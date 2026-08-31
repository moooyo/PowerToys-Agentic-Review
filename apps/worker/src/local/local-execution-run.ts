import { type RunTerminalResponse, RunTerminalResponseSchema } from "@agentic-review/contracts";
import type {
  ArtifactChunkMessage,
  ArtifactEndMessage,
  ArtifactStartMessage,
  CancelAckMessage,
  CancelAttemptMessage,
  ProgressMessage,
  TerminalAckMessage,
  TerminalDispositionMessage,
  VerifiedAttemptCompletion,
  VerifiedAttemptFailure,
} from "@agentic-review/local-protocol";
import {
  createCanonicalJsonDocument,
  type DeepReadonly,
  deepFreezeJson,
  isVerifiedAttemptTerminal,
  LOCAL_GRANT_MAXIMUM_DURATION_MS,
} from "@agentic-review/local-protocol";
import { Value } from "@sinclair/typebox/value";
import {
  isPreparedLocalExecutionStart,
  normalizeLocalMonotonicObservationMilliseconds,
  normalizeLocalRemainingBudgetMilliseconds,
  type PreparedLocalExecutionStart,
  type SanitizedExecutorJobEnvelopeV1,
} from "./executor-envelope.js";

export type LocalExecutionArtifactEvent =
  | DeepReadonly<ArtifactStartMessage>
  | DeepReadonly<ArtifactChunkMessage>
  | DeepReadonly<ArtifactEndMessage>;

export type LocalExecutionTerminal = DeepReadonly<
  VerifiedAttemptCompletion | VerifiedAttemptFailure
>;
export type LocalExecutionCancelReason = CancelAttemptMessage["reason"];

declare const preparedLocalExecutionRenewalBrand: unique symbol;
declare const localExecutionAuthorityUseBrand: unique symbol;
declare const localExecutionStartTicketBrand: unique symbol;
declare const localExecutionRenewalTicketBrand: unique symbol;

export interface SuccessfulServerLeaseRenewalObservation {
  readonly runAttemptId: string;
  readonly leaseGeneration: number;
  readonly serverHeartbeatSequence: number;
  readonly observedAtMonotonicMilliseconds: number;
  readonly remainingLeaseMilliseconds: number;
  readonly action: "continue" | "drain";
}

export type PreparedLocalExecutionRenewal = DeepReadonly<
  SuccessfulServerLeaseRenewalObservation & {
    readonly attemptCorrelationId: string;
    readonly remainingHardDeadlineMilliseconds: number;
    readonly [preparedLocalExecutionRenewalBrand]: true;
  }
>;

export type LocalExecutionAuthorityFenceReason =
  | "cancelled"
  | "close"
  | "expired"
  | "lease_lost"
  | "shutdown"
  | "stale_revision"
  | "terminal";

export type LocalExecutionAuthorityUse = DeepReadonly<
  {
    readonly kind: "start" | "renewal";
    readonly generation: number;
    readonly attemptCorrelationId: string;
    readonly runAttemptId: string;
    readonly leaseGeneration: number;
    readonly signedPayloadSha256: string;
    readonly deadlineMonotonicMilliseconds: number;
    readonly validForMilliseconds: number;
    readonly serverHeartbeatSequence: number | null;
  } & { readonly [localExecutionAuthorityUseBrand]: true }
>;

export type LocalExecutionStartTicket = DeepReadonly<
  {
    readonly generation: number;
    readonly attemptCorrelationId: string;
    readonly runAttemptId: string;
    readonly leaseGeneration: number;
    readonly deadlineMonotonicMilliseconds: number;
    readonly validForMilliseconds: number;
  } & { readonly [localExecutionStartTicketBrand]: true }
>;

export type LocalExecutionRenewalTicket = DeepReadonly<
  {
    readonly generation: number;
    readonly attemptCorrelationId: string;
    readonly runAttemptId: string;
    readonly leaseGeneration: number;
    readonly serverHeartbeatSequence: number;
    readonly action: "continue" | "drain";
    readonly deadlineMonotonicMilliseconds: number;
    readonly validForMilliseconds: number;
  } & { readonly [localExecutionRenewalTicketBrand]: true }
>;

