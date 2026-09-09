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

  public constructor(
    public readonly code: ManagedProcessRunFailureCode,
    message: string,
    options: {
      readonly exitCode?: number | null;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ManagedProcessRunError";
    this.exitCode = options.exitCode ?? null;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
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

  public constructor(maximumBytes: number) {
    this.#remaining = maximumBytes;
  }

  public take(chunk: Buffer): Buffer | null {
    if (this.#remaining === 0) {
      this.truncated = true;
      return null;
    }
    const acceptedBytes = Math.min(this.#remaining, chunk.byteLength);
    this.#remaining -= acceptedBytes;
    if (acceptedBytes < chunk.byteLength) {
      this.truncated = true;
    }
    return acceptedBytes === 0 ? null : chunk.subarray(0, acceptedBytes);
  }
}

class StreamCapture {
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;

  public constructor(
    private readonly budget: SharedCaptureBudget,
    private readonly onProgress: () => void,
  ) {}

  public async drain(stream: Readable): Promise<void> {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(String(value), "utf8");
      if (chunk.byteLength === 0) continue;
      this.onProgress();
      const accepted = this.budget.take(chunk);
      if (accepted !== null) {
        this.#chunks.push(Buffer.from(accepted));
        this.#byteLength += accepted.byteLength;
      }
    }
  }

  public bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#byteLength);
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

    const budget = new SharedCaptureBudget(
      Math.min(spec.limits.maximumOutputBytes, this.#maximumCapturedOutputBytes),
    );
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
    const stdoutCapture = new StreamCapture(budget, reportProgress);
    const stderrCapture = new StreamCapture(budget, reportProgress);
    const [processOutcome, stdoutOutcome, stderrOutcome] = await Promise.allSettled([
      managed.completed,
      stdoutCapture.drain(managed.stdout),
      stderrCapture.drain(managed.stderr),
    ] as const);
    const stdoutBytes = stdoutCapture.bytes();
    const stderrBytes = stderrCapture.bytes();
    const errorOutput = (): { readonly stdout: string; readonly stderr: string } => ({
      stdout: outputPreview(stdoutBytes, this.#maximumErrorPreviewBytes),
      stderr: outputPreview(stderrBytes, this.#maximumErrorPreviewBytes),
    });

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
  errorOutput: { readonly stdout: string; readonly stderr: string },
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
  output: { readonly stdout: string; readonly stderr: string },
): ManagedProcessRunError {
  return new ManagedProcessRunError(code, message, {
    exitCode: exit.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
  });
}

function abortedError(
  signal: AbortSignal,
  cause?: unknown,
  output: { readonly stdout: string; readonly stderr: string } = { stdout: "", stderr: "" },
): ManagedProcessRunError {
  return new ManagedProcessRunError("ABORTED", "Managed process execution was aborted.", {
    ...output,
    cause: cause ?? signal.reason,
  });
}

function outputPreview(bytes: Buffer, maximumBytes: number): string {
  return bytes.subarray(0, maximumBytes).toString("utf8");
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
