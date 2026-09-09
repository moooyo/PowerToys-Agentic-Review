import type { SQLInputValue } from "node:sqlite";
import type * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { handleEvaluationModelInvocationRequest } from "./evaluation-model-invocations.js";
import {
  invocationHistoryInput,
  recordInvocationHistory,
} from "./evaluation-model-invocations.testing.js";
import { beginRetryAdmissionInTransaction } from "./job-admission.js";
import {
  createModelInvocationFixture,
  type ModelInvocationFixture,
  modelInvocationBeginRequest,
  modelInvocationFixtureTime as time,
} from "./model-invocations.testing.js";
import { handleModelRuntimeRegistryRequest } from "./model-runtime-registry.js";

const fixtures: ModelInvocationFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const sampledAt = "2026-09-08T06:00:00.000Z";
function fixture(options: Parameters<typeof createModelInvocationFixture>[0] = {}) {
  const f = createModelInvocationFixture(options);
  fixtures.push(f);
  return f;
}
function read(f: ModelInvocationFixture, input = invocationHistoryInput(f), now = sampledAt) {
  return handleEvaluationModelInvocationRequest(
    f.database,
    { operation: "listEvaluationCellModelInvocations", input },
    now,
    [evaluationAdministrator],
  );
}
function records(f: ModelInvocationFixture) {
  return canonicalJson(
    Object.fromEntries(
      ["openings", "seals", "submissions"].map((suffix) => [
        suffix,
        f.database.prepare(`SELECT * FROM model_invocation_${suffix} ORDER BY invocation_id`).all(),
      ]),
    ),
  );
}
function insertRow(f: ModelInvocationFixture, table: string, row: Record<string, SQLInputValue>) {
  const keys = Object.keys(row);
  f.database
    .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
function nextSyntheticAttempt(f: ModelInvocationFixture, sequence: number): C.LeaseIdentity {
  const previous = f.lease(),
    now = `2026-09-08T04:0${sequence}:00.000Z`;
  const lease = {
    ...previous,
    runAttemptId: `history-attempt-${sequence}`,
    leaseGeneration: sequence,
    leaseToken: `synthetic-invocation-history-lease-${sequence}-only`,
  };
  f.database.exec("BEGIN IMMEDIATE");
  try {
    f.database
      .prepare(
        "UPDATE run_attempts SET status = 'failed', failure_code = 'SYNTHETIC_RETRY', failure_message = 'Synthetic history attempt', ended_at = ? WHERE job_id = ? AND status IN ('leased','running')",
      )
      .run(now, previous.jobId);
    f.database
      .prepare(
        "UPDATE jobs SET status = 'retry_waiting', current_run_attempt_id = NULL, next_attempt_at = ?, max_attempts = 3 WHERE id = ?",
      )
      .run(now, previous.jobId);
    beginRetryAdmissionInTransaction(f.database, previous.jobId, now);
    // Like the shared fixture, this is an explicit protocol seed, never a successful model claim.
    f.database
      .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
      .run(now, previous.jobId);
    f.database
      .prepare(
        "UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = ?, lease_generation = ? WHERE id = ?",
      )
      .run(lease.runAttemptId, sequence, sequence, lease.jobId);
    f.database
      .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id, status, lease_token_hash, lease_generation,
      lease_expires_at, execution_deadline_at, no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at)
      VALUES (?, ?, ?, 'invocation-worker', ?, ?, 'running', ?, ?, ?, ?, 60000, ?, ?, 'synthetic_history', ?)`)
      .run(
        lease.runAttemptId,
        lease.jobId,
        sequence,
        lease.workerNodeId,
        lease.workerInstanceId,
        sha256(lease.leaseToken),
        sequence,
        time.deadline,
        time.deadline,
        time.deadline,
        now,
        now,
      );
    f.database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(lease.jobId);
    f.database.exec("COMMIT");
    return lease;
  } catch (error) {
    if (f.database.isTransaction) f.database.exec("ROLLBACK");
    throw error;
  }
}

describe("evaluation model invocation history owner", () => {
  it("returns frozen expectations without an invocation or a successful result", () => {
    const f = fixture();
    const value = read(f);
    expect(value).toMatchObject({
      schemaVersion: "EvaluationCellInvocationListV1",
      expectedRuntimeRegistration: f.registration,
      page: 1,
      pageSize: 10,
      total: 0,
      items: [],
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
    const profileOnly = fixture({ modelRequired: false });
    expect(read(profileOnly).expectedRuntimeRegistration).toBeNull();
  });
  it.each(["opening", "seal", "submission"] as const)(
    "reads the exact %s stage with bounded public diagnostics",
    (stage) => {
      const f = fixture();
      const written = recordInvocationHistory(f, {
        openingOnly: stage === "opening",
        sealOnly: stage === "seal",
      });
      const before = records(f);
      f.database.exec("PRAGMA query_only = ON");
      const value = read(f);
      expect(value.items).toHaveLength(1);
      expect(value.items[0]).toMatchObject(written);
      expect(value.items[0]?.observedIdentity).toEqual(stage === "submission" ? f.identity : null);
      expect(value.items[0]?.callOutcomes).toEqual(
        stage === "submission"
          ? {
              completed: 1,
              provider_failed: 0,
              provider_incomplete: 0,
              transport_failed: 0,
              cancelled: 0,
              protocol_invalid: 0,
              budget_exceeded: 0,
            }
          : null,
      );
      expect(JSON.stringify(value)).not.toContain('"receiptSet"');
      expect(JSON.stringify(value)).not.toContain(f.workerToken);
      expect(JSON.stringify(value)).not.toContain(f.lease().leaseToken);
      expect(records(f)).toBe(before);
    },
  );
  it("keeps invalid collection diagnostics while withholding its claimed observed identity", () => {
    const f = fixture();
    recordInvocationHistory(f, {
      changeLedger: (set) => {
        const call = set.calls[0];
        if (!call) throw new Error("A call is required.");
        call.sha256 = "0".repeat(64);
      },
    });
    const item = read(f).items[0];
    expect(item?.submission?.consistency.state).toBe("invalid");
    expect(item?.observedIdentity).toBeNull();
    expect(item?.callOutcomes?.completed).toBe(1);
    expect(item?.submission?.executionAccepted).toBe(false);
  });
  it("reads cancelled and disabled historical scopes after Worker credential revocation", () => {
    const f = fixture();
    recordInvocationHistory(f);
    handleModelRuntimeRegistryRequest(
      f.database,
      {
        operation: "changeModelRuntimeControl",
        input: {
          actor: evaluationAdministrator,
          registrationId: f.registration.id,
          request: {
            changeId: "disable-history-runtime",
            expectedVersion: 1,
            enabled: false,
            reason: "Only future selections are disabled.",
          },
        },
      },
      time.submitted,
      [evaluationAdministrator],
    );
    f.database.exec("BEGIN IMMEDIATE");
    try {
      cancelEvaluationBatchInTransaction(
        f.database,
        {
          repositoryId: f.repositoryId,
          evaluationId: f.batch.id,
          actor: evaluationAdministrator,
          request: {
            changeId: "cancel-history-batch",
            expectedVersion: 1,
            reason: "Retain recorded invocation history.",
          },
        },
        time.submitted,
        [evaluationAdministrator],
      );
      f.database.exec("COMMIT");
    } catch (error) {
      f.database.exec("ROLLBACK");
      throw error;
    }
    f.database
      .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
      .run(f.repositoryId);
    f.database
      .prepare(
        "UPDATE worker_node_credentials SET auth_state = 'revoked', revoked_at = ? WHERE worker_node_id = ?",
      )
      .run(time.submitted, f.lease().workerNodeId);
    f.database
      .prepare("UPDATE workers SET status = 'offline', superseded_at = ? WHERE node_id = ?")
      .run(time.submitted, f.lease().workerNodeId);
    const value = read(f);
    expect(value.expectedRuntimeRegistration).toEqual(f.registration);
    expect(value.items[0]?.submission?.consistency.state).toBe("matched");
  });
  it("enforces current read permission before history and isolates repository, batch and cell IDs", () => {
    const f = fixture();
    recordInvocationHistory(f);
    setEvaluationManagementRole(f.database, f.repositoryId, "viewer", 1);
    expect(read(f).total).toBe(1);
    for (const input of [
      { ...invocationHistoryInput(f), repositoryId: f.secondRepositoryId },
      { ...invocationHistoryInput(f), evaluationId: "other-evaluation" },
      { ...invocationHistoryInput(f), cellId: "other-cell" },
    ])
      expect(() => read(f, { ...input, actor: evaluationAdministrator })).toThrow(
        expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
      );
    expect(read(f, invocationHistoryInput(f, "candidate")).total).toBe(0);
    setEvaluationManagementRole(f.database, f.repositoryId, null, 2);
    expect(() => read(f)).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() =>
      read(f, { ...invocationHistoryInput(f), actor: { ...evaluationActor, subject: "unknown" } }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
  });
  it("pages all attempts including earlier failures in deterministic newest-first order", () => {
    const f = fixture();
    recordInvocationHistory(f, { openingOnly: true });
    const second = nextSyntheticAttempt(f, 2);
    recordInvocationHistory(f, {
      lease: second,
      invocationId: "history-second",
      now: "2026-09-08T04:02:00.000Z",
      openingOnly: true,
    });
    const third = nextSyntheticAttempt(f, 3);
    recordInvocationHistory(f, {
      lease: third,
      invocationId: "history-third",
      now: "2026-09-08T04:03:00.000Z",
      openingOnly: true,
    });
    const pages = [1, 2, 3, 4].map((page) =>
      read(f, { ...invocationHistoryInput(f), query: { page, pageSize: 1 } }),
    );
    expect(pages.map((page) => page.total)).toEqual([3, 3, 3, 3]);
    expect(pages.map((page) => page.items[0]?.opening.scope.invocationId ?? null)).toEqual([
      "history-third",
      "history-second",
      "invocation-baseline",
      null,
    ]);
  });
  it.each([
    { page: 0 },
    { pageSize: 11 },
    { pageSize: 0 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 10 },
    { page: 1.1 },
    { unexpected: true },
  ])("rejects invalid pagination %j", (query) => {
    const f = fixture();
    expect(() =>
      read(f, {
        ...invocationHistoryInput(f),
        query: query as C.EvaluationCellInvocationListQuery,
      }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });
  it("rejects a future Server opening timestamp without comparing Worker closure clocks", () => {
    const f = fixture();
    recordInvocationHistory(f);
    expect(() => read(f, invocationHistoryInput(f), time.leased)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
    expect(read(f).items[0]?.seal?.closedAt.startsWith("2020-")).toBe(true);
  });
  it.each(["opening_sha256", "begin_intent_sha256"] as const)(
    "rejects a shape-valid inserted archive with corrupt %s",
    (field) => {
      const f = fixture();
      // ScopeV2 requires its immutable input to survive the deliberately rolled-back opening.
      modelInvocationBeginRequest(f);
      f.database.exec("BEGIN");
      recordInvocationHistory(f, { openingOnly: true });
      const row = f.database.prepare("SELECT * FROM model_invocation_openings").get() as Record<
        string,
        SQLInputValue
      >;
      f.database.exec("ROLLBACK");
      insertRow(f, "model_invocation_openings", { ...row, [field]: "0".repeat(64) });
      f.database.exec("PRAGMA query_only = ON");
      expect(() => read(f)).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    },
  );
});