export interface LocalExecutionMonotonicAuthority {
  consumeStart(nowMonotonicMilliseconds: number): LocalExecutionStartTicket;
  commitStart(
    ticket: LocalExecutionStartTicket,
    signedPayloadSha256: string,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionAuthorityUse;
  beginRenewal(
    renewal: PreparedLocalExecutionRenewal,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionRenewalTicket;
  commitRenewal(
    ticket: LocalExecutionRenewalTicket,
    signedPayloadSha256: string,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionAuthorityUse;
  consumeUse(
    use: LocalExecutionAuthorityUse,
    signedPayloadSha256: string,
    nowMonotonicMilliseconds: number,
  ): void;
  fence(reason: LocalExecutionAuthorityFenceReason): void;
}

export interface LocalExecutionRenewalRegistrar {
  /** This capability must be held only by the adapter that observes successful Server heartbeats. */
  prepare(observation: SuccessfulServerLeaseRenewalObservation): PreparedLocalExecutionRenewal;
}

export interface LocalExecutionMonotonicAuthorityBinding {
  readonly authority: LocalExecutionMonotonicAuthority;
  readonly renewalRegistrar: LocalExecutionRenewalRegistrar;
}

export class LocalExecutionAuthorityError extends Error {
  public constructor(
    public readonly code:
      | "AUTHORITY_EXPIRED"
      | "AUTHORITY_FENCED"
      | "AUTHORITY_HEARTBEAT_REPLAYED"
      | "AUTHORITY_IDENTITY_MISMATCH"
      | "AUTHORITY_NOT_STARTED"
      | "AUTHORITY_RENEWAL_INVALID"
      | "AUTHORITY_START_ALREADY_CONSUMED"
      | "AUTHORITY_START_INVALID"
      | "AUTHORITY_TICKET_INVALID"
      | "AUTHORITY_TIME_INVALID"
      | "AUTHORITY_USE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalExecutionAuthorityError";
  }
}

interface RenewalTicketState {
  readonly owner: StatefulLocalExecutionMonotonicAuthority;
  readonly generation: number;
  readonly deadlineMonotonicMilliseconds: number;
  readonly serverHeartbeatSequence: number;
}

interface StartTicketState {
  readonly owner: StatefulLocalExecutionMonotonicAuthority;
  readonly generation: number;
  readonly deadlineMonotonicMilliseconds: number;
}

interface AuthorityUseState {
  readonly owner: StatefulLocalExecutionMonotonicAuthority;
  readonly generation: number;
  readonly deadlineMonotonicMilliseconds: number;
  readonly signedPayloadSha256: string;
  consumed: boolean;
}

const localExecutionAuthorityUses = new WeakMap<object, AuthorityUseState>();
const localExecutionStartTickets = new WeakMap<object, StartTicketState>();
const localExecutionRenewalTickets = new WeakMap<object, RenewalTicketState>();
const preparedLocalExecutionRenewalSources = new WeakMap<
  object,
  StatefulLocalExecutionMonotonicAuthority
>();
const claimedPreparedLocalExecutionStarts = new WeakSet<object>();

export function createLocalExecutionMonotonicAuthority(
  start: PreparedLocalExecutionStart,
): LocalExecutionMonotonicAuthorityBinding {
  if (!isPreparedLocalExecutionStart(start)) {
    throw authorityError(
      "AUTHORITY_START_INVALID",
      "Monotonic authority requires a runtime-verified prepared local start.",
    );
  }
  if (claimedPreparedLocalExecutionStarts.has(start)) {
    throw authorityError(
      "AUTHORITY_START_ALREADY_CONSUMED",
      "Prepared local start is already bound to a monotonic authority.",
    );
  }
  const authority = new StatefulLocalExecutionMonotonicAuthority(start);
  claimedPreparedLocalExecutionStarts.add(start);
  const renewalRegistrar = Object.freeze({
    prepare(observation: SuccessfulServerLeaseRenewalObservation): PreparedLocalExecutionRenewal {
      return prepareLocalExecutionRenewal(authority, start, observation);
    },
  });
  return Object.freeze({ authority, renewalRegistrar });
}

declare const localExecutionTerminalDecisionBrand: unique symbol;

export type LocalExecutionTerminalDecision = DeepReadonly<{
  readonly runIdentity: LocalExecutionRunIdentity;
  readonly serverResponse: RunTerminalResponse;
  readonly terminalPayloadSha256: string;
  readonly outcome: TerminalDispositionMessage["outcome"];
  readonly workspaceDisposition: TerminalDispositionMessage["workspaceDisposition"];
  readonly decidedAtUnixMs: number;
  readonly [localExecutionTerminalDecisionBrand]: true;
}>;

export interface LocalExecutionRunIdentity {
  readonly jobId: string;
  readonly runAttemptId: string;
}

export type LocalExecutionEvent =
  | { readonly type: "progress"; readonly message: DeepReadonly<ProgressMessage> }
  | { readonly type: "artifact"; readonly message: LocalExecutionArtifactEvent }
  | { readonly type: "terminal"; readonly message: LocalExecutionTerminal };

export class LocalExecutionRenewalError extends Error {
  public constructor(
    public readonly code:
      | "RENEWAL_IDENTITY_MISMATCH"
      | "RENEWAL_ACTION_INVALID"
      | "RENEWAL_SEQUENCE_INVALID"
      | "RENEWAL_TIMING_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalExecutionRenewalError";
  }
}

/** Narrows one registrar-observed successful Server heartbeat into lease-token-free evidence. */
function prepareLocalExecutionRenewal(
  owner: StatefulLocalExecutionMonotonicAuthority,
  start: PreparedLocalExecutionStart,
  observation: SuccessfulServerLeaseRenewalObservation,
): PreparedLocalExecutionRenewal {
  if (!isPreparedLocalExecutionStart(start)) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_IDENTITY_MISMATCH",
      "Server lease renewal requires a runtime-verified prepared local start.",
    );
  }
  if (
    observation.runAttemptId !== start.executorEnvelope.runAttemptId ||
    observation.leaseGeneration !== start.authorityBasis.leaseGeneration
  ) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_IDENTITY_MISMATCH",
      "Server lease renewal does not belong to the prepared local attempt.",
    );
  }
  if (observation.action !== "continue" && observation.action !== "drain") {
    throw new LocalExecutionRenewalError(
      "RENEWAL_ACTION_INVALID",
      "Only a continuing or draining Server lease may renew local execution.",
    );
  }
  if (
    !Number.isSafeInteger(observation.serverHeartbeatSequence) ||
    observation.serverHeartbeatSequence < 0
  ) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_SEQUENCE_INVALID",
      "Server heartbeat sequence must be a non-negative safe integer.",
    );
  }
  if (
    !Number.isSafeInteger(start.authorityBasis.observedAtMonotonicMilliseconds) ||
    start.authorityBasis.observedAtMonotonicMilliseconds < 0 ||
    !Number.isSafeInteger(start.authorityBasis.remainingHardDeadlineMilliseconds) ||
    start.authorityBasis.remainingHardDeadlineMilliseconds <= 0
  ) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_TIMING_INVALID",
      "Prepared local execution timing basis is invalid.",
    );
  }
  let observedAtMonotonicMilliseconds: number;
  let remainingLeaseMilliseconds: number;
  try {
    observedAtMonotonicMilliseconds = normalizeLocalMonotonicObservationMilliseconds(
      observation.observedAtMonotonicMilliseconds,
    );
    remainingLeaseMilliseconds = normalizeLocalRemainingBudgetMilliseconds(
      observation.remainingLeaseMilliseconds,
    );
  } catch (error) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_TIMING_INVALID",
      `Server lease renewal timing evidence is invalid: ${error instanceof Error ? error.message : "unknown timing error"}`,
    );
  }
  if (observedAtMonotonicMilliseconds < start.authorityBasis.observedAtMonotonicMilliseconds) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_TIMING_INVALID",
      "Server lease renewal observation predates the prepared local attempt.",
    );
  }
  const elapsedMilliseconds =
    observedAtMonotonicMilliseconds - start.authorityBasis.observedAtMonotonicMilliseconds;
  const remainingHardDeadlineMilliseconds =
    start.authorityBasis.remainingHardDeadlineMilliseconds - elapsedMilliseconds;
  if (remainingHardDeadlineMilliseconds <= 0) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_TIMING_INVALID",
      "Server lease renewal was observed after the monotonic hard deadline.",
    );
  }
  const prepared = deepFreezeJson({
    attemptCorrelationId: start.attemptCorrelationId,
    runAttemptId: observation.runAttemptId,
    leaseGeneration: observation.leaseGeneration,
    serverHeartbeatSequence: observation.serverHeartbeatSequence,
    observedAtMonotonicMilliseconds,
    remainingLeaseMilliseconds,
    remainingHardDeadlineMilliseconds,
    action: observation.action,
  }) as PreparedLocalExecutionRenewal;
  preparedLocalExecutionRenewalSources.set(prepared, owner);
  return prepared;
}

