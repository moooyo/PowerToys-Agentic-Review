import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionContext,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { MockAccessAdapter, sampleOperatorPrincipal } from "../access/mock-adapter";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import type { ReviewRunAdapter } from "../runs/adapter";
import { sampleReviewRuns } from "../runs/fixtures";
import { MockReviewRunAdapter } from "../runs/mock-adapter";
import { MockDecisionAdapter } from "./mock-adapter";

const actor: OperatorPrincipal = { ...sampleOperatorPrincipal };
const repositoryId = "repo-powertoys";
const reviewRunId = "sample-run-pr-41982";
const issueRunId = "sample-run-issue-41876";
function request(
  context: ReviewRunDecisionContext,
  action: ReviewRunDecisionChangeRequest["action"] = "comment",
  changeId: string = globalThis.crypto.randomUUID(),
): ReviewRunDecisionChangeRequest {
  const base = {
    changeId,
    expectedVersion: context.version,
    expectedRevisionKey: context.revisionKey,
    expectedPlanDigest: context.planDigest,
    expectedResultSetDigest: context.resultSetDigest,
    reason: "Reviewed the sample validation report.",
  };
  return action === "withdraw"
    ? { ...base, action, targetDecisionId: context.recordedDecision?.id ?? "missing-decision" }
    : { ...base, action };
}

function mutableRun() {
  const original = sampleReviewRuns.find((run) => run.id === reviewRunId);
  if (original === undefined) throw new Error("The sample PR run is missing.");
  const state = { run: structuredClone(original) };
  const runs: Pick<ReviewRunAdapter, "mode" | "get"> = {
    mode: "sample",
    get: vi.fn(async () => structuredClone(state.run)),
  };
  const adapter = new MockDecisionAdapter({ runs });
  return { state, adapter, runs };
}

