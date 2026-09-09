import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type {
  WorkerNodeAuthState,
  WorkerNodeCredentialListItem,
  WorkerNodeCredentialListResult,
} from "../database/protocol.js";
import type { OperatorSession } from "../security/operator-auth.js";
import { type OperatorAuthRouteService, readOperatorSession } from "./auth.js";
import { sendConfigurationError } from "./configuration-support.js";

export const WORKER_CREDENTIAL_PATHS = {
  list: "/api/v1/operator/worker-nodes",
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

interface WorkerCredentialListPagination {
  readonly offset: number;
  readonly limit: number;
  readonly sort?: "identity";
}

const workerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const storedWorkerNodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const workerTokenShapePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const canonicalPositiveIntegerPattern = /^[1-9][0-9]*$/u;
const canonicalDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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
    fields.displayName.includes("\0") ||
    workerTokenShapePattern.test(fields.displayName)
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

const readRotateBody = (body: unknown): { readonly expectedUpdatedAt: string } | undefined => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 1 ||
    typeof fields.expectedUpdatedAt !== "string" ||
    !canonicalDateTimePattern.test(fields.expectedUpdatedAt) ||
    !Number.isFinite(Date.parse(fields.expectedUpdatedAt)) ||
    new Date(Date.parse(fields.expectedUpdatedAt)).toISOString() !== fields.expectedUpdatedAt
  ) {
    return undefined;
  }
  return { expectedUpdatedAt: fields.expectedUpdatedAt };
};

const readCanonicalPositiveInteger = (
  values: readonly string[],
  defaultValue: number,
): number | undefined => {
  if (values.length === 0) {
    return defaultValue;
  }
  if (values.length !== 1 || !canonicalPositiveIntegerPattern.test(values[0] ?? "")) {
    return undefined;
  }
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : undefined;
};

const readListPagination = (
  request: FastifyRequest,
): WorkerCredentialListPagination | undefined => {
  const rawUrl = request.raw.url;
  if (rawUrl === undefined) {
    return undefined;
  }
  const queryStart = rawUrl.indexOf("?");
  const rawQuery = queryStart === -1 ? "" : rawUrl.slice(queryStart + 1);
  const values = new Map<string, string[]>();
  if (rawQuery.length > 0) {
    for (const field of rawQuery.split("&")) {
      const match = /^(?:(page|pageSize)=([1-9][0-9]*)|(sort)=(identity))$/u.exec(field);
      if (match === null) {
        return undefined;
      }
      const name = match[1] ?? match[3];
      const value = match[2] ?? match[4];
      if (name === undefined || value === undefined) {
        return undefined;
      }
      const existing = values.get(name);
      if (existing !== undefined) {
        existing.push(value);
      } else {
        values.set(name, [value]);
      }
    }
  }
  for (const name of values.keys()) {
    if (name !== "page" && name !== "pageSize" && name !== "sort") {
      return undefined;
    }
  }
  const page = readCanonicalPositiveInteger(values.get("page") ?? [], 1);
  const pageSize = readCanonicalPositiveInteger(values.get("pageSize") ?? [], 200);
  if (page === undefined || pageSize === undefined || pageSize > 200) {
    return undefined;
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    return undefined;
  }
  const sortValues = values.get("sort") ?? [];
  if (sortValues.length > 1 || (sortValues.length === 1 && sortValues[0] !== "identity")) {
    return undefined;
  }
  return {
    offset,
    limit: pageSize,
    ...(sortValues.length === 0 ? {} : { sort: "identity" as const }),
  };
};

const createWorkerToken = (): string => `arw1_${randomBytes(32).toString("base64url")}`;

const hashWorkerToken = (token: string): string =>
  createHash("sha256").update(token, "ascii").digest("hex");

const sendDatabaseError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "PLATFORM_FORBIDDEN" || error.code === "PLATFORM_NOT_FOUND")
  ) {
    return sendConfigurationError(reply, error);
  }
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

const workerNodeAuthStates = new Set<WorkerNodeAuthState>(["pending", "active", "revoked"]);
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" &&
  dateTimePattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

const isNullableDateTime = (value: unknown): value is string | null =>
  value === null || isDateTime(value);

