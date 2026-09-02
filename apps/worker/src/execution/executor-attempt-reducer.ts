const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const nonZeroSha256Pattern = /^(?!0{64}$)[a-f0-9]{64}$/u;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface ExecutorAttemptIdentity {
  readonly attemptCorrelationId: string;
  readonly capabilityId: string;
  readonly leaseGeneration: number;
  readonly runAttemptId: string;
}

export type ExecutorAttemptPhase =
  | "reserved"
  | "launching"
  | "running"
  | "stopping"
  | "settling"
  | "awaiting_disposition"
  | "cleaning"
  | "closed"
  | "faulted";

export type ExecutorAttemptStopReason =
  | "cancelled"
  | "close"
  | "drain"
  | "expired"
  | "lease_lost"
  | "process_host_failed"
  | "shutdown"
  | "stale_revision";

export type ExecutorAttemptTerminalOutcome = "completed" | "failed";

export type ExecutorAttemptDispositionOutcome =
  | "committed"
  | "retry_scheduled"
  | "cancelled"
  | "fenced"
  | "rejected";

export type ExecutorAttemptWorkspaceDisposition = "delete" | "retain_for_janitor";
export type ExecutorAttemptCleanupOutcome = "deleted" | "retained" | "janitor_required";

export interface ExecutorAttemptStop {
  readonly reason: ExecutorAttemptStopReason;
}

export interface ExecutorAttemptTerminal {
  readonly outcome: ExecutorAttemptTerminalOutcome;
  readonly payloadSha256: string;
}

export interface ExecutorAttemptDisposition {
  readonly dispositionId: string;
  readonly outcome: ExecutorAttemptDispositionOutcome;
  readonly terminalPayloadSha256: string;
  readonly workspaceDisposition: ExecutorAttemptWorkspaceDisposition;
}

export interface ExecutorAttemptCleanup {
  readonly dispositionId: string;
  readonly outcome: ExecutorAttemptCleanupOutcome;
}

export interface ExecutorAttemptFault {
  readonly code: string;
}

export interface ExecutorAttemptState {
  readonly cleanup: Readonly<ExecutorAttemptCleanup> | null;
  readonly disposition: Readonly<ExecutorAttemptDisposition> | null;
  readonly fault: Readonly<ExecutorAttemptFault> | null;
  readonly identity: Readonly<ExecutorAttemptIdentity>;
  readonly launchConfirmed: boolean;
  readonly launchRequested: boolean;
  readonly phase: ExecutorAttemptPhase;
  readonly processTreeZero: boolean;
  readonly stop: Readonly<ExecutorAttemptStop> | null;
  readonly terminal: Readonly<ExecutorAttemptTerminal> | null;
}

type IdentityBoundEvent<TType extends string> = Readonly<{
  type: TType;
  identity: Readonly<ExecutorAttemptIdentity>;
}>;

export type ExecutorAttemptEvent =
  | IdentityBoundEvent<"launch_requested">
  | IdentityBoundEvent<"launch_confirmed">
  | (IdentityBoundEvent<"stop_requested"> & Readonly<{ reason: ExecutorAttemptStopReason }>)
  | (IdentityBoundEvent<"terminal_verified"> &
      Readonly<{ outcome: ExecutorAttemptTerminalOutcome; payloadSha256: string }>)
  | IdentityBoundEvent<"process_tree_zero">
  | (IdentityBoundEvent<"disposition_committed"> &
      Readonly<{
        dispositionId: string;
        outcome: ExecutorAttemptDispositionOutcome;
        terminalPayloadSha256: string;
        workspaceDisposition: ExecutorAttemptWorkspaceDisposition;
      }>)
  | (IdentityBoundEvent<"cleanup_finished"> &
      Readonly<{ dispositionId: string; outcome: ExecutorAttemptCleanupOutcome }>)
  | (IdentityBoundEvent<"fatal"> & Readonly<{ code: string }>);

export class ExecutorAttemptReducerError extends Error {
  public constructor(
    public readonly code:
      | "ABSORBING_STATE"
      | "EVENT_CONFLICT"
      | "EVENT_INVALID"
      | "IDENTITY_INVALID"
      | "IDENTITY_MISMATCH"
      | "STATE_INVALID"
      | "TRANSITION_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ExecutorAttemptReducerError";
  }
}

