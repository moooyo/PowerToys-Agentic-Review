import { createHash, randomUUID } from "node:crypto";
import type { InvestigationInputSnapshotV1, InvestigationTaskV1 } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationE2eIntake,
  type InvestigationE2eReceipt,
  parseE2eCommand,
} from "../../dist/investigation/e2e-intake.js";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationSourceImporter } from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import type { InvestigationWebhookDeliveryInput } from "../../dist/investigation/webhook-http.js";

const repository = { id: "e2e-fixture", fullName: "fixture/e2e", githubRepositoryId: 123 };
const at = "2026-09-19T00:00:00.000Z";
const retryDelayMs = 60_000;
const actor: InvestigationOperatorPrincipal = {
  id: "fixture-reader",
  displayName: "Fixture reader",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "task:create", "task:cancel"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};
const resources: { intake: InvestigationE2eIntake; store: InvestigationStore }[] = [];
afterEach(async () => {
  for (const { intake, store } of resources.splice(0)) {
    await intake.stop();
    store.close();
  }
  vi.restoreAllMocks();
});

function harness(options: { maximumAttempts?: number } = {}) {
  let now = Date.parse(at);
  const store = new InvestigationStore();
  store.insert("repositories", repository.id, repository);
  const upstream = {
    id: 77,
    number: 9,
    state: "open",
    title: "Small PR",
    body: "One user-visible feature.",
    comments: 0,
    review_comments: 0,
    updated_at: at,
    merged_at: null,
    assignees: [],
    base: { sha: "b".repeat(40), repo: { id: repository.githubRepositoryId } },
    head: { sha: "a".repeat(40) },
  };
  const user = { id: 55, login: "reviewer", type: "User" };
  const mentionedUser = { ...user };
  const comments = new Map<
    number,
    { id: number; body: string; user: typeof user; issue_url: string }
  >();
  const binding = {
    repositoryId: repository.id,
    reviewerUserId: 55,
    allowedActorUserIds: [55],
    e2eEnabled: true,
  };
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    calls.push(url.pathname);
    if (url.pathname === "/user") return Response.json(user);
    if (url.pathname === "/users/reviewer") return Response.json(mentionedUser);
    if (url.pathname === "/repos/fixture/e2e")
      return Response.json({ id: 123, full_name: repository.fullName });
    if (url.pathname === "/repos/fixture/e2e/issues/9")
      return Response.json({
        ...upstream,
        id: 88,
        pull_request: { url: "https://api.github.com/repos/fixture/e2e/pulls/9" },
      });
    if (url.pathname === "/repos/fixture/e2e/pulls/9") return Response.json(upstream);
    if (url.pathname.startsWith("/repos/fixture/e2e/issues/comments/"))
      return Response.json(comments.get(Number(url.pathname.split("/").at(-1))));
    if (url.pathname.endsWith("/comments") || url.pathname.endsWith("/reviews"))
      return Response.json([]);
    throw new Error(`Unexpected fixture URL: ${url.pathname}`);
  };
  const importer = new InvestigationSourceImporter({
    store,
    github: { token: "synthetic-token", expectedGitHubUserId: 55 },
    fetch,
  });
  const service = new InvestigationService({
    store,
    now: () => new Date(now),
    idFactory: () => `e2e-task-${randomUUID()}`,
    prepareTaskInput: importer.prepareTaskInput,
  });
  const admitted = vi.fn();
  const attached = vi.fn();
  const changed = vi.fn();
  const errors: string[] = [];
  const ownCommentIds = new Set<number>();
  const intake = new InvestigationE2eIntake({
    store,
    importer,
    service,
    settings: { bindings: () => [binding] },
    now: () => now,
    retryDelayMs,
    ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
    onAdmission: admitted,
    onTaskCreated: attached,
    onAdmissionChanged: changed,
    isOwnComment: (_repositoryId, commentId) => ownCommentIds.has(commentId),
    onError: (code) => errors.push(code),
  });
  resources.push({ intake, store });
  function delivery(
    commentId = 901,
    body = "@reviewer e2e",
    mutate?: (payload: Record<string, any>) => void,
  ): InvestigationWebhookDeliveryInput {
    const comment = {
      id: commentId,
      body,
      user: structuredClone(user),
      issue_url: "https://api.github.com/repos/fixture/e2e/issues/9",
    };
    comments.set(commentId, comment);
    const payload: Record<string, any> = {
      action: "created",
      repository: { id: 123, full_name: repository.fullName },
      issue: { id: 88, number: 9, state: "open", pull_request: {} },
      sender: structuredClone(user),
      comment: structuredClone(comment),
    };
    mutate?.(payload);
    return {
      deliveryId: `delivery-${commentId}-${randomUUID()}`,
      eventName: "issue_comment",
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: at,
      payload,
    };
  }
  async function process(input = delivery()) {
    const response = intake.accept(input);
    intake.start();
    await intake.drain();
    return { response, receipt: intake.readReceipt(actor, input.deliveryId) };
  }
  return {
    store,
    upstream,
    user,
    mentionedUser,
    comments,
    binding,
    importer,
    service,
    intake,
    admitted,
    attached,
    changed,
    errors,
    calls,
    ownCommentIds,
    delivery,
    process,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    rawReceipt: (deliveryId: string) =>
      store.get<InvestigationE2eReceipt>("idempotency", `e2e:webhook:${deliveryId}`)!,
    tasks: () => store.list<InvestigationTaskV1>("tasks"),
  };
}

