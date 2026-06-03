import { useRef } from "react";
import type { SessionInfo } from "../../types";
import { cn } from "../../utils/cn";
import styles from "./TerminalPanel.module.css";

interface Props {
  sessions: SessionInfo[];
  activeGroupId: string;
  selectedSessionId: string | null;
  splitMode: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onToggleSplitMode: () => void;
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  splitMode,
  onSelectSession,
  onCloseSession,
  onToggleSplitMode,
}: Props) {
  const dragSessionIdRef = useRef<string | null>(null);

  return (
    <div className={styles.terminalTabs}>
      {sessions.length > 1 && (
        <button
          className={cn(styles.splitToggle, splitMode && styles.active)}
          onClick={onToggleSplitMode}
          title={splitMode ? "单屏模式" : "分屏模式"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            {splitMode ? (
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            ) : (
              <>
                <rect x="1.5" y="1.5" width="4.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="8" y="1.5" width="4.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
              </>
            )}
          </svg>
        </button>
      )}
      {sessions.map((session) => (
        <div
          key={session.id}
          className={cn(styles.terminalTab, session.id === selectedSessionId && styles.active)}
          onClick={() => onSelectSession(session.id)}
          data-tooltip={session.worktreeName ? `Worktree: ${session.worktreeName}` : undefined}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', session.id);
            dragSessionIdRef.current = session.id;
          }}
          onDragEnd={() => { dragSessionIdRef.current = null; }}
        >
          <span className={`${styles.tabIndicator} ${styles[session.status as keyof typeof styles] || ''}`} />
          <span className={styles.tabLabel}>
            {session.worktreeName && (
              <span style={{ marginRight: 3, fontSize: 10 }}>🌿</span>
            )}
            {session.name}
          </span>
          <button
            className={styles.tabClose}
            onClick={(e) => {
              e.stopPropagation();
              onCloseSession(session.id);
            }}
            title="关闭会话"
          >
            <svg width="8" height="8" viewBox="0 0 8 8">
              <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
