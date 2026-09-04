import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import type {
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
  WorkerState,
} from "@agentic-review/contracts";
import {
  type DeepReadonly,
  type DrainedMessage,
  type EstablishedLocalSession,
  establishLocalSession,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  type ReadyMessage,
  validateReadyForEstablishedSession,
} from "@agentic-review/local-protocol";
import { WorkerApiError } from "../server-client/errors.js";
import type {
  ArwxDispatchScope,
  ArwxInboundMessage,
  ArwxInboundMessageHandlerResult,
  ArwxPostDispatchEffect,
} from "../service-host/arwx-stdio-channel.js";
import type { ControlHostControlClient } from "../service-host/host-control-client.js";
import type { ServiceHostRoleRuntimeActivation } from "../service-host/role-entrypoint.js";
import type { RuntimeBootstrapArwxRuntimeOwner } from "../service-host/runtime-bootstrap-handshake.js";
import { HostControlShadowApi } from "./host-control-shadow-api.js";

const executionDisabledReason = "EXECUTION_DISABLED" as const;
const serviceStopReason = "SERVICE_STOP" as const;
const maximumServerOperationMs = 15_000;
const maximumRetryCount = 2;
const retryDelayMs = 1_000;

type ControlActivation = Pick<
  ServiceHostRoleRuntimeActivation<"control", ControlHostControlClient>,
  "activated" | "arwx" | "bootstrap" | "hostControl" | "signal"
>;

type ControlShadowHostLifecycle = Pick<ControlHostControlClient, "armArwxShutdown" | "waitForIdle">;

export interface ControlShadowServerApi {
  register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse>;
  heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse>;
}

export interface ControlShadowSupervisorDependencies {
  readonly architecture?: string;
  readonly nowUnixMs?: () => number;
  readonly operationTimeoutMs?: number;
  readonly randomNonce?: () => string;
  readonly randomUuid?: () => string;
  readonly serverApi?: ControlShadowServerApi;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class ControlShadowSupervisorError extends Error {
  public constructor(
    public readonly code:
      | "CONTROL_SHADOW_ARCHITECTURE_INVALID"
      | "CONTROL_SHADOW_HANDSHAKE_INVALID"
      | "CONTROL_SHADOW_SERVER_INVALID"
      | "CONTROL_SHADOW_SHUTDOWN_INVALID"
      | "CONTROL_SHADOW_TIMEOUT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlShadowSupervisorError";
  }
}

/**
 * Returns an inert owner synchronously and creates the supervisor only after the full role
 * activation resolves. No random identity, API facade, timer, or ARWX write exists before then.
 */
export function installControlZeroSlotShadowSupervisor(
  activation: Readonly<ControlActivation>,
  dependencies: Readonly<ControlShadowSupervisorDependencies> = {},
): RuntimeBootstrapArwxRuntimeOwner {
  const initialized = new Deferred<ControlZeroSlotShadowSupervisor>();
  void activation.activated.then(
    () => {
      if (activation.signal.aborted) {
        initialized.reject(
          shadowError(
            "CONTROL_SHADOW_SHUTDOWN_INVALID",
            "Control shadow activation was revoked before full role activation.",
          ),
        );
        return;
      }
      try {
        const supervisor = new ControlZeroSlotShadowSupervisor(activation, dependencies);
        supervisor.start();
        initialized.resolve(supervisor);
      } catch (error) {
        initialized.reject(error);
      }
    },
    (error: unknown) => initialized.reject(error),
  );
  const done = initialized.promise.then((supervisor) => supervisor.done);
  done.catch(() => undefined);
  const handler: RuntimeBootstrapArwxRuntimeOwner["handler"] = async (message, dispatch, signal) =>
    await (await initialized.promise).handle(message, dispatch, signal);
  return Object.freeze({
    handler,
    done,
    close: async (absoluteDeadline?: number) => {
      const supervisor = await initialized.promise;
      await supervisor.close(absoluteDeadline);
    },
  });
}

class ControlZeroSlotShadowSupervisor {
  public readonly done: Promise<void>;
  readonly #completion = new Deferred<void>();
  readonly #ready = new Deferred<Readonly<ReadyMessage>>();
  readonly #shutdownArmed = new Deferred<void>();
  readonly #postArmSignal = new AbortController().signal;
  readonly #serverCancellation = new AbortController();
  readonly #arwx: ControlActivation["arwx"];
  readonly #bootstrap: ControlActivation["bootstrap"];
  readonly #lifecycleSignal: AbortSignal;
  readonly #hostLifecycle: ControlShadowHostLifecycle;
  readonly #api: ControlShadowServerApi;
  readonly #hello: Readonly<HelloMessage>;
  readonly #workerInstanceId: string;
  readonly #operationTimeoutMs: number;
  readonly #architecture: "x64" | "arm64";
  readonly #nowUnixMs: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #phase:
    | "created"
    | "hello-sent"
    | "acknowledged"
    | "ready"
    | "registered"
    | "closing"
    | "closed"
    | "failed" = "created";
  #session: EstablishedLocalSession | undefined;
  #readyMessage: Readonly<ReadyMessage> | undefined;
  #heartbeatSequence = 0;
  readonly #activeServerOperations = new Set<Promise<unknown>>();
  #healthState: WorkerState = "online";
  #runPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #externalCloseRequested = false;
  #drainedObserved = false;
  #shutdownArmCommitted = false;
  #serviceShutdownRequest:
    | Readonly<{ requestedAtUnixMs: number; shutdownDeadlineUnixMs: number }>
    | undefined;

