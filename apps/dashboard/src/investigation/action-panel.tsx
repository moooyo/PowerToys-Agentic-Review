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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ActionDraftFields,
  type ActionDraftRecord,
  acceptPreparedAction,
  actionDraftIsDirty,
  actionDraftKey,
  actionDraftLease,
  beginActionConfirmation,
  beginActionPreparation,
  createActionDraft,
  discardActionDraft,
  hasUnresolvedActionPreparation,
  hasUnresolvedActionSubmission,
  inspectActionIntent,
  retainActionIntent,
  saveActionDraft,
} from "./action-draft-store";
import { investigationApi, type PrepareActionInput, type WorkItem } from "./api";
import type { FeedbackSelectionEvent, FeedbackSelectionState } from "./feedback-selection";
import { useUnsavedChanges } from "./navigation-guard";
import { TextList } from "./report-sections";
import { sessionIdentity, useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

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
  if (drafts.some((draft) => !draft.body.trim()))
    throw new Error(
      "A selected feedback draft is empty. Add content or remove it from the selection.",
    );
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

export function actionIntentMatchesContext(
  intent: InvestigationActionIntentV1,
  context: ActionContextV1,
): boolean {
  return (
    intent.workItemId === context.workItemId &&
    intent.repositoryId === context.repositoryId &&
    intent.actorId === context.actor.id &&
    intent.expectedRevisionKey === context.target.revisionKey &&
    intent.expectedHeadSha === context.target.headSha &&
    intent.reportRef?.id === context.reportRef?.id &&
    intent.reportRef?.version === context.reportRef?.version &&
    intent.reportRef?.digest === context.reportRef?.digest
  );
}

export function assertActionPreparationBindings(
  savedItem: WorkItem,
  savedContext: ActionContextV1,
  liveItem: WorkItem,
  liveContext: ActionContextV1,
  allowSourceRefresh = false,
): void {
  if (
    liveItem.id !== savedItem.id ||
    liveItem.repositoryId !== savedItem.repositoryId ||
    liveItem.kind !== savedItem.kind ||
    liveItem.number !== savedItem.number ||
    liveContext.workItemId !== liveItem.id ||
    liveContext.repositoryId !== liveItem.repositoryId ||
    liveContext.workItemId !== savedContext.workItemId ||
    liveContext.repositoryId !== savedContext.repositoryId ||
    liveContext.actor.id !== savedContext.actor.id ||
    liveContext.target.kind !== liveItem.kind ||
    liveContext.reportRef?.id !== savedContext.reportRef?.id ||
    liveContext.reportRef?.version !== savedContext.reportRef?.version ||
    liveContext.reportRef?.digest !== savedContext.reportRef?.digest ||
    liveItem.subject.repositoryId !== liveItem.repositoryId ||
    liveItem.subject.workItemId !== liveItem.id ||
    liveItem.subject.revisionKey !== liveContext.target.revisionKey ||
    liveItem.state !== liveContext.target.state ||
    (liveItem.subject.kind === "original_pr" &&
      liveItem.subject.headSha !== liveContext.target.headSha)
  )
    throw new Error(
      "The refreshed source or action context does not match this report's destination and actor. Refresh the report before preparing an action.",
    );
  if (
    !allowSourceRefresh &&
    (liveItem.subject.id !== savedItem.subject.id ||
      liveItem.subject.kind !== savedItem.subject.kind ||
      liveItem.subject.revisionKey !== savedItem.subject.revisionKey ||
      liveItem.state !== savedItem.state ||
      liveContext.target.state !== savedContext.target.state ||
      liveContext.target.revisionKey !== savedContext.target.revisionKey ||
      liveContext.target.headSha !== savedContext.target.headSha)
  )
    throw new Error(
      "The source changed since this form was opened. Refresh the action context and review the updated source before preparing.",
    );
}

function PreviewFields({ fields }: { fields: readonly (readonly [string, ReactNode])[] }) {
  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "minmax(120px, 0.35fr) minmax(0, 1fr)" },
        columnGap: 2,
        rowGap: 1,
        m: 0,
      }}
    >
      {fields.map(([label, value]) => (
        <Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body2"
            sx={{ m: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
          >
            {value}
          </Typography>
        </Fragment>
      ))}
    </Box>
  );
}

