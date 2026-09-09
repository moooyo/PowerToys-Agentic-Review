import {
  DateTimeSchema,
  EntityIdSchema,
  getValidationProfileConfigIssues,
  maximumPromptContentUtf8Bytes,
  NonNegativeIntegerSchema,
  type OperatorPrincipal,
  PromptBindingSaveRequestSchema,
  PromptBindingSchema,
  PromptDraftPublishRequestSchema,
  PromptDraftSaveRequestSchema,
  type PromptPreviewRequest,
  PromptPreviewRequestSchema,
  type PromptPreviewResponse,
  PromptPreviewResponseSchema,
  PromptTemplateCreateRequestSchema,
  PromptTemplateSchema,
  PromptTemplateSummarySchema,
  PromptVersionSchema,
  PromptVersionSummarySchema,
  RepositoryValidationProfileBindingSaveRequestSchema,
  RepositoryValidationProfileBindingSchema,
  ValidationProfileCreateRequestSchema,
  ValidationProfileVersionSchema,
  ValidationProfileVersionSummarySchema,
  WorkflowKindSchema,
  WorkflowKindValues,
} from "@agentic-review/contracts";
import { type TProperties, type TSchema, Type } from "@sinclair/typebox";
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

const operatorPrefix = "/api/v1/operator";
const repositoryPrefix = `${operatorPrefix}/repositories/:repositoryId`;

export const PROMPT_CONFIGURATION_PATHS = {
  templates: `${operatorPrefix}/prompts`,
  template: `${operatorPrefix}/prompts/:templateId`,
  draft: `${operatorPrefix}/prompts/:templateId/draft`,
  publish: `${operatorPrefix}/prompts/:templateId/publish`,
  versions: `${operatorPrefix}/prompts/:templateId/versions`,
  version: `${operatorPrefix}/prompts/:templateId/versions/:versionId`,
  preview: `${operatorPrefix}/prompts/preview`,
  globalBindings: `${operatorPrefix}/prompt-bindings`,
  globalBinding: `${operatorPrefix}/prompt-bindings/:workflowKind`,
  globalBindingHistory: `${operatorPrefix}/prompt-bindings/:workflowKind/history`,
  repositoryBindings: `${repositoryPrefix}/prompt-bindings`,
  repositoryBinding: `${repositoryPrefix}/prompt-bindings/:workflowKind`,
  repositoryBindingHistory: `${repositoryPrefix}/prompt-bindings/:workflowKind/history`,
  profiles: `${repositoryPrefix}/validation-profiles`,
  profileVersions: `${repositoryPrefix}/validation-profiles/:profileId/versions`,
  profileVersion: `${repositoryPrefix}/validation-profiles/:profileId/versions/:versionId`,
  profileBindings: `${repositoryPrefix}/validation-profile-bindings`,
  profileBinding: `${repositoryPrefix}/validation-profile-bindings/:profileId`,
  profileBindingHistory: `${repositoryPrefix}/validation-profile-bindings/:profileId/history`,
} as const;

export interface PromptConfigurationRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
  readonly preview?: (
    input: PromptPreviewRequest,
    actor: OperatorPrincipal,
  ) => Promise<PromptPreviewResponse>;
}

interface ConfigurationRouteResult {
  readonly schema: TSchema;
  readonly value: unknown;
  readonly statusCode?: number;
}

const paginationKeys = ["page", "pageSize"] as const;
const NullableEntityIdSchema = Type.Union([EntityIdSchema, Type.Null()]);
const bindingHistoryProperties = {
  id: EntityIdSchema,
  previousVersionId: NullableEntityIdSchema,
  createdAt: DateTimeSchema,
  createdBy: PromptVersionSchema.properties.createdBy,
};
const PromptBindingHistorySchema = Type.Object(
  { ...PromptBindingSchema.properties, ...bindingHistoryProperties },
  { additionalProperties: false },
);
const ValidationProfileBindingHistorySchema = Type.Object(
  { ...RepositoryValidationProfileBindingSchema.properties, ...bindingHistoryProperties },
  { additionalProperties: false },
);

function entityParameter(request: FastifyRequest, name: string): string {
  return configurationEntityId((request.params as Record<string, unknown>)[name]);
}

function workflowParameter(request: FastifyRequest) {
  return parseConfigurationBody(
    WorkflowKindSchema,
    (request.params as Record<string, unknown>).workflowKind,
  );
}

