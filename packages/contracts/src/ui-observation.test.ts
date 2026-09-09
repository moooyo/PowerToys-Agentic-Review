import { describe, expect, it } from "vitest";
import {
  isSafeUiObservationText,
  matchesUiScenarioObservations,
  matchesUiStepObservation,
} from "./ui-observation.js";
import type { UiStepExecutionEvidence, WebUiScenarioStep } from "./ui-scenarios.js";

const planned = {
  id: "status",
  name: "Status text",
  action: "assertText",
  expected: "Ready",
  match: "exact",
  timeoutMs: 1_000,
  locator: { by: "testId", testId: "status" },
} satisfies WebUiScenarioStep;

function observed(): UiStepExecutionEvidence {
  return {
    stepId: planned.id,
    name: planned.name,
    action: planned.action,
    expected: planned.expected,
    actual: "Duplicate",
    outcome: "failed",
    summary: "The complete value did not match.",
    evidenceIds: ["status-screenshot"],
    capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
  };
}

describe("complete frozen UI observations", () => {
  it("accepts a real failed correctness assertion as a complete measurement", () => {
    expect(matchesUiStepObservation(planned, observed(), { requireCapture: true })).toBe(true);
    expect(
      matchesUiStepObservation(planned, { ...observed(), outcome: "passed", actual: "Ready" }),
    ).toBe(true);
  });

  it("rechecks both passed and failed assertions including contains", () => {
    expect(matchesUiStepObservation(planned, { ...observed(), actual: "Ready" })).toBe(false);
    expect(matchesUiStepObservation(planned, { ...observed(), outcome: "passed" })).toBe(false);
    const contains = { ...planned, match: "contains" as const };
    expect(matchesUiStepObservation(contains, { ...observed(), actual: "Ready now" })).toBe(false);
    expect(
      matchesUiStepObservation(contains, {
        ...observed(),
        actual: "Ready now",
        outcome: "passed",
      }),
    ).toBe(true);
  });

  it("preserves complete false and empty values without treating null as a value", () => {
    const visible = { ...planned, action: "assertVisible", expected: false } as const;
    const actual: UiStepExecutionEvidence = {
      ...observed(),
      action: "assertVisible",
      expected: false,
      actual: false,
      outcome: "passed",
    };
    expect(matchesUiStepObservation(visible, actual, { requireCapture: true })).toBe(true);
    expect(matchesUiStepObservation(visible, { ...actual, actual: null })).toBe(false);
    expect(matchesUiStepObservation(planned, { ...observed(), actual: "" })).toBe(true);
  });

  it.each(["blocked", "inconclusive", "not_run", "skipped"] as const)(
    "rejects complete values from %s steps",
    (outcome) => {
      expect(matchesUiStepObservation(planned, { ...observed(), outcome })).toBe(false);
    },
  );

  it("makes unavailable observations explicitly valueless", () => {
    const actual: UiStepExecutionEvidence = {
      ...observed(),
      actual: null,
      outcome: "blocked",
      capture: {
        schemaVersion: "UiAssertionCaptureV1",
        state: "unavailable",
        reason: "provider_error",
      },
    };
    expect(matchesUiStepObservation(planned, actual, { requireCapture: true })).toBe(true);
    expect(matchesUiStepObservation(planned, { ...actual, actual: "Duplicate" })).toBe(false);
    expect(matchesUiStepObservation(planned, { ...actual, outcome: "passed" })).toBe(false);
    expect(matchesUiStepObservation(planned, { ...actual, outcome: "not_run" })).toBe(false);
  });

  it("keeps historical evidence readable without granting capture authority", () => {
    const actual = observed();
    if (actual.action === "click" || actual.action === "fill") throw new Error("Invalid fixture.");
    delete actual.capture;
    expect(matchesUiStepObservation(planned, actual)).toBe(true);
    expect(matchesUiStepObservation(planned, actual, { requireCapture: true })).toBe(false);
    expect("capture" in actual).toBe(false);
  });

  it.each(["stepId", "name", "expected"] as const)("rejects substituted %s", (field) => {
    expect(matchesUiStepObservation(planned, { ...observed(), [field]: "foreign" })).toBe(false);
  });

  it("rejects unsafe original complete values", () => {
    expect(matchesUiStepObservation(planned, { ...observed(), actual: "Bearer fake-token" })).toBe(
      false,
    );
  });
});

describe("frozen scenario order", () => {
  const second = { ...planned, id: "second" };
  const notRun: UiStepExecutionEvidence = {
    ...observed(),
    stepId: second.id,
    actual: null,
    outcome: "not_run",
    evidenceIds: [],
    capture: { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "not_run" },
  };

  it("permits only not_run after a failed measurement", () => {
    expect(
      matchesUiScenarioObservations([planned, second], [observed(), notRun], {
        requireCapture: true,
        checkOutcome: "failed",
      }),
    ).toBe(true);
    expect(
      matchesUiScenarioObservations(
        [planned, second],
        [observed(), { ...observed(), stepId: second.id, evidenceIds: ["second-screenshot"] }],
      ),
    ).toBe(false);
  });

  it("rejects substituted order, missing steps, reused screenshots, and false check outcomes", () => {
    expect(matchesUiScenarioObservations([planned, second], [observed()])).toBe(false);
    expect(matchesUiScenarioObservations([second, planned], [observed(), notRun])).toBe(false);
    expect(
      matchesUiScenarioObservations(
        [planned, second],
        [observed(), { ...notRun, evidenceIds: ["x"] }],
      ),
    ).toBe(false);
    expect(matchesUiScenarioObservations([planned], [observed()], { checkOutcome: "passed" })).toBe(
      false,
    );
    expect(
      matchesUiScenarioObservations(
        [planned],
        [{ ...observed(), outcome: "passed", actual: "Ready" }],
        { checkOutcome: "failed" },
      ),
    ).toBe(false);
    const passed = { ...observed(), outcome: "passed" as const, actual: "Ready" };
    expect(
      matchesUiScenarioObservations([planned, second], [passed, { ...passed, stepId: second.id }]),
    ).toBe(false);
  });
});

describe("untransformed safe UI text", () => {
  it.each(["", " ", "Ready\nNext\titem", "世界😀", "x".repeat(2_048)])(
    "retains a safe full value %j",
    (value) => expect(isSafeUiObservationText(value)).toBe(true),
  );

  it.each([
    "x".repeat(2_049),
    "bad\0text",
    "bad\u001btext",
    "bad\ud800text",
    "[REDACTED]",
    "[REDACTED AUTHORIZATION]",
    "Authorization: Token opaque-session",
    "Cookie: session_id=opaque-session",
    "Bearer opaque-session",
    "Basic dXNlcjpwYXNz",
    "ghp_fakecredential123",
    "github_pat_fake123",
    "sk-fakecredential123",
    "arw1_fakecredential123",
    "eyJabc.def.ghi",
    "password=fixture",
    "--token fixture",
    "https://user:password@example.invalid",
    "-----BEGIN PRIVATE KEY-----",
  ])("rejects unsafe capture without generating a replacement %j", (value) => {
    expect(isSafeUiObservationText(value)).toBe(false);
  });
});
