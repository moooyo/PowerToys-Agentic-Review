import {
  type ClaimLeaseRequest,
  ClaimLeaseRequestSchema,
  type ClaimLeaseResponse,
  ClaimLeaseResponseSchema,
  type RunCompletionSubmission,
  RunCompletionSubmissionSchema,
  type RunFailureSubmission,
  RunFailureSubmissionSchema,
  type RunTerminalResponse,
  RunTerminalResponseSchema,
  type WorkerHeartbeatRequest,
  WorkerHeartbeatRequestSchema,
  type WorkerHeartbeatResponse,
  WorkerHeartbeatResponseSchema,
  type WorkerRegistrationRequest,
  WorkerRegistrationRequestSchema,
  type WorkerRegistrationResponse,
  WorkerRegistrationResponseSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { ProtocolError, WorkerApiError } from "../server-client/errors.js";
import type { WorkerApi } from "../server-client/worker-api.js";
import {
  type ControlHostControlClient,
  HostControlClientError,
} from "../service-host/host-control-client.js";
import {
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
  HostControlRemoteError,
} from "../service-host/host-control-protocol.js";
import {
  encodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "../service-host/opaque-json.js";

export interface LocalAuthorityDigestSigner {
  signLocalDigest(digestSha256: string, signal?: AbortSignal): Promise<string>;
}

registerWorkerContractFormats();

type ControlShadowRpcClient = Pick<
  ControlHostControlClient,
  "instanceHeartbeat" | "register" | "signLocalDigest"
>;

/** Exposes only the three HostControl operations needed by a zero-slot shadow. */
export class HostControlShadowApi implements LocalAuthorityDigestSigner {
  readonly #register: ControlShadowRpcClient["register"];
  readonly #instanceHeartbeat: ControlShadowRpcClient["instanceHeartbeat"];
  readonly #signLocalDigest: ControlShadowRpcClient["signLocalDigest"];

  public constructor(client: ControlShadowRpcClient) {
    this.#register = client.register.bind(client);
    this.#instanceHeartbeat = client.instanceHeartbeat.bind(client);
    this.#signLocalDigest = client.signLocalDigest.bind(client);
  }

  public async register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    const body = encodeRequest(
      WorkerRegistrationRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "registration request",
    );
    const response = await this.#call(() =>
      this.#register(body, signal === undefined ? {} : { signal }),
    );
    return validateResponse(WorkerRegistrationResponseSchema, response, "registration response");
  }

  public async heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse> {
    const body = encodeRequest(
      WorkerHeartbeatRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "heartbeat request",
    );
    assertRouteIdentity(
      workerInstanceId,
      request.workerInstanceId,
      "Heartbeat route and body worker instance identities do not match.",
    );
    const response = await this.#call(() =>
      this.#instanceHeartbeat(workerInstanceId, body, signal === undefined ? {} : { signal }),
    );
    return validateResponse(WorkerHeartbeatResponseSchema, response, "heartbeat response");
  }

  public async signLocalDigest(digestSha256: string, signal?: AbortSignal): Promise<string> {
    return await this.#call(() =>
      this.#signLocalDigest(digestSha256, signal === undefined ? {} : { signal }),
    );
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapHostControlError(error);
    }
  }
}

/** Maps the fixed Control HostControl RPC surface to the existing Worker control-plane API. */
export class HostControlWorkerApi implements WorkerApi, LocalAuthorityDigestSigner {
  public constructor(private readonly client: ControlHostControlClient) {}

