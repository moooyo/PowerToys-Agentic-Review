import { EntityIdSchema } from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import { type OperatorAuthRouteService, readOperatorSession } from "./auth.js";
import { sendMappedEvidenceError } from "./evidence-http-errors.js";

export class ConfigurationHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ConfigurationHttpError";
  }
}

function ensureFormats(): void {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

export function parseConfigurationBody<T extends TSchema>(schema: T, value: unknown): Static<T> {
  ensureFormats();
  if (!Value.Check(schema, value))
    throw new ConfigurationHttpError(
      400,
      "configuration_request_invalid",
      "The configuration request is invalid.",
    );
  return value as Static<T>;
}

export function configurationEntityId(value: unknown): string {
  return parseConfigurationBody(EntityIdSchema, value);
}

export function configurationQuery(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationHttpError(
      400,
      "configuration_query_invalid",
      "The configuration query is invalid.",
    );
  }
  const query: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowedKeys.includes(key) || typeof entry !== "string") {
      throw new ConfigurationHttpError(
        400,
        "configuration_query_invalid",
        "Query fields must be supported and occur only once.",
      );
    }
    query[key] = entry;
  }
  return query;
}

export function configurationPagination(query: Record<string, string>): {
  page: number;
  pageSize: number;
} {
  const parse = (value: string | undefined, fallback: number, maximum: number): number => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(number) || number > maximum) {
      throw new ConfigurationHttpError(
        400,
        "configuration_query_invalid",
        "Pagination is outside the supported bounds.",
      );
    }
    return number;
  };
  const page = parse(query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parse(query.pageSize, 20, 50);
  if (!Number.isSafeInteger((page - 1) * pageSize))
    throw new ConfigurationHttpError(
      400,
      "configuration_query_invalid",
      "The requested page is too large.",
    );
  return { page, pageSize };
}

export function validateConfigurationResponse<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  ensureFormats();
  if (
    !Value.Check(schema, value) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 2 * 1_024 * 1_024
  ) {
    throw new ConfigurationHttpError(
      502,
      "configuration_response_invalid",
      "The configuration response could not be validated.",
    );
  }
  return value as Static<T>;
}

export function sendConfigurationResponse(
  reply: FastifyReply,
  schema: TSchema,
  value: unknown,
): FastifyReply {
  return reply.send(validateConfigurationResponse(schema, value));
}

export function sendConfigurationError(reply: FastifyReply, error: unknown): FastifyReply {
  const evidenceError = sendMappedEvidenceError(reply, error);
  if (evidenceError !== undefined) return evidenceError;
  if (error instanceof ConfigurationHttpError) {
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, retryable: error.retryable });
  }
  if (error instanceof DatabaseRequestError) {
    const statuses: Record<string, number> = {
      PLATFORM_INVALID: 400,
      PLATFORM_NOT_FOUND: 404,
      PLATFORM_FORBIDDEN: 403,
      PLATFORM_CONFLICT: 409,
    };
    const status = error.code === undefined ? undefined : statuses[error.code];
    if (status !== undefined)
      return reply.code(status).send({
        code: error.code?.toLowerCase(),
        message:
          error.code === "PLATFORM_NOT_FOUND"
            ? "The requested resource was not found."
            : error.code === "PLATFORM_FORBIDDEN"
              ? "The operator does not have permission for this action."
              : error.message,
        retryable: false,
      });
  }
  return reply.code(500).send({
    code: "configuration_operation_failed",
    message: "The configuration operation could not be completed.",
    retryable: false,
  });
}

export function createConfigurationAuthorization(
  operatorAuth: OperatorAuthRouteService,
  readOnly = false,
): {
  read: onRequestAsyncHookHandler;
  mutate: onRequestAsyncHookHandler;
  actor(request: FastifyRequest): { issuer: string; subject: string };
} {
  const sessions = new WeakMap<FastifyRequest, OperatorSession>();
  const hook =
    (mutation: boolean): onRequestAsyncHookHandler =>
    async (request, reply) => {
      reply
        .header("cache-control", "private, no-store")
        .header("vary", "Cookie")
        .header("referrer-policy", "no-referrer");
      if (mutation) {
        const origins: string[] = [];
        for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
          if (request.raw.rawHeaders[index]?.toLowerCase() === "origin")
            origins.push(request.raw.rawHeaders[index + 1] ?? "");
        }
        if (origins.length !== 1 || origins[0] !== operatorAuth.publicOrigin) {
          return sendConfigurationError(
            reply,
            new ConfigurationHttpError(
              403,
              "invalid_operator_auth_origin",
              "The request origin is not authorized for this operator action.",
            ),
          );
        }
      }
      const session = await readOperatorSession(request, operatorAuth);
      if (session === null)
        return sendConfigurationError(
          reply,
          new ConfigurationHttpError(
            401,
            "operator_authentication_required",
            "An authenticated operator session is required.",
          ),
        );
      if (mutation && readOnly)
        return sendConfigurationError(
          reply,
          new ConfigurationHttpError(
            503,
            "configuration_read_only",
            "Configuration changes are unavailable during recovery maintenance.",
          ),
        );
      sessions.set(request, session);
    };
  return {
    read: hook(false),
    mutate: hook(true),
    actor(request) {
      const session = sessions.get(request);
      if (!session) throw new Error("Configuration authorization did not establish a session.");
      return { issuer: session.issuer, subject: session.subject };
    },
  };
}
