import type {
  ClaimLeaseRequest,
  RunCompletionSubmission,
  RunFailureSubmission,
  WorkerHeartbeatRequest,
  WorkerRegistrationRequest,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ProtocolError, type WorkerApiError } from "../server-client/errors.js";
import {
  type ControlHostControlClient,
  HostControlClientError,
} from "../service-host/host-control-client.js";
import {
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
} from "../service-host/host-control-protocol.js";
import {
  decodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "../service-host/opaque-json.js";
import { parseRuntimeBootstrap } from "../service-host/runtime-bootstrap.js";
import { bootstrapDocument } from "../service-host/runtime-bootstrap.test-helpers.js";
import { HostControlWorkerApi } from "./host-control-worker-api.js";

const serverTime = "2026-08-31T00:00:00.000Z";

interface RecordedCall {
  readonly operation: string;
  readonly body: HostControlOpaqueJsonDescriptor;
  readonly routeId?: string;
}

class FakeControlClient implements ControlHostControlClient {
  public readonly role = "control" as const;
  public readonly bootstrap = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
  public readonly done = new Promise<void>(() => undefined);
  public readonly calls: RecordedCall[] = [];
  public registrationResponse: unknown = validRegistrationResponse();
  public claimResponse: unknown = { outcome: "no_work", serverTime };
  public heartbeatResponse: unknown = validHeartbeatResponse();
  public terminalResponse: unknown = validTerminalResponse();
  public operationError: Error | undefined;

  public async register(body: HostControlOpaqueJsonDescriptor): Promise<unknown> {
    if (this.operationError !== undefined) throw this.operationError;
    this.calls.push({ operation: "Register", body });
    return this.registrationResponse;
  }

  public async claim(body: HostControlOpaqueJsonDescriptor): Promise<unknown> {
    if (this.operationError !== undefined) throw this.operationError;
    this.calls.push({ operation: "Claim", body });
    return this.claimResponse;
  }

  public async instanceHeartbeat(
    workerInstanceId: string,
    body: HostControlOpaqueJsonDescriptor,
  ): Promise<unknown> {
    if (this.operationError !== undefined) throw this.operationError;
    this.calls.push({ operation: "InstanceHeartbeat", body, routeId: workerInstanceId });
    return this.heartbeatResponse;
  }

  public async completeRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
  ): Promise<unknown> {
    if (this.operationError !== undefined) throw this.operationError;
    this.calls.push({ operation: "CompleteRun", body, routeId: runAttemptId });
    return this.terminalResponse;
  }

  public async failRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
  ): Promise<unknown> {
    if (this.operationError !== undefined) throw this.operationError;
    this.calls.push({ operation: "FailRun", body, routeId: runAttemptId });
    return this.terminalResponse;
  }

  public async signLocalDigest(): Promise<string> {
    return "signature";
  }

  public async drain(): Promise<void> {}

  public async close(): Promise<void> {}
}

