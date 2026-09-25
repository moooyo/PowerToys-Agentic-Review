import { normalizeInvestigationUsername } from "@agentic-review/contracts";
import { ShieldRounded } from "@mui/icons-material";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { type FormEvent, useId, useRef, useState } from "react";
import type { PasswordLoginInput } from "./auth-api";
import { focusInvalidAccountField, PasswordField } from "./password-field";

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
  const formId = useId();
  const titleId = useId();
  const pending = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || pending.current) return;
    const input = { username: normalizeInvestigationUsername(username), password };
    const nextErrors = {
      username: /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(input.username)
        ? undefined
        : "Enter your workspace username: 3–64 letters, numbers, periods, underscores, or hyphens.",
      password: input.password ? undefined : "Enter your password.",
    };
    setErrors(nextErrors);
    setError(undefined);
    setPassword("");
    if (nextErrors.username || nextErrors.password) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    try {
      await onLogin(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Try again.");
    } finally {
      pending.current = false;
    }
  };
  return (
    <Box
      component="main"
      sx={{
        minHeight: "100dvh",
        bgcolor: "background.default",
        p: { xs: 2, sm: 4, lg: 6 },
        display: "flex",
        flexDirection: "column",
        gap: { xs: 4, md: 5 },
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: "center", justifyContent: { xs: "center", md: "flex-start" } }}
      >
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: "16px",
            bgcolor: "action.selected",
            color: "primary.main",
            display: "grid",
            placeItems: "center",
          }}
        >
          <ShieldRounded aria-hidden="true" />
        </Box>
        <Typography sx={{ fontSize: 18, fontWeight: 500 }}>Agentic Review</Typography>
      </Stack>
      <Box
        sx={{
          width: "100%",
          maxWidth: 456,
          mx: "auto",
          my: "auto",
          alignItems: "center",
          gap: { md: 6, lg: 12 },
        }}
      >
        <Box
          component="section"
          aria-labelledby={titleId}
          sx={{
            width: "100%",
            maxWidth: 456,
            mx: "auto",
            minWidth: 0,
            borderRadius: "16px",
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            p: { xs: 3, sm: 4, lg: 4.5 },
          }}
        >
          <Stack spacing={3}>
            <Box>
              <Typography component="h1" id={titleId} sx={{ fontSize: 28, lineHeight: 1.3, mb: 1 }}>
                Sign in
              </Typography>
            </Box>
            {(message || error) && (
              <Alert severity={error ? "error" : severity}>{error ?? message}</Alert>
            )}
            <Box
              component="form"
              id={formId}
              onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
              aria-label="Sign in"
              noValidate
            >
              <Stack spacing={2.5}>
                <TextField
                  autoFocus
                  label="Username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setErrors((current) => ({ ...current, username: undefined }));
                  }}
                  error={!!errors.username}
                  helperText={errors.username}
                  disabled={busy}
                  required
                  fullWidth
                  slotProps={{
                    htmlInput: { autoCapitalize: "none", spellCheck: false, maxLength: 64 },
                  }}
                />
                <PasswordField
                  label="Password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setErrors((current) => ({ ...current, password: undefined }));
                  }}
                  error={!!errors.password}
                  helperText={errors.password}
                  disabled={busy}
                  required
                />
                <Button type="submit" variant="contained" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
                {(message || error) && (
                  <Button disabled={busy} onClick={() => void onRetry()}>
                    Retry connection
                  </Button>
                )}
              </Stack>
            </Box>
            <Typography color="text.secondary" sx={{ fontSize: 13, lineHeight: 1.55 }}>
              Need access or a password reset? Contact your workspace administrator.
            </Typography>
            {process.env.NODE_ENV === "development" && (
              <Alert severity="info">
                <Typography variant="subtitle2">Development sample only</Typography>
                <Typography variant="body2">
                  Public demo account: <strong>demo</strong>
                  <br />
                  Demo password: <code>Demo-password-2026!</code>
                </Typography>
                <Typography variant="body2" sx={{ mt: 1 }}>
                  Accounts and PowerToys reports are held in memory. This preview does not access
                  GitHub or start a Worker.
                </Typography>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setUsername("demo");
                    setPassword("Demo-password-2026!");
                    setErrors({});
                  }}
                >
                  Fill demo credentials
                </Button>
              </Alert>
            )}
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}
