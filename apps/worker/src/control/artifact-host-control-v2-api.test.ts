import type {
  ArtifactRunCompletionSubmission,
  CreateResultArtifactUploadRequest,
  FinalizeResultArtifactUploadRequest,
  ResultArtifactChunkRequest,
  TerminateResultArtifactUploadRequest,
} from "@agentic-review/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ArtifactHostControlV2RemoteError } from "../service-host/artifact-host-control-v2-protocol.js";
import {
  decodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "../service-host/opaque-json.js";
import {
  ArtifactHostControlV2Api,
  ArtifactHostControlV2ApiError,
  type ArtifactHostControlV2Port,
} from "./artifact-host-control-v2-api.js";

const token = "a".repeat(32);
const uploadId = "20000000-0000-4000-8000-000000000002";
const clientArtifactId = "30000000-0000-4000-8000-000000000003";
const artifactId = "artifact:server";
const digest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

interface RecordedCall {
  readonly operation: keyof ArtifactHostControlV2Port;
  readonly routeId: string;
  readonly chunkIndex?: number;
  readonly body: Readonly<HostControlOpaqueJsonDescriptor>;
  readonly signal?: AbortSignal;
}

class FakePortOwner {
  public readonly calls: RecordedCall[] = [];
  public createResponse: unknown = createResponse();
  public chunkResponse: unknown = chunkResponse();
  public finalizeResponse: unknown = finalizeResponse();
  public terminateResponse: unknown = terminateResponse();
  public completeResponse: unknown = terminalResponse();
  public failure: Error | undefined;

  public async createArtifactUpload(
    routeId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.record("createArtifactUpload", routeId, body, options.signal);
    return this.createResponse;
  }

  public async putArtifactChunk(
    routeId: string,
    chunkIndex: number,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.record("putArtifactChunk", routeId, body, options.signal, chunkIndex);
    return this.chunkResponse;
  }

  public async finalizeArtifactUpload(
    routeId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.record("finalizeArtifactUpload", routeId, body, options.signal);
    return this.finalizeResponse;
  }

  public async terminateArtifactUpload(
    routeId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.record("terminateArtifactUpload", routeId, body, options.signal);
    return this.terminateResponse;
  }

  public async completeArtifactRun(
    routeId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.record("completeArtifactRun", routeId, body, options.signal);
    return this.completeResponse;
  }

  private record(
    operation: keyof ArtifactHostControlV2Port,
    routeId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    signal?: AbortSignal,
    chunkIndex?: number,
  ): void {
    if (this.failure !== undefined) throw this.failure;
    this.calls.push({
      operation,
      routeId,
      body,
      ...(signal === undefined ? {} : { signal }),
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
    });
  }
}

function createApi(): { readonly api: ArtifactHostControlV2Api; readonly owner: FakePortOwner } {
  const owner = new FakePortOwner();
  const port: ArtifactHostControlV2Port = {
    createArtifactUpload: owner.createArtifactUpload.bind(owner),
    putArtifactChunk: owner.putArtifactChunk.bind(owner),
    finalizeArtifactUpload: owner.finalizeArtifactUpload.bind(owner),
    terminateArtifactUpload: owner.terminateArtifactUpload.bind(owner),
    completeArtifactRun: owner.completeArtifactRun.bind(owner),
  };
  return { api: new ArtifactHostControlV2Api(port), owner };
}

describe("dormant Artifact HostControl v2 API", () => {
  it("exposes only the five reviewed API and port operations", () => {
    expectTypeOf<keyof ArtifactHostControlV2Port>().toEqualTypeOf<
      | "createArtifactUpload"
      | "putArtifactChunk"
      | "finalizeArtifactUpload"
      | "terminateArtifactUpload"
      | "completeArtifactRun"
    >();
    expect(Object.getOwnPropertyNames(ArtifactHostControlV2Api.prototype)).toEqual([
      "constructor",
      "create",
      "put",
      "finalize",
      "terminate",
      "completeArtifactRun",
    ]);
  });

  it("maps all five operations without exposing route construction authority", async () => {
    const { api, owner } = createApi();
    const cancellation = new AbortController();

    await expect(api.create("run:1", createRequest(), cancellation.signal)).resolves.toEqual(
      createResponse(),
    );
    await expect(api.put(uploadId, 0, chunkRequest(), cancellation.signal)).resolves.toEqual(
      chunkResponse(),
    );
    await expect(api.finalize(uploadId, finalizeRequest(), cancellation.signal)).resolves.toEqual(
      finalizeResponse(),
    );
    await expect(api.terminate(uploadId, terminateRequest(), cancellation.signal)).resolves.toEqual(
      terminateResponse(),
    );
    await expect(
      api.completeArtifactRun("run:1", artifactCompletion(), cancellation.signal),
    ).resolves.toEqual(terminalResponse());

    expect(owner.calls.map(({ operation }) => operation)).toEqual([
      "createArtifactUpload",
      "putArtifactChunk",
      "finalizeArtifactUpload",
      "terminateArtifactUpload",
      "completeArtifactRun",
    ]);
    for (const call of owner.calls) {
      expect(call.signal).toBe(cancellation.signal);
      expect(JSON.stringify(call)).not.toContain(token);
      for (const forbidden of ["url", "method", "header", "origin", "certificatePath"]) {
        expect(call).not.toHaveProperty(forbidden);
      }
    }
    expect(decodeHostControlOpaqueJson(required(owner.calls[0]).body, 16_384)).toEqual(
      createRequest(),
    );
    expect(decodeHostControlOpaqueJson(required(owner.calls[1]).body, 365_910)).toEqual(
      chunkRequest(),
    );
  });

  it("rejects route and body identities before calling the port", async () => {
    const { api, owner } = createApi();
    await expect(api.create("run:other", createRequest())).rejects.toMatchObject({
      kind: "definitive",
      code: "run_attempt_mismatch",
      retryable: false,
    });
    await expect(api.put(uploadId, 1, chunkRequest())).rejects.toMatchObject({
      kind: "definitive",
      code: "artifact_chunk_index_mismatch",
      retryable: false,
    });
    await expect(api.completeArtifactRun("run:other", artifactCompletion())).rejects.toMatchObject({
      code: "run_attempt_mismatch",
    });
    expect(owner.calls).toEqual([]);
  });

  it("accepts only the artifact completion form", async () => {
    const { api, owner } = createApi();
    await expect(
      api.completeArtifactRun("run:1", {
        ...artifactCompletion(),
        result: { forbidden: true },
      } as never),
    ).rejects.toMatchObject({ kind: "definitive", code: "artifact_request_invalid" });
    expect(owner.calls).toEqual([]);
  });

  it("treats response schema or identity drift as ambiguous exact-replay territory", async () => {
    const { api, owner } = createApi();
    owner.chunkResponse = { ...chunkResponse(), uploadId: "upload:other" };
    await expect(api.put(uploadId, 0, chunkRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_response_invalid",
      retryable: true,
    });

    const second = createApi();
    second.owner.finalizeResponse = {
      ...finalizeResponse(),
      artifact: { ...finalizeResponse().artifact, jobId: "job:other" },
    };
    await expect(second.api.finalize(uploadId, finalizeRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_response_invalid",
    });
  });

  it("preserves explicit remote code and retryable without status inference", async () => {
    const cases = [
      ["lease_lost", false, "lease_revoked"],
      ["artifact_outcome_unknown", true, "ambiguous"],
      ["artifact_storage_integrity", false, "definitive"],
      ["artifact_storage_capacity", true, "definitive"],
    ] as const;
    for (const [code, retryable, kind] of cases) {
      const { api, owner } = createApi();
      owner.failure = new ArtifactHostControlV2RemoteError(code, retryable);
      await expect(api.create("run:1", createRequest())).rejects.toMatchObject({
        code,
        retryable,
        kind,
      });
    }
  });

  it("freezes validated error classifications and rejects fabricated remote errors", async () => {
    const remote = new ArtifactHostControlV2RemoteError("artifact_storage_capacity", true);
    expect(Object.isFrozen(remote)).toBe(true);
    expect(Object.isFrozen(ArtifactHostControlV2RemoteError.prototype)).toBe(true);
    expect(Reflect.set(remote, "code", "lease_lost")).toBe(false);
    expect(() => new ArtifactHostControlV2RemoteError("INVALID", false)).toThrow(TypeError);
    expect(() => new ArtifactHostControlV2RemoteError("valid_code", "yes" as never)).toThrow(
      TypeError,
    );

    const apiError = new ArtifactHostControlV2ApiError(
      "ambiguous",
      "artifact_outcome_unknown",
      true,
    );
    expect(Object.isFrozen(apiError)).toBe(true);
    expect(Object.isFrozen(ArtifactHostControlV2ApiError.prototype)).toBe(true);
    expect(Reflect.set(apiError, "kind", "definitive")).toBe(false);
    expect(
      () => new ArtifactHostControlV2ApiError("invalid" as never, "valid_code", false),
    ).toThrow(TypeError);
    expect(() => new ArtifactHostControlV2ApiError("lease_revoked", "lease_lost", true)).toThrow(
      TypeError,
    );

    const { api, owner } = createApi();
    const fabricated = Object.create(ArtifactHostControlV2RemoteError.prototype) as Error;
    Object.defineProperties(fabricated, {
      code: { enumerable: true, value: "lease_lost" },
      retryable: { enumerable: true, value: false },
    });
    owner.failure = fabricated;
    await expect(api.create("run:1", createRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_outcome_unknown",
      retryable: true,
    });

    const proxyCase = createApi();
    proxyCase.owner.failure = new Proxy(remote, {});
    await expect(proxyCase.api.create("run:1", createRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_outcome_unknown",
      retryable: true,
    });

    expect(() =>
      Object.defineProperty(ArtifactHostControlV2RemoteError.prototype, "code", {
        get: () => "lease_lost",
      }),
    ).toThrow(TypeError);
  });

  it("sanitizes unknown transport failures as outcome unknown", async () => {
    const { api, owner } = createApi();
    owner.failure = new Error(`request ${token} https://attacker.invalid failed`);
    const operation = api.create("run:1", createRequest());
    await expect(operation).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_outcome_unknown",
      retryable: true,
      message: "Artifact HostControl v2 API operation failed.",
    });
    await operation.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain("attacker.invalid");
    });
  });

  it("never reflects the raw lease token through a response or remote error code", async () => {
    const responseCase = createApi();
    responseCase.owner.createResponse = { ...createResponse(), uploadId: token };
    await expect(responseCase.api.create("run:1", createRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_response_invalid",
    });

    const errorCase = createApi();
    errorCase.owner.failure = new ArtifactHostControlV2RemoteError(token, false);
    const operation = errorCase.api.create("run:1", createRequest());
    await expect(operation).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_error_code_invalid",
      retryable: false,
    });
    await operation.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain(token);
    });
  });

  it("rejects accessor ports and accessor responses without invoking getters", async () => {
    const owner = new FakePortOwner();
    const port = {
      createArtifactUpload: owner.createArtifactUpload.bind(owner),
      putArtifactChunk: owner.putArtifactChunk.bind(owner),
      finalizeArtifactUpload: owner.finalizeArtifactUpload.bind(owner),
      terminateArtifactUpload: owner.terminateArtifactUpload.bind(owner),
      completeArtifactRun: owner.completeArtifactRun.bind(owner),
    };
    let methodReads = 0;
    Object.defineProperty(port, "createArtifactUpload", {
      enumerable: true,
      get: () => {
        methodReads += 1;
        return owner.createArtifactUpload.bind(owner);
      },
    });
    expect(() => new ArtifactHostControlV2Api(port)).toThrow(/port surface/u);
    expect(methodReads).toBe(0);

    const requestCase = createApi();
    let requestReads = 0;
    const request = { ...createRequest() };
    Object.defineProperty(request, "leaseToken", {
      enumerable: true,
      get: () => {
        requestReads += 1;
        return token;
      },
    });
    await expect(requestCase.api.create("run:1", request)).rejects.toMatchObject({
      kind: "definitive",
      code: "artifact_request_invalid",
    });
    expect(requestReads).toBe(0);
    expect(requestCase.owner.calls).toEqual([]);

    const valid = createApi();
    let responseReads = 0;
    const response = { ...createResponse() };
    Object.defineProperty(response, "uploadId", {
      enumerable: true,
      get: () => {
        responseReads += 1;
        return token;
      },
    });
    valid.owner.createResponse = response;
    await expect(valid.api.create("run:1", createRequest())).rejects.toMatchObject({
      kind: "ambiguous",
      code: "artifact_response_invalid",
    });
    expect(responseReads).toBe(0);
  });
});

