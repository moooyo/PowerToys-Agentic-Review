import * as C from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createWorkerAuthenticationHooks,
  getAuthenticatedWorkerIdentity,
  getAuthenticatedWorkerTokenSha256,
} from "../security/worker-identity.js";

const path = "/api/v1/worker/runs/:runAttemptId/model-invocations";
export const MODEL_INVOCATION_PATHS = Object.freeze({
  begin: `${path}/open`,
  seal: `${path}/:invocationId/seal`,
  submit: `${path}/:invocationId/receipts`,
});
export interface ModelInvocationRouteDependencies {
  readonly database: DatabaseClient;
  readonly config: Pick<ServerConfig, "recoveryMaintenance">;
  readonly shutdownSignal: AbortSignal;
}
class InvocationHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
function invalid(): never {
  throw new InvocationHttpError(
    400,
    "model_invocation_invalid",
    "The model invocation request is invalid.",
  );
}
function responseCheck(condition: boolean): void {
  if (!condition)
    throw new InvocationHttpError(
      502,
      "model_invocation_response_invalid",
      "The model invocation response could not be validated.",
    );
}
function parameter(request: FastifyRequest, key: string): string {
  const raw = (request.params as Record<string, unknown>)[key];
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(raw))
    invalid();
  return raw;
}

// JSON.parse accepts duplicate keys. Scan this route's bounded raw JSON first so even
// escaped spellings of the same key cannot silently replace a lease or receipt field.
function strictJson(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid();
  }
  let at = 0,
    nodes = 0;
  const space = () => {
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return;
      at += 1;
    }
  };
  const character = (expected: string) => {
    space();
    if (text[at] !== expected) invalid();
    at += 1;
  };
  const string = (): string => {
    const start = at;
    character('"');
    while (at < text.length) {
      const current = text[at++];
      if (current === "\\") {
        at += 1;
        continue;
      }
      if (current === '"') {
        try {
          const value: unknown = JSON.parse(text.slice(start, at));
          if (typeof value !== "string" || !value.isWellFormed()) invalid();
          return value;
        } catch {
          return invalid();
        }
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64 || ++nodes > 100_000) invalid();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{",
        end = object ? "}" : "]",
        names = new Set<string>();
      space();
      if (text[at] === end) {
        at += 1;
        return;
      }
      while (true) {
        space();
        if (object) {
          const key = string();
          if (names.has(key)) invalid();
          names.add(key);
          character(":");
        }
        value(depth + 1);
        space();
        if (text[at] === end) {
          at += 1;
          return;
        }
        character(",");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      text.slice(at),
    );
    if (!token) invalid();
    at += token[0].length;
  };
  value(0);
  space();
  if (at !== text.length) invalid();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid();
  }
}

function requestBody<T extends TSchema>(
  schema: T,
  input: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  if (issues(input).length || !Value.Check(schema, input)) invalid();
  return input as Static<T>;
}
function response<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  responseCheck(issues(raw).length === 0 && Value.Check(schema, raw));
  return raw as Static<T>;
}
function requireScope(
  request: FastifyRequest,
  input: { lease: C.LeaseIdentity; invocationId: string },
  invocationPath: boolean,
): void {
  if (Object.keys(request.query as object).length > 0) invalid();
  if (parameter(request, "runAttemptId") !== input.lease.runAttemptId) invalid();
  if (invocationPath && parameter(request, "invocationId") !== input.invocationId) invalid();
  if (input.lease.workerNodeId !== getAuthenticatedWorkerIdentity(request).workerNodeId)
    throw new InvocationHttpError(
      403,
      "worker_identity_mismatch",
      "The invocation lease does not belong to the authenticated Worker.",
    );
}
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InvocationHttpError) {
    if (error.statusCode === 401) reply.header("www-authenticate", "Bearer");
    if (error.retryable && !reply.hasHeader("retry-after")) reply.header("retry-after", "1");
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, retryable: error.retryable });
  }
  if (error instanceof DatabaseRequestError) {
    const mapping: Record<string, readonly [number, string, boolean]> = {
      MODEL_INVOCATION_INVALID: [400, "The model invocation request is invalid.", false],
      MODEL_INVOCATION_NOT_FOUND: [404, "The model invocation was not found.", false],
      MODEL_INVOCATION_CONFLICT: [
        409,
        "The model invocation conflicts with its immutable record.",
        false,
      ],
      VALIDATION_SUMMARY_INPUT_CONFLICT: [
        409,
        "The summary input reference does not match this immutable invocation.",
        false,
      ],
      MODEL_INVOCATION_LEASE_REJECTED: [
        409,
        "The model invocation lease is no longer authorized.",
        false,
      ],
      WORKER_TOKEN_REJECTED: [401, "Worker authentication failed.", false],
      DATABASE_READ_ONLY: [
        503,
        "Model invocation writes are unavailable during recovery maintenance.",
        true,
      ],
      DATABASE_WORKER_SHUTTING_DOWN: [503, "The service is shutting down.", true],
    };
    const entry = mapping[error.code ?? ""];
    if (entry)
      return sendError(
        reply,
        new InvocationHttpError(entry[0], String(error.code).toLowerCase(), entry[1], entry[2]),
      );
  }
  if (error instanceof Error && "statusCode" in error && Number(error.statusCode) === 429)
    return sendError(
      reply,
      new InvocationHttpError(
        429,
        "request_rate_limited",
        "The Worker request rate limit was reached.",
        true,
      ),
    );
  if (
    error instanceof Error &&
    "statusCode" in error &&
    [400, 413, 415].includes(Number(error.statusCode))
  ) {
    const status = Number(error.statusCode);
    return sendError(
      reply,
      new InvocationHttpError(
        status,
        status === 413 ? "model_invocation_too_large" : "model_invocation_invalid",
        status === 413
          ? "The model invocation request exceeds its UTF-8 byte limit."
          : "The model invocation request is invalid.",
      ),
    );
  }
  return reply.code(500).send({
    code: "model_invocation_unavailable",
    message: "The model invocation could not be processed.",
    retryable: false,
  });
}

