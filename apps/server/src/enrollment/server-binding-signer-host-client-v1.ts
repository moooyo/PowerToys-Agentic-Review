import {
  type ChildProcessWithoutNullStreams,
  spawn as spawnSignerHostProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  loadProductionServerBindingSignerHostProfileV1,
  type ServerBindingSignerHostProfileV1,
} from "./server-binding-signer-host-profile-v1.js";
import {
  frameServerBindingSignerHostPayloadV1,
  marshalServerBindingSignerHostParentMessageV1,
  parseServerBindingSignerHostChildMessageV1,
  SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES,
  SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
  SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS,
  ServerBindingSignerHostFrameDecoderV1,
  type ServerBindingSignerHostOperationV1,
  type ServerBindingSignerHostParentMessageV1,
} from "./server-binding-signer-host-protocol-v1.js";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const issuedStates = new WeakSet<object>();

export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS = 4096;

export type ServerBindingSignerHostLogicalStateV1 =
  | "new"
  | "starting"
  | "ready_idle"
  | "signing"
  | "closing"
  | "failed"
  | "closed";

export type ServerBindingSignerHostCleanupStateV1 =
  | "no_spawn_attempt"
  | "spawn_not_started"
  | "child_live"
  | "termination_requested"
  | "exit_proven"
  | "exit_unproven";

export type ServerBindingSignerHostClientErrorCodeV1 =
  | "SIGNER_HOST_UNAVAILABLE"
  | "SIGNER_HOST_MISMATCH"
  | "SIGNER_HOST_PROTOCOL_FAILURE"
  | "SIGNER_HOST_OUTCOME_UNKNOWN"
  | "SIGNER_HOST_EXIT_UNPROVEN"
  | "SIGNER_HOST_BUSY"
  | "SIGNER_HOST_CLOSED";

type TerminalErrorCodeV1 = Exclude<
  ServerBindingSignerHostClientErrorCodeV1,
  "SIGNER_HOST_BUSY" | "SIGNER_HOST_CLOSED"
>;

export interface ServerBindingSignerHostClientStateV1 {
  readonly logicalState: ServerBindingSignerHostLogicalStateV1;
  readonly cleanupState: ServerBindingSignerHostCleanupStateV1;
  readonly activeRequestId: string | null;
  readonly shutdownRequestId: string | null;
  readonly shutdownAcknowledged: boolean;
  readonly terminalCode: TerminalErrorCodeV1 | null;
  readonly instanceId: string | null;
  readonly usedRequestIds: readonly string[];
}

/**
 * `reject_busy` allocates no ID, and `settle_local_sign_operation` records only local wrapper
 * settlement, never a received wire frame.
 */
export type ServerBindingSignerHostClientEventV1 =
  | Readonly<{ type: "start"; instanceId: string }>
  | Readonly<{ type: "spawn_started" }>
  | Readonly<{ type: "spawn_not_started" }>
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "begin_sign"; requestId: string }>
  | Readonly<{ type: "reject_busy" }>
  | Readonly<{ type: "settle_local_sign_operation"; requestId: string }>
  | Readonly<{ type: "close" }>
  | Readonly<{ type: "send_shutdown"; requestId: string }>
  | Readonly<{ type: "ack_shutdown"; requestId: string }>
  | Readonly<{ type: "request_termination" }>
  | Readonly<{ type: "fail"; code: TerminalErrorCodeV1 }>
  | Readonly<{ type: "exit_proven" }>
  | Readonly<{ type: "exit_unproven" }>;

export type ServerBindingSignerHostStateErrorCodeV1 =
  | "EVENT_INVALID"
  | "REQUEST_MISMATCH"
  | "STATE_INVALID"
  | "TRANSITION_INVALID";

export class ServerBindingSignerHostStateErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingSignerHostStateErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingSignerHostStateErrorV1";
  }
}

/** Creates one source-only lifecycle snapshot with no process, key, trust, or authority capability. */
export function createServerBindingSignerHostClientStateV1(): Readonly<ServerBindingSignerHostClientStateV1> {
  return freezeState({
    logicalState: "new",
    cleanupState: "no_spawn_attempt",
    activeRequestId: null,
    shutdownRequestId: null,
    shutdownAcknowledged: false,
    terminalCode: null,
    instanceId: null,
    usedRequestIds: [],
  });
}

/**
 * Reduces one already-observed lifecycle fact. This function performs no I/O, timekeeping, spawn,
 * signaling, cryptography, trust decision, or authority publication.
 */
export function reduceServerBindingSignerHostClientStateV1(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  eventValue: Readonly<ServerBindingSignerHostClientEventV1>,
): Readonly<ServerBindingSignerHostClientStateV1> {
  assertState(state);
  const event = snapshotEvent(eventValue);

  switch (event.type) {
    case "start": {
      requireTransition(state.logicalState === "new", "Only a new client can start.");
      return freezeState({
        ...state,
        logicalState: "starting",
        instanceId: event.instanceId,
      });
    }
    case "spawn_started":
      requireTransition(
        state.logicalState === "starting" ||
          state.logicalState === "closing" ||
          state.logicalState === "failed",
        "Spawn start is invalid in this client state.",
      );
      requireTransition(
        state.cleanupState === "no_spawn_attempt",
        "Spawn start requires no prior child fact.",
      );
      requireTransition(
        state.logicalState !== "failed" || state.instanceId !== null,
        "A failed pre-start client cannot acquire a child.",
      );
      return freezeState({
        ...state,
        cleanupState: state.logicalState === "starting" ? "child_live" : "termination_requested",
      });
    case "spawn_not_started":
      requireTransition(
        (state.logicalState === "starting" ||
          state.logicalState === "closing" ||
          state.logicalState === "failed") &&
          state.cleanupState === "no_spawn_attempt" &&
          (state.logicalState !== "failed" || state.instanceId !== null),
        "Spawn-not-started proof is invalid in this client state.",
      );
      if (state.logicalState === "closing") {
        return freezeState({
          ...state,
          logicalState: "closed",
          cleanupState: "spawn_not_started",
        });
      }
      if (state.logicalState === "failed") {
        return freezeState({ ...state, cleanupState: "spawn_not_started" });
      }
      return failState(state, "SIGNER_HOST_UNAVAILABLE", "spawn_not_started");
    case "ready":
      requireTransition(
        state.logicalState === "starting" && state.cleanupState === "child_live",
        "Ready is valid only for one live starting child.",
      );
      return freezeState({ ...state, logicalState: "ready_idle" });
    case "begin_sign":
      requireTransition(
        state.logicalState === "ready_idle" && state.cleanupState === "child_live",
        "Signing requires one ready idle child.",
      );
      requireRequestCapacity(state, true);
      requireUnusedRequestId(state, event.requestId);
      return freezeState({
        ...state,
        logicalState: "signing",
        activeRequestId: event.requestId,
        usedRequestIds: [...state.usedRequestIds, event.requestId],
      });
    case "reject_busy":
      requireTransition(
        state.logicalState === "signing" && state.activeRequestId !== null,
        "Busy rejection requires one active signing request.",
      );
      return state;
    case "settle_local_sign_operation":
      if (state.activeRequestId !== event.requestId) {
        throw stateError("REQUEST_MISMATCH", "Signing settlement referenced another request.");
      }
      if (state.logicalState === "signing") {
        return freezeState({
          ...state,
          logicalState:
            state.usedRequestIds.length ===
            SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS - 1
              ? "closing"
              : "ready_idle",
          activeRequestId: null,
        });
      }
      requireTransition(
        state.logicalState === "closing" || state.logicalState === "failed",
        "Late signing settlement is invalid in this client state.",
      );
      return freezeState({ ...state, activeRequestId: null });
    case "close":
      return beginClose(state);
    case "send_shutdown":
      requireTransition(
        state.logicalState === "closing" &&
          state.cleanupState === "child_live" &&
          state.activeRequestId === null &&
          state.shutdownRequestId === null,
        "Shutdown requires one idle closing child.",
      );
      requireRequestCapacity(state, false);
      requireUnusedRequestId(state, event.requestId);
      return freezeState({
        ...state,
        shutdownRequestId: event.requestId,
        usedRequestIds: [...state.usedRequestIds, event.requestId],
      });
    case "ack_shutdown":
      requireTransition(
        state.logicalState === "closing" &&
          state.cleanupState === "child_live" &&
          state.shutdownRequestId !== null &&
          !state.shutdownAcknowledged,
        "Shutdown acknowledgement is invalid in this client state.",
      );
      if (state.shutdownRequestId !== event.requestId) {
        throw stateError(
          "REQUEST_MISMATCH",
          "Shutdown acknowledgement referenced another request.",
        );
      }
      return freezeState({ ...state, shutdownAcknowledged: true });
    case "request_termination":
      requireTransition(
        (state.logicalState === "closing" || state.logicalState === "failed") &&
          (state.cleanupState === "child_live" || state.cleanupState === "termination_requested"),
        "Termination request is invalid in this client state.",
      );
      return state.cleanupState === "termination_requested"
        ? state
        : freezeState({ ...state, cleanupState: "termination_requested" });
    case "fail":
      if (state.logicalState === "failed") return state;
      requireTransition(state.logicalState !== "closed", "A closed client cannot fail.");
      return failState(
        state,
        event.code,
        state.cleanupState === "child_live" ? "termination_requested" : state.cleanupState,
      );
    case "exit_proven":
      return recordExitProven(state);
    case "exit_unproven":
      requireTransition(
        state.cleanupState === "termination_requested",
        "Unproved exit requires a prior termination request.",
      );
      return failState(state, state.terminalCode ?? "SIGNER_HOST_EXIT_UNPROVEN", "exit_unproven");
  }
}

