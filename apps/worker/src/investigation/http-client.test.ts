import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext, SecureContextOptions } from "node:tls";
import { inspect } from "node:util";
import type {
  InvestigationAnalysisV1,
  InvestigationArtifactRequest,
  InvestigationCheckpointRequest,
  InvestigationClaim,
  InvestigationClaimRequest,
  InvestigationFinalizeRequest,
  InvestigationHeartbeatRequest,
  InvestigationLoopCheckpointV1,
  InvestigationLoopRoundV1,
  InvestigationModelInvocationReceipt,
  InvestigationPrDiffManifestV1,
  InvestigationReportPartRequest,
  InvestigationUsageSummary,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createInvestigationHttpClient,
  type InvestigationHttpClientOptions,
  InvestigationWorkerClientError,
} from "./http-client.js";

const serverTime = "2026-09-15T00:00:00.000Z";
const taskId = "task:1";
const attemptId = "attempt-1";
const workerToken = "arw1_fixture-worker-token";
const lease = { attemptId, fence: 4, leaseToken: "fixture-lease-token" };
const digest = "a".repeat(64);
const claimRequest: InvestigationClaimRequest = { supportedKinds: ["issue-investigate"] };
const heartbeatRequest: InvestigationHeartbeatRequest = { lease };
const heartbeatResponse = { cancelRequested: false, leaseExpiresAt: serverTime, serverTime };
const modelUsageReceipt = (): InvestigationModelInvocationReceipt => ({
  invocationId: "invocation-1",
  taskId,
  attemptId,
  purpose: "analysis",
  engine: "codex",
  model: null,
  startedAt: serverTime,
  updatedAt: serverTime,
  revision: 3,
  state: "cancelled",
  disposition: "rejected",
  completeness: "partial",
  usage: {
    inputTokens: 10,
    cachedReadTokens: 3,
    outputTokens: 5,
    reasoningTokens: null,
    cacheWriteTokens: null,
    totalTokens: 15,
    providerCounters: {},
  },
});
const reportUsageSummary = (): InvestigationUsageSummary => ({
  usage: modelUsageReceipt().usage,
  reportedTokens: 15,
  completeness: "complete",
  invocationCount: 1,
  activeInvocationCount: 0,
  unknownInvocationCount: 0,
  legacyTokens: 0,
});
const budget = {
  maxRounds: 3,
  maxDurationMs: 60_000,
  maxTokens: 10_000,
  maxReportBytes: 1_048_576,
};
const consumed = { rounds: 1, durationMs: 100, tokens: 200, reportBytes: 300 };
const collections = {
  findings: 0,
  verificationEvidence: 0,
  artifacts: 0,
  plans: 0,
  nextActions: 0,
  candidates: 0,
  rechecks: 0,
};

class StubResponse extends EventEmitter {
  public readonly destroy = vi.fn(() => this);

  public constructor(public readonly statusCode: number) {
    super();
  }

  public finish(...chunks: (Buffer | string)[]): void {
    for (const chunk of chunks) this.emit("data", chunk);
    this.emit("end");
    this.emit("close");
  }
}

class StubRequest extends EventEmitter {
  public readonly chunks: Buffer[] = [];
  public readonly destroy = vi.fn(() => this);
  public readonly end = vi.fn(() => this);

  public constructor(private readonly callback: (response: IncomingMessage) => void) {
    super();
  }

  public write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
    return true;
  }

  public startResponse(statusCode = 200): StubResponse {
    const response = new StubResponse(statusCode);
    this.callback(response as unknown as IncomingMessage);
    return response;
  }

  public respondJson(payload: unknown, statusCode = 200): void {
    this.startResponse(statusCode).finish(JSON.stringify(payload));
  }
}

function createFixture(options: Partial<InvestigationHttpClientOptions> = {}) {
  const requests: { url: URL; options: RequestOptions; request: StubRequest }[] = [];
  const request = (
    url: URL,
    requestOptions: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const outgoing = new StubRequest(callback);
    requests.push({ url, options: requestOptions, request: outgoing });
    return outgoing as unknown as ClientRequest;
  };
  const httpRequest = vi.fn(request);
  const httpsRequest = vi.fn(request);
  const secureContext = {} as SecureContext;
  const createSecureContext = vi.fn((_options: SecureContextOptions) => secureContext);
  const client = createInvestigationHttpClient(
    { serverUrl: "https://worker-api.test", workerToken, ...options },
    { httpRequest, httpsRequest, createSecureContext },
  );
  return {
    client,
    requests,
    httpRequest,
    httpsRequest,
    secureContext,
    createSecureContext,
    lastRequest() {
      const captured = requests.at(-1);
      if (captured === undefined) throw new Error("No request was captured.");
      return captured;
    },
  };
}

