import * as C from "@agentic-review/contracts";
import { Alert, Button, Card, Form, Input, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import type { EvaluationAdjudicationAdapter } from "@/services/evaluation-adjudication";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { errorMessage, newIdentity, OriginalMutation } from "./state";

type ContextItem = C.EvaluationAdjudicationContextV1["items"][number];
type Judgment = C.EvaluationAdjudicationChangeRequest["judgment"];
interface Editor {
  occurrenceKey: string;
  expectedVersion: number;
  judgment: Judgment;
  savedJson: string;
}
interface ChangeIntent {
  scope: C.EvaluationAdjudicationScope;
  request: C.EvaluationAdjudicationChangeRequest;
}
const kinds = [
  { value: "match", label: "Matches an expected finding" },
  { value: "duplicate", label: "Duplicate of a primary match" },
  { value: "false_positive", label: "False positive" },
  { value: "unjudged", label: "Unjudged" },
] as const;

export function resultAdjudicationScope(
  result: C.EvaluationCellResultV1,
): C.EvaluationCellResultReadQuery {
  return {
    repositoryId: result.repositoryId,
    evaluationId: result.evaluationId,
    cellId: result.cellId,
    resultId: result.resultId,
  };
}
export function assertAdjudicationContext(
  result: C.EvaluationCellResultV1,
  context: C.EvaluationAdjudicationContextV1,
): void {
  const scope = resultAdjudicationScope(result),
    occurrences = new Map(result.occurrences.map((item) => [item.key, item]));
  const expected = new Set(context.expectations.expected.map((item) => item.expectedFindingId)),
    matched = new Set<string>();
  const invalid = () => {
    throw new ReviewControlProtocolError(
      "read evaluation adjudications",
      "The adjudication context does not match this exact result and its complete occurrence set.",
    );
  };
  if (
    (Object.keys(scope) as (keyof typeof scope)[]).some(
      (key) => context.scope[key] !== scope[key],
    ) ||
    context.resultDigest !== result.resultDigest ||
    context.caseId !== result.caseId ||
    context.arm !== result.arm ||
    context.modelRequired !== result.modelRequirements.required ||
    context.modelState !== result.modelReview.state ||
    context.items.length !== result.occurrences.length ||
    new Set(context.items.map((item) => item.occurrence.key)).size !== result.occurrences.length
  )
    invalid();
  for (const item of context.items) {
    const occurrence = occurrences.get(item.occurrence.key);
    if (
      !occurrence ||
      occurrence.kind !== item.occurrence.kind ||
      occurrence.ordinal !== item.occurrence.ordinal ||
      occurrence.resultDigest !== item.occurrence.resultDigest ||
      occurrence.resultId !== item.occurrence.resultId
    )
      invalid();
    const adjudication = item.adjudication;
    if (adjudication?.kind === "match") {
      if (
        !expected.has(adjudication.expectedFindingId) ||
        matched.has(adjudication.expectedFindingId)
      )
        invalid();
      matched.add(adjudication.expectedFindingId);
    }
    if (
      adjudication?.kind === "duplicate" &&
      (adjudication.primaryOccurrenceKey === item.occurrence.key ||
        context.items.find(
          (candidate) => candidate.occurrence.key === adjudication.primaryOccurrenceKey,
        )?.adjudication?.kind !== "match")
    )
      invalid();
  }
}
export function judgmentFromCurrent(value: C.EvaluationFindingAdjudication | null): Judgment {
  if (!value) return { kind: "unjudged", reason: "" };
  if (value.kind === "match")
    return { kind: value.kind, expectedFindingId: value.expectedFindingId, reason: value.reason };
  if (value.kind === "duplicate")
    return {
      kind: value.kind,
      primaryOccurrenceKey: value.primaryOccurrenceKey,
      reason: value.reason,
    };
  return { kind: value.kind, reason: value.reason };
}
export function changeJudgmentKind(previous: Judgment, kind: Judgment["kind"]): Judgment {
  return kind === "match"
    ? { kind, expectedFindingId: "", reason: previous.reason }
    : kind === "duplicate"
      ? { kind, primaryOccurrenceKey: "", reason: previous.reason }
      : { kind, reason: previous.reason };
}
export function adjudicationEditorForItem(item: ContextItem): Editor {
  const judgment = judgmentFromCurrent(item.adjudication);
  return {
    occurrenceKey: item.occurrence.key,
    expectedVersion: item.version,
    judgment,
    savedJson: JSON.stringify(judgment),
  };
}
export function applyReviewedAdjudicationVersion(
  editor: Editor,
  reviewed: { occurrenceKey: string; version: number },
): Editor {
  if (editor.occurrenceKey !== reviewed.occurrenceKey)
    throw new ReviewControlRequestError(
      "change evaluation adjudication",
      "occurrenceKey",
      "The refreshed version belongs to another occurrence.",
    );
  return { ...editor, expectedVersion: reviewed.version };
}
export function validateJudgmentIntent(
  context: C.EvaluationAdjudicationContextV1,
  key: string,
  judgment: Judgment,
): void {
  const reject = (message: string): never => {
    throw new ReviewControlRequestError("change evaluation adjudication", "judgment", message);
  };
  if (!context.modelRequired || context.modelState !== "completed")
    reject("Only a required, completed model result accepts adjudication changes.");
  const item = context.items.find((candidate) => candidate.occurrence.key === key);
  if (!item) reject("Select an occurrence in this exact result.");
  if (judgment.kind === "match") {
    if (
      !context.expectations.expected.some(
        (expected) => expected.expectedFindingId === judgment.expectedFindingId,
      )
    )
      reject("Select a frozen expected finding for this case.");
    if (
      context.items.some(
        (candidate) =>
          candidate.occurrence.key !== key &&
          candidate.adjudication?.kind === "match" &&
          candidate.adjudication.expectedFindingId === judgment.expectedFindingId,
      )
    )
      reject("Another primary match already uses this expected finding.");
  }
  if (
    judgment.kind === "duplicate" &&
    (judgment.primaryOccurrenceKey === key ||
      context.items.find((candidate) => candidate.occurrence.key === judgment.primaryOccurrenceKey)
        ?.adjudication?.kind !== "match")
  )
    reject("A duplicate must point directly to another current primary match in this result.");
  if (
    judgment.kind !== "match" &&
    context.items.some(
      (candidate) =>
        candidate.adjudication?.kind === "duplicate" &&
        candidate.adjudication.primaryOccurrenceKey === key,
    )
  )
    reject(
      "Resolve the existing duplicate references before changing this primary to a non-match.",
    );
}
function occurrenceContent(result: C.EvaluationCellResultV1, occurrence: C.FindingOccurrenceRef) {
  return occurrence.kind === "pr_finding"
    ? result.modelReview.findings[occurrence.ordinal]
    : result.modelReview.observations[occurrence.ordinal];
}
export function judgmentLabel(value: C.EvaluationFindingAdjudication | null): string {
  return !value
    ? "Not yet judged"
    : value.kind === "match"
      ? `Match · ${value.expectedFindingId}`
      : value.kind === "duplicate"
        ? `Duplicate · ${value.primaryOccurrenceKey.slice(0, 12)}`
        : value.kind === "false_positive"
          ? "False positive"
          : "Unjudged";
}
export function adjudicationEditingAllowed(
  context: C.EvaluationAdjudicationContextV1 | null,
  access: {
    active: boolean;
    readable: boolean;
    reviewer: boolean;
    fetching: boolean;
    error: unknown;
  },
): boolean {
  return (
    access.active &&
    access.readable &&
    access.reviewer &&
    context?.modelRequired === true &&
    context.modelState === "completed" &&
    !access.error &&
    !access.fetching
  );
}

export function Adjudication({
  result,
  adapter,
  active,
}: {
  result: C.EvaluationCellResultV1;
  adapter: EvaluationAdjudicationAdapter;
  active: boolean;
}) {
  const page = useEvaluationPage(),
    access = useOperatorAccess(page.repositoryId);
  const scope = resultAdjudicationScope(result),
    scopeKey = JSON.stringify([scope, result.resultDigest]);
  const contextQuery = useEvaluationQuery(
    ["adjudications", scopeKey],
    async (signal) => {
      const value = await adapter.getContext(scope, signal);
      assertAdjudicationContext(result, value);
      return value;
    },
    active,
  );
  const [retained, setRetained] = useState<C.EvaluationAdjudicationContextV1 | null>(null);
  useEffect(() => {
    if (contextQuery.data) setRetained(contextQuery.data);
  }, [contextQuery.data]);
  const context = contextQuery.data ?? retained;
  const [editor, setEditor] = useState<Editor | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [historyPage, setHistoryPage] = useState(1);
  const [reviewed, setReviewed] = useState<{ occurrenceKey: string; version: number } | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const owner = useMemo(() => new OriginalMutation<ChangeIntent>(), []);
  const mutation = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(() => {
    owner.activate();
    return () => owner.dispose();
  }, [owner]);
  const sameActor =
    access.principal?.issuer === page.principal.issuer &&
    access.principal?.subject === page.principal.subject;
  const reviewer =
    sameActor &&
    access.ready &&
    !access.checking &&
    !access.pending &&
    !access.error &&
    access.can("review");
  const canWrite = adjudicationEditingAllowed(context, {
    active,
    readable: page.readable,
    reviewer,
    error: contextQuery.error,
    fetching: contextQuery.isFetching,
  });
  const pending = mutation.busy || mutation.request !== null;
  const current = context?.items.find((item) => item.occurrence.key === editor?.occurrenceKey);
  const dirty = editor !== null && JSON.stringify(editor.judgment) !== editor.savedJson;
  const stale = !!editor && !!current && current.version > editor.expectedVersion;
  const currentVersionMatches = !!editor && current?.version === editor.expectedVersion;
  const conflict = mutation.conflict || stale;
  const select = (item: ContextItem, history = false) => {
    if (pending || (dirty && item.occurrence.key !== editor?.occurrenceKey)) return;
    if (item.occurrence.key !== editor?.occurrenceKey) {
      setEditor(adjudicationEditorForItem(item));
      setReviewed(null);
      setError(null);
      setNotice(null);
      owner.reset();
      setHistoryPage(1);
    }
    setHistoryOpen(history);
  };
  const execute = (intent: ChangeIntent) =>
    adapter.change(intent.scope, intent.request, page.principal).then((value) => {
      if (value.adjudication.caseId !== result.caseId || value.adjudication.arm !== result.arm)
        throw new ReviewControlProtocolError(
          "change evaluation adjudication",
          "The accepted judgment does not belong to this result's case and arm.",
        );
      return value;
    });
  const success = (value: C.EvaluationAdjudicationChangeV1) => {
    setEditor((previous) =>
      previous && previous.occurrenceKey === value.scope.occurrenceKey
        ? {
            ...previous,
            expectedVersion: value.version,
            savedJson: JSON.stringify(previous.judgment),
          }
        : previous,
    );
    setNotice(`Judgment saved at version ${value.version}.`);
    setReviewed(null);
    void contextQuery.refetch();
    if (historyOpen) void history.refetch();
  };
  const save = () => {
    if (
      !canWrite ||
      !editor ||
      !context ||
      pending ||
      conflict ||
      !dirty ||
      !currentVersionMatches ||
      editor.expectedVersion >= Number.MAX_SAFE_INTEGER
    )
      return;
    try {
      validateJudgmentIntent(context, editor.occurrenceKey, editor.judgment);
      const request = {
        changeId: newIdentity(),
        expectedVersion: editor.expectedVersion,
        resultDigest: result.resultDigest,
        judgment: editor.judgment,
      };
      const issues = C.getEvaluationAdjudicationChangeRequestIssues(request);
      if (issues.length)
        throw new ReviewControlRequestError(
          "change evaluation adjudication",
          "request",
          issues[0] ?? "Invalid judgment.",
        );
      setError(null);
      setNotice(null);
      void owner.run(
        { scope: { ...scope, occurrenceKey: editor.occurrenceKey }, request },
        execute,
        success,
        page.invalidateAccess,
      );
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const retry = () => {
    if (canWrite && mutation.request)
      void owner.run(mutation.request, execute, success, page.invalidateAccess);
  };
  const refresh = async () => {
    if (!active || !page.readable || pending) return;
    const selectedKey = editor?.occurrenceKey;
    const value = await contextQuery.refetch();
    if (!value.isError && value.data && selectedKey) {
      const item = value.data.items.find((candidate) => candidate.occurrence.key === selectedKey);
      if (item) {
        setReviewed({ occurrenceKey: selectedKey, version: item.version });
        setNotice("Current judgments refreshed. Your proposed judgment is unchanged.");
      }
    }
  };
  const history = useEvaluationQuery(
    ["adjudication-history", scopeKey, editor?.occurrenceKey, historyPage],
    async (signal) => {
      if (!editor) throw new Error("Select an occurrence first.");
      const value = await adapter.history(
        { ...scope, occurrenceKey: editor.occurrenceKey },
        { page: historyPage, pageSize: 20 },
        signal,
      );
      if (
        value.resultDigest !== result.resultDigest ||
        value.items.some(
          (item) =>
            item.adjudication.caseId !== result.caseId || item.adjudication.arm !== result.arm,
        )
      )
        throw new ReviewControlProtocolError(
          "read evaluation adjudication history",
          "The history belongs to another result, case or arm.",
        );
      return value;
    },
    active && editor !== null && historyOpen,
  );
  const locked = !canWrite || pending;
  const reason =
    context === null
      ? "Load current judgments before editing."
      : !context.modelRequired
        ? "This profile-only result does not participate in model adjudication."
        : context.modelState !== "completed"
          ? "The required model result is not completed. Judgments are read-only."
          : !reviewer
            ? "Reviewer permission is required to change judgments."
            : null;
  const rows = result.occurrences.map((occurrence) => ({
    occurrence,
    item: context?.items.find((item) => item.occurrence.key === occurrence.key),
    content: occurrenceContent(result, occurrence),
  }));
  return (
    <Card
      size="small"
      title="Human adjudication"
      extra={
        <Button
          disabled={!active || !page.readable || pending}
          loading={contextQuery.isFetching}
          onClick={() => void refresh()}
        >
          Refresh judgments
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        Judge each model occurrence against this case's frozen expected findings. Evidence
        verification is separate; a judgment never approves a pull request.
      </Typography.Paragraph>
      {reason ? <Alert type="info" title="Read-only adjudication" description={reason} /> : null}
      {contextQuery.error ? (
        <Alert
          type="error"
          title="Adjudication context unavailable"
          description={errorMessage(contextQuery.error)}
        />
      ) : null}
      {context ? (
        <Card
          size="small"
          title="Frozen expected findings"
          extra={<Tag>{context.expectations.annotation}</Tag>}
        >
          <Typography.Paragraph>
            {context.expectations.annotation === "unlabeled"
              ? "Finding expectations are unlabeled; an empty list is not a negative example."
              : context.expectations.annotation === "partial"
                ? "Only known positive findings are labeled. Other findings remain unassessed."
                : context.expectations.expected.length === 0
                  ? "Complete labels explicitly declare that no findings are expected."
                  : "This list declares all expected findings for the frozen case."}
          </Typography.Paragraph>
          {context.expectations.expected.map((expected) => (
            <p key={expected.expectedFindingId}>
              {expected.description}
              <span className="evaluation-meta">{expected.expectedFindingId}</span>
            </p>
          ))}
        </Card>
      ) : null}
      <Table
        rowKey={(row) => row.occurrence.key}
        size="small"
        dataSource={context ? rows : []}
        loading={contextQuery.isPending}
        pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        columns={[
          {
            title: "Model occurrence",
            key: "occurrence",
            render: (_, row) => (
              <div>
                <strong>{row.content?.title}</strong>
                <p className="evaluation-result-text">{row.content?.body}</p>
                <span className="evaluation-meta">
                  {row.occurrence.kind} · ordinal {row.occurrence.ordinal} · {row.occurrence.key}
                </span>
              </div>
            ),
          },
          {
            title: "Current judgment",
            key: "current",
            render: (_, row) => (
              <div>
                {judgmentLabel(row.item?.adjudication ?? null)}
                <span className="evaluation-meta">Version {row.item?.version ?? 0}</span>
              </div>
            ),
          },
          {
            title: "Actions",
            key: "actions",
            render: (_, row) =>
              row.item ? (
                <Space wrap>
                  <Button
                    size="small"
                    disabled={pending || (dirty && row.occurrence.key !== editor?.occurrenceKey)}
                    onClick={() => row.item && select(row.item)}
                  >
                    Inspect judgment
                  </Button>
                  <Button
                    size="small"
                    disabled={pending || (dirty && row.occurrence.key !== editor?.occurrenceKey)}
                    onClick={() => row.item && select(row.item, true)}
                  >
                    History
                  </Button>
                </Space>
              ) : null,
          },
        ]}
      />
      {editor && current && context ? (
        <Card
          size="small"
          title={`Judgment · occurrence ${current.occurrence.ordinal}`}
          extra={
            <Button
              disabled={pending}
              onClick={() => {
                setEditor(null);
                owner.reset();
                setReviewed(null);
                setHistoryOpen(false);
              }}
            >
              Discard editor
            </Button>
          }
        >
          <span className="evaluation-meta">
            {editor.occurrenceKey} · editing version {editor.expectedVersion} · current version{" "}
            {current.version}
          </span>
          {conflict ? (
            <Alert
              type="warning"
              title="The current judgment changed"
              description="Your proposed judgment and original version are preserved. Refresh current judgments to compare, then explicitly use the refreshed version before creating a new change."
              action={
                <Button
                  disabled={!active || !page.readable || pending}
                  onClick={() => void refresh()}
                >
                  Refresh current judgment
                </Button>
              }
            />
          ) : null}
          {conflict && reviewed?.occurrenceKey === editor.occurrenceKey ? (
            <Button
              disabled={!canWrite || pending}
              onClick={() => {
                if (!canWrite || pending) return;
                setEditor(applyReviewedAdjudicationVersion(editor, reviewed));
                owner.reset();
                setReviewed(null);
              }}
            >
              Use refreshed version {reviewed.version} for this intent
            </Button>
          ) : null}
          <Form layout="vertical" disabled={locked}>
            <Form.Item label="Judgment">
              <Select
                aria-label="Evaluation finding judgment"
                value={editor.judgment.kind}
                options={[...kinds]}
                onChange={(kind) => {
                  if (!locked)
                    setEditor({ ...editor, judgment: changeJudgmentKind(editor.judgment, kind) });
                }}
              />
            </Form.Item>
            {editor.judgment.kind === "match" ? (
              <Form.Item label="Frozen expected finding" required>
                <Select
                  aria-label="Matched frozen expected finding"
                  value={editor.judgment.expectedFindingId || undefined}
                  placeholder="Select a frozen expectation"
                  options={context.expectations.expected.map((expected) => ({
                    value: expected.expectedFindingId,
                    label: expected.description,
                    disabled: context.items.some(
                      (item) =>
                        item.occurrence.key !== editor.occurrenceKey &&
                        item.adjudication?.kind === "match" &&
                        item.adjudication.expectedFindingId === expected.expectedFindingId,
                    ),
                  }))}
                  onChange={(expectedFindingId) => {
                    if (!locked)
                      setEditor({
                        ...editor,
                        judgment: {
                          kind: "match",
                          expectedFindingId,
                          reason: editor.judgment.reason,
                        },
                      });
                  }}
                />
              </Form.Item>
            ) : editor.judgment.kind === "duplicate" ? (
              <Form.Item label="Primary match" required>
                <Select
                  aria-label="Duplicate primary occurrence"
                  value={editor.judgment.primaryOccurrenceKey || undefined}
                  placeholder="Select a current primary match"
                  options={context.items
                    .filter(
                      (item) =>
                        item.occurrence.key !== editor.occurrenceKey &&
                        item.adjudication?.kind === "match",
                    )
                    .map((item) => ({
                      value: item.occurrence.key,
                      label: `${occurrenceContent(result, item.occurrence)?.title ?? item.occurrence.kind} · ordinal ${item.occurrence.ordinal}`,
                    }))}
                  onChange={(primaryOccurrenceKey) => {
                    if (!locked)
                      setEditor({
                        ...editor,
                        judgment: {
                          kind: "duplicate",
                          primaryOccurrenceKey,
                          reason: editor.judgment.reason,
                        },
                      });
                  }}
                />
              </Form.Item>
            ) : null}
            <Form.Item label="Reason" required>
              <Input.TextArea
                aria-label="Adjudication reason"
                value={editor.judgment.reason}
                maxLength={2048}
                autoSize={{ minRows: 2, maxRows: 5 }}
                onChange={(event) => {
                  if (!locked)
                    setEditor({
                      ...editor,
                      judgment: { ...editor.judgment, reason: event.target.value },
                    });
                }}
              />
            </Form.Item>
          </Form>
          {error ? (
            <Alert type="error" title="Review the proposed judgment" description={error} />
          ) : null}
          {mutation.error ? (
            <Alert
              type={mutation.conflict ? "warning" : "error"}
              title={mutation.request ? "The result is not confirmed" : "The judgment was rejected"}
              description={mutation.error}
              action={
                mutation.request ? (
                  <Button disabled={!canWrite} loading={mutation.busy} onClick={retry}>
                    Retry original judgment
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          {mutation.request ? (
            <p className="evaluation-meta">
              The exact occurrence, change ID, expected version and judgment are preserved for
              retry.
            </p>
          ) : null}
          {notice ? <Alert type="info" title={notice} /> : null}
          {editor.expectedVersion >= Number.MAX_SAFE_INTEGER ? (
            <Alert type="info" title="The judgment version limit has been reached" />
          ) : null}
          <Space>
            <Button
              type="primary"
              disabled={
                locked ||
                conflict ||
                !dirty ||
                !currentVersionMatches ||
                editor.expectedVersion >= Number.MAX_SAFE_INTEGER
              }
              loading={mutation.busy}
              onClick={save}
            >
              Save judgment
            </Button>
            <Button onClick={() => setHistoryOpen((value) => !value)}>
              {historyOpen ? "Hide history" : "Show history"}
            </Button>
          </Space>
          {historyOpen ? (
            <>
              {history.error ? (
                <Alert
                  type="error"
                  title="History unavailable"
                  description={errorMessage(history.error)}
                />
              ) : null}
              <Table
                rowKey={(item) => item.adjudication.adjudicationId}
                size="small"
                dataSource={history.data?.items ?? []}
                loading={history.isFetching}
                pagination={{
                  current: historyPage,
                  pageSize: 20,
                  total: history.data?.total ?? 0,
                  showSizeChanger: false,
                  hideOnSinglePage: true,
                  onChange: setHistoryPage,
                }}
                columns={[
                  { title: "Version", dataIndex: "version", key: "version" },
                  {
                    title: "Judgment",
                    key: "judgment",
                    render: (_, item) => (
                      <div>
                        {judgmentLabel(item.adjudication)}
                        <p>{item.adjudication.reason}</p>
                      </div>
                    ),
                  },
                  {
                    title: "Reviewer",
                    key: "actor",
                    render: (_, item) => (
                      <span className="evaluation-meta">
                        {item.adjudication.actor.issuer} · {item.adjudication.actor.subject}
                        <br />
                        {item.adjudication.createdAt}
                      </span>
                    ),
                  },
                ]}
              />
            </>
          ) : null}
        </Card>
      ) : null}
    </Card>
  );
}
