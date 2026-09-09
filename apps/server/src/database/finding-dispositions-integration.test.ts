import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  IssueTriageV2ModelOutputSchema,
  type PrReviewFindingV1,
  type ValidationJobResultV1,
} from "@agentic-review/codex";
import type {
  FindingDispositionAction,
  FindingDispositionChangeRequest,
  FindingListResponse,
  JobExecutionEnvelopeV2,
  OperatorPrincipal,
  OperatorRepositoryRole,
  ReviewRunDecisionContext,
  SchedulingRequestOpenedEvent,
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
  subject: "finding-integration-admin",
};
const reviewer: OperatorPrincipal = { issuer: administrator.issuer, subject: "finding-reviewer" };
const fixtures: EvidenceControlPlaneFixture[] = [];
const bound = (f: EvidenceControlPlaneFixture, actor = reviewer) =>
  bindOperatorDatabase(f.client, actor);
type ResultScope = {
  repositoryId: string;
  reviewRunId: string;
  requestId: string;
  jobId: string;
};
const runScope = (envelope: JobExecutionEnvelopeV2) => ({
  repositoryId: envelope.validation.repositoryId,
  reviewRunId: envelope.validation.runId,
});
const resultScope = (envelope: JobExecutionEnvelopeV2): ResultScope => ({
  ...runScope(envelope),
  requestId: envelope.validation.requestId,
  jobId: envelope.job.jobId,
});
afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((f) => f.dispose()));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Finding fixture cleanup failed.",
    );
});

