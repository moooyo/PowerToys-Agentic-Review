import type {
  PublicationDelivery,
  PublicationIntent,
  PublicationRemoteReceipt,
} from "@agentic-review/contracts";
import { createPullRequestRevisionKey } from "../github/revision-key.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";

export const publicationTestTime = "2026-09-07T14:00:00.000Z";
export const publicationTestActor = {
  issuer: "https://identity.example.test",
  subject: "publication-administrator",
};
export function createPublicationTestIntent(): PublicationIntent {
  const binding = {
    repositoryId: "repository-1",
    reviewRunId: "run-1",
    workItemId: "work-item-1",
    selectedDecisionId: "decision-1",
    selectedDecisionVersion: 1,
    decisionContextVersion: 1,
    revisionKey: createPullRequestRevisionKey("a".repeat(40), "b".repeat(40)),
    planDigest: "c".repeat(64),
    resultSetDigest: "d".repeat(64),
  };
  const publicationId = `publication-${sha256(canonicalJson({ repositoryId: binding.repositoryId, reviewRunId: binding.reviewRunId, decisionId: binding.selectedDecisionId, rendererVersion: "publication-renderer-v1" }))}`;
  const semanticBody = "Recorded synthetic validation report.\n",
    semanticSha256 = sha256(semanticBody);
  const payload = {
    kind: "pull_request_review" as const,
    commitId: "b".repeat(40),
    event: "COMMENT" as const,
    body: `${semanticBody}\n<!-- agentic-review-publication:${publicationId} semantic-sha256:${semanticSha256} -->`,
  };
  return {
    schemaVersion: "PublicationIntentV1",
    publicationId,
    rendererVersion: "publication-renderer-v1",
    binding,
    policyVersion: 1,
    publisherGitHubUserId: 73,
    target: {
      githubRepositoryId: 11,
      githubWorkItemId: 22,
      fullName: "fixture/example",
      number: 3,
      kind: "pull_request",
    },
    payload,
    payloadSha256: sha256(canonicalJson(payload)),
    semanticSha256,
    actor: { ...publicationTestActor },
    createdAt: publicationTestTime,
    confirmationChangeId: "confirmation-1",
    decision: {
      repositoryId: binding.repositoryId,
      reviewRunId: binding.reviewRunId,
      workItemId: binding.workItemId,
      revisionKey: binding.revisionKey,
      planDigest: binding.planDigest,
      resultSetDigest: binding.resultSetDigest,
      id: binding.selectedDecisionId,
      changeId: "decision-change-1",
      actor: { ...publicationTestActor },
      previousVersion: 0,
      version: 1,
      createdAt: publicationTestTime,
      action: "comment",
      reason: "Publish the recorded test report.",
      supersedesDecisionId: null,
      targetDecisionId: null,
      workItemKind: "pull_request",
      policyAtDecision: {
        policyVersion: "required-checks-and-p0-p1-v1",
        applicable: true,
        eligible: true,
        blockingFindingCount: 0,
        reasonCount: 0,
        reasonCodes: [],
        reasonCodesTruncated: false,
      },
    },
  };
}
export function createPublicationTestDelivery(
  intent = createPublicationTestIntent(),
): PublicationDelivery {
  return {
    schemaVersion: "PublicationDeliveryV1",
    publicationId: intent.publicationId,
    version: 1,
    status: "pending",
    attemptCount: 0,
    failure: null,
    remoteReceipt: null,
    updatedAt: publicationTestTime,
  };
}
export function createPublicationTestReceipt(
  intent = createPublicationTestIntent(),
): PublicationRemoteReceipt {
  return {
    kind: "pull_request_review",
    githubId: 901,
    htmlUrl: "https://github.com/fixture/example/pull/3#pullrequestreview-901",
    createdAt: publicationTestTime,
    publisherGitHubUserId: intent.publisherGitHubUserId,
    commitId: "b".repeat(40),
    event: "COMMENT",
  };
}
