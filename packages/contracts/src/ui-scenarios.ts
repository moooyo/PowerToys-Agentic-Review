import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { EntityIdSchema } from "./common.js";
import { UiAssertionCaptureV1Schema } from "./issue-reproduction.js";
import { ValidationOutcomeSchema } from "./validation-report.js";

export const maximumUiScenarioCount = 32;
export const maximumUiScenarioStepCount = 32;
export const maximumUiAssertionCount = 128;
export const maximumUiScenarioTimeoutMs = 600_000;

export const UiDriverCapabilities = {
  web: "ui:web",
  windows_desktop: "ui:windows_desktop",
} as const;

const UiNameSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
});
const UiTextSchema = Type.String({ maxLength: 2_048, pattern: "^[^\\u0000]*$" });
const UiOperationTimeoutSchema = Type.Integer({ minimum: 100, maximum: 60_000 });
const UiReadinessTimeoutSchema = Type.Integer({ minimum: 1_000, maximum: 120_000 });
const UiEnvironmentVariableNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])",
});

// Navigation is relative to the single managed service, never to an arbitrary loopback origin.
export const UiRelativeWebPathSchema = Type.String({
  minLength: 1,
  maxLength: 2_048,
  pattern: "^/(?!/)[^\\\\\\u0000-\\u0020\\u007F]*(?![\\s\\S])",
});

export const WebUiRoleSchema = Type.Union([
  Type.Literal("button"),
  Type.Literal("textbox"),
  Type.Literal("checkbox"),
  Type.Literal("heading"),
  Type.Literal("link"),
  Type.Literal("combobox"),
  Type.Literal("option"),
  Type.Literal("dialog"),
  Type.Literal("status"),
  Type.Literal("alert"),
  Type.Literal("tab"),
  Type.Literal("tablist"),
  Type.Literal("listitem"),
]);
export type WebUiRole = Static<typeof WebUiRoleSchema>;

