import type { InvestigationWorkerLease } from "@agentic-review/contracts";
import { delay } from "../util/async.js";
import type { InvestigationWorkerClient } from "./http-client.js";

export class InvestigationLeaseLost extends Error {
  public constructor() {
    super("The investigation attempt lease is no longer valid.");
    this.name = "InvestigationLeaseLost";
  }
}

export class InvestigationTaskCancelled extends Error {
  public constructor() {
    super("The investigation task was cancelled.");
    this.name = "InvestigationTaskCancelled";
  }
}

export interface InvestigationAttemptHeartbeatOptions {
  readonly client: InvestigationWorkerClient;
  readonly taskId: string;
  readonly lease: InvestigationWorkerLease;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

/** Keeps reporting ownership alive even after execution has been cancelled. */
export class InvestigationAttemptHeartbeat {
  readonly #lifecycle = new AbortController();
  readonly #execution = new AbortController();
  readonly #intervalMs: number;
  readonly #now: () => number;
  #expiresAt = 0;
  #expiryTimer: NodeJS.Timeout | undefined;
  #loop: Promise<void> | undefined;
  #leaseLost = false;

  public constructor(private readonly options: InvestigationAttemptHeartbeatOptions) {
    this.#intervalMs = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error("Heartbeat interval must be a positive safe integer.");
    }
    this.#now = options.now ?? Date.now;
  }

  public get executionSignal(): AbortSignal {
    return this.#execution.signal;
  }
  public get leaseLost(): boolean {
    return this.#leaseLost;
  }

  public async start(): Promise<void> {
    if (this.#loop !== undefined) throw new Error("The attempt heartbeat is already running.");
    try {
      await this.#renew();
    } catch {
      this.#loseLease();
      throw new InvestigationLeaseLost();
    }
    this.#loop = this.#run();
  }

  public async stop(): Promise<void> {
    this.#lifecycle.abort();
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    await this.#loop;
  }

  async #run(): Promise<void> {
    while (!this.#lifecycle.signal.aborted && !this.#leaseLost) {
      try {
        await delay(
          Math.min(this.#intervalMs, Math.max(1, Math.floor((this.#expiresAt - this.#now()) / 3))),
          this.#lifecycle.signal,
        );
        await this.#renew();
      } catch (error) {
        if (this.#lifecycle.signal.aborted) return;
        if (!isRetryable(error) || this.#now() >= this.#expiresAt) {
          this.#loseLease();
          return;
        }
      }
    }
  }

  async #renew(): Promise<void> {
    const requestStarted = performance.now();
    const response = await this.options.client.heartbeat(
      this.options.taskId,
      { lease: this.options.lease },
      this.#lifecycle.signal,
    );
    if (this.#lifecycle.signal.aborted || this.#leaseLost) return;
    const serverExpiry = Date.parse(response.leaseExpiresAt);
    const serverTime = Date.parse(response.serverTime);
    const remaining = serverExpiry - serverTime - Math.ceil(performance.now() - requestStarted);
    if (!Number.isFinite(remaining) || remaining <= 0) throw new InvestigationLeaseLost();
    const expiry = this.#now() + remaining;
    this.#expiresAt = expiry;
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(
      () => this.#loseLease(),
      Math.min(2_147_483_647, expiry - this.#now()),
    );
    if (response.cancelRequested) this.#execution.abort(new InvestigationTaskCancelled());
  }

  #loseLease(): void {
    this.#leaseLost = true;
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    this.#execution.abort(new InvestigationLeaseLost());
    this.#lifecycle.abort();
  }
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}
