import type * as C from "@agentic-review/contracts";
import type { EvaluationModelInvocationScope } from "@/services/evaluation-model-invocations";
import { ReviewControlProtocolError } from "@/services/review-control/errors";
import { arms } from "./batch-state";

export interface CellInvocationBinding {
  readonly scope: EvaluationModelInvocationScope;
  readonly caseTitle: string;
  readonly arm: C.EvaluationArm;
  readonly runId: string;
  readonly requestId: string;
  readonly jobId: string | null;
  readonly modelRequired: boolean;
  readonly expectedRuntimeRegistration: C.ModelRuntimeRegistrationV1 | null;
}

export function selectedCellInvocationBinding(
  detail: C.EvaluationBatchDetailV1 | undefined,
  matrix: C.EvaluationBatchMatrixV1 | undefined,
  cellId: string | null,
): CellInvocationBinding | null {
  if (
    !detail ||
    !matrix ||
    !cellId ||
    detail.summary.id !== matrix.evaluationId ||
    detail.summary.repositoryId !== matrix.repositoryId ||
    detail.summary.suiteVersionId !== matrix.suiteVersionId
  )
    return null;
  for (const entry of matrix.cases)
    for (const arm of arms) {
      const cell = entry[arm];
      if (cell.cellId !== cellId) continue;
      return {
        scope: { repositoryId: matrix.repositoryId, evaluationId: matrix.evaluationId, cellId },
        caseTitle: entry.title,
        arm,
        runId: cell.runId,
        requestId: cell.requestId,
        jobId: cell.job?.jobId ?? null,
        modelRequired: detail.configurations[arm].modelRequirements.required,
        expectedRuntimeRegistration: detail.configurations[arm].modelRuntimeRegistration ?? null,
      };
    }
  return null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
export function cellInvocationBindingKey(binding: CellInvocationBinding): string {
  return canonical(binding);
}
export function assertCellInvocationBinding(
  value: C.EvaluationCellInvocationListV1,
  binding: CellInvocationBinding,
): void {
  if (
    value.repositoryId !== binding.scope.repositoryId ||
    value.evaluationId !== binding.scope.evaluationId ||
    value.cellId !== binding.scope.cellId ||
    canonical(value.expectedRuntimeRegistration) !==
      canonical(binding.expectedRuntimeRegistration) ||
    (!binding.modelRequired && value.items.length > 0) ||
    value.items.some(
      ({ opening }) =>
        opening.scope.runId !== binding.runId ||
        opening.scope.requestId !== binding.requestId ||
        (binding.jobId !== null && opening.scope.jobId !== binding.jobId),
    )
  ) {
    throw new ReviewControlProtocolError(
      "read model invocation history",
      "The invocation history does not match the selected cell and its frozen configuration.",
    );
  }
}

export function invocationCollectionLabel(item: C.EvaluationCellInvocationItem): string {
  if (item.submission === null)
    return item.seal === null ? "Closure not received" : "Ledger not received";
  return {
    matched: "Collection matches",
    unavailable: "Collection incomplete",
    mismatched: "Identity mismatch",
    invalid: "Collection invalid",
  }[item.submission.consistency.state];
}

export const invocationReasonLabels: Record<C.ModelInvocationConsistencyReason, string> = {
  INVALID_EXPECTATION: "The stored expectation is invalid.",
  INVALID_RECEIPT_SET: "The collected record does not match its required format.",
  SCOPE_DIGEST_MISMATCH: "The invocation scope digest does not match its content.",
  RECEIPT_DIGEST_MISMATCH: "A recorded call digest does not match its content.",
  IDENTITY_DIGEST_MISMATCH: "The recorded model identity digest is inconsistent.",
  SCOPE_MISMATCH: "The collection belongs to another invocation scope.",
  CLOSURE_SEAL_MISMATCH: "The collection differs from the separately saved closure.",
  CLOSURE_METADATA_MISMATCH: "Call counts or closure metadata do not match the saved closure.",
  RUNTIME_MEASUREMENT_MISMATCH: "The recorded runtime differs from the opening measurement.",
  CALL_TIME_ORDER_INVALID: "Recorded calls are not in a valid time order.",
  INVOCATION_CANCELLED: "The collector recorded a cancelled invocation.",
  CALL_CHAIN_INCOMPLETE: "One or more calls failed, were incomplete, or were not recorded.",
  OBSERVED_IDENTITY_MISSING: "A consistent provider model identity was not observed.",
  RUNTIME_IDENTITY_MISMATCH: "The observed model identity differs from the frozen expectation.",
  OUTPUT_UNBOUND: "The collection is not bound to a validated model output.",
  OUTPUT_MISMATCH: "The model output digest differs from the recorded expectation.",
  CLEANUP_UNCONFIRMED: "Process or relay cleanup was not confirmed.",
};

export const invocationOutcomeLabels: Record<keyof C.EvaluationCellInvocationCallOutcomes, string> =
  {
    completed: "Completed",
    provider_failed: "Provider failed",
    provider_incomplete: "Provider incomplete",
    transport_failed: "Connection failed",
    cancelled: "Cancelled",
    protocol_invalid: "Invalid response",
    budget_exceeded: "Limit exceeded",
  };