function scopedSchema(schema: TSchema, properties: TProperties): TSchema {
  return Type.Intersect([schema, Type.Object(properties)]);
}

function repositoryScope(repositoryId: string | null): TProperties {
  return { repositoryId: repositoryId === null ? Type.Null() : Type.Literal(repositoryId) };
}

function pageSchema(
  item: TSchema,
  pagination: { readonly page: number; readonly pageSize: number },
): TSchema {
  return Type.Object(
    {
      items: Type.Array(item, { maxItems: pagination.pageSize }),
      total: NonNegativeIntegerSchema,
      page: Type.Literal(pagination.page),
      pageSize: Type.Literal(pagination.pageSize),
    },
    { additionalProperties: false },
  );
}

function validatePromptContent(content: string): void {
  if (
    Buffer.byteLength(content, "utf8") > maximumPromptContentUtf8Bytes ||
    Buffer.from(content, "utf8").toString("utf8") !== content
  ) {
    throw new ConfigurationHttpError(
      400,
      "configuration_request_invalid",
      "Prompt content must contain valid Unicode within the supported UTF-8 byte limit.",
    );
  }
}

export function registerPromptConfigurationRoutes(
  app: FastifyInstance,
  dependencies: PromptConfigurationRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const databaseFor = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));

  const register = (options: {
    readonly method: "GET" | "POST" | "PATCH" | "PUT";
    readonly path: string;
    readonly queryKeys?: readonly string[];
    readonly handle: (
      request: FastifyRequest,
      query: Record<string, string>,
    ) => Promise<ConfigurationRouteResult>;
  }): void => {
    app.route({
      method: options.method,
      url: options.path,
      bodyLimit: 2 * 1_024 * 1_024,
      onRequest: options.method === "GET" ? authorization.read : authorization.mutate,
      handler: async (request, reply) => {
        try {
          const query = configurationQuery(request.query, options.queryKeys ?? []);
          const result = await options.handle(request, query);
          reply.code(result.statusCode ?? 200);
          return sendConfigurationResponse(reply, result.schema, result.value);
        } catch (error) {
          return sendConfigurationError(reply, error);
        }
      },
    });
  };

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.templates,
    queryKeys: [...paginationKeys, "workflowKind"],
    handle: async (request, query) => {
      const pagination = configurationPagination(query);
      const workflowKind =
        query.workflowKind === undefined
          ? undefined
          : parseConfigurationBody(WorkflowKindSchema, query.workflowKind);
      return {
        schema: pageSchema(
          workflowKind === undefined
            ? PromptTemplateSummarySchema
            : scopedSchema(PromptTemplateSummarySchema, {
                workflowKind: Type.Literal(workflowKind),
              }),
          pagination,
        ),
        value: await databaseFor(request).request("listPromptTemplates", {
          ...pagination,
          ...(workflowKind === undefined ? {} : { workflowKind }),
        }),
      };
    },
  });

  register({
    method: "POST",
    path: PROMPT_CONFIGURATION_PATHS.templates,
    handle: async (request) => {
      const input = parseConfigurationBody(PromptTemplateCreateRequestSchema, request.body);
      validatePromptContent(input.content);
      return {
        statusCode: 201,
        schema: scopedSchema(PromptTemplateSchema, {
          workflowKind: Type.Literal(input.workflowKind),
        }),
        value: await databaseFor(request).request("createPromptTemplate", {
          request: input,
          actor: authorization.actor(request),
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.template,
    handle: async (request) => {
      const templateId = entityParameter(request, "templateId");
      const value = await databaseFor(request).request("getPromptTemplate", { templateId });
      if (value === null) {
        throw new ConfigurationHttpError(
          404,
          "platform_not_found",
          "The prompt template was not found.",
        );
      }
      return {
        schema: scopedSchema(PromptTemplateSchema, { id: Type.Literal(templateId) }),
        value,
      };
    },
  });

  register({
    method: "PATCH",
    path: PROMPT_CONFIGURATION_PATHS.draft,
    handle: async (request) => {
      const templateId = entityParameter(request, "templateId");
      const input = parseConfigurationBody(PromptDraftSaveRequestSchema, request.body);
      validatePromptContent(input.content);
      return {
        schema: scopedSchema(PromptTemplateSchema, { id: Type.Literal(templateId) }),
        value: await databaseFor(request).request("savePromptDraft", {
          templateId,
          request: input,
          actor: authorization.actor(request),
        }),
      };
    },
  });

  register({
    method: "POST",
    path: PROMPT_CONFIGURATION_PATHS.publish,
    handle: async (request) => {
      const templateId = entityParameter(request, "templateId");
      const input = parseConfigurationBody(PromptDraftPublishRequestSchema, request.body);
      return {
        statusCode: 201,
        schema: scopedSchema(PromptVersionSchema, { templateId: Type.Literal(templateId) }),
        value: await databaseFor(request).request("publishPromptDraft", {
          templateId,
          request: input,
          actor: authorization.actor(request),
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.versions,
    queryKeys: paginationKeys,
    handle: async (request, query) => {
      const templateId = entityParameter(request, "templateId");
      const pagination = configurationPagination(query);
      return {
        schema: pageSchema(
          scopedSchema(PromptVersionSummarySchema, { templateId: Type.Literal(templateId) }),
          pagination,
        ),
        value: await databaseFor(request).request("listPromptVersions", {
          templateId,
          ...pagination,
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.version,
    handle: async (request) => {
      const templateId = entityParameter(request, "templateId");
      const versionId = entityParameter(request, "versionId");
      return {
        schema: scopedSchema(PromptVersionSchema, {
          templateId: Type.Literal(templateId),
          id: Type.Literal(versionId),
        }),
        value: await databaseFor(request).request("getPromptVersion", { templateId, versionId }),
      };
    },
  });

  register({
    method: "POST",
    path: PROMPT_CONFIGURATION_PATHS.preview,
    handle: async (request) => {
      const input = parseConfigurationBody(PromptPreviewRequestSchema, request.body);
      validatePromptContent(input.content);
      if (dependencies.preview === undefined) {
        throw new ConfigurationHttpError(
          503,
          "prompt_preview_unavailable",
          "Prompt rendering preview is not available on this server.",
        );
      }
      return {
        schema: scopedSchema(PromptPreviewResponseSchema, {
          workItemId: input.workItemId === undefined ? Type.Null() : Type.Literal(input.workItemId),
        }),
        value: await dependencies.preview(input, authorization.actor(request)),
      };
    },
  });

  for (const scope of [
    {
      list: PROMPT_CONFIGURATION_PATHS.globalBindings,
      binding: PROMPT_CONFIGURATION_PATHS.globalBinding,
      history: PROMPT_CONFIGURATION_PATHS.globalBindingHistory,
      repositoryId: (_request: FastifyRequest): string | null => null,
    },
    {
      list: PROMPT_CONFIGURATION_PATHS.repositoryBindings,
      binding: PROMPT_CONFIGURATION_PATHS.repositoryBinding,
      history: PROMPT_CONFIGURATION_PATHS.repositoryBindingHistory,
      repositoryId: (request: FastifyRequest): string | null =>
        entityParameter(request, "repositoryId"),
    },
  ]) {
    register({
      method: "GET",
      path: scope.list,
      handle: async (request) => {
        const repositoryId = scope.repositoryId(request);
        return {
          schema: Type.Object(
            {
              items: Type.Array(scopedSchema(PromptBindingSchema, repositoryScope(repositoryId)), {
                maxItems: WorkflowKindValues.length,
              }),
            },
            { additionalProperties: false },
          ),
          value: {
            items: await databaseFor(request).request("listPromptBindings", { repositoryId }),
          },
        };
      },
    });

    register({
      method: "PUT",
      path: scope.binding,
      handle: async (request) => {
        const repositoryId = scope.repositoryId(request);
        const workflowKind = workflowParameter(request);
        const input = parseConfigurationBody(PromptBindingSaveRequestSchema, request.body);
        return {
          schema: scopedSchema(PromptBindingSchema, {
            ...repositoryScope(repositoryId),
            workflowKind: Type.Literal(workflowKind),
          }),
          value: await databaseFor(request).request("savePromptBinding", {
            repositoryId,
            workflowKind,
            request: input,
            actor: authorization.actor(request),
          }),
        };
      },
    });

    register({
      method: "GET",
      path: scope.history,
      queryKeys: paginationKeys,
      handle: async (request, query) => {
        const repositoryId = scope.repositoryId(request);
        const workflowKind = workflowParameter(request);
        const pagination = configurationPagination(query);
        return {
          schema: pageSchema(
            scopedSchema(PromptBindingHistorySchema, {
              ...repositoryScope(repositoryId),
              workflowKind: Type.Literal(workflowKind),
            }),
            pagination,
          ),
          value: await databaseFor(request).request("listPromptBindingHistory", {
            repositoryId,
            workflowKind,
            ...pagination,
          }),
        };
      },
    });
  }

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.profiles,
    queryKeys: paginationKeys,
    handle: async (request, query) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const pagination = configurationPagination(query);
      return {
        schema: pageSchema(
          scopedSchema(ValidationProfileVersionSummarySchema, repositoryScope(repositoryId)),
          pagination,
        ),
        value: await databaseFor(request).request("listValidationProfiles", {
          repositoryId,
          ...pagination,
        }),
      };
    },
  });

  register({
    method: "POST",
    path: PROMPT_CONFIGURATION_PATHS.profiles,
    handle: async (request) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const input = parseConfigurationBody(ValidationProfileCreateRequestSchema, request.body);
      if (
        getValidationProfileConfigIssues(input.config, input.workflowKind, input.target).length > 0
      ) {
        throw new ConfigurationHttpError(
          400,
          "configuration_request_invalid",
          "The validation profile contains invalid step, timeout, or configuration relationships.",
        );
      }
      return {
        statusCode: 201,
        schema: scopedSchema(ValidationProfileVersionSchema, {
          ...repositoryScope(repositoryId),
          workflowKind: Type.Literal(input.workflowKind),
          ...("profileId" in input ? { profileId: Type.Literal(input.profileId) } : {}),
        }),
        value: await databaseFor(request).request("publishValidationProfile", {
          repositoryId,
          request: input,
          actor: authorization.actor(request),
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.profileVersions,
    queryKeys: paginationKeys,
    handle: async (request, query) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const profileId = entityParameter(request, "profileId");
      const pagination = configurationPagination(query);
      return {
        schema: pageSchema(
          scopedSchema(ValidationProfileVersionSummarySchema, {
            ...repositoryScope(repositoryId),
            profileId: Type.Literal(profileId),
          }),
          pagination,
        ),
        value: await databaseFor(request).request("listValidationProfileVersions", {
          repositoryId,
          profileId,
          ...pagination,
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.profileVersion,
    handle: async (request) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const profileId = entityParameter(request, "profileId");
      const versionId = entityParameter(request, "versionId");
      return {
        schema: scopedSchema(ValidationProfileVersionSchema, {
          ...repositoryScope(repositoryId),
          profileId: Type.Literal(profileId),
          id: Type.Literal(versionId),
        }),
        value: await databaseFor(request).request("getValidationProfileVersion", {
          repositoryId,
          profileId,
          versionId,
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.profileBindings,
    queryKeys: paginationKeys,
    handle: async (request, query) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const pagination = configurationPagination(query);
      return {
        schema: pageSchema(
          scopedSchema(RepositoryValidationProfileBindingSchema, repositoryScope(repositoryId)),
          pagination,
        ),
        value: await databaseFor(request).request("listValidationProfileBindings", {
          repositoryId,
          ...pagination,
        }),
      };
    },
  });

  register({
    method: "PUT",
    path: PROMPT_CONFIGURATION_PATHS.profileBinding,
    handle: async (request) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const profileId = entityParameter(request, "profileId");
      const input = parseConfigurationBody(
        RepositoryValidationProfileBindingSaveRequestSchema,
        request.body,
      );
      return {
        schema: scopedSchema(RepositoryValidationProfileBindingSchema, {
          ...repositoryScope(repositoryId),
          profileId: Type.Literal(profileId),
        }),
        value: await databaseFor(request).request("saveValidationProfileBinding", {
          repositoryId,
          profileId,
          request: input,
          actor: authorization.actor(request),
        }),
      };
    },
  });

  register({
    method: "GET",
    path: PROMPT_CONFIGURATION_PATHS.profileBindingHistory,
    queryKeys: paginationKeys,
    handle: async (request, query) => {
      const repositoryId = entityParameter(request, "repositoryId");
      const profileId = entityParameter(request, "profileId");
      const pagination = configurationPagination(query);
      return {
        schema: pageSchema(
          scopedSchema(ValidationProfileBindingHistorySchema, {
            ...repositoryScope(repositoryId),
            profileId: Type.Literal(profileId),
          }),
          pagination,
        ),
        value: await databaseFor(request).request("listValidationProfileBindingHistory", {
          repositoryId,
          profileId,
          ...pagination,
        }),
      };
    },
  });
}
