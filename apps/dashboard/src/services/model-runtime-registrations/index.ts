import * as C from "@agentic-review/contracts";
import {
  evaluationBatchActor,
  evaluationBatchActorMatches,
  evaluationBatchMatch,
  evaluationBatchPageQuery,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "../evaluation-batches/validation";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";

export interface ModelRuntimeRegistrationAdapter {
  readonly mode: "connected";
  register(
    request: C.ModelRuntimeRegisterRequest,
    actor: C.OperatorPrincipal,
  ): Promise<C.ModelRuntimeStatusV1>;
  changeControl(
    id: string,
    request: C.ModelRuntimeControlRequest,
    actor: C.OperatorPrincipal,
  ): Promise<C.ModelRuntimeStatusV1>;
  list(query?: C.ModelRuntimeListQuery, signal?: AbortSignal): Promise<C.ModelRuntimeListV1>;
  get(id: string, signal?: AbortSignal): Promise<C.ModelRuntimeStatusV1>;
  history(
    id: string,
    query?: C.ModelRuntimeHistoryQuery,
    signal?: AbortSignal,
  ): Promise<C.ModelRuntimeHistoryV1>;
  options(
    repositoryId: string,
    query?: C.ModelRuntimeOptionsQuery,
    signal?: AbortSignal,
  ): Promise<C.ModelRuntimeOptionsV1>;
}
const root = "/api/v1/operator/model-runtimes";
const budget = C.maximumModelRuntimeRegistryReadUtf8Bytes;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new Error("The canonical identity must contain JSON values.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
function entityId(value: string, operation: string): string {
  return evaluationBatchRequest(
    C.ModelRuntimeControlV1Schema.properties.registrationId,
    value,
    operation,
  );
}
function actor(input: C.OperatorPrincipal, operation: string): C.OperatorPrincipal {
  const value = evaluationBatchActor(input, operation);
  if (!value)
    throw new ReviewControlRequestError(
      operation,
      "actor",
      "A signed-in platform administrator identity is required.",
    );
  return value;
}
function parameters(query: { page: number; pageSize: number }): URLSearchParams {
  return new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
}
function pageMatches(
  value: { page: number; pageSize: number },
  query: { page: number; pageSize: number },
  operation: string,
): void {
  evaluationBatchMatch(value.page === query.page && value.pageSize === query.pageSize, operation);
}
async function verifyIdentity(
  value: C.ModelRuntimeRegistrationV1,
  operation: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let digest: string;
  try {
    const result = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value.identity)),
    );
    digest = [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ReviewControlProtocolError(
      operation,
      "The registered expected identity could not be verified.",
    );
  }
  signal?.throwIfAborted();
  evaluationBatchMatch(digest === value.identitySha256, operation);
}

