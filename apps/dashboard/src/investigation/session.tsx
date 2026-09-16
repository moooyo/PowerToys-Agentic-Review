import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  type AuthApi,
  authApi,
  type InvestigationSession,
  type PasswordChangeInput,
  type PasswordLoginInput,
} from "./auth-api";
import {
  resumeInvestigationRequests,
  subscribeInvestigationSessionExpired,
  suspendInvestigationRequests,
} from "./transport";

export type { InvestigationSession } from "./auth-api";
export { decodeSession } from "./auth-api";

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

export function PasswordSignInForm({
  onLogin,
  onRetry,
  busy,
  message,
  severity = "info",
}: {
  onLogin: (input: PasswordLoginInput) => Promise<void>;
  onRetry: () => Promise<void>;
  busy: boolean;
  message?: string;
  severity?: "info" | "error" | "success";
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const input = { username: normalizeInvestigationUsername(username), password };
    setPassword("");
    setValidationError(undefined);
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(input.username) || !input.password) {
      setValidationError("Enter a valid username and password.");
      return;
    }
    await onLogin(input);
  };
  return (
    <Box sx={{ maxWidth: 480, mx: "auto", pt: { xs: 6, sm: 12 }, px: 3, pb: 4 }}>
      <Typography variant="h4" sx={{ mb: 1 }}>
        Agentic Review
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Sign in with your workspace account.
      </Typography>
      {(message || validationError) && (
        <Alert severity={validationError ? "error" : severity} sx={{ mb: 2 }}>
          {validationError ?? message}
        </Alert>
      )}
      <Box
        component="form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
        aria-label="Sign in"
        noValidate
      >
        <Stack spacing={2}>
          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
            required
            fullWidth
            slotProps={{ htmlInput: { autoCapitalize: "none", spellCheck: false, maxLength: 128 } }}
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            required
            fullWidth
            slotProps={{ htmlInput: { maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2 } }}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={busy || !username.trim() || !password}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <Button disabled={busy} onClick={() => void onRetry()}>
            Retry connection
          </Button>
        </Stack>
      </Box>
      {process.env.NODE_ENV === "development" && (
        <Alert severity="info" sx={{ mt: 3 }}>
          <Typography variant="subtitle2">Development sample only</Typography>
          <Typography variant="body2">
            Public demo account: <strong>demo</strong>
            <br />
            Demo password: <code>Demo-password-2026!</code>
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Accounts and PowerToys reports are held in memory. This preview does not access GitHub
            or start a Worker.
          </Typography>
          <Button
            disabled={busy}
            onClick={() => {
              setUsername("demo");
              setPassword("Demo-password-2026!");
            }}
          >
            Fill demo credentials
          </Button>
        </Alert>
      )}
    </Box>
  );
}

export function InvestigationSessionProvider({
  children,
  api = authApi,
}: {
  children: ReactNode;
  api?: AuthApi;
}) {
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
          {mutationInProgress.current ? "Updating your account…" : "Opening your workspace…"}
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
