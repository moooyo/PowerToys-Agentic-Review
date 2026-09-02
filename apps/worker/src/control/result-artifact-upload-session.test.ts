import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CommittedRunArtifact,
  CreateResultArtifactUploadRequest,
  CreateResultArtifactUploadResponse,
  FinalizeResultArtifactUploadRequest,
  FinalizeResultArtifactUploadResponse,
  ResultArtifactChunkRequest,
  ResultArtifactChunkResponse,
  TerminateResultArtifactUploadRequest,
  TerminateResultArtifactUploadResponse,
} from "@agentic-review/contracts";
import {
  type ArtifactChunkMessage,
  type ArtifactEndMessage,
  type ArtifactStartMessage,
  type CompleteMessage,
  type FailedMessage,
  sha256Hex,
} from "@agentic-review/local-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ResultArtifactUploadApi,
  ResultArtifactUploadApiError,
  type ResultArtifactUploadContext,
  type ResultArtifactUploadEvent,
  type ResultArtifactUploadRetryPolicy,
  ResultArtifactUploadSession,
  type ResultArtifactUploadSessionOptions,
} from "./result-artifact-upload-session.js";

const token = "private-server-lease-token".padEnd(32, "x");
const uploadId = "20000000-0000-4000-8000-000000000002";
const serverArtifactId = "30000000-0000-4000-8000-000000000003";
const artifactId = "40000000-0000-4000-8000-000000000004";
const content = Buffer.from('{"summary":"bounded"}', "utf8");
const contentSha256 = sha256Hex(content);
const chunkData = content.toString("base64url");
const context: ResultArtifactUploadContext = {
  protocolMajor: 1,
  protocolMinor: 0,
  workerNodeId: "worker:node",
  workerInstanceId: "worker:instance",
  executorBootId: "50000000-0000-4000-8000-000000000005",
  sessionId: "60000000-0000-4000-8000-000000000006",
  attemptCorrelationId: "70000000-0000-4000-8000-000000000007",
  runAttemptId: "run:attempt",
};

interface RecordedCall<TRequest> {
  readonly routeId: string;
  readonly request: Readonly<TRequest>;
  readonly signal: AbortSignal;
}

interface MutableUploadEvent<TType extends ResultArtifactUploadEvent["type"], TMessage> {
  type: TType;
  message: TMessage;
}

class FakeResultArtifactUploadApi implements ResultArtifactUploadApi {
  public readonly createCalls: RecordedCall<CreateResultArtifactUploadRequest>[] = [];
  public readonly putCalls: (RecordedCall<ResultArtifactChunkRequest> & {
    readonly chunkIndex: number;
  })[] = [];
  public readonly finalizeCalls: RecordedCall<FinalizeResultArtifactUploadRequest>[] = [];
  public readonly terminateCalls: RecordedCall<TerminateResultArtifactUploadRequest>[] = [];
  public createImplementation: () => Promise<CreateResultArtifactUploadResponse> = async () =>
    createResponse();
  public putImplementation: () => Promise<ResultArtifactChunkResponse> = async () =>
    chunkResponse();
  public finalizeImplementation: () => Promise<FinalizeResultArtifactUploadResponse> = async () =>
    finalizeResponse();
  public terminateImplementation: () => Promise<TerminateResultArtifactUploadResponse> = async () =>
    terminateResponse();

