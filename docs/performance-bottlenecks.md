# Craft.js 编辑器性能卡点分析与优化路线

> ⚠️ **本文部分结论已被后续实测推翻，阅读前请先看 [`perf-handoff.md`](./perf-handoff.md)。**
>
> 主要变更：
> - **订阅/collect 不是瓶颈**（仅占单次 mousedown 的约 2%），本文围绕订阅优化的多项方案实测端到端收益为 0
> - 本文 §「已证伪的怀疑二：常驻 will-change」**实验设计有缺陷**（只移除了 14%），后续完整移除（1382→17）仍无收益，结论虽相同但依据应以新文档为准
> - 本文 §「待处理：Layerize 与 1805 个合成层」基于**累计数据的量纲错误**，单次 mousedown 的 Rendering 仅 11ms（2%），该方向已废弃
> - 真正的瓶颈是 **Context 广播导致几百个组件重渲染**，元凶已定位并修掉，**单次点击帧从约 530ms 降到 97ms**
> - 本文 §「现有补丁做了什么 / 改动 3」把 `onNodesChange` 的 collector 换成自增计数器，
>   并判断「实际影响可控」——**这是错的，它是一个回归**：每次 hover 都会让业务侧 debounce 后白跑一次
>   全量序列化（约 45ms）。已于 2026-09-22 改为按引用比较修复
> - 本文 §「Performance Summary 的真实分布」（Rendering 34.5% / Scripting 34.2%）是**累计值**，
>   单次 mousedown 的真实分布是 Scripting 91% / Rendering 2%
> - 本文 B 组 / C 组的「预期收益」多数**未兑现**，逐条实测结果见下文就地更正与 `perf-handoff.md` §七
>
> 关联文档：[整体架构](./architecture.md)、[订阅机制与优化方向](./subscription-optimization.md)、[**交接文档**](./perf-handoff.md)
>
> 本文解决的是真实业务现象：**节点数量多时（约 1000+），编辑器页 `mousedown` 响应超过 500ms、`mouseup` 超过 300ms，拖拽过程有明显卡顿。**

## 结论先说

`subscription-optimization.md` 里已经落地的两层优化（`setNodeEvent` 集合去重、`dispatch` 引用比较、Watcher 按 patch path 建依赖索引）方向是对的，但**它们解决的是"广播次数多"，而当前的卡顿主要来自"每次广播里存在几个极其昂贵的 collector"**。

换句话说：

```text
原以为：1 次点击 -> 4 次广播 -> 每次 1000 个便宜的 collector   （减少广播次数即可）
实际是：1 次点击 -> 4 次广播 -> 每次都有 1 个「全量序列化整棵树」的 collector
```

所以下面的 P0 不修，后面的优化在数字上都看不出来。

## 一次点击到底 dispatch 了几次

这是理解"为什么 collector 重复执行很多次"的前提。单次点击选中一个节点，实际会产生 3~4 次独立 dispatch：

```text
mouseover  -> setNodeEvent('hovered', id)      dispatch #1
mousedown  -> setNodeEvent('selected', ids)    dispatch #2
click      -> setNodeEvent('selected', ids)    dispatch #3（多选/收敛分支才有）
mouseleave -> setNodeEvent('hovered', null)    dispatch #4（removeHoverOnMouseleave 开启时）
```

拖拽一次的 dispatch 更多：

```text
dragstart -> setNodeEvent('selected') + setNodeEvent('dragged')   2 次
dragover  -> setIndicator（Positioner 已做 isDiff 去重，只在位置变化时）
dragend   -> move + setIndicator(null) + setNodeEvent('dragged', null)   3 次
```

每一次 dispatch 都会走一遍完整的 `Watcher.notify`。所以任何在 notify 链路上的昂贵操作，都会被乘以 3~5 倍。

## 真正的卡点

### ① 致命：`Editor` 内部有一个全局订阅，每次 dispatch 都全量序列化整棵树

> **⚠️ 更正（实测后）：业务项目 `deeplogic.designer` 的现有补丁已经修掉了这一条。**
> 详见下文「现有补丁做了什么」。upstream craft.js 仍然存在此问题，但**对该业务项目不再是卡点**。
> 下面保留原始分析，作为 upstream 问题的记录。

文件：`packages/core/src/editor/Editor.tsx`（`onNodesChange` 订阅处）

```ts
context.subscribe(
  (_) => ({ json: context.query.serialize() }),   // 没有 dependencies -> 进入 globalSubscribers
  () => {
    context.query.getOptions().onNodesChange(context.query);
  }
);
```

`serialize()` 的成本链路：

```text
query.serialize()
  -> getSerializedNodes()            遍历 state.nodes 的所有 key
  -> NodeHelpers(state, id)          每个节点新建 ~30 个闭包
  -> toSerializedNode()
  -> serializeNode / serializeComp   递归深拷贝 props（含 children 递归）
  -> JSON.stringify(整棵树)
```

问题点：

- 它是**全局订阅**，`setNodeEvent`、`setIndicator`、`setDOM` 这些与节点数据完全无关的 action 也会触发。
- 它**无条件注册**。业务侧即使没有传 `onNodesChange`，序列化照样每次都跑。
- collector 里做重活，`isEqualWith` 只能在事后阻止 React 更新，救不了已经花掉的时间。

量级估算：1000 节点单次 `serialize()` 约 30~150ms（取决于 props 复杂度），一次点击 × 3~4 次 dispatch，**刚好对上 500ms**。拖拽时每次 indicator 变化都跑一遍，就是"拖拽有卡顿感"的直接来源。

> ⚠️ **更正**：「刚好对上 500ms」是**凑数字凑出来的因果**。该业务项目的补丁早就去掉了这处同步序列化，
> 而 mousedown 依旧是 500ms+。500ms 的真实构成见 `perf-handoff.md` §5.1（Scripting 91%，其中大头是
> Context 广播引起的重渲染）。**本条的教训：先有假设再找数据支持它，很容易凑出一个自洽但错误的解释。**

### ② 每个节点一个全局订阅：`RenderNodeToElement`

文件：`packages/core/src/render/RenderNode.tsx`

```ts
const { hidden } = useInternalNode((node) => ({ hidden: node.data.hidden }));   // 已按 ['nodes', id] 索引，OK

const { onRender } = useInternalEditor((state) => ({
  onRender: state.options.onRender,                                            // 未声明依赖 -> 全局订阅
}));
```

`onRender` 本质是**静态配置**，几乎不会变，却让每个渲染中的节点都挂了一个全局订阅。

```text
N 个节点 = N 个 globalSubscribers
每次 dispatch = N 次 collector 调用 + N 次 isEqualWith + N 次 try/catch
```

