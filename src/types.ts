// ── Session types ──

import type { SessionBackendState } from "./api";

export type SessionStatus = "pending" | "running" | "thinking" | "idle" | "attention" | "exited" | "waiting";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  sessionIndex: number;
  status: SessionStatus;
  /** Set when session was launched with --worktree <name> */
  worktreeName?: string;
}

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
}

export const MAX_GROUP_SIZE = 4;

/** Launch strategy — encapsulates how to compose the final command */
export type LaunchStrategy =
  | { type: "normal" }
  | { type: "worktree"; worktreeName: string }
  | { type: "resume"; sessionId: string };

/** Compute next group id/name from current groups (safe under StrictMode) */
export function nextGroupInfo(groups: SessionGroup[]): { id: string; name: string } {
  const maxNum = groups.reduce((max, g) => Math.max(max, parseInt(g.id.replace('g', '')) || 0), 1);
  const n = maxNum + 1;
  return { id: `g${n}`, name: `Group ${n}` };
}

/** Detect Claude Code permission prompt from PTY output text */
export function isPermissionPrompt(data: string): boolean {
  return (
    data.includes("Allow Claude Code to") ||
    data.includes("Claude Code needs permission") ||
    data.includes("Claude Code needs your permission") ||
    /Allow\s.*Claude Code/im.test(data)
  );
}

// ── Backend session state mapping ──

/** Convert backend session state to frontend display status */
export function mapBackendToDisplay(state: SessionBackendState): SessionStatus {
  switch (state) {
    case "created": return "running";
    case "running": return "running";
    case "busy": return "running";
    case "idle": return "idle";
    case "zombie": return "exited";
    case "exited": return "exited";
  }
}
