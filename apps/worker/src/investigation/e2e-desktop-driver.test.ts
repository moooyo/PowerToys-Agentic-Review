import { describe, expect, it } from "vitest";
import type { ProcessResourceLimits } from "../execution/process-host-protocol.js";
import {
  buildE2eDesktopLaunch,
  buildE2eVideoLaunch,
  type E2eDesktopRequest,
  type E2eDesktopResult,
  type E2eTargetWindow,
  type E2eVideoLaunchOptions,
  getE2eOwnedDescendants,
  getE2eTargetWindow,
  parseE2eDesktopRequest,
  parseE2eDesktopResult,
} from "./e2e-desktop-driver.js";

const owner = { pid: 101, creationTimeFileTime: "134322001234567890" };
const targetWindow: E2eTargetWindow = {
  ...owner,
  windowHandle: "12345",
  sessionId: 1,
  imagePath: "C:\\fresh-build\\Fixture.exe",
  title: "Fixture",
  className: "FixtureWindow",
  visible: true,
  minimized: false,
  owned: true,
  bounds: { x: 120, y: 80, width: 1_080, height: 720 },
};
const limits: ProcessResourceLimits = {
  hardTimeoutMs: 30_000,
  maximumProcessCount: 4,
  maximumMemoryBytes: 512 * 1_024 * 1_024,
  maximumOutputBytes: 1_048_576,
};
const request = (overrides: Partial<E2eDesktopRequest> = {}): E2eDesktopRequest => ({
  schemaVersion: "E2eDesktopRequestV1",
  requestId: "step-1",
  action: "inspect",
  ownedProcesses: [{ ...owner }],
  target: { pid: owner.pid },
  ...overrides,
});
const result = (overrides: Partial<E2eDesktopResult> = {}): E2eDesktopResult => ({
  schemaVersion: "E2eDesktopResultV1",
  requestId: "step-1",
  action: "inspect",
  success: true,
  code: "completed",
  message: "The desktop observation or action completed.",
  observedAt: "2026-09-19T10:00:00.0000000Z",
  interactive: true,
  sessionId: 1,
  desktopName: "Default",
  foreground: { pid: owner.pid, windowHandle: "12345", title: "Fixture", owned: true },
  ownedProcessesAlive: [{ ...owner }],
  ownedPidsPresent: [owner.pid],
  ownedProcessStates: [{ ...owner, state: "alive" }],
  data: { targetWindow: structuredClone(targetWindow) },
  ...overrides,
});

describe("E2E desktop request ownership and input boundaries", () => {
  it("accepts per-task selectors and returns an isolated request copy", () => {
    const original = request({ target: { pid: owner.pid, selector: { automationId: "Search" } } });
    const parsed = parseE2eDesktopRequest(original);
    original.ownedProcesses[0]!.creationTimeFileTime = "134322001234567891";
    expect(parsed.ownedProcesses[0]!.creationTimeFileTime).toBe("134322001234567890");
  });

  it.each([
    { target: { pid: 202 } },
    { target: { pid: owner.pid, selector: {} } },
    { target: { pid: owner.pid, selector: { index: 1 } } },
    { ownedProcesses: [owner, owner] },
    { ownedProcesses: [{ pid: owner.pid, creationTimeFileTime: "18446744073709551616" }] },
    { target: { pid: owner.pid, windowHandle: "9223372036854775808" } },
    { action: "type", text: "bad\u0000value" },
    { action: "type", text: "bad\ud800value" },
    { action: "inspect", text: "not a typing action" },
    {
      action: "click",
      coordinates: { x: 20, y: 20 },
      target: { pid: owner.pid, selector: { name: "OK" } },
    },
  ])("rejects unowned, ambiguous, or malformed request input %j", (overrides) => {
    expect(() => parseE2eDesktopRequest({ ...request(), ...overrides })).toThrow();
  });

  it("requires no live target for desktop readiness or cleanup observations", () => {
    expect(
      parseE2eDesktopRequest({
        schemaVersion: "E2eDesktopRequestV1",
        requestId: "cleanup-1",
        action: "desktop-status",
        ownedProcesses: [],
      }),
    ).toMatchObject({ action: "desktop-status", ownedProcesses: [] });
  });

  it.each(["ALT+TAB", "CTRL+ESC", "CTRL+ALT+DELETE", "WIN+R", "CTRL+CTRL+A", "UNKNOWN"])(
    "rejects unsupported or desktop-switching key chord %s",
    (key) => {
      expect(() => parseE2eDesktopRequest(request({ action: "keys", keys: [key] }))).toThrow();
    },
  );

  it("accepts normal text editing and navigation chords", () => {
    expect(
      parseE2eDesktopRequest(
        request({ action: "keys", keys: ["CTRL+A", "BACKSPACE", "SHIFT+TAB", "ENTER"] }),
      ),
    ).toMatchObject({ action: "keys" });
  });

  it.each([
    { property: "enabled", expected: "true" },
    { property: "text", expected: false },
    { property: "text", expected: "", match: "contains" },
    { property: "toggleState", expected: "unknown" },
  ])("rejects an assertion that cannot prove its expectation %j", (assertion) => {
    expect(() => parseE2eDesktopRequest({ ...request(), action: "assert", assertion })).toThrow();
  });

  it.each([
    "screenshot.png",
    "\\\\server\\share\\screen.png",
    "C:\\evidence\\screen.jpg",
    "C:\\evidence\\screen.png:stream",
  ])("rejects a screenshot outside a local PNG file path: %s", (artifactPath) => {
    expect(() => parseE2eDesktopRequest(request({ action: "screenshot", artifactPath }))).toThrow();
  });
});

