import { mkdtemp, rm } from "node:fs/promises";
import { request as nodeHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionContextV1,
  ActionContextV1Schema,
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationClaim,
  type InvestigationCreateTaskRequestV1,
  type InvestigationFindingsPageV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationReportPartRequest,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../../../worker/src/execution/process-host-protocol.js";
import { createInvestigationHttpClient } from "../../../worker/src/investigation/http-client.js";
import { InvestigationLoopCoordinator } from "../../../worker/src/investigation/loop-coordinator.js";
import type {
  ModelTurnExecutionInput,
  ModelTurnExecutionResult,
  ModelTurnRunner,
} from "../../../worker/src/investigation/model-turn-runner.js";
import type { InvestigationPlanExecutor } from "../../../worker/src/investigation/plan-executor.js";
import { InvestigationWorkerShutdown } from "../../../worker/src/investigation/task-service.js";
import type { PreparedInvestigationWorkspace } from "../../../worker/src/investigation/workspace.js";
import { buildInvestigationApp } from "./app.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "./types.js";

const workerToken = "roundtrip-worker-token-opaque";
const maximumPartBytes = 64 * 1024;
const findingCount = 137;
const servers: Array<{ app: FastifyInstance; store: InvestigationStore; closed: boolean }> = [];
const directories: string[] = [];

interface RecordedPart {
  reportId: string;
  collection: string;
  itemCount: number;
  byteLength: number;
}

interface TaskDetail {
  task: InvestigationTaskV1;
  checkpoint: InvestigationLoopCheckpointV1 | null;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Global fetch and external network access are forbidden in this test.");
    }),
  );
});

afterEach(async () => {
  try {
    for (const server of servers.splice(0)) {
      if (!server.closed) {
        await server.app.close();
        server.store.close();
      }
    }
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function post(app: FastifyInstance, path: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: path,
    payload: JSON.stringify(payload),
    headers: { authorization: "operator", "content-type": "application/json" },
  });
}

function get(app: FastifyInstance, path: string) {
  return app.inject({ method: "GET", url: path, headers: { authorization: "operator" } });
}

async function startServer(databasePath: string, repositoryId: string, parts: RecordedPart[]) {
  const operator: InvestigationOperatorPrincipal = {
    id: "roundtrip-operator",
    displayName: "Synthetic roundtrip operator",
    repositoryIds: [repositoryId],
    permissions: ["repository:manage", "task:create", "task:cancel", "action:prepare"],
    actionCapabilities: ["comment", "close", "start-task", "view-evidence"],
    allowRepositoryExecution: false,
  };
  const worker: InvestigationWorkerPrincipal = {
    id: "roundtrip-worker",
    repositoryIds: [repositoryId],
  };
  const store = new InvestigationStore(databasePath);
  const app = buildInvestigationApp({
    store,
    leaseDurationMs: 60_000,
    enableExternalWrites: false,
    authenticateOperator: (request) =>
      request.headers.authorization === "operator" ? operator : null,
    authenticateWorker: (request) =>
      request.headers.authorization === `Bearer ${workerToken}` ? worker : null,
  });
  const resource = { app, store, closed: false };
  servers.push(resource);
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode !== 200 || !request.url.endsWith("/report-parts")) return;
    const { part } = request.body as InvestigationReportPartRequest;
    parts.push({
      reportId: part.reportId,
      collection: part.collection,
      itemCount: part.items.length,
      byteLength: Buffer.byteLength(JSON.stringify(part), "utf8"),
    });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const expectedOrigin = new URL(address).origin;
  const localRequests: string[] = [];
  const client = createInvestigationHttpClient(
    {
      serverUrl: address,
      workerToken,
      allowInsecureHttp: true,
      requestTimeoutMs: 10_000,
      maximumResponseBytes: 32 * 1024 * 1024,
    },
    {
      httpRequest: (url, options, callback) => {
        if (url.origin !== expectedOrigin || url.hostname !== "127.0.0.1") {
          throw new Error("Only this owned loopback server may receive Worker requests.");
        }
        localRequests.push(url.pathname);
        return nodeHttpRequest(url, options, callback);
      },
      httpsRequest: () => {
        throw new Error("HTTPS and external transport are forbidden in this fixture.");
      },
    },
  );
  return {
    app,
    store,
    client,
    localRequests,
    async close() {
      await app.close();
      store.close();
      resource.closed = true;
    },
  };
}

