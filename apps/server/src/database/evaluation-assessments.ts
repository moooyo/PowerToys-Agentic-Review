import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import {
  captureEvaluationObservations,
  EVALUATION_SCORING_RULES_VERSION,
  scoreEvaluation,
} from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import {
  captureEvaluationScoreInputsInTransaction,
  evaluationScoreInputDigest,
  type VerifiedEvaluationBatchEvidenceFacts,
} from "./evaluation-observations.js";
import { readEvaluationResultSelectionInTransaction } from "./evaluation-result-selection.js";
import { readEvaluationScoringPlanInTransaction } from "./evaluation-scoring-plan.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { assertRepositoryPermission } from "./operator-access.js";
import { normalizedValidationModel } from "./validation-result-projection.js";

export const EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE =
  "The requested report page exceeds its snapshot read budget. Reduce pageSize.";
const maximumAssessmentPageSnapshotBytes = 64 * 1024 * 1024;

type Scope = C.EvaluationAssessmentScope & { readonly actor: C.OperatorPrincipal };
export interface EvaluationAssessmentOperationMap {
  getEvaluationScorePreview: { input: Scope; output: C.EvaluationScorePreviewV1 };
  publishEvaluationAssessment: {
    input: Scope & {
      readonly request: C.EvaluationAssessmentPublishRequest;
      readonly replayOnly?: true;
    };
    output: C.EvaluationAssessmentSummaryV1;
  };
  listEvaluationAssessments: {
    input: Scope & { readonly query: C.EvaluationAssessmentListQuery };
    output: C.EvaluationAssessmentListV1;
  };
  getEvaluationAssessment: {
    input: C.EvaluationAssessmentReadQuery & { readonly actor: C.OperatorPrincipal };
    output: C.EvaluationAssessmentSummaryV1;
  };
  getEvaluationAssessmentCase: {
    input: C.EvaluationAssessmentCaseReadQuery & { readonly actor: C.OperatorPrincipal };
    output: C.EvaluationAssessmentCaseV1;
  };
}
export type EvaluationAssessmentOperation = keyof EvaluationAssessmentOperationMap;
export type EvaluationAssessmentRequest = {
  [K in EvaluationAssessmentOperation]: {
    readonly operation: K;
    readonly input: EvaluationAssessmentOperationMap[K]["input"];
  };
}[EvaluationAssessmentOperation];
export type EvaluationAssessmentCaptureRequest = Extract<
  EvaluationAssessmentRequest,
  {
    readonly operation: "getEvaluationScorePreview" | "publishEvaluationAssessment";
  }
>;
export type PreparedEvaluationAssessmentRequest =
  | { readonly kind: "replay"; readonly assessment: C.EvaluationAssessmentSummaryV1 }
  | { readonly kind: "capture"; readonly scope: C.EvaluationAssessmentScope };
