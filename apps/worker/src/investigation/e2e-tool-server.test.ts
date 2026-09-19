import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createInvestigationPreview } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "../execution/process-host-protocol.js";
import {
  type E2eToolReceipt,
  E2eToolServer,
  requireSuccessfulE2eRecording,
  selectE2eRecordingEvidence,
} from "./e2e-tool-server.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

function fixture(onRuntimeObservation = vi.fn(async () => {})) {
  const { task, attempt } = createInvestigationPreview("pr");
  const launches: ProcessLaunchSpec[] = [];
  const host: ProcessHostClient = {
    start: async (spec, _signal, dispatched) => {
      dispatched?.();
      launches.push(spec);
      const exit: ProcessExitedEvent = {
        protocolVersion: "1.0",
        type: "exited",
        requestId: randomUUID(),
        exitCode: 0,
        signal: null,
        outputTruncated: false,
      };
      return {
        requestId: exit.requestId,
        processId: 123,
        processCreationTimeFileTime: "134322001234567890",
        stdout: Readable.from([Buffer.from("OK")]),
        stderr: Readable.from([]),
        completed: Promise.resolve(exit),
        exited: Promise.resolve(exit),
        terminate: async () => {},
      };
    },
    terminateAll: async () => {},
    close: async () => {},
  };
  const workspace = {
    controlDirectory: "C:\\Attempt\\control",
    sourceDirectory: "C:\\Attempt\\source",
    tempDirectory: "C:\\Attempt\\temp",
    sourceBinding: { sourceSha: "a".repeat(40) },
    writeArtifact: async (
      input: Parameters<PreparedInvestigationWorkspace["writeArtifact"]>[0],
    ) => ({
      id: randomUUID(),
      taskId: task.id,
      attemptId: attempt.id,
      subjectRef: task.subjectRef,
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      digest: createHash("sha256").update(input.bytes).digest("hex"),
      byteLength: input.bytes.byteLength,
      availability: "available" as const,
    }),
  } as PreparedInvestigationWorkspace;
  const server = new E2eToolServer({
    task,
    attempt,
    workspace,
    processHost: host,
    signal: new AbortController().signal,
    environment: { SYSTEMROOT: "C:\\Windows", GIT_OPTIONAL_LOCKS: "1" },
    processLimits: {
      hardTimeoutMs: 30_000,
      maximumProcessCount: 8,
      maximumMemoryBytes: 1024 * 1024 * 1024,
      maximumOutputBytes: 1024 * 1024,
    },
    powershellExecutablePath: "C:\\Windows\\powershell.exe",
    gitExecutablePath: "C:\\Tools\\git.exe",
    ffmpegExecutablePath: "C:\\Tools\\ffmpeg.exe",
    changedPaths: ["file.cs"],
    onRuntimeObservation,
  });
  return { server, launches, onRuntimeObservation };
}