function discoveryAnalysis(
  task: InvestigationTaskV1,
  fixture: InvestigationResultV1,
): InvestigationAnalysisV1 {
  const evidence = fixture.verificationEvidence.map((entry) => ({
    id: entry.id,
    subjectRef: entry.subjectRef,
    source: "reporter_statement" as const,
    summary: entry.summary,
    evidenceRefs: [...entry.evidenceRefs],
  }));
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary:
      "All 137 synthetic reporter hypotheses were inventoried; final-version rechecks remain pending.",
    coverage: {
      ...structuredClone(task.scope),
      includedUnits: task.scope.includedUnits.map((unit) => ({
        ...structuredClone(unit),
        status: "completed",
        evidenceRefs: evidence.map((entry) => entry.id),
      })),
      completedUnitRefs: task.scope.includedUnits.map((unit) => unit.id),
      unresolvedUnitRefs: [],
    },
    findings: structuredClone(fixture.findings),
    candidates: structuredClone(fixture.report.loop.candidates),
    rechecks: [],
    evidence,
    assessment: structuredClone(fixture.assessment),
    plans: fixture.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) =>
        structuredClone(plan),
    ),
    nextActions: fixture.nextActions.map(({ state: _state, sourceReportRef: _source, ...action }) =>
      structuredClone(action),
    ),
    feedbackDrafts: structuredClone(fixture.feedbackDrafts),
    diagnostics: [],
    limitations: structuredClone(fixture.report.limitations),
  };
}

function modelResult(
  input: ModelTurnExecutionInput,
  analysis: InvestigationAnalysisV1,
  final: boolean,
): ModelTurnExecutionResult {
  const checkpoint = input.checkpoint;
  if (checkpoint === null)
    throw new Error("The real Server must persist a checkpoint before model execution.");
  return {
    round: {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: input.task.id,
      attemptId: input.attempt.id,
      inputCheckpointRef: {
        id: checkpoint.id,
        version: checkpoint.version,
        digest: checkpoint.digest,
      },
      round: checkpoint.round + 1,
      phase: final ? "finalize" : "discovery",
      analysis,
      continue: !final,
      continuationReason: final
        ? "Every retained hypothesis has its final-version recheck and saved verification plan."
        : "Recheck every candidate before delivering a complete investigation.",
    },
    usage: { tokens: 200, source: "cli" },
    modelIdentity: final
      ? { engine: "copilot", model: "provider/recheck-model" }
      : { engine: "codex", model: "provider/investigation-model" },
  };
}

function executionFakes() {
  const forbidden = async (): Promise<never> => {
    throw new Error(
      "Snapshot-only roundtrip fixtures must not access source, artifacts, or real processes.",
    );
  };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: "C:\\roundtrip-fixture\\attempt",
    modelInputDirectory: "C:\\roundtrip-fixture\\attempt\\input",
    modelInputPath: "C:\\roundtrip-fixture\\attempt\\input\\snapshot.json",
    modelInputDigest: "f".repeat(64),
    controlDirectory: "C:\\roundtrip-fixture\\attempt\\control",
    tempDirectory: "C:\\roundtrip-fixture\\attempt\\temp",
    sourceDirectory: null,
    sourceBinding: null,
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: vi.fn(forbidden),
    readSourceFile: vi.fn(forbidden),
    readPrDiffManifest: vi.fn(forbidden),
    readPrDiffChunk: vi.fn(forbidden),
    applyEdits: vi.fn(forbidden),
    capturePatch: vi.fn(forbidden),
    writeArtifact: vi.fn(forbidden),
    writePatchArtifact: vi.fn(forbidden),
    readArtifact: vi.fn(forbidden),
    cleanup: vi.fn(async () => undefined),
  };
  const processHost: ProcessHostClient = {
    start: vi.fn(forbidden),
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const planExecutor: InvestigationPlanExecutor = { execute: vi.fn(forbidden) };
  const prepare = vi.fn(async () => workspace);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { workspace, processHost, planExecutor, prepare, logger };
}

