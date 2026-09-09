import {
  EntityIdSchema,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";

const strict = { additionalProperties: false } as const;
const repositoryProperties = { repositoryId: EntityIdSchema };
const suiteProperties = { ...repositoryProperties, suiteId: EntityIdSchema };
const versionProperties = { ...suiteProperties, versionId: EntityIdSchema };
export const EvaluationRepositoryScopeSchema = Type.Object(repositoryProperties, strict);
export const EvaluationSourceScopeSchema = Type.Object(
  { ...repositoryProperties, sourceId: EntityIdSchema },
  strict,
);
export const EvaluationSuiteScopeSchema = Type.Object(suiteProperties, strict);
export const EvaluationSuiteVersionScopeSchema = Type.Object(versionProperties, strict);
export const EvaluationSuiteCaseScopeSchema = Type.Object(
  { ...versionProperties, caseId: EntityIdSchema },
  strict,
);

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const entityIdFields = new Set([
  "id",
  "repositoryId",
  "sourceId",
  "suiteId",
  "versionId",
  "caseId",
  "workItemId",
  "revisionId",
  "changeId",
  "sourceVersionId",
  "expectationVersionId",
  "latestVersionId",
  "reviewRunId",
  "criterionId",
  "expectedFindingId",
]);
const encoder = new TextEncoder();

function ensureFormats(): void {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  }
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

function validJson(value: unknown, ancestors = new Set<object>(), key = ""): boolean {
  if (typeof value === "string") {
    return value.isWellFormed() && (!entityIdFields.has(key) || entityIdPattern.test(value));
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value) || ancestors.size > 64) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? [...value].every((entry) => validJson(entry, ancestors))
    : Object.entries(value).every(
        ([entryKey, entry]) => entryKey.isWellFormed() && validJson(entry, ancestors, entryKey),
      );
  ancestors.delete(value);
  return valid;
}

function valid<T extends TSchema>(
  schema: T,
  value: unknown,
  issues: (value: unknown) => readonly string[],
  maximumBytes: number,
): value is Static<T> {
  ensureFormats();
  return (
    validJson(value) &&
    encoder.encode(JSON.stringify(value)).byteLength <= maximumBytes &&
    Value.Check(schema, value) &&
    issues(value).length === 0
  );
}

export function evaluationRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  issues: (value: unknown) => readonly string[] = () => [],
  maximumBytes = 64 * 1024,
): Static<T> {
  if (!valid(schema, value, issues, maximumBytes)) {
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  }
  // Capture the exact caller intent before any asynchronous work. The caller owns change IDs.
  return structuredClone(value);
}

export function evaluationResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  issues: (value: unknown) => readonly string[],
  maximumBytes: number,
): Static<T> {
  if (!valid(schema, value, issues, maximumBytes)) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response is invalid or outside its frozen scope.`,
    );
  }
  return value;
}

export function evaluationMatch(condition: boolean, operation: string): void {
  if (!condition)
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response does not match the requested scope or original change.`,
    );
}

export function evaluationActor(
  value: OperatorPrincipal | undefined,
  operation: string,
): OperatorPrincipal | undefined {
  if (value === undefined) return undefined;
  return evaluationRequest(OperatorPrincipalSchema, value, operation, (input) => {
    const actor = input as OperatorPrincipal;
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

export function evaluationActorMatches(
  actual: OperatorPrincipal,
  expected: OperatorPrincipal | undefined,
): boolean {
  return (
    expected === undefined ||
    (actual.issuer === expected.issuer && actual.subject === expected.subject)
  );
}

export function evaluationPageQuery(query: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  return { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
}

export function evaluationPageMatches(
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
