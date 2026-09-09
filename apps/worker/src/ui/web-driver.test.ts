import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebUiScenarioStep } from "@agentic-review/contracts";
import { chromium, type Frame, type Page, type Route, type WebSocketRoute } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseWebDriverRequest,
  parseWebDriverResult,
  parseWebUiObservationProbeResult,
  runWebUiScenario,
  serializeWebDriverResult,
  serializeWebDriverStepCompleted,
  type WebDriverBrowser,
  type WebDriverContext,
  type WebDriverLauncher,
  type WebDriverLocator,
  type WebDriverPage,
  type WebDriverRequest,
  type WebDriverResult,
  type WebDriverStepCompleted,
} from "./web-driver.js";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "web-driver-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function assertion(
  overrides: Partial<Extract<WebUiScenarioStep, { action: "assertText" }>> = {},
): WebUiScenarioStep {
  return {
    id: "assert-text",
    name: "Check result text",
    timeoutMs: 100,
    locator: { by: "testId", testId: "result" },
    action: "assertText",
    expected: "Saved",
    match: "exact",
    ...overrides,
  };
}
function request(steps: WebUiScenarioStep[] = [assertion()]): WebDriverRequest {
  return {
    schemaVersion: "WebDriverRequestV1",
    servicePort: 32123,
    browserExecutablePath: process.execPath,
    evidenceDirectory: directory,
    browser: { engine: "chromium", headless: true, viewport: { width: 800, height: 600 } },
    scenario: {
      id: "scenario-1",
      name: "Save public fixture input",
      required: true,
      path: "/",
      timeoutMs: 1_000,
      steps,
    },
    evidence: {
      screenshots: "every_assertion",
      screenshotScope: "viewport",
      trace: "always",
      required: true,
    },
  };
}

function harness() {
  let currentUrl = "about:blank";
  let currentValue = "";
  let routeHandler: ((route: Route) => Promise<void>) | null = null;
  let socketHandler: ((route: WebSocketRoute) => void) | null = null;
  let frameHandler: ((frame: Frame) => void) | null = null;
  let pageHandler: ((page: Page) => void) | null = null;
  const locator = {
    count: vi.fn<WebDriverLocator["count"]>().mockResolvedValue(1),
    click: vi.fn<WebDriverLocator["click"]>().mockResolvedValue(undefined),
    fill: vi.fn<WebDriverLocator["fill"]>().mockImplementation(async (value) => {
      currentValue = value;
    }),
    isVisible: vi.fn<WebDriverLocator["isVisible"]>().mockResolvedValue(true),
    innerText: vi.fn<WebDriverLocator["innerText"]>().mockResolvedValue("Saved"),
    inputValue: vi
      .fn<WebDriverLocator["inputValue"]>()
      .mockImplementation(async () => currentValue),
  } satisfies WebDriverLocator;
  const page = {
    goto: vi.fn<WebDriverPage["goto"]>().mockImplementation(async (url) => {
      currentUrl = url;
    }),
    url: () => currentUrl,
    mainFrame: () => ({ url: () => currentUrl }) as Frame,
    on: (_event: "framenavigated", handler: (frame: Frame) => void) => {
      frameHandler = handler;
    },
    getByRole: vi.fn<WebDriverPage["getByRole"]>().mockReturnValue(locator),
    getByTestId: vi.fn<WebDriverPage["getByTestId"]>().mockReturnValue(locator),
    screenshot: vi.fn<WebDriverPage["screenshot"]>().mockImplementation(async ({ path }) => {
      const bytes = Buffer.from("fixture screenshot");
      if (path !== undefined) await writeFile(path, bytes);
      return bytes;
    }),
  } satisfies WebDriverPage;
  const context = {
    route: vi.fn<WebDriverContext["route"]>().mockImplementation(async (_pattern, handler) => {
      routeHandler = handler;
    }),
    routeWebSocket: vi
      .fn<WebDriverContext["routeWebSocket"]>()
      .mockImplementation(async (_pattern, handler) => {
        socketHandler = handler;
      }),
    on: (_event: "page", handler: (page: Page) => void) => {
      pageHandler = handler;
    },
    newPage: vi.fn<WebDriverContext["newPage"]>().mockImplementation(async () => {
      pageHandler?.(page as unknown as Page);
      return page;
    }),
    tracing: {
      start: vi.fn<WebDriverContext["tracing"]["start"]>().mockResolvedValue(undefined),
      stop: vi.fn<WebDriverContext["tracing"]["stop"]>().mockImplementation(async (options) => {
        if (options?.path !== undefined) await writeFile(options.path, "fixture trace");
      }),
    },
    close: vi.fn<WebDriverContext["close"]>().mockResolvedValue(undefined),
  } satisfies WebDriverContext;
  const browser = {
    version: () => "fixture-chromium",
    newContext: vi.fn<WebDriverBrowser["newContext"]>().mockResolvedValue(context),
    close: vi.fn<WebDriverBrowser["close"]>().mockResolvedValue(undefined),
  } satisfies WebDriverBrowser;
  const launcher = {
    launch: vi.fn<WebDriverLauncher["launch"]>().mockResolvedValue(browser),
  } satisfies WebDriverLauncher;
  const controller = new AbortController();
  return {
    locator,
    page,
    context,
    browser,
    launcher,
    controller,
    dependencies: { chromium: launcher, signal: controller.signal },
    emitRoute: async (url: string, status = 200, location?: string) => {
      const route = {
        request: () => ({ url: () => url }),
        fetch: vi.fn().mockResolvedValue({
          status: () => status,
          headers: () => (location === undefined ? {} : { location }),
          dispose: vi.fn().mockResolvedValue(undefined),
        }),
        fulfill: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      };
      if (routeHandler === null) throw new Error("Request routing is not installed.");
      await routeHandler(route as unknown as Route);
      return route;
    },
    emitFrame: (url: string) => {
      currentUrl = url;
      frameHandler?.({ url: () => url } as Frame);
    },
    emitPopup: () => {
      const close = vi.fn().mockResolvedValue(undefined);
      pageHandler?.({ close } as unknown as Page);
      return close;
    },
    emitSocket: () => {
      const close = vi.fn().mockResolvedValue(undefined);
      socketHandler?.({ close } as unknown as WebSocketRoute);
      return close;
    },
  };
}