type StructuralFactErrorCode = "EVENT_INVALID" | "STATE_INVALID";
type PlainDataErrorCode = StructuralFactErrorCode | "IDENTITY_INVALID";

/**
 * Creates a pure attempt-lifecycle snapshot. This reducer is not an execution-authority boundary:
 * it neither admits work nor proves that its caller holds a verified capability. Inputs must be
 * ordinary non-Proxy objects; the zero-import reducer rejects non-plain prototypes, accessors,
 * symbols, non-enumerable fields, and extra fields before copying data descriptors.
 */
export function createExecutorAttemptState(
  identityValue: Readonly<ExecutorAttemptIdentity>,
): Readonly<ExecutorAttemptState> {
  const identity = snapshotIdentity(identityValue);
  return freezeState({
    cleanup: null,
    disposition: null,
    fault: null,
    identity,
    launchConfirmed: false,
    launchRequested: false,
    phase: "reserved",
    processTreeZero: false,
    stop: null,
    terminal: null,
  });
}

/**
 * Reduces one already-routed lifecycle fact without I/O, callbacks, clocks, randomness, or hidden
 * mutable state. A future adapter must authenticate and reserve authority before calling it and
 * must honor the structured-data, non-Proxy input contract documented by the state factory.
 */
export function reduceExecutorAttempt(
  state: Readonly<ExecutorAttemptState>,
  eventValue: Readonly<ExecutorAttemptEvent>,
): Readonly<ExecutorAttemptState> {
  assertState(state);
  const event = snapshotEvent(eventValue);
  assertEventIdentity(state.identity, event);

  if (state.phase === "faulted") {
    if (event.type === "fatal") {
      assertFaultCode(event.code);
      if (state.fault?.code === event.code) return state;
      throw reducerError("EVENT_CONFLICT", "Fatal replay changed the retained fault code.");
    }
    throw reducerError("ABSORBING_STATE", "A faulted attempt cannot accept another event.");
  }
  if (state.phase === "closed") {
    if (event.type === "cleanup_finished") {
      assertCleanup(event.dispositionId, event.outcome);
      if (
        state.cleanup?.dispositionId === event.dispositionId &&
        state.cleanup.outcome === event.outcome
      ) {
        return state;
      }
      throw reducerError("EVENT_CONFLICT", "Cleanup replay changed the retained outcome.");
    }
    throw reducerError("ABSORBING_STATE", "A closed attempt cannot accept another event.");
  }

  switch (event.type) {
    case "launch_requested":
      return reduceLaunchRequested(state);
    case "launch_confirmed":
      return reduceLaunchConfirmed(state);
    case "stop_requested":
      return reduceStopRequested(state, event.reason);
    case "terminal_verified":
      return reduceTerminalVerified(state, event.outcome, event.payloadSha256);
    case "process_tree_zero":
      return reduceProcessTreeZero(state);
    case "disposition_committed":
      return reduceDispositionCommitted(state, event);
    case "cleanup_finished":
      return reduceCleanupFinished(state, event.dispositionId, event.outcome);
    case "fatal":
      return reduceFatal(state, event.code);
    default:
      throw reducerError("EVENT_INVALID", "Attempt event type is invalid.");
  }
}

function reduceLaunchRequested(
  state: Readonly<ExecutorAttemptState>,
): Readonly<ExecutorAttemptState> {
  if (state.launchRequested) return state;
  if (
    state.stop !== null ||
    state.terminal !== null ||
    state.processTreeZero ||
    state.disposition !== null ||
    state.cleanup !== null
  ) {
    throw reducerError(
      "TRANSITION_INVALID",
      "An attempt cannot request launch after lifecycle settlement started.",
    );
  }
  return nextState(state, { launchRequested: true });
}

function reduceLaunchConfirmed(
  state: Readonly<ExecutorAttemptState>,
): Readonly<ExecutorAttemptState> {
  if (state.launchConfirmed) return state;
  if (
    !state.launchRequested ||
    state.stop !== null ||
    state.terminal !== null ||
    state.processTreeZero ||
    state.disposition !== null ||
    state.cleanup !== null
  ) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Launch confirmation requires one active, unfenced launch request.",
    );
  }
  return nextState(state, { launchConfirmed: true });
}

