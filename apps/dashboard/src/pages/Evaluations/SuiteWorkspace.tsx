import * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Pagination,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/ui";
import { BatchWorkspace } from "./BatchWorkspace";
import { CaseEditor } from "./CaseEditor";
import {
  MutationNotice,
  useEvaluationPage,
  useEvaluationQuery,
  useOriginalMutation,
  useRefreshEvaluations,
} from "./context";
import { PublishedVersion } from "./PublishedVersion";
import { SourceLibrary } from "./Sources";
import {
  errorMessage,
  newCase,
  newIdentity,
  type SampleKind,
  targetLabels,
  workflowLabels,
} from "./state";

function CreateSuite({
  kind,
  onCreated,
  onPendingChange,
}: {
  kind: SampleKind;
  onCreated: (suite: C.EvaluationSuiteSummaryV1) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const page = useEvaluationPage();
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [workflow, setWorkflow] = useState<C.WorkflowKind>(
    kind === "pull_request" ? "pr_static_build" : "issue_triage",
  );
  const [target, setTarget] = useState<C.ValidationTarget>("headless"),
    [error, setError] = useState<string | null>(null);
  const mutation = useOriginalMutation<C.EvaluationSuiteCreateRequest, C.EvaluationSuiteSummaryV1>(
    (request) => page.api.createSuite(page.repositoryId, request, page.principal),
    onCreated,
  );
  useEffect(() => {
    onPendingChange(mutation.busy || mutation.request !== null);
  }, [mutation.busy, mutation.request, onPendingChange]);
  const locked = !page.canConfigure || mutation.busy || mutation.request !== null;
  const targets: C.ValidationTarget[] =
    workflow === "pr_ui"
      ? ["windows_desktop", "web"]
      : workflow === "issue_validation"
        ? ["headless", "windows_desktop", "web"]
        : ["headless"];
  const create = () => {
    if (locked) return;
    const request: C.EvaluationSuiteCreateRequest = {
      changeId: newIdentity(),
      name,
      description,
      workflowKind: workflow,
      target,
    };
    const issues = C.getEvaluationSuiteCreateRequestIssues(request);
    setError(issues.length ? "Enter a sample set name and a supported workflow and target." : null);
    if (!issues.length) mutation.submit(request);
  };
  return (
    <Card variant="outlined">
      <CardHeader
        title={"Create sample set"}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Stack
          disabled={locked}
          component="fieldset"
          spacing={2}
          sx={{
            border: 0,
            p: 0,
            m: 0,
            minWidth: 0,
          }}
        >
          <TextField
            value={name}
            onChange={(event) => setName(event.target.value)}
            fullWidth
            label={"Name"}
            required={true}
            disabled={locked}
            slotProps={{
              htmlInput: {
                maxLength: 128,
              },
            }}
          />
          <TextField
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            fullWidth
            label={"Description"}
            disabled={locked}
            slotProps={{
              htmlInput: {
                maxLength: 2048,
              },
            }}
            multiline
            minRows={2}
          />
          <div className="evaluation-field-grid">
            <Autocomplete
              options={(kind === "pull_request"
                ? (["pr_static_build", "pr_ui"] as const)
                : (["issue_triage", "issue_validation"] as const)
              ).map((value) => ({
                value,
                label: workflowLabels[value],
              }))}
              disablePortal
              fullWidth
              disabled={locked}
              value={
                (kind === "pull_request"
                  ? (["pr_static_build", "pr_ui"] as const)
                  : (["issue_triage", "issue_validation"] as const)
                )
                  .map((value) => ({
                    value,
                    label: workflowLabels[value],
                  }))
                  .find((option) => option.value === workflow) ??
                (workflow == null || String(workflow) === ""
                  ? null
                  : {
                      value: workflow as NonNullable<typeof workflow>,
                      label: String(workflow),
                    })
              }
              onChange={(_event, option) => {
                if (option !== null)
                  ((value) => {
                    setWorkflow(value);
                    setTarget(value === "pr_ui" ? "windows_desktop" : "headless");
                  })(option.value as NonNullable<typeof workflow>);
              }}
              getOptionLabel={(option) => option.label}
              isOptionEqualToValue={(option, selected) => option.value === selected.value}
              getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={"Workflow"}
                  slotProps={{
                    ...params.slotProps,
                    htmlInput: {
                      ...params.slotProps.htmlInput,
                      "aria-label": "Workflow",
                    },
                  }}
                />
              )}
              disableClearable={Boolean(workflow)}
              getOptionKey={(option) => option.value}
            />
            <Autocomplete
              options={targets.map((value) => ({
                value,
                label: targetLabels[value],
              }))}
              disablePortal
              fullWidth
              disabled={locked}
              value={
                targets
                  .map((value) => ({
                    value,
                    label: targetLabels[value],
                  }))
                  .find((option) => option.value === target) ??
                (target == null || String(target) === ""
                  ? null
                  : {
                      value: target as NonNullable<typeof target>,
                      label: String(target),
                    })
              }
              onChange={(_event, option) => {
                if (option !== null) setTarget(option.value as NonNullable<typeof target>);
              }}
              getOptionLabel={(option) => option.label}
              isOptionEqualToValue={(option, selected) => option.value === selected.value}
              getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={"Target"}
                  slotProps={{
                    ...params.slotProps,
                    htmlInput: {
                      ...params.slotProps.htmlInput,
                      "aria-label": "Target",
                    },
                  }}
                />
              )}
              disableClearable={Boolean(target)}
              getOptionKey={(option) => option.value}
            />
          </div>
        </Stack>
        <p className="evaluation-meta">
          Workflow and target stay fixed for this sample set. Creation does not start any execution.
        </p>
        {error ? (
          <Alert severity={"error"}>
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        ) : null}
        <MutationNotice mutation={mutation} />
        <Button disabled={locked} loading={mutation.busy} onClick={create} variant="contained">
          Create sample set
        </Button>
      </CardContent>
    </Card>
  );
}
interface EditorState {
  suiteId: string;
  revision: number;
  draft: C.EvaluationSuiteDraft;
  savedJson: string;
  workflowKind: C.WorkflowKind;
  target: C.ValidationTarget;
}
export function SuiteWorkspace({
  kind,
  suites,
  sources,
  active,
}: {
  kind: SampleKind;
  suites: C.EvaluationSuiteSummaryV1[];
  sources: C.EvaluationSourceSummaryV1[];
  active: boolean;
}) {
  const [suitePage, setSuitePage] = useState(1);
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const [selected, setSelected] = useState<string | null>(null),
    [editor, setEditor] = useState<EditorState | null>(null);
  const [createOpen, setCreateOpen] = useState(false),
    [createVisited, setCreateVisited] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [view, setView] = useState<"draft" | "versions" | "batches">("draft"),
    [versionId, setVersionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [reloading, setReloading] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const scope = {
    repositoryId: page.repositoryId,
    suiteId: selected ?? "",
  };
  const detail = useEvaluationQuery(
    ["suite", selected],
    (signal) => page.api.getSuite(scope, signal),
    selected !== null,
  );
  useEffect(() => {
    if (detail.data && (!editor || editor.suiteId !== detail.data.id)) {
      setEditor({
        suiteId: detail.data.id,
        revision: detail.data.draftRevision,
        draft: structuredClone(detail.data.draft),
        savedJson: JSON.stringify(detail.data.draft),
        workflowKind: detail.data.workflowKind,
        target: detail.data.target,
      });
    }
  }, [detail.data, editor]);
  const save = useOriginalMutation<C.EvaluationSuiteSaveRequest, C.EvaluationSuiteSummaryV1>(
    (request) => page.api.saveSuiteDraft(scope, request, page.principal),
    (result) => {
      setEditor((previous) =>
        previous
          ? {
              ...previous,
              revision: result.draftRevision,
              savedJson: JSON.stringify(previous.draft),
            }
          : null,
      );
      setNotice(`Draft revision ${result.draftRevision} saved.`);
      refresh();
    },
  );
  const publish = useOriginalMutation<C.EvaluationSuitePublishRequest, C.EvaluationSuiteVersionV1>(
    (request) => page.api.publishSuite(scope, request, page.principal),
    (result) => {
      setEditor((previous) =>
        previous
          ? {
              ...previous,
              revision: result.sourceDraftRevision + 1,
            }
          : null,
      );
      setVersionId(result.id);
      setView("versions");
      setNotice(`Version ${result.version} published with ${result.caseCount} frozen cases.`);
      refresh();
    },
  );
  const dirty = !!editor && JSON.stringify(editor.draft) !== editor.savedJson;
  const pending =
    createPending ||
    batchPending ||
    save.request !== null ||
    publish.request !== null ||
    save.busy ||
    publish.busy;
  const newerRevision = !!detail.data && !!editor && detail.data.draftRevision > editor.revision;
  const conflict = save.conflict || publish.conflict || newerRevision;
  const locked = !page.canConfigure || pending || reloading || conflict;
  const select = (suiteId: string) => {
    if (pending || dirty || reloading) return;
    setSelected(suiteId);
    setEditor(null);
    setView("draft");
    setVersionId(null);
    setNotice(null);
    setError(null);
    save.reset();
    publish.reset();
  };
  const reload = async () => {
    if (!page.readable || pending || reloading || !selected) return;
    setReloading(true);
    const result = await detail.refetch();
    if (!live.current) return;
    setReloading(false);
    if (result.data && !result.isError) {
      setEditor({
        suiteId: result.data.id,
        revision: result.data.draftRevision,
        draft: structuredClone(result.data.draft),
        savedJson: JSON.stringify(result.data.draft),
        workflowKind: result.data.workflowKind,
        target: result.data.target,
      });
      save.reset();
      publish.reset();
      setError(null);
      setNotice("The saved draft is loaded.");
    }
  };
  const saveDraft = () => {
    if (!editor || locked) return;
    const issues = C.getEvaluationSuiteDraftIssues(editor.draft);
    setError(issues[0] ?? null);
    if (!issues.length)
      save.submit({
        changeId: newIdentity(),
        expectedRevision: editor.revision,
        draft: editor.draft,
      });
  };
  const publishDraft = () => {
    if (!editor || locked || dirty) return;
    const issues = C.getEvaluationSuitePublicationIssues(editor.draft);
    setError(issues[0] ?? null);
    if (!issues.length)
      publish.submit({
        changeId: newIdentity(),
        expectedRevision: editor.revision,
      });
  };
  const add = (source: C.EvaluationSourceSummaryV1) => {
    if (!editor || locked || view !== "draft" || editor.draft.cases.length >= 32) return;
    setEditor({
      ...editor,
      draft: {
        ...editor.draft,
        cases: [...editor.draft.cases, newCase(source)],
      },
    });
  };
  return (
    <div className="evaluation-kind-workspace">
      <div className="evaluation-workspace-grid">
        <Card className="evaluation-suite-navigation" variant="outlined">
          <CardHeader
            title={`${kind === "pull_request" ? "PR" : "Issue"} sample sets`}
            action={
              page.allowsConfigure ? (
                <Button
                  disabled={!page.canConfigure || pending || dirty}
                  onClick={() => {
                    setCreateVisited(true);
                    setCreateOpen((value) => !value);
                  }}
                  variant="outlined"
                >
                  New set
                </Button>
              ) : null
            }
            slotProps={{
              title: {
                variant: "subtitle1",
                component: "h3",
              },
            }}
          />
          <CardContent>
            <>
              {suites.length === 0 ? (
                <EmptyState title="No sample sets for this item kind." />
              ) : (
                <List disablePadding>
                  {suites
                    .slice(
                      (Math.min(suitePage, Math.max(1, Math.ceil(suites.length / 10))) - 1) * 10,
                      Math.min(suitePage, Math.max(1, Math.ceil(suites.length / 10))) * 10,
                    )
                    .map((suite) => (
                      <ListItem key={suite.id} disableGutters>
                        <ListItemButton
                          className="evaluation-suite-choice"
                          disabled={(pending || dirty || reloading) && selected !== suite.id}
                          onClick={() => select(suite.id)}
                          selected={selected === suite.id}
                          aria-current={selected === suite.id ? "true" : undefined}
                        >
                          <ListItemText
                            primary={suite.name}
                            secondary={
                              <>
                                {workflowLabels[suite.workflowKind]} · {targetLabels[suite.target]}
                                <br />
                                {suite.caseCount} draft cases · revision {suite.draftRevision}
                              </>
                            }
                            slotProps={{
                              primary: { variant: "subtitle1" },
                              secondary: { variant: "body2" },
                            }}
                          />
                        </ListItemButton>
                      </ListItem>
                    ))}
                </List>
              )}
              {suites.length > 10 ? (
                <Pagination
                  count={Math.max(1, Math.ceil(suites.length / 10))}
                  page={Math.min(suitePage, Math.max(1, Math.ceil(suites.length / 10)))}
                  onChange={(_event, page) => setSuitePage(page)}
                  sx={{
                    mt: 2,
                  }}
                />
              ) : null}
            </>
            {dirty ? (
              <p className="evaluation-meta">
                Save or discard the current draft before opening another set.
              </p>
            ) : null}
          </CardContent>
        </Card>
        <div className="evaluation-editor-area">
          {createVisited ? (
            <div hidden={!createOpen}>
              <CreateSuite
                kind={kind}
                onPendingChange={setCreatePending}
                onCreated={(suite) => {
                  setCreateOpen(false);
                  setSelected(suite.id);
                  setEditor(null);
                  setVersionId(null);
                  setView("draft");
                  setNotice("Sample set created. Add a case from the source library.");
                  refresh();
                }}
              />
            </div>
          ) : null}
          {!selected ? (
            <Card variant="outlined">
              <CardContent>
                <EmptyState title={"Choose a sample set or create one to label frozen examples."} />
              </CardContent>
            </Card>
          ) : (
            <Box component="section" className="evaluation-workspace">
              <Stack
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 1,
                }}
              >
                <Typography component="h2" variant="h5">
                  {detail.data?.name ?? "Sample set"}
                </Typography>
                <Chip label={detail.data ? workflowLabels[detail.data.workflowKind] : "Loading"} />
                <Chip label={detail.data ? targetLabels[detail.data.target] : ""} />
              </Stack>
              <Tabs
                value={view}
                onChange={(_event, value: "draft" | "versions" | "batches") => setView(value)}
                aria-label="Sample set workspace"
                variant="scrollable"
                scrollButtons="auto"
                allowScrollButtonsMobile
              >
                <Tab
                  label="Draft"
                  value="draft"
                  id={`${kind}-suite-tab-draft`}
                  aria-controls={`${kind}-suite-panel-draft`}
                />
                <Tab
                  label="Published versions"
                  value="versions"
                  id={`${kind}-suite-tab-versions`}
                  aria-controls={`${kind}-suite-panel-versions`}
                />
                <Tab
                  label="Evaluation batches"
                  value="batches"
                  id={`${kind}-suite-tab-batches`}
                  aria-controls={`${kind}-suite-panel-batches`}
                />
              </Tabs>
              <Box>
                {notice ? (
                  <Alert severity={"success"}>
                    <AlertTitle>{notice}</AlertTitle>
                  </Alert>
                ) : null}
                {detail.error ? (
                  <Alert severity={"error"}>
                    <AlertTitle>{"Sample set unavailable"}</AlertTitle>
                    {errorMessage(detail.error)}
                  </Alert>
                ) : null}
                <div
                  role="tabpanel"
                  id={`${kind}-suite-panel-draft`}
                  aria-labelledby={`${kind}-suite-tab-draft`}
                  hidden={view !== "draft"}
                >
                  {editor ? (
                    <>
                      <div className="evaluation-subheading">
                        <span className="evaluation-meta">
                          Draft revision {editor.revision} · {editor.draft.cases.length}/32 cases
                          {dirty ? " · Unsaved changes" : ""}
                        </span>
                        <Stack
                          direction="row"
                          spacing={1.5}
                          sx={{
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: 1,
                          }}
                        >
                          <Button
                            disabled={pending || !page.readable || reloading}
                            loading={reloading}
                            onClick={() => void reload()}
                            variant="outlined"
                          >
                            {dirty || conflict ? "Discard draft and reload" : "Reload draft"}
                          </Button>
                          {page.allowsConfigure ? (
                            <>
                              <Button
                                disabled={locked || !dirty}
                                loading={save.busy}
                                onClick={saveDraft}
                                variant="outlined"
                              >
                                Save draft
                              </Button>
                              <Button
                                disabled={locked || dirty}
                                loading={publish.busy}
                                onClick={publishDraft}
                                variant="contained"
                              >
                                Publish version
                              </Button>
                            </>
                          ) : null}
                        </Stack>
                      </div>
                      {dirty ? (
                        <p className="evaluation-meta">
                          Save this draft before publishing. Publication freezes all source and
                          expectation labels.
                        </p>
                      ) : null}
                      {newerRevision ? (
                        <Alert severity={"warning"}>
                          <AlertTitle>{"A newer saved revision is available"}</AlertTitle>
                          {
                            "Your editor and its revision are preserved. Discard and reload to review the newer saved draft."
                          }
                        </Alert>
                      ) : null}
                      {error ? (
                        <Alert severity={"error"}>
                          <AlertTitle>{"Complete the draft before continuing"}</AlertTitle>
                          {error}
                        </Alert>
                      ) : null}
                      <MutationNotice mutation={save} />
                      <MutationNotice mutation={publish} />
                      <CaseEditor
                        value={editor.draft}
                        sources={sources}
                        disabled={locked}
                        onChange={(draft) => {
                          if (!locked)
                            setEditor({
                              ...editor,
                              draft,
                            });
                        }}
                      />
                    </>
                  ) : (
                    <Typography component="p" variant="body2" color={"text.secondary"}>
                      Loading draft…
                    </Typography>
                  )}
                </div>
                <div
                  role="tabpanel"
                  id={`${kind}-suite-panel-versions`}
                  aria-labelledby={`${kind}-suite-tab-versions`}
                  hidden={view !== "versions"}
                >
                  <PublishedVersion
                    key={`${selected}:${versionId ?? "initial"}`}
                    suiteId={selected}
                    preferredVersionId={versionId ?? detail.data?.latestVersionId ?? null}
                    active={active && view === "versions"}
                    sources={sources}
                  />
                </div>
                {editor ? (
                  <div
                    role="tabpanel"
                    id={`${kind}-suite-panel-batches`}
                    aria-labelledby={`${kind}-suite-tab-batches`}
                    hidden={view !== "batches"}
                  >
                    <BatchWorkspace
                      key={selected}
                      suiteId={selected}
                      workflowKind={editor.workflowKind}
                      target={editor.target}
                      active={active && view === "batches"}
                      onPendingChange={setBatchPending}
                    />
                  </div>
                ) : null}
              </Box>
            </Box>
          )}
        </div>
      </div>
      <SourceLibrary
        kind={kind}
        sources={sources}
        onAdd={editor ? add : undefined}
        allowAdd={!!editor && !locked && view === "draft" && editor.draft.cases.length < 32}
      />
    </div>
  );
}
