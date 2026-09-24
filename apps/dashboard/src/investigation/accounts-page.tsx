import { InvestigationActionKindSchema } from "@agentic-review/contracts";
import { AddOutlined, AdminPanelSettingsOutlined, SearchOutlined } from "@mui/icons-material";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  FormGroup,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type AccountDirectoryFilter,
  AccountFormError,
  type AccountFormValues,
  accountDirectoryFilters,
  accountFormIsDirty,
  accountFormValues,
  accountPasswordResetProblems,
  accountWriteVersion,
  filterAccounts,
  permissionOptions,
  submitAccountForm,
  submitAccountPassword,
} from "./account-form";
import { actionLabels } from "./action-panel";
import { investigationApi, type Repository } from "./api";
import { type Account, authApi } from "./auth-api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { focusInvalidAccountField, PasswordField } from "./password-field";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";

const accountsQueryKey = ["investigation-accounts"];
const actionOptions = InvestigationActionKindSchema.anyOf.map((schema) => schema.const);
const actionGroups = [
  {
    label: "Review & publish",
    actions: [
      "comment",
      "approve",
      "suggestion-comment",
      "request-changes",
      "close",
      "merge",
      "close-as-duplicate",
      "create-pr",
    ],
  },
  { label: "Investigations", actions: ["start-task", "reviews.verify", "trigger-ci", "resume"] },
  { label: "View", actions: ["view-validation", "view-changes", "view-evidence"] },
];

