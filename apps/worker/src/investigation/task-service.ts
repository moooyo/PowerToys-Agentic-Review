import type { InvestigationClaimResponse, InvestigationTaskKind } from "@agentic-review/contracts";
import type { Logger } from "../logging/logger.js";
import { delay } from "../util/async.js";
import type { InvestigationWorkerClient } from "./http-client.js";

export type ClaimedInvestigationTask = NonNullable<InvestigationClaimResponse["claim"]>;
export type InvestigationTaskPool = "static" | "e2e";
export type InvestigationWorkerRole = InvestigationTaskPool | "all";

export interface InvestigationClaimExecutor {
  execute(claim: ClaimedInvestigationTask, signal: AbortSignal): Promise<void>;
}

export interface InvestigationTaskServiceOptions {
  readonly client: InvestigationWorkerClient;
  readonly executor: InvestigationClaimExecutor;
  readonly supportedKinds: readonly InvestigationTaskKind[];
  readonly logger: Logger;
  /** Legacy alias for the static pool capacity. */
  readonly maximumConcurrentTasks?: number;
  readonly maximumConcurrentStaticTasks?: number;
  readonly role?: InvestigationWorkerRole;
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
  readonly #activeByPool: Record<InvestigationTaskPool, number> = { static: 0, e2e: 0 };
  readonly #capacity: Readonly<Record<InvestigationTaskPool, number>>;
  readonly #supportedKinds: readonly InvestigationTaskKind[];
  readonly #claimPollMs: number;
  readonly #retryDelayMs: number;
  #draining = false;
  #runPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #executionFailure: Error | undefined;

  public constructor(private readonly options: InvestigationTaskServiceOptions) {
    this.#capacity = {
      static: positiveInteger(
        options.maximumConcurrentStaticTasks ?? options.maximumConcurrentTasks ?? 1,
        "maximumConcurrentStaticTasks",
      ),
      e2e: 1,
    };
    this.#claimPollMs = positiveInteger(options.claimPollMs ?? 2_000, "claimPollMs");
    this.#retryDelayMs = positiveInteger(options.retryDelayMs ?? 5_000, "retryDelayMs");
    const role = options.role ?? "all";
    if (role !== "all" && role !== "static" && role !== "e2e")
      throw new Error("The investigation Worker role must be static, e2e, or all.");
    this.#supportedKinds = options.supportedKinds.filter(
      (kind) => role === "all" || investigationTaskPool(kind) === role,
    );
    if (this.#supportedKinds.length === 0)
      throw new Error("At least one investigation task kind must match the Worker role.");
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
    try {
      await this.#claimTasks();
    } finally {
      // A claim failure must not let runtime shutdown abort unrelated accepted attempts.
      this.requestDrain();
      await Promise.allSettled(this.#active.values());
    }
    if (this.#executionFailure !== undefined) throw this.#executionFailure;
  }

  async #claimTasks(): Promise<void> {
    const claimSignal = AbortSignal.any([this.#claimAbort.signal, this.#shutdown.signal]);
    while (!this.#draining && !this.#shutdown.signal.aborted) {
      const supportedKinds = this.#supportedKinds.filter((kind) => {
        const pool = investigationTaskPool(kind);
        return this.#activeByPool[pool] < this.#capacity[pool];
      });
      if (supportedKinds.length === 0) {
        await Promise.race(this.#active.values());
        continue;
      }
      let claim: ClaimedInvestigationTask | null;
      try {
        claim = await this.options.client.claim({ supportedKinds }, claimSignal);
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
      if (!supportedKinds.includes(claim.task.kind))
        throw new Error("The server claimed an investigation task outside the available pools.");
      const attemptId = claim.attempt.id;
      const taskId = claim.task.id;
      const pool = investigationTaskPool(claim.task.kind);
      const execution = Promise.resolve()
        .then(() => this.options.executor.execute(claim, this.#shutdown.signal))
        .catch(() => {
          // An executor owns durable termination. Never log model output, credentials, or server response bodies.
          this.#executionFailure ??= new Error(
            "Investigation attempt could not complete its terminal submission.",
          );
          this.requestDrain();
          this.options.logger.error(
            "Investigation attempt could not complete its terminal submission.",
            { taskId, attemptId },
          );
        })
        .finally(() => {
          this.#active.delete(attemptId);
          this.#activeByPool[pool] -= 1;
        });
      this.#activeByPool[pool] += 1;
      this.#active.set(attemptId, execution);
    }
  }

  async #stop(): Promise<void> {
    this.requestDrain();
    this.#shutdown.abort(new InvestigationWorkerShutdown());
    await Promise.allSettled(this.#active.values());
    await this.#runPromise;
  }
}

/** Execution tasks share one E2E slot, including legacy saved-plan tasks. */
export function investigationTaskPool(kind: InvestigationTaskKind): InvestigationTaskPool {
  return kind === "pr-review" || kind === "issue-investigate" ? "static" : "e2e";
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
