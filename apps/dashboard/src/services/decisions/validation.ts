import {
  type DashboardValidationPolicy,
  maximumDashboardReviewRunPolicyReasonCount,
  maximumReviewRunDecisionPageSize,
  maximumReviewRunDecisionRequestUtf8Bytes,
  maximumReviewRunDecisionResponseUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  PositiveIntegerSchema,
  type ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeRequestSchema,
  ReviewRunDecisionChangeResponseSchema,
  type ReviewRunDecisionContext,
  ReviewRunDecisionContextSchema,
  type ReviewRunDecisionEvent,
  ReviewRunDecisionHistoryResponseSchema,
  type ReviewRunDecisionPolicySnapshot,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { samePrincipal } from "../access/validation";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { DecisionPageQuery } from "./adapter";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const pageSchema = Type.Object(
  {
    page: Type.Optional(PositiveIntegerSchema),
    pageSize: Type.Optional(
      Type.Integer({ minimum: 1, maximum: maximumReviewRunDecisionPageSize }),
    ),
  },
  { additionalProperties: false },
);

function validTimestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)(?![\s\S])/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

FormatRegistry.Set("date-time", validTimestamp);

function hasControlCharacters(value: string, allowParagraphs = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 0x20 && !(allowParagraphs && (code === 0x09 || code === 0x0a || code === 0x0d))) ||
      (code >= 0x7f && code <= 0x9f)
    );
  });
}

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value) return false;
    if ((key === "id" || key.endsWith("Id")) && key !== "checkId" && !idPattern.test(value))
      return false;
    if (
      (key.endsWith("Digest") || key.endsWith("RevisionKey") || key === "revisionKey") &&
      !digestPattern.test(value)
    )
      return false;
    if (key === "createdAt" && !validTimestamp(value)) return false;
    if ((key === "issuer" || key === "subject") && (!value.trim() || hasControlCharacters(value)))
      return false;
    if ((key === "issuer" || key === "subject") && value.trim() !== value) return false;
  }
  if (Array.isArray(value)) return value.every((item) => validWireValue(item, key));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([name, item]) => validWireValue(item, name));
  return typeof value !== "number" || Number.isSafeInteger(value);
}

function invalid(operation: string): never {
  throw new ReviewControlProtocolError(
    operation,
    `The ${operation} response is invalid or inconsistent.`,
  );
}

function request<T extends TSchema>(schema: T, value: unknown, operation: string): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value))
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  return value;
}

function response<T extends TSchema>(schema: T, value: unknown, operation: string): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) invalid(operation);
  if (encoder.encode(JSON.stringify(value)).byteLength > maximumReviewRunDecisionResponseUtf8Bytes)
    invalid(operation);
  return value;
}

export function validateDecisionScope(
  repositoryId: string,
  reviewRunId: string,
  operation: string,
): void {
  for (const [name, value] of Object.entries({ repositoryId, reviewRunId })) {
    if (typeof value !== "string" || !idPattern.test(value))
      throw new ReviewControlRequestError(
        operation,
        name,
        "A valid repository and review run ID are required.",
      );
  }
}

export function normalizeDecisionPage(
  query: DecisionPageQuery = {},
  operation: string,
): Required<DecisionPageQuery> {
  request(pageSchema, query, operation);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? maximumReviewRunDecisionPageSize;
  if (!Number.isSafeInteger((page - 1) * pageSize))
    throw new ReviewControlRequestError(operation, "page", "The requested page is too large.");
  return { page, pageSize };
}

export function validateDecisionChange(
  input: ReviewRunDecisionChangeRequest,
  operation: string,
): ReviewRunDecisionChangeRequest {
  request(ReviewRunDecisionChangeRequestSchema, input, operation);
  if (
    hasControlCharacters(input.reason, true) ||
    input.expectedVersion === Number.MAX_SAFE_INTEGER ||
    encoder.encode(JSON.stringify(input)).byteLength > maximumReviewRunDecisionRequestUtf8Bytes
  )
    throw new ReviewControlRequestError(
      operation,
      "request",
      "The decision request exceeds its supported bounds.",
    );
  // Match server canonicalization without modifying the caller's retry intent.
  return { ...input, reason: input.reason.trim() };
}

