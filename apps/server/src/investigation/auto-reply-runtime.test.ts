import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InvestigationAccount,
  InvestigationActionIntentV1,
  InvestigationAnalysisV1,
  InvestigationCheckpointResponse,
  InvestigationClaim,
  InvestigationClaimResponse,
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
  InvestigationFinalizeResponse,
  InvestigationLoopRoundV1,
  InvestigationResultV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationReportSubmission } from "../../../worker/src/investigation/report-builder.js";
import type { AutomaticReplyReceipt } from "../../dist/investigation/auto-reply.js";
import {
  automaticReplyTemplateVersion,
  defaultAutomaticReplyTemplates,
} from "../../dist/investigation/auto-reply-template.js";
import { InvestigationCommentDeliveries } from "../../dist/investigation/comment-deliveries.js";
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import type { ProgressReplyReceipt } from "../../dist/investigation/progress-reply.js";
import {
  type InvestigationRuntimeConfig,
  loadInvestigationRuntimeConfig,
} from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationActionTransport,
  InvestigationProgressCommentRequest,
} from "../../dist/investigation/types.js";

const applications = new Set<FastifyInstance>();
const directories: string[] = [];
const blockedGates = new Set<() => void>();
const origin = "http://127.0.0.1:8000";
const host = "127.0.0.1:8000";
const password = "Synthetic automatic reply runtime password";
const workerToken = "W".repeat(43);
const repository = { id: "repo-1", githubRepositoryId: 123, fullName: "fixture/reply-runtime" };
const settingsUrl = `/api/repositories/${repository.id}/auto-reply-settings`;
const repliesUrl = `/api/repositories/${repository.id}/auto-replies`;
const progressUrl = `/api/repositories/${repository.id}/progress-replies`;
const webhookSecret = "Synthetic progress webhook signing secret";
const enabledSettings = {
  version: 0,
  enabled: true,
  pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
  issueTemplate: defaultAutomaticReplyTemplates.issue,
};
const publicationPermissions = ["repository:manage", "action:prepare", "action:execute"] as const;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("External network access is forbidden in automatic reply runtime tests.");
    }),
  );
});

