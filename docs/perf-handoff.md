# 性能排查交接文档

> 写给接手这项排查的人（或新会话）。
> 配套阅读：[`2026-09-22-changes.md`](./2026-09-22-changes.md)（**改动清单与实测收益**）、[`performance-bottlenecks.md`](./performance-bottlenecks.md)（详细分析与早期结论）、[`architecture.md`](./architecture.md)、[`subscription-optimization.md`](./subscription-optimization.md)。
> **本文档记录的是最近几轮的转折与纠错，其中若干结论推翻了 `performance-bottlenecks.md` 里的早期判断，以本文为准。**
>
> 最后更新：2026-09-22

---

## 一句话现状

**craft.js 的订阅机制不是瓶颈（占比约 2%）。** 真正的开销是一次 mousedown 里有几百个组件重渲染，而拉起它们的是 **Context 广播**，不是 craft。元凶（两个漏写 `useCallback` 的函数）已修复并**验证有效：mousedown 483–526ms → 322–408ms（约 −35%）**。功能回归尚未做（见 9.2）。
**新发现**：LoAF 显示单次点击这一帧 246ms，其中**设备节点的 mousedown 回调独占 162ms**（最可能是 craft 的选中逻辑加上同步重渲染），业务侧的 `flushSelectionOnPointerUp` 占 28ms（见 5.6）。ctx-watch 进一步查明：**每次 dispatch（包括 hover）都会整棵重渲染 Sidebar**，已修复（hover 不再触发，点击帧 246→216ms，见 5.7）。**画布外层 antd `ConfigProvider` 的内联 `getPopupContainer` 会让整个画布的 antd 消费者穿透 memo**，已修复：**mousedown 回调 163→61ms，点击帧 216→97ms**（见 5.8）。hover 帧里的强制布局只出现在普通组件上，不在监控画布路径上，已暂缓（见 5.9）。**监控画布 hover 时每次约 45ms 的 `timerExpired`，根源是我们自己的 craft 补丁让 `onNodesChange` 在每次 dispatch 都回调**，已修复并验证：hover 和点击后不再出现，真实修改照常回调（见 5.10）。下一个目标是 hover 时 craft mouseover 监听的 dispatch 开销，每次 7–9ms、一帧 3–5 次（见 9.1）。

---

## 一、问题与目标

- **仓库**：业务 `E:\code\deeplogic.designer`，craft fork `E:\source-code\craft.js`
- **场景**：2.5D 监控编辑页，约 5000+ 节点、12759 个 DOM
- **症状**：mousedown 响应 >500ms，mouseup >300ms，拖拽卡顿
- **目标**：降低交互延迟。**空闲重绘（管道流动动画）已由用户明确排除在范围外**，只关注交互时的开销

---

## 二、方法论（用户定的规矩，必须遵守）

1. **先埋点 → 取基准 → 改一处 → 再测 → 量化收益**，不允许"改一堆再看总效果"
2. 每一步的结论必须有数据支撑，**不接受"理应更快"的推断**
3. 基准格式示例：`1 次 mousedown -> 4 次 dispatch -> 5000 次 collect -> 仅 3 个结果变化`
4. 分析完先列 to-do 并**征求同意再执行**（见根目录 `CLAUDE.md`）

---

## 三、测量工具

### 3.1 craft 侧临时测量设施（已移除）

本轮曾临时记录 dispatch、collect、结果变化和双 rAF 的到下一帧耗时，用于验证订阅路径优化。测量模块、全局对象和 A/B 开关已在提交前删除；本文件保留的数字只作为历史证据。后续若继续优化，重新建立临时测量后应在验证完成时一并清理。

### 3.2 业务侧 context 依赖探针（已删除）

该临时探针曾用于逐项比对 `contextValue` 的 32 个依赖，已在整体功能回归通过后从业务仓库 `useCanvas.tsx` 删除。

### 3.3 Chrome Performance —— **使用时务必注意量纲**

见下文「四、最大的方法论教训」。

---

## 四、最大的方法论教训（务必先读）

**Performance Summary / Bottom-up 给出的是选定区间内的累计值，不是单次交互的值。**

曾经录制 3.35 秒、内含 5 次点击，看到 `Layerize 539.8ms (21.6%)` 就判定它是"单项最大开销"，据此连做两轮优化（移除 will-change、关闭动画），**全部零收益**——因为单次实际只有约 108ms，被放大了 5 倍。

**正确做法**：录制后在时间轴上**拖选出单次 mousedown 区间**，确认 `Range` 显示约 530ms，再看 Summary / Bottom-up。

另外：**录制时必须关闭 React DevTools Profiler**，否则 `Profiling overhead` 会占到 28.8%，污染全部数据。

### 4.1 第二条量纲教训：`watch()` 的统计窗口会重叠

`watch()` 的窗口是「事件开始 → 双 rAF」，而 mousedown 卡住主线程时用户已经松手，排队的 mouseup/click 会在下一帧 rAF **之前**分发，所以：

- **mousedown 的「到下一帧」包含了 mouseup + click 的开销**
- mouseup 和 click 两条记录的是**同一段工作**（click 只比 mouseup 晚约 8ms 开始，等的是同一帧）

实证：某次 `mousedown: 4 dispatch / 27460 collect` = 自身 `13731` + mouseup 的 `13729`，而 mouseup 与 click 都显示 `2 dispatch / 13729 collect`，完全相同。
**结论**：`watch()` 的数字只能前后对比（同一把尺子），**不能相加，也不能当作单个事件的耗时**。另外它只监听 mouse 事件，pointer 事件上的开销没有统计进去。