describe("explicit sample decision lifecycle", () => {
  it("derives initial contexts from both existing PR and Issue runs", async () => {
    const adapter = new MockDecisionAdapter();
    expect(adapter.mode).toBe("sample");
    await expect(adapter.getContext(repositoryId, reviewRunId)).resolves.toMatchObject({
      repositoryId,
      reviewRunId,
      workItemKind: "pull_request",
      version: 0,
      recordedDecision: null,
      recordedDecisionState: "none",
    });
    await expect(adapter.getContext(repositoryId, issueRunId)).resolves.toMatchObject({
      workItemKind: "issue",
      version: 0,
      recordedDecision: null,
      canApprove: false,
    });
    await expect(adapter.listHistory(repositoryId, reviewRunId)).resolves.toMatchObject({
      page: 1,
      pageSize: 20,
      total: 0,
      items: [],
    });
  });

  it("records comments without replacing a recorded decision and withdraws through an immutable tombstone", async () => {
    const adapter = new MockDecisionAdapter({ now: () => new Date("2026-09-07T10:00:00.000Z") });
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const firstComment = await adapter.change(repositoryId, reviewRunId, request(initial), actor);
    const afterComment = await adapter.getContext(repositoryId, reviewRunId);
    expect(afterComment).toMatchObject({
      version: 1,
      recordedDecision: null,
      recordedDecisionState: "none",
    });
    expect(firstComment.change).toMatchObject({ action: "comment", supersedesDecisionId: null });
    const decision = await adapter.change(
      repositoryId,
      reviewRunId,
      request(afterComment, "request_changes"),
      actor,
    );
    const secondComment = await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId)),
      actor,
    );
    const beforeWithdrawal = await adapter.getContext(repositoryId, reviewRunId);
    expect(beforeWithdrawal).toMatchObject({
      version: 3,
      recordedDecision: { id: decision.change.id, version: 2 },
    });
    const withdrawal = await adapter.change(
      repositoryId,
      reviewRunId,
      request(beforeWithdrawal, "withdraw"),
      actor,
    );
    expect(withdrawal.change).toMatchObject({
      action: "withdraw",
      targetDecisionId: decision.change.id,
      supersedesDecisionId: decision.change.id,
    });
    const withdrawn = await adapter.getContext(repositoryId, reviewRunId);
    expect(withdrawn).toMatchObject({
      version: 4,
      recordedDecisionState: "withdrawn",
      stateReasons: [],
    });
    const replacement = await adapter.change(
      repositoryId,
      reviewRunId,
      request(withdrawn, "request_changes"),
      actor,
    );
    expect(replacement.change.supersedesDecisionId).toBeNull();
    const history = await adapter.listHistory(repositoryId, reviewRunId, { page: 1, pageSize: 2 });
    expect(history).toMatchObject({ total: 5, items: [{ version: 5 }, { version: 4 }] });
    const older = await adapter.listHistory(repositoryId, reviewRunId, { page: 2, pageSize: 2 });
    expect(older.items.map((event) => event.id)).toEqual([
      secondComment.change.id,
      decision.change.id,
    ]);
    await expect(
      adapter.listHistory(repositoryId, reviewRunId, { page: 4, pageSize: 2 }),
    ).resolves.toMatchObject({ total: 5, items: [] });
  });

  it("preserves an accepted historical receipt through subsequent comments, decisions and withdrawal", async () => {
    const adapter = new MockDecisionAdapter();
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const intent = request(initial, "request_changes", "stable-retry");
    const first = await adapter.change(repositoryId, reviewRunId, intent, actor);
    await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "withdraw"),
      actor,
    );
    const replay = await adapter.change(repositoryId, reviewRunId, intent, actor);
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await adapter.getContext(repositoryId, reviewRunId)).recordedDecisionState).toBe(
      "withdrawn",
    );
    expect((await adapter.listHistory(repositoryId, reviewRunId)).total).toBe(2);
  });

  it("isolates caller-owned intent, contexts, receipts and history objects", async () => {
    const adapter = new MockDecisionAdapter();
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const intent = request(initial, "request_changes", "isolated-intent");
    intent.reason = `  ${intent.reason}  `;
    const receipt = await adapter.change(repositoryId, reviewRunId, intent, actor);
    const accepted = structuredClone(receipt);
    expect(intent.reason.startsWith("  ")).toBe(true);
    receipt.change.reason = "Altered receipt";
    const context = await adapter.getContext(repositoryId, reviewRunId);
    if (context.recordedDecision !== null) context.recordedDecision.reason = "Altered context";
    const history = await adapter.listHistory(repositoryId, reviewRunId);
    const first = history.items[0];
    if (first !== undefined) first.actor.subject = "Altered actor";
    expect(await adapter.change(repositoryId, reviewRunId, intent, actor)).toEqual({
      ...accepted,
      replayed: true,
    });
  });

  it("rejects stale versions, binding changes, conflicting change IDs and noncurrent withdrawal targets", async () => {
    const adapter = new MockDecisionAdapter();
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const intent = request(initial, "request_changes", "change-once");
    await adapter.change(repositoryId, reviewRunId, intent, actor);
    for (const input of [
      request(initial, "comment"),
      { ...intent, reason: "Another intent" },
      {
        ...request(await adapter.getContext(repositoryId, reviewRunId)),
        expectedRevisionKey: "f".repeat(64),
      },
      {
        ...request(await adapter.getContext(repositoryId, reviewRunId)),
        expectedPlanDigest: "f".repeat(64),
      },
      {
        ...request(await adapter.getContext(repositoryId, reviewRunId)),
        expectedResultSetDigest: "f".repeat(64),
      },
      {
        ...request(await adapter.getContext(repositoryId, reviewRunId), "withdraw"),
        targetDecisionId: "another",
      },
    ]) {
      await expect(adapter.change(repositoryId, reviewRunId, input, actor)).rejects.toMatchObject({
        status: 409,
      });
    }
    expect((await adapter.listHistory(repositoryId, reviewRunId)).total).toBe(1);
  });

  it("makes concurrent sample changes observe one CAS winner", async () => {
    const adapter = new MockDecisionAdapter();
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const results = await Promise.allSettled([
      adapter.change(repositoryId, reviewRunId, request(initial, "request_changes"), actor),
      adapter.change(repositoryId, reviewRunId, request(initial, "comment"), actor),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await adapter.listHistory(repositoryId, reviewRunId)).total).toBe(1);
  });

  it.each(["approve", "override_approve"] as const)("does not record Issue %s", async (action) => {
    const adapter = new MockDecisionAdapter();
    await expect(
      adapter.change(
        repositoryId,
        issueRunId,
        request(await adapter.getContext(repositoryId, issueRunId), action),
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await adapter.listHistory(repositoryId, issueRunId)).total).toBe(0);
  });

  it("supports Issue handling decisions without modifying reproduction results", async () => {
    const runs = new MockReviewRunAdapter();
    const adapter = new MockDecisionAdapter({ runs });
    const before = await runs.get(repositoryId, issueRunId);
    const result = await adapter.change(
      repositoryId,
      issueRunId,
      request(await adapter.getContext(repositoryId, issueRunId), "request_changes"),
      actor,
    );
    expect(result.change).toMatchObject({
      workItemKind: "issue",
      action: "request_changes",
      policyAtDecision: { applicable: false, eligible: null },
    });
    expect(await runs.get(repositoryId, issueRunId)).toEqual(before);
  });
});