describe("HostControlWorkerApi opaque Worker API boundary", () => {
  it("preserves a valid fractional completion in exact JSON.stringify bytes", async () => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);
    const submission = completionSubmission({ confidence: 0.8 });

    await expect(api.completeRun(submission.runAttemptId, submission)).resolves.toEqual(
      validTerminalResponse(),
    );
    expect(client.calls).toHaveLength(1);
    const call = requiredCall(client.calls[0]);
    expect(call.operation).toBe("CompleteRun");
    expect(call.routeId).toBe(submission.runAttemptId);
    expect(
      decodeHostControlOpaqueJson(call.body, HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES),
    ).toEqual(submission);
    expect(Buffer.from(call.body.base64Url, "base64url")).toEqual(
      Buffer.from(JSON.stringify(submission), "utf8"),
    );
  });

  it.each([
    ["nonfinite", { confidence: Number.NaN }],
    ["infinity", { confidence: Number.POSITIVE_INFINITY }],
    ["BigInt", { confidence: 1n }],
  ])("rejects %s completion data before issuing HostControl RPC", async (_name, result) => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);

    await expect(api.completeRun("run:1", completionSubmission(result))).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(client.calls).toEqual([]);
  });

  it("rejects cyclic completion data before issuing HostControl RPC", async () => {
    const result: Record<string, unknown> = {};
    result.self = result;
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);

    await expect(api.completeRun("run:1", completionSubmission(result))).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(client.calls).toEqual([]);
  });

  it.each([
    [
      "Register",
      () => ({ ...registrationRequest(), maxSlots: 0 }),
      (api: HostControlWorkerApi, value: unknown) =>
        api.register(value as WorkerRegistrationRequest),
    ],
    [
      "Claim",
      () => ({ ...claimRequest(), availableSlots: 0 }),
      (api: HostControlWorkerApi, value: unknown) => api.claimLease(value as ClaimLeaseRequest),
    ],
    [
      "InstanceHeartbeat",
      () => ({ ...heartbeatRequest(), observedAt: "invalid" }),
      (api: HostControlWorkerApi, value: unknown) =>
        api.heartbeat("worker:instance", value as WorkerHeartbeatRequest),
    ],
    [
      "CompleteRun",
      () => ({ ...completionSubmission({ ok: true }), leaseGeneration: 0 }),
      (api: HostControlWorkerApi, value: unknown) =>
        api.completeRun("run:1", value as RunCompletionSubmission),
    ],
    [
      "FailRun",
      () => ({ ...failureSubmission(), code: "" }),
      (api: HostControlWorkerApi, value: unknown) =>
        api.failRun("run:1", value as RunFailureSubmission),
    ],
  ] as const)("validates the %s request schema before RPC", async (_operation, create, invoke) => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);

    await expect(invoke(api, create())).rejects.toBeInstanceOf(ProtocolError);
    expect(client.calls).toEqual([]);
  });

  it("accepts a granted claim containing the contracts uri format", async () => {
    const client = new FakeControlClient();
    client.claimResponse = grantedClaimResponse();
    const api = new HostControlWorkerApi(client);

    await expect(api.claimLease(claimRequest())).resolves.toEqual(grantedClaimResponse());
    const call = requiredCall(client.calls[0]);
    expect(decodeHostControlOpaqueJson(call.body, HOST_CONTROL_MAXIMUM_BODY_BYTES)).toEqual(
      claimRequest(),
    );
  });

  it("rejects oversized completion JSON before issuing HostControl RPC", async () => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);
    const submission = completionSubmission({
      value: "x".repeat(HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES),
    });

    await expect(api.completeRun(submission.runAttemptId, submission)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(client.calls).toEqual([]);
  });

  it("rejects invalid and cross-run responses after HostControl decoding", async () => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);
    client.registrationResponse = { invalid: true };
    await expect(api.register(registrationRequest())).rejects.toBeInstanceOf(ProtocolError);

    client.terminalResponse = { ...validTerminalResponse(), runAttemptId: "run:other" };
    await expect(api.completeRun("run:1", completionSubmission({ ok: true }))).rejects.toThrow(
      /another run/u,
    );
  });

  it("rejects route and request identity mismatches before RPC", async () => {
    const client = new FakeControlClient();
    const api = new HostControlWorkerApi(client);

    await expect(api.heartbeat("worker:other", heartbeatRequest())).rejects.toBeInstanceOf(
      ProtocolError,
    );
    await expect(
      api.completeRun("run:other", completionSubmission({ ok: true })),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(api.failRun("run:other", failureSubmission())).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(client.calls).toEqual([]);
  });

  it.each([
    ["Claim", (api: HostControlWorkerApi) => api.claimLease(claimRequest())],
    [
      "Heartbeat",
      (api: HostControlWorkerApi) => api.heartbeat("worker:instance", heartbeatRequest()),
    ],
    [
      "Complete",
      (api: HostControlWorkerApi) =>
        api.completeRun("run:1", completionSubmission({ confidence: 0.8 })),
    ],
  ] as const)("maps %s queue pressure to a retryable Worker API error", async (_name, invoke) => {
    const client = new FakeControlClient();
    client.operationError = new HostControlClientError(
      "OUTPUT_QUEUE_LIMIT_EXCEEDED",
      "HostControl outbound queue exceeds its byte limit.",
    );
    const api = new HostControlWorkerApi(client);

    const failure = invoke(api);
    await expect(failure).rejects.toMatchObject({
      statusCode: 429,
      errorCode: "output_queue_limit_exceeded",
      isRetryable: true,
    } satisfies Partial<WorkerApiError>);
    client.operationError = undefined;
    await expect(api.claimLease(claimRequest())).resolves.toEqual({
      outcome: "no_work",
      serverTime,
    });
  });
});