function reduceStopRequested(
  state: Readonly<ExecutorAttemptState>,
  reason: ExecutorAttemptStopReason,
): Readonly<ExecutorAttemptState> {
  assertStopReason(reason);
  if (state.stop !== null) {
    if (state.stop.reason === reason) return state;
    throw reducerError("EVENT_CONFLICT", "Stop replay changed the first retained stop reason.");
  }
  if (
    state.phase === "awaiting_disposition" ||
    state.disposition !== null ||
    state.cleanup !== null
  ) {
    throw reducerError(
      "TRANSITION_INVALID",
      "An attempt cannot acquire a stop reason after terminal settlement completed.",
    );
  }
  return nextState(state, { stop: Object.freeze({ reason }) });
}

function reduceTerminalVerified(
  state: Readonly<ExecutorAttemptState>,
  outcome: ExecutorAttemptTerminalOutcome,
  payloadSha256: string,
): Readonly<ExecutorAttemptState> {
  assertTerminal(outcome, payloadSha256);
  if (state.terminal !== null) {
    if (state.terminal.outcome === outcome && state.terminal.payloadSha256 === payloadSha256) {
      return state;
    }
    throw reducerError("EVENT_CONFLICT", "Terminal replay changed the retained terminal evidence.");
  }
  if (outcome === "completed" && !state.launchConfirmed) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Successful terminal evidence requires a confirmed launch.",
    );
  }
  if (!state.launchConfirmed && state.stop === null) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Terminal evidence requires a confirmed launch or an already latched stop.",
    );
  }
  if (state.disposition !== null || state.cleanup !== null) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Terminal evidence cannot arrive after disposition or cleanup.",
    );
  }
  return nextState(state, {
    terminal: Object.freeze({ outcome, payloadSha256 }),
  });
}

function reduceProcessTreeZero(
  state: Readonly<ExecutorAttemptState>,
): Readonly<ExecutorAttemptState> {
  if (state.processTreeZero) return state;
  if (!state.launchConfirmed && state.stop === null) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Process-tree settlement requires a confirmed launch or an already latched stop.",
    );
  }
  if (state.disposition !== null || state.cleanup !== null) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Process-tree settlement cannot arrive after disposition or cleanup.",
    );
  }
  return nextState(state, { processTreeZero: true });
}

function reduceDispositionCommitted(
  state: Readonly<ExecutorAttemptState>,
  event: Extract<ExecutorAttemptEvent, { readonly type: "disposition_committed" }>,
): Readonly<ExecutorAttemptState> {
  assertDisposition(event);
  if (state.disposition !== null) {
    if (sameDisposition(state.disposition, event)) return state;
    throw reducerError(
      "EVENT_CONFLICT",
      "Disposition replay changed the retained terminal decision.",
    );
  }
  if (state.terminal === null || !state.processTreeZero) {
    throw reducerError(
      "TRANSITION_INVALID",
      "Disposition requires verified terminal evidence and a zero process tree.",
    );
  }
  if (event.terminalPayloadSha256 !== state.terminal.payloadSha256) {
    throw reducerError(
      "EVENT_CONFLICT",
      "Disposition does not bind the retained terminal payload.",
    );
  }
  return nextState(state, {
    disposition: Object.freeze({
      dispositionId: event.dispositionId,
      outcome: event.outcome,
      terminalPayloadSha256: event.terminalPayloadSha256,
      workspaceDisposition: event.workspaceDisposition,
    }),
  });
}

function reduceCleanupFinished(
  state: Readonly<ExecutorAttemptState>,
  dispositionId: string,
  outcome: ExecutorAttemptCleanupOutcome,
): Readonly<ExecutorAttemptState> {
  assertCleanup(dispositionId, outcome);
  if (state.cleanup !== null) {
    if (state.cleanup.dispositionId === dispositionId && state.cleanup.outcome === outcome) {
      return state;
    }
    throw reducerError("EVENT_CONFLICT", "Cleanup replay changed the retained outcome.");
  }
  const disposition = state.disposition;
  if (disposition === null) {
    throw reducerError("TRANSITION_INVALID", "Cleanup requires a committed disposition.");
  }
  if (disposition.dispositionId !== dispositionId) {
    throw reducerError("EVENT_CONFLICT", "Cleanup belongs to another disposition.");
  }
  if (
    (disposition.workspaceDisposition === "delete" && outcome === "retained") ||
    (disposition.workspaceDisposition === "retain_for_janitor" && outcome === "deleted")
  ) {
    throw reducerError(
      "EVENT_CONFLICT",
      "Cleanup outcome contradicts the committed workspace disposition.",
    );
  }
  return nextState(state, {
    cleanup: Object.freeze({ dispositionId, outcome }),
  });
}

