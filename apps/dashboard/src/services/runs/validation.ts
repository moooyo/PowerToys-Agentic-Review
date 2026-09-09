import {
  type DashboardReviewRunDetail,
  DashboardReviewRunDetailSchema,
  type DashboardReviewRunJob,
  DashboardReviewRunJobListResponseSchema,
  DashboardReviewRunListResponseSchema,
  type DashboardReviewRunRequest,
  type DashboardReviewRunResult,
  DashboardReviewRunResultSchema,
  type DashboardReviewRunSummary,
  type DashboardValidationOutcomeCounts,
  type DashboardValidationResultSummary,
  EntityIdSchema,
  getJobAdmissionIssues,
  maximumDashboardReviewRunFindingPreviewCount,
  maximumDashboardReviewRunPageSize,
  maximumDashboardReviewRunResponseUtf8Bytes,
  maximumOperatorReviewRunCreateRequestUtf8Bytes,
  OperatorReviewRunCreateRequestSchema,
  PositiveIntegerSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { ReviewRunJobListQuery, ReviewRunListQuery, ReviewRunPageQuery } from "./adapter";
import {
  validateReproductionCreateRequest,
  validateRunReproductionSummary,
  validateRunResultReproduction,
} from "./reproduction-validation";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
);
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const qualifiedIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,256}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const pageProperties = {
  page: Type.Optional(PositiveIntegerSchema),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumDashboardReviewRunPageSize })),
};
const PageQuerySchema = Type.Object(pageProperties, { additionalProperties: false });
const ListQuerySchema = Type.Object(
  { ...pageProperties, workItemId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);
const JobListQuerySchema = Type.Object(
  { ...pageProperties, jobId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);

export interface NormalizedReviewRunQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly workItemId?: string;
  readonly jobId?: string;
}

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value) return false;
    if (
      (key === "id" || key.endsWith("Id") || key.endsWith("Ids")) &&
      !qualifiedIdPattern.test(value)
    )
      return false;
    if (key === "testedSourceCommit" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(value))
      return false;
  }
  if (Array.isArray(value)) return value.every((entry) => validWireValue(entry, key));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([entryKey, entry]) => validWireValue(entry, entryKey));
  return typeof value !== "number" || Number.isFinite(value);
}

export function validateRunRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value))
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  if ((schema as TSchema) === OperatorReviewRunCreateRequestSchema) {
    if (
      encoder.encode(JSON.stringify(value)).byteLength >
      maximumOperatorReviewRunCreateRequestUtf8Bytes
    )
      throw new ReviewControlRequestError(
        operation,
        "request",
        "The create review run request exceeds the 2 MiB UTF-8 limit.",
      );
    validateReproductionCreateRequest(
      value as Static<typeof OperatorReviewRunCreateRequestSchema>,
      operation,
    );
  }
  return value;
}

export function validateRunEntityId(value: string, operation: string, path = "id"): void {
  if (typeof value !== "string" || !entityIdPattern.test(value))
    throw new ReviewControlRequestError(
      operation,
      path,
      "A valid review run entity ID is required.",
    );
}

export function normalizeRunPageQuery(
  query: ReviewRunPageQuery | ReviewRunListQuery = {},
  allowWorkItem = false,
): NormalizedReviewRunQuery {
  const operation = "list review runs";
  validateRunRequest(allowWorkItem ? ListQuerySchema : PageQuerySchema, query, operation);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (!Number.isSafeInteger((page - 1) * pageSize))
    throw new ReviewControlRequestError(operation, "page", "The requested page is too large.");
  return {
    page,
    pageSize,
    ...("workItemId" in query && query.workItemId !== undefined
      ? { workItemId: query.workItemId }
      : {}),
  };
}

export function runPageQueryString(query: NormalizedReviewRunQuery): string {
  const parameters = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.workItemId !== undefined) parameters.set("workItemId", query.workItemId);
  if (query.jobId !== undefined) parameters.set("jobId", query.jobId);
  return parameters.toString();
}

export function normalizeRunJobQuery(query: ReviewRunJobListQuery = {}): NormalizedReviewRunQuery {
  validateRunRequest(JobListQuerySchema, query, "list review run jobs");
  return {
    ...normalizeRunPageQuery({
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    }),
    ...(query.jobId === undefined ? {} : { jobId: query.jobId }),
  };
}

type ResponseScope = Readonly<Record<string, string | number | boolean | null>>;

