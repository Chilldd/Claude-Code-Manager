import type { Workspace } from "../api";
import { useSession } from "../contexts/SessionContext";
import { cn } from "../utils/cn";
import { WorkspaceRow } from "./WorkspaceRow";
import styles from "./WorkspacePanel.module.css";

interface Props {
  collapsed?: boolean;
  workspaces: Workspace[];
  onLaunchSession: (ws: Workspace) => void;
  onEdit: (ws: Workspace) => void;
  onDelete: (workspaceId: string) => void;
  onAdd: () => void;
  onImportClaude?: () => void;
  onReorder?: (workspaceId: string, direction: "up" | "down") => void;
}

export function WorkspacePanel({
  collapsed = false,
  workspaces,
  onLaunchSession,
  onEdit,
  onDelete,
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
        <h1>Workspaces</h1>
        <div className={styles.headerActions}>
          {onImportClaude && (
            <button
              className={styles.headerBtn}
              onClick={onImportClaude}
              title="Import workspaces from Claude Code"
            >
              CC
            </button>
          )}
          <button
            className={cn(styles.headerBtn, styles.primary)}
            onClick={onAdd}
            title="Add Workspace"
          >
            +
          </button>
        </div>
      </div>
      <div className={styles.workspaceList}>
        {workspaces.length === 0 ? (
          <p className={styles.emptyHint}>
            No workspaces yet.
            <br />
            Click <strong>+</strong> to add one.
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
              onStopSession={stopSession}
              onSelectSession={selectSession}
              onEdit={() => onEdit(ws)}
              onDelete={() => onDelete(ws.id)}
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