function reduceFatal(
  state: Readonly<ExecutorAttemptState>,
  code: string,
): Readonly<ExecutorAttemptState> {
  assertFaultCode(code);
  return nextState(state, { fault: Object.freeze({ code }) });
}

function nextState(
  state: Readonly<ExecutorAttemptState>,
  patch: Partial<Omit<ExecutorAttemptState, "identity" | "phase">>,
): Readonly<ExecutorAttemptState> {
  const candidate: Omit<ExecutorAttemptState, "phase"> = {
    cleanup: patch.cleanup ?? state.cleanup,
    disposition: patch.disposition ?? state.disposition,
    fault: patch.fault ?? state.fault,
    identity: state.identity,
    launchConfirmed: patch.launchConfirmed ?? state.launchConfirmed,
    launchRequested: patch.launchRequested ?? state.launchRequested,
    processTreeZero: patch.processTreeZero ?? state.processTreeZero,
    stop: patch.stop ?? state.stop,
    terminal: patch.terminal ?? state.terminal,
  };
  return freezeState({ ...candidate, phase: derivePhase(candidate) });
}

function derivePhase(state: Omit<ExecutorAttemptState, "phase">): ExecutorAttemptPhase {
  if (state.fault !== null) return "faulted";
  if (state.cleanup !== null) return "closed";
  if (state.disposition !== null) return "cleaning";
  if (state.terminal !== null && state.processTreeZero) return "awaiting_disposition";
  if (state.terminal !== null || state.processTreeZero) return "settling";
  if (state.stop !== null) return "stopping";
  if (state.launchConfirmed) return "running";
  if (state.launchRequested) return "launching";
  return "reserved";
}

function freezeState(state: ExecutorAttemptState): Readonly<ExecutorAttemptState> {
  return Object.freeze(state);
}

function snapshotEvent(eventValue: unknown): Readonly<ExecutorAttemptEvent> {
  const descriptors = readPlainDataDescriptors(eventValue, "EVENT_INVALID", "Attempt event");
  const type = dataValue(descriptors, "type");
  if (typeof type !== "string") {
    throw reducerError("EVENT_INVALID", "Attempt event type is invalid.");
  }
  const identity = snapshotIdentity(dataValue(descriptors, "identity"));
  switch (type) {
    case "launch_requested":
    case "launch_confirmed":
    case "process_tree_zero":
      assertExactDescriptorKeys(
        descriptors,
        ["identity", "type"],
        "EVENT_INVALID",
        "Attempt event",
      );
      return Object.freeze({ identity, type }) as Readonly<ExecutorAttemptEvent>;
    case "stop_requested":
      assertExactDescriptorKeys(
        descriptors,
        ["identity", "reason", "type"],
        "EVENT_INVALID",
        "Attempt stop event",
      );
      return Object.freeze({
        identity,
        type,
        reason: dataValue(descriptors, "reason"),
      }) as Readonly<ExecutorAttemptEvent>;
    case "terminal_verified":
      assertExactDescriptorKeys(
        descriptors,
        ["identity", "outcome", "payloadSha256", "type"],
        "EVENT_INVALID",
        "Attempt terminal event",
      );
      return Object.freeze({
        identity,
        type,
        outcome: dataValue(descriptors, "outcome"),
        payloadSha256: dataValue(descriptors, "payloadSha256"),
      }) as Readonly<ExecutorAttemptEvent>;
    case "disposition_committed":
      assertExactDescriptorKeys(
        descriptors,
        [
          "dispositionId",
          "identity",
          "outcome",
          "terminalPayloadSha256",
          "type",
          "workspaceDisposition",
        ],
        "EVENT_INVALID",
        "Attempt disposition event",
      );
      return Object.freeze({
        dispositionId: dataValue(descriptors, "dispositionId"),
        identity,
        outcome: dataValue(descriptors, "outcome"),
        terminalPayloadSha256: dataValue(descriptors, "terminalPayloadSha256"),
        type,
        workspaceDisposition: dataValue(descriptors, "workspaceDisposition"),
      }) as Readonly<ExecutorAttemptEvent>;
    case "cleanup_finished":
      assertExactDescriptorKeys(
        descriptors,
        ["dispositionId", "identity", "outcome", "type"],
        "EVENT_INVALID",
        "Attempt cleanup event",
      );
      return Object.freeze({
        dispositionId: dataValue(descriptors, "dispositionId"),
        identity,
        outcome: dataValue(descriptors, "outcome"),
        type,
      }) as Readonly<ExecutorAttemptEvent>;
    case "fatal":
      assertExactDescriptorKeys(
        descriptors,
        ["code", "identity", "type"],
        "EVENT_INVALID",
        "Attempt fatal event",
      );
      return Object.freeze({
        code: dataValue(descriptors, "code"),
        identity,
        type,
      }) as Readonly<ExecutorAttemptEvent>;
    default:
      throw reducerError("EVENT_INVALID", "Attempt event type is invalid.");
  }
}

