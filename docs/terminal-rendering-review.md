# 终端分屏渲染代码审查报告

> 审查范围：`TerminalPanel.tsx`、`useSessionManager.ts`、`terminal-global.css`、`docs/terminal-rendering.md`
> 重点：分屏布局、容器尺寸变更重绘、终端焦点管理

---

## 严重问题

### 1. 每次 PTY 标题变更窃取焦点（CONFIRMED）

**文件：** `TerminalPanel.tsx:270`

`useLayoutEffect` 依赖 `sessions` 数组。`onPtyTitle` 事件（useSessionManager.ts:80）中调用 `setSessions(prev => prev.map(...))` 生成新数组引用 → 触发 `useLayoutEffect` 重新执行 → **Step 5 无条件 focus `visibleIds[0]`**（第 244-245 行）。

**失败场景：**
用户在侧栏搜索框输入关键字。Shell 命令执行完毕，PTY 标题更新（`[2] workspace$`）→ `onPtyTitle` → `setSessions` → layout effect 重跑 → `first.term.focus()` 将输入焦点从搜索框劫持到终端。用户的后续按键输入到终端而非搜索框。

### 2. `onPtyOutput`/`onPtyExit` 注册失败导致 cleanup `<undefined>()` 崩溃（CONFIRMED）

**文件：** `TerminalPanel.tsx:105,112,115-116`

```ts
const unlistenOut = onPtyOutput(...).catch(() => {});
// ↑ 注册失败时 .catch(() => {}) 返回 undefined

return () => {
  unlistenOut.then((fn) => fn());
  // ↑ fn = undefined → undefined() 抛出 TypeError → 未处理的 Promise 拒绝
};
```

`api.ts:187` 确认 `onPtyOutput` 返回 `Promise<() => void>`。`.catch(() => {})` 在拒绝时将 Promise 解析为 `undefined`，cleanup 调用 `undefined()` 崩溃。

**失败场景：**
开发中热重载 → 卸载 → cleanup 执行 → `fn()` 抛出 TypeError（未处理 Promise 拒绝）→ 重新挂载 → 注册新监听器但原监听器仍存在 → 每次 PTY 事件触发两次 handler。

### 3. `useSessionManager` 全部 4 个事件 cleanup 缺少错误处理（CONFIRMED）

**文件：** `useSessionManager.ts:110-112,130-132,167-169,191-193`

所有 4 个 `useEffect` 的 cleanup 均为：
```ts
return () => { unlisten.then((fn) => fn()); };
```

没有 `.catch()`。`onPtyTitle`/`onPtyExit`/`onPtyOutput`/`listen("session-deeplink")` 任一失败 → `unlisten` 为 rejected Promise → cleanup 的 `.then` 被跳过 → 原始监听器未注销 → 重新挂载时双重注册。

### 4. `setState` 嵌套在 `setGroups` updater 内部（CONFIRMED）

**文件：** `useSessionManager.ts:290,339,342,346,388,407,411,414`

`setActiveGroupId()` / `setSelectedSessionId()` 在 `setGroups(prev => { ... })` 的回调内部调用。React 明确规定 updater 函数必须是纯函数。该模式违反 React 契约，在并发模式下 (React 19) 可能导致：
- updater 被调用两次（Strict Mode dev），外部 setState 被执行两次
- 渲染中断后观察到不一致的中间状态

**失败场景：**
`deleteGroup("g1")` 时在 `setGroups` updater 内调用 `setActiveGroupId(updated[0].id)`。Strict Mode 下 updater 被调用两次，第一次调用 `setActiveGroupId` 已生效，第二次再次调用时 updated[0] 可能已不在最新状态中。

### 5. `moveSessionToGroup` 不更新 `selectedSessionId`（CONFIRMED）

**文件：** `useSessionManager.ts:369-381`

`moveSessionToGroup` 仅在 `setGroups` 中移动 session ID，**从不调用 `setSelectedSessionId`**。

```ts
const moveSessionToGroup = useCallback((sessionId, targetGroupId) => {
  setGroups((prev) => { /* 只操作 groups，不碰 selectedSessionId */ });
}, []);
```

**失败场景：**
用户在 Group A（active），选中 session `s1`。将 `s1` 拖拽至 Group B。`selectedSessionId` 保留为 `s1`，但 `activeGroupSessions` 仅包含 Group A 剩余 session（`[s2]`）。TerminalPanel 中所有容器无 active highlight（第 170 行 `sid === selectedSessionId` 永假），Step 7 恢复焦点失败（`visibleIds.includes(selectedSessionId)` 为假）。

### 6. `launchSession` 跨 `await` 的 `activeGroupId` 闭包过期（CONFIRMED）

**文件：** `useSessionManager.ts:278-290`

```ts
const sessionId = await api.createPty(ws.id, ...);  // ← 耗时 200-500ms
// activeGroupId 来自 useCallback 创建时的闭包，此时已过期
setGroups((prev) => {
  const idx = prev.findIndex((g) => g.id === activeGroupId);
  // ...
});
```

