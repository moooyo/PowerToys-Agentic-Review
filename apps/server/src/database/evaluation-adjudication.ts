import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import {
  type EvaluationResultSelection,
  readEvaluationResultSelectionInTransaction,
} from "./evaluation-result-selection.js";
import { readEvaluationScoringPlanInTransaction } from "./evaluation-scoring-plan.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { assertRepositoryPermission } from "./operator-access.js";
import { normalizedValidationModel } from "./validation-result-projection.js";

type ResultScope = C.EvaluationCellResultReadQuery & { readonly actor: C.OperatorPrincipal };
type OccurrenceScope = C.EvaluationAdjudicationScope & { readonly actor: C.OperatorPrincipal };
export interface EvaluationAdjudicationOperationMap {
  getEvaluationAdjudicationContext: {
    input: ResultScope;
    output: C.EvaluationAdjudicationContextV1;
  };
  changeEvaluationAdjudication: {
    input: OccurrenceScope & {
      readonly request: C.EvaluationAdjudicationChangeRequest;
      readonly replayOnly?: true;
    };
    output: C.EvaluationAdjudicationChangeV1;
  };
  listEvaluationAdjudicationHistory: {
    input: OccurrenceScope & { readonly query: C.EvaluationAdjudicationHistoryQuery };
    output: C.EvaluationAdjudicationHistoryV1;
  };
}
export type EvaluationAdjudicationOperation = keyof EvaluationAdjudicationOperationMap;
export type EvaluationAdjudicationRequest = {
  [K in EvaluationAdjudicationOperation]: {
    readonly operation: K;
    readonly input: EvaluationAdjudicationOperationMap[K]["input"];
  };
}[EvaluationAdjudicationOperation];
type ChangeInput = EvaluationAdjudicationOperationMap["changeEvaluationAdjudication"]["input"];
const strict = { additionalProperties: false } as const;
const resultScope = {
  ...C.EvaluationCellResultReadQuerySchema.properties,
  actor: C.OperatorPrincipalSchema,
};
const occurrenceScope = {
  ...C.EvaluationAdjudicationScopeSchema.properties,
  actor: C.OperatorPrincipalSchema,
};
const schemas = {
  getEvaluationAdjudicationContext: Type.Object(resultScope, strict),
  changeEvaluationAdjudication: Type.Object(
    {
      ...occurrenceScope,
      request: C.EvaluationAdjudicationChangeRequestSchema,
      replayOnly: Type.Optional(Type.Literal(true)),
    },
    strict,
  ),
  listEvaluationAdjudicationHistory: Type.Object(
    { ...occurrenceScope, query: C.EvaluationAdjudicationHistoryQuerySchema },
    strict,
  ),
};
export function isEvaluationAdjudicationOperation(
  operation: string,
): operation is EvaluationAdjudicationOperation {
  return Object.hasOwn(schemas, operation);
}
function fail(
  code: ConstructorParameters<typeof EvaluationManagementError>[0],
  message: string,
): never {
  throw new EvaluationManagementError(code, message);
}
function corrupt(): never {
  fail("PLATFORM_CORRUPT", "The stored evaluation adjudication binding is inconsistent.");
}
function missing(): never {
  fail("PLATFORM_NOT_FOUND", "The evaluation result or occurrence was not found.");
}
function conflict(message = "The evaluation adjudication changed. Reload before saving."): never {
  fail("PLATFORM_CONFLICT", message);
}
function queryFor(input: ResultScope): C.EvaluationCellResultReadQuery {
  return {
    repositoryId: input.repositoryId,
    evaluationId: input.evaluationId,
    cellId: input.cellId,
    resultId: input.resultId,
  };
}
function scopeFor(input: OccurrenceScope): C.EvaluationAdjudicationScope {
  return { ...queryFor(input), occurrenceKey: input.occurrenceKey };
}
function parseCanonical(serialized: string | null, maximum: number): unknown {
  if (serialized === null || Buffer.byteLength(serialized, "utf8") > maximum) corrupt();
  try {
    const value: unknown = JSON.parse(serialized);
    if (canonicalJson(value) !== serialized) corrupt();
    return value;
  } catch {
    return corrupt();
  }
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction;
  const name = `evaluation_adjudication_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${name}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = action();
    database.exec(nested ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
    return value;
  } catch (error) {
    try {
      if (database.isTransaction) {
        if (nested) {
          database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          database.exec(`RELEASE SAVEPOINT ${name}`);
        } else database.exec("ROLLBACK");
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Evaluation adjudication rollback failed.", {
        cause: error,
      });
    }
    throw error;
  }
}

interface JudgmentBinding {
  readonly caseId: string;
  readonly arm: C.EvaluationArm;
  readonly resultId: string;
  readonly resultDigest: string;
  readonly occurrences: readonly C.FindingOccurrenceRef[];
  readonly expectations: C.EvaluationFindingExpectations;
}

/** Pure current-set validation only; this function grants no persistence or result authority. */
export function evaluationAdjudicationSetIssues(
  binding: JudgmentBinding,
  judgments: readonly C.EvaluationFindingAdjudication[],
): string[] {
  try {
    C.assertEvaluationFindingAdjudications(judgments);
  } catch {
    return ["The selected judgments must match the adjudication contract."];
  }
  const keys = new Set(binding.occurrences.map((entry) => entry.key));
  const expected = new Set(binding.expectations.expected.map((entry) => entry.expectedFindingId));
  const selected = new Map<string, C.EvaluationFindingAdjudication>();
  const events = new Set<string>(),
    matches = new Set<string>();
  const issues: string[] = [];
  for (const judgment of judgments) {
    if (
      judgment.caseId !== binding.caseId ||
      judgment.arm !== binding.arm ||
      judgment.resultId !== binding.resultId ||
      judgment.resultDigest !== binding.resultDigest ||
      !keys.has(judgment.occurrenceKey) ||
      selected.has(judgment.occurrenceKey) ||
      events.has(judgment.adjudicationId)
    )
      issues.push("Each selected judgment must identify one actual occurrence in this result.");
    selected.set(judgment.occurrenceKey, judgment);
    events.add(judgment.adjudicationId);
    if (judgment.kind === "match") {
      if (!expected.has(judgment.expectedFindingId) || matches.has(judgment.expectedFindingId))
        issues.push("Each frozen expected finding may have only one matched primary occurrence.");
      matches.add(judgment.expectedFindingId);
    }
  }
  for (const judgment of judgments)
    if (
      judgment.kind === "duplicate" &&
      (judgment.primaryOccurrenceKey === judgment.occurrenceKey ||
        selected.get(judgment.primaryOccurrenceKey)?.kind !== "match")
    )
      issues.push(
        "A duplicate must refer directly to a matched primary occurrence in the same result.",
      );
  return issues;
}

interface BoundResult extends JudgmentBinding {
  readonly selection: EvaluationResultSelection;
  readonly modelRequired: boolean;
  readonly modelState: C.DashboardValidationModelReview["state"];
}
function boundResult(
  database: DatabaseSync,
  input: ResultScope,
  administrators: readonly C.OperatorPrincipal[],
): BoundResult {
  const selection = readEvaluationResultSelectionInTransaction(database, queryFor(input));
  if (selection === null) missing();
  const { frozen } = readEvaluationScoringPlanInTransaction(
    database,
    { repositoryId: input.repositoryId, evaluationId: input.evaluationId },
    input.actor,
    administrators,
  );
  const purpose = selection.cell.plan.purpose;
  const expected = frozen.plan.cases.find((entry) => entry.caseId === purpose.caseId);
  if (
    !expected ||
    expected.sourceDigest !== selection.row.sourceDigest ||
    expected[`${purpose.arm}Binding`].cellId !== selection.cell.cellId ||
    expected[`${purpose.arm}Binding`].runId !== selection.cell.runId ||
    expected[`${purpose.arm}Binding`].requestId !== selection.cell.requestId ||
    frozen.plan[purpose.arm].profileVersionId !== selection.row.profileVersionId ||
    frozen.plan[purpose.arm].promptVersionId !== selection.row.promptVersionId ||
    frozen.plan[purpose.arm].modelIdentityDigest !==
      selection.cell.plan.modelRequirements.expectedModelIdentityDigest
  )
    corrupt();
  const cells = database
    .prepare(`SELECT id, arm, run_id AS runId, request_id AS requestId FROM evaluation_cells
    WHERE evaluation_id = ? AND repository_id = ? AND case_id = ?`)
    .all(input.evaluationId, input.repositoryId, expected.caseId) as {
    id: string;
    arm: C.EvaluationArm;
    runId: string;
    requestId: string;
  }[];
  if (
    cells.length !== 2 ||
    new Set(cells.map((cell) => cell.arm)).size !== 2 ||
    cells.some(
      (cell) =>
        canonicalJson(expected[`${cell.arm}Binding`]) !==
        canonicalJson({ cellId: cell.id, runId: cell.runId, requestId: cell.requestId }),
    )
  )
    corrupt();
  const model = normalizedValidationModel(selection.result, selection.row.workflowKind);
  const occurrence = (
    kind: C.FindingOccurrenceRef["kind"],
    ordinal: number,
  ): C.FindingOccurrenceRef => {
    const ref = {
      resultId: selection.row.id,
      resultDigest: selection.row.resultDigest,
      kind,
      ordinal,
    };
    return { ...ref, key: findingOccurrenceKey(ref) };
  };
  const occurrences = [
    ...model.findings.map((finding) => occurrence("pr_finding", finding.ordinal)),
    ...model.observations.map((_finding, ordinal) => occurrence("validation_observation", ordinal)),
  ];
  return {
    selection,
    caseId: expected.caseId,
    arm: purpose.arm,
    resultId: selection.row.id,
    resultDigest: selection.row.resultDigest,
    expectations: expected.findings,
    occurrences,
    modelRequired: selection.cell.plan.modelRequirements.required,
    modelState: model.state,
  };
}

interface EventRow {
  id: string;
  evaluation_id: string;
  repository_id: string;
  cell_id: string;
  result_id: string;
  result_digest: string;
  occurrence_key: string;
  version: number;
  previous_event_id: string | null;
  adjudication_json: string | null;
  actor_issuer: string;
  actor_subject: string;
  change_id: string;
  created_at: string;
}
const eventColumns = `event.id, event.evaluation_id, event.repository_id, event.cell_id, event.result_id,
  event.result_digest, event.occurrence_key, event.version, event.previous_event_id,
  CASE WHEN length(CAST(event.adjudication_json AS BLOB)) <= 16384 THEN event.adjudication_json END AS adjudication_json,
  event.actor_issuer, event.actor_subject, event.change_id, event.created_at`;
function readEvent(
  database: DatabaseSync,
  row: EventRow,
  scope: C.EvaluationAdjudicationScope,
  resultDigest: string,
): C.EvaluationFindingAdjudication {
  const adjudication = parseCanonical(
    row.adjudication_json,
    16384,
  ) as C.EvaluationFindingAdjudication;
  const response = {
    schemaVersion: "EvaluationAdjudicationChangeV1",
    scope,
    previousVersion: row.version - 1,
    version: row.version,
    adjudication,
  };
  if (
    C.getEvaluationAdjudicationChangeIssues(response).length ||
    row.repository_id !== scope.repositoryId ||
    row.evaluation_id !== scope.evaluationId ||
    row.cell_id !== scope.cellId ||
    row.result_id !== scope.resultId ||
    row.result_digest !== resultDigest ||
    row.occurrence_key !== scope.occurrenceKey ||
    adjudication.adjudicationId !== row.id ||
    adjudication.resultDigest !== resultDigest ||
    adjudication.actor.issuer !== row.actor_issuer ||
    adjudication.actor.subject !== row.actor_subject ||
    adjudication.createdAt !== row.created_at ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at ||
    (row.version === 1
      ? row.previous_event_id !== null
      : row.previous_event_id === null ||
        !database
          .prepare(`SELECT 1 FROM evaluation_adjudication_events
      WHERE id = ? AND cell_id = ? AND result_id = ? AND result_digest = ? AND occurrence_key = ? AND version = ?`)
          .get(
            row.previous_event_id,
            scope.cellId,
            scope.resultId,
            resultDigest,
            scope.occurrenceKey,
            row.version - 1,
          ))
  )
    corrupt();
  return adjudication;
}
interface CurrentEvent {
  readonly row: EventRow;
  readonly adjudication: C.EvaluationFindingAdjudication;
}
function currentEvents(
  database: DatabaseSync,
  input: ResultScope,
  bound: BoundResult,
): Map<string, CurrentEvent> {
  const rows = database
    .prepare(`SELECT ${eventColumns} FROM evaluation_adjudication_events AS event
    WHERE event.cell_id = ? AND event.result_id = ? AND event.result_digest = ?
      AND event.version = (SELECT MAX(latest.version) FROM evaluation_adjudication_events AS latest
        WHERE latest.cell_id = event.cell_id AND latest.result_id = event.result_id
          AND latest.result_digest = event.result_digest AND latest.occurrence_key = event.occurrence_key)
    ORDER BY event.occurrence_key LIMIT ?`)
    .all(
      input.cellId,
      input.resultId,
      bound.resultDigest,
      C.maximumFindingResultOccurrenceCount + 1,
    ) as unknown as EventRow[];
  if (rows.length > C.maximumFindingResultOccurrenceCount) corrupt();
  const current = new Map<string, CurrentEvent>();
  for (const row of rows) {
    const adjudication = readEvent(
      database,
      row,
      { ...queryFor(input), occurrenceKey: row.occurrence_key },
      bound.resultDigest,
    );
    if (current.has(row.occurrence_key)) corrupt();
    current.set(row.occurrence_key, { row, adjudication });
  }
  if (
    evaluationAdjudicationSetIssues(
      bound,
      [...current.values()].map((entry) => entry.adjudication),
    ).length
  )
    corrupt();
  return current;
}
/** Shared projection for reads and pre-insert aggregate budgets; it grants no write authority. */
export function evaluationAdjudicationContextProjection(
  scope: C.EvaluationCellResultReadQuery,
  bound: JudgmentBinding & {
    readonly modelRequired: boolean;
    readonly modelState: C.DashboardValidationModelReview["state"];
  },
  current: ReadonlyMap<
    string,
    { readonly version: number; readonly adjudication: C.EvaluationFindingAdjudication }
  >,
): C.EvaluationAdjudicationContextV1 {
  return {
    schemaVersion: "EvaluationAdjudicationContextV1",
    scope,
    resultDigest: bound.resultDigest,
    caseId: bound.caseId,
    arm: bound.arm,
    modelRequired: bound.modelRequired,
    modelState: bound.modelState,
    expectations: bound.expectations,
    items: bound.occurrences.map((occurrence) => {
      const selected = current.get(occurrence.key);
      return {
        occurrence,
        version: selected?.version ?? 0,
        adjudication: selected?.adjudication ?? null,
      };
    }),
  };
}
function selectedJudgments(current: ReadonlyMap<string, CurrentEvent>) {
  return new Map(
    [...current].map(([key, value]) => [
      key,
      { version: value.row.version, adjudication: value.adjudication },
    ]),
  );
}

/** Counts the proposed current JSON array from SQL byte aggregates, without parsing other cells. */
export function assertEvaluationAdjudicationSnapshotBudget(input: {
  readonly currentCount: number;
  readonly currentEventBytes: number;
  readonly replacedEventBytes: number | null;
  readonly proposedEventJson: string;
}): { readonly count: number; readonly utf8Bytes: number } {
  const invalid = (): never =>
    fail(
      "PLATFORM_INVALID",
      "The proposed current adjudications exceed the supported batch snapshot budget.",
    );
  if (
    !Number.isSafeInteger(input.currentCount) ||
    input.currentCount < 0 ||
    !Number.isSafeInteger(input.currentEventBytes) ||
    input.currentEventBytes < 0 ||
    (input.currentCount === 0 && input.currentEventBytes !== 0) ||
    (input.replacedEventBytes !== null &&
      (!Number.isSafeInteger(input.replacedEventBytes) ||
        input.replacedEventBytes < 1 ||
        input.currentCount === 0 ||
        input.replacedEventBytes > input.currentEventBytes))
  )
    invalid();
  const count = input.currentCount + (input.replacedEventBytes === null ? 1 : 0);
  const eventBytes =
    input.currentEventBytes -
    (input.replacedEventBytes ?? 0) +
    Buffer.byteLength(input.proposedEventJson, "utf8");
  const utf8Bytes = 2 + eventBytes + Math.max(0, count - 1);
  if (
    !Number.isSafeInteger(count) ||
    count > C.maximumEvaluationAdjudicationCount ||
    !Number.isSafeInteger(utf8Bytes) ||
    utf8Bytes > C.maximumEvaluationScoringInputUtf8Bytes
  )
    invalid();
  return { count, utf8Bytes };
}

function assertBatchSnapshotBudget(
  database: DatabaseSync,
  input: ResultScope,
  selected: CurrentEvent | undefined,
  eventJson: string,
): void {
  const current = database
    .prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(CAST(event.adjudication_json AS BLOB))), 0) AS eventBytes
    FROM evaluation_adjudication_events AS event
    WHERE event.repository_id = ? AND event.evaluation_id = ?
      AND event.version = (SELECT MAX(latest.version) FROM evaluation_adjudication_events AS latest
        WHERE latest.repository_id = event.repository_id AND latest.evaluation_id = event.evaluation_id
          AND latest.cell_id = event.cell_id AND latest.result_id = event.result_id
          AND latest.result_digest = event.result_digest AND latest.occurrence_key = event.occurrence_key)`)
    .get(input.repositoryId, input.evaluationId) as { count: number; eventBytes: number };
  assertEvaluationAdjudicationSnapshotBudget({
    currentCount: current.count,
    currentEventBytes: current.eventBytes,
    replacedEventBytes: selected
      ? Buffer.byteLength(canonicalJson(selected.adjudication), "utf8")
      : null,
    proposedEventJson: eventJson,
  });
}