单个 collector 很便宜，但 1000 次加起来仍是几 ms 到十几 ms，且被 dispatch 次数放大。

### ③ 图层面板：每行 4 个全局订阅，其中 2 个带树遍历 + 深比较

文件与订阅：

| 文件 | collector 内容 | 成本 |
| --- | --- | --- |
| `packages/layers/src/layers/LayerNode.tsx` | `data: state.nodes[id].data` + `query.node(selected).ancestors(true)` | **整个 `data`（含 props）走 lodash 深比较** |
| `packages/layers/src/layers/useLayer.tsx` | `query.node(id).descendants()` | 每次新建 NodeHelpers + 数组 |
| `packages/layers/src/layers/DefaultLayer/DefaultLayer.tsx` | `query.node(id).isParentOfTopLevelNodes()` | 轻，但是全局 |
| `packages/layers/src/layers/DefaultLayer/DefaultLayerHeader.tsx` | `query.getEvent('selected').first()` + `isTopLevelCanvas()` | 轻，但是全局 |

编辑器页如果同时开着图层树，1000 节点大约是：

```text
4000 个全局 collector + 1000 次 node.data 深比较   ——— 每一次 dispatch
```

### ④ `isEqualWith` 的深比较是隐藏成本

文件：`packages/utils/src/useMethods.ts`（`Subscriber.collect`）

```ts
const recollect = this.collector();
if (!isEqualWith(recollect, this.collected)) { ... }
```

这里用的是 lodash `isEqual`（未传 customizer），即**完全深比较**。凡是 collector 返回了下列内容，比较本身就是 O(树大小)：

- `state.nodes` / `node.data` / `node.data.props`
- 节点数组、`descendants()` 结果
- `state.indicator`

`indicator` 尤其糟：`indicator.placement.parent` 是完整的 Node 对象，**带 `dom`（真实 DOM 元素）**，拖拽期间每帧都要深比较一次。

### ⑤ `query` 与 `NodeHelpers` 的分配开销

- `createQuery` 的包装是 `queryMethods(getState())[key](...args)`——**每调用一次 `store.query.xxx()`，都会重建整个 query 对象**（约 12 个方法）。
- `NodeHelpers(state, id)` 每次返回约 30 个闭包。
- `descendants(deep)` 内部对每个子节点再调用 `nodeHelpers(id).linkedNodes()` 和 `.childNodes()`，即**每个节点新建 2 个 NodeHelpers**。遍历 N 个节点 ≈ 60N 个闭包分配。

而 `mousedown` 的选中逻辑正好命中这里，文件 `packages/core/src/events/DefaultEventHandlers.ts`：

```ts
newSelectedElementIds = selectedElementIds.filter((selectedId) => {
  const descendants = query.node(selectedId).descendants(true);   // 全子树遍历
  const ancestors = query.node(selectedId).ancestors(true);
  if (descendants.includes(id) || ancestors.includes(id)) return false;
  return true;
});
```

如果当前选中的是根节点或大容器，这一步就是**一次全树遍历 + 数组 includes 线性查找**，纯粹发生在 mousedown 的同步路径上。

### ⑥ 次要但值得顺手修

- `packages/utils/src/useCollector.tsx`：`const dependencyKey = JSON.stringify(options?.dependencies || null)`——**每个组件每次 render 都做一次 JSON.stringify**。1000 个节点就是 1000 次。
- `mouseover` / `mouseleave` 没有任何节流，鼠标划过一片区域就是一串 dispatch。
- `useInternalEditor` 中每个 hook 实例都会 `handler.createConnectorsUsage()`，内部调用一次 `this.handlers()` 新建 6 个闭包。属于挂载期成本，不影响 mousedown，但影响首屏和大量节点挂载。

## 现有补丁做了什么

业务项目 `E:\code\deeplogic.designer` 已有 `patches/@craftjs__core@0.2.12.patch`。
它只有 16 行，改的是 `dist/cjs/index.js` 和 `dist/esm/index.js` 两个**压缩后的单行文件**（整行替换，净增 299 字节）。
通过字符级 diff 还原出**三处改动**：

### 改动 1 + 2：`setDOM` 批量化（挂载期优化）

`connect` 连接器原本每连接一个 DOM 就 dispatch 一次 `setDOM`：

```js
// 原始
connect: (el, id) => {
  store.actions.setDOM(id, el);
  return this.reflect(...);
}

// 补丁后：microtask 内攒批，合并成一次 dispatch
connect: (el, id) => {
  const q = store.__craftDomQ || (store.__craftDomQ = new Map());
  q.set(id, el);
  if (!store.__craftDomP) {
    store.__craftDomP = true;
    queueMicrotask(() => {
      store.__craftDomP = false;
      const batch = Array.from(q);
      q.clear();
      if (batch.length) store.actions.setDOM(batch);   // 传数组
    });
  }
  return this.reflect(...);
}
```

配套让 `setDOM` 接受数组（向后兼容原签名）：

```js
setDOM(e, n) {
  if (Array.isArray(e)) {
    e.forEach((p) => { state.nodes[p[0]] && (state.nodes[p[0]].dom = p[1]); });
    return;
  }
  state.nodes[e] && (state.nodes[e].dom = n);
}
```

**效果**：挂载 1000 个节点，从 1000 次 dispatch（每次一轮全量广播）压缩成 **1 次**。
这是本文原始分析**完全没有覆盖**的一条，价值很高，必须保留。

> 隐含风险（源码化时要保留注释）：`setDOM` 被推迟到 microtask，
> 意味着 `connect()` 返回后的同一个同步块内 `node.dom` 还是空的。
> 依赖 `node.dom` 的代码（`Positioner.getDOMInfo`、`RenderEditorIndicator`）都在事件回调里，跨了 microtask，因此安全。

### 改动 3：`onNodesChange` 去掉全量序列化 —— 正是本文卡点①

```js
// 原始：无条件订阅 + 每次 dispatch 全量 serialize
o.subscribe(
  () => ({ json: o.query.serialize() }),
  () => { o.query.getOptions().onNodesChange(o.query); }
);

// 补丁后：只在业务传了 onNodesChange 时订阅，collector 换成自增计数器
void 0 !== props.onNodesChange &&
  o.subscribe(
    (() => { let c = 0; return () => ({ i: ++c }); })(),
    () => { o.query.getOptions().onNodesChange(o.query); }
  );
```

两个改法：

1. **未传 `onNodesChange` 就不订阅**——等于本文 P0-1 的第 ① 点。
2. **collector 不再 serialize**，改成自增计数器（恒不相等 → 必然触发 onChange）。
   序列化的成本被移出 craft 内部。

