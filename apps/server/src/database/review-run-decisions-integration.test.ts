import type { ValidationJobResultV1 } from "@agentic-review/codex";
import type {
  JobExecutionEnvelopeV2,
  OperatorPrincipal,
  OperatorRepositoryRole,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionContext,
  SchedulingRevisionObservedEvent,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
  uploadEvidence,
} from "./evidence-control-plane.testing.js";

const administrator: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "decision-integration-admin",
};
const reviewer: OperatorPrincipal = { issuer: administrator.issuer, subject: "decision-reviewer" };
const colleague: OperatorPrincipal = { issuer: administrator.issuer, subject: "other-reviewer" };
const fixtures: EvidenceControlPlaneFixture[] = [];
const bound = (f: EvidenceControlPlaneFixture, actor = reviewer) =>
  bindOperatorDatabase(f.client, actor);

afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((f) => f.dispose()));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Decision integration cleanup failed.",
    );
});

async function fixture(profileCount = 1) {
  const f = await createEvidenceControlPlaneFixture(profileCount, [administrator]);
  fixtures.push(f);
  await grant(f, reviewer, "reviewer");
  return f;
}

function grant(
  f: EvidenceControlPlaneFixture,
  principal: OperatorPrincipal,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
) {
  return bound(f, administrator).request("changeRepositoryAccess", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      changeId: `access-${principal.subject}-${expectedVersion}-${role}`,
      principal,
      role,
      expectedVersion,
      reason: "Exercise decisions through authenticated repository access.",
    },
  });
}

const context = (f: EvidenceControlPlaneFixture, actor = reviewer, scope = f.query) =>
  bound(f, actor).request("getReviewRunDecisionContext", { ...scope, actor });
const history = (f: EvidenceControlPlaneFixture, actor = reviewer, scope = f.query) =>
  bound(f, actor).request("listReviewRunDecisionHistory", {
    ...scope,
    actor,
    page: 1,
    pageSize: 20,
  });

function intent(
  current: ReviewRunDecisionContext,
  action: Exclude<ReviewRunDecisionChangeRequest["action"], "withdraw">,
  changeId = `${action}-${current.version}`,
): ReviewRunDecisionChangeRequest {
  return {
    changeId,
    action,
    expectedVersion: current.version,
    expectedRevisionKey: current.revisionKey,
    expectedPlanDigest: current.planDigest,
    expectedResultSetDigest: current.resultSetDigest,
    reason: "Reviewed the exact source, validation results, and available evidence.",
  };
}

function withdraw(current: ReviewRunDecisionContext, targetDecisionId: string) {
  return {
    ...intent(current, "comment", `withdraw-${current.version}`),
    action: "withdraw" as const,
    targetDecisionId,
  };
}

const change = (
  f: EvidenceControlPlaneFixture,
  request: ReviewRunDecisionChangeRequest,
  actor = reviewer,
  scope = f.query,
) => bound(f, actor).request("changeReviewRunDecision", { ...scope, actor, ...request });
const rejected = (promise: Promise<unknown>, code = "PLATFORM_CONFLICT") =>
  expect(promise).rejects.toMatchObject({ code });

async function complete(
  f: EvidenceControlPlaneFixture,
  envelope: JobExecutionEnvelopeV2,
  bytes = 1024,
) {
  const assetId = await uploadEvidence(f, envelope, `decision-${envelope.job.jobId}`, bytes);
  const result: ValidationJobResultV1 = completion(envelope, [assetId]).result;
  result.modelReview = {
    state: "completed",
    result: {
      schemaVersion: "PrReviewPlanV2",
      summary: "No blocking findings were found in the synthetic review.",
      assessment: "approve",
      findings: [],
      requestedRecipeIds: [],
      verification: {
        status: "not_run",
        summary: "Actual runner checks are recorded independently.",
        commands: [],
      },
      executionEvidence: {
        schemaVersion: "ReviewExecutionEvidenceV1",
        source: "worker",
        commandCapture: "complete",
        commands: [],
        worktree: { status: "clean", source: "git_status" },
      },
    },
  };
  const sent = { ...envelope.lease, result, resultDigest: sha256(canonicalJson(result)) };
  expect(await f.client.request("completeLease", sent)).toMatchObject({ runState: "succeeded" });
  return { assetId, sent };
}