  public constructor(
    activation: Readonly<ControlActivation>,
    dependencies: Readonly<ControlShadowSupervisorDependencies>,
  ) {
    const roleConfig = activation.bootstrap.roleConfig;
    if (
      activation.bootstrap.bootstrap.role !== "control" ||
      roleConfig.role !== "control" ||
      roleConfig.executionEnabled !== false ||
      roleConfig.maximumSlots !== 1
    ) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control shadow activation is not bound to the zero-execution authority.",
      );
    }
    this.#arwx = activation.arwx;
    this.#bootstrap = activation.bootstrap;
    this.#lifecycleSignal = activation.signal;
    this.#hostLifecycle = Object.freeze({
      armArwxShutdown: activation.hostControl.armArwxShutdown.bind(activation.hostControl),
      waitForIdle: activation.hostControl.waitForIdle.bind(activation.hostControl),
    });
    void activation.hostControl.shutdownRequested.then(
      (request) => {
        this.#serviceShutdownRequest = Object.freeze({
          requestedAtUnixMs: request.requestedAtUnixMs,
          shutdownDeadlineUnixMs: request.shutdownDeadlineUnixMs,
        });
      },
      () => undefined,
    );
    this.#architecture = normalizeArchitecture(dependencies.architecture ?? process.arch);
    this.#api = freezeServerApi(
      dependencies.serverApi ?? createDefaultServerApi(activation.hostControl),
    );
    this.#nowUnixMs = dependencies.nowUnixMs ?? Date.now;
    this.#sleep = dependencies.sleep ?? sleep;
    this.#operationTimeoutMs = boundedOperationTimeout(
      dependencies.operationTimeoutMs ??
        Math.min(maximumServerOperationMs, activation.arwx.configuredCloseTimeoutMs),
    );
    const randomUuidSource = dependencies.randomUuid ?? randomUUID;
    const randomNonceSource = dependencies.randomNonce ?? (() => randomBytes(32).toString("hex"));
    this.#workerInstanceId = `control:${randomUuidSource()}`;
    this.#hello = Object.freeze({
      protocolMajor: activation.bootstrap.bootstrap.arwx.protocolMajor,
      minimumMinor: activation.bootstrap.bootstrap.arwx.minimumMinor,
      maximumMinor: activation.bootstrap.bootstrap.arwx.maximumMinor,
      workerNodeId: activation.bootstrap.bootstrap.workerNodeId,
      workerInstanceId: this.#workerInstanceId,
      executorBootId: null,
      sessionId: randomUuidSource(),
      controlNonce: randomNonceSource(),
      controlManifestSha256: activation.bootstrap.bootstrap.installationManifestSha256,
      controlPreflightSha256: activation.bootstrap.bootstrap.preflightSha256,
    });
    this.done = this.#completion.promise;
    this.done.catch(() => undefined);
  }

  public start(): void {
    if (this.#runPromise !== undefined) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control shadow supervisor can start only once.",
      );
    }
    const onLifecycleAbort = (): void => {
      if (this.#phase === "closing" && this.#shutdownArmCommitted) return;
      this.#fail(
        shadowError(
          "CONTROL_SHADOW_SHUTDOWN_INVALID",
          "Control shadow lifecycle ended before supervisor completion.",
        ),
      );
    };
    this.#lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
    const running = this.#run();
    this.#runPromise = running;
    void this.done.then(
      () => this.#lifecycleSignal.removeEventListener("abort", onLifecycleAbort),
      () => this.#lifecycleSignal.removeEventListener("abort", onLifecycleAbort),
    );
    void running.catch((error: unknown) => this.#fail(error));
  }

  public async handle(
    message: Readonly<ArwxInboundMessage>,
    dispatch: Readonly<ArwxDispatchScope>,
    signal: AbortSignal,
  ): Promise<ArwxInboundMessageHandlerResult> {
    if (signal.aborted || this.#lifecycleSignal.aborted || this.#phase === "failed") {
      throw shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Control shadow dispatcher authority is no longer active.",
      );
    }
    try {
      if (message.messageType === LocalMessageType.HelloAck) {
        await this.#acceptHelloAck(message.payload as unknown as HelloAckMessage);
        return;
      }
      if (message.messageType === LocalMessageType.Ready) {
        this.#acceptReady(message.payload as unknown as ReadyMessage);
        return;
      }
      if (message.messageType === LocalMessageType.Drained) {
        return this.#acceptDrained(message.payload as unknown as DrainedMessage, dispatch);
      }
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control received an ARWX message outside the zero-slot shadow protocol.",
      );
    } catch (error) {
      // The active ARWX dispatch owns the transport failure. Let its rejected handler
      // commit DISPATCH_FAILED instead of racing it with a synthetic ABORTED terminal.
      this.#fail(error, false);
      throw error;
    }
  }

  public close(absoluteDeadline?: number): Promise<void> {
    this.#closePromise ??= this.#close(absoluteDeadline).catch((error: unknown) => {
      this.#fail(error);
      throw error;
    });
    return this.#closePromise;
  }

  async #run(): Promise<void> {
    this.#phase = "hello-sent";
    const runtimeSignal = AbortSignal.any([this.#lifecycleSignal, this.#serverCancellation.signal]);
    try {
      await this.#callBounded(
        () =>
          this.#arwx.send({
            messageType: LocalMessageType.Hello,
            correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
            payload: this.#hello,
          }),
        runtimeSignal,
      );
      const ready = await this.#callBounded(() => this.#ready.promise, runtimeSignal);
      const registration = await this.#registerWithRetry(ready, runtimeSignal);
      if (registration.state === "offline") {
        throw shadowError(
          "CONTROL_SHADOW_SERVER_INVALID",
          "Server kept the Control shadow worker offline after registration.",
        );
      }
      this.#phase = "registered";
      this.#observeServerState(registration.state);
      await this.#heartbeatLoop(registration, runtimeSignal);
    } catch (error) {
      if (
        this.#externalCloseRequested &&
        this.#serverCancellation.signal.aborted &&
        isExpectedCancellation(error, this.#serverCancellation.signal)
      ) {
        return;
      }
      throw error;
    }
  }

  async #acceptHelloAck(helloAck: HelloAckMessage): Promise<void> {
    if (this.#phase !== "hello-sent" || this.#session !== undefined) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control received HelloAck out of order or more than once.",
      );
    }
    const roleConfig = this.#bootstrap.roleConfig;
    let session: EstablishedLocalSession;
    try {
      session = establishLocalSession(this.#hello, helloAck);
    } catch (error) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Executor HelloAck does not match the Control handshake context.",
        error,
      );
    }
    if (
      helloAck.protocolMajor !== this.#hello.protocolMajor ||
      helloAck.protocolMinor < this.#hello.minimumMinor ||
      helloAck.protocolMinor > this.#hello.maximumMinor ||
      helloAck.workerNodeId !== this.#hello.workerNodeId ||
      helloAck.workerInstanceId !== this.#hello.workerInstanceId ||
      helloAck.sessionId !== this.#hello.sessionId ||
      helloAck.controlNonce !== this.#hello.controlNonce ||
      helloAck.executorManifestSha256 !== this.#bootstrap.bootstrap.installationManifestSha256 ||
      helloAck.maximumSlots !== roleConfig.maximumSlots
    ) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Executor HelloAck evidence does not match the committed Control bootstrap.",
      );
    }
    this.#session = session;
    this.#phase = "acknowledged";
  }

  #acceptReady(readyValue: ReadyMessage): void {
    const session = this.#session;
    if (this.#phase !== "acknowledged" || session === undefined) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control received Ready before establishing its local session.",
      );
    }
    const ready = validateControlReady(readyValue, session);
    this.#readyMessage = ready;
    this.#phase = "ready";
    this.#ready.resolve(ready);
  }

  #acceptDrained(
    drained: Readonly<DrainedMessage>,
    dispatch: Readonly<ArwxDispatchScope>,
  ): ArwxPostDispatchEffect {
    if (this.#phase !== "closing" || this.#drainedObserved) {
      throw shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Control received Drained outside its exact shutdown dispatch.",
      );
    }
    const ready = this.#requireReady();
    if (
      drained.protocolMajor !== ready.protocolMajor ||
      drained.protocolMinor !== ready.protocolMinor ||
      drained.workerNodeId !== ready.workerNodeId ||
      drained.workerInstanceId !== ready.workerInstanceId ||
      drained.executorBootId !== ready.executorBootId ||
      drained.sessionId !== ready.sessionId ||
      drained.activeAttemptCount !== 0
    ) {
      throw shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Executor Drained does not match the authenticated Control session.",
      );
    }
    this.#drainedObserved = true;
    const receipt = dispatch.readFinalFrameReceipt();
    return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
      await this.#hostLifecycle.armArwxShutdown(receipt);
      this.#shutdownArmCommitted = true;
      this.#shutdownArmed.resolve(undefined);
    });
  }

  async #heartbeatLoop(
    registration: WorkerRegistrationResponse,
    signal: AbortSignal,
  ): Promise<void> {
    let nextDelayMs = clampHeartbeatDelay(registration.heartbeatIntervalMs);
    let transientFailures = 0;
    let registrationRecoveries = 0;
    while (!signal.aborted) {
      let response: WorkerHeartbeatResponse;
      try {
        response = await this.#callBounded(
          (operationSignal) =>
            this.#api.heartbeat(this.#workerInstanceId, this.#heartbeatRequest(), operationSignal),
          signal,
          true,
        );
        transientFailures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WorkerApiError && error.isWorkerRegistrationLost) {
          if (registrationRecoveries >= maximumRetryCount) {
            throw shadowError(
              "CONTROL_SHADOW_SERVER_INVALID",
              "Control shadow registration recovery limit was exceeded.",
            );
          }
          registrationRecoveries += 1;
          await this.#sleep(retryDelayMs, signal);
          registration = await this.#registerWithRetry(this.#requireReady(), signal);
          if (registration.state === "offline") {
            throw shadowError(
              "CONTROL_SHADOW_SERVER_INVALID",
              "Server rejected Control shadow re-registration.",
            );
          }
          this.#observeServerState(registration.state);
          nextDelayMs = clampHeartbeatDelay(registration.heartbeatIntervalMs);
          continue;
        }
        if (
          error instanceof WorkerApiError &&
          error.isRetryable &&
          transientFailures < maximumRetryCount
        ) {
          transientFailures += 1;
          await this.#sleep(retryDelayMs, signal);
          continue;
        }
        throw error;
      }
      if (response.commands.length !== 0) {
        throw shadowError(
          "CONTROL_SHADOW_SERVER_INVALID",
          "Server returned lease commands to a zero-slot Control shadow.",
        );
      }
      if (response.workerState === "offline") {
        if (registrationRecoveries >= maximumRetryCount) {
          throw shadowError(
            "CONTROL_SHADOW_SERVER_INVALID",
            "Control shadow offline recovery limit was exceeded.",
          );
        }
        registrationRecoveries += 1;
        await this.#sleep(retryDelayMs, signal);
        registration = await this.#registerWithRetry(this.#requireReady(), signal);
        if (registration.state === "offline") {
          throw shadowError(
            "CONTROL_SHADOW_SERVER_INVALID",
            "Server kept the Control shadow offline after re-registration.",
          );
        }
        this.#observeServerState(registration.state);
        nextDelayMs = clampHeartbeatDelay(registration.heartbeatIntervalMs);
        continue;
      }
      this.#observeServerState(response.workerState);
      registrationRecoveries = 0;
      nextDelayMs = clampHeartbeatDelay(response.nextHeartbeatInMs);
      await this.#sleep(nextDelayMs, signal);
    }
  }

  #requireReady(): Readonly<ReadyMessage> {
    if (this.#readyMessage === undefined) {
      throw shadowError(
        "CONTROL_SHADOW_HANDSHAKE_INVALID",
        "Control shadow Ready authority is unavailable.",
      );
    }
    return this.#readyMessage;
  }

  async #registerWithRetry(
    ready: Readonly<ReadyMessage>,
    signal: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    const request = this.#registrationRequest(ready);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maximumRetryCount; attempt += 1) {
      try {
        const response = await this.#callBounded(
          (operationSignal) => this.#api.register(request, operationSignal),
          signal,
          true,
        );
        if (response.protocolVersion !== this.#bootstrap.bootstrap.protocolVersion) {
          throw shadowError(
            "CONTROL_SHADOW_SERVER_INVALID",
            "Server selected an unsupported Control shadow protocol version.",
          );
        }
        return response;
      } catch (error) {
        lastError = error;
        if (
          signal.aborted ||
          !(error instanceof WorkerApiError) ||
          !error.isRetryable ||
          attempt === maximumRetryCount
        ) {
          throw error;
        }
        await this.#sleep(retryDelayMs, signal);
      }
    }
    throw lastError;
  }

  #registrationRequest(ready: Readonly<ReadyMessage>): WorkerRegistrationRequest {
    const bootstrap = this.#bootstrap.bootstrap;
    const roleConfig = this.#bootstrap.roleConfig;
    return Object.freeze({
      protocolVersion: bootstrap.protocolVersion,
      workerNodeId: bootstrap.workerNodeId,
      workerInstanceId: this.#workerInstanceId,
      displayName: bootstrap.workerNodeId,
      workerVersion: bootstrap.releaseId,
      maxSlots: roleConfig.maximumSlots,
      capabilities: Object.freeze({
        operatingSystem: "windows" as const,
        architecture: this.#architecture,
        headless: true,
        interactiveDesktop: false,
        codexVersion: "disabled-zero-execution",
        recipeIds: [],
        labels: {
          "execution-enabled": "false",
          "execution-mode": "zero-slot-shadow",
          "isolation-mode": ready.isolationMode,
          "executor-boot-id": ready.executorBootId,
          "executor-manifest-sha256": ready.executorManifestSha256,
          "executor-preflight-sha256": ready.executorPreflightSha256,
          "node-bundle-sha256": bootstrap.nodeBundleSha256,
          "release-id": bootstrap.releaseId,
        },
      }),
    });
  }

  #heartbeatRequest(): WorkerHeartbeatRequest {
    if (this.#heartbeatSequence >= Number.MAX_SAFE_INTEGER) {
      throw shadowError(
        "CONTROL_SHADOW_SERVER_INVALID",
        "Control shadow heartbeat sequence is exhausted.",
      );
    }
    const observedAtUnixMs = boundedUnixMilliseconds(this.#nowUnixMs());
    const request = Object.freeze({
      protocolVersion: this.#bootstrap.bootstrap.protocolVersion,
      workerNodeId: this.#bootstrap.bootstrap.workerNodeId,
      workerInstanceId: this.#workerInstanceId,
      heartbeatSequence: this.#heartbeatSequence,
      observedAt: new Date(observedAtUnixMs).toISOString(),
      availableSlots: 0,
      activeLeases: [],
      health: Object.freeze({
        state: this.#healthState,
        freeDiskBytes: 0,
        memoryUsageBytes: boundedMemoryUsage(process.memoryUsage().rss),
      }),
    });
    this.#heartbeatSequence += 1;
    return request;
  }

  #observeServerState(state: WorkerState): void {
    if (state === "disabled") this.#healthState = "disabled";
    else if (state === "draining" && this.#healthState === "online") {
      this.#healthState = "draining";
    }
  }

  async #close(absoluteDeadline?: number): Promise<void> {
    const deadline = normalizeAbsoluteDeadline(
      absoluteDeadline,
      this.#arwx.configuredCloseTimeoutMs,
    );
    this.#externalCloseRequested = true;
    this.#serverCancellation.abort();
    let runFailure: { readonly error: unknown } | undefined;
    let ownershipFailure: { readonly error: unknown } | undefined;
    const running = this.#runPromise;
    try {
      if (running !== undefined) {
        await waitBeforeDeadline(() => running, deadline, this.#postArmSignal);
      }
    } catch (error) {
      runFailure = { error };
    }
    try {
      await waitBeforeDeadline(
        () => this.#hostLifecycle.waitForIdle(deadline),
        deadline,
        this.#postArmSignal,
      );
      await this.#waitForServerOperations(deadline);
    } catch (error) {
      ownershipFailure = { error };
    }
    if (runFailure !== undefined || ownershipFailure !== undefined) {
      throw combineShutdownFailures(runFailure, ownershipFailure);
    }
    await this.#shutdownTransport(deadline);
    this.#complete();
  }

  #shutdownTransport(absoluteDeadline: number): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown(absoluteDeadline);
    return this.#shutdownPromise;
  }

  async #shutdown(absoluteDeadline: number): Promise<void> {
    if (this.#phase === "closed") return;
    if (this.#phase !== "ready" && this.#phase !== "registered") {
      throw shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Control cannot drain an unauthenticated shadow session.",
      );
    }
    const ready = this.#requireReady();
    const serviceShutdown = this.#serviceShutdownRequest;
    this.#phase = "closing";
    await waitBeforeDeadline(
      () =>
        this.#arwx.sendFinal(
          {
            messageType: LocalMessageType.Drain,
            correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
            payload: sessionPayload(ready, {
              reasonCode: serviceStopReason,
              requestedAtUnixMs:
                serviceShutdown?.requestedAtUnixMs ?? boundedUnixMilliseconds(this.#nowUnixMs()),
              shutdownDeadlineUnixMs:
                serviceShutdown?.shutdownDeadlineUnixMs ??
                monotonicDeadlineToUnixMilliseconds(absoluteDeadline),
            }),
          },
          absoluteDeadline,
        ),
      absoluteDeadline,
      this.#lifecycleSignal,
    );
    await waitBeforeDeadline(
      () => this.#shutdownArmed.promise,
      absoluteDeadline,
      this.#lifecycleSignal,
    );
    await waitBeforeDeadline(
      () => this.#arwx.drain(absoluteDeadline),
      absoluteDeadline,
      this.#postArmSignal,
    );
    this.#phase = "closed";
  }

  async #callBounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    trackServerOperation = false,
  ): Promise<T> {
    return await callBounded(operation, signal, this.#operationTimeoutMs, (running) => {
      if (!trackServerOperation) return;
      this.#activeServerOperations.add(running);
      void running.then(
        () => this.#activeServerOperations.delete(running),
        () => this.#activeServerOperations.delete(running),
      );
    });
  }

  async #waitForServerOperations(absoluteDeadline: number): Promise<void> {
    while (this.#activeServerOperations.size !== 0) {
      const active = [...this.#activeServerOperations];
      await waitBeforeDeadline(
        () => Promise.allSettled(active).then(() => undefined),
        absoluteDeadline,
        this.#postArmSignal,
      );
    }
  }

  #complete(): void {
    if (this.#phase !== "failed") this.#completion.resolve(undefined);
  }

  #fail(error: unknown, abortArwx = true): void {
    if (this.#phase === "failed" || this.#phase === "closed") return;
    this.#phase = "failed";
    this.#serverCancellation.abort();
    this.#ready.reject(error);
    this.#shutdownArmed.reject(error);
    this.#completion.reject(error);
    if (abortArwx) this.#arwx.abort();
  }
}

