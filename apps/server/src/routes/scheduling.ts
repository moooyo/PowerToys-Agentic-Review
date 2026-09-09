import {
  getSchedulingDiagnosticsIssues,
  maximumSchedulingDiagnosticsResponseUtf8Bytes,
  SchedulingDiagnosticsSchema,
} from "@agentic-review/contracts";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  sendConfigurationError,
  validateConfigurationResponse,
} from "./configuration-support.js";

const repositoryPath = "/api/v1/operator/repositories/:repositoryId";
export const SCHEDULING_PATHS = {
  repositoryJob: `${repositoryPath}/jobs/:jobId/scheduling`,
  validationRequest: `${repositoryPath}/review-runs/:reviewRunId/requests/:requestId/scheduling`,
  platformJob: "/api/v1/operator/scheduling/jobs/:jobId",
} as const;

export interface SchedulingRouteDependencies {
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
    "The scheduling observation could not be validated.",
  );
}

function validateResponse(value: unknown) {
  if (value === null)
    throw new ConfigurationHttpError(
      404,
      "platform_not_found",
      "The requested resource was not found.",
    );
  const result = validateConfigurationResponse(SchedulingDiagnosticsSchema, value);
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
      maximumSchedulingDiagnosticsResponseUtf8Bytes ||
    getSchedulingDiagnosticsIssues(result).length !== 0
  )
    invalidResponse();
  return result;
}

export function registerSchedulingRoutes(
  app: FastifyInstance,
  dependencies: SchedulingRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const authorize: onRequestAsyncHookHandler = async (request, reply) => {
    try {
      return await authorization.read.call(app, request, reply);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  };
  const databaseFor = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));

  app.get(SCHEDULING_PATHS.repositoryJob, { onRequest: authorize }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const repositoryId = parameter(request, "repositoryId");
      const jobId = parameter(request, "jobId");
      const value = validateResponse(
        await databaseFor(request).request("getRepositoryJobScheduling", { repositoryId, jobId }),
      );
      if (
        value.subject.kind !== "repository_job" ||
        value.subject.repositoryId !== repositoryId ||
        value.subject.jobId !== jobId
      )
        invalidResponse();
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(SCHEDULING_PATHS.validationRequest, { onRequest: authorize }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const scope = {
        repositoryId: parameter(request, "repositoryId"),
        reviewRunId: parameter(request, "reviewRunId"),
        requestId: parameter(request, "requestId"),
      };
      const value = validateResponse(
        await databaseFor(request).request("getValidationRequestScheduling", scope),
      );
      if (
        value.subject.kind !== "validation_request" ||
        value.subject.repositoryId !== scope.repositoryId ||
        value.subject.reviewRunId !== scope.reviewRunId ||
        value.subject.requestId !== scope.requestId
      )
        invalidResponse();
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(SCHEDULING_PATHS.platformJob, { onRequest: authorize }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const jobId = parameter(request, "jobId");
      const value = validateResponse(
        await databaseFor(request).request("getPlatformJobScheduling", { jobId }),
      );
      if (
        (value.subject.kind !== "platform_job" && value.subject.kind !== "repository_job") ||
        value.subject.jobId !== jobId ||
        value.policy.platform.visibility !== "full"
      )
        invalidResponse();
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
}
