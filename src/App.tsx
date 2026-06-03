import { useState, useCallback, useEffect } from "react";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { PerformancePanel } from "./components/PerformancePanel";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useSession } from "./contexts/SessionContext";
import { api } from "./api";
import type { Workspace } from "./api";
import { cn } from "./utils/cn";
import styles from "./App.module.css";

function App() {
  const {
    workspaces,
    loading,
    error,
    refresh,
    addWorkspace,
    updateWorkspace,
    deleteWorkspace,
    reorderWorkspaces,
  } = useWorkspaces();

  const { sessions, launchSession } = useSession();

  // ── UI state ──
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [ptyError, setPtyError] = useState<string | null>(null);
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const [view, setView] = useState<"performance" | "terminal">("terminal");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);

  // ── Handlers ──

  const handleLaunchSession = useCallback(
    async (ws: Workspace) => {
      setPtyError(null);
      try {
        await launchSession(ws);
      } catch (e) {
        setPtyError(String(e));
      }
    },
    [launchSession]
  );

  const handleDeleteConfirm = useCallback(async () => {
    const workspaceId = confirmDeleteId;
    if (!workspaceId) return;
    setConfirmDeleteId(null);
    const wsSessions = sessions.filter((s) => s.workspaceId === workspaceId);
    for (const s of wsSessions) {
      await api.killPty(s.id).catch(() => {});
    }
    await deleteWorkspace(workspaceId);
  }, [confirmDeleteId, sessions, deleteWorkspace]);

  const handleEditSave = useCallback(
    async (ws: Omit<Workspace, "id">, originalId: string) => {
      const ok = await updateWorkspace({ ...ws, id: originalId });
      if (ok) setEditingWorkspace(null);
    },
    [updateWorkspace]
  );

  const handleReorder = useCallback(
    async (workspaceId: string, direction: "up" | "down") => {
      const idx = workspaces.findIndex((w) => w.id === workspaceId);
      if (idx === -1) return;
      const target = direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= workspaces.length) return;
      const reordered = [...workspaces];
      [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
      await reorderWorkspaces(reordered.map((w) => w.id));
    },
    [workspaces, reorderWorkspaces]
  );

  const handleAddSave = useCallback(
    async (ws: Omit<Workspace, "id">) => {
      const ok = await addWorkspace(ws);
      if (ok) setShowAddDialog(false);
    },
    [addWorkspace]
  );

  const handleImportClaude = useCallback(async () => {
    try {
      const discovered = await api.importFromClaudeCode();
      if (discovered.length === 0) {
        setInfoToast("All Claude Code projects have already been imported.");
        return;
      }
      let imported = 0;
      for (const ws of discovered) {
        const ok = await addWorkspace({
          name: ws.name,
          path: ws.path,
          command: ws.command,
          args: ws.args,
          auto_prompt: ws.auto_prompt,
          env: ws.env,
        });
        if (ok) imported++;
      }
      if (imported > 0) {
        setInfoToast(`Imported ${imported} workspace${imported > 1 ? 's' : ''} from Claude Code.`);
      }
    } catch (e) {
      setPtyError(`Import failed: ${String(e)}`);
    }
  }, [addWorkspace]);

  // ---- Auto-dismiss infoToast ----
  useEffect(() => {
    if (!infoToast) return;
    const timer = setTimeout(() => setInfoToast(null), 4000);
    return () => clearTimeout(timer);
  }, [infoToast]);

  if (loading) {
    return (
      <div className={styles.appLoading}>
        Loading workspaces...
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <TitleBar
        view={view}
        onViewChange={setView}
        onAddWorkspace={() => setShowAddDialog(true)}
      />

      <div className={styles.appLayout}>
        {view === "terminal" ? (
          <>
            <WorkspacePanel
              collapsed={sidebarCollapsed}
              workspaces={workspaces}
              onLaunchSession={handleLaunchSession}
              onEdit={setEditingWorkspace}
              onDelete={setConfirmDeleteId}
              onAdd={() => setShowAddDialog(true)}
              onImportClaude={() => setShowImportConfirm(true)}
              onReorder={handleReorder}
            />
            <button
              className={cn(styles.sidebarToggle, sidebarCollapsed && styles.collapsed)}
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                {sidebarCollapsed ? (
                  <polyline points="3,2 7,5 3,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <polyline points="7,2 3,5 7,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
            </button>
            <TerminalPanel />
          </>
        ) : (
          <PerformancePanel sessions={sessions} />
        )}
      </div>

      <Toast
        error={error}
        ptyError={ptyError}
        infoToast={infoToast}
        onDismissError={() => {}}
        onDismissPtyError={() => setPtyError(null)}
        onDismissInfo={() => setInfoToast(null)}
        onRetry={refresh}
      />

      {showAddDialog && (
        <AddWorkspaceDialog
          onSave={handleAddSave}
          onCancel={() => setShowAddDialog(false)}
        />
      )}

      {editingWorkspace && (
        <AddWorkspaceDialog
          workspace={editingWorkspace}
          onSave={(ws) => handleEditSave(ws, editingWorkspace.id)}
          onCancel={() => setEditingWorkspace(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete Workspace"
        confirmLabel="Delete"
        confirmClass="btn-danger"
        message={
          <>
            Are you sure you want to delete this workspace?
            {confirmDeleteId && sessions.some((s) => s.workspaceId === confirmDeleteId) &&
              " All running sessions will be terminated."}
          </>
        }
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteId(null)}
      />

      <ConfirmDialog
        open={showImportConfirm}
        title="Import from Claude Code"
        confirmLabel="Import"
        message={
          <>
            This will scan your Claude Code projects directory
            (<code>~/.claude/projects/</code>) and import any workspaces not
            already in your list. Each workspace will be configured with
            default settings (command: <code>claude</code>).
          </>
        }
        onConfirm={() => {
          setShowImportConfirm(false);
          handleImportClaude();
        }}
        onCancel={() => setShowImportConfirm(false)}
      />
    </div>
  );
}

export default App;
