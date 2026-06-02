import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { Workspace } from "../api";

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await api.getWorkspaces();
      setWorkspaces(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addWorkspace = useCallback(
    async (ws: Omit<Workspace, "id">) => {
      try {
        setError(null);
        const list = await api.addWorkspace(ws);
        setWorkspaces(list);
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    },
    []
  );

  const updateWorkspace = useCallback(async (ws: Workspace) => {
    try {
      setError(null);
      const list = await api.updateWorkspace(ws);
      setWorkspaces(list);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  const deleteWorkspace = useCallback(async (id: string) => {
    try {
      setError(null);
      const list = await api.deleteWorkspace(id);
      setWorkspaces(list);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  return {
    workspaces,
    loading,
    error,
    refresh,
    addWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };
}
