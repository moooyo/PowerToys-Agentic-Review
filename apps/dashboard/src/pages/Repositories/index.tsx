import type {
  GitHubRepository,
  ManagedRepository,
  ManagedRepositorySummary,
} from "@agentic-review/contracts";
import { Add, CheckCircle, Close, GitHub, Refresh, Search } from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  TablePagination,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { RepositoryConfigurationActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { PublicationPolicy } from "@/components/PublicationPolicy";
import { RepositoryAccessDrawer } from "@/components/RepositoryAccess";
import { RepositorySchedulingPolicy } from "@/components/SchedulingPolicy";
import {
  SchedulingLimitFields,
  SchedulingLimitFieldsProvider,
} from "@/components/SchedulingPolicy/LimitFields";
import { DataTable, DetailsGrid, EmptyState, notify } from "@/components/ui";
import { repositories } from "@/services/repositories";
import { schedulingPolicyQueryRoot } from "@/services/scheduling-policy";
import { useOperatorSession } from "@/state/session";
import {
  buildRepositoryUpdate,
  isConfigurationConflict,
  type RepositorySettingsValues,
  repositorySettingsValues,
} from "./form";

const connectionLabels = { unknown: "Not checked", ready: "Connected", error: "Connection error" };
const repositoryNamePattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

function RepositoryPanel({
  title,
  children,
  onClose,
  busy = false,
  width = 600,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  width?: number;
  actions?: ReactNode;
}) {
  return (
    <Drawer
      open
      anchor="right"
      onClose={() => {
        if (!busy) onClose();
      }}
      slotProps={{ paper: { sx: { width: { xs: "100%", sm: width }, maxWidth: "100%" } } }}
    >
      <Stack
        direction="row"
        sx={{
          px: 3,
          py: 2,
          minHeight: 72,
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
          {title}
        </Typography>
        <IconButton aria-label="Close repository panel" disabled={busy} onClick={onClose}>
          <Close />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: { xs: 2, sm: 3 }, flex: 1, overflowY: "auto" }}>{children}</Box>
      {actions && (
        <>
          <Divider />
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              px: 3,
              py: 2,
              bgcolor: "background.default",
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            {actions}
          </Stack>
        </>
      )}
    </Drawer>
  );
}

function Connection({ repository }: { repository: ManagedRepositorySummary }) {
  return (
    <Stack spacing={1} sx={{ alignItems: "flex-start", minWidth: 0 }}>
      <Chip
        size="medium"
        variant="outlined"
        color={
          repository.connectionStatus === "ready"
            ? "success"
            : repository.connectionStatus === "error"
              ? "error"
              : "default"
        }
        label={connectionLabels[repository.connectionStatus]}
      />
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {repository.connectionMessage ??
          (repository.connectionStatus === "unknown"
            ? "Run a connection check to verify GitHub access."
            : repository.connectionStatus === "ready"
              ? "GitHub access verified."
              : "Check the repository configuration and try again.")}
      </Typography>
    </Stack>
  );
}

function AddRepositoryDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (repository: ManagedRepository) => void;
}) {
  const operatorAccess = useOperatorAccess();
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [resolved, setResolved] = useState<GitHubRepository | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const resolve = async () => {
    if (!operatorAccess.platformAdministrator || operatorAccess.checking) return;
    const fullName = name.trim();
    if (!repositoryNamePattern.test(fullName)) {
      setError("Enter a GitHub repository in owner/repository format.");
      return;
    }
    const request = ++generation.current;
    setResolving(true);
    setResolved(null);
    setError(null);
    try {
      const result = await repositories.resolve(fullName);
      if (request === generation.current) setResolved(result);
    } catch (failure) {
      if (request === generation.current) setError(errorMessage(failure));
    } finally {
      if (request === generation.current) setResolving(false);
    }
  };
  const create = async () => {
    if (!resolved || creating || !operatorAccess.platformAdministrator || operatorAccess.checking)
      return;
    setCreating(true);
    setError(null);
    try {
      const result = await repositories.create({
        fullName: resolved.fullName,
        githubRepositoryId: resolved.githubRepositoryId,
        enabled,
      });
      onCreated(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setCreating(false);
    }
  };
  return (
    <RepositoryPanel
      title="Add repository"
      width={560}
      onClose={onClose}
      busy={creating}
      actions={
        <>
          <Button disabled={creating} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={
              !resolved ||
              resolving ||
              !operatorAccess.platformAdministrator ||
              operatorAccess.checking
            }
            loading={creating}
            onClick={() => void create()}
          >
            Add repository
          </Button>
        </>
      }
    >
      <Stack spacing={2.5}>
        <Typography variant="body2" color="text.secondary">
          Find a repository on GitHub, then add it to your review workspace.
        </Typography>
        <Stack
          component="form"
          spacing={1.5}
          onSubmit={(event) => {
            event.preventDefault();
            void resolve();
          }}
        >
          <TextField
            id="repository-full-name"
            label="GitHub repository"
            required
            fullWidth
            placeholder="owner/repository"
            slotProps={{ htmlInput: { maxLength: 201 } }}
            disabled={creating}
            value={name}
            onChange={(event) => {
              generation.current += 1;
              setName(event.target.value);
              setResolved(null);
              setResolving(false);
              setError(null);
            }}
          />
          <Button
            type="submit"
            variant="outlined"
            loading={resolving}
            disabled={
              creating ||
              !name.trim() ||
              !operatorAccess.platformAdministrator ||
              operatorAccess.checking
            }
            sx={{ alignSelf: "flex-start" }}
          >
            Find repository
          </Button>
        </Stack>
        {error && (
          <Alert severity="error">
            <AlertTitle>Could not add repository</AlertTitle>
            {error}
          </Alert>
        )}
        {resolved && (
          <Box sx={{ p: 3, borderRadius: 3, bgcolor: "background.default" }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
              <CheckCircle color="success" fontSize="small" />
              <Typography variant="subtitle1">Repository found</Typography>
            </Stack>
            <DetailsGrid
              columns={1}
              items={[
                {
                  key: "name",
                  label: "Repository",
                  value: (
                    <Link href={resolved.htmlUrl} target="_blank" rel="noreferrer">
                      {resolved.fullName}
                    </Link>
                  ),
                },
                {
                  key: "visibility",
                  label: "Visibility",
                  value: resolved.isPrivate ? "Private" : "Public",
                },
                {
                  key: "branch",
                  label: "Default branch",
                  value: <code>{resolved.defaultBranch}</code>,
                },
                {
                  key: "id",
                  label: "GitHub repository ID",
                  value: <code>{resolved.githubRepositoryId}</code>,
                },
              ]}
            />
          </Box>
        )}
        <Box>
          <FormControlLabel
            label="Enable repository"
            control={
              <Switch
                id="repository-create-enabled"
                checked={enabled}
                onChange={(_, checked) => setEnabled(checked)}
                disabled={creating}
              />
            }
          />
          <Typography variant="body2" color="text.secondary">
            Allow this repository to participate in synchronization and scheduling.
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          New repositories inherit the default reviewer and authorization policy. You can change
          these after adding the repository.
        </Typography>
      </Stack>
    </RepositoryPanel>
  );
}

function RepositorySettingsDrawer({
  repositoryId,
  onClose,
  onSaved,
}: {
  repositoryId: string;
  onClose: () => void;
  onSaved: (repository: ManagedRepository) => void;
}) {
  const operatorAccess = useOperatorAccess(repositoryId);
  const { initialState } = useOperatorSession();
  const [values, setValues] = useState<RepositorySettingsValues | null>(null);
  const [baseline, setBaseline] = useState<ManagedRepository | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState(false);
  const repositoryQuery = useQuery({
    queryKey: [
      "managed-repositories",
      "detail",
      repositoryId,
      ...operatorAccess.identityKey,
      initialState?.authenticationEpoch ?? 0,
    ],
    queryFn: ({ signal }) => repositories.get(repositoryId, signal),
    enabled: operatorAccess.can("configure"),
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (repositoryQuery.data && !baseline) {
      setBaseline(repositoryQuery.data);
      setValues(repositorySettingsValues(repositoryQuery.data));
    }
  }, [repositoryQuery.data, baseline]);
  const update = <K extends keyof RepositorySettingsValues>(
    key: K,
    value: RepositorySettingsValues[K],
  ) => {
    setValues((current) => (current ? { ...current, [key]: value } : current));
    setDirty(true);
  };
  const reloadLatest = async () => {
    try {
      const result = await repositoryQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      setValues(repositorySettingsValues(result.data));
      setConflict(false);
      setDirty(false);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const save = async () => {
    if (!baseline || !values || !dirty || saving || conflict || !operatorAccess.can("configure"))
      return;
    setSaving(true);
    setError(null);
    try {
      if (
        values.reviewerMode === "custom" &&
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(values.reviewerGithubLogin)
      ) {
        throw new Error(
          "Use up to 39 letters, numbers, or hyphens, starting with a letter or number.",
        );
      }
      const result = await repositories.update(
        repositoryId,
        buildRepositoryUpdate(values, baseline.version),
      );
      onSaved(result);
    } catch (failure) {
      setConflict(isConfigurationConflict(failure));
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const disabled = saving || !operatorAccess.can("configure");
  return (
    <RepositoryPanel
      title={baseline ? `Settings · ${baseline.fullName}` : "Repository settings"}
      onClose={onClose}
      busy={saving}
      actions={
        <>
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="contained"
            type="submit"
            form="repository-settings-form"
            loading={saving}
            disabled={
              !baseline ||
              !dirty ||
              conflict ||
              repositoryQuery.isFetching ||
              !operatorAccess.can("configure")
            }
          >
            Save changes
          </Button>
        </>
      }
    >
      {!baseline && repositoryQuery.isPending && <Skeleton variant="rounded" height={400} />}
      {!baseline && repositoryQuery.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void reloadLatest()}>Try again</Button>}
        >
          <AlertTitle>Could not load repository settings</AlertTitle>
          {errorMessage(repositoryQuery.error)}
        </Alert>
      )}
      {baseline && values && (
        <Stack
          component="form"
          id="repository-settings-form"
          spacing={4}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DetailsGrid
            columns={1}
            items={[
              { key: "repository", label: "Repository", value: baseline.fullName },
              {
                key: "github-id",
                label: "GitHub repository ID",
                value: <code>{baseline.githubRepositoryId}</code>,
              },
            ]}
          />
          <Divider />
          {conflict ? (
            <Alert
              severity="warning"
              action={
                <Button loading={repositoryQuery.isFetching} onClick={() => void reloadLatest()}>
                  Reload latest settings
                </Button>
              }
            >
              <AlertTitle>These settings changed while you were editing</AlertTitle>
              <Typography variant="body2">{error}</Typography>
              <Typography variant="body2">
                Your changes have not been saved. Reload the latest settings, then reapply your
                changes. Reloading replaces this draft.
              </Typography>
            </Alert>
          ) : error ? (
            <Alert severity="error">
              <AlertTitle>Could not save changes</AlertTitle>
              {error}
            </Alert>
          ) : null}
          <Box>
            <FormControlLabel
              label="Enable repository"
              control={
                <Switch
                  checked={values.enabled}
                  disabled={disabled}
                  onChange={(_, checked) => update("enabled", checked)}
                />
              }
            />
            <Typography variant="body2" color="text.secondary">
              Disabled repositories do not participate in new synchronization or scheduling.
            </Typography>
          </Box>
          <Divider />
          <Stack component="section" spacing={3} aria-labelledby="repository-scheduling-heading">
            <Typography id="repository-scheduling-heading" variant="subtitle1">
              Scheduling
            </Typography>
            <SchedulingLimitFieldsProvider
              values={values}
              disabled={disabled}
              onChange={(next) => {
                setValues((current) => (current ? { ...current, ...next } : current));
                setDirty(true);
              }}
            >
              <SchedulingLimitFields />
            </SchedulingLimitFieldsProvider>
            <Typography variant="body2" color="text.secondary">
              Unlimited at repository scope still obeys global limits and Worker constraints.
            </Typography>
          </Stack>
          <Divider />
          <Stack component="section" spacing={3} aria-labelledby="repository-reviewer-heading">
            <Typography id="repository-reviewer-heading" variant="subtitle1">
              Reviewer
            </Typography>
            <TextField
              select
              label="Reviewer configuration"
              value={values.reviewerMode}
              disabled={disabled}
              onChange={(event) =>
                update(
                  "reviewerMode",
                  event.target.value as RepositorySettingsValues["reviewerMode"],
                )
              }
            >
              <MenuItem value="inherit">Inherit default reviewer</MenuItem>
              <MenuItem value="custom">Configure for this repository</MenuItem>
            </TextField>
            {values.reviewerMode === "custom" ? (
              <>
                <TextField
                  label="Reviewer GitHub user ID"
                  required
                  value={values.reviewerGithubUserId}
                  disabled={disabled}
                  onChange={(event) => update("reviewerGithubUserId", event.target.value)}
                  placeholder="e.g. 12345678"
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 16 } }}
                  helperText="Numeric identity used for scheduling. Configure the ID and login together."
                />
                <TextField
                  label="Reviewer GitHub login"
                  required
                  value={values.reviewerGithubLogin}
                  disabled={disabled}
                  onChange={(event) => update("reviewerGithubLogin", event.target.value)}
                  placeholder="e.g. review-bot"
                  slotProps={{ htmlInput: { maxLength: 39 } }}
                  helperText="The login of the configured reviewer account. The numeric ID determines authorization."
                />
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Uses the server's default reviewer ID and login.
              </Typography>
            )}
          </Stack>
          <Divider />
          <Stack component="section" spacing={3} aria-labelledby="repository-authorization-heading">
            <Typography id="repository-authorization-heading" variant="subtitle1">
              Authorization
            </Typography>
            <TextField
              select
              label="Authorization policy"
              value={values.policyMode}
              disabled={disabled}
              onChange={(event) =>
                update("policyMode", event.target.value as RepositorySettingsValues["policyMode"])
              }
            >
              <MenuItem value="inherit">Inherit default policy</MenuItem>
              <MenuItem value="custom">Self or allowlisted actors</MenuItem>
            </TextField>
            {values.policyMode === "custom" ? (
              <>
                {values.reviewerMode === "inherit" && (
                  <Alert severity="warning">
                    Configure a reviewer above to use a custom authorization policy.
                  </Alert>
                )}
                <Typography variant="body2" color="text.secondary">
                  The configured reviewer can authorize requests for itself. Allowlisted actors can
                  also authorize requests for this reviewer. Unknown actors are always denied.
                </Typography>
                <TextField
                  label="Scheduling target GitHub user ID"
                  required
                  value={values.schedulingTargetGithubUserId}
                  disabled={disabled}
                  onChange={(event) => update("schedulingTargetGithubUserId", event.target.value)}
                  placeholder="GitHub user ID"
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 16 } }}
                  helperText="Must match the configured reviewer ID above. This account receives review requests and assignments."
                />
                <TextField
                  label="Allowlisted actor IDs"
                  multiline
                  minRows={3}
                  maxRows={8}
                  value={values.allowlistedActorGithubUserIds}
                  disabled={disabled}
                  onChange={(event) => update("allowlistedActorGithubUserIds", event.target.value)}
                  placeholder={"12345678\n87654321"}
                  helperText="Enter numeric GitHub user IDs, one per line or separated by commas. An empty list permits only self-requests."
                  sx={{ "& textarea": { fontFamily: '"Roboto Mono", monospace' } }}
                />
                <TextField
                  select
                  label="When a pull request receives new commits"
                  value={values.newRevisionPolicy}
                  disabled={disabled}
                  onChange={(event) =>
                    update(
                      "newRevisionPolicy",
                      event.target.value as RepositorySettingsValues["newRevisionPolicy"],
                    )
                  }
                >
                  <MenuItem value="default">Default: require a new authorization</MenuItem>
                  <MenuItem value="require_new_authorization">Require a new authorization</MenuItem>
                  <MenuItem value="inherit_authorized_epoch">
                    Carry authorization forward while the request is active
                  </MenuItem>
                </TextField>
                <TextField
                  label="Policy version"
                  required
                  value={values.policyVersion}
                  disabled={disabled}
                  onChange={(event) => update("policyVersion", event.target.value)}
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 16 } }}
                  helperText="Version recorded with authorization decisions. Set this explicitly when revising your policy."
                />
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Uses the server's default authorization policy, including who may request reviews
                and how new commits are authorized.
              </Typography>
            )}
          </Stack>
        </Stack>
      )}
    </RepositoryPanel>
  );
}