export function validateDecisionActor(
  actor: OperatorPrincipal,
  operation: string,
): OperatorPrincipal {
  return request(OperatorPrincipalSchema, actor, operation);
}

function unresolvedBlockingCount(
  policy: DashboardValidationPolicy | ReviewRunDecisionPolicySnapshot,
  operation: string,
): number {
  if (policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2") {
    if (policy.unresolvedBlockingFindingCount > policy.blockingFindingCount) invalid(operation);
    return policy.unresolvedBlockingFindingCount;
  }
  return policy.blockingFindingCount;
}

export function validateDecisionEvent(
  event: ReviewRunDecisionEvent,
  repositoryId: string,
  reviewRunId: string,
  operation: string,
): void {
  if (
    event.repositoryId !== repositoryId ||
    event.reviewRunId !== reviewRunId ||
    event.previousVersion === Number.MAX_SAFE_INTEGER ||
    event.version !== event.previousVersion + 1 ||
    event.id === event.supersedesDecisionId ||
    event.id === event.targetDecisionId ||
    (event.previousVersion === 0 && event.supersedesDecisionId !== null) ||
    (event.action === "comment" && event.supersedesDecisionId !== null) ||
    (event.action === "withdraw" && event.targetDecisionId !== event.supersedesDecisionId) ||
    event.reason !== event.reason.trim() ||
    hasControlCharacters(event.reason, true)
  )
    invalid(operation);
  const policy = event.policyAtDecision;
  const blockingFindingCount = unresolvedBlockingCount(policy, operation);
  if (
    policy.reasonCount < policy.reasonCodes.length ||
    (policy.reasonCodesTruncated &&
      (policy.reasonCount <= policy.reasonCodes.length || policy.reasonCodes.length !== 128)) ||
    (policy.applicable &&
      policy.eligible &&
      (blockingFindingCount !== 0 || policy.reasonCount !== 0)) ||
    (event.action === "approve" && policy.eligible !== true)
  )
    invalid(operation);
}

export function decisionState(
  context: Pick<
    ReviewRunDecisionContext,
    "recordedDecision" | "resultSetDigest" | "sourceCurrent" | "policy"
  >,
): Pick<ReviewRunDecisionContext, "recordedDecisionState" | "stateReasons"> {
  const event = context.recordedDecision;
  const stateReasons: ReviewRunDecisionContext["stateReasons"] = [];
  if (event === null) return { recordedDecisionState: "none", stateReasons };
  if (event.action === "withdraw") return { recordedDecisionState: "withdrawn", stateReasons };
  if (event.resultSetDigest !== context.resultSetDigest) stateReasons.push("result_set_changed");
  if (!context.sourceCurrent) stateReasons.push("source_not_current");
  if (event.action === "approve" && context.policy.eligible !== true)
    stateReasons.push("approval_policy_not_satisfied");
  return {
    recordedDecisionState:
      event.resultSetDigest !== context.resultSetDigest || !context.sourceCurrent
        ? "stale"
        : event.action === "approve" && context.policy.eligible !== true
          ? "ineligible"
          : "current",
    stateReasons,
  };
}

