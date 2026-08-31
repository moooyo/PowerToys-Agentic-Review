import type { DeepReadonly } from "./canonical.js";
import {
  digestExecutionCapability,
  digestRenewalGrant,
  isVerifiedExecutionCapability,
  isVerifiedRenewalGrant,
  type VerifiedExecutionCapability,
  type VerifiedRenewalGrant,
} from "./capability.js";

interface AuthorityState {
  readonly capability: VerifiedExecutionCapability;
  readonly initialCapabilitySha256: string;
  active: boolean;
  grantSequence: number;
  authorizationSha256: string;
  serverHeartbeatSequence: number;
  fenceReason?: LocalAuthorityFenceReason;
}

export type LocalAuthorityFenceReason =
  | "stale_revision"
  | "lease_lost"
  | "cancelled"
  | "terminal"
  | "shutdown";

export interface ExpectedRenewalChain {
  readonly capability: VerifiedExecutionCapability;
  readonly expectedPreviousGrantSha256: string;
  readonly expectedPreviousGrantSequence: number;
  readonly expectedGrantSequence: number;
  readonly expectedPreviousServerHeartbeatSequence: number;
}

export class LocalAuthorityReplayError extends Error {
  public constructor(
    public readonly code:
      | "REPLAY_CAPACITY_EXCEEDED"
      | "CAPABILITY_REPLAYED"
      | "CAPABILITY_UNVERIFIED"
      | "ATTEMPT_REPLAYED"
      | "CAPABILITY_UNKNOWN"
      | "CAPABILITY_TERMINAL"
      | "RENEWAL_REPLAYED"
      | "RENEWAL_UNVERIFIED"
      | "RENEWAL_CHAIN_INVALID"
      | "RENEWAL_CONTEXT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LocalAuthorityReplayError";
  }
}

// Keep one instance for the complete Executor boot. Entries are never evicted: reaching the bound
// disables additional work instead of making an old capability replayable.
export class LocalAuthorityReplayGuard {
  readonly #maximumCapabilities: number;
  readonly #states = new Map<string, AuthorityState>();
  readonly #runAttemptTombstones = new Set<string>();
  readonly #correlationTombstones = new Set<string>();

  public constructor(maximumCapabilities = 65_536) {
    if (
      !Number.isSafeInteger(maximumCapabilities) ||
      maximumCapabilities < 1 ||
      maximumCapabilities > 1_000_000
    ) {
      throw new RangeError("maximumCapabilities is outside the supported range");
    }
    this.#maximumCapabilities = maximumCapabilities;
  }

