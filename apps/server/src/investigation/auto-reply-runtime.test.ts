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
import { InvestigationPasswordStore } from "../../dist/investigation/password-store.js";
import {
  type InvestigationRuntimeConfig,
  loadInvestigationRuntimeConfig,
} from "../../dist/investigation/runtime-config.js";
import { createInvestigationRuntime } from "../../dist/investigation/runtime-main.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationActionTransport } from "../../dist/investigation/types.js";

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
  };
  const sourceImportFetch: typeof globalThis.fetch = async (input, init) => {
    expect(init?.method).toBe("GET");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
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
      idempotencyKey: "automatic-reply-task",
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
  for (const phase of (outcome === "completed"
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
      continue: phase !== "finalize",
      continuationReason:
        phase === "finalize"
          ? "The complete synthetic scope is ready for delivery."
          : "A separate finalization round remains necessary.",
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

describe("automatic reply production runtime", () => {
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
      const { app, cookie, config, published, execute, reconcile, readPublisherIdentity } = context;
      expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
      const claim = await createClaim(app, cookie, kind);
      const sealed = await sealReport(app, claim);
      await vi.waitFor(
        async () => {
          expect(await receipts(app, cookie)).toMatchObject([
            {
              reportId: sealed.reportRef.id,
              taskId: claim.task.id,
              workItemKind: kind,
              workItemNumber: 7,
              state: "sent",
              externalId: "901",
              settingsVersion: 1,
            },
          ]);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        action: "comment",
        reportRef: sealed.reportRef,
        payload: { kind: "feedback" },
      });
      const reply = (await receipts(app, cookie))[0]!;
      expect(reply.body).toMatch(/^I'm GPT-6 Astra,/u);
      expect(reply.body).toContain(kind === "issue" ? "automated bug triage" : "automated review");
      expect(reply.body).toContain("on behalf of GitHub user `@synthetic-publisher`");
      expect(reply.body).toContain("generated by AI and may contain errors.");
      const body = reply.body!;
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
      expect(await receipts(restarted, renewed)).toMatchObject([
        { state: "sent", reportId: sealed.reportRef.id },
      ]);
      expect(published).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
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
      const { app, cookie, adminCookie, author, published, execute } = context;
      expect((await put(app, enabledSettings, cookie)).statusCode).toBe(200);
      context.pauseExecution();
      const claim = await createClaim(app, cookie);
      await sealReport(app, claim);
      try {
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), {
          timeout: 5000,
          interval: 20,
        });
        expect(published).toEqual([]);
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
          expect(await receipts(app, adminCookie)).toMatchObject([{ state: "failed" }]);
        },
        { timeout: 5000, interval: 20 },
      );
      expect(published).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await receipts(app, adminCookie))[0]?.reason).toMatch(/disabled|permission/iu);
    },
    20000,
  );
});
