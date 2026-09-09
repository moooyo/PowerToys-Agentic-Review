import * as C from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type {
  EvaluationAdapter,
  EvaluationSourceScope,
  EvaluationSuiteCaseScope,
  EvaluationSuiteScope,
  EvaluationSuiteVersionScope,
} from "./types";
import {
  EvaluationRepositoryScopeSchema,
  EvaluationSourceScopeSchema,
  EvaluationSuiteCaseScopeSchema,
  EvaluationSuiteScopeSchema,
  EvaluationSuiteVersionScopeSchema,
  evaluationActor,
  evaluationActorMatches,
  evaluationMatch,
  evaluationPageMatches,
  evaluationPageQuery,
  evaluationRequest,
  evaluationResponse,
} from "./validation";

const suiteDetailLimit = C.maximumEvaluationSuiteUtf8Bytes + 64 * 1024;
const repositoryPath = (repositoryId: string) => `/api/v1/operator/repositories/${repositoryId}`;
const suitePath = (scope: EvaluationSuiteScope) =>
  `${repositoryPath(scope.repositoryId)}/evaluation-suites/${scope.suiteId}`;
const versionPath = (scope: EvaluationSuiteVersionScope) =>
  `${suitePath(scope)}/versions/${scope.versionId}`;
const pageParameters = (query: { page: number; pageSize: number }) =>
  new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });

