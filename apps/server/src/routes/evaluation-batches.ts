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

const repository = "/api/v1/operator/repositories/:repositoryId";
export const EVALUATION_BATCH_PATHS = Object.freeze({
  batches: `${repository}/evaluations`,
  batch: `${repository}/evaluations/:evaluationId`,
  matrix: `${repository}/evaluations/:evaluationId/matrix`,
  result: `${repository}/evaluations/:evaluationId/cells/:cellId/results/:resultId`,
  cancel: `${repository}/evaluations/:evaluationId/cancel`,
  promptOptions: `${repository}/evaluation-prompt-options`,
});

export interface EvaluationBatchRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  /** Limits HTTP mutations to exact receipt replays even when the owner is in normal mode. */
  readonly readOnly?: boolean;
}

function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_request_invalid",
    "The evaluation request is invalid.",
  );
}
function check(condition: boolean): void {
  if (!condition)
    throw new ConfigurationHttpError(
      502,
      "evaluation_response_invalid",
      "The evaluation response could not be validated.",
    );
}
function entityId(raw: unknown): string {
  const value = configurationEntityId(raw);
  if (value.trim() !== value) invalid();
  return value;
}
function parameter(request: FastifyRequest, name: string): string {
  return entityId((request.params as Record<string, unknown>)[name]);
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
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DatabaseRequestError && error.code === "DATABASE_READ_ONLY") {
    return sendConfigurationError(
      reply,
      new ConfigurationHttpError(
        503,
        "configuration_read_only",
        "New evaluation changes are unavailable during recovery maintenance.",
      ),
    );
  }
  return sendConfigurationError(reply, error);
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
function listQuery(request: FastifyRequest): C.EvaluationBatchListQuery {
  const query = configurationQuery(request.query, ["page", "pageSize", "suiteId", "workflowKind"]);
  const value = {
    ...pageQuery(query),
    ...(query.suiteId === undefined ? {} : { suiteId: entityId(query.suiteId) }),
    ...(query.workflowKind === undefined ? {} : { workflowKind: query.workflowKind }),
  };
  if (C.getEvaluationBatchListQueryIssues(value).length) invalid();
  return value as C.EvaluationBatchListQuery;
}
function promptQuery(request: FastifyRequest): C.EvaluationPromptOptionsQuery {
  const query = configurationQuery(request.query, ["page", "pageSize", "workflowKind"]);
  const value = { ...pageQuery(query), workflowKind: query.workflowKind };
  if (C.getEvaluationPromptOptionsQueryIssues(value).length) invalid();
  return value as C.EvaluationPromptOptionsQuery;
}

export function registerEvaluationBatchRoutes(
  app: FastifyInstance,
  dependencies: EvaluationBatchRouteDependencies,
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
  const scope = (request: FastifyRequest) => ({
    repositoryId: parameter(request, "repositoryId"),
    actor: authorization.actor(request),
  });
  const batchScope = (request: FastifyRequest) => ({
    ...scope(request),
    evaluationId: parameter(request, "evaluationId"),
  });
  const readOptions = { onRequest: authorize(false) };
  const mutationOptions = {
    onRequest: authorize(true),
    bodyLimit: C.maximumEvaluationBatchRequestUtf8Bytes,
  };

  app.post(EVALUATION_BATCH_PATHS.batches, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...scope(request),
        ...replayRestriction,
        request: body(
          C.EvaluationBatchCreateRequestSchema,
          request.body,
          C.getEvaluationBatchCreateRequestIssues,
        ),
      };
      const value = response(
        C.EvaluationBatchSummaryV1Schema,
        await bound(request).request("createEvaluationBatch", input),
        C.getEvaluationBatchSummaryIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.request.suiteId &&
          value.suiteVersionId === input.request.suiteVersionId &&
          value.mode === input.request.mode &&
          value.baseline.profileVersionId === input.request.baseline.profileVersionId &&
          value.baseline.promptVersionId === input.request.baseline.promptVersionId &&
          value.candidate.profileVersionId === input.request.candidate.profileVersionId &&
          value.candidate.promptVersionId === input.request.candidate.promptVersionId &&
          sameActor(value.createdBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    EVALUATION_BATCH_PATHS.cancel,
    { ...mutationOptions, bodyLimit: 16 * 1024 },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const input = {
          ...batchScope(request),
          ...replayRestriction,
          request: body(
            C.EvaluationBatchCancelRequestSchema,
            request.body,
            C.getEvaluationBatchCancelRequestIssues,
          ),
        };
        const value = response(
          C.EvaluationBatchCancellationV1Schema,
          await bound(request).request("cancelEvaluationBatch", input),
          C.getEvaluationBatchCancellationIssues,
        );
        check(
          value.repositoryId === input.repositoryId &&
            value.evaluationId === input.evaluationId &&
            value.version === input.request.expectedVersion + 1 &&
            value.reason === input.request.reason &&
            sameActor(value.cancelledBy, input.actor),
        );
        return reply.send(value);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(EVALUATION_BATCH_PATHS.batches, readOptions, async (request, reply) => {
    try {
      const input = { ...scope(request), query: listQuery(request) };
      const value = response(
        C.EvaluationBatchListV1Schema,
        await bound(request).request("listEvaluationBatches", input),
        C.getEvaluationBatchListIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.page === input.query.page &&
          value.pageSize === input.query.pageSize &&
          value.items.every(
            (item) =>
              (input.query.suiteId === undefined || item.summary.suiteId === input.query.suiteId) &&
              (input.query.workflowKind === undefined ||
                item.summary.workflowKind === input.query.workflowKind),
          ),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_BATCH_PATHS.batch, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = batchScope(request);
      const value = response(
        C.EvaluationBatchDetailV1Schema,
        await bound(request).request("getEvaluationBatch", input),
        C.getEvaluationBatchDetailIssues,
      );
      check(
        value.summary.repositoryId === input.repositoryId &&
          value.summary.id === input.evaluationId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_BATCH_PATHS.matrix, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = batchScope(request);
      const value = response(
        C.EvaluationBatchMatrixV1Schema,
        await bound(request).request("getEvaluationBatchMatrix", input),
        C.getEvaluationBatchMatrixIssues,
      );
      check(value.repositoryId === input.repositoryId && value.evaluationId === input.evaluationId);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_BATCH_PATHS.result, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...batchScope(request),
        cellId: parameter(request, "cellId"),
        resultId: parameter(request, "resultId"),
      };
      const value = response(
        C.EvaluationCellResultV1Schema,
        await bound(request).request("getEvaluationCellResult", input),
        C.getEvaluationCellResultIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.evaluationId === input.evaluationId &&
          value.cellId === input.cellId &&
          value.resultId === input.resultId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_BATCH_PATHS.promptOptions, readOptions, async (request, reply) => {
    try {
      const input = { ...scope(request), query: promptQuery(request) };
      // The independent operator rule and owner handler require configure permission for this GET.
      const value = response(
        C.EvaluationPromptOptionsV1Schema,
        await bound(request).request("listEvaluationPromptOptions", input),
        C.getEvaluationPromptOptionsIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.workflowKind === input.query.workflowKind &&
          value.page === input.query.page &&
          value.pageSize === input.query.pageSize &&
          value.items.every(
            (item) =>
              item.outputSchemaVersion === C.WorkflowOutputSchemaVersions[input.query.workflowKind],
          ),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
