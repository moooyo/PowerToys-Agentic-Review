import {
  DashboardReviewRunDetailSchema,
  DashboardReviewRunJobListResponseSchema,
  DashboardReviewRunListResponseSchema,
  DashboardReviewRunReproductionCaseResponseSchema,
  DashboardReviewRunResultSchema,
  EntityIdSchema,
  maximumDashboardReproductionCaseResponseUtf8Bytes,
  maximumIssueReproductionRequestUtf8Bytes,
  OperatorReviewRunCreateRequestSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  sendConfigurationResponse,
} from "./configuration-support.js";

const repositoryPath = "/api/v1/operator/repositories/:repositoryId";
export const REVIEW_RUN_PATHS = {
  list: `${repositoryPath}/review-runs`,
  create: `${repositoryPath}/work-items/:workItemId/review-runs`,
  detail: `${repositoryPath}/review-runs/:reviewRunId`,
  jobs: `${repositoryPath}/review-runs/:reviewRunId/requests/:requestId/jobs`,
  result: `${repositoryPath}/review-runs/:reviewRunId/requests/:requestId/jobs/:jobId/result`,
  reproductionCase: `${repositoryPath}/review-runs/:reviewRunId/requests/:requestId/reproduction-cases/:caseId`,
} as const;

interface ReviewRunRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

function parameter(request: FastifyRequest, name: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[name]);
}

function requiredResult<T>(result: T | null): T {
  if (result === null)
    throw new ConfigurationHttpError(
      404,
      "review_run_not_found",
      "The selected run or result was not found in this repository.",
    );
  return result;
}

function scoped(schema: TSchema, scope: Record<string, string>): TSchema {
  return Type.Intersect([
    schema,
    Type.Object(
      Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, Type.Literal(value)])),
    ),
  ]);
}

