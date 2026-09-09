import type {
  DashboardReviewRunDetail,
  DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunReproductionSummary,
  DashboardReviewRunResult,
  FrozenIssueReproductionCase,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  IssueReproductionCaseRequest,
  IssueReproductionRequestAssessmentV1,
  ObservationEquals,
  OperatorReviewRunCreateRequest,
  ReproductionObservationRef,
} from "@agentic-review/contracts";
import { maximumTestProbeOutputUtf8Bytes } from "@agentic-review/contracts";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";

type CaseIdentity = DashboardReviewRunReproductionSummary["cases"][number];
type CaseDefinition = IssueReproductionCaseRequest | FrozenIssueReproductionCase;
type Assessment = IssueReproductionAssessmentV1 | IssueReproductionRequestAssessmentV1;

function invalid(operation: string, reason: string): never {
  throw new ReviewControlProtocolError(operation, `The ${operation} response ${reason}.`);
}

function refKey(ref: ReproductionObservationRef): string {
  return ref.kind === "ui_assertion"
    ? JSON.stringify([ref.kind, ref.scenarioId, ref.stepId])
    : JSON.stringify([ref.kind, ref.testStepId, ref.observationId]);
}

function checkId(profileVersionId: string, ref: ReproductionObservationRef): string {
  return `${profileVersionId}:${ref.kind === "ui_assertion" ? ref.scenarioId : ref.testStepId}`;
}

function predicates(entry: CaseDefinition): ObservationEquals[] {
  return [
    ...entry.presentWhen.allOf,
    ...(entry.absentWhen?.allOf ?? []),
    ...entry.preconditions.flatMap((control) =>
      control.kind === "observation_equals" ? [control.predicate] : [],
    ),
  ];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((entry) => right.includes(entry))
  );
}

function equalPredicateValue(left: ObservationEquals, right: ObservationEquals): boolean {
  return left.equals.type === right.equals.type && left.equals.value === right.equals.value;
}

function validCaseDefinition(entry: CaseDefinition): boolean {
  const expectedProfileVersionId =
    "profileVersionId" in entry ? entry.profileVersionId : entry.expectedProfileVersionId;
  const preconditions = entry.preconditions.flatMap((control) =>
    control.kind === "observation_equals" ? [control.predicate] : [],
  );
  if (
    "target" in entry &&
    entry.target === "headless" &&
    predicates(entry).some((predicate) => predicate.observation.kind === "ui_assertion")
  )
    return false;
  const preconditionKeys = entry.preconditions.map((control) =>
    control.kind === "check_passed"
      ? `check:${control.checkId}`
      : `observation:${refKey(control.predicate.observation)}`,
  );
  if (
    new Set(preconditionKeys).size !== preconditionKeys.length ||
    entry.preconditions.some(
      (control) =>
        control.kind === "check_passed" &&
        !control.checkId.startsWith(`${expectedProfileVersionId}:`),
    )
  )
    return false;
  const types = new Map<string, ObservationEquals["equals"]["type"]>();
  for (const predicate of predicates(entry)) {
    const key = refKey(predicate.observation);
    if (types.has(key) && types.get(key) !== predicate.equals.type) return false;
    types.set(key, predicate.equals.type);
  }
  for (const signature of [entry.presentWhen, entry.absentWhen]) {
    if (signature === null) continue;
    if (
      new Set(signature.allOf.map((predicate) => refKey(predicate.observation))).size !==
      signature.allOf.length
    )
      return false;
    const values = new Map<string, ObservationEquals>();
    for (const predicate of [...preconditions, ...signature.allOf]) {
      const key = refKey(predicate.observation);
      const previous = values.get(key);
      if (previous !== undefined && !equalPredicateValue(previous, predicate)) return false;
      values.set(key, predicate);
    }
  }
  return (
    entry.absentWhen === null ||
    entry.presentWhen.allOf.some((present) =>
      entry.absentWhen?.allOf.some(
        (absent) =>
          refKey(present.observation) === refKey(absent.observation) &&
          !equalPredicateValue(present, absent),
      ),
    )
  );
}

