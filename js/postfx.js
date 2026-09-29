import * as Shaders from './shaders.js';

export const MAX_TAPS = 16;

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('着色器编译失败: ' + log);
  }
  return shader;
}

function createProgram(gl, vsSrc, fsSrc) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

export class VRAMTracker {
  constructor() {
    this.entries = new Map();
  }

  alloc(name, bytes) {
    this.entries.set(name, bytes);
  }

  free(name) {
    this.entries.delete(name);
  }

  total() {
    let sum = 0;
    for (const bytes of this.entries.values()) sum += bytes;
    return sum;
  }

  breakdown() {
    return [...this.entries.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
  }
}

class RenderTarget {
  constructor(gl, tracker, name, fmt) {
    this.gl = gl;
    this.tracker = tracker;
    this.name = name;
    this.fmt = fmt;
    this.width = 0;
    this.height = 0;
    this.texture = null;
    this.fbo = null;
  }

  resize(width, height) {
    const gl = this.gl;
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (this.texture && this.width === width && this.height === height) return;
    this.dispose();

    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (width > maxSize || height > maxSize) {
      throw new Error(`分辨率 ${width}x${height} 超过 MAX_TEXTURE_SIZE=${maxSize}`);
    }

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, width, height, 0,
                  this.fmt.format, this.fmt.type, null);

    const err = gl.getError();
    if (err === gl.OUT_OF_MEMORY) {
      this.dispose();
      throw new Error(`显存不足 (OUT_OF_MEMORY)，分配 ${this.name} ${width}x${height} 失败`);
    }
    if (err !== gl.NO_ERROR) {
      this.dispose();
      throw new Error(`texImage2D 错误 0x${err.toString(16)} (${this.name})`);
    }

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.dispose();
      throw new Error(`帧缓冲不完整: 0x${status.toString(16)} (${this.name}, ${this.fmt.label})`);
    }

    this.width = width;
    this.height = height;
    this.tracker.alloc(this.name, width * height * this.fmt.bpp);
  }

  dispose() {
    if (this.texture) this.gl.deleteTexture(this.texture);
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
    if (this.width || this.height) this.tracker.free(this.name);
    this.texture = null;
    this.fbo = null;
    this.width = 0;
    this.height = 0;
  }
}

class GPUTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.perCallMs = new Map();
  }

  get supported() {
    return !!this.ext;
  }

  begin() {
    if (!this.ext) return null;
    const gl = this.gl;
    const query = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    return query;
  }

  end(name, query) {
    if (!query) return;
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ name, query });
  }

  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i];
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const available = gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE);
      if (disjoint || available) {
        if (!disjoint) {
          const ns = gl.getQueryParameter(entry.query, gl.QUERY_RESULT);
          const list = this.perCallMs.get(entry.name) || [];
          list.push(ns / 1e6);
          if (list.length > 60) list.shift();
          this.perCallMs.set(entry.name, list);
        }
        gl.deleteQuery(entry.query);
        this.pending.splice(i, 1);
      }
    }
  }

  perCallAvg(name) {
    const list = this.perCallMs.get(name);
    if (!list || !list.length) return null;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  dispose() {
    if (!this.ext) return;
    for (const entry of this.pending) this.gl.deleteQuery(entry.query);
    this.pending = [];
  }
}

