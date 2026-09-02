import { randomBytes, randomUUID } from "node:crypto";
import {
  type ControlProofMessage,
  createHandshakeTranscriptV1,
  type DeepReadonly,
  type DrainedMessage,
  type DrainMessage,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  type ReadyMessage,
  validateLocalMessagePayload,
  validateReadyAfterHandshakeProofV1,
  verifyControlProofMessageV1,
} from "@agentic-review/local-protocol";
import type {
  ArwxDispatchScope,
  ArwxFinalFrameReceipt,
  ArwxInboundMessage,
  ArwxInboundMessageHandlerResult,
  ArwxPostDispatchEffect,
} from "./arwx-stdio-channel.js";
import type { ExecutorHostControlSession } from "./executor-host-control-session.js";
import type { ServiceHostRoleRuntimeActivation } from "./role-entrypoint.js";
import {
  isParsedRuntimeBootstrapForRole,
  type ParsedRuntimeBootstrapV1,
} from "./runtime-bootstrap.js";
import type { RuntimeBootstrapArwxRuntimeOwner } from "./runtime-bootstrap-handshake.js";

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nonceBytes = 32;

type ExecutorShadowPhase =
  | "awaiting_hello"
  | "awaiting_control_proof"
  | "ready_disabled"
  | "draining"
  | "terminal";

export interface ExecutorShadowRuntimeOptions {
  readonly createBootId?: () => string;
  readonly createNonce?: () => Uint8Array;
  readonly nowUnixMs?: () => number;
  readonly nowMonotonicMs?: () => number;
}

export class ExecutorShadowRuntimeError extends Error {
  public constructor(
    public readonly code:
      | "BOOTSTRAP_INVALID"
      | "EXECUTION_DISABLED"
      | "HANDSHAKE_CONTEXT_INVALID"
      | "HANDSHAKE_ORDER_INVALID"
      | "HANDSHAKE_PROOF_INVALID"
      | "RUNTIME_CANCELLED"
      | "RUNTIME_CLOSING"
      | "SESSION_MISMATCH"
      | "SHUTDOWN_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutorShadowRuntimeError";
  }
}

interface NormalizedExecutorShadowRuntimeOptions {
  readonly createBootId: () => string;
  readonly createNonce: () => Uint8Array;
  readonly nowUnixMs: () => number;
  readonly nowMonotonicMs: () => number;
}

/** Installs the authenticated, zero-slot Executor shadow state machine. */
export function installExecutorShadowRuntime(
  activation: Readonly<ServiceHostRoleRuntimeActivation<"executor", ExecutorHostControlSession>>,
  options: ExecutorShadowRuntimeOptions = {},
): RuntimeBootstrapArwxRuntimeOwner {
  let supervisor: ExecutorShadowSupervisor | undefined;
  const initialization = activation.activated.then(() => {
    if (activation.signal.aborted) {
      throw runtimeError(
        "RUNTIME_CANCELLED",
        "Executor shadow activation was revoked before full role activation.",
      );
    }
    const installed = new ExecutorShadowSupervisor(activation, normalizeOptions(options));
    supervisor = installed;
    return installed;
  });
  const done = initialization.then((installed) => installed.done);
  done.catch(() => undefined);
  const handler: RuntimeBootstrapArwxRuntimeOwner["handler"] = async (
    message,
    dispatch,
    signal,
  ) => {
    const installed = supervisor ?? (await initialization);
    return await installed.handle(message, dispatch, signal);
  };
  return Object.freeze({
    handler,
    done,
    close: (absoluteDeadline?: number) => {
      const installed = supervisor;
      return installed === undefined
        ? initialization.then((pending) => pending.close(absoluteDeadline))
        : installed.close(absoluteDeadline);
    },
  });
}

