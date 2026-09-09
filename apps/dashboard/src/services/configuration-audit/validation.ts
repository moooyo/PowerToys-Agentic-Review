import {
  type ConfigurationAuditEvent,
  ConfigurationAuditEventSchema,
  type ConfigurationAuditSource,
  type ConfigurationAuditSummary,
  ConfigurationAuditSummarySchema,
  GlobalConfigurationAuditListQuerySchema,
  GlobalConfigurationAuditListResponseSchema,
  GlobalConfigurationAuditReadQuerySchema,
  maximumConfigurationAuditResponseUtf8Bytes,
  maximumConfigurationAuditSnapshotUtf8Bytes,
  maximumPromptConfigurationAuditSnapshotUtf8Bytes,
  RepositoryConfigurationAuditListQuerySchema,
  RepositoryConfigurationAuditListResponseSchema,
  RepositoryConfigurationAuditReadQuerySchema,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { repositorySettingsAreConsistent } from "../repositories/validation";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import type { ConfigurationAuditPageQuery, GlobalConfigurationAuditQuery } from "./adapter";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PageQuerySchema = Type.Omit(RepositoryConfigurationAuditListQuerySchema, ["repositoryId"]);

function validTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
);

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value || value.includes("\0")) return false;
    if ((key === "id" || key.endsWith("Id")) && !idPattern.test(value)) return false;
    if ((key === "createdAt" || key === "updatedAt") && !validTimestamp(value)) return false;
    if (
      (key === "issuer" || key === "subject") &&
      (!value ||
        value.trim() !== value ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        }))
    )
      return false;
  }
  if (Array.isArray(value)) return value.every((item) => validWireValue(item));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([entryKey, entry]) => validWireValue(entry, entryKey));
  return typeof value !== "number" || Number.isSafeInteger(value);
}

function invalid(operation: string): never {
  throw new ReviewControlProtocolError(
    operation,
    `The ${operation} response is invalid or inconsistent.`,
  );
}

function validateRequest<T extends TSchema>(
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
  return value;
}

function validateResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) invalid(operation);
  if (encoder.encode(JSON.stringify(value)).byteLength > maximumConfigurationAuditResponseUtf8Bytes)
    throw new ReviewControlResponseTooLargeError(
      operation,
      maximumConfigurationAuditResponseUtf8Bytes,
    );
  return value;
}

export function normalizeConfigurationAuditPage(
  query: ConfigurationAuditPageQuery = {},
  operation: string,
): Required<ConfigurationAuditPageQuery> {
  validateRequest(PageQuerySchema, query, operation);
  return { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
}

export function normalizeGlobalConfigurationAuditQuery(
  query: GlobalConfigurationAuditQuery = {},
  operation: string,
): Required<ConfigurationAuditPageQuery> & { templateId?: string } {
  validateRequest(GlobalConfigurationAuditListQuerySchema, query, operation);
  return {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 20,
    ...(query.templateId === undefined ? {} : { templateId: query.templateId }),
  };
}

export function configurationAuditQueryString(
  query: Required<ConfigurationAuditPageQuery> & { templateId?: string },
): string {
  const parameters = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.templateId !== undefined) parameters.set("templateId", query.templateId);
  return parameters.toString();
}

export function validateRepositoryConfigurationAuditList(
  repositoryId: string,
  query: Required<ConfigurationAuditPageQuery>,
  operation: string,
): void {
  validateRequest(
    RepositoryConfigurationAuditListQuerySchema,
    { repositoryId, ...query },
    operation,
  );
}

function summaryIsConsistent(summary: ConfigurationAuditSummary): boolean {
  if (summary.source === "repository") return summary.entityId === summary.repositoryId;
  switch (summary.action) {
    case "template_created":
      return summary.version === 1;
    case "draft_saved":
    case "prompt_published":
      return summary.version >= 2;
    case "bootstrap_registered":
      return Value.Check(WorkflowKindSchema, summary.entityId);
    default:
      return true;
  }
}

export function configurationAuditEventMatches(
  event: ConfigurationAuditEvent,
  summary: ConfigurationAuditSummary,
): boolean {
  return (
    event.id === summary.id &&
    event.source === summary.source &&
    event.action === summary.action &&
    event.entityId === summary.entityId &&
    event.repositoryId === summary.repositoryId &&
    event.version === summary.version &&
    event.createdAt === summary.createdAt &&
    event.actor.issuer === summary.actor.issuer &&
    event.actor.subject === summary.actor.subject
  );
}

function snapshotExpectedSummary(
  repositoryId: string | null,
  source: ConfigurationAuditSource,
  eventId: string,
  expectedSummary: ConfigurationAuditSummary | undefined,
  operation: string,
): ConfigurationAuditSummary | undefined {
  if (expectedSummary === undefined) return undefined;
  const summary = validateRequest(ConfigurationAuditSummarySchema, expectedSummary, operation);
  if (
    summary.id !== eventId ||
    summary.source !== source ||
    summary.repositoryId !== repositoryId ||
    !summaryIsConsistent(summary)
  )
    throw new ReviewControlRequestError(
      operation,
      "expectedSummary",
      "The expected configuration audit summary does not match the requested event.",
    );
  // A UI rerender must not change the immutable receipt expected by an in-flight request.
  return structuredClone(summary);
}

