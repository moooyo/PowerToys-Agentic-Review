import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  getValidationProfileConfigIssues,
  type ValidationProfileConfig,
  ValidationProfileConfigSchema,
} from "./platform-configuration.js";
import {
  getUiScenarioConfigurationIssues,
  isUiAssertionAction,
  resolveManagedWebUiUrl,
  UiDriverCapabilities,
  UiScenarioConfigurationSchema,
  UiScenarioExecutionEvidenceV1Schema,
  UiStepExecutionEvidenceSchema,
  type WebUiConfiguration,
  WebUiLocatorSchema,
  type WebUiScenarioStep,
  WebUiScenarioStepSchema,
  type WindowsUiConfiguration,
  type WindowsUiLocator,
  WindowsUiLocatorSchema,
  WindowsUiScenarioStepSchema,
} from "./ui-scenarios.js";

function requireFirst<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("The scenario test fixture must not be empty.");
  return first;
}

const assertion = {
  id: "assert-title",
  name: "The saved title is visible",
  action: "assertText",
  locator: { by: "testId", testId: "saved-title" },
  expected: "Example title",
  match: "exact",
  timeoutMs: 5_000,
} satisfies WebUiScenarioStep;

const webUi: WebUiConfiguration = {
  schemaVersion: "UiScenariosV1",
  target: "web",
  service: {
    origin: "managed_loopback",
    portEnvironmentVariable: "UI_TEST_PORT",
    navigation: "same_origin",
  },
  browser: { engine: "chromium", headless: true, viewport: { width: 1_280, height: 720 } },
  launch: {
    stepId: "launch-app",
    mode: "persistent",
    readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 30_000 },
  },
  reset: { strategy: "commands", stepIds: ["reset-data"] },
  scenarios: [
    {
      id: "save-title",
      name: "Save a title",
      required: true,
      timeoutMs: 60_000,
      path: "/editor",
      steps: [
        {
          id: "fill-title",
          name: "Enter a title",
          action: "fill",
          locator: { by: "role", role: "textbox", name: "Title" },
          value: "Example title",
          timeoutMs: 5_000,
        },
        {
          id: "click-save",
          name: "Save the title",
          action: "click",
          locator: { by: "role", role: "button", name: "Save" },
          timeoutMs: 5_000,
        },
        assertion,
      ],
    },
  ],
  evidence: {
    screenshots: "every_assertion",
    screenshotScope: "viewport",
    trace: "on_failure",
    required: true,
  },
};

const windowsUi: WindowsUiConfiguration = {
  schemaVersion: "UiScenariosV1",
  target: "windows_desktop",
  desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
  launch: {
    stepId: "launch-app",
    mode: "persistent",
    readiness: { kind: "window", window: { title: "Validation fixture" }, timeoutMs: 30_000 },
  },
  reset: { strategy: "restart_process" },
  scenarios: [
    {
      id: "edit-value",
      name: "Edit a value",
      required: true,
      timeoutMs: 60_000,
      steps: [
        {
          id: "fill-value",
          name: "Enter a value",
          action: "fill",
          locator: { by: "automationId", automationId: "ValueInput" },
          value: "Example value",
          timeoutMs: 5_000,
        },
        {
          id: "assert-value",
          name: "The value is retained",
          action: "assertValue",
          locator: { by: "name", controlType: "Edit", name: "Value" },
          expected: "Example value",
          timeoutMs: 5_000,
        },
      ],
    },
  ],
  evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
};

const profile: ValidationProfileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [
    {
      id: "reset-data",
      name: "Reset fixture data",
      command: { executable: "node", args: ["reset.mjs"], workingDirectory: ".", environment: [] },
      timeoutMs: 30_000,
      required: true,
    },
  ],
  build: [],
  test: [],
  launch: [
    {
      id: "launch-app",
      name: "Launch the fixture",
      command: { executable: "node", args: ["app.mjs"], workingDirectory: ".", environment: [] },
      timeoutMs: 120_000,
      required: true,
    },
  ],
  cleanup: [],
  requiredCapabilities: [UiDriverCapabilities.web],
  hardTimeoutMs: 600_000,
  noProgressTimeoutMs: 120_000,
  ui: webUi,
};

