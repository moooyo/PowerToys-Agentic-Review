import type {
  EvaluationSourceCaptureRequest,
  EvaluationSourceDetailV1,
  EvaluationSourceListResponse,
  EvaluationSourceSnapshotV1,
  EvaluationSourceSummaryV1,
  EvaluationSuiteCaseDetailV1,
  EvaluationSuiteCaseListV1,
  EvaluationSuiteCaseSummaryV1,
  EvaluationSuiteCreateRequest,
  EvaluationSuiteDetailV1,
  EvaluationSuiteDraft,
  EvaluationSuiteDraftCase,
  EvaluationSuiteListResponse,
  EvaluationSuitePublishRequest,
  EvaluationSuiteSaveRequest,
  EvaluationSuiteSummaryV1,
  EvaluationSuiteVersionListResponse,
  EvaluationSuiteVersionV1,
  OperatorPrincipal,
} from "@agentic-review/contracts";

export const evaluationTestActor: OperatorPrincipal = {
  issuer: "https://fixture.example.test",
  subject: "evaluation-maintainer",
};
export const evaluationTestTime = "2026-09-08T01:00:00.000Z";
export const evaluationTestSourceScope = { repositoryId: "repository-a", sourceId: "source-a" };
export const evaluationTestSuiteScope = { repositoryId: "repository-a", suiteId: "suite-a" };
export const evaluationTestVersionScope = {
  ...evaluationTestSuiteScope,
  versionId: "version-a",
};
export const evaluationTestCaseScope = { ...evaluationTestVersionScope, caseId: "case-1" };

export function sourceCaptureRequestFixture(): EvaluationSourceCaptureRequest {
  return {
    changeId: "capture-a",
    source: {
      kind: "current_work_item",
      workItemId: "work-item-a",
      expectedRevisionKey: "a".repeat(64),
      testedIssueCommit: null,
    },
  };
}