配套的业务侧实现（`packages/web/src/pages/editor/components/designer/designer-view.jsx:240`）：

```js
const onNodesChange = useCallback(
  debounce((query) => {
    ...
    const json = query.serialize();     // ← serialize 在 debounce 之后才做
    const baseline = getDesignerBaseline();
    ...
  }),
  []
);
```

即**「每次 dispatch 同步序列化」→「debounce 之后序列化一次」**。这是一次正确且完整的迁移，
等价于本文 P0-1 的 ① + ③ + ④。

**唯一的语义变化**：原实现靠 `serialize()` 结果比对，只在节点**真的变了**时才回调；
现在任何 dispatch（含 hover / select / setIndicator）都会进入 debounce 队列。

> ⚠️ **更正（2026-09-22）：「因为业务侧有 debounce 兜底，实际影响可控」是错的，这是一个回归。**
>
> LoAF 实测：在监控画布上 hover，每帧都有一次 `timerExpired` 约 **45ms** ——
> 就是业务侧 debounce 到期后白跑的那次全量序列化。hover 只改 `node.events`，
> 而 `serialize()` 只读 `node.data`，**序列化结果不可能变化**，这 45ms 是纯浪费。
> 序列化的开销并没有被消除，只是从同步挪到了 300ms 之后。
>
> 正确做法不是本文建议的 `dependencies: [['nodes']]`（`node.events` 也在 `['nodes']` 下，过滤不掉 hover），
> 而是让 collector **按引用比较节点集合、每个 `node.data` 和 `options.resolver`**，
> 恢复原版「只有序列化结果可能变化时才回调」的语义，同时不做序列化。
> 修复后 hover 与点击后的 `timerExpired` 都消失，真实修改照常回调。详见 `perf-handoff.md` §5.10。

### 与本文优化方案的冲突判定

| 补丁改动 | 与本文方案的关系 | 处理方式 |
| --- | --- | --- |
| 改动 1+2 `setDOM` 批量化 | **本文完全没覆盖，纯增量** | **原样搬到源码**，新增为 C 组的 P0-3 |
| 改动 3 `onNodesChange` | **同一处代码，补丁已实现 P0-1 的 ①③④** | 源码实现**以补丁版本为基础**，可选再加 ②（dependencies） |
| 本文 P0-2（`onRender` 全局订阅） | 补丁未触及 | 照常实施 |
| 本文 P1 / P2 全部 | 补丁未触及 | 照常实施 |
| 本文 P2-2（改 `DefaultEventHandlers.select`） | 与改动 1 同文件不同函数 | 不冲突 |

**结论：没有冲突。** 补丁是本文方案的一个真子集 + 一条本文遗漏的增量优化。
把三处改动搬回 craft.js 源码后，构建产物天然包含它们，新补丁不会抹掉任何东西。

## 实测挖出的 upstream 缺陷：订阅首次 notify 的假变化

这是整个排查里收益最大的一条，**不是猜出来的，是埋点指出来的**。

### 现象

在真实项目里点一下，`report()` 显示 955 个结果变化中有 **880 个（92%）集中在 5 个 collector，每个恰好 176 次**：

```text
(state2) => getRootEditorSnapshot(state2, fallbackProjIdRef.current)   176
(state)  => getPointsDataSnapshot(state)                               176
(editorState) => { const rootCustom = editorState...ROOT_NODE].data }  176
...另外两个物料级 useEditor                                             176 × 2
```

可疑之处：前两个读的是 ROOT 的 props / points，而触发的 action 是 `setNodeEvent`，
**根本不碰这些字段**；而且两者都有模块级快照缓存，输入不变时返回同一引用。它们不该变化。

### 根因

`packages/utils/src/useCollector.tsx`：

```ts
// ① 首次 render 已经收集过一次，用作 useState 的初始值
if (initial.current && collector) {
  collected.current = collector(getState(), query);
}

// ② 但订阅时没把这个值交给 Subscriber，collectOnCreate 传的是 false
subscribe(collector, onChange, false, { ... });
```

于是 `Subscriber.collected` 的初始值是 `undefined`。
第一次 notify 时 `isEqualWith(recollect, undefined)` **永远不相等**，
于是必然调用 onChange、必然 setState —— **哪怕收集到的值和初始渲染时完全一致**。

**每个订阅在挂载后都白白浪费一次 React 重渲染。**
176 个组件实例 × 5 类订阅 = 880 次。

### 修复

新增 `SubscribeOptions.initialCollected`，把 `useCollector` 已经收集的值作为 Subscriber 的比较基准：

```ts
subscribe(collector, onChange, false, {
  ...options,
  initialCollected: collected.current,
});
```

配套把 `onChange` 里的新值写回 `collected.current`，
这样因 `dependencies` 变化而重新订阅时，基准取的是最新值而不是首次渲染的陈旧值。

### 效果

| | 修复前 | 修复后 | 变化 |
| --- | --- | --- | --- |
| 一次点击的结果变化数 | 959 | 67 | **−93%** |
| collect 耗时 | 84.1ms | 32.7ms | **−61%** |
| 最大单项 | 176 × 5 | 17 | — |

> 这条同样适用于 upstream craft.js，与本项目的业务代码无关，值得回馈社区。

### 剩下的 67 个变化

```text
function(t){return o&&t.nodes[o]&&e(t.nodes[o])}     17   useNode 包装，节点级变化，合理
useStableEditorSelector 系列（多个调用点合计）          40   ← 业务侧，见下
function(){return e(i.getState())}                    9   Editor 计数器，onChange 不是 setState，不引发重渲染
其他业务 selector                                      1×N
```

`useStableEditorSelector` 的 40 次几乎是「每次 dispatch 必失败」，两类写法导致：

1. **selector 返回 `query.node(id)`**（`NodeHelpers` 对象，每次新建约 30 个闭包）
   → 浅比较该 key 必然不等。应改为 `query.node(id).get()`（Immer 管理的稳定引用）或只取需要的字段。
2. **selector 返回嵌套新对象**（如 `{ selectedLite: { id, data: {...} } }`）
   → `shallowEqual` 只比一层，顶层 key 每次都是新引用。应把字段摊平到顶层。

## 瓶颈重定位：订阅优化到顶之后

把订阅层面能做的都做完之后，端到端**几乎没动**。这个结果本身就是结论。

### 三轮实测对比（同一交互，mousedown）

| | 基线（全量广播） | 修 initialCollected 前 | 修 initialCollected 后 |
| --- | --- | --- | --- |
| 结果变化数 | ~950 | 959 | **67** |
| collect 耗时 | 52.6ms | 84.1ms | **32.7ms** |
| **到下一帧** | **727.1ms** | **583.4ms** | **583.8ms** |