export class HttpModelRuntimeRegistrationAdapter implements ModelRuntimeRegistrationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  private read(path: string, operation: string, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      ...(signal === undefined ? {} : { signal }),
      maxResponseBytes: budget,
    });
  }
  private async status(raw: unknown, operation: string, signal?: AbortSignal) {
    const value = evaluationBatchResponse(
      C.ModelRuntimeStatusV1Schema,
      raw,
      operation,
      C.getModelRuntimeStatusIssues,
      budget,
    );
    await verifyIdentity(value.registration, operation, signal);
    return value;
  }
  async register(input: C.ModelRuntimeRegisterRequest, principal: C.OperatorPrincipal) {
    const operation = "register expected model runtime";
    const request = evaluationBatchRequest(
      C.ModelRuntimeRegisterRequestSchema,
      input,
      operation,
      C.getModelRuntimeRegisterRequestIssues,
      C.maximumModelRuntimeRegistryRequestUtf8Bytes,
    );
    const expectedActor = actor(principal, operation);
    const value = await this.status(await this.client.post(root, operation, request), operation);
    evaluationBatchMatch(
      value.registration.name === request.name &&
        value.registration.requestedModel === request.requestedModel &&
        canonical(value.registration.identity) === canonical(request.identity) &&
        evaluationBatchActorMatches(value.registration.createdBy, expectedActor) &&
        value.control.version === 1 &&
        value.control.enabled === request.enabled &&
        evaluationBatchActorMatches(value.control.updatedBy, expectedActor),
      operation,
    );
    return value;
  }
  async changeControl(
    id: string,
    input: C.ModelRuntimeControlRequest,
    principal: C.OperatorPrincipal,
  ) {
    const operation = "change model runtime selection control";
    const registrationId = entityId(id, operation);
    const request = evaluationBatchRequest(
      C.ModelRuntimeControlRequestSchema,
      input,
      operation,
      C.getModelRuntimeControlRequestIssues,
      C.maximumModelRuntimeRegistryRequestUtf8Bytes,
    );
    const expectedActor = actor(principal, operation);
    const value = await this.status(
      await this.client.patch(`${root}/${registrationId}`, operation, request),
      operation,
    );
    evaluationBatchMatch(
      value.registration.id === registrationId &&
        value.control.version === request.expectedVersion + 1 &&
        value.control.enabled === request.enabled &&
        evaluationBatchActorMatches(value.control.updatedBy, expectedActor),
      operation,
    );
    return value;
  }
  async list(input: C.ModelRuntimeListQuery = {}, signal?: AbortSignal) {
    const operation = "list model runtime registrations";
    const filters = evaluationBatchRequest(
      C.ModelRuntimeListQuerySchema,
      input,
      operation,
      C.getModelRuntimeListQueryIssues,
    );
    const query = evaluationBatchPageQuery(filters),
      search = parameters(query);
    if (filters.enabled !== undefined) search.set("enabled", String(filters.enabled));
    const value = evaluationBatchResponse(
      C.ModelRuntimeListV1Schema,
      await this.read(`${root}?${search}`, operation, signal),
      operation,
      C.getModelRuntimeListIssues,
      budget,
    );
    pageMatches(value, query, operation);
    evaluationBatchMatch(
      value.items.every(
        (item) => filters.enabled === undefined || item.control.enabled === filters.enabled,
      ),
      operation,
    );
    for (const item of value.items) await verifyIdentity(item.registration, operation, signal);
    return value;
  }
  async get(id: string, signal?: AbortSignal) {
    const operation = "read model runtime registration";
    const registrationId = entityId(id, operation);
    const value = await this.status(
      await this.read(`${root}/${registrationId}`, operation, signal),
      operation,
      signal,
    );
    evaluationBatchMatch(value.registration.id === registrationId, operation);
    return value;
  }
  async history(id: string, input: C.ModelRuntimeHistoryQuery = {}, signal?: AbortSignal) {
    const operation = "read model runtime registration history";
    const registrationId = entityId(id, operation);
    const query = evaluationBatchPageQuery(
      evaluationBatchRequest(
        C.ModelRuntimeHistoryQuerySchema,
        input,
        operation,
        C.getModelRuntimeHistoryQueryIssues,
      ),
    );
    const value = evaluationBatchResponse(
      C.ModelRuntimeHistoryV1Schema,
      await this.read(`${root}/${registrationId}/history?${parameters(query)}`, operation, signal),
      operation,
      C.getModelRuntimeHistoryIssues,
      budget,
    );
    evaluationBatchMatch(value.registrationId === registrationId, operation);
    pageMatches(value, query, operation);
    return value;
  }
  async options(id: string, input: C.ModelRuntimeOptionsQuery = {}, signal?: AbortSignal) {
    const operation = "list evaluation model runtime options";
    const repositoryId = entityId(id, operation);
    const query = evaluationBatchPageQuery(
      evaluationBatchRequest(
        C.ModelRuntimeOptionsQuerySchema,
        input,
        operation,
        C.getModelRuntimeOptionsQueryIssues,
      ),
    );
    const value = evaluationBatchResponse(
      C.ModelRuntimeOptionsV1Schema,
      await this.read(
        `/api/v1/operator/repositories/${repositoryId}/evaluation-model-runtime-options?${parameters(query)}`,
        operation,
        signal,
      ),
      operation,
      C.getModelRuntimeOptionsIssues,
      budget,
    );
    evaluationBatchMatch(value.repositoryId === repositoryId, operation);
    pageMatches(value, query, operation);
    for (const item of value.items) await verifyIdentity(item, operation, signal);
    return value;
  }
}
export function createHttpModelRuntimeRegistrationAdapter(
  options: DashboardHttpClientOptions = {},
): ModelRuntimeRegistrationAdapter {
  return new HttpModelRuntimeRegistrationAdapter(options);
}
