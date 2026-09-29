import { PostFX } from './postfx.js';

const PASS_META = {
  bloom: {
    label: '辉光 Bloom（亮部提取 + 双向高斯模糊）',
    params: [
      { key: 'threshold', label: '亮部阈值', min: 0, max: 4, step: 0.05 },
      { key: 'knee', label: '软膝', min: 0.01, max: 1, step: 0.01 },
      { key: 'intensity', label: '辉光强度', min: 0, max: 3, step: 0.05 },
      { key: 'sigma', label: '模糊 σ', min: 0.5, max: 12, step: 0.1 },
      { key: 'iterations', label: '模糊迭代', min: 1, max: 4, step: 1 },
    ],
  },
  tonemap: {
    label: '色调映射 Tone Mapping',
    params: [
      { key: 'exposure', label: '曝光', min: 0.1, max: 4, step: 0.05 },
      {
        key: 'operator', label: '算子', type: 'select',
        options: [[0, 'Reinhard'], [1, 'ACES Filmic'], [2, 'Clamp']],
      },
      { key: 'gamma', label: 'Gamma', min: 1, max: 3.2, step: 0.05 },
    ],
  },
  fxaa: {
    label: 'FXAA 抗锯齿',
    params: [
      { key: 'subpix', label: '亚像素混合', min: 0, max: 1, step: 0.05 },
    ],
  },
};

const DEFAULT_STATE = {
  scale: 1,
  singlePass: false,
  order: ['bloom', 'tonemap', 'fxaa'],
  passes: {
    bloom: { enabled: true, threshold: 1.0, knee: 0.5, intensity: 1.0, sigma: 4, iterations: 2 },
    tonemap: { enabled: true, exposure: 1.0, operator: 1, gamma: 2.2 },
    fxaa: { enabled: true, subpix: 0.75 },
  },
};

const state = structuredClone(DEFAULT_STATE);

const canvas = document.getElementById('gl');
const banner = document.getElementById('banner');
const logEl = document.getElementById('log');
const scaleInput = document.getElementById('scale');
const scaleVal = document.getElementById('scaleVal');
const singlePassInput = document.getElementById('singlePass');

let postfx = null;
let rafId = 0;
let running = false;
let saveTimer = 0;

