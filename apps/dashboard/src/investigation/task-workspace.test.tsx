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
import { TaskOutputPanel } from "./task-output";
import {
  TaskDetails,
  TaskList,
  taskCleanupPending,
  taskDetailQueryKey,
  taskDetailTab,
  taskIsActive,
  taskReportMatches,
} from "./task-workspace";

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
    permissions: [] as ("task:create" | "task:cancel")[],
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
  it("shows the fixed execution limit and retained usage for a legacy task", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    if (!detail.checkpoint) throw new Error("A checkpoint fixture is required.");
    const legacy: TaskDetail = {
      ...detail,
      task: {
        ...detail.task,
        budget: { ...detail.task.budget, maxDurationMs: 1, maxTokens: 1, maxRounds: 1 },
      },
      checkpoint: {
        ...detail.checkpoint,
        consumed: { ...detail.checkpoint.consumed, rounds: 50, durationMs: 900_000 },
      },
      usage,
    };
    const queryClient = client();
    queryClient.setQueryData(taskDetailQueryKey(sessionIdentity(session), detail.task.id), legacy);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/tasks?taskId=${detail.task.id}&tab=details`]}>
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("2 hours across all attempts");
    expect(html).toContain("Execution time used");
    expect(html).toContain("15 minutes");
    expect(html).toContain("700 tokens");
    expect(html).toContain("Review rounds");
    expect(html).not.toContain("Token budget");
    expect(html).not.toContain("50 / 1");
  });

  it("explains exhausted execution time independently of otherwise valid recovery permissions", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    if (!detail.checkpoint) throw new Error("A checkpoint fixture is required.");
    const exhausted: TaskDetail = {
      ...detail,
      task: { ...detail.task, state: "cancelled" },
      checkpoint: {
        ...detail.checkpoint,
        stopReason: "budget_exhausted",
        consumed: { ...detail.checkpoint.consumed, durationMs: 7_200_000 },
      },
    };
    const permissions = session.user.permissions;
    session.user.permissions = ["task:create"];
    try {
      const queryClient = client();
      queryClient.setQueryData(
        taskDetailQueryKey(sessionIdentity(session), detail.task.id),
        exhausted,
      );
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <TaskDetails taskId={detail.task.id} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(html).toContain("The 2-hour total execution limit is exhausted");
      expect(html).not.toContain("Recovery requires Create tasks access");
    } finally {
      session.user.permissions = permissions;
    }
  });

  it("restores copied output filters while keeping the explicitly selected attempt", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    const attempt = detail.attempts[0];
    if (!attempt) throw new Error("An attempt fixture is required.");
    const queryClient = client();
    queryClient.setQueryData(taskDetailQueryKey(sessionIdentity(session), detail.task.id), detail);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[
            `/tasks?taskId=${detail.task.id}&attemptId=${attempt.id}&outputSearch=retained-needle&outputType=system`,
          ]}
        >
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain('value="retained-needle"');
    expect(html).toContain('value="system"');
    expect(html).toContain(`value="${attempt.id}"`);
    expect(html).toContain("Find in loaded output");
  });

  it("keeps the output panel independently usable without a router or controlled view", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-partial-task");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <TaskOutputPanel
          task={detail.task}
          attempts={detail.attempts}
          attemptId={detail.attempts[0]?.id}
          onAttemptChange={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Agent output");
    expect(html).not.toContain("Find in loaded output");
  });
  it("keeps cancelled work in Active until its own resources are released", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-p1-task");
    const task = { ...detail.task, state: "cancelled" as const };
    const lease = {
      taskId: task.id,
      attemptId: "owned-attempt",
      workerId: "worker-one",
      fence: 1,
      pool: "e2e" as const,
      state: "needs_cleanup" as const,
      acquiredAt: task.createdAt,
      updatedAt: task.updatedAt,
      releasedAt: null,
      reason: "cancelled",
    };
    expect(taskIsActive(task, [lease])).toBe(true);
    expect(taskCleanupPending(task, [lease])).toBe(true);
    expect(taskIsActive(task, [{ ...lease, state: "released" }])).toBe(false);
    expect(taskIsActive(task, [{ ...lease, taskId: "another-task" }])).toBe(false);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <TaskList tasks={[task]} usageByTaskId={{}} resourceLeases={[lease]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("cancelled · awaiting cleanup");
  });

  it("binds the saved report to its task and keeps its result immutable across resumed execution", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-p1-task");
    if (!detail.latestReport) throw new Error("A saved report fixture is required.");
    const header = structuredClone(detail.latestReport);
    expect(taskReportMatches(detail.task, header)).toBe(true);
    expect(taskReportMatches({ ...detail.task, state: "running" }, header)).toBe(true);
    expect(
      taskReportMatches(detail.task, {
        ...header,
        context: { ...header.context, task: { ...header.context.task, id: "other-task" } },
      }),
    ).toBe(false);
    expect(
      taskReportMatches(detail.task, {
        ...header,
        context: {
          ...header.context,
          workItem: { ...header.context.workItem, number: header.context.workItem.number + 1 },
        },
      }),
    ).toBe(false);
    expect(
      taskReportMatches(detail.task, {
        ...header,
        report: { ...header.report, logicalContentDigest: "f".repeat(64) },
      }),
    ).toBe(false);
    const queryClient = client();
    queryClient.setQueryData(taskDetailQueryKey(sessionIdentity(session), detail.task.id), {
      ...detail,
      task: { ...detail.task, state: "running" },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Task status and saved report");
    expect(html).toContain("Read report");
    expect(html).toContain(
      `https://github.com/${detail.task.repository.fullName}/pull/${detail.task.workItem.number}`,
    );
    expect(detail.latestReport).toEqual(header);
  });

  it("rejects a cached task that does not match the requested repository scope", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-p1-task");
    const queryClient = client();
    queryClient.setQueryData(taskDetailQueryKey(sessionIdentity(session), detail.task.id), detail);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[`/tasks?taskId=${detail.task.id}&repositoryId=another-repository`]}
        >
          <TaskDetails taskId={detail.task.id} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("unavailable in the current repository scope");
    expect(html).not.toContain(detail.task.workItem.title);
  });
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
      expect(html).toContain("Final analysis was not adopted because the task was cancelled");
      expect(html).toContain(
        stage === "started"
          ? "workflow start was recorded; application execution is not established"
          : "Worker observations or artifacts were recorded; final E2E feature results are unavailable",
      );
      expect(html).not.toContain("Investigation has not started.");
      const detailsHtml = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/tasks?taskId=${detail.task.id}&tab=details`]}>
            <TaskDetails taskId={detail.task.id} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(detailsHtml).toContain("0 accepted analysis rounds");
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
    expect(detailsHtml).toContain("3 model calls");
    expect(detailsHtml).toContain("3 accepted analysis rounds");
    expect(detailsHtml).toContain("Saved state v6");
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

  it("uses the next-action link for output, saved reports, and pending cleanup", async () => {
    const detail = await createSampleInvestigationApi().task("sample-pr-p1-task");
    const running = { ...detail.task, id: "running-task", state: "running" as const };
    const cleaning = { ...detail.task, id: "cleaning-task", state: "cancelled" as const };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <TaskList
            tasks={[detail.task, running, cleaning]}
            usageByTaskId={{}}
            resourceLeases={[
              {
                taskId: cleaning.id,
                attemptId: "cleanup-attempt",
                workerId: "worker",
                fence: 1,
                pool: "e2e",
                state: "needs_cleanup",
                acquiredAt: cleaning.createdAt,
                updatedAt: cleaning.updatedAt,
                releasedAt: null,
                reason: "cancelled",
              },
            ]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Review report:");
    expect(html).toContain("View output:");
    expect(html).toContain("View cleanup:");
    expect(html).toContain(
      `taskId=cleaning-task&amp;repositoryId=${cleaning.repository.id}&amp;tab=details`,
    );
    expect(html).toContain(`reportId=${detail.task.latestReportRef?.id}`);
    const shortcuts = html
      .match(/<a\b[^>]*>/gu)
      ?.filter((link) => link.includes("production-task-next"));
    expect(shortcuts).toHaveLength(3);
    for (const shortcut of shortcuts ?? [])
      expect(shortcut).toMatch(/id="review-result-[^"]+-next"/u);
    const openerIds = [...html.matchAll(/id="(review-result-[^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(openerIds).size).toBe(openerIds.length);
    expect(html).not.toContain("Task pages");
  });
});
