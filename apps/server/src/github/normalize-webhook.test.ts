import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvalidGitHubWebhookPayloadError,
  normalizeGitHubWebhookPayload,
  UnsupportedGitHubWebhookActionError,
  UnsupportedGitHubWebhookTargetError,
} from "../../dist/github/normalize-webhook.js";
import { createPullRequestRevisionKey } from "../../dist/github/revision-key.js";
import type { GitHubWebhookEventName } from "../../dist/github/types.js";

const identity = (id: number, login: string) => ({
  id,
  node_id: `U_${id}`,
  login,
  type: "User",
});

const author = identity(101, "author");
const actor = identity(202, "scheduler");
const actionTarget = identity(303, "target");
const decoyTarget = identity(404, "decoy");

const repository = {
  id: 10,
  node_id: "R_10",
  name: "PowerToys",
  full_name: "microsoft/PowerToys",
  html_url: "https://github.com/microsoft/PowerToys",
  default_branch: "main",
  private: false,
  owner: identity(1, "microsoft"),
};

const issue = {
  id: 20,
  node_id: "I_20",
  number: 123,
  title: "Issue title",
  body: "Issue body",
  state: "open",
  html_url: "https://github.com/microsoft/PowerToys/issues/123",
  created_at: "2026-08-29T01:02:03Z",
  updated_at: "2026-08-30T01:02:03Z",
  closed_at: null,
  user: author,
  assignee: decoyTarget,
  assignees: [decoyTarget],
};

const pullRequest = {
  id: 30,
  node_id: "PR_30",
  number: 456,
  title: "Pull request title",
  body: "Pull request body",
  state: "open",
  html_url: "https://github.com/microsoft/PowerToys/pull/456",
  created_at: "2026-08-29T02:03:04Z",
  updated_at: "2026-08-30T02:03:04Z",
  closed_at: null,
  user: author,
  draft: false,
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40) },
  assignee: decoyTarget,
  assignees: [decoyTarget],
  requested_reviewers: [decoyTarget],
};

const normalize = (eventName: GitHubWebhookEventName, payload: Record<string, unknown>) =>
  normalizeGitHubWebhookPayload({
    deliveryId: "11111111-2222-3333-4444-555555555555",
    eventName,
    receivedAt: "2026-08-30T03:04:05.000Z",
    payload,
  });

describe("normalizeGitHubWebhookPayload", () => {
  it.each(["assigned", "unassigned"] as const)(
    "normalizes issues.%s using the action-specific assignee",
    (action) => {
      const event = normalize("issues", {
        action,
        issue,
        assignee: actionTarget,
        repository,
        sender: actor,
      });

      expect(event).toMatchObject({
        contractVersion: 1,
        source: "webhook",
        sourceEventId: "11111111-2222-3333-4444-555555555555",
        action: action === "assigned" ? "request_opened" : "request_closed",
        requestKind: "assignment",
        author: { githubUserId: author.id, login: author.login },
        actor: { githubUserId: actor.id, login: actor.login },
        target: { githubUserId: actionTarget.id, login: actionTarget.login },
        workItem: { kind: "issue", number: 123 },
        revision: {
          kind: "issue",
          contentDigest: createHash("sha256")
            .update(JSON.stringify([issue.title, issue.body, issue.state, issue.updated_at]))
            .digest("hex"),
        },
        repository: { fullName: "microsoft/PowerToys" },
      });
      expect(event.target?.githubUserId).not.toBe(decoyTarget.id);
    },
  );

  it.each([
    ["edited", "revision_observed"],
    ["closed", "work_item_closed"],
    ["reopened", "work_item_reopened"],
  ] as const)("normalizes issues.%s without inventing a target", (action, expectedAction) => {
    const actionIssue =
      action === "closed"
        ? { ...issue, state: "closed", closed_at: "2026-08-30T01:02:03Z" }
        : issue;
    const event = normalize("issues", {
      action,
      issue: actionIssue,
      repository,
      sender: actor,
    });

    expect(event).toMatchObject({
      action: expectedAction,
      requestKind: null,
      target: null,
      actor: { githubUserId: actor.id },
    });
  });

  it.each(["assigned", "unassigned"] as const)(
    "normalizes pull_request.%s using the action-specific assignee",
    (action) => {
      const event = normalize("pull_request", {
        action,
        pull_request: pullRequest,
        assignee: actionTarget,
        repository,
        sender: actor,
      });

      expect(event).toMatchObject({
        action: action === "assigned" ? "request_opened" : "request_closed",
        requestKind: "assignment",
        author: { githubUserId: author.id },
        actor: { githubUserId: actor.id },
        target: { githubUserId: actionTarget.id },
        workItem: {
          kind: "pull_request",
          number: 456,
        },
        revision: {
          kind: "pull_request",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          revisionKey: createPullRequestRevisionKey("b".repeat(40), "a".repeat(40)),
        },
      });
      expect(event.target?.githubUserId).not.toBe(decoyTarget.id);
    },
  );

  it.each(["review_requested", "review_request_removed"] as const)(
    "normalizes pull_request.%s using requested_reviewer instead of reviewer lists",
    (action) => {
      const event = normalize("pull_request", {
        action,
        pull_request: pullRequest,
        requested_reviewer: actionTarget,
        repository,
        sender: actor,
      });

      expect(event).toMatchObject({
        action: action === "review_requested" ? "request_opened" : "request_closed",
        requestKind: "review_request",
        target: { githubUserId: actionTarget.id },
      });
      expect(event.target?.githubUserId).not.toBe(decoyTarget.id);
    },
  );

  it.each([
    ["synchronize", "revision_observed"],
    ["closed", "work_item_closed"],
    ["reopened", "work_item_reopened"],
  ] as const)("normalizes pull_request.%s without inventing a target", (action, expectedAction) => {
    const actionPullRequest =
      action === "closed"
        ? { ...pullRequest, state: "closed", closed_at: "2026-08-30T02:03:04Z" }
        : pullRequest;
    const event = normalize("pull_request", {
      action,
      pull_request: actionPullRequest,
      repository,
      sender: actor,
    });

    expect(event).toMatchObject({
      action: expectedAction,
      requestKind: null,
      target: null,
      actor: { githubUserId: actor.id },
    });
  });

  it("rejects lifecycle actions that contradict the work item state", () => {
    expect(() =>
      normalize("pull_request", {
        action: "closed",
        pull_request: pullRequest,
        repository,
        sender: actor,
      }),
    ).toThrow(InvalidGitHubWebhookPayloadError);
  });

  it("rejects an unsupported action", () => {
    expect(() =>
      normalize("issues", {
        action: "labeled",
        issue,
        repository,
        sender: actor,
      }),
    ).toThrow(UnsupportedGitHubWebhookActionError);
  });

  it("rejects team review requests until team identities are explicitly supported", () => {
    expect(() =>
      normalize("pull_request", {
        action: "review_requested",
        pull_request: pullRequest,
        requested_team: { id: 505, node_id: "T_505", slug: "maintainers" },
        repository,
        sender: actor,
      }),
    ).toThrow(UnsupportedGitHubWebhookTargetError);
  });

  it("rejects a payload missing an immutable identity field", () => {
    const invalidActor = { ...actor } as Partial<typeof actor>;
    delete invalidActor.node_id;

    expect(() =>
      normalize("issues", {
        action: "assigned",
        issue,
        assignee: actionTarget,
        repository,
        sender: invalidActor,
      }),
    ).toThrow(InvalidGitHubWebhookPayloadError);
  });
});