function grant(
  f: EvidenceControlPlaneFixture,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
) {
  return bound(f, administrator).request("changeRepositoryAccess", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      changeId: `finding-access-${expectedVersion}-${role}`,
      principal: reviewer,
      role,
      expectedVersion,
      reason: "Verify current permissions for finding dispositions.",
    },
  });
}
async function fixture(profileCount = 1) {
  const f = await createEvidenceControlPlaneFixture(profileCount, [administrator]);
  fixtures.push(f);
  await grant(f, "reviewer");
  return f;
}
function finding(id = "blocking", overrides: Partial<PrReviewFindingV1> = {}): PrReviewFindingV1 {
  return {
    findingId: id,
    title: "Guard the missing resource",
    body: "The acquired resource must be checked before it is dereferenced.",
    priority: 1,
    path: "src/settings.ts",
    line: 12,
    endLine: 14,
    confidence: 0.9,
    ...overrides,
  };
}
async function complete(
  f: EvidenceControlPlaneFixture,
  envelope: JobExecutionEnvelopeV2,
  findings: PrReviewFindingV1[] = [finding()],
  options: {
    bytes?: number;
    failedCheck?: boolean;
    modelUnavailable?: boolean;
    issueObservation?: boolean;
  } = {},
) {
  const assetId = await uploadEvidence(
    f,
    envelope,
    `finding-${envelope.job.jobId}`,
    options.bytes ?? 1024,
  );
  const base = completion(envelope, [assetId]).result;
  if (options.failedCheck) {
    present(base.report.checks[0]).outcome = "failed";
    present(base.report.checks[0]).actual = "Exit code 1";
    present(base.execution.diagnostics[0]).outcome = "failed";
    present(base.execution.diagnostics[0]).exitCode = 1;
  }
  const result: ValidationJobResultV1 = options.issueObservation
    ? {
        ...base,
        report: {
          ...base.report,
          workItemKind: "issue",
          reproductionConclusion: "inconclusive",
          modelSummary: {
            schemaVersion: "ValidationSummaryV1",
            workItemKind: "issue",
            summary: "The model suggests investigating an observed resource failure.",
            reproductionConclusion: "inconclusive",
            observations: [
              {
                id: "observation",
                title: "Inspect resource ownership",
                body: "Ownership is unclear in the observed execution.",
                priority: 1,
                path: null,
                line: null,
              },
            ],
          },
        },
        modelReview: { state: "not_requested" },
      }
    : {
        ...base,
        modelReview: options.modelUnavailable
          ? { state: "not_requested" }
          : {
              state: "completed",
              result: {
                schemaVersion: "PrReviewPlanV2",
                summary: "Synthetic static review findings.",
                assessment: findings.some((item) => item.priority < 2)
                  ? "request_changes"
                  : "approve",
                findings,
                requestedRecipeIds: [],
                verification: {
                  status: "not_run",
                  summary: "Runner checks are independent.",
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
            },
      };
  const submitted = { ...envelope.lease, result, resultDigest: sha256(canonicalJson(result)) };
  expect(await f.client.request("completeLease", submitted)).toMatchObject({
    runState: "succeeded",
  });
  return { assetId, submitted };
}
const list = (f: EvidenceControlPlaneFixture, scope: ResultScope, actor = reviewer) =>
  bound(f, actor).request("listFindingOccurrences", { ...scope, actor, page: 1, pageSize: 20 });
const decision = (f: EvidenceControlPlaneFixture, scope = f.query) =>
  bound(f).request("getReviewRunDecisionContext", { ...scope, actor: reviewer });
const decisionHistory = (f: EvidenceControlPlaneFixture, scope = f.query) =>
  bound(f).request("listReviewRunDecisionHistory", { ...scope, actor: reviewer });
function approve(f: EvidenceControlPlaneFixture, current: ReviewRunDecisionContext) {
  return bound(f).request("changeReviewRunDecision", {
    repositoryId: current.repositoryId,
    reviewRunId: current.reviewRunId,
    actor: reviewer,
    changeId: `approve-${current.version}`,
    action: "approve",
    expectedVersion: current.version,
    expectedRevisionKey: current.revisionKey,
    expectedPlanDigest: current.planDigest,
    expectedResultSetDigest: current.resultSetDigest,
    reason: "Reviewed current evidence and explicit finding dispositions.",
  });
}
function dispositionInput(
  current: FindingListResponse,
  action: FindingDispositionAction,
  ordinal = 0,
) {
  const item = present(current.items.find((item) => item.ordinal === ordinal));
  return {
    occurrenceKey: item.key,
    changeId: `${item.key}-${item.disposition.version}-${action}`,
    expectedVersion: item.disposition.version,
    expectedResultDigest: current.context.resultDigest,
    expectedContextDigest: current.context.contextDigest,
    kind: item.kind,
    ordinal: item.ordinal,
    action,
    reason: "Assessed the exact immutable finding and its current execution context.",
  } satisfies FindingDispositionChangeRequest & { occurrenceKey: string };
}
const change = (
  f: EvidenceControlPlaneFixture,
  scope: ResultScope,
  input: ReturnType<typeof dispositionInput>,
) => bound(f).request("changeFindingDisposition", { ...scope, actor: reviewer, ...input });
const history = (f: EvidenceControlPlaneFixture, scope: ResultScope, occurrenceKey: string) =>
  bound(f).request("getFindingDispositionHistory", { ...scope, occurrenceKey, actor: reviewer });
const rejected = (promise: Promise<unknown>, code = "PLATFORM_CONFLICT") =>
  expect(promise).rejects.toMatchObject({ code });
function rawResults(f: EvidenceControlPlaneFixture) {
  return f.read((database) =>
    database
      .prepare("SELECT id, result_digest, result_json FROM validation_job_results ORDER BY id")
      .all(),
  );
}
async function rerun(
  f: EvidenceControlPlaneFixture,
  scope: ResultScope,
  activationId = "finding-rerun",
) {
  await bound(f).request("rerunValidationRequest", {
    repositoryId: scope.repositoryId,
    reviewRunId: scope.reviewRunId,
    requestId: scope.requestId,
    activationId,
    actor: reviewer,
  });
  return present((await f.claimAll())[0]);
}
const compare = (f: EvidenceControlPlaneFixture, before: ResultScope, after: ResultScope) =>
  bound(f).request("compareFindingResults", {
    ...after,
    actor: reviewer,
    beforeReviewRunId: before.reviewRunId,
    beforeRequestId: before.requestId,
    beforeJobId: before.jobId,
    page: 1,
    pageSize: 20,
  });
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
      name: "Optional finding validation",
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
      activationId: "finding-optional-run",
      expectedRevisionKey: f.run.revisionKey,
      profileIds: [required.profileId, optional.profileId],
    },
  });
  return {
    scope: { repositoryId: run.repositoryId, reviewRunId: run.id },
    optionalId: optional.id,
  };
}