function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function accountInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function useMountedAccountForm() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export function AccountAccessSummary({ account }: { account: Account }) {
  return (
    <Stack spacing={1} sx={{ overflowWrap: "anywhere" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Chip label={account.enabled ? "Enabled" : "Disabled"} variant="outlined" />
        {account.isAdmin && <Chip label="Administrator" color="primary" variant="outlined" />}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Repositories: {account.repositoryIds.length ? account.repositoryIds.join(", ") : "None"}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Permissions: {account.permissions.length ? account.permissions.join(", ") : "None"}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Actions:{" "}
        {account.actionCapabilities.length
          ? account.actionCapabilities.map((action) => actionLabels[action]).join(", ")
          : "None"}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Repository execution: {account.allowRepositoryExecution ? "Allowed" : "Not allowed"}
      </Typography>
    </Stack>
  );
}

function useAccountReview(account: Account | undefined, reload: (id: string) => Promise<Account>) {
  const mounted = useMountedAccountForm();
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Account>();
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  return {
    conflict,
    latest,
    reviewed,
    loading,
    error,
    setReviewed,
    ready: !conflict || (!!latest && reviewed),
    version: () => (account ? accountWriteVersion(account, conflict, latest, reviewed) : undefined),
    markConflict: () => {
      setConflict(true);
      setLatest(undefined);
      setReviewed(false);
    },
    refresh: async () => {
      if (!account) return;
      setLoading(true);
      setError(undefined);
      setReviewed(false);
      try {
        const result = await reload(account.id);
        if (mounted.current) setLatest(result);
      } catch (cause) {
        if (!mounted.current) return;
        setLatest(undefined);
        setError(cause instanceof Error ? cause.message : "The account could not be refreshed.");
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
  };
}

export function AccountConflictNotice({
  review,
  disabled,
}: {
  review: ReturnType<typeof useAccountReview>;
  disabled: boolean;
}) {
  if (!review.conflict) return null;
  return (
    <Stack spacing={2}>
      <Alert severity="warning">
        Account access changed. Refresh and review the latest access before saving. Your edits are
        kept.
      </Alert>
      <Button
        variant="outlined"
        disabled={disabled || review.loading}
        onClick={() => void review.refresh()}
        sx={{ alignSelf: "flex-start" }}
      >
        {review.loading ? "Refreshing…" : "Review latest access"}
      </Button>
      {review.error && <Alert severity="error">{review.error}</Alert>}
      {review.latest && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Latest saved account · version {review.latest.version}
          </Typography>
          <Typography sx={{ mb: 1 }}>{review.latest.displayName}</Typography>
          <AccountAccessSummary account={review.latest} />
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                checked={review.reviewed}
                disabled={disabled || review.loading}
                onChange={(_, checked) => review.setReviewed(checked)}
              />
            }
            label="Apply my changes to this version."
          />
        </Paper>
      )}
    </Stack>
  );
}

function AccountAccessFields({
  form,
  setField,
  repositories,
  repositoriesUnavailable,
  repositoryError,
}: {
  form: AccountFormValues;
  setField: <K extends keyof AccountFormValues>(field: K, value: AccountFormValues[K]) => void;
  repositories: Repository[];
  repositoriesUnavailable: boolean;
  repositoryError?: string;
}) {
  const repositoryIdsId = useId();
  const selectedRepositoryIds = form.repositoryIdsText.split(/[\s,]+/u).filter(Boolean);
  const unknownRepositoryIds = selectedRepositoryIds.filter(
    (id) => !repositories.some((repository) => repository.id === id),
  );
  const [showRepositoryIds, setShowRepositoryIds] = useState(unknownRepositoryIds.length > 0);
  useEffect(() => {
    if (repositoryError) setShowRepositoryIds(true);
  }, [repositoryError]);
  const toggleRepository = (id: string, checked: boolean) => {
    setField("repositoryIdsText", toggleValue(selectedRepositoryIds, id, checked).join("\n"));
  };
  return (
    <Stack spacing={2.5}>
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1" sx={{ mb: 1.5 }}>
          Repository access
        </Typography>
        {!!repositories.length && (
          <FormGroup
            sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1 }}
          >
            {repositories.map((repository) => (
              <FormControlLabel
                key={repository.id}
                sx={{ minWidth: 0, overflowWrap: "anywhere", alignItems: "flex-start" }}
                control={
                  <Checkbox
                    checked={selectedRepositoryIds.includes(repository.id)}
                    onChange={(_, checked) => toggleRepository(repository.id, checked)}
                  />
                }
                label={
                  <Box sx={{ py: 1 }}>
                    <Typography variant="body2">{repository.fullName}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {repository.id}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </FormGroup>
        )}
        {repositoriesUnavailable && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Repository directory unavailable. Enter repository IDs below.
          </Alert>
        )}
        <Button
          type="button"
          onClick={() => setShowRepositoryIds((shown) => !shown)}
          aria-expanded={showRepositoryIds || repositoriesUnavailable || !!repositoryError}
          aria-controls={repositoryIdsId}
          sx={{ px: 0 }}
        >
          Repository IDs
          {unknownRepositoryIds.length
            ? ` · ${unknownRepositoryIds.length} outside this directory`
            : ""}
        </Button>
        <Box
          id={repositoryIdsId}
          hidden={!showRepositoryIds && !repositoriesUnavailable && !repositoryError}
        >
          <TextField
            label="Repository IDs"
            name="repositoryIdsText"
            fullWidth
            multiline
            minRows={2}
            maxRows={6}
            value={form.repositoryIdsText}
            onChange={(event) => setField("repositoryIdsText", event.target.value)}
            error={!!repositoryError}
            helperText={repositoryError ?? "Exact IDs, separated by commas or new lines."}
          />
        </Box>
      </Box>
      <Divider />
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1">
          Operations
        </Typography>
        <FormGroup sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
          {permissionOptions.map((permission) => (
            <FormControlLabel
              key={permission.value}
              control={
                <Checkbox
                  checked={form.permissions.includes(permission.value)}
                  onChange={(_, checked) =>
                    setField(
                      "permissions",
                      toggleValue(form.permissions, permission.value, checked),
                    )
                  }
                />
              }
              label={permission.label}
            />
          ))}
        </FormGroup>
      </Box>
      <Box>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Allowed actions{" "}
          <Typography component="span" variant="body2" color="text.secondary">
            · {form.actionCapabilities.length} selected
          </Typography>
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(3,minmax(0,1fr))" },
            gap: 2,
          }}
        >
          {actionGroups.map((group) => (
            <Box component="fieldset" key={group.label} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
              <Typography component="legend" variant="body2" sx={{ mb: 1, fontWeight: 500 }}>
                {group.label}
              </Typography>
              <FormGroup>
                {actionOptions
                  .filter((action) => group.actions.includes(action))
                  .map((action) => (
                    <FormControlLabel
                      key={action}
                      control={
                        <Checkbox
                          checked={form.actionCapabilities.includes(action)}
                          onChange={(_, checked) =>
                            setField(
                              "actionCapabilities",
                              toggleValue(form.actionCapabilities, action, checked),
                            )
                          }
                        />
                      }
                      label={actionLabels[action]}
                    />
                  ))}
              </FormGroup>
            </Box>
          ))}
        </Box>
      </Box>
      <Box sx={{ p: 2.5, bgcolor: "action.hover", borderRadius: "16px" }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={form.allowRepositoryExecution}
              onChange={(_, value) => setField("allowRepositoryExecution", value)}
            />
          }
          label="Allow repository code execution"
        />
        <Typography variant="body2" color="text.secondary">
          Allows builds, tests and desktop verification.
        </Typography>
      </Box>
    </Stack>
  );
}

function AccountEditor({
  account,
  repositories,
  repositoriesUnavailable,
  onClose,
  onSaved,
  reloadAccount,
  onResetPassword,
}: {
  account?: Account;
  repositories: Repository[];
  repositoriesUnavailable: boolean;
  onClose: () => void;
  onSaved: (account: Account, created: boolean) => Promise<void>;
  reloadAccount: (id: string) => Promise<Account>;
  onResetPassword: (account: Account) => void;
}) {
  const formId = useId();
  const titleId = useId();
  const mounted = useMountedAccountForm();
  const guardedAction = useGuardedAction();
  const [form, setForm] = useState(() => accountFormValues(account));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<AccountFormError>();
  const review = useAccountReview(account, reloadAccount);
  const baseline = review.reviewed && review.latest ? review.latest : account;
  const dirty = accountFormIsDirty(form, baseline);
  useUnsavedChanges(dirty, {
    busy: busy || review.loading,
    description: "Your unsaved account changes will be discarded.",
    onDiscard: () => setForm(accountFormValues(baseline)),
  });
  const close = () => guardedAction(onClose);
  const setField = <K extends keyof AccountFormValues>(field: K, value: AccountFormValues[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (fieldError?.field === field) setFieldError(undefined);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading || (account && !dirty)) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      const saved = await submitAccountForm(form, account, review.version(), authApi, () => {
        if (mounted.current) setForm((current) => ({ ...current, password: "" }));
      });
      if (!mounted.current) return;
      await onSaved(saved, !account);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof AccountFormError) {
        setFieldError(cause);
        focusInvalidAccountField(formId);
      } else {
        setError(cause instanceof Error ? cause.message : "The account could not be saved.");
        if (account && cause instanceof InvestigationHttpError && cause.status === 409) {
          review.markConflict();
        }
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog open fullWidth maxWidth="md" onClose={close} aria-labelledby={titleId}>
      <DialogTitle component="div">
        <Typography component="h2" id={titleId} variant="h6">
          {account ? `Edit ${account.displayName}` : "Create account"}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Box component="form" id={formId} noValidate onSubmit={(event) => void submit(event)}>
          <Stack spacing={2} sx={{ mb: 2 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <AccountConflictNotice review={review} disabled={busy} />
          </Stack>
          <Box component="fieldset" disabled={busy} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
            <Stack spacing={2.5} component="section" aria-label="Identity" sx={{ mb: 3 }}>
              <Typography component="h3" variant="subtitle1">
                Identity
              </Typography>
              <TextField
                autoFocus
                label="Username"
                name="username"
                autoComplete="username"
                required
                fullWidth
                value={form.username}
                slotProps={{
                  input: { readOnly: !!account },
                  htmlInput: { maxLength: 64, autoCapitalize: "none", spellCheck: false },
                }}
                onChange={(event) => setField("username", event.target.value)}
                error={fieldError?.field === "username"}
                helperText={
                  fieldError?.field === "username"
                    ? fieldError.message
                    : account
                      ? "Usernames cannot be changed."
                      : "3–64 letters, numbers, periods, underscores or hyphens."
                }
              />
              <TextField
                label="Display name"
                name="displayName"
                required
                fullWidth
                autoComplete="name"
                value={form.displayName}
                onChange={(event) => setField("displayName", event.target.value)}
                slotProps={{ htmlInput: { maxLength: 120 } }}
                error={fieldError?.field === "displayName"}
                helperText={fieldError?.field === "displayName" ? fieldError.message : undefined}
              />
              {!account && (
                <PasswordField
                  label="Initial password"
                  name="password"
                  autoComplete="new-password"
                  required
                  fullWidth
                  value={form.password}
                  onChange={(event) => setField("password", event.target.value)}
                  error={fieldError?.field === "password"}
                  helperText={
                    fieldError?.field === "password" ? fieldError.message : "15–128 characters."
                  }
                />
              )}
            </Stack>
            <AccountAccessFields
              form={form}
              setField={setField}
              repositories={repositories}
              repositoriesUnavailable={repositoriesUnavailable}
              repositoryError={
                fieldError?.field === "repositoryIdsText" ? fieldError.message : undefined
              }
            />
            <Stack
              component="section"
              spacing={2}
              sx={{ mt: 3, pt: 3, borderTop: 1, borderColor: "divider" }}
            >
              <Typography component="h3" variant="subtitle1">
                Workspace administration
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={form.isAdmin}
                    onChange={(_, value) => setField("isAdmin", value)}
                  />
                }
                label="Administrator"
              />
              {account && (
                <Box>
                  <Typography component="h3" variant="subtitle1" sx={{ mb: 1 }}>
                    Security
                  </Typography>
                  <Button
                    type="button"
                    disabled={busy || review.loading}
                    onClick={() => guardedAction(() => onResetPassword(account))}
                  >
                    Reset password
                  </Button>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={form.enabled}
                        onChange={(_, value) => setField("enabled", value)}
                      />
                    }
                    label="Account enabled"
                  />
                  <Typography variant="body2" color="text.secondary">
                    Disabled accounts cannot sign in. Disabling an account ends its sessions.
                  </Typography>
                </Box>
              )}
            </Stack>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        {dirty && (
          <Typography
            role="status"
            variant="body2"
            color="text.secondary"
            sx={{ mr: "auto", pl: 1 }}
          >
            Unsaved changes
          </Typography>
        )}
        <Button disabled={busy || review.loading} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="contained"
          disabled={busy || review.loading || !review.ready || Boolean(account && !dirty)}
        >
          {busy ? "Saving…" : account ? "Save changes" : "Create account"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ResetPasswordDialog({
  account,
  onClose,
  onSaved,
  reloadAccount,
}: {
  account: Account;
  onClose: () => void;
  onSaved: (account: Account) => Promise<void>;
  reloadAccount: (id: string) => Promise<Account>;
}) {
  const formId = useId();
  const titleId = useId();
  const acknowledgmentId = useId();
  const mounted = useMountedAccountForm();
  const guardedAction = useGuardedAction();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [acknowledgedError, setAcknowledgedError] = useState<string>();
  const review = useAccountReview(account, reloadAccount);
  useUnsavedChanges(Boolean(password || confirmation || acknowledged), {
    busy: busy || review.loading,
    description: "The new password has not been saved. Discard this password reset?",
    onDiscard: () => {
      setPassword("");
      setConfirmation("");
      setAcknowledged(false);
    },
  });
  const close = () => guardedAction(onClose);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading) return;
    const problems = accountPasswordResetProblems(password, confirmation, acknowledged);
    const newPassword = password;
    setPassword("");
    setConfirmation("");
    setPasswordError(problems.password);
    setConfirmationError(problems.confirmation);
    setAcknowledgedError(problems.acknowledged);
    setError(undefined);
    if (Object.keys(problems).length) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setPasswordError(undefined);
    try {
      const saved = await submitAccountPassword(
        account,
        newPassword,
        review.version() ?? account.version,
        authApi.resetAccountPassword,
        () => {
          if (mounted.current) setPassword("");
        },
      );
      if (!mounted.current) return;
      await onSaved(saved);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof AccountFormError) setPasswordError(cause.message);
      else {
        setError(cause instanceof Error ? cause.message : "The password could not be reset.");
        if (cause instanceof InvestigationHttpError && cause.status === 409) review.markConflict();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={close} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Reset password for {account.username}</DialogTitle>
      <DialogContent dividers>
        <Box component="form" id={formId} noValidate onSubmit={(event) => void submit(event)}>
          <Stack spacing={2}>
            <Alert severity="warning">
              This ends every session for this account. Share the new password with the account
              owner through a secure channel. They will need it to sign in again.
            </Alert>
            <TextField
              label="Username"
              autoComplete="username"
              value={account.username}
              slotProps={{ input: { readOnly: true } }}
            />
            <PasswordField
              autoFocus
              label="New password"
              name="newPassword"
              autoComplete="new-password"
              required
              disabled={busy}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(undefined);
              }}
              error={!!passwordError}
              helperText={passwordError ?? "15–128 characters."}
            />
            <PasswordField
              label="Confirm new password"
              name="confirmPassword"
              autoComplete="new-password"
              required
              disabled={busy}
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setConfirmationError(undefined);
              }}
              error={!!confirmationError}
              helperText={confirmationError}
            />
            <Box>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={acknowledged}
                    disabled={busy}
                    slotProps={{
                      input: {
                        "aria-invalid": !!acknowledgedError,
                        "aria-describedby": acknowledgedError ? acknowledgmentId : undefined,
                      },
                    }}
                    onChange={(_, checked) => {
                      setAcknowledged(checked);
                      setAcknowledgedError(undefined);
                    }}
                  />
                }
                label="I understand this account will be signed out everywhere."
              />
              {acknowledgedError && (
                <Typography id={acknowledgmentId} role="alert" color="error" variant="body2">
                  {acknowledgedError}
                </Typography>
              )}
            </Box>
            {error && <Alert severity="error">{error}</Alert>}
            <AccountConflictNotice review={review} disabled={busy} />
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button disabled={busy || review.loading} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="contained"
          disabled={busy || review.loading || !review.ready}
        >
          {busy ? "Resetting…" : "Reset password"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AdminAccountsPage() {
  const { session, refresh, requireSignIn } = useInvestigationSession();
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: accountsQueryKey,
    queryFn: authApi.listAccounts,
    retry: false,
    retryOnMount: false,
  });
  const [lastLoadError, setLastLoadError] = useState(() => accounts.error?.message);
  useEffect(() => {
    if (accounts.isError) setLastLoadError(accounts.error.message);
    else if (accounts.isSuccess) setLastLoadError(undefined);
  }, [accounts.isError, accounts.isSuccess, accounts.error]);
  const repositories = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
  });
  const [editor, setEditor] = useState<{ account?: Account }>();
  const [passwordAccount, setPasswordAccount] = useState<Account>();
  const [notice, setNotice] = useState<string>();
  const [parameters, setParameters] = useSearchParams();
  const { search, filter } = accountDirectoryFilters(parameters.toString());
  const setView = (nextSearch: string, nextFilter: AccountDirectoryFilter, replace = false) => {
    const next = new URLSearchParams();
    if (nextSearch) next.set("q", nextSearch.slice(0, 200));
    if (nextFilter !== "all") next.set("status", nextFilter);
    setParameters(next, { replace });
  };
  const guardedAction = useGuardedAction();
  const visibleAccounts = filterAccounts(accounts.data?.items ?? [], search, filter);
  const reloadAccount = async (id: string) => {
    const result = await accounts.refetch();
    if (result.isError) throw result.error;
    const account = result.data?.items.find((item) => item.id === id);
    if (!account) {
      throw new Error("This account is no longer available. Close this form and refresh the list.");
    }
    return account;
  };
  const onSaved = async (account: Account, created: boolean) => {
    setEditor(undefined);
    if (created) {
      setView("", "all", true);
    }
    setNotice(`${account.username} was ${created ? "created" : "updated"}.`);
    if (account.id === session.user?.id) await refresh();
    await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
  };
  const onPasswordSaved = async (account: Account) => {
    setPasswordAccount(undefined);
    if (account.id === session.user?.id) {
      await requireSignIn("Your password was reset. Sign in again.");
      return;
    }
    setNotice(`The password for ${account.username} was reset. Its active sessions have ended.`);
    await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
  };
  return (
    <Stack spacing={3.5} sx={{ minWidth: 0 }}>
      <PageHeading
        title="Accounts"
        action={
          <Button
            variant="contained"
            startIcon={<AddOutlined />}
            onClick={() => guardedAction(() => setEditor({}))}
          >
            Create account
          </Button>
        }
      />
      {notice && (
        <Alert severity="success" onClose={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        useFlexGap
        sx={{ alignItems: { sm: "center" }, flexWrap: "wrap" }}
      >
        <TextField
          label="Search accounts"
          value={search}
          onChange={(event) => setView(event.target.value, filter, true)}
          placeholder="Name or username"
          size="small"
          sx={{ width: { xs: "100%", sm: 340 }, maxWidth: "100%" }}
          slotProps={{
            htmlInput: { maxLength: 200 },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlined />
                </InputAdornment>
              ),
            },
          }}
        />
        <Stack
          direction="row"
          spacing={1}
          role="group"
          aria-label="Account status"
          sx={{ flex: 1, flexWrap: "wrap" }}
          useFlexGap
        >
          {(["all", "enabled", "disabled"] as const).map((value) => (
            <Chip
              key={value}
              label={value === "all" ? "All" : value === "enabled" ? "Enabled" : "Disabled"}
              component="button"
              type="button"
              clickable
              aria-pressed={filter === value}
              color={filter === value ? "primary" : "default"}
              variant={filter === value ? "filled" : "outlined"}
              onClick={() => setView(search, value)}
              sx={{ minHeight: 44, "@media (pointer: coarse)": { minHeight: 48 } }}
            />
          ))}
        </Stack>
        <Button
          disabled={accounts.isFetching}
          onClick={() =>
            guardedAction(() => {
              void accounts.refetch();
            })
          }
          sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}
        >
          {accounts.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </Stack>
      {accounts.isPending && (
        <Stack direction="row" spacing={2} role="status" sx={{ alignItems: "center" }}>
          <CircularProgress size={28} />
          <Typography>Loading accounts…</Typography>
        </Stack>
      )}
      {(accounts.error?.message ?? lastLoadError) && (
        <Alert severity="error">{accounts.error?.message ?? lastLoadError}</Alert>
      )}
      {accounts.data?.items.length === 0 && (
        <Surface>
          <EmptyState title="No accounts yet" description="Create an account to grant access." />
        </Surface>
      )}
      {!!accounts.data?.items.length && (
        <Surface sx={{ p: 0, overflow: "hidden" }}>
          <Box
            aria-hidden="true"
            sx={{
              display: { xs: "none", lg: "grid" },
              gridTemplateColumns: "minmax(220px,1.5fr) minmax(150px,1fr) 100px",
              alignItems: "center",
              gap: 2,
              py: 1.5,
              px: 3,
              bgcolor: "action.hover",
              color: "text.secondary",
              fontSize: 12,
            }}
          >
            <Box>Account</Box>
            <Box>Repository access</Box>
            <Box>Status</Box>
          </Box>
          {visibleAccounts.map((account) => (
            <Box
              component="article"
              key={account.id}
              aria-label={`Account ${account.username}`}
              sx={{
                px: { xs: 2, lg: 3 },
                py: { xs: 2, lg: 1.5 },
                minHeight: 88,
                borderBottom: 1,
                borderColor: "divider",
                display: "grid",
                gridTemplateColumns: {
                  xs: "minmax(0,1fr) auto",
                  lg: "minmax(220px,1.5fr) minmax(150px,1fr) 100px",
                },
                alignItems: "center",
                gap: { xs: 1.25, lg: 2 },
              }}
            >
              <Button
                onClick={() => guardedAction(() => setEditor({ account }))}
                aria-label={`Open account ${account.username}`}
                sx={{
                  gridColumn: 1,
                  gridRow: 1,
                  p: 0,
                  minWidth: 0,
                  minHeight: 48,
                  gap: 1.75,
                  justifyContent: "flex-start",
                  color: "text.primary",
                  textAlign: "left",
                  "&:hover .account-name": {
                    textDecoration: "underline",
                    textUnderlineOffset: "4px",
                  },
                }}
              >
                <Avatar
                  aria-hidden="true"
                  sx={{
                    width: 44,
                    height: 44,
                    fontSize: 14,
                    color: "primary.main",
                    bgcolor: "action.selected",
                  }}
                >
                  {accountInitials(account.displayName)}
                </Avatar>
                <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <Typography className="account-name" sx={{ fontWeight: 500, fontSize: 16 }}>
                    {account.displayName}
                    {account.isAdmin && (
                      <Chip component="span" label="Admin" size="small" sx={{ ml: 1 }} />
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                    @{account.username}
                    {account.id === session.user?.id ? " · You" : ""}
                  </Typography>
                </Box>
              </Button>
              <Box
                sx={{
                  gridColumn: { xs: 1, lg: 2 },
                  gridRow: { xs: 2, lg: 1 },
                  ml: { xs: 7.25, lg: 0 },
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: { xs: "block", lg: "none" } }}
                >
                  Repository access
                </Typography>
                <Typography variant="body2" title={account.repositoryIds.join(", ")}>
                  {account.repositoryIds.length === 0
                    ? "No repositories"
                    : `${account.repositoryIds.length} ${account.repositoryIds.length === 1 ? "repository" : "repositories"}`}
                </Typography>
              </Box>
              <Chip
                label={account.enabled ? "Enabled" : "Disabled"}
                size="small"
                color={account.enabled ? "success" : "default"}
                variant="outlined"
                sx={{ gridColumn: { xs: 2, lg: 3 }, gridRow: 1, justifySelf: "end" }}
              />
            </Box>
          ))}
          {visibleAccounts.length === 0 && (
            <EmptyState
              title="No matching accounts"
              description="Try another name, username, or status."
              action={
                <Button
                  onClick={() => {
                    setView("", "all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )}
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            sx={{
              px: { xs: 2, lg: 3 },
              py: 2,
              justifyContent: "space-between",
              color: "text.secondary",
            }}
          >
            <Typography role="status" variant="body2" sx={{ fontSize: 13 }}>
              {visibleAccounts.length} of {accounts.data?.items.length ?? 0} accounts
            </Typography>
          </Stack>
        </Surface>
      )}
      {editor && (
        <AccountEditor
          key={editor.account?.id ?? "new-account"}
          account={editor.account}
          repositories={repositories.data?.items ?? []}
          repositoriesUnavailable={repositories.isError}
          onClose={() => setEditor(undefined)}
          onSaved={onSaved}
          reloadAccount={reloadAccount}
          onResetPassword={(account) => {
            setEditor(undefined);
            setPasswordAccount(account);
          }}
        />
      )}
      {passwordAccount && (
        <ResetPasswordDialog
          key={passwordAccount.id}
          account={passwordAccount}
          onClose={() => setPasswordAccount(undefined)}
          onSaved={onPasswordSaved}
          reloadAccount={reloadAccount}
        />
      )}
    </Stack>
  );
}

export default function AccountsPage() {
  const { session } = useInvestigationSession();
  if (!session.authenticated || !session.user?.isAdmin) {
    return (
      <Stack spacing={3.5}>
        <PageHeading title="Accounts" subtitle="Give each person the access they need." />
        <Surface>
          <EmptyState
            title="Administrator access is required to manage accounts."
            description="You can review your own access and change your password in My account. Ask a workspace administrator to change your permissions."
            icon={<AdminPanelSettingsOutlined sx={{ fontSize: 32 }} />}
          />
        </Surface>
      </Stack>
    );
  }
  return <AdminAccountsPage />;
}
