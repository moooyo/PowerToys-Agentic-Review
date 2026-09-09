import * as C from "@agentic-review/contracts";
import {
  evaluationReproductionCellRecordDigest,
  evaluationReproductionSourceDefinitionDigest,
} from "@agentic-review/domain";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
} from "./configuration-support.js";

const repository = "/api/v1/operator/repositories/:repositoryId";
export const EVALUATION_REPRODUCTION_PATHS = Object.freeze({
  source: `${repository}/evaluation-sources/:sourceId/reproduction`,
  plan: `${repository}/evaluations/:evaluationId/reproduction`,
  cell: `${repository}/evaluations/:evaluationId/cells/:cellId/reproduction`,
  preview: `${repository}/evaluation-reproduction/preview`,
});

export interface EvaluationReproductionRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
}

function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_reproduction_request_invalid",
    "The evaluation reproduction request is invalid.",
  );
}
function check(condition: boolean): void {
  if (!condition)
    throw new ConfigurationHttpError(
      502,
      "evaluation_reproduction_response_invalid",
      "The evaluation reproduction response could not be validated.",
    );
}
function parameter(request: FastifyRequest, name: string): string {
  const value = configurationEntityId((request.params as Record<string, unknown>)[name]);
  if (value.trim() !== value) invalid();
  return value;
}
function noQuery(request: FastifyRequest): void {
  configurationQuery(request.query, []);
}
function response<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  check(Value.Check(schema, raw) && issues(raw).length === 0);
  return raw as Static<T>;
}
function matchingDigest(compute: () => string, expected: string | null): void {
  let actual: string;
  try {
    actual = compute();
  } catch {
    check(false);
    return;
  }
  check(actual === expected);
}

/** All operations are read-only. POST preview retains session and exact Origin checks. */
export function registerEvaluationReproductionRoutes(
  app: FastifyInstance,
  dependencies: EvaluationReproductionRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
  const authorize =
    (post: boolean): onRequestAsyncHookHandler =>
    async (request, reply) => {
      try {
        return await (post ? authorization.mutate : authorization.read).call(app, request, reply);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    };
  const bound = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const scope = (request: FastifyRequest) => ({
    repositoryId: parameter(request, "repositoryId"),
    actor: authorization.actor(request),
  });
  const read = { onRequest: authorize(false) };

  app.get(EVALUATION_REPRODUCTION_PATHS.source, read, async (request, reply) => {
    try {
      noQuery(request);
      const input = { ...scope(request), sourceId: parameter(request, "sourceId") };
      const value = response(
        C.EvaluationReproductionSourceDefinitionReadV1Schema,
        await bound(request).request("getEvaluationSourceReproduction", input),
        C.getEvaluationReproductionSourceDefinitionReadIssues,
      );
      check(value.repositoryId === input.repositoryId && value.sourceId === input.sourceId);
      if (value.sourceDefinition !== null) {
        const definition = value.sourceDefinition;
        matchingDigest(
          () => evaluationReproductionSourceDefinitionDigest(definition),
          value.sourceDefinitionSha256,
        );
      }
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(EVALUATION_REPRODUCTION_PATHS.plan, read, async (request, reply) => {
    try {
      noQuery(request);
      const input = { ...scope(request), evaluationId: parameter(request, "evaluationId") };
      const value = response(
        C.EvaluationReproductionPlanV1Schema,
        await bound(request).request("getEvaluationReproductionPlan", input),
        C.getEvaluationReproductionPlanIssues,
      );
      check(value.repositoryId === input.repositoryId && value.evaluationId === input.evaluationId);
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(EVALUATION_REPRODUCTION_PATHS.cell, read, async (request, reply) => {
    try {
      noQuery(request);
      const input = {
        ...scope(request),
        evaluationId: parameter(request, "evaluationId"),
        cellId: parameter(request, "cellId"),
      };
      const value = response(
        C.EvaluationReproductionCellDetailV1Schema,
        await bound(request).request("getEvaluationReproductionCell", input),
        C.getEvaluationReproductionCellDetailIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.evaluationId === input.evaluationId &&
          value.cellId === input.cellId,
      );
      matchingDigest(
        () => evaluationReproductionCellRecordDigest(value.record),
        value.cellRecordSha256,
      );
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.post(
    EVALUATION_REPRODUCTION_PATHS.preview,
    {
      onRequest: authorize(true),
      bodyLimit: C.maximumEvaluationReproductionRequestUtf8Bytes,
    },
    async (request, reply) => {
      try {
        noQuery(request);
        const selected = parseConfigurationBody(
          C.EvaluationReproductionPreviewRequestSchema,
          request.body,
        );
        if (C.getEvaluationReproductionPreviewRequestIssues(selected).length > 0) invalid();
        const input = { ...scope(request), request: selected };
        const value = response(
          C.EvaluationReproductionPreviewV1Schema,
          await bound(request).request("previewEvaluationReproduction", input),
          C.getEvaluationReproductionPreviewIssues,
        );
        check(
          value.repositoryId === input.repositoryId &&
            value.sourceId === selected.sourceId &&
            value.baseline.profileVersionId === selected.baselineProfileVersionId &&
            value.candidate.profileVersionId === selected.candidateProfileVersionId,
        );
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
