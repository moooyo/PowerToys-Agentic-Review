import {
  type ConfigurationAuditEvent,
  ConfigurationAuditEventSchema,
  ConfigurationAuditSourceSchema,
  type ConfigurationAuditSummary,
  GlobalConfigurationAuditListQuerySchema,
  GlobalConfigurationAuditListResponseSchema,
  maximumConfigurationAuditPageSize,
  maximumConfigurationAuditResponseUtf8Bytes,
  RepositoryConfigurationAuditListQuerySchema,
  RepositoryConfigurationAuditListResponseSchema,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
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

const prefix = "/api/v1/operator";
export const CONFIGURATION_AUDIT_PATHS = {
  repository: `${prefix}/repositories/:repositoryId/configuration-audit`,
  repositoryEvent: `${prefix}/repositories/:repositoryId/configuration-audit/:source/:eventId`,
  global: `${prefix}/configuration-audit`,
  globalEvent: `${prefix}/configuration-audit/:eventId`,
} as const;

interface Dependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
}
function parameter(request: FastifyRequest, key: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[key]);
}
function inconsistent(): never {
  throw new ConfigurationHttpError(
    502,
    "configuration_audit_response_invalid",
    "The audit response does not match its requested scope.",
  );
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumConfigurationAuditResponseUtf8Bytes)
    inconsistent();
}
function instant(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    inconsistent();
}
function validateSummary(value: ConfigurationAuditSummary): void {
  instant(value.createdAt);
  for (const part of [value.actor.issuer, value.actor.subject]) {
    if (
      part.trim() !== part ||
      !part.isWellFormed() ||
      [...part].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      )
    )
      inconsistent();
  }
  if (
    (value.source === "repository" && value.entityId !== value.repositoryId) ||
    (value.action === "template_created" && value.version !== 1) ||
    ((value.action === "draft_saved" || value.action === "prompt_published") &&
      value.version < 2) ||
    (value.action === "bootstrap_registered" && !Value.Check(WorkflowKindSchema, value.entityId))
  )
    inconsistent();
}
function validateSnapshot(value: ConfigurationAuditEvent): void {
  validateSummary(value);
  if (value.source === "repository") {
    instant(value.snapshot.createdAt);
    if (
      value.snapshot.id !== value.repositoryId ||
      value.snapshot.version !== value.version ||
      value.snapshot.updatedAt !== value.createdAt ||
      (value.snapshot.reviewerGithubUserId === null) !==
        (value.snapshot.reviewerGithubLogin === null)
    )
      inconsistent();
    return;
  }
  if (value.action === "bootstrap_registered") return;
  if (value.snapshot.version !== value.version) inconsistent();
  switch (value.action) {
    case "draft_saved":
      if (value.snapshot.draftRevision < 2 || value.snapshot.draftRevision > value.version)
        inconsistent();
      break;
    case "prompt_published":
      if (value.snapshot.publishedVersion >= value.version) inconsistent();
      break;
    case "prompt_bound":
    case "profile_bound":
      if ((value.version === 1) !== (value.snapshot.previousVersionId === null)) inconsistent();
      break;
  }
}

