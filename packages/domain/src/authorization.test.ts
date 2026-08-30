import { createHash } from "node:crypto";
import type {
  GitHubActor,
  GitHubPullRequestRevision,
  NormalizedSchedulingEvent,
  SchedulingRequestClosedEvent,
  SchedulingRequestOpenedEvent,
  SchedulingRevisionObservedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import {
  advanceAuthorizedRequestEpochRevision,
  closeAuthorizedRequestEpoch,
  evaluateRevisionInheritance,
  evaluateSchedulingAuthorization,
  openAuthorizedRequestEpoch,
} from "./authorization.js";

const now = "2026-08-30T10:00:00.000Z";
const reviewer = actor(100, "reviewer");
const maintainer = actor(200, "maintainer");
const contributor = actor(300, "contributor");
const author = actor(400, "author");

const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 3,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [maintainer.githubUserId],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
};

describe("SelfOrAllowlist authorization", () => {
  it("authorizes a request made by the configured target", () => {
    const event = requestOpened({ schedulingActor: reviewer });

    expect(decide(event)).toMatchObject({
      outcome: "authorized",
      basis: "self",
      reason: "authorized_self",
      actorGithubUserId: reviewer.githubUserId,
      targetGithubUserId: reviewer.githubUserId,
    });
  });

  it("authorizes an allowlisted user by numeric GitHub ID", () => {
    const renamedMaintainer = actor(maintainer.githubUserId, "maintainer-after-rename");
    const event = requestOpened({ schedulingActor: renamedMaintainer });

    expect(decide(event)).toMatchObject({
      outcome: "authorized",
      basis: "allowlist",
      reason: "authorized_allowlisted",
    });
  });

  it("denies a known actor who is neither self nor allowlisted", () => {
    const event = requestOpened({ schedulingActor: contributor });

    expect(decide(event)).toMatchObject({
      outcome: "denied",
      basis: null,
      reason: "denied_actor_not_allowed",
    });
  });

  it("denies a request aimed at another user before considering its actor", () => {
    const event = requestOpened({ schedulingActor: reviewer, target: contributor });

    expect(decide(event)).toMatchObject({
      outcome: "denied",
      reason: "denied_wrong_target",
      targetGithubUserId: contributor.githubUserId,
    });
  });

  it("denies a request when the scheduling actor is unknown", () => {
    const event = requestOpened({ schedulingActor: null });

    expect(decide(event)).toMatchObject({
      outcome: "denied",
      reason: "denied_actor_unknown",
      actorGithubUserId: null,
    });
  });
});

describe("authorized request epochs", () => {
  it("closes the matching epoch when an assignment is removed", () => {
    const opened = requestOpened({ schedulingActor: maintainer });
    const epoch = openAuthorizedRequestEpoch({
      event: opened,
      decision: decide(opened),
      requestEpochId: "epoch-1",
      sequence: 1,
    });
    const unassigned = requestClosed(opened);

    expect(closeAuthorizedRequestEpoch(epoch, unassigned)).toEqual({
      changed: true,
      epoch: {
        ...epoch,
        status: "closed",
        closedByEventId: unassigned.eventId,
        closedAt: unassigned.occurredAt,
        closeReason: "assignment_removed",
      },
    });
  });

  it("inherits an active authorized epoch for a new pull request SHA", () => {
    const opened = requestOpened({ schedulingActor: maintainer });
    const epoch = openAuthorizedRequestEpoch({
      event: opened,
      decision: decide(opened),
      requestEpochId: "epoch-2",
      sequence: 2,
    });
    const pushed = revisionObserved(opened, "2222222222222222222222222222222222222222");

    const inheritance = evaluateRevisionInheritance({
      epoch,
      event: pushed,
      evaluatedAt: pushed.observedAt,
      fallbackPolicyVersion: policy.policyVersion,
    });

    expect(inheritance).toMatchObject({
      outcome: "authorized",
      basis: "active_epoch",
      reason: "inherited_active_epoch",
      actorGithubUserId: contributor.githubUserId,
      targetGithubUserId: reviewer.githubUserId,
      inheritedFromEpochId: epoch.requestEpochId,
    });
    expect(
      advanceAuthorizedRequestEpochRevision(epoch, pushed, inheritance).currentRevision,
    ).toEqual(pushed.revision);
  });

  it("inherits an active authorized epoch for edited issue content", () => {
    const pullRequestEvent = requestOpened({ schedulingActor: reviewer });
    if (pullRequestEvent.workItem.kind !== "pull_request") {
      throw new Error("Expected a pull request fixture.");
    }
    const { isDraft: _isDraft, ...workItemBase } = pullRequestEvent.workItem;
    const firstDigest = "a".repeat(64);
    const opened: SchedulingRequestOpenedEvent = {
      ...pullRequestEvent,
      eventId: "issue-opened",
      sourceEventId: "issue-opened-source",
      workItem: {
        ...workItemBase,
        kind: "issue",
        githubNodeId: "I_item",
        htmlUrl: "https://github.com/microsoft/PowerToys/issues/123",
      },
      revision: {
        kind: "issue",
        githubRepositoryId: 1,
        githubWorkItemId: 10,
        revisionKey: firstDigest,
        contentDigest: firstDigest,
        observedAt: now,
        sourceUpdatedAt: now,
      },
    };
    const epoch = openAuthorizedRequestEpoch({
      event: opened,
      decision: decide(opened),
      requestEpochId: "issue-epoch",
      sequence: 4,
    });
    const nextDigest = "b".repeat(64);
    const edited: SchedulingRevisionObservedEvent = {
      ...opened,
      eventId: "issue-edited",
      sourceEventId: "issue-edited-source",
      action: "revision_observed",
      requestKind: null,
      actor: contributor,
      target: null,
      revision: {
        kind: "issue",
        githubRepositoryId: 1,
        githubWorkItemId: 10,
        revisionKey: nextDigest,
        contentDigest: nextDigest,
        observedAt: now,
        sourceUpdatedAt: now,
      },
    };

    expect(
      evaluateRevisionInheritance({
        epoch,
        event: edited,
        evaluatedAt: now,
        fallbackPolicyVersion: policy.policyVersion,
      }),
    ).toMatchObject({
      outcome: "authorized",
      basis: "active_epoch",
      inheritedFromEpochId: "issue-epoch",
    });
  });

  it("does not inherit after the request epoch is closed", () => {
    const opened = requestOpened({ schedulingActor: reviewer });
    const activeEpoch = openAuthorizedRequestEpoch({
      event: opened,
      decision: decide(opened),
      requestEpochId: "epoch-3",
      sequence: 3,
    });
    const closed = closeAuthorizedRequestEpoch(activeEpoch, requestClosed(opened));
    if (!closed.changed) {
      throw new Error("Expected the epoch to close");
    }

    const inheritance = evaluateRevisionInheritance({
      epoch: closed.epoch,
      event: revisionObserved(opened, "3333333333333333333333333333333333333333"),
      evaluatedAt: now,
      fallbackPolicyVersion: policy.policyVersion,
    });

    expect(inheritance).toMatchObject({
      outcome: "denied",
      reason: "denied_no_active_epoch",
    });
  });
});

