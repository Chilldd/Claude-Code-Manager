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
      unlisten.then((fn) => fn());
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
      unlisten.then((fn) => fn());
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
          const { id, name } = nextGroupInfo(prev);
          const newGroup: SessionGroup = { id, name, sessionIds: [sessionId] };
          setActiveGroupId(newGroup.id);
          return [...prev, newGroup];
        });
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

    // Determine next selection before state updates
    let nextSelectedId: string | null = null;
    if (selectedSessionId === sessionId) {
      const activeGroup = groups.find((g) => g.id === activeGroupId);
      const remaining = activeGroup?.sessionIds.filter((id) => id !== sessionId) ?? [];
      if (remaining.length > 0) {
        nextSelectedId = remaining[0];
      }
    }

    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setSelectedSessionId((prev) => (prev === sessionId ? nextSelectedId : prev));

    setGroups((prev) => {
      let updated = prev
        .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) }))
        .filter((g) => g.sessionIds.length > 0);
      if (!updated.some((g) => g.id === activeGroupId)) {
        // Active group is gone — switch to the first remaining group
        if (updated.length > 0) {
          setActiveGroupId(updated[0].id);
          // If we didn't already pick a next session, select the first of the new group
          if (nextSelectedId === null && updated[0].sessionIds.length > 0) {
            setSelectedSessionId(updated[0].sessionIds[0]);
          }
        } else {
          const fresh: SessionGroup = { id: 'g1', name: 'Group 1', sessionIds: [] };
          setActiveGroupId(fresh.id);
          updated = [fresh];
        }
      }
      return updated;
    });
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
    setGroups((prev) => {
      const src = prev.find((g) => g.sessionIds.includes(sessionId));
      const tgt = prev.find((g) => g.id === targetGroupId);
      if (!src || !tgt || src.id === tgt.id) return prev;
      if (tgt.sessionIds.length >= MAX_GROUP_SIZE) return prev;
      return prev.map((g) => {
        if (g.id === src.id) return { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) };
        if (g.id === targetGroupId) return { ...g, sessionIds: [...g.sessionIds, sessionId] };
        return g;
      });
    });
  }, []);

  const addGroup = useCallback(() => {
    setSelectedSessionId(null);
    setGroups((prev) => {
      const { id, name } = nextGroupInfo(prev);
      const newGroup: SessionGroup = { id, name, sessionIds: [] };
      setActiveGroupId(newGroup.id);
      return [...prev, newGroup];
    });
  }, []);

  const deleteGroup = useCallback((groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      const ids = group.sessionIds;
      for (const sid of ids) {
        api.killPty(sid).catch(() => {});
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
        // Select the first session of the new active group
        if (updated[0].sessionIds.length > 0) {
          setSelectedSessionId(updated[0].sessionIds[0]);
        }
      }
      return updated;
    });
  }, [groups, activeGroupId]);

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
