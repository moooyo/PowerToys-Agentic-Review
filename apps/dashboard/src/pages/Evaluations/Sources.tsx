import * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Pagination,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { reviewControl } from "@/services/review-control";
import type { WorkItem } from "@/services/review-control/types";
import {
  MutationNotice,
  useEvaluationPage,
  useEvaluationQuery,
  useOriginalMutation,
  useRefreshEvaluations,
} from "./context";
import { errorMessage, newIdentity, type SampleKind } from "./state";

export function FrozenSourceLabel({ source }: { source: C.EvaluationSourceSummaryV1 }) {
  return (
    <div className="evaluation-source-signature">
      <Space size={8}>
        <Tag>
          {source.workItemKind === "pull_request" ? "PR" : "Issue"} #{source.number}
        </Tag>
        <Typography.Text strong>{source.title}</Typography.Text>
      </Space>
      <span className="evaluation-meta" title={source.revisionKey}>
        Frozen revision {source.revisionKey.slice(0, 12)} · {source.id}
      </span>
    </div>
  );
}

export function CaseSourceLabel({
  sourceId,
  known,
}: {
  sourceId: string;
  known?: C.EvaluationSourceSummaryV1;
}) {
  const page = useEvaluationPage();
  const query = useEvaluationQuery(
    ["source", sourceId],
    (signal) => page.api.getSource({ repositoryId: page.repositoryId, sourceId }, signal),
    !known,
  );
  const source = known ?? query.data;
  return source ? (
    <FrozenSourceLabel source={source} />
  ) : (
    <Typography.Text type={query.isError ? "danger" : "secondary"}>
      {query.isError ? "Frozen source unavailable" : "Loading frozen source…"} · {sourceId}
    </Typography.Text>
  );
}

export function SourceDetails({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const page = useEvaluationPage();
  const query = useEvaluationQuery(["source", sourceId], (signal) =>
    page.api.getSource({ repositoryId: page.repositoryId, sourceId }, signal),
  );
  const source = query.data;
  return (
    <Card
      size="small"
      title="Captured source"
      extra={<Button onClick={onClose}>Close source</Button>}
      loading={query.isPending}
    >
      {query.error ? (
        <Alert type="error" title="Source unavailable" description={errorMessage(query.error)} />
      ) : source ? (
        <>
          <FrozenSourceLabel source={source} />
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: "captured", label: "Captured", children: source.createdAt },
              {
                key: "digest",
                label: "Source digest",
                children: <Typography.Text copyable>{source.sourceDigest}</Typography.Text>,
              },
              {
                key: "commit",
                label: "Checkout",
                children: source.snapshot.testedSourceRevision
                  ? source.snapshot.testedSourceRevision.headSha
                  : "Snapshot only",
              },
              {
                key: "origin",
                label: "Original item",
                children: (
                  <a href={source.snapshot.workItem.htmlUrl} target="_blank" rel="noreferrer">
                    Open {source.workItemKind === "pull_request" ? "pull request" : "issue"} #
                    {source.number}
                  </a>
                ),
              },
            ]}
          />
          <Typography.Text strong>Frozen body</Typography.Text>
          <pre className="evaluation-source-body">
            {source.snapshot.workItem.body ?? "No body was provided."}
          </pre>
        </>
      ) : null}
    </Card>
  );
}