function decide(event: NormalizedSchedulingEvent) {
  return evaluateSchedulingAuthorization({ event, policy, evaluatedAt: now });
}

function actor(githubUserId: number, login: string): GitHubActor {
  return { githubUserId, login, accountType: "user" };
}

interface RequestOpenedOverrides {
  schedulingActor: GitHubActor | null;
  target?: GitHubActor | null;
}

function requestOpened(overrides: RequestOpenedOverrides): SchedulingRequestOpenedEvent {
  const revision = pullRequestRevision("1111111111111111111111111111111111111111");
  return {
    contractVersion: 1,
    eventId: "github-event-1",
    source: "webhook",
    sourceEventId: "delivery-1",
    occurredAt: now,
    observedAt: now,
    repository: {
      githubRepositoryId: 1,
      githubNodeId: "R_repo",
      ownerLogin: "microsoft",
      name: "PowerToys",
      fullName: "microsoft/PowerToys",
      htmlUrl: "https://github.com/microsoft/PowerToys",
      defaultBranch: "main",
      isPrivate: false,
    },
    workItem: {
      githubWorkItemId: 10,
      githubNodeId: "PR_item",
      githubRepositoryId: 1,
      kind: "pull_request",
      number: 123,
      title: "Improve review scheduling",
      body: "Body",
      state: "open",
      author,
      htmlUrl: "https://github.com/microsoft/PowerToys/pull/123",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isDraft: false,
    },
    revision,
    author,
    action: "request_opened",
    requestKind: "assignment",
    actor: overrides.schedulingActor,
    target: overrides.target === undefined ? reviewer : overrides.target,
  };
}

function requestClosed(opened: SchedulingRequestOpenedEvent): SchedulingRequestClosedEvent {
  return {
    ...opened,
    eventId: "github-event-2",
    sourceEventId: "delivery-2",
    action: "request_closed",
    closeReason: "assignment_removed",
    actor: contributor,
  };
}

function revisionObserved(
  opened: SchedulingRequestOpenedEvent,
  headSha: string,
): SchedulingRevisionObservedEvent {
  return {
    ...opened,
    eventId: `revision-${headSha}`,
    sourceEventId: `delivery-${headSha}`,
    action: "revision_observed",
    requestKind: null,
    actor: contributor,
    target: null,
    revision: pullRequestRevision(headSha),
  };
}

function pullRequestRevision(headSha: string): GitHubPullRequestRevision {
  const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    kind: "pull_request",
    githubRepositoryId: 1,
    githubWorkItemId: 10,
    revisionKey: createHash("sha256").update(baseSha).update("\0").update(headSha).digest("hex"),
    baseSha,
    headSha,
    observedAt: now,
    sourceUpdatedAt: now,
  };
}
