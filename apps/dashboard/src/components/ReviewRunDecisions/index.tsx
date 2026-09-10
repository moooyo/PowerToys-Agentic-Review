import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  ReviewRunDecisionChangeResponse,
} from "@agentic-review/contracts";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Button,
  Card,
  CardContent,
  Pagination,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
    queryFn: () =>
      decisions.listHistory(run.repositoryId, run.id, {
        page,
        pageSize: 20,
      }),
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
      await client.invalidateQueries({
        queryKey: baseKey,
        refetchType: "none",
      });
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
            variant="outlined"
          >
            Refresh decision access
          </Button>
        }
        severity="info"
      >
        <AlertTitle>{"Decision records unavailable"}</AlertTitle>
        {
          "Read access to this repository is required. Existing drafts are retained for this session while access is refreshed."
        }
      </Alert>
    );
  }
  const actions: DecisionAction[] =
    context?.workItemKind === "issue"
      ? ["request_changes", "comment", "withdraw"]
      : ["approve", "request_changes", "comment", "override_approve", "withdraw"];
  return (
    <Stack component="section" spacing={3} sx={{ width: "100%", minWidth: 0 }}>
      <Stack
        spacing={2}
        direction="row"
        useFlexGap
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
      >
        <Typography
          style={{
            margin: 0,
          }}
          variant="h5"
          component="h3"
          sx={{ fontWeight: 500 }}
        >
          Recorded run decision
        </Typography>
        <Button
          loading={stateQuery.isFetching}
          disabled={saving || reviewing || access.checking}
          onClick={() => void refresh()}
          variant="outlined"
        >
          Refresh decisions
        </Button>
      </Stack>
      <Typography
        style={{
          margin: 0,
        }}
        variant="body1"
        component="p"
        color="text.secondary"
      >
        {decisionPublicationNotice} Decisions apply only to this run and its reviewed result set.
        Comments do not replace a decision.
      </Typography>
      {context && stateQuery.dataUpdatedAt > 0 && !access.checking && (
        <Typography variant="body2" component="span" color="text.secondary">
          Last checked: {timestamp(new Date(stateQuery.dataUpdatedAt).toISOString())}.
          {decisions.mode === "connected"
            ? " Refreshes every 30 seconds while this page is visible and access is available. Refresh manually after an error."
            : " Sample records are refreshed on request."}
        </Typography>
      )}
      {decisions.mode === "sample" && (
        <Alert severity="info">
          <AlertTitle>{"Sample decision records"}</AlertTitle>
          {"This preview uses simulated decision records. Changes affect sample data only."}
        </Alert>
      )}
      {receipt && !access.checking && (
        <Alert severity="success">
          <AlertTitle>
            {receipt.replayed ? "Existing decision receipt received" : "Decision recorded"}
          </AlertTitle>
          {decisionReceiptSummary(receipt.change)}
        </Alert>
      )}
      {access.checking ? (
        <Skeleton variant="rounded" height={72} />
      ) : stateError ? (
        <ErrorNotice
          title="Could not load decision state"
          error={stateError}
          retry={() => void refresh()}
        />
      ) : !context ? (
        <Skeleton variant="rounded" height={72} />
      ) : (
        <>
          <CurrentDecision context={context} />
          {context.recordedDecision && context.recordedDecision.action !== "withdraw" && (
            <Button
              disabled={decisions.mode !== "connected" || !access.can("read")}
              onClick={() => setPublicationDecisionId(context.recordedDecision?.id ?? null)}
              variant="outlined"
            >
              Preview GitHub publication
            </Button>
          )}
          <Accordion key="binding" disableGutters elevation={0} sx={{ bgcolor: "transparent" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
              <Typography variant="subtitle1" component="div">
                {"Current decision binding and policy"}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pb: 3 }}>
              <DecisionBinding context={context} />
            </AccordionDetails>
          </Accordion>
          <Stack
            spacing={1}
            direction="row"
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            {actions.map((action) => {
              const reason = decisionUnavailableReason(action, context, access);
              return (
                <Tooltip key={action} title={reason}>
                  <span>
                    <Button
                      disabled={Boolean(reason) || busy || editor !== null}
                      onClick={() => {
                        if (!reason && !busy) {
                          setEditor(createDecisionEditor(context, action));
                          setFailure(null);
                        }
                      }}
                      variant={
                        action === "approve"
                          ? "contained"
                          : action === "request_changes" || action === "override_approve"
                            ? "outlined"
                            : "text"
                      }
                      color={
                        action === "override_approve" || action === "withdraw" ? "error" : "primary"
                      }
                    >
                      {action === "override_approve"
                        ? "Record approval with exception"
                        : decisionActionLabel(action, context.workItemKind)}
                    </Button>
                  </span>
                </Tooltip>
              );
            })}
          </Stack>
          {!access.can("review") && (
            <Typography variant="body2" component="span" color="text.secondary">
              Reviewer access is required to record decisions, comments, and withdrawals. Only the
              recorded author or a maintainer can withdraw a decision.
            </Typography>
          )}
        </>
      )}
      {editor && !access.checking && (
        <Card elevation={0} sx={{ width: "100%", bgcolor: "background.default" }}>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
                {decisionActionLabel(editor.action, editor.reviewed.workItemKind)} · review before
                recording
              </Typography>
              <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent" }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
                  <Typography variant="subtitle1" component="div">
                    Reviewed source and decision policy
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0, pb: 3 }}>
                  <DecisionBinding context={editor.reviewed} />
                </AccordionDetails>
              </Accordion>
              {editor.action === "withdraw" && (
                <Typography variant="body2" component="span">
                  Withdrawal target: {editor.reviewed.recordedDecision?.id}
                </Typography>
              )}
              {editor.action === "override_approve" && (
                <Alert severity="warning">
                  <AlertTitle>{"Record an explicit human exception"}</AlertTitle>
                  {
                    "Explain why approval is appropriate despite policy findings or missing validation. This never changes check outcomes or policy eligibility."
                  }
                </Alert>
              )}
              <TextField
                rows={3}
                value={editor.reason}
                disabled={saving || reviewing || editor.request !== null}
                onChange={(event) =>
                  setEditor((current) =>
                    current && !current.request
                      ? {
                          ...current,
                          reason: event.target.value,
                        }
                      : current,
                  )
                }
                placeholder="Explain the decision for this source revision and result set."
                multiline
                fullWidth
                label="Decision reason"
                slotProps={{
                  htmlInput: {
                    maxLength: 2_048,
                  },
                }}
                helperText={`${editor.reason.length} / 2048`}
              />
              {editor.request && (
                <Typography variant="body2" component="span" color="text.secondary">
                  This submitted intent is locked. Retry sends the original request and may return
                  its historical receipt after later changes. To revise it, review and explicitly
                  use the latest state.
                </Typography>
              )}
              {freshReviewRequired && (
                <Alert severity="warning">
                  <AlertTitle>{"Fresh review required"}</AlertTitle>
                  {
                    "The decision stream, source, or result set changed, or the server rejected the original binding. Your reason and original binding are preserved. Review the latest state before preparing another request."
                  }
                </Alert>
              )}
              {failure !== null && (
                <Alert severity="error">
                  <AlertTitle>{"Decision request could not be completed"}</AlertTitle>
                  {failure instanceof Error
                    ? failure.message
                    : "The operation could not be completed."}
                </Alert>
              )}
              {editReason && (
                <Typography variant="body2" component="span" color="text.secondary">
                  {editReason}
                </Typography>
              )}
              {editor.candidate && (
                <Stack
                  style={{
                    width: "100%",
                  }}
                  spacing={1.5}
                >
                  <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
                    Latest state for your review
                  </Typography>
                  <CurrentDecision context={editor.candidate} />
                  <DecisionBinding context={editor.candidate} />
                  <Button
                    disabled={
                      busy || !context || !decisionBindingMatches(editor.candidate, context)
                    }
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
                    variant="outlined"
                  >
                    Use this reviewed state
                  </Button>
                </Stack>
              )}
              <Stack
                spacing={1}
                direction="row"
                useFlexGap
                sx={{ alignItems: "center", flexWrap: "wrap" }}
              >
                <Button
                  loading={saving}
                  disabled={
                    busy || Boolean(editReason) || freshReviewRequired || !editor.reason.trim()
                  }
                  onClick={() => void submit()}
                  variant="contained"
                  color={
                    editor.action === "override_approve" || editor.action === "withdraw"
                      ? "error"
                      : "primary"
                  }
                >
                  {editor.request ? "Retry original submission" : "Record in platform"}
                </Button>
                <Button
                  loading={reviewing}
                  disabled={busy || !access.can("read")}
                  onClick={() => void loadReview()}
                  variant="outlined"
                >
                  Review latest state
                </Button>
                <Button
                  disabled={saving || reviewing}
                  onClick={() => {
                    setEditor(null);
                    setFailure(null);
                  }}
                  variant="text"
                >
                  Discard draft
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}
      {!access.checking && (
        <Accordion
          key="history"
          disableGutters
          elevation={0}
          sx={{ bgcolor: "transparent" }}
          expanded={historyOpen}
          onChange={(_event, expanded) => setHistoryOpen(expanded)}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
            <Typography variant="subtitle1" component="div">
              {"Decision and comment history"}
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0, pb: 3 }}>
            {historyError ? (
              <ErrorNotice
                title="Could not load decision history"
                error={historyError}
                retry={() => void historyQuery.refetch()}
              />
            ) : historyQuery.isPending ? (
              <Skeleton variant="rounded" height={72} />
            ) : (
              <Stack
                style={{
                  width: "100%",
                }}
                spacing={2}
              >
                <Typography variant="body2" component="span" color="text.secondary">
                  Entries are immutable records of the actor, source, result set, and policy at
                  recording. Earlier entries do not describe the current decision.
                </Typography>
                {historyQuery.data?.items.length ? (
                  historyQuery.data.items.map((event) => (
                    <Stack
                      key={event.id}
                      style={{
                        width: "100%",
                      }}
                      spacing={1.5}
                    >
                      <DecisionEvent event={event} />
                      {event.action !== "withdraw" && (
                        <Button
                          disabled={decisions.mode !== "connected" || !access.can("read")}
                          aria-label={`Preview publication for decision ${event.id}`}
                          onClick={() => setPublicationDecisionId(event.id)}
                          variant="text"
                        >
                          Preview GitHub publication
                        </Button>
                      )}
                    </Stack>
                  ))
                ) : (
                  <Typography variant="body2" component="span" color="text.secondary">
                    No decisions or comments have been recorded.
                  </Typography>
                )}
                {Math.ceil((historyQuery.data?.total ?? 0) / 20) > 1 && (
                  <Pagination
                    disabled={saving || historyQuery.isFetching}
                    onChange={(_event, next) => setPage(next)}
                    page={page}
                    count={Math.ceil((historyQuery.data?.total ?? 0) / 20)}
                    color="primary"
                    size="medium"
                  />
                )}
              </Stack>
            )}
          </AccordionDetails>
        </Accordion>
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
    </Stack>
  );
}
export function ReviewRunDecisions({ run }: { run: DashboardReviewRunDetail }) {
  const access = useOperatorAccess(run.repositoryId);
  if (!access.principal) return <Skeleton variant="rounded" height={48} />;
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
