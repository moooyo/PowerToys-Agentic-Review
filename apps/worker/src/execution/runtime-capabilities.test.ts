import type { WorkerCapabilities } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import type { WorkerExecutionConfig, WorkerValidationOnlyExecutionConfig } from "../config.js";
import {
  createRuntimeCapabilities,
  type ExecutionRuntimeReadiness,
  validationProcessLimits,
} from "./runtime-capabilities.js";

const base = (): WorkerCapabilities => ({
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  codexVersion: "codex-pinned",
  recipeIds: [],
  labels: { site: "fixture", execution: "enabled", processHost: "available" },
});
const readiness = (
  overrides: Partial<ExecutionRuntimeReadiness> = {},
): ExecutionRuntimeReadiness => ({
  execution: true,
  envelopeV2: true,
  headless: true,
  web: false,
  windowsDesktop: false,
  evidenceDelivery: true,
  ...overrides,
});

describe("runtime-derived Worker capabilities", () => {
  it.each([true, false])(
    "reserves modelExecution labels when enabled=%s without changing driver readiness",
    (enabled) => {
      const configured = base();
      configured.labels = {
        modelExecution: "enabled",
        MODELEXECUTION: "disabled",
        ModelExecution: "enabled",
        site: "fixture",
      };
      const result = createRuntimeCapabilities(
        configured,
        readiness({ web: true, windowsDesktop: true, modelExecution: enabled }),
      );
      expect(
        Object.keys(result.labels).filter((name) => name.toLowerCase() === "modelexecution"),
      ).toEqual(enabled ? [] : ["modelExecution"]);
      expect(result.codexVersion).toBe(enabled ? "codex-pinned" : "not-configured");
      expect(result.labels.validationWeb).toBe("1");
      expect(result.labels.validationWindowsDesktop).toBe("1");
      expect(result.labels.validationEvaluation).toBeUndefined();
      expect(result.interactiveDesktop).toBe(true);
    },
  );
  it("preserves legacy support and deployment metadata while adding prepared headless execution", () => {
    const result = createRuntimeCapabilities(base(), readiness());
    expect(result.labels).toStrictEqual({
      site: "fixture",
      execution: "enabled",
      processHost: "available",
      executionEnvelope: "2",
      validationHeadless: "1",
      evidenceDelivery: "1",
    });
    expect(result.codexVersion).toBe("codex-pinned");
    expect(result.headless).toBe(true);
    expect(result.interactiveDesktop).toBe(false);
  });

  it("removes forged reserved labels regardless of case and every UI namespace claim", () => {
    const configured = base();
    configured.interactiveDesktop = true;
    configured.labels = {
      ...configured.labels,
      EXECUTION: "enabled",
      ProcessHost: "available",
      executionEnvelope: "2",
      validationHeadless: "1",
      validationWeb: "1",
      validationWindowsDesktop: "1",
      validationEvaluation: "1",
      evidenceDelivery: "1",
      "ui:web": "1",
      issueReproduction: "1",
      STRUCTUREDPROBEOUTPUT: "1",
      UiAssertionObservation: "1",
      "UI:windows_desktop": "1",
      "ui:future": "1",
    };
    const result = createRuntimeCapabilities(configured, readiness({ execution: false }));
    expect(result.labels).toStrictEqual({
      site: "fixture",
      execution: "disabled",
      processHost: "unavailable",
    });
    expect(result.interactiveDesktop).toBe(false);
    expect(result.headless).toBe(false);
    expect(configured.labels.executionEnvelope).toBe("2");
  });

  it.each(["validationEvaluation", "VALIDATIONEVALUATION", "ValidationEvaluation"])(
    "never advertises unaccepted evaluation execution from deployment label %s",
    (name) => {
      const configured = base();
      configured.labels[name] = "1";
      const result = createRuntimeCapabilities(
        configured,
        readiness({
          web: true,
          windowsDesktop: true,
          reproduction: true,
          structuredProbes: true,
          uiObservations: true,
        }),
      );
      expect(
        Object.keys(result.labels).some((key) => key.toLowerCase() === "validationevaluation"),
      ).toBe(false);
      expect(result.labels.executionEnvelope).toBe("2");
      expect(result.labels.validationHeadless).toBe("1");
      expect(result.labels.validationWeb).toBe("1");
      expect(result.labels.validationWindowsDesktop).toBe("1");
      expect(configured.labels[name]).toBe("1");
    },
  );

  it.each(["web", "windowsDesktop"] as const)("requires evidence delivery for %s", (target) => {
    const result = createRuntimeCapabilities(
      base(),
      readiness({ [target]: true, evidenceDelivery: false }),
    );
    expect(result.labels.validationWeb).toBeUndefined();
    expect(result.labels.validationWindowsDesktop).toBeUndefined();
    expect(result.labels["ui:web"]).toBeUndefined();
    expect(result.labels["ui:windows_desktop"]).toBeUndefined();
    expect(result.interactiveDesktop).toBe(false);
  });

  it("separates Web readiness from interactive desktop readiness", () => {
    const result = createRuntimeCapabilities(base(), readiness({ web: true }));
    expect(result.labels.validationWeb).toBe("1");
    expect(result.labels["ui:web"]).toBe("1");
    expect(result.labels.validationWindowsDesktop).toBeUndefined();
    expect(result.interactiveDesktop).toBe(false);
  });

  it("advertises Windows only after its independent readiness result", () => {
    const result = createRuntimeCapabilities(base(), readiness({ windowsDesktop: true }));
    expect(result.labels.validationWindowsDesktop).toBe("1");
    expect(result.labels["ui:windows_desktop"]).toBe("1");
    expect(result.interactiveDesktop).toBe(true);
    expect(result.labels.validationWeb).toBeUndefined();
  });

  it("does not derive executable labels from feature booleans when the V2 executor is unavailable", () => {
    expect(
      createRuntimeCapabilities(
        base(),
        readiness({ envelopeV2: false, web: true, windowsDesktop: true }),
      ).labels,
    ).toStrictEqual({ site: "fixture", execution: "enabled", processHost: "available" });
  });

  it("freezes independent snapshots and enforces the final registration label count", () => {
    const configured = base();
    const result = createRuntimeCapabilities(configured, readiness());
    configured.recipeIds.push("new-recipe");
    configured.labels.site = "changed";
    expect(result.recipeIds).toStrictEqual([]);
    expect(result.labels.site).toBe("fixture");
    expect(Object.isFrozen(result.labels)).toBe(true);
    expect(Object.isFrozen(result.recipeIds)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    configured.labels = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`site${index}`, "value"]),
    );
    expect(() => createRuntimeCapabilities(configured, readiness())).toThrow(
      /registration contract/u,
    );
  });

  it("advertises observation features only with independently prepared execution support", () => {
    const features = { reproduction: true, structuredProbes: true, uiObservations: true };
    const headless = createRuntimeCapabilities(base(), readiness(features));
    expect(headless.labels.issueReproduction).toBe("1");
    expect(headless.labels.structuredProbeOutput).toBe("1");
    expect(headless.labels.uiAssertionObservation).toBeUndefined();
    expect(
      createRuntimeCapabilities(base(), readiness({ ...features, web: true })).labels
        .uiAssertionObservation,
    ).toBe("1");
    const disabled = createRuntimeCapabilities(
      base(),
      readiness({ ...features, web: true, execution: false }),
    );
    expect(disabled.labels.issueReproduction).toBeUndefined();
    expect(disabled.labels.structuredProbeOutput).toBeUndefined();
    expect(disabled.labels.uiAssertionObservation).toBeUndefined();
  });
});

