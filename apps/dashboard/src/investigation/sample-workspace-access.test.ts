import {
  ActionContextV1Schema,
  type InvestigationAccount,
  type InvestigationAccountPermission,
  InvestigationActionKindSchema,
  type InvestigationSession,
  type InvestigationSessionUser,
  type InvestigationUpdateAccountRequest,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTaskInput,
  InvestigationApi,
  PrepareActionInput,
  UpdateRepositoryAutoReplySettingsInput,
  UpdateRepositoryWebhookSettingsInput,
} from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { createSampleAuthApi } from "./sample-auth";
import {
  sampleIssueAutoReplyTemplate,
  samplePullRequestAutoReplyTemplate,
} from "./sample-auto-reply-templates";
import { createSessionScopedSampleApi } from "./sample-workspace-access";
import { InvestigationHttpError } from "./transport";

const repositoryId = "repo-powertoys-fork";
const foreignRepositoryId = "repo-private-project";
const workItemId = "sample-pr-p1-work-item";
const reportId = "sample-pr-p1-report";
const taskId = "sample-pr-p1-task";
const permissions: InvestigationAccountPermission[] = [
  "repository:manage",
  "task:create",
  "task:cancel",
  "action:prepare",
  "action:execute",
];
const fetcher = vi.fn<typeof fetch>();
const storageAccess = vi.fn(() => {
  throw new Error("Sample workspace access must never use persistent browser storage.");
});
const forbiddenStorage = new Proxy({} as Storage, {
  get: storageAccess,
  set: storageAccess,
  deleteProperty: storageAccess,
  defineProperty: storageAccess,
  ownKeys: storageAccess,
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("A required sample value is missing.");
  return value;
}

function signedIn(
  overrides: Partial<InvestigationSessionUser> = {},
): Extract<InvestigationSession, { authenticated: true }> {
  return {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "sample-operator",
      username: "demo",
      displayName: "Development Operator",
      email: null,
      isAdmin: true,
      repositoryIds: [repositoryId],
      permissions: [...permissions],
      actionCapabilities: InvestigationActionKindSchema.anyOf.map((entry) => entry.const),
      allowRepositoryExecution: false,
      ...overrides,
    },
  };
}

function signedOut(): InvestigationSession {
  return { authenticated: false, authMode: "password", loginPath: "/api/auth/login", user: null };
}

async function expectDenied(operation: Promise<unknown>, status = 403): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(InvestigationHttpError);
  await expect(operation).rejects.toMatchObject({ status });
}

function spyAll(api: InvestigationApi): void {
  for (const method of Object.keys(api) as (keyof InvestigationApi)[]) vi.spyOn(api, method);
}

function createInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    idempotencyKey: "scoped-create-task",
    workItemId: "sample-feature-work-item",
    kind: "issue-investigate",
    executionMode: "source_read",
    ...overrides,
  };
}

function webhookInput(): UpdateRepositoryWebhookSettingsInput {
  return { version: 0, enabled: true, reviewerUserId: 200, allowedActorUserIds: [100, 101] };
}

function autoReplyInput(): UpdateRepositoryAutoReplySettingsInput {
  return {
    version: 0,
    enabled: true,
    pullRequestTemplate: samplePullRequestAutoReplyTemplate,
    issueTemplate: sampleIssueAutoReplyTemplate,
  };
}

async function feedbackInput(raw: InvestigationApi): Promise<PrepareActionInput> {
  const item = await raw.workItem(workItemId);
  const context = await raw.actionContext(workItemId, reportId);
  return {
    idempotencyKey: "scoped-comment",
    workItemId,
    action: "comment",
    subjectRef: item.subject.id,
    expectedRevisionKey: context.target.revisionKey,
    expectedHeadSha: context.target.headSha,
    reportRef: context.reportRef,
    payload: { kind: "feedback", body: "Selected sample feedback.", findingIds: [], drafts: [] },
  };
}

function accountUpdate(
  account: InvestigationAccount,
  overrides: Partial<InvestigationUpdateAccountRequest> = {},
): InvestigationUpdateAccountRequest {
  return {
    version: account.version,
    displayName: account.displayName,
    enabled: account.enabled,
    isAdmin: account.isAdmin,
    repositoryIds: [...account.repositoryIds],
    permissions: [...account.permissions],
    actionCapabilities: [...account.actionCapabilities],
    allowRepositoryExecution: account.allowRepositoryExecution,
    ...overrides,
  };
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(
    new Error("Sample workspace tests must never dispatch network requests."),
  );
  storageAccess.mockClear();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("localStorage", forbiddenStorage);
  vi.stubGlobal("sessionStorage", forbiddenStorage);
});