function storedResults(f: EvidenceControlPlaneFixture) {
  return f.read((database) =>
    database
      .prepare("SELECT id, result_digest, result_json FROM validation_job_results ORDER BY id")
      .all(),
  );
}

async function optionalRun(f: EvidenceControlPlaneFixture) {
  const admin = bound(f, administrator);
  for (const request of f.run.requests)
    for (const job of request.jobs)
      await admin.request("cancelValidationJob", {
        ...f.query,
        requestId: request.requestId,
        jobId: job.jobId,
        actor: administrator,
      });
  const required = present(f.run.plan.jobs[0]?.profileVersion);
  for (const job of f.run.plan.jobs.slice(1)) {
    const profile = present(job.profileVersion);
    await admin.request("saveValidationProfileBinding", {
      repositoryId: f.run.repositoryId,
      profileId: profile.profileId,
      actor: administrator,
      request: { expectedVersion: 1, enabled: false, profileVersionId: profile.id },
    });
  }
  const optional = await admin.request("publishValidationProfile", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      name: "Optional integration validation",
      workflowKind: "pr_static_build",
      target: "headless",
      required: false,
      config: required.config,
      outputSchemaVersion: "PrReviewPlanV2",
    },
  });
  await admin.request("saveValidationProfileBinding", {
    repositoryId: f.run.repositoryId,
    profileId: optional.profileId,
    actor: administrator,
    request: { expectedVersion: 0, enabled: true, profileVersionId: optional.id },
  });
  const run = await admin.request("createOperatorReviewRun", {
    repositoryId: f.run.repositoryId,
    workItemId: f.run.workItemId,
    actor: administrator,
    request: {
      activationId: "decision-optional-run",
      expectedRevisionKey: f.run.revisionKey,
      profileIds: [required.profileId, optional.profileId],
    },
  });
  const scope = { repositoryId: run.repositoryId, reviewRunId: run.id };
  return { run, scope, optionalId: optional.id };
}

async function observeRevision(f: EvidenceControlPlaneFixture, headSha: string, ordinal: number) {
  const original = f.run.plan.workItem;
  if (original.kind !== "pull_request") throw new Error("A pull request source is required.");
  const at = new Date(Date.now() + ordinal * 1000).toISOString();
  const repository = {
    githubRepositoryId: original.githubRepositoryId,
    githubNodeId: "repository-1",
    ownerLogin: "example",
    name: "project-1",
    fullName: "example/project-1",
    htmlUrl: "https://github.com/example/project-1",
    defaultBranch: "main",
    isPrivate: false,
  };
  const event: SchedulingRevisionObservedEvent = {
    contractVersion: 1,
    eventId: `decision-source-${ordinal}`,
    source: "webhook",
    sourceEventId: `decision-source-delivery-${ordinal}`,
    occurredAt: at,
    observedAt: at,
    repository,
    author: original.author,
    actor: original.author,
    target: null,
    requestKind: null,
    action: "revision_observed",
    workItem: { ...original, updatedAt: at },
    revision: {
      kind: "pull_request",
      githubRepositoryId: original.githubRepositoryId,
      githubWorkItemId: original.githubWorkItemId,
      baseSha: "a".repeat(40),
      headSha,
      revisionKey: sha256(`${"a".repeat(40)}\0${headSha}`),
      observedAt: at,
      sourceUpdatedAt: at,
    },
  };
  // This is isolated upstream-event ingestion, not a network request or a GitHub mutation.
  return f.client.request("ingestSchedulingEvent", {
    event,
    policy: f.run.plan.authorization.policy,
    schedule: null,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "pull_request",
      receivedAt: at,
      payloadSha256: sha256(canonicalJson(event)),
    },
  });
}