// Locator text matches exactly and must resolve to one element. No CSS, XPath, or scripts.
export const WebUiLocatorSchema = Type.Union([
  Type.Object(
    { by: Type.Literal("role"), role: WebUiRoleSchema, name: UiNameSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { by: Type.Literal("testId"), testId: UiNameSchema },
    { additionalProperties: false },
  ),
]);
export type WebUiLocator = Static<typeof WebUiLocatorSchema>;

export const WindowsUiControlTypeSchema = Type.Union([
  Type.Literal("Button"),
  Type.Literal("Edit"),
  Type.Literal("Text"),
  Type.Literal("CheckBox"),
  Type.Literal("ComboBox"),
  Type.Literal("ListItem"),
  Type.Literal("Window"),
  Type.Literal("Pane"),
  Type.Literal("TabItem"),
]);
export type WindowsUiControlType = Static<typeof WindowsUiControlTypeSchema>;

// Resolve only under the unique readiness window in the owned process tree. Revalidate ownership
// before every operation and capture; an unmatched locator must never fall back to desktop search.
export const WindowsUiLocatorSchema = Type.Union([
  Type.Object(
    {
      by: Type.Literal("automationId"),
      automationId: UiNameSchema,
      controlType: Type.Optional(WindowsUiControlTypeSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { by: Type.Literal("name"), controlType: WindowsUiControlTypeSchema, name: UiNameSchema },
    { additionalProperties: false },
  ),
]);
export type WindowsUiLocator = Static<typeof WindowsUiLocatorSchema>;

export const WindowsUiWindowSelectorSchema = Type.Object(
  {
    title: Type.Optional(UiNameSchema),
    className: Type.Optional(UiNameSchema),
    automationId: Type.Optional(UiNameSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type WindowsUiWindowSelector = Static<typeof WindowsUiWindowSelectorSchema>;

export const UiStepActionValues = [
  "click",
  "fill",
  "assertVisible",
  "assertText",
  "assertValue",
] as const;
export const UiStepActionSchema = Type.Union(
  UiStepActionValues.map((action) => Type.Literal(action)),
);
export type UiStepAction = Static<typeof UiStepActionSchema>;

export function isUiAssertionAction(action: UiStepAction): boolean {
  return action === "assertVisible" || action === "assertText" || action === "assertValue";
}

function createUiStepSchema<TLocator extends TSchema>(locator: TLocator) {
  const properties = {
    id: EntityIdSchema,
    name: UiNameSchema,
    timeoutMs: UiOperationTimeoutSchema,
    locator,
  };
  return Type.Union([
    Type.Object({ ...properties, action: Type.Literal("click") }, { additionalProperties: false }),
    Type.Object(
      {
        ...properties,
        action: Type.Literal("fill"),
        // The first driver protocol supports public fixture input only. Credential injection
        // needs an explicit redaction protocol before it can be added to recorded UI scenarios.
        value: UiTextSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...properties, action: Type.Literal("assertVisible"), expected: Type.Boolean() },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...properties,
        action: Type.Literal("assertText"),
        expected: UiTextSchema,
        match: Type.Union([Type.Literal("exact"), Type.Literal("contains")]),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...properties, action: Type.Literal("assertValue"), expected: UiTextSchema },
      { additionalProperties: false },
    ),
  ]);
}

export const WebUiScenarioStepSchema = createUiStepSchema(WebUiLocatorSchema);
export type WebUiScenarioStep = Static<typeof WebUiScenarioStepSchema>;
export const WindowsUiScenarioStepSchema = createUiStepSchema(WindowsUiLocatorSchema);
export type WindowsUiScenarioStep = Static<typeof WindowsUiScenarioStepSchema>;
export const UiScenarioStepSchema = Type.Union([
  WebUiScenarioStepSchema,
  WindowsUiScenarioStepSchema,
]);
export type UiScenarioStep = Static<typeof UiScenarioStepSchema>;

const UiScenarioProperties = {
  id: EntityIdSchema,
  name: UiNameSchema,
  required: Type.Boolean(),
  timeoutMs: Type.Integer({ minimum: 1_000, maximum: maximumUiScenarioTimeoutMs }),
};

export const WebUiScenarioSchema = Type.Object(
  {
    ...UiScenarioProperties,
    path: UiRelativeWebPathSchema,
    steps: Type.Array(WebUiScenarioStepSchema, {
      minItems: 1,
      maxItems: maximumUiScenarioStepCount,
    }),
  },
  { additionalProperties: false },
);
export type WebUiScenario = Static<typeof WebUiScenarioSchema>;

export const WindowsUiScenarioSchema = Type.Object(
  {
    ...UiScenarioProperties,
    steps: Type.Array(WindowsUiScenarioStepSchema, {
      minItems: 1,
      maxItems: maximumUiScenarioStepCount,
    }),
  },
  { additionalProperties: false },
);
export type WindowsUiScenario = Static<typeof WindowsUiScenarioSchema>;

// Each scenario starts after the preceding owned process has stopped. Restarting a process does
// not claim to reset files, accounts, databases, or registry state. The commands strategy runs only
// referenced trusted setup/cleanup steps, then launches a new process. Any stop/reset failure blocks
// the scenario and prevents environment reuse until recovery succeeds.
export const UiResetPolicySchema = Type.Union([
  Type.Object({ strategy: Type.Literal("restart_process") }, { additionalProperties: false }),
  Type.Object(
    {
      strategy: Type.Literal("commands"),
      stepIds: Type.Array(EntityIdSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
]);
export type UiResetPolicy = Static<typeof UiResetPolicySchema>;

const UiScreenshotWhenSchema = Type.Union([
  Type.Literal("on_failure"),
  Type.Literal("every_assertion"),
]);
export const WebUiEvidencePolicySchema = Type.Object(
  {
    screenshots: UiScreenshotWhenSchema,
    screenshotScope: Type.Literal("viewport"),
    trace: Type.Union([Type.Literal("on_failure"), Type.Literal("always"), Type.Literal("off")]),
    required: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type WebUiEvidencePolicy = Static<typeof WebUiEvidencePolicySchema>;

export const WindowsUiEvidencePolicySchema = Type.Object(
  {
    screenshots: UiScreenshotWhenSchema,
    screenshotScope: Type.Literal("owned_window"),
    required: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type WindowsUiEvidencePolicy = Static<typeof WindowsUiEvidencePolicySchema>;

// Start the referenced command without waiting for exit. A clean early exit is a launch failure,
// not a successful UI check. Readiness must also prove the endpoint belongs to that process tree.
// The command step's timeout caps startup; the persistent process then lives under the scenario
// and profile deadlines and is stopped before reset or release of the interactive environment.
export const WebUiLaunchSchema = Type.Object(
  {
    stepId: EntityIdSchema,
    mode: Type.Literal("persistent"),
    readiness: Type.Object(
      {
        kind: Type.Literal("http"),
        path: UiRelativeWebPathSchema,
        expectedStatus: Type.Integer({ minimum: 200, maximum: 299 }),
        timeoutMs: UiReadinessTimeoutSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WebUiLaunch = Static<typeof WebUiLaunchSchema>;

export const WindowsUiLaunchSchema = Type.Object(
  {
    stepId: EntityIdSchema,
    mode: Type.Literal("persistent"),
    readiness: Type.Object(
      {
        kind: Type.Literal("window"),
        window: WindowsUiWindowSelectorSchema,
        timeoutMs: UiReadinessTimeoutSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WindowsUiLaunch = Static<typeof WindowsUiLaunchSchema>;

export const WebUiConfigurationSchema = Type.Object(
  {
    schemaVersion: Type.Literal("UiScenariosV1"),
    target: Type.Literal("web"),
    service: Type.Object(
      {
        origin: Type.Literal("managed_loopback"),
        portEnvironmentVariable: UiEnvironmentVariableNameSchema,
        navigation: Type.Literal("same_origin"),
      },
      { additionalProperties: false },
    ),
    browser: Type.Object(
      {
        engine: Type.Literal("chromium"),
        headless: Type.Literal(true),
        viewport: Type.Object(
          {
            width: Type.Integer({ minimum: 320, maximum: 2_560 }),
            height: Type.Integer({ minimum: 240, maximum: 1_600 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    launch: WebUiLaunchSchema,
    reset: UiResetPolicySchema,
    scenarios: Type.Array(WebUiScenarioSchema, { minItems: 1, maxItems: maximumUiScenarioCount }),
    evidence: WebUiEvidencePolicySchema,
  },
  { additionalProperties: false },
);
export type WebUiConfiguration = Static<typeof WebUiConfigurationSchema>;

// The driver owns an exclusive interactive session and the launch's process identity/handles.
// PID-only matching, arbitrary desktop windows, UAC dialogs, and existing single-instance apps
// outside that owned process tree are unsupported; they must produce a blocked outcome.
export const WindowsUiConfigurationSchema = Type.Object(
  {
    schemaVersion: Type.Literal("UiScenariosV1"),
    target: Type.Literal("windows_desktop"),
    desktop: Type.Object(
      {
        session: Type.Literal("exclusive_interactive"),
        scope: Type.Literal("launched_process_tree"),
      },
      { additionalProperties: false },
    ),
    launch: WindowsUiLaunchSchema,
    reset: UiResetPolicySchema,
    scenarios: Type.Array(WindowsUiScenarioSchema, {
      minItems: 1,
      maxItems: maximumUiScenarioCount,
    }),
    evidence: WindowsUiEvidencePolicySchema,
  },
  { additionalProperties: false },
);
export type WindowsUiConfiguration = Static<typeof WindowsUiConfigurationSchema>;

export const UiScenarioConfigurationSchema = Type.Union([
  WebUiConfigurationSchema,
  WindowsUiConfigurationSchema,
]);
export type UiScenarioConfiguration = Static<typeof UiScenarioConfigurationSchema>;

export interface UiScenarioConfigurationContext {
  readonly launchStepIds: readonly string[];
  readonly launchTimeoutMs?: number;
  readonly resetStepIds: readonly string[];
  readonly reservedIds: readonly string[];
  readonly hardTimeoutMs: number;
}

export function getUiScenarioConfigurationIssues(
  ui: UiScenarioConfiguration,
  context?: UiScenarioConfigurationContext,
): string[] {
  const issues: string[] = [];
  const seenIds = new Set(context?.reservedIds ?? []);
  let assertionCount = 0;
  if (context !== undefined) {
    if (context.launchStepIds.length !== 1 || context.launchStepIds[0] !== ui.launch.stepId) {
      issues.push("UI validation must reference its single persistent launch step.");
    }
    if (ui.launch.readiness.timeoutMs > context.hardTimeoutMs) {
      issues.push("UI readiness timeout exceeds the profile hard timeout.");
    }
    if (
      context.launchTimeoutMs !== undefined &&
      ui.launch.readiness.timeoutMs > context.launchTimeoutMs
    ) {
      issues.push("UI readiness timeout exceeds the launch step startup timeout.");
    }
    if (ui.reset.strategy === "commands") {
      for (const stepId of ui.reset.stepIds) {
        if (!context.resetStepIds.includes(stepId)) {
          issues.push(`UI reset step ${stepId} must reference a trusted setup or cleanup step.`);
        }
      }
    }
  }
  if (ui.target === "web") {
    if (!isManagedWebUiPath(ui.launch.readiness.path)) {
      issues.push("UI readiness path must remain inside the managed service origin.");
    }
  }
  for (const scenario of ui.scenarios) {
    if (seenIds.has(scenario.id)) issues.push(`UI scenario ID ${scenario.id} is duplicated.`);
    seenIds.add(scenario.id);
    if (context !== undefined && scenario.timeoutMs > context.hardTimeoutMs) {
      issues.push(`UI scenario ${scenario.id} timeout exceeds the profile hard timeout.`);
    }
    if ("path" in scenario && !isManagedWebUiPath(scenario.path)) {
      issues.push(`UI scenario ${scenario.id} path must remain inside the managed service origin.`);
    }
    let scenarioAssertions = 0;
    for (const step of scenario.steps) {
      if (seenIds.has(step.id)) issues.push(`UI step ID ${step.id} is duplicated.`);
      seenIds.add(step.id);
      if (step.timeoutMs > scenario.timeoutMs) {
        issues.push(`UI step ${step.id} timeout exceeds its scenario timeout.`);
      }
      if (isUiAssertionAction(step.action)) scenarioAssertions += 1;
      if (step.action === "assertText" && step.match === "contains" && step.expected.length === 0) {
        issues.push(`UI text assertion ${step.id} must not search for an empty string.`);
      }
    }
    if (scenarioAssertions === 0) {
      issues.push(`UI scenario ${scenario.id} must include at least one deterministic assertion.`);
    }
    assertionCount += scenarioAssertions;
  }
  if (assertionCount > maximumUiAssertionCount) {
    issues.push(`UI validation must not exceed ${maximumUiAssertionCount} assertions.`);
  }
  return issues;
}

function isManagedWebUiPath(path: string): boolean {
  if (!Value.Check(UiRelativeWebPathSchema, path)) return false;
  // Reject ambiguous encoded separators/control characters before the application can decode them.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|20|5c|7f)/iu.test(path) || /%(?![0-9a-f]{2})/iu.test(path))
    return false;
  const origin = "http://127.0.0.1:1";
  return new URL(path, origin).origin === origin;
}

export function resolveManagedWebUiUrl(port: number, path: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !isManagedWebUiPath(path)) {
    throw new TypeError("UI navigation requires an allocated port and a managed relative path.");
  }
  return new URL(path, `http://127.0.0.1:${port}`).href;
}

const UiStepEvidenceProperties = {
  stepId: EntityIdSchema,
  name: UiNameSchema,
  outcome: ValidationOutcomeSchema,
  summary: Type.String({ minLength: 1, maxLength: 2_048 }),
  evidenceIds: Type.Array(EntityIdSchema, { maxItems: 4, uniqueItems: true }),
};

// This is driver-produced evidence stored as an asset. Configuration never accepts actual values
// or verdicts. The scenario's CheckResult passes only after all planned assertions ran and passed,
// required evidence was finalized, owned processes stopped, and declared reset/cleanup completed.
export const UiStepExecutionEvidenceSchema = Type.Union([
  Type.Object(
    {
      ...UiStepEvidenceProperties,
      action: Type.Union([Type.Literal("click"), Type.Literal("fill")]),
      expected: Type.Null(),
      actual: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...UiStepEvidenceProperties,
      action: Type.Literal("assertVisible"),
      expected: Type.Boolean(),
      actual: Type.Union([Type.Boolean(), Type.Null()]),
      capture: Type.Optional(UiAssertionCaptureV1Schema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...UiStepEvidenceProperties,
      action: Type.Union([Type.Literal("assertText"), Type.Literal("assertValue")]),
      expected: UiTextSchema,
      actual: Type.Union([UiTextSchema, Type.Null()]),
      capture: Type.Optional(UiAssertionCaptureV1Schema),
    },
    { additionalProperties: false },
  ),
]);
export type UiStepExecutionEvidence = Static<typeof UiStepExecutionEvidenceSchema>;

export const UiScenarioExecutionEvidenceV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("UiScenarioExecutionEvidenceV1"),
    source: Type.Literal("ui_driver"),
    scenarioId: EntityIdSchema,
    target: Type.Union([Type.Literal("web"), Type.Literal("windows_desktop")]),
    steps: Type.Array(UiStepExecutionEvidenceSchema, {
      minItems: 1,
      maxItems: maximumUiScenarioStepCount,
    }),
  },
  { additionalProperties: false },
);
export type UiScenarioExecutionEvidenceV1 = Static<typeof UiScenarioExecutionEvidenceV1Schema>;
