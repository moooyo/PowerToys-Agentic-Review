import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WindowsUiScenarioStep } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWindowsDriverRequest,
  parseWindowsDriverResult,
  parseWindowsSessionProbeResult,
  parseWindowsTcpOwnerProbeResult,
  parseWindowsUiObservationProbeResult,
  type WindowsDriverRequest,
  type WindowsDriverResult,
  windowsDriverMaximumInputBytes,
} from "./windows-driver.js";

function textAssertion(
  expected = "Saved: public fixture",
): Extract<WindowsUiScenarioStep, { action: "assertText" }> {
  return {
    id: "assert-result",
    name: "Check saved text",
    action: "assertText",
    locator: { by: "automationId", automationId: "ResultLabel" },
    expected,
    match: "exact",
    timeoutMs: 5_000,
  };
}
function request(steps: WindowsUiScenarioStep[] = [textAssertion()]): WindowsDriverRequest {
  return {
    schemaVersion: "WindowsDriverRequestV1",
    rootProcess: { pid: 1234, creationTimeFileTime: "133900000000000001" },
    readiness: { kind: "window", window: { title: "Owned fixture" }, timeoutMs: 10_000 },
    scenario: { id: "scenario-1", name: "Save fixture", required: true, timeoutMs: 30_000, steps },
    evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
    evidenceDirectory: "C:\\worker\\evidence",
  };
}
function successfulResult(input: WindowsDriverRequest): WindowsDriverResult {
  const id = "77c15c0b-f508-4edb-b102-7e697b777ffb";
  const stepsId = "81933c02-4a3a-4ab7-a591-58036b37d19b";
  const directory = "windows-365d0ab8-3bcb-4b79-94a5-d776591fa322";
  const result: WindowsDriverResult = {
    schemaVersion: "WindowsDriverResultV1",
    scenarioId: input.scenario.id,
    outcome: "passed",
    reasonCode: "completed",
    summary: "Every configured assertion passed.",
    evidenceComplete: true,
    execution: {
      schemaVersion: "UiScenarioExecutionEvidenceV1",
      source: "ui_driver",
      target: "windows_desktop",
      scenarioId: input.scenario.id,
      steps: [
        {
          stepId: "assert-result",
          name: "Check saved text",
          action: "assertText",
          expected: "Saved: public fixture",
          actual: "Saved: public fixture",
          outcome: "passed",
          summary: "The observed text matched.",
          evidenceIds: [id],
        },
      ],
    },
    evidenceFiles: [
      {
        id,
        relativePath: `${directory}/${id}.png`,
        kind: "screenshot",
        mediaType: "image/png",
        sizeBytes: 300,
        sha256: "a".repeat(64),
      },
      {
        id: stepsId,
        relativePath: `${directory}/${stepsId}.json`,
        kind: "ui_steps",
        mediaType: "application/json",
        sizeBytes: 400,
        sha256: "b".repeat(64),
      },
    ],
  };
  bindStepAsset(result);
  return result;
}

function bindStepAsset(result: WindowsDriverResult): void {
  const asset = result.evidenceFiles.find((file) => file.kind === "ui_steps");
  if (asset === undefined) throw new Error("The fixture requires structured evidence.");
  const bytes = Buffer.from(JSON.stringify(result.execution), "utf8");
  asset.sizeBytes = bytes.byteLength;
  asset.sha256 = createHash("sha256").update(bytes).digest("hex");
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("The fixture requires a first item.");
  return value;
}