function claimFixture(): InvestigationClaim {
  return {
    task: {
      schemaVersion: "InvestigationTaskV1",
      id: taskId,
      kind: "issue-investigate",
      repository: { id: "repository-1", fullName: "example/repository", githubRepositoryId: 123 },
      workItem: { id: "issue-1", kind: "issue", number: 42, title: "Inspect the startup behavior" },
      parentTaskId: null,
      parentReportRef: null,
      planRef: null,
      subjectRef: "subject-1",
      subjects: [
        {
          id: "subject-1",
          repositoryId: "repository-1",
          workItemId: "issue-1",
          revisionKey: digest,
          kind: "issue_snapshot",
          snapshotDigest: digest,
        },
      ],
      scope: {
        scopeManifest: { id: "scope-1", version: 1, digest },
        includedUnits: [],
        exclusions: [],
        completedUnitRefs: [],
        unresolvedUnitRefs: [],
      },
      executionPolicy: {
        mode: "snapshot_only",
        allowedSubjectRefs: ["subject-1"],
        allowRepositoryExecution: false,
        authorizationRef: null,
      },
      budget,
      profileRef: { id: "profile-1", version: 1, digest },
      promptRef: { id: "prompt-1", version: 1, digest },
      state: "running",
      latestReportRef: null,
      createdAt: serverTime,
      updatedAt: serverTime,
    },
    attempt: {
      schemaVersion: "InvestigationAttemptV1",
      id: attemptId,
      taskId,
      number: 1,
      workerId: "worker-1",
      leaseVersion: lease.fence,
      state: "running",
      startedAt: serverTime,
      finishedAt: null,
      terminationReason: null,
    },
    lease: { ...lease },
    checkpoint: null,
    reportId: "report-1",
    inputSnapshot: {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: "repository-1",
      workItemId: "issue-1",
      subjectRef: "subject-1",
      subjectRevisionKey: digest,
      title: "Inspect the startup behavior",
      body: "The behavior needs clarification.",
      comments: [],
      source: null,
    },
    plan: null,
    execution: null,
  };
}

function analysisFixture(): InvestigationAnalysisV1 {
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: "The snapshot was inspected.",
    coverage: claimFixture().task.scope,
    assessment: {
      kind: "other_issue",
      subjectRef: "subject-1",
      summary: "The report needs clarification.",
      evidenceRefs: [],
      classification: "question",
      explanation: "No execution was requested.",
    },
    findings: [],
    candidates: [],
    rechecks: [],
    evidence: [],
    plans: [],
    nextActions: [],
    feedbackDrafts: [],
    diagnostics: [],
    limitations: [],
  };
}

function roundFixture(): InvestigationLoopRoundV1 {
  return {
    schemaVersion: "InvestigationLoopRoundV1",
    taskId,
    attemptId,
    inputCheckpointRef: null,
    round: 1,
    phase: "discovery",
    analysis: analysisFixture(),
    continue: false,
    continuationReason: "All snapshot questions have been assessed.",
  };
}

function checkpointRequestFixture(): Extract<InvestigationCheckpointRequest, { kind: "analysis" }> {
  return {
    kind: "analysis",
    lease,
    round: roundFixture(),
    usage: { durationMs: 100, tokens: 200, reportBytes: 300 },
  };
}

function sourceManifestFixture(): InvestigationPrDiffManifestV1 {
  return {
    schemaVersion: "InvestigationPrDiffManifestV1",
    subjectRef: "subject-1",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    mergeBaseSha: "b".repeat(40),
    files: [
      {
        path: "new.ts",
        previousPath: null,
        status: "added",
        chunkIds: ["chunk-diff", "chunk-head"],
      },
    ],
    chunks: [
      {
        id: "chunk-diff",
        path: "new.ts",
        kind: "diff",
        ordinal: 0,
        encoding: "utf8",
        contentDigest: digest,
        byteLength: 20,
      },
      {
        id: "chunk-head",
        path: "new.ts",
        kind: "head",
        ordinal: 0,
        encoding: "utf8",
        contentDigest: "b".repeat(64),
        byteLength: 10,
      },
    ],
    digest,
  };
}

function checkpointFixture(): InvestigationLoopCheckpointV1 {
  const task = claimFixture().task;
  return {
    schemaVersion: "InvestigationLoopCheckpointV1",
    id: "checkpoint-1",
    version: 1,
    digest,
    taskId,
    attemptId,
    leaseVersion: lease.fence,
    subjectRevisionKey: digest,
    profileRef: task.profileRef,
    promptRef: task.promptRef,
    previousCheckpointRef: null,
    round: 1,
    analysis: analysisFixture(),
    adoptedAttemptIds: [],
    recordedAt: serverTime,
    budget,
    consumed,
    stopReason: "complete",
    taskBindingDigest: digest,
    lastPhase: "discovery",
    runtime: {
      completedStepIds: [],
      checks: [],
      evidence: [],
      artifacts: [],
      subjects: [],
      startedSteps: [],
      completedSteps: [],
    },
  };
}

function partFixture(): InvestigationReportPartRequest {
  return {
    lease,
    part: {
      schemaVersion: "InvestigationReportPartV1",
      id: "part-1",
      taskId,
      attemptId,
      reportId: "report-1",
      reportVersion: 1,
      sequence: 0,
      itemCount: 0,
      previousPartDigest: null,
      digest,
      collection: "findings",
      items: [],
    },
  };
}

function artifactFixture(
  content = Buffer.from("The snapshot was inspected.\n"),
): InvestigationArtifactRequest {
  return {
    lease,
    artifact: {
      id: "artifact-1",
      taskId,
      attemptId,
      subjectRef: "subject-1",
      kind: "log",
      name: "observation.txt",
      mediaType: "text/plain",
      availability: "available",
      digest: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength,
    },
    contentBase64: content.toString("base64"),
  };
}

