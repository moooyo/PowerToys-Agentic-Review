import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { createInvestigationPreview } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "../execution/process-host-protocol.js";
import * as build from "./e2e-build.js";
import {
  type E2eToolReceipt,
  E2eToolServer,
  type E2eToolServerOptions,
  requireSuccessfulE2eRecording,
  selectE2eRecordingEvidence,
} from "./e2e-tool-server.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

function fixture(
  onRuntimeObservation = vi.fn(async () => {}),
  options: Pick<E2eToolServerOptions, "buildToolDigests" | "msbuildToolchain"> = {},
  controlDirectory = "C:\\Attempt\\control",
) {
  const { task, attempt } = createInvestigationPreview("pr");
  const launches: ProcessLaunchSpec[] = [];
  const artifactInputs: Parameters<PreparedInvestigationWorkspace["writeArtifact"]>[0][] = [];
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
    controlDirectory,
    sourceDirectory: "C:\\Attempt\\source",
    tempDirectory: "C:\\Attempt\\temp",
    sourceBinding: { sourceSha: "a".repeat(40) },
    writeArtifact: async (
      input: Parameters<PreparedInvestigationWorkspace["writeArtifact"]>[0],
    ) => {
      artifactInputs.push({ ...input, bytes: Uint8Array.from(input.bytes) });
      return {
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
      };
    },
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
    ...options,
  });
  return { server, host, launches, onRuntimeObservation, artifactInputs };
}

