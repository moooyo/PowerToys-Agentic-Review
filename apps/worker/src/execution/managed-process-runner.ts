import type { Readable } from "node:stream";
import type {
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "./process-host-protocol.js";

export interface ManagedProcessRunContext {
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  /** Synchronous notification of observed non-empty process output; receives no output bytes. */
  readonly onProgress?: () => void;
}

export interface ManagedProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ManagedProcessRunFailureCode =
  | "ABORTED"
  | "PROCESS_START_FAILED"
  | "PROCESS_FAILED"
  | "PROCESS_TERMINATED"
  | "NON_ZERO_EXIT"
  | "OUTPUT_TRUNCATED"
  | "OUTPUT_READ_FAILED"
  | "PROGRESS_OBSERVER_FAILED"
  | "INVALID_UTF8_OUTPUT";

export class ManagedProcessRunError extends Error {
  public readonly exitCode: number | null;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly outputTruncated: boolean;

  public constructor(
    public readonly code: ManagedProcessRunFailureCode,
    message: string,
    options: {
      readonly exitCode?: number | null;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly outputTruncated?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ManagedProcessRunError";
    this.exitCode = options.exitCode ?? null;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.outputTruncated = code === "OUTPUT_TRUNCATED" || options.outputTruncated === true;
  }
}

export interface ManagedProcessRunner {
  run(spec: ProcessLaunchSpec, context: ManagedProcessRunContext): Promise<ManagedProcessRunResult>;
}

export interface ProductionManagedProcessRunnerOptions {
  readonly maximumCapturedOutputBytes?: number;
  readonly maximumErrorPreviewBytes?: number;
}

const defaultMaximumCapturedOutputBytes = 1024 * 1024;
const maximumCapturedOutputBytesLimit = 1024 * 1024;
const defaultMaximumErrorPreviewBytes = 64 * 1024;
const maximumErrorPreviewBytesLimit = 64 * 1024;

class SharedCaptureBudget {
  public truncated = false;
  #remaining: number;
  readonly #onOverflow: Array<() => void> = [];

  public constructor(maximumBytes: number) {
    this.#remaining = maximumBytes;
  }

  public onOverflow(callback: () => void): void {
    this.#onOverflow.push(callback);
  }

  public take(chunk: Buffer): boolean {
    if (this.truncated) return false;
    if (chunk.byteLength > this.#remaining) {
      this.truncated = true;
      for (const callback of this.#onOverflow) callback();
      return false;
    }
    this.#remaining -= chunk.byteLength;
    return true;
  }
}

/** Overflow retains only bounded per-stream suffixes, never another full output capture. */
class OutputTail {
  readonly #buffer: Buffer;
  #offset = 0;
  #length = 0;
  public constructor(capacity: number) {
    this.#buffer = Buffer.alloc(capacity);
  }
  public append(bytes: Buffer): void {
    const capacity = this.#buffer.byteLength;
    if (capacity === 0) return;
    if (bytes.byteLength >= capacity) {
      bytes.copy(this.#buffer, 0, bytes.byteLength - capacity);
      this.#offset = 0;
      this.#length = capacity;
      return;
    }
    const first = Math.min(bytes.byteLength, capacity - this.#offset);
    bytes.copy(this.#buffer, this.#offset, 0, first);
    if (first < bytes.byteLength) bytes.copy(this.#buffer, 0, first);
    this.#offset = (this.#offset + bytes.byteLength) % capacity;
    this.#length = Math.min(capacity, this.#length + bytes.byteLength);
  }
  public bytes(): Buffer {
    return this.#length < this.#buffer.byteLength
      ? Buffer.from(this.#buffer.subarray(0, this.#length))
      : Buffer.concat(
          [this.#buffer.subarray(this.#offset), this.#buffer.subarray(0, this.#offset)],
          this.#length,
        );
  }
}

class StreamCapture {
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;
  #tail: OutputTail | undefined;
  public observedBytes = 0;

  public constructor(
    private readonly budget: SharedCaptureBudget,
    private readonly onProgress: () => void,
    tailCapacity: number,
  ) {
    budget.onOverflow(() => {
      this.#tail = new OutputTail(tailCapacity);
      for (const chunk of this.#chunks) this.#tail.append(chunk);
      this.#chunks.length = 0;
      this.#byteLength = 0;
    });
  }

  public async drain(stream: Readable): Promise<void> {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(String(value), "utf8");
      if (chunk.byteLength === 0) continue;
      this.observedBytes += chunk.byteLength;
      this.onProgress();
      const accepted = this.budget.take(chunk);
      if (accepted) {
        this.#chunks.push(Buffer.from(chunk));
        this.#byteLength += chunk.byteLength;
      } else this.#tail!.append(chunk);
    }
  }

  public bytes(): Buffer {
    return this.#tail?.bytes() ?? Buffer.concat(this.#chunks, this.#byteLength);
  }
}

export class ProductionManagedProcessRunner implements ManagedProcessRunner {
  readonly #maximumCapturedOutputBytes: number;
  readonly #maximumErrorPreviewBytes: number;

  public constructor(options: ProductionManagedProcessRunnerOptions = {}) {
    this.#maximumCapturedOutputBytes = boundedInteger(
      options.maximumCapturedOutputBytes ?? defaultMaximumCapturedOutputBytes,
      "maximumCapturedOutputBytes",
      1,
      maximumCapturedOutputBytesLimit,
    );
    this.#maximumErrorPreviewBytes = boundedInteger(
      options.maximumErrorPreviewBytes ?? defaultMaximumErrorPreviewBytes,
      "maximumErrorPreviewBytes",
      0,
      maximumErrorPreviewBytesLimit,
    );
  }

  public async run(
    spec: ProcessLaunchSpec,
    context: ManagedProcessRunContext,
  ): Promise<ManagedProcessRunResult> {
    if (context.signal.aborted) {
      throw abortedError(context.signal);
    }

    let managed: Awaited<ReturnType<ProcessHostClient["start"]>>;
    try {
      managed = await context.processHost.start(spec, context.signal);
    } catch (error) {
      if (context.signal.aborted) {
        throw abortedError(context.signal, error);
      }
      throw new ManagedProcessRunError("PROCESS_START_FAILED", "Managed process failed to start.", {
        cause: error,
      });
    }

    const maximumCaptureBytes = Math.min(
      spec.limits.maximumOutputBytes,
      this.#maximumCapturedOutputBytes,
    );
    const budget = new SharedCaptureBudget(maximumCaptureBytes);
    let progressFailure: { readonly cause: unknown } | undefined;
    const reportProgress = (): void => {
      if (context.signal.aborted || progressFailure !== undefined) return;
      try {
        context.onProgress?.();
      } catch (cause) {
        // An observer failure must not stop either output drain or race process-tree teardown.
        progressFailure = { cause };
      }
    };
    // Both suffix capacities together remain inside the original shared capture budget.
    const stdoutCapture = new StreamCapture(
      budget,
      reportProgress,
      Math.min(this.#maximumErrorPreviewBytes, Math.ceil(maximumCaptureBytes / 2)),
    );
    const stderrCapture = new StreamCapture(
      budget,
      reportProgress,
      Math.min(this.#maximumErrorPreviewBytes, Math.floor(maximumCaptureBytes / 2)),
    );
    const [processOutcome, stdoutOutcome, stderrOutcome] = await Promise.allSettled([
      managed.completed,
      stdoutCapture.drain(managed.stdout),
      stderrCapture.drain(managed.stderr),
    ] as const);
    const stdoutBytes = stdoutCapture.bytes();
    const stderrBytes = stderrCapture.bytes();
    const errorOutput = (): ManagedProcessErrorOutput => {
      const stdout = outputPreview(stdoutBytes, this.#maximumErrorPreviewBytes);
      const stderr = outputPreview(stderrBytes, this.#maximumErrorPreviewBytes);
      return {
        stdout,
        stderr,
        outputTruncated:
          budget.truncated ||
          (processOutcome.status === "fulfilled" && processOutcome.value.outputTruncated) ||
          Buffer.byteLength(stdout, "utf8") !== stdoutCapture.observedBytes ||
          Buffer.byteLength(stderr, "utf8") !== stderrCapture.observedBytes,
      };
    };

    if (context.signal.aborted) {
      throw abortedError(
        context.signal,
        processOutcome.status === "rejected" ? processOutcome.reason : undefined,
        errorOutput(),
      );
    }
    if (progressFailure !== undefined) {
      throw new ManagedProcessRunError(
        "PROGRESS_OBSERVER_FAILED",
        "Managed process progress observation failed after process and output settlement.",
        {
          ...errorOutput(),
          cause: progressFailure.cause,
          exitCode: processOutcome.status === "fulfilled" ? processOutcome.value.exitCode : null,
        },
      );
    }
    if (stdoutOutcome.status === "rejected" || stderrOutcome.status === "rejected") {
      const outputFailure =
        stdoutOutcome.status === "rejected"
          ? stdoutOutcome.reason
          : stderrOutcome.status === "rejected"
            ? stderrOutcome.reason
            : new Error("Output stream failed without an error.");
      throw new ManagedProcessRunError(
        "OUTPUT_READ_FAILED",
        "Managed process output stream failed.",
        {
          ...errorOutput(),
          cause: outputFailure,
        },
      );
    }
    if (budget.truncated) {
      throw new ManagedProcessRunError(
        "OUTPUT_TRUNCATED",
        "Managed process output exceeded the capture limit.",
        errorOutput(),
      );
    }
    if (processOutcome.status === "rejected") {
      throw new ManagedProcessRunError("PROCESS_FAILED", "Managed process execution failed.", {
        ...errorOutput(),
        cause: processOutcome.reason,
      });
    }

    const exit = processOutcome.value;
    if (exit.outputTruncated) {
      throw processExitError("OUTPUT_TRUNCATED", "ProcessHost truncated process output.", exit, {
        ...errorOutput(),
      });
    }
    if (exit.signal !== null || exit.exitCode === null) {
      throw processExitError(
        "PROCESS_TERMINATED",
        "Managed process terminated without an exit code.",
        exit,
        errorOutput(),
      );
    }
    if (exit.exitCode !== 0) {
      throw processExitError(
        "NON_ZERO_EXIT",
        `Managed process exited with code ${exit.exitCode}.`,
        exit,
        errorOutput(),
      );
    }

    const errorPreview = errorOutput();
    return {
      exitCode: exit.exitCode,
      stdout: decodeUtf8(stdoutBytes, "stdout", errorPreview),
      stderr: decodeUtf8(stderrBytes, "stderr", errorPreview),
    };
  }
}

function decodeUtf8(
  bytes: Buffer,
  streamName: "stdout" | "stderr",
  errorOutput: ManagedProcessErrorOutput,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ManagedProcessRunError(
      "INVALID_UTF8_OUTPUT",
      `Managed process ${streamName} was not valid UTF-8.`,
      {
        ...errorOutput,
        cause: error,
      },
    );
  }
}

function processExitError(
  code: ManagedProcessRunFailureCode,
  message: string,
  exit: ProcessExitedEvent,
  output: ManagedProcessErrorOutput,
): ManagedProcessRunError {
  return new ManagedProcessRunError(code, message, {
    exitCode: exit.exitCode,
    ...output,
    outputTruncated: output.outputTruncated || exit.outputTruncated,
  });
}

function abortedError(
  signal: AbortSignal,
  cause?: unknown,
  output: ManagedProcessErrorOutput = { stdout: "", stderr: "", outputTruncated: false },
): ManagedProcessRunError {
  return new ManagedProcessRunError("ABORTED", "Managed process execution was aborted.", {
    ...output,
    cause: cause ?? signal.reason,
  });
}

interface ManagedProcessErrorOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

function outputPreview(bytes: Buffer, maximumBytes: number): string {
  if (maximumBytes === 0) return "";
  const suffix = (value: Buffer): Buffer => {
    let start = Math.max(0, value.byteLength - maximumBytes);
    while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start++;
    return value.subarray(start);
  };
  // Streaming decode omits an incomplete terminal code point instead of inventing a replacement.
  const decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(suffix(bytes), {
    stream: true,
  });
  const encoded = Buffer.from(decoded, "utf8");
  return encoded.byteLength <= maximumBytes ? decoded : suffix(encoded).toString("utf8");
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