describe("E2E desktop observation integrity", () => {
  it("binds the observation to its request and original creation FILETIME", () => {
    expect(parseE2eDesktopResult(JSON.stringify(result()), request()).success).toBe(true);
    expect(() =>
      parseE2eDesktopResult(JSON.stringify(result({ requestId: "another-step" })), request()),
    ).toThrow();
    expect(() =>
      parseE2eDesktopResult(
        JSON.stringify(
          result({
            ownedProcessStates: [{ ...owner, creationTimeFileTime: "1", state: "alive" }],
          }),
        ),
        request(),
      ),
    ).toThrow();
  });

  it("does not accept an absent original process as proof that a reused PID is absent", () => {
    const observation = result({
      action: "desktop-status",
      foreground: null,
      ownedProcessesAlive: [],
      ownedProcessStates: [{ ...owner, state: "identity_mismatch" }],
      data: { cleanupConfirmed: false },
    });
    expect(parseE2eDesktopResult(JSON.stringify(observation)).data.cleanupConfirmed).toBe(false);
    expect(() =>
      parseE2eDesktopResult(JSON.stringify({ ...observation, data: { cleanupConfirmed: true } })),
    ).toThrow();
  });

  it("requires complete exited-process observations before accepting cleanup", () => {
    const observation = result({
      action: "desktop-status",
      foreground: null,
      ownedProcessesAlive: [],
      ownedPidsPresent: [],
      ownedProcessStates: [{ ...owner, state: "exited" }],
      data: { cleanupConfirmed: true },
    });
    expect(parseE2eDesktopResult(JSON.stringify(observation)).data.cleanupConfirmed).toBe(true);
    expect(() =>
      parseE2eDesktopResult(
        JSON.stringify({ ...observation, ownedProcessStates: [] }),
        request({ action: "desktop-status" }),
      ),
    ).toThrow();
  });

  it("retains real assertion failures instead of treating exit output as success", () => {
    const observation = result({
      action: "assert",
      success: false,
      code: "assertion_failed",
      data: { actual: "incorrect", targetWindow },
    });
    expect(parseE2eDesktopResult(JSON.stringify(observation)).success).toBe(false);
    expect(() =>
      parseE2eDesktopResult(JSON.stringify({ ...observation, success: true })),
    ).toThrow();
  });

  it("rejects evidence for a different screenshot artifact", () => {
    const screenshot = request({
      action: "screenshot",
      artifactPath: "C:\\evidence\\expected.png",
    });
    const observation = result({
      action: "screenshot",
      data: {
        artifactPath: "C:\\evidence\\other.png",
        pid: owner.pid,
        mediaType: "image/png",
        sizeBytes: 256,
        windowHandle: targetWindow.windowHandle,
        targetWindow,
      },
    });
    expect(() => parseE2eDesktopResult(JSON.stringify(observation), screenshot)).toThrow();
  });

  it("registers module processes only through a pinned parent chain", () => {
    const child = {
      pid: 202,
      creationTimeFileTime: "134322001234567891",
      parentPid: owner.pid,
      imagePath: "C:\\fresh-build\\Module.exe",
    };
    const observation = result({ data: { ownedDescendants: [child] } });
    expect(getE2eOwnedDescendants(observation, request())).toEqual([child]);
    expect(() =>
      getE2eOwnedDescendants(
        result({ data: { ownedDescendants: [{ ...child, parentPid: 303 }] } }),
        request(),
      ),
    ).toThrow();
    expect(() =>
      getE2eOwnedDescendants(
        result({ data: { ownedDescendants: [{ ...child, creationTimeFileTime: "1" }] } }),
        request(),
      ),
    ).toThrow();
  });

  it.each(["inspect", "click", "type", "keys", "assert", "screenshot"] as const)(
    "requires the actual target window identity for successful %s observations",
    (action) => {
      expect(() => parseE2eDesktopResult(JSON.stringify(result({ action, data: {} })))).toThrow(
        "actual target window identity",
      );
    },
  );

  it("retains the actual target for a failed assertion even when the app subsequently exits", () => {
    const observation = result({
      action: "assert",
      success: false,
      code: "assertion_failed",
      foreground: null,
      ownedProcessesAlive: [],
      ownedPidsPresent: [],
      ownedProcessStates: [{ ...owner, state: "exited" }],
      data: { actual: "incorrect", targetWindow },
    });
    const parsed = parseE2eDesktopResult(
      JSON.stringify(observation),
      request({ action: "assert" }),
    );
    expect(getE2eTargetWindow(parsed)?.windowHandle).toBe("12345");
    expect(getE2eTargetWindow(parsed)?.imagePath).toBe("C:\\fresh-build\\Fixture.exe");
    expect(() =>
      parseE2eDesktopResult(JSON.stringify({ ...observation, data: { actual: "incorrect" } })),
    ).toThrow("actual target window identity");
  });

  it("rejects an action receipt from another window in the same owned process", () => {
    expect(() =>
      parseE2eDesktopResult(
        JSON.stringify(result()),
        request({ target: { pid: owner.pid, windowHandle: "67890" } }),
      ),
    ).toThrow("target window identity");
  });

  it("rejects screenshot data that names a different window than its actual target", () => {
    const screenshot = request({ action: "screenshot", artifactPath: "C:\\evidence\\screen.png" });
    const observation = result({
      action: "screenshot",
      data: {
        artifactPath: screenshot.artifactPath,
        mediaType: "image/png",
        sizeBytes: 256,
        pid: owner.pid,
        windowHandle: "67890",
        targetWindow,
      },
    });
    expect(() => parseE2eDesktopResult(JSON.stringify(observation), screenshot)).toThrow(
      "screenshot observation",
    );
    observation.data.windowHandle = targetWindow.windowHandle;
    expect(parseE2eDesktopResult(JSON.stringify(observation), screenshot).success).toBe(true);
  });

  it.each([
    { imagePath: "Fixture.exe" },
    { imagePath: "\\\\server\\share\\Fixture.exe" },
    { imagePath: "C:\\fresh-build\\Fixture.exe:stream" },
    { pid: 202 },
    { creationTimeFileTime: "1" },
    { sessionId: 2 },
    { owned: false },
  ])("rejects invalid target executable or ownership identity %j", (overrides) => {
    expect(() =>
      parseE2eDesktopResult(
        JSON.stringify(result({ data: { targetWindow: { ...targetWindow, ...overrides } } })),
        request(),
      ),
    ).toThrow();
  });

  it.each([
    undefined,
    "",
    "Module.exe",
    "\\\\server\\share\\Module.exe",
    "C:\\fresh-build\\Module.exe:stream",
  ])("requires a local executable image path before registering a descendant %j", (imagePath) => {
    expect(() =>
      getE2eOwnedDescendants(
        result({
          data: {
            ownedDescendants: [
              {
                pid: 202,
                creationTimeFileTime: "134322001234567891",
                parentPid: owner.pid,
                imagePath,
              },
            ],
          },
        }),
        request(),
      ),
    ).toThrow();
  });
});