变化数砍掉 93%、collect 砍掉 61%，**端到端 583.4 → 583.8，纹丝不动**。

**结论：订阅系统 + React 重渲染加起来，只占那 583ms 的不到 10%。**
本文前面把优先级压在订阅上，方向只对了一半 —— 省下的都是真的，但天花板远低于预期。

### 被证伪的假设

**「强制同步布局（layout thrashing）」在 mousedown 路径上不成立。** 在 mousedown 期间实测：

```text
offsetWidth: 31, offsetHeight: 38, getBoundingClientRect: 44, getComputedStyle: 108
```

合计 221 次，这个量级完全正常。`getElementRotatedRect` 的三连读取只在**拖动**时密集触发，mousedown 用不上。

> 量化脚本见「验证机制」一节的 layout-reads 探针。
>
> ⚠️ **补充限定（2026-09-22）**：这条只对 **mousedown** 成立。**hover 普通组件**时确实存在强制同步布局：
> `hover.jsx:138` 的 layout effect 调 `getViewportRect` → `getBoundingClientRect`，
> 实测 `Recalculate style` 49ms、Elements affected 3217。
> 但**监控画布里的设备不挂 Hover 组件**（没有标签和边框），所以它不在本项目关注的交互路径上，已暂缓。
> 另外要注意：强制回流本身不会凭空增加工作量，它只是把这一帧反正要做的样式计算提前到 JS 里同步执行 ——
> 把读取挪到 rAF 并不会带来端到端收益。详见 `perf-handoff.md` §5.9。

### ~~Performance Summary 的真实分布~~（⚠️ 量纲错误，已作废）

```text
Rendering  1,212 ms  (34.5%)
Scripting  1,202 ms  (34.2%)
System       677 ms  (19.3%)
Painting     180 ms   (5.1%)
```

~~**没有单一瓶颈**，JS 和渲染各占三分之一。~~

> ⚠️ **更正**：这是**选定区间内含多次交互的累计值**，不是单次交互的分布，据此得出的
> 「渲染占三分之一」直接误导了后面两轮（will-change、关闭动画）优化，收益全为 0。
>
> 正确口径是在时间轴上**拖选出单次 mousedown 区间**（确认 `Range` 约 530ms）再看 Summary：
> Scripting **483ms（91%）**、System 36ms（7%）、Rendering **11ms（2%）**。
>
> **瓶颈 100% 在 JS，合成层 / Layerize / Paint 全部无关。** 详见 `perf-handoff.md` §四、§5.1。
> 「订阅优化只能动 Scripting 里的一小块，收益见顶是必然的」这个结论仍然成立，但理由不是分布均匀，
> 而是 collect 只占 2%。

### 已证伪的怀疑二：常驻 will-change 造成的合成层爆炸

`packages/web.materials/components/monitor/nodes/nodesBox.tsx` 有三处：

```js
willChange: enabled && !shouldUse2dPipeLineTransform ? 'transform' : '',   // target
willChange: enabled ? 'transform' : '',                                     // 外层壳（设备分支）
willChange: enabled ? 'transform' : undefined                               // 外层壳（弯管分支）
```

NodesBox 是**每个节点一个实例**，后两处互斥，所以编辑态下每个节点常驻 1~2 个 `will-change: transform`。
数千节点 = 数千个常驻合成层，层树维护、样式重算和 GPU 内存都要持续付费。
MDN 对 `will-change` 的建议是「即将变化时临时加、变化完就撤」，常驻在大量元素上是反模式。

这与 `Rendering 1212ms + System 677ms` 的分布吻合，于是加开关做了 A/B。

**实测结果：证伪。**

| | 关闭前 | 关闭后 |
| --- | --- | --- |
| will-change 元素数 | 1610 | 1382（少 228） |
| mousedown 到下一帧 | 583.8ms | **589.8ms** |
| mouseup 到下一帧 | 419.4ms | **401.3ms** |

改动确实生效（少了 228 个合成层），但端到端在噪声范围内没有变化。

> ⚠️ **本实验设计有缺陷**：只砍掉了 14%（1610 → 1382），主力在 `transform.ts` 的 `resolveMonitorTransform`（无条件写入）。
> 后续把全部常驻 `will-change` 移除（→ **17** 个）之后，层数 1805 → 1822（**反而略增**），端到端**仍然零收益**，
> 这才是有效的证伪。结论相同，但依据要用后者。见 `perf-handoff.md` §六-7。
已把开关改回 `true` 恢复原行为 —— 既然没收益，就不该白白牺牲拖动时的合成层提升。
开关和结论留在代码里，省得以后再试一遍。

> 页面规模参考：DOM 总数约 12759，craft 节点约 5000+。

### 真凶：每根管道一个常驻 rAF 循环

三个独立数据互相印证，这次没有猜测成分。

**① rAF 计数（空闲态）**

```text
1 秒内 rAF 注册次数: 5820 ≈ 每帧 97 个
```

**② 空闲对照录制**（完全不操作页面，4.55s）

| Bottom-up | Self | Total |
| --- | --- | --- |
| Profiling overhead | 569.8ms | 762.0ms |
| **Commit** | **379.9ms** | 379.9ms |
| **Paint** | **247.2ms** | 247.7ms |
| **`loop` PipeLine.tsx:478** | **192.7ms** | 309.6ms |
| Layerize | 153.3ms | 153.3ms |
| `Animation frame fired` | 95.1ms | **1,065.6ms (55.8%)** |
| `Function call` PipeLine.tsx:478 | 93.2ms | **936.0ms (49.0%)** |

**页面什么都没干，49% 的时间在跑管道的 rAF，还带出持续的 Commit + Paint。**

> ⚠️ **范围限定**：这是**空闲态**的开销，用户已明确把「管道流动动画的空闲重绘」排除在优化范围之外。
> rAF 收敛（N 个循环 → 1 个）作为空闲优化保留，但它**不改善交互延迟**。
> 另有实测佐证动画与交互无关：把 `document.getAnimations()` 全部 pause、SVG 动画也 pause 之后，
> 每帧的样式重算成本从 0.0ms 到 0.0ms，**没有变化**（见 `perf-handoff.md` §5.9）。

**③ Profiling overhead 的归属**

交互录制里那 586ms 的 `Profiling overhead` 全部挂在
`Function call PipeLine.tsx:478 → Animation frame fired` 下面。
Profiling overhead 正比于函数调用次数，它不是均匀噪音，而是「这个回调被调用了天文数字次」的证据。
（注意：这部分开销只存在于录制期间，不能计入生产环境的真实成本。）