export function registerModelInvocationRoutes(
  app: FastifyInstance,
  dependencies: ModelInvocationRouteDependencies,
): void {
  app.register(async (scope) => {
    const authenticate = createWorkerAuthenticationHooks(dependencies.database);
    scope.setErrorHandler((error, _request, reply) => sendError(reply, error));
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: C.maximumModelInvocationSubmitRequestUtf8Bytes },
      (request, bytes, done) => {
        try {
          if (
            (bytes as Buffer).length >
            (request.routeOptions.bodyLimit ?? C.maximumModelInvocationSubmitRequestUtf8Bytes)
          )
            throw new InvocationHttpError(
              413,
              "model_invocation_too_large",
              "The model invocation request exceeds its UTF-8 byte limit.",
            );
          done(null, strictJson(bytes as Buffer));
        } catch (error) {
          done(error instanceof Error ? error : new Error("Invalid invocation JSON."));
        }
      },
    );
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (dependencies.config.recoveryMaintenance)
        return sendError(
          reply,
          new InvocationHttpError(
            503,
            "worker_api_maintenance",
            "Worker API access is disabled during recovery maintenance.",
            true,
          ),
        );
      if (dependencies.shutdownSignal.aborted)
        return sendError(
          reply,
          new InvocationHttpError(
            503,
            "database_worker_shutting_down",
            "The service is shutting down.",
            true,
          ),
        );
      await authenticate.onRequest(request, reply);
    });
    scope.addHook("preValidation", authenticate.preValidation);

    scope.post(
      MODEL_INVOCATION_PATHS.begin,
      { bodyLimit: C.maximumModelInvocationControlRequestUtf8Bytes },
      async (request, reply) => {
        const input = requestBody(
          C.ModelInvocationBeginRequestSchema,
          request.body,
          C.getModelInvocationBeginRequestIssues,
        );
        requireScope(request, input, false);
        const result = response(
          C.ModelInvocationOpeningSchema,
          await dependencies.database.request("beginModelInvocation", {
            workerTokenSha256: getAuthenticatedWorkerTokenSha256(request),
            request: input,
          }),
          C.getModelInvocationOpeningIssues,
        );
        const actual = result.scope,
          lease = input.lease;
        responseCheck(
          actual.invocationId === input.invocationId &&
            actual.jobId === lease.jobId &&
            actual.attemptId === lease.runAttemptId &&
            actual.workerNodeId === lease.workerNodeId &&
            actual.workerInstanceId === lease.workerInstanceId &&
            actual.leaseGeneration === lease.leaseGeneration &&
            result.scopeSha256 === sha256(canonicalJson(actual)) &&
            (input.summaryInput === undefined
              ? actual.schemaVersion === "ModelInvocationScopeV1"
              : actual.schemaVersion === "ModelInvocationScopeV2" &&
                canonicalJson(actual.inputRef) === canonicalJson(input.summaryInput)) &&
            canonicalJson(result.runtime) === canonicalJson(input.runtime),
        );
        return reply.code(200).send(result);
      },
    );
    scope.post(
      MODEL_INVOCATION_PATHS.seal,
      { bodyLimit: C.maximumModelInvocationControlRequestUtf8Bytes },
      async (request, reply) => {
        const input = requestBody(
          C.ModelInvocationSealRequestSchema,
          request.body,
          C.getModelInvocationSealRequestIssues,
        );
        requireScope(request, input, true);
        const result = response(
          C.ModelInvocationSealV1Schema,
          await dependencies.database.request("sealModelInvocation", {
            workerTokenSha256: getAuthenticatedWorkerTokenSha256(request),
            request: input,
          }),
          C.getModelInvocationSealIssues,
        );
        const expected = Object.fromEntries(
          Object.entries(input).filter(([key]) => key !== "lease"),
        );
        const actual = Object.fromEntries(
          Object.entries(result).filter(([key]) => key !== "schemaVersion" && key !== "recordedAt"),
        );
        responseCheck(canonicalJson(actual) === canonicalJson(expected));
        return reply.code(200).send(result);
      },
    );
    scope.post(
      MODEL_INVOCATION_PATHS.submit,
      { bodyLimit: C.maximumModelInvocationSubmitRequestUtf8Bytes },
      async (request, reply) => {
        const input = requestBody(
          C.ModelInvocationSubmitRequestSchema,
          request.body,
          C.getModelInvocationSubmitRequestIssues,
        );
        requireScope(request, input, true);
        const result = response(
          C.ModelInvocationSubmissionV1Schema,
          await dependencies.database.request("submitModelInvocationReceipts", {
            workerTokenSha256: getAuthenticatedWorkerTokenSha256(request),
            request: input,
          }),
          C.getModelInvocationSubmissionIssues,
        );
        // The owner admits only the exact scope and bytes bound by its opening and seal;
        // internal call-chain diagnostics may still report unavailable or invalid consistency.
        responseCheck(
          result.invocationId === input.invocationId &&
            result.scopeSha256 === input.receiptSet.scopeSha256 &&
            result.scopeSha256 === sha256(canonicalJson(input.receiptSet.scope)) &&
            result.receiptSetSha256 === sha256(canonicalJson(input.receiptSet)) &&
            (result.consistency.observedIdentitySha256 === null ||
              result.consistency.observedIdentitySha256 ===
                input.receiptSet.observedIdentitySha256),
        );
        return reply.code(200).send(result);
      },
    );
  });
}
