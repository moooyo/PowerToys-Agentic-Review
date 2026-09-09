import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Sha256Schema } from "./common.js";
import { ValidationSummaryInputReferenceV1Schema } from "./model-summary-input-reference.js";

export const maximumModelInvocationCallCount = 128;
export const maximumModelRuntimeUtf8Bytes = 1024 * 1024;
export const maximumModelRequestBytes = 16 * 1024 * 1024;
export const maximumModelResponseBytes = 64 * 1024 * 1024;
export const maximumModelResponseEventCount = 1_000_000;

const strict = { additionalProperties: false } as const;
const exactId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
const identifier = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum });
const modelIdentifier = identifier(1024);
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))(?![\s\S])/u;
const timestamp = Type.String({ pattern: dateTimePattern.source, minLength: 20, maxLength: 64 });
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const nullableIdentifier = Type.Union([modelIdentifier, Type.Null()]);
const runtimeProperties = {
  providerId: identifier(128),
  endpointSha256: Sha256Schema,
  client: Type.Object(
    {
      kind: Type.Literal("codex_cli"),
      version: identifier(128),
      executableSha256: Sha256Schema,
      // The launcher hashes stable effective configuration, excluding credentials and attempt paths.
      launchPolicySha256: Sha256Schema,
    },
    strict,
  ),
  relay: Type.Object({ implementationSha256: Sha256Schema, policySha256: Sha256Schema }, strict),
};

export const ModelRuntimeIdentityV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeIdentityV1"),
    ...runtimeProperties,
    modelId: modelIdentifier,
  },
  strict,
);
export type ModelRuntimeIdentityV1 = Static<typeof ModelRuntimeIdentityV1Schema>;

export const ModelInvocationScopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelInvocationScopeV1"),
    repositoryId: exactId,
    evaluationId: exactId,
    cellId: exactId,
    runId: exactId,
    requestId: exactId,
    jobId: exactId,
    attemptId: exactId,
    invocationId: exactId,
    authorizationId: exactId,
    executionManifestSha256: Sha256Schema,
    promptSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    expectedModelIdentitySha256: Sha256Schema,
    requestedModel: modelIdentifier,
    workerNodeId: exactId,
    workerInstanceId: exactId,
    leaseGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  strict,
);
export type ModelInvocationScopeV1 = Static<typeof ModelInvocationScopeV1Schema>;

export const ModelInvocationScopeV2Schema = Type.Object(
  {
    ...ModelInvocationScopeV1Schema.properties,
    schemaVersion: Type.Literal("ModelInvocationScopeV2"),
    purpose: Type.Literal("validation_summary"),
    inputRef: ValidationSummaryInputReferenceV1Schema,
  },
  strict,
);
export type ModelInvocationScopeV2 = Static<typeof ModelInvocationScopeV2Schema>;
export const ModelInvocationScopeSchema = Type.Union([
  ModelInvocationScopeV1Schema,
  ModelInvocationScopeV2Schema,
]);
export type ModelInvocationScope = Static<typeof ModelInvocationScopeSchema>;

export const ModelResponseReasonCodeSchema = Type.Union([
  Type.Literal("BODY_LIMIT_EXCEEDED"),
  Type.Literal("EVENT_LIMIT_EXCEEDED"),
  Type.Literal("OUTPUT_LIMIT_EXCEEDED"),
  Type.Literal("INVALID_UTF8"),
  Type.Literal("INVALID_JSON"),
  Type.Literal("AMBIGUOUS_JSON"),
  Type.Literal("JSON_COMPLEXITY_EXCEEDED"),
  Type.Literal("INVALID_SSE"),
  Type.Literal("INVALID_SEQUENCE"),
  Type.Literal("INVALID_METADATA"),
  Type.Literal("CONFLICTING_METADATA"),
  Type.Literal("INVALID_TERMINAL"),
  Type.Literal("MISSING_TERMINAL"),
  Type.Literal("TRANSPORT_INCOMPLETE"),
  Type.Literal("RESPONSE_FAILED"),
  Type.Literal("RESPONSE_INCOMPLETE"),
]);
export type ModelResponseReasonCode = Static<typeof ModelResponseReasonCodeSchema>;

