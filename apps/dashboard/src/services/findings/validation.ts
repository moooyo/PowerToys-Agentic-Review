import {
  EntityIdSchema,
  type FindingComparisonResponse,
  FindingComparisonResponseSchema,
  type FindingComparisonSide,
  type FindingDispositionChangeRequest,
  FindingDispositionChangeRequestSchema,
  FindingDispositionChangeResponseSchema,
  type FindingDispositionEvent,
  FindingDispositionHistoryResponseSchema,
  FindingListResponseSchema,
  type FindingOccurrence,
  type FindingOccurrenceRef,
  FindingOccurrenceRefSchema,
  type FindingResultContext,
  maximumFindingDispositionPageSize,
  maximumFindingDispositionRequestUtf8Bytes,
  maximumFindingDispositionResponseUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  PositiveIntegerSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { samePrincipal } from "../access/validation";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { FindingPageQuery, FindingScope } from "./adapter";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const scopeSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    reviewRunId: EntityIdSchema,
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
  },
  { additionalProperties: false },
);
const pageSchema = Type.Object(
  {
    page: Type.Optional(PositiveIntegerSchema),
    pageSize: Type.Optional(
      Type.Integer({ minimum: 1, maximum: maximumFindingDispositionPageSize }),
    ),
  },
  { additionalProperties: false },
);
const stateForAction = {
  accept: "accepted",
  dismiss: "dismissed",
  resolve: "resolved",
  reopen: "open",
} as const;

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

function forbiddenControls(value: string, paragraphs = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 0x20 && !(paragraphs && [9, 10, 13].includes(code))) || (code >= 0x7f && code <= 0x9f)
    );
  });
}

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value) return false;
    if ((key === "id" || key.endsWith("Id")) && key !== "modelId" && !idPattern.test(value))
      return false;
    if ((key === "key" || /(?:Digest|Key)(?:AtChange)?$/u.test(key)) && !digestPattern.test(value))
      return false;
    if ((key === "createdAt" || key === "updatedAt") && !validTimestamp(value)) return false;
    if (
      (key === "issuer" || key === "subject") &&
      (!value.trim() || value.trim() !== value || forbiddenControls(value))
    )
      return false;
  }
  if (typeof value === "number")
    return key === "confidence" ? Number.isFinite(value) : Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every((item) => validWireValue(item, key));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([name, item]) => validWireValue(item, name));
  return true;
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
  if (
    !Value.Check(schema, value) ||
    !validWireValue(value) ||
    encoder.encode(JSON.stringify(value)).byteLength > maximumFindingDispositionResponseUtf8Bytes
  )
    invalid(operation);
  return value;
}

function sameScope(first: FindingScope, second: FindingScope): boolean {
  return (
    first.repositoryId === second.repositoryId &&
    first.reviewRunId === second.reviewRunId &&
    first.requestId === second.requestId &&
    first.jobId === second.jobId
  );
}

function sameRef(first: FindingOccurrenceRef, second: FindingOccurrenceRef): boolean {
  return (
    first.key === second.key &&
    first.resultId === second.resultId &&
    first.resultDigest === second.resultDigest &&
    first.kind === second.kind &&
    first.ordinal === second.ordinal
  );
}

function pageMatches(
  value: { page: number; pageSize: number; total: number; items: readonly unknown[] },
  query: Required<FindingPageQuery>,
  operation: string,
): void {
  const offset = (query.page - 1) * query.pageSize;
  if (
    value.page !== query.page ||
    value.pageSize !== query.pageSize ||
    value.items.length !== Math.min(query.pageSize, Math.max(0, value.total - offset))
  )
    invalid(operation);
}

export function validateFindingScope(scope: FindingScope, operation: string): FindingScope {
  return request(scopeSchema, scope, operation);
}

export function validateFindingComparisonScope(
  scope: FindingScope,
  before: FindingScope,
  operation: string,
): void {
  if (scope.repositoryId !== before.repositoryId)
    throw new ReviewControlRequestError(
      operation,
      "repositoryId",
      "Finding comparisons must stay within one repository.",
    );
}

export function validateFindingKey(key: string, operation: string): void {
  if (typeof key !== "string" || !digestPattern.test(key))
    throw new ReviewControlRequestError(
      operation,
      "occurrenceKey",
      "A valid occurrence key is required.",
    );
}

export function validateFindingRef(
  ref: FindingOccurrenceRef,
  operation: string,
): FindingOccurrenceRef {
  return request(FindingOccurrenceRefSchema, ref, operation);
}

