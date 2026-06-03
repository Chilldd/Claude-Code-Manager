import { useState, useEffect } from "react";
import { api } from "../../api";
import styles from "./WorktreeDialog.module.css";

interface WorktreeInfo {
  name: string;
  path: string;
  active: boolean;
}

interface Props {
  /** Workspace path to scan for existing worktrees */
  path: string;
  onConfirm: (worktreeName: string) => void;
  onCancel: () => void;
}

export function WorktreeDialog({ path, onConfirm, onCancel }: Props) {
  const [name, setName] = useState("");
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.scanWorktrees(path).then((list) => {
      if (cancelled) return;
      setWorktrees(list);
      setLoading(false);
    }).catch((e: string) => {
      if (cancelled) return;
      setError(String(e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [path]);

  // Claude Code replaces "/" in worktree names with "+" internally,
  // but "+" is invalid for git worktree names. Replace "/" with "-"
  // proactively to avoid launch failures.
  const sanitize = (raw: string) => raw.replace(/[/+]/g, "-");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onConfirm(sanitize(name.trim()));
  };

  const handleLaunch = (worktreeName: string) => {
    setLaunching(worktreeName);
    onConfirm(sanitize(worktreeName));
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>启动 Worktree 会话</h2>

        {/* Existing worktrees */}
        {loading && <p className={styles.loading}>扫描现有 worktree…</p>}

        {error && (
          <p className={styles.loading} style={{ fontStyle: "normal", color: "var(--text-muted)" }}>
            {error}
          </p>
        )}

        {!loading && !error && worktrees.length === 0 && (
          <p className={styles.emptyHint}>暂未发现现有 worktree</p>
        )}

        {!loading && !error && worktrees.filter((wt) => wt.active).length > 0 && (
          <>
            <p className={styles.sectionTitle}>已有 Worktree</p>
            <div className={styles.worktreeList}>
              {worktrees.filter((wt) => wt.active).map((wt) => (
                <div key={wt.name} className={styles.worktreeRow}>
                  <span className={styles.worktreeName}>{wt.name}</span>
                  <button
                    type="button"
                    className={styles.worktreeBtn}
                    onClick={() => handleLaunch(wt.name)}
                    disabled={launching === wt.name}
                  >
                    {launching === wt.name ? "启动中…" : "启动"}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && !error && worktrees.filter((wt) => !wt.active).length > 0 && (
          <>
            <p className={styles.sectionTitle} style={{ marginTop: worktrees.filter((wt) => wt.active).length > 0 ? 12 : 0 }}>残留目录（无实际 worktree）</p>
            <div className={styles.worktreeList}>
              {worktrees.filter((wt) => !wt.active).map((wt) => (
                <div key={wt.name} className={styles.worktreeRow}>
                  <span className={styles.worktreeName} style={{ color: "var(--text-muted)" }}>{wt.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>已失效</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className={styles.divider} />

        {/* New worktree input */}
        <p className={styles.newLabel}>创建新的 Worktree</p>
        <form onSubmit={handleSubmit}>
          <label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：feature/new-branch"
              autoFocus
              required
            />
          </label>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
            将在工作区目录下创建 git worktree，并以 <code>claude --worktree</code> 模式启动。
          </p>
          <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.4 }}>
            提示：名称中的 <code>/</code> 会自动转换为 <code>-</code>
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={!name.trim()}>
              启动
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