function context(
  database: DatabaseSync,
  input: ResultScope,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationAdjudicationContextV1 {
  const bound = boundResult(database, input, administrators),
    current = currentEvents(database, input, bound);
  const response = evaluationAdjudicationContextProjection(
    queryFor(input),
    bound,
    selectedJudgments(current),
  );
  if (C.getEvaluationAdjudicationContextIssues(response).length) corrupt();
  return response;
}
function requireOccurrence(bound: BoundResult, key: string): void {
  if (!bound.occurrences.some((entry) => entry.key === key)) missing();
}
function history(
  database: DatabaseSync,
  input: EvaluationAdjudicationOperationMap["listEvaluationAdjudicationHistory"]["input"],
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationAdjudicationHistoryV1 {
  const bound = boundResult(database, input, administrators);
  requireOccurrence(bound, input.occurrenceKey);
  const parameters = [input.cellId, input.resultId, bound.resultDigest, input.occurrenceKey];
  const counts = database
    .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(version), 0) AS version FROM evaluation_adjudication_events
    WHERE cell_id = ? AND result_id = ? AND result_digest = ? AND occurrence_key = ?`)
    .get(...parameters) as { count: number; version: number };
  if (!Number.isSafeInteger(counts.count) || counts.count !== counts.version) corrupt();
  const page = input.query.page ?? 1,
    pageSize = input.query.pageSize ?? 20;
  const rows = database
    .prepare(`SELECT ${eventColumns} FROM evaluation_adjudication_events AS event
    WHERE event.cell_id = ? AND event.result_id = ? AND event.result_digest = ? AND event.occurrence_key = ?
    ORDER BY event.version DESC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize) as unknown as EventRow[];
  const scope = scopeFor(input);
  const response: C.EvaluationAdjudicationHistoryV1 = {
    schemaVersion: "EvaluationAdjudicationHistoryV1",
    scope,
    resultDigest: bound.resultDigest,
    page,
    pageSize,
    total: counts.count,
    items: rows.map((row) => {
      const adjudication = readEvent(database, row, scope, bound.resultDigest);
      if (adjudication.caseId !== bound.caseId || adjudication.arm !== bound.arm) corrupt();
      return { version: row.version, previousEventId: row.previous_event_id, adjudication };
    }),
  };
  if (C.getEvaluationAdjudicationHistoryIssues(response).length) corrupt();
  return response;
}

