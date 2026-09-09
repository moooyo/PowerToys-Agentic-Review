import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  ModelInvocationBeginRequestSchema,
  type ModelInvocationReceiptSetV1,
  type ModelInvocationScope,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { ModelInvocationApi } from "../server-client/model-invocation-api.js";
import { snapshotModelInvocationBeginRequest } from "../server-client/model-invocation-api.js";
import {
  createModelInvocationSession,
  type ModelInvocationSession,
} from "./model-invocation-coordinator.js";
import {
  type CreateModelInvocation,
  createModelInvocationScope,
  createSummaryModelInvocationScope,
} from "./model-output-artifact.js";
import {
  describeModelResponseRelayPolicy,
  type ModelResponseRelayOptions,
} from "./model-response-relay.js";
import type { PreparedModelInvocation } from "./prepared-codex-output-runner.js";

export interface ModelInvocationFactoryOptions {
  readonly api: ModelInvocationApi;
  /** Startup-owned runtime binding. Per-process configuration and confinement remain independent. */
  readonly runtime: ModelInvocationReceiptSetV1["runtime"];
  readonly endpoint: string;
  readonly authorize: ModelResponseRelayOptions["authorize"];
  readonly relayLimits?: ModelResponseRelayOptions["limits"];
  readonly relayTransport?: ModelResponseRelayOptions["transport"];
  readonly operationTimeoutMs?: number;
  readonly processTimeoutMs?: number;
  readonly createInvocationId?: () => string;
}

export class ModelInvocationFactoryError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "INVALID_ENVELOPE"
      | "RUNTIME_MISMATCH"
      | "ATTEMPT_CONTEXT_CHANGED"
      | "DEADLINE_EXCEEDED"
      | "CANCELLED",
  ) {
    super("The frozen task could not create its parent-owned model invocation.");
    this.name = "ModelInvocationFactoryError";
  }
}
const failure = (code: ModelInvocationFactoryError["code"]) =>
  new ModelInvocationFactoryError(code);
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function fields(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failure("INVALID_CONFIGURATION");
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) throw failure("INVALID_CONFIGURATION");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
      throw failure("INVALID_CONFIGURATION");
    result[key] = descriptor.value;
  }
  return result;
}

/** Runtime and relay-limit data are small records with no arrays or executable properties. */
function copyConfiguration(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): unknown {
  if (depth > 8 || ++budget.nodes > 4096) throw failure("INVALID_CONFIGURATION");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.isWellFormed()) {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 32768) throw failure("INVALID_CONFIGURATION");
    return value;
  }
  const entries = Object.entries(fields(value));
  if (entries.length > 64) throw failure("INVALID_CONFIGURATION");
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, child]) => {
        budget.bytes += Buffer.byteLength(key);
        if (!key.isWellFormed() || budget.bytes > 32768) throw failure("INVALID_CONFIGURATION");
        return [key, copyConfiguration(child, depth + 1, budget)];
      }),
    ),
  );
}

function optionalTimeout(value: unknown, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw failure("INVALID_CONFIGURATION");
  return value;
}