export function validateFindingActor(
  actor: OperatorPrincipal,
  operation: string,
): OperatorPrincipal {
  return request(OperatorPrincipalSchema, actor, operation);
}

export function normalizeFindingPage(
  query: FindingPageQuery = {},
  operation: string,
): Required<FindingPageQuery> {
  request(pageSchema, query, operation);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? maximumFindingDispositionPageSize;
  if (!Number.isSafeInteger((page - 1) * pageSize))
    throw new ReviewControlRequestError(operation, "page", "The requested page is too large.");
  return { page, pageSize };
}

export function validateFindingChange(
  input: FindingDispositionChangeRequest,
  operation: string,
): FindingDispositionChangeRequest {
  request(FindingDispositionChangeRequestSchema, input, operation);
  if (
    forbiddenControls(input.reason, true) ||
    input.expectedVersion === Number.MAX_SAFE_INTEGER ||
    encoder.encode(JSON.stringify(input)).byteLength > maximumFindingDispositionRequestUtf8Bytes
  )
    throw new ReviewControlRequestError(
      operation,
      "request",
      "The finding disposition request exceeds its supported bounds.",
    );
  return { ...input, reason: input.reason.trim() };
}

// This fixed key order is canonicalJson({ schemaVersion: "FindingOccurrenceV1", ...ref }).
// Only immutable identity participates; display position, model ID, and disposition never do.
export async function findingOccurrenceKey(
  ref: Omit<FindingOccurrenceRef, "key">,
): Promise<string> {
  const content = JSON.stringify({
    kind: ref.kind,
    ordinal: ref.ordinal,
    resultDigest: ref.resultDigest,
    resultId: ref.resultId,
    schemaVersion: "FindingOccurrenceV1",
  });
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(content));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRef(ref: FindingOccurrenceRef, operation: string): Promise<void> {
  if (ref.key !== (await findingOccurrenceKey(ref))) invalid(operation);
}

function contextMatches(
  context: FindingResultContext,
  scope: FindingScope,
  operation: string,
): void {
  const pr = context.workItemKind === "pull_request";
  if (
    !sameScope(context, scope) ||
    context.historical !== (!context.sourceCurrent || !context.latestForRequest) ||
    pr !== ["pr_static_build", "pr_ui"].includes(context.workflowKind) ||
    (["pr_static_build", "issue_triage"].includes(context.workflowKind) &&
      context.target !== "headless") ||
    (context.workflowKind === "pr_ui" && context.target === "headless") ||
    (context.workflowKind === "issue_triage" && context.modelAvailability !== "not_applicable") ||
    (context.modelAvailability !== "complete" && context.findingCount !== 0)
  )
    invalid(operation);
}

function occurrenceMatches(
  occurrence: FindingOccurrenceRef,
  context: FindingResultContext,
  operation: string,
): void {
  if (
    occurrence.resultId !== context.resultId ||
    occurrence.resultDigest !== context.resultDigest ||
    occurrence.ordinal >= context.findingCount ||
    occurrence.kind !==
      (context.workflowKind === "pr_static_build" ? "pr_finding" : "validation_observation")
  )
    invalid(operation);
}

function locationMatches(value: Pick<FindingOccurrence, "path" | "line">, operation: string): void {
  if (
    (value.path === null && value.line !== null) ||
    (value.path !== null &&
      (value.path.includes(":") ||
        value.path.includes("\\") ||
        forbiddenControls(value.path) ||
        value.path.split("/").some((part) => part === "" || part === "." || part === "..")))
  )
    invalid(operation);
}

function dispositionMatches(item: FindingOccurrence, operation: string): void {
  const disposition = item.disposition;
  if (
    (item.kind === "pr_finding" &&
      (item.path === null || item.line === null || item.confidence === null)) ||
    (item.kind === "validation_observation" &&
      (item.endLine !== null || item.confidence !== null)) ||
    (item.endLine !== null && (item.line === null || item.endLine < item.line)) ||
    (disposition.version === 0
      ? disposition.state !== "open" ||
        disposition.lastEventId !== null ||
        disposition.updatedAt !== null ||
        disposition.updatedBy !== null
      : disposition.lastEventId === null ||
        disposition.updatedAt === null ||
        disposition.updatedBy === null)
  )
    invalid(operation);
}

