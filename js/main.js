// 主控：初始化/重建、渲染循环、UI 绑定、上下文丢失、降级、性能观察、IndexedDB。

import { PostPipeline } from './pipeline.js';
import { loadSettings, persistSettings } from './db.js';
import { SCALE_STEPS, nextScaleStep, formatBytes } from './shared.js';

const DEFAULT_SETTINGS = {
  scale: 1,
  bloom: true,
  bloomThreshold: 1.0,
  bloomStrength: 0.9,
  blurRadius: 2.0,
  blurIterations: 2,
  tonemap: true,
  exposure: 1.0,
  gamma: 2.2,
  operator: 1,
  fxaa: true,
};

const PASS_NAMES = {
  scene: '场景',
  bright: '亮部提取',
  blurH: '模糊(水平)',
  blurV: '模糊(垂直)',
  composite: '辉光合成',
  tonemap: '色调映射',
  fxaa: 'FXAA',
  copy: '拷贝',
  single: '单通道(降级)',
};

const els = {};
let gl = null;
let pipeline = null;
let settings = { ...DEFAULT_SETTINGS };
let rafId = 0;
let contextLost = false;
let fpsEma = 0;
let longTaskCount = 0;
let lastLongTask = 0;

const worker = new Worker('./js/stats-worker.js', { type: 'classic' });

// ---------- 初始化 ----------
function initGL() {
  const canvas = els.canvas;
  const ctx = canvas.getContext('webgl2', {
    antialias: false, // 抗锯齿交给 FXAA
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  if (!ctx) throw new Error('当前浏览器不支持 WebGL2');
  ctx.extColorFloat = ctx.getExtension('EXT_color_buffer_float');
  ctx.extLoseContext = ctx.getExtension('WEBGL_lose_context');
  if (!ctx.extColorFloat) {
    addWarning('不支持 EXT_color_buffer_float，HDR 帧缓冲自动回退 RGBA8');
  }
  return ctx;
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(els.canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(els.canvas.clientHeight * dpr));
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
}

// 目标缩放到实际生效缩放：显存不足时逐档降级，最终降级到单通道。
function buildWithFallback(desiredScale) {
  const p = new PostPipeline(gl, els.canvas);
  p.onSample = (name, ms, source) => worker.postMessage({ type: 'sample', name, ms, source });

  const errors = [];
  let scale = desiredScale;
  while (true) {
    const res = p.tryBuild(scale);
    if (res.ok) break;
    errors.push(...res.errors);
    const next = nextScaleStep(scale);
    if (next === null) {
      p.enterSinglePass();
      break;
    }
    scale = next;
  }
  return { pipeline: p, scale, errors };
}

function rebuild() {
  if (contextLost) return;
  resizeCanvas();
  let built;
  try {
    built = buildWithFallback(Number(settings.scale));
  } catch (err) {
    // 连单通道都无法构建（着色器/上下文层面失败）
    addWarning('管线重建失败: ' + err.message);
    return;
  }
  pipeline?.dispose();
  pipeline = built.pipeline;
  reportVram();
  renderStatus(built.errors);
  updateEffectiveScaleUI();
}

function reportVram() {
  worker.postMessage({ type: 'vram', info: pipeline.vramInfo });
}

// ---------- 渲染循环 ----------
function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (!pipeline || contextLost) return;
  const t0 = performance.now();
  pipeline.render(now / 1000, settings);
  pipeline.pollTimers();
  const dt = performance.now() - t0;
  fpsEma = fpsEma ? fpsEma * 0.92 + (1000 / Math.max(dt, 0.01)) * 0.08 : 1000 / Math.max(dt, 0.01);
  els.fps.textContent = fpsEma.toFixed(0);
  els.frameMs.textContent = dt.toFixed(2);
}

// ---------- 上下文丢失 / 恢复 ----------
function bindContextLoss(canvas) {
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    cancelAnimationFrame(rafId);
    pipeline?.dispose();
    pipeline = null;
    els.contextState.textContent = '已丢失';
    els.contextState.className = 'badge bad';
    addWarning('检测到 WebGL 上下文丢失，已停止渲染（等待恢复）');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    els.contextState.textContent = '正常';
    els.contextState.className = 'badge ok';
    try {
      gl = initGL();
      rebuild();
      addWarning('上下文已恢复，全部 GPU 资源已重建');
    } catch (err) {
      addWarning('上下文恢复后重建失败: ' + err.message);
    }
  });
}

