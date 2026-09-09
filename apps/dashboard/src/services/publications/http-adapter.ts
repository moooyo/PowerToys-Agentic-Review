import {
  defaultPublicationPageSize,
  getPublicationAttemptListIssues,
  getPublicationConfirmRequestIssues,
  getPublicationConfirmResponseIssues,
  getPublicationControlRequestIssues,
  getPublicationControlResponseIssues,
  getPublicationDetailIssues,
  getPublicationListIssues,
  getPublicationPreviewIssues,
  getRepositoryPublicationPolicyAuditEventIssues,
  getRepositoryPublicationPolicyAuditListIssues,
  getRepositoryPublicationPolicyIssues,
  maximumPublicationResponseUtf8Bytes,
  type PublicationAttemptListQuery,
  PublicationAttemptListQuerySchema,
  PublicationAttemptListResponseSchema,
  type PublicationConfirmRequest,
  PublicationConfirmRequestSchema,
  PublicationConfirmResponseSchema,
  type PublicationControlAction,
  PublicationControlActionSchema,
  type PublicationControlRequest,
  PublicationControlRequestSchema,
  PublicationControlResponseSchema,
  PublicationDetailSchema,
  type PublicationListQuery,
  PublicationListQuerySchema,
  PublicationListResponseSchema,
  type PublicationPreviewQuery,
  PublicationPreviewQuerySchema,
  PublicationPreviewSchema,
  type PublicationReadQuery,
  PublicationReadQuerySchema,
  RepositoryPublicationPolicyAuditEventSchema,
  type RepositoryPublicationPolicyAuditListQuery,
  RepositoryPublicationPolicyAuditListQuerySchema,
  RepositoryPublicationPolicyAuditListResponseSchema,
  RepositoryPublicationPolicySchema,
  type RepositoryPublicationPolicyUpdateRequest,
  RepositoryPublicationPolicyUpdateRequestSchema,
  RepositoryPublicationPolicyUpdateResponseSchema,
} from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { PublicationAdapter } from "./adapter";
import {
  assertPublicationMatch,
  publicationId,
  publicationRequest,
  publicationResponse,
} from "./validation";

const repositoryPath = (repositoryId: string) =>
  `/api/v1/operator/repositories/${publicationId(repositoryId)}`;
const pageQuery = (query: { page?: number; pageSize?: number }) =>
  new URLSearchParams({
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? defaultPublicationPageSize),
  });
