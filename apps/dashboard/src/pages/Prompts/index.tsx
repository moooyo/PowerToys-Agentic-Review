import {
  type PromptTemplate,
  type PromptTemplateSummary,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  TablePagination,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { GlobalPromptActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { ConfigurationScopeGuard } from "@/components/ConfigurationScopeGuard";
import { OperatorAccessGate } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { DataTable } from "@/components/ui";
import { configuration } from "@/services/configuration";
import { usePromptAvailable } from "./access";
import {
  buildPromptCreate,
  type CreatePromptValues,
  configurationErrorMessage,
  validatePromptContent,
  validatePromptName,
  workflowLabels,
  workflowOptions,
} from "./forms";
import { PromptBindings } from "./PromptBindings";
import { PromptEditor } from "./PromptEditor";
import { promptQueryKeys } from "./queries";
import "./index.css";

function CreatePromptDrawer({
  onClose,
  onCreated,
  initialWorkflowKind,
}: {
  onClose: () => void;
  onCreated: (template: PromptTemplate) => void;
  initialWorkflowKind: WorkflowKind;
}) {
  const available = usePromptAvailable();
  const [values, setValues] = useState<CreatePromptValues>({
    name: "",
    description: "",
    workflowKind: initialWorkflowKind,
    content: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CreatePromptValues, string>>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const workflowKind = values.workflowKind;
  const create = async () => {
    if (!available || savingRef.current) return;
    const errors: Partial<Record<keyof CreatePromptValues, string>> = {};
    try {
      validatePromptName(values.name);
    } catch (failure) {
      errors.name = configurationErrorMessage(failure);
    }
    if (values.description.length > 2_048 || values.description.includes("\u0000")) {
      errors.description =
        "Description must contain at most 2,048 characters without null characters.";
    }
    try {
      validatePromptContent(values.content);
    } catch (failure) {
      errors.content = configurationErrorMessage(failure);
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      onCreated(await configuration.createPrompt(buildPromptCreate(values)));
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const close = () => {
    if (!savingRef.current) onClose();
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
          "aria-labelledby": "create-prompt-title",
          sx: { width: { xs: "100%", sm: 760 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography id="create-prompt-title" variant="h6" sx={{ flex: 1 }}>
          Create prompt template
        </Typography>
        <IconButton aria-label="Close" disabled={saving} onClick={close}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box
        component="form"
        id="create-prompt-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}
      >
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Create a shared template with an editable draft. Publishing and workflow binding are
          separate steps.
        </Typography>
        {error && (
          <Alert severity="error" className="prompts-notice">
            <AlertTitle>Could not create template</AlertTitle>
            {error}
          </Alert>
        )}
        <Box
          component="fieldset"
          disabled={!available || saving}
          sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
        >
          <Stack spacing={3}>
            <TextField
              label="Template name"
              required
              fullWidth
              value={values.name}
              slotProps={{ htmlInput: { maxLength: 128 } }}
              placeholder="e.g. Maintainer code review"
              error={Boolean(fieldErrors.name)}
              helperText={fieldErrors.name}
              onChange={(event) =>
                setValues((current) => ({ ...current, name: event.target.value }))
              }
            />
            <TextField
              label="Description"
              fullWidth
              multiline
              minRows={2}
              maxRows={4}
              value={values.description}
              slotProps={{ htmlInput: { maxLength: 2_048 } }}
              placeholder="What should this template help reviewers do?"
              error={Boolean(fieldErrors.description)}
              helperText={fieldErrors.description}
              onChange={(event) =>
                setValues((current) => ({ ...current, description: event.target.value }))
              }
            />
            <div className="prompts-form-columns">
              <TextField
                label="Workflow"
                select
                fullWidth
                required
                value={workflowKind}
                disabled={!available || saving}
                helperText="A template's workflow cannot be changed after creation."
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    workflowKind: event.target.value as WorkflowKind,
                  }))
                }
              >
                {workflowOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Output schema"
                fullWidth
                value={WorkflowOutputSchemaVersions[workflowKind]}
                helperText="Determined by the workflow."
                slotProps={{
                  htmlInput: {
                    readOnly: true,
                    "aria-label": "Output schema determined by workflow",
                  },
                }}
              />
            </div>
            {(workflowKind === "pr_ui" || workflowKind === "issue_validation") && (
              <Alert severity="info">
                <AlertTitle>Validation also requires a configured driver</AlertTitle>
                Publishing this prompt will not enable validation or start a job. Configure the
                workflow's validation profile and driver separately.
              </Alert>
            )}
            <TextField
              label="Prompt content"
              required
              fullWidth
              multiline
              minRows={14}
              maxRows={26}
              className="prompts-code-editor"
              value={values.content}
              slotProps={{ htmlInput: { spellCheck: false } }}
              placeholder="Write the instructions for this workflow…"
              error={Boolean(fieldErrors.content)}
              helperText={
                fieldErrors.content ??
                "Content is preserved exactly as entered. Maximum size: 262,144 UTF-8 bytes."
              }
              onChange={(event) =>
                setValues((current) => ({ ...current, content: event.target.value }))
              }
            />
          </Stack>
        </Box>
      </Box>
      <Box
        sx={{ px: { xs: 2, sm: 3 }, py: 2, borderTop: 1, borderColor: "divider" }}
        className="prompts-drawer-actions"
      >
        <Button disabled={saving} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="create-prompt-form"
          variant="contained"
          loading={saving}
          disabled={!available || saving}
        >
          Create template
        </Button>
      </Box>
    </Drawer>
  );
}

function PromptWorkspace({
  repositoryId,
  scopeLabel,
}: {
  repositoryId: string | null;
  scopeLabel: string;
}) {
  const [activePromptTab, setActivePromptTab] = useState("templates");
  const [visitedPromptTabs, setVisitedPromptTabs] = useState<string[]>(["templates"]);

  const available = usePromptAvailable();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [workflowKind, setWorkflowKind] = useState<WorkflowKind | undefined>();
  const [creating, setCreating] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: promptQueryKeys.templateList(page, pageSize, workflowKind),
    queryFn: () =>
      configuration.listPrompts({ page, pageSize, ...(workflowKind ? { workflowKind } : {}) }),
    enabled: available,
  });
  const refresh = async () => {
    if (!available) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates }),
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindings }),
      queryClient.invalidateQueries({ queryKey: promptQueryKeys.bindingHistories }),
      queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot }),
    ]);
  };
  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Prompts"
        titleId="prompts-page-title"
        description="Write workflow instructions, publish versions, and choose which version each workflow uses."
        actions={
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Button
              loading={listQuery.isFetching}
              disabled={!available}
              onClick={refresh}
              variant="outlined"
              startIcon={<RefreshIcon />}
            >
              Refresh
            </Button>
            <Button
              disabled={!available}
              onClick={() => setCreating(true)}
              variant={"contained"}
              startIcon={<AddIcon />}
            >
              Create template
            </Button>
          </Stack>
        }
      />
      {process.env.NODE_ENV === "development" && (
        <Alert className="prompts-notice" severity={"info"}>
          <AlertTitle>{"Sample data"}</AlertTitle>
          {"This preview uses sample templates and bindings. Changes affect the preview only."}
        </Alert>
      )}
      <Box>
        <Tabs
          value={activePromptTab}
          onChange={(_event, next: string) => {
            setActivePromptTab(next);
            setVisitedPromptTabs((current) =>
              current.includes(next) ? current : [...current, next],
            );
          }}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab
            value={"templates"}
            label={"Templates"}
            disabled={!available}
            id={"PromptWorkspace-tab-" + "templates"}
            aria-controls={"PromptWorkspace-panel-" + "templates"}
          />
          <Tab
            value={"bindings"}
            label={"Workflow bindings"}
            disabled={!available}
            id={"PromptWorkspace-tab-" + "bindings"}
            aria-controls={"PromptWorkspace-panel-" + "bindings"}
          />
          <Tab
            value={"activity"}
            label={"Global prompt activity"}
            disabled={!available}
            id={"PromptWorkspace-tab-" + "activity"}
            aria-controls={"PromptWorkspace-panel-" + "activity"}
          />
        </Tabs>
        {visitedPromptTabs.includes("templates") && (
          <Box
            role="tabpanel"
            id={"PromptWorkspace-panel-" + "templates"}
            aria-labelledby={"PromptWorkspace-tab-" + "templates"}
            hidden={activePromptTab !== "templates"}
            sx={{ pt: 3 }}
          >
            {
              <>
                <div className="prompts-toolbar">
                  <Typography variant="body2" component="p" color="text.secondary">
                    Templates are shared across repositories. Workflow bindings select the versions
                    used by each repository.
                  </Typography>
                  <TextField
                    select
                    label="Filter templates by workflow"
                    className="prompts-workflow-filter"
                    value={workflowKind ?? ""}
                    disabled={!available}
                    onChange={(event) => {
                      setWorkflowKind(
                        event.target.value ? (event.target.value as WorkflowKind) : undefined,
                      );
                      setPage(1);
                    }}
                  >
                    <MenuItem value="">All workflows</MenuItem>
                    {workflowOptions.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </div>
                {listQuery.isError ? (
                  <Alert
                    action={
                      <Button
                        disabled={!available}
                        onClick={() => {
                          if (available) void listQuery.refetch();
                        }}
                        variant="outlined"
                      >
                        Try again
                      </Button>
                    }
                    severity={"error"}
                  >
                    <AlertTitle>{"Could not load templates"}</AlertTitle>
                    {configurationErrorMessage(listQuery.error)}
                  </Alert>
                ) : (
                  <>
                    <DataTable<PromptTemplateSummary>
                      rows={listQuery.data?.items ?? []}
                      columns={[
                        {
                          id: "name",
                          label: "Template",
                          render: (template) => {
                            const name = template.name;
                            return (
                              <div className="prompts-template-cell">
                                <Button
                                  className="prompts-name-link"
                                  disabled={!available}
                                  onClick={() => setSelectedTemplateId(template.id)}
                                  variant={"text"}
                                >
                                  {name}
                                </Button>
                                {template.description && (
                                  <span className="prompts-secondary prompts-break">
                                    {template.description}
                                  </span>
                                )}
                              </div>
                            );
                          },
                        },
                        {
                          id: "workflowKind",
                          label: "Workflow",
                          width: 230,
                          render: (row) => {
                            const value = row.workflowKind;
                            return workflowLabels[value];
                          },
                        },
                        {
                          id: "publication",
                          label: "Publication",
                          width: 150,
                          render: (template) => {
                            return (
                              <div className="prompts-template-cell">
                                <Chip
                                  size="medium"
                                  label={
                                    template.latestPublishedVersionId
                                      ? "Published version available"
                                      : "Draft only"
                                  }
                                  color={template.latestPublishedVersionId ? "primary" : "default"}
                                ></Chip>
                                <span className="prompts-secondary">
                                  Draft revision {template.draftRevision}
                                </span>
                              </div>
                            );
                          },
                        },
                        {
                          id: "updatedAt",
                          label: "Updated",
                          width: 170,
                          render: (row) => {
                            const value = row.updatedAt;
                            return (
                              <time dateTime={value}>
                                {new Date(value).toLocaleString("en-US")}
                              </time>
                            );
                          },
                        },
                        {
                          id: "edit",
                          label: "",
                          width: 105,
                          render: (template) => {
                            return (
                              <Button
                                disabled={!available}
                                onClick={() => setSelectedTemplateId(template.id)}
                                aria-label={`Edit ${template.name}`}
                                variant="outlined"
                              >
                                Open
                              </Button>
                            );
                          },
                        },
                      ]}
                      getRowId={(row) => row.id}
                      loading={listQuery.isFetching}
                      emptyTitle={
                        workflowKind
                          ? "No templates for this workflow."
                          : "Create a template to define your review instructions."
                      }
                    />
                    {!listQuery.isFetching && listQuery.data?.items.length === 0 && (
                      <Box sx={{ display: "flex", justifyContent: "center", pb: 2 }}>
                        <Button
                          variant="contained"
                          disabled={!available}
                          onClick={() => setCreating(true)}
                        >
                          Create template
                        </Button>
                      </Box>
                    )}
                    {(listQuery.data?.total ?? 0) > pageSize && (
                      <TablePagination
                        component="div"
                        page={page - 1}
                        rowsPerPage={pageSize}
                        count={listQuery.data?.total ?? 0}
                        rowsPerPageOptions={[20, 50]}
                        disabled={!available}
                        onPageChange={(_event, nextPage) => {
                          if (!available) return;
                          setPage(nextPage + 1);
                        }}
                        onRowsPerPageChange={(event) => {
                          if (!available) return;
                          setPage(1);
                          setPageSize(Number(event.target.value));
                        }}
                      />
                    )}
                  </>
                )}
              </>
            }
          </Box>
        )}
        {visitedPromptTabs.includes("bindings") && (
          <Box
            role="tabpanel"
            id={"PromptWorkspace-panel-" + "bindings"}
            aria-labelledby={"PromptWorkspace-tab-" + "bindings"}
            hidden={activePromptTab !== "bindings"}
            sx={{ pt: 3 }}
          >
            {
              <PromptBindings
                key={repositoryId ?? "global"}
                repositoryId={repositoryId}
                scopeLabel={scopeLabel}
              />
            }
          </Box>
        )}
        {visitedPromptTabs.includes("activity") && (
          <Box
            role="tabpanel"
            id={"PromptWorkspace-panel-" + "activity"}
            aria-labelledby={"PromptWorkspace-tab-" + "activity"}
            hidden={activePromptTab !== "activity"}
            sx={{ pt: 3 }}
          >
            {<GlobalPromptActivity enabled={available} />}
          </Box>
        )}
      </Box>
      {creating && (
        <CreatePromptDrawer
          initialWorkflowKind={workflowKind ?? "pr_static_build"}
          onClose={() => setCreating(false)}
          onCreated={(template) => {
            setCreating(false);
            setSelectedTemplateId(template.id);
            queryClient.setQueryData(promptQueryKeys.template(template.id), template);
            void queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates });
            void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
          }}
        />
      )}
      {selectedTemplateId && (
        <PromptEditor
          key={`${repositoryId ?? "global"}:${selectedTemplateId}`}
          templateId={selectedTemplateId}
          repositoryId={repositoryId}
          onClose={() => setSelectedTemplateId(null)}
        />
      )}
    </>
  );
}

export default function PromptsPage() {
  const scope = useRepositoryScope();
  return (
    <OperatorAccessGate platformOnly>
      <section className="prompts-page" aria-labelledby="prompts-page-title">
        <ConfigurationScopeGuard
          key={scope.key}
          scopeKey={scope.key}
          available={scope.ready && !scope.error}
          fallback={
            <>
              <PageHeader
                eyebrow="Configuration"
                title="Prompts"
                titleId="prompts-page-title"
                description="Load a valid repository scope to manage prompt templates and bindings."
              />
              <RepositoryScopeUnavailable />
            </>
          }
        >
          <PromptWorkspace
            key={scope.key}
            repositoryId={scope.repositoryId ?? null}
            scopeLabel={scope.repositoryId ? scope.label : "Global defaults"}
          />
        </ConfigurationScopeGuard>
      </section>
    </OperatorAccessGate>
  );
}
