import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EvaluationManagementError } from "./evaluation-management.js";
import {
  readEvaluationResultIdentityInTransaction,
  readEvaluationResultSelectionInTransaction,
} from "./evaluation-result-selection.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { assertRepositoryPermission } from "./operator-access.js";
import {
  currentValidationEvidence,
  normalizedValidationModel,
  normalizedValidationReport,
  type VerifiedValidationEvidenceFacts,
  verificationKey,
  verificationStatuses,
} from "./validation-result-projection.js";

export interface EvaluationResultOperationMap {
  getEvaluationCellResult: {
    input: C.EvaluationCellResultReadQuery & { readonly actor: C.OperatorPrincipal };
    output: C.EvaluationCellResultV1;
  };
}
type Input = EvaluationResultOperationMap["getEvaluationCellResult"]["input"];
const inputSchema = Type.Object(
  { ...C.EvaluationCellResultReadQuerySchema.properties, actor: C.OperatorPrincipalSchema },
  { additionalProperties: false },
);

function missing(): never {
  throw new EvaluationManagementError("PLATFORM_NOT_FOUND", "The evaluation result was not found.");
}
function queryFor(input: Input): C.EvaluationCellResultReadQuery {
  if (!Value.Check(inputSchema, input))
    throw new EvaluationManagementError(
      "PLATFORM_INVALID",
      "The evaluation result scope is invalid.",
    );
  const { actor: _actor, ...query } = input;
  if (C.getEvaluationCellResultReadQueryIssues(query).length)
    throw new EvaluationManagementError(
      "PLATFORM_INVALID",
      "The evaluation result scope is invalid.",
    );
  return query;
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec("BEGIN");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** Establish current access and exact result scope before any asynchronous file verification. */
export function prepareEvaluationCellResultRead(
  database: DatabaseSync,
  input: Input,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationCellResultReadQuery {
  const query = queryFor(input);
  return transaction(database, () => {
    assertRepositoryPermission(database, input.actor, query.repositoryId, "read", administrators);
    if (!readEvaluationResultIdentityInTransaction(database, query)) missing();
    return query;
  });
}

/** The prepared proof is consumed immediately, after current access and before result projection. */
export function getEvaluationCellResult(
  database: DatabaseSync,
  input: Input,
  administrators: readonly C.OperatorPrincipal[],
  facts?: VerifiedValidationEvidenceFacts,
): C.EvaluationCellResultV1 {
  const query = queryFor(input);
  return transaction(database, () => {
    assertRepositoryPermission(database, input.actor, query.repositoryId, "read", administrators);
    facts?.assertCurrent();
    const selected = readEvaluationResultSelectionInTransaction(database, query);
    if (selected === null) missing();
    const { row, cell, result } = selected;
    const statuses = verificationStatuses(facts);
    const modelReview = normalizedValidationModel(result, row.workflowKind);
    const occurrence = (
      kind: C.FindingOccurrenceRef["kind"],
      ordinal: number,
    ): C.FindingOccurrenceRef => {
      const ref = { resultId: row.id, resultDigest: row.resultDigest, kind, ordinal };
      return { ...ref, key: findingOccurrenceKey(ref) };
    };
    const report = normalizedValidationReport(result);
    const projected: C.EvaluationCellResultV1 = {
      schemaVersion: "EvaluationCellResultV1",
      ...query,
      caseId: cell.plan.purpose.caseId,
      arm: cell.plan.purpose.arm,
      trial: 1,
      runId: row.runId,
      requestId: row.requestId,
      jobId: row.jobId,
      runAttemptId: row.runAttemptId,
      workItemId: row.workItemId,
      sourceId: row.sourceId,
      sourceDigest: row.sourceDigest,
      revisionKey: row.revisionKey,
      planDigest: row.planDigest,
      executionDigest: row.executionDigest,
      profileVersionId: row.profileVersionId,
      promptVersionId: row.promptVersionId,
      workflowKind: row.workflowKind,
      target: row.target,
      resultDigest: row.resultDigest,
      createdAt: row.createdAt,
      modelRequirements: cell.plan.modelRequirements,
      evidenceComplete: currentValidationEvidence(
        database,
        {
          id: row.runId,
          repositoryId: row.repositoryId,
          revisionKey: row.revisionKey,
          planDigest: row.planDigest,
        },
        row.requestId,
        { jobId: row.jobId },
        row,
        result,
        { kind: "prepared", ...(facts === undefined ? {} : { facts }), statuses },
      ),
      ...(statuses.get(verificationKey(row.requestId, row.jobId)) === "pending"
        ? { evidenceVerificationPending: true as const }
        : {}),
      report,
      execution: result.execution,
      modelReview,
      occurrences: [
        ...modelReview.findings.map((finding) => occurrence("pr_finding", finding.ordinal)),
        ...modelReview.observations.map((_observation, ordinal) =>
          occurrence("validation_observation", ordinal),
        ),
      ],
    };
    if (C.getEvaluationCellResultIssues(projected).length)
      throw new EvaluationManagementError(
        "PLATFORM_CORRUPT",
        "The evaluation result projection is invalid.",
      );
    return projected;
  });
}
