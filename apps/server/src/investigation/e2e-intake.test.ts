import { createHash, randomUUID } from "node:crypto";
import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationE2eIntake, parseE2eCommand } from "../../dist/investigation/e2e-intake.js";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationSourceImporter } from "../../dist/investigation/source-import.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import type { InvestigationWebhookDeliveryInput } from "../../dist/investigation/webhook-http.js";

const repository = { id: "e2e-fixture", fullName: "fixture/e2e", githubRepositoryId: 123 };
const at = "2026-09-19T00:00:00.000Z";
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

function harness() {
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
    now: () => new Date(at),
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
    now: () => Date.parse(at),
    retryDelayMs: 60_000,
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
});
