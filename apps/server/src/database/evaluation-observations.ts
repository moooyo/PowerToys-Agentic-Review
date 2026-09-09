import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import {
  type CapturedEvaluationObservations,
  captureEvaluationObservations,
  EVALUATION_SCORING_RULES_VERSION,
  type FrozenEvaluationScoringPlan,
} from "@agentic-review/domain";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { handleEvaluationAdjudicationRequest } from "./evaluation-adjudication.js";
import {
  type EvaluationBatchEvidenceQuery,
  readEvaluationBatchEvidenceSelectionInTransaction,
} from "./evaluation-batch-selection.js";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { readEvaluationBatchScoringProjectionInTransaction } from "./evaluation-queries.js";
import { readEvaluationResultSelectionInTransaction } from "./evaluation-result-selection.js";
import { readEvaluationScoringPlanInTransaction } from "./evaluation-scoring-plan.js";
import { assertRepositoryPermission } from "./operator-access.js";
import {
  currentValidationEvidence,
  normalizedValidationModel,
  type VerifiedValidationEvidenceFacts,
  verificationStatuses,
} from "./validation-result-projection.js";

/** Internal operation-scoped views bound to one coordinator token, never accepted over HTTP/RPC. */
export interface VerifiedEvaluationBatchEvidenceFacts {
  readonly selectionDigest: string;
  readonly cells: ReadonlyMap<string, VerifiedValidationEvidenceFacts>;
  readonly assertCurrent: () => void;
}
export interface EvaluationScoreInputs {
  readonly frozen: FrozenEvaluationScoringPlan;
  readonly captured: CapturedEvaluationObservations;
  readonly observations: readonly C.EvaluationOwnerObservation[];
  readonly adjudications: readonly C.EvaluationFindingAdjudication[];
  readonly selectionDigest: string;
  readonly observationDigest: string;
  readonly adjudicationDigest: string;
  readonly inputDigest: string;
}

export function evaluationScoreInputDigest(input: {
  readonly repositoryId: string;
  readonly evaluationId: string;
  readonly scorerVersion: C.EvaluationScoringReportV1["rulesVersion"];
  readonly scoringPlanDigest: string;
  readonly observationDigest: string;
  readonly adjudicationDigest: string;
}): string {
  return sha256(canonicalJson({ schemaVersion: "EvaluationScoreInputV1", ...input }));
}

function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The owner evaluation observations do not match the complete frozen execution matrix.",
  );
}

function reasonFor(cell: C.EvaluationCellSummaryV1): string {
  if (cell.state === "awaiting_admission")
    return "The evaluation Job is awaiting admission; execution has not started.";
  if (cell.state === "not_run") return "The evaluation cell has not been executed.";
  if (cell.state === "queued") return "The admitted evaluation Job is waiting for a Worker.";
  if (cell.state === "running") return "The evaluation Job has not produced a terminal result.";
  if (cell.state === "cancelled")
    return "The evaluation cell was cancelled before a result was recorded.";
  const code = cell.job?.failureCode ?? cell.blockers[0]?.code;
  return `The evaluation cell is ${cell.state}${code ? ` (${code})` : ""}.`;
}