class ExecutorShadowSupervisor {
  public readonly done: Promise<void>;
  readonly #resolveDone: () => void;
  readonly #rejectDone: (error: unknown) => void;
  readonly #bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly #hostControl: ExecutorHostControlSession;
  readonly #arwx: Readonly<
    ServiceHostRoleRuntimeActivation<"executor", ExecutorHostControlSession>
  >["arwx"];
  readonly #lifecycleSignal: AbortSignal;
  readonly #options: NormalizedExecutorShadowRuntimeOptions;
  readonly #executorBootId: string;
  readonly #executorNonce: string;
  #phase: ExecutorShadowPhase = "awaiting_hello";
  #hello: DeepReadonly<HelloMessage> | undefined;
  #helloAck: DeepReadonly<HelloAckMessage> | undefined;
  #closeRequested = false;
  #shutdownDeadline: number | undefined;
  #activeShutdownDeadline: number | undefined;
  #terminalError: ExecutorShadowRuntimeError | undefined;
  #settled = false;

  public constructor(
    activation: Readonly<ServiceHostRoleRuntimeActivation<"executor", ExecutorHostControlSession>>,
    options: NormalizedExecutorShadowRuntimeOptions,
  ) {
    if (
      activation.role !== "executor" ||
      activation.hostControl.role !== "executor" ||
      activation.hostControl.bootstrap !== activation.bootstrap ||
      activation.arwx.localRole !== "executor" ||
      !isParsedRuntimeBootstrapForRole(activation.bootstrap, "executor") ||
      activation.bootstrap.roleConfig.role !== "executor" ||
      activation.bootstrap.roleConfig.executionEnabled !== false ||
      activation.bootstrap.roleConfig.foundationVersion !== 2 ||
      activation.bootstrap.roleConfig.maximumSlots !== 1 ||
      activation.bootstrap.localAuthorityPublicKey === null
    ) {
      throw runtimeError("BOOTSTRAP_INVALID", "Executor shadow bootstrap authority is invalid.");
    }
    if (activation.signal.aborted) {
      throw runtimeError(
        "RUNTIME_CANCELLED",
        "Executor shadow runtime was cancelled before start.",
      );
    }

    this.#bootstrap = activation.bootstrap;
    this.#hostControl = activation.hostControl;
    this.#arwx = activation.arwx;
    this.#lifecycleSignal = activation.signal;
    this.#options = options;
    this.#executorBootId = createExecutorBootId(options.createBootId);
    this.#executorNonce = createExecutorNonce(options.createNonce);

    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    this.done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.done.catch(() => undefined);
    this.#resolveDone = resolveDone;
    this.#rejectDone = rejectDone;
    this.#lifecycleSignal.addEventListener("abort", this.#onLifecycleAbort, { once: true });
  }

  public async handle(
    message: Readonly<ArwxInboundMessage>,
    dispatch: Readonly<ArwxDispatchScope>,
    signal: AbortSignal,
  ): Promise<ArwxInboundMessageHandlerResult> {
    try {
      if (signal.aborted || this.#lifecycleSignal.aborted) {
        throw runtimeError("RUNTIME_CANCELLED", "Executor shadow runtime was cancelled.");
      }
      if (
        this.#closeRequested &&
        !(this.#phase === "ready_disabled" && message.messageType === LocalMessageType.Drain)
      ) {
        throw runtimeError(
          "RUNTIME_CLOSING",
          "Executor shadow runtime does not accept this message while closing.",
        );
      }

      if (this.#phase === "awaiting_hello") {
        return await this.#handleHello(message);
      }
      if (this.#phase === "awaiting_control_proof") {
        return await this.#handleControlProof(message);
      }
      if (this.#phase === "ready_disabled") {
        if (message.messageType !== LocalMessageType.Drain) {
          throw runtimeError(
            "EXECUTION_DISABLED",
            "Executor shadow runtime rejects all non-drain work after authentication.",
          );
        }
        return await this.#handleDrain(message, dispatch);
      }
      throw runtimeError(
        "HANDSHAKE_ORDER_INVALID",
        "Executor shadow runtime received a message after its terminal transition.",
      );
    } catch (error) {
      const failure = normalizeRuntimeFailure(error);
      this.#fail(failure);
      throw failure;
    }
  }

  public close(absoluteDeadline?: number): Promise<void> {
    if (absoluteDeadline !== undefined) {
      if (!Number.isFinite(absoluteDeadline)) {
        throw new TypeError("Executor shadow shutdown deadline must be finite.");
      }
      this.#shutdownDeadline = Math.min(
        this.#shutdownDeadline ?? Number.POSITIVE_INFINITY,
        absoluteDeadline,
      );
      if (
        !this.#settled &&
        this.#activeShutdownDeadline !== undefined &&
        absoluteDeadline < this.#activeShutdownDeadline
      ) {
        const failure = runtimeError(
          "SHUTDOWN_FAILED",
          "Executor shadow shutdown deadline tightened after its final frame started.",
        );
        this.#fail(failure);
        this.#revokeHostControl(absoluteDeadline);
      }
    }
    this.#closeRequested = true;
    return this.done;
  }

