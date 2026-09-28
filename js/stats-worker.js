// Web Worker：聚合每通道耗时（avg/min/max/last），缓存显存信息，节流回传。
const WINDOW = 120; // 每个通道最多保留最近 120 个样本
const buckets = new Map(); // name -> number[]
let vram = null;
let lastFlush = 0;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'sample') {
    let arr = buckets.get(msg.name);
    if (!arr) { arr = []; buckets.set(msg.name, arr); }
    arr.push(msg.ms);
    if (arr.length > WINDOW) arr.shift();
    const now = performance.now();
    if (now - lastFlush > 500) {
      lastFlush = now;
      flush(msg.source);
    }
  } else if (msg.type === 'vram') {
    vram = msg.info;
    flush(vram && vram.timingSource);
  } else if (msg.type === 'reset') {
    buckets.clear();
    vram = null;
  }
};

function flush(source) {
  const passes = {};
  for (const [name, arr] of buckets) {
    if (!arr.length) continue;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const v of arr) { sum += v; if (v < min) min = v; if (v > max) max = v; }
    passes[name] = { avg: sum / arr.length, min, max, last: arr[arr.length - 1], count: arr.length };
  }
  self.postMessage({ type: 'stats', passes, vram, source });
}
