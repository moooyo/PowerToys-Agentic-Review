import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ManagedProcessRunError,
  ProductionManagedProcessRunner,
} from "./managed-process-runner.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "./process-host-protocol.js";

const launchSpec = (maximumOutputBytes = 4_096): ProcessLaunchSpec => ({
  executable: "C:\\Program Files\\Git\\cmd\\git.exe",
  arguments: ["--version"],
  workingDirectory: "C:\\AgenticReview\\workspaces\\one",
  environmentMode: "replace",
  environment: { SystemRoot: "C:\\Windows" },
  limits: {
    hardTimeoutMs: 10_000,
    maximumProcessCount: 1,
    maximumMemoryBytes: 134_217_728,
    maximumOutputBytes,
  },
});

const exitEvent = (overrides: Partial<ProcessExitedEvent> = {}): ProcessExitedEvent => ({
  protocolVersion: "1.0",
  type: "exited",
  requestId: "process:one",
  exitCode: 0,
  signal: null,
  outputTruncated: false,
  ...overrides,
});

function managedProcess(
  stdoutValue: Buffer | string,
  stderrValue: Buffer | string,
  exit: ProcessExitedEvent = exitEvent(),
): ManagedProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end(stdoutValue);
  stderr.end(stderrValue);
  return {
    requestId: exit.requestId,
    processId: 42,
    stdout,
    stderr,
    completed: Promise.resolve(exit),
    terminate: async () => undefined,
  };
}

class FakeProcessHost implements ProcessHostClient {
  public startHandler: ProcessHostClient["start"] = async () => managedProcess("", "");
  public seenSignal: AbortSignal | undefined;

  public start: ProcessHostClient["start"] = (spec, signal) => {
    this.seenSignal = signal;
    return this.startHandler(spec, signal);
  };

  public async terminateAll(): Promise<void> {}
  public async close(): Promise<void> {}
}