`launchSession` 的 `useCallback` 依赖 `[activeGroupId, nextSessionIndex]`。用户等待 PTY 创建期间切换分组 → `activeGroupId` 已变为新分组 → 新 session 被分配到旧分组。

**失败场景：**
1. 当前分组 Group A，点击"启动 session"
2. `api.createPty()` 执行中（~300ms）
3. 用户切换到 Group B
4. `launchSession` 继续执行，闭包中 `activeGroupId` 是 Group A
5. 新 session 加入 Group A，而用户期望在 Group B

### 7. `onPtyTitle` 中 `setSessions` updater 包含副作用（CONFIRMED）

**文件：** `useSessionManager.ts:80-108`

`setSessions` updater 内部调用 `prevStatusMap.set()`（外部变量突变）和 `notifySession()`（系统通知 + 异步调用）。

**失败场景：**
Strict Mode（dev）下 `setSessions` updater 被调用两次。第一次调用已突变 `prevStatusMap`，已调用 `notifySession`。第二次调用发现 `oldStatus === newStatus` 跳过通知分支，但第一次的通知已发出。用户收到重复的"Task Complete"通知。

### 8. Caps Lock 开启时 Ctrl+V 粘贴失效（CONFIRMED）

**文件：** `TerminalPanel.tsx:197`

```ts
e.ctrlKey && !e.shiftKey && ... && e.key === "v"  // 第 197 行：要求小写 v
e.ctrlKey && e.shiftKey && ... && e.key === "V"   // 第 202 行：要求 Shift 键 + 大写 V
```

Caps Lock 开启时 `Ctrl+V` 产生 `e.key === "V"` 且 `e.shiftKey === false`。两个条件均不匹配 → `return true` → xterm 收到 `^V` 控制字符而不是粘贴。

**修复：** 将行 197 的 `e.key === "v"` 改为 `e.key.toLowerCase() === "v"`。

---

## 中等问题

### 9. IME 保护层 DOM 泄漏（CONFIRMED）

**文件：** `TerminalPanel.tsx:248-259`

Step 6 的 IME 保护层逻辑缺少对"不可见且非选中"会话的处理：

```ts
if (sid === selectedSessionId) {
  if (overlay) overlay.remove();
} else if (visibleIds.includes(sid) && !overlay) {
  // 创建覆盖层
}
// 缺少：else if (!visibleIds.includes(sid) && overlay) { overlay.remove(); }
```

**失败场景：**
用户从 3 会话分屏切换到单会话布局。原先两个非选中会话的 `.term-ime-guard` div 残留在 DOM 中。重复切换累积垃圾节点。

### 10. 文档与代码不一致：1-2 会话用 CSS Grid 而非 Flex（CONFIRMED）

**文件：** `docs/terminal-rendering.md:13-14`

| 文档描述 | 实际代码 |
|---------|---------|
| "flex row" | `root.className = "terminal-container split-mode"` + CSS `.split-mode { display: grid; }` |
| 1 会话：grid-template-columns: 1fr | 正确 |
| 2 会话：grid-template-columns: 1fr 1fr | 正确 |

布局方式列误标为"flex row"，实际是 CSS Grid。`说明` 列正确标注了 CSS Grid 属性（`grid-template-columns`），与 `布局方式` 列自相矛盾。另外 4 会话说明"四等分自动填充"不够精确——实际也是 `grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr`。

### 11. 空 `catch` 违反项目错误处理规范（CONFIRMED）

**文件：** `TerminalPanel.tsx:238-239,293`

```ts
try {
  inst.fitAddon.fit();
  // ...
} catch { /* ignore */ }
```

项目规范（development-standards.md）明确要求："禁止静默吞噬错误（IO/持久化/序列化等关键路径禁止 `let _ = ...`）"。`fit()` 和 `resizePty()` 属于终端渲染关键路径。空 catch 导致终端尺寸不对齐时完全无日志，问题被掩盖。

### 12. `e.target as HTMLElement` 不安全类型断言（CONFIRMED）

**文件：** `TerminalPanel.tsx:308-310`

```ts
const tag = (e.target as HTMLElement)?.tagName;
const cl = (e.target as HTMLElement)?.classList;
```

`e.target` 运行时可能是 `SVGElement`、`Document`、`Text` 节点等。SVG 元素的 `tagName` 返回字符串（如 `"svg"`、`"path"`），`?.tagName` 返回非空字符串但 `tag === "INPUT"` 为假 → `isInput` 为 false → 键盘快捷键在 SVG 图标聚焦时被意外触发。

具体场景：用户点击侧栏 SVG 图标后按 `Alt+Arrow`，KeyDown 事件从 SVG 元素触发，`tag` 为 `"svg"`，`isInput` 为 `false`，Alt+Arrow 快捷键执行 session 切换。

---

## 次要问题

### 13. `deleteGroup`/`stopSession` 两次调用 `setSelectedSessionId`（CONFIRMED）

**文件：** `useSessionManager.ts:330,342,401,414`

```ts
// stopSession 先设置
setSelectedSessionId((prev) => (prev === sessionId ? nextSelectedId : prev));
// setGroups updater 内部又设置一次
setSelectedSessionId(updated[0].sessionIds[0]);
```