function snapshotIdentity(identityValue: unknown): Readonly<ExecutorAttemptIdentity> {
  const descriptors = readPlainDataDescriptors(
    identityValue,
    "IDENTITY_INVALID",
    "Attempt identity",
  );
  assertExactDescriptorKeys(
    descriptors,
    ["attemptCorrelationId", "capabilityId", "leaseGeneration", "runAttemptId"],
    "IDENTITY_INVALID",
    "Attempt identity",
  );
  const identity = {
    attemptCorrelationId: dataValue(descriptors, "attemptCorrelationId"),
    capabilityId: dataValue(descriptors, "capabilityId"),
    leaseGeneration: dataValue(descriptors, "leaseGeneration"),
    runAttemptId: dataValue(descriptors, "runAttemptId"),
  };
  assertIdentityValues(identity);
  return Object.freeze({
    attemptCorrelationId: identity.attemptCorrelationId as string,
    capabilityId: identity.capabilityId as string,
    leaseGeneration: identity.leaseGeneration as number,
    runAttemptId: identity.runAttemptId as string,
  });
}

function assertState(state: Readonly<ExecutorAttemptState>): void {
  const descriptors = readPlainDataDescriptors(state, "STATE_INVALID", "Attempt state");
  assertExactDescriptorKeys(
    descriptors,
    [
      "cleanup",
      "disposition",
      "fault",
      "identity",
      "launchConfirmed",
      "launchRequested",
      "phase",
      "processTreeZero",
      "stop",
      "terminal",
    ],
    "STATE_INVALID",
    "Attempt state",
  );
  if (!Object.isFrozen(state)) {
    throw reducerError("STATE_INVALID", "Attempt state must be an immutable reducer snapshot.");
  }
  snapshotIdentity(state.identity);
  if (!Object.isFrozen(state.identity)) {
    throw reducerError("STATE_INVALID", "Attempt state identity must be immutable.");
  }
  if (
    typeof state.launchRequested !== "boolean" ||
    typeof state.launchConfirmed !== "boolean" ||
    typeof state.processTreeZero !== "boolean" ||
    (state.launchConfirmed && !state.launchRequested) ||
    ((state.terminal !== null || state.processTreeZero) &&
      !state.launchConfirmed &&
      state.stop === null) ||
    (state.cleanup !== null && state.fault !== null)
  ) {
    throw reducerError("STATE_INVALID", "Attempt state launch or process facts are invalid.");
  }
  assertOptionalRetainedState(state);
  if (derivePhase(state) !== state.phase) {
    throw reducerError("STATE_INVALID", "Attempt phase does not match its retained facts.");
  }
}