// ---------- PerformanceObserver ----------
function observeLongTasks() {
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++;
        lastLongTask = entry.duration;
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    els.longtask.textContent = '不支持';
  }
  setInterval(() => {
    els.longtask.textContent = String(longTaskCount);
    els.longtaskLast.textContent = lastLongTask ? lastLongTask.toFixed(1) + ' ms' : '—';
  }, 500);
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function initEls() {
  Object.assign(els, {
    canvas: $('canvas'),
    fps: $('fps'), frameMs: $('frameMs'), longtask: $('longtask'), longtaskLast: $('longtaskLast'),
    contextState: $('contextState'),
    modeState: $('modeState'), formatState: $('formatState'), scaleState: $('scaleState'),
    timingState: $('timingState'), vramTotal: $('vramTotal'), bufferList: $('bufferList'),
    warningList: $('warningList'), passTable: $('passTable'),
  });
}

function bindControls() {
  const scaleSelect = $('cfg-scale');
  for (const s of SCALE_STEPS.concat([1.25, 1.5, 2])) {
    const sorted = [...new Set([s])]; // 逐个 append，下方去重排序
  }
  // 按顺序去重的完整档位
  const steps = [...new Set([...SCALE_STEPS, 1.25, 1.5, 2])].sort((a, b) => a - b);
  scaleSelect.innerHTML = '';
  for (const s of steps) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = Math.round(s * 100) + '%';
    scaleSelect.appendChild(opt);
  }

  const bindRange = (id, key, fmt = (v) => v) => {
    const input = $(id), label = $(id + '-val');
    const apply = () => {
      settings[key] = Number(input.value);
      label.textContent = fmt(settings[key]);
      schedulePersist();
    };
    input.addEventListener('input', apply);
    return { input, label, apply };
  };
  const ranges = {
    threshold: bindRange('cfg-threshold', 'bloomThreshold', (v) => v.toFixed(2)),
    strength: bindRange('cfg-strength', 'bloomStrength', (v) => v.toFixed(2)),
    radius: bindRange('cfg-radius', 'blurRadius', (v) => v.toFixed(2)),
    iterations: bindRange('cfg-iterations', 'blurIterations', (v) => v.toFixed(0)),
    exposure: bindRange('cfg-exposure', 'exposure', (v) => v.toFixed(2)),
    gamma: bindRange('cfg-gamma', 'gamma', (v) => v.toFixed(2)),
  };
  const checks = {
    bloom: $('cfg-bloom'), tonemap: $('cfg-tonemap'), fxaa: $('cfg-fxaa'),
  };
  for (const [key, node] of Object.entries(checks)) {
    node.addEventListener('change', () => { settings[key] = node.checked; schedulePersist(); });
  }
  scaleSelect.addEventListener('change', () => {
    settings.scale = Number(scaleSelect.value);
    schedulePersist();
    rebuild();
  });
  $('cfg-operator').addEventListener('change', (e) => {
    settings.operator = Number(e.target.value);
    schedulePersist();
  });

  $('btn-vram-down').addEventListener('click', () => {
    pipeline.vramTest = 'downscale';
    rebuild();
    addWarning('注入模拟显存不足：当前及以上缩放档位分配失败，触发分辨率降级');
  });
  $('btn-vram-single').addEventListener('click', () => {
    pipeline.vramTest = 'single';
    rebuild();
    addWarning('注入模拟显存耗尽：所有帧缓冲分配失败，降级到单通道模式');
  });
  $('btn-vram-reset').addEventListener('click', () => {
    pipeline.vramTest = 'none';
    rebuild();
  });
  $('btn-ctx-lose').addEventListener('click', () => {
    const ext = gl?.extLoseContext;
    if (ext) ext.loseContext();
    setTimeout(() => ext && ext.restoreContext(), 1500);
  });
  $('btn-reset').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    syncControls();
    pipeline.vramTest = 'none';
    rebuild();
    schedulePersist();
  });

  return { ranges, checks, scaleSelect, operator: $('cfg-operator') };
}

let controls;