export class PostFX {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = Object.assign({ log: () => {}, onDegrade: () => {} }, hooks);
    this.tracker = new VRAMTracker();
    this.gl = null;
    this.timer = null;
    this.programs = null;
    this.targets = {};
    this.config = null;
    this.scale = 1.0;
    this.bloomScale = 0.5;
    this.fmt = null;
    this.hdrSupported = false;
    this.singlePass = false;
    this.degradeLevel = 0;
    this.blurWeights = new Float32Array(MAX_TAPS);
    this.blurCount = 1;
    this.blurWeights[0] = 1;
    this.debugFailAlloc = false;
    this.frameCpu = new Map();
    this.frameCalls = new Map();
    this.lastFrameCpu = new Map();
    this.lastFrameCalls = new Map();
    this.lastPassOrder = [];
    this.lastPassSizes = new Map();
    this.warnedOrder = new Set();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.detectFormat();
    this.buildPrograms();
    this.buildGeometry();
    this.timer = new GPUTimer(gl);
    this.hooks.log(
      this.timer.supported
        ? 'GPU 计时器可用 (EXT_disjoint_timer_query_webgl2)'
        : 'GPU 计时器不可用，通道耗时回退为 CPU 计时',
      this.timer.supported ? 'ok' : 'warn'
    );
    this.resize();
  }

  detectFormat() {
    const gl = this.gl;
    const candidates = [];
    if (gl.getExtension('EXT_color_buffer_float')) {
      candidates.push({
        internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
        bpp: 8, label: 'RGBA16F (HDR 半浮点)',
      });
    }
    if (gl.getExtension('EXT_color_buffer_half_float')) {
      candidates.push({
        internal: gl.getExtension('EXT_color_buffer_half_float').RGBA16F_EXT,
        format: gl.RGBA, type: gl.HALF_FLOAT, bpp: 8, label: 'RGBA16F_EXT (HDR 半浮点)',
      });
    }
    candidates.push({
      internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
      bpp: 4, label: 'RGBA8 (LDR)',
    });

    for (const candidate of candidates) {
      const probe = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, probe);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, candidate.internal, 4, 4, 0,
                    candidate.format, candidate.type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                              gl.TEXTURE_2D, probe, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(probe);
      if (complete) {
        this.fmt = candidate;
        this.hdrSupported = candidate.bpp > 4;
        if (!this.hdrSupported) {
          this.hooks.log('HDR 帧缓冲格式不可用，回退到 RGBA8：辉光高光将被截断', 'warn');
        } else {
          this.hooks.log(`帧缓冲格式: ${candidate.label}`, 'ok');
        }
        return;
      }
    }
    throw new Error('没有可用的可渲染帧缓冲格式');
  }

  buildPrograms() {
    const gl = this.gl;
    this.programs = {
      scene: createProgram(gl, Shaders.VERT, Shaders.SCENE_FRAG),
      single: createProgram(gl, Shaders.VERT, Shaders.SINGLE_FRAG),
      bright: createProgram(gl, Shaders.VERT, Shaders.BRIGHT_FRAG),
      blur: createProgram(gl, Shaders.VERT, Shaders.BLUR_FRAG),
      tonemap: createProgram(gl, Shaders.VERT, Shaders.TONEMAP_FRAG),
      fxaa: createProgram(gl, Shaders.VERT, Shaders.FXAA_FRAG),
      copy: createProgram(gl, Shaders.VERT, Shaders.COPY_FRAG),
    };
  }

  buildGeometry() {
    const gl = this.gl;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]),
                  gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  configure(config) {
    this.config = config;
    this.singlePass = !!config.singlePass;
  }

  setBlurWeights(weights) {
    const padded = new Float32Array(MAX_TAPS);
    padded.set(weights.subarray(0, MAX_TAPS));
    this.blurWeights = padded;
    this.blurCount = Math.min(weights.length, MAX_TAPS);
  }

  setScale(scale) {
    this.scale = scale;
    this.degradeLevel = 0;
    this.resize();
  }

  resize() {
    if (!this.gl || !this.fmt) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;
    const sw = Math.max(1, Math.round(w * this.scale));
    const sh = Math.max(1, Math.round(h * this.scale));
    const bw = Math.max(1, Math.round(sw * this.bloomScale));
    const bh = Math.max(1, Math.round(sh * this.bloomScale));
    try {
      this.allocTargets(sw, sh, bw, bh);
      this.sceneWidth = sw;
      this.sceneHeight = sh;
      this.bloomWidth = bw;
      this.bloomHeight = bh;
    } catch (err) {
      this.hooks.log(err.message, 'error');
      if (this.degrade()) {
        this.resize();
      } else {
        throw err;
      }
    }
  }

  allocTargets(sw, sh, bw, bh) {
    if (this.debugFailAlloc) {
      this.debugFailAlloc = false;
      throw new Error('调试注入：模拟本次帧缓冲分配失败');
    }
    const t = this.targets;
    const names = ['scene', 'workA', 'workB', 'bloomA', 'bloomB'];
    for (const name of names) {
      if (!t[name]) t[name] = new RenderTarget(this.gl, this.tracker, name, this.fmt);
    }
    t.scene.resize(sw, sh);
    t.workA.resize(sw, sh);
    t.workB.resize(sw, sh);
    t.bloomA.resize(bw, bh);
    t.bloomB.resize(bw, bh);
  }

  degrade() {
    this.degradeLevel += 1;
    if (this.degradeLevel === 1) {
      this.scale = Math.max(0.25, Math.round(this.scale * 0.5 * 100) / 100);
      this.hooks.log(`降级 L1：分辨率缩放降至 ${this.scale.toFixed(2)}`, 'warn');
      this.hooks.onDegrade({ level: 1, singlePass: this.singlePass, scale: this.scale });
      return true;
    }
    if (this.degradeLevel === 2 && this.config && this.config.passes.bloom.enabled) {
      this.config.passes.bloom.enabled = false;
      this.hooks.log('降级 L2：关闭辉光通道（亮部提取 + 高斯模糊）', 'warn');
      this.hooks.onDegrade({ level: 2, singlePass: this.singlePass, scale: this.scale, bloomDisabled: true });
      return true;
    }
    if (this.degradeLevel >= 2 && !this.singlePass) {
      this.singlePass = true;
      this.hooks.log('降级 L3：单通道模式，旁路全部中间帧缓冲', 'warn');
      this.hooks.onDegrade({ level: 3, singlePass: true, scale: this.scale });
      return true;
    }
    this.hooks.log('已到最低降级级别，无法继续', 'error');
    return false;
  }

  bindTexture(unit, target, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(target, unit);
  }

  render(time) {
    const gl = this.gl;
    if (!gl || !this.config) return;
    this.timer.poll();
    this.frameCpu = new Map();
    this.frameCalls = new Map();
    const passOrder = [];

    const runPass = (name, target, prog, setup) => {
      const t0 = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.width : this.canvas.width,
                        target ? target.height : this.canvas.height);
      gl.useProgram(prog.program);
      setup(prog.uniforms);
      gl.bindVertexArray(this.vao);
      const query = this.timer.begin();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.timer.end(name, query);
      const t1 = performance.now();
      this.frameCpu.set(name, (this.frameCpu.get(name) || 0) + (t1 - t0));
      this.frameCalls.set(name, (this.frameCalls.get(name) || 0) + 1);
      if (!passOrder.includes(name)) passOrder.push(name);
      this.lastPassSizes.set(name, [
        target ? target.width : this.canvas.width,
        target ? target.height : this.canvas.height,
      ]);
      try {
        performance.measure('pass:' + name, { start: t0, end: t1 });
      } catch (_) { /* 部分浏览器不支持时间戳形式的 measure */ }
    };

    const cfg = this.config;
    const tp = cfg.passes.tonemap;

    if (this.singlePass) {
      runPass('single', null, this.programs.single, (u) => {
        gl.uniform1f(u.uTime, time);
        gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
        gl.uniform1f(u.uExposure, tp.enabled ? tp.exposure : 1.0);
        gl.uniform1i(u.uOperator, tp.enabled ? tp.operator : 1);
        gl.uniform1f(u.uGamma, tp.enabled ? tp.gamma : 2.2);
      });
      this.commitFrame(passOrder);
      return;
    }

    const t = this.targets;
    runPass('scene', t.scene, this.programs.scene, (u) => {
      gl.uniform1f(u.uTime, time);
      gl.uniform2f(u.uRes, this.sceneWidth, this.sceneHeight);
    });

    const enabledOrder = cfg.order.filter((id) => cfg.passes[id].enabled);
    let bloomTex = null;

    if (enabledOrder.includes('bloom')) {
      const bp = cfg.passes.bloom;
      runPass('bright', t.bloomA, this.programs.bright, (u) => {
        this.bindTexture(0, u.uTex, t.scene.texture);
        gl.uniform1f(u.uThreshold, bp.threshold);
        gl.uniform1f(u.uKnee, bp.knee);
      });
      let src = t.bloomA;
      let dst = t.bloomB;
      for (let i = 0; i < bp.iterations; i++) {
        runPass('blurH', dst, this.programs.blur, (u) => {
          this.bindTexture(0, u.uTex, src.texture);
          gl.uniform2f(u.uDir, 1.0 / dst.width, 0.0);
          gl.uniform1fv(u.uW, this.blurWeights);
          gl.uniform1i(u.uCount, this.blurCount);
        });
        runPass('blurV', src, this.programs.blur, (u) => {
          this.bindTexture(0, u.uTex, dst.texture);
          gl.uniform2f(u.uDir, 0.0, 1.0 / src.height);
          gl.uniform1fv(u.uW, this.blurWeights);
          gl.uniform1i(u.uCount, this.blurCount);
        });
      }
      bloomTex = t.bloomA.texture;
      const bloomIndex = enabledOrder.indexOf('bloom');
      const tonemapIndex = enabledOrder.indexOf('tonemap');
      if (tonemapIndex !== -1 && tonemapIndex < bloomIndex && !this.warnedOrder.has('earlyTM')) {
        this.warnedOrder.add('earlyTM');
        this.hooks.log('通道顺序：色调映射在辉光之前执行，辉光结果不参与合成', 'warn');
      }
      if (tonemapIndex === -1 && !this.warnedOrder.has('noTM')) {
        this.warnedOrder.add('noTM');
        this.hooks.log('辉光已启用但色调映射通道关闭，辉光结果将被丢弃', 'warn');
      }
    }

    const postPasses = enabledOrder.filter((id) => id !== 'bloom');
    if (postPasses.length === 0) {
      runPass('copy', null, this.programs.copy, (u) => {
        this.bindTexture(0, u.uTex, t.scene.texture);
      });
      this.commitFrame(passOrder);
      return;
    }

    let current = t.scene;
    let useWorkA = true;
    postPasses.forEach((id, i) => {
      const last = i === postPasses.length - 1;
      const target = last ? null : (useWorkA ? t.workA : t.workB);
      if (id === 'tonemap') {
        const p = cfg.passes.tonemap;
        const useBloom = bloomTex !== null &&
          enabledOrder.indexOf('bloom') < enabledOrder.indexOf('tonemap');
        runPass('tonemap', target, this.programs.tonemap, (u) => {
          this.bindTexture(0, u.uScene, current.texture);
          this.bindTexture(1, u.uBloom,
            bloomTex || t.scene.texture);
          gl.uniform1i(u.uUseBloom, useBloom ? 1 : 0);
          gl.uniform1f(u.uBloomIntensity, cfg.passes.bloom.intensity);
          gl.uniform1f(u.uExposure, p.exposure);
          gl.uniform1i(u.uOperator, p.operator);
          gl.uniform1f(u.uGamma, p.gamma);
        });
      } else if (id === 'fxaa') {
        const p = cfg.passes.fxaa;
        runPass('fxaa', target, this.programs.fxaa, (u) => {
          this.bindTexture(0, u.uTex, current.texture);
          gl.uniform2f(u.uInvRes, 1.0 / current.width, 1.0 / current.height);
          gl.uniform1f(u.uSubpix, p.subpix);
        });
      }
      if (target) {
        current = target;
        useWorkA = !useWorkA;
      }
    });

    this.commitFrame(passOrder);
  }

  commitFrame(passOrder) {
    this.lastFrameCpu = this.frameCpu;
    this.lastFrameCalls = this.frameCalls;
    this.lastPassOrder = passOrder;
  }

  getStats() {
    const passes = this.lastPassOrder.map((name) => {
      const calls = this.lastFrameCalls.get(name) || 1;
      const perCall = this.timer.perCallAvg(name);
      const size = this.lastPassSizes.get(name) || [0, 0];
      return {
        name,
        gpuMs: perCall === null ? null : perCall * calls,
        cpuMs: this.lastFrameCpu.get(name) || 0,
        calls,
        width: size[0],
        height: size[1],
      };
    });
    return {
      format: this.fmt ? this.fmt.label : '未知',
      gpuTimer: this.timer ? this.timer.supported : false,
      hdrSupported: this.hdrSupported,
      scale: this.scale,
      bloomScale: this.bloomScale,
      singlePass: this.singlePass,
      degradeLevel: this.degradeLevel,
      sceneWidth: this.sceneWidth || 0,
      sceneHeight: this.sceneHeight || 0,
      bloomWidth: this.bloomWidth || 0,
      bloomHeight: this.bloomHeight || 0,
      passes,
      vram: {
        total: this.tracker.total(),
        breakdown: this.tracker.breakdown(),
      },
    };
  }

  destroy() {
    for (const name of Object.keys(this.targets)) {
      this.targets[name].dispose();
    }
    this.targets = {};
    if (this.timer) this.timer.dispose();
    this.timer = null;
    this.programs = null;
    this.gl = null;
    this.fmt = null;
    this.lastFrameCpu = new Map();
    this.lastFrameCalls = new Map();
    this.lastPassOrder = [];
  }

  simulateOOM() {
    const gl = this.gl;
    const junk = [];
    let totalMb = 0;
    try {
      for (let i = 0; i < 128; i++) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4096, 4096, 0,
                      gl.RGBA, gl.UNSIGNED_BYTE, null);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          gl.deleteTexture(tex);
          this.hooks.log(
            `显存不足已触发：累计申请 ${totalMb.toFixed(0)} MB 后驱动返回 0x${err.toString(16)}`,
            'error'
          );
          return;
        }
        junk.push(tex);
        totalMb += (4096 * 4096 * 4) / (1024 * 1024);
      }
      this.hooks.log(`已申请 ${totalMb.toFixed(0)} MB 仍未报错（驱动可能使用虚拟显存）`, 'warn');
    } finally {
      for (const tex of junk) gl.deleteTexture(tex);
    }
  }
}
