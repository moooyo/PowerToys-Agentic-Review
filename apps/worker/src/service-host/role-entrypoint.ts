import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { ArwxStdioChannel, type ArwxStdioChannelError } from "./arwx-stdio-channel.js";
import type { HostControlSession } from "./host-control-session.js";
import {
  type HostControlPipeSelector,
  parseServiceHostLaunchContract,
  type ServiceHostLaunchContract,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";
import {
  closeRuntimeBootstrapArwxDispatcher,
  createRuntimeBootstrapReadyBoundary,
  isCompletedRuntimeBootstrap,
  observeRuntimeBootstrapArwxDispatcherTerminalReservation,
  prepareRuntimeBootstrapArwxDispatcher,
  type RuntimeBootstrapArwxDispatcherGate,
  type RuntimeBootstrapArwxRuntimeOwner,
  type RuntimeBootstrapPreparation,
  type RuntimeBootstrapReadyBoundary,
  terminateRuntimeBootstrapArwxDispatcher,
} from "./runtime-bootstrap-handshake.js";

export interface ServiceHostRoleFoundation<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
> {
  readonly launch: Readonly<ServiceHostLaunchContract>;
  readonly hostControl: TSession;
  readonly arwx: ArwxStdioChannel;
  readonly done: Promise<Readonly<ServiceHostRoleTerminal>>;
  close(absoluteDeadline?: number): Promise<void>;
}

export type ServiceHostRoleTerminal =
  | {
      readonly source: "external" | "host-control" | "arwx" | "runtime";
      readonly outcome: "fulfilled";
    }
  | {
      readonly source: "host-control" | "arwx" | "runtime";
      readonly outcome: "rejected";
      readonly error: unknown;
    };

export interface ServiceHostConnectOptions<TRole extends ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly pipe: HostControlPipeSelector;
  readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<TRole>;
}

interface ArwxRuntimeOwner {
  readonly arwx: ArwxStdioChannel;
  readonly dispatcherGate: RuntimeBootstrapArwxDispatcherGate;
}

export interface ServiceHostRoleRuntimeActivation<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole>,
> {
  readonly role: TRole;
  readonly launch: Readonly<ServiceHostLaunchContract>;
  readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly hostControl: TSession;
  readonly arwx: ArwxStdioChannel;
  /** Resolves only after the connector result passes the complete role-foundation validation. */
  readonly activated: Promise<void>;
  readonly signal: AbortSignal;
}

export type ServiceHostRoleRuntimeInstaller<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole>,
> = (
  activation: Readonly<ServiceHostRoleRuntimeActivation<TRole, TSession>>,
) => RuntimeBootstrapArwxRuntimeOwner;

export type ServiceHostRoleRuntimeSessionValidator<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole>,
> = (session: HostControlSession<TRole>) => session is TSession;

export type ServiceHostConnector<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
> = (options: ServiceHostConnectOptions<TRole>, signal?: AbortSignal) => Promise<TSession>;

export interface ServiceHostRoleEntrypointDependencies<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
> {
  readonly argumentsList?: readonly string[];
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connect?: ServiceHostConnector<TRole, TSession>;
  readonly installRuntime?: ServiceHostRoleRuntimeInstaller<TRole, TSession>;
  readonly validateRuntimeSession?: ServiceHostRoleRuntimeSessionValidator<TRole, TSession>;
  readonly signal?: AbortSignal;
}

export class ServiceHostRoleStartupError extends Error {
  public constructor(
    public readonly code:
      | "ARWX_STDIO_INVALID"
      | "PRODUCTION_ENVIRONMENT_REQUIRED"
      | "ROLE_RUNTIME_UNAVAILABLE"
      | "ROLE_RUNTIME_SHUTDOWN_TIMEOUT"
      | "RUNTIME_BOOTSTRAP_UNAVAILABLE"
      | "WINDOWS_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "ServiceHostRoleStartupError";
  }
}

