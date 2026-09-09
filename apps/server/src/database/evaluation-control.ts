import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { assertRepositoryPermission } from "./operator-access.js";
import { cancelEvaluationJobInTransaction } from "./validation-dispatch.js";

export interface CancelEvaluationBatchInput {
  readonly repositoryId: string;
  readonly evaluationId: string;
  readonly actor: C.OperatorPrincipal;
  readonly request: C.EvaluationBatchCancelRequest;
  readonly replayOnly?: true;
}
const schema = Type.Object(
  {
    repositoryId: C.EntityIdSchema,
    evaluationId: C.EntityIdSchema,
    actor: C.OperatorPrincipalSchema,
    request: C.EvaluationBatchCancelRequestSchema,
    replayOnly: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
function fail(
  code: ConstructorParameters<typeof EvaluationManagementError>[0],
  message: string,
): never {
  throw new EvaluationManagementError(code, message);
}

/** Cancellation and all Job state transitions share the owner's transaction and replay receipt. */
export function cancelEvaluationBatchInTransaction(
  database: DatabaseSync,
  input: CancelEvaluationBatchInput,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): C.EvaluationBatchCancellationV1 {
  if (
    !database.isTransaction ||
    !Value.Check(schema, input) ||
    !input.request.reason.isWellFormed() ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > 32_768 ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    fail("PLATFORM_INVALID", "The evaluation cancellation input or transaction is invalid.");
  }
  assertRepositoryPermission(
    database,
    input.actor,
    input.repositoryId,
    "configure",
    administrators,
  );
  const intent = sha256(
    canonicalJson({
      operation: "cancelEvaluationBatch",
      input: {
        repositoryId: input.repositoryId,
        evaluationId: input.evaluationId,
        actor: input.actor,
        request: input.request,
      },
    }),
  );
  const previous = database
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
  if (previous) {
    if (
      previous.operation !== "evaluation_cancelled" ||
      previous.entity_id !== input.evaluationId ||
      previous.intent_digest !== intent ||
      previous.actor_issuer !== input.actor.issuer ||
      previous.actor_subject !== input.actor.subject
    ) {
      fail(
        "PLATFORM_CONFLICT",
        "This evaluation change ID belongs to a different action, actor, or intent.",
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(previous.response_json);
    } catch {
      fail("PLATFORM_CORRUPT", "The evaluation cancellation receipt is invalid JSON.");
    }
    if (
      !Value.Check(C.EvaluationBatchCancellationV1Schema, result) ||
      result.repositoryId !== input.repositoryId ||
      result.evaluationId !== input.evaluationId ||
      result.reason !== input.request.reason ||
      result.cancelledAt !== previous.created_at ||
      canonicalJson(result.cancelledBy) !== canonicalJson(input.actor) ||
      previous.previous_version !== 1 ||
      previous.version !== 2 ||
      result.cancelledJobCount + result.cancellationRequestedJobCount > 64 ||
      !database
        .prepare(`SELECT 1 FROM evaluation_controls AS control JOIN evaluations AS evaluation ON evaluation.id = control.evaluation_id
        WHERE evaluation.id = ? AND evaluation.repository_id = ? AND control.status = 'cancelled' AND control.version = 2`)
        .get(input.evaluationId, input.repositoryId)
    )
      fail("PLATFORM_CORRUPT", "The cancellation receipt does not match its final control state.");
    return result;
  }
  if (options.readOnly || input.replayOnly)
    fail(
      "DATABASE_READ_ONLY",
      "Recovery maintenance permits existing cancellation receipt replay only.",
    );
  const control = database
    .prepare(`SELECT control.status, control.version FROM evaluation_controls AS control
    JOIN evaluations AS evaluation ON evaluation.id = control.evaluation_id
    WHERE evaluation.id = ? AND evaluation.repository_id = ?`)
    .get(input.evaluationId, input.repositoryId) as { status: string; version: number } | undefined;
  if (!control) fail("PLATFORM_NOT_FOUND", "The evaluation batch was not found.");
  if (control.status !== "active" || control.version !== input.request.expectedVersion)
    fail("PLATFORM_CONFLICT", "The evaluation control version has changed.");
  const savepoint = `evaluation_cancel_${randomUUID().replaceAll("-", "")}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const changed = database
      .prepare(`UPDATE evaluation_controls SET status = 'cancelled', version = 2,
      actor_issuer = ?, actor_subject = ?, reason = ?, updated_at = ? WHERE evaluation_id = ? AND status = 'active' AND version = 1`)
      .run(input.actor.issuer, input.actor.subject, input.request.reason, now, input.evaluationId);
    if (Number(changed.changes) !== 1)
      fail("PLATFORM_CONFLICT", "The evaluation control changed during cancellation.");
    const jobs = database
      .prepare(`SELECT cell.run_id, cell.request_id, link.job_id FROM evaluation_cells AS cell
      JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id AND link.request_id = cell.request_id
      WHERE cell.evaluation_id = ? AND cell.repository_id = ? ORDER BY cell.id`)
      .all(input.evaluationId, input.repositoryId) as {
      run_id: string;
      request_id: string;
      job_id: string;
    }[];
    if (jobs.length > C.maximumEvaluationCaseCount * 2)
      fail("PLATFORM_CORRUPT", "The evaluation exceeds its complete Job matrix.");
    let cancelledJobCount = 0,
      cancellationRequestedJobCount = 0;
    for (const job of jobs) {
      const result = cancelEvaluationJobInTransaction(
        database,
        {
          repositoryId: input.repositoryId,
          actor: input.actor,
          reviewRunId: job.run_id,
          requestId: job.request_id,
          jobId: job.job_id,
        },
        now,
      );
      if (result.changed && result.jobState === "cancelled") cancelledJobCount += 1;
      if (result.changed && result.jobState === "cancel_requested")
        cancellationRequestedJobCount += 1;
    }
    database
      .prepare(`UPDATE validation_dispatch_checks SET pending = 0 WHERE review_run_id IN (
      SELECT run_id FROM evaluation_cells WHERE evaluation_id = ? AND repository_id = ?)`)
      .run(input.evaluationId, input.repositoryId);
    const result: C.EvaluationBatchCancellationV1 = {
      schemaVersion: "EvaluationBatchCancellationV1",
      evaluationId: input.evaluationId,
      repositoryId: input.repositoryId,
      status: "cancelled",
      version: 2,
      reason: input.request.reason,
      cancelledAt: now,
      cancelledBy: input.actor,
      cancelledJobCount,
      cancellationRequestedJobCount,
    };
    const responseJson = canonicalJson(result);
    database
      .prepare(`INSERT INTO evaluation_mutation_receipts (repository_id, change_id, operation, entity_id, intent_digest,
      actor_issuer, actor_subject, previous_version, version, response_json, created_at)
      VALUES (?, ?, 'evaluation_cancelled', ?, ?, ?, ?, 1, 2, ?, ?)`)
      .run(
        input.repositoryId,
        input.request.changeId,
        input.evaluationId,
        intent,
        input.actor.issuer,
        input.actor.subject,
        responseJson,
        now,
      );
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return JSON.parse(responseJson) as C.EvaluationBatchCancellationV1;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Evaluation cancellation rollback failed.", {
        cause: error,
      });
    }
    throw error;
  }
}