function finalizeFixture(): InvestigationFinalizeRequest {
  const task = claimFixture().task;
  return {
    lease,
    header: {
      schemaVersion: "InvestigationReportHeaderV1",
      id: "result-1",
      version: 1,
      context: {
        repository: task.repository,
        workItem: task.workItem,
        task: { id: taskId, kind: task.kind, parentTaskId: null, subjectRef: task.subjectRef },
        attempt: { id: attemptId, number: 1 },
        adoptedAttemptIds: [],
        subjects: task.subjects,
        profileRef: task.profileRef,
        promptRef: task.promptRef,
        parentReportRef: null,
      },
      outcome: "completed",
      assessment: analysisFixture().assessment,
      validation: { summary: "Only the provided snapshot was inspected." },
      report: {
        id: "report-1",
        version: 1,
        delivery: "final",
        completeness: "complete",
        summary: "The snapshot investigation is complete.",
        logicalContentDigest: digest,
        coverage: {
          scopeManifest: task.scope.scopeManifest,
          includedUnitCount: 0,
          completedUnitCount: 0,
          unresolvedUnitCount: 0,
          exclusionCount: 0,
        },
        recheck: { finalFindingCount: 0, validFinalVersionRecheckCount: 0, pendingFindingCount: 0 },
        loop: {
          checkpointId: "checkpoint-1",
          checkpointVersion: 1,
          completedRounds: 1,
          stopReason: "complete",
          budget,
          consumed,
        },
        collections,
      },
    },
    manifest: {
      schemaVersion: "InvestigationReportManifestV1",
      reportId: "report-1",
      reportVersion: 1,
      parts: [],
      collections,
      logicalContentDigest: digest,
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<InvestigationWorkerClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationWorkerClientError);
    if (!(error instanceof InvestigationWorkerClientError)) throw error;
    return error;
  }
  throw new Error("Expected the request to reject.");
}

