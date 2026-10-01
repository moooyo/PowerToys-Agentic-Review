import { afterEach, describe, expect, it } from "vitest";
import type { InvestigationE2eReceipt } from "../../dist/investigation/e2e-intake.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import { projectWebhookDelivery } from "../../dist/investigation/webhook-delivery-controls.js";
import type { InvestigationWebhookReceipt } from "../../dist/investigation/webhook-intake.js";

const repository = { id: "repo-1", fullName: "fixture/project", githubRepositoryId: 1 };
const actor: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Operator",
  repositoryIds: [repository.id],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
const receivedAt = "2026-10-01T10:00:00.000Z";
const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function storeFixture() {
  const store = new InvestigationStore();
  stores.push(store);
  return store;
}
function receipt(id: string, requestKind?: "review_request"): InvestigationWebhookReceipt {
  return {
    id: `webhook:delivery:${id}`,
    deliveryId: id,
    eventName: "pull_request",
    payloadSha256: "a".repeat(64),
    receivedAt,
    pendingId: `webhook:pending:${id}`,
    assignment: {
      repository,
      kind: "pull_request",
      number: 7,
      githubWorkItemId: 70,
      actorUserId: 10,
      actorLogin: "requester",
      actorAvatarUrl: "https://avatars.githubusercontent.com/u/10",
      assigneeUserId: 20,
      assigneeLogin: "reviewer",
      updatedAt: receivedAt,
      ...(requestKind === undefined ? {} : { requestKind }),
    },
    policyDigest: "b".repeat(64),
    state: "completed",
    attempts: 1,
    nextAttemptAt: Date.parse(receivedAt),
    source: null,
    taskRequest: null,
    taskId: "task-1",
    reason: null,
  };
}

describe("native webhook trigger attribution", () => {
  it("preserves assignment semantics and uses only a frozen review baseline to identify rereview", () => {
    const store = storeFixture();
    expect(projectWebhookDelivery(store, actor, receipt("assignment")).triggerKind).toBe(
      "assignment",
    );
    expect(
      projectWebhookDelivery(store, actor, receipt("request", "review_request")).triggerKind,
    ).toBe("review_request");
    store.put("tasks", "task-1", {
      id: "task-1",
      repository,
      workItem: { id: "item-1", repositoryId: repository.id, kind: "pull_request", number: 7 },
      reviewBaseline: { priorReportRef: { id: "report-1" } },
    });
    const result = projectWebhookDelivery(store, actor, receipt("rerequest", "review_request"));
    expect(result.triggerKind).toBe("review_rerequest");
    expect(result.actorLogin).toBe("requester");
    expect(result.actorAvatarUrl).toBe("https://avatars.githubusercontent.com/u/10");
    expect(projectWebhookDelivery(store, actor, receipt("assignment")).triggerKind).toBe(
      "assignment",
    );
  });

  it("keeps an alias request as its own event instead of attributing its actor or rereview state to the canonical task", () => {
    const store = storeFixture();
    const canonical = receipt("canonical", "review_request");
    store.put("idempotency", canonical.id, canonical);
    store.put("tasks", "task-1", {
      repository,
      workItem: { kind: "pull_request", number: 7 },
      reviewBaseline: { priorReportRef: { id: "report-1" } },
    });
    const alias = {
      ...receipt("alias", "review_request"),
      canonicalReceiptId: canonical.id,
      assignment: { ...canonical.assignment, actorUserId: 30, actorLogin: "later-requester" },
    };
    const result = projectWebhookDelivery(store, actor, alias);
    expect(result.triggerKind).toBe("review_request");
    expect(result.actorUserId).toBe(30);
    expect(result.actorLogin).toBe("later-requester");
    expect(result.canonicalDeliveryId).toBe("canonical");
  });

  it("distinguishes revision observations from E2E comment commands", () => {
    const store = storeFixture();
    const observed: InvestigationE2eReceipt = {
      id: "e2e:webhook:observed",
      deliveryId: "observed",
      eventName: "pull_request",
      payloadSha256: "a".repeat(64),
      repository,
      number: 7,
      receivedAt,
      actorUserId: 10,
      actorLogin: "observer",
      reviewerUserId: 20,
      command: null,
      state: "completed",
      reason: "revision_observed",
      taskId: null,
      revision: null,
      source: null,
      taskRequest: null,
      admission: null,
      attempts: 1,
      nextAttemptAt: Date.parse(receivedAt),
    };
    expect(projectWebhookDelivery(store, actor, observed).triggerKind).toBe("e2e_revision");
    const command = {
      ...observed,
      eventName: "issue_comment",
      command: {
        commentId: 1,
        githubIssueId: 70,
        mentionLogin: "unverified-mention",
        bodySha256: "b".repeat(64),
      },
    };
    expect(projectWebhookDelivery(store, actor, command).triggerKind).toBe("e2e_command");
    expect(projectWebhookDelivery(store, actor, command).assigneeLogin).toBeUndefined();
    const accepted = {
      ...command,
      admission: {
        mode: "e2e" as const,
        id: command.id,
        repository,
        target: {
          id: "item-1",
          repositoryId: repository.id,
          kind: "pull_request" as const,
          number: 7,
          githubWorkItemId: 70,
        },
        trigger: {
          eventName: "issue_comment" as const,
          actorUserId: 10,
          assigneeUserId: 20,
          assigneeLogin: "verified-reviewer",
        },
        receivedAt,
        expectedAssigneeUserId: 20,
      },
    };
    expect(projectWebhookDelivery(store, actor, accepted).assigneeLogin).toBe("verified-reviewer");
  });
});
