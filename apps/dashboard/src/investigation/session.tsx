import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { resumeInvestigationRequests, suspendInvestigationRequests } from "./transport";

export interface InvestigationSession {
  authenticated: boolean;
  authMode: "loopback" | "oidc";
  loginPath: string;
  user: null | {
    id: string;
    displayName: string;
    email?: string | null;
    repositoryIds: string[];
    permissions: string[];
    actionCapabilities: string[];
    allowRepositoryExecution: boolean;
  };
  expiresAt?: string;
}

const sampleSession: InvestigationSession = {
  authenticated: true,
  authMode: "loopback",
  loginPath: "/api/auth/login",
  user: {
    id: "sample-operator",
    displayName: "Development Operator",
    repositoryIds: ["repo-powertoys-fork"],
    permissions: [
      "repository:manage",
      "task:create",
      "task:cancel",
      "action:prepare",
      "action:execute",
    ],
    actionCapabilities: [
      "comment",
      "approve",
      "suggestion-comment",
      "request-changes",
      "start-task",
      "reviews.verify",
    ],
    allowRepositoryExecution: false,
  },
};

export function sessionIdentity(session: InvestigationSession | undefined): string {
  const user = session?.user;
  return JSON.stringify(
    user
      ? [
          user.id,
          [...user.repositoryIds].sort(),
          [...user.permissions].sort(),
          [...user.actionCapabilities].sort(),
          user.allowRepositoryExecution,
        ]
      : null,
  );
}

export function decodeSession(value: unknown): InvestigationSession {
  if (typeof value !== "object" || value === null)
    throw new Error("The service returned an invalid session.");
  const session = value as Partial<InvestigationSession>;
  if (
    typeof session.authenticated !== "boolean" ||
    !["loopback", "oidc"].includes(session.authMode ?? "") ||
    session.loginPath !== "/api/auth/login"
  )
    throw new Error("The service returned an invalid session.");
  if (session.authenticated) {
    const user = session.user;
    if (
      !user ||
      typeof user.id !== "string" ||
      typeof user.displayName !== "string" ||
      !Array.isArray(user.repositoryIds) ||
      !user.repositoryIds.every((item) => typeof item === "string") ||
      !Array.isArray(user.permissions) ||
      !user.permissions.every((item) => typeof item === "string") ||
      !Array.isArray(user.actionCapabilities) ||
      !user.actionCapabilities.every((item) => typeof item === "string") ||
      typeof user.allowRepositoryExecution !== "boolean"
    )
      throw new Error("The service omitted the authenticated identity.");
  } else if (session.user !== null) throw new Error("The signed-out session contains an identity.");
  return session as InvestigationSession;
}

const SessionContext = createContext<{
  session: InvestigationSession;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
} | null>(null);

export function useInvestigationSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("The investigation session provider is missing.");
  return context;
}

export function InvestigationSessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<InvestigationSession>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [accessSuspended, setAccessSuspended] = useState(false);
  const generation = useRef(0);
  const identity = useRef(sessionIdentity(undefined));
  const logoutInProgress = useRef(false);
  const refresh = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      await Promise.resolve();
      const next =
        process.env.NODE_ENV === "development"
          ? sampleSession
          : await fetch("/api/auth/session", {
              credentials: "include",
              cache: "no-store",
              redirect: "error",
            }).then(async (response) => {
              if (!response.ok) throw new Error(`Session request failed (${response.status}).`);
              return decodeSession(await response.json());
            });
      if (generation.current !== currentGeneration) return;
      const nextIdentity = sessionIdentity(next);
      if (identity.current !== nextIdentity) {
        suspendInvestigationRequests();
        flushSync(() => setAccessSuspended(true));
        await queryClient.cancelQueries();
        if (generation.current !== currentGeneration) return;
        queryClient.clear();
      }
      identity.current = nextIdentity;
      if (next.authenticated) resumeInvestigationRequests();
      else suspendInvestigationRequests();
      flushSync(() => {
        setSession(next);
        setAccessSuspended(false);
      });
    } catch (cause) {
      if (generation.current !== currentGeneration) return;
      identity.current = sessionIdentity(undefined);
      suspendInvestigationRequests();
      flushSync(() => {
        setSession(undefined);
        setAccessSuspended(false);
      });
      await queryClient.cancelQueries();
      if (generation.current !== currentGeneration) return;
      queryClient.clear();
      setError(cause instanceof Error ? cause.message : "The session could not be loaded.");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (process.env.NODE_ENV === "development") return;
    const onFocus = () => {
      if (!logoutInProgress.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const login = async () => {
    setError(undefined);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`Sign in failed (${response.status}).`);
      const value: unknown = await response.json();
      if (
        typeof value === "object" &&
        value !== null &&
        "authorizationUrl" in value &&
        typeof value.authorizationUrl === "string"
      ) {
        const url = new URL(value.authorizationUrl);
        if (url.protocol !== "https:") throw new Error("The identity provider URL is invalid.");
        window.location.assign(url.href);
      } else {
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    }
  };
  const logout = async () => {
    generation.current += 1;
    logoutInProgress.current = true;
    suspendInvestigationRequests();
    flushSync(() => setAccessSuspended(true));
    await queryClient.cancelQueries();
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Sign out failed (${response.status}).`);
      queryClient.clear();
      await refresh();
    } catch (cause) {
      await refresh();
      const message =
        cause instanceof Error
          ? cause.message
          : "Sign out failed. Your current session was checked again.";
      setError(message);
      throw new Error(message);
    } finally {
      logoutInProgress.current = false;
      setAccessSuspended(false);
    }
  };

  if (accessSuspended)
    return (
      <Box sx={{ p: 6 }} role="status">
        <CircularProgress size={28} />
        <Typography sx={{ mt: 2 }}>
          {logoutInProgress.current ? "Signing out…" : "Updating workspace access…"}
        </Typography>
      </Box>
    );
  if (loading && !session)
    return (
      <Box sx={{ p: 6 }} role="status">
        <CircularProgress size={28} />
        <Typography sx={{ mt: 2 }}>Opening your workspace…</Typography>
      </Box>
    );
  if (!session?.authenticated)
    return (
      <Box sx={{ maxWidth: 600, mx: "auto", pt: 12, px: 3 }}>
        <Typography variant="h4" sx={{ mb: 2 }}>
          Agentic Review
        </Typography>
        <Alert severity={error ? "error" : "info"}>
          {error ?? "Sign in to inspect investigations and prepare actions."}
        </Alert>
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" onClick={() => void login()}>
            Sign in
          </Button>
          <Button onClick={() => void refresh()}>Retry connection</Button>
        </Stack>
      </Box>
    );
  return (
    <SessionContext.Provider value={{ session, refresh, logout }}>
      <Box id="dashboard-session" key={sessionIdentity(session)}>
        {error && (
          <Alert severity="error" onClose={() => setError(undefined)}>
            {error}
          </Alert>
        )}
        {children}
      </Box>
    </SessionContext.Provider>
  );
}