#### 代码根因

`packages/web.materials/components/monitor/devices/pipeline/PipeLine.tsx`

```js
const loop = () => {
  if (!refHub.monitorDragging) {
    startRects = null;
    if (wasActive) { setFollowPoints(null); wasActive = false; }
    raf = requestAnimationFrame(loop);   // ← 空闲分支也排下一帧
    return;
  }
  ...
  raf = requestAnimationFrame(loop);
};
raf = requestAnimationFrame(loop);
```

作者优化过空闲路径的**单次成本**（注释写着「空闲每帧只读一个布尔，分配为零」），
但没解决**数量**问题：每根绑定管道一个独立循环，永远在跑。

#### 修复

新增 `pipeline/pipeFollowScheduler.ts`，把 N 个循环收敛成 1 个：

```ts
const tick = () => {
  const dragging = !!refHub.monitorDragging;
  // 拖拽中逐帧跑；刚结束的那一帧再跑一次做归位；完全空闲时不触碰任何管道回调
  if (dragging || wasDragging) {
    tasks.forEach((task) => task());
  }
  wasDragging = dragging;
  rafId = requestAnimationFrame(tick);
};
```

`PipeLine` 只改驱动方式，跟随的业务逻辑一行未动：

```diff
- raf = requestAnimationFrame(loop);
- return () => cancelAnimationFrame(raf);
+ return registerPipeFollow(loop);
```

刻意**没有**去劫持 `refHub.monitorDragging` 做事件通知 ——
它在 `movableTool` 里有多处直接赋值，轮询一个布尔的成本远低于改动那些写入点的风险。

### ~~待处理：Layerize 与 1805 个合成层~~（⚠️ 已作废，量纲错误）

Layers 面板：**1805 层 / 47.2 MB**（正常页面数十层）。
~~`Layerize` 在交互录制里 1926ms（39.2%）。~~

> ⚠️ **更正**：那个 1926ms（以及后来看到的 `Layerize 539.8ms / 21.6%`）都是**多次点击的累计值**。
> 单次 mousedown 区间里 **Rendering 合计只有 11ms（2%）**，Layerize 不是卡点。
> 沿这个方向做的两轮优化（移除 will-change、注入 `animation: none`）**收益均为 0**，方向已废弃。
> 见 `perf-handoff.md` §六-7、§六-8、§六-9。

### 方法论教训

到这里，基于火焰图形状的两个假设都被实测推翻了：

| 假设 | 证伪方式 |
| --- | --- |
| 强制同步布局（layout thrashing） | 探针实测 mousedown 期间仅 221 次布局读取，量级正常（**仅限 mousedown**，hover 普通组件另有 49ms 强制重算） |
| 常驻 will-change 导致合成层爆炸 | 完整移除（1382→17）后层数反而 1805→1822，端到端零变化 |
| 管道流动 animation 是合成层种子 | 注入 `animation: none !important`，层数与耗时完全不变 |
| `Layerize 539.8ms` 是单项最大开销 | 累计值；单次区间 Rendering 仅 11ms |
| craft 订阅 / collect 是瓶颈 | 三轮优化把变化数砍 93%、collect 砍 61%，端到端 0 |
| 组件被卸载重挂（树重建） | 埋点实测 mount 0 / unmount 0 |

完整清单见 `perf-handoff.md` §六（共 10 条）。

**教训：Summary 饼图只能给出「哪一类活动占比高」，火焰图的形状容易诱导出错误的因果猜想。
要定位「具体是谁干的」，必须用 Bottom-up 按 Self time 排序，而不是继续猜。**

后续排查应当先取 Bottom-up 数据再动代码。

## 业务侧实测：deeplogic.designer-exp

对真实项目 `E:\code\deeplogic.designer-exp` 做了一轮检索，结论比预想的更关键：
**业务侧自己的订阅写法，才是节点数放大倍率最高的地方，而且这部分改动不需要打补丁。**

### 先排除的

- **没有使用 `@craftjs/layers`。** `packages/web` 的 `package.json` 里虽然声明了 `@craftjs/layers@0.2.7`，
  但全仓 0 处 import；图层面板已由自研虚拟滚动 `VirtualLayerTree.jsx` 取代
  （见 `packages/web/src/pages/editor/components/designer/layout/sidebar/DesignerLayer.jsx` 的注释）。
  **所以本文卡点③不适用，layers 包不需要改也不需要打补丁。**
- `VirtualLayerTree` 内部没有 per-row 的 `useEditor` 订阅，只有少量 `query.node(id).get()` 调用，成本可控。

### 需要注意的依赖事实

`@craftjs/utils` 在源码里被直接 import **49 次**（`@craftjs/core` 106 次），
但 `package.json` 里**没有声明** `@craftjs/utils` —— 它是通过 `@craftjs/layers` 传递进来的幽灵依赖。
后续如果要给 utils 打补丁，需要先把它提升为显式依赖。

### 放大器 A：`useComponent` 给每个物料实例挂了 2 个全局订阅（最严重）

文件：`packages/mobile-materials/src/components/useComponent.tsx`，被 **220 个物料组件文件**使用。

```ts
// 订阅 1：全局订阅
const { actions, query, enabled } = useEditor((state) => ({
  enabled: state.options.enabled,
}));

// 订阅 2：全局订阅 + 返回多个大对象引用
const { theme, global, points, functions, projId, rootCustom, ROOT_DOM } = useEditor((state) => {
  const rootNode = state.nodes[ROOT_NODE];
  const rootProps = rootNode?.data?.props;
  return {
    theme: rootProps?.theme ?? null,
    global: rootProps?.global ?? null,
    points: rootProps?.points ?? null,
    functions: rootProps?.functions ?? null,
    projId: rootProps?.projId ?? localStorage.getItem('PROJID') ?? sessionStorage.getItem('pid'),
    rootCustom: rootNode?.data?.custom,
    ROOT_DOM: rootNode?.dom,
  };
});
```

三重问题：

1. **两个都是全局订阅**（未声明 `dependencies`）。画布上 N 个物料实例 = **2N 个全局 collector**，
   叠加 core 自身 `RenderNodeToElement` 的 N 个，合计 **3N**，每次 dispatch 全跑。
2. **订阅 2 返回的 `theme` / `global` / `points` / `functions` / `rootCustom` 都是对象引用**，
   会被 `Subscriber.collect` 里的 lodash 深比较逐个深比。在低代码项目里
   `functions`（全局函数定义）和 `points`（点位表）通常很大 —— **N 次大对象深比较**。
