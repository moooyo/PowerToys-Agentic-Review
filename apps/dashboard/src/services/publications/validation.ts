import {
  maximumPublicationRequestUtf8Bytes,
  maximumPublicationResponseUtf8Bytes,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";

if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
  );
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
function validWire(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string")
    return (
      value.isWellFormed() &&
      !value.includes("\0") &&
      (!(key === "id" || key.endsWith("Id")) || idPattern.test(value))
    );
  if (Array.isArray(value)) return value.every((entry) => validWire(entry));
  return (
    value === null ||
    typeof value !== "object" ||
    Object.entries(value).every(([entryKey, entry]) => validWire(entry, entryKey))
  );
}
export function publicationId(value: string, operation = "read publications"): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new ReviewControlRequestError(
      operation,
      "scope",
      "An exact valid repository and publication scope is required.",
    );
  return value;
}
export function publicationRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (
    !Value.Check(schema, value) ||
    !validWire(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumPublicationRequestUtf8Bytes
  )
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  return structuredClone(value);
}
export function publicationResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  issues: (value: Static<T>) => string[] = () => [],
): Static<T> {
  if (
    !Value.Check(schema, value) ||
    !validWire(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      maximumPublicationResponseUtf8Bytes ||
    issues(value).length > 0
  )
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response is invalid or outside its exact scope.`,
    );
  return value;
}
export function assertPublicationMatch(matches: boolean, operation: string): void {
  if (!matches)
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} receipt does not match the submitted action.`,
    );
}