### 4.2 Event Timing 的 `duration` ≠ 该事件的开销

`duration` 是「事件开始 → 下一次绘制」，这一帧里任何其他工作（rAF 回调、定时器、其他事件、hover 更新）都会被算进去。**看单个事件的开销要看 `processingEnd - processingStart`**；两者的差值就是「回调之外、绘制之前」的工作量。

---

## 五、已确证的结论（带数据）

### 5.1 单次 mousedown 的真实分布

在正确选区下（`Event: mousedown, Duration 530.44ms`）：

| 分类 | 耗时 | 占比 |
|---|---|---|
| **Scripting (children)** | **483ms** | **91%** |
| System | 36ms | 7% |
| **Rendering** | **11ms** | **2%** |
| Loading | 1ms | — |

**结论：合成层、Layerize、Paint、will-change 全部无关。瓶颈 100% 在 JS。**

### 5.2 Bottom-up（单次区间）——没有热点，只有海量小工作

最大单项仅占 7.8%：

| Self time | 项 | 性质 |
|---|---|---|
| 41.2 / 19.2 / 11.2 / 10.7 / 8.1 / 7.6ms | `Y` `he` `Ne` `ge` `Pe` `ee` @ `index.js:1:1` | **@craftjs 压缩产物**，合计 ≈98ms |
| 28.2ms | `Minor GC` | 渲染期临时对象的副作用 |
| **26.0ms** | **`scheduleContextWorkOnParentPath`** | **Context 传播** |
| 23.3 / 20.2 / 11.2 / 8.8 / 11.7ms | `useMemo` `updateWorkInProgressHook` `FiberNode` `pushEffect` `ReactElement` | hook/fiber 机制，**正比于渲染的组件数** |
| 17.8ms | `diffProperties` | DOM 属性 diff |
| 10.7ms | `formatLanguageCode` @ `i18next.js:890` | 每个组件调 `t()` 都在重复格式化语言码，**可优化** |
| 9.2ms | `Recalculate style` @ **`isVisible.js:6`** | **强制同步布局，可优化** |
| 7.0 / 6.5ms | `warnUnknownProperties` `jsxDEV` | dev-only，生产环境无 |

`Y`/`he`/`Ae`/`Ne` 的调用者链（Bottom-up 展开可见）：`useComponent.tsx:181/185/193`、`useStableEditor.ts:4`、`nodesBox.tsx:44`、`PipeLine.tsx:111`、`PipeJointBridges.tsx:73`——**确认是 craft 的 hook 机制开销**。

> 注意区分：`collect 12.3ms` 是 collector **函数体**执行时间；`98ms` 是 **hook 机制**（`useCollector` 内部的 useMemo/useRef/useEffect 链、订阅注册、`isEqualWith`）。优化前者对端到端无效。

### 5.3 核心矛盾 → Context 广播

```
临时测量：2 次 dispatch -> 13731 次 collect -> 仅 32 个结果变化
changeSources: useInternalNode 的 collector 只有 12 次变化（= 只有 12 个节点数据真的变了）
Profiler:    却有几百个 PipeLine / NodesBox / StateText 在重渲染
```

**12 个节点变化，几百个组件重渲染**——唯一能解释的机制是 Context 穿透 `memo`。

证据链：

| 证据 | 来源 |
|---|---|
| `contextValue` 每次点击都换新引用（10/10） | context 依赖探针 |
| `children` 无辜（0 次换引用） | 同上 |
| `scheduleContextWorkOnParentPath` 26ms | 单次 Bottom-up |
| `propagateContextChange_eager` 37.8ms | 累计 Bottom-up |
| `PipeLine.tsx:244` 确实调用 `useCanvas()` | 代码 |

### 5.4 元凶定位（最新一轮，证据最硬）

逐项埋点比对 `contextValue` 的 32 个依赖，结果：

```
CanvasProvider 渲染 10 次 | contextValue 换引用 10 次
onDrag       9 次   ← 渲染 10 次、首次无基线，9 = 每次必变
onDragStart  9 次
（其余 30 项全部稳定，包括 props.query）
```

原因是它们**根本没被 `useCallback` 包裹**：

```js
const onDragStart = (events) => {...};   // 普通函数字面量
const onDrag = () => {};                 // 空函数，什么都不做
```

一个空函数每次换引用，就把整个 Context 广播给了几百个组件。

**验证结果（2026-09-22，补 `useCallback` 后）**：

```
context 探针：CanvasProvider 渲染 10 次 | contextValue 换引用 0 次   ← 元凶消除
```

| 指标（`watch()` 口径，只比较 dispatch 次数相同的样本） | 基线 | 修复后 |
|---|---|---|
| mousedown（2 dispatch） | 483–526ms | **322–408ms（约 −35%，省约 170ms）** |
| mouseup（0 dispatch） | ~131ms | 140–166ms（无变化） |
| click（0 dispatch） | — | 132–158ms（与 mouseup 是同一段工作，见 4.1） |

遗留线索：CanvasProvider 每次点击仍然渲染 2 次（按下、松开各一次），说明业务侧在这两个时机都有 `setState`。contextValue 稳定之后这两次渲染不会再广播，但本身的来源还没查。

### 5.5 craft 侧发现的真实缺陷：`useEditor` 的 `actions` 引用不稳定

[`packages/core/src/hooks/useEditor.tsx`](../packages/core/src/hooks/useEditor.tsx)