function monotonicDeadlineToUnixMilliseconds(absoluteDeadline: number): number {
  const remaining = Math.floor(absoluteDeadline - performance.now());
  if (remaining < 1) {
    throw shadowError(
      "CONTROL_SHADOW_TIMEOUT",
      "Control shadow shutdown deadline expired before Drain publication.",
    );
  }
  return boundedUnixMilliseconds(Date.now() + remaining);
}

function validateControlReady(
  readyValue: Readonly<ReadyMessage>,
  session: EstablishedLocalSession,
): Readonly<ReadyMessage> {
  let ready: Readonly<ReadyMessage>;
  try {
    ready = validateReadyForEstablishedSession(readyValue, session);
  } catch (error) {
    throw shadowError(
      "CONTROL_SHADOW_HANDSHAKE_INVALID",
      "Executor Ready does not match the established local session.",
      error,
    );
  }
  if (
    ready.isolationMode !== "split-service-v1" ||
    ready.ready !== false ||
    ready.availableSlots !== 0 ||
    ready.reasonCode !== executionDisabledReason
  ) {
    throw shadowError(
      "CONTROL_SHADOW_HANDSHAKE_INVALID",
      "Executor Ready does not match the zero-slot local session.",
    );
  }
  return Object.freeze({ ...ready });
}

