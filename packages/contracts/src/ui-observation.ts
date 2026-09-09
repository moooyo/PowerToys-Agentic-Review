import type { UiScenarioStep, UiStepExecutionEvidence } from "./ui-scenarios.js";
import type { ValidationOutcome } from "./validation-report.js";

export interface UiObservationValidationOptions {
  readonly requireCapture?: boolean;
}

export interface UiScenarioObservationValidationOptions extends UiObservationValidationOptions {
  readonly checkOutcome?: ValidationOutcome;
}

/** Rejects unsafe original text without transforming it into another observation. */
export function isSafeUiObservationText(value: string): boolean {
  if (value.length > 2_048 || !value.isWellFormed()) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Transformed control characters are not complete observations.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false;
  return ![
    /\[REDACTED(?:[^\]]*)\]/iu,
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]/iu,
    /-----BEGIN [^-]*PRIVATE KEY-----/u,
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|arw1_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/u,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/iu,
    /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu,
    /["']?[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu,
    /--?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu,
  ].some((pattern) => pattern.test(value));
}

/** Validates a parsed driver's value against the exact frozen assertion, without doing I/O. */
export function matchesUiStepObservation(
  planned: UiScenarioStep,
  actual: UiStepExecutionEvidence,
  options: UiObservationValidationOptions = {},
): boolean {
  if (
    actual.stepId !== planned.id ||
    actual.name !== planned.name ||
    actual.action !== planned.action
  )
    return false;
  if (planned.action === "click" || planned.action === "fill")
    return actual.expected === null && actual.actual === null && !("capture" in actual);
  if (actual.action === "click" || actual.action === "fill") return false;
  if (actual.expected !== planned.expected) return false;
  const capture = actual.capture;
  if (capture === undefined && options.requireCapture) return false;
  const matches =
    planned.action === "assertVisible"
      ? typeof actual.actual === "boolean" && actual.actual === planned.expected
      : typeof actual.actual === "string" &&
        (planned.action === "assertText" && planned.match === "contains"
          ? actual.actual.includes(planned.expected)
          : actual.actual === planned.expected);
  // Historical evidence is readable, but absence of a capture protocol never grants a new fact.
  if (capture === undefined) return actual.outcome !== "passed" || matches;
  if (capture.schemaVersion !== "UiAssertionCaptureV1") return false;
  if (capture.state === "unavailable")
    return (
      actual.actual === null &&
      actual.outcome !== "passed" &&
      (actual.outcome === "not_run") === (capture.reason === "not_run")
    );
  if (
    capture.state !== "complete" ||
    actual.actual === null ||
    (planned.action === "assertVisible"
      ? typeof actual.actual !== "boolean"
      : typeof actual.actual !== "string" || !isSafeUiObservationText(actual.actual))
  )
    return false;
  return actual.outcome === "passed" ? matches : actual.outcome === "failed" ? !matches : false;
}

/** Preserves frozen order and stop-on-failure semantics for both native UI protocols. */
export function matchesUiScenarioObservations(
  planned: readonly UiScenarioStep[],
  actual: readonly UiStepExecutionEvidence[],
  options: UiScenarioObservationValidationOptions = {},
): boolean {
  if (
    planned.length !== actual.length ||
    new Set(planned.map((step) => step.id)).size !== planned.length
  )
    return false;
  let firstFailure: UiStepExecutionEvidence | undefined;
  const screenshotIds = new Set<string>();
  for (const [index, step] of planned.entries()) {
    const observation = actual[index];
    if (
      observation === undefined ||
      !matchesUiStepObservation(step, observation, options) ||
      (firstFailure !== undefined && observation.outcome !== "not_run") ||
      (observation.outcome === "not_run" && observation.evidenceIds.length !== 0)
    )
      return false;
    if (observation.outcome !== "passed") firstFailure ??= observation;
    for (const id of observation.evidenceIds) {
      if (screenshotIds.has(id)) return false;
      screenshotIds.add(id);
    }
  }
  if (options.checkOutcome === "passed" && firstFailure !== undefined) return false;
  if (options.checkOutcome === "failed" && firstFailure?.outcome !== "failed") return false;
  return true;
}