function invalid(operation: string, reason: string): never {
  throw new ReviewControlProtocolError(operation, `The ${operation} response ${reason}.`);
}

export function validateResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  scope: ResponseScope = {},
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) invalid(operation, "is invalid");
  if (encoder.encode(JSON.stringify(value)).byteLength > maximumDashboardReviewRunResponseUtf8Bytes)
    invalid(operation, "exceeds the 2 MiB UTF-8 limit");
  const record = value as Record<string, unknown>;
  if (Object.entries(scope).some(([key, expected]) => record[key] !== expected))
    invalid(operation, "belongs to another review run or repository");
  return value;
}

function validatePagination<T>(
  result: { items: T[]; total: number; page: number; pageSize: number },
  query: NormalizedReviewRunQuery,
  operation: string,
  key: (item: T) => string,
): void {
  const offset = (query.page - 1) * query.pageSize;
  if (
    result.page !== query.page ||
    result.pageSize !== query.pageSize ||
    result.items.length > query.pageSize ||
    result.items.length > result.total ||
    (result.items.length > 0 && offset + result.items.length > result.total) ||
    new Set(result.items.map(key)).size !== result.items.length
  )
    invalid(operation, "contains inconsistent pagination or duplicate items");
}

function validateSummary(summary: DashboardReviewRunSummary, operation: string): void {
  if (
    summary.requiredRequestCount > summary.requestCount ||
    Object.values(summary.execution).reduce((sum, count) => sum + count, 0) !==
      summary.requestCount ||
    // Equal revisions do not establish an active authorization or source activation.
    // The server can supersede an older run even when the repository returns to the same SHA.
    (summary.freshness === "current" && summary.revisionKey !== summary.currentRevisionKey)
  )
    invalid(operation, "contains inconsistent execution counts or revision metadata");
}

function validateJob(job: DashboardReviewRunJob, operation: string): void {
  if (getJobAdmissionIssues(job).length > 0)
    invalid(operation, "contains an inconsistent job admission episode");
  if ((job.resultId === null) !== (job.resultDigest === null))
    invalid(operation, "contains an incomplete result identity");
  if (job.resultId !== null && (job.status !== "succeeded" || job.runAttemptId === null))
    invalid(operation, "attaches a result to an unsuccessful execution");
}

function validateRequestSummary(request: DashboardReviewRunRequest, operation: string): void {
  if (request.latestJob !== null) validateJob(request.latestJob, operation);
  const result = request.latestResult;
  if (result === null) return;
  validateEvidenceVerification(result, operation);
  if (
    request.latestJob === null ||
    request.latestJob.status !== "succeeded" ||
    request.latestJob.resultId !== result.id ||
    request.latestJob.resultDigest !== result.resultDigest ||
    result.findingCount < result.findings.length ||
    (!result.findingsTruncated && result.findingCount !== result.findings.length) ||
    result.evidenceCount < result.evidenceIds.length ||
    result.evidenceTruncated !== result.evidenceCount > result.evidenceIds.length
  )
    invalid(operation, "contains inconsistent result summary metadata");
}

function validateEvidenceVerification(
  value: { evidenceComplete: boolean; evidenceVerificationPending?: true },
  operation: string,
): void {
  if (value.evidenceVerificationPending === true && value.evidenceComplete)
    invalid(operation, "claims complete evidence while verification is pending");
}