describe("Web driver request boundary", () => {
  it("accepts only an exact bounded observation capability probe response", () => {
    const supported = {
      schemaVersion: "WebUiObservationProbeResultV1",
      features: ["uiAssertionObservation1"],
    };
    expect(parseWebUiObservationProbeResult(JSON.stringify(supported))).toEqual(supported);
    for (const value of [
      { ...supported, features: [] },
      { ...supported, features: ["uiAssertionObservation1", "unknown"] },
      { ...supported, launch: true },
      { schemaVersion: "WebDriverResultV1" },
    ])
      expect(() => parseWebUiObservationProbeResult(JSON.stringify(value))).toThrow(TypeError);
    expect(() => parseWebUiObservationProbeResult(" ".repeat(1_025))).toThrow(TypeError);
  });
  it("accepts only the exact typed protocol", () => {
    expect(parseWebDriverRequest(request())).toEqual(request());
    expect(() => parseWebDriverRequest({ ...request(), verdict: "passed" })).toThrow();
    expect(() => parseWebDriverRequest({ ...request(), servicePort: 0 })).toThrow();
    expect(() =>
      parseWebDriverRequest({ ...request(), browserExecutablePath: "chromium" }),
    ).toThrow();
    expect(() =>
      parseWebDriverRequest({ ...request(), evidenceDirectory: "../evidence" }),
    ).toThrow();
    expect(() => parseWebDriverRequest(request([assertion({ expected: "\ud800" })]))).toThrow();
  });
  it.each(["//example.com", "/\\example.com", "/%5cexample.com", "/%00", "/invalid%zz"])(
    "rejects unsafe scenario path %s",
    (path) => {
      const input = request();
      input.scenario.path = path;
      expect(() => parseWebDriverRequest(input)).toThrow();
    },
  );
  it("requires a unique assertion identity and bounded budgets", () => {
    expect(() => parseWebDriverRequest(request([assertion(), assertion()]))).toThrow();
    expect(() => parseWebDriverRequest(request([assertion({ id: "scenario-1" })]))).toThrow();
    expect(() => parseWebDriverRequest(request([assertion({ timeoutMs: 1_001 })]))).toThrow();
    expect(() =>
      parseWebDriverRequest(request([assertion({ match: "contains", expected: "" })])),
    ).toThrow();
    expect(() =>
      parseWebDriverRequest(
        request([
          {
            id: "click",
            name: "Click",
            action: "click",
            locator: { by: "testId", testId: "button" },
            timeoutMs: 100,
          },
        ]),
      ),
    ).toThrow();
  });
});