export async function readFindingList(
  value: unknown,
  scope: FindingScope,
  query: Required<FindingPageQuery>,
  operation: string,
) {
  const result = response(FindingListResponseSchema, value, operation);
  contextMatches(result.context, scope, operation);
  pageMatches(result, query, operation);
  const summary = result.summary;
  if (
    result.total !== result.context.findingCount ||
    summary.open + summary.accepted + summary.dismissed + summary.resolved !== result.total ||
    summary.rawBlocking > result.total ||
    summary.unresolvedBlocking > summary.rawBlocking ||
    summary.unresolvedBlocking > summary.open + summary.accepted ||
    summary.rawBlocking - summary.unresolvedBlocking > summary.dismissed + summary.resolved ||
    new Set(result.items.map((item) => item.key)).size !== result.items.length
  )
    invalid(operation);
  const visible = {
    open: 0,
    accepted: 0,
    dismissed: 0,
    resolved: 0,
    rawBlocking: 0,
    unresolvedBlocking: 0,
  };
  const offset = (query.page - 1) * query.pageSize;
  for (const [index, item] of result.items.entries()) {
    occurrenceMatches(item, result.context, operation);
    locationMatches(item, operation);
    dispositionMatches(item, operation);
    if (item.ordinal !== offset + index) invalid(operation);
    visible[item.disposition.state] += 1;
    if (item.priority <= 1) {
      visible.rawBlocking += 1;
      if (["open", "accepted"].includes(item.disposition.state)) visible.unresolvedBlocking += 1;
    }
  }
  for (const name of Object.keys(visible) as (keyof typeof visible)[]) {
    if (
      summary[name] < visible[name] ||
      summary[name] > visible[name] + result.total - result.items.length
    )
      invalid(operation);
  }
  await Promise.all(result.items.map((item) => checkRef(item, operation)));
  return result;
}

async function eventMatches(
  event: FindingDispositionEvent,
  scope: FindingScope,
  operation: string,
) {
  if (
    !sameScope(event, scope) ||
    event.previousVersion === Number.MAX_SAFE_INTEGER ||
    event.version !== event.previousVersion + 1 ||
    event.state !== stateForAction[event.action] ||
    event.state === event.previousState ||
    (event.previousVersion === 0 && event.previousState !== "open") ||
    (event.occurrence.kind === "pr_finding" && event.workItemKind !== "pull_request") ||
    event.reason !== event.reason.trim() ||
    forbiddenControls(event.reason, true) ||
    new Date(event.createdAt).toISOString() !== event.createdAt
  )
    invalid(operation);
  await checkRef(event.occurrence, operation);
}

export async function readFindingChange(
  value: unknown,
  scope: FindingScope,
  occurrenceKey: string,
  input: FindingDispositionChangeRequest,
  actor: OperatorPrincipal,
  operation: string,
) {
  const result = response(FindingDispositionChangeResponseSchema, value, operation);
  const event = result.change;
  await eventMatches(event, scope, operation);
  if (
    event.changeId !== input.changeId ||
    event.occurrence.key !== occurrenceKey ||
    event.occurrence.resultDigest !== input.expectedResultDigest ||
    event.occurrence.kind !== input.kind ||
    event.occurrence.ordinal !== input.ordinal ||
    event.contextDigestAtChange !== input.expectedContextDigest ||
    event.action !== input.action ||
    event.reason !== input.reason.trim() ||
    event.previousVersion !== input.expectedVersion ||
    !samePrincipal(event.actor, actor)
  )
    invalid(operation);
  return result;
}

export async function readFindingHistory(
  value: unknown,
  scope: FindingScope,
  occurrence: FindingOccurrenceRef,
  query: Required<FindingPageQuery>,
  operation: string,
) {
  const result = response(FindingDispositionHistoryResponseSchema, value, operation);
  pageMatches(result, query, operation);
  if (
    !sameScope(result, scope) ||
    !sameRef(result.occurrence, occurrence) ||
    new Set(result.items.map((event) => event.id)).size !== result.items.length ||
    new Set(result.items.map((event) => event.changeId)).size !== result.items.length
  )
    invalid(operation);
  await checkRef(result.occurrence, operation);
  const offset = (query.page - 1) * query.pageSize;
  const first = result.items[0];
  for (const [index, event] of result.items.entries()) {
    const newer = result.items[index - 1];
    if (
      !sameRef(event.occurrence, occurrence) ||
      event.version !== result.total - offset - index ||
      (first !== undefined &&
        (event.workItemId !== first.workItemId ||
          event.workItemKind !== first.workItemKind ||
          event.revisionKey !== first.revisionKey ||
          event.planDigest !== first.planDigest)) ||
      (newer !== undefined &&
        (newer.previousState !== event.state ||
          Date.parse(newer.createdAt) < Date.parse(event.createdAt)))
    )
      invalid(operation);
  }
  await Promise.all(result.items.map((event) => eventMatches(event, scope, operation)));
  return result;
}

