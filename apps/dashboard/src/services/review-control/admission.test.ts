import type {
  DashboardJobListItem,
  DashboardWorkItemListItem,
  JobAdmission,
  JobState,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobDisplayStatus } from "./admission";
import { HttpReviewControlAdapter } from "./http-adapter";
import {
  mapJobListResponse,
  mapSystemSnapshotResponse,
  mapWorkItemListResponse,
} from "./http-mappers";
import { jobs, workItems } from "./mock/fixtures";
import { MockReviewControlAdapter } from "./mock/mock-adapter";

const at = "2026-09-07T08:00:00.000Z";
const episode = (state: "pending" | "admitted", attemptBase = 2): JobAdmission =>
  state === "pending"
    ? { state, attemptBase, requestedAt: at, admittedAt: null, timestampBasis: "recorded" }
    : { state, attemptBase, requestedAt: at, admittedAt: at, timestampBasis: "recorded" };
const job = (
  status: JobState = "queued",
  admission: JobAdmission | null = episode("pending"),
): DashboardJobListItem => ({
  id: "job-one",
  repositoryId: "repo-one",
  workItemId: "item-one",
  workItemRef: "owner/repo#1",
  title: "PR review",
  generation: 1,
  status,
  admission,
  phase: status === "running" ? "validation" : null,
  attempt: 2,
  maxAttempts: 3,
  workerNodeId: null,
  leaseGeneration: null,
  leaseExpiresAt: null,
  progressUpdatedAt: null,
  elapsedSeconds: 0,
  targetRevisionKey: "a".repeat(64),
  outcome: null,
  createdAt: at,
  updatedAt: at,
});
const item = (): DashboardWorkItemListItem => ({
  id: "item-one",
  repositoryId: "repo-one",
  kind: "issue",
  repository: "owner/repo",
  number: 1,
  title: "Issue",
  author: { githubUserId: 1, login: "author" },
  githubUrl: "https://example.test/owner/repo/issues/1",
  trigger: null,
  schedulingActor: null,
  schedulingTarget: null,
  authorization: null,
  authorizationReason: null,
  priority: "normal",
  state: "open",
  stage: "awaiting_admission",
  freshness: "current",
  currentRevision: {
    kind: "issue",
    githubRepositoryId: 1,
    githubWorkItemId: 1,
    observedAt: at,
    sourceUpdatedAt: at,
    revisionKey: "a".repeat(64),
    contentDigest: "a".repeat(64),
  },
  reviewedRevisionKey: null,
  activeRequestEpoch: null,
  latestJobId: "job-one",
  latestJobStatus: "queued",
  latestJobAttemptCount: 2,
  latestJobAdmission: episode("pending"),
  workerNodeId: null,
  attentionReason: null,
  updatedAt: at,
});
const page = (value: unknown) => ({ items: [value], total: 1 });
const system = {
  serverVersion: "test",
  protocolVersion: "1.0",
  nodeVersion: "24",
  sqliteVersion: "3.50",
  databaseSizeBytes: 0,
  oldestQueuedAt: at,
  oldestAwaitingAdmissionAt: at,
  queuedJobs: 1,
  awaitingAdmissionJobs: 2,
  pendingValidationRequests: 3,
  activeWorkers: 0,
  activeLeases: 0,
  pendingApprovals: 0,
  health: [],
};