function previewText(value: string, maximumLength: number): string {
  const shortened = value.slice(0, maximumLength);
  const lastCodeUnit = shortened.charCodeAt(shortened.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? shortened.slice(0, -1) : shortened;
}

function immutableResultPreview(result: DashboardReviewRunResult) {
  const checks: DashboardValidationOutcomeCounts = {
    passed: 0,
    failed: 0,
    blocked: 0,
    not_run: 0,
    skipped: 0,
    inconclusive: 0,
  };
  for (const check of result.report.checks) checks[check.outcome]++;
  const findings = [
    ...result.modelReview.findings.map((finding) => ({
      id: finding.findingId,
      priority: finding.priority,
      title: finding.title,
      body: finding.body,
      path: finding.path,
      line: finding.line,
    })),
    ...result.modelReview.observations,
  ].sort((left, right) => left.priority - right.priority);
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return {
    id: result.id,
    resultDigest: result.resultDigest,
    createdAt: result.createdAt,
    summary: previewText(result.report.summary, 1_024),
    summaryTruncated: result.report.summary.length > 1_024,
    sourceState: result.report.sourceState,
    checks,
    modelReviewState: result.modelReview.state,
    recommendation: result.modelReview.recommendation,
    reproductionConclusion:
      result.report.workItemKind === "issue" ? result.report.reproductionConclusion : null,
    findings: findings
      .slice(0, maximumDashboardReviewRunFindingPreviewCount)
      .map((finding) => ({ ...finding, body: previewText(finding.body, 512) })),
    findingCount: findings.length,
    findingsTruncated:
      findings.length > maximumDashboardReviewRunFindingPreviewCount ||
      findings.some((finding) => finding.body.length > 512),
    evidenceIds: evidenceIds.slice(0, 32),
    evidenceCount: evidenceIds.length,
    evidenceTruncated: evidenceIds.length > 32,
    lifecycleBlockerCount: result.execution.blockers.length,
  } satisfies Omit<
    DashboardValidationResultSummary,
    "evidenceComplete" | "evidenceVerificationPending"
  >;
}

function equivalentJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => equivalentJson(item, right[index]))
    );
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return (
    Object.keys(leftRecord).length === Object.keys(rightRecord).length &&
    Object.entries(leftRecord).every(
      ([key, value]) => Object.hasOwn(rightRecord, key) && equivalentJson(value, rightRecord[key]),
    )
  );
}

export function validateRunList(
  value: unknown,
  repositoryId: string,
  query: NormalizedReviewRunQuery,
  operation: string,
) {
  const result = validateResponse(DashboardReviewRunListResponseSchema, value, operation);
  validatePagination(result, query, operation, (item) => item.id);
  for (const item of result.items) {
    if (
      item.repositoryId !== repositoryId ||
      (query.workItemId !== undefined && item.workItemId !== query.workItemId)
    )
      invalid(operation, "belongs to another work item or repository");
    validateSummary(item, operation);
  }
  return result;
}

export function validateRunDetail(
  value: unknown,
  operation: string,
  scope: ResponseScope = {},
): DashboardReviewRunDetail {
  const result = validateResponse(DashboardReviewRunDetailSchema, value, operation, scope);
  validateSummary(result, operation);
  validateRunReproductionSummary(result, operation);
  const required = result.requests.filter((request) => request.required);
  const requiredCheckIds = required.flatMap((request) => request.requiredCheckIds);
  if (
    result.requests.length !== result.requestCount ||
    required.length !== result.requiredRequestCount ||
    new Set(result.requests.map((request) => request.requestId)).size !== result.requests.length ||
    new Set(requiredCheckIds).size !== requiredCheckIds.length ||
    requiredCheckIds.length !== result.requiredCheckIds.length ||
    requiredCheckIds.some((id) => !result.requiredCheckIds.includes(id)) ||
    result.policy.reasonCount < result.policy.reasons.length ||
    result.policy.reasonsTruncated !== result.policy.reasonCount > result.policy.reasons.length
  )
    invalid(operation, "contains inconsistent request or policy metadata");
  for (const request of result.requests) {
    if ((result.workItemKind === "pull_request") !== request.workflowKind.startsWith("pr_"))
      invalid(operation, "contains a request for another work item kind");
    validateRequestSummary(request, operation);
  }
  const actualExecution = {
    missing: 0,
    awaitingAdmission: 0,
    queued: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const request of result.requests) {
    const status = request.latestJob?.status;
    if (status === undefined) actualExecution.missing++;
    else if (status === "queued" || status === "retry_waiting") {
      if (request.latestJob?.admission?.state === "pending") actualExecution.awaitingAdmission++;
      else actualExecution.queued++;
    } else if (status === "leased" || status === "running" || status === "cancel_requested")
      actualExecution.active++;
    else if (status === "succeeded") actualExecution.succeeded++;
    else if (status === "failed" || status === "dead_letter") actualExecution.failed++;
    else actualExecution.cancelled++;
  }
  if (
    Object.entries(actualExecution).some(
      ([key, count]) => result.execution[key as keyof typeof actualExecution] !== count,
    )
  )
    invalid(operation, "contains execution counts that do not match its requests");
  const dispositionPolicy =
    result.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2";
  const visibleBlockingFindings = result.requests.reduce(
    (count, request) =>
      count +
      (request.latestResult?.findings.filter((finding) => finding.priority <= 1).length ?? 0),
    0,
  );
  if (
    result.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2" &&
    (result.policy.unresolvedBlockingFindingCount > result.policy.blockingFindingCount ||
      result.policy.blockingFindingCount < visibleBlockingFindings)
  )
    invalid(operation, "contains inconsistent reported or unresolved finding counts");
  const blockingFindingCount =
    result.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
      ? result.policy.unresolvedBlockingFindingCount
      : result.policy.blockingFindingCount;
  if (
    result.policy.applicable &&
    result.policy.eligible &&
    (result.freshness !== "current" ||
      result.requiredCheckIds.length === 0 ||
      result.policy.reasonCount > 0 ||
      blockingFindingCount > 0 ||
      // Preview findings preserve model output and do not carry human dispositions.
      (!dispositionPolicy && visibleBlockingFindings > 0) ||
      required.some(
        (request) =>
          request.readiness !== "ready" ||
          request.blockers.length > 0 ||
          request.blockersTruncated ||
          request.profile === null ||
          request.prompt === null ||
          request.latestJob?.status !== "succeeded" ||
          request.latestResult === null ||
          request.latestResult.checks.passed < request.requiredCheckIds.length ||
          request.latestResult.sourceState !== "original" ||
          !request.latestResult.evidenceComplete ||
          request.latestResult.evidenceVerificationPending === true ||
          ((request.workflowKind === "pr_static_build" ||
            request.workflowKind === "issue_triage") &&
            request.latestResult.modelReviewState !== "completed") ||
          request.latestResult.lifecycleBlockerCount > 0,
      ))
  )
    invalid(operation, "claims approval eligibility without complete current evidence");
  return result;
}

