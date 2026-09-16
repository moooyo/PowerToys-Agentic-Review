import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  INVESTIGATION_PASSWORD_MIN_LENGTH,
  InvestigationActionKindSchema,
} from "@agentic-review/contracts";
import {
  Alert,
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
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  AccountFormError,
  type AccountFormValues,
  accountFormValues,
  accountWriteVersion,
  permissionOptions,
  submitAccountForm,
  submitAccountPassword,
} from "./account-form";
import { actionLabels } from "./action-panel";
import { investigationApi, type Repository } from "./api";
import { type Account, authApi } from "./auth-api";
import { useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

const accountsQueryKey = ["investigation-accounts"];
const actionOptions = InvestigationActionKindSchema.anyOf.map((schema) => schema.const);

function toggleValue<T extends string>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
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
        setLatest(await reload(account.id));
      } catch (cause) {
        setLatest(undefined);
        setError(cause instanceof Error ? cause.message : "The account could not be refreshed.");
      } finally {
        setLoading(false);
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
        This account changed or could not accept this update. Your non-password fields are still in
        this form. Refresh the account and review its current access before trying again.
      </Alert>
      <Button
        variant="outlined"
        disabled={disabled || review.loading}
        onClick={() => void review.refresh()}
        sx={{ alignSelf: "flex-start" }}
      >
        {review.loading ? "Refreshing account…" : "Refresh account for review"}
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
            label="I reviewed the latest account and want to apply this form."
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
  const selectedRepositoryIds = form.repositoryIdsText.split(/[\s,]+/u).filter(Boolean);
  const toggleRepository = (id: string, checked: boolean) => {
    setField("repositoryIdsText", toggleValue(selectedRepositoryIds, id, checked).join("\n"));
  };
  return (
    <Stack spacing={2.5}>
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1">
          Account administration
        </Typography>
        <FormControlLabel
          control={
            <Checkbox checked={form.isAdmin} onChange={(_, value) => setField("isAdmin", value)} />
          }
          label="Administrator"
        />
        <Typography variant="body2" color="text.secondary">
          Administrators can manage every local account. Repository access and business permissions
          are granted separately below.
        </Typography>
      </Box>
      <Divider />
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1" sx={{ mb: 1.5 }}>
          Repository access
        </Typography>
        <TextField
          label="Repository IDs"
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          value={form.repositoryIdsText}
          onChange={(event) => setField("repositoryIdsText", event.target.value)}
          error={!!repositoryError}
          helperText={
            repositoryError ??
            "Enter exact IDs separated by commas or new lines. An empty list grants no repositories."
          }
        />
        {!!repositories.length && (
          <Box sx={{ mt: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              Add from repositories visible to your account:
            </Typography>
            <FormGroup>
              {repositories.map((repository) => (
                <FormControlLabel
                  key={repository.id}
                  sx={{ overflowWrap: "anywhere" }}
                  control={
                    <Checkbox
                      checked={selectedRepositoryIds.includes(repository.id)}
                      onChange={(_, checked) => toggleRepository(repository.id, checked)}
                    />
                  }
                  label={`${repository.fullName} (${repository.id})`}
                />
              ))}
            </FormGroup>
          </Box>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {repositoriesUnavailable
            ? "The repository directory is unavailable. You can still enter exact repository IDs."
            : "You can enter registered repository IDs that are outside your own repository access."}
        </Typography>
      </Box>
      <Divider />
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1">
          Business permissions
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
      <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle1">
          Allowed actions
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Select which actions this account may use within its repository and business permissions.
        </Typography>
        <FormGroup sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
          {actionOptions.map((action) => (
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
      <FormControlLabel
        control={
          <Checkbox
            checked={form.allowRepositoryExecution}
            onChange={(_, value) => setField("allowRepositoryExecution", value)}
          />
        }
        label="Allow repository code execution"
      />
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
}: {
  account?: Account;
  repositories: Repository[];
  repositoriesUnavailable: boolean;
  onClose: () => void;
  onSaved: (account: Account, created: boolean) => Promise<void>;
  reloadAccount: (id: string) => Promise<Account>;
}) {
  const formId = useId();
  const titleId = useId();
  const [form, setForm] = useState(() => accountFormValues(account));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<AccountFormError>();
  const review = useAccountReview(account, reloadAccount);
  const setField = <K extends keyof AccountFormValues>(field: K, value: AccountFormValues[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (fieldError?.field === field) setFieldError(undefined);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      const saved = await submitAccountForm(form, account, review.version(), authApi, () =>
        setForm((current) => ({ ...current, password: "" })),
      );
      await onSaved(saved, !account);
    } catch (cause) {
      if (cause instanceof AccountFormError) setFieldError(cause);
      else {
        setError(cause instanceof Error ? cause.message : "The account could not be saved.");
        if (account && cause instanceof InvestigationHttpError && cause.status === 409) {
          review.markConflict();
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      onClose={() => !busy && onClose()}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>
        {account ? `Edit ${account.username}` : "Create account"}
      </DialogTitle>
      <DialogContent dividers>
        <Box component="form" id={formId} noValidate onSubmit={(event) => void submit(event)}>
          <Box component="fieldset" disabled={busy} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
            <Stack spacing={2.5}>
              <TextField
                autoFocus
                label="Username"
                autoComplete="username"
                required
                fullWidth
                value={form.username}
                slotProps={{ input: { readOnly: !!account }, htmlInput: { maxLength: 128 } }}
                onChange={(event) => setField("username", event.target.value)}
                error={fieldError?.field === "username"}
                helperText={
                  fieldError?.field === "username"
                    ? fieldError.message
                    : account
                      ? "Usernames cannot be changed."
                      : "3–64 letters, numbers, periods, underscores, or hyphens. Saved in lowercase."
                }
              />
              <TextField
                label="Display name"
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
                <TextField
                  label="Password"
                  type="password"
                  autoComplete="new-password"
                  required
                  fullWidth
                  value={form.password}
                  onChange={(event) => setField("password", event.target.value)}
                  slotProps={{
                    htmlInput: {
                      minLength: INVESTIGATION_PASSWORD_MIN_LENGTH,
                      maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2,
                    },
                  }}
                  error={fieldError?.field === "password"}
                  helperText={
                    fieldError?.field === "password"
                      ? fieldError.message
                      : "Use 15–128 characters. The password field is cleared after each attempt."
                  }
                />
              )}
              {account && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.enabled}
                      onChange={(_, value) => setField("enabled", value)}
                    />
                  }
                  label="Account enabled"
                />
              )}
              <AccountAccessFields
                form={form}
                setField={setField}
                repositories={repositories}
                repositoriesUnavailable={repositoriesUnavailable}
                repositoryError={
                  fieldError?.field === "repositoryIdsText" ? fieldError.message : undefined
                }
              />
            </Stack>
          </Box>
          <Stack spacing={2} sx={{ mt: 2 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <AccountConflictNotice review={review} disabled={busy} />
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="contained"
          disabled={busy || review.loading || !review.ready}
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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const review = useAccountReview(account, reloadAccount);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setPasswordError(undefined);
    try {
      const saved = await submitAccountPassword(
        account,
        password,
        review.version() ?? account.version,
        authApi.resetAccountPassword,
        () => setPassword(""),
      );
      await onSaved(saved);
    } catch (cause) {
      if (cause instanceof AccountFormError) setPasswordError(cause.message);
      else {
        setError(cause instanceof Error ? cause.message : "The password could not be reset.");
        if (cause instanceof InvestigationHttpError && cause.status === 409) review.markConflict();
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={() => !busy && onClose()}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>Reset password for {account.username}</DialogTitle>
      <DialogContent dividers>
        <Box component="form" id={formId} noValidate onSubmit={(event) => void submit(event)}>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              Set a new password for this account. Its active sessions will end, and the account
              will need to sign in again.
            </Typography>
            <TextField
              label="Username"
              autoComplete="username"
              value={account.username}
              slotProps={{ input: { readOnly: true } }}
            />
            <TextField
              autoFocus
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              disabled={busy}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(undefined);
              }}
              slotProps={{
                htmlInput: {
                  minLength: INVESTIGATION_PASSWORD_MIN_LENGTH,
                  maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2,
                },
              }}
              error={!!passwordError}
              helperText={
                passwordError ?? "Use 15–128 characters. Enter it again after a failed attempt."
              }
            />
            {error && <Alert severity="error">{error}</Alert>}
            <AccountConflictNotice review={review} disabled={busy} />
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={onClose}>
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
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ justifyContent: "space-between", alignItems: { sm: "flex-start" } }}
      >
        <Box>
          <Typography variant="h4">Accounts</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            Manage local sign-in accounts and grant access to investigation work.
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => setEditor({})} sx={{ flexShrink: 0 }}>
          Create account
        </Button>
      </Stack>
      {notice && (
        <Alert severity="success" onClose={() => setNotice(undefined)}>
          {notice}
        </Alert>
      )}
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography variant="subtitle1">
          {accounts.data ? `${accounts.data.items.length} local accounts` : "Local accounts"}
        </Typography>
        <Button disabled={accounts.isFetching} onClick={() => void accounts.refetch()}>
          {accounts.isFetching ? "Refreshing…" : "Refresh accounts"}
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
        <Alert severity="info">
          No local accounts are available. Create an account to grant access.
        </Alert>
      )}
      <Stack spacing={2}>
        {accounts.data?.items.map((account) => (
          <Paper
            component="article"
            variant="outlined"
            key={account.id}
            sx={{ p: { xs: 2, sm: 2.5 }, borderRadius: 3 }}
          >
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              sx={{ justifyContent: "space-between", alignItems: { sm: "flex-start" } }}
            >
              <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                <Typography variant="h6">{account.displayName}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  @{account.username}
                  {account.id === session.user?.id ? " · You" : ""}
                </Typography>
                <AccountAccessSummary account={account} />
              </Box>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: "wrap", flexShrink: 0 }}
              >
                <Button
                  variant="outlined"
                  aria-label={`Edit account ${account.username}`}
                  onClick={() => setEditor({ account })}
                >
                  Edit account
                </Button>
                <Button
                  aria-label={`Reset password for ${account.username}`}
                  onClick={() => setPasswordAccount(account)}
                >
                  Reset password
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {editor && (
        <AccountEditor
          account={editor.account}
          repositories={repositories.data?.items ?? []}
          repositoriesUnavailable={repositories.isError}
          onClose={() => setEditor(undefined)}
          onSaved={onSaved}
          reloadAccount={reloadAccount}
        />
      )}
      {passwordAccount && (
        <ResetPasswordDialog
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
    return <Alert severity="warning">Administrator access is required to manage accounts.</Alert>;
  }
  return <AdminAccountsPage />;
}