export const ModelResponseObservationV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelResponseObservationV1"),
    bodySha256: Sha256Schema,
    bodyBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    eventCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    transportComplete: Type.Boolean(),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
      Type.Literal("invalid"),
    ]),
    responseId: nullableIdentifier,
    modelId: nullableIdentifier,
    outputJsonSha256: nullableDigest,
    reasonCode: Type.Union([ModelResponseReasonCodeSchema, Type.Null()]),
  },
  strict,
);
export type ModelResponseObservationV1 = Static<typeof ModelResponseObservationV1Schema>;

export const ModelCallReceiptV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelCallReceiptV1"),
    scopeSha256: Sha256Schema,
    sequence: Type.Integer({ minimum: 1, maximum: maximumModelInvocationCallCount }),
    previousReceiptSha256: nullableDigest,
    startedAt: timestamp,
    finishedAt: timestamp,
    requestSha256: Sha256Schema,
    requestBytes: Type.Integer({ minimum: 0, maximum: maximumModelRequestBytes }),
    requestedModel: modelIdentifier,
    httpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
    response: Type.Union([ModelResponseObservationV1Schema, Type.Null()]),
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("provider_failed"),
      Type.Literal("provider_incomplete"),
      Type.Literal("transport_failed"),
      Type.Literal("cancelled"),
      Type.Literal("protocol_invalid"),
      Type.Literal("budget_exceeded"),
    ]),
  },
  strict,
);
export type ModelCallReceiptV1 = Static<typeof ModelCallReceiptV1Schema>;

export const ModelInvocationReceiptSetV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelInvocationReceiptSetV1"),
    scope: ModelInvocationScopeV1Schema,
    scopeSha256: Sha256Schema,
    runtime: Type.Object(runtimeProperties, strict),
    calls: Type.Array(
      Type.Object({ receipt: ModelCallReceiptV1Schema, sha256: Sha256Schema }, strict),
      { maxItems: maximumModelInvocationCallCount },
    ),
    closedAt: timestamp,
    state: Type.Union([Type.Literal("closed"), Type.Literal("cancelled")]),
    modelOutputSha256: nullableDigest,
    observedIdentity: Type.Union([ModelRuntimeIdentityV1Schema, Type.Null()]),
    observedIdentitySha256: nullableDigest,
  },
  strict,
);
export type ModelInvocationReceiptSetV1 = Static<typeof ModelInvocationReceiptSetV1Schema>;

export const ModelInvocationReceiptSetV2Schema = Type.Object(
  {
    ...ModelInvocationReceiptSetV1Schema.properties,
    schemaVersion: Type.Literal("ModelInvocationReceiptSetV2"),
    scope: ModelInvocationScopeV2Schema,
  },
  strict,
);
export type ModelInvocationReceiptSetV2 = Static<typeof ModelInvocationReceiptSetV2Schema>;
export const ModelInvocationReceiptSetSchema = Type.Union([
  ModelInvocationReceiptSetV1Schema,
  ModelInvocationReceiptSetV2Schema,
]);
export type ModelInvocationReceiptSet = Static<typeof ModelInvocationReceiptSetSchema>;

function wellFormed(value: unknown, parents = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value) || parents.size > 64) return false;
  if (
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
  )
    return false;
  parents.add(value);
  const valid = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      wellFormed(descriptor.value, parents),
  );
  parents.delete(value);
  return valid;
}