function ExactText({ children, empty }: { children: string; empty: string }) {
  return children.length > 0 ? (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 2,
        borderRadius: 2,
        bgcolor: "action.hover",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        fontFamily: "inherit",
        fontSize: "0.875rem",
        lineHeight: 1.6,
      }}
    >
      {children}
    </Box>
  ) : (
    <Typography variant="body2" color="text.secondary">
      {empty}
    </Typography>
  );
}

function reportReference(reference: InvestigationActionIntentV1["reportRef"]): string {
  return reference
    ? `${reference.id} · Version ${reference.version} · ${reference.digest}`
    : "None";
}

export function ExactActionPreview({
  intent,
  destination,
}: {
  intent: InvestigationActionIntentV1;
  destination?: string;
}) {
  const payload = intent.payload;
  return (
    <Stack spacing={2}>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <Chip
          size="small"
          color={
            intent.state === "succeeded"
              ? "success"
              : intent.state === "failed"
                ? "error"
                : intent.state === "unknown"
                  ? "warning"
                  : "default"
          }
          label={intent.state}
        />
        <Typography variant="subtitle1">{actionLabels[intent.action]}</Typography>
      </Stack>
      <PreviewFields
        fields={[
          ...(destination ? [["Destination", destination] as const] : []),
          ["Repository", intent.repositoryId],
          ["Work item", intent.workItemId],
          ["Subject", intent.subjectRef],
          ["Expected head SHA", intent.expectedHeadSha ?? "None · issue snapshot"],
        ]}
      />
      <Divider />
      {payload.kind === "feedback" && (
        <Stack spacing={2}>
          <Typography variant="subtitle2">Additional comment</Typography>
          <ExactText empty="No additional comment.">{payload.body}</ExactText>
          <Typography variant="subtitle2">
            Selected feedback · {payload.drafts.length} drafts
          </Typography>
          {payload.drafts.map((draft, index) => (
            <Box key={draft.id} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Draft {index + 1} · {draft.id}
              </Typography>
              <ExactText empty="Empty draft body.">{draft.body}</ExactText>
              {draft.suggestion && (
                <Stack spacing={1.5} sx={{ mt: 2 }}>
                  <Typography variant="subtitle2">Code suggestion</Typography>
                  <PreviewFields
                    fields={[
                      ["File", draft.suggestion.path],
                      ["Lines", `${draft.suggestion.startLine}–${draft.suggestion.endLine}`],
                      ["Subject", draft.suggestion.subjectRef],
                      ["Head SHA", draft.suggestion.headSha],
                      ["Original content digest", draft.suggestion.originalContentDigest],
                    ]}
                  />
                  <Typography variant="body2" color="text.secondary">
                    Exact replacement
                  </Typography>
                  <ExactText empty="Empty replacement · removes the selected content.">
                    {draft.suggestion.replacement}
                  </ExactText>
                </Stack>
              )}
            </Box>
          ))}
          <PreviewFields
            fields={[
              ["Finding IDs", payload.findingIds.length ? payload.findingIds.join("\n") : "None"],
            ]}
          />
        </Stack>
      )}
      {payload.kind === "task" && (
        <PreviewFields
          fields={[
            ["Task kind", payload.taskKind],
            ["Plan", payload.planRef.id],
            ["Plan version", payload.planRef.version],
            ["Plan digest", payload.planRef.digest],
            [
              "Exact source commit",
              payload.sourceCommit ?? "Not supplied · retained source binding applies",
            ],
          ]}
        />
      )}
      {payload.kind === "close" && (
        <PreviewFields
          fields={[
            ["Close reason", payload.reason],
            [
              "Original issue number",
              payload.duplicateNumber === null ? "None" : `#${payload.duplicateNumber}`,
            ],
          ]}
        />
      )}
      {payload.kind === "merge" && (
        <Stack spacing={2}>
          <PreviewFields fields={[["Merge method", payload.method]]} />
          <Typography variant="subtitle2">Commit title</Typography>
          <ExactText empty="No custom commit title.">{payload.commitTitle}</ExactText>
        </Stack>
      )}
      {payload.kind === "trigger-ci" && (
        <Stack spacing={2}>
          <PreviewFields
            fields={[
              ["Workflow", payload.workflowId],
              ["Exact ref", payload.ref],
            ]}
          />
          <Typography variant="subtitle2">Workflow inputs</Typography>
          {Object.keys(payload.inputs).length ? (
            <PreviewFields fields={Object.entries(payload.inputs)} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              No workflow inputs.
            </Typography>
          )}
        </Stack>
      )}
      {payload.kind === "create-pr" && (
        <Stack spacing={2}>
          <PreviewFields
            fields={[
              ["Pull request state", payload.draft ? "Draft" : "Open"],
              ["Verified branch subject", payload.branchSubjectRef],
              ["Base branch", payload.baseBranch],
              ["Title", payload.title],
            ]}
          />
          <Typography variant="subtitle2">Pull request body</Typography>
          <ExactText empty="No pull request body.">{payload.body}</ExactText>
        </Stack>
      )}
      {payload.kind === "navigate" && (
        <PreviewFields
          fields={[
            ["Report", reportReference(payload.reportRef)],
            ["Artifact", payload.artifactRef ?? "None"],
          ]}
        />
      )}
      <Box component="details">
        <Typography component="summary" variant="subtitle2" sx={{ cursor: "pointer" }}>
          Saved identity and provenance
        </Typography>
        <Box sx={{ mt: 1.5 }}>
          <PreviewFields
            fields={[
              ["Preview ID", intent.id],
              ["Version", intent.version],
              ["Payload digest", intent.payloadDigest],
              ["Request key", intent.idempotencyKey],
              ["Actor", intent.actorId],
              ["Source revision", intent.expectedRevisionKey],
              ["Report", reportReference(intent.reportRef)],
              ["Created", intent.createdAt],
              ["Confirmed", intent.confirmedAt ?? "Not confirmed"],
              ["External result", intent.result?.externalId ?? "None"],
            ]}
          />
        </Box>
        <Typography variant="caption" component="p" color="text.secondary">
          Closing this preview or discarding form edits keeps this submission identity.
        </Typography>
      </Box>
      <Box component="details">
        <Typography component="summary" variant="subtitle2" sx={{ cursor: "pointer" }}>
          All server checks · {intent.guards.length}
        </Typography>
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {intent.guards.map((guard) => (
            <Alert key={guard.code} severity={guard.satisfied ? "success" : "warning"}>
              <Typography variant="subtitle2">
                {guard.code} · {guard.satisfied ? "Satisfied" : "Not satisfied"}
              </Typography>
              {guard.message}
            </Alert>
          ))}
        </Stack>
      </Box>
      <Box component="details">
        <Typography component="summary" variant="subtitle2" sx={{ cursor: "pointer" }}>
          Raw server intent
        </Typography>
        <Box sx={{ mt: 1.5 }}>
          <ExactText empty="No server intent.">{JSON.stringify(intent, null, 2)}</ExactText>
        </Box>
      </Box>
    </Stack>
  );
}

