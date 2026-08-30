import type { ExecutionPhase, JobExecutionEnvelope } from "@agentic-review/contracts";
import type { ProcessHostClient } from "./process-host-protocol.js";

export interface ExecutionProgress {
  readonly phase: ExecutionPhase;
  readonly processCount?: number;
}

export interface JobExecutionContext {
  readonly signal: AbortSignal;
  readonly processHost: ProcessHostClient;
  reportProgress(progress: ExecutionProgress): void;
}

export type JobExecutionResult =
  | {
      readonly outcome: "succeeded";
      readonly resultDigest: string;
      readonly result: unknown;
    }
  | {
      readonly outcome: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface JobExecutor {
  execute(
    envelope: JobExecutionEnvelope,
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