```js
const EditorActions = getPublicActions(internalActions);  // 渲染期无条件执行，每次新对象
const actions = useMemo(() => {...}, [EditorActions]);    // 依赖每次变 → memo 永不命中
```

每个 `useEditor` 调用点、每次渲染都重建 `actions`，且新引用会让下游所有以 `actions` 为依赖的 `useCallback`/`useMemo`/`useEffect` 连锁失效。

**已修复**：把计算移入 `useMemo`，依赖改为 `internalActions`（来自 store 实例，引用稳定）。
这也说明业务侧 `useStableEditor` 的 getter 代理**不是多余保险**，它在兜这个缺陷——其注释「craft 内部本来就是稳定引用」的说法是错的。


### 5.6 单次点击的脚本归属（LoAF，权威口径）

先用 Event Timing 采样，mousedown 的回调「处理」只有 15ms，到绘制却要 144ms，据此一度判断「大头在回调之外」。**这个判断被 LoAF 推翻了**：Event Timing 的 processing 在这里明显少算（可能没包含回调之后的微任务，也可能两次采的不是同一个点击），**以 LoAF 为准**。

光标静止 2 秒后点击 1 次，LoAF 结果：

```
[loaf] 帧 246ms | 阻塞 143ms
入口                                   类型            耗时   强制布局  来源
IMG[src=".../ct_off.webp"].onmousedown  event-listener  162ms  9ms      o@umi.js:469864
BODY.onmousedown                        event-listener   19ms  7ms      @vendors(react-querybuilder/react/redux).async.js:536736
DOMWindow.onpointerup                   event-listener   28ms  0ms      flushSelectionOnPointerUp@src__pages__editor__config__index.async.js
DOMWindow.onmouseup                     event-listener    8ms  2ms      @vendors(...).async.js:543415

[loaf] 帧 67ms | 阻塞 8ms          ← 点击之后单独的一帧
TimerHandler:setTimeout                 user-callback    57ms  0ms      timerExpired@umi.js（lodash debounce）
```

- **大头就在 mousedown 回调里：162ms，占这一帧脚本的约 75%。** 监听挂在设备节点的 DOM 上，最可能是 craft `connectors.select` 的 mousedown（`DefaultEventHandlers.ts:95`）：`setNodeEvent('selected')` 同步通知所有订阅者，React 在同一个回调里完成重渲染，所以渲染时间也算在这 162ms 里。**已确认 `o` 就是 craft 的监听包装函数**：`@craftjs/utils` 的压缩产物里，`addCraftEventListener` 的 `bindedListener` 被压缩成了 `o`（`e.addEventListener(t,o,r)`）。另外 LoAF 的「入口」写的是 **currentTarget**，不是事件目标（证据：`BODY.onmousedown` 对应的正是 React 挂在 BODY 上的 `bound dispatchDiscreteEvent`）。所以这 162ms = craft 挂在设备 IMG 上的 select 监听 → `setNodeEvent('selected')` → collect（约 13ms）→ 32 个订阅者 setState → React 在同一个回调里同步渲染（约 150ms）。**React 自身的根监听只占 19ms**
- `flushSelectionOnPointerUp` 28ms：业务侧代码，名字已经指明
- `BODY.onmousedown` 19ms / `DOMWindow.onmouseup` 8ms：vendors chunk 里的库监听（React 根容器或弹层库的点外关闭），量级较小
- `timerExpired` 57ms：lodash `debounce` 在点击之后才触发，不计入点击延迟，但会造成一次掉帧，后续再查是谁的 debounce
- 强制布局合计约 18ms，分散在各个回调里

旧的 Event Timing 数据仍然有一条可用：**悬停时连续 6 帧到绘制 128–176ms**，hover 的成本还需要用 LoAF 单独测一次。

---

### 5.7 ctx-watch：Sidebar 在每次 dispatch 都整棵重渲染（包括 hover）

React Profiler 的「Why did this render?」在本项目里一律显示 *first time rendered*，**不可信**（见六-3）。改用 ctx-watch 脚本（见 9.1），挂在 `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` 上，逐次 commit 列出换了引用的 Provider、渲染者、具体哪些键变了。

一次点击（连带 hover）的结果：

- **CanvasProvider 没有出现**，5.4 的修复是稳的
- 换引用的 Provider **全部在 Sidebar（Pages / TemplatesPanel / DataPanel / DataSourcesPanel）、Toolbar 和 Settings（ArraySetter）里**，没有一个是画布物料的祖先。所以画布上 PipeLine / NodesBox 的重渲染来自 craft 自己的订阅，**不是 Context 广播**
- **点击和 hover 的每个 commit 都以 `PagesProvider < Sidebar` 开头**：每一次 dispatch 都会把整个 Sidebar 重渲染一遍，这和「悬停帧 128–176ms」对得上
- Sidebar 一渲染，子树里的 Context 就跟着全部换引用，形成第二层放大：`PagesProvider` 的 value 没有 memo（键全相同、仅外层对象换了），rc-tree 收到内联的 `switcherIcon` / `draggable` / `titleRender`，Tabs 收到内联的 `tabs` 数组，antd Select 的一串回调也都是新的

**根因是 `sidebar.jsx:487`**：`useStableEditorSelector((state) => state.nodes)`

