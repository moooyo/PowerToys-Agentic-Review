import process from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  type ArwxBootstrapReceiveLoop,
  ArwxStdioChannel,
  ArwxStdioChannelError,
} from "./arwx-stdio-channel.js";
import type { HostControlSession } from "./host-control-session.js";
import {
  type HostControlPipeSelector,
  parseServiceHostLaunchContract,
  type ServiceHostLaunchContract,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";
import {
  createRuntimeBootstrapReadyBoundary,
  isCompletedRuntimeBootstrap,
  type RuntimeBootstrapPreparation,
  type RuntimeBootstrapReadyBoundary,
} from "./runtime-bootstrap-handshake.js";

export interface ServiceHostRoleFoundation<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
> {
  readonly launch: Readonly<ServiceHostLaunchContract>;
  readonly hostControl: TSession;
  readonly arwx: ArwxStdioChannel;
  readonly done: Promise<void>;
  close(): Promise<void>;
}

export interface ServiceHostConnectOptions<TRole extends ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly pipe: HostControlPipeSelector;
  readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<TRole>;
}

interface ArwxRuntimeOwner {
  readonly arwx: ArwxStdioChannel;
  readonly receiveLoop: Readonly<ArwxBootstrapReceiveLoop>;
}

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
  readonly signal?: AbortSignal;
}

export class ServiceHostRoleStartupError extends Error {
  public constructor(
    public readonly code:
      | "ARWX_STDIO_INVALID"
      | "PRODUCTION_ENVIRONMENT_REQUIRED"
      | "ROLE_RUNTIME_UNAVAILABLE"
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
  const cancelConnection = (): void => transportCancellation.abort();
  let hostControl: TSession | undefined;
  let arwxOwner: ArwxRuntimeOwner | undefined;
  let preparationStarted = false;
  let prepared:
    | {
        readonly arwx: ArwxStdioChannel;
        readonly boundary: RuntimeBootstrapReadyBoundary<TRole>;
        readonly parsed: Readonly<ParsedRuntimeBootstrapV1>;
        readonly receiveLoop: Readonly<ArwxBootstrapReceiveLoop>;
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
    const receiveLoop = arwx.startRuntimeBootstrapReceiveLoop(() => {
      throw startupError(
        "ROLE_RUNTIME_UNAVAILABLE",
        "ARWX business messages are unavailable until the role runtime is installed.",
      );
    });
    arwxOwner = { arwx, receiveLoop };
    const boundary = createRuntimeBootstrapReadyBoundary(
      expectedRole,
      parsed,
      arwx,
      receiveLoop.token,
    );
    prepared = { arwx, boundary, parsed, receiveLoop };
    void receiveLoop.done.then(cancelConnection, cancelConnection);
    return boundary;
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
    const cleanupErrors: unknown[] = [];
    if (arwxOwner !== undefined) {
      await stopArwx(arwxOwner.arwx, arwxOwner.receiveLoop.done, cleanupErrors);
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
    ready.arwx.state === "failed" ||
    hostControl.bootstrap !== ready.parsed ||
    !isCompletedRuntimeBootstrap({
      role: expectedRole,
      parsed: ready.parsed,
      boundary: ready.boundary,
    })
  ) {
    const primary = startupError(
      "ARWX_STDIO_INVALID",
      "ARWX stream failed during HostControl connection.",
    );
    throw await rejectOpenedFoundation(primary, hostControl, arwxOwner);
  }
  if (hostControl.role !== expectedRole) {
    const primary = startupError(
      "RUNTIME_BOOTSTRAP_UNAVAILABLE",
      "HostControl role binding is invalid.",
    );
    throw await rejectOpenedFoundation(primary, hostControl, arwxOwner);
  }
  let removeRuntimeCancellation = (): void => undefined;
  const runtimeCancellation = new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    if (dependencies.signal?.aborted) {
      resolve();
      return;
    }
    dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    removeRuntimeCancellation = () => dependencies.signal?.removeEventListener("abort", onAbort);
  });
  const done = Promise.race([hostControl.done, ready.receiveLoop.done, runtimeCancellation]);
  void done.then(undefined, () => undefined);
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    launch,
    hostControl,
    arwx: ready.arwx,
    done,
    close(): Promise<void> {
      closePromise ??= (async () => {
        removeRuntimeCancellation();
        const cleanupErrors: unknown[] = [];
        try {
          await hostControl.drain();
        } catch (error) {
          appendDistinctError(cleanupErrors, error);
          try {
            await hostControl.close();
          } catch (closeError) {
            appendDistinctError(cleanupErrors, closeError);
          }
        }
        await stopArwx(ready.arwx, ready.receiveLoop.done, cleanupErrors);
        throwCleanupErrors(cleanupErrors, "ServiceHost role foundation cleanup failed.");
      })();
      return closePromise;
    },
  });
}

/**
 * Establishes the reviewed bootstrap transport, then fails closed until the business role runtime
 * is implemented. It never falls back to legacy WORKER_* configuration or emits ARWX Ready.
 */
export async function runServiceHostRoleEntrypoint<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
>(
  expectedRole: TRole,
  dependencies: ServiceHostRoleEntrypointDependencies<TRole, TSession> = {},
): Promise<never> {
  const foundation = await openServiceHostRoleFoundation(expectedRole, dependencies);
  let primaryError: unknown;
  try {
    await foundation.done;
    primaryError = startupError(
      "ROLE_RUNTIME_UNAVAILABLE",
      `ServiceHost ${expectedRole} foundation stopped without a business runtime.`,
    );
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await foundation.close();
  } catch (error) {
    appendDistinctError(cleanupErrors, error);
  }
  throw combinePrimaryAndCleanupErrors(
    primaryError,
    cleanupErrors,
    `ServiceHost ${expectedRole} runtime and cleanup both failed.`,
  );
}

async function rejectOpenedFoundation<TRole extends ServiceHostPayloadRole>(
  primary: unknown,
  hostControl: HostControlSession<TRole>,
  arwxOwner: ArwxRuntimeOwner | undefined,
): Promise<unknown> {
  const cleanupErrors: unknown[] = [];
  try {
    await hostControl.close();
  } catch (error) {
    appendDistinctError(cleanupErrors, error);
  }
  if (arwxOwner !== undefined) {
    await stopArwx(arwxOwner.arwx, arwxOwner.receiveLoop.done, cleanupErrors);
  }
  return combinePrimaryAndCleanupErrors(
    primary,
    cleanupErrors,
    "ServiceHost startup validation and cleanup both failed.",
  );
}

async function stopArwx(
  arwx: ArwxStdioChannel,
  receiveLoopDone: Promise<void>,
  cleanupErrors: unknown[],
): Promise<void> {
  arwx.abort();
  try {
    await receiveLoopDone;
  } catch (error) {
    if (error instanceof ArwxStdioChannelError && error.code === "ABORTED") {
      return;
    }
    appendDistinctError(cleanupErrors, error);
  }
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

function startupError(
  code: ServiceHostRoleStartupError["code"],
  message: string,
): ServiceHostRoleStartupError {
  return new ServiceHostRoleStartupError(code, message);
}