function SourceCapture({ kind, active }: { kind: SampleKind; active: boolean }) {
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const [method, setMethod] = useState<"current_work_item" | "review_run">("current_work_item");
  const [search, setSearch] = useState(""),
    [itemPage, setItemPage] = useState(1);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [commit, setCommit] = useState(""),
    [runId, setRunId] = useState(""),
    [planDigest, setPlanDigest] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<C.EvaluationSourceSummaryV1 | null>(null);
  const workItems = useEvaluationQuery(
    ["capture-items", kind, search, itemPage],
    async () => {
      const result = await reviewControl.listWorkItems({
        page: itemPage,
        pageSize: 20,
        search,
        filters: { repositoryId: page.repositoryId, kind },
      });
      if (
        result.items.some((item) => item.repositoryId !== page.repositoryId || item.kind !== kind)
      )
        throw new Error("The work-item list does not match this repository and item kind.");
      return result;
    },
    active && method === "current_work_item",
  );
  const mutation = useOriginalMutation<
    C.EvaluationSourceCaptureRequest,
    C.EvaluationSourceSummaryV1
  >(
    (request) => page.api.captureSource(page.repositoryId, request, page.principal),
    (result) => {
      setCaptured(result);
      refresh();
    },
  );
  const locked = !page.canConfigure || mutation.busy || mutation.request !== null;
  const capture = () => {
    if (locked) return;
    setValidationError(null);
    const request: C.EvaluationSourceCaptureRequest = {
      changeId: newIdentity(),
      source:
        method === "review_run"
          ? { kind: method, reviewRunId: runId, expectedPlanDigest: planDigest }
          : {
              kind: method,
              workItemId: selected?.id ?? "",
              expectedRevisionKey: selected?.revisionKey ?? "",
              testedIssueCommit: kind === "issue" && commit !== "" ? commit : null,
            },
    };
    const issues = C.getEvaluationSourceCaptureRequestIssues(request);
    if (issues.length) {
      setValidationError(
        "Select a stored item and its revision, or enter a valid review run ID and plan digest. Commit IDs must be full lowercase hashes.",
      );
      return;
    }
    mutation.submit(request);
  };
  return (
    <Card size="small" title={`Capture ${kind === "pull_request" ? "PR" : "Issue"} source`}>
      <Form layout="vertical" disabled={locked}>
        <Form.Item label="Capture from">
          <Select
            value={method}
            onChange={setMethod}
            options={[
              { value: "current_work_item", label: "Current stored work item" },
              { value: "review_run", label: "Immutable review run" },
            ]}
          />
        </Form.Item>
        {method === "current_work_item" ? (
          <>
            <Form.Item label="Find a stored item">
              <Input.Search
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setItemPage(1);
                }}
                placeholder="Search by title or number"
              />
            </Form.Item>
            {workItems.error ? (
              <Alert
                type="error"
                title="Stored items unavailable"
                description={errorMessage(workItems.error)}
              />
            ) : null}
            <Form.Item
              label={kind === "pull_request" ? "Pull request revision" : "Issue revision"}
              required
            >
              <Select
                value={selected?.id}
                placeholder="Select a stored item"
                loading={workItems.isFetching}
                options={(workItems.data?.items ?? []).map((item) => ({
                  value: item.id,
                  label: `#${item.number} ${item.title}`,
                }))}
                onChange={(id) => {
                  const item = workItems.data?.items.find((value) => value.id === id);
                  if (item) setSelected(structuredClone(item));
                }}
              />
            </Form.Item>
            <Pagination
              size="small"
              current={itemPage}
              pageSize={20}
              total={workItems.data?.total ?? 0}
              showSizeChanger={false}
              hideOnSinglePage
              onChange={setItemPage}
              disabled={locked}
            />
            {selected ? (
              <p className="evaluation-meta">
                Selected #{selected.number} · revision {selected.revisionKey.slice(0, 12)}. Capture
                checks this exact revision.
              </p>
            ) : null}
            {kind === "issue" ? (
              <Form.Item
                label="Issue checkout commit"
                extra="Leave empty for triage. Issue validation requires an explicit commit."
              >
                <Input
                  value={commit}
                  onChange={(event) => setCommit(event.target.value)}
                  placeholder="Full 40- or 64-character commit hash"
                />
              </Form.Item>
            ) : null}
          </>
        ) : (
          <>
            <Form.Item label="Review run ID" required>
              <Input value={runId} onChange={(event) => setRunId(event.target.value)} />
            </Form.Item>
            <Form.Item
              label="Original plan digest"
              required
              extra="Copy the digest from the stored review run. Capture uses that run's original snapshot."
            >
              <Input value={planDigest} onChange={(event) => setPlanDigest(event.target.value)} />
            </Form.Item>
          </>
        )}
      </Form>
      {validationError ? <Alert type="error" title={validationError} /> : null}
      <MutationNotice mutation={mutation} />
      {captured ? (
        <Alert
          type="success"
          title={`Captured ${captured.workItemKind === "pull_request" ? "PR" : "Issue"} #${captured.number}`}
          description="The frozen source is now available in its item-kind tab."
        />
      ) : null}
      <Button type="primary" disabled={locked} loading={mutation.busy} onClick={capture}>
        Capture source
      </Button>
    </Card>
  );
}

export function SourceLibrary({
  kind,
  sources,
  onAdd,
  allowAdd,
}: {
  kind: SampleKind;
  sources: C.EvaluationSourceSummaryV1[];
  onAdd?: (source: C.EvaluationSourceSummaryV1) => void;
  allowAdd: boolean;
}) {
  const page = useEvaluationPage();
  const [captureOpen, setCaptureOpen] = useState(false),
    [captureVisited, setCaptureVisited] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  return (
    <section
      className="evaluation-sources"
      aria-label={`${kind === "pull_request" ? "PR" : "Issue"} frozen sources`}
    >
      <Card
        title="Frozen sources"
        extra={
          page.allowsConfigure ? (
            <Button
              disabled={!page.canConfigure}
              onClick={() => {
                setCaptureVisited(true);
                setCaptureOpen((value) => !value);
              }}
            >
              {captureOpen ? "Hide capture form" : "Capture source"}
            </Button>
          ) : null
        }
      >
        <Typography.Paragraph type="secondary">
          Capture stored work before adding it to a sample set. Every case keeps its selected
          revision.
        </Typography.Paragraph>
        <Table<C.EvaluationSourceSummaryV1>
          rowKey="id"
          size="small"
          dataSource={sources}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={`No frozen ${kind === "pull_request" ? "PR" : "Issue"} sources yet.`}
              />
            ),
          }}
          columns={[
            {
              title: "Source and frozen revision",
              key: "source",
              render: (_, source) => <FrozenSourceLabel source={source} />,
            },
            {
              title: "Actions",
              key: "actions",
              width: 200,
              render: (_, source) => (
                <Space>
                  <Button size="small" onClick={() => setSelected(source.id)}>
                    View source
                  </Button>
                  {onAdd && page.allowsConfigure ? (
                    <Button
                      size="small"
                      disabled={!allowAdd || !page.canConfigure}
                      onClick={() => onAdd(source)}
                    >
                      Add case
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {captureVisited ? (
        <div hidden={!captureOpen}>
          <SourceCapture kind={kind} active={captureOpen} />
        </div>
      ) : null}
      {selected ? <SourceDetails sourceId={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