/** Opens the two fixed ServiceHost channels without starting any child process or network client. */
export async function openServiceHostRoleFoundation<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
>(
  expectedRole: TRole,
  dependencies: ServiceHostRoleEntrypointDependencies<TRole, TSession> = {},
): Promise<ServiceHostRoleFoundation<TRole, TSession>> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    throw startupError("WINDOWS_REQUIRED", "ServiceHost Worker payload requires Windows.");
  }
  const environment = dependencies.environment ?? process.env;
  if (environment.NODE_ENV !== "production") {
    throw startupError(
      "PRODUCTION_ENVIRONMENT_REQUIRED",
      "ServiceHost Worker payload requires the production replacement environment.",
    );
  }
  const launch = parseServiceHostLaunchContract(
    dependencies.argumentsList ?? process.argv.slice(2),
    expectedRole,
  );
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  if (
    input === output ||
    input.destroyed ||
    input.readableEnded ||
    typeof input.destroy !== "function" ||
    typeof output.write !== "function" ||
    output.destroyed ||
    output.writableEnded
  ) {
    throw startupError(
      "ARWX_STDIO_INVALID",
      "ServiceHost ARWX standard input and output must be distinct binary streams.",
    );
  }

  const connect = dependencies.connect;
  if (connect === undefined) {
    throw startupError(
      "RUNTIME_BOOTSTRAP_UNAVAILABLE",
      "Role-specific HostControl connector is not installed.",
    );
  }
  const transportCancellation = new AbortController();
  const runtimeActivation = new Deferred<void>();
  const cancelConnection = (): void => transportCancellation.abort();
  let hostControl: TSession | undefined;
  let promotedHostControl: HostControlSession<TRole> | undefined;
  let runtimeSessionValidated = false;
  let arwxOwner: ArwxRuntimeOwner | undefined;
  let preparationStarted = false;
  let prepared:
    | {
        readonly arwx: ArwxStdioChannel;
        readonly boundary: RuntimeBootstrapReadyBoundary<TRole>;
        readonly dispatcherGate: RuntimeBootstrapArwxDispatcherGate<TRole>;
        readonly parsed: Readonly<ParsedRuntimeBootstrapV1>;
      }
    | undefined;
  const prepareRuntimeBootstrap: RuntimeBootstrapPreparation<TRole> = (parsed) => {
    if (preparationStarted) {
      throw startupError(
        "RUNTIME_BOOTSTRAP_UNAVAILABLE",
        "RuntimeBootstrapV1 preparation is single-use.",
      );
    }
    preparationStarted = true;
    const closeTimeoutMs =
      parsed.bootstrap.shutdown.gracefulTimeoutMs -
      parsed.bootstrap.shutdown.forceTerminationReserveMs;
    const arwx = new ArwxStdioChannel({
      localRole: expectedRole,
      input,
      output,
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs,
    });
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher(
      expectedRole,
      parsed,
      arwx,
      ({ role, parsed: activatedBootstrap, boundary, promotedOwner, signal }) => {
        if (
          role !== expectedRole ||
          activatedBootstrap !== parsed ||
          boundary !== prepared?.boundary ||
          promotedHostControl !== undefined ||
          !isRoleBoundHostControlSession(promotedOwner, expectedRole, parsed)
        ) {
          throw startupError(
            "RUNTIME_BOOTSTRAP_UNAVAILABLE",
            "Promoted HostControl owner does not match the prepared role runtime.",
          );
        }
        promotedHostControl = promotedOwner;
        const installRuntime = dependencies.installRuntime;
        if (installRuntime === undefined) {
          return createUnavailableRoleRuntime();
        }
        const validateRuntimeSession = dependencies.validateRuntimeSession;
        if (validateRuntimeSession === undefined || !validateRuntimeSession(promotedOwner)) {
          throw startupError(
            "RUNTIME_BOOTSTRAP_UNAVAILABLE",
            "Promoted HostControl owner was not validated for the role runtime.",
          );
        }
        runtimeSessionValidated = true;
        return gateRoleRuntimeActivation(
          installRuntime({
            role: expectedRole,
            launch,
            bootstrap: parsed,
            hostControl: promotedOwner,
            arwx,
            activated: runtimeActivation.promise,
            signal,
          }),
          runtimeActivation.promise,
        );
      },
    );
    arwxOwner = { arwx, dispatcherGate };
    try {
      const boundary = createRuntimeBootstrapReadyBoundary(
        expectedRole,
        parsed,
        arwx,
        dispatcherGate,
      );
      prepared = { arwx, boundary, dispatcherGate, parsed };
      void dispatcherGate.done.then(cancelConnection, cancelConnection);
      return boundary;
    } catch (error) {
      terminateRuntimeBootstrapArwxDispatcher(dispatcherGate);
      arwx.abort();
      throw error;
    }
  };
  const probeInputTermination = (): void => {
    if (input.readableLength === 0) input.read(0);
  };
  input.once("error", cancelConnection);
  input.once("end", cancelConnection);
  input.once("close", cancelConnection);
  input.on("readable", probeInputTermination);
  output.once("error", cancelConnection);
  output.once("finish", cancelConnection);
  output.once("close", cancelConnection);
  if (dependencies.signal?.aborted) transportCancellation.abort();
  else dependencies.signal?.addEventListener("abort", cancelConnection, { once: true });
  probeInputTermination();
  try {
    hostControl = await connect(
      { role: expectedRole, pipe: launch.hostControlPipe, prepareRuntimeBootstrap },
      transportCancellation.signal,
    );
  } catch (error) {
    runtimeActivation.reject(error);
    const cleanupErrors: unknown[] = [];
    const absoluteDeadline =
      performance.now() + (arwxOwner?.arwx.configuredCloseTimeoutMs ?? 15_000);
    let cleanupAbort: ArwxStdioChannelError | undefined;
    if (arwxOwner !== undefined) {
      cleanupAbort = await closeDispatcherRuntime(arwxOwner, cleanupErrors, absoluteDeadline);
    }
    if (promotedHostControl !== undefined) {
      const promoted = promotedHostControl;
      appendShutdownOutcome(
        cleanupErrors,
        await settleBeforeDeadline(
          Promise.resolve().then(() => promoted.close(absoluteDeadline)),
          absoluteDeadline,
        ),
      );
    }
    if (arwxOwner !== undefined) {
      await stopArwx(arwxOwner, cleanupErrors, absoluteDeadline, cleanupAbort);
    }
    throw combinePrimaryAndCleanupErrors(
      error,
      cleanupErrors,
      "ServiceHost role connection and ARWX cleanup both failed.",
    );
  } finally {
    input.removeListener("error", cancelConnection);
    input.removeListener("end", cancelConnection);
    input.removeListener("close", cancelConnection);
    input.removeListener("readable", probeInputTermination);
    output.removeListener("error", cancelConnection);
    output.removeListener("finish", cancelConnection);
    output.removeListener("close", cancelConnection);
    dependencies.signal?.removeEventListener("abort", cancelConnection);
  }
  void hostControl.done.then(undefined, () => undefined);
  const ready = prepared;
  if (
    ready === undefined ||
    ready.arwx.state !== "open" ||
    promotedHostControl === undefined ||
    hostControl !== promotedHostControl ||
    hostControl.bootstrap !== ready.parsed ||
    !isCompletedRuntimeBootstrap({
      role: expectedRole,
      parsed: ready.parsed,
      boundary: ready.boundary,
    }) ||
    transportCancellation.signal.aborted ||
    dependencies.signal?.aborted === true ||
    (dependencies.installRuntime !== undefined && !runtimeSessionValidated)
  ) {
    const primary = startupError(
      "ARWX_STDIO_INVALID",
      "ARWX stream failed during HostControl connection.",
    );
    runtimeActivation.reject(primary);
    throw await rejectOpenedFoundation(primary, hostControl, arwxOwner, promotedHostControl);
  }
  if (hostControl.role !== expectedRole) {
    const primary = startupError(
      "RUNTIME_BOOTSTRAP_UNAVAILABLE",
      "HostControl role binding is invalid.",
    );
    runtimeActivation.reject(primary);
    throw await rejectOpenedFoundation(primary, hostControl, arwxOwner, promotedHostControl);
  }
  runtimeActivation.resolve(undefined);
  const terminalArbiter = createRoleTerminalArbiter();
  let serviceShutdownDeadline: number | undefined;
  observeRuntimeBootstrapArwxDispatcherTerminalReservation(ready.dispatcherGate, (source) =>
    terminalArbiter.reserve(source),
  );
  void ready.dispatcherGate.terminal.then((terminal) => terminalArbiter.settle(terminal));
  void hostControl.done.then(
    () => undefined,
    (error: unknown) =>
      terminalArbiter.settle(Object.freeze({ source: "host-control", outcome: "rejected", error })),
  );
  if (expectedRole === "control") {
    void hostControl.shutdownRequested.then(
      (request) => {
        serviceShutdownDeadline = request.absoluteDeadline;
        terminalArbiter.settle(fulfilledRoleTerminal("external"));
      },
      () => undefined,
    );
  }
  let removeRuntimeCancellation = (): void => undefined;
  const onAbort = (): void => {
    terminalArbiter.settle(fulfilledRoleTerminal("external"));
  };
  if (dependencies.signal?.aborted) {
    onAbort();
  } else {
    dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    removeRuntimeCancellation = () => dependencies.signal?.removeEventListener("abort", onAbort);
  }
  const done = terminalArbiter.done;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    launch,
    hostControl,
    arwx: ready.arwx,
    done,
    close(requestedDeadline?: number): Promise<void> {
      closePromise ??= (async () => {
        removeRuntimeCancellation();
        const cleanupErrors: unknown[] = [];
        if (requestedDeadline !== undefined && !Number.isFinite(requestedDeadline)) {
          throw new TypeError("ServiceHost role shutdown deadline must be finite.");
        }
        const arwxDeadline = Math.min(
          performance.now() + ready.arwx.configuredCloseTimeoutMs,
          requestedDeadline ?? Number.POSITIVE_INFINITY,
          serviceShutdownDeadline ?? Number.POSITIVE_INFINITY,
        );
        const cleanupAbort = await closeDispatcherRuntime(
          { arwx: ready.arwx, dispatcherGate: ready.dispatcherGate },
          cleanupErrors,
          arwxDeadline,
        );
        const drainOutcome = await settleBeforeDeadline(
          Promise.resolve().then(() => hostControl.drain(arwxDeadline)),
          arwxDeadline,
        );
        appendShutdownOutcome(cleanupErrors, drainOutcome);
        if (drainOutcome.kind !== "fulfilled") {
          appendShutdownOutcome(
            cleanupErrors,
            await settleBeforeDeadline(
              Promise.resolve().then(() => hostControl.close(arwxDeadline)),
              arwxDeadline,
            ),
          );
        }
        await stopArwx(
          { arwx: ready.arwx, dispatcherGate: ready.dispatcherGate },
          cleanupErrors,
          arwxDeadline,
          cleanupAbort,
        );
        throwCleanupErrors(cleanupErrors, "ServiceHost role foundation cleanup failed.");
      })();
      return closePromise;
    },
  });
}