describe("deterministic browser execution", () => {
  it("emits one progress event for each completed step without copying UI content", async () => {
    const h = harness();
    const events: WebDriverStepCompleted[] = [];
    const input = request([
      {
        id: "fill",
        name: "Private name must stay out of events",
        action: "fill",
        value: "Private fixture value",
        locator: { by: "testId", testId: "private-locator" },
        timeoutMs: 100,
      },
      assertion(),
    ]);
    const result = await runWebUiScenario(input, {
      ...h.dependencies,
      onStepCompleted: (event) => {
        events.push(event);
      },
    });
    expect(result.outcome).toBe("passed");
    expect(events).toEqual([
      { scenarioId: "scenario-1", stepId: "fill", outcome: "passed" },
      { scenarioId: "scenario-1", stepId: "assert-text", outcome: "passed" },
    ]);
    for (const event of events) {
      expect(Object.keys(JSON.parse(serializeWebDriverStepCompleted(event)))).toEqual([
        "type",
        "scenarioId",
        "stepId",
        "outcome",
      ]);
    }
    const serialized = events.map(serializeWebDriverStepCompleted).join("\n");
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("private-locator");
    expect(serialized).not.toContain("Saved");
  });

  it("emits a failed step once and never emits pending or skipped steps", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValue("Wrong");
    const onStepCompleted = vi.fn();
    const result = await runWebUiScenario(request([assertion(), assertion({ id: "later" })]), {
      ...h.dependencies,
      onStepCompleted,
    });
    expect(result.outcome).toBe("failed");
    expect(onStepCompleted).toHaveBeenCalledExactlyOnceWith({
      scenarioId: "scenario-1",
      stepId: "assert-text",
      outcome: "failed",
    });
    expect(h.locator.innerText.mock.calls.length).toBeGreaterThan(1);
    const cancelled = harness();
    cancelled.controller.abort();
    onStepCompleted.mockClear();
    await runWebUiScenario(request(), { ...cancelled.dependencies, onStepCompleted });
    expect(onStepCompleted).not.toHaveBeenCalled();
  });

  it("closes the browser when reporting actual step completion fails", async () => {
    const h = harness();
    const result = await runWebUiScenario(request(), {
      ...h.dependencies,
      onStepCompleted: () => {
        throw new Error("Private callback content");
      },
    });
    expect(result).toMatchObject({ outcome: "inconclusive", reasonCode: "progress_failed" });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.browser.close).toHaveBeenCalledOnce();
    expect(serializeWebDriverResult(result)).not.toContain("Private callback content");
  });

  it("reports an unavailable evidence directory without launching a browser", async () => {
    const h = harness();
    const input = request();
    input.evidenceDirectory = join(directory, "missing");
    expect(await runWebUiScenario(input, h.dependencies)).toMatchObject({
      outcome: "blocked",
      reasonCode: "evidence_failed",
      evidenceComplete: false,
    });
    expect(h.launcher.launch).not.toHaveBeenCalled();
  });
  it("executes all supported actions and finalizes bounded files with verified digests", async () => {
    const h = harness();
    const input = request([
      {
        id: "fill",
        name: "Fill fixture",
        action: "fill",
        value: "Ada",
        locator: { by: "role", role: "textbox", name: "Name" },
        timeoutMs: 100,
      },
      {
        id: "value",
        name: "Check value",
        timeoutMs: 100,
        locator: { by: "testId", testId: "name" },
        action: "assertValue",
        expected: "Ada",
      },
      {
        id: "click",
        name: "Save fixture",
        action: "click",
        locator: { by: "role", role: "button", name: "Save" },
        timeoutMs: 100,
      },
      {
        id: "visible",
        name: "Check visible",
        timeoutMs: 100,
        locator: { by: "testId", testId: "result" },
        action: "assertVisible",
        expected: true,
      },
      assertion(),
    ]);
    const result = await runWebUiScenario(input, h.dependencies);
    expect(result).toMatchObject({
      outcome: "passed",
      reasonCode: "completed",
      evidenceComplete: true,
    });
    expect(result.execution.steps.every((step) => step.outcome === "passed")).toBe(true);
    expect(h.page.getByRole).toHaveBeenCalledWith("textbox", {
      name: "Name",
      exact: true,
      includeHidden: true,
    });
    expect(h.context.route).toHaveBeenCalledBefore(h.context.newPage);
    expect(h.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: "block", acceptDownloads: false }),
    );
    expect(h.launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: process.execPath,
        headless: true,
        handleSIGINT: false,
      }),
    );
    expect(result.evidenceFiles.map((file) => file.kind)).toEqual([
      "screenshot",
      "screenshot",
      "screenshot",
      "trace",
      "ui_steps",
    ]);
    for (const asset of result.evidenceFiles) {
      const bytes = await readFile(join(directory, asset.relativePath));
      expect(bytes.byteLength).toBe(asset.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    }
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.browser.close).toHaveBeenCalledOnce();
    expect(JSON.parse(serializeWebDriverResult(result))).toEqual(result);
  });

  it("a wrong assertion fails and later steps remain not_run", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValue("Failed");
    const result = await runWebUiScenario(
      request([assertion(), assertion({ id: "later" })]),
      h.dependencies,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "assertion_failed",
      evidenceComplete: true,
    });
    expect(result.execution.steps[0]).toMatchObject({
      outcome: "failed",
      expected: "Saved",
      actual: "Failed",
    });
    expect(result.execution.steps[1]?.outcome).toBe("not_run");
    expect(h.page.screenshot).toHaveBeenCalledOnce();
  });

  it("polls asynchronously changing values without normalizing exact text", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValueOnce("Loading").mockResolvedValue("Saved");
    expect((await runWebUiScenario(request(), h.dependencies)).outcome).toBe("passed");
    h.locator.innerText.mockResolvedValue(" Saved ");
    expect((await runWebUiScenario(request(), h.dependencies)).outcome).toBe("failed");
  });

  it("supports contains assertions without hiding oversized actual values", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValue("Saved successfully");
    expect(
      (await runWebUiScenario(request([assertion({ match: "contains" })]), h.dependencies)).outcome,
    ).toBe("passed");
    h.locator.innerText.mockResolvedValue(`Saved${"x".repeat(2_048)}`);
    expect(
      (await runWebUiScenario(request([assertion({ match: "contains" })]), h.dependencies)).outcome,
    ).toBe("blocked");
  });

  it("does not pass a hidden assertion with ambiguous matching elements", async () => {
    const h = harness();
    h.locator.count.mockResolvedValue(2);
    h.locator.isVisible.mockResolvedValue(false);
    const step: WebUiScenarioStep = {
      id: "hidden",
      name: "Existing element is hidden",
      action: "assertVisible",
      expected: false,
      locator: { by: "testId", testId: "hidden" },
      timeoutMs: 100,
    };
    expect((await runWebUiScenario(request([step]), h.dependencies)).outcome).toBe("blocked");
  });

  it("passes hidden only for one existing hidden element", async () => {
    const h = harness();
    h.locator.isVisible.mockResolvedValue(false);
    const step: WebUiScenarioStep = {
      id: "hidden",
      name: "Existing element is hidden",
      action: "assertVisible",
      expected: false,
      locator: { by: "testId", testId: "hidden" },
      timeoutMs: 100,
    };
    expect(
      (await runWebUiScenario(request([step]), h.dependencies)).execution.steps[0],
    ).toMatchObject({ outcome: "passed", actual: false });
  });

  it("treats a browser action rejection as failed validation", async () => {
    const h = harness();
    h.locator.click.mockRejectedValue(new Error("Private internal details"));
    const result = await runWebUiScenario(
      request([
        {
          id: "click",
          name: "Save",
          action: "click",
          timeoutMs: 100,
          locator: { by: "testId", testId: "save" },
        },
        assertion(),
      ]),
      h.dependencies,
    );
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "action_failed" });
    expect(serializeWebDriverResult(result)).not.toContain("Private internal details");
  });

  it("does not declare a scenario passed when screenshot or trace finalization fails", async () => {
    const h = harness();
    h.page.screenshot.mockRejectedValue(new Error("Disk full"));
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "blocked",
      reasonCode: "evidence_failed",
      evidenceComplete: false,
    });
    const other = harness();
    other.context.tracing.stop.mockRejectedValue(new Error("Trace failure"));
    expect(await runWebUiScenario(request(), other.dependencies)).toMatchObject({
      outcome: "blocked",
      reasonCode: "evidence_failed",
      evidenceComplete: false,
    });
  });

  it("reports failed cleanup as inconclusive with incomplete evidence", async () => {
    const h = harness();
    h.context.close.mockRejectedValue(new Error("Context did not close"));
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "inconclusive",
      reasonCode: "cleanup_failed",
      evidenceComplete: false,
    });
    expect(h.browser.close).toHaveBeenCalledOnce();
  });

  it("marks total budget expiration inconclusive rather than a failed assertion", async () => {
    const h = harness();
    h.locator.count.mockImplementation(() => new Promise(() => undefined));
    expect(
      await runWebUiScenario(request([assertion({ timeoutMs: 1_000 })]), h.dependencies),
    ).toMatchObject({
      outcome: "inconclusive",
      reasonCode: "scenario_timeout",
      evidenceComplete: false,
    });
    expect(h.context.close).toHaveBeenCalledOnce();
    expect(h.browser.close).toHaveBeenCalledOnce();
  });

  it("enforces the step timeout even when a locator read never settles", async () => {
    const h = harness();
    h.locator.count.mockImplementation(() => new Promise(() => undefined));
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "inconclusive",
      reasonCode: "observation_unavailable",
    });
  });

  it("does not pass hidden when the sole matching element disappears during sampling", async () => {
    const h = harness();
    h.locator.count.mockResolvedValueOnce(1).mockResolvedValue(0);
    h.locator.isVisible.mockResolvedValue(false);
    const input = request([
      {
        id: "hidden",
        name: "Still exists",
        timeoutMs: 100,
        action: "assertVisible",
        expected: false,
        locator: { by: "testId", testId: "hidden" },
      },
    ]);
    expect((await runWebUiScenario(input, h.dependencies)).execution.steps[0]).toMatchObject({
      outcome: "blocked",
      actual: null,
    });
  });

  it("honors cancellation during evidence finalization", async () => {
    const h = harness();
    h.context.tracing.stop.mockImplementation(async () => {
      h.controller.abort();
    });
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "inconclusive",
      reasonCode: "aborted",
      evidenceComplete: false,
    });
  });

  it("cancels pending operations and never launches an already cancelled scenario", async () => {
    const h = harness();
    h.controller.abort();
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "inconclusive",
      reasonCode: "aborted",
      evidenceComplete: false,
    });
    expect(h.launcher.launch).not.toHaveBeenCalled();
    const other = harness();
    other.locator.click.mockImplementation(async () => {
      other.controller.abort();
      throw new Error("Cancelled");
    });
    expect(
      await runWebUiScenario(
        request([
          {
            id: "click",
            name: "Save",
            action: "click",
            timeoutMs: 100,
            locator: { by: "testId", testId: "save" },
          },
          assertion(),
        ]),
        other.dependencies,
      ),
    ).toMatchObject({ outcome: "inconclusive", reasonCode: "aborted" });
    expect(other.context.close).toHaveBeenCalledOnce();
  });

  it("closes a browser which arrives after cancellation won startup", async () => {
    const h = harness();
    let completeLaunch: ((browser: WebDriverBrowser) => void) | undefined;
    h.launcher.launch.mockImplementation(
      () =>
        new Promise((resolveLaunch) => {
          completeLaunch = resolveLaunch;
          h.controller.abort();
        }),
    );
    expect((await runWebUiScenario(request(), h.dependencies)).reasonCode).toBe("aborted");
    completeLaunch?.(h.browser);
    await Promise.resolve();
    expect(h.browser.close).toHaveBeenCalledOnce();
  });

  it("can retain only structured assertion evidence for a clean on-failure policy", async () => {
    const input = request();
    input.evidence.screenshots = "on_failure";
    input.evidence.trace = "on_failure";
    const result = await runWebUiScenario(input, harness().dependencies);
    expect(result.evidenceComplete).toBe(true);
    expect(result.evidenceFiles.map((file) => file.kind)).toEqual(["ui_steps"]);
  });
});

