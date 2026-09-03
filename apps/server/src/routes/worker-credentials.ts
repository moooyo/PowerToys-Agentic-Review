import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import { type OperatorAuthRouteService, readOperatorSession } from "./auth.js";

export const WORKER_CREDENTIAL_PATHS = {
  create: "/api/v1/operator/worker-nodes",
  rotate: "/api/v1/operator/worker-nodes/:workerNodeId/token/rotate",
  revoke: "/api/v1/operator/worker-nodes/:workerNodeId/revoke",
} as const;

export interface WorkerCredentialRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
}

interface WorkerNodeParams {
  readonly workerNodeId: string;
}

const workerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const noStore = (reply: FastifyReply): FastifyReply =>
  reply
    .header("cache-control", "private, no-store")
    .header("pragma", "no-cache")
    .header("referrer-policy", "no-referrer");

const sendError = (
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  retryable = false,
): FastifyReply =>
  reply.code(statusCode).send({
    code,
    message,
    retryable,
  });

const readHeaderValues = (request: FastifyRequest, headerName: string): readonly string[] => {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
};

const hasExactOrigin = (request: FastifyRequest, expectedOrigin: string): boolean => {
  const origins = readHeaderValues(request, "origin");
  return origins.length === 1 && origins[0] === expectedOrigin;
};

const readCreateBody = (body: unknown): { readonly displayName: string } | undefined => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 1 ||
    typeof fields.displayName !== "string" ||
    fields.displayName.length < 1 ||
    fields.displayName.length > 512 ||
    fields.displayName.includes("\0")
  ) {
    return undefined;
  }
  return { displayName: fields.displayName };
};

const hasEmptyBody = (body: unknown): boolean =>
  body === undefined ||
  (body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0);

const createWorkerToken = (): string => `arw1_${randomBytes(32).toString("base64url")}`;

const hashWorkerToken = (token: string): string =>
  createHash("sha256").update(token, "ascii").digest("hex");

const sendDatabaseError = (reply: FastifyReply, error: unknown): FastifyReply => {
  const code = error instanceof DatabaseRequestError ? error.code : undefined;
  switch (code) {
    case "WORKER_NODE_CREDENTIAL_NOT_FOUND":
      return sendError(
        reply,
        404,
        "worker_node_credential_not_found",
        "The worker node credential does not exist.",
      );
    case "WORKER_NODE_CREDENTIAL_REVOKED":
      return sendError(
        reply,
        409,
        "worker_node_credential_revoked",
        "A revoked worker node credential cannot be changed.",
      );
    case "WORKER_NODE_CREDENTIAL_CONFLICT":
      return sendError(
        reply,
        409,
        "worker_node_credential_conflict",
        "The worker node credential conflicts with existing state.",
      );
    default:
      return sendError(
        reply,
        503,
        "worker_credential_store_unavailable",
        "Worker credential storage is unavailable.",
        true,
      );
  }
};

const sendInvalidRequest = (reply: FastifyReply): FastifyReply =>
  sendError(reply, 400, "request_validation_failed", "The worker credential request is invalid.");

const readWorkerNodeId = (params: WorkerNodeParams): string | undefined =>
  workerNodeIdPattern.test(params.workerNodeId) ? params.workerNodeId : undefined;

const createAuthorizationHook =
  (
    operatorAuth: OperatorAuthRouteService,
    sessions: WeakMap<FastifyRequest, OperatorSession>,
  ): onRequestAsyncHookHandler =>
  async (request, reply) => {
    noStore(reply);
    if (!hasExactOrigin(request, operatorAuth.publicOrigin)) {
      return sendError(
        reply,
        403,
        "invalid_operator_auth_origin",
        "The request origin is not authorized for this operator action.",
      );
    }
    const session = await readOperatorSession(request, operatorAuth);
    if (session === null) {
      return sendError(
        reply,
        401,
        "operator_authentication_required",
        "An authenticated operator session is required.",
      );
    }
    sessions.set(request, session);
  };

const requireSession = (
  request: FastifyRequest,
  sessions: WeakMap<FastifyRequest, OperatorSession>,
): OperatorSession => {
  const session = sessions.get(request);
  if (session === undefined) {
    throw new Error("The worker credential authorization hook did not publish a session.");
  }
  return session;
};

export const registerWorkerCredentialRoutes = (
  app: FastifyInstance,
  dependencies: WorkerCredentialRouteDependencies,
): void => {
  const sessions = new WeakMap<FastifyRequest, OperatorSession>();
  const authorize = createAuthorizationHook(dependencies.operatorAuth, sessions);

  app.post<{ Body: unknown }>(
    WORKER_CREDENTIAL_PATHS.create,
    { onRequest: authorize },
    async (request, reply) => {
      const body = readCreateBody(request.body);
      if (body === undefined) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);
      const workerNodeId = `worker:${randomUUID()}`;
      const token = createWorkerToken();
      const workerTokenSha256 = hashWorkerToken(token);

      try {
        const result = await dependencies.database.request("createWorkerNodeCredential", {
          workerNodeId,
          displayName: body.displayName,
          workerTokenSha256,
          createdByIssuer: session.issuer,
          createdBySubject: session.subject,
        });
        if (result.workerNodeId !== workerNodeId || result.authState !== "pending") {
          return sendDatabaseError(reply, undefined);
        }
        return reply.code(201).send({ workerNodeId, authState: "pending", token });
      } catch (error) {
        return sendDatabaseError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown; Params: WorkerNodeParams }>(
    WORKER_CREDENTIAL_PATHS.rotate,
    { onRequest: authorize },
    async (request, reply) => {
      const workerNodeId = readWorkerNodeId(request.params);
      if (workerNodeId === undefined || !hasEmptyBody(request.body)) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);
      const token = createWorkerToken();
      const workerTokenSha256 = hashWorkerToken(token);

      try {
        const result = await dependencies.database.request("rotateWorkerToken", {
          workerNodeId,
          workerTokenSha256,
          rotatedByIssuer: session.issuer,
          rotatedBySubject: session.subject,
        });
        if (
          result.workerNodeId !== workerNodeId ||
          (result.authState !== "pending" && result.authState !== "active")
        ) {
          return sendDatabaseError(reply, undefined);
        }
        return reply.send({ workerNodeId, authState: result.authState, token });
      } catch (error) {
        return sendDatabaseError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown; Params: WorkerNodeParams }>(
    WORKER_CREDENTIAL_PATHS.revoke,
    { onRequest: authorize },
    async (request, reply) => {
      const workerNodeId = readWorkerNodeId(request.params);
      if (workerNodeId === undefined || !hasEmptyBody(request.body)) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);

      try {
        const result = await dependencies.database.request("revokeWorkerToken", {
          workerNodeId,
          revokedByIssuer: session.issuer,
          revokedBySubject: session.subject,
        });
        if (result.workerNodeId !== workerNodeId || result.authState !== "revoked") {
          return sendDatabaseError(reply, undefined);
        }
        return reply.send({ workerNodeId, authState: "revoked" });
      } catch (error) {
        return sendDatabaseError(reply, error);
      }
    },
  );
};
