import * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
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
    <Card size="small" title="Create sample set">
      <Form layout="vertical" disabled={locked}>
        <Form.Item label="Name" required>
          <Input value={name} maxLength={128} onChange={(event) => setName(event.target.value)} />
        </Form.Item>
        <Form.Item label="Description">
          <Input.TextArea
            value={description}
            maxLength={2048}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Form.Item>
        <div className="evaluation-field-grid">
          <Form.Item label="Workflow">
            <Select
              value={workflow}
              options={(kind === "pull_request"
                ? (["pr_static_build", "pr_ui"] as const)
                : (["issue_triage", "issue_validation"] as const)
              ).map((value) => ({ value, label: workflowLabels[value] }))}
              onChange={(value) => {
                setWorkflow(value);
                setTarget(value === "pr_ui" ? "windows_desktop" : "headless");
              }}
            />
          </Form.Item>
          <Form.Item label="Target">
            <Select
              value={target}
              options={targets.map((value) => ({ value, label: targetLabels[value] }))}
              onChange={setTarget}
            />
          </Form.Item>
        </div>
      </Form>
      <p className="evaluation-meta">
        Workflow and target stay fixed for this sample set. Creation does not start any execution.
      </p>
      {error ? <Alert type="error" title={error} /> : null}
      <MutationNotice mutation={mutation} />
      <Button type="primary" disabled={locked} loading={mutation.busy} onClick={create}>
        Create sample set
      </Button>
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
  const scope = { repositoryId: page.repositoryId, suiteId: selected ?? "" };
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
        previous ? { ...previous, revision: result.sourceDraftRevision + 1 } : null,
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
      publish.submit({ changeId: newIdentity(), expectedRevision: editor.revision });
  };
  const add = (source: C.EvaluationSourceSummaryV1) => {
    if (!editor || locked || view !== "draft" || editor.draft.cases.length >= 32) return;
    setEditor({
      ...editor,
      draft: { ...editor.draft, cases: [...editor.draft.cases, newCase(source)] },
    });
  };
  return (
    <div className="evaluation-kind-workspace">
      <div className="evaluation-workspace-grid">
        <Card
          title={`${kind === "pull_request" ? "PR" : "Issue"} sample sets`}
          className="evaluation-suite-navigation"
          extra={
            page.allowsConfigure ? (
              <Button
                size="small"
                disabled={!page.canConfigure || pending || dirty}
                onClick={() => {
                  setCreateVisited(true);
                  setCreateOpen((value) => !value);
                }}
              >
                New set
              </Button>
            ) : null
          }
        >
          <List<C.EvaluationSuiteSummaryV1>
            dataSource={suites}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: "No sample sets for this item kind." }}
            renderItem={(suite) => (
              <List.Item>
                <Button
                  type={selected === suite.id ? "primary" : "text"}
                  className="evaluation-suite-choice"
                  disabled={(pending || dirty || reloading) && selected !== suite.id}
                  onClick={() => select(suite.id)}
                >
                  <span>{suite.name}</span>
                  <span className="evaluation-meta">
                    {workflowLabels[suite.workflowKind]} · {targetLabels[suite.target]}
                    <br />
                    {suite.caseCount} draft cases · revision {suite.draftRevision}
                  </span>
                </Button>
              </List.Item>
            )}
          />
          {dirty ? (
            <p className="evaluation-meta">
              Save or discard the current draft before opening another set.
            </p>
          ) : null}
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
            <Card>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Choose a sample set or create one to label frozen examples."
              />
            </Card>
          ) : (
            <Card
              title={
                <Space>
                  <Typography.Text strong>{detail.data?.name ?? "Sample set"}</Typography.Text>
                  <Tag>{detail.data ? workflowLabels[detail.data.workflowKind] : "Loading"}</Tag>
                  <Tag>{detail.data ? targetLabels[detail.data.target] : ""}</Tag>
                </Space>
              }
              extra={
                <Space>
                  <Button
                    type={view === "draft" ? "primary" : "default"}
                    onClick={() => setView("draft")}
                  >
                    Draft
                  </Button>
                  <Button
                    type={view === "versions" ? "primary" : "default"}
                    onClick={() => setView("versions")}
                  >
                    Published versions
                  </Button>
                  <Button
                    type={view === "batches" ? "primary" : "default"}
                    onClick={() => setView("batches")}
                  >
                    Evaluation batches
                  </Button>
                </Space>
              }
            >
              {notice ? <Alert type="success" title={notice} /> : null}
              {detail.error ? (
                <Alert
                  type="error"
                  title="Sample set unavailable"
                  description={errorMessage(detail.error)}
                />
              ) : null}
              <div hidden={view !== "draft"}>
                {editor ? (
                  <>
                    <div className="evaluation-subheading">
                      <span className="evaluation-meta">
                        Draft revision {editor.revision} · {editor.draft.cases.length}/32 cases
                        {dirty ? " · Unsaved changes" : ""}
                      </span>
                      <Space>
                        <Button
                          disabled={pending || !page.readable || reloading}
                          loading={reloading}
                          onClick={() => void reload()}
                        >
                          {dirty || conflict ? "Discard draft and reload" : "Reload draft"}
                        </Button>
                        {page.allowsConfigure ? (
                          <>
                            <Button
                              disabled={locked || !dirty}
                              loading={save.busy}
                              onClick={saveDraft}
                            >
                              Save draft
                            </Button>
                            <Button
                              type="primary"
                              disabled={locked || dirty}
                              loading={publish.busy}
                              onClick={publishDraft}
                            >
                              Publish version
                            </Button>
                          </>
                        ) : null}
                      </Space>
                    </div>
                    {dirty ? (
                      <p className="evaluation-meta">
                        Save this draft before publishing. Publication freezes all source and
                        expectation labels.
                      </p>
                    ) : null}
                    {newerRevision ? (
                      <Alert
                        type="warning"
                        title="A newer saved revision is available"
                        description="Your editor and its revision are preserved. Discard and reload to review the newer saved draft."
                      />
                    ) : null}
                    {error ? (
                      <Alert
                        type="error"
                        title="Complete the draft before continuing"
                        description={error}
                      />
                    ) : null}
                    <MutationNotice mutation={save} />
                    <MutationNotice mutation={publish} />
                    <CaseEditor
                      value={editor.draft}
                      sources={sources}
                      disabled={locked}
                      onChange={(draft) => {
                        if (!locked) setEditor({ ...editor, draft });
                      }}
                    />
                  </>
                ) : (
                  <Typography.Paragraph type="secondary">Loading draft…</Typography.Paragraph>
                )}
              </div>
              <div hidden={view !== "versions"}>
                <PublishedVersion
                  key={`${selected}:${versionId ?? "initial"}`}
                  suiteId={selected}
                  preferredVersionId={versionId ?? detail.data?.latestVersionId ?? null}
                  active={active && view === "versions"}
                  sources={sources}
                />
              </div>
              {editor ? (
                <div hidden={view !== "batches"}>
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
            </Card>
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
