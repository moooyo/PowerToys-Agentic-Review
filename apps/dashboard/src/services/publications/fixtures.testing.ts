import type {
  PublicationDetail,
  PublicationPreview,
  PublicationSummary,
  RepositoryPublicationPolicyAuditEvent,
} from "@agentic-review/contracts";
export const publicationTestActor = {
  issuer: "https://fixture.example.test",
  subject: "maintainer",
};
export const publicationTestTime = "2026-09-07T12:00:00.000Z";
export const publicationTestScope = {
  repositoryId: "repository-a",
  reviewRunId: "run-a",
  decisionId: "comment-event-a",
};
export function previewFixture(): PublicationPreview {
  return {
    schemaVersion: "PublicationPreviewV1",
    publicationId: "publication-a",
    rendererVersion: "publication-renderer-v1",
    binding: {
      repositoryId: "repository-a",
      reviewRunId: "run-a",
      workItemId: "work-item-a",
      selectedDecisionId: "comment-event-a",
      selectedDecisionVersion: 3,
      decisionContextVersion: 5,
      revisionKey: "a".repeat(64),
      planDigest: "b".repeat(64),
      resultSetDigest: "c".repeat(64),
    },
    target: {
      githubRepositoryId: 101,
      githubWorkItemId: 202,
      fullName: "fixture-owner/review-target",
      number: 7,
      kind: "pull_request",
    },
    payload: {
      kind: "pull_request_review",
      event: "COMMENT",
      commitId: "d".repeat(40),
      body: "Complete exact review text.\n\nRequired check: failed.\n<!-- publication:publication-a -->",
    },
    payloadSha256: "e".repeat(64),
    semanticSha256: "f".repeat(64),
    observedAt: publicationTestTime,
    policyVersion: 1,
    publisherAvailability: "available",
    publisherGitHubUserId: 303,
    blockers: [],
    canConfirm: true,
    existingIntent: null,
  };
}
export function detailFixture(): PublicationDetail {
  const preview = previewFixture();
  if (
    !preview.payload ||
    !preview.payloadSha256 ||
    !preview.semanticSha256 ||
    !preview.publisherGitHubUserId
  )
    throw new Error("The test preview must be confirmable.");
  const binding = preview.binding;
  return {
    schemaVersion: "PublicationDetailV1",
    intent: {
      schemaVersion: "PublicationIntentV1",
      publicationId: preview.publicationId,
      rendererVersion: preview.rendererVersion,
      binding,
      target: preview.target,
      payload: preview.payload,
      payloadSha256: preview.payloadSha256,
      semanticSha256: preview.semanticSha256,
      publisherGitHubUserId: preview.publisherGitHubUserId,
      policyVersion: preview.policyVersion,
      actor: { ...publicationTestActor },
      createdAt: publicationTestTime,
      confirmationChangeId: "confirm-a",
      decision: {
        id: binding.selectedDecisionId,
        repositoryId: binding.repositoryId,
        reviewRunId: binding.reviewRunId,
        workItemId: binding.workItemId,
        workItemKind: "pull_request",
        changeId: "decision-change-a",
        actor: { ...publicationTestActor },
        previousVersion: 2,
        version: 3,
        createdAt: publicationTestTime,
        reason: "Review this exact result set.",
        revisionKey: binding.revisionKey,
        planDigest: binding.planDigest,
        resultSetDigest: binding.resultSetDigest,
        supersedesDecisionId: null,
        targetDecisionId: null,
        action: "comment",
        policyAtDecision: {
          policyVersion: "required-checks-and-p0-p1-v1",
          applicable: true,
          eligible: false,
          blockingFindingCount: 0,
          reasonCount: 1,
          reasonCodes: ["required_execution_failed"],
          reasonCodesTruncated: false,
        },
      },
    },
    delivery: {
      schemaVersion: "PublicationDeliveryV1",
      publicationId: preview.publicationId,
      version: 1,
      status: "pending",
      attemptCount: 0,
      failure: null,
      remoteReceipt: null,
      updatedAt: publicationTestTime,
    },
  };
}
export function summaryFixture(): PublicationSummary {
  const detail = detailFixture(),
    intent = detail.intent;
  return {
    schemaVersion: "PublicationSummaryV1",
    publicationId: intent.publicationId,
    repositoryId: intent.binding.repositoryId,
    reviewRunId: intent.binding.reviewRunId,
    workItemId: intent.binding.workItemId,
    selectedDecisionId: intent.binding.selectedDecisionId,
    selectedDecisionVersion: intent.binding.selectedDecisionVersion,
    rendererVersion: intent.rendererVersion,
    target: intent.target,
    payloadSha256: intent.payloadSha256,
    publisherGitHubUserId: intent.publisherGitHubUserId,
    actor: intent.actor,
    createdAt: intent.createdAt,
    delivery: detail.delivery,
  };
}
export function policyEventFixture(): RepositoryPublicationPolicyAuditEvent {
  return {
    schemaVersion: "RepositoryPublicationPolicyAuditEventV1",
    id: "policy-event-a",
    repositoryId: "repository-a",
    changeId: "policy-change-a",
    actor: { ...publicationTestActor },
    previousVersion: 0,
    version: 1,
    previousSnapshot: {
      schemaVersion: "RepositoryPublicationPolicyV1",
      repositoryId: "repository-a",
      version: 0,
      enabled: false,
      updatedAt: null,
      updatedBy: null,
    },
    snapshot: {
      schemaVersion: "RepositoryPublicationPolicyV1",
      repositoryId: "repository-a",
      version: 1,
      enabled: true,
      updatedAt: publicationTestTime,
      updatedBy: { ...publicationTestActor },
    },
    createdAt: publicationTestTime,
  };
}
