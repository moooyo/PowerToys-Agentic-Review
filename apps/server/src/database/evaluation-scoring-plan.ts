import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { freezeEvaluationScoringPlan } from "@agentic-review/domain";
import { canonicalJson } from "../scheduling/canonical-json.js";
import {
  EvaluationManagementError,
  type PublishedEvaluationSuite,
  readPublishedEvaluationSuiteInTransaction,
} from "./evaluation-management.js";

function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The stored evaluation adjudication binding is inconsistent.",
  );
}
function parseCanonical(serialized: string | null): unknown {
  if (
    serialized === null ||
    Buffer.byteLength(serialized, "utf8") > C.maximumEvaluationScoringInputUtf8Bytes
  )
    corrupt();
  try {
    const value: unknown = JSON.parse(serialized);
    if (canonicalJson(value) !== serialized) corrupt();
    return value;
  } catch {
    return corrupt();
  }
}

/** Reads the sealed scoring expectations and their complete published source binding. */
export function readEvaluationScoringPlanInTransaction(
  database: DatabaseSync,
  scope: { readonly repositoryId: string; readonly evaluationId: string },
  actor: C.OperatorPrincipal,
  administrators: readonly C.OperatorPrincipal[],
): {
  readonly frozen: ReturnType<typeof freezeEvaluationScoringPlan>;
  readonly published: PublishedEvaluationSuite;
} {
  if (!database.isTransaction)
    throw new EvaluationManagementError(
      "PLATFORM_INVALID",
      "Reading a frozen evaluation scoring plan requires an existing transaction.",
    );
  const header = database
    .prepare(`SELECT evaluation.scoring_plan_digest AS digest,
    CASE WHEN length(CAST(evaluation.scoring_plan_json AS BLOB)) <= ? THEN evaluation.scoring_plan_json END AS json,
    evaluation.suite_version_id AS suiteVersionId, evaluation.source_version_id AS sourceVersionId,
    evaluation.expectation_version_id AS expectationVersionId, version.suite_id AS suiteId
    FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_suite_versions AS version ON version.id = evaluation.suite_version_id AND version.repository_id = evaluation.repository_id
    WHERE evaluation.id = ? AND evaluation.repository_id = ?`)
    .get(C.maximumEvaluationScoringInputUtf8Bytes, scope.evaluationId, scope.repositoryId) as
    | {
        digest: string;
        json: string | null;
        suiteVersionId: string;
        sourceVersionId: string;
        expectationVersionId: string;
        suiteId: string;
      }
    | undefined;
  if (!header) corrupt();
  const plan = parseCanonical(header.json);
  let frozen: ReturnType<typeof freezeEvaluationScoringPlan>;
  try {
    frozen = freezeEvaluationScoringPlan(plan);
  } catch {
    return corrupt();
  }
  const published = readPublishedEvaluationSuiteInTransaction(
    database,
    {
      repositoryId: scope.repositoryId,
      actor,
      suiteId: header.suiteId,
      versionId: header.suiteVersionId,
    },
    administrators,
  );
  if (
    frozen.digest !== header.digest ||
    frozen.plan.repositoryId !== scope.repositoryId ||
    frozen.plan.evaluationId !== scope.evaluationId ||
    frozen.plan.sampleSetVersionId !== header.suiteVersionId ||
    frozen.plan.expectationVersionId !== header.expectationVersionId ||
    header.sourceVersionId !== published.version.sourceVersionId ||
    header.expectationVersionId !== published.version.expectationVersionId ||
    frozen.plan.cases.length !== published.version.caseCount ||
    frozen.plan.cases.some((entry) => {
      const original = published.expectationManifest.cases.find(
        (item) => item.caseId === entry.caseId,
      );
      const source = published.sourceManifest.cases.find((item) => item.caseId === entry.caseId);
      return (
        !original ||
        !source ||
        entry.sourceDigest !== source.sourceDigest ||
        canonicalJson({
          caseId: entry.caseId,
          applicability: entry.applicability,
          findings: entry.findings,
          criteria: entry.criteria.map(
            ({ baselineCheckId: _baseline, candidateCheckId: _candidate, ...criterion }) =>
              criterion,
          ),
        }) !==
          canonicalJson({
            caseId: original.caseId,
            applicability: original.applicability,
            findings: original.findings,
            criteria: original.criteria,
          })
      );
    })
  )
    corrupt();
  return { frozen, published };
}
