import { useState, useRef, useCallback, useEffect } from "react";
import type { Workspace } from "../api";
import type { SessionInfo } from "../types";
import { cn } from "../utils/cn";
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
  onStopSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
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
  onStopSession,
  onSelectSession,
  onEdit,
  onDelete,
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
                  ✎ 编辑
                </button>
                {onReorder && totalCount > 1 && (
                  <>
                    <button
                      onClick={() => { onReorder("up"); closeMenu(); }}
                      disabled={idx === 0}
                    >
                      ▲ 上移
                    </button>
                    <button
                      onClick={() => { onReorder("down"); closeMenu(); }}
                      disabled={idx === totalCount - 1}
                    >
                      ▼ 下移
                    </button>
                  </>
                )}
                <div className={styles.workspaceMenuSep} />
                <button
                  className={styles.danger}
                  onClick={() => { onDelete(); closeMenu(); }}
                >
                  ✕ 删除
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session sub-list (expanded) */}
      {isExpanded && (
        <div className={styles.sessionList}>
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
            >
              <span
                className={`${styles.sessionIndicator} ${styles[session.status as keyof typeof styles] || ''}`}
              />
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