export function sourceSnapshotFixture(): EvaluationSourceSnapshotV1 {
  return {
    schemaVersion: "EvaluationSourceSnapshotV1",
    repository: {
      id: evaluationTestSourceScope.repositoryId,
      githubRepositoryId: 100,
      fullName: "fixture-owner/evaluation-target",
      configurationVersion: 1,
    },
    workItemId: "work-item-a",
    revisionId: "revision-a",
    workItem: {
      kind: "pull_request",
      githubWorkItemId: 200,
      githubNodeId: "NODE_200",
      githubRepositoryId: 100,
      number: 7,
      title: "Preserve the original failing source",
      body: "Complete frozen source text.\nRequired build: failed.\n<!-- exact-source -->",
      state: "open",
      author: { githubUserId: 300, login: "contributor" },
      htmlUrl: "https://github.com/fixture-owner/evaluation-target/pull/7",
      createdAt: evaluationTestTime,
      updatedAt: evaluationTestTime,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      revisionKey: "a".repeat(64),
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    freshness: "frozen",
    sourceDigest: "d".repeat(64),
    provenance: {
      kind: "current_work_item",
      capturedAt: evaluationTestTime,
      expectedRevisionKey: "a".repeat(64),
    },
  };
}

export function sourceSummaryFixture(
  snapshot = sourceSnapshotFixture(),
): EvaluationSourceSummaryV1 {
  return {
    schemaVersion: "EvaluationSourceSummaryV1",
    id: evaluationTestSourceScope.sourceId,
    repositoryId: snapshot.repository.id,
    workItemId: snapshot.workItemId,
    revisionId: snapshot.revisionId,
    revisionKey: snapshot.revision.revisionKey,
    sourceDigest: snapshot.sourceDigest,
    workItemKind: snapshot.workItem.kind,
    number: snapshot.workItem.number,
    title: snapshot.workItem.title,
    createdAt: snapshot.provenance.capturedAt,
    createdBy: { ...evaluationTestActor },
  };
}

export function sourceDetailFixture(snapshot = sourceSnapshotFixture()): EvaluationSourceDetailV1 {
  return { ...sourceSummaryFixture(snapshot), snapshot };
}

export function sourceListFixture(): EvaluationSourceListResponse {
  return {
    repositoryId: evaluationTestSourceScope.repositoryId,
    total: 1,
    page: 1,
    pageSize: 20,
    items: [sourceSummaryFixture()],
  };
}

export function suiteDraftCaseFixture(index = 1): EvaluationSuiteDraftCase {
  return {
    caseId: `case-${index}`,
    title: "A complete negative example",
    sourceId: evaluationTestSourceScope.sourceId,
    applicability: { state: "applicable" },
    criteria: [
      {
        criterionId: "criterion-1",
        description: "The known build failure remains a failed outcome.",
        applicability: { state: "applicable" },
        expectedOutcome: "failed",
      },
    ],
    findings: { annotation: "complete", expected: [] },
  };
}

export function suiteDraftFixture(): EvaluationSuiteDraft {
  return {
    name: "Compiler regressions",
    description: "Frozen build examples with exact assessment labels.",
    cases: [suiteDraftCaseFixture()],
  };
}

export function suiteCreateRequestFixture(): EvaluationSuiteCreateRequest {
  const draft = suiteDraftFixture();
  return {
    changeId: "create-a",
    name: draft.name,
    description: draft.description,
    workflowKind: "pr_static_build",
    target: "headless",
  };
}

export function suiteSaveRequestFixture(): EvaluationSuiteSaveRequest {
  return { changeId: "save-a", expectedRevision: 1, draft: suiteDraftFixture() };
}

export function suitePublishRequestFixture(): EvaluationSuitePublishRequest {
  return { changeId: "publish-a", expectedRevision: 2 };
}

export function suiteSummaryFixture(draft = suiteDraftFixture()): EvaluationSuiteSummaryV1 {
  return {
    schemaVersion: "EvaluationSuiteSummaryV1",
    id: evaluationTestSuiteScope.suiteId,
    repositoryId: evaluationTestSuiteScope.repositoryId,
    name: draft.name,
    description: draft.description,
    workflowKind: "pr_static_build",
    target: "headless",
    draftRevision: 2,
    caseCount: draft.cases.length,
    latestVersionId: null,
    createdAt: evaluationTestTime,
    updatedAt: evaluationTestTime,
    createdBy: { ...evaluationTestActor },
    updatedBy: { ...evaluationTestActor },
  };
}

export function suiteDetailFixture(draft = suiteDraftFixture()): EvaluationSuiteDetailV1 {
  return { ...suiteSummaryFixture(draft), draft };
}

export function suiteVersionFixture(): EvaluationSuiteVersionV1 {
  const draft = suiteDraftFixture();
  return {
    schemaVersion: "EvaluationSuiteVersionV1",
    id: evaluationTestVersionScope.versionId,
    suiteId: evaluationTestVersionScope.suiteId,
    repositoryId: evaluationTestVersionScope.repositoryId,
    version: 1,
    sourceDraftRevision: 2,
    name: draft.name,
    description: draft.description,
    workflowKind: "pr_static_build",
    target: "headless",
    sourceVersionId: "source-version-a",
    expectationVersionId: "expectation-version-a",
    sourceManifestSha256: "e".repeat(64),
    expectationManifestSha256: "f".repeat(64),
    caseCount: draft.cases.length,
    createdAt: evaluationTestTime,
    createdBy: { ...evaluationTestActor },
  };
}

export function suiteListFixture(): EvaluationSuiteListResponse {
  return {
    repositoryId: evaluationTestSuiteScope.repositoryId,
    total: 1,
    page: 1,
    pageSize: 20,
    items: [suiteSummaryFixture()],
  };
}

export function suiteVersionListFixture(): EvaluationSuiteVersionListResponse {
  return {
    ...evaluationTestSuiteScope,
    total: 1,
    page: 1,
    pageSize: 20,
    items: [suiteVersionFixture()],
  };
}

function caseManifestScope() {
  const version = suiteVersionFixture();
  return {
    ...evaluationTestVersionScope,
    sourceVersionId: version.sourceVersionId,
    expectationVersionId: version.expectationVersionId,
    sourceManifestSha256: version.sourceManifestSha256,
    expectationManifestSha256: version.expectationManifestSha256,
  };
}

export function suiteCaseSummaryFixture(
  entry = suiteDraftCaseFixture(),
): EvaluationSuiteCaseSummaryV1 {
  return {
    schemaVersion: "EvaluationSuiteCaseSummaryV1",
    ...evaluationTestVersionScope,
    caseId: entry.caseId,
    title: entry.title,
    sourceId: entry.sourceId,
    sourceDigest: sourceSummaryFixture().sourceDigest,
    applicability: entry.applicability,
    criterionCount: entry.criteria.length,
    annotation: entry.findings.annotation,
    expectedFindingCount: entry.findings.expected.length,
  };
}

export function suiteCaseListFixture(cases = [suiteDraftCaseFixture()]): EvaluationSuiteCaseListV1 {
  return {
    schemaVersion: "EvaluationSuiteCaseListV1",
    ...caseManifestScope(),
    items: cases.map(suiteCaseSummaryFixture),
    total: cases.length,
  };
}

export function suiteCaseDetailFixture(
  entry = suiteDraftCaseFixture(),
): EvaluationSuiteCaseDetailV1 {
  const { sourceId: _sourceId, ...expectation } = entry;
  return {
    schemaVersion: "EvaluationSuiteCaseDetailV1",
    ...caseManifestScope(),
    caseId: entry.caseId,
    source: sourceSummaryFixture(),
    expectation,
  };
}