describe("typed UI scenario configuration", () => {
  it("supports managed Web and owned Windows UI validation with real assertions", () => {
    expect(Value.Check(UiScenarioConfigurationSchema, webUi)).toBe(true);
    expect(Value.Check(UiScenarioConfigurationSchema, windowsUi)).toBe(true);
    expect(getUiScenarioConfigurationIssues(webUi)).toEqual([]);
    expect(getUiScenarioConfigurationIssues(windowsUi)).toEqual([]);
    expect(getValidationProfileConfigIssues(profile, "pr_ui", "web")).toEqual([]);
    expect(
      getValidationProfileConfigIssues(
        { ...profile, ui: windowsUi },
        "issue_validation",
        "windows_desktop",
      ),
    ).toEqual([]);
  });

  it.each(["navigate", "evaluate", "script", "pressKey", "drag", "screenshot"])(
    "does not advertise the unsupported %s action",
    (action) => {
      expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, action })).toBe(false);
    },
  );

  it("keeps typed expected values in configuration and driver actual values out", () => {
    expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, actual: "Pretend pass" })).toBe(
      false,
    );
    expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, outcome: "passed" })).toBe(false);
    expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, expected: true })).toBe(false);
    const visibility = {
      id: "visible",
      name: "The control is visible",
      action: "assertVisible",
      expected: true,
      locator: { by: "testId", testId: "control" },
      timeoutMs: 5_000,
    };
    expect(Value.Check(WebUiScenarioStepSchema, visibility)).toBe(true);
    expect(Value.Check(WebUiScenarioStepSchema, { ...visibility, expected: "true" })).toBe(false);
  });

  it("keeps locators exact and scoped instead of accepting scripts, coordinates, or selectors", () => {
    expect(Value.Check(WebUiLocatorSchema, { by: "role", role: "button", name: "Save" })).toBe(
      true,
    );
    expect(Value.Check(WebUiLocatorSchema, { by: "css", selector: "body *" })).toBe(false);
    expect(
      Value.Check(WebUiLocatorSchema, { by: "role", role: "button", name: ".*", regex: true }),
    ).toBe(false);
    expect(Value.Check(WindowsUiLocatorSchema, { by: "automationId", automationId: "Save" })).toBe(
      true,
    );
    expect(Value.Check(WindowsUiLocatorSchema, { by: "position", x: 100, y: 200 })).toBe(false);
    expect(
      Value.Check(WindowsUiLocatorSchema, { by: "name", controlType: "Any", name: "Save" }),
    ).toBe(false);
    expect(
      Value.Check(WindowsUiLocatorSchema, {
        by: "automationId",
        automationId: "Save",
        processId: 123,
      }),
    ).toBe(false);
  });

  it("optionally narrows an exact Windows AutomationId by a supported control type", () => {
    const legacy = { by: "automationId", automationId: "Item 41001" } as const;
    const button = { ...legacy, controlType: "Button" } satisfies WindowsUiLocator;
    expect(Value.Check(WindowsUiLocatorSchema, legacy)).toBe(true);
    expect(Value.Check(WindowsUiLocatorSchema, button)).toBe(true);
    expect(
      Value.Check(WindowsUiScenarioStepSchema, {
        id: "click-new",
        name: "Create a new document",
        action: "click",
        locator: button,
        timeoutMs: 5_000,
      }),
    ).toBe(true);
    expect(Value.Check(WindowsUiLocatorSchema, { ...button, processId: 123 })).toBe(false);
    expect(Value.Check(WindowsUiLocatorSchema, { ...button, index: 0 })).toBe(false);
    expect(Value.Check(WindowsUiLocatorSchema, { ...button, unknown: true })).toBe(false);
  });

  it.each([
    { name: "unsupported MenuItem", controlType: "MenuItem" },
    { name: "unknown control type", controlType: "Unknown" },
    { name: "incorrect case", controlType: "button" },
    { name: "empty control type", controlType: "" },
    { name: "null control type", controlType: null },
    { name: "numeric control type", controlType: 50_000 },
  ])("rejects an AutomationId locator with $name", ({ controlType }) => {
    expect(
      Value.Check(WindowsUiLocatorSchema, {
        by: "automationId",
        automationId: "Item 41001",
        controlType,
      }),
    ).toBe(false);
  });

  it("keeps a supported control type mandatory for Windows name locators", () => {
    const byName = { by: "name", name: "New" } as const;
    expect(Value.Check(WindowsUiLocatorSchema, { ...byName, controlType: "Button" })).toBe(true);
    expect(Value.Check(WindowsUiLocatorSchema, byName)).toBe(false);
    expect(Value.Check(WindowsUiLocatorSchema, { ...byName, controlType: "MenuItem" })).toBe(false);
    expect(
      Value.Check(WindowsUiLocatorSchema, {
        ...byName,
        controlType: "Button",
        automationId: "Item 41001",
      }),
    ).toBe(false);
  });

  it("does not accept external services, unowned windows, or arbitrary desktop capture", () => {
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        service: { ...webUi.service, origin: "http://127.0.0.1:8000" },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        service: { ...webUi.service, port: 8000 },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        service: { ...webUi.service, navigation: "any_origin" },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...windowsUi,
        desktop: { ...windowsUi.desktop, scope: "desktop" },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...windowsUi,
        evidence: { ...windowsUi.evidence, screenshotScope: "desktop" },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...windowsUi,
        launch: { ...windowsUi.launch, readiness: { ...windowsUi.launch.readiness, window: {} } },
      }),
    ).toBe(false);
  });

  it("requires persistent launch readiness and evidence delivery instead of a successful exit", () => {
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        launch: { ...webUi.launch, mode: "exit_success" },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        launch: { ...webUi.launch, readiness: { ...webUi.launch.readiness, expectedStatus: 500 } },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        evidence: { ...webUi.evidence, required: false },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...windowsUi,
        evidence: { ...windowsUi.evidence, trace: "always" },
      }),
    ).toBe(false);
  });

  it("requires an assertion in every scenario and bounds assertion coverage", () => {
    const actionOnly = structuredClone(webUi);
    requireFirst(actionOnly.scenarios).steps = [
      requireFirst(requireFirst(actionOnly.scenarios).steps),
    ];
    expect(getUiScenarioConfigurationIssues(actionOnly)).toContain(
      "UI scenario save-title must include at least one deterministic assertion.",
    );
    const manyAssertions: WebUiConfiguration = {
      ...webUi,
      scenarios: Array.from({ length: 5 }, (_, scenarioIndex) => ({
        id: `scenario-${scenarioIndex}`,
        name: "A scenario",
        required: true,
        timeoutMs: 60_000,
        path: "/",
        steps: Array.from({ length: 32 }, (_, stepIndex) => ({
          ...assertion,
          id: `assert-${scenarioIndex}-${stepIndex}`,
        })),
      })),
    };
    expect(Value.Check(UiScenarioConfigurationSchema, manyAssertions)).toBe(true);
    expect(getUiScenarioConfigurationIssues(manyAssertions)).toContain(
      "UI validation must not exceed 128 assertions.",
    );
    expect(
      getUiScenarioConfigurationIssues({
        ...webUi,
        scenarios: [
          {
            ...requireFirst(webUi.scenarios),
            steps: [{ ...assertion, match: "contains", expected: "" }],
          },
        ],
      }),
    ).toContain("UI text assertion assert-title must not search for an empty string.");
  });

  it("bounds scenarios, steps, timeouts, and text sizes", () => {
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        scenarios: Array.from({ length: 33 }, () => webUi.scenarios[0]),
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        scenarios: [{ ...webUi.scenarios[0], steps: Array.from({ length: 33 }, () => assertion) }],
      }),
    ).toBe(false);
    expect(
      Value.Check(WebUiScenarioStepSchema, { ...assertion, expected: "x".repeat(2_049) }),
    ).toBe(false);
    expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, timeoutMs: 60_001 })).toBe(false);
    expect(Value.Check(WebUiScenarioStepSchema, { ...assertion, expected: "x\u0000y" })).toBe(
      false,
    );
  });

  it("reserves scenario/check identities across command steps and every UI scenario", () => {
    const collisions: WebUiConfiguration = {
      ...webUi,
      scenarios: [
        { ...requireFirst(webUi.scenarios), id: "reset-data" },
        { ...requireFirst(webUi.scenarios), id: "another-scenario" },
      ],
    };
    const issues = getValidationProfileConfigIssues({ ...profile, ui: collisions }, "pr_ui", "web");
    expect(issues).toContain("UI scenario ID reset-data is duplicated.");
    expect(issues).toContain("UI step ID assert-title is duplicated.");
  });

  it("validates exact launch and reset references rather than running arbitrary steps", () => {
    expect(getValidationProfileConfigIssues({ ...profile, launch: [] }, "pr_ui", "web")).toContain(
      "UI validation must reference its single persistent launch step.",
    );
    expect(
      getValidationProfileConfigIssues(
        {
          ...profile,
          ui: { ...webUi, reset: { strategy: "commands", stepIds: ["launch-app"] } },
        },
        "pr_ui",
        "web",
      ),
    ).toContain("UI reset step launch-app must reference a trusted setup or cleanup step.");
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        reset: { strategy: "commands", stepIds: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...webUi,
        reset: { strategy: "restart_process", stateRestored: true },
      }),
    ).toBe(false);
  });

  it("validates target compatibility, allocated-port ownership, and nested timeout budgets", () => {
    expect(getValidationProfileConfigIssues(profile, "pr_ui", "windows_desktop")).toContain(
      "UI configuration target must match the validation profile target.",
    );
    expect(getValidationProfileConfigIssues(profile, "pr_static_build", "headless")).toContain(
      "Workflow pr_static_build must not contain UI scenarios.",
    );
    const overriddenPort = structuredClone(profile);
    requireFirst(overriddenPort.launch).command.environment.push({
      name: "ui_test_port",
      value: "8000",
    });
    expect(getValidationProfileConfigIssues(overriddenPort, "pr_ui", "web")).toContain(
      "The managed Web port environment variable must not be overridden by the launch command.",
    );
    const longStep = structuredClone(webUi);
    requireFirst(longStep.scenarios).timeoutMs = 1_000;
    expect(getUiScenarioConfigurationIssues(longStep)).toContain(
      "UI step assert-title timeout exceeds its scenario timeout.",
    );
    const issues = getValidationProfileConfigIssues(
      { ...profile, hardTimeoutMs: 1_000 },
      "pr_ui",
      "web",
    );
    expect(issues).toContain("UI readiness timeout exceeds the profile hard timeout.");
    expect(issues).toContain("UI scenario save-title timeout exceeds the profile hard timeout.");
    expect(
      getValidationProfileConfigIssues(
        { ...profile, launch: [{ ...requireFirst(profile.launch), timeoutMs: 1_000 }] },
        "pr_ui",
        "web",
      ),
    ).toContain("UI readiness timeout exceeds the launch step startup timeout.");
  });

  it("preserves published V1 configurations without inserting UI defaults", () => {
    const legacy = structuredClone(profile);
    delete legacy.ui;
    const originalJson = JSON.stringify(legacy);
    expect(Value.Check(ValidationProfileConfigSchema, legacy)).toBe(true);
    expect(getValidationProfileConfigIssues(legacy, "pr_ui", "web")).toEqual([]);
    expect(JSON.stringify(legacy)).toBe(originalJson);
    expect(legacy).not.toHaveProperty("ui");
  });

  it("accepts an explicitly disabled Web trace while retaining required screenshots", () => {
    const traceOff: WebUiConfiguration = {
      ...webUi,
      evidence: { ...webUi.evidence, trace: "off" },
    };
    expect(Value.Check(UiScenarioConfigurationSchema, traceOff)).toBe(true);
    expect(getValidationProfileConfigIssues({ ...profile, ui: traceOff }, "pr_ui", "web")).toEqual(
      [],
    );
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...traceOff,
        evidence: { ...traceOff.evidence, required: false },
      }),
    ).toBe(false);
    expect(
      Value.Check(UiScenarioConfigurationSchema, {
        ...traceOff,
        evidence: { ...traceOff.evidence, trace: "disabled" },
      }),
    ).toBe(false);
  });

  it.each(["on_failure", "always"] as const)(
    "preserves the serialized configuration and hash for existing trace policy %s",
    (trace) => {
      const existing = { ...profile, ui: { ...webUi, evidence: { ...webUi.evidence, trace } } };
      const originalJson = JSON.stringify(existing);
      const originalHash = createHash("sha256").update(originalJson).digest("hex");
      expect(Value.Check(ValidationProfileConfigSchema, existing)).toBe(true);
      expect(getValidationProfileConfigIssues(existing, "pr_ui", "web")).toEqual([]);
      expect(JSON.stringify(existing)).toBe(originalJson);
      expect(createHash("sha256").update(JSON.stringify(existing)).digest("hex")).toBe(
        originalHash,
      );
      expect(existing.ui.evidence.trace).toBe(trace);
    },
  );
});

