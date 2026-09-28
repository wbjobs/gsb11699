// 后处理管线：场景 -> 亮部 -> 高斯模糊(H/V ping-pong) -> 辉光合成 -> 色调映射 -> FXAA -> 屏幕
// 覆盖：帧缓冲格式回退、分辨率不匹配、通道顺序、显存不足降级、上下文丢失重建。

import { createProgram, createTarget, destroyTarget } from './gl-utils.js';
import { scaledSize, estimateVramBytes } from './shared.js';
import {
  VS_QUAD, FS_SCENE, FS_BRIGHT, FS_BLUR, FS_COMPOSITE,
  FS_TONEMAP, FS_FXAA, FS_COPY, FS_SCENE_SINGLE,
} from './shaders.js';

export class PostPipeline {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.programs = {};
    this.targets = new Map();
    this.scale = 1;
    this.mode = 'multi'; // 'multi' | 'single'
    this.hdrSupported = !!gl.extColorFloat;
    this.hdrActive = false;
    this.vramBytes = 0;
    this.vramBuffers = [];

    // 显存压力测试钩子：'none' | 'downscale'（>=0.5 档失败）| 'single'（全部失败）
    this.vramTest = 'none';

    // GPU 计时（EXT_disjoint_timer_query_webgl2），不可用时用 CPU 计时
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timingSource = this.timerExt ? 'GPU' : 'CPU';
    this.activePasses = [];
    this.pending = [];
    this.onSample = null; // (name, ms, source) => void