class StatefulLocalExecutionMonotonicAuthority implements LocalExecutionMonotonicAuthority {
  readonly #attemptCorrelationId: string;
  readonly #runAttemptId: string;
  readonly #leaseGeneration: number;
  readonly #startLeaseDeadlineMonotonicMilliseconds: number;
  readonly #hardDeadlineMonotonicMilliseconds: number;
  #lastUseMonotonicMilliseconds: number;
  #currentGrantDeadlineMonotonicMilliseconds: number | undefined;
  #highestHeartbeatSequence = -1;
  #latestRenewalObservationMonotonicMilliseconds: number;
  #generation = 0;
  #startConsumed = false;
  #fenceReason: LocalExecutionAuthorityFenceReason | undefined;
  #pendingStartTicket: LocalExecutionStartTicket | undefined;
  #pendingTicket: LocalExecutionRenewalTicket | undefined;

  public constructor(start: PreparedLocalExecutionStart) {
    const observedAt = start.authorityBasis.observedAtMonotonicMilliseconds;
    this.#attemptCorrelationId = start.attemptCorrelationId;
    this.#runAttemptId = start.executorEnvelope.runAttemptId;
    this.#leaseGeneration = start.authorityBasis.leaseGeneration;
    this.#lastUseMonotonicMilliseconds = observedAt;
    this.#latestRenewalObservationMonotonicMilliseconds = observedAt;
    this.#startLeaseDeadlineMonotonicMilliseconds = checkedMonotonicDeadline(
      observedAt,
      start.authorityBasis.remainingLeaseMilliseconds,
    );
    this.#hardDeadlineMonotonicMilliseconds = checkedMonotonicDeadline(
      observedAt,
      start.authorityBasis.remainingHardDeadlineMilliseconds,
    );
  }

  public consumeStart(nowMonotonicMilliseconds: number): LocalExecutionStartTicket {
    this.#assertActive();
    if (this.#startConsumed) {
      throw authorityError(
        "AUTHORITY_START_ALREADY_CONSUMED",
        "Prepared local start authority was already consumed.",
      );
    }
    const now = this.#consumeNow(nowMonotonicMilliseconds);
    this.#startConsumed = true;
    this.#generation += 1;
    const effectiveDeadline = Math.min(
      this.#startLeaseDeadlineMonotonicMilliseconds,
      this.#hardDeadlineMonotonicMilliseconds,
    );
    if (effectiveDeadline <= now) {
      this.#expire();
      throw authorityError("AUTHORITY_EXPIRED", "Prepared local start authority has expired.");
    }
    const validForMilliseconds = Math.min(effectiveDeadline - now, LOCAL_GRANT_MAXIMUM_DURATION_MS);
    const deadlineMonotonicMilliseconds = now + validForMilliseconds;
    const ticket = Object.freeze({
      generation: this.#generation,
      attemptCorrelationId: this.#attemptCorrelationId,
      runAttemptId: this.#runAttemptId,
      leaseGeneration: this.#leaseGeneration,
      deadlineMonotonicMilliseconds,
      validForMilliseconds,
    }) as LocalExecutionStartTicket;
    this.#pendingStartTicket = ticket;
    localExecutionStartTickets.set(ticket, {
      owner: this,
      generation: this.#generation,
      deadlineMonotonicMilliseconds,
    });
    return ticket;
  }

  public commitStart(
    ticket: LocalExecutionStartTicket,
    signedPayloadSha256Value: string,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionAuthorityUse {
    this.#assertActive();
    const signedPayloadSha256 = normalizeSignedPayloadSha256(signedPayloadSha256Value);
    const ticketState =
      typeof ticket === "object" && ticket !== null
        ? localExecutionStartTickets.get(ticket)
        : undefined;
    if (
      ticketState === undefined ||
      ticketState.owner !== this ||
      ticketState.generation !== this.#generation ||
      this.#pendingStartTicket !== ticket
    ) {
      throw authorityError(
        "AUTHORITY_TICKET_INVALID",
        "Start commit requires the current ticket issued by this monotonic authority.",
      );
    }
    const now = this.#consumeNow(nowMonotonicMilliseconds);
    if (now >= ticketState.deadlineMonotonicMilliseconds) {
      this.#expire();
      throw authorityError("AUTHORITY_EXPIRED", "Local start authority expired while signing.");
    }
    this.#pendingStartTicket = undefined;
    const use = createAuthorityUse(
      this,
      "start",
      ticketState.generation,
      null,
      this.#attemptCorrelationId,
      this.#runAttemptId,
      this.#leaseGeneration,
      signedPayloadSha256,
      ticketState.deadlineMonotonicMilliseconds,
      now,
    );
    this.#currentGrantDeadlineMonotonicMilliseconds = use.deadlineMonotonicMilliseconds;
    return use;
  }

  public beginRenewal(
    renewal: PreparedLocalExecutionRenewal,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionRenewalTicket {
    this.#assertActive();
    if (!this.#startConsumed || this.#currentGrantDeadlineMonotonicMilliseconds === undefined) {
      throw authorityError(
        "AUTHORITY_NOT_STARTED",
        "Local execution renewal cannot begin before start authority is consumed.",
      );
    }
    const now = this.#consumeNow(nowMonotonicMilliseconds);
    if (now >= this.#currentGrantDeadlineMonotonicMilliseconds) {
      this.#expire();
      throw authorityError("AUTHORITY_EXPIRED", "Current local execution grant has expired.");
    }
    const observation = normalizeRenewalForAuthority(renewal);
    if (preparedLocalExecutionRenewalSources.get(renewal) !== this) {
      throw authorityError(
        "AUTHORITY_RENEWAL_INVALID",
        "Local execution renewal was not prepared for this monotonic authority.",
      );
    }
    if (
      observation.attemptCorrelationId !== this.#attemptCorrelationId ||
      observation.runAttemptId !== this.#runAttemptId ||
      observation.leaseGeneration !== this.#leaseGeneration
    ) {
      throw authorityError(
        "AUTHORITY_IDENTITY_MISMATCH",
        "Local execution renewal belongs to another attempt or lease generation.",
      );
    }
    if (
      observation.observedAtMonotonicMilliseconds <
        this.#latestRenewalObservationMonotonicMilliseconds ||
      observation.observedAtMonotonicMilliseconds > now
    ) {
      throw authorityError(
        "AUTHORITY_TIME_INVALID",
        "Local execution renewal observation is out of monotonic order.",
      );
    }
    if (observation.serverHeartbeatSequence <= this.#highestHeartbeatSequence) {
      throw authorityError(
        "AUTHORITY_HEARTBEAT_REPLAYED",
        "Server heartbeat sequence was already used or observed out of order.",
      );
    }
    const leaseDeadline = checkedMonotonicDeadline(
      observation.observedAtMonotonicMilliseconds,
      observation.remainingLeaseMilliseconds,
    );
    const effectiveDeadline = Math.min(leaseDeadline, this.#hardDeadlineMonotonicMilliseconds);
    if (effectiveDeadline <= now) {
      throw authorityError("AUTHORITY_EXPIRED", "Local execution renewal authority has expired.");
    }

    this.#highestHeartbeatSequence = observation.serverHeartbeatSequence;
    this.#latestRenewalObservationMonotonicMilliseconds =
      observation.observedAtMonotonicMilliseconds;
    this.#generation += 1;
    const validForMilliseconds = Math.min(effectiveDeadline - now, LOCAL_GRANT_MAXIMUM_DURATION_MS);
    const deadlineMonotonicMilliseconds = now + validForMilliseconds;
    const ticket = Object.freeze({
      generation: this.#generation,
      attemptCorrelationId: this.#attemptCorrelationId,
      runAttemptId: this.#runAttemptId,
      leaseGeneration: this.#leaseGeneration,
      serverHeartbeatSequence: observation.serverHeartbeatSequence,
      action: observation.action,
      deadlineMonotonicMilliseconds,
      validForMilliseconds,
    }) as LocalExecutionRenewalTicket;
    this.#pendingTicket = ticket;
    localExecutionRenewalTickets.set(ticket, {
      owner: this,
      generation: this.#generation,
      deadlineMonotonicMilliseconds,
      serverHeartbeatSequence: observation.serverHeartbeatSequence,
    });
    return ticket;
  }

  public commitRenewal(
    ticket: LocalExecutionRenewalTicket,
    signedPayloadSha256Value: string,
    nowMonotonicMilliseconds: number,
  ): LocalExecutionAuthorityUse {
    this.#assertActive();
    const signedPayloadSha256 = normalizeSignedPayloadSha256(signedPayloadSha256Value);
    const ticketState =
      typeof ticket === "object" && ticket !== null
        ? localExecutionRenewalTickets.get(ticket)
        : undefined;
    if (ticketState === undefined || ticketState.owner !== this) {
      throw authorityError(
        "AUTHORITY_TICKET_INVALID",
        "Renewal commit requires a ticket issued by this monotonic authority.",
      );
    }
    if (
      ticketState.generation !== this.#generation ||
      this.#pendingTicket !== ticket ||
      ticketState.serverHeartbeatSequence !== ticket.serverHeartbeatSequence
    ) {
      throw authorityError(
        "AUTHORITY_TICKET_INVALID",
        "Renewal ticket was superseded or invalidated by an authority state change.",
      );
    }
    const now = this.#consumeNow(nowMonotonicMilliseconds);
    if (
      this.#currentGrantDeadlineMonotonicMilliseconds === undefined ||
      now >= this.#currentGrantDeadlineMonotonicMilliseconds ||
      now >= ticketState.deadlineMonotonicMilliseconds
    ) {
      this.#expire();
      throw authorityError("AUTHORITY_EXPIRED", "Local execution authority expired while signing.");
    }
    this.#pendingTicket = undefined;
    const use = createAuthorityUse(
      this,
      "renewal",
      ticketState.generation,
      ticketState.serverHeartbeatSequence,
      this.#attemptCorrelationId,
      this.#runAttemptId,
      this.#leaseGeneration,
      signedPayloadSha256,
      ticketState.deadlineMonotonicMilliseconds,
      now,
    );
    this.#currentGrantDeadlineMonotonicMilliseconds = use.deadlineMonotonicMilliseconds;
    return use;
  }

  public consumeUse(
    use: LocalExecutionAuthorityUse,
    signedPayloadSha256Value: string,
    nowMonotonicMilliseconds: number,
  ): void {
    this.#assertActive();
    const signedPayloadSha256 = normalizeSignedPayloadSha256(signedPayloadSha256Value);
    const state =
      typeof use === "object" && use !== null ? localExecutionAuthorityUses.get(use) : undefined;
    if (
      state === undefined ||
      state.owner !== this ||
      state.consumed ||
      state.signedPayloadSha256 !== signedPayloadSha256 ||
      use.attemptCorrelationId !== this.#attemptCorrelationId ||
      use.runAttemptId !== this.#runAttemptId ||
      use.leaseGeneration !== this.#leaseGeneration
    ) {
      throw authorityError(
        "AUTHORITY_USE_INVALID",
        "Committed local authority use is forged, stale, mismatched, or already consumed.",
      );
    }
    const now = this.#consumeNow(nowMonotonicMilliseconds);
    if (
      state.generation !== this.#generation ||
      state.deadlineMonotonicMilliseconds !== this.#currentGrantDeadlineMonotonicMilliseconds
    ) {
      throw authorityError(
        "AUTHORITY_USE_INVALID",
        "Committed local authority use was invalidated by a newer authority generation.",
      );
    }
    if (now >= state.deadlineMonotonicMilliseconds) {
      this.#expire();
      throw authorityError("AUTHORITY_EXPIRED", "Committed local authority use has expired.");
    }
    state.consumed = true;
  }

  public fence(reason: LocalExecutionAuthorityFenceReason): void {
    if (!isAuthorityFenceReason(reason)) {
      throw new TypeError("Local execution authority fence reason is invalid.");
    }
    if (this.#fenceReason !== undefined) return;
    this.#fenceReason = reason;
    this.#generation += 1;
    this.#pendingStartTicket = undefined;
    this.#pendingTicket = undefined;
  }

  #assertActive(): void {
    if (this.#fenceReason !== undefined) {
      throw authorityError(
        "AUTHORITY_FENCED",
        `Local execution authority is fenced (${this.#fenceReason}).`,
      );
    }
  }

  #consumeNow(value: number): number {
    const now = normalizeAuthorityUseTimeMilliseconds(value);
    if (now < this.#lastUseMonotonicMilliseconds) {
      throw authorityError(
        "AUTHORITY_TIME_INVALID",
        "Monotonic authority use time moved backwards.",
      );
    }
    this.#lastUseMonotonicMilliseconds = now;
    return now;
  }

  #expire(): void {
    this.fence("expired");
  }
}

