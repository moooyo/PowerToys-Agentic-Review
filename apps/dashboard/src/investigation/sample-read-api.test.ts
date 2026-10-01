import {
  INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
  InvestigationOutputPageSchema,
  InvestigationPublicationDirectoryPageSchema,
  InvestigationReportDirectoryPageSchema,
  type InvestigationSession,
  type InvestigationSessionUser,
  InvestigationTaskArtifactsPageSchema,
  InvestigationTaskDefaultsSchema,
  InvestigationWorkItemDiscussionSchema,
  InvestigationWorkspaceSearchResultSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvestigationApi } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createSampleReadApi } from "./sample-read-api";
import { createSessionScopedSampleApi } from "./sample-workspace-access";

const repositoryId = "repo-powertoys-fork";
const taskId = "sample-pr-p1-task";
const attemptId = "sample-pr-p1-attempt-1";
const workItemId = "sample-pr-p1-work-item";
const reportId = "sample-pr-p1-report";
const fetcher = vi.fn<typeof fetch>();

function signedIn(overrides: Partial<InvestigationSessionUser> = {}): InvestigationSession {
  return {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "reader",
      username: "reader",
      displayName: "Sample reader",
      email: null,
      isAdmin: false,
      repositoryIds: [repositoryId],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
      ...overrides,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(new Error("Development readers must not call a network service."));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit development read fixtures", () => {
  it("normalizes execution defaults without rewriting retained legacy budgets", async () => {
    const detail = await createSampleInvestigationApi().task(taskId);
    detail.task.budget = {
      maxRounds: 1,
      maxTokens: 1,
      maxDurationMs: 1_000,
      maxReportBytes: 16_384,
    };
    const original = structuredClone(detail);
    const api = createSampleReadApi({
      repositories: () => [],
      workItems: () => [],
      tasks: () => [detail],
      reports: () => [],
      artifacts: () => [],
      publications: () => [],
    });
    const defaults = await api.taskDefaults();
    expect(defaults.budget).toEqual({
      maxDurationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
      maxReportBytes: 16_384,
    });
    expect(detail).toEqual(original);
    defaults.budget.maxReportBytes = 1;
    expect((await api.taskDefaults()).budget.maxReportBytes).toBe(16_384);
  });

  it("uses shared contracts for every added sample read", async () => {
    const api = createSampleInvestigationApi();
    for (const [schema, value] of [
      [InvestigationTaskDefaultsSchema, await api.taskDefaults()],
      [InvestigationOutputPageSchema, await api.taskOutput(taskId, { attemptId })],
      [InvestigationTaskArtifactsPageSchema, await api.taskArtifacts(taskId)],
      [InvestigationReportDirectoryPageSchema, await api.reports()],
      [InvestigationPublicationDirectoryPageSchema, await api.publications()],
      [InvestigationWorkItemDiscussionSchema, await api.workItemSnapshot(workItemId)],
      [InvestigationWorkspaceSearchResultSchema, await api.workspaceSearch({ query: "Settings" })],
    ] as const)
      expect(Value.Check(schema, value)).toBe(true);
  });

  it("replays fixed attempt output without synthetic progress on repeated polls", async () => {
    const api = createSampleInvestigationApi();
    const first = await api.taskOutput(taskId, { attemptId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.text).toContain("synthetic");
    expect(first.nextCursor).not.toBeNull();
    const second = await api.taskOutput(taskId, { attemptId, after: first.nextCursor!, limit: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const poll = await api.taskOutput(taskId, { attemptId, after: second.highWaterCursor! });
    expect(poll.items).toEqual([]);
    expect(poll.highWaterCursor).toBe(second.highWaterCursor);
    expect(await api.taskOutput(taskId, { attemptId, limit: 1 })).toEqual(first);
    await expect(
      api.taskOutput("sample-bug-task", {
        attemptId: "sample-bug-attempt-1",
        after: first.highWaterCursor!,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.taskOutput(taskId, { attemptId: "another-attempt" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("traverses the entire report and publication fixtures with filter-bound cursors", async () => {
    const api = createSampleInvestigationApi();
    const reportIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.reports({ limit: 1, ...(cursor ? { cursor } : {}) });
      reportIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(new Set(reportIds).size).toBe(5);
    const publications = await api.publications({ limit: 1 });
    expect(publications.nextCursor).not.toBeNull();
    await expect(
      api.publications({ mode: "result", cursor: publications.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    const exact = await api.publications({ workItemNumber: 2101, taskKind: "pr-review" });
    expect(
      exact.items.every(
        (item) => item.producerTaskKind === "pr-review" && item.workItemNumber === 2101,
      ),
    ).toBe(true);
    expect(exact.items[0]?.workItemTitle).toContain("Sample");
  });

  it.each(["pull_request", "issue"] as const)(
    "filters %s publications before sample pagination and binds cursors to the work item kind",
    async (workItemKind) => {
      const api = createSampleInvestigationApi();
      const all = await api.publications({ repositoryId, limit: 50 });
      expect(all.nextCursor).toBeNull();
      const expected = all.items.filter((item) => item.workItemKind === workItemKind);
      expect(expected.length).toBeGreaterThan(1);
      const ids: string[] = [];
      let cursor: string | undefined;
      let firstCursor: string | null = null;
      do {
        const page = await api.publications({
          repositoryId,
          workItemKind,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.workItemKind).toBe(workItemKind);
        ids.push(...page.items.map((item) => item.id));
        firstCursor ??= page.nextCursor;
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(ids).toEqual(expected.map((item) => item.id));
      if (firstCursor === null) throw new Error("Expected a filtered publication continuation.");
      await expect(
        api.publications({
          repositoryId,
          workItemKind: workItemKind === "issue" ? "pull_request" : "issue",
          cursor: firstCursor,
        }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it("retains a frozen discussion copy and labels an unknown revision unavailable", async () => {
    const api = createSampleInvestigationApi();
    const first = await api.workItemSnapshot(workItemId);
    const body = first.inputSnapshot?.body;
    first.inputSnapshot!.body = "Changed by the caller";
    expect((await api.workItemSnapshot(workItemId)).inputSnapshot?.body).toBe(body);
    expect(await api.workItemSnapshot(workItemId, { revisionKey: "b".repeat(64) })).toMatchObject({
      availability: "unavailable",
      snapshotRef: null,
      inputSnapshot: null,
    });
    await expect(api.reportMediaPublication(reportId)).rejects.toMatchObject({ status: 400 });
  });
});

describe("development reader session grants", () => {
  it("rejects every new reader before accessing sample data after sign-out", async () => {
    const raw = createSampleInvestigationApi();
    for (const method of Object.keys(raw) as (keyof InvestigationApi)[]) vi.spyOn(raw, method);
    const api = createSessionScopedSampleApi(raw, async () => ({
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    }));
    const reads = [
      () => api.taskDefaults(),
      () => api.taskOutput(taskId, { attemptId }),
      () => api.taskArtifacts(taskId),
      () => api.reports(),
      () => api.publications(),
      () => api.publicationDirectory(),
      () => api.workItemSnapshot(workItemId),
      () => api.workItemDiscussion(workItemId),
      () => api.workspaceSearch({ query: "Settings" }),
      () => api.reportMediaPublication(reportId),
    ];
    for (const read of reads) await expect(read()).rejects.toMatchObject({ status: 401 });
    for (const method of Object.values(raw)) expect(method).not.toHaveBeenCalled();
  });

  it("keeps repository IDs exact even for administrators", async () => {
    const raw = createSampleInvestigationApi();
    const output = vi.spyOn(raw, "taskOutput");
    const artifacts = vi.spyOn(raw, "taskArtifacts");
    const discussion = vi.spyOn(raw, "workItemSnapshot");
    const media = vi.spyOn(raw, "reportMediaPublication");
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ isAdmin: true, repositoryIds: ["moooyo/PowerToys"] }),
    );
    await expect(api.taskOutput(taskId, { attemptId })).rejects.toMatchObject({ status: 403 });
    await expect(api.taskArtifacts(taskId)).rejects.toMatchObject({ status: 403 });
    await expect(api.workItemSnapshot(workItemId)).rejects.toMatchObject({ status: 403 });
    await expect(api.reportMediaPublication(reportId)).rejects.toMatchObject({ status: 403 });
    expect(output).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
    expect(discussion).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect((await api.reports()).items).toEqual([]);
    expect((await api.publications()).items).toEqual([]);
    expect((await api.workspaceSearch({ query: "Settings" })).items).toEqual([]);
  });

  it.each(["output", "artifacts", "discussion"] as const)(
    "discards a late %s response after repository access is revoked",
    async (kind) => {
      const raw = createSampleInvestigationApi();
      let current = signedIn();
      const api = createSessionScopedSampleApi(raw, async () => current);
      const saved =
        kind === "output"
          ? await raw.taskOutput(taskId, { attemptId })
          : kind === "artifacts"
            ? await raw.taskArtifacts(taskId)
            : await raw.workItemSnapshot(workItemId);
      const waiting = deferred<typeof saved>();
      const response =
        kind === "output"
          ? vi
              .spyOn(raw, "taskOutput")
              .mockImplementation(
                async () => waiting.promise as ReturnType<InvestigationApi["taskOutput"]>,
              )
          : kind === "artifacts"
            ? vi
                .spyOn(raw, "taskArtifacts")
                .mockImplementation(
                  async () => waiting.promise as ReturnType<InvestigationApi["taskArtifacts"]>,
                )
            : vi
                .spyOn(raw, "workItemSnapshot")
                .mockImplementation(
                  async () => waiting.promise as ReturnType<InvestigationApi["workItemSnapshot"]>,
                );
      const pending =
        kind === "output"
          ? api.taskOutput(taskId, { attemptId })
          : kind === "artifacts"
            ? api.taskArtifacts(taskId)
            : api.workItemSnapshot(workItemId);
      await vi.waitFor(() => expect(response).toHaveBeenCalled());
      current = signedIn({ repositoryIds: [] });
      waiting.resolve(saved);
      await expect(pending).rejects.toMatchObject({ status: 403 });
    },
  );

  it("discards a directory response from the previous identity", async () => {
    const raw = createSampleInvestigationApi();
    const saved = await raw.reports();
    const waiting = deferred<typeof saved>();
    const read = vi.spyOn(raw, "reports").mockReturnValue(waiting.promise);
    let current = signedIn();
    const api = createSessionScopedSampleApi(raw, async () => current);
    const pending = api.reports();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    current = signedIn({ id: "different-reader" });
    waiting.resolve(saved);
    await expect(pending).rejects.toMatchObject({ status: 401 });
  });

  it("aborts a read after its sample response but before it can be returned", async () => {
    const raw = createSampleInvestigationApi();
    const saved = await raw.workspaceSearch({ query: "Settings" });
    const controller = new AbortController();
    vi.spyOn(raw, "workspaceSearch").mockImplementation(async () => {
      controller.abort();
      return saved;
    });
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    await expect(
      api.workspaceSearch({ query: "Settings" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
