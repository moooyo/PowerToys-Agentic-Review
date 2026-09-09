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
export const EVALUATION_MANAGEMENT_PATHS = Object.freeze({
  sources: `${repository}/evaluation-sources`,
  source: `${repository}/evaluation-sources/:sourceId`,
  suites: `${repository}/evaluation-suites`,
  suite: `${repository}/evaluation-suites/:suiteId`,
  draft: `${repository}/evaluation-suites/:suiteId/draft`,
  versions: `${repository}/evaluation-suites/:suiteId/versions`,
  version: `${repository}/evaluation-suites/:suiteId/versions/:versionId`,
  cases: `${repository}/evaluation-suites/:suiteId/versions/:versionId/cases`,
  case: `${repository}/evaluation-suites/:suiteId/versions/:versionId/cases/:caseId`,
});

export interface EvaluationManagementRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  /** Restricts route mutations to exact replays independently of the owner's startup mode. */
  readonly readOnly?: boolean;
}

function parameter(request: FastifyRequest, name: string): string {
  const value = configurationEntityId((request.params as Record<string, unknown>)[name]);
  if (value.trim() !== value) invalidRequest();
  return value;
}

function invalidRequest(): never {
  throw new ConfigurationHttpError(
    400,
    "evaluation_request_invalid",
    "The evaluation management request is invalid.",
  );
}

function check(condition: boolean): void {
  if (!condition) {
    throw new ConfigurationHttpError(
      502,
      "evaluation_response_invalid",
      "The evaluation management response could not be validated.",
    );
  }
}

function body<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  const value = parseConfigurationBody(schema, raw);
  if (issues(value).length > 0) invalidRequest();
  return value;
}

