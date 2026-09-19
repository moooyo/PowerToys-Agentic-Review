import type {
  InvestigationCommentPublicationSummary,
  InvestigationSessionUser,
} from "@agentic-review/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationApi } from "./api";
import {
  canScheduleCommentAction,
  commentCommandQueryKey,
  hasCommentActionGrant,
  type RetainedCommentCommand,
  scheduleCommentCommand,
} from "./comment-publication-state";
import { InvestigationHttpError } from "./transport";

const comment: InvestigationCommentPublicationSummary = {
  id: "comment-1",
  version: "opaque:first-version",
  mode: "progress",
  repositoryId: "repo-1",
  repositoryFullName: "owner/repository",
  workItemId: "item-1",
  workItemKind: "pull_request",
  workItemNumber: 7,
  taskId: "task-1",
  reportId: null,
  state: "paused",
  reasonCode: null,
  reason: null,
  requiresAttention: true,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastConfirmedAt: null,
  externalId: null,
  commentUrl: null,
  availableActions: ["sync", "reconcile"],
  createdAt: "2026-09-19T02:00:00.000Z",
  updatedAt: "2026-09-19T02:00:00.000Z",
};
const user: InvestigationSessionUser = {
  id: "operator-1",
  username: "operator",
  displayName: "Operator",
  isAdmin: false,
  email: null,
  repositoryIds: ["repo-1"],
  permissions: ["action:prepare", "action:execute"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: false,
};
const clients: QueryClient[] = [];
function createClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return client;
}
function retained(client: QueryClient) {
  return client.getQueryData<RetainedCommentCommand>(commentCommandQueryKey(comment.id))!;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.clear();
});

describe("retained comment requests", () => {
  it("replays the original opaque version and key after route re-entry and a changed summary", async () => {
    const client = createClient();
    const sync = vi
      .spyOn(investigationApi, "syncComment")
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce({ ...comment, version: "opaque:next-version", state: "pending" });
    await scheduleCommentCommand(client, comment, "sync");
    const saved = retained(client);
    expect(saved.state).toBe("unknown");
    expect(canScheduleCommentAction(comment, user, "sync", saved)).toBe(false);
    await scheduleCommentCommand(
      client,
      { ...comment, version: "changed-after-acceptance", availableActions: [] },
      "sync",
      saved,
    );
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0]?.[1]).toEqual(sync.mock.calls[1]?.[1]);
    expect(sync.mock.calls[1]?.[1].version).toBe("opaque:first-version");
    expect(retained(client).state).toBe("completed");
  });

  it("blocks duplicate clicks synchronously and never automatically retries an accepted request", async () => {
    const client = createClient();
    let finish!: (value: InvestigationCommentPublicationSummary) => void;
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sync = vi.spyOn(investigationApi, "syncComment").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const running = scheduleCommentCommand(client, comment, "sync");
    await invoked;
    await scheduleCommentCommand(client, comment, "sync");
    expect(sync).toHaveBeenCalledTimes(1);
    finish(comment);
    await running;
    await scheduleCommentCommand(client, comment, "sync");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(canScheduleCommentAction(comment, user, "sync", retained(client))).toBe(false);
  });

  it("keeps a 409 blocked until the latest state has been loaded for review", async () => {
    const client = createClient();
    const sync = vi
      .spyOn(investigationApi, "syncComment")
      .mockRejectedValue(new InvestigationHttpError(409, "Changed"));
    await scheduleCommentCommand(client, comment, "sync");
    expect(retained(client).state).toBe("conflict");
    await scheduleCommentCommand(client, { ...comment, version: "changed" }, "sync");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(canScheduleCommentAction(comment, user, "sync", retained(client))).toBe(false);
    expect(
      canScheduleCommentAction({ ...comment, version: "reviewed" }, user, "sync", {
        ...retained(client),
        state: "refreshed",
      }),
    ).toBe(true);
  });

  it("does not restore private data after session cache invalidation", async () => {
    const client = createClient();
    let finish!: (value: InvestigationCommentPublicationSummary) => void;
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(investigationApi, "syncComment").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const running = scheduleCommentCommand(client, comment, "sync");
    await invoked;
    client.clear();
    finish(comment);
    await running;
    expect(client.getQueryData(commentCommandQueryKey(comment.id))).toBeUndefined();
    expect(client.getQueryData(["investigation-comment", comment.id])).toBeUndefined();
  });

  it("requires explicit repository and action grants with no administrator bypass", () => {
    expect(
      hasCommentActionGrant(comment, { ...user, isAdmin: true, repositoryIds: [] }, "sync"),
    ).toBe(false);
    expect(
      hasCommentActionGrant(comment, { ...user, permissions: ["action:prepare"] }, "sync"),
    ).toBe(false);
    expect(
      hasCommentActionGrant(comment, { ...user, permissions: ["action:prepare"] }, "reconcile"),
    ).toBe(true);
    expect(hasCommentActionGrant(comment, { ...user, actionCapabilities: [] }, "reconcile")).toBe(
      false,
    );
    expect(canScheduleCommentAction({ ...comment, availableActions: [] }, user, "sync")).toBe(
      false,
    );
  });

  it("uses reconciliation without sending a publication and rejects another target's response", async () => {
    const client = createClient();
    const sync = vi.spyOn(investigationApi, "syncComment");
    const reconcile = vi
      .spyOn(investigationApi, "reconcileComment")
      .mockResolvedValue({ ...comment, workItemNumber: 8 });
    await scheduleCommentCommand(client, comment, "reconcile");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    expect(retained(client).state).toBe("unknown");
    expect(client.getQueryData(["investigation-comment", comment.id])).toBeUndefined();
  });
});
