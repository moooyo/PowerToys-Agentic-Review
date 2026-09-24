import type {
  InvestigationMediaPublication,
  InvestigationOutputPage,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvestigationReadApi } from "./read-api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createHttpTransport, resumeInvestigationRequests } from "./transport";

afterEach(() => resumeInvestigationRequests());

function outputPage(): InvestigationOutputPage {
  return {
    taskId: "task:selected",
    attemptId: "attempt:selected",
    items: [
      {
        schemaVersion: "InvestigationOutputEventV1",
        taskId: "task:selected",
        attemptId: "attempt:selected",
        invocationId: "invocation:selected",
        producerSequence: 1,
        itemId: "item:tool",
        kind: "tool",
        operation: "replace",
        text: "Read a source file.",
        command: "read source.ts",
        result: "The retained visible tool result.",
        status: "completed",
        observedAt: "2026-09-20T01:00:00.000Z",
        receivedAt: "2026-09-20T01:00:01.000Z",
        cursor: "cursor/1",
      },
    ],
    nextCursor: null,
    highWaterCursor: "cursor/1",
    earliestAvailableCursor: "cursor/1",
    lastAcceptedProducerSequence: 1,
    retainedEventCount: 1,
    truncated: false,
    cursorExpired: false,
  };
}

describe("production investigation readers", () => {
  it("reads bounded attempt output through the authenticated transport and preserves gap metadata", async () => {
    const page = { ...outputPage(), cursorExpired: true, truncated: true };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    const controller = new AbortController();
    expect(
      await api.taskOutput(
        "task:selected",
        { attemptId: "attempt:selected", after: "cursor/0", limit: 50 },
        controller.signal,
      ),
    ).toEqual(page);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/tasks/task%3Aselected/output-events?attemptId=attempt%3Aselected&after=cursor%2F0&limit=50",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      }),
    );
    controller.abort();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects private envelopes and responses bound to a different task or attempt", async () => {
    const page = outputPage();
    const event = page.items[0]!;
    const fetcher = vi.fn<typeof fetch>();
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    for (const value of [
      { ...page, taskId: "another-task" },
      { ...page, attemptId: "another-attempt" },
      { ...page, items: [{ ...event, taskId: "another-task" }] },
      { ...page, items: [{ ...event, attemptId: "another-attempt" }] },
      { ...page, items: [{ ...event, providerEnvelope: { token: "private" } }] },
      { ...page, items: [{ ...event, kind: "reasoning" }] },
      { ...page, items: [{ ...event, producerSequence: 0 }] },
      { ...page, items: [{ ...event, text: "x".repeat(16_385) }] },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(value));
      await expect(api.taskOutput(page.taskId, { attemptId: page.attemptId })).rejects.toThrow(
        "invalid structured response",
      );
    }
  });

  it("keeps immutable report and distinct publication directory pagination", async () => {
    const sample = createSampleInvestigationApi();
    const reports = await sample.reports({ limit: 1 });
    const publications = await sample.publications({ limit: 1 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(reports))
      .mockResolvedValueOnce(Response.json(publications));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    expect(
      await api.reports({
        repositoryId: "repo:selected",
        search: "Settings & more",
        cursor: "page/2",
        limit: 1,
      }),
    ).toEqual(reports);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/reports?repositoryId=repo%3Aselected&search=Settings+%26+more&cursor=page%2F2&limit=1",
      expect.anything(),
    );
    expect(
      await api.publicationDirectory({
        taskId: "task:selected",
        workItemKind: "pull_request",
        mode: "result",
        cursor: "page/2",
        limit: 1,
      }),
    ).toEqual(publications);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/publications?taskId=task%3Aselected&workItemKind=pull_request&mode=result&cursor=page%2F2&limit=1",
      expect.anything(),
    );
    expect(reports.nextCursor).not.toBeNull();
    expect(publications.nextCursor).not.toBeNull();
    expect(api.publicationDirectory).toBe(api.publications);
  });

  it("checks metadata ownership without reading artifact content", async () => {
    const sample = createSampleInvestigationApi();
    const page = await sample.taskArtifacts("sample-pr-partial-task");
    const item = page.items[0]!;
    expect(item).toBeDefined();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(page));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    expect(
      await api.taskArtifacts(page.taskId, { attemptId: item.artifact.attemptId, limit: 1 }),
    ).toEqual(page);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/artifacts?attemptId=");
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const invalid of [
      { ...page, taskId: "other-task" },
      { ...page, items: [{ ...item, artifact: { ...item.artifact, taskId: "other-task" } }] },
      { ...page, items: [{ ...item, artifact: { ...item.artifact, attemptId: "other-attempt" } }] },
      { ...page, items: [{ ...item, content: "base64-is-not-metadata" }] },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      await expect(
        api.taskArtifacts(page.taskId, { attemptId: item.artifact.attemptId }),
      ).rejects.toThrow("invalid structured response");
    }
  });

  it("reads the frozen revision and rejects mismatched or false available snapshots", async () => {
    const sample = createSampleInvestigationApi();
    const snapshot = await sample.workItemSnapshot("sample-pr-p1-work-item");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    expect(
      await api.workItemSnapshot(snapshot.workItemId, { revisionKey: snapshot.revisionKey }),
    ).toEqual(snapshot);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/work-items/${snapshot.workItemId}/discussion?revisionKey=${snapshot.revisionKey}`,
      expect.anything(),
    );
    for (const invalid of [
      { ...snapshot, workItemId: "other-item" },
      { ...snapshot, revisionKey: "b".repeat(64) },
      { ...snapshot, inputSnapshot: null },
      {
        ...snapshot,
        inputSnapshot: { ...snapshot.inputSnapshot, repositoryId: "other-repository" },
      },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      await expect(
        api.workItemSnapshot(snapshot.workItemId, { revisionKey: snapshot.revisionKey }),
      ).rejects.toThrow("invalid structured response");
    }
    const unavailable = {
      ...snapshot,
      availability: "unavailable",
      snapshotRef: null,
      inputSnapshot: null,
    };
    fetcher.mockResolvedValueOnce(Response.json(unavailable));
    expect(await api.workItemDiscussion(snapshot.workItemId)).toEqual(unavailable);
  });

  it("reads exact task defaults and bounded search metadata", async () => {
    const sample = createSampleInvestigationApi();
    const defaults = await sample.taskDefaults();
    const search = await sample.workspaceSearch({ query: "Settings", limit: 2 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(defaults))
      .mockResolvedValueOnce(Response.json(search));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    expect(await api.taskDefaults()).toEqual(defaults);
    expect(fetcher).toHaveBeenLastCalledWith("/api/investigation/task-defaults", expect.anything());
    expect(
      await api.workspaceSearch({
        query: "Settings & tools",
        repositoryId: "repo:selected",
        limit: 2,
      }),
    ).toEqual(search);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/workspace/search?query=Settings+%26+tools&repositoryId=repo%3Aselected&limit=2",
      expect.anything(),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ budget: { ...defaults.budget, maxReportBytes: 0 } }),
    );
    await expect(api.taskDefaults()).rejects.toThrow("invalid structured response");
  });

  it("preserves media publication state and rejects the wrong report identity", async () => {
    const value: InvestigationMediaPublication = {
      reportId: "report:selected",
      state: "blocked",
      retryable: false,
      uploadedCount: 0,
      totalCount: 1,
      blockers: ["External media upload is disabled."],
      uploads: [],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(value))
      .mockResolvedValueOnce(Response.json({ ...value, reportId: "other-report" }));
    const api = createInvestigationReadApi(createHttpTransport(fetcher));
    expect(await api.reportMediaPublication(value.reportId)).toEqual(value);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/reports/report%3Aselected/media-publication",
      expect.anything(),
    );
    await expect(api.reportMediaPublication(value.reportId)).rejects.toThrow(
      "invalid structured response",
    );
  });

  it.each([403, 404, 503])(
    "keeps an unavailable production reader as a %s error",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("Unavailable", { status }));
      const api = createInvestigationReadApi(createHttpTransport(fetcher));
      await expect(
        api.taskOutput("task:selected", { attemptId: "attempt:selected" }),
      ).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