  async #handleHello(message: Readonly<ArwxInboundMessage>): Promise<void> {
    if (message.messageType !== LocalMessageType.Hello) {
      throw runtimeError(
        "HANDSHAKE_ORDER_INVALID",
        "Executor shadow runtime requires Hello as its first message.",
      );
    }
    const hello = normalizePayload<HelloMessage>(message);
    const bootstrap = this.#bootstrap.bootstrap;
    if (
      hello.protocolMajor !== bootstrap.arwx.protocolMajor ||
      hello.minimumMinor !== bootstrap.arwx.minimumMinor ||
      hello.maximumMinor !== bootstrap.arwx.maximumMinor ||
      hello.workerNodeId !== bootstrap.workerNodeId ||
      hello.controlManifestSha256 !== bootstrap.installationManifestSha256
    ) {
      throw runtimeError(
        "HANDSHAKE_CONTEXT_INVALID",
        "Control Hello does not match the sealed Executor bootstrap.",
      );
    }

    const helloAck = normalizePayload<HelloAckMessage>({
      messageType: LocalMessageType.HelloAck,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: {
        protocolMajor: bootstrap.arwx.protocolMajor,
        protocolMinor: bootstrap.arwx.minimumMinor,
        workerNodeId: bootstrap.workerNodeId,
        workerInstanceId: hello.workerInstanceId,
        executorBootId: this.#executorBootId,
        sessionId: hello.sessionId,
        controlNonce: hello.controlNonce,
        executorNonce: this.#executorNonce,
        executorManifestSha256: bootstrap.installationManifestSha256,
        executorPolicySha256: this.#bootstrap.roleConfig.executorPolicySha256,
        executorPreflightSha256: bootstrap.preflightSha256,
        maximumSlots: this.#bootstrap.roleConfig.maximumSlots,
      },
    });
    try {
      createHandshakeTranscriptV1(hello, helloAck, this.#bootstrap.roleConfig.localAuthorityKeyId);
    } catch (error) {
      throw runtimeError(
        "HANDSHAKE_CONTEXT_INVALID",
        "Executor HelloAck could not be bound to Control Hello.",
        error,
      );
    }

    this.#hello = hello;
    this.#helloAck = helloAck;
    await this.#arwx.send({
      messageType: LocalMessageType.HelloAck,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: helloAck,
    });
    if (this.#closeRequested) {
      throw runtimeError(
        "RUNTIME_CLOSING",
        "Executor shadow runtime closed before Control proof verification.",
      );
    }
    this.#phase = "awaiting_control_proof";
  }

  async #handleControlProof(message: Readonly<ArwxInboundMessage>): Promise<void> {
    if (message.messageType !== LocalMessageType.ControlProof) {
      throw runtimeError(
        "HANDSHAKE_ORDER_INVALID",
        "Executor shadow runtime requires ControlProof after HelloAck.",
      );
    }
    const hello = required(this.#hello, "Control Hello");
    const helloAck = required(this.#helloAck, "Executor HelloAck");
    const proof = normalizePayload<ControlProofMessage>(message);
    let verified: ReturnType<typeof verifyControlProofMessageV1>;
    try {
      verified = verifyControlProofMessageV1(
        proof,
        required(this.#bootstrap.localAuthorityPublicKey, "pinned Executor public key"),
        {
          expectedKeyId: this.#bootstrap.roleConfig.localAuthorityKeyId,
          expectedHello: hello,
          expectedHelloAck: helloAck,
        },
      );
    } catch (error) {
      throw runtimeError("HANDSHAKE_PROOF_INVALID", "Control handshake proof is invalid.", error);
    }
    if (this.#closeRequested) {
      throw runtimeError(
        "RUNTIME_CLOSING",
        "Executor shadow runtime closed before Ready publication.",
      );
    }

    const readyCandidate: ReadyMessage = {
      protocolMajor: helloAck.protocolMajor,
      protocolMinor: helloAck.protocolMinor,
      workerNodeId: helloAck.workerNodeId,
      workerInstanceId: helloAck.workerInstanceId,
      executorBootId: helloAck.executorBootId,
      sessionId: helloAck.sessionId,
      controlNonce: helloAck.controlNonce,
      executorNonce: helloAck.executorNonce,
      executorManifestSha256: helloAck.executorManifestSha256,
      executorPolicySha256: helloAck.executorPolicySha256,
      executorPreflightSha256: helloAck.executorPreflightSha256,
      isolationMode: "split-service-v1",
      ready: false,
      availableSlots: 0,
      reasonCode: "EXECUTION_DISABLED",
    };
    const ready = validateReadyAfterHandshakeProofV1(readyCandidate, verified);
    await this.#arwx.send({
      messageType: LocalMessageType.Ready,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: ready,
    });
    this.#phase = "ready_disabled";
  }

  async #handleDrain(
    message: Readonly<ArwxInboundMessage>,
    dispatch: Readonly<ArwxDispatchScope>,
  ): Promise<ArwxPostDispatchEffect> {
    const drain = normalizePayload<DrainMessage>(message);
    this.#assertSession(drain);
    this.#phase = "draining";
    const now = this.#options.nowMonotonicMs();
    const deadline = Math.min(
      this.#shutdownDeadline ?? Number.POSITIVE_INFINITY,
      now + this.#arwx.configuredCloseTimeoutMs,
    );
    this.#activeShutdownDeadline = deadline;
    let receipt: ArwxFinalFrameReceipt;
    try {
      receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: {
            protocolMajor: drain.protocolMajor,
            protocolMinor: drain.protocolMinor,
            workerNodeId: drain.workerNodeId,
            workerInstanceId: drain.workerInstanceId,
            executorBootId: drain.executorBootId,
            sessionId: drain.sessionId,
            activeAttemptCount: 0,
            drainedAtUnixMs: readUnixTime(this.#options.nowUnixMs),
          } satisfies DrainedMessage,
        },
        deadline,
      );
    } catch (error) {
      throw (
        this.#terminalError ??
        runtimeError("SHUTDOWN_FAILED", "Executor shadow Drained output failed.", error)
      );
    }
    if (this.#terminalError !== undefined) throw this.#terminalError;
    return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
      try {
        if (this.#terminalError !== undefined) throw this.#terminalError;
        await this.#hostControl.armArwxShutdown(receipt);
        if (this.#terminalError !== undefined) throw this.#terminalError;
        this.#complete();
      } catch (error) {
        const failure =
          this.#terminalError ??
          runtimeError(
            "SHUTDOWN_FAILED",
            "Executor shadow HostControl shutdown arm failed.",
            error,
          );
        this.#fail(failure);
        throw failure;
      }
    });
  }

  #assertSession(message: DeepReadonly<DrainMessage>): void {
    const helloAck = required(this.#helloAck, "Executor HelloAck");
    if (
      message.protocolMajor !== helloAck.protocolMajor ||
      message.protocolMinor !== helloAck.protocolMinor ||
      message.workerNodeId !== helloAck.workerNodeId ||
      message.workerInstanceId !== helloAck.workerInstanceId ||
      message.executorBootId !== helloAck.executorBootId ||
      message.sessionId !== helloAck.sessionId
    ) {
      throw runtimeError("SESSION_MISMATCH", "Executor Drain session identity is invalid.");
    }
  }

  #revokeHostControl(absoluteDeadline: number): void {
    try {
      this.#hostControl.close(absoluteDeadline).catch(() => undefined);
    } catch {
      // The runtime failure is already terminal; foundation cleanup will retry the session close.
    }
  }

  #complete(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#phase = "terminal";
    this.#lifecycleSignal.removeEventListener("abort", this.#onLifecycleAbort);
    this.#resolveDone();
  }

  #fail(error: ExecutorShadowRuntimeError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#phase = "terminal";
    this.#terminalError = error;
    this.#lifecycleSignal.removeEventListener("abort", this.#onLifecycleAbort);
    this.#rejectDone(error);
  }

  readonly #onLifecycleAbort = (): void => {
    this.#fail(runtimeError("RUNTIME_CANCELLED", "Executor shadow runtime was cancelled."));
  };
}