function lease() {
  return {
    jobId: "job:1",
    runAttemptId: "run:1",
    workerNodeId: "worker:node",
    workerInstanceId: "worker:instance",
    leaseToken: token,
    leaseGeneration: 7,
  };
}

function createRequest(): CreateResultArtifactUploadRequest {
  return {
    ...lease(),
    clientArtifactId,
    purpose: "result",
    name: "result.json",
    mediaType: "application/json",
    totalBytes: 2,
    sha256: digest,
  };
}

function chunkRequest(): ResultArtifactChunkRequest {
  return {
    ...lease(),
    chunkIndex: 0,
    offsetBytes: 0,
    chunkBytes: 2,
    chunkSha256: digest,
    data: "e30",
  };
}

function finalizeRequest(): FinalizeResultArtifactUploadRequest {
  return {
    ...lease(),
    chunkCount: 1,
    totalBytes: 2,
    sha256: digest,
  };
}

function terminateRequest(): TerminateResultArtifactUploadRequest {
  return {
    ...lease(),
    state: "abandoned",
    reason: "client_abandoned",
  };
}

function artifactCompletion(): ArtifactRunCompletionSubmission {
  return {
    ...lease(),
    artifactId,
    resultDigest: "b".repeat(64),
  };
}

function createResponse() {
  return {
    uploadId,
    maximumChunkBytes: 256 * 1024,
    maximumChunkCount: 8,
    state: "receiving" as const,
    replayed: false as const,
    nextChunkIndex: 0 as const,
    nextOffsetBytes: 0 as const,
  };
}

function chunkResponse() {
  return {
    uploadId,
    chunkIndex: 0,
    nextChunkIndex: 1,
    nextOffsetBytes: 2,
    state: "receiving" as const,
    outcome: "accepted" as const,
  };
}

function finalizeResponse() {
  return {
    state: "committed" as const,
    replayed: false,
    artifact: {
      artifactId,
      uploadId,
      clientArtifactId,
      jobId: "job:1",
      runAttemptId: "run:1",
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: 2,
      sha256: digest,
    },
  };
}

function terminateResponse() {
  return {
    uploadId,
    state: "abandoned" as const,
    reason: "client_abandoned" as const,
    terminatedAt: "2026-09-03T00:00:00.000Z",
    replayed: false,
  };
}

function terminalResponse() {
  return {
    jobId: "job:1",
    runAttemptId: "run:1",
    jobState: "succeeded" as const,
    runState: "succeeded" as const,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected recorded Artifact HostControl v2 call.");
  return value;
}