function registrationRequest(): WorkerRegistrationRequest {
  return {
    protocolVersion: "1.0",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    displayName: "Worker",
    workerVersion: "1.0.0",
    maxSlots: 1,
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "1.0.0",
      recipeIds: [],
      labels: {},
    },
  };
}

function claimRequest(): ClaimLeaseRequest {
  return {
    protocolVersion: "1.0",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    availableSlots: 1,
    waitSeconds: 0,
    capabilitiesDigest: "a".repeat(64),
  };
}

function heartbeatRequest(): WorkerHeartbeatRequest {
  return {
    protocolVersion: "1.0",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    heartbeatSequence: 1,
    observedAt: serverTime,
    availableSlots: 1,
    activeLeases: [],
    health: { state: "online", freeDiskBytes: 1, memoryUsageBytes: 1 },
  };
}

function completionSubmission(result: unknown): RunCompletionSubmission {
  return {
    jobId: "job:1",
    runAttemptId: "run:1",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    leaseToken: "t".repeat(32),
    leaseGeneration: 1,
    resultDigest: "b".repeat(64),
    result,
  };
}

function failureSubmission(): RunFailureSubmission {
  return {
    jobId: "job:1",
    runAttemptId: "run:1",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    leaseToken: "t".repeat(32),
    leaseGeneration: 1,
    code: "EXECUTION_FAILED",
    message: "The execution failed.",
    retryable: false,
  };
}

function validRegistrationResponse() {
  return {
    protocolVersion: "1.0" as const,
    workerId: "worker:id",
    state: "online" as const,
    heartbeatIntervalMs: 5_000,
    leaseTtlMs: 30_000,
    serverTime,
  };
}

function validHeartbeatResponse() {
  return {
    serverTime,
    nextHeartbeatInMs: 5_000,
    workerState: "online" as const,
    commands: [],
  };
}

function validTerminalResponse() {
  return {
    jobId: "job:1",
    runAttemptId: "run:1",
    jobState: "succeeded" as const,
    runState: "succeeded" as const,
  };
}

function grantedClaimResponse() {
  return {
    outcome: "granted" as const,
    serverTime,
    envelope: {
      protocolVersion: "1.0" as const,
      envelopeVersion: 1 as const,
      assignedAt: serverTime,
      leaseExpiresAt: "2026-08-31T00:01:00.000Z",
      executionDeadlineAt: "2026-08-31T00:05:00.000Z",
      lease: {
        jobId: "job:1",
        runAttemptId: "run:1",
        workerNodeId: "worker:node",
        workerInstanceId: "worker:instance",
        leaseToken: "t".repeat(32),
        leaseGeneration: 1,
      },
      job: {
        jobId: "job:1",
        kind: "issue_triage" as const,
        priority: 1,
        attempt: 1,
        maxAttempts: 3,
        generation: 1,
        intentVersion: 1,
        semanticKey: "issue:1",
      },
      repository: { githubRepositoryId: 1, fullName: "microsoft/PowerToys" },
      resource: {
        kind: "issue" as const,
        githubNodeId: "issue:node",
        number: 1,
        title: "Issue",
        author: {
          githubUserId: 1,
          login: "author",
          avatarUrl: "https://avatars.example.test/author.png",
        },
        canonicalSnapshot: { body: "Issue body" },
        revisionDigest: "c".repeat(64),
      },
      prompt: {
        name: "issue-triage",
        version: "1",
        renderedPrompt: "Review the issue.",
        promptSha256: "d".repeat(64),
        outputSchema: { type: "object" },
        outputSchemaSha256: "e".repeat(64),
      },
      executionPolicy: {
        hardTimeoutMs: 300_000,
        noProgressTimeoutMs: 60_000,
        maxCodexTurns: 4,
        allowedRecipeIds: [],
        requiredCapabilityLabels: {},
      },
    },
  };
}

function requiredCall(value: RecordedCall | undefined): RecordedCall {
  if (value === undefined) throw new Error("Expected a recorded HostControl call.");
  return value;
}
