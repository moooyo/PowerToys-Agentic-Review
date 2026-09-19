import type {
  InvestigationActionIntentV1,
  InvestigationCreateActionIntentRequest,
  InvestigationReportRef,
} from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";

export interface ActionDraftFields {
  nextActionId: string | undefined;
  body: string;
  mergeMethod: "merge" | "squash" | "rebase";
  commitTitle: string;
  closeReason: "completed" | "not_planned";
  duplicateNumber: string;
  workflowId: string;
  workflowRef: string;
  workflowInputs: string;
  branchSubjectRef: string;
  prTitle: string;
  baseBranch: string;
  sourceCommit: string;
}

export interface ActionDraftRecord {
  fields: ActionDraftFields;
  savedFields: ActionDraftFields;
  prepareRequest: InvestigationCreateActionIntentRequest | null;
  preparationRejected: boolean;
  preparationResolved: boolean;
  contextRefreshRequired: boolean;
  intent: InvestigationActionIntentV1 | null;
  confirmationUncertain: boolean;
}

export function actionDraftKey(
  session: string,
  repositoryId: string,
  workItemId: string,
  reportRef: InvestigationReportRef | null,
) {
  return [
    "investigation-private-action-draft",
    session,
    repositoryId,
    workItemId,
    reportRef?.id ?? null,
    reportRef?.version ?? null,
    reportRef?.digest ?? null,
  ] as const;
}

export function createActionDraft(): ActionDraftRecord {
  const fields: ActionDraftFields = {
    nextActionId: undefined,
    body: "",
    mergeMethod: "squash",
    commitTitle: "",
    closeReason: "completed",
    duplicateNumber: "",
    workflowId: "",
    workflowRef: "",
    workflowInputs: "{}",
    branchSubjectRef: "",
    prTitle: "",
    baseBranch: "",
    sourceCommit: "",
  };
  return {
    fields,
    savedFields: { ...fields },
    prepareRequest: null,
    preparationRejected: false,
    preparationResolved: false,
    contextRefreshRequired: false,
    intent: null,
    confirmationUncertain: false,
  };
}

export function actionDraftIsDirty(record: ActionDraftRecord): boolean {
  return (Object.keys(record.fields) as (keyof ActionDraftFields)[]).some(
    (key) => record.fields[key] !== record.savedFields[key],
  );
}

export function saveActionDraft(record: ActionDraftRecord): ActionDraftRecord {
  return { ...record, savedFields: { ...record.fields } };
}

export function discardActionDraft(record: ActionDraftRecord): ActionDraftRecord {
  // Draft editing and an already submitted request have separate lifecycles.
  return { ...record, fields: { ...record.savedFields } };
}

export function hasUnresolvedActionSubmission(record: ActionDraftRecord): boolean {
  return (
    record.confirmationUncertain ||
    hasUnresolvedActionPreparation(record) ||
    Boolean(record.intent && ["confirmed", "executing", "unknown"].includes(record.intent.state))
  );
}

export function hasUnresolvedActionPreparation(record: ActionDraftRecord): boolean {
  return Boolean(
    record.prepareRequest && !record.preparationRejected && !record.preparationResolved,
  );
}

export function beginActionPreparation(
  record: ActionDraftRecord,
  request: InvestigationCreateActionIntentRequest,
): ActionDraftRecord {
  if (hasUnresolvedActionPreparation(record)) return record;
  if (hasUnresolvedActionSubmission(record))
    throw new Error("Check the saved submission before preparing another operation.");
  if (record.contextRefreshRequired)
    throw new Error("Refresh the action context before preparing another operation.");
  return {
    ...record,
    prepareRequest: structuredClone(request),
    preparationRejected: false,
    preparationResolved: false,
    intent: null,
    confirmationUncertain: false,
  };
}

