import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvestigationInputSnapshotV1, InvestigationTaskV1 } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationSourceImporter } from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationActionTransport } from "../../dist/investigation/types.js";
import type {
  InvestigationWebhookBinding,
  InvestigationWebhookConfig,
} from "../../dist/investigation/webhook-config.js";
import type { InvestigationWebhookDeliveryInput } from "../../dist/investigation/webhook-http.js";
import {
  InvestigationWebhookIntake,
  type InvestigationWebhookReceipt,
} from "../../dist/investigation/webhook-intake.js";

const repository = {
  id: "webhook-repository",
  fullName: "fixture/webhook",
  githubRepositoryId: 123,
};
const startedAt = Date.parse("2026-09-16T08:00:00.000Z");
const retryDelayMs = 60_000;
const stores: InvestigationStore[] = [];
const intakes: InvestigationWebhookIntake[] = [];
const directories: string[] = [];

interface Identity {
  id: number;
  login: string;
  type: string;
}

interface UpstreamTarget {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  comments: number;
  updated_at: string;
  assignees: Identity[];
  base?: { sha: string; repo: { id: number } };
  head?: { sha: string };
  review_comments?: number;
  merged_at?: string | null;
  pull_request?: unknown;
}

interface AssignmentPayload {
  action: string;
  repository: { id: number; full_name: string };
  sender: Identity;
  assignee: Identity;
  issue?: UpstreamTarget;
  pull_request?: UpstreamTarget;
}