describe("admission-aware read projections", () => {
  it.each(["queued", "retry_waiting"] as const)(
    "preserves both waiting groups without creating an attempt for %s",
    (status) => {
      for (const state of ["pending", "admitted"] as const) {
        const mapped = mapJobListResponse(page(job(status, episode(state)))).items[0];
        expect(mapped).toMatchObject({
          id: "job-one",
          status,
          attempt: 2,
          admission: episode(state),
          stage: state === "pending" ? "awaiting_admission" : "queued",
        });
        expect(jobDisplayStatus(status, mapped?.admission ?? null)).toBe(
          state === "pending" ? "awaiting_admission" : "queued",
        );
      }
    },
  );
  it.each([
    "leased",
    "running",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "stale",
    "dead_letter",
  ] as const)("requires null current admission for %s", (status) => {
    expect(mapJobListResponse(page(job(status, null))).items[0]?.admission).toBeNull();
    expect(() => mapJobListResponse(page(job(status, episode("admitted"))))).toThrow();
    expect(jobDisplayStatus(status, null)).toBe(status);
  });
  it.each([
    null,
    undefined,
    { ...episode("pending"), attemptBase: 1 },
    { ...episode("pending"), admittedAt: at },
    { ...episode("admitted"), admittedAt: null },
    { ...episode("admitted"), timestampBasis: "assumed" },
    { ...episode("pending"), bucket: "private" },
  ])("rejects missing, stale or private admission data", (admission) => {
    expect(() => mapJobListResponse(page({ ...job(), admission }))).toThrow();
  });
  it("retains migration provenance and wall-clock rollback without inventing original times", () => {
    const admission = {
      ...episode("admitted"),
      state: "admitted" as const,
      timestampBasis: "migration_backfill" as const,
      requestedAt: "2026-09-07T09:00:00.000Z",
      admittedAt: at,
    };
    expect(mapJobListResponse(page(job("queued", admission))).items[0]?.admission).toEqual(
      admission,
    );
  });
  it("keeps no-job Work Items separate from real pending jobs", () => {
    expect(mapWorkItemListResponse(page(item())).items[0]).toMatchObject({
      latestJobId: "job-one",
      latestJobAttemptCount: 2,
      latestJobAdmission: episode("pending"),
      stage: "awaiting_admission",
    });
    const noJob = {
      ...item(),
      latestJobId: null,
      latestJobStatus: null,
      latestJobAttemptCount: null,
      latestJobAdmission: null,
      stage: "not_scheduled",
    };
    expect(mapWorkItemListResponse(page(noJob)).items[0]).toMatchObject({
      stage: "not_scheduled",
      latestJobAdmission: null,
      latestJobAttemptCount: null,
    });
    expect(() => mapWorkItemListResponse(page({ ...noJob, stage: "queued" }))).toThrow();
    expect(() => mapWorkItemListResponse(page({ ...item(), latestJobAttemptCount: 1 }))).toThrow();
    expect(() => mapWorkItemListResponse(page({ ...item(), stage: "queued" }))).toThrow();
  });
  it("keeps global admitted, pending-job and no-job counters independent", () => {
    expect(mapSystemSnapshotResponse(system)).toMatchObject({
      queuedJobs: 1,
      awaitingAdmissionJobs: 2,
      pendingValidationRequests: 3,
      oldestQueuedAt: at,
      oldestAwaitingAdmissionAt: at,
    });
    expect(() => mapSystemSnapshotResponse({ ...system, queuedJobs: 0 })).toThrow();
    expect(() =>
      mapSystemSnapshotResponse({ ...system, oldestAwaitingAdmissionAt: null }),
    ).toThrow();
  });
  it("does not silently default a missing waiting admission to Queued", () => {
    expect(jobDisplayStatus("queued", null)).toBe("unknown");
  });
});

describe("admission filters and honest sample groups", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each(["pending", "admitted"] as const)(
    "filters %s before pagination and retains real job identities",
    async (state) => {
      const selected = jobs.filter((value) => value.admission?.state === state);
      const result = await new MockReviewControlAdapter().listJobs({
        page: 1,
        pageSize: 1,
        filters: { admission: state },
      });
      expect(result.total).toBe(selected.length);
      expect(result.items.map((value) => value.id)).toEqual(
        selected.slice(0, 1).map((value) => value.id),
      );
      expect(
        result.items.every(
          (value) => value.status === "queued" || value.status === "retry_waiting",
        ),
      ).toBe(true);
    },
  );
  it("does not include active or terminal jobs when both admission states are selected", async () => {
    const result = await new MockReviewControlAdapter().listJobs({
      filters: { admission: ["pending", "admitted"] },
    });
    expect(result.total).toBe(2);
    expect(result.items.map((value) => value.id).sort()).toEqual([
      "job-01JPR41925",
      "job-terminal-pr-21042",
    ]);
    expect(workItems.find((value) => value.id === "wi-issue-41903")).toMatchObject({
      stage: "not_scheduled",
      latestJobAttemptCount: null,
      latestJobAdmission: null,
    });
    const snapshot = await new MockReviewControlAdapter().getSystemSnapshot();
    expect(snapshot).toMatchObject({
      queuedJobs: 1,
      awaitingAdmissionJobs: 1,
      pendingValidationRequests: 1,
    });
  });
  it("does not match a pending queue filter against a running status filter", async () => {
    expect(
      (
        await new MockReviewControlAdapter().listJobs({
          filters: { admission: "pending", status: "running" },
        })
      ).total,
    ).toBe(0);
  });
  it("sends admission as a separate canonical filter", async () => {
    const fetch = vi.fn(
      async (_path: RequestInfo | URL) =>
        new Response(JSON.stringify(page(job())), {
          headers: { "content-type": "application/json" },
        }),
    );
    await new HttpReviewControlAdapter({ fetch }).listJobs({
      filters: { status: ["queued", "retry_waiting"], admission: "pending" },
    });
    expect(fetch.mock.calls[0]?.[0]).toContain(
      "status=queued&status=retry_waiting&admission=pending",
    );
  });
  it.each<[string | string[]]>([
    [[]],
    [["pending", "pending"]],
    [["pending", "admitted", "pending"]],
    ["unknown"],
    ["pending\n"],
  ])("rejects invalid admission query values", async (admission) => {
    const fetch = vi.fn();
    await expect(
      new HttpReviewControlAdapter({ fetch }).listJobs({ filters: { admission } }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      new MockReviewControlAdapter().listJobs({ filters: { admission } }),
    ).rejects.toThrow();
  });
});
