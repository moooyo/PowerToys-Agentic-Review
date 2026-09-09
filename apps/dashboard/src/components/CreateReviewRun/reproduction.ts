import {
  assertIssueReproductionRequest,
  getValidationProfileConfigIssues,
  type IssueReproductionCaseRequest,
  type IssueReproductionRequestV1,
  maximumIssueReproductionRequestUtf8Bytes,
  type ObservationEquals,
  type ObservationSignature,
  type ObservationValue,
  ObservationValueSchema,
  type ReproductionObservationRef,
  type ReproductionPrecondition,
  type UiScenarioStep,
  type ValidationProfileVersion,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { RunProfileOption } from "./helpers";

export interface ReproductionObservationOption {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly ref: ReproductionObservationRef;
  readonly type: ObservationValue["type"];
  readonly checkId: string;
}

export interface ReproductionProfileOption extends RunProfileOption {
  readonly selected: boolean;
  readonly suitable: boolean;
  readonly reason: string | null;
}

// Tuples preserve identifier boundaries even when an identifier contains a colon.
export function observationRefKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}

export function getObservationOptions(
  version: ValidationProfileVersion,
): ReproductionObservationOption[] {
  const options: ReproductionObservationOption[] = [];
  for (const step of version.config.test) {
    for (const field of step.probeOutput?.fields ?? []) {
      const ref: ReproductionObservationRef = {
        kind: "probe_value",
        testStepId: step.id,
        observationId: field.id,
      };
      options.push({
        key: observationRefKey(ref),
        label: `${step.name} / ${field.id}`,
        description: field.description,
        ref,
        type: field.type,
        checkId: `${version.id}:${step.id}`,
      });
    }
  }
  for (const scenario of version.config.ui?.scenarios ?? []) {
    for (const step of scenario.steps) {
      if (step.action === "click" || step.action === "fill") continue;
      const ref: ReproductionObservationRef = {
        kind: "ui_assertion",
        scenarioId: scenario.id,
        stepId: step.id,
      };
      options.push({
        key: observationRefKey(ref),
        label: `${scenario.name} / ${step.name}`,
        description:
          step.action === "assertVisible" ? "Observed element visibility." : "Observed text value.",
        ref,
        type: step.action === "assertVisible" ? "boolean" : "string",
        checkId: `${version.id}:${scenario.id}`,
      });
    }
  }
  return options;
}

export function getPreconditionChecks(
  version: ValidationProfileVersion,
): { id: string; label: string }[] {
  return [
    ...(["setup", "build", "test", "cleanup"] as const).flatMap((phase) =>
      version.config[phase].map((step) => ({
        id: `${version.id}:${step.id}`,
        label: `${phase}: ${step.name}`,
      })),
    ),
    ...(version.config.ui?.scenarios ?? []).map((scenario) => ({
      id: `${version.id}:${scenario.id}`,
      label: `UI: ${scenario.name}`,
    })),
  ];
}

export function reproductionProfileUnavailableReason(
  version: ValidationProfileVersion,
): string | null {
  if (version.workflowKind !== "issue_validation") {
    return "Reproduction cases require an Issue validation profile.";
  }
  const issues = getValidationProfileConfigIssues(
    version.config,
    version.workflowKind,
    version.target,
  );
  if (issues.length > 0) {
    return `The published profile configuration is invalid. Reload the repository bindings. ${issues[0]}`;
  }
  if (version.target !== "headless") {
    // Legacy UI profiles remain readable, but cannot supply an executable UI lifecycle.
    if (version.config.ui === undefined) {
      return "Publish UI scenarios before using this profile for reproduction.";
    }
    const commands = ["setup", "build", "test", "launch", "cleanup"] as const;
    if (
      commands.some((phase) =>
        version.config[phase].some((step) =>
          step.command.environment.some((variable) => "secretRef" in variable),
        ),
      )
    ) {
      return "Mapped UI observations require public fixture commands without secret references in any phase.";
    }
    if (version.config.ui.target === "web" && version.config.ui.evidence.trace !== "off") {
      return "Mapped Web observations require a published profile with traces explicitly turned off.";
    }
  }
  if (getObservationOptions(version).length === 0) {
    return "This profile has no declared test probe fields or UI assertions. Publish observation definitions before adding a case.";
  }
  return null;
}