/** Capture real rows and current evidence inside the final owner transaction, without asynchronous I/O. */
export function captureEvaluationScoreInputsInTransaction(
  database: DatabaseSync,
  scope: EvaluationBatchEvidenceQuery,
  actor: C.OperatorPrincipal,
  administrators: readonly C.OperatorPrincipal[],
  facts?: VerifiedEvaluationBatchEvidenceFacts,
): EvaluationScoreInputs {
  if (!database.isTransaction) corrupt();
  assertRepositoryPermission(database, actor, scope.repositoryId, "read", administrators);
  facts?.assertCurrent();
  const selection = readEvaluationBatchEvidenceSelectionInTransaction(database, scope);
  if (facts && facts.selectionDigest !== selection.selectionDigest)
    throw new EvaluationManagementError(
      "PLATFORM_CONFLICT",
      "The evaluation result selection changed during evidence verification. Refresh the preview.",
    );
  const projection = readEvaluationBatchScoringProjectionInTransaction(database, scope);
  const { frozen } = readEvaluationScoringPlanInTransaction(database, scope, actor, administrators);
  if (
    frozen.plan.cases.length * 2 !== projection.cells.length ||
    frozen.plan.sampleSetVersionId !== projection.suiteVersion.id ||
    frozen.plan.expectationVersionId !== projection.suiteVersion.expectationVersionId
  )
    corrupt();
  const selectedCells = new Set(projection.cells.map((cell) => cell.cellId));
  if (facts && [...facts.cells.keys()].some((cellId) => !selectedCells.has(cellId))) corrupt();
  const observations: C.EvaluationOwnerObservation[] = [];
  const adjudications: C.EvaluationFindingAdjudication[] = [];
  for (const expected of frozen.plan.cases) {
    for (const arm of ["baseline", "candidate"] as const) {
      const binding = expected[`${arm}Binding`];
      const cell = projection.cells.find((entry) => entry.cellId === binding.cellId);
      if (
        !cell ||
        cell.caseId !== expected.caseId ||
        cell.arm !== arm ||
        cell.runId !== binding.runId ||
        cell.requestId !== binding.requestId ||
        cell.sourceDigest !== expected.sourceDigest ||
        cell.profileVersionId !== frozen.plan[arm].profileVersionId ||
        cell.promptVersionId !== frozen.plan[arm].promptVersionId
      )
        corrupt();
      // Even an unexecuted cell must retain its actual sealed V2 source/configuration binding.
      const execution = readEvaluationExecutionCellInTransaction(database, {
        repositoryId: scope.repositoryId,
        runId: cell.runId,
      });
      if (
        !execution ||
        execution.evaluationId !== scope.evaluationId ||
        execution.cellId !== cell.cellId ||
        execution.requestId !== cell.requestId ||
        execution.applicable !== (expected.applicability.state === "applicable") ||
        execution.plan.source.sourceDigest !== expected.sourceDigest ||
        execution.request.profileVersion.id !== cell.profileVersionId ||
        execution.request.prompt.version.id !== cell.promptVersionId ||
        execution.plan.modelRequirements.expectedModelIdentityDigest !==
          frozen.plan[arm].modelIdentityDigest ||
        canonicalJson(execution.plan.modelRequirements) !==
          canonicalJson(projection.configurations[arm].modelRequirements) ||
        execution.jobs.length !== (cell.job === null ? 0 : 1) ||
        (cell.job !== null && execution.jobs[0]?.jobId !== cell.job.jobId)
      )
        corrupt();
      const base = {
        evaluationId: scope.evaluationId,
        repositoryId: scope.repositoryId,
        caseId: expected.caseId,
        arm,
        cellId: cell.cellId,
        runId: cell.runId,
        requestId: cell.requestId,
      };
      const modelRequired = execution.plan.modelRequirements.required;
      if (
        execution.reproductionReadiness.state === "blocked" &&
        cell.state !== "blocked" &&
        cell.state !== "cancelled"
      )
        corrupt();
      if (cell.state !== "completed") {
        const reason =
          expected.applicability.state === "not_applicable"
            ? expected.applicability.reason
            : reasonFor(cell);
        observations.push({
          ...base,
          executionState: cell.state === "awaiting_admission" ? "not_run" : cell.state,
          reason,
          result: null,
          sourceState: "unknown",
          checks: [],
          model:
            !modelRequired || !execution.applicable
              ? {
                  state: "not_applicable",
                  reason: "Model review is not required for this frozen cell.",
                }
              : {
                  state:
                    cell.state === "failed" || cell.state === "invalid" || cell.state === "blocked"
                      ? cell.state
                      : "not_run",
                  reason,
                },
        });
        continue;
      }
      if (!cell.result || !cell.job) corrupt();
      const query = { ...scope, cellId: cell.cellId, resultId: cell.result.resultId };
      const selected = readEvaluationResultSelectionInTransaction(database, query);
      if (
        !selected ||
        selected.row.resultDigest !== cell.result.resultDigest ||
        selected.row.jobId !== cell.job.jobId ||
        selected.row.runAttemptId !== cell.result.runAttemptId ||
        selected.row.planDigest !== execution.planDigest
      )
        corrupt();
      const cellFacts = facts?.cells.get(cell.cellId);
      // The shared batch token was checked once above; this synchronous transaction cannot yield.
      const evidenceAvailable = currentValidationEvidence(
        database,
        {
          id: cell.runId,
          repositoryId: scope.repositoryId,
          revisionKey: selected.row.revisionKey,
          planDigest: selected.row.planDigest,
        },
        cell.requestId,
        { jobId: cell.job.jobId },
        selected.row,
        selected.result,
        {
          kind: "prepared",
          ...(cellFacts ? { facts: cellFacts } : {}),
          statuses: verificationStatuses(cellFacts),
        },
      );
      const model = normalizedValidationModel(selected.result, selected.row.workflowKind);
      const context = handleEvaluationAdjudicationRequest(
        database,
        {
          operation: "getEvaluationAdjudicationContext",
          input: { ...query, actor },
        },
        new Date().toISOString(),
        administrators,
      ) as C.EvaluationAdjudicationContextV1;
      if (
        context.caseId !== expected.caseId ||
        context.arm !== arm ||
        context.resultDigest !== selected.row.resultDigest ||
        context.modelRequired !== modelRequired
      )
        corrupt();
      const current = context.items.flatMap((item) =>
        item.adjudication === null ? [] : [item.adjudication],
      );
      if (current.length > 0 && (!modelRequired || model.state !== "completed")) corrupt();
      adjudications.push(...current);
      observations.push({
        ...base,
        executionState: "completed",
        reason: null,
        result: {
          resultId: selected.row.id,
          resultDigest: selected.row.resultDigest,
          jobId: selected.row.jobId,
          runAttemptId: selected.row.runAttemptId,
          profileVersionId: selected.row.profileVersionId,
          promptVersionId: selected.row.promptVersionId,
          executionDigest: selected.row.executionDigest,
          sourceDigest: selected.row.sourceDigest,
        },
        sourceState: selected.result.report.sourceState,
        checks: selected.result.report.checks.map((check) => ({
          checkId: check.id,
          outcome: check.outcome,
          evidenceAvailable,
        })),
        model: !modelRequired
          ? {
              state: "not_applicable",
              reason: "Model review is not required by this frozen configuration.",
            }
          : model.state === "completed"
            ? {
                state: "complete",
                evidenceAvailable,
                // Invocation consistency does not attest an accepted execution boundary. V1 and V2
                // both withhold scoring identity while required-model execution remains unavailable.
                modelIdentityDigest: null,
                occurrenceKeys: context.items.map((item) => item.occurrence.key),
              }
            : {
                state: model.state === "failed" ? "failed" : "not_run",
                reason: "A completed required model result is unavailable.",
              },
      });
    }
  }
  const currentCount = database
    .prepare(`SELECT COUNT(*) AS count FROM evaluation_adjudication_events AS event
    WHERE event.repository_id = ? AND event.evaluation_id = ? AND event.version = (
      SELECT MAX(latest.version) FROM evaluation_adjudication_events AS latest
      WHERE latest.cell_id = event.cell_id AND latest.result_id = event.result_id
        AND latest.result_digest = event.result_digest AND latest.occurrence_key = event.occurrence_key
    )`)
    .get(scope.repositoryId, scope.evaluationId) as { count: number };
  if (currentCount.count !== adjudications.length) corrupt();
  let captured: CapturedEvaluationObservations;
  try {
    captured = captureEvaluationObservations(frozen, observations);
    C.assertEvaluationFindingAdjudications(adjudications);
  } catch {
    return corrupt();
  }
  const observationDigest = sha256(canonicalJson(captured.observations));
  const adjudicationDigest = sha256(canonicalJson(adjudications));
  return {
    frozen,
    captured,
    observations: captured.observations,
    adjudications,
    selectionDigest: selection.selectionDigest,
    observationDigest,
    adjudicationDigest,
    inputDigest: evaluationScoreInputDigest({
      ...scope,
      scorerVersion: EVALUATION_SCORING_RULES_VERSION,
      scoringPlanDigest: frozen.digest,
      observationDigest,
      adjudicationDigest,
    }),
  };
}
