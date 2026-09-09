import { createHash } from "node:crypto";

import {
  assertFrozenIssueReproductionBinding,
  assertIssueReproductionCaseAssessment,
  assertIssueReproductionRequest,
  assertReproductionObservationFact,
  assertReviewRunPlanInput,
  type FrozenIssueReproductionBinding,
  type FrozenIssueReproductionCase,
  getValidationProfileConfigIssues,
  type IssueReproductionAssessmentV1,
  type IssueReproductionBindingV1,
  type IssueReproductionCaseAssessment,
  type IssueReproductionCaseReason,
  type IssueReproductionCaseRequest,
  type IssueReproductionRequestAssessmentV1,
  type IssueReproductionRequestV1,
  maximumIssueReproductionRequestUtf8Bytes,
  type ObservationEquals,
  type ObservationSignature,
  type ObservationValue,
  type ReproductionObservationFact,
  type ReproductionObservationRef,
  type ReproductionPrecondition,
  type ReviewRunPlanInput,
  type ReviewRunRequest,
  type ReviewRunTestedSourceAuthorization,
  type ReviewRunTestedSourceRevision,
  type UiScenarioStep,
  type ValidationExecutionDetails,
  type ValidationProfileVersion,
  type ValidationReportV1,
} from "@agentic-review/contracts";

export type ReproductionProfileRequest = Pick<
  ReviewRunRequest,
  "requestId" | "workflowKind" | "target" | "profileVersion"
>;

/** Authoritative source identity, resolved at the creation or admission boundary. */
export interface IssueReproductionBindingSourceContext {
  readonly activationId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: number;
  readonly workItemId: string;
  readonly githubWorkItemId: number;
  readonly workItemKind: "issue" | "pull_request";
  readonly issueRevisionKey: string;
  readonly testedSourceRevision: ReviewRunTestedSourceRevision | null;
  readonly testedSourceAuthorization: ReviewRunTestedSourceAuthorization | null;
}

/** Internal facts only: the caller verifies the current run, job, attempt, lease, and evidence. */
export interface ReproductionCaseExecution {
  readonly caseId: string;
  readonly bindingDigest: string;
  readonly planDigest: string;
  readonly requestId: string;
  readonly profileVersionId: string;
  readonly profileConfigSha256: string;
  readonly target: FrozenIssueReproductionCase["target"];
  readonly issueRevisionKey: string;
  readonly testedSourceCommit: string;
  readonly state: "pending" | "verified" | "blocked";
  readonly passedPreconditionCheckIds: readonly string[];
  readonly failedPreconditionCheckIds: readonly string[];
  readonly observations: readonly ReproductionObservationFact[];
  readonly reasons: readonly IssueReproductionCaseReason[];
}

export interface DeriveIssueReproductionCaseExecutionsInput {
  readonly frozen: FrozenIssueReproductionBinding;
  /** Must be the admitted frozen plan digest, not a value taken from model output. */
  readonly planDigest: string;
  readonly request: ReproductionProfileRequest;
  readonly issueRevisionKey: string;
  readonly testedSourceCommit: string;
  readonly report: ValidationReportV1 | null;
  readonly execution: ValidationExecutionDetails | null;
  readonly observations: readonly ReproductionObservationFact[];
  /** The caller verifies manifest ownership, capture integrity, and current availability. */
  readonly evidenceComplete: boolean;
  /** Local evidence loss must not suppress a different case's complete positive witness. */
  readonly evidenceUnavailableCheckIds?: readonly string[];
  readonly state?: "pending" | "verified" | "blocked";
}

const shaPattern = /^[a-f0-9]{64}$/u;
const knownObservationObstructions = new Set([
  "capture_unavailable",
  "capture_failed",
  "unsafe_value",
  "oversized_value",
  "provider_error",
  "timeout",
  "ambiguous_element",
  "unsupported_control",
  "evidence_unavailable",
  "execution_blocked",
]);

/** Sorts semantic sets only; claim text, context text, and profile execution order are untouched. */
export function canonicalizeIssueReproductionRequest(
  request: IssueReproductionRequestV1,
): IssueReproductionRequestV1 {
  assertIssueReproductionRequest(request);
  assertJsonValues(request);
  unique(
    request.cases.map((entry) => entry.id),
    "Reproduction case IDs",
  );
  const result: IssueReproductionRequestV1 = {
    schemaVersion: "IssueReproductionRequestV1",
    claim: request.claim,
    cases: request.cases.map(canonicalCase).sort(byId),
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > maximumIssueReproductionRequestUtf8Bytes) {
    throw new RangeError("The reproduction request exceeds its UTF-8 byte limit.");
  }
  return result;
}