export function ActionPanel({
  workItem,
  context,
  result,
  selection,
  dispatch,
  editedBodies,
  onBusyChange,
  onSaveDraft,
  guardScope,
}: {
  workItem: WorkItem;
  context: ActionContextV1;
  result?: InvestigationResultV1;
  selection: FeedbackSelectionState<InvestigationActionKind>;
  dispatch: (event: FeedbackSelectionEvent<InvestigationActionKind>) => void;
  editedBodies: Record<string, string>;
  onBusyChange?: (busy: boolean) => void;
  onSaveDraft?: () => void;
  guardScope?: string;
}) {
  const queryClient = useQueryClient();
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const reportId = context.reportRef?.id;
  const reportVersion = context.reportRef?.version;
  const reportDigest = context.reportRef?.digest;
  const key = useMemo(
    () =>
      actionDraftKey(
        identity,
        workItem.repositoryId,
        workItem.id,
        reportId !== undefined && reportVersion !== undefined && reportDigest !== undefined
          ? { id: reportId, version: reportVersion, digest: reportDigest }
          : null,
      ),
    [identity, workItem.repositoryId, workItem.id, reportId, reportVersion, reportDigest],
  );
  const { data: draft } = useQuery({
    queryKey: key,
    queryFn: createActionDraft,
    initialData: createActionDraft,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const {
    nextActionId,
    body,
    mergeMethod,
    commitTitle,
    closeReason,
    duplicateNumber,
    workflowId,
    workflowRef,
    workflowInputs,
    branchSubjectRef,
    prTitle,
    baseBranch,
    sourceCommit,
  } = draft.fields;
  const intent = draft.intent;
  const repositoryName =
    result?.context.repository.id === workItem.repositoryId
      ? result.context.repository.fullName
      : workItem.repositoryId;
  const destination = `${repositoryName} · ${workItem.kind === "pull_request" ? "Pull request" : "Issue"} #${workItem.number}`;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  useEffect(() => {
    // Only the current draft scope may reset transient UI after a key transition.
    // The render-time assignment already invalidates callbacks from the previous scope.
    if (currentKey.current !== key) return;
    sequence.current += 1;
    busyRef.current = false;
    setBusy(false);
    setPreviewOpen(false);
    setError(undefined);
  }, [key]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );
  const updateDraft = (change: (record: ActionDraftRecord) => ActionDraftRecord) =>
    actionDraftLease(queryClient, key).update(change);
  const setField = <Field extends keyof ActionDraftFields>(
    field: Field,
    value: ActionDraftFields[Field],
  ) => {
    updateDraft((record) => ({ ...record, fields: { ...record.fields, [field]: value } }));
  };
  const discard = () => {
    updateDraft(discardActionDraft);
    setError(undefined);
  };
  const dirty = actionDraftIsDirty(draft);
  useUnsavedChanges(dirty, {
    scope: guardScope,
    busy,
    allowPresentationNavigation: true,
    description: "The action form has unsaved edits. Saved submission identities are retained.",
    onDiscard: discard,
  });
  const submissionUnresolved = hasUnresolvedActionSubmission(draft);
  const preparationUnresolved = hasUnresolvedActionPreparation(draft);
  const anotherSubmissionUnresolved =
    submissionUnresolved && intent !== null && intent.id !== context.pendingSubmission?.intentId;
  const intentMatchesContext = Boolean(intent && actionIntentMatchesContext(intent, context));
  const hasExecutionPermission = Boolean(
    intent &&
      session.user?.permissions.includes("action:execute") &&
      session.user.actionCapabilities.includes(intent.action),
  );
  const canExecuteIntent = Boolean(
    intent &&
      intentMatchesContext &&
      !draft.confirmationUncertain &&
      !draft.contextRefreshRequired &&
      !context.pendingSubmission &&
      hasExecutionPermission,
  );
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
    setField("nextActionId", proposalId);
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
    if (
      busyRef.current ||
      (submissionUnresolved && !preparationUnresolved) ||
      ((context.pendingSubmission || draft.contextRefreshRequired) && !preparationUnresolved)
    )
      return;
    const lease = actionDraftLease(queryClient, key);
    if (!lease.isCurrent()) return;
    const requestSequence = ++sequence.current;
    const active = () =>
      mounted.current &&
      currentKey.current === key &&
      sequence.current === requestSequence &&
      lease.isCurrent();
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      let request: PrepareActionInput;
      if (preparationUnresolved && draft.prepareRequest) {
        request = draft.prepareRequest;
      } else {
        const payload = makePayload();
        let liveContext: ActionContextV1;
        let liveItem: WorkItem;
        try {
          [liveContext, liveItem] = await Promise.all([
            investigationApi.actionContext(workItem.id, context.reportRef?.id),
            investigationApi.workItem(workItem.id),
          ]);
          if (!active()) return;
          assertActionPreparationBindings(workItem, context, liveItem, liveContext);
          if (
            !action ||
            liveContext.pendingSubmission ||
            !isActionAllowed(liveContext, action, proposal?.id)
          )
            throw new Error(
              "This operation is not allowed by the current server context. Refresh the action context to review its checks.",
            );
          if (proposal) {
            const liveProposal = liveContext.nextActions.find(
              (item) => item.id === proposal.id && item.action === action,
            );
            if (
              !liveProposal ||
              liveProposal.subjectRef !== proposal.subjectRef ||
              liveProposal.planRef?.id !== proposal.planRef?.id ||
              liveProposal.planRef?.version !== proposal.planRef?.version ||
              liveProposal.planRef?.digest !== proposal.planRef?.digest ||
              liveProposal.taskKind !== proposal.taskKind ||
              liveProposal.draftRef !== proposal.draftRef
            )
              throw new Error(
                "The saved next action changed. Refresh the action context before preparing.",
              );
          }
        } catch (cause) {
          if (active()) lease.update((record) => ({ ...record, contextRefreshRequired: true }));
          throw cause;
        }
        if (!action) return;
        request = {
          workItemId: workItem.id,
          action,
          ...(proposal ? { nextActionId: proposal.id } : {}),
          reportRef: liveContext.reportRef,
          subjectRef: proposal?.subjectRef ?? liveItem.subject.id,
          expectedRevisionKey: liveContext.target.revisionKey,
          expectedHeadSha: liveContext.target.headSha,
          idempotencyKey: crypto.randomUUID(),
          payload,
        };
        lease.update((record) => beginActionPreparation(record, request));
      }
      const retainedRequest = queryClient.getQueryData<ActionDraftRecord>(key)?.prepareRequest;
      if (!retainedRequest || !lease.isCurrent()) return;
      const prepared = await investigationApi.prepareAction(structuredClone(retainedRequest));
      if (!active()) return;
      if (prepared.repositoryId !== workItem.repositoryId)
        throw new Error("The prepared action belongs to a different repository.");
      lease.update((record) => acceptPreparedAction(record, prepared));
      setPreviewOpen(true);
    } catch (cause) {
      if (active()) {
        if (
          cause instanceof InvestigationHttpError &&
          [400, 403, 404, 409, 422].includes(cause.status)
        )
          lease.update((record) => ({
            ...record,
            preparationRejected: true,
            contextRefreshRequired: cause.status === 409 || record.contextRefreshRequired,
          }));
        setError(cause instanceof Error ? cause.message : "The operation could not be prepared.");
      }
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const updateIntent = async (operation: "confirm" | "refresh" | "reconcile") => {
    if (!intent || busyRef.current) return;
    if (
      operation === "confirm" &&
      (intent.state !== "prepared" ||
        !canExecuteIntent ||
        intent.guards.some((guard) => !guard.satisfied))
    )
      return;
    const lease = actionDraftLease(queryClient, key);
    if (!lease.isCurrent()) return;
    const requestSequence = ++sequence.current;
    const active = () =>
      mounted.current &&
      currentKey.current === key &&
      sequence.current === requestSequence &&
      lease.isCurrent();
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (
        operation === "confirm" &&
        !lease.update((record) => beginActionConfirmation(record, intent))
      )
        return;
      const next =
        operation === "confirm"
          ? await investigationApi.confirmAction(intent.id, intent.version, intent.payloadDigest)
          : operation === "reconcile"
            ? await investigationApi.reconcileAction(intent.id)
            : await investigationApi.actionIntent(intent.id);
      if (!active()) return;
      lease.update((record) =>
        operation !== "confirm" && !draft.confirmationUncertain && record.confirmationUncertain
          ? record
          : retainActionIntent(record, next),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["investigation-action-context"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-work-item"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-work-items"] }),
      ]);
      if (!active()) return;
      await queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] });
    } catch (cause) {
      if (active())
        setError(
          cause instanceof Error
            ? cause.message
            : "The operation status is unavailable. Recheck the saved intent before retrying.",
        );
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const refreshActionContext = async () => {
    if (busyRef.current) return;
    const lease = actionDraftLease(queryClient, key);
    if (!lease.isCurrent()) return;
    const requestSequence = ++sequence.current;
    const active = () =>
      mounted.current &&
      currentKey.current === key &&
      sequence.current === requestSequence &&
      lease.isCurrent();
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const [liveContext, liveItem] = await Promise.all([
        investigationApi.actionContext(workItem.id, context.reportRef?.id),
        investigationApi.workItem(workItem.id),
      ]);
      if (!active()) return;
      assertActionPreparationBindings(workItem, context, liveItem, liveContext, true);
      queryClient.setQueriesData<ActionContextV1>(
        { queryKey: ["investigation-action-context"] },
        (saved) =>
          saved?.workItemId === liveContext.workItemId &&
          saved.reportRef?.id === liveContext.reportRef?.id
            ? liveContext
            : saved,
      );
      queryClient.setQueriesData<WorkItem>({ queryKey: ["investigation-work-item"] }, (saved) =>
        saved?.id === liveItem.id && saved.repositoryId === liveItem.repositoryId
          ? liveItem
          : saved,
      );
      lease.update((record) => ({ ...record, contextRefreshRequired: false }));
    } catch (cause) {
      if (active()) {
        lease.update((record) => ({ ...record, contextRefreshRequired: true }));
        setError(
          cause instanceof Error ? cause.message : "The action context could not be refreshed.",
        );
      }
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const inspectPendingSubmission = async () => {
    const pendingId = context.pendingSubmission?.intentId;
    if (!pendingId || busyRef.current || preparationUnresolved || anotherSubmissionUnresolved)
      return;
    const lease = actionDraftLease(queryClient, key);
    if (!lease.isCurrent()) return;
    const requestSequence = ++sequence.current;
    const active = () =>
      mounted.current &&
      currentKey.current === key &&
      sequence.current === requestSequence &&
      lease.isCurrent();
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const pending = await investigationApi.actionIntent(pendingId);
      if (!active()) return;
      if (
        pending.id !== pendingId ||
        pending.workItemId !== workItem.id ||
        pending.repositoryId !== workItem.repositoryId
      )
        throw new Error("The pending submission does not belong to this work item.");
      lease.update((record) => inspectActionIntent(record, pending));
      setPreviewOpen(true);
    } catch (cause) {
      if (active())
        setError(cause instanceof Error ? cause.message : "Could not load the pending submission.");
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Box>
      <Stack
        direction="row"
        useFlexGap
        spacing={1}
        sx={{ alignItems: "center", flexWrap: "wrap", mb: 1 }}
      >
        <Typography variant="subtitle1" sx={{ overflowWrap: "anywhere" }}>
          {destination}
        </Typography>
        <Chip size="small" label={workItem.state} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, overflowWrap: "anywhere" }}>
        {workItem.title}
      </Typography>
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
            disabled={busy || preparationUnresolved || anotherSubmissionUnresolved}
            onClick={() => void inspectPendingSubmission()}
          >
            Inspect previous submission
          </Button>
          {(preparationUnresolved || anotherSubmissionUnresolved) && (
            <Typography variant="body2">
              Resolve the locally saved request before inspecting a different submission.
            </Typography>
          )}
        </Alert>
      )}
      {preparationUnresolved && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The preparation response is not confirmed. Recover the exact saved request before
          preparing another action. Its content and request key are retained across navigation.
          <Button disabled={busy} onClick={() => void prepare()}>
            Recover saved preparation
          </Button>
          <Typography variant="caption" component="div" sx={{ overflowWrap: "anywhere" }}>
            Request key: {draft.prepareRequest?.idempotencyKey}
          </Typography>
        </Alert>
      )}
      {intent && (
        <Alert severity={submissionUnresolved ? "warning" : "info"} sx={{ mb: 2 }}>
          {submissionUnresolved
            ? "Check the saved submission before preparing another action."
            : "Your exact server preview is saved in this session."}
          <Button disabled={busy} onClick={() => setPreviewOpen(true)}>
            Open saved preview
          </Button>
        </Alert>
      )}
      {draft.contextRefreshRequired && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The source or action context needs a fresh review before a new preparation. Your draft is
          retained.
          <Button disabled={busy} onClick={() => void refreshActionContext()}>
            Refresh action context
          </Button>
        </Alert>
      )}
      <Box
        component="fieldset"
        aria-label="Action preparation form"
        disabled={busy || submissionUnresolved}
        sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}
      >
        {context.nextActions.length > 0 && (
          <Box component="details" sx={{ mb: 2 }}>
            <Typography component="summary" variant="subtitle2" sx={{ cursor: "pointer" }}>
              Saved next actions · {context.nextActions.length}
            </Typography>
            <Stack spacing={1} sx={{ mt: 1.5 }}>
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
        <TextField
          select
          fullWidth
          label="Operation"
          value={
            !proposal && context.fixedActions.some((item) => item.action === action) ? action : ""
          }
          onChange={(event) => selectAction(event.target.value as InvestigationActionKind)}
          helperText={
            proposal
              ? `Saved next action: ${proposal.label}`
              : "The server determines which operations are available."
          }
        >
          <MenuItem value="" disabled>
            {proposal ? "Saved next action selected" : "Choose an operation"}
          </MenuItem>
          {context.fixedActions.map((item) => (
            <MenuItem
              key={item.action}
              value={item.action}
              disabled={!isActionAllowed(context, item.action)}
            >
              {actionLabels[item.action]}
            </MenuItem>
          ))}
        </TextField>
        <Box component="details" sx={{ mt: 1.5 }}>
          <Typography
            component="summary"
            variant="body2"
            color="text.secondary"
            sx={{ cursor: "pointer" }}
          >
            Operation availability and checks
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1.5 }}>
            {context.fixedActions.map((item) => (
              <Box key={item.action}>
                <Typography variant="subtitle2">
                  {actionLabels[item.action]} ·{" "}
                  {isActionAllowed(context, item.action) ? "Available" : "Unavailable"}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {item.reason}
                </Typography>
                <TextList
                  items={item.guards.map(
                    (guard) =>
                      `${guard.satisfied ? "Satisfied" : "Not satisfied"}: ${guard.message}`,
                  )}
                />
              </Box>
            ))}
          </Stack>
        </Box>
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
                setField("nextActionId", undefined);
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
              onChange={(event) => setField("sourceCommit", event.target.value.trim())}
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
            onChange={(event) => setField("body", event.target.value)}
            fullWidth
            helperText="The preview includes this text, selected finding drafts, and selected independent drafts."
          />
        )}
        {action === "close" && (
          <TextField
            select
            fullWidth
            label="Close reason"
            value={closeReason}
            onChange={(event) =>
              setField("closeReason", event.target.value as "completed" | "not_planned")
            }
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
            onChange={(event) => setField("duplicateNumber", event.target.value)}
          />
        )}
        {action === "merge" && (
          <Stack spacing={2}>
            <TextField
              select
              label="Merge method"
              value={mergeMethod}
              onChange={(event) =>
                setField("mergeMethod", event.target.value as "merge" | "squash" | "rebase")
              }
            >
              <MenuItem value="squash">Squash</MenuItem>
              <MenuItem value="merge">Merge commit</MenuItem>
              <MenuItem value="rebase">Rebase</MenuItem>
            </TextField>
            <TextField
              label="Commit title"
              value={commitTitle}
              onChange={(event) => setField("commitTitle", event.target.value)}
            />
          </Stack>
        )}
        {action === "trigger-ci" && (
          <Stack spacing={2}>
            <TextField
              label="Workflow ID or file name"
              value={workflowId}
              onChange={(event) => setField("workflowId", event.target.value)}
            />
            <TextField
              label="Exact workflow ref"
              value={workflowRef}
              onChange={(event) => setField("workflowRef", event.target.value)}
            />
            <TextField
              label="Workflow inputs (JSON)"
              multiline
              minRows={3}
              value={workflowInputs}
              onChange={(event) => setField("workflowInputs", event.target.value)}
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
              onChange={(event) => setField("branchSubjectRef", event.target.value)}
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
              onChange={(event) => setField("prTitle", event.target.value)}
            />
            <TextField
              label="Base branch"
              value={baseBranch}
              onChange={(event) => setField("baseBranch", event.target.value)}
            />
            <TextField
              multiline
              label="Pull request body"
              minRows={3}
              value={body}
              onChange={(event) => setField("body", event.target.value)}
            />
          </Stack>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Box>
      <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap", mt: 2 }}>
        <Button
          disabled={busy}
          onClick={() => {
            if (updateDraft(saveActionDraft)) onSaveDraft?.();
          }}
        >
          Save private draft
        </Button>
        <Button disabled={!dirty || busy} onClick={discard}>
          Discard form edits
        </Button>
      </Stack>
      <Button
        variant="contained"
        disabled={
          !allowed ||
          !feedbackReady ||
          busy ||
          submissionUnresolved ||
          draft.contextRefreshRequired ||
          Boolean(context.pendingSubmission) ||
          (action !== null && navigationActions.has(action)) ||
          ((action === "start-task" || action === "reviews.verify") && !plan)
        }
        onClick={() => void prepare()}
        sx={{ mt: 2 }}
      >
        {busy ? "Working…" : "Prepare preview"}
      </Button>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 1 }}>
        Preparing saves an exact preview. Execution requires a separate confirmation and fresh
        server checks. Private drafts are kept only for this signed-in session.
      </Typography>
      <Dialog
        open={previewOpen && Boolean(intent)}
        onClose={() => {
          if (!busy) setPreviewOpen(false);
        }}
        fullWidth
        maxWidth="md"
        aria-labelledby="action-preview-title"
        aria-describedby="action-preview-description"
      >
        <DialogTitle id="action-preview-title">
          {intent ? `Review ${actionLabels[intent.action]}` : "Action preview"}
        </DialogTitle>
        <DialogContent dividers>
          {intent && (
            <Stack spacing={2}>
              <Typography id="action-preview-description" variant="body2" color="text.secondary">
                This is the exact content and destination returned by the server. Confirming
                executes this saved preview after the server checks its current guards.
              </Typography>
              <ExactActionPreview
                intent={intent}
                destination={
                  intent.workItemId === workItem.id && intent.repositoryId === workItem.repositoryId
                    ? destination
                    : undefined
                }
              />
              {draft.contextRefreshRequired && (
                <Alert severity="warning">
                  Refresh the current action context before confirming this saved preview.
                  <Button disabled={busy} onClick={() => void refreshActionContext()}>
                    Refresh action context
                  </Button>
                </Alert>
              )}
              {!intentMatchesContext && intent.state === "prepared" && (
                <Alert severity="warning">
                  The source, report, or actor changed since this preview was saved. Prepare a new
                  preview from the current context before confirming.
                </Alert>
              )}
              {intent.state === "prepared" && !hasExecutionPermission && (
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
              {(intent.state === "unknown" || draft.confirmationUncertain) && (
                <Alert severity="warning">
                  The previous submission has no confirmed outcome. Refresh or reconcile the saved
                  submission before creating another one.
                </Alert>
              )}
              {error && <Alert severity="error">{error}</Alert>}
              {intent.result?.taskId && (
                <Button
                  component={Link}
                  to={`/tasks?taskId=${encodeURIComponent(intent.result.taskId)}&repositoryId=${encodeURIComponent(intent.repositoryId)}`}
                >
                  Open linked task
                </Button>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setPreviewOpen(false)}>
            Close preview
          </Button>
          {intent && ["unknown", "executing"].includes(intent.state) && (
            <Button disabled={busy} onClick={() => void updateIntent("reconcile")}>
              Reconcile submission
            </Button>
          )}
          {intent &&
            (["confirmed", "executing", "unknown"].includes(intent.state) ||
              draft.confirmationUncertain) && (
              <Button disabled={busy} onClick={() => void updateIntent("refresh")}>
                Refresh status
              </Button>
            )}
          {intent?.state === "prepared" && !draft.confirmationUncertain && (
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
    </Box>
  );
}