function comparisonReasons(before: FindingResultContext, after: FindingResultContext) {
  const reasons: FindingComparisonResponse["reasons"] = [];
  if (
    ["workflowKind", "target", "profileVersionId", "promptVersionId", "workItemKind"].some(
      (key) =>
        before[key as keyof FindingResultContext] !== after[key as keyof FindingResultContext],
    )
  )
    reasons.push("configuration_changed");
  if (before.modelAvailability !== "complete" || after.modelAvailability !== "complete")
    reasons.push("model_unavailable");
  if (before.resultId === after.resultId) reasons.push("same_result");
  if (Date.parse(before.createdAt) >= Date.parse(after.createdAt))
    reasons.push("baseline_not_earlier");
  return reasons;
}

export async function readFindingComparison(
  value: unknown,
  scope: FindingScope,
  beforeScope: FindingScope,
  query: Required<FindingPageQuery>,
  operation: string,
) {
  const result = response(FindingComparisonResponseSchema, value, operation);
  contextMatches(result.before, beforeScope, operation);
  contextMatches(result.after, scope, operation);
  pageMatches(result, query, operation);
  const reasons = comparisonReasons(result.before, result.after);
  const count = result.before.findingCount + result.after.findingCount;
  if (
    result.before.repositoryId !== result.after.repositoryId ||
    result.before.workItemId !== result.after.workItemId ||
    result.before.workItemKind !== result.after.workItemKind ||
    result.reasons.length !== reasons.length ||
    reasons.some((reason) => !result.reasons.includes(reason)) ||
    result.compatible !== (reasons.length === 0) ||
    result.total > count ||
    result.total < Math.max(result.before.findingCount, result.after.findingCount) ||
    (!result.compatible && result.total !== count) ||
    ((result.before.resultId === result.after.resultId ||
      result.before.jobId === result.after.jobId) &&
      (Object.keys(result.before) as (keyof FindingResultContext)[]).some(
        (key) => result.before[key] !== result.after[key],
      ))
  )
    invalid(operation);
  const before = new Map<string, FindingComparisonSide>();
  const after = new Map<string, FindingComparisonSide>();
  const refs: FindingComparisonSide[] = [];
  for (const row of result.items) {
    if (
      (row.status === "persistent" &&
        (row.before === null || row.after === null || row.reason !== null || !result.compatible)) ||
      (row.status === "new" &&
        (row.before !== null || row.after === null || row.reason !== null || !result.compatible)) ||
      (row.status === "not_observed_again" &&
        (row.before === null || row.after !== null || row.reason !== null || !result.compatible)) ||
      (row.status === "incomparable" &&
        ((row.before === null) === (row.after === null) ||
          row.reason !==
            (result.compatible
              ? "ambiguous_match"
              : reasons.includes("configuration_changed")
                ? "configuration_changed"
                : reasons.includes("model_unavailable")
                  ? "model_unavailable"
                  : null)))
    )
      invalid(operation);
    if (
      row.status === "persistent" &&
      row.before !== null &&
      row.after !== null &&
      (row.before.kind !== row.after.kind ||
        row.before.path !== row.after.path ||
        row.before.title.replace(/\r\n?/gu, "\n") !== row.after.title.replace(/\r\n?/gu, "\n"))
    )
      invalid(operation);
    for (const [side, context, seen] of [
      [row.before, result.before, before],
      [row.after, result.after, after],
    ] as const) {
      if (side === null) continue;
      occurrenceMatches(side, context, operation);
      locationMatches(side, operation);
      if (seen.has(side.key)) invalid(operation);
      seen.set(side.key, side);
      refs.push(side);
    }
  }
  if (
    before.size > result.before.findingCount ||
    after.size > result.after.findingCount ||
    result.before.findingCount - before.size > result.total - result.items.length ||
    result.after.findingCount - after.size > result.total - result.items.length
  )
    invalid(operation);
  await Promise.all(refs.map((ref) => checkRef(ref, operation)));
  return result;
}
