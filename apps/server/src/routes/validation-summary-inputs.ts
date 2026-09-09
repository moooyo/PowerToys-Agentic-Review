import * as C from "@agentic-review/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createWorkerAuthenticationHooks,
  getAuthenticatedWorkerIdentity,
  getAuthenticatedWorkerTokenSha256,
} from "../security/worker-identity.js";

export const VALIDATION_SUMMARY_INPUT_PATH = "/api/v1/worker/model-summary-inputs";
export interface ValidationSummaryInputRouteDependencies {
  readonly database: DatabaseClient;
  readonly config: Pick<ServerConfig, "recoveryMaintenance">;
  readonly shutdownSignal: AbortSignal;
}
class InputHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super("The validation summary input could not be processed.");
  }
}
function invalid(): never {
  throw new InputHttpError(400, "validation_summary_input_invalid");
}
// Reject duplicate decoded keys before JSON.parse can silently overwrite a lease or runner fact.
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
    while (at < text.length && /[\t\r\n ]/u.test(text[at] as string)) at++;
  };
  const character = (expected: string) => {
    space();
    if (text[at++] !== expected) invalid();
  };
  const string = (): string => {
    const start = at;
    character('"');
    while (at < text.length) {
      const current = text[at++];
      if (current === "\\") {
        at++;
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
    if (depth > 64 || ++nodes > 100000) invalid();
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
        at++;
        return;
      }
      while (true) {
        space();
        if (object) {
          const name = string();
          if (names.has(name)) invalid();
          names.add(name);
          character(":");
        }
        value(depth + 1);
        space();
        if (text[at] === end) {
          at++;
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
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DatabaseRequestError) {
    const code = error.code ?? "";
    const status =
      code === "WORKER_TOKEN_REJECTED"
        ? 401
        : [
              "VALIDATION_SUMMARY_INPUT_INVALID",
              "MODEL_INVOCATION_INVALID",
              "REVIEW_RESULT_INVALID",
            ].includes(code)
          ? 400
          : [
                "VALIDATION_SUMMARY_INPUT_CONFLICT",
                "MODEL_INVOCATION_LEASE_REJECTED",
                "EVIDENCE_LEASE_REJECTED",
              ].includes(code)
            ? 409
            : [
                  "DATABASE_READ_ONLY",
                  "DATABASE_WORKER_SHUTTING_DOWN",
                  "EVIDENCE_UNAVAILABLE",
                  "EVIDENCE_VERIFIER_UNAVAILABLE",
                  "EVIDENCE_VERIFIER_TIMEOUT",
                ].includes(code)
              ? 503
              : 500;
    return sendError(
      reply,
      new InputHttpError(
        status,
        status === 500 ? "validation_summary_input_unavailable" : code.toLowerCase(),
        status === 503,
      ),
    );
  }
  if (error instanceof InputHttpError) {
    if (error.statusCode === 401) reply.header("www-authenticate", "Bearer");
    if (error.retryable) reply.header("retry-after", "1");
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, retryable: error.retryable });
  }
  const status = error instanceof Error && "statusCode" in error ? Number(error.statusCode) : 500;
  return sendError(
    reply,
    new InputHttpError(
      [400, 401, 403, 413, 415, 429].includes(status) ? status : 500,
      status === 413
        ? "validation_summary_input_too_large"
        : status === 429
          ? "request_rate_limited"
          : status === 500
            ? "validation_summary_input_unavailable"
            : "validation_summary_input_invalid",
      status === 429,
    ),
  );
}
export function registerValidationSummaryInputRoutes(
  app: FastifyInstance,
  dependencies: ValidationSummaryInputRouteDependencies,
): void {
  app.register(async (scope) => {
    const authenticate = createWorkerAuthenticationHooks(dependencies.database);
    scope.setErrorHandler((error, _request, reply) => sendError(reply, error));
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: C.maximumFreezeValidationSummaryInputRequestUtf8Bytes },
      (_request, bytes, done) => {
        try {
          done(null, strictJson(bytes as Buffer));
        } catch (error) {
          done(
            error instanceof Error
              ? error
              : new InputHttpError(400, "validation_summary_input_invalid"),
          );
        }
      },
    );
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (dependencies.config.recoveryMaintenance)
        return sendError(reply, new InputHttpError(503, "worker_api_maintenance", true));
      if (dependencies.shutdownSignal.aborted)
        return sendError(reply, new InputHttpError(503, "database_worker_shutting_down", true));
      await authenticate.onRequest(request, reply);
    });
    scope.addHook("preValidation", authenticate.preValidation);
    scope.post(
      VALIDATION_SUMMARY_INPUT_PATH,
      { bodyLimit: C.maximumFreezeValidationSummaryInputRequestUtf8Bytes },
      async (request, reply) => {
        if (
          Object.keys(request.query as object).length ||
          request.raw.url !== VALIDATION_SUMMARY_INPUT_PATH ||
          C.getFreezeValidationSummaryInputRequestIssues(request.body).length
        )
          invalid();
        const input = request.body as C.FreezeValidationSummaryInputRequest;
        if (input.lease.workerNodeId !== getAuthenticatedWorkerIdentity(request).workerNodeId)
          throw new InputHttpError(403, "worker_identity_mismatch");
        const result = await dependencies.database.request("freezeValidationSummaryInput", {
          workerTokenSha256: getAuthenticatedWorkerTokenSha256(request),
          request: input,
        });
        if (
          C.getFreezeValidationSummaryInputResponseIssues(result).length ||
          result.reference.inputId !== input.inputId ||
          result.reference.contextSha256 !== sha256(canonicalJson(input.context))
        )
          throw new InputHttpError(502, "validation_summary_input_response_invalid");
        return reply.code(200).send(result);
      },
    );
  });
}