function log(message, level = '') {
  const line = document.createElement('div');
  if (level) line.className = level;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${time}] ${message}`;
  logEl.appendChild(line);
  while (logEl.children.length > 120) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function setBanner(text, visible) {
  banner.textContent = text;
  banner.classList.toggle('hidden', !visible);
}

const worker = new Worker('./js/worker.js');
worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'kernel') {
    if (postfx) postfx.setBlurWeights(msg.weights);
  } else if (msg.type === 'settings') {
    if (msg.data) {
      applyLoadedSettings(msg.data);
    } else {
      applyConfig();
    }
  } else if (msg.type === 'settingsSaved') {
    log('参数已持久化到 IndexedDB', 'ok');
  } else if (msg.type === 'timingsCleared') {
    log('IndexedDB 中的耗时记录已清除', 'ok');
  } else if (msg.type === 'error') {
    log('Worker 错误: ' + msg.message, 'error');
  }
};

function requestKernel(sigma) {
  worker.postMessage({ type: 'kernel', sigma });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    worker.postMessage({ type: 'saveSettings', settings: state });
  }, 500);
}

function applyLoadedSettings(data) {
  try {
    if (typeof data.scale === 'number') state.scale = data.scale;
    if (typeof data.singlePass === 'boolean') state.singlePass = data.singlePass;
    if (Array.isArray(data.order) && data.order.length === 3 &&
        data.order.every((id) => PASS_META[id])) {
      state.order = data.order.slice();
    }
    for (const id of Object.keys(PASS_META)) {
      if (data.passes && data.passes[id]) {
        Object.assign(state.passes[id], data.passes[id]);
      }
    }
  } catch (err) {
    log('读取已保存参数失败，使用默认值: ' + err.message, 'warn');
  }
  syncControlValues();
  buildOrderList();
  buildParamBlocks();
  applyConfig();
  log('已从 IndexedDB 恢复参数', 'ok');
}

function applyConfig() {
  if (!postfx) return;
  postfx.configure(structuredClone(state));
  requestKernel(state.passes.bloom.sigma);
}

function initGL() {
  postfx = new PostFX(canvas, {
    log,
    onDegrade: (info) => {
      if (info.singlePass) {
        state.singlePass = true;
        singlePassInput.checked = true;
      }
      if (info.bloomDisabled) {
        state.passes.bloom.enabled = false;
        buildOrderList();
      }
      if (typeof info.scale === 'number') {
        state.scale = info.scale;
        scaleInput.value = String(info.scale);
        scaleVal.textContent = info.scale.toFixed(2);
      }
    },
  });
  postfx.init();
  resizeCanvas();
  applyConfig();
}

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  running = false;
  cancelAnimationFrame(rafId);
  setBanner('WebGL 上下文已丢失，等待恢复……', true);
  log('WebGL 上下文丢失', 'error');
  if (postfx) postfx.destroy();
});

canvas.addEventListener('webglcontextrestored', () => {
  log('WebGL 上下文已恢复，重建全部 GL 资源', 'ok');
  setBanner('', false);
  initGL();
  startLoop();
});

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (postfx) postfx.resize();
  }
}

const resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(canvas);

function buildOrderList() {
  const ul = document.getElementById('passOrder');
  ul.innerHTML = '';
  state.order.forEach((id, index) => {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.passes[id].enabled;
    checkbox.addEventListener('change', () => {
      state.passes[id].enabled = checkbox.checked;
      postfx.warnedOrder.clear();
      applyConfig();
      scheduleSave();
    });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = PASS_META[id].label.split(' ')[0];
    const up = document.createElement('button');
    up.textContent = '▲';
    up.disabled = index === 0;
    up.addEventListener('click', () => movePass(index, -1));
    const down = document.createElement('button');
    down.textContent = '▼';
    down.disabled = index === state.order.length - 1;
    down.addEventListener('click', () => movePass(index, 1));
    li.append(checkbox, name, up, down);
    ul.appendChild(li);
  });
}

function movePass(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.order.length) return;
  const [item] = state.order.splice(index, 1);
  state.order.splice(target, 0, item);
  postfx.warnedOrder.clear();
  buildOrderList();
  applyConfig();
  scheduleSave();
}

function formatParam(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function buildParamBlocks() {
  const container = document.getElementById('passParams');
  container.innerHTML = '';
  for (const id of ['bloom', 'tonemap', 'fxaa']) {
    const meta = PASS_META[id];
    const block = document.createElement('div');
    block.className = 'pass-block';
    const head = document.createElement('div');
    head.className = 'pass-head';
    head.textContent = meta.label;
    block.appendChild(head);
    for (const spec of meta.params) {
      const row = document.createElement('label');
      row.className = 'row';
      if (spec.type === 'select') {
        const span = document.createElement('span');
        span.textContent = spec.label;
        const select = document.createElement('select');
        for (const [value, label] of spec.options) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          select.appendChild(option);
        }
        select.value = String(state.passes[id][spec.key]);
        select.addEventListener('change', () => {
          state.passes[id][spec.key] = Number(select.value);
          applyConfig();
          scheduleSave();
        });
        row.append(span, select);
      } else {
        const span = document.createElement('span');
        span.textContent = spec.label;
        const value = document.createElement('b');
        value.textContent = formatParam(state.passes[id][spec.key]);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        input.value = String(state.passes[id][spec.key]);
        input.addEventListener('input', () => {
          const v = Number(input.value);
          state.passes[id][spec.key] = v;
          value.textContent = formatParam(v);
          applyConfig();
          scheduleSave();
        });
        row.append(span, value, input);
      }
      block.appendChild(row);
    }
    container.appendChild(block);
  }
}

function syncControlValues() {
  scaleInput.value = String(state.scale);
  scaleVal.textContent = state.scale.toFixed(2);
  singlePassInput.checked = state.singlePass;
}

scaleInput.addEventListener('input', () => {
  state.scale = Number(scaleInput.value);
  scaleVal.textContent = state.scale.toFixed(2);
  try {
    if (postfx) postfx.setScale(state.scale);
  } catch (err) {
    log('分辨率调整失败: ' + err.message, 'error');
  }
  scheduleSave();
});

singlePassInput.addEventListener('change', () => {
  state.singlePass = singlePassInput.checked;
  log(state.singlePass ? '已切换到单通道模式' : '已恢复多通道模式');
  applyConfig();
  scheduleSave();
});

document.getElementById('btnReset').addEventListener('click', () => {
  const fresh = structuredClone(DEFAULT_STATE);
  state.scale = fresh.scale;
  state.singlePass = fresh.singlePass;
  state.order = fresh.order;
  state.passes = fresh.passes;
  syncControlValues();
  buildOrderList();
  buildParamBlocks();
  postfx.warnedOrder.clear();
  postfx.setScale(state.scale);
  applyConfig();
  scheduleSave();
  log('参数已重置', 'ok');
});

document.getElementById('btnCtxLoss').addEventListener('click', () => {
  const ext = postfx.gl.getExtension('WEBGL_lose_context');
  if (!ext) {
    log('当前环境不支持 WEBGL_lose_context', 'warn');
    return;
  }
  log('调用 loseContext() 模拟上下文丢失，1.2 秒后恢复', 'warn');
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 1200);
});

document.getElementById('btnOOM').addEventListener('click', () => {
  log('开始申请大块纹理以模拟显存不足（随后释放，不影响渲染资源）', 'warn');
  postfx.simulateOOM();
});

document.getElementById('btnDegrade').addEventListener('click', () => {
  log('注入一次帧缓冲分配失败，触发自动降级链路', 'warn');
  postfx.debugFailAlloc = true;
  try {
    postfx.resize();
  } catch (err) {
    log('降级失败: ' + err.message, 'error');
  }
});

document.getElementById('btnClearTimings').addEventListener('click', () => {
  worker.postMessage({ type: 'clearTimings' });
});

let fps = 0;
let frameCount = 0;
let fpsWindowStart = performance.now();
let lastStatsUpdate = 0;
let lastTimingLog = 0;

function startLoop() {
  if (running) return;
  running = true;
  const loop = (now) => {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    postfx.render(now / 1000);
    frameCount += 1;
    if (now - fpsWindowStart >= 500) {
      fps = (frameCount * 1000) / (now - fpsWindowStart);
      frameCount = 0;
      fpsWindowStart = now;
    }
    if (now - lastStatsUpdate >= 250) {
      lastStatsUpdate = now;
      updateStatsUI();
    }
    if (now - lastTimingLog >= 1000) {
      lastTimingLog = now;
      const stats = postfx.getStats();
      worker.postMessage({
        type: 'logTiming',
        sample: {
          time: Date.now(),
          fps,
          scale: stats.scale,
          singlePass: stats.singlePass,
          degradeLevel: stats.degradeLevel,
          vramBytes: stats.vram.total,
          passes: stats.passes.map((p) => ({
            name: p.name,
            gpuMs: p.gpuMs,
            cpuMs: p.cpuMs,
            calls: p.calls,
            width: p.width,
            height: p.height,
          })),
        },
      });
    }
  };
  rafId = requestAnimationFrame(loop);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function updateStatsUI() {
  const stats = postfx.getStats();
  if (!stats) return;
  const statsEl = document.getElementById('stats');
  statsEl.innerHTML = '';
  const items = [
    ['FPS', fps.toFixed(1)],
    ['帧缓冲格式', stats.format],
    ['GPU 计时器', stats.gpuTimer ? '支持' : '不支持（CPU 计时）'],
    ['渲染分辨率', `${stats.sceneWidth}×${stats.sceneHeight}`],
    ['辉光分辨率', `${stats.bloomWidth}×${stats.bloomHeight}`],
    ['分辨率缩放', stats.scale.toFixed(2)],
    ['渲染模式', stats.singlePass ? '单通道（降级）' : '多通道'],
    ['降级级别', 'L' + stats.degradeLevel],
  ];
  for (const [key, value] of items) {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.textContent = value;
    statsEl.append(k, v);
  }

  const tbody = document.getElementById('passTableBody');
  tbody.innerHTML = '';
  for (const pass of stats.passes) {
    const tr = document.createElement('tr');
    const cells = [
      pass.name + (pass.calls > 1 ? ` ×${pass.calls}` : ''),
      pass.gpuMs === null ? '—' : pass.gpuMs.toFixed(3),
      pass.cpuMs.toFixed(3),
      `${pass.width}×${pass.height}`,
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const vramEl = document.getElementById('vram');
  vramEl.innerHTML = '';
  const total = document.createElement('div');
  total.textContent = `显存占用（估算）: ${formatBytes(stats.vram.total)}`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.style.width = Math.min(100, (stats.vram.total / (256 * 1024 * 1024)) * 100) + '%';
  bar.appendChild(fill);
  vramEl.append(total, bar);
  for (const item of stats.vram.breakdown) {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = `${item.name}: ${formatBytes(item.bytes)}`;
    vramEl.appendChild(div);
  }
}

try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === 'longtask') {
        log(`检测到长任务: ${entry.duration.toFixed(1)}ms（可能导致掉帧）`, 'warn');
      }
    }
  });
  observer.observe({ entryTypes: ['longtask', 'measure'] });
} catch (err) {
  log('PerformanceObserver 不可用: ' + err.message, 'warn');
}

try {
  initGL();
  buildOrderList();
  buildParamBlocks();
  syncControlValues();
  worker.postMessage({ type: 'loadSettings' });
  startLoop();
  log('初始化完成，后处理链已启动', 'ok');
} catch (err) {
  setBanner('初始化失败: ' + err.message, true);
  log('初始化失败: ' + err.message, 'error');
}