export function getReproductionProfileOptions(
  profiles: readonly RunProfileOption[],
  selectedProfileIds: readonly string[],
): ReproductionProfileOption[] {
  return profiles.map((option) => {
    const reason = reproductionProfileUnavailableReason(option.version);
    return {
      ...option,
      selected: option.version.required || selectedProfileIds.includes(option.version.profileId),
      suitable: reason === null,
      reason,
    };
  });
}

export function observationValueFromInput(
  type: ObservationValue["type"],
  input: string | number | boolean,
): ObservationValue {
  let value: ObservationValue;
  if (type === "string") {
    if (typeof input !== "string") throw new Error("Enter a string observation value.");
    value = { type, value: input };
  } else if (type === "boolean") {
    if (input !== true && input !== false && input !== "true" && input !== "false") {
      throw new Error("Select true or false for the boolean observation.");
    }
    value = { type, value: input === true || input === "true" };
  } else {
    if (
      typeof input === "boolean" ||
      (typeof input === "string" &&
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(input.trim()))
    ) {
      throw new Error("Enter a finite numeric observation value.");
    }
    const numeric = typeof input === "number" ? input : Number(input);
    if (!Number.isFinite(numeric)) throw new Error("Enter a finite numeric observation value.");
    value = { type, value: numeric === 0 ? 0 : numeric };
  }
  assertJsonValues(value);
  if (!Value.Check(ObservationValueSchema, value)) {
    throw new Error("The observation value exceeds its allowed length or contains invalid text.");
  }
  return value;
}

// Checks authored interpretation before the server's authoritative admission.
export function validateAndCanonicalizeReproduction(
  request: IssueReproductionRequestV1,
  profiles: readonly RunProfileOption[],
  selectedProfileIds: readonly string[],
): IssueReproductionRequestV1 {
  assertJsonValues(request);
  assertIssueReproductionRequest(request);
  assertUnique(
    request.cases.map((entry) => entry.id),
    "Reproduction case IDs",
  );
  const selected = new Set([
    ...selectedProfileIds,
    ...profiles
      .filter((option) => option.version.required)
      .map((option) => option.version.profileId),
  ]);
  const result: IssueReproductionRequestV1 = {
    schemaVersion: "IssueReproductionRequestV1",
    claim: request.claim,
    cases: request.cases
      .map((entry) => {
        const matches = profiles.filter((option) => option.version.profileId === entry.profileId);
        const option = matches[0];
        if (matches.length !== 1 || option === undefined || !selected.has(entry.profileId)) {
          throw new Error(
            `Case "${entry.id}" references an unavailable or deselected profile. Reselect the profile or remove this case.`,
          );
        }
        if (
          !option.binding.enabled ||
          option.binding.profileId !== option.version.profileId ||
          option.binding.repositoryId !== option.version.repositoryId ||
          option.binding.profileVersionId !== option.version.id ||
          entry.expectedProfileVersionId !== option.version.id
        ) {
          throw new Error(
            `Case "${entry.id}" has a changed published profile version. Reload the repository bindings, then reselect its profile and review the case observations.`,
          );
        }
        const reason = reproductionProfileUnavailableReason(option.version);
        if (reason !== null) throw new Error(`Case "${entry.id}": ${reason}`);
        try {
          validateCaseLogic(entry);
          validateCaseReferences(entry, option.version);
        } catch (error) {
          throw new Error(
            `Case "${entry.id}": ${error instanceof Error ? error.message : "Invalid case."}`,
          );
        }
        return canonicalCase(entry);
      })
      .sort((left, right) => compare(left.id, right.id)),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    maximumIssueReproductionRequestUtf8Bytes
  ) {
    throw new Error(
      "The reproduction request exceeds the 2 MiB UTF-8 limit. Reduce the cases or observation text.",
    );
  }
  return result;
}

