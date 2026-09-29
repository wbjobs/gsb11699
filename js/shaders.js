export const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const SCENE_BODY = `
uniform float uTime;
uniform vec2 uRes;

vec3 sceneColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 2.0;
  vec3 col = vec3(0.015, 0.02, 0.045);
  col += vec3(0.04, 0.07, 0.14) * (1.0 - uv.y);
  col += vec3(0.10, 0.05, 0.02) * smoothstep(0.0, 1.0, uv.x) * 0.5;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(uTime * 0.7 + fi * 1.7) * 0.8,
                  cos(uTime * 0.9 + fi * 2.3) * 0.5);
    float d = length(p - c);
    vec3 tint = 0.5 + 0.5 * cos(fi * 2.1 + vec3(0.0, 2.1, 4.2));
    float glow = 0.02 / (d * d + 0.004);
    col += tint * glow * (1.2 + 1.2 * sin(uTime + fi));
  }
  float pulse = smoothstep(0.6, 1.0, sin(uTime * 0.5) * 0.5 + 0.5);
  col *= 1.0 + 2.5 * pulse;
  return col;
}
`;

const TONEMAP_BODY = `
uniform float uExposure;
uniform int uOperator;
uniform float uGamma;

vec3 toneMap(vec3 hdr) {
  hdr *= uExposure;
  vec3 mapped;
  if (uOperator == 0) {
    mapped = hdr / (1.0 + hdr);
  } else if (uOperator == 1) {
    mapped = clamp((hdr * (2.51 * hdr + 0.03)) /
                   (hdr * (2.43 * hdr + 0.59) + 0.14), 0.0, 1.0);
  } else {
    mapped = clamp(hdr, 0.0, 1.0);
  }
  return pow(mapped, vec3(1.0 / uGamma));
}
`;

export const SCENE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
${SCENE_BODY}
void main() {
  frag = vec4(sceneColor(vUV), 1.0);
}
`;

export const SINGLE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
${SCENE_BODY}
${TONEMAP_BODY}
void main() {
  frag = vec4(toneMap(sceneColor(vUV)), 1.0);
}
`;

export const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  frag = vec4(c * w, 1.0);
}
`;

export const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uW[16];
uniform int uCount;
void main() {
  vec3 acc = texture(uTex, vUV).rgb * uW[0];
  for (int i = 1; i < 16; i++) {
    if (i >= uCount) break;
    vec2 off = uDir * float(i);
    acc += texture(uTex, vUV + off).rgb * uW[i];
    acc += texture(uTex, vUV - off).rgb * uW[i];
  }
  frag = vec4(acc, 1.0);
}
`;

export const TONEMAP_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform int uUseBloom;
uniform float uBloomIntensity;
${TONEMAP_BODY}
void main() {
  vec3 hdr = texture(uScene, vUV).rgb;
  if (uUseBloom == 1) {
    hdr += texture(uBloom, vUV).rgb * uBloomIntensity;
  }
  frag = vec4(toneMap(hdr), 1.0);
}
`;

export const FXAA_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uInvRes;
uniform float uSubpix;
void main() {
  vec3 luma = vec3(0.299, 0.587, 0.114);
  vec3 rgbNW = texture(uTex, vUV + vec2(-1.0, -1.0) * uInvRes).rgb;
  vec3 rgbNE = texture(uTex, vUV + vec2( 1.0, -1.0) * uInvRes).rgb;
  vec3 rgbSW = texture(uTex, vUV + vec2(-1.0,  1.0) * uInvRes).rgb;
  vec3 rgbSE = texture(uTex, vUV + vec2( 1.0,  1.0) * uInvRes).rgb;
  vec3 rgbM  = texture(uTex, vUV).rgb;
  float lumaNW = dot(rgbNW, luma);
  float lumaNE = dot(rgbNE, luma);
  float lumaSW = dot(rgbSW, luma);
  float lumaSE = dot(rgbSE, luma);
  float lumaM  = dot(rgbM, luma);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  vec2 dir = vec2(-((lumaNW + lumaNE) - (lumaSW + lumaSE)),
                   ((lumaNW + lumaSW) - (lumaNE + lumaSE)));
  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uInvRes * uSubpix;
  vec3 rgbA = 0.5 * (texture(uTex, vUV + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(uTex, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 *
              (texture(uTex, vUV + dir * -0.5).rgb +
               texture(uTex, vUV + dir *  0.5).rgb);
  float lumaB = dot(rgbB, luma);
  frag = vec4((lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB, 1.0);
}
`;

export const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
uniform sampler2D uTex;
void main() {
  frag = vec4(texture(uTex, vUV).rgb, 1.0);
}
`;
