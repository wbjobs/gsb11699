// 全部着色器源码（GLSL ES 3.00）。

export const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// HDR 过程化场景：网格 + 运动的高亮光球（亮度可超过 1.0，用于演示辉光/色调映射）
export const FS_SCENE = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform float uTime;
uniform vec2 uAspect;

float orb(vec2 uv, vec2 c, float r){
  float d = length(uv - c);
  // 核心能量 >1，形成 HDR 高光
  return (r*r) / (d*d + 0.0008) * 2.2;
}

void main(){
  vec2 uv = (vUV - 0.5) * uAspect;
  float t = uTime * 0.35;

  vec3 bg = mix(vec3(0.012,0.016,0.030), vec3(0.05,0.07,0.11), vUV.y);

  // 透视网格
  vec2 g = uv; g.x *= 1.2;
  vec2 grid = abs(fract(g*6.0 - vec2(0.0,t*1.5)) - 0.5) / fwidth(g*6.0);
  float line = min(grid.x, grid.y);
  bg += vec3(0.0, 0.35, 0.9) * (1.0 - min(line, 1.0)) * 0.10 * smoothstep(-0.2,-0.7,uv.y);

  vec3 col = bg;
  vec2 c1 = vec2(sin(t*1.3)*0.7, cos(t*0.9)*0.45);
  vec2 c2 = vec2(cos(t*0.7+2.0)*0.8, sin(t*1.1)*0.5);
  vec2 c3 = vec2(sin(t*0.5+4.0)*0.5, cos(t*1.7+1.0)*0.4);
  col += vec3(1.0, 0.25, 0.08) * orb(uv, c1, 0.10);
  col += vec3(0.10, 0.45, 1.0) * orb(uv, c2, 0.09);
  col += vec3(0.95, 0.95, 0.35) * orb(uv, c3, 0.07);

  fragColor = vec4(col, 1.0);
}`;

// 亮部提取（带柔和膝部）
export const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(uThreshold - uKnee, uThreshold + uKnee, luma);
  fragColor = vec4(c * w, 1.0);
}`;

// 9 抽头可分离高斯模糊，uDir 已乘纹理步长与半径
export const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;
void main(){
  vec3 c = texture(uTex, vUV).rgb * 0.227027;
  vec2 o1 = uDir * 1.384615;
  vec2 o2 = uDir * 3.230769;
  c += texture(uTex, vUV + o1).rgb * 0.316216;
  c += texture(uTex, vUV - o1).rgb * 0.316216;
  c += texture(uTex, vUV + o2).rgb * 0.070270;
  c += texture(uTex, vUV - o2).rgb * 0.070270;
  fragColor = vec4(c, 1.0);
}`;

// 辉光合成
export const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uStrength;
void main(){
  vec3 scene = texture(uScene, vUV).rgb;
  vec3 bloom = texture(uBloom, vUV).rgb;
  fragColor = vec4(scene + bloom * uStrength, 1.0);
}`;

// 色调映射与伽马。被 tonemap 通道与单通道降级路径共用。
export const CHUNK_TONEMAP = `
vec3 tonemapACES(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
vec3 applyTonemap(vec3 hdr, float exposure, float gamma, int op){
  vec3 x = hdr * exposure;
  vec3 mapped;
  if(op == 0)      mapped = x / (1.0 + x);          // Reinhard
  else if(op == 1) mapped = tonemapACES(x);          // ACES filmic
  else             mapped = clamp(x, 0.0, 1.0);      // 仅曝光
  return pow(mapped, vec3(1.0 / gamma));
}`;

export const FS_TONEMAP = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform float uExposure;
uniform float uGamma;
uniform int uOperator;
${CHUNK_TONEMAP}
void main(){
  vec3 hdr = texture(uTex, vUV).rgb;
  fragColor = vec4(applyTonemap(hdr, uExposure, uGamma, uOperator), 1.0);
}`;

// FXAA（Lottes FXAA 3.11 思路的精简实现）
export const FS_FXAA = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main(){
  vec3 rgbNW = texture(uTex, vUV + vec2(-1.0,-1.0)*uTexel).rgb;
  vec3 rgbNE = texture(uTex, vUV + vec2( 1.0,-1.0)*uTexel).rgb;
  vec3 rgbSW = texture(uTex, vUV + vec2(-1.0, 1.0)*uTexel).rgb;
  vec3 rgbSE = texture(uTex, vUV + vec2( 1.0, 1.0)*uTexel).rgb;
  vec3 rgbM  = texture(uTex, vUV).rgb;
  const vec3 toLuma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, toLuma), lNE = dot(rgbNE, toLuma);
  float lSW = dot(rgbSW, toLuma), lSE = dot(rgbSE, toLuma);
  float lM  = dot(rgbM, toLuma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)),
                   ((lNW + lSW) - (lNE + lSE)));
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + max(lMax - lMin, lMax / 128.0));
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture(uTex, vUV + dir * (1.0/3.0 - 0.5)).rgb +
                  texture(uTex, vUV + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uTex, vUV + dir * -0.5).rgb +
                             texture(uTex, vUV + dir *  0.5).rgb);
  float lB = dot(b, toLuma);
  vec3 outc = (lB < lMin || lB > lMax) ? a : b;
  fragColor = vec4(outc, 1.0);
}`;

// 直通拷贝（色调映射关闭时直接上屏）
export const FS_COPY = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
void main(){
  fragColor = texture(uTex, vUV);
}`;

// 单通道降级：直接渲染到默认帧缓冲，场景 + 色调映射内联（无任何 FBO）
export const FS_SCENE_SINGLE = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform float uTime;
uniform vec2 uAspect;
uniform float uExposure;
uniform float uGamma;
uniform int uOperator;
${CHUNK_TONEMAP}
float orb(vec2 uv, vec2 c, float r){
  float d = length(uv - c);
  return (r*r) / (d*d + 0.0008) * 2.2;
}
void main(){
  vec2 uv = (vUV - 0.5) * uAspect;
  float t = uTime * 0.35;
  vec3 bg = mix(vec3(0.012,0.016,0.030), vec3(0.05,0.07,0.11), vUV.y);
  vec2 g = uv; g.x *= 1.2;
  vec2 grid = abs(fract(g*6.0 - vec2(0.0,t*1.5)) - 0.5) / fwidth(g*6.0);
  float line = min(grid.x, grid.y);
  bg += vec3(0.0, 0.35, 0.9) * (1.0 - min(line, 1.0)) * 0.10 * smoothstep(-0.2,-0.7,uv.y);
  vec3 col = bg;
  vec2 c1 = vec2(sin(t*1.3)*0.7, cos(t*0.9)*0.45);
  vec2 c2 = vec2(cos(t*0.7+2.0)*0.8, sin(t*1.1)*0.5);
  vec2 c3 = vec2(sin(t*0.5+4.0)*0.5, cos(t*1.7+1.0)*0.4);
  col += vec3(1.0, 0.25, 0.08) * orb(uv, c1, 0.10);
  col += vec3(0.10, 0.45, 1.0) * orb(uv, c2, 0.09);
  col += vec3(0.95, 0.95, 0.35) * orb(uv, c3, 0.07);
  fragColor = vec4(applyTonemap(col, uExposure, uGamma, uOperator), 1.0);
}`;