async function issueRun(f: EvidenceControlPlaneFixture) {
  const admin = bound(f, administrator);
  for (const request of f.run.requests)
    for (const job of request.jobs)
      await admin.request("cancelValidationJob", {
        ...f.query,
        requestId: request.requestId,
        jobId: job.jobId,
        actor: administrator,
      });
  const author = f.run.plan.workItem.author;
  const at = new Date().toISOString();
  const revisionKey = sha256(
    JSON.stringify([
      "Investigate a resource failure",
      "Synthetic issue observation fixture.",
      "open",
      at,
    ]),
  );
  const event: SchedulingRequestOpenedEvent = {
    contractVersion: 1,
    eventId: "finding-issue",
    source: "webhook",
    sourceEventId: "finding-issue-delivery",
    occurredAt: at,
    observedAt: at,
    repository: {
      githubRepositoryId: 1,
      githubNodeId: "repository-1",
      ownerLogin: "example",
      name: "project-1",
      fullName: "example/project-1",
      htmlUrl: "https://github.com/example/project-1",
      defaultBranch: "main",
      isPrivate: false,
    },
    workItem: {
      kind: "issue",
      githubRepositoryId: 1,
      githubWorkItemId: 1002,
      githubNodeId: "ISSUE_1002",
      number: 2,
      title: "Investigate a resource failure",
      body: "Synthetic issue observation fixture.",
      state: "open",
      author,
      htmlUrl: "https://github.com/example/project-1/issues/2",
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    },
    revision: {
      kind: "issue",
      githubRepositoryId: 1,
      githubWorkItemId: 1002,
      revisionKey,
      contentDigest: revisionKey,
      observedAt: at,
      sourceUpdatedAt: at,
    },
    author,
    actor: author,
    target: author,
    action: "request_opened",
    requestKind: "assignment",
  };
  const ingested = await f.client.request("ingestSchedulingEvent", {
    event,
    policy: f.run.plan.authorization.policy,
    schedule: {
      jobKind: "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 1,
      // This fixture executes the explicit validation lane; the legacy job stays unclaimed.
      requiredCapabilities: ["legacy-triage"],
      executionTemplate: {
        repository: { githubRepositoryId: 1, fullName: event.repository.fullName },
        resource: {
          kind: "issue",
          githubNodeId: event.workItem.githubNodeId,
          number: 2,
          title: event.workItem.title,
          author,
          canonicalSnapshot: event.workItem,
          revisionDigest: revisionKey,
        },
        prompt: {
          name: "Issue triage",
          version: "fixture",
          renderedPrompt: "Triage this synthetic issue.",
          promptSha256: sha256("Triage this synthetic issue."),
          outputSchema: IssueTriageV2ModelOutputSchema,
          outputSchemaSha256: sha256(canonicalJson(IssueTriageV2ModelOutputSchema)),
        },
        executionPolicy: {
          hardTimeoutMs: 120_000,
          noProgressTimeoutMs: 30_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "issues",
      receivedAt: at,
      payloadSha256: sha256(canonicalJson(event)),
    },
  });
  expect(ingested.authorized).toBe(true);
  const template = await admin.request("createPromptTemplate", {
    actor: administrator,
    request: {
      name: "Issue observations",
      workflowKind: "issue_validation",
      content: "Summarize the independent measurements.",
      outputSchemaVersion: "ValidationSummaryV1",
    },
  });
  const prompt = await admin.request("publishPromptDraft", {
    templateId: template.id,
    actor: administrator,
    request: { expectedVersion: template.version },
  });
  await admin.request("savePromptBinding", {
    repositoryId: f.run.repositoryId,
    workflowKind: "issue_validation",
    actor: administrator,
    request: { expectedVersion: 0, promptVersionId: prompt.id },
  });
  const profile = await admin.request("publishValidationProfile", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      name: "Issue headless observation",
      workflowKind: "issue_validation",
      target: "headless",
      required: true,
      config: present(f.run.plan.jobs[0]?.profileVersion).config,
      outputSchemaVersion: "ValidationReportV1",
    },
  });
  await admin.request("saveValidationProfileBinding", {
    repositoryId: f.run.repositoryId,
    profileId: profile.profileId,
    actor: administrator,
    request: { expectedVersion: 0, enabled: true, profileVersionId: profile.id },
  });
  return admin.request("createOperatorReviewRun", {
    repositoryId: f.run.repositoryId,
    workItemId: ingested.workItemId,
    actor: administrator,
    request: {
      activationId: "finding-issue-run",
      expectedRevisionKey: revisionKey,
      testedSourceCommit: "b".repeat(40),
    },
  });
}

