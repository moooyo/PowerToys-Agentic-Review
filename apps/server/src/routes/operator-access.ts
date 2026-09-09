import {
  OperatorAccessContextSchema,
  RepositoryAccessAuditListResponseSchema,
  RepositoryAccessAuditSchema,
  RepositoryAccessChangeRequestSchema,
  RepositoryAccessChangeResponseSchema,
  RepositoryAccessGrantSchema,
  RepositoryAccessListResponseSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import type { OperatorAuthRouteService } from "./auth.js";
import {
  configurationEntityId,
  configurationPagination,
  configurationQuery,
  createConfigurationAuthorization,
  parseConfigurationBody,
  sendConfigurationError,
  sendConfigurationResponse,
  validateConfigurationResponse,
} from "./configuration-support.js";

const repositoryPath = "/api/v1/operator/repositories/:repositoryId/access";
export const OPERATOR_ACCESS_PATHS = {
  context: "/api/v1/operator/access",
  grants: repositoryPath,
  changes: repositoryPath,
  history: `${repositoryPath}/history`,
} as const;

export interface OperatorAccessRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

const repositoryId = (request: FastifyRequest): string =>
  configurationEntityId((request.params as Record<string, unknown>).repositoryId);
const scoped = (schema: TSchema, properties: Record<string, TSchema>) =>
  Type.Intersect([schema, Type.Object(properties)]);

export function registerOperatorAccessRoutes(
  app: FastifyInstance,
  dependencies: OperatorAccessRouteDependencies,
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
    OPERATOR_ACCESS_PATHS.context,
    { onRequest: authorize(false) },
    async (request, reply) => {
      try {
        const query = configurationQuery(request.query, ["repositoryId"]);
        const selected =
          query.repositoryId === undefined ? undefined : configurationEntityId(query.repositoryId);
        const actor = authorization.actor(request);
        const result = await databaseFor(request).request("getOperatorAccessContext", {
          actor,
          ...(selected === undefined ? {} : { repositoryId: selected }),
        });
        return sendConfigurationResponse(
          reply,
          scoped(OperatorAccessContextSchema, {
            principal: Type.Object({
              issuer: Type.Literal(actor.issuer),
              subject: Type.Literal(actor.subject),
            }),
            repository:
              selected === undefined
                ? Type.Null()
                : Type.Object({ repositoryId: Type.Literal(selected) }),
          }),
          result,
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );

  for (const history of [false, true]) {
    app.get(
      history ? OPERATOR_ACCESS_PATHS.history : OPERATOR_ACCESS_PATHS.grants,
      { onRequest: authorize(false) },
      async (request, reply) => {
        try {
          const scope = repositoryId(request);
          const query = configurationQuery(request.query, ["page", "pageSize"]);
          const page = configurationPagination(query);
          const input = { repositoryId: scope, actor: authorization.actor(request), ...page };
          const result = history
            ? await databaseFor(request).request("listRepositoryAccessAudit", input)
            : await databaseFor(request).request("listRepositoryAccessGrants", input);
          return sendConfigurationResponse(
            reply,
            scoped(
              history
                ? RepositoryAccessAuditListResponseSchema
                : RepositoryAccessListResponseSchema,
              {
                repositoryId: Type.Literal(scope),
                page: Type.Literal(page.page),
                pageSize: Type.Literal(page.pageSize),
                items: Type.Array(
                  scoped(history ? RepositoryAccessAuditSchema : RepositoryAccessGrantSchema, {
                    repositoryId: Type.Literal(scope),
                  }),
                  { maxItems: page.pageSize },
                ),
              },
            ),
            result,
          );
        } catch (error) {
          return sendConfigurationError(reply, error);
        }
      },
    );
  }

  app.post(
    OPERATOR_ACCESS_PATHS.changes,
    { bodyLimit: 16_384, onRequest: authorize(true) },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const scope = repositoryId(request);
        const input = parseConfigurationBody(RepositoryAccessChangeRequestSchema, request.body);
        const actor = authorization.actor(request);
        const result = validateConfigurationResponse(
          RepositoryAccessChangeResponseSchema,
          await databaseFor(request).request("changeRepositoryAccess", {
            repositoryId: scope,
            actor,
            request: input,
          }),
        );
        return sendConfigurationResponse(
          reply.code(result.replayed ? 200 : 201),
          scoped(RepositoryAccessChangeResponseSchema, {
            change: Type.Object({
              repositoryId: Type.Literal(scope),
              changeId: Type.Literal(input.changeId),
              principal: Type.Object({
                issuer: Type.Literal(input.principal.issuer),
                subject: Type.Literal(input.principal.subject),
              }),
              actor: Type.Object({
                issuer: Type.Literal(actor.issuer),
                subject: Type.Literal(actor.subject),
              }),
              role: input.role === null ? Type.Null() : Type.Literal(input.role),
              previousVersion: Type.Literal(input.expectedVersion),
              version: Type.Literal(input.expectedVersion + 1),
              reason: Type.Literal(input.reason),
            }),
          }),
          result,
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
