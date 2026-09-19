import { describe, expect, it, vi } from "vitest";
import { createInvestigationApi } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createHttpTransport } from "./transport";

describe("typed investigation HTTP operations", () => {
  it("reads production scheduler occupancy and only submits the editable static quota", async () => {
    const status = {
      staticConcurrency: 3,
      e2eConcurrency: 1,
      occupiedStatic: 2,
      occupiedE2e: 0,
      leases: [],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(status));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(await api.scheduler()).toEqual(status);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/investigation/scheduler",
      expect.objectContaining({ method: "GET" }),
    );
    expect(await api.updateScheduler({ staticConcurrency: 3 })).toEqual(status);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/investigation/scheduler",
      expect.objectContaining({ method: "PUT", body: '{"staticConcurrency":3}' }),
    );
    fetcher.mockResolvedValueOnce(Response.json({ ...status, e2eConcurrency: 2 }));
    await expect(api.scheduler()).rejects.toThrow("invalid structured response");
  });

  it("validates task usage and progress from the production routes without inventing absent counters", async () => {
    const sample = createSampleInvestigationApi();
    const detail = await sample.task("sample-pr-p1-task");
    const usage = {
      usage: {
        inputTokens: 800,
        cachedReadTokens: 600,
        outputTokens: 200,
        reasoningTokens: null,
        cacheWriteTokens: null,
        totalTokens: 1000,
        providerCounters: {},
      },
      reportedTokens: 1000,
      completeness: "partial",
      invocationCount: 2,
      activeInvocationCount: 1,
      unknownInvocationCount: 1,
      legacyTokens: 0,
    };
    const enriched = {
      ...detail,
      usage,
      invocations: [],
      resourceLeases: [],
      progress: {
        stage: "model",
        stageStartedAt: "2026-09-19T01:00:00Z",
        lastActivityAt: null,
        lastMeaningfulProgressAt: null,
        lastHeartbeatAt: "2026-09-19T01:00:05Z",
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(enriched));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect((await api.task(detail.task.id)).usage?.usage.reasoningTokens).toBeNull();
    expect(fetcher).toHaveBeenLastCalledWith(`/api/tasks/${detail.task.id}`, expect.anything());
    fetcher.mockResolvedValueOnce(
      Response.json({ items: [detail.task], usageByTaskId: { [detail.task.id]: usage } }),
    );
    expect((await api.tasks()).usageByTaskId?.[detail.task.id]?.reportedTokens).toBe(1000);
    fetcher.mockResolvedValueOnce(
      Response.json({ ...enriched, usage: { ...usage, reportedTokens: -1 } }),
    );
    await expect(api.task(detail.task.id)).rejects.toThrow("invalid structured response");
  });

  it("reads paginated delivery attempts and batch comment summaries through shared contracts", async () => {
    const sample = createSampleInvestigationApi();
    const history = await sample.commentDeliveries({ limit: 1 });
    const comments = await sample.comments({});
    const comment = comments.items[0];
    if (!comment || !history.items[0]) throw new Error("Comment fixtures are required.");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(history));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(
      await api.commentDeliveries({
        repositoryId: "repo:selected",
        workItemNumber: 7,
        taskId: "task:selected",
        state: "unknown",
        cursor: "cursor/1",
        limit: 25,
      }),
    ).toEqual(history);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comment-deliveries?repositoryId=repo%3Aselected&workItemNumber=7&taskId=task%3Aselected&state=unknown&cursor=cursor%2F1&limit=25",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    fetcher.mockResolvedValueOnce(Response.json(comments));
    expect(
      await api.comments({ repositoryId: "repo:selected", taskIds: ["task:one", "task:two"] }),
    ).toEqual(comments);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comments?repositoryId=repo%3Aselected&taskIds=task%3Aone%2Ctask%3Atwo",
      expect.anything(),
    );
    fetcher.mockResolvedValueOnce(Response.json(comments));
    await api.comments({ commentIds: ["comment:one", "comment:two"] });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comments?commentIds=comment%3Aone%2Ccomment%3Atwo",
      expect.anything(),
    );
    fetcher.mockResolvedValueOnce(Response.json(comment));
    expect(await api.comment("comment:selected")).toEqual(comment);
    expect(fetcher).toHaveBeenLastCalledWith("/api/comments/comment%3Aselected", expect.anything());
    fetcher.mockResolvedValueOnce(Response.json(history));
    expect(await api.commentAttempts("comment:selected", { cursor: "page/2", limit: 25 })).toEqual(
      history,
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comments/comment%3Aselected/attempts?cursor=page%2F2&limit=25",
      expect.anything(),
    );
    for (const invalid of [
      { ...history.items[0], operation: "reconcile" },
      { ...history.items[0], state: "synced" },
      { ...history.items[0], body: undefined },
      { ...history.items[0], taskId: 42 },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ items: [invalid], nextCursor: null }));
      await expect(api.commentDeliveries()).rejects.toThrow("invalid structured response");
    }
  });

  it("schedules only the selected versioned comment command and validates its returned summary", async () => {
    const comments = await createSampleInvestigationApi().comments({});
    const comment = comments.items[0];
    if (!comment) throw new Error("A comment fixture is required.");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(comment));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    const input = { version: "frozen-publication-version", idempotencyKey: "reviewed-command" };
    expect(await api.syncComment("comment:selected", input)).toEqual(comment);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comments/comment%3Aselected/sync",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
    expect(await api.reconcileComment("comment:selected", input)).toEqual(comment);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/comments/comment%3Aselected/reconcile",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const invalid of [
      { ...comment, version: 1 },
      { ...comment, availableActions: ["recreate"] },
      { ...comment, state: "succeeded" },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(invalid));
      await expect(api.comment(comment.id)).rejects.toThrow("invalid structured response");
    }
  });

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
      progressEnabled: true,
      progressTemplates: settings.progressTemplates,
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
      { ...settings, authorizationEpoch: -1 },
      { ...settings, updatedById: 42 },
      { ...settings, updatedAt: "invalid date" },
      { ...settings, progressEnabled: "true" },
      { ...settings, progressEnabled: undefined },
      { ...settings, progressTemplates: undefined },
      { ...settings, progressTemplates: { ...settings.progressTemplates, completed: undefined } },
      { ...settings, progressTemplates: { ...settings.progressTemplates, received: 42 } },
      { ...settings, progressTemplates: { ...settings.progressTemplates, extra: "template" } },
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

  it("retains compatibility with settings updates that omit progress fields", async () => {
    const sample = createSampleInvestigationApi();
    const settings = await sample.repositoryAutoReplySettings("repo-powertoys-fork");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(settings));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    const input = {
      version: settings.version,
      enabled: settings.enabled,
      pullRequestTemplate: settings.pullRequestTemplate,
      issueTemplate: settings.issueTemplate,
    };
    await api.updateRepositoryAutoReplySettings(settings.repositoryId, input);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/repositories/${settings.repositoryId}/auto-reply-settings`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
    );
  });

  it("reads scoped progress deliveries with nullable reports and validates their stages", async () => {
    const reply = {
      id: "progress-reply",
      reportId: null,
      taskId: "task-id",
      workItemId: "work-item-id",
      workItemKind: "pull_request",
      workItemNumber: 7,
      stage: "received",
      state: "sent",
      body: "Investigation received.",
      externalId: "comment-id",
      reason: null,
      settingsVersion: 1,
      templateVersion: 1,
      createdAt: "2026-09-18T03:00:00.000Z",
      updatedAt: "2026-09-18T03:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [reply] }));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(await api.repositoryProgressReplies("repo:selected")).toEqual({ items: [reply] });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/repositories/repo%3Aselected/progress-replies",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
    const completed = { ...reply, stage: "completed", reportId: "report-id" };
    fetcher.mockResolvedValueOnce(Response.json({ items: [completed] }));
    expect(await api.repositoryProgressReplies("repo:selected")).toEqual({ items: [completed] });
    for (const invalid of [
      { ...reply, stage: "queued" },
      { ...reply, state: "prepared" },
      { ...reply, reportId: 42 },
      { ...reply, settingsVersion: 0 },
      { ...reply, updatedAt: "invalid date" },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ items: [invalid] }));
      await expect(api.repositoryProgressReplies("repo:selected")).rejects.toThrow(
        "invalid structured response",
      );
    }
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
