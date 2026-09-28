// 纯逻辑工具：分辨率缩放降级、显存估算。被主线程与测试共用（无 DOM/WebGL 依赖）。

// 显存不足时依次尝试的缩放档位
export const SCALE_STEPS = [1, 0.75, 0.5, 0.35, 0.25];

export const BYTES_PER_PIXEL = {
  RGBA16F: 8,
  RGBA8: 4,
  DEPTH24: 4,
};

// 估算一组帧缓冲的显存占用（字节）。buffers: [{ w, h, format, depth? }]
export function estimateVramBytes(buffers) {
  let total = 0;
  for (const b of buffers) {
    const bpp = BYTES_PER_PIXEL[b.format] ?? 4;
    total += b.w * b.h * bpp;
    if (b.depth) total += b.w * b.h * BYTES_PER_PIXEL.DEPTH24;
  }
  return total;
}

export function formatBytes(bytes) {
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(2) + ' MB';
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(1) + ' KB';
  return bytes + ' B';
}

// 给定当前缩放，返回下一个更小的降级档位；没有则返回 null（应降级到单通道）。
export function nextScaleStep(current) {
  const smaller = SCALE_STEPS.filter((s) => s < current - 1e-6);
  return smaller.length ? smaller[0] : null;
}

// 计算缩放后的实际像素尺寸，至少 1x1，避免 0 尺寸帧缓冲。
export function scaledSize(w, h, scale) {
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}