function beginClose(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
): Readonly<ServerBindingSignerHostClientStateV1> {
  switch (state.logicalState) {
    case "new":
      return freezeState({ ...state, logicalState: "closed" });
    case "starting":
      return freezeState({
        ...state,
        logicalState: "closing",
        cleanupState:
          state.cleanupState === "child_live" ? "termination_requested" : state.cleanupState,
      });
    case "ready_idle":
      return freezeState({ ...state, logicalState: "closing" });
    case "signing":
      return freezeState({
        ...state,
        logicalState: "closing",
        cleanupState: "termination_requested",
      });
    case "closing":
    case "closed":
    case "failed":
      return state;
  }
}

function recordExitProven(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
): Readonly<ServerBindingSignerHostClientStateV1> {
  requireTransition(
    state.cleanupState === "child_live" ||
      state.cleanupState === "termination_requested" ||
      state.cleanupState === "exit_unproven",
    "Exit proof requires a started child.",
  );
  if (state.logicalState === "closing") {
    const orderly = state.shutdownRequestId !== null && state.shutdownAcknowledged;
    const forced = state.cleanupState === "termination_requested";
    if (!orderly && !forced) {
      return failAfterExit(state, "SIGNER_HOST_PROTOCOL_FAILURE");
    }
    return freezeState({
      ...state,
      logicalState: "closed",
      cleanupState: "exit_proven",
      activeRequestId: null,
      shutdownRequestId: null,
      shutdownAcknowledged: false,
    });
  }
  if (state.logicalState === "failed") {
    return freezeState({
      ...state,
      cleanupState: "exit_proven",
      activeRequestId: null,
      shutdownRequestId: null,
      shutdownAcknowledged: false,
    });
  }
  if (state.logicalState === "starting") {
    return failAfterExit(state, "SIGNER_HOST_UNAVAILABLE");
  }
  return failAfterExit(state, "SIGNER_HOST_OUTCOME_UNKNOWN");
}

function failAfterExit(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  code: TerminalErrorCodeV1,
): Readonly<ServerBindingSignerHostClientStateV1> {
  return freezeState({
    ...state,
    logicalState: "failed",
    cleanupState: "exit_proven",
    activeRequestId: null,
    shutdownRequestId: null,
    shutdownAcknowledged: false,
    terminalCode: state.terminalCode ?? code,
  });
}

function failState(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  code: TerminalErrorCodeV1,
  cleanupState: ServerBindingSignerHostCleanupStateV1,
): Readonly<ServerBindingSignerHostClientStateV1> {
  return freezeState({
    ...state,
    logicalState: "failed",
    cleanupState,
    terminalCode: state.terminalCode ?? code,
  });
}

function snapshotEvent(value: unknown): ServerBindingSignerHostClientEventV1 {
  const fields = snapshotPlainDataObject(value, "EVENT_INVALID", "Signer-host lifecycle event");
  const type = fields.type;
  if (typeof type !== "string") {
    throw stateError("EVENT_INVALID", "Signer-host lifecycle event type is invalid.");
  }
  switch (type) {
    case "spawn_started":
    case "spawn_not_started":
    case "ready":
    case "reject_busy":
    case "close":
    case "request_termination":
    case "exit_proven":
    case "exit_unproven":
      assertExactKeys(fields, ["type"], "EVENT_INVALID");
      return Object.freeze({ type });
    case "start":
      assertExactKeys(fields, ["instanceId", "type"], "EVENT_INVALID");
      return Object.freeze({ type, instanceId: requireUuid(fields.instanceId) });
    case "begin_sign":
    case "settle_local_sign_operation":
    case "send_shutdown":
    case "ack_shutdown":
      assertExactKeys(fields, ["requestId", "type"], "EVENT_INVALID");
      return Object.freeze({ type, requestId: requireUuid(fields.requestId) });
    case "fail":
      assertExactKeys(fields, ["code", "type"], "EVENT_INVALID");
      if (!isTerminalCode(fields.code)) {
        throw stateError("EVENT_INVALID", "Signer-host terminal code is invalid.");
      }
      return Object.freeze({ type, code: fields.code });
    default:
      throw stateError("EVENT_INVALID", "Signer-host lifecycle event type is unknown.");
  }
}

function assertState(
  state: unknown,
): asserts state is Readonly<ServerBindingSignerHostClientStateV1> {
  if (state === null || typeof state !== "object" || !issuedStates.has(state)) {
    throw stateError("STATE_INVALID", "Signer-host lifecycle state was not issued by this module.");
  }
}

function freezeState(
  value: ServerBindingSignerHostClientStateV1,
): Readonly<ServerBindingSignerHostClientStateV1> {
  const state = {
    ...value,
    usedRequestIds: Object.isFrozen(value.usedRequestIds)
      ? value.usedRequestIds
      : Object.freeze([...value.usedRequestIds]),
  };
  assertStateShape(state);
  Object.freeze(state);
  issuedStates.add(state);
  return state;
}