export function validateReproductionCreateRequest(
  input: OperatorReviewRunCreateRequest,
  operation: string,
): void {
  if (input.reproduction === undefined) return;
  if (
    input.testedSourceCommit === undefined ||
    new Set(input.reproduction.cases.map((entry) => entry.id)).size !==
      input.reproduction.cases.length ||
    input.reproduction.cases.some((entry) => !validCaseDefinition(entry))
  )
    throw new ReviewControlRequestError(
      operation,
      "reproduction",
      "Mapped reproduction requires an exact source commit and unique, consistent case definitions.",
    );
}

export function validateCreatedReproduction(
  detail: DashboardReviewRunDetail,
  input: OperatorReviewRunCreateRequest,
  operation: string,
): void {
  const intent = input.reproduction;
  const actual = detail.reproduction;
  if ((intent === undefined) !== (actual === undefined))
    invalid(operation, "does not preserve the requested reproduction mapping");
  if (intent === undefined || actual === undefined) return;
  if (
    actual.claim !== intent.claim ||
    actual.caseCount !== intent.cases.length ||
    intent.cases.some((entry) => {
      const mapped = actual.cases.find((candidate) => candidate.caseId === entry.id);
      const request = detail.requests.find(
        (candidate) => candidate.requestId === mapped?.requestId,
      );
      return (
        mapped === undefined ||
        mapped.context !== entry.context ||
        mapped.profileVersionId !== entry.expectedProfileVersionId ||
        request?.profile?.profileId !== entry.profileId
      );
    })
  )
    invalid(
      operation,
      "does not match the requested reproduction claim, cases, or profile versions",
    );
}

function validateCaseAssessment(
  assessment: IssueReproductionCaseAssessment,
  expected: CaseIdentity,
  operation: string,
): void {
  if (
    assessment.caseId !== expected.caseId ||
    assessment.requestId !== expected.requestId ||
    assessment.profileVersionId !== expected.profileVersionId ||
    assessment.target !== expected.target
  )
    invalid(operation, "contains a reproduction assessment outside its frozen case scope");
  const decisive = assessment.state === "present" || assessment.state === "absent";
  if (
    (decisive &&
      (assessment.reasons.length !== 0 || assessment.matchedObservationRefs.length === 0)) ||
    (!decisive &&
      (assessment.matchedObservationRefs.length !== 0 || assessment.evidenceIds.length !== 0))
  )
    invalid(operation, "contains inconsistent reproduction matches or reasons");
}

function validateAssessment(
  assessment: Assessment,
  expected: readonly CaseIdentity[],
  detail: DashboardReviewRunDetail,
  operation: string,
): void {
  if (
    detail.reproduction === undefined ||
    detail.testedSourceRevision?.kind !== "commit" ||
    assessment.bindingDigest !== detail.reproduction.bindingDigest ||
    assessment.planDigest !== detail.planDigest ||
    assessment.issueRevisionKey !== detail.revisionKey ||
    assessment.testedSourceCommit !== detail.testedSourceRevision.headSha ||
    !sameSet(
      assessment.cases.map((entry) => entry.caseId),
      expected.map((entry) => entry.caseId),
    )
  )
    invalid(operation, "contains inconsistent reproduction binding, source, or case identities");
  for (const entry of assessment.cases) {
    const identity = expected.find((candidate) => candidate.caseId === entry.caseId);
    if (identity === undefined) invalid(operation, "contains an unexpected reproduction case");
    validateCaseAssessment(entry, identity, operation);
  }
  const conclusion = assessment.cases.some((entry) => entry.state === "present")
    ? "confirmed"
    : assessment.cases.every((entry) => entry.state === "absent")
      ? "not_reproduced"
      : assessment.cases.some((entry) => entry.state === "blocked")
        ? "blocked"
        : "inconclusive";
  const coverage = assessment.cases.every(
    (entry) => entry.state === "present" || entry.state === "absent",
  )
    ? "complete"
    : "partial";
  if (assessment.conclusion !== conclusion || assessment.coverage !== coverage)
    invalid(operation, "contains reproduction totals that disagree with the individual cases");
}

