import type { Workspace } from "../../api";
import { useSession } from "../../contexts/SessionContext";
import { cn } from "../../utils/cn";
import { WorkspaceRow } from "./WorkspaceRow";
import styles from "./WorkspacePanel.module.css";

interface Props {
  collapsed?: boolean;
  workspaces: Workspace[];
  onLaunchSession: (ws: Workspace) => void;
  onLaunchWorktree: (ws: Workspace) => void;
  onResumeSession: (ws: Workspace, sessionId: string) => void;
  onEdit: (ws: Workspace) => void;
  onDelete: (workspaceId: string) => void;
  onOpenInExplorer: (ws: Workspace) => void;
  onAdd: () => void;
  onImportClaude?: () => void;
  onReorder?: (workspaceId: string, direction: "up" | "down") => void;
}

export function WorkspacePanel({
  collapsed = false,
  workspaces,
  onLaunchSession,
  onLaunchWorktree,
  onResumeSession,
  onEdit,
  onDelete,
  onOpenInExplorer,
  onAdd,
  onImportClaude,
  onReorder,
}: Props) {
  const {
    sessions,
    selectedSessionId,
    expandedWorkspaces,
    toggleExpand,
    stopSession,
    selectSession,
  } = useSession();

  return (
    <div className={cn(styles.panel, collapsed && styles.collapsed)}>
      <div className={styles.header}>
        <h1>工作区</h1>
        <div className={styles.headerActions}>
          {onImportClaude && (
            <button
              className={styles.headerBtn}
              onClick={onImportClaude}
              title="从 Claude Code 导入工作区"
            >
              CC
            </button>
          )}
          <button
            className={cn(styles.headerBtn, styles.primary)}
            onClick={onAdd}
            title="添加工作区"
          >
            +
          </button>
        </div>
      </div>
      <div className={styles.workspaceList}>
        {workspaces.length === 0 ? (
          <p className={styles.emptyHint}>
            暂无工作区。
            <br />
            点击 <strong>+</strong> 添加
          </p>
        ) : (
          workspaces.map((ws, idx) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              sessions={sessions}
              idx={idx}
              totalCount={workspaces.length}
              isExpanded={expandedWorkspaces.has(ws.id)}
              selectedSessionId={selectedSessionId}
              onToggleExpand={() => toggleExpand(ws.id)}
              onLaunchSession={() => onLaunchSession(ws)}
              onLaunchWorktree={() => onLaunchWorktree(ws)}
              onResumeSession={(sid) => onResumeSession(ws, sid)}
              onStopSession={stopSession}
              onSelectSession={selectSession}
              onEdit={() => onEdit(ws)}
              onDelete={() => onDelete(ws.id)}
              onOpenInExplorer={() => onOpenInExplorer(ws)}
              onReorder={
                onReorder
                  ? (dir) => onReorder(ws.id, dir)
                  : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
