import {
  EntityIdSchema,
  type ManagedRepository,
  type ManagedRepositorySummary,
  ManagedRepositorySummarySchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  type RepositoryConfigurationSnapshot,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { RepositoryListQuery } from "./adapter";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const RepositoryListQuerySchema = Type.Object(
  {
    page: Type.Optional(PositiveIntegerSchema),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    search: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const RepositoryListResultSchema = Type.Object(
  {
    items: Type.Array(ManagedRepositorySummarySchema, { maxItems: 50 }),
    total: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);

const containsUndefined = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "object" && value !== null && Object.values(value).some(containsUndefined));

const canonicalRepositoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;

export function validateRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  path = "request",
): Static<T> {
  if (!Value.Check(schema, value) || containsUndefined(value)) {
    throw new ReviewControlRequestError(operation, path, `The ${operation} request is invalid.`);
  }
  return value;
}

export function validateResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new ReviewControlProtocolError(operation, `The ${operation} response is invalid.`);
  }
  return value;
}

export function validateRepositoryId(id: string, operation: string): void {
  validateRequest(EntityIdSchema, id, operation, "id");
  if (!canonicalRepositoryIdPattern.test(id)) {
    throw new ReviewControlRequestError(operation, "id", "The repository ID is invalid.");
  }
}

export function normalizeListQuery(query: RepositoryListQuery = {}): Required<RepositoryListQuery> {
  validateRequest(RepositoryListQuerySchema, query, "list repositories");
  const normalized = {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 50,
    search: query.search ?? "",
  };
  if (!Number.isSafeInteger((normalized.page - 1) * normalized.pageSize)) {
    throw new ReviewControlRequestError(
      "list repositories",
      "page",
      "The repository page is too large.",
    );
  }
  return normalized;
}

export function repositorySettingsAreConsistent(
  repository: ManagedRepository | ManagedRepositorySummary | RepositoryConfigurationSnapshot,
): boolean {
  return (
    canonicalRepositoryIdPattern.test(repository.id) &&
    (repository.reviewerGithubUserId === null) === (repository.reviewerGithubLogin === null) &&
    (repository.reviewerGithubLogin === null ||
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?![\s\S])/u.test(repository.reviewerGithubLogin)) &&
    (!("authorizationPolicy" in repository) ||
      repository.authorizationPolicy === null ||
      repository.authorizationPolicy.schedulingTargetGithubUserId ===
        repository.reviewerGithubUserId)
  );
}

export function ensureRepositoryResponseIdentity(
  repository: ManagedRepository,
  operation: string,
  expectedId?: string,
): ManagedRepository {
  if (
    (expectedId !== undefined && repository.id !== expectedId) ||
    !repositorySettingsAreConsistent(repository)
  ) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response contains inconsistent repository details.`,
    );
  }
  return repository;
}
