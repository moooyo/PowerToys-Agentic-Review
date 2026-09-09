import type {
  DashboardAuthorization,
  DashboardJobStage,
  DashboardWorkItemStage,
  ExecutionPhase,
  GitHubWorkItemKind,
  JobState,
  WorkerState,
  WorkItemState,
} from "@agentic-review/contracts";
import type { ReviewControlAdapter } from "./adapter";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlUnsupportedOperationError,
} from "./errors";
import { DashboardHttpClient, type DashboardHttpClientOptions } from "./http-client";
import {
  mapCreatedWorkerCredentialResponse,
  mapJobDetailsResponse,
  mapJobListResponse,
  mapRevokedWorkerCredentialResponse,
  mapRotatedWorkerCredentialResponse,
  mapSystemSnapshotResponse,
  mapWorkerCredentialListResponse,
  mapWorkerListResponse,
  mapWorkItemListResponse,
} from "./http-mappers";
import type {
  Approval,
  ApprovalDecision,
  Job,
  JobDetails,
  ListQuery,
  PageResult,
  Publication,
  SystemSnapshot,
  WorkerCredential,
  WorkerCredentialRevocation,
  WorkerCredentialSecret,
  WorkerNode,
  WorkItem,
} from "./types";

const endpoints = {
  jobById: "/api/v1/dashboard/jobs",
  jobs: "/api/v1/dashboard/jobs",
  system: "/api/v1/dashboard/system",
  workerCredentials: "/api/v1/operator/worker-nodes",
  workers: "/api/v1/dashboard/workers",
  workItems: "/api/v1/dashboard/work-items",
} as const;

const workerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const canonicalDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WORKER_ROSTER_PAGE_SIZE = 200;
const MAX_WORKER_ROSTER_ITEMS = 10_000;

const workItemKinds = {
  issue: true,
  pull_request: true,
} satisfies Record<GitHubWorkItemKind, true>;

const workItemStates = {
  active: true,
  assigned: true,
  closed: true,
  open: true,
  unassigned: true,
} satisfies Record<WorkItemState, true>;

const workItemStages = {
  not_scheduled: true,
  awaiting_admission: true,
  done: true,
  preparing: true,
  publishing: true,
  queued: true,
  reviewing: true,
  validating: true,
  waiting_approval: true,
} satisfies Record<DashboardWorkItemStage, true>;

const authorizations = {
  allowlisted: true,
  denied: true,
  self: true,
} satisfies Record<DashboardAuthorization, true>;

const jobStates = {
  cancel_requested: true,
  cancelled: true,
  dead_letter: true,
  failed: true,
  leased: true,
  queued: true,
  retry_waiting: true,
  running: true,
  stale: true,
  succeeded: true,
} satisfies Record<JobState, true>;

const executionPhases = {
  cancelling: true,
  cli_review: true,
  cli_revision: true,
  completing: true,
  leased: true,
  preparing: true,
  uploading: true,
  validation: true,
} satisfies Record<ExecutionPhase, true>;

const jobStages = {
  ...executionPhases,
  awaiting_admission: true,
  done: true,
  queued: true,
} satisfies Record<DashboardJobStage, true>;

const workerStates = {
  disabled: true,
  draining: true,
  offline: true,
  online: true,
} satisfies Record<WorkerState, true>;

type FilterValues = Readonly<Record<string, string | string[] | undefined>>;
type EnumValues<TValue extends string> = Readonly<Record<TValue, true>>;

const invalidRequest = (operation: string, path: string, expectation: string): never => {
  throw new ReviewControlRequestError(
    operation,
    path,
    `The ${operation} request has an invalid ${path}; expected ${expectation}.`,
  );
};

const appendInteger = (
  parameters: URLSearchParams,
  name: string,
  value: number | undefined,
  operation: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void => {
  if (value === undefined) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidRequest(operation, `query.${name}`, `an integer from ${minimum} through ${maximum}`);
  }
  parameters.set(name, String(value));
};

const appendSearch = (
  parameters: URLSearchParams,
  search: string | undefined,
  operation: string,
): void => {
  if (search === undefined || search === "") {
    return;
  }
  if (search.length > 512) {
    invalidRequest(operation, "query.search", "a string no longer than 512 characters");
  }
  parameters.set("search", search);
};