describe("versioned assertion observations", () => {
  function mapped(steps?: WebUiScenarioStep[]): WebDriverRequest {
    const input = request(steps);
    return {
      ...input,
      evidence: { ...input.evidence, trace: "off" },
      observationProtocol: "UiAssertionCaptureV1",
    };
  }

  it.each(["always", "on_failure"] as const)(
    "rejects mapped trace policy %s before capture",
    async (trace) => {
      const h = harness();
      const input = mapped();
      input.evidence.trace = trace;
      await expect(runWebUiScenario(input, h.dependencies)).rejects.toThrow(
        "trace policy to be off",
      );
      expect(h.launcher.launch).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe frozen expected and fill values before starting the browser", async () => {
    const unsafe = "Authorization: Bearer private-fixture-token";
    for (const steps of [
      [assertion({ expected: unsafe })],
      [
        {
          id: "fill",
          name: "Fill",
          action: "fill" as const,
          value: unsafe,
          locator: { by: "testId" as const, testId: "input" },
          timeoutMs: 100,
        },
        assertion(),
      ],
    ]) {
      const h = harness();
      await expect(runWebUiScenario(mapped(steps), h.dependencies)).rejects.toThrow(
        "unsafe configured text",
      );
      expect(h.launcher.launch).not.toHaveBeenCalled();
    }
    const h = harness();
    h.locator.innerText.mockResolvedValue("");
    const result = await runWebUiScenario(mapped([assertion({ expected: "" })]), h.dependencies);
    expect(result.execution.steps[0]).toMatchObject({
      outcome: "passed",
      actual: "",
      capture: { state: "complete" },
    });
  });

  it("emits capture only after the private request opts in", async () => {
    const legacy = await runWebUiScenario(request(), harness().dependencies);
    expect(legacy.execution.steps[0]).not.toHaveProperty("capture");
    const input = mapped();
    const observed = await runWebUiScenario(input, harness().dependencies);
    expect(observed.execution.steps[0]).toMatchObject({
      outcome: "passed",
      actual: "Saved",
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
    });
    expect(parseWebDriverResult(JSON.stringify(observed), input)).toEqual(observed);
    expect(observed.evidenceFiles.some((asset) => asset.kind === "trace")).toBe(false);
  });

  it("never starts tracing with the frozen off policy and rejects an injected trace asset", async () => {
    const h = harness();
    const input = mapped();
    const result = await runWebUiScenario(input, h.dependencies);
    expect(h.context.tracing.start).not.toHaveBeenCalled();
    expect(h.context.tracing.stop).not.toHaveBeenCalled();
    const directoryName = result.evidenceFiles[0]?.relativePath.split("/")[0];
    result.evidenceFiles.push({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      relativePath: `${directoryName}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.zip`,
      kind: "trace",
      mediaType: "application/zip",
      sizeBytes: 1,
      sha256: "a".repeat(64),
    });
    expect(() => parseWebDriverResult(JSON.stringify(result), input)).toThrow(TypeError);
  });

  it("does not accept a completed observation as a provider failure", async () => {
    const input = mapped();
    const result = await runWebUiScenario(input, harness().dependencies);
    result.outcome = "blocked";
    result.reasonCode = "observation_unavailable";
    expect(() => parseWebDriverResult(JSON.stringify(result), input)).toThrow(TypeError);
  });

  it("retains a terminal complete mismatch and never executes later assertions", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValue("Duplicate");
    const input = mapped([assertion({ expected: "Ready" }), assertion({ id: "later" })]);
    const result = await runWebUiScenario(input, h.dependencies);
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "assertion_failed" });
    expect(result.execution.steps[0]).toMatchObject({
      actual: "Duplicate",
      outcome: "failed",
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
    });
    expect(result.execution.steps[1]).toMatchObject({
      actual: null,
      outcome: "not_run",
      capture: { state: "unavailable", reason: "not_run" },
    });
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
  });

  it.each([false, true])(
    "captures a fresh absent visibility value when expecting %s",
    async (expected) => {
      const h = harness();
      h.locator.count.mockResolvedValue(0);
      const input = mapped([
        {
          id: "visible",
          name: "Visibility",
          action: "assertVisible",
          expected,
          locator: { by: "testId", testId: "result" },
          timeoutMs: 100,
        },
      ]);
      const result = await runWebUiScenario(input, h.dependencies);
      expect(result.execution.steps[0]).toMatchObject({
        actual: false,
        outcome: expected ? "failed" : "passed",
        capture: { state: "complete" },
      });
      expect(h.locator.isVisible).not.toHaveBeenCalled();
      expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    },
  );

  it.each(["missing_element", "ambiguous_element", "provider_error", "timeout"] as const)(
    "invalidates a previous mismatch after a later %s read",
    async (reason) => {
      const h = harness();
      h.locator.innerText.mockResolvedValue("Duplicate");
      h.locator.count.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      if (reason === "missing_element") h.locator.count.mockResolvedValue(0);
      else if (reason === "ambiguous_element") h.locator.count.mockResolvedValue(2);
      else if (reason === "provider_error")
        h.locator.count.mockRejectedValue(new Error("Private provider error"));
      else h.locator.count.mockImplementation(() => new Promise(() => undefined));
      const input = mapped([assertion({ expected: "Ready" })]);
      const result = await runWebUiScenario(input, h.dependencies);
      expect(result.reasonCode).toBe("observation_unavailable");
      expect(result.execution.steps[0]).toMatchObject({
        actual: null,
        capture: { state: "unavailable", reason },
      });
      expect(result.execution.steps[0]?.outcome).not.toBe("failed");
      expect(h.locator.innerText).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("Duplicate");
      expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    },
  );

  it.each(["assertText", "assertValue"] as const)(
    "rechecks uniqueness after %s",
    async (action) => {
      const h = harness();
      h.locator.count.mockResolvedValueOnce(1).mockResolvedValue(2);
      h.locator.inputValue.mockResolvedValue("Saved");
      const step: WebUiScenarioStep =
        action === "assertText"
          ? assertion()
          : {
              id: "value",
              name: "Value",
              action,
              expected: "Saved",
              locator: { by: "testId", testId: "result" },
              timeoutMs: 100,
            };
      const input = mapped([step]);
      const result = await runWebUiScenario(input, h.dependencies);
      expect(result.execution.steps[0]).toMatchObject({
        outcome: "blocked",
        actual: null,
        capture: { state: "unavailable", reason: "ambiguous_element" },
      });
      expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    },
  );

  it("invalidates an earlier mismatch when a later value exceeds the complete value bound", async () => {
    const h = harness();
    h.locator.innerText.mockResolvedValueOnce("Duplicate").mockResolvedValue("x".repeat(2_049));
    const result = await runWebUiScenario(
      mapped([assertion({ expected: "Ready" })]),
      h.dependencies,
    );
    expect(result.execution.steps[0]).toMatchObject({
      outcome: "blocked",
      actual: null,
      capture: { state: "unavailable", reason: "oversized_value" },
    });
    expect(result.evidenceComplete).toBe(false);
    expect(result.evidenceFiles.map((asset) => asset.kind)).toEqual(["ui_steps"]);
    expect(JSON.stringify(result)).not.toContain("Duplicate");
  });

  it.each(["cancelled", "capture_failed"] as const)(
    "invalidates an in-flight value after %s",
    async (reason) => {
      const h = harness();
      h.locator.innerText.mockResolvedValueOnce("Duplicate").mockImplementation(async () => {
        if (reason === "cancelled") h.controller.abort();
        else {
          h.emitFrame("https://outside.invalid/");
          h.emitFrame("http://127.0.0.1:32123/");
        }
        return "Ready";
      });
      const input = mapped([assertion({ expected: "Ready" })]);
      const result = await runWebUiScenario(input, h.dependencies);
      expect(result.evidenceComplete).toBe(false);
      expect(result.execution.steps[0]).toMatchObject({
        actual: null,
        capture: { state: "unavailable", reason },
      });
      expect(JSON.stringify(result)).not.toContain("Duplicate");
      expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    },
  );

  it("rejects unsafe original values before any screenshot or trace becomes durable", async () => {
    const h = harness();
    const unsafe = "ghp_1234567890abcdefghijk";
    h.locator.innerText.mockResolvedValueOnce("Saved").mockResolvedValue(unsafe);
    const input = mapped([assertion(), assertion({ id: "unsafe" })]);
    const result = await runWebUiScenario(input, h.dependencies);
    expect(result).toMatchObject({
      outcome: "blocked",
      reasonCode: "observation_unavailable",
      evidenceComplete: false,
    });
    expect(result.execution.steps[1]).toMatchObject({
      actual: null,
      capture: { state: "unavailable", reason: "unsafe_value" },
    });
    expect(result.execution.steps.every((step) => step.evidenceIds.length === 0)).toBe(true);
    expect(result.evidenceFiles.map((asset) => asset.kind)).toEqual(["ui_steps"]);
    expect(h.context.tracing.start).not.toHaveBeenCalled();
    expect(h.page.screenshot).toHaveBeenCalledOnce();
    expect(h.page.screenshot.mock.calls[0]?.[0]).not.toHaveProperty("path");
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      expect(entry.name).not.toMatch(/\.(png|zip)$/u);
      expect(
        (await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(unsafe)),
      ).toBe(false);
    }
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
  });

  it.each([
    "missing_capture",
    "false_failure",
    "unavailable_with_value",
    "post_failure_execution",
  ] as const)("rejects forged mapped execution semantics: %s", async (kind) => {
    const h = harness();
    h.locator.innerText.mockResolvedValue("Duplicate");
    const input = mapped([assertion({ expected: "Ready" }), assertion({ id: "later" })]);
    const result = await runWebUiScenario(input, h.dependencies);
    const step = result.execution.steps[0];
    if (step?.action !== "assertText") throw new Error("Missing fixture assertion.");
    if (kind === "missing_capture") delete step.capture;
    else if (kind === "false_failure") step.actual = "Ready";
    else if (kind === "unavailable_with_value")
      step.capture = {
        schemaVersion: "UiAssertionCaptureV1",
        state: "unavailable",
        reason: "provider_error",
      };
    else {
      const later = result.execution.steps[1];
      if (later?.action !== "assertText") throw new Error("Missing later fixture assertion.");
      later.outcome = "passed";
      later.actual = "Saved";
      later.capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
    }
    const bytes = Buffer.from(JSON.stringify(result.execution), "utf8");
    const asset = result.evidenceFiles.find((item) => item.kind === "ui_steps");
    if (asset === undefined) throw new Error("Missing fixture evidence asset.");
    asset.sizeBytes = bytes.byteLength;
    asset.sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() => parseWebDriverResult(JSON.stringify(result), input)).toThrow(TypeError);
  });
});