function assertOptionalRetainedState(state: Readonly<ExecutorAttemptState>): void {
  if (state.stop !== null) {
    assertFrozenStateRecord(state.stop, ["reason"], "Retained stop evidence");
    assertStopReason(state.stop.reason, "STATE_INVALID");
  }
  if (state.terminal !== null) {
    assertFrozenStateRecord(
      state.terminal,
      ["outcome", "payloadSha256"],
      "Retained terminal evidence",
    );
    assertTerminal(state.terminal.outcome, state.terminal.payloadSha256, "STATE_INVALID");
    if (state.terminal.outcome === "completed" && !state.launchConfirmed) {
      throw reducerError(
        "STATE_INVALID",
        "Successful retained terminal evidence lacks a confirmed launch.",
      );
    }
  }
  if (state.disposition !== null) {
    assertFrozenStateRecord(
      state.disposition,
      ["dispositionId", "outcome", "terminalPayloadSha256", "workspaceDisposition"],
      "Retained disposition",
    );
    assertDisposition(state.disposition, "STATE_INVALID");
    if (
      state.terminal === null ||
      !state.processTreeZero ||
      state.disposition.terminalPayloadSha256 !== state.terminal.payloadSha256
    ) {
      throw reducerError("STATE_INVALID", "Retained disposition lacks settled terminal evidence.");
    }
  }
  if (state.cleanup !== null) {
    assertFrozenStateRecord(state.cleanup, ["dispositionId", "outcome"], "Retained cleanup result");
    assertCleanup(state.cleanup.dispositionId, state.cleanup.outcome, "STATE_INVALID");
    if (
      state.disposition === null ||
      state.cleanup.dispositionId !== state.disposition.dispositionId
    ) {
      throw reducerError("STATE_INVALID", "Retained cleanup does not match its disposition.");
    }
    if (
      (state.disposition.workspaceDisposition === "delete" &&
        state.cleanup.outcome === "retained") ||
      (state.disposition.workspaceDisposition === "retain_for_janitor" &&
        state.cleanup.outcome === "deleted")
    ) {
      throw reducerError("STATE_INVALID", "Retained cleanup contradicts its disposition.");
    }
  }
  if (state.fault !== null) {
    assertFrozenStateRecord(state.fault, ["code"], "Retained fault");
    assertFaultCode(state.fault.code, "STATE_INVALID");
  }
}

function assertEventIdentity(
  expected: Readonly<ExecutorAttemptIdentity>,
  event: Readonly<ExecutorAttemptEvent>,
): void {
  if (event === null || typeof event !== "object") {
    throw reducerError("EVENT_INVALID", "Attempt event must be an object.");
  }
  assertIdentityValues(event.identity);
  if (!sameIdentity(expected, event.identity)) {
    throw reducerError("IDENTITY_MISMATCH", "Attempt event belongs to another identity.");
  }
}

function assertIdentityValues(identity: {
  readonly attemptCorrelationId: unknown;
  readonly capabilityId: unknown;
  readonly leaseGeneration: unknown;
  readonly runAttemptId: unknown;
}): asserts identity is ExecutorAttemptIdentity {
  if (
    typeof identity.attemptCorrelationId !== "string" ||
    !uuidV4Pattern.test(identity.attemptCorrelationId) ||
    typeof identity.capabilityId !== "string" ||
    !nonZeroSha256Pattern.test(identity.capabilityId) ||
    typeof identity.leaseGeneration !== "number" ||
    !Number.isSafeInteger(identity.leaseGeneration) ||
    identity.leaseGeneration < 1 ||
    typeof identity.runAttemptId !== "string" ||
    !entityIdPattern.test(identity.runAttemptId)
  ) {
    throw reducerError("IDENTITY_INVALID", "Attempt identity is structurally invalid.");
  }
}

function assertStopReason(
  value: unknown,
  code: StructuralFactErrorCode = "EVENT_INVALID",
): asserts value is ExecutorAttemptStopReason {
  if (
    value !== "cancelled" &&
    value !== "close" &&
    value !== "drain" &&
    value !== "expired" &&
    value !== "lease_lost" &&
    value !== "process_host_failed" &&
    value !== "shutdown" &&
    value !== "stale_revision"
  ) {
    throw reducerError(code, "Attempt stop reason is invalid.");
  }
}

