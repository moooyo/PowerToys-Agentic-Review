import {
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "./api";
import { commentSummariesQueryKey } from "./comment-deliveries";
import { createSampleInvestigationApi } from "./sample-adapter";
import { sessionIdentity } from "./session";
import { TaskDetails, TaskList, taskDetailQueryKey, taskDetailTab } from "./task-workspace";

const session = vi.hoisted(() => ({
  authenticated: true as const,
  authMode: "password" as const,
  loginPath: "/api/auth/login" as const,
  expiresAt: "2099-01-01T00:00:00Z",
  user: {
    id: "viewer",
    username: "viewer",
    displayName: "Viewer",
    email: null,
    isAdmin: false,
    permissions: [],
    repositoryIds: ["repo-powertoys-fork"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  },
}));
vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  useInvestigationSession: () => ({ session }),
}));

const usage: InvestigationUsageSummary = {
  usage: {
    ...unavailableInvestigationTokenUsage(),
    inputTokens: 600,
    cachedReadTokens: 400,
    outputTokens: 100,
    totalTokens: 700,
  },
  reportedTokens: 700,
  completeness: "complete",
  invocationCount: 3,
  activeInvocationCount: 0,
  unknownInvocationCount: 0,
  legacyTokens: 0,
};

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

describe("task workspace runtime information", () => {
  it.each(["started", "observed"])(
    "shows cancelled E2E %s activity without claiming an adopted analysis",
    async (stage) => {
      const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
      if (!detail.checkpoint) throw new Error("A checkpoint fixture is required.");
      detail.task.kind = "pr-e2e";
      detail.task.state = "cancelled";
      detail.latestReport = null;
      const checkpoint = detail.checkpoint;
      checkpoint.round = 0;
      checkpoint.stopReason = "cancelled";
      checkpoint.analysis.summary = "Investigation has not started.";
      delete checkpoint.runtime.e2e;
      checkpoint.runtime.e2eExecution = {
        attemptId: checkpoint.attemptId,
        status: "started",
        startedAt: checkpoint.recordedAt,
        completedAt: null,
      };
      checkpoint.runtime.artifacts = [];
      checkpoint.runtime.evidence =
        stage === "started"
          ? []
          : [
              {
                id: "observed-window",
                subjectRef: detail.task.subjectRef,
                source: "executor_observation",
                authority: "worker",
                summary: "The owned application window opened.",
                artifactRefs: [],
                evidenceRefs: [],
                provenance: {
                  taskId: detail.task.id,
                  attemptId: checkpoint.attemptId,
                  producer: "e2e-tool-server",
                  recordedAt: checkpoint.recordedAt,
                },
              },
            ];
      const before = structuredClone(checkpoint);
      const queryClient = client();
      queryClient.setQueryData(
        taskDetailQueryKey(sessionIdentity(session), detail.task.id),
        detail,
      );
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <TaskDetails taskId={detail.task.id} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(html).toContain("0 accepted analysis rounds");
      expect(html).toContain("Final analysis was not adopted because the task was cancelled");
      expect(html).toContain(
        stage === "started"
          ? "workflow start was recorded; application execution is not established"
          : "Worker observations or artifacts were recorded; final E2E feature results are unavailable",
      );
      expect(html).not.toContain("Investigation has not started.");
      expect(checkpoint).toEqual(before);
    },
  );

  it("shows production task usage in the task list", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-p1-task");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <TaskList tasks={[detail.task]} usageByTaskId={{ [detail.task.id]: usage }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("700 tokens");
    expect(html).toContain("Static");
    expect(html).toContain("Reported usage");
  });

  it("links older and current tasks to their shared comment without changing its producer", async () => {
    const api = createSampleInvestigationApi();
    const detail = await api.task("sample-pr-p0-task");
    const older = { ...detail.task, id: "task-older" };
    const unrelated = { ...detail.task, id: "task-unrelated" };
    const tasks = [older, detail.task, unrelated];
    const shared = {
      ...(await api.comment("sample-pr-p0-comment")),
      taskId: detail.task.id,
      associatedTaskIds: [older.id, detail.task.id],
    };
    const queryClient = client();
    queryClient.setQueryData(
      [
        ...commentSummariesQueryKey({ taskIds: tasks.map((task) => task.id).sort() }),
        sessionIdentity(session),
      ],
      { items: [shared] },
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TaskList tasks={tasks} usageByTaskId={{}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html.match(/commentId=sample-pr-p0-comment/gu)).toHaveLength(2);
    expect(shared.taskId).toBe(detail.task.id);
  });

  it("separates model call counts, accepted rounds, and saved state versions", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    if (!detail.checkpoint) throw new Error("A checkpoint fixture is required.");
    const queryClient = client();
    const cancelledDetail: TaskDetail = {
      ...detail,
      task: { ...detail.task, state: "cancelled" },
      latestReport: null,
      checkpoint: { ...detail.checkpoint, version: 6, round: 3 },
      usage,
      invocations: [],
      progress: {
        stage: "model",
        stageStartedAt: null,
        lastActivityAt: null,
        lastMeaningfulProgressAt: null,
        lastHeartbeatAt: "2026-09-19T01:00:00Z",
      },
    };
    queryClient.setQueryData(
      taskDetailQueryKey(sessionIdentity(session), detail.task.id),
      cancelledDetail,
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("3 model calls");
    expect(html).toContain("3 accepted analysis rounds");
    expect(html).toContain("Saved state v6");
    expect(html).not.toContain("Checkpoint version 6");
    expect(html).toContain("Agent output");
    expect(html).toContain("Task tokens");
    expect(html).toContain("700");
    expect(html).not.toContain("Recorded stage totals");
    const detailsHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/tasks?taskId=${detail.task.id}&tab=details`]}>
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(detailsHtml).toContain("including initialization and cancellation");
    expect(detailsHtml).toContain("700 tokens");
    expect(detailsHtml).toContain("Worker heartbeat");
    expect(detailsHtml).toContain("Latest meaningful progress");
    expect(detailsHtml).not.toContain("Task output events");
  });

  it("resolves old detail links and keeps progress, evidence, and details as separate route panels", async () => {
    expect(taskDetailTab(null)).toBe("progress");
    expect(taskDetailTab("usage")).toBe("details");
    expect(taskDetailTab("comments")).toBe("details");
    expect(taskDetailTab("evidence")).toBe("evidence");
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    const queryClient = client();
    queryClient.setQueryData(taskDetailQueryKey(sessionIdentity(session), detail.task.id), detail);
    for (const tab of ["progress", "evidence", "details"]) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/tasks?taskId=${detail.task.id}&tab=${tab}`]}>
            <TaskDetails taskId={detail.task.id} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(html).toContain(`id="task-${tab}-panel"`);
      expect(html.includes("Task output events")).toBe(tab === "progress");
      expect(html.includes("Stored in workspace")).toBe(tab === "evidence");
      expect(html.includes("Run details")).toBe(tab === "details");
      expect(html).not.toContain("Complete report");
    }
  });
});