function normalizeOptions(
  options: ExecutorShadowRuntimeOptions,
): NormalizedExecutorShadowRuntimeOptions {
  const createBootId = options.createBootId ?? randomUUID;
  const createNonce = options.createNonce ?? (() => randomBytes(nonceBytes));
  const nowUnixMs = options.nowUnixMs ?? Date.now;
  const nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now());
  if (
    typeof createBootId !== "function" ||
    typeof createNonce !== "function" ||
    typeof nowUnixMs !== "function" ||
    typeof nowMonotonicMs !== "function"
  ) {
    throw new TypeError("Executor shadow runtime options are invalid.");
  }
  return Object.freeze({ createBootId, createNonce, nowUnixMs, nowMonotonicMs });
}

function createExecutorBootId(factory: () => string): string {
  const value = factory();
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw runtimeError("BOOTSTRAP_INVALID", "Executor boot ID source is invalid.");
  }
  return value;
}

function createExecutorNonce(factory: () => Uint8Array): string {
  const value = factory();
  if (!(value instanceof Uint8Array) || value.byteLength !== nonceBytes) {
    throw runtimeError("BOOTSTRAP_INVALID", "Executor nonce source is invalid.");
  }
  const nonce = Buffer.from(value).toString("hex");
  if (/^0{64}$/u.test(nonce)) {
    throw runtimeError("BOOTSTRAP_INVALID", "Executor nonce source returned zero.");
  }
  return nonce;
}