function createDefaultServerApi(client: ControlHostControlClient): ControlShadowServerApi {
  const api = new HostControlShadowApi(client);
  return Object.freeze({
    register: (request: WorkerRegistrationRequest, signal?: AbortSignal) =>
      api.register(request, signal),
    heartbeat: (workerInstanceId: string, request: WorkerHeartbeatRequest, signal?: AbortSignal) =>
      api.heartbeat(workerInstanceId, request, signal),
  });
}

function freezeServerApi(api: ControlShadowServerApi): ControlShadowServerApi {
  if (
    api === null ||
    typeof api !== "object" ||
    typeof api.register !== "function" ||
    typeof api.heartbeat !== "function"
  ) {
    throw new TypeError("Control shadow server API is invalid.");
  }
  return Object.freeze({
    register: api.register.bind(api),
    heartbeat: api.heartbeat.bind(api),
  });
}

function sessionPayload<T extends Readonly<Record<string, unknown>>>(
  ready: Readonly<ReadyMessage>,
  fields: T,
): DeepReadonly<
  T & {
    protocolMajor: number;
    protocolMinor: number;
    workerNodeId: string;
    workerInstanceId: string;
    executorBootId: string;
    sessionId: string;
  }
> {
  return Object.freeze({
    protocolMajor: ready.protocolMajor,
    protocolMinor: ready.protocolMinor,
    workerNodeId: ready.workerNodeId,
    workerInstanceId: ready.workerInstanceId,
    executorBootId: ready.executorBootId,
    sessionId: ready.sessionId,
    ...fields,
  }) as DeepReadonly<
    T & {
      protocolMajor: number;
      protocolMinor: number;
      workerNodeId: string;
      workerInstanceId: string;
      executorBootId: string;
      sessionId: string;
    }
  >;
}