afterEach(() => {
  try {
    expect(fetcher).not.toHaveBeenCalled();
    expect(storageAccess).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("sample workspace session and repository access", () => {
  it("does not read a session or call the wrapped API during construction", () => {
    const raw = createSampleInvestigationApi();
    spyAll(raw);
    const session = vi.fn(async () => signedIn());
    createSessionScopedSampleApi(raw, session);
    expect(session).not.toHaveBeenCalled();
    for (const method of Object.values(raw)) expect(method).not.toHaveBeenCalled();
  });

  it("rejects every operation before accessing sample data when signed out", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    spyAll(raw);
    const session = vi.fn(async () => signedOut());
    const expired = vi.fn();
    const api = createSessionScopedSampleApi(raw, session, expired);
    const operations: Array<() => Promise<unknown>> = [
      () => api.repositories(),
      () => api.repositoryWebhookSettings(repositoryId),
      () => api.updateRepositoryWebhookSettings(repositoryId, webhookInput()),
      () => api.repositoryAutoReplySettings(repositoryId),
      () => api.repositoryAutoReplies(repositoryId),
      () => api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput()),
      () => api.workItems(),
      () => api.workItem(workItemId),
      () => api.importWorkItem(repositoryId, { kind: "pull_request", number: 1 }),
      () => api.tasks(),
      () => api.task(taskId),
      () => api.createTask(createInput()),
      () => api.resumeTask("sample-pr-partial-task", "signed-out-resume"),
      () => api.cancelTask(taskId),
      () => api.report(reportId),
      () => api.findings(reportId),
      () => api.exportReport(reportId),
      () => api.artifact("sample-artifact"),
      () => api.actionContext(workItemId, reportId),
      () => api.prepareAction(input),
      () => api.actionIntent("sample-intent"),
      () => api.confirmAction("sample-intent", 1, "a".repeat(64)),
      () => api.reconcileAction("sample-intent"),
    ];
    for (const operation of operations) await expectDenied(operation(), 401);
    expect(session).toHaveBeenCalledTimes(operations.length);
    expect(expired).toHaveBeenCalledTimes(operations.length);
    for (const method of Object.values(raw)) expect(method).not.toHaveBeenCalled();
  });

  it("allows repository members to read webhook settings and managers to update them", async () => {
    const raw = createSampleInvestigationApi();
    const settings = await raw.repositoryWebhookSettings(repositoryId);
    const reading = vi.spyOn(raw, "repositoryWebhookSettings");
    const updating = vi.spyOn(raw, "updateRepositoryWebhookSettings");
    let current = signedIn({ isAdmin: false, permissions: [], actionCapabilities: [] });
    const api = createSessionScopedSampleApi(raw, async () => current);
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(settings);
    expect(reading).toHaveBeenCalledWith(repositoryId);
    await expectDenied(api.updateRepositoryWebhookSettings(repositoryId, webhookInput()));
    expect(updating).not.toHaveBeenCalled();

    current = signedIn({
      isAdmin: false,
      permissions: ["repository:manage"],
      actionCapabilities: [],
    });
    const input = webhookInput();
    const updated = await api.updateRepositoryWebhookSettings(repositoryId, input);
    expect(updating).toHaveBeenCalledWith(repositoryId, input);
    expect(updated).toEqual({ ...input, repositoryId, version: 1, receiverConfigured: false });
    expect(await api.repositoryWebhookSettings(repositoryId)).toEqual(updated);
  });

  it("filters mixed repository, work item, and task lists by current repository grants", async () => {
    const raw = createSampleInvestigationApi();
    const repository = required((await raw.repositories()).items[0]);
    const item = await raw.workItem(workItemId);
    const task = (await raw.task(taskId)).task;
    const foreignRepository = {
      ...repository,
      id: foreignRepositoryId,
      fullName: "private/project",
    };
    const foreignItem = { ...item, id: "foreign-work-item", repositoryId: foreignRepositoryId };
    const foreignTask = {
      ...task,
      id: "foreign-task",
      repository: foreignRepository,
      workItem: { ...task.workItem, id: foreignItem.id },
    };
    vi.spyOn(raw, "repositories").mockResolvedValue({ items: [foreignRepository, repository] });
    vi.spyOn(raw, "workItems").mockResolvedValue({ items: [foreignItem, item] });
    vi.spyOn(raw, "tasks").mockResolvedValue({ items: [foreignTask, task] });
    let current = signedIn();
    const api = createSessionScopedSampleApi(raw, async () => current);
    expect(await api.repositories()).toEqual({ items: [repository] });
    expect(await api.workItems()).toEqual({ items: [item] });
    expect(await api.tasks()).toEqual({ items: [task] });
    current = signedIn({ repositoryIds: [foreignRepositoryId] });
    expect(await api.repositories()).toEqual({ items: [foreignRepository] });
    expect(await api.workItems()).toEqual({ items: [foreignItem] });
    expect(await api.tasks()).toEqual({ items: [foreignTask] });
    current = signedIn({ repositoryIds: [] });
    expect(await api.repositories()).toEqual({ items: [] });
    expect(await api.workItems()).toEqual({ items: [] });
    expect(await api.tasks()).toEqual({ items: [] });
  });

  it("scopes artifact metadata to the owning task and rechecks access before returning it", async () => {
    const raw = createSampleInvestigationApi();
    const artifact = required((await raw.exportReport(reportId)).artifacts[0]);
    let current = signedIn({ repositoryIds: [foreignRepositoryId] });
    const api = createSessionScopedSampleApi(raw, async () => current);
    await expectDenied(api.artifact(artifact.id));
    current = signedIn();
    expect((await api.artifact(artifact.id)).artifact.id).toBe(artifact.id);
    const task = await raw.task(taskId);
    vi.spyOn(raw, "task").mockImplementation(async () => {
      current = signedIn({ repositoryIds: [] });
      return task;
    });
    await expectDenied(api.artifact(artifact.id));
  });

  it("rejects direct identifiers outside repository grants without returning findings or exports", async () => {
    const raw = createSampleInvestigationApi();
    const intent = await raw.prepareAction(await feedbackInput(raw));
    const findings = vi.spyOn(raw, "findings");
    const exportReport = vi.spyOn(raw, "exportReport");
    const context = vi.spyOn(raw, "actionContext");
    const settings = vi.spyOn(raw, "repositoryWebhookSettings");
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ repositoryIds: [foreignRepositoryId] }),
    );
    for (const operation of [
      () => api.repositoryWebhookSettings(repositoryId),
      () => api.workItem(workItemId),
      () => api.task(taskId),
      () => api.report(reportId),
      () => api.findings(reportId),
      () => api.exportReport(reportId),
      () => api.actionContext(workItemId, reportId),
      () => api.actionIntent(intent.id),
    ])
      await expectDenied(operation());
    expect(findings).not.toHaveBeenCalled();
    expect(exportReport).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });

  it("filters unauthorized nested tasks and reports from an authorized task detail", async () => {
    const raw = createSampleInvestigationApi();
    const detail = await raw.task(taskId);
    const allowedChild = { ...structuredClone(detail.task), id: "allowed-child" };
    const foreignChild = { ...structuredClone(detail.task), id: "foreign-child" };
    foreignChild.repository.id = foreignRepositoryId;
    detail.children = [foreignChild, allowedChild];
    detail.latestReport = structuredClone(required(detail.latestReport));
    detail.latestReport.context.repository.id = foreignRepositoryId;
    vi.spyOn(raw, "task").mockResolvedValue(detail);
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    const result = await api.task(taskId);
    expect(result.task.id).toBe(taskId);
    expect(result.children).toEqual([allowedChild]);
    expect(result.latestReport).toBeNull();
    expect(detail.children).toHaveLength(2);
    expect(detail.latestReport).not.toBeNull();
  });

  it("checks an explicit report even when its work item belongs to an authorized repository", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const header = await raw.report(reportId);
    const foreignHeader = structuredClone(header);
    foreignHeader.context.repository.id = foreignRepositoryId;
    vi.spyOn(raw, "report").mockResolvedValue(foreignHeader);
    const context = vi.spyOn(raw, "actionContext");
    const prepare = vi.spyOn(raw, "prepareAction");
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    await expectDenied(api.actionContext(workItemId, reportId));
    await expectDenied(api.prepareAction(input));
    expect(context).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("sample automatic reply access", () => {
  it("allows repository readers to inspect settings and delivery history while blocking outsiders", async () => {
    const raw = createSampleInvestigationApi();
    const settings = await raw.repositoryAutoReplySettings(repositoryId);
    const reading = vi.spyOn(raw, "repositoryAutoReplySettings");
    const replies = vi.spyOn(raw, "repositoryAutoReplies");
    const updating = vi.spyOn(raw, "updateRepositoryAutoReplySettings");
    let current = signedIn({ permissions: [], actionCapabilities: [] });
    const api = createSessionScopedSampleApi(raw, async () => current);
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(settings);
    expect(await api.repositoryAutoReplies(repositoryId)).toEqual({ items: [] });
    await expectDenied(api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput()));
    expect(updating).not.toHaveBeenCalled();
    reading.mockClear();
    replies.mockClear();
    current = signedIn({ repositoryIds: [foreignRepositoryId] });
    await expectDenied(api.repositoryAutoReplySettings(repositoryId));
    await expectDenied(api.repositoryAutoReplies(repositoryId));
    await expectDenied(api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput()));
    expect(reading).not.toHaveBeenCalled();
    expect(replies).not.toHaveBeenCalled();
    expect(updating).not.toHaveBeenCalled();
  });

  it.each<{ name: string; overrides: Partial<InvestigationSessionUser> }>([
    {
      name: "repository management",
      overrides: { permissions: ["action:prepare", "action:execute"] },
    },
    {
      name: "action preparation",
      overrides: { permissions: ["repository:manage", "action:execute"] },
    },
    {
      name: "action execution",
      overrides: { permissions: ["repository:manage", "action:prepare"] },
    },
    { name: "comment capability", overrides: { actionCapabilities: ["approve"] } },
  ])(
    "requires $name to save enabled automatic replies even for administrators",
    async ({ overrides }) => {
      const raw = createSampleInvestigationApi();
      const updating = vi.spyOn(raw, "updateRepositoryAutoReplySettings");
      const api = createSessionScopedSampleApi(raw, async () => signedIn(overrides));
      await expectDenied(api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput()));
      expect(updating).not.toHaveBeenCalled();
    },
  );

  it("permits managers to disable automatic replies and binds enabled settings to the actual authorizing account", async () => {
    const raw = createSampleInvestigationApi();
    let current = signedIn({ id: "first-operator", username: "first" });
    const api = createSessionScopedSampleApi(raw, async () => current);
    const first = await api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput());
    expect(first).toMatchObject({ enabled: true, authorizedById: "first-operator", version: 1 });
    current = signedIn({ id: "second-operator", username: "second" });
    expect((await api.repositoryAutoReplySettings(repositoryId)).authorizedById).toBe(
      "first-operator",
    );
    const second = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...first,
      enabled: true,
    });
    expect(second).toMatchObject({ enabled: true, authorizedById: "second-operator", version: 2 });
    const external = await raw.updateRepositoryAutoReplySettings(repositoryId, {
      ...second,
      enabled: true,
    });
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(external);
    current = signedIn({
      id: "manager",
      username: "manager",
      isAdmin: false,
      permissions: ["repository:manage"],
      actionCapabilities: [],
    });
    const disabled = await api.updateRepositoryAutoReplySettings(repositoryId, {
      ...external,
      enabled: false,
    });
    expect(disabled).toMatchObject({ enabled: false, authorizedById: null, version: 4 });
    expect(await api.repositoryAutoReplySettings(repositoryId)).toEqual(disabled);
    expect(await api.repositoryAutoReplies(repositoryId)).toEqual({ items: [] });
  });

  it.each([
    "sign out",
    "switch account",
    "revoke repository",
    "revoke management",
    "revoke preparation",
    "revoke execution",
    "revoke comment",
  ] as const)(
    "rechecks all authorization before saving when the session changes to %s",
    async (change) => {
      const raw = createSampleInvestigationApi();
      const initial = await raw.repositoryAutoReplySettings(repositoryId);
      const updating = vi.spyOn(raw, "updateRepositoryAutoReplySettings");
      const changed =
        change === "sign out"
          ? signedOut()
          : change === "switch account"
            ? signedIn({ id: "other-operator", username: "other" })
            : change === "revoke repository"
              ? signedIn({ repositoryIds: [] })
              : change === "revoke comment"
                ? signedIn({ actionCapabilities: [] })
                : signedIn({
                    permissions: permissions.filter((permission) =>
                      change === "revoke management"
                        ? permission !== "repository:manage"
                        : change === "revoke preparation"
                          ? permission !== "action:prepare"
                          : permission !== "action:execute",
                    ),
                  });
      const session = vi
        .fn<() => Promise<InvestigationSession>>()
        .mockResolvedValueOnce(signedIn())
        .mockResolvedValue(changed);
      const expired = vi.fn();
      const api = createSessionScopedSampleApi(raw, session, expired);
      const sessionExpired = change === "sign out" || change === "switch account";
      await expectDenied(
        api.updateRepositoryAutoReplySettings(repositoryId, autoReplyInput()),
        sessionExpired ? 401 : 403,
      );
      expect(session).toHaveBeenCalledTimes(2);
      expect(updating).not.toHaveBeenCalled();
      expect(await raw.repositoryAutoReplySettings(repositoryId)).toEqual(initial);
      expect(expired).toHaveBeenCalledTimes(sessionExpired ? 1 : 0);
    },
  );

  it.each(["repositoryAutoReplySettings", "repositoryAutoReplies"] as const)(
    "rechecks repository access after awaiting %s",
    async (method) => {
      const raw = createSampleInvestigationApi();
      let current = signedIn();
      if (method === "repositoryAutoReplySettings") {
        const settings = await raw.repositoryAutoReplySettings(repositoryId);
        vi.spyOn(raw, method).mockImplementation(async () => {
          current = signedIn({ repositoryIds: [] });
          return settings;
        });
      } else {
        vi.spyOn(raw, method).mockImplementation(async () => {
          current = signedIn({ repositoryIds: [] });
          return { items: [] };
        });
      }
      const api = createSessionScopedSampleApi(raw, async () => current);
      await expectDenied(api[method](repositoryId));
      expect(raw[method]).toHaveBeenCalledOnce();
    },
  );

  it("freezes the enabling decision and templates before awaiting the session", async () => {
    const raw = createSampleInvestigationApi();
    const updating = vi.spyOn(raw, "updateRepositoryAutoReplySettings");
    let release!: (value: InvestigationSession) => void;
    const pendingSession = new Promise<InvestigationSession>((resolve) => {
      release = resolve;
    });
    const api = createSessionScopedSampleApi(raw, () => pendingSession);
    const input = autoReplyInput();
    const expected = structuredClone(input);
    const pending = api.updateRepositoryAutoReplySettings(repositoryId, input);
    input.enabled = false;
    input.version = 100;
    input.pullRequestTemplate = "Replaced template";
    input.issueTemplate = "Replaced template";
    release(signedIn());
    const saved = await pending;
    expect(updating).toHaveBeenCalledWith(repositoryId, expected);
    expect(saved).toMatchObject({ ...expected, version: 1 });
  });
});

