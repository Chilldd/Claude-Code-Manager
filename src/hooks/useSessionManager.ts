import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { api, onPtyTitle, onPtyExit, onPtyOutput, onClaudeAgentsUpdated } from "../api";
import type { Workspace, ClaudeAgentInfo, Ccconfig } from "../api";
import { notifySession } from "../notification";
import type {
  SessionInfo,
  SessionGroup,
  SessionStatus,
} from "../types";
import {
  MAX_GROUP_SIZE,
  nextGroupInfo,
  isPermissionPrompt,
} from "../types";
import { listen } from "@tauri-apps/api/event";

/** Map `claude agents --json` status to frontend SessionStatus */
function mapAgentStatus(info: ClaudeAgentInfo): SessionStatus | undefined {
  switch (info.status) {
    case "busy":
      return "thinking";
    case "idle":
      return "idle";
    case "waiting":
      return "waiting";
    // "running" or unknown — leave existing status unchanged
    default:
      return undefined;
  }
}

/** Whether the agent's "waiting" reason is a real permission request (needs user notification) */
function isAgentPermissionPrompt(waitingFor?: string): boolean {
  if (!waitingFor) return false;
  return waitingFor.toLowerCase().includes("permission");
}

export interface SessionManager {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  groups: SessionGroup[];
  activeGroupId: string;
  expandedWorkspaces: Set<string>;
  activeGroupSessionIds: string[];
  activeGroupSessions: SessionInfo[];

  launchSession: (ws: Workspace, worktreeName?: string, resumeSessionId?: string) => Promise<void>;
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
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  // Notification config — default values applied immediately, async loaded from backend
  const configRef = useRef<Ccconfig>({ notification: { task_complete: false, permission_prompt: true } });

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

  // Listen for PTY title changes — only updates session name, status comes from agent polling
  useEffect(() => {
    const unlisten = onPtyTitle((payload) => {
      const session = sessionsRef.current.find((s) => s.id === payload.session_id);
      if (!session) return;

      setSessions((prev) =>
        prev.map((s) =>
          s.id === payload.session_id
            ? { ...s, name: `[${s.sessionIndex}] ${payload.title}` }
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

      // notifySession hook placeholder — add back when needed
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Listen for real-time agent updates pushed from backend every 500ms
  useEffect(() => {
    const seenInAgent = new Set<string>();
    /// Track whether a session has ever been "busy" or "waiting" since last idle.
    const hadActivity = new Map<string, boolean>();

    const unlisten = onClaudeAgentsUpdated((agents) => {
      const cfg = configRef.current;
      const current = sessionsRef.current;

      for (const session of current) {
        if (session.status === "exited") continue;

        const info = agents[session.id];
        if (!info) {
          // Not found — might have exited (e.g. /exit)
          if (seenInAgent.has(session.id)) {
            seenInAgent.delete(session.id);
            hadActivity.delete(session.id);
            setSessions((prev) =>
              prev.map((s) =>
                s.id === session.id
                  ? { ...s, status: "exited" as const, name: `[${s.sessionIndex}] 已退出` }
                  : s
              )
            );
          }
          continue;
        }
        seenInAgent.add(session.id);

        // Mark activity when agent is busy (actually working, not just waiting for input)
        if (info.status === "busy") {
          hadActivity.set(session.id, true);
        }

        // Update display status
        const newStatus = mapAgentStatus(info);
        if (newStatus && newStatus !== session.status) {
          const next = newStatus;
          setSessions((prev) =>
            prev.map((s) =>
              s.id === session.id ? { ...s, status: next } : s
            )
          );

          // Permission-prompt notification — only when waitingFor indicates a
          // real permission request, not generic "dialog open" or other waits
          if (
            next === "waiting"
            && cfg.notification.permission_prompt
            && isAgentPermissionPrompt(info.waiting_for)
          ) {
            notifySession({
              title: "⚡ 需要授权",
              sessionName: session.name,
              workspaceName: session.workspaceName,
              sessionId: session.id,
              detail: "Claude Code 需要你的授权才能继续执行",
            });
          }
        }

        // Task-complete notification (was active, now idle)
        if (info.status === "idle" && hadActivity.get(session.id)) {
          hadActivity.delete(session.id);
          if (cfg.notification.task_complete) {
            notifySession({
              title: "✅ 任务完成",
              sessionName: session.name,
              workspaceName: session.workspaceName,
              sessionId: session.id,
            });
          }
        }
      }
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

      if (configRef.current.notification.permission_prompt) {
        notifySession({
          title: "⚡ 需要授权",
          sessionName: session.name,
          workspaceName: session.workspaceName,
          sessionId: session.id,
          detail: "Claude Code 需要你的授权才能继续执行",
        });
      }

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

  // Load notification config once on mount
  useEffect(() => {
    api.getConfig().then((cfg) => { configRef.current = cfg; }).catch(() => {});
  }, []);

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
    async (ws: Workspace, worktreeName?: string, resumeSessionId?: string) => {
      const sessionIndex = nextSessionIndex();
      const sessionName = `[${sessionIndex}] ${ws.name}`;
      const sessionId = resumeSessionId ?? crypto.randomUUID();
      api.debugLog(`launchSession: calling createPty sid=${sessionId} cmd=${ws.command} args=${ws.args}`);
      try {
        await api.createPty(
          sessionId,
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

        // Step 3/4: assign session to a group
        // 使用 ref 读取最新 groups，避免 useCallback 闭包捕获过期值
        api.debugLog("launchSession: step3 setGroups");
        const latestGroups = groupsRef.current;
        const currentGroup = latestGroups.find((g) => g.id === activeGroupIdRef.current);
        if (currentGroup && currentGroup.sessionIds.length < MAX_GROUP_SIZE) {
          setGroups((prev) =>
            prev.map((g) =>
              g.id === currentGroup.id
                ? { ...g, sessionIds: [...g.sessionIds, sessionId] }
                : g
            )
          );
        } else {
          const { id, name } = nextGroupInfo(latestGroups);
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
        // notifySession hook placeholder
      }
    },
    [nextSessionIndex]
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
