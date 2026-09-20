import {
  createInvestigationPreview,
  type InvestigationCheckpointRequest,
  type InvestigationLoopCheckpointV1,
  type InvestigationModelInvocationReceipt,
  type InvestigationTaskV1,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
} from "../../dist/investigation/types.js";
import { recordInvestigationUsage } from "../../dist/investigation/usage-ledger.js";

type RejectionRequest = Extract<InvestigationCheckpointRequest, { kind: "rejected_analysis" }>;
const stores: InvestigationStore[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

/** All tasks and usage receipts are synthetic; this fixture has no external transport. */
function fixture(budget: Partial<InvestigationTaskV1["budget"]> = {}) {
  const store = new InvestigationStore();
  stores.push(store);
  const original = createInvestigationPreview("bug", { findingCount: 0 }).task;
  let now = Date.parse("2026-09-20T12:00:00.000Z");
  let sequence = 0;
  const task: InvestigationTaskV1 = {
    ...original,
    id: "rejected-output-task",
    state: "queued",
    latestReportRef: null,
    budget: { ...original.budget, ...budget },
    scope: {
      ...original.scope,
      includedUnits: original.scope.includedUnits.map((unit) => ({
        ...unit,
        status: "pending",
        evidenceRefs: [],
      })),
      completedUnitRefs: [],
      unresolvedUnitRefs: original.scope.includedUnits.map((unit) => unit.id),
    },
  };
  const worker: InvestigationWorkerPrincipal = {
    id: "synthetic-correction-worker",
    repositoryIds: [task.repository.id],
  };
  const operator: InvestigationOperatorPrincipal = {
    id: "synthetic-correction-operator",
    displayName: "Synthetic Operator",
    repositoryIds: worker.repositoryIds,
    isAdmin: true,
    permissions: ["task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  const options = {
    store,
    now: () => new Date(now),
    idFactory: () => `synthetic-correction-${++sequence}`,
    leaseDurationMs: 600_000,
  };
  const service = new InvestigationService(options);
  store.insert("tasks", task.id, task);
  store.insert("idempotency", `input:${task.id}`, {
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      subjectRef: task.subjectRef,
      subjectRevisionKey: task.subjects[0]!.revisionKey,
      title: task.workItem.title,
      body: "Synthetic output-correction fixture.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  });
  const claim = service.workerClaim(worker, { supportedKinds: ["issue-investigate"] }).claim;
  if (claim === null || claim.checkpoint === null)
    throw new Error("The synthetic static task must be claimed with a checkpoint.");
  const checkpoint = claim.checkpoint;
  const rejection = (
    current = checkpoint,
    invocationId = "rejected-invocation",
  ): RejectionRequest => ({
    kind: "rejected_analysis",
    lease: claim.lease,
    inputCheckpointRef: { id: current.id, version: current.version, digest: current.digest },
    round: current.round + 1,
    invocationId,
    issue: { rule: "duplicate_record_id", paths: ["/analysis/evidence/1/id"] },
  });
  const bill = (
    invocationId = "rejected-invocation",
    tokens = 65,
    overrides: Partial<InvestigationModelInvocationReceipt> = {},
  ) => {
    const registered: InvestigationModelInvocationReceipt = {
      invocationId,
      taskId: task.id,
      attemptId: claim.attempt.id,
      purpose: overrides.purpose ?? "analysis",
      engine: "codex",
      model: null,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      revision: 1,
      state: "registered",
      disposition: "pending",
      completeness: "unavailable",
      usage: unavailableInvestigationTokenUsage(),
    };
    service.workerModelUsage(worker, task.id, { lease: claim.lease, receipt: registered });
    const receipt: InvestigationModelInvocationReceipt = {
      ...registered,
      revision: 2,
      state: "completed",
      disposition: "rejected",
      completeness: "complete",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: tokens },
      ...overrides,
    };
    service.workerModelUsage(worker, task.id, { lease: claim.lease, receipt });
    return receipt;
  };
  const accept = (request = rejection(), instance = service) =>
    instance.workerCheckpoint(worker, task.id, request).checkpoint;
  return {
    store,
    options,
    service,
    task,
    worker,
    operator,
    claim,
    checkpoint,
    rejection,
    bill,
    accept,
    advance: (durationMs: number) => {
      now += durationMs;
    },
  };
}

function analysisRequest(
  f: ReturnType<typeof fixture>,
  checkpoint: InvestigationLoopCheckpointV1,
  tokens: number,
): InvestigationCheckpointRequest {
  return {
    kind: "analysis",
    lease: f.claim.lease,
    invocationId: "corrected-invocation",
    usage: { durationMs: 999_999, tokens, reportBytes: 0 },
    round: {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: f.task.id,
      attemptId: f.claim.attempt.id,
      inputCheckpointRef: {
        id: checkpoint.id,
        version: checkpoint.version,
        digest: checkpoint.digest,
      },
      round: checkpoint.round + 1,
      phase: "investigation",
      analysis: structuredClone(checkpoint.analysis),
      continue: true,
      continuationReason: "Continue the synthetic static investigation.",
    },
  };
}

describe("trusted rejected analysis checkpoints", () => {
  it.each(["completed", "failed"] as const)(
    "charges a %s rejected invocation without advancing accepted analysis",
    (state) => {
      const f = fixture();
      f.bill("rejected-invocation", 65, { state });
      f.advance(125);
      const next = f.accept();
      expect(next).toMatchObject({
        round: 0,
        version: f.checkpoint.version + 1,
        stopReason: "continuing",
        consumed: { rounds: 0, durationMs: 125, tokens: 65 },
        runtime: {
          modelOutputRejections: [
            {
              attemptId: f.claim.attempt.id,
              round: 1,
              invocationId: "rejected-invocation",
              issue: f.rejection().issue,
            },
          ],
        },
      });
      expect(next.analysis).toEqual(f.checkpoint.analysis);
      expect(next.lastPhase).toEqual(f.checkpoint.lastPhase);
      expect(next.digest).not.toBe(f.checkpoint.digest);
      expect(f.service.usageSummary(f.task.id).reportedTokens).toBe(65);
    },
  );

  it("persists one correction per attempt and round across Server restart", () => {
    const f = fixture();
    f.bill();
    const next = f.accept();
    const restarted = new InvestigationService(f.options);
    f.advance(50);
    expect(f.accept(f.rejection(), restarted)).toEqual(next);
    f.bill("another-rejected-invocation", 11);
    expect(() => f.accept(f.rejection(next, "another-rejected-invocation"), restarted)).toThrow(
      /Only one rejected proposal/,
    );
    expect(f.store.get("checkpoints", f.task.id)).toEqual(next);
  });

  it("returns current state after a lost rejection acknowledgement and preserves exact final invocation accounting", () => {
    const f = fixture();
    f.bill();
    const rejected = f.accept();
    f.bill("corrected-invocation", 18, { disposition: "accepted" });
    const aggregate = analysisRequest(f, rejected, 83);
    expect(() => f.service.workerCheckpoint(f.worker, f.task.id, aggregate)).toThrow(
      /exact completed model invocation/,
    );
    const corrected = f.service.workerCheckpoint(
      f.worker,
      f.task.id,
      analysisRequest(f, rejected, 18),
    ).checkpoint;
    expect(corrected.consumed.tokens).toBe(83);
    expect(corrected.consumed.durationMs).toBe(0);
    expect(corrected.round).toBe(1);
    expect(f.accept()).toEqual(corrected);
    expect(f.service.usageSummary(f.task.id)).toMatchObject({
      reportedTokens: 83,
      invocationCount: 2,
    });
  });

  it.each(["tokens", "duration"] as const)(
    "stops the durable correction at the trusted %s budget boundary",
    (boundary) => {
      const f = fixture(boundary === "tokens" ? { maxTokens: 65 } : { maxDurationMs: 125 });
      f.bill();
      if (boundary === "duration") f.advance(125);
      const next = f.accept();
      expect(next.stopReason).toBe("budget_exhausted");
      expect(next.round).toBe(0);
      expect(next.runtime.modelOutputRejections).toHaveLength(1);
      expect(f.accept()).toEqual(next);
    },
  );

  it.each([
    { name: "pending disposition", overrides: { disposition: "pending" } },
    { name: "cancelled invocation", overrides: { state: "cancelled" } },
    { name: "wrong purpose", overrides: { purpose: "e2e" } },
    { name: "incomplete usage", overrides: { completeness: "partial" } },
    {
      name: "unknown usage",
      overrides: { completeness: "unavailable", usage: unavailableInvestigationTokenUsage() },
    },
  ] satisfies {
    name: string;
    overrides: Partial<InvestigationModelInvocationReceipt>;
  }[])("rejects $name", ({ overrides }) => {
    const f = fixture();
    f.bill("rejected-invocation", 65, overrides);
    expect(() => f.accept()).toThrow(/rejected terminal model invocation/);
    expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
  });

  it.each(["running", "failed"] as const)(
    "blocks correction when another invocation has %s unsettled usage",
    (state) => {
      const f = fixture();
      f.bill();
      f.bill("unsettled-invocation", 5, { state, completeness: "partial" });
      expect(() => f.accept()).toThrow(/Every model invocation/);
      expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
    },
  );

  it.each(["taskId", "attemptId"] as const)(
    "rejects a rejected invocation belonging to another %s",
    (identity) => {
      const f = fixture();
      const registered: InvestigationModelInvocationReceipt = {
        invocationId: "rejected-invocation",
        taskId: f.task.id,
        attemptId: f.claim.attempt.id,
        purpose: "analysis",
        engine: "codex",
        model: null,
        startedAt: f.checkpoint.recordedAt,
        updatedAt: f.checkpoint.recordedAt,
        revision: 1,
        state: "registered",
        disposition: "pending",
        completeness: "unavailable",
        usage: unavailableInvestigationTokenUsage(),
        [identity]: "another-synthetic-owner",
      };
      recordInvestigationUsage(f.store, registered, 0);
      recordInvestigationUsage(
        f.store,
        {
          ...registered,
          revision: 2,
          state: "failed",
          disposition: "rejected",
          completeness: "complete",
          usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 7 },
        },
        0,
      );
      expect(() => f.accept()).toThrow(/rejected terminal model invocation/);
    },
  );

  it("refuses already bound analysis invocations and conflicting rejection replays", () => {
    const f = fixture();
    f.bill();
    f.store.insert("idempotency", "model-usage-analysis:rejected-invocation", {
      attemptId: f.claim.attempt.id,
      round: 1,
    });
    expect(() => f.accept()).toThrow(/accepted analysis invocation/);
    const fresh = fixture();
    fresh.bill();
    fresh.accept();
    expect(() =>
      fresh.accept({
        ...fresh.rejection(),
        issue: { rule: "duplicate_record_id", paths: ["/analysis/findings/1/id"] },
      }),
    ).toThrow(/different checkpoint content/);
  });

  it.each(["id", "version", "digest"] as const)(
    "requires the exact input checkpoint %s",
    (field) => {
      const f = fixture();
      f.bill();
      const request = f.rejection();
      const inputCheckpointRef = {
        ...request.inputCheckpointRef,
        [field]: field === "version" ? request.inputCheckpointRef.version + 1 : "a".repeat(64),
      };
      expect(() => f.accept({ ...request, inputCheckpointRef })).toThrow(
        /exact accepted input checkpoint/,
      );
      expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
    },
  );

  it("rejects cancellation, expired leases, runtime tasks, and forged trusted metadata", async () => {
    const cancelled = fixture();
    cancelled.bill();
    cancelled.service.cancelTask(cancelled.operator, cancelled.task.id);
    expect(() => cancelled.accept()).toThrow(/stop before correcting/);

    const expired = fixture();
    expired.bill();
    expired.advance(600_000);
    expect(() => expired.accept()).toThrow(/lease expired/);

    const runtime = fixture();
    runtime.bill();
    runtime.store.put("tasks", runtime.task.id, { ...runtime.claim.task, kind: "pr-e2e" });
    expect(() => runtime.accept()).toThrow(/Only a static investigation/);

    const f = fixture();
    f.bill();
    const app = buildInvestigationApp({
      ...f.options,
      authenticateWorker: () => f.worker,
      authenticateOperator: () => null,
    });
    apps.push(app);
    for (const payload of [
      { ...f.rejection(), accountedTokens: 0 },
      { ...f.rejection(), durationMs: 0 },
      { ...f.rejection(), issue: { ...f.rejection().issue, message: "untrusted output" } },
      {
        ...f.rejection(),
        issue: { rule: "reference_outside_batch", paths: ["/analysis/evidence/0/subjectRef"] },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/worker/tasks/${f.task.id}/checkpoints`,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(f.store.get("checkpoints", f.task.id)).toEqual(f.checkpoint);
    const response = await app.inject({
      method: "POST",
      url: `/api/worker/tasks/${f.task.id}/checkpoints`,
      payload: {
        ...f.rejection(),
        issue: {
          rule: "reference_outside_batch",
          paths: [
            "/analysis/findings/0/rootCause/evidenceRefs/0",
            "/analysis/assessment/evidenceRefs/0",
          ],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().checkpoint.runtime.modelOutputRejections[0].issue).toEqual({
      rule: "reference_outside_batch",
      paths: [
        "/analysis/assessment/evidenceRefs/0",
        "/analysis/findings/0/rootCause/evidenceRefs/0",
      ],
    });
  });

  it("does not add legacy usage when a rejection acknowledgement is lost before interruption", async () => {
    const f = fixture();
    f.bill();
    const app = buildInvestigationApp({
      ...f.options,
      authenticateWorker: () => f.worker,
      authenticateOperator: () => null,
    });
    apps.push(app);
    const rejectionResponse = await app.inject({
      method: "POST",
      url: `/api/worker/tasks/${f.task.id}/checkpoints`,
      payload: f.rejection(),
    });
    expect(rejectionResponse.statusCode, rejectionResponse.body).toBe(200);
    // Discard the acknowledgement: the Worker still holds the original pending usage.
    const response = await app.inject({
      method: "POST",
      url: `/api/worker/tasks/${f.task.id}/checkpoints`,
      payload: {
        kind: "interrupt",
        lease: f.claim.lease,
        reason: "error",
        diagnostics: [],
        modelUsage: { invocationId: "rejected-invocation", round: 1, tokens: 65 },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const interrupted = response.json<{ checkpoint: InvestigationLoopCheckpointV1 }>().checkpoint;
    expect(interrupted.stopReason).toBe("error");
    expect(interrupted.consumed.tokens).toBe(65);
    expect(f.service.usageSummary(f.task.id).reportedTokens).toBe(65);
    expect(interrupted.runtime.modelOutputRejections).toHaveLength(1);
    expect(interrupted.runtime.unacceptedModelUsage).toBeUndefined();
  });

  it("accounts a failed correction separately and strips its transport invocation identity", () => {
    const f = fixture();
    f.bill();
    f.accept();
    f.bill("corrected-invocation", 18, { state: "failed" });
    const interrupted = f.service.workerCheckpoint(f.worker, f.task.id, {
      kind: "interrupt",
      lease: f.claim.lease,
      reason: "error",
      diagnostics: [],
      modelUsage: { invocationId: "corrected-invocation", round: 1, tokens: 18 },
    }).checkpoint;
    expect(interrupted.consumed.tokens).toBe(83);
    expect(interrupted.runtime.unacceptedModelUsage).toEqual([
      { attemptId: f.claim.attempt.id, round: 1, tokens: 18 },
    ]);
    expect(interrupted.runtime.modelOutputRejections).toHaveLength(1);
  });

  it("requires an exact invocation when recovering a lost accepted-analysis acknowledgement", () => {
    const f = fixture();
    f.bill();
    const rejected = f.accept();
    f.bill("corrected-invocation", 18, { disposition: "accepted" });
    const corrected = f.service.workerCheckpoint(
      f.worker,
      f.task.id,
      analysisRequest(f, rejected, 18),
    ).checkpoint;
    f.bill("different-invocation", 18, { state: "failed" });
    expect(() =>
      f.service.workerCheckpoint(f.worker, f.task.id, {
        kind: "interrupt",
        lease: f.claim.lease,
        reason: "error",
        diagnostics: [],
        modelUsage: { invocationId: "different-invocation", round: 1, tokens: 18 },
      }),
    ).toThrow(/next unaccepted analysis round/);
    expect(f.store.get("checkpoints", f.task.id)).toEqual(corrected);
    const interrupted = f.service.workerCheckpoint(f.worker, f.task.id, {
      kind: "interrupt",
      lease: f.claim.lease,
      reason: "error",
      diagnostics: [],
      modelUsage: { invocationId: "corrected-invocation", round: 1, tokens: 18 },
    }).checkpoint;
    expect(interrupted.consumed.tokens).toBe(101);
    expect(interrupted.runtime.unacceptedModelUsage).toBeUndefined();
  });

  it("ignores a late failure for a rejected invocation after corrected analysis advances", () => {
    const f = fixture();
    f.bill();
    const rejected = f.accept();
    f.bill("corrected-invocation", 18, { disposition: "accepted" });
    const corrected = f.service.workerCheckpoint(
      f.worker,
      f.task.id,
      analysisRequest(f, rejected, 18),
    ).checkpoint;
    f.advance(100);
    const current = f.service.workerCheckpoint(f.worker, f.task.id, {
      kind: "interrupt",
      lease: f.claim.lease,
      reason: "error",
      diagnostics: [],
      modelUsage: { invocationId: "rejected-invocation", round: 1, tokens: 65 },
    }).checkpoint;
    expect(current).toEqual(corrected);
    expect(current.stopReason).toBe("continuing");
    expect(current.runtime.unacceptedModelUsage).toBeUndefined();
  });

  it("honors cancellation even when rejected-output interruption arrives after corrected analysis", () => {
    const f = fixture();
    f.bill();
    const rejected = f.accept();
    f.bill("corrected-invocation", 18, { disposition: "accepted" });
    f.service.workerCheckpoint(f.worker, f.task.id, analysisRequest(f, rejected, 18));
    f.service.cancelTask(f.operator, f.task.id);
    const interrupted = f.service.workerCheckpoint(f.worker, f.task.id, {
      kind: "interrupt",
      lease: f.claim.lease,
      reason: "cancelled",
      diagnostics: [],
      modelUsage: { invocationId: "rejected-invocation", round: 1, tokens: 65 },
    }).checkpoint;
    expect(interrupted.stopReason).toBe("cancelled");
    expect(interrupted.consumed.tokens).toBe(83);
    expect(interrupted.runtime.unacceptedModelUsage).toBeUndefined();
  });

  it.each([
    { invocationId: "missing-invocation", round: 1, tokens: 65 },
    { invocationId: "rejected-invocation", round: 1, tokens: 66 },
    { invocationId: "rejected-invocation", round: 2, tokens: 65 },
  ])("rejects a mismatched terminal usage receipt: %o", (modelUsage) => {
    const f = fixture();
    f.bill();
    const rejected = f.accept();
    expect(() =>
      f.service.workerCheckpoint(f.worker, f.task.id, {
        kind: "interrupt",
        lease: f.claim.lease,
        reason: "error",
        diagnostics: [],
        modelUsage,
      }),
    ).toThrow(/exact invocation|original correction checkpoint/);
    expect(f.store.get("checkpoints", f.task.id)).toEqual(rejected);
  });
});