describe("standalone E2E commands", () => {
  it.each(["@reviewer e2e", "Please verify this.\n@reviewer e2e\nThanks.", "   @reviewer E2E  "])(
    "accepts independent command %s",
    (body) => expect(parseE2eCommand(body)).toEqual({ mentionLogin: "reviewer" }),
  );
  it.each([
    "> @reviewer e2e",
    "> quoted text\n@reviewer e2e",
    "    @reviewer e2e",
    "\t@reviewer e2e",
    "```text\n@reviewer e2e\n```",
    "~~~\n@reviewer e2e\n~~~",
    "<!--\n@reviewer e2e\n-->",
    "<!-- --> <!--\n@reviewer e2e\n-->",
    "<pre>\n@reviewer e2e\n</pre>",
    "Please @reviewer e2e",
    "@reviewer e2e extra",
    "@reviewer e2e\n@reviewer e2e",
  ])("ignores quoted or ambiguous command %s", (body) => expect(parseE2eCommand(body)).toBeNull());
});

describe("durable trusted E2E intake", () => {
  it("requires explicit E2E opt-in and ignores the application's own recorded comments", () => {
    const h = harness();
    h.binding.e2eEnabled = false;
    expect(h.intake.accept(h.delivery()).status).toBe("ignored");
    h.binding.e2eEnabled = true;
    h.ownCommentIds.add(902);
    expect(h.intake.accept(h.delivery(902))).toMatchObject({
      status: "ignored",
      reason: "automation_comment",
    });
    expect(h.calls).toEqual([]);
  });
  it("creates a standalone pinned executable Task without requiring assignment or a static report", async () => {
    const h = harness();
    const { receipt } = await h.process();
    expect(h.errors).toEqual([]);
    expect(receipt.state).toBe("completed");
    const task = h.tasks()[0]!;
    expect(task).toMatchObject({
      kind: "pr-e2e",
      parentTaskId: null,
      parentReportRef: null,
      planRef: null,
      executionPolicy: { mode: "execute", allowRepositoryExecution: true },
    });
    expect(task.subjects[0]).toMatchObject({ kind: "original_pr", headSha: "a".repeat(40) });
    expect(task.scope.includedUnits[0]?.kind).toBe("e2e_features");
    expect(h.admitted).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "e2e",
        target: expect.objectContaining({ githubWorkItemId: 77 }),
        trigger: expect.objectContaining({ eventName: "issue_comment", commandCommentId: 901 }),
      }),
    );
    expect(h.attached).toHaveBeenCalledTimes(1);
    expect(h.calls).toContain("/users/reviewer");
  });
  it("deduplicates both delivery IDs and new deliveries of one comment", async () => {
    const h = harness();
    const input = h.delivery();
    await h.process(input);
    expect(h.intake.accept(input).status).toBe("duplicate");
    const duplicate = { ...input, deliveryId: "redelivery" };
    expect(h.intake.accept(duplicate)).toMatchObject({
      status: "duplicate",
      taskId: h.tasks()[0]!.id,
    });
    expect(h.tasks()).toHaveLength(1);
  });
  it("joins an active PR revision without creating another Task or publication", async () => {
    const h = harness();
    await h.process();
    const { receipt } = await h.process(h.delivery(902));
    expect(receipt).toMatchObject({ reason: "active_e2e_revision", taskId: h.tasks()[0]!.id });
    expect(h.tasks()).toHaveLength(1);
    expect(h.admitted).toHaveBeenCalledTimes(1);
  });
  it("allows an explicit new comment to rerun a terminal revision", async () => {
    const h = harness();
    await h.process();
    const first = h.tasks()[0]!;
    h.store.put("tasks", first.id, { ...first, state: "cancelled" });
    await h.process(h.delivery(902));
    expect(h.tasks()).toHaveLength(2);
    expect(h.admitted).toHaveBeenCalledTimes(2);
  });
  it("cancels old queued work on a signed synchronize event without creating new E2E work", async () => {
    const h = harness();
    await h.process();
    h.upstream.head.sha = "c".repeat(40);
    const payload = {
      action: "synchronize",
      repository: { id: 123, full_name: repository.fullName },
      sender: h.user,
      pull_request: h.upstream,
    };
    const input = {
      deliveryId: "push-delivery",
      eventName: "pull_request",
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: at,
      payload,
    };
    const { receipt } = await h.process(input);
    expect(receipt).toMatchObject({ state: "completed", reason: "revision_observed" });
    expect(h.tasks()).toHaveLength(1);
    expect(h.tasks()[0]!.state).toBe("cancelled");
    expect(h.store.has("idempotency", `e2e:superseded:${h.tasks()[0]!.id}`)).toBe(true);
  });
  it("uses the current upstream head instead of trusting a stale synchronize payload", async () => {
    const h = harness();
    await h.process();
    const payload = {
      action: "synchronize",
      repository: { id: 123, full_name: repository.fullName },
      sender: h.user,
      pull_request: { ...h.upstream, head: { sha: "c".repeat(40) } },
    };
    await h.process({
      deliveryId: "stale-push",
      eventName: "pull_request",
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: at,
      payload,
    });
    expect(h.tasks()[0]!.state).toBe("queued");
  });
  it("requests cleanup instead of releasing a running E2E slot after a new head", async () => {
    const h = harness();
    await h.process();
    const worker = { id: "fixture-worker", repositoryIds: [repository.id] };
    h.service.workerControls.initialize([worker]);
    h.service.updateWorkerE2e({ ...actor, id: "fixture-worker-admin", isAdmin: true }, worker.id, {
      version: h.service.workerControls.get(worker.id)!.version,
      e2eEnabled: true,
    });
    const claim = h.service.workerClaim(worker, { supportedKinds: ["pr-e2e"] }).claim;
    expect(claim).not.toBeNull();
    h.upstream.head.sha = "c".repeat(40);
    const { receipt } = await h.process(h.delivery(902));
    expect(receipt).toMatchObject({ state: "completed", reason: null });
    expect(h.tasks()).toHaveLength(2);
    expect(
      h.service.workerHeartbeat(worker, claim!.task.id, { lease: claim!.lease }).cancelRequested,
    ).toBe(true);
    expect(h.service.workerClaim(worker, { supportedKinds: ["pr-e2e"] }).claim).toBeNull();
    expect(h.service.schedulerStatus(actor).leases[0]?.state).toBe("needs_cleanup");
  });
  it("serializes revision observations for one PR across intake instances", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = h.importer.verifyE2eCommand.bind(h.importer);
    const observed = vi
      .spyOn(h.importer, "verifyE2eCommand")
      .mockImplementationOnce(async (...args) => {
        const revision = await verify(...args);
        await gate;
        return revision;
      });
    h.intake.accept(h.delivery());
    h.intake.start();
    const first = h.intake.drain();
    const second = new InvestigationE2eIntake({
      store: h.store,
      importer: h.importer,
      service: h.service,
      settings: { bindings: () => [h.binding] },
      now: () => Date.parse(at),
    });
    try {
      second.accept(h.delivery(902));
      second.start();
      await second.drain();
      expect(observed).toHaveBeenCalledTimes(1);
      expect(h.tasks()).toEqual([]);
      release();
      await first;
      expect(h.tasks()).toHaveLength(1);
    } finally {
      release();
      await second.stop();
    }
  });
  it.each([
    [
      "edited",
      (p: Record<string, any>) => {
        p.action = "edited";
      },
    ],
    [
      "bot",
      (p: Record<string, any>) => {
        p.sender.type = "Bot";
        p.comment.user.type = "Bot";
      },
    ],
    [
      "untrusted",
      (p: Record<string, any>) => {
        p.sender.id = 99;
        p.comment.user.id = 99;
      },
    ],
    [
      "mismatched sender",
      (p: Record<string, any>) => {
        p.comment.user.id = 99;
      },
    ],
    [
      "wrong repository",
      (p: Record<string, any>) => {
        p.repository.id = 999;
      },
    ],
    [
      "issue",
      (p: Record<string, any>) => {
        delete p.issue.pull_request;
      },
    ],
  ] as const)("ignores %s events before upstream requests", async (_name, mutate) => {
    const h = harness();
    expect(h.intake.accept(h.delivery(901, "@reviewer e2e", mutate)).status).toBe("ignored");
    expect(h.calls).toEqual([]);
    expect(h.tasks()).toEqual([]);
  });
  it("fails closed when the mention resolves to a different numeric user", async () => {
    const h = harness();
    const input = h.delivery();
    h.mentionedUser.id = 99;
    await h.process(input);
    expect(h.tasks()).toEqual([]);
    expect(h.errors).toContain("e2e_mention_not_authorized");
  });
  it("refuses a command edited after delivery", async () => {
    const h = harness();
    const input = h.delivery();
    h.comments.get(901)!.body = "changed";
    const { receipt } = await h.process(input);
    expect(receipt.reason).toBe("e2e_command_changed");
    expect(h.tasks()).toEqual([]);
  });
  it("rechecks repository authorization after fetching upstream", async () => {
    const h = harness();
    const original = h.importer.verifyE2eCommand.bind(h.importer);
    vi.spyOn(h.importer, "verifyE2eCommand").mockImplementation(async (...args) => {
      const revision = await original(...args);
      h.binding.e2eEnabled = false;
      return revision;
    });
    await h.process();
    expect(h.errors).toContain("e2e_authorization_revoked");
    expect(h.tasks()).toEqual([]);
  });

  it("retries transient failures only until the limit and permits an exact failed redelivery", async () => {
    const h = harness({ maximumAttempts: 2 });
    const importing = vi
      .spyOn(h.importer, "importWorkItem")
      .mockRejectedValueOnce(new Error("Synthetic initial source failure."))
      .mockRejectedValueOnce(new Error("Synthetic repeated source failure."));
    const input = h.delivery();
    const { receipt: first } = await h.process(input);
    expect(first).toMatchObject({
      state: "accepted",
      attempts: 1,
      totalAttempts: 1,
      reason: "e2e_preparation_failed",
    });
    await h.intake.drain();
    expect(importing).toHaveBeenCalledTimes(1);
    h.advance(retryDelayMs);
    await h.intake.drain();
    const failed = h.intake.readReceipt(actor, input.deliveryId);
    expect(failed).toMatchObject({
      state: "failed",
      attempts: 2,
      totalAttempts: 2,
      taskId: null,
      reason: "e2e_preparation_failed",
    });
    expect(failed.attemptHistory.map((attempt) => attempt.state)).toEqual(["retrying", "failed"]);
    expect(h.store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
    h.advance(24 * 60 * 60 * 1000);
    await h.intake.drain();
    expect(importing).toHaveBeenCalledTimes(2);

    const otherDelivery = { ...input, deliveryId: "failed-command-redelivery" };
    expect(h.intake.accept(otherDelivery)).toMatchObject({ status: "duplicate" });
    expect(h.intake.readReceipt(actor, otherDelivery.deliveryId)).toMatchObject({
      state: "ignored",
      reason: "duplicate_comment",
      taskId: null,
    });
    expect(h.intake.accept(input)).toEqual({ status: "accepted" });
    expect(h.intake.readReceipt(actor, input.deliveryId)).toMatchObject({
      state: "accepted",
      attempts: 0,
      totalAttempts: 2,
      attemptHistory: failed.attemptHistory,
    });
    await h.intake.drain();
    const completed = h.intake.readReceipt(actor, input.deliveryId);
    expect(completed).toMatchObject({
      state: "completed",
      mode: "e2e",
      attempts: 1,
      totalAttempts: 3,
      reason: null,
      taskId: h.tasks()[0]!.id,
    });
    expect(completed.attemptHistory.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
    expect(completed.attemptHistory.map((attempt) => attempt.cycleAttempt)).toEqual([1, 2, 1]);
    expect(importing).toHaveBeenCalledTimes(3);
    expect(h.tasks()).toHaveLength(1);
  });

  it("preserves the original source and Task request through an explicit retry", async () => {
    const h = harness({ maximumAttempts: 1 });
    const importing = vi.spyOn(h.importer, "importWorkItem");
    const creating = vi
      .spyOn(h.service, "createImportedTask")
      .mockRejectedValueOnce(
        new InvestigationRequestError(503, "synthetic_task_unavailable", "Synthetic Task failure."),
      );
    const input = h.delivery();
    const { receipt: failed } = await h.process(input);
    expect(failed).toMatchObject({ state: "failed", attempts: 1, taskId: null });
    const { source, taskRequest } = structuredClone(h.rawReceipt(input.deliveryId));
    expect(source).not.toBeNull();
    expect(taskRequest).not.toBeNull();
    const snapshot = h.store.get("sourceSnapshots", source!.snapshotRef.id);
    h.upstream.title = "A later title must not replace the admitted source.";
    h.upstream.body = "A later body must not replace the admitted source.";

    const request = { version: failed.version, idempotencyKey: "retry-frozen-e2e-source" };
    const accepted = h.intake.retryReceipt(actor, input.deliveryId, request);
    expect(accepted).toMatchObject({
      state: "source_ready",
      attempts: 0,
      totalAttempts: 1,
      attemptHistory: failed.attemptHistory,
    });
    expect(h.intake.retryReceipt(actor, input.deliveryId, request)).toEqual(accepted);
    expect(h.rawReceipt(input.deliveryId)).toMatchObject({ source, taskRequest });
    await h.intake.drain();

    const completed = h.intake.readReceipt(actor, input.deliveryId);
    expect(completed).toMatchObject({
      state: "completed",
      attempts: 1,
      totalAttempts: 2,
      taskId: h.tasks()[0]!.id,
      reason: null,
    });
    expect(completed.attemptHistory.map((attempt) => attempt.state)).toEqual([
      "failed",
      "completed",
    ]);
    expect(h.rawReceipt(input.deliveryId)).toMatchObject({ source, taskRequest });
    expect(h.store.get("sourceSnapshots", source!.snapshotRef.id)).toEqual(snapshot);
    expect(importing).toHaveBeenCalledTimes(1);
    expect(creating).toHaveBeenCalledTimes(2);
    expect(creating.mock.calls[1]![1]).toEqual(taskRequest);
    expect(creating.mock.calls[1]![2]).toEqual(source);
    const taskInput = h.store.get<{ inputSnapshot: InvestigationInputSnapshotV1 }>(
      "idempotency",
      `input:${h.tasks()[0]!.id}`,
    )!;
    expect(taskInput.inputSnapshot.title).toBe("Small PR");
    expect(taskInput.inputSnapshot.body).toBe("One user-visible feature.");
  });

  it("rejects stale retry versions and never retries a completed delivery", async () => {
    const h = harness({ maximumAttempts: 1 });
    vi.spyOn(h.importer, "importWorkItem").mockRejectedValueOnce(
      new Error("Synthetic source preparation failure."),
    );
    const input = h.delivery();
    const { receipt: failed } = await h.process(input);
    expect(() =>
      h.intake.retryReceipt(actor, input.deliveryId, {
        version: "stale-version",
        idempotencyKey: "stale-e2e-retry",
      }),
    ).toThrow(expect.objectContaining({ code: "webhook_delivery_stale" }));
    const request = { version: failed.version, idempotencyKey: "valid-e2e-retry" };
    h.intake.retryReceipt(actor, input.deliveryId, request);
    expect(() =>
      h.intake.retryReceipt(actor, input.deliveryId, {
        ...request,
        version: "different-version",
      }),
    ).toThrow(expect.objectContaining({ code: "webhook_retry_conflict" }));
    await h.intake.drain();
    const completed = h.intake.readReceipt(actor, input.deliveryId);
    expect(() =>
      h.intake.retryReceipt(actor, input.deliveryId, {
        version: completed.version,
        idempotencyKey: "completed-e2e-retry",
      }),
    ).toThrow(expect.objectContaining({ code: "webhook_retry_unavailable" }));
    expect(h.tasks()).toHaveLength(1);
    expect(h.store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
  });

  it("persists a terminal failure when its publication callback throws without repeating execution", async () => {
    const h = harness({ maximumAttempts: 1 });
    const creating = vi
      .spyOn(h.service, "createImportedTask")
      .mockRejectedValue(
        new InvestigationRequestError(503, "synthetic_task_unavailable", "Synthetic Task failure."),
      );
    const importing = vi.spyOn(h.importer, "importWorkItem");
    h.changed.mockImplementation(() => {
      throw new Error("Synthetic publication callback failure.");
    });
    const input = h.delivery();
    h.intake.accept(input);
    h.intake.start();
    await expect(h.intake.drain()).rejects.toThrow("Synthetic publication callback failure.");
    const failed = h.intake.readReceipt(actor, input.deliveryId);
    expect(failed).toMatchObject({
      state: "failed",
      attempts: 1,
      totalAttempts: 1,
      reason: "synthetic_task_unavailable",
      taskId: null,
      attemptHistory: [{ state: "failed", phase: "task", reason: "synthetic_task_unavailable" }],
    });
    expect(h.store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
    expect(h.rawReceipt(input.deliveryId).claim?.expiresAt).toBe(0);
    h.calls.length = 0;

    await h.intake.drain();
    h.advance(retryDelayMs);
    await h.intake.drain();
    h.advance(24 * 60 * 60 * 1000);
    await h.intake.drain();
    expect(h.intake.readReceipt(actor, input.deliveryId)).toEqual(failed);
    expect(h.calls).toEqual([]);
    expect(creating).toHaveBeenCalledTimes(1);
    expect(importing).toHaveBeenCalledTimes(1);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.tasks()).toEqual([]);
  });

  it("preserves a legacy E2E attempt count through a real retry cycle", async () => {
    const h = harness();
    const input = h.delivery();
    h.intake.accept(input);
    const accepted = h.rawReceipt(input.deliveryId);
    h.store.put("idempotency", accepted.id, {
      ...accepted,
      state: "failed",
      attempts: 3,
      reason: "legacy_preparation_failed",
    });
    h.store.delete("idempotency", `e2e:pending:${accepted.id}`);
    const failed = h.intake.readReceipt(actor, input.deliveryId);
    expect(failed).toMatchObject({ totalAttempts: 3, attemptHistory: [] });

    const retried = h.intake.retryReceipt(actor, input.deliveryId, {
      version: failed.version,
      idempotencyKey: "retry-legacy-e2e",
    });
    expect(retried).toMatchObject({ attempts: 0, totalAttempts: 3, attemptHistory: [] });
    h.intake.start();
    await h.intake.drain();
    expect(h.intake.readReceipt(actor, input.deliveryId)).toMatchObject({
      state: "completed",
      attempts: 1,
      totalAttempts: 4,
      attemptHistory: [{ number: 4, cycleAttempt: 1, state: "completed" }],
    });
    expect(h.tasks()).toHaveLength(1);
  });

  it.each([
    {
      name: "authorization is revoked",
      state: "completed" as const,
      mutate: (h: ReturnType<typeof harness>) => {
        h.binding.e2eEnabled = false;
      },
    },
    {
      name: "the original command is edited",
      state: "failed" as const,
      mutate: (h: ReturnType<typeof harness>) => {
        h.comments.get(901)!.body = "The command was removed after Task creation.";
      },
    },
    {
      name: "the PR head changes",
      state: "failed" as const,
      mutate: (h: ReturnType<typeof harness>) => {
        h.upstream.head.sha = "c".repeat(40);
      },
    },
  ])(
    "recovers a committed terminal Task after $name without reading GitHub",
    async ({ state, mutate }) => {
      const h = harness();
      const create = h.service.createImportedTask.bind(h.service);
      const creating = vi
        .spyOn(h.service, "createImportedTask")
        .mockImplementationOnce(async (...args) => {
          await create(...args);
          void h.intake.stop();
          throw new Error(
            "Synthetic shutdown after Task commit and before receipt acknowledgement.",
          );
        });
      const verifying = vi.spyOn(h.importer, "verifyE2eCommand");
      const importing = vi.spyOn(h.importer, "importWorkItem");
      const input = h.delivery();
      const { receipt: interrupted } = await h.process(input);
      const task = h.tasks()[0]!;
      expect(interrupted).toMatchObject({ state: "source_ready", attempts: 1, taskId: null });
      expect(h.tasks()).toHaveLength(1);
      h.store.put("tasks", task.id, { ...task, state });
      mutate(h);
      verifying.mockClear();
      importing.mockClear();
      h.calls.length = 0;

      h.intake.start();
      await h.intake.drain();
      const recovered = h.intake.readReceipt(actor, input.deliveryId);
      expect(recovered).toMatchObject({
        state: "completed",
        taskId: task.id,
        reason: null,
        totalAttempts: 2,
      });
      expect(recovered.attemptHistory.at(-1)).toMatchObject({
        state: "completed",
        phase: "recovery",
        taskId: task.id,
      });
      expect(h.tasks()).toHaveLength(1);
      expect(h.tasks()[0]!.state).toBe(state);
      expect(creating).toHaveBeenCalledTimes(1);
      expect(verifying).not.toHaveBeenCalled();
      expect(importing).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
      expect(h.store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
    },
  );

  it.each([
    {
      name: "authorization is revoked",
      reason: "e2e_authorization_revoked",
      mutate: (h: ReturnType<typeof harness>) => {
        h.binding.e2eEnabled = false;
      },
    },
    {
      name: "the command is edited",
      reason: "e2e_command_changed",
      mutate: (h: ReturnType<typeof harness>) => {
        h.comments.get(901)!.body = "The command was removed before retry.";
      },
    },
    {
      name: "the admitted PR head changes",
      reason: "e2e_revision_changed",
      mutate: (h: ReturnType<typeof harness>) => {
        h.upstream.head.sha = "c".repeat(40);
      },
    },
  ])("rejects an uncommitted retry when $name", async ({ reason, mutate }) => {
    const h = harness({ maximumAttempts: 1 });
    const creating = vi
      .spyOn(h.service, "createImportedTask")
      .mockRejectedValueOnce(
        new InvestigationRequestError(503, "synthetic_task_unavailable", "Synthetic Task failure."),
      );
    const input = h.delivery();
    const { receipt: failed } = await h.process(input);
    expect(failed).toMatchObject({ state: "failed", taskId: null });
    const source = structuredClone(h.rawReceipt(input.deliveryId).source);
    mutate(h);
    const retry = () =>
      h.intake.retryReceipt(actor, input.deliveryId, {
        version: failed.version,
        idempotencyKey: `retry-uncommitted-${reason}`,
      });
    if (reason === "e2e_authorization_revoked") {
      expect(retry).toThrow(expect.objectContaining({ code: reason }));
      expect(() => h.intake.accept(input)).toThrow(expect.objectContaining({ code: reason }));
      expect(h.intake.readReceipt(actor, input.deliveryId)).toEqual(failed);
    } else {
      retry();
      await h.intake.drain();
      expect(h.intake.readReceipt(actor, input.deliveryId)).toMatchObject({
        state: "failed",
        taskId: null,
        reason,
        totalAttempts: 2,
      });
    }
    expect(h.rawReceipt(input.deliveryId).source).toEqual(source);
    expect(h.tasks()).toEqual([]);
    expect(creating).toHaveBeenCalledTimes(1);
    expect(h.store.countPrefix("idempotency", "e2e:pending:")).toBe(0);
  });
});