export function registerConfigurationAuditRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  for (const [key, path] of Object.entries(CONFIGURATION_AUDIT_PATHS)) {
    app.get(path, { onRequest: authorization.read }, async (request, reply) => {
      try {
        const database = bindOperatorDatabase(dependencies.database, authorization.actor(request));
        const repositoryScope = key === "repository" || key === "repositoryEvent";
        const repositoryId = repositoryScope ? parameter(request, "repositoryId") : undefined;
        const detail = key === "repositoryEvent" || key === "globalEvent";
        const query = configurationQuery(
          request.query,
          detail ? [] : repositoryScope ? ["page", "pageSize"] : ["page", "pageSize", "templateId"],
        );
        if (detail) {
          const eventId = parameter(request, "eventId");
          const source = repositoryScope ? parameter(request, "source") : "prompt";
          if (!Value.Check(ConfigurationAuditSourceSchema, source))
            throw new ConfigurationHttpError(
              400,
              "configuration_query_invalid",
              "The audit source is invalid.",
            );
          const value =
            repositoryId === undefined
              ? await database.request("getGlobalConfigurationAudit", { eventId })
              : await database.request("getRepositoryConfigurationAudit", {
                  repositoryId,
                  source,
                  eventId,
                });
          if (value === null)
            throw new ConfigurationHttpError(
              404,
              "configuration_audit_not_found",
              "The audit event was not found in this scope.",
            );
          if (
            !Value.Check(ConfigurationAuditEventSchema, value) ||
            value.id !== eventId ||
            value.source !== source ||
            value.repositoryId !== (repositoryId ?? null)
          )
            inconsistent();
          bounded(value);
          validateSnapshot(value);
          return sendConfigurationResponse(reply, ConfigurationAuditEventSchema, value);
        }
        const pagination = configurationPagination(query);
        if (pagination.pageSize > maximumConfigurationAuditPageSize || pagination.page > 10_000_000)
          throw new ConfigurationHttpError(
            400,
            "configuration_query_invalid",
            "Audit pagination is outside the supported bounds.",
          );
        const templateId =
          query.templateId === undefined ? undefined : configurationEntityId(query.templateId);
        parseConfigurationBody(
          repositoryId === undefined
            ? GlobalConfigurationAuditListQuerySchema
            : RepositoryConfigurationAuditListQuerySchema,
          {
            ...pagination,
            ...(repositoryId === undefined ? {} : { repositoryId }),
            ...(templateId === undefined ? {} : { templateId }),
          },
        );
        const value =
          repositoryId === undefined
            ? await database.request("listGlobalConfigurationAudit", {
                ...pagination,
                ...(templateId === undefined ? {} : { templateId }),
              })
            : await database.request("listRepositoryConfigurationAudit", {
                repositoryId,
                ...pagination,
              });
        const schema = repositoryScope
          ? RepositoryConfigurationAuditListResponseSchema
          : GlobalConfigurationAuditListResponseSchema;
        if (
          !Value.Check(schema, value) ||
          value.page !== pagination.page ||
          value.pageSize !== pagination.pageSize ||
          value.items.length > pagination.pageSize ||
          (repositoryId !== undefined &&
            (!("repositoryId" in value) || value.repositoryId !== repositoryId)) ||
          (repositoryId === undefined &&
            ("templateId" in value ? value.templateId : undefined) !== templateId) ||
          value.items.some(
            (entry) =>
              entry.repositoryId !== (repositoryId ?? null) ||
              (repositoryId === undefined && entry.source !== "prompt"),
          )
        )
          inconsistent();
        const offset = (pagination.page - 1) * pagination.pageSize;
        if (value.items.length !== Math.min(pagination.pageSize, Math.max(0, value.total - offset)))
          inconsistent();
        const seen = new Set<string>();
        let previous: (typeof value.items)[number] | undefined;
        for (const entry of value.items) {
          validateSummary(entry);
          const identity = JSON.stringify([entry.source, entry.id]);
          if (
            seen.has(identity) ||
            (entry.source === "repository" && entry.entityId !== repositoryId) ||
            (templateId !== undefined &&
              ["template_created", "draft_saved", "prompt_published"].includes(entry.action) &&
              entry.entityId !== templateId)
          )
            inconsistent();
          if (
            previous &&
            (previous.createdAt < entry.createdAt ||
              (previous.createdAt === entry.createdAt &&
                (previous.source > entry.source ||
                  (previous.source === entry.source && previous.id <= entry.id))))
          )
            inconsistent();
          seen.add(identity);
          previous = entry;
        }
        bounded(value);
        return sendConfigurationResponse(reply, schema, value);
      } catch (error) {
        return sendConfigurationError(reply, error);
      }
    });
  }
}