describe("E2E tool authority", () => {
  it.skipIf(process.platform !== "win32")(
    "loads the exact authenticated HTTP transport from a private file without publishing it",
    async () => {
      const controlDirectory = await mkdtemp(win32.join(tmpdir(), "e2e-transport-"));
      const f = fixture(undefined, {}, controlDirectory);
      const receipt: E2eToolReceipt = {
        id: "transport-receipt",
        operation: "transport-test",
        status: "passed",
        assertion: false,
        summary: "The transport request completed.",
        observed: null,
        artifactRefs: [],
      };
      const execute = vi.spyOn(f.server, "execute").mockResolvedValue(receipt);
      const startProcess = f.host.start;
      const start = vi.spyOn(f.host, "start").mockImplementation(async (...args) => {
        const spec = args[0];
        const requestPath = spec.arguments.find((argument) => argument.endsWith(".request.json"))!;
        const resultPath = spec.arguments.find((argument) => argument.endsWith(".result.json"))!;
        const request = JSON.parse(await readFile(requestPath, "utf8")) as {
          requestId: string;
          action: string;
        };
        await writeFile(
          resultPath,
          JSON.stringify({
            schemaVersion: "E2eDesktopResultV1",
            requestId: request.requestId,
            action: request.action,
            success: true,
            code: "completed",
            message: "No owned processes remain.",
            observedAt: new Date().toISOString(),
            interactive: true,
            sessionId: 1,
            desktopName: "Default",
            foreground: null,
            ownedProcessesAlive: [],
            ownedPidsPresent: [],
            ownedProcessStates: [],
            data: { cleanupConfirmed: true },
          }),
          { flag: "wx" },
        );
        return startProcess(...args);
      });
      try {
        const session = await f.server.start();
        const transport = JSON.parse(
          await readFile(win32.join(session.directory, "transport.json"), "utf8"),
        ) as { endpoint: string; capability: string };
        expect(transport).toEqual({ endpoint: session.endpoint, capability: session.capability });
        expect(transport.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/tool$/u);
        const response = await fetch(transport.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${transport.capability}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ operation: "transport-test" }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(receipt);
        expect(execute).toHaveBeenCalledWith({ operation: "transport-test" });
        expect(f.artifactInputs).toEqual([]);
        expect(f.server.artifacts).toEqual([]);
      } finally {
        try {
          await f.server.cleanup();
        } finally {
          execute.mockRestore();
          start.mockRestore();
          await rm(controlDirectory, { recursive: true, force: true });
        }
      }
    },
  );

  it("persists artifact mismatch details privately and returns only the artifact reference", async () => {
    const failure = new build.E2eBuildError(
      "E2E_BUILD_ARTIFACT_INVALID",
      "A file in the complete build output manifest changed.",
    );
    const diagnostic: build.E2eBuildArtifactDiagnostics = {
      schemaVersion: "E2eBuildArtifactDiagnosticsV1",
      phase: "output_tree_validation",
      relativePath: "private-output/Changed.dll",
      kind: "file",
      changedFields: ["ctimeNs"],
      expected: { ctimeNs: "1", sha256: "a".repeat(64) },
      actual: { ctimeNs: "2", sha256: "a".repeat(64) },
      actualSha256Status: "captured",
      sha256LimitBytes: 16 * 1024 * 1024,
    };
    const mocked = vi.spyOn(build, "performE2eBuild").mockRejectedValueOnce(failure);
    const diagnosticMock = vi
      .spyOn(build, "getE2eBuildArtifactDiagnostics")
      .mockReturnValueOnce(diagnostic);
    try {
      const f = fixture();
      const receipt = await f.server.execute({ operation: "build", request: {} });
      expect(receipt.status).toBe("blocked");
      expect(receipt.artifactRefs).toHaveLength(2);
      const capturedInput = f.artifactInputs.find((entry) =>
        entry.name.startsWith("e2e-build-artifact-diagnostic-"),
      )!;
      expect(JSON.parse(Buffer.from(capturedInput.bytes).toString("utf8"))).toEqual(diagnostic);
      expect(receipt.observed).toMatchObject({
        errorCode: "E2E_BUILD_ARTIFACT_INVALID",
        buildArtifactDiagnostic: { artifactRef: receipt.artifactRefs[0] },
      });
      expect(JSON.stringify(receipt)).not.toContain(diagnostic.relativePath);
      expect(JSON.stringify(f.server.evidence)).not.toContain(diagnostic.relativePath);
      expect(f.onRuntimeObservation).toHaveBeenCalledOnce();
    } finally {
      mocked.mockRestore();
      diagnosticMock.mockRestore();
    }
  });

  it("persists the bounded complete compiler transcript separately from the agent preview and checkpoints both artifacts", async () => {
    const stdout = `${"retained compiler detail\n".repeat(5000)}error C2653: missing namespace\n`;
    const failure = build.describeE2eBuildFailure(
      { exitCode: 1, stdout, stderr: "" },
      {
        compilerExecutable: "C:\\Trusted\\MSBuild.exe",
        compilerSha256: "a".repeat(64),
        tool: "msbuild",
        projectPath: "logging.vcxproj",
        projectDigest: "b".repeat(64),
        headSha: "a".repeat(40),
        configuration: "Debug",
        platform: "x64",
        command: ["C:\\Trusted\\MSBuild.exe", "logging.vcxproj"],
        msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" },
      },
    );
    const mocked = vi.spyOn(build, "performE2eBuild").mockRejectedValueOnce(failure);
    try {
      let persisted: unknown;
      const onObservation = vi.fn(async (observation?: unknown) => {
        persisted = observation;
      });
      const options = {
        buildToolDigests: { msbuild: "a".repeat(64) },
        msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" as const },
      };
      const f = fixture(onObservation, options);
      const receipt = await f.server.execute({ operation: "build", request: {} });
      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({
          toolDigests: options.buildToolDigests,
          msbuildToolchain: options.msbuildToolchain,
        }),
      );
      expect(receipt.status).toBe("blocked");
      expect(receipt.artifactRefs).toHaveLength(2);
      const capturedInput = f.artifactInputs.find((entry) =>
        entry.name.startsWith("e2e-build-output-"),
      )!;
      const captured = JSON.parse(Buffer.from(capturedInput.bytes).toString("utf8"));
      expect(captured).toMatchObject({
        stdout,
        stderr: "",
        outputTruncated: false,
        retention: "complete_within_capture_limit",
        exitCode: 1,
      });
      expect(captured.invocation).toMatchObject({
        compilerSha256: "a".repeat(64),
        msbuildToolchain: options.msbuildToolchain,
      });
      const observed = receipt.observed as {
        buildDiagnostics: {
          stdout: string;
          outputTruncated: boolean;
          capture: { artifactRef: string; retainedBytes: number; outputTruncated: boolean };
        };
      };
      expect(Buffer.byteLength(observed.buildDiagnostics.stdout)).toBeLessThanOrEqual(16_384);
      expect(observed.buildDiagnostics.outputTruncated).toBe(true);
      expect(observed.buildDiagnostics.capture).toMatchObject({
        retainedBytes: Buffer.byteLength(stdout),
        outputTruncated: false,
      });
      expect(receipt.artifactRefs).toContain(observed.buildDiagnostics.capture.artifactRef);
      expect(f.onRuntimeObservation).toHaveBeenCalledOnce();
      expect(f.server.artifacts).toHaveLength(2);
      expect(
        (persisted as { artifacts: { id: string }[] }).artifacts.map((entry) => entry.id),
      ).toEqual(receipt.artifactRefs);
      expect(f.launches).toEqual([]);
    } finally {
      mocked.mockRestore();
    }
  });

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