export class HttpEvaluationAdapter implements EvaluationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  private read(path: string, operation: string, maximumBytes: number, signal?: AbortSignal) {
    return this.client.get(path, operation, {
      ...(signal === undefined ? {} : { signal }),
      maxResponseBytes: maximumBytes,
    });
  }

  async captureSource(
    repositoryId: string,
    input: C.EvaluationSourceCaptureRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "capture evaluation source";
    const scope = evaluationRequest(EvaluationRepositoryScopeSchema, { repositoryId }, operation);
    const request = evaluationRequest(
      C.EvaluationSourceCaptureRequestSchema,
      input,
      operation,
      C.getEvaluationSourceCaptureRequestIssues,
      C.maximumEvaluationSourceCaptureRequestUtf8Bytes,
    );
    const actor = evaluationActor(principal, operation);
    const value = evaluationResponse(
      C.EvaluationSourceSummaryV1Schema,
      await this.client.post(
        `${repositoryPath(scope.repositoryId)}/evaluation-sources`,
        operation,
        request,
      ),
      operation,
      C.getEvaluationSourceSummaryIssues,
      C.maximumEvaluationSourceSummaryUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId && evaluationActorMatches(value.createdBy, actor),
      operation,
    );
    if (request.source.kind === "current_work_item")
      evaluationMatch(
        value.workItemId === request.source.workItemId &&
          value.revisionKey === request.source.expectedRevisionKey,
        operation,
      );
    return value;
  }

  async listSources(
    repositoryId: string,
    input: C.EvaluationSourceListQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation sources";
    const scope = evaluationRequest(EvaluationRepositoryScopeSchema, { repositoryId }, operation);
    const query = evaluationPageQuery(
      evaluationRequest(
        C.EvaluationSourceListQuerySchema,
        input,
        operation,
        C.getEvaluationSourceListQueryIssues,
      ),
    );
    const value = evaluationResponse(
      C.EvaluationSourceListResponseSchema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/evaluation-sources?${pageParameters(query)}`,
        operation,
        C.maximumEvaluationSourceSnapshotUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSourceListResponseIssues,
      C.maximumEvaluationSourceSnapshotUtf8Bytes,
    );
    evaluationMatch(evaluationPageMatches(value, scope.repositoryId, query), operation);
    return value;
  }

  async getSource(input: EvaluationSourceScope, signal?: AbortSignal) {
    const operation = "read evaluation source";
    const scope = evaluationRequest(EvaluationSourceScopeSchema, input, operation);
    const value = evaluationResponse(
      C.EvaluationSourceDetailV1Schema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/evaluation-sources/${scope.sourceId}`,
        operation,
        C.maximumEvaluationSourceDetailUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSourceDetailIssues,
      C.maximumEvaluationSourceDetailUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId && value.id === scope.sourceId,
      operation,
    );
    return value;
  }

  async createSuite(
    repositoryId: string,
    input: C.EvaluationSuiteCreateRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "create evaluation suite";
    const scope = evaluationRequest(EvaluationRepositoryScopeSchema, { repositoryId }, operation);
    const request = evaluationRequest(
      C.EvaluationSuiteCreateRequestSchema,
      input,
      operation,
      C.getEvaluationSuiteCreateRequestIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    const actor = evaluationActor(principal, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteSummaryV1Schema,
      await this.client.post(
        `${repositoryPath(scope.repositoryId)}/evaluation-suites`,
        operation,
        request,
      ),
      operation,
      C.getEvaluationSuiteSummaryIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.name === request.name &&
        value.description === request.description &&
        value.workflowKind === request.workflowKind &&
        value.target === request.target &&
        value.draftRevision === 1 &&
        value.caseCount === 0 &&
        value.latestVersionId === null &&
        evaluationActorMatches(value.createdBy, actor) &&
        evaluationActorMatches(value.updatedBy, actor),
      operation,
    );
    return value;
  }

  async listSuites(
    repositoryId: string,
    input: C.EvaluationSuiteListQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation suites";
    const scope = evaluationRequest(EvaluationRepositoryScopeSchema, { repositoryId }, operation);
    const query = evaluationPageQuery(
      evaluationRequest(
        C.EvaluationSuiteListQuerySchema,
        input,
        operation,
        C.getEvaluationSuiteListQueryIssues,
      ),
    );
    const value = evaluationResponse(
      C.EvaluationSuiteListResponseSchema,
      await this.read(
        `${repositoryPath(scope.repositoryId)}/evaluation-suites?${pageParameters(query)}`,
        operation,
        C.maximumEvaluationSuiteUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSuiteListResponseIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(evaluationPageMatches(value, scope.repositoryId, query), operation);
    return value;
  }

  async getSuite(input: EvaluationSuiteScope, signal?: AbortSignal) {
    const operation = "read evaluation suite";
    const scope = evaluationRequest(EvaluationSuiteScopeSchema, input, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteDetailV1Schema,
      await this.read(suitePath(scope), operation, suiteDetailLimit, signal),
      operation,
      C.getEvaluationSuiteDetailIssues,
      suiteDetailLimit,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId && value.id === scope.suiteId,
      operation,
    );
    return value;
  }

  async saveSuiteDraft(
    input: EvaluationSuiteScope,
    change: C.EvaluationSuiteSaveRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "save evaluation suite draft";
    const scope = evaluationRequest(EvaluationSuiteScopeSchema, input, operation);
    const request = evaluationRequest(
      C.EvaluationSuiteSaveRequestSchema,
      change,
      operation,
      C.getEvaluationSuiteSaveRequestIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    const actor = evaluationActor(principal, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteSummaryV1Schema,
      await this.client.put(`${suitePath(scope)}/draft`, operation, request),
      operation,
      C.getEvaluationSuiteSummaryIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.id === scope.suiteId &&
        value.draftRevision === request.expectedRevision + 1 &&
        value.name === request.draft.name &&
        value.description === request.draft.description &&
        value.caseCount === request.draft.cases.length &&
        evaluationActorMatches(value.updatedBy, actor),
      operation,
    );
    return value;
  }

  async publishSuite(
    input: EvaluationSuiteScope,
    change: C.EvaluationSuitePublishRequest,
    principal?: C.OperatorPrincipal,
  ) {
    const operation = "publish evaluation suite";
    const scope = evaluationRequest(EvaluationSuiteScopeSchema, input, operation);
    const request = evaluationRequest(
      C.EvaluationSuitePublishRequestSchema,
      change,
      operation,
      C.getEvaluationSuitePublishRequestIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    const actor = evaluationActor(principal, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteVersionV1Schema,
      await this.client.post(`${suitePath(scope)}/versions`, operation, request),
      operation,
      C.getEvaluationSuiteVersionIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.suiteId === scope.suiteId &&
        value.sourceDraftRevision === request.expectedRevision &&
        evaluationActorMatches(value.createdBy, actor),
      operation,
    );
    return value;
  }

  async listSuiteVersions(
    input: EvaluationSuiteScope,
    inputQuery: C.EvaluationSuiteListQuery = {},
    signal?: AbortSignal,
  ) {
    const operation = "list evaluation suite versions";
    const scope = evaluationRequest(EvaluationSuiteScopeSchema, input, operation);
    const query = evaluationPageQuery(
      evaluationRequest(
        C.EvaluationSuiteListQuerySchema,
        inputQuery,
        operation,
        C.getEvaluationSuiteListQueryIssues,
      ),
    );
    const value = evaluationResponse(
      C.EvaluationSuiteVersionListResponseSchema,
      await this.read(
        `${suitePath(scope)}/versions?${pageParameters(query)}`,
        operation,
        C.maximumEvaluationSuiteUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSuiteVersionListResponseIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(
      evaluationPageMatches(value, scope.repositoryId, query) && value.suiteId === scope.suiteId,
      operation,
    );
    return value;
  }

  async getSuiteVersion(input: EvaluationSuiteVersionScope, signal?: AbortSignal) {
    const operation = "read evaluation suite version";
    const scope = evaluationRequest(EvaluationSuiteVersionScopeSchema, input, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteVersionV1Schema,
      await this.read(versionPath(scope), operation, C.maximumEvaluationSuiteUtf8Bytes, signal),
      operation,
      C.getEvaluationSuiteVersionIssues,
      C.maximumEvaluationSuiteUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.suiteId === scope.suiteId &&
        value.id === scope.versionId,
      operation,
    );
    return value;
  }

  async listSuiteCases(input: EvaluationSuiteVersionScope, signal?: AbortSignal) {
    const operation = "list published evaluation cases";
    const scope = evaluationRequest(EvaluationSuiteVersionScopeSchema, input, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteCaseListV1Schema,
      await this.read(
        `${versionPath(scope)}/cases`,
        operation,
        C.maximumEvaluationSuiteCaseListUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSuiteCaseListIssues,
      C.maximumEvaluationSuiteCaseListUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.suiteId === scope.suiteId &&
        value.versionId === scope.versionId,
      operation,
    );
    return value;
  }

  async getSuiteCase(input: EvaluationSuiteCaseScope, signal?: AbortSignal) {
    const operation = "read published evaluation case";
    const scope = evaluationRequest(EvaluationSuiteCaseScopeSchema, input, operation);
    const value = evaluationResponse(
      C.EvaluationSuiteCaseDetailV1Schema,
      await this.read(
        `${versionPath(scope)}/cases/${scope.caseId}`,
        operation,
        C.maximumEvaluationSuiteCaseDetailUtf8Bytes,
        signal,
      ),
      operation,
      C.getEvaluationSuiteCaseDetailIssues,
      C.maximumEvaluationSuiteCaseDetailUtf8Bytes,
    );
    evaluationMatch(
      value.repositoryId === scope.repositoryId &&
        value.suiteId === scope.suiteId &&
        value.versionId === scope.versionId &&
        value.caseId === scope.caseId,
      operation,
    );
    return value;
  }
}

export function createHttpEvaluationAdapter(
  options: DashboardHttpClientOptions = {},
): EvaluationAdapter {
  return new HttpEvaluationAdapter(options);
}
