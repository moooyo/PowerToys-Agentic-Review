import { ServerLifecycleCore, type ServerLifecycleCoreEffects } from "./server-lifecycle-core.js";

export interface ProductionServerLifecycleOptions {
  readonly shutdownTimeoutMilliseconds: number;
}

export interface ServerLifecycleAdmission {
  read(): boolean;
}

export interface ServerLifecycleApplication {
  close(): Promise<void>;
}

export interface ServerLifecycleStorageRuntime {
  close(): Promise<void>;
}

export interface ServerLifecycle {
  readonly signal: AbortSignal;
  readonly admission: ServerLifecycleAdmission;
  readonly completion: Promise<void>;
  readonly onFatalError: (error: Error) => void;
  adoptApplication(application: ServerLifecycleApplication): void;
  adoptStorageRuntime(storageRuntime: ServerLifecycleStorageRuntime): void;
  trackBackground(name: string, completion: Promise<void>): void;
  markRunning(): void;
  sealStartupFailure(error: unknown): void;
  sealStartupShutdown(): void;
  requestGracefulShutdown(reason: string): void;
}

const productionHardExitCode = 1;
const capturedProcessExit = process.exit.bind(process);
const capturedSetTimeout = globalThis.setTimeout.bind(globalThis);
const capturedClearTimeout = globalThis.clearTimeout.bind(globalThis);
const capturedQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

const productionEffects: ServerLifecycleCoreEffects = Object.freeze({
  armHardDeadline: (delayMilliseconds: number, callback: () => void) => {
    const timer = capturedSetTimeout(callback, delayMilliseconds);
    timer.ref();
    return () => capturedClearTimeout(timer);
  },
  queueTeardown: (callback: () => void) => capturedQueueMicrotask(callback),
  hardExit: (exitCode: number): never => capturedProcessExit(exitCode),
});

/**
 * Creates the only production lifecycle profile. Runtime configuration cannot replace effects.
 * The internal core constructor is protected by trusted-source architecture guards.
 */
export const createProductionServerLifecycle = (
  options: ProductionServerLifecycleOptions,
): ServerLifecycle => {
  const core = new ServerLifecycleCore({
    shutdownTimeoutMilliseconds: options.shutdownTimeoutMilliseconds,
    hardExitCode: productionHardExitCode,
    effects: productionEffects,
  });
  return Object.freeze({
    signal: core.signal,
    admission: core.admission,
    completion: core.completion,
    onFatalError: core.onFatalError,
    adoptApplication: (application: ServerLifecycleApplication) =>
      core.adoptApplication(application),
    adoptStorageRuntime: (storageRuntime: ServerLifecycleStorageRuntime) =>
      core.adoptStorageRuntime(storageRuntime),
    trackBackground: (name: string, completion: Promise<void>) =>
      core.trackBackground(name, completion),
    markRunning: () => core.markRunning(),
    sealStartupFailure: (error: unknown) => core.sealStartupFailure(error),
    sealStartupShutdown: () => core.sealStartupShutdown(),
    requestGracefulShutdown: (reason: string) => core.requestGracefulShutdown(reason),
  });
};