const appendEnumFilter = <TValue extends string>(
  parameters: URLSearchParams,
  name: string,
  value: string | string[] | undefined,
  operation: string,
  allowed: EnumValues<TValue>,
  maximumItems: number,
): void => {
  if (value === undefined) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.length > maximumItems || new Set(values).size !== values.length) {
    invalidRequest(operation, `query.${name}`, `at most ${maximumItems} unique filter values`);
  }
  for (const item of values) {
    if (!Object.hasOwn(allowed, item)) {
      invalidRequest(operation, `query.${name}`, "a supported filter value");
    }
    parameters.append(name, item);
  }
};

const appendEntityIdFilter = (
  parameters: URLSearchParams,
  name: string,
  value: string | string[] | undefined,
  operation: string,
): void => {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    invalidRequest(operation, `query.${name}`, "one entity identifier");
  }
  const entityId = value as string;
  if (entityId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u.test(entityId)) {
    invalidRequest(operation, `query.${name}`, "a valid entity identifier");
  }
  parameters.set(name, entityId);
};

const assertKnownFilters = (
  filters: FilterValues | undefined,
  allowed: readonly string[],
  operation: string,
): void => {
  if (filters === undefined) {
    return;
  }
  const allowedNames = new Set(allowed);
  const unknown = Object.keys(filters).find((name) => !allowedNames.has(name));
  if (unknown !== undefined) {
    invalidRequest(operation, "query.filters", "supported filter names only");
  }
};

const baseQuery = (query: ListQuery, operation: string): URLSearchParams => {
  const parameters = new URLSearchParams();
  appendInteger(parameters, "page", query.page, operation, 1);
  appendInteger(parameters, "pageSize", query.pageSize, operation, 1, 200);
  appendSearch(parameters, query.search, operation);
  return parameters;
};

const withQuery = (endpoint: string, parameters: URLSearchParams): string => {
  const query = parameters.toString();
  return query === "" ? endpoint : `${endpoint}?${query}`;
};

const buildWorkItemPath = (query: ListQuery, operation: string): string => {
  assertKnownFilters(
    query.filters,
    ["authorization", "kind", "stage", "state", "repositoryId"],
    operation,
  );
  const parameters = baseQuery(query, operation);
  appendEnumFilter(parameters, "kind", query.filters?.kind, operation, workItemKinds, 16);
  appendEnumFilter(parameters, "state", query.filters?.state, operation, workItemStates, 16);
  appendEnumFilter(parameters, "stage", query.filters?.stage, operation, workItemStages, 16);
  appendEnumFilter(
    parameters,
    "authorization",
    query.filters?.authorization,
    operation,
    authorizations,
    16,
  );
  appendEntityIdFilter(parameters, "repositoryId", query.filters?.repositoryId, operation);
  return withQuery(endpoints.workItems, parameters);
};

const buildJobPath = (query: ListQuery, operation: string): string => {
  assertKnownFilters(
    query.filters,
    ["phase", "stage", "status", "admission", "workItemId", "repositoryId"],
    operation,
  );
  const parameters = baseQuery(query, operation);
  appendEnumFilter(parameters, "status", query.filters?.status, operation, jobStates, 32);
  appendEnumFilter(parameters, "phase", query.filters?.phase, operation, executionPhases, 32);
  appendEnumFilter(parameters, "stage", query.filters?.stage, operation, jobStages, 32);
  if (Array.isArray(query.filters?.admission) && query.filters.admission.length === 0)
    invalidRequest(operation, "query.admission", "one or two admission states");
  appendEnumFilter(
    parameters,
    "admission",
    query.filters?.admission,
    operation,
    { pending: true, admitted: true },
    2,
  );
  appendEntityIdFilter(parameters, "workItemId", query.filters?.workItemId, operation);
  appendEntityIdFilter(parameters, "repositoryId", query.filters?.repositoryId, operation);
  return withQuery(endpoints.jobs, parameters);
};

const buildJobByIdPath = (jobId: string, operation: string): string => {
  if (jobId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(jobId)) {
    invalidRequest(operation, "jobId", "a valid entity identifier");
  }
  return `${endpoints.jobById}/${jobId}`;
};