function RepositoryManagement({
  repository,
  onUpdated,
}: {
  repository: ManagedRepositorySummary;
  onUpdated: () => void;
}) {
  const operatorAccess = useOperatorAccess(repository.id);
  const { initialState } = useOperatorSession();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const checkConnection = async () => {
    if (!operatorAccess.can("configure") || checking) return;
    setChecking(true);
    setConnectionNotice(null);
    try {
      const result = await repositories.checkConnection(repository.id);
      setConnectionNotice({
        success: result.connectionStatus === "ready",
        message:
          result.connectionStatus === "ready"
            ? `Connection verified for ${result.fullName}.`
            : (result.connectionMessage ?? "The connection could not be verified."),
      });
      onUpdated();
    } catch (failure) {
      setConnectionNotice({ success: false, message: errorMessage(failure) });
    } finally {
      setChecking(false);
    }
  };
  const refreshAccess = () => {
    void queryClient.invalidateQueries({ queryKey: ["operator-access"] });
    onUpdated();
  };
  return (
    <Stack spacing={3}>
      <DetailsGrid
        columns={1}
        items={[
          { key: "repository", label: "Repository", value: repository.fullName },
          {
            key: "role",
            label: "Your access",
            value: operatorAccess.platformAdministrator
              ? "Platform administrator"
              : operatorAccess.context?.repository?.role,
          },
          { key: "connection", label: "Connection", value: <Connection repository={repository} /> },
        ]}
      />
      {!operatorAccess.allows("configure") && (
        <Alert severity="info">
          <AlertTitle>Read-only repository settings</AlertTitle>Maintainer access or higher is
          required to change repository settings and verify the connection.
        </Alert>
      )}
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Button
          variant="outlined"
          disabled={!operatorAccess.can("configure")}
          loading={checking}
          onClick={() => void checkConnection()}
        >
          Check connection
        </Button>
        <Button
          variant="contained"
          disabled={!operatorAccess.can("configure")}
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </Button>
        <Button
          variant="outlined"
          disabled={!operatorAccess.can("manage_access")}
          onClick={() => setAccessOpen(true)}
        >
          Members and access
        </Button>
      </Stack>
      {!operatorAccess.allows("manage_access") && (
        <Typography variant="body2" color="text.secondary">
          Repository administrators manage members and access history.
        </Typography>
      )}
      {connectionNotice && (
        <Alert severity={connectionNotice.success ? "success" : "error"}>
          <AlertTitle>
            {connectionNotice.success ? "Connection verified" : "Connection check failed"}
          </AlertTitle>
          {connectionNotice.message}
        </Alert>
      )}
      <RepositoryConfigurationActivity repositoryId={repository.id} />
      <RepositorySchedulingPolicy repositoryId={repository.id} />
      <PublicationPolicy repositoryId={repository.id} />
      {settingsOpen && (
        <OperatorAccessGate repositoryId={repository.id} permission="configure">
          <RepositorySettingsDrawer
            key={JSON.stringify([
              repository.id,
              operatorAccess.identityKey,
              initialState?.authenticationEpoch ?? 0,
              operatorAccess.context?.repository,
              operatorAccess.platformAdministrator,
            ])}
            repositoryId={repository.id}
            onClose={() => setSettingsOpen(false)}
            onSaved={() => {
              setSettingsOpen(false);
              void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
              void queryClient.invalidateQueries({ queryKey: schedulingPolicyQueryRoot });
              void queryClient.invalidateQueries({ queryKey: ["scheduling-diagnostics"] });
              onUpdated();
            }}
          />
        </OperatorAccessGate>
      )}
      {accessOpen && operatorAccess.principal && (
        <RepositoryAccessDrawer
          repositoryId={repository.id}
          repositoryName={repository.fullName}
          open
          onClose={() => setAccessOpen(false)}
          canManage={operatorAccess.allows("manage_access")}
          platformAdministrator={operatorAccess.platformAdministrator}
          currentPrincipal={operatorAccess.principal}
          onChanged={refreshAccess}
        />
      )}
    </Stack>
  );
}