function normalizePayload<T>(value: {
  readonly messageType: Parameters<typeof validateLocalMessagePayload>[0];
  readonly correlationId: string;
  readonly payload: unknown;
}): DeepReadonly<T> {
  return validateLocalMessagePayload(
    value.messageType,
    value.payload,
    value.correlationId,
  ) as unknown as DeepReadonly<T>;
}

function readUnixTime(factory: () => number): number {
  const value = factory();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw runtimeError("SHUTDOWN_FAILED", "Executor shadow clock returned an invalid time.");
  }
  return value;
}

function required<T>(value: T | null | undefined, description: string): T {
  if (value === undefined || value === null) {
    throw runtimeError("BOOTSTRAP_INVALID", `${description} is unavailable.`);
  }
  return value;
}

function normalizeRuntimeFailure(error: unknown): ExecutorShadowRuntimeError {
  return error instanceof ExecutorShadowRuntimeError
    ? error
    : runtimeError("HANDSHAKE_CONTEXT_INVALID", "Executor shadow runtime failed closed.", error);
}

function runtimeError(
  code: ExecutorShadowRuntimeError["code"],
  message: string,
  cause?: unknown,
): ExecutorShadowRuntimeError {
  return new ExecutorShadowRuntimeError(code, message, cause === undefined ? undefined : { cause });
}
