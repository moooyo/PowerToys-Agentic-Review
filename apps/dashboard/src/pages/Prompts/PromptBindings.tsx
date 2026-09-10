import {
  type PromptBinding,
  type PromptTemplateSummary,
  type PromptVersionSummary,
  type WorkflowKind,
  WorkflowKindValues,
} from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HistoryIcon from "@mui/icons-material/History";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Tab,
  TablePagination,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { DataTable, DetailsGrid, notify } from "@/components/ui";
import { configuration } from "@/services/configuration";
import type { ConfigurationPage, PromptBindingHistory } from "@/services/configuration/adapter";
import { usePromptAvailable } from "./access";
import {
  bindingExpectedVersion,
  configurationErrorMessage,
  isPromptConflict,
  workflowLabels,
} from "./forms";
import { promptQueryKeys } from "./queries";
import "./bindings.css";

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function VersionId({ value }: { value: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, alignItems: "center" }}>
      <Typography className="prompt-bindings-code" variant="body2" component="span">
        {value}
      </Typography>
      <IconButton
        size="medium"
        aria-label="Copy value"
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .catch(() => notify("Could not copy the value.", "error"));
        }}
      >
        <ContentCopyIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  );
}

function BindingPagination({
  result,
  loading,
  onChange,
}: {
  result: ConfigurationPage<unknown>;
  loading: boolean;
  onChange: (page: number, pageSize: number) => void;
}) {
  if (result.total === 0) return null;
  return (
    <div className="prompt-bindings-pagination">
      <TablePagination
        component="div"
        page={result.page - 1}
        rowsPerPage={result.pageSize}
        count={result.total}
        rowsPerPageOptions={[20, 50]}
        disabled={loading}
        onPageChange={(_event, page) => {
          if (!loading) onChange(page + 1, result.pageSize);
        }}
        onRowsPerPageChange={(event) => {
          if (!loading) onChange(1, Number(event.target.value));
        }}
      />
    </div>
  );
}

