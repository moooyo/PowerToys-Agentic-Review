import {
  maximumNotificationRequestUtf8Bytes,
  maximumNotificationResponseUtf8Bytes,
  NotificationIdSchema,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";

if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

function validWire(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\0");
  if (Array.isArray(value)) return value.every(validWire);
  return value === null || typeof value !== "object" || Object.values(value).every(validWire);
}
export function notificationRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  issues: (value: Static<T>) => string[] = () => [],
): Static<T> {
  if (
    !Value.Check(schema, value) ||
    !validWire(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      maximumNotificationRequestUtf8Bytes ||
    issues(value).length > 0
  )
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  return structuredClone(value);
}
export function notificationId(value: string): string {
  return notificationRequest(NotificationIdSchema, value, "scope notifications");
}
export function notificationActor(value: OperatorPrincipal): OperatorPrincipal {
  return notificationRequest(
    OperatorPrincipalSchema,
    value,
    "scope notification operator",
    (actor) =>
      [actor.issuer, actor.subject].some(
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
        ? ["invalid_actor"]
        : [],
  );
}
export function notificationResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
  issues: (value: Static<T>) => string[],
): Static<T> {
  if (
    !Value.Check(schema, value) ||
    !validWire(value) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      maximumNotificationResponseUtf8Bytes ||
    issues(value).length > 0
  )
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response is invalid or outside its exact operator and repository scope.`,
    );
  return value;
}