/** Freezes interpretation using authoritative plan input; omission preserves legacy plan bytes. */
export function freezeIssueReproductionBinding(
  input: ReviewRunPlanInput,
): FrozenIssueReproductionBinding | undefined {
  if (input.reproduction === undefined) return undefined;
  assertReviewRunPlanInput(input);
  const request = canonicalizeIssueReproductionRequest(input.reproduction);
  const source = sourceContext(input);
  if (
    input.revision.kind !== "issue" ||
    input.workItem.state !== "open" ||
    input.revision.githubRepositoryId !== source.githubRepositoryId ||
    input.revision.githubWorkItemId !== source.githubWorkItemId ||
    input.workItem.githubRepositoryId !== source.githubRepositoryId ||
    input.revision.contentDigest !== source.issueRevisionKey ||
    sha256(
      JSON.stringify([
        input.workItem.title,
        input.workItem.body,
        input.workItem.state,
        input.workItem.updatedAt,
      ]),
    ) !== source.issueRevisionKey ||
    input.authorization.currentRevision.kind !== "issue" ||
    input.authorization.currentRevision.revisionKey !== source.issueRevisionKey ||
    input.authorization.githubRepositoryId !== source.githubRepositoryId ||
    input.authorization.githubWorkItemId !== source.githubWorkItemId
  )
    throw new TypeError("Reproduction requires the authoritative current Issue revision.");
  const authorization = source.testedSourceAuthorization;
  if (source.testedSourceRevision?.kind !== "commit" || authorization === null) {
    throw new TypeError("Reproduction requires an explicitly authorized exact source commit.");
  }
  const binding: IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: source.activationId,
    repositoryId: source.repositoryId,
    githubRepositoryId: source.githubRepositoryId,
    workItemId: source.workItemId,
    githubWorkItemId: source.githubWorkItemId,
    issueRevisionKey: source.issueRevisionKey,
    testedSourceCommit: source.testedSourceRevision.headSha,
    authorizedBy: {
      issuer: authorization.issuer,
      subject: authorization.subject,
      authorizedAt: authorization.authorizedAt,
    },
    claim: request.claim,
    cases: request.cases.map((entry) => {
      const selected = input.requests.filter(
        (candidate) => candidate.profileVersion?.profileId === entry.profileId,
      );
      if (
        selected.length !== 1 ||
        selected[0]?.profileVersion === null ||
        selected[0] === undefined
      ) {
        throw new TypeError("A reproduction case must select exactly one frozen profile request.");
      }
      const selectedRequest = selected[0];
      const profile = selectedRequest.profileVersion;
      if (profile === null || entry.expectedProfileVersionId !== profile.id) {
        throw new TypeError("The expected reproduction profile version has changed.");
      }
      const {
        profileId: _profileId,
        expectedProfileVersionId: _expected,
        ...interpretation
      } = entry;
      return {
        ...interpretation,
        requestId: selectedRequest.requestId,
        profileVersionId: profile.id,
        profileConfigSha256: profile.configSha256,
        target: selectedRequest.target,
      };
    }),
  };
  const frozen = { binding, bindingDigest: sha256(canonicalJson(binding)) };
  validateFrozenIssueReproductionBinding(frozen, input.requests, source);
  return deepFreeze(frozen);
}

/** A requestId limits reference validation to the Worker's own profile, never the binding hash. */
export function validateFrozenIssueReproductionBinding(
  frozen: FrozenIssueReproductionBinding,
  requests: readonly ReproductionProfileRequest[],
  source?: IssueReproductionBindingSourceContext,
  requestId?: string,
): void {
  assertCanonicalBinding(frozen);
  const { binding } = frozen;
  if (source !== undefined) assertBindingSource(binding, source);
  unique(
    requests.map((request) => request.requestId),
    "Reproduction request IDs",
  );
  const cases =
    requestId === undefined
      ? binding.cases
      : binding.cases.filter((entry) => entry.requestId === requestId);
  if (cases.length === 0) throw new TypeError("The request has no frozen reproduction cases.");
  for (const entry of cases) {
    const request = requests.find((candidate) => candidate.requestId === entry.requestId);
    const profile = request?.profileVersion;
    if (
      request === undefined ||
      profile === undefined ||
      profile === null ||
      request.workflowKind !== "issue_validation" ||
      profile.workflowKind !== "issue_validation" ||
      profile.repositoryId !== binding.repositoryId ||
      profile.id !== entry.profileVersionId ||
      request.target !== entry.target ||
      profile.target !== entry.target ||
      profile.configSha256 !== entry.profileConfigSha256 ||
      sha256(canonicalJson(profile.config)) !== profile.configSha256 ||
      getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target)
        .length > 0
    )
      throw new TypeError("The reproduction case does not match its frozen profile request.");
    validateCaseReferences(entry, profile);
  }
}

