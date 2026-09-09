import {
  type DashboardReviewRunDetail,
  DashboardReviewRunDetailSchema,
  DashboardReviewRunJobListResponseSchema,
  DashboardReviewRunListResponseSchema,
  DashboardReviewRunResultSchema,
  maximumDashboardReviewRunPolicyReasonCount,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
  ValidationExecutionDetailsSchema,
  type ValidationProfileCreateRequest,
  ValidationReportV1Schema,
} from "@agentic-review/contracts";
import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { MockConfigurationAdapter } from "../configuration/mock-adapter";
import { ReviewControlHttpError, ReviewControlRequestError } from "../review-control/errors";
import { workItems } from "../review-control/mock/fixtures";
import type { ReviewRunListQuery, ReviewRunPageQuery } from "./adapter";
import { sampleReviewRunResults, sampleReviewRuns } from "./fixtures";
import { MockReviewRunAdapter } from "./mock-adapter";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const repositoryId = "repo-powertoys";
const otherRepositoryId = "repo-terminal";
const timestamp = "2026-09-07T16:00:00.000Z";
const makeConfiguration = () => new MockConfigurationAdapter({ now: () => new Date(timestamp) });
const makeAdapter = (empty = false, configuration = makeConfiguration()) =>
  new MockReviewRunAdapter({ empty, configuration, now: () => new Date(timestamp) });

it("does not present sample rerun or cancel actions as real execution", async () => {
  const adapter = makeAdapter();
  const { run, request, job } = sampleJob();
  const before = await adapter.get(repositoryId, run.id);
  expect(adapter.mode).toBe("sample");
  await expect(
    adapter.rerun(repositoryId, run.id, request.requestId, { activationId: "sample-intent" }),
  ).rejects.toThrow("Sample mode");
  await expect(adapter.cancel(repositoryId, run.id, request.requestId, job.jobId)).rejects.toThrow(
    "Sample mode",
  );
  expect(await adapter.get(repositoryId, run.id)).toEqual(before);
});

it("keeps exact sample job lookups scoped and does not substitute the latest job", async () => {
  const adapter = makeAdapter();
  const { run, request, job } = sampleJob();
  expect(
    await adapter.listJobs(repositoryId, run.id, request.requestId, {
      jobId: job.jobId,
      pageSize: 1,
    }),
  ).toMatchObject({ items: [job], total: 1, page: 1, pageSize: 1 });
  expect(
    await adapter.listJobs(repositoryId, run.id, request.requestId, {
      jobId: "absent-job",
      pageSize: 1,
    }),
  ).toMatchObject({ items: [], total: 0 });
});

it("explicitly rejects mapped sample creation and evidence without altering legacy intent", async () => {
  const adapter = makeAdapter();
  const run = sampleRun("wi-issue-41876");
  const request = run.requests.find((entry) => entry.workflowKind === "issue_validation");
  if (request?.profile == null) throw new Error("The sample Issue validation profile is missing.");
  const profile = request.profile;
  const before = await adapter.list(repositoryId);
  const input: OperatorReviewRunCreateRequest = {
    ...createRequest("mapped-sample-intent", run),
    testedSourceCommit: "a".repeat(40),
    reproduction: {
      schemaVersion: "IssueReproductionRequestV1",
      claim: "A sample claim.",
      cases: [
        {
          id: "sample-case",
          profileId: profile.profileId,
          expectedProfileVersionId: profile.id,
          context: "Use a public fixture.",
          preconditions: [],
          presentWhen: {
            allOf: [
              {
                observation: { kind: "probe_value", testStepId: "probe", observationId: "present" },
                equals: { type: "boolean", value: true },
              },
            ],
          },
          absentWhen: null,
        },
      ],
    },
  };
  await expect(adapter.create(repositoryId, run.workItemId, input)).rejects.toThrow(
    "Sample mode does not create mapped reproduction runs",
  );
  await expect(
    adapter.getReproductionCase({
      repositoryId,
      reviewRunId: run.id,
      requestId: request.requestId,
      caseId: "sample-case",
    }),
  ).rejects.toThrow("Sample mode does not provide mapped reproduction evidence");
  expect(await adapter.list(repositoryId)).toEqual(before);
  delete input.reproduction;
  const legacy = await adapter.create(repositoryId, run.workItemId, input);
  expect(Object.hasOwn(legacy, "reproduction")).toBe(false);
  expect(
    legacy.requests.every((entry) => entry.latestJob === null && entry.latestResult === null),
  ).toBe(true);
});

function sampleRun(workItemId = "wi-pr-41982"): DashboardReviewRunDetail {
  const run = sampleReviewRuns.find((item) => item.workItemId === workItemId);
  if (!run) throw new Error(`Missing sample review run for ${workItemId}.`);
  return run;
}

function sampleJob() {
  const run = sampleRun();
  const request = run.requests.find((item) => item.latestJob !== null);
  if (!request?.latestJob) throw new Error("The PR sample must include an executed request.");
  return { run, request, job: request.latestJob };
}

