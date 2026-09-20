import type { InvestigationCommentPublicationSummary } from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InvestigationCommentRoutesOptions,
  registerInvestigationCommentRoutes,
} from "./comment-http.js";

const applications: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
});

function publication(
  overrides: Partial<InvestigationCommentPublicationSummary> = {},
): InvestigationCommentPublicationSummary {
  return {
    id: "progress-reply:task:shared",
    version: "version-one",
    mode: "progress",
    repositoryId: "repository-one",
    repositoryFullName: "fixture/repository",
    workItemId: "item-one",
    workItemKind: "pull_request",
    workItemNumber: 7,
    taskId: "task-current",
    producerTaskKind: "pr-review",
    reportId: "report-current",
    state: "synced",
    reasonCode: null,
    reason: null,
    requiresAttention: false,
    nextAttemptAt: null,
    lastAttemptAt: "2026-09-20T00:00:00Z",
    lastConfirmedAt: "2026-09-20T00:00:00Z",
    externalId: "700",
    commentUrl: "https://github.com/fixture/repository/pull/7#issuecomment-700",
    availableActions: [],
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    ...overrides,
  };
}

function harness(
  progressItems: InvestigationCommentPublicationSummary[],
  resultItems: InvestigationCommentPublicationSummary[] = [],
) {
  const app = Fastify({ logger: false });
  applications.push(app);
  const progress = { taskSummaries: vi.fn(() => ({ items: progressItems })) };
  const automaticReplies = { taskSummaries: vi.fn(() => ({ items: resultItems })) };
  registerInvestigationCommentRoutes(app, {
    authenticateOperator: () => ({
      id: "operator",
      displayName: "Synthetic operator",
      repositoryIds: ["repository-one"],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    }),
    deliveries: {} as InvestigationCommentRoutesOptions["deliveries"],
    progress: progress as unknown as InvestigationCommentRoutesOptions["progress"],
    automaticReplies:
      automaticReplies as unknown as InvestigationCommentRoutesOptions["automaticReplies"],
  });
  return { app, progress, automaticReplies };
}

describe("task comment summary routes", () => {
  it("returns one shared publication for all requested associated tasks and retains its producer", async () => {
    const shared = publication({ associatedTaskIds: ["task-old", "task-current"] });
    const legacy = publication({
      id: "auto-reply:report:old",
      mode: "result",
      taskId: "task-old",
      reportId: "report-old",
      updatedAt: "2026-09-20T01:00:00Z",
    });
    const h = harness([shared], [legacy]);
    const response = await h.app.inject({
      method: "GET",
      url: "/api/comments?taskIds=task-old,task-current,task-old",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([shared]);
    expect(h.progress.taskSummaries).toHaveBeenCalledWith(expect.any(Object), [
      "task-old",
      "task-current",
    ]);
  });

  it("keeps a legacy result for an unrelated task without duplicating the shared comment", async () => {
    const shared = publication({ associatedTaskIds: ["task-old", "task-current"] });
    const legacy = publication({
      id: "auto-reply:report:unrelated",
      mode: "result",
      taskId: "task-unrelated",
    });
    const h = harness([shared], [legacy]);
    const response = await h.app.inject({
      method: "GET",
      url: "/api/comments?taskIds=task-old,task-unrelated",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        { ...shared, associatedTaskIds: ["task-old"] },
        { ...legacy, associatedTaskIds: ["task-unrelated"] },
      ]),
    );
    expect(response.json().items).toHaveLength(2);
  });

  it("rejects an ungranted repository before reading any task summaries", async () => {
    const h = harness([publication()]);
    const response = await h.app.inject({
      method: "GET",
      url: "/api/comments?taskIds=task-old&repositoryId=foreign-repository",
    });
    expect(response.statusCode).toBe(403);
    expect(h.progress.taskSummaries).not.toHaveBeenCalled();
    expect(h.automaticReplies.taskSummaries).not.toHaveBeenCalled();
  });
});
