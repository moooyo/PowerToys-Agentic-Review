import { createHash } from "node:crypto";

export const acceptanceId = "m40-publication-20260910-b2619d4e";
export const repository = "moooyo/PowerToys";
export const repositoryId = 1299518756;
export const publisherLogin = "moooyo";
export const publisherId = 42196638;
export const baseBranch = "main";
export const baseSha = "3a1e642db52d45f88c0cb702b10663e1f65623f7";
export const branch = `codex/${acceptanceId}`;
export const documentPath = `doc/agentic-review-acceptance/${acceptanceId}.md`;
export const commitMessage = "docs: add isolated Agentic Review publication acceptance fixture";
export const documentBody = `# Agentic Review publication acceptance fixture

Acceptance run: ${acceptanceId}

This document identifies a temporary pull request used to verify the Agentic Review publication client and durable publication outbox against this fork.

The acceptance sends one COMMENT review to this pull request and one comment to its dedicated test issue. Each publication uses an explicitly synthetic local validation record. No PowerToys build, test, or model execution is claimed.

After verification, the temporary pull request and issue are closed and the temporary branch is deleted. The publication comments remain as the acceptance record.
`;
export const pullTitle = "[Acceptance test] Agentic Review publication outbox";
export const pullBody = `## Purpose

Controlled publication acceptance for ${acceptanceId} in moooyo/PowerToys.

This draft pull request adds one explanatory document. It is the target of exactly one Agentic Review COMMENT review containing a clearly identified synthetic validation fixture.

The acceptance verifies GitHub publisher identity, repository and source binding, durable outbox state, and read-only reconciliation after a deliberately discarded local acknowledgement. Reconciliation must not send another review.

Cleanup closes this pull request and its dedicated test issue, deletes only the temporary branch, and restores this fork's Issues setting to disabled. The test publications remain visible in the closed objects. This pull request will not be merged.
`;
export const issueTitle = "[Acceptance test] Agentic Review issue-comment publication";
export const issueBody = `## Purpose

Controlled publication acceptance for ${acceptanceId} in moooyo/PowerToys.

This issue is an isolated target for exactly one Agentic Review comment containing a clearly identified synthetic validation fixture. It does not report a PowerToys defect or request product work.

The acceptance verifies publisher and issue identity, durable outbox state, and GET-only reconciliation after a deliberately discarded local acknowledgement. Reconciliation must not send another comment.

Cleanup closes this issue and its companion draft pull request, deletes only the temporary branch, and restores this fork's Issues setting to disabled. The test comment remains attached to this closed issue.
`;
export const decisionReason =
  "Publish this explicitly synthetic acceptance fixture to the dedicated temporary test target. No PowerToys build, test, or model execution was performed.";
export const reportSummary =
  "Synthetic publication acceptance fixture. No PowerToys build, test, or model execution was performed.";
export const checkSummary =
  "Synthetic fixture outcome used only to exercise publication persistence and transport.";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const approvalPlan = Object.freeze({
  schemaVersion: "PublicationAcceptancePlanV1",
  acceptanceId,
  executionDefault: "prepare-only; no GitHub mutations",
  repository: {
    fullName: repository,
    id: repositoryId,
    baseBranch,
    baseSha,
    originalHasIssues: false,
  },
  publisher: {
    login: publisherLogin,
    id: publisherId,
    credential: "Current GitHub CLI session, retained only in process memory.",
  },
  branch,
  document: {
    path: documentPath,
    content: documentBody,
    sha256: sha256(documentBody),
    commitMessage,
  },
  operations: [
    {
      id: "create-branch",
      method: "POST",
      path: `/repos/${repository}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    },
    {
      id: "create-document-commit",
      method: "PUT",
      path: `/repos/${repository}/contents/${documentPath}`,
      body: {
        message: commitMessage,
        branch,
        content: Buffer.from(documentBody).toString("base64"),
      },
    },
    {
      id: "create-draft-pr",
      method: "POST",
      path: `/repos/${repository}/pulls`,
      body: {
        title: pullTitle,
        head: branch,
        base: baseBranch,
        body: pullBody,
        draft: true,
        maintainer_can_modify: false,
      },
    },
    {
      id: "enable-issues",
      method: "PATCH",
      path: `/repos/${repository}`,
      body: { has_issues: true },
    },
    {
      id: "create-test-issue",
      method: "POST",
      path: `/repos/${repository}/issues`,
      body: { title: issueTitle, body: issueBody },
    },
    {
      id: "publish-pr-review",
      method: "POST",
      path: `/repos/${repository}/pulls/{{NEW_PR_NUMBER}}/reviews`,
      body: {
        commit_id: "{{NEW_DOCUMENT_COMMIT_SHA}}",
        event: "COMMENT",
        body: "{{APPROVED_PR_RENDERER_BODY}}",
      },
    },
    {
      id: "publish-issue-comment",
      method: "POST",
      path: `/repos/${repository}/issues/{{NEW_ISSUE_NUMBER}}/comments`,
      body: { body: "{{APPROVED_ISSUE_RENDERER_BODY}}" },
    },
    {
      id: "close-draft-pr",
      method: "PATCH",
      path: `/repos/${repository}/pulls/{{NEW_PR_NUMBER}}`,
      body: { state: "closed" },
    },
    {
      id: "close-test-issue",
      method: "PATCH",
      path: `/repos/${repository}/issues/{{NEW_ISSUE_NUMBER}}`,
      body: { state: "closed", state_reason: "completed" },
    },
    {
      id: "delete-test-branch",
      method: "DELETE",
      path: `/repos/${repository}/git/refs/heads/${branch}`,
      body: null,
    },
    {
      id: "restore-issues-disabled",
      method: "PATCH",
      path: `/repos/${repository}`,
      body: { has_issues: false },
    },
  ],
  publication: {
    decisionAction: "comment",
    reviewEvent: "COMMENT",
    prBodyTemplate: "pr-review-body.template.md",
    issueBodyTemplate: "issue-comment-body.template.md",
    decisionReason,
    reportSummary,
    checkSummary,
    source:
      "Isolated SQLite fixture through the production owner, preview, confirmation, publisher and GitHub client.",
    acknowledgementExercise:
      "Discard each first successful publication acknowledgement locally; persist unknown, request GET-only reconciliation, then verify published with exactly one POST per target.",
    allowedMechanicalSubstitutions: [
      "New PR/Issue IDs, numbers and URLs returned by this run",
      "The one document commit SHA returned by this run",
      "Fixture entity IDs, timestamps and their derived canonical hashes",
      "The production publication marker derived from that exact fixture and body",
    ],
    semanticTextChangesRequireNewApproval: true,
  },
  cleanup: {
    retained:
      "The closed test PR, closed test Issue and their publication bodies remain as remote history; local database and receipts remain in the owned acceptance directory.",
    scope:
      "Only targets created and recorded by this run. Existing branches, PRs, Issues, comments and settings are not cleanup targets.",
    safety:
      "No automatic mutation retry. An uncertain setup or cleanup response is retained for read-only inspection; no unrelated target is substituted.",
  },
});
