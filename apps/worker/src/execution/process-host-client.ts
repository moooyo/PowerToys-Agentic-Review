import {
  type ChildProcessWithoutNullStreams,
  spawn as spawnChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { types } from "node:util";
import {
  assertValidProcessLaunchSpec,
  assertValidProcessStdinResult,
  assertWindowsLocalAbsolutePath,
  encodeProcessHostRequest,
  type ManagedProcess,
  type ProcessExitedEvent,
  type ProcessHostClient,
  type ProcessHostErrorEvent,
  type ProcessHostEvent,
  ProcessHostProtocolError,
  type ProcessHostRequest,
  type ProcessHostStdinRequest,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
  type ProcessResourceUsage,
  type ProcessStdinResultEvent,
  type ProcessTerminationReason,
  parseProcessHostEventFrame,
  processHostInteractiveStdinCapability,
  processHostMaximumFrameBytes,
  processHostProtocolVersion,
} from "./process-host-protocol.js";

export interface ProcessHostSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly detached: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

export type ProcessHostSpawn = (
  executable: string,
  argumentsList: readonly string[],
  options: ProcessHostSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface ProcessHostExitObservation {
  readonly requestId: string;
  readonly exitCode: number | null;
  readonly outputTruncated: boolean;
  readonly limits: Readonly<ProcessResourceLimits>;
  readonly resourceUsage?: Readonly<ProcessResourceUsage>;
}

export interface StdioProcessHostClientOptions {
  readonly processHostPath: string;
  readonly instanceKey: string;
  readonly maximumConcurrentRequests: number;
  readonly hostEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly hostSignal?: AbortSignal;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawnProcess?: ProcessHostSpawn;
  readonly interactiveStdin?: true;
  readonly captureResourceUsage?: true;
  /** Receives a deeply frozen metadata snapshot only after a valid, matching exit is observed. */
  readonly onExitObservation?: (observation: ProcessHostExitObservation) => void;
}

export class ProcessHostRequestError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProcessHostRequestError";
  }
}

export interface WorkerProcessHostInstanceIdentity {
  readonly dataDirectory: string;
}

export function deriveWorkerProcessHostInstanceKey(
  identity: WorkerProcessHostInstanceIdentity,
): string {
  const dataDirectory = normalizeInstanceIdentityPath(identity.dataDirectory, "dataDirectory");
  const canonicalIdentity = `agentic-review-worker-data-root-v1\n${dataDirectory}`;
  return createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
}

type HostState =
  | "awaiting_ready"
  | "ready"
  | "closing_processes"
  | "awaiting_shutdown_ack"
  | "awaiting_exit"
  | "closed"
  | "failed";

type ProcessState = "start_sent" | "started";

interface TerminationState {
  readonly reason: ProcessTerminationReason;
  readonly acknowledged: Deferred<void>;
  readonly requestedByClient: boolean;
  acknowledgedEvent: boolean;
}

interface ActiveProcess {
  readonly requestId: string;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly started: Deferred<ManagedProcess>;
  readonly completed: Deferred<ProcessExitedEvent>;
  readonly lifecycleDone: Deferred<void>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly truncatedStreams: Set<"stdout" | "stderr" | "combined">;
  readonly requestErrorCodes: Set<string>;
  readonly maximumBufferedOutputBytes: number;
  readonly captureProcessIdentity: boolean;
  readonly resourceLimits: Readonly<ProcessResourceLimits>;
  readonly interactiveStdin: boolean;
  state: ProcessState;
  processId?: number;
  expectedOutputSequence: number;
  termination?: TerminationState;
  completionFailure?: Error;
  input?: InteractiveInput;
  exitEvent?: ProcessExitedEvent;
  processIdReleased?: boolean;
  inputDrainTimer?: NodeJS.Timeout;
}

interface InputOperation {
  readonly request: ProcessHostStdinRequest;
  readonly result: Deferred<void>;
  readonly bytes: number;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
  timer?: NodeJS.Timeout;
  sent: boolean;
}
interface InteractiveInput {
  readonly streamId: string;
  state: "open" | "closing" | "closed" | "failed";
  sequence: number;
  operations: number;
  bytes: number;
  pending?: InputOperation;
  closePromise?: Promise<void>;
}
interface LateInputResult {
  readonly streamId: string;
  readonly sequence: number;
  readonly operation: "write" | "close";
  readonly bytes: number;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  public settled = false;
  readonly #resolvePromise: (value: T | PromiseLike<T>) => void;
  readonly #rejectPromise: (reason?: unknown) => void;

  public constructor() {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    this.promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.promise.catch(() => undefined);
    this.#resolvePromise = resolvePromise;
    this.#rejectPromise = rejectPromise;
  }

  public resolve(value: T): void {
    if (!this.settled) {
      this.settled = true;
      this.#resolvePromise(value);
    }
  }

  public reject(reason: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.#rejectPromise(reason);
    }
  }
}

const defaultSpawnProcess: ProcessHostSpawn = (executable, argumentsList, options) =>
  spawnChildProcess(executable, [...argumentsList], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

const defaultHandshakeTimeoutMs = 10_000;
const defaultRequestTimeoutMs = 10_000;
const defaultStartTimeoutMs = 30_000;
const defaultShutdownTimeoutMs = 15_000;
const maximumClientBufferedOutputBytes = 8 * 1_024 * 1_024;
const instanceKeyPattern = /^[a-f0-9]{64}$/u;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;

function inputError(code: string): ProcessHostRequestError {
  return new ProcessHostRequestError(code, `Interactive process input failed (${code}).`);
}

function snapshotInputBytes(bytes: Uint8Array): Buffer {
  if (
    !types.isUint8Array(bytes) ||
    typedArrayLength === undefined ||
    typedArrayBuffer === undefined
  )
    throw new ProcessHostProtocolError("Interactive stdin requires a Uint8Array chunk.");
  const length = Reflect.apply(typedArrayLength, bytes, []) as number;
  const buffer = Reflect.apply(typedArrayBuffer, bytes, []) as ArrayBufferLike;
  if (types.isSharedArrayBuffer(buffer))
    throw new ProcessHostProtocolError("Interactive stdin requires a nonshared byte snapshot.");
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > processHostInteractiveStdinCapability.maximumChunkBytes
  )
    throw inputError("STDIN_LIMIT_EXCEEDED");
  const snapshot = new Uint8Array(length);
  snapshot.set(bytes);
  return Buffer.from(snapshot.buffer);
}

