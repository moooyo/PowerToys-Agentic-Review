import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const maximumPendingOperations = 1_024;
const maximumAdmissionMilliseconds = 600_000;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const promiseThen = Promise.prototype.then;

export type ArtifactMutationGateErrorCode =
  | "ARTIFACT_MUTATION_GATE_BUSY"
  | "ARTIFACT_MUTATION_GATE_CANCELLED"
  | "ARTIFACT_MUTATION_GATE_CLOSED"
  | "ARTIFACT_MUTATION_GATE_INVALID_REQUEST"
  | "ARTIFACT_MUTATION_GATE_POISONED"
  | "ARTIFACT_MUTATION_GATE_REENTRANT"
  | "ARTIFACT_MUTATION_GATE_TIMEOUT";

const definitions: Readonly<
  Record<ArtifactMutationGateErrorCode, { readonly message: string; readonly retryable: boolean }>
> = Object.freeze({
  ARTIFACT_MUTATION_GATE_BUSY: {
    message: "Artifact mutation admission capacity is exhausted.",
    retryable: true,
  },
  ARTIFACT_MUTATION_GATE_CANCELLED: {
    message: "Artifact mutation admission was cancelled before execution.",
    retryable: false,
  },
  ARTIFACT_MUTATION_GATE_CLOSED: {
    message: "Artifact mutation admission is closed.",
    retryable: false,
  },
  ARTIFACT_MUTATION_GATE_INVALID_REQUEST: {
    message: "Artifact mutation admission input is invalid.",
    retryable: false,
  },
  ARTIFACT_MUTATION_GATE_POISONED: {
    message: "Artifact mutation admission is poisoned by an uncertain outcome.",
    retryable: false,
  },
  ARTIFACT_MUTATION_GATE_REENTRANT: {
    message: "Artifact mutation admission cannot reenter the same gate.",
    retryable: false,
  },
  ARTIFACT_MUTATION_GATE_TIMEOUT: {
    message: "Artifact mutation admission expired before execution.",
    retryable: true,
  },
});

export class ArtifactMutationGateError extends Error {
  readonly code: ArtifactMutationGateErrorCode;
  readonly retryable: boolean;
  readonly callbackStarted = false;

  constructor(code: ArtifactMutationGateErrorCode, options?: ErrorOptions) {
    const definition = definitions[code];
    super(definition.message, options);
    this.name = "ArtifactMutationGateError";
    this.code = code;
    this.retryable = definition.retryable;
  }
}

export interface ArtifactMutationGateOptions {
  /** Bounds all accepted active and queued callbacks. */
  readonly maximumPendingOperations: number;
}

export interface ArtifactMutationGateRunOptions {
  /** Absolute latest callback start time in the performance.now() monotonic clock domain. */
  readonly deadline: number;
  /** Cancellation is observed only while the callback is queued. */
  readonly signal?: AbortSignal;
}

type GateState = "open" | "closing" | "closed" | "poisoned";
type TaskPhase = "queued" | "active" | "settled";

interface Task {
  readonly operation: () => Promise<unknown> | unknown;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer: NodeJS.Timeout | undefined;
  abortListener: (() => void) | undefined;
  phase: TaskPhase;
}

const gateError = (
  code: ArtifactMutationGateErrorCode,
  cause?: unknown,
): ArtifactMutationGateError =>
  new ArtifactMutationGateError(code, cause === undefined ? undefined : { cause });

const readAborted = (signal: AbortSignal): boolean => {
  if (abortedGetter === undefined) {
    throw new TypeError("Artifact mutation cancellation signal is unavailable.");
  }
  return Reflect.apply(abortedGetter, signal, []) as boolean;
};

const isAborted = (signal: AbortSignal | undefined): boolean => {
  if (signal === undefined) {
    return false;
  }
  try {
    return readAborted(signal);
  } catch {
    return true;
  }
};

const snapshotSignal = (value: unknown): AbortSignal | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("Artifact mutation cancellation signal is invalid.");
  }
  readAborted(value);
  return value;
};

const requireDeadline = (value: unknown, now: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value - now > maximumAdmissionMilliseconds
  ) {
    throw new TypeError("Artifact mutation admission deadline is invalid or too distant.");
  }
  return value;
};

const requireCapacity = (value: unknown): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximumPendingOperations
  ) {
    throw new TypeError("Artifact mutation pending capacity must be a positive bounded integer.");
  }
  return value as number;
};

