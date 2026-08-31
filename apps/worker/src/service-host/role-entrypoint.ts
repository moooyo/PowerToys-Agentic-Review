import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { ArwxStdioChannel } from "./arwx-stdio-channel.js";
import type { HostControlSession } from "./host-control-session.js";
import {
  type HostControlPipeSelector,
  parseServiceHostLaunchContract,
  type ServiceHostLaunchContract,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";

export interface ServiceHostRoleFoundation<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
> {
  readonly launch: Readonly<ServiceHostLaunchContract>;
  readonly hostControl: TSession;
  readonly arwx: ArwxStdioChannel;
  close(): Promise<void>;
}

export interface ServiceHostConnectOptions<TRole extends ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly pipe: HostControlPipeSelector;
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
  const arwx = new ArwxStdioChannel({ localRole: expectedRole, input, output });
  const transportCancellation = new AbortController();
  const cancelConnection = (): void => transportCancellation.abort();
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
  let hostControl: TSession;
  try {
    hostControl = await connect(
      { role: expectedRole, pipe: launch.hostControlPipe },
      transportCancellation.signal,
    );
  } catch (error) {
    arwx.abort();
    throw error;
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
  if (arwx.state === "failed") {
    await hostControl.close().catch(() => undefined);
    throw startupError("ARWX_STDIO_INVALID", "ARWX stream failed during HostControl connection.");
  }
  if (hostControl.role !== expectedRole) {
    arwx.abort();
    await hostControl.close().catch(() => undefined);
    throw startupError("RUNTIME_BOOTSTRAP_UNAVAILABLE", "HostControl role binding is invalid.");
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    launch,
    hostControl,
    arwx,
    close(): Promise<void> {
      closePromise ??= (async () => {
        arwx.abort();
        await hostControl.close();
      })();
      return closePromise;
    },
  });
}

/**
 * Establishes the reviewed transport foundation, then fails closed until RuntimeBootstrapV1 is
 * implemented by ServiceHost. It never falls back to legacy WORKER_* configuration.
 */
export async function runServiceHostRoleEntrypoint<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole> = HostControlSession<TRole>,
>(
  expectedRole: TRole,
  dependencies: ServiceHostRoleEntrypointDependencies<TRole, TSession> = {},
): Promise<never> {
  const foundation = await openServiceHostRoleFoundation(expectedRole, dependencies);
  try {
    throw startupError(
      "RUNTIME_BOOTSTRAP_UNAVAILABLE",
      `ServiceHost ${expectedRole} RuntimeBootstrapV1 is not implemented.`,
    );
  } finally {
    await foundation.close();
  }
}

function startupError(
  code: ServiceHostRoleStartupError["code"],
  message: string,
): ServiceHostRoleStartupError {
  return new ServiceHostRoleStartupError(code, message);
}
