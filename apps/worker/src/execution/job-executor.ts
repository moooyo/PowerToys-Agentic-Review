import type {
  ExecutionPhase,
  JobExecutionEnvelope,
  JobExecutionEnvelopeV2,
  RunFailureDiagnostics,
} from "@agentic-review/contracts";
import type { ModelOutputArtifact } from "./model-output-artifact.js";
import type { ProcessHostClient } from "./process-host-protocol.js";

export interface ExecutionProgress {
  readonly phase: ExecutionPhase;
  readonly processCount?: number;
}

export interface JobExecutionContext {
  readonly signal: AbortSignal;
  /** Stable attempt ownership; signal may belong to a shorter execution budget. */
  readonly attemptSignal?: AbortSignal;
  readonly processHost: ProcessHostClient;
  reportProgress(progress: ExecutionProgress): void;
  reportNodeHealthFault(error: Error): void;
  // The callback must be retained synchronously and invoked after terminal reporting finishes.
  deferCleanup?(cleanup: () => Promise<void>): void;
}

export type JobExecutionResult =
  | {
      readonly outcome: "succeeded";
      readonly resultDigest: string;
      readonly result: unknown;
      readonly modelOutputArtifact?: ModelOutputArtifact;
    }
  | {
      readonly outcome: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly diagnostics?: RunFailureDiagnostics;
    };

export interface JobExecutor {
  execute(
    envelope: JobExecutionEnvelope,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult>;
}

/** Model delegation retains the complete frozen profile and execution purpose. */
export interface ProfileModelExecutor {
  readonly modelInvocationRequired?: boolean;
  executeProfileModel(
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult>;
}

export class PlaceholderJobExecutor implements JobExecutor {
  public async execute(
    _envelope: JobExecutionEnvelope,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult> {
    context.reportProgress({ phase: "preparing", processCount: 0 });
    await Promise.resolve();
    return {
      outcome: "failed",
      code: "EXECUTOR_NOT_IMPLEMENTED",
      message: "The Codex job executor has not been installed in this worker build.",
      retryable: false,
    };
  }
}

export {
  buildReviewCodexConfigurationOverrides,
  type ReviewFileHandle,
  type ReviewFileIO,
  ReviewJobExecutor,
  type ReviewJobExecutorOptions,
} from "./review-executor.js";
