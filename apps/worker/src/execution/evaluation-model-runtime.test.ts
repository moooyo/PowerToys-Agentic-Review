import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EvaluationModelRuntimeOptions,
  prepareEvaluationModelRuntime,
} from "./evaluation-model-runtime.js";
import type { JobExecutionContext } from "./job-executor.js";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";
import { describeModelResponseRelayPolicy } from "./model-response-relay.js";

// Startup composition uses synthetic measurements; the file verifier has its own stable-handle tests.
const verify = vi.hoisted(() => vi.fn());
vi.mock("./trusted-binary.js", () => ({ verifyTrustedWorkerFile: verify }));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const measurement = (sha256: string) => ({
  sha256,
  sizeBytes: 100,
  fileIdentity: { dev: "1", ino: "2", mtimeMs: "1000", ctimeMs: "1000" },
  verifiedAtISO: "2026-09-08T00:00:00.000Z",
});
function fixture(): EvaluationModelRuntimeOptions {
  return {
    configuration: {
      backend: "app_server",
      workerBundleSha256: "a".repeat(64),
      nodeExecutableSha256: "b".repeat(64),
      reviewLaunchPolicySha256: "c".repeat(64),
    },
    trustedExecutableRoot: "C:\\Trusted",
    workerEntryPath: "C:\\Trusted\\Worker\\worker.mjs",
    processEntryPath: "C:\\Trusted\\Worker\\worker.mjs",
    nodeExecutablePath: "C:\\Trusted\\Node\\node.exe",
    nodeVersion: "24.20.0",
    nodeExecArguments: [],
    nodeOptions: undefined,
    codexVersion: "0.145.0",
    codexMeasurement: measurement("d".repeat(64)),
    provider: {
      state: "supported",
      effectivePolicy: "unverified",
      declared: {
        providerId: "synthetic-provider",
        baseUrl: "https://provider.invalid/v1",
        endpoint: "https://provider.invalid/v1/responses",
        model: "fixture-model",
        modelReasoningEffort: "high",
        modelContextWindow: 100000,
        modelAutoCompactTokenLimit: 80000,
        provider: {
          name: null,
          wireApi: "responses",
          supportsWebsockets: false,
          requiresOpenaiAuth: false,
          requestMaxRetries: null,
          streamMaxRetries: null,
          streamIdleTimeoutMs: null,
        },
      },
      authorize: vi.fn(async () => ({
        headers: { Authorization: "Bearer synthetic-only" },
        protectedValues: ["synthetic-only"],
      })),
      getProtectedValues: () => Object.freeze(["synthetic-only"]),
    },
    api: {
      beginModelInvocation: vi.fn(),
      sealModelInvocation: vi.fn(),
      submitModelInvocationReceipts: vi.fn(),
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:10.000Z"));
  verify.mockReset().mockImplementation(async (input) => ({
    path: input.file.path,
    measurement: measurement(input.file.expectedSha256),
  }));
});
afterEach(() => vi.useRealTimers());

describe("parent evaluation model runtime", () => {
  it("requires the freezing API only for an explicitly configured summary policy", async () => {
    const f = fixture();
    const configuration = { ...f.configuration, summaryLaunchPolicySha256: "e".repeat(64) };
    await expect(prepareEvaluationModelRuntime({ ...f, configuration })).rejects.toThrow(
      "input freezing API",
    );
    expect(verify).not.toHaveBeenCalled();
    const freezeValidationSummaryInput = vi.fn(async () => {
      throw new Error("Unexpected synthetic freeze.");
    });
    const prepared = await prepareEvaluationModelRuntime({
      ...f,
      configuration,
      summaryInputApi: { freezeValidationSummaryInput },
    });
    expect(prepared.summary?.createSummaryModelInvocation).toBeTypeOf("function");
    expect(prepared.summary?.codexProviderProtectedValues).toEqual(["synthetic-only"]);
    expect(prepared.summary?.modelInvocationBackend).toEqual(
      prepared.review.modelInvocationBackend,
    );
    expect(freezeValidationSummaryInput).not.toHaveBeenCalled();
  });
  it("binds the measured executing implementation, parent provider and policy without opening anything", async () => {
    const f = fixture();
    const prepared = await prepareEvaluationModelRuntime(f);
    expect(verify.mock.calls.map(([input]) => input)).toEqual([
      {
        trustedExecutableRoot: f.trustedExecutableRoot,
        role: "workerBundle",
        file: { path: f.workerEntryPath, expectedSha256: f.configuration.workerBundleSha256 },
      },
      {
        trustedExecutableRoot: f.trustedExecutableRoot,
        role: "node",
        file: { path: f.nodeExecutablePath, expectedSha256: f.configuration.nodeExecutableSha256 },
      },
    ]);
    expect(prepared.review.modelInvocationBackend).toEqual({
      kind: "app_server",
      codexExecutableSha256: "d".repeat(64),
      commandNetworkDomains: [],
      modelReasoningEffort: "high",
      modelContextWindow: 100000,
      modelAutoCompactTokenLimit: 80000,
    });
    expect(prepared.review.codexProviderProtectedValues).toEqual(["synthetic-only"]);
    expect(JSON.stringify(prepared.review.modelInvocationBackend)).not.toContain("synthetic-only");
    expect(Object.isFrozen(prepared.review)).toBe(true);
    const { envelope } = modelArtifactEvaluationFixture();
    const registration = envelope.validation.modelRuntimeRegistration;
    if (!registration) throw new Error("Missing synthetic runtime registration.");
    registration.identity = {
      ...registration.identity,
      providerId: "synthetic-provider",
      endpointSha256: digest("https://provider.invalid/v1/responses"),
      client: {
        kind: "codex_cli",
        version: "0.145.0",
        executableSha256: "d".repeat(64),
        launchPolicySha256: "c".repeat(64),
      },
      relay: {
        implementationSha256: prepared.implementationSha256,
        policySha256: describeModelResponseRelayPolicy().sha256,
      },
    };
    const updateReferences = () => {
      registration.identitySha256 = createCanonicalResult(registration.identity).sha256;
      envelope.validation.modelRequirements.expectedModelIdentityDigest =
        registration.identitySha256;
      const reference = envelope.validation.modelRequirements.runtimeRegistration;
      if (!reference) throw new Error("Missing synthetic reference.");
      reference.registrationSha256 = createCanonicalResult(registration).sha256;
    };
    updateReferences();
    const signal = new AbortController().signal;
    const context = { signal, attemptSignal: signal } as JobExecutionContext;
    expect(prepared.review.createModelInvocation(envelope, context).expectedScope.jobId).toBe(
      envelope.job.jobId,
    );
    registration.identity.client.executableSha256 = "e".repeat(64);
    updateReferences();
    expect(() =>
      prepared.review.createModelInvocation(envelope, {
        signal: new AbortController().signal,
      } as JobExecutionContext),
    ).toThrow(expect.objectContaining({ code: "RUNTIME_MISMATCH" }));
    expect(f.api?.beginModelInvocation).not.toHaveBeenCalled();
    if (f.provider.state === "supported") expect(f.provider.authorize).not.toHaveBeenCalled();
  });
  it("supports the existing source-map start command and binds it into implementation identity", async () => {
    const plain = await prepareEvaluationModelRuntime(fixture());
    const maps = await prepareEvaluationModelRuntime({
      ...fixture(),
      nodeExecArguments: ["--enable-source-maps"],
    });
    expect(maps.implementationSha256).not.toBe(plain.implementationSha256);
    const differentNode = await prepareEvaluationModelRuntime({
      ...fixture(),
      nodeVersion: "24.21.0",
    });
    expect(differentNode.implementationSha256).not.toBe(plain.implementationSha256);
  });
  it.each([
    { processEntryPath: "C:\\Trusted\\unused-worker.mjs" },
    { workerEntryPath: "C:\\Trusted\\main.ts", processEntryPath: "C:\\Trusted\\main.ts" },
    { nodeExecArguments: ["--import", "C:\\loader.mjs"] },
    { nodeExecArguments: ["--enable-source-maps", "--enable-source-maps"] },
    { nodeOptions: "--require C:\\loader.cjs" },
    { nodeVersion: "22.0.0" },
    { nodeVersion: "24.19.9" },
    { codexVersion: "0.146.0" },
    { api: undefined },
  ])("refuses unsupported startup input before reading files: %j", async (change) => {
    await expect(prepareEvaluationModelRuntime({ ...fixture(), ...change })).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects unsupported provider configuration without falling back", async () => {
    await expect(
      prepareEvaluationModelRuntime({
        ...fixture(),
        provider: {
          state: "unsupported",
          reason: "AUTHENTICATION_UNSUPPORTED",
          effectivePolicy: "unverified",
        },
      }),
    ).rejects.toThrow("supported provider");
    expect(verify).not.toHaveBeenCalled();
  });
  it("awaits both file verifiers before rejecting one failure", async () => {
    let finish!: (value: unknown) => void;
    verify.mockRejectedValueOnce(new Error("Synthetic digest mismatch."));
    verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let closed = false;
    const result = prepareEvaluationModelRuntime(fixture()).finally(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish({ path: "C:\\Trusted\\Node\\node.exe", measurement: measurement("b".repeat(64)) });
    await expect(result).rejects.toThrow("Synthetic digest mismatch");
    expect(closed).toBe(true);
  });
  it("snapshots parent inputs before asynchronous file verification", async () => {
    const f = fixture();
    const pending = prepareEvaluationModelRuntime(f);
    Object.assign(f.configuration, { reviewLaunchPolicySha256: "changed" });
    Object.assign(f.codexMeasurement, { sha256: "changed" });
    if (f.provider.state === "supported")
      Object.assign(f.provider.declared, { modelReasoningEffort: "low" });
    const prepared = await pending;
    expect(prepared.review.modelInvocationBackend.codexExecutableSha256).toBe("d".repeat(64));
    expect(prepared.review.modelInvocationBackend.modelReasoningEffort).toBe("high");
  });
});
