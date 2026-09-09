import {
  type DashboardReviewRunDetail,
  type DashboardReviewRunJobListResponse,
  type DashboardReviewRunListResponse,
  type DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseQuerySchema,
  type DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunReproductionCaseResponseSchema,
  type DashboardReviewRunResult,
  type OperatorReviewRunCancelResponse,
  OperatorReviewRunCancelResponseSchema,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
  type OperatorReviewRunRerunRequest,
  OperatorReviewRunRerunRequestSchema,
  type OperatorReviewRunRerunResponse,
  OperatorReviewRunRerunResponseSchema,
} from "@agentic-review/contracts";
import { ReviewControlHttpError, ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { ReviewRunAdapter, ReviewRunJobListQuery, ReviewRunListQuery } from "./adapter";
import {
  validateCreatedReproduction,
  validateRunProbeReceiptDigests,
  validateRunReproductionCase,
} from "./reproduction-validation";
import {
  normalizeRunJobQuery,
  normalizeRunPageQuery,
  runPageQueryString,
  validateResponse,
  validateRunDetail,
  validateRunEntityId,
  validateRunJobs,
  validateRunList,
  validateRunRequest,
  validateRunResult,
} from "./validation";

function repositoryPath(repositoryId: string, operation: string): string {
  validateRunEntityId(repositoryId, operation, "repositoryId");
  return `/api/v1/operator/repositories/${repositoryId}`;
}

function runPath(repositoryId: string, reviewRunId: string, operation: string): string {
  validateRunEntityId(reviewRunId, operation, "reviewRunId");
  return `${repositoryPath(repositoryId, operation)}/review-runs/${reviewRunId}`;
}

function requestPath(
  repositoryId: string,
  reviewRunId: string,
  requestId: string,
  operation: string,
): string {
  validateRunEntityId(requestId, operation, "requestId");
  return `${runPath(repositoryId, reviewRunId, operation)}/requests/${requestId}`;
}

export class HttpReviewRunAdapter implements ReviewRunAdapter {
  readonly mode = "connected";
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async rerun(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    input: OperatorReviewRunRerunRequest,
  ): Promise<OperatorReviewRunRerunResponse> {
    const operation = "rerun validation profile";
    const path = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/reruns`;
    validateRunRequest(OperatorReviewRunRerunRequestSchema, input, operation);
    return validateResponse(
      OperatorReviewRunRerunResponseSchema,
      await this.client.post(path, operation, input),
      operation,
      { repositoryId, reviewRunId, requestId },
    );
  }

  async cancel(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    jobId: string,
  ): Promise<OperatorReviewRunCancelResponse> {
    const operation = "cancel validation job";
    validateRunEntityId(jobId, operation, "jobId");
    const path = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/jobs/${jobId}/cancel`;
    return validateResponse(
      OperatorReviewRunCancelResponseSchema,
      await this.client.post(path, operation, {}),
      operation,
      { repositoryId, reviewRunId, requestId, jobId },
    );
  }

  async list(
    repositoryId: string,
    query?: ReviewRunListQuery,
  ): Promise<DashboardReviewRunListResponse> {
    const operation = "list review runs";
    const path = `${repositoryPath(repositoryId, operation)}/review-runs`;
    const pagination = normalizeRunPageQuery(query, true);
    return validateRunList(
      await this.client.get(`${path}?${runPageQueryString(pagination)}`, operation),
      repositoryId,
      pagination,
      operation,
    );
  }

  async create(
    repositoryId: string,
    workItemId: string,
    input: OperatorReviewRunCreateRequest,
  ): Promise<DashboardReviewRunDetail> {
    const operation = "create review run";
    validateRunEntityId(workItemId, operation, "workItemId");
    const path = `${repositoryPath(repositoryId, operation)}/work-items/${workItemId}/review-runs`;
    validateRunRequest(OperatorReviewRunCreateRequestSchema, input, operation);
    // The caller retains activationId until this creation intent succeeds or is explicitly discarded.
    const result = validateRunDetail(await this.client.post(path, operation, input), operation, {
      repositoryId,
      workItemId,
      activationId: input.activationId,
      revisionKey: input.expectedRevisionKey,
    });
    if (
      input.profileIds?.some(
        (id) => !result.requests.some((request) => request.profile?.profileId === id),
      ) ||
      (input.testedSourceCommit !== undefined &&
        (result.testedSourceRevision?.kind !== "commit" ||
          result.testedSourceRevision.headSha !== input.testedSourceCommit))
    )
      throw new ReviewControlProtocolError(
        operation,
        "The created review run does not match the selected profiles or source commit.",
      );
    validateCreatedReproduction(result, input, operation);
    return result;
  }

  async get(repositoryId: string, reviewRunId: string): Promise<DashboardReviewRunDetail> {
    const operation = "get review run";
    return validateRunDetail(
      await this.client.get(runPath(repositoryId, reviewRunId, operation), operation),
      operation,
      { repositoryId, id: reviewRunId },
    );
  }

  async getReproductionCase(
    query: DashboardReviewRunReproductionCaseQuery,
  ): Promise<DashboardReviewRunReproductionCaseResponse> {
    const operation = "get review run reproduction case";
    validateRunRequest(DashboardReviewRunReproductionCaseQuerySchema, query, operation);
    const { repositoryId, reviewRunId, requestId, caseId, jobId } = query;
    const path = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/reproduction-cases/${caseId}`;
    const detail = await this.get(repositoryId, reviewRunId);
    if (
      !detail.reproduction?.cases.some(
        (entry) => entry.caseId === caseId && entry.requestId === requestId,
      )
    )
      throw new ReviewControlProtocolError(
        operation,
        "The selected reproduction case does not belong to this frozen request.",
      );
    const response = validateResponse(
      DashboardReviewRunReproductionCaseResponseSchema,
      await this.client.get(
        jobId === undefined ? path : `${path}?${new URLSearchParams({ jobId })}`,
        operation,
      ),
      operation,
      { repositoryId, reviewRunId, requestId, caseId, ...(jobId === undefined ? {} : { jobId }) },
    );
    let result: DashboardReviewRunResult | null = null;
    if (response.resultId !== null) {
      if (response.jobId === null)
        throw new ReviewControlProtocolError(
          operation,
          "The reproduction result does not identify a job.",
        );
      const resultPath = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/jobs/${response.jobId}/result`;
      const latest = detail.requests.find((entry) => entry.requestId === requestId)?.latestJob;
      // A selected case may complete or activate after the initial bounded summary read.
      const resultDetail =
        latest?.jobId === response.jobId &&
        latest.status === "succeeded" &&
        latest.resultId === response.resultId
          ? detail
          : await this.get(repositoryId, reviewRunId);
      if (
        resultDetail.planDigest !== detail.planDigest ||
        resultDetail.revisionKey !== detail.revisionKey ||
        resultDetail.reproduction?.bindingDigest !== detail.reproduction?.bindingDigest
      )
        throw new ReviewControlProtocolError(
          operation,
          "The frozen reproduction scope changed between reads.",
        );
      result = validateRunResult(
        await this.client.get(resultPath, operation),
        resultDetail,
        requestId,
        response.jobId,
        operation,
      );
      await validateRunProbeReceiptDigests(result, operation);
    }
    return validateRunReproductionCase(response, query, detail, result, operation);
  }

  async listJobs(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    query?: ReviewRunJobListQuery,
  ): Promise<DashboardReviewRunJobListResponse> {
    const operation = "list review run jobs";
    const path = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/jobs`;
    const pagination = normalizeRunJobQuery(query);
    return validateRunJobs(
      await this.client.get(`${path}?${runPageQueryString(pagination)}`, operation),
      repositoryId,
      reviewRunId,
      requestId,
      pagination,
      operation,
    );
  }

  async getResult(
    repositoryId: string,
    reviewRunId: string,
    requestId: string,
    jobId: string,
  ): Promise<DashboardReviewRunResult | null> {
    const operation = "get review run result";
    validateRunEntityId(jobId, operation, "jobId");
    const path = `${requestPath(repositoryId, reviewRunId, requestId, operation)}/jobs/${jobId}/result`;
    // Run details contain only bounded previews. Full reports are fetched for this selected job only.
    const detail = await this.get(repositoryId, reviewRunId);
    if (!detail.requests.some((request) => request.requestId === requestId))
      throw new ReviewControlProtocolError(
        operation,
        "The selected request does not belong to this review run.",
      );
    let value: unknown;
    try {
      value = await this.client.get(path, operation);
    } catch (error) {
      if (
        error instanceof ReviewControlHttpError &&
        error.status === 404 &&
        error.serverCode === "review_run_not_found"
      )
        return null;
      throw error;
    }
    const result = validateRunResult(value, detail, requestId, jobId, operation);
    await validateRunProbeReceiptDigests(result, operation);
    return result;
  }
}
