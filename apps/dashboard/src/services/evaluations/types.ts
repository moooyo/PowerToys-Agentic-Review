import type * as C from "@agentic-review/contracts";

export interface EvaluationSourceScope {
  readonly repositoryId: string;
  readonly sourceId: string;
}
export interface EvaluationSuiteScope {
  readonly repositoryId: string;
  readonly suiteId: string;
}
export interface EvaluationSuiteVersionScope extends EvaluationSuiteScope {
  readonly versionId: string;
}
export interface EvaluationSuiteCaseScope extends EvaluationSuiteVersionScope {
  readonly caseId: string;
}

export interface EvaluationAdapter {
  readonly mode: "connected";
  captureSource(
    repositoryId: string,
    request: C.EvaluationSourceCaptureRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationSourceSummaryV1>;
  listSources(
    repositoryId: string,
    query?: C.EvaluationSourceListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSourceListResponse>;
  getSource(
    scope: EvaluationSourceScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSourceDetailV1>;
  createSuite(
    repositoryId: string,
    request: C.EvaluationSuiteCreateRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationSuiteSummaryV1>;
  listSuites(
    repositoryId: string,
    query?: C.EvaluationSuiteListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSuiteListResponse>;
  getSuite(scope: EvaluationSuiteScope, signal?: AbortSignal): Promise<C.EvaluationSuiteDetailV1>;
  saveSuiteDraft(
    scope: EvaluationSuiteScope,
    request: C.EvaluationSuiteSaveRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationSuiteSummaryV1>;
  publishSuite(
    scope: EvaluationSuiteScope,
    request: C.EvaluationSuitePublishRequest,
    actor?: C.OperatorPrincipal,
  ): Promise<C.EvaluationSuiteVersionV1>;
  listSuiteVersions(
    scope: EvaluationSuiteScope,
    query?: C.EvaluationSuiteListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSuiteVersionListResponse>;
  getSuiteVersion(
    scope: EvaluationSuiteVersionScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSuiteVersionV1>;
  listSuiteCases(
    scope: EvaluationSuiteVersionScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSuiteCaseListV1>;
  getSuiteCase(
    scope: EvaluationSuiteCaseScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationSuiteCaseDetailV1>;
}
