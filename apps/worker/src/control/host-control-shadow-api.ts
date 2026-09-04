import {
  type WorkerHeartbeatRequest,
  WorkerHeartbeatRequestSchema,
  type WorkerHeartbeatResponse,
  WorkerHeartbeatResponseSchema,
  type WorkerRegistrationRequest,
  WorkerRegistrationRequestSchema,
  type WorkerRegistrationResponse,
  WorkerRegistrationResponseSchema,
} from "@agentic-review/contracts";
import type { ControlHostControlClient } from "../service-host/host-control-client.js";
import { HOST_CONTROL_MAXIMUM_BODY_BYTES } from "../service-host/host-control-protocol.js";
import {
  assertHostControlRouteIdentity,
  callHostControlOperation,
  encodeHostControlRequest,
  validateHostControlResponse,
} from "./host-control-api-common.js";

type ControlShadowRpcClient = Pick<ControlHostControlClient, "instanceHeartbeat" | "register">;

/** Exposes only the HostControl operations needed by a zero-slot shadow. */
export class HostControlShadowApi {
  readonly #register: ControlShadowRpcClient["register"];
  readonly #instanceHeartbeat: ControlShadowRpcClient["instanceHeartbeat"];

  public constructor(client: ControlShadowRpcClient) {
    this.#register = client.register.bind(client);
    this.#instanceHeartbeat = client.instanceHeartbeat.bind(client);
  }

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
      this.#register(body, signal === undefined ? {} : { signal }),
    );
    return validateHostControlResponse(
      WorkerRegistrationResponseSchema,
      response,
      "registration response",
    );
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
      this.#instanceHeartbeat(workerInstanceId, body, signal === undefined ? {} : { signal }),
    );
    return validateHostControlResponse(
      WorkerHeartbeatResponseSchema,
      response,
      "heartbeat response",
    );
  }
}