function assertStateShape(value: ServerBindingSignerHostClientStateV1): void {
  if (
    value.logicalState === "new" &&
    (value.cleanupState !== "no_spawn_attempt" ||
      value.activeRequestId !== null ||
      value.shutdownRequestId !== null ||
      value.shutdownAcknowledged ||
      value.terminalCode !== null ||
      value.instanceId !== null ||
      value.usedRequestIds.length !== 0)
  ) {
    throw stateError("STATE_INVALID", "New signer-host state is inconsistent.");
  }
  if (
    (value.logicalState === "ready_idle" || value.logicalState === "signing") &&
    value.cleanupState !== "child_live"
  ) {
    throw stateError("STATE_INVALID", "Ready or signing state requires one live child.");
  }
  if ((value.logicalState === "signing") !== (value.activeRequestId !== null)) {
    if (value.logicalState !== "closing" && value.logicalState !== "failed") {
      throw stateError("STATE_INVALID", "Active signer-host request shape is inconsistent.");
    }
  }
  if (value.shutdownAcknowledged && value.shutdownRequestId === null) {
    throw stateError("STATE_INVALID", "Shutdown acknowledgement requires a request ID.");
  }
  if (value.instanceId !== null && !uuidV4.test(value.instanceId)) {
    throw stateError("STATE_INVALID", "Signer-host instance ID is inconsistent.");
  }
  if (
    value.instanceId === null &&
    (value.logicalState === "starting" ||
      value.logicalState === "ready_idle" ||
      value.logicalState === "signing" ||
      value.logicalState === "closing" ||
      value.cleanupState !== "no_spawn_attempt" ||
      value.activeRequestId !== null ||
      value.shutdownRequestId !== null ||
      value.usedRequestIds.length !== 0)
  ) {
    throw stateError("STATE_INVALID", "Signer-host child facts require an instance ID.");
  }
  if (
    !Array.isArray(value.usedRequestIds) ||
    value.usedRequestIds.length > SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS ||
    value.usedRequestIds.some((requestId) => !uuidV4.test(requestId)) ||
    new Set(value.usedRequestIds).size !== value.usedRequestIds.length ||
    (value.activeRequestId !== null && !value.usedRequestIds.includes(value.activeRequestId)) ||
    (value.shutdownRequestId !== null && !value.usedRequestIds.includes(value.shutdownRequestId))
  ) {
    throw stateError("STATE_INVALID", "Signer-host used request IDs are inconsistent.");
  }
  if (
    value.logicalState === "ready_idle" &&
    value.usedRequestIds.length >= SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS - 1
  ) {
    throw stateError("STATE_INVALID", "Signer-host request capacity was not fenced.");
  }
  if (
    value.cleanupState === "exit_proven" &&
    (value.activeRequestId !== null ||
      value.shutdownRequestId !== null ||
      value.shutdownAcknowledged)
  ) {
    throw stateError("STATE_INVALID", "Exit-proven signer-host state retains live request facts.");
  }
  if ((value.logicalState === "failed") !== (value.terminalCode !== null)) {
    throw stateError("STATE_INVALID", "Terminal signer-host state shape is inconsistent.");
  }
  if (
    value.logicalState === "closed" &&
    value.cleanupState !== "no_spawn_attempt" &&
    value.cleanupState !== "spawn_not_started" &&
    value.cleanupState !== "exit_proven"
  ) {
    throw stateError("STATE_INVALID", "Closed signer-host state lacks cleanup proof.");
  }
}