describe("sample source and result binding", () => {
  it("rejects ordinary approval for the existing blocked sample while allowing an explicit override", async () => {
    const adapter = new MockDecisionAdapter();
    const before = await adapter.getContext(repositoryId, reviewRunId);
    expect(before.canApprove).toBe(false);
    await expect(
      adapter.change(repositoryId, reviewRunId, request(before, "approve"), actor),
    ).rejects.toMatchObject({ status: 409 });
    const receipt = await adapter.change(
      repositoryId,
      reviewRunId,
      request(before, "override_approve"),
      actor,
    );
    expect(receipt.change).toMatchObject({
      action: "override_approve",
      policyAtDecision: { eligible: false },
    });
    const after = await adapter.getContext(repositoryId, reviewRunId);
    expect(after).toMatchObject({ canApprove: false, recordedDecisionState: "current" });
    expect(after.policy).toEqual(before.policy);
  });

  it("does not bind presentation timestamps or transient evidence eligibility into the sample result digest", async () => {
    const { state, adapter } = mutableRun();
    const before = await adapter.getContext(repositoryId, reviewRunId);
    state.run.createdAt = "2026-09-07T12:00:00.000Z";
    const job = state.run.requests[0]?.latestJob;
    if (job === undefined || job === null) throw new Error("The sample job is missing.");
    job.startedAt = "2026-09-06T20:00:11.000Z";
    expect((await adapter.getContext(repositoryId, reviewRunId)).resultSetDigest).toBe(
      before.resultSetDigest,
    );
    state.run.policy = {
      ...state.run.policy,
      eligible: false,
      reasons: [{ code: "evidence_pending" }],
      reasonCount: 1,
      reasonsTruncated: false,
    } as DashboardReviewRunDetail["policy"];
    expect((await adapter.getContext(repositoryId, reviewRunId)).resultSetDigest).toBe(
      before.resultSetDigest,
    );
  });

  it("invalidates a decision when a new activation appears before a replacement result", async () => {
    const { state, adapter } = mutableRun();
    const before = await adapter.getContext(repositoryId, reviewRunId);
    const intent = request(before, "request_changes", "original-results");
    const accepted = await adapter.change(repositoryId, reviewRunId, intent, actor);
    const requestEntry = state.run.requests[0];
    if (requestEntry === undefined || requestEntry.latestJob === null)
      throw new Error("The sample request is missing.");
    requestEntry.latestJob.activationNumber += 1;
    requestEntry.latestJob.jobId = "replacement-job";
    requestEntry.latestJob.resultId = null;
    requestEntry.latestJob.resultDigest = null;
    requestEntry.latestJob.status = "queued";
    requestEntry.latestJob.runAttemptId = null;
    requestEntry.latestJob.attemptCount = 0;
    requestEntry.latestJob.admission = {
      state: "pending",
      attemptBase: 0,
      requestedAt: requestEntry.latestJob.createdAt,
      admittedAt: null,
      timestampBasis: "recorded",
    };
    requestEntry.latestResult = null;
    state.run.execution.succeeded -= 1;
    state.run.execution.awaitingAdmission += 1;
    const changed = await adapter.getContext(repositoryId, reviewRunId);
    expect(changed.resultSetDigest).not.toBe(before.resultSetDigest);
    expect(changed).toMatchObject({
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed"],
    });
    await expect(adapter.change(repositoryId, reviewRunId, intent, actor)).resolves.toEqual({
      ...accepted,
      replayed: true,
    });
  });

  it("keeps source freshness distinct from revision equality", async () => {
    const { state, adapter } = mutableRun();
    await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "request_changes"),
      actor,
    );
    state.run.freshness = "superseded";
    const changed = await adapter.getContext(repositoryId, reviewRunId);
    expect(changed.revisionKey).toBe(changed.currentRevisionKey);
    expect(changed.sourceCurrent).toBe(false);
    expect(changed.recordedDecisionState).toBe("stale");
    expect(changed.stateReasons).toContain("source_not_current");
  });

  it("requires current source for new handling decisions while preserving comment and withdrawal paths", async () => {
    const { state, adapter } = mutableRun();
    const accepted = await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "request_changes"),
      actor,
    );
    state.run.freshness = "superseded";
    const stale = await adapter.getContext(repositoryId, reviewRunId);
    for (const action of ["approve", "request_changes", "override_approve"] as const) {
      await expect(
        adapter.change(repositoryId, reviewRunId, request(stale, action), actor),
      ).rejects.toMatchObject({ status: 409 });
    }
    await adapter.change(repositoryId, reviewRunId, request(stale, "comment"), actor);
    const withdrawal = await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "withdraw"),
      actor,
    );
    expect(withdrawal.change.targetDecisionId).toBe(accepted.change.id);
  });

  it("does not invent a complete private policy from a truncated sample preview", async () => {
    const { state, adapter } = mutableRun();
    state.run.policy = {
      ...state.run.policy,
      reasons: Array.from({ length: 128 }, () => ({ code: "check_failed" })),
      reasonCount: 300,
      reasonsTruncated: true,
    };
    const context = await adapter.getContext(repositoryId, reviewRunId);
    expect(context.policy.reasonCount).toBe(300);
    await expect(
      adapter.change(repositoryId, reviewRunId, request(context), actor),
    ).rejects.toMatchObject({ status: 409 });
    expect((await adapter.listHistory(repositoryId, reviewRunId)).total).toBe(0);
  });

  it.each(["v1", "v2"])(
    "preserves %s approval policy semantics when evidence later fails",
    async (version) => {
      const { state, adapter } = mutableRun();
      const completed = state.run.requests[0];
      if (completed === undefined || completed.latestResult === null)
        throw new Error("The sample result is missing.");
      completed.latestResult.checks = {
        passed: completed.requiredCheckIds.length,
        failed: 0,
        blocked: 0,
        not_run: 0,
        skipped: 0,
        inconclusive: 0,
      };
      if (version === "v1") {
        completed.latestResult.findings = [];
        completed.latestResult.findingCount = 0;
      }
      completed.latestResult.findingsTruncated = false;
      state.run.requests = [completed];
      state.run.requestCount = 1;
      state.run.requiredRequestCount = 1;
      state.run.requiredCheckIds = [...completed.requiredCheckIds];
      state.run.execution = {
        missing: 0,
        awaitingAdmission: 0,
        queued: 0,
        active: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
      };
      state.run.policy = {
        ...state.run.policy,
        applicable: true,
        eligible: true,
        reasons: [],
        reasonCount: 0,
        reasonsTruncated: false,
        ...(version === "v2"
          ? {
              policyVersion: "required-checks-and-unresolved-p0-p1-v2",
              blockingFindingCount: 1,
              unresolvedBlockingFindingCount: 0,
              findingDispositionDigest: "d".repeat(64),
            }
          : { policyVersion: "required-checks-and-p0-p1-v1", blockingFindingCount: 0 }),
      };
      const before = await adapter.getContext(repositoryId, reviewRunId);
      const receipt = await adapter.change(
        repositoryId,
        reviewRunId,
        request(before, "approve"),
        actor,
      );
      if (version === "v2") {
        expect(receipt.change.policyAtDecision).toMatchObject({
          policyVersion: "required-checks-and-unresolved-p0-p1-v2",
          blockingFindingCount: 1,
          unresolvedBlockingFindingCount: 0,
          findingDispositionDigest: "d".repeat(64),
        });
        expect(completed.latestResult.findings).toHaveLength(1);
      } else expect(receipt.change.policyAtDecision).not.toHaveProperty("findingDispositionDigest");
      state.run.policy = {
        ...state.run.policy,
        eligible: false,
        reasonCount: 1,
        reasons: [{ code: "evidence_expired" }],
      };
      const changed = await adapter.getContext(repositoryId, reviewRunId);
      expect(changed).toMatchObject({
        resultSetDigest: before.resultSetDigest,
        canApprove: false,
        recordedDecisionState: "ineligible",
        stateReasons: ["approval_policy_not_satisfied"],
      });
    },
  );

  it("binds V2 policy and disposition changes in sample contexts while preserving V1 replay", async () => {
    const { state, adapter } = mutableRun();
    const original = await adapter.getContext(repositoryId, reviewRunId);
    const originalIntent = request(original, "request_changes", "before-disposition-policy");
    const originalReceipt = await adapter.change(repositoryId, reviewRunId, originalIntent, actor);
    state.run.policy = {
      ...state.run.policy,
      policyVersion: "required-checks-and-unresolved-p0-p1-v2",
      unresolvedBlockingFindingCount: state.run.policy.blockingFindingCount,
      findingDispositionDigest: "d".repeat(64),
    };
    const upgraded = await adapter.getContext(repositoryId, reviewRunId);
    expect(upgraded.resultSetDigest).not.toBe(original.resultSetDigest);
    expect(upgraded.recordedDecisionState).toBe("stale");
    expect(upgraded.recordedDecision?.policyAtDecision.policyVersion).toBe(
      "required-checks-and-p0-p1-v1",
    );
    await expect(adapter.change(repositoryId, reviewRunId, originalIntent, actor)).resolves.toEqual(
      { ...originalReceipt, replayed: true },
    );
    const versionTwo = await adapter.change(
      repositoryId,
      reviewRunId,
      request(upgraded, "request_changes"),
      actor,
    );
    state.run.policy.findingDispositionDigest = "e".repeat(64);
    const changed = await adapter.getContext(repositoryId, reviewRunId);
    expect(changed.resultSetDigest).not.toBe(upgraded.resultSetDigest);
    expect(changed).toMatchObject({
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed"],
      recordedDecision: {
        id: versionTwo.change.id,
        policyAtDecision: { findingDispositionDigest: "d".repeat(64) },
      },
    });
    await expect(
      adapter.change(
        repositoryId,
        reviewRunId,
        { ...request(upgraded), expectedVersion: changed.version },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("sample isolation and permissions", () => {
  it("rejects mixed connected/sample adapters", () => {
    expect(() => new MockDecisionAdapter({ runs: { mode: "connected", get: vi.fn() } })).toThrow(
      ReviewControlRequestError,
    );
    expect(
      () => new MockDecisionAdapter({ access: { mode: "connected", context: vi.fn() } }),
    ).toThrow(ReviewControlRequestError);
  });

  it("uses live sample runs and propagates their errors instead of manufacturing a context", async () => {
    const { adapter, runs } = mutableRun();
    const failure = new ReviewControlHttpError("Unavailable", {
      status: 503,
      retryable: true,
      operation: "get run",
    });
    vi.mocked(runs.get).mockRejectedValueOnce(failure);
    await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toBe(failure);
    vi.mocked(runs.get).mockResolvedValueOnce({
      ...sampleReviewRuns[0],
      repositoryId: "other",
    } as DashboardReviewRunDetail);
    await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each(["repo-unknown", "repo-terminal"])(
    "does not leak another repository's sample run via %s",
    async (repository) => {
      const adapter = new MockDecisionAdapter();
      await expect(adapter.getContext(repository, reviewRunId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(adapter.listHistory(repository, reviewRunId)).rejects.toMatchObject({
        status: 404,
      });
    },
  );

  it("enforces reviewer and maintainer permissions, actor identity and revoked access on replay", async () => {
    const access = new MockAccessAdapter({
      principal: actor,
      platformAdministrator: false,
      grants: [
        {
          repositoryId,
          principal: actor,
          role: "reviewer",
          version: 1,
          createdAt: "2026-09-07T08:00:00.000Z",
          updatedAt: "2026-09-07T08:00:00.000Z",
          updatedBy: actor,
        },
      ],
    });
    const adapter = new MockDecisionAdapter({ access });
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    await expect(
      adapter.change(repositoryId, reviewRunId, request(initial, "override_approve"), actor),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      adapter.change(repositoryId, reviewRunId, request(initial), {
        ...actor,
        subject: "someone-else",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const intent = request(initial, "request_changes");
    await adapter.change(repositoryId, reviewRunId, intent, actor);
    const current = await access.context(repositoryId);
    if (current.repository === null) throw new Error("Expected sample repository access.");
    vi.spyOn(access, "context").mockResolvedValue({
      ...current,
      repository: { ...current.repository, role: "viewer", permissions: ["read"] },
    });
    await expect(adapter.change(repositoryId, reviewRunId, intent, actor)).rejects.toMatchObject({
      status: 403,
    });
    expect((await adapter.getContext(repositoryId, reviewRunId)).version).toBe(1);
  });

  it("requires review permission plus original authorship or configure permission for withdrawal and receipt replay", async () => {
    const backing = new MockAccessAdapter();
    const currentAccess = await backing.context(repositoryId);
    const access = {
      mode: "sample" as const,
      context: vi.fn(async () => structuredClone(currentAccess)),
    };
    const adapter = new MockDecisionAdapter({ access });
    const decision = await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "request_changes"),
      actor,
    );
    const withdrawnBy = { ...actor, subject: "another-reviewer" };
    if (currentAccess.repository === null) throw new Error("Expected sample repository access.");
    currentAccess.platformAdministrator = false;
    currentAccess.repository.source = "repository";
    currentAccess.repository.role = "viewer";
    currentAccess.repository.permissions = ["read"];
    const withdraw = request(
      await adapter.getContext(repositoryId, reviewRunId),
      "withdraw",
      "withdraw-once",
    );
    await expect(adapter.change(repositoryId, reviewRunId, withdraw, actor)).rejects.toMatchObject({
      status: 403,
    });
    currentAccess.principal = withdrawnBy;
    currentAccess.repository.role = "reviewer";
    currentAccess.repository.permissions = ["read", "review"];
    await expect(
      adapter.change(repositoryId, reviewRunId, withdraw, withdrawnBy),
    ).rejects.toMatchObject({ status: 403 });
    currentAccess.repository.role = "maintainer";
    currentAccess.repository.permissions = ["read", "review", "configure"];
    const receipt = await adapter.change(repositoryId, reviewRunId, withdraw, withdrawnBy);
    expect(receipt.change.targetDecisionId).toBe(decision.change.id);
    await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "request_changes"),
      withdrawnBy,
    );
    await expect(adapter.change(repositoryId, reviewRunId, withdraw, withdrawnBy)).resolves.toEqual(
      { ...receipt, replayed: true },
    );
    currentAccess.repository.role = "reviewer";
    currentAccess.repository.permissions = ["read", "review"];
    // A newer decision by this actor cannot authorize replay against another author's original target.
    await expect(
      adapter.change(repositoryId, reviewRunId, withdraw, withdrawnBy),
    ).rejects.toMatchObject({ status: 403 });
    expect((await adapter.getContext(repositoryId, reviewRunId)).version).toBe(3);
  });

  it("lets a reviewer withdraw their own decision without configure permission", async () => {
    const access = new MockAccessAdapter({
      principal: actor,
      platformAdministrator: false,
      grants: [
        {
          repositoryId,
          principal: actor,
          role: "reviewer",
          version: 1,
          createdAt: "2026-09-07T08:00:00.000Z",
          updatedAt: "2026-09-07T08:00:00.000Z",
          updatedBy: actor,
        },
      ],
    });
    const adapter = new MockDecisionAdapter({ access });
    await adapter.change(
      repositoryId,
      reviewRunId,
      request(await adapter.getContext(repositoryId, reviewRunId), "request_changes"),
      actor,
    );
    const withdrawal = request(await adapter.getContext(repositoryId, reviewRunId), "withdraw");
    const receipt = await adapter.change(repositoryId, reviewRunId, withdrawal, actor);
    await expect(adapter.change(repositoryId, reviewRunId, withdrawal, actor)).resolves.toEqual({
      ...receipt,
      replayed: true,
    });
  });

  it("rejects permission loss after asynchronous sample lookup before admitting a change", async () => {
    const access = new MockAccessAdapter();
    const adapter = new MockDecisionAdapter({ access });
    const initial = await adapter.getContext(repositoryId, reviewRunId);
    const original = access.context.bind(access);
    let calls = 0;
    vi.spyOn(access, "context").mockImplementation(async (repository) => {
      calls += 1;
      if (calls >= 3)
        throw new ReviewControlHttpError("Revoked", {
          status: 404,
          retryable: false,
          operation: "access",
        });
      return original(repository);
    });
    await expect(
      adapter.change(repositoryId, reviewRunId, request(initial), actor),
    ).rejects.toMatchObject({ status: 404 });
  });
});
