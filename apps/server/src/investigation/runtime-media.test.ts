import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvestigationPreview,
  type InvestigationArtifactV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationAutomaticReplySettings } from "../../dist/investigation/auto-reply-settings.js";
import { defaultAutomaticReplyTemplates } from "../../dist/investigation/auto-reply-template.js";
import { InvestigationEvidenceStore } from "../../dist/investigation/evidence-store.js";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import { InvestigationProgressReplies } from "../../dist/investigation/progress-reply.js";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationActionTransport, InvestigationProgressCommentRequest } from "./types.js";

const applications: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("production E2E media and comment assembly", () => {
  it("uploads retained evidence and patches the exact existing E2E comment without rerunning on sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-runtime-media-"));
    directories.push(directory);
    const dashboard = join(directory, "dashboard");
    await mkdir(dashboard);
    await writeFile(join(dashboard, "index.html"), "<!doctype html><title>Media fixture</title>");
    const password = "Synthetic media runtime password";
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_DATABASE_PATH: join(directory, "investigation.sqlite"),
      INVESTIGATION_AUTH_DATABASE_PATH: join(directory, "accounts.sqlite"),
      INVESTIGATION_DASHBOARD_DIRECTORY: dashboard,
      INVESTIGATION_GITHUB_TOKEN: "synthetic-media-token",
      INVESTIGATION_GITHUB_USER_ID: "42",
      INVESTIGATION_ENABLE_EXTERNAL_WRITES: "true",
    });
    const preview = createInvestigationPreview("pr", { findingCount: 0 });
    const now = new Date();
    const task: InvestigationTaskV1 = {
      ...preview.task,
      kind: "pr-e2e",
      state: "queued",
      latestReportRef: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
    if (subject.kind !== "original_pr") throw new Error("Invalid PR fixture.");
    const accounts = new InvestigationPasswordStore(config.authDatabasePath);
    const actor = await accounts.initializeBootstrap({
      username: "media-admin",
      password,
      displayName: "Media fixture",
      repositoryIds: [task.repository.id],
      permissions: ["repository:manage", "task:create", "action:prepare", "action:execute"],
      actionCapabilities: ["comment"],
    });
    accounts.close();
    if (actor === null) throw new Error("The fixture account was not created.");
    const requests: InvestigationProgressCommentRequest[] = [];
    const transport: InvestigationActionTransport = {
      supportedActions: ["comment"],
      readPublisherIdentity: async () => ({ githubUserId: 42, githubLogin: "synthetic-publisher" }),
      readTarget: async () => ({
        kind: "pull_request",
        state: "open",
        headSha: subject.headSha,
        revisionKey: subject.revisionKey,
      }),
      publishProgressComment: async (request, _repository, _target, _actor, beforeDispatch) => {
        beforeDispatch?.();
        requests.push(structuredClone(request));
        return {
          state: "succeeded",
          effect: "applied",
          retryable: false,
          reasonCode: "accepted",
          message: "Synthetic comment accepted.",
          externalId: "9002",
        };
      },
      reconcileProgressComment: async () => ({
        state: "unknown",
        message: "No reconciliation is expected.",
        externalId: null,
      }),
      execute: async () => {
        throw new Error("The independent E2E progress comment must be reused.");
      },
      reconcile: async () => {
        throw new Error("No native action is expected.");
      },
    };
    const store = new InvestigationStore(config.databasePath);
    try {
      store.insert("repositories", task.repository.id, task.repository);
      store.insert("tasks", task.id, task);
      store.insert("workItems", task.workItem.id, {
        ...task.workItem,
        repositoryId: task.repository.id,
        body: "Synthetic PR",
        state: "open",
        subject,
        updatedAt: task.updatedAt,
      });
      const settings = new InvestigationAutomaticReplySettings(store, true, () => now);
      settings.update(actor, task.repository.id, {
        version: 0,
        enabled: true,
        progressEnabled: true,
        pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
        issueTemplate: defaultAutomaticReplyTemplates.issue,
      });
      const pending = new InvestigationProgressReplies({
        store,
        settings,
        transport,
        resolveOperator: () => actor,
        enableExternalWrites: true,
        now: () => now,
      });
      pending.enqueue(task, {
        eventName: "issue_comment",
        actorUserId: 11,
        assigneeUserId: 42,
        actorLogin: "trusted-user",
        assigneeLogin: "synthetic-publisher",
        commandCommentId: 77,
      });
      pending.start();
      await pending.drain();
      await pending.stop();
      expect(requests).toHaveLength(1);
      const content = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
      const artifact: InvestigationArtifactV1 = {
        id: "runtime-media-image",
        taskId: task.id,
        attemptId: preview.result.context.attempt.id,
        subjectRef: task.subjectRef,
        kind: "image",
        name: "feature.png",
        mediaType: "image/png",
        digest: createHash("sha256").update(content).digest("hex"),
        byteLength: content.length,
        availability: "available",
      };
      new InvestigationEvidenceStore(store).upload(
        artifact,
        content.toString("base64"),
        () => undefined,
      );
      const report = structuredClone(preview.result);
      report.context.task.kind = "pr-e2e";
      report.context.e2e = {
        headSha: subject.headSha,
        buildIdentity: "Synthetic pinned build",
        features: [
          {
            id: "feature-one",
            title: "Feature one",
            paths: ["src/example.cs"],
            scenario: "Open and exercise the changed behavior.",
            userVisible: true,
            outcome: "passed",
            assertions: [
              {
                id: "assertion-one",
                expected: "The changed behavior works.",
                observed: "The Worker observed the expected result.",
                outcome: "passed",
                evidenceRefs: ["runtime-receipt"],
              },
            ],
            artifactRefs: [artifact.id],
            limitations: [],
          },
        ],
        cleanup: {
          confirmed: true,
          recordedAt: now.toISOString(),
          summary: "All attempt-owned processes stopped.",
        },
      };
      report.artifacts = [artifact];
      report.verificationEvidence = [
        {
          id: "runtime-receipt",
          subjectRef: task.subjectRef,
          source: "visual_observation",
          authority: "worker",
          summary: "The feature assertion and screenshot were captured.",
          artifactRefs: [artifact.id],
          evidenceRefs: [],
          provenance: {
            taskId: task.id,
            attemptId: report.context.attempt.id,
            producer: "e2e-tool-server",
            recordedAt: now.toISOString(),
          },
        },
      ];
      const completed: InvestigationTaskV1 = {
        ...task,
        state: "completed",
        latestReportRef: {
          id: report.report.id,
          version: report.report.version,
          digest: report.report.logicalContentDigest,
        },
      };
      store.put("tasks", task.id, completed);
      store.put("reports", report.report.id, report);
      pending.update(completed, report);
    } finally {
      store.close();
    }
    const mediaUrl =
      "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
    let uploadCount = 0;
    const app = await createInvestigationRuntime(config, {
      logger: false,
      actionTransport: transport,
      mediaUploadFetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.href === "https://api.github.com/user") return Response.json({ id: 42 });
        if (url.href === `https://api.github.com/repos/${task.repository.fullName}`)
          return Response.json({
            id: task.repository.githubRepositoryId,
            full_name: task.repository.fullName,
            permissions: { push: true },
          });
        expect(url.origin).toBe("https://uploads.github.com");
        expect(init?.method).toBe("POST");
        expect(url.searchParams.get("repository_id")).toBe(
          String(task.repository.githubRepositoryId),
        );
        uploadCount += 1;
        return Response.json({ url: mediaUrl });
      },
    });
    applications.push(app);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(uploadCount).toBe(1);
    expect(requests[1]).toMatchObject({
      externalId: "9002",
      marker: requests[0]!.marker,
      previousBody: requests[0]!.body,
    });
    expect(requests[1]!.body).toContain(`![feature.png](${mediaUrl})`);
    const origin = "http://127.0.0.1:8000";
    const host = "127.0.0.1:8000";
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host, origin },
      payload: { username: "media-admin", password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const headers = { host, origin, cookie };
    const comments = await app.inject({
      method: "GET",
      url: `/api/comments?taskIds=${task.id}`,
      headers,
    });
    const summary = comments.json().items[0];
    expect(summary.availableActions).toContain("sync");
    const sync = await app.inject({
      method: "POST",
      url: `/api/comments/${encodeURIComponent(summary.id)}/sync`,
      headers,
      payload: { version: summary.version, idempotencyKey: "retry-media-comment" },
    });
    expect(sync.statusCode).toBe(202);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(uploadCount).toBe(1);
    expect(requests[2]!.externalId).toBe("9002");
    const status = await app.inject({
      method: "GET",
      url: `/api/reports/${preview.result.report.id}/media-publication`,
      headers,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      state: "ready",
      uploadedCount: 1,
      totalCount: 1,
      uploads: [{ state: "uploaded", url: mediaUrl }],
    });
    const retained = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers });
    expect(retained.json().task.state).toBe("completed");
    expect(retained.json().attempts).toHaveLength(0);
  });
});