1. hover 和选中都会改 `node.events`，Immer 给 `state.nodes` 换了引用，所以这个选择器**每次必中**。9.3 之前估计它「影响小」，是只算了 Sidebar 自身的 2ms，没算连带的子树
2. `useEditor` 的返回值是 `{ connectors, actions, query, store, ...collected }`，会**把数千个节点展开进一个新对象，而且每次渲染都换引用**，下游的 `useMemo([active, layerNodesSource])` 永远不会命中
3. 这份全量 nodes **只有图层 tab 用得到**

修复方案见 7.1。**实测结果**（非图层 tab 下）：

| 指标 | 改动前 | 改动后 |
|---|---|---|
| hover 时 Sidebar 重渲染 | 每次 dispatch 都渲染 | **不再出现** ✅ |
| 点击帧总时长（LoAF） | 246ms | **216ms（−30ms）** |
| mousedown 回调 | 162ms | 163ms（**没变**） |
| `flushSelectionOnPointerUp` | 28ms | 17ms |

点击时 Sidebar 仍然会渲染（444 行的 `selectedLayerKey` 确实变了），它的子树也还在逐层放大（PagesProvider、rc-tree、Tabs 的内联 props）。**mousedown 里那 162ms 不在 Sidebar 上。**
hover 帧改动前是 128–176ms；这次 LoAF 没有输出 hover 帧，如果测试时确实划过了设备，就说明已经降到 50ms 以下，**有待确认**。

### 5.8 画布外层的 antd `ConfigProvider` 每次点击都换引用

改完 sidebar 之后，ctx-watch 在点击的 commit 里还抓到：

```
ProviderChildren < ConfigProvider < GlobalThemeProvider < EditorCanvas   getPopupContainer
ProviderChildren < ConfigProvider < GlobalThemeProvider < EditorCanvas   date, types, string, number, array, pattern（表单校验文案）
V < Te < je < Ie                                                          (键全相同，仅外层对象换了)
```

根因在 `useGlobalTheme.tsx`：`<ConfigProvider getPopupContainer={() => ...}>` 传的是内联函数。

- 这个 `ConfigProvider` **包着整个画布**（`<Frame>` 就在它里面）
- antd 的 ConfigContext 由 `useMemo` 计算，依赖里有 `getPopupContainer`。它一换引用，校验文案 context 也被连带重算
- 结果是画布里**所有 antd 消费者都被 Context 穿透 memo 强制重渲染**。Profiler 画布 commit 里排前两名的 `Context.Provider (5.5ms / 4.7ms)`、成片的 `TypographyText (Memo)`，都能用它解释
- 同一个文件第 34 行已经有一个模块级的 `getThemeModalContainer`，逻辑完全一样

修复：直接改用 `getThemeModalContainer`。**实测结果**：

| 指标 | 改动前 | 改动后 |
|---|---|---|
| ctx-watch 里的 `ConfigProvider < GlobalThemeProvider` | 每次点击都出现 | **消失** ✅ |
| **mousedown 回调（LoAF）** | **163ms** | **61ms（−63%）** |
| **点击帧总时长** | 216ms | **97ms（−55%）** |
| BODY.onmousedown（React 根监听） | 16ms | 16ms |

**这是整轮收益最大的一刀。** 点击帧的演进：约 530ms（Performance 选区）→ 246ms（CanvasProvider 修复后）→ 216ms（Sidebar 修复后）→ **97ms**。
pointerup / mouseup 没有再出现在 LoAF 里，说明它们落在了 50ms 以下的帧里。

`V < Te < je < Ie`（键全相同，仅外层对象换了）改完后**依然存在**，所以它不是 ConfigProvider 连带出来的。它来自某个压缩过的库（很可能就是 craft），只有一个实例，先记下来。

### 5.9 新暴露：Scheduler 帧约 95ms，其中强制布局占一半

同一次测量里，mousedown **之前**有 4 帧：

```
MessagePort.onmessage  event-listener  100ms  强制布局 46ms  eventListener@umi.js:25252125
MessagePort.onmessage  event-listener   94ms  强制布局 48ms
MessagePort.onmessage  event-listener   90ms  强制布局 46ms
MessagePort.onmessage  event-listener   95ms  强制布局 55ms
```

- 入口是 React Scheduler（非离散事件的更新走 MessageChannel 调度）。时间上最像**光标移向设备时的 hover**：craft 在 rAF 里派发 hover，产生的 setState 不属于离散事件，交给 Scheduler 异步渲染。**尚待确认**
- **强制布局占约一半**：渲染或 layout effect 里有代码先写 DOM 再读布局。候选有 `isVisible.js:6`（见 5.2）、Moveable 这类量尺寸的逻辑
- LoAF 只能看到入口，看不到是谁触发了强制布局，需要用 Performance 的 *Forced reflow* 调用栈来定位

**后续排查结论：它不在监控画布的交互路径上，暂缓。**

- Performance 定位到 `hover.jsx:138` 的 layout effect → `getViewportRect`（`hover.jsx:45`）→ `getBoundingClientRect`，强制 Recalculate style 49ms，Elements affected 3217
- 但**监控画布里的设备不挂 Hover 组件**（没有 hover 标签和边框），只有普通组件才会挂载 tooltip。只在设备之间来回 hover 时，LoAF **没有强制布局，也没有 MessagePort 帧**。上面那几帧是鼠标从控制台移进画布时，顺路划过普通组件产生的
- 已排除的原因：往 portal 容器（10457 个后代）插入空 div 只要 0.1–0.2ms；`.designer-stateful-hovered` 的规则没有后代选择器；管道动画开启和暂停时，每帧的样式成本都约为 0
- 尚未排除：tooltip 身上的 class / id 命中了某些全局规则，或者鼠标移入引起的 `:hover` 失效。**普通组件的 hover 成本，以后需要时再查**（克隆 tooltip 做 A/B 的脚本见本轮会话记录）

