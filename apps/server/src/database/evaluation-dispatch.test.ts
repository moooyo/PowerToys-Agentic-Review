import type * as C from "@agentic-review/contracts";
import {
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import {
  type CancelEvaluationBatchInput,
  cancelEvaluationBatchInTransaction,
} from "./evaluation-control.js";
import {
  readEvaluationExecutionCellInTransaction,
  readEvaluationJobBindingInTransaction,
} from "./evaluation-execution.js";
import {
  evaluationActor,
  evaluationAdministrator,
  reviseEvaluationManagementSource,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { getJobAdmissionRecord } from "./job-admission.js";
import { authorizeOperatorRequest } from "./operator-request.js";
import { evaluateJobWorkerCapabilities, parseExecutionTemplate } from "./scheduling-eligibility.js";
import {
  handleValidationDispatchRequest,
  type ValidationDispatchOperationMap,
} from "./validation-dispatch.js";

const now = "2026-09-08T04:00:00.000Z",
  cancelledAt = "2026-09-08T04:01:00.000Z";
type Base = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: Base[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
function fixture(
  kind: "issue" | "pull_request" = "issue",
  mode: C.EvaluationBatchMode = "profile_only",
) {
  const value = createEvaluationBatchFixture(kind);
  fixtures.push(value);
  const input = structuredClone(value.input);
  input.request.mode = mode;
  const batch = value.create(input);
  return { ...value, batch };
}
type Fixture = ReturnType<typeof fixture>;
function transaction<T>(value: Base, action: () => T): T {
  value.database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    value.database.exec("COMMIT");
    return result;
  } catch (error) {
    if (value.database.isTransaction) value.database.exec("ROLLBACK");
    throw error;
  }
}
function dispatch(value: Fixture, limit = 128) {
  return handleValidationDispatchRequest(
    value.database,
    { operation: "dispatchPendingReviewRuns", input: { limit } },
    now,
  ) as ValidationDispatchOperationMap["dispatchPendingReviewRuns"]["output"];
}
function cancelInput(value: Fixture): CancelEvaluationBatchInput {
  return {
    repositoryId: value.repositoryId,
    evaluationId: value.batch.id,
    actor: evaluationActor,
    request: {
      changeId: "cancel-evaluation",
      expectedVersion: 1,
      reason: "Stop this evaluation batch.",
    },
  };
}
function cancel(value: Fixture, input = cancelInput(value), options?: { readOnly?: boolean }) {
  return transaction(value, () =>
    cancelEvaluationBatchInTransaction(
      value.database,
      input,
      cancelledAt,
      [evaluationAdministrator],
      options,
    ),
  );
}
function jobs(value: Fixture) {
  return value.database
    .prepare(`SELECT job.id, job.status, job.request_epoch_id, job.execution_json, job.semantic_key,
    job.concurrency_key FROM evaluation_cells AS cell JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id
    JOIN jobs AS job ON job.id = link.job_id WHERE cell.evaluation_id = ? ORDER BY job.id`)
    .all(value.batch.id) as {
    id: string;
    status: string;
    request_epoch_id: null;
    execution_json: string;
    semantic_key: string;
    concurrency_key: string;
  }[];
}

describe("evaluation request dispatch and control", () => {
  it.each(["profile_only", "prompt_and_profile"] as const)(
    "matches the frozen %s requirement independently of the evaluation model gate",
    (mode) => {
      const value = fixture("issue", mode);
      const cell = readEvaluationBatchCells(value.database, value.batch.id).find(
        (item) => item.applicable === 1,
      );
      if (!cell) throw new Error("The applicable evaluation cell is missing.");
      const template = createEvaluationExecutionTemplate({
        runId: cell.run_id,
        plan: cell.plan,
        planDigest: cell.plan_digest,
        frozenPrompt: cell.prompt,
      });
      const labels = { executionEnvelope: "2", validationHeadless: "1", validationEvaluation: "1" };
      expect(evaluateJobWorkerCapabilities(template, [], { labels })).toBe(true);
      expect(
        evaluateJobWorkerCapabilities(template, [], {
          labels: {
            ...labels,
            [workerModelExecutionDisabledLabel]: workerModelExecutionDisabledValue,
          },
        }),
      ).toBe(mode === "profile_only");
      const result = dispatch(value);
      if (mode === "prompt_and_profile") {
        expect(result.createdJobs).toEqual([]);
        expect(result.blockedRequestCount).toBe(2);
      } else expect(result.createdJobs).toHaveLength(2);
    },
  );

  it("uses bounded dispatch to create one distinct Job for each applicable arm without GitHub epochs", () => {
    const value = fixture();
    expect(dispatch(value, 1)).toMatchObject({
      examinedRequestCount: 1,
      createdJobs: [expect.any(Object)],
    });
    expect(dispatch(value, 1)).toMatchObject({
      examinedRequestCount: 1,
      createdJobs: [expect.any(Object)],
    });
    expect(dispatch(value).createdJobs).toEqual([]);
    const rows = jobs(value);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.semantic_key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.concurrency_key)).size).toBe(2);
    for (const row of rows) {
      expect(row.request_epoch_id).toBeNull();
      expect(
        value.database
          .prepare("SELECT COUNT(*) AS count FROM job_request_epochs WHERE job_id = ?")
          .get(row.id),
      ).toEqual({ count: 0 });
      const parsed = parseExecutionTemplate(row.execution_json);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || !("validation" in parsed.template))
        throw new Error("Expected a parsed evaluation template.");
      const template = parsed.template;
      expect(template.validation.schemaVersion).toBe("ValidationJobContextV2");
      const bound = transaction(value, () =>
        readEvaluationJobBindingInTransaction(value.database, row.id, template, now),
      );
      expect(bound.evaluationId).toBe(value.batch.id);
      expect(bound.applicable).toBe(true);
      expect(getJobAdmissionRecord(value.database, row.id)).toMatchObject({
        state: "pending",
        ownershipState: "resolved",
      });
      const labels = { executionEnvelope: "2", validationHeadless: "1" };
      expect(evaluateJobWorkerCapabilities(template, [], { labels })).toBe(false);
      expect(
        evaluateJobWorkerCapabilities(template, [], {
          labels: { ...labels, validationEvaluation: "1" },
        }),
      ).toBe(true);
    }
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("dispatches the original frozen Issue commit after the current source changes", () => {
    const value = fixture();
    reviseEvaluationManagementSource(value, "A different current Issue body.");
    expect(dispatch(value).createdJobs).toHaveLength(2);
    for (const row of jobs(value)) {
      const template = JSON.parse(row.execution_json) as C.EvaluationExecutionTemplate;
      expect(template.validation.source.workItem.body).toBe("The original full report body.");
      expect(template.validation.testedSourceRevision).toEqual({
        kind: "commit",
        headSha: "c".repeat(40),
      });
    }
  });

  it.each(["pull_request", "issue"] as const)(
    "keeps %s Prompt evaluation blocked when verified model identity is missing",
    (kind) => {
      const value = fixture(kind, "prompt_and_profile");
      const result = dispatch(value);
      expect(result.createdJobs).toEqual([]);
      expect(result.blockedRequestCount).toBe(2);
      const checks = value.database
        .prepare(`SELECT blockers_json FROM validation_dispatch_checks WHERE review_run_id IN
      (SELECT run_id FROM evaluation_cells WHERE evaluation_id = ? AND applicable = 1)`)
        .all(value.batch.id) as { blockers_json: string }[];
      expect(checks).toHaveLength(2);
      for (const check of checks)
        expect(JSON.parse(check.blockers_json)).toContainEqual({
          code: "missing_capability",
          capability: "verified_model_identity",
        });
    },
  );

  it("cancels before dispatch without creating Jobs and retains all four frozen cells", () => {
    const value = fixture();
    expect(cancel(value)).toMatchObject({
      status: "cancelled",
      version: 2,
      cancelledJobCount: 0,
      cancellationRequestedJobCount: 0,
    });
    expect(dispatch(value)).toMatchObject({ examinedRequestCount: 0, createdJobs: [] });
    const cells = readEvaluationBatchCells(value.database, value.batch.id);
    expect(cells).toHaveLength(4);
    for (const cell of cells)
      expect(
        transaction(value, () =>
          readEvaluationExecutionCellInTransaction(
            value.database,
            { repositoryId: value.repositoryId, runId: cell.run_id },
            cancelledAt,
          ),
        )?.controlStatus,
      ).toBe("cancelled");
  });

  it("cancels only its queued Jobs, preserving ordinary Jobs, frozen plans, and exact replay", () => {
    const value = fixture();
    const ordinary = value.database.prepare("SELECT id, status FROM jobs ORDER BY id").all() as {
      id: string;
      status: string;
    }[];
    dispatch(value);
    const plans = readEvaluationBatchCells(value.database, value.batch.id).map(
      (cell) => cell.plan_json,
    );
    const first = cancel(value),
      input = cancelInput(value);
    expect(first).toMatchObject({ cancelledJobCount: 2, cancellationRequestedJobCount: 0 });
    expect(jobs(value).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    for (const row of ordinary)
      expect(
        value.database.prepare("SELECT id, status FROM jobs WHERE id = ?").get(row.id),
      ).toEqual(row);
    expect(
      readEvaluationBatchCells(value.database, value.batch.id).map((cell) => cell.plan_json),
    ).toEqual(plans);
    expect(cancel(value, { ...input, replayOnly: true }, { readOnly: true })).toEqual(first);
    expect(dispatch(value).createdJobs).toEqual([]);
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM notification_events").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects ordinary reviewer cancellation of an evaluation Job without changing its batch", () => {
    const value = fixture();
    dispatch(value);
    setEvaluationManagementRole(value.database, value.repositoryId, "reviewer", 1);
    const selected = value.database
      .prepare(`SELECT cell.run_id, cell.request_id, link.job_id FROM evaluation_cells AS cell
      JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id AND link.request_id = cell.request_id
      WHERE cell.evaluation_id = ? AND cell.repository_id = ? ORDER BY cell.id LIMIT 1`)
      .get(value.batch.id, value.repositoryId) as
      | { run_id: string; request_id: string; job_id: string }
      | undefined;
    if (!selected) throw new Error("The fixture requires a dispatched evaluation Job.");
    const authorized = authorizeOperatorRequest(
      value.database,
      {
        context: { kind: "operator", actor: evaluationActor },
        operation: "cancelValidationJob",
        input: {
          repositoryId: value.repositoryId,
          reviewRunId: selected.run_id,
          requestId: selected.request_id,
          jobId: selected.job_id,
        },
      },
      [evaluationAdministrator],
    );
    expect(authorized.request.operation).toBe("cancelValidationJob");
    expect(authorized.request.input.actor).toEqual(evaluationActor);
    const snapshot = () => ({
      jobs: value.database.prepare("SELECT * FROM jobs ORDER BY id").all(),
      controls: value.database
        .prepare("SELECT * FROM evaluation_controls ORDER BY evaluation_id")
        .all(),
      receipts: value.database
        .prepare("SELECT * FROM evaluation_mutation_receipts ORDER BY repository_id, change_id")
        .all(),
      audit: value.database.prepare("SELECT * FROM validation_control_audit ORDER BY id").all(),
    });
    const before = snapshot();
    expect(() =>
      handleValidationDispatchRequest(
        value.database,
        {
          operation: "cancelValidationJob",
          input: authorized.request
            .input as unknown as ValidationDispatchOperationMap["cancelValidationJob"]["input"],
        },
        cancelledAt,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(snapshot()).toEqual(before);
  });

  it.each(["read_only", "replay_only"] as const)("blocks a new cancellation in %s mode", (mode) => {
    const value = fixture(),
      input = cancelInput(value);
    expect(() =>
      cancel(
        value,
        { ...input, ...(mode === "replay_only" ? { replayOnly: true } : {}) },
        { readOnly: mode === "read_only" },
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    expect(
      value.database
        .prepare("SELECT status, version FROM evaluation_controls WHERE evaluation_id = ?")
        .get(value.batch.id),
    ).toEqual({ status: "active", version: 1 });
  });

  it("rechecks configure permission before cancellation receipt replay", () => {
    const value = fixture();
    cancel(value);
    setEvaluationManagementRole(value.database, value.repositoryId, "viewer", 1);
    expect(() => cancel(value)).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
  });

  it.each(["changed_reason", "other_operation", "stale_version"] as const)(
    "rejects %s cancellation intent",
    (change) => {
      const value = fixture();
      if (change !== "other_operation") cancel(value);
      const input = structuredClone(cancelInput(value));
      if (change === "changed_reason") input.request.reason = "A different cancellation reason.";
      if (change === "other_operation") input.request.changeId = value.input.request.changeId;
      if (change === "stale_version") input.request.changeId = "another-cancellation";
      expect(() => cancel(value, input)).toThrow(
        expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
      );
    },
  );

  it("rolls back control, queued Job cancellation and dispatch state if receipt persistence fails", () => {
    const value = fixture();
    dispatch(value);
    const beforeJobs = jobs(value),
      beforeChecks = value.database
        .prepare("SELECT * FROM validation_dispatch_checks ORDER BY review_run_id")
        .all();
    value.database.exec(
      "CREATE TEMP TRIGGER reject_cancellation_receipt BEFORE INSERT ON evaluation_mutation_receipts WHEN NEW.operation = 'evaluation_cancelled' BEGIN SELECT RAISE(ABORT, 'Injected receipt failure'); END",
    );
    transaction(value, () => {
      expect(() =>
        cancelEvaluationBatchInTransaction(value.database, cancelInput(value), cancelledAt, [
          evaluationAdministrator,
        ]),
      ).toThrow("Injected receipt failure");
      expect(value.database.isTransaction).toBe(true);
      expect(jobs(value)).toEqual(beforeJobs);
      expect(
        value.database
          .prepare("SELECT * FROM validation_dispatch_checks ORDER BY review_run_id")
          .all(),
      ).toEqual(beforeChecks);
      expect(
        value.database
          .prepare("SELECT status, version FROM evaluation_controls WHERE evaluation_id = ?")
          .get(value.batch.id),
      ).toEqual({ status: "active", version: 1 });
    });
  });
});
