import type { Workspace } from "../api";
import type { SessionInfo } from "../App";

interface Props {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  expandedWorkspaces: Set<string>;
  onToggleExpand: (workspaceId: string) => void;
  onLaunchSession: (ws: Workspace) => void;
  onStopSession: (sessionId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onEdit: (ws: Workspace) => void;
  onDelete: (workspaceId: string) => void;
  onAdd: () => void;
}

export function WorkspacePanel({
  workspaces,
  sessions,
  selectedSessionId,
  expandedWorkspaces,
  onToggleExpand,
  onLaunchSession,
  onStopSession,
  onSelectSession,
  onEdit,
  onDelete,
  onAdd,
}: Props) {
  return (
    <div className="workspace-panel">
      <div className="workspace-header">
        <h1>Workspaces</h1>
        <div className="workspace-header-actions">
          <button
            className="workspace-header-btn primary"
            onClick={onAdd}
            title="Add Workspace"
          >
            +
          </button>
        </div>
      </div>
      <div className="workspace-list">
        {workspaces.length === 0 ? (
          <p className="empty-hint">
            No workspaces yet.
            <br />
            Click <strong>+</strong> to add one.
          </p>
        ) : (
          workspaces.map((ws) => {
            const isExpanded = expandedWorkspaces.has(ws.id);
            const wsSessions = sessions.filter((s) => s.workspaceId === ws.id);
            return (
              <div key={ws.id} className="workspace-group">
                {/* Workspace header row */}
                <div className="workspace-item">
                  <button
                    className="workspace-expand-btn"
                    onClick={() => onToggleExpand(ws.id)}
                    title={isExpanded ? "Collapse" : "Expand"}
                  >
                    {isExpanded ? "▼" : "▶"}
                  </button>
                  <div
                    className="workspace-info"
                    onClick={() => onToggleExpand(ws.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <span className="workspace-name">
                      {wsSessions.some((s) => s.status === "running") && (
                        <span className="indicator" />
                      )}
                      {ws.name}
                    </span>
                    <span className="workspace-path">{ws.path}</span>
                  </div>
                  <div className="workspace-actions">
                    <button
                      className="btn-new-session"
                      onClick={() => onLaunchSession(ws)}
                      title="New session"
                    >
                      +
                    </button>
                    <button
                      className="btn-edit"
                      onClick={() => onEdit(ws)}
                      title="Edit workspace"
                    >
                      ✎
                    </button>
                    <button
                      className="btn-delete"
                      onClick={() => onDelete(ws.id)}
                      title="Delete workspace"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Session sub-list (expanded) */}
                {isExpanded && (
                  <div className="session-list">
                    {wsSessions.length === 0 && (
                      <div className="session-empty">
                        No sessions. Click <strong>+</strong> to launch one.
                      </div>
                    )}
                    {wsSessions.map((session) => (
                      <div
                        key={session.id}
                        className={`session-item ${session.id === selectedSessionId ? "selected" : ""}`}
                        onClick={() => onSelectSession(session.id)}
                      >
                        <span
                          className={`session-indicator ${session.status}`}
                        />
                        <span className="session-name">{session.name}</span>
                        <button
                          className="session-stop"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopSession(session.id);
                          }}
                          title="Stop session"
                        >
                          ■
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