### 5.10 `onNodesChange` 每次 dispatch 都回调：我们自己补丁引入的回归

只在设备之间 hover 时，LoAF 里每次都有一帧 `timerExpired`（lodash debounce）约 45ms。来源是 `designer-view.jsx:241`：

```js
const onNodesChange = useCallback(debounce((query) => {
  const json = query.serialize();   // 5000 节点全量序列化 + JSON.stringify
  // 与基准比对 → 标记 / 清除「已修改」
}, 300), []);
```

**它的功能是必要的**：维护「组态已修改」标记（未保存拦截、撤销回原样自动变干净、首次水合记基准）。**但它在 hover 和选中时被调用是浪费**：`serialize()` 只读节点集合、每个 `node.data` 和 `options.resolver`（`NodeHelpers.toSerializedNode` → `serializeNode`），而 hover 和选中只改 `node.events`，序列化结果不可能变化。

**根因**：原版 craft 的 collector 就是 `query.serialize()`，结果相等就不回调，语义是「只有数据真的变了才回调」（业务代码的注释也写着这一点），代价是每次 dispatch 都同步序列化。我们的补丁把 collector 换成了自增计数器，省掉了同步序列化，但计数器每次都变，**退化成了每次 dispatch 都回调**。序列化的开销只是从同步挪到了 debounce 之后，并没有被消除。

**修复（craft `Editor.tsx`）**：collector 改为比较引用，只有节点集合、某个节点的 `data`、`options.resolver` 这三者之一变化时才递增版本号。这样恢复了原版语义，但不需要序列化。

- 正确性：craft 内所有 `.data.x =` 的写法，要么在 Immer draft 里，要么是给还没入库的新节点赋值，**不存在绕过 Immer 原地修改 `data` 的情况**，所以引用比较不会漏报
- 开销：hover 这类操作要做 O(n) 次引用比较（5000 节点约 0.1ms）；`nodes` 引用没变的操作（setIndicator、setOptions）直接跳过
- 不涉及之前修过的订阅机制（Subscriber、useCollector、路径索引、initialCollected、空 dispatch 防护）；首次 notify 照旧必定回调
- 单测：`Editor.test.tsx` 由 3 个用例扩充到 13 个。hover、选中、setDOM、不改 resolver 的 setOptions **不**触发回调；setProp、setHidden、增删节点、撤销重做、更换 resolver **会**触发回调；首次变化必定回调。全量 **156/156** 通过

**业务侧的隐性依赖（已先行修复）**：业务里有 6 处约定「先把基准置为 null，由下一次 `onNodesChange` 重新记基准」。过去这其实是靠随便一次 hover **碰巧兜住**的。逐个核对后，其中 5 处置 null 之后紧跟 `deserialize`，数据必然变化，是安全的。有风险的是 `useVersionPreview.ts` 的 `restoreDirtyState`：退出历史版本预览时，如果 snapshot 没有 content，就会跳过 `deserialize`，基准一直悬空，**用户的第一次真实编辑会被误记为基准，切页不提示保存**。

修复方式：`helper/utils.js` 新增 `requestDesignerBaselineCapture()`（由 `designer-view.jsx` 注册，内部用已保存的 query 调用那个防抖过的 `onNodesChange`），`restoreDirtyState` 置 null 之后显式调用它。
**刻意没有放进 `setDesignerBaseline(null)` 里全局生效**：`designer-view.jsx` 在退出模板预览时，会在回调内部置 null，那时真实内容还没灌入，不能提前补记基准。

**实测结果**（LoAF）：

| 场景 | 预期 | 实测 |
|---|---|---|
| 设备间 hover | `timerExpired` 消失 | 修复前每帧 44–47ms → **消失** ✅ |
| 点击设备 | 点击后没有 `timerExpired` | **没有出现** ✅ |
| 修改属性 | 出现**一次** `timerExpired` | `DIV#root.oninput` 32ms 之后跟了**一次** `timerExpired` 24ms ✅（真实修改没有被误伤） |

**确认补丁已加载的方法**：不要依赖运行时测量对象判断版本。可靠的方法是看 LoAF 里 craft 监听的来源偏移：从 `o@umi.js:469864` 变成了 `470141`，正好后移 277 个字符，与新 core 产物增大的字节数（38534 → 38811）完全吻合。

**hover 帧里剩下的开销**：修复后 hover 帧仍有 51–76ms，里面是 craft 自己的 mouseover 监听，**每次 7–9ms，一帧 3–5 次**（光标一帧内划过多个元素，每个都触发一次 `setNodeEvent('hovered')`）。单次 7–9ms 与「每次 dispatch 约 6.9k 次 collect、约 6.8ms」的实测量级一致（见 5.3：2 次 dispatch → 13731 次 collect、13.4ms）。mouseover 在 React 里是连续事件优先级，渲染不在监听函数里同步执行，所以这 7–9ms 基本就是 dispatch 加 collect 本身。**这是 hover 路径上的下一个目标**（见 9.1）。

## 六、已证伪的假设（不要重走）