describe("managed origin enforcement", () => {
  it("accepts the allocated default HTTP port after URL canonicalization", async () => {
    const h = harness();
    const input = request();
    input.servicePort = 80;
    expect((await runWebUiScenario(input, h.dependencies)).outcome).toBe("passed");
  });
  it.each([
    "https://example.com/",
    "http://127.0.0.1:32124/",
    "http://localhost:32123/",
    "http://user@127.0.0.1:32123/",
  ])("blocks external request %s before fetch", async (url) => {
    const h = harness();
    h.page.goto.mockImplementation(async () => {
      const route = await h.emitRoute(url);
      expect(route.fetch).not.toHaveBeenCalled();
      expect(route.abort).toHaveBeenCalled();
    });
    expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
      outcome: "blocked",
      reasonCode: "origin_violation",
    });
  });

  it.each([301, 302, 303, 307, 308])(
    "blocks an external %s redirect without following it",
    async (status) => {
      const h = harness();
      h.page.goto.mockImplementation(async () => {
        const route = await h.emitRoute(
          "http://127.0.0.1:32123/",
          status,
          "https://example.com/private",
        );
        expect(route.fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
        expect(route.fulfill).not.toHaveBeenCalled();
      });
      expect((await runWebUiScenario(request(), h.dependencies)).reasonCode).toBe(
        "origin_violation",
      );
    },
  );

  it("reports same-origin redirects as unsupported instead of rewriting browser URL semantics", async () => {
    const h = harness();
    h.page.goto.mockImplementation(async () => {
      await h.emitRoute("http://127.0.0.1:32123/", 302, "/next");
    });
    expect((await runWebUiScenario(request(), h.dependencies)).reasonCode).toBe(
      "unsupported_redirect",
    );
  });

  it.each(["data:text/html,Hello", "file:///tmp/data", "blob:http://127.0.0.1:32123/token"])(
    "latches non-network navigation %s",
    async (url) => {
      const h = harness();
      h.locator.innerText.mockImplementation(async () => {
        h.emitFrame(url);
        h.emitFrame("http://127.0.0.1:32123/");
        return "Saved";
      });
      expect(await runWebUiScenario(request(), h.dependencies)).toMatchObject({
        outcome: "blocked",
        reasonCode: "origin_violation",
      });
    },
  );

  it("blocks unexpected popups and WebSocket transport", async () => {
    const h = harness();
    h.locator.innerText.mockImplementation(async () => {
      h.emitPopup();
      return "Saved";
    });
    expect((await runWebUiScenario(request(), h.dependencies)).reasonCode).toBe(
      "unsupported_popup",
    );
    const other = harness();
    other.locator.innerText.mockImplementation(async () => {
      other.emitSocket();
      return "Saved";
    });
    expect((await runWebUiScenario(request(), other.dependencies)).reasonCode).toBe(
      "unsupported_websocket",
    );
  });
});

