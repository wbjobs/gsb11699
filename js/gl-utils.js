// WebGL2 基础工具：着色器编译、程序链接、帧缓冲创建（含格式/完整性校验）。

export function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('着色器编译失败: ' + log + '\n' + src);
  }
  return shader;
}

export function createProgram(gl, vsSrc, fsSrc, defines = []) {
  const prefix = defines.map((d) => '#define ' + d).join('\n') + '\n';
  const vs = compileShader(gl, gl.VERTEX_SHADER, prefix + vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, prefix + fsSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('程序链接失败: ' + log);
  }
  return program;
}

// 创建一个颜色附件帧缓冲。失败（不完整 / OUT_OF_MEMORY）时抛错，由上层执行降级。
export function createTarget(gl, w, h, { hdr = true, depth = false, name = '' } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // HDR 优先 RGBA16F；不支持或不完整时自动回退 RGBA8（LDR）。
  const wantF16 = hdr && !!gl.extColorFloat;
  let useF16 = wantF16;

  const allocate = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internalFormat = useF16 ? gl.RGBA16F : gl.RGBA8;
    const type = useF16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    let depthRb = null;
    if (depth) {
      depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const glErr = gl.getError();
    if (glErr === gl.OUT_OF_MEMORY) {
      destroyTarget(gl, { fbo, tex, depthRb });
      const e = new Error(`显存不足 (${name || '?'} ${w}x${h} ${useF16 ? 'RGBA16F' : 'RGBA8'})`);
      e.code = 'OUT_OF_MEMORY';
      throw e;
    }
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      destroyTarget(gl, { fbo, tex, depthRb });
      const reason = framebufferStatusName(gl, status) || '0x' + status.toString(16);
      const e = new Error(`帧缓冲不完整 (${name || '?'} ${w}x${h} ${useF16 ? 'RGBA16F' : 'RGBA8'}): ${reason}`);
      e.code = 'FRAMEBUFFER_INCOMPLETE';
      throw e;
    }
    return { fbo, depthRb };
  };

  let result;
  try {
    result = allocate();
  } catch (err) {
    if (useF16) {
      // 16F 失败（格式不支持 / 显存不足）→ 同一逻辑纹理上回退 8bit
      useF16 = false;
      result = allocate();
    } else {
      throw err;
    }
  }

  return {
    name, fbo: result.fbo, tex, depthRb: result.depthRb, w, h,
    format: useF16 ? 'RGBA16F' : 'RGBA8',
    depth,
  };
}

export function destroyTarget(gl, target) {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.tex);
  if (target.depthRb) gl.deleteRenderbuffer(target.depthRb);
}

export function framebufferStatusName(gl, status) {
  const names = {
    [gl.FRAMEBUFFER_COMPLETE]: 'FRAMEBUFFER_COMPLETE',
    [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'INCOMPLETE_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'INCOMPLETE_MISSING_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: 'INCOMPLETE_DIMENSIONS',
    [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
    [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: 'INCOMPLETE_MULTISAMPLE',
  };
  return names[status] || null;
}
