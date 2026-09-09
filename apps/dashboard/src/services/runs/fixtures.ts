import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunRequest,
  DashboardReviewRunResult,
  DashboardValidationOutcomeCounts,
  DashboardValidationResultSummary,
} from "@agentic-review/contracts";
import { workItems } from "../review-control/mock/fixtures";

const createdAt = "2026-09-06T20:00:00.000Z";
const startedAt = "2026-09-06T20:00:10.000Z";
const completedAt = "2026-09-06T20:04:00.000Z";

function workItem(id: string) {
  const item = workItems.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`The sample work item ${id} is missing.`);
  return item;
}

const pullRequest = workItem("wi-pr-41982");
const issue = workItem("wi-issue-41876");
const prRunId = "sample-run-pr-41982";
const issueRunId = "sample-run-issue-41876";
const prPlanDigest = "a".repeat(64);
const issuePlanDigest = "b".repeat(64);

function resultSummary(result: DashboardReviewRunResult): DashboardValidationResultSummary {
  const checks: DashboardValidationOutcomeCounts = {
    passed: 0,
    failed: 0,
    blocked: 0,
    not_run: 0,
    skipped: 0,
    inconclusive: 0,
  };
  for (const check of result.report.checks) checks[check.outcome] += 1;
  const findings = [
    ...result.modelReview.findings.map((finding) => ({
      id: finding.findingId,
      priority: finding.priority,
      title: finding.title,
      body: finding.body,
      path: finding.path,
      line: finding.line,
    })),
    ...result.modelReview.observations,
  ];
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return {
    id: result.id,
    resultDigest: result.resultDigest,
    createdAt: result.createdAt,
    summary: result.report.summary,
    summaryTruncated: false,
    sourceState: result.report.sourceState,
    checks,
    modelReviewState: result.modelReview.state,
    recommendation: result.modelReview.recommendation,
    reproductionConclusion:
      result.report.workItemKind === "issue" ? result.report.reproductionConclusion : null,
    findings,
    findingCount: findings.length,
    findingsTruncated: false,
    evidenceIds,
    evidenceCount: evidenceIds.length,
    evidenceTruncated: false,
    evidenceComplete: result.evidenceComplete,
    ...(result.evidenceVerificationPending === true
      ? { evidenceVerificationPending: true as const }
      : {}),
    lifecycleBlockerCount: result.execution.blockers.length,
  };
}

function completedJob(result: DashboardReviewRunResult): DashboardReviewRunJob {
  return {
    jobId: result.jobId,
    activationNumber: result.activationNumber,
    status: "succeeded",
    admission: null,
    phase: "completing",
    attemptCount: 1,
    runAttemptId: result.runAttemptId,
    createdAt,
    startedAt,
    completedAt,
    failureCode: null,
    failureMessage: null,
    resultId: result.id,
    resultDigest: result.resultDigest,
  };
}

const prResult: DashboardReviewRunResult = {
  id: "sample-result-pr-41982-build",
  repositoryId: pullRequest.repositoryId,
  reviewRunId: prRunId,
  workItemId: pullRequest.id,
  requestId: "sample-profile-pr-build",
  jobId: "sample-job-pr-41982-build",
  runAttemptId: "sample-attempt-pr-41982-build-1",
  activationNumber: 1,
  authoritative: true,
  revisionKey: pullRequest.revisionKey,
  planDigest: prPlanDigest,
  profileVersionId: "sample-profile-pr-build-v1",
  promptVersionId: "sample-prompt-pr-build-v1",
  resultDigest: "1".repeat(64),
  createdAt: completedAt,
  evidenceComplete: true,
  report: {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "pull_request",
    sourceState: "original",
    summary:
      "Sample data: static analysis passed, but the release build failed. The execution completed and recorded the failure; the pull request is not ready for approval.",
    checks: [
      {
        id: "sample-profile-pr-build-v1:static-analysis",
        name: "Static analysis",
        kind: "static",
        required: true,
        outcome: "passed",
        summary: "Sample data: no static analysis errors were reported.",
        expected: "No static analysis errors.",
        actual: "No errors in the sample diagnostic output.",
        evidenceIds: ["sample-evidence-pr-static-log"],
        source: "runner",
      },
      {
        id: "sample-profile-pr-build-v1:release-build",
        name: "Release build",
        kind: "build",
        required: true,
        outcome: "failed",
        summary: "Sample data: the FancyZones build could not resolve the monitor identity type.",
        expected: "The release build exits with code 0.",
        actual: "The sample build exited with code 1 after a missing type declaration.",
        evidenceIds: ["sample-evidence-pr-build-log"],
        source: "runner",
      },
    ],
  },
  execution: {
    blockers: [],
    diagnostics: [
      {
        stepId: "sample-profile-pr-build-v1:release-build",
        phase: "build",
        outcome: "failed",
        exitCode: 1,
        summary: "Sample build diagnostic; no command was executed by this dashboard.",
        stdout: "Sample release build started for FancyZones.",
        stderr: "Sample compiler error: the monitor identity type is not declared.",
      },
    ],
    cleanupState: "completed",
  },
  modelReview: {
    execution: null,
    state: "completed",
    summary: "Sample review: restore the missing monitor type declaration before merging.",
    recommendation: "request_changes",
    findings: [
      {
        findingId: "sample-finding-monitor-type",
        ordinal: 0,
        priority: 1,
        title: "Restore the monitor identity declaration",
        body: "Sample finding: the new monitor identity reference is missing its declaration, so the release target cannot compile.",
        path: "src/modules/fancyzones/FancyZonesLib/FancyZones.cpp",
        line: 142,
        endLine: null,
        confidence: 0.96,
      },
    ],
    observations: [],
    issueTriage: null,
    reproductionConclusion: null,
    error: null,
  },
};