/** Converts verified runner records into per-case facts without reading diagnostics as values. */
export function deriveIssueReproductionCaseExecutions(
  input: DeriveIssueReproductionCaseExecutionsInput,
): ReproductionCaseExecution[] {
  if (!shaPattern.test(input.planDigest))
    throw new TypeError("The reproduction plan digest is invalid.");
  validateFrozenIssueReproductionBinding(
    input.frozen,
    [input.request],
    undefined,
    input.request.requestId,
  );
  const profile = input.request.profileVersion;
  if (profile === null) throw new TypeError("A reproduction profile is required.");
  const checks = new Map(input.report?.checks.map((check) => [check.id, check]) ?? []);
  const diagnostics = new Map(
    input.execution?.diagnostics.map((diagnostic) => [diagnostic.stepId, diagnostic]) ?? [],
  );
  const phases = new Map<string, "setup" | "build" | "test" | "cleanup" | "launch" | "ui">();
  for (const phase of ["setup", "build", "test", "cleanup", "launch"] as const) {
    for (const step of profile.config[phase]) phases.set(`${profile.id}:${step.id}`, phase);
  }
  for (const scenario of profile.config.ui?.scenarios ?? [])
    phases.set(`${profile.id}:${scenario.id}`, "ui");
  const invalidRecords =
    checks.size !== (input.report?.checks.length ?? 0) ||
    diagnostics.size !== (input.execution?.diagnostics.length ?? 0) ||
    [...checks.values()].some((check) => {
      const phase = phases.get(check.id);
      const kind = phase === "setup" || phase === "cleanup" ? "static" : phase;
      const diagnostic = diagnostics.get(check.id);
      return (
        check.source !== "runner" ||
        phase === undefined ||
        phase === "launch" ||
        check.kind !== kind ||
        (diagnostic !== undefined &&
          (diagnostic.phase !== phase || diagnostic.outcome !== check.outcome))
      );
    }) ||
    [...diagnostics.values()].some(
      (diagnostic) => phases.get(diagnostic.stepId) !== diagnostic.phase,
    ) ||
    (input.execution?.blockers.some(
      (blocker) => blocker.stepId !== null && !phases.has(blocker.stepId),
    ) ??
      false) ||
    (input.evidenceUnavailableCheckIds?.some(
      (id) => !phases.has(id) || phases.get(id) === "launch",
    ) ??
      false);
  const uncertainCommandLifecycle = [...checks.values()].some((check) => {
    if (check.kind === "ui" || check.outcome === "not_run" || check.outcome === "skipped")
      return false;
    const diagnostic = diagnostics.get(check.id);
    return (
      diagnostic === undefined ||
      diagnostic.exitCode === null ||
      (check.outcome !== "passed" && check.outcome !== "failed") ||
      (check.outcome === "passed" ? diagnostic.exitCode !== 0 : diagnostic.exitCode === 0)
    );
  });
  const supported = observationDefinitions(profile);
  const observedKeys = new Set<string>();
  let invalidFacts = false;
  for (const fact of input.observations) {
    assertReproductionObservationFact(fact);
    assertJsonValues(fact);
    const key = observationKey(fact.observation);
    const definition = supported.get(key);
    if (
      observedKeys.has(key) ||
      definition === undefined ||
      definition.checkId !== fact.checkId ||
      (fact.state === "observed" && definition.type !== fact.value.type)
    )
      invalidFacts = true;
    if (
      fact.state === "observed" &&
      definition?.assertion !== undefined &&
      checks.get(fact.checkId)?.outcome === "passed" &&
      !satisfiesAssertion(definition.assertion, fact.value)
    )
      invalidFacts = true;
    observedKeys.add(key);
  }
  const checkPassed = (id: string): boolean => {
    const check = checks.get(id);
    const diagnostic = diagnostics.get(id);
    return (
      check?.source === "runner" &&
      check.outcome === "passed" &&
      diagnostic?.outcome === "passed" &&
      diagnostic.phase === phases.get(id) &&
      diagnostic.exitCode === 0
    );
  };
  const passed = [...checks.keys()].filter(checkPassed).sort();
  const failed = [...checks.values()]
    .filter((check) => check.source === "runner" && check.outcome === "failed")
    .map((check) => check.id)
    .sort();
  return input.frozen.binding.cases
    .filter((entry) => entry.requestId === input.request.requestId)
    .map((entry) => {
      const reasons: IssueReproductionCaseReason[] = [];
      const relevantRefs = allPredicates(entry).map((predicate) =>
        observationKey(predicate.observation),
      );
      const unavailableChecks = new Set(input.evidenceUnavailableCheckIds ?? []);
      if (invalidRecords || invalidFacts) reasons.push("invalid_scope");
      if (
        input.issueRevisionKey !== input.frozen.binding.issueRevisionKey ||
        input.testedSourceCommit !== input.frozen.binding.testedSourceCommit ||
        (input.report !== null &&
          (input.report.source !== "worker" || input.report.workItemKind !== "issue"))
      )
        reasons.push("invalid_scope");
      const pending =
        input.state === "pending" ||
        (input.state === undefined && input.report === null && input.execution === null);
      if (!pending) {
        if (input.report?.sourceState !== "original") reasons.push("source_unverified");
        if (!input.evidenceComplete) reasons.push("evidence_unavailable");
        if (input.state === "blocked" || input.report === null || input.execution === null)
          reasons.push("execution_blocked");
        if (uncertainCommandLifecycle) reasons.push("lifecycle_blocked");
        if (input.execution !== null) {
          const mandatoryCommands = [
            ...profile.config.setup.filter((step) => step.required),
            ...profile.config.build.filter((step) => step.required),
            ...profile.config.cleanup,
            ...(profile.config.ui?.reset.strategy === "commands"
              ? profile.config.setup.filter(
                  (step) =>
                    profile.config.ui?.reset.strategy === "commands" &&
                    profile.config.ui.reset.stepIds.includes(step.id),
                )
              : []),
          ];
          if (
            mandatoryCommands.some((step) => !checkPassed(`${profile.id}:${step.id}`)) ||
            input.execution.cleanupState === "failed" ||
            (profile.config.cleanup.length > 0 && input.execution.cleanupState !== "completed")
          )
            reasons.push("lifecycle_blocked");
          if (entry.target !== "headless") {
            const launch = profile.config.ui?.launch;
            const diagnostic =
              launch === undefined ? undefined : diagnostics.get(`${profile.id}:${launch.stepId}`);
            if (
              diagnostic?.phase !== "launch" ||
              diagnostic.outcome !== "passed" ||
              diagnostic.exitCode === null
            )
              reasons.push("lifecycle_blocked");
          }
          for (const blocker of input.execution.blockers) {
            if (
              blocker.phase === "model_review" &&
              [
                "MODEL_REVIEW_REQUIRED",
                "MODEL_REVIEW_FAILED",
                "MODEL_RESULT_INVALID",
                "SUMMARY_RESULT_INVALID",
                "SUMMARY_RESULT_TOO_LARGE",
                "SUMMARY_CONTEXT_UNAVAILABLE",
              ].includes(blocker.code)
            )
              continue;
            const local =
              (blocker.phase === "test" && blocker.code === "REQUIRED_STEP_NOT_RUN") ||
              (blocker.phase === "evidence" && blocker.code === "UI_EVIDENCE_INCOMPLETE");
            if (local && blocker.stepId !== null) unavailableChecks.add(blocker.stepId);
            else
              reasons.push(
                blocker.phase === "evidence" ? "evidence_unavailable" : "lifecycle_blocked",
              );
          }
        }
      }
      const caseFacts = [...input.observations];
      const included = new Set(caseFacts.map((fact) => observationKey(fact.observation)));
      for (const predicate of allPredicates(entry)) {
        const key = observationKey(predicate.observation);
        const definition = supported.get(key);
        const check = definition === undefined ? undefined : checks.get(definition.checkId);
        if (included.has(key) || definition === undefined) continue;
        if (
          unavailableChecks.has(definition.checkId) ||
          check?.outcome === "blocked" ||
          check?.outcome === "inconclusive" ||
          (check?.kind !== "ui" && check?.outcome === "failed")
        ) {
          caseFacts.push({
            observation: predicate.observation,
            checkId: definition.checkId,
            evidenceIds: [],
            state: "unavailable",
            reason: unavailableChecks.has(definition.checkId)
              ? "evidence_unavailable"
              : "execution_blocked",
          });
          included.add(key);
        }
      }
      return {
        caseId: entry.id,
        bindingDigest: input.frozen.bindingDigest,
        planDigest: input.planDigest,
        requestId: entry.requestId,
        profileVersionId: entry.profileVersionId,
        profileConfigSha256: entry.profileConfigSha256,
        target: entry.target,
        issueRevisionKey: input.issueRevisionKey,
        testedSourceCommit: input.testedSourceCommit,
        state: reasons.length > 0 ? "blocked" : pending ? "pending" : "verified",
        passedPreconditionCheckIds: passed.filter((id) => !unavailableChecks.has(id)),
        failedPreconditionCheckIds: failed,
        observations: caseFacts
          .filter((fact) => relevantRefs.includes(observationKey(fact.observation)))
          .map((fact): ReproductionObservationFact => {
            if (fact.state === "unavailable") return fact;
            const check = checks.get(fact.checkId);
            const diagnostic = diagnostics.get(fact.checkId);
            const valid =
              !unavailableChecks.has(fact.checkId) &&
              check?.source === "runner" &&
              diagnostic !== undefined &&
              diagnostic.outcome === check.outcome &&
              (fact.observation.kind === "ui_assertion"
                ? check.kind === "ui" &&
                  diagnostic.phase === "ui" &&
                  diagnostic.exitCode === 0 &&
                  (check.outcome === "passed" || check.outcome === "failed")
                : checkPassed(fact.checkId));
            return valid
              ? fact
              : {
                  observation: fact.observation,
                  checkId: fact.checkId,
                  evidenceIds: fact.evidenceIds,
                  state: "unavailable",
                  reason: "execution_blocked",
                };
          }),
        reasons: sortedUnique(reasons),
      };
    });
}