const browserExecutable = process.env.AGENTIC_REVIEW_WEB_DRIVER_CHROMIUM;
describe("owned driver result parsing", () => {
  async function valid() {
    const input = request();
    const result = await runWebUiScenario(input, harness().dependencies);
    return { input, result };
  }
  it("accepts the complete owned result and preserves a real failed assertion", async () => {
    const { input, result } = await valid();
    expect(parseWebDriverResult(serializeWebDriverResult(result), input)).toEqual(result);
    const h = harness();
    h.locator.innerText.mockResolvedValue("Wrong");
    const failed = await runWebUiScenario(input, h.dependencies);
    expect(parseWebDriverResult(JSON.stringify(failed), input).outcome).toBe("failed");
  });
  it.each([
    [
      "scenario identity",
      (result: WebDriverResult) => {
        result.scenarioId = "other";
      },
    ],
    [
      "execution identity",
      (result: WebDriverResult) => {
        result.execution.scenarioId = "other";
      },
    ],
    [
      "step identity",
      (result: WebDriverResult) => {
        const step = result.execution.steps[0];
        if (step) step.stepId = "other";
      },
    ],
    [
      "step name",
      (result: WebDriverResult) => {
        const step = result.execution.steps[0];
        if (step) step.name = "Other";
      },
    ],
    [
      "expected value",
      (result: WebDriverResult) => {
        const step = result.execution.steps[0];
        if (step?.action === "assertText") step.expected = "Other";
      },
    ],
    [
      "false positive text",
      (result: WebDriverResult) => {
        const step = result.execution.steps[0];
        if (step?.action === "assertText") step.actual = "Wrong";
      },
    ],
    [
      "null actual",
      (result: WebDriverResult) => {
        const step = result.execution.steps[0];
        if (step?.action === "assertText") step.actual = null;
      },
    ],
    [
      "passed with incomplete evidence",
      (result: WebDriverResult) => {
        result.evidenceComplete = false;
      },
    ],
    [
      "incorrect completion reason",
      (result: WebDriverResult) => {
        result.reasonCode = "assertion_failed";
      },
    ],
    [
      "missing required trace",
      (result: WebDriverResult) => {
        result.evidenceFiles = result.evidenceFiles.filter((asset) => asset.kind !== "trace");
      },
    ],
    [
      "missing structured evidence",
      (result: WebDriverResult) => {
        result.evidenceFiles = result.evidenceFiles.filter((asset) => asset.kind !== "ui_steps");
      },
    ],
    [
      "missing referenced screenshot",
      (result: WebDriverResult) => {
        result.evidenceFiles = result.evidenceFiles.filter((asset) => asset.kind !== "screenshot");
      },
    ],
    [
      "wrong structured digest",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles.find((asset) => asset.kind === "ui_steps");
        if (file) file.sha256 = "a".repeat(64);
      },
    ],
    [
      "wrong structured size",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles.find((asset) => asset.kind === "ui_steps");
        if (file) file.sizeBytes += 1;
      },
    ],
    [
      "wrong media type",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles.find((asset) => asset.kind === "screenshot");
        if (file) file.mediaType = "application/json";
      },
    ],
    [
      "wrong file identity",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles[0];
        if (file) file.id = "other";
      },
    ],
    [
      "oversized screenshot",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles.find((asset) => asset.kind === "screenshot");
        if (file) file.sizeBytes = 16 * 1024 * 1024 + 1;
      },
    ],
    [
      "duplicate asset",
      (result: WebDriverResult) => {
        const file = result.evidenceFiles[0];
        if (file) result.evidenceFiles.push(file);
      },
    ],
  ] as const)("rejects %s", async (_name, mutate) => {
    const { input, result } = await valid();
    mutate(result);
    expect(() => parseWebDriverResult(JSON.stringify(result), input)).toThrow(TypeError);
  });
  it("rejects malformed or oversized output without reflecting it in the error", async () => {
    const { input } = await valid();
    for (const stdout of ["{private-invalid", "{}\n{}", " ".repeat(512 * 1024 + 1)]) {
      expect(() => parseWebDriverResult(stdout, input)).toThrow(
        "The Web driver result did not match",
      );
    }
  });
  it("does not trust a visible assertion claiming pass with false actual", async () => {
    const input = request([
      {
        id: "visible",
        name: "Visible",
        action: "assertVisible",
        expected: true,
        timeoutMs: 100,
        locator: { by: "testId", testId: "result" },
      },
    ]);
    const result = await runWebUiScenario(input, harness().dependencies);
    const step = result.execution.steps[0];
    if (step?.action === "assertVisible") step.actual = false;
    expect(() => parseWebDriverResult(JSON.stringify(result), input)).toThrow(TypeError);
  });
});
describe.skipIf(browserExecutable === undefined)("real isolated Chromium fixture", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0))
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error === undefined ? resolveClose() : reject(error))),
      );
  });
  async function serve(handler: RequestListener): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture did not bind an owned loopback port.");
    return address.port;
  }
  it("runs fill/click/visibility/text/value and records real screenshot and trace bytes", async () => {
    const port = await serve((_req, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<label>Name<input aria-label="Name" data-testid="name"></label><button onclick="document.querySelector(\'[data-testid=result]\').textContent=\'Saved\'">Save</button><p data-testid="result">Waiting</p>',
      );
    });
    const input = request([
      {
        id: "fill",
        name: "Fill",
        action: "fill",
        value: "Ada",
        locator: { by: "role", role: "textbox", name: "Name" },
        timeoutMs: 1_000,
      },
      {
        id: "value",
        name: "Value",
        action: "assertValue",
        expected: "Ada",
        locator: { by: "testId", testId: "name" },
        timeoutMs: 1_000,
      },
      {
        id: "click",
        name: "Click",
        action: "click",
        locator: { by: "role", role: "button", name: "Save" },
        timeoutMs: 1_000,
      },
      {
        id: "visible",
        name: "Visible",
        action: "assertVisible",
        expected: true,
        locator: { by: "testId", testId: "result" },
        timeoutMs: 1_000,
      },
      assertion({ timeoutMs: 1_000 }),
    ]);
    input.scenario.timeoutMs = 20_000;
    input.servicePort = port;
    input.browserExecutablePath = browserExecutable ?? "";
    const result = await runWebUiScenario(input, {
      chromium,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: "passed", evidenceComplete: true });
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    expect(result.browserVersion).not.toBe("fixture-chromium");
    const screenshot = result.evidenceFiles.find((file) => file.kind === "screenshot");
    const trace = result.evidenceFiles.find((file) => file.kind === "trace");
    expect(screenshot).toBeDefined();
    expect(trace).toBeDefined();
    expect(
      (await readFile(join(directory, screenshot?.relativePath ?? "")))
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    expect(
      (await readFile(join(directory, trace?.relativePath ?? ""))).subarray(0, 2).toString(),
    ).toBe("PK");
  }, 30_000);
  it("a real false assertion fails and retains failure evidence", async () => {
    const port = await serve((_req, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<p data-testid="result">Failure</p>');
    });
    const input = request();
    input.scenario.timeoutMs = 20_000;
    input.servicePort = port;
    input.browserExecutablePath = browserExecutable ?? "";
    const result = await runWebUiScenario(input, {
      chromium,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "assertion_failed",
      evidenceComplete: true,
    });
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
    expect(result.execution.steps[0]).toMatchObject({ expected: "Saved", actual: "Failure" });
  }, 30_000);
  it("captures a real complete mismatch through the opt-in observation protocol", async () => {
    const port = await serve((_req, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<p data-testid="result">Duplicate</p>');
    });
    const input: WebDriverRequest = {
      ...request([assertion({ expected: "Ready", timeoutMs: 300 })]),
      observationProtocol: "UiAssertionCaptureV1",
      servicePort: port,
      browserExecutablePath: browserExecutable ?? "",
    };
    input.evidence.trace = "off";
    input.scenario.timeoutMs = 20_000;
    const result = await runWebUiScenario(input, {
      chromium,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "assertion_failed",
      evidenceComplete: true,
    });
    expect(result.execution.steps[0]).toMatchObject({
      expected: "Ready",
      actual: "Duplicate",
      outcome: "failed",
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
    });
    expect(result.execution.steps[0]?.evidenceIds).toHaveLength(1);
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
  }, 30_000);
  it("does not write real screenshot or trace files when the observed value is unsafe", async () => {
    const unsafe = "ghp_1234567890abcdefghijk";
    const port = await serve((_req, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<p data-testid="result">${unsafe}</p>`);
    });
    const input: WebDriverRequest = {
      ...request(),
      observationProtocol: "UiAssertionCaptureV1",
      servicePort: port,
      browserExecutablePath: browserExecutable ?? "",
    };
    input.evidence.trace = "off";
    input.scenario.timeoutMs = 20_000;
    const result = await runWebUiScenario(input, {
      chromium,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: "blocked",
      reasonCode: "observation_unavailable",
      evidenceComplete: false,
    });
    expect(result.execution.steps[0]).toMatchObject({
      actual: null,
      capture: { state: "unavailable", reason: "unsafe_value" },
    });
    expect(result.evidenceFiles.map((asset) => asset.kind)).toEqual(["ui_steps"]);
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      expect(entry.name).not.toMatch(/\.(png|zip)$/u);
      expect(
        (await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(unsafe)),
      ).toBe(false);
    }
    expect(parseWebDriverResult(JSON.stringify(result), input)).toEqual(result);
  }, 30_000);
  it("a real cross-origin redirect sends no request to the other server", async () => {
    let externalRequests = 0;
    const externalPort = await serve((_req, response) => {
      externalRequests += 1;
      response.end("Should not be requested");
    });
    const port = await serve((_req, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${externalPort}/escape` });
      response.end();
    });
    const input = request();
    input.scenario.timeoutMs = 20_000;
    input.servicePort = port;
    input.browserExecutablePath = browserExecutable ?? "";
    expect(
      await runWebUiScenario(input, { chromium, signal: new AbortController().signal }),
    ).toMatchObject({ outcome: "blocked", reasonCode: "origin_violation" });
    expect(externalRequests).toBe(0);
  }, 30_000);
});