  public async create(
    runAttemptId: string,
    request: Readonly<CreateResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<CreateResultArtifactUploadResponse> {
    this.createCalls.push({ routeId: runAttemptId, request, signal });
    return await this.createImplementation();
  }

  public async put(
    routeUploadId: string,
    chunkIndex: number,
    request: Readonly<ResultArtifactChunkRequest>,
    signal: AbortSignal,
  ): Promise<ResultArtifactChunkResponse> {
    this.putCalls.push({ routeId: routeUploadId, chunkIndex, request, signal });
    return await this.putImplementation();
  }

  public async finalize(
    routeUploadId: string,
    request: Readonly<FinalizeResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<FinalizeResultArtifactUploadResponse> {
    this.finalizeCalls.push({ routeId: routeUploadId, request, signal });
    return await this.finalizeImplementation();
  }

  public async terminate(
    routeUploadId: string,
    request: Readonly<TerminateResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<TerminateResultArtifactUploadResponse> {
    this.terminateCalls.push({ routeId: routeUploadId, request, signal });
    return await this.terminateImplementation();
  }
}

interface SessionHarness {
  readonly api: FakeResultArtifactUploadApi;
  readonly port: ResultArtifactUploadApi;
  readonly clock: { now: number };
  readonly delays: number[];
  readonly session: ResultArtifactUploadSession;
}

function createHarness(
  overrides: Partial<
    Pick<
      ResultArtifactUploadSessionOptions,
      "hardDeadlineMonotonicMilliseconds" | "leaseDeadlineMonotonicMilliseconds"
    >
  > & {
    readonly retryPolicy?: Readonly<ResultArtifactUploadRetryPolicy>;
    readonly wait?: (delayMilliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): SessionHarness {
  const api = new FakeResultArtifactUploadApi();
  const port = boundPort(api);
  const clock = { now: 100 };
  const delays: number[] = [];
  const session = new ResultArtifactUploadSession({
    api: port,
    context,
    lease: {
      jobId: "job:1",
      runAttemptId: context.runAttemptId,
      workerNodeId: context.workerNodeId,
      workerInstanceId: context.workerInstanceId,
      leaseToken: token,
      leaseGeneration: 7,
    },
    leaseDeadlineMonotonicMilliseconds: overrides.leaseDeadlineMonotonicMilliseconds ?? 10_000,
    hardDeadlineMonotonicMilliseconds: overrides.hardDeadlineMonotonicMilliseconds ?? 20_000,
    ...(overrides.retryPolicy === undefined ? {} : { retryPolicy: overrides.retryPolicy }),
    dependencies: {
      now: () => clock.now,
      wait:
        overrides.wait ??
        (async (delayMilliseconds, signal) => {
          if (signal.aborted) throw new Error("wait aborted");
          delays.push(delayMilliseconds);
          clock.now += delayMilliseconds;
        }),
    },
  });
  return { api, port, clock, delays, session };
}

function boundPort(api: FakeResultArtifactUploadApi): ResultArtifactUploadApi {
  return {
    create: api.create.bind(api),
    put: api.put.bind(api),
    finalize: api.finalize.bind(api),
    terminate: api.terminate.bind(api),
  };
}

function defaultOptions(
  api: ResultArtifactUploadApi,
  dependencies: ResultArtifactUploadSessionOptions["dependencies"] = {},
): ResultArtifactUploadSessionOptions {
  return {
    api,
    context,
    lease: {
      jobId: "job:1",
      runAttemptId: context.runAttemptId,
      workerNodeId: context.workerNodeId,
      workerInstanceId: context.workerInstanceId,
      leaseToken: token,
      leaseGeneration: 7,
    },
    leaseDeadlineMonotonicMilliseconds: 10_000,
    hardDeadlineMonotonicMilliseconds: 20_000,
    dependencies,
  };
}

describe("dormant result artifact upload session", () => {
  it("keeps the source-only API and class surface exact", () => {
    expectTypeOf<keyof ResultArtifactUploadApi>().toEqualTypeOf<
      "create" | "put" | "finalize" | "terminate"
    >();
    expect(Object.getOwnPropertyNames(ResultArtifactUploadSession.prototype)).toEqual([
      "constructor",
      "state",
      "accept",
      "shutdown",
    ]);

    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    for (const relativePath of [
      "apps/worker/src/main.ts",
      "apps/worker/src/control-main.ts",
      "apps/worker/src/executor-main.ts",
      "apps/worker/src/service-host/index.ts",
      "apps/worker/src/local/index.ts",
    ]) {
      expect(readFileSync(resolve(repositoryRoot, relativePath), "utf8")).not.toContain(
        "result-artifact-upload-session",
      );
    }
  });

  it("uploads one result and closes only after the matching Complete event", async () => {
    const { api, session } = createHarness();

    expect(session.state).toEqual({
      phase: "created",
      clientArtifactId: null,
      uploadId: null,
      nextChunkIndex: 0,
      nextOffsetBytes: 0,
      committedArtifact: null,
      closure: null,
      failure: null,
    });
    expect(Object.isFrozen(session.state)).toBe(true);

    await session.accept(startEvent());
    expect(session.state).toMatchObject({
      phase: "receiving",
      clientArtifactId: artifactId,
      uploadId,
      nextChunkIndex: 0,
      nextOffsetBytes: 0,
    });
    const create = required(api.createCalls[0]);
    expect(create.routeId).toBe(context.runAttemptId);
    expect(create.request).toEqual({
      jobId: "job:1",
      runAttemptId: context.runAttemptId,
      workerNodeId: context.workerNodeId,
      workerInstanceId: context.workerInstanceId,
      leaseToken: token,
      leaseGeneration: 7,
      clientArtifactId: artifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: content.byteLength,
      sha256: contentSha256,
    });
    expect(Object.isFrozen(create.request)).toBe(true);

    await session.accept(chunkEvent());
    expect(session.state).toMatchObject({
      phase: "receiving",
      nextChunkIndex: 1,
      nextOffsetBytes: content.byteLength,
    });
    expect(required(api.putCalls[0])).toMatchObject({ routeId: uploadId, chunkIndex: 0 });

    await session.accept(endEvent());
    expect(session.state).toMatchObject({
      phase: "committed",
      committedArtifact: committedArtifact(),
    });
    expect(Object.isFrozen(session.state.committedArtifact)).toBe(true);

    const complete = completeEvent();
    const closed = await session.accept(complete);
    expect(closed).toMatchObject({ phase: "closed", closure: "complete", failure: null });
    await expect(session.accept(complete)).resolves.toEqual(closed);
    expect(api.terminateCalls).toEqual([]);
    expect(JSON.stringify(session)).not.toContain(token);
    expect(JSON.stringify(session.state)).not.toContain(token);
    expect(JSON.stringify(session.state)).not.toContain(chunkData);
  });

  it("abandons an active upload on Failed and accepts only its exact terminal replay", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    const failed = failedEvent();

    const closed = await session.accept(failed);
    expect(closed).toMatchObject({
      phase: "closed",
      closure: "executor_failed",
      failure: null,
    });
    expect(required(api.terminateCalls[0])).toMatchObject({
      routeId: uploadId,
      request: {
        jobId: "job:1",
        runAttemptId: context.runAttemptId,
        workerNodeId: context.workerNodeId,
        workerInstanceId: context.workerInstanceId,
        leaseToken: token,
        leaseGeneration: 7,
        state: "abandoned",
        reason: "client_abandoned",
      },
    });
    await expect(session.accept(failed)).resolves.toEqual(closed);
    await expect(
      session.accept({
        type: "Failed",
        message: { ...failed.message, code: "CHANGED_FAILURE" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(api.terminateCalls).toHaveLength(1);
  });

  it("closes a pre-upload failure without inventing a Server mutation", async () => {
    const { api, session } = createHarness();

    await expect(session.accept(failedEvent())).resolves.toMatchObject({
      phase: "closed",
      closure: "executor_failed",
    });
    expect(api.createCalls).toEqual([]);
    expect(api.terminateCalls).toEqual([]);
  });

  it("replays an ambiguous create with the identical frozen application request", async () => {
    const { api, delays, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 3,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 100,
      },
    });
    let attempt = 0;
    api.createImplementation = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ResultArtifactUploadApiError("ambiguous", "TRANSPORT_OUTCOME_UNKNOWN", true);
      }
      return createResponse(true);
    };

    await expect(session.accept(startEvent())).resolves.toMatchObject({ phase: "receiving" });
    expect(delays).toEqual([10]);
    expect(api.createCalls).toHaveLength(2);
    expect(required(api.createCalls[0]).request).toBe(required(api.createCalls[1]).request);
    expect(required(api.createCalls[0]).signal).not.toBe(required(api.createCalls[1]).signal);
  });

  it("uses explicit definitive retryability and bounded exponential backoff", async () => {
    const { api, delays, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 4,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 15,
      },
    });
    await session.accept(startEvent());
    let attempt = 0;
    api.putImplementation = async () => {
      attempt += 1;
      if (attempt < 3) {
        throw new ResultArtifactUploadApiError("definitive", "SERVER_BUSY", true);
      }
      return chunkResponse();
    };

    await expect(session.accept(chunkEvent())).resolves.toMatchObject({ nextChunkIndex: 1 });
    expect(delays).toEqual([10, 15]);
    expect(api.putCalls).toHaveLength(3);
    expect(required(api.putCalls[0]).request).toBe(required(api.putCalls[1]).request);
    expect(required(api.putCalls[1]).request).toBe(required(api.putCalls[2]).request);
  });

  it("never downgrades an earlier ambiguous outcome to a later definitive failure", async () => {
    const { api, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 3,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    let attempt = 0;
    api.createImplementation = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ResultArtifactUploadApiError("ambiguous", "TRANSPORT_OUTCOME_UNKNOWN", true);
      }
      throw new ResultArtifactUploadApiError("definitive", "SERVER_REJECTED", false);
    };

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "TRANSPORT_OUTCOME_UNKNOWN",
        attempts: 2,
      },
    });
    expect(api.createCalls).toHaveLength(2);
  });

  it("replays a malformed finalize response without changing its request identity", async () => {
    const { api, delays, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 2,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    await session.accept(startEvent());
    await session.accept(chunkEvent());
    let attempt = 0;
    api.finalizeImplementation = async () => {
      attempt += 1;
      return attempt === 1 ? finalizeResponse({ runAttemptId: "run:other" }) : finalizeResponse();
    };

    await expect(session.accept(endEvent())).resolves.toMatchObject({ phase: "committed" });
    expect(delays).toEqual([10]);
    expect(api.finalizeCalls).toHaveLength(2);
    expect(required(api.finalizeCalls[0]).request).toBe(required(api.finalizeCalls[1]).request);
  });

  it("rejects accessor responses without reading or publishing their values", async () => {
    const { api, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 1,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    let uploadIdReads = 0;
    const response = { ...createResponse() } as CreateResultArtifactUploadResponse;
    Object.defineProperty(response, "uploadId", {
      enumerable: true,
      get: () => {
        uploadIdReads += 1;
        return token;
      },
    });
    api.createImplementation = async () => response;

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "RESPONSE_INVALID",
        attempts: 1,
      },
    });
    expect(uploadIdReads).toBe(0);
    expect(session.state.uploadId).toBeNull();
    expect(JSON.stringify(session.state)).not.toContain(token);
  });

  it("rejects a response that reflects the private lease token into public identity", async () => {
    const { api, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 1,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    api.createImplementation = async () => ({ ...createResponse(), uploadId: token });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "RESPONSE_SECRET_REFLECTION",
        attempts: 1,
      },
    });
    expect(session.state.uploadId).toBeNull();
    expect(JSON.stringify(session.state)).not.toContain(token);
  });

  it("redacts an API failure code that reflects a grammar-valid lease token", async () => {
    const uppercaseToken = "A".repeat(32);
    const api = new FakeResultArtifactUploadApi();
    const port = boundPort(api);
    api.createImplementation = async () => {
      throw new ResultArtifactUploadApiError("ambiguous", uppercaseToken, false);
    };
    const base = defaultOptions(port, { now: () => 100 });
    const session = new ResultArtifactUploadSession({
      ...base,
      lease: { ...base.lease, leaseToken: uppercaseToken },
    });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "FAILURE_SECRET_REFLECTION",
        attempts: 1,
      },
    });
    expect(JSON.stringify(session.state)).not.toContain(uppercaseToken);
  });

  it("fails closed as ambiguous after the exact retry budget is exhausted", async () => {
    const { api, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 2,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    api.createImplementation = async () => {
      throw new Error(`unknown transport failure ${token}`);
    };

    const outcome = session.accept(startEvent());
    await expect(outcome).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "OUTCOME_UNKNOWN",
        attempts: 2,
      },
    });
    expect(session.state).toMatchObject({
      phase: "closed",
      closure: "upload_failed",
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "OUTCOME_UNKNOWN",
        attempts: 2,
      },
    });
    await outcome.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(token);
    });
    expect(api.terminateCalls).toEqual([]);
  });

  it("never retries explicit lease revocation", async () => {
    const { api, delays, session } = createHarness();
    api.createImplementation = async () => {
      throw new ResultArtifactUploadApiError("lease_revoked", "LEASE_LOST", false);
    };

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: { kind: "lease_revoked", code: "LEASE_LOST", attempts: 1 },
    });
    expect(api.createCalls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("does not begin a request after the lease deadline", async () => {
    const { api, session } = createHarness({ leaseDeadlineMonotonicMilliseconds: 100 });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      code: "DEADLINE_EXPIRED",
      failure: {
        kind: "lease_revoked",
        operation: "create",
        code: "DEADLINE_EXPIRED",
        attempts: 0,
      },
    });
    expect(api.createCalls).toEqual([]);
  });

  it("does not begin a request after the hard deadline", async () => {
    const { api, session } = createHarness({ hardDeadlineMonotonicMilliseconds: 100 });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      code: "DEADLINE_EXPIRED",
      failure: { kind: "lease_revoked", operation: "create", attempts: 0 },
    });
    expect(api.createCalls).toEqual([]);
  });

  it("does not apply a response observed after the authority deadline", async () => {
    const { api, clock, session } = createHarness({
      leaseDeadlineMonotonicMilliseconds: 101,
    });
    api.createImplementation = async () => {
      clock.now = 101;
      return createResponse();
    };

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "AUTHORITY_EXPIRED_AFTER_DISPATCH",
        attempts: 1,
      },
    });
    expect(session.state.uploadId).toBeNull();
  });

  it("does not apply a response after reentrant shutdown fences dispatch", async () => {
    const { api, session } = createHarness();
    let shutdown: Promise<unknown> | undefined;
    api.createImplementation = async () => {
      shutdown = session.shutdown(1_000);
      return createResponse();
    };

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "create",
        code: "SHUTDOWN_INTERRUPTED",
        attempts: 1,
      },
    });
    await expect(required(shutdown)).resolves.toMatchObject({ phase: "closed" });
    expect(session.state.uploadId).toBeNull();
  });

  it("does not sleep beyond the remaining authority budget", async () => {
    const { api, delays, session } = createHarness({
      leaseDeadlineMonotonicMilliseconds: 105,
      retryPolicy: {
        maximumAttempts: 3,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
    });
    api.createImplementation = async () => {
      throw new ResultArtifactUploadApiError("definitive", "SERVER_BUSY", true);
    };

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: { kind: "definitive", code: "SERVER_BUSY", attempts: 1 },
    });
    expect(api.createCalls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("yields a definitive retry backoff so shutdown can terminate the known upload", async () => {
    const waitStarted = new Deferred<void>();
    const releaseWait = new Deferred<void>();
    let waitSignal: AbortSignal | undefined;
    const { api, session } = createHarness({
      retryPolicy: {
        maximumAttempts: 3,
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
      },
      wait: async (_delayMilliseconds, signal) => {
        waitSignal = signal;
        waitStarted.resolve();
        await releaseWait.promise;
      },
    });
    await session.accept(startEvent());
    api.putImplementation = async () => {
      throw new ResultArtifactUploadApiError("definitive", "SERVER_BUSY", true);
    };

    const put = session.accept(chunkEvent());
    await waitStarted.promise;
    const shutdown = session.shutdown(1_000);
    await expect(put).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await expect(shutdown).resolves.toMatchObject({
      phase: "closed",
      closure: "shutdown",
      failure: null,
    });
    expect(required(waitSignal).aborted).toBe(true);
    expect(api.putCalls).toHaveLength(1);
    expect(api.terminateCalls).toHaveLength(1);
    releaseWait.resolve();
    await flushDispatch();
  });

  it("fails closed if the injected monotonic clock moves backwards", async () => {
    const { api, clock, session } = createHarness();
    clock.now = 99;

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "definitive",
        operation: "create",
        code: "MONOTONIC_CLOCK_INVALID",
        attempts: 0,
      },
    });
    expect(api.createCalls).toEqual([]);
  });

  it("terminates a receiving upload within the shutdown authority", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());

    await expect(session.shutdown(1_000)).resolves.toMatchObject({
      phase: "closed",
      closure: "shutdown",
      failure: null,
    });
    expect(api.terminateCalls).toHaveLength(1);
    expect(required(api.terminateCalls[0]).request).toMatchObject({
      leaseToken: token,
      state: "abandoned",
      reason: "client_abandoned",
    });
  });

  it("does not interrupt termination for an idempotent shutdown replay", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    const termination = new Deferred<TerminateResultArtifactUploadResponse>();
    api.terminateImplementation = async () => await termination.promise;

    const first = session.shutdown(1_000);
    await flushDispatch();
    const signal = required(api.terminateCalls[0]).signal;
    const second = session.shutdown(1_000);
    expect(signal.aborted).toBe(false);
    termination.resolve(terminateResponse());

    await expect(first).resolves.toMatchObject({ phase: "closed", closure: "shutdown" });
    await expect(second).resolves.toMatchObject({ phase: "closed", closure: "shutdown" });
    expect(api.terminateCalls).toHaveLength(1);
    expect(signal.aborted).toBe(false);
  });

  it("does not start termination after the shutdown deadline", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());

    await expect(session.shutdown(100)).rejects.toMatchObject({
      code: "DEADLINE_EXPIRED",
      failure: { kind: "lease_revoked", operation: "terminate", attempts: 0 },
    });
    expect(api.terminateCalls).toEqual([]);
  });

  it("interrupts an in-flight mutation on shutdown and preserves ambiguity", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    api.putImplementation = async () => await new Promise<ResultArtifactChunkResponse>(() => {});

    const put = session.accept(chunkEvent());
    await Promise.resolve();
    await Promise.resolve();
    const shutdown = session.shutdown(1_000);

    await expect(put).rejects.toMatchObject({
      failure: {
        kind: "ambiguous",
        operation: "put",
        code: "SHUTDOWN_INTERRUPTED",
        attempts: 1,
      },
    });
    await expect(shutdown).resolves.toMatchObject({
      phase: "closed",
      closure: "upload_failed",
      failure: { kind: "ambiguous", operation: "put" },
    });
    expect(required(api.putCalls[0]).signal.aborted).toBe(true);
    expect(api.terminateCalls).toEqual([]);
  });

  it("does not let a create that ignores abort publish a late upload identity", async () => {
    const { api, session } = createHarness();
    const late = new Deferred<CreateResultArtifactUploadResponse>();
    api.createImplementation = async () => await late.promise;

    const create = session.accept(startEvent());
    await flushDispatch();
    const shutdown = session.shutdown(1_000);
    await expect(create).rejects.toMatchObject({
      failure: { kind: "ambiguous", operation: "create", code: "SHUTDOWN_INTERRUPTED" },
    });
    await expect(shutdown).resolves.toMatchObject({ phase: "closed" });
    late.resolve(createResponse());
    await flushDispatch();

    expect(session.state).toMatchObject({
      phase: "closed",
      uploadId: null,
      clientArtifactId: null,
      nextChunkIndex: 0,
    });
  });

  it("does not let a put that ignores abort advance the late cursor", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    const late = new Deferred<ResultArtifactChunkResponse>();
    api.putImplementation = async () => await late.promise;

    const put = session.accept(chunkEvent());
    await flushDispatch();
    const shutdown = session.shutdown(1_000);
    await expect(put).rejects.toMatchObject({
      failure: { kind: "ambiguous", operation: "put", code: "SHUTDOWN_INTERRUPTED" },
    });
    await expect(shutdown).resolves.toMatchObject({ phase: "closed" });
    late.resolve(chunkResponse());
    await flushDispatch();

    expect(session.state).toMatchObject({
      phase: "closed",
      nextChunkIndex: 0,
      nextOffsetBytes: 0,
      committedArtifact: null,
    });
  });

  it("does not let a finalize that ignores abort publish a late committed artifact", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    await session.accept(chunkEvent());
    const late = new Deferred<FinalizeResultArtifactUploadResponse>();
    api.finalizeImplementation = async () => await late.promise;

    const finalize = session.accept(endEvent());
    await flushDispatch();
    const shutdown = session.shutdown(1_000);
    await expect(finalize).rejects.toMatchObject({
      failure: { kind: "ambiguous", operation: "finalize", code: "SHUTDOWN_INTERRUPTED" },
    });
    await expect(shutdown).resolves.toMatchObject({ phase: "closed" });
    late.resolve(finalizeResponse());
    await flushDispatch();

    expect(session.state).toMatchObject({ phase: "closed", committedArtifact: null });
  });

  it("absorbs a late terminate rejection after its shutdown authority is shortened", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    const late = new Deferred<TerminateResultArtifactUploadResponse>();
    api.terminateImplementation = async () => await late.promise;

    const firstShutdown = session.shutdown(1_000);
    await flushDispatch();
    const secondShutdown = session.shutdown(900);
    await expect(firstShutdown).rejects.toMatchObject({
      failure: { kind: "ambiguous", operation: "terminate", code: "SHUTDOWN_INTERRUPTED" },
    });
    await expect(secondShutdown).resolves.toMatchObject({
      phase: "closed",
      closure: "upload_failed",
    });
    late.reject(new Error(`late ignored-abort rejection ${token}`));
    await flushDispatch();

    expect(session.state).toMatchObject({
      phase: "closed",
      failure: { kind: "ambiguous", operation: "terminate" },
    });
  });

  it("captures the API method set before an external method replacement", async () => {
    const { api, port, session } = createHarness();
    port.create = async () => {
      throw new Error("replacement must remain unreachable");
    };

    await expect(session.accept(startEvent())).resolves.toMatchObject({ phase: "receiving" });
    expect(api.createCalls).toHaveLength(1);
  });

  it("rejects accessor-based dependency and API injection without invoking getters", () => {
    const api = new FakeResultArtifactUploadApi();
    const port = boundPort(api);
    let dependencyReads = 0;
    const options = defaultOptions(port, { now: () => 100 });
    Object.defineProperty(options, "dependencies", {
      enumerable: true,
      get: () => {
        dependencyReads += 1;
        return { now: () => 100 };
      },
    });
    expect(() => new ResultArtifactUploadSession(options)).toThrow(/input shape/u);
    expect(dependencyReads).toBe(0);

    let methodReads = 0;
    const hostileApi = boundPort(api);
    Object.defineProperty(hostileApi, "create", {
      enumerable: true,
      get: () => {
        methodReads += 1;
        return api.create.bind(api);
      },
    });
    expect(
      () =>
        new ResultArtifactUploadSession(
          defaultOptions(hostileApi, {
            now: () => 100,
          }),
        ),
    ).toThrow(/input shape/u);
    expect(methodReads).toBe(0);
  });

  it("rejects unsupported result inputs before exposing lease authority", async () => {
    const wrongContext = startEvent();
    wrongContext.message = { ...wrongContext.message, workerNodeId: "worker:other" };
    const first = createHarness();
    await expect(first.session.accept(wrongContext)).rejects.toMatchObject({
      code: "EVENT_INVALID",
    });
    expect(first.session.state.phase).toBe("created");
    expect(first.api.createCalls).toEqual([]);

    const logArtifact = startEvent();
    logArtifact.message = { ...logArtifact.message, purpose: "log" };
    const second = createHarness();
    await expect(second.session.accept(logArtifact)).rejects.toMatchObject({
      code: "EVENT_INVALID",
    });
    expect(second.session.state).toMatchObject({
      phase: "closed",
      closure: "upload_failed",
    });
    expect(second.api.createCalls).toEqual([]);
  });

  it("fails closed on non-contiguous or changed chunk bytes", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    const changed = chunkEvent();
    changed.message = {
      ...changed.message,
      chunkIndex: 1,
    };

    await expect(session.accept(changed)).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
    expect(session.state.phase).toBe("closed");
    expect(api.putCalls).toEqual([]);
  });

  it("fails closed when ArtifactEnd does not bind the uploaded prefix", async () => {
    const { api, session } = createHarness();
    await session.accept(startEvent());
    await session.accept(chunkEvent());
    const changed = endEvent();
    changed.message = { ...changed.message, chunkCount: 2 };

    await expect(session.accept(changed)).rejects.toMatchObject({ code: "EVENT_CONFLICT" });
    expect(session.state.phase).toBe("closed");
    expect(api.finalizeCalls).toEqual([]);
  });

  it("requires committed upload evidence before accepting Complete", async () => {
    const { api, session } = createHarness();

    await expect(session.accept(completeEvent())).rejects.toMatchObject({
      code: "TRANSITION_INVALID",
    });
    expect(session.state.phase).toBe("closed");
    expect(api.createCalls).toEqual([]);
  });

  it("rejects a durable cursor that this in-memory session cannot prove", async () => {
    const { api, session } = createHarness();
    api.createImplementation = async () => ({
      uploadId,
      maximumChunkBytes: 256 * 1024,
      maximumChunkCount: 8,
      state: "receiving",
      replayed: true,
      nextChunkIndex: 1,
      nextOffsetBytes: content.byteLength,
    });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "definitive",
        operation: "create",
        code: "UPLOAD_RECOVERY_UNSUPPORTED",
        attempts: 1,
      },
    });
    expect(session.state.phase).toBe("closed");
    expect(api.createCalls).toHaveLength(1);
  });

  it("rejects consumed client artifact identities without resurrection", async () => {
    const { api, session } = createHarness();
    api.createImplementation = async () => ({
      uploadId,
      maximumChunkBytes: 256 * 1024,
      maximumChunkCount: 8,
      replayed: true,
      nextChunkIndex: 0,
      nextOffsetBytes: 0,
      state: "abandoned",
      reason: "client_abandoned",
      terminatedAt: "2026-09-02T00:00:00.000Z",
    });

    await expect(session.accept(startEvent())).rejects.toMatchObject({
      failure: {
        kind: "definitive",
        code: "UPLOAD_IDENTITY_CONSUMED",
        attempts: 1,
      },
    });
    expect(api.createCalls).toHaveLength(1);
  });
});

