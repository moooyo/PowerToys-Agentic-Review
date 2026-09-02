import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { ProtocolError, WorkerApiError } from "../server-client/errors.js";
import { HostControlClientError } from "../service-host/host-control-client.js";
import { HostControlRemoteError } from "../service-host/host-control-protocol.js";
import {
  encodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "../service-host/opaque-json.js";

export interface LocalAuthorityDigestSigner {
  signLocalDigest(digestSha256: string, signal?: AbortSignal): Promise<string>;
}

registerWorkerContractFormats();

export async function callHostControlOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapHostControlError(error);
  }
}

export function encodeHostControlRequest(
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

export function validateHostControlResponse<T>(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
  description: string,
): T {
  if (!Value.Check(schema, value)) {
    throw new ProtocolError(`ServiceHost returned an invalid ${description}.`);
  }
  return value as T;
}

export function assertHostControlRouteIdentity(
  routeValue: string,
  bodyValue: string,
  message: string,
): void {
  if (routeValue !== bodyValue) throw new ProtocolError(message);
}

export function mapHostControlError(error: unknown): Error {
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

function mapRemoteError(error: HostControlRemoteError): WorkerApiError {
  const statusCode = remoteStatusCode(error);
  return new WorkerApiError(
    "Worker API HostControl operation failed.",
    statusCode,
    error.code.toLowerCase(),
    {
      retryable: error.retryable,
    },
  );
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
