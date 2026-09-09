import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { createCanonicalResult } from "@agentic-review/codex";
import type { ModelInvocationReceiptSetV1 } from "@agentic-review/contracts";
import type { WorkerEvaluationModelConfig } from "../config.js";
import type {
  ModelInvocationApi,
  ModelSummaryInputApi,
} from "../server-client/model-invocation-api.js";
import type { CodexRelayProviderProfile } from "./codex-provider-profile.js";
import { createModelInvocationFactory } from "./model-invocation-factory.js";
import type { CreateModelInvocation } from "./model-output-artifact.js";
import { describeModelResponseRelayPolicy } from "./model-response-relay.js";
import {
  type CreateSummaryModelInvocation,
  createSummaryModelInvocationFactory,
} from "./model-summary-invocation-factory.js";
import type { PreparedCodexOutputRunnerOptions } from "./prepared-codex-output-runner.js";
import {
  type VerifiedTrustedBinaryMeasurement,
  verifyTrustedWorkerFile,
} from "./trusted-binary.js";

export interface EvaluationModelExecutorBinding {
  readonly modelInvocationBackend: NonNullable<
    PreparedCodexOutputRunnerOptions["modelInvocationBackend"]
  >;
  readonly createModelInvocation: CreateModelInvocation;
  /** Parent-only output guards; these values are never CLI environment or arguments. */
  readonly codexProviderProtectedValues: readonly string[];
}

export interface PreparedEvaluationModelRuntime {
  readonly review: EvaluationModelExecutorBinding;
  readonly summary?: {
    readonly modelInvocationBackend: EvaluationModelExecutorBinding["modelInvocationBackend"];
    readonly codexProviderProtectedValues: readonly string[];
    readonly createSummaryModelInvocation: CreateSummaryModelInvocation;
  };
  readonly implementationSha256: string;
}

export interface EvaluationModelRuntimeOptions {
  readonly configuration: WorkerEvaluationModelConfig;
  readonly trustedExecutableRoot: string;
  readonly workerEntryPath: string;
  readonly processEntryPath: string | undefined;
  readonly nodeExecutablePath: string;
  readonly nodeVersion: string;
  readonly nodeExecArguments: readonly string[];
  readonly nodeOptions: string | undefined;
  readonly codexVersion: string;
  readonly codexMeasurement: VerifiedTrustedBinaryMeasurement;
  readonly provider: CodexRelayProviderProfile;
  readonly api: ModelInvocationApi | undefined;
  readonly summaryInputApi?: ModelSummaryInputApi;
}