/** Equality is three-valued: missing and unavailable facts never prove an absent signature. */
export function evaluateIssueReproductionCases(
  binding: IssueReproductionBindingV1,
  executions: readonly ReproductionCaseExecution[],
): IssueReproductionCaseAssessment[] {
  const bindingDigest = sha256(canonicalJson(binding));
  assertCanonicalBinding({ binding, bindingDigest });
  const planDigests = new Set(executions.map((execution) => execution.planDigest));
  unique(
    executions.map((execution) => execution.caseId),
    "Reproduction execution case IDs",
  );
  if (
    executions.some((execution) => !binding.cases.some((entry) => entry.id === execution.caseId))
  ) {
    throw new TypeError("An execution references a case outside the frozen binding.");
  }
  return binding.cases.map((entry) => {
    const execution = executions.find((candidate) => candidate.caseId === entry.id);
    const assessment = (
      state: IssueReproductionCaseAssessment["state"],
      reasons: IssueReproductionCaseReason[],
      predicates: readonly ObservationEquals[] = [],
    ): IssueReproductionCaseAssessment => {
      const result: IssueReproductionCaseAssessment = {
        caseId: entry.id,
        requestId: entry.requestId,
        profileVersionId: entry.profileVersionId,
        target: entry.target,
        state,
        matchedObservationRefs: predicates
          .map((predicate) => predicate.observation)
          .sort(byObservation),
        evidenceIds: sortedUnique(
          predicates.flatMap(
            (predicate) =>
              execution?.observations.find(
                (fact) =>
                  observationKey(fact.observation) === observationKey(predicate.observation),
              )?.evidenceIds ?? [],
          ),
        ),
        reasons: sortedUnique(reasons),
      };
      assertIssueReproductionCaseAssessment(result);
      return result;
    };
    if (execution === undefined) return assessment("inconclusive", ["execution_pending"]);
    if (
      execution.requestId !== entry.requestId ||
      execution.bindingDigest !== bindingDigest ||
      !shaPattern.test(execution.planDigest) ||
      planDigests.size > 1 ||
      execution.profileVersionId !== entry.profileVersionId ||
      execution.profileConfigSha256 !== entry.profileConfigSha256 ||
      execution.target !== entry.target ||
      execution.issueRevisionKey !== binding.issueRevisionKey ||
      execution.testedSourceCommit !== binding.testedSourceCommit
    )
      return assessment("blocked", ["invalid_scope"]);
    if (execution.state === "blocked")
      return assessment(
        "blocked",
        execution.reasons.length > 0 ? [...execution.reasons] : ["execution_blocked"],
      );
    if (execution.state === "pending") return assessment("inconclusive", ["execution_pending"]);
    if (execution.state !== "verified") return assessment("blocked", ["invalid_scope"]);
    if (execution.reasons.length > 0) return assessment("blocked", [...execution.reasons]);
    const facts = new Map<string, ReproductionObservationFact>();
    const expectedFacts = new Map(
      allPredicates(entry).map((predicate) => [observationKey(predicate.observation), predicate]),
    );
    for (const fact of execution.observations) {
      assertReproductionObservationFact(fact);
      assertJsonValues(fact);
      const key = observationKey(fact.observation);
      const expected = expectedFacts.get(key);
      const expectedCheckId = `${entry.profileVersionId}:${fact.observation.kind === "ui_assertion" ? fact.observation.scenarioId : fact.observation.testStepId}`;
      if (
        facts.has(key) ||
        expected === undefined ||
        fact.checkId !== expectedCheckId ||
        (fact.state === "observed" && fact.value.type !== expected.equals.type)
      )
        return assessment("blocked", ["invalid_scope"]);
      facts.set(key, fact);
    }
    if (
      new Set(execution.passedPreconditionCheckIds).size !==
        execution.passedPreconditionCheckIds.length ||
      new Set(execution.failedPreconditionCheckIds).size !==
        execution.failedPreconditionCheckIds.length ||
      execution.passedPreconditionCheckIds.some((id) =>
        execution.failedPreconditionCheckIds.includes(id),
      )
    )
      return assessment("blocked", ["invalid_scope"]);
    const preconditionReasons: IssueReproductionCaseReason[] = [];
    for (const precondition of entry.preconditions) {
      const result =
        precondition.kind === "check_passed"
          ? execution.passedPreconditionCheckIds.includes(precondition.checkId)
            ? "matched"
            : execution.failedPreconditionCheckIds.includes(precondition.checkId)
              ? "unmatched"
              : "unknown"
          : predicateState(precondition.predicate, facts);
      if (result !== "matched")
        preconditionReasons.push(
          result === "unknown" ? "precondition_unavailable" : "precondition_failed",
        );
    }
    if (preconditionReasons.length > 0) return assessment("blocked", preconditionReasons);
    const present = signatureState(entry.presentWhen, facts);
    const absent =
      entry.absentWhen === null ? "unmatched" : signatureState(entry.absentWhen, facts);
    if (present === "matched" && absent === "matched")
      return assessment("blocked", ["conflicting_signatures"]);
    if (present === "matched") return assessment("present", [], entry.presentWhen.allOf);
    if (absent === "matched" && entry.absentWhen !== null)
      return assessment("absent", [], entry.absentWhen.allOf);
    const obstructed = allPredicates(entry).some((predicate) => {
      const fact = facts.get(observationKey(predicate.observation));
      return fact?.state === "unavailable" && knownObservationObstructions.has(fact.reason);
    });
    if (obstructed || present === "unknown" || absent === "unknown") {
      return assessment(obstructed ? "blocked" : "inconclusive", ["observation_unavailable"]);
    }
    return assessment("inconclusive", [
      entry.absentWhen === null ? "positive_only" : "signature_not_matched",
    ]);
  });
}

