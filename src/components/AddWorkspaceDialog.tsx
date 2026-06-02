import { useState } from "react";
import type { Workspace } from "../api";

interface Props {
  workspace?: Workspace;            // if provided, we're editing
  onSave: (ws: Omit<Workspace, "id">) => void;
  onCancel: () => void;
}

export function AddWorkspaceDialog({ workspace, onSave, onCancel }: Props) {
  const [name, setName] = useState(workspace?.name ?? "");
  const [path, setPath] = useState(workspace?.path ?? "");
  const [command, setCommand] = useState(workspace?.command ?? "claude");
  const [args, setArgs] = useState(workspace?.args ?? "");
  const [autoPrompt, setAutoPrompt] = useState(workspace?.auto_prompt ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    onSave({
      name: name.trim(),
      path: path.trim(),
      command: command.trim() || "claude",
      args,
      auto_prompt: autoPrompt,
      env: {},
    });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{workspace ? "Edit Workspace" : "Add Workspace"}</h2>
        <form onSubmit={handleSubmit}>
          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              autoFocus
              required
            />
          </label>
          <label>
            Path
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:\code\my-project"
              required
            />
          </label>
          <label>
            Command
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="claude"
            />
          </label>
          <label>
            Args
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-p --verbose"
            />
          </label>
          <label>
            Auto Prompt
            <textarea
              value={autoPrompt}
              onChange={(e) => setAutoPrompt(e.target.value)}
              placeholder="Optional: auto-send prompt on launch"
              rows={3}
            />
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {workspace ? "Save" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