function assertTerminal(
  outcome: unknown,
  payloadSha256: unknown,
  code: StructuralFactErrorCode = "EVENT_INVALID",
): void {
  if (
    (outcome !== "completed" && outcome !== "failed") ||
    typeof payloadSha256 !== "string" ||
    !sha256Pattern.test(payloadSha256)
  ) {
    throw reducerError(code, "Attempt terminal evidence is invalid.");
  }
}

function assertDisposition(
  value: {
    readonly dispositionId: unknown;
    readonly outcome: unknown;
    readonly terminalPayloadSha256: unknown;
    readonly workspaceDisposition: unknown;
  },
  code: StructuralFactErrorCode = "EVENT_INVALID",
): void {
  if (
    typeof value.dispositionId !== "string" ||
    !nonZeroSha256Pattern.test(value.dispositionId) ||
    (value.outcome !== "committed" &&
      value.outcome !== "retry_scheduled" &&
      value.outcome !== "cancelled" &&
      value.outcome !== "fenced" &&
      value.outcome !== "rejected") ||
    typeof value.terminalPayloadSha256 !== "string" ||
    !sha256Pattern.test(value.terminalPayloadSha256) ||
    (value.workspaceDisposition !== "delete" && value.workspaceDisposition !== "retain_for_janitor")
  ) {
    throw reducerError(code, "Attempt disposition is invalid.");
  }
}

function assertCleanup(
  dispositionId: unknown,
  outcome: unknown,
  code: StructuralFactErrorCode = "EVENT_INVALID",
): void {
  if (
    typeof dispositionId !== "string" ||
    !nonZeroSha256Pattern.test(dispositionId) ||
    (outcome !== "deleted" && outcome !== "retained" && outcome !== "janitor_required")
  ) {
    throw reducerError(code, "Attempt cleanup result is invalid.");
  }
}

function assertFaultCode(value: unknown, code: StructuralFactErrorCode = "EVENT_INVALID"): void {
  if (typeof value !== "string" || !errorCodePattern.test(value)) {
    throw reducerError(code, "Attempt fault code is invalid.");
  }
}

function assertFrozenStateRecord(
  value: unknown,
  expectedKeys: readonly string[],
  description: string,
): void {
  const descriptors = readPlainDataDescriptors(value, "STATE_INVALID", description);
  assertExactDescriptorKeys(descriptors, expectedKeys, "STATE_INVALID", description);
  if (!Object.isFrozen(value)) {
    throw reducerError("STATE_INVALID", `${description} must be immutable.`);
  }
}

function readPlainDataDescriptors(
  value: unknown,
  code: PlainDataErrorCode,
  description: string,
): Readonly<Record<string, PropertyDescriptor>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw reducerError(code, `${description} must be a plain string-keyed data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw reducerError(code, `${description} must contain only enumerable data properties.`);
    }
  }
  return descriptors;
}

function assertExactDescriptorKeys(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  expectedKeys: readonly string[],
  code: PlainDataErrorCode,
  description: string,
): void {
  const actual = Object.keys(descriptors).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length || actual.join("\u0000") !== expected.join("\u0000")) {
    throw reducerError(code, `${description} fields are not exact.`);
  }
}

function dataValue(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
): unknown {
  if (!Object.hasOwn(descriptors, key)) return undefined;
  return descriptors[key]?.value;
}

function sameIdentity(
  left: Readonly<ExecutorAttemptIdentity>,
  right: Readonly<ExecutorAttemptIdentity>,
): boolean {
  return (
    left.attemptCorrelationId === right.attemptCorrelationId &&
    left.capabilityId === right.capabilityId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.runAttemptId === right.runAttemptId
  );
}

function sameDisposition(
  retained: Readonly<ExecutorAttemptDisposition>,
  event: Extract<ExecutorAttemptEvent, { readonly type: "disposition_committed" }>,
): boolean {
  return (
    retained.dispositionId === event.dispositionId &&
    retained.outcome === event.outcome &&
    retained.terminalPayloadSha256 === event.terminalPayloadSha256 &&
    retained.workspaceDisposition === event.workspaceDisposition
  );
}

function reducerError(
  code: ExecutorAttemptReducerError["code"],
  message: string,
): ExecutorAttemptReducerError {
  return new ExecutorAttemptReducerError(code, message);
}
