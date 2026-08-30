import {
  type DashboardJobListQuery,
  DashboardJobListQuerySchema,
  type DashboardJobListResponse,
  DashboardJobListResponseSchema,
  type DashboardSystemRead,
  DashboardSystemReadSchema,
  type DashboardWorkerListQuery,
  DashboardWorkerListQuerySchema,
  type DashboardWorkerListResponse,
  DashboardWorkerListResponseSchema,
  type DashboardWorkItemListQuery,
  DashboardWorkItemListQuerySchema,
  type DashboardWorkItemListResponse,
  DashboardWorkItemListResponseSchema,
  EntityIdSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

export const DASHBOARD_API_PATHS = {
  jobs: "/api/v1/dashboard/jobs",
  system: "/api/v1/dashboard/system",
  workers: "/api/v1/dashboard/workers",
  workItems: "/api/v1/dashboard/work-items",
} as const;

export interface DashboardReadStore {
  request(
    operation: "listWorkItems",
    input: DashboardWorkItemListQuery,
  ): Promise<DashboardWorkItemListResponse>;
  request(operation: "listJobs", input: DashboardJobListQuery): Promise<DashboardJobListResponse>;
  request(
    operation: "listWorkers",
    input: DashboardWorkerListQuery,
  ): Promise<DashboardWorkerListResponse>;
  request(
    operation: "getSystemSnapshot",
    input: Record<string, never>,
  ): Promise<DashboardSystemRead>;
}

export type DashboardAuthenticationPreHandler = onRequestAsyncHookHandler;

export interface DashboardRouteDependencies {
  readonly database: DashboardReadStore;
  readonly authenticate: DashboardAuthenticationPreHandler;
}

type QueryRecord = Record<string, unknown>;

interface QueryFieldLimits {
  readonly filters: Readonly<Record<string, number>>;
  readonly entityIds?: readonly string[];
}

const MAX_PAGE = Number.MAX_SAFE_INTEGER;
const MAX_PAGE_SIZE = 200;
const MAX_SEARCH_LENGTH = 512;

class DashboardQueryValidationError extends Error {
  public readonly statusCode = 400;
  public readonly validation: readonly {
    readonly instancePath: string;
    readonly message: string;
  }[];
  public readonly validationContext = "querystring";

  public constructor(field: string, message: string) {
    super(`query.${field} ${message}`);
    this.name = "DashboardQueryValidationError";
    this.validation = [{ instancePath: `/${field}`, message }];
  }
}

const inlineSchema = (schema: unknown): Record<string, unknown> => {
  const serialized = JSON.stringify(schema, (key, value: unknown) =>
    key === "$id" ? undefined : value,
  );
  if (serialized === undefined) {
    throw new Error("The dashboard route schema could not be serialized.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
};

const queryRecord = (value: unknown): QueryRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DashboardQueryValidationError("query", "must be an object");
  }
  return value as QueryRecord;
};

const singleQueryValue = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DashboardQueryValidationError(field, "must occur at most once");
  }
  return value;
};

const positiveInteger = (value: unknown, field: string, maximum: number): number | undefined => {
  const raw = singleQueryValue(value, field);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new DashboardQueryValidationError(field, "must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new DashboardQueryValidationError(field, `must be at most ${maximum}`);
  }
  return parsed;
};

const searchValue = (value: unknown): string | undefined => {
  const search = singleQueryValue(value, "search");
  if (search !== undefined && [...search].length > MAX_SEARCH_LENGTH) {
    throw new DashboardQueryValidationError(
      "search",
      `must contain at most ${MAX_SEARCH_LENGTH} characters`,
    );
  }
  return search;
};

const entityIdValue = (value: unknown, field: string): string | undefined => {
  const entityId = singleQueryValue(value, field);
  if (entityId !== undefined && !Value.Check(EntityIdSchema, entityId)) {
    throw new DashboardQueryValidationError(field, "must be one valid entity identifier");
  }
  return entityId;
};

const filterValue = (
  value: unknown,
  field: string,
  maximumItems: number,
): string | string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const occurrences = Array.isArray(value) ? value : [value];
  const values: string[] = [];
  for (const occurrence of occurrences) {
    if (typeof occurrence !== "string") {
      throw new DashboardQueryValidationError(field, "must contain only strings");
    }
    values.push(...occurrence.split(",").map((item) => item.trim()));
  }
  if (values.length > maximumItems) {
    throw new DashboardQueryValidationError(field, `must contain at most ${maximumItems} values`);
  }
  if (values.some((item) => item.length === 0)) {
    throw new DashboardQueryValidationError(field, "must not contain empty values");
  }
  if (new Set(values).size !== values.length) {
    throw new DashboardQueryValidationError(field, "must contain unique values");
  }
  return values.length === 1 ? values[0] : values;
};