function expectSafeError(error: InvestigationWorkerClientError, ...secrets: string[]): void {
  expect(error).not.toHaveProperty("cause");
  const serialized = `${inspect(error, { showHidden: true })}\n${JSON.stringify(error)}`;
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

describe("Investigation HTTP client requests", () => {
  it("reads task admission policy through the authenticated Worker transport", async () => {
    const fixture = createFixture();
    const request = { supportedKinds: ["pr-review", "pr-e2e"] as const };
    const pending = fixture.client.workerPolicy!({ supportedKinds: [...request.supportedKinds] });
    const captured = fixture.lastRequest();
    expect(captured.url.pathname).toBe("/api/worker/policy");
    const response = {
      workerId: "worker-1",
      version: 3,
      e2eEnabled: false,
      effectiveKinds: ["pr-review"],
    };
    captured.request.respondJson(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("rejects a policy that advertises a task kind outside the local Worker role", async () => {
    const fixture = createFixture();
    const pending = fixture.client.workerPolicy!({ supportedKinds: ["pr-review"] });
    fixture.lastRequest().request.respondJson({
      workerId: "worker-1",
      version: 3,
      e2eEnabled: true,
      effectiveKinds: ["pr-review", "pr-e2e"],
    });
    expect((await rejectionOf(pending)).code).toBe("invalid_response");
  });

  it("requests the frozen report usage snapshot with the exact attempt lease", async () => {
    const fixture = createFixture();
    const request = { lease };
    const pending = fixture.client.reportUsage!(taskId, request);
    const captured = fixture.lastRequest();
    expect(captured.url.pathname).toBe("/api/worker/tasks/task%3A1/report-usage");
    expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(request);
    const response = { summary: reportUsageSummary() };
    captured.request.respondJson(response);
    await expect(pending).resolves.toEqual(response);
  });

  it("rejects a report usage response whose token subdivisions contradict its input total", async () => {
    const fixture = createFixture();
    const pending = fixture.client.reportUsage!(taskId, { lease });
    const summary = reportUsageSummary();
    summary.usage.cachedReadTokens = 100;
    fixture.lastRequest().request.respondJson({ summary });
    expect((await rejectionOf(pending)).code).toBe("invalid_response");
  });

  it("sends retained model accounting under its original lease and acknowledges the exact revision", async () => {
    const fixture = createFixture();
    const request = { lease, receipt: modelUsageReceipt() };
    const pending = fixture.client.modelUsage!(taskId, request);
    const captured = fixture.lastRequest();
    expect(captured.url.pathname).toBe("/api/worker/tasks/task%3A1/model-usage");
    expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(request);
    const response = {
      invocationId: request.receipt.invocationId,
      revision: request.receipt.revision,
    };
    captured.request.respondJson(response);
    await expect(pending).resolves.toEqual(response);
  });

  it.each([true, false])(
    "preserves explicit execution admission %s in a registration acknowledgement",
    async (executionAllowed) => {
      const fixture = createFixture();
      const receipt: InvestigationModelInvocationReceipt = {
        ...modelUsageReceipt(),
        revision: 1,
        state: "registered",
        disposition: "pending",
        completeness: "unavailable",
        usage: {
          ...modelUsageReceipt().usage,
          inputTokens: null,
          cachedReadTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
      };
      const pending = fixture.client.modelUsage!(taskId, { lease, receipt });
      const response = {
        invocationId: receipt.invocationId,
        revision: receipt.revision,
        executionAllowed,
      };
      fixture.lastRequest().request.respondJson(response);
      await expect(pending).resolves.toEqual(response);
    },
  );

  it("rejects a malformed execution admission instead of treating a false-like string as permission", async () => {
    const fixture = createFixture();
    const pending = fixture.client.modelUsage!(taskId, { lease, receipt: modelUsageReceipt() });
    fixture.lastRequest().request.respondJson({
      invocationId: "invocation-1",
      revision: 3,
      executionAllowed: "false",
    });
    expect((await rejectionOf(pending)).code).toBe("invalid_response");
  });

  it.each(["task", "attempt", "usage"])(
    "rejects an invalid model accounting %s binding before transport",
    async (binding) => {
      const fixture = createFixture();
      const receipt = modelUsageReceipt();
      if (binding === "task") receipt.taskId = "another-task";
      if (binding === "attempt") receipt.attemptId = "another-attempt";
      if (binding === "usage") receipt.usage.cachedReadTokens = 100;
      expect((await rejectionOf(fixture.client.modelUsage!(taskId, { lease, receipt }))).code).toBe(
        "invalid_request",
      );
      expect(fixture.httpsRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    { invocationId: "another-invocation", revision: 3 },
    { invocationId: "invocation-1", revision: 2 },
    { invocationId: "invocation-1", revision: 4 },
  ])(
    "rejects a model accounting acknowledgement for another identity or revision: %j",
    async (response) => {
      const fixture = createFixture();
      const pending = fixture.client.modelUsage!(taskId, { lease, receipt: modelUsageReceipt() });
      fixture.lastRequest().request.respondJson(response);
      expect((await rejectionOf(pending)).code).toBe("invalid_response");
    },
  );

  it("authenticates cleanup with the exact original lease even after execution ends", async () => {
    const fixture = createFixture();
    const request = { lease, ownedProcessesStopped: true as const, desktopRestored: true as const };
    const pending = fixture.client.cleanup!(taskId, request);
    const captured = fixture.lastRequest();
    expect(captured.url.pathname).toBe("/api/worker/tasks/task%3A1/cleanup");
    expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(request);
    captured.request.respondJson({ released: true, attemptId });
    await expect(pending).resolves.toEqual({ released: true, attemptId });
  });

  it("reports fenced activity separately from heartbeat and accepts unknown progress times", async () => {
    const fixture = createFixture();
    const request = { lease, sequence: 1, kind: "stage" as const, stage: "model" as const };
    const pending = fixture.client.progress!(taskId, request);
    const captured = fixture.lastRequest();
    expect(captured.url.pathname).toBe("/api/worker/tasks/task%3A1/progress");
    expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(request);
    const progress = {
      stage: "model",
      stageStartedAt: serverTime,
      lastActivityAt: serverTime,
      lastMeaningfulProgressAt: null,
      lastHeartbeatAt: null,
    };
    captured.request.respondJson({ progress });
    await expect(pending).resolves.toEqual({ progress });
  });

  it("rejects a cleanup response for another attempt", async () => {
    const fixture = createFixture();
    const pending = fixture.client.cleanup!(taskId, {
      lease,
      ownedProcessesStopped: true,
      desktopRestored: true,
    });
    fixture.lastRequest().request.respondJson({ released: true, attemptId: "another-attempt" });
    expect((await rejectionOf(pending)).code).toBe("invalid_response");
  });

  it("reuses verified Server TLS configuration and authenticates each request with the Worker Bearer token", async () => {
    const fixture = createFixture({ tls: { ca: "fixture-ca", serverName: "worker-api.internal" } });
    for (let index = 0; index < 2; index += 1) {
      const pending = fixture.client.claim(claimRequest);
      fixture.lastRequest().request.respondJson({ claim: null });
      await expect(pending).resolves.toBeNull();
    }

    expect(fixture.createSecureContext).toHaveBeenCalledExactlyOnceWith({ ca: "fixture-ca" });
    expect(fixture.httpsRequest).toHaveBeenCalledTimes(2);
    expect(fixture.httpRequest).not.toHaveBeenCalled();
    for (const captured of fixture.requests) {
      expect(captured.url.href).toBe("https://worker-api.test/api/worker/claims");
      expect(captured.options).toMatchObject({
        method: "POST",
        secureContext: fixture.secureContext,
        rejectUnauthorized: true,
        servername: "worker-api.internal",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${workerToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(JSON.stringify(claimRequest)),
        },
      });
      expect(captured.options).not.toHaveProperty("cert");
      expect(captured.options).not.toHaveProperty("key");
      expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(
        claimRequest,
      );
    }
  });

  it("uses explicitly enabled loopback HTTP with Bearer authentication", async () => {
    const fixture = createFixture({ serverUrl: "http://127.0.0.1:8080", allowInsecureHttp: true });
    const pending = fixture.client.claim(claimRequest);
    fixture.lastRequest().request.respondJson({ claim: null });

    await expect(pending).resolves.toBeNull();
    expect(fixture.httpRequest).toHaveBeenCalledOnce();
    expect(fixture.httpsRequest).not.toHaveBeenCalled();
    expect(fixture.createSecureContext).not.toHaveBeenCalled();
    expect(fixture.lastRequest().options.headers).toMatchObject({
      authorization: `Bearer ${workerToken}`,
    });
    expect(fixture.lastRequest().options).not.toHaveProperty("secureContext");
  });

  it.each([
    { serverUrl: "http://worker-api.test", allowInsecureHttp: true },
    { serverUrl: "http://127.0.0.1:8080" },
    { serverUrl: "https://worker-api.test/prefix" },
    { serverUrl: "https://user:password@worker-api.test" },
    { workerToken: "unsafe\r\nheader: value" },
  ])("rejects unsafe configuration before making a request: %j", (options) => {
    expect(() => createFixture(options)).toThrowError(
      expect.objectContaining({ code: "invalid_configuration", retryable: false }),
    );
  });

  it("unwraps a native claim including its task, attempt, lease, and checkpoint", async () => {
    const fixture = createFixture();
    const claim = { ...claimFixture(), checkpoint: checkpointFixture() };
    const pending = fixture.client.claim(claimRequest);
    fixture.lastRequest().request.respondJson({ claim });

    await expect(pending).resolves.toEqual(claim);
  });

  it.each([200, 204])("returns null for an empty queue with status %i", async (statusCode) => {
    const fixture = createFixture();
    const pending = fixture.client.claim(claimRequest);
    const response = fixture.lastRequest().request.startResponse(statusCode);
    response.finish(...(statusCode === 200 ? [JSON.stringify({ claim: null })] : []));

    await expect(pending).resolves.toBeNull();
  });

  it("serializes lease-fenced task operations to their native paths and returns typed response DTOs", async () => {
    const fixture = createFixture();
    const checkpointRequest = checkpointRequestFixture();
    const executionRequest: InvestigationCheckpointRequest = {
      kind: "execution",
      lease,
      execution: checkpointFixture().runtime,
    };
    const interruptRequest: InvestigationCheckpointRequest = {
      kind: "interrupt",
      lease,
      reason: "interrupted",
      diagnostics: [],
    };
    const partRequest = partFixture();
    const artifactRequest = artifactFixture();
    const artifactContentRequest = { lease, artifactId: artifactRequest.artifact.id };
    const finalizeRequest = finalizeFixture();
    const operations = [
      {
        path: "heartbeat",
        request: heartbeatRequest,
        response: heartbeatResponse,
        invoke: () => fixture.client.heartbeat(taskId, heartbeatRequest),
      },
      {
        path: "checkpoints",
        request: checkpointRequest,
        response: { checkpoint: checkpointFixture() },
        invoke: () => fixture.client.checkpoint(taskId, checkpointRequest),
      },
      {
        path: "checkpoints",
        request: executionRequest,
        response: { checkpoint: checkpointFixture() },
        invoke: () => fixture.client.checkpoint(taskId, executionRequest),
      },
      {
        path: "checkpoints",
        request: interruptRequest,
        response: { checkpoint: checkpointFixture() },
        invoke: () => fixture.client.checkpoint(taskId, interruptRequest),
      },
      {
        path: "artifacts",
        request: artifactRequest,
        response: { accepted: true },
        invoke: () => fixture.client.uploadArtifact(taskId, artifactRequest),
      },
      {
        path: "artifact-content",
        request: artifactContentRequest,
        response: {
          artifact: artifactRequest.artifact,
          contentBase64: artifactRequest.contentBase64,
        },
        invoke: () => fixture.client.readArtifact(taskId, artifactContentRequest),
      },
      {
        path: "report-parts",
        request: partRequest,
        response: { accepted: true },
        invoke: () => fixture.client.uploadReportPart(taskId, partRequest),
      },
      {
        path: "finalize",
        request: finalizeRequest,
        response: { reportRef: { id: "report-1", version: 1, digest } },
        invoke: () => fixture.client.finalize(taskId, finalizeRequest),
      },
    ];
    for (const operation of operations) {
      const pending = operation.invoke();
      const captured = fixture.lastRequest();
      expect(captured.url.pathname).toBe(`/api/worker/tasks/task%3A1/${operation.path}`);
      expect(captured.options.method).toBe("POST");
      expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(
        operation.request,
      );
      captured.request.respondJson(operation.response);
      await expect(pending).resolves.toEqual(operation.response);
    }
  });

  it("rejects invalid request DTOs and unsafe task identifiers before transport", async () => {
    const fixture = createFixture();
    const invalidLease = { lease: { ...lease, fence: -1 } };
    for (const pending of [
      fixture.client.claim({ supportedKinds: [] }),
      fixture.client.heartbeat(taskId, invalidLease),
      fixture.client.heartbeat("../another-task", heartbeatRequest),
    ]) {
      expect(await rejectionOf(pending)).toMatchObject({
        code: "invalid_request",
        retryable: false,
      });
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it("rejects report parts bound to another attempt before transport", async () => {
    const fixture = createFixture();
    const request = partFixture();
    request.part.attemptId = "another-attempt";

    const error = await rejectionOf(fixture.client.uploadReportPart(taskId, request));

    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(fixture.requests).toHaveLength(0);
  });

  it("keeps the submitted checkpoint binding stable when the caller mutates its original DTO", async () => {
    const fixture = createFixture();
    const request = checkpointRequestFixture();
    const pending = fixture.client.checkpoint(taskId, request);
    request.round.round = 2;
    fixture.lastRequest().request.respondJson({ checkpoint: checkpointFixture() });

    await expect(pending).resolves.toEqual({ checkpoint: checkpointFixture() });
    expect(
      JSON.parse(Buffer.concat(fixture.lastRequest().request.chunks).toString("utf8")),
    ).toMatchObject({
      kind: "analysis",
      round: { round: 1 },
    });
  });

  it("submits a source manifest without analysis-only fields and preserves the acknowledged coverage", async () => {
    const fixture = createFixture();
    const request: InvestigationCheckpointRequest = {
      kind: "source",
      lease,
      manifest: sourceManifestFixture(),
    };
    const checkpoint = checkpointFixture();
    checkpoint.runtime.sourceCoverage = { manifest: request.manifest, brokeredUnitIds: [] };
    const pending = fixture.client.checkpoint(taskId, request);
    const captured = fixture.lastRequest();
    captured.request.respondJson({ checkpoint });

    await expect(pending).resolves.toEqual({ checkpoint });
    expect(captured.url.pathname).toBe("/api/worker/tasks/task%3A1/checkpoints");
    expect(JSON.parse(Buffer.concat(captured.request.chunks).toString("utf8"))).toEqual(request);
  });

  it("preserves the actual source unit IDs submitted with an analysis round", async () => {
    const fixture = createFixture();
    const request = checkpointRequestFixture();
    request.sourceUnitIds = ["chunk-diff", "chunk-head"];
    const pending = fixture.client.checkpoint(taskId, request);
    request.sourceUnitIds.push("unsubmitted-chunk");
    const checkpoint = checkpointFixture();
    checkpoint.runtime.sourceCoverage = {
      manifest: sourceManifestFixture(),
      brokeredUnitIds: ["chunk-diff", "chunk-head"],
    };
    fixture.lastRequest().request.respondJson({ checkpoint });

    await expect(pending).resolves.toEqual({ checkpoint });
    expect(
      JSON.parse(Buffer.concat(fixture.lastRequest().request.chunks).toString("utf8")),
    ).toMatchObject({
      sourceUnitIds: ["chunk-diff", "chunk-head"],
    });
  });

  it.each(["task", "attempt", "digest", "byte length", "encoding"] as const)(
    "rejects an artifact with an invalid %s before transport",
    async (field) => {
      const fixture = createFixture();
      const request = artifactFixture();
      if (field === "task") request.artifact.taskId = "another-task";
      if (field === "attempt") request.artifact.attemptId = "another-attempt";
      if (field === "digest") request.artifact.digest = "0".repeat(64);
      if (field === "byte length") request.artifact.byteLength += 1;
      if (field === "encoding") request.contentBase64 += "\n";

      const error = await rejectionOf(fixture.client.uploadArtifact(taskId, request));

      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect(fixture.requests).toHaveLength(0);
    },
  );

  it("rejects artifact content exceeding the 32 MiB decoded limit before transport", async () => {
    const fixture = createFixture();
    const request = artifactFixture(Buffer.alloc(32 * 1_024 * 1_024 + 1, 0x61));

    const error = await rejectionOf(fixture.client.uploadArtifact(taskId, request));

    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(fixture.requests).toHaveLength(0);
  });

  it("rejects finalization when the manifest and header describe different reports", async () => {
    const fixture = createFixture();
    const request = finalizeFixture();
    request.manifest.reportId = "another-report";

    const error = await rejectionOf(fixture.client.finalize(taskId, request));

    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(fixture.requests).toHaveLength(0);
  });

  it("reads parent-report artifacts without rewriting their original provenance", async () => {
    const fixture = createFixture();
    const artifact = artifactFixture();
    artifact.artifact.taskId = "parent-task";
    artifact.artifact.attemptId = "parent-attempt";
    artifact.artifact.subjectRef = "parent-subject";
    const response = { artifact: artifact.artifact, contentBase64: artifact.contentBase64 };
    const pending = fixture.client.readArtifact(taskId, {
      lease,
      artifactId: artifact.artifact.id,
    });
    fixture.lastRequest().request.respondJson(response);

    await expect(pending).resolves.toEqual(response);
  });
});

describe("Investigation HTTP client response validation", () => {
  it("accepts complete claim checkpoints above the artifact response size while honoring a lower configured cap", async () => {
    const summaryBytes = 49 * 1_024 * 1_024;
    const claim = claimFixture();
    claim.task.budget = { ...claim.task.budget, maxReportBytes: 64 * 1_024 * 1_024 };
    claim.checkpoint = checkpointFixture();
    claim.checkpoint.budget = { ...claim.task.budget };
    claim.checkpoint.consumed = { ...claim.checkpoint.consumed, reportBytes: summaryBytes };
    claim.checkpoint.analysis.summary = "x".repeat(summaryBytes);
    const payload = JSON.stringify({ claim });
    const fixture = createFixture();
    const pending = fixture.client.claim(claimRequest);
    fixture.lastRequest().request.startResponse().finish(payload);

    const response = await pending;
    expect(response?.checkpoint?.analysis.summary.length).toBe(summaryBytes);

    const bounded = createFixture({ maximumResponseBytes: 48 * 1_024 * 1_024 });
    const rejected = bounded.client.claim(claimRequest);
    bounded.lastRequest().request.startResponse().finish(payload);
    expect(await rejectionOf(rejected)).toMatchObject({
      code: "response_too_large",
      retryable: false,
    });
  });

  it("fences source checkpoint responses to the current attempt", async () => {
    const fixture = createFixture();
    const request: InvestigationCheckpointRequest = {
      kind: "source",
      lease,
      manifest: sourceManifestFixture(),
    };
    const checkpoint = checkpointFixture();
    checkpoint.attemptId = "another-attempt";
    const pending = fixture.client.checkpoint(taskId, request);
    fixture.lastRequest().request.respondJson({ checkpoint });

    expect(await rejectionOf(pending)).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it.each(["identity", "digest", "byte length", "canonical encoding"] as const)(
    "rejects artifact content with an invalid %s receipt",
    async (field) => {
      const fixture = createFixture();
      const artifact = artifactFixture(Buffer.from("f"));
      const pending = fixture.client.readArtifact(taskId, {
        lease,
        artifactId: artifact.artifact.id,
      });
      if (field === "identity") artifact.artifact.id = "another-artifact";
      if (field === "digest") artifact.artifact.digest = "0".repeat(64);
      if (field === "byte length") artifact.artifact.byteLength += 1;
      if (field === "canonical encoding") artifact.contentBase64 = "Zh==";
      fixture.lastRequest().request.respondJson({
        artifact: artifact.artifact,
        contentBase64: artifact.contentBase64,
      });

      expect(await rejectionOf(pending)).toMatchObject({
        code: "invalid_response",
        statusCode: 200,
        retryable: false,
      });
    },
  );

  it.each([workerToken, lease.leaseToken])(
    "rejects credentials encoded within artifact content",
    async (credential) => {
      const fixture = createFixture();
      const artifact = artifactFixture(Buffer.from(credential));
      const pending = fixture.client.readArtifact(taskId, {
        lease,
        artifactId: artifact.artifact.id,
      });
      fixture.lastRequest().request.respondJson({
        artifact: artifact.artifact,
        contentBase64: artifact.contentBase64,
      });

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({
        code: "confidential_response",
        statusCode: 200,
        retryable: false,
      });
      expectSafeError(error, credential);
    },
  );

  it.each([
    { cancelRequested: "false", leaseExpiresAt: serverTime, serverTime },
    { cancelRequested: false, leaseExpiresAt: "not-a-date", serverTime },
    { ...heartbeatResponse, extra: "unexpected" },
  ])("rejects malformed heartbeat DTOs: %j", async (payload) => {
    const fixture = createFixture();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest);
    fixture.lastRequest().request.respondJson(payload);

    expect(await rejectionOf(pending)).toMatchObject({
      code: "invalid_response",
      statusCode: 200,
      retryable: false,
    });
  });

  it("rejects 204 for an operation that requires a response DTO", async () => {
    const fixture = createFixture();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest);
    fixture.lastRequest().request.startResponse(204).finish();

    expect(await rejectionOf(pending)).toMatchObject({ code: "invalid_response", statusCode: 204 });
  });

  it.each(["task", "fence", "kind"] as const)(
    "rejects a claim with an inconsistent %s binding",
    async (binding) => {
      const fixture = createFixture();
      const claim = claimFixture();
      if (binding === "task") claim.attempt.taskId = "another-task";
      if (binding === "fence") claim.lease.fence += 1;
      if (binding === "kind") claim.task.kind = "feature-implement";
      const pending = fixture.client.claim(claimRequest);
      fixture.lastRequest().request.respondJson({ claim });

      expect(await rejectionOf(pending)).toMatchObject({
        code: "invalid_response",
        retryable: false,
      });
    },
  );

  it("rejects a checkpoint acknowledged for a different round", async () => {
    const fixture = createFixture();
    const checkpoint = { ...checkpointFixture(), round: 2 };
    const pending = fixture.client.checkpoint(taskId, checkpointRequestFixture());
    fixture.lastRequest().request.respondJson({ checkpoint });

    expect(await rejectionOf(pending)).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a finalize receipt for a different report digest", async () => {
    const fixture = createFixture();
    const pending = fixture.client.finalize(taskId, finalizeFixture());
    fixture
      .lastRequest()
      .request.respondJson({ reportRef: { id: "report-1", version: 1, digest: "b".repeat(64) } });

    expect(await rejectionOf(pending)).toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  it.each(["invalid JSON", "invalid UTF-8"])(
    "rejects %s without retaining response bytes",
    async (scenario) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      const bytes =
        scenario === "invalid JSON" ? Buffer.from("{private-response") : Buffer.from([0xff]);
      fixture.lastRequest().request.startResponse().finish(bytes);

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({ code: "invalid_response", retryable: false });
      expectSafeError(error, "private-response");
    },
  );

  it("bounds accumulated response bytes across chunks and closes both streams", async () => {
    const fixture = createFixture({ maximumResponseBytes: 8 });
    const pending = fixture.client.claim(claimRequest);
    const request = fixture.lastRequest().request;
    const response = request.startResponse();
    response.finish(Buffer.from("12345"), Buffer.from("6789"));

    expect(await rejectionOf(pending)).toMatchObject({
      code: "response_too_large",
      retryable: false,
    });
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it.each(["close", "aborted"])(
    "treats a response terminated by %s before end as retryable truncation",
    async (event) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      const response = fixture.lastRequest().request.startResponse();
      response.emit("data", JSON.stringify({ claim: null }));
      response.emit(event);

      expect(await rejectionOf(pending)).toMatchObject({
        code: "transport_error",
        retryable: true,
      });
      expect(response.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["value", "key", "escaped value"])(
    "rejects reflected Worker credentials in a response %s",
    async (location) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      const escapedToken = [...workerToken]
        .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
      const payload =
        location === "escaped value"
          ? `{"code":"upstream_error","details":"${escapedToken}"}`
          : JSON.stringify({
              code: "upstream_error",
              details:
                location === "key" ? { [workerToken]: "reflected" } : [`Bearer ${workerToken}`],
            });
      fixture.lastRequest().request.startResponse(503).finish(payload);

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({
        code: "confidential_response",
        statusCode: 503,
        retryable: false,
      });
      expectSafeError(error, workerToken);
    },
  );

  it("rejects reflected lease credentials in task operation responses", async () => {
    const fixture = createFixture();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest);
    fixture.lastRequest().request.respondJson({ ...heartbeatResponse, details: lease.leaseToken });

    const error = await rejectionOf(pending);
    expect(error).toMatchObject({ code: "confidential_response", retryable: false });
    expectSafeError(error, lease.leaseToken);
  });
});

describe("Investigation HTTP client failure metadata", () => {
  it("enforces an absolute deadline while response bytes are still arriving", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({ requestTimeoutMs: 100 });
      const pending = rejectionOf(fixture.client.heartbeat(taskId, heartbeatRequest));
      const request = fixture.lastRequest().request;
      const response = request.startResponse();
      await vi.advanceTimersByTimeAsync(90);
      response.emit("data", Buffer.from('{"cancelRequested":'));
      expect(request.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);

      expect(await pending).toMatchObject({
        code: "request_timeout",
        statusCode: 408,
        retryable: true,
      });
      expect(request.destroy).toHaveBeenCalledOnce();
      expect(response.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes cancellation listeners after a successful request", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest, controller.signal);
    const request = fixture.lastRequest().request;
    request.respondJson(heartbeatResponse);
    await expect(pending).resolves.toEqual(heartbeatResponse);

    controller.abort();

    expect(request.destroy).not.toHaveBeenCalled();
  });

  it.each([
    { code: "lease_lost", leaseLost: true },
    { code: "idempotency_conflict", leaseLost: false },
  ])(
    "distinguishes $code from other conflicts without retaining remote messages",
    async ({ code, leaseLost }) => {
      const fixture = createFixture();
      const pending = fixture.client.heartbeat(taskId, heartbeatRequest);
      const secret = "private-upstream-diagnostic";
      fixture.lastRequest().request.respondJson({ code, message: secret, retryable: true }, 409);

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({ code, statusCode: 409, retryable: false, leaseLost });
      expectSafeError(error, secret);
    },
  );

  it.each([408, 425, 429, 500, 503])(
    "classifies status %i as retryable without requiring a JSON error body",
    async (statusCode) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      fixture
        .lastRequest()
        .request.startResponse(statusCode)
        .finish("<html>private gateway error</html>");

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({
        code: "http_error",
        statusCode,
        retryable: true,
        leaseLost: false,
      });
      expectSafeError(error, "private gateway error");
    },
  );

  it.each([
    { statusCode: 503, retryable: false },
    { statusCode: 401, retryable: true },
    { statusCode: 422, retryable: true },
  ])(
    "keeps status $statusCode permanent with remote retryable=$retryable",
    async ({ statusCode, retryable }) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      fixture
        .lastRequest()
        .request.respondJson(
          { code: "unavailable", message: "The request was rejected.", retryable },
          statusCode,
        );

      expect(await rejectionOf(pending)).toMatchObject({
        code: "unavailable",
        statusCode,
        retryable: false,
      });
    },
  );

  it("does not interpret an invalid error DTO as an authoritative lease-loss response", async () => {
    const fixture = createFixture();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest);
    fixture.lastRequest().request.respondJson({ code: "lease_lost" }, 409);

    expect(await rejectionOf(pending)).toMatchObject({
      code: "http_error",
      statusCode: 409,
      retryable: false,
      leaseLost: false,
    });
  });

  it.each([
    { code: "ECONNRESET", retryable: true },
    { code: "CERT_HAS_EXPIRED", retryable: false },
  ])(
    "classifies transport $code without retaining the original error or cause",
    async ({ code, retryable }) => {
      const fixture = createFixture();
      const pending = fixture.client.claim(claimRequest);
      const secret = "private-network-cause";
      const original = new Error(secret, {
        cause: Object.assign(new Error(workerToken), { code }),
      });
      fixture.lastRequest().request.emit("error", original);

      const error = await rejectionOf(pending);
      expect(error).toMatchObject({ code: "transport_error", retryable });
      expect(error).not.toBe(original);
      expectSafeError(error, secret, workerToken);
      expect(fixture.lastRequest().request.destroy).toHaveBeenCalledOnce();
    },
  );

  it("rejects an already aborted call without inspecting its reason or making a request", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort(new Error("private-abort-reason"));
    const readReason = vi.spyOn(controller.signal, "reason", "get");

    const error = await rejectionOf(fixture.client.claim(claimRequest, controller.signal));

    expect(error).toMatchObject({ name: "AbortError", code: "request_aborted", retryable: false });
    expectSafeError(error, "private-abort-reason");
    expect(readReason).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
  });

  it("aborts an in-flight response and discards the caller's reason", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const pending = fixture.client.heartbeat(taskId, heartbeatRequest, controller.signal);
    const request = fixture.lastRequest().request;
    const response = request.startResponse();
    controller.abort(new Error("private-running-abort"));
    response.finish(JSON.stringify(heartbeatResponse));

    const error = await rejectionOf(pending);
    expect(error).toMatchObject({ name: "AbortError", code: "request_aborted", retryable: false });
    expectSafeError(error, "private-running-abort");
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(response.destroy).toHaveBeenCalledOnce();
  });
});
