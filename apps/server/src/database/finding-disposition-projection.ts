import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  type FindingDisposition,
  FindingDispositionSchema,
  type FindingOccurrenceRef,
  FindingOccurrenceRefSchema,
  JobStateSchema,
  maximumFindingResultOccurrenceCount,
  maximumReviewRunRequestCount,
  Sha256Schema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { validateStoredValidationModelResultBindingInTransaction } from "./validation-model-result-binding.js";

export interface FindingDispositionProjection {
  readonly occurrence: FindingOccurrenceRef;
  readonly disposition: FindingDisposition;
}
export type FindingDispositionProjectionMap = ReadonlyMap<string, FindingDispositionProjection>;

class FindingDispositionProjectionError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "FindingDispositionProjectionError";
  }
}
function corrupt(): never {
  throw new FindingDispositionProjectionError(
    "PLATFORM_CORRUPT",
    "The stored finding disposition projection is invalid.",
  );
}
const resultScopeSchema = Type.Object(
  { resultId: EntityIdSchema, resultDigest: Sha256Schema },
  { additionalProperties: false },
);
const runScopeSchema = Type.Object(
  { repositoryId: EntityIdSchema, reviewRunId: EntityIdSchema },
  { additionalProperties: false },
);
// This low-level reader validates timestamps itself and does not depend on a globally registered
// TypeBox date-time callback, which may not exist before the HTTP application starts.
const dispositionMetadataSchema = Type.Object(
  { ...FindingDispositionSchema.properties, updatedAt: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
export function findingOccurrenceKey(input: Omit<FindingOccurrenceRef, "key">): string {
  return sha256(canonicalJson({ schemaVersion: "FindingOccurrenceV1", ...input }));
}
export function initialFindingDisposition(): FindingDisposition {
  return { state: "open", version: 0, lastEventId: null, updatedAt: null, updatedBy: null };
}
type Row = Record<string, unknown>;
function timestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function principalText(value: string): boolean {
  return (
    value.isWellFormed() &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

/** Reads the small, trigger-protected projection only. It never loads raw results or audit reasons. */
export function readFindingDispositionProjection(
  database: DatabaseSync,
  input: { readonly resultId: string; readonly resultDigest: string },
): FindingDispositionProjectionMap {
  if (!Value.Check(resultScopeSchema, input))
    throw new FindingDispositionProjectionError(
      "PLATFORM_INVALID",
      "The finding result scope is invalid.",
    );
  const result = database
    .prepare(`SELECT id, result_digest, repository_id, review_run_id,
    request_id, job_id FROM validation_job_results WHERE id = ?`)
    .get(input.resultId) as Row | undefined;
  if (!result || result.result_digest !== input.resultDigest) corrupt();
  const rows = database
    .prepare(`SELECT p.result_id, p.result_digest, p.repository_id, p.review_run_id,
    p.request_id, p.job_id, p.kind, p.ordinal, p.occurrence_key, p.state, p.version, p.last_event_id,
    p.created_at, p.updated_at, p.updated_by_issuer, p.updated_by_subject,
    (event.id IS NOT NULL AND event.result_id IS p.result_id AND event.kind IS p.kind
      AND event.ordinal IS p.ordinal AND event.repository_id IS p.repository_id
      AND event.review_run_id IS p.review_run_id AND event.request_id IS p.request_id
      AND event.job_id IS p.job_id AND event.result_digest IS p.result_digest
      AND event.occurrence_key IS p.occurrence_key AND event.state IS p.state
      AND event.version IS p.version AND event.previous_version IS p.version - 1
      AND event.state IS CASE event.action WHEN 'accept' THEN 'accepted' WHEN 'dismiss' THEN 'dismissed'
        WHEN 'resolve' THEN 'resolved' WHEN 'reopen' THEN 'open' END
      AND event.previous_state IS NOT event.state
      AND event.created_at IS p.updated_at AND event.actor_issuer IS p.updated_by_issuer
      AND event.actor_subject IS p.updated_by_subject AND first.created_at IS p.created_at
      AND first.previous_version IS 0 AND first.previous_state IS 'open'
      AND NOT EXISTS (SELECT 1 FROM finding_disposition_events AS later
        WHERE later.result_id = p.result_id AND later.kind = p.kind AND later.ordinal = p.ordinal
          AND later.version > p.version)) AS event_matches
    FROM finding_dispositions AS p
    LEFT JOIN finding_disposition_events AS event ON event.id = p.last_event_id
    LEFT JOIN finding_disposition_events AS first ON first.result_id = p.result_id
      AND first.kind = p.kind AND first.ordinal = p.ordinal AND first.version = 1
    WHERE p.result_id = ? ORDER BY p.kind, p.ordinal LIMIT 201`)
    .all(input.resultId);
  if (rows.length > maximumFindingResultOccurrenceCount) corrupt();
  const output = new Map<string, FindingDispositionProjection>();
  for (const row of rows) {
    const occurrence = {
      key: row.occurrence_key,
      resultId: row.result_id,
      resultDigest: row.result_digest,
      kind: row.kind,
      ordinal: row.ordinal,
    };
    const disposition = {
      state: row.state,
      version: row.version,
      lastEventId: row.last_event_id,
      updatedAt: row.updated_at,
      updatedBy: { issuer: row.updated_by_issuer, subject: row.updated_by_subject },
    };
    if (
      !Value.Check(FindingOccurrenceRefSchema, occurrence) ||
      !Value.Check(dispositionMetadataSchema, disposition)
    )
      corrupt();
    if (
      row.event_matches !== 1 ||
      row.result_id !== input.resultId ||
      row.result_digest !== input.resultDigest ||
      ["repository_id", "review_run_id", "request_id", "job_id"].some(
        (key) => row[key] !== result[key],
      ) ||
      occurrence.key !==
        findingOccurrenceKey({
          resultId: occurrence.resultId,
          resultDigest: occurrence.resultDigest,
          kind: occurrence.kind,
          ordinal: occurrence.ordinal,
        }) ||
      disposition.version < 1 ||
      disposition.lastEventId === null ||
      disposition.updatedBy === null ||
      !timestamp(row.created_at) ||
      !timestamp(disposition.updatedAt) ||
      String(row.created_at) > String(disposition.updatedAt) ||
      !principalText(disposition.updatedBy.issuer) ||
      !principalText(disposition.updatedBy.subject) ||
      output.has(occurrence.key)
    )
      corrupt();
    output.set(occurrence.key, { occurrence, disposition });
  }
  return output;
}

function compactProjection(projection: FindingDispositionProjectionMap) {
  return [...projection.values()]
    .sort((left, right) => left.occurrence.key.localeCompare(right.occurrence.key))
    .map(({ occurrence, disposition }) => ({
      ...occurrence,
      state: disposition.state,
      version: disposition.version,
      lastEventId: disposition.lastEventId,
    }));
}
export function findingResultDispositionDigest(
  input: { readonly resultId: string; readonly resultDigest: string },
  projection: FindingDispositionProjectionMap,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: "FindingResultDispositionV1",
      ...input,
      dispositions: compactProjection(projection),
    }),
  );
}

/** Bind every planned request, including optional and missing results, to its latest activation.
 * The immutable result digest represents untouched open occurrences; only explicit dispositions
 * need projection rows. V2 results require independent owner binding before contributing.
 * Old activations cannot contribute to a current approval snapshot. */
export function currentRunFindingDispositionDigest(
  database: DatabaseSync,
  input: { readonly repositoryId: string; readonly reviewRunId: string },
): string {
  if (!database.isTransaction || !Value.Check(runScopeSchema, input))
    throw new FindingDispositionProjectionError(
      "PLATFORM_INVALID",
      "An existing transaction and valid run scope are required.",
    );
  const run = database
    .prepare(
      "SELECT request_count FROM review_runs WHERE repository_id = ? AND id = ? AND purpose = 'review'",
    )
    .get(input.repositoryId, input.reviewRunId) as Row | undefined;
  if (!run) corrupt();
  const rows = database
    .prepare(`SELECT request.request_id, request.workflow_kind, request.target,
    request.required, link.job_id, link.activation_number, result.id AS result_id,
    result.result_digest, result.schema_id, result.run_attempt_id, job.execution_digest,
    (job.id IS link.job_id AND job.work_item_id IS run.work_item_id
      AND job.request_epoch_id IS run.request_epoch_id AND job.resource_revision IS run.revision_key
      AND job.job_kind IS CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui')
        THEN 'pull_request_review' ELSE 'issue_triage' END) AS job_matches,
    job.status AS job_status,
    (job.status IS 'succeeded' AND attempt.status IS 'succeeded'
      AND result.run_attempt_id IS attempt.id AND result.result_digest IS attempt.result_digest
      AND result.repository_id IS run.repository_id AND result.work_item_id IS run.work_item_id
      AND result.resource_revision IS run.revision_key AND result.revision_id IS run.revision_id
      AND result.review_run_id IS run.id AND result.request_id IS request.request_id
      AND result.activation_id IS run.activation_id AND result.job_activation IS link.activation_number
      AND result.plan_digest IS run.plan_digest
      AND result.schema_id IN ('ValidationJobResultV1', 'ValidationJobResultV2')
      AND result.job_kind IS job.job_kind AND result.workflow_kind IS request.workflow_kind
      AND result.target IS request.target AND result.profile_version_id IS request.profile_version_id
      AND result.prompt_version_id IS request.prompt_version_id
      AND result.execution_template_sha256 IS job.execution_digest) AS result_matches
    FROM review_run_requests AS request JOIN review_runs AS run ON run.id = request.review_run_id
    LEFT JOIN review_run_job_links AS link ON link.review_run_id = request.review_run_id
      AND link.request_id = request.request_id AND link.activation_number = (
        SELECT MAX(latest.activation_number) FROM review_run_job_links AS latest
        WHERE latest.review_run_id = request.review_run_id AND latest.request_id = request.request_id)
    LEFT JOIN jobs AS job ON job.id = link.job_id
    LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id AND attempt.attempt_number = job.attempt_count
    LEFT JOIN validation_job_results AS result ON result.job_id = job.id
    WHERE run.repository_id = ? AND run.id = ? AND run.purpose = 'review' ORDER BY request.request_id LIMIT 33`)
    .all(input.repositoryId, input.reviewRunId);
  if (
    rows.length < 1 ||
    rows.length > maximumReviewRunRequestCount ||
    rows.length !== run.request_count ||
    new Set(rows.map((row) => row.request_id)).size !== rows.length
  )
    corrupt();
  let count = 0;
  const requests = rows.map((row) => {
    if (
      !Value.Check(EntityIdSchema, row.request_id) ||
      !Value.Check(WorkflowKindSchema, row.workflow_kind) ||
      !Value.Check(ValidationTargetSchema, row.target) ||
      (row.required !== 0 && row.required !== 1) ||
      (row.job_id === null) !== (row.activation_number === null) ||
      (row.job_id !== null &&
        (!Value.Check(EntityIdSchema, row.job_id) ||
          !Value.Check(JobStateSchema, row.job_status) ||
          row.job_matches !== 1 ||
          !Number.isSafeInteger(row.activation_number) ||
          Number(row.activation_number) < 1)) ||
      (row.result_id === null) !== (row.result_digest === null) ||
      (row.job_status === "succeeded" && row.result_id === null) ||
      (row.result_id !== null && row.result_matches !== 1)
    )
      corrupt();
    let result = null;
    if (row.result_id !== null) {
      if (
        !Value.Check(EntityIdSchema, row.result_id) ||
        !Value.Check(Sha256Schema, row.result_digest)
      )
        corrupt();
      try {
        validateStoredValidationModelResultBindingInTransaction(database, {
          resultId: row.result_id,
          schemaId: String(row.schema_id),
          repositoryId: input.repositoryId,
          runId: input.reviewRunId,
          requestId: String(row.request_id),
          jobId: String(row.job_id),
          runAttemptId: String(row.run_attempt_id),
          resultDigest: row.result_digest,
          executionDigest: String(row.execution_digest),
        });
      } catch {
        corrupt();
      }
      const resultScope = { resultId: row.result_id, resultDigest: row.result_digest };
      const projection = readFindingDispositionProjection(database, resultScope);
      count += projection.size;
      if (count > maximumReviewRunRequestCount * maximumFindingResultOccurrenceCount) corrupt();
      result = { ...resultScope, dispositions: compactProjection(projection) };
    }
    return {
      requestId: row.request_id,
      workflowKind: row.workflow_kind,
      target: row.target,
      required: row.required === 1,
      jobId: row.job_id,
      activationNumber: row.activation_number,
      result,
    };
  });
  return sha256(
    canonicalJson({ schemaVersion: "CurrentRunFindingDispositionsV1", ...input, requests }),
  );
}
