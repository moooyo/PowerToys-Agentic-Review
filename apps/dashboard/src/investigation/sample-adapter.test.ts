import {
  ActionContextV1Schema,
  InvestigationActionIntentV1Schema,
  InvestigationArtifactMetadataV1Schema,
  type InvestigationCommentDelivery,
  InvestigationCommentDeliveryListSchema,
  InvestigationCommentPublicationListSchema,
  InvestigationCommentPublicationSummarySchema,
  InvestigationFindingsPageV1Schema,
  type InvestigationFindingV1,
  InvestigationReportHeaderV1Schema,
  InvestigationResultV1Schema,
  InvestigationTaskV1Schema,
} from "@agentic-review/contracts";
import { FormatRegistry, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InvestigationApi,
  type PrepareActionInput,
  RepositoryAutoReplySchema,
  RepositoryAutoReplySettingsSchema,
  RepositoryProgressReplySchema,
  RepositorySchema,
  RepositoryWebhookSettingsSchema,
  TaskDetailSchema,
  type UpdateRepositoryAutoReplySettingsInput,
  type UpdateRepositoryWebhookSettingsInput,
  WorkItemSchema,
} from "./api";
import { createSampleInvestigationApi, sampleCommentDeliveryView } from "./sample-adapter";
import {
  sampleAutoReplyProgressTemplates,
  sampleIssueAutoReplyTemplate,
  samplePullRequestAutoReplyTemplate,
} from "./sample-auto-reply-templates";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const repositoryId = "repo-powertoys-fork";
const seeds = ["sample-pr-p1", "sample-pr-p0", "sample-pr-partial", "sample-bug", "sample-feature"];
const RepositoryListSchema = Type.Object(
  { items: Type.Array(RepositorySchema) },
  { additionalProperties: false },
);
const WorkItemListSchema = Type.Object(
  { items: Type.Array(WorkItemSchema) },
  { additionalProperties: false },
);
const TaskListSchema = Type.Object(
  { items: Type.Array(InvestigationTaskV1Schema) },
  { additionalProperties: false },
);
const fetcher = vi.fn<typeof fetch>();

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("A required sample value is missing.");
  return value;
}

function expectSchema(schema: TSchema, value: unknown): void {
  expect(Value.Check(schema, value)).toBe(true);
}

