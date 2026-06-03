import { createContext, useContext, type ReactNode } from "react";
import { useSessionManager, type SessionManager } from "../hooks/useSessionManager";

const SessionContext = createContext<SessionManager | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const manager = useSessionManager();
  return (
    <SessionContext.Provider value={manager}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionManager {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
