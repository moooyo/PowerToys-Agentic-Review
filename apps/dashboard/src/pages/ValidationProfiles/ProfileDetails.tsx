import type {
  RepositoryValidationProfileBinding,
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import { Close, ContentCopy } from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useConfigurationAvailable } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable, DetailsGrid, notify } from "@/components/ui";
import { configuration } from "@/services/configuration";
import type { ValidationProfileBindingHistory } from "@/services/configuration/adapter";
import {
  buildProfileBinding,
  collectProfileBindings,
  configurationErrorMessage,
  isProfileConflict,
  targetLabels,
  webTraceLabels,
  workflowLabels,
} from "./forms";

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "flex-start" }}>
      <Box
        component="code"
        sx={{
          overflowWrap: "anywhere",
          fontFamily: '"Roboto Mono", Consolas, monospace',
          fontSize: 14,
          lineHeight: "20px",
        }}
      >
        {value}
      </Box>
      <Tooltip title={`Copy ${label}`}>
        <IconButton
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              notify(`Copied ${label}.`);
            } catch {
              notify(`Could not copy ${label}.`, "error");
            }
          }}
        >
          <ContentCopy fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function PublishedVersion({ profile }: { profile: ValidationProfileVersion }) {
  const configurationJson = JSON.stringify(profile.config, null, 2);
  const observables = profile.config.test.flatMap((step) =>
    (step.probeOutput?.fields ?? []).map((field) => ({
      ...field,
      key: `${step.id}/${field.id}`,
      testStepId: step.id,
      testStepName: step.name,
    })),
  );
  return (
    <Stack spacing={3} className="validation-profiles-version">
      <Typography variant="h6" component="h3">
        Version {profile.version} · {profile.name}
      </Typography>
      <DetailsGrid
        columns={1}
        items={[
          { label: "Workflow", value: workflowLabels[profile.workflowKind] },
          { label: "Execution target", value: targetLabels[profile.target] },
          { label: "Required", value: profile.required ? "Yes" : "No" },
          ...(profile.config.ui?.target === "web"
            ? [
                {
                  label: "Browser trace capture",
                  value: webTraceLabels[profile.config.ui.evidence.trace],
                },
              ]
            : []),
          { label: "Output schema", value: <code>{profile.outputSchemaVersion}</code> },
          { label: "Published", value: profile.publishedAt },
          { label: "Published by", value: profile.createdBy },
          { label: "Version ID", value: <CopyValue value={profile.id} label="version ID" /> },
          {
            label: "Configuration digest",
            value: <CopyValue value={profile.configSha256} label="configuration digest" />,
          },
        ]}
      />
      <Typography color="text.secondary">
        Published configuration is read-only. Create a new version to change commands or settings.
      </Typography>
      {profile.workflowKind !== "issue_triage" && (
        <Box>
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
            Test observables
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 1.5 }}>
            Issue reproduction cases can select these fields from this published version.
          </Typography>
          {observables.length === 0 ? (
            <Typography color="text.secondary">
              This version has no declared test observables.
            </Typography>
          ) : (
            <DataTable
              rows={observables}
              getRowId={(field) => field.key}
              ariaLabel="Published test observables"
              columns={[
                {
                  id: "testStepId",
                  label: "Test command",
                  minWidth: 180,
                  render: (field) => (
                    <>
                      {field.testStepName}
                      <div className="validation-profiles-secondary">
                        <code>{field.testStepId}</code>
                      </div>
                    </>
                  ),
                },
                {
                  id: "id",
                  label: "Field ID",
                  minWidth: 150,
                  render: (field) => <code>{field.id}</code>,
                },
                { id: "type", label: "Type", width: 90, render: (field) => field.type },
                {
                  id: "description",
                  label: "Description",
                  minWidth: 200,
                  render: (field) => field.description,
                },
              ]}
            />
          )}
        </Box>
      )}
      <TextField
        fullWidth
        multiline
        variant="outlined"
        label="Published execution configuration"
        minRows={Math.min(24, configurationJson.split("\n").length)}
        maxRows={24}
        slotProps={{
          input: { readOnly: true },
          htmlInput: {
            spellCheck: false,
            "aria-label": `Published configuration for version ${profile.version}`,
          },
        }}
        sx={{
          "& textarea": {
            fontFamily: '"Roboto Mono", Consolas, monospace',
            fontSize: 14,
            lineHeight: "24px",
          },
        }}
        value={configurationJson}
      />
    </Stack>
  );
}