  public async register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    const body = encodeRequest(
      WorkerRegistrationRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "registration request",
    );
    const response = await this.#call(() =>
      this.client.register(body, signal === undefined ? {} : { signal }),
    );
    return validateResponse(WorkerRegistrationResponseSchema, response, "registration response");
  }

  public async claimLease(
    request: ClaimLeaseRequest,
    signal?: AbortSignal,
  ): Promise<ClaimLeaseResponse> {
    const body = encodeRequest(
      ClaimLeaseRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "claim request",
    );
    const response = await this.#call(() =>
      this.client.claim(body, signal === undefined ? {} : { signal }),
    );
    return validateResponse(ClaimLeaseResponseSchema, response, "claim response");
  }

  public async heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse> {
    const body = encodeRequest(
      WorkerHeartbeatRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "heartbeat request",
    );
    assertRouteIdentity(
      workerInstanceId,
      request.workerInstanceId,
      "Heartbeat route and body worker instance identities do not match.",
    );
    const response = await this.#call(() =>
      this.client.instanceHeartbeat(workerInstanceId, body, signal === undefined ? {} : { signal }),
    );
    return validateResponse(WorkerHeartbeatResponseSchema, response, "heartbeat response");
  }

  public async completeRun(
    runAttemptId: string,
    submission: RunCompletionSubmission,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    const body = encodeRequest(
      RunCompletionSubmissionSchema,
      submission,
      HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
      "completion request",
    );
    assertRouteIdentity(
      runAttemptId,
      submission.runAttemptId,
      "Completion route and body attempt identities do not match.",
    );
    const response = await this.#call(() =>
      this.client.completeRun(runAttemptId, body, signal === undefined ? {} : { signal }),
    );
    return validateTerminalResponse(
      response,
      submission.jobId,
      runAttemptId,
      "completion response",
    );
  }

  public async failRun(
    runAttemptId: string,
    submission: RunFailureSubmission,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    const body = encodeRequest(
      RunFailureSubmissionSchema,
      submission,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "failure request",
    );
    assertRouteIdentity(
      runAttemptId,
      submission.runAttemptId,
      "Failure route and body attempt identities do not match.",
    );
    const response = await this.#call(() =>
      this.client.failRun(runAttemptId, body, signal === undefined ? {} : { signal }),
    );
    return validateTerminalResponse(response, submission.jobId, runAttemptId, "failure response");
  }

  public async signLocalDigest(digestSha256: string, signal?: AbortSignal): Promise<string> {
    return await this.#call(() =>
      this.client.signLocalDigest(digestSha256, signal === undefined ? {} : { signal }),
    );
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapHostControlError(error);
    }
  }
}

function mapHostControlError(error: unknown): Error {
  if (error instanceof HostControlRemoteError) return mapRemoteError(error);
  if (error instanceof HostControlClientError) {
    if (error.code === "REQUEST_TIMEOUT" || error.code === "REQUEST_CANCELLED") {
      return new WorkerApiError(error.message, 408, error.code.toLowerCase());
    }
    if (error.code === "CONCURRENCY_LIMIT" || error.code === "OUTPUT_QUEUE_LIMIT_EXCEEDED") {
      return new WorkerApiError(error.message, 429, error.code.toLowerCase());
    }
    return new ProtocolError("ServiceHost HostControl channel failed.");
  }
  return new ProtocolError("ServiceHost HostControl operation failed.");
}

function encodeRequest(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
  maximumBytes: number,
  description: string,
): HostControlOpaqueJsonDescriptor {
  if (!Value.Check(schema, value)) {
    throw new ProtocolError(`Worker API ${description} does not match its contract.`);
  }
  try {
    return encodeHostControlOpaqueJson(value, maximumBytes);
  } catch (error) {
    throw new ProtocolError(`Worker API ${description} is not valid bounded JSON.`, {
      cause: error,
    });
  }
}

function validateResponse<T>(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
  description: string,
): T {
  if (!Value.Check(schema, value)) {
    throw new ProtocolError(`ServiceHost returned an invalid ${description}.`);
  }
  return value as T;
}

function validateTerminalResponse(
  value: unknown,
  expectedJobId: string,
  expectedRunAttemptId: string,
  description: string,
): RunTerminalResponse {
  const response = validateResponse<RunTerminalResponse>(
    RunTerminalResponseSchema,
    value,
    description,
  );
  if (response.jobId !== expectedJobId || response.runAttemptId !== expectedRunAttemptId) {
    throw new ProtocolError("ServiceHost returned a terminal response for another run.");
  }
  return response;
}

function assertRouteIdentity(routeValue: string, bodyValue: string, message: string): void {
  if (routeValue !== bodyValue) throw new ProtocolError(message);
}

function mapRemoteError(error: HostControlRemoteError): WorkerApiError {
  const statusCode = remoteStatusCode(error);
  return new WorkerApiError(error.message, statusCode, error.code.toLowerCase());
}

function remoteStatusCode(error: HostControlRemoteError): number {
  if (error.code === "REQUEST_TIMEOUT" || error.code === "REQUEST_CANCELLED") return 408;
  if (error.code === "CONCURRENCY_LIMIT") return 429;
  if (error.code === "UPSTREAM_UNAVAILABLE") return 503;
  if (
    error.code === "LEASE_LOST" ||
    error.code === "PROTOCOL_VERSION_UNSUPPORTED" ||
    error.code === "TERMINAL_SUBMISSION_CONFLICT" ||
    error.code === "WORKER_INSTANCE_SUPERSEDED" ||
    error.code === "WORKER_UNAVAILABLE"
  ) {
    return 409;
  }
  return error.retryable ? 503 : 400;
}