3. **collector 里同步读 `localStorage` / `sessionStorage`**。每次 dispatch × N 个实例 = N 次同步 IO，
   而且这个值根本不属于编辑器 state，不该出现在 collector 里。

按一次点击 3~4 次 dispatch 算，1000 节点时这里是 **6000~8000 次 collector + 3000~4000 次大对象深比较 + 3000~4000 次 localStorage 读**。
~~**这个量级可能超过卡点①的 serialize。**~~

> ⚠️ **更正（实测）**：已按 B-1 / B-2 改造（两个全局订阅合并为一个 `getComponentEditorSnapshot`），
> 订阅数 9605 → 6857、collect 耗时 −29%，**端到端收益为 0**。
> collect 只占单次 mousedown 的约 2%，所以「量级超过 serialize」这个推断不成立。改动无害，已保留。

### 放大器 B：图层面板订阅整个 `state.nodes`，且 mousedown 必然命中

文件：`packages/web/src/pages/editor/components/designer/layout/sidebar/sidebar.jsx`

```js
const layerNodesSource = useStableEditorSelector((state) => state.nodes);
```

`useStableEditorSelector`（`designer/hooks/useStableSelector.ts`）在 collector 内做浅比较，
相等时返回上一次引用，让外层 `isEqualWith` 走 `===` 快速路径。思路是对的，但：

- 浅比较本身是 **O(N)**：1000 个 key 每次 dispatch 比一遍。
- **`setNodeEvent('selected', ...)` 会改写 `state.nodes[id].events.selected`，该节点引用变化 → 浅比较必然失败。**
  也就是说**每一次点击选中都会走进最坏路径**：一次整树 lodash 深比较 → `setRenderCollected({...state.nodes, actions, query})`
  **把 1000 个 node 键展开成一个新对象** → setState → 图层面板整体重渲染。

~~这条是 mousedown 卡顿的又一个 500ms 级嫌疑犯~~，且**完全在业务侧，不需要改 craft**。

> ✅ **已确认并修复（2026-09-22），但量级判断要更正**：它不是「500ms 级」。
> ctx-watch 实测每次 dispatch（**包括 hover**）都会把整个 Sidebar 重渲染一遍。
> 改法是按 tab 门控这个订阅（非图层 tab 返回 `null`），实测收益：
> **hover 不再重渲染 Sidebar；单次点击帧 246ms → 216ms（约 −30ms）；mousedown 回调没变。**
> 见 `perf-handoff.md` §5.7。

### 放大器 C：`useStableEditor` 制造了无意义的全局订阅

文件：`packages/web/src/pages/editor/components/designer/hooks/useStableEditor.ts`

```ts
const { actions, query, connectors } = useEditor((state, query) => {
  return {};        // ← 只是为了拿 actions/query/connectors，却传了 collector
});
```

`useCollector` 只在 **collector 为 undefined 时才完全不订阅**。这里传了一个返回 `{}` 的函数，
于是每个使用 `useStableEditor` 的组件都注册了一个全局订阅，每次 dispatch 执行一次空 collector + 一次 `isEqualWith({}, {})`。

**改成无参数的 `useEditor()` 即可零成本消除**——`actions` / `query` / `connectors` 本来就是 `useMemo` 稳定引用，
外面那层 `stableEditor` getter 包装也可以一并去掉。

### 放大器 D：`LocatorGuideHints` 无保护地订阅整棵树

文件：`packages/web/src/pages/editor/components/designer/inspection/LocatorGuideHints.tsx`

```ts
const { nodes } = useEditor((state) => ({ nodes: state.nodes }));
```

没有 `useStableEditorSelector` 保护，**每次 dispatch 都对整棵 `state.nodes` 做 lodash 深比较**。
好在它是条件渲染（挂在 `ComponentLocator` 的结果项里），只在检查面板打开时才命中 —— 但一旦打开就是持续成本。

### 业务侧结论

```text
每次 dispatch 的实际负担（1000 节点，图层面板打开）：

  craft 内部   1 次全量 serialize          ← 卡点①
             + 1000 个 onRender 全局订阅   ← 卡点②
  业务侧       2000 个 useComponent 全局 collector
             + 1000 次 root props 大对象深比较
             + 1000 次 localStorage 同步读
             + 1 次整树浅比较（点击时退化为深比较 + 1000 键对象展开）

  × 一次点击 3~4 次 dispatch
```

## 优化方向（按执行顺序）

分成两组：**B 组在业务仓库改，不需要打补丁，可以立刻验证**；**C 组在 craft.js 改，需要走构建 + patch 流程**。
建议**先做 B 组**——成本低、风险小、见效快，还能顺便把埋点验证链路跑通。

### B 组：业务仓库 `deeplogic.designer-exp`（无需补丁）

| 优先级 | 改动 | 涉及文件 | 预期收益 |
| --- | --- | --- | --- |
| **B-1** | `useComponent` 的订阅 2 拆解：① `projId` 移出 collector（localStorage 读放到模块级或 `useMemo`）；② `theme`/`global`/`points`/`functions`/`rootCustom` 不再逐个返回，改为返回 **`rootProps` 单一引用**并在组件内解构，让比较退化为一次 `===`；③ 声明 `dependencies: [['nodes', ROOT_NODE]]` | `packages/mobile-materials/src/components/useComponent.tsx` | **最大收益**：干掉 N 次大对象深比较 + N 次 localStorage 读 |
| **B-2** | `useComponent` 的订阅 1 声明 `dependencies: [['options','enabled']]`；与订阅 2 合并成一个 hook 调用 | 同上 | 全局订阅 2N → 0 |
| **B-3** | `useStableEditor` 改用无参数 `useEditor()`，去掉 `() => ({})` | `designer/hooks/useStableEditor.ts` | 零成本消除一批全局订阅 |
| **B-4** | 图层面板不再订阅整个 `state.nodes`：改为订阅「结构版本号」（节点增删改名/移动时才变）或按需的扁平 id 列表，避免 `setNodeEvent` 触发整树比较与 1000 键对象展开 | `designer/layout/sidebar/sidebar.jsx`、`useStableSelector.ts` | 点击时不再走最坏路径 |
| **B-5** | `LocatorGuideHints` 的 `state.nodes` 订阅加 `useStableEditorSelector` 保护，或改为只订阅 `targetId` 相关子树 | `designer/inspection/LocatorGuideHints.tsx` | 检查面板打开时不再整树深比较 |
| **B-6** | `@craftjs/utils` 提升为 `packages/web/package.json` 的显式依赖（当前是幽灵依赖） | `packages/web/package.json` | 为后续 utils 补丁铺路 |