function canonicalCase(entry: IssueReproductionCaseRequest): IssueReproductionCaseRequest {
  return {
    id: entry.id,
    context: entry.context,
    profileId: entry.profileId,
    expectedProfileVersionId: entry.expectedProfileVersionId,
    preconditions: entry.preconditions
      .map(
        (precondition): ReproductionPrecondition =>
          precondition.kind === "check_passed"
            ? { kind: "check_passed", checkId: precondition.checkId }
            : { kind: "observation_equals", predicate: canonicalPredicate(precondition.predicate) },
      )
      .sort((left, right) => compare(preconditionKey(left), preconditionKey(right))),
    presentWhen: canonicalSignature(entry.presentWhen),
    absentWhen: entry.absentWhen === null ? null : canonicalSignature(entry.absentWhen),
  };
}

function canonicalSignature(signature: ObservationSignature): ObservationSignature {
  return {
    allOf: signature.allOf
      .map(canonicalPredicate)
      .sort((left, right) =>
        compare(observationRefKey(left.observation), observationRefKey(right.observation)),
      ),
  };
}

function canonicalPredicate(predicate: ObservationEquals): ObservationEquals {
  const ref = predicate.observation;
  return {
    observation:
      ref.kind === "ui_assertion"
        ? { kind: "ui_assertion", scenarioId: ref.scenarioId, stepId: ref.stepId }
        : { kind: "probe_value", testStepId: ref.testStepId, observationId: ref.observationId },
    equals:
      predicate.equals.type === "number"
        ? { type: "number", value: predicate.equals.value === 0 ? 0 : predicate.equals.value }
        : predicate.equals.type === "boolean"
          ? { type: "boolean", value: predicate.equals.value }
          : { type: "string", value: predicate.equals.value },
  };
}

function allPredicates(entry: IssueReproductionCaseRequest): ObservationEquals[] {
  return [
    ...entry.presentWhen.allOf,
    ...(entry.absentWhen?.allOf ?? []),
    ...entry.preconditions.flatMap((precondition) =>
      precondition.kind === "observation_equals" ? [precondition.predicate] : [],
    ),
  ];
}

function validateCaseLogic(entry: IssueReproductionCaseRequest): void {
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature !== null) {
      assertUnique(
        signature.allOf.map((predicate) => observationRefKey(predicate.observation)),
        "Signature observation references",
      );
    }
  }
  assertUnique(entry.preconditions.map(preconditionKey), "Reproduction preconditions");
  const types = new Map<string, ObservationValue["type"]>();
  for (const predicate of allPredicates(entry)) {
    const key = observationRefKey(predicate.observation);
    if (types.has(key) && types.get(key) !== predicate.equals.type) {
      throw new Error("An observation reference must have one exact type.");
    }
    types.set(key, predicate.equals.type);
  }
  const preconditions = entry.preconditions.flatMap((precondition) =>
    precondition.kind === "observation_equals" ? [precondition.predicate] : [],
  );
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature === null) continue;
    const values = new Map<string, ObservationValue>();
    for (const predicate of [...preconditions, ...signature.allOf]) {
      const key = observationRefKey(predicate.observation);
      const previous = values.get(key);
      if (previous !== undefined && !equalValues(previous, predicate.equals)) {
        throw new Error("Reproduction preconditions and signatures must be satisfiable.");
      }
      values.set(key, predicate.equals);
    }
  }
  if (
    entry.absentWhen !== null &&
    !entry.presentWhen.allOf.some((present) =>
      entry.absentWhen?.allOf.some(
        (absent) =>
          observationRefKey(present.observation) === observationRefKey(absent.observation) &&
          present.equals.type === absent.equals.type &&
          !equalValues(present.equals, absent.equals),
      ),
    )
  ) {
    throw new Error(
      "Present and absent signatures must be provably disjoint: use different values for at least one shared observation.",
    );
  }
}