async function callBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  observeRunning: (running: Promise<T>) => void,
): Promise<T> {
  if (signal.aborted) {
    throw shadowError("CONTROL_SHADOW_SHUTDOWN_INVALID", "Control shadow operation was cancelled.");
  }
  const cancellation = new AbortController();
  const absoluteDeadline = performance.now() + timeoutMs;
  let cancelled = false;
  let timedOut = false;
  let rejectStopped!: (reason?: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const cancel = (): void => {
    cancelled = true;
    cancellation.abort();
    rejectStopped(
      shadowError("CONTROL_SHADOW_SHUTDOWN_INVALID", "Control shadow operation was cancelled."),
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancellation.abort();
      reject(shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow operation timed out."));
    }, timeoutMs);
    timer.unref();
  });
  let running: Promise<T>;
  try {
    running = Promise.resolve(operation(cancellation.signal));
  } catch (error) {
    running = Promise.reject(error);
  }
  observeRunning(running);
  running.catch(() => undefined);
  try {
    let value: T;
    try {
      value = await Promise.race([running, timeout, stopped]);
    } catch (error) {
      if (timedOut) {
        throw shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow operation timed out.");
      }
      if (cancelled || signal.aborted) {
        throw shadowError(
          "CONTROL_SHADOW_SHUTDOWN_INVALID",
          "Control shadow operation was cancelled.",
        );
      }
      throw error;
    }
    if (signal.aborted) {
      throw shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Control shadow operation completed after cancellation.",
      );
    }
    if (performance.now() >= absoluteDeadline) {
      throw shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow operation timed out.");
    }
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

async function waitBeforeDeadline<T>(
  createPromise: () => Promise<T>,
  absoluteDeadline: number,
  signal: AbortSignal,
): Promise<T> {
  const remaining = Math.floor(absoluteDeadline - performance.now());
  if (remaining < 1 || signal.aborted) {
    throw shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow shutdown deadline expired.");
  }
  let timer: NodeJS.Timeout | undefined;
  let rejectStopped!: (reason?: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => undefined);
  const stop = (): void => {
    rejectStopped(
      shadowError(
        "CONTROL_SHADOW_SHUTDOWN_INVALID",
        "Control shadow shutdown authority was revoked.",
      ),
    );
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", stop);
    throw shadowError(
      "CONTROL_SHADOW_SHUTDOWN_INVALID",
      "Control shadow shutdown authority was revoked.",
    );
  }
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow shutdown timed out.")),
      remaining,
    );
    timer.unref();
  });
  try {
    const promise = createPromise();
    const value = await Promise.race([promise, timeout, stopped]);
    if (performance.now() >= absoluteDeadline) {
      throw shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow shutdown deadline expired.");
    }
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clampHeartbeatDelay(value: number): number {
  return Math.max(1_000, Math.min(60_000, value));
}

function normalizeArchitecture(value: string): "x64" | "arm64" {
  if (value === "x64" || value === "arm64") return value;
  throw shadowError(
    "CONTROL_SHADOW_ARCHITECTURE_INVALID",
    "Control shadow requires x64 or arm64 Windows architecture.",
  );
}

function boundedOperationTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumServerOperationMs) {
    throw new RangeError(
      `Control shadow operation timeout must be from 1 through ${maximumServerOperationMs}.`,
    );
  }
  return value;
}