const buildWorkerPath = (query: ListQuery, operation: string): string => {
  assertKnownFilters(query.filters, ["status"], operation);
  const parameters = baseQuery(query, operation);
  appendEnumFilter(parameters, "status", query.filters?.status, operation, workerStates, 16);
  return withQuery(endpoints.workers, parameters);
};

const buildWorkerCredentialMutationPath = (
  workerNodeId: string,
  operation: string,
  suffix: "token/rotate" | "revoke",
): string => {
  if (!workerNodeIdPattern.test(workerNodeId)) {
    invalidRequest(operation, "workerNodeId", "a canonical worker node identifier");
  }
  return `${endpoints.workerCredentials}/${workerNodeId}/${suffix}`;
};

const ensureMatchingWorkerNodeId = (actual: string, expected: string, operation: string): void => {
  if (actual !== expected) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response did not match the requested worker node.`,
      "$.workerNodeId",
    );
  }
};

interface StrictRosterOptions<TItem> {
  readonly itemId: (item: TItem) => string;
  readonly operation: string;
  readonly readPage: (page: number) => Promise<PageResult<TItem>>;
}

const collectStrictRoster = async <TItem>({
  itemId,
  operation,
  readPage,
}: StrictRosterOptions<TItem>): Promise<PageResult<TItem>> => {
  const items: TItem[] = [];
  const itemIds = new Set<string>();
  let expectedTotal: number | undefined;

  for (let page = 1; ; page += 1) {
    const result = await readPage(page);
    if (result.items.length > WORKER_ROSTER_PAGE_SIZE) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response exceeded the requested page size.`,
      );
    }
    if (expectedTotal === undefined) {
      expectedTotal = result.total;
      if (expectedTotal > MAX_WORKER_ROSTER_ITEMS) {
        throw new ReviewControlProtocolError(
          operation,
          `The ${operation} response exceeds the dashboard roster limit.`,
        );
      }
    } else if (result.total !== expectedTotal) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response changed total records between pages.`,
      );
    }

    const previousCount = items.length;
    for (const item of result.items) {
      const id = itemId(item);
      if (itemIds.has(id)) {
        throw new ReviewControlProtocolError(
          operation,
          `The ${operation} response repeated a worker between pages.`,
        );
      }
      itemIds.add(id);
      items.push(item);
    }

    if (items.length > expectedTotal) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response returned more records than its total.`,
      );
    }
    if (items.length === expectedTotal) {
      return { items, total: expectedTotal };
    }
    if (items.length === previousCount || result.items.length < WORKER_ROSTER_PAGE_SIZE) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response made no valid pagination progress.`,
      );
    }
  }
};

export interface HttpReviewControlAdapterOptions extends DashboardHttpClientOptions {
  readonly client?: DashboardHttpClient;
}

function ensureRepositoryScope<T extends { repositoryId: string }>(
  response: PageResult<T>,
  query: ListQuery,
  operation: string,
): PageResult<T> {
  const repositoryId = query.filters?.repositoryId;
  if (
    typeof repositoryId === "string" &&
    response.items.some((item) => item.repositoryId !== repositoryId)
  ) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response included data from another repository.`,
      "$.items.repositoryId",
    );
  }
  return response;
}

export class HttpReviewControlAdapter implements ReviewControlAdapter {
  private readonly client: DashboardHttpClient;

  constructor(options: HttpReviewControlAdapterOptions = {}) {
    this.client = options.client ?? new DashboardHttpClient(options);
  }

  async listWorkItems(query: ListQuery = {}): Promise<PageResult<WorkItem>> {
    const operation = "listWorkItems";
    const response = await this.client.get(buildWorkItemPath(query, operation), operation);
    return ensureRepositoryScope(mapWorkItemListResponse(response, operation), query, operation);
  }