function validateCaseReferences(
  entry: IssueReproductionCaseRequest,
  version: ValidationProfileVersion,
): void {
  const definitions = new Map(getObservationOptions(version).map((option) => [option.key, option]));
  const checks = new Set(getPreconditionChecks(version).map((check) => check.id));
  const passedChecks = new Set(
    entry.preconditions.flatMap((precondition) =>
      precondition.kind === "check_passed" ? [precondition.checkId] : [],
    ),
  );
  if ([...passedChecks].some((id) => !checks.has(id))) {
    throw new Error(
      "A reproduction precondition must name an existing qualified check from this profile version.",
    );
  }
  for (const predicate of allPredicates(entry)) {
    const definition = definitions.get(observationRefKey(predicate.observation));
    if (definition === undefined || definition.type !== predicate.equals.type) {
      throw new Error(
        "The reproduction observation is unsupported or has the wrong type. Reselect a published observation.",
      );
    }
    const ref = predicate.observation;
    const assertion =
      ref.kind === "ui_assertion"
        ? version.config.ui?.scenarios
            .find((scenario) => scenario.id === ref.scenarioId)
            ?.steps.find((step) => step.id === ref.stepId)
        : undefined;
    if (
      passedChecks.has(definition.checkId) &&
      assertion !== undefined &&
      !satisfiesAssertion(assertion, predicate.equals)
    ) {
      throw new Error("A passed UI check contradicts a reproduction observation equality.");
    }
  }
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature === null) continue;
    const predicates = [
      ...signature.allOf,
      ...entry.preconditions.flatMap((precondition) =>
        precondition.kind === "observation_equals" ? [precondition.predicate] : [],
      ),
    ];
    for (const scenario of version.config.ui?.scenarios ?? []) {
      let priorFailure = false;
      for (const step of scenario.steps) {
        const predicate = predicates.find(
          (candidate) =>
            candidate.observation.kind === "ui_assertion" &&
            candidate.observation.scenarioId === scenario.id &&
            candidate.observation.stepId === step.id,
        );
        if (predicate === undefined) continue;
        if (priorFailure) {
          throw new Error(
            "A reproduction signature cannot reach an assertion after a required assertion mismatch.",
          );
        }
        if (!satisfiesAssertion(step, predicate.equals)) priorFailure = true;
      }
    }
  }
}

function satisfiesAssertion(step: UiScenarioStep, value: ObservationValue): boolean {
  if (step.action === "assertVisible")
    return value.type === "boolean" && value.value === step.expected;
  if (step.action === "assertText") {
    return (
      value.type === "string" &&
      (step.match === "contains"
        ? value.value.includes(step.expected)
        : value.value === step.expected)
    );
  }
  return step.action === "assertValue" && value.type === "string" && value.value === step.expected;
}

function preconditionKey(precondition: ReproductionPrecondition): string {
  return precondition.kind === "check_passed"
    ? JSON.stringify([precondition.kind, precondition.checkId])
    : JSON.stringify([precondition.kind, observationRefKey(precondition.predicate.observation)]);
}

function equalValues(left: ObservationValue, right: ObservationValue): boolean {
  return left.type === right.type && left.value === right.value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnique(values: readonly string[], description: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${description} must be unique.`);
}

function assertJsonValues(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === "string" && !value.isWellFormed()) {
    throw new Error("Reproduction text must contain well-formed Unicode.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Reproduction numbers must be finite.");
  }
  if (value === undefined || ["bigint", "function", "symbol"].includes(typeof value)) {
    throw new Error("Reproduction values must be strict JSON values.");
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value))
      throw new Error("Reproduction values must not contain circular references.");
    ancestors.add(value);
    for (const entry of Object.values(value)) assertJsonValues(entry, ancestors);
    ancestors.delete(value);
  }
}