/** Composes parent-owned sessions without opening a listener, invoking a provider, or accepting execution. */
export async function prepareEvaluationModelRuntime(
  options: EvaluationModelRuntimeOptions,
): Promise<PreparedEvaluationModelRuntime> {
  if (
    options.configuration.backend !== "app_server" ||
    options.codexVersion !== "0.145.0" ||
    options.api === undefined ||
    options.provider.state !== "supported"
  )
    throw new Error(
      "The evaluation model backend requires a supported provider, API, and pinned Codex version.",
    );
  const api = options.api;
  const summaryInputApi = options.summaryInputApi;
  if (
    options.configuration.summaryLaunchPolicySha256 !== undefined &&
    typeof summaryInputApi?.freezeValidationSummaryInput !== "function"
  )
    throw new Error("Summary model composition requires the input freezing API.");
  const provider = Object.freeze({
    declared: Object.freeze({ ...options.provider.declared }),
    authorize: options.provider.authorize,
    protectedValues: Object.freeze([...options.provider.getProtectedValues()]),
  });
  options = Object.freeze({
    ...options,
    configuration: Object.freeze({ ...options.configuration }),
    codexMeasurement: Object.freeze({ ...options.codexMeasurement }),
    nodeExecArguments: Object.freeze([...options.nodeExecArguments]),
  });
  if (
    options.processEntryPath === undefined ||
    !win32.isAbsolute(options.workerEntryPath) ||
    !win32.isAbsolute(options.processEntryPath) ||
    win32.normalize(options.workerEntryPath).toLowerCase() !==
      win32.normalize(options.processEntryPath).toLowerCase() ||
    win32.basename(options.workerEntryPath) !== "worker.mjs" ||
    !/^24\.[0-9]+\.[0-9]+$/u.test(options.nodeVersion) ||
    Number(options.nodeVersion.split(".")[1]) < 20 ||
    options.nodeExecArguments.length > 1 ||
    options.nodeExecArguments.some((argument) => argument !== "--enable-source-maps") ||
    (options.nodeOptions !== undefined && options.nodeOptions.trim() !== "")
  )
    throw new Error(
      "Evaluation model startup requires the pinned worker.mjs entry and Node 24 without runtime injection options.",
    );

  const files = await Promise.allSettled([
    verifyTrustedWorkerFile({
      trustedExecutableRoot: options.trustedExecutableRoot,
      role: "workerBundle",
      file: {
        path: options.workerEntryPath,
        expectedSha256: options.configuration.workerBundleSha256,
      },
    }),
    verifyTrustedWorkerFile({
      trustedExecutableRoot: options.trustedExecutableRoot,
      role: "node",
      file: {
        path: options.nodeExecutablePath,
        expectedSha256: options.configuration.nodeExecutableSha256,
      },
    }),
  ]);
  for (const result of files) if (result.status === "rejected") throw result.reason;
  const [bundleResult, nodeResult] = files;
  if (bundleResult.status !== "fulfilled" || nodeResult.status !== "fulfilled")
    throw new Error("The Worker implementation could not be verified.");
  const bundle = bundleResult.value;
  const node = nodeResult.value;
  // Hash the implementation that this process actually runs, including its interpreter.
  // Deployment owns the read-only trust root; this descriptor is not OS confinement attestation.
  const implementationSha256 = createCanonicalResult({
    schemaVersion: "WorkerModelRelayImplementationV1",
    workerBundleSha256: bundle.measurement.sha256,
    nodeExecutableSha256: node.measurement.sha256,
    nodeVersion: options.nodeVersion,
    nodeExecArguments: options.nodeExecArguments,
  }).sha256;
  const policy = describeModelResponseRelayPolicy();
  const backend = Object.freeze({
    kind: "app_server" as const,
    codexExecutableSha256: options.codexMeasurement.sha256,
    commandNetworkDomains: Object.freeze([] as string[]),
    modelReasoningEffort: provider.declared.modelReasoningEffort,
    modelContextWindow: provider.declared.modelContextWindow,
    modelAutoCompactTokenLimit: provider.declared.modelAutoCompactTokenLimit,
  });
  const invocationOptions = (launchPolicySha256: string) => {
    const runtime: ModelInvocationReceiptSetV1["runtime"] = {
      client: {
        kind: "codex_cli",
        version: options.codexVersion,
        executableSha256: options.codexMeasurement.sha256,
        launchPolicySha256,
      },
      relay: { implementationSha256, policySha256: policy.sha256 },
      providerId: provider.declared.providerId,
      endpointSha256: createHash("sha256").update(provider.declared.endpoint, "utf8").digest("hex"),
    };
    return {
      api,
      runtime,
      endpoint: provider.declared.endpoint,
      authorize: provider.authorize,
    };
  };
  const summary =
    options.configuration.summaryLaunchPolicySha256 === undefined || summaryInputApi === undefined
      ? undefined
      : Object.freeze({
          modelInvocationBackend: backend,
          codexProviderProtectedValues: provider.protectedValues,
          createSummaryModelInvocation: createSummaryModelInvocationFactory(
            invocationOptions(options.configuration.summaryLaunchPolicySha256),
            summaryInputApi,
          ),
        });
  return Object.freeze({
    review: Object.freeze({
      modelInvocationBackend: backend,
      codexProviderProtectedValues: provider.protectedValues,
      createModelInvocation: createModelInvocationFactory(
        invocationOptions(options.configuration.reviewLaunchPolicySha256),
      ),
    }),
    ...(summary === undefined ? {} : { summary }),
    implementationSha256,
  });
}
