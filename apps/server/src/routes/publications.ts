import * as C from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
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
  validateConfigurationResponse,
} from "./configuration-support.js";

const repository = "/api/v1/operator/repositories/:repositoryId";
export const PUBLICATION_PATHS = {
  policy: `${repository}/publication-policy`,
  policyActivity: `${repository}/publication-policy/activity`,
  policyEvent: `${repository}/publication-policy/activity/:eventId`,
  preview: `${repository}/review-runs/:reviewRunId/publications/preview`,
  confirm: `${repository}/review-runs/:reviewRunId/publications`,
  list: `${repository}/publications`,
  detail: `${repository}/publications/:publicationId`,
  attempts: `${repository}/publications/:publicationId/attempts`,
  cancel: `${repository}/publications/:publicationId/cancel`,
  retry: `${repository}/publications/:publicationId/retry`,
  reconcile: `${repository}/publications/:publicationId/reconcile`,
} as const;

export interface PublicationRouteDependencies {
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
    "publication_response_invalid",
    "The publication response could not be validated.",
  );
}
function check(condition: boolean): void {
  if (!condition) invalidResponse();
}
function response<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: Static<T>) => readonly string[],
): Static<T> {
  const value = validateConfigurationResponse(schema, raw);
  check(Buffer.byteLength(JSON.stringify(value), "utf8") <= C.maximumPublicationResponseUtf8Bytes);
  check(issues(value).length === 0);
  return value;
}
function checkPayload(payload: C.PublicationPayload | null, digest: string | null): void {
  check(payload === null ? digest === null : sha256(canonicalJson(payload)) === digest);
}
function sameActor(left: C.OperatorPrincipal, right: C.OperatorPrincipal): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}
function pagination(query: Record<string, string>): { page: number; pageSize: number } {
  const value = configurationPagination(query);
  if (value.page > 10_000_000)
    throw new ConfigurationHttpError(
      400,
      "publication_query_invalid",
      "The publication page is outside the supported bounds.",
    );
  return value;
}