export function ProfileDetails({
  repositoryId,
  profile,
  onClose,
  onNewVersion,
}: {
  repositoryId: string;
  profile: ValidationProfileVersionSummary;
  onClose: () => void;
  onNewVersion: () => void;
}) {
  const available = useConfigurationAvailable();
  const access = useOperatorAccess(repositoryId);
  const canConfigure = available && access.can("configure");
  const allowsConfigure = access.allows("configure");
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("versions");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [viewedVersionId, setViewedVersionId] = useState(profile.id);
  const [selected, setSelected] = useState<ValidationProfileVersionSummary>(profile);
  const [selectionReady, setSelectionReady] = useState(false);
  const [binding, setBinding] = useState<RepositoryValidationProfileBinding | undefined>();
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const mutationInFlight = useRef(false);
  const [selectingVersionId, setSelectingVersionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const versionsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, profile.profileId, "versions", page, pageSize],
    queryFn: () =>
      configuration.listProfileVersions(repositoryId, profile.profileId, { page, pageSize }),
    retry: false,
  });
  const versionQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, profile.profileId, "version", viewedVersionId],
    queryFn: () =>
      configuration.getProfileVersion(repositoryId, profile.profileId, viewedVersionId),
    retry: false,
  });
  const bindingsQuery = useQuery({
    queryKey: ["validation-profiles", repositoryId, "bindings"],
    queryFn: () =>
      collectProfileBindings(repositoryId, (id, query) =>
        configuration.listProfileBindings(id, query),
      ),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const boundVersionQuery = useQuery({
    queryKey: [
      "validation-profiles",
      repositoryId,
      profile.profileId,
      "version",
      binding?.profileVersionId,
    ],
    queryFn: () => {
      if (!binding) throw new Error("Load the repository binding first.");
      return configuration.getProfileVersion(
        repositoryId,
        profile.profileId,
        binding.profileVersionId,
      );
    },
    enabled: binding !== undefined,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: [
      "validation-profiles",
      repositoryId,
      profile.profileId,
      "binding-history",
      historyPage,
      historyPageSize,
    ],
    queryFn: () =>
      configuration.listProfileBindingHistory(repositoryId, profile.profileId, {
        page: historyPage,
        pageSize: historyPageSize,
      }),
    enabled: tab === "history",
    retry: false,
  });
  useEffect(() => {
    if (bindingsQuery.isSuccess && !bindingsQuery.isFetching && !bindingLoaded) {
      const current = bindingsQuery.data.find((item) => item.profileId === profile.profileId);
      setBinding(current);
      setEnabled(current?.enabled ?? true);
      setBindingLoaded(true);
    }
  }, [
    bindingLoaded,
    bindingsQuery.data,
    bindingsQuery.isSuccess,
    bindingsQuery.isFetching,
    profile.profileId,
  ]);
  useEffect(() => {
    if (!bindingLoaded || selectionReady) return;
    if (!binding) {
      setSelected(profile);
      setSelectionReady(true);
    } else if (boundVersionQuery.data && !boundVersionQuery.isError) {
      setSelected(boundVersionQuery.data);
      setSelectionReady(true);
    }
  }, [
    binding,
    bindingLoaded,
    boundVersionQuery.data,
    boundVersionQuery.isError,
    profile,
    selectionReady,
  ]);

  const reloadBinding = async () => {
    try {
      const result = await bindingsQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      const current = result.data.find((item) => item.profileId === profile.profileId);
      setBinding(current);
      setEnabled(current?.enabled ?? true);
      setBindingLoaded(true);
      setConflict(false);
      setError(null);
      setSaved(false);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };
  const saveBinding = async () => {
    if (!canConfigure || mutationInFlight.current || saving || selectingVersionId !== null) return;
    if (
      !bindingLoaded ||
      !selectionReady ||
      bindingsQuery.isError ||
      bindingsQuery.isFetching ||
      conflict
    )
      return;
    mutationInFlight.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await configuration.saveProfileBinding(
        repositoryId,
        profile.profileId,
        buildProfileBinding(repositoryId, profile.profileId, selected, enabled, binding),
      );
      setBinding(result);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["validation-profiles", repositoryId] });
    } catch (failure) {
      setConflict(isProfileConflict(failure));
      setError(configurationErrorMessage(failure));
    } finally {
      mutationInFlight.current = false;
      setSaving(false);
    }
  };
  const selectHistoricalVersion = async (versionId: string) => {
    if (!canConfigure || mutationInFlight.current || saving || selectingVersionId !== null) return;
    mutationInFlight.current = true;
    setSelectingVersionId(versionId);
    setError(null);
    try {
      const version = await configuration.getProfileVersion(
        repositoryId,
        profile.profileId,
        versionId,
      );
      setSelected(version);
      setSelectionReady(true);
      setSaved(false);
      setTab("binding");
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      mutationInFlight.current = false;
      setSelectingVersionId(null);
    }
  };
  const mutationDisabled = saving || selectingVersionId !== null;
  const unchanged = binding?.profileVersionId === selected.id && binding.enabled === enabled;
  const closeDetails = () => {
    if (!mutationInFlight.current && !mutationDisabled) onClose();
  };

  return (
    <Drawer
      open
      anchor="right"
      onClose={closeDetails}
      slotProps={{
        paper: {
          sx: { width: { xs: "100%", md: 920 }, maxWidth: "100%" },
          role: "dialog",
          "aria-labelledby": "profile-details-title",
        },
      }}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{
          px: 3,
          py: 2,
          borderBottom: 1,
          borderColor: "divider",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h2" id="profile-details-title">
            {profile.name}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {workflowLabels[profile.workflowKind]} · {targetLabels[profile.target]}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          {allowsConfigure && (
            <Button
              variant="outlined"
              disabled={!canConfigure || mutationDisabled}
              onClick={() => {
                if (canConfigure && !mutationInFlight.current) onNewVersion();
              }}
            >
              Create new version
            </Button>
          )}
          <IconButton
            aria-label="Close profile details"
            disabled={mutationDisabled}
            onClick={closeDetails}
          >
            <Close />
          </IconButton>
        </Stack>
      </Stack>
      <Box sx={{ p: { xs: 2, sm: 3 }, overflowY: "auto", flex: 1 }}>
        {(profile.workflowKind === "pr_ui" || profile.workflowKind === "issue_validation") && (
          <Alert className="validation-profiles-notice" severity="info">
            <AlertTitle>Execution needs a matching driver</AlertTitle>A Worker must have a driver
            for this workflow and target. A published or enabled profile is configuration, not
            evidence of a passed validation.
          </Alert>
        )}
        {error && !conflict && (
          <Alert className="validation-profiles-notice" severity="error">
            <AlertTitle>The request could not be completed</AlertTitle>
            {error}
          </Alert>
        )}
        <Tabs
          value={tab}
          onChange={(_, value: string) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Profile details"
          sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
        >
          <Tab
            value="versions"
            label="Published versions"
            id="profile-tab-versions"
            aria-controls="profile-panel-versions"
          />
          <Tab
            value="binding"
            label="Repository binding"
            id="profile-tab-binding"
            aria-controls="profile-panel-binding"
          />
          <Tab
            value="history"
            label="Binding history"
            id="profile-tab-history"
            aria-controls="profile-panel-history"
          />
        </Tabs>
        <Box
          role="tabpanel"
          id="profile-panel-versions"
          aria-labelledby="profile-tab-versions"
          hidden={tab !== "versions"}
        >
          {versionsQuery.isError ? (
            <Alert
              severity="error"
              action={
                <Button color="inherit" onClick={() => void versionsQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Could not load version history</AlertTitle>
              {configurationErrorMessage(versionsQuery.error)}
            </Alert>
          ) : (
            <DataTable<ValidationProfileVersionSummary>
              ariaLabel="Published profile versions"
              getRowId={(item) => item.id}
              loading={versionsQuery.isPending}
              rows={versionsQuery.data?.items ?? []}
              emptyTitle="No published versions are available."
              pagination={{
                page,
                pageSize,
                total: versionsQuery.data?.total ?? 0,
                onChange: (nextPage, nextSize) => {
                  setPage(nextSize === pageSize ? nextPage : 1);
                  setPageSize(nextSize);
                },
              }}
              columns={[
                {
                  id: "version",
                  label: "Version",
                  width: 95,
                  render: (item) => (
                    <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
                      v{item.version}
                    </Typography>
                  ),
                },
                { id: "name", label: "Name", minWidth: 180, render: (item) => item.name },
                {
                  id: "publishedAt",
                  label: "Published",
                  minWidth: 160,
                  render: (item) => (
                    <span className="validation-profiles-date">{item.publishedAt}</span>
                  ),
                },
                {
                  id: "actions",
                  label: "Actions",
                  minWidth: 210,
                  render: (item) => (
                    <Stack direction="row" spacing={1}>
                      <Button onClick={() => setViewedVersionId(item.id)}>View</Button>
                      {allowsConfigure && (
                        <Button
                          disabled={!canConfigure || mutationDisabled}
                          onClick={() => {
                            if (!canConfigure || mutationInFlight.current) return;
                            setSelected(item);
                            setSelectionReady(true);
                            setSaved(false);
                            setTab("binding");
                          }}
                        >
                          Use this version
                        </Button>
                      )}
                    </Stack>
                  ),
                },
              ]}
            />
          )}
          {versionQuery.isError ? (
            <Alert
              className="validation-profiles-notice"
              severity="error"
              action={
                <Button color="inherit" onClick={() => void versionQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Could not load this published version</AlertTitle>
              {configurationErrorMessage(versionQuery.error)}
            </Alert>
          ) : versionQuery.isPending ? (
            <Typography role="status" sx={{ mt: 3 }}>
              Loading published configuration…
            </Typography>
          ) : (
            <PublishedVersion profile={versionQuery.data} />
          )}
        </Box>
        <Box
          role="tabpanel"
          id="profile-panel-binding"
          aria-labelledby="profile-tab-binding"
          hidden={tab !== "binding"}
        >
          <Typography sx={{ mb: 2 }}>
            {allowsConfigure
              ? "Choose the published version used for this repository. To roll back, select an older version in Published versions, then save this binding. Published content stays unchanged."
              : "View the published version used for this repository. Repository configuration permission is required to change this binding."}
          </Typography>
          {bindingsQuery.isError ? (
            <Alert
              className="validation-profiles-notice"
              severity="error"
              action={
                <Button color="inherit" loading={bindingsQuery.isFetching} onClick={reloadBinding}>
                  Reload bindings
                </Button>
              }
            >
              <AlertTitle>Could not load current bindings</AlertTitle>
              {configurationErrorMessage(bindingsQuery.error)}
            </Alert>
          ) : !bindingLoaded ? (
            <Typography role="status">Loading current binding…</Typography>
          ) : (
            <DetailsGrid
              columns={1}
              items={[
                {
                  label: "Current version",
                  value: binding ? (
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      sx={{ alignItems: "center", flexWrap: "wrap" }}
                    >
                      <span>
                        {boundVersionQuery.data ? (
                          `v${boundVersionQuery.data.version} · ${boundVersionQuery.data.name}`
                        ) : (
                          <code>{binding.profileVersionId}</code>
                        )}
                      </span>
                      <Chip variant="outlined" label={binding.enabled ? "Enabled" : "Disabled"} />
                    </Stack>
                  ) : (
                    "Not bound"
                  ),
                },
                { label: "Binding revision", value: binding?.version ?? "No binding yet" },
              ]}
            />
          )}
          {boundVersionQuery.isError && binding && (
            <Alert
              className="validation-profiles-notice"
              severity="error"
              action={
                <Button color="inherit" onClick={() => void boundVersionQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Could not load the bound version</AlertTitle>
              {configurationErrorMessage(boundVersionQuery.error)}
            </Alert>
          )}
          {conflict && (
            <Alert
              className="validation-profiles-notice"
              severity="warning"
              action={
                <Button color="inherit" loading={bindingsQuery.isFetching} onClick={reloadBinding}>
                  Reload current binding
                </Button>
              }
            >
              <AlertTitle>The repository binding changed</AlertTitle>
              <p>{error}</p>
              <p>
                Reload the current binding, review the selected version and enabled state, then save
                again.
              </p>
            </Alert>
          )}
          {saved && (
            <Alert className="validation-profiles-notice" severity="success">
              <AlertTitle>Repository binding saved</AlertTitle>This updates configuration for future
              work. It does not start or confirm a validation run.
            </Alert>
          )}
          {allowsConfigure && (
            <>
              <div className="validation-profiles-binding-choice">
                <div>
                  <Typography sx={{ fontWeight: 500 }}>Version to bind</Typography>
                  <Typography>
                    {selectionReady
                      ? `v${selected.version} · ${selected.name}`
                      : "Loading current version…"}
                  </Typography>
                  {selectionReady && (
                    <Typography variant="body2" color="text.secondary">
                      {selected.id}
                    </Typography>
                  )}
                </div>
                <Button
                  disabled={!canConfigure || mutationDisabled}
                  onClick={() => {
                    if (canConfigure) setTab("versions");
                  }}
                >
                  Choose another version
                </Button>
              </div>
              <div className="validation-profiles-binding-choice">
                <div>
                  <Typography
                    component="label"
                    htmlFor="profile-binding-enabled"
                    sx={{ fontWeight: 500 }}
                  >
                    Enable this profile
                  </Typography>
                  <Typography color="text.secondary">
                    Allow future work to select this profile through the repository binding.
                  </Typography>
                </div>
                <Switch
                  slotProps={{ input: { id: "profile-binding-enabled" } }}
                  checked={enabled}
                  disabled={
                    !canConfigure ||
                    !bindingLoaded ||
                    bindingsQuery.isError ||
                    mutationDisabled ||
                    conflict
                  }
                  onChange={(_, value) => {
                    if (!canConfigure) return;
                    setEnabled(value);
                    setSaved(false);
                  }}
                />
              </div>
              <Button
                variant="contained"
                loading={saving}
                disabled={
                  !canConfigure ||
                  !bindingLoaded ||
                  !selectionReady ||
                  bindingsQuery.isError ||
                  bindingsQuery.isFetching ||
                  conflict ||
                  unchanged ||
                  selectingVersionId !== null
                }
                onClick={saveBinding}
              >
                Save repository binding
              </Button>
            </>
          )}
        </Box>
        <Box
          role="tabpanel"
          id="profile-panel-history"
          aria-labelledby="profile-tab-history"
          hidden={tab !== "history"}
        >
          {historyQuery.isError ? (
            <Alert
              severity="error"
              action={
                <Button color="inherit" onClick={() => void historyQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              <AlertTitle>Could not load binding history</AlertTitle>
              {configurationErrorMessage(historyQuery.error)}
            </Alert>
          ) : (
            <DataTable<ValidationProfileBindingHistory>
              ariaLabel="Profile binding history"
              getRowId={(item) => item.id}
              rows={historyQuery.data?.items ?? []}
              loading={historyQuery.isPending}
              emptyTitle="This profile has no binding history yet."
              pagination={{
                page: historyPage,
                pageSize: historyPageSize,
                total: historyQuery.data?.total ?? 0,
                onChange: (nextPage, nextSize) => {
                  setHistoryPage(nextSize === historyPageSize ? nextPage : 1);
                  setHistoryPageSize(nextSize);
                },
              }}
              columns={[
                { id: "version", label: "Revision", width: 85, render: (item) => item.version },
                {
                  id: "profileVersionId",
                  label: "Version ID",
                  minWidth: 200,
                  render: (item) => <CopyValue value={item.profileVersionId} label="version ID" />,
                },
                {
                  id: "enabled",
                  label: "State",
                  width: 95,
                  render: (item) => (
                    <Chip variant="outlined" label={item.enabled ? "Enabled" : "Disabled"} />
                  ),
                },
                {
                  id: "createdAt",
                  label: "Changed",
                  minWidth: 160,
                  render: (item) => (
                    <>
                      <span className="validation-profiles-date">{item.createdAt}</span>
                      <div className="validation-profiles-secondary">{item.createdBy}</div>
                    </>
                  ),
                },
                {
                  id: "actions",
                  label: "Actions",
                  minWidth: 145,
                  render: (item) =>
                    allowsConfigure && (
                      <Button
                        disabled={!canConfigure || mutationDisabled}
                        loading={selectingVersionId === item.profileVersionId}
                        onClick={() => void selectHistoricalVersion(item.profileVersionId)}
                      >
                        Use this version
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