/** Opens at most one retained session for a frozen attempt; it does not enable execution gates. */
export function createModelInvocationFactory(
  options: ModelInvocationFactoryOptions,
): CreateModelInvocation {
  let runtime: ModelInvocationReceiptSetV1["runtime"];
  let endpoint: string;
  let authorize: ModelResponseRelayOptions["authorize"];
  let relayTransport: ModelResponseRelayOptions["transport"];
  let relayLimits: ModelResponseRelayOptions["limits"];
  let api: ModelInvocationApi;
  let operationTimeoutMs: number | undefined;
  let processTimeoutMs: number | undefined;
  let nextId: () => string;
  try {
    const captured = fields(options);
    if (
      Object.keys(captured).some(
        (key) =>
          ![
            "api",
            "runtime",
            "endpoint",
            "authorize",
            "relayLimits",
            "relayTransport",
            "operationTimeoutMs",
            "processTimeoutMs",
            "createInvocationId",
          ].includes(key),
      )
    )
      throw failure("INVALID_CONFIGURATION");
    runtime = copyConfiguration(captured.runtime) as typeof runtime;
    if (!Value.Check(ModelInvocationBeginRequestSchema.properties.runtime, runtime))
      throw failure("INVALID_CONFIGURATION");
    endpoint = captured.endpoint as string;
    if (typeof endpoint !== "string") throw failure("INVALID_CONFIGURATION");
    const target = new URL(endpoint);
    if (
      typeof endpoint !== "string" ||
      target.protocol !== "https:" ||
      target.href !== endpoint ||
      !target.pathname.endsWith("/responses") ||
      target.search ||
      target.hash ||
      target.username ||
      target.password ||
      runtime.endpointSha256 !== hash(endpoint)
    )
      throw failure("INVALID_CONFIGURATION");
    const overrides =
      captured.relayLimits === undefined ? undefined : copyConfiguration(captured.relayLimits);
    const defaultLimits = describeModelResponseRelayPolicy().descriptor.limits;
    if (
      overrides !== undefined &&
      Object.keys(overrides as object).some((key) => !Object.hasOwn(defaultLimits, key))
    )
      throw failure("INVALID_CONFIGURATION");
    const policy = describeModelResponseRelayPolicy(
      overrides as ModelResponseRelayOptions["limits"],
    );
    relayLimits = policy.descriptor.limits;
    if (runtime.relay.policySha256 !== policy.sha256) throw failure("INVALID_CONFIGURATION");
    authorize = captured.authorize as typeof authorize;
    relayTransport = captured.relayTransport as typeof relayTransport;
    nextId = (captured.createInvocationId ?? (() => `invocation:${randomUUID()}`)) as typeof nextId;
    if (
      typeof authorize !== "function" ||
      typeof nextId !== "function" ||
      (relayTransport !== undefined && typeof relayTransport !== "function")
    )
      throw failure("INVALID_CONFIGURATION");
    const sourceApi = captured.api as ModelInvocationApi;
    api = Object.freeze({
      beginModelInvocation: sourceApi.beginModelInvocation.bind(sourceApi),
      sealModelInvocation: sourceApi.sealModelInvocation.bind(sourceApi),
      submitModelInvocationReceipts: sourceApi.submitModelInvocationReceipts.bind(sourceApi),
    });
    operationTimeoutMs = optionalTimeout(captured.operationTimeoutMs, 60_000);
    processTimeoutMs = optionalTimeout(captured.processTimeoutMs, 2 * 60 * 60 * 1000);
  } catch {
    throw failure("INVALID_CONFIGURATION");
  }

  const attempts = new WeakMap<
    AbortSignal,
    Map<
      string,
      {
        readonly envelopeSha256: string;
        readonly executionSignal: AbortSignal;
        readonly prepared: PreparedModelInvocation;
      }
    >
  >();
  return (input, context, summaryInput) => {
    let envelope: typeof input;
    let scope: ModelInvocationScope;
    let executionSignal: AbortSignal;
    let owner: AbortSignal;
    try {
      executionSignal = context.signal;
      owner = context.attemptSignal ?? executionSignal;
      if (!(executionSignal instanceof AbortSignal) || !(owner instanceof AbortSignal))
        throw new Error();
      if (executionSignal.aborted || owner.aborted) throw failure("CANCELLED");
      scope =
        summaryInput === undefined
          ? createModelInvocationScope(input, nextId())
          : createSummaryModelInvocationScope(input, nextId(), summaryInput);
      // Scope creation rejects active properties before this synchronous copy of the envelope.
      envelope = structuredClone(input);
    } catch (cause) {
      if (cause instanceof ModelInvocationFactoryError) throw cause;
      throw failure("INVALID_ENVELOPE");
    }
    if (envelope.validation.schemaVersion !== "ValidationJobContextV2")
      throw failure("INVALID_ENVELOPE");
    const registration = envelope.validation.modelRuntimeRegistration;
    if (registration === undefined) throw failure("INVALID_ENVELOPE");
    const {
      schemaVersion: _version,
      modelId: _model,
      ...registeredRuntime
    } = registration.identity;
    if (createCanonicalResult(registeredRuntime).json !== createCanonicalResult(runtime).json)
      throw failure("RUNTIME_MISMATCH");
    const key = JSON.stringify([scope.jobId, scope.attemptId]);
    const envelopeSha256 = createCanonicalResult({
      envelope,
      summaryInput: scope.schemaVersion === "ModelInvocationScopeV2" ? scope.inputRef : null,
    }).sha256;
    const owned = attempts.get(owner) ?? new Map();
    const previous = owned.get(key);
    if (previous !== undefined) {
      if (
        previous.envelopeSha256 !== envelopeSha256 ||
        previous.executionSignal !== executionSignal
      )
        throw failure("ATTEMPT_CONTEXT_CHANGED");
      return previous.prepared;
    }
    const begin = snapshotModelInvocationBeginRequest({
      lease: envelope.lease,
      invocationId: scope.invocationId,
      runtime,
      ...(scope.schemaVersion === "ModelInvocationScopeV2" ? { summaryInput: scope.inputRef } : {}),
    }).value;
    const deadline = Math.min(
      Date.parse(envelope.executionDeadlineAt),
      Date.parse(envelope.assignedAt) + envelope.executionPolicy.hardTimeoutMs,
    );
    const currentTime = Date.now();
    if (
      !Number.isSafeInteger(deadline) ||
      deadline <= currentTime ||
      deadline - currentTime > 2 * 60 * 60 * 1000
    )
      throw failure("DEADLINE_EXCEEDED");
    let opening: Promise<ModelInvocationSession> | undefined;
    const invocationSignal = AbortSignal.any([executionSignal, owner]);
    const prepared: PreparedModelInvocation = Object.freeze({
      expectedScope: scope,
      open: () => {
        opening ??= Promise.resolve().then(() => {
          if (executionSignal.aborted || owner.aborted) throw failure("CANCELLED");
          if (Date.now() >= deadline) throw failure("DEADLINE_EXCEEDED");
          return createModelInvocationSession({
            api,
            lease: begin.lease,
            expectedScope: scope,
            runtime: begin.runtime,
            relayOptions: {
              endpoint,
              authorize,
              signal: invocationSignal,
              deadlineAt: new Date(deadline).toISOString(),
              limits: relayLimits,
              ...(relayTransport === undefined ? {} : { transport: relayTransport }),
            },
            ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
            ...(processTimeoutMs === undefined ? {} : { processTimeoutMs }),
          });
        });
        return opening;
      },
    });
    owned.set(key, { envelopeSha256, executionSignal, prepared });
    attempts.set(owner, owned);
    return prepared;
  };
}