describe("managed UI navigation", () => {
  it("resolves relative paths against exactly the allocated local origin", () => {
    expect(resolveManagedWebUiUrl(41_000, "/editor?tab=validation#result")).toBe(
      "http://127.0.0.1:41000/editor?tab=validation#result",
    );
    expect(resolveManagedWebUiUrl(41_000, "/")).toBe("http://127.0.0.1:41000/");
  });

  it.each([
    "https://example.com",
    "http://127.0.0.1:8000/",
    "//example.com/",
    "/\\example.com/",
    "/path\n",
    "/white space",
    "/%00",
    "/%0a",
    "/%5c",
    "/bad%zz",
    "relative/path",
  ])("rejects unsafe or external navigation %s", (path) => {
    expect(() => resolveManagedWebUiUrl(41_000, path)).toThrow(TypeError);
    expect(
      getUiScenarioConfigurationIssues({
        ...webUi,
        scenarios: [{ ...requireFirst(webUi.scenarios), path }],
      }),
    ).toContain("UI scenario save-title path must remain inside the managed service origin.");
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])("rejects invalid allocated port %s", (port) => {
    expect(() => resolveManagedWebUiUrl(port, "/")).toThrow(TypeError);
  });
});

describe("driver-owned scenario evidence", () => {
  it("records typed expected and actual values independently of configuration", () => {
    const step = {
      stepId: "assert-value",
      name: "Saved value",
      action: "assertValue",
      expected: "Expected value",
      actual: "Different value",
      outcome: "failed",
      summary: "The application did not retain the supplied value.",
      evidenceIds: ["screenshot-1"],
    };
    expect(Value.Check(UiStepExecutionEvidenceSchema, step)).toBe(true);
    expect(Value.Check(UiStepExecutionEvidenceSchema, { ...step, actual: true })).toBe(false);
    expect(Value.Check(UiStepExecutionEvidenceSchema, { ...step, action: "fill" })).toBe(false);
    const evidence = {
      schemaVersion: "UiScenarioExecutionEvidenceV1",
      source: "ui_driver",
      scenarioId: "save-value",
      target: "windows_desktop",
      steps: [step],
    };
    expect(Value.Check(UiScenarioExecutionEvidenceV1Schema, evidence)).toBe(true);
    expect(Value.Check(UiScenarioExecutionEvidenceV1Schema, { ...evidence, source: "model" })).toBe(
      false,
    );
    expect(Value.Check(UiScenarioExecutionEvidenceV1Schema, { ...evidence, steps: [] })).toBe(
      false,
    );
  });

  it("does not mistake actions for deterministic assertions", () => {
    expect(isUiAssertionAction("click")).toBe(false);
    expect(isUiAssertionAction("fill")).toBe(false);
    expect(isUiAssertionAction("assertText")).toBe(true);
    expect(isUiAssertionAction("assertValue")).toBe(true);
    expect(isUiAssertionAction("assertVisible")).toBe(true);
  });
});
