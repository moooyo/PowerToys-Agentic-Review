import type { RunTerminalResponse } from "@agentic-review/contracts";
import type {
  ArtifactChunkMessage,
  ArtifactEndMessage,
  ArtifactStartMessage,
  CancelAckMessage,
  CancelAttemptMessage,
  CompleteMessage,
  FailedMessage,
  ProgressMessage,
  RenewGrantMessage,
  TerminalAckMessage,
  TerminalDispositionMessage,
} from "@agentic-review/local-protocol";
import type { DeepReadonly, SanitizedExecutorJobEnvelopeV1 } from "./executor-envelope.js";

export type LocalExecutionArtifactEvent =
  | Readonly<ArtifactStartMessage>
  | Readonly<ArtifactChunkMessage>
  | Readonly<ArtifactEndMessage>;

export type LocalExecutionTerminal = Readonly<CompleteMessage> | Readonly<FailedMessage>;
export type LocalExecutionCancelReason = CancelAttemptMessage["reason"];
export type LocalExecutionRenewalAuthority = DeepReadonly<RenewGrantMessage["authorization"]>;
export type LocalExecutionTerminalDecision = DeepReadonly<
  Pick<
    TerminalDispositionMessage,
    "terminalPayloadSha256" | "outcome" | "workspaceDisposition" | "decidedAtUnixMs"
  >
>;

export type LocalExecutionEvent =
  | { readonly type: "progress"; readonly message: Readonly<ProgressMessage> }
  | { readonly type: "artifact"; readonly message: LocalExecutionArtifactEvent }
  | { readonly type: "terminal"; readonly message: LocalExecutionTerminal };

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
  cancel(reason: LocalExecutionCancelReason): Promise<Readonly<CancelAckMessage>>;

  /**
   * Applies the exact next signed grant only after Control receives a matching Server heartbeat.
   * Implementations must verify its signature, run binding, and sequence and never extend locally.
   */
  renew(authority: LocalExecutionRenewalAuthority): Promise<void>;

  /**
   * Binds a Server decision to this run, creates the disposition ID, and validates the returned
   * acknowledgement against the fixed run identity before resolving.
   */
  acknowledgeTerminal(
    decision: LocalExecutionTerminalDecision,
  ): Promise<Readonly<TerminalAckMessage>>;

  /** Releases run-local resources without converting an incomplete attempt into success. */
  close(): Promise<void>;
}

/** Maps a successful Server terminal commit to the only valid local disposition outcome. */
export function mapRunTerminalResponseOutcome(
  response: RunTerminalResponse,
): LocalExecutionTerminalDecision["outcome"] {
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
