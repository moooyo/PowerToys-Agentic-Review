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
