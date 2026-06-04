import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { api, onPtyTitle, onPtyExit, onPtyOutput } from "../api";
import type { Workspace } from "../api";
import type {
  SessionInfo,
  SessionGroup,
  SessionStatus,
} from "../types";
import {
  MAX_GROUP_SIZE,
  nextGroupInfo,
  inferStatus,
  isPermissionPrompt,
} from "../types";
import { notifySession } from "../notification";
import { listen } from "@tauri-apps/api/event";

export interface SessionManager {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  groups: SessionGroup[];
  activeGroupId: string;
  expandedWorkspaces: Set<string>;
  activeGroupSessionIds: string[];
  activeGroupSessions: SessionInfo[];

  launchSession: (ws: Workspace, worktreeName?: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  toggleExpand: (workspaceId: string) => void;
  switchGroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  moveSessionToGroup: (sessionId: string, targetGroupId: string) => void;
  addGroup: () => void;
  deleteGroup: (groupId: string) => void;
}

export function useSessionManager(): SessionManager {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<SessionGroup[]>([
    { id: 'g1', name: 'Group 1', sessionIds: [] },
  ]);
  const [activeGroupId, setActiveGroupId] = useState<string>("g1");
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  // Module-level mutable counter becomes a ref
  const sessionCounterRef = useRef(0);
  const nextSessionIndex = useCallback(() => {
    sessionCounterRef.current += 1;
    return sessionCounterRef.current;
  }, []);

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
      // Read session from ref (latest committed state) to determine transition
      const session = sessionsRef.current.find((s) => s.id === payload.session_id);
      if (!session) return;

      const newStatus = inferStatus(payload.title);
      const oldStatus = prevStatusMap.get(payload.session_id);
      prevStatusMap.set(payload.session_id, newStatus); // <-- side effect, ok outside updater

      // Task complete: thinking → idle → fire system notification
      if (oldStatus === "thinking" && newStatus === "idle") {
        notifySession({                                // <-- side effect, ok outside updater
          title: "✅ Task Complete",
          sessionName: session.name,
          workspaceName: session.workspaceName,
          sessionId: session.id,
        });
        setSessions((prev) =>
          prev.map((s) =>
            s.id === payload.session_id
              ? { ...s, name: `[${s.sessionIndex}] ${payload.title}`, status: "attention" as const }
              : s
          )
        );
        return;
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === payload.session_id
            ? { ...s, name: `[${s.sessionIndex}] ${payload.title}`, status: newStatus }
            : s
        )
      );
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for PTY exit events — notify on abnormal exit
  useEffect(() => {
    const unlisten = onPtyExit((payload) => {
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
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for PTY output — detect permission prompts from Claude Code
  useEffect(() => {
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

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? { ...s, status: "attention" as const }
            : s
        )
      );
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for session-deeplink events
  useEffect(() => {
    const unlisten = listen<{ session_id: string }>("session-deeplink", (event) => {
      const sid = event.payload.session_id;
      if (!sid) return;
      setSelectedSessionId(sid);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid && s.status === "attention"
            ? { ...s, status: "idle" as const }
            : s
        )
      );
      setGroups((prev) => {
        const g = prev.find((g) => g.sessionIds.includes(sid));
        if (g) setActiveGroupId(g.id);
        return prev;
      });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Auto-expand workspaces that have sessions
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

  // ── Callbacks ──

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId && s.status === "attention"
          ? { ...s, status: "idle" as const }
          : s
      )
    );
    setGroups((prev) => {
      const g = prev.find((g) => g.sessionIds.includes(sessionId));
      if (g) setActiveGroupId(g.id);
      return prev;
    });
  }, []);

  const toggleExpand = useCallback((workspaceId: string) => {
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

  const launchSession = useCallback(
    async (ws: Workspace, worktreeName?: string) => {
      const sessionIndex = nextSessionIndex();
      const sessionName = `[${sessionIndex}] ${ws.name}`;
      api.debugLog(`launchSession: calling createPty cmd=${ws.command} args=${ws.args}`);
      try {
        const sessionId = await api.createPty(
          ws.id,
          sessionName,
          ws.command,
          ws.args,
          ws.path,
          ws.env
        );
        api.debugLog(`launchSession: createPty OK sid=${sessionId}`);

        // Step 1/4: add session to state
        api.debugLog("launchSession: step1 setSessions");
        setSessions((prev) => [
          ...prev,
          {
            id: sessionId,
            workspaceId: ws.id,
            workspaceName: ws.name,
            name: sessionName,
            sessionIndex,
            status: "running" as const,
            worktreeName,
          },
        ]);
        api.debugLog("launchSession: step1 setSessions done");

        api.debugLog("launchSession: step2 setSelectedSessionId");
        setSelectedSessionId(sessionId);
        api.debugLog("launchSession: step2 done");

        api.debugLog("launchSession: step3 setGroups");
        // Read the latest active group via ref — user may have switched groups during the await
        const currentGroup = groups.find((g) => g.id === activeGroupIdRef.current);
        const effectiveGroupId = activeGroupIdRef.current;
        if (currentGroup && currentGroup.sessionIds.length < MAX_GROUP_SIZE) {
          setGroups((prev) =>
            prev.map((g) =>
              g.id === effectiveGroupId
                ? { ...g, sessionIds: [...g.sessionIds, sessionId] }
                : g
            )
          );
        } else {
          const { id, name } = nextGroupInfo(groups);
          setGroups((prev) => [...prev, { id, name, sessionIds: [sessionId] }]);
          setActiveGroupId(id);
        }
        api.debugLog("launchSession: step3 setGroups done");

        if (ws.auto_prompt) {
          setTimeout(() => {
            api.writePty(sessionId, ws.auto_prompt + "\n").catch(() => {});
          }, 1500);
        }
        api.debugLog("launchSession: ALL STEPS COMPLETE");
      } catch (e) {
        api.debugLog(`launchSession CAUGHT: ${e}`);
        notifySession({
          title: "❌ Launch Error",
          sessionName: sessionName,
          workspaceName: ws.name,
          detail: String(e),
        });
      }
    },
    [activeGroupId, nextSessionIndex]
  );

  const stopSession = useCallback(async (sessionId: string) => {
    try {
      await api.killPty(sessionId);
    } catch { /* ignore */ }

    // Compute what happens to groups when this session is removed
    const remainingGroups = groups
      .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }))
      .filter((g) => g.sessionIds.length > 0);
    const activeGroupDestroyed = !remainingGroups.some((g) => g.id === activeGroupId);

    // Determine the final selected session ID (single call, no double-write)
    let finalSelectedId: string | null;
    if (selectedSessionId === sessionId) {
      // The selected session is being removed
      if (activeGroupDestroyed && remainingGroups.length > 0) {
        // The active group is gone too — pick fallback group's first session
        finalSelectedId = remainingGroups[0].sessionIds[0] ?? null;
      } else if (!activeGroupDestroyed) {
        // Same group still exists — pick the next sibling
        const activeGroup = groups.find((g) => g.id === activeGroupId);
        const remaining = activeGroup?.sessionIds.filter((id) => id !== sessionId) ?? [];
        finalSelectedId = remaining.length > 0 ? remaining[0] : null;
      } else {
        finalSelectedId = null;
      }
    } else {
      finalSelectedId = selectedSessionId;
    }

    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setSelectedSessionId(finalSelectedId);

    // Handle fallback if active group is gone
    if (activeGroupDestroyed) {
      if (remainingGroups.length > 0) {
        setActiveGroupId(remainingGroups[0].id);
        setGroups(remainingGroups);
      } else {
        setActiveGroupId('g1');
        setGroups([{ id: 'g1', name: 'Group 1', sessionIds: [] }]);
      }
    } else {
      // Apply groups state via updater (fresh computation from latest committed state)
      setGroups((prev) => {
        const filtered = prev
          .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }))
          .filter((g) => g.sessionIds.length > 0);
        if (filtered.length > 0) return filtered;
        return [{ id: 'g1', name: 'Group 1', sessionIds: [] }];
      });
    }
  }, [activeGroupId, groups, selectedSessionId]);

  const switchGroup = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    const group = groups.find((g) => g.id === groupId);
    if (group && group.sessionIds.length > 0 && !group.sessionIds.includes(selectedSessionId ?? '')) {
      setSelectedSessionId(group.sessionIds[0]);
    }
  }, [groups, selectedSessionId]);

  const renameGroup = useCallback((groupId: string, name: string) => {
    setGroups((prev) => {
      if (prev.some((g) => g.id !== groupId && g.name === name)) return prev;
      return prev.map((g) => (g.id === groupId ? { ...g, name } : g));
    });
  }, []);

  const moveSessionToGroup = useCallback((sessionId: string, targetGroupId: string) => {
    const src = groups.find((g) => g.sessionIds.includes(sessionId));
    const tgt = groups.find((g) => g.id === targetGroupId);
    if (!src || !tgt || src.id === tgt.id) return;
    if (tgt.sessionIds.length >= MAX_GROUP_SIZE) return;

    setGroups((prev) => prev.map((g) => {
      if (g.id === src.id) return { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) };
      if (g.id === targetGroupId) return { ...g, sessionIds: [...g.sessionIds, sessionId] };
      return g;
    }));

    // If the moved session was selected and is leaving the active group, select a sibling
    if (sessionId === selectedSessionId && src.id === activeGroupId) {
      const remaining = src.sessionIds.filter((id) => id !== sessionId);
      if (remaining.length > 0) {
        setSelectedSessionId(remaining[0]);
      } else {
        setSelectedSessionId(null);
      }
    }
  }, [groups, activeGroupId, selectedSessionId]);

  const addGroup = useCallback(() => {
    const { id, name } = nextGroupInfo(groups);
    setSelectedSessionId(null);
    setGroups((prev) => [...prev, { id, name, sessionIds: [] }]);
    setActiveGroupId(id);
  }, [groups]);

  const deleteGroup = useCallback((groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      const ids = group.sessionIds;
      for (const sid of ids) {
        api.killPty(sid).catch(() => {});
      }
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
    }

    const sessionInDeletedGroup = group?.sessionIds.includes(selectedSessionId ?? '') ?? false;
    const remainingGroups = groups.filter((g) => g.id !== groupId);
    const activeGroupDeleted = group?.id === activeGroupId;

    if (remainingGroups.length === 0) {
      setGroups([{ id: 'g1', name: 'Group 1', sessionIds: [] }]);
      setActiveGroupId('g1');
      setSelectedSessionId(sessionInDeletedGroup ? null : selectedSessionId);
    } else {
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      if (activeGroupDeleted) {
        setActiveGroupId(remainingGroups[0].id);
        setSelectedSessionId(
          remainingGroups[0].sessionIds.length > 0
            ? remainingGroups[0].sessionIds[0]
            : (sessionInDeletedGroup ? null : selectedSessionId)
        );
      } else if (sessionInDeletedGroup) {
        setSelectedSessionId(null);
      }
    }
  }, [groups, activeGroupId, selectedSessionId]);

  return {
    sessions,
    selectedSessionId,
    groups,
    activeGroupId,
    expandedWorkspaces,
    activeGroupSessionIds,
    activeGroupSessions,
    launchSession,
    stopSession,
    selectSession,
    toggleExpand,
    switchGroup,
    renameGroup,
    moveSessionToGroup,
    addGroup,
    deleteGroup,
  };
}