type PublishInput = EvaluationAssessmentOperationMap["publishEvaluationAssessment"]["input"];
export interface EvaluationAssessmentOptions {
  readonly readOnly?: boolean;
  readonly facts?: VerifiedEvaluationBatchEvidenceFacts;
}
const strict = { additionalProperties: false } as const;
const scopeProperties = {
  ...C.EvaluationAssessmentScopeSchema.properties,
  actor: C.OperatorPrincipalSchema,
};
const schemas = {
  getEvaluationScorePreview: Type.Object(scopeProperties, strict),
  publishEvaluationAssessment: Type.Object(
    {
      ...scopeProperties,
      request: C.EvaluationAssessmentPublishRequestSchema,
      replayOnly: Type.Optional(Type.Literal(true)),
    },
    strict,
  ),
  listEvaluationAssessments: Type.Object(
    { ...scopeProperties, query: C.EvaluationAssessmentListQuerySchema },
    strict,
  ),
  getEvaluationAssessment: Type.Object(
    { ...C.EvaluationAssessmentReadQuerySchema.properties, actor: C.OperatorPrincipalSchema },
    strict,
  ),
  getEvaluationAssessmentCase: Type.Object(
    { ...C.EvaluationAssessmentCaseReadQuerySchema.properties, actor: C.OperatorPrincipalSchema },
    strict,
  ),
};
export function isEvaluationAssessmentOperation(
  operation: string,
): operation is EvaluationAssessmentOperation {
  return Object.hasOwn(schemas, operation);
}
function invalid(message = "The evaluation assessment request is invalid."): never {
  throw new EvaluationManagementError("PLATFORM_INVALID", message);
}
function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The stored evaluation assessment is inconsistent.",
  );
}
function missing(): never {
  throw new EvaluationManagementError(
    "PLATFORM_NOT_FOUND",
    "The evaluation assessment or case was not found.",
  );
}
function conflict(message: string): never {
  throw new EvaluationManagementError("PLATFORM_CONFLICT", message);
}
function scopeFor(input: C.EvaluationAssessmentScope): C.EvaluationAssessmentScope {
  return { repositoryId: input.repositoryId, evaluationId: input.evaluationId };
}
function timestamp(now: string): void {
  if (
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid();
}
function validateRequest(request: EvaluationAssessmentRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !isEvaluationAssessmentOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input)
  )
    invalid();
  if (C.getEvaluationAssessmentScopeIssues(scopeFor(request.input)).length) invalid();
  switch (request.operation) {
    case "publishEvaluationAssessment":
      if (C.getEvaluationAssessmentPublishRequestIssues(request.input.request).length) invalid();
      break;
    case "listEvaluationAssessments":
      if (C.getEvaluationAssessmentListQueryIssues(request.input.query).length) invalid();
      break;
    case "getEvaluationAssessment":
      if (
        C.getEvaluationAssessmentReadQueryIssues({
          ...scopeFor(request.input),
          assessmentId: request.input.assessmentId,
        }).length
      )
        invalid();
      break;
    case "getEvaluationAssessmentCase":
      if (
        C.getEvaluationAssessmentCaseReadQueryIssues({
          ...scopeFor(request.input),
          assessmentId: request.input.assessmentId,
          caseId: request.input.caseId,
        }).length
      )
        invalid();
      break;
  }
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction,
    name = `evaluation_assessment_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${name}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = action();
    database.exec(nested ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      if (database.isTransaction) {
        if (nested) {
          database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          database.exec(`RELEASE SAVEPOINT ${name}`);
        } else database.exec("ROLLBACK");
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Evaluation assessment rollback failed.", {
        cause: error,
      });
    }
    throw error;
  }
}
function requireEvaluation(database: DatabaseSync, scope: C.EvaluationAssessmentScope): void {
  if (
    !database
      .prepare(`SELECT 1 FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    WHERE evaluation.repository_id = ? AND evaluation.id = ?`)
      .get(scope.repositoryId, scope.evaluationId)
  )
    missing();
}
function currentVersion(database: DatabaseSync, scope: C.EvaluationAssessmentScope): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(version), 0) AS version FROM evaluation_assessments
    WHERE repository_id = ? AND evaluation_id = ?`)
    .get(scope.repositoryId, scope.evaluationId) as { count: number; version: number };
  if (!Number.isSafeInteger(row.version) || row.version < 0 || row.count !== row.version) corrupt();
  return row.version;
}
function parseCanonical(serialized: string | null, digest?: string): unknown {
  if (
    serialized === null ||
    Buffer.byteLength(serialized, "utf8") > C.maximumEvaluationScoringInputUtf8Bytes ||
    (digest !== undefined && sha256(serialized) !== digest)
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
function reportSummary(report: C.EvaluationScoringReportV1): C.EvaluationScoringSummaryV1 {
  const { schemaVersion: _schemaVersion, cases: _cases, ...summary } = report;
  return summary;
}
interface AssessmentRow {
  id: string;
  repository_id: string;
  evaluation_id: string;
  version: number;
  scorer_version: string;
  scoring_plan_digest: string;
  observation_digest: string;
  adjudication_digest: string;
  report_digest: string;
  observation_json: string | null;
  adjudication_json: string | null;
  report_json: string | null;
  actor_issuer: string;
  actor_subject: string;
  change_id: string;
  created_at: string;
  frozen_plan_digest: string;
}
interface StoredAssessment {
  row: AssessmentRow;
  summary: C.EvaluationAssessmentSummaryV1;
  report: C.EvaluationScoringReportV1;
  cases: ReadonlyMap<string, C.EvaluationAssessmentCaseV1>;
}
interface HistoricalResultFacts {
  readonly provenance: NonNullable<C.EvaluationOwnerObservation["result"]>;
  readonly sourceState: C.EvaluationOwnerObservation["sourceState"];
  readonly checks: ReadonlyMap<string, C.EvaluationOwnerObservation["checks"][number]["outcome"]>;
  readonly modelState: ReturnType<typeof normalizedValidationModel>["state"];
  readonly occurrenceKeys: ReadonlySet<string>;
}
interface HistoricalAdjudicationFacts {
  readonly scope: C.EvaluationAdjudicationScope;
  readonly resultDigest: string;
  readonly version: number;
  readonly canonicalDigest: string;
}
const rowColumns = `assessment.id, assessment.repository_id, assessment.evaluation_id, assessment.version, assessment.scorer_version,
  assessment.scoring_plan_digest, assessment.observation_digest, assessment.adjudication_digest, assessment.report_digest,
  CASE WHEN length(CAST(assessment.observation_json AS BLOB)) <= 16777216 THEN assessment.observation_json END AS observation_json,
  CASE WHEN length(CAST(assessment.adjudication_json AS BLOB)) <= 16777216 THEN assessment.adjudication_json END AS adjudication_json,
  CASE WHEN length(CAST(assessment.report_json AS BLOB)) <= 16777216 THEN assessment.report_json END AS report_json,
  assessment.actor_issuer, assessment.actor_subject, assessment.change_id, assessment.created_at,
  evaluation.scoring_plan_digest AS frozen_plan_digest`;
function readStored(
  database: DatabaseSync,
  scope: C.EvaluationAssessmentReadQuery,
  actor: C.OperatorPrincipal,
  administrators: readonly C.OperatorPrincipal[],
): StoredAssessment {
  return createAssessmentReader(database, scope, actor, administrators)(scope.assessmentId);
}

/** This private reader exists only inside one synchronous owner transaction and fixed scope. */
function createAssessmentReader(
  database: DatabaseSync,
  input: C.EvaluationAssessmentScope,
  actor: C.OperatorPrincipal,
  administrators: readonly C.OperatorPrincipal[],
): (assessmentId: string) => StoredAssessment {
  if (!database.isTransaction) corrupt();
  const scope = scopeFor(input);
  const { frozen, published } = readEvaluationScoringPlanInTransaction(
    database,
    scope,
    actor,
    administrators,
  );
  const expectedByCase = new Map(frozen.plan.cases.map((entry) => [entry.caseId, entry]));
  const titleByCase = new Map(
    published.expectationManifest.cases.map((entry) => [entry.caseId, entry.title]),
  );
  const sourceByCase = new Map(
    published.sourceManifest.cases.map((entry) => [entry.caseId, entry]),
  );
  const resultFacts = new Map<string, HistoricalResultFacts>();
  const readResult = (cellId: string, resultId: string): HistoricalResultFacts => {
    if (!database.isTransaction) corrupt();
    const query = { ...scope, cellId, resultId };
    const key = canonicalJson(query);
    const cached = resultFacts.get(key);
    if (cached) return cached;
    // Each sealed cell has at most one Job, and validation results are unique per Job.
    if (resultFacts.size >= frozen.plan.cases.length * 2) corrupt();
    const selected = readEvaluationResultSelectionInTransaction(database, query);
    if (!selected) corrupt();
    const { row, result } = selected;
    const model = normalizedValidationModel(result, row.workflowKind);
    const occurrence = (kind: C.FindingOccurrenceRef["kind"], ordinal: number) =>
      findingOccurrenceKey({ resultId: row.id, resultDigest: row.resultDigest, kind, ordinal });
    const facts: HistoricalResultFacts = {
      provenance: {
        resultId: row.id,
        resultDigest: row.resultDigest,
        jobId: row.jobId,
        runAttemptId: row.runAttemptId,
        profileVersionId: row.profileVersionId,
        promptVersionId: row.promptVersionId,
        executionDigest: row.executionDigest,
        sourceDigest: row.sourceDigest,
      },
      sourceState: result.report.sourceState,
      checks: new Map(result.report.checks.map((check) => [check.id, check.outcome])),
      modelState: model.state,
      occurrenceKeys: new Set([
        ...model.findings.map((finding) => occurrence("pr_finding", finding.ordinal)),
        ...model.observations.map((_finding, ordinal) =>
          occurrence("validation_observation", ordinal),
        ),
      ]),
    };
    resultFacts.set(key, facts);
    return facts;
  };
  const adjudicationFacts = new Map<string, HistoricalAdjudicationFacts>();
  const assertAdjudication = (cellId: string, judgment: C.EvaluationFindingAdjudication): void => {
    if (!database.isTransaction) corrupt();
    let facts = adjudicationFacts.get(judgment.adjudicationId);
    if (!facts) {
      const row = database
        .prepare(`SELECT id, repository_id AS repositoryId, evaluation_id AS evaluationId,
        cell_id AS cellId, result_id AS resultId, result_digest AS resultDigest, occurrence_key AS occurrenceKey,
        version, previous_event_id AS previousEventId, actor_issuer AS actorIssuer, actor_subject AS actorSubject,
        created_at AS createdAt, CASE WHEN length(CAST(adjudication_json AS BLOB)) <= 16384
          THEN adjudication_json END AS adjudicationJson
        FROM evaluation_adjudication_events WHERE id = ? AND repository_id = ? AND evaluation_id = ?`)
        .get(judgment.adjudicationId, scope.repositoryId, scope.evaluationId) as unknown as
        | {
            id: string;
            repositoryId: string;
            evaluationId: string;
            cellId: string;
            resultId: string;
            resultDigest: string;
            occurrenceKey: string;
            version: number;
            previousEventId: string | null;
            actorIssuer: string;
            actorSubject: string;
            createdAt: string;
            adjudicationJson: string | null;
          }
        | undefined;
      if (!row) corrupt();
      const actual = parseCanonical(row.adjudicationJson) as C.EvaluationFindingAdjudication;
      const eventScope = {
        ...scope,
        cellId: row.cellId,
        resultId: row.resultId,
        occurrenceKey: row.occurrenceKey,
      };
      if (
        C.getEvaluationAdjudicationChangeIssues({
          schemaVersion: "EvaluationAdjudicationChangeV1",
          scope: eventScope,
          previousVersion: row.version - 1,
          version: row.version,
          adjudication: actual,
        }).length ||
        row.repositoryId !== scope.repositoryId ||
        row.evaluationId !== scope.evaluationId ||
        actual.adjudicationId !== row.id ||
        actual.resultId !== row.resultId ||
        actual.resultDigest !== row.resultDigest ||
        actual.occurrenceKey !== row.occurrenceKey ||
        actual.actor.issuer !== row.actorIssuer ||
        actual.actor.subject !== row.actorSubject ||
        actual.createdAt !== row.createdAt ||
        expectedByCase.get(actual.caseId)?.[`${actual.arm}Binding`].cellId !== row.cellId ||
        !Number.isFinite(Date.parse(row.createdAt)) ||
        new Date(row.createdAt).toISOString() !== row.createdAt ||
        (row.version === 1
          ? row.previousEventId !== null
          : row.previousEventId === null ||
            !database
              .prepare(`SELECT 1
          FROM evaluation_adjudication_events WHERE id = ? AND repository_id = ? AND evaluation_id = ?
            AND cell_id = ? AND result_id = ? AND result_digest = ? AND occurrence_key = ? AND version = ?`)
              .get(
                row.previousEventId,
                scope.repositoryId,
                scope.evaluationId,
                row.cellId,
                row.resultId,
                row.resultDigest,
                row.occurrenceKey,
                row.version - 1,
              ))
      )
        corrupt();
      facts = {
        scope: eventScope,
        resultDigest: row.resultDigest,
        version: row.version,
        canonicalDigest: sha256(canonicalJson(actual)),
      };
      // A page may contain several historical versions; bound the cache without retaining event text.
      if (adjudicationFacts.size >= C.maximumEvaluationAdjudicationCount) {
        const oldest = adjudicationFacts.keys().next().value;
        if (oldest !== undefined) adjudicationFacts.delete(oldest);
      }
      adjudicationFacts.set(judgment.adjudicationId, facts);
    }
    if (
      facts.scope.cellId !== cellId ||
      facts.scope.resultId !== judgment.resultId ||
      facts.scope.occurrenceKey !== judgment.occurrenceKey ||
      facts.resultDigest !== judgment.resultDigest ||
      facts.canonicalDigest !== sha256(canonicalJson(judgment))
    )
      corrupt();
  };
  return (assessmentId) => {
    if (!database.isTransaction) corrupt();
    return readStoredWithPlan(
      database,
      { ...scope, assessmentId },
      frozen,
      expectedByCase,
      titleByCase,
      sourceByCase,
      readResult,
      assertAdjudication,
    );
  };
}

function readStoredWithPlan(
  database: DatabaseSync,
  scope: C.EvaluationAssessmentReadQuery,
  frozen: ReturnType<typeof readEvaluationScoringPlanInTransaction>["frozen"],
  expectedByCase: ReadonlyMap<string, C.EvaluationCaseExpectation>,
  titleByCase: ReadonlyMap<string, string>,
  sourceByCase: ReadonlyMap<string, C.EvaluationSourceManifestV1["cases"][number]>,
  readResult: (cellId: string, resultId: string) => HistoricalResultFacts,
  assertAdjudication: (cellId: string, judgment: C.EvaluationFindingAdjudication) => void,
): StoredAssessment {
  const row = database
    .prepare(`SELECT ${rowColumns} FROM evaluation_assessments AS assessment
    JOIN evaluations AS evaluation ON evaluation.id = assessment.evaluation_id AND evaluation.repository_id = assessment.repository_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    WHERE assessment.repository_id = ? AND assessment.evaluation_id = ? AND assessment.id = ?`)
    .get(scope.repositoryId, scope.evaluationId, scope.assessmentId) as unknown as
    | AssessmentRow
    | undefined;
  if (!row) missing();
  const plan = frozen.plan;
  const observations = parseCanonical(row.observation_json, row.observation_digest);
  const adjudications = parseCanonical(row.adjudication_json, row.adjudication_digest);
  const report = parseCanonical(row.report_json, row.report_digest);
  try {
    C.assertEvaluationOwnerObservations(observations);
    C.assertEvaluationFindingAdjudications(adjudications);
    C.assertEvaluationScoringReport(report);
  } catch {
    return corrupt();
  }
  if (
    plan.repositoryId !== scope.repositoryId ||
    plan.evaluationId !== scope.evaluationId ||
    frozen.digest !== row.scoring_plan_digest ||
    row.scoring_plan_digest !== row.frozen_plan_digest ||
    report.planDigest !== row.scoring_plan_digest ||
    report.rulesVersion !== row.scorer_version ||
    canonicalJson(report.cases.map((entry) => entry.caseId)) !==
      canonicalJson(plan.cases.map((entry) => entry.caseId))
  )
    corrupt();
  // These checks validate historical identity and source provenance, never today's score arithmetic.
  try {
    captureEvaluationObservations(frozen, observations);
  } catch {
    return corrupt();
  }
  for (const observed of observations) {
    if (observed.result === null) continue;
    const actual = readResult(observed.cellId, observed.result.resultId);
    if (
      canonicalJson(observed.result) !== canonicalJson(actual.provenance) ||
      observed.sourceState !== actual.sourceState ||
      observed.checks.some((check) => actual.checks.get(check.checkId) !== check.outcome)
    )
      corrupt();
    // Missing historical check observations may reduce coverage; invented checks or outcomes may not.
    if (
      observed.model.state === "complete" &&
      (actual.modelState !== "completed" ||
        observed.model.occurrenceKeys.length !== actual.occurrenceKeys.size ||
        observed.model.occurrenceKeys.some((key) => !actual.occurrenceKeys.has(key)))
    )
      corrupt();
  }
  const judgments = new Map<string, C.EvaluationFindingAdjudication>();
  const eventIds = new Set<string>();
  const matched = new Set<string>();
  for (const judgment of adjudications) {
    const observed = observations.find(
      (entry) => entry.caseId === judgment.caseId && entry.arm === judgment.arm,
    );
    const expected = expectedByCase.get(judgment.caseId);
    const key = `${judgment.caseId}\0${judgment.arm}\0${judgment.occurrenceKey}`;
    if (
      !expected ||
      expected.applicability.state !== "applicable" ||
      !observed?.result ||
      observed.model.state !== "complete" ||
      observed.result.resultId !== judgment.resultId ||
      observed.result.resultDigest !== judgment.resultDigest ||
      !observed.model.occurrenceKeys.includes(judgment.occurrenceKey) ||
      eventIds.has(judgment.adjudicationId) ||
      judgments.has(key)
    )
      corrupt();
    assertAdjudication(observed.cellId, judgment);
    if (judgment.kind === "match") {
      const matchKey = `${judgment.caseId}\0${judgment.arm}\0${judgment.expectedFindingId}`;
      if (
        !expected.findings.expected.some(
          (entry) => entry.expectedFindingId === judgment.expectedFindingId,
        ) ||
        matched.has(matchKey)
      )
        corrupt();
      matched.add(matchKey);
    }
    eventIds.add(judgment.adjudicationId);
    judgments.set(key, judgment);
  }
  for (const judgment of adjudications)
    if (
      judgment.kind === "duplicate" &&
      (judgment.primaryOccurrenceKey === judgment.occurrenceKey ||
        judgments.get(`${judgment.caseId}\0${judgment.arm}\0${judgment.primaryOccurrenceKey}`)
          ?.kind !== "match")
    )
      corrupt();
  const cases = new Map<string, C.EvaluationAssessmentCaseV1>();
  for (const entry of report.cases) {
    const expected = expectedByCase.get(entry.caseId);
    const title = titleByCase.get(entry.caseId);
    if (
      !expected ||
      title === undefined ||
      expected.sourceDigest !== sourceByCase.get(entry.caseId)?.sourceDigest
    )
      corrupt();
    const value = evaluationAssessmentCaseProjection(
      { ...scope, caseId: entry.caseId },
      row.report_digest,
      row.scoring_plan_digest,
      entry,
      title,
      expected,
    );
    if (C.getEvaluationAssessmentCaseIssues(value).length) corrupt();
    for (const arm of ["baseline", "candidate"] as const) {
      const observed = observations.find(
        (item) => item.caseId === entry.caseId && item.arm === arm,
      );
      const actualResult = observed?.result
        ? readResult(observed.cellId, observed.result.resultId)
        : null;
      if (
        entry[arm].executionState !== (observed?.executionState ?? "not_run") ||
        canonicalJson(entry[arm].result) !== canonicalJson(observed?.result ?? null) ||
        entry[arm].criteria.some(
          (criterion) =>
            criterion.checkId !==
              expected.criteria.find((item) => item.criterionId === criterion.criterionId)?.[
                `${arm}CheckId`
              ] ||
            (criterion.actualOutcome !== null &&
              (actualResult === null ||
                criterion.checkId === null ||
                actualResult.checks.get(criterion.checkId) !== criterion.actualOutcome)),
        )
      )
        corrupt();
      const actual =
        observed?.model.state === "complete"
          ? new Set(observed.model.occurrenceKeys)
          : new Set<string>();
      const occurrences = new Set<string>();
      for (const occurrence of entry[arm].findings.occurrences) {
        const judgment = judgments.get(`${entry.caseId}\0${arm}\0${occurrence.occurrenceKey}`);
        if (
          !actual.has(occurrence.occurrenceKey) ||
          occurrences.has(occurrence.occurrenceKey) ||
          (occurrence.adjudicationId === null
            ? occurrence.kind !== "unjudged" || judgment !== undefined
            : judgment?.adjudicationId !== occurrence.adjudicationId ||
              judgment.kind !== occurrence.kind)
        )
          corrupt();
        occurrences.add(occurrence.occurrenceKey);
      }
      for (const finding of entry[arm].findings.expected)
        if (finding.occurrenceKey !== null || finding.adjudicationId !== null) {
          const judgment = judgments.get(`${entry.caseId}\0${arm}\0${finding.occurrenceKey}`);
          if (
            judgment?.kind !== "match" ||
            judgment.expectedFindingId !== finding.expectedFindingId ||
            judgment.adjudicationId !== finding.adjudicationId
          )
            corrupt();
        }
    }
    cases.set(entry.caseId, value);
  }
  const summary: C.EvaluationAssessmentSummaryV1 = {
    schemaVersion: "EvaluationAssessmentSummaryV1",
    ...scopeFor(scope),
    assessmentId: row.id,
    version: row.version,
    scorerVersion: report.rulesVersion,
    scoringPlanDigest: row.scoring_plan_digest,
    observationDigest: row.observation_digest,
    adjudicationDigest: row.adjudication_digest,
    reportDigest: row.report_digest,
    createdAt: row.created_at,
    createdBy: { issuer: row.actor_issuer, subject: row.actor_subject },
    summary: reportSummary(report),
    caseIds: report.cases.map((entry) => entry.caseId),
  };
  // Historical reports retain their original rules version and captured inputs; never rescore here.
  if (
    C.getEvaluationAssessmentPublishResponseIssues(summary).length ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at
  )
    corrupt();
  return { row, summary, report, cases };
}

/** The same complete case envelope is checked before persistence and during historical reads. */
export function evaluationAssessmentCaseProjection(
  scope: C.EvaluationAssessmentCaseReadQuery,
  reportDigest: string,
  scoringPlanDigest: string,
  score: C.EvaluationCaseScore,
  caseTitle: string,
  expectation: C.EvaluationCaseExpectation,
): C.EvaluationAssessmentCaseV1 {
  return {
    schemaVersion: "EvaluationAssessmentCaseV1",
    scope,
    reportDigest,
    scoringPlanDigest,
    caseTitle,
    expectation,
    case: score,
  };
}
function storedCase(
  stored: StoredAssessment,
  input: C.EvaluationAssessmentCaseReadQuery,
): C.EvaluationAssessmentCaseV1 {
  const value = stored.cases.get(input.caseId);
  if (!value) missing();
  return value;
}
function intentDigest(input: PublishInput): string {
  const { replayOnly: _replayOnly, ...intent } = input;
  return sha256(canonicalJson({ operation: "publishEvaluationAssessment", input: intent }));
}
function replay(
  database: DatabaseSync,
  input: PublishInput,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationAssessmentSummaryV1 | null {
  const receipt = database
    .prepare(`SELECT operation, entity_id, intent_digest, actor_issuer, actor_subject,
    previous_version, version, response_json, created_at FROM evaluation_mutation_receipts WHERE repository_id = ? AND change_id = ?`)
    .get(input.repositoryId, input.request.changeId) as
    | {
        operation: string;
        entity_id: string;
        intent_digest: string;
        actor_issuer: string;
        actor_subject: string;
        previous_version: number;
        version: number;
        response_json: string;
        created_at: string;
      }
    | undefined;
  if (!receipt) return null;
  if (
    receipt.operation !== "assessment_published" ||
    receipt.intent_digest !== intentDigest(input) ||
    receipt.actor_issuer !== input.actor.issuer ||
    receipt.actor_subject !== input.actor.subject
  )
    conflict("The evaluation change ID belongs to another operation, scope, payload, or operator.");
  if (
    Buffer.byteLength(receipt.response_json, "utf8") > C.maximumEvaluationAssessmentReceiptUtf8Bytes
  )
    corrupt();
  const response = parseCanonical(receipt.response_json) as C.EvaluationAssessmentSummaryV1;
  if (
    C.getEvaluationAssessmentPublishResponseIssues(response).length ||
    response.repositoryId !== input.repositoryId ||
    response.evaluationId !== input.evaluationId ||
    response.assessmentId !== receipt.entity_id ||
    response.version !== input.request.expectedVersion + 1 ||
    receipt.previous_version !== input.request.expectedVersion ||
    receipt.version !== response.version ||
    response.createdAt !== receipt.created_at ||
    canonicalJson(response.createdBy) !== canonicalJson(input.actor)
  )
    corrupt();
  const stored = readStored(
    database,
    { ...scopeFor(input), assessmentId: receipt.entity_id },
    input.actor,
    administrators,
  );
  if (
    stored.row.change_id !== input.request.changeId ||
    canonicalJson(stored.summary) !== canonicalJson(response) ||
    evaluationScoreInputDigest({
      repositoryId: input.repositoryId,
      evaluationId: input.evaluationId,
      scorerVersion: response.scorerVersion,
      scoringPlanDigest: response.scoringPlanDigest,
      observationDigest: response.observationDigest,
      adjudicationDigest: response.adjudicationDigest,
    }) !== input.request.expectedInputDigest
  )
    corrupt();
  return response;
}
function readOnly(
  input: PublishInput,
  options: Pick<EvaluationAssessmentOptions, "readOnly">,
): boolean {
  return options.readOnly === true || input.replayOnly === true;
}
function assertWritable(
  input: PublishInput,
  options: Pick<EvaluationAssessmentOptions, "readOnly">,
): void {
  if (readOnly(input, options))
    throw new EvaluationManagementError(
      "DATABASE_READ_ONLY",
      "Recovery maintenance permits existing assessment receipt replay only.",
    );
}

export function prepareEvaluationAssessmentRequest(
  database: DatabaseSync,
  request: EvaluationAssessmentCaptureRequest,
  administrators: readonly C.OperatorPrincipal[],
  options: Pick<EvaluationAssessmentOptions, "readOnly"> = {},
): PreparedEvaluationAssessmentRequest {
  validateRequest(request);
  if (
    request.operation !== "getEvaluationScorePreview" &&
    request.operation !== "publishEvaluationAssessment"
  )
    invalid();
  return transaction(database, false, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      request.operation === "publishEvaluationAssessment" ? "review" : "read",
      administrators,
    );
    if (request.operation === "publishEvaluationAssessment") {
      const assessment = replay(database, request.input, administrators);
      if (assessment !== null) return { kind: "replay" as const, assessment };
      assertWritable(request.input, options);
    }
    const scope = scopeFor(request.input);
    requireEvaluation(database, scope);
    return { kind: "capture" as const, scope };
  });
}

function score(
  database: DatabaseSync,
  input: Scope,
  administrators: readonly C.OperatorPrincipal[],
  facts?: VerifiedEvaluationBatchEvidenceFacts,
) {
  const captured = captureEvaluationScoreInputsInTransaction(
    database,
    scopeFor(input),
    input.actor,
    administrators,
    facts,
  );
  const observationJson = canonicalJson(captured.observations),
    adjudicationJson = canonicalJson(captured.adjudications);
  if (
    captured.frozen.plan.repositoryId !== input.repositoryId ||
    captured.frozen.plan.evaluationId !== input.evaluationId ||
    captured.observationDigest !== sha256(observationJson) ||
    captured.adjudicationDigest !== sha256(adjudicationJson) ||
    canonicalJson(captured.captured.observations) !== observationJson ||
    captured.inputDigest !==
      evaluationScoreInputDigest({
        ...scopeFor(input),
        scorerVersion: EVALUATION_SCORING_RULES_VERSION,
        scoringPlanDigest: captured.frozen.digest,
        observationDigest: captured.observationDigest,
        adjudicationDigest: captured.adjudicationDigest,
      })
  )
    corrupt();
  let report: C.EvaluationScoringReportV1;
  try {
    report = scoreEvaluation(captured.frozen, captured.captured, captured.adjudications);
  } catch {
    invalid("The captured evaluation inputs cannot produce a bounded scoring report.");
  }
  if (
    report.rulesVersion !== EVALUATION_SCORING_RULES_VERSION ||
    report.planDigest !== captured.frozen.digest
  )
    corrupt();
  const reportJson = canonicalJson(report);
  if (
    [observationJson, adjudicationJson, reportJson].some(
      (json) => Buffer.byteLength(json, "utf8") > C.maximumEvaluationScoringInputUtf8Bytes,
    )
  )
    invalid("The evaluation assessment snapshot exceeds its supported byte budget.");
  return {
    captured,
    report,
    reportJson,
    reportDigest: sha256(reportJson),
    observationJson,
    adjudicationJson,
  };
}
function preview(
  database: DatabaseSync,
  input: Scope,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  facts?: VerifiedEvaluationBatchEvidenceFacts,
): C.EvaluationScorePreviewV1 {
  const { captured, report } = score(database, input, administrators, facts);
  const value: C.EvaluationScorePreviewV1 = {
    schemaVersion: "EvaluationScorePreviewV1",
    ...scopeFor(input),
    generatedAt: now,
    assessmentVersion: currentVersion(database, input),
    selectionDigest: captured.selectionDigest,
    scoringPlanDigest: captured.frozen.digest,
    observationDigest: captured.observationDigest,
    adjudicationDigest: captured.adjudicationDigest,
    inputDigest: captured.inputDigest,
    summary: reportSummary(report),
    caseIds: report.cases.map((entry) => entry.caseId),
  };
  if (C.getEvaluationScorePreviewIssues(value).length)
    invalid("The score preview exceeds its supported response budget.");
  facts?.assertCurrent();
  return value;
}
function publish(
  database: DatabaseSync,
  input: PublishInput,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: EvaluationAssessmentOptions,
): C.EvaluationAssessmentSummaryV1 {
  const previous = replay(database, input, administrators);
  if (previous !== null) return previous;
  assertWritable(input, options);
  requireEvaluation(database, input);
  const scored = score(database, input, administrators, options.facts);
  if (scored.captured.inputDigest !== input.request.expectedInputDigest)
    conflict("The scoring inputs changed. Refresh the preview before publishing.");
  const version = currentVersion(database, input);
  if (version !== input.request.expectedVersion || version >= Number.MAX_SAFE_INTEGER)
    conflict("The assessment version changed. Reload before publishing.");
  const assessmentId = randomUUID();
  const value: C.EvaluationAssessmentSummaryV1 = {
    schemaVersion: "EvaluationAssessmentSummaryV1",
    ...scopeFor(input),
    assessmentId,
    version: version + 1,
    scorerVersion: scored.report.rulesVersion,
    scoringPlanDigest: scored.captured.frozen.digest,
    observationDigest: scored.captured.observationDigest,
    adjudicationDigest: scored.captured.adjudicationDigest,
    reportDigest: scored.reportDigest,
    createdAt: now,
    createdBy: { ...input.actor },
    summary: reportSummary(scored.report),
    caseIds: scored.report.cases.map((entry) => entry.caseId),
  };
  if (C.getEvaluationAssessmentPublishResponseIssues(value).length)
    invalid("The assessment summary exceeds its receipt byte budget.");
  const frozen = readEvaluationScoringPlanInTransaction(
    database,
    input,
    input.actor,
    administrators,
  );
  if (frozen.frozen.digest !== scored.captured.frozen.digest) corrupt();
  for (const entry of scored.report.cases) {
    const expectation = frozen.frozen.plan.cases.find((item) => item.caseId === entry.caseId);
    const original = frozen.published.expectationManifest.cases.find(
      (item) => item.caseId === entry.caseId,
    );
    if (!expectation || !original) corrupt();
    const projected = evaluationAssessmentCaseProjection(
      { ...scopeFor(input), assessmentId, caseId: entry.caseId },
      scored.reportDigest,
      scored.captured.frozen.digest,
      entry,
      original.title,
      expectation,
    );
    if (C.getEvaluationAssessmentCaseIssues(projected).length)
      invalid("An assessment case exceeds its supported response budget.");
  }
  const responseJson = canonicalJson(value);
  options.facts?.assertCurrent();
  database
    .prepare(`INSERT INTO evaluation_assessments
    (id,evaluation_id,repository_id,version,scorer_version,scoring_plan_digest,observation_digest,adjudication_digest,
    observation_json,adjudication_json,report_digest,report_json,actor_issuer,actor_subject,change_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      assessmentId,
      input.evaluationId,
      input.repositoryId,
      version + 1,
      value.scorerVersion,
      value.scoringPlanDigest,
      value.observationDigest,
      value.adjudicationDigest,
      scored.observationJson,
      scored.adjudicationJson,
      scored.reportDigest,
      scored.reportJson,
      input.actor.issuer,
      input.actor.subject,
      input.request.changeId,
      now,
    );
  database
    .prepare(`INSERT INTO evaluation_mutation_receipts
    (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
    VALUES (?,?,'assessment_published',?,?,?,?,?,?,?,?)`)
    .run(
      input.repositoryId,
      input.request.changeId,
      assessmentId,
      intentDigest(input),
      input.actor.issuer,
      input.actor.subject,
      version,
      version + 1,
      responseJson,
      now,
    );
  return value;
}

/** All owner reads and immutable report writes reauthorize inside a synchronous transaction. */
export function handleEvaluationAssessmentRequest(
  database: DatabaseSync,
  request: EvaluationAssessmentRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: EvaluationAssessmentOptions = {},
): EvaluationAssessmentOperationMap[EvaluationAssessmentOperation]["output"] {
  validateRequest(request);
  timestamp(now);
  const mutation = request.operation === "publishEvaluationAssessment";
  const write =
    request.operation === "publishEvaluationAssessment" && !readOnly(request.input, options);
  return transaction(database, write, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      mutation ? "review" : "read",
      administrators,
    );
    if (request.operation === "publishEvaluationAssessment")
      return publish(database, request.input, now, administrators, options);
    const scope = scopeFor(request.input);
    requireEvaluation(database, scope);
    switch (request.operation) {
      case "getEvaluationScorePreview":
        return preview(database, request.input, now, administrators, options.facts);
      case "getEvaluationAssessment":
        return readStored(
          database,
          { ...scope, assessmentId: request.input.assessmentId },
          request.input.actor,
          administrators,
        ).summary;
      case "getEvaluationAssessmentCase": {
        const selected = {
          ...scope,
          assessmentId: request.input.assessmentId,
          caseId: request.input.caseId,
        };
        return storedCase(
          readStored(database, selected, request.input.actor, administrators),
          selected,
        );
      }
      case "listEvaluationAssessments": {
        const page = request.input.query.page ?? 1,
          pageSize = request.input.query.pageSize ?? 20;
        const total = currentVersion(database, scope);
        const rows = database
          .prepare(`SELECT id, length(CAST(observation_json AS BLOB)) AS observation_bytes,
            length(CAST(adjudication_json AS BLOB)) AS adjudication_bytes,
            length(CAST(report_json AS BLOB)) AS report_bytes
          FROM evaluation_assessments WHERE repository_id = ? AND evaluation_id = ?
          ORDER BY version DESC LIMIT ? OFFSET ?`)
          .all(
            scope.repositoryId,
            scope.evaluationId,
            pageSize,
            (page - 1) * pageSize,
          ) as unknown as {
          id: string;
          observation_bytes: number;
          adjudication_bytes: number;
          report_bytes: number;
        }[];
        let snapshotBytes = 0;
        for (const row of rows) {
          for (const bytes of [row.observation_bytes, row.adjudication_bytes, row.report_bytes]) {
            if (
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > C.maximumEvaluationScoringInputUtf8Bytes
            )
              corrupt();
            snapshotBytes += bytes;
          }
          if (snapshotBytes > maximumAssessmentPageSnapshotBytes)
            invalid(EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE);
        }
        // Budget rejection happens before reading source manifests or materializing any snapshot.
        const readAssessment =
          rows.length > 0
            ? createAssessmentReader(database, scope, request.input.actor, administrators)
            : null;
        const value: C.EvaluationAssessmentListV1 = {
          schemaVersion: "EvaluationAssessmentListV1",
          ...scope,
          page,
          pageSize,
          total,
          items: rows.map((row) => {
            if (readAssessment === null) corrupt();
            return readAssessment(row.id).summary;
          }),
        };
        if (C.getEvaluationAssessmentListIssues(value).length) corrupt();
        return value;
      }
    }
  });
}