export function aggregateIssueReproduction(
  frozen: FrozenIssueReproductionBinding,
  planDigest: string,
  cases: readonly IssueReproductionCaseAssessment[],
): IssueReproductionAssessmentV1 {
  return {
    schemaVersion: "IssueReproductionAssessmentV1",
    ...aggregate(frozen, planDigest, frozen.binding.cases, cases),
  };
}

export function aggregateIssueReproductionRequest(
  frozen: FrozenIssueReproductionBinding,
  planDigest: string,
  requestId: string,
  cases: readonly IssueReproductionCaseAssessment[],
): IssueReproductionRequestAssessmentV1 {
  return {
    schemaVersion: "IssueReproductionRequestAssessmentV1",
    requestId,
    ...aggregate(
      frozen,
      planDigest,
      frozen.binding.cases.filter((entry) => entry.requestId === requestId),
      cases,
    ),
  };
}

function aggregate(
  frozen: FrozenIssueReproductionBinding,
  planDigest: string,
  expected: readonly FrozenIssueReproductionCase[],
  cases: readonly IssueReproductionCaseAssessment[],
) {
  assertCanonicalBinding(frozen);
  if (!shaPattern.test(planDigest)) throw new TypeError("The reproduction plan digest is invalid.");
  if (expected.length === 0 || cases.length !== expected.length)
    throw new TypeError("Reproduction aggregation requires every expected case exactly once.");
  unique(
    cases.map((entry) => entry.caseId),
    "Reproduction assessment case IDs",
  );
  for (const entry of cases) {
    assertIssueReproductionCaseAssessment(entry);
    const original = expected.find((candidate) => candidate.id === entry.caseId);
    if (
      original === undefined ||
      original.requestId !== entry.requestId ||
      original.profileVersionId !== entry.profileVersionId ||
      original.target !== entry.target
    )
      throw new TypeError("The reproduction assessment scope is invalid.");
    const signature =
      entry.state === "present"
        ? original.presentWhen
        : entry.state === "absent"
          ? original.absentWhen
          : null;
    if (
      (entry.state === "absent" && signature === null) ||
      (signature !== null &&
        (entry.reasons.length !== 0 ||
          canonicalJson([...entry.matchedObservationRefs].sort(byObservation)) !==
            canonicalJson(
              signature.allOf.map((predicate) => predicate.observation).sort(byObservation),
            ))) ||
      (signature === null &&
        (entry.matchedObservationRefs.length !== 0 || entry.evidenceIds.length !== 0))
    )
      throw new TypeError("The reproduction assessment is inconsistent with its signature.");
  }
  const conclusion = cases.some((entry) => entry.state === "present")
    ? ("confirmed" as const)
    : cases.every((entry) => entry.state === "absent")
      ? ("not_reproduced" as const)
      : cases.some((entry) => entry.state === "blocked")
        ? ("blocked" as const)
        : ("inconclusive" as const);
  return {
    rulesVersion: 1 as const,
    bindingDigest: frozen.bindingDigest,
    planDigest,
    issueRevisionKey: frozen.binding.issueRevisionKey,
    testedSourceCommit: frozen.binding.testedSourceCommit,
    conclusion,
    coverage: cases.every((entry) => entry.state === "present" || entry.state === "absent")
      ? ("complete" as const)
      : ("partial" as const),
    cases: [...cases].sort((left, right) => compare(left.caseId, right.caseId)),
  };
}

