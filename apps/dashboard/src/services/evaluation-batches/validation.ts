import {
  EntityIdSchema,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";

const strict = { additionalProperties: false } as const;
export const EvaluationBatchRepositoryScopeSchema = Type.Object(
  { repositoryId: EntityIdSchema },
  strict,
);
export const EvaluationBatchScopeSchema = Type.Object(
  { repositoryId: EntityIdSchema, evaluationId: EntityIdSchema },
  strict,
);
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const entityIdFields = new Set([
  "id",
  "repositoryId",
  "evaluationId",
  "suiteId",
  "suiteVersionId",
  "sourceId",
  "runId",
  "requestId",
  "profileId",
  "profileVersionId",
  "promptVersionId",
  "templateId",
  "sourceVersionId",
  "expectationVersionId",
  "caseId",
  "criterionId",
  "workItemId",
  "revisionId",
  "jobId",
  "resultId",
  "runAttemptId",
  "changeId",
  "cellId",
  "reviewRunId",
  "activationId",
  "testStepId",
  "observationId",
  "scenarioId",
  "stepId",
  "baselineProfileVersionId",
  "candidateProfileVersionId",
]);
const qualifiedCheckFields = new Set(["checkId", "fromCheckId", "toCheckId"]);
const qualifiedCheckPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u;
const invalidJson = Symbol("invalid JSON");
const encoder = new TextEncoder();

function snapshot(value: unknown, ancestors = new Set<object>(), key = ""): unknown {
  if (typeof value === "string")
    return value.isWellFormed() &&
      (!entityIdFields.has(key) || entityIdPattern.test(value)) &&
      (!qualifiedCheckFields.has(key) || qualifiedCheckPattern.test(value))
      ? value
      : invalidJson;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalidJson;
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    ancestors.size > 64 ||
    Object.getOwnPropertySymbols(value).length
  )
    return invalidJson;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return invalidJson;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([name]) => !Array.isArray(value) || name !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== value.length || entries.some(([name], index) => name !== String(index)))
  )
    return invalidJson;
  ancestors.add(value);
  const result: [string, unknown][] = [];
  for (const [name, descriptor] of entries) {
    if (!name.isWellFormed() || !descriptor.enumerable || !("value" in descriptor))
      return invalidJson;
    const child = snapshot(
      descriptor.value,
      ancestors,
      Array.isArray(value) ? (key === "selectedCaseIds" ? "id" : "") : name,
    );
    if (child === invalidJson) return invalidJson;
    result.push([name, child]);
  }
  ancestors.delete(value);
  return Array.isArray(value) ? result.map(([, child]) => child) : Object.fromEntries(result);
}

function formats(): void {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

function validated<T extends TSchema>(
  schema: T,
  input: unknown,
  issues: (value: unknown) => readonly string[],
  maximumBytes: number,
): Static<T> | typeof invalidJson {
  try {
    const value = snapshot(input);
    formats();
    return value !== invalidJson &&
      encoder.encode(JSON.stringify(value)).byteLength <= maximumBytes &&
      Value.Check(schema, value) &&
      issues(value).length === 0
      ? (value as Static<T>)
      : invalidJson;
  } catch {
    return invalidJson;
  }
}

export function evaluationBatchRequest<T extends TSchema>(
  schema: T,
  input: unknown,
  operation: string,
  issues: (value: unknown) => readonly string[] = () => [],
  maximumBytes = 64 * 1024,
): Static<T> {
  const value = validated(schema, input, issues, maximumBytes);
  if (value === invalidJson)
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  // The snapshot precedes asynchronous transport; change IDs and retries remain caller-owned.
  return value;
}

export function evaluationBatchResponse<T extends TSchema>(
  schema: T,
  input: unknown,
  operation: string,
  issues: (value: unknown) => readonly string[],
  maximumBytes: number,
): Static<T> {
  const value = validated(schema, input, issues, maximumBytes);
  if (value === invalidJson)
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response is invalid or outside its frozen scope.`,
    );
  return value;
}

export function evaluationBatchMatch(condition: boolean, operation: string): void {
  if (!condition)
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response does not match the requested scope or original change.`,
    );
}

export function evaluationBatchActor(
  input: OperatorPrincipal | undefined,
  operation: string,
): OperatorPrincipal | undefined {
  if (input === undefined) return undefined;
  return evaluationBatchRequest(OperatorPrincipalSchema, input, operation, (value) => {
    const actor = value as OperatorPrincipal;
    return [actor.issuer, actor.subject].some(
      (part) =>
        part.trim() !== part ||
        [...part].some((character) => {
          const code = character.charCodeAt(0);
          return (
            code < 32 ||
            (code >= 127 && code <= 159) ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
          );
        }),
    )
      ? ["An exact operator identity is required."]
      : [];
  });
}

export const evaluationBatchActorMatches = (
  actual: OperatorPrincipal,
  expected: OperatorPrincipal | undefined,
): boolean =>
  expected === undefined ||
  (actual.issuer === expected.issuer && actual.subject === expected.subject);

export const evaluationBatchPageQuery = (query: { page?: number; pageSize?: number }) => ({
  page: query.page ?? 1,
  pageSize: query.pageSize ?? 20,
});

export function evaluationBatchPageMatches(
  value: {
    repositoryId: string;
    page: number;
    pageSize: number;
    total: number;
    items: readonly unknown[];
  },
  repositoryId: string,
  query: { page: number; pageSize: number },
): boolean {
  const offset = (query.page - 1) * query.pageSize;
  return (
    Number.isSafeInteger(offset) &&
    value.repositoryId === repositoryId &&
    value.page === query.page &&
    value.pageSize === query.pageSize &&
    value.items.length === Math.min(query.pageSize, Math.max(0, value.total - offset))
  );
}