/**
 * Represents one started local attempt. Events retain protocol order, including artifact framing
 * before the terminal event. Implementations expose only the sanitized Executor envelope.
 */
export interface LocalExecutionRun {
  readonly attemptCorrelationId: string;
  readonly executorEnvelope: SanitizedExecutorJobEnvelopeV1;
  readonly events: AsyncIterable<Readonly<LocalExecutionEvent>>;
  readonly terminal: Promise<LocalExecutionTerminal>;

  /** Requests idempotent cancellation and resolves only after the active process count is zero. */
  cancel(reason: LocalExecutionCancelReason): Promise<DeepReadonly<CancelAckMessage>>;

  /**
   * Signs and applies the exact next grant from one matching successful Server heartbeat.
   * Implementations must serialize grant creation, reject reused heartbeat sequences, and reject
   * every renewal after stale, cancel, terminal, or close has synchronously fenced the run.
   */
  renew(observation: PreparedLocalExecutionRenewal): Promise<void>;

  /**
   * Validates the Server response identity, derives its outcome, hashes the run's retained terminal
   * payload, injects all local identity plus a new disposition ID, and validates the returned ACK.
   */
  acknowledgeTerminal(
    decision: LocalExecutionTerminalDecision,
  ): Promise<DeepReadonly<TerminalAckMessage>>;

