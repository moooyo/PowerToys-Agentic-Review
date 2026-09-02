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
import { ProtocolError } from "../server-client/errors.js";
import type { WorkerApi } from "../server-client/worker-api.js";
import type { ControlHostControlClient } from "../service-host/host-control-client.js";
import {
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
} from "../service-host/host-control-protocol.js";
import {
  assertHostControlRouteIdentity,
  callHostControlOperation,
  encodeHostControlRequest,
  type LocalAuthorityDigestSigner,
  validateHostControlResponse,
} from "./host-control-api-common.js";

export type { LocalAuthorityDigestSigner } from "./host-control-api-common.js";

/** Maps the fixed Control HostControl RPC surface to the existing Worker control-plane API. */
export class HostControlWorkerApi implements WorkerApi, LocalAuthorityDigestSigner {
  public constructor(private readonly client: ControlHostControlClient) {}

  public async register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    const body = encodeHostControlRequest(
      WorkerRegistrationRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "registration request",
    );
    const response = await callHostControlOperation(() =>
      this.client.register(body, signal === undefined ? {} : { signal }),
    );
    return validateHostControlResponse(
      WorkerRegistrationResponseSchema,
      response,
      "registration response",
    );
  }

  public async claimLease(
    request: ClaimLeaseRequest,
    signal?: AbortSignal,
  ): Promise<ClaimLeaseResponse> {
    const body = encodeHostControlRequest(
      ClaimLeaseRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "claim request",
    );
    const response = await callHostControlOperation(() =>
      this.client.claim(body, signal === undefined ? {} : { signal }),
    );
    return validateHostControlResponse(ClaimLeaseResponseSchema, response, "claim response");
  }

  public async heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse> {
    const body = encodeHostControlRequest(
      WorkerHeartbeatRequestSchema,
      request,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "heartbeat request",
    );
    assertHostControlRouteIdentity(
      workerInstanceId,
      request.workerInstanceId,
      "Heartbeat route and body worker instance identities do not match.",
    );
    const response = await callHostControlOperation(() =>
      this.client.instanceHeartbeat(workerInstanceId, body, signal === undefined ? {} : { signal }),
    );
    return validateHostControlResponse(
      WorkerHeartbeatResponseSchema,
      response,
      "heartbeat response",
    );
  }

  public async completeRun(
    runAttemptId: string,
    submission: RunCompletionSubmission,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    const body = encodeHostControlRequest(
      RunCompletionSubmissionSchema,
      submission,
      HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
      "completion request",
    );
    assertHostControlRouteIdentity(
      runAttemptId,
      submission.runAttemptId,
      "Completion route and body attempt identities do not match.",
    );
    const response = await callHostControlOperation(() =>
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
    const body = encodeHostControlRequest(
      RunFailureSubmissionSchema,
      submission,
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
      "failure request",
    );
    assertHostControlRouteIdentity(
      runAttemptId,
      submission.runAttemptId,
      "Failure route and body attempt identities do not match.",
    );
    const response = await callHostControlOperation(() =>
      this.client.failRun(runAttemptId, body, signal === undefined ? {} : { signal }),
    );
    return validateTerminalResponse(response, submission.jobId, runAttemptId, "failure response");
  }

  public async signLocalDigest(digestSha256: string, signal?: AbortSignal): Promise<string> {
    return await callHostControlOperation(() =>
      this.client.signLocalDigest(digestSha256, signal === undefined ? {} : { signal }),
    );
  }
}

function validateTerminalResponse(
  value: unknown,
  expectedJobId: string,
  expectedRunAttemptId: string,
  description: string,
): RunTerminalResponse {
  const response = validateHostControlResponse<RunTerminalResponse>(
    RunTerminalResponseSchema,
    value,
    description,
  );
  if (response.jobId !== expectedJobId || response.runAttemptId !== expectedRunAttemptId) {
    throw new ProtocolError("ServiceHost returned a terminal response for another run.");
  }
  return response;
}