function coordinator(
  client: ReturnType<typeof createInvestigationHttpClient>,
  fakes: ReturnType<typeof executionFakes>,
  modelTurnRunner: ModelTurnRunner,
) {
  return new InvestigationLoopCoordinator({
    client,
    ...fakes,
    modelTurnRunner,
    workspaceProvider: { prepare: fakes.prepare },
    heartbeatIntervalMs: 5_000,
    terminalTimeoutMs: 30_000,
    requestRetryMs: 1,
    maximumPartBytes,
  });
}

async function requireClaim(
  client: ReturnType<typeof createInvestigationHttpClient>,
): Promise<InvestigationClaim> {
  const claimed = await client.claim({ supportedKinds: ["issue-investigate"] });
  if (claimed === null)
    throw new Error("The real Server did not return the queued synthetic investigation.");
  return claimed;
}

describe("investigation Worker and Server HTTP roundtrip", () => {
  it("resumes 137 durable hypotheses after a Worker interruption and Server restart, then seals and pages the entire large report", async () => {
    const initial = createInvestigationFixture("bug", { findingCount, priority: "P2" });
    const lastFinding = initial.result.findings.at(-1);
    if (lastFinding === undefined)
      throw new Error("Expected the complete synthetic finding ledger.");
    lastFinding.priority = "P0";
    const retainedDetail =
      "Retained synthetic report detail, not observed runtime evidence. ".repeat(350);
    for (const finding of initial.result.findings)
      finding.feedbackDraft.body += `\n${retainedDetail}`;
    const subject = initial.task.subjects.find((entry) => entry.id === initial.task.subjectRef);
    if (subject === undefined) throw new Error("Expected the frozen Issue snapshot subject.");
    const item: InvestigationWorkItemRecord = {
      ...initial.task.workItem,
      repositoryId: initial.task.repository.id,
      subject,
      body: "Synthetic Issue snapshot with 137 distinct reporter scenarios. No upstream activity is authorized.",
      state: "open",
      updatedAt: "2026-09-15T08:00:00.000Z",
    };
    const directory = await mkdtemp(join(tmpdir(), "investigation-worker-roundtrip-"));
    directories.push(directory);
    const databasePath = join(directory, "investigation.sqlite");
    const parts: RecordedPart[] = [];
    const firstServer = await startServer(databasePath, initial.task.repository.id, parts);
    expect(
      (await post(firstServer.app, "/api/repositories", initial.task.repository)).statusCode,
    ).toBe(201);
    expect((await post(firstServer.app, "/api/work-items", item)).statusCode).toBe(201);
    const created = await post(firstServer.app, "/api/tasks", {
      idempotencyKey: "create-roundtrip-task",
      workItemId: item.id,
      kind: "issue-investigate",
      executionMode: "snapshot_only",
      budget: {
        maxRounds: 8,
        maxDurationMs: 120_000,
        maxTokens: 100_000,
        maxReportBytes: 32 * 1024 * 1024,
      },
    } satisfies InvestigationCreateTaskRequestV1);
    expect(created.statusCode).toBe(201);
    const task = created.json<InvestigationTaskV1>();
    const first = await requireClaim(firstServer.client);
    expect(first.task.id).toBe(task.id);
    expect(first.task.executionPolicy.mode).toBe("snapshot_only");
    expect(first.inputSnapshot.source).toBeNull();

    const shutdown = new AbortController();
    const firstFakes = executionFakes();
    const firstModel: ModelTurnRunner = {
      execute: vi.fn(async (input) => {
        if (input.checkpoint?.round === 0) {
          return modelResult(input, discoveryAnalysis(input.task, initial.result), false);
        }
        const persisted = await get(firstServer.app, `/api/tasks/${task.id}`);
        expect(persisted.statusCode).toBe(200);
        const state = persisted.json<TaskDetail>();
        expect(state.checkpoint?.round).toBe(1);
        expect(state.checkpoint?.analysis.findings).toHaveLength(findingCount);
        expect(state.checkpoint?.analysis.rechecks).toEqual([]);
        shutdown.abort(new InvestigationWorkerShutdown());
        input.signal.throwIfAborted();
        throw new Error("The interrupted fixture must not produce another model result.");
      }),
    };
    await coordinator(firstServer.client, firstFakes, firstModel).execute(first, shutdown.signal);
    expect(firstModel.execute).toHaveBeenCalledTimes(2);
    expect(firstFakes.workspace.cleanup).toHaveBeenCalledTimes(1);
    expect(firstFakes.processHost.start).not.toHaveBeenCalled();
    expect(firstFakes.planExecutor.execute).not.toHaveBeenCalled();
    const interruptedResponse = await get(firstServer.app, `/api/tasks/${task.id}`);
    expect(interruptedResponse.statusCode).toBe(200);
    const interrupted = interruptedResponse.json<TaskDetail>();
    expect(interrupted.task.state).toBe("interrupted");
    expect(interrupted.checkpoint?.analysis.findings).toHaveLength(findingCount);
    const partialRef = interrupted.task.latestReportRef;
    if (partialRef === null)
      throw new Error("The interrupted Attempt must seal its complete retained partial ledger.");
    const partialExport = await get(firstServer.app, `/api/reports/${partialRef.id}/export`);
    expect(partialExport.statusCode).toBe(200);
    const partial = partialExport.json<InvestigationResultV1>();
    expect(partial.outcome).toBe("interrupted");
    expect(partial.context.modelExecutions).toEqual([
      {
        attemptId: first.attempt.id,
        round: 1,
        engine: "codex",
        model: "provider/investigation-model",
      },
    ]);
    expect(partial.report.completeness).toBe("partial");
    expect(partial.findings).toHaveLength(findingCount);
    expect(partial.report.recheck.pendingFindingIds).toHaveLength(findingCount);
    await firstServer.close();

    const secondServer = await startServer(databasePath, initial.task.repository.id, parts);
    const restoredResponse = await get(secondServer.app, `/api/tasks/${task.id}`);
    expect(restoredResponse.statusCode).toBe(200);
    expect(restoredResponse.json<TaskDetail>().checkpoint).toEqual(interrupted.checkpoint);
    expect(
      (
        await post(secondServer.app, `/api/tasks/${task.id}/resume`, {
          idempotencyKey: "resume-roundtrip-task",
        })
      ).statusCode,
    ).toBe(200);
    const second = await requireClaim(secondServer.client);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(second.checkpoint?.round).toBe(1);
    expect(second.checkpoint?.analysis.findings).toHaveLength(findingCount);
    expect(second.checkpoint?.adoptedAttemptIds).toEqual([first.attempt.id, second.attempt.id]);
    await expect(
      secondServer.client.heartbeat(task.id, { lease: first.lease }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const secondFakes = executionFakes();
    const secondModel: ModelTurnRunner = {
      execute: vi.fn(async (input) => {
        if (input.checkpoint?.round !== 1)
          throw new Error(
            "Resume must continue the persisted candidate ledger without rediscovery.",
          );
        const analysis = structuredClone(input.checkpoint.analysis);
        analysis.summary =
          "The complete synthetic investigation retains all 137 individually rechecked hypotheses and a saved reproduction plan. No runtime claim is confirmed.";
        analysis.rechecks = initial.result.report.recheck.records.map((record) => ({
          ...structuredClone(record),
          round: 2,
        }));
        return modelResult(input, analysis, true);
      }),
    };
    await coordinator(secondServer.client, secondFakes, secondModel).execute(
      second,
      new AbortController().signal,
    );
    expect(secondModel.execute).toHaveBeenCalledTimes(1);
    expect(secondFakes.workspace.cleanup).toHaveBeenCalledTimes(1);
    expect(secondFakes.processHost.start).not.toHaveBeenCalled();
    expect(secondFakes.planExecutor.execute).not.toHaveBeenCalled();
    expect(secondFakes.workspace.readSourceFile).not.toHaveBeenCalled();
    expect(secondFakes.workspace.readPrDiffManifest).not.toHaveBeenCalled();

    const completedResponse = await get(secondServer.app, `/api/tasks/${task.id}`);
    expect(completedResponse.statusCode).toBe(200);
    const completed = completedResponse.json<TaskDetail>();
    expect(completed.task.state).toBe("completed");
    const finalRef = completed.task.latestReportRef;
    if (finalRef === null)
      throw new Error("The final complete report must be linked from the task.");
    expect(finalRef.id).not.toBe(partialRef.id);
    const exported = await get(secondServer.app, `/api/reports/${finalRef.id}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.rawPayload.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const result = exported.json<InvestigationResultV1>();
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(result.outcome).toBe("completed");
    expect(result.report).toMatchObject({
      completeness: "complete",
      delivery: "final",
      recheck: {
        finalFindingCount: findingCount,
        validFinalVersionRecheckCount: findingCount,
        pendingFindingIds: [],
      },
      collections: { findings: findingCount, candidates: findingCount, rechecks: findingCount },
    });
    expect(result.context.adoptedAttemptIds).toEqual([first.attempt.id, second.attempt.id]);
    expect(result.context.modelExecutions).toEqual([
      {
        attemptId: first.attempt.id,
        round: 1,
        engine: "codex",
        model: "provider/investigation-model",
      },
      {
        attemptId: second.attempt.id,
        round: 2,
        engine: "copilot",
        model: "provider/recheck-model",
      },
    ]);
    expect(completed.checkpoint?.runtime.modelExecutions).toEqual(result.context.modelExecutions);
    expect(result.findings.map((finding) => finding.id)).toEqual(
      initial.result.findings.map((finding) => finding.id),
    );
    expect(result.findings.at(-1)?.feedbackDraft.body).toBe(lastFinding.feedbackDraft.body);
    expect(result.validation.checks.every((check) => check.status === "not_run")).toBe(true);
    expect(result.verificationEvidence.every((evidence) => evidence.authority === "model")).toBe(
      true,
    );
    expect(result.report.coverage.unresolvedUnitRefs).toEqual([]);
    const finalParts = parts.filter((part) => part.reportId === finalRef.id);
    expect(finalParts.filter((part) => part.collection === "findings").length).toBeGreaterThan(1);
    expect(
      finalParts
        .filter((part) => part.collection === "findings")
        .reduce((total, part) => total + part.itemCount, 0),
    ).toBe(findingCount);
    expect(finalParts.every((part) => part.byteLength <= maximumPartBytes)).toBe(true);

    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const pageResponse = await get(
        secondServer.app,
        `/api/reports/${finalRef.id}/findings?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(pageResponse.statusCode).toBe(200);
      const page = pageResponse.json<InvestigationFindingsPageV1>();
      expect(page.total).toBe(findingCount);
      expect(page.offset).toBe(pageIndex * 50);
      sizes.push(page.items.length);
      ids.push(...page.items.map((finding) => finding.id));
      if (pageIndex < 2)
        expect(page.items.every((finding) => finding.priority !== "P0")).toBe(true);
      else
        expect(page.items.at(-1)).toMatchObject({
          id: lastFinding.id,
          priority: "P0",
          confirmation: { status: "hypothesis" },
        });
      cursor = page.nextCursor;
    }
    expect(sizes).toEqual([50, 50, 37]);
    expect(cursor).toBeNull();
    expect(ids).toEqual(result.findings.map((finding) => finding.id));
    expect(new Set(ids).size).toBe(findingCount);

    const contextResponse = await get(
      secondServer.app,
      `/api/work-items/${item.id}/action-context?reportId=${finalRef.id}`,
    );
    expect(contextResponse.statusCode).toBe(200);
    const actionContext = contextResponse.json<ActionContextV1>();
    expect(Value.Check(ActionContextV1Schema, actionContext)).toBe(true);
    expect(actionContext.reportRef).toEqual(finalRef);
    expect(actionContext.hardContentBlockers).toEqual([]);
    expect(actionContext.target).toMatchObject({
      kind: "issue",
      headSha: null,
      revisionKey: subject.revisionKey,
    });
    expect(actionContext.nextActions.map((action) => action.id)).toEqual(
      result.nextActions.map((action) => action.id),
    );
    expect(actionContext.fixedActions.find((action) => action.action === "comment")?.allowed).toBe(
      false,
    );
    expect((await get(secondServer.app, `/api/reports/${partialRef.id}/export`)).body).toBe(
      partialExport.body,
    );
    expect(firstServer.localRequests.some((path) => path.endsWith("/checkpoints"))).toBe(true);
    expect(secondServer.localRequests.some((path) => path.endsWith("/finalize"))).toBe(true);
  }, 60_000);
});
