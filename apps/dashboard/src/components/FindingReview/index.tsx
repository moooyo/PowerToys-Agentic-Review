import type {
  DashboardReviewRunResult,
  FindingDispositionAction,
  FindingDispositionChangeResponse,
  FindingOccurrence,
  FindingOccurrenceRef,
  OperatorPrincipal,
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
  Chip,
  Pagination,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable } from "@/components/ui";
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
      const response = await findings.list(scope, {
        page,
        pageSize: 20,
      });
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
      return findings.history(scope, history, {
        page: historyPage,
        pageSize: 20,
      });
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
        client.invalidateQueries({
          queryKey: baseKey,
          refetchType: "none",
        }),
        client.invalidateQueries({
          queryKey: ["review-runs", result.repositoryId],
        }),
        client.invalidateQueries({
          queryKey: ["review-run-decisions"],
        }),
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
            variant="outlined"
          >
            Refresh finding access
          </Button>
        }
        severity="info"
      >
        <AlertTitle>{"Finding records unavailable"}</AlertTitle>
        {
          "Repository read access is required. Drafts are retained for this session while access is refreshed."
        }
      </Alert>
    );
  if (access.checking) return <Skeleton variant="rounded" height={72} />;
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
          Findings and dispositions
        </Typography>
        <Button
          loading={list.isFetching}
          disabled={busy}
          onClick={() => void refresh()}
          variant="outlined"
        >
          Refresh findings
        </Button>
      </Stack>
      <Typography variant="body1" component="p" color="text.secondary">
        {findingPublicationNotice}
      </Typography>
      {receipt && (
        <Alert severity="success">
          <AlertTitle>
            {receipt.replayed ? "Existing disposition receipt received" : "Disposition recorded"}
          </AlertTitle>
          {findingReceiptSummary(receipt.change)}
        </Alert>
      )}
      {listError ? (
        <ErrorNotice
          title="Could not load finding records"
          error={listError}
          retry={() => void refresh()}
        />
      ) : !context || !list.data ? (
        <Skeleton variant="rounded" height={72} />
      ) : (
        <>
          {list.dataUpdatedAt > 0 && (
            <Typography variant="body2" component="span" color="text.secondary">
              Last checked: {timestamp(new Date(list.dataUpdatedAt).toISOString())}. Refreshes every
              30 seconds while visible. Automatic refresh stops after an error.
            </Typography>
          )}
          {context.historical && (
            <Alert severity="warning">
              <AlertTitle>{"Historical result findings"}</AlertTitle>
              {
                "Changes here apply only to this saved result. They do not carry over to the latest activation or a different run. The reviewed execution context is checked again when you submit."
              }
            </Alert>
          )}
          {context.modelAvailability !== "complete" && (
            <Alert severity="info">
              <AlertTitle>{"Complete model findings are unavailable"}</AlertTitle>
              {`Model output: ${context.modelAvailability.replaceAll("_", " ")}. Missing output does not establish that this result has no problems.`}
            </Alert>
          )}
          <FindingSummary summary={list.data.summary} />
          <Accordion key="binding" disableGutters elevation={0} sx={{ bgcolor: "transparent" }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
              <Typography variant="subtitle1" component="div">
                {"Finding result identity and execution context"}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pb: 3 }}>
              <FindingBinding context={context} />
            </AccordionDetails>
          </Accordion>
          <DataTable<FindingOccurrence>
            rows={list.data.items}
            columns={[
              {
                id: "priority",
                label: "Priority",
                render: (finding) => (
                  <Chip
                    color={finding.priority < 2 ? "warning" : "default"}
                    size="medium"
                    label={<>P{finding.priority}</>}
                    sx={{
                      alignSelf: "flex-start",
                    }}
                  />
                ),
                minWidth: 96,
              },
              {
                id: "finding",
                label: "Finding",
                render: (finding) => (
                  <Accordion disableGutters elevation={0} sx={{ bgcolor: "transparent" }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
                      <Stack spacing={0.5}>
                        <Typography variant="body1" component="span" sx={{ fontWeight: 500 }}>
                          {finding.title}
                        </Typography>
                        <Typography variant="body2" component="span" color="text.secondary">
                          {finding.path ?? "No location"}
                          {finding.line === null ? "" : `:${finding.line}`}
                        </Typography>
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails sx={{ px: 0, pb: 3 }}>
                      <OriginalFinding finding={finding} />
                    </AccordionDetails>
                  </Accordion>
                ),
                minWidth: 320,
              },
              {
                id: "disposition",
                label: "Disposition",
                render: (finding) => (
                  <Stack spacing={0.5}>
                    <Typography variant="body2" component="span">
                      {findingStateLabel(finding.disposition.state)}
                    </Typography>
                    <Typography variant="body2" component="span" color="text.secondary">
                      Version {finding.disposition.version}
                    </Typography>
                  </Stack>
                ),
                minWidth: 180,
              },
              {
                id: "actions",
                label: "Actions",
                render: (finding) => (
                  <Stack
                    spacing={1}
                    direction="row"
                    useFlexGap
                    sx={{ alignItems: "center", flexWrap: "wrap" }}
                  >
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
                              size="medium"
                              disabled={!access.can("review") || busy || editor !== null}
                              onClick={() => {
                                setEditor(createFindingEditor(context, finding, action));
                                setFailure(null);
                              }}
                              variant="text"
                            >
                              {findingActionLabel(action)}
                            </Button>
                          </span>
                        </Tooltip>
                      ),
                    )}
                    <Button
                      size="medium"
                      onClick={() => {
                        setHistory(occurrenceRef(finding));
                        setHistoryPage(1);
                      }}
                      variant="text"
                    >
                      History
                    </Button>
                  </Stack>
                ),
                minWidth: 360,
              },
            ]}
            getRowId={(row) => row.key}
            emptyTitle={
              context.modelAvailability === "complete"
                ? "No findings were reported in this complete model output."
                : "No findings are available from a complete model output."
            }
            ariaLabel="Findings and dispositions"
          />
          {Math.ceil(list.data.total / 20) > 1 && (
            <Pagination
              disabled={busy || editor !== null}
              onChange={(_event, next) => {
                setPage(next);
                setHistory(null);
              }}
              page={page}
              count={Math.ceil(list.data.total / 20)}
              color="primary"
              size="medium"
            />
          )}
          {!access.can("review") && (
            <Typography variant="body2" component="span" color="text.secondary">
              Reviewer access is required to change dispositions. Original findings and history
              remain readable.
            </Typography>
          )}
        </>
      )}
      {editor && (
        <Card elevation={0} sx={{ width: "100%", bgcolor: "background.default" }}>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
                {findingActionLabel(editor.action)} · {editor.occurrence.title}
              </Typography>
              <Alert
                severity={
                  editor.action === "dismiss" || editor.action === "resolve" ? "warning" : "info"
                }
              >
                <AlertTitle>{"Review before recording"}</AlertTitle>
                {findingActionDescription(editor.action)}
              </Alert>
              <OriginalFinding finding={editor.occurrence} />
              <Accordion
                key="reviewed"
                disableGutters
                elevation={0}
                sx={{ bgcolor: "transparent" }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
                  <Typography variant="subtitle1" component="div">
                    {"Reviewed result and execution context"}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0, pb: 3 }}>
                  <FindingBinding context={editor.context} />
                </AccordionDetails>
              </Accordion>
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
                placeholder="Explain the disposition for this exact original finding."
                multiline
                fullWidth
                label="Finding disposition reason"
                slotProps={{
                  htmlInput: {
                    maxLength: 2_048,
                  },
                }}
                helperText={`${editor.reason.length} / 2048`}
              />
              {editor.request && (
                <Typography variant="body2" component="span" color="text.secondary">
                  The submitted intent is locked. Retry sends the exact original request and may
                  return a historical receipt after later changes. To revise it, review and
                  explicitly use the latest state.
                </Typography>
              )}
              {editReason && (
                <Alert severity="warning">
                  <AlertTitle>{"Fresh review or access is required"}</AlertTitle>
                  {`${editReason} Your reason and original binding are preserved.`}
                </Alert>
              )}
              {failure !== null && (
                <Alert severity="error">
                  <AlertTitle>{"Disposition request could not be completed"}</AlertTitle>
                  {failure instanceof Error
                    ? failure.message
                    : "The operation could not be completed."}
                </Alert>
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
                    variant="outlined"
                  >
                    Use this reviewed finding state
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
                  disabled={busy || Boolean(editReason) || !editor.reason.trim()}
                  onClick={() => void submit()}
                  variant="contained"
                >
                  {editor.request ? "Retry original submission" : "Record disposition in platform"}
                </Button>
                <Button
                  disabled={busy || !mayRead}
                  loading={reviewing}
                  onClick={() => void loadLatest()}
                  variant="outlined"
                >
                  Review latest finding state
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
      {history && (
        <Stack
          style={{
            width: "100%",
          }}
          spacing={1.5}
        >
          <Stack
            spacing={1}
            direction="row"
            useFlexGap
            sx={{ alignItems: "center", flexWrap: "wrap" }}
          >
            <Typography
              style={{
                margin: 0,
              }}
              variant="subtitle1"
              component="h3"
              sx={{ fontWeight: 500 }}
            >
              Finding disposition history
            </Typography>
            <Button onClick={() => setHistory(null)} variant="text">
              Close history
            </Button>
          </Stack>
          <Typography variant="body2" component="p" color="text.secondary">
            Immutable entries preserve the actor, reason, version, and execution context. An earlier
            receipt does not describe the current disposition.
          </Typography>
          {historyQuery.isError ? (
            <ErrorNotice
              title="Could not load disposition history"
              error={historyQuery.error}
              retry={() => void historyQuery.refetch()}
            />
          ) : !historyQuery.data ? (
            <Skeleton variant="rounded" height={72} />
          ) : (
            <>
              {historyQuery.data.items.length ? (
                historyQuery.data.items.map((event) => (
                  <FindingEvent key={event.id} event={event} />
                ))
              ) : (
                <Typography variant="body2" component="span" color="text.secondary">
                  No disposition has been recorded for this finding.
                </Typography>
              )}
              {Math.ceil(historyQuery.data.total / 20) > 1 && (
                <Pagination
                  disabled={historyQuery.isFetching}
                  onChange={(_event, next) => setHistoryPage(next)}
                  page={historyPage}
                  count={Math.ceil(historyQuery.data.total / 20)}
                  color="primary"
                  size="medium"
                />
              )}
            </>
          )}
        </Stack>
      )}
      <Accordion
        key="comparison"
        disableGutters
        elevation={0}
        sx={{ bgcolor: "transparent" }}
        expanded={comparisonOpen}
        onChange={(_event, expanded) => setComparisonOpen(expanded)}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 56 }}>
          <Typography variant="subtitle1" component="div">
            {"Compare with an earlier saved result"}
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0, pb: 3 }}>
          {comparisonOpen ? (
            <FindingComparison
              result={result}
              principal={principal}
              onDenied={markComparisonDenied}
            />
          ) : null}
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
export function FindingReview({ result }: { result: DashboardReviewRunResult }) {
  const access = useOperatorAccess(result.repositoryId);
  if (!access.principal) return <Skeleton variant="rounded" height={48} />;
  if (findings.mode === "sample")
    return (
      <Alert severity="info">
        <AlertTitle>{"Sample finding preview"}</AlertTitle>
        {
          "The original sample model output is shown above. Finding dispositions and comparisons require a connected control plane; this preview does not simulate those records or change sample approval eligibility."
        }
      </Alert>
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
