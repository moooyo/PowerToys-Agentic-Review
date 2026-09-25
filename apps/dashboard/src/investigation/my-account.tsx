import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  INVESTIGATION_PASSWORD_MIN_LENGTH,
  InvestigationNewPasswordSchema,
} from "@agentic-review/contracts";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import LockRounded from "@mui/icons-material/LockRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
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
  const accessDetailsId = useId();
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
  return (
    <Stack spacing={3.5} sx={{ minWidth: 0 }}>
      <PageHeading title="My account" subtitle={`${user.displayName} · ${user.username}`} />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0,1fr)", md: "minmax(0,1.1fr) minmax(0,1fr)" },
          gap: { xs: 3, lg: 4 },
          alignItems: "start",
          maxWidth: 1180,
        }}
      >
        <Surface
          component="section"
          aria-labelledby={securityTitleId}
          sx={{ p: { xs: 2, sm: 3 }, bgcolor: "background.paper" }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
            <LockRounded color="primary" aria-hidden="true" />
            <Typography id={securityTitleId} component="h2" variant="h6">
              Change password
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Changing your password signs you out on all devices.
          </Typography>
          <Box
            component="form"
            id={formId}
            onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
            aria-label="Change password"
            noValidate
            sx={{ maxWidth: 420 }}
          >
            <Stack spacing={2.75}>
              <input
                type="hidden"
                name="username"
                autoComplete="username"
                value={user.username}
                readOnly
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
                  `${INVESTIGATION_PASSWORD_MIN_LENGTH}–${INVESTIGATION_PASSWORD_MAX_LENGTH} characters.`
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
                  Clear fields
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
        <Surface
          component="section"
          aria-labelledby={accessTitleId}
          sx={{ p: { xs: 2, sm: 3 }, bgcolor: "background.paper" }}
        >
          <Typography id={accessTitleId} component="h2" variant="h6" sx={{ mb: 2 }}>
            Your access
          </Typography>
          {user.isAdmin && <Chip label="Administrator" size="small" sx={{ mb: 2 }} />}
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
              <Typography component="dt">Repository access</Typography>
              <Box component="dd">
                {user.repositoryIds.length ? user.repositoryIds.join(", ") : "No repositories"}
              </Box>
            </Box>
            <Box>
              <Typography component="dt">Repository code execution</Typography>
              <Box component="dd">{user.allowRepositoryExecution ? "Allowed" : "Not allowed"}</Box>
            </Box>
          </Box>
          <Accordion
            disableGutters
            elevation={0}
            sx={{ mt: 2.5, bgcolor: "transparent", "&::before": { display: "none" } }}
          >
            <AccordionSummary
              id={`${accessDetailsId}-summary`}
              aria-controls={accessDetailsId}
              expandIcon={<ExpandMoreRounded aria-hidden="true" />}
              sx={{ px: 0 }}
            >
              <Typography variant="body2">Access details</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pb: 0 }}>
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
                  <Typography component="dt">Operations</Typography>
                  <Box component="dd">
                    {user.permissions.length
                      ? user.permissions
                          .map(
                            (permission) =>
                              permissionOptions.find((option) => option.value === permission)
                                ?.label ?? permission,
                          )
                          .join(", ")
                      : "Read-only"}
                  </Box>
                </Box>
                <Box>
                  <Typography component="dt">Allowed actions</Typography>
                  <Box component="dd">
                    {user.actionCapabilities.length ? (
                      <Box
                        component="ul"
                        sx={{
                          m: 0,
                          p: 0,
                          listStyle: "none",
                          display: "grid",
                          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                          gap: 1.5,
                        }}
                      >
                        {user.actionCapabilities.map((action) => (
                          <Typography key={action} component="li" variant="body2">
                            {actionLabels[action]}
                          </Typography>
                        ))}
                      </Box>
                    ) : (
                      "No actions are granted to this account."
                    )}
                  </Box>
                </Box>
                <Box>
                  <Typography component="dt">Account ID</Typography>
                  <Typography component="dd">{user.id}</Typography>
                </Box>
              </Box>
            </AccordionDetails>
          </Accordion>
        </Surface>
      </Box>
    </Stack>
  );
}
