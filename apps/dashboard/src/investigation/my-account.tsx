import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  INVESTIGATION_PASSWORD_MIN_LENGTH,
  InvestigationNewPasswordSchema,
} from "@agentic-review/contracts";
import { CheckCircleOutlined, LockOutlined } from "@mui/icons-material";
import { Alert, Avatar, Box, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { Value } from "@sinclair/typebox/value";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { permissionOptions } from "./account-form";
import { actionLabels } from "./action-panel";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { focusInvalidAccountField, PasswordField } from "./password-field";
import { useInvestigationSession } from "./session";
import { PageHeading, Surface } from "./workspace-ui";

export function passwordChangeValidation(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
) {
  const errors: { currentPassword?: string; newPassword?: string; confirmation?: string } = {};
  if (!currentPassword) errors.currentPassword = "Enter your current password.";
  if (!Value.Check(InvestigationNewPasswordSchema, newPassword)) {
    errors.newPassword = `Use ${INVESTIGATION_PASSWORD_MIN_LENGTH}–${INVESTIGATION_PASSWORD_MAX_LENGTH} characters and include a non-space character.`;
  }
  if (newPassword !== confirmation) errors.confirmation = "The new passwords do not match.";
  return errors;
}

export function passwordChangeProblem(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
): string | null {
  const errors = passwordChangeValidation(currentPassword, newPassword, confirmation);
  return errors.currentPassword ?? errors.newPassword ?? errors.confirmation ?? null;
}

export default function MyAccountPage() {
  const { session, changePassword } = useInvestigationSession();
  const formId = useId();
  const securityTitleId = useId();
  const accessTitleId = useId();
  const actionsTitleId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const guardedAction = useGuardedAction();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<ReturnType<typeof passwordChangeValidation>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = Boolean(currentPassword || newPassword || confirmation);
  const clearPasswords = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
  };
  useUnsavedChanges(dirty, {
    busy,
    description: "Your new password has not been saved. Discard the password changes?",
    onDiscard: clearPasswords,
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const input = { currentPassword, newPassword };
    const problems = passwordChangeValidation(currentPassword, newPassword, confirmation);
    clearPasswords();
    setError(undefined);
    setErrors(problems);
    if (Object.keys(problems).length) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await changePassword(input);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "Your password could not be changed.");
      setErrors({ currentPassword: "Enter your current password again to retry." });
      focusInvalidAccountField(formId);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const user = session.user;
  if (!user) return <Alert severity="warning">Sign in to view your account.</Alert>;
  const initials = user.displayName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <Stack spacing={3.5} sx={{ minWidth: 0 }}>
      <PageHeading title="My account" subtitle="Your profile, security, and workspace access." />
      <Stack
        direction="row"
        spacing={3}
        sx={{ alignItems: "center", pb: 3.5, borderBottom: 1, borderColor: "divider", minWidth: 0 }}
      >
        <Avatar
          aria-hidden="true"
          sx={{
            width: { xs: 60, sm: 76 },
            height: { xs: 60, sm: 76 },
            fontSize: { xs: 22, sm: 26 },
            bgcolor: "action.selected",
            color: "primary.main",
          }}
        >
          {initials}
        </Avatar>
        <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <Typography
            component="h2"
            sx={{ fontSize: 24, lineHeight: 1.3, fontWeight: 500, mb: 0.5 }}
          >
            {user.displayName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            @{user.username}
          </Typography>
          <Chip
            label={user.isAdmin ? "Administrator" : "Standard account"}
            color={user.isAdmin ? "primary" : "default"}
            size="small"
            variant="outlined"
          />
        </Box>
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0,1fr)", lg: "minmax(0,1.3fr) minmax(0,1fr)" },
          gap: { xs: 3, lg: 4 },
          alignItems: "start",
          maxWidth: 1180,
        }}
      >
        <Surface
          component="section"
          aria-labelledby={securityTitleId}
          sx={{ p: { xs: 2.5, sm: 3.5 } }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
            <LockOutlined color="primary" aria-hidden="true" />
            <Typography id={securityTitleId} component="h2" variant="h6">
              Change password
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Changing your password signs out every session for your account. Sign in again with the
            new password.
          </Typography>
          <Box
            component="form"
            id={formId}
            onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
            aria-label="Change password"
            noValidate
          >
            <Stack spacing={2.75}>
              <TextField
                label="Username"
                name="username"
                autoComplete="username"
                value={user.username}
                slotProps={{ input: { readOnly: true } }}
                fullWidth
              />
              <PasswordField
                label="Current password"
                name="currentPassword"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setErrors((current) => ({ ...current, currentPassword: undefined }));
                }}
                error={!!errors.currentPassword}
                helperText={errors.currentPassword}
                required
                disabled={busy}
              />
              <PasswordField
                label="New password"
                name="newPassword"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  setErrors((current) => ({ ...current, newPassword: undefined }));
                }}
                error={!!errors.newPassword}
                helperText={
                  errors.newPassword ??
                  `${INVESTIGATION_PASSWORD_MIN_LENGTH}–${INVESTIGATION_PASSWORD_MAX_LENGTH} characters. Passwords are case-sensitive and spaces are preserved.`
                }
                required
                disabled={busy}
              />
              <PasswordField
                label="Confirm new password"
                name="confirmPassword"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setErrors((current) => ({ ...current, confirmation: undefined }));
                }}
                error={!!errors.confirmation}
                helperText={errors.confirmation}
                required
                disabled={busy}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Typography variant="body2" color="text.secondary">
                Password fields are cleared after every attempt.
              </Typography>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1}
                sx={{ alignItems: { sm: "center" } }}
              >
                <Button type="submit" variant="contained" disabled={busy}>
                  {busy ? "Changing password…" : "Change password"}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !dirty}
                  onClick={() =>
                    guardedAction(() => {
                      clearPasswords();
                      setErrors({});
                      setError(undefined);
                    })
                  }
                >
                  Discard changes
                </Button>
              </Stack>
              {dirty && (
                <Typography role="status" variant="body2" color="text.secondary">
                  Unsaved password changes
                </Typography>
              )}
            </Stack>
          </Box>
        </Surface>
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <Surface
            component="section"
            aria-labelledby={accessTitleId}
            sx={{ p: { xs: 2.5, sm: 3.5 } }}
          >
            <Typography id={accessTitleId} component="h2" variant="h6" sx={{ mb: 2 }}>
              Workspace access
            </Typography>
            <Alert severity="info" sx={{ mb: 2.5 }}>
              Contact a workspace administrator to change your access.
            </Alert>
            <Box
              component="dl"
              sx={{
                m: 0,
                display: "grid",
                gap: 2.5,
                "& dt": { fontSize: 12, color: "text.secondary", mb: 0.5 },
                "& dd": { m: 0, fontSize: 14, lineHeight: 1.6, overflowWrap: "anywhere" },
              }}
            >
              <Box>
                <Typography component="dt">Account ID</Typography>
                <Typography component="dd">{user.id}</Typography>
              </Box>
              <Box>
                <Typography component="dt">Repository access</Typography>
                <Box component="dd">
                  {user.repositoryIds.length ? user.repositoryIds.join(", ") : "No repositories"}
                </Box>
              </Box>
              <Box>
                <Typography component="dt">Business permissions</Typography>
                <Box component="dd">
                  {user.permissions.length
                    ? user.permissions
                        .map(
                          (permission) =>
                            permissionOptions.find((option) => option.value === permission)
                              ?.label ?? permission,
                        )
                        .join(", ")
                    : "No business permissions"}
                </Box>
              </Box>
              <Box>
                <Typography component="dt">Repository code execution</Typography>
                <Box component="dd">
                  {user.allowRepositoryExecution ? "Allowed" : "Not allowed"}
                </Box>
              </Box>
            </Box>
            {user.isAdmin && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2.5 }}>
                Administrator access manages accounts. It does not grant repository access, business
                permissions, actions, or code execution.
              </Typography>
            )}
            {!user.repositoryIds.length && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2.5 }}>
                You can manage your profile here. A repository grant is needed to open repository
                work.
              </Typography>
            )}
          </Surface>
          <Surface
            component="section"
            aria-labelledby={actionsTitleId}
            sx={{ p: { xs: 2.5, sm: 3.5 } }}
          >
            <Typography id={actionsTitleId} component="h2" variant="h6" sx={{ mb: 1 }}>
              Allowed actions
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Actions also require the corresponding repository access and business permission.
            </Typography>
            {user.actionCapabilities.length ? (
              <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: "none" }}>
                {user.actionCapabilities.map((action) => (
                  <Stack
                    key={action}
                    component="li"
                    direction="row"
                    spacing={1.25}
                    sx={{ alignItems: "center", minWidth: 0 }}
                  >
                    <CheckCircleOutlined fontSize="small" color="primary" aria-hidden="true" />
                    <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                      {actionLabels[action]}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No actions are granted to this account.
              </Typography>
            )}
          </Surface>
        </Stack>
      </Box>
    </Stack>
  );
}