export function registerPublicationRoutes(
  app: FastifyInstance,
  dependencies: PublicationRouteDependencies,
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
  const bound = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const scope = (request: FastifyRequest) => ({
    repositoryId: parameter(request, "repositoryId"),
    actor: authorization.actor(request),
  });
  const readScope = (request: FastifyRequest) => ({
    ...scope(request),
    publicationId: parameter(request, "publicationId"),
  });
  const mutationOptions = {
    onRequest: authorize(true),
    bodyLimit: C.maximumPublicationRequestUtf8Bytes,
  };

  app.get(PUBLICATION_PATHS.policy, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = scope(request);
      const value = response(
        C.RepositoryPublicationPolicySchema,
        await bound(request).request("getRepositoryPublicationPolicy", input),
        C.getRepositoryPublicationPolicyIssues,
      );
      check(value.repositoryId === input.repositoryId);
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.patch(PUBLICATION_PATHS.policy, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = {
        ...scope(request),
        ...parseConfigurationBody(C.RepositoryPublicationPolicyUpdateRequestSchema, request.body),
      };
      const value = response(
        C.RepositoryPublicationPolicyUpdateResponseSchema,
        await bound(request).request("updateRepositoryPublicationPolicy", input),
        (entry) => C.getRepositoryPublicationPolicyAuditEventIssues(entry.change),
      );
      check(
        value.change.repositoryId === input.repositoryId &&
          value.change.changeId === input.changeId &&
          value.change.previousVersion === input.expectedVersion &&
          value.change.snapshot.enabled === input.enabled &&
          sameActor(value.change.actor, input.actor),
      );
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.get(
    PUBLICATION_PATHS.policyActivity,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["page", "pageSize"]);
        const input = { ...scope(request), ...pagination(query) };
        const value = response(
          C.RepositoryPublicationPolicyAuditListResponseSchema,
          await bound(request).request("listRepositoryPublicationPolicyAudit", input),
          (entry) => C.getRepositoryPublicationPolicyAuditListIssues(entry, input),
        );
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
  app.get(
    PUBLICATION_PATHS.policyEvent,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const input = { ...scope(request), eventId: parameter(request, "eventId") };
        const value = response(
          C.RepositoryPublicationPolicyAuditEventSchema,
          await bound(request).request("getRepositoryPublicationPolicyAudit", input),
          C.getRepositoryPublicationPolicyAuditEventIssues,
        );
        check(value.repositoryId === input.repositoryId && value.id === input.eventId);
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
  app.get(PUBLICATION_PATHS.preview, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const query = configurationQuery(request.query, ["decisionId"]);
      const input = {
        ...scope(request),
        reviewRunId: parameter(request, "reviewRunId"),
        decisionId: configurationEntityId(query.decisionId),
      };
      const value = response(
        C.PublicationPreviewSchema,
        await bound(request).request("getPublicationPreview", input),
        (entry) => C.getPublicationPreviewIssues(entry, input),
      );
      checkPayload(value.payload, value.payloadSha256);
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.post(PUBLICATION_PATHS.confirm, mutationOptions, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const body = parseConfigurationBody(C.PublicationConfirmRequestSchema, request.body);
      if (C.getPublicationConfirmRequestIssues(body).length)
        throw new ConfigurationHttpError(
          400,
          "publication_request_invalid",
          "The publication confirmation is invalid.",
        );
      const input = { ...scope(request), reviewRunId: parameter(request, "reviewRunId"), ...body };
      const value = response(
        C.PublicationConfirmResponseSchema,
        await bound(request).request("confirmPublication", input),
        (entry) => C.getPublicationIntentIssues(entry.intent, input),
      );
      const intent = value.intent;
      check(
        intent.binding.reviewRunId === input.reviewRunId &&
          sameActor(intent.actor, input.actor) &&
          intent.confirmationChangeId === body.changeId &&
          intent.rendererVersion === body.rendererVersion &&
          intent.publisherGitHubUserId === body.expectedPublisherGitHubUserId &&
          intent.policyVersion === body.expectedPolicyVersion &&
          intent.payloadSha256 === body.expectedPayloadSha256,
      );
      const expected = {
        selectedDecisionId: body.expectedSelectedDecisionId,
        selectedDecisionVersion: body.expectedSelectedDecisionVersion,
        decisionContextVersion: body.expectedDecisionContextVersion,
        revisionKey: body.expectedRevisionKey,
        planDigest: body.expectedPlanDigest,
        resultSetDigest: body.expectedResultSetDigest,
      };
      for (const key of Object.keys(expected) as (keyof typeof expected)[])
        check(intent.binding[key] === expected[key]);
      checkPayload(intent.payload, intent.payloadSha256);
      return reply.code(value.replayed ? 200 : 201).send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.get(PUBLICATION_PATHS.list, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const query = configurationQuery(request.query, [
        "page",
        "pageSize",
        "reviewRunId",
        "status",
      ]);
      const input = {
        ...scope(request),
        ...pagination(query),
        ...(query.reviewRunId === undefined
          ? {}
          : { reviewRunId: configurationEntityId(query.reviewRunId) }),
        ...(query.status === undefined
          ? {}
          : { status: parseConfigurationBody(C.PublicationStatusSchema, query.status) }),
      };
      const value = response(
        C.PublicationListResponseSchema,
        await bound(request).request("listPublications", input),
        (entry) => C.getPublicationListIssues(entry, input),
      );
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.get(PUBLICATION_PATHS.detail, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const input = readScope(request);
      const value = response(
        C.PublicationDetailSchema,
        await bound(request).request("getPublication", input),
        (entry) => C.getPublicationDetailIssues(entry, input),
      );
      checkPayload(value.intent.payload, value.intent.payloadSha256);
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  app.get(PUBLICATION_PATHS.attempts, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const query = configurationQuery(request.query, ["page", "pageSize"]),
        input = { ...readScope(request), ...pagination(query) };
      const value = response(
        C.PublicationAttemptListResponseSchema,
        await bound(request).request("listPublicationAttempts", input),
        (entry) => C.getPublicationAttemptListIssues(entry, input),
      );
      return reply.send(value);
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });
  for (const [action, operation] of [
    ["cancel", "cancelPublication"],
    ["retry", "retryPublication"],
    ["reconcile", "requestPublicationReconciliation"],
  ] as const) {
    app.post(PUBLICATION_PATHS[action], mutationOptions, async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const input = {
          ...readScope(request),
          ...parseConfigurationBody(C.PublicationControlRequestSchema, request.body),
        };
        if (C.getPublicationControlRequestIssues(input).length)
          throw new ConfigurationHttpError(
            400,
            "publication_request_invalid",
            "The publication action is invalid.",
          );
        const value = response(
          C.PublicationControlResponseSchema,
          await bound(request).request(operation, input),
          (entry) => C.getPublicationControlReceiptIssues(entry.change, input),
        );
        check(
          value.change.action === action &&
            value.change.changeId === input.changeId &&
            sameActor(value.change.actor, input.actor) &&
            value.change.previousVersion === input.expectedVersion &&
            value.change.payloadSha256 === input.expectedPayloadSha256,
        );
        return reply.send(value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    });
  }
}