describe("Windows driver protocol", () => {
  it("accepts only the complete private observation capability response", () => {
    const result = {
      schemaVersion: "WindowsUiObservationProbeResultV1",
      features: ["uiAssertionObservation1"],
    };
    expect(parseWindowsUiObservationProbeResult(JSON.stringify(result))).toEqual(result);
    expect(() =>
      parseWindowsUiObservationProbeResult(JSON.stringify({ ...result, features: [] })),
    ).toThrow();
    expect(() =>
      parseWindowsUiObservationProbeResult(JSON.stringify({ ...result, available: true })),
    ).toThrow();
  });
  it("preserves full FILETIME precision and requires a deterministic assertion", () => {
    expect(parseWindowsDriverRequest(request()).rootProcess.creationTimeFileTime).toBe(
      "133900000000000001",
    );
    expect(() => parseWindowsDriverRequest(request([]))).toThrow();
  });
  it.each([
    { pid: 0, creationTimeFileTime: "133900000000000001" },
    { pid: 1, creationTimeFileTime: 133900000000000000 },
    { pid: 1, creationTimeFileTime: "2026-09-08T10:00:00Z" },
    { pid: 1, creationTimeFileTime: "0133900000000000001" },
    { pid: 1, creationTimeFileTime: "18446744073709551616" },
    { pid: 1, creationTimeFileTime: "133900000000000001", title: "Existing app" },
  ])("rejects unsafe or inexact process identities: %j", (rootProcess) => {
    expect(() => parseWindowsDriverRequest({ ...request(), rootProcess })).toThrow();
  });
  it.each(["relative", "\\\\host\\share", "\\\\?\\C:\\evidence", "C:relative", "C:\\a\n"])(
    "rejects non-local or ambiguous evidence directory %s",
    (evidenceDirectory) => {
      expect(() => parseWindowsDriverRequest({ ...request(), evidenceDirectory })).toThrow();
    },
  );
  it("rejects duplicate IDs, step budget overflow, secret fields, and unbounded input", () => {
    expect(() => parseWindowsDriverRequest(request([textAssertion(), textAssertion()]))).toThrow();
    expect(() =>
      parseWindowsDriverRequest(request([{ ...textAssertion(), timeoutMs: 60_000 }])),
    ).toThrow();
    expect(() => parseWindowsDriverRequest({ ...request(), password: "secret" })).toThrow();
    expect(() => parseWindowsDriverRequest(request([textAssertion("\ud800")]))).toThrow();
    expect(() =>
      parseWindowsDriverRequest({
        ...request(),
        evidenceDirectory: "a".repeat(windowsDriverMaximumInputBytes),
      }),
    ).toThrow();
  });
  it("accepts a complete result whose planned assertions and manifest agree", () => {
    const input = request();
    expect(parseWindowsDriverResult(JSON.stringify(successfulResult(input)), input).outcome).toBe(
      "passed",
    );
  });
  it("requires opted-in capture and preserves a complete failed assertion witness", () => {
    const input = { ...request(), observationProtocol: "UiAssertionCaptureV1" as const };
    const result = successfulResult(input);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
    const step = first(result.execution.steps);
    if (step.action !== "assertText") throw new Error("The fixture requires a text assertion.");
    step.capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
    step.actual = "Duplicate";
    step.outcome = "failed";
    result.outcome = "failed";
    result.reasonCode = "assertion_failed";
    bindStepAsset(result);
    expect(parseWindowsDriverResult(JSON.stringify(result), input).execution.steps[0]?.actual).toBe(
      "Duplicate",
    );
    step.actual = step.expected;
    bindStepAsset(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
  });
  it("binds mapped observation bytes and retains legacy serializer compatibility", () => {
    const legacy = request();
    const result = successfulResult(legacy);
    const asset = result.evidenceFiles.find((file) => file.kind === "ui_steps");
    if (asset === undefined) throw new Error("Structured evidence must exist.");
    asset.sha256 = "f".repeat(64);
    expect(parseWindowsDriverResult(JSON.stringify(result), legacy)).toEqual(result);
    const mapped = { ...legacy, observationProtocol: "UiAssertionCaptureV1" as const };
    const step = first(result.execution.steps);
    if (step.action !== "assertText") throw new Error("The fixture requires a text assertion.");
    step.capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
    expect(() => parseWindowsDriverResult(JSON.stringify(result), mapped)).toThrow();
  });
  it("rejects mapped protected expected and fill input without exposing them", () => {
    const unsafe = "Authorization: Bearer fixture-private-token";
    expect(() =>
      parseWindowsDriverRequest({
        ...request([textAssertion(unsafe)]),
        observationProtocol: "UiAssertionCaptureV1",
      }),
    ).toThrow("Mapped Windows UI inputs cannot contain protected values.");
    expect(() =>
      parseWindowsDriverRequest({
        ...request([
          {
            id: "fill",
            name: "Fill",
            action: "fill",
            locator: { by: "automationId", automationId: "InputBox" },
            value: unsafe,
            timeoutMs: 1_000,
          },
          textAssertion(),
        ]),
        observationProtocol: "UiAssertionCaptureV1",
      }),
    ).toThrow("Mapped Windows UI inputs cannot contain protected values.");
  });
  it("rejects stale unavailable values and unsafe complete observations", () => {
    const input = { ...request(), observationProtocol: "UiAssertionCaptureV1" as const };
    const result = successfulResult(input);
    const step = first(result.execution.steps);
    if (step.action !== "assertText") throw new Error("The fixture requires a text assertion.");
    result.outcome = "blocked";
    result.reasonCode = "provider_unavailable";
    step.outcome = "blocked";
    step.capture = {
      schemaVersion: "UiAssertionCaptureV1",
      state: "unavailable",
      reason: "provider_error",
    };
    bindStepAsset(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
    step.actual = null;
    bindStepAsset(result);
    expect(
      parseWindowsDriverResult(JSON.stringify(result), input).execution.steps[0]?.actual,
    ).toBeNull();
    step.capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
    step.actual = "Authorization: Bearer fixture-private-token";
    step.outcome = "failed";
    result.outcome = "failed";
    result.reasonCode = "assertion_failed";
    bindStepAsset(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
  });
  it("rejects resumed steps after a first failure and mismatched failure reason", () => {
    const input = request([textAssertion(), { ...textAssertion(), id: "later" }]);
    const result = successfulResult(input);
    const step = first(result.execution.steps);
    if (step.action !== "assertText") throw new Error("The fixture requires a text assertion.");
    step.actual = "Wrong";
    step.outcome = "failed";
    result.outcome = "failed";
    result.reasonCode = "assertion_failed";
    result.execution.steps.push({
      ...step,
      stepId: "later",
      actual: step.expected,
      outcome: "passed",
      evidenceIds: [],
    });
    result.evidenceComplete = false;
    bindStepAsset(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
    const later = result.execution.steps[1];
    if (later === undefined) throw new Error("The fixture requires a later step.");
    later.outcome = "not_run";
    later.actual = null;
    result.reasonCode = "action_failed";
    bindStepAsset(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
  });
  it.each([
    (result: WindowsDriverResult) => {
      result.scenarioId = "different";
    },
    (result: WindowsDriverResult) => {
      result.execution.target = "web";
    },
    (result: WindowsDriverResult) => {
      result.evidenceComplete = false;
    },
    (result: WindowsDriverResult) => {
      first(result.execution.steps).actual = "Wrong value";
    },
    (result: WindowsDriverResult) => {
      first(result.execution.steps).expected = "Changed expectation";
    },
    (result: WindowsDriverResult) => {
      first(result.execution.steps).evidenceIds = [];
    },
    (result: WindowsDriverResult) => {
      first(result.execution.steps).outcome = "not_run";
    },
    (result: WindowsDriverResult) => {
      first(result.evidenceFiles).relativePath = "../../outside.png";
    },
    (result: WindowsDriverResult) => {
      first(result.evidenceFiles).mediaType = "application/json";
    },
    (result: WindowsDriverResult) => {
      result.evidenceFiles.push(first(result.evidenceFiles));
    },
    (result: WindowsDriverResult) => {
      result.evidenceFiles.pop();
    },
  ])("rejects forged or incomplete completion evidence %#", (mutate) => {
    const input = request();
    const result = successfulResult(input);
    mutate(result);
    expect(() => parseWindowsDriverResult(JSON.stringify(result), input)).toThrow();
  });
});

// This opt-in suite opens only disposable fixture windows and uses no global input. It must run
// on an explicitly authorized Windows interactive test session, never on Linux test-env.
const nativeEnabled =
  process.platform === "win32" && process.env.AGENTIC_REVIEW_WINDOWS_UI_TESTS === "1";
const powershell = join(
  process.env.WINDIR ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const driverEntry = fileURLToPath(new URL("./windows-driver-entry.ps1", import.meta.url));
const fixtureEntry = fileURLToPath(new URL("./testdata/windows-fixture.ps1", import.meta.url));
const children = new Set<ChildProcess>();
const directories = new Set<string>();
const fixtureDiagnostics = new WeakMap<ChildProcess, () => string>();
const fixtureClosures = new WeakMap<ChildProcess, Promise<void>>();

function runEntry(
  input: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driverEntry],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Fixture driver exceeded its test deadline."));
    }, 45_000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
async function fixture(
  flags: string[] = [],
): Promise<{ child: ChildProcess; input: WindowsDriverRequest }> {
  const title = `Agentic Review fixture ${randomUUID()}`;
  const child = spawn(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fixtureEntry, "-Title", title, ...flags],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  fixtureClosures.set(child, new Promise<void>((resolve) => child.once("close", () => resolve())));
  const identity = await new Promise<WindowsDriverRequest["rootProcess"]>((resolve, reject) => {
    let output = "";
    let errors = "";
    fixtureDiagnostics.set(child, () => errors);
    const timer = setTimeout(
      () => reject(new Error(`Fixture identity did not arrive: ${errors}`)),
      flags.includes("-Descendant") && flags.includes("-TcpPort") ? 20_000 : 10_000,
    );
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.trim()) as WindowsDriverRequest["rootProcess"]);
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errors += bytes.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited: ${errors}`));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "agentic-windows-evidence-"));
  directories.add(directory);
  const input = request();
  input.rootProcess = identity;
  input.readiness.window = { title };
  input.evidenceDirectory = directory;
  return { child, input };
}
async function stopLauncher(child: ChildProcess): Promise<void> {
  const closed = fixtureClosures.get(child);
  if (closed === undefined) throw new Error("The owned launcher has no close observation.");
  const drained = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Owned launcher cleanup exceeded its deadline.")),
      20_000,
    );
    void closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.stdin?.end("stop\n");
  await drained;
  expect(child.exitCode, fixtureDiagnostics.get(child)?.()).toBe(0);
}
async function prepareBackgroundWindow(input: WindowsDriverRequest): Promise<void> {
  const title = input.readiness.window.title;
  if (typeof title !== "string") throw new Error("The background fixture requires an exact title.");
  const preparation: WindowsDriverRequest = {
    ...input,
    readiness: { ...input.readiness, window: { title: `${title} neutral` } },
    scenario: {
      ...input.scenario,
      id: "prepare-background",
      name: "Explicitly focus the owned neutral window before the target action",
      steps: [
        {
          id: "prepare-neutral-window",
          name: "Invoke the neutral preparation control once",
          action: "click",
          locator: {
            by: "automationId",
            automationId: "NeutralPrepareButton",
            controlType: "Button",
          },
          timeoutMs: 5_000,
        },
        {
          ...textAssertion("Background prepared"),
          id: "verify-neutral-window",
          name: "Verify the neutral window owned foreground with no target clicks",
          locator: {
            by: "automationId",
            automationId: "NeutralPrepareButton",
            controlType: "Button",
          },
        },
      ],
    },
  };
  const output = await runEntry(preparation);
  expect(output.code, output.stderr).toBe(0);
  const result = parseWindowsDriverResult(output.stdout, preparation);
  expect(result, JSON.stringify(result)).toMatchObject({
    outcome: "passed",
    evidenceComplete: true,
  });
  expect(result.execution.steps[1]?.actual).toBe("Background prepared");
}
async function withOwnedLauncher(child: ChildProcess, run: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  try {
    await stopLauncher(child);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    const diagnostics = fixtureDiagnostics.get(child)?.();
    if (diagnostics) failures.push(new Error(`Bounded fixture diagnostics:\n${diagnostics}`));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "The native fixture failed; original errors and bounded diagnostics are retained.",
    );
}
function fixtureStatus(
  child: ChildProcess,
): Promise<{ guiAlive: boolean; ancestorAlive: boolean }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.stdout?.off("data", onData);
      reject(new Error("The owned fixture status exceeded its deadline."));
    }, 5_000);
    function onData(bytes: Buffer): void {
      output += bytes.toString("utf8");
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      try {
        const status = JSON.parse(output.trim()) as Record<string, unknown>;
        if (
          status.event !== "fixture_status" ||
          typeof status.guiAlive !== "boolean" ||
          typeof status.ancestorAlive !== "boolean"
        )
          throw new Error("The owned fixture returned an invalid process status.");
        resolve({ guiAlive: status.guiAlive, ancestorAlive: status.ancestorAlive });
      } catch (error) {
        reject(error);
      }
    }
    child.stdout?.on("data", onData);
    child.stdin?.write("status\n");
  });
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.stdin?.end("stop\n");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
  children.clear();
  for (const directory of directories) {
    const root = resolve(tmpdir());
    const target = resolve(directory);
    const path = relative(root, target);
    if (isAbsolute(path) || path.startsWith("..") || !path.startsWith("agentic-windows-evidence-"))
      throw new Error("Fixture cleanup must remain inside its own temporary evidence directory.");
    if (nativeEnabled && process.env.AGENTIC_REVIEW_WINDOWS_UI_RETAIN_EVIDENCE === "1") {
      console.info(
        JSON.stringify({ type: "windows_fixture_evidence_retained", directory: target }),
      );
    } else await rm(target, { recursive: true, force: true });
  }
  directories.clear();
});

describe.skipIf(!nativeEnabled)("Windows UI Automation native fixtures", () => {
  it("advertises observation support without requiring an application or interactive window", async () => {
    const output = await runEntry({ schemaVersion: "WindowsUiObservationProbeRequestV1" });
    expect(output.code).toBe(0);
    expect(parseWindowsUiObservationProbeResult(output.stdout).features).toEqual([
      "uiAssertionObservation1",
    ]);
  });
  it("captures owned-root absence as false and missing text as unavailable", async () => {
    const { input } = await fixture();
    input.observationProtocol = "UiAssertionCaptureV1";
    input.scenario.steps = [
      {
        id: "absent-visible",
        name: "Observe scoped absence",
        action: "assertVisible",
        locator: { by: "automationId", automationId: "MissingLabel" },
        expected: false,
        timeoutMs: 1_000,
      },
      {
        ...textAssertion(),
        locator: { by: "automationId", automationId: "MissingLabel" },
        timeoutMs: 1_000,
      },
      { ...textAssertion(), id: "not-reached" },
    ];
    const output = await runEntry(input);
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result.execution.steps[0]).toMatchObject({
      outcome: "passed",
      actual: false,
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
    });
    expect(result.execution.steps[1]).toMatchObject({
      outcome: "blocked",
      actual: null,
      capture: {
        schemaVersion: "UiAssertionCaptureV1",
        state: "unavailable",
        reason: "missing_element",
      },
    });
    expect(result.execution.steps[2]).toMatchObject({
      outcome: "not_run",
      actual: null,
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "not_run" },
    });
  }, 45_000);
  it("captures a real complete mismatch without changing its text", async () => {
    const { input } = await fixture();
    input.observationProtocol = "UiAssertionCaptureV1";
    input.scenario.steps = [{ ...textAssertion("Ready"), timeoutMs: 1_000 }];
    const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "assertion_failed",
      evidenceComplete: true,
    });
    expect(result.execution.steps[0]).toMatchObject({
      outcome: "failed",
      expected: "Ready",
      actual: "Waiting",
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
    });
  }, 45_000);
  it("withholds credential-shaped text before writing step evidence or screenshots", async () => {
    const { input } = await fixture();
    const unsafe = "Authorization: Bearer fixture-private-token";
    // Populate the isolated fixture without recording its field as an observation or image.
    input.evidence.screenshots = "on_failure";
    input.scenario.steps = [
      {
        id: "fill-credential",
        name: "Fill synthetic credential",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: unsafe,
        timeoutMs: 5_000,
      },
      textAssertion("Waiting"),
    ];
    const staged = parseWindowsDriverResult((await runEntry(input)).stdout, input);
    expect(staged.outcome).toBe("passed");
    expect(staged.evidenceFiles.some((file) => file.kind === "screenshot")).toBe(false);
    input.observationProtocol = "UiAssertionCaptureV1";
    input.evidence.screenshots = "every_assertion";
    input.scenario.steps = [
      textAssertion("Waiting"),
      {
        id: "observe-credential",
        name: "Observe protected value",
        action: "assertValue",
        locator: { by: "automationId", automationId: "InputBox" },
        expected: "public",
        timeoutMs: 5_000,
      },
    ];
    const output = await runEntry(input);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result).toMatchObject({ outcome: "blocked", evidenceComplete: false });
    expect(result.execution.steps[1]).toMatchObject({
      actual: null,
      capture: {
        schemaVersion: "UiAssertionCaptureV1",
        state: "unavailable",
        reason: "unsafe_value",
      },
    });
    expect(output.stdout).not.toContain(unsafe);
    expect(result.evidenceFiles.some((file) => file.kind === "screenshot")).toBe(false);
    expect(
      (await readdir(input.evidenceDirectory, { recursive: true })).some((path) =>
        path.endsWith(".png"),
      ),
    ).toBe(false);
    for (const asset of result.evidenceFiles)
      expect(
        await readFile(join(input.evidenceDirectory, asset.relativePath), "utf8"),
      ).not.toContain(unsafe);
  }, 45_000);
  it("rejects protected mapped input at the native boundary before opening a process", async () => {
    const input = {
      ...request([textAssertion("Authorization: Bearer fixture-private-token")]),
      observationProtocol: "UiAssertionCaptureV1",
    };
    const output = await runEntry(input);
    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain("fixture-private-token");
  });
  it.each([
    { by: "automationId", automationId: "SaveButton", controlType: "MenuItem" },
    { by: "automationId", automationId: "SaveButton", controlType: "button" },
    { by: "automationId", automationId: "SaveButton", controlType: 50000 },
    { by: "automationId", automationId: "SaveButton", controlType: null },
    { by: "automationId", automationId: "SaveButton", controlType: "Button", name: "Save" },
  ])("rejects invalid automation ID locator fields at the native boundary: %j", async (locator) => {
    const input = request([textAssertion("Waiting")]);
    const malformed = {
      ...input,
      scenario: {
        ...input.scenario,
        steps: [{ ...first(input.scenario.steps), locator }],
      },
    };
    const output = await runEntry(malformed);
    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
  });
  it("rejects oversized actual text and discards earlier mapped screenshots", async () => {
    const { input } = await fixture();
    input.observationProtocol = "UiAssertionCaptureV1";
    input.scenario.steps = [
      textAssertion("Waiting"),
      {
        id: "fill-long",
        name: "Fill bounded input",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: "x".repeat(2_048),
        timeoutMs: 5_000,
      },
      {
        id: "expand-text",
        name: "Display expanded text",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton" },
        timeoutMs: 5_000,
      },
      { ...textAssertion("Ready"), id: "observe-oversized" },
    ];
    const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
    expect(result).toMatchObject({ outcome: "blocked", evidenceComplete: false });
    expect(result.execution.steps[3]).toMatchObject({
      actual: null,
      capture: {
        schemaVersion: "UiAssertionCaptureV1",
        state: "unavailable",
        reason: "oversized_value",
      },
    });
    expect(
      (await readdir(input.evidenceDirectory, { recursive: true })).some((path) =>
        path.endsWith(".png"),
      ),
    ).toBe(false);
  }, 45_000);
  it.each(["legacy", "capture"] as const)(
    "preserves exact special text in the %s evidence serializer",
    async (protocol) => {
      const { input } = await fixture();
      const value = "Ready <&> 'quoted' \"double\" \u2028 exact";
      if (protocol === "capture") input.observationProtocol = "UiAssertionCaptureV1";
      input.scenario.steps = [
        {
          id: "fill-exact",
          name: "Fill exact text",
          action: "fill",
          locator: { by: "automationId", automationId: "InputBox" },
          value,
          timeoutMs: 5_000,
        },
        {
          id: "observe-exact",
          name: "Observe exact value",
          action: "assertValue",
          locator: { by: "automationId", automationId: "InputBox" },
          expected: value,
          timeoutMs: 5_000,
        },
      ];
      const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
      expect(result.outcome).toBe("passed");
      const asset = result.evidenceFiles.find((file) => file.kind === "ui_steps");
      if (asset === undefined) throw new Error("Structured evidence must exist.");
      const bytes = await readFile(join(input.evidenceDirectory, asset.relativePath), "utf8");
      expect(JSON.parse(bytes)).toEqual(result.execution);
      if (protocol === "capture") expect(bytes).toBe(JSON.stringify(result.execution));
      else expect(bytes).toContain("\\u003c");
    },
    45_000,
  );
  it("probes the real interactive session without selecting or operating a window", async () => {
    const result = parseWindowsSessionProbeResult(
      (await runEntry({ schemaVersion: "WindowsSessionProbeRequestV1" })).stdout,
    );
    expect(result.available).toBe(true);
    expect(result.sessionId).toBeGreaterThan(0);
  });
  it("proves a native TCP listener owner and rejects a separate process on the same port", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture port allocation failed.");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    const owned = await fixture(["-TcpPort", String(port)]);
    const input = {
      schemaVersion: "WindowsTcpOwnerProbeRequestV1",
      rootProcess: owned.input.rootProcess,
      port,
    };
    const result = parseWindowsTcpOwnerProbeResult(
      (await runEntry(input)).stdout,
      input.rootProcess,
      port,
    );
    expect(result.reasonCode).toBe("owned");
    const unrelated = await fixture(["-NoWindow"]);
    const otherInput = { ...input, rootProcess: unrelated.input.rootProcess };
    const rejected = parseWindowsTcpOwnerProbeResult(
      (await runEntry(otherInput)).stdout,
      otherInput.rootProcess,
      port,
    );
    expect(rejected.reasonCode).toBe("unowned_listener");
    expect(rejected.owned).toBe(false);
  }, 45_000);
  it("proves a native descendant TCP listener through a persistent launcher's live ancestry", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture port allocation failed.");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    const { child, input: fixtureInput } = await fixture(["-Descendant", "-TcpPort", String(port)]);
    const input = {
      schemaVersion: "WindowsTcpOwnerProbeRequestV1",
      rootProcess: fixtureInput.rootProcess,
      port,
    };
    await withOwnedLauncher(child, async () => {
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsTcpOwnerProbeResult(output.stdout, input.rootProcess, port);
      expect(result).toMatchObject({ reasonCode: "owned", owned: true });
      expect(child.exitCode).toBeNull();
    });
  }, 90_000);
  it("rejects an empty-key window selector at the independent PowerShell boundary", async () => {
    const input = request();
    const output = await runEntry({
      ...input,
      readiness: { ...input.readiness, window: { "": "Any window" } },
    });
    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("input or execution protocol failed");
  });
  it("executes real fill, click, visibility, value, and text assertions with owned-window PNGs", async () => {
    const { input } = await fixture();
    input.scenario.steps = [
      {
        id: "fill-input",
        name: "Fill fixture",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: "public fixture",
        timeoutMs: 5_000,
      },
      {
        id: "assert-input",
        name: "Check input value",
        action: "assertValue",
        locator: { by: "automationId", automationId: "InputBox" },
        expected: "public fixture",
        timeoutMs: 5_000,
      },
      {
        id: "click-save",
        name: "Save fixture",
        action: "click",
        locator: { by: "name", controlType: "Button", name: "Save" },
        timeoutMs: 5_000,
      },
      textAssertion(),
      {
        id: "assert-visible",
        name: "Check result visibility",
        action: "assertVisible",
        locator: { by: "automationId", automationId: "ResultLabel" },
        expected: true,
        timeoutMs: 5_000,
      },
      {
        id: "assert-absent",
        name: "Check absent element",
        action: "assertVisible",
        locator: { by: "automationId", automationId: "MissingLabel" },
        expected: false,
        timeoutMs: 5_000,
      },
    ];
    const output = await runEntry(input);
    expect(
      output.stderr
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line)),
    ).toEqual(
      input.scenario.steps.map((step) => ({
        type: "ui_step_completed",
        scenarioId: input.scenario.id,
        stepId: step.id,
        outcome: "passed",
      })),
    );
    expect(output.code).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result.outcome, result.summary).toBe("passed");
    expect(result.execution.steps.map((step) => step.actual)).toEqual([
      null,
      "public fixture",
      null,
      "Saved: public fixture",
      true,
      false,
    ]);
    expect(result.evidenceFiles.filter((asset) => asset.kind === "screenshot")).toHaveLength(4);
    for (const asset of result.evidenceFiles) {
      const bytes = await readFile(join(input.evidenceDirectory, asset.relativePath));
      expect(bytes.byteLength).toBe(asset.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      if (asset.kind === "screenshot") {
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        // The fixture is DPI-unaware with a 420 by 210 client area. Capture in its own
        // rendering coordinate system instead of adding a physical-pixel black border.
        expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(420);
        expect(bytes.readUInt32BE(16)).toBeLessThan(500);
        expect(bytes.readUInt32BE(20)).toBeGreaterThanOrEqual(210);
        expect(bytes.readUInt32BE(20)).toBeLessThan(300);
      } else expect(JSON.parse(bytes.toString("utf8"))).toEqual(result.execution);
    }
  }, 45_000);
  it("returns the real failed assertion and failure screenshot", async () => {
    const { input } = await fixture();
    input.scenario.steps = [{ ...textAssertion("Unexpected"), timeoutMs: 1_000 }];
    input.evidence.screenshots = "on_failure";
    const output = await runEntry(input);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result.outcome).toBe("failed");
    expect(result.reasonCode).toBe("assertion_failed");
    expect(result.execution.steps[0]?.actual).toBe("Waiting");
    expect(result.evidenceComplete).toBe(true);
  }, 45_000);
  it("focuses the pinned owned window before invoking a background button once", async () => {
    const { child, input } = await fixture(["-Descendant", "-BackgroundBeforeClick"]);
    input.evidence.screenshots = "on_failure";
    input.scenario.steps = [
      {
        ...textAssertion("Before click: background; clicks: 0"),
        id: "assert-background",
        name: "Confirm the owned target starts in the background",
        locator: { by: "automationId", automationId: "ForegroundPreparationLabel" },
      },
      {
        id: "click-background-button",
        name: "Invoke the owned background button once",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      {
        ...textAssertion("Clicks: 1; foreground witnessed: true;"),
        id: "assert-foreground-click",
        name: "Observe foreground activation before the single callback",
        match: "contains",
      },
    ];
    await withOwnedLauncher(child, async () => {
      await prepareBackgroundWindow(input);
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "passed",
        evidenceComplete: true,
      });
      expect(result.execution.steps.slice(0, 2).map((step) => step.actual)).toEqual([
        "Before click: background; clicks: 0",
        null,
      ]);
      // The guard precedes Invoke; an asynchronous callback can observe later focus changes.
      expect(result.execution.steps[2]?.actual).toMatch(
        /^Clicks: 1; foreground witnessed: true; callback foreground: (?:true; background clicks: 0|false; background clicks: 1)$/,
      );
      expect(await fixtureStatus(child)).toEqual({ guiAlive: true, ancestorAlive: true });
    });
  }, 90_000);
  it("blocks an owned topmost window covering the click center without invoking", async () => {
    const { child, input } = await fixture([
      "-Descendant",
      "-BackgroundBeforeClick",
      "-OccludeClick",
    ]);
    input.evidence.screenshots = "on_failure";
    input.scenario.steps = [
      {
        ...textAssertion("Before click: background; clicks: 0"),
        id: "assert-background",
        name: "Confirm the owned target starts in the background",
        locator: { by: "automationId", automationId: "ForegroundPreparationLabel" },
      },
      {
        id: "click-occluded-button",
        name: "Reject a button covered by a separate owned top-level window",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      {
        ...textAssertion("Clicks: 0; foreground: none; background clicks: 0"),
        id: "not-reached-after-occlusion",
        name: "Leave subsequent steps unexecuted after the blocked click",
      },
    ];
    await withOwnedLauncher(child, async () => {
      await prepareBackgroundWindow(input);
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "blocked",
        reasonCode: "provider_unavailable",
      });
      expect(result.execution.steps[1]?.summary).toBe(
        "The invocation point is covered or outside the pinned window.",
      );
      expect(result.execution.steps.map((step) => step.outcome)).toEqual([
        "passed",
        "blocked",
        "not_run",
      ]);
      const witnessInput: WindowsDriverRequest = {
        ...input,
        scenario: {
          ...input.scenario,
          id: "occluded-click-witness",
          name: "Observe the untouched fixture after the blocked click",
          steps: [textAssertion("Clicks: 0; foreground: none; background clicks: 0")],
        },
      };
      const witnessOutput = await runEntry(witnessInput);
      expect(witnessOutput.code, witnessOutput.stderr).toBe(0);
      const witness = parseWindowsDriverResult(witnessOutput.stdout, witnessInput);
      expect(witness, JSON.stringify(witness)).toMatchObject({
        outcome: "passed",
        evidenceComplete: true,
      });
      expect(witness.execution.steps[0]?.actual).toBe(
        "Clicks: 0; foreground: none; background clicks: 0",
      );
      expect(await fixtureStatus(child)).toEqual({ guiAlive: true, ancestorAlive: true });
    });
  }, 90_000);
  it("rejects an exact PID whose trusted creation time does not match", async () => {
    const { input } = await fixture();
    input.rootProcess.creationTimeFileTime = String(
      BigInt(input.rootProcess.creationTimeFileTime) + 1n,
    );
    const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
    expect(result.reasonCode).toBe("ownership_lost");
    expect(result.evidenceComplete).toBe(false);
    expect(result.execution.steps[0]?.outcome).toBe("not_run");
  }, 45_000);
  it("does not search a same-title window outside the launched process tree", async () => {
    const unowned = await fixture();
    unowned.input.scenario.steps = [textAssertion("Waiting")];
    const visible = await runEntry(unowned.input);
    expect(visible.code, visible.stderr).toBe(0);
    expect(parseWindowsDriverResult(visible.stdout, unowned.input)).toMatchObject({
      outcome: "passed",
      evidenceComplete: true,
    });
    const owned = await fixture(["-NoWindow"]);
    owned.input.readiness.window = unowned.input.readiness.window;
    owned.input.readiness.timeoutMs = 1_000;
    const output = await runEntry(owned.input);
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, owned.input);
    expect(result.reasonCode).toBe("window_unavailable");
    expect(result.evidenceFiles.every((asset) => asset.kind !== "screenshot")).toBe(true);
    expect(result.execution.steps.every((step) => step.outcome === "not_run")).toBe(true);
  }, 45_000);
  it.each([
    ["-DuplicateWindow", "ambiguous_window"],
    ["-DuplicateControl", "ambiguous_locator"],
  ])(
    "blocks nonunique ownership-scoped matches: %s",
    async (flag, reason) => {
      const { input } = await fixture([flag]);
      const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
      expect(result.reasonCode).toBe(reason);
      expect(result.outcome).toBe("blocked");
    },
    45_000,
  );
  it("keeps an unqualified automation ID ambiguous across control types", async () => {
    const { input } = await fixture(["-MixedControlTypes"]);
    input.scenario.steps = [
      {
        id: "ambiguous-id",
        name: "Reject a shared automation ID",
        action: "assertVisible",
        locator: { by: "automationId", automationId: "SaveButton" },
        expected: true,
        timeoutMs: 5_000,
      },
    ];
    const output = await runEntry(input);
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result).toMatchObject({ outcome: "blocked", reasonCode: "ambiguous_locator" });
  }, 45_000);
  it("narrows a shared automation ID to the requested control type before invoking", async () => {
    const { input } = await fixture(["-MixedControlTypes"]);
    input.scenario.steps = [
      {
        id: "fill-typed-locator",
        name: "Prepare the owned input",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: "typed locator fixture",
        timeoutMs: 5_000,
      },
      {
        id: "invoke-typed-id",
        name: "Invoke the shared-ID Button",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      textAssertion("Saved: typed locator fixture"),
      {
        id: "verify-other-type",
        name: "Verify the shared-ID Text control was unchanged",
        action: "assertText",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Text" },
        expected: "Shared-ID text control",
        match: "exact",
        timeoutMs: 5_000,
      },
    ];
    const output = await runEntry(input);
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result).toMatchObject({ outcome: "passed", evidenceComplete: true });
    expect(result.execution.steps[1]?.outcome).toBe("passed");
    expect(result.execution.steps[2]?.actual).toBe("Saved: typed locator fixture");
    expect(result.execution.steps[3]?.actual).toBe("Shared-ID text control");
  }, 45_000);
  it("keeps an automation ID ambiguous when the requested control type is duplicated", async () => {
    const { input } = await fixture(["-MixedControlTypes", "-DuplicateButton"]);
    input.scenario.steps = [
      {
        id: "ambiguous-typed-id",
        name: "Reject duplicate shared-ID Buttons",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      textAssertion("Waiting"),
    ];
    const output = await runEntry(input);
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result).toMatchObject({ outcome: "blocked", reasonCode: "ambiguous_locator" });
    expect(result.execution.steps[1]?.outcome).toBe("not_run");
  }, 45_000);
  it("does not record password values", async () => {
    const { input } = await fixture();
    input.scenario.steps = [
      {
        id: "secret-assertion",
        name: "Reject secret control",
        action: "assertValue",
        locator: { by: "automationId", automationId: "SecretBox" },
        expected: "anything",
        timeoutMs: 5_000,
      },
    ];
    const output = await runEntry(input);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result.reasonCode).toBe("unsupported_control");
    expect(output.stdout).not.toContain("fixture-secret");
    expect(result.execution.steps[0]?.actual).toBeNull();
  }, 45_000);
  it("fails closed after the owned root exits during a UI action", async () => {
    const { input } = await fixture(["-ExitAfterClick"]);
    input.scenario.steps = [
      {
        id: "exit-root",
        name: "Exit fixture",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton" },
        timeoutMs: 5_000,
      },
      textAssertion(),
      { ...textAssertion(), id: "never-reached" },
    ];
    const output = await runEntry(input);
    // UIA can hang while its provider exits; the watchdog must return no partial observations.
    if (output.code === 124) {
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("evidence is incomplete");
      return;
    }
    expect(output.code, output.stderr).toBe(0);
    const result = parseWindowsDriverResult(output.stdout, input);
    expect(result.outcome).toBe("blocked");
    expect(["ownership_lost", "provider_unavailable"]).toContain(result.reasonCode);
    expect(["not_run", "blocked"]).toContain(result.execution.steps[1]?.outcome);
    expect(result.execution.steps[1]?.actual).toBeNull();
    expect(result.execution.steps[2]?.outcome).toBe("not_run");
    expect(result.evidenceComplete).toBe(false);
  }, 45_000);
  it("accepts a live descendant with a verified creation-time ancestry", async () => {
    const { child, input } = await fixture(["-Descendant"]);
    input.scenario.steps = [textAssertion("Waiting")];
    try {
      const result = parseWindowsDriverResult((await runEntry(input)).stdout, input);
      expect(result.outcome, result.summary).toBe("passed");
    } finally {
      child.stdin?.end("stop\n");
      if (child.exitCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 45_000);
  it("keeps a persistent launcher usable when metadata siblings exit during readiness", async () => {
    const { child, input } = await fixture(["-Descendant", "-MetadataChildrenDuringReadiness"]);
    input.readiness.timeoutMs = 15_000;
    input.scenario.steps = [
      textAssertion("Waiting"),
      {
        id: "fill-after-metadata",
        name: "Fill the owned GUI after metadata helpers exit",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: "metadata sibling fixture",
        timeoutMs: 5_000,
      },
      {
        id: "click-after-metadata",
        name: "Invoke the owned GUI after metadata helpers exit",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      { ...textAssertion("Saved: metadata sibling fixture"), id: "assert-after-metadata" },
    ];
    try {
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "passed",
        evidenceComplete: true,
      });
      expect(result.execution.steps[2]?.outcome).toBe("passed");
      expect(result.execution.steps[3]?.actual).toBe("Saved: metadata sibling fixture");
      expect(child.exitCode).toBeNull();
    } finally {
      child.stdin?.end("stop\n");
      if (child.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Owned launcher cleanup exceeded its deadline.")),
            20_000,
          );
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      expect(child.exitCode).toBe(0);
    }
  }, 60_000);
  it("keeps a pinned descendant window usable after an unrelated helper exits on click", async () => {
    const { child, input } = await fixture([
      "-Descendant",
      "-HelperExitAfterClick",
      "-TracePublicInput",
    ]);
    input.scenario.steps = [
      { ...textAssertion("Waiting"), id: "pin-window" },
      {
        id: "exit-helper",
        name: "Exit the owned helper after pinning the window",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      {
        id: "empty-after-helper-exit",
        name: "Check the initial public input after helper exit",
        action: "assertValue",
        locator: { by: "automationId", automationId: "InputBox" },
        expected: "",
        timeoutMs: 5_000,
      },
      {
        id: "fill-after-helper-exit",
        name: "Fill the pinned GUI after the helper exits",
        action: "fill",
        locator: { by: "automationId", automationId: "InputBox" },
        value: "pinned helper fixture",
        timeoutMs: 5_000,
      },
      {
        id: "verify-filled-input",
        name: "Check the exact public input before saving",
        action: "assertValue",
        locator: { by: "automationId", automationId: "InputBox" },
        expected: "pinned helper fixture",
        timeoutMs: 5_000,
      },
      {
        id: "save-after-helper-exit",
        name: "Invoke the pinned GUI after the helper exits",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton", controlType: "Button" },
        timeoutMs: 5_000,
      },
      { ...textAssertion("Saved: pinned helper fixture"), id: "assert-after-helper-exit" },
    ];
    await withOwnedLauncher(child, async () => {
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "passed",
        evidenceComplete: true,
      });
      expect(result.execution.steps.map((step) => step.outcome)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed",
        "passed",
        "passed",
        "passed",
      ]);
      expect(result.execution.steps[6]?.actual).toBe("Saved: pinned helper fixture");
      expect(child.exitCode).toBeNull();
    });
  }, 90_000);
  it("rejects a pinned descendant window owner exiting while its launcher stays alive", async () => {
    const { child, input } = await fixture(["-Descendant", "-ExitAfterClick"]);
    input.scenario.steps = [
      { ...textAssertion("Waiting"), id: "pin-owner" },
      {
        id: "exit-owner",
        name: "Exit the pinned GUI owner",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton" },
        timeoutMs: 5_000,
      },
      { ...textAssertion("Waiting"), id: "observe-after-owner-exit" },
      { ...textAssertion("Waiting"), id: "never-after-owner-exit" },
    ];
    await withOwnedLauncher(child, async () => {
      const output = await runEntry(input);
      expect(output.stderr).toContain('"stepId":"pin-owner","outcome":"passed"');
      expect(child.exitCode).toBeNull();
      expect(await fixtureStatus(child)).toEqual({ guiAlive: false, ancestorAlive: true });
      // The provider can stop responding when its process exits; no partial result may escape.
      if (output.code === 124) {
        expect(output.stdout).toBe("");
        expect(output.stderr).toContain("evidence is incomplete");
        return;
      }
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result.outcome).toBe("blocked");
      // Exit can destroy the HWND before the held process becomes signaled. Independently
      // confirm actual GUI termination before accepting that window-closure outcome.
      expect(["ownership_lost", "provider_unavailable", "window_unavailable"]).toContain(
        result.reasonCode,
      );
      expect(result.execution.steps[0]?.outcome).toBe("passed");
      expect(["not_run", "blocked"]).toContain(result.execution.steps[2]?.outcome);
      expect(result.execution.steps[2]?.actual).toBeNull();
      expect(result.execution.steps[3]?.outcome).toBe("not_run");
      expect(result.evidenceComplete).toBe(false);
    });
  }, 90_000);
  it("rejects a pinned GUI whose intermediate ancestor exits while the GUI and root stay alive", async () => {
    const { child, input } = await fixture(["-AncestorExitAfterClick"]);
    input.readiness.timeoutMs = 15_000;
    input.scenario.steps = [
      { ...textAssertion("Waiting"), id: "pin-through-ancestor" },
      {
        id: "exit-ancestor",
        name: "Exit the pinned GUI owner's intermediate ancestor",
        action: "click",
        locator: { by: "automationId", automationId: "SaveButton" },
        timeoutMs: 5_000,
      },
      { ...textAssertion("Ancestor exited"), id: "observe-orphan" },
      { ...textAssertion("Ancestor exited"), id: "never-after-ancestor-exit" },
    ];
    await withOwnedLauncher(child, async () => {
      const output = await runEntry(input);
      expect(output.code, output.stderr).toBe(0);
      const result = parseWindowsDriverResult(output.stdout, input);
      expect(result, JSON.stringify(result)).toMatchObject({
        outcome: "blocked",
        reasonCode: "ownership_lost",
        evidenceComplete: false,
      });
      expect(result.execution.steps[0]?.outcome).toBe("passed");
      expect(["not_run", "blocked"]).toContain(result.execution.steps[2]?.outcome);
      expect(result.execution.steps[2]?.actual).toBeNull();
      expect(result.execution.steps[3]?.outcome).toBe("not_run");
      expect(child.exitCode).toBeNull();
      expect(await fixtureStatus(child)).toEqual({ guiAlive: true, ancestorAlive: false });
    });
  }, 90_000);
  it("terminates a blocked UIA provider within the step watchdog budget", async () => {
    const { input } = await fixture();
    input.scenario.steps = [
      {
        id: "hang-provider",
        name: "Block fixture UI thread",
        action: "click",
        locator: { by: "automationId", automationId: "HangButton" },
        timeoutMs: 1_000,
      },
      { ...textAssertion(), timeoutMs: 1_000 },
    ];
    const started = performance.now();
    const output = await runEntry(input);
    expect(output.code).toBe(124);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("evidence is incomplete");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 45_000);
});
