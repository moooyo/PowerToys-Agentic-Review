import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  ReviewRunDecisionChangeResponse,
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
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { PublicationPreview } from "@/components/PublicationPreview";
import { decisions } from "@/services/decisions";
import { ErrorNotice, timestamp } from "../ReviewRuns/common";
import { evidencePollingViewVisible } from "../ReviewRuns/evidence-verification";
import { CurrentDecision, DecisionBinding, DecisionEvent } from "./presentation";
import {
  acceptReviewedDecisionState,
  createDecisionEditor,
  type DecisionAccess,
  type DecisionAction,
  type DecisionEditorState,
  decisionActionLabel,
  decisionBindingMatches,
  decisionContextMatchesRun,
  decisionEditorUnavailableReason,
  decisionEventMatchesRun,
  decisionPollingInterval,
  decisionPublicationNotice,
  decisionQueryKey,
  decisionReceiptSummary,
  decisionUnavailableReason,
  isDecisionAccessDenied,
  prepareDecisionSubmission,
  receiveDecisionFailure,
  reviewDecisionCandidate,
  runDecisionRefreshKey,
} from "./state";

function DecisionSession({
  run,
  principal,
  access,
  refreshAccess,
}: {
  run: DashboardReviewRunDetail;
  principal: OperatorPrincipal;
  access: DecisionAccess;
  refreshAccess: () => Promise<void>;
}) {
  const client = useQueryClient();
  const baseKey = decisionQueryKey(decisions.mode, run.repositoryId, run.id, principal);
  const [page, setPage] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publicationDecisionId, setPublicationDecisionId] = useState<string | null>(null);
  const [editor, setEditor] = useState<DecisionEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<ReviewRunDecisionChangeResponse | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const mayRead = access.ready && !access.checking && access.can("read");
  const stateQuery = useQuery({
    queryKey: [...baseKey, "state", runDecisionRefreshKey(run)],
    queryFn: () => decisions.getContext(run.repositoryId, run.id),
    enabled: mayRead,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      decisionPollingInterval({
        mode: decisions.mode,
        visible: evidencePollingViewVisible(),
        canRead: mayRead,
        hasError: query.state.status === "error",
      }),
  });
  const historyQuery = useQuery({
    queryKey: [...baseKey, "history", page, stateQuery.data?.version ?? 0],
    queryFn: () => decisions.listHistory(run.repositoryId, run.id, { page, pageSize: 20 }),
    enabled: mayRead && historyOpen,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const context =
    !stateQuery.isError && decisionContextMatchesRun(stateQuery.data, run)
      ? stateQuery.data
      : undefined;
  const mismatch = stateQuery.isSuccess && !decisionContextMatchesRun(stateQuery.data, run);
  const stateError =
    stateQuery.error ??
    (mismatch ? new Error("The decision state does not match the selected run.") : null);
  const historyError =
    historyQuery.error ??
    (historyQuery.data?.items.some((event) => !decisionEventMatchesRun(event, run))
      ? new Error("The decision history does not match the selected run.")
      : null);
  const busy = saving || reviewing || stateQuery.isFetching || access.checking;
  const editorChanged = Boolean(
    editor && context && !decisionBindingMatches(editor.reviewed, context),
  );
  const editReason = editor ? decisionEditorUnavailableReason(editor, context, access) : null;
  const freshReviewRequired =
    editor?.conflict === true || (editor?.request === null && editorChanged);
  const refresh = async () => {
    if (!access.can("read") || pending.current) return;
    await Promise.all([
      stateQuery.refetch(),
      ...(historyOpen || historyQuery.isError ? [historyQuery.refetch()] : []),
    ]);
  };
  const loadReview = async () => {
    if (!editor || busy || pending.current || !access.can("read")) return;
    setReviewing(true);
    setFailure(null);
    try {
      const result = await stateQuery.refetch();
      if (result.isError) throw result.error;
      if (!decisionContextMatchesRun(result.data, run))
        throw new Error("The refreshed state does not match this run.");
      const candidate = result.data;
      if (mounted.current)
        setEditor((current) => (current ? reviewDecisionCandidate(current, candidate) : current));
    } catch (error) {
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setReviewing(false);
    }
  };
  const submit = async () => {
    if (
      !editor ||
      (!editor.request && !context) ||
      busy ||
      pending.current ||
      editReason ||
      freshReviewRequired
    )
      return;
    pending.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const prepared = prepareDecisionSubmission(editor);
      setEditor(prepared);
      if (!prepared.request) throw new Error("A reviewed decision request is required.");
      const accepted = await decisions.change(
        run.repositoryId,
        run.id,
        prepared.request,
        principal,
      );
      if (!decisionEventMatchesRun(accepted.change, run)) {
        throw new Error("The decision receipt does not match the selected run.");
      }
      await client.invalidateQueries({ queryKey: baseKey, refetchType: "none" });
      await client.invalidateQueries({
        queryKey: ["review-runs", run.repositoryId],
        refetchType: "none",
      });
      if (!mounted.current) return;
      setReceipt(accepted);
      setEditor(null);
      setPage(1);
      // A receipt is historical. Fetch current state and history independently after acceptance.
      await stateQuery.refetch();
      if (historyOpen && page === 1) await historyQuery.refetch();
    } catch (error) {
      if (mounted.current) {
        setFailure(error);
        setEditor((current) => (current ? receiveDecisionFailure(current, error) : current));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const denied =
    isDecisionAccessDenied(stateError) ||
    isDecisionAccessDenied(historyError) ||
    isDecisionAccessDenied(failure);
  if ((!mayRead || denied) && !access.checking) {
    return (
      <Alert
        showIcon
        type="info"
        title="Decision records unavailable"
        description="Read access to this repository is required. Existing drafts are retained for this session while access is refreshed."
        action={
          <Button
            disabled={saving}
            onClick={() => {
              setFailure(null);
              void refreshAccess().then(() =>
                Promise.all([
                  stateQuery.refetch(),
                  ...(historyQuery.isError ? [historyQuery.refetch()] : []),
                ]),
              );
            }}
          >
            Refresh decision access
          </Button>
        }
      />
    );
  }
  const actions: DecisionAction[] =
    context?.workItemKind === "issue"
      ? ["request_changes", "comment", "withdraw"]
      : ["approve", "request_changes", "comment", "override_approve", "withdraw"];
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Recorded run decision
        </Typography.Title>
        <Button
          loading={stateQuery.isFetching}
          disabled={saving || reviewing || access.checking}
          onClick={() => void refresh()}
        >
          Refresh decisions
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        {decisionPublicationNotice} Decisions apply only to this run and its reviewed result set.
        Comments do not replace a decision.
      </Typography.Paragraph>
      {context && stateQuery.dataUpdatedAt > 0 && !access.checking && (
        <Typography.Text type="secondary">
          Last checked: {timestamp(new Date(stateQuery.dataUpdatedAt).toISOString())}.
          {decisions.mode === "connected"
            ? " Refreshes every 30 seconds while this page is visible and access is available. Refresh manually after an error."
            : " Sample records are refreshed on request."}
        </Typography.Text>
      )}
      {decisions.mode === "sample" && (
        <Alert
          showIcon
          type="info"
          title="Sample decision records"
          description="This preview uses simulated decision records. Changes affect sample data only."
        />
      )}
      {receipt && !access.checking && (
        <Alert
          showIcon
          type="success"
          title={receipt.replayed ? "Existing decision receipt received" : "Decision recorded"}
          description={decisionReceiptSummary(receipt.change)}
        />
      )}
      {access.checking ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : stateError ? (
        <ErrorNotice
          title="Could not load decision state"
          error={stateError}
          retry={() => void refresh()}
        />
      ) : !context ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <>
          <CurrentDecision context={context} />
          {context.recordedDecision && context.recordedDecision.action !== "withdraw" && (
            <Button
              disabled={decisions.mode !== "connected" || !access.can("read")}
              onClick={() => setPublicationDecisionId(context.recordedDecision?.id ?? null)}
            >
              Preview GitHub publication
            </Button>
          )}
          <Collapse
            items={[
              {
                key: "binding",
                label: "Current decision binding and policy",
                children: <DecisionBinding context={context} />,
              },
            ]}
          />
          <Space wrap>
            {actions.map((action) => {
              const reason = decisionUnavailableReason(action, context, access);
              return (
                <Tooltip key={action} title={reason}>
                  <span>
                    <Button
                      type={action === "approve" ? "primary" : "default"}
                      danger={action === "override_approve" || action === "withdraw"}
                      disabled={Boolean(reason) || busy || editor !== null}
                      onClick={() => {
                        if (!reason && !busy) {
                          setEditor(createDecisionEditor(context, action));
                          setFailure(null);
                        }
                      }}
                    >
                      {action === "override_approve"
                        ? "Record approval with exception"
                        : decisionActionLabel(action, context.workItemKind)}
                    </Button>
                  </span>
                </Tooltip>
              );
            })}
          </Space>
          {!access.can("review") && (
            <Typography.Text type="secondary">
              Reviewer access is required to record decisions, comments, and withdrawals. Only the
              recorded author or a maintainer can withdraw a decision.
            </Typography.Text>
          )}
        </>
      )}
      {editor && !access.checking && (
        <Space
          orientation="vertical"
          size="small"
          style={{
            width: "100%",
            border: "1px solid var(--ant-color-border-secondary, #f0f0f0)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <Typography.Text strong>
            {decisionActionLabel(editor.action, editor.reviewed.workItemKind)} · review before
            recording
          </Typography.Text>
          <DecisionBinding context={editor.reviewed} />
          {editor.action === "withdraw" && (
            <Typography.Text>
              Withdrawal target: {editor.reviewed.recordedDecision?.id}
            </Typography.Text>
          )}
          {editor.action === "override_approve" && (
            <Alert
              showIcon
              type="warning"
              title="Record an explicit human exception"
              description="Explain why approval is appropriate despite policy findings or missing validation. This never changes check outcomes or policy eligibility."
            />
          )}
          <Typography.Text>Reason</Typography.Text>
          <Input.TextArea
            aria-label="Decision reason"
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
            placeholder="Explain the decision for this source revision and result set."
          />
          {editor.request && (
            <Typography.Text type="secondary">
              This submitted intent is locked. Retry sends the original request and may return its
              historical receipt after later changes. To revise it, review and explicitly use the
              latest state.
            </Typography.Text>
          )}
          {freshReviewRequired && (
            <Alert
              showIcon
              type="warning"
              title="Fresh review required"
              description="The decision stream, source, or result set changed, or the server rejected the original binding. Your reason and original binding are preserved. Review the latest state before preparing another request."
            />
          )}
          {failure !== null && (
            <Alert
              showIcon
              type="error"
              title="Decision request could not be completed"
              description={
                failure instanceof Error ? failure.message : "The operation could not be completed."
              }
            />
          )}
          {editReason && <Typography.Text type="secondary">{editReason}</Typography.Text>}
          {editor.candidate && (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Typography.Text strong>Latest state for your review</Typography.Text>
              <CurrentDecision context={editor.candidate} />
              <DecisionBinding context={editor.candidate} />
              <Button
                disabled={busy || !context || !decisionBindingMatches(editor.candidate, context)}
                onClick={() => {
                  if (
                    !busy &&
                    context &&
                    editor.candidate &&
                    decisionBindingMatches(editor.candidate, context)
                  ) {
                    setEditor(acceptReviewedDecisionState(editor));
                    setFailure(null);
                  }
                }}
              >
                Use this reviewed state
              </Button>
            </Space>
          )}
          <Space wrap>
            <Button
              type="primary"
              danger={editor.action === "override_approve" || editor.action === "withdraw"}
              loading={saving}
              disabled={busy || Boolean(editReason) || freshReviewRequired || !editor.reason.trim()}
              onClick={() => void submit()}
            >
              {editor.request ? "Retry original submission" : "Record in platform"}
            </Button>
            <Button
              loading={reviewing}
              disabled={busy || !access.can("read")}
              onClick={() => void loadReview()}
            >
              Review latest state
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
      {!access.checking && (
        <Collapse
          activeKey={historyOpen ? ["history"] : []}
          onChange={(keys) => setHistoryOpen(keys.includes("history"))}
          items={[
            {
              key: "history",
              label: "Decision and comment history",
              children: historyError ? (
                <ErrorNotice
                  title="Could not load decision history"
                  error={historyError}
                  retry={() => void historyQuery.refetch()}
                />
              ) : historyQuery.isPending ? (
                <Skeleton active />
              ) : (
                <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    Entries are immutable records of the actor, source, result set, and policy at
                    recording. Earlier entries do not describe the current decision.
                  </Typography.Text>
                  {historyQuery.data?.items.length ? (
                    historyQuery.data.items.map((event) => (
                      <Space key={event.id} orientation="vertical" style={{ width: "100%" }}>
                        <DecisionEvent event={event} />
                        {event.action !== "withdraw" && (
                          <Button
                            disabled={decisions.mode !== "connected" || !access.can("read")}
                            aria-label={`Preview publication for decision ${event.id}`}
                            onClick={() => setPublicationDecisionId(event.id)}
                          >
                            Preview GitHub publication
                          </Button>
                        )}
                      </Space>
                    ))
                  ) : (
                    <Typography.Text type="secondary">
                      No decisions or comments have been recorded.
                    </Typography.Text>
                  )}
                  <Pagination
                    current={page}
                    pageSize={20}
                    total={historyQuery.data?.total ?? 0}
                    showSizeChanger={false}
                    hideOnSinglePage
                    disabled={saving || historyQuery.isFetching}
                    onChange={setPage}
                  />
                </Space>
              ),
            },
          ]}
        />
      )}
      {publicationDecisionId && access.ready && (mayRead || access.checking) && !denied && (
        <PublicationPreview
          key={JSON.stringify([run.repositoryId, run.id, publicationDecisionId])}
          repositoryId={run.repositoryId}
          reviewRunId={run.id}
          decisionId={publicationDecisionId}
          onClose={() => setPublicationDecisionId(null)}
        />
      )}
    </Space>
  );
}

export function ReviewRunDecisions({ run }: { run: DashboardReviewRunDetail }) {
  const access = useOperatorAccess(run.repositoryId);
  if (!access.principal) return <Skeleton active paragraph={{ rows: 2 }} />;
  return (
    <DecisionSession
      key={JSON.stringify([
        decisions.mode,
        run.repositoryId,
        run.id,
        access.principal.issuer,
        access.principal.subject,
      ])}
      run={run}
      principal={access.principal}
      access={access}
      refreshAccess={access.refresh}
    />
  );
}
