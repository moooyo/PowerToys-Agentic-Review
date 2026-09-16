import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  INVESTIGATION_PASSWORD_MIN_LENGTH,
  InvestigationNewPasswordSchema,
} from "@agentic-review/contracts";
import { Alert, Box, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { Value } from "@sinclair/typebox/value";
import { type FormEvent, useState } from "react";
import { Section } from "./report-sections";
import { useInvestigationSession } from "./session";

export function passwordChangeProblem(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string | null {
  if (!currentPassword) return "Enter your current password.";
  if (!Value.Check(InvestigationNewPasswordSchema, newPassword))
    return `Use ${INVESTIGATION_PASSWORD_MIN_LENGTH}–${INVESTIGATION_PASSWORD_MAX_LENGTH} characters and include a non-space character.`;
  if (newPassword !== confirmation) return "The new passwords do not match.";
  return null;
}

export default function MyAccountPage() {
  const { session, changePassword } = useInvestigationSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const input = { currentPassword, newPassword };
    const problem = passwordChangeProblem(currentPassword, newPassword, confirmation);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setError(undefined);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await changePassword(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your password could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <Box>
        <Typography variant="h4">My account</Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          {session.user?.displayName}
        </Typography>
        {session.user?.isAdmin && <Chip label="Administrator" size="small" sx={{ mt: 1 }} />}
      </Box>
      <Section title="Change password">
        <Box
          component="form"
          onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
          aria-label="Change password"
          noValidate
        >
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Changing your password signs out every session for your account. Sign in again with
              the new password.
            </Typography>
            <TextField
              label="Username"
              name="username"
              autoComplete="username"
              value={session.user?.username ?? ""}
              slotProps={{ input: { readOnly: true } }}
              fullWidth
            />
            <TextField
              label="Current password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              disabled={busy}
              fullWidth
              slotProps={{ htmlInput: { maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2 } }}
            />
            <TextField
              label="New password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              disabled={busy}
              fullWidth
              helperText={`${INVESTIGATION_PASSWORD_MIN_LENGTH}–${INVESTIGATION_PASSWORD_MAX_LENGTH} characters. Passwords are case-sensitive and spaces are preserved.`}
              slotProps={{ htmlInput: { maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2 } }}
            />
            <TextField
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              disabled={busy}
              fullWidth
              slotProps={{ htmlInput: { maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2 } }}
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button
              type="submit"
              variant="contained"
              disabled={busy || !currentPassword || !newPassword || !confirmation}
              sx={{ alignSelf: "flex-start" }}
            >
              {busy ? "Changing password…" : "Change password"}
            </Button>
          </Stack>
        </Box>
      </Section>
    </Stack>
  );
}