export default function RepositoriesPage() {
  return (
    <OperatorAccessGate>
      <RepositoriesContent />
    </OperatorAccessGate>
  );
}

function RepositoriesContent() {
  const operatorAccess = useOperatorAccess();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<ManagedRepositorySummary | null>(null);
  const listQuery = useQuery({
    queryKey: [
      "managed-repositories",
      "list",
      ...operatorAccess.identityKey,
      { page, pageSize, search },
    ],
    queryFn: () => repositories.list({ page, pageSize, search }),
  });
  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  useEffect(() => {
    if (listQuery.data && total > 0 && page > Math.ceil(total / pageSize))
      setPage(Math.ceil(total / pageSize));
  }, [listQuery.data, total, page, pageSize]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["managed-repositories"] });
  const clearSearch = () => {
    setSearch("");
    setSearchInput("");
    setPage(1);
  };
  return (
    <Stack component="section" spacing={3} aria-labelledby="repositories-page-title">
      <PageHeader
        eyebrow="Configuration"
        title="Repositories"
        titleId="repositories-page-title"
        description="Connect GitHub repositories and control who can request reviews."
        actions={
          <Stack direction="row" spacing={1}>
            <Button
              startIcon={<Refresh />}
              loading={listQuery.isFetching}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            {operatorAccess.platformAdministrator && (
              <Button
                variant="contained"
                startIcon={<Add />}
                disabled={operatorAccess.checking}
                onClick={() => setAdding(true)}
              >
                Add repository
              </Button>
            )}
          </Stack>
        }
      />
      {process.env.NODE_ENV === "development" && (
        <Alert severity="info">
          <AlertTitle>Sample data</AlertTitle>This preview uses sample repositories. Changes affect
          the preview only.
        </Alert>
      )}
      <Card elevation={0}>
        <CardContent>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{ justifyContent: "space-between", alignItems: { sm: "center" }, mb: 2 }}
          >
            <Box
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchInput.trim());
                setPage(1);
              }}
              sx={{ width: { xs: "100%", sm: 440 } }}
            >
              <TextField
                fullWidth
                label="Search repositories"
                placeholder="Search owner or repository name"
                value={searchInput}
                onChange={(event) => {
                  setSearchInput(event.target.value);
                  if (!event.target.value) {
                    setSearch("");
                    setPage(1);
                  }
                }}
                slotProps={{
                  htmlInput: { maxLength: 512, "aria-label": "Search repositories" },
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        {searchInput && (
                          <IconButton aria-label="Clear search" size="medium" onClick={clearSearch}>
                            <Close fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton type="submit" aria-label="Search repositories" size="medium">
                          <Search fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </Box>
            <Typography variant="body2" color="text.secondary" aria-live="polite">
              {listQuery.isFetching
                ? "Loading repositories…"
                : listQuery.isError
                  ? "Repositories unavailable"
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "repository" : "repositories"}`}
            </Typography>
          </Stack>
          {listQuery.isError ? (
            <Alert
              severity="error"
              action={<Button onClick={() => void refresh()}>Try again</Button>}
            >
              <AlertTitle>Could not load repositories</AlertTitle>
              {errorMessage(listQuery.error)}
            </Alert>
          ) : listQuery.isPending ? (
            <Box role="status" aria-label="Loading repositories">
              <Skeleton variant="rounded" height={260} />
            </Box>
          ) : items.length === 0 ? (
            <EmptyState
              title={
                search
                  ? "No repositories match your search."
                  : operatorAccess.platformAdministrator
                    ? "Add your first repository"
                    : "No repository access"
              }
              description={
                search
                  ? undefined
                  : operatorAccess.platformAdministrator
                    ? "Add your first repository to start reviewing pull requests and issues."
                    : "No repository access. Ask a repository or platform administrator to share a repository with you."
              }
              action={
                search ? (
                  <Button onClick={clearSearch}>Clear search</Button>
                ) : operatorAccess.platformAdministrator ? (
                  <Button variant="contained" onClick={() => setAdding(true)}>
                    Add repository
                  </Button>
                ) : undefined
              }
              icon={<GitHub />}
            />
          ) : (
            <DataTable<ManagedRepositorySummary>
              rows={items}
              getRowId={(repository) => repository.id}
              ariaLabel="Managed repositories"
              columns={[
                {
                  id: "repository",
                  label: "Repository",
                  minWidth: 230,
                  render: (repository) => (
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
                      <GitHub fontSize="small" sx={{ color: "text.secondary", mt: 0.25 }} />
                      <Box>
                        <Link
                          component={RouterLink}
                          to={`/pull-requests?repositoryId=${encodeURIComponent(repository.id)}`}
                          sx={{ fontWeight: 500, overflowWrap: "anywhere" }}
                        >
                          {repository.fullName}
                        </Link>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ display: "block" }}
                        >
                          {repository.enabled ? "Enabled" : "Disabled"}
                        </Typography>
                      </Box>
                    </Stack>
                  ),
                },
                {
                  id: "reviewer",
                  label: "Reviewer",
                  minWidth: 140,
                  render: (repository) => (
                    <Typography variant="body2">
                      {repository.reviewerGithubLogin ??
                        (repository.reviewerGithubUserId
                          ? `ID ${repository.reviewerGithubUserId}`
                          : "Inherited default")}
                    </Typography>
                  ),
                },
                {
                  id: "connection",
                  label: "Connection",
                  minWidth: 220,
                  render: (repository) => <Connection repository={repository} />,
                },
                {
                  id: "actions",
                  label: "Manage",
                  width: 210,
                  minWidth: 210,
                  render: (repository) => (
                    <Button
                      size="medium"
                      variant="outlined"
                      sx={{ whiteSpace: "nowrap" }}
                      onClick={() => setManaging(repository)}
                      aria-label={`Settings and access for ${repository.fullName}`}
                    >
                      Settings and access
                    </Button>
                  ),
                },
              ]}
            />
          )}
          {!listQuery.isError && total > pageSize && (
            <TablePagination
              component="div"
              page={page - 1}
              rowsPerPage={pageSize}
              count={total}
              rowsPerPageOptions={[20, 50]}
              disabled={listQuery.isFetching}
              onPageChange={(_, nextPage) => setPage(nextPage + 1)}
              onRowsPerPageChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
            />
          )}
        </CardContent>
      </Card>
      {adding && (
        <OperatorAccessGate platformOnly>
          <AddRepositoryDrawer
            onClose={() => setAdding(false)}
            onCreated={(repository) => {
              setAdding(false);
              notify(`${repository.fullName} added.`);
              void refresh();
            }}
          />
        </OperatorAccessGate>
      )}
      {managing && (
        <RepositoryPanel
          width={960}
          title={`Settings and access · ${managing.fullName}`}
          onClose={() => setManaging(null)}
        >
          <OperatorAccessGate repositoryId={managing.id}>
            <RepositoryManagement
              key={managing.id}
              repository={items.find((item) => item.id === managing.id) ?? managing}
              onUpdated={() => void refresh()}
            />
          </OperatorAccessGate>
        </RepositoryPanel>
      )}
    </Stack>
  );
}