export function readDecisionContext(
  value: unknown,
  repositoryId: string,
  reviewRunId: string,
  operation: string,
): ReviewRunDecisionContext {
  const result = response(ReviewRunDecisionContextSchema, value, operation);
  const policy = result.policy;
  const blockingFindingCount = unresolvedBlockingCount(policy, operation);
  if (
    result.repositoryId !== repositoryId ||
    result.reviewRunId !== reviewRunId ||
    (result.sourceCurrent && result.revisionKey !== result.currentRevisionKey) ||
    result.canApprove !==
      (result.workItemKind === "pull_request" &&
        result.sourceCurrent &&
        policy.eligible === true) ||
    policy.reasonCount < policy.reasons.length ||
    policy.reasonsTruncated !== policy.reasonCount > policy.reasons.length ||
    (policy.reasonsTruncated &&
      policy.reasons.length !== maximumDashboardReviewRunPolicyReasonCount) ||
    (policy.applicable &&
      policy.eligible &&
      (blockingFindingCount !== 0 || policy.reasonCount !== 0))
  )
    invalid(operation);
  const event = result.recordedDecision;
  if (event !== null) {
    validateDecisionEvent(event, repositoryId, reviewRunId, operation);
    if (
      event.workItemId !== result.workItemId ||
      event.workItemKind !== result.workItemKind ||
      event.revisionKey !== result.revisionKey ||
      event.planDigest !== result.planDigest ||
      event.version > result.version ||
      event.action === "comment"
    )
      invalid(operation);
    // The result set binds the policy version and disposition history. Older result sets may
    // legitimately retain an earlier version or disposition snapshot without being rewritten.
    if (
      event.resultSetDigest === result.resultSetDigest &&
      (event.policyAtDecision.policyVersion !== policy.policyVersion ||
        (event.policyAtDecision.policyVersion === "required-checks-and-unresolved-p0-p1-v2" &&
          policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2" &&
          event.policyAtDecision.findingDispositionDigest !== policy.findingDispositionDigest))
    )
      invalid(operation);
  }
  const state = decisionState(result);
  if (
    result.recordedDecisionState !== state.recordedDecisionState ||
    result.stateReasons.length !== state.stateReasons.length ||
    state.stateReasons.some((reason) => !result.stateReasons.includes(reason))
  )
    invalid(operation);
  return result;
}

export function readDecisionHistory(
  value: unknown,
  repositoryId: string,
  reviewRunId: string,
  query: Required<DecisionPageQuery>,
  operation: string,
) {
  const result = response(ReviewRunDecisionHistoryResponseSchema, value, operation);
  const offset = (query.page - 1) * query.pageSize;
  if (
    result.repositoryId !== repositoryId ||
    result.reviewRunId !== reviewRunId ||
    result.page !== query.page ||
    result.pageSize !== query.pageSize ||
    result.items.length !== Math.min(query.pageSize, Math.max(0, result.total - offset)) ||
    new Set(result.items.map((event) => event.id)).size !== result.items.length ||
    new Set(result.items.map((event) => event.changeId)).size !== result.items.length
  )
    invalid(operation);
  const first = result.items[0];
  for (const [index, event] of result.items.entries()) {
    validateDecisionEvent(event, repositoryId, reviewRunId, operation);
    if (
      event.version !== result.total - offset - index ||
      (first !== undefined &&
        (event.workItemId !== first.workItemId ||
          event.workItemKind !== first.workItemKind ||
          event.revisionKey !== first.revisionKey ||
          event.planDigest !== first.planDigest))
    )
      invalid(operation);
  }
  return result;
}

export function readDecisionChange(
  value: unknown,
  repositoryId: string,
  reviewRunId: string,
  input: ReviewRunDecisionChangeRequest,
  actor: OperatorPrincipal,
  operation: string,
) {
  const result = response(ReviewRunDecisionChangeResponseSchema, value, operation);
  const event = result.change;
  validateDecisionEvent(event, repositoryId, reviewRunId, operation);
  if (
    event.changeId !== input.changeId ||
    !samePrincipal(event.actor, actor) ||
    event.action !== input.action ||
    event.reason !== input.reason.trim() ||
    event.revisionKey !== input.expectedRevisionKey ||
    event.planDigest !== input.expectedPlanDigest ||
    event.resultSetDigest !== input.expectedResultSetDigest ||
    event.previousVersion !== input.expectedVersion ||
    event.version !== input.expectedVersion + 1 ||
    event.targetDecisionId !== (input.action === "withdraw" ? input.targetDecisionId : null)
  )
    invalid(operation);
  return result;
}