function response<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: unknown) => readonly string[],
): Static<T> {
  // Contract helpers enforce each read model's byte budget, including bounded detail metadata.
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

function pagination(request: FastifyRequest): { page: number; pageSize: number } {
  const query = configurationQuery(request.query, ["page", "pageSize"]);
  if (Object.values(query).some((entry) => !/^[1-9][0-9]*(?![\s\S])/u.test(entry)))
    invalidRequest();
  const value = configurationPagination(query);
  if (C.getEvaluationSuiteListQueryIssues(value).length > 0) invalidRequest();
  return value;
}

export function registerEvaluationManagementRoutes(
  app: FastifyInstance,
  dependencies: EvaluationManagementRouteDependencies,
): void {
  // Retain exact Origin and session checks. The owner checks current configure permission and
  // permits only an exact existing mutation receipt before rejecting new recovery-mode writes.
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
  const suiteScope = (request: FastifyRequest) => ({
    ...scope(request),
    suiteId: parameter(request, "suiteId"),
  });
  const readOptions = { onRequest: authorize(false) };
  const mutationOptions = {
    onRequest: authorize(true),
    bodyLimit: C.maximumEvaluationSuiteUtf8Bytes,
  };

  app.get(EVALUATION_MANAGEMENT_PATHS.sources, readOptions, async (request, reply) => {
    try {
      const query = pagination(request);
      if (C.getEvaluationSourceListQueryIssues(query).length > 0) invalidRequest();
      const input = { ...scope(request), query };
      const value = response(
        C.EvaluationSourceListResponseSchema,
        await bound(request).request("listEvaluationSources", input),
        C.getEvaluationSourceListResponseIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.page === query.page &&
          value.pageSize === query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    EVALUATION_MANAGEMENT_PATHS.sources,
    { ...mutationOptions, bodyLimit: C.maximumEvaluationSourceCaptureRequestUtf8Bytes },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const input = {
          ...scope(request),
          ...replayRestriction,
          request: body(
            C.EvaluationSourceCaptureRequestSchema,
            request.body,
            C.getEvaluationSourceCaptureRequestIssues,
          ),
        };
        const value = response(
          C.EvaluationSourceSummaryV1Schema,
          await bound(request).request("captureEvaluationSource", input),
          C.getEvaluationSourceSummaryIssues,
        );
        check(value.repositoryId === input.repositoryId && sameActor(value.createdBy, input.actor));
        if (input.request.source.kind === "current_work_item") {
          check(
            value.workItemId === input.request.source.workItemId &&
              value.revisionKey === input.request.source.expectedRevisionKey,
          );
        }
        return reply.send(value);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(EVALUATION_MANAGEMENT_PATHS.source, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = { ...scope(request), sourceId: parameter(request, "sourceId") };
      const value = response(
        C.EvaluationSourceDetailV1Schema,
        await bound(request).request("getEvaluationSource", input),
        C.getEvaluationSourceDetailIssues,
      );
      check(value.repositoryId === input.repositoryId && value.id === input.sourceId);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.suites, readOptions, async (request, reply) => {
    try {
      const query = pagination(request);
      const input = { ...scope(request), query };
      const value = response(
        C.EvaluationSuiteListResponseSchema,
        await bound(request).request("listEvaluationSuites", input),
        C.getEvaluationSuiteListResponseIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.page === query.page &&
          value.pageSize === query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(EVALUATION_MANAGEMENT_PATHS.suites, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...scope(request),
        ...replayRestriction,
        request: body(
          C.EvaluationSuiteCreateRequestSchema,
          request.body,
          C.getEvaluationSuiteCreateRequestIssues,
        ),
      };
      const value = response(
        C.EvaluationSuiteSummaryV1Schema,
        await bound(request).request("createEvaluationSuite", input),
        C.getEvaluationSuiteSummaryIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.name === input.request.name &&
          value.description === input.request.description &&
          value.workflowKind === input.request.workflowKind &&
          value.target === input.request.target &&
          value.draftRevision === 1 &&
          value.caseCount === 0 &&
          value.latestVersionId === null &&
          sameActor(value.createdBy, input.actor) &&
          sameActor(value.updatedBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.suite, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = suiteScope(request);
      const value = response(
        C.EvaluationSuiteDetailV1Schema,
        await bound(request).request("getEvaluationSuite", input),
        C.getEvaluationSuiteDetailIssues,
      );
      check(value.repositoryId === input.repositoryId && value.id === input.suiteId);
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(EVALUATION_MANAGEMENT_PATHS.draft, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...suiteScope(request),
        ...replayRestriction,
        request: body(
          C.EvaluationSuiteSaveRequestSchema,
          request.body,
          C.getEvaluationSuiteSaveRequestIssues,
        ),
      };
      const value = response(
        C.EvaluationSuiteSummaryV1Schema,
        await bound(request).request("saveEvaluationSuiteDraft", input),
        C.getEvaluationSuiteSummaryIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.id === input.suiteId &&
          value.draftRevision === input.request.expectedRevision + 1 &&
          value.name === input.request.draft.name &&
          value.description === input.request.draft.description &&
          value.caseCount === input.request.draft.cases.length &&
          sameActor(value.updatedBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.versions, readOptions, async (request, reply) => {
    try {
      const query = pagination(request);
      const input = { ...suiteScope(request), query };
      const value = response(
        C.EvaluationSuiteVersionListResponseSchema,
        await bound(request).request("listEvaluationSuiteVersions", input),
        C.getEvaluationSuiteVersionListResponseIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.suiteId &&
          value.page === query.page &&
          value.pageSize === query.pageSize,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(EVALUATION_MANAGEMENT_PATHS.versions, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...suiteScope(request),
        ...replayRestriction,
        request: body(
          C.EvaluationSuitePublishRequestSchema,
          request.body,
          C.getEvaluationSuitePublishRequestIssues,
        ),
      };
      const value = response(
        C.EvaluationSuiteVersionV1Schema,
        await bound(request).request("publishEvaluationSuite", input),
        C.getEvaluationSuiteVersionIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.suiteId &&
          value.sourceDraftRevision === input.request.expectedRevision &&
          sameActor(value.createdBy, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.version, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = { ...suiteScope(request), versionId: parameter(request, "versionId") };
      const value = response(
        C.EvaluationSuiteVersionV1Schema,
        await bound(request).request("getEvaluationSuiteVersion", input),
        C.getEvaluationSuiteVersionIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.suiteId &&
          value.id === input.versionId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.cases, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = { ...suiteScope(request), versionId: parameter(request, "versionId") };
      const value = response(
        C.EvaluationSuiteCaseListV1Schema,
        await bound(request).request("listEvaluationSuiteCases", input),
        C.getEvaluationSuiteCaseListIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.suiteId &&
          value.versionId === input.versionId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(EVALUATION_MANAGEMENT_PATHS.case, readOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...suiteScope(request),
        versionId: parameter(request, "versionId"),
        caseId: parameter(request, "caseId"),
      };
      const value = response(
        C.EvaluationSuiteCaseDetailV1Schema,
        await bound(request).request("getEvaluationSuiteCase", input),
        C.getEvaluationSuiteCaseDetailIssues,
      );
      check(
        value.repositoryId === input.repositoryId &&
          value.suiteId === input.suiteId &&
          value.versionId === input.versionId &&
          value.caseId === input.caseId,
      );
      return reply.send(value);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
