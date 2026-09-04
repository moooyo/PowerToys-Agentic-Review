export type ServerLifecycleState =
  | "starting"
  | "running"
  | "graceful-stopping"
  | "fail-stopping"
  | "stopped"
  | "hard-exit";

export interface ServerLifecycleApplication {
  close(): Promise<void>;
}

export interface ServerLifecycleStorageRuntime {
  /** Resolves only after storage absence, SQLite close, and owner-lock release are proven. */
  close(): Promise<void>;
}

export interface ServerLifecycleAdmission {
  read(): boolean;
}

export interface ServerLifecycleCoreEffects {
  armHardDeadline(delayMilliseconds: number, callback: () => void): () => void;
  queueTeardown(callback: () => void): void;
  hardExit(exitCode: number): never;
}

export interface ServerLifecycleCoreOptions {
  readonly shutdownTimeoutMilliseconds: number;
  readonly hardExitCode: number;
  readonly effects: ServerLifecycleCoreEffects;
}

const maximumShutdownTimeoutMilliseconds = 10 * 60 * 1_000;

const snapshotClose = <T extends object>(owner: T, name: string): (() => Promise<void>) => {
  const close = Reflect.get(owner, "close") as unknown;
  if (typeof close !== "function") {
    throw new TypeError(`${name} must expose close().`);
  }
  return async () => {
    await (Reflect.apply(close, owner, []) as Promise<void>);
  };
};

const normalizeFailure = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Server lifecycle received a non-Error failure.");

/**
 * Coordinates process-wide admission and shutdown. This internal core accepts effects so excluded
 * testing code can drive deadlines deterministically; production callers use the sealed factory.
 * Direct core construction is a trusted-source architecture boundary enforced by source guards.
 */
export class ServerLifecycleCore {
  readonly #shutdownTimeoutMilliseconds: number;
  readonly #hardExitCode: number;
  readonly #effects: ServerLifecycleCoreEffects;
  readonly #abortController = new AbortController();
  readonly #resourcesReady = Promise.withResolvers<void>();
  readonly #completion = Promise.withResolvers<void>();
  readonly #background = new Set<Promise<void>>();
  #state: ServerLifecycleState = "starting";
  #accepting = false;
  #resourcesSealed = false;
  #applicationClose: (() => Promise<void>) | undefined;
  #storageRuntimeClose: (() => Promise<void>) | undefined;
  #fatalError: Error | undefined;
  #deadlineCancel: (() => void) | undefined;
  #teardownScheduled = false;
  #teardownPromise: Promise<void> | undefined;
  #hardExitRequested = false;

  readonly admission: ServerLifecycleAdmission = Object.freeze({
    read: () => this.#accepting,
  });

  readonly onFatalError = (error: Error): void => {
    this.#requestFailStop(error);
  };

