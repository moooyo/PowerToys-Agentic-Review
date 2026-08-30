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
import { ReviewControlRequestError, ReviewControlUnsupportedOperationError } from "./errors";
import { DashboardHttpClient, type DashboardHttpClientOptions } from "./http-client";
import {
  mapJobListResponse,
  mapSystemSnapshotResponse,
  mapWorkerListResponse,
  mapWorkItemListResponse,
} from "./http-mappers";
import type {
  Approval,
  ApprovalDecision,
  Job,
  ListQuery,
  PageResult,
  Publication,
  SystemSnapshot,
  WorkerNode,
  WorkItem,
} from "./types";

const endpoints = {
  jobs: "/api/v1/dashboard/jobs",
  system: "/api/v1/dashboard/system",
  workers: "/api/v1/dashboard/workers",
  workItems: "/api/v1/dashboard/work-items",
} as const;

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
  codex_review: true,
  codex_revision: true,
  completing: true,
  leased: true,
  preparing: true,
  uploading: true,
  validation: true,
} satisfies Record<ExecutionPhase, true>;

const jobStages = {
  ...executionPhases,
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
  if (entityId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(entityId)) {
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
    invalidRequest(operation, `query.filters.${unknown}`, "a supported filter name");
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
  assertKnownFilters(query.filters, ["authorization", "kind", "stage", "state"], operation);
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
  return withQuery(endpoints.workItems, parameters);
};

const buildJobPath = (query: ListQuery, operation: string): string => {
  assertKnownFilters(query.filters, ["phase", "stage", "status", "workItemId"], operation);
  const parameters = baseQuery(query, operation);
  appendEnumFilter(parameters, "status", query.filters?.status, operation, jobStates, 32);
  appendEnumFilter(parameters, "phase", query.filters?.phase, operation, executionPhases, 32);
  appendEnumFilter(parameters, "stage", query.filters?.stage, operation, jobStages, 32);
  appendEntityIdFilter(parameters, "workItemId", query.filters?.workItemId, operation);
  return withQuery(endpoints.jobs, parameters);
};

const buildWorkerPath = (query: ListQuery, operation: string): string => {
  assertKnownFilters(query.filters, ["status"], operation);
  const parameters = baseQuery(query, operation);
  appendEnumFilter(parameters, "status", query.filters?.status, operation, workerStates, 16);
  return withQuery(endpoints.workers, parameters);
};

export interface HttpReviewControlAdapterOptions extends DashboardHttpClientOptions {
  readonly client?: DashboardHttpClient;
}

export class HttpReviewControlAdapter implements ReviewControlAdapter {
  private readonly client: DashboardHttpClient;

  constructor(options: HttpReviewControlAdapterOptions = {}) {
    this.client = options.client ?? new DashboardHttpClient(options);
  }

  async listWorkItems(query: ListQuery = {}): Promise<PageResult<WorkItem>> {
    const operation = "listWorkItems";
    const response = await this.client.get(buildWorkItemPath(query, operation), operation);
    return mapWorkItemListResponse(response, operation);
  }

  async requeueWorkItem(_workItemId: string): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("requeueWorkItem");
  }

  async listJobs(query: ListQuery = {}): Promise<PageResult<Job>> {
    const operation = "listJobs";
    const response = await this.client.get(buildJobPath(query, operation), operation);
    return mapJobListResponse(response, operation);
  }

  async cancelJob(_jobId: string): Promise<void> {
    throw new ReviewControlUnsupportedOperationError("cancelJob");
  }

  async listWorkers(query: ListQuery = {}): Promise<PageResult<WorkerNode>> {
    const operation = "listWorkers";
    const response = await this.client.get(buildWorkerPath(query, operation), operation);
    return mapWorkerListResponse(response, operation);
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