describe("sample workspace mutation authorization", () => {
  it("requires each operation's permission before calling its underlying mutation, including for administrators", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const intent = await raw.prepareAction(input);
    for (const method of [
      "updateRepositoryWebhookSettings",
      "importWorkItem",
      "createTask",
      "resumeTask",
      "cancelTask",
      "prepareAction",
      "confirmAction",
      "reconcileAction",
    ] as const) {
      vi.spyOn(raw, method);
    }
    let current = signedIn();
    const api = createSessionScopedSampleApi(raw, async () => current);
    const operations: Array<{
      permission: InvestigationAccountPermission;
      method: keyof InvestigationApi;
      run: () => Promise<unknown>;
    }> = [
      {
        permission: "repository:manage",
        method: "updateRepositoryWebhookSettings",
        run: () => api.updateRepositoryWebhookSettings(repositoryId, webhookInput()),
      },
      {
        permission: "repository:manage",
        method: "importWorkItem",
        run: () => api.importWorkItem(repositoryId, { kind: "issue", number: 1 }),
      },
      { permission: "task:create", method: "createTask", run: () => api.createTask(createInput()) },
      {
        permission: "task:create",
        method: "resumeTask",
        run: () => api.resumeTask("sample-pr-partial-task", "denied-resume"),
      },
      { permission: "task:cancel", method: "cancelTask", run: () => api.cancelTask(taskId) },
      {
        permission: "action:prepare",
        method: "prepareAction",
        run: () => api.prepareAction(input),
      },
      {
        permission: "action:execute",
        method: "confirmAction",
        run: () => api.confirmAction(intent.id, intent.version, intent.payloadDigest),
      },
      {
        permission: "action:execute",
        method: "reconcileAction",
        run: () => api.reconcileAction(intent.id),
      },
    ];
    for (const operation of operations) {
      current = signedIn({
        permissions: permissions.filter((permission) => permission !== operation.permission),
      });
      await expectDenied(operation.run());
      expect(raw[operation.method]).not.toHaveBeenCalled();
    }
  });

  it("rejects every mutation when repository access is missing even with all business grants", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const intent = await raw.prepareAction(input);
    const mutations = [
      "updateRepositoryWebhookSettings",
      "importWorkItem",
      "createTask",
      "resumeTask",
      "cancelTask",
      "prepareAction",
      "confirmAction",
      "reconcileAction",
    ] as const;
    for (const method of mutations) vi.spyOn(raw, method);
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ repositoryIds: [foreignRepositoryId] }),
    );
    for (const operation of [
      () => api.updateRepositoryWebhookSettings(repositoryId, webhookInput()),
      () => api.importWorkItem(repositoryId, { kind: "issue", number: 1 }),
      () => api.createTask(createInput()),
      () => api.resumeTask("sample-pr-partial-task", "foreign-resume"),
      () => api.cancelTask(taskId),
      () => api.prepareAction(input),
      () => api.confirmAction(intent.id, intent.version, intent.payloadDigest),
      () => api.reconcileAction(intent.id),
    ])
      await expectDenied(operation());
    for (const method of mutations) expect(raw[method]).not.toHaveBeenCalled();
  });

  it("delegates authorized operations while preserving the sample adapter's synthetic outcomes", async () => {
    const raw = createSampleInvestigationApi();
    const item = await raw.workItem(workItemId);
    const input = await feedbackInput(raw);
    const imported = {
      workItem: item,
      snapshotRef: { id: "sample-snapshot", digest: "a".repeat(64) },
      commentsCount: 0,
    };
    const importing = vi.spyOn(raw, "importWorkItem").mockResolvedValue(imported);
    const api = createSessionScopedSampleApi(raw, async () => signedIn());
    expect(
      await api.importWorkItem(repositoryId, { kind: "pull_request", number: item.number }),
    ).toEqual(imported);
    expect(importing).toHaveBeenCalledOnce();
    const created = await api.createTask(createInput());
    expect(created.state).toBe("queued");
    expect((await api.cancelTask(created.id)).state).toBe("cancelled");
    expect((await api.resumeTask("sample-pr-partial-task", "allowed-resume")).state).toBe("queued");
    const prepared = await api.prepareAction(input);
    expect((await api.actionIntent(prepared.id)).id).toBe(prepared.id);
    const confirmed = await api.confirmAction(
      prepared.id,
      prepared.version,
      prepared.payloadDigest,
    );
    expect(confirmed.state).toBe("failed");
    expect(confirmed.result?.externalId).toBeNull();
    expect(confirmed.result?.message).toContain("no GitHub action was dispatched");
    expect(await api.reconcileAction(prepared.id)).toEqual(confirmed);
  });

  it("requires exact capabilities for preparation and the stored action for confirmation and reconciliation", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const merge = await raw.prepareAction({
      ...input,
      action: "merge",
      payload: { kind: "merge", method: "squash", commitTitle: "Sample merge" },
    });
    const prepare = vi.spyOn(raw, "prepareAction");
    const confirm = vi.spyOn(raw, "confirmAction");
    const reconcile = vi.spyOn(raw, "reconcileAction");
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ actionCapabilities: ["comment"] }),
    );
    await expectDenied(api.prepareAction({ ...input, action: "suggestion-comment" }));
    await expectDenied(api.confirmAction(merge.id, merge.version, merge.payloadDigest));
    await expectDenied(api.reconcileAction(merge.id));
    expect(prepare).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(["start-task", "reviews.verify"] as const)(
    "requires task:create in addition to action grants for %s",
    async (action) => {
      const raw = createSampleInvestigationApi();
      const input = await feedbackInput(raw);
      const original = await raw.prepareAction(input);
      const intent = { ...original, action };
      vi.spyOn(raw, "actionIntent").mockResolvedValue(intent);
      const prepare = vi.spyOn(raw, "prepareAction");
      const confirm = vi.spyOn(raw, "confirmAction");
      const reconcile = vi.spyOn(raw, "reconcileAction");
      const api = createSessionScopedSampleApi(raw, async () =>
        signedIn({ permissions: ["action:prepare", "action:execute"] }),
      );
      await expectDenied(api.prepareAction({ ...input, action }));
      await expectDenied(api.confirmAction(intent.id, intent.version, intent.payloadDigest));
      await expectDenied(api.reconcileAction(intent.id));
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it("requires execution authorization for explicit execution and inherited execution on resume", async () => {
    const raw = createSampleInvestigationApi();
    const detail = await raw.task("sample-pr-partial-task");
    detail.task.executionPolicy.mode = "execute";
    detail.task.executionPolicy.allowRepositoryExecution = true;
    vi.spyOn(raw, "task").mockResolvedValue(detail);
    const creating = vi.spyOn(raw, "createTask").mockImplementation(async (input) => ({
      ...structuredClone(detail.task),
      executionPolicy: {
        ...detail.task.executionPolicy,
        mode: input.executionMode ?? "source_read",
        allowRepositoryExecution: input.executionMode === "execute",
      },
    }));
    const resuming = vi.spyOn(raw, "resumeTask").mockResolvedValue(detail.task);
    let current = signedIn({ allowRepositoryExecution: false });
    const api = createSessionScopedSampleApi(raw, async () => current);
    await expectDenied(api.createTask(createInput({ executionMode: "execute" })));
    await expectDenied(api.resumeTask(detail.task.id, "execute-resume"));
    expect(creating).not.toHaveBeenCalled();
    expect(resuming).not.toHaveBeenCalled();
    await api.createTask(createInput({ executionMode: "source_read" }));
    expect(creating).toHaveBeenCalledOnce();
    expect(creating).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionMode: "source_read" }),
    );
    current = signedIn({ allowRepositoryExecution: true });
    await api.createTask(createInput({ executionMode: "execute" }));
    await api.resumeTask(detail.task.id, "execute-resume");
    expect(creating).toHaveBeenCalledTimes(2);
    expect(creating).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionMode: "execute" }),
    );
    expect(resuming).toHaveBeenCalledOnce();
  });

  it("allows execution-only access to an existing owned intent without requiring preparation again", async () => {
    const raw = createSampleInvestigationApi();
    const intent = await raw.prepareAction(await feedbackInput(raw));
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ permissions: ["action:execute"], actionCapabilities: ["comment"] }),
    );
    const confirmed = await api.confirmAction(intent.id, intent.version, intent.payloadDigest);
    expect(confirmed.state).toBe("failed");
    expect(await api.reconcileAction(intent.id)).toEqual(confirmed);
  });
});

