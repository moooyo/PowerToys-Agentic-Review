import type * as C from "@agentic-review/contracts";
import { ReviewControlProtocolError } from "@/services/review-control/errors";
import { arms } from "./batch-state";

export interface CellResultSelection {
  readonly cellId: string;
  readonly resultId: string;
}
export interface CellResultBinding {
  readonly scope: C.EvaluationCellResultReadQuery;
  readonly caseTitle: string;
  readonly expected: Pick<
    C.EvaluationCellResultV1,
    | "caseId"
    | "arm"
    | "trial"
    | "runId"
    | "requestId"
    | "jobId"
    | "runAttemptId"
    | "workItemId"
    | "sourceId"
    | "sourceDigest"
    | "revisionKey"
    | "profileVersionId"
    | "promptVersionId"
    | "resultDigest"
    | "createdAt"
    | "workflowKind"
    | "target"
  >;
  readonly modelRequirements: C.EvaluationModelRequirementsV1;
}

export function selectedCellResultBinding(
  detail: C.EvaluationBatchDetailV1 | undefined,
  matrix: C.EvaluationBatchMatrixV1 | undefined,
  selection: CellResultSelection | null,
): CellResultBinding | null {
  if (
    !detail ||
    !matrix ||
    !selection ||
    detail.summary.id !== matrix.evaluationId ||
    detail.summary.repositoryId !== matrix.repositoryId ||
    detail.summary.suiteVersionId !== matrix.suiteVersionId
  )
    return null;
  for (const entry of matrix.cases)
    for (const arm of arms) {
      const cell = entry[arm],
        result = cell.result;
      if (cell.cellId !== selection.cellId || result?.resultId !== selection.resultId || !cell.job)
        continue;
      return {
        scope: {
          repositoryId: matrix.repositoryId,
          evaluationId: matrix.evaluationId,
          cellId: cell.cellId,
          resultId: result.resultId,
        },
        caseTitle: entry.title,
        expected: {
          caseId: entry.caseId,
          arm,
          trial: cell.trial,
          runId: cell.runId,
          requestId: cell.requestId,
          jobId: cell.job.jobId,
          runAttemptId: result.runAttemptId,
          workItemId: entry.source.workItemId,
          sourceId: cell.sourceId,
          sourceDigest: cell.sourceDigest,
          revisionKey: entry.source.revisionKey,
          profileVersionId: cell.profileVersionId,
          promptVersionId: cell.promptVersionId,
          resultDigest: result.resultDigest,
          createdAt: result.createdAt,
          workflowKind: detail.summary.workflowKind,
          target: detail.summary.target,
        },
        modelRequirements: detail.configurations[arm].modelRequirements,
      };
    }
  return null;
}

export function cellResultBindingKey(binding: CellResultBinding): string {
  return JSON.stringify([binding.scope, binding.expected, binding.modelRequirements]);
}

export function assertCellResultBinding(
  result: C.EvaluationCellResultV1,
  binding: CellResultBinding,
): void {
  const expected = { ...binding.scope, ...binding.expected };
  if (
    (Object.keys(expected) as (keyof typeof expected)[]).some(
      (key) => result[key] !== expected[key],
    ) ||
    result.modelRequirements.required !== binding.modelRequirements.required ||
    result.modelRequirements.expectedModelIdentityDigest !==
      binding.modelRequirements.expectedModelIdentityDigest
  )
    throw new ReviewControlProtocolError(
      "read evaluation cell result",
      "The result no longer matches the selected matrix cell, source, configuration, Job and attempt.",
    );
}

export const currentEvidenceLabel = (result: C.EvaluationCellResultV1) =>
  result.evidenceVerificationPending === true
    ? "Pending verification"
    : result.evidenceComplete
      ? "Currently verified"
      : "Unavailable or incomplete";