    this._initQuad();
    this._initPrograms();
  }

  _initQuad() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  _initPrograms() {
    const gl = this.gl;
    const P = (name, fs) => { this.programs[name] = createProgram(gl, VS_QUAD, fs); };
    P('scene', FS_SCENE);
    P('bright', FS_BRIGHT);
    P('blur', FS_BLUR);
    P('composite', FS_COMPOSITE);
    P('tonemap', FS_TONEMAP);
    P('fxaa', FS_FXAA);
    P('copy', FS_COPY);
    P('sceneSingle', FS_SCENE_SINGLE);
    this.ulocs = {};
    for (const [name, prog] of Object.entries(this.programs)) {
      const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      const locs = {};
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(prog, i);
        locs[info.name.replace('[0]$', '')] = gl.getUniformLocation(prog, info.name);
      }
      this.ulocs[name] = locs;
    }
  }

  useProgram(name) {
    this.gl.useProgram(this.programs[name]);
    return this.ulocs[name];
  }

  _makeTarget(key, w, h, hdr, depth) {
    if (this.vramTest === 'single') {
      throw Object.assign(new Error(`模拟显存耗尽 (${key})`), { code: 'OUT_OF_MEMORY', simulated: true });
    }
    if (this.vramTest === 'downscale' && this.scale >= 0.5 - 1e-6) {
      throw Object.assign(new Error(`模拟显存不足 (${key} @ scale=${this.scale})`), { code: 'OUT_OF_MEMORY', simulated: true });
    }
    return createTarget(this.gl, w, h, { hdr, depth, name: key });
  }

  // 按指定缩放构建全部帧缓冲；返回 { ok, errors }。多档缩放由 main 调用方驱动。
  tryBuild(scale) {
    this.disposeTargets();
    this.scale = scale;
    const gl = this.gl;
    const [w, h] = scaledSize(this.canvas.width, this.canvas.height, scale);
    const [bw, bh] = [Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))];

    const desired = [
      ['scene', w, h, true, false],
      ['workA', w, h, true, false],
      ['brightA', bw, bh, true, false],
      ['brightB', bw, bh, true, false],
      ['ldr', w, h, false, false],
    ];
    const errors = [];
    try {
      for (const [key, tw, th, hdr] of desired) {
        const target = this._makeTarget(key, tw, th, hdr, false);
        this.targets.set(key, target);
      }
    } catch (err) {
      errors.push(err.message);
      this.disposeTargets();
      return { ok: false, errors };
    }

    this.mode = 'multi';
    this.hdrActive = this.targets.get('scene').format === 'RGBA16F';
    this._refreshVram();
    return { ok: true, errors: [] };
  }

  // 降级到单通道：释放全部帧缓冲，场景直接渲染到默认帧缓冲。
  enterSinglePass() {
    this.disposeTargets();
    this.mode = 'single';
    this.hdrActive = false;
    this._refreshVram();
  }

  _refreshVram() {
    this.vramBuffers = [...this.targets.values()].map((t) => ({
      name: t.name, w: t.w, h: t.h, format: t.format, depth: !!t.depth,
    }));
    this.vramBytes = estimateVramBytes(this.vramBuffers);
  }

  get vramInfo() {
    return {
      mode: this.mode,
      scale: this.scale,
      hdrSupported: this.hdrSupported,
      hdrActive: this.hdrActive,
      timingSource: this.timingSource,
      bytes: this.vramBytes,
      buffers: this.vramBuffers,
    };
  }

  disposeTargets() {
    for (const t of this.targets.values()) destroyTarget(this.gl, t);
    this.targets.clear();
    for (const q of this.pending) this.gl.deleteQuery(q.query);
    this.pending = [];
    this.vramBytes = 0;
    this.vramBuffers = [];
  }

  dispose() {
    this.disposeTargets();
    for (const p of Object.values(this.programs)) this.gl.deleteProgram(p);
    this.programs = {};
  }

  // ---- 计时 ----
  _beginPass(name) {
    const gl = this.gl;
    const rec = { name, cpuStart: performance.now(), query: null, disjoint: 0 };
    if (this.timerExt) {
      const query = gl.createQuery();
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
      rec.query = query;
      rec.disjoint = this.timerExt.GPU_DISJOINT_EXT;
    }
    this.activePasses.push(rec);
  }

  _endPass() {
    const gl = this.gl;
    const rec = this.activePasses.pop();
    if (rec.query) gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    rec.cpuMs = performance.now() - rec.cpuStart;
    if (rec.query) this.pending.push(rec);
    else if (this.onSample) this.onSample(rec.name, rec.cpuMs, 'CPU');
  }

  pollTimers() {
    if (!this.timerExt) return;
    const gl = this.gl;
    const remain = [];
    for (const rec of this.pending) {
      const available = gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(rec.disjoint);
      if (available && !disjoint) {
        const ns = gl.getQueryParameter(rec.query, gl.QUERY_RESULT);
        gl.deleteQuery(rec.query);
        if (this.onSample) this.onSample(rec.name, ns / 1e6, 'GPU');
      } else if (available) {
        gl.deleteQuery(rec.query); // 与其他查询冲突，丢弃本帧该样本
      } else {
        remain.push(rec); // 下一帧再取
      }
    }
    this.pending = remain;
  }

  _draw(targetOrNull, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetOrNull ? targetOrNull.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _bindTex(unit, loc, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // ---- 主渲染 ----
  render(timeSec, s) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.mode === 'single') {
      this._renderSingle(timeSec, s);
      return;
    }
    const scene = this.targets.get('scene');
    const workA = this.targets.get('workA');
    const brightA = this.targets.get('brightA');
    const brightB = this.targets.get('brightB');
    const ldr = this.targets.get('ldr');
    const aspect = [this.canvas.width / this.canvas.height, 1.0];

    // 1. 场景（HDR 帧缓冲）
    this._beginPass('scene');
    let u = this.useProgram('scene');
    gl.uniform1f(u.uTime, timeSec);
    gl.uniform2f(u.uAspect, aspect[0], aspect[1]);
    this._draw(scene, scene.w, scene.h);
    this._endPass();

    // 当前“场景色”的来源纹理与分辨率（合成会换源，FXAA 需要正确的纹理步长）
    let srcTex = scene.tex;
    let srcW = scene.w, srcH = scene.h;

    if (s.bloom) {
      // 2. 亮部提取（半分辨率）
      this._beginPass('bright');
      u = this.useProgram('bright');
      this._bindTex(0, u.uTex, srcTex);
      gl.uniform1f(u.uThreshold, s.bloomThreshold);
      gl.uniform1f(u.uKnee, 0.25);
      this._draw(brightA, brightA.w, brightA.h);
      this._endPass();

      // 3. 可分离高斯模糊 ping-pong（每次迭代 H 然后 V）
      u = this.useProgram('blur');
      let read = brightA, write = brightB;
      for (let i = 0; i < s.blurIterations; i++) {
        this._beginPass('blurH');
        gl.useProgram(this.programs.blur);
        this._bindTex(0, this.ulocs.blur.uTex, read.tex);
        gl.uniform2f(this.ulocs.blur.uDir, (s.blurRadius / read.w), 0);
        this._draw(write, write.w, write.h);
        this._endPass();

        this._beginPass('blurV');
        this._bindTex(0, this.ulocs.blur.uTex, write.tex);
        gl.uniform2f(this.ulocs.blur.uDir, 0, (s.blurRadius / write.h));
        this._draw(read, read.w, read.h);
        this._endPass();
      }

      // 4. 辉光合成（全分辨率 workA；半分辨率 bloom 纹理自动线性放大）
      this._beginPass('composite');
      u = this.useProgram('composite');
      this._bindTex(0, u.uScene, srcTex);
      this._bindTex(1, u.uBloom, read.tex);
      gl.uniform1f(u.uStrength, s.bloomStrength);
      this._draw(workA, workA.w, workA.h);
      this._endPass();
      srcTex = workA.tex; srcW = workA.w; srcH = workA.h;
    }

    // 5. 色调映射（关闭则直通，屏幕空间伽马交给 copy 之外——这里直接 clamp 上屏）
    if (s.tonemap) {
      this._beginPass('tonemap');
      u = this.useProgram('tonemap');
      this._bindTex(0, u.uTex, srcTex);
      gl.uniform1f(u.uExposure, s.exposure);
      gl.uniform1f(u.uGamma, s.gamma);
      gl.uniform1i(u.uOperator, s.operator);
      // FXAA 开启：写入 LDR 帧缓冲；否则直接上屏
      if (s.fxaa) {
        this._draw(ldr, ldr.w, ldr.h);
      } else {
        this._draw(null, this.canvas.width, this.canvas.height);
      }
      this._endPass();
      srcTex = ldr.tex; srcW = ldr.w; srcH = ldr.h;
    } else if (s.fxaa) {
      // 无色调映射但有 FXAA：先把 HDR 源拷到 LDR 缓冲（clamp），避免 FXAA 读到超范围值
      this._beginPass('copy');
      u = this.useProgram('copy');
      this._bindTex(0, u.uTex, srcTex);
      this._draw(ldr, ldr.w, ldr.h);
      this._endPass();
      srcTex = ldr.tex; srcW = ldr.w; srcH = ldr.h;
    }

    // 6. 上屏：FXAA 或直通
    if (s.fxaa) {
      this._beginPass('fxaa');
      u = this.useProgram('fxaa');
      this._bindTex(0, u.uTex, srcTex);
      // 关键：纹理步长按源分辨率；默认帧缓冲按画布分辨率设置 viewport
      gl.uniform2f(u.uTexel, 1 / srcW, 1 / srcH);
      this._draw(null, this.canvas.width, this.canvas.height);
      this._endPass();
    } else if (!s.tonemap) {
      this._beginPass('copy');
      u = this.useProgram('copy');
      this._bindTex(0, u.uTex, srcTex);
      this._draw(null, this.canvas.width, this.canvas.height);
      this._endPass();
    }
  }

  _renderSingle(timeSec, s) {
    // 单通道降级：无帧缓冲、无辉光、无 FXAA，场景与色调映射合并一次绘制。
    this._beginPass('single');
    const u = this.useProgram('sceneSingle');
    this.gl.uniform1f(u.uTime, timeSec);
    this.gl.uniform2f(u.uAspect, this.canvas.width / this.canvas.height, 1.0);
    this.gl.uniform1f(u.uExposure, s.exposure);
    this.gl.uniform1f(u.uGamma, s.gamma);
    this.gl.uniform1i(u.uOperator, s.operator);
    this._draw(null, this.canvas.width, this.canvas.height);
    this._endPass();
  }
}