/**
 * Serializes Server-side artifact authority transactions. A deadline or AbortSignal can prevent a
 * queued callback from starting, but neither can cancel a callback after its execution begins.
 */
export class ArtifactMutationGate {
  readonly #maximumPendingOperations: number;
  readonly #executionContext = new AsyncLocalStorage<object>();
  readonly #executionIdentity = Object.freeze(Object.create(null)) as object;
  readonly #queue: Task[] = [];
  #state: GateState = "open";
  #active: Task | undefined;
  #acceptedOperations = 0;
  #admissionReservations = 0;
  #drainScheduled = false;
  #poisonError: ArtifactMutationGateError | undefined;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(options: ArtifactMutationGateOptions) {
    const capacity = options?.maximumPendingOperations;
    this.#maximumPendingOperations = requireCapacity(capacity);
  }

  run<T>(options: ArtifactMutationGateRunOptions, operation: () => Promise<T> | T): Promise<T> {
    const initialError = this.#admissionError();
    if (initialError !== undefined) {
      return Promise.reject(initialError);
    }
    if (typeof operation !== "function") {
      return Promise.reject(gateError("ARTIFACT_MUTATION_GATE_INVALID_REQUEST"));
    }

    this.#admissionReservations += 1;
    let deadline: number;
    let signal: AbortSignal | undefined;
    try {
      const now = performance.now();
      deadline = requireDeadline(options?.deadline, now);
      signal = snapshotSignal(options?.signal);
    } catch {
      const reentrantError = this.#admissionError(true);
      this.#admissionReservations -= 1;
      return Promise.reject(reentrantError ?? gateError("ARTIFACT_MUTATION_GATE_INVALID_REQUEST"));
    }

    const reentrantError = this.#admissionError(true);
    this.#admissionReservations -= 1;
    if (reentrantError !== undefined) {
      return Promise.reject(reentrantError);
    }
    if (isAborted(signal)) {
      return Promise.reject(gateError("ARTIFACT_MUTATION_GATE_CANCELLED"));
    }
    if (performance.now() >= deadline) {
      return Promise.reject(gateError("ARTIFACT_MUTATION_GATE_TIMEOUT"));
    }

    const deferred = Promise.withResolvers<T>();
    const task: Task = {
      operation,
      deadline,
      signal,
      resolve: (value) => deferred.resolve(value as T),
      reject: deferred.reject,
      timer: undefined,
      abortListener: undefined,
      phase: "queued",
    };
    this.#acceptedOperations += 1;
    this.#queue.push(task);
    task.timer = setTimeout(
      () => this.#cancelQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_TIMEOUT")),
      Math.max(1, Math.ceil(deadline - performance.now())),
    );
    task.timer.unref();
    if (signal !== undefined) {
      task.abortListener = () =>
        this.#cancelQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_CANCELLED"));
      Reflect.apply(addEventListener, signal, ["abort", task.abortListener, { once: true }]);
    }

    const lifecycleError = this.#acceptedTaskError();
    if (lifecycleError !== undefined) {
      this.#cancelQueuedTask(task, lifecycleError);
    } else if (isAborted(signal)) {
      this.#cancelQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_CANCELLED"));
    } else if (performance.now() >= deadline) {
      this.#cancelQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_TIMEOUT"));
    } else {
      this.#scheduleDrain();
    }
    return deferred.promise;
  }

  /** Synchronously rejects new admission, cancels queued callbacks, and waits for the active one. */
  close(): Promise<void> {
    if (this.#executionContext.getStore() === this.#executionIdentity) {
      return Promise.reject(gateError("ARTIFACT_MUTATION_GATE_REENTRANT"));
    }
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    const deferred = Promise.withResolvers<void>();
    this.#closePromise = deferred.promise;
    this.#resolveClose = deferred.resolve;
    if (this.#state === "open") {
      this.#state = "closing";
    }
    this.#cancelAllQueued(this.#poisonError ?? gateError("ARTIFACT_MUTATION_GATE_CLOSED"));
    this.#completeCloseIfIdle();
    return this.#closePromise;
  }

  /** Permanently rejects admission and queued callbacks after an uncertain or fatal outcome. */
  poison(cause?: unknown): ArtifactMutationGateError {
    if (this.#poisonError !== undefined) {
      return this.#poisonError;
    }
    const error = gateError("ARTIFACT_MUTATION_GATE_POISONED", cause);
    this.#poisonError = error;
    if (this.#state !== "closed") {
      this.#state = "poisoned";
      this.#cancelAllQueued(error);
      this.#completeCloseIfIdle();
    }
    return error;
  }

  #admissionError(holdsOwnReservation = false): ArtifactMutationGateError | undefined {
    if (this.#poisonError !== undefined) {
      return this.#poisonError;
    }
    if (this.#state !== "open") {
      return gateError("ARTIFACT_MUTATION_GATE_CLOSED");
    }
    if (this.#executionContext.getStore() === this.#executionIdentity) {
      return gateError("ARTIFACT_MUTATION_GATE_REENTRANT");
    }
    const ownReservation = holdsOwnReservation ? 1 : 0;
    if (this.#admissionReservations > ownReservation) {
      return gateError("ARTIFACT_MUTATION_GATE_REENTRANT");
    }
    if (
      this.#acceptedOperations + this.#admissionReservations - ownReservation >=
      this.#maximumPendingOperations
    ) {
      return gateError("ARTIFACT_MUTATION_GATE_BUSY");
    }
    return undefined;
  }

  #acceptedTaskError(): ArtifactMutationGateError | undefined {
    if (this.#poisonError !== undefined) {
      return this.#poisonError;
    }
    return this.#state === "open" ? undefined : gateError("ARTIFACT_MUTATION_GATE_CLOSED");
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#active !== undefined || this.#state !== "open") {
      return;
    }
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#active !== undefined) {
      return;
    }
    while (this.#queue.length > 0) {
      const task = this.#queue.shift();
      if (task === undefined || task.phase !== "queued") {
        continue;
      }
      const lifecycleError = this.#acceptedTaskError();
      if (lifecycleError !== undefined) {
        this.#settleQueuedTask(task, lifecycleError);
        continue;
      }
      if (isAborted(task.signal)) {
        this.#settleQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_CANCELLED"));
        continue;
      }
      if (performance.now() >= task.deadline) {
        this.#settleQueuedTask(task, gateError("ARTIFACT_MUTATION_GATE_TIMEOUT"));
        continue;
      }
      this.#startTask(task);
      return;
    }
    this.#completeCloseIfIdle();
  }

  #startTask(task: Task): void {
    task.phase = "active";
    this.#clearQueuedResources(task);
    this.#active = task;
    let result: Promise<unknown>;
    try {
      result = this.#executionContext.run(this.#executionIdentity, async () => task.operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    void Reflect.apply(promiseThen, result, [
      (value: unknown) => this.#finishActiveTask(task, true, value),
      (error: unknown) => this.#finishActiveTask(task, false, error),
    ]);
  }

  #finishActiveTask(task: Task, succeeded: boolean, value: unknown): void {
    if (this.#active !== task || task.phase !== "active") {
      this.poison(new Error("Artifact mutation gate lost its active callback identity."));
      return;
    }
    this.#active = undefined;
    task.phase = "settled";
    this.#acceptedOperations -= 1;
    if (succeeded) {
      task.resolve(value);
    } else {
      task.reject(value);
    }
    if (this.#state === "open") {
      this.#scheduleDrain();
    } else {
      this.#completeCloseIfIdle();
    }
  }

  #cancelQueuedTask(task: Task, error: ArtifactMutationGateError): void {
    if (task.phase !== "queued") {
      return;
    }
    const index = this.#queue.indexOf(task);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
    this.#settleQueuedTask(task, error);
    if (this.#state === "open") {
      this.#scheduleDrain();
    } else {
      this.#completeCloseIfIdle();
    }
  }

  #settleQueuedTask(task: Task, error: ArtifactMutationGateError): void {
    if (task.phase !== "queued") {
      return;
    }
    task.phase = "settled";
    this.#clearQueuedResources(task);
    this.#acceptedOperations -= 1;
    task.reject(error);
  }

  #cancelAllQueued(error: ArtifactMutationGateError): void {
    const queued = this.#queue.splice(0);
    for (const task of queued) {
      this.#settleQueuedTask(task, error);
    }
  }

  #clearQueuedResources(task: Task): void {
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    if (task.signal !== undefined && task.abortListener !== undefined) {
      Reflect.apply(removeEventListener, task.signal, ["abort", task.abortListener]);
      task.abortListener = undefined;
    }
  }

  #completeCloseIfIdle(): void {
    if (this.#closePromise === undefined || this.#active !== undefined) {
      return;
    }
    this.#state = "closed";
    const resolve = this.#resolveClose;
    this.#resolveClose = undefined;
    resolve?.();
  }
}