async function feedbackInput(
  api: InvestigationApi,
  findingIndices: readonly number[],
  includeSummary = false,
): Promise<PrepareActionInput> {
  const report = await api.exportReport("sample-pr-p1-report");
  const context = await api.actionContext("sample-pr-p1-work-item", report.id);
  const findings = findingIndices.map((index) => required(report.findings[index]));
  return {
    idempotencyKey: "sample-selected-feedback",
    workItemId: context.workItemId,
    action: findings.some((finding) => finding.feedbackDraft.suggestion !== null)
      ? "suggestion-comment"
      : "comment",
    subjectRef: report.context.task.subjectRef,
    expectedRevisionKey: context.target.revisionKey,
    expectedHeadSha: context.target.headSha,
    reportRef: context.reportRef,
    payload: {
      kind: "feedback",
      body: "Only the explicitly selected feedback is included.",
      findingIds: findings.map((finding) => finding.id),
      drafts: [
        ...findings.map((finding) => finding.feedbackDraft),
        ...(includeSummary ? [required(report.feedbackDrafts[0])] : []),
      ],
    },
  };
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(new Error("Sample tests must never dispatch network requests."));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  try {
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("sample investigation read contracts", () => {
  it("keeps historical report content stable when current artifact bytes are unavailable", async () => {
    const api = createSampleInvestigationApi();
    for (const [seed, availability] of [
      ["sample-pr-partial", "expired"],
      ["sample-pr-p1", "missing"],
    ] as const) {
      const report = await api.exportReport(`${seed}-report`);
      const artifact = required(report.artifacts[0]);
      const metadata = await api.artifact(artifact.id);
      expectSchema(InvestigationArtifactMetadataV1Schema, metadata);
      expect(artifact.availability).toBe("available");
      expect(metadata.artifact.availability).toBe(availability);
      expect(metadata.expiredAt !== null).toBe(availability === "expired");
      metadata.artifact.availability = "available";
      expect((await api.artifact(artifact.id)).artifact.availability).toBe(availability);
      expect(await api.exportReport(report.id)).toEqual(report);
    }
    await expect(api.artifact("missing-artifact")).rejects.toMatchObject({ status: 404 });
  });

  it("returns all five isolated scenarios through the structured list and detail contracts", async () => {
    const api = createSampleInvestigationApi();
    const repositories = await api.repositories();
    const workItems = await api.workItems(repositoryId);
    const tasks = await api.tasks();
    expectSchema(RepositoryListSchema, repositories);
    expectSchema(WorkItemListSchema, workItems);
    expectSchema(TaskListSchema, tasks);
    expect(repositories.items.map((repository) => repository.id)).toContain(repositoryId);
    expect(new Set(workItems.items.map((item) => item.id))).toEqual(
      new Set(seeds.map((seed) => `${seed}-work-item`)),
    );
    expect(new Set(tasks.items.map((task) => task.id))).toEqual(
      new Set(seeds.map((seed) => `${seed}-task`)),
    );

    for (const seed of seeds) {
      const workItem = await api.workItem(`${seed}-work-item`);
      const filteredTasks = await api.tasks(workItem.id);
      const detail = await api.task(`${seed}-task`);
      const header = await api.report(`${seed}-report`);
      const report = await api.exportReport(header.id);
      const context = await api.actionContext(workItem.id, header.id);
      expectSchema(WorkItemSchema, workItem);
      expectSchema(TaskListSchema, filteredTasks);
      expectSchema(TaskDetailSchema, detail);
      expectSchema(InvestigationReportHeaderV1Schema, header);
      expectSchema(InvestigationResultV1Schema, report);
      expectSchema(ActionContextV1Schema, context);
      expect(filteredTasks.items.map((task) => task.id)).toEqual([`${seed}-task`]);
      expect(detail.task.workItem.id).toBe(workItem.id);
      expect(detail.latestReport?.id).toBe(header.id);
      expect(header.context.repository.id).toBe(repositoryId);
      expect(header.context.workItem.id).toBe(workItem.id);
      expect(header.report.collections.findings).toBe(report.findings.length);
      expect(header).not.toHaveProperty("findings");
      expect(context.reportRef).toEqual(detail.task.latestReportRef);

      const findings: InvestigationFindingV1[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.findings(header.id, cursor, 25);
        expectSchema(InvestigationFindingsPageV1Schema, page);
        expect(page.reportRef).toEqual(context.reportRef);
        expect(page.total).toBe(report.findings.length);
        expect(page.offset).toBe(findings.length);
        expect(page.items.length).toBeLessThanOrEqual(25);
        findings.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      expect(findings).toEqual(report.findings);
    }
  });

  it("filters work items without crossing repository or work item boundaries", async () => {
    const api = createSampleInvestigationApi();
    const pullRequests = await api.workItems(repositoryId, "pull_request");
    const issues = await api.workItems(repositoryId, "issue");
    expect(pullRequests.items).toHaveLength(3);
    expect(pullRequests.items.every((item) => item.kind === "pull_request")).toBe(true);
    expect(issues.items).toHaveLength(2);
    expect(issues.items.every((item) => item.kind === "issue")).toBe(true);
    expect(await api.workItems("missing-repository")).toEqual({ items: [] });
    expect(await api.tasks("missing-work-item")).toEqual({ items: [] });
  });

  it("blocks approval using a P0 on the second page before that page is loaded", async () => {
    const api = createSampleInvestigationApi();
    const firstPage = await api.findings("sample-pr-p0-report");
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.items.every((finding) => finding.priority === "P2")).toBe(true);
    const context = await api.actionContext("sample-pr-p0-work-item", "sample-pr-p0-report");
    expect(
      required(context.fixedActions.find((action) => action.action === "approve")).allowed,
    ).toBe(false);
    const merge = required(context.fixedActions.find((action) => action.action === "merge"));
    expect(merge.allowed).toBe(true);
    expect(merge.guards.map((guard) => guard.code)).not.toContain("no_original_pr_p0");
    expect(context.suggestionSelectionDefaults).toHaveLength(26);
    expect(
      context.suggestionSelectionDefaults.every(
        (option) => option.valid && option.selectedByDefault,
      ),
    ).toBe(true);
    expect(context.hardContentBlockers.length).toBeGreaterThan(0);
    expect(
      context.hardContentBlockers.every(
        (blocker) => !firstPage.items.some((finding) => finding.id === blocker.findingId),
      ),
    ).toBe(true);
    const item = await api.workItem(context.workItemId);
    await expect(
      api.prepareAction({
        idempotencyKey: "sample-p0-empty-approval",
        workItemId: item.id,
        action: "approve",
        subjectRef: item.subject.id,
        expectedRevisionKey: context.target.revisionKey,
        expectedHeadSha: context.target.headSha,
        reportRef: context.reportRef,
        payload: {
          kind: "feedback",
          body: "No findings were selected.",
          findingIds: [],
          drafts: [],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const secondPage = await api.findings("sample-pr-p0-report", required(firstPage.nextCursor));
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const p0 = required(secondPage.items[0]);
    expect(p0.priority).toBe("P0");
    expect(context.hardContentBlockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ findingId: p0.id })]),
    );
    expect(context.suggestionSelectionDefaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: p0.id,
          draftId: p0.feedbackDraft.id,
          valid: true,
          selectedByDefault: true,
        }),
      ]),
    );
  });

  it("rejects another report's cursor and invalid page sizes", async () => {
    const api = createSampleInvestigationApi();
    const page = await api.findings("sample-pr-p0-report", undefined, 1);
    expectSchema(InvestigationFindingsPageV1Schema, page);
    expect(page.items).toHaveLength(1);
    await expect(
      api.findings("sample-pr-p1-report", required(page.nextCursor)),
    ).rejects.toMatchObject({ status: 400 });
    for (const limit of [0, 101, 1.5]) {
      await expect(api.findings("sample-pr-p0-report", undefined, limit)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("provides both suggested code and ordinary P1 feedback with required E2E verification", async () => {
    const api = createSampleInvestigationApi();
    const report = await api.exportReport("sample-pr-p1-report");
    const suggestion = required(report.findings[0]);
    const plainComment = required(report.findings[1]);
    expect(suggestion.priority).toBe("P1");
    expect(suggestion.feedbackDraft.suggestion).not.toBeNull();
    expect(plainComment.feedbackDraft.suggestion).toBeNull();
    expect(report.assessment).toMatchObject({ kind: "pr", e2eAssessment: { level: "required" } });
    const context = await api.actionContext("sample-pr-p1-work-item", report.id);
    expect(context.suggestionSelectionDefaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingId: suggestion.id, valid: true, selectedByDefault: true }),
      ]),
    );
    expect(
      context.suggestionSelectionDefaults.some(
        (option) =>
          option.findingId === plainComment.id && option.valid && option.selectedByDefault,
      ),
    ).toBe(false);
    expect(context.hardContentBlockers).toEqual([]);
    expect(
      required(context.fixedActions.find((action) => action.action === "approve")).allowed,
    ).toBe(true);
  });

  it("retains interrupted coverage, an unverified bug, and a ready feature as distinct outcomes", async () => {
    const api = createSampleInvestigationApi();
    const partial = await api.exportReport("sample-pr-partial-report");
    const bug = await api.exportReport("sample-bug-report");
    const feature = await api.exportReport("sample-feature-report");
    expect(partial.outcome).toBe("interrupted");
    expect(partial.report).toMatchObject({
      delivery: "checkpoint",
      completeness: "partial",
      loop: { stopReason: "interrupted" },
    });
    expect(partial.report.coverage.unresolvedUnitRefs.length).toBeGreaterThan(0);
    const partialContext = await api.actionContext("sample-pr-partial-work-item", partial.id);
    expect(
      required(partialContext.fixedActions.find((action) => action.action === "approve")).allowed,
    ).toBe(true);
    expect(bug.assessment).toMatchObject({
      kind: "bug",
      bugAssessment: { status: "needs_verification" },
      reproduction: { status: "not_run" },
    });
    expect(feature.assessment).toMatchObject({
      kind: "feature",
      featureAssessment: { status: "ready" },
    });
    expect(feature.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "start-task",
          taskKind: "feature-implement",
          planRef: expect.any(Object),
        }),
      ]),
    );
  });
});

