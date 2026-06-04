# 终端渲染逻辑

## 概述

终端渲染的核心在 `src/components/terminal/TerminalPanel.tsx` 中，依赖 xterm.js 和 `xterm-addon-fit`。每个会话对应一个独立的 `Terminal` 实例，容器为 `div.term-instance`。

## 布局策略

所有 `div.term-instance` 作为 `div.terminal-container` 的子元素，通过 CSS Grid 或 Flexbox 排列：

| 会话数 | 布局方式 | 说明 |
|--------|----------|------|
| 1 | CSS Grid | `grid-template-columns: 1fr` |
| 2 | CSS Grid | `grid-template-columns: 1fr 1fr` |
| 3 | CSS Grid 2×2 | 第一个容器 `grid-row: 1 / 3` 占左列 100% 高度，其余占右列 |
| 4 | CSS Grid 2×2 | `grid-template-columns: 1fr 1fr`; `grid-template-rows: 1fr 1fr` |

3 会话时没有使用嵌套容器，直接通过 `grid-row: 1 / 3` 实现左列全高，这是目前唯一用到 CSS Grid span 的场景。1-2 会话同样使用 CSS Grid（`display: grid` via `.terminal-container.split-mode`），而非 Flexbox。

## 生命周期（`useLayoutEffect`）

布局修改在 `useLayoutEffect` 中同步执行，在浏览器 paint 前完成。

### Step 1 — 销毁

遍历 `instances` 字典，如果某会话已从 `sessions` 数组中移除（用户关闭了会话），则：

1. `inst.term.dispose()` — 销毁 xterm 实例（清理事件监听、渲染器、DOM）
2. 从父节点移除 `container` DOM 元素
3. 从 `instances` Map 中删除条目

### Step 2 — 可见会话

根据 `activeGroupSessions` 和 `splitMode` 计算当前要显示的会话 ID 列表 `visibleIds`。

### Step 3 — 应用布局

- 设置 `root` 的 CSS Grid 属性（列数、行数）
- 对每个 container：
  - `display: block / none` — 控制可见性
  - `gridRow: "1 / 3"` — 仅在 3 会话时对第一个容器设置
  - `active` class + `outline` — 高亮选中的会话

### Step 4 — 创建 xterm

遍历 `sessions`，为尚未创建 xterm 的会话创建新实例：

1. 创建 `div.term-instance`，设置 data 属性、样式，append 到 root
2. `new Terminal(options)` — 配置光标、字体、主题（Campbell 暗色）
3. `term.loadAddon(fitAddon)` — 装载 FitAddon
4. `term.open(container)` — 初始化 xterm 的 DOM（`div.xterm` → `div.xterm-screen` → `<canvas>`）
5. 绑定事件：click（选中会话）、onData（键盘输入→PTY）
6. 刷新缓冲区中的积压输出

### Step 5 — 调整尺寸 + 重绘

对所有可见终端：

1. `void root.offsetHeight` — 强制浏览器提交布局
2. `inst.fitAddon.fit()` — 读取容器实际宽高，计算 cols/rows，调用 `term.resize()`
3. `api.resizePty()` — 通知后端 PTY 调整尺寸
4. `inst.term.refresh(0, rows-1)` — 刷新 canvas 内容
5. **`visibleIds[0].term.focus()`** — 焦点触发 xterm 内部同步重绘（关键修复）

#### 为什么需要 `focus()`（关键）

`refresh()` 是 rAF 异步的：它只是标记"需要重绘"，真正执行的时机在下一帧。浏览器可能在脏 canvas 上 paint，导致用户看到旧尺寸的内容。

`focus()` 触发的路径：`textarea.onfocus` → `_onTextAreaFocus()` → `renderRows(0, rows-1)` 是**同步**的，在 `useLayoutEffect` 返回前、浏览器 paint 之前就重绘完毕。

因为 focus 在 `useLayoutEffect` 中同步执行，焦点很快会被 Step 7 跳回用户选中的会话，用户无感知。

### Step 6 — IME 输入法保护

在非选中的可见容器上覆盖 `div.term-ime-guard`（绝对定位、inset:0、z-index:10、click 透传），防止输入法组合状态被意外切换。

### Step 7 — 恢复焦点

使用双重 `requestAnimationFrame` 延迟恢复焦点到 `selectedSessionId`：

```ts
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    termInstancesRef.current.get(selectedSessionId)?.term.focus();
  });
});
```

双重 rAF 确保在浏览器完成当前帧的绘制后、下一帧布局前设置焦点。顺序上 Step 5 的 `focus(visibleIds[0])` 先触发，约 32ms 后恢复为选中会话，用户感觉不到焦点跳转。

## 窗口缩放的响应

`ResizeObserver`（`useEffect`）监听 `div.terminal-container` 的尺寸变化，250ms 防抖后调用相同的 `fit()` + `refresh()` 逻辑（不调用 `focus()`，因为没有布局变化）。

## 键盘快捷键

`useEffect`（capture 模式）拦截全局 `keydown`：

| 组合键 | 行为 |
|--------|------|
| `Alt+←` / `Alt+↑` | 切换到上一个会话 |
| `Alt+→` / `Alt+↓` | 切换到下一个会话 |
| `Ctrl+V` | 粘贴剪贴板内容到当前终端 |
| `Ctrl+Enter` | 发送回车 |

`switchSessionRef` 引用最新 `selectSession` 函数避免闭包陈旧。

## PTY 输出流

`useEffect`（空依赖，仅 mount 时执行）注册两个事件监听：

- **pty-output**：从后端接收 shell 输出。如果对应 xterm 实例已存在则 `term.write()`，否则缓冲到 `pendingOutputRef`，等 xterm 创建后刷新。
- **pty-exit**：进程退出时在终端底部写一条"进程已退出"的黄色提示。

## 颜色方案

Windows Terminal "Dark+"（Campbell 调色板），定义在 `TERM_THEME` 常量中，24 色全色域覆盖。

## 文件依赖

```
TerminalPanel.tsx
├── api.ts                  — invoke resizePty / writePty 等
├── useSession.ts (context) — sessions, selectedSessionId, groups
├── xterm / xterm-addon-fit — 终端引擎 & 自适应尺寸
├── terminal-global.css     — .term-instance, .xterm, .split-mode 样式
├── TerminalPanel.module.css — .panel, .groupTabs, .terminalTabs
├── GroupTabs.tsx           — 分组标签栏
├── SessionTabs.tsx         — 会话标签栏
└── ConfirmDialog.tsx       — 删除分组确认弹窗
```
