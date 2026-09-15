import type { InvestigationClaimResponse, InvestigationTaskKind } from "@agentic-review/contracts";
import type { Logger } from "../logging/logger.js";
import { delay } from "../util/async.js";
import type { InvestigationWorkerClient } from "./http-client.js";

export type ClaimedInvestigationTask = NonNullable<InvestigationClaimResponse["claim"]>;

export interface InvestigationClaimExecutor {
  execute(claim: ClaimedInvestigationTask, signal: AbortSignal): Promise<void>;
}

export interface InvestigationTaskServiceOptions {
  readonly client: InvestigationWorkerClient;
  readonly executor: InvestigationClaimExecutor;
  readonly supportedKinds: readonly InvestigationTaskKind[];
  readonly logger: Logger;
  readonly maximumConcurrentTasks?: number;
  readonly claimPollMs?: number;
  readonly retryDelayMs?: number;
}

export class InvestigationWorkerShutdown extends Error {
  public constructor() {
    super("The investigation worker is shutting down.");
    this.name = "InvestigationWorkerShutdown";
  }
}

/** Runs native Task attempts without converting them into legacy jobs. */
export class InvestigationTaskService {
  readonly #shutdown = new AbortController();
  readonly #claimAbort = new AbortController();
  readonly #active = new Map<string, Promise<void>>();
  readonly #capacity: number;
  readonly #claimPollMs: number;
  readonly #retryDelayMs: number;
  #draining = false;
  #runPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(private readonly options: InvestigationTaskServiceOptions) {
    this.#capacity = positiveInteger(options.maximumConcurrentTasks ?? 1, "maximumConcurrentTasks");
    this.#claimPollMs = positiveInteger(options.claimPollMs ?? 2_000, "claimPollMs");
    this.#retryDelayMs = positiveInteger(options.retryDelayMs ?? 5_000, "retryDelayMs");
    if (options.supportedKinds.length === 0)
      throw new Error("At least one investigation task kind is required.");
  }

  public run(): Promise<void> {
    this.#runPromise ??= this.#run();
    return this.#runPromise;
  }

  /** Draining finishes current attempts while preventing any additional claim. */
  public requestDrain(): void {
    this.#draining = true;
    this.#claimAbort.abort(new InvestigationWorkerShutdown());
  }

  /** Aborting an attempt preserves its last accepted checkpoint before workspace cleanup. */
  public stop(): Promise<void> {
    this.#shutdownPromise ??= this.#stop();
    return this.#shutdownPromise;
  }

  async #run(): Promise<void> {
    const claimSignal = AbortSignal.any([this.#claimAbort.signal, this.#shutdown.signal]);
    while (!this.#draining && !this.#shutdown.signal.aborted) {
      if (this.#active.size >= this.#capacity) {
        await Promise.race(this.#active.values());
        continue;
      }
      let claim: ClaimedInvestigationTask | null;
      try {
        claim = await this.options.client.claim(
          { supportedKinds: [...this.options.supportedKinds] },
          claimSignal,
        );
      } catch (error) {
        if (claimSignal.aborted) break;
        if (!isRetryable(error)) throw error;
        this.options.logger.warn("Investigation claim temporarily unavailable.");
        await delay(this.#retryDelayMs, claimSignal).catch(() => undefined);
        continue;
      }
      if (claim === null) {
        await delay(this.#claimPollMs, claimSignal).catch(() => undefined);
        continue;
      }
      if (this.#active.has(claim.attempt.id)) {
        throw new Error("The server claimed an investigation attempt that is already active.");
      }
      const attemptId = claim.attempt.id;
      const taskId = claim.task.id;
      const execution = this.options.executor
        .execute(claim, this.#shutdown.signal)
        .catch(() => {
          // An executor owns durable termination. Never log model output, credentials, or server response bodies.
          this.options.logger.error(
            "Investigation attempt could not complete its terminal submission.",
            { taskId, attemptId },
          );
        })
        .finally(() => {
          this.#active.delete(attemptId);
        });
      this.#active.set(attemptId, execution);
    }
    await Promise.allSettled(this.#active.values());
  }

  async #stop(): Promise<void> {
    this.requestDrain();
    this.#shutdown.abort(new InvestigationWorkerShutdown());
    await Promise.allSettled(this.#active.values());
    await this.#runPromise;
  }
}

export function startInvestigationWorker(
  options: InvestigationTaskServiceOptions,
): InvestigationTaskService {
  return new InvestigationTaskService(options);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}