function snapshotPlainDataObject(
  value: unknown,
  code: ServerBindingSignerHostStateErrorCodeV1,
  name: string,
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw stateError(code, `${name} must be an exact plain data object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: ServerBindingSignerHostStateErrorCodeV1,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw stateError(code, "Signer-host lifecycle event has an invalid member set.");
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV4.test(value)) {
    throw stateError("EVENT_INVALID", "Signer-host request ID is invalid.");
  }
  return value;
}

function requireUnusedRequestId(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  requestId: string,
): void {
  if (requestId === state.instanceId || state.usedRequestIds.includes(requestId)) {
    throw stateError("REQUEST_MISMATCH", "Signer-host request ID was already used.");
  }
}

function requireRequestCapacity(
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  reserveShutdownId: boolean,
): void {
  const limit =
    SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS - (reserveShutdownId ? 1 : 0);
  requireTransition(
    state.usedRequestIds.length < limit,
    "Signer-host request ID capacity is exhausted.",
  );
}

function isTerminalCode(value: unknown): value is TerminalErrorCodeV1 {
  return (
    value === "SIGNER_HOST_UNAVAILABLE" ||
    value === "SIGNER_HOST_MISMATCH" ||
    value === "SIGNER_HOST_PROTOCOL_FAILURE" ||
    value === "SIGNER_HOST_OUTCOME_UNKNOWN" ||
    value === "SIGNER_HOST_EXIT_UNPROVEN"
  );
}

function requireTransition(condition: boolean, message: string): asserts condition {
  if (!condition) throw stateError("TRANSITION_INVALID", message);
}

function stateError(
  code: ServerBindingSignerHostStateErrorCodeV1,
  message: string,
): ServerBindingSignerHostStateErrorV1 {
  return new ServerBindingSignerHostStateErrorV1(code, message);
}

export class ServerBindingSignerHostClientErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingSignerHostClientErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingSignerHostClientErrorV1";
  }
}

export interface ServerBindingSignerHostDirectClientV1 {
  readonly ready: Promise<void>;
  readonly terminalFailure: Promise<ServerBindingSignerHostClientErrorV1>;
  readIssuerPublicKeySpki(): Uint8Array | null;
  readTerminalError(): ServerBindingSignerHostClientErrorV1 | null;
  signReceiptStatementV1(statementJson: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  signActiveStatusStatementV1(statementJson: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface PendingSignerHostRequest {
  readonly operation: ServerBindingSignerHostOperationV1;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (signature: Uint8Array) => void;
  readonly reject: (error: ServerBindingSignerHostClientErrorV1) => void;
  readonly timer: NodeJS.Timeout;
  requestWritten: boolean;
}

interface SignerHostProfileSnapshot {
  readonly arguments: readonly string[];
  readonly executablePath: string;
  readonly workingDirectory: string;
}

const signerHostProtocolArgument = "--server-binding-signer-host-v1";
const maximumProfileStringCharacters = 32_767;
const maximumUuidGenerationAttempts = 8;
const quarantinedSignerHostOwners = new Set<DirectSignerHostOwner>();
const emptySignerHostEnvironment = Object.freeze(Object.create(null) as Record<string, string>);

/** Creates a dormant direct-child client without exposing path, environment, timeout, or spawn seams. */
export function createServerBindingSignerHostDirectClientV1(): Readonly<ServerBindingSignerHostDirectClientV1> {
  const owner = new DirectSignerHostOwner(quarantinedSignerHostOwners.size !== 0);
  const readIssuerPublicKeySpki = (): Uint8Array | null => owner.readIssuerPublicKeySpki();
  const readTerminalError = (): ServerBindingSignerHostClientErrorV1 | null =>
    owner.readTerminalError();
  const signReceiptStatementV1 = (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> => owner.signReceiptStatementV1(statementJson, signal);
  const signActiveStatusStatementV1 = (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> => owner.signActiveStatusStatementV1(statementJson, signal);
  const close = (): Promise<void> => owner.close();
  Object.freeze(readIssuerPublicKeySpki);
  Object.freeze(readTerminalError);
  Object.freeze(signReceiptStatementV1);
  Object.freeze(signActiveStatusStatementV1);
  Object.freeze(close);
  return Object.freeze({
    ready: owner.ready,
    terminalFailure: owner.terminalFailure,
    readIssuerPublicKeySpki,
    readTerminalError,
    signReceiptStatementV1,
    signActiveStatusStatementV1,
    close,
  });
}

class DirectSignerHostOwner {
  readonly #readyControl = Promise.withResolvers<void>();
  readonly #terminalControl = Promise.withResolvers<ServerBindingSignerHostClientErrorV1>();
  readonly #cleanupControl = Promise.withResolvers<void>();
  readonly #spawnOutcomeControl = Promise.withResolvers<void>();
  readonly #decoder = new ServerBindingSignerHostFrameDecoderV1();
  readonly #rawSettlements = new Set<Promise<unknown>>();
  readonly ready = this.#readyControl.promise;
  readonly terminalFailure = this.#terminalControl.promise;
  #state = createServerBindingSignerHostClientStateV1();
  #child: ChildProcessWithoutNullStreams | null = null;
  #instanceId: string | null = null;
  #issuerPublicKeySpki: Buffer | null = null;
  #terminalError: ServerBindingSignerHostClientErrorV1 | null = null;
  #pending: PendingSignerHostRequest | null = null;
  #cancelledRequestId: string | null = null;
  #writeChain: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #forcedCleanupPromise: Promise<void> | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #readySettled = false;
  #readyResolved = false;
  #spawnObserved = false;
  #preSpawnErrorObserved = false;
  #exitObserved = false;
  #childCloseObserved = false;
  #stdinClosed = false;
  #stdoutClosed = false;
  #stderrClosed = false;
  #stdoutEnded = false;
  #protocolOutputTerminal = false;
  #ignoreStartupProtocolOutput = false;
  #killRequested = false;
  #cleanupProven = false;
  #stderrBytes = 0;

  public constructor(blockedByQuarantine: boolean) {
    void this.ready.catch(() => undefined);
    if (blockedByQuarantine) {
      const error = this.#latchTerminal(
        "SIGNER_HOST_EXIT_UNPROVEN",
        "A prior Server binding signer-host exit remains unproved.",
      );
      this.#resolveCleanupWithoutChild();
      this.#rejectReady(error);
      return;
    }
    void this.#initialize();
  }

  public readIssuerPublicKeySpki(): Uint8Array | null {
    return this.#issuerPublicKeySpki === null ? null : Uint8Array.from(this.#issuerPublicKeySpki);
  }

  public readTerminalError(): ServerBindingSignerHostClientErrorV1 | null {
    return this.#terminalError;
  }

  public signReceiptStatementV1(
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#sign("receipt_statement_v1", "sign_receipt_statement_v1", statementJson, signal);
  }

  public signActiveStatusStatementV1(
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#sign(
      "active_status_statement_v1",
      "sign_active_status_statement_v1",
      statementJson,
      signal,
    );
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  async #initialize(): Promise<void> {
    let profileValue: ServerBindingSignerHostProfileV1;
    try {
      profileValue = await loadProductionServerBindingSignerHostProfileV1();
    } catch {
      if (this.#state.logicalState === "closed") return;
      const error = this.#latchTerminal(
        "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host profile is unavailable.",
      );
      this.#resolveCleanupWithoutChild();
      this.#rejectReady(error);
      return;
    }
    if (this.#state.logicalState === "closed") return;

    if (quarantinedSignerHostOwners.size !== 0) {
      const error = this.#latchTerminal(
        "SIGNER_HOST_EXIT_UNPROVEN",
        "A prior Server binding signer-host exit remains unproved.",
      );
      this.#resolveCleanupWithoutChild();
      this.#rejectReady(error);
      return;
    }

    let profile: SignerHostProfileSnapshot;
    let instanceId: string;
    try {
      profile = snapshotSignerHostProfile(profileValue);
      instanceId = randomUUID();
      if (!uuidV4.test(instanceId)) throw new TypeError();
    } catch {
      const error = this.#latchTerminal(
        "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host startup profile is invalid.",
      );
      this.#resolveCleanupWithoutChild();
      this.#rejectReady(error);
      return;
    }
    this.#instanceId = instanceId;
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
      type: "start",
      instanceId,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnSignerHostProcess(profile.executablePath, [...profile.arguments], {
        cwd: profile.workingDirectory,
        detached: false,
        env: emptySignerHostEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "spawn_not_started",
      });
      const error = this.#publishStateTerminal(
        "The Server binding signer-host process could not be started.",
      );
      this.#resolveCleanupWithoutChild();
      this.#rejectReady(error);
      return;
    }

    this.#child = child;
    this.#attachChildHandlers(child);
    this.#handshakeTimer = setTimeout(() => {
      if (this.#readySettled) return;
      const error = this.#latchTerminal(
        "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host handshake timed out.",
      );
      this.#rejectReady(error);
      void this.#ensureForcedCleanup();
    }, SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS);
    this.#handshakeTimer.unref();

    if (isPositivePid(child.pid)) this.#observeSpawn();
  }

  #attachChildHandlers(child: ChildProcessWithoutNullStreams): void {
    child.once("spawn", () => this.#observeSpawn());
    child.on("error", () => this.#handleChildError());
    child.once("exit", (code, signal) => this.#handleChildExit(code, signal));
    child.once("close", () => {
      this.#childCloseObserved = true;
      if (!this.#spawnObserved && !isPositivePid(child.pid)) {
        if (!this.#preSpawnErrorObserved) {
          const error = this.#latchTerminal(
            "SIGNER_HOST_UNAVAILABLE",
            "The Server binding signer-host closed without a spawn result.",
          );
          this.#rejectReady(error);
          quarantinedSignerHostOwners.add(this);
          this.#spawnOutcomeControl.resolve();
        }
      }
      this.#maybeProveCleanup();
    });
    child.stdin.on("error", () => this.#handleStreamFailure("stdin"));
    child.stdin.once("close", () => {
      this.#stdinClosed = true;
      if (
        !this.#exitObserved &&
        (this.#state.logicalState === "starting" ||
          this.#state.logicalState === "ready_idle" ||
          this.#state.logicalState === "signing")
      ) {
        this.#handleStreamFailure("stdin");
      }
      this.#maybeProveCleanup();
    });
    child.stdout.on("data", (chunk: unknown) => this.#handleStdoutData(chunk));
    child.stdout.on("error", () => this.#handleStreamFailure("stdout"));
    child.stdout.once("end", () => this.#handleStdoutEnd());
    child.stdout.once("close", () => {
      this.#stdoutClosed = true;
      if (
        !this.#stdoutEnded &&
        !this.#exitObserved &&
        (this.#state.logicalState === "starting" ||
          this.#state.logicalState === "ready_idle" ||
          this.#state.logicalState === "signing")
      ) {
        this.#handleStreamFailure("stdout");
      }
      this.#maybeProveCleanup();
    });
    child.stderr.on("data", (chunk: unknown) => this.#handleStderrData(chunk));
    child.stderr.on("error", () => this.#handleStreamFailure("stderr"));
    child.stderr.once("close", () => {
      this.#stderrClosed = true;
      if (
        !this.#exitObserved &&
        (this.#state.logicalState === "starting" ||
          this.#state.logicalState === "ready_idle" ||
          this.#state.logicalState === "signing")
      ) {
        this.#handleStreamFailure("stderr");
      }
      this.#maybeProveCleanup();
    });
  }

  #observeSpawn(): void {
    if (this.#spawnObserved) return;
    const child = this.#child;
    if (child === null) return;
    this.#spawnObserved = true;
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
      type: "spawn_started",
    });
    this.#spawnOutcomeControl.resolve();
    if (!isPositivePid(child.pid)) {
      const error = this.#latchTerminal(
        "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host process did not expose a valid PID.",
      );
      this.#rejectReady(error);
      void this.#ensureForcedCleanup();
      return;
    }

    if (this.#state.logicalState === "starting") {
      const instanceId = this.#instanceId;
      if (instanceId === null) {
        const error = this.#latchTerminal(
          "SIGNER_HOST_UNAVAILABLE",
          "The Server binding signer-host instance is unavailable.",
        );
        this.#rejectReady(error);
        void this.#ensureForcedCleanup();
        return;
      }
      let hello: Uint8Array;
      try {
        hello = marshalServerBindingSignerHostParentMessageV1({
          instanceId,
          protocolVersion: SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
          type: "hello",
        });
      } catch {
        const error = this.#latchTerminal(
          "SIGNER_HOST_UNAVAILABLE",
          "The Server binding signer-host handshake could not be encoded.",
        );
        this.#rejectReady(error);
        void this.#ensureForcedCleanup();
        return;
      }
      void this.#writePayload(hello).catch(() => {
        if (
          this.#state.logicalState === "closed" ||
          this.#state.cleanupState === "termination_requested" ||
          this.#state.cleanupState === "exit_proven"
        ) {
          return;
        }
        const error = this.#latchTerminal(
          this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
          "The Server binding signer-host handshake write failed.",
        );
        this.#rejectReady(error);
        void this.#ensureForcedCleanup();
      });
      return;
    }

    void this.#ensureForcedCleanup();
  }

  #handleChildError(): void {
    if (!this.#spawnObserved && isPositivePid(this.#child?.pid)) this.#observeSpawn();
    if (!this.#spawnObserved && !isPositivePid(this.#child?.pid)) {
      this.#preSpawnErrorObserved = true;
      quarantinedSignerHostOwners.add(this);
      if (this.#state.logicalState !== "closing") {
        const error = this.#latchTerminal(
          "SIGNER_HOST_UNAVAILABLE",
          "The Server binding signer-host process failed before spawn.",
        );
        this.#rejectReady(error);
      }
      this.#maybeProveCleanup();
      return;
    }
    if (
      this.#state.logicalState === "closing" &&
      this.#state.cleanupState === "termination_requested" &&
      this.#terminalError === null
    ) {
      return;
    }
    const error = this.#latchTerminal(
      this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
      "The Server binding signer-host process failed.",
    );
    this.#rejectReady(error);
    void this.#ensureForcedCleanup();
  }

  #handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.#spawnObserved) this.#observeSpawn();
    this.#exitObserved = true;
    const orderly =
      this.#state.logicalState === "closing" &&
      this.#state.cleanupState === "child_live" &&
      this.#state.shutdownAcknowledged &&
      code === 0 &&
      signal === null;
    const forced = this.#state.cleanupState === "termination_requested";
    if (!orderly && !forced && this.#terminalError === null) {
      const error = this.#latchTerminal(
        this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host process exited unexpectedly.",
      );
      this.#rejectReady(error);
      void this.#ensureForcedCleanup();
    }
    this.#maybeProveCleanup();
  }

  #handleStdoutData(chunk: unknown): void {
    const bytes = snapshotStreamBytes(chunk);
    if (bytes === null) {
      this.#protocolFailure("The Server binding signer-host stdout chunk is invalid.");
      return;
    }
    if (this.#ignoreStartupProtocolOutput) return;
    if (this.#protocolOutputTerminal) {
      this.#protocolFailure("The Server binding signer-host emitted bytes after a terminal frame.");
      return;
    }

    let payloads: readonly Uint8Array[];
    try {
      payloads = this.#decoder.push(bytes);
    } catch {
      this.#protocolFailure("The Server binding signer-host frame is invalid.");
      return;
    }
    for (const payload of payloads) {
      if (this.#protocolOutputTerminal) {
        this.#protocolFailure("The Server binding signer-host emitted a frame after termination.");
        return;
      }
      try {
        this.#handleChildMessage(parseServerBindingSignerHostChildMessageV1(payload));
      } catch (error) {
        if (error instanceof ServerBindingSignerHostClientErrorV1) {
          this.#protocolFailure(error.message);
        } else {
          this.#protocolFailure("The Server binding signer-host message is invalid.");
        }
        return;
      }
    }
  }

  #handleStdoutEnd(): void {
    if (this.#stdoutEnded) return;
    this.#stdoutEnded = true;
    if (!this.#ignoreStartupProtocolOutput) {
      try {
        this.#decoder.finish();
      } catch {
        this.#protocolFailure("The Server binding signer-host stdout ended with a partial frame.");
      }
    }
    if (
      this.#state.logicalState === "starting" ||
      this.#state.logicalState === "ready_idle" ||
      this.#state.logicalState === "signing"
    ) {
      const error = this.#latchTerminal(
        this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host stdout ended unexpectedly.",
      );
      this.#rejectReady(error);
      void this.#ensureForcedCleanup();
    }
  }

  #handleStderrData(chunk: unknown): void {
    const bytes = snapshotStreamBytes(chunk);
    if (bytes === null) {
      this.#handleStreamFailure("stderr");
      return;
    }
    this.#stderrBytes += bytes.byteLength;
    if (this.#stderrBytes > SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES) {
      const error = this.#latchTerminal(
        this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
        "The Server binding signer-host stderr limit was exceeded.",
      );
      this.#rejectReady(error);
      void this.#ensureForcedCleanup();
    }
  }

  #handleStreamFailure(stream: "stdin" | "stdout" | "stderr"): void {
    if (
      this.#state.logicalState === "closing" &&
      this.#state.cleanupState === "termination_requested" &&
      !this.#readyResolved &&
      this.#terminalError === null
    ) {
      return;
    }
    const error = this.#latchTerminal(
      this.#readyResolved ? "SIGNER_HOST_OUTCOME_UNKNOWN" : "SIGNER_HOST_UNAVAILABLE",
      `The Server binding signer-host ${stream} stream failed.`,
    );
    this.#rejectReady(error);
    void this.#ensureForcedCleanup();
  }

  #handleChildMessage(
    message: ReturnType<typeof parseServerBindingSignerHostChildMessageV1>,
  ): void {
    if (!this.#readyResolved) {
      if (message.type === "error") {
        if (
          message.requestId !== null ||
          (message.code !== "HANDSHAKE_REJECTED" && message.code !== "INTERNAL_FAILURE")
        ) {
          throw clientError(
            "SIGNER_HOST_MISMATCH",
            "The Server binding signer-host startup error is invalid.",
          );
        }
        this.#protocolOutputTerminal = true;
        const error = this.#latchTerminal(
          "SIGNER_HOST_UNAVAILABLE",
          "The Server binding signer-host rejected startup.",
        );
        this.#rejectReady(error);
        void this.#ensureForcedCleanup();
        return;
      }
      if (message.type !== "ready") {
        throw clientError(
          "SIGNER_HOST_MISMATCH",
          "The Server binding signer-host sent a response before readiness.",
        );
      }
      this.#acceptReady(message);
      return;
    }

    switch (message.type) {
      case "ready":
        throw clientError(
          "SIGNER_HOST_PROTOCOL_FAILURE",
          "The Server binding signer-host sent duplicate readiness.",
        );
      case "signature":
        this.#acceptSignature(message);
        return;
      case "cancelled":
        if (
          this.#cancelledRequestId === null ||
          message.requestId !== this.#cancelledRequestId ||
          this.#terminalError === null
        ) {
          throw clientError(
            "SIGNER_HOST_PROTOCOL_FAILURE",
            "The Server binding signer-host sent an unsolicited cancellation.",
          );
        }
        this.#protocolOutputTerminal = true;
        return;
      case "shutdown_ack":
        if (
          this.#state.logicalState !== "closing" ||
          this.#state.shutdownRequestId !== message.requestId
        ) {
          throw clientError(
            "SIGNER_HOST_PROTOCOL_FAILURE",
            "The Server binding signer-host shutdown acknowledgement is invalid.",
          );
        }
        this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
          type: "ack_shutdown",
          requestId: message.requestId,
        });
        this.#protocolOutputTerminal = true;
        return;
      case "error": {
        this.#acceptChildError(message);
        return;
      }
    }
  }

  #acceptChildError(
    message: Extract<
      ReturnType<typeof parseServerBindingSignerHostChildMessageV1>,
      { readonly type: "error" }
    >,
  ): void {
    const matchesPendingRequest =
      message.requestId !== null &&
      message.requestId === this.#pending?.requestId &&
      (message.code === "REQUEST_INVALID" ||
        message.code === "REQUEST_BUSY" ||
        message.code === "SIGNING_FAILED" ||
        message.code === "INTERNAL_FAILURE");
    const matchesCancelledRequest =
      message.requestId !== null &&
      message.requestId === this.#cancelledRequestId &&
      (message.code === "REQUEST_INVALID" ||
        message.code === "REQUEST_BUSY" ||
        message.code === "SIGNING_FAILED" ||
        message.code === "CANCEL_FAILED" ||
        message.code === "INTERNAL_FAILURE");
    const matchesShutdownRequest =
      message.requestId !== null &&
      message.requestId === this.#state.shutdownRequestId &&
      (message.code === "SHUTDOWN_REJECTED" || message.code === "INTERNAL_FAILURE");
    const matchesProcessFailure = message.requestId === null && message.code === "INTERNAL_FAILURE";
    if (
      !matchesPendingRequest &&
      !matchesCancelledRequest &&
      !matchesShutdownRequest &&
      !matchesProcessFailure
    ) {
      throw clientError(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host error correlation is invalid.",
      );
    }
    this.#protocolOutputTerminal = true;
    const error = this.#latchTerminal(
      "SIGNER_HOST_OUTCOME_UNKNOWN",
      "The Server binding signer-host reported an operation failure.",
    );
    this.#rejectReady(error);
    void this.#ensureForcedCleanup();
  }

  #acceptReady(
    message: Extract<
      ReturnType<typeof parseServerBindingSignerHostChildMessageV1>,
      { readonly type: "ready" }
    >,
  ): void {
    const child = this.#child;
    if (
      this.#state.logicalState !== "starting" ||
      child === null ||
      !isPositivePid(child.pid) ||
      message.hostPid !== child.pid ||
      message.instanceId !== this.#instanceId
    ) {
      throw clientError(
        "SIGNER_HOST_MISMATCH",
        "The Server binding signer-host readiness identity is invalid.",
      );
    }
    this.#issuerPublicKeySpki = Buffer.from(message.issuerPublicKeySpki, "base64url");
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, { type: "ready" });
    this.#clearHandshakeTimer();
    this.#readySettled = true;
    this.#readyResolved = true;
    this.#readyControl.resolve();
  }

  #acceptSignature(
    message: Extract<
      ReturnType<typeof parseServerBindingSignerHostChildMessageV1>,
      { readonly type: "signature" }
    >,
  ): void {
    const pending = this.#pending;
    if (
      pending === null ||
      this.#state.logicalState !== "signing" ||
      message.requestId !== pending.requestId ||
      message.operation !== pending.operation
    ) {
      throw clientError(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host signature correlation is invalid.",
      );
    }
    this.#pending = null;
    clearTimeout(pending.timer);
    this.#removeAbortListener(pending.signal, pending.onAbort);
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
      type: "settle_local_sign_operation",
      requestId: pending.requestId,
    });
    pending.resolve(Uint8Array.from(Buffer.from(message.signature, "base64url")));
    if (this.#state.logicalState === "closing") {
      void this.close().catch(() => undefined);
    }
  }

  #protocolFailure(message: string): void {
    const error = this.#latchTerminal(
      this.#readyResolved ? "SIGNER_HOST_PROTOCOL_FAILURE" : "SIGNER_HOST_MISMATCH",
      message,
    );
    this.#rejectReady(error);
    void this.#ensureForcedCleanup();
  }

  async #sign(
    operation: ServerBindingSignerHostOperationV1,
    type: "sign_active_status_statement_v1" | "sign_receipt_statement_v1",
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#state.logicalState === "signing") {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "reject_busy",
      });
      throw clientError("SIGNER_HOST_BUSY", "The Server binding signer-host is busy.");
    }
    if (this.#state.logicalState === "closing" || this.#state.logicalState === "closed") {
      throw clientError("SIGNER_HOST_CLOSED", "The Server binding signer-host is closed.");
    }
    if (this.#state.logicalState !== "ready_idle") {
      throw clientError("SIGNER_HOST_UNAVAILABLE", "The Server binding signer-host is not ready.");
    }
    let signalInitiallyAborted: boolean;
    try {
      this.#assertSignal(signal);
      signalInitiallyAborted = signal.aborted;
    } catch {
      const error = this.#latchTerminal(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host abort signal is invalid.",
      );
      void this.#ensureForcedCleanup();
      throw error;
    }
    if (signalInitiallyAborted) {
      const error = this.#latchTerminal(
        "SIGNER_HOST_OUTCOME_UNKNOWN",
        "The Server binding signer-host request was aborted.",
      );
      void this.#ensureForcedCleanup();
      throw error;
    }

    const requestId = this.#generateRequestId();
    let message: ServerBindingSignerHostParentMessageV1;
    let frame: Uint8Array;
    try {
      message = {
        protocolVersion: SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
        requestId,
        statementJson: Buffer.from(statementJson).toString("base64url"),
        type,
      };
      frame = frameServerBindingSignerHostPayloadV1(
        marshalServerBindingSignerHostParentMessageV1(message),
      );
    } catch {
      const error = this.#latchTerminal(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host statement is invalid.",
      );
      void this.#ensureForcedCleanup();
      throw error;
    }

    const control = Promise.withResolvers<Uint8Array>();
    let listenerArmed = false;
    let abortObservedBeforeArm = false;
    const onAbort = (): void => {
      if (!listenerArmed) {
        abortObservedBeforeArm = true;
        return;
      }
      this.#cancelActiveRequest("caller_abort");
    };
    let timer: NodeJS.Timeout | null = null;
    let signalAbortedAfterRegistration = false;
    try {
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => this.#cancelActiveRequest("deadline"),
        SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS,
      );
      timer.unref();
      signalAbortedAfterRegistration = signal.aborted;
    } catch {
      if (timer !== null) clearTimeout(timer);
      this.#removeAbortListener(signal, onAbort);
      const error = this.#latchTerminal(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host abort signal registration failed.",
      );
      void this.#ensureForcedCleanup();
      throw error;
    }
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
      type: "begin_sign",
      requestId,
    });
    const promise = control.promise;
    this.#pending = {
      operation,
      requestId,
      signal,
      onAbort,
      resolve: control.resolve,
      reject: control.reject,
      timer,
      requestWritten: false,
    };
    listenerArmed = true;
    if (abortObservedBeforeArm || signalAbortedAfterRegistration) onAbort();
    void promise.catch(() => undefined);

    if (this.#terminalError !== null) return await promise;

    try {
      if (this.#pending?.requestId === requestId) this.#pending.requestWritten = true;
      await this.#writeFrame(frame);
    } catch {
      if (
        this.#pending?.requestId !== requestId &&
        (this.#state.logicalState === "closed" ||
          this.#state.cleanupState === "termination_requested" ||
          this.#state.cleanupState === "exit_proven")
      ) {
        return await promise;
      }
      const error = this.#latchTerminal(
        "SIGNER_HOST_OUTCOME_UNKNOWN",
        "The Server binding signer-host request write failed.",
      );
      this.#rejectPending(error);
      void this.#ensureForcedCleanup();
      throw error;
    }
    return await promise;
  }

  #cancelActiveRequest(reason: "caller_abort" | "deadline" | "shutdown"): void {
    const pending = this.#pending;
    if (pending === null || this.#terminalError !== null) return;
    this.#cancelledRequestId = pending.requestId;
    const error = this.#latchTerminal(
      "SIGNER_HOST_OUTCOME_UNKNOWN",
      "The Server binding signer-host request outcome is unknown.",
    );
    this.#rejectPending(error);
    if (pending.requestWritten && this.#canWrite()) {
      try {
        const cancel = marshalServerBindingSignerHostParentMessageV1({
          protocolVersion: SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
          reason,
          requestId: pending.requestId,
          type: "cancel",
        });
        this.#writePayloadBestEffort(cancel);
      } catch {
        // The first outcome-unknown failure remains authoritative.
      }
    }
    void this.#ensureForcedCleanup();
  }

  async #closeInternal(): Promise<void> {
    if (this.#state.logicalState === "closed") return;
    if (this.#state.logicalState === "new") {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, { type: "close" });
      this.#rejectReady(
        clientError(
          "SIGNER_HOST_CLOSED",
          "The Server binding signer-host was closed before start.",
        ),
      );
      this.#cleanupControl.resolve();
      return;
    }

    if (this.#state.logicalState !== "failed") {
      const wasSigning = this.#state.logicalState === "signing";
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, { type: "close" });
      if (!this.#readySettled) {
        this.#ignoreStartupProtocolOutput = true;
        this.#clearHandshakeTimer();
        this.#rejectReady(
          clientError(
            "SIGNER_HOST_CLOSED",
            "The Server binding signer-host was closed during startup.",
          ),
        );
      }
      if (wasSigning) this.#cancelActiveRequest("shutdown");
    }

    if (this.#state.cleanupState === "no_spawn_attempt") {
      await this.#spawnOutcomeControl.promise;
    }
    if (
      this.#state.cleanupState === "spawn_not_started" ||
      this.#state.cleanupState === "no_spawn_attempt"
    ) {
      if (this.#terminalError !== null) throw this.#terminalError;
      return;
    }
    if (this.#state.logicalState === "failed") {
      await this.#ensureForcedCleanup();
      if (this.#isExitUnproven()) {
        throw (
          this.#terminalError ??
          this.#publishStateTerminal("The Server binding signer-host exit was not proved.")
        );
      }
      throw (
        this.#terminalError ??
        this.#publishStateTerminal("The Server binding signer-host failed during close.")
      );
    }
    if (this.#state.cleanupState === "termination_requested") {
      await this.#ensureForcedCleanup();
      if (this.#isExitUnproven()) {
        throw (
          this.#terminalError ??
          this.#publishStateTerminal("The Server binding signer-host exit was not proved.")
        );
      }
      if (this.#terminalError !== null) throw this.#terminalError;
      return;
    }

    const gracefulCleanup = this.#waitForCleanup(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    let shutdownWriteOutcome: Promise<"write_complete" | "write_failed"> | null = null;
    if (this.#state.shutdownRequestId === null) {
      let requestId: string;
      try {
        requestId = this.#generateRequestId();
      } catch (error) {
        await this.#ensureForcedCleanup();
        throw error;
      }
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "send_shutdown",
        requestId,
      });
      try {
        shutdownWriteOutcome = this.#writePayload(
          marshalServerBindingSignerHostParentMessageV1({
            protocolVersion: SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
            requestId,
            type: "shutdown",
          }),
        ).then(
          () => "write_complete" as const,
          () => "write_failed" as const,
        );
      } catch {
        const error = this.#latchTerminal(
          "SIGNER_HOST_OUTCOME_UNKNOWN",
          "The Server binding signer-host shutdown write failed.",
        );
        await this.#ensureForcedCleanup();
        throw error;
      }
    }

    const firstCloseOutcome = await Promise.race([
      gracefulCleanup.then((proved): "cleanup_proven" | "deadline" =>
        proved ? "cleanup_proven" : "deadline",
      ),
      ...(shutdownWriteOutcome === null ? [] : [shutdownWriteOutcome]),
    ]);
    if (firstCloseOutcome === "write_failed") {
      const error = this.#latchTerminal(
        "SIGNER_HOST_OUTCOME_UNKNOWN",
        "The Server binding signer-host shutdown write failed.",
      );
      await this.#ensureForcedCleanup();
      throw error;
    }
    if (firstCloseOutcome === "deadline") {
      await this.#ensureForcedCleanup();
    } else if (firstCloseOutcome === "write_complete" && !(await gracefulCleanup)) {
      await this.#ensureForcedCleanup();
    }
    if (this.#isExitUnproven()) {
      throw (
        this.#terminalError ??
        this.#publishStateTerminal("The Server binding signer-host exit was not proved.")
      );
    }
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#state.logicalState !== "closed") {
      throw clientError(
        "SIGNER_HOST_EXIT_UNPROVEN",
        "The Server binding signer-host close was not proved.",
      );
    }
  }

  async #ensureForcedCleanup(): Promise<void> {
    this.#forcedCleanupPromise ??= this.#forceCleanup();
    await this.#forcedCleanupPromise;
  }

  async #forceCleanup(): Promise<void> {
    quarantinedSignerHostOwners.add(this);
    if (this.#state.cleanupState === "no_spawn_attempt") {
      await this.#spawnOutcomeControl.promise;
    }
    if (this.#cleanupProven && this.#state.cleanupState === "no_spawn_attempt") {
      this.#maybeReleaseQuarantine();
      return;
    }
    if (
      this.#state.cleanupState === "spawn_not_started" ||
      this.#state.cleanupState === "exit_proven"
    ) {
      this.#maybeReleaseQuarantine();
      return;
    }
    if (this.#state.cleanupState === "child_live") {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "request_termination",
      });
    }
    if (this.#state.cleanupState !== "termination_requested") return;
    if (!this.#exitObserved) this.#requestKill();
    const exited = await this.#waitForCleanup(
      SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
    );
    if (!exited && this.#state.cleanupState === "termination_requested") {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "exit_unproven",
      });
      if (this.#terminalError === null) {
        this.#publishStateTerminal("The Server binding signer-host exit was not proved.");
      }
    }
    this.#maybeReleaseQuarantine();
  }

  #requestKill(): void {
    if (this.#killRequested) return;
    this.#killRequested = true;
    const child = this.#child;
    if (child === null) return;
    try {
      child.stdin.destroy();
    } catch {
      // Stream destruction is not exit proof.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // A thrown kill is handled by the forced-exit deadline.
    }
  }

  #maybeProveCleanup(): void {
    if (this.#cleanupProven) return;
    if (
      !this.#spawnObserved &&
      this.#preSpawnErrorObserved &&
      this.#childCloseObserved &&
      this.#stdinClosed &&
      this.#stdoutClosed &&
      this.#stderrClosed
    ) {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "spawn_not_started",
      });
      this.#cleanupProven = true;
      this.#spawnOutcomeControl.resolve();
      this.#cleanupControl.resolve();
      this.#maybeReleaseQuarantine();
      return;
    }
    if (
      this.#spawnObserved &&
      this.#exitObserved &&
      this.#childCloseObserved &&
      this.#stdinClosed &&
      this.#stdoutClosed &&
      this.#stderrClosed
    ) {
      this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
        type: "exit_proven",
      });
      if (this.#state.logicalState === "failed" && this.#terminalError === null) {
        this.#publishStateTerminal("The Server binding signer-host exited unexpectedly.");
      }
      this.#cleanupProven = true;
      this.#clearHandshakeTimer();
      this.#cleanupControl.resolve();
      this.#maybeReleaseQuarantine();
    }
  }

  #resolveCleanupWithoutChild(): void {
    this.#cleanupProven = true;
    this.#spawnOutcomeControl.resolve();
    this.#cleanupControl.resolve();
  }

  #latchTerminal(code: TerminalErrorCodeV1, message: string): ServerBindingSignerHostClientErrorV1 {
    if (this.#terminalError !== null) return this.#terminalError;
    this.#state = reduceServerBindingSignerHostClientStateV1(this.#state, {
      type: "fail",
      code,
    });
    const error = clientError(code, message);
    this.#terminalError = error;
    this.#terminalControl.resolve(error);
    this.#clearHandshakeTimer();
    this.#rejectPending(error);
    return error;
  }

  #publishStateTerminal(message: string): ServerBindingSignerHostClientErrorV1 {
    if (this.#terminalError !== null) return this.#terminalError;
    const code = this.#state.terminalCode;
    if (code === null) {
      throw stateError("STATE_INVALID", "Signer-host terminal state lacks an error code.");
    }
    const error = clientError(code, message);
    this.#terminalError = error;
    this.#terminalControl.resolve(error);
    this.#clearHandshakeTimer();
    this.#rejectPending(error);
    return error;
  }

  #rejectReady(error: ServerBindingSignerHostClientErrorV1): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyControl.reject(error);
  }

  #rejectPending(error: ServerBindingSignerHostClientErrorV1): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    this.#removeAbortListener(pending.signal, pending.onAbort);
    pending.reject(error);
  }

  #removeAbortListener(signal: AbortSignal, listener: () => void): void {
    try {
      signal.removeEventListener("abort", listener);
    } catch {
      // Cleared request correlation prevents a hostile listener owner from reviving the operation.
    }
  }

  #generateRequestId(): string {
    try {
      for (let attempt = 0; attempt < maximumUuidGenerationAttempts; attempt += 1) {
        const candidate = randomUUID();
        if (
          uuidV4.test(candidate) &&
          candidate !== this.#state.instanceId &&
          !this.#state.usedRequestIds.includes(candidate)
        ) {
          return candidate;
        }
      }
    } catch {
      // A throwing UUID source is terminal and is mapped to the same stable public category.
    }
    const error = this.#latchTerminal(
      "SIGNER_HOST_PROTOCOL_FAILURE",
      "The Server binding signer-host request ID generator failed.",
    );
    void this.#ensureForcedCleanup();
    throw error;
  }

  #assertSignal(signal: AbortSignal): void {
    if (
      signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    ) {
      throw clientError(
        "SIGNER_HOST_PROTOCOL_FAILURE",
        "The Server binding signer-host abort signal is invalid.",
      );
    }
  }

  #canWrite(): boolean {
    const stdin = this.#child?.stdin;
    return stdin !== undefined && !stdin.destroyed && !stdin.writableEnded;
  }

  #writePayload(payload: Uint8Array): Promise<void> {
    return this.#writeFrame(frameServerBindingSignerHostPayloadV1(payload));
  }

  #writeFrame(frame: Uint8Array): Promise<void> {
    const write = this.#writeChain
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const stdin = this.#child?.stdin;
            if (stdin === undefined || stdin.destroyed || stdin.writableEnded) {
              reject(new Error("Signer-host stdin is unavailable."));
              return;
            }
            try {
              stdin.write(frame, (error: Error | null | undefined) => {
                if (error === null || error === undefined) resolve();
                else reject(new Error("Signer-host stdin write failed."));
              });
            } catch {
              reject(new Error("Signer-host stdin write failed."));
            }
          }),
      );
    this.#writeChain = write.catch(() => undefined);
    return this.#trackRawSettlement(write);
  }

  #writePayloadBestEffort(payload: Uint8Array): void {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin.destroyed || stdin.writableEnded) return;
    let frame: Uint8Array;
    try {
      frame = frameServerBindingSignerHostPayloadV1(payload);
    } catch {
      return;
    }
    const write = new Promise<void>((resolve) => {
      try {
        stdin.write(frame, () => resolve());
      } catch {
        resolve();
      }
    });
    void this.#trackRawSettlement(write);
  }

  #trackRawSettlement<T>(promise: Promise<T>): Promise<T> {
    this.#rawSettlements.add(promise);
    void promise
      .finally(() => {
        this.#rawSettlements.delete(promise);
        this.#maybeReleaseQuarantine();
      })
      .catch(() => undefined);
    return promise;
  }

  #waitForCleanup(timeoutMilliseconds: number): Promise<boolean> {
    if (this.#cleanupProven) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      timer.unref();
      void this.#cleanupControl.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #maybeReleaseQuarantine(): void {
    if (this.#cleanupProven && this.#rawSettlements.size === 0) {
      quarantinedSignerHostOwners.delete(this);
    }
  }

  #isExitUnproven(): boolean {
    return this.#state.cleanupState === "exit_unproven";
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }
}

function snapshotSignerHostProfile(value: unknown): SignerHostProfileSnapshot {
  const fields = snapshotPlainDataObject(value, "STATE_INVALID", "Signer-host profile");
  assertExactKeys(fields, ["arguments", "executablePath", "workingDirectory"], "STATE_INVALID");
  const executablePath = requireAbsoluteProfilePath(fields.executablePath, "executable path");
  const workingDirectory = requireAbsoluteProfilePath(fields.workingDirectory, "working directory");
  const argumentsList = snapshotProfileArguments(fields.arguments);
  return Object.freeze({
    arguments: Object.freeze(argumentsList),
    executablePath,
    workingDirectory,
  });
}

function snapshotProfileArguments(value: unknown): string[] {
  const argumentsList = snapshotExactProfileStringArray(value);
  if (
    argumentsList.length !== 1 ||
    argumentsList.some(
      (argument) =>
        argument.length === 0 ||
        argument.length > maximumProfileStringCharacters ||
        argument.includes("\0"),
    ) ||
    argumentsList[0] !== signerHostProtocolArgument
  ) {
    throw new TypeError("Signer-host profile arguments are invalid.");
  }
  return argumentsList;
}

function snapshotExactProfileStringArray(value: unknown): string[] {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorMap = descriptors as unknown as Record<string, PropertyDescriptor | undefined>;
    const lengthDescriptor = descriptorMap.length;
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new TypeError();
    }
    const length = lengthDescriptor.value;
    const expectedKeys = Array.from({ length }, (_, index) => String(index));
    expectedKeys.push("length");
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      throw new TypeError();
    }
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptorMap[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      ) {
        throw new TypeError();
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    throw new TypeError("Signer-host profile arguments are invalid.");
  }
}

function requireAbsoluteProfilePath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumProfileStringCharacters ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new TypeError(`Signer-host ${name} is invalid.`);
  }
  return value;
}

function snapshotStreamBytes(value: unknown): Buffer | null {
  if (!(value instanceof Uint8Array)) return null;
  try {
    return Buffer.from(value);
  } catch {
    return null;
  }
}

function isPositivePid(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function clientError(
  code: ServerBindingSignerHostClientErrorCodeV1,
  message: string,
): ServerBindingSignerHostClientErrorV1 {
  return new ServerBindingSignerHostClientErrorV1(code, message);
}
