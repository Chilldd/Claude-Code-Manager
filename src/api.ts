import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Domain types ──

export interface Workspace {
  id: string;
  name: string;
  path: string;
  command: string;
  args: string;
  auto_prompt: string;
  env: Record<string, string>;
}

export interface PtyOutputEvent {
  session_id: string;
  data: string;
}

export interface PtyExitEvent {
  session_id: string;
  code: number;
}

export interface PtyTitleEvent {
  session_id: string;
  title: string;
}

export interface BackendSessionInfo {
  id: string;
  workspace_id: string;
  name: string;
}

export type SessionBackendState = "created" | "running" | "busy" | "idle" | "zombie" | "exited";

/** Notification preferences (from ccmanager.json) */
export interface NotificationConfig {
  task_complete: boolean;
  permission_prompt: boolean;
}

export interface Ccconfig {
  notification: NotificationConfig;
}

export type AgentStatus = "idle" | "busy" | "waiting" | "running";

/** One entry from `claude agents --json` */
export interface ClaudeAgentInfo {
  pid: number;
  cwd: string;
  kind: string;
  started_at: number;
  session_id: string;
  status: AgentStatus;
  waiting_for?: string;
}

// ── Metrics event types (event-driven, no polling) ──

export interface SystemMetrics {
  cpu_percent: number;
  memory_total_gb: number;
  memory_used_gb: number;
  memory_percent: number;
}

export interface FlatProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_bytes: number;
  state: string;
  parent_pid: number | null;
}

export interface ProcessNode {
  pid: number;
  parent_pid: number | null;
  children: ProcessNode[];
  name: string;
  cpu_percent: number;
  memory_bytes: number;
  state: string;
}

export interface ProcessTreePayload {
  session_id: string;
  trees: ProcessNode[];
}

export interface ProcessesDiffPayload {
  session_id: string;
  added: FlatProcessInfo[];
  removed: number[];
  updated: FlatProcessInfo[];
}

export interface SessionStatePayload {
  session_id: string;
  state: SessionBackendState;
}

// ── API commands ──

export const api = {
  getWorkspaces: () => invoke<Workspace[]>("get_workspaces"),
  addWorkspace: (ws: Omit<Workspace, "id">) =>
    invoke<Workspace[]>("add_workspace", { ws }),
  updateWorkspace: (ws: Workspace) =>
    invoke<Workspace[]>("update_workspace", { ws }),
  deleteWorkspace: (id: string) =>
    invoke<Workspace[]>("delete_workspace", { id }),
  reorderWorkspaces: (ids: string[]) =>
    invoke<Workspace[]>("reorder_workspaces", { ids }),

  createPty: (sessionId: string, workspaceId: string, sessionName: string, command: string, args: string, cwd: string, env: Record<string, string>, injectSessionId?: boolean, cols?: number, rows?: number) =>
    invoke<string>("create_pty", { sessionId, workspaceId, sessionName, command, args, cwd, env, injectSessionId, cols, rows }),
  writePty: (sessionId: string, data: string) =>
    invoke<void>("write_pty", { sessionId, data }),
  resizePty: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize_pty", { sessionId, cols, rows }),
  killPty: (sessionId: string) =>
    invoke<void>("kill_pty", { sessionId }),
  isPtyActive: (sessionId: string) =>
    invoke<boolean>("is_pty_active", { sessionId }),
  listActiveSessions: () =>
    invoke<BackendSessionInfo[]>("list_active_sessions"),

  /** Send a native notification with click-to-activate. Click opens the app via deep-link protocol. */
  sendSessionNotification: (sessionId: string, title: string, body: string) =>
    invoke<void>("send_session_notification", { sessionId, title, body }),

  /** Import workspaces from Claude Code's project directory (~/.claude/projects/) */
  importFromClaudeCode: () =>
    invoke<Workspace[]>("import_from_claude_code"),

  /** Load notification preferences from ccmanager.json */
  getConfig: () => invoke<Ccconfig>("get_config"),

  /** Get Claude agent info by session_id */
  getAgentInfo: (sessionId: string) =>
    invoke<ClaudeAgentInfo | null>("get_agent_info", { sessionId }),

  /** Open a directory in the system file explorer */
  openInExplorer: (path: string) =>
    invoke<void>("open_in_explorer", { path }),

  /** Append to the persistent debug log file (survives webview refresh) */
  debugLog: (msg: string) =>
    invoke<void>("frontend_log", { msg }).catch(() => {}),

  /** Scan git worktrees in a directory */
  scanWorktrees: (path: string) =>
    invoke<{ name: string; path: string; active: boolean }[]>("scan_worktrees", { path }),

  /** Get recent Claude Code sessions for a workspace path */
  getRecentSessions: (workspacePath: string) =>
    invoke<{ session_id: string; title: string; last_modified: number }[]>("get_recent_sessions", { workspacePath }),
};

// ── Event listeners (event-driven, replaces polling) ──

/** System metrics: CPU + memory (emitted every 1s by MetricsEngine) */
export function onSystemMetrics(
  cb: (payload: SystemMetrics) => void,
): Promise<() => void> {
  return listen<SystemMetrics>("system-metrics-updated", (e) => cb(e.payload));
}

/** Process tree snapshot for a session (emitted every 2s) */
export function onProcessTreeUpdated(
  cb: (payload: ProcessTreePayload) => void,
): Promise<() => void> {
  return listen<ProcessTreePayload>("process-tree-updated", (e) =>
    cb(e.payload),
  );
}

/** State diff: process spawn/kill/update delta (emitted when change detected) */
export function onProcessesDiff(
  cb: (payload: ProcessesDiffPayload) => void,
): Promise<() => void> {
  return listen<ProcessesDiffPayload>("processes-diff", (e) => cb(e.payload));
}

/** Session lifecycle state change */
export function onSessionStateChanged(
  cb: (payload: SessionStatePayload) => void,
): Promise<() => void> {
  return listen<SessionStatePayload>("session-state-changed", (e) =>
    cb(e.payload),
  );
}

/** Session created by PTY */
export function onSessionCreated(
  cb: (payload: { session_id: string; workspace_id: string }) => void,
): Promise<() => void> {
  return listen<{ session_id: string; workspace_id: string }>(
    "session-created",
    (e) => cb(e.payload),
  );
}

/** Session killed by PTY */
export function onSessionKilled(
  cb: (payload: { session_id: string }) => void,
): Promise<() => void> {

  return listen<{ session_id: string }>("session-killed", (e) =>
    cb(e.payload),
  );
}

/** Claude agent snapshot pushed from backend every 1s */
export function onClaudeAgentsUpdated(
  cb: (agents: Record<string, ClaudeAgentInfo>) => void,
): Promise<() => void> {
  return listen<Record<string, ClaudeAgentInfo>>("claude-agents-updated", (e) =>
    cb(e.payload),
  );
}

// ── Legacy PTY events ──

/** Listen for PTY output events from any session */
export function onPtyOutput(cb: (payload: PtyOutputEvent) => void): Promise<() => void> {
  return listen<PtyOutputEvent>("pty-output", (event) => cb(event.payload));
}

/** Listen for PTY exit events from any session */
export function onPtyExit(cb: (payload: PtyExitEvent) => void): Promise<() => void> {
  return listen<PtyExitEvent>("pty-exit", (event) => {
    cb(event.payload);
  });
}

/** Listen for PTY title-change events (OSC 0/2 sequences from the child process) */
export function onPtyTitle(cb: (payload: PtyTitleEvent) => void): Promise<() => void> {
  return listen<PtyTitleEvent>("pty-title", (event) => cb(event.payload));
}