export class StdioProcessHostClient implements ProcessHostClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #ready = new Deferred<void>();
  readonly #childClosed = new Deferred<void>();
  readonly #shutdownAcknowledged = new Deferred<void>();
  readonly #active = new Map<string, ActiveProcess>();
  readonly #processIds = new Set<number>();
  readonly #recentSettledTerminations = new Map<string, true>();
  readonly #lateInputResults = new Map<string, LateInputResult>();
  readonly #requestTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #maximumConcurrentRequests: number;
  readonly #settledTerminationTombstoneLimit: number;
  readonly #hostSignal: AbortSignal | undefined;
  readonly #interactiveStdin: boolean;
  readonly #captureResourceUsage: boolean;
  readonly #onExitObservation: StdioProcessHostClientOptions["onExitObservation"];
  readonly #inputResultTimeoutMs: number;
  #hostInteractiveStdin = false;
  #onHostAbort: (() => void) | undefined;
  #state: HostState = "awaiting_ready";
  #failure: Error | undefined;
  #readBuffer = Buffer.alloc(0);
  #handshakeTimer: NodeJS.Timeout | undefined;
  #shutdownRequestId: string | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  private constructor(options: StdioProcessHostClientOptions) {
    const processHostPath = validateProcessHostPath(options.processHostPath);
    const instanceKey = validateInstanceKey(options.instanceKey);
    const handshakeTimeoutMs = validateTimeout(
      options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs,
      "handshakeTimeoutMs",
    );
    this.#requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      "requestTimeoutMs",
    );
    this.#startTimeoutMs = validateTimeout(
      options.startTimeoutMs ?? defaultStartTimeoutMs,
      "startTimeoutMs",
    );
    this.#shutdownTimeoutMs = validateTimeout(
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
      "shutdownTimeoutMs",
    );
    this.#maximumConcurrentRequests = validateMaximumConcurrentRequests(
      options.maximumConcurrentRequests,
    );
    this.#settledTerminationTombstoneLimit = this.#maximumConcurrentRequests * 2;
    if (options.interactiveStdin !== undefined && options.interactiveStdin !== true)
      throw new TypeError("interactiveStdin must be an explicit true opt-in.");
    this.#interactiveStdin = options.interactiveStdin === true;
    if (options.captureResourceUsage !== undefined && options.captureResourceUsage !== true)
      throw new TypeError("captureResourceUsage must be an explicit true opt-in.");
    this.#captureResourceUsage = options.captureResourceUsage === true;
    if (options.onExitObservation !== undefined && typeof options.onExitObservation !== "function")
      throw new TypeError("onExitObservation must be a function when provided.");
    this.#onExitObservation = options.onExitObservation;
    this.#inputResultTimeoutMs =
      processHostInteractiveStdinCapability.writeTimeoutMs + this.#requestTimeoutMs;
    this.#hostSignal = options.hostSignal;
    if (this.#hostSignal?.aborted) {
      throw abortReason(this.#hostSignal, "ProcessHost client startup was aborted.");
    }

    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.#child = spawnProcess(
      processHostPath,
      [
        "--stdio",
        "--max-concurrent-requests",
        String(this.#maximumConcurrentRequests),
        "--instance-key",
        instanceKey,
        ...(this.#interactiveStdin ? ["--interactive-stdin"] : []),
      ],
      {
        cwd: win32.dirname(processHostPath),
        env: buildMinimalHostEnvironment(options.hostEnvironment ?? process.env),
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#attachChildHandlers();
    this.#handshakeTimer = setTimeout(() => {
      this.#failHost(
        new ProcessHostProtocolError(
          `ProcessHost did not complete its ready handshake within ${handshakeTimeoutMs} ms.`,
        ),
      );
    }, handshakeTimeoutMs);
    this.#handshakeTimer.unref();

    const hostSignal = this.#hostSignal;
    if (hostSignal !== undefined) {
      this.#onHostAbort = () => {
        this.#failHost(abortReason(hostSignal, "ProcessHost client was aborted."));
      };
      hostSignal.addEventListener("abort", this.#onHostAbort, { once: true });
    }
  }

  public static async create(
    options: StdioProcessHostClientOptions,
  ): Promise<StdioProcessHostClient> {
    const client = new StdioProcessHostClient(options);
    try {
      await client.#ready.promise;
      return client;
    } catch (error) {
      await client.#childClosed.promise;
      throw error;
    }
  }

  public async start(spec: ProcessLaunchSpec, signal: AbortSignal): Promise<ManagedProcess> {
    assertValidProcessLaunchSpec(spec);
    spec = JSON.parse(JSON.stringify(spec)) as ProcessLaunchSpec;
    if (this.#captureResourceUsage) spec = { ...spec, captureResourceUsage: true };
    await this.#ready.promise;
    this.#assertReadyForStart();
    if (signal.aborted) {
      throw abortReason(signal, "Process start was aborted.");
    }
    assertValidProcessLaunchSpec(spec);
    if (spec.interactiveStdin === true && (!this.#interactiveStdin || !this.#hostInteractiveStdin))
      throw inputError("STDIN_NOT_ENABLED");
    if (this.#active.size >= this.#maximumConcurrentRequests) {
      throw new ProcessHostProtocolError(
        `ProcessHost client allows at most ${this.#maximumConcurrentRequests} active requests.`,
      );
    }

    const requestId = `process:${randomUUID()}`;
    const stdout = new PassThrough({ highWaterMark: 64 * 1_024 });
    const stderr = new PassThrough({ highWaterMark: 64 * 1_024 });
    const entry: ActiveProcess = {
      requestId,
      stdout,
      stderr,
      started: new Deferred<ManagedProcess>(),
      completed: new Deferred<ProcessExitedEvent>(),
      lifecycleDone: new Deferred<void>(),
      signal,
      onAbort: () => this.#abortProcess(requestId),
      truncatedStreams: new Set(),
      requestErrorCodes: new Set(),
      maximumBufferedOutputBytes: Math.min(
        spec.limits.maximumOutputBytes,
        maximumClientBufferedOutputBytes,
      ),
      captureProcessIdentity: spec.captureProcessIdentity === true,
      resourceLimits: Object.freeze({ ...spec.limits }),
      interactiveStdin: spec.interactiveStdin === true,
      state: "start_sent",
      expectedOutputSequence: 0,
    };
    this.#active.set(requestId, entry);
    signal.addEventListener("abort", entry.onAbort, { once: true });

    try {
      await this.#writeRequest({
        protocolVersion: processHostProtocolVersion,
        type: "start",
        requestId,
        spec,
      });
      return await this.#withHostDeadline(
        entry.started.promise,
        `ProcessHost did not acknowledge start for ${requestId}.`,
        this.#startTimeoutMs,
      );
    } catch (error) {
      if (
        this.#active.get(requestId) === entry &&
        entry.state === "start_sent" &&
        entry.completionFailure === undefined
      ) {
        this.#finishBeforeStart(entry, asError(error));
      }
      throw error;
    }
  }

  public async terminateAll(reason: ProcessTerminationReason): Promise<void> {
    await this.#ready.promise;
    const entries = [...this.#active.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.state === "start_sent") {
          await entry.started.promise;
        }
        if (this.#active.get(entry.requestId) === entry) {
          await this.#terminateForShutdown(entry, reason);
        }
      }),
    );
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeWithTimeout();
    return this.#closePromise;
  }

  async #closeWithTimeout(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    if (this.#failure !== undefined) {
      throw this.#failure;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProcessHostProtocolError(
          `ProcessHost did not shut down within ${this.#shutdownTimeoutMs} ms.`,
        );
        this.#failHost(error);
        reject(error);
      }, this.#shutdownTimeoutMs);
      timer.unref();
    });

    try {
      await Promise.race([this.#closeGracefully(), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async #closeGracefully(): Promise<void> {
    await this.#ready.promise;
    if (this.#state !== "ready") {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      throw new ProcessHostProtocolError(`Cannot close ProcessHost while it is ${this.#state}.`);
    }
    this.#state = "closing_processes";

    const entries = [...this.#active.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.state === "start_sent") {
          try {
            await entry.started.promise;
          } catch {
            return;
          }
        }
        if (this.#active.get(entry.requestId) === entry) {
          await this.#terminateForShutdown(entry, "worker_shutdown");
        }
      }),
    );
    await Promise.all(entries.map(async (entry) => entry.lifecycleDone.promise));
    this.#throwIfFailed();
    if (this.#active.size !== 0) {
      throw new ProcessHostProtocolError("ProcessHost still has active requests during shutdown.");
    }

    this.#shutdownRequestId = `shutdown:${randomUUID()}`;
    this.#state = "awaiting_shutdown_ack";
    await this.#writeRequest({
      protocolVersion: processHostProtocolVersion,
      type: "shutdown",
      requestId: this.#shutdownRequestId,
    });
    await this.#shutdownAcknowledged.promise;
    await this.#childClosed.promise;
    this.#throwIfFailed();
    if (this.#currentState() !== "closed") {
      throw new ProcessHostProtocolError("ProcessHost closed without completing shutdown.");
    }
  }

  #attachChildHandlers(): void {
    this.#child.stdout.on("data", (chunk: Buffer | string) => {
      this.#consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    this.#child.stdout.once("end", () => {
      if (this.#state === "closed" || this.#state === "failed") {
        return;
      }
      if (this.#readBuffer.byteLength !== 0) {
        this.#failHost(new ProcessHostProtocolError("ProcessHost ended with an incomplete frame."));
        return;
      }
      if (this.#state !== "awaiting_exit") {
        this.#failHost(new ProcessHostProtocolError("ProcessHost stdout ended before shutdown."));
      }
    });
    this.#child.stdout.on("error", (error) => {
      if (this.#state !== "closed" && this.#state !== "failed") {
        this.#failHost(
          new ProcessHostProtocolError("ProcessHost stdout failed.", { cause: error }),
        );
      }
    });
    this.#child.stderr.on("data", () => undefined);
    this.#child.stderr.on("error", (error) => {
      if (this.#state !== "closed" && this.#state !== "failed") {
        this.#failHost(
          new ProcessHostProtocolError("ProcessHost stderr failed.", { cause: error }),
        );
      }
    });
    this.#child.stdin.on("error", (error) => {
      if (this.#state !== "awaiting_exit" && this.#state !== "closed" && this.#state !== "failed") {
        this.#failHost(new ProcessHostProtocolError("ProcessHost stdin failed.", { cause: error }));
      }
    });
    this.#child.once("error", (error) => {
      this.#failHost(
        new ProcessHostProtocolError("ProcessHost failed to start or communicate.", {
          cause: error,
        }),
      );
    });
    this.#child.once("close", (exitCode, signal) => {
      this.#handleHostClose(exitCode, signal);
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#state === "failed" || this.#state === "closed") {
      return;
    }
    let data = this.#readBuffer.byteLength === 0 ? chunk : Buffer.concat([this.#readBuffer, chunk]);
    let newline = data.indexOf(0x0a);
    while (newline !== -1) {
      let frame = data.subarray(0, newline);
      if (frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d) {
        frame = frame.subarray(0, frame.byteLength - 1);
      }
      if (frame.byteLength > processHostMaximumFrameBytes) {
        this.#failHost(
          new ProcessHostProtocolError(
            `ProcessHost frame exceeds the ${processHostMaximumFrameBytes}-byte limit.`,
          ),
        );
        return;
      }
      try {
        this.#handleEvent(parseProcessHostEventFrame(frame));
      } catch (error) {
        this.#failHost(asProtocolError(error));
        return;
      }
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    if (data.byteLength > processHostMaximumFrameBytes) {
      this.#failHost(
        new ProcessHostProtocolError(
          `ProcessHost frame exceeds the ${processHostMaximumFrameBytes}-byte limit.`,
        ),
      );
      return;
    }
    this.#readBuffer = data.byteLength === 0 ? Buffer.alloc(0) : Buffer.from(data);
  }

  #handleEvent(event: ProcessHostEvent): void {
    if (this.#state === "awaiting_ready") {
      if (event.type !== "ready") {
        throw new ProcessHostProtocolError(
          "ProcessHost emitted an event before the ready handshake.",
        );
      }
      if (this.#child.pid !== undefined && event.processHostPid !== this.#child.pid) {
        throw new ProcessHostProtocolError(
          "ProcessHost ready event reported an unexpected process ID.",
        );
      }
      if (event.capabilities.maximumConcurrentRequests !== this.#maximumConcurrentRequests) {
        throw new ProcessHostProtocolError(
          "ProcessHost ready event reported an unexpected concurrent request capacity.",
        );
      }
      if (this.#handshakeTimer !== undefined) {
        clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = undefined;
      }
      this.#state = "ready";
      this.#hostInteractiveStdin = event.capabilities.interactiveStdin !== undefined;
      this.#ready.resolve();
      return;
    }
    if (event.type === "ready") {
      throw new ProcessHostProtocolError("ProcessHost emitted a duplicate ready event.");
    }
    if (this.#state === "awaiting_exit") {
      throw new ProcessHostProtocolError(
        "ProcessHost emitted an event after shutdown acknowledgement.",
      );
    }
    if (event.type === "shutdown_complete") {
      this.#handleShutdownComplete(event.requestId);
      return;
    }
    if (event.type === "error") {
      this.#handleErrorEvent(event);
      return;
    }
    if (event.type === "stdin_result") {
      this.#handleInputResult(event);
      return;
    }
    if (this.#state === "awaiting_shutdown_ack") {
      throw new ProcessHostProtocolError("ProcessHost emitted a process event during shutdown.");
    }
    this.#handleProcessEvent(event);
  }

  #handleProcessEvent(event: ProcessHostEvent): void {
    if (
      event.type === "ready" ||
      event.type === "error" ||
      event.type === "shutdown_complete" ||
      event.type === "stdin_result"
    ) {
      throw new ProcessHostProtocolError(`Unexpected ProcessHost ${event.type} event.`);
    }
    const entry = this.#active.get(event.requestId);
    if (entry === undefined) {
      throw new ProcessHostProtocolError(
        `ProcessHost event ${event.type} referenced an unknown request.`,
      );
    }

    switch (event.type) {
      case "started":
        this.#handleStarted(
          entry,
          event.processId,
          event.processCreationTimeFileTime,
          event.stdinStreamId,
        );
        return;
      case "stdout":
      case "stderr":
        this.#handleOutput(entry, event.type, event.sequence, event.dataBase64);
        return;
      case "output_truncated":
        this.#handleOutputTruncated(entry, event.sequence, event.stream);
        return;
      case "terminated":
        this.#handleTerminated(entry, event.reason);
        return;
      case "exited":
        this.#handleExited(entry, event);
        return;
    }
  }

  #handleStarted(
    entry: ActiveProcess,
    processId: number,
    processCreationTimeFileTime?: string,
    stdinStreamId?: string,
  ): void {
    if (entry.state !== "start_sent" || entry.processId !== undefined) {
      throw new ProcessHostProtocolError("ProcessHost emitted a duplicate started event.");
    }
    if (this.#processIds.has(processId)) {
      throw new ProcessHostProtocolError("ProcessHost reused an active process ID.");
    }
    if (!entry.captureProcessIdentity && processCreationTimeFileTime !== undefined) {
      throw new ProcessHostProtocolError(
        "ProcessHost returned process identity that was not requested.",
      );
    }
    if (!entry.interactiveStdin && stdinStreamId !== undefined)
      throw new ProcessHostProtocolError(
        "ProcessHost returned interactive stdin that was not requested.",
      );
    entry.state = "started";
    entry.processId = processId;
    this.#processIds.add(processId);
    if (entry.interactiveStdin && stdinStreamId === undefined) {
      const error = inputError("STDIN_NOT_ENABLED");
      entry.completionFailure ??= error;
      void entry.lifecycleDone.promise.then(() => entry.started.reject(error));
      void this.#terminate(entry, "cancelled").catch((failure: unknown) =>
        this.#failHost(asProtocolError(failure)),
      );
      this.#watchInputDrain(entry);
      return;
    }
    if (stdinStreamId !== undefined) {
      for (const other of this.#active.values())
        if (other !== entry && other.input?.streamId === stdinStreamId)
          throw new ProcessHostProtocolError("ProcessHost reused an active stdin stream identity.");
      entry.input = {
        streamId: stdinStreamId,
        state: "open",
        sequence: 1,
        operations: 0,
        bytes: 0,
      };
    }
    if (entry.captureProcessIdentity && processCreationTimeFileTime === undefined) {
      const error = new ProcessHostRequestError(
        "PROCESS_IDENTITY_UNAVAILABLE",
        "ProcessHost did not provide the requested exact process creation identity.",
      );
      entry.completionFailure ??= error;
      // An older Host can ignore the opt-in field. Do not expose an unverified process handle,
      // and wait for this request's process tree to exit before rejecting its start operation.
      void entry.lifecycleDone.promise.then(() => entry.started.reject(error));
      void this.#terminate(entry, "cancelled").catch((terminationError: unknown) => {
        this.#failHost(asProtocolError(terminationError));
      });
      if (entry.interactiveStdin) this.#watchInputDrain(entry);
      return;
    }
    const handle: ManagedProcess = Object.freeze({
      requestId: entry.requestId,
      processId,
      ...(processCreationTimeFileTime === undefined ? {} : { processCreationTimeFileTime }),
      stdout: entry.stdout,
      stderr: entry.stderr,
      completed: entry.completed.promise,
      ...(entry.input === undefined
        ? {}
        : {
            stdin: Object.freeze({
              streamId: entry.input.streamId,
              write: (bytes: Uint8Array, signal?: AbortSignal) =>
                this.#writeInput(entry, bytes, signal),
              close: (signal?: AbortSignal) => this.#closeInput(entry, signal),
            }),
          }),
      terminate: async (reason: ProcessTerminationReason) => this.#terminate(entry, reason),
    });
    entry.started.resolve(handle);
    if (entry.completionFailure !== undefined && entry.termination === undefined) {
      void this.#terminate(entry, "cancelled").catch((error: unknown) => {
        this.#failHost(asProtocolError(error));
      });
    }
  }

  #inputForOperation(entry: ActiveProcess): InteractiveInput {
    if (this.#active.get(entry.requestId) !== entry || entry.state !== "started")
      throw inputError("STDIN_PROCESS_NOT_RUNNING");
    if (entry.exitEvent !== undefined) throw inputError("STDIN_PROCESS_EXITED");
    const input = entry.input;
    if (input === undefined) throw inputError("STDIN_NOT_ENABLED");
    if (input.state === "closing" || input.state === "closed") throw inputError("STDIN_CLOSED");
    if (
      input.state === "failed" ||
      entry.completionFailure !== undefined ||
      entry.termination !== undefined
    )
      throw inputError("STDIN_PROCESS_NOT_RUNNING");
    if (input.pending !== undefined) throw inputError("STDIN_BUSY");
    return input;
  }

  #writeInput(entry: ActiveProcess, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    try {
      const input = this.#inputForOperation(entry);
      const snapshot = snapshotInputBytes(bytes);
      return this.#beginInput(entry, input, snapshot, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #closeInput(entry: ActiveProcess, signal?: AbortSignal): Promise<void> {
    if (entry.input?.closePromise !== undefined) return entry.input.closePromise;
    try {
      const input = this.#inputForOperation(entry);
      const promise = this.#beginInput(entry, input, undefined, signal);
      input.closePromise = promise;
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #beginInput(
    entry: ActiveProcess,
    input: InteractiveInput,
    bytes: Buffer | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      const error = inputError("STDIN_CANCELLED");
      this.#failInput(entry, error);
      throw error;
    }
    const size = bytes?.byteLength ?? 0;
    if (
      input.operations >= processHostInteractiveStdinCapability.maximumOperations ||
      input.bytes + size > processHostInteractiveStdinCapability.maximumTotalBytes
    )
      throw inputError("STDIN_LIMIT_EXCEEDED");
    const common = {
      protocolVersion: processHostProtocolVersion,
      requestId: entry.requestId,
      stdinStreamId: input.streamId,
      sequence: input.sequence,
    };
    const request: ProcessHostStdinRequest =
      bytes === undefined
        ? { ...common, type: "stdin_close" }
        : { ...common, type: "stdin_write", dataBase64: bytes.toString("base64") };
    const operation: InputOperation = {
      request,
      bytes: size,
      result: new Deferred<void>(),
      sent: false,
      signal,
      onAbort:
        signal === undefined
          ? undefined
          : () => this.#failInput(entry, inputError("STDIN_CANCELLED")),
    };
    input.operations++;
    input.sequence++;
    input.bytes += size;
    input.pending = operation;
    if (bytes === undefined) input.state = "closing";
    operation.timer = setTimeout(() => {
      if (this.#active.get(entry.requestId) === entry && input.pending === operation)
        this.#failInput(
          entry,
          inputError(bytes === undefined ? "STDIN_CLOSE_FAILED" : "STDIN_WRITE_TIMEOUT"),
        );
    }, this.#inputResultTimeoutMs);
    operation.timer.unref();
    if (operation.onAbort !== undefined)
      signal?.addEventListener("abort", operation.onAbort, { once: true });
    if (signal?.aborted) this.#failInput(entry, inputError("STDIN_CANCELLED"));
    void this.#writeRequest(request, () => {
      if (
        this.#active.get(entry.requestId) !== entry ||
        input.pending !== operation ||
        operation.result.settled
      )
        return false;
      if (entry.exitEvent !== undefined) {
        this.#failInput(entry, inputError("STDIN_PROCESS_EXITED"));
        return false;
      }
      operation.sent = true;
      return true;
    }).catch((error: unknown) => {
      operation.result.reject(error);
      this.#clearInputOperation(operation);
    });
    return operation.result.promise;
  }

  #handleInputResult(event: ProcessStdinResultEvent): void {
    const entry = this.#active.get(event.requestId);
    const input = entry?.input;
    const pending = input?.pending;
    if (entry === undefined || input === undefined || pending === undefined) {
      if (this.#consumeLateInputResult(event)) return;
      throw new ProcessHostProtocolError(
        "ProcessHost stdin result referenced an unknown operation.",
      );
    }
    if (!pending.sent)
      throw new ProcessHostProtocolError(
        "ProcessHost acknowledged stdin before its request was sent.",
      );
    assertValidProcessStdinResult(event, pending.request);
    this.#clearInputOperation(pending);
    delete input.pending;
    if (event.status === "failed") {
      const error = inputError(event.code ?? "STDIN_WRITE_FAILED");
      pending.result.reject(error);
      this.#failInput(entry, error);
    } else {
      // Cancellation is monotonic even when a completed pipe write's ACK races with it.
      if (input.state !== "failed") {
        if (event.operation === "close") input.state = "closed";
        pending.result.resolve();
      }
      if (entry.exitEvent !== undefined) this.#finalizeExited(entry);
    }
  }

  #clearInputOperation(operation: InputOperation): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    delete operation.timer;
    if (operation.onAbort !== undefined)
      operation.signal?.removeEventListener("abort", operation.onAbort);
  }

  #failInput(entry: ActiveProcess, error: Error): void {
    if (this.#active.get(entry.requestId) !== entry) return;
    entry.completionFailure ??= error;
    if (entry.input !== undefined) {
      entry.input.state = "failed";
      if (entry.input.pending !== undefined) {
        entry.input.pending.result.reject(error);
        this.#clearInputOperation(entry.input.pending);
      }
    }
    if (entry.exitEvent !== undefined) {
      this.#finalizeExited(entry);
      return;
    }
    this.#watchInputDrain(entry);
    if (entry.state === "started" && entry.termination === undefined)
      void this.#terminate(entry, "cancelled").catch((failure: unknown) =>
        this.#failHost(asProtocolError(failure)),
      );
  }

  #watchInputDrain(entry: ActiveProcess): void {
    if (entry.inputDrainTimer !== undefined) return;
    entry.inputDrainTimer = setTimeout(() => {
      if (this.#active.get(entry.requestId) === entry && entry.exitEvent === undefined)
        this.#failHost(
          new ProcessHostProtocolError(
            "ProcessHost did not drain the process after interactive stdin failed.",
          ),
        );
    }, this.#shutdownTimeoutMs);
    entry.inputDrainTimer.unref();
  }

  #rememberLateInputResult(entry: ActiveProcess, operation: InputOperation): void {
    if (!operation.sent) return;
    this.#deleteLateInputResult(entry.requestId);
    const timer = setTimeout(
      () => this.#deleteLateInputResult(entry.requestId),
      this.#inputResultTimeoutMs,
    );
    timer.unref();
    this.#lateInputResults.set(entry.requestId, {
      streamId: operation.request.stdinStreamId,
      sequence: operation.request.sequence,
      operation: operation.request.type === "stdin_write" ? "write" : "close",
      bytes: operation.bytes,
      expiresAt: Date.now() + this.#inputResultTimeoutMs,
      timer,
    });
    while (this.#lateInputResults.size > this.#settledTerminationTombstoneLimit) {
      const oldest = this.#lateInputResults.keys().next().value;
      if (oldest === undefined) break;
      this.#deleteLateInputResult(oldest);
    }
  }

  #deleteLateInputResult(requestId: string): void {
    const entry = this.#lateInputResults.get(requestId);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.#lateInputResults.delete(requestId);
  }

  #consumeLateInputResult(event: ProcessStdinResultEvent): boolean {
    const remembered = this.#lateInputResults.get(event.requestId);
    if (remembered === undefined) return false;
    if (Date.now() >= remembered.expiresAt) {
      this.#deleteLateInputResult(event.requestId);
      return false;
    }
    if (
      event.stdinStreamId !== remembered.streamId ||
      event.sequence !== remembered.sequence ||
      event.operation !== remembered.operation ||
      event.bytesWritten > remembered.bytes ||
      (event.status === "succeeded" && event.bytesWritten !== remembered.bytes)
    )
      throw new ProcessHostProtocolError(
        "ProcessHost late stdin result changed its operation identity or byte count.",
      );
    this.#deleteLateInputResult(event.requestId);
    return true;
  }

  #handleOutput(
    entry: ActiveProcess,
    stream: "stdout" | "stderr",
    sequence: number,
    dataBase64: string,
  ): void {
    this.#assertStarted(entry, stream);
    this.#acceptOutputSequence(entry, sequence);
    if (entry.truncatedStreams.has("combined") || entry.truncatedStreams.has(stream)) {
      throw new ProcessHostProtocolError(`ProcessHost emitted ${stream} after truncating it.`);
    }
    const destination = stream === "stdout" ? entry.stdout : entry.stderr;
    const data = Buffer.from(dataBase64, "base64");
    if (data.byteLength === 0) {
      throw new ProcessHostProtocolError("ProcessHost emitted an empty output chunk.");
    }
    const bufferedBytes = entry.stdout.readableLength + entry.stderr.readableLength;
    if (bufferedBytes + data.byteLength > entry.maximumBufferedOutputBytes) {
      entry.completionFailure ??= new ProcessHostProtocolError(
        `Buffered output for ${entry.requestId} exceeded ${entry.maximumBufferedOutputBytes} bytes.`,
      );
      if (entry.termination === undefined) {
        void this.#terminate(entry, "cancelled").catch((error: unknown) => {
          this.#failHost(asProtocolError(error));
        });
      }
      return;
    }
    destination.write(data);
  }

  #handleOutputTruncated(
    entry: ActiveProcess,
    sequence: number,
    stream: "stdout" | "stderr" | "combined",
  ): void {
    this.#assertStarted(entry, "output_truncated");
    this.#acceptOutputSequence(entry, sequence);
    if (
      entry.truncatedStreams.has(stream) ||
      entry.truncatedStreams.has("combined") ||
      (stream === "combined" && entry.truncatedStreams.size > 0)
    ) {
      throw new ProcessHostProtocolError("ProcessHost emitted a duplicate truncation event.");
    }
    entry.truncatedStreams.add(stream);
  }

  #handleTerminated(entry: ActiveProcess, reason: ProcessTerminationReason): void {
    this.#assertStarted(entry, "terminated");
    if (entry.termination === undefined) {
      if (reason !== "timeout") {
        throw new ProcessHostProtocolError(
          "ProcessHost emitted an unsolicited terminate acknowledgement.",
        );
      }
      const acknowledged = new Deferred<void>();
      acknowledged.resolve();
      entry.termination = {
        reason,
        acknowledged,
        requestedByClient: false,
        acknowledgedEvent: true,
      };
      entry.completionFailure ??= new ProcessHostRequestError(
        "PROCESS_HARD_TIMEOUT",
        "ProcessHost terminated the process after its hard timeout.",
      );
      return;
    }
    const termination = entry.termination;
    if (termination.acknowledgedEvent) {
      throw new ProcessHostProtocolError(
        "ProcessHost emitted a duplicate terminate acknowledgement.",
      );
    }
    if (termination.reason !== reason) {
      if (reason !== "timeout") {
        throw new ProcessHostProtocolError(
          "ProcessHost terminate acknowledgement changed the requested reason.",
        );
      }
      entry.completionFailure ??= new ProcessHostRequestError(
        "PROCESS_HARD_TIMEOUT",
        "ProcessHost terminated the process after its hard timeout.",
      );
    }
    termination.acknowledgedEvent = true;
    termination.acknowledged.resolve();
  }

  #handleExited(entry: ActiveProcess, event: ProcessExitedEvent): void {
    this.#assertStarted(entry, "exited");
    const terminationSettledByExit =
      entry.termination?.requestedByClient === true && !entry.termination.acknowledgedEvent;
    if (entry.termination !== undefined && !entry.termination.acknowledgedEvent) {
      entry.termination.acknowledged.resolve();
    }
    if ((event.exitCode === null) === (event.signal === null)) {
      throw new ProcessHostProtocolError(
        "ProcessHost exited event must contain exactly one of exitCode or signal.",
      );
    }
    const observedTruncation = entry.truncatedStreams.size > 0;
    if (event.outputTruncated !== observedTruncation) {
      throw new ProcessHostProtocolError(
        "ProcessHost exited event has inconsistent truncation state.",
      );
    }
    if (terminationSettledByExit) {
      this.#rememberSettledTermination(entry.requestId);
    }
    const firstObservedExit = entry.exitEvent === undefined;
    entry.exitEvent = event;
    this.#releaseProcessId(entry);
    entry.stdout.end();
    entry.stderr.end();
    if (firstObservedExit) this.#observeExit(entry, event);
    if (
      entry.input?.pending !== undefined &&
      !entry.input.pending.result.settled &&
      entry.completionFailure === undefined
    )
      return;
    this.#finalizeExited(entry);
  }

  #observeExit(entry: ActiveProcess, event: ProcessExitedEvent): void {
    if (this.#onExitObservation === undefined) return;
    try {
      const resourceUsage = event.resourceUsage;
      const observation: ProcessHostExitObservation = Object.freeze({
        requestId: event.requestId,
        exitCode: event.exitCode,
        outputTruncated: event.outputTruncated,
        limits: Object.freeze({ ...entry.resourceLimits }),
        ...(resourceUsage === undefined
          ? {}
          : {
              resourceUsage: Object.freeze({
                ...(resourceUsage.peakJobMemoryBytes === undefined
                  ? {}
                  : { peakJobMemoryBytes: resourceUsage.peakJobMemoryBytes }),
                ...(resourceUsage.peakProcessMemoryBytes === undefined
                  ? {}
                  : { peakProcessMemoryBytes: resourceUsage.peakProcessMemoryBytes }),
                ...(resourceUsage.activeProcesses === undefined
                  ? {}
                  : { activeProcesses: Object.freeze({ ...resourceUsage.activeProcesses }) }),
              }),
            }),
      });
      void Promise.resolve(this.#onExitObservation(observation)).catch(() => undefined);
    } catch {
      // Diagnostics must not change the observed exit, completion failure, or cleanup behavior.
    }
  }

  #finalizeExited(entry: ActiveProcess): void {
    const event = entry.exitEvent;
    if (event === undefined || this.#active.get(entry.requestId) !== entry) return;
    if (entry.completionFailure === undefined) {
      entry.completed.resolve(event);
    } else {
      entry.completed.reject(entry.completionFailure);
    }
    this.#finishEntry(entry);
  }

  #handleErrorEvent(event: ProcessHostErrorEvent): void {
    const error = new ProcessHostRequestError(event.code, event.message);
    if (event.requestId === null) {
      throw new ProcessHostProtocolError(`ProcessHost reported fatal error ${event.code}.`, {
        cause: error,
      });
    }
    const entry = this.#active.get(event.requestId);
    if (entry === undefined) {
      if (this.#consumeSettledTerminationError(event.requestId, event.code)) {
        return;
      }
      throw new ProcessHostProtocolError("ProcessHost error referenced an unknown request.", {
        cause: error,
      });
    }
    if (entry.requestErrorCodes.has(event.code)) {
      throw new ProcessHostProtocolError("ProcessHost emitted a duplicate request error.", {
        cause: error,
      });
    }
    entry.requestErrorCodes.add(event.code);
    if (entry.state === "start_sent") {
      this.#finishBeforeStart(entry, error);
      return;
    }
    if (event.code === "PROCESS_TERMINATION_FAILED") {
      throw new ProcessHostProtocolError(
        "ProcessHost could not enforce process-tree termination.",
        { cause: error },
      );
    }
    if (
      entry.termination !== undefined &&
      (event.code === "PROCESS_NOT_FOUND" || event.code === "PROCESS_NOT_RUNNING")
    ) {
      entry.termination.acknowledgedEvent = true;
      entry.termination.acknowledged.resolve();
      this.#recentSettledTerminations.delete(entry.requestId);
      return;
    }
    entry.completionFailure ??= error;
  }

  #handleShutdownComplete(requestId: string): void {
    if (this.#state !== "awaiting_shutdown_ack" || requestId !== this.#shutdownRequestId) {
      throw new ProcessHostProtocolError(
        "ProcessHost emitted an unsolicited shutdown acknowledgement.",
      );
    }
    if (this.#active.size !== 0) {
      throw new ProcessHostProtocolError("ProcessHost acknowledged shutdown with active requests.");
    }
    this.#state = "awaiting_exit";
    for (const requestId of this.#lateInputResults.keys()) this.#deleteLateInputResult(requestId);
    this.#child.stdin.end();
    this.#shutdownAcknowledged.resolve();
  }

  async #terminate(entry: ActiveProcess, reason: ProcessTerminationReason): Promise<void> {
    if (
      this.#active.get(entry.requestId) !== entry ||
      entry.state !== "started" ||
      entry.exitEvent !== undefined
    ) {
      throw new ProcessHostProtocolError("Cannot terminate a process that is not active.");
    }
    if (entry.termination !== undefined) {
      if (entry.termination.reason !== reason) {
        throw new ProcessHostProtocolError(
          `Process termination is already pending with reason ${entry.termination.reason}.`,
        );
      }
      return this.#withHostDeadline(
        entry.termination.acknowledged.promise,
        `ProcessHost did not acknowledge termination for ${entry.requestId}.`,
      );
    }

    const termination: TerminationState = {
      reason,
      acknowledged: new Deferred<void>(),
      requestedByClient: true,
      acknowledgedEvent: false,
    };
    entry.termination = termination;
    await this.#withHostDeadline(
      (async () => {
        await this.#writeRequest({
          protocolVersion: processHostProtocolVersion,
          type: "terminate",
          requestId: entry.requestId,
          reason,
        });
        await termination.acknowledged.promise;
      })(),
      `ProcessHost did not acknowledge termination for ${entry.requestId}.`,
    );
  }

  async #terminateForShutdown(
    entry: ActiveProcess,
    fallbackReason: ProcessTerminationReason,
  ): Promise<void> {
    if (entry.exitEvent !== undefined) return;
    if (entry.termination !== undefined) {
      await this.#withHostDeadline(
        entry.termination.acknowledged.promise,
        `ProcessHost did not finish termination for ${entry.requestId}.`,
      );
      return;
    }
    await this.#terminate(entry, fallbackReason);
  }

  #abortProcess(requestId: string): void {
    const entry = this.#active.get(requestId);
    if (entry === undefined) {
      return;
    }
    const error = abortReason(entry.signal, "Managed process was aborted.");
    entry.completionFailure ??= error;
    if (entry.input !== undefined) {
      this.#failInput(entry, inputError("STDIN_CANCELLED"));
      return;
    }
    if (entry.state === "start_sent") {
      // Keep the start deadline and admission slot until the host acknowledges or rejects it.
      // A successful acknowledgement will terminate only this request in #handleStarted.
      return;
    }
    if (entry.termination === undefined) {
      void this.#terminate(entry, "cancelled").catch((terminationError: unknown) => {
        this.#failHost(asProtocolError(terminationError));
      });
    }
  }

  #rememberSettledTermination(requestId: string): void {
    this.#recentSettledTerminations.delete(requestId);
    this.#recentSettledTerminations.set(requestId, true);
    while (this.#recentSettledTerminations.size > this.#settledTerminationTombstoneLimit) {
      const oldestRequestId = this.#recentSettledTerminations.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.#recentSettledTerminations.delete(oldestRequestId);
    }
  }

  #consumeSettledTerminationError(requestId: string, code: string): boolean {
    if (code !== "PROCESS_NOT_FOUND" && code !== "PROCESS_NOT_RUNNING") {
      return false;
    }
    return this.#recentSettledTerminations.delete(requestId);
  }

  #acceptOutputSequence(entry: ActiveProcess, sequence: number): void {
    if (sequence !== entry.expectedOutputSequence) {
      throw new ProcessHostProtocolError(
        `ProcessHost output sequence for ${entry.requestId} was ${sequence}; expected ${entry.expectedOutputSequence}.`,
      );
    }
    entry.expectedOutputSequence += 1;
  }

  #assertStarted(entry: ActiveProcess, eventType: string): void {
    if (
      entry.state !== "started" ||
      entry.processId === undefined ||
      entry.exitEvent !== undefined
    ) {
      throw new ProcessHostProtocolError(
        `ProcessHost emitted ${eventType} before acknowledging process start.`,
      );
    }
  }

  #finishBeforeStart(entry: ActiveProcess, error: Error): void {
    const failure = entry.completionFailure ?? error;
    entry.started.reject(failure);
    entry.completed.reject(failure);
    this.#finishEntry(entry);
  }

  #finishEntry(entry: ActiveProcess): void {
    entry.signal.removeEventListener("abort", entry.onAbort);
    this.#active.delete(entry.requestId);
    this.#releaseProcessId(entry);
    if (entry.inputDrainTimer !== undefined) clearTimeout(entry.inputDrainTimer);
    if (entry.input !== undefined) {
      if (entry.input.pending !== undefined) {
        const operation = entry.input.pending;
        this.#rememberLateInputResult(entry, operation);
        this.#clearInputOperation(operation);
        operation.result.reject(entry.completionFailure ?? inputError("STDIN_PROCESS_EXITED"));
        delete entry.input.pending;
      }
      if (entry.input.state !== "failed") entry.input.state = "closed";
    }
    if (entry.termination !== undefined && !entry.termination.acknowledged.settled) {
      entry.termination.acknowledged.reject(
        new ProcessHostProtocolError("Process ended without a terminate acknowledgement."),
      );
    }
    entry.stdout.end();
    entry.stderr.end();
    entry.lifecycleDone.resolve();
  }

  #releaseProcessId(entry: ActiveProcess): void {
    if (entry.processId !== undefined && entry.processIdReleased !== true) {
      this.#processIds.delete(entry.processId);
      entry.processIdReleased = true;
    }
  }

  #writeRequest(request: ProcessHostRequest, beforeWrite?: () => boolean): Promise<void> {
    const frame = encodeProcessHostRequest(request);
    const unboundedOperation = this.#writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#failure !== undefined) {
            reject(this.#failure);
            return;
          }
          try {
            if (beforeWrite !== undefined && !beforeWrite()) {
              resolve();
              return;
            }
            this.#child.stdin.write(frame, (error?: Error | null) => {
              if (error !== undefined && error !== null) {
                const protocolError = new ProcessHostProtocolError(
                  "Unable to write a ProcessHost request.",
                  { cause: error },
                );
                this.#failHost(protocolError);
                reject(protocolError);
                return;
              }
              resolve();
            });
          } catch (error) {
            const protocolError = new ProcessHostProtocolError(
              "Unable to write a ProcessHost request.",
              { cause: error },
            );
            this.#failHost(protocolError);
            reject(protocolError);
          }
        }),
    );
    const operation = this.#withHostDeadline(
      unboundedOperation,
      `ProcessHost stdin write timed out for ${request.type} request ${request.requestId}.`,
      this.#requestTimeoutMs,
    );
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async #withHostDeadline<T>(
    promise: Promise<T>,
    message: string,
    timeoutMs = this.#shutdownTimeoutMs,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProcessHostProtocolError(message);
        this.#failHost(error);
        reject(error);
      }, timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #handleHostClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.#childClosed.resolve();
    this.#removeHostAbortListener();
    if (this.#state === "failed") {
      return;
    }
    if (this.#state === "awaiting_exit" && exitCode === 0 && signal === null) {
      this.#state = "closed";
      return;
    }
    this.#failHost(
      new ProcessHostProtocolError(
        `ProcessHost exited unexpectedly (exitCode=${String(exitCode)}, signal=${String(signal)}).`,
      ),
    );
  }

  #failHost(error: Error): void {
    if (this.#state === "failed" || this.#state === "closed") {
      return;
    }
    this.#failure = error;
    this.#state = "failed";
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
    this.#ready.reject(error);
    this.#shutdownAcknowledged.reject(error);
    this.#removeHostAbortListener();

    for (const entry of this.#active.values()) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.started.reject(error);
      entry.completed.reject(error);
      entry.termination?.acknowledged.reject(error);
      if (entry.inputDrainTimer !== undefined) clearTimeout(entry.inputDrainTimer);
      if (entry.input?.pending !== undefined) {
        this.#clearInputOperation(entry.input.pending);
        entry.input.pending.result.reject(error);
      }
      entry.stdout.end();
      entry.stderr.end();
      entry.lifecycleDone.resolve();
    }
    this.#active.clear();
    this.#processIds.clear();
    this.#recentSettledTerminations.clear();
    for (const requestId of this.#lateInputResults.keys()) this.#deleteLateInputResult(requestId);
    this.#readBuffer = Buffer.alloc(0);
    this.#child.stdin.destroy();
    if (!this.#child.killed) {
      this.#child.kill();
    }
  }

  #removeHostAbortListener(): void {
    if (this.#hostSignal !== undefined && this.#onHostAbort !== undefined) {
      this.#hostSignal.removeEventListener("abort", this.#onHostAbort);
    }
  }

  #assertReadyForStart(): void {
    this.#throwIfFailed();
    if (this.#state !== "ready") {
      throw new ProcessHostProtocolError(
        `ProcessHost cannot start work while it is ${this.#state}.`,
      );
    }
  }

  #throwIfFailed(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
  }

  #currentState(): HostState {
    return this.#state;
  }
}

