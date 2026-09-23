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
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  savedDuplicateTarget,
  savedPlanSubject,
  savedSubjectDescription,
} from "./action-composer-source";
import {
  type ActionDraftFields,
  type ActionDraftRecord,
  acceptPreparedAction,
  actionDraftIsDirty,
  actionDraftKey,
  actionDraftLease,
  actionFormIsDirty,
  beginActionConfirmation,
  beginActionPreparation,
  createActionDraft,
  discardActionDraft,
  hasUnresolvedActionPreparation,
  hasUnresolvedActionSubmission,
  inspectActionIntent,
  retainActionIntent,
  saveActionDraft,
  switchActionDraft,
} from "./action-draft-store";
import { investigationApi, type PrepareActionInput, type WorkItem } from "./api";
import type { FeedbackSelectionEvent, FeedbackSelectionState } from "./feedback-selection";
import { useUnsavedChanges } from "./navigation-guard";
import {
  importPublicationSelection,
  materializePublication,
  type PublicationComposerDraft,
  setPublicationFinding,
  setPublicationIndependentDraft,
  validatePublication,
} from "./publication-composer";
import { PublicationComposerPanel, type PublicationStep } from "./publication-composer-panel";
import { TextList } from "./report-sections";
import { sessionIdentity, useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

export const actionLabels: Record<InvestigationActionKind, string> = {
  comment: "Conversation comment",
  approve: "Approve",
  "suggestion-comment": "Review comments & suggestions",
  "request-changes": "Request changes",
  close: "Close",
  merge: "Merge",
  "trigger-ci": "Run CI",
  "close-as-duplicate": "Close as duplicate",
  "start-task": "Start linked task",
  "reviews.verify": "Verify PR",
  "view-validation": "View validation",
  "view-changes": "View changes",
  "create-pr": "Create pull request",
  "view-evidence": "View evidence",
  resume: "Resume investigation",
};

export interface ActionPanelRequest {
  /** A new ID represents a deliberate request from the report or saved plan. */
  id: string;
  action?: InvestigationActionKind;
  nextActionId?: string;
  importReportSelection?: boolean;
  sourceCommit?: string;
}

export function actionExecutionAccess(
  user:
    | {
        permissions: readonly string[];
        actionCapabilities: readonly string[];
        allowRepositoryExecution: boolean;
      }
    | null
    | undefined,
  action: InvestigationActionKind | null,
): { allowed: boolean; reason: string | null } {
  if (!action) return { allowed: false, reason: "Choose an operation." };
  const missing: string[] = [];
  if (!user?.permissions.includes("action:execute")) missing.push("Execute actions permission");
  if (!user?.actionCapabilities.includes(action))
    missing.push(`${actionLabels[action]} capability`);
  if (action === "start-task" || action === "reviews.verify") {
    if (!user?.permissions.includes("task:create"))
      missing.push("Create investigations permission");
    if (!user?.allowRepositoryExecution) missing.push("repository execution permission");
  }
  return {
    allowed: missing.length === 0,
    reason: missing.length ? `Execution and reconciliation require ${missing.join(", ")}.` : null,
  };
}

function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPayload(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

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
  result,
}: {
  intent: InvestigationActionIntentV1;
  destination?: string;
  result?: InvestigationResultV1;
}) {
  const payload = intent.payload;
  const previewPlan =
    payload.kind === "task" &&
    result !== undefined &&
    intent.reportRef !== null &&
    result.report.id === intent.reportRef.id &&
    result.report.version === intent.reportRef.version &&
    result.report.logicalContentDigest === intent.reportRef.digest
      ? result.plans.find(
          (plan) =>
            plan.id === payload.planRef.id &&
            plan.version === payload.planRef.version &&
            plan.digest === payload.planRef.digest,
        )
      : undefined;
  const feedbackSummary =
    payload.kind === "feedback"
      ? [
          payload.body,
          ...payload.drafts.filter((draft) => draft.suggestion === null).map((draft) => draft.body),
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
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
          <Typography variant="subtitle2">
            {intent.action === "comment" ? "Conversation comment body" : "Review summary"}
          </Typography>
          <ExactText empty="No additional comment.">{feedbackSummary}</ExactText>
          <Typography variant="body2" color="text.secondary">
            The introduction and text-only findings appear in this summary once. Feedback with a
            code suggestion appears only in its corresponding inline comment below.
          </Typography>
          <Typography variant="subtitle2">
            Selected feedback · {payload.drafts.length}{" "}
            {payload.drafts.length === 1 ? "draft" : "drafts"}
          </Typography>
          {payload.drafts
            .filter((draft) => draft.suggestion !== null)
            .map((draft, index) => (
              <Box key={draft.id} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Inline comment {index + 1} · {draft.id}
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
              [
                "Text draft IDs",
                payload.drafts
                  .filter((draft) => draft.suggestion === null)
                  .map((draft) => draft.id)
                  .join("\n") || "None",
              ],
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
              "Saved plan source",
              previewPlan
                ? savedSubjectDescription(savedPlanSubject(result, previewPlan))
                : `Retained subject · ${intent.subjectRef}`,
            ],
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
  editedBodies,
  onBusyChange,
  guardScope,
  request,
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
  request?: ActionPanelRequest;
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
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [choosingAction, setChoosingAction] = useState(draft.activeAction === null);
  const [importOnChoice, setImportOnChoice] = useState(false);
  const [publicationStep, setPublicationStep] = useState<PublicationStep>("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const summaryFocus = useRef<HTMLButtonElement>(null);
  const handledRequest = useRef<string | null>(null);
  const componentId = useId();
  const fieldId = useCallback(
    (name: string) => `action-${componentId.replaceAll(":", "")}-${encodeURIComponent(name)}`,
    [componentId],
  );
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
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
    setReceiptId(null);
    setChoosingAction(currentDraft.current.activeAction === null);
    setPublicationStep("select");
    setImportOnChoice(false);
    setError(undefined);
    setFieldErrors({});
    handledRequest.current = null;
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
  const clearFieldError = (name: string) =>
    setFieldErrors((current) => {
      if (!Object.hasOwn(current, name)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  const setField = <Field extends keyof ActionDraftFields>(
    field: Field,
    value: ActionDraftFields[Field],
  ) => {
    updateDraft((record) => ({ ...record, fields: { ...record.fields, [field]: value } }));
    clearFieldError(field === "body" ? "summary" : field);
  };
  const discard = () => {
    updateDraft(discardActionDraft);
    setError(undefined);
    setFieldErrors({});
  };
  const dirty = actionDraftIsDirty(draft);
  useUnsavedChanges(dirty, {
    scope: guardScope,
    busy,
    allowPresentationNavigation: true,
    description:
      "Action drafts have unsaved edits. Saved submission identities and receipts are retained.",
    onDiscard: discard,
  });
  const submissionUnresolved = hasUnresolvedActionSubmission(draft);
  const preparationUnresolved = hasUnresolvedActionPreparation(draft);
  const anotherSubmissionUnresolved =
    submissionUnresolved && intent !== null && intent.id !== context.pendingSubmission?.intentId;
  const intentMatchesContext = Boolean(intent && actionIntentMatchesContext(intent, context));
  const executionAccess = actionExecutionAccess(session.user, intent?.action ?? null);
  const hasExecutionPermission = executionAccess.allowed;
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
        (item) => item.id === nextActionId && item.action === draft.activeAction,
      )
    : undefined;
  const proposal = activeNextAction;
  const plan = proposal?.planRef
    ? result?.plans.find(
        (item) =>
          item.id === proposal.planRef?.id &&
          item.version === proposal.planRef.version &&
          item.digest === proposal.planRef.digest,
      )
    : undefined;
  const planSubject = savedPlanSubject(result, plan);
  const needsSourceSelection = workItem.kind === "issue" && planSubject?.kind === "issue_snapshot";
  const duplicateTarget = savedDuplicateTarget(result, workItem);
  const canPrepareActions = session.user?.permissions.includes("action:prepare") === true;
  const action = draft.activeAction;
  const allowed = action !== null && isActionAllowed(context, action, proposal?.id);
  const feedbackAction =
    action !== null &&
    ["comment", "approve", "suggestion-comment", "request-changes"].includes(action);
  const feedbackReady =
    !feedbackAction ||
    (publicationStep === "compose" &&
      (action !== "request-changes" || draft.publication.selectedFindingIds.length > 0));

  const feedbackKinds = new Set<InvestigationActionKind>([
    "comment",
    "approve",
    "request-changes",
    "suggestion-comment",
  ]);
  const choose = (
    selected: InvestigationActionKind,
    proposalId?: string,
    options: { importSelection?: boolean; sourceCommit?: string } = {},
  ) => {
    if (
      busyRef.current ||
      submissionUnresolved ||
      context.pendingSubmission ||
      !canPrepareActions
    ) {
      setError(
        !canPrepareActions
          ? "This account requires Prepare actions permission."
          : "Resolve the saved submission before changing the preparation action.",
      );
      return;
    }
    const suggested = proposalId
      ? context.nextActions.find((item) => item.id === proposalId && item.action === selected)
      : undefined;
    if (!isActionAllowed(context, selected, proposalId)) {
      setError(
        suggested?.reason ??
          context.fixedActions.find((item) => item.action === selected)?.reason ??
          "This operation is unavailable in the current server context.",
      );
      return;
    }
    updateDraft((record) => {
      const next = switchActionDraft(record, selected);
      const fields = { ...next.fields, nextActionId: proposalId };
      const selectedPlan = suggested?.planRef
        ? result?.plans.find(
            (plan) =>
              plan.id === suggested.planRef?.id &&
              plan.version === suggested.planRef.version &&
              plan.digest === suggested.planRef.digest,
          )
        : undefined;
      if (
        options.sourceCommit !== undefined &&
        workItem.kind === "issue" &&
        savedPlanSubject(result, selectedPlan)?.kind === "issue_snapshot"
      )
        fields.sourceCommit = options.sourceCommit;
      if (selected === "close-as-duplicate")
        fields.duplicateNumber = duplicateTarget ? String(duplicateTarget.number) : "";
      if (selected === "trigger-ci" && !fields.workflowRef && context.target.headSha)
        fields.workflowRef = context.target.headSha;
      let publication = next.publication;
      if (options.importSelection && feedbackKinds.has(selected))
        publication = importPublicationSelection(
          publication,
          selection,
          result,
          editedBodies,
          selected,
        );
      if (suggested?.draftRef && feedbackKinds.has(selected)) {
        const finding = result?.findings.find(
          (item) => item.feedbackDraft.id === suggested.draftRef,
        );
        if (finding)
          publication = setPublicationFinding(
            publication,
            finding.id,
            true,
            result,
            editedBodies,
            selected,
          );
        else if (result?.feedbackDrafts.some((item) => item.id === suggested.draftRef))
          publication = setPublicationIndependentDraft(
            publication,
            suggested.draftRef,
            true,
            result,
            editedBodies,
            selected,
          );
      }
      return { ...next, fields, publication };
    });
    setChoosingAction(false);
    setImportOnChoice(false);
    setPublicationStep(options.importSelection ? "compose" : "select");
    setError(undefined);
    setFieldErrors({});
    if (feedbackKinds.has(selected))
      requestAnimationFrame(() => {
        document.getElementById(fieldId("publication-step"))?.scrollIntoView({ block: "start" });
        document
          .getElementById(fieldId(options.importSelection ? "step-back" : "show"))
          ?.focus({ preventScroll: true });
      });
  };
  const selectAction = (selected: InvestigationActionKind, proposalId?: string) => {
    if (request) handledRequest.current = request.id;
    choose(selected, proposalId, { importSelection: importOnChoice });
  };
  // Requests are nonce-driven commands, but must use the latest bindings and grants.
  const currentChoose = useRef(choose);
  currentChoose.current = choose;
  useEffect(() => {
    if (currentKey.current !== key) return;
    if (!request || handledRequest.current === request.id) return;
    const requestedPlan = request.nextActionId
      ? context.nextActions.find((item) => item.id === request.nextActionId)
      : undefined;
    if (
      !result &&
      (request.importReportSelection || requestedPlan?.planRef || requestedPlan?.draftRef)
    )
      return;
    handledRequest.current = request.id;
    if (request.action)
      currentChoose.current(request.action, request.nextActionId, {
        importSelection: request.importReportSelection,
        sourceCommit: request.sourceCommit,
      });
    else {
      setChoosingAction(true);
      setImportOnChoice(Boolean(request.importReportSelection));
      setFieldErrors({});
    }
    // A nonce is a deliberate request; later report edits must not replay its import.
  }, [key, request, result, context.nextActions]);
  const updatePublication = (publication: PublicationComposerDraft) =>
    updateDraft((record) => ({ ...record, publication }));
  const makePayload = (): InvestigationActionPayload => {
    if (!action) throw new Error("Select an operation to prepare.");
    if (feedbackAction)
      return materializePublication(draft.publication, result, context, action, body, editedBodies);
    if (action === "start-task" || action === "reviews.verify") {
      if (!proposal?.planRef || !proposal.taskKind || !plan || !planSubject)
        throw new Error(
          "This action requires its exact saved plan. Load the report details and refresh the action context.",
        );
      if (needsSourceSelection && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sourceCommit))
        throw new Error("Enter the full hexadecimal source commit SHA.");
      return {
        kind: "task",
        taskKind: proposal.taskKind,
        planRef: proposal.planRef,
        ...(needsSourceSelection ? { sourceCommit: sourceCommit.toLowerCase() } : {}),
      };
    }
    if (action === "close" || action === "close-as-duplicate") {
      if (action === "close-as-duplicate" && !duplicateTarget)
        throw new Error(
          "The saved report does not identify a valid other Issue in this repository.",
        );
      return {
        kind: "close",
        reason:
          action === "close-as-duplicate"
            ? "duplicate"
            : workItem.kind === "pull_request"
              ? "not_planned"
              : closeReason,
        duplicateNumber: action === "close-as-duplicate" ? duplicateTarget!.number : null,
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
        Object.values(inputs).some((value) => typeof value !== "string") ||
        Object.keys(inputs).length > 25
      )
        throw new Error(
          "Supply a workflow, an exact ref, and a JSON object containing string inputs.",
        );
      return {
        kind: "trigger-ci",
        workflowId: workflowId.trim(),
        ref: workflowRef.trim(),
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
  const validateForm = (): Record<string, string> => {
    if (!action) return { operation: "Choose an operation." };
    if (feedbackAction)
      return validatePublication(draft.publication, result, context, action, body, editedBodies);
    const errors: Record<string, string> = {};
    if (action === "start-task" || action === "reviews.verify") {
      if (!plan || !planSubject || !proposal?.planRef || !proposal.taskKind)
        errors.operation = "Choose an available saved plan with its exact version and digest.";
      if (needsSourceSelection && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sourceCommit))
        errors.sourceCommit = "Enter a full 40- or 64-character hexadecimal source commit SHA.";
    }
    if (action === "close-as-duplicate" && !duplicateTarget)
      errors.duplicateNumber =
        "Choose the original Issue recorded in this report's duplicate assessment.";
    if (action === "trigger-ci") {
      if (!/^[A-Za-z0-9_.-]+$/u.test(workflowId.trim()))
        errors.workflowId =
          "Enter a workflow ID or filename using letters, numbers, dots, underscores or hyphens.";
      if (!workflowRef.trim())
        errors.workflowRef =
          "Enter an exact workflow ref. The server must resolve it to the reviewed head.";
      try {
        const parsed: unknown = JSON.parse(workflowInputs);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((value) => typeof value !== "string") ||
          Object.keys(parsed).length > 25
        )
          errors.workflowInputs = "Use a JSON object with at most 25 string input values.";
      } catch {
        errors.workflowInputs = 'Enter valid JSON, for example {"inputName":"value"}.';
      }
    }
    if (action === "create-pr") {
      if (
        !result?.context.subjects.some(
          (subject) => subject.id === branchSubjectRef && subject.kind === "remote_branch",
        )
      )
        errors.branchSubjectRef = "Choose a verified remote branch from this saved report.";
      if (!prTitle.trim()) errors.prTitle = "Enter a pull request title.";
      if (!baseBranch.trim()) errors.baseBranch = "Enter the base branch.";
    }
    return errors;
  };
  const focusField = (name: string) => {
    if (name === "operation") setChoosingAction(true);
    else if (name === "selection") setPublicationStep("select");
    else if (name.startsWith("draft-") || name === "summary") setPublicationStep("compose");
    requestAnimationFrame(() => {
      const target = document.getElementById(fieldId(name));
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
  };
  let currentPayload: InvestigationActionPayload | null = null;
  try {
    if (
      action &&
      draft.receipts.some((receipt) => receipt.state === "succeeded" && receipt.action === action)
    )
      currentPayload = makePayload();
  } catch {
    /* Incomplete fields are validated on preparation. */
  }
  const duplicateReceipt =
    currentPayload &&
    [...draft.receipts]
      .reverse()
      .find(
        (receipt) =>
          receipt.state === "succeeded" &&
          receipt.action === action &&
          actionIntentMatchesContext(receipt, context) &&
          canonicalPayload(receipt.payload) === canonicalPayload(currentPayload),
      );
  const receiptCandidate = receiptId
    ? (draft.receipts.find((receipt) => receipt.id === receiptId) ?? null)
    : intent;
  const previewIntent =
    receiptCandidate?.actorId === context.actor.id &&
    receiptCandidate.repositoryId === workItem.repositoryId &&
    receiptCandidate.workItemId === workItem.id
      ? receiptCandidate
      : null;
  const lastReceipt = [...draft.receipts]
    .reverse()
    .find(
      (receipt) =>
        receipt.actorId === context.actor.id &&
        receipt.repositoryId === workItem.repositoryId &&
        receipt.workItemId === workItem.id,
    );
  const repeatedPreview =
    intent &&
    draft.receipts.some(
      (receipt) =>
        receipt.id !== intent.id &&
        receipt.state === "succeeded" &&
        receipt.action === intent.action &&
        actionIntentMatchesContext(receipt, context) &&
        canonicalPayload(receipt.payload) === canonicalPayload(intent.payload),
    );
  const prepare = async () => {
    if (
      busyRef.current ||
      !canPrepareActions ||
      (submissionUnresolved && !preparationUnresolved) ||
      ((context.pendingSubmission || draft.contextRefreshRequired) && !preparationUnresolved)
    )
      return;
    if (!preparationUnresolved) {
      const errors = validateForm();
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        setError(undefined);
        requestAnimationFrame(() => {
          summaryFocus.current?.focus();
          summaryFocus.current?.scrollIntoView({ block: "nearest" });
        });
        return;
      }
    }
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
    setFieldErrors({});
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
      if (prepared.repositoryId !== workItem.repositoryId || prepared.actorId !== context.actor.id)
        throw new Error("The prepared action belongs to a different repository or actor.");
      lease.update((record) => acceptPreparedAction(record, prepared));
      setReceiptId(null);
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
    if (
      !intent ||
      busyRef.current ||
      intent.actorId !== context.actor.id ||
      intent.repositoryId !== workItem.repositoryId ||
      intent.workItemId !== workItem.id
    )
      return;
    if (operation === "reconcile" && !hasExecutionPermission) {
      setError(`${executionAccess.reason} You can still refresh the saved intent as its owner.`);
      return;
    }
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
        pending.repositoryId !== workItem.repositoryId ||
        pending.actorId !== context.actor.id
      )
        throw new Error("The pending submission does not belong to this work item.");
      lease.update((record) => inspectActionIntent(record, pending));
      setReceiptId(null);
      setPreviewOpen(true);
      // The saved intent may have completed in another observer. Its old source-level
      // pending marker must not keep this composer blocked after an authoritative read.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["investigation-action-context"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-work-item"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-work-items"] }),
        queryClient.invalidateQueries({ queryKey: ["investigation-tasks"] }),
      ]);
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
    <Box sx={{ "& .MuiFormHelperText-root": { overflowWrap: "anywhere" } }}>
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
          <Button
            disabled={busy}
            onClick={() => {
              setReceiptId(null);
              setPreviewOpen(true);
            }}
          >
            {intent.state === "succeeded" || intent.state === "failed"
              ? "View last submission"
              : "Open saved preview"}
          </Button>
        </Alert>
      )}
      {lastReceipt && lastReceipt.id !== intent?.id && (
        <Alert severity="info" sx={{ mb: 2 }}>
          A previous submission is retained independently of this draft.
          <Button
            disabled={busy}
            onClick={() => {
              setReceiptId(lastReceipt.id);
              setPreviewOpen(true);
            }}
          >
            View last submission
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
      {!canPrepareActions && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This account can inspect available context and its own saved submissions. Editing or
          preparing an action requires Prepare actions permission.
        </Alert>
      )}
      {Object.keys(fieldErrors).length > 0 && (
        <Alert severity="error" sx={{ mb: 2, overflowWrap: "anywhere" }}>
          <Button
            ref={summaryFocus}
            onClick={() => focusField(Object.keys(fieldErrors)[0]!)}
            sx={{ justifyContent: "flex-start", textAlign: "start", whiteSpace: "normal" }}
          >
            {Object.keys(fieldErrors).length}{" "}
            {Object.keys(fieldErrors).length === 1 ? "field needs" : "fields need"} attention
          </Button>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {Object.entries(fieldErrors).map(([name, message]) => (
              <li key={name}>
                <Button
                  onClick={() => focusField(name)}
                  sx={{
                    justifyContent: "flex-start",
                    textAlign: "start",
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                  }}
                >
                  {message}
                </Button>
              </li>
            ))}
          </Box>
        </Alert>
      )}
      <Box
        component="fieldset"
        aria-label="Action preparation form"
        disabled={busy || submissionUnresolved || !canPrepareActions}
        sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}
      >
        {context.nextActions.length > 0 && (
          <Box component="details" open={choosingAction} sx={{ mb: 2 }}>
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
        {choosingAction || !action ? (
          <Stack spacing={1.5} sx={{ mb: 2 }}>
            <Typography variant="h6" component="h2">
              Choose an action
            </Typography>
            {importOnChoice && (
              <Alert severity="info">
                The current report selection will be imported only if you choose a feedback action.
                Existing publishing text in that action is retained.
              </Alert>
            )}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                gap: 1.5,
              }}
            >
              {context.fixedActions.map((item, index) => (
                <Box
                  key={item.action}
                  sx={{ border: 1, borderColor: "divider", borderRadius: 3, p: 2, minWidth: 0 }}
                >
                  <Button
                    id={
                      index ===
                      context.fixedActions.findIndex((candidate) =>
                        isActionAllowed(context, candidate.action),
                      )
                        ? fieldId("operation")
                        : undefined
                    }
                    variant="outlined"
                    disabled={
                      !isActionAllowed(context, item.action) ||
                      busy ||
                      submissionUnresolved ||
                      Boolean(context.pendingSubmission)
                    }
                    onClick={() => selectAction(item.action)}
                  >
                    {actionLabels[item.action]}
                  </Button>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 1, overflowWrap: "anywhere" }}
                  >
                    {item.reason}
                  </Typography>
                  {item.guards
                    .filter((guard) => !guard.satisfied)
                    .map((guard) => (
                      <Typography
                        key={guard.code}
                        variant="caption"
                        component="p"
                        color="warning.main"
                      >
                        {guard.message}
                      </Typography>
                    ))}
                </Box>
              ))}
            </Box>
            {action && (
              <Button onClick={() => setChoosingAction(false)}>
                Return to {actionLabels[action]} draft
              </Button>
            )}
          </Stack>
        ) : (
          <Stack
            direction="row"
            useFlexGap
            spacing={1}
            sx={{ alignItems: "center", flexWrap: "wrap", mb: 2 }}
          >
            <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
              {actionLabels[action]}
            </Typography>
            <Button
              id={fieldId("operation")}
              disabled={busy || submissionUnresolved}
              onClick={() => setChoosingAction(true)}
            >
              Change action
            </Button>
          </Stack>
        )}
        {action && !choosingAction && !allowed && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {proposal?.reason ??
              context.fixedActions.find((item) => item.action === action)?.reason ??
              "The current server context does not allow this operation."}
          </Alert>
        )}
        {proposal && !choosingAction && !proposal.readyToExecute && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Preparation is available, but execution still needs the server's current prerequisites.
            <TextList
              items={proposal.guards
                .filter((guard) => !guard.satisfied)
                .map((guard) => guard.message)}
            />
          </Alert>
        )}
        {action && !choosingAction && navigationActions.has(action) && context.reportRef && (
          <Button
            component={Link}
            to={reportNavigation(action, context.reportRef.id, workItem.repositoryId)}
          >
            {actionLabels[action]}
          </Button>
        )}
        {plan && !choosingAction && (
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
            <Typography variant="overline">Saved plan source</Typography>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              {savedSubjectDescription(planSubject)}
            </Typography>
          </Box>
        )}
        {plan &&
          !choosingAction &&
          (action === "start-task" || action === "reviews.verify") &&
          needsSourceSelection && (
            <TextField
              id={fieldId("sourceCommit")}
              fullWidth
              label="Exact source commit SHA"
              value={sourceCommit}
              onChange={(event) => setField("sourceCommit", event.target.value.trim())}
              error={Boolean(fieldErrors.sourceCommit)}
              helperText={
                fieldErrors.sourceCommit ||
                (workItem.kind === "issue"
                  ? "Issue snapshots do not identify a source revision. Choose the full commit SHA for this saved plan."
                  : "The source commit is explicit. The server verifies this plan and its source compatibility.")
              }
              sx={{ mb: 2 }}
            />
          )}
        {feedbackAction && !choosingAction && action && (
          <PublicationComposerPanel
            key={action}
            action={action}
            context={context}
            result={result}
            draft={draft.publication}
            reportSelection={selection}
            editedBodies={editedBodies}
            summary={body}
            step={publicationStep}
            disabled={busy || submissionUnresolved || !canPrepareActions}
            errors={fieldErrors}
            fieldId={fieldId}
            onChange={updatePublication}
            onSummaryChange={(value) => setField("body", value)}
            onClearError={clearFieldError}
            onStepChange={setPublicationStep}
          />
        )}
        {action === "close" && !choosingAction && (
          <Stack spacing={2}>
            <Alert severity="warning">
              Close changes only the source state. It does not publish feedback, merge changes or
              delete a branch. Prepare a separate conversation comment if you need to explain the
              closure.
            </Alert>
            {workItem.kind === "issue" && (
              <TextField
                select
                fullWidth
                id={fieldId("closeReason")}
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
          </Stack>
        )}
        {action === "close-as-duplicate" && !choosingAction && (
          <Stack spacing={1.5}>
            <Alert severity={duplicateTarget ? "info" : "warning"}>
              Duplicate closure uses only the other Issue identified in the saved assessment. The
              server verifies that target and its repository; an arbitrary number cannot replace it.
            </Alert>
            <TextField
              id={fieldId("duplicateNumber")}
              label="Saved duplicate target"
              value={
                duplicateTarget
                  ? `${duplicateTarget.identifier} · Issue #${duplicateTarget.number}`
                  : "No usable saved target"
              }
              slotProps={{ input: { readOnly: true } }}
              error={Boolean(fieldErrors.duplicateNumber)}
              helperText={
                fieldErrors.duplicateNumber ||
                (!duplicateTarget
                  ? "Reload the saved report or choose another operation."
                  : "This target is read-only.")
              }
            />
          </Stack>
        )}
        {action === "merge" && !choosingAction && (
          <Stack spacing={2}>
            <Alert severity="warning">
              Merge uses its own current source and permission guards. It does not publish a review,
              finding text or a code suggestion.
            </Alert>
            <TextField
              id={fieldId("mergeMethod")}
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
              id={fieldId("commitTitle")}
              label="Commit title"
              value={commitTitle}
              onChange={(event) => setField("commitTitle", event.target.value)}
            />
          </Stack>
        )}
        {action === "trigger-ci" && !choosingAction && (
          <Stack spacing={2}>
            <TextField
              id={fieldId("workflowId")}
              label="Workflow ID or file name"
              value={workflowId}
              onChange={(event) => setField("workflowId", event.target.value)}
              error={Boolean(fieldErrors.workflowId)}
              helperText={fieldErrors.workflowId}
            />
            <TextField
              id={fieldId("workflowRef")}
              label="Exact workflow ref"
              value={workflowRef}
              onChange={(event) => setField("workflowRef", event.target.value)}
              error={Boolean(fieldErrors.workflowRef)}
              helperText={
                fieldErrors.workflowRef ||
                "The server must resolve this ref to the reviewed PR head. Queueing CI does not establish a passed check."
              }
            />
            <TextField
              id={fieldId("workflowInputs")}
              label="Workflow inputs (JSON)"
              multiline
              minRows={3}
              value={workflowInputs}
              onChange={(event) => setField("workflowInputs", event.target.value)}
              error={Boolean(fieldErrors.workflowInputs)}
              helperText={fieldErrors.workflowInputs}
            />
          </Stack>
        )}
        {action === "create-pr" && !choosingAction && (
          <Stack spacing={2}>
            <Alert severity="info">
              Create PR uses an existing verified remote branch. It does not commit or push changes.
            </Alert>
            <TextField
              id={fieldId("branchSubjectRef")}
              select
              label="Verified remote branch"
              value={branchSubjectRef}
              onChange={(event) => setField("branchSubjectRef", event.target.value)}
              error={Boolean(fieldErrors.branchSubjectRef)}
              helperText={fieldErrors.branchSubjectRef}
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
              id={fieldId("prTitle")}
              label="Pull request title"
              value={prTitle}
              onChange={(event) => setField("prTitle", event.target.value)}
              error={Boolean(fieldErrors.prTitle)}
              helperText={fieldErrors.prTitle}
            />
            <TextField
              id={fieldId("baseBranch")}
              label="Base branch"
              value={baseBranch}
              onChange={(event) => setField("baseBranch", event.target.value)}
              error={Boolean(fieldErrors.baseBranch)}
              helperText={fieldErrors.baseBranch}
            />
            <TextField
              id={fieldId("summary")}
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
          disabled={busy || !action || !canPrepareActions || !actionFormIsDirty(draft)}
          onClick={() => {
            updateDraft(saveActionDraft);
          }}
        >
          Save this action draft
        </Button>
        <Button disabled={!dirty || busy} onClick={discard}>
          Discard unsaved action edits
        </Button>
      </Stack>
      {duplicateReceipt && !choosingAction && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          This exact content and action already succeeded for the same source and report. Preparing
          again creates a separate submission; the final confirmation will explicitly say “Confirm
          another”.
          <Button
            disabled={busy}
            onClick={() => {
              setReceiptId(duplicateReceipt.id);
              setPreviewOpen(true);
            }}
          >
            View matching submission
          </Button>
        </Alert>
      )}
      <Button
        variant="contained"
        disabled={
          choosingAction ||
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
        open={previewOpen && Boolean(previewIntent)}
        onClose={() => {
          if (!busy) {
            setPreviewOpen(false);
            setReceiptId(null);
          }
        }}
        fullWidth
        maxWidth="md"
        aria-labelledby={fieldId("preview-title")}
        aria-describedby={fieldId("preview-description")}
      >
        <DialogTitle id={fieldId("preview-title")}>
          {previewIntent
            ? `${["succeeded", "failed", "cancelled"].includes(previewIntent.state) ? "Submission receipt" : "Review"} · ${actionLabels[previewIntent.action]}`
            : "Action preview"}
        </DialogTitle>
        <DialogContent dividers>
          {previewIntent && (
            <Stack spacing={2}>
              <Typography
                id={fieldId("preview-description")}
                variant="body2"
                color="text.secondary"
              >
                {receiptId || ["succeeded", "failed", "cancelled"].includes(previewIntent.state)
                  ? "This is a retained server submission snapshot. Viewing it does not change the current draft or submit another operation."
                  : "This is the exact content and destination returned by the server. Confirming executes this saved preview after the server rechecks its current guards."}
              </Typography>
              <ExactActionPreview
                intent={previewIntent}
                destination={destination}
                result={result}
              />
              {!receiptId && draft.contextRefreshRequired && (
                <Alert severity="warning">
                  Refresh the current action context before confirming.
                  <Button disabled={busy} onClick={() => void refreshActionContext()}>
                    Refresh action context
                  </Button>
                </Alert>
              )}
              {!receiptId && !intentMatchesContext && previewIntent.state === "prepared" && (
                <Alert severity="warning">
                  The source, report or actor changed. Prepare a new preview from the current
                  context before confirming.
                </Alert>
              )}
              {!receiptId && previewIntent.state === "prepared" && !hasExecutionPermission && (
                <Alert severity="info">{executionAccess.reason}</Alert>
              )}
              {previewIntent.guards
                .filter((guard) => !guard.satisfied)
                .map((guard) => (
                  <Alert key={guard.code} severity="warning">
                    {guard.message}
                  </Alert>
                ))}
              {!receiptId && repeatedPreview && previewIntent.state === "prepared" && (
                <Alert severity="warning">
                  The same action and content already succeeded for this source and report. Confirm
                  another only if you intend a separate submission.
                </Alert>
              )}
              {previewIntent.result && (
                <Alert
                  severity={
                    previewIntent.state === "succeeded"
                      ? "success"
                      : previewIntent.state === "failed"
                        ? "error"
                        : "info"
                  }
                >
                  {previewIntent.result.message}
                </Alert>
              )}
              {(previewIntent.state === "unknown" ||
                (!receiptId && draft.confirmationUncertain)) && (
                <Alert severity="warning">
                  The submission outcome is not confirmed. Check this saved intent; do not submit a
                  new review or resend individual findings. A review-level receipt does not
                  independently verify each inline comment.
                </Alert>
              )}
              {!receiptId &&
                ["unknown", "executing"].includes(previewIntent.state) &&
                !hasExecutionPermission && (
                  <Alert severity="info">
                    You can refresh this saved intent as its owner. {executionAccess.reason}
                  </Alert>
                )}
              {error && <Alert severity="error">{error}</Alert>}
              {previewIntent.result?.taskId && (
                <Button
                  component={Link}
                  to={`/tasks?taskId=${encodeURIComponent(previewIntent.result.taskId)}&repositoryId=${encodeURIComponent(previewIntent.repositoryId)}`}
                >
                  Open linked task
                </Button>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setPreviewOpen(false);
              setReceiptId(null);
            }}
          >
            {receiptId ? "Return to current draft" : "Close preview"}
          </Button>
          {!receiptId && intent && ["unknown", "executing"].includes(intent.state) && (
            <Button
              disabled={busy || !hasExecutionPermission}
              onClick={() => void updateIntent("reconcile")}
            >
              Reconcile saved submission
            </Button>
          )}
          {!receiptId &&
            intent &&
            (["confirmed", "executing", "unknown"].includes(intent.state) ||
              draft.confirmationUncertain) && (
              <Button disabled={busy} onClick={() => void updateIntent("refresh")}>
                Refresh saved status
              </Button>
            )}
          {!receiptId && intent?.state === "prepared" && !draft.confirmationUncertain && (
            <Button
              variant="contained"
              color={
                intent.action === "close" ||
                intent.action === "merge" ||
                intent.action === "close-as-duplicate"
                  ? "error"
                  : "primary"
              }
              disabled={
                busy || !canExecuteIntent || intent.guards.some((guard) => !guard.satisfied)
              }
              onClick={() => void updateIntent("confirm")}
            >
              {repeatedPreview ? "Confirm another" : "Confirm"} {actionLabels[intent.action]}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