/**
 * Establishes the reviewed bootstrap transport, supervises one installed runtime, and joins cleanup.
 * The default runtime remains fail-closed and never falls back to legacy WORKER_* configuration.
 */
export async function runServiceHostRoleEntrypoint<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
>(
  expectedRole: TRole,
  dependencies: ServiceHostRoleEntrypointDependencies<TRole, TSession> = {},
): Promise<void> {
  const foundation = await openServiceHostRoleFoundation(expectedRole, dependencies);
  const terminal = await foundation.done;
  const cleanupErrors: unknown[] = [];
  try {
    await foundation.close();
  } catch (error) {
    appendDistinctError(cleanupErrors, error);
  }
  if (terminal.outcome === "rejected") {
    throw combinePrimaryAndCleanupErrors(
      terminal.error,
      cleanupErrors,
      `ServiceHost ${expectedRole} runtime and cleanup both failed.`,
    );
  }
  throwCleanupErrors(cleanupErrors, `ServiceHost ${expectedRole} cleanup failed.`);
}

async function rejectOpenedFoundation<TRole extends ServiceHostPayloadRole>(
  primary: unknown,
  hostControl: HostControlSession<TRole>,
  arwxOwner: ArwxRuntimeOwner | undefined,
  promotedHostControl: HostControlSession<TRole> | undefined,
): Promise<unknown> {
  const cleanupErrors: unknown[] = [];
  const absoluteDeadline = performance.now() + (arwxOwner?.arwx.configuredCloseTimeoutMs ?? 15_000);
  let cleanupAbort: ArwxStdioChannelError | undefined;
  if (arwxOwner !== undefined) {
    cleanupAbort = await closeDispatcherRuntime(arwxOwner, cleanupErrors, absoluteDeadline);
  }
  const sessions =
    promotedHostControl === undefined || promotedHostControl === hostControl
      ? [hostControl]
      : [promotedHostControl, hostControl];
  for (const session of sessions) {
    appendShutdownOutcome(
      cleanupErrors,
      await settleBeforeDeadline(
        Promise.resolve().then(() => session.close(absoluteDeadline)),
        absoluteDeadline,
      ),
    );
  }
  if (arwxOwner !== undefined) {
    await stopArwx(arwxOwner, cleanupErrors, absoluteDeadline, cleanupAbort);
  }
  return combinePrimaryAndCleanupErrors(
    primary,
    cleanupErrors,
    "ServiceHost startup validation and cleanup both failed.",
  );
}