const readWorkerNodeCredentialListItem = (
  value: unknown,
): WorkerNodeCredentialListItem | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 8 ||
    typeof fields.workerNodeId !== "string" ||
    !storedWorkerNodeIdPattern.test(fields.workerNodeId) ||
    typeof fields.displayName !== "string" ||
    fields.displayName.length < 1 ||
    fields.displayName.length > 512 ||
    fields.displayName.includes("\0") ||
    workerTokenShapePattern.test(fields.displayName) ||
    typeof fields.authState !== "string" ||
    !workerNodeAuthStates.has(fields.authState as WorkerNodeAuthState) ||
    !isDateTime(fields.createdAt) ||
    !isNullableDateTime(fields.activatedAt) ||
    !isNullableDateTime(fields.rotatedAt) ||
    !isNullableDateTime(fields.revokedAt) ||
    !isDateTime(fields.updatedAt)
  ) {
    return undefined;
  }
  return {
    workerNodeId: fields.workerNodeId,
    displayName: fields.displayName,
    authState: fields.authState as WorkerNodeAuthState,
    createdAt: fields.createdAt,
    activatedAt: fields.activatedAt,
    rotatedAt: fields.rotatedAt,
    revokedAt: fields.revokedAt,
    updatedAt: fields.updatedAt,
  };
};

const readWorkerNodeCredentialListResult = (
  value: unknown,
  maximumItems: number,
): WorkerNodeCredentialListResult | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    !Array.isArray(fields.items) ||
    fields.items.length > maximumItems ||
    typeof fields.total !== "number" ||
    !Number.isSafeInteger(fields.total) ||
    fields.total < fields.items.length
  ) {
    return undefined;
  }
  const items: WorkerNodeCredentialListItem[] = [];
  for (const valueItem of fields.items) {
    const item = readWorkerNodeCredentialListItem(valueItem);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return { items, total: fields.total };
};

const createAuthorizationHook =
  (
    operatorAuth: OperatorAuthRouteService,
    sessions: WeakMap<FastifyRequest, OperatorSession>,
    requireExactOrigin: boolean,
  ): onRequestAsyncHookHandler =>
  async (request, reply) => {
    noStore(reply);
    if (requireExactOrigin && !hasExactOrigin(request, operatorAuth.publicOrigin)) {
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
  const authorizeRead = createAuthorizationHook(dependencies.operatorAuth, sessions, false);
  const authorizeMutation = createAuthorizationHook(dependencies.operatorAuth, sessions, true);

  app.get(WORKER_CREDENTIAL_PATHS.list, { onRequest: authorizeRead }, async (request, reply) => {
    const pagination = readListPagination(request);
    if (pagination === undefined) {
      return sendInvalidRequest(reply);
    }
    try {
      const session = requireSession(request, sessions);
      const database = bindOperatorDatabase(dependencies.database, {
        issuer: session.issuer,
        subject: session.subject,
      });
      await database.request("operatorCheckPermission", {});
      const result: unknown = await database.request("listWorkerNodeCredentials", pagination);
      const response = readWorkerNodeCredentialListResult(result, pagination.limit);
      if (response === undefined) {
        return sendDatabaseError(reply, undefined);
      }
      return reply.send(response);
    } catch (error) {
      return sendDatabaseError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(
    WORKER_CREDENTIAL_PATHS.create,
    { onRequest: authorizeMutation },
    async (request, reply) => {
      const body = readCreateBody(request.body);
      if (body === undefined) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);

      try {
        const database = bindOperatorDatabase(dependencies.database, {
          issuer: session.issuer,
          subject: session.subject,
        });
        await database.request("operatorCheckPermission", {});
        const workerNodeId = `worker:${randomUUID()}`;
        const token = createWorkerToken();
        const workerTokenSha256 = hashWorkerToken(token);
        const result = await database.request("createWorkerNodeCredential", {
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
    { onRequest: authorizeMutation },
    async (request, reply) => {
      const workerNodeId = readWorkerNodeId(request.params);
      const body = readRotateBody(request.body);
      if (workerNodeId === undefined || body === undefined) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);

      try {
        const database = bindOperatorDatabase(dependencies.database, {
          issuer: session.issuer,
          subject: session.subject,
        });
        await database.request("operatorCheckPermission", {});
        const token = createWorkerToken();
        const workerTokenSha256 = hashWorkerToken(token);
        const result = await database.request("rotateWorkerToken", {
          workerNodeId,
          workerTokenSha256,
          expectedUpdatedAt: body.expectedUpdatedAt,
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
    { onRequest: authorizeMutation },
    async (request, reply) => {
      const workerNodeId = readWorkerNodeId(request.params);
      if (workerNodeId === undefined || !hasEmptyBody(request.body)) {
        return sendInvalidRequest(reply);
      }
      const session = requireSession(request, sessions);

      try {
        const database = bindOperatorDatabase(dependencies.database, {
          issuer: session.issuer,
          subject: session.subject,
        });
        await database.request("operatorCheckPermission", {});
        const result = await database.request("revokeWorkerToken", {
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
