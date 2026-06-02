import type { Workspace } from "../api";

interface Props {
  workspace: Workspace;
  active: boolean;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (ws: Workspace) => void;
}

export function WorkspaceItem({
  workspace,
  active,
  onLaunch,
  onStop,
  onDelete,
  onEdit,
}: Props) {
  return (
    <div className={`workspace-item ${active ? "active" : ""}`}>
      <div className="workspace-info">
        <span className="workspace-name">{workspace.name}</span>
        <span className="workspace-path">{workspace.path}</span>
      </div>
      <div className="workspace-actions">
        {active ? (
          <button
            className="btn-stop"
            onClick={() => onStop(workspace.id)}
            title="Stop"
          >
            ■
          </button>
        ) : (
          <button
            className="btn-launch"
            onClick={() => onLaunch(workspace.id)}
            title="Launch"
          >
            ▶
          </button>
        )}
        <button
          className="btn-edit"
          onClick={() => onEdit(workspace)}
          title="Edit"
        >
          ✎
        </button>
        <button
          className="btn-delete"
          onClick={() => onDelete(workspace.id)}
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
