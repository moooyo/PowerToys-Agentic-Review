import {
  getSchedulingDiagnosticsIssues,
  maximumSchedulingDiagnosticsResponseUtf8Bytes,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import type { SchedulingReadScope } from "./adapter";

const operation = "read current scheduling diagnostics";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
  );

export function schedulingPath(scope: SchedulingReadScope): string {
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    throw new ReviewControlRequestError(
      operation,
      "scope",
      "An exact scheduling scope is required.",
    );
  const keys =
    scope.kind === "repository_job"
      ? ["kind", "repositoryId", "workItemId", "jobId"]
      : scope.kind === "validation_request"
        ? ["kind", "repositoryId", "workItemId", "reviewRunId", "requestId"]
        : scope.kind === "platform_job"
          ? ["kind", "jobId"]
          : [];
  if (
    keys.length === 0 ||
    Object.keys(scope).length !== keys.length ||
    Object.entries(scope).some(
      ([key, value]) =>
        !keys.includes(key) ||
        (key !== "kind" && (typeof value !== "string" || !idPattern.test(value))),
    )
  )
    throw new ReviewControlRequestError(
      operation,
      "scope",
      "The scheduling scope contains invalid identity fields.",
    );
  if (scope.kind === "platform_job") return `/api/v1/operator/scheduling/jobs/${scope.jobId}`;
  const repository = `/api/v1/operator/repositories/${scope.repositoryId}`;
  return scope.kind === "repository_job"
    ? `${repository}/jobs/${scope.jobId}/scheduling`
    : `${repository}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}/scheduling`;
}

export function schedulingMatchesScope(
  value: SchedulingDiagnostics,
  scope: SchedulingReadScope,
): boolean {
  if (!Value.Check(SchedulingDiagnosticsSchema, value)) return false;
  const subject = value.subject;
  if (
    subject.kind !== "platform_job" &&
    (value.policy.repository === null ||
      value.policy.repository.repositoryId !== subject.repositoryId)
  )
    return false;
  if (scope.kind === "platform_job")
    return (
      subject.kind !== "validation_request" &&
      subject.jobId === scope.jobId &&
      value.policy.platform.visibility === "full"
    );
  return (
    subject.kind === scope.kind &&
    Object.entries(scope).every(([key, item]) => subject[key as keyof typeof subject] === item)
  );
}

export function readSchedulingDiagnostics(
  value: unknown,
  scope: SchedulingReadScope,
): SchedulingDiagnostics {
  schedulingPath(scope);
  if (
    !Value.Check(SchedulingDiagnosticsSchema, value) ||
    !schedulingMatchesScope(value, scope) ||
    getSchedulingDiagnosticsIssues(value).length > 0
  )
    throw new ReviewControlProtocolError(
      operation,
      "The scheduling observation does not match its supported contract and exact scope.",
    );
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    maximumSchedulingDiagnosticsResponseUtf8Bytes
  )
    throw new ReviewControlResponseTooLargeError(
      operation,
      maximumSchedulingDiagnosticsResponseUtf8Bytes,
    );
  return value;
}

export function schedulingScopeKey(scope: SchedulingReadScope): readonly string[] {
  schedulingPath(scope);
  return scope.kind === "platform_job"
    ? ["scheduling-diagnostics", scope.kind, scope.jobId]
    : scope.kind === "repository_job"
      ? ["scheduling-diagnostics", scope.kind, scope.repositoryId, scope.workItemId, scope.jobId]
      : [
          "scheduling-diagnostics",
          scope.kind,
          scope.repositoryId,
          scope.workItemId,
          scope.reviewRunId,
          scope.requestId,
        ];
}
