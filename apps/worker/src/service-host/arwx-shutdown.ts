import type { DeepReadonly } from "@agentic-review/local-protocol";
import {
  type ArwxFinalFrameReceipt,
  commitArwxFinalFrameReceipt,
  failArwxFinalFrameReceipt,
} from "./arwx-stdio-channel.js";
import type { ServiceHostPayloadRole } from "./launch-contract.js";
import {
  type CompletedRuntimeBootstrap,
  consumeCompletedRuntimeBootstrapForArwxShutdown,
  readCompletedRuntimeBootstrapArwxShutdownDeadline,
} from "./runtime-bootstrap-handshake.js";

export const ARM_ARWX_SHUTDOWN_OPERATION = "ArmArwxShutdown" as const;

export interface ArmArwxShutdownV1 extends Readonly<Record<string, unknown>> {
  readonly bootstrapId: string;
  readonly shutdownId: string;
  readonly remainingShutdownMs: number;
  readonly finalMessageType: 14 | 15;
  readonly finalSequence: string;
  readonly finalCorrelationId: string;
  readonly finalFrameBytes: number;
  readonly finalFrameSha256: string;
}

export interface ArmArwxShutdownResultV1 extends ArmArwxShutdownV1 {
  readonly armed: true;
}

declare const preparedArmArwxShutdownBrand: unique symbol;

export interface PreparedArmArwxShutdownV1 {
  readonly [preparedArmArwxShutdownBrand]: true;
}

interface PreparedArmArwxShutdownState {
  readonly request: DeepReadonly<ArmArwxShutdownV1>;
  readonly absoluteDeadline: number;
  readonly receipt: ArwxFinalFrameReceipt;
  settled: boolean;
}

const preparedArmStates = new WeakMap<object, PreparedArmArwxShutdownState>();

export class ArmArwxShutdownError extends Error {
  public constructor(
    public readonly code: "ARM_RESULT_INVALID" | "ARM_STATE_INVALID" | "ARM_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "ArmArwxShutdownError";
  }
}

/** Returns only the exact final-frame deadline needed to bound failed Arm cleanup. */
export function readArmArwxShutdownDeadline<TRole extends ServiceHostPayloadRole>(
  completed: Readonly<CompletedRuntimeBootstrap<TRole>>,
  receipt: ArwxFinalFrameReceipt,
): number | undefined {
  return readCompletedRuntimeBootstrapArwxShutdownDeadline(completed, receipt);
}

/** Builds an Arm request only from a completed bootstrap and an actual final-frame receipt. */
export function prepareArmArwxShutdown<TRole extends ServiceHostPayloadRole>(
  completed: Readonly<CompletedRuntimeBootstrap<TRole>>,
  receipt: ArwxFinalFrameReceipt,
): Readonly<PreparedArmArwxShutdownV1> {
  const binding = consumeCompletedRuntimeBootstrapForArwxShutdown(completed, receipt);
  if (binding === undefined) {
    failArwxFinalFrameReceipt(receipt);
    throw armError("ARM_STATE_INVALID", "ARWX shutdown authority is unavailable.");
  }
  const remainingShutdownMs = Math.floor(binding.absoluteDeadline - performance.now());
  if (!Number.isSafeInteger(remainingShutdownMs) || remainingShutdownMs < 1) {
    failArwxFinalFrameReceipt(receipt);
    throw armError("ARM_TIMEOUT", "ARWX shutdown deadline expired before arming.");
  }
  const request = Object.freeze({
    bootstrapId: binding.bootstrapId,
    shutdownId: binding.shutdownId,
    remainingShutdownMs,
    finalMessageType: binding.finalMessageType,
    finalSequence: binding.finalSequence.toString(10),
    finalCorrelationId: binding.finalCorrelationId,
    finalFrameBytes: binding.finalFrameBytes,
    finalFrameSha256: binding.finalFrameSha256,
  }) satisfies Readonly<ArmArwxShutdownV1>;
  const prepared = Object.freeze({}) as PreparedArmArwxShutdownV1;
  preparedArmStates.set(prepared, {
    request,
    absoluteDeadline: binding.absoluteDeadline,
    receipt,
    settled: false,
  });
  return prepared;
}

export function readPreparedArmArwxShutdown(
  prepared: PreparedArmArwxShutdownV1,
): Readonly<Pick<PreparedArmArwxShutdownState, "request" | "absoluteDeadline">> {
  const state = preparedArmStates.get(prepared);
  if (state === undefined || state.settled) {
    throw armError("ARM_STATE_INVALID", "Prepared ARWX shutdown authority is unavailable.");
  }
  return Object.freeze({ request: state.request, absoluteDeadline: state.absoluteDeadline });
}

export function commitPreparedArmArwxShutdown(prepared: PreparedArmArwxShutdownV1): void {
  const state = preparedArmStates.get(prepared);
  if (
    state === undefined ||
    state.settled ||
    state.absoluteDeadline <= performance.now() ||
    !commitArwxFinalFrameReceipt(state.receipt)
  ) {
    if (state !== undefined) {
      state.settled = true;
      failArwxFinalFrameReceipt(state.receipt);
    }
    throw armError("ARM_STATE_INVALID", "ARWX shutdown acknowledgement cannot be committed.");
  }
  state.settled = true;
}

export function failPreparedArmArwxShutdown(prepared: PreparedArmArwxShutdownV1): void {
  const state = preparedArmStates.get(prepared);
  if (state === undefined || state.settled) return;
  state.settled = true;
  failArwxFinalFrameReceipt(state.receipt);
}

/** Validates the exact ServiceHost result and its complete request echo. */
export function validateArmArwxShutdownResult(
  value: unknown,
  expected: Readonly<ArmArwxShutdownV1>,
): Readonly<ArmArwxShutdownResultV1> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "armed",
      "bootstrapId",
      "finalCorrelationId",
      "finalFrameBytes",
      "finalFrameSha256",
      "finalMessageType",
      "finalSequence",
      "remainingShutdownMs",
      "shutdownId",
    ]) ||
    value.armed !== true ||
    value.bootstrapId !== expected.bootstrapId ||
    value.shutdownId !== expected.shutdownId ||
    value.remainingShutdownMs !== expected.remainingShutdownMs ||
    value.finalMessageType !== expected.finalMessageType ||
    value.finalSequence !== expected.finalSequence ||
    value.finalCorrelationId !== expected.finalCorrelationId ||
    value.finalFrameBytes !== expected.finalFrameBytes ||
    value.finalFrameSha256 !== expected.finalFrameSha256
  ) {
    throw armError("ARM_RESULT_INVALID", "ArmArwxShutdownV1 result is invalid.");
  }
  return Object.freeze({
    armed: true,
    bootstrapId: expected.bootstrapId,
    shutdownId: expected.shutdownId,
    remainingShutdownMs: expected.remainingShutdownMs,
    finalMessageType: expected.finalMessageType,
    finalSequence: expected.finalSequence,
    finalCorrelationId: expected.finalCorrelationId,
    finalFrameBytes: expected.finalFrameBytes,
    finalFrameSha256: expected.finalFrameSha256,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function armError(code: ArmArwxShutdownError["code"], message: string): ArmArwxShutdownError {
  return new ArmArwxShutdownError(code, message);
}
