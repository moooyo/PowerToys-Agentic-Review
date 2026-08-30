import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";

export interface AuthenticatedWorkerIdentity {
  readonly workerNodeId: string;
  readonly certificateFingerprint: string | undefined;
  readonly authenticationMethod: "mtls" | "insecure-loopback";
}

const authenticatedWorkerIdentities = new WeakMap<object, AuthenticatedWorkerIdentity>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readClaimedWorkerNodeIds = (body: unknown): readonly string[] => {
  if (!isRecord(body) || typeof body.workerNodeId !== "string") {
    return [];
  }

  const claimedWorkerNodeIds = [body.workerNodeId];
  if (Array.isArray(body.activeLeases)) {
    for (const activeLease of body.activeLeases) {
      if (isRecord(activeLease) && typeof activeLease.workerNodeId === "string") {
        claimedWorkerNodeIds.push(activeLease.workerNodeId);
      }
    }
  }
  return claimedWorkerNodeIds;
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

    let identity: AuthenticatedWorkerIdentity;
    if (config.allowInsecureWorkerAuth) {
      if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
        sendAuthenticationFailure(
          reply,
          403,
          "insecure_worker_auth_loopback_only",
          "Insecure Worker authentication is restricted to loopback clients.",
        );
        return;
      }
      identity = {
        workerNodeId: claimedWorkerNodeIds[0] as string,
        certificateFingerprint: undefined,
        authenticationMethod: "insecure-loopback",
      };
    } else {
      const socket = request.raw.socket;
      if (!(socket instanceof TLSSocket) || !socket.encrypted) {
        sendAuthenticationFailure(
          reply,
          401,
          "worker_mtls_required",
          "A mutually authenticated TLS connection is required.",
        );
        return;
      }
      if (!socket.authorized) {
        sendAuthenticationFailure(
          reply,
          401,
          "worker_certificate_unauthorized",
          "The Worker client certificate was not authorized by the configured CA.",
        );
        return;
      }

      const certificateFingerprint = fingerprintPeerCertificate(socket);
      if (certificateFingerprint === undefined) {
        sendAuthenticationFailure(
          reply,
          401,
          "worker_certificate_missing",
          "The TLS connection did not provide a usable Worker client certificate.",
        );
        return;
      }
      const workerNodeId = config.workerCertificateBindings[certificateFingerprint];
      if (workerNodeId === undefined) {
        sendAuthenticationFailure(
          reply,
          403,
          "worker_certificate_unmapped",
          "The Worker client certificate is not bound to a workerNodeId.",
        );
        return;
      }
      identity = {
        workerNodeId,
        certificateFingerprint,
        authenticationMethod: "mtls",
      };
    }

    if (
      claimedWorkerNodeIds.some(
        (claimedWorkerNodeId) => claimedWorkerNodeId !== identity.workerNodeId,
      )
    ) {
      sendAuthenticationFailure(
        reply,
        403,
        "worker_identity_mismatch",
        "The claimed workerNodeId does not match the authenticated Worker identity.",
      );
      return;
    }

    authenticatedWorkerIdentities.set(request, identity);
  };

export const getAuthenticatedWorkerIdentity = (request: object): AuthenticatedWorkerIdentity => {
  const identity = authenticatedWorkerIdentities.get(request);
  if (identity === undefined) {
    throw new Error("The Worker request was not authenticated.");
  }
  return identity;
};
