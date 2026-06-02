# Claude Code Manager — MVP 设计文档

## 🎯 1. 项目定位

桌面应用 — 管理 Claude Code CLI 的工作区，提供一键启动和嵌入式终端交互。

**核心能力：**

- 创建 / 删除 / 编辑 Workspace
- Workspace 列表展示
- 一键启动 Claude Code（嵌入式终端）
- 记录启动 Session（可选）

---

## 🧱 2. 技术架构（Tauri）

```text
┌──────────────────────────────────────────────────┐
│                   Tauri Window                    │
│  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Workspace    │  │      Terminal (xterm.js)   │ │
│  │ Management   │  │                           │ │
│  │              │  │   ┌─────────────────────┐ │ │
│  │ ┌──────────┐ │  │   │  Claude Code CLI    │ │ │
│  │ │ Trading  │ │  │   │                     │ │ │
│  │ │ Bot      │ │  │   │  > What do you      │ │ │
│  │ │ [Launch] │ │  │   │  want to build?     │ │ │
│  │ ├──────────┤ │  │   └─────────────────────┘ │ │
│  │ │ AI Agent │ │  │                           │ │
│  │ │ [Launch] │ │  │                           │ │
│  │ └──────────┘ │  │                           │ │
│  │ [+ Add]      │  │                           │ │
│  └──────────────┘  └───────────────────────────┘ │
└──────────────────────────────────────────────────┘
                        ↑
              Tauri IPC (Rust PTY Bridge)
```

**技术栈：**

| 层 | 技术 |
|---|---|
| 前端框架 | React + TypeScript + Vite |
| UI 样式 | CSS (自建) |
| 终端渲染 | xterm.js |
| PTY 层 | portable-pty (Rust) |
| 后端框架 | Tauri v1 |
| IPC 通信 | Tauri Events + Commands |
| 存储 | JSON 文件 (`%APPDATA%/yug-cc-manager/`) |

---

## 🧩 3. 核心数据模型

### 📁 Workspace

```json
{
  "id": "trading-bot",
  "name": "Trading Bot",
  "path": "D:\\code\\trading-bot",
  "command": "claude",
  "args": "",
  "autoPrompt": "",
  "env": {}
}
```

### 💾 存储方式

本地 JSON 文件：`%APPDATA%/yug-cc-manager/workspaces.json`

---

## 🖥️ 4. UI 布局

```
┌──────────────────────────────────────────────────────┐
│  Claude Code Manager                                 │
├──────────────┬───────────────────────────────────────┤
│  Workspaces  │           Terminal                    │
│              │                                       │
│  + Add       │  ┌─────────────────────────────────┐ │
│              │  │  $ claude                        │ │
│  📁 Trading  │  │  > What do you want to build?   │ │
│    [Launch]  │  │  > I want to create a Discord   │ │
│  📁 AI Agent │  │    bot that...                   │ │
│    [Launch]  │  │                                 │ │
│  📁 Backend  │  └─────────────────────────────────┘ │
│    [Launch]  │                                       │
└──────────────┴───────────────────────────────────────┘
```

---

## ⚙️ 5. Rust 后端设计

### Tauri Commands

```rust
// Workspace CRUD
#[tauri::command]
fn get_workspaces() -> Vec<Workspace>

#[tauri::command]
fn add_workspace(ws: Workspace) -> Vec<Workspace>

#[tauri::command]
fn update_workspace(ws: Workspace) -> Vec<Workspace>

#[tauri::command]
fn delete_workspace(id: String) -> Vec<Workspace>

// PTY (终端) 管理
#[tauri::command]
fn create_pty(workspace_id: String)

#[tauri::command]
fn write_pty(data: String)

#[tauri::command]
fn resize_pty(cols: u16, rows: u16)

#[tauri::command]
fn kill_pty()
```

### Events (Rust → Frontend)

```rust
// 终端数据输出
emit("pty-output", data: String)

// PTY 退出
emit("pty-exit", code: i32)
```

### PTY 生命周期

```
用户点击 Launch
      ↓
create_pty(workspace_id)
      ↓
portable-pty: 创建 PTY + spawn claude
      ↓
pty-output event → xterm.js 渲染  ←→  键盘输入 → write_pty
      ↓                                          ↑
用户关闭 / 切换 workspace                              resize_pty(cols, rows)
      ↓
kill_pty()
```

---

## 🔌 6. 前端设计

### 组件树

```
App
├── WorkspacePanel
│   ├── WorkspaceHeader (+ Add button, title)
│   ├── WorkspaceList
│   │   └── WorkspaceItem (name, path, Launch/Stop button)
│   └── AddWorkspaceDialog (modal: name, path, command)
│
└── TerminalPanel
    ├── TerminalToolbar (workspace name, close button)
    └── XTerm (xterm.js terminal)
```

### Workspace 状态管理

```typescript
// Tauri invoke 封装
const api = {
  getWorkspaces: () => invoke<Workspace[]>("get_workspaces"),
  addWorkspace: (ws: Workspace) => invoke<Workspace[]>("add_workspace", { ws }),
  updateWorkspace: (ws: Workspace) => invoke<Workspace[]>("update_workspace", { ws }),
  deleteWorkspace: (id: string) => invoke<Workspace[]>("delete_workspace", { id }),
  createPty: (workspaceId: string) => invoke<void>("create_pty", { workspaceId }),
  writePty: (data: string) => invoke<void>("write_pty", { data }),
  resizePty: (cols: number, rows: number) => invoke<void>("resize_pty", { cols, rows }),
  killPty: () => invoke<void>("kill_pty"),
};
```

### xterm.js 集成

```typescript
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

// 监听 Tauri 事件
import { listen } from "@tauri-apps/api/event";
listen("pty-output", (event) => {
  term.write(event.payload as string);
});

// 键盘输入 → Tauri
term.onData((data) => {
  invoke("write_pty", { data });
});

// 窗口 resize
window.addEventListener("resize", () => fitAddon.fit());
```

---

## 📁 项目结构

```
yug-cc-manager/
├── src/                          # React 前端
│   ├── App.tsx                   # 主布局 (左右分栏)
│   ├── App.css                   # 全局样式
│   ├── main.tsx                  # 入口
│   ├── components/
│   │   ├── WorkspacePanel.tsx    # 左侧面板
│   │   ├── WorkspaceItem.tsx     # 单个 workspace
│   │   ├── AddWorkspaceDialog.tsx # 添加弹窗
│   │   └── TerminalPanel.tsx     # 右侧终端
│   ├── hooks/
│   │   └── useWorkspaces.ts      # Workspace CRUD hook
│   └── api.ts                    # Tauri invoke 封装
│
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # Tauri 入口 + Commands
│       ├── workspace.rs           # Workspace CRUD
│       └── pty.rs                # PTY 管理
│
├── package.json
├── tsconfig.json
├── vite.config.ts
└── index.html
```

---

## ✔️ MVP 功能范围

### 必须有
- Workspace CRUD（增删改查）
- 列表显示
- Launch/Stop Claude Code（嵌入式终端）
- xterm.js 终端交互
- PTY 进程生命周期管理

### 暂时不做
- 多 Tab / Session 管理
- 分屏
- Session 日志记录
- Workspace 模板
- 快捷键
- 状态栏/日志

---

## 🚀 后续方向

### v2
- 最近使用 workspace
- 快捷键启动
- 多 session / 多 tab
- Terminal 日志预览

### v3
- Split window
- Workspace templates
- 环境变量管理
- Agent runtime 监控