export class HttpPublicationAdapter implements PublicationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  private read(path: string, operation: string, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      signal,
      maxResponseBytes: maximumPublicationResponseUtf8Bytes,
    });
  }
  async preview(scope: PublicationPreviewQuery, signal?: AbortSignal) {
    const operation = "preview publication",
      query = publicationRequest(PublicationPreviewQuerySchema, scope, operation);
    const parameters = new URLSearchParams({ decisionId: query.decisionId });
    return publicationResponse(
      PublicationPreviewSchema,
      await this.read(
        `${repositoryPath(query.repositoryId)}/review-runs/${query.reviewRunId}/publications/preview?${parameters}`,
        operation,
        signal,
      ),
      operation,
      (value) => getPublicationPreviewIssues(value, query),
    );
  }
  async confirm(scope: PublicationPreviewQuery, input: PublicationConfirmRequest) {
    const operation = "confirm publication",
      query = publicationRequest(PublicationPreviewQuerySchema, scope, operation),
      request = publicationRequest(PublicationConfirmRequestSchema, input, operation);
    if (
      request.expectedSelectedDecisionId !== query.decisionId ||
      getPublicationConfirmRequestIssues(request).length > 0
    )
      throw new Error("The confirmation does not match the selected decision.");
    const result = publicationResponse(
      PublicationConfirmResponseSchema,
      await this.client.post(
        `${repositoryPath(query.repositoryId)}/review-runs/${query.reviewRunId}/publications`,
        operation,
        request,
      ),
      operation,
      (value) =>
        getPublicationConfirmResponseIssues(value, request, {
          repositoryId: query.repositoryId,
          publicationId: request.publicationId,
        }),
    );
    const intent = result.intent,
      binding = intent.binding;
    assertPublicationMatch(
      intent.confirmationChangeId === request.changeId &&
        intent.rendererVersion === request.rendererVersion &&
        intent.payloadSha256 === request.expectedPayloadSha256 &&
        intent.publisherGitHubUserId === request.expectedPublisherGitHubUserId &&
        binding.reviewRunId === query.reviewRunId &&
        binding.selectedDecisionId === query.decisionId &&
        binding.selectedDecisionVersion === request.expectedSelectedDecisionVersion &&
        binding.decisionContextVersion === request.expectedDecisionContextVersion &&
        binding.revisionKey === request.expectedRevisionKey &&
        binding.planDigest === request.expectedPlanDigest &&
        binding.resultSetDigest === request.expectedResultSetDigest,
      operation,
    );
    return result;
  }
  async list(input: PublicationListQuery, signal?: AbortSignal) {
    const operation = "list publications",
      query = publicationRequest(PublicationListQuerySchema, input, operation),
      parameters = pageQuery(query);
    if (query.reviewRunId) parameters.set("reviewRunId", query.reviewRunId);
    if (query.status) parameters.set("status", query.status);
    return publicationResponse(
      PublicationListResponseSchema,
      await this.read(
        `${repositoryPath(query.repositoryId)}/publications?${parameters}`,
        operation,
        signal,
      ),
      operation,
      (value) => getPublicationListIssues(value, query),
    );
  }
  async get(input: PublicationReadQuery, signal?: AbortSignal) {
    const operation = "read publication",
      scope = publicationRequest(PublicationReadQuerySchema, input, operation);
    return publicationResponse(
      PublicationDetailSchema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/publications/${scope.publicationId}`,
        operation,
        signal,
      ),
      operation,
      (value) => getPublicationDetailIssues(value, scope),
    );
  }
  async attempts(input: PublicationAttemptListQuery, signal?: AbortSignal) {
    const operation = "read publication attempts",
      query = publicationRequest(PublicationAttemptListQuerySchema, input, operation);
    return publicationResponse(
      PublicationAttemptListResponseSchema,
      await this.read(
        `${repositoryPath(query.repositoryId)}/publications/${query.publicationId}/attempts?${pageQuery(query)}`,
        operation,
        signal,
      ),
      operation,
      (value) => getPublicationAttemptListIssues(value, query),
    );
  }
  async control(
    input: PublicationReadQuery,
    action: PublicationControlAction,
    body: PublicationControlRequest,
  ) {
    const operation = `${action} publication`,
      scope = publicationRequest(PublicationReadQuerySchema, input, operation),
      request = publicationRequest(PublicationControlRequestSchema, body, operation);
    publicationRequest(PublicationControlActionSchema, action, operation);
    if (getPublicationControlRequestIssues(request).length > 0)
      throw new Error("The publication action is invalid.");
    const result = publicationResponse(
      PublicationControlResponseSchema,
      await this.client.post(
        `${repositoryPath(scope.repositoryId)}/publications/${scope.publicationId}/${action}`,
        operation,
        request,
      ),
      operation,
      (value) => getPublicationControlResponseIssues(value, scope, request, action),
    );
    assertPublicationMatch(
      result.change.action === action &&
        result.change.changeId === request.changeId &&
        result.change.previousVersion === request.expectedVersion &&
        result.change.payloadSha256 === request.expectedPayloadSha256,
      operation,
    );
    return result;
  }
  async policy(repositoryId: string, signal?: AbortSignal) {
    const operation = "read publication policy";
    return publicationResponse(
      RepositoryPublicationPolicySchema,
      await this.read(`${repositoryPath(repositoryId)}/publication-policy`, operation, signal),
      operation,
      (value) => [
        ...getRepositoryPublicationPolicyIssues(value),
        ...(value.repositoryId === repositoryId ? [] : ["scope_mismatch"]),
      ],
    );
  }
  async updatePolicy(repositoryId: string, input: RepositoryPublicationPolicyUpdateRequest) {
    const operation = "update publication policy",
      request = publicationRequest(
        RepositoryPublicationPolicyUpdateRequestSchema,
        input,
        operation,
      );
    const result = publicationResponse(
      RepositoryPublicationPolicyUpdateResponseSchema,
      await this.client.patch(
        `${repositoryPath(repositoryId)}/publication-policy`,
        operation,
        request,
      ),
      operation,
      (value) => getRepositoryPublicationPolicyAuditEventIssues(value.change),
    );
    assertPublicationMatch(
      result.change.repositoryId === repositoryId &&
        result.change.changeId === request.changeId &&
        result.change.previousVersion === request.expectedVersion &&
        result.change.snapshot.enabled === request.enabled,
      operation,
    );
    return result;
  }
  async policyActivity(input: RepositoryPublicationPolicyAuditListQuery, signal?: AbortSignal) {
    const operation = "read publication policy activity",
      query = publicationRequest(RepositoryPublicationPolicyAuditListQuerySchema, input, operation);
    return publicationResponse(
      RepositoryPublicationPolicyAuditListResponseSchema,
      await this.read(
        `${repositoryPath(query.repositoryId)}/publication-policy/activity?${pageQuery(query)}`,
        operation,
        signal,
      ),
      operation,
      (value) => getRepositoryPublicationPolicyAuditListIssues(value, query),
    );
  }
  async policyEvent(repositoryId: string, eventId: string, signal?: AbortSignal) {
    const operation = "read publication policy event";
    return publicationResponse(
      RepositoryPublicationPolicyAuditEventSchema,
      await this.read(
        `${repositoryPath(repositoryId)}/publication-policy/activity/${publicationId(eventId, operation)}`,
        operation,
        signal,
      ),
      operation,
      (value) => [
        ...getRepositoryPublicationPolicyAuditEventIssues(value),
        ...(value.repositoryId === repositoryId && value.id === eventId ? [] : ["scope_mismatch"]),
      ],
    );
  }
}