const normalizeQuery = (value: unknown, limits: QueryFieldLimits): QueryRecord => {
  const raw = queryRecord(value);
  const normalized: QueryRecord = { ...raw };
  const allowedFields = new Set([
    "page",
    "pageSize",
    "search",
    ...Object.keys(limits.filters),
    ...(limits.entityIds ?? []),
  ]);
  const unknownField = Object.keys(raw).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    throw new DashboardQueryValidationError(unknownField, "is not supported");
  }

  const page = positiveInteger(raw.page, "page", MAX_PAGE);
  if (page !== undefined) {
    normalized.page = page;
  }
  const pageSize = positiveInteger(raw.pageSize, "pageSize", MAX_PAGE_SIZE);
  if (pageSize !== undefined) {
    normalized.pageSize = pageSize;
  }
  const search = searchValue(raw.search);
  if (search !== undefined) {
    normalized.search = search;
  }
  for (const [field, maximumItems] of Object.entries(limits.filters)) {
    const filter = filterValue(raw[field], field, maximumItems);
    if (filter !== undefined) {
      normalized[field] = filter;
    }
  }
  for (const field of limits.entityIds ?? []) {
    const entityId = entityIdValue(raw[field], field);
    if (entityId !== undefined) {
      normalized[field] = entityId;
    }
  }
  return normalized;
};

const normalizeQueryPreValidation =
  (limits: QueryFieldLimits) =>
  async (request: FastifyRequest): Promise<void> => {
    request.query = normalizeQuery(request.query, limits);
  };

const rejectSystemQuery = async (request: FastifyRequest): Promise<void> => {
  const raw = queryRecord(request.query);
  const field = Object.keys(raw)[0];
  if (field !== undefined) {
    throw new DashboardQueryValidationError(field, "is not supported");
  }
};

const workItemQuerySchema = inlineSchema(DashboardWorkItemListQuerySchema);
const workItemResponseSchema = inlineSchema(DashboardWorkItemListResponseSchema);
const jobQuerySchema = inlineSchema(DashboardJobListQuerySchema);
const jobResponseSchema = inlineSchema(DashboardJobListResponseSchema);
const workerQuerySchema = inlineSchema(DashboardWorkerListQuerySchema);
const workerResponseSchema = inlineSchema(DashboardWorkerListResponseSchema);
const systemResponseSchema = inlineSchema(DashboardSystemReadSchema);
const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const registerDashboardRoutes = (
  app: FastifyInstance,
  dependencies: DashboardRouteDependencies,
): void => {
  const { authenticate, database } = dependencies;

  app.get<{ Querystring: DashboardWorkItemListQuery; Reply: DashboardWorkItemListResponse }>(
    DASHBOARD_API_PATHS.workItems,
    {
      preValidation: normalizeQueryPreValidation({
        filters: { authorization: 16, kind: 16, stage: 16, state: 16 },
      }),
      onRequest: authenticate,
      schema: {
        querystring: workItemQuerySchema,
        response: { 200: workItemResponseSchema },
      },
    },
    async (request) => database.request("listWorkItems", request.query),
  );

  app.get<{ Querystring: DashboardJobListQuery; Reply: DashboardJobListResponse }>(
    DASHBOARD_API_PATHS.jobs,
    {
      preValidation: normalizeQueryPreValidation({
        entityIds: ["workItemId"],
        filters: { phase: 32, stage: 32, status: 32 },
      }),
      onRequest: authenticate,
      schema: {
        querystring: jobQuerySchema,
        response: { 200: jobResponseSchema },
      },
    },
    async (request) => database.request("listJobs", request.query),
  );

  app.get<{ Querystring: DashboardWorkerListQuery; Reply: DashboardWorkerListResponse }>(
    DASHBOARD_API_PATHS.workers,
    {
      preValidation: normalizeQueryPreValidation({ filters: { status: 16 } }),
      onRequest: authenticate,
      schema: {
        querystring: workerQuerySchema,
        response: { 200: workerResponseSchema },
      },
    },
    async (request) => database.request("listWorkers", request.query),
  );

  app.get<{ Querystring: Record<string, never>; Reply: DashboardSystemRead }>(
    DASHBOARD_API_PATHS.system,
    {
      preValidation: rejectSystemQuery,
      onRequest: authenticate,
      schema: {
        querystring: emptyQuerySchema,
        response: { 200: systemResponseSchema },
      },
    },
    async () => database.request("getSystemSnapshot", {}),
  );
};