function startEvent(): MutableUploadEvent<"ArtifactStart", ArtifactStartMessage> {
  return {
    type: "ArtifactStart",
    message: {
      ...context,
      artifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: String(content.byteLength),
      sha256: contentSha256,
    },
  };
}

function chunkEvent(): MutableUploadEvent<"ArtifactChunk", ArtifactChunkMessage> {
  return {
    type: "ArtifactChunk",
    message: {
      ...context,
      artifactId,
      chunkIndex: 0,
      offsetBytes: "0",
      chunkBytes: content.byteLength,
      chunkSha256: contentSha256,
      data: chunkData,
    },
  };
}

function endEvent(): MutableUploadEvent<"ArtifactEnd", ArtifactEndMessage> {
  return {
    type: "ArtifactEnd",
    message: {
      ...context,
      artifactId,
      chunkCount: 1,
      totalBytes: String(content.byteLength),
      sha256: contentSha256,
    },
  };
}

function completeEvent(): MutableUploadEvent<"Complete", CompleteMessage> {
  return {
    type: "Complete",
    message: {
      ...context,
      resultArtifactId: artifactId,
      resultBytes: String(content.byteLength),
      resultSha256: contentSha256,
      outputSchemaSha256: "a".repeat(64),
      completedAtUnixMs: 1_800_000_000_000,
    },
  };
}

