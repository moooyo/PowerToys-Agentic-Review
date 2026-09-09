import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJobListResponse,
  DashboardReviewRunListResponse,
  DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  OperatorReviewRunCancelResponse,
  OperatorReviewRunCreateRequest,
  OperatorReviewRunRerunRequest,
  OperatorReviewRunRerunResponse,
} from "@agentic-review/contracts";

export interface ReviewRunPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ReviewRunListQuery extends ReviewRunPageQuery {
  readonly workItemId?: string;
}

export interface ReviewRunJobListQuery extends ReviewRunPageQuery {
  readonly jobId?: string;
}

export interface ReviewRunAdapter {
  readonly mode: "connected" | "sample";
  rerun(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    input: OperatorReviewRunRerunRequest,
  ): Promise<OperatorReviewRunRerunResponse>;
  cancel(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    jobId: string,
  ): Promise<OperatorReviewRunCancelResponse>;
  list(repositoryId: string, query?: ReviewRunListQuery): Promise<DashboardReviewRunListResponse>;
  create(
    repositoryId: string,
    workItemId: string,
    input: OperatorReviewRunCreateRequest,
  ): Promise<DashboardReviewRunDetail>;
  get(repositoryId: string, reviewRunId: string): Promise<DashboardReviewRunDetail>;
  getReproductionCase(
    query: DashboardReviewRunReproductionCaseQuery,
  ): Promise<DashboardReviewRunReproductionCaseResponse>;
  listJobs(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    query?: ReviewRunJobListQuery,
  ): Promise<DashboardReviewRunJobListResponse>;
  getResult(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    jobId: string,
  ): Promise<DashboardReviewRunResult | null>;
}