两次竞态调用只有最后一次生效。虽然 React 18 自动批处理确保最终结果正确，但该模式脆弱——代码修改者可能无意中改变执行顺序导致不一致。

### 14. Container 样式逻辑在 Step 3 和 Step 4 重复（CONFIRMED）

**文件：** `TerminalPanel.tsx:160-171,182-185`

```ts
// Step 3：已有容器设置样式
inst.container.style.display = visible ? "block" : "none";
if (visible && count === 3 && i === 0) inst.container.style.gridRow = "1 / 3";
inst.container.classList.toggle("active", sid === selectedSessionId);
inst.container.style.outline = sid === selectedSessionId ? "1px solid #60cdff" : "";

// Step 4：新建容器重复完全相同的逻辑
container.style.display = i >= 0 ? "block" : "none";
if (i >= 0 && count === 3 && i === 0) container.style.gridRow = "1 / 3";
container.classList.toggle("active", session.id === selectedSessionId);
container.style.outline = session.id === selectedSessionId ? "1px solid #60cdff" : "";
```

如果 highlight 颜色或布局规则变化需要同时修改两处。建议：Step 4 新建容器后放入 instances Map，让 Step 3 的循环统一处理所有容器。

### 15. `resizePty` 未做维度 diff 即发送 IPC（CONFIRMED）

**文件：** `TerminalPanel.tsx:237,291`

每次 layout effect 重跑或 ResizeObserver 触发，不论容器尺寸是否变化，都对所有可见 session 调用 `api.resizePty`。旧代码（`refitVisible`）曾比较 `oldCols !== dims.cols || oldRows !== dims.rows` 再发送，重构后被移除。

**影响：** 每帧多 N 次 IPC round-trip（Tauri invoke → backend）。PTY 标题更新频繁时，持续向后端发送无意义的 resize 请求。

---

## Step 5 `focus()` 同步重绘机制的可靠性问题

以下几项针对提交 `e605b13`（trigger xterm synchronous redraw via focus()）引入的机制进行分析，不涉及文档与代码的一致性，而是机制本身的设计局限。

### 16. textarea 已聚焦时 `focus()` 是空操作，同步重绘失效（PLAUSIBLE）

**文件：** `TerminalPanel.tsx:244-245`

Step 5 调用 `first.term.focus()` 的预期是通过 `_onTextAreaFocus()` → `renderRows(0, rows-1)` 实现同步重绘。但如果用户正在该终端输入（textarea 已经是 activeElement），`focus()` 不触发 `onfocus` 事件 → 同步重绘路径不执行。

此时只有第 238 行 `inst.term.refresh(0, inst.term.rows - 1)` 的 rAF 异步重绘在排队。浏览器 paint 时 canvas 用旧内容绘制在新尺寸上，产生一帧闪烁。

**触发条件：** 用户正在第一个可见终端输入（它是 selectedSessionId）+ 布局变更（如新增第三个会话、切换 split mode）同时发生。

**影响范围：** 一帧视觉闪烁，后续 Step 7 的双重 rAF `focus()` 在约 32ms 后修复。文档未讨论此场景。

### 17. ResizeObserver 路径缺少 `focus()` 同步重绘兜底（PLAUSIBLE）

**文件：** `TerminalPanel.tsx:283-293`

`ResizeObserver` 回调只调用 `fit()` + `refresh()`（rAF 异步），没有 `focus()`。文档称"没有布局变化，不需要 focus()"，但窗口缩放时 grid cell 尺寸变化导致 canvas 尺寸变更，`refresh()` 的异步重绘同样存在一帧旧内容闪烁的风险。

**不同之处：** 窗口缩放不涉及 `gridRow: 1/3` 的跨行变化，canvas 尺寸变化幅度通常较小，闪烁不那么明显。但原理相同：缺少同步重绘的兜底。

---

## 总结

| 严重性 | 数量 | 典型问题 |
|--------|------|---------|
| 🔴 严重 | 8 | 焦点窃取、cleanup 崩溃、状态不一致、分组穿越 |
| 🟡 中等 | 5 | DOM 泄漏、文档偏差、错误吞噬、类型安全、focus()同步重绘在已聚焦时失效 |
| 🔵 次要 | 4 | 竞态 setter、代码重复、冗余 IPC、ResizeObserver 缺同步重绘 |

**推荐优先级：**
1. 修复 #1（`useLayoutEffect` 依赖过多导致焦点窃取）— 分离"结构变更"和"元数据变更"
2. 修复 #2（`.catch(() => {})` cleanup 崩溃）— 改为 `.catch(() => () => {})` 确保始终返回函数
3. 修复 #3（useSessionManager cleanup 缺 catch）— 统一添加 `.catch(() => {})`
4. 修复 #4（setState 嵌套在 updater 内）— 将状态计算外提到 updater 外部
5. 修复 #5（moveSessionToGroup 未更新 selectedSessionId）
6. 修复 #6（launchSession 需用 ref 追踪 activeGroupId）
7. 修复 #8（Caps Lock 粘贴失效）
8. 修复 #11（空 catch 加日志）