export function validateRepositoryConfigurationAuditRead(
  repositoryId: string,
  source: ConfigurationAuditSource,
  eventId: string,
  expectedSummary: ConfigurationAuditSummary | undefined,
  operation: string,
): ConfigurationAuditSummary | undefined {
  validateRequest(
    RepositoryConfigurationAuditReadQuerySchema,
    { repositoryId, source, eventId },
    operation,
  );
  return snapshotExpectedSummary(repositoryId, source, eventId, expectedSummary, operation);
}

export function validateGlobalConfigurationAuditRead(
  eventId: string,
  expectedSummary: ConfigurationAuditSummary | undefined,
  operation: string,
): ConfigurationAuditSummary | undefined {
  validateRequest(GlobalConfigurationAuditReadQuerySchema, { eventId }, operation);
  return snapshotExpectedSummary(null, "prompt", eventId, expectedSummary, operation);
}

export function compareConfigurationAuditSummaries(
  left: ConfigurationAuditSummary,
  right: ConfigurationAuditSummary,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  if (left.source !== right.source) return left.source < right.source ? -1 : 1;
  return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
}

function validatePage(
  result: {
    items: ConfigurationAuditSummary[];
    total: number;
    page: number;
    pageSize: number;
  },
  query: Required<ConfigurationAuditPageQuery>,
  repositoryId: string | null,
  operation: string,
): void {
  const offset = (query.page - 1) * query.pageSize;
  const expectedCount = Math.min(query.pageSize, Math.max(0, result.total - offset));
  if (
    result.page !== query.page ||
    result.pageSize !== query.pageSize ||
    result.items.length !== expectedCount ||
    result.items.some((item) => item.repositoryId !== repositoryId || !summaryIsConsistent(item)) ||
    new Set(result.items.map((item) => JSON.stringify([item.source, item.id]))).size !==
      result.items.length
  )
    invalid(operation);
  for (let index = 1; index < result.items.length; index += 1) {
    const previous = result.items[index - 1];
    const current = result.items[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareConfigurationAuditSummaries(previous, current) > 0
    )
      invalid(operation);
  }
}

export function readRepositoryConfigurationAuditList(
  value: unknown,
  repositoryId: string,
  query: Required<ConfigurationAuditPageQuery>,
  operation: string,
) {
  const result = validateResponse(RepositoryConfigurationAuditListResponseSchema, value, operation);
  if (result.repositoryId !== repositoryId) invalid(operation);
  validatePage(result, query, repositoryId, operation);
  return result;
}

export function readGlobalConfigurationAuditList(
  value: unknown,
  query: Required<ConfigurationAuditPageQuery> & { templateId?: string },
  operation: string,
) {
  const result = validateResponse(GlobalConfigurationAuditListResponseSchema, value, operation);
  if (result.templateId !== query.templateId) invalid(operation);
  validatePage(result, query, null, operation);
  if (
    query.templateId !== undefined &&
    result.items.some(
      (item) =>
        ["template_created", "draft_saved", "prompt_published"].includes(item.action) &&
        item.entityId !== query.templateId,
    )
  )
    invalid(operation);
  return result;
}

function snapshotIsConsistent(event: ConfigurationAuditEvent): boolean {
  if (event.source === "repository") {
    return (
      event.snapshot.id === event.repositoryId &&
      event.snapshot.version === event.version &&
      event.snapshot.updatedAt === event.createdAt &&
      repositorySettingsAreConsistent(event.snapshot)
    );
  }
  if (event.action === "bootstrap_registered") return true;
  if (event.snapshot.version !== event.version) return false;
  switch (event.action) {
    case "draft_saved":
      return event.snapshot.draftRevision >= 2 && event.snapshot.draftRevision <= event.version;
    case "prompt_published":
      return event.snapshot.publishedVersion < event.version;
    case "prompt_bound":
    case "profile_bound":
      return (event.version === 1) === (event.snapshot.previousVersionId === null);
    default:
      return true;
  }
}

export function readConfigurationAuditEvent(
  value: unknown,
  repositoryId: string | null,
  source: ConfigurationAuditSource,
  eventId: string,
  expectedSummary: ConfigurationAuditSummary | undefined,
  operation: string,
): ConfigurationAuditEvent {
  const event = validateResponse(ConfigurationAuditEventSchema, value, operation);
  if (
    event.id !== eventId ||
    event.source !== source ||
    event.repositoryId !== repositoryId ||
    !summaryIsConsistent(event) ||
    !snapshotIsConsistent(event) ||
    (expectedSummary !== undefined && !configurationAuditEventMatches(event, expectedSummary))
  )
    invalid(operation);
  const limit =
    event.source === "repository"
      ? maximumConfigurationAuditSnapshotUtf8Bytes
      : maximumPromptConfigurationAuditSnapshotUtf8Bytes;
  if (encoder.encode(JSON.stringify(event.snapshot)).byteLength > limit) invalid(operation);
  return event;
}
