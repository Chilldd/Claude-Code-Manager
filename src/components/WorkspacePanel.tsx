import { useState, useRef, useCallback, useEffect } from "react";
import type { Workspace } from "../api";
import type { SessionInfo } from "../App";

interface Props {
  collapsed?: boolean;
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
  onImportClaude?: () => void;
  onReorder?: (workspaceId: string, direction: "up" | "down") => void;
}

export function WorkspacePanel({
  collapsed = false,
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
  onImportClaude,
  onReorder,
}: Props) {
  const [menuWsId, setMenuWsId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside click
  const closeMenu = useCallback(() => setMenuWsId(null), []);
  useEffect(() => {
    if (!menuWsId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuWsId, closeMenu]);

  return (
    <div className={`workspace-panel${collapsed ? " collapsed" : ""}`}>
      <div className="workspace-header">
        <h1>Workspaces</h1>
        <div className="workspace-header-actions">
          {onImportClaude && (
            <button
              className="workspace-header-btn"
              onClick={onImportClaude}
              title="Import workspaces from Claude Code"
            >
              CC
            </button>
          )}
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
          workspaces.map((ws, idx) => {
            const isExpanded = expandedWorkspaces.has(ws.id);
            const wsSessions = sessions.filter((s) => s.workspaceId === ws.id);
            const isMenuOpen = menuWsId === ws.id;
            return (
              <div key={ws.id} className="workspace-group" data-animation-index={idx > 20 ? "20+" : idx}>
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
                    {/* More actions menu */}
                    <div className="workspace-menu-wrapper">
                      <button
                        className="btn-more"
                        onClick={(e) => { e.stopPropagation(); setMenuWsId(isMenuOpen ? null : ws.id); }}
                        title="More actions"
                      >
                        ⋯
                      </button>
                      {isMenuOpen && (
                        <div ref={menuRef} className="workspace-menu" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => { onEdit(ws); closeMenu(); }}>
                            ✎ Edit
                          </button>
                          {onReorder && workspaces.length > 1 && (
                            <>
                              <button
                                onClick={() => { onReorder(ws.id, "up"); closeMenu(); }}
                                disabled={idx === 0}
                              >
                                ▲ Move up
                              </button>
                              <button
                                onClick={() => { onReorder(ws.id, "down"); closeMenu(); }}
                                disabled={idx === workspaces.length - 1}
                              >
                                ▼ Move down
                              </button>
                            </>
                          )}
                          <div className="workspace-menu-sep" />
                          <button
                            className="danger"
                            onClick={() => { onDelete(ws.id); closeMenu(); }}
                          >
                            ✕ Delete
                          </button>
                        </div>
                      )}
                    </div>
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
