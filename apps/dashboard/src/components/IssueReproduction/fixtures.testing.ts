import type {
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  IssueReproductionRequestAssessmentV1,
  ObservationEquals,
} from "@agentic-review/contracts";
import { sampleReviewRunResults } from "../../services/runs/fixtures";
import type { ReproductionCaseSelection } from "./state";

const sample = sampleReviewRunResults.find(
  (entry) =>
    entry.report.workItemKind === "issue" &&
    entry.report.source === "worker" &&
    entry.report.checks.length > 0,
);
const sampleCheck = sample?.report.checks[0];
if (!sample || !sampleCheck)
  throw new Error("A worker issue sample result and check are required.");

export const check = sampleCheck;
export const principal = { issuer: "https://issuer.example/tenant", subject: "Reviewer" };
export const predicates: [ObservationEquals, ObservationEquals, ObservationEquals] = [
  {
    observation: { kind: "ui_assertion", scenarioId: "save", stepId: "focused" },
    equals: { type: "boolean", value: false },
  },
  {
    observation: { kind: "probe_value", testStepId: "measure", observationId: "count" },
    equals: { type: "number", value: 0 },
  },
  {
    observation: { kind: "probe_value", testStepId: "measure", observationId: "message" },
    equals: { type: "string", value: "" },
  },
];
export const recorded: IssueReproductionCaseAssessment = {
  caseId: "case-one",
  requestId: sample.requestId,
  profileVersionId: sample.profileVersionId,
  target: "windows_desktop",
  state: "present",
  matchedObservationRefs: predicates.map((predicate) => predicate.observation),
  evidenceIds: ["evidence-one", "evidence-two", "evidence-three"],
  reasons: [],
};
export const assessment: IssueReproductionAssessmentV1 = {
  schemaVersion: "IssueReproductionAssessmentV1",
  rulesVersion: 1,
  bindingDigest: "a".repeat(64),
  planDigest: sample.planDigest,
  issueRevisionKey: sample.revisionKey,
  testedSourceCommit: "b".repeat(40),
  conclusion: "confirmed",
  coverage: "complete",
  cases: [recorded],
};
const requestAssessment: IssueReproductionRequestAssessmentV1 = {
  ...assessment,
  schemaVersion: "IssueReproductionRequestAssessmentV1",
  requestId: sample.requestId,
};
export const result: DashboardReviewRunResult = {
  ...sample,
  reproduction: {
    recordedAssessment: requestAssessment,
    currentAssessment: requestAssessment,
  },
};
export const detail: DashboardReviewRunReproductionCaseResponse = {
  repositoryId: result.repositoryId,
  reviewRunId: result.reviewRunId,
  requestId: result.requestId,
  caseId: recorded.caseId,
  jobId: result.jobId,
  resultId: result.id,
  bindingDigest: assessment.bindingDigest,
  planDigest: assessment.planDigest,
  binding: {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "activation-one",
    repositoryId: result.repositoryId,
    githubRepositoryId: 1,
    workItemId: result.workItemId,
    githubWorkItemId: 2,
    issueRevisionKey: assessment.issueRevisionKey,
    testedSourceCommit: assessment.testedSourceCommit,
    authorizedBy: { ...principal, authorizedAt: "2026-09-07T01:00:00.000Z" },
    claim: "Saving once loses focus without creating a record or message.",
  },
  case: {
    id: recorded.caseId,
    requestId: recorded.requestId,
    profileVersionId: recorded.profileVersionId,
    profileConfigSha256: "c".repeat(64),
    target: recorded.target,
    context: "Inspect focus, count, and message after one save.\nKeep the same window open.",
    preconditions: [
      { kind: "check_passed", checkId: check.id },
      { kind: "observation_equals", predicate: predicates[0] },
    ],
    presentWhen: { allOf: predicates },
    absentWhen: {
      allOf: [
        { observation: predicates[0].observation, equals: { type: "boolean", value: true } },
        { observation: predicates[1].observation, equals: { type: "number", value: 1 } },
        { observation: predicates[2].observation, equals: { type: "string", value: "Saved" } },
      ],
    },
  },
  current: recorded,
  recorded,
  observations: predicates.map((predicate, index) => ({
    observation: predicate.observation,
    checkId: check.id,
    evidenceIds: [`evidence-${index + 1}`],
    state: "observed",
    value: predicate.equals,
  })),
};
export const selection: ReproductionCaseSelection = {
  repositoryId: detail.repositoryId,
  workItemId: detail.binding.workItemId,
  reviewRunId: detail.reviewRunId,
  requestId: detail.requestId,
  caseId: detail.caseId,
  jobId: result.jobId,
  resultId: result.id,
  bindingDigest: detail.bindingDigest,
  planDigest: detail.planDigest,
  issueRevisionKey: detail.binding.issueRevisionKey,
  testedSourceCommit: detail.binding.testedSourceCommit,
  profileVersionId: detail.case.profileVersionId,
  target: detail.case.target,
};
