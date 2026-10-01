import { Alert, Box, CircularProgress, Snackbar, Typography } from "@mui/material";
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
import { useConsolePreferences } from "../console/preferences";
import {
  type AuthApi,
  authApi,
  type InvestigationSession,
  type PasswordChangeInput,
  type PasswordLoginInput,
} from "./auth-api";
import { PasswordSignInForm } from "./sign-in-form";
import {
  resumeInvestigationRequests,
  subscribeInvestigationSessionExpired,
  suspendInvestigationRequests,
} from "./transport";

export type { InvestigationSession } from "./auth-api";
export { decodeSession } from "./auth-api";
export { PasswordSignInForm } from "./sign-in-form";

const signedOut = (): InvestigationSession => ({
  authenticated: false,
  authMode: "password",
  loginPath: "/api/auth/login",
  user: null,
});

export function sessionIdentity(session: InvestigationSession | undefined): string {
  const user = session?.user;
  return JSON.stringify(
    user
      ? [
          user.id,
          user.username,
          user.isAdmin,
          [...user.repositoryIds].sort(),
          [...user.permissions].sort(),
          [...user.actionCapabilities].sort(),
          user.allowRepositoryExecution,
        ]
      : null,
  );
}

interface SessionContextValue {
  session: InvestigationSession;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (input: PasswordChangeInput) => Promise<void>;
  requireSignIn: (message?: string) => Promise<void>;
}
const SessionContext = createContext<SessionContextValue | null>(null);

export function useInvestigationSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("The investigation session provider is missing.");
  return context;
}

export function InvestigationSessionProvider({
  children,
  api = authApi,
}: {
  children: ReactNode;
  api?: AuthApi;
}) {
  const { text } = useConsolePreferences();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<InvestigationSession>();
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    severity: "info" | "error" | "success";
  }>();
  const [accessSuspended, setAccessSuspended] = useState(false);
  const generation = useRef(0);
  const currentSession = useRef<InvestigationSession | undefined>(undefined);
  const mutationInProgress = useRef(false);

  const commitSession = useCallback(
    async (next: InvestigationSession, expectedGeneration: number) => {
      if (generation.current !== expectedGeneration) return;
      if (sessionIdentity(currentSession.current) !== sessionIdentity(next)) {
        suspendInvestigationRequests();
        flushSync(() => setAccessSuspended(true));
        await queryClient.cancelQueries();
        if (generation.current !== expectedGeneration) return;
        queryClient.clear();
      }
      currentSession.current = next;
      if (next.authenticated) resumeInvestigationRequests();
      else suspendInvestigationRequests();
      flushSync(() => {
        setSession(next);
        setAccessSuspended(false);
      });
      setLoading(false);
    },
    [queryClient],
  );

  const requireSignIn = useCallback(
    async (message = "Your session expired. Sign in again.") => {
      const current = ++generation.current;
      suspendInvestigationRequests();
      flushSync(() => setAccessSuspended(true));
      await queryClient.cancelQueries();
      if (generation.current !== current) return;
      queryClient.clear();
      currentSession.current = signedOut();
      flushSync(() => {
        setSession(signedOut());
        setAccessSuspended(false);
      });
      setLoading(false);
      setSigningIn(false);
      setNotice({ message, severity: "info" });
    },
    [queryClient],
  );

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api.session();
      if (next.authenticated && Date.parse(next.expiresAt) <= Date.now()) {
        if (generation.current === current) await requireSignIn();
        return;
      }
      await commitSession(next, current);
    } catch (cause) {
      if (generation.current !== current) return;
      await requireSignIn(
        "The current session could not be verified. Retry the connection or sign in again.",
      );
      setNotice({
        message: cause instanceof Error ? cause.message : "The session could not be loaded.",
        severity: "error",
      });
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [api, commitSession, requireSignIn]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(
    () =>
      subscribeInvestigationSessionExpired(() => {
        void requireSignIn();
      }),
    [requireSignIn],
  );
  useEffect(() => {
    const onFocus = () => {
      if (!mutationInProgress.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const expiry = session.expiresAt;
    const timer = window.setTimeout(
      () => {
        if (
          !mutationInProgress.current &&
          currentSession.current?.authenticated &&
          currentSession.current.expiresAt === expiry
        )
          void refresh();
      },
      Math.max(0, Math.min(Date.parse(expiry) - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [session, refresh]);

  const login = async (input: PasswordLoginInput) => {
    const current = ++generation.current;
    mutationInProgress.current = true;
    setSigningIn(true);
    setNotice(undefined);
    try {
      const next = await api.login(input);
      if (!next.authenticated)
        throw new Error("The service did not establish a signed-in session.");
      if (Date.parse(next.expiresAt) <= Date.now())
        throw new Error("The service returned an expired session. Try signing in again.");
      await commitSession(next, current);
    } catch (cause) {
      if (generation.current === current)
        setNotice({
          message: cause instanceof Error ? cause.message : "Sign in failed.",
          severity: "error",
        });
    } finally {
      mutationInProgress.current = false;
      setSigningIn(false);
    }
  };

  const changeSession = async (operation: () => Promise<void>, success: string) => {
    generation.current += 1;
    mutationInProgress.current = true;
    suspendInvestigationRequests();
    flushSync(() => setAccessSuspended(true));
    await queryClient.cancelQueries();
    try {
      await operation();
      await requireSignIn(success);
    } catch (cause) {
      await refresh();
      const message = cause instanceof Error ? cause.message : "The account operation failed.";
      setNotice({ message, severity: "error" });
      throw new Error(message);
    } finally {
      mutationInProgress.current = false;
      setAccessSuspended(false);
    }
  };
  const logout = () => changeSession(() => api.logout(), "You have signed out.");
  const changePassword = (input: PasswordChangeInput) =>
    changeSession(
      () => api.changePassword(input),
      "Your password was changed. Sign in again with the new password.",
    );

  if (accessSuspended || (loading && !session))
    return (
      <Box sx={{ p: 6 }} role="status">
        <CircularProgress size={28} />
        <Typography sx={{ mt: 2 }}>
          {mutationInProgress.current
            ? text("正在更新账号…", "Updating your account…")
            : text("正在打开控制台…", "Opening your workspace…")}
        </Typography>
      </Box>
    );
  if (!session?.authenticated)
    return (
      <PasswordSignInForm
        onLogin={login}
        onRetry={refresh}
        busy={signingIn}
        message={notice?.message}
        severity={notice?.severity}
      />
    );
  return (
    <SessionContext.Provider value={{ session, refresh, logout, changePassword, requireSignIn }}>
      <Box id="dashboard-session" key={sessionIdentity(session)}>
        {notice && (
          <Snackbar open anchorOrigin={{ vertical: "top", horizontal: "center" }}>
            <Alert severity={notice.severity} onClose={() => setNotice(undefined)}>
              {notice.message}
            </Alert>
          </Snackbar>
        )}
        {children}
      </Box>
    </SessionContext.Provider>
  );
}
