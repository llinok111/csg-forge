# 上游改动清单

基线：`gkjohnson/three-bvh-csg`，分支 `main`，版本 `0.0.18`，完整提交历史保留。

本文件记录：**上游留下的空白**、**改了哪些上游文件**、**新增了什么**、**设计决策与实测**。

---

## 1. 上游留下的空白

### 1.1 三处自证

| 位置 | 原文 |
|---|---|
| `README.md` 的 Roadmap | `- Worker Support [#14](https://github.com/gkjohnson/three-bvh-csg/issues/14)` |
| `IMPLEMENTATION.md` | `src/workers/*` → **"Currently unused."** |
| `src/workers/AsyncEvaluator.js` | `export class AsyncEvaluator { }` |
| `src/workers/Pool.js` | `export class Pool { }` |

最后两条是逐字复制的上游源码 —— 两个空类，没有属性、没有方法、没有注释。

### 1.2 `IMPLEMENTATION.md` 里对应的改进条目

> **Web Worker**
> The half edge structure and BVHs could be generated in parallel with others using a thread pool system. Perform CSG operations in a worker.

本项目实现的是后半句（"Perform CSG operations in a worker"）。前半句（并行生成 half-edge / BVH）没有做 —— 那需要在 worker 里重建 brush 的加速结构，属于另一个量级的改动，且当前瓶颈在链式求值的重复计算而非单次 BVH 构建。

---