function canonicalCase<T extends IssueReproductionCaseRequest | FrozenIssueReproductionCase>(
  entry: T,
): T {
  validateCaseLogic(entry);
  return {
    ...entry,
    preconditions: entry.preconditions
      .map(
        (precondition): ReproductionPrecondition =>
          precondition.kind === "check_passed"
            ? { kind: "check_passed", checkId: precondition.checkId }
            : { kind: "observation_equals", predicate: canonicalPredicate(precondition.predicate) },
      )
      .sort((left, right) => compare(preconditionKey(left), preconditionKey(right))),
    presentWhen: { allOf: entry.presentWhen.allOf.map(canonicalPredicate).sort(byPredicate) },
    absentWhen:
      entry.absentWhen === null
        ? null
        : { allOf: entry.absentWhen.allOf.map(canonicalPredicate).sort(byPredicate) },
  };
}

function validateCaseLogic(
  entry: IssueReproductionCaseRequest | FrozenIssueReproductionCase,
): void {
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature !== null)
      unique(
        signature.allOf.map((predicate) => observationKey(predicate.observation)),
        "Signature observation references",
      );
  }
  unique(entry.preconditions.map(preconditionKey), "Reproduction preconditions");
  const types = new Map<string, ObservationValue["type"]>();
  for (const predicate of allPredicates(entry)) {
    const key = observationKey(predicate.observation);
    if (types.has(key) && types.get(key) !== predicate.equals.type)
      throw new TypeError("An observation reference must have one exact type.");
    types.set(key, predicate.equals.type);
  }
  const preconditions = entry.preconditions.flatMap((precondition) =>
    precondition.kind === "observation_equals" ? [precondition.predicate] : [],
  );
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature === null) continue;
    const values = new Map<string, ObservationValue>();
    for (const predicate of [...preconditions, ...signature.allOf]) {
      const key = observationKey(predicate.observation);
      const previous = values.get(key);
      if (previous !== undefined && !equalValues(previous, predicate.equals))
        throw new TypeError("Reproduction preconditions and signatures must be satisfiable.");
      values.set(key, predicate.equals);
    }
  }
  if (
    entry.absentWhen !== null &&
    !entry.presentWhen.allOf.some((present) =>
      entry.absentWhen?.allOf.some(
        (absent) =>
          observationKey(present.observation) === observationKey(absent.observation) &&
          present.equals.type === absent.equals.type &&
          !equalValues(present.equals, absent.equals),
      ),
    )
  ) {
    throw new TypeError("Present and absent signatures must be provably disjoint.");
  }
}

