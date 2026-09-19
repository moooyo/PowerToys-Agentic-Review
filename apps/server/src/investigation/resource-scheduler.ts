import {
  type InvestigationTaskKind,
  type InvestigationTaskV1,
  investigationTaskRequiresE2e,
  isInvestigationStaticTaskKind,
} from "@agentic-review/contracts";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";

export type InvestigationResourcePool = "static" | "e2e";
export type InvestigationResourceState = "held" | "needs_cleanup" | "released";

export interface InvestigationResourceLease {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly fence: number;
  readonly pool: InvestigationResourcePool;
  readonly state: InvestigationResourceState;
  readonly acquiredAt: string;
  readonly updatedAt: string;
  readonly releasedAt: string | null;
  readonly reason: string | null;
}

export interface InvestigationSchedulerSettings {
  readonly staticConcurrency: number;
  readonly e2eConcurrency: 1;
}

/** Every task that can execute repository code shares the exclusive desktop pool. */
export function investigationResourcePool(
  task: InvestigationTaskKind | Pick<InvestigationTaskV1, "kind" | "executionPolicy">,
): InvestigationResourcePool {
  return (
    typeof task === "string"
      ? !isInvestigationStaticTaskKind(task)
      : investigationTaskRequiresE2e(task)
  )
    ? "e2e"
    : "static";
}

/** Mutations run inside the same store transaction as their task/attempt transition. */
export class InvestigationResourceScheduler {
  constructor(
    private readonly store: InvestigationStore,
    private readonly now: () => Date,
    private readonly defaultStaticConcurrency = 1,
  ) {
    validateStaticConcurrency(defaultStaticConcurrency);
  }

  settings(): InvestigationSchedulerSettings {
    return (
      this.store.get<InvestigationSchedulerSettings>("schedulerSettings", "global") ?? {
        staticConcurrency: this.defaultStaticConcurrency,
        e2eConcurrency: 1,
      }
    );
  }

  /** The first configured server establishes one durable capacity for all server instances. */
  initialize(): void {
    if (!this.store.has("schedulerSettings", "global")) {
      this.configure(this.defaultStaticConcurrency);
    }
    const settings = this.settings();
    validateStaticConcurrency(settings.staticConcurrency);
    requireCondition(
      settings.e2eConcurrency === 1,
      500,
      "invalid_e2e_concurrency",
      "Desktop execution concurrency must remain exactly one.",
    );
  }

  configure(staticConcurrency: number): InvestigationSchedulerSettings {
    validateStaticConcurrency(staticConcurrency);
    const settings = { staticConcurrency, e2eConcurrency: 1 as const };
    this.store.put("schedulerSettings", "global", settings);
    return settings;
  }

  leases(): InvestigationResourceLease[] {
    return this.store.list<InvestigationResourceLease>("resourceLeases");
  }

  lease(attemptId: string): InvestigationResourceLease | undefined {
    return this.store.get<InvestigationResourceLease>("resourceLeases", attemptId);
  }

  available(pool: InvestigationResourcePool): boolean {
    const occupied = this.leases().filter(
      (entry) => entry.pool === pool && entry.state !== "released",
    ).length;
    return occupied < (pool === "e2e" ? 1 : this.settings().staticConcurrency);
  }

  acquire(
    input: Omit<
      InvestigationResourceLease,
      "state" | "acquiredAt" | "updatedAt" | "releasedAt" | "reason"
    >,
  ): void {
    requireCondition(
      this.available(input.pool),
      409,
      "resource_pool_busy",
      "The task resource pool has no available capacity.",
    );
    this.adopt(input);
  }

  /** Upgrades retain already-running attempts, even when they exceed a newly lowered limit. */
  adopt(
    input: Omit<
      InvestigationResourceLease,
      "state" | "acquiredAt" | "updatedAt" | "releasedAt" | "reason"
    >,
  ): void {
    const existing = this.lease(input.attemptId);
    if (existing !== undefined) {
      requireCondition(
        existing.taskId === input.taskId &&
          existing.workerId === input.workerId &&
          existing.fence === input.fence,
        409,
        "resource_lease_mismatch",
        "A retained resource lease must match its original task, worker, and fence.",
      );
      // An older kind-only classification must not release an executable task as static work.
      if (existing.pool === "static" && input.pool === "e2e" && existing.state !== "released")
        this.store.put("resourceLeases", input.attemptId, {
          ...existing,
          pool: "e2e",
          state: "needs_cleanup",
          updatedAt: this.now().toISOString(),
          reason: "execution_policy_requires_e2e",
        } satisfies InvestigationResourceLease);
      return;
    }
    const at = this.now().toISOString();
    this.store.insert("resourceLeases", input.attemptId, {
      ...input,
      state: "held",
      acquiredAt: at,
      updatedAt: at,
      releasedAt: null,
      reason: null,
    } satisfies InvestigationResourceLease);
  }

  /** Cancellation never proves that an application, child process, or UI operation stopped. */
  requestCleanup(attemptId: string, reason: string): void {
    const lease = this.lease(attemptId);
    if (lease === undefined || lease.state === "released" || lease.pool === "static") return;
    this.store.put("resourceLeases", attemptId, {
      ...lease,
      state: "needs_cleanup",
      updatedAt: this.now().toISOString(),
      reason,
    } satisfies InvestigationResourceLease);
  }

  terminate(attemptId: string, reason: string): void {
    const lease = this.lease(attemptId);
    if (lease === undefined || lease.state === "released") return;
    if (lease.pool === "e2e") {
      this.requestCleanup(attemptId, reason);
      return;
    }
    this.release(lease, reason);
  }

  confirmCleanup(input: {
    attemptId: string;
    taskId: string;
    workerId: string;
    fence: number;
  }): InvestigationResourceLease {
    const lease = this.lease(input.attemptId);
    requireCondition(
      lease !== undefined &&
        lease.taskId === input.taskId &&
        lease.workerId === input.workerId &&
        lease.fence === input.fence,
      409,
      "resource_lease_mismatch",
      "Cleanup must confirm the exact resource owner and attempt fence.",
    );
    if (lease.state === "released") return lease;
    return this.release(lease, "cleanup_confirmed");
  }

  private release(lease: InvestigationResourceLease, reason: string): InvestigationResourceLease {
    const at = this.now().toISOString();
    const released: InvestigationResourceLease = {
      ...lease,
      state: "released",
      updatedAt: at,
      releasedAt: at,
      reason,
    };
    this.store.put("resourceLeases", lease.attemptId, released);
    return released;
  }
}

function validateStaticConcurrency(value: number): void {
  requireCondition(
    Number.isSafeInteger(value) && value >= 1 && value <= 16,
    400,
    "invalid_static_concurrency",
    "Static concurrency must be an integer between 1 and 16.",
  );
}
