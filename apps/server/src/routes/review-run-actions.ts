import {
  OperatorReviewRunCancelRequestSchema,
  OperatorReviewRunCancelResponseSchema,
  OperatorReviewRunRerunRequestSchema,
  OperatorReviewRunRerunResponseSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
  sendConfigurationResponse,
  validateConfigurationResponse,
} from "./configuration-support.js";

const requestPath =
  "/api/v1/operator/repositories/:repositoryId/review-runs/:reviewRunId/requests/:requestId";
export const REVIEW_RUN_ACTION_PATHS = {
  rerun: `${requestPath}/reruns`,
  cancel: `${requestPath}/jobs/:jobId/cancel`,
} as const;

export interface ReviewRunActionRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

function parameter(request: FastifyRequest, name: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[name]);
}

function scoped(schema: TSchema, scope: Record<string, string>): TSchema {
  return Type.Intersect([
    schema,
    Type.Object(
      Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, Type.Literal(value)])),
    ),
  ]);
}

export function registerReviewRunActionRoutes(
  app: FastifyInstance,
  dependencies: ReviewRunActionRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const authorizeMutation: onRequestAsyncHookHandler = async (request, reply) => {
    try {
      return await authorization.mutate.call(app, request, reply);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  };
  app.post(
    REVIEW_RUN_ACTION_PATHS.rerun,
    { bodyLimit: 4_096, onRequest: authorizeMutation },
    async (request, reply) => {
      try {
        const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
        configurationQuery(request.query, []);
        const scope = {
          repositoryId: parameter(request, "repositoryId"),
          reviewRunId: parameter(request, "reviewRunId"),
          requestId: parameter(request, "requestId"),
        };
        const input = parseConfigurationBody(OperatorReviewRunRerunRequestSchema, request.body);
        const value = validateConfigurationResponse(
          OperatorReviewRunRerunResponseSchema,
          await database.request("rerunValidationRequest", {
            ...scope,
            activationId: input.activationId,
            actor: authorization.actor(request),
          }),
        );
        return sendConfigurationResponse(
          reply.code(value.replayed ? 200 : 201),
          scoped(OperatorReviewRunRerunResponseSchema, scope),
          value,
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
  app.post(
    REVIEW_RUN_ACTION_PATHS.cancel,
    { bodyLimit: 4_096, onRequest: authorizeMutation },
    async (request, reply) => {
      try {
        const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
        configurationQuery(request.query, []);
        const scope = {
          repositoryId: parameter(request, "repositoryId"),
          reviewRunId: parameter(request, "reviewRunId"),
          requestId: parameter(request, "requestId"),
          jobId: parameter(request, "jobId"),
        };
        parseConfigurationBody(
          OperatorReviewRunCancelRequestSchema,
          request.body === undefined ? {} : request.body,
        );
        const value = validateConfigurationResponse(
          OperatorReviewRunCancelResponseSchema,
          await database.request("cancelValidationJob", {
            ...scope,
            actor: authorization.actor(request),
          }),
        );
        return sendConfigurationResponse(
          reply.code(value.jobState === "cancel_requested" ? 202 : 200),
          scoped(OperatorReviewRunCancelResponseSchema, scope),
          value,
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
