import {
  type GitHubRepository,
  GitHubRepositorySchema,
  ManagedRepositoryNameSchema,
  ManagedRepositorySchema,
  ManagedRepositorySummarySchema,
  RepositoryCreateRequestSchema,
  RepositoryUpdateRequestSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { RepositoryConnectionError } from "../github/repository-connection.js";
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
  validateConfigurationResponse,
} from "./configuration-support.js";

export interface RepositoryRouteDependencies {
  readonly database: DatabaseClient;
  readonly operatorAuth: OperatorAuthRouteService;
  readonly readOnly?: boolean;
  readonly resolveRepository?: (
    fullName: string,
    expectedGithubRepositoryId?: number,
  ) => Promise<GitHubRepository>;
}

const repositoryRoot = "/api/v1/operator/repositories";
const ListResponseSchema = Type.Object(
  {
    items: Type.Array(ManagedRepositorySummarySchema, { maxItems: 50 }),
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
const ResolveRequestSchema = Type.Object(
  { fullName: ManagedRepositoryNameSchema },
  { additionalProperties: false },
);
const EmptyRequestSchema = Type.Object({}, { additionalProperties: false });

function asHttpError(error: unknown): unknown {
  return error instanceof RepositoryConnectionError
    ? new ConfigurationHttpError(
        error.statusCode,
        error.code,
        error.message,
        error.statusCode >= 500,
      )
    : error;
}

function assertRepository(repository: GitHubRepository, expectedId?: number): void {
  validateConfigurationResponse(GitHubRepositorySchema, repository);
  validateConfigurationResponse(ManagedRepositoryNameSchema, repository.fullName);
  if (
    (expectedId !== undefined && expectedId !== repository.githubRepositoryId) ||
    repository.fullName !== `${repository.ownerLogin}/${repository.name}` ||
    repository.htmlUrl !== `https://github.com/${repository.fullName}`
  ) {
    throw new ConfigurationHttpError(
      502,
      "repository_identity_invalid",
      "The repository response does not have a consistent GitHub identity.",
    );
  }
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  dependencies: RepositoryRouteDependencies,
): void {
  const authorization = createConfigurationAuthorization(
    dependencies.operatorAuth,
    dependencies.readOnly,
  );
  const databaseFor = (request: FastifyRequest) =>
    bindOperatorDatabase(dependencies.database, authorization.actor(request));
  const resolve = async (fullName: string, expectedId?: number): Promise<GitHubRepository> => {
    if (!dependencies.resolveRepository)
      throw new ConfigurationHttpError(
        503,
        "repository_connection_unavailable",
        "GitHub repository connection checks are unavailable.",
      );
    const repository = await dependencies.resolveRepository(fullName, expectedId);
    assertRepository(repository, expectedId);
    return repository;
  };

  app.get(repositoryRoot, { onRequest: authorization.read }, async (request, reply) => {
    try {
      const query = configurationQuery(request.query, ["page", "pageSize", "search", "enabled"]);
      const pagination = configurationPagination(query);
      if (query.search !== undefined && query.search.length > 512)
        throw new ConfigurationHttpError(
          400,
          "configuration_query_invalid",
          "Repository search is too long.",
        );
      if (query.enabled !== undefined && !["true", "false"].includes(query.enabled))
        throw new ConfigurationHttpError(
          400,
          "configuration_query_invalid",
          "Repository enabled filter must be true or false.",
        );
      const result = validateConfigurationResponse(
        ListResponseSchema,
        await databaseFor(request).request("listManagedRepositories", {
          ...pagination,
          ...(query.search === undefined ? {} : { search: query.search }),
          ...(query.enabled === undefined ? {} : { enabled: query.enabled === "true" }),
        }),
      );
      if (
        result.items.length > pagination.pageSize ||
        (result.items.length > 0 &&
          result.total < (pagination.page - 1) * pagination.pageSize + result.items.length)
      )
        throw new ConfigurationHttpError(
          502,
          "configuration_response_invalid",
          "The repository page is inconsistent with its size or total.",
        );
      return sendConfigurationResponse(reply, ListResponseSchema, result);
    } catch (error) {
      return sendConfigurationError(reply, asHttpError(error));
    }
  });

  app.post(
    `${repositoryRoot}/resolve`,
    { onRequest: authorization.mutate },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const body = parseConfigurationBody(ResolveRequestSchema, request.body);
        const database = databaseFor(request);
        await database.request("operatorCheckPermission", {});
        const metadata = await resolve(body.fullName);
        await database.request("operatorCheckPermission", {});
        return sendConfigurationResponse(reply, GitHubRepositorySchema, metadata);
      } catch (error) {
        return sendConfigurationError(reply, asHttpError(error));
      }
    },
  );

  app.post(repositoryRoot, { onRequest: authorization.mutate }, async (request, reply) => {
    try {
      configurationQuery(request.query, []);
      const body = parseConfigurationBody(RepositoryCreateRequestSchema, request.body);
      const database = databaseFor(request);
      await database.request("operatorCheckPermission", {});
      const metadata = await resolve(body.fullName, body.githubRepositoryId);
      const result = validateConfigurationResponse(
        ManagedRepositorySchema,
        await database.request("createManagedRepository", {
          request: { ...body, fullName: metadata.fullName },
          metadata,
          actor: authorization.actor(request),
        }),
      );
      if (
        result.githubRepositoryId !== metadata.githubRepositoryId ||
        result.fullName !== metadata.fullName
      )
        throw new ConfigurationHttpError(
          502,
          "configuration_response_invalid",
          "The created repository has an unexpected identity.",
        );
      reply.code(201);
      return sendConfigurationResponse(reply, ManagedRepositorySchema, result);
    } catch (error) {
      return sendConfigurationError(reply, asHttpError(error));
    }
  });

  app.get<{ Params: { repositoryId: string } }>(
    `${repositoryRoot}/:repositoryId`,
    { onRequest: authorization.read },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const repositoryId = configurationEntityId(request.params.repositoryId);
        const result = await databaseFor(request).request("getManagedRepository", {
          repositoryId,
        });
        if (result === null)
          throw new ConfigurationHttpError(
            404,
            "platform_not_found",
            "The repository does not exist.",
          );
        if (result.id !== repositoryId)
          throw new ConfigurationHttpError(
            502,
            "configuration_response_invalid",
            "The repository response has an unexpected identity.",
          );
        return sendConfigurationResponse(reply, ManagedRepositorySchema, result);
      } catch (error) {
        return sendConfigurationError(reply, asHttpError(error));
      }
    },
  );

  app.patch<{ Params: { repositoryId: string } }>(
    `${repositoryRoot}/:repositoryId`,
    { onRequest: authorization.mutate },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        const repositoryId = configurationEntityId(request.params.repositoryId);
        const body = parseConfigurationBody(RepositoryUpdateRequestSchema, request.body);
        const result = validateConfigurationResponse(
          ManagedRepositorySchema,
          await databaseFor(request).request("updateManagedRepository", {
            repositoryId,
            request: body,
            actor: authorization.actor(request),
          }),
        );
        if (result.id !== repositoryId || result.version !== body.expectedVersion + 1)
          throw new ConfigurationHttpError(
            502,
            "configuration_response_invalid",
            "The updated repository response is inconsistent.",
          );
        return sendConfigurationResponse(reply, ManagedRepositorySchema, result);
      } catch (error) {
        return sendConfigurationError(reply, asHttpError(error));
      }
    },
  );

  app.post<{ Params: { repositoryId: string } }>(
    `${repositoryRoot}/:repositoryId/check-connection`,
    { onRequest: authorization.mutate },
    async (request, reply) => {
      try {
        configurationQuery(request.query, []);
        parseConfigurationBody(EmptyRequestSchema, request.body ?? {});
        const repositoryId = configurationEntityId(request.params.repositoryId);
        const database = databaseFor(request);
        await database.request("operatorCheckPermission", {
          repositoryId,
          permission: "configure",
        });
        const stored = await database.request("getManagedRepository", {
          repositoryId,
        });
        if (stored === null)
          throw new ConfigurationHttpError(
            404,
            "platform_not_found",
            "The repository does not exist.",
          );
        const repository = validateConfigurationResponse(ManagedRepositorySchema, stored);
        if (repository.id !== repositoryId)
          throw new ConfigurationHttpError(
            502,
            "configuration_response_invalid",
            "The repository response has an unexpected identity.",
          );
        let metadata: GitHubRepository;
        try {
          metadata = await resolve(repository.fullName, repository.githubRepositoryId);
        } catch (error) {
          const normalized = asHttpError(error);
          const message =
            normalized instanceof ConfigurationHttpError
              ? normalized.message
              : "The GitHub repository could not be reached.";
          const result = validateConfigurationResponse(
            ManagedRepositorySchema,
            await database.request("updateRepositoryConnection", {
              repositoryId,
              status: "error",
              message,
            }),
          );
          if (
            result.id !== repositoryId ||
            result.githubRepositoryId !== repository.githubRepositoryId ||
            result.connectionStatus !== "error"
          )
            throw new ConfigurationHttpError(
              502,
              "configuration_response_invalid",
              "The connection update response is inconsistent.",
            );
          return sendConfigurationResponse(reply, ManagedRepositorySchema, result);
        }
        const result = validateConfigurationResponse(
          ManagedRepositorySchema,
          await database.request("updateRepositoryConnection", {
            repositoryId,
            status: "ready",
            message: metadata.isPrivate
              ? "GitHub metadata is accessible. Private checkout requires a repository credential binding."
              : "GitHub repository metadata is accessible.",
            metadata,
          }),
        );
        if (
          result.id !== repositoryId ||
          result.githubRepositoryId !== repository.githubRepositoryId ||
          result.fullName !== metadata.fullName ||
          result.connectionStatus !== "ready"
        )
          throw new ConfigurationHttpError(
            502,
            "configuration_response_invalid",
            "The connection update response is inconsistent.",
          );
        return sendConfigurationResponse(reply, ManagedRepositorySchema, result);
      } catch (error) {
        return sendConfigurationError(reply, asHttpError(error));
      }
    },
  );
}
