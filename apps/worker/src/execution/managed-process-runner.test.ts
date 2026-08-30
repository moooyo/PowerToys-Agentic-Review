import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
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
