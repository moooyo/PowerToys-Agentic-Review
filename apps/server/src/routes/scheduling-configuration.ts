import {
  getSchedulingConfigurationAuditEventIssues,
  getSchedulingConfigurationAuditListIssues,
  getSchedulingConfigurationIssues,
  getSchedulingStatusIssues,
  PlatformSchedulingStatusSchema,
  RepositorySchedulingStatusSchema,
  SchedulingConfigurationAuditEventSchema,
  SchedulingConfigurationAuditListQuerySchema,
  SchedulingConfigurationAuditListResponseSchema,
  SchedulingConfigurationSchema,
  SchedulingConfigurationUpdateRequestSchema,
} from "@agentic-review/contracts";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
  validateConfigurationResponse,
} from "./configuration-support.js";

const root = "/api/v1/operator";
export const SCHEDULING_CONFIGURATION_PATHS = {
  repository: `${root}/repositories/:repositoryId/scheduling`,
  platform: `${root}/scheduling`,
  activity: `${root}/scheduling/activity`,
  activityEvent: `${root}/scheduling/activity/:eventId`,
} as const;

export interface SchedulingConfigurationRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}
function parameter(request: FastifyRequest, name: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[name]);
}
function invalidResponse(): never {
  throw new ConfigurationHttpError(
    502,
    "scheduling_response_invalid",
    "The scheduling response could not be validated.",
  );
}
function requireFound<T>(value: T | null): T {
  if (value === null)
    throw new ConfigurationHttpError(
      404,
      "platform_not_found",
      "The requested resource was not found.",
    );
  return value;
}

export function registerSchedulingConfigurationRoutes(
  app: FastifyInstance,
  dependencies: SchedulingConfigurationRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
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
        return sendConfigurationError(reply, error);
      }
    };
  const databaseFor = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));

  app.get(
    SCHEDULING_CONFIGURATION_PATHS.repository,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const repositoryId = parameter(request, "repositoryId");
        const value = validateConfigurationResponse(
          RepositorySchedulingStatusSchema,
          requireFound(
            await databaseFor(request).request("getRepositorySchedulingStatus", { repositoryId }),
          ),
        );
        if (value.repositoryId !== repositoryId || getSchedulingStatusIssues(value).length !== 0)
          invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    SCHEDULING_CONFIGURATION_PATHS.platform,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const value = validateConfigurationResponse(
          PlatformSchedulingStatusSchema,
          await databaseFor(request).request("getPlatformSchedulingStatus", {}),
        );
        if (getSchedulingStatusIssues(value).length !== 0) invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.patch(
    SCHEDULING_CONFIGURATION_PATHS.platform,
    { onRequest: authorize(true) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const body = parseConfigurationBody(
          SchedulingConfigurationUpdateRequestSchema,
          request.body,
        );
        const value = validateConfigurationResponse(
          SchedulingConfigurationSchema,
          await databaseFor(request).request("updatePlatformSchedulingConfiguration", {
            request: body,
            actor: authorization.actor(request),
          }),
        );
        if (
          value.version !== body.expectedVersion + 1 ||
          value.limits.maxActiveLeases !== body.limits.maxActiveLeases ||
          value.limits.maxQueuedJobs !== body.limits.maxQueuedJobs ||
          getSchedulingConfigurationIssues(value).length !== 0
        )
          invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    SCHEDULING_CONFIGURATION_PATHS.activity,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["page", "pageSize"]);
        const pagination = parseConfigurationBody(
          SchedulingConfigurationAuditListQuerySchema,
          configurationPagination(query),
        );
        const value = validateConfigurationResponse(
          SchedulingConfigurationAuditListResponseSchema,
          await databaseFor(request).request(
            "listPlatformSchedulingConfigurationAudit",
            pagination,
          ),
        );
        if (
          value.page !== pagination.page ||
          value.pageSize !== pagination.pageSize ||
          getSchedulingConfigurationAuditListIssues(value).length !== 0
        )
          invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  app.get(
    SCHEDULING_CONFIGURATION_PATHS.activityEvent,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const eventId = parameter(request, "eventId");
        const value = validateConfigurationResponse(
          SchedulingConfigurationAuditEventSchema,
          requireFound(
            await databaseFor(request).request("getPlatformSchedulingConfigurationAudit", {
              eventId,
            }),
          ),
        );
        if (value.id !== eventId || getSchedulingConfigurationAuditEventIssues(value).length !== 0)
          invalidResponse();
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