export function validateRunReproductionSummary(
  detail: DashboardReviewRunDetail,
  operation: string,
): void {
  const reproduction = detail.reproduction;
  if (reproduction === undefined) return;
  if (
    detail.workItemKind !== "issue" ||
    detail.testedSourceRevision?.kind !== "commit" ||
    reproduction.caseCount !== reproduction.cases.length ||
    new Set(reproduction.cases.map((entry) => entry.caseId)).size !== reproduction.cases.length
  )
    invalid(operation, "contains reproduction mapping without a unique Issue source and cases");
  for (const entry of reproduction.cases) {
    const request = detail.requests.find((candidate) => candidate.requestId === entry.requestId);
    if (
      request?.workflowKind !== "issue_validation" ||
      request.profile?.id !== entry.profileVersionId ||
      request.target !== entry.target
    )
      invalid(operation, "maps reproduction to another frozen profile or workflow");
  }
  validateAssessment(reproduction.assessment, reproduction.cases, detail, operation);
  for (const entry of reproduction.assessment.cases) {
    if (entry.state !== "present" && entry.state !== "absent") continue;
    const request = detail.requests.find((candidate) => candidate.requestId === entry.requestId);
    if (
      request?.latestJob?.status !== "succeeded" ||
      request.latestResult?.sourceState !== "original"
    )
      invalid(operation, "claims a reproduction match without an original completed result");
  }
}

function settledObservation(
  result: DashboardReviewRunResult,
  ref: ReproductionObservationRef,
): boolean {
  const id = checkId(result.profileVersionId, ref);
  const check = result.report.checks.find((entry) => entry.id === id);
  const diagnostic = result.execution.diagnostics.find((entry) => entry.stepId === id);
  return (
    check?.source === "runner" &&
    diagnostic?.outcome === check.outcome &&
    diagnostic.exitCode === 0 &&
    (ref.kind === "ui_assertion"
      ? check.kind === "ui" &&
        diagnostic.phase === "ui" &&
        (check.outcome === "passed" || check.outcome === "failed")
      : check.kind === "test" && check.outcome === "passed" && diagnostic.phase === "test")
  );
}

