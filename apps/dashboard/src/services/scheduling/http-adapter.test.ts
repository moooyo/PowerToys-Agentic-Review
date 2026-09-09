import type { SchedulingDiagnostics } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlUnsupportedOperationError,
} from "../review-control/errors";
import type { SchedulingReadScope } from "./adapter";
import {
  observation,
  platformObservation,
  platformScope,
  repositoryScope,
  requestScope,
} from "./fixtures.testing";
import { HttpSchedulingAdapter } from "./http-adapter";
import { SampleSchedulingAdapter } from "./sample-adapter";

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
describe("current scheduling reads", () => {
  it("preserves pending admission and its explicit start rule", async () => {
    const value = structuredClone(observation);
    if (!value.job?.admission) throw new Error("The fixture must include a waiting job.");
    value.job.admission = { ...value.job.admission, state: "pending", admittedAt: null };
    value.reasons = [{ code: "awaiting_admission", effect: "claim_gate" }];
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).resolves.toEqual(value);
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response({ ...value, reasons: [] }) }).get(
        repositoryScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    value.job.admission.attemptBase += 1;
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("rejects historical V1 and V2 responses on a current scheduling read", async () => {
    const value = structuredClone(observation);
    if (!value.job) throw new Error("The fixture must include a waiting job.");
    const { admission: _admission, ...historicalJob } = value.job;
    await expect(
      new HttpSchedulingAdapter({
        fetch: async () =>
          response({ ...value, schemaVersion: "SchedulingDiagnosticsV1", job: historicalJob }),
      }).get(repositoryScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const { policy: _policy, ...historicalV2 } = value;
    await expect(
      new HttpSchedulingAdapter({
        fetch: async () => response({ ...historicalV2, schemaVersion: "SchedulingDiagnosticsV2" }),
      }).get(repositoryScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it.each([
    [
      repositoryScope,
      observation,
      "/api/v1/operator/repositories/repository:one/jobs/job:one/scheduling",
    ],
    [
      requestScope,
      { ...observation, subject: requestScope },
      "/api/v1/operator/repositories/repository:one/review-runs/run:one/requests/request:one/scheduling",
    ],
    [platformScope, platformObservation, "/api/v1/operator/scheduling/jobs/job:one"],
    [
      platformScope,
      {
        ...observation,
        policy: { ...observation.policy, platform: platformObservation.policy.platform },
      },
      "/api/v1/operator/scheduling/jobs/job:one",
    ],
  ] as const)("uses its exact GET path for %j", async (scope, value, path) => {
    const fetch = vi.fn(async (_path: RequestInfo | URL, _init?: RequestInit) => response(value));
    await expect(new HttpSchedulingAdapter({ fetch }).get(scope)).resolves.toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(path);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "error",
    });
  });
  it.each([
    { ...observation, subject: { ...observation.subject, repositoryId: "another-repository" } },
    { ...observation, subject: { ...observation.subject, workItemId: "another-item" } },
    { ...observation, job: { ...observation.job, jobId: "another-job" } },
    { ...observation, stage: "executing" },
    { ...observation, workerInspection: { state: "partial", latestContactAt: null } },
    { ...observation, reasons: [{ code: "platform_active_limit", effect: "claim_gate" }] },
    { ...observation, reserved: true },
    { ...observation, workerNodeId: "worker:private" },
    { ...observation, policy: undefined },
    { ...observation, policy: { ...observation.policy, repository: null } },
    {
      ...observation,
      policy: {
        ...observation.policy,
        repository: { ...observation.policy.repository, repositoryId: "foreign" },
      },
    },
    {
      ...observation,
      policy: {
        ...observation.policy,
        platform: { ...observation.policy.platform, activeLeases: 5 },
      },
    },
    { ...observation, observedAt: "2026-02-30T08:00:00.000Z" },
    {
      ...observation,
      reasons: [{ code: "retry_backoff", effect: "claim_gate", until: "2026-09-07T08:01:00.000Z" }],
    },
  ])("rejects an invalid or mismatched observation", async (value) => {
    const fetch = vi.fn(async () => response(value));
    await expect(new HttpSchedulingAdapter({ fetch }).get(repositoryScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("shows exact pending quota blockers without disclosing restricted global counts", async () => {
    const value = structuredClone(observation);
    if (!value.job?.admission || !value.policy.repository)
      throw new Error("A repository job is required.");
    value.job.admission = { ...value.job.admission, state: "pending", admittedAt: null };
    value.policy.repository.limits = { maxActiveLeases: 1, maxQueuedJobs: 1 };
    value.policy.repository.usage = {
      activeLeases: 1,
      admittedQueuedJobs: 1,
      awaitingAdmissionJobs: 1,
      awaitingConfigurationRequests: 0,
    };
    value.policy.platform = {
      visibility: "restricted",
      version: 2,
      activeCapacity: "available",
      queueCapacity: "limited",
    };
    value.reasons = [
      { code: "awaiting_admission", effect: "claim_gate" },
      { code: "repository_queue_limit", effect: "admission_gate" },
      { code: "platform_queue_limit", effect: "admission_gate" },
      { code: "repository_active_limit", effect: "claim_gate" },
    ];
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).resolves.toEqual(value);
    value.reasons = value.reasons.filter((reason) => reason.code !== "repository_queue_limit");
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("accepts honest partial inspection without inventing worker absence", async () => {
    const value: SchedulingDiagnostics = {
      ...observation,
      workerInspection: { state: "partial", latestContactAt: null },
      reasons: [{ code: "inspection_incomplete", effect: "observation" }],
    };
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).resolves.toEqual(value);
  });
  it("retains a no-job request with current prerequisites", async () => {
    const value: SchedulingDiagnostics = {
      ...observation,
      subject: requestScope,
      job: null,
      workerInspection: { state: "not_applicable", latestContactAt: null },
      reasons: [
        {
          code: "plan_prerequisite_missing",
          effect: "current_prerequisite",
          requirement: "profile",
        },
      ],
    };
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(requestScope),
    ).resolves.toEqual(value);
  });
  it("preserves future contact timestamps after a server clock rollback", async () => {
    const value = {
      ...observation,
      workerInspection: { state: "complete", latestContactAt: "2026-09-07T08:10:00.000Z" },
      requirements: { names: [], truncated: true },
    };
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response(value) }).get(repositoryScope),
    ).resolves.toEqual(value);
  });
  it.each(["../job", "job%3Aone", "job?x=1", "job\n", "", "job/other"])(
    "rejects unsafe identifiers before fetching",
    async (jobId) => {
      const fetch = vi.fn();
      await expect(
        new HttpSchedulingAdapter({ fetch }).get({ kind: "platform_job", jobId }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("freezes input identity while the HTTP request is pending", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const scope = { ...repositoryScope };
    const pending = new HttpSchedulingAdapter({ fetch }).get(scope);
    Object.assign(scope, { workItemId: "changed-item" });
    resolve(response(observation));
    await expect(pending).resolves.toEqual(observation);
  });
  it("does not fall back to sample data on authorization failure", async () => {
    const fetch = vi.fn(async () => response({ code: "not_found", message: "Unavailable." }, 404));
    await expect(new HttpSchedulingAdapter({ fetch }).get(repositoryScope)).rejects.toBeInstanceOf(
      ReviewControlHttpError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("enforces the 64 KiB transport limit", async () => {
    await expect(
      new HttpSchedulingAdapter({ fetch: async () => response("x".repeat(65536)) }).get(
        repositoryScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
  });
  it("passes cancellation to the actual HTTP request", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const fetch = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const pending = new HttpSchedulingAdapter({ fetch }).get(repositoryScope, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(received?.aborted).toBe(true);
  });
  it("never creates synthetic live observations in sample mode", async () => {
    await expect(new SampleSchedulingAdapter().get(repositoryScope)).rejects.toBeInstanceOf(
      ReviewControlUnsupportedOperationError,
    );
  });
  it("does not accept a request subject through the platform job endpoint", async () => {
    await expect(
      new HttpSchedulingAdapter({
        fetch: async () => response({ ...observation, subject: requestScope }),
      }).get(platformScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("rejects extra request-scope fields", async () => {
    const fetch = vi.fn();
    await expect(
      new HttpSchedulingAdapter({ fetch }).get({
        ...platformScope,
        workerNodeId: "worker:secret",
      } as unknown as SchedulingReadScope),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