function normalizeAbsoluteDeadline(value: number | undefined, timeoutMs: number): number {
  const deadline = value ?? performance.now() + timeoutMs;
  if (!Number.isFinite(deadline) || deadline <= performance.now()) {
    throw shadowError("CONTROL_SHADOW_TIMEOUT", "Control shadow shutdown deadline is invalid.");
  }
  return deadline;
}

function boundedUnixMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw shadowError(
      "CONTROL_SHADOW_SERVER_INVALID",
      "Control shadow clock returned an invalid timestamp.",
    );
  }
  return value;
}

function boundedMemoryUsage(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function isExpectedCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    error === signal.reason ||
    (error instanceof ControlShadowSupervisorError &&
      error.code === "CONTROL_SHADOW_SHUTDOWN_INVALID")
  );
}

function shadowError(
  code: ControlShadowSupervisorError["code"],
  message: string,
  cause?: unknown,
): ControlShadowSupervisorError {
  return new ControlShadowSupervisorError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function combineShutdownFailures(
  primary: { readonly error: unknown } | undefined,
  cleanup: { readonly error: unknown } | undefined,
): unknown {
  if (primary === undefined) return cleanup?.error;
  if (cleanup === undefined || cleanup.error === primary.error) return primary.error;
  const primaryError = primary.error;
  const cleanupError = cleanup.error;
  if (
    primaryError instanceof ControlShadowSupervisorError &&
    cleanupError instanceof ControlShadowSupervisorError &&
    primaryError.code === cleanupError.code &&
    primaryError.message === cleanupError.message
  ) {
    return primaryError;
  }
  return new AggregateError(
    [primaryError, cleanupError],
    "Control shadow runtime and ownership cleanup both failed.",
  );
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  #settled = false;
  readonly #resolve: (value: T | PromiseLike<T>) => void;
  readonly #reject: (reason?: unknown) => void;

  public constructor() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.promise.catch(() => undefined);
    this.#resolve = resolve;
    this.#reject = reject;
  }

  public resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  public reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}
