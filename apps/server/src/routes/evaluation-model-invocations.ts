import * as C from "@agentic-review/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  ConfigurationHttpError,
  configurationEntityId,
  configurationQuery,
  createConfigurationAuthorization,
  sendConfigurationError,
} from "./configuration-support.js";

export const EVALUATION_MODEL_INVOCATIONS_PATH =
  "/api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId/cells/:cellId/model-invocations";
export interface EvaluationModelInvocationRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
}
function invalid(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_invocation_request_invalid",
    "The invocation history request is invalid.",
  );
}
function check(valid: boolean): void {
  if (!valid)
    throw new ConfigurationHttpError(
      502,
      "evaluation_invocation_response_invalid",
      "The invocation history response could not be validated.",
    );
}
function parameter(request: FastifyRequest, name: string): string {
  const id = configurationEntityId((request.params as Record<string, unknown>)[name]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(id)) invalid();
  return id;
}
export function registerEvaluationModelInvocationRoutes(
  app: FastifyInstance,
  dependencies: EvaluationModelInvocationRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(dependencies.operatorAuth);
  app.get(
    EVALUATION_MODEL_INVOCATIONS_PATH,
    { onRequest: authorization.read },
    async (request, reply) => {
      try {
        if (request.body !== undefined) invalid();
        const repositoryId = parameter(request, "repositoryId"),
          evaluationId = parameter(request, "evaluationId"),
          cellId = parameter(request, "cellId");
        const raw = configurationQuery(request.query, ["page", "pageSize"]);
        if (Object.values(raw).some((value) => !/^[1-9][0-9]*(?![\s\S])/u.test(value))) invalid();
        const query = {
          page: raw.page === undefined ? 1 : Number(raw.page),
          pageSize: raw.pageSize === undefined ? 10 : Number(raw.pageSize),
        };
        if (C.getEvaluationCellInvocationListQueryIssues(query).length) invalid();
        const actor = authorization.actor(request);
        const result = await bindOperatorDatabase(dependencies.database, actor).request(
          "listEvaluationCellModelInvocations",
          { repositoryId, evaluationId, cellId, actor, query },
        );
        check(C.getEvaluationCellInvocationListIssues(result).length === 0);
        check(
          result.repositoryId === repositoryId &&
            result.evaluationId === evaluationId &&
            result.cellId === cellId &&
            result.page === query.page &&
            result.pageSize === query.pageSize,
        );
        if (result.expectedRuntimeRegistration)
          check(
            result.expectedRuntimeRegistration.identitySha256 ===
              sha256(canonicalJson(result.expectedRuntimeRegistration.identity)),
          );
        for (const item of result.items) {
          check(item.opening.scopeSha256 === sha256(canonicalJson(item.opening.scope)));
          if (item.observedIdentity !== null)
            check(
              sha256(canonicalJson(item.observedIdentity)) ===
                item.submission?.consistency.observedIdentitySha256,
            );
        }
        return reply.code(200).send(result);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