async function stopArwx(
  owner: ArwxRuntimeOwner,
  cleanupErrors: unknown[],
  absoluteDeadline = performance.now() + owner.arwx.configuredCloseTimeoutMs,
  cleanupAbort?: ArwxStdioChannelError,
): Promise<void> {
  const { arwx, dispatcherGate } = owner;
  terminateRuntimeBootstrapArwxDispatcher(dispatcherGate);
  let ownedAbort = cleanupAbort;
  if (arwx.state === "open") {
    ownedAbort = arwx.abort();
  } else {
    const drainOutcome = await settleBeforeDeadline(arwx.drain(absoluteDeadline), absoluteDeadline);
    if (
      !(
        ownedAbort !== undefined &&
        drainOutcome.kind === "rejected" &&
        drainOutcome.error === ownedAbort
      )
    ) {
      appendShutdownOutcome(cleanupErrors, drainOutcome);
    }
  }
  const [dispatcherOutcome, runtimeOutcome, quiescenceOutcome] = await Promise.all([
    settleBeforeDeadline(dispatcherGate.done, absoluteDeadline),
    settleBeforeDeadline(dispatcherGate.runtimeDone, absoluteDeadline),
    settleBeforeDeadline(dispatcherGate.quiesced, absoluteDeadline),
  ]);
  if (dispatcherOutcome.kind === "timeout") {
    appendRuntimeShutdownTimeout(cleanupErrors);
  } else if (dispatcherOutcome.kind === "rejected") {
    const { error } = dispatcherOutcome;
    if (!(ownedAbort !== undefined && error === ownedAbort)) {
      appendDistinctError(cleanupErrors, error);
    }
  }
  appendShutdownOutcome(cleanupErrors, runtimeOutcome);
  appendShutdownOutcome(cleanupErrors, quiescenceOutcome);
}

