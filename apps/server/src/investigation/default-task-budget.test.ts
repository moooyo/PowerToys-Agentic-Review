import { createInvestigationPreview, type InvestigationTaskV1 } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvestigationService,
  type InvestigationServiceOptions,
} from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const budget = { maxTokens: 5_000_000, maxRounds: 8, maxDurationMs: 7_200_000 };

function fixture(
  defaultTaskBudget?: InvestigationServiceOptions["defaultTaskBudget"],
  kind: "pr" | "bug" = "pr",
) {
  const store = new InvestigationStore();
  stores.push(store);
  const original = createInvestigationPreview(kind, { findingCount: 0 }).task;
  const item: InvestigationWorkItemRecord = {
    ...original.workItem,
    repositoryId: original.repository.id,
    body: "Synthetic budget fixture.",
    state: "open",
    subject: original.subjects.find((entry) => entry.id === original.subjectRef)!,
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
  store.insert("repositories", original.repository.id, original.repository);
  store.insert("workItems", item.id, item);
  const actor: InvestigationOperatorPrincipal = {
    id: "budget-fixture-operator",
    displayName: "Budget fixture operator",
    repositoryIds: [original.repository.id],
    permissions: ["task:create", "task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: true,
  };
  const options: InvestigationServiceOptions = {
    store,
    maxReportBytes: 1_048_576,
    ...(defaultTaskBudget === undefined ? {} : { defaultTaskBudget }),
  };
  const service = new InvestigationService(options);
  return { store, item, actor, service, options };
}

describe("deployment default Task budget", () => {
  it("preserves legacy defaults when no deployment override exists", async () => {
    const h = fixture();
    const task = await h.service.createTask(h.actor, {
      kind: "pr-review",
      workItemId: h.item.id,
      idempotencyKey: "legacy-default",
    });
    expect(task.budget).toEqual({
      maxTokens: 120_000,
      maxRounds: 24,
      maxDurationMs: 1_800_000,
      maxReportBytes: 1_048_576,
    });
  });

  it.each(["pr-review", "pr-e2e", "issue-investigate"] as const)(
    "applies the same deployment defaults to %s roots",
    async (kind) => {
      const h = fixture(budget, kind === "issue-investigate" ? "bug" : "pr");
      const task = await h.service.createTask(h.actor, {
        kind,
        workItemId: h.item.id,
        idempotencyKey: `default-${kind}`,
      });
      expect(task.budget).toEqual({ ...budget, maxReportBytes: 1_048_576 });
    },
  );

  it("detaches deployment configuration and each returned Task budget", async () => {
    const configured = { ...budget };
    const h = fixture(configured);
    configured.maxTokens = 1;
    h.options.defaultTaskBudget = { ...budget, maxTokens: 2 };
    const first = await h.service.createTask(h.actor, {
      kind: "pr-review",
      workItemId: h.item.id,
      idempotencyKey: "first",
    });
    first.budget.maxTokens = 3;
    const second = await h.service.createTask(h.actor, {
      kind: "pr-review",
      workItemId: h.item.id,
      idempotencyKey: "second",
    });
    expect(second.budget.maxTokens).toBe(5_000_000);
    expect(h.store.get<InvestigationTaskV1>("tasks", first.id)?.budget.maxTokens).toBe(5_000_000);
  });

  it("keeps explicit request budgets authoritative without changing later defaults", async () => {
    const h = fixture(budget);
    const explicit = {
      maxTokens: 200_000,
      maxRounds: 4,
      maxDurationMs: 60_000,
      maxReportBytes: 100_000,
    };
    const task = await h.service.createTask(h.actor, {
      kind: "pr-review",
      workItemId: h.item.id,
      idempotencyKey: "explicit",
      budget: explicit,
    });
    expect(task.budget).toEqual(explicit);
    explicit.maxTokens = 1;
    expect(task.budget.maxTokens).toBe(200_000);
    const next = await h.service.createTask(h.actor, {
      kind: "pr-review",
      workItemId: h.item.id,
      idempotencyKey: "after-explicit",
    });
    expect(next.budget.maxTokens).toBe(5_000_000);
  });

  it("does not alter existing Task, idempotent creation, or resume budgets after configuration changes", async () => {
    const h = fixture(budget);
    const request = {
      kind: "pr-review" as const,
      workItemId: h.item.id,
      idempotencyKey: "before-restart",
    };
    const task = await h.service.createTask(h.actor, request);
    h.service.cancelTask(h.actor, task.id);
    const restarted = new InvestigationService({
      ...h.options,
      defaultTaskBudget: { ...budget, maxTokens: 50_000_000 },
    });
    const replayed = await restarted.createTask(h.actor, request);
    expect(replayed.budget).toEqual(task.budget);
    const resumed = await restarted.resumeTask(h.actor, task.id, {
      idempotencyKey: "resume-existing",
    });
    expect(resumed.budget).toEqual(task.budget);
    const fresh = await restarted.createTask(h.actor, {
      ...request,
      idempotencyKey: "after-restart",
    });
    expect(fresh.budget.maxTokens).toBe(50_000_000);
  });

  it.each([
    null,
    [],
    {},
    { ...budget, maxTokens: "5000000" },
    { ...budget, maxRounds: 0 },
    { ...budget, maxTokens: -1 },
    { ...budget, maxTokens: 1.5 },
    { ...budget, maxTokens: Number.NaN },
    { ...budget, maxTokens: Number.POSITIVE_INFINITY },
    { ...budget, maxTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...budget, maxDurationMs: 2_147_483_648 },
    { ...budget, maxReportBytes: 1 },
  ])("rejects malformed programmatic defaults %#", (input) => {
    expect(() => fixture(input as InvestigationServiceOptions["defaultTaskBudget"])).toThrow(
      expect.objectContaining({ code: "invalid_default_task_budget" }),
    );
  });
});