function profileIds(run = sampleRun()): string[] {
  return [
    ...new Set(
      run.requests.flatMap((request) => (request.profile ? [request.profile.profileId] : [])),
    ),
  ];
}

function createRequest(
  activationId = "sample-operator-activation",
  run = sampleRun(),
): OperatorReviewRunCreateRequest {
  return { activationId, expectedRevisionKey: run.currentRevisionKey };
}

function expectSchema(schema: TSchema, value: unknown): void {
  expect(Value.Check(schema, value), JSON.stringify([...Value.Errors(schema, value)])).toBe(true);
}

async function expectHttp(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ReviewControlHttpError);
  await expect(promise).rejects.toMatchObject({ status, retryable: false });
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ReviewControlRequestError);
  await expect(promise).rejects.toMatchObject({ code: "invalid_request", retryable: false });
}

async function policyConfiguration(checksPerProfile: readonly number[]) {
  const configuration = new MockConfigurationAdapter({
    empty: true,
    now: () => new Date(timestamp),
  });
  const template = await configuration.createPrompt({
    name: "Sample policy boundary prompt",
    workflowKind: "pr_static_build",
    content: "Sample policy boundary instructions. No commands have been executed.",
    outputSchemaVersion: "PrReviewPlanV2",
  });
  const prompt = await configuration.publishPrompt(template.id, {
    expectedVersion: template.version,
  });
  await configuration.savePromptBinding(null, "pr_static_build", {
    expectedVersion: 0,
    promptVersionId: prompt.id,
  });
  const steps = (phase: "build" | "test", count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${phase}-${index + 1}`,
      name: `Sample ${phase} check ${index + 1}`,
      command: {
        executable: "pwsh",
        args: ["-NoProfile", "-Command", "exit 0"],
        workingDirectory: ".",
        environment: [],
      },
      timeoutMs: 1_000,
      required: true,
    }));
  for (const [index, checkCount] of checksPerProfile.entries()) {
    const profile = await configuration.publishProfile(repositoryId, {
      name: `Sample policy boundary profile ${index + 1}`,
      workflowKind: "pr_static_build",
      target: "headless",
      outputSchemaVersion: "PrReviewPlanV2",
      required: true,
      config: {
        schemaVersion: "ValidationProfileV1",
        setup: [],
        build: steps("build", Math.min(32, checkCount)),
        test: steps("test", Math.max(0, checkCount - 32)),
        launch: [],
        cleanup: [],
        requiredCapabilities: ["windows"],
        hardTimeoutMs: 120_000,
        noProgressTimeoutMs: 30_000,
      },
    });
    await configuration.saveProfileBinding(repositoryId, profile.profileId, {
      expectedVersion: 0,
      profileVersionId: profile.id,
      enabled: true,
    });
  }
  return configuration;
}

describe("sample review run fixtures", () => {
  it("provides complete schema-valid fixtures with exact work item and result associations", () => {
    expect(sampleReviewRuns.length).toBeGreaterThanOrEqual(2);
    expect(sampleReviewRunResults.length).toBeGreaterThanOrEqual(3);
    for (const run of sampleReviewRuns) {
      expectSchema(DashboardReviewRunDetailSchema, run);
      const item = workItems.find((candidate) => candidate.id === run.workItemId);
      expect(item).toMatchObject({
        repositoryId: run.repositoryId,
        repository: run.repository,
        kind: run.workItemKind,
        number: run.number,
        title: run.title,
        revisionKey: run.currentRevisionKey,
      });
      expect(run.requestCount).toBe(run.requests.length);
      expect(run.requiredRequestCount).toBe(
        run.requests.filter((request) => request.required).length,
      );
      expect(Object.values(run.execution).reduce((total, count) => total + count, 0)).toBe(
        run.requestCount,
      );
      expect(new Set(run.requests.map((request) => request.requestId)).size).toBe(run.requestCount);
    }
    for (const result of sampleReviewRunResults) {
      expectSchema(DashboardReviewRunResultSchema, result);
      expectSchema(ValidationReportV1Schema, result.report);
      expectSchema(ValidationExecutionDetailsSchema, result.execution);
      const run = sampleReviewRuns.find((candidate) => candidate.id === result.reviewRunId);
      expect(run).toMatchObject({
        repositoryId: result.repositoryId,
        workItemId: result.workItemId,
        revisionKey: result.revisionKey,
        planDigest: result.planDigest,
        workItemKind: result.report.workItemKind,
      });
      const request = run?.requests.find((candidate) => candidate.requestId === result.requestId);
      expect(request).toMatchObject({
        profile: { id: result.profileVersionId },
        prompt: { id: result.promptVersionId },
        latestJob: {
          jobId: result.jobId,
          runAttemptId: result.runAttemptId,
          activationNumber: result.activationNumber,
          resultId: result.id,
          resultDigest: result.resultDigest,
        },
        latestResult: { id: result.id, resultDigest: result.resultDigest },
      });
      const counts = { passed: 0, failed: 0, blocked: 0, not_run: 0, skipped: 0, inconclusive: 0 };
      for (const check of result.report.checks) counts[check.outcome] += 1;
      expect(request?.latestResult?.checks).toEqual(counts);
      expect(request?.latestResult?.evidenceComplete).toBe(result.evidenceComplete);
      expect(result.report.summary).toMatch(/sample/i);
    }
  });

  it("distinguishes a succeeded PR execution from failed validation and blocked UI coverage", () => {
    const run = sampleRun();
    expect(run.workItemKind).toBe("pull_request");
    expect(run.requests.map((request) => request.workflowKind).sort()).toEqual([
      "pr_static_build",
      "pr_ui",
    ]);
    const staticRequest = run.requests.find(
      (request) => request.workflowKind === "pr_static_build",
    );
    expect(staticRequest?.latestJob?.status).toBe("succeeded");
    expect(staticRequest?.latestResult?.checks.failed).toBeGreaterThan(0);
    const result = sampleReviewRunResults.find(
      (candidate) => candidate.id === staticRequest?.latestResult?.id,
    );
    expect(
      result?.report.checks.some((check) => check.required && check.outcome === "failed"),
    ).toBe(true);
    const uiRequest = run.requests.find((request) => request.workflowKind === "pr_ui");
    expect(uiRequest).toMatchObject({
      readiness: "blocked",
      prompt: null,
      blockers: ["missing_prompt"],
      latestJob: null,
      latestResult: null,
    });
    expect(
      sampleReviewRunResults.some((candidate) => candidate.requestId === uiRequest?.requestId),
    ).toBe(false);
    expect(run.policy).toMatchObject({ applicable: true, eligible: false });
    expect(run.policy.reasons).toContainEqual({
      code: "required_request_blocked",
      requestId: uiRequest?.requestId,
      reason: "missing_prompt",
    });
  });

  it("keeps both Issue workflows complete without assigning a PR eligibility verdict", () => {
    const run = sampleRun("wi-issue-41876");
    expect(run.workItemKind).toBe("issue");
    expect(run.requests.map((request) => request.workflowKind).sort()).toEqual([
      "issue_triage",
      "issue_validation",
    ]);
    expect(run.policy).toMatchObject({ applicable: false, eligible: null });
    for (const request of run.requests) {
      expect(request.latestJob?.status).toBe("succeeded");
      const result = sampleReviewRunResults.find(
        (candidate) => candidate.id === request.latestResult?.id,
      );
      expect(result).toBeDefined();
      expectSchema(DashboardReviewRunResultSchema, result);
      expect(result?.report.workItemKind).toBe("issue");
      expect(result?.modelReview.recommendation).toBeNull();
    }
  });
});

describe("sample review run reads", () => {
  it("returns bounded summaries and resolves the corresponding full details", async () => {
    const adapter = makeAdapter();
    const list = await adapter.list(repositoryId);
    expectSchema(DashboardReviewRunListResponseSchema, list);
    expect(list.total).toBe(
      sampleReviewRuns.filter((run) => run.repositoryId === repositoryId).length,
    );
    expect(list).toMatchObject({ page: 1, pageSize: 20 });
    for (const summary of list.items) {
      expect(summary.repositoryId).toBe(repositoryId);
      expect(summary).not.toHaveProperty("requests");
      expect(summary).not.toHaveProperty("policy");
      const detail = await adapter.get(repositoryId, summary.id);
      expectSchema(DashboardReviewRunDetailSchema, detail);
      expect(detail).toMatchObject(summary);
    }
  });

  it("filters by work item within its repository and allows known work items without runs", async () => {
    const adapter = makeAdapter();
    const run = sampleRun();
    const list = await adapter.list(repositoryId, { workItemId: run.workItemId });
    expectSchema(DashboardReviewRunListResponseSchema, list);
    expect(list.items.length).toBeGreaterThan(0);
    expect(
      list.items.every(
        (item) => item.repositoryId === repositoryId && item.workItemId === run.workItemId,
      ),
    ).toBe(true);
    expect(
      await adapter.list(otherRepositoryId, { workItemId: "wi-terminal-pr-21042" }),
    ).toMatchObject({
      items: [],
      total: 0,
    });
    await expectHttp(adapter.list(otherRepositoryId, { workItemId: run.workItemId }), 404);
    await expectHttp(adapter.list(repositoryId, { workItemId: "wi-terminal-pr-21042" }), 404);
    await expectHttp(adapter.list(repositoryId, { workItemId: "unknown-work-item" }), 404);
  });

  it("paginates run history without dropping the total or repeating records", async () => {
    const adapter = makeAdapter(true);
    const run = sampleRun();
    for (let index = 0; index < 3; index += 1) {
      await adapter.create(repositoryId, run.workItemId, createRequest(`sample-page-${index}`));
    }
    const pages = await Promise.all(
      [1, 2, 3, 4].map((page) =>
        adapter.list(repositoryId, {
          workItemId: run.workItemId,
          page,
          pageSize: 1,
        }),
      ),
    );
    for (const [index, page] of pages.entries()) {
      expectSchema(DashboardReviewRunListResponseSchema, page);
      expect(page).toMatchObject({ page: index + 1, pageSize: 1, total: 3 });
    }
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size).toBe(3);
    expect(pages[3]?.items).toEqual([]);
    const maximum = await adapter.list(repositoryId, { pageSize: 50 });
    expectSchema(DashboardReviewRunListResponseSchema, maximum);
    expect(maximum.pageSize).toBe(50);
  });

  it("reads the exact request's jobs and full worker report", async () => {
    const adapter = makeAdapter();
    for (const fixture of sampleReviewRunResults) {
      const jobs = await adapter.listJobs(
        fixture.repositoryId,
        fixture.reviewRunId,
        fixture.requestId,
      );
      expectSchema(DashboardReviewRunJobListResponseSchema, jobs);
      expect(jobs.items.some((job) => job.jobId === fixture.jobId)).toBe(true);
      const result = await adapter.getResult(
        fixture.repositoryId,
        fixture.reviewRunId,
        fixture.requestId,
        fixture.jobId,
      );
      expectSchema(DashboardReviewRunResultSchema, result);
      expect(result).toEqual(fixture);
      const pastEnd = await adapter.listJobs(
        fixture.repositoryId,
        fixture.reviewRunId,
        fixture.requestId,
        {
          page: jobs.total + 1,
          pageSize: 1,
        },
      );
      expectSchema(DashboardReviewRunJobListResponseSchema, pastEnd);
      expect(pastEnd).toMatchObject({ items: [], total: jobs.total, pageSize: 1 });
    }
  });

  it("returns an empty job list for blocked coverage without inventing a result", async () => {
    const adapter = makeAdapter();
    const run = sampleRun();
    const blocked = run.requests.find((request) => request.readiness === "blocked");
    if (!blocked) throw new Error("The sample PR must include blocked coverage.");
    const list = await adapter.listJobs(repositoryId, run.id, blocked.requestId);
    expectSchema(DashboardReviewRunJobListResponseSchema, list);
    expect(list).toMatchObject({ items: [], total: 0 });
    await expectHttp(
      adapter.getResult(repositoryId, run.id, blocked.requestId, "unknown-job"),
      404,
    );
  });

  it("rejects unknown repositories and every cross-scope run, request and job association", async () => {
    const adapter = makeAdapter();
    const { run, request, job } = sampleJob();
    const issue = sampleRun("wi-issue-41876");
    const issueRequest = issue.requests.find((candidate) => candidate.latestJob !== null);
    if (!issueRequest?.latestJob)
      throw new Error("The sample Issue must include an executed request.");
    const requests = [
      adapter.list("unknown-repository"),
      adapter.get("unknown-repository", run.id),
      adapter.get(otherRepositoryId, run.id),
      adapter.get(repositoryId, "unknown-run"),
      adapter.listJobs(otherRepositoryId, run.id, request.requestId),
      adapter.listJobs(repositoryId, "unknown-run", request.requestId),
      adapter.listJobs(repositoryId, run.id, "unknown-request"),
      adapter.listJobs(repositoryId, run.id, issueRequest.requestId),
      adapter.getResult(otherRepositoryId, run.id, request.requestId, job.jobId),
      adapter.getResult(repositoryId, "unknown-run", request.requestId, job.jobId),
      adapter.getResult(repositoryId, run.id, "unknown-request", job.jobId),
      adapter.getResult(repositoryId, run.id, issueRequest.requestId, issueRequest.latestJob.jobId),
      adapter.getResult(repositoryId, run.id, request.requestId, issueRequest.latestJob.jobId),
      adapter.getResult(repositoryId, run.id, request.requestId, "unknown-job"),
    ];
    await Promise.all(requests.map((requestPromise) => expectHttp(requestPromise, 404)));
  });

  it("isolates adapter instances and protects stored details and results from caller mutation", async () => {
    const adapter = makeAdapter();
    const { run, request, job } = sampleJob();
    const original = structuredClone(run);
    const detail = await adapter.get(repositoryId, run.id);
    detail.title = "Changed by a caller";
    detail.requests.length = 0;
    const list = await adapter.list(repositoryId);
    const summary = list.items.find((item) => item.id === run.id);
    if (!summary) throw new Error("Missing sample summary.");
    summary.execution.succeeded = 99;
    const jobs = await adapter.listJobs(repositoryId, run.id, request.requestId);
    const firstJob = jobs.items[0];
    if (!firstJob) throw new Error("Missing sample job.");
    firstJob.status = "cancelled";
    const result = await adapter.getResult(repositoryId, run.id, request.requestId, job.jobId);
    if (!result) throw new Error("Missing sample report.");
    result.report.checks.length = 0;
    expect(await adapter.get(repositoryId, run.id)).toEqual(original);
    expect(await makeAdapter().get(repositoryId, run.id)).toEqual(original);
    expect(await adapter.getResult(repositoryId, run.id, request.requestId, job.jobId)).toEqual(
      sampleReviewRunResults.find((fixture) => fixture.jobId === job.jobId),
    );
    expect((await adapter.listJobs(repositoryId, run.id, request.requestId)).items[0]?.status).toBe(
      job.status,
    );
    expect(sampleRun()).toEqual(original);
    expect((await makeAdapter(true).list(repositoryId)).total).toBe(0);
  });
});

describe("sample review run creation", () => {
  it.each(["wi-pr-41982", "wi-issue-41876"])(
    "freezes a valid blocked plan for %s without simulating execution",
    async (workItemId) => {
      const adapter = makeAdapter(true);
      const sample = sampleRun(workItemId);
      const input = createRequest("sample-create", sample);
      expectSchema(OperatorReviewRunCreateRequestSchema, input);
      const created = await adapter.create(repositoryId, workItemId, input);
      expectSchema(DashboardReviewRunDetailSchema, created);
      expect(created).toMatchObject({
        repositoryId,
        workItemId,
        activationId: input.activationId,
        revisionKey: input.expectedRevisionKey,
        currentRevisionKey: input.expectedRevisionKey,
        freshness: "current",
        createdAt: timestamp,
      });
      expect(created.id).not.toBe(sample.id);
      expect(created.requestCount).toBe(created.requests.length);
      expect(created.execution).toEqual({
        missing: created.requestCount,
        awaitingAdmission: 0,
        queued: 0,
        active: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });
      for (const request of created.requests) {
        expect(request).toMatchObject({
          readiness: "blocked",
          latestJob: null,
          latestResult: null,
        });
        expect(request.blockers).toContain(
          "Sample preview only: execution creation is disabled, so this plan has no job or result.",
        );
        expect(await adapter.listJobs(repositoryId, created.id, request.requestId)).toMatchObject({
          items: [],
          total: 0,
        });
      }
      expect(created.policy).toMatchObject(
        workItemId === "wi-pr-41982"
          ? { applicable: true, eligible: false }
          : { applicable: false, eligible: null },
      );
      expect(await adapter.get(repositoryId, created.id)).toEqual(created);
      expect((await adapter.list(repositoryId, { workItemId })).total).toBe(1);
      expect((await makeAdapter(true).list(repositoryId)).total).toBe(0);
    },
  );

  it("replays an activation idempotently after normalizing profile selection order", async () => {
    const configuration = makeConfiguration();
    const adapter = makeAdapter(true, configuration);
    const run = sampleRun();
    const ids = (await configuration.listProfiles(repositoryId)).items
      .filter((profile) => profile.workflowKind.startsWith("pr_"))
      .map((profile) => profile.profileId);
    const replayIds = [...ids].reverse();
    expect(ids.length).toBeGreaterThan(1);
    const input = { ...createRequest(), profileIds: ids };
    const first = await adapter.create(repositoryId, run.workItemId, input);
    const replay = await adapter.create(repositoryId, run.workItemId, {
      ...input,
      profileIds: [...ids].reverse(),
    });
    expect(replay).toEqual(first);
    expect((await adapter.list(repositoryId, { workItemId: run.workItemId })).total).toBe(1);
    input.profileIds.length = 0;
    first.requests.length = 0;
    const afterMutation = await adapter.create(repositoryId, run.workItemId, {
      ...createRequest(),
      profileIds: replayIds,
    });
    expect(afterMutation.requests.length).toBeGreaterThan(0);
    expect(afterMutation).toEqual(replay);
  });

  it("does not duplicate a concurrently replayed activation", async () => {
    const adapter = makeAdapter(true);
    const run = sampleRun();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        adapter.create(repositoryId, run.workItemId, createRequest("sample-concurrent")),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await adapter.list(repositoryId, { workItemId: run.workItemId })).total).toBe(1);
  });

  it("retains required profiles when the caller selects only part of the plan", async () => {
    const configuration = makeConfiguration();
    const adapter = makeAdapter(true, configuration);
    const run = sampleRun();
    const profiles = (await configuration.listProfiles(repositoryId)).items.filter((profile) =>
      profile.workflowKind.startsWith("pr_"),
    );
    const requiredIds = profiles
      .filter((profile) => profile.required)
      .map((profile) => profile.profileId);
    const selectedId = profiles.find((profile) => profile.profileId !== requiredIds[0])?.profileId;
    if (!requiredIds[0] || !selectedId) throw new Error("The sample requires multiple profiles.");
    const created = await adapter.create(repositoryId, run.workItemId, {
      ...createRequest(),
      profileIds: [selectedId],
    });
    expectSchema(DashboardReviewRunDetailSchema, created);
    expect(profileIds(created).sort()).toEqual([...new Set([...requiredIds, selectedId])].sort());
  });

  it.each([40, 64])(
    "records an explicit %i-character Issue source commit without claiming execution",
    async (length) => {
      const adapter = makeAdapter(true);
      const issue = sampleRun("wi-issue-41876");
      const unspecified = await adapter.create(
        repositoryId,
        issue.workItemId,
        createRequest("sample-no-source", issue),
      );
      expect(unspecified.testedSourceRevision).toBeNull();
      const commit = "c".repeat(length);
      const explicit = await adapter.create(repositoryId, issue.workItemId, {
        ...createRequest("sample-exact-source", issue),
        testedSourceCommit: commit,
      });
      expectSchema(DashboardReviewRunDetailSchema, explicit);
      expect(explicit.testedSourceRevision).toEqual({ kind: "commit", headSha: commit });
      expect(
        explicit.requests.every(
          (request) => request.latestJob === null && request.latestResult === null,
        ),
      ).toBe(true);
      expect(explicit.policy).toMatchObject({ applicable: false, eligible: null });
    },
  );

  it("rejects source commit overrides for a newly created PR run", async () => {
    const adapter = makeAdapter(true);
    await expectHttp(
      adapter.create(repositoryId, sampleRun().workItemId, {
        ...createRequest(),
        testedSourceCommit: "c".repeat(40),
      }),
      400,
    );
    expect((await adapter.list(repositoryId)).total).toBe(0);
  });

  it("rejects activation payload changes and stale revisions without creating extra runs", async () => {
    const adapter = makeAdapter(true);
    const run = sampleRun();
    const input = createRequest();
    const first = await adapter.create(repositoryId, run.workItemId, input);
    await expectHttp(
      adapter.create(repositoryId, run.workItemId, {
        ...input,
        testedSourceCommit: "a".repeat(40),
      }),
      409,
    );
    const staleRevision =
      run.currentRevisionKey === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    await expectHttp(
      adapter.create(repositoryId, run.workItemId, {
        activationId: "sample-stale-revision",
        expectedRevisionKey: staleRevision,
      }),
      409,
    );
    expect(await adapter.get(repositoryId, first.id)).toEqual(first);
    expect((await adapter.list(repositoryId)).total).toBe(1);
  });

  it("scopes activation IDs to a work item and never borrows another repository's plan", async () => {
    const adapter = makeAdapter(true);
    const pr = sampleRun();
    const issue = sampleRun("wi-issue-41876");
    const activationId = "sample-shared-activation";
    const prRun = await adapter.create(
      repositoryId,
      pr.workItemId,
      createRequest(activationId, pr),
    );
    const issueRun = await adapter.create(
      repositoryId,
      issue.workItemId,
      createRequest(activationId, issue),
    );
    expect(prRun.id).not.toBe(issueRun.id);
    expect((await adapter.list(repositoryId)).total).toBe(2);
    await expectHttp(adapter.create(otherRepositoryId, pr.workItemId, createRequest()), 404);
    await expectHttp(adapter.create(repositoryId, "unknown-work-item", createRequest()), 404);
    await expectHttp(adapter.create("unknown-repository", pr.workItemId, createRequest()), 404);
    const terminalItem = workItems.find((item) => item.id === "wi-terminal-pr-21042");
    if (!terminalItem) throw new Error("Missing terminal sample work item.");
    await expectHttp(
      adapter.create(otherRepositoryId, terminalItem.id, {
        activationId: "sample-missing-plan",
        expectedRevisionKey: terminalItem.revisionKey,
      }),
      409,
    );
    expect((await adapter.list(otherRepositoryId)).total).toBe(0);
  });

  it("rejects profile selections from a different workflow instead of substituting profiles", async () => {
    const configuration = makeConfiguration();
    const adapter = makeAdapter(true, configuration);
    const run = sampleRun();
    const issueProfiles = (await configuration.listProfiles(repositoryId)).items
      .filter((profile) => profile.workflowKind.startsWith("issue_"))
      .map((profile) => profile.profileId);
    expect(issueProfiles.length).toBeGreaterThan(0);
    await expectHttp(
      adapter.create(repositoryId, run.workItemId, {
        ...createRequest(),
        profileIds: issueProfiles,
      }),
      400,
    );
    expect((await adapter.list(repositoryId)).total).toBe(0);
  });

  it("uses the shared configuration's published bindings and preserves already frozen runs", async () => {
    const configuration = makeConfiguration();
    const adapter = makeAdapter(true, configuration);
    const run = sampleRun();
    const initial = await adapter.create(
      repositoryId,
      run.workItemId,
      createRequest("sample-before-settings"),
    );
    const binding = (await configuration.listProfileBindings(repositoryId)).items.find((item) =>
      initial.requests.some(
        (request) =>
          request.workflowKind === "pr_static_build" &&
          request.profile?.profileId === item.profileId,
      ),
    );
    if (!binding) throw new Error("Missing configured build profile binding.");
    const originalProfile = await configuration.getProfileVersion(
      repositoryId,
      binding.profileId,
      binding.profileVersionId,
    );
    const nextProfile = await configuration.publishProfile(repositoryId, {
      profileId: originalProfile.profileId,
      expectedVersion: originalProfile.version,
      workflowKind: originalProfile.workflowKind,
      target: originalProfile.target,
      outputSchemaVersion: originalProfile.outputSchemaVersion,
      required: originalProfile.required,
      name: "Sample revised build profile",
      config: {
        ...originalProfile.config,
        hardTimeoutMs: originalProfile.config.hardTimeoutMs + 1_000,
      },
    } as ValidationProfileCreateRequest);
    await configuration.saveProfileBinding(repositoryId, binding.profileId, {
      expectedVersion: binding.version,
      profileVersionId: nextProfile.id,
      enabled: true,
    });
    const template = await configuration.createPrompt({
      name: "Sample repository review override",
      workflowKind: "pr_static_build",
      content: "Sample replacement instructions. These instructions have not been executed.",
      outputSchemaVersion: "PrReviewPlanV2",
    });
    const prompt = await configuration.publishPrompt(template.id, {
      expectedVersion: template.version,
    });
    await configuration.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 0,
      promptVersionId: prompt.id,
    });
    const updated = await adapter.create(
      repositoryId,
      run.workItemId,
      createRequest("sample-after-settings"),
    );
    expectSchema(DashboardReviewRunDetailSchema, updated);
    expect(
      updated.requests.find((request) => request.workflowKind === "pr_static_build"),
    ).toMatchObject({
      profile: {
        id: nextProfile.id,
        profileId: nextProfile.profileId,
        version: nextProfile.version,
        name: nextProfile.name,
        configSha256: nextProfile.configSha256,
      },
      prompt: {
        id: prompt.id,
        templateId: prompt.templateId,
        version: prompt.version,
        contentSha256: prompt.contentSha256,
      },
      latestJob: null,
      latestResult: null,
    });
    expect(await adapter.get(repositoryId, initial.id)).toEqual(initial);
    expect(
      await adapter.create(repositoryId, run.workItemId, createRequest("sample-before-settings")),
    ).toEqual(initial);
    expect(updated.planDigest).not.toBe(initial.planDigest);

    const bindings = (await configuration.listProfileBindings(repositoryId)).items;
    for (const activeBinding of bindings) {
      await configuration.saveProfileBinding(repositoryId, activeBinding.profileId, {
        expectedVersion: activeBinding.version,
        profileVersionId: activeBinding.profileVersionId,
        enabled: false,
      });
    }
    await expectHttp(
      adapter.create(repositoryId, run.workItemId, createRequest("sample-disabled-settings")),
      409,
    );
    expect((await adapter.list(repositoryId)).total).toBe(2);
    expect(await adapter.get(repositoryId, updated.id)).toEqual(updated);
  });
});

describe("sample review run policy boundaries", () => {
  it.each([
    { reasonCount: 127, checksPerProfile: [63, 62] },
    { reasonCount: 128, checksPerProfile: [63, 63] },
    { reasonCount: 129, checksPerProfile: [64, 63] },
    { reasonCount: 195, checksPerProfile: [64, 64, 64] },
  ])(
    "bounds $reasonCount policy reasons while preserving totals across stale reads",
    async ({ reasonCount, checksPerProfile }) => {
      const configuration = await policyConfiguration(checksPerProfile);
      const adapter = makeAdapter(true, configuration);
      const input = createRequest(`sample-policy-boundary-${reasonCount}`);
      const workItemId = sampleRun().workItemId;
      const item = workItems.find((candidate) => candidate.id === workItemId);
      if (!item) throw new Error("Missing policy boundary work item.");
      const originalRevisionKey = item.revisionKey;
      const created = await adapter.create(repositoryId, workItemId, input);
      const checkCount = checksPerProfile.reduce((total, count) => total + count, 0);
      expectSchema(DashboardReviewRunDetailSchema, created);
      expect(created.requiredCheckIds).toHaveLength(checkCount);
      expect(created.requests).toHaveLength(checksPerProfile.length);
      expect(
        created.requests.every(
          (request) =>
            request.required && request.latestJob === null && request.latestResult === null,
        ),
      ).toBe(true);
      expect(created.policy).toMatchObject({
        applicable: true,
        eligible: false,
        reasonCount,
        reasonsTruncated: reasonCount > maximumDashboardReviewRunPolicyReasonCount,
      });
      expect(created.policy.reasons).toHaveLength(
        Math.min(reasonCount, maximumDashboardReviewRunPolicyReasonCount),
      );
      expect(
        created.policy.reasons.every(
          (reason) =>
            reason.code === "required_request_blocked" || reason.code === "missing_required_check",
        ),
      ).toBe(true);
      const staleRevision =
        originalRevisionKey === "d".repeat(64) ? "e".repeat(64) : "d".repeat(64);
      try {
        item.revisionKey = staleRevision;
        for (let index = 0; index < 3; index += 1) {
          const stale = await adapter.get(repositoryId, created.id);
          expectSchema(DashboardReviewRunDetailSchema, stale);
          expect(stale).toMatchObject({
            revisionKey: originalRevisionKey,
            currentRevisionKey: staleRevision,
            freshness: "superseded",
            planDigest: created.planDigest,
            policy: {
              applicable: true,
              eligible: false,
              reasonCount: reasonCount + 1,
              reasonsTruncated: reasonCount + 1 > maximumDashboardReviewRunPolicyReasonCount,
            },
          });
          expect(stale.requiredCheckIds).toEqual(created.requiredCheckIds);
          expect(stale.requests).toEqual(created.requests);
          expect(stale.policy.reasons).toHaveLength(
            Math.min(reasonCount + 1, maximumDashboardReviewRunPolicyReasonCount),
          );
          expect(
            stale.policy.reasons.filter((reason) => reason.code === "stale_revision"),
          ).toHaveLength(reasonCount < maximumDashboardReviewRunPolicyReasonCount ? 1 : 0);
          const list = await adapter.list(repositoryId, { workItemId });
          expectSchema(DashboardReviewRunListResponseSchema, list);
          expect(list).toMatchObject({
            total: 1,
            items: [
              {
                id: created.id,
                revisionKey: originalRevisionKey,
                currentRevisionKey: staleRevision,
                freshness: "superseded",
              },
            ],
          });
          const replay = await adapter.create(repositoryId, workItemId, input);
          expectSchema(DashboardReviewRunDetailSchema, replay);
          expect(replay).toEqual(stale);
          expect(created.policy.reasonCount).toBe(reasonCount);
        }
      } finally {
        item.revisionKey = originalRevisionKey;
      }
      expect(await adapter.get(repositoryId, created.id)).toEqual(created);
      expect(await adapter.create(repositoryId, workItemId, input)).toEqual(created);
      expect((await adapter.list(repositoryId, { workItemId })).items).toMatchObject([
        { id: created.id, freshness: "current", currentRevisionKey: originalRevisionKey },
      ]);
    },
  );
});

describe("sample review run request boundaries", () => {
  it.each([
    "",
    " leading-space",
    "trailing-space ",
    "../run",
    "repo/name",
    "id?query=1",
    "x".repeat(129),
  ])("rejects invalid entity IDs at every route level: %j", async (invalidId) => {
    const adapter = makeAdapter();
    const { run, request, job } = sampleJob();
    await Promise.all(
      [
        adapter.list(invalidId),
        adapter.list(repositoryId, { workItemId: invalidId }),
        adapter.get(invalidId, run.id),
        adapter.get(repositoryId, invalidId),
        adapter.listJobs(invalidId, run.id, request.requestId),
        adapter.listJobs(repositoryId, invalidId, request.requestId),
        adapter.listJobs(repositoryId, run.id, invalidId),
        adapter.getResult(invalidId, run.id, request.requestId, job.jobId),
        adapter.getResult(repositoryId, invalidId, request.requestId, job.jobId),
        adapter.getResult(repositoryId, run.id, invalidId, job.jobId),
        adapter.getResult(repositoryId, run.id, request.requestId, invalidId),
        adapter.create(invalidId, run.workItemId, createRequest()),
        adapter.create(repositoryId, invalidId, createRequest()),
      ].map(expectInvalid),
    );
  });

  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: Number.NaN },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { page: "1" },
    { pageSize: 0 },
    { pageSize: -1 },
    { pageSize: 1.5 },
    { pageSize: 51 },
    { pageSize: Number.POSITIVE_INFINITY },
    { pageSize: "20" },
    { pageSize: null },
    { repositoryId: otherRepositoryId },
    { unexpected: true },
  ])("rejects invalid or scope-overriding pagination %j", async (query) => {
    const adapter = makeAdapter();
    const { run, request } = sampleJob();
    await expectInvalid(adapter.list(repositoryId, query as unknown as ReviewRunListQuery));
    await expectInvalid(
      adapter.listJobs(
        repositoryId,
        run.id,
        request.requestId,
        query as unknown as ReviewRunPageQuery,
      ),
    );
  });

  it.each([
    null,
    [],
    {},
    { activationId: "", expectedRevisionKey: "a".repeat(64) },
    { activationId: "../activation", expectedRevisionKey: "a".repeat(64) },
    { activationId: "sample-invalid", expectedRevisionKey: "a".repeat(40) },
    { activationId: "sample-invalid", expectedRevisionKey: "A".repeat(64) },
    { ...createRequest(), extra: true },
    { ...createRequest(), profileIds: [] },
    { ...createRequest(), profileIds: ["profile-1", "profile-1"] },
    { ...createRequest(), profileIds: ["../profile"] },
    {
      ...createRequest(),
      profileIds: Array.from({ length: 33 }, (_, index) => `profile-${index}`),
    },
    { ...createRequest(), testedSourceCommit: "a".repeat(41) },
    { ...createRequest(), testedSourceCommit: "A".repeat(40) },
    { ...createRequest(), testedSourceCommit: "not-a-commit" },
  ])("rejects malformed creation payloads without mutating history: %j", async (input) => {
    const adapter = makeAdapter(true);
    await expectInvalid(
      adapter.create(
        repositoryId,
        sampleRun().workItemId,
        input as unknown as OperatorReviewRunCreateRequest,
      ),
    );
    expect((await adapter.list(repositoryId)).total).toBe(0);
  });
});