| # | 假设 | 证伪方式 | 结论 |
|---|---|---|---|
| 1 | craft 订阅/collect 是瓶颈 | collect 仅占 530ms 的约 2% | **证伪**。三轮订阅优化端到端收益均为 0 |
| 2 | React dev build 是主因 | 生产环境实测 ~515ms vs dev ~600ms | 仅快 15%，**不是主因** |
| 3 | 组件被卸载重挂（树重建） | 埋点实测 mount 0 / unmount 0 | **证伪**。DevTools "first time rendered" 是其自身记账产物 |
| 4 | Resizer 是所有物料的公共外壳 | `__MOUNT__` = 19 | **证伪**，文本物料不走 Resizer |
| 5 | hover 抖动（10 次 `setNodeEvent`）是大头 | A/B（移入即点 vs 停留 2 秒再点）dispatch 均为 2 | **证伪**，发生在 mousemove，不在 mousedown 帧内 |
| 6 | 高层组件（Layout/Sidebar）拖垮整棵树 | Flamegraph 中 `BasicLayout`→`Layout`→`Content`→`Outlet` 全为灰色斜线 | **证伪**，它们未渲染 |
| 7 | **常驻 `will-change` 造成层爆炸** | 从 1382 降到 **17**，层数 1805 → **1822（反而略增）** | **证伪**。且 `Compositing reasons` 明确显示 `Overlaps other composited content` |
| 8 | 管道流动 `animation` 是合成层种子 | 注入 `animation: none !important`，层数 1822 **完全不变**，耗时不变 | **证伪** |
| 9 | `Layerize 539.8ms` 是单项最大开销 | 那是 5 次点击的累计；单次 Rendering 仅 11ms | **证伪，量纲错误** |
| 10 | `contextValue` 的 children 依赖是元凶 | context 探针显示 children 换引用 0 次 | **证伪**，`selectTool.tsx:62` 的注释是对的 |

> 第 7 条需特别说明：`performance-bottlenecks.md:389` 曾以「关闭后 1610→1382、耗时无变化」判定 will-change 无罪。**该实验设计有缺陷**——只砍掉 14%，主力在 `transform.ts` 的 `resolveMonitorTransform`（无条件写入）。本轮把全部 will-change 移除（→17）后**仍然无收益**，这才是有效的证伪。

---

## 七、改动清单

### 7.1 业务仓库 `E:\code\deeplogic.designer`

| 文件 | 改动 | 收益 | 状态 |
|---|---|---|---|
| **`useCanvas.tsx:306, 371`** | **`onDragStart` / `onDrag` 补 `useCallback`** | **mousedown −35%（约 170ms）** | ✅ 性能已验证；⏳ 功能回归待做（9.1） |
| `useComponent.tsx` | 新增 `getComponentEditorSnapshot`，两个全局订阅合并为一个 | 订阅 9605→6857，collect −29%，**端到端 0** | 已验证无收益，保留（无害） |
| `DesignerCanvas.tsx:578` | `getCachedPositionStyle`，按签名缓存 `positionStyle` 引用 | **端到端 0** | 保留（让 memo 真生效，无害） |
| `transform.ts:51` + `nodesBox.tsx:30` + 7 处管道/母版 + 2 处 less | 移除全部常驻 `will-change`（1382→17） | **端到端 0** | 保留（省层内存，符合 MDN） |
| `web/src/app.js` | `localStorage.__NO_CTC__` 开关，可关闭 `click-to-component` | 测量必需 | 保留 |
| `useCanvas.tsx` | context 依赖探针 | 诊断用 | ✅ **整体回归后已删除** |
| **`sidebar.jsx:487`** | **`state.nodes` 订阅按图层 tab 门控**：用 `activeRef` 读 tab，非图层 tab 返回 `null`；结果包一层 `{ layerNodes }`，避免展开数千节点；刚切到图层 tab 时用 `query.getState().nodes` 兜底 | hover 不再重渲染 Sidebar；点击帧 246→216ms；mousedown 回调没变 | ✅ 已测量；⏳ 功能回归待做（9.2） |
| **`useGlobalTheme.tsx`** | **画布外层 `ConfigProvider` 的 `getPopupContainer` 改用模块级的 `getThemeModalContainer`**（见 5.8） | **mousedown 回调 163→61ms，点击帧 216→97ms** | ✅ 已测量 |
| `helper/utils.js` + `designer-view.jsx` + `hooks/useVersionPreview.ts` | 新增 `requestDesignerBaselineCapture()`，`restoreDirtyState` 置 null 后显式请求补记基准（见 5.10） | 正确性保障，配合 craft `Editor.tsx` 的改动 | ✅ 已改；⏳ 功能回归待做（9.2） |

### 7.2 craft 仓库 `E:\source-code\craft.js`

| 文件 | 改动 | 状态 |
|---|---|---|
| **`core/src/hooks/useEditor.tsx`** | **`actions` 引用稳定化**（见 5.5） | ✅ 已构建、已打 patch |
| `utils/src/perf.ts` | 临时测量设施 | ✅ **已删除** |
| `utils/src/useMethods.ts` | 路径索引订阅、空 dispatch 防护 | 已在 patch |
| `utils/src/useCollector.tsx` | `initialCollected` 修复首次 notify 的假变化（959→67） | 已在 patch |
| `core/src/editor/actions.ts` | `setNodeEvent` 早返回 | 已在 patch |
| `core/src/editor/Editor.tsx` | `onNodesChange` 不再全量序列化；**2026-09-22 修正：只在节点数据变化时回调**，hover 和选中不再触发（见 5.10） | ✅ 已构建、已打 patch；✅ 已测量（hover 与点击后的 `timerExpired` 消失，真实修改照常回调） |
| `core/src/render/RenderNode.tsx` | `onRender` 改路径索引订阅 | 已在 patch |
| `core/src/events/DefaultEventHandlers.ts` | rAF 调度器（97 rAF/帧 → 1） | 已在 patch |