const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe(
  "finding dispositions through the real database owner and accepted worker results",
  () => {
    it("keeps accepted P1 findings blocking, permits dismissal, and invalidates approval on reopen", async () => {
      const f = await fixture();
      const envelope = present((await f.claimAll())[0]);
      await complete(f, envelope, [
        finding("advice", {
          priority: 2,
          title: "Document ownership",
          body: "Explain ownership.\n".repeat(80),
        }),
        finding(),
      ]);
      const scope = resultScope(envelope);
      const before = rawResults(f);
      const first = await list(f, scope);
      expect(first.summary).toMatchObject({ rawBlocking: 1, unresolvedBlocking: 1, open: 2 });
      expect(present(first.items.find((item) => item.modelId === "blocking")).ordinal).toBe(1);
      expect(
        present(first.items.find((item) => item.modelId === "advice")).body.length,
      ).toBeGreaterThan(512);
      await change(f, scope, dispositionInput(first, "accept", 1));
      expect((await list(f, scope)).summary).toMatchObject({
        rawBlocking: 1,
        unresolvedBlocking: 1,
        accepted: 1,
      });
      await rejected(approve(f, await decision(f)));
      await change(f, scope, dispositionInput(await list(f, scope), "dismiss", 1));
      const eligible = await decision(f);
      expect(eligible.policy).toMatchObject({
        eligible: true,
        blockingFindingCount: 1,
        unresolvedBlockingFindingCount: 0,
      });
      const approved = await approve(f, eligible);
      await change(f, scope, dispositionInput(await list(f, scope), "reopen", 1));
      expect(await decision(f)).toMatchObject({
        recordedDecisionState: "stale",
        recordedDecision: approved.change,
        policy: { eligible: false, blockingFindingCount: 1, unresolvedBlockingFindingCount: 1 },
      });
      expect(rawResults(f)).toEqual(before);
      expect(
        (
          await history(f, scope, present(first.items.find((item) => item.ordinal === 1)).key)
        ).items.map((item) => item.action),
      ).toEqual(["reopen", "dismiss", "accept"]);
    }, 30_000);

    it.each(["failed_check", "missing_evidence"] as const)(
      "resolving a finding cannot repair %s",
      async (failure) => {
        const f = await fixture();
        const envelope = present((await f.claimAll())[0]);
        const { assetId } = await complete(f, envelope, [finding()], {
          failedCheck: failure === "failed_check",
        });
        const scope = resultScope(envelope);
        const before = rawResults(f);
        await change(f, scope, dispositionInput(await list(f, scope), "resolve"));
        if (failure === "missing_evidence")
          await unlink(join(f.evidenceDirectory, `${assetId}.asset`));
        const current = await decision(f);
        expect(current.policy).toMatchObject({
          eligible: false,
          blockingFindingCount: 1,
          unresolvedBlockingFindingCount: 0,
        });
        await rejected(approve(f, current));
        expect((await list(f, scope)).summary).toMatchObject({
          resolved: 1,
          rawBlocking: 1,
          unresolvedBlocking: 0,
        });
        expect(rawResults(f)).toEqual(before);
      },
      30_000,
    );

    it("includes P1 findings from optional requests in the current approval policy", async () => {
      const f = await fixture(2);
      const { scope, optionalId } = await optionalRun(f);
      const envelopes = await f.claimAll();
      const optional = present(
        envelopes.find((item) => item.validation.profileVersion.id === optionalId),
      );
      for (const envelope of envelopes)
        await complete(f, envelope, envelope === optional ? [finding()] : []);
      expect((await decision(f, scope)).policy).toMatchObject({
        eligible: false,
        blockingFindingCount: 1,
        unresolvedBlockingFindingCount: 1,
      });
      const selected = resultScope(optional);
      await change(f, selected, dispositionInput(await list(f, selected), "dismiss"));
      const eligible = await decision(f, scope);
      expect(eligible.canApprove).toBe(true);
      expect((await approve(f, eligible)).change.action).toBe("approve");
    }, 30_000);

    it("replays immutable receipts with current authorization and rejects stale CAS or conflicting intent", async () => {
      const f = await fixture();
      const envelope = present((await f.claimAll())[0]);
      await complete(f, envelope);
      const scope = resultScope(envelope);
      const first = await list(f, scope);
      const request = dispositionInput(first, "dismiss");
      const results = await Promise.all([change(f, scope, request), change(f, scope, request)]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.change).toEqual(results[1]?.change);
      const receipt = present(results[0]);
      await change(f, scope, dispositionInput(await list(f, scope), "reopen"));
      expect(await change(f, scope, request)).toEqual({ ...receipt, replayed: true });
      await rejected(change(f, scope, { ...request, changeId: "stale-disposition-cas" }));
      await rejected(change(f, scope, { ...request, reason: "Conflicting retry content." }));
      await rejected(change(f, { ...scope, requestId: "foreign-request" }, request));
      await grant(f, "viewer", 1);
      await rejected(change(f, scope, request), "PLATFORM_FORBIDDEN");
      expect((await history(f, scope, request.occurrenceKey)).total).toBe(2);
      await grant(f, null, 2);
      await rejected(list(f, scope), "PLATFORM_NOT_FOUND");
      await rejected(history(f, scope, request.occurrenceKey), "PLATFORM_NOT_FOUND");
    }, 30_000);

    it("does not inherit dispositions after rerun or let historical edits alter current approval", async () => {
      const f = await fixture();
      const firstEnvelope = present((await f.claimAll())[0]);
      await complete(f, firstEnvelope);
      const firstScope = resultScope(firstEnvelope);
      const original = await list(f, firstScope);
      const dismissed = dispositionInput(original, "dismiss");
      const receipt = await change(f, firstScope, dismissed);
      const oldCurrent = await list(f, firstScope);
      const newer = await rerun(f, firstScope);
      await rejected(change(f, firstScope, dispositionInput(oldCurrent, "reopen")));
      expect(await change(f, firstScope, dismissed)).toEqual({ ...receipt, replayed: true });
      await complete(f, newer, [finding("different-model-id", { line: 120, endLine: 124 })]);
      const newerScope = resultScope(newer);
      const fresh = await list(f, newerScope);
      expect(fresh.items[0]).toMatchObject({ disposition: { state: "open", version: 0 } });
      expect(fresh.items[0]?.key).not.toBe(original.items[0]?.key);
      await change(f, newerScope, dispositionInput(fresh, "dismiss"));
      const approved = await approve(f, await decision(f));
      const currentBefore = await decision(f);
      const historical = await list(f, firstScope);
      expect(historical.context).toMatchObject({ historical: true, latestForRequest: false });
      const edited = await change(f, firstScope, dispositionInput(historical, "reopen"));
      expect(edited.change.latestForRequestAtChange).toBe(false);
      expect(await decision(f)).toMatchObject({
        resultSetDigest: currentBefore.resultSetDigest,
        recordedDecisionState: "current",
        recordedDecision: approved.change,
      });
      expect((await list(f, newerScope)).summary).toMatchObject({
        dismissed: 1,
        unresolvedBlocking: 0,
      });
    }, 30_000);

    it("compares accepted results by unique content while leaving ambiguous and absent findings explicit", async () => {
      const f = await fixture();
      const firstEnvelope = present((await f.claimAll())[0]);
      await complete(f, firstEnvelope, [
        finding("persistent"),
        finding("absent", { title: "Release the handle", body: "An early return leaks a handle." }),
        finding("ambiguous-1", { title: "Shared title", body: "Identical content." }),
        finding("ambiguous-2", { title: "Shared title", body: "Identical content." }),
      ]);
      const before = resultScope(firstEnvelope);
      const newer = await rerun(f, before);
      await complete(f, newer, [
        finding("new-model-id", { line: 88, endLine: 90 }),
        finding("new", { title: "Reject empty input", body: "Empty input fails validation." }),
        finding("new-ambiguous-1", { title: "Shared title", body: "Identical content." }),
        finding("new-ambiguous-2", { title: "Shared title", body: "Identical content." }),
      ]);
      const after = resultScope(newer);
      const comparison = await compare(f, before, after);
      expect(comparison).toMatchObject({ compatible: true, reasons: [], total: 7 });
      expect(comparison.items.filter((item) => item.status === "persistent")).toMatchObject([
        { before: { ordinal: 0, line: 12 }, after: { ordinal: 0, line: 88 } },
      ]);
      expect(comparison.items.filter((item) => item.status === "not_observed_again")).toHaveLength(
        1,
      );
      expect(comparison.items.filter((item) => item.status === "new")).toHaveLength(1);
      expect(comparison.items.filter((item) => item.reason === "ambiguous_match")).toHaveLength(4);
      expect((await list(f, before)).summary).toMatchObject({ open: 4, resolved: 0 });
      expect((await list(f, after)).summary).toMatchObject({ open: 4, resolved: 0 });
    }, 30_000);

    it.each(["model_unavailable", "configuration_changed"] as const)(
      "does not infer resolution when %s prevents comparison",
      async (reason) => {
        const f = await fixture();
        const firstEnvelope = present((await f.claimAll())[0]);
        await complete(f, firstEnvelope);
        const before = resultScope(firstEnvelope);
        let newer: JobExecutionEnvelopeV2;
        if (reason === "model_unavailable") newer = await rerun(f, before);
        else {
          const admin = bound(f, administrator);
          const template = await admin.request("createPromptTemplate", {
            actor: administrator,
            request: {
              name: "Changed review prompt",
              workflowKind: "pr_static_build",
              content: "Review a changed synthetic prompt configuration.",
              outputSchemaVersion: "PrReviewPlanV2",
            },
          });
          const prompt = await admin.request("publishPromptDraft", {
            templateId: template.id,
            actor: administrator,
            request: { expectedVersion: template.version },
          });
          await admin.request("savePromptBinding", {
            repositoryId: f.run.repositoryId,
            workflowKind: "pr_static_build",
            actor: administrator,
            request: { expectedVersion: 1, promptVersionId: prompt.id },
          });
          await admin.request("createOperatorReviewRun", {
            repositoryId: f.run.repositoryId,
            workItemId: f.run.workItemId,
            actor: administrator,
            request: { activationId: "changed-prompt-run", expectedRevisionKey: f.run.revisionKey },
          });
          newer = present((await f.claimAll())[0]);
        }
        await complete(f, newer, [], { modelUnavailable: reason === "model_unavailable" });
        const comparison = await compare(f, before, resultScope(newer));
        expect(comparison.compatible).toBe(false);
        expect(comparison.reasons).toContain(reason);
        expect(comparison.items).toMatchObject([{ status: "incomparable", reason }]);
        expect((await list(f, before)).summary.resolved).toBe(0);
      },
      30_000,
    );

    it("records Issue validation observations independently of reproduction conclusions", async () => {
      const f = await fixture();
      const run = await issueRun(f);
      const envelope = present((await f.claimAll())[0]);
      expect(envelope.validation.runId).toBe(run.id);
      await complete(f, envelope, [], { issueObservation: true });
      const scope = resultScope(envelope);
      const original = rawResults(f);
      const occurrences = await list(f, scope);
      expect(occurrences.context).toMatchObject({
        workItemKind: "issue",
        workflowKind: "issue_validation",
        modelAvailability: "complete",
      });
      expect(occurrences.items).toMatchObject([
        { kind: "validation_observation", ordinal: 0, path: null, line: null },
      ]);
      await change(f, scope, dispositionInput(occurrences, "resolve"));
      expect((await list(f, scope)).summary).toMatchObject({ resolved: 1, unresolvedBlocking: 0 });
      expect(await decision(f, runScope(envelope))).toMatchObject({
        workItemKind: "issue",
        canApprove: false,
        policy: { applicable: false },
      });
      expect(rawResults(f)).toEqual(original);
      const result = await bound(f).request("getDashboardReviewRunJobResult", scope);
      expect(result?.report).toMatchObject({ reproductionConclusion: "inconclusive" });
    }, 30_000);

    it("rejects old-basis approval when a finding reopens during real 32 MiB evidence verification", async () => {
      const f = await fixture(2);
      const { scope, optionalId } = await optionalRun(f);
      const envelopes = await f.claimAll();
      const active = present(
        envelopes.find((item) => item.validation.profileVersion.id === optionalId),
      );
      const completed = present(envelopes.find((item) => item !== active));
      await complete(f, completed, [finding()], { bytes: 32 * 1024 * 1024 });
      const selected = resultScope(completed);
      await change(f, selected, dispositionInput(await list(f, selected), "dismiss"));
      const eligible = await decision(f, scope);
      expect(eligible.canApprove).toBe(true);
      const reopen = dispositionInput(await list(f, selected), "reopen");
      const order: string[] = [];
      const pending = approve(f, eligible)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        .then((outcome) => {
          order.push("approval");
          return outcome;
        });
      const heartbeat = f.heartbeat(active).then((value) => {
        order.push("heartbeat");
        return value;
      });
      const changed = change(f, selected, reopen).then((value) => {
        order.push("reopen");
        return value;
      });
      expect(await heartbeat).toMatchObject({ command: "continue" });
      expect((await changed).change.state).toBe("open");
      const outcome = await pending;
      expect(order.indexOf("heartbeat"), JSON.stringify(order)).toBeLessThan(
        order.indexOf("approval"),
      );
      expect(order.indexOf("reopen"), JSON.stringify(order)).toBeLessThan(
        order.indexOf("approval"),
      );
      expect(outcome).toMatchObject({ status: "rejected", reason: { code: "PLATFORM_CONFLICT" } });
      expect((await decisionHistory(f, scope)).total).toBe(0);
      expect((await decision(f, scope)).policy).toMatchObject({
        eligible: false,
        unresolvedBlockingFindingCount: 1,
      });
      expect(await f.heartbeat(active, 2)).toMatchObject({ command: "continue" });
      expect(rawResults(f)).toHaveLength(1);
    }, 60_000);
  },
);
