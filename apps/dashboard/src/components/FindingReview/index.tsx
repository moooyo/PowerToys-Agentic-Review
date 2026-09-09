import type {
  DashboardReviewRunResult,
  FindingDispositionAction,
  FindingDispositionChangeResponse,
  FindingOccurrence,
  FindingOccurrenceRef,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Collapse,
  Input,
  Pagination,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { findings } from "@/services/findings";
import { ErrorNotice, timestamp } from "../ReviewRuns/common";
import { evidencePollingViewVisible } from "../ReviewRuns/evidence-verification";
import { FindingComparison } from "./Comparison";
import { FindingBinding, FindingEvent, FindingSummary, OriginalFinding } from "./presentation";
import {
  acceptReviewedFinding,
  createFindingEditor,
  type FindingEditor,
  findingAccessDenied,
  findingActionDescription,
  findingActionLabel,
  findingBindingMatches,
  findingContextMatchesResult,
  findingEditorUnavailable,
  findingPollingInterval,
  findingPublicationNotice,
  findingQueryKey,
  findingReceiptSummary,
  findingStateLabel,
  prepareFindingSubmission,
  receiveFindingFailure,
  reviewFindingCandidate,
} from "./state";

function occurrenceRef(finding: FindingOccurrence): FindingOccurrenceRef {
  return {
    key: finding.key,
    resultId: finding.resultId,
    resultDigest: finding.resultDigest,
    kind: finding.kind,
    ordinal: finding.ordinal,
  };
}

function FindingSession({
  result,
  principal,
  access,
}: {
  result: DashboardReviewRunResult;
  principal: OperatorPrincipal;
  access: ReturnType<typeof useOperatorAccess>;
}) {
  const client = useQueryClient();
  const baseKey = findingQueryKey(findings.mode, result, principal);
  const scope = {
    repositoryId: result.repositoryId,
    reviewRunId: result.reviewRunId,
    requestId: result.requestId,
    jobId: result.jobId,
  };
  const [page, setPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [history, setHistory] = useState<FindingOccurrenceRef | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonDenied, setComparisonDenied] = useState(false);
  const [editor, setEditor] = useState<FindingEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<FindingDispositionChangeResponse | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mayRead = access.ready && access.can("read");
  const list = useQuery({
    queryKey: [...baseKey, "list", page],
    retry: false,
    enabled: mayRead,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      findingPollingInterval({
        mode: findings.mode,
        visible: evidencePollingViewVisible(),
        canRead: mayRead,
        hasError: query.state.status === "error",
      }),
    queryFn: async () => {
      const response = await findings.list(scope, { page, pageSize: 20 });
      if (!findingContextMatchesResult(response.context, result))
        throw new Error("The finding list does not match the selected immutable result.");
      return response;
    },
  });
  const context =
    !list.isError && findingContextMatchesResult(list.data?.context, result)
      ? list.data?.context
      : undefined;
  const liveDispositionDigest = context?.dispositionDigest;
  const liveContextDigest = context?.contextDigest;
  useEffect(() => {
    if (!liveDispositionDigest || !liveContextDigest || !mayRead) return;
    // A disposition recorded by another operator also changes policy and decision eligibility.
    void client.invalidateQueries({
      queryKey: [
        "review-runs",
        result.repositoryId,
        result.workItemId,
        result.reviewRunId,
        "detail",
      ],
      exact: true,
    });
    void client.invalidateQueries({
      queryKey: ["review-run-decisions", findings.mode, result.repositoryId, result.reviewRunId],
    });
  }, [
    client,
    liveDispositionDigest,
    liveContextDigest,
    mayRead,
    result.repositoryId,
    result.workItemId,
    result.reviewRunId,
  ]);
  const historyQuery = useQuery({
    queryKey: [...baseKey, "history", history, historyPage, context?.dispositionDigest],
    retry: false,
    enabled: mayRead && history !== null,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: () => {
      if (!history) throw new Error("Select a finding to inspect its history.");
      return findings.history(scope, history, { page: historyPage, pageSize: 20 });
    },
  });
  const listError =
    list.error ??
    (list.data && !findingContextMatchesResult(list.data.context, result)
      ? new Error("The finding list does not match the selected immutable result.")
      : null);
  const currentFinding = context
    ? list.data?.items.find((item) => item.key === editor?.occurrence.key)
    : undefined;
  const denied =
    comparisonDenied ||
    findingAccessDenied(listError) ||
    findingAccessDenied(historyQuery.error) ||
    findingAccessDenied(failure);
  const busy = saving || reviewing || list.isFetching || access.checking;
  const editReason = editor
    ? findingEditorUnavailable(editor, context, currentFinding, access.can("review"))
    : null;
  const markComparisonDenied = useCallback(() => setComparisonDenied(true), []);
  const refresh = async () => {
    if (!access.can("read") || pending.current) return;
    await Promise.all([list.refetch(), ...(history ? [historyQuery.refetch()] : [])]);
  };
  const loadLatest = async () => {
    if (!editor || busy || pending.current || !mayRead) return;
    setReviewing(true);
    setFailure(null);
    try {
      const response = await list.refetch();
      if (response.isError) throw response.error;
      const next = response.data;
      const occurrence = next?.items.find((item) => item.key === editor.occurrence.key);
      if (!next || !occurrence || !findingContextMatchesResult(next.context, result))
        throw new Error(
          "The refreshed page no longer contains this immutable finding. Refresh the selected result.",
        );
      if (mounted.current)
        setEditor((current) =>
          current ? reviewFindingCandidate(current, next.context, occurrence) : current,
        );
    } catch (error) {
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setReviewing(false);
    }
  };
  const submit = async () => {
    if (!editor || busy || pending.current || editReason) return;
    pending.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const prepared = prepareFindingSubmission(editor);
      setEditor(prepared);
      if (!prepared.request) throw new Error("A reviewed finding request is required.");
      const accepted = await findings.change(
        scope,
        prepared.occurrence.key,
        prepared.request,
        principal,
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: baseKey, refetchType: "none" }),
        client.invalidateQueries({ queryKey: ["review-runs", result.repositoryId] }),
        client.invalidateQueries({ queryKey: ["review-run-decisions"] }),
      ]);
      if (!mounted.current) return;
      setReceipt(accepted);
      setEditor(null);
      setHistoryPage(1);
      await list.refetch();
      if (history && historyPage === 1) await historyQuery.refetch();
    } catch (error) {
      if (mounted.current) {
        setFailure(error);
        setEditor((current) => (current ? receiveFindingFailure(current, error) : current));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  if ((!mayRead || denied) && !access.checking)
    return (
      <Alert
        showIcon
        type="info"
        title="Finding records unavailable"
        description="Repository read access is required. Drafts are retained for this session while access is refreshed."
        action={
          <Button
            disabled={saving}
            onClick={() => {
              setFailure(null);
              setComparisonDenied(false);
              void access
                .refresh()
                .then(() =>
                  Promise.all([
                    list.refetch(),
                    ...(historyQuery.isError ? [historyQuery.refetch()] : []),
                  ]),
                );
            }}
          >
            Refresh finding access
          </Button>
        }
      />
    );
  if (access.checking) return <Skeleton active paragraph={{ rows: 3 }} />;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Findings and dispositions
        </Typography.Title>
        <Button loading={list.isFetching} disabled={busy} onClick={() => void refresh()}>
          Refresh findings
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">{findingPublicationNotice}</Typography.Paragraph>
      {receipt && (
        <Alert
          showIcon
          type="success"
          title={
            receipt.replayed ? "Existing disposition receipt received" : "Disposition recorded"
          }
          description={findingReceiptSummary(receipt.change)}
        />
      )}
      {listError ? (
        <ErrorNotice
          title="Could not load finding records"
          error={listError}
          retry={() => void refresh()}
        />
      ) : !context || !list.data ? (
        <Skeleton active />
      ) : (
        <>
          {list.dataUpdatedAt > 0 && (
            <Typography.Text type="secondary">
              Last checked: {timestamp(new Date(list.dataUpdatedAt).toISOString())}. Refreshes every
              30 seconds while visible. Automatic refresh stops after an error.
            </Typography.Text>
          )}
          {context.historical && (
            <Alert
              showIcon
              type="warning"
              title="Historical result findings"
              description="Changes here apply only to this saved result. They do not carry over to the latest activation or a different run. The reviewed execution context is checked again when you submit."
            />
          )}
          {context.modelAvailability !== "complete" && (
            <Alert
              showIcon
              type="info"
              title="Complete model findings are unavailable"
              description={`Model output: ${context.modelAvailability.replaceAll("_", " ")}. Missing output does not establish that this result has no problems.`}
            />
          )}
          <FindingSummary summary={list.data.summary} />
          <Collapse
            items={[
              {
                key: "binding",
                label: "Finding result identity and execution context",
                children: <FindingBinding context={context} />,
              },
            ]}
          />
          <Table<FindingOccurrence>
            size="small"
            dataSource={list.data.items}
            rowKey="key"
            pagination={false}
            scroll={{ x: 820 }}
            locale={{
              emptyText:
                context.modelAvailability === "complete"
                  ? "No findings were reported in this complete model output."
                  : "No findings are available from a complete model output.",
            }}
            columns={[
              {
                title: "Priority",
                render: (_, finding) => (
                  <Tag color={finding.priority < 2 ? "warning" : "default"}>
                    P{finding.priority}
                  </Tag>
                ),
              },
              {
                title: "Finding",
                render: (_, finding) => (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text strong>{finding.title}</Typography.Text>
                    <Typography.Text type="secondary">
                      {finding.path ?? "No location"}
                      {finding.line === null ? "" : `:${finding.line}`}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Disposition",
                render: (_, finding) => (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text>
                      {findingStateLabel(finding.disposition.state)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      Version {finding.disposition.version}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: "Actions",
                render: (_, finding) => (
                  <Space wrap>
                    {(["accept", "dismiss", "resolve", "reopen"] as FindingDispositionAction[]).map(
                      (action) => (
                        <Tooltip
                          key={action}
                          title={
                            access.can("review")
                              ? findingActionDescription(action)
                              : "Reviewer access is required."
                          }
                        >
                          <span>
                            <Button
                              size="small"
                              disabled={!access.can("review") || busy || editor !== null}
                              onClick={() => {
                                setEditor(createFindingEditor(context, finding, action));
                                setFailure(null);
                              }}
                            >
                              {findingActionLabel(action)}
                            </Button>
                          </span>
                        </Tooltip>
                      ),
                    )}
                    <Button
                      size="small"
                      onClick={() => {
                        setHistory(occurrenceRef(finding));
                        setHistoryPage(1);
                      }}
                    >
                      History
                    </Button>
                  </Space>
                ),
              },
            ]}
            expandable={{ expandedRowRender: (finding) => <OriginalFinding finding={finding} /> }}
          />
          <Pagination
            current={page}
            pageSize={20}
            total={list.data.total}
            showSizeChanger={false}
            hideOnSinglePage
            disabled={busy || editor !== null}
            onChange={(next) => {
              setPage(next);
              setHistory(null);
            }}
          />
          {!access.can("review") && (
            <Typography.Text type="secondary">
              Reviewer access is required to change dispositions. Original findings and history
              remain readable.
            </Typography.Text>
          )}
        </>
      )}
      {editor && (
        <Space
          orientation="vertical"
          style={{
            width: "100%",
            border: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <Typography.Text strong>
            {findingActionLabel(editor.action)} · {editor.occurrence.title}
          </Typography.Text>
          <Alert
            showIcon
            type={editor.action === "dismiss" || editor.action === "resolve" ? "warning" : "info"}
            title="Review before recording"
            description={findingActionDescription(editor.action)}
          />
          <OriginalFinding finding={editor.occurrence} />
          <Collapse
            items={[
              {
                key: "reviewed",
                label: "Reviewed result and execution context",
                children: <FindingBinding context={editor.context} />,
              },
            ]}
          />
          <Typography.Text>Reason</Typography.Text>
          <Input.TextArea
            aria-label="Finding disposition reason"
            rows={3}
            maxLength={2_048}
            showCount
            value={editor.reason}
            disabled={saving || reviewing || editor.request !== null}
            onChange={(event) =>
              setEditor((current) =>
                current && !current.request ? { ...current, reason: event.target.value } : current,
              )
            }
            placeholder="Explain the disposition for this exact original finding."
          />
          {editor.request && (
            <Typography.Text type="secondary">
              The submitted intent is locked. Retry sends the exact original request and may return
              a historical receipt after later changes. To revise it, review and explicitly use the
              latest state.
            </Typography.Text>
          )}
          {editReason && (
            <Alert
              showIcon
              type="warning"
              title="Fresh review or access is required"
              description={`${editReason} Your reason and original binding are preserved.`}
            />
          )}
          {failure !== null && (
            <Alert
              showIcon
              type="error"
              title="Disposition request could not be completed"
              description={
                failure instanceof Error ? failure.message : "The operation could not be completed."
              }
            />
          )}
          {editor.candidate && (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Typography.Text strong>Latest state for your review</Typography.Text>
              <OriginalFinding finding={editor.candidate.occurrence} />
              <FindingBinding context={editor.candidate.context} />
              <Button
                disabled={
                  busy ||
                  !context ||
                  !currentFinding ||
                  !findingBindingMatches(editor.candidate, context, currentFinding)
                }
                onClick={() => {
                  if (
                    !busy &&
                    context &&
                    currentFinding &&
                    editor.candidate &&
                    findingBindingMatches(editor.candidate, context, currentFinding)
                  ) {
                    setEditor(acceptReviewedFinding(editor));
                    setFailure(null);
                  }
                }}
              >
                Use this reviewed finding state
              </Button>
            </Space>
          )}
          <Space wrap>
            <Button
              type="primary"
              loading={saving}
              disabled={busy || Boolean(editReason) || !editor.reason.trim()}
              onClick={() => void submit()}
            >
              {editor.request ? "Retry original submission" : "Record disposition in platform"}
            </Button>
            <Button
              disabled={busy || !mayRead}
              loading={reviewing}
              onClick={() => void loadLatest()}
            >
              Review latest finding state
            </Button>
            <Button
              disabled={saving || reviewing}
              onClick={() => {
                setEditor(null);
                setFailure(null);
              }}
            >
              Discard draft
            </Button>
          </Space>
        </Space>
      )}
      {history && (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <Typography.Title level={5} style={{ margin: 0 }}>
              Finding disposition history
            </Typography.Title>
            <Button onClick={() => setHistory(null)}>Close history</Button>
          </Space>
          <Typography.Paragraph type="secondary">
            Immutable entries preserve the actor, reason, version, and execution context. An earlier
            receipt does not describe the current disposition.
          </Typography.Paragraph>
          {historyQuery.isError ? (
            <ErrorNotice
              title="Could not load disposition history"
              error={historyQuery.error}
              retry={() => void historyQuery.refetch()}
            />
          ) : !historyQuery.data ? (
            <Skeleton active />
          ) : (
            <>
              {historyQuery.data.items.length ? (
                historyQuery.data.items.map((event) => (
                  <FindingEvent key={event.id} event={event} />
                ))
              ) : (
                <Typography.Text type="secondary">
                  No disposition has been recorded for this finding.
                </Typography.Text>
              )}
              <Pagination
                current={historyPage}
                pageSize={20}
                total={historyQuery.data.total}
                hideOnSinglePage
                showSizeChanger={false}
                disabled={historyQuery.isFetching}
                onChange={setHistoryPage}
              />
            </>
          )}
        </Space>
      )}
      <Collapse
        activeKey={comparisonOpen ? ["comparison"] : []}
        onChange={(keys) => setComparisonOpen(keys.includes("comparison"))}
        items={[
          {
            key: "comparison",
            label: "Compare with an earlier saved result",
            children: comparisonOpen ? (
              <FindingComparison
                result={result}
                principal={principal}
                onDenied={markComparisonDenied}
              />
            ) : null,
          },
        ]}
      />
    </Space>
  );
}

export function FindingReview({ result }: { result: DashboardReviewRunResult }) {
  const access = useOperatorAccess(result.repositoryId);
  if (!access.principal) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (findings.mode === "sample")
    return (
      <Alert
        showIcon
        type="info"
        title="Sample finding preview"
        description="The original sample model output is shown above. Finding dispositions and comparisons require a connected control plane; this preview does not simulate those records or change sample approval eligibility."
      />
    );
  return (
    <FindingSession
      key={JSON.stringify(findingQueryKey(findings.mode, result, access.principal))}
      result={result}
      principal={access.principal}
      access={access}
    />
  );
}