  public reserveVerifiedCapability(
    capability: VerifiedExecutionCapability,
  ): VerifiedExecutionCapability {
    if (!isVerifiedExecutionCapability(capability)) {
      throw replayError(
        "CAPABILITY_UNVERIFIED",
        "Execution capability was not authenticated by this protocol runtime.",
      );
    }
    if (this.#states.has(capability.capabilityId)) {
      throw replayError("CAPABILITY_REPLAYED", "Execution capability was already observed.");
    }
    const runAttemptKey = replayKey(capability.executorBootId, capability.runAttemptId);
    const correlationKey = replayKey(capability.executorBootId, capability.attemptCorrelationId);
    if (
      this.#runAttemptTombstones.has(runAttemptKey) ||
      this.#correlationTombstones.has(correlationKey)
    ) {
      throw replayError(
        "ATTEMPT_REPLAYED",
        "Executor attempt identity was already observed during this boot.",
      );
    }
    if (this.#states.size >= this.#maximumCapabilities) {
      throw replayError(
        "REPLAY_CAPACITY_EXCEEDED",
        "Executor boot replay capacity has been exhausted.",
      );
    }
    const digest = digestExecutionCapability(capability);
    this.#runAttemptTombstones.add(runAttemptKey);
    this.#correlationTombstones.add(correlationKey);
    this.#states.set(capability.capabilityId, {
      capability,
      initialCapabilitySha256: digest,
      active: true,
      grantSequence: capability.grantSequence,
      authorizationSha256: digest,
      serverHeartbeatSequence: -1,
    });
    return capability;
  }

  public expectedRenewal(capabilityId: string): DeepReadonly<ExpectedRenewalChain> {
    const state = this.#requireActive(capabilityId);
    if (state.grantSequence >= Number.MAX_SAFE_INTEGER) {
      throw replayError("RENEWAL_CHAIN_INVALID", "Local grant sequence is exhausted.");
    }
    return Object.freeze({
      capability: state.capability,
      expectedPreviousGrantSha256: state.authorizationSha256,
      expectedPreviousGrantSequence: state.grantSequence,
      expectedGrantSequence: state.grantSequence + 1,
      expectedPreviousServerHeartbeatSequence: state.serverHeartbeatSequence,
    });
  }

  // This synchronous commit is the replay reservation point and must precede extending the
  // monotonic execution deadline.
  public acceptVerifiedRenewal(grant: VerifiedRenewalGrant): VerifiedRenewalGrant {
    if (!isVerifiedRenewalGrant(grant)) {
      throw replayError(
        "RENEWAL_UNVERIFIED",
        "Renewal grant was not authenticated by this protocol runtime.",
      );
    }
    const state = this.#requireActive(grant.capabilityId);
    const capability = state.capability;
    if (
      grant.initialCapabilitySha256 !== state.initialCapabilitySha256 ||
      grant.previousGrantSha256 !== state.authorizationSha256 ||
      grant.previousGrantSequence !== state.grantSequence ||
      grant.grantSequence !== state.grantSequence + 1
    ) {
      throw replayError("RENEWAL_CHAIN_INVALID", "Renewal does not extend the exact grant chain.");
    }
    if (grant.serverHeartbeatSequence <= state.serverHeartbeatSequence) {
      throw replayError(
        "RENEWAL_REPLAYED",
        "Server heartbeat sequence was already used for this capability.",
      );
    }
    for (const key of [
      "workerNodeId",
      "workerInstanceId",
      "executorBootId",
      "sessionId",
      "attemptCorrelationId",
      "runAttemptId",
      "jobId",
      "leaseGeneration",
      "hardDeadlineUnixMs",
    ] as const) {
      if (grant[key] !== capability[key]) {
        throw replayError(
          "RENEWAL_CONTEXT_MISMATCH",
          "Renewal does not match the reserved execution capability.",
        );
      }
    }
    state.grantSequence = grant.grantSequence;
    state.authorizationSha256 = digestRenewalGrant(grant);
    state.serverHeartbeatSequence = grant.serverHeartbeatSequence;
    return grant;
  }

  public markTerminal(capabilityId: string): void {
    this.fence(capabilityId, "terminal");
  }

  /** Synchronously prevents every later renewal before asynchronous cancellation begins. */
  public fence(capabilityId: string, reason: LocalAuthorityFenceReason): void {
    const state = this.#states.get(capabilityId);
    if (state === undefined) {
      throw replayError("CAPABILITY_UNKNOWN", "Execution capability was not reserved.");
    }
    state.active = false;
    state.fenceReason = reason;
  }

  public isActive(capabilityId: string): boolean {
    return this.#states.get(capabilityId)?.active === true;
  }

  #requireActive(capabilityId: string): AuthorityState {
    const state = this.#states.get(capabilityId);
    if (state === undefined) {
      throw replayError("CAPABILITY_UNKNOWN", "Execution capability was not reserved.");
    }
    if (!state.active) {
      throw replayError(
        "CAPABILITY_TERMINAL",
        `Fenced capability cannot be renewed or resumed (${state.fenceReason ?? "unknown"}).`,
      );
    }
    return state;
  }
}

function replayKey(executorBootId: string, value: string): string {
  return `${executorBootId}\u0000${value}`;
}

function replayError(
  code: LocalAuthorityReplayError["code"],
  message: string,
): LocalAuthorityReplayError {
  return new LocalAuthorityReplayError(code, message);
}