describe("sample action context access", () => {
  it("uses the current actor while retaining P0 blockers and saved source prerequisites", async () => {
    const raw = createSampleInvestigationApi();
    const original = await raw.actionContext("sample-pr-p0-work-item", "sample-pr-p0-report");
    const current = signedIn({
      id: "review-operator",
      username: "reviewer",
      displayName: "Current Reviewer",
    });
    const api = createSessionScopedSampleApi(raw, async () => current);
    const context = await api.actionContext("sample-pr-p0-work-item", "sample-pr-p0-report");
    expect(Value.Check(ActionContextV1Schema, context)).toBe(true);
    expect(context.actor).toEqual({ id: current.user.id, displayName: current.user.displayName });
    expect(context.hardContentBlockers).toEqual(original.hardContentBlockers);
    expect(context.hardContentBlockers.length).toBeGreaterThan(0);
    const approval = required(context.fixedActions.find((entry) => entry.action === "approve"));
    expect(approval.allowed).toBe(false);
    expect(approval.guards).toEqual(
      expect.arrayContaining(
        required(original.fixedActions.find((entry) => entry.action === "approve")).guards,
      ),
    );
    const feature = await api.actionContext("sample-feature-work-item", "sample-feature-report");
    const start = required(feature.nextActions.find((entry) => entry.action === "start-task"));
    expect(start.canPrepare).toBe(true);
    expect(start.allowed).toBe(false);
    expect(start.readyToExecute).toBe(false);
    expect(start.guards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sample_source_commit", satisfied: false }),
      ]),
    );
  });

  it.each([
    {
      name: "prepare only",
      grants: ["action:prepare"],
      caps: ["comment"],
      prepare: true,
      execute: false,
    },
    {
      name: "execute only",
      grants: ["action:execute"],
      caps: ["comment"],
      prepare: false,
      execute: false,
    },
    {
      name: "prepare and execute",
      grants: ["action:prepare", "action:execute"],
      caps: ["comment"],
      prepare: true,
      execute: true,
    },
    {
      name: "a different capability",
      grants: ["action:prepare", "action:execute"],
      caps: ["close"],
      prepare: false,
      execute: false,
    },
  ] as const)(
    "intersects fixed and next action availability for $name",
    async ({ grants, caps, prepare, execute }) => {
      const raw = createSampleInvestigationApi();
      const context = await raw.actionContext("sample-feature-work-item", "sample-feature-report");
      const template = required(context.nextActions[0]);
      const guards = [
        {
          code: "saved_prerequisite",
          satisfied: true,
          message: "The saved prerequisite is satisfied.",
        },
      ];
      context.nextActions = [
        {
          ...template,
          id: "allowed-comment",
          action: "comment",
          taskKind: null,
          planRef: null,
          allowed: true,
          canPrepare: true,
          readyToExecute: true,
          guards,
        },
        {
          ...template,
          id: "blocked-comment",
          action: "comment",
          taskKind: null,
          planRef: null,
          allowed: false,
          canPrepare: false,
          readyToExecute: false,
          guards,
        },
      ];
      vi.spyOn(raw, "actionContext").mockResolvedValue(context);
      const api = createSessionScopedSampleApi(raw, async () =>
        signedIn({ permissions: [...grants], actionCapabilities: [...caps] }),
      );
      const result = await api.actionContext("sample-feature-work-item", "sample-feature-report");
      expect(Value.Check(ActionContextV1Schema, result)).toBe(true);
      expect(
        required(result.fixedActions.find((entry) => entry.action === "comment")).allowed,
      ).toBe(prepare);
      expect(
        required(result.nextActions.find((entry) => entry.id === "allowed-comment")),
      ).toMatchObject({ canPrepare: prepare, allowed: execute, readyToExecute: execute });
      expect(
        required(result.nextActions.find((entry) => entry.id === "blocked-comment")),
      ).toMatchObject({ canPrepare: false, allowed: false, readyToExecute: false });
      for (const action of result.nextActions)
        expect(action.guards).toEqual(expect.arrayContaining(guards));
      expect(context.actor.id).toBe("sample-operator");
      expect(required(context.nextActions[0]).canPrepare).toBe(true);
    },
  );

  it("disables task next actions when task creation permission is absent", async () => {
    const raw = createSampleInvestigationApi();
    const api = createSessionScopedSampleApi(raw, async () =>
      signedIn({ permissions: ["action:prepare", "action:execute"] }),
    );
    const context = await api.actionContext("sample-feature-work-item", "sample-feature-report");
    const start = required(context.nextActions.find((entry) => entry.action === "start-task"));
    expect(start).toMatchObject({ canPrepare: false, allowed: false, readyToExecute: false });
  });
});