describe("managed E2E desktop and video launches", () => {
  const windowBounds = { x: -1_200, y: 120, width: 1_080, height: 720 };
  const common = {
    workingDirectory: "C:\\E2E run",
    environment: { PATH: "C:\\Windows\\System32" },
    processLimits: limits,
  };

  it("passes request paths as literal script parameters without executable shell text", () => {
    const requestPath = "C:\\E2E run\\request;$(ignored).json";
    const spec = buildE2eDesktopLaunch({
      ...common,
      powershellExecutablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      driverPath: "C:\\trusted tools\\e2e-desktop-driver.ps1",
      requestPath,
      resultPath: "C:\\E2E run\\result.json",
    });
    expect(spec.arguments).toContain(requestPath);
    expect(spec.arguments).toContain("-File");
    expect(spec.arguments).not.toContain("-Command");
    expect(spec).toMatchObject({ environmentMode: "replace", captureProcessIdentity: true });
  });

  it("rejects request/result aliases before the driver can overwrite an input", () => {
    expect(() =>
      buildE2eDesktopLaunch({
        ...common,
        powershellExecutablePath: "C:\\Windows\\powershell.exe",
        driverPath: "C:\\trusted\\driver.ps1",
        requestPath: "C:\\E2E run\\request.json",
        resultPath: "c:\\e2e run\\REQUEST.json",
      }),
    ).toThrow();
  });

  it("records observed application bounds as H264 with managed shutdown and no overwrite", () => {
    const spec = buildE2eVideoLaunch({
      ...common,
      ffmpegExecutablePath: "C:\\trusted\\ffmpeg.exe",
      artifactPath: "C:\\E2E run\\video.mp4",
      windowBounds,
      durationSeconds: 20,
    });
    expect(spec.interactiveStdin).toBe(true);
    expect(spec.arguments).toEqual(
      expect.arrayContaining(["gdigrab", "desktop", "libx264", "yuv420p", "-n", "20"]),
    );
    expect(spec.arguments).not.toContain("-y");
    expect(spec.arguments).not.toContain("-nostdin");
    expect(spec.arguments).toEqual(expect.arrayContaining(["-fs", String(9 * 1_024 * 1_024)]));
    expect(
      spec.arguments.slice(spec.arguments.indexOf("-offset_x"), spec.arguments.indexOf("-i")),
    ).toEqual(["-offset_x", "-1200", "-offset_y", "120", "-video_size", "1080x720"]);
  });

  it.each([
    undefined,
    null,
    {},
    { ...windowBounds, x: Number.NaN },
    { ...windowBounds, y: Number.POSITIVE_INFINITY },
    { ...windowBounds, x: 65_537 },
    { ...windowBounds, width: 0 },
    { ...windowBounds, height: -1 },
    { ...windowBounds, width: 640.5 },
    { ...windowBounds, width: 32_768, height: 32_768 },
  ])("rejects missing or invalid observed application bounds %j", (bounds) => {
    expect(() =>
      buildE2eVideoLaunch({
        ...common,
        ffmpegExecutablePath: "C:\\trusted\\ffmpeg.exe",
        artifactPath: "C:\\E2E run\\video.mp4",
        windowBounds: bounds,
        durationSeconds: 20,
      } as unknown as E2eVideoLaunchOptions),
    ).toThrow("observed application window bounds");
  });

  it("reserves managed time to finalize the video container", () => {
    expect(() =>
      buildE2eVideoLaunch({
        ...common,
        ffmpegExecutablePath: "C:\\trusted\\ffmpeg.exe",
        artifactPath: "C:\\E2E run\\video.mp4",
        windowBounds,
        durationSeconds: 30,
      }),
    ).toThrow();
  });

  it("keeps recorded clips within the supported duration and upload budget", () => {
    expect(() =>
      buildE2eVideoLaunch({
        ...common,
        processLimits: { ...limits, hardTimeoutMs: 150_000 },
        ffmpegExecutablePath: "C:\\trusted\\ffmpeg.exe",
        artifactPath: "C:\\E2E run\\video.mp4",
        windowBounds,
        durationSeconds: 121,
      }),
    ).toThrow();
  });
});
