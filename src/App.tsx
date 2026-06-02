import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { PerformancePanel } from "./components/PerformancePanel";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { api, onPtyTitle, onPtyExit, onPtyOutput } from "./api";
import type { Workspace } from "./api";
import { notifySession } from "./notification";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

const MAX_GROUP_SIZE = 4;

/** Compute next group id/name from current groups (safe under StrictMode) */
function nextGroupInfo(groups: SessionGroup[]): { id: string; name: string } {
  const maxNum = groups.reduce((max, g) => Math.max(max, parseInt(g.id.replace('g', '')) || 0), 1);
  const n = maxNum + 1;
  return { id: `g${n}`, name: `Group ${n}` };
}

/** Detect if a character is a Braille-pattern spinner (U+2800-U+28FF range) */
function isSpinnerChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  return code !== undefined && code >= 0x2800 && code <= 0x28FF;
}

/** Infer claude status from terminal title */
function inferStatus(title: string): SessionStatus {
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
function isPermissionPrompt(data: string): boolean {
  return (
    data.includes("Allow Claude Code to") ||
    data.includes("Claude Code needs permission") ||
    data.includes("Claude Code needs your permission") ||
    /Allow\s.*Claude Code/im.test(data)
  );
}

let _sessionCounter = 0;
function nextSessionIndex(): number {
  return ++_sessionCounter;
}

function App() {
  const {
    workspaces,
    loading,
    error,
    refresh,
    addWorkspace,
    updateWorkspace,
    deleteWorkspace,
    reorderWorkspaces,
  } = useWorkspaces();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [ptyError, setPtyError] = useState<string | null>(null);
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const [groups, setGroups] = useState<SessionGroup[]>([
    { id: 'g1', name: 'Group 1', sessionIds: [] },
  ]);
  const [activeGroupId, setActiveGroupId] = useState<string>(groups[0]?.id ?? "");
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  // View toggle: default to workspace/terminal view
  const [view, setView] = useState<"performance" | "terminal">("terminal");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);

  // Active group's session IDs
  const activeGroupSessionIds = useMemo(() => {
    const g = groups.find((g) => g.id === activeGroupId);
    return g?.sessionIds ?? [];
  }, [groups, activeGroupId]);

  // Sessions belonging to the active group
  const activeGroupSessions = useMemo(
    () => activeGroupSessionIds.map((id) => sessions.find((s) => s.id === id)).filter(Boolean) as SessionInfo[],
    [activeGroupSessionIds, sessions]
  );

  // Sync activeGroupId on mount
  useEffect(() => {
    if (!activeGroupId && groups.length > 0) {
      setActiveGroupId(groups[0].id);
    }
  }, []);

  // Listen for PTY title changes — infer status, detect task completion
  useEffect(() => {
    let prevStatusMap = new Map<string, SessionStatus>();

    const unlisten = onPtyTitle((payload) => {
      setSessions((prev) => {
        const session = prev.find((s) => s.id === payload.session_id);
        if (!session) return prev;

        const newStatus = inferStatus(payload.title);
        const oldStatus = prevStatusMap.get(payload.session_id);
        prevStatusMap.set(payload.session_id, newStatus);

        // Task complete: thinking → idle → fire system notification
        if (oldStatus === "thinking" && newStatus === "idle") {
          notifySession({
            title: "✅ Task Complete",
            sessionName: session.name,
            workspaceName: session.workspaceName,
            sessionId: session.id,
          });
          return prev.map((s) =>
            s.id === payload.session_id
              ? { ...s, name: `[${s.sessionIndex}] ${payload.title}`, status: "attention" as const }
              : s
          );
        }

        return prev.map((s) =>
          s.id === payload.session_id
            ? { ...s, name: `[${s.sessionIndex}] ${payload.title}`, status: newStatus }
            : s
        );
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for PTY exit events — notify on abnormal exit
  useEffect(() => {
    const unlisten = onPtyExit((payload) => {
      // Only notify if session still exists (not user-closed) and exit is abnormal
      const session = sessionsRef.current.find((s) => s.id === payload.session_id);
      if (!session) return;
      if (payload.code === 0) return;

      notifySession({
        title: "⚠️ Session Exited",
        sessionName: session.name,
        workspaceName: session.workspaceName,
        sessionId: session.id,
        detail: `exited with code ${payload.code}`,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for PTY output — detect permission prompts from Claude Code
  useEffect(() => {
    // Debounce: at most one permission notification per session every 15 seconds
    const lastNotify = new Map<string, number>();

    const unlisten = onPtyOutput((payload) => {
      if (!isPermissionPrompt(payload.data)) return;

      const sid = payload.session_id;
      const now = Date.now();
      const last = lastNotify.get(sid) ?? 0;
      if (now - last < 15_000) return;
      lastNotify.set(sid, now);

      const session = sessionsRef.current.find((s) => s.id === sid);
      if (!session) return;

      notifySession({
        title: "⚡ Permission Required",
        sessionName: session.name,
        workspaceName: session.workspaceName,
        sessionId: session.id,
        detail: "Claude Code needs your permission to continue",
      });

      // Also mark the session as attention so the UI highlights it
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? { ...s, status: "attention" as const }
            : s
        )
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for session-deeplink events (from notification click or single-instance forwarding)
  useEffect(() => {
    const unlisten = listen<{ session_id: string }>("session-deeplink", (event) => {
      const sid = event.payload.session_id;
      if (!sid) return;
      // Switch to terminal view so the user can see the session
      setView("terminal");
      setSelectedSessionId(sid);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid && s.status === "attention"
            ? { ...s, status: "idle" as const }
            : s
        )
      );
      // Also switch to the group containing this session
      setGroups((prev) => {
        const g = prev.find((g) => g.sessionIds.includes(sid));
        if (g) setActiveGroupId(g.id);
        return prev;
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // When user selects a session, clear its attention state & switch to its group
  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId && s.status === "attention"
          ? { ...s, status: "idle" as const }
          : s
      )
    );
    // Switch to the group containing this session
    setGroups((prev) => {
      const g = prev.find((g) => g.sessionIds.includes(sessionId));
      if (g) setActiveGroupId(g.id);
      return prev;
    });
  }, []);

  // Toggle workspace expand
  const handleToggleExpand = useCallback((workspaceId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  // Handle launch
  const handleLaunchSession = useCallback(
    async (ws: Workspace) => {
      setPtyError(null);
      const sessionIndex = nextSessionIndex();
      const sessionName = `[${sessionIndex}] ${ws.name}`;
      try {
        const sessionId = await api.createPty(
          ws.id,
          sessionName,
          ws.command,
          ws.args,
          ws.path,
          ws.env
        );
        setSessions((prev) => [
          ...prev,
          {
            id: sessionId,
            workspaceId: ws.id,
            workspaceName: ws.name,
            name: sessionName,
            sessionIndex,
            status: "running" as const,
          },
        ]);
        setSelectedSessionId(sessionId);

        // Assign to active group, or create new group if full
        setGroups((prev) => {
          const idx = prev.findIndex((g) => g.id === activeGroupId);
          if (idx >= 0 && prev[idx].sessionIds.length < MAX_GROUP_SIZE) {
            const copy = prev.map((g) =>
              g.id === activeGroupId
                ? { ...g, sessionIds: [...g.sessionIds, sessionId] }
                : g
            );
            return copy;
          }
          // Create a new group
          const { id, name } = nextGroupInfo(prev);
          const newGroup: SessionGroup = { id, name, sessionIds: [sessionId] };
          setActiveGroupId(newGroup.id);
          return [...prev, newGroup];
        });

        if (ws.auto_prompt) {
          const sid = sessionId;
          setTimeout(() => {
            api.writePty(sid, ws.auto_prompt + "\n").catch(() => {});
          }, 1500);
        }
      } catch (e) {
        const msg = String(e);
        setPtyError(msg);
        notifySession({
          title: "❌ Launch Error",
          sessionName: sessionName,
          workspaceName: ws.name,
          detail: msg,
        });
      }
    },
    [activeGroupId]
  );

  // Handle stop — also clean up groups
  const handleStopSession = useCallback(async (sessionId: string) => {
    try {
      await api.killPty(sessionId);
    } catch { /* ignore */ }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setSelectedSessionId((prev) => (prev === sessionId ? null : prev));

    setGroups((prev) => {
      let updated = prev
        .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }))
        .filter((g) => g.sessionIds.length > 0);
      // If current active group was removed, switch to first remaining
      if (!updated.some((g) => g.id === activeGroupId)) {
        if (updated.length > 0) {
          setActiveGroupId(updated[0].id);
        } else {
          // Re-create a default empty group
          const fresh: SessionGroup = { id: 'g1', name: 'Group 1', sessionIds: [] };
          setActiveGroupId(fresh.id);
          updated = [fresh];
        }
      }
      return updated;
    });
  }, [activeGroupId]);

  // Handle delete workspace
  const handleDeleteConfirm = useCallback(async () => {
    const workspaceId = confirmDeleteId;
    if (!workspaceId) return;
    setConfirmDeleteId(null);
    const wsSessions = sessions.filter((s) => s.workspaceId === workspaceId);
    const ids = wsSessions.map((s) => s.id);
    for (const s of wsSessions) {
      await api.killPty(s.id).catch(() => {});
    }
    setSessions((prev) => prev.filter((s) => s.workspaceId !== workspaceId));
    setSelectedSessionId((prev) =>
      wsSessions.some((s) => s.id === prev) ? null : prev
    );
    setGroups((prev) => {
      let updated = prev
        .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => !ids.includes(id)) }))
        .filter((g) => g.sessionIds.length > 0);
      if (!updated.some((g) => g.id === activeGroupId)) {
        if (updated.length > 0) {
          setActiveGroupId(updated[0].id);
        } else {
          const fresh: SessionGroup = { id: 'g1', name: 'Group 1', sessionIds: [] };
          setActiveGroupId(fresh.id);
          updated = [fresh];
        }
      }
      return updated;
    });
    await deleteWorkspace(workspaceId);
  }, [confirmDeleteId, activeGroupId, sessions, deleteWorkspace]);

  const handleEditSave = useCallback(
    async (ws: Omit<Workspace, "id">, originalId: string) => {
      const ok = await updateWorkspace({ ...ws, id: originalId });
      if (ok) setEditingWorkspace(null);
    },
    [updateWorkspace]
  );

  const handleSwitchGroup = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    const group = groups.find((g) => g.id === groupId);
    if (group && group.sessionIds.length > 0 && !group.sessionIds.includes(selectedSessionId ?? '')) {
      setSelectedSessionId(group.sessionIds[0]);
    }
  }, [groups, selectedSessionId]);

  const handleReorder = useCallback(
    async (workspaceId: string, direction: "up" | "down") => {
      const idx = workspaces.findIndex((w) => w.id === workspaceId);
      if (idx === -1) return;
      const target = direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= workspaces.length) return;
      const reordered = [...workspaces];
      [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
      await reorderWorkspaces(reordered.map((w) => w.id));
    },
    [workspaces, reorderWorkspaces]
  );

  const handleGroupDeleteConfirm = useCallback(async () => {
    const groupId = confirmDeleteGroupId;
    if (!groupId) return;
    setConfirmDeleteGroupId(null);
    // Find sessions in this group and kill them
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      const ids = group.sessionIds;
      for (const sid of ids) {
        await api.killPty(sid).catch(() => {});
      }
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
      setSelectedSessionId((prev) => (ids.includes(prev ?? '') ? null : prev));
    }
    setGroups((prev) => {
      const updated = prev.filter((g) => g.id !== groupId);
      if (updated.length === 0) {
        const fresh = { id: 'g1', name: 'Group 1', sessionIds: [] };
        setActiveGroupId(fresh.id);
        return [fresh];
      }
      if (!updated.some((g) => g.id === activeGroupId)) {
        setActiveGroupId(updated[0].id);
      }
      return updated;
    });
  }, [confirmDeleteGroupId, groups, activeGroupId]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    setGroups((prev) => {
      if (prev.some((g) => g.id !== groupId && g.name === name)) return prev; // duplicate
      return prev.map((g) => (g.id === groupId ? { ...g, name } : g));
    });
  }, []);

  const handleMoveSessionToGroup = useCallback((sessionId: string, targetGroupId: string) => {
    setGroups((prev) => {
      const src = prev.find((g) => g.sessionIds.includes(sessionId));
      const tgt = prev.find((g) => g.id === targetGroupId);
      if (!src || !tgt || src.id === tgt.id) return prev;
      if (tgt.sessionIds.length >= MAX_GROUP_SIZE) return prev; // target full
      return prev.map((g) => {
        if (g.id === src.id) return { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) };
        if (g.id === targetGroupId) return { ...g, sessionIds: [...g.sessionIds, sessionId] };
        return g;
      });
    });
  }, []);

  const handleAddSave = useCallback(
    async (ws: Omit<Workspace, "id">) => {
      const ok = await addWorkspace(ws);
      if (ok) setShowAddDialog(false);
    },
    [addWorkspace]
  );

  const handleImportClaude = useCallback(async () => {
    try {
      const discovered = await api.importFromClaudeCode();
      if (discovered.length === 0) {
        setInfoToast("All Claude Code projects have already been imported.");
        return;
      }
      let imported = 0;
      for (const ws of discovered) {
        const ok = await addWorkspace({
          name: ws.name,
          path: ws.path,
          command: ws.command,
          args: ws.args,
          auto_prompt: ws.auto_prompt,
          env: ws.env,
        });
        if (ok) imported++;
      }
      if (imported > 0) {
        setInfoToast(`Imported ${imported} workspace${imported > 1 ? 's' : ''} from Claude Code.`);
      }
    } catch (e) {
      setPtyError(`Import failed: ${String(e)}`);
    }
  }, [addWorkspace]);

  // ---- Auto-dismiss infoToast ----
  useEffect(() => {
    if (!infoToast) return;
    const timer = setTimeout(() => setInfoToast(null), 4000);
    return () => clearTimeout(timer);
  }, [infoToast]);

  // ---- Auto-expand workspaces that have sessions ----
  useEffect(() => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const s of sessions) {
        if (!next.has(s.workspaceId)) {
          next.add(s.workspaceId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  if (loading) {
    return (
      <div className="app-loading">
        Loading workspaces...
      </div>
    );
  }

  return (
    <div className="app">
      {/* ── Title Bar ── */}
      <header
        className="titlebar"
        onDoubleClick={() => {
          getCurrentWindow().toggleMaximize().catch(console.error);
        }}
      >
        <div className="titlebar-left" data-tauri-drag-region>
          <span className="titlebar-icon">⚡</span>
          <span className="titlebar-text">yug-cc-manager</span>
        </div>
        <div className="titlebar-center" data-tauri-drag-region />
        <div className="titlebar-right">
          {/* ── View Toggle ── */}
          <button
            className={`titlebar-btn view-toggle ${view === "performance" ? "active" : ""}`}
            onClick={() => setView("performance")}
            title="Performance Monitor"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <polyline points="2,12 6,8 8,10 14,4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="14" cy="4" r="1.5" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`titlebar-btn view-toggle ${view === "terminal" ? "active" : ""}`}
            onClick={() => setView("terminal")}
            title="Terminal View"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <polyline points="4,10 8,6 4,2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="10" y1="13" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <div className="titlebar-sep" />
          <button
            className="titlebar-btn primary"
            onClick={() => setShowAddDialog(true)}
            title="Add Workspace"
          >
            +
          </button>
          <div className="titlebar-sep" />
          <button
            className="win-btn"
            onClick={() => getCurrentWindow().minimize().catch(console.error)}
            title="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            className="win-btn"
            onClick={() => getCurrentWindow().toggleMaximize().catch(console.error)}
            title="Maximize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1.5" y="1.5" width="7" height="7" rx="0" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className="win-btn win-btn-close"
            onClick={() => getCurrentWindow().close().catch(console.error)}
            title="Close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.2" />
              <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-layout">
        {view === "terminal" ? (
          <>
            <WorkspacePanel
              collapsed={sidebarCollapsed}
              workspaces={workspaces}
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              expandedWorkspaces={expandedWorkspaces}
              onToggleExpand={handleToggleExpand}
              onLaunchSession={handleLaunchSession}
              onStopSession={handleStopSession}
              onSelectSession={handleSelectSession}
              onEdit={setEditingWorkspace}
              onDelete={setConfirmDeleteId}
              onAdd={() => setShowAddDialog(true)}
              onImportClaude={() => setShowImportConfirm(true)}
              onReorder={handleReorder}
            />
            <button
              className={`sidebar-toggle${sidebarCollapsed ? " collapsed" : ""}`}
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                {sidebarCollapsed ? (
                  <polyline points="3,2 7,5 3,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <polyline points="7,2 3,5 7,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
            </button>
            <TerminalPanel
              sessions={sessions}
              groupSessions={activeGroupSessions}
              groups={groups.map((g) => ({
                id: g.id,
                name: g.name,
                count: g.sessionIds.length,
              }))}
              activeGroupId={activeGroupId}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelectSession}
              onSwitchGroup={handleSwitchGroup}
              onCloseSession={handleStopSession}
              onRenameGroup={handleRenameGroup}
              onMoveSessionToGroup={handleMoveSessionToGroup}
              onAddGroup={() => {
                setSelectedSessionId(null);
                setGroups((prev) => {
                  const { id, name } = nextGroupInfo(prev);
                  const newGroup: SessionGroup = { id, name, sessionIds: [] };
                  setActiveGroupId(newGroup.id);
                  return [...prev, newGroup];
                });
              }}
              onDeleteGroup={(gId) => setConfirmDeleteGroupId(gId)}
            />
          </>
        ) : (
          <PerformancePanel sessions={sessions} />
        )}
      </div>

      {error && (
        <div className="app-toast error">
          <span>{error}</span>
          <button onClick={refresh}>Retry</button>
        </div>
      )}

      {ptyError && (
        <div className="app-toast error">
          <span>PTY Error: {ptyError}</span>
          <button onClick={() => setPtyError(null)}>Dismiss</button>
        </div>
      )}

      {infoToast && (
        <div className="app-toast info">
          <span>{infoToast}</span>
          <button onClick={() => setInfoToast(null)}>Dismiss</button>
        </div>
      )}

      {showAddDialog && (
        <AddWorkspaceDialog
          onSave={handleAddSave}
          onCancel={() => setShowAddDialog(false)}
        />
      )}

      {editingWorkspace && (
        <AddWorkspaceDialog
          workspace={editingWorkspace}
          onSave={(ws) => handleEditSave(ws, editingWorkspace.id)}
          onCancel={() => setEditingWorkspace(null)}
        />
      )}

      {confirmDeleteId && (
        <div className="dialog-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Workspace</h2>
            <p className="confirm-text">
              Are you sure you want to delete this workspace?
              {sessions.some((s) => s.workspaceId === confirmDeleteId) &&
                " All running sessions will be terminated."}
            </p>
            <div className="dialog-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteGroupId && (
        <div className="dialog-overlay" onClick={() => setConfirmDeleteGroupId(null)}>
          <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Group</h2>
            <p className="confirm-text">
              Are you sure you want to delete this group?
              {groups.find((g) => g.id === confirmDeleteGroupId)?.sessionIds.length
                ? " All sessions in this group will be terminated."
                : ""}
            </p>
            <div className="dialog-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteGroupId(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleGroupDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showImportConfirm && (
        <div className="dialog-overlay" onClick={() => setShowImportConfirm(false)}>
          <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
            <h2>Import from Claude Code</h2>
            <p className="confirm-text">
              This will scan your Claude Code projects directory
              (<code>~/.claude/projects/</code>) and import any workspaces not
              already in your list. Each workspace will be configured with
              default settings (command: <code>claude</code>).
            </p>
            <div className="dialog-actions">
              <button className="btn-secondary" onClick={() => setShowImportConfirm(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => {
                setShowImportConfirm(false);
                handleImportClaude();
              }}>Import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