function dateTime(value: string): boolean {
  const match = dateTimePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function shapeIssues(schema: TSchema, value: unknown): string[] {
  const invalid = "Model runtime metadata must match its strict JSON contract.";
  try {
    if (!wellFormed(value) || !Value.Check(schema, value)) return [invalid];
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumModelRuntimeUtf8Bytes)
      return ["Model runtime metadata exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return [invalid];
  }
}

function exactText(value: string): boolean {
  return value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function runtimeIssues(runtime: ModelInvocationReceiptSetV1["runtime"]): string[] {
  return [runtime.providerId, runtime.client.version].every(exactText)
    ? []
    : ["Runtime identifiers must retain exact text without control characters."];
}

function identityIssues(identity: ModelRuntimeIdentityV1): string[] {
  return [
    ...runtimeIssues(identity),
    ...(exactText(identity.modelId)
      ? []
      : ["The observed model identifier must retain exact text without control characters."]),
  ];
}

function observationIssues(response: ModelResponseObservationV1): string[] {
  const issues: string[] = [];
  // An invalid observation retains the actual counter at which bounded parsing stopped.
  if (
    response.outcome !== "invalid" &&
    (response.bodyBytes === 0 ||
      response.bodyBytes > maximumModelResponseBytes ||
      response.eventCount > maximumModelResponseEventCount)
  )
    issues.push(
      "Recognized responses require a nonempty body within the global body and event budgets.",
    );
  if ([response.responseId, response.modelId].some((entry) => entry !== null && !exactText(entry)))
    issues.push("Response identifiers must retain exact text without control characters.");
  if (
    response.outcome !== "invalid" &&
    (!response.transportComplete || response.responseId === null || response.modelId === null)
  )
    issues.push(
      "A recognized response requires complete transport and its response/model identities.",
    );
  const expectedReason = {
    completed: null,
    failed: "RESPONSE_FAILED",
    incomplete: "RESPONSE_INCOMPLETE",
  } as const;
  if (response.outcome !== "invalid" && response.reasonCode !== expectedReason[response.outcome])
    issues.push("The response outcome must retain its corresponding diagnostic reason code.");
  if (response.outcome !== "completed" && response.outputJsonSha256 !== null)
    issues.push("Only a completed response can identify structured output bytes.");
  if (response.reasonCode === "TRANSPORT_INCOMPLETE" && response.transportComplete)
    issues.push("An incomplete transport reason cannot claim complete transport.");
  if (
    response.outcome === "invalid" &&
    (response.responseId !== null ||
      response.modelId !== null ||
      response.reasonCode === null ||
      response.reasonCode === "RESPONSE_FAILED" ||
      response.reasonCode === "RESPONSE_INCOMPLETE")
  )
    issues.push(
      "Invalid metadata must omit response/model identities and retain its invalidity reason.",
    );
  return issues;
}

function callIssues(receipt: ModelCallReceiptV1): string[] {
  const issues: string[] = [];
  if (!exactText(receipt.requestedModel))
    issues.push(
      "The requested model identifier must retain exact text without control characters.",
    );
  if (
    !dateTime(receipt.startedAt) ||
    !dateTime(receipt.finishedAt) ||
    Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
  )
    issues.push("A model call must finish at or after its recorded start.");
  if ((receipt.sequence === 1) !== (receipt.previousReceiptSha256 === null))
    issues.push("Only the first call may omit its previous receipt digest.");
  if (receipt.response !== null) issues.push(...observationIssues(receipt.response));
  if (
    receipt.outcome === "completed" &&
    (receipt.httpStatus === null ||
      receipt.httpStatus < 200 ||
      receipt.httpStatus >= 300 ||
      receipt.response?.outcome !== "completed")
  )
    issues.push("A completed call requires a successful HTTP status and completed response.");
  if (receipt.outcome === "provider_incomplete" && receipt.response?.outcome !== "incomplete")
    issues.push("An incomplete provider call must retain its incomplete response observation.");
  if (
    receipt.outcome === "provider_failed" &&
    receipt.response !== null &&
    receipt.response.outcome !== "failed"
  )
    issues.push("A failed provider call cannot claim a completed response observation.");
  return issues;
}

/** Consistency only: the owner separately authenticates the source and recomputes every digest. */
export function getModelRuntimeIdentityIssues(value: unknown): string[] {
  const issues = shapeIssues(ModelRuntimeIdentityV1Schema, value);
  return issues.length > 0 ? issues : identityIssues(value as ModelRuntimeIdentityV1);
}

export function getModelInvocationScopeIssues(value: unknown): string[] {
  const issues = shapeIssues(ModelInvocationScopeSchema, value);
  if (issues.length > 0) return issues;
  const scope = value as ModelInvocationScope;
  if (!exactText(scope.requestedModel))
    issues.push(
      "The requested model identifier must retain exact text without control characters.",
    );
  if (
    scope.schemaVersion === "ModelInvocationScopeV2" &&
    (scope.inputRef.sourcePromptSha256 !== scope.promptSha256 ||
      scope.inputRef.outputSchemaSha256 !== scope.outputSchemaSha256)
  )
    issues.push(
      "A summary invocation must preserve the original Prompt and output schema identities.",
    );
  return issues;
}

export function getModelResponseObservationIssues(value: unknown): string[] {
  const issues = shapeIssues(ModelResponseObservationV1Schema, value);
  return issues.length > 0 ? issues : observationIssues(value as ModelResponseObservationV1);
}

export function getModelCallReceiptIssues(value: unknown): string[] {
  const issues = shapeIssues(ModelCallReceiptV1Schema, value);
  return issues.length > 0 ? issues : callIssues(value as ModelCallReceiptV1);
}

/** Closed/completed metadata is not model attestation, authorization, or proof of confinement. */
export function getModelInvocationReceiptSetIssues(value: unknown): string[] {
  const issues = shapeIssues(ModelInvocationReceiptSetSchema, value);
  if (issues.length > 0) return issues;
  const set = value as ModelInvocationReceiptSet;
  issues.push(...getModelInvocationScopeIssues(set.scope), ...runtimeIssues(set.runtime));
  if (!dateTime(set.closedAt)) issues.push("Invocation closure requires an exact timestamp.");
  const digests = new Set<string>();
  for (const [index, entry] of set.calls.entries()) {
    const { receipt, sha256 } = entry;
    issues.push(...callIssues(receipt));
    if (
      receipt.sequence !== index + 1 ||
      receipt.previousReceiptSha256 !== (set.calls[index - 1]?.sha256 ?? null) ||
      receipt.scopeSha256 !== set.scopeSha256 ||
      receipt.requestedModel !== set.scope.requestedModel ||
      digests.has(sha256)
    )
      issues.push("Invocation calls must retain their complete ordered scope-bound receipt chain.");
    digests.add(sha256);
    if (Date.parse(receipt.finishedAt) > Date.parse(set.closedAt))
      issues.push("Invocation closure cannot precede a recorded call's completion.");
  }
  const last = set.calls.at(-1)?.receipt;
  if (
    set.modelOutputSha256 !== null &&
    (set.state !== "closed" ||
      last?.outcome !== "completed" ||
      last.response?.outputJsonSha256 !== set.modelOutputSha256)
  )
    issues.push("Invocation output must match the final completed call of a closed chain.");
  if ((set.observedIdentity === null) !== (set.observedIdentitySha256 === null))
    issues.push("Observed identity and its digest must be present or absent together.");
  if (set.observedIdentity !== null) {
    const identity = set.observedIdentity;
    issues.push(...identityIssues(identity));
    if (
      identity.providerId !== set.runtime.providerId ||
      identity.endpointSha256 !== set.runtime.endpointSha256 ||
      identity.client.kind !== set.runtime.client.kind ||
      identity.client.version !== set.runtime.client.version ||
      identity.client.executableSha256 !== set.runtime.client.executableSha256 ||
      identity.client.launchPolicySha256 !== set.runtime.client.launchPolicySha256 ||
      identity.relay.implementationSha256 !== set.runtime.relay.implementationSha256 ||
      identity.relay.policySha256 !== set.runtime.relay.policySha256
    )
      issues.push(
        "Observed identity must retain the measured provider, client, and relay runtime.",
      );
    if (
      set.calls.length === 0 ||
      set.calls.some(
        ({ receipt }) =>
          receipt.outcome === "transport_failed" ||
          receipt.outcome === "protocol_invalid" ||
          receipt.response === null ||
          !receipt.response.transportComplete ||
          receipt.response.outcome === "invalid" ||
          receipt.response.responseId === null ||
          receipt.response.modelId !== identity.modelId,
      )
    )
      issues.push("Observed identity requires consistent valid metadata from every recorded call.");
  }
  return issues;
}
