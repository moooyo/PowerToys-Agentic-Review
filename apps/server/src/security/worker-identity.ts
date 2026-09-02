import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";

export interface AuthenticatedWorkerIdentity {
  readonly workerNodeId: string;
  readonly certificateFingerprint: string | undefined;
  readonly authenticationMethod: "mtls" | "insecure-loopback";
}

type AuthenticatedWorkerTransport =
  | {
      readonly workerNodeId: string;
      readonly certificateFingerprint: string;
      readonly authenticationMethod: "mtls";
    }
  | {
      readonly workerNodeId: undefined;
      readonly certificateFingerprint: undefined;
      readonly authenticationMethod: "insecure-loopback";
    };

const authenticatedWorkerIdentities = new WeakMap<object, AuthenticatedWorkerIdentity>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOwnString = (value: Record<string, unknown>, key: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
};

const readClaimedWorkerNodeIds = (body: unknown): readonly string[] => {
  try {
    if (!isRecord(body)) {
      return [];
    }
    const workerNodeId = readOwnString(body, "workerNodeId");
    if (workerNodeId === undefined) {
      return [];
    }

    const claimedWorkerNodeIds = [workerNodeId];
    const activeLeases = Object.getOwnPropertyDescriptor(body, "activeLeases");
    if (
      activeLeases !== undefined &&
      "value" in activeLeases &&
      Array.isArray(activeLeases.value)
    ) {
      for (const activeLease of activeLeases.value) {
        if (isRecord(activeLease)) {
          const activeWorkerNodeId = readOwnString(activeLease, "workerNodeId");
          if (activeWorkerNodeId !== undefined) {
            claimedWorkerNodeIds.push(activeWorkerNodeId);
          }
        }
      }
    }
    return claimedWorkerNodeIds;
  } catch {
    return [];
  }
};

const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined) {
    return false;
  }
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  return (
    normalized === "::1" ||
    normalized.startsWith("::ffff:127.") ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
};

const sendAuthenticationFailure = (
  reply: FastifyReply,
  statusCode: 400 | 401 | 403,
  code: string,
  message: string,
): void => {
  void reply.code(statusCode).send({
    code,
    message,
    retryable: false,
  });
};

const fingerprintPeerCertificate = (socket: TLSSocket): string | undefined => {
  const certificate = socket.getPeerCertificate();
  if (!Buffer.isBuffer(certificate.raw) || certificate.raw.length === 0) {
    return undefined;
  }
  return createHash("sha256").update(certificate.raw).digest("hex").toUpperCase();
};

const authenticateWorkerTransport = (
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): AuthenticatedWorkerTransport | undefined => {
  if (config.allowInsecureWorkerAuth) {
    if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
      sendAuthenticationFailure(
        reply,
        403,
        "insecure_worker_auth_loopback_only",
        "Insecure Worker authentication is restricted to loopback clients.",
      );
      return undefined;
    }
    return Object.freeze({
      workerNodeId: undefined,
      certificateFingerprint: undefined,
      authenticationMethod: "insecure-loopback" as const,
    });
  }

  const socket = request.raw.socket;
  if (!(socket instanceof TLSSocket) || !socket.encrypted) {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_mtls_required",
      "A mutually authenticated TLS connection is required.",
    );
    return undefined;
  }
  if (!socket.authorized) {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_certificate_unauthorized",
      "The Worker client certificate was not authorized by the configured CA.",
    );
    return undefined;
  }

  let certificateFingerprint: string | undefined;
  try {
    certificateFingerprint = fingerprintPeerCertificate(socket);
  } catch {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_certificate_missing",
      "The TLS connection did not provide a usable Worker client certificate.",
    );
    return undefined;
  }
  if (certificateFingerprint === undefined) {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_certificate_missing",
      "The TLS connection did not provide a usable Worker client certificate.",
    );
    return undefined;
  }
  const workerNodeId = config.workerCertificateBindings[certificateFingerprint];
  if (workerNodeId === undefined) {
    sendAuthenticationFailure(
      reply,
      403,
      "worker_certificate_unmapped",
      "The Worker client certificate is not bound to a workerNodeId.",
    );
    return undefined;
  }
  return Object.freeze({
    workerNodeId,
    certificateFingerprint,
    authenticationMethod: "mtls" as const,
  });
};