function PublishedVersionDrawer({
  template,
  version,
  onClose,
}: {
  template: PromptTemplateSummary;
  version: PromptVersionSummary;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const versionQuery = useQuery({
    queryKey: promptQueryKeys.version(template.id, version.id),
    queryFn: () => configuration.getPromptVersion(template.id, version.id),
    enabled: available,
    refetchOnWindowFocus: false,
  });

  return (
    <Drawer
      open
      anchor="right"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") onClose();
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-label": `Published version ${version.version} · ${template.name}`,
          sx: { width: { xs: "100%", sm: 760 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography
          variant="h6"
          sx={{ flex: 1 }}
        >{`Published version ${version.version} · ${template.name}`}</Typography>
        <IconButton aria-label="Close" disabled={false} onClick={() => onClose()}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        {versionQuery.isPending && (
          <Skeleton variant="rounded" height={10 * 24} aria-label="Loading" />
        )}
        {versionQuery.isError && (
          <Alert
            action={
              <Button
                disabled={!available}
                onClick={() => {
                  if (available) void versionQuery.refetch();
                }}
                variant="outlined"
              >
                Try again
              </Button>
            }
            severity={"error"}
          >
            <AlertTitle>{"Could not load published version"}</AlertTitle>
            {configurationErrorMessage(versionQuery.error)}
          </Alert>
        )}
        {versionQuery.isSuccess && (
          <>
            <Typography variant="body2" component="p" color="text.secondary">
              Published content is immutable. This is a read-only view.
            </Typography>
            <div className={"prompt-bindings-facts"}>
              <DetailsGrid
                columns={2}
                items={[
                  {
                    key: "id",
                    label: "Version ID",
                    value: <VersionId value={versionQuery.data.id} />,
                  },
                  {
                    key: "schema",
                    label: "Output schema",
                    value: versionQuery.data.outputSchemaVersion,
                  },
                  {
                    key: "published",
                    label: "Published",
                    value: <Timestamp value={versionQuery.data.publishedAt} />,
                  },
                  {
                    key: "actor",
                    label: "Published by",
                    value: (
                      <span className="prompt-bindings-wrap">{versionQuery.data.createdBy}</span>
                    ),
                  },
                  {
                    key: "hash",
                    label: "SHA-256",
                    value: <VersionId value={versionQuery.data.contentSha256} />,
                  },
                ]}
              />
            </div>
            <TextField
              className="prompt-bindings-content"
              value={versionQuery.data.content}
              fullWidth
              slotProps={{
                htmlInput: { "aria-label": "Published prompt content", readOnly: true },
              }}
              multiline
              minRows={14}
              maxRows={30}
            ></TextField>
          </>
        )}
      </Box>
    </Drawer>
  );
}

function BindingEditor({
  repositoryId,
  scopeLabel,
  workflowKind,
  initialBinding,
  onClose,
  onSaved,
}: {
  repositoryId: string | null;
  scopeLabel: string;
  workflowKind: WorkflowKind;
  initialBinding: PromptBinding | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const available = usePromptAvailable();
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState(initialBinding);
  const [expectedVersion, setExpectedVersion] = useState(() =>
    bindingExpectedVersion(initialBinding, repositoryId, workflowKind),
  );
  const [templatePage, setTemplatePage] = useState(1);
  const [templatePageSize, setTemplatePageSize] = useState(20);
  const [versionPage, setVersionPage] = useState(1);
  const [versionPageSize, setVersionPageSize] = useState(20);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplateSummary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PromptVersionSummary | null>(null);
  const [viewingVersion, setViewingVersion] = useState<PromptVersionSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const busyRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: promptQueryKeys.templatePicker(workflowKind, templatePage, templatePageSize),
    queryFn: () =>
      configuration.listPrompts({ workflowKind, page: templatePage, pageSize: templatePageSize }),
    enabled: available && selectedTemplate === null,
    refetchOnWindowFocus: false,
  });
  const versionsQuery = useQuery({
    queryKey: promptQueryKeys.versionList(
      selectedTemplate?.id ?? null,
      versionPage,
      versionPageSize,
    ),
    queryFn: () => {
      if (!selectedTemplate)
        throw new Error("Choose a template before loading published versions.");
      return configuration.listPromptVersions(selectedTemplate.id, {
        page: versionPage,
        pageSize: versionPageSize,
      });
    },
    enabled: available && selectedTemplate !== null,
    refetchOnWindowFocus: false,
  });

  const reloadLatest = async () => {
    if (!available || busyRef.current) return;
    busyRef.current = true;
    setReloading(true);
    setError(null);
    try {
      const result = await configuration.listPromptBindings(repositoryId);
      const latest = result.items.find(
        (binding) => binding.repositoryId === repositoryId && binding.workflowKind === workflowKind,
      );
      const nextExpectedVersion = bindingExpectedVersion(latest, repositoryId, workflowKind);
      queryClient.setQueryData(promptQueryKeys.bindingScope(repositoryId), result);
      setBaseline(latest);
      setExpectedVersion(nextExpectedVersion);
      setSelectedTemplate(null);
      setSelectedVersion(null);
      setViewingVersion(null);
      setTemplatePage(1);
      setVersionPage(1);
      setConflict(false);
      setReloaded(true);
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      busyRef.current = false;
      setReloading(false);
    }
  };

  const save = async () => {
    if (!available || !selectedTemplate || !selectedVersion || conflict || busyRef.current) return;
    if (selectedVersion.id === baseline?.promptVersionId) return;
    if (
      selectedVersion.templateId !== selectedTemplate.id ||
      selectedTemplate.workflowKind !== workflowKind
    ) {
      setError("Select a published version from a template for this workflow.");
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await configuration.savePromptBinding(repositoryId, workflowKind, {
        expectedVersion,
        promptVersionId: selectedVersion.id,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindings }),
        queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindingHistories }),
      ]);
      onSaved();
    } catch (failure) {
      setConflict(isPromptConflict(failure));
      setError(configurationErrorMessage(failure));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const selectionDisabled = !available || saving || reloading || conflict;
  const unchanged = selectedVersion?.id === baseline?.promptVersionId && selectedVersion !== null;
  const close = () => {
    if (!busyRef.current) onClose();
  };

  return (
    <Drawer
      open
      anchor="right"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") close();
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-label": `Bind prompt · ${workflowLabels[workflowKind]}`,
          sx: { width: { xs: "100%", sm: 900 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography
          variant="h6"
          sx={{ flex: 1 }}
        >{`Bind prompt · ${workflowLabels[workflowKind]}`}</Typography>
        <IconButton aria-label="Close" disabled={!(!saving && !reloading)} onClick={close}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        <div className={"prompt-bindings-facts"}>
          <DetailsGrid
            columns={2}
            items={[
              { key: "scope", label: "Binding scope", value: scopeLabel },
              {
                key: "current",
                label:
                  repositoryId === null ? "Current global binding" : "Current repository binding",
                value: baseline ? (
                  <VersionId value={baseline.promptVersionId} />
                ) : (
                  "Not bound in this scope"
                ),
              },
              ...(baseline
                ? [{ key: "revision", label: "Binding revision", value: baseline.version }]
                : []),
            ]}
          />
        </div>
        {repositoryId === null && (
          <Alert className="prompt-bindings-notice" severity={"info"}>
            <AlertTitle>{"This changes the global default"}</AlertTitle>
            {"Every repository without an override for this workflow uses this binding."}
          </Alert>
        )}
        {conflict ? (
          <Alert
            className="prompt-bindings-notice"
            action={
              <Button
                disabled={!available}
                loading={reloading}
                onClick={() => void reloadLatest()}
                variant="outlined"
              >
                Reload latest binding
              </Button>
            }
            severity={"warning"}
          >
            <AlertTitle>{"This binding changed while you were choosing a version"}</AlertTitle>
            {
              <>
                {error && <p>{error}</p>}
                <p>
                  Your selection has not been saved. Reload the latest binding, then choose a
                  template and published version again.
                </p>
              </>
            }
          </Alert>
        ) : error ? (
          <Alert className="prompt-bindings-notice" severity={"error"}>
            <AlertTitle>{"Could not save binding"}</AlertTitle>
            {error}
          </Alert>
        ) : reloaded ? (
          <Alert className="prompt-bindings-notice" severity={"info"}>
            <AlertTitle>{"Latest binding loaded"}</AlertTitle>
            {"The previous selection was cleared. Choose a published version again to continue."}
          </Alert>
        ) : null}

        {!selectedTemplate ? (
          <>
            <Typography variant="h6" component="h3">
              1. Choose a template
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              Templates for {workflowLabels[workflowKind].toLowerCase()}. Only templates with
              published versions can be bound.
            </Typography>
            {templatesQuery.isError ? (
              <Alert
                action={
                  <Button
                    disabled={!available}
                    onClick={() => {
                      if (available) void templatesQuery.refetch();
                    }}
                    variant="outlined"
                  >
                    Try again
                  </Button>
                }
                severity={"error"}
              >
                <AlertTitle>{"Could not load templates"}</AlertTitle>
                {configurationErrorMessage(templatesQuery.error)}
              </Alert>
            ) : (
              <DataTable<PromptTemplateSummary>
                rows={templatesQuery.data?.items ?? []}
                columns={[
                  {
                    id: "template",
                    label: "Template",
                    render: (template) => {
                      return (
                        <div className="prompt-bindings-template">
                          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
                            {template.name}
                          </Typography>
                          {template.description && (
                            <span className="prompt-bindings-secondary">
                              {template.description}
                            </span>
                          )}
                          <code className="prompt-bindings-secondary">{template.id}</code>
                        </div>
                      );
                    },
                  },
                  {
                    id: "published",
                    label: "Publication",
                    width: 160,
                    render: (template) => {
                      return (
                        <Chip
                          size="medium"
                          label={
                            template.latestPublishedVersionId ? "Published versions" : "Draft only"
                          }
                          color={template.latestPublishedVersionId ? "success" : "default"}
                        ></Chip>
                      );
                    },
                  },
                  {
                    id: "action",
                    label: "Action",
                    width: 140,
                    render: (template) => {
                      return (
                        <Button
                          disabled={selectionDisabled || !template.latestPublishedVersionId}
                          onClick={() => {
                            setSelectedTemplate(template);
                            setSelectedVersion(null);
                            setVersionPage(1);
                            setReloaded(false);
                            setError(null);
                          }}
                          aria-label={`Choose template ${template.name}`}
                          variant="outlined"
                        >
                          Choose template
                        </Button>
                      );
                    },
                  },
                ]}
                getRowId={(row) => row.id}
                loading={templatesQuery.isFetching}
                emptyTitle={"No templates for this workflow"}
              />
            )}
            {templatesQuery.isSuccess && (
              <BindingPagination
                result={templatesQuery.data}
                loading={templatesQuery.isFetching || selectionDisabled}
                onChange={(page, pageSize) => {
                  setTemplatePage(page);
                  setTemplatePageSize(pageSize);
                }}
              />
            )}
          </>
        ) : (
          <>
            <div className="prompt-bindings-selection">
              <div className="prompt-bindings-template">
                <span className="prompt-bindings-secondary">Selected template</span>
                <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
                  {selectedTemplate.name}
                </Typography>
                <code className="prompt-bindings-secondary">{selectedTemplate.id}</code>
              </div>
              <Button
                disabled={selectionDisabled}
                onClick={() => {
                  setSelectedTemplate(null);
                  setSelectedVersion(null);
                  setViewingVersion(null);
                  setError(null);
                }}
                variant="outlined"
              >
                Change template
              </Button>
            </div>
            <Typography variant="h6" component="h3">
              2. Choose a published version
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              You can select any published version, including an earlier version for a rollback.
            </Typography>
            {versionsQuery.isError ? (
              <Alert
                action={
                  <Button
                    disabled={!available}
                    onClick={() => {
                      if (available) void versionsQuery.refetch();
                    }}
                    variant="outlined"
                  >
                    Try again
                  </Button>
                }
                severity={"error"}
              >
                <AlertTitle>{"Could not load published versions"}</AlertTitle>
                {configurationErrorMessage(versionsQuery.error)}
              </Alert>
            ) : (
              <DataTable<PromptVersionSummary>
                rows={versionsQuery.data?.items ?? []}
                columns={[
                  {
                    id: "version",
                    label: "Version",
                    render: (version) => {
                      return (
                        <div className="prompt-bindings-template">
                          <Stack
                            direction="row"
                            spacing={1}
                            useFlexGap
                            sx={{ alignItems: "center", flexWrap: "wrap" }}
                          >
                            <Typography
                              variant="subtitle1"
                              component="span"
                              sx={{ fontWeight: 500 }}
                            >
                              Version {version.version}
                            </Typography>
                            {version.id === selectedTemplate.latestPublishedVersionId && (
                              <Chip size="medium" label={<>Latest</>} color={"primary"}></Chip>
                            )}
                            {version.id === baseline?.promptVersionId && (
                              <Chip size="medium" label={<>Current binding</>}></Chip>
                            )}
                          </Stack>
                          <VersionId value={version.id} />
                        </div>
                      );
                    },
                  },
                  {
                    id: "published",
                    label: "Published",
                    width: 180,
                    render: (version) => {
                      return <Timestamp value={version.publishedAt} />;
                    },
                  },
                  {
                    id: "actions",
                    label: "Actions",
                    width: 220,
                    render: (version) => {
                      return (
                        <Stack
                          direction="row"
                          spacing={1}
                          useFlexGap
                          sx={{ alignItems: "center", flexWrap: "wrap" }}
                        >
                          <Button
                            disabled={!available || saving || reloading}
                            onClick={() => setViewingVersion(version)}
                            variant="outlined"
                          >
                            View content
                          </Button>
                          <Button
                            disabled={selectionDisabled}
                            aria-pressed={version.id === selectedVersion?.id}
                            aria-label={`Select published version ${version.version}`}
                            onClick={() => {
                              setSelectedVersion(version);
                              setError(null);
                            }}
                            variant={version.id === selectedVersion?.id ? "contained" : "outlined"}
                          >
                            {version.id === selectedVersion?.id ? "Selected" : "Select"}
                          </Button>
                        </Stack>
                      );
                    },
                  },
                ]}
                getRowId={(row) => row.id}
                loading={versionsQuery.isFetching}
                emptyTitle={"This template has no published versions"}
              />
            )}
            {versionsQuery.isSuccess && (
              <BindingPagination
                result={versionsQuery.data}
                loading={versionsQuery.isFetching || selectionDisabled}
                onChange={(page, pageSize) => {
                  setVersionPage(page);
                  setVersionPageSize(pageSize);
                }}
              />
            )}
            {selectedVersion && (
              <div className="prompt-bindings-chosen" aria-live="polite">
                <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
                  Selected: {selectedTemplate.name} · Version {selectedVersion.version}
                </Typography>
                <VersionId value={selectedVersion.id} />
                {unchanged && (
                  <span className="prompt-bindings-secondary">
                    This version is already bound in this scope. Select a different version to make
                    a change.
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {selectedTemplate && viewingVersion && (
          <PublishedVersionDrawer
            key={viewingVersion.id}
            template={selectedTemplate}
            version={viewingVersion}
            onClose={() => setViewingVersion(null)}
          />
        )}
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 2, borderTop: 1, borderColor: "divider" }}>
        {
          <div className="prompt-bindings-drawer-actions">
            <Button disabled={saving || reloading} onClick={close} variant="outlined">
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={!selectedVersion || selectionDisabled || unchanged}
              onClick={() => void save()}
              variant={"contained"}
            >
              {repositoryId !== null && !baseline ? "Create repository override" : "Save binding"}
            </Button>
          </div>
        }
      </Box>
    </Drawer>
  );
}

function BindingHistoryDrawer({
  repositoryId,
  scopeLabel,
  workflowKind,
  onClose,
}: {
  repositoryId: string | null;
  scopeLabel: string;
  workflowKind: WorkflowKind;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const historyQuery = useQuery({
    queryKey: promptQueryKeys.bindingHistory(repositoryId, workflowKind, page, pageSize),
    queryFn: () =>
      configuration.listPromptBindingHistory(repositoryId, workflowKind, { page, pageSize }),
    enabled: available,
    refetchOnWindowFocus: false,
  });

  return (
    <Drawer
      open
      anchor="right"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") onClose();
      }}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-label": `Binding history · ${workflowLabels[workflowKind]}`,
          sx: { width: { xs: "100%", sm: 1120 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography
          variant="h6"
          sx={{ flex: 1 }}
        >{`Binding history · ${workflowLabels[workflowKind]}`}</Typography>
        <IconButton aria-label="Close" disabled={false} onClick={() => onClose()}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        <Typography variant="body2" component="p">
          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
            Scope:{" "}
          </Typography>
          {scopeLabel}
        </Typography>
        <Typography variant="body2" component="p" color="text.secondary">
          This read-only history records changes to this scope's binding.
          {repositoryId !== null &&
            " Changes to an inherited global default appear in the global binding history."}
        </Typography>
        {historyQuery.isError ? (
          <Alert
            action={
              <Button
                disabled={!available}
                onClick={() => {
                  if (available) void historyQuery.refetch();
                }}
                variant="outlined"
              >
                Try again
              </Button>
            }
            severity={"error"}
          >
            <AlertTitle>{"Could not load binding history"}</AlertTitle>
            {configurationErrorMessage(historyQuery.error)}
          </Alert>
        ) : (
          <DataTable<PromptBindingHistory>
            rows={historyQuery.data?.items ?? []}
            columns={[
              {
                id: "version",
                label: "Binding revision",
                width: 110,
                render: (row) => row.version,
              },
              {
                id: "previous",
                label: "Previous version ID",
                width: 210,
                render: (entry) => {
                  return entry.previousVersionId ? (
                    <VersionId value={entry.previousVersionId} />
                  ) : (
                    <span className="prompt-bindings-secondary">No previous binding</span>
                  );
                },
              },
              {
                id: "next",
                label: "New version ID",
                width: 210,
                render: (entry) => {
                  return <VersionId value={entry.promptVersionId} />;
                },
              },
              {
                id: "actor",
                label: "Changed by",
                width: 230,
                render: (entry) => {
                  return <span className="prompt-bindings-wrap">{entry.createdBy}</span>;
                },
              },
              {
                id: "time",
                label: "Changed at",
                width: 180,
                render: (entry) => {
                  return <Timestamp value={entry.createdAt} />;
                },
              },
            ]}
            getRowId={(row) => row.id}
            loading={!available || historyQuery.isFetching}
            emptyTitle={"No binding changes recorded for this scope"}
          />
        )}
        {historyQuery.isSuccess && (
          <BindingPagination
            result={historyQuery.data}
            loading={!available || historyQuery.isFetching}
            onChange={(nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            }}
          />
        )}
      </Box>
    </Drawer>
  );
}

function BindingsScope({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const available = usePromptAvailable();
  const [editing, setEditing] = useState<{
    workflowKind: WorkflowKind;
    binding: PromptBinding | undefined;
  } | null>(null);
  const [historyWorkflow, setHistoryWorkflow] = useState<WorkflowKind | null>(null);
  const bindingsQuery = useQuery({
    queryKey: promptQueryKeys.bindingScope(repositoryId),
    queryFn: () => configuration.listPromptBindings(repositoryId),
    enabled: available,
    refetchOnWindowFocus: false,
  });
  const globalQuery = useQuery({
    queryKey: promptQueryKeys.bindingScope(null),
    queryFn: () => configuration.listPromptBindings(null),
    enabled: available && repositoryId !== null,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="prompt-bindings" aria-label={`Prompt bindings for ${scopeLabel}`}>
      <div className="prompt-bindings-toolbar">
        <div>
          <Typography variant="h6" component="h3">
            {repositoryId === null ? "Global workflow defaults" : "Repository workflow overrides"}
          </Typography>
          <Typography variant="body2" component="p" color="text.secondary">
            {repositoryId === null
              ? "Global defaults apply to every repository without an override for the workflow."
              : `Bindings for ${scopeLabel}. A repository override takes precedence over its global default.`}
          </Typography>
        </div>
        <Button
          loading={bindingsQuery.isFetching || (repositoryId !== null && globalQuery.isFetching)}
          disabled={!available}
          onClick={() => {
            if (!available) return;
            void bindingsQuery.refetch();
            if (repositoryId !== null) void globalQuery.refetch();
          }}
          variant="outlined"
          startIcon={<RefreshIcon />}
        >
          Refresh bindings
        </Button>
      </div>
      {bindingsQuery.isPending && (
        <Skeleton variant="rounded" height={8 * 24} aria-label="Loading" />
      )}
      {bindingsQuery.isError && (
        <Alert
          className="prompt-bindings-notice"
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void bindingsQuery.refetch();
              }}
              variant="outlined"
            >
              Try again
            </Button>
          }
          severity={"error"}
        >
          <AlertTitle>{"Could not load bindings for this scope"}</AlertTitle>
          {configurationErrorMessage(bindingsQuery.error)}
        </Alert>
      )}
      {repositoryId !== null && globalQuery.isError && (
        <Alert
          className="prompt-bindings-notice"
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void globalQuery.refetch();
              }}
              variant="outlined"
            >
              Retry global defaults
            </Button>
          }
          severity={"warning"}
        >
          <AlertTitle>{"Global defaults are unavailable"}</AlertTitle>
          {
            "Repository bindings are shown below. Inheritance cannot be determined until global defaults load."
          }
        </Alert>
      )}
      {bindingsQuery.isSuccess && (
        <ul className="prompt-bindings-list">
          {WorkflowKindValues.map((workflowKind) => {
            const ownBinding = bindingsQuery.data.items.find(
              (binding) =>
                binding.repositoryId === repositoryId && binding.workflowKind === workflowKind,
            );
            const globalBinding =
              repositoryId === null
                ? ownBinding
                : globalQuery.data?.items.find(
                    (binding) =>
                      binding.repositoryId === null && binding.workflowKind === workflowKind,
                  );
            const globalKnown = repositoryId === null || globalQuery.isSuccess;
            const inherited =
              repositoryId !== null && !ownBinding && globalKnown && Boolean(globalBinding);
            const status = ownBinding
              ? repositoryId === null
                ? "Global default"
                : "Repository override"
              : inherited
                ? "Inherited global default"
                : globalKnown
                  ? "Unbound"
                  : globalQuery.isPending
                    ? "Loading global default"
                    : "Inheritance unavailable";

            return (
              <li className="prompt-bindings-item" key={workflowKind}>
                <div className="prompt-bindings-workflow">
                  <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500 }}>
                    {workflowLabels[workflowKind]}
                  </Typography>
                  <Chip
                    size="medium"
                    label={status}
                    color={ownBinding ? "primary" : inherited ? "success" : "default"}
                  ></Chip>
                </div>
                <div className="prompt-bindings-details">
                  <div className="prompt-bindings-value">
                    <span className="prompt-bindings-secondary">
                      {repositoryId === null ? "Global binding" : "Repository binding"}
                    </span>
                    {ownBinding ? (
                      <>
                        <VersionId value={ownBinding.promptVersionId} />
                        <span className="prompt-bindings-secondary">
                          Binding revision {ownBinding.version}
                        </span>
                      </>
                    ) : (
                      <span>
                        {repositoryId === null
                          ? "No global default is bound."
                          : "No repository override is bound."}
                      </span>
                    )}
                  </div>
                  {repositoryId !== null && (
                    <div className="prompt-bindings-value">
                      <span className="prompt-bindings-secondary">
                        Global default {ownBinding ? "(overridden)" : "(inherited when bound)"}
                      </span>
                      {!globalKnown ? (
                        <span>
                          {globalQuery.isPending
                            ? "Loading global default…"
                            : "Could not load global default."}
                        </span>
                      ) : globalBinding ? (
                        <>
                          <VersionId value={globalBinding.promptVersionId} />
                          <span className="prompt-bindings-secondary">
                            Global binding revision {globalBinding.version}
                          </span>
                        </>
                      ) : (
                        <span>No global default is bound.</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="prompt-bindings-item-actions">
                  <Button
                    disabled={!available || bindingsQuery.isFetching}
                    onClick={() => setEditing({ workflowKind, binding: ownBinding })}
                    aria-label={`Change ${workflowLabels[workflowKind]} binding for ${scopeLabel}`}
                    variant="outlined"
                  >
                    {ownBinding
                      ? "Change binding"
                      : repositoryId === null
                        ? "Bind version"
                        : "Create override"}
                  </Button>
                  <Button
                    disabled={!available}
                    onClick={() => setHistoryWorkflow(workflowKind)}
                    variant="outlined"
                    startIcon={<HistoryIcon />}
                  >
                    History
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <BindingEditor
          key={`${repositoryId ?? "global"}:${editing.workflowKind}`}
          repositoryId={repositoryId}
          scopeLabel={scopeLabel}
          workflowKind={editing.workflowKind}
          initialBinding={editing.binding}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notify(`Binding saved for ${workflowLabels[editing.workflowKind]}.`);
          }}
        />
      )}
      {historyWorkflow && (
        <BindingHistoryDrawer
          key={`${repositoryId ?? "global"}:${historyWorkflow}`}
          repositoryId={repositoryId}
          scopeLabel={scopeLabel}
          workflowKind={historyWorkflow}
          onClose={() => setHistoryWorkflow(null)}
        />
      )}
    </section>
  );
}

export function PromptBindings({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const available = usePromptAvailable();
  const [activeScope, setActiveScope] = useState("repository");
  if (repositoryId === null)
    return <BindingsScope repositoryId={null} scopeLabel="Global defaults" />;

  return (
    <>
      <Tabs
        value={activeScope}
        onChange={(_event, next: string) => {
          setActiveScope(next);
        }}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab
          value={"repository"}
          label={"Repository overrides"}
          disabled={!available}
          id={"PromptBindings-tab-" + "repository"}
          aria-controls={"PromptBindings-panel-" + "repository"}
        />
        <Tab
          value={"global"}
          label={"Global defaults"}
          disabled={!available}
          id={"PromptBindings-tab-" + "global"}
          aria-controls={"PromptBindings-panel-" + "global"}
        />
      </Tabs>
      {activeScope === "repository" && (
        <Box
          role="tabpanel"
          id={"PromptBindings-panel-" + "repository"}
          aria-labelledby={"PromptBindings-tab-" + "repository"}
          hidden={activeScope !== "repository"}
          sx={{ pt: 3 }}
        >
          {<BindingsScope key={repositoryId} repositoryId={repositoryId} scopeLabel={scopeLabel} />}
        </Box>
      )}
      {activeScope === "global" && (
        <Box
          role="tabpanel"
          id={"PromptBindings-panel-" + "global"}
          aria-labelledby={"PromptBindings-tab-" + "global"}
          hidden={activeScope !== "global"}
          sx={{ pt: 3 }}
        >
          {<BindingsScope key="global" repositoryId={null} scopeLabel="Global defaults" />}
        </Box>
      )}
    </>
  );
}
