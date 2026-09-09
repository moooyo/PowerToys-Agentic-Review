import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { readEvaluationBatchScoringProjectionInTransaction } from "./evaluation-queries.js";

export interface EvaluationBatchEvidenceQuery {
  readonly repositoryId: string;
  readonly evaluationId: string;
}
export interface EvaluationBatchEvidenceSelection {
  readonly selectionDigest: string;
  readonly cells: readonly {
    readonly cellId: string;
    readonly requestId: string;
    readonly jobId: string | null;
    readonly resultId: string | null;
  }[];
}
const scopeSchema = Type.Object(
  { repositoryId: C.EntityIdSchema, evaluationId: C.EntityIdSchema },
  { additionalProperties: false },
);

function invalid(): never {
  throw new EvaluationManagementError(
    "PLATFORM_INVALID",
    "The evaluation batch selection scope is invalid.",
  );
}

/** Includes the complete sealed matrix, including pending cells and absent results. No file proof is implied. */
export function readEvaluationBatchEvidenceSelectionInTransaction(
  database: DatabaseSync,
  scope: EvaluationBatchEvidenceQuery,
): EvaluationBatchEvidenceSelection {
  if (!database.isTransaction)
    throw new EvaluationManagementError(
      "PLATFORM_CORRUPT",
      "Evaluation selection requires an owner transaction.",
    );
  if (
    !Value.Check(scopeSchema, scope) ||
    Object.values(scope).some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u.test(id))
  )
    invalid();
  const projection = readEvaluationBatchScoringProjectionInTransaction(database, scope);
  const identity = database
    .prepare(`SELECT scoring_plan_digest AS scoringPlanDigest,
    source_manifest_sha256 AS sourceManifestDigest, configuration_manifest_sha256 AS configurationManifestDigest,
    cell_manifest_sha256 AS cellManifestDigest, execution_manifest_sha256 AS executionManifestDigest,
    source_version_id AS sourceVersionId, expectation_version_id AS expectationVersionId
    FROM evaluations WHERE repository_id = ? AND id = ?`)
    .get(scope.repositoryId, scope.evaluationId);
  if (
    !identity ||
    Object.entries(identity).some(
      ([key, value]) =>
        !Value.Check(key.endsWith("Digest") ? C.Sha256Schema : C.EntityIdSchema, value),
    )
  )
    throw new EvaluationManagementError(
      "PLATFORM_CORRUPT",
      "The sealed evaluation selection identity is inconsistent.",
    );
  return {
    selectionDigest: sha256(
      canonicalJson({ schemaVersion: "EvaluationBatchSelectionV1", identity, projection }),
    ),
    cells: projection.cells.map((cell) => ({
      cellId: cell.cellId,
      requestId: cell.requestId,
      jobId: cell.job?.jobId ?? null,
      resultId: cell.result?.resultId ?? null,
    })),
  };
}