const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("human decisions through the real database owner and evidence verifier", () => {
  it("requires verified policy eligibility and preserves runner results after approval", async () => {
    const f = await fixture();
    const queued = await context(f);
    expect(queued).toMatchObject({ version: 0, canApprove: false, recordedDecisionState: "none" });
    await rejected(change(f, intent(queued, "approve")));
    expect((await history(f)).total).toBe(0);
    const envelope = present((await f.claimAll())[0]);
    await complete(f, envelope);
    const eligible = await context(f);
    expect(eligible).toMatchObject({
      sourceCurrent: true,
      canApprove: true,
      policy: { eligible: true },
    });
    const before = storedResults(f);
    const approved = await change(f, intent(eligible, "approve"));
    expect(approved).toMatchObject({
      replayed: false,
      change: { action: "approve", actor: reviewer, version: 1 },
    });
    expect(await context(f)).toMatchObject({
      version: 1,
      recordedDecisionState: "current",
      recordedDecision: approved.change,
      canApprove: true,
    });
    expect(storedResults(f)).toEqual(before);
    await f.restart();
    expect((await history(f)).items).toEqual([approved.change]);
  }, 30_000);

  it("requires maintainer access for overrides without changing policy eligibility", async () => {
    const f = await fixture();
    const initial = await context(f);
    const request = intent(initial, "override_approve");
    await rejected(change(f, request), "PLATFORM_FORBIDDEN");
    await grant(f, reviewer, "maintainer", 1);
    const accepted = await change(f, request);
    expect(accepted.change).toMatchObject({
      action: "override_approve",
      policyAtDecision: { eligible: false },
    });
    expect(await context(f)).toMatchObject({
      recordedDecisionState: "current",
      recordedDecision: accepted.change,
      policy: initial.policy,
      canApprove: false,
    });
    expect(await bound(f).request("getDashboardReviewRun", f.query)).toMatchObject({
      policy: initial.policy,
      execution: { queued: 0, awaitingAdmission: 1 },
    });
    await grant(f, reviewer, "reviewer", 2);
    await rejected(change(f, request), "PLATFORM_FORBIDDEN");
    expect((await history(f)).total).toBe(1);
  }, 30_000);

  it("rechecks cold and missing evidence without erasing an accepted decision or its receipt", async () => {
    const f = await fixture();
    const envelope = present((await f.claimAll())[0]);
    const { assetId } = await complete(f, envelope);
    const initial = await context(f);
    const request = intent(initial, "approve");
    const accepted = await change(f, request);
    const next = intent(await context(f), "approve", "evidence-recheck");
    const before = storedResults(f);
    await f.restart();
    await expect(change(f, next)).rejects.toMatchObject({
      code: "PLATFORM_CONFLICT",
      message: "The current verified validation policy does not allow approval.",
    });
    await expect.poll(async () => (await context(f)).canApprove, { timeout: 3000 }).toBe(true);
    await unlink(join(f.evidenceDirectory, `${assetId}.asset`));
    await rejected(change(f, next));
    const unavailable = await context(f);
    expect(unavailable).toMatchObject({
      resultSetDigest: initial.resultSetDigest,
      recordedDecisionState: "ineligible",
      recordedDecision: accepted.change,
      canApprove: false,
    });
    expect(unavailable.stateReasons).toContain("approval_policy_not_satisfied");
    expect(await change(f, request)).toEqual({ ...accepted, replayed: true });
    expect((await history(f)).total).toBe(1);
    expect(storedResults(f)).toEqual(before);
  }, 30_000);

  it("serializes concurrent intent receipts and competing versions into one accepted event", async () => {
    const f = await fixture();
    await complete(f, present((await f.claimAll())[0]));
    const request = intent(await context(f), "approve");
    const receipts = await Promise.all([change(f, request), change(f, request)]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(receipts[0]?.change).toEqual(receipts[1]?.change);
    const current = await context(f);
    const attempts = await Promise.allSettled([
      change(f, intent(current, "request_changes", "concurrent-a")),
      change(f, intent(current, "comment", "concurrent-b")),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "PLATFORM_CONFLICT" },
    });
    expect((await history(f)).total).toBe(2);
    expect((await context(f)).version).toBe(2);
  }, 30_000);

  it("keeps comments separate and withdrawal never resurrects a superseded approval", async () => {
    const f = await fixture();
    await complete(f, present((await f.claimAll())[0]));
    const approved = await change(f, intent(await context(f), "approve"));
    const changes = await change(f, intent(await context(f), "request_changes"));
    expect(changes.change.supersedesDecisionId).toBe(approved.change.id);
    const comment = await change(f, intent(await context(f), "comment"));
    expect(comment.change.supersedesDecisionId).toBeNull();
    expect(await context(f)).toMatchObject({ version: 3, recordedDecision: changes.change });
    await rejected(change(f, withdraw(await context(f), approved.change.id)));
    await rejected(change(f, withdraw(await context(f), comment.change.id)));
    const withdrawn = await change(f, withdraw(await context(f), changes.change.id));
    expect(await context(f)).toMatchObject({
      version: 4,
      recordedDecisionState: "withdrawn",
      recordedDecision: withdrawn.change,
    });
    await change(f, intent(await context(f), "comment"));
    expect(await context(f)).toMatchObject({
      version: 5,
      recordedDecisionState: "withdrawn",
      recordedDecision: withdrawn.change,
    });
    expect((await history(f)).items.map((item) => item.action)).toEqual([
      "comment",
      "withdraw",
      "comment",
      "request_changes",
      "approve",
    ]);
  }, 30_000);

  it("enforces withdrawal target ownership and current repository permissions", async () => {
    const f = await fixture();
    await grant(f, colleague, "reviewer");
    const accepted = await change(f, intent(await context(f), "request_changes"));
    const request = withdraw(await context(f), accepted.change.id);
    await rejected(change(f, request, colleague), "PLATFORM_FORBIDDEN");
    await grant(f, colleague, "maintainer", 1);
    const withdrawn = await change(f, request, colleague);
    expect(withdrawn.change.actor).toEqual(colleague);
    await grant(f, colleague, "viewer", 2);
    await rejected(change(f, request, colleague), "PLATFORM_FORBIDDEN");
    await grant(f, reviewer, null, 1);
    await rejected(history(f), "PLATFORM_NOT_FOUND");
    await rejected(context(f), "PLATFORM_NOT_FOUND");
    expect((await history(f, administrator)).total).toBe(2);
  }, 30_000);

  it("replays immutable receipts after withdrawal and rerun without replaying the old state", async () => {
    const f = await fixture();
    const envelope = present((await f.claimAll())[0]);
    await complete(f, envelope);
    const request = intent(await context(f), "approve");
    const accepted = await change(f, request);
    const withdrawal = withdraw(await context(f), accepted.change.id);
    const removed = await change(f, withdrawal);
    await bound(f).request("rerunValidationRequest", {
      ...f.query,
      requestId: envelope.validation.requestId,
      activationId: "after-withdrawal-rerun",
      actor: reviewer,
    });
    expect(await change(f, request)).toEqual({ ...accepted, replayed: true });
    expect(await change(f, withdrawal)).toEqual({ ...removed, replayed: true });
    expect((await context(f)).recordedDecision).toEqual(removed.change);
    expect((await history(f)).total).toBe(2);
    await rejected(change(f, { ...request, reason: "A conflicting retry payload." }));
    await rejected(change(f, { ...request, changeId: "new-stale-intent" }));
    await grant(f, reviewer, "viewer", 1);
    await rejected(change(f, request), "PLATFORM_FORBIDDEN");
  }, 30_000);

  it("invalidates approval immediately when an optional request is rerun", async () => {
    const f = await fixture(2);
    const { scope, optionalId } = await optionalRun(f);
    const envelopes = await f.claimAll();
    expect(envelopes.map((item) => item.validation.profileVersion.id)).toContain(optionalId);
    for (const envelope of envelopes) await complete(f, envelope);
    const before = await context(f, reviewer, scope);
    expect(before.policy, JSON.stringify(before.policy)).toMatchObject({ eligible: true });
    const request = intent(before, "approve");
    const accepted = await change(f, request, reviewer, scope);
    const optional = present(
      envelopes.find((item) => item.validation.profileVersion.id === optionalId),
    );
    await bound(f).request("rerunValidationRequest", {
      ...scope,
      requestId: optional.validation.requestId,
      activationId: "optional-rerun",
      actor: reviewer,
    });
    const after = await context(f, reviewer, scope);
    expect(after.resultSetDigest).not.toBe(before.resultSetDigest);
    expect(after).toMatchObject({
      policy: { eligible: true },
      recordedDecisionState: "stale",
      recordedDecision: accepted.change,
    });
    expect(after.stateReasons).toContain("result_set_changed");
    expect(await change(f, request, reviewer, scope)).toEqual({ ...accepted, replayed: true });
    await rejected(
      change(
        f,
        { ...request, changeId: "stale-after-optional-rerun", expectedVersion: 1 },
        reviewer,
        scope,
      ),
    );
    expect((await history(f, reviewer, scope)).total).toBe(1);
  }, 30_000);

  it.each(["revoke", "rerun"] as const)(
    "does not commit an approval when %s occurs during real evidence verification",
    async (mutation) => {
      const f = await fixture();
      const envelope = present((await f.claimAll())[0]);
      await complete(f, envelope, 32 * 1024 * 1024);
      const current = await context(f);
      expect(current.canApprove).toBe(true);
      const request = intent(current, "approve");
      const order: string[] = [];
      const pending = change(f, request)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        .then((outcome) => {
          order.push("decision");
          return outcome;
        });
      const progress = f.client.request("ping", {}).then(() => {
        order.push("ping");
      });
      const changed = (
        mutation === "revoke"
          ? grant(f, reviewer, null, 1)
          : bound(f, administrator).request("rerunValidationRequest", {
              ...f.query,
              requestId: envelope.validation.requestId,
              activationId: "during-decision-verification",
              actor: administrator,
            })
      ).then(() => {
        order.push(mutation);
      });
      await progress;
      await changed;
      const outcome = await pending;
      expect(order.indexOf("ping"), JSON.stringify({ order, outcome })).toBeLessThan(
        order.indexOf("decision"),
      );
      expect(order.indexOf(mutation)).toBeLessThan(order.indexOf("decision"));
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("A stale approval was committed.");
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          code:
            mutation === "revoke"
              ? expect.stringMatching(/^PLATFORM_(?:NOT_FOUND|FORBIDDEN)$/u)
              : "PLATFORM_CONFLICT",
        }),
      );
      expect((await history(f, administrator)).total).toBe(0);
      expect(storedResults(f)).toHaveLength(1);
    },
    60_000,
  );

  it("does not revive a manual approval after source A changes to B and returns to A", async () => {
    const f = await fixture();
    await complete(f, present((await f.claimAll())[0]));
    const original = await context(f);
    const accepted = await change(f, intent(original, "approve"));
    await observeRevision(f, "c".repeat(40), 1);
    expect(await context(f)).toMatchObject({
      sourceCurrent: false,
      recordedDecisionState: "stale",
    });
    await observeRevision(f, "b".repeat(40), 2);
    const returned = await context(f);
    expect(returned.revisionKey).toBe(returned.currentRevisionKey);
    expect(returned.resultSetDigest).not.toBe(original.resultSetDigest);
    expect(returned).toMatchObject({
      sourceCurrent: true,
      recordedDecisionState: "stale",
      recordedDecision: accepted.change,
    });
    expect(returned.stateReasons).toContain("result_set_changed");
    expect((await history(f)).total).toBe(1);
  }, 30_000);
});

import { unlink } from "node:fs/promises";
import { join } from "node:path";