export function validateRunJobs(
  value: unknown,
  repositoryId: string,
  reviewRunId: string,
  requestId: string,
  query: NormalizedReviewRunQuery,
  operation: string,
) {
  const result = validateResponse(DashboardReviewRunJobListResponseSchema, value, operation, {
    repositoryId,
    reviewRunId,
    requestId,
  });
  validatePagination(result, query, operation, (item) => item.jobId);
  if (
    query.jobId !== undefined &&
    (result.total > 1 || result.items.some((item) => item.jobId !== query.jobId))
  )
    invalid(operation, "does not identify the requested historical job");
  if (new Set(result.items.map((item) => item.activationNumber)).size !== result.items.length)
    invalid(operation, "contains duplicate job activations");
  for (const item of result.items) validateJob(item, operation);
  return result;
}

export function validateRunResult(
  value: unknown,
  detail: DashboardReviewRunDetail,
  requestId: string,
  jobId: string,
  operation: string,
): DashboardReviewRunResult {
  const request = detail.requests.find((candidate) => candidate.requestId === requestId);
  if (request === undefined || request.profile === null || request.prompt === null)
    invalid(operation, "does not identify an executable request in this run");
  const result = validateResponse(DashboardReviewRunResultSchema, value, operation, {
    repositoryId: detail.repositoryId,
    reviewRunId: detail.id,
    workItemId: detail.workItemId,
    requestId,
    jobId,
    revisionKey: detail.revisionKey,
    planDigest: detail.planDigest,
    profileVersionId: request.profile.id,
    promptVersionId: request.prompt.id,
  });
  validateEvidenceVerification(result, operation);
  validateRunResultReproduction(result, detail, operation);
  if (result.report.workItemKind !== detail.workItemKind)
    invalid(operation, "contains a report for another work item kind");
  const latest = request.latestJob;
  if (
    latest?.jobId === jobId &&
    (latest.status !== "succeeded" ||
      result.id !== latest.resultId ||
      result.resultDigest !== latest.resultDigest ||
      result.runAttemptId !== latest.runAttemptId ||
      result.activationNumber !== latest.activationNumber)
  )
    invalid(operation, "does not match the requested execution result");
  if (
    latest === null ||
    result.activationNumber > latest.activationNumber ||
    (latest.jobId !== jobId && result.activationNumber >= latest.activationNumber) ||
    (result.authoritative &&
      (latest.jobId !== jobId || latest.activationNumber !== result.activationNumber))
  )
    invalid(operation, "contains inconsistent result authority metadata");
  if (new Set(result.report.checks.map((check) => check.id)).size !== result.report.checks.length)
    invalid(operation, "contains duplicate check identities");
  if (latest.jobId === jobId && request.latestResult !== null) {
    // Evidence verification, retention, and latest-activation authority may change between reads.
    const {
      evidenceComplete: _evidenceComplete,
      evidenceVerificationPending: _evidenceVerificationPending,
      ...preview
    } = request.latestResult;
    if (!equivalentJson(preview, immutableResultPreview(result)))
      invalid(operation, "does not match the immutable result summary");
  }
  return result;
}
