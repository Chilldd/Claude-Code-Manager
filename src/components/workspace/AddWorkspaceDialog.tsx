import { useState } from "react";
import type { Workspace } from "../../api";

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
        <h2>{workspace ? "编辑工作区" : "添加工作区"}</h2>
        <form onSubmit={handleSubmit}>
          <label>
            名称
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="我的项目"
              autoFocus
              required
            />
          </label>
          <label>
            路径
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="D:\code\my-project"
              required
            />
          </label>
          <label>
            命令
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="claude"
            />
          </label>
          <label>
            参数
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-p --verbose"
            />
          </label>
          <label>
            自动提示
            <textarea
              value={autoPrompt}
              onChange={(e) => setAutoPrompt(e.target.value)}
              placeholder="可选：启动时自动发送提示"
              rows={3}
            />
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="btn-primary">
              {workspace ? "保存" : "添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