function validateProcessHostPath(value: string): string {
  assertWindowsLocalAbsolutePath(value, "processHostPath", true);
  return win32.normalize(value);
}

function validateInstanceKey(value: string): string {
  if (!instanceKeyPattern.test(value)) {
    throw new RangeError("instanceKey must be exactly 64 lowercase hexadecimal characters.");
  }
  return value;
}

function normalizeInstanceIdentityPath(path: string, name: string): string {
  assertWindowsLocalAbsolutePath(path, name, false);
  const normalized = win32.normalize(path.replaceAll("/", "\\"));
  const trimmed =
    normalized.length > 3 && normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
  return trimmed.toLowerCase();
}

function validateMaximumConcurrentRequests(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new RangeError("maximumConcurrentRequests must be an integer from 1 through 64.");
  }
  return value;
}

function validateTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) {
    throw new RangeError(`${name} must be an integer from 1 through 300000.`);
  }
  return value;
}

function buildMinimalHostEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    AGENTIC_REVIEW_PROCESS_HOST_PROTOCOL_VERSION: processHostProtocolVersion,
  };
  const allowedNames = ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const;
  const sourceEntries = Object.entries(source);
  for (const allowedName of allowedNames) {
    const entry = sourceEntries.find(([name]) => name.toLowerCase() === allowedName.toLowerCase());
    const value = entry?.[1];
    if (value === undefined || value.length === 0) {
      continue;
    }
    if (value.includes("\0") || value.length > 32_767) {
      throw new TypeError(`Host environment variable ${allowedName} is invalid.`);
    }
    result[allowedName] = value;
  }
  return result;
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function asProtocolError(value: unknown): ProcessHostProtocolError {
  return value instanceof ProcessHostProtocolError
    ? value
    : new ProcessHostProtocolError("ProcessHost protocol processing failed.", {
        cause: asError(value),
      });
}