export function validateRunResultReproduction(
  result: DashboardReviewRunResult,
  detail: DashboardReviewRunDetail,
  operation: string,
): void {
  const expected =
    detail.reproduction?.cases.filter((entry) => entry.requestId === result.requestId) ?? [];
  if (expected.length > 0 !== (result.reproduction !== undefined))
    invalid(operation, "does not preserve the frozen request reproduction mapping");
  const receipts = result.probeReceipts ?? [];
  if (new Set(receipts.map((receipt) => receipt.checkId)).size !== receipts.length)
    invalid(operation, "contains duplicate probe receipts");
  for (const receipt of receipts) {
    const check = result.report.checks.find((entry) => entry.id === receipt.checkId);
    const diagnostic = result.execution.diagnostics.find(
      (entry) => entry.stepId === receipt.checkId,
    );
    if (
      receipt.requestId !== result.requestId ||
      receipt.jobId !== result.jobId ||
      receipt.runAttemptId !== result.runAttemptId ||
      receipt.planDigest !== result.planDigest ||
      receipt.profileVersionId !== result.profileVersionId ||
      !receipt.checkId.startsWith(`${result.profileVersionId}:`) ||
      check?.kind !== "test" ||
      check.source !== "runner" ||
      check.outcome !== "passed" ||
      diagnostic?.phase !== "test" ||
      diagnostic.outcome !== "passed" ||
      diagnostic.exitCode !== 0 ||
      new Set(receipt.output.observations.map((entry) => entry.id)).size !==
        receipt.output.observations.length
    )
      invalid(operation, "contains a probe receipt outside its settled execution scope");
  }
  if (result.reproduction === undefined) return;
  if (result.report.workItemKind !== "issue" || result.report.source !== "worker")
    invalid(operation, "contains reproduction assessments outside an Issue worker report");
  const { recordedAssessment, currentAssessment } = result.reproduction;
  for (const assessment of [recordedAssessment, currentAssessment]) {
    if (assessment.requestId !== result.requestId)
      invalid(operation, "contains reproduction for another request");
    validateAssessment(assessment, expected, detail, operation);
    for (const entry of assessment.cases) {
      const checks = entry.matchedObservationRefs.map((ref) =>
        result.report.checks.find((check) => check.id === checkId(result.profileVersionId, ref)),
      );
      if (
        checks.some(
          (check, index) =>
            check === undefined ||
            check.source !== "runner" ||
            check.kind !==
              (entry.matchedObservationRefs[index]?.kind === "ui_assertion" ? "ui" : "test"),
        ) ||
        entry.evidenceIds.some((id) => !checks.some((check) => check?.evidenceIds.includes(id))) ||
        entry.matchedObservationRefs.some((ref) => !settledObservation(result, ref)) ||
        ((entry.state === "present" || entry.state === "absent") &&
          result.report.sourceState !== "original")
      )
        invalid(operation, "contains reproduction matches outside the original runner evidence");
    }
  }
  if (result.report.reproductionConclusion !== recordedAssessment.conclusion)
    invalid(operation, "disagrees with the immutable recorded reproduction conclusion");
  if (
    !result.authoritative &&
    currentAssessment.cases.some(
      (entry) => entry.state !== "blocked" || !sameSet(entry.reasons, ["invalid_scope"]),
    )
  )
    invalid(operation, "presents a historical activation as current reproduction evidence");
  // Current assessments may change with evidence verification and retention between reads.
  // Model recommendations and legacy model conclusions never establish case outcomes.
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function validateRunProbeReceiptDigests(
  result: DashboardReviewRunResult,
  operation: string,
): Promise<void> {
  for (const receipt of result.probeReceipts ?? []) {
    const bytes = new TextEncoder().encode(canonicalJson(receipt.output));
    if (bytes.byteLength > maximumTestProbeOutputUtf8Bytes)
      invalid(operation, "contains an oversized complete probe document");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    if (
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") !==
      receipt.outputSha256
    )
      invalid(operation, "contains a probe document that does not match its immutable digest");
  }
}

function sameAssessment(
  left: IssueReproductionCaseAssessment,
  right: IssueReproductionCaseAssessment,
): boolean {
  return (
    left.caseId === right.caseId &&
    left.requestId === right.requestId &&
    left.profileVersionId === right.profileVersionId &&
    left.target === right.target &&
    left.state === right.state &&
    sameSet(left.matchedObservationRefs.map(refKey), right.matchedObservationRefs.map(refKey)) &&
    sameSet(left.evidenceIds, right.evidenceIds) &&
    sameSet(left.reasons, right.reasons)
  );
}

export function validateRunReproductionCase(
  response: DashboardReviewRunReproductionCaseResponse,
  query: DashboardReviewRunReproductionCaseQuery,
  detail: DashboardReviewRunDetail,
  result: DashboardReviewRunResult | null,
  operation: string,
): DashboardReviewRunReproductionCaseResponse {
  const summary = detail.reproduction;
  const expected = summary?.cases.find(
    (entry) => entry.caseId === query.caseId && entry.requestId === query.requestId,
  );
  const request = detail.requests.find((entry) => entry.requestId === query.requestId);
  const entry = response.case;
  if (
    summary === undefined ||
    expected === undefined ||
    request?.profile === null ||
    request?.profile === undefined ||
    response.repositoryId !== query.repositoryId ||
    response.reviewRunId !== query.reviewRunId ||
    response.requestId !== query.requestId ||
    response.caseId !== query.caseId ||
    (query.jobId !== undefined && response.jobId !== query.jobId) ||
    response.binding.repositoryId !== detail.repositoryId ||
    response.binding.workItemId !== detail.workItemId ||
    response.binding.activationId !== detail.activationId ||
    response.binding.issueRevisionKey !== detail.revisionKey ||
    detail.testedSourceRevision?.kind !== "commit" ||
    response.binding.testedSourceCommit !== detail.testedSourceRevision.headSha ||
    response.binding.claim !== summary.claim ||
    response.bindingDigest !== summary.bindingDigest ||
    response.planDigest !== detail.planDigest ||
    entry.id !== expected.caseId ||
    entry.requestId !== expected.requestId ||
    entry.profileVersionId !== expected.profileVersionId ||
    entry.profileConfigSha256 !== request.profile.configSha256 ||
    entry.target !== expected.target ||
    entry.context !== expected.context ||
    !validCaseDefinition(entry)
  )
    invalid(operation, "does not match the selected frozen reproduction case and source");
  if (
    (response.resultId === null) !== (response.recorded === null) ||
    (response.resultId !== null && response.jobId === null) ||
    (response.resultId === null) !== (result === null) ||
    (result !== null && (result.id !== response.resultId || result.jobId !== response.jobId))
  )
    invalid(operation, "contains inconsistent reproduction result identities");
  for (const assessment of [
    response.current,
    ...(response.recorded === null ? [] : [response.recorded]),
  ]) {
    validateCaseAssessment(assessment, expected, operation);
    const signature =
      assessment.state === "present"
        ? entry.presentWhen
        : assessment.state === "absent"
          ? entry.absentWhen
          : null;
    if (
      (assessment.state === "absent" && signature === null) ||
      (signature !== null &&
        !sameSet(
          assessment.matchedObservationRefs.map(refKey),
          signature.allOf.map((predicate) => refKey(predicate.observation)),
        ))
    )
      invalid(operation, "contains reproduction matches outside the frozen signature");
  }
  const recorded = result?.reproduction?.recordedAssessment.cases.find(
    (candidate) => candidate.caseId === entry.id,
  );
  if (
    response.recorded !== null &&
    (recorded === undefined || !sameAssessment(response.recorded, recorded))
  )
    invalid(operation, "does not match the immutable recorded reproduction case");
  const expectedPredicates = new Map(
    predicates(entry).map((predicate) => [refKey(predicate.observation), predicate]),
  );
  const facts = new Map(response.observations.map((fact) => [refKey(fact.observation), fact]));
  if (facts.size !== response.observations.length || (result === null && facts.size !== 0))
    invalid(
      operation,
      "contains duplicate observations or observations without an execution result",
    );
  for (const [key, fact] of facts) {
    const predicate = expectedPredicates.get(key);
    const check = result?.report.checks.find((candidate) => candidate.id === fact.checkId);
    if (
      predicate === undefined ||
      fact.checkId !== checkId(entry.profileVersionId, fact.observation) ||
      (fact.state === "observed" && fact.value.type !== predicate.equals.type) ||
      check === undefined ||
      check.source !== "runner" ||
      check.kind !== (fact.observation.kind === "ui_assertion" ? "ui" : "test") ||
      fact.evidenceIds.some((id) => !check.evidenceIds.includes(id))
    )
      invalid(operation, "contains observations outside the frozen references, types, or evidence");
    if (fact.state === "observed" && fact.observation.kind === "probe_value") {
      // The case endpoint verifies complete receipts before projecting facts. Some bounded
      // result projections omit receipts; when supplied, they must agree with the fact.
      const observationId = fact.observation.observationId;
      const captured = result?.probeReceipts
        ?.find((receipt) => receipt.checkId === fact.checkId)
        ?.output.observations.find((candidate) => candidate.id === observationId);
      if (
        fact.evidenceIds.length !== 0 ||
        (result?.probeReceipts !== undefined &&
          (captured?.state !== "observed" ||
            captured.value.type !== fact.value.type ||
            captured.value.value !== fact.value.value))
      )
        invalid(operation, "contains a probe observation inconsistent with its captured receipt");
    }
  }
  const signature =
    response.current.state === "present"
      ? entry.presentWhen
      : response.current.state === "absent"
        ? entry.absentWhen
        : null;
  if (signature !== null) {
    if (
      result?.report.sourceState !== "original" ||
      [
        ...signature.allOf,
        ...entry.preconditions.flatMap((control) =>
          control.kind === "observation_equals" ? [control.predicate] : [],
        ),
      ].some((predicate) => {
        const fact = facts.get(refKey(predicate.observation));
        return (
          fact?.state !== "observed" ||
          result === null ||
          !settledObservation(result, predicate.observation) ||
          fact.value.type !== predicate.equals.type ||
          fact.value.value !== predicate.equals.value ||
          (fact.observation.kind === "ui_assertion" && fact.evidenceIds.length === 0)
        );
      }) ||
      !sameSet(response.current.evidenceIds, [
        ...new Set(
          signature.allOf.flatMap(
            (predicate) => facts.get(refKey(predicate.observation))?.evidenceIds ?? [],
          ),
        ),
      ]) ||
      entry.preconditions.some(
        (control) =>
          control.kind === "check_passed" &&
          !result.report.checks.some(
            (check) =>
              check.id === control.checkId &&
              check.source === "runner" &&
              check.outcome === "passed" &&
              result.execution.diagnostics.some(
                (diagnostic) =>
                  diagnostic.stepId === check.id &&
                  diagnostic.outcome === "passed" &&
                  diagnostic.exitCode === 0,
              ),
          ),
      )
    )
      invalid(
        operation,
        "claims a reproduction match without the required observed values and evidence",
      );
  }
  return response;
}
