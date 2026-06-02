/**
 * Windows 系统通知封装
 *
 * 基于 Tauri v1 的 notification API，提供简洁的通用接口。
 * 使用前确保 tauri.conf.json 的 allowlist 中包含：
 *   "notification": { "all": true }
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";

// ── 权限管理 ──

let _permissionGranted: boolean | null = null;

/**
 * 确保通知权限已获取。
 * 首次调用会检查权限，若未授权则向用户请求。
 * 后续调用复用缓存结果。
 */
export async function ensurePermission(): Promise<boolean> {
  if (_permissionGranted === true) return true;
  if (_permissionGranted === false) return false;

  let granted = await isPermissionGranted();
  if (!granted) {
    const result = await requestPermission();
    granted = result === "granted";
  }
  _permissionGranted = granted;
  return granted;
}

/**
 * 重置缓存的权限状态（例如用户可能在系统设置中更改了权限）
 */
export function resetPermissionCache(): void {
  _permissionGranted = null;
}

// ── 通知发送 ──

export interface NotificationOptions {
  /** 通知标题（必填） */
  title: string;
  /** 通知正文（可选） */
  body?: string;
  /** 失败时是否静默（默认 true — 不抛异常、不打印） */
  silent?: boolean;
}

/**
 * 发送一条 Windows 系统通知（Toast）。
 *
 * 自动处理权限请求，权限被拒时静默失败（除非 silent: false）。
 *
 * @example
 *   notify({ title: "Task Complete", body: "claude-code has finished" });
 *   notify({ title: "Hello" }); // 仅标题
 */
export async function notify(options: NotificationOptions): Promise<void> {
  const { title, body, silent = true } = options;

  try {
    const ok = await ensurePermission();
    if (!ok) {
      if (!silent) {
        console.warn("[notify] notification permission not granted");
      }
      return;
    }
    sendNotification({ title, body: body ?? "" });
  } catch (e) {
    if (!silent) {
      console.error("[notify] failed to send notification:", e);
    }
  }
}

// ── 会话事件通知 ──

export interface NotifySessionOptions {
  /** 事件标题，例如 "✅ Task Complete" */
  title: string;
  /** 会话显示名，例如 "[3] Claude Code" */
  sessionName: string;
  /** 所属工作区名称 */
  workspaceName?: string;
  /** 附加信息，例如 "exited with code 1" */
  detail?: string;
  /** 会话 ID，用于点击通知后跳转 */
  sessionId?: string;
}

/**
 * 发送一条带会话上下文标识的系统通知。
 *
 * 通知正文格式：`[工作区] Session #N 详情`
 * 通过 Rust notify-rust 发送原生 Windows Toast，点击后可跳转到对应会话。
 *
 * @example
 *   notifySession({ title: "✅ Task Complete", sessionName: "my-project #2", workspaceName: "my-project", sessionIndex: 2, sessionId: "uuid" });
 *   notifySession({ title: "⚠️ Session Exited", sessionName: "my-project #2", workspaceName: "my-project", sessionIndex: 2, detail: "exited with code 1", sessionId: "uuid" });
 */
export async function notifySession(opts: NotifySessionOptions): Promise<void> {
  const { title, sessionName, detail, sessionId } = opts;

  // 通知体格式: "[my-project] [3] Claude Code" 或 "[my-project] [3] Claude Code exited with code 1"
  const tag = opts.workspaceName ? `[${opts.workspaceName}]` : "";
  const parts = [tag, sessionName, detail].filter(Boolean);
  const body = parts.join(" ");

  // 优先使用 Rust 原生通知（支持点击跳转），回退到 JS API
  if (sessionId) {
    try {
      await invoke("send_session_notification", {
        sessionId,
        title,
        body,
      });
      return;
    } catch {
      // fall through to JS notification
    }
  }

  return notify({ title, body });
}
