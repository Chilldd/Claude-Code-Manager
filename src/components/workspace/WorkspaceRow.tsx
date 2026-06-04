import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../../api";
import type { Workspace } from "../../api";
import type { SessionInfo } from "../../types";
import { cn } from "../../utils/cn";
import styles from "./WorkspacePanel.module.css";

interface Props {
  workspace: Workspace;
  sessions: SessionInfo[];
  idx: number;
  totalCount: number;
  isExpanded: boolean;
  selectedSessionId: string | null;
  onToggleExpand: () => void;
  onLaunchSession: () => void;
  onLaunchWorktree: () => void;
  onResumeSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenInExplorer?: () => void;
  onReorder?: (direction: "up" | "down") => void;
}

export function WorkspaceRow({
  workspace,
  sessions,
  idx,
  totalCount,
  isExpanded,
  selectedSessionId,
  onToggleExpand,
  onLaunchSession,
  onLaunchWorktree,
  onResumeSession,
  onStopSession,
  onSelectSession,
  onEdit,
  onDelete,
  onOpenInExplorer,
  onReorder,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen, closeMenu]);

  const wsSessions = sessions.filter((s) => s.workspaceId === workspace.id);

  // ── Recent session history from Claude Code project files ──
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recentSessions, setRecentSessions] = useState<{ session_id: string; last_modified: number }[] | null>(null);

  useEffect(() => {
    if (!isExpanded) return;
    let cancelled = false;
    api.getRecentSessions(workspace.path).then((data) => {
      if (!cancelled) setRecentSessions(data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isExpanded, workspace.path]);

  const historySessions = (recentSessions ?? []).filter(
    (h) => !sessions.some((s) => s.workspaceId === workspace.id && s.name.includes(h.session_id))
  );

  function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  return (
    <div className={styles.workspaceGroup}>
      {/* Workspace header row */}
      <div className={styles.workspaceItem}>
        <button
          className={styles.expandBtn}
          onClick={onToggleExpand}
          title={isExpanded ? "收起" : "展开"}
        >
          {isExpanded ? "▼" : "▶"}
        </button>
        <div
          className={styles.workspaceInfo}
          onClick={onToggleExpand}
          style={{ cursor: "pointer" }}
        >
          <span className={styles.workspaceName}>
            {wsSessions.some((s) => s.status === "running") && (
              <span className={styles.indicator} />
            )}
            {workspace.name}
          </span>
          <span className={styles.workspacePath}>{workspace.path}</span>
        </div>
        <div className={styles.workspaceActions}>
          <button
            className={styles.btnNewSession}
            onClick={onLaunchSession}
            title="新建会话"
          >
            +
          </button>
          <button
            className={styles.btnWorktree}
            onClick={onLaunchWorktree}
            title="启动 Worktree 会话"
          >
            🌿
          </button>
          <div className={styles.workspaceMenuWrapper}>
            <button
              className={styles.btnMore}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
              title="更多操作"
            >
              ⋯
            </button>
            {menuOpen && (
              <div ref={menuRef} className={styles.workspaceMenu} onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { onEdit(); closeMenu(); }}>
                  <span className={styles.menuIcon}>✎</span>
                  编辑
                </button>
                {onReorder && totalCount > 1 && (
                  <>
                    <button
                      onClick={() => { onReorder("up"); closeMenu(); }}
                      disabled={idx === 0}
                    >
                      <span className={styles.menuIcon}>▲</span>
                      上移
                    </button>
                    <button
                      onClick={() => { onReorder("down"); closeMenu(); }}
                      disabled={idx === totalCount - 1}
                    >
                      <span className={styles.menuIcon}>▼</span>
                      下移
                    </button>
                  </>
                )}
                {onOpenInExplorer && (
                  <button onClick={() => { onOpenInExplorer(); closeMenu(); }}>
                    <span className={styles.menuIcon}>📂</span>
                    打开所在目录
                  </button>
                )}
                <div className={styles.workspaceMenuSep} />
                <button
                  className={styles.danger}
                  onClick={() => { onDelete(); closeMenu(); }}
                >
                  <span className={styles.menuIcon}>✕</span>
                  删除
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session sub-list (expanded) — history above current sessions */}
      {isExpanded && (
        <div className={styles.sessionList}>
          {/* ── History sessions ── */}
          {historySessions.length > 0 && (
            <>
              <div
                className={styles.historyHeader}
                onClick={() => setHistoryOpen(!historyOpen)}
              >
                <span className={styles.historyArrow}>{historyOpen ? "▼" : "▶"}</span>
                历史会话
                <span className={styles.historyCount}>{historySessions.length}</span>
              </div>
              {historyOpen && historySessions.map((h) => (
                <div
                  key={h.session_id}
                  className={styles.historyItem}
                  onClick={() => onResumeSession(h.session_id)}
                  title="恢复此会话"
                >
                  <span className={styles.historyIcon}>↻</span>
                  <span className={styles.historyName}>{workspace.name}</span>
                  <span className={styles.historyTime}>{formatRelativeTime(h.last_modified)}</span>
                </div>
              ))}
              <div className={styles.historySep} />
            </>
          )}

          {wsSessions.length === 0 && (
            <div className={styles.sessionEmpty}>
              暂无会话。点击 <strong>+</strong> 启动
            </div>
          )}
          {wsSessions.map((session) => (
            <div
              key={session.id}
              className={cn(styles.sessionItem, session.id === selectedSessionId && styles.selected)}
              onClick={() => onSelectSession(session.id)}
              data-tooltip={session.worktreeName ? `Worktree: ${session.worktreeName}` : undefined}
            >
              <span
                className={`${styles.sessionIndicator} ${styles[session.status as keyof typeof styles] || ''}`}
              />
              {session.worktreeName && <span style={{ fontSize: 11, marginRight: 2 }}>🌿</span>}
              <span className={styles.sessionName}>{session.name}</span>
              <button
                className={styles.sessionStop}
                onClick={(e) => {
                  e.stopPropagation();
                  onStopSession(session.id);
                }}
                title="停止会话"
              >
                ■
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
