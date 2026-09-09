import {
  getSchedulingConfigurationAuditEventIssues,
  getSchedulingConfigurationAuditListIssues,
  getSchedulingConfigurationIssues,
  getSchedulingStatusIssues,
  PlatformSchedulingStatusSchema,
  RepositorySchedulingStatusSchema,
  SchedulingConfigurationAuditEventSchema,
  type SchedulingConfigurationAuditListQuery,
  SchedulingConfigurationAuditListQuerySchema,
  SchedulingConfigurationAuditListResponseSchema,
  SchedulingConfigurationSchema,
  SchedulingConfigurationUpdateRequestSchema,
  type SchedulingLimits,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  validateRepositoryId,
  validateRequest,
  validateResponse,
} from "../repositories/validation";
import { ReviewControlProtocolError } from "../review-control/errors";

const canonicalId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value || value.includes("\0")) return false;
    if ((key === "id" || key.endsWith("Id")) && !canonicalId.test(value)) return false;
    if (
      (key === "issuer" || key === "subject") &&
      (value.trim() !== value ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        }))
    )
      return false;
  }
  if (Array.isArray(value)) return value.every((entry) => validWireValue(entry));
  if (value !== null && typeof value === "object")
    return Object.entries(value).every(([entryKey, entry]) => validWireValue(entry, entryKey));
  return typeof value !== "number" || Number.isSafeInteger(value);
}

function readPolicyResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  const result = validateResponse(schema, value, operation);
  requireConsistent(validWireValue(value) ? [] : ["invalid_wire_value"], operation);
  return result;
}

function requireConsistent(issues: readonly string[], operation: string): void {
  if (issues.length > 0)
    throw new ReviewControlProtocolError(operation, `The ${operation} response is inconsistent.`);
}

export function schedulingPolicyRepositoryPath(repositoryId: string): string {
  validateRepositoryId(repositoryId, "read repository scheduling");
  return `/api/v1/operator/repositories/${repositoryId}/scheduling`;
}

export function schedulingPolicyEventPath(eventId: string): string {
  validateRepositoryId(eventId, "read scheduling event");
  return `/api/v1/operator/scheduling/activity/${eventId}`;
}

export function normalizeSchedulingActivityQuery(
  query: SchedulingConfigurationAuditListQuery = {},
): Required<SchedulingConfigurationAuditListQuery> {
  validateRequest(SchedulingConfigurationAuditListQuerySchema, query, "read scheduling activity");
  return { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
}

export function readRepositorySchedulingStatus(value: unknown, repositoryId: string) {
  const operation = "read repository scheduling";
  schedulingPolicyRepositoryPath(repositoryId);
  const result = readPolicyResponse(RepositorySchedulingStatusSchema, value, operation);
  requireConsistent(
    [
      ...getSchedulingStatusIssues(result),
      ...(result.repositoryId === repositoryId ? [] : ["scope_mismatch"]),
    ],
    operation,
  );
  return result;
}

export function readPlatformSchedulingStatus(value: unknown) {
  const operation = "read platform scheduling";
  const result = readPolicyResponse(PlatformSchedulingStatusSchema, value, operation);
  requireConsistent(getSchedulingStatusIssues(result), operation);
  return result;
}

export function validateSchedulingUpdate(value: unknown) {
  return validateRequest(
    SchedulingConfigurationUpdateRequestSchema,
    value,
    "update scheduling configuration",
  );
}

export function readSchedulingConfiguration(
  value: unknown,
  expectedVersion: number,
  expectedLimits?: SchedulingLimits,
) {
  const operation = "update scheduling configuration";
  const result = readPolicyResponse(SchedulingConfigurationSchema, value, operation);
  requireConsistent(
    [
      ...getSchedulingConfigurationIssues(result),
      ...(result.version === expectedVersion + 1 ? [] : ["version_mismatch"]),
    ],
    operation,
  );
  if (
    expectedLimits &&
    (result.limits.maxActiveLeases !== expectedLimits.maxActiveLeases ||
      result.limits.maxQueuedJobs !== expectedLimits.maxQueuedJobs)
  )
    requireConsistent(["saved_limits_mismatch"], operation);
  return result;
}

export function readSchedulingActivity(
  value: unknown,
  query: Required<SchedulingConfigurationAuditListQuery>,
) {
  const operation = "read scheduling activity";
  const result = readPolicyResponse(
    SchedulingConfigurationAuditListResponseSchema,
    value,
    operation,
  );
  const issues = getSchedulingConfigurationAuditListIssues(result);
  if (
    result.page !== query.page ||
    result.pageSize !== query.pageSize ||
    result.items.length !==
      Math.min(query.pageSize, Math.max(0, result.total - (query.page - 1) * query.pageSize))
  )
    issues.push("page_mismatch");
  for (let index = 1; index < result.items.length; index += 1) {
    const previous = result.items[index - 1];
    const current = result.items[index];
    if (
      previous &&
      current &&
      (previous.createdAt < current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id <= current.id))
    )
      issues.push("order_mismatch");
  }
  requireConsistent(issues, operation);
  return result;
}

export function readSchedulingEvent(value: unknown, eventId: string) {
  const operation = "read scheduling event";
  schedulingPolicyEventPath(eventId);
  const result = readPolicyResponse(SchedulingConfigurationAuditEventSchema, value, operation);
  requireConsistent(
    [
      ...getSchedulingConfigurationAuditEventIssues(result),
      ...(result.id === eventId ? [] : ["event_mismatch"]),
    ],
    operation,
  );
  return result;
}