  async requeueWorkItem(_workItemId: string): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("requeueWorkItem");
  }

  async listJobs(query: ListQuery = {}): Promise<PageResult<Job>> {
    const operation = "listJobs";
    const response = await this.client.get(buildJobPath(query, operation), operation);
    return ensureRepositoryScope(mapJobListResponse(response, operation), query, operation);
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<JobDetails | null> {
    const operation = "getJob";
    try {
      const response = await this.client.get(buildJobByIdPath(jobId, operation), operation, {
        signal,
      });
      return mapJobDetailsResponse(response, operation);
    } catch (error) {
      if (
        error instanceof ReviewControlHttpError &&
        error.status === 404 &&
        error.serverCode === "dashboard_job_not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  async cancelJob(_jobId: string): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("cancelJob");
  }

  async listWorkers(query: ListQuery = {}): Promise<PageResult<WorkerNode>> {
    const operation = "listWorkers";
    const response = await this.client.get(buildWorkerPath(query, operation), operation);
    return mapWorkerListResponse(response, operation);
  }

  async listAllWorkers(): Promise<PageResult<WorkerNode>> {
    const operation = "listAllWorkers";
    return collectStrictRoster({
      itemId: (item) => item.id,
      operation,
      readPage: async (page) => {
        const response = await this.client.get(
          `${endpoints.workers}?page=${page}&pageSize=${WORKER_ROSTER_PAGE_SIZE}&sort=identity`,
          operation,
        );
        return mapWorkerListResponse(response, operation);
      },
    });
  }

  async listWorkerCredentials(): Promise<PageResult<WorkerCredential>> {
    const operation = "listWorkerCredentials";
    return collectStrictRoster({
      itemId: (item) => item.workerNodeId,
      operation,
      readPage: async (page) => {
        const response = await this.client.get(
          `${endpoints.workerCredentials}?page=${page}&pageSize=${WORKER_ROSTER_PAGE_SIZE}&sort=identity`,
          operation,
        );
        return mapWorkerCredentialListResponse(response, operation);
      },
    });
  }

  async createWorkerCredential(displayName: string): Promise<WorkerCredentialSecret> {
    const operation = "createWorkerCredential";
    if (
      displayName.length < 1 ||
      displayName.length > 512 ||
      displayName.includes("\0") ||
      workerTokenExposurePattern.test(displayName)
    ) {
      invalidRequest(operation, "displayName", "a non-empty string no longer than 512 characters");
    }
    const response = await this.client.post(endpoints.workerCredentials, operation, {
      displayName,
    });
    return mapCreatedWorkerCredentialResponse(response, operation);
  }

  async rotateWorkerToken(
    workerNodeId: string,
    expectedUpdatedAt: string,
  ): Promise<WorkerCredentialSecret> {
    const operation = "rotateWorkerToken";
    const path = buildWorkerCredentialMutationPath(workerNodeId, operation, "token/rotate");
    const expectedUpdatedAtMilliseconds = Date.parse(expectedUpdatedAt);
    if (
      !canonicalDateTimePattern.test(expectedUpdatedAt) ||
      !Number.isFinite(expectedUpdatedAtMilliseconds) ||
      new Date(expectedUpdatedAtMilliseconds).toISOString() !== expectedUpdatedAt
    ) {
      invalidRequest(operation, "expectedUpdatedAt", "an RFC 3339 date-time");
    }
    const response = await this.client.post(path, operation, { expectedUpdatedAt });
    const result = mapRotatedWorkerCredentialResponse(response, operation);
    ensureMatchingWorkerNodeId(result.workerNodeId, workerNodeId, operation);
    return result;
  }

  async revokeWorkerToken(workerNodeId: string): Promise<WorkerCredentialRevocation> {
    const operation = "revokeWorkerToken";
    const path = buildWorkerCredentialMutationPath(workerNodeId, operation, "revoke");
    const response = await this.client.post(path, operation, {});
    const result = mapRevokedWorkerCredentialResponse(response, operation);
    ensureMatchingWorkerNodeId(result.workerNodeId, workerNodeId, operation);
    return result;
  }

  async setWorkerDrain(_workerId: string, _drain: boolean): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("setWorkerDrain");
  }

  async listApprovals(_query: ListQuery = {}): Promise<PageResult<Approval>> {
    throw new ReviewControlUnsupportedOperationError("listApprovals");
  }

  async decideApproval(_approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("decideApproval");
  }

  async listPublications(_query: ListQuery = {}): Promise<PageResult<Publication>> {
    throw new ReviewControlUnsupportedOperationError("listPublications");
  }

  async retryPublication(_publicationId: string): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("retryPublication");
  }

  async getSystemSnapshot(): Promise<SystemSnapshot> {
    const operation = "getSystemSnapshot";
    const response = await this.client.get(endpoints.system, operation);
    return mapSystemSnapshotResponse(response, operation);
  }
}