function execution(): WorkerExecutionConfig {
  return {
    codexMaximumHardTimeoutMs: 60_000,
    codexResourceLimits: {
      maximumProcessCount: 32,
      maximumMemoryBytes: 8 * 1_024 ** 3,
      maximumOutputBytes: 8 * 1_024 ** 2,
    },
    totalResourceBudget: {
      maximumProcessCount: 64,
      maximumMemoryBytes: 16 * 1_024 ** 3,
      maximumOutputBytes: 64 * 1_024 ** 2,
    },
  } as WorkerExecutionConfig;
}

describe("validation concurrency resource limits", () => {
  it("uses the actual validation budget without model configuration", () => {
    const settings = execution();
    if (settings.modelExecutionEnabled === false) throw new Error("Expected model fixture.");
    const validationOnly = {
      modelExecutionEnabled: false,
      validationMaximumHardTimeoutMs: settings.codexMaximumHardTimeoutMs,
      validationResourceLimits: settings.codexResourceLimits,
      totalResourceBudget: settings.totalResourceBudget,
    } as WorkerValidationOnlyExecutionConfig;
    expect(validationProcessLimits(validationOnly, 2, 2)).toEqual(
      validationProcessLimits(settings, 2, 2),
    );
  });
  it("also bounds Git observations that overlap a still-running UI application", () => {
    const settings = execution();
    const requested = {
      hardTimeoutMs: 30_000,
      maximumProcessCount: 64,
      maximumMemoryBytes: 16 * 1_024 ** 3,
      maximumOutputBytes: 64 * 1_024 ** 2,
    };
    expect(validationProcessLimits(settings, 1, 2, requested)).toStrictEqual({
      hardTimeoutMs: 30_000,
      maximumProcessCount: 32,
      maximumMemoryBytes: 8 * 1_024 ** 3,
      maximumOutputBytes: 32 * 1_024 ** 2,
    });
  });

  it("preserves per-command headless limits within the shared budget", () => {
    expect(validationProcessLimits(execution(), 2, 1)).toStrictEqual({
      hardTimeoutMs: 60_000,
      ...execution().codexResourceLimits,
    });
  });

  it("budgets both the application and driver tree for every UI slot", () => {
    const settings = execution();
    const limits = validationProcessLimits(settings, 4, 2);
    expect(limits.maximumProcessCount).toBe(8);
    expect(limits.maximumMemoryBytes).toBe(2 * 1_024 ** 3);
    expect(limits.maximumOutputBytes).toBe(8 * 1_024 ** 2);
    for (const field of [
      "maximumProcessCount",
      "maximumMemoryBytes",
      "maximumOutputBytes",
    ] as const)
      expect(limits[field] * 8).toBeLessThanOrEqual(settings.totalResourceBudget[field]);
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it("allows 64 headless slots but rejects more than 32 two-tree UI slots", () => {
    const settings = execution();
    expect(() => validationProcessLimits(settings, 64, 1)).not.toThrow();
    expect(() => validationProcessLimits(settings, 33, 2)).toThrow(/64 concurrent/u);
  });

  it("fails if aggregate capacity cannot sustain minimum safe process limits", () => {
    const settings = execution();
    expect(() =>
      validationProcessLimits(
        {
          ...settings,
          totalResourceBudget: {
            ...settings.totalResourceBudget,
            maximumMemoryBytes: 128 * 1_024 ** 2,
          },
        },
        1,
        2,
      ),
    ).toThrow(/cannot support/u);
  });
});