describe("ProductionManagedProcessRunner", () => {
  it.each([false, true])(
    "retains bounded complete failure output only when explicitly requested: enabled=%s",
    async (enabled) => {
      const processHost = new FakeProcessHost();
      const stdout = "compiler diagnostic\n".repeat(5000);
      const stderr = "error C2653: missing namespace\n";
      processHost.startHandler = async () =>
        managedProcess(stdout, stderr, exitEvent({ exitCode: 1 }));
      const runner = new ProductionManagedProcessRunner({ retainFailureOutput: enabled });
      const error = await runner
        .run(launchSpec(1024 * 1024), {
          processHost,
          signal: new AbortController().signal,
        })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ManagedProcessRunError);
      expect(error).toMatchObject({
        code: "NON_ZERO_EXIT",
        exitCode: 1,
        stderr,
        outputTruncated: !enabled,
      });
      expect((error as ManagedProcessRunError).stdout).toBe(
        enabled ? stdout : stdout.slice(-65_536),
      );
    },
  );

  it("still bounds and labels failure output when full-retention capture overflows", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () =>
      managedProcess("x".repeat(20_000), "error tail", exitEvent({ exitCode: 1 }));
    const error = await new ProductionManagedProcessRunner({ retainFailureOutput: true })
      .run(launchSpec(4096), {
        processHost,
        signal: new AbortController().signal,
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "OUTPUT_TRUNCATED", outputTruncated: true });
    expect(
      Buffer.byteLength((error as ManagedProcessRunError).stdout) +
        Buffer.byteLength((error as ManagedProcessRunError).stderr),
    ).toBeLessThanOrEqual(4096);
  });

  it.each([Buffer.alloc(200_000, 0xff), Buffer.from([0xff, 0xe4, 0xb8])])(
    "marks invalid UTF-8 as partial without growing retained text past its shared capture budget",
    async (bytes) => {
      const processHost = new FakeProcessHost();
      processHost.startHandler = async () =>
        managedProcess(bytes, bytes, exitEvent({ exitCode: 1 }));
      const error = await new ProductionManagedProcessRunner({ retainFailureOutput: true })
        .run(launchSpec(1024 * 1024), {
          processHost,
          signal: new AbortController().signal,
        })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "NON_ZERO_EXIT", outputTruncated: true });
      expect(
        Buffer.byteLength((error as ManagedProcessRunError).stdout) +
          Buffer.byteLength((error as ManagedProcessRunError).stderr),
      ).toBeLessThanOrEqual(1024 * 1024);
    },
  );

  it("marks a failed output stream as partial even when every delivered byte fit the capture budget", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => ({
      ...managedProcess("", "", exitEvent({ exitCode: 1 })),
      stdout: Readable.from(
        (async function* () {
          yield Buffer.from("partial compiler output");
          throw new Error("Synthetic stream failure");
        })(),
      ),
    });
    const error = await new ProductionManagedProcessRunner({ retainFailureOutput: true })
      .run(launchSpec(), {
        processHost,
        signal: new AbortController().signal,
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "OUTPUT_READ_FAILED",
      outputTruncated: true,
      stdout: "partial compiler output",
    });
  });

  it("reports only non-empty observed stdout and stderr chunks without passing their text", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => ({
      ...managedProcess("", ""),
      stdout: Readable.from([Buffer.from("first"), Buffer.alloc(0), Buffer.from("second")]),
      stderr: Readable.from(["", "diagnostic"]),
    });
    const onProgress = vi.fn();

    const result = await new ProductionManagedProcessRunner().run(launchSpec(), {
      processHost,
      signal: new AbortController().signal,
      onProgress,
    });

    expect(result).toEqual({ exitCode: 0, stdout: "firstsecond", stderr: "diagnostic" });
    expect(onProgress.mock.calls).toEqual([[], [], []]);
  });

  it("does not report progress for empty streams or empty chunks", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => ({
      ...managedProcess("", ""),
      stdout: Readable.from([Buffer.alloc(0), ""]),
      stderr: Readable.from([]),
    });
    const onProgress = vi.fn();
    await new ProductionManagedProcessRunner().run(launchSpec(), {
      processHost,
      signal: new AbortController().signal,
      onProgress,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("drains both streams and waits for the child after a progress observer throws", async () => {
    const processHost = new FakeProcessHost();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settleProcess!: (exit: ProcessExitedEvent) => void;
    const completed = new Promise<ProcessExitedEvent>((resolve) => {
      settleProcess = resolve;
    });
    processHost.startHandler = async () => ({
      ...managedProcess("", ""),
      stdout,
      stderr,
      completed,
    });
    const cause = new Error("Private progress observer details.");
    const onProgress = vi.fn(() => {
      throw cause;
    });
    let settled = false;
    const outcome = new ProductionManagedProcessRunner()
      .run(launchSpec(), {
        processHost,
        signal: new AbortController().signal,
        onProgress,
      })
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    stdout.write("first");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onProgress).toHaveBeenCalledTimes(1);
    stderr.end("still drained");
    stdout.end("remaining");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdout.readableEnded).toBe(true);
    expect(stderr.readableEnded).toBe(true);
    expect(settled).toBe(false);
    expect(onProgress).toHaveBeenCalledTimes(1);

    settleProcess(exitEvent());
    const failure = await outcome;
    expect(failure).toBeInstanceOf(ManagedProcessRunError);
    expect(failure).toMatchObject({
      code: "PROGRESS_OBSERVER_FAILED",
      cause,
      stdout: "firstremaining",
      stderr: "still drained",
      exitCode: 0,
    });
    expect(String(failure)).not.toContain(cause.message);
  });

  it("stops reporting output progress after its execution signal loses authority", async () => {
    const processHost = new FakeProcessHost();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    processHost.startHandler = async () => ({ ...managedProcess("", ""), stdout, stderr });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const running = new ProductionManagedProcessRunner().run(launchSpec(), {
      processHost,
      signal: controller.signal,
      onProgress,
    });
    const rejected = expect(running).rejects.toMatchObject({ code: "ABORTED" });
    stdout.write("before cancellation");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onProgress).toHaveBeenCalledTimes(1);
    controller.abort(new Error("Lease authority was lost."));
    stdout.end("after cancellation");
    stderr.end("late stderr");
    await rejected;
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("drains stdout and stderr concurrently and returns valid UTF-8", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => managedProcess("revision\n", "diagnostic\n");
    const signal = new AbortController().signal;

    const result = await new ProductionManagedProcessRunner().run(launchSpec(), {
      processHost,
      signal,
    });

    expect(result).toEqual({ exitCode: 0, stdout: "revision\n", stderr: "diagnostic\n" });
    expect(processHost.seenSignal).toBe(signal);
  });
  it("preserves every successful output byte up to the combined one-MiB ceiling", async () => {
    const processHost = new FakeProcessHost();
    const stderr = "diagnostic\n";
    const ending = "中🙂done\n";
    const stdout = "x".repeat(1024 * 1024 - Buffer.byteLength(stderr + ending)) + ending;
    processHost.startHandler = async () => managedProcess(stdout, stderr);
    const result = await new ProductionManagedProcessRunner({
      maximumErrorPreviewBytes: 16 * 1024,
    }).run(launchSpec(1024 * 1024), { processHost, signal: new AbortController().signal });
    expect(result).toEqual({ exitCode: 0, stdout, stderr });
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(1024 * 1024);
  });
  it("retains the final compiler error after long restore output on a nonzero exit", async () => {
    const processHost = new FakeProcessHost();
    const errorLine = "error MSB4019: The imported build targets could not be found.\n";
    processHost.startHandler = async () =>
      managedProcess(
        "Restored package.\n".repeat(6000) + errorLine,
        "warning\n".repeat(3000) + "error NU1301: Package feed unavailable.\n",
        exitEvent({ exitCode: 1 }),
      );
    const error = await new ProductionManagedProcessRunner({ maximumErrorPreviewBytes: 16 * 1024 })
      .run(launchSpec(1024 * 1024), { processHost, signal: new AbortController().signal })
      .catch((failure: unknown) => failure as ManagedProcessRunError);
    expect(error).toMatchObject({ code: "NON_ZERO_EXIT", exitCode: 1, outputTruncated: true });
    expect(error.stdout.endsWith(errorLine)).toBe(true);
    expect(error.stderr.endsWith("error NU1301: Package feed unavailable.\n")).toBe(true);
    expect(Buffer.byteLength(error.stdout)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(16 * 1024);
  });
  it("keeps independent final stdout and stderr suffixes after the shared budget overflows", async () => {
    const processHost = new FakeProcessHost();
    let stdoutDrained = false;
    let stderrDrained = false;
    processHost.startHandler = async () => ({
      ...managedProcess("", "", exitEvent({ exitCode: 1 })),
      stdout: Readable.from(
        (async function* () {
          yield "r".repeat(256);
          yield "estoring";
          yield "error MSB4019\n";
          stdoutDrained = true;
        })(),
      ),
      stderr: Readable.from(
        (async function* () {
          yield "w".repeat(256);
          yield "arning";
          yield "error NU1301\n";
          stderrDrained = true;
        })(),
      ),
    });
    const error = await new ProductionManagedProcessRunner({
      maximumCapturedOutputBytes: 64,
      maximumErrorPreviewBytes: 64,
    })
      .run(launchSpec(), { processHost, signal: new AbortController().signal })
      .catch((failure: unknown) => failure as ManagedProcessRunError);
    expect(error).toMatchObject({ code: "OUTPUT_TRUNCATED", outputTruncated: true });
    expect(error.stdout.endsWith("error MSB4019\n")).toBe(true);
    expect(error.stderr.endsWith("error NU1301\n")).toBe(true);
    expect(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(
      64,
    );
    expect(stdoutDrained && stderrDrained).toBe(true);
  });
  it("keeps valid UTF-8 suffixes when the ring and preview cut through a multibyte character", async () => {
    const processHost = new FakeProcessHost();
    const ending = Buffer.from("中🙂结尾");
    processHost.startHandler = async () => ({
      ...managedProcess("", "", exitEvent({ exitCode: 1 })),
      stdout: Readable.from([
        Buffer.alloc(200, 114),
        ending.subarray(0, 4),
        ending.subarray(4, 6),
        ending.subarray(6),
      ]),
    });
    const error = await new ProductionManagedProcessRunner({
      maximumCapturedOutputBytes: 128,
      maximumErrorPreviewBytes: 11,
    })
      .run(launchSpec(), { processHost, signal: new AbortController().signal })
      .catch((failure: unknown) => failure as ManagedProcessRunError);
    expect(error).toMatchObject({
      code: "OUTPUT_TRUNCATED",
      stdout: "🙂结尾",
      outputTruncated: true,
    });
    expect(error.stdout).not.toContain("\uFFFD");
    expect(Buffer.byteLength(error.stdout)).toBeLessThanOrEqual(11);
  });
  it("does not invent a replacement character for an incomplete terminal UTF-8 sequence", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () =>
      managedProcess(
        Buffer.concat([Buffer.from("error: "), Buffer.from([0xe4, 0xb8])]),
        "",
        exitEvent({ exitCode: 1 }),
      );
    const error = await new ProductionManagedProcessRunner()
      .run(launchSpec(), { processHost, signal: new AbortController().signal })
      .catch((failure: unknown) => failure as ManagedProcessRunError);
    expect(error).toMatchObject({
      code: "NON_ZERO_EXIT",
      stdout: "error: ",
      outputTruncated: true,
    });
  });
  it("still rejects malformed UTF-8 on a successful process instead of returning preview text", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => managedProcess(Buffer.from([0xff]), "");
    await expect(
      new ProductionManagedProcessRunner().run(launchSpec(), {
        processHost,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UTF8_OUTPUT" });
  });
  it("preserves zero-preview secrecy for nonzero exits and overflowing captures", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () =>
      managedProcess(
        "private-stdout".repeat(100),
        "private-stderr".repeat(100),
        exitEvent({ exitCode: 1 }),
      );
    for (const maximumCapturedOutputBytes of [64, 16 * 1024]) {
      const error = await new ProductionManagedProcessRunner({
        maximumCapturedOutputBytes,
        maximumErrorPreviewBytes: 0,
      })
        .run(launchSpec(16 * 1024), { processHost, signal: new AbortController().signal })
        .catch((failure: unknown) => failure as ManagedProcessRunError);
      expect(error).toMatchObject({ stdout: "", stderr: "", outputTruncated: true });
      expect(String(error)).not.toContain("private-");
    }
  });

  it.each([
    {
      name: "non-zero exit",
      exit: exitEvent({ exitCode: 2 }),
      code: "NON_ZERO_EXIT",
    },
    {
      name: "ProcessHost truncation",
      exit: exitEvent({ outputTruncated: true }),
      code: "OUTPUT_TRUNCATED",
    },
    {
      name: "signal termination",
      exit: exitEvent({ exitCode: null, signal: "terminated" }),
      code: "PROCESS_TERMINATED",
    },
  ] as const)("reports $name explicitly", async ({ exit, code }) => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => managedProcess("out", "err", exit);

    await expect(
      new ProductionManagedProcessRunner().run(launchSpec(), {
        processHost,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("continues draining while bounding combined captured output", async () => {
    const processHost = new FakeProcessHost();
    processHost.startHandler = async () => managedProcess("a".repeat(3_000), "b".repeat(3_000));

    await expect(
      new ProductionManagedProcessRunner().run(launchSpec(4_096), {
        processHost,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "OUTPUT_TRUNCATED",
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
  });

  it("uses an independent capture ceiling and retains only bounded error previews", async () => {
    const processHost = new FakeProcessHost();
    let stdoutDrained = false;
    let stderrDrained = false;
    processHost.startHandler = async () => {
      const process = managedProcess("", "");
      return {
        ...process,
        stdout: Readable.from(
          (async function* () {
            yield "a".repeat(40);
            yield "c".repeat(40);
            stdoutDrained = true;
          })(),
        ),
        stderr: Readable.from(
          (async function* () {
            yield "b".repeat(40);
            yield "d".repeat(40);
            stderrDrained = true;
          })(),
        ),
      };
    };
    const runner = new ProductionManagedProcessRunner({
      maximumCapturedOutputBytes: 32,
      maximumErrorPreviewBytes: 8,
    });

    let failure: unknown;
    try {
      await runner.run(launchSpec(128 * 1024 * 1024), {
        processHost,
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ManagedProcessRunError);
    expect(failure).toMatchObject({ code: "OUTPUT_TRUNCATED" });
    expect((failure as ManagedProcessRunError).stdout.length).toBeLessThanOrEqual(8);
    expect((failure as ManagedProcessRunError).stderr.length).toBeLessThanOrEqual(8);
    expect(stdoutDrained).toBe(true);
    expect(stderrDrained).toBe(true);
  });

  it("rejects capture and preview settings above their hard ceilings", () => {
    expect(
      () => new ProductionManagedProcessRunner({ maximumCapturedOutputBytes: 1024 * 1024 + 1 }),
    ).toThrow(RangeError);
    expect(
      () => new ProductionManagedProcessRunner({ maximumErrorPreviewBytes: 64 * 1024 + 1 }),
    ).toThrow(RangeError);
  });

  it("classifies an in-flight AbortSignal without replacing it", async () => {
    const processHost = new FakeProcessHost();
    const controller = new AbortController();
    processHost.startHandler = async (_spec, signal) =>
      await new Promise<ManagedProcess>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const running = new ProductionManagedProcessRunner().run(launchSpec(), {
      processHost,
      signal: controller.signal,
    });
    controller.abort(new Error("lease lost"));

    await expect(running).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(processHost.seenSignal).toBe(controller.signal);
  });
});