  /** Releases run-local resources without converting an incomplete attempt into success. */
  close(): Promise<void>;
}

/** Maps a successful Server terminal commit to the only valid local disposition outcome. */
export function mapRunTerminalResponseOutcome(
  response: RunTerminalResponse,
): TerminalDispositionMessage["outcome"] {
  if (response.jobState === "succeeded" && response.runState === "succeeded") {
    return "committed";
  }
  if (response.jobState === "retry_waiting" && response.runState === "failed") {
    return "retry_scheduled";
  }
  if (response.jobState === "cancelled" && response.runState === "cancelled") {
    return "cancelled";
  }
  if (
    (response.jobState === "failed" || response.jobState === "dead_letter") &&
    response.runState === "failed"
  ) {
    return "committed";
  }
  throw new TypeError("Server terminal job and run states are inconsistent.");
}

export function prepareLocalTerminalDecision(
  runIdentity: LocalExecutionRunIdentity,
  terminal: LocalExecutionTerminal,
  serverResponseValue: unknown,
  workspaceDisposition: TerminalDispositionMessage["workspaceDisposition"],
  decidedAtUnixMs: number,
): LocalExecutionTerminalDecision {
  if (!isVerifiedAttemptTerminal(terminal)) {
    throw new TypeError("Terminal evidence was not produced by ArtifactStreamVerifier.");
  }
  const serverResponse = normalizeRunTerminalResponse(serverResponseValue);
  if (
    serverResponse.jobId !== runIdentity.jobId ||
    serverResponse.runAttemptId !== runIdentity.runAttemptId ||
    terminal.terminal.runAttemptId !== runIdentity.runAttemptId
  ) {
    throw new TypeError("Terminal evidence or Server response belongs to another execution run.");
  }
  const terminalPayloadSha256 = createCanonicalJsonDocument(terminal.terminal).sha256;
  if (terminalPayloadSha256 !== terminal.terminalPayloadSha256) {
    throw new TypeError("Verified terminal payload digest is inconsistent.");
  }
  if (
    "resultArtifact" in terminal &&
    (terminal.terminal.resultArtifactId !== terminal.resultArtifact.artifactId ||
      terminal.terminal.resultBytes !== terminal.resultArtifact.totalBytes.toString() ||
      terminal.terminal.resultSha256 !== terminal.resultArtifact.sha256)
  ) {
    throw new TypeError("Verified terminal result artifact binding is inconsistent.");
  }
  if (workspaceDisposition !== "delete" && workspaceDisposition !== "retain_for_janitor") {
    throw new TypeError("Local terminal workspace disposition is invalid.");
  }
  if (!Number.isSafeInteger(decidedAtUnixMs) || decidedAtUnixMs < 0) {
    throw new TypeError("Local terminal decision timestamp is invalid.");
  }
  return deepFreezeJson({
    runIdentity: { jobId: runIdentity.jobId, runAttemptId: runIdentity.runAttemptId },
    serverResponse,
    terminalPayloadSha256,
    outcome: mapRunTerminalResponseOutcome(serverResponse),
    workspaceDisposition,
    decidedAtUnixMs,
  }) as LocalExecutionTerminalDecision;
}