const issueTriageResult: DashboardReviewRunResult = {
  id: "sample-result-issue-41876-triage",
  repositoryId: issue.repositoryId,
  reviewRunId: issueRunId,
  workItemId: issue.id,
  requestId: "sample-profile-issue-triage",
  jobId: "sample-job-issue-41876-triage",
  runAttemptId: "sample-attempt-issue-41876-triage-1",
  activationNumber: 1,
  authoritative: true,
  revisionKey: issue.revisionKey,
  planDigest: issuePlanDigest,
  profileVersionId: "sample-profile-issue-triage-v1",
  promptVersionId: "sample-prompt-issue-triage-v1",
  resultDigest: "2".repeat(64),
  createdAt: completedAt,
  evidenceComplete: true,
  report: {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "issue",
    sourceState: "original",
    summary:
      "Sample data: the report describes a Keyboard Manager focus regression. Triage identified a reproduction path without executing repository code.",
    reproductionConclusion: "needs_information",
    checks: [],
  },
  execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
  modelReview: {
    execution: null,
    state: "completed",
    summary:
      "Sample triage: selecting a remap target appears to move keyboard focus outside the editor. Capture the PowerToys version and display configuration.",
    recommendation: null,
    findings: [],
    observations: [],
    issueTriage: {
      category: "bug",
      priority: 2,
      confidence: 0.9,
      suggestedLabels: ["Product-Keyboard Manager", "Needs-Triage"],
      missingInformation: ["PowerToys version and display scaling settings."],
      duplicateCandidates: [],
    },
    reproductionConclusion: "needs_information",
    error: null,
  },
};

const issueValidationResult: DashboardReviewRunResult = {
  id: "sample-result-issue-41876-reproduction",
  repositoryId: issue.repositoryId,
  reviewRunId: issueRunId,
  workItemId: issue.id,
  requestId: "sample-profile-issue-reproduction",
  jobId: "sample-job-issue-41876-reproduction",
  runAttemptId: "sample-attempt-issue-41876-reproduction-1",
  activationNumber: 1,
  authoritative: true,
  revisionKey: issue.revisionKey,
  planDigest: issuePlanDigest,
  profileVersionId: "sample-profile-issue-reproduction-v1",
  promptVersionId: "sample-prompt-issue-reproduction-v1",
  resultDigest: "3".repeat(64),
  createdAt: completedAt,
  evidenceComplete: true,
  report: {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "issue",
    sourceState: "original",
    summary:
      "Sample data: the focus regression was reproduced. The focus assertion failed after target selection; this is reproduction evidence, not an approval decision.",
    reproductionConclusion: "confirmed",
    checks: [
      {
        id: "sample-profile-issue-reproduction-v1:focus-restoration",
        name: "Focus returns to the remap editor",
        kind: "ui",
        required: true,
        outcome: "failed",
        summary: "Sample data: keyboard focus left the remap editor after target selection.",
        expected: "The remap editor remains keyboard focused.",
        actual: "The sample assertion observed focus on the parent settings window.",
        evidenceIds: [
          "sample-evidence-issue-focus-steps",
          "sample-evidence-issue-focus-screenshot",
        ],
        source: "runner",
      },
    ],
  },
  execution: {
    blockers: [],
    diagnostics: [
      {
        stepId: "sample-profile-issue-reproduction-v1:focus-restoration",
        phase: "ui",
        outcome: "failed",
        exitCode: null,
        summary: "Sample assertion evidence: expected remap editor focus; observed settings focus.",
      },
    ],
    cleanupState: "completed",
  },
  modelReview: {
    execution: null,
    state: "completed",
    summary: "Sample reproduction: focus moves to the parent window when target selection closes.",
    recommendation: null,
    findings: [],
    observations: [
      {
        id: "sample-observation-issue-focus",
        title: "Focus changes when target selection closes",
        body: "Sample observation: the remap editor stops receiving keyboard input until it is focused again.",
        priority: 2,
        path: null,
        line: null,
      },
    ],
    issueTriage: null,
    reproductionConclusion: "confirmed",
    error: null,
  },
};

