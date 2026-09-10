import type {
  PromptPreviewResponse,
  PromptTemplate,
  PromptVersionSummary,
} from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Tab,
  TablePagination,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { GlobalPromptActivity } from "@/components/ConfigurationAudit";
import { configurationAuditQueryRoot } from "@/components/ConfigurationAudit/state";
import { ConfirmDialog, DataTable, DetailsGrid, notify } from "@/components/ui";
import { configuration } from "@/services/configuration";
import { usePromptAvailable } from "./access";
import {
  assertPromptPreviewScope,
  buildPromptDraftSave,
  buildPromptPreview,
  buildPromptPublish,
  configurationErrorMessage,
  isPromptConflict,
  workflowLabels,
} from "./forms";
import { invalidatePromptPublication, promptQueryKeys } from "./queries";

function PublishedVersionDetails({
  templateId,
  versionId,
  onClose,
}: {
  templateId: string;
  versionId: string;
  onClose: () => void;
}) {
  const available = usePromptAvailable();
  const query = useQuery({
    queryKey: promptQueryKeys.version(templateId, versionId),
    queryFn: () => configuration.getPromptVersion(templateId, versionId),
    enabled: available,
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
          "aria-label": "Published prompt · read only",
          sx: { width: { xs: "100%", sm: 760 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {"Published prompt · read only"}
        </Typography>
        <IconButton aria-label="Close" disabled={false} onClick={() => onClose()}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        {query.isPending ? (
          <CircularProgress aria-label="Loading" size={28} />
        ) : query.isError ? (
          <Alert
            action={
              <Button
                disabled={!available}
                onClick={() => {
                  if (available) void query.refetch();
                }}
                variant="outlined"
              >
                Try again
              </Button>
            }
            severity={"error"}
          >
            <AlertTitle>{"Could not load version"}</AlertTitle>
            {configurationErrorMessage(query.error)}
          </Alert>
        ) : (
          <>
            <div>
              <DetailsGrid
                columns={2}
                items={[
                  { key: "version", label: "Version", value: query.data.version },
                  {
                    key: "published",
                    label: "Published",
                    value: new Date(query.data.publishedAt).toLocaleString("en-US"),
                  },
                  {
                    key: "author",
                    label: "Published by",
                    value: <span className="prompts-break">{query.data.createdBy}</span>,
                  },
                  {
                    key: "schema",
                    label: "Output schema",
                    value: <code>{query.data.outputSchemaVersion}</code>,
                  },
                  {
                    key: "digest",
                    label: "Content SHA-256",
                    value: <code className="prompts-break">{query.data.contentSha256}</code>,
                  },
                ]}
              />
            </div>
            <Typography
              className="prompts-section-note"
              variant="body2"
              component="p"
              color="text.secondary"
            >
              Published content is immutable. Edit the template draft to prepare a new version.
            </Typography>
            <TextField
              className="prompts-readonly"
              value={query.data.content}
              fullWidth
              slotProps={{
                htmlInput: { "aria-label": "Published prompt content", readOnly: true },
              }}
              multiline
              minRows={14}
              maxRows={26}
            ></TextField>
          </>
        )}
      </Box>
    </Drawer>
  );
}

function PublishedVersions({ templateId }: { templateId: string }) {
  const available = usePromptAvailable();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: promptQueryKeys.versionList(templateId, page, pageSize),
    queryFn: () => configuration.listPromptVersions(templateId, { page, pageSize }),
    enabled: available,
  });
  return (
    <>
      <Typography variant="body2" component="p" color="text.secondary">
        Inspect immutable published versions. To roll back a workflow, choose an older published
        version in Workflow bindings.
      </Typography>
      {query.isError ? (
        <Alert
          action={
            <Button
              disabled={!available}
              onClick={() => {
                if (available) void query.refetch();
              }}
              variant="outlined"
            >
              Try again
            </Button>
          }
          severity={"error"}
        >
          <AlertTitle>{"Could not load published versions"}</AlertTitle>
          {configurationErrorMessage(query.error)}
        </Alert>
      ) : (
        <>
          <DataTable<PromptVersionSummary>
            rows={query.data?.items ?? []}
            columns={[
              {
                id: "version",
                label: "Version",
                width: 90,
                render: (row) => {
                  const version = row.version;
                  return <Chip size="medium" label={<>v{version}</>}></Chip>;
                },
              },
              {
                id: "publishedAt",
                label: "Published",
                width: 180,
                render: (row) => {
                  const value = row.publishedAt;
                  return new Date(value).toLocaleString("en-US");
                },
              },
              {
                id: "createdBy",
                label: "Published by",
                render: (row) => {
                  const value = row.createdBy;
                  return <span className="prompts-break">{value}</span>;
                },
              },
              {
                id: "view",
                label: "",
                width: 112,
                render: (item) => {
                  return (
                    <Button
                      disabled={!available}
                      onClick={() => setSelectedVersionId(item.id)}
                      variant={"text"}
                    >
                      Read version
                    </Button>
                  );
                },
              },
            ]}
            getRowId={(row) => row.id}
            loading={query.isFetching}
            emptyTitle={
              "No published versions. Save and publish the draft to create the first version."
            }
          />
          {(query.data?.total ?? 0) > pageSize && (
            <TablePagination
              component="div"
              page={page - 1}
              rowsPerPage={pageSize}
              count={query.data?.total ?? 0}
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
      {selectedVersionId && (
        <PublishedVersionDetails
          templateId={templateId}
          versionId={selectedVersionId}
          onClose={() => setSelectedVersionId(null)}
        />
      )}
    </>
  );
}

export function PromptEditor({
  templateId,
  repositoryId,
  onClose,
}: {
  templateId: string;
  repositoryId: string | null;
  onClose: () => void;
}) {
  const [activePromptTab, setActivePromptTab] = useState("draft");
  const [visitedPromptTabs, setVisitedPromptTabs] = useState<string[]>(["draft"]);

  const available = usePromptAvailable();
  const availableRef = useRef(available);
  availableRef.current = available;
  const queryClient = useQueryClient();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [baseline, setBaseline] = useState<PromptTemplate | null>(null);
  const [content, setContent] = useState("");
  const [workItemId, setWorkItemId] = useState("");
  const [operation, setOperation] = useState<"save" | "publish" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewGeneration = useRef(0);
  const templateQuery = useQuery({
    queryKey: promptQueryKeys.template(templateId),
    queryFn: () => configuration.getPrompt(templateId),
    enabled: available,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const dirty = baseline !== null && content !== baseline.draftContent;
  const busy = operation !== null;

  useEffect(() => {
    if (!baseline && templateQuery.data && !templateQuery.isFetching && !templateQuery.isError) {
      setBaseline(templateQuery.data);
      setContent(templateQuery.data.draftContent);
    }
  }, [baseline, templateQuery.data, templateQuery.isFetching, templateQuery.isError]);
  useEffect(() => {
    availableRef.current = available;
  }, [available]);
  useEffect(
    () => () => {
      availableRef.current = false;
      previewGeneration.current += 1;
    },
    [],
  );

  const clearPreview = () => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewError(null);
    setPreviewing(false);
  };

  const reload = async () => {
    if (!available) return;
    try {
      const result = await templateQuery.refetch({ throwOnError: true });
      if (!result.data) return;
      setBaseline(result.data);
      setContent(result.data.draftContent);
      setError(null);
      setNeedsReload(false);
      clearPreview();
    } catch (failure) {
      setError(configurationErrorMessage(failure));
    }
  };

  const save = async () => {
    if (!available || !baseline || busyRef.current || needsReload) return;
    busyRef.current = true;
    setOperation("save");
    setError(null);
    setNotice(null);
    try {
      const result = await configuration.savePromptDraft(
        templateId,
        buildPromptDraftSave(baseline, content),
      );
      setBaseline(result);
      setContent(result.draftContent);
      queryClient.setQueryData(promptQueryKeys.template(templateId), result);
      void queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates });
      void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
      setNotice("Draft saved. Publish it when it is ready for use.");
    } catch (failure) {
      setError(configurationErrorMessage(failure));
      setNeedsReload(isPromptConflict(failure));
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  };

  const publish = async () => {
    if (!available || !baseline || busyRef.current || needsReload) return;
    busyRef.current = true;
    setOperation("publish");
    setError(null);
    setNotice(null);
    try {
      const version = await configuration.publishPrompt(
        templateId,
        buildPromptPublish(baseline, content),
      );
      setNotice(
        `Version ${version.version} published. Select it in Workflow bindings to use it for future jobs. Publishing does not start a job.`,
      );
      await invalidatePromptPublication(queryClient, templateId);
      void queryClient.invalidateQueries({ queryKey: configurationAuditQueryRoot });
      if (!availableRef.current) {
        setError(
          "Publication succeeded. Verify access, then reload the updated draft before continuing.",
        );
        setNeedsReload(true);
        return;
      }
      try {
        const current = await configuration.getPrompt(templateId);
        setBaseline(current);
        setContent(current.draftContent);
        queryClient.setQueryData(promptQueryKeys.template(templateId), current);
      } catch (failure) {
        setError(
          `Publication succeeded, but the updated draft could not be loaded. ${configurationErrorMessage(failure)}`,
        );
        setNeedsReload(true);
      }
    } catch (failure) {
      setError(configurationErrorMessage(failure));
      setNeedsReload(isPromptConflict(failure));
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  };

  const renderPreview = async () => {
    if (!available || !baseline) return;
    const generation = ++previewGeneration.current;
    setPreviewing(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const request = buildPromptPreview(content, workItemId, baseline.workflowKind);
      const result = await configuration.previewPrompt(request);
      assertPromptPreviewScope(result, request, repositoryId);
      if (generation === previewGeneration.current) setPreview(result);
    } catch (failure) {
      if (generation === previewGeneration.current)
        setPreviewError(configurationErrorMessage(failure));
    } finally {
      if (generation === previewGeneration.current) setPreviewing(false);
    }
  };

  const close = () => {
    if (busyRef.current) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
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
          "aria-label": baseline?.name ?? "Prompt template",
          sx: { width: { xs: "100%", sm: 880 }, maxWidth: "100%" },
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, display: "flex", alignItems: "center", gap: 2 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {baseline?.name ?? "Prompt template"}
        </Typography>
        <IconButton aria-label="Close" disabled={busy} onClick={() => close()}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 3, overflowY: "auto", flex: 1 }}>
        <ConfirmDialog
          open={confirmDiscard}
          title="Discard unsaved draft changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onClose={() => setConfirmDiscard(false)}
          onConfirm={() => {
            if (!busyRef.current) onClose();
          }}
        >
          The last saved draft will be kept. Changes in this editor will be discarded.
        </ConfirmDialog>
        {!baseline ? (
          templateQuery.isError ? (
            <Alert
              action={
                <Button disabled={!available} onClick={reload} variant="outlined">
                  Try again
                </Button>
              }
              severity={"error"}
            >
              <AlertTitle>{"Could not load prompt"}</AlertTitle>
              {configurationErrorMessage(templateQuery.error)}
            </Alert>
          ) : (
            <CircularProgress aria-label="Loading" size={28} />
          )
        ) : (
          <>
            <div className="prompts-template-meta">
              <Chip size="medium" label={workflowLabels[baseline.workflowKind]}></Chip>
              <code>{baseline.draftOutputSchemaVersion}</code>
            </div>
            {baseline.description && (
              <Typography variant="body2" component="p" color="text.secondary">
                {baseline.description}
              </Typography>
            )}
            {(baseline.workflowKind === "pr_ui" ||
              baseline.workflowKind === "issue_validation") && (
              <Alert className="prompts-notice" severity={"info"}>
                <AlertTitle>{"Validation needs a configured driver"}</AlertTitle>
                {
                  "This prompt describes the task. Configure a compatible validation profile and driver separately before running this workflow."
                }
              </Alert>
            )}

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
                value={"draft"}
                label={"Draft"}
                disabled={!available}
                id={"PromptEditor-tab-" + "draft"}
                aria-controls={"PromptEditor-panel-" + "draft"}
              />
              <Tab
                value={"versions"}
                label={"Published versions"}
                disabled={!available}
                id={"PromptEditor-tab-" + "versions"}
                aria-controls={"PromptEditor-panel-" + "versions"}
              />
              <Tab
                value={"activity"}
                label={"Template activity"}
                disabled={!available}
                id={"PromptEditor-tab-" + "activity"}
                aria-controls={"PromptEditor-panel-" + "activity"}
              />
            </Tabs>
            {visitedPromptTabs.includes("draft") && (
              <Box
                role="tabpanel"
                id={"PromptEditor-panel-" + "draft"}
                aria-labelledby={"PromptEditor-tab-" + "draft"}
                hidden={activePromptTab !== "draft"}
                sx={{ pt: 3 }}
              >
                {
                  <>
                    {notice && (
                      <Alert className="prompts-notice" severity={"success"}>
                        <AlertTitle>{notice}</AlertTitle>
                      </Alert>
                    )}
                    {error && (
                      <Alert
                        className="prompts-notice"
                        action={
                          needsReload ? (
                            <Button
                              disabled={!available}
                              loading={templateQuery.isFetching}
                              onClick={reload}
                              variant="outlined"
                            >
                              Reload latest draft
                            </Button>
                          ) : undefined
                        }
                        severity={needsReload ? "warning" : "error"}
                      >
                        <AlertTitle>
                          {needsReload
                            ? "Reload the latest draft before continuing"
                            : "Could not complete the action"}
                        </AlertTitle>
                        {
                          <>
                            <p>{error}</p>
                            {needsReload && (
                              <p>
                                Your editor content has not been submitted again. Reloading replaces
                                it with the current saved draft.
                              </p>
                            )}
                          </>
                        }
                      </Alert>
                    )}
                    <div className="prompts-editor-status">
                      <span>Draft revision {baseline.draftRevision}</span>
                      <Chip
                        size="medium"
                        label={dirty ? "Unsaved changes" : "Saved draft"}
                        color={dirty ? "warning" : "default"}
                      ></Chip>
                    </div>
                    <label className="prompts-field-label" htmlFor="prompt-draft-content">
                      Prompt content
                    </label>
                    <TextField
                      id="prompt-draft-content"
                      className="prompts-code-editor"
                      value={content}
                      disabled={!available || busy}
                      onChange={(event) => {
                        setContent(event.target.value);
                        setNotice(null);
                        clearPreview();
                      }}
                      fullWidth
                      slotProps={{ htmlInput: { spellCheck: false } }}
                      multiline
                      minRows={16}
                      maxRows={30}
                    ></TextField>
                    <div className="prompts-editor-actions">
                      <Stack
                        direction="row"
                        spacing={1}
                        useFlexGap
                        sx={{ alignItems: "center", flexWrap: "wrap" }}
                      >
                        <Button
                          loading={operation === "save"}
                          disabled={
                            !available || !dirty || busy || needsReload || templateQuery.isFetching
                          }
                          onClick={save}
                          variant={"contained"}
                        >
                          Save draft
                        </Button>
                        <Button
                          loading={operation === "publish"}
                          disabled={
                            !available || dirty || busy || needsReload || templateQuery.isFetching
                          }
                          onClick={publish}
                          variant="outlined"
                        >
                          Publish saved draft
                        </Button>
                      </Stack>
                      <Typography variant="body2" component="span" color="text.secondary">
                        {dirty
                          ? "Save your changes before publishing."
                          : "Publishing creates an immutable version."}
                      </Typography>
                    </div>
                    <section className="prompts-preview" aria-labelledby="prompt-preview-heading">
                      <Typography id="prompt-preview-heading" variant="h6" component="h3">
                        Preview current content
                      </Typography>
                      <Typography variant="body2" component="p" color="text.secondary">
                        Preview does not save or publish. Optionally render with one work item's
                        context.
                      </Typography>
                      <Box sx={{ mb: 2 }}>
                        <TextField
                          label="Work item ID (optional)"
                          helperText="Use the exact internal work item ID, not a GitHub issue or pull request number."
                          id="prompt-preview-work-item"
                          value={workItemId}
                          placeholder="Exact work item ID"
                          disabled={!available || busy}
                          onChange={(event) => {
                            setWorkItemId(event.target.value);
                            clearPreview();
                          }}
                          fullWidth
                          slotProps={{ htmlInput: { maxLength: 128 } }}
                        ></TextField>
                      </Box>
                      <Button
                        loading={previewing}
                        disabled={!available || busy || !content.trim()}
                        onClick={renderPreview}
                        variant="outlined"
                      >
                        Render preview
                      </Button>
                      {previewError && (
                        <Alert className="prompts-preview-result" severity={"error"}>
                          <AlertTitle>{"Preview unavailable"}</AlertTitle>
                          {previewError}
                        </Alert>
                      )}
                      {preview && (
                        <div className="prompts-preview-result">
                          <div className="prompts-preview-meta">
                            <Chip size="medium" label={<>Preview only</>}></Chip>
                            <span>
                              {preview.workItemId
                                ? `Work item: ${preview.workItemId}`
                                : "Template without work item context"}
                            </span>
                          </div>
                          <div className={"prompts-preview-digest"}>
                            <DetailsGrid
                              columns={1}
                              items={[
                                {
                                  key: "rendered-digest",
                                  label: "Rendered SHA-256",
                                  value: (
                                    <Stack
                                      direction="row"
                                      spacing={0.5}
                                      sx={{ minWidth: 0, alignItems: "center" }}
                                    >
                                      <Typography
                                        className="prompts-break"
                                        variant="body2"
                                        component="code"
                                      >
                                        {preview.contentSha256}
                                      </Typography>
                                      <IconButton
                                        size="medium"
                                        aria-label="Copy value"
                                        onClick={() => {
                                          void navigator.clipboard
                                            .writeText(preview.contentSha256)
                                            .catch(() =>
                                              notify("Could not copy the value.", "error"),
                                            );
                                        }}
                                      >
                                        <ContentCopyIcon fontSize="inherit" />
                                      </IconButton>
                                    </Stack>
                                  ),
                                },
                              ]}
                            />
                          </div>
                          <TextField
                            className="prompts-readonly"
                            value={preview.renderedContent}
                            fullWidth
                            slotProps={{
                              htmlInput: {
                                "aria-label": "Rendered prompt preview",
                                readOnly: true,
                              },
                            }}
                            multiline
                            minRows={14}
                            maxRows={26}
                          ></TextField>
                        </div>
                      )}
                    </section>
                  </>
                }
              </Box>
            )}
            {visitedPromptTabs.includes("versions") && (
              <Box
                role="tabpanel"
                id={"PromptEditor-panel-" + "versions"}
                aria-labelledby={"PromptEditor-tab-" + "versions"}
                hidden={activePromptTab !== "versions"}
                sx={{ pt: 3 }}
              >
                {<PublishedVersions templateId={templateId} />}
              </Box>
            )}
            {visitedPromptTabs.includes("activity") && (
              <Box
                role="tabpanel"
                id={"PromptEditor-panel-" + "activity"}
                aria-labelledby={"PromptEditor-tab-" + "activity"}
                hidden={activePromptTab !== "activity"}
                sx={{ pt: 3 }}
              >
                {<GlobalPromptActivity templateId={templateId} enabled={available} />}
              </Box>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}
