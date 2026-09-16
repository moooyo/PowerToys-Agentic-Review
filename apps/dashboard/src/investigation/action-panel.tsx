import type {
  ActionContextV1,
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationActionPayload,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { investigationApi, type WorkItem } from "./api";
import type { FeedbackSelectionEvent, FeedbackSelectionState } from "./feedback-selection";
import { Section, TextList } from "./report-sections";
import { useInvestigationSession } from "./session";

export const actionLabels: Record<InvestigationActionKind, string> = {
  comment: "Comment",
  approve: "Approve",
  "suggestion-comment": "Code suggestion comment",
  "request-changes": "Request changes",
  close: "Close",
  merge: "Merge",
  "trigger-ci": "Trigger CI",
  "close-as-duplicate": "Close as duplicate",
  "start-task": "Start linked task",
  "reviews.verify": "Verify PR",
  "view-validation": "View validation",
  "view-changes": "View changes",
  "create-pr": "Create pull request",
  "view-evidence": "View evidence",
  resume: "Resume investigation",
};

export function reportNavigation(
  action: InvestigationActionKind,
  reportId: string,
  repositoryId: string,
): string {
  const section =
    action === "view-changes"
      ? "changes"
      : action === "view-validation"
        ? "validation"
        : "evidence";
  return `/reports?reportId=${encodeURIComponent(reportId)}&repositoryId=${encodeURIComponent(repositoryId)}&section=${section}`;
}

const navigationActions = new Set<InvestigationActionKind>([
  "view-validation",
  "view-changes",
  "view-evidence",
]);

export function materializeFeedback(
  state: FeedbackSelectionState<InvestigationActionKind>,
  result: InvestigationResultV1 | undefined,
  editedBodies: Record<string, string>,
  body: string,
): Extract<InvestigationActionPayload, { kind: "feedback" }> {
  const drafts = state.selectedFindings.map((selection) => {
    const finding = result?.findings.find(
      (candidate) =>
        candidate.id === selection.findingId && candidate.feedbackDraft.id === selection.draftId,
    );
    if (!finding)
      throw new Error(
        "A selected finding is unavailable in this report version. Refresh before preparing feedback.",
      );
    return {
      ...finding.feedbackDraft,
      body: editedBodies[finding.feedbackDraft.id] ?? finding.feedbackDraft.body,
      suggestion:
        selection.suggestionId !== null && state.action !== "comment"
          ? finding.feedbackDraft.suggestion
          : null,
    };
  });
  for (const draftId of state.selectedDraftIds) {
    const draft = result?.feedbackDrafts.find((candidate) => candidate.id === draftId);
    if (!draft)
      throw new Error(
        "A selected independent draft is unavailable. Refresh before preparing feedback.",
      );
    drafts.push({ ...draft, body: editedBodies[draftId] ?? draft.body, suggestion: null });
  }
  return {
    kind: "feedback",
    body,
    findingIds: state.selectedFindings.map((item) => item.findingId),
    drafts,
  };
}

export function isActionAllowed(
  context: ActionContextV1,
  action: InvestigationActionKind,
  nextActionId?: string,
): boolean {
  if (action === "approve" && context.hardContentBlockers.length > 0) return false;
  return nextActionId
    ? context.nextActions.some(
        (candidate) =>
          candidate.id === nextActionId &&
          candidate.action === action &&
          candidate.state === "saved" &&
          candidate.canPrepare,
      )
    : context.fixedActions.some((candidate) => candidate.action === action && candidate.allowed);
}

export function ActionPanel({
  workItem,
  context,
  result,
  selection,
  dispatch,
  editedBodies,
}: {
  workItem: WorkItem;
  context: ActionContextV1;
  result?: InvestigationResultV1;
  selection: FeedbackSelectionState<InvestigationActionKind>;
  dispatch: (event: FeedbackSelectionEvent<InvestigationActionKind>) => void;
  editedBodies: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const { session } = useInvestigationSession();
  const [nextActionId, setNextActionId] = useState<string>();
  const [body, setBody] = useState("");
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [commitTitle, setCommitTitle] = useState("");
  const [closeReason, setCloseReason] = useState<"completed" | "not_planned">("completed");
  const [duplicateNumber, setDuplicateNumber] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [workflowRef, setWorkflowRef] = useState("");
  const [workflowInputs, setWorkflowInputs] = useState("{}");
  const [branchSubjectRef, setBranchSubjectRef] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [sourceCommit, setSourceCommit] = useState("");
  const [intent, setIntent] = useState<InvestigationActionIntentV1>();
  const canExecuteIntent = Boolean(
    intent &&
      session.user?.permissions.includes("action:execute") &&
      session.user.actionCapabilities.includes(intent.action),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeNextAction = nextActionId
    ? context.nextActions.find(
        (item) => item.id === nextActionId && item.action === selection.action,
      )
    : undefined;
  const recommendedNextAction = context.nextActions.find(
    (item) => item.id === context.recommendedActionId && item.action === selection.action,
  );
  const proposal =
    activeNextAction ?? (!selection.explicitAction ? recommendedNextAction : undefined);
  const plan = proposal?.planRef
    ? result?.plans.find(
        (item) =>
          item.id === proposal.planRef?.id &&
          item.version === proposal.planRef.version &&
          item.digest === proposal.planRef.digest,
      )
    : undefined;
  const action = selection.action;
  const allowed = action !== null && isActionAllowed(context, action, proposal?.id);
  const feedbackAction =
    action !== null &&
    ["comment", "approve", "suggestion-comment", "request-changes"].includes(action);
  const feedbackReady =
    !feedbackAction ||
    action === "approve" ||
    body.trim().length > 0 ||
    selection.selectedFindings.length > 0 ||
    selection.selectedDraftIds.length > 0;

  const selectAction = (selected: InvestigationActionKind, proposalId?: string) => {
    setNextActionId(proposalId);
    const suggested = proposalId
      ? context.nextActions.find((item) => item.id === proposalId)
      : undefined;
    if (
      suggested?.draftRef &&
      result?.feedbackDrafts.some((draft) => draft.id === suggested.draftRef)
    ) {
      dispatch({ type: "set-draft", draftId: suggested.draftRef, selected: true });
    } else if (suggested?.draftRef) {
      const finding = result?.findings.find((item) => item.feedbackDraft.id === suggested.draftRef);
      if (finding)
        dispatch({
          type: "set-finding",
          finding: {
            findingId: finding.id,
            draftId: finding.feedbackDraft.id,
            suggestionId: finding.feedbackDraft.suggestion ? finding.feedbackDraft.id : null,
          },
          selected: true,
        });
    }
    dispatch({ type: "set-action", action: selected });
    setError(undefined);
  };
  const makePayload = (): InvestigationActionPayload => {
    if (!action) throw new Error("Select an operation to prepare.");
    if (feedbackAction) return materializeFeedback(selection, result, editedBodies, body);
    if (action === "start-task" || action === "reviews.verify") {
      if (!proposal?.planRef || !proposal.taskKind || !plan)
        throw new Error(
          "This action requires its exact saved plan. Load the report details and refresh the action context.",
        );
      if (sourceCommit && !/^[a-f0-9]{40,64}$/u.test(sourceCommit))
        throw new Error("Enter the full hexadecimal source commit SHA.");
      return {
        kind: "task",
        taskKind: proposal.taskKind,
        planRef: proposal.planRef,
        ...(sourceCommit ? { sourceCommit } : {}),
      };
    }
    if (action === "close" || action === "close-as-duplicate") {
      const duplicate = Number(duplicateNumber);
      if (action === "close-as-duplicate" && (!Number.isInteger(duplicate) || duplicate <= 0))
        throw new Error("Enter the original issue number.");
      return {
        kind: "close",
        reason: action === "close-as-duplicate" ? "duplicate" : closeReason,
        duplicateNumber: action === "close-as-duplicate" ? duplicate : null,
      };
    }
    if (action === "merge") return { kind: "merge", method: mergeMethod, commitTitle };
    if (action === "trigger-ci") {
      const inputs: unknown = JSON.parse(workflowInputs);
      if (
        !workflowId.trim() ||
        !workflowRef.trim() ||
        typeof inputs !== "object" ||
        inputs === null ||
        Array.isArray(inputs) ||
        Object.values(inputs).some((value) => typeof value !== "string")
      )
        throw new Error(
          "Supply a workflow, an exact ref, and a JSON object containing string inputs.",
        );
      return {
        kind: "trigger-ci",
        workflowId,
        ref: workflowRef,
        inputs: inputs as Record<string, string>,
      };
    }
    if (action === "create-pr") {
      if (
        !result?.context.subjects.some(
          (subject) => subject.id === branchSubjectRef && subject.kind === "remote_branch",
        ) ||
        !prTitle.trim() ||
        !baseBranch.trim()
      )
        throw new Error(
          "Select an existing verified remote branch and provide the pull request title and base branch.",
        );
      return { kind: "create-pr", branchSubjectRef, title: prTitle, body, baseBranch, draft: true };
    }
    throw new Error("This operation does not have a preparation form in this workspace.");
  };
  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!action || !isActionAllowed(context, action, proposal?.id))
        throw new Error("This operation is not allowed by the current server context.");
      const payload = makePayload();
      const prepared = await investigationApi.prepareAction({
        workItemId: workItem.id,
        action,
        ...(proposal ? { nextActionId: proposal.id } : {}),
        reportRef: context.reportRef,
        subjectRef: proposal?.subjectRef ?? workItem.subject.id,
        expectedRevisionKey: context.target.revisionKey,
        expectedHeadSha: context.target.headSha,
        idempotencyKey: crypto.randomUUID(),
        payload,
      });
      setIntent(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation could not be prepared.");
    } finally {
      setBusy(false);
    }
  };
  const updateIntent = async (operation: "confirm" | "refresh" | "reconcile") => {
    if (!intent) return;
    setBusy(true);
    setError(undefined);
    try {
      const next =
        operation === "confirm"
          ? await investigationApi.confirmAction(intent.id, intent.version, intent.payloadDigest)
          : operation === "reconcile"
            ? await investigationApi.reconcileAction(intent.id)
            : await investigationApi.actionIntent(intent.id);
      setIntent(next);
      await queryClient.invalidateQueries({
        queryKey: ["investigation-action-context", workItem.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The operation status is unavailable. Recheck the saved intent before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Decide the next step">
      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography variant="subtitle2">Recommendation</Typography>
        {context.recommendation.reason}
      </Alert>
      {context.hardContentBlockers.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Approve is unavailable: the server found a confirmed unresolved P0 on the current original
          version. This applies across every findings page.
          <TextList
            items={context.hardContentBlockers.map((item) => `${item.findingId}: ${item.reason}`)}
          />
        </Alert>
      )}
      {context.pendingSubmission && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {context.pendingSubmission.message}
          <Button
            onClick={() => {
              void investigationApi
                .actionIntent(context.pendingSubmission!.intentId)
                .then(setIntent)
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not load the pending submission.",
                  ),
                );
            }}
          >
            Inspect previous submission
          </Button>
        </Alert>
      )}
      {context.nextActions.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Saved next actions
          </Typography>
          <Stack spacing={1}>
            {context.nextActions.map((item) => (
              <Box key={item.id}>
                {navigationActions.has(item.action) &&
                (item.validationReportRef ?? context.reportRef) ? (
                  <Button
                    component={Link}
                    disabled={!item.allowed}
                    to={reportNavigation(
                      item.action,
                      (item.validationReportRef ?? context.reportRef)!.id,
                      workItem.repositoryId,
                    )}
                  >
                    {item.label}
                  </Button>
                ) : (
                  <Button
                    variant={item.recommended ? "outlined" : "text"}
                    disabled={
                      !item.canPrepare ||
                      ((item.draftRef !== null || item.planRef !== null) && !result)
                    }
                    onClick={() => selectAction(item.action, item.id)}
                  >
                    {item.label}
                  </Button>
                )}
                {item.recommended && <Chip size="small" label="Recommended" sx={{ ml: 1 }} />}
                <Typography variant="body2" color="text.secondary">
                  {item.reason}
                </Typography>
                {item.canPrepare && !item.readyToExecute && (
                  <Typography variant="caption" component="div" color="warning.main">
                    Preparation is available. Execution still requires the listed prerequisites.
                  </Typography>
                )}
                {item.guards
                  .filter((guard) => !guard.satisfied)
                  .map((guard) => (
                    <Typography
                      key={guard.code}
                      variant="caption"
                      component="div"
                      color="warning.main"
                    >
                      {guard.message}
                    </Typography>
                  ))}
              </Box>
            ))}
          </Stack>
        </Box>
      )}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Fixed operations
      </Typography>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}>
        {context.fixedActions.map((item) => (
          <Box key={item.action}>
            <Button
              variant={action === item.action && !proposal ? "contained" : "outlined"}
              disabled={!isActionAllowed(context, item.action)}
              onClick={() => selectAction(item.action)}
            >
              {actionLabels[item.action]}
            </Button>
            {!item.allowed && (
              <Typography
                variant="caption"
                component="div"
                color="text.secondary"
                sx={{ maxWidth: 220, mt: 0.5 }}
              >
                {item.reason}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle1">
        {action ? `Prepare ${actionLabels[action]}` : "Select an available action"}
      </Typography>
      {action && navigationActions.has(action) && context.reportRef && (
        <Button
          component={Link}
          to={reportNavigation(action, context.reportRef.id, workItem.repositoryId)}
        >
          {actionLabels[action]}
        </Button>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        {selection.selectedFindings.length} findings selected across all pages.{" "}
        {selection.explicitAction
          ? "Your explicitly chosen operation is retained."
          : "The prepared operation follows the selected feedback or the server recommendation."}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button size="small" onClick={() => dispatch({ type: "clear-selection" })}>
          Clear selection
        </Button>
        {selection.explicitAction && (
          <Button
            size="small"
            onClick={() => {
              setNextActionId(undefined);
              dispatch({ type: "reset-action" });
            }}
          >
            Use automatic choice
          </Button>
        )}
      </Stack>
      {plan && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2">{plan.title}</Typography>
          <Typography variant="body2">{plan.rationale}</Typography>
          <TextList
            items={plan.steps.map(
              (step) => `${step.description} Expected: ${step.expectedObservation}`,
            )}
          />
          <Typography variant="overline">Acceptance criteria</Typography>
          <TextList items={plan.acceptanceCriteria} />
          <Typography variant="overline">Prerequisites</Typography>
          <TextList items={plan.prerequisites.map((item) => item.description)} />
        </Box>
      )}
      {plan &&
        workItem.kind === "issue" &&
        (action === "start-task" || action === "reviews.verify") && (
          <TextField
            fullWidth
            label="Exact source commit SHA"
            value={sourceCommit}
            onChange={(event) => setSourceCommit(event.target.value.trim())}
            helperText="Issue snapshots do not identify a source revision. Choose the full commit SHA for the linked investigation or verification."
            sx={{ mb: 2 }}
          />
        )}
      {feedbackAction && (
        <TextField
          label="Additional comment"
          multiline
          minRows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          fullWidth
          helperText="The preview will contain this text and only the selected independent drafts."
        />
      )}
      {action === "close" && (
        <TextField
          select
          fullWidth
          label="Close reason"
          value={closeReason}
          onChange={(event) => setCloseReason(event.target.value as "completed" | "not_planned")}
        >
          <MenuItem value="completed">Completed</MenuItem>
          <MenuItem value="not_planned">Not planned</MenuItem>
        </TextField>
      )}
      {action === "close-as-duplicate" && (
        <TextField
          label="Original issue number"
          type="number"
          value={duplicateNumber}
          onChange={(event) => setDuplicateNumber(event.target.value)}
        />
      )}
      {action === "merge" && (
        <Stack spacing={2}>
          <TextField
            select
            label="Merge method"
            value={mergeMethod}
            onChange={(event) =>
              setMergeMethod(event.target.value as "merge" | "squash" | "rebase")
            }
          >
            <MenuItem value="squash">Squash</MenuItem>
            <MenuItem value="merge">Merge commit</MenuItem>
            <MenuItem value="rebase">Rebase</MenuItem>
          </TextField>
          <TextField
            label="Commit title"
            value={commitTitle}
            onChange={(event) => setCommitTitle(event.target.value)}
          />
        </Stack>
      )}
      {action === "trigger-ci" && (
        <Stack spacing={2}>
          <TextField
            label="Workflow ID or file name"
            value={workflowId}
            onChange={(event) => setWorkflowId(event.target.value)}
          />
          <TextField
            label="Exact workflow ref"
            value={workflowRef}
            onChange={(event) => setWorkflowRef(event.target.value)}
          />
          <TextField
            label="Workflow inputs (JSON)"
            multiline
            minRows={3}
            value={workflowInputs}
            onChange={(event) => setWorkflowInputs(event.target.value)}
          />
        </Stack>
      )}
      {action === "create-pr" && (
        <Stack spacing={2}>
          <Alert severity="info">
            Create PR uses an existing verified remote branch. It does not commit or push changes.
          </Alert>
          <TextField
            select
            label="Verified remote branch"
            value={branchSubjectRef}
            onChange={(event) => setBranchSubjectRef(event.target.value)}
          >
            {result?.context.subjects
              .filter((subject) => subject.kind === "remote_branch")
              .map((subject) => (
                <MenuItem key={subject.id} value={subject.id}>
                  {subject.kind === "remote_branch"
                    ? `${subject.branch} · ${subject.headSha}`
                    : subject.id}
                </MenuItem>
              ))}
          </TextField>
          <TextField
            label="Pull request title"
            value={prTitle}
            onChange={(event) => setPrTitle(event.target.value)}
          />
          <TextField
            label="Base branch"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
          />
          <TextField
            multiline
            label="Pull request body"
            minRows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </Stack>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
      <Button
        variant="contained"
        disabled={
          !allowed ||
          !feedbackReady ||
          busy ||
          ((action === "start-task" || action === "reviews.verify") && !plan)
        }
        onClick={() => void prepare()}
        sx={{ mt: 2 }}
      >
        {busy ? "Working…" : "Prepare preview"}
      </Button>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 1 }}>
        Preparing saves an exact preview. Execution requires a separate confirmation and fresh
        server checks.
      </Typography>
      <Dialog
        open={Boolean(intent)}
        onClose={() => {
          if (!busy) setIntent(undefined);
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {intent ? `${actionLabels[intent.action]} · ${intent.state}` : "Action preview"}
        </DialogTitle>
        <DialogContent dividers>
          {intent && (
            <Stack spacing={2}>
              <Typography variant="body2">
                Target: {workItem.repositoryId} · #{workItem.number} · {intent.workItemId}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                Expected SHA: {intent.expectedHeadSha ?? "Issue snapshot"}
                <br />
                Revision: {intent.expectedRevisionKey}
              </Typography>
              <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                Preview {intent.id} · Version {intent.version} · Payload digest{" "}
                {intent.payloadDigest}
              </Typography>
              <Box
                component="pre"
                sx={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  fontSize: 12,
                  bgcolor: "action.hover",
                  borderRadius: 2,
                  p: 2,
                }}
              >
                {JSON.stringify(intent.payload, null, 2)}
              </Box>
              {intent.state === "prepared" && !canExecuteIntent && (
                <Alert severity="info">
                  Your account can prepare this preview but does not have permission to execute it.
                </Alert>
              )}
              {intent.guards
                .filter((guard) => !guard.satisfied)
                .map((guard) => (
                  <Alert key={guard.code} severity="warning">
                    {guard.message}
                  </Alert>
                ))}
              {intent.result && (
                <Alert
                  severity={
                    intent.state === "succeeded"
                      ? "success"
                      : intent.state === "failed"
                        ? "error"
                        : "info"
                  }
                >
                  {intent.result.message}
                </Alert>
              )}
              {intent.state === "unknown" && (
                <Alert severity="warning">
                  The previous submission has no confirmed outcome. Reconcile it before creating
                  another submission.
                </Alert>
              )}
              {error && <Alert severity="error">{error}</Alert>}
              {intent.result?.taskId && (
                <Button
                  component={Link}
                  to={`/tasks?taskId=${encodeURIComponent(intent.result.taskId)}&repositoryId=${encodeURIComponent(workItem.repositoryId)}`}
                >
                  Open linked task
                </Button>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setIntent(undefined)}>
            Close preview
          </Button>
          {intent && ["unknown", "executing"].includes(intent.state) && (
            <Button disabled={busy} onClick={() => void updateIntent("reconcile")}>
              Reconcile submission
            </Button>
          )}
          {intent && ["confirmed", "executing"].includes(intent.state) && (
            <Button disabled={busy} onClick={() => void updateIntent("refresh")}>
              Refresh status
            </Button>
          )}
          {intent?.state === "prepared" && (
            <Button
              variant="contained"
              disabled={
                busy || !canExecuteIntent || intent.guards.some((guard) => !guard.satisfied)
              }
              onClick={() => void updateIntent("confirm")}
            >
              Confirm {actionLabels[intent.action]}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Section>
  );
}