afterEach(async () => {
  for (const intake of intakes.splice(0)) await intake.stop();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configuration(allowedActorUserIds: readonly number[] = [44]): InvestigationWebhookConfig {
  return {
    secret: "synthetic-webhook-secret-with-no-live-use",
    maximumPayloadBytes: 1024 * 1024,
    bindings: [{ repositoryId: repository.id, reviewerUserId: 55, allowedActorUserIds }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "investigation-webhook-intake-"));
  directories.push(directory);
  return join(directory, "investigation.sqlite");
}

/** Every upstream request uses this in-memory GET-only transport and synthetic identities. */
function harness(
  options: {
    kind?: "issue" | "pull_request";
    path?: string;
    now?: number;
    config?: InvestigationWebhookConfig;
    maximumAttempts?: number;
    settings?: { bindings: () => readonly InvestigationWebhookBinding[] };
    beforeTargetRead?: () => Promise<void>;
  } = {},
) {
  const kind = options.kind ?? "issue";
  const store = new InvestigationStore(options.path);
  stores.push(store);
  if (!store.has("repositories", repository.id))
    store.insert("repositories", repository.id, repository);
  const reviewer: Identity = { id: 55, login: "configured-reviewer", type: "User" };
  const upstream: UpstreamTarget = {
    id: 77,
    number: 7,
    title: "Frozen investigation title",
    body: "Complete original body with reproduction details.",
    state: "open",
    comments: 1,
    updated_at: new Date(startedAt).toISOString(),
    assignees: [reviewer],
    ...(kind === "issue"
      ? {}
      : {
          base: { sha: "b".repeat(40), repo: { id: repository.githubRepositoryId } },
          head: { sha: "a".repeat(40) },
          review_comments: 1,
          merged_at: null,
        }),
  };
  const comments = [{ id: 201, body: "Complete conversation comment" }];
  const calls: { path: string; method: string | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    calls.push({ path: `${url.pathname}${url.search}`, method: init?.method });
    if (url.pathname === "/user") return Response.json({ id: reviewer.id });
    if (url.pathname === "/repos/fixture/webhook")
      return Response.json({ id: repository.githubRepositoryId, full_name: repository.fullName });
    if (
      url.pathname === "/repos/fixture/webhook/issues/7" ||
      url.pathname === "/repos/fixture/webhook/pulls/7"
    )
      return Response.json(upstream);
    if (url.pathname === "/repos/fixture/webhook/issues/7/comments") return Response.json(comments);
    if (url.pathname === "/repos/fixture/webhook/pulls/7/comments")
      return Response.json([{ id: 301, body: "Complete inline review comment" }]);
    if (url.pathname === "/repos/fixture/webhook/pulls/7/reviews")
      return Response.json([{ id: 401, body: "Complete review summary" }]);
    throw new Error(`Unexpected synthetic upstream request: ${url.pathname}`);
  };
  const importer = new InvestigationSourceImporter({
    store,
    github: { token: "synthetic-read-only-token", expectedGitHubUserId: reviewer.id },
    fetch,
  });
  let now = options.now ?? startedAt;
  const actionTransport: InvestigationActionTransport | undefined =
    options.beforeTargetRead === undefined
      ? undefined
      : {
          supportedActions: [],
          readTarget: async (_repository, item) => {
            await options.beforeTargetRead!();
            return {
              kind: item.kind,
              state: item.state,
              revisionKey: item.subject.revisionKey,
              headSha: item.subject.kind === "original_pr" ? item.subject.headSha : null,
            };
          },
          execute: async () => {
            throw new Error("Synthetic intake must never execute an upstream mutation.");
          },
          reconcile: async () => {
            throw new Error("Synthetic intake must never reconcile an upstream mutation.");
          },
        };
  const service = new InvestigationService({
    store,
    prepareTaskInput: importer.prepareTaskInput,
    now: () => new Date(now),
    idFactory: () => `webhook-task-${randomUUID()}`,
    ...(actionTransport === undefined ? {} : { actionTransport }),
  });
  const errors: string[] = [];
  const intake = new InvestigationWebhookIntake({
    store,
    service,
    importer,
    config: options.config ?? configuration(),
    now: () => now,
    retryDelayMs,
    ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    onError: (code) => errors.push(code),
  });
  intakes.push(intake);
  function delivery(
    options: {
      id?: string;
      eventName?: string;
      mutate?: (payload: AssignmentPayload) => void;
    } = {},
  ): InvestigationWebhookDeliveryInput {
    const payload: AssignmentPayload = {
      action: "assigned",
      repository: { id: repository.githubRepositoryId, full_name: repository.fullName },
      sender: { id: 44, login: "trusted-maintainer", type: "User" },
      assignee: structuredClone(reviewer),
      ...(kind === "issue"
        ? { issue: structuredClone(upstream) }
        : { pull_request: structuredClone(upstream) }),
    };
    options.mutate?.(payload);
    return {
      deliveryId: options.id ?? "delivery-1",
      eventName: options.eventName ?? (kind === "issue" ? "issues" : "pull_request"),
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: new Date(now).toISOString(),
      payload,
    };
  }
  return {
    store,
    importer,
    service,
    intake,
    upstream,
    comments,
    calls,
    errors,
    delivery,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    tasks: () => store.list<InvestigationTaskV1>("tasks"),
    receipt: (id = "delivery-1") =>
      store.get<InvestigationWebhookReceipt>("idempotency", `webhook:delivery:${id}`)!,
  };
}

async function run(intake: InvestigationWebhookIntake): Promise<void> {
  intake.start();
  await intake.drain();
}

describe("durable assignment-only Webhook intake", () => {
  it.each(["issue", "pull_request"] as const)(
    "creates the correct frozen root Task for an authorized %s assignment",
    async (kind) => {
      const test = harness({ kind });
      const create = vi.spyOn(test.service, "createImportedTask");
      expect(test.intake.accept(test.delivery())).toEqual({ status: "accepted" });
      expect(test.receipt()).toMatchObject({ state: "accepted", attempts: 0, source: null });
      expect(test.tasks()).toHaveLength(0);
      expect(test.calls).toHaveLength(0);
      await run(test.intake);

      const [task] = test.tasks();
      expect(test.tasks()).toHaveLength(1);
      expect(task).toMatchObject({
        kind: kind === "issue" ? "issue-investigate" : "pr-review",
        state: "queued",
        repository,
        parentReportRef: null,
        planRef: null,
        executionPolicy: {
          mode: kind === "issue" ? "snapshot_only" : "source_read",
          allowRepositoryExecution: false,
          authorizationRef: null,
        },
      });
      expect(create.mock.calls[0]?.[0]).toEqual({
        id: "github-webhook:44",
        displayName: "GitHub user 44",
        repositoryIds: [repository.id],
        permissions: ["repository:manage", "task:create"],
        actionCapabilities: [],
        allowRepositoryExecution: false,
      });
      const input = test.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
        "idempotency",
        `input:${task!.id}`,
      )!;
      expect(input.inputSnapshot).toMatchObject({
        title: test.upstream.title,
        body: test.upstream.body,
      });
      expect(input.inputSnapshot.comments.map((comment) => comment.body)).toEqual(
        kind === "issue"
          ? ["Complete conversation comment"]
          : [
              "Complete conversation comment",
              "Complete inline review comment",
              "Complete review summary",
            ],
      );
      expect(test.receipt()).toMatchObject({
        state: "completed",
        attempts: 1,
        taskId: task!.id,
        reason: null,
      });
      expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
      expect(test.calls.every((call) => call.method === "GET")).toBe(true);
      expect(test.store.list("actionIntents")).toEqual([]);
    },
  );

  it.each([
    {
      name: "untrusted actor",
      reason: "assignment_not_authorized",
      mutate: (payload: AssignmentPayload) => {
        payload.sender.id = 99;
      },
    },
    {
      name: "bot actor",
      reason: "assignment_not_authorized",
      mutate: (payload: AssignmentPayload) => {
        payload.sender.type = "Bot";
      },
    },
    {
      name: "different assignee",
      reason: "assignment_not_authorized",
      mutate: (payload: AssignmentPayload) => {
        payload.assignee.id = 99;
      },
    },
    {
      name: "different repository ID",
      reason: "repository_not_configured",
      mutate: (payload: AssignmentPayload) => {
        payload.repository.id = 999;
      },
    },
    {
      name: "different repository name",
      reason: "repository_not_configured",
      mutate: (payload: AssignmentPayload) => {
        payload.repository.full_name = "fixture/other";
      },
    },
    {
      name: "closed Issue",
      reason: "work_item_not_open",
      mutate: (payload: AssignmentPayload) => {
        payload.issue!.state = "closed";
      },
    },
  ])("ignores $name without importing or creating any Task", async ({ reason, mutate }) => {
    const test = harness();
    expect(test.intake.accept(test.delivery({ mutate }))).toEqual({ status: "ignored", reason });
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.calls).toEqual([]);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
  });

  it.each(["opened", "edited", "unassigned", "review_requested", "synchronize"])(
    "does not schedule the unsupported %s action",
    async (action) => {
      const test = harness();
      expect(
        test.intake.accept(
          test.delivery({
            mutate: (payload) => {
              payload.action = action;
            },
          }),
        ),
      ).toEqual({ status: "ignored", reason: "unsupported_action" });
      await run(test.intake);
      expect(test.tasks()).toEqual([]);
      expect(test.calls).toEqual([]);
    },
  );

  it("does not inspect or scan upstream when started with an empty inbox", async () => {
    const test = harness();
    expect(test.intake.accept(test.delivery({ eventName: "issue_comment" }))).toEqual({
      status: "ignored",
      reason: "unsupported_event",
    });
    await run(test.intake);
    test.advance(24 * 60 * 60 * 1000);
    await test.intake.drain();
    expect(test.calls).toEqual([]);
    expect(test.tasks()).toEqual([]);
  });

  it("requires the assigned user to occur in the event's assignee list", () => {
    const test = harness();
    expect(() =>
      test.intake.accept(
        test.delivery({
          mutate: (payload) => {
            payload.issue!.assignees = [];
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_assignment" }));
    expect(test.tasks()).toEqual([]);
    expect(test.calls).toEqual([]);
  });

  it("deduplicates exact raw deliveries before and after Task completion", async () => {
    const test = harness();
    const delivery = test.delivery();
    expect(test.intake.accept(delivery)).toEqual({ status: "accepted" });
    expect(test.intake.accept(delivery)).toEqual({ status: "duplicate" });
    await run(test.intake);
    const [task] = test.tasks();
    const requestCount = test.calls.length;
    expect(test.intake.accept(delivery)).toEqual({ status: "duplicate", taskId: task!.id });
    await test.intake.drain();
    expect(test.tasks()).toHaveLength(1);
    expect(test.calls).toHaveLength(requestCount);
    expect(test.receipt().attempts).toBe(1);
  });

  it("rejects a reused delivery ID with a different raw payload digest", () => {
    const test = harness();
    const delivery = test.delivery();
    test.intake.accept(delivery);
    expect(() => test.intake.accept({ ...delivery, payloadSha256: "f".repeat(64) })).toThrow(
      expect.objectContaining({ code: "webhook_delivery_conflict", statusCode: 409 }),
    );
    expect(test.receipt().payloadSha256).toBe(delivery.payloadSha256);
  });

  it("does not disguise a conflicting existing delivery as an unsupported action", () => {
    const test = harness();
    test.intake.accept(test.delivery());
    expect(() =>
      test.intake.accept(
        test.delivery({
          mutate: (payload) => {
            payload.action = "edited";
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "webhook_delivery_conflict", statusCode: 409 }));
  });

  it("deduplicates the same assignment delivered under another delivery ID", async () => {
    const test = harness();
    test.intake.accept(test.delivery());
    expect(test.intake.accept(test.delivery({ id: "delivery-2" }))).toEqual({
      status: "duplicate",
    });
    expect(test.receipt("delivery-2")).toMatchObject({
      state: "ignored",
      reason: "duplicate_assignment",
    });
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt().attempts).toBe(1);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
  });

  it("recovers an accepted delivery after closing and reopening the database", async () => {
    const path = await databasePath();
    const first = harness({ path });
    first.intake.accept(first.delivery());
    await first.intake.stop();
    first.store.close();
    const second = harness({ path });
    await run(second.intake);
    expect(second.tasks()).toHaveLength(1);
    expect(second.receipt()).toMatchObject({ state: "completed", attempts: 1 });
  });

  it("recovers persisted source_ready input without importing a different snapshot", async () => {
    const path = await databasePath();
    const first = harness({ path });
    vi.spyOn(first.service, "createImportedTask").mockRejectedValueOnce(
      new Error("Synthetic pre-commit interruption"),
    );
    first.intake.accept(first.delivery());
    await run(first.intake);
    const frozenSource = first.receipt().source;
    const frozenRequest = first.receipt().taskRequest;
    expect(first.receipt()).toMatchObject({ state: "source_ready", attempts: 1, taskId: null });
    expect(first.tasks()).toEqual([]);
    await first.intake.stop();
    first.store.close();

    const second = harness({ path, now: startedAt + retryDelayMs });
    second.upstream.title = "Changed after the saved input";
    second.comments[0]!.body = "A later conversation must not replace the saved input";
    const importing = vi.spyOn(second.importer, "importWorkItem");
    await run(second.intake);
    expect(importing).not.toHaveBeenCalled();
    expect(second.receipt()).toMatchObject({
      state: "completed",
      attempts: 2,
      source: frozenSource,
      taskRequest: frozenRequest,
    });
    expect(second.tasks()).toHaveLength(1);
    const input = second.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
      "idempotency",
      `input:${second.tasks()[0]!.id}`,
    )!;
    expect(input.inputSnapshot.title).toBe("Frozen investigation title");
    expect(input.inputSnapshot.comments[0]!.body).toBe("Complete conversation comment");
  });

  it("recovers a committed Task without a second Task or another upstream read", async () => {
    const path = await databasePath();
    const first = harness({ path });
    const create = first.service.createImportedTask.bind(first.service);
    vi.spyOn(first.service, "createImportedTask").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("Synthetic interruption after atomic Task commit");
    });
    first.intake.accept(first.delivery());
    await run(first.intake);
    expect(first.tasks()).toHaveLength(1);
    expect(first.receipt()).toMatchObject({ state: "source_ready", taskId: null });
    const taskId = first.tasks()[0]!.id;
    await first.intake.stop();
    first.store.close();

    const second = harness({ path, now: startedAt + retryDelayMs });
    second.upstream.assignees = [];
    const creating = vi.spyOn(second.service, "createImportedTask");
    await run(second.intake);
    expect(creating).not.toHaveBeenCalled();
    expect(second.calls).toEqual([]);
    expect(second.tasks().map((task) => task.id)).toEqual([taskId]);
    expect(second.receipt()).toMatchObject({ state: "completed", taskId, attempts: 2 });
  });

  it("completes an already committed Task receipt after the effective grant is revoked", async () => {
    const path = await databasePath();
    const first = harness({ path });
    const create = first.service.createImportedTask.bind(first.service);
    vi.spyOn(first.service, "createImportedTask").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("Synthetic interruption after atomic Task commit");
    });
    first.intake.accept(first.delivery());
    await run(first.intake);
    expect(first.tasks()).toHaveLength(1);
    expect(first.receipt()).toMatchObject({ state: "source_ready", taskId: null });
    const taskId = first.tasks()[0]!.id;
    await first.intake.stop();
    first.store.close();

    const second = harness({
      path,
      now: startedAt + retryDelayMs,
      settings: { bindings: () => [] },
    });
    const creating = vi.spyOn(second.service, "createImportedTask");
    await run(second.intake);
    expect(creating).not.toHaveBeenCalled();
    expect(second.calls).toEqual([]);
    expect(second.tasks().map((task) => task.id)).toEqual([taskId]);
    expect(second.receipt()).toMatchObject({
      state: "completed",
      taskId,
      attempts: 2,
      reason: null,
    });
    expect(second.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
  });

  it("retains source_ready input when stopped during an import and resumes it later", async () => {
    const test = harness();
    const entered = deferred();
    const release = deferred();
    const importing = test.importer.importWorkItem.bind(test.importer);
    vi.spyOn(test.importer, "importWorkItem").mockImplementationOnce(async (...args) => {
      const result = await importing(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    test.intake.accept(test.delivery());
    test.intake.start();
    const draining = test.intake.drain();
    await entered.promise;
    const stopping = test.intake.stop();
    release.resolve();
    await draining;
    await stopping;
    expect(test.receipt()).toMatchObject({ state: "source_ready", taskId: null });
    expect(test.tasks()).toEqual([]);
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt().state).toBe("completed");
  });

  it("allows only one intake instance to own a pending delivery while its import is awaiting", async () => {
    const test = harness({ kind: "pull_request" });
    const entered = deferred();
    const release = deferred();
    const importing = test.importer.importWorkItem.bind(test.importer);
    const importCalls = vi
      .spyOn(test.importer, "importWorkItem")
      .mockImplementationOnce(async (...args) => {
        const result = await importing(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
    const other = new InvestigationWebhookIntake({
      store: test.store,
      service: test.service,
      importer: test.importer,
      config: configuration(),
      now: () => startedAt,
      retryDelayMs,
    });
    intakes.push(other);
    test.intake.accept(test.delivery());
    test.intake.start();
    const firstDrain = test.intake.drain();
    await entered.promise;
    test.comments[0]!.body = "Changed while the original delivery still has an active owner";
    try {
      await run(other);
      expect(importCalls).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await firstDrain;
    await other.drain();
    expect(test.tasks()).toHaveLength(1);
    const input = test.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
      "idempotency",
      `input:${test.tasks()[0]!.id}`,
    )!;
    expect(input.inputSnapshot.comments[0]!.body).toBe("Complete conversation comment");
  });

  it.each([
    {
      name: "assignment removal",
      kind: "issue" as const,
      code: "source_assignment_missing",
      change: (target: UpstreamTarget) => {
        target.assignees = [];
      },
    },
    {
      name: "Issue closure",
      kind: "issue" as const,
      code: "source_assignment_stale",
      change: (target: UpstreamTarget) => {
        target.state = "closed";
      },
    },
    {
      name: "different PR head",
      kind: "pull_request" as const,
      code: "source_assignment_revision_changed",
      change: (target: UpstreamTarget) => {
        target.head!.sha = "c".repeat(40);
      },
    },
    {
      name: "different upstream item identity",
      kind: "issue" as const,
      code: "source_assignment_target_changed",
      change: (target: UpstreamTarget) => {
        target.id = 78;
      },
    },
  ])("rejects a received assignment after $name", async ({ kind, code, change }) => {
    const test = harness({ kind });
    test.intake.accept(test.delivery());
    change(test.upstream);
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.receipt()).toMatchObject({ state: "failed", reason: code, attempts: 1 });
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
  });

  it("checks assignment again after importing the complete conversation", async () => {
    const test = harness();
    const importing = test.importer.importWorkItem.bind(test.importer);
    vi.spyOn(test.importer, "importWorkItem").mockImplementationOnce(async (...args) => {
      const result = await importing(...args);
      test.upstream.assignees = [];
      return result;
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.receipt()).toMatchObject({ state: "failed", reason: "source_assignment_missing" });
  });

  it("rejects a repository binding changed while source import is awaiting", async () => {
    const test = harness();
    const importing = test.importer.importWorkItem.bind(test.importer);
    vi.spyOn(test.importer, "importWorkItem").mockImplementationOnce(async (...args) => {
      const result = await importing(...args);
      test.store.put("repositories", repository.id, { ...repository, githubRepositoryId: 999 });
      return result;
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.receipt()).toMatchObject({
      state: "failed",
      reason: "webhook_authorization_revoked",
    });
  });

  it("rechecks the original repository binding after assignment verification awaits", async () => {
    const test = harness();
    const verifying = test.importer.verifyAssignment.bind(test.importer);
    vi.spyOn(test.importer, "verifyAssignment").mockImplementationOnce(async (...args) => {
      await verifying(...args);
      test.store.put("repositories", repository.id, { ...repository, githubRepositoryId: 999 });
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.receipt()).toMatchObject({
      state: "failed",
      reason: "webhook_authorization_revoked",
    });
  });

  it("rechecks the deployment grant before recovering an accepted delivery", async () => {
    const path = await databasePath();
    const first = harness({ path });
    first.intake.accept(first.delivery());
    await first.intake.stop();
    first.store.close();
    const second = harness({ path, config: configuration([45]) });
    await run(second.intake);
    expect(second.tasks()).toEqual([]);
    expect(second.calls).toEqual([]);
    expect(second.receipt()).toMatchObject({
      state: "failed",
      reason: "webhook_authorization_revoked",
    });
  });

  it.each(["import", "verification"] as const)(
    "rechecks live settings revoked while %s is awaiting",
    async (stage) => {
      let bindings: readonly InvestigationWebhookBinding[] = configuration().bindings;
      const test = harness({ settings: { bindings: () => bindings } });
      if (stage === "import") {
        const importing = test.importer.importWorkItem.bind(test.importer);
        vi.spyOn(test.importer, "importWorkItem").mockImplementationOnce(async (...args) => {
          const result = await importing(...args);
          bindings = [];
          return result;
        });
      } else {
        const verifying = test.importer.verifyAssignment.bind(test.importer);
        vi.spyOn(test.importer, "verifyAssignment").mockImplementationOnce(async (...args) => {
          await verifying(...args);
          bindings = [];
        });
      }
      test.intake.accept(test.delivery());
      await run(test.intake);
      expect(test.tasks()).toEqual([]);
      expect(test.receipt()).toMatchObject({
        state: "failed",
        reason: "webhook_authorization_revoked",
      });
    },
  );

  it("rejects a live grant revoked during the service's final upstream freshness read", async () => {
    let bindings: readonly InvestigationWebhookBinding[] = configuration().bindings;
    const test = harness({
      settings: { bindings: () => bindings },
      beforeTargetRead: async () => {
        await Promise.resolve();
        bindings = [];
      },
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.receipt()).toMatchObject({
      state: "failed",
      reason: "webhook_authorization_revoked",
    });
    expect(test.store.list("actionIntents")).toEqual([]);
  });

  it("binds the original PR snapshot even when another import replaces the current pointer", async () => {
    const test = harness({ kind: "pull_request" });
    const verifying = test.importer.verifyAssignment.bind(test.importer);
    vi.spyOn(test.importer, "verifyAssignment").mockImplementationOnce(
      async (actor, repositoryId, request, expectation) => {
        await verifying(actor, repositoryId, request, expectation);
        test.upstream.title = "Later PR title at the same base and head";
        test.comments[0]!.body = "Later comment content at the same base and head";
        await test.importer.importWorkItem(actor, repositoryId, request, expectation);
      },
    );
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    const task = test.tasks()[0]!;
    expect(task.workItem.title).toBe("Frozen investigation title");
    const input = test.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
      "idempotency",
      `input:${task.id}`,
    )!;
    expect(input.inputSnapshot.title).toBe("Frozen investigation title");
    expect(input.inputSnapshot.comments[0]!.body).toBe("Complete conversation comment");
    expect(test.store.get<{ title: string }>("workItems", task.workItem.id)?.title).toBe(
      test.upstream.title,
    );
  });

  it.each([
    { status: 503, code: "synthetic_upstream_unavailable" },
    { status: 429, code: "synthetic_upstream_rate_limit" },
    { status: 409, code: "source_changed_during_import" },
  ])("retries $code only after its persisted retry deadline", async ({ status, code }) => {
    const test = harness();
    const importing = vi
      .spyOn(test.importer, "importWorkItem")
      .mockRejectedValueOnce(
        new InvestigationRequestError(status, code, "Synthetic transient upstream read failure."),
      );
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.receipt()).toMatchObject({
      state: "accepted",
      attempts: 1,
      nextAttemptAt: startedAt + retryDelayMs,
      reason: code,
      source: null,
    });
    expect(test.tasks()).toEqual([]);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(1);
    test.advance(retryDelayMs);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(2);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt()).toMatchObject({ state: "completed", attempts: 2, reason: null });
    expect(test.errors).toEqual([]);
  });

  it("terminates repeated transient failure without scanning or creating Tasks", async () => {
    const test = harness({ maximumAttempts: 2 });
    const importing = vi
      .spyOn(test.importer, "importWorkItem")
      .mockRejectedValue(new Error("Synthetic repeated read failure"));
    test.intake.accept(test.delivery());
    await run(test.intake);
    test.advance(retryDelayMs);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(2);
    expect(test.receipt()).toMatchObject({
      state: "failed",
      attempts: 2,
      reason: "webhook_preparation_failed",
    });
    expect(test.errors).toEqual(["webhook_preparation_failed"]);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
    test.advance(24 * 60 * 60 * 1000);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(2);
    expect(test.calls).toEqual([]);
    expect(test.tasks()).toEqual([]);
  });

  it("lets an explicit exact redelivery retry failure with its original frozen source and Task request", async () => {
    const test = harness();
    const importing = vi.spyOn(test.importer, "importWorkItem");
    vi.spyOn(test.service, "createImportedTask").mockRejectedValueOnce(
      new InvestigationRequestError(
        409,
        "synthetic_task_blocked",
        "Synthetic one-time Task preparation blocker.",
      ),
    );
    const delivery = test.delivery();
    test.intake.accept(delivery);
    await run(test.intake);
    const source = test.receipt().source;
    const request = test.receipt().taskRequest;
    expect(test.receipt()).toMatchObject({
      state: "failed",
      attempts: 1,
      reason: "synthetic_task_blocked",
    });
    expect(test.tasks()).toEqual([]);
    expect(importing).toHaveBeenCalledTimes(1);

    test.comments[0]!.body = "New upstream text must not change the retry's source binding";
    expect(test.intake.accept(delivery)).toEqual({ status: "accepted" });
    expect(test.receipt()).toMatchObject({ attempts: 0, source, taskRequest: request });
    await test.intake.drain();
    expect(test.tasks()).toHaveLength(1);
    expect(importing).toHaveBeenCalledTimes(1);
    expect(test.receipt()).toMatchObject({
      state: "completed",
      attempts: 1,
      source,
      taskRequest: request,
      reason: null,
    });
    const input = test.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
      "idempotency",
      `input:${test.tasks()[0]!.id}`,
    )!;
    expect(input.inputSnapshot.comments[0]!.body).toBe("Complete conversation comment");
  });
});
