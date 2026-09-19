import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvestigationInputSnapshotV1, InvestigationTaskV1 } from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationSourceImporter } from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
} from "../../dist/investigation/types.js";
import type {
  InvestigationWebhookBinding,
  InvestigationWebhookConfig,
} from "../../dist/investigation/webhook-config.js";
import type { InvestigationWebhookDeliveryInput } from "../../dist/investigation/webhook-http.js";
import {
  InvestigationWebhookIntake,
  type InvestigationWebhookIntakeOptions,
  type InvestigationWebhookReceipt,
} from "../../dist/investigation/webhook-intake.js";

const repository = {
  id: "webhook-repository",
  fullName: "fixture/webhook",
  githubRepositoryId: 123,
};
const startedAt = Date.parse("2026-09-16T08:00:00.000Z");
const retryDelayMs = 60_000;
const operator: InvestigationOperatorPrincipal = {
  id: "intake-console-operator",
  displayName: "Synthetic intake operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
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
    onTaskCreated?: InvestigationWebhookIntakeOptions["onTaskCreated"];
    onAssignmentAccepted?: InvestigationWebhookIntakeOptions["onAssignmentAccepted"];
    onAssignmentChanged?: InvestigationWebhookIntakeOptions["onAssignmentChanged"];
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
    ...(options.onTaskCreated === undefined ? {} : { onTaskCreated: options.onTaskCreated }),
    ...(options.onAssignmentAccepted === undefined
      ? {}
      : { onAssignmentAccepted: options.onAssignmentAccepted }),
    ...(options.onAssignmentChanged === undefined
      ? {}
      : { onAssignmentChanged: options.onAssignmentChanged }),
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
  it("enrolls an authorized admission atomically before any source import or Task exists", () => {
    const accepted =
      vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
    const test = harness({ onAssignmentAccepted: accepted });
    accepted.mockImplementation((admission) => {
      expect(test.store.get("idempotency", admission.id)).toMatchObject({
        state: "accepted",
        admission,
      });
      expect(test.tasks()).toEqual([]);
      expect(test.store.list("workItems")).toEqual([]);
      test.store.insert("idempotency", "synthetic-publication-admission", {
        receiptId: admission.id,
      });
    });
    expect(test.intake.accept(test.delivery())).toEqual({ status: "accepted" });
    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted.mock.calls[0]?.[0]).toMatchObject({
      id: "webhook:delivery:delivery-1",
      repository,
      target: { repositoryId: repository.id, kind: "issue", number: 7, githubWorkItemId: 77 },
      expectedAssigneeUserId: 55,
      trigger: { actorUserId: 44, assigneeUserId: 55 },
      receivedAt: new Date(startedAt).toISOString(),
    });
    expect(test.calls).toEqual([]);
    expect(test.store.has("idempotency", "synthetic-publication-admission")).toBe(true);
    test.intake.accept(test.delivery());
    test.intake.accept(test.delivery({ id: "duplicate-admission" }));
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("rolls back both admission and publication when the acceptance callback fails", () => {
    const accepted =
      vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
    const test = harness({ onAssignmentAccepted: accepted });
    accepted.mockImplementation((admission) => {
      test.store.insert("idempotency", "synthetic-publication-admission", {
        receiptId: admission.id,
      });
      throw new Error("Synthetic publication enrollment failed.");
    });
    expect(() => test.intake.accept(test.delivery())).toThrow(
      "Synthetic publication enrollment failed.",
    );
    expect(test.store.list("idempotency")).toEqual([]);
    expect(test.tasks()).toEqual([]);
  });

  it("does not enroll historical accepted admissions when callbacks become available after restart", async () => {
    const path = await databasePath();
    const first = harness({ path });
    first.intake.accept(first.delivery());
    await first.intake.stop();
    first.store.close();
    const accepted =
      vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
    const attached = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
    const second = harness({ path, onAssignmentAccepted: accepted, onTaskCreated: attached });
    second.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    expect(second.intake.accept(second.delivery({ id: "historical-cycle-reassignment" }))).toEqual({
      status: "duplicate",
    });
    await run(second.intake);
    expect(accepted).not.toHaveBeenCalled();
    expect(attached).toHaveBeenCalledOnce();
    expect(attached.mock.calls[0]?.[3]?.id).toBe("webhook:delivery:delivery-1");
    expect(second.tasks()).toHaveLength(1);
  });

  it("finds a legacy active admission through bounded receipt pages without loading Task input records", () => {
    const test = harness();
    test.intake.accept(test.delivery());
    const original = test.receipt();
    const cycleKey = `webhook:active-cycle:${investigationContentDigest({
      repository,
      githubWorkItemId: 77,
      kind: "issue",
      number: 7,
      assigneeUserId: 55,
    })}`;
    test.store.delete("idempotency", cycleKey);
    for (let index = 0; index < 500; index += 1) {
      const id = `webhook:delivery:aaa-${String(index).padStart(3, "0")}`;
      test.store.insert("idempotency", id, {
        ...original,
        id,
        canonicalReceiptId: id,
        assignment: {
          ...original.assignment,
          number: index + 100,
          githubWorkItemId: index + 1_000,
        },
      });
    }
    test.store.insert("idempotency", "input:unrelated-task", {
      inputSnapshot: { body: "Unrelated retained source" },
    });
    const listed = vi.spyOn(test.store, "list");
    const paged = vi.spyOn(test.store, "pagePrefix");
    test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    expect(test.intake.accept(test.delivery({ id: "legacy-reassignment" }))).toEqual({
      status: "duplicate",
    });
    expect(test.receipt("legacy-reassignment").canonicalReceiptId).toBe(original.id);
    expect(listed.mock.calls.some(([collection]) => collection === "idempotency")).toBe(false);
    expect(paged.mock.calls.filter(([, prefix]) => prefix === "webhook:delivery:").length).toBe(2);
  });

  it("preserves a legacy prepared Task request key when the admission resumes", async () => {
    const test = harness({ maximumAttempts: 1 });
    vi.spyOn(test.service, "createImportedTask").mockRejectedValueOnce(
      new InvestigationRequestError(409, "synthetic_task_blocked", "Synthetic legacy pause"),
    );
    const delivery = test.delivery();
    test.intake.accept(delivery);
    await run(test.intake);
    const saved = test.receipt();
    if (saved.taskRequest === null)
      throw new Error("Expected a prepared synthetic legacy request.");
    const legacyRequest = { ...saved.taskRequest, idempotencyKey: "webhook:legacy-frozen-request" };
    const {
      admission: _admission,
      canonicalReceiptId: _canonicalReceiptId,
      ...legacyReceipt
    } = saved;
    test.store.put("idempotency", saved.id, { ...legacyReceipt, taskRequest: legacyRequest });
    expect(test.intake.accept(delivery)).toEqual({ status: "accepted" });
    await test.intake.drain();
    expect(test.receipt().taskRequest).toEqual(legacyRequest);
    expect(test.tasks()).toHaveLength(1);
    expect(
      test.store.has("idempotency", "task:github-webhook:44:webhook:legacy-frozen-request"),
    ).toBe(true);
  });

  it.each(["issue", "pull_request"] as const)(
    "joins repeated %s assignments to the canonical active admission despite source comment changes",
    async (kind) => {
      const accepted =
        vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
      const test = harness({
        kind,
        onAssignmentAccepted: accepted,
        config: configuration([44, 45]),
      });
      test.intake.accept(test.delivery());
      test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
      expect(test.intake.accept(test.delivery({ id: "during-preparation" }))).toEqual({
        status: "duplicate",
      });
      await run(test.intake);
      const task = test.tasks()[0]!;
      const calls = test.calls.length;
      test.comments[0]!.body = "The earlier progress comment changed the complete source snapshot.";
      test.upstream.updated_at = new Date(startedAt + 2_000).toISOString();
      expect(
        test.intake.accept(
          test.delivery({
            id: "active-reassignment",
            mutate: (payload) => {
              payload.sender.id = 45;
              payload.sender.login = "second-maintainer";
            },
          }),
        ),
      ).toEqual({ status: "duplicate", taskId: task.id });
      await test.intake.drain();
      expect(accepted).toHaveBeenCalledOnce();
      expect(test.tasks()).toEqual([task]);
      expect(test.calls).toHaveLength(calls);
      expect(test.receipt("active-reassignment")).toMatchObject({
        canonicalReceiptId: test.receipt().id,
        state: "ignored",
      });
      expect(test.receipt().taskRequest?.idempotencyKey).toBe(
        `webhook-admission:${investigationContentDigest(test.receipt().id)}`,
      );
    },
  );

  it("keeps a maximum-length webhook delivery ID within the Task idempotency key limit", async () => {
    const test = harness();
    const deliveryId = "d".repeat(128);
    test.intake.accept(test.delivery({ id: deliveryId }));
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt(deliveryId)).toMatchObject({ state: "completed" });
    expect(test.receipt(deliveryId).taskRequest!.idempotencyKey.length).toBeLessThanOrEqual(128);
  });

  it("starts a new cycle for a new assignment after Task completion but preserves old delivery replay", async () => {
    const accepted =
      vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
    const test = harness({ onAssignmentAccepted: accepted });
    const original = test.delivery();
    test.intake.accept(original);
    await run(test.intake);
    const task = test.tasks()[0]!;
    test.store.put("tasks", task.id, { ...task, state: "completed" });
    test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    expect(test.intake.accept(test.delivery({ id: "next-cycle" }))).toEqual({ status: "accepted" });
    expect(test.intake.accept(original)).toEqual({ status: "duplicate", taskId: task.id });
    await test.intake.drain();
    expect(test.tasks()).toHaveLength(2);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(test.receipt("next-cycle").canonicalReceiptId).toBe("webhook:delivery:next-cycle");
    expect(test.receipt("next-cycle").taskId).not.toBe(task.id);
  });

  it("creates a separate active PR cycle only for a new explicitly assigned revision", async () => {
    const accepted =
      vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentAccepted"]>>();
    const test = harness({ kind: "pull_request", onAssignmentAccepted: accepted });
    test.intake.accept(test.delivery());
    await run(test.intake);
    test.upstream.head!.sha = "c".repeat(40);
    test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    expect(test.intake.accept(test.delivery({ id: "new-pr-revision" }))).toEqual({
      status: "accepted",
    });
    await test.intake.drain();
    expect(test.tasks()).toHaveLength(2);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(test.receipt("new-pr-revision").admission?.headSha).toBe("c".repeat(40));
  });

  it.each([
    { code: "webhook_preparation_failed", state: "failed" },
    { code: "source_assignment_missing", state: "cancelled" },
  ] as const)("updates the same pre-Task admission after $code", async ({ code, state }) => {
    const changed = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onAssignmentChanged"]>>();
    const test = harness({ onAssignmentChanged: changed, maximumAttempts: 1 });
    vi.spyOn(test.importer, "importWorkItem").mockRejectedValueOnce(
      code === "webhook_preparation_failed"
        ? new Error("Synthetic read failure")
        : new InvestigationRequestError(409, code, "Synthetic removed assignment"),
    );
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(changed.mock.calls[0]?.[1]).toBe("preparing");
    expect(changed).toHaveBeenLastCalledWith(test.receipt().admission, state, code);
  });

  it.each(["issue", "pull_request"] as const)(
    "persists a %s assignment acknowledgement with trusted trigger identities",
    async (kind) => {
      const created = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
      const test = harness({ kind, onTaskCreated: created });
      created.mockImplementation((task, trigger) => {
        expect(test.store.get("tasks", task.id)).toEqual(task);
        test.store.insert("idempotency", "synthetic-progress-created", {
          taskId: task.id,
          trigger,
        });
      });
      test.intake.accept(test.delivery());
      await run(test.intake);
      const task = test.tasks()[0]!;
      expect(created).toHaveBeenCalledExactlyOnceWith(
        task,
        {
          eventName: kind === "issue" ? "issues" : "pull_request",
          actorUserId: 44,
          assigneeUserId: 55,
          actorLogin: "trusted-maintainer",
          assigneeLogin: "configured-reviewer",
        },
        true,
        test.receipt().admission,
      );
      expect(test.store.get("idempotency", "synthetic-progress-created")).toMatchObject({
        taskId: task.id,
      });
    },
  );

  it("retains numeric trigger identities when signed login fields are unsafe", async () => {
    const created = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
    const test = harness({ onTaskCreated: created });
    test.intake.accept(
      test.delivery({
        mutate: (payload) => {
          payload.sender.login = "@unexpected-mention";
          payload.assignee.login = "invalid\nmarkdown";
        },
      }),
    );
    await run(test.intake);
    expect(created.mock.calls[0]?.[1]).toEqual({
      eventName: "issues",
      actorUserId: 44,
      assigneeUserId: 55,
    });
  });

  it("does not create another task when the same assignment is redelivered with changed logins", async () => {
    const test = harness();
    test.intake.accept(test.delivery());
    expect(
      test.intake.accept(
        test.delivery({
          id: "renamed-identities-delivery",
          mutate: (payload) => {
            payload.sender.login = "renamed-maintainer";
            payload.assignee.login = "renamed-reviewer";
          },
        }),
      ),
    ).toEqual({ status: "duplicate" });
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
  });

  it("keeps task creation and acknowledgement persistence atomic on callback failure", async () => {
    const created = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
    const test = harness({ onTaskCreated: created, maximumAttempts: 1 });
    created.mockImplementation((task) => {
      test.store.insert("idempotency", "synthetic-progress-created", { taskId: task.id });
      throw new Error("Synthetic acknowledgement persistence failed.");
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toEqual([]);
    expect(test.store.has("idempotency", "synthetic-progress-created")).toBe(false);
    expect(test.receipt().state).toBe("failed");
  });

  it("does not treat a concurrent idempotent task return as new enrollment", async () => {
    const created = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
    const test = harness({ onTaskCreated: created });
    const verifyAssignment = test.importer.verifyAssignment.bind(test.importer);
    vi.spyOn(test.importer, "verifyAssignment").mockImplementationOnce(async (...args) => {
      await verifyAssignment(...args);
      const receipt = test.receipt();
      if (receipt.taskRequest === null || receipt.source === null)
        throw new Error("The synthetic concurrent creator requires prepared input.");
      await test.service.createImportedTask(args[0], receipt.taskRequest, receipt.source);
    });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt().state).toBe("completed");
    expect(created).toHaveBeenCalledOnce();
    expect(created.mock.calls[0]?.[2]).toBe(false);
  });

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

    const recovered = vi.fn<NonNullable<InvestigationWebhookIntakeOptions["onTaskCreated"]>>();
    const second = harness({ path, now: startedAt + retryDelayMs, onTaskCreated: recovered });
    second.upstream.assignees = [];
    const creating = vi.spyOn(second.service, "createImportedTask");
    await run(second.intake);
    expect(creating).not.toHaveBeenCalled();
    expect(second.calls).toEqual([]);
    expect(second.tasks().map((task) => task.id)).toEqual([taskId]);
    expect(second.receipt()).toMatchObject({ state: "completed", taskId, attempts: 2 });
    expect(recovered).toHaveBeenCalledExactlyOnceWith(
      second.tasks()[0],
      {
        eventName: "issues",
        actorUserId: 44,
        assigneeUserId: 55,
        actorLogin: "trusted-maintainer",
        assigneeLogin: "configured-reviewer",
      },
      false,
      second.receipt().admission,
    );
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

  it("fully reimports a stale prepared source before creating the canonical Task", async () => {
    const test = harness({ maximumAttempts: 2 });
    const importing = vi.spyOn(test.importer, "importWorkItem");
    const creating = vi
      .spyOn(test.service, "createImportedTask")
      .mockRejectedValueOnce(
        new InvestigationRequestError(409, "stale_subject", "The Issue changed after import."),
      );
    test.intake.accept(test.delivery());
    await run(test.intake);
    const firstSource = creating.mock.calls[0]![2];
    const originalSnapshot = test.store.get("sourceSnapshots", firstSource.snapshotRef.id);
    const originalKey = creating.mock.calls[0]![1].idempotencyKey;
    expect(test.receipt()).toMatchObject({
      state: "accepted",
      source: null,
      taskRequest: null,
      attempts: 1,
      reason: "stale_subject",
      nextAttemptAt: startedAt + retryDelayMs,
    });
    expect(test.tasks()).toEqual([]);
    test.upstream.title = "A new human clarification after the prepared snapshot";
    test.upstream.body = "The complete changed issue body must be imported again.";
    test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    test.comments[0]!.body = "A changed human comment must not be ignored as progress metadata.";
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(1);
    test.advance(retryDelayMs);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(2);
    expect(test.tasks()).toHaveLength(1);
    expect(creating.mock.calls[1]![1].idempotencyKey).toBe(originalKey);
    expect(test.receipt()).toMatchObject({ state: "completed", attempts: 2, reason: null });
    expect(test.store.get("sourceSnapshots", firstSource.snapshotRef.id)).toEqual(originalSnapshot);
    const task = test.tasks()[0]!;
    expect(test.store.get("idempotency", `input:${task.id}`)).toMatchObject({
      inputSnapshot: {
        title: test.upstream.title,
        body: test.upstream.body,
        comments: [{ id: "issue-comment:201", body: test.comments[0]!.body }],
      },
    });
  });

  it("recovers a committed Task before retrying a stale-source response", async () => {
    const test = harness();
    const importing = vi.spyOn(test.importer, "importWorkItem");
    const create = test.service.createImportedTask.bind(test.service);
    const creating = vi
      .spyOn(test.service, "createImportedTask")
      .mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new InvestigationRequestError(
          409,
          "stale_subject",
          "Synthetic lost committed Task response.",
        );
      });
    test.intake.accept(test.delivery());
    await run(test.intake);
    expect(test.tasks()).toHaveLength(1);
    expect(test.receipt()).toMatchObject({
      state: "completed",
      taskId: test.tasks()[0]!.id,
      attempts: 1,
      reason: null,
    });
    test.advance(retryDelayMs);
    await test.intake.drain();
    expect(importing).toHaveBeenCalledTimes(1);
    expect(creating).toHaveBeenCalledTimes(1);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
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

  it("retries a failed assignment from the console without losing its original failure", async () => {
    const test = harness({ maximumAttempts: 1 });
    vi.spyOn(test.service, "createImportedTask").mockRejectedValueOnce(
      new InvestigationRequestError(503, "synthetic_task_unavailable", "Synthetic Task failure."),
    );
    test.intake.accept(test.delivery());
    await run(test.intake);
    const failed = test.intake.readReceipt(operator, "delivery-1");
    const originalSource = test.receipt().source;
    const originalRequest = test.receipt().taskRequest;
    expect(failed).toMatchObject({
      state: "failed",
      totalAttempts: 1,
      availableActions: ["retry"],
      attemptHistory: [{ state: "failed", phase: "task", reason: "synthetic_task_unavailable" }],
    });
    const command = { version: failed.version, idempotencyKey: "retry-assignment-console" };
    const queued = test.intake.retryReceipt(operator, "delivery-1", command);
    expect(queued).toMatchObject({ state: "source_ready", attempts: 0, totalAttempts: 1 });
    expect(queued.attemptHistory).toEqual(failed.attemptHistory);
    expect(test.intake.retryReceipt(operator, "delivery-1", command)).toEqual(queued);
    expect(test.receipt()).toMatchObject({ source: originalSource, taskRequest: originalRequest });
    await test.intake.drain();
    const completed = test.intake.readReceipt(operator, "delivery-1");
    expect(completed).toMatchObject({ state: "completed", attempts: 1, totalAttempts: 2 });
    expect(completed.attemptHistory.map((attempt) => attempt.state)).toEqual([
      "failed",
      "completed",
    ]);
    expect(test.intake.retryReceipt(operator, "delivery-1", command)).toEqual(completed);
    expect(() =>
      test.intake.retryReceipt(operator, "delivery-1", {
        version: completed.version,
        idempotencyKey: "must-not-run-the-task-again",
      }),
    ).toThrow(expect.objectContaining({ code: "webhook_retry_unavailable" }));
    expect(test.tasks()).toHaveLength(1);
  });

  it("rejects stale, unauthorized, and revoked assignment retry commands before queueing", async () => {
    let bindings = configuration().bindings;
    const test = harness({ maximumAttempts: 1, settings: { bindings: () => bindings } });
    vi.spyOn(test.importer, "importWorkItem").mockRejectedValueOnce(new Error("Synthetic outage."));
    test.intake.accept(test.delivery());
    await run(test.intake);
    const failed = test.intake.readReceipt(operator, "delivery-1");
    const command = { version: failed.version, idempotencyKey: "retry-assignment-guarded" };
    expect(() =>
      test.intake.retryReceipt(operator, "delivery-1", {
        ...command,
        version: "stale",
      }),
    ).toThrow(expect.objectContaining({ code: "webhook_delivery_stale" }));
    expect(() =>
      test.intake.retryReceipt({ ...operator, permissions: [] }, "delivery-1", command),
    ).toThrow(expect.objectContaining({ code: "webhook_retry_forbidden" }));
    bindings = [];
    expect(() => test.intake.retryReceipt(operator, "delivery-1", command)).toThrow(
      expect.objectContaining({ code: "webhook_authorization_revoked" }),
    );
    expect(test.intake.readReceipt(operator, "delivery-1")).toEqual(failed);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
    expect(test.tasks()).toEqual([]);
  });

  it.each(["issue", "pull_request"] as const)(
    "joins a later %s assignment when the original Task committed before intake failed",
    async (kind) => {
      const test = harness({ kind, maximumAttempts: 1 });
      const create = test.service.createImportedTask.bind(test.service);
      const creating = vi
        .spyOn(test.service, "createImportedTask")
        .mockImplementationOnce(async (...args) => {
          await create(...args);
          throw new Error("Synthetic lost response after Task commit.");
        });
      test.intake.accept(test.delivery());
      await run(test.intake);
      const task = test.tasks()[0]!;
      expect(test.receipt()).toMatchObject({ state: "failed", taskId: null });
      expect(task.state).toBe("queued");
      test.calls.length = 0;
      test.advance(1_000);
      test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();

      expect(
        test.intake.accept(test.delivery({ id: "assignment-after-lost-response" })),
      ).toMatchObject({ status: "duplicate" });
      expect(test.receipt("assignment-after-lost-response")).toMatchObject({
        state: "ignored",
        reason: "active_assignment_cycle",
        canonicalReceiptId: test.receipt().id,
      });
      await test.intake.drain();
      expect(test.calls).toEqual([]);
      expect(creating).toHaveBeenCalledTimes(1);
      expect(test.tasks().map((entry) => entry.id)).toEqual([task.id]);
    },
  );

  it("recovers an old committed terminal Task without replacing a newer active assignment", async () => {
    let bindings = configuration().bindings;
    const test = harness({ maximumAttempts: 1, settings: { bindings: () => bindings } });
    const create = test.service.createImportedTask.bind(test.service);
    const creating = vi
      .spyOn(test.service, "createImportedTask")
      .mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new Error("Synthetic lost response after the original Task committed.");
      });
    test.intake.accept(test.delivery());
    await run(test.intake);
    const originalTask = test.tasks()[0]!;
    expect(test.receipt()).toMatchObject({ state: "failed", taskId: null });
    test.store.put("tasks", originalTask.id, { ...originalTask, state: "failed" });
    test.advance(1_000);
    test.upstream.updated_at = new Date(startedAt + 1_000).toISOString();
    expect(test.intake.accept(test.delivery({ id: "newer-assignment" }))).toEqual({
      status: "accepted",
    });
    await test.intake.drain();
    const newerTaskId = test.receipt("newer-assignment").taskId!;
    expect(newerTaskId).not.toBe(originalTask.id);
    expect(test.store.get<InvestigationTaskV1>("tasks", newerTaskId)?.state).toBe("queued");
    expect(creating).toHaveBeenCalledTimes(2);
    test.calls.length = 0;
    bindings = [];

    const failed = test.intake.readReceipt(operator, "delivery-1");
    test.intake.retryReceipt(operator, "delivery-1", {
      version: failed.version,
      idempotencyKey: "recover-old-task-with-newer-assignment",
    });
    await test.intake.drain();
    expect(test.intake.readReceipt(operator, "delivery-1")).toMatchObject({
      state: "completed",
      taskId: originalTask.id,
      attemptHistory: [
        { state: "failed", phase: "task" },
        { state: "completed", phase: "recovery", taskId: originalTask.id },
      ],
    });
    expect(test.calls).toEqual([]);
    expect(creating).toHaveBeenCalledTimes(2);
    expect(test.store.get<InvestigationTaskV1>("tasks", originalTask.id)?.state).toBe("failed");
    expect(test.store.get<InvestigationTaskV1>("tasks", newerTaskId)?.state).toBe("queued");

    bindings = configuration().bindings;
    test.advance(1_000);
    test.upstream.updated_at = new Date(startedAt + 2_000).toISOString();
    expect(test.intake.accept(test.delivery({ id: "assignment-after-recovery" }))).toEqual({
      status: "duplicate",
      taskId: newerTaskId,
    });
    expect(test.receipt("assignment-after-recovery").canonicalReceiptId).toBe(
      test.receipt("newer-assignment").id,
    );
    expect(test.tasks()).toHaveLength(2);
  });

  it("preserves a legacy assignment attempt count through a real retry cycle", async () => {
    const test = harness();
    test.intake.accept(test.delivery());
    const accepted = test.receipt();
    test.store.put("idempotency", accepted.id, {
      ...accepted,
      state: "failed",
      attempts: 3,
      reason: "legacy_preparation_failed",
    });
    test.store.delete("idempotency", accepted.pendingId);
    const failed = test.intake.readReceipt(operator, "delivery-1");
    expect(failed).toMatchObject({ totalAttempts: 3, attemptHistory: [] });

    const retried = test.intake.retryReceipt(operator, "delivery-1", {
      version: failed.version,
      idempotencyKey: "retry-legacy-assignment",
    });
    expect(retried).toMatchObject({ attempts: 0, totalAttempts: 3, attemptHistory: [] });
    await run(test.intake);
    expect(test.intake.readReceipt(operator, "delivery-1")).toMatchObject({
      state: "completed",
      attempts: 1,
      totalAttempts: 4,
      attemptHistory: [{ number: 4, cycleAttempt: 1, state: "completed" }],
    });
    expect(test.tasks()).toHaveLength(1);
  });

  it("closes an exhausted interrupted assignment without importing source or creating a Task", async () => {
    const test = harness({ maximumAttempts: 3 });
    test.intake.accept(test.delivery());
    const accepted = test.receipt();
    test.store.put("idempotency", accepted.id, {
      ...accepted,
      attempts: 3,
      claim: { ownerId: "interrupted-intake-owner", expiresAt: 0 },
    });
    const importing = vi.spyOn(test.importer, "importWorkItem");
    const verifying = vi.spyOn(test.importer, "verifyAssignment");
    const creating = vi.spyOn(test.service, "createImportedTask");

    await run(test.intake);
    expect(test.intake.readReceipt(operator, "delivery-1")).toMatchObject({
      state: "failed",
      attempts: 4,
      totalAttempts: 4,
      taskId: null,
      reason: "webhook_attempts_exhausted",
      attemptHistory: [
        {
          number: 4,
          cycleAttempt: 4,
          state: "failed",
          phase: "authorization",
          reason: "webhook_attempts_exhausted",
        },
      ],
    });
    expect(importing).not.toHaveBeenCalled();
    expect(verifying).not.toHaveBeenCalled();
    expect(creating).not.toHaveBeenCalled();
    expect(test.calls).toEqual([]);
    expect(test.tasks()).toEqual([]);
    expect(test.store.countPrefix("idempotency", "webhook:pending:")).toBe(0);
  });
});
