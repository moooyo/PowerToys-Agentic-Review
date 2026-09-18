import { describe, expect, it, vi } from "vitest";
import { createInvestigationApi } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createHttpTransport } from "./transport";

describe("typed investigation HTTP operations", () => {
  it("reads and updates automatic reply settings and lists deliveries through scoped routes", async () => {
    const sample = createSampleInvestigationApi();
    const settings = {
      ...(await sample.repositoryAutoReplySettings("repo-powertoys-fork")),
      repositoryId: "repo:selected",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(settings));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(await api.repositoryAutoReplySettings("repo:selected")).toEqual(settings);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/repositories/repo%3Aselected/auto-reply-settings",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
    const input = {
      version: 0,
      enabled: true,
      pullRequestTemplate: settings.pullRequestTemplate,
      issueTemplate: settings.issueTemplate,
    };
    await api.updateRepositoryAutoReplySettings("repo:selected", input);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/repositories/repo%3Aselected/auto-reply-settings",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
    );
    fetcher.mockResolvedValueOnce(Response.json({ items: [] }));
    expect(await api.repositoryAutoReplies("repo:selected")).toEqual({ items: [] });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/repositories/repo%3Aselected/auto-replies",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
    for (const invalid of [
      { ...settings, version: -1 },
      { ...settings, templateVersion: 0 },
      { ...settings, authorizedById: 42 },
      { ...settings, updatedAt: "invalid date" },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      await expect(api.repositoryAutoReplySettings("repo:selected")).rejects.toThrow(
        "invalid structured response",
      );
    }
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ state: "confirmed" }] }));
    await expect(api.repositoryAutoReplies("repo:selected")).rejects.toThrow(
      "invalid structured response",
    );
  });

  it("reads and updates webhook settings for the selected repository with a versioned PUT", async () => {
    const settings = {
      repositoryId: "repo:selected",
      enabled: true,
      reviewerUserId: 1001,
      allowedActorUserIds: [2001, 2002],
      version: 3,
      receiverConfigured: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(settings));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(await api.repositoryWebhookSettings("repo:selected")).toEqual(settings);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/repositories/repo%3Aselected/webhook-settings",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
    const input = {
      version: 2,
      enabled: true,
      reviewerUserId: 1001,
      allowedActorUserIds: [2001, 2002],
    };
    expect(await api.updateRepositoryWebhookSettings("repo:selected", input)).toEqual(settings);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/repositories/repo%3Aselected/webhook-settings",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const invalid of [
      { ...settings, reviewerUserId: "username" },
      { ...settings, reviewerUserId: 0 },
      { ...settings, allowedActorUserIds: [2001, 2001] },
      { ...settings, allowedActorUserIds: [Number.MAX_SAFE_INTEGER + 1] },
      { ...settings, version: -1 },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      await expect(api.repositoryWebhookSettings("repo:selected")).rejects.toThrow(
        "invalid structured response",
      );
    }
  });

  it("reads and validates current artifact retention independently of report snapshots", async () => {
    const sample = createSampleInvestigationApi();
    const report = await sample.exportReport("sample-pr-partial-report");
    const artifact = report.artifacts[0];
    if (!artifact) throw new Error("The partial report omitted its evidence artifact.");
    const metadata = await sample.artifact(artifact.id);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(metadata));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    const signal = new AbortController().signal;
    expect(await api.artifact(artifact.id, signal)).toEqual(metadata);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/artifacts/${encodeURIComponent(artifact.id)}`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
    expect(artifact.availability).toBe("available");
    expect(metadata.artifact.availability).toBe("expired");
    fetcher.mockResolvedValue(Response.json({ ...metadata, expiredAt: "invalid date" }));
    await expect(api.artifact(artifact.id)).rejects.toThrow("invalid structured response");
  });

  it("imports a source snapshot using a scoped repository route without sending feedback", async () => {
    const sample = createSampleInvestigationApi();
    const workItem = await sample.workItem("sample-bug-work-item");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        workItem,
        snapshotRef: { id: "snapshot-import", digest: "1".repeat(64) },
        commentsCount: 3,
      }),
    );
    const api = createInvestigationApi(createHttpTransport(fetcher));
    await api.importWorkItem("repo-powertoys-fork", { kind: "issue", number: 6 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/repositories/repo-powertoys-fork/import-work-item",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "issue", number: 6 }),
      }),
    );
  });

  it("passes an explicitly chosen Issue source commit to task creation", async () => {
    const sample = createSampleInvestigationApi();
    const { task } = await sample.task("sample-bug-task");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(task));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    const sourceCommit = "a".repeat(40);
    await api.createTask({
      workItemId: task.workItem.id,
      kind: "issue-investigate",
      executionMode: "source_read",
      sourceCommit,
      idempotencyKey: "explicit-commit",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        body: JSON.stringify({
          workItemId: task.workItem.id,
          kind: "issue-investigate",
          executionMode: "source_read",
          sourceCommit,
          idempotencyKey: "explicit-commit",
        }),
      }),
    );
  });

  it("does not confirm an action when a preparation request succeeds", async () => {
    const sample = createSampleInvestigationApi();
    const workItem = await sample.workItem("sample-pr-p1-work-item");
    const context = await sample.actionContext(workItem.id);
    const input = {
      workItemId: workItem.id,
      action: "comment" as const,
      subjectRef: workItem.subject.id,
      expectedRevisionKey: context.target.revisionKey,
      expectedHeadSha: context.target.headSha,
      reportRef: context.reportRef,
      idempotencyKey: "prepare-only",
      payload: {
        kind: "feedback" as const,
        body: "A reviewed comment",
        findingIds: [],
        drafts: [],
      },
    };
    const intent = await sample.prepareAction(input);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(intent));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect((await api.prepareAction(input)).state).toBe("prepared");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/action-intents");
  });
});