单测状态：**156 passed / 156**（`experimental/slate/splitSlate` 那个 suite 失败是既有问题，与 core 无关）。

> jest 的 `testMatch` glob 在 Windows 上匹配不到文件，需显式指定：
> `npx jest --testMatch="**/*.test.tsx" --testMatch="**/*.test.ts"`

---

## 八、打 patch 流程（已验证可用）

```bash
# 1) craft 仓库：构建
cd E:/source-code/craft.js/packages/core
npx cross-env NODE_ENV=production npx rollup -c rollup.config.js

# 2) 业务仓库：创建编辑目录
cd E:/code/deeplogic.designer
pnpm patch "@craftjs/core@0.2.12" --edit-dir <EDIT_DIR>

# 3) 先用「当前已打 patch 的 node_modules」覆盖，保住既有改动
cp -r node_modules/@craftjs/core/lib/. <EDIT_DIR>/lib/
cp -r node_modules/@craftjs/core/dist/. <EDIT_DIR>/dist/
# 4) 再用新构建产物覆盖入口
cp <craft>/packages/core/dist/esm/index.js <EDIT_DIR>/dist/esm/index.js
cp <craft>/packages/core/dist/cjs/index.js <EDIT_DIR>/dist/cjs/index.js
# 5) 剥离 sourcemap / tsbuildinfo，避免混入巨大 diff
find <EDIT_DIR> \( -name "*.map" -o -name "*.tsbuildinfo" \) -delete

# 6) 提交（先备份旧 patch！）
cp patches/@craftjs__core@0.2.12.patch <备份路径>
pnpm patch-commit <EDIT_DIR>
```

`patchedDependencies` 在业务仓库根 `package.json`，含 `@craftjs/core@0.2.12`、`@craftjs/utils@0.2.5`、`@rc-component/trigger@3.10.1`。
**`@craftjs/utils` 是 rollup external，需要独立的 patch。**

**打 patch 前建议做一致性校验**：用 Python 对比「新构建产物」与「当前 node_modules（已打 patch）」，确认差异只包含本次改动——这可验证 craft 源码仓库的状态与线上 patch 一致，不会丢失早期改动。本次校验结果为 13 个差异块，全部集中于 `useEditor` 的 `actions` 改动，符合预期。

---

## 九、当前待办

### 9.1 立即：量化 hover 的 dispatch 开销（**最高优先级**，背景见 5.10 末尾）

`onNodesChange` 的修复已验证通过（见 5.10）。hover 帧里剩下的是 craft 的 mouseover 监听，每次 7–9ms，一帧 3–5 次。**先取数据，再决定改法**：

```js
重新建立一次临时测量；只在设备之间来回划 3～5 秒，不点击。
```

需要读出的数据：dispatch 次数（其中 `setNodeEvent` 占多少）、每次 dispatch 的 collect 次数和耗时，以及变化来源排行（每次 hover 到底有多少个 collector 结果真的变了）。

两个候选方向，**等数据出来再选**：
- **合并同一帧内的多次 hover**：把 mouseover 记成待处理，每帧只派发一次 `setNodeEvent('hovered')`，mousedown 时先同步冲掉待处理的 hover。一帧 3–5 次会降到 1 次
- **减少每次 dispatch 的全局 collect**：找出没声明 dependencies 的全局订阅者（业务侧的 `useEditor` / `useStableEditor`），让它们不再被 hover 拉起

ctx-watch 脚本（贴进控制台；第一次 commit 只建基线；停止用 `__CTX_WATCH_STOP__()`）：

```js
(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const orig = hook.onCommitFiberRoot;
  const seen = new WeakMap(); // fiber -> 上次看到的 value（current 和 alternate 都记，避免跳过的子树误报）
  const nameOf = (f) => {
    const t = f && f.type;
    if (!t) return '?';
    return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || '?';
  };
  const owners = (f) => {
    const out = [];
    for (let o = f._debugOwner; o && out.length < 4; o = o._debugOwner) out.push(nameOf(o));
    return out.join(' < ') || '(无 owner)';
  };
  const diffKeys = (a, b) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return '(非对象整体替换)';
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.filter((k) => a[k] !== b[k]).join(', ') || '(键全相同，仅外层对象换了)';
  };
  let commit = 0;
  hook.onCommitFiberRoot = function (id, root) {
    commit++;
    const rows = [];
    let f = root.current; // 迭代遍历 fiber 树，tag 10 = ContextProvider
    while (f) {
      if (f.tag === 10) {
        const value = f.memoizedProps?.value;
        if (seen.has(f) && seen.get(f) !== value) {
          rows.push({ commit, 渲染者: owners(f), 变化的键: diffKeys(seen.get(f), value) });
        }
        seen.set(f, value);
        if (f.alternate) seen.set(f.alternate, value);
      }
      if (f.child) { f = f.child; continue; }
      while (f && !f.sibling) f = f.return;
      if (f) f = f.sibling;
    }
    if (rows.length) console.table(rows);
    return orig.apply(this, arguments);
  };
  window.__CTX_WATCH_STOP__ = () => { hook.onCommitFiberRoot = orig; };
})();
```

LoAF 监听脚本：