const safelyAuthenticateWorkerTransport = (
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): AuthenticatedWorkerTransport | undefined => {
  try {
    return authenticateWorkerTransport(config, request, reply);
  } catch {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_transport_authentication_failed",
      "Worker transport authentication could not be completed.",
    );
    return undefined;
  }
};

const bindAuthenticatedWorkerIdentity = (
  request: FastifyRequest,
  reply: FastifyReply,
  transport: AuthenticatedWorkerTransport,
  claimedWorkerNodeIds: readonly string[],
): void => {
  const workerNodeId = transport.workerNodeId ?? claimedWorkerNodeIds[0];
  if (workerNodeId === undefined) {
    sendAuthenticationFailure(
      reply,
      400,
      "worker_identity_missing",
      "The request must claim a workerNodeId.",
    );
    return;
  }
  if (claimedWorkerNodeIds.some((claimedWorkerNodeId) => claimedWorkerNodeId !== workerNodeId)) {
    sendAuthenticationFailure(
      reply,
      403,
      "worker_identity_mismatch",
      "The claimed workerNodeId does not match the authenticated Worker identity.",
    );
    return;
  }
  authenticatedWorkerIdentities.set(
    request,
    Object.freeze({
      workerNodeId,
      certificateFingerprint: transport.certificateFingerprint,
      authenticationMethod: transport.authenticationMethod,
    }),
  );
};

export const createWorkerAuthenticationPreHandler =
  (config: ServerConfig): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
  async (request, reply) => {
    const claimedWorkerNodeIds = readClaimedWorkerNodeIds(request.body);
    if (claimedWorkerNodeIds.length === 0) {
      sendAuthenticationFailure(
        reply,
        400,
        "worker_identity_missing",
        "The request must claim a workerNodeId.",
      );
      return;
    }
    const transport = safelyAuthenticateWorkerTransport(config, request, reply);
    if (transport !== undefined) {
      bindAuthenticatedWorkerIdentity(request, reply, transport, claimedWorkerNodeIds);
    }
  };

export const createWorkerAuthenticationHooks = (
  config: ServerConfig,
): Readonly<{
  readonly onRequest: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly preValidation: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> => {
  const pendingTransports = new WeakMap<object, AuthenticatedWorkerTransport>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    authenticatedWorkerIdentities.delete(request);
    if (pendingTransports.has(request)) {
      pendingTransports.delete(request);
      sendAuthenticationFailure(
        reply,
        401,
        "worker_authentication_state_invalid",
        "Worker transport authentication state is invalid.",
      );
      return;
    }
    const transport = safelyAuthenticateWorkerTransport(config, request, reply);
    if (transport !== undefined) {
      pendingTransports.set(request, transport);
    }
  };
  const preValidation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    authenticatedWorkerIdentities.delete(request);
    const transport = pendingTransports.get(request);
    pendingTransports.delete(request);
    if (transport === undefined) {
      sendAuthenticationFailure(
        reply,
        401,
        "worker_authentication_state_missing",
        "Worker transport authentication state is missing.",
      );
      return;
    }
    const claimedWorkerNodeIds = readClaimedWorkerNodeIds(request.body);
    if (claimedWorkerNodeIds.length === 0) {
      sendAuthenticationFailure(
        reply,
        400,
        "worker_identity_missing",
        "The request must claim a workerNodeId.",
      );
      return;
    }
    bindAuthenticatedWorkerIdentity(request, reply, transport, claimedWorkerNodeIds);
  };
  return Object.freeze({ onRequest, preValidation });
};

export const getAuthenticatedWorkerIdentity = (request: object): AuthenticatedWorkerIdentity => {
  const identity = authenticatedWorkerIdentities.get(request);
  if (identity === undefined) {
    throw new Error("The Worker request was not authenticated.");
  }
  return identity;
};