> ⚠️ **B 组「预期收益」的实测结果（2026-09-22）**：
> - **B-1 / B-2（`useComponent` 订阅合并）**：订阅 9605 → 6857、collect −29%，**端到端 0**
> - **B-4（图层面板不再订阅整个 `state.nodes`）**：✅ 有效但不是主力 —— hover 不再重渲染 Sidebar，点击帧 246 → 216ms
> - B-3 / B-5 / B-6：未做，按现有证据收益很小
> - **真正见效的三刀本文一条都没预测到**：业务侧 `onDragStart`/`onDrag` 漏写 `useCallback`（mousedown −35%）、
>   画布外层 antd `ConfigProvider` 的内联 `getPopupContainer`（mousedown 回调 163 → 61ms）、以及上面 B-4。
>   见 `perf-handoff.md` §5.4、§5.7、§5.8
>
> B-1 / B-2 里的 `dependencies` 参数依赖 craft 侧已落地的 patch path 订阅能力。
> 如果当前线上补丁还没包含该能力，B 组可以先只做 ①②③ 中不涉及 `dependencies` 的部分
> （拆 localStorage、合并返回引用、`useEditor()` 无参、图层面板版本号），这部分**纯业务改动，零依赖**。

### C 组：craft.js 仓库（需要构建 + patch）

| 优先级 | 改动 | 涉及文件 | 预期收益 |
| --- | --- | --- | --- |
| ~~P0-0~~ ✅ | **已完成**：现有补丁的三处改动已搬回源码 —— `DefaultEventHandlers` 用实例级队列 + `queueMicrotask` 攒批（放实例字段而非 `handlers()` 闭包，否则每个 hook 一个队列、批量失效）；`actions.setDOM` 接受 `[id, dom][]` 批量；`Editor.tsx` 条件订阅 + 按引用比较 collector（并补上原本缺失的 unsubscribe） | `events/DefaultEventHandlers.ts`、`editor/actions.ts`、`editor/Editor.tsx` | 保住已有收益，是后续一切改动的基线 |
| P0-1 ✅ | `onNodesChange` 订阅重构。~~仅剩可选的 ②（声明 `dependencies: [['nodes']]`），收益小~~ —— **这个判断是错的**：计数器 collector 是回归，每次 hover 白跑一次全量序列化（约 45ms），而 `['nodes']` 也过滤不掉 hover（`node.events` 就在这条路径下）。**2026-09-22 已改为按引用比较**节点集合 / `node.data` / `options.resolver` | `packages/core/src/editor/Editor.tsx` | **实测：hover 与点击后的 45ms `timerExpired` 消失，真实修改照常回调** |
| ~~P0-2~~ ✅ | **已完成**：`onRender` 订阅声明 `dependencies: [['options','onRender']]`，常量提到模块作用域避免每次 render 重建订阅 | `packages/core/src/render/RenderNode.tsx` | 干掉 N 个全局订阅 |
| — | **重测基线，对比数字**（此时应已解决约 80%） | — | — |
| **P1-1** | 比较策略：`Subscriber.collect` 默认改**浅比较**（collector 返回的都是扁平对象），需要深比较再显式开启；至少给 DOM 元素加 customizer 直接走 `===` | `packages/utils/src/useMethods.ts` | 每次广播省一大笔 |
| **P1-2** | `indicator` 只存 id：`placement.parent` → `parentId`、`currentNode` → `currentNodeId`，渲染时再查 | `packages/core/src/events/Positioner.ts`、`RenderEditorIndicator.tsx`、`interfaces` | 拖拽每帧省一次深比较 |
| **P1-3** | layers 四处 `useEditor` 全部声明 dependencies（`['nodes', id]` / `['events','selected']`）；`LayerNode` 不再整体返回 `data`，只取实际用到的字段 | `packages/layers/src/layers/**` | 干掉 4N 个全局订阅 + N 次深比较 |
| **P2-1** | `query` 对象缓存：`createQuery` 按 state 引用 memo 一次，而非每次调用重建；`NodeHelpers` 按 `(state, id)` 缓存 | `packages/utils/src/useMethods.ts`、`packages/core/src/editor/NodeHelpers.ts` | 树遍历快 2~5 倍 |
| **P2-2** | mousedown 的祖先/后代判断改为沿 `data.parent` 向上走，**O(depth) 替代 O(N)** | `packages/core/src/events/DefaultEventHandlers.ts` | 选中大容器时不再全树遍历 |
| **P2-3** | `hovered` 事件用 rAF 合并节流；`useCollector` 的 `dependencyKey` 不用 JSON.stringify（用稳定引用或手写拼接） | `DefaultEventHandlers.ts`、`useCollector.tsx` | 鼠标划过不掉帧 |
| **P3** | 公共 API 收尾：`useEditor` 的 `dependencies` 补文档，并导出预置 hook（如 `useSelectedNodes()`、`useNodeProps(id)`），让业务侧不必手写依赖路径 | `packages/core/src/hooks/**` + site 文档 | 长期可维护性 |

> ⚠️ **P1 / P2 全部未做，且不建议再按这个优先级推进**：它们都是「让每次广播更便宜」，
> 而 collect 只占单次 mousedown 的约 2%（三轮实测端到端收益为 0，见文首更正）。
> 唯一额外落地的 craft 侧改动是 `useEditor` 的 `actions` 引用稳定化（本文未覆盖，见 `perf-handoff.md` §5.5）。
> 下一个有数据支撑的 craft 侧目标是：hover 时每次 mouseover 触发一次 `setNodeEvent`，
> 单次约 7–9ms、一帧 3–5 次，候选改法是「同一帧内合并 hover 派发」或「减少全局订阅者」（见 `perf-handoff.md` §9.1）。

### 明确不做的方案

- **Proxy 自动追踪读取路径**（`subscription-optimization.md` 方案 C）：解决不了上面任何一条卡点，反而增加每次 collector 的代理开销。
- **换成 `useSyncExternalStore`**：它解决并发渲染一致性，不是字段级通知机制，对本文列出的成本零收益。
- **加大 `isEqualWith` 的比较深度 / 换 diff 库**：方向相反，应该是减少比较而不是优化比较。

## ~~执行顺序总览~~（已按实测调整，见本节末）

```text
第 0 步  在 craft.js 仓库加埋点 + examples/basic 大节点基准页，拿到基线数字
第 1 步  B 组（业务仓库 deeplogic.designer，零补丁）
         -> 直接在项目里验证，这一步就能看到明显改善
第 2 步  C 组 P0-0：把现有补丁的三处改动搬回 craft.js 源码（先保住已有收益）
第 3 步  C 组 P0-2（RenderNode onRender）
         先在 examples/basic 验证，再用 yalc 链到业务项目联调
第 4 步  重测对比，决定是否继续 C 组 P1/P2
第 5 步  稳定后固化成 pnpm patch（@craftjs/core 必打，@craftjs/utils 视 P1/P2 范围而定）
```