```js
new PerformanceObserver((list) => list.getEntries().forEach((f) => {
  console.groupCollapsed(`[loaf] 帧 ${Math.round(f.duration)}ms | 阻塞 ${Math.round(f.blockingDuration)}ms`);
  console.table(f.scripts.map((s) => ({
    入口: s.invoker,
    类型: s.invokerType,
    耗时: Math.round(s.duration),
    强制布局: Math.round(s.forcedStyleAndLayoutDuration),
    来源: `${s.sourceFunctionName}@${s.sourceURL.split('/').pop()}:${s.sourceCharPosition}`,
  })));
  console.groupEnd();
})).observe({ type: 'long-animation-frame' });
```

`类型` 的含义：`event-listener` 是事件回调，`user-callback` 通常是 rAF 或定时器，`resolve-promise` 是微任务。LoAF 只记录超过 5ms 的脚本；它的「入口」写的是 currentTarget。

测完之后的下一步候选：
- `EditorCanvas` 为什么在点击时重渲染（它是 memo 的，说明 `useDesigner` / `useLayout` 里有东西变了）。它一渲染，`<Frame>` 就是新的 children
- `V < Te < je < Ie`：压缩库里的某个 Provider 每次点击都换外层对象（见 5.8）
- Sidebar 子树的第二层放大：`PagesProvider` 的 value 补 memo，rc-tree / Tabs 的内联 props（见 5.7）
- 画布物料的重渲染来源：重新建立临时测量，查点击时哪些 collector 变了
- `flushSelectionOnPointerUp`（17ms）

### 9.2 待统一回归（用户安排后续集中做）

`useCanvas.tsx` 改动了拖拽起点的计算，需要逐项确认：

- [x] 单选拖拽：位置连续，不跳飞
- [x] 旋转过的节点：拖拽后角度保留
- [x] 多选拖拽
- [x] 母版内节点拖拽（注释提到的时序窗口）
- [ ] 母版转换后，点击编辑，再保存，回到原来的画布，点击脱离，设备没有正确还原
- [x] 拖拽后撤销能回到原位

`sidebar.jsx:487` 改动了图层 tab 的数据来源：

- [x] 切到图层 tab，列表首帧不为空
- [x] 在图层 tab 下删除、拖拽、改名节点，列表实时更新
- [x] 在其他 tab 改动节点后切回图层 tab，显示的是最新数据
- [x] 图层搜索正常（包括改名后能按新名字搜到）

craft `Editor.tsx` 的 `onNodesChange` 改动，加上业务侧补记基准，影响的是「已修改」标记：

- [x] 打开页面什么都不做，切页**不**提示未保存
- [x] 改一个属性后切页，**会**提示未保存
- [x] 改完再撤销回原样，「已修改」标记自动消失
- [x] 只 hover、只点选设备，**不会**被标记为已修改
- [ ] 进入历史版本预览再退出，然后改一个属性，**会**提示未保存（这是本次重点修复的场景）
- [x] 切页、切模板 tab、从模板预览切回项目页之后，首次打开都不是脏的
- [x] 保存成功后，「已修改」标记被清除

业务仓库 `useCanvas.tsx` 的 context 依赖探针已删除。

### 9.3 后续候选（按证据强度排序）

| 项 | 依据 | 预估 |
|---|---|---|
| `formatLanguageCode` @ i18next | 单次 Bottom-up 10.7ms | ~10ms |
| `isVisible.js:6` 强制同步布局 | 单次 Bottom-up `Recalculate style` 9.2ms | ~9ms |
| `useSelected` 合并进 `useComponent` | 管道类物料同时调 `useComponent`(内含 `useNode`) + `useSelected`(再一个 `useNode`)，共 5 套 hook 链 | 中，回归面大 |
| 普通组件 hover 的强制布局（`hover.jsx:45`，49ms，3217 个元素） | 不在监控画布路径上，暂缓（见 5.9） | 只影响普通组件的 hover |
| `setDOM` 不应广播 | 实测 2 次 dispatch → 16430 次 collect → 仅 6 个变化 | 纯浪费，但不在 mousedown 路径 |

### 9.4 明确不做

- 管道流动动画的空闲重绘（**用户明确排除**）
- 合成层 / Layerize / will-change 方向（已充分证伪，见六-7、六-8）
- 当前不继续优化 craft 订阅层：已有三轮实测端到端收益为 0；useMethods 后续候选只在 `2026-09-22-changes.md` §4 第 7 项记录，待整体回归和新数据后重开

---

## 十、协作注意事项

1. **遵守根目录 `CLAUDE.md`**：中文回复；未经同意不改文件；分析后先列 to-do 并询问；CSS 用短横杠命名；**禁止 `for-in`**；多写注释
2. **图片尺寸**：用户截图常超过 2000px，会导致整个带图请求被拒，且**历史中存在超限图片时，后续任何带图请求都会失败**（本地缩放也绕不过）。遇到这种情况请用户**贴文本**，例如相关对象的 `JSON.stringify(...)` 或控制台表格右键 Copy table
3. **每次只改一处、单独量化**，这是用户反复强调的要求
4. 报告结论时**如实说明收益为 0**——本轮多次出现"理应有效但实测无收益"，如实记录比给出乐观推断更有价值

---

## 十一、写给接手者的一段话

这轮排查前后做了约六次优化，**其中四次端到端收益为零**。回头看，失败的根因高度一致：**先有假设，再去找支持它的数据**；而成功的两次（定位 Context 广播、定位 `onDragStart`/`onDrag`）都是**先让数据说话，再解释**。

如果接下来的改动又出现"理应更快但没变化"，不要继续在同一方向加码——**回到单次区间的 Bottom-up，重新确认量纲，再挑下一个目标。**