export function acceptPreparedAction(
  record: ActionDraftRecord,
  intent: InvestigationActionIntentV1,
): ActionDraftRecord {
  const request = record.prepareRequest;
  if (
    !request ||
    request.idempotencyKey !== intent.idempotencyKey ||
    request.workItemId !== intent.workItemId ||
    request.action !== intent.action ||
    request.subjectRef !== intent.subjectRef ||
    request.expectedRevisionKey !== intent.expectedRevisionKey ||
    request.expectedHeadSha !== intent.expectedHeadSha ||
    request.reportRef?.id !== intent.reportRef?.id ||
    request.reportRef?.version !== intent.reportRef?.version ||
    request.reportRef?.digest !== intent.reportRef?.digest
  )
    throw new Error("The saved preview does not match the retained preparation request.");
  // Another mounted observer may have already received this idempotent preparation.
  // Its late response must not undo a subsequent confirmation or status refresh.
  if (record.preparationResolved) return record;
  return {
    ...record,
    intent: structuredClone(intent),
    preparationRejected: false,
    preparationResolved: true,
    confirmationUncertain: false,
  };
}

export function retainActionIntent(
  record: ActionDraftRecord,
  intent: InvestigationActionIntentV1,
): ActionDraftRecord {
  if (
    record.intent &&
    (record.intent.id !== intent.id ||
      record.intent.idempotencyKey !== intent.idempotencyKey ||
      record.intent.action !== intent.action ||
      record.intent.repositoryId !== intent.repositoryId ||
      record.intent.workItemId !== intent.workItemId ||
      record.intent.actorId !== intent.actorId ||
      record.intent.subjectRef !== intent.subjectRef ||
      record.intent.expectedRevisionKey !== intent.expectedRevisionKey ||
      record.intent.expectedHeadSha !== intent.expectedHeadSha ||
      record.intent.reportRef?.id !== intent.reportRef?.id ||
      record.intent.reportRef?.version !== intent.reportRef?.version ||
      record.intent.reportRef?.digest !== intent.reportRef?.digest ||
      record.intent.payloadDigest !== intent.payloadDigest ||
      intent.version < record.intent.version)
  )
    throw new Error("The returned status does not match the saved submission.");
  return { ...record, intent: structuredClone(intent), confirmationUncertain: false };
}

export function inspectActionIntent(
  record: ActionDraftRecord,
  intent: InvestigationActionIntentV1,
): ActionDraftRecord {
  if (record.intent?.id === intent.id) return retainActionIntent(record, intent);
  if (hasUnresolvedActionSubmission(record))
    throw new Error("Resolve the saved request before inspecting a different submission.");
  return { ...record, intent: structuredClone(intent), confirmationUncertain: false };
}

export function beginActionConfirmation(
  record: ActionDraftRecord,
  preview: InvestigationActionIntentV1,
): ActionDraftRecord {
  const current = record.intent;
  if (
    record.confirmationUncertain ||
    record.contextRefreshRequired ||
    !current ||
    current.state !== "prepared" ||
    current.id !== preview.id ||
    current.version !== preview.version ||
    current.payloadDigest !== preview.payloadDigest
  )
    throw new Error("The saved preview changed. Reopen it before confirming.");
  return { ...record, confirmationUncertain: true };
}

// A cleared session cache invalidates the lease, even if the same account signs in again.
export function actionDraftLease(queryClient: QueryClient, key: ReturnType<typeof actionDraftKey>) {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  const isCurrent = () =>
    query !== undefined &&
    queryClient.getQueryCache().find({ queryKey: key, exact: true }) === query;
  return {
    isCurrent,
    update: (change: (record: ActionDraftRecord) => ActionDraftRecord): boolean => {
      if (!isCurrent()) return false;
      let updated = false;
      queryClient.setQueryData<ActionDraftRecord>(key, (record) => {
        if (!record) return undefined;
        const next = change(record);
        updated = true;
        return next;
      });
      return updated;
    },
  };
}
