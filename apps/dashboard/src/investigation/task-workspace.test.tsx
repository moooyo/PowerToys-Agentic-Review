import {
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { TaskDetails, TaskList } from "./task-workspace";

vi.mock("./session", () => ({
  useInvestigationSession: () => ({ session: { user: { isAdmin: false, permissions: [] } } }),
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
      queryClient.setQueryData(["investigation-task", detail.task.id], detail);
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
    queryClient.setQueryData(["investigation-task", detail.task.id], cancelledDetail);
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
    expect(html).toContain("including initialization and cancellation");
    expect(html).toContain("700 tokens");
    expect(html).toContain("Worker heartbeat");
    expect(html).toContain("Latest meaningful progress");
  });
});