function normalizeRunTerminalResponse(value: unknown): DeepReadonly<RunTerminalResponse> {
  let normalized: unknown;
  try {
    normalized = JSON.parse(createCanonicalJsonDocument(value).json) as unknown;
  } catch (error) {
    throw new TypeError("Server terminal response is not canonical JSON data.", { cause: error });
  }
  if (!Value.Check(RunTerminalResponseSchema, normalized)) {
    throw new TypeError("Server terminal response does not match its strict schema.");
  }
  return deepFreezeJson(normalized as RunTerminalResponse);
}

function normalizeRenewalForAuthority(
  value: PreparedLocalExecutionRenewal,
): Omit<PreparedLocalExecutionRenewal, typeof preparedLocalExecutionRenewalBrand> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.attemptCorrelationId !== "string" ||
    typeof value.runAttemptId !== "string" ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    value.leaseGeneration < 1 ||
    !Number.isSafeInteger(value.serverHeartbeatSequence) ||
    value.serverHeartbeatSequence < 0 ||
    (value.action !== "continue" && value.action !== "drain")
  ) {
    throw authorityError(
      "AUTHORITY_IDENTITY_MISMATCH",
      "Local execution renewal evidence is malformed.",
    );
  }
  let observedAtMonotonicMilliseconds: number;
  let remainingLeaseMilliseconds: number;
  let remainingHardDeadlineMilliseconds: number;
  try {
    observedAtMonotonicMilliseconds = normalizeLocalMonotonicObservationMilliseconds(
      value.observedAtMonotonicMilliseconds,
    );
    remainingLeaseMilliseconds = normalizeLocalRemainingBudgetMilliseconds(
      value.remainingLeaseMilliseconds,
    );
    remainingHardDeadlineMilliseconds = normalizeLocalRemainingBudgetMilliseconds(
      value.remainingHardDeadlineMilliseconds,
    );
  } catch (error) {
    throw authorityError(
      "AUTHORITY_TIME_INVALID",
      `Local execution renewal timing is invalid: ${error instanceof Error ? error.message : "unknown timing error"}`,
    );
  }
  return {
    attemptCorrelationId: value.attemptCorrelationId,
    runAttemptId: value.runAttemptId,
    leaseGeneration: value.leaseGeneration,
    serverHeartbeatSequence: value.serverHeartbeatSequence,
    observedAtMonotonicMilliseconds,
    remainingLeaseMilliseconds,
    remainingHardDeadlineMilliseconds,
    action: value.action,
  };
}

function normalizeAuthorityUseTimeMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw authorityError(
      "AUTHORITY_TIME_INVALID",
      "Authority use time is outside the supported range.",
    );
  }
  const normalized = Math.ceil(value);
  if (!Number.isSafeInteger(normalized)) {
    throw authorityError(
      "AUTHORITY_TIME_INVALID",
      "Authority use time is outside the supported range.",
    );
  }
  return normalized;
}

function checkedMonotonicDeadline(observedAt: number, remainingMilliseconds: number): number {
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    !Number.isSafeInteger(remainingMilliseconds) ||
    remainingMilliseconds <= 0 ||
    observedAt > Number.MAX_SAFE_INTEGER - remainingMilliseconds
  ) {
    throw authorityError(
      "AUTHORITY_TIME_INVALID",
      "Monotonic deadline is outside the supported range.",
    );
  }
  return observedAt + remainingMilliseconds;
}

function createAuthorityUse(
  owner: StatefulLocalExecutionMonotonicAuthority,
  kind: "start" | "renewal",
  generation: number,
  serverHeartbeatSequence: number | null,
  attemptCorrelationId: string,
  runAttemptId: string,
  leaseGeneration: number,
  signedPayloadSha256: string,
  effectiveDeadline: number,
  now: number,
): LocalExecutionAuthorityUse {
  const validForMilliseconds = Math.min(effectiveDeadline - now, LOCAL_GRANT_MAXIMUM_DURATION_MS);
  if (!Number.isSafeInteger(validForMilliseconds) || validForMilliseconds <= 0) {
    throw authorityError("AUTHORITY_EXPIRED", "Local execution authority has expired.");
  }
  const use = Object.freeze({
    kind,
    generation,
    attemptCorrelationId,
    runAttemptId,
    leaseGeneration,
    signedPayloadSha256,
    deadlineMonotonicMilliseconds: now + validForMilliseconds,
    validForMilliseconds,
    serverHeartbeatSequence,
  }) as LocalExecutionAuthorityUse;
  localExecutionAuthorityUses.set(use, {
    owner,
    generation,
    deadlineMonotonicMilliseconds: use.deadlineMonotonicMilliseconds,
    signedPayloadSha256,
    consumed: false,
  });
  return use;
}

function normalizeSignedPayloadSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw authorityError(
      "AUTHORITY_USE_INVALID",
      "Signed local authority payload digest must be lowercase SHA-256.",
    );
  }
  return value;
}

function isAuthorityFenceReason(value: unknown): value is LocalExecutionAuthorityFenceReason {
  return (
    value === "cancelled" ||
    value === "close" ||
    value === "expired" ||
    value === "lease_lost" ||
    value === "shutdown" ||
    value === "stale_revision" ||
    value === "terminal"
  );
}

function authorityError(
  code: LocalExecutionAuthorityError["code"],
  message: string,
): LocalExecutionAuthorityError {
  return new LocalExecutionAuthorityError(code, message);
}
