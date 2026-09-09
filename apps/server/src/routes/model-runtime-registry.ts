import * as C from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
} from "./configuration-support.js";

export const MODEL_RUNTIME_REGISTRY_PATHS = Object.freeze({
  registrations: "/api/v1/operator/model-runtimes",
  registration: "/api/v1/operator/model-runtimes/:registrationId",
  history: "/api/v1/operator/model-runtimes/:registrationId/history",
  options: "/api/v1/operator/repositories/:repositoryId/evaluation-model-runtime-options",
});
export interface ModelRuntimeRegistryRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  /** Trusted route restriction; the database owner also checks its independent startup mode. */
  readonly readOnly?: boolean;
}
function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "model_runtime_request_invalid",
    "The model runtime registry request is invalid.",
  );
}
function check(condition: boolean): void {
  if (!condition)
    throw new ConfigurationHttpError(
      502,
      "model_runtime_response_invalid",
      "The model runtime registry response could not be validated.",
    );
}
function parameter(request: FastifyRequest, name: string): string {
  const value = configurationEntityId((request.params as Record<string, unknown>)[name]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value)) invalid();
  return value;
}
function body<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  const value = parseConfigurationBody(schema, raw);
  if (issues(value).length) invalid();
  return value;
}
function response<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  check(issues(raw).length === 0 && Value.Check(schema, raw));
  return raw as Static<T>;
}
function sameActor(left: C.OperatorPrincipal, right: C.OperatorPrincipal): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}
function registrationIdentity(registration: C.ModelRuntimeRegistrationV1): void {
  check(registration.identitySha256 === sha256(canonicalJson(registration.identity)));
}
function status(raw: unknown): C.ModelRuntimeStatusV1 {
  const value = response(C.ModelRuntimeStatusV1Schema, raw, C.getModelRuntimeStatusIssues);
  registrationIdentity(value.registration);
  return value;
}
function pageQuery(query: Record<string, string>): { page: number; pageSize: number } {
  const pages: Record<string, string> = {};
  for (const key of ["page", "pageSize"] as const) {
    const value = query[key];
    if (value !== undefined) {
      if (!/^[1-9][0-9]*(?![\s\S])/u.test(value)) invalid();
      pages[key] = value;
    }
  }
  return configurationPagination(pages);
}
function listQuery(request: FastifyRequest): C.ModelRuntimeListQuery {
  const query = configurationQuery(request.query, ["page", "pageSize", "enabled"]);
  if (query.enabled !== undefined && query.enabled !== "true" && query.enabled !== "false")
    invalid();
  const value = {
    ...pageQuery(query),
    ...(query.enabled === undefined ? {} : { enabled: query.enabled === "true" }),
  };
  if (C.getModelRuntimeListQueryIssues(value).length) invalid();
  return value;
}
function readQuery(
  request: FastifyRequest,
  issues: (value: unknown) => readonly string[],
): { page: number; pageSize: number } {
  const value = pageQuery(configurationQuery(request.query, ["page", "pageSize"]));
  if (issues(value).length) invalid();
  return value;
}
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DatabaseRequestError) {
    if (error.code === "DATABASE_READ_ONLY")
      return sendConfigurationError(
        reply,
        new ConfigurationHttpError(
          503,
          "configuration_read_only",
          "New model runtime registry changes are unavailable during recovery maintenance.",
        ),
      );
    if (error.code === "PLATFORM_INVALID" || error.code === "PLATFORM_CONFLICT")
      return sendConfigurationError(
        reply,
        new ConfigurationHttpError(
          error.code === "PLATFORM_INVALID" ? 400 : 409,
          error.code.toLowerCase(),
          error.code === "PLATFORM_INVALID"
            ? "The model runtime registry request is invalid."
            : "The model runtime registry change conflicts with the current state.",
        ),
      );
  }
  return sendConfigurationError(reply, error);
}

