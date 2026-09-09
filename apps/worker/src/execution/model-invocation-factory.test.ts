import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import type {
  JobExecutionEnvelopeV2,
  ModelInvocationReceiptSetV1,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionContext } from "./job-executor.js";
import {
  createModelInvocationFactory,
  type ModelInvocationFactoryOptions,
} from "./model-invocation-factory.js";
import {
  captureModelInvocationScope,
  createModelInvocationScope,
} from "./model-output-artifact.js";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";
import { describeModelResponseRelayPolicy } from "./model-response-relay.js";

// These tests isolate factory composition; no coordinator, HTTP, process or persistence runs.
const coordinator = vi.hoisted(() => vi.fn());
vi.mock("./model-invocation-coordinator.js", () => ({ createModelInvocationSession: coordinator }));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(kind: "pull_request" | "issue" = "pull_request") {
  const { envelope } = modelArtifactEvaluationFixture(kind);
  const registration = envelope.validation.modelRuntimeRegistration;
  if (!registration) throw new Error("Missing synthetic registration.");
  const endpoint = "https://provider.invalid/v1/responses";
  registration.identity.endpointSha256 = hash(endpoint);
  registration.identity.relay.policySha256 = describeModelResponseRelayPolicy().sha256;
  registration.identitySha256 = createCanonicalResult(registration.identity).sha256;
  envelope.validation.modelRequirements.expectedModelIdentityDigest = registration.identitySha256;
  const reference = envelope.validation.modelRequirements.runtimeRegistration;
  if (!reference) throw new Error("Missing synthetic runtime reference.");
  reference.registrationSha256 = createCanonicalResult(registration).sha256;
  const {
    schemaVersion: _version,
    modelId: _model,
    ...runtime
  } = structuredClone(registration.identity);
  const api = {
    beginModelInvocation: vi.fn(async () => {
      throw new Error("Unexpected synthetic API invocation.");
    }),
    sealModelInvocation: vi.fn(async () => {
      throw new Error("Unexpected synthetic API invocation.");
    }),
    submitModelInvocationReceipts: vi.fn(async () => {
      throw new Error("Unexpected synthetic API invocation.");
    }),
  };
  const owner = new AbortController();
  const context: JobExecutionContext = {
    signal: owner.signal,
    attemptSignal: owner.signal,
    processHost: {
      start: vi.fn(async () => {
        throw new Error("Unexpected process launch.");
      }),
      terminateAll: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
  };
  const options: ModelInvocationFactoryOptions = {
    api,
    runtime,
    endpoint,
    authorize: vi.fn(async () => ({ headers: {}, protectedValues: [] })),
    createInvocationId: () => "invocation-fixed",
  };
  return { envelope, registration, runtime, api, owner, context, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:10.000Z"));
  coordinator.mockReset().mockResolvedValue({ syntheticSession: true });
});
afterEach(() => vi.useRealTimers());

describe("frozen parent model invocation factory", () => {
  it("retains the complete summary reference in scope and same-attempt replay identity", () => {
    const f = fixture("issue");
    const create = createModelInvocationFactory(f.options);
    const reference = {
      schemaVersion: "ValidationSummaryInputReferenceV1" as const,
      inputId: "summary-input",
      inputSha256: "a".repeat(64),
      sourcePromptSha256: f.envelope.prompt.promptSha256,
      outputSchemaSha256: f.envelope.prompt.outputSchemaSha256,
      contextSha256: "b".repeat(64),
      actualPromptSha256: "c".repeat(64),
    };
    const prepared = create(f.envelope, f.context, reference);
    expect(prepared.expectedScope).toMatchObject({
      schemaVersion: "ModelInvocationScopeV2",
      inputRef: reference,
    });
    expect(create(f.envelope, f.context, reference)).toBe(prepared);
    expect(() =>
      create(f.envelope, f.context, { ...reference, contextSha256: "d".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "ATTEMPT_CONTEXT_CHANGED" }));
    expect(() => create(f.envelope, f.context)).toThrow(
      expect.objectContaining({ code: "ATTEMPT_CONTEXT_CHANGED" }),
    );
    expect(coordinator).not.toHaveBeenCalled();
  });
  it.each([Symbol.toPrimitive, "toString"])(
    "rejects an endpoint object without invoking %s",
    (key) => {
      const f = fixture();
      const convert = vi.fn(() => f.options.endpoint);
      const endpoint = { [key]: convert };
      expect(() =>
        createModelInvocationFactory({
          ...f.options,
          endpoint,
        } as unknown as ModelInvocationFactoryOptions),
      ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
      expect(convert).not.toHaveBeenCalled();
    },
  );

  it.each(["pull_request", "issue"] as const)(
    "derives the exact %s scope without trusting caller-supplied identifiers",
    (kind) => {
      const f = fixture(kind);
      const scope = createModelInvocationScope(f.envelope, "invocation-fixed");
      expect(captureModelInvocationScope(scope, f.envelope)).toEqual(scope);
      expect(scope).toMatchObject({
        repositoryId: "repo-a",
        evaluationId: "evaluation-a",
        cellId: "cell-a",
        authorizationId: "authorization-a",
        attemptId: "attempt-a",
        requestedModel: "alias-a",
        expectedModelIdentitySha256: f.registration.identitySha256,
      });
      expect(Object.isFrozen(scope)).toBe(true);
      expect(createModelInvocationFactory(f.options)(f.envelope, f.context).expectedScope).toEqual(
        scope,
      );
      expect(coordinator).not.toHaveBeenCalled();
    },
  );

  it("captures configuration, complete scope and the earlier hard deadline before opening", async () => {
    const f = fixture();
    const factory = createModelInvocationFactory(f.options);
    const expectedRuntime = structuredClone(f.runtime);
    f.runtime.client.executableSha256 = "f".repeat(64);
    const prepared = factory(f.envelope, f.context);
    const expectedScope = prepared.expectedScope;
    f.envelope.lease.leaseToken = "changed-after-preparation";
    f.envelope.prompt.renderedPrompt = "Changed after preparation.";
    await prepared.open();
    const captured = coordinator.mock.calls[0]?.[0];
    expect(captured).toMatchObject({
      expectedScope,
      runtime: expectedRuntime,
      lease: { leaseToken: "private-lease-token-for-artifact-check" },
      relayOptions: { endpoint: f.options.endpoint, deadlineAt: "2026-09-08T00:01:00.000Z" },
    });
    expect(f.options.authorize).not.toHaveBeenCalled();
    expect(f.context.processHost.start).not.toHaveBeenCalled();
  });

  it("returns the retained preparation and exactly one open promise for the same owner", async () => {
    const f = fixture();
    const factory = createModelInvocationFactory(f.options);
    const first = factory(f.envelope, f.context);
    const second = factory(structuredClone(f.envelope), f.context);
    expect(second).toBe(first);
    const opening = first.open();
    expect(second.open()).toBe(opening);
    await opening;
    expect(coordinator).toHaveBeenCalledOnce();
  });

  it("retains a failed open without dispatching a second coordinator", async () => {
    const f = fixture();
    coordinator.mockRejectedValue(new Error("Synthetic opening failure."));
    const prepared = createModelInvocationFactory(f.options)(f.envelope, f.context);
    const opening = prepared.open();
    await expect(opening).rejects.toThrow("Synthetic opening failure.");
    expect(prepared.open()).toBe(opening);
    await expect(prepared.open()).rejects.toThrow();
    expect(coordinator).toHaveBeenCalledOnce();
  });

  it.each(["input", "execution signal"])(
    "rejects changed %s for the same original attempt",
    (change) => {
      const f = fixture();
      const factory = createModelInvocationFactory(f.options);
      factory(f.envelope, f.context);
      const changed = structuredClone(f.envelope);
      if (change === "input") {
        changed.prompt.renderedPrompt = "A different frozen prompt.";
        changed.prompt.promptSha256 = hash(changed.prompt.renderedPrompt);
      }
      expect(() =>
        factory(changed, {
          ...f.context,
          ...(change === "execution signal" ? { signal: new AbortController().signal } : {}),
        }),
      ).toThrow(expect.objectContaining({ code: "ATTEMPT_CONTEXT_CHANGED" }));
      expect(coordinator).not.toHaveBeenCalled();
    },
  );

  it("permits a distinct attempt with its own owner", () => {
    const f = fixture();
    const factory = createModelInvocationFactory(f.options);
    const first = factory(f.envelope, f.context);
    const secondEnvelope = structuredClone(f.envelope);
    secondEnvelope.lease.runAttemptId = "attempt-b";
    const secondOwner = new AbortController();
    const second = factory(secondEnvelope, {
      ...f.context,
      signal: secondOwner.signal,
      attemptSignal: secondOwner.signal,
    });
    expect(second).not.toBe(first);
    expect(second.expectedScope.attemptId).toBe("attempt-b");
  });

  it.each(["workerNodeId", "workerInstanceId", "leaseGeneration"] as const)(
    "does not reacquire the same attempt by changing %s",
    (key) => {
      const f = fixture();
      const factory = createModelInvocationFactory(f.options);
      factory(f.envelope, f.context);
      const changed = structuredClone(f.envelope);
      if (key === "leaseGeneration") changed.lease[key] += 1;
      else changed.lease[key] = "different-owner";
      expect(() => factory(changed, f.context)).toThrow(
        expect.objectContaining({ code: "ATTEMPT_CONTEXT_CHANGED" }),
      );
      expect(coordinator).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "execution"])(
    "propagates %s cancellation into the parent session",
    async (which) => {
      const f = fixture();
      const execution = new AbortController();
      const prepared = createModelInvocationFactory(f.options)(f.envelope, {
        ...f.context,
        signal: execution.signal,
      });
      await prepared.open();
      const signal = coordinator.mock.calls[0]?.[0]?.relayOptions.signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      (which === "owner" ? f.owner : execution).abort();
      expect(signal.aborted).toBe(true);
    },
  );

  it("does not open when the attempt was cancelled after preparation", async () => {
    const f = fixture();
    const prepared = createModelInvocationFactory(f.options)(f.envelope, f.context);
    f.owner.abort(new Error("Protected cancellation detail."));
    await expect(prepared.open()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(coordinator).not.toHaveBeenCalled();
  });

  it("rechecks the deadline when opening is deferred", async () => {
    const f = fixture();
    const prepared = createModelInvocationFactory(f.options)(f.envelope, f.context);
    vi.setSystemTime(new Date("2026-09-08T00:01:00.000Z"));
    await expect(prepared.open()).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(coordinator).not.toHaveBeenCalled();
  });

  it.each(["provider", "client", "relay"])(
    "rejects a registered %s mismatch before coordinator creation",
    (part) => {
      const f = fixture();
      if (part === "provider") f.runtime.providerId = "foreign-provider";
      else if (part === "client") f.runtime.client.executableSha256 = "f".repeat(64);
      else f.runtime.relay.implementationSha256 = "f".repeat(64);
      const factory = createModelInvocationFactory(f.options);
      expect(() => factory(f.envelope, f.context)).toThrow(
        expect.objectContaining({ code: "RUNTIME_MISMATCH" }),
      );
      expect(coordinator).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed frozen input without invoking getters or opening a session", () => {
    const f = fixture();
    const getter = vi.fn(() => f.envelope.prompt);
    const bad = Object.defineProperty({ ...f.envelope }, "prompt", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      createModelInvocationFactory(f.options)(bad as JobExecutionEnvelopeV2, f.context),
    ).toThrow(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(getter).not.toHaveBeenCalled();
    expect(() => createModelInvocationScope(f.envelope, "invalid\n")).toThrow();
    expect(coordinator).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "endpoint hash", "relay policy", "runtime getter", "limits", "timeout"])(
    "rejects invalid %s configuration before preparation",
    (part) => {
      const f = fixture();
      let options: ModelInvocationFactoryOptions = f.options;
      const getter = vi.fn(() => "protected-value");
      if (part === "endpoint")
        options = { ...options, endpoint: "https://user:password@provider.invalid/v1/responses" };
      else if (part === "endpoint hash") f.runtime.endpointSha256 = "f".repeat(64);
      else if (part === "relay policy") f.runtime.relay.policySha256 = "f".repeat(64);
      else if (part === "runtime getter")
        options = {
          ...options,
          runtime: Object.defineProperty({}, "providerId", {
            enumerable: true,
            get: getter,
          }) as ModelInvocationReceiptSetV1["runtime"],
        };
      else if (part === "limits") options = { ...options, relayLimits: { maximumCalls: 0 } };
      else options = { ...options, operationTimeoutMs: 60_001 };
      expect(() => createModelInvocationFactory(options)).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
      expect(getter).not.toHaveBeenCalled();
      expect(coordinator).not.toHaveBeenCalled();
    },
  );
});