describe("E2E tool authority", () => {
  it("does not let an agent weaken a registered expected value after inspecting the result", async () => {
    const f = fixture();
    const feature = {
      id: "conversion",
      title: "Conversion",
      paths: ["file.cs"],
      scenario: "Convert the input.",
      userVisible: true,
      assertions: [
        {
          id: "result",
          kind: "ui",
          description: "The result is correct.",
          selector: { automationId: "Result" },
          assertion: { property: "text", expected: "2589988" },
        },
      ],
    };
    expect((await f.server.execute({ operation: "register-feature", feature })).status).toBe(
      "passed",
    );
    feature.assertions[0]!.assertion.expected = "unexpected actual value";
    expect((await f.server.execute({ operation: "register-feature", feature })).status).toBe(
      "blocked",
    );
    const accepted = f.server.features[0]!.assertions[0]!;
    expect(accepted.kind === "ui" && accepted.assertion?.expected).toBe("2589988");
    expect(f.launches).toEqual([]);
  });
  it.each(["nonzero", "cancelled", "truncated", "completion failure", "missing exit"])(
    "rejects a partial recording after %s even if an MP4 header exists",
    (reason) => {
      const exit: ProcessExitedEvent = {
        protocolVersion: "1.0",
        type: "exited",
        requestId: "recorder",
        exitCode: reason === "nonzero" ? 1 : 0,
        signal: reason === "cancelled" ? "cancelled" : null,
        outputTruncated: reason === "truncated",
      };
      expect(() =>
        requireSuccessfulE2eRecording(
          reason !== "completion failure",
          reason === "missing exit" ? undefined : exit,
        ),
      ).toThrow(/successfully/u);
    },
  );
  it("cannot promote an arbitrary exit-zero shell command into build or feature acceptance", async () => {
    const f = fixture();
    const command = await f.server.execute({
      operation: "command",
      script: "exit 0",
      expectedExitCode: 0,
    });
    expect(command).toMatchObject({ status: "passed", assertion: false });
    const launch = await f.server.execute({
      operation: "launch",
      buildRef: command.id,
      outputPath: "old.exe",
      arguments: [],
    });
    expect(launch.status).toBe("blocked");
    expect(f.launches).toHaveLength(1);
  });
  it("does not attach assertions made after an automatically ended recording", () => {
    const binding = {
      featureId: "feature",
      processRef: "app",
      buildRef: "build",
      targetPid: 123,
      windowHandle: "44",
      startedAt: "2026-09-19T00:00:00Z",
      endedAt: "2026-09-19T00:00:30Z",
    };
    const receipt = (operation: string, seconds: string): E2eToolReceipt => ({
      id: operation,
      operation,
      ...binding,
      status: "passed",
      assertion: operation === "assert",
      summary: "Observed operation",
      observed: {},
      artifactRefs: [],
      startedAt: `2026-09-19T00:00:${seconds}Z`,
      finishedAt: `2026-09-19T00:00:${seconds}Z`,
    });
    expect(
      selectE2eRecordingEvidence([receipt("click", "10"), receipt("assert", "40")], binding),
    ).toEqual([]);
    expect(
      selectE2eRecordingEvidence([receipt("click", "10"), receipt("assert", "20")], binding).map(
        (entry) => entry.id,
      ),
    ).toEqual(["assert"]);
    expect(selectE2eRecordingEvidence([receipt("assert", "20")], binding)).toEqual([]);
    expect(
      selectE2eRecordingEvidence(
        [receipt("click", "10"), { ...receipt("assert", "20"), featureId: "other" }],
        binding,
      ),
    ).toEqual([]);
    expect(
      selectE2eRecordingEvidence(
        [receipt("click", "10"), { ...receipt("assert", "20"), windowHandle: "other-window" }],
        binding,
      ),
    ).toEqual([]);
  });
  it("forces optional Git writes off even when the plan environment requested them", async () => {
    const f = fixture();
    await f.server.execute({ operation: "command", script: "git status" });
    expect(f.launches[0]?.environment.GIT_OPTIONAL_LOCKS).toBe("0");
  });
  it("refuses an empty-desktop recording before any application or feature is registered", async () => {
    const f = fixture();
    const receipt = await f.server.execute({ operation: "video-start", durationSeconds: 30 });
    expect(receipt.status).toBe("blocked");
    expect(f.launches).toEqual([]);
    expect(receipt.artifactRefs).toHaveLength(1);
    expect(f.server.artifacts[0]?.kind).toBe("log");
  });
  it("does not accept final JSON-style assertions without pre-registered expectations", async () => {
    const f = fixture();
    const receipt = await f.server.execute({
      operation: "assert",
      featureId: "invented",
      assertionId: "invented",
      processRef: "invented",
      assertion: { property: "exists", expected: true },
    });
    expect(receipt.status).toBe("blocked");
    expect(f.launches).toEqual([]);
  });
  it("stops subsequent operations when a real receipt could not be persisted", async () => {
    const callback = vi.fn(async () => {
      throw new Error("Server unavailable");
    });
    const f = fixture(callback);
    await expect(f.server.execute({ operation: "command", script: "exit 0" })).rejects.toThrow(
      /saved durably/u,
    );
    await expect(f.server.execute({ operation: "command", script: "exit 0" })).rejects.toThrow(
      /saved durably/u,
    );
    expect(f.launches).toHaveLength(1);
  });
});