describe("sample workspace isolation and changing sessions", () => {
  it.each(["sign out", "switch account", "revoke repository"] as const)(
    "does not return webhook settings after the session changes to %s during a read",
    async (change) => {
      const raw = createSampleInvestigationApi();
      const settings = await raw.repositoryWebhookSettings(repositoryId);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const reading = vi.spyOn(raw, "repositoryWebhookSettings").mockImplementation(async () => {
        notifyStarted();
        await paused;
        return settings;
      });
      let current: InvestigationSession = signedIn();
      const expired = vi.fn();
      const api = createSessionScopedSampleApi(raw, async () => current, expired);
      const sessionExpired = change !== "revoke repository";
      const denied = expectDenied(
        api.repositoryWebhookSettings(repositoryId),
        sessionExpired ? 401 : 403,
      );
      await started;
      current =
        change === "sign out"
          ? signedOut()
          : change === "switch account"
            ? signedIn({ id: "other-operator", username: "other" })
            : signedIn({ repositoryIds: [] });
      release();
      await denied;
      expect(reading).toHaveBeenCalledOnce();
      expect(expired).toHaveBeenCalledTimes(sessionExpired ? 1 : 0);
    },
  );

  it.each(["sign out", "switch account", "revoke repository", "revoke permission"] as const)(
    "rechecks webhook update access before mutation when the session changes to %s",
    async (change) => {
      const raw = createSampleInvestigationApi();
      const settings = await raw.repositoryWebhookSettings(repositoryId);
      const updating = vi.spyOn(raw, "updateRepositoryWebhookSettings");
      let release!: (value: InvestigationSession) => void;
      const paused = new Promise<InvestigationSession>((resolve) => {
        release = resolve;
      });
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const session = vi
        .fn<() => Promise<InvestigationSession>>()
        .mockResolvedValueOnce(signedIn())
        .mockImplementationOnce(() => {
          notifyStarted();
          return paused;
        });
      const expired = vi.fn();
      const api = createSessionScopedSampleApi(raw, session, expired);
      const sessionExpired = change === "sign out" || change === "switch account";
      const denied = expectDenied(
        api.updateRepositoryWebhookSettings(repositoryId, webhookInput()),
        sessionExpired ? 401 : 403,
      );
      await started;
      expect(updating).not.toHaveBeenCalled();
      release(
        change === "sign out"
          ? signedOut()
          : change === "switch account"
            ? signedIn({ id: "other-operator", username: "other" })
            : change === "revoke repository"
              ? signedIn({ repositoryIds: [] })
              : signedIn({ permissions: [] }),
      );
      await denied;
      expect(session).toHaveBeenCalledTimes(2);
      expect(updating).not.toHaveBeenCalled();
      expect(await raw.repositoryWebhookSettings(repositoryId)).toEqual(settings);
      expect(expired).toHaveBeenCalledTimes(sessionExpired ? 1 : 0);
    },
  );

  it.each(["sign out", "switch account", "revoke repository", "revoke permission"] as const)(
    "rechecks access after a delayed lookup before mutation when the session changes to %s",
    async (change) => {
      const raw = createSampleInvestigationApi();
      const detail = await raw.task("sample-feature-task");
      const input = createInput({ parentReportRef: required(detail.task.latestReportRef) });
      const item = await raw.workItem(input.workItemId);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      vi.spyOn(raw, "workItem").mockImplementation(async () => {
        notifyStarted();
        await paused;
        return item;
      });
      const readingReport = vi.spyOn(raw, "report");
      const creating = vi.spyOn(raw, "createTask");
      const expired = vi.fn();
      let current: InvestigationSession = signedIn();
      const api = createSessionScopedSampleApi(raw, async () => current, expired);
      const pending = api.createTask(input);
      await started;
      current =
        change === "sign out"
          ? signedOut()
          : change === "switch account"
            ? signedIn({ id: "other-operator", username: "other" })
            : change === "revoke repository"
              ? signedIn({ repositoryIds: [] })
              : signedIn({
                  permissions: permissions.filter((permission) => permission !== "task:create"),
                });
      release();
      const sessionExpired = change === "sign out" || change === "switch account";
      await expectDenied(pending, sessionExpired ? 401 : 403);
      expect(creating).not.toHaveBeenCalled();
      if (change !== "revoke permission") expect(readingReport).not.toHaveBeenCalled();
      expect(expired).toHaveBeenCalledTimes(sessionExpired ? 1 : 0);
    },
  );

  it("keeps action ownership and repeated idempotency keys isolated between actors", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const confirm = vi.spyOn(raw, "confirmAction");
    const reconcile = vi.spyOn(raw, "reconcileAction");
    let current = signedIn({
      id: "first-operator",
      username: "first",
      displayName: "First Operator",
    });
    const api = createSessionScopedSampleApi(raw, async () => current);
    const first = await api.prepareAction(input);
    expect(first).toMatchObject({
      actorId: "first-operator",
      idempotencyKey: input.idempotencyKey,
    });
    expect((await api.prepareAction(structuredClone(input))).id).toBe(first.id);
    const firstTask = await api.createTask(createInput());
    current = signedIn({
      id: "second-operator",
      username: "second",
      displayName: "Second Operator",
    });
    await expectDenied(api.actionIntent(first.id));
    await expectDenied(api.confirmAction(first.id, first.version, first.payloadDigest));
    await expectDenied(api.reconcileAction(first.id));
    expect(confirm).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    const second = await api.prepareAction(structuredClone(input));
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      actorId: "second-operator",
      idempotencyKey: input.idempotencyKey,
    });
    expect((await api.createTask(createInput())).id).not.toBe(firstTask.id);
    current = signedIn({ id: "first-operator", username: "first" });
    expect((await api.actionIntent(first.id)).actorId).toBe(current.user.id);
    await expectDenied(api.actionIntent(second.id));
  });

  it("snapshots mutable mutation inputs before awaiting the session", async () => {
    const raw = createSampleInvestigationApi();
    const input = await feedbackInput(raw);
    const savedInput = structuredClone(input);
    const detail = await raw.task("sample-pr-partial-task");
    const importedItem = await raw.workItem(workItemId);
    const importInput = { kind: "pull_request" as "pull_request" | "issue", number: 1 };
    const creatingInput = createInput({ budget: structuredClone(detail.task.budget) });
    const savedCreate = structuredClone(creatingInput);
    const budget = structuredClone(detail.task.budget);
    const savedBudget = structuredClone(budget);
    const webhook = webhookInput();
    const savedWebhook = structuredClone(webhook);
    const importing = vi.spyOn(raw, "importWorkItem").mockResolvedValue({
      workItem: importedItem,
      snapshotRef: { id: "snapshot", digest: "a".repeat(64) },
      commentsCount: 0,
    });
    const creating = vi.spyOn(raw, "createTask").mockResolvedValue(detail.task);
    const resuming = vi.spyOn(raw, "resumeTask").mockResolvedValue(detail.task);
    const preparing = vi.spyOn(raw, "prepareAction");
    const updatingWebhook = vi.spyOn(raw, "updateRepositoryWebhookSettings");
    let release!: (session: InvestigationSession) => void;
    const pendingSession = new Promise<InvestigationSession>((resolve) => {
      release = resolve;
    });
    const api = createSessionScopedSampleApi(raw, () => pendingSession);
    const operations = [
      api.updateRepositoryWebhookSettings(repositoryId, webhook),
      api.importWorkItem(repositoryId, importInput),
      api.createTask(creatingInput),
      api.resumeTask(detail.task.id, "snapshot-resume", budget),
      api.prepareAction(input),
    ];
    webhook.version = 99;
    webhook.enabled = false;
    webhook.reviewerUserId = null;
    webhook.allowedActorUserIds.length = 0;
    importInput.kind = "issue";
    importInput.number = 999;
    creatingInput.workItemId = "foreign-work-item";
    required(creatingInput.budget).maxTokens = 1;
    budget.maxTokens = 1;
    input.workItemId = "foreign-work-item";
    input.action = "merge";
    if (input.payload.kind !== "feedback") throw new Error("Expected feedback input.");
    input.payload.body = "Mutated request";
    input.payload.findingIds.push("foreign-finding");
    release(signedIn());
    await Promise.all(operations);
    expect(updatingWebhook).toHaveBeenCalledWith(repositoryId, savedWebhook);
    expect(importing).toHaveBeenCalledWith(repositoryId, { kind: "pull_request", number: 1 });
    expect(creating).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: savedCreate.workItemId, budget: savedCreate.budget }),
    );
    expect(resuming).toHaveBeenCalledWith(detail.task.id, expect.any(String), savedBudget);
    expect(preparing).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: savedInput.workItemId,
        action: savedInput.action,
        payload: savedInput.payload,
      }),
    );
  });

  it("applies revoked repository grants from the real sample account service on the next call", async () => {
    const auth = createSampleAuthApi();
    await auth.login({ username: "demo", password: "Demo-password-2026!" });
    const account = required((await auth.listAccounts()).items[0]);
    const raw = createSampleInvestigationApi();
    const create = vi.spyOn(raw, "createTask");
    const api = createSessionScopedSampleApi(raw, () => auth.session());
    expect((await api.tasks()).items.length).toBeGreaterThan(0);
    await auth.updateAccount(account.id, accountUpdate(account, { repositoryIds: [] }));
    expect(await api.tasks()).toEqual({ items: [] });
    await expectDenied(api.task(taskId));
    await expectDenied(api.createTask(createInput()));
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["reset", "disable"] as const)(
    "rejects reads after the real account service revokes the session through %s",
    async (operation) => {
      const auth = createSampleAuthApi();
      await auth.login({ username: "demo", password: "Demo-password-2026!" });
      const account = required((await auth.listAccounts()).items[0]);
      if (operation === "disable") {
        await auth.createAccount({
          username: "backup",
          password: "Backup-password-2026!",
          displayName: "Backup Administrator",
          isAdmin: true,
          repositoryIds: [repositoryId],
          permissions: [],
          actionCapabilities: [],
          allowRepositoryExecution: false,
        });
      }
      const raw = createSampleInvestigationApi();
      const tasks = vi.spyOn(raw, "tasks");
      const expired = vi.fn();
      const api = createSessionScopedSampleApi(raw, () => auth.session(), expired);
      expect((await api.tasks()).items.length).toBeGreaterThan(0);
      tasks.mockClear();
      if (operation === "reset") {
        await auth.resetAccountPassword(account.id, {
          version: account.version,
          newPassword: "Reset-password-2026!",
        });
      } else {
        await auth.updateAccount(account.id, accountUpdate(account, { enabled: false }));
      }
      await expectDenied(api.tasks(), 401);
      expect(tasks).not.toHaveBeenCalled();
      expect(expired).toHaveBeenCalledOnce();
    },
  );
});
