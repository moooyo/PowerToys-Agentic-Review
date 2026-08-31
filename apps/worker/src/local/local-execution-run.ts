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
} from "@agentic-review/local-protocol";
import { Value } from "@sinclair/typebox/value";
import {
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

/** Narrows one successfully completed Server heartbeat into lease-token-free renewal evidence. */
export function prepareLocalExecutionRenewal(
  start: PreparedLocalExecutionStart,
  observation: SuccessfulServerLeaseRenewalObservation,
): PreparedLocalExecutionRenewal {
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
  if (
    remainingHardDeadlineMilliseconds <= 0 ||
    remainingLeaseMilliseconds > remainingHardDeadlineMilliseconds
  ) {
    throw new LocalExecutionRenewalError(
      "RENEWAL_TIMING_INVALID",
      "Server lease renewal exceeds the remaining monotonic hard deadline.",
    );
  }
  return deepFreezeJson({
    attemptCorrelationId: start.attemptCorrelationId,
    runAttemptId: observation.runAttemptId,
    leaseGeneration: observation.leaseGeneration,
    serverHeartbeatSequence: observation.serverHeartbeatSequence,
    observedAtMonotonicMilliseconds,
    remainingLeaseMilliseconds,
    remainingHardDeadlineMilliseconds,
    action: observation.action,
  }) as PreparedLocalExecutionRenewal;
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
