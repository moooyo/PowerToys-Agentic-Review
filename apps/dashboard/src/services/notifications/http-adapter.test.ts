import { describe, expect, it, vi } from "vitest";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import {
  notificationChangeFixture,
  notificationListFixture,
  notificationOverviewFixture,
  notificationSummaryFixture,
  notificationTestActor,
} from "./fixtures.testing";
import { HttpNotificationAdapter } from "./http-adapter";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const withResponse = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: new HttpNotificationAdapter({ fetch }) };
};
const request = {
  changeId: "change-a",
  changes: [{ notificationId: "notification-a", expectedVersion: 0, state: "read" as const }],
};

describe("notification transport", () => {
  it("uses only exact bounded notification endpoints and authenticated no-store requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(notificationOverviewFixture()))
      .mockResolvedValueOnce(json(notificationSummaryFixture()))
      .mockResolvedValueOnce(json(notificationSummaryFixture("repository-a")))
      .mockResolvedValueOnce(json(notificationListFixture()))
      .mockResolvedValueOnce(json(notificationChangeFixture(request)));
    const adapter = new HttpNotificationAdapter({ fetch });
    await adapter.overview({}, notificationTestActor);
    await adapter.summary(undefined, notificationTestActor);
    await adapter.summary("repository-a", notificationTestActor);
    await adapter.list("repository-a", {}, notificationTestActor);
    await adapter.change("repository-a", request, notificationTestActor);
    expect(fetch.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ["/api/v1/operator/notifications/overview?page=1&pageSize=20", "GET"],
      ["/api/v1/operator/notifications/summary", "GET"],
      ["/api/v1/operator/notifications/summary?repositoryId=repository-a", "GET"],
      [
        "/api/v1/operator/repositories/repository-a/notifications?limit=20&state=all&workItemKind=all",
        "GET",
      ],
      ["/api/v1/operator/repositories/repository-a/notifications/state", "POST"],
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
    expect(JSON.parse(String(fetch.mock.calls[4]?.[1]?.body))).toEqual(request);
  });
  it("retains an empty filtered window with a continuation cursor", async () => {
    const value = {
      ...notificationListFixture(),
      items: [],
      scanLimited: true,
      nextCursor: "100",
      filter: { state: "unread" as const, workItemKind: "issue" as const },
      limit: 50,
    };
    const { adapter, fetch } = withResponse(value);
    await expect(
      adapter.list(
        "repository-a",
        { limit: 50, state: "unread", workItemKind: "issue", cursor: "500" },
        notificationTestActor,
      ),
    ).resolves.toEqual(value);
    expect(fetch.mock.calls[0]?.[0]).toContain(
      "?limit=50&state=unread&workItemKind=issue&cursor=500",
    );
  });
  it.each(["", "../repo", "repository/a", "repository%3Aa", "repo\n"])(
    "rejects unsafe repository scope %j before fetching",
    async (repositoryId) => {
      const { adapter, fetch } = withResponse({});
      await expect(adapter.summary(repositoryId, notificationTestActor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(adapter.list(repositoryId, {}, notificationTestActor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(
        adapter.change(repositoryId, request, notificationTestActor),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { cursor: "0" },
    { cursor: "01" },
    { cursor: "9007199254740992" },
    { limit: 51 },
    { state: "new" },
    { page: 1 },
    { workItemKind: "pr" },
  ])("rejects invalid query %j", async (query) => {
    const { adapter, fetch } = withResponse({});
    await expect(
      adapter.list("repository-a", query as never, notificationTestActor),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { actor: { ...notificationTestActor, subject: "reader-b" } },
    { repositoryId: "repository-b" },
    { filter: { state: "read", workItemKind: "all" } },
    { limit: 50 },
    {
      items: [
        {
          ...notificationListFixture().items[0],
          state: { ...notificationListFixture().items[0]?.state, notificationId: "other" },
        },
      ],
    },
    {
      items: [
        {
          ...notificationListFixture().items[0],
          event: { ...notificationListFixture().items[0]?.event, repositoryId: "repository-b" },
        },
      ],
    },
    { observedAt: "2026-09-07T12:00:00Z" },
  ])("rejects mismatched or noncanonical list response %j", async (patch) => {
    const { adapter } = withResponse({ ...notificationListFixture(), ...patch });
    await expect(adapter.list("repository-a", {}, notificationTestActor)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it.each([
    { changeId: "other" },
    { repositoryId: "repository-b" },
    { actor: { ...notificationTestActor, subject: "other" } },
    { changes: [{ ...notificationChangeFixture(request).changes[0], previousVersion: 1 }] },
    {
      changes: [
        {
          ...notificationChangeFixture(request).changes[0],
          state: { ...notificationChangeFixture(request).changes[0]?.state, state: "archived" },
        },
      ],
    },
  ])("rejects a receipt that does not match the operator and submitted CAS %j", async (patch) => {
    const { adapter } = withResponse({ ...notificationChangeFixture(request), ...patch });
    await expect(
      adapter.change("repository-a", request, notificationTestActor),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("replays the exact request body and does not auto retry a lost response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(json({ ...notificationChangeFixture(request), replayed: true }));
    const adapter = new HttpNotificationAdapter({ fetch });
    await expect(adapter.change("repository-a", request, notificationTestActor)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      adapter.change("repository-a", request, notificationTestActor),
    ).resolves.toMatchObject({ replayed: true });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
  });
  it("rejects duplicate, oversized and hidden extra state changes", async () => {
    const { adapter, fetch } = withResponse({});
    for (const value of [
      { ...request, changes: [...request.changes, ...request.changes] },
      {
        ...request,
        changes: Array.from({ length: 51 }, (_, i) => ({
          ...request.changes[0],
          notificationId: `event-${i}`,
        })),
      },
      { ...request, actor: notificationTestActor },
    ])
      await expect(
        adapter.change("repository-a", value as never, notificationTestActor),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not conflate a summary failure with zero unread", async () => {
    const { adapter } = withResponse({
      ...notificationSummaryFixture(),
      capped: true,
      unreadCount: 0,
    });
    await expect(adapter.summary(undefined, notificationTestActor)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("rejects cross-operator overview data and inconsistent counters", async () => {
    for (const value of [
      { ...notificationOverviewFixture(), actor: { ...notificationTestActor, subject: "other" } },
      {
        ...notificationOverviewFixture(),
        items: [
          {
            ...notificationOverviewFixture().items[0],
            counts: { total: 1, unread: 3, read: 0, archived: 0 },
          },
        ],
      },
    ]) {
      const { adapter } = withResponse(value);
      await expect(adapter.overview({}, notificationTestActor)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });
});