afterEach(async () => {
  try {
    for (const release of blockedGates) release();
    blockedGates.clear();
    for (const app of applications) await app.close();
    applications.clear();
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function stored<T>(
  config: InvestigationRuntimeConfig,
  operation: (store: InvestigationStore) => T,
): T {
  const store = new InvestigationStore(config.databasePath);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function get(app: FastifyInstance, url: string, cookie = "") {
  return app.inject({ method: "GET", url, headers: { host, cookie } });
}

function post(app: FastifyInstance, url: string, payload: unknown, cookie: string) {
  return app.inject({ method: "POST", url, payload, headers: { host, origin, cookie } });
}

function put(app: FastifyInstance, payload: unknown, cookie: string) {
  return app.inject({
    method: "PUT",
    url: settingsUrl,
    payload,
    headers: { host, origin, cookie },
  });
}

function workerPost(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: { authorization: `Bearer ${workerToken}` },
  });
}

async function login(app: FastifyInstance, username = "fixture-author") {
  const response = await post(app, "/api/auth/login", { username, password }, "");
  expect(response.statusCode, response.body).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function closeRuntime(app: FastifyInstance) {
  applications.delete(app);
  await app.close();
}

function updateAccount(account: InvestigationAccount, changes: Partial<InvestigationAccount>) {
  const updated = { ...account, ...changes };
  return {
    version: updated.version,
    displayName: updated.displayName,
    enabled: updated.enabled,
    isAdmin: updated.isAdmin,
    repositoryIds: updated.repositoryIds,
    permissions: updated.permissions,
    actionCapabilities: updated.actionCapabilities,
    allowRepositoryExecution: updated.allowRepositoryExecution,
  };
}

/** Native accounts and runtime APIs use isolated databases; every upstream read and write is mocked. */
async function fixture(
  options: {
    publisher?: boolean;
    github?: boolean;
    transport?: boolean;
    identity?: boolean;
    additionalAccounts?: boolean;
    assignment?: boolean;
    pauseSource?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "automatic-reply-runtime-"));
  directories.push(directory);
  const dashboardDirectory = join(directory, "dashboard");
  await mkdir(dashboardDirectory);
  await writeFile(
    join(dashboardDirectory, "index.html"),
    "<!doctype html><title>Automatic Reply Fixture</title>",
  );
  const github = options.github !== false;
  const config = loadInvestigationRuntimeConfig({
    INVESTIGATION_DATABASE_PATH: join(directory, "investigation.sqlite"),
    INVESTIGATION_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: dashboardDirectory,
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
    INVESTIGATION_ENABLE_EXTERNAL_WRITES: String(options.publisher !== false && github),
    INVESTIGATION_WORKERS_JSON: JSON.stringify([
      { id: "worker-1", token: workerToken, repositoryIds: [repository.id] },
    ]),
    ...(options.assignment ? { INVESTIGATION_GITHUB_WEBHOOK_SECRET: webhookSecret } : {}),
    ...(github
      ? {
          INVESTIGATION_GITHUB_TOKEN: "synthetic-transport-token",
          INVESTIGATION_GITHUB_USER_ID: "55",
        }
      : {}),
  });
  const accounts = new InvestigationPasswordStore(config.authDatabasePath);
  let author!: InvestigationAccount;
  try {
    const admin = await accounts.initializeBootstrap({
      username: "fixture-admin",
      password,
      displayName: "Fixture Administrator",
      repositoryIds: [repository.id],
      permissions: [...publicationPermissions, "task:create"],
      actionCapabilities: ["comment"],
    });
    if (admin === null) throw new Error("The isolated runtime must initialize its administrator.");
    author = await accounts.createAccount(admin, {
      username: "fixture-author",
      password,
      displayName: "Fixture Author",
      repositoryIds: [repository.id],
      permissions: [...publicationPermissions, "task:create"],
      actionCapabilities: ["comment"],
    });
    if (options.additionalAccounts) {
      for (const account of [
        { username: "fixture-viewer", permissions: [], actionCapabilities: [] },
        { username: "fixture-manager", permissions: ["repository:manage"], actionCapabilities: [] },
        {
          username: "fixture-preparer",
          permissions: ["repository:manage", "action:prepare"],
          actionCapabilities: ["comment"],
        },
        {
          username: "fixture-executor",
          permissions: ["repository:manage", "action:execute"],
          actionCapabilities: ["comment"],
        },
        {
          username: "fixture-reviewer",
          permissions: [...publicationPermissions],
          actionCapabilities: ["approve"],
        },
      ] as const) {
        await accounts.createAccount(admin, {
          ...account,
          password,
          repositoryIds: [repository.id],
          permissions: [...account.permissions],
          actionCapabilities: [...account.actionCapabilities],
        });
      }
      await accounts.createAccount(admin, {
        username: "fixture-foreign",
        password,
        isAdmin: true,
        repositoryIds: ["other-repository"],
        permissions: [...publicationPermissions],
        actionCapabilities: ["comment"],
      });
    }
  } finally {
    accounts.close();
  }

  const upstream = {
    id: 77,
    number: 7,
    title: "Synthetic issue for automatic conclusions",
    body: "The isolated reporter describes a behavior that needs investigation.",
    state: "open",
    comments: 0,
    updated_at: "2026-09-16T10:00:00.000Z",
    assignees: [{ id: 55, login: "synthetic-publisher" }],
  };
  const sourceEntered = gate();
  const sourceReleased = gate();
  let suspendSource = options.pauseSource === true;
  blockedGates.add(sourceReleased.release);
  const sourceImportFetch: typeof globalThis.fetch = async (input, init) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    if (
      suspendSource &&
      ["/repos/fixture/reply-runtime/issues/7", "/repos/fixture/reply-runtime/pulls/7"].includes(
        url.pathname,
      )
    ) {
      sourceEntered.release();
      await sourceReleased.promise;
    }
    if (url.pathname === "/user") return Response.json({ id: 55, login: "synthetic-publisher" });
    if (url.pathname === "/repos/fixture/reply-runtime")
      return Response.json({ id: repository.githubRepositoryId, full_name: repository.fullName });
    if (url.pathname === "/repos/fixture/reply-runtime/issues/7") return Response.json(upstream);
    if (url.pathname === "/repos/fixture/reply-runtime/pulls/7")
      return Response.json({
        ...upstream,
        review_comments: 0,
        merged_at: null,
        base: { sha: "b".repeat(40), repo: { id: repository.githubRepositoryId } },
        head: { sha: "a".repeat(40) },
      });
    if (
      [
        "/repos/fixture/reply-runtime/issues/7/comments",
        "/repos/fixture/reply-runtime/pulls/7/comments",
        "/repos/fixture/reply-runtime/pulls/7/reviews",
      ].includes(url.pathname)
    )
      return Response.json([]);
    throw new Error(`Unexpected synthetic source request: ${url.pathname}`);
  };
  const published: InvestigationActionIntentV1[] = [];
  const executionEntered = gate();
  const executionReleased = gate();
  blockedGates.add(executionReleased.release);
  let suspendExecution = false;
  const execute = vi.fn<InvestigationActionTransport["execute"]>(
    async (intent, targetRepository, item, actor, beforeDispatch) => {
      expect(targetRepository).toEqual(repository);
      expect(intent.action).toBe("comment");
      expect(item.repositoryId).toBe(repository.id);
      expect(actor.actionCapabilities).toEqual(["comment"]);
      expect(actor.githubIdentity).toEqual({
        githubUserId: 55,
        githubLogin: "synthetic-publisher",
      });
      expect(beforeDispatch).toBeTypeOf("function");
      executionEntered.release();
      if (suspendExecution) await executionReleased.promise;
      beforeDispatch?.();
      published.push(structuredClone(intent));
      return {
        state: "succeeded",
        externalId: String(900 + published.length),
        message: "Synthetic comment was recorded.",
      };
    },
  );
  const reconcile = vi.fn<InvestigationActionTransport["reconcile"]>(async () => {
    throw new Error("No unknown external delivery is part of this runtime fixture.");
  });
  const readPublisherIdentity = vi.fn(async () => ({
    githubUserId: 55,
    githubLogin: "synthetic-publisher",
  }));
  const progressPublished: InvestigationProgressCommentRequest[] = [];
  let unknownProgressWrite = false;
  const publishProgressComment = vi.fn<
    NonNullable<InvestigationActionTransport["publishProgressComment"]>
  >(async (request, targetRepository, item, actor, beforeDispatch) => {
    expect(targetRepository).toEqual(repository);
    expect(item.number).toBe(7);
    expect(actor.githubIdentity?.githubUserId).toBe(55);
    expect(beforeDispatch).toBeTypeOf("function");
    executionEntered.release();
    if (suspendExecution) await executionReleased.promise;
    beforeDispatch?.();
    if (progressPublished.length === 0) {
      expect(request.externalId).toBeNull();
      expect(request.previousBody).toBeNull();
    } else {
      expect(request.externalId).toBe("1901");
      expect(request.previousBody).toBe(progressPublished.at(-1)?.body);
    }
    progressPublished.push(structuredClone(request));
    if (unknownProgressWrite) {
      unknownProgressWrite = false;
      return {
        state: "unknown",
        externalId: request.externalId,
        message: "Synthetic response was lost.",
        effect: "unknown",
        retryable: false,
        reasonCode: "mutation_response_unknown",
      };
    }
    return {
      state: "succeeded",
      externalId: "1901",
      message: "Synthetic progress saved.",
      effect: "applied",
      retryable: false,
      reasonCode: "mutation_applied",
    };
  });
  const actionTransport: InvestigationActionTransport = {
    supportedActions: ["comment"],
    ...(options.identity === false ? {} : { readPublisherIdentity }),
    readCapabilities: vi.fn(async () => ["comment"] as const),
    readTarget: vi.fn(async (_repository, item) => ({
      kind: item.kind,
      state: item.state,
      revisionKey: item.subject.revisionKey,
      headSha: item.subject.kind === "original_pr" ? item.subject.headSha : null,
    })),
    execute,
    reconcile,
    publishProgressComment,
    reconcileProgressComment: vi.fn(async () => {
      return {
        state: "succeeded",
        externalId: "1901",
        message: "Synthetic exact readback.",
        effect: "applied",
        retryable: false,
        reasonCode: "readback_applied",
      };
    }),
  };
  const start = async () => {
    const app = await createInvestigationRuntime(config, {
      logger: false,
      sourceImportFetch,
      ...(options.transport === false ? {} : { actionTransport }),
    });
    applications.add(app);
    return app;
  };
  const app = await start();
  const cookie = await login(app);
  const adminCookie = await login(app, "fixture-admin");
  const registered = await post(app, "/api/repositories", repository, cookie);
  expect(registered.statusCode, registered.body).toBe(201);
  return {
    app,
    cookie,
    adminCookie,
    author,
    config,
    start,
    published,
    execute,
    reconcile,
    readPublisherIdentity,
    progressPublished,
    publishProgressComment,
    loseNextProgressResponse: () => {
      unknownProgressWrite = true;
    },
    sourceEntered: sourceEntered.promise,
    releaseSource: () => {
      suspendSource = false;
      sourceReleased.release();
    },
    assignmentDelivery: (kind: "issue" | "pull_request") => {
      const item =
        kind === "issue"
          ? upstream
          : {
              ...upstream,
              base: { sha: "b".repeat(40), repo: { id: repository.githubRepositoryId } },
              head: { sha: "a".repeat(40) },
            };
      const body = JSON.stringify({
        action: "assigned",
        repository: { id: repository.githubRepositoryId, full_name: repository.fullName },
        sender: { id: 44, login: "trusted-maintainer", type: "User" },
        assignee: { id: 55, login: "synthetic-publisher", type: "User" },
        ...(kind === "issue" ? { issue: item } : { pull_request: item }),
      });
      return {
        method: "POST" as const,
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "progress-runtime-assignment",
          "x-github-event": kind === "issue" ? "issues" : "pull_request",
          "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
        },
        payload: body,
      };
    },
    pauseExecution: () => {
      suspendExecution = true;
    },
    executionEntered: executionEntered.promise,
    releaseExecution: executionReleased.release,
  };
}

