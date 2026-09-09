import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJobListResponse,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { sampleReviewRuns } from "@/services/runs/fixtures";
import {
  loadNotificationJob,
  loadNotificationRun,
  notificationRunWorkItem,
  type ValidationNotificationTarget,
} from "./navigation";

function fixture(kind: "pull_request" | "issue" = "pull_request") {
  const stored = sampleReviewRuns.find((run) => run.workItemKind === kind);
  if (!stored) throw new Error("A sample run is required.");
  const run = structuredClone(stored);
  const request = run.requests.find((item) => item.latestJob !== null);
  if (!request?.latestJob) throw new Error("A sample job is required.");
  const job = { ...request.latestJob, jobId: "historical-job", activationNumber: 1 };
  request.latestJob = { ...request.latestJob, jobId: "newest-job", activationNumber: 12 };
  const target: ValidationNotificationTarget = {
    kind: "validation",
    repositoryId: run.repositoryId,
    workItemKind: kind,
    workItemId: run.workItemId,
    reviewRunId: run.id,
    requestId: request.requestId,
    jobId: job.jobId,
  };
  const page: DashboardReviewRunJobListResponse = {
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    requestId: request.requestId,
    items: [job],
    total: 1,
    page: 1,
    pageSize: 1,
  };
  return { run, request, job, target, page };
}

describe("notification run resolution", () => {
  it.each(["pull_request", "issue"] as const)("loads only the exact %s run", async (kind) => {
    const { run, target } = fixture(kind);
    const adapter = { get: vi.fn(async () => run) };
    expect(await loadNotificationRun(adapter, target)).toBe(run);
    expect(adapter.get).toHaveBeenCalledExactlyOnceWith(target.repositoryId, target.reviewRunId);
    expect(notificationRunWorkItem(run)).toEqual({
      id: run.workItemId,
      repositoryId: run.repositoryId,
      kind,
      repository: run.repository,
      title: run.title,
      number: run.number,
    });
  });

  it.each(["repositoryId", "workItemId", "id", "workItemKind"] as const)(
    "rejects an exact read with a different %s",
    async (field) => {
      const { run, target } = fixture();
      const response = {
        ...run,
        [field]: field === "workItemKind" ? "issue" : "another-id",
      } as DashboardReviewRunDetail;
      await expect(
        loadNotificationRun({ get: vi.fn(async () => response) }, target),
      ).rejects.toThrow("does not match");
    },
  );

  it("does not fall back to another request or retry a missing run", async () => {
    const { run, target } = fixture();
    await expect(
      loadNotificationRun({ get: vi.fn(async () => run) }, { ...target, requestId: "absent" }),
    ).rejects.toThrow("does not match");
    const get = vi.fn(async () => {
      throw new Error("not found");
    });
    await expect(loadNotificationRun({ get }, target)).rejects.toThrow("not found");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retains a superseded run instead of loading the latest revision", async () => {
    const { run, target } = fixture();
    run.freshness = "superseded";
    const adapter = { get: vi.fn(async () => run) };
    expect((await loadNotificationRun(adapter, target)).freshness).toBe("superseded");
    expect(adapter.get).toHaveBeenCalledTimes(1);
  });
});

describe("notification historical job resolution", () => {
  it("requests one exact historical job despite a newer activation", async () => {
    const { run, request, job, page } = fixture();
    const adapter = { listJobs: vi.fn(async () => page) };
    await expect(
      loadNotificationJob(adapter, run, { requestId: request.requestId, jobId: job.jobId }),
    ).resolves.toEqual({ requestId: request.requestId, job });
    expect(adapter.listJobs).toHaveBeenCalledExactlyOnceWith(
      run.repositoryId,
      run.id,
      request.requestId,
      { jobId: job.jobId, page: 1, pageSize: 1 },
    );
  });

  it("preserves an actual failed job without fabricating a saved report", async () => {
    const { run, request, job, page } = fixture();
    job.status = "failed";
    job.resultId = null;
    job.resultDigest = null;
    job.failureCode = "BUILD_FAILED";
    const selection = await loadNotificationJob({ listJobs: vi.fn(async () => page) }, run, {
      requestId: request.requestId,
      jobId: job.jobId,
    });
    expect(selection.job).toBe(job);
    expect(selection.job.resultId).toBeNull();
    expect(selection.job.failureCode).toBe("BUILD_FAILED");
  });

  it.each(["repositoryId", "reviewRunId", "requestId", "page", "pageSize", "total"] as const)(
    "rejects a historical job response with a different %s",
    async (field) => {
      const { run, request, job, page } = fixture();
      const response = {
        ...page,
        [field]: ["page", "pageSize", "total"].includes(field) ? 2 : "another-id",
      };
      await expect(
        loadNotificationJob({ listJobs: vi.fn(async () => response) }, run, {
          requestId: request.requestId,
          jobId: job.jobId,
        }),
      ).rejects.toThrow("unavailable");
    },
  );

  it.each(["missing", "newest", "duplicate"])("does not substitute a %s job", async (variant) => {
    const { run, request, job, page } = fixture();
    if (!request.latestJob) throw new Error("A newer job is required.");
    page.items =
      variant === "missing" ? [] : variant === "newest" ? [request.latestJob] : [job, job];
    page.total = page.items.length;
    const adapter = { listJobs: vi.fn(async () => page) };
    await expect(
      loadNotificationJob(adapter, run, { requestId: request.requestId, jobId: job.jobId }),
    ).rejects.toThrow("unavailable");
    expect(adapter.listJobs).toHaveBeenCalledTimes(1);
  });

  it("refuses an unowned request before reading job history", async () => {
    const { run, job, page } = fixture();
    const adapter = { listJobs: vi.fn(async () => page) };
    await expect(
      loadNotificationJob(adapter, run, { requestId: "another-request", jobId: job.jobId }),
    ).rejects.toThrow("does not belong");
    expect(adapter.listJobs).not.toHaveBeenCalled();
  });
});