describe("sample comment publications", () => {
  it("exposes independent publication states, batch summaries, and a pre-task receipt", async () => {
    const api = createSampleInvestigationApi();
    const all = await api.comments();
    expectSchema(InvestigationCommentPublicationListSchema, all);
    expect(all.items).toHaveLength(7);
    expect(new Set(all.items.map((comment) => comment.state))).toEqual(
      new Set(["synced", "retrying", "unconfirmed", "needs_attention", "paused", "pending"]),
    );
    const pending = required(all.items.find((comment) => comment.taskId === null));
    expect(pending).toMatchObject({ workItemId: null, mode: "progress", state: "pending" });
    expect(await api.commentAttempts(pending.id)).toEqual({ items: [], nextCursor: null });
    const preparing = await api.comment("sample-assignment-preparing-comment");
    expect(preparing).toMatchObject({ state: "synced", taskId: null, workItemId: null });
    expect((await api.commentAttempts(preparing.id)).items).toEqual([
      expect.objectContaining({
        operation: "create",
        taskId: null,
        body: expect.stringContaining("Source import is preparing"),
      }),
    ]);
    expect(await api.comments({ repositoryId: "missing-repository" })).toEqual({ items: [] });
    expect((await api.comments({ taskIds: ["sample-pr-p0-task"] })).items).toEqual([
      await api.comment("sample-pr-p0-comment"),
    ]);
    expect((await api.comments({ commentIds: [pending.id] })).items).toEqual([pending]);
    await expect(api.comments({ taskIds: [], commentIds: [] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      api.comments({ commentIds: Array.from({ length: 101 }, (_, index) => `comment-${index}`) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.comment("missing-comment")).rejects.toMatchObject({ status: 404 });
    await expect(api.commentAttempts("missing-comment")).rejects.toMatchObject({ status: 404 });
  });

  it("paginates immutable create and update bodies with filter-bound cursors", async () => {
    const api = createSampleInvestigationApi();
    const id = "sample-pr-p1-comment";
    const first = await api.commentAttempts(id, { limit: 1 });
    expectSchema(InvestigationCommentDeliveryListSchema, first);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      operation: "update",
      attemptNumber: 2,
      state: "succeeded",
    });
    const second = await api.commentAttempts(id, { limit: 1, cursor: required(first.nextCursor) });
    expectSchema(InvestigationCommentDeliveryListSchema, second);
    expect(second.items[0]).toMatchObject({
      operation: "create",
      attemptNumber: 1,
      state: "succeeded",
    });
    expect(second.items[0]?.body).toContain("Assignment of #2101");
    expect(first.items[0]?.body).toContain("completed");
    expect(first.items[0]?.body).not.toBe(second.items[0]?.body);
    expect(second.nextCursor).toBeNull();
    await expect(
      api.commentAttempts("sample-pr-p0-comment", { cursor: required(first.nextCursor) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.commentAttempts(id, { limit: 51 })).rejects.toMatchObject({ status: 400 });
    const filtered = await api.commentDeliveries({
      repositoryId,
      mode: "progress",
      state: "unknown",
    });
    expectSchema(InvestigationCommentDeliveryListSchema, filtered);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.commentId).toBe("sample-pr-partial-comment");
    expect((await api.commentDeliveries({ workItemNumber: 2101 })).items).toHaveLength(2);
    required(first.items[0]).body = "Changed by the reader.";
    expect((await api.commentAttempts(id)).items[0]?.body).toContain("completed");
  });

  it("appends an update once per command and retains every previous body", async () => {
    const api = createSampleInvestigationApi();
    const before = await api.comment("sample-pr-p0-comment");
    const previousAttempts = await api.commentAttempts(before.id);
    const taskBefore = await api.task(required(before.taskId));
    const command = { version: before.version, idempotencyKey: "retry-publication" };
    const synced = await api.syncComment(before.id, command);
    expectSchema(InvestigationCommentPublicationSummarySchema, synced);
    expect(synced).toMatchObject({ state: "synced", availableActions: [], nextAttemptAt: null });
    expect(synced.version).not.toBe(before.version);
    const attempts = await api.commentAttempts(before.id);
    expect(attempts.items).toHaveLength(previousAttempts.items.length + 1);
    expect(attempts.items).toEqual(expect.arrayContaining(previousAttempts.items));
    expect(attempts.items.find((attempt) => attempt.attemptNumber === 3)).toMatchObject({
      operation: "update",
      state: "succeeded",
      externalId: before.externalId,
      body: previousAttempts.items[0]?.body,
    });
    expect(await api.syncComment(before.id, command)).toEqual(synced);
    expect(await api.commentAttempts(before.id)).toEqual(attempts);
    expect(await api.task(required(before.taskId))).toEqual(taskBefore);
    await expect(
      api.syncComment(before.id, { ...command, version: synced.version }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      api.syncComment(before.id, { ...command, idempotencyKey: "stale-command" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("projects a reconciled attempt without fabricating a write or changing its saved body", async () => {
    const api = createSampleInvestigationApi();
    const before = await api.comment("sample-pr-partial-comment");
    const oldAttempts = await api.commentAttempts(before.id);
    const oldUnknown = required(oldAttempts.items.find((attempt) => attempt.state === "unknown"));
    await expect(
      api.syncComment(before.id, { version: before.version, idempotencyKey: "unsafe-sync" }),
    ).rejects.toMatchObject({ status: 409 });
    const command = { version: before.version, idempotencyKey: "read-back" };
    const reconciled = await api.reconcileComment(before.id, command);
    expect(reconciled.state).toBe("synced");
    const attempts = await api.commentAttempts(before.id);
    expect(attempts.items).toHaveLength(oldAttempts.items.length);
    const observed = required(attempts.items.find((attempt) => attempt.id === oldUnknown.id));
    expect(observed).toEqual({
      ...oldUnknown,
      state: "succeeded",
      effect: "applied",
      reason: observed.observations[0]?.reason,
      observations: observed.observations,
    });
    expect(observed.observations).toEqual([expect.objectContaining({ state: "succeeded" })]);
    expect(attempts.items.find((attempt) => attempt.operation === "create")).toEqual(
      oldAttempts.items.find((attempt) => attempt.operation === "create"),
    );
    expect(await api.reconcileComment(before.id, command)).toEqual(reconciled);
    expect(await api.commentAttempts(before.id)).toEqual(attempts);
    expect((await api.commentDeliveries({ commentId: before.id, state: "unknown" })).items).toEqual(
      [],
    );
    expect(
      (await api.commentDeliveries({ commentId: before.id, state: "succeeded" })).items,
    ).toHaveLength(2);
  });

  it.each([
    {
      original: "unknown",
      observations: ["failed", "unknown"],
      expected: "unknown",
      effect: "unknown",
    },
    {
      original: "unknown",
      observations: ["failed", "succeeded", "unknown", "failed"],
      expected: "succeeded",
      effect: "applied",
    },
    {
      original: "succeeded",
      observations: ["failed", "unknown"],
      expected: "succeeded",
      effect: "applied",
    },
    { original: "failed", observations: ["succeeded"], expected: "failed", effect: "rejected" },
  ] as const)(
    "preserves authoritative $original write evidence across $observations observations",
    async ({ original, observations, expected, effect }) => {
      const api = createSampleInvestigationApi();
      const saved = required((await api.commentAttempts("sample-pr-partial-comment")).items[0]);
      const receipt: InvestigationCommentDelivery = {
        ...saved,
        state: original,
        effect:
          original === "succeeded" ? "applied" : original === "failed" ? "rejected" : "unknown",
        reason: "The original write receipt.",
        observations: observations.map((state, index) => ({
          at: `2026-09-15T03:0${index}:00.000Z`,
          state,
          reason: `Readback ${index}: ${state}.`,
        })),
      };
      const originalReceipt = structuredClone(receipt);
      const view = sampleCommentDeliveryView(receipt);
      expect(view).toMatchObject({ state: expected, effect, body: saved.body });
      expect(view.observations).toEqual(receipt.observations);
      expect(view.reason).toBe(
        original !== "unknown"
          ? originalReceipt.reason
          : observations.some((state) => state === "succeeded")
            ? receipt.observations.find((observation) => observation.state === "succeeded")?.reason
            : receipt.observations.at(-1)?.reason,
      );
      view.observations.length = 0;
      expect(receipt).toEqual(originalReceipt);
    },
  );

  it("creates a synthetic intake receipt and isolates independently created adapters", async () => {
    const first = createSampleInvestigationApi();
    const second = createSampleInvestigationApi();
    const before = await first.comment("sample-assignment-intake-comment");
    await first.syncComment(before.id, {
      version: before.version,
      idempotencyKey: "intake-receipt",
    });
    const delivery = required((await first.commentAttempts(before.id)).items[0]);
    expect(delivery).toMatchObject({
      operation: "create",
      taskId: null,
      workItemId: null,
      attemptNumber: 1,
    });
    expect(delivery.body).toContain("Preparing the source");
    expect(await second.comment(before.id)).toEqual(before);
    expect(await second.commentAttempts(before.id)).toEqual({ items: [], nextCursor: null });
  });
});

describe("sample repository automatic replies", () => {
  it("separates ordinary template revisions from publishing authorization epochs", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    const enabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...initial,
      enabled: true,
    });
    const edited = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...enabled,
      pullRequestTemplate: enabled.pullRequestTemplate.replace("## Summary", "## Review summary"),
    });
    expect(edited).toMatchObject({
      version: 2,
      authorizationEpoch: 1,
      authorizedById: enabled.authorizedById,
      updatedById: "sample-operator",
    });
    const renewed = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...edited,
      reauthorize: true,
    });
    expect(renewed).toMatchObject({ version: 3, authorizationEpoch: 2 });
    expect(renewed).not.toHaveProperty("reauthorize");
    const progress = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...renewed,
      progressEnabled: true,
    });
    expect(progress.authorizationEpoch).toBe(3);
    const disabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...progress,
      enabled: false,
      progressEnabled: false,
    });
    expect(disabled).toMatchObject({ authorizationEpoch: 4, authorizedById: null });
    const reenabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...disabled,
      enabled: true,
    });
    expect(reenabled).toMatchObject({ authorizationEpoch: 5, authorizedById: "sample-operator" });
    await expect(
      api.updateRepositoryAutoReplySettings(repositoryId, {
        ...reenabled,
        enabled: false,
        reauthorize: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(reenabled);
  });

  it("saves versioned templates without fabricating deliveries or enabling a publisher", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    expectSchema(RepositoryAutoReplySettingsSchema, initial);
    expect(initial).toEqual({
      repositoryId,
      enabled: false,
      progressEnabled: false,
      progressTemplates: sampleAutoReplyProgressTemplates,
      version: 0,
      publisherConfigured: false,
      authorizedById: null,
      authorizationEpoch: 0,
      updatedById: null,
      updatedAt: null,
      templateVersion: 4,
      pullRequestTemplate: samplePullRequestAutoReplyTemplate,
      issueTemplate: sampleIssueAutoReplyTemplate,
    });
    const input = {
      version: initial.version,
      enabled: true,
      pullRequestTemplate: initial.pullRequestTemplate.replace(
        "## Summary",
        "## Sample PR summary",
      ),
      issueTemplate: initial.issueTemplate.replace("## Triage result", "## Sample issue triage"),
    };
    const updated = await api.updateRepositoryAutoReplySettings(repositoryId, input);
    expectSchema(RepositoryAutoReplySettingsSchema, updated);
    expect(updated).toEqual({
      ...initial,
      ...input,
      version: 1,
      authorizedById: "sample-operator",
      authorizationEpoch: 1,
      updatedById: "sample-operator",
      updatedAt: "2026-09-15T03:00:00.000Z",
    });
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(updated);
    await expect(api.updateRepositoryAutoReplySettings(repositoryId, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(updated);
    const deliveries = await api.repositoryAutoReplies(repositoryId);
    expectSchema(Type.Object({ items: Type.Array(RepositoryAutoReplySchema) }), deliveries);
    expect(deliveries).toEqual({ items: [] });
    const disabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...input,
      version: updated.version,
      enabled: false,
    });
    expect(disabled).toMatchObject({ enabled: false, version: 2, authorizedById: null });
    expect(await api.repositoryAutoReplies(repositoryId)).toEqual({ items: [] });
    const progressReplies = await api.repositoryProgressReplies(repositoryId);
    expectSchema(
      Type.Object({ items: Type.Array(RepositoryProgressReplySchema) }),
      progressReplies,
    );
    expect(progressReplies).toEqual({ items: [] });
  });

  it("rejects settings and delivery requests for an unknown repository", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const operation of [
      () => api.repositoryAutoReplySettings("missing-repository"),
      () => api.repositoryAutoReplies("missing-repository"),
      () => api.repositoryProgressReplies("missing-repository"),
      () => api.updateRepositoryAutoReplySettings("missing-repository", initial),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 404 });
    }
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
  });

  it("resets omitted progress settings to safe defaults and disables progress with automatic replies", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    const progressTemplates = {
      ...initial.progressTemplates,
      received: initial.progressTemplates.received.replace("## {{status}}", "## Sample {{status}}"),
    };
    const enabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...initial,
      enabled: true,
      progressEnabled: true,
      progressTemplates,
    });
    const legacyInput = {
      version: enabled.version,
      enabled: true,
      pullRequestTemplate: enabled.pullRequestTemplate,
      issueTemplate: enabled.issueTemplate,
    };
    const legacy = await api.updateRepositoryAutoReplySettings(repositoryId, legacyInput);
    expect(legacy).toMatchObject({
      progressEnabled: false,
      progressTemplates: sampleAutoReplyProgressTemplates,
    });
    const enabledAgain = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...legacyInput,
      version: legacy.version,
      progressEnabled: true,
      progressTemplates,
    });
    const disabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...legacyInput,
      version: enabledAgain.version,
      enabled: false,
      progressTemplates,
    });
    expect(disabled).toMatchObject({ enabled: false, progressEnabled: false, progressTemplates });
    const reenabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...legacyInput,
      version: disabled.version,
    });
    expect(reenabled).toMatchObject({
      enabled: true,
      progressEnabled: false,
      progressTemplates: sampleAutoReplyProgressTemplates,
    });
    expect(await api.repositoryProgressReplies(repositoryId)).toEqual({ items: [] });
  });

  it("rejects invalid progress settings without changing the saved version", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const overrides of [
      { enabled: false, progressEnabled: true },
      { progressEnabled: "true" },
      { progressEnabled: null },
      { progressTemplates: null },
      { progressTemplates: [] },
      { progressTemplates: "invalid" },
      { progressTemplates: { ...initial.progressTemplates, completed: undefined } },
      { progressTemplates: { ...initial.progressTemplates, failed: 42 } },
      { progressTemplates: { ...initial.progressTemplates, unexpected: "template" } },
    ]) {
      await expect(
        api.updateRepositoryAutoReplySettings(repositoryId, {
          ...initial,
          enabled: true,
          ...overrides,
        } as unknown as UpdateRepositoryAutoReplySettingsInput),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
    }
  });

  it.each([
    {
      name: "a missing trigger",
      transform: (template: string) => template.replace("{{trigger}}", ""),
    },
    {
      name: "a duplicate timestamp",
      transform: (template: string) => `${template}{{updated_at}}`,
    },
    {
      name: "an unknown placeholder",
      transform: (template: string) => `${template}{{secret}}`,
    },
    {
      name: "an incomplete placeholder",
      transform: (template: string) => `${template}{{trigger`,
    },
    {
      name: "nested braces",
      transform: (template: string) => template.replace("{{trigger}}", "{{{trigger}}}"),
    },
    {
      name: "a timestamp before the trigger",
      transform: (template: string) =>
        template.replace(/\{\{(trigger|updated_at)\}\}/gu, (_, token) =>
          token === "trigger" ? "{{updated_at}}" : "{{trigger}}",
        ),
    },
    {
      name: "more than 12,000 UTF-8 bytes",
      transform: (template: string) => `${template}${"é".repeat(6_000)}`,
    },
  ])("rejects $name in every progress stage without saving", async ({ transform }) => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const stage of ["received", "started", "failed", "completed"] as const) {
      await expect(
        api.updateRepositoryAutoReplySettings(repositoryId, {
          ...initial,
          progressTemplates: {
            ...initial.progressTemplates,
            [stage]: transform(initial.progressTemplates[stage]),
          },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
    }
  });

  it("rejects result and failure tokens in the wrong progress stage", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const [stage, template] of [
      ["received", initial.progressTemplates.completed],
      ["started", initial.progressTemplates.failed],
      ["failed", initial.progressTemplates.completed],
      ["completed", initial.progressTemplates.failed],
    ] as const) {
      await expect(
        api.updateRepositoryAutoReplySettings(repositoryId, {
          ...initial,
          progressTemplates: { ...initial.progressTemplates, [stage]: template },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
    }
  });

  it.each([
    {
      name: "a missing placeholder",
      transform: (template: string) => template.replace("{{details}}", ""),
    },
    {
      name: "a duplicated placeholder",
      transform: (template: string) => `${template}{{details}}`,
    },
    { name: "an unknown placeholder", transform: (template: string) => `${template}{{secret}}` },
    {
      name: "an incomplete placeholder",
      transform: (template: string) => `${template}{{details`,
    },
    {
      name: "nested placeholder braces",
      transform: (template: string) => template.replace("{{details}}", "{{{details}}}"),
    },
    {
      name: "content before the identity statement",
      transform: (template: string) => `# Automated review\n${template}`,
    },
    {
      name: "content after collapsed details",
      transform: (template: string) => `${template}\nAdditional footer.`,
    },
    {
      name: "details before the conclusion",
      transform: (template: string) =>
        template.replace(/\{\{(conclusion|details)\}\}/gu, (_, token) =>
          token === "conclusion" ? "{{details}}" : "{{conclusion}}",
        ),
    },
    {
      name: "a multibyte template larger than 12,000 bytes",
      transform: (template: string) => `${template}${"é".repeat(6_000)}`,
    },
  ])("rejects $name in either template without changing saved settings", async ({ transform }) => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const field of ["pullRequestTemplate", "issueTemplate"] as const) {
      await expect(
        api.updateRepositoryAutoReplySettings(repositoryId, {
          ...initial,
          [field]: transform(initial[field]),
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
    }
  });

  it("rejects swapped PR and Issue template placeholders without changing saved settings", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryAutoReplySettings(repositoryId);
    for (const input of [
      { ...initial, pullRequestTemplate: sampleIssueAutoReplyTemplate },
      { ...initial, issueTemplate: samplePullRequestAutoReplyTemplate },
      {
        ...initial,
        issueTemplate: sampleIssueAutoReplyTemplate.replace(
          "{{conclusion}}",
          "{{conclusion}}\n\n## Summary\n\n{{summary}}",
        ),
      },
    ]) {
      await expect(
        api.updateRepositoryAutoReplySettings(repositoryId, input),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
    }
  });

  it("isolates the saved settings and empty delivery list across adapter instances and callers", async () => {
    const first = createSampleInvestigationApi();
    const second = createSampleInvestigationApi();
    const original = await second.repositoryAutoReplySettings(repositoryId);
    const input = {
      enabled: true,
      progressEnabled: true,
      progressTemplates: structuredClone(original.progressTemplates),
      version: original.version,
      pullRequestTemplate: original.pullRequestTemplate,
      issueTemplate: original.issueTemplate,
    };
    const saved = await first.updateRepositoryAutoReplySettings(repositoryId, input);
    const expected = structuredClone(saved);
    input.pullRequestTemplate = "Changed after saving.";
    input.progressTemplates.received = "Changed after saving.";
    saved.issueTemplate = "Changed after reading.";
    saved.progressTemplates.completed = "Changed after reading.";
    expect(await first.repositoryAutoReplySettings(repositoryId)).toEqual(expected);
    expect(await second.repositoryAutoReplySettings(repositoryId)).toEqual(original);
    const replies = await first.repositoryAutoReplies(repositoryId);
    replies.items.length = 10;
    expect(await first.repositoryAutoReplies(repositoryId)).toEqual({ items: [] });
    expect(await second.repositoryAutoReplies(repositoryId)).toEqual({ items: [] });
    const progressReplies = await first.repositoryProgressReplies(repositoryId);
    progressReplies.items.length = 10;
    expect(await first.repositoryProgressReplies(repositoryId)).toEqual({ items: [] });
    expect(await second.repositoryProgressReplies(repositoryId)).toEqual({ items: [] });
  });
});

describe("sample repository webhook settings", () => {
  it("persists versioned settings and rejects stale updates or unknown repositories", async () => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryWebhookSettings(repositoryId);
    expectSchema(RepositoryWebhookSettingsSchema, initial);
    expect(initial).toEqual({
      repositoryId,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
      version: 0,
      receiverConfigured: false,
    });
    const input = {
      version: initial.version,
      enabled: true,
      reviewerUserId: 200,
      allowedActorUserIds: [100, 101],
    };
    const updated = await api.updateRepositoryWebhookSettings(repositoryId, input);
    expectSchema(RepositoryWebhookSettingsSchema, updated);
    expect(updated).toEqual({ ...input, repositoryId, version: 1, receiverConfigured: false });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(updated);
    await expect(api.updateRepositoryWebhookSettings(repositoryId, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(updated);
    await expect(api.repositoryWebhookSettings("missing-repository")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      api.updateRepositoryWebhookSettings("missing-repository", { ...input, version: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(updated);

    const disabled = await api.updateRepositoryWebhookSettings(repositoryId, {
      version: updated.version,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
    });
    expectSchema(RepositoryWebhookSettingsSchema, disabled);
    expect(disabled).toEqual({ ...initial, version: 2 });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(disabled);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric reviewer and actor IDs %s without saving them",
    async (id) => {
      const api = createSampleInvestigationApi();
      const initial = await api.repositoryWebhookSettings(repositoryId);
      const input = {
        version: 0,
        enabled: true,
        reviewerUserId: 200,
        allowedActorUserIds: [100],
      };
      await expect(
        api.updateRepositoryWebhookSettings(repositoryId, { ...input, reviewerUserId: id }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        api.updateRepositoryWebhookSettings(repositoryId, { ...input, allowedActorUserIds: [id] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(initial);
    },
  );

  it.each<{
    name: string;
    overrides: Partial<UpdateRepositoryWebhookSettingsInput>;
  }>([
    { name: "an enabled configuration without a reviewer", overrides: { reviewerUserId: null } },
    { name: "an enabled configuration without actors", overrides: { allowedActorUserIds: [] } },
    { name: "duplicate actors", overrides: { allowedActorUserIds: [100, 100] } },
    {
      name: "more than 1024 actors",
      overrides: { allowedActorUserIds: Array.from({ length: 1025 }, (_, index) => index + 1) },
    },
  ])("rejects $name without changing the saved configuration", async ({ overrides }) => {
    const api = createSampleInvestigationApi();
    const initial = await api.repositoryWebhookSettings(repositoryId);
    await expect(
      api.updateRepositoryWebhookSettings(repositoryId, {
        version: 0,
        enabled: true,
        reviewerUserId: 200,
        allowedActorUserIds: [100],
        ...overrides,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(initial);
  });

  it("accepts the safe numeric ID and actor count boundaries", async () => {
    const api = createSampleInvestigationApi();
    const actors = Array.from({ length: 1024 }, (_, index) =>
      index === 1023 ? Number.MAX_SAFE_INTEGER : index + 1,
    );
    const updated = await api.updateRepositoryWebhookSettings(repositoryId, {
      version: 0,
      enabled: true,
      reviewerUserId: Number.MAX_SAFE_INTEGER,
      allowedActorUserIds: actors,
    });
    expectSchema(RepositoryWebhookSettingsSchema, updated);
    expect(updated.reviewerUserId).toBe(Number.MAX_SAFE_INTEGER);
    expect(updated.allowedActorUserIds).toEqual(actors);
  });
});

describe("sample action preparation and confirmation", () => {
  it.each([
    { name: "one suggestion", indices: [0], summary: false },
    { name: "mixed suggestion and ordinary comment", indices: [0, 1], summary: false },
    { name: "an ordinary comment", indices: [1], summary: false },
    { name: "an independent summary draft", indices: [], summary: true },
    { name: "no selected findings or drafts", indices: [], summary: false },
  ])("prepares exactly the explicit payload for $name", async ({ indices, summary }) => {
    const api = createSampleInvestigationApi();
    const input = await feedbackInput(api, indices, summary);
    const prepared = await api.prepareAction(input);
    expectSchema(InvestigationActionIntentV1Schema, prepared);
    expect(prepared.state).toBe("prepared");
    expect(prepared.payload).toEqual(input.payload);
    expect(prepared.action).toBe(input.action);
    expect(prepared.reportRef).toEqual(input.reportRef);
    expect((await api.prepareAction(structuredClone(input))).id).toBe(prepared.id);
  });

  it("shares one intent for concurrent identical requests and rejects changed idempotent content", async () => {
    const api = createSampleInvestigationApi();
    const input = await feedbackInput(api, [0, 1]);
    const [first, second] = await Promise.all([
      api.prepareAction(input),
      api.prepareAction(structuredClone(input)),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.payloadDigest).toBe(second.payloadDigest);
    if (input.payload.kind !== "feedback") throw new Error("Expected a feedback payload.");
    input.payload.body = "Different content with the same idempotency key.";
    await expect(api.prepareAction(input)).rejects.toMatchObject({ status: 409 });
    expect((await api.actionIntent(first.id)).payload).toEqual(first.payload);
  });

  it("fails external confirmation explicitly without recording a GitHub dispatch", async () => {
    const api = createSampleInvestigationApi();
    const input = await feedbackInput(api, [0, 1], true);
    const prepared = await api.prepareAction(input);
    const confirmed = await api.confirmAction(
      prepared.id,
      prepared.version,
      prepared.payloadDigest,
    );
    expectSchema(InvestigationActionIntentV1Schema, confirmed);
    expect(confirmed.state).toBe("failed");
    expect(confirmed.result).toMatchObject({
      message: expect.stringContaining("Sample mode: no GitHub action was dispatched."),
      externalId: null,
      taskId: null,
    });
    expect(await api.actionIntent(prepared.id)).toEqual(confirmed);
    expect(await api.reconcileAction(prepared.id)).toEqual(confirmed);
    expect(await api.confirmAction(prepared.id, prepared.version, prepared.payloadDigest)).toEqual(
      confirmed,
    );
    expect((await api.tasks()).items).toHaveLength(seeds.length);
  });

  it("starts one synthetic queued child from a saved feature plan across confirmation retries", async () => {
    const api = createSampleInvestigationApi();
    const context = await api.actionContext("sample-feature-work-item", "sample-feature-report");
    const nextAction = required(
      context.nextActions.find(
        (action) => action.action === "start-task" && action.taskKind === "feature-implement",
      ),
    );
    expect(nextAction.canPrepare).toBe(true);
    expect(nextAction.readyToExecute).toBe(false);
    const input: PrepareActionInput = {
      idempotencyKey: "sample-feature-follow-up",
      workItemId: context.workItemId,
      action: "start-task",
      subjectRef: nextAction.subjectRef,
      expectedRevisionKey: context.target.revisionKey,
      expectedHeadSha: context.target.headSha,
      reportRef: context.reportRef,
      nextActionId: nextAction.id,
      payload: {
        kind: "task",
        taskKind: required(nextAction.taskKind),
        planRef: required(nextAction.planRef),
        sourceCommit: "a".repeat(40),
      },
    };
    const missingSource = await api.prepareAction({
      ...input,
      idempotencyKey: "sample-feature-source-missing",
      payload: {
        kind: "task",
        taskKind: required(nextAction.taskKind),
        planRef: required(nextAction.planRef),
      },
    });
    expect(missingSource.guards.some((entry) => !entry.satisfied)).toBe(true);
    await expect(
      api.confirmAction(missingSource.id, missingSource.version, missingSource.payloadDigest),
    ).rejects.toThrow("unmet execution prerequisites");
    const prepared = await api.prepareAction(input);
    const confirmed = await api.confirmAction(
      prepared.id,
      prepared.version,
      prepared.payloadDigest,
    );
    expectSchema(InvestigationActionIntentV1Schema, prepared);
    expectSchema(InvestigationActionIntentV1Schema, confirmed);
    expect(confirmed.state).toBe("succeeded");
    expect(confirmed.result?.message).toContain("Sample");
    expect(confirmed.result?.externalId).toBeNull();
    const childId = required(confirmed.result?.taskId);
    const child = await api.task(childId);
    expectSchema(TaskDetailSchema, child);
    expect(child.task).toMatchObject({
      kind: "feature-implement",
      state: "queued",
      parentTaskId: "sample-feature-task",
      parentReportRef: context.reportRef,
      planRef: nextAction.planRef,
    });
    expect(child.latestReport).toBeNull();
    expect(child.attempts).toEqual([]);
    expect(child.task.executionPolicy.allowRepositoryExecution).toBe(false);
    expect(
      child.task.subjects.find((subject) => subject.id === child.task.subjectRef),
    ).toMatchObject({ kind: "source_commit", commitSha: "a".repeat(40) });
    expect((await api.task("sample-feature-task")).children.map((task) => task.id)).toEqual([
      childId,
    ]);

    expect(await api.confirmAction(prepared.id, prepared.version, prepared.payloadDigest)).toEqual(
      confirmed,
    );
    const repeated = await api.prepareAction(structuredClone(input));
    expect(repeated.id).toBe(prepared.id);
    expect(repeated.result?.taskId).toBe(childId);
    expect((await api.tasks()).items).toHaveLength(seeds.length + 1);
    expect((await api.tasks(context.workItemId)).items.map((task) => task.id)).toEqual(
      expect.arrayContaining(["sample-feature-task", childId]),
    );
  });

  it("keeps task creation, cancellation, and resumption inside the sample store", async () => {
    const api = createSampleInvestigationApi();
    const input = {
      idempotencyKey: "sample-create-task",
      workItemId: "sample-feature-work-item",
      kind: "issue-investigate" as const,
    };
    const created = await api.createTask(input);
    expectSchema(InvestigationTaskV1Schema, created);
    expect(created.state).toBe("queued");
    expect((await api.createTask(input)).id).toBe(created.id);
    expect((await api.tasks()).items).toHaveLength(seeds.length + 1);
    const cancelled = await api.cancelTask(created.id);
    expectSchema(InvestigationTaskV1Schema, cancelled);
    expect(cancelled.state).toBe("cancelled");
    expect((await api.task(created.id)).task.state).toBe("cancelled");
    const stopped = await api.task("sample-pr-partial-task");
    const resumed = await api.resumeTask("sample-pr-partial-task", "sample-resume-task");
    expectSchema(InvestigationTaskV1Schema, resumed);
    expect(resumed.state).toBe("queued");
    expect((await api.resumeTask("sample-pr-partial-task", "sample-resume-task")).id).toBe(
      resumed.id,
    );
    const resumedDetail = await api.task(resumed.id);
    expectSchema(TaskDetailSchema, resumedDetail);
    expect(resumedDetail.attempts).toEqual(stopped.attempts);
    expect(resumedDetail.checkpoint).toEqual(stopped.checkpoint);
  });
});

describe("sample data isolation", () => {
  it("copies webhook settings on input and output and isolates independently created factories", async () => {
    const firstApi = createSampleInvestigationApi();
    const secondApi = createSampleInvestigationApi();
    const initial = await secondApi.repositoryWebhookSettings(repositoryId);
    const input = {
      version: 0,
      enabled: true,
      reviewerUserId: 200,
      allowedActorUserIds: [100, 101],
    };
    const savedInput = structuredClone(input);
    const updated = await firstApi.updateRepositoryWebhookSettings(repositoryId, input);
    const expected = { ...savedInput, repositoryId, version: 1, receiverConfigured: false };
    input.reviewerUserId = 999;
    input.allowedActorUserIds.push(999);
    updated.enabled = false;
    updated.allowedActorUserIds.length = 0;
    expect(await firstApi.repositoryWebhookSettings(repositoryId)).toEqual(expected);
    const retrieved = await firstApi.repositoryWebhookSettings(repositoryId);
    retrieved.reviewerUserId = null;
    retrieved.allowedActorUserIds.push(999);
    expect(await firstApi.repositoryWebhookSettings(repositoryId)).toEqual(expected);
    expect(await secondApi.repositoryWebhookSettings(repositoryId)).toEqual(initial);
  });

  it("returns independent nested responses for lists, details, reports, pages, and contexts", async () => {
    const api = createSampleInvestigationApi();
    const repositories = await api.repositories();
    const repositoryName = required(repositories.items[0]).fullName;
    required(repositories.items[0]).fullName = "mutated/repository";
    expect(required((await api.repositories()).items[0]).fullName).toBe(repositoryName);

    const workItems = await api.workItems();
    required(workItems.items[0]).title = "Mutated work item";
    const mutatedWorkItemId = required(workItems.items[0]).id;
    expect((await api.workItem(mutatedWorkItemId)).title).not.toBe("Mutated work item");
    workItems.items.length = 0;
    expect((await api.workItems()).items).toHaveLength(seeds.length);

    const listedTask = required((await api.tasks()).items[0]);
    const originalTaskState = listedTask.state;
    listedTask.state = "failed";
    expect((await api.task(listedTask.id)).task.state).toBe(originalTaskState);

    const detail = await api.task("sample-pr-p1-task");
    required(detail.task.scope.includedUnits[0]).requiredWork = "Mutated task scope";
    required(detail.attempts[0]).workerId = "mutated-worker";
    const freshDetail = await api.task("sample-pr-p1-task");
    expect(required(freshDetail.task.scope.includedUnits[0]).requiredWork).not.toBe(
      "Mutated task scope",
    );
    expect(required(freshDetail.attempts[0]).workerId).not.toBe("mutated-worker");

    const header = await api.report("sample-pr-p1-report");
    header.report.collections.findings = 999;
    header.assessment.summary = "Mutated header";
    const freshHeader = await api.report(header.id);
    expect(freshHeader.report.collections.findings).not.toBe(999);
    expect(freshHeader.assessment.summary).not.toBe("Mutated header");

    const report = await api.exportReport(header.id);
    required(report.findings[0]).feedbackDraft.body = "Mutated export";
    required(report.context.subjects[0]).revisionKey = "mutated-revision";
    const freshReport = await api.exportReport(header.id);
    expect(required(freshReport.findings[0]).feedbackDraft.body).not.toBe("Mutated export");
    expect(required(freshReport.context.subjects[0]).revisionKey).not.toBe("mutated-revision");
    const page = await api.findings(header.id);
    required(page.items[0]).feedbackDraft.body = "Mutated page";
    expect(required((await api.findings(header.id)).items[0]).feedbackDraft.body).not.toBe(
      "Mutated page",
    );

    const context = await api.actionContext("sample-pr-p1-work-item", header.id);
    const option = required(
      context.suggestionSelectionDefaults.find((item) => item.valid && item.selectedByDefault),
    );
    option.selectedByDefault = false;
    context.fixedActions.length = 0;
    const freshContext = await api.actionContext("sample-pr-p1-work-item", header.id);
    expect(
      required(
        freshContext.suggestionSelectionDefaults.find(
          (item) => item.findingId === option.findingId,
        ),
      ).selectedByDefault,
    ).toBe(true);
    expect(freshContext.fixedActions.length).toBeGreaterThan(0);
  });

  it("copies prepared payloads on input and output", async () => {
    const api = createSampleInvestigationApi();
    const input = await feedbackInput(api, [0, 1], true);
    const originalPayload = structuredClone(input.payload);
    const prepared = await api.prepareAction(input);
    if (input.payload.kind !== "feedback" || prepared.payload.kind !== "feedback")
      throw new Error("Expected feedback payloads.");
    input.payload.body = "Mutated request";
    input.payload.findingIds.length = 0;
    required(input.payload.drafts[0]).body = "Mutated request draft";
    prepared.payload.body = "Mutated response";
    prepared.payload.drafts.length = 0;
    expect((await api.actionIntent(prepared.id)).payload).toEqual(originalPayload);
    const retrieved = await api.actionIntent(prepared.id);
    if (retrieved.payload.kind !== "feedback") throw new Error("Expected a feedback payload.");
    retrieved.payload.findingIds.length = 0;
    expect((await api.actionIntent(prepared.id)).payload).toEqual(originalPayload);
  });

  it("isolates tasks and action intents between independently created factories", async () => {
    const firstApi = createSampleInvestigationApi();
    const secondApi = createSampleInvestigationApi();
    await firstApi.resumeTask("sample-pr-partial-task", "factory-one-resume");
    await firstApi.cancelTask("sample-pr-partial-task");
    expect((await firstApi.task("sample-pr-partial-task")).task.state).toBe("cancelled");
    expect((await secondApi.task("sample-pr-partial-task")).task.state).toBe("interrupted");
    const created = await firstApi.createTask({
      idempotencyKey: "factory-one-task",
      workItemId: "sample-feature-work-item",
      kind: "issue-investigate",
    });
    expect((await secondApi.tasks()).items).toHaveLength(seeds.length);
    expect((await secondApi.tasks()).items.some((task) => task.id === created.id)).toBe(false);
    const prepared = await firstApi.prepareAction(await feedbackInput(firstApi, [1]));
    await expect(secondApi.actionIntent(prepared.id)).rejects.toThrow();
    const firstInput = await feedbackInput(firstApi, [1]);
    const secondInput = await feedbackInput(secondApi, [0]);
    expect(firstInput.idempotencyKey).toBe(secondInput.idempotencyKey);
    const secondPrepared = await secondApi.prepareAction(secondInput);
    expect(secondPrepared.payload).toEqual(secondInput.payload);
    expect((await firstApi.actionIntent(prepared.id)).payload).toEqual(firstInput.payload);
  });
});