function syncControls() {
  const { ranges, checks, scaleSelect, operator } = controls;
  scaleSelect.value = String(settings.scale);
  ranges.threshold.input.value = settings.bloomThreshold;
  ranges.strength.input.value = settings.bloomStrength;
  ranges.radius.input.value = settings.blurRadius;
  ranges.iterations.input.value = settings.blurIterations;
  ranges.exposure.input.value = settings.exposure;
  ranges.gamma.input.value = settings.gamma;
  for (const key of Object.keys(checks)) checks[key].checked = settings[key];
  operator.value = String(settings.operator);
  for (const r of Object.values(ranges)) r.apply();
}

function updateEffectiveScaleUI() {
  const eff = pipeline.scale;
  const desired = Number(settings.scale);
  els.scaleState.textContent =
    Math.round(desired * 100) + '% → ' + Math.round(eff * 100) + '%';
  const [w, h] = [els.canvas.width, els.canvas.height];
  const fw = Math.round(w * eff), fh = Math.round(h * eff);
  els.scaleState.title = `画布 ${w}x${h}，帧缓冲 ${fw}x${fh}`;
}

function renderStatus(errors) {
  const info = pipeline.vramInfo;
  els.modeState.textContent = info.mode === 'single' ? '单通道(降级)' : '多通道';
  els.modeState.className = 'badge ' + (info.mode === 'single' ? 'warn' : 'ok');
  els.formatState.textContent = info.hdrActive ? 'RGBA16F (HDR)'
    : (info.hdrSupported ? 'RGBA8 (回退)' : 'RGBA8 (不支持 HDR)');
  els.formatState.className = 'badge ' + (info.hdrActive ? 'ok' : 'warn');
  els.timingState.textContent = (info.timingSource === 'GPU' ? 'GPU 计时' : 'CPU 计时');
  els.timingState.className = 'badge ' + (info.timingSource === 'GPU' ? 'ok' : 'warn');
  els.vramTotal.textContent = formatBytes(info.bytes);
  els.bufferList.innerHTML = info.buffers
    .map((b) => `<li><code>${b.name}</code> ${b.w}×${b.h} ${b.format} <span>${formatBytes(b.w * b.h * (b.format === 'RGBA16F' ? 8 : 4))}</span></li>`)
    .join('');
  if (errors.length) {
    for (const e of [...new Set(errors)].slice(-3)) addWarning(e);
  }
  updateEffectiveScaleUI();
}

function addWarning(text) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  li.textContent = `[${time}] ${text}`;
  els.warningList.prepend(li);
  while (els.warningList.children.length > 12) {
    els.warningList.removeChild(els.warningList.lastChild);
  }
}

// Worker 回传统计 → 表格
worker.onmessage = (e) => {
  const { passes, source } = e.data;
  if (!passes) return;
  for (const key of Object.keys(PASS_NAMES)) {
    const row = els.passTable.querySelector(`[data-pass="${key}"]`);
    if (!row) continue;
    const stat = passes[key];
    const set = (cls, v) => { row.querySelector('.' + cls).textContent = v; };
    if (stat) {
      set('p-avg', stat.avg.toFixed(3));
      set('p-min', stat.min.toFixed(3));
      set('p-max', stat.max.toFixed(3));
      set('p-last', stat.last.toFixed(3));
      set('p-src', source === 'GPU' ? 'GPU' : 'CPU');
    } else {
      for (const cls of ['p-avg', 'p-min', 'p-max', 'p-last', 'p-src']) set(cls, '—');
    }
  }
};

// ---------- 持久化 ----------
let persistTimer = 0;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistSettings({ ...settings }), 300);
}

// ---------- 启动 ----------
async function main() {
  initEls();
  buildPassTable();
  controls = bindControls();

  const saved = await loadSettings();
  if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
  syncControls();

  bindContextLoss(els.canvas);
  observeLongTasks();

  gl = initGL();
  rebuild();
  window.addEventListener('resize', () => rebuild());
  rafId = requestAnimationFrame(frame);
}

function buildPassTable() {
  for (const [key, label] of Object.entries(PASS_NAMES)) {
    const tr = document.createElement('tr');
    tr.dataset.pass = key;
    tr.innerHTML =
      `<td>${label}</td><td class="p-avg">—</td><td class="p-min">—</td>` +
      `<td class="p-max">—</td><td class="p-last">—</td><td class="p-src">—</td>`;
    els.passTable.appendChild(tr);
  }
}

main().catch((err) => {
  document.body.insertAdjacentHTML('beforeend',
    `<pre style="color:#f88;padding:16px">启动失败: ${err.message}\n${err.stack || ''}</pre>`);
});