export function registerReviewRunRoutes(
  app: FastifyInstance,
  dependencies: ReviewRunRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const register = (
    method: "GET" | "POST",
    url: string,
    queryKeys: readonly string[],
    handle: (
      request: FastifyRequest,
      query: Record<string, string>,
      database: Pick<DatabaseClient, "request">,
    ) => Promise<{ value: unknown; schema: TSchema }>,
  ) => {
    app.route({
      method,
      url,
      bodyLimit:
        method === "POST" && url === REVIEW_RUN_PATHS.create
          ? maximumIssueReproductionRequestUtf8Bytes
          : 16_384,
      onRequest: method === "GET" ? authorization.read : authorization.mutate,
      handler: async (request, reply) => {
        try {
          const result = await handle(
            request,
            configurationQuery(request.query, queryKeys),
            bindOperatorDatabase(dependencies.database, authorization.actor(request)),
          );
          return sendConfigurationResponse(
            reply.code(method === "POST" ? 201 : 200),
            result.schema,
            result.value,
          );
        } catch (error) {
          return sendConfigurationError(reply, error);
        }
      },
    });
  };
  register(
    "GET",
    REVIEW_RUN_PATHS.reproductionCase,
    ["jobId"],
    async (request, query, database) => {
      const scope = {
        repositoryId: parameter(request, "repositoryId"),
        reviewRunId: parameter(request, "reviewRunId"),
        requestId: parameter(request, "requestId"),
        caseId: parameter(request, "caseId"),
        ...(query.jobId === undefined ? {} : { jobId: configurationEntityId(query.jobId) }),
      };
      const value = requiredResult(
        await database.request("getDashboardReviewRunReproductionCase", scope),
      );
      if (
        !Value.Check(DashboardReviewRunReproductionCaseResponseSchema, value) ||
        Buffer.byteLength(JSON.stringify(value), "utf8") >
          maximumDashboardReproductionCaseResponseUtf8Bytes ||
        value.binding.repositoryId !== scope.repositoryId ||
        value.case.id !== scope.caseId ||
        value.case.requestId !== scope.requestId ||
        [value.current, ...(value.recorded === null ? [] : [value.recorded])].some(
          (assessment) =>
            assessment.caseId !== scope.caseId ||
            assessment.requestId !== scope.requestId ||
            assessment.profileVersionId !== value.case.profileVersionId ||
            assessment.target !== value.case.target,
        ) ||
        (value.resultId === null) !== (value.recorded === null) ||
        (value.resultId !== null && value.jobId === null)
      )
        throw new ConfigurationHttpError(
          502,
          "reproduction_response_invalid",
          "The server returned inconsistent reproduction evidence.",
        );
      return { value, schema: scoped(DashboardReviewRunReproductionCaseResponseSchema, scope) };
    },
  );
  register(
    "GET",
    REVIEW_RUN_PATHS.list,
    ["page", "pageSize", "workItemId"],
    async (request, query, database) => {
      const repositoryId = parameter(request, "repositoryId");
      const pagination = configurationPagination(query);
      const workItemId =
        query.workItemId === undefined ? undefined : configurationEntityId(query.workItemId);
      const value = await database.request("listDashboardReviewRuns", {
        repositoryId,
        ...pagination,
        ...(workItemId === undefined ? {} : { workItemId }),
      });
      const scope = { repositoryId, ...(workItemId === undefined ? {} : { workItemId }) };
      const schema = Type.Intersect([
        DashboardReviewRunListResponseSchema,
        Type.Object({
          page: Type.Literal(pagination.page),
          pageSize: Type.Literal(pagination.pageSize),
          items: Type.Array(
            Type.Object(
              Object.fromEntries(
                Object.entries(scope).map(([key, entry]) => [key, Type.Literal(entry)]),
              ),
            ),
            { maxItems: pagination.pageSize },
          ),
        }),
      ]);
      return { value, schema };
    },
  );
  register("POST", REVIEW_RUN_PATHS.create, [], async (request, _query, database) => {
    const repositoryId = parameter(request, "repositoryId");
    const workItemId = parameter(request, "workItemId");
    const input = parseConfigurationBody(OperatorReviewRunCreateRequestSchema, request.body);
    const run = await database.request("createOperatorReviewRun", {
      repositoryId,
      workItemId,
      request: input,
      actor: authorization.actor(request),
    });
    if (
      !run ||
      !Value.Check(EntityIdSchema, run.id) ||
      run.repositoryId !== repositoryId ||
      run.workItemId !== workItemId ||
      run.activationId !== input.activationId
    ) {
      throw new ConfigurationHttpError(
        502,
        "review_run_response_invalid",
        "The server returned an inconsistent run identity.",
      );
    }
    const value = requiredResult(
      await database.request("getDashboardReviewRun", {
        repositoryId,
        workItemId,
        reviewRunId: run.id,
      }),
    );
    return {
      value,
      schema: scoped(DashboardReviewRunDetailSchema, { repositoryId, workItemId, id: run.id }),
    };
  });
  register("GET", REVIEW_RUN_PATHS.detail, ["workItemId"], async (request, query, database) => {
    const repositoryId = parameter(request, "repositoryId");
    const reviewRunId = parameter(request, "reviewRunId");
    const workItemId =
      query.workItemId === undefined ? undefined : configurationEntityId(query.workItemId);
    const value = requiredResult(
      await database.request("getDashboardReviewRun", {
        repositoryId,
        reviewRunId,
        ...(workItemId === undefined ? {} : { workItemId }),
      }),
    );
    return {
      value,
      schema: scoped(DashboardReviewRunDetailSchema, {
        repositoryId,
        id: reviewRunId,
        ...(workItemId === undefined ? {} : { workItemId }),
      }),
    };
  });
  register(
    "GET",
    REVIEW_RUN_PATHS.jobs,
    ["page", "pageSize", "jobId"],
    async (request, query, database) => {
      const repositoryId = parameter(request, "repositoryId");
      const reviewRunId = parameter(request, "reviewRunId");
      const requestId = parameter(request, "requestId");
      const jobId = query.jobId === undefined ? undefined : configurationEntityId(query.jobId);
      const pagination = configurationPagination(query);
      const value = requiredResult(
        await database.request("listDashboardReviewRunJobs", {
          repositoryId,
          reviewRunId,
          requestId,
          ...(jobId === undefined ? {} : { jobId }),
          ...pagination,
        }),
      );
      return {
        value,
        schema: Type.Intersect([
          DashboardReviewRunJobListResponseSchema,
          Type.Object({
            repositoryId: Type.Literal(repositoryId),
            reviewRunId: Type.Literal(reviewRunId),
            requestId: Type.Literal(requestId),
            page: Type.Literal(pagination.page),
            pageSize: Type.Literal(pagination.pageSize),
            items: Type.Array(
              jobId === undefined ? Type.Unknown() : Type.Object({ jobId: Type.Literal(jobId) }),
              { maxItems: jobId === undefined ? pagination.pageSize : 1 },
            ),
            ...(jobId === undefined ? {} : { total: Type.Integer({ minimum: 0, maximum: 1 }) }),
          }),
        ]),
      };
    },
  );
  register("GET", REVIEW_RUN_PATHS.result, [], async (request, _query, database) => {
    const scope = {
      repositoryId: parameter(request, "repositoryId"),
      reviewRunId: parameter(request, "reviewRunId"),
      requestId: parameter(request, "requestId"),
      jobId: parameter(request, "jobId"),
    };
    const value = requiredResult(await database.request("getDashboardReviewRunJobResult", scope));
    return { value, schema: scoped(DashboardReviewRunResultSchema, scope) };
  });
}
