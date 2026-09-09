import type {
  PlatformSchedulingStatus,
  RepositorySchedulingStatus,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { MockRepositoryAdapter } from "../repositories/mock-adapter";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import { DashboardHttpClient } from "../review-control/http-client";
import { HttpSchedulingPolicyAdapter } from "./http-adapter";
import { SampleSchedulingPolicyAdapter } from "./sample-adapter";

const now = "2026-09-07T10:00:00.000Z";
const sample = () =>
  new SampleSchedulingPolicyAdapter(new MockRepositoryAdapter(), () => new Date(now));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("scheduling policy adapter", () => {
  it("uses exact same-origin authenticated paths for status, CAS and audit", async () => {
    const fixtures = sample();
    const repository = await fixtures.repository("repo-powertoys");
    const platform = await fixtures.platform();
    const updated = await fixtures.update({
      expectedVersion: 2,
      limits: { maxActiveLeases: 1, maxQueuedJobs: 1 },
    });
    const activity = await fixtures.activity();
    const summary = activity.items[0];
    if (!summary) throw new Error("Expected a sample scheduling event.");
    const event = await fixtures.event(summary.id);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(repository))
      .mockResolvedValueOnce(json(platform))
      .mockResolvedValueOnce(json(updated))
      .mockResolvedValueOnce(json(activity))
      .mockResolvedValueOnce(json(event));
    const adapter = new HttpSchedulingPolicyAdapter({ fetch });
    await adapter.repository("repo-powertoys");
    await adapter.platform();
    await adapter.update({ expectedVersion: 2, limits: { maxActiveLeases: 1, maxQueuedJobs: 1 } });
    await adapter.activity();
    await adapter.event(event.id);
    expect(fetch.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ["/api/v1/operator/repositories/repo-powertoys/scheduling", "GET"],
      ["/api/v1/operator/scheduling", "GET"],
      ["/api/v1/operator/scheduling", "PATCH"],
      ["/api/v1/operator/scheduling/activity?page=1&pageSize=20", "GET"],
      [`/api/v1/operator/scheduling/activity/${event.id}`, "GET"],
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
  });
  it("allows lowered limits, reports overage and preserves all accepted usage", async () => {
    const adapter = sample();
    const before = await adapter.platform();
    await adapter.update({ expectedVersion: 2, limits: { maxActiveLeases: 1, maxQueuedJobs: 1 } });
    const after = await adapter.platform();
    expect(after.usage).toEqual(before.usage);
    expect(after.overage).toEqual({ activeLeases: 3, admittedQueuedJobs: 5 });
    await expect(
      adapter.update({
        expectedVersion: 2,
        limits: { maxActiveLeases: null, maxQueuedJobs: null },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("reads current sample repository limits after saves and preserves PATCH omission", async () => {
    const repositories = new MockRepositoryAdapter();
    const adapter = new SampleSchedulingPolicyAdapter(repositories, () => new Date(now));
    await repositories.update("repo-powertoys", {
      expectedVersion: 1,
      schedulingLimits: { maxActiveLeases: 1, maxQueuedJobs: 1 },
    });
    await repositories.update("repo-powertoys", { expectedVersion: 2, enabled: false });
    expect(await adapter.repository("repo-powertoys")).toMatchObject({
      enabled: false,
      repositoryVersion: 3,
      limits: { maxActiveLeases: 1, maxQueuedJobs: 1 },
      overage: { activeLeases: 1, admittedQueuedJobs: 2 },
    });
  });
  it.each(["../other", "repo/other", "repo%2Fother", "repo\n", ""])(
    "rejects invalid scopes %j before a request",
    async (id) => {
      const fetch = vi.fn();
      const adapter = new HttpSchedulingPolicyAdapter({ fetch });
      await expect(adapter.repository(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.event(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    (value: RepositorySchedulingStatus) => ({ ...value, repositoryId: "another-repository" }),
    (value: RepositorySchedulingStatus) => ({
      ...value,
      usage: { ...value.usage, activeLeases: -1 },
    }),
    (value: RepositorySchedulingStatus) => ({
      ...value,
      overage: { ...value.overage, activeLeases: 1 },
    }),
    (value: RepositorySchedulingStatus) => ({
      ...value,
      limits: { maxActiveLeases: 0, maxQueuedJobs: null },
    }),
    (value: RepositorySchedulingStatus) => ({
      ...value,
      platform: { ...value.platform, usage: { activeLeases: 999 } },
    }),
    (value: RepositorySchedulingStatus) => ({ ...value, observedAt: "2026-09-07T10:00:00Z" }),
  ])("rejects scope, count, quota and restricted-data corruption", async (corrupt) => {
    const value = await sample().repository("repo-powertoys");
    const adapter = new HttpSchedulingPolicyAdapter({
      fetch: vi.fn(async () => json(corrupt(value))),
    });
    await expect(adapter.repository("repo-powertoys")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("rejects unscoped usage greater than the global total", async () => {
    const value: PlatformSchedulingStatus = await sample().platform();
    const adapter = new HttpSchedulingPolicyAdapter({
      fetch: vi.fn(async () =>
        json({ ...value, unscopedUsage: { ...value.unscopedUsage, activeLeases: 100 } }),
      ),
    });
    await expect(adapter.platform()).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("rejects partial limits and oversized audit pages before transport", async () => {
    const fetch = vi.fn();
    const adapter = new HttpSchedulingPolicyAdapter({ fetch });
    await expect(
      adapter.update({ expectedVersion: 2, limits: { maxActiveLeases: null } } as never),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.activity({ pageSize: 21 })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps HTTP access errors visible without a sample fallback", async () => {
    const adapter = new HttpSchedulingPolicyAdapter({
      fetch: vi.fn(async () => json({ error: "forbidden" }, 403)),
    });
    await expect(adapter.platform()).rejects.toBeInstanceOf(ReviewControlHttpError);
  });
  it.each([
    { id: "event-with-trailing-newline\n" },
    { actor: { issuer: " issuer ", subject: "operator" } },
    { actor: { issuer: "issuer", subject: "operator\u0000suffix" } },
  ])("rejects noncanonical audit identity fields %j", async (changes) => {
    const activity = await sample().activity();
    const value = { ...activity, items: activity.items.map((entry) => ({ ...entry, ...changes })) };
    const adapter = new HttpSchedulingPolicyAdapter({ fetch: vi.fn(async () => json(value)) });
    await expect(adapter.activity()).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("honors an obsolete request signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Scope changed"));
    const fetch = vi.fn();
    await expect(
      new HttpSchedulingPolicyAdapter({ fetch }).repository("repo-powertoys", controller.signal),
    ).rejects.toThrow("Scope changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "/api/v1/operator/scheduling/activity?page=1&pageSize=21",
    "/api/v1/operator/scheduling/activity?page=01&pageSize=20",
    "/api/v1/operator/scheduling/activity?page=1&pageSize=20&repositoryId=other",
  ])("rejects noncanonical activity requests %s", async (path) => {
    const fetch = vi.fn();
    await expect(
      new DashboardHttpClient({ fetch }).get(path, "read scheduling activity"),
    ).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
});