async function closeDispatcherRuntime(
  owner: ArwxRuntimeOwner,
  cleanupErrors: unknown[],
  absoluteDeadline: number,
): Promise<ArwxStdioChannelError | undefined> {
  const outcome = await settleBeforeDeadline(
    closeRuntimeBootstrapArwxDispatcher(owner.dispatcherGate, absoluteDeadline),
    absoluteDeadline,
  );
  appendRuntimeCloseOutcome(cleanupErrors, outcome);
  terminateRuntimeBootstrapArwxDispatcher(owner.dispatcherGate);
  return outcome.kind === "fulfilled" ? undefined : owner.arwx.abort();
}

function appendShutdownOutcome(
  cleanupErrors: unknown[],
  outcome:
    | { readonly kind: "fulfilled" }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "timeout" },
): void {
  if (outcome.kind === "timeout") appendRuntimeShutdownTimeout(cleanupErrors);
  else if (outcome.kind === "rejected") appendDistinctError(cleanupErrors, outcome.error);
}

function appendRuntimeCloseOutcome(
  cleanupErrors: unknown[],
  outcome:
    | { readonly kind: "fulfilled" }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "timeout" },
): void {
  if (outcome.kind === "timeout") {
    appendRuntimeShutdownTimeout(cleanupErrors);
  } else if (outcome.kind === "rejected") {
    appendDistinctError(cleanupErrors, outcome.error);
  }
}

function appendRuntimeShutdownTimeout(cleanupErrors: unknown[]): void {
  if (
    cleanupErrors.some(
      (error) =>
        error instanceof ServiceHostRoleStartupError &&
        error.code === "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
    )
  ) {
    return;
  }
  cleanupErrors.push(
    startupError(
      "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
      "ServiceHost role components did not quiesce before the graceful shutdown deadline.",
    ),
  );
}

