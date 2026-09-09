import * as C from "@agentic-review/contracts";
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
  validateConfigurationResponse,
} from "./configuration-support.js";

export const NOTIFICATION_PATHS = Object.freeze({
  overview: "/api/v1/operator/notifications/overview",
  summary: "/api/v1/operator/notifications/summary",
  list: "/api/v1/operator/repositories/:repositoryId/notifications",
  state: "/api/v1/operator/repositories/:repositoryId/notifications/state",
});

export interface NotificationRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}

function invalidQuery(): never {
  throw new ConfigurationHttpError(
    400,
    "notification_request_invalid",
    "The notification request is invalid.",
  );
}
function entity(value: unknown): string {
  const id = configurationEntityId(value);
  if (!Value.Check(C.NotificationIdSchema, id)) invalidQuery();
  return id;
}
function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*(?![\s\S])/u.test(value)) invalidQuery();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) invalidQuery();
  return number;
}
function validated<T extends TSchema>(
  schema: T,
  raw: unknown,
  issues: (value: Static<T>) => readonly string[],
): Static<T> {
  const value = validateConfigurationResponse(schema, raw);
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > C.maximumNotificationResponseUtf8Bytes ||
    issues(value).length !== 0
  )
    throw new ConfigurationHttpError(
      502,
      "notification_response_invalid",
      "The notification response could not be validated.",
    );
  return value;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: NotificationRouteDependencies,
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
    repositoryId: entity((request.params as Record<string, unknown>).repositoryId),
    actor: authorization.actor(request),
  });

  app.get(NOTIFICATION_PATHS.overview, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const raw = configurationQuery(request.query, ["page", "pageSize"]);
      const query = {
        page: integer(raw.page, 1, 10_000_000),
        pageSize: integer(
          raw.pageSize,
          C.defaultNotificationPageSize,
          C.maximumNotificationPageSize,
        ),
      };
      const actor = authorization.actor(request);
      const value = await bound(request).request("listNotificationOverview", { actor, ...query });
      return reply.send(
        validated(C.NotificationOverviewSchema, value, (entry) =>
          C.getNotificationOverviewIssues(entry, { actor, query }),
        ),
      );
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(NOTIFICATION_PATHS.summary, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const query = configurationQuery(request.query, ["repositoryId"]);
      const repositoryId =
        query.repositoryId === undefined ? undefined : entity(query.repositoryId);
      const actor = authorization.actor(request);
      const value = await bound(request).request("getNotificationSummary", {
        actor,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      });
      return reply.send(
        validated(C.NotificationSummarySchema, value, (entry) =>
          C.getNotificationSummaryIssues(entry, { actor, repositoryId: repositoryId ?? null }),
        ),
      );
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.get(NOTIFICATION_PATHS.list, { onRequest: authorize(false) }, async (request, reply) => {
    try {
      const raw = configurationQuery(request.query, ["cursor", "limit", "state", "workItemKind"]);
      const query = {
        ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
        limit: integer(raw.limit, C.defaultNotificationPageSize, C.maximumNotificationPageSize),
        state: raw.state ?? "all",
        workItemKind: raw.workItemKind ?? "all",
      };
      if (
        !Value.Check(C.NotificationListQuerySchema, query) ||
        C.getNotificationListQueryIssues(query).length !== 0
      )
        invalidQuery();
      const input = { ...scope(request), query };
      const value = await bound(request).request("listRepositoryNotifications", input);
      return reply.send(
        validated(C.NotificationListSchema, value, (entry) =>
          C.getNotificationListIssues(entry, input),
        ),
      );
    } catch (error) {
      return sendConfigurationError(reply, error);
    }
  });

  app.post(
    NOTIFICATION_PATHS.state,
    { onRequest: authorize(true), bodyLimit: C.maximumNotificationRequestUtf8Bytes },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const input = {
          ...scope(request),
          request: parseConfigurationBody(C.NotificationStateChangeRequestSchema, request.body),
        };
        if (C.getNotificationStateChangeRequestIssues(input.request).length !== 0) invalidQuery();
        const value = await bound(request).request("changeNotificationStates", input);
        return reply.send(
          validated(C.NotificationStateChangeSchema, value, (entry) =>
            C.getNotificationStateChangeIssues(entry, input.request, input),
          ),
        );
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    },
  );
}
