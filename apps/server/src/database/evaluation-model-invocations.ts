import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { readModelInvocationHistoryInTransaction } from "./model-invocations.js";
import { assertRepositoryPermission } from "./operator-access.js";

export interface EvaluationModelInvocationOperationMap {
  listEvaluationCellModelInvocations: {
    input: {
      readonly actor: C.OperatorPrincipal;
      readonly repositoryId: string;
      readonly evaluationId: string;
      readonly cellId: string;
      readonly query: C.EvaluationCellInvocationListQuery;
    };
    output: C.EvaluationCellInvocationListV1;
  };
}
export type EvaluationModelInvocationOperation = keyof EvaluationModelInvocationOperationMap;
export type EvaluationModelInvocationRequest = {
  readonly operation: EvaluationModelInvocationOperation;
  readonly input: EvaluationModelInvocationOperationMap[EvaluationModelInvocationOperation]["input"];
};
export function isEvaluationModelInvocationOperation(
  value: string,
): value is EvaluationModelInvocationOperation {
  return value === "listEvaluationCellModelInvocations";
}
const inputSchema = Type.Object(
  {
    actor: C.OperatorPrincipalSchema,
    repositoryId: C.EntityIdSchema,
    evaluationId: C.EntityIdSchema,
    cellId: C.EntityIdSchema,
    query: C.EvaluationCellInvocationListQuerySchema,
  },
  { additionalProperties: false },
);
function fail(code: "PLATFORM_INVALID" | "PLATFORM_NOT_FOUND" | "PLATFORM_CORRUPT"): never {
  throw new EvaluationManagementError(
    code,
    code === "PLATFORM_NOT_FOUND"
      ? "The evaluation cell was not found."
      : code === "PLATFORM_INVALID"
        ? "The invocation history request is invalid."
        : "The stored invocation history is inconsistent.",
  );
}
function transaction<T>(db: DatabaseSync, read: () => T): T {
  if (db.isTransaction) return read();
  db.exec("BEGIN");
  try {
    const value = read();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function handleEvaluationModelInvocationRequest(
  database: DatabaseSync,
  request: EvaluationModelInvocationRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationCellInvocationListV1 {
  if (
    !request ||
    !isEvaluationModelInvocationOperation(request.operation) ||
    !Value.Check(inputSchema, request.input) ||
    C.getEvaluationCellInvocationListQueryIssues(request.input.query).length ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    fail("PLATFORM_INVALID");
  const input = request.input;
  if (
    ![input.repositoryId, input.evaluationId, input.cellId].every((id) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(id),
    )
  )
    fail("PLATFORM_INVALID");
  return transaction(database, () => {
    assertRepositoryPermission(database, input.actor, input.repositoryId, "read", administrators);
    const row = database
      .prepare(
        "SELECT run_id FROM evaluation_cells WHERE id = ? AND evaluation_id = ? AND repository_id = ?",
      )
      .get(input.cellId, input.evaluationId, input.repositoryId) as { run_id: string } | undefined;
    if (!row) fail("PLATFORM_NOT_FOUND");
    const cell = readEvaluationExecutionCellInTransaction(
      database,
      { repositoryId: input.repositoryId, runId: row.run_id },
      now,
    );
    if (!cell || cell.cellId !== input.cellId || cell.evaluationId !== input.evaluationId)
      fail("PLATFORM_CORRUPT");
    const page = input.query.page ?? 1,
      pageSize = input.query.pageSize ?? 10,
      offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) fail("PLATFORM_INVALID");
    const from = `FROM model_invocation_openings AS opening JOIN run_attempts AS attempt ON attempt.id = opening.run_attempt_id
      JOIN review_run_job_links AS link ON link.job_id = attempt.job_id
      WHERE link.review_run_id = ? AND link.request_id = ? AND link.activation_number = 1`;
    const total = (
      database.prepare(`SELECT COUNT(*) AS total ${from}`).get(cell.runId, cell.requestId) as {
        total: number;
      }
    ).total;
    const selected = database
      .prepare(
        `SELECT opening.invocation_id ${from} ORDER BY opening.opened_at DESC, opening.invocation_id DESC LIMIT ? OFFSET ?`,
      )
      .all(cell.runId, cell.requestId, pageSize, offset) as unknown as { invocation_id: string }[];
    let items: C.EvaluationCellInvocationItem[];
    try {
      items = selected.map((entry) =>
        readModelInvocationHistoryInTransaction(
          database,
          {
            repositoryId: input.repositoryId,
            evaluationId: input.evaluationId,
            cellId: input.cellId,
            invocationId: entry.invocation_id,
          },
          now,
        ),
      );
    } catch {
      return fail("PLATFORM_CORRUPT");
    }
    const result: C.EvaluationCellInvocationListV1 = {
      schemaVersion: "EvaluationCellInvocationListV1",
      repositoryId: input.repositoryId,
      evaluationId: input.evaluationId,
      cellId: input.cellId,
      expectedRuntimeRegistration: cell.plan.modelRuntimeRegistration ?? null,
      page,
      pageSize,
      total,
      sampledAt: now,
      items,
    };
    if (C.getEvaluationCellInvocationListIssues(result).length) fail("PLATFORM_CORRUPT");
    return result;
  });
}