## 2. 修改的上游文件

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/workers/AsyncEvaluator.js` | 空类 → 305 行实现 | 见 §3.1 |
| `src/workers/Pool.js` | 空类 → 391 行实现 | 见 §3.2 |
| `package.json` | 加 3 个 scripts + 2 个 devDependencies | `probe`/`verify`/`bench`；`playwright-core`、`pngjs` 仅验证用 |
| `.gitignore` | 加 `docs/shots` 临时输出与 `.npmrc` | — |
| `eslint.config.js` | 一处规则放宽 | worker 脚本用 `node:` 前缀导入 |

**没有改动**：`src/core/*`、`src/objects/*`、`src/materials/*`、`src/utils/*`、`src/libs/*`、`benchmark/*`、`examples/` 下上游原有的 8 个示例页。

上游 `Evaluator` 在 worker 里是**原版运行**，没有打补丁、没有复制分支。

---

## 3. 新增的文件

### 3.1 `src/workers/protocol.js`（271 行）

three.js 对象（`Brush` / `BufferGeometry` / `Material`）不可结构化克隆，所以跨线程传输前必须降级成纯数据：

```
brush descriptor = { geometry, matrixWorld, material }
```

关键点：

- **零拷贝**：几何的 `position` / `normal` / `uv` 以 `ArrayBuffer` 形式放进 transfer list。但转移后发送端 buffer 会被 detach，所以离开主线程前必须**先复制**，否则会破坏活的场景图。
- **指纹**：`fnv1a(version)` 把 brush 的几何版本 + 变换压成 32 位整数。worker 端只比较指纹，相同就不重建 BVH。
- **往返一致性**：`serializeBrush` / `deserializeBrush` 有 13 个单元测试守着，包括 group、材质数组、空属性等边界。

### 3.2 `src/workers/csg.worker.js`（289 行）

模块 worker，消息类型：`csg-ready` / `csg-evaluate` / `csg-result` / `csg-error` / `csg-ack`。

**两级缓存**（这是热路径反超的来源）：

| 缓存 | 键 | 作用 |
|---|---|---|
| `brushCache` | `node.id` + `fingerprint` | 同一个 brush 不重复反序列化、不重复生成 BVH |
| `stageCache` | 链前缀长度 | 缓存 `nodes[0..i]` 的求值结果，编辑链尾时前面 N-1 级直接命中 |

另外带三个探针消息（`csg-cpu-probe` / `csg-solve-probe` / `csg-echo`），只用于基准对比，正常路径不触发。

### 3.3 `src/workers/Pool.js`（391 行）

- 任务队列 + 最少负载调度（派给当前任务最少的 worker）
- 每个 worker 独立的状态 Map（`_sent` 记录已发送的 brush 指纹）
- `AbortSignal` 支持：排队中的任务直接丢弃，运行中的任务标记为孤儿，结果返回后丢弃
- 空闲回收与 `dispose()` 完整清理

10 个单元测试覆盖：并发上限、队列顺序、错误传播、abort、dispose 后拒绝新任务、worker 崩溃恢复。

### 3.4 `src/workers/AsyncEvaluator.js`（305 行）

`Evaluator` 的 Promise 版：

```js
// 上游
const result = evaluator.evaluate( a, b, SUBTRACTION );

// 本项目
const result = await asyncEvaluator.evaluate( a, b, SUBTRACTION );
```

额外 API `evaluateChain(nodes, options)` 处理线性修改器栈，返回 `{ brush, stats }`，`stats` 里有 `reusedStages` 让调用方知道复用了几级。

**降级**：`typeof Worker === 'undefined'` 时 `mode = 'sync'`，走 `_evaluateChainSync`，用 microtask 包成 Promise。调用方代码不变。

### 3.5 工作台（`examples/workbench*`，2760 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| `workbench.html` | 131 | 三栏 shell + 移动端 sheet tabs + HUD |
| `workbench.css` | 583 | 深工业风（`#0b0d10` 底 / `#f0a35e` 琥珀主色），布尔运算四色编码（绿并/红减/蓝交/紫差） |
| `main.js` | 863 | 文档模型、历史、UI 渲染、求值调度、导出 |
| `graph.js` | 502 | 节点模型、5 种图元、3 个预设、`BrushStore`、`History` |
| `viewport.js` | 261 | three.js 场景、剖切平面、三种显示模式、fps 计 |
| `exporter.js` | 79 | glTF / STL / OBJ 导出 |
| `bench.js` | 341 | 主线程 vs worker 基准（含 CPU / solve 探针） |

### 3.6 验证工具（`scripts/`，约 700 行）

| 脚本 | 作用 |
|---|---|
| `_server.mjs` | 检测 5199 端口，没起就程序化启动 Vite，跑完自动关闭 |
| `probe.mjs` | 冒烟：加载、DOM 几何、HUD、canvas 像素 |
| `verify.mjs` | 完整验收：13 张截图 + 12 项交互断言 + 像素统计 |
| `run-bench.mjs` | 跑 `window.__runBench`，写 `docs/shots/bench.json` |

---

## 4. 设计决策

### 4.1 为什么把上游 `Evaluator` 原封不动放进 worker

替代方案是"在 worker 里重新实现一份精简 CSG"。否决理由：

1. 上游 CSG 有 2000+ 行核心算法（half-edge 遍历、三角形分割、浮点鲁棒性处理），复刻必然引入差异；
2. 上游仍在活跃修 bug（issue #73 / #68），复制会永久失去这些修复；
3. 用原版意味着**结果与主线程模式逐字节一致**，这才能做"A/B 对比"的基准。

代价是 worker bundle 要带上完整的 `Evaluator`（约 92KB shared chunk）。可接受。

### 4.2 为什么缓存放在 worker 端而不是主线程

主线程缓存只能省掉"序列化"这一步，省不掉"求解"。而求解是 12–24ms 的大头。放在 worker 端才能让 `stageCache` 命中时**连消息都不用发**（只发指纹，worker 直接返回缓存结果）。

### 4.3 为什么 `evaluateChain` 只支持线性链

工作台的修改器栈天然是线性的（base → op → op → op）。树状 CSG（`OperationGroup`）需要按子树做记忆化，且失效传播比线性链复杂得多。当前不做，记录在 README 的已知限制里。

### 4.4 为什么降级到同步而不是报错

工作台和库的调用方在 Node（测试）、受限 iframe（无 Worker）、主线程（老浏览器）里都可能运行。报错会迫使调用方写两套代码，降级只需要一个 `if`。

---

## 5. 实测（12 轮，同一台机器，同一条 4 节点链）

数据来自 `docs/shots/bench.json`，`npm run bench` 可复现。

| 指标 | Worker | 主线程 | 说明 |
|---|---|---|---|
| 冷路径往返 | 55.1 ms | 24.6 ms | worker 慢 2.2×（每个 brush 都要跨边界） |
| 热路径往返 | **14.7 ms** | 24.0 ms | worker 快 1.63×（前缀缓存） |
| 热路径求解 | 12.8 ms | 23.9 ms | — |
| 冷路径主线程最大卡顿 | 18.5 ms | 32.2 ms | 省 13.7 ms |
| 热路径主线程最大卡顿 | 16.3 ms | 32.4 ms | 省 16.1 ms |
| 帧间隔均值（热） | 14.6 ms | 22.9 ms | — |
| 阻塞帧（热） | **0 / 16** | **2 / 12** | 用户可感知的差别 |
| 前缀复用 | 3 / 4 | 不支持 | — |
| 一次性启动 | 199.4 ms | 0 | — |

**结论（不含修饰）**：单次求值用 worker 是亏的；连续编辑才回本；热路径的优势主要来自 `stageCache` 而非并发本身。

---

## 6. 兼容性守门

`npm test` = **65 passed | 2 todo**，其中：

- 上游原有 **31** 个测试全过（`CSG.Evaluator`、`CSG.Evaluator.options`、`CSG.ResultVolume`、`HalfEdgeMap`、`LegacyTriangleSplitter`、`Utils.*`）
- 新增 **34** 个（protocol 13 / Pool 10 / AsyncEvaluator 11）

新增测试里最关键的一组是 **双模式一致性**：同一组 brush 分别用 `mode: 'worker'` 与 `mode: 'sync'` 求值，断言输出的三角形数、包围盒、体积在容差内一致。这条保证了降级路径不是"能跑但结果不对"。

---

## 7. 未处理的上游问题

以下属于上游算法层，本项目没有触及，如实记录：

1. **三角形分割的边角情况**（issue #73 / #68）：数值精度导致的漏三角形、非法流形。上游 README 自己标注了 "Due to numerical precision and corner cases resulting geometry may not be correctly completely two-manifold."
2. **half-edge 连通性在分割后丢失**：`IMPLEMENTATION.md` 提到分割后边不再对齐，导致后续操作要重新 raycast。本项目的前缀缓存绕过了大部分重复计算，但没有修这个根因。
3. **并行生成 BVH**：`IMPLEMENTATION.md` 的 "Web Worker" 条目前半句，未实现（见 §1.2）。