/** Global operations require platform administration in the independent operator RPC allowlist. */
export function registerModelRuntimeRegistryRoutes(
  app: FastifyInstance,
  dependencies: ModelRuntimeRegistryRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
  const replayRestriction = dependencies.readOnly === true ? { replayOnly: true as const } : {};
  const authorize =
    (mutation: boolean): onRequestAsyncHookHandler =>
    async (request, reply) => {
      try {
        return await (mutation ? authorization.mutate : authorization.read).call(
          app,
          request,
          reply,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    };
  const bound = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const readOptions = { onRequest: authorize(false) };
  const mutationOptions = {
    onRequest: authorize(true),
    bodyLimit: C.maximumModelRuntimeRegistryRequestUtf8Bytes,
  };

  app.post(MODEL_RUNTIME_REGISTRY_PATHS.registrations, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        actor: authorization.actor(request),
        ...replayRestriction,
        request: body(
          C.ModelRuntimeRegisterRequestSchema,
          request.body,
          C.getModelRuntimeRegisterRequestIssues,
        ),
      };
      const value = status(await bound(request).request("registerModelRuntime", input));
      check(
        value.registration.name === input.request.name &&
          value.registration.requestedModel === input.request.requestedModel &&
          canonicalJson(value.registration.identity) === canonicalJson(input.request.identity) &&
          sameActor(value.registration.createdBy, input.actor) &&
          value.control.version === 1 &&
          value.control.enabled === input.request.enabled &&
          sameActor(value.control.updatedBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.patch(MODEL_RUNTIME_REGISTRY_PATHS.registration, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        actor: authorization.actor(request),
        registrationId: parameter(request, "registrationId"),
        ...replayRestriction,
        request: body(
          C.ModelRuntimeControlRequestSchema,
          request.body,
          C.getModelRuntimeControlRequestIssues,
        ),
      };
      const value = status(await bound(request).request("changeModelRuntimeControl", input));
      check(
        value.registration.id === input.registrationId &&
          value.control.version === input.request.expectedVersion + 1 &&
          value.control.enabled === input.request.enabled &&
          sameActor(value.control.updatedBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(MODEL_RUNTIME_REGISTRY_PATHS.registrations, readOptions, async (request, reply) => {
    try {
      const input = { actor: authorization.actor(request), query: listQuery(request) };
      const value = response(
        C.ModelRuntimeListV1Schema,
        await bound(request).request("listModelRuntimeRegistrations", input),
        C.getModelRuntimeListIssues,
      );
      check(
        value.page === input.query.page &&
          value.pageSize === input.query.pageSize &&
          value.items.every(
            (item) =>
              input.query.enabled === undefined || item.control.enabled === input.query.enabled,
          ),
      );
      for (const item of value.items) registrationIdentity(item.registration);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(MODEL_RUNTIME_REGISTRY_PATHS.registration, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        actor: authorization.actor(request),
        registrationId: parameter(request, "registrationId"),
      };
      const value = status(await bound(request).request("getModelRuntimeRegistration", input));
      check(value.registration.id === input.registrationId);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(MODEL_RUNTIME_REGISTRY_PATHS.history, readOptions, async (request, reply) => {
    try {
      const input = {
        actor: authorization.actor(request),
        registrationId: parameter(request, "registrationId"),
        query: readQuery(request, C.getModelRuntimeHistoryQueryIssues),
      };
      const value = response(
        C.ModelRuntimeHistoryV1Schema,
        await bound(request).request("listModelRuntimeHistory", input),
        C.getModelRuntimeHistoryIssues,
      );
      check(
        value.registrationId === input.registrationId &&
          value.page === input.query.page &&
          value.pageSize === input.query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get(MODEL_RUNTIME_REGISTRY_PATHS.options, readOptions, async (request, reply) => {
    try {
      const input = {
        actor: authorization.actor(request),
        repositoryId: parameter(request, "repositoryId"),
        query: readQuery(request, C.getModelRuntimeOptionsQueryIssues),
      };
      const value = response(
        C.ModelRuntimeOptionsV1Schema,
        await bound(request).request("listEvaluationModelRuntimeOptions", input),
        C.getModelRuntimeOptionsIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.page === input.query.page &&
          value.pageSize === input.query.pageSize,
      );
      for (const registration of value.items) registrationIdentity(registration);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