> ⚠️ **第 0～3 步都已执行完，但第 1、3 步的端到端收益是 0**（订阅层方向已证伪三次）。
> 实际走通的路线是：**先用 LoAF / ctx-watch 定位「谁在换引用、谁在重渲染」，再改那一处**。
> 当前的待办与优先级一律以 [`perf-handoff.md`](./perf-handoff.md) §九 为准，本节不再维护。

`@craftjs/layers` 全程不涉及。

> 卡点①（全量 serialize）在该业务项目上已由现有补丁解决，所以**第 1 步 B 组现在是收益最大的一步**。

## 验证机制

优化前必须先能量化，否则每一步都是凭感觉。

### 1. 运行时测量（已移除）

本节记录的 dispatch、collect、结果变化和到下一帧数据来自本轮排查期间的临时测量。测量模块、全局对象和 A/B 开关已在提交前删除，不再进入发布包；这些数字只保留作历史证据。后续若重开性能优化，应重新建立临时测量，并在验证后删除。

### 1b. 打补丁到业务项目

> ℹ️ 本节流程仍然可用，但**已被 `perf-handoff.md` §八取代**（那里补了「先用当前已打 patch 的 node_modules
> 覆盖编辑目录」这一步，以及打包前的一致性校验方法，避免丢掉早期改动）。

craft.js 仓库构建后，把产物覆盖进 pnpm 的 patch 编辑目录即可。
**实测确认：`pnpm patch` 对已打补丁的包，编辑目录里是「已应用旧补丁」的内容**，
所以旧改动不会凭空消失；本仓库已把旧补丁的三处改动搬进源码，新产物天然包含它们。

```powershell
# craft.js 仓库：先构建两个包（utils 在前，core 依赖它）
cd packages/utils; npx cross-env NODE_ENV=production npx rollup -c rollup.config.js; npx tsc --skipLibCheck --emitDeclarationOnly
cd ../core;        npx cross-env NODE_ENV=production npx rollup -c rollup.config.js; npx tsc --skipLibCheck --emitDeclarationOnly

# 业务项目：逐个包走 patch 流程
pnpm patch @craftjs/core@0.2.12 --edit-dir C:\Temp\craftpatch\core
#   复制 <craft>/packages/core/dist/{cjs,esm}/index.js 和 lib/ 过去（.map 不要复制）
pnpm patch-commit "C:\Temp\craftpatch\core"

pnpm patch @craftjs/utils@0.2.5 --edit-dir C:\Temp\craftpatch\utils
#   同上
pnpm patch-commit "C:\Temp\craftpatch\utils"

pnpm install
```

**补丁瘦身**：`patch-commit` 默认会把 `.js.map` 和 `lib/tsconfig.tsbuildinfo` 一起算进 diff，
能让补丁从 ~900KB 涨到没法看。这两类都是纯噪音（旧补丁当初也只改 `.js` 不改 `.map`），
提交后按 `diff --git` 切段剔除即可：

```js
const parts = fs.readFileSync(p, 'utf8').split(/(?=^diff --git )/m);
const kept = parts.filter((s) => s.trim() && !/^diff --git a\/\S+(\.map|tsbuildinfo)/m.test(s));
fs.writeFileSync(p, kept.join(''));
```

瘦身后：core 164KB、utils 104KB。

> `@craftjs/utils` 在业务项目里是幽灵依赖（各包都没显式声明），
> 但 `patchedDependencies` 定义在根 `package.json`、对整个 workspace 的解析生效，
> **打补丁不需要先补依赖声明**。治理幽灵依赖是另一件事，不要和性能改动混在一起做。

### 2. 压力基准

在 `examples/basic` 增加节点生成入口（如 `?nodes=1000|3000|5000`），配合 `performance.mark` 输出：

- `mousedown` 到下一帧 paint 的耗时
- 拖拽全程的 long task 数量与最长 task
- 优化前后用 Chrome DevTools Performance trace 对比

### 3. 单元测试

已落地（`yarn jest`，注意 Windows 下根 `jest.config` 的 testMatch 匹配不到，需要
`npx jest --testMatch "**/tests/**/*.test.ts?(x)"`）：

- `editor/tests/Editor.test.tsx`（新增，2026-09-22 扩充到 13 例，全量 **156 passed / 156**）
  - 传了 `onNodesChange` 时，dispatch **不调用** `query.serialize()`
  - 订阅后的首次变化必定回调，且回调里拿到可用的 query
  - 未传 `onNodesChange` 时完全不订阅，dispatch 不抛错
  - **不**回调：hover、选中、`setDOM`、不改 resolver 的 `setOptions`
  - **会**回调：`setProp`、`setHidden`、增删节点、撤销重做、更换 resolver
- `editor/tests/actions.test.ts`（新增两例）：`setDOM` 接受 `[id, dom][]` 批量；批量里的未知 id 被忽略而不抛错
- `render/tests/RenderNode.test.tsx`（新增一例）：`onRender` 订阅带 `dependencies: [['options','onRender']]`

> 既有失败 `experimental/slate/.../splitSlate.test.ts` 与本次改动无关：
> `experimental/*` 不在 workspaces 里，`shortid` 依赖未安装。

仍待补充：



- 两个节点各自订阅，修改 A 的 props 后，**B 的 collector 执行 0 次**
- 声明 `['events','selected']` 的订阅，在 `setProp` 时执行 0 次
- 未提供 `onNodesChange` 时，dispatch **不调用** `query.serialize()`（spy 断言）
- 保留原有：重复选中 / 相同集合不同顺序 / 重复清空 hovered 均不产生第二次通知

### 4. 手动回归清单

重复点击、多选（含取消多选）、鼠标快速划过、同容器拖拽排序、跨容器拖入、撤销/重做、设置面板改 props、隐藏节点、页面刷新恢复。

重点确认**按 patch path 过滤后不漏更新**，两个高风险点：

- `selected` 的 Editor 级 Set 与 Node 级布尔镜像双写，patch key 必须同时覆盖被清除和被设置的节点
- `move` / `delete` 会同时影响节点自身路径与父节点 `data.nodes`，两条路径都要失效

### 5. 本地命令

```powershell
yarn test --runInBand
yarn build
yarn lint

# 大节点 Demo（端口 3002，cypress.json 的 baseUrl 已指向它）
yarn workspace example-basic start
yarn cy:test
```