  constructor(options: ServerLifecycleCoreOptions) {
    if (
      !Number.isSafeInteger(options.shutdownTimeoutMilliseconds) ||
      options.shutdownTimeoutMilliseconds < 1 ||
      options.shutdownTimeoutMilliseconds > maximumShutdownTimeoutMilliseconds ||
      !Number.isSafeInteger(options.hardExitCode) ||
      options.hardExitCode < 1 ||
      options.hardExitCode > 255 ||
      typeof options.effects?.armHardDeadline !== "function" ||
      typeof options.effects.queueTeardown !== "function" ||
      typeof options.effects.hardExit !== "function"
    ) {
      throw new TypeError("Server lifecycle options are invalid.");
    }
    this.#shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds;
    this.#hardExitCode = options.hardExitCode;
    const armHardDeadline = options.effects.armHardDeadline;
    const queueTeardown = options.effects.queueTeardown;
    const hardExit = options.effects.hardExit;
    this.#effects = Object.freeze({
      armHardDeadline: (delayMilliseconds: number, callback: () => void) =>
        Reflect.apply(armHardDeadline, undefined, [delayMilliseconds, callback]) as () => void,
      queueTeardown: (callback: () => void) =>
        Reflect.apply(queueTeardown, undefined, [callback]) as undefined,
      hardExit: (exitCode: number) => Reflect.apply(hardExit, undefined, [exitCode]) as never,
    });
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get state(): ServerLifecycleState {
    return this.#state;
  }

  get completion(): Promise<void> {
    return this.#completion.promise;
  }

  adoptApplication(application: ServerLifecycleApplication): void {
    this.#requireAttachable("application");
    if (this.#applicationClose !== undefined) {
      throw new Error("Server lifecycle application was already adopted.");
    }
    this.#applicationClose = snapshotClose(application, "Server lifecycle application");
  }

  adoptStorageRuntime(storageRuntime: ServerLifecycleStorageRuntime): void {
    this.#requireAttachable("storage runtime");
    if (this.#storageRuntimeClose !== undefined) {
      throw new Error("Server lifecycle storage runtime was already adopted.");
    }
    this.#storageRuntimeClose = snapshotClose(storageRuntime, "Server lifecycle storage runtime");
  }

  trackBackground(name: string, completion: Promise<void>): void {
    this.#requireAttachable("background task");
    if (name.length < 1 || name.length > 128 || !(completion instanceof Promise)) {
      throw new TypeError("Server lifecycle background task is invalid.");
    }
    const monitored = completion.then(
      () => undefined,
      (error: unknown) => {
        if (!this.#abortController.signal.aborted) {
          this.#requestFailStop(normalizeFailure(error));
        }
      },
    );
    this.#background.add(monitored);
  }

  markRunning(): void {
    if (this.#resourcesSealed) {
      throw new Error("Server lifecycle resources were already sealed.");
    }
    if (this.#state !== "starting") {
      throw new Error("Server lifecycle cannot become running after shutdown has started.");
    }
    if (this.#applicationClose === undefined || this.#storageRuntimeClose === undefined) {
      throw new Error("Server lifecycle requires application and storage runtime ownership.");
    }
    this.#resourcesSealed = true;
    this.#state = "running";
    this.#accepting = true;
    this.#resourcesReady.resolve();
  }

  sealStartupFailure(error: unknown): void {
    if (this.#resourcesSealed) {
      throw new Error("Server lifecycle startup resources were already sealed.");
    }
    if (this.#state === "stopped" || this.#state === "hard-exit") {
      throw new Error("Server lifecycle cannot seal startup after termination.");
    }
    this.#resourcesSealed = true;
    this.#requestFailStop(normalizeFailure(error));
    this.#resourcesReady.resolve();
  }

  sealStartupShutdown(): void {
    if (this.#resourcesSealed) {
      throw new Error("Server lifecycle startup resources were already sealed.");
    }
    if (this.#state !== "graceful-stopping" && this.#state !== "fail-stopping") {
      throw new Error(
        "Server lifecycle startup shutdown can be sealed only after shutdown starts.",
      );
    }
    this.#resourcesSealed = true;
    this.#resourcesReady.resolve();
  }

  requestGracefulShutdown(reason: string): void {
    const normalizedReason =
      typeof reason === "string" && reason.length > 0 && reason.length <= 128
        ? reason
        : "SERVER_SHUTDOWN";
    this.#beginShutdown("graceful-stopping", new Error(normalizedReason));
  }

  #requestFailStop(error: Error): void {
    this.#fatalError ??= normalizeFailure(error);
    this.#beginShutdown("fail-stopping", this.#fatalError);
  }

  #beginShutdown(requestedState: "graceful-stopping" | "fail-stopping", reason: Error): void {
    if (this.#state === "stopped" || this.#state === "hard-exit") {
      return;
    }
    if (this.#state === "fail-stopping") {
      return;
    }
    if (this.#state === "graceful-stopping") {
      if (requestedState === "fail-stopping") {
        this.#state = "fail-stopping";
      }
      return;
    }

    this.#state = requestedState;
    this.#accepting = false;
    this.#abortController.abort(reason);
    this.#armHardDeadline();
    this.#scheduleTeardown();
  }

  #armHardDeadline(): void {
    if (this.#deadlineCancel !== undefined || this.#hardExitRequested) {
      return;
    }
    try {
      const cancel = this.#effects.armHardDeadline(this.#shutdownTimeoutMilliseconds, () => {
        this.#requestHardExit();
      });
      if (typeof cancel !== "function") {
        this.#requestHardExit();
        return;
      }
      this.#deadlineCancel = cancel;
    } catch {
      this.#requestHardExit();
    }
  }

  #scheduleTeardown(): void {
    if (this.#teardownScheduled || this.#hardExitRequested) {
      return;
    }
    this.#teardownScheduled = true;
    try {
      this.#effects.queueTeardown(() => {
        this.#teardownPromise ??= this.#runTeardown();
        void this.#teardownPromise.catch(() => {
          this.#requestHardExit();
        });
      });
    } catch {
      this.#requestHardExit();
    }
  }

  async #runTeardown(): Promise<void> {
    await this.#resourcesReady.promise;
    if (this.#hardExitRequested) return;

    const applicationClose = this.#applicationClose;
    const storageRuntimeClose = this.#storageRuntimeClose;
    await Promise.all([
      ...(applicationClose === undefined ? [] : [applicationClose()]),
      ...this.#background,
    ]);
    if (this.#hardExitRequested) return;

    if (storageRuntimeClose !== undefined) {
      await storageRuntimeClose();
    }
    if (this.#hardExitRequested) return;

    if (this.#state === "fail-stopping" || this.#fatalError !== undefined) {
      this.#requestHardExit();
      return;
    }

    this.#cancelHardDeadline();
    this.#state = "stopped";
    this.#completion.resolve();
  }

  #requestHardExit(): void {
    if (this.#hardExitRequested) {
      return;
    }
    this.#hardExitRequested = true;
    this.#accepting = false;
    this.#state = "hard-exit";
    this.#cancelHardDeadline();
    this.#effects.hardExit(this.#hardExitCode);
  }

  #cancelHardDeadline(): void {
    const cancel = this.#deadlineCancel;
    this.#deadlineCancel = undefined;
    if (cancel !== undefined) {
      try {
        cancel();
      } catch {
        // A failed timer cancellation cannot make an unsafe shutdown safe.
      }
    }
  }

  #requireAttachable(name: string): void {
    if (this.#resourcesSealed) {
      throw new Error(`Server lifecycle ${name} cannot be adopted after resources are sealed.`);
    }
    if (this.#state === "stopped" || this.#state === "hard-exit") {
      throw new Error(`Server lifecycle ${name} cannot be adopted after termination.`);
    }
  }
}
