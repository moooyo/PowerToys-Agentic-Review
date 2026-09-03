import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export type WorkerAuthenticationPolicy = "registration" | "active";

export interface AuthenticatedWorkerIdentity {
  readonly workerNodeId: string;
  readonly authState: "pending" | "active";
  readonly authenticationMethod: "bearer-token";
}

interface AuthenticatedWorkerCredential {
  readonly identity: AuthenticatedWorkerIdentity;
  readonly workerTokenSha256: string;
}

const workerTokenPattern = /^arw1_[A-Za-z0-9_-]{43}$/u;
const authenticatedWorkerCredentials = new WeakMap<object, AuthenticatedWorkerCredential>();

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
    const claimedWorkerNodeIds: string[] = [];
    const workerNodeId = readOwnString(body, "workerNodeId");
    if (workerNodeId !== undefined) {
      claimedWorkerNodeIds.push(workerNodeId);
    }

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

const readWorkerToken = (request: FastifyRequest): string | undefined => {
  const authorizationValues: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") {
      authorizationValues.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  if (authorizationValues.length === 0 && typeof request.headers.authorization === "string") {
    authorizationValues.push(request.headers.authorization);
  }
  const authorization = authorizationValues[0];
  if (authorizationValues.length !== 1 || !authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  if (!workerTokenPattern.test(token)) {
    return undefined;
  }
  const encodedSecret = token.slice("arw1_".length);
  let secret: Buffer;
  try {
    secret = Buffer.from(encodedSecret, "base64url");
  } catch {
    return undefined;
  }
  if (secret.length !== 32 || secret.toString("base64url") !== encodedSecret) {
    return undefined;
  }
  return token;
};

const sendAuthenticationFailure = (
  reply: FastifyReply,
  statusCode: 401 | 403 | 503,
  code: string,
  message: string,
  retryable: boolean,
): void => {
  if (statusCode === 401) {
    reply.header("www-authenticate", "Bearer");
  }
  void reply.code(statusCode).send({ code, message, retryable });
};

const authenticateWorker = async (
  database: DatabaseClient,
  policy: WorkerAuthenticationPolicy,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedWorkerCredential | undefined> => {
  const token = readWorkerToken(request);
  if (token === undefined) {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_authentication_failed",
      "Worker authentication failed.",
      false,
    );
    return undefined;
  }

  const workerTokenSha256 = createHash("sha256").update(token, "ascii").digest("hex");
  let result: unknown;
  try {
    result = await database.request("authenticateWorkerToken", { workerTokenSha256 });
  } catch {
    sendAuthenticationFailure(
      reply,
      503,
      "worker_authentication_unavailable",
      "Worker authentication is temporarily unavailable.",
      true,
    );
    return undefined;
  }

  if (!isRecord(result) || readOwnString(result, "outcome") !== "authenticated") {
    sendAuthenticationFailure(
      reply,
      401,
      "worker_authentication_failed",
      "Worker authentication failed.",
      false,
    );
    return undefined;
  }
  const workerNodeId = readOwnString(result, "workerNodeId");
  const authState = readOwnString(result, "authState");
  if (workerNodeId === undefined || (authState !== "pending" && authState !== "active")) {
    sendAuthenticationFailure(
      reply,
      503,
      "worker_authentication_unavailable",
      "Worker authentication is temporarily unavailable.",
      true,
    );
    return undefined;
  }
  if (policy === "active" && authState !== "active") {
    sendAuthenticationFailure(
      reply,
      403,
      "worker_registration_required",
      "The Worker must complete registration before using this route.",
      false,
    );
    return undefined;
  }

  return Object.freeze({
    identity: Object.freeze({
      workerNodeId,
      authState,
      authenticationMethod: "bearer-token" as const,
    }),
    workerTokenSha256,
  });
};

const bindAuthenticatedWorkerIdentity = (
  request: FastifyRequest,
  reply: FastifyReply,
  credential: AuthenticatedWorkerCredential,
): void => {
  const claimedWorkerNodeIds = readClaimedWorkerNodeIds(request.body);
  if (
    claimedWorkerNodeIds.some((workerNodeId) => workerNodeId !== credential.identity.workerNodeId)
  ) {
    sendAuthenticationFailure(
      reply,
      403,
      "worker_identity_mismatch",
      "The claimed workerNodeId does not match the authenticated Worker identity.",
      false,
    );
    return;
  }
  authenticatedWorkerCredentials.set(request, credential);
};

export const createWorkerAuthenticationHooks = (
  database: DatabaseClient,
  policy: WorkerAuthenticationPolicy = "active",
): Readonly<{
  readonly onRequest: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly preValidation: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> => {
  const pendingCredentials = new WeakMap<object, AuthenticatedWorkerCredential>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    authenticatedWorkerCredentials.delete(request);
    pendingCredentials.delete(request);
    const credential = await authenticateWorker(database, policy, request, reply);
    if (credential !== undefined) {
      pendingCredentials.set(request, credential);
    }
  };
  const preValidation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    authenticatedWorkerCredentials.delete(request);
    const credential = pendingCredentials.get(request);
    pendingCredentials.delete(request);
    if (credential === undefined) {
      if (!reply.sent) {
        sendAuthenticationFailure(
          reply,
          503,
          "worker_authentication_unavailable",
          "Worker authentication is temporarily unavailable.",
          true,
        );
      }
      return;
    }
    bindAuthenticatedWorkerIdentity(request, reply, credential);
  };
  return Object.freeze({ onRequest, preValidation });
};

export const getAuthenticatedWorkerIdentity = (request: object): AuthenticatedWorkerIdentity => {
  const credential = authenticatedWorkerCredentials.get(request);
  if (credential === undefined) {
    throw new Error("The Worker request was not authenticated.");
  }
  return credential.identity;
};

export const getAuthenticatedWorkerTokenSha256 = (request: object): string => {
  const credential = authenticatedWorkerCredentials.get(request);
  if (credential === undefined) {
    throw new Error("The Worker request was not authenticated.");
  }
  return credential.workerTokenSha256;
};
