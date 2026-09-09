import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunResult,
  DashboardReviewRunSummary,
  OperatorReviewRunCreateRequest,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "../review-control/http-client";
import type { ReviewRunListQuery, ReviewRunPageQuery } from "./adapter";
import { sampleReviewRunResults, sampleReviewRuns } from "./fixtures";
import { HttpReviewRunAdapter } from "./http-adapter";

const repositoryId = "repo-powertoys";
const runId = "review-run-1";
const workItemId = "work-item-41982";
const requestId = "request-ui";
const jobId = "job-ui";
const digest = "a".repeat(64);
const timestamp = "2026-09-07T02:00:00.000Z";
const checkId = "profile-version-1:open-settings";
const repositoryPath = `/api/v1/operator/repositories/${repositoryId}`;
const listPath = `${repositoryPath}/review-runs`;
const runPath = `${listPath}/${runId}`;
const jobsPath = `${runPath}/requests/${requestId}/jobs`;
const resultPath = `${jobsPath}/${jobId}/result`;
const createPath = `${repositoryPath}/work-items/${workItemId}/review-runs`;
const pagination = "?page=1&pageSize=20";

const summary: DashboardReviewRunSummary = {
  id: runId,
  repositoryId,
  repository: "microsoft/PowerToys",
  workItemId,
  workItemKind: "pull_request",
  number: 41982,
  title: "Validate the settings dialog",
  revisionKey: digest,
  currentRevisionKey: digest,
  freshness: "current",
  planDigest: digest,
  activationId: "activation-1",
  createdAt: timestamp,
  requestCount: 1,
  requiredRequestCount: 1,
  execution: {
    missing: 0,
    awaitingAdmission: 0,
    queued: 0,
    active: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
  },
};
const job: DashboardReviewRunJob = {
  jobId,
  activationNumber: 1,
  status: "succeeded",
  admission: null,
  phase: null,
  attemptCount: 1,
  runAttemptId: "attempt-1",
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  failureCode: null,
  failureMessage: null,
  resultId: "result-1",
  resultDigest: digest,
};
const detail: DashboardReviewRunDetail = {
  ...summary,
  workItemKind: "pull_request",
  requestEpochId: "epoch-1",
  testedSourceRevision: {
    kind: "pull_request",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
  requiredCheckIds: [checkId],
  requests: [
    {
      requestId,
      workflowKind: "pr_ui",
      target: "web",
      required: true,
      profile: {
        id: "profile-version-1",
        profileId: "profile-ui",
        name: "Settings UI",
        version: 1,
        configSha256: digest,
      },
      prompt: {
        id: "prompt-version-1",
        templateId: "prompt-ui",
        version: 1,
        contentSha256: digest,
      },
      requiredCheckIds: [checkId],
      readiness: "ready",
      blockers: [],
      blockersTruncated: false,
      latestJob: job,
      latestResult: {
        id: "result-1",
        resultDigest: digest,
        createdAt: timestamp,
        summary: "The required UI check failed.",
        summaryTruncated: false,
        sourceState: "original",
        checks: { passed: 0, failed: 1, blocked: 0, not_run: 0, skipped: 0, inconclusive: 0 },
        modelReviewState: "completed",
        recommendation: "approve",
        reproductionConclusion: null,
        findings: [],
        findingCount: 0,
        findingsTruncated: false,
        evidenceIds: [],
        evidenceCount: 0,
        evidenceTruncated: false,
        evidenceComplete: true,
        lifecycleBlockerCount: 0,
      },
    },
  ],
  policy: {
    applicable: true,
    eligible: false,
    policyVersion: "required-checks-and-p0-p1-v1",
    reasons: [
      {
        code: "REQUIRED_CHECK_FAILED",
        requestId,
        checkId,
        outcome: "failed",
        reason: "The settings dialog did not open.",
      },
    ],
    reasonCount: 1,
    reasonsTruncated: false,
    blockingFindingCount: 0,
  },
};
const result: DashboardReviewRunResult = {
  id: "result-1",
  repositoryId,
  reviewRunId: runId,
  workItemId,
  requestId,
  jobId,
  runAttemptId: "attempt-1",
  activationNumber: 1,
  authoritative: true,
  revisionKey: digest,
  planDigest: digest,
  profileVersionId: "profile-version-1",
  promptVersionId: "prompt-version-1",
  resultDigest: digest,
  createdAt: timestamp,
  evidenceComplete: true,
  report: {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "pull_request",
    summary: "The required UI check failed.",
    sourceState: "original",
    checks: [
      {
        id: checkId,
        name: "Open settings",
        kind: "ui",
        required: true,
        outcome: "failed",
        summary: "The settings dialog did not open.",
        expected: "The settings dialog is visible.",
        actual: "The settings dialog is absent.",
        evidenceIds: [],
        source: "runner",
      },
    ],
  },
  execution: { blockers: [], diagnostics: [], cleanupState: "completed" },
  modelReview: {
    execution: null,
    state: "completed",
    summary: "No additional code concerns were identified.",
    recommendation: "approve",
    findings: [],
    observations: [],
    issueTriage: null,
    reproductionConclusion: null,
    error: null,
  },
};
const createRequest: OperatorReviewRunCreateRequest = {
  activationId: summary.activationId,
  expectedRevisionKey: digest,
  profileIds: ["profile-ui"],
};

const pageOf = <T>(item: T) => ({ items: [item], total: 1, page: 1, pageSize: 20 });
const jobPage = () => ({ repositoryId, reviewRunId: runId, requestId, ...pageOf(job) });
const requireFixture = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("The run fixture is incomplete.");
  return value;
};
const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
const adapterWith = (...responses: unknown[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response instanceof Response ? response : jsonResponse(response));
  }
  return { fetch, adapter: new HttpReviewRunAdapter({ fetch }) };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("review run execution actions", () => {
  const rerunResponse = {
    repositoryId,
    reviewRunId: runId,
    requestId,
    jobId: "job-rerun",
    jobActivation: 2,
    replayed: false,
  };
  const cancelResponse = {
    repositoryId,
    reviewRunId: runId,
    requestId,
    jobId,
    jobState: "cancel_requested",
    changed: true,
  };

  it("queues only the selected profile and preserves the caller's retry identity", async () => {
    const { adapter, fetch } = adapterWith(jsonResponse(rerunResponse, 201), {
      ...rerunResponse,
      replayed: true,
    });
    const input = { activationId: "operator-intent-one" };
    await expect(adapter.rerun(repositoryId, runId, requestId, input)).resolves.toEqual(
      rerunResponse,
    );
    await expect(adapter.rerun(repositoryId, runId, requestId, input)).resolves.toMatchObject({
      replayed: true,
    });
    for (const [path, init] of fetch.mock.calls) {
      expect(path).toBe(`${runPath}/requests/${requestId}/reruns`);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "include",
        redirect: "error",
        body: JSON.stringify(input),
      });
    }
  });

  it("cancels the exact job without supplying actor or scope in the body", async () => {
    const { adapter, fetch } = adapterWith(jsonResponse(cancelResponse, 202));
    await expect(adapter.cancel(repositoryId, runId, requestId, jobId)).resolves.toEqual(
      cancelResponse,
    );
    expect(fetch).toHaveBeenCalledWith(
      `${jobsPath}/${jobId}/cancel`,
      expect.objectContaining({ body: "{}", method: "POST", credentials: "include" }),
    );
  });

  it.each(["repositoryId", "reviewRunId", "requestId", "jobId"])(
    "rejects a cancellation response with another %s",
    async (field) => {
      const { adapter } = adapterWith({ ...cancelResponse, [field]: "other-scope" });
      await expect(adapter.cancel(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it("rejects impossible action states and caller-injected authority", async () => {
    const { adapter, fetch } = adapterWith({ ...cancelResponse, jobState: "running" });
    await expect(adapter.cancel(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(
      adapter.rerun(repositoryId, runId, requestId, {
        activationId: "intent",
        actor: "admin",
      } as unknown as Parameters<HttpReviewRunAdapter["rerun"]>[3]),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves readiness conflicts and authorization failures for the operator", async () => {
    for (const status of [403, 409]) {
      const { adapter } = adapterWith(
        jsonResponse(
          { code: "platform_conflict", message: "Refresh current authorization and readiness." },
          status,
        ),
      );
      await expect(
        adapter.rerun(repositoryId, runId, requestId, { activationId: "same-intent" }),
      ).rejects.toMatchObject({ status });
    }
  });

  it("never sends action requests outside the selected scope", async () => {
    const { adapter, fetch } = adapterWith();
    await expect(adapter.cancel(repositoryId, runId, "../other", jobId)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.rerun(repositoryId, "run-one\n", requestId, { activationId: "intent" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("review run HTTP routes", () => {
  it("lists only the selected repository and serializes work-item pagination", async () => {
    const page = { ...pageOf(summary), page: 2, pageSize: 1, total: 2 };
    const { adapter, fetch } = adapterWith(page);
    await expect(adapter.list(repositoryId, { page: 2, pageSize: 1, workItemId })).resolves.toEqual(
      page,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${listPath}?page=2&pageSize=1&workItemId=${workItemId}`,
      {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("creates a run with a frozen revision under the selected work item", async () => {
    const { adapter, fetch } = adapterWith(jsonResponse(detail, 201));
    await expect(adapter.create(repositoryId, workItemId, createRequest)).resolves.toEqual(detail);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      createPath,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(createRequest),
        credentials: "include",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }),
    );
  });

  it("loads bounded detail without eagerly fetching result bodies", async () => {
    const { adapter, fetch } = adapterWith(detail);
    await expect(adapter.get(repositoryId, runId)).resolves.toEqual(detail);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      runPath,
      expect.objectContaining({ method: "GET" }),
    );
    expect(detail.requests[0]?.latestResult).not.toHaveProperty("report");
    expect(detail.requests[0]?.latestResult).not.toHaveProperty("execution");
  });

  it("anchors job history to the request in the selected run", async () => {
    const { adapter, fetch } = adapterWith(jobPage());
    await expect(adapter.listJobs(repositoryId, runId, requestId)).resolves.toEqual(jobPage());
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${jobsPath}${pagination}`, expect.anything());
  });

  it("loads a single exact job without scanning activation pages", async () => {
    const page = { ...jobPage(), pageSize: 1 };
    const { adapter, fetch } = adapterWith(page);
    await expect(
      adapter.listJobs(repositoryId, runId, requestId, { page: 1, pageSize: 1, jobId }),
    ).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${jobsPath}?page=1&pageSize=1&jobId=${jobId}`,
      expect.anything(),
    );
  });

  it("does not accept another job as an exact filtered result", async () => {
    const { adapter } = adapterWith(jobPage());
    await expect(
      adapter.listJobs(repositoryId, runId, requestId, { jobId: "another-job" }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("keeps an absent exact job empty", async () => {
    const page = { ...jobPage(), items: [], total: 0 };
    const { adapter } = adapterWith(page);
    await expect(
      adapter.listJobs(repositoryId, runId, requestId, { jobId: "missing-job" }),
    ).resolves.toEqual(page);
  });

  it.each(["", "../job", "job\n", "x".repeat(129)])(
    "rejects an unsafe exact job filter %j before network access",
    async (unsafe) => {
      const { adapter, fetch } = adapterWith();
      await expect(
        adapter.listJobs(repositoryId, runId, requestId, { jobId: unsafe }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("fetches the exact result while preserving execution, checks, and model dimensions", async () => {
    const { adapter, fetch } = adapterWith(detail, result);
    const received = await adapter.getResult(repositoryId, runId, requestId, jobId);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([runPath, resultPath]);
    expect(received).toEqual(result);
    expect(detail.requests[0]?.latestJob?.status).toBe("succeeded");
    expect(received?.report.checks[0]?.outcome).toBe("failed");
    expect(received?.modelReview.recommendation).toBe("approve");
    expect(detail.policy.eligible).toBe(false);
  });
});

describe("review run request boundaries", () => {
  it.each(["", "../other", "repo%2Fother", "repo\\other", "repo\n", "a".repeat(129)])(
    "rejects an unsafe repository ID before network access: %j",
    async (unsafeId) => {
      const { adapter, fetch } = adapterWith();
      await expect(adapter.list(unsafeId)).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.get(unsafeId, runId)).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.create(unsafeId, workItemId, createRequest)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("validates every nested identity before fetching the run", async () => {
    const { adapter, fetch } = adapterWith();
    await expect(adapter.get(repositoryId, "../other")).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.listJobs(repositoryId, runId, "../other")).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.getResult(repositoryId, runId, requestId, "job\n")).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.create(repositoryId, "../other", createRequest)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0 },
    { pageSize: 51 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { page: "1" },
    { repositoryId: "repo-other" },
    { status: "succeeded" },
  ])("rejects noncanonical or unknown pagination fields: %j", async (query) => {
    const { adapter, fetch } = adapterWith();
    await expect(adapter.list(repositoryId, query as ReviewRunListQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.listJobs(repositoryId, runId, requestId, query as ReviewRunPageQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...createRequest, authorization: { basis: "allowlist" } },
    { ...createRequest, expectedRevisionKey: "latest" },
    { ...createRequest, profileIds: ["profile-ui", "profile-ui"] },
    { ...createRequest, testedSourceCommit: "main" },
  ])("rejects malformed or client-injected authorization in create: %j", async (input) => {
    const { adapter, fetch } = adapterWith();
    await expect(adapter.create(repositoryId, workItemId, input)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    `${listPath}?page=1&pageSize=51`,
    `${listPath}?page=1&pageSize=20&page=2`,
    `${listPath}?page=1&pageSize=20&repositoryId=repo-other`,
    `${runPath}?page=1&pageSize=20`,
    `${jobsPath}?page=1&pageSize=20&workItemId=${workItemId}`,
    `${resultPath}?raw=true`,
    `${jobsPath}/${jobId}`,
    `${runPath}/result`,
    `https://example.com${runPath}`,
    `${repositoryPath}/review-runs/%2e%2e`,
  ])("does not authorize an approximate or altered run route: %s", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(path, "read review run")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows only POST at the run-creation endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(createPath, "create review run")).rejects.toThrow();
    await expect(client.post(listPath, "create review run", createRequest)).rejects.toThrow();
    await expect(client.patch(runPath, "change review run", {})).rejects.toThrow();
    await expect(client.put(resultPath, "replace review result", {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "?",
    "?jobId=",
    "?jobId=one&jobId=two",
    "?jobId=job%0A",
    "?jobId=../other",
    "?jobId=job&raw=true",
    "?jobId=%6Aob",
    "?page=1",
    "/observations",
    "?jobId=job?raw=true",
  ])("rejects altered reproduction case paths and query strings: %s", async (suffix) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(
      client.get(
        `${runPath}/requests/${requestId}/reproduction-cases/case-1${suffix}`,
        "read case",
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not authorize writes to the reproduction evidence endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    const path = `${runPath}/requests/${requestId}/reproduction-cases/case-1`;
    await expect(client.post(path, "write case", {})).rejects.toThrow();
    await expect(client.patch(path, "write case", {})).rejects.toThrow();
    await expect(client.put(path, "write case", {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("review run response consistency", () => {
  it("compares the issue reproduction preview with the runner report, independently of the model summary", async () => {
    const issueResult = structuredClone(
      requireFixture(
        sampleReviewRunResults.find(
          (entry) =>
            entry.report.workItemKind === "issue" &&
            entry.report.reproductionConclusion === "confirmed",
        ),
      ),
    );
    const issueDetail = structuredClone(
      requireFixture(sampleReviewRuns.find((entry) => entry.id === issueResult.reviewRunId)),
    );
    issueResult.modelReview.reproductionConclusion = null;
    const { adapter } = adapterWith(issueDetail, issueResult);
    await expect(
      adapter.getResult(
        issueResult.repositoryId,
        issueResult.reviewRunId,
        issueResult.requestId,
        issueResult.jobId,
      ),
    ).resolves.toMatchObject({
      report: { reproductionConclusion: "confirmed" },
      modelReview: { reproductionConclusion: null },
    });
  });
  const eligibleUiDetail = (modelReviewState: "completed" | "not_requested" | "failed") => {
    const value = structuredClone(detail);
    value.policy = {
      ...value.policy,
      applicable: true,
      eligible: true,
      reasons: [],
      reasonCount: 0,
      reasonsTruncated: false,
      blockingFindingCount: 0,
    };
    const request = requireFixture(value.requests[0]);
    const latestResult = requireFixture(request.latestResult);
    latestResult.modelReviewState = modelReviewState;
    latestResult.recommendation = null;
    latestResult.checks = {
      passed: 1,
      failed: 0,
      blocked: 0,
      not_run: 0,
      skipped: 0,
      inconclusive: 0,
    };
    return value;
  };

  const dispositionEligibleDetail = () => {
    const value = eligibleUiDetail("completed");
    value.policy = {
      ...value.policy,
      applicable: true,
      policyVersion: "required-checks-and-unresolved-p0-p1-v2",
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 0,
      findingDispositionDigest: "d".repeat(64),
    };
    const preview = requireFixture(requireFixture(value.requests[0]).latestResult);
    preview.findings = [
      {
        id: "reported-p1",
        priority: 1,
        title: "A reported issue remains in the immutable model output",
        body: "The original report remains visible after an operator dismisses or resolves it.",
        path: "src/settings.ts",
        line: 4,
      },
    ];
    preview.findingCount = 1;
    return value;
  };

  it("accepts V2 eligibility with reported P1 findings after all blocking dispositions are handled", async () => {
    const value = dispositionEligibleDetail();
    await expect(adapterWith(value).adapter.get(repositoryId, runId)).resolves.toEqual(value);
    expect(value.requests[0]?.latestResult?.findings).toHaveLength(1);
  });

  it.each([0, 1])(
    "preserves legacy eligibility rejection for reported P1 with raw count %i",
    async (blockingFindingCount) => {
      const value = dispositionEligibleDetail();
      value.policy = {
        applicable: true,
        eligible: true,
        policyVersion: "required-checks-and-p0-p1-v1",
        blockingFindingCount,
        reasons: [],
        reasonCount: 0,
        reasonsTruncated: false,
      };
      await expect(adapterWith(value).adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each([
    { unresolvedBlockingFindingCount: 1 },
    { unresolvedBlockingFindingCount: 2, eligible: false },
    { unresolvedBlockingFindingCount: -1 },
    { unresolvedBlockingFindingCount: 0.5 },
    { unresolvedBlockingFindingCount: Number.MAX_SAFE_INTEGER + 1 },
    { blockingFindingCount: 0, eligible: false },
    { findingDispositionDigest: "D".repeat(64) },
    { findingDispositionDigest: "d".repeat(63) },
    { findingDispositionDigest: undefined },
  ])("rejects V2 count or digest inconsistency %j", async (mutation) => {
    const value = dispositionEligibleDetail();
    await expect(
      adapterWith({ ...value, policy: { ...value.policy, ...mutation } }).adapter.get(
        repositoryId,
        runId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("counts reported blockers from optional request previews without assigning dispositions to them", async () => {
    const value = dispositionEligibleDetail();
    const optional = structuredClone(requireFixture(value.requests[0]));
    optional.requestId = "optional-request";
    optional.required = false;
    value.requests.push(optional);
    value.requestCount += 1;
    value.execution.succeeded += 1;
    await expect(adapterWith(value).adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    value.policy.blockingFindingCount = 2;
    await expect(adapterWith(value).adapter.get(repositoryId, runId)).resolves.toEqual(value);
  });

  it.each([
    "source",
    "required_checks",
    "evidence",
    "pending_evidence",
    "lifecycle",
    "readiness",
    "model_review",
    "required_profile",
  ])("retains the existing %s gate after dispositions remove finding blockers", async (gate) => {
    const value = dispositionEligibleDetail();
    const request = requireFixture(value.requests[0]);
    const preview = requireFixture(request.latestResult);
    if (gate === "source") value.freshness = "superseded";
    if (gate === "required_checks") preview.checks.passed = 0;
    if (gate === "evidence") preview.evidenceComplete = false;
    if (gate === "pending_evidence") {
      preview.evidenceComplete = false;
      preview.evidenceVerificationPending = true;
    }
    if (gate === "lifecycle") preview.lifecycleBlockerCount = 1;
    if (gate === "readiness") request.readiness = "blocked";
    if (gate === "model_review") {
      request.workflowKind = "pr_static_build";
      preview.modelReviewState = "failed";
    }
    if (gate === "required_profile") request.profile = null;
    await expect(adapterWith(value).adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("keeps recorded runner outcomes visible while required evidence verification is pending", async () => {
    const pendingDetail = structuredClone(detail);
    const pendingRequest = requireFixture(pendingDetail.requests[0]);
    const pendingPreview = requireFixture(pendingRequest.latestResult);
    pendingRequest.blockers.push("evidence_verification_pending");
    pendingPreview.evidenceVerificationPending = true;
    pendingPreview.evidenceComplete = false;
    const pendingResult = { ...result, evidenceComplete: false, evidenceVerificationPending: true };
    const { adapter } = adapterWith(pendingDetail, pendingResult);
    const actual = await adapter.getResult(repositoryId, runId, requestId, jobId);
    expect(actual).toMatchObject({ evidenceVerificationPending: true, evidenceComplete: false });
    expect(actual?.report).toEqual(result.report);
    expect(actual?.execution).toEqual(result.execution);
    expect(actual?.resultDigest).toBe(result.resultDigest);
  });

  it.each([
    { previewPending: true, resultPending: false },
    { previewPending: false, resultPending: true },
  ])(
    "allows verification metadata to change between scoped detail/result reads: %j",
    async ({ previewPending, resultPending }) => {
      const currentDetail = structuredClone(detail);
      const preview = requireFixture(requireFixture(currentDetail.requests[0]).latestResult);
      preview.evidenceComplete = !previewPending;
      if (previewPending) preview.evidenceVerificationPending = true;
      const currentResult = {
        ...result,
        evidenceComplete: !resultPending,
        ...(resultPending ? { evidenceVerificationPending: true as const } : {}),
      };
      const { adapter } = adapterWith(currentDetail, currentResult);
      await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toEqual(
        currentResult,
      );
    },
  );

  it("rejects approval eligibility while a required request is pending evidence verification", async () => {
    const currentDetail = eligibleUiDetail("not_requested");
    const preview = requireFixture(requireFixture(currentDetail.requests[0]).latestResult);
    preview.evidenceComplete = false;
    preview.evidenceVerificationPending = true;
    const { adapter } = adapterWith(currentDetail);
    await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("does not block completed required requests solely because an optional profile is pending", async () => {
    const currentDetail = eligibleUiDetail("not_requested");
    const optional = structuredClone(requireFixture(currentDetail.requests[0]));
    optional.requestId = "optional-request";
    optional.required = false;
    optional.requiredCheckIds = ["optional-profile-version:check"];
    optional.blockers = ["evidence_verification_pending"];
    const optionalProfile = requireFixture(optional.profile);
    optionalProfile.id = "optional-profile-version";
    optionalProfile.profileId = "optional-profile";
    const latestJob = requireFixture(optional.latestJob);
    latestJob.jobId = "optional-job";
    latestJob.resultId = "optional-result";
    latestJob.runAttemptId = "optional-attempt";
    const preview = requireFixture(optional.latestResult);
    preview.id = "optional-result";
    preview.evidenceComplete = false;
    preview.evidenceVerificationPending = true;
    currentDetail.requests.push(optional);
    currentDetail.requestCount = 2;
    currentDetail.execution.succeeded = 2;
    const { adapter } = adapterWith(currentDetail);
    await expect(adapter.get(repositoryId, runId)).resolves.toMatchObject({
      policy: { eligible: true },
      requests: [
        { required: true, latestResult: { evidenceComplete: true } },
        { required: false, latestResult: { evidenceVerificationPending: true } },
      ],
    });
    preview.findings = [
      {
        id: "blocking-optional-finding",
        priority: 1,
        title: "Blocking optional finding",
        body: "The known defect still requires attention.",
        path: null,
        line: null,
      },
    ];
    preview.findingCount = 1;
    const invalidPolicy = adapterWith(currentDetail).adapter;
    await expect(invalidPolicy.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects contradictory complete-and-pending evidence at both response boundaries", async () => {
    const currentDetail = structuredClone(detail);
    requireFixture(
      requireFixture(currentDetail.requests[0]).latestResult,
    ).evidenceVerificationPending = true;
    const summaryAdapter = adapterWith(currentDetail).adapter;
    await expect(summaryAdapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    const fullAdapter = adapterWith(detail, {
      ...result,
      evidenceVerificationPending: true,
    }).adapter;
    await expect(
      fullAdapter.getResult(repositoryId, runId, requestId, jobId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects false pending flags instead of treating them as supported wire states", async () => {
    const { adapter } = adapterWith(detail, { ...result, evidenceVerificationPending: false });
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each(["not_requested", "failed"] as const)(
    "accepts eligible runner UI checks with optional model review %s",
    async (state) => {
      const value = eligibleUiDetail(state);
      const { adapter } = adapterWith(value);
      await expect(adapter.get(repositoryId, runId)).resolves.toEqual(value);
    },
  );

  it.each(["not_requested", "failed"] as const)(
    "still requires completed model review for static/build workflow: %s",
    async (state) => {
      const value = eligibleUiDetail(state);
      const request = requireFixture(value.requests[0]);
      request.workflowKind = "pr_static_build";
      request.target = "headless";
      const { adapter } = adapterWith(value);
      await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each(["failed-check", "missing-evidence", "modified-source", "lifecycle-blocker"])(
    "keeps the UI policy gate for %s even when the model is optional",
    async (failure) => {
      const value = eligibleUiDetail("not_requested");
      const latestResult = requireFixture(requireFixture(value.requests[0]).latestResult);
      if (failure === "failed-check")
        latestResult.checks = { ...latestResult.checks, passed: 0, failed: 1 };
      if (failure === "missing-evidence") latestResult.evidenceComplete = false;
      if (failure === "modified-source") latestResult.sourceState = "modified";
      if (failure === "lifecycle-blocker") latestResult.lifecycleBlockerCount = 1;
      const { adapter } = adapterWith(value);
      await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each([
    { ...summary, repositoryId: "repo-other" },
    { ...summary, revisionKey: "invalid" },
    { ...summary, title: "Unpaired surrogate \ud800" },
    { ...summary, unknown: true },
    { ...summary, requiredRequestCount: 2 },
    { ...summary, execution: { ...summary.execution, missing: 1 } },
    { ...summary, currentRevisionKey: "d".repeat(64), freshness: "current" },
  ])("rejects invalid, unscoped, or contradictory run summaries: %j", async (item) => {
    const { adapter } = adapterWith(pageOf(item));
    await expect(adapter.list(repositoryId)).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("preserves server supersession when a previous source activation has the same revision", async () => {
    const oldActivation = { ...summary, freshness: "superseded" };
    const oldDetail = { ...detail, freshness: "superseded" };
    const { adapter } = adapterWith(pageOf(oldActivation), oldDetail);
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({
      items: [{ revisionKey: digest, currentRevisionKey: digest, freshness: "superseded" }],
    });
    await expect(adapter.get(repositoryId, runId)).resolves.toMatchObject({
      revisionKey: digest,
      currentRevisionKey: digest,
      freshness: "superseded",
      policy: { eligible: false },
    });
  });

  it("rejects a response outside the requested work item", async () => {
    const { adapter } = adapterWith(pageOf({ ...summary, workItemId: "work-item-other" }));
    await expect(adapter.list(repositoryId, { workItemId })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { ...pageOf(summary), page: 2 },
    { ...pageOf(summary), pageSize: 50 },
    { ...pageOf(summary), total: 0 },
    { ...pageOf(summary), items: [summary, summary], total: 2 },
    { ...pageOf(summary), total: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects mismatched page metadata and duplicate runs: %j", async (page) => {
    const { adapter } = adapterWith(page);
    await expect(adapter.list(repositoryId)).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { ...detail, id: "review-run-other" },
    { ...detail, repositoryId: "repo-other" },
    { ...detail, requestCount: 2 },
    { ...detail, requiredRequestCount: 0 },
    { ...detail, requiredCheckIds: [] },
    { ...detail, policy: { ...detail.policy, reasonCount: 0 } },
    { ...detail, policy: { ...detail.policy, applicable: false, eligible: null } },
  ])("rejects a detail whose identity or aggregates disagree: %j", async (value) => {
    const { adapter } = adapterWith(value);
    await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects report payloads hidden in the bounded detail summary", async () => {
    const value = structuredClone(detail);
    Object.assign(requireFixture(value.requests[0]?.latestResult), { report: result.report });
    const { adapter } = adapterWith(value);
    await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects approval eligibility when the only required check failed", async () => {
    const value = {
      ...detail,
      policy: { ...detail.policy, eligible: true, reasons: [], reasonCount: 0 },
    };
    const { adapter } = adapterWith(value);
    await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("allows optional check failures when every required check passed", async () => {
    const value = structuredClone(detail);
    Object.assign(requireFixture(value.requests[0]?.latestResult).checks, {
      passed: 1,
      failed: 1,
    });
    Object.assign(value.policy, { eligible: true, reasons: [], reasonCount: 0 });
    const { adapter } = adapterWith(value);
    await expect(adapter.get(repositoryId, runId)).resolves.toEqual(value);
  });

  it("rejects mismatched preview identities and counts", async () => {
    for (const change of [
      { id: "result-other" },
      { resultDigest: "d".repeat(64) },
      { findingCount: 1 },
      { evidenceCount: 1 },
    ]) {
      const value = structuredClone(detail);
      Object.assign(requireFixture(value.requests[0]?.latestResult), change);
      const { adapter } = adapterWith(value);
      await expect(adapter.get(repositoryId, runId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });

  it("preserves model observations that share an ID in the server preview", async () => {
    const observation = {
      id: "observation-1",
      title: "Inspect the settings behavior",
      body: "The settings dialog could not be opened.",
      priority: 2,
      path: null,
      line: null,
    };
    const observations = [
      observation,
      { ...observation, body: "The retry exposed an additional timeout." },
    ];
    const value = structuredClone(detail);
    Object.assign(requireFixture(value.requests[0]?.latestResult), {
      findings: observations,
      findingCount: 2,
    });
    const expanded = { ...result, modelReview: { ...result.modelReview, observations } };
    const { adapter } = adapterWith(value, expanded);
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toEqual(
      expanded,
    );
  });

  it.each(["workItemId", "activationId", "revisionKey"] as const)(
    "rejects create acknowledgments for another %s",
    async (field) => {
      const value = { ...detail, [field]: field === "revisionKey" ? "d".repeat(64) : "other-id" };
      const { adapter } = adapterWith(jsonResponse(value, 201));
      await expect(adapter.create(repositoryId, workItemId, createRequest)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it("does not fetch a result for a request missing from the run", async () => {
    const { adapter, fetch } = adapterWith(detail);
    await expect(
      adapter.getResult(repositoryId, runId, "request-other", jobId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([runPath]);
  });

  it.each(["repositoryId", "reviewRunId", "requestId"] as const)(
    "rejects job history from another %s even when the page is empty",
    async (field) => {
      for (const items of [[], [job]]) {
        const { adapter } = adapterWith({ ...jobPage(), items, [field]: "other-id" });
        await expect(adapter.listJobs(repositoryId, runId, requestId)).rejects.toBeInstanceOf(
          ReviewControlProtocolError,
        );
      }
    },
  );

  it("requires explicit job-history scope and validates page metadata", async () => {
    for (const page of [pageOf(job), { ...jobPage(), page: 2 }, { ...jobPage(), total: 0 }]) {
      const { adapter } = adapterWith(page);
      await expect(adapter.listJobs(repositoryId, runId, requestId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });

  it("rejects duplicate activations and partial result identities in job history", async () => {
    for (const items of [
      [job, { ...job, jobId: "job-other" }],
      [{ ...job, resultDigest: null }],
      [{ ...job, status: "failed" }],
    ]) {
      const { adapter } = adapterWith({ ...jobPage(), items, total: items.length });
      await expect(adapter.listJobs(repositoryId, runId, requestId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });

  it.each([
    "repositoryId",
    "reviewRunId",
    "requestId",
    "workItemId",
    "jobId",
    "profileVersionId",
    "promptVersionId",
    "runAttemptId",
    "id",
  ] as const)("rejects a result from a different %s", async (field) => {
    const { adapter } = adapterWith(detail, { ...result, [field]: "other-id" });
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each(["revisionKey", "planDigest", "resultDigest"] as const)(
    "rejects a result whose %s differs from the frozen run or job",
    async (field) => {
      const { adapter } = adapterWith(detail, { ...result, [field]: "d".repeat(64) });
      await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each([
    { name: "creation time", value: { ...result, createdAt: "2026-09-07T03:00:00.000Z" } },
    {
      name: "source state",
      value: { ...result, report: { ...result.report, sourceState: "modified" } },
    },
    {
      name: "check outcomes",
      value: {
        ...result,
        report: {
          ...result.report,
          checks: result.report.checks.map((check) => ({ ...check, outcome: "passed" })),
        },
      },
    },
  ])(
    "rejects a latest result whose immutable $name differs from its preview",
    async ({ value }) => {
      const { adapter } = adapterWith(detail, value);
      await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each([
    { name: "summary", maximumLength: 1_024, character: "a" },
    { name: "finding body", maximumLength: 512, character: "b" },
  ])("accepts a Unicode-safe $name preview and rejects a split surrogate", async (testCase) => {
    const prefix = testCase.character.repeat(testCase.maximumLength - 1);
    const text = `${prefix}\u{1f600}Additional context.`;
    const expanded = structuredClone(result);
    const value = structuredClone(detail);
    const preview = requireFixture(value.requests[0]?.latestResult);
    if (testCase.name === "summary") {
      expanded.report.summary = text;
      Object.assign(preview, { summary: prefix, summaryTruncated: true });
    } else {
      const observation = {
        id: "observation-unicode",
        title: "Inspect the settings behavior",
        body: text,
        priority: 2,
        path: null,
        line: null,
      };
      expanded.modelReview.observations = [observation];
      Object.assign(preview, {
        findings: [{ ...observation, body: prefix }],
        findingCount: 1,
        findingsTruncated: true,
      });
    }
    const { adapter } = adapterWith(value, expanded);
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toEqual(
      expanded,
    );

    const broken = structuredClone(value);
    const brokenPreview = requireFixture(broken.requests[0]?.latestResult);
    if (testCase.name === "summary") brokenPreview.summary = text.slice(0, testCase.maximumLength);
    else requireFixture(brokenPreview.findings[0]).body = text.slice(0, testCase.maximumLength);
    const { adapter: brokenAdapter, fetch } = adapterWith(broken);
    await expect(
      brokenAdapter.getResult(repositoryId, runId, requestId, jobId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(runPath, expect.anything());
  });

  it("allows current evidence availability and authority to change between reads", async () => {
    const changed = { ...result, evidenceComplete: false, authoritative: false };
    const { adapter } = adapterWith(detail, changed);
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toEqual(
      changed,
    );
  });

  it("rejects duplicate frozen check identities in the full report", async () => {
    const duplicated = {
      ...result,
      report: { ...result.report, checks: [...result.report.checks, ...result.report.checks] },
    };
    const { adapter } = adapterWith(detail, duplicated);
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("accepts an older result only with historical authority and an older activation", async () => {
    const newerDetail = structuredClone(detail);
    Object.assign(requireFixture(newerDetail.requests[0]?.latestJob), {
      jobId: "job-newer",
      activationNumber: 2,
      runAttemptId: "attempt-newer",
      resultId: "result-newer",
      resultDigest: "b".repeat(64),
    });
    Object.assign(requireFixture(newerDetail.requests[0]?.latestResult), {
      id: "result-newer",
      resultDigest: "b".repeat(64),
    });
    const historical = { ...result, authoritative: false };
    const { adapter } = adapterWith(newerDetail, historical);
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toEqual(
      historical,
    );

    for (const change of [
      { authoritative: true },
      { activationNumber: 2 },
      { activationNumber: 3 },
    ]) {
      const { adapter: invalidAdapter } = adapterWith(newerDetail, { ...historical, ...change });
      await expect(
        invalidAdapter.getResult(repositoryId, runId, requestId, jobId),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
  });
});

describe("review run transport failures", () => {
  it("returns null only for an exact result endpoint review_run_not_found response", async () => {
    const { adapter, fetch } = adapterWith(
      detail,
      jsonResponse({ code: "review_run_not_found", message: "No result exists." }, 404),
    );
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).resolves.toBeNull();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([runPath, resultPath]);
  });

  it("preserves a missing run instead of silently treating it as a missing result", async () => {
    const { adapter, fetch } = adapterWith(
      jsonResponse({ code: "review_run_not_found", message: "No run exists." }, 404),
    );
    await expect(adapter.getResult(repositoryId, runId, requestId, jobId)).rejects.toMatchObject({
      status: 404,
      serverCode: "review_run_not_found",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "repository_not_found"],
    [403, "forbidden"],
    [409, "revision_conflict"],
    [503, "review_run_not_found"],
  ] as const)("preserves HTTP %i %s without sample fallback", async (status, code) => {
    const { adapter, fetch } = adapterWith(
      detail,
      jsonResponse({ code, message: "The requested result is unavailable." }, status),
    );
    const promise = adapter.getResult(repositoryId, runId, requestId, jobId);
    await expect(promise).rejects.toBeInstanceOf(ReviewControlHttpError);
    await expect(promise).rejects.toMatchObject({ status, serverCode: code });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps network failures visible without fetching sample data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Offline"));
    const adapter = new HttpReviewRunAdapter({ fetch });
    await expect(adapter.list(repositoryId)).rejects.toBeInstanceOf(ReviewControlNetworkError);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${listPath}${pagination}`, expect.anything());
  });

  it.each([
    new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { "content-type": "application/json" },
    }),
  ])("rejects non-JSON and invalid UTF-8 responses", async (response) => {
    const { adapter } = adapterWith(response);
    await expect(adapter.list(repositoryId)).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("enforces the response limit in streamed UTF-8 bytes rather than character count", async () => {
    const body = JSON.stringify({
      padding: "\u20ac".repeat(Math.ceil(MAX_DASHBOARD_RESPONSE_BYTES / 3)),
    });
    expect(body.length).toBeLessThan(MAX_DASHBOARD_RESPONSE_BYTES);
    const { adapter, fetch } = adapterWith(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    await expect(adapter.list(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlResponseTooLargeError,
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