function failedEvent(): MutableUploadEvent<"Failed", FailedMessage> {
  return {
    type: "Failed",
    message: {
      ...context,
      code: "CODEX_FAILED",
      message: "Codex failed.",
      retryable: true,
      failedAtUnixMs: 1_800_000_000_000,
    },
  };
}

function createResponse(replayed = false): CreateResultArtifactUploadResponse {
  return replayed
    ? {
        uploadId,
        maximumChunkBytes: 256 * 1024,
        maximumChunkCount: 8,
        nextChunkIndex: 0,
        nextOffsetBytes: 0,
        state: "receiving",
        replayed: true,
      }
    : {
        uploadId,
        maximumChunkBytes: 256 * 1024,
        maximumChunkCount: 8,
        nextChunkIndex: 0,
        nextOffsetBytes: 0,
        state: "receiving",
        replayed: false,
      };
}

function chunkResponse(): ResultArtifactChunkResponse {
  return {
    uploadId,
    chunkIndex: 0,
    nextChunkIndex: 1,
    nextOffsetBytes: content.byteLength,
    state: "receiving",
    outcome: "accepted",
  };
}

function committedArtifact(overrides: Partial<CommittedRunArtifact> = {}): CommittedRunArtifact {
  return {
    artifactId: serverArtifactId,
    uploadId,
    clientArtifactId: artifactId,
    jobId: "job:1",
    runAttemptId: context.runAttemptId,
    purpose: "result",
    name: "result.json",
    mediaType: "application/json",
    totalBytes: content.byteLength,
    sha256: contentSha256,
    ...overrides,
  };
}

function finalizeResponse(
  artifactOverrides: Partial<CommittedRunArtifact> = {},
): FinalizeResultArtifactUploadResponse {
  return {
    state: "committed",
    replayed: false,
    artifact: committedArtifact(artifactOverrides),
  };
}

function terminateResponse(): TerminateResultArtifactUploadResponse {
  return {
    uploadId,
    state: "abandoned",
    reason: "client_abandoned",
    terminatedAt: "2026-09-02T00:00:00.000Z",
    replayed: false,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected recorded upload API call.");
  return value;
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  public resolve!: (value: T) => void;
  public reject!: (error: unknown) => void;

  public constructor() {
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      this.resolve = resolvePromise;
      this.reject = rejectPromise;
    });
  }
}

async function flushDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