function intentDigest(input: ChangeInput): string {
  const { replayOnly: _replayOnly, ...intent } = input;
  return sha256(canonicalJson({ operation: "changeEvaluationAdjudication", input: intent }));
}
function replay(
  database: DatabaseSync,
  input: ChangeInput,
  digest: string,
): C.EvaluationAdjudicationChangeV1 | null {
  const receipt = database
    .prepare(`SELECT operation, entity_id, intent_digest, actor_issuer, actor_subject,
    previous_version, version, response_json, created_at FROM evaluation_mutation_receipts
    WHERE repository_id = ? AND change_id = ?`)
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
    receipt.operation !== "finding_adjudicated" ||
    receipt.intent_digest !== digest ||
    receipt.actor_issuer !== input.actor.issuer ||
    receipt.actor_subject !== input.actor.subject
  )
    conflict("The evaluation change ID belongs to another operation, scope, payload, or operator.");
  const response = parseCanonical(
    receipt.response_json,
    C.maximumEvaluationAdjudicationChangeUtf8Bytes,
  ) as C.EvaluationAdjudicationChangeV1;
  if (
    C.getEvaluationAdjudicationChangeIssues(response).length ||
    canonicalJson(response.scope) !== canonicalJson(scopeFor(input)) ||
    response.previousVersion !== input.request.expectedVersion ||
    receipt.previous_version !== response.previousVersion ||
    receipt.version !== response.version ||
    response.adjudication.adjudicationId !== receipt.entity_id ||
    response.adjudication.resultDigest !== input.request.resultDigest ||
    response.adjudication.createdAt !== receipt.created_at ||
    canonicalJson(response.adjudication.actor) !== canonicalJson(input.actor)
  )
    corrupt();
  const {
    adjudicationId: _id,
    caseId: _caseId,
    arm: _arm,
    resultId: _resultId,
    resultDigest: _resultDigest,
    occurrenceKey: _occurrence,
    actor: _actor,
    createdAt: _createdAt,
    ...judgment
  } = response.adjudication;
  if (canonicalJson(judgment) !== canonicalJson(input.request.judgment)) corrupt();
  const row = database
    .prepare(
      `SELECT ${eventColumns} FROM evaluation_adjudication_events AS event WHERE event.id = ?`,
    )
    .get(receipt.entity_id) as EventRow | undefined;
  if (
    !row ||
    row.change_id !== input.request.changeId ||
    row.version !== response.version ||
    canonicalJson(readEvent(database, row, response.scope, response.adjudication.resultDigest)) !==
      canonicalJson(response.adjudication)
  )
    corrupt();
  return response;
}
function change(
  database: DatabaseSync,
  input: ChangeInput,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  readOnly: boolean,
): C.EvaluationAdjudicationChangeV1 {
  const digest = intentDigest(input),
    previous = replay(database, input, digest);
  if (previous !== null) return previous;
  if (readOnly)
    fail(
      "DATABASE_READ_ONLY",
      "Recovery maintenance permits existing adjudication receipt replay only.",
    );
  const bound = boundResult(database, input, administrators);
  if (bound.resultDigest !== input.request.resultDigest)
    conflict("The requested result digest does not match this immutable result.");
  requireOccurrence(bound, input.occurrenceKey);
  if (!bound.modelRequired || bound.modelState !== "completed")
    fail(
      "PLATFORM_INVALID",
      "Only a required completed model result can receive finding adjudications.",
    );
  const current = currentEvents(database, input, bound),
    selected = current.get(input.occurrenceKey);
  const version = selected?.row.version ?? 0;
  if (version !== input.request.expectedVersion) conflict();
  if (version >= Number.MAX_SAFE_INTEGER) conflict("The adjudication version limit was reached.");
  const judgment = input.request.judgment;
  if (
    judgment.kind === "match" &&
    !bound.expectations.expected.some(
      (entry) => entry.expectedFindingId === judgment.expectedFindingId,
    )
  )
    fail("PLATFORM_INVALID", "The requested expected finding does not belong to this frozen case.");
  const adjudication: C.EvaluationFindingAdjudication = {
    ...judgment,
    adjudicationId: randomUUID(),
    caseId: bound.caseId,
    arm: bound.arm,
    resultId: input.resultId,
    resultDigest: bound.resultDigest,
    occurrenceKey: input.occurrenceKey,
    actor: { ...input.actor },
    createdAt: now,
  };
  const proposed = [...current.values()]
    .filter((entry) => entry.adjudication.occurrenceKey !== input.occurrenceKey)
    .map((entry) => entry.adjudication);
  proposed.push(adjudication);
  if (evaluationAdjudicationSetIssues(bound, proposed).length)
    conflict(
      "The change would invalidate a current match or duplicate relationship. Update dependent judgments explicitly first.",
    );
  const proposedCurrent = selectedJudgments(current);
  proposedCurrent.set(input.occurrenceKey, { version: version + 1, adjudication });
  const proposedContext = evaluationAdjudicationContextProjection(
    queryFor(input),
    bound,
    proposedCurrent,
  );
  if (C.getEvaluationAdjudicationContextIssues(proposedContext).length)
    fail("PLATFORM_INVALID", "The proposed current judgments exceed the supported context budget.");
  const response: C.EvaluationAdjudicationChangeV1 = {
    schemaVersion: "EvaluationAdjudicationChangeV1",
    scope: scopeFor(input),
    previousVersion: version,
    version: version + 1,
    adjudication,
  };
  if (C.getEvaluationAdjudicationChangeIssues(response).length) corrupt();
  const eventJson = canonicalJson(adjudication),
    responseJson = canonicalJson(response);
  if (
    Buffer.byteLength(eventJson, "utf8") > 16384 ||
    Buffer.byteLength(responseJson, "utf8") > 262144
  )
    fail(
      "PLATFORM_INVALID",
      "The adjudication event or response exceeds the supported byte limit.",
    );
  assertBatchSnapshotBudget(database, input, selected, eventJson);
  database
    .prepare(`INSERT INTO evaluation_adjudication_events
    (id,evaluation_id,repository_id,cell_id,result_id,result_digest,occurrence_key,version,previous_event_id,adjudication_json,actor_issuer,actor_subject,change_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      adjudication.adjudicationId,
      input.evaluationId,
      input.repositoryId,
      input.cellId,
      input.resultId,
      bound.resultDigest,
      input.occurrenceKey,
      version + 1,
      selected?.row.id ?? null,
      eventJson,
      input.actor.issuer,
      input.actor.subject,
      input.request.changeId,
      now,
    );
  database
    .prepare(`INSERT INTO evaluation_mutation_receipts
    (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
    VALUES (?,?,'finding_adjudicated',?,?,?,?,?,?,?,?)`)
    .run(
      input.repositoryId,
      input.request.changeId,
      adjudication.adjudicationId,
      digest,
      input.actor.issuer,
      input.actor.subject,
      version,
      version + 1,
      responseJson,
      now,
    );
  return response;
}

/** Current permission, exact receipt replay, CAS and append-only writes share one owner transaction. */
export function handleEvaluationAdjudicationRequest(
  database: DatabaseSync,
  request: EvaluationAdjudicationRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): EvaluationAdjudicationOperationMap[EvaluationAdjudicationOperation]["output"] {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !isEvaluationAdjudicationOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input) ||
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    fail("PLATFORM_INVALID", "The evaluation adjudication request is invalid.");
  if (
    C.getEvaluationCellResultReadQueryIssues(queryFor(request.input)).length ||
    (request.operation !== "getEvaluationAdjudicationContext" &&
      C.getEvaluationAdjudicationScopeIssues(scopeFor(request.input)).length) ||
    (request.operation === "changeEvaluationAdjudication" &&
      C.getEvaluationAdjudicationChangeRequestIssues(request.input.request).length) ||
    (request.operation === "listEvaluationAdjudicationHistory" &&
      C.getEvaluationAdjudicationHistoryQueryIssues(request.input.query).length)
  )
    fail("PLATFORM_INVALID", "The evaluation adjudication scope, payload or page is invalid.");
  const mutation = request.operation === "changeEvaluationAdjudication";
  const readOnly =
    options.readOnly === true ||
    ("replayOnly" in request.input && request.input.replayOnly === true);
  return transaction(database, mutation && !readOnly, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      mutation ? "review" : "read",
      administrators,
    );
    switch (request.operation) {
      case "getEvaluationAdjudicationContext":
        return context(database, request.input, administrators);
      case "listEvaluationAdjudicationHistory":
        return history(database, request.input, administrators);
      case "changeEvaluationAdjudication":
        return change(database, request.input, now, administrators, readOnly);
    }
  });
}