async function settleBeforeDeadline(
  promise: Promise<void>,
  absoluteDeadline: number,
): Promise<
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "timeout" }
> {
  const observed = promise.then(
    () => ({ kind: "fulfilled" }) as const,
    (error: unknown) => ({ kind: "rejected", error }) as const,
  );
  const immediate = await Promise.race([
    observed,
    new Promise<{ readonly kind: "pending" }>((resolve) => {
      queueMicrotask(() => resolve({ kind: "pending" }));
    }),
  ]);
  if (immediate.kind !== "pending") {
    return immediate.kind === "fulfilled" && performance.now() >= absoluteDeadline
      ? { kind: "timeout" }
      : immediate;
  }
  const remaining = Math.floor(absoluteDeadline - performance.now());
  if (remaining < 1) return { kind: "timeout" };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
  });
  try {
    const outcome = await Promise.race([observed, timeout]);
    return outcome.kind === "fulfilled" && performance.now() >= absoluteDeadline
      ? { kind: "timeout" }
      : outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createRoleTerminalArbiter(): Readonly<{
  readonly done: Promise<Readonly<ServiceHostRoleTerminal>>;
  reserve(source: ServiceHostRoleTerminal["source"]): boolean;
  settle(terminal: Readonly<ServiceHostRoleTerminal>): boolean;
}> {
  const terminal = new Deferred<Readonly<ServiceHostRoleTerminal>>();
  let winner: ServiceHostRoleTerminal["source"] | undefined;
  let settled = false;
  const reserve = (source: ServiceHostRoleTerminal["source"]): boolean => {
    winner ??= source;
    return winner === source;
  };
  return Object.freeze({
    done: terminal.promise,
    reserve,
    settle(outcome: Readonly<ServiceHostRoleTerminal>): boolean {
      if (!reserve(outcome.source) || settled) return false;
      settled = true;
      terminal.resolve(outcome);
      return true;
    },
  });
}

function fulfilledRoleTerminal(
  source: ServiceHostRoleTerminal["source"],
): Readonly<ServiceHostRoleTerminal> {
  return Object.freeze({ source, outcome: "fulfilled" });
}

function combinePrimaryAndCleanupErrors(
  primary: unknown,
  cleanupErrors: readonly unknown[],
  message: string,
): unknown {
  const errors = [primary];
  for (const error of cleanupErrors) {
    if (error instanceof AggregateError && error.errors.length > 0) {
      for (const nested of error.errors) appendDistinctError(errors, nested);
    } else {
      appendDistinctError(errors, error);
    }
  }
  return errors.length === 1 ? primary : new AggregateError(errors, message, { cause: primary });
}

function appendDistinctError(errors: unknown[], error: unknown): void {
  if (!errors.includes(error)) errors.push(error);
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function createUnavailableRoleRuntime(): RuntimeBootstrapArwxRuntimeOwner {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    handler: () => {
      throw startupError(
        "ROLE_RUNTIME_UNAVAILABLE",
        "ARWX business messages are unavailable until the role runtime is installed.",
      );
    },
    done,
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(resolveDone);
      return closePromise;
    },
  });
}

function gateRoleRuntimeActivation(
  runtime: RuntimeBootstrapArwxRuntimeOwner,
  activated: Promise<void>,
): RuntimeBootstrapArwxRuntimeOwner {
  if (!isSynchronousRoleRuntimeOwner(runtime)) return runtime;
  const handler = runtime.handler;
  const done = runtime.done;
  const close = runtime.close;
  done.catch(() => undefined);
  const gatedDone = activated.then(() => done);
  gatedDone.catch(() => undefined);
  const guardedHandler: RuntimeBootstrapArwxRuntimeOwner["handler"] = async (
    message,
    dispatch,
    signal,
  ) => {
    await activated;
    return await handler.call(runtime, message, dispatch, signal);
  };
  return Object.freeze({
    handler: guardedHandler,
    done: gatedDone,
    close: (absoluteDeadline?: number) => close.call(runtime, absoluteDeadline),
  });
}

function isSynchronousRoleRuntimeOwner(value: unknown): value is RuntimeBootstrapArwxRuntimeOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const candidate = value as RuntimeBootstrapArwxRuntimeOwner & {
      readonly then?: unknown;
    };
    return (
      typeof candidate.then !== "function" &&
      typeof candidate.handler === "function" &&
      candidate.done instanceof Promise &&
      typeof candidate.close === "function"
    );
  } catch {
    return false;
  }
}

function isRoleBoundHostControlSession<TRole extends ServiceHostPayloadRole>(
  value: unknown,
  role: TRole,
  bootstrap: Readonly<ParsedRuntimeBootstrapV1>,
): value is HostControlSession<TRole> {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<HostControlSession<ServiceHostPayloadRole>>;
  return (
    candidate.role === role &&
    candidate.bootstrap === bootstrap &&
    candidate.done instanceof Promise &&
    candidate.shutdownRequested instanceof Promise &&
    typeof candidate.armArwxShutdown === "function" &&
    typeof candidate.drain === "function" &&
    typeof candidate.close === "function"
  );
}

function startupError(
  code: ServiceHostRoleStartupError["code"],
  message: string,
): ServiceHostRoleStartupError {
  return new ServiceHostRoleStartupError(code, message);
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