function completedRequest(
  result: DashboardReviewRunResult,
  workflowKind: DashboardReviewRunRequest["workflowKind"],
  target: DashboardReviewRunRequest["target"],
  name: string,
): DashboardReviewRunRequest {
  return {
    requestId: result.requestId,
    workflowKind,
    target,
    required: true,
    profile: {
      id: result.profileVersionId,
      profileId: result.requestId,
      name,
      version: 1,
      configSha256: "4".repeat(64),
    },
    prompt: {
      id: result.promptVersionId,
      templateId: result.promptVersionId.replace(/-v1$/, ""),
      version: 1,
      contentSha256: "5".repeat(64),
    },
    requiredCheckIds: result.report.checks
      .filter((check) => check.required)
      .map((check) => check.id),
    readiness: "ready",
    blockers: [],
    blockersTruncated: false,
    latestJob: completedJob(result),
    latestResult: resultSummary(result),
  };
}

const prRequests: DashboardReviewRunRequest[] = [
  completedRequest(
    prResult,
    "pr_static_build",
    "headless",
    "Sample PowerToys static analysis and build",
  ),
  {
    requestId: "sample-profile-pr-ui",
    workflowKind: "pr_ui",
    target: "windows_desktop",
    required: true,
    profile: {
      id: "sample-profile-pr-ui-v1",
      profileId: "sample-profile-pr-ui",
      name: "Sample Windows interface validation",
      version: 1,
      configSha256: "6".repeat(64),
    },
    prompt: null,
    requiredCheckIds: ["sample-profile-pr-ui-v1:layout-restoration"],
    readiness: "blocked",
    blockers: ["missing_prompt"],
    blockersTruncated: false,
    latestJob: null,
    latestResult: null,
  },
];
const issueRequests: DashboardReviewRunRequest[] = [
  completedRequest(issueTriageResult, "issue_triage", "headless", "Sample issue triage"),
  completedRequest(
    issueValidationResult,
    "issue_validation",
    "windows_desktop",
    "Sample Keyboard Manager reproduction",
  ),
];

export const sampleReviewRunResults: readonly DashboardReviewRunResult[] = [
  prResult,
  issueTriageResult,
  issueValidationResult,
];

export const sampleReviewRuns: readonly DashboardReviewRunDetail[] = [
  {
    id: prRunId,
    repositoryId: pullRequest.repositoryId,
    repository: pullRequest.repository,
    workItemId: pullRequest.id,
    workItemKind: "pull_request",
    number: pullRequest.number,
    title: pullRequest.title,
    revisionKey: pullRequest.revisionKey,
    currentRevisionKey: pullRequest.revisionKey,
    freshness: "current",
    planDigest: prPlanDigest,
    activationId: "sample-activation-pr-41982",
    createdAt,
    requestCount: prRequests.length,
    requiredRequestCount: prRequests.length,
    execution: {
      missing: 1,
      awaitingAdmission: 0,
      queued: 0,
      active: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    },
    requestEpochId: "sample-epoch-pr-41982",
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "d".repeat(40),
      headSha: pullRequest.headSha ?? "",
    },
    requiredCheckIds: prRequests.flatMap((request) => request.requiredCheckIds),
    requests: prRequests,
    policy: {
      policyVersion: "required-checks-and-p0-p1-v1",
      applicable: true,
      eligible: false,
      reasons: [
        {
          code: "required_check_not_passed",
          checkId: "sample-profile-pr-build-v1:release-build",
          reportIndex: 0,
          outcome: "failed",
        },
        { code: "missing_required_check", checkId: "sample-profile-pr-ui-v1:layout-restoration" },
        {
          code: "required_request_blocked",
          requestId: "sample-profile-pr-ui",
          reason: "missing_prompt",
        },
        { code: "blocking_findings" },
      ],
      reasonCount: 4,
      reasonsTruncated: false,
      blockingFindingCount: 1,
    },
  },
  {
    id: issueRunId,
    repositoryId: issue.repositoryId,
    repository: issue.repository,
    workItemId: issue.id,
    workItemKind: "issue",
    number: issue.number,
    title: issue.title,
    revisionKey: issue.revisionKey,
    currentRevisionKey: issue.revisionKey,
    freshness: "current",
    planDigest: issuePlanDigest,
    activationId: "sample-activation-issue-41876",
    createdAt,
    requestCount: issueRequests.length,
    requiredRequestCount: issueRequests.length,
    execution: {
      missing: 0,
      awaitingAdmission: 0,
      queued: 0,
      active: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
    },
    requestEpochId: "sample-epoch-issue-41876",
    testedSourceRevision: { kind: "commit", headSha: "e".repeat(40) },
    requiredCheckIds: issueRequests.flatMap((request) => request.requiredCheckIds),
    requests: issueRequests,
    policy: {
      policyVersion: "required-checks-and-p0-p1-v1",
      applicable: false,
      eligible: null,
      reasons: [],
      reasonCount: 0,
      reasonsTruncated: false,
      blockingFindingCount: 0,
    },
  },
];
