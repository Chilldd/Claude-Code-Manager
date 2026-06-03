// ── Session types ──

import type { SessionBackendState } from "./api";

export type SessionStatus = "running" | "thinking" | "idle" | "attention" | "exited";

export interface SessionInfo {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  sessionIndex: number;
  status: SessionStatus;
}

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
}

export const MAX_GROUP_SIZE = 4;

/** Compute next group id/name from current groups (safe under StrictMode) */
export function nextGroupInfo(groups: SessionGroup[]): { id: string; name: string } {
  const maxNum = groups.reduce((max, g) => Math.max(max, parseInt(g.id.replace('g', '')) || 0), 1);
  const n = maxNum + 1;
  return { id: `g${n}`, name: `Group ${n}` };
}

/** Detect if a character is a Braille-pattern spinner (U+2800-U+28FF range) */
export function isSpinnerChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  return code !== undefined && code >= 0x2800 && code <= 0x28FF;
}

/** Infer claude status from terminal title */
export function inferStatus(title: string): SessionStatus {
  const trimmed = title.trim();
  const claudeIdx = trimmed.indexOf("Claude Code");
  if (claudeIdx >= 0) {
    const prefix = trimmed[claudeIdx - 2] ?? "";
    if (isSpinnerChar(prefix)) return "thinking";
    return "idle";
  }
  return "running";
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