async function createClaim(
  app: FastifyInstance,
  cookie: string,
  kind: "issue" | "pull_request" = "issue",
  idempotencyKey = "automatic-reply-task",
): Promise<InvestigationClaim> {
  const taskKind = kind === "issue" ? "issue-investigate" : "pr-review";
  const imported = await post(
    app,
    `/api/repositories/${repository.id}/import-work-item`,
    { kind, number: 7 },
    cookie,
  );
  expect(imported.statusCode, imported.body).toBe(201);
  const created = await post(
    app,
    "/api/tasks",
    {
      kind: taskKind,
      workItemId: imported.json().workItem.id,
      idempotencyKey,
    },
    cookie,
  );
  expect(created.statusCode, created.body).toBe(201);
  const claimed = await workerPost(app, "/api/worker/claims", { supportedKinds: [taskKind] });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const claim = claimed.json<InvestigationClaimResponse>().claim;
  if (claim === null) throw new Error("The native Worker must claim the imported task.");
  return claim;
}

async function sealReport(
  app: FastifyInstance,
  claim: InvestigationClaim,
  outcome: "completed" | "blocked" = "completed",
) {
  if (claim.checkpoint === null)
    throw new Error("The native claim must contain a saved checkpoint.");
  let checkpoint = claim.checkpoint;
  const taskPath = `/api/worker/tasks/${claim.task.id}`;
  const subject = claim.task.subjects.find((entry) => entry.id === claim.task.subjectRef);
  if (subject?.kind === "original_pr") {
    const manifestContent = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: subject.id,
      baseSha: subject.baseSha,
      headSha: subject.headSha,
      mergeBaseSha: subject.baseSha,
      files: [],
      chunks: [],
    };
    const source = await workerPost(app, `${taskPath}/checkpoints`, {
      kind: "source",
      lease: claim.lease,
      manifest: { ...manifestContent, digest: investigationContentDigest(manifestContent) },
    });
    expect(source.statusCode, source.body).toBe(200);
    checkpoint = source.json<InvestigationCheckpointResponse>().checkpoint;
  }
  const evidenceId = "synthetic-snapshot-observation";
  const summary =
    claim.task.workItem.kind === "pull_request"
      ? "The complete synthetic investigation contains no retained findings."
      : "The reported startup problem requires the installed version and exact launch steps.";
  const analysis: InvestigationAnalysisV1 = {
    ...structuredClone(checkpoint.analysis),
    summary,
    coverage:
      outcome === "completed"
        ? {
            ...structuredClone(checkpoint.analysis.coverage),
            includedUnits: checkpoint.analysis.coverage.includedUnits.map((unit) => ({
              ...structuredClone(unit),
              status: "completed" as const,
              evidenceRefs: [evidenceId],
            })),
            completedUnitRefs: checkpoint.analysis.coverage.includedUnits.map((unit) => unit.id),
            unresolvedUnitRefs: [],
          }
        : structuredClone(checkpoint.analysis.coverage),
    evidence: [
      {
        id: evidenceId,
        subjectRef: claim.task.subjectRef,
        source: "reporter_statement",
        summary: "The isolated snapshot is the sole input to this synthetic investigation.",
        evidenceRefs: [],
      },
    ],
    feedbackDrafts:
      claim.task.workItem.kind === "pull_request"
        ? []
        : [
            {
              id: "synthetic-reporter-information-request",
              body: "Please provide the installed version and exact launch steps.",
              suggestion: null,
            },
          ],
    assessment:
      claim.task.workItem.kind === "pull_request"
        ? {
            kind: "pr",
            subjectRef: claim.task.subjectRef,
            summary,
            evidenceRefs: [evidenceId],
            reviewConclusion: {
              status: "no-blocking-findings",
              rationale: "The synthetic empty diff has no findings.",
            },
            e2eAssessment: {
              level: "not_needed",
              rationale: "This synthetic empty diff only exercises report delivery.",
              planRef: null,
              scenarioIds: [],
              prerequisiteRefs: [],
              linkedValidationReportRefs: [],
            },
          }
        : {
            kind: "bug",
            subjectRef: claim.task.subjectRef,
            summary,
            evidenceRefs: [evidenceId],
            bugAssessment: {
              status: "needs_information",
              rationale:
                "The synthetic report does not include the failing version or launch steps.",
              missingInformation: ["Please provide the installed version and exact launch steps."],
              hypotheses: [],
              upstreamFix: null,
              duplicateOf: null,
              expectedBehavior: null,
            },
            reproduction: {
              status: "not_run",
              summary: "No runtime reproduction was performed by this synthetic workflow fixture.",
              evidenceRefs: [],
              planRef: null,
            },
          },
    limitations: [
      {
        id: "synthetic-runtime-limitation",
        description: "The fixture does not run a model or repository commands.",
        impact: "Only native workflow and publication behavior are under test.",
        evidenceRefs: [],
      },
    ],
  };
  for (const phase of (outcome === "completed" && checkpoint.runtime.reviewMode === undefined
    ? ["discovery", "finalize"]
    : ["discovery"]) as readonly ("discovery" | "finalize")[]) {
    const round: InvestigationLoopRoundV1 = {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: claim.task.id,
      attemptId: claim.attempt.id,
      inputCheckpointRef: {
        id: checkpoint.id,
        version: checkpoint.version,
        digest: checkpoint.digest,
      },
      round: checkpoint.round + 1,
      phase,
      analysis: structuredClone(analysis),
      continue: outcome !== "completed",
      continuationReason:
        outcome === "completed"
          ? "The complete synthetic scope is ready for delivery."
          : "The incomplete synthetic scope remains explicitly blocked.",
    };
    const accepted = await workerPost(app, `${taskPath}/checkpoints`, {
      kind: "analysis",
      lease: claim.lease,
      round,
      modelIdentity: { engine: "codex", model: "gpt-6-astra" },
      usage: {
        durationMs: 0,
        tokens: 0,
        reportBytes: Buffer.byteLength(JSON.stringify(analysis), "utf8"),
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    checkpoint = accepted.json<InvestigationCheckpointResponse>().checkpoint;
  }
  if (outcome === "blocked") {
    const interrupted = await workerPost(app, `${taskPath}/checkpoints`, {
      kind: "interrupt",
      lease: claim.lease,
      reason: "blocked",
      diagnostics: [],
    });
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    checkpoint = interrupted.json<InvestigationCheckpointResponse>().checkpoint;
  }
  expect(checkpoint.stopReason).toBe(outcome === "completed" ? "complete" : "blocked");
  const submission = buildInvestigationReportSubmission({
    task: claim.task,
    attempt: claim.attempt,
    checkpoint,
    reportId: claim.reportId,
    outcome,
    parentPlan: claim.plan,
  });
  for (const part of submission.parts) {
    const uploaded = await workerPost(app, `${taskPath}/report-parts`, {
      lease: claim.lease,
      part,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
  }
  const finalizePayload = {
    lease: claim.lease,
    header: submission.header,
    manifest: submission.manifest,
  };
  const sealed = await workerPost(app, `${taskPath}/finalize`, finalizePayload);
  expect(sealed.statusCode, sealed.body).toBe(200);
  return { reportRef: sealed.json<InvestigationFinalizeResponse>().reportRef, finalizePayload };
}

async function receipts(app: FastifyInstance, cookie: string): Promise<AutomaticReplyReceipt[]> {
  const response = await get(app, repliesUrl, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: AutomaticReplyReceipt[] }>().items;
}

async function conversationReceipts(app: FastifyInstance, cookie: string) {
  const response = await get(app, progressUrl, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: ProgressReplyReceipt[] }>().items;
}

async function commentHistory(app: FastifyInstance, cookie: string, query = "") {
  const response = await get(app, `/api/comment-deliveries${query}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: InvestigationCommentDelivery[]; nextCursor: string | null }>();
}

async function enableAssignmentProgress(app: FastifyInstance, cookie: string) {
  const settings = await put(app, { ...enabledSettings, progressEnabled: true }, cookie);
  expect(settings.statusCode, settings.body).toBe(200);
  const webhook = await app.inject({
    method: "PUT",
    url: `/api/repositories/${repository.id}/webhook-settings`,
    headers: { host, origin, cookie },
    payload: { version: 0, enabled: true, reviewerUserId: 55, allowedActorUserIds: [44] },
  });
  expect(webhook.statusCode, webhook.body).toBe(200);
}

async function assignmentTask(app: FastifyInstance, cookie: string): Promise<string> {
  let taskId = "";
  await vi.waitFor(
    async () => {
      const response = await get(
        app,
        "/api/github/webhook-deliveries/progress-runtime-assignment",
        cookie,
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ state: "completed" });
      taskId = response.json().taskId;
      expect(taskId).toBeTypeOf("string");
    },
    { timeout: 5_000, interval: 10 },
  );
  return taskId;
}

describe("automatic reply production runtime", () => {
  it("parses HTTP numeric comment filters and paginates global and comment-scoped histories", async () => {
    const context = await fixture({ assignment: true, pauseSource: true });
    const { app, cookie, config } = context;
    await enableAssignmentProgress(app, cookie);
    expect((await app.inject(context.assignmentDelivery("issue"))).statusCode).toBe(202);
    await context.sourceEntered;
    let first!: InvestigationCommentDelivery;
    await vi.waitFor(
      async () => {
        const history = await commentHistory(app, cookie);
        expect(history.items).toHaveLength(1);
        expect(history.items[0]?.state).toBe("succeeded");
        first = history.items[0]!;
      },
      { timeout: 5_000, interval: 10 },
    );
    stored(config, (store) =>
      store.transaction(() => {
        const deliveries = new InvestigationCommentDeliveries({ store });
        for (const number of [7, 5]) {
          const delivery = deliveries.begin({
            id: `numeric-query-delivery-${number}`,
            commentId: number === 7 ? first.commentId : "numeric-query-second-comment",
            mode: "progress",
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
            workItemKind: "issue",
            workItemNumber: number,
            operation: number === 7 ? "update" : "create",
            body: `Synthetic query fixture for target ${number}.`,
            externalId: number === 7 ? first.externalId : null,
            settingsVersion: first.settingsVersion,
            templateVersion: first.templateVersion,
            startedAt: new Date(Date.parse(first.startedAt) + (number === 7 ? 1 : 2)).toISOString(),
          });
          deliveries.finish(delivery.id, {
            state: "succeeded",
            externalId: number === 7 ? first.externalId : "1902",
          });
        }
      }),
    );
    const onlyFive = await commentHistory(
      app,
      cookie,
      `?repositoryId=${repository.id}&workItemNumber=5&limit=50`,
    );
    expect(onlyFive.items.map((entry) => entry.id)).toEqual(["numeric-query-delivery-5"]);
    expect(onlyFive.items[0]?.workItemNumber).toBe(5);
    const onlySeven = await commentHistory(
      app,
      cookie,
      `?repositoryId=${repository.id}&workItemNumber=7&limit=50`,
    );
    expect(onlySeven.items).toHaveLength(2);
    expect(onlySeven.items.every((entry) => entry.workItemNumber === 7)).toBe(true);
    const globalFirst = await commentHistory(app, cookie, "?workItemNumber=7&limit=1");
    expect(globalFirst.items).toHaveLength(1);
    expect(globalFirst.nextCursor).not.toBeNull();
    const globalSecond = await commentHistory(
      app,
      cookie,
      `?workItemNumber=7&limit=1&cursor=${encodeURIComponent(globalFirst.nextCursor!)}`,
    );
    expect(globalSecond.items.map((entry) => entry.id)).toEqual([first.id]);
    expect(globalSecond.nextCursor).toBeNull();
    const attemptsPath = `/api/comments/${encodeURIComponent(first.commentId)}/attempts`;
    const page = await get(app, `${attemptsPath}?limit=1`, cookie);
    expect(page.statusCode, page.body).toBe(200);
    const pageBody = page.json<{
      items: InvestigationCommentDelivery[];
      nextCursor: string | null;
    }>();
    expect(pageBody.items.map((entry) => entry.id)).toEqual(["numeric-query-delivery-7"]);
    expect(pageBody.nextCursor).not.toBeNull();
    const next = await get(
      app,
      `${attemptsPath}?limit=1&cursor=${encodeURIComponent(pageBody.nextCursor!)}`,
      cookie,
    );
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json()).toMatchObject({ items: [{ id: first.id }], nextCursor: null });
    const full = await get(app, `${attemptsPath}?limit=50`, cookie);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().items).toHaveLength(2);
  }, 20_000);

  it("rejects invalid and repeated HTTP numeric comment query parameters without coercion", async () => {
    const { app, cookie } = await fixture({ publisher: false });
    const invalid = [
      "0",
      "-1",
      "1.5",
      "1e1",
      "",
      "%20",
      "%205",
      "5%20",
      "5%0A",
      "+5",
      "01",
      "9007199254740992",
      "999999999999999999999",
    ];
    for (const value of invalid) {
      const response = await get(app, `/api/comment-deliveries?workItemNumber=${value}`, cookie);
      expect(response.statusCode, `workItemNumber=${value}: ${response.body}`).toBe(400);
    }
    for (const path of ["/api/comment-deliveries", "/api/comments/nonexistent-comment/attempts"]) {
      for (const value of [...invalid, "51", "100"]) {
        const response = await get(app, `${path}?limit=${value}`, cookie);
        expect(response.statusCode, `${path}?limit=${value}: ${response.body}`).toBe(400);
      }
      for (const query of ["limit=1&limit=2", "limit=1&limit=1"]) {
        const response = await get(app, `${path}?${query}`, cookie);
        expect(response.statusCode, response.body).toBe(400);
      }
    }
    for (const query of [
      "workItemNumber=5&workItemNumber=7",
      "workItemNumber=5&workItemNumber=5",
    ]) {
      const response = await get(app, `/api/comment-deliveries?${query}`, cookie);
      expect(response.statusCode, response.body).toBe(400);
    }
    const maximum = await get(
      app,
      `/api/comment-deliveries?workItemNumber=${Number.MAX_SAFE_INTEGER}&limit=50`,
      cookie,
    );
    expect(maximum.statusCode, maximum.body).toBe(200);
    expect(maximum.json()).toEqual({ items: [], nextCursor: null });
  });

  it("keeps publication states separate from legacy delivery states when parsing numeric filters", async () => {
    const context = await fixture({ publisher: false });
    const { app, cookie } = context;
    for (const state of [
      "pending",
      "synced",
      "paused",
      "unconfirmed",
      "needs_attention",
      "conflict",
      "retrying",
      "sending",
    ]) {
      const response = await get(
        app,
        `/api/publications?state=${state}&workItemNumber=7&limit=1`,
        cookie,
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
    }
    for (const state of ["cancelled", "failed", "succeeded", "unknown"]) {
      const publication = await get(
        app,
        `/api/publications?state=${state}&workItemNumber=7&limit=1`,
        cookie,
      );
      expect(publication.statusCode).toBe(400);
      const delivery = await get(
        app,
        `/api/comment-deliveries?state=${state}&workItemNumber=7&limit=1`,
        cookie,
      );
      expect(delivery.statusCode, delivery.body).toBe(200);
      expect(delivery.json()).toEqual({ items: [], nextCursor: null });
    }
    expect((await get(app, "/api/publications?state=pending&limit=51", cookie)).statusCode).toBe(
      400,
    );
    expect(context.execute).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "issue", outcome: "completed" },
    { kind: "pull_request", outcome: "completed" },
    { kind: "issue", outcome: "blocked" },
  ] as const)(
    "updates one assignment progress comment through $kind $outcome",
    async ({ kind, outcome }) => {
      const context = await fixture({ assignment: true, additionalAccounts: true });
      const { app, cookie, progressPublished } = context;
      expect((await get(app, progressUrl)).statusCode).toBe(401);
      const foreign = await login(app, "fixture-foreign");
      expect((await get(app, progressUrl, foreign)).statusCode).toBe(403);
      const settings = await put(app, { ...enabledSettings, progressEnabled: true }, cookie);
      expect(settings.statusCode, settings.body).toBe(200);
      const webhook = await app.inject({
        method: "PUT",
        url: `/api/repositories/${repository.id}/webhook-settings`,
        headers: { host, origin, cookie },
        payload: { version: 0, enabled: true, reviewerUserId: 55, allowedActorUserIds: [44] },
      });
      expect(webhook.statusCode, webhook.body).toBe(200);
      const accepted = await app.inject(context.assignmentDelivery(kind));
      expect(accepted.statusCode, accepted.body).toBe(202);
      await assignmentTask(app, cookie);
      const progress = async () => {
        const response = await get(app, progressUrl, cookie);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        return response.json<{ items: ProgressReplyReceipt[] }>().items;
      };
      await vi.waitFor(
        async () => {
          expect(await progress()).toMatchObject([
            { stage: "received", state: "sent", externalId: "1901" },
          ]);
        },
        { timeout: 5000, interval: 10 },
      );
      expect(progressPublished.length).toBeGreaterThanOrEqual(1);
      expect(progressPublished.filter((entry) => entry.externalId === null)).toHaveLength(1);
      expect(progressPublished[0]?.body).toContain("trusted-maintainer");
      expect(progressPublished[0]?.body).toContain("synthetic-publisher");
      const taskKind = kind === "issue" ? "issue-investigate" : "pr-review";
      const claimed = await workerPost(app, "/api/worker/claims", { supportedKinds: [taskKind] });
      expect(claimed.statusCode, claimed.body).toBe(200);
      const claim = claimed.json<InvestigationClaimResponse>().claim;
      if (claim === null) throw new Error("The assignment task must be available to the Worker.");
      await vi.waitFor(
        async () => {
          expect(await progress()).toMatchObject([
            { stage: "started", state: "sent", externalId: "1901" },
          ]);
        },
        { timeout: 5000, interval: 10 },
      );
      const sealed = await sealReport(app, claim, outcome);
      await vi.waitFor(
        async () => {
          expect(await progress()).toMatchObject([
            {
              stage: outcome === "completed" ? "completed" : "failed",
              state: "sent",
              externalId: "1901",
              reportId: sealed.reportRef.id,
            },
          ]);
        },
        { timeout: 5000, interval: 10 },
      );
      expect(progressPublished.length).toBeGreaterThanOrEqual(3);
      expect(progressPublished.filter((entry) => entry.externalId === null)).toHaveLength(1);
      if (outcome === "completed") {
        expect(progressPublished.at(-1)?.body).toContain("GPT-6 Astra");
        expect(progressPublished.at(-1)?.body).toContain("<details>");
      }
      expect(await receipts(app, cookie)).toEqual([]);
      expect(context.execute).not.toHaveBeenCalled();
      const publishedCount = progressPublished.length;
      const history = await commentHistory(app, cookie, `?taskId=${claim.task.id}`);
      expect(history.items).toHaveLength(publishedCount);
      expect(history.items.every((entry) => entry.state === "succeeded")).toBe(true);
      expect(history.items.filter((entry) => entry.operation === "create")).toHaveLength(1);
      expect(history.items.map((entry) => entry.body).sort()).toEqual(
        progressPublished.map((entry) => entry.body).sort(),
      );
      expect(
        history.items.every(
          (entry) => entry.body?.startsWith("I'm ") && entry.body.includes("Agentic Review"),
        ),
      ).toBe(true);
      const replay = await app.inject(context.assignmentDelivery(kind));
      expect(replay.statusCode, replay.body).toBe(202);
      expect(await progress()).toHaveLength(1);
      expect(progressPublished).toHaveLength(publishedCount);
    },
    20000,
  );

  it("publishes a scoped receipt before source import completes and attaches its history to the Task", async () => {
    const context = await fixture({
      assignment: true,
      pauseSource: true,
      additionalAccounts: true,
    });
    const { app, cookie, config } = context;
    await enableAssignmentProgress(app, cookie);
    expect((await app.inject(context.assignmentDelivery("issue"))).statusCode).toBe(202);
    await context.sourceEntered;
    let first!: InvestigationCommentDelivery;
    await vi.waitFor(
      async () => {
        const history = await commentHistory(app, cookie);
        expect(history.items).toHaveLength(1);
        first = history.items[0]!;
        expect(first).toMatchObject({ taskId: null, operation: "create", state: "succeeded" });
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(stored(config, (store) => store.list("tasks"))).toEqual([]);
    expect(first.body).toContain("AI assistant");
    expect(first.body).toContain("synthetic-publisher");
    expect(first.body).not.toContain("snapshot captured");
    const foreign = await login(app, "fixture-foreign");
    expect(
      (await get(app, `/api/comments/${encodeURIComponent(first.commentId)}`, foreign)).statusCode,
    ).toBe(403);
    expect(
      (await get(app, `/api/comment-deliveries?repositoryId=${repository.id}`, foreign)).statusCode,
    ).toBe(403);
    context.releaseSource();
    const taskId = await assignmentTask(app, cookie);
    const attached = await commentHistory(app, cookie, `?taskId=${taskId}`);
    expect(attached.items.find((entry) => entry.id === first.id)).toMatchObject({
      taskId,
      body: first.body,
    });
    const summaries = await get(
      app,
      `/api/comments?taskIds=${encodeURIComponent(taskId)}&repositoryId=${repository.id}`,
      cookie,
    );
    expect(summaries.statusCode, summaries.body).toBe(200);
    expect(summaries.json().items).toMatchObject([
      { id: first.commentId, taskId, mode: "progress" },
    ]);
  }, 20_000);

  it("uses edited templates for later updates while retaining exact earlier delivery bodies", async () => {
    const context = await fixture({ assignment: true });
    const { app, cookie } = context;
    await enableAssignmentProgress(app, cookie);
    await app.inject(context.assignmentDelivery("issue"));
    const taskId = await assignmentTask(app, cookie);
    await vi.waitFor(
      async () => {
        const response = await get(app, `/api/comments?taskIds=${taskId}`, cookie);
        expect(response.json().items).toMatchObject([{ state: "synced" }]);
      },
      { timeout: 5_000, interval: 10 },
    );
    const oldBodies = (await commentHistory(app, cookie)).items.map((entry) => ({
      id: entry.id,
      body: entry.body,
    }));
    const previous = (await get(app, settingsUrl, cookie)).json();
    const saved = await put(
      app,
      {
        ...enabledSettings,
        version: previous.version,
        progressEnabled: true,
        progressTemplates: {
          ...previous.progressTemplates,
          started:
            previous.progressTemplates.started + "\nNew progress wording for subsequent updates.",
        },
      },
      cookie,
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().authorizationEpoch).toBe(previous.authorizationEpoch);
    expect(
      (await commentHistory(app, cookie)).items.map((entry) => ({
        id: entry.id,
        body: entry.body,
      })),
    ).toEqual(oldBodies);
    const claimed = await workerPost(app, "/api/worker/claims", {
      supportedKinds: ["issue-investigate"],
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    await vi.waitFor(
      () => expect(context.progressPublished.at(-1)?.body).toContain("New progress wording"),
      { timeout: 5_000, interval: 10 },
    );
    const history = await commentHistory(app, cookie);
    for (const before of oldBodies)
      expect(history.items.find((entry) => entry.id === before.id)?.body).toBe(before.body);
  }, 20_000);

  it("keeps unknown delivery history during HTTP reconciliation and rejects stale or unprivileged commands", async () => {
    const context = await fixture({ assignment: true, additionalAccounts: true });
    const { app, cookie } = context;
    await enableAssignmentProgress(app, cookie);
    context.loseNextProgressResponse();
    await app.inject(context.assignmentDelivery("issue"));
    const taskId = await assignmentTask(app, cookie);
    let summary!: InvestigationCommentPublicationSummary;
    await vi.waitFor(
      async () => {
        const response = await get(app, `/api/comments?taskIds=${taskId}`, cookie);
        summary = response.json().items[0];
        expect(summary.state).toBe("unconfirmed");
      },
      { timeout: 5_000, interval: 10 },
    );
    const initialHistory = await commentHistory(app, cookie);
    expect(initialHistory.items).toHaveLength(1);
    expect(initialHistory.items[0]?.state).toBe("unknown");
    const endpoint = `/api/comments/${encodeURIComponent(summary.id)}/reconcile`;
    const input = { version: summary.version, idempotencyKey: "synthetic-reconcile" };
    const viewer = await login(app, "fixture-viewer");
    expect((await post(app, endpoint, input, viewer)).statusCode).toBe(403);
    expect(
      (await post(app, endpoint, { ...input, version: "0".repeat(64) }, cookie)).statusCode,
    ).toBe(409);
    expect((await post(app, endpoint, input, cookie)).statusCode).toBe(202);
    await vi.waitFor(
      async () => {
        const history = await commentHistory(app, cookie);
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
          id: initialHistory.items[0]!.id,
          state: "succeeded",
        });
        expect(history.items[0]!.observations.length).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(context.progressPublished).toHaveLength(1);
    expect((await post(app, endpoint, input, cookie)).statusCode).toBe(202);
    expect((await commentHistory(app, cookie)).items).toHaveLength(1);
  }, 20_000);

  it("expires Worker leases on the server timer without a Task read or another Worker claim", async () => {
    const nativeSetInterval = globalThis.setInterval;
    let sweep: (() => void) | undefined;
    const scheduled = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback,
      delay,
      ...args
    ) => {
      if (delay === 30_000 && typeof callback === "function") sweep = () => callback(...args);
      return nativeSetInterval(callback, delay, ...args);
    }) as typeof globalThis.setInterval);
    try {
      const context = await fixture({ assignment: true });
      const { app, cookie, config } = context;
      await enableAssignmentProgress(app, cookie);
      await app.inject(context.assignmentDelivery("issue"));
      const taskId = await assignmentTask(app, cookie);
      const claimed = await workerPost(app, "/api/worker/claims", {
        supportedKinds: ["issue-investigate"],
      });
      expect(claimed.statusCode, claimed.body).toBe(200);
      const claim = claimed.json<InvestigationClaimResponse>().claim!;
      stored(config, (store) => {
        const attempt = store.get<Record<string, unknown>>("attempts", claim.attempt.id)!;
        store.put("attempts", claim.attempt.id, {
          ...attempt,
          leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
        });
      });
      expect(sweep).toBeTypeOf("function");
      sweep!();
      expect(
        stored(config, (store) => store.get<InvestigationTaskV1>("tasks", taskId)?.state),
      ).toBe("interrupted");
      await vi.waitFor(
        () =>
          expect(context.progressPublished.at(-1)?.body).toContain(
            "Static investigation interrupted",
          ),
        { timeout: 5_000, interval: 10 },
      );
    } finally {
      scheduled.mockRestore();
    }
  }, 20_000);

  it.each([
    { publisher: false },
    { publisher: false, github: false, transport: false },
    { identity: false },
  ])("allows advance authorization while a publisher is not configured", async (options) => {
    const { app, cookie, config, published } = await fixture(options);
    const before = await get(app, settingsUrl, cookie);
    expect(before.statusCode).toBe(200);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.json()).toMatchObject({
      version: 0,
      enabled: false,
      publisherConfigured: false,
      authorizedById: null,
    });
    const updated = await put(app, enabledSettings, cookie);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      version: 1,
      enabled: true,
      publisherConfigured: false,
    });
    expect(updated.body).not.toContain("synthetic-transport-token");
    expect(await receipts(app, cookie)).toEqual([]);
    expect(published).toEqual([]);
    expect(stored(config, (store) => store.list("actionIntents"))).toEqual([]);
  });

  it("requires a scoped account and every publication grant while permitting a manager to disable replies", async () => {
    const { app, cookie } = await fixture({ additionalAccounts: true });
    expect((await get(app, settingsUrl)).statusCode).toBe(401);
    expect((await get(app, repliesUrl)).statusCode).toBe(401);
    expect((await put(app, enabledSettings, "")).statusCode).toBe(401);
    const foreign = await login(app, "fixture-foreign");
    expect((await get(app, settingsUrl, foreign)).statusCode).toBe(403);
    expect((await get(app, repliesUrl, foreign)).statusCode).toBe(403);
    expect((await put(app, enabledSettings, foreign)).statusCode).toBe(403);
    const viewer = await login(app, "fixture-viewer");
    expect((await get(app, settingsUrl, viewer)).statusCode).toBe(200);
    expect((await get(app, repliesUrl, viewer)).statusCode).toBe(200);
    for (const username of [
      "fixture-viewer",
      "fixture-manager",
      "fixture-preparer",
      "fixture-executor",
      "fixture-reviewer",
    ]) {
      const denied = await login(app, username);
      expect((await put(app, enabledSettings, denied)).statusCode).toBe(403);
    }
    expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
    const manager = await login(app, "fixture-manager");
    const disabled = await put(app, { ...enabledSettings, version: 1, enabled: false }, manager);
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({ version: 2, enabled: false, authorizedById: null });
    const draft = await put(
      app,
      {
        ...enabledSettings,
        version: 2,
        enabled: false,
        issueTemplate: enabledSettings.issueTemplate.replace(
          "## Triage result",
          "## Custom triage result",
        ),
      },
      manager,
    );
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json().version).toBe(3);
  }, 20000);

  it("enforces request shape, template validity, same-origin writes, and compare-and-swap revisions", async () => {
    const { app, cookie, author } = await fixture();
    const missingOrigin = await app.inject({
      method: "PUT",
      url: settingsUrl,
      headers: { host, cookie },
      payload: enabledSettings,
    });
    expect(missingOrigin.statusCode).toBe(401);
    expect(
      (await put(app, { ...enabledSettings, authorizedById: "forged-account" }, cookie)).statusCode,
    ).toBe(400);
    const invalid = await put(app, { ...enabledSettings, issueTemplate: "{{summary}}" }, cookie);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("automatic_reply_template_invalid");
    const saved = await put(app, enabledSettings, cookie);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      version: 1,
      authorizedById: author.id,
      publisherConfigured: true,
      templateVersion: automaticReplyTemplateVersion,
    });
    const stale = await put(app, { ...enabledSettings, enabled: false }, cookie);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("auto_reply_settings_conflict");
    expect((await get(app, settingsUrl, cookie)).json()).toEqual(saved.json());
  });

  it("invalidates authorization atomically on repository rename and never restores it by renaming back", async () => {
    const { app, cookie } = await fixture();
    expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
    const renamed = { ...repository, fullName: "fixture/renamed-runtime" };
    expect((await post(app, "/api/repositories", renamed, cookie)).statusCode).toBe(201);
    expect((await get(app, settingsUrl, cookie)).json()).toMatchObject({
      version: 2,
      enabled: false,
      authorizedById: null,
    });
    expect((await put(app, { ...enabledSettings, version: 1 }, cookie)).statusCode).toBe(409);
    expect((await post(app, "/api/repositories", repository, cookie)).statusCode).toBe(201);
    expect((await get(app, settingsUrl, cookie)).json()).toMatchObject({
      version: 3,
      enabled: false,
      authorizedById: null,
    });
    expect((await put(app, { ...enabledSettings, version: 3 }, cookie)).statusCode).toBe(200);
    expect((await get(app, settingsUrl, cookie)).json()).toMatchObject({
      version: 4,
      enabled: true,
    });
  });

  it.each(["issue", "pull_request"] as const)(
    "automatically comments after a native complete %s report without a manual action confirmation",
    async (kind) => {
      const context = await fixture();
      const {
        app,
        cookie,
        config,
        progressPublished,
        publishProgressComment,
        execute,
        reconcile,
        readPublisherIdentity,
      } = context;
      expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
      const claim = await createClaim(app, cookie, kind);
      const sealed = await sealReport(app, claim);
      await vi.waitFor(
        async () => {
          expect(await conversationReceipts(app, cookie)).toMatchObject([
            {
              reportId: sealed.reportRef.id,
              taskId: claim.task.id,
              workItemKind: kind,
              workItemNumber: 7,
              state: "sent",
              externalId: "1901",
              settingsVersion: 1,
            },
          ]);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(progressPublished).toHaveLength(1);
      expect(progressPublished[0]).toMatchObject({ externalId: null, previousBody: null });
      expect(await receipts(app, cookie)).toEqual([]);
      expect(stored(config, (store) => store.list("actionIntents"))).toEqual([]);
      const reply = (await conversationReceipts(app, cookie))[0]!;
      expect(reply.body).toMatch(/^I'm GPT-6 Astra,/u);
      expect(reply.body).toContain(kind === "issue" ? "automated bug triage" : "automated review");
      expect(reply.body).toContain("on behalf of GitHub user `@synthetic-publisher`");
      expect(reply.body).toContain("generated by AI and may contain errors.");
      const body = reply.body!.replace(/\n\n<!-- agentic-review-progress:[^\n]+ -->\s*$/u, "");
      const headings =
        kind === "issue"
          ? ["## Triage result", "## Next steps", "<details>"]
          : ["## Conclusion", "## Summary", "## Findings", "<details>"];
      for (let index = 0; index < headings.length; index += 1) {
        expect(body).toContain(headings[index]);
        if (index > 0)
          expect(body.indexOf(headings[index]!)).toBeGreaterThan(
            body.indexOf(headings[index - 1]!),
          );
      }
      expect(body).toContain(
        kind === "issue"
          ? "<summary>Investigation details</summary>"
          : "<summary>Details</summary>",
      );
      expect(body).not.toMatch(/<details\s+open/iu);
      expect(body.trimEnd()).toMatch(/<\/details>$/u);
      if (kind === "issue") {
        const visible = body.slice(0, body.indexOf("<details>"));
        expect(visible).toContain("This triage was generated by AI and may contain errors.");
        expect(visible).toContain("**Needs more information.**");
        expect(visible).not.toContain("**Assessment:**");
        expect(visible).toContain("Could you provide:");
        expect(visible).toContain("**Runtime reproduction:** Not attempted.");
        expect(visible).toContain(
          "The reported startup problem requires the installed version and exact launch steps.",
        );
        expect(visible).toContain("Please provide the installed version and exact launch steps.");
        expect(visible).not.toContain("## Findings");
        expect(visible).not.toContain("## Summary");
      }
      expect(reply.body).toContain("### Validation");
      expect(reply.body).toContain("### Limitations");
      expect(readPublisherIdentity).toHaveBeenCalledTimes(1);
      expect(reply.body).not.toContain(claim.lease.leaseToken);
      expect(
        stored(config, (store) => store.get<InvestigationTaskV1>("tasks", claim.task.id)?.state),
      ).toBe("completed");
      expect(
        stored(
          config,
          (store) =>
            store.get<InvestigationResultV1>("reports", sealed.reportRef.id)?.report.completeness,
        ),
      ).toBe("complete");
      const retry = await workerPost(
        app,
        `/api/worker/tasks/${claim.task.id}/finalize`,
        sealed.finalizePayload,
      );
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual({ reportRef: sealed.reportRef });
      await closeRuntime(app);
      const restarted = await context.start();
      const renewed = await login(restarted);
      expect(await conversationReceipts(restarted, renewed)).toMatchObject([
        { state: "sent", reportId: sealed.reportRef.id },
      ]);
      expect(progressPublished).toHaveLength(1);
      expect(publishProgressComment).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      const nextClaim = await createClaim(restarted, renewed, kind, "next-conversation-task");
      const nextSealed = await sealReport(restarted, nextClaim);
      await vi.waitFor(
        async () => {
          expect(await conversationReceipts(restarted, renewed)).toMatchObject([
            {
              id: reply.id,
              taskId: nextClaim.task.id,
              reportId: nextSealed.reportRef.id,
              state: "sent",
              externalId: "1901",
            },
          ]);
          expect(progressPublished).toHaveLength(2);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(progressPublished[1]).toMatchObject({
        externalId: "1901",
        previousBody: progressPublished[0]!.body,
        marker: progressPublished[0]!.marker,
      });
      expect(progressPublished.filter((request) => request.externalId === null)).toHaveLength(1);
    },
    20000,
  );

  it("keeps a natively sealed partial report available without creating an automatic reply", async () => {
    const { app, cookie, config, execute, published } = await fixture();
    expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
    const claim = await createClaim(app, cookie);
    const sealed = await sealReport(app, claim, "blocked");
    expect(
      stored(config, (store) => store.get<InvestigationResultV1>("reports", sealed.reportRef.id)),
    ).toMatchObject({
      outcome: "blocked",
      report: { completeness: "partial" },
    });
    expect(await receipts(app, cookie)).toEqual([]);
    expect(stored(config, (store) => store.countPrefix("idempotency", "auto-reply:report:"))).toBe(
      0,
    );
    expect(published).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not publish historical complete reports when settings are enabled or the runtime restarts", async () => {
    const context = await fixture();
    const { app, cookie, config, published, execute } = context;
    const claim = await createClaim(app, cookie);
    const sealed = await sealReport(app, claim);
    expect(await receipts(app, cookie)).toEqual([]);
    expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
    await closeRuntime(app);
    const restarted = await context.start();
    const renewed = await login(restarted);
    expect(await receipts(restarted, renewed)).toEqual([]);
    expect(
      stored(
        config,
        (store) => store.get<InvestigationResultV1>("reports", sealed.reportRef.id)?.outcome,
      ),
    ).toBe("completed");
    expect(stored(config, (store) => store.countPrefix("idempotency", "auto-reply:report:"))).toBe(
      0,
    );
    expect(published).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["account", "settings"] as const)(
    "rechecks %s authorization immediately before a mock comment POST",
    async (revocation) => {
      const context = await fixture();
      const { app, cookie, adminCookie, author, progressPublished, publishProgressComment } =
        context;
      expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
      context.pauseExecution();
      const claim = await createClaim(app, cookie);
      await sealReport(app, claim);
      try {
        await vi.waitFor(() => expect(publishProgressComment).toHaveBeenCalledTimes(1), {
          timeout: 5000,
          interval: 20,
        });
        expect(progressPublished).toEqual([]);
        if (revocation === "account") {
          const revoked = await post(
            app,
            `/api/accounts/${author.id}/update`,
            updateAccount(author, {
              actionCapabilities: [],
            }),
            adminCookie,
          );
          expect(revoked.statusCode, revoked.body).toBe(200);
        } else {
          const disabled = await put(
            app,
            { ...enabledSettings, version: 1, enabled: false },
            cookie,
          );
          expect(disabled.statusCode, disabled.body).toBe(200);
        }
      } finally {
        context.releaseExecution();
      }
      await vi.waitFor(
        async () => {
          expect(await conversationReceipts(app, adminCookie)).toMatchObject([
            { state: "blocked" },
          ]);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(progressPublished).toEqual([]);
      expect(publishProgressComment).toHaveBeenCalledTimes(1);
      expect((await conversationReceipts(app, adminCookie))[0]?.reason).toMatch(
        /authorization|publisher/iu,
      );
    },
    20000,
  );
});