function validateCaseReferences(
  entry: FrozenIssueReproductionCase,
  profile: ValidationProfileVersion,
): void {
  if (entry.target !== "headless") {
    if (
      [
        ...profile.config.setup,
        ...profile.config.build,
        ...profile.config.test,
        ...profile.config.launch,
        ...profile.config.cleanup,
      ].some((step) => step.command.environment.some((variable) => "secretRef" in variable))
    ) {
      throw new TypeError(
        "Mapped UI observations require public fixture commands without secret references.",
      );
    }
    if (profile.config.ui?.target === "web" && profile.config.ui.evidence.trace !== "off") {
      throw new TypeError(
        "Mapped Web observations require the published profile to disable traces.",
      );
    }
  }
  const definitions = observationDefinitions(profile);
  const checkIds = new Set(
    [
      ...profile.config.setup,
      ...profile.config.build,
      ...profile.config.test,
      ...profile.config.cleanup,
      ...(profile.config.ui?.scenarios ?? []),
    ].map((step) => `${profile.id}:${step.id}`),
  );
  const passedChecks = new Set(
    entry.preconditions.flatMap((precondition) =>
      precondition.kind === "check_passed" ? [precondition.checkId] : [],
    ),
  );
  if ([...passedChecks].some((id) => !checkIds.has(id)))
    throw new TypeError("A reproduction precondition must name an existing qualified check.");
  for (const predicate of allPredicates(entry)) {
    const definition = definitions.get(observationKey(predicate.observation));
    if (definition === undefined || definition.type !== predicate.equals.type)
      throw new TypeError("The reproduction observation is unsupported or has the wrong type.");
    if (
      passedChecks.has(definition.checkId) &&
      definition.assertion !== undefined &&
      !satisfiesAssertion(definition.assertion, predicate.equals)
    ) {
      throw new TypeError("A passed UI check contradicts a reproduction observation equality.");
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
    for (const scenario of profile.config.ui?.scenarios ?? []) {
      let priorFailure = false;
      for (const step of scenario.steps) {
        const predicate = predicates.find(
          (candidate) =>
            candidate.observation.kind === "ui_assertion" &&
            candidate.observation.scenarioId === scenario.id &&
            candidate.observation.stepId === step.id,
        );
        if (predicate === undefined) continue;
        if (priorFailure)
          throw new TypeError(
            "A reproduction signature cannot reach an assertion after a required assertion mismatch.",
          );
        if (!satisfiesAssertion(step, predicate.equals)) priorFailure = true;
      }
    }
  }
}

function observationDefinitions(profile: ValidationProfileVersion) {
  const definitions = new Map<
    string,
    { type: ObservationValue["type"]; checkId: string; assertion?: UiScenarioStep }
  >();
  for (const step of profile.config.test) {
    for (const field of step.probeOutput?.fields ?? []) {
      definitions.set(
        observationKey({ kind: "probe_value", testStepId: step.id, observationId: field.id }),
        { type: field.type, checkId: `${profile.id}:${step.id}` },
      );
    }
  }
  for (const scenario of profile.config.ui?.scenarios ?? []) {
    for (const step of scenario.steps) {
      if (step.action === "click" || step.action === "fill") continue;
      definitions.set(
        observationKey({ kind: "ui_assertion", scenarioId: scenario.id, stepId: step.id }),
        {
          type: step.action === "assertVisible" ? "boolean" : "string",
          checkId: `${profile.id}:${scenario.id}`,
          assertion: step,
        },
      );
    }
  }
  return definitions;
}

function satisfiesAssertion(step: UiScenarioStep, value: ObservationValue): boolean {
  if (step.action === "assertVisible")
    return value.type === "boolean" && value.value === step.expected;
  if (step.action === "assertText")
    return (
      value.type === "string" &&
      (step.match === "contains"
        ? value.value.includes(step.expected)
        : value.value === step.expected)
    );
  if (step.action === "assertValue")
    return value.type === "string" && value.value === step.expected;
  return false;
}

function assertCanonicalBinding(frozen: FrozenIssueReproductionBinding): void {
  assertFrozenIssueReproductionBinding(frozen);
  assertJsonValues(frozen);
  unique(
    frozen.binding.cases.map((entry) => entry.id),
    "Frozen reproduction case IDs",
  );
  const canonical = {
    ...frozen.binding,
    cases: frozen.binding.cases.map(canonicalCase).sort(byId),
  };
  if (
    canonicalJson(canonical) !== canonicalJson(frozen.binding) ||
    sha256(canonicalJson(canonical)) !== frozen.bindingDigest
  )
    throw new TypeError(
      "The frozen reproduction binding is not canonical or its digest is invalid.",
    );
}

function assertBindingSource(
  binding: IssueReproductionBindingV1,
  source: IssueReproductionBindingSourceContext,
): void {
  const authorization = source.testedSourceAuthorization;
  if (
    source.workItemKind !== "issue" ||
    source.testedSourceRevision?.kind !== "commit" ||
    authorization === null ||
    binding.activationId !== source.activationId ||
    binding.repositoryId !== source.repositoryId ||
    binding.githubRepositoryId !== source.githubRepositoryId ||
    binding.workItemId !== source.workItemId ||
    binding.githubWorkItemId !== source.githubWorkItemId ||
    binding.issueRevisionKey !== source.issueRevisionKey ||
    binding.testedSourceCommit !== source.testedSourceRevision.headSha ||
    authorization.kind !== "operator" ||
    authorization.activationId !== source.activationId ||
    authorization.githubRepositoryId !== source.githubRepositoryId ||
    authorization.githubWorkItemId !== source.githubWorkItemId ||
    authorization.issueRevisionKey !== source.issueRevisionKey ||
    authorization.headSha !== binding.testedSourceCommit ||
    authorization.issuer.trim() !== authorization.issuer ||
    authorization.subject.trim() !== authorization.subject ||
    canonicalJson(binding.authorizedBy) !==
      canonicalJson({
        issuer: authorization.issuer,
        subject: authorization.subject,
        authorizedAt: authorization.authorizedAt,
      })
  )
    throw new TypeError(
      "The reproduction binding does not match the authoritative Issue and source authorization.",
    );
}

function sourceContext(input: ReviewRunPlanInput): IssueReproductionBindingSourceContext {
  return {
    activationId: input.activationId,
    repositoryId: input.repository.id,
    githubRepositoryId: input.repository.githubRepositoryId,
    workItemId: input.workItemId,
    githubWorkItemId: input.workItem.githubWorkItemId,
    workItemKind: input.workItem.kind,
    issueRevisionKey: input.revision.revisionKey,
    testedSourceRevision: input.testedSourceRevision,
    testedSourceAuthorization: input.testedSourceAuthorization,
  };
}

function predicateState(
  predicate: ObservationEquals,
  facts: ReadonlyMap<string, ReproductionObservationFact>,
): "matched" | "unmatched" | "unknown" {
  const fact = facts.get(observationKey(predicate.observation));
  if (fact === undefined || fact.state === "unavailable") return "unknown";
  return equalValues(fact.value, predicate.equals) ? "matched" : "unmatched";
}
function signatureState(
  signature: ObservationSignature,
  facts: ReadonlyMap<string, ReproductionObservationFact>,
): "matched" | "unmatched" | "unknown" {
  const states = signature.allOf.map((predicate) => predicateState(predicate, facts));
  return states.includes("unmatched")
    ? "unmatched"
    : states.includes("unknown")
      ? "unknown"
      : "matched";
}
function allPredicates(
  entry: IssueReproductionCaseRequest | FrozenIssueReproductionCase,
): ObservationEquals[] {
  return [
    ...entry.presentWhen.allOf,
    ...(entry.absentWhen?.allOf ?? []),
    ...entry.preconditions.flatMap((precondition) =>
      precondition.kind === "observation_equals" ? [precondition.predicate] : [],
    ),
  ];
}
function canonicalPredicate(predicate: ObservationEquals): ObservationEquals {
  return {
    observation: { ...predicate.observation },
    equals:
      predicate.equals.type === "number"
        ? { type: "number", value: predicate.equals.value === 0 ? 0 : predicate.equals.value }
        : { ...predicate.equals },
  };
}
function equalValues(left: ObservationValue, right: ObservationValue): boolean {
  return left.type === right.type && left.value === right.value;
}
/** JSON tuples preserve boundaries even when identifiers themselves contain colons. */
function observationKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}
function preconditionKey(precondition: ReproductionPrecondition): string {
  return precondition.kind === "check_passed"
    ? JSON.stringify([precondition.kind, precondition.checkId])
    : JSON.stringify([precondition.kind, observationKey(precondition.predicate.observation)]);
}
function byObservation(
  left: ReproductionObservationRef,
  right: ReproductionObservationRef,
): number {
  return compare(observationKey(left), observationKey(right));
}
function byPredicate(left: ObservationEquals, right: ObservationEquals): number {
  return byObservation(left.observation, right.observation);
}
function byId(left: { id: string }, right: { id: string }): number {
  return compare(left.id, right.id);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must be unique.`);
}
function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compare);
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function assertJsonValues(value: unknown): void {
  if (typeof value === "string" && !value.isWellFormed())
    throw new TypeError("Reproduction text must contain well-formed Unicode.");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("Reproduction numbers must be finite.");
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    throw new TypeError("Reproduction values must be strict JSON values.");
  if (value !== null && typeof value === "object")
    for (const entry of Object.values(value)) assertJsonValues(entry);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
