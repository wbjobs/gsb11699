# 帧缓冲与后处理演示（WebGL2）

一个纯前端的多通道后处理管线演示：HDR 场景渲染 → 亮部提取 → 双向高斯模糊（辉光）→
色调映射合成 → FXAA，支持多通道、分辨率缩放、参数实时调整，并展示每通道耗时与显存占用。

## 运行

需要通过 HTTP 服务访问（ES Module 与 Web Worker 不支持 file://）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

要求支持 WebGL2 的浏览器（Chrome / Edge / Firefox / Safari 16+）。

## 技术栈

- **WebGL2**：帧缓冲（FBO）离屏渲染、半浮点 HDR 颜色附件、GPU 计时查询
- **Canvas**：最终上屏与 2D 控制面板
- **Web Worker**（`js/worker.js`）：高斯模糊核计算、IndexedDB 读写，避免阻塞渲染线程
- **PerformanceObserver**：监听 longtask 掉帧预警；每通道同时写入 `performance.measure`
- **IndexedDB**：持久化用户参数（`settings`）与每秒耗时样本（`timings`）

## 后处理链

```
场景(HDR) → bright(亮部提取) → blurH/blurV × N(辉光) → tonemap(合成+映射) → FXAA → 屏幕
```

- 场景与中间目标使用 RGBA16F（不支持时回退 RGBA8 并提示）
- 辉光链在 0.5× 分辨率下运行，模糊核由 Worker 按 σ 计算
- 色调映射支持 Reinhard / ACES Filmic / Clamp，含曝光与 Gamma
- 单通道模式：一个着色器直接完成场景 + 色调映射上屏，旁路全部中间 FBO

## 验收标准对照

| 标准 | 实现 |
| --- | --- |
| 后处理链正确 | `js/postfx.js` `render()` 按序执行 scene→bloom→tonemap→fxaa，最后一个启用的通道输出到屏幕 |
| 多通道正确 | 5 个 FBO（scene/workA/workB/bloomA/bloomB）乒乓复用，通道可独立开关 |
| 分辨率缩放正确 | 全局缩放 0.25–2.0，辉光固定 0.5×，ResizeObserver 处理画布尺寸变化 |
| 参数调整正确 | 阈值/软膝/强度/σ/迭代/曝光/算子/Gamma/亚像素均实时生效并持久化 |
| 每通道耗时准确 | 优先 `EXT_disjoint_timer_query_webgl2` GPU 计时（异步回收查询），回退 CPU 计时；按帧聚合多次调用 |

## 异常场景覆盖

- **帧缓冲格式**：探测 RGBA16F → RGBA16F_EXT → RGBA8，逐级回退并记录日志
- **分辨率不匹配**：缩放/窗口变化时全部 FBO 重建；超过 `MAX_TEXTURE_SIZE` 抛错并降级
- **通道顺序**：面板可上下调整 bloom/tonemap/fxaa 顺序；色调映射早于辉光时给出警告并不合成辉光
- **显存不足**：分配失败自动降级 L1 减半分辨率 → L2 关闭辉光 → L3 单通道；「模拟显存不足」按钮压测驱动，「触发真实降级」按钮注入分配失败
- **上下文丢失**：`webglcontextlost/restored` 监听，丢失时停循环+横幅提示，恢复后重建全部 GL 资源；可用按钮模拟
- **降级到单通道**：手动复选框或自动 L3 降级，单着色器直接上屏

## 文件结构

```
index.html        页面与控制面板
css/style.css     样式
js/main.js        UI、渲染循环、上下文丢失处理、PerformanceObserver
js/postfx.js      FBO 管理、渲染管线、GPU 计时、显存统计、降级
js/shaders.js     全部 GLSL（场景/亮部/模糊/色调映射/FXAA/单通道）
js/worker.js      高斯核计算 + IndexedDB 持久化
```
