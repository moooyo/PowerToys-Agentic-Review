import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSource,
  ConfigurationAuditSummary,
  GlobalConfigurationAuditListResponse,
  RepositoryConfigurationAuditListResponse,
  RepositoryConfigurationSnapshotV1,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "../review-control/errors";
import { MAX_DASHBOARD_RESPONSE_BYTES } from "../review-control/http-client";
import type { ConfigurationAuditPageQuery, GlobalConfigurationAuditQuery } from "./adapter";
import { HttpConfigurationAuditAdapter } from "./http-adapter";
import { compareConfigurationAuditSummaries, configurationAuditEventMatches } from "./validation";

const repositoryId = "repository:one";
const templateId = "template:one";
const createdAt = "2026-09-07T08:00:00.000Z";
const actor = { issuer: "https://Identity.example/Issuer", subject: "Operator-A" };
const repository: RepositoryConfigurationSnapshotV1 = {
  id: repositoryId,
  githubRepositoryId: 123,
  fullName: "example/project",
  enabled: true,
  version: 2,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  connectionStatus: "unknown",
  connectionMessage: null,
  createdAt: "2026-09-06T08:00:00.000Z",
  updatedAt: createdAt,
};
const base = { id: "audit:one", actor, createdAt };
const repositoryEvent: ConfigurationAuditEvent = {
  ...base,
  source: "repository",
  action: "updated",
  entityId: repositoryId,
  repositoryId,
  version: 2,
  snapshot: repository,
};
const templateEvent: ConfigurationAuditEvent = {
  ...base,
  source: "prompt",
  action: "template_created",
  entityId: templateId,
  repositoryId: null,
  version: 1,
  snapshot: { workflowKind: "pr_static_build", version: 1 },
};
const draftEvent: ConfigurationAuditEvent = {
  ...templateEvent,
  action: "draft_saved",
  version: 3,
  snapshot: { version: 3, draftRevision: 2 },
};
const publishedEvent: ConfigurationAuditEvent = {
  ...templateEvent,
  action: "prompt_published",
  version: 4,
  snapshot: { promptVersionId: "prompt-version:one", version: 4, publishedVersion: 1 },
};
const boundEvent: ConfigurationAuditEvent = {
  ...base,
  source: "prompt",
  action: "prompt_bound",
  entityId: "binding-history:one",
  repositoryId,
  version: 1,
  snapshot: {
    workflowKind: "pr_static_build",
    promptVersionId: "prompt-version:one",
    previousVersionId: null,
    version: 1,
  },
};
const profileEvent: ConfigurationAuditEvent = {
  ...base,
  source: "prompt",
  action: "profile_published",
  entityId: "profile:one",
  repositoryId,
  version: 3,
  snapshot: { profileVersionId: "profile-version:three", version: 3 },
};
const profileBoundEvent: ConfigurationAuditEvent = {
  ...base,
  source: "prompt",
  action: "profile_bound",
  entityId: "profile-binding-history:one",
  repositoryId,
  version: 2,
  snapshot: {
    profileId: "profile:one",
    profileVersionId: "profile-version:one",
    previousVersionId: "profile-version:three",
    enabled: false,
    version: 2,
  },
};
const bootstrapEvent: ConfigurationAuditEvent = {
  ...base,
  source: "prompt",
  action: "bootstrap_registered",
  entityId: "pr_static_build",
  repositoryId: null,
  version: null,
  snapshot: { promptVersionId: "prompt-version:one" },
};
const events = [
  repositoryEvent,
  templateEvent,
  draftEvent,
  publishedEvent,
  boundEvent,
  profileEvent,
  profileBoundEvent,
  bootstrapEvent,
];
const summary = (event: ConfigurationAuditEvent): ConfigurationAuditSummary => {
  const { snapshot: _snapshot, ...result } = event;
  return result;
};
const repositoryPage = (
  items: ConfigurationAuditSummary[],
  overrides: Partial<RepositoryConfigurationAuditListResponse> = {},
): RepositoryConfigurationAuditListResponse => ({
  repositoryId,
  page: 1,
  pageSize: 20,
  total: items.length,
  items,
  ...overrides,
});
const globalPage = (
  items: ConfigurationAuditSummary[],
  overrides: Partial<GlobalConfigurationAuditListResponse> = {},
): GlobalConfigurationAuditListResponse => ({
  page: 1,
  pageSize: 20,
  total: items.length,
  items,
  ...overrides,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const adapterWith = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
  return { adapter: new HttpConfigurationAuditAdapter({ fetch }), fetch };
};
const read = (
  adapter: HttpConfigurationAuditAdapter,
  event: ConfigurationAuditEvent,
  expected = summary(event),
) =>
  event.repositoryId === null
    ? adapter.getGlobalConfigurationAudit(event.id, expected)
    : adapter.getRepositoryConfigurationAudit(event.repositoryId, event.source, event.id, expected);

describe("configuration audit HTTP transport", () => {
  it("uses bounded authenticated read routes for repository and global history", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(repositoryPage([summary(repositoryEvent)])))
      .mockResolvedValueOnce(response(repositoryEvent))
      .mockResolvedValueOnce(response(globalPage([summary(templateEvent)], { templateId })))
      .mockResolvedValueOnce(response(templateEvent));
    const adapter = new HttpConfigurationAuditAdapter({ fetch });
    expect(adapter.mode).toBe("connected");
    await adapter.listRepositoryConfigurationAudit(repositoryId);
    await adapter.getRepositoryConfigurationAudit(
      repositoryId,
      "repository",
      repositoryEvent.id,
      summary(repositoryEvent),
    );
    await adapter.listGlobalConfigurationAudit({ templateId });
    await adapter.getGlobalConfigurationAudit(templateEvent.id, summary(templateEvent));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/operator/repositories/${repositoryId}/configuration-audit?page=1&pageSize=20`,
      `/api/v1/operator/repositories/${repositoryId}/configuration-audit/repository/${repositoryEvent.id}`,
      "/api/v1/operator/configuration-audit?page=1&pageSize=20&templateId=template%3Aone",
      `/api/v1/operator/configuration-audit/${templateEvent.id}`,
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "include",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(options?.body).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([401, 403, 404, 409, 500, 503])(
    "propagates HTTP %s without replacing missing history",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response(
          {
            error: { code: "AUDIT_UNAVAILABLE", message: "Audit unavailable.", retryable: false },
          },
          status,
        ),
      );
      const adapter = new HttpConfigurationAuditAdapter({ fetch });
      await expect(adapter.listGlobalConfigurationAudit()).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("retains typed network, timeout, protocol and size failures", async () => {
    const failed = new HttpConfigurationAuditAdapter({
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(failed.listGlobalConfigurationAudit()).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
    const timedOut = new HttpConfigurationAuditAdapter({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
      timeoutMs: 1,
    });
    await expect(timedOut.listGlobalConfigurationAudit()).rejects.toBeInstanceOf(
      ReviewControlTimeoutError,
    );
    const malformed = new HttpConfigurationAuditAdapter({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("not JSON", { headers: { "content-type": "application/json" } }),
        ),
    });
    await expect(malformed.listGlobalConfigurationAudit()).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    const oversized = new HttpConfigurationAuditAdapter({
      fetch: vi.fn().mockResolvedValue(
        new Response(" ".repeat(MAX_DASHBOARD_RESPONSE_BYTES + 1), {
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    await expect(oversized.listGlobalConfigurationAudit()).rejects.toBeInstanceOf(
      ReviewControlResponseTooLargeError,
    );
  });
});

describe("configuration audit request validation", () => {
  it.each([undefined, null, 123, {}, []])(
    "rejects non-string repository scopes %j before fetch",
    async (value) => {
      const { adapter, fetch } = adapterWith({});
      const id = value as unknown as string;
      await expect(adapter.listRepositoryConfigurationAudit(id)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(
        adapter.getRepositoryConfigurationAudit(id, "repository", base.id),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(
        adapter.getRepositoryConfigurationAudit(id, "prompt", base.id),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "../other",
    "repo/other",
    "repo%2Fother",
    "repo?x=1",
    "repo#x",
    "repo\n",
    "repo\0",
    "a".repeat(129),
    "\ud800",
  ])("rejects unsafe identifiers %j before fetch", async (id) => {
    const { adapter, fetch } = adapterWith({});
    await expect(adapter.listRepositoryConfigurationAudit(id)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.getRepositoryConfigurationAudit(repositoryId, "repository", id),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getRepositoryConfigurationAudit(id, "repository", base.id),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.listGlobalConfigurationAudit({ templateId: id })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.getGlobalConfigurationAudit(id)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: 10_000_001 },
    { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 0 },
    { pageSize: 21 },
    { pageSize: 1.5 },
    { pageSize: "20" },
    { page: undefined },
    { actor },
    { source: "prompt" },
    { templateId },
  ])("rejects malformed repository query %j before fetch", async (query) => {
    const { adapter, fetch } = adapterWith({});
    await expect(
      adapter.listRepositoryConfigurationAudit(repositoryId, query as ConfigurationAuditPageQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { actor },
    { repositoryId },
    { templateId: undefined },
    { page: 10_000_001 },
    { pageSize: 21 },
  ])("rejects malformed global query %j before fetch", async (query) => {
    const { adapter, fetch } = adapterWith({});
    await expect(
      adapter.listGlobalConfigurationAudit(query as GlobalConfigurationAuditQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid sources and expected summary scopes before fetch", async () => {
    const { adapter, fetch } = adapterWith({});
    await expect(
      adapter.getRepositoryConfigurationAudit(
        repositoryId,
        "repository/other" as ConfigurationAuditSource,
        base.id,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getRepositoryConfigurationAudit(
        repositoryId,
        "repository",
        base.id,
        summary(boundEvent),
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.getGlobalConfigurationAudit(base.id, summary(repositoryEvent)),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("configuration audit list validation", () => {
  it("accepts empty and final pages, including pages beyond the recorded total", async () => {
    await expect(
      adapterWith(repositoryPage([])).adapter.listRepositoryConfigurationAudit(repositoryId),
    ).resolves.toMatchObject({ total: 0, items: [] });
    const final = repositoryPage([summary(repositoryEvent)], { page: 2, pageSize: 1, total: 2 });
    await expect(
      adapterWith(final).adapter.listRepositoryConfigurationAudit(repositoryId, {
        page: 2,
        pageSize: 1,
      }),
    ).resolves.toEqual(final);
    const beyond = globalPage([], { page: 10_000_000, total: 1 });
    await expect(
      adapterWith(beyond).adapter.listGlobalConfigurationAudit({ page: 10_000_000 }),
    ).resolves.toEqual(beyond);
  });

  it("accepts colliding IDs across sources and binary descending ID ordering", async () => {
    const items = [
      { ...summary(boundEvent), id: "audit:a" },
      { ...summary(boundEvent), id: "audit:Z" },
      { ...summary(repositoryEvent), id: "audit:a" },
      { ...summary(repositoryEvent), id: "audit:Z" },
    ];
    expect([...items].sort(compareConfigurationAuditSummaries)).toEqual(items);
    await expect(
      adapterWith(repositoryPage(items)).adapter.listRepositoryConfigurationAudit(repositoryId),
    ).resolves.toMatchObject({ items });
  });

  it.each([
    { repositoryId: "other" },
    { page: 2 },
    { pageSize: 1 },
    { total: 0 },
    { total: 2 },
    { total: -1 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { extra: true },
    { items: [{ ...summary(repositoryEvent), repositoryId: "other", entityId: "other" }] },
    { items: [{ ...summary(repositoryEvent), entityId: "other" }] },
    { items: [summary(repositoryEvent), summary(repositoryEvent)], total: 2 },
    { items: [summary(repositoryEvent), summary(boundEvent)], total: 2 },
    {
      items: [
        summary(repositoryEvent),
        { ...summary(repositoryEvent), id: "audit:newer", createdAt: "2026-09-07T09:00:00.000Z" },
      ],
      total: 2,
    },
    {
      items: [
        { ...summary(repositoryEvent), id: "audit:A" },
        { ...summary(repositoryEvent), id: "audit:a" },
      ],
      total: 2,
    },
    { items: [repositoryEvent] },
  ])("rejects inconsistent repository list metadata %j", async (overrides) => {
    await expect(
      adapterWith({
        ...repositoryPage([summary(repositoryEvent)]),
        ...overrides,
      }).adapter.listRepositoryConfigurationAudit(repositoryId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { items: [summary(repositoryEvent)] },
    { items: [summary(boundEvent)] },
    { templateId: "other" },
    { repositoryId: null },
    { items: [{ ...summary(templateEvent), version: 2 }] },
    { items: [{ ...summary(draftEvent), version: 1 }] },
    { items: [{ ...summary(publishedEvent), version: 1 }] },
    { items: [{ ...summary(bootstrapEvent), entityId: "unknown-workflow" }] },
  ])("rejects inconsistent global history %j", async (overrides) => {
    await expect(
      adapterWith({
        ...globalPage([summary(templateEvent)]),
        ...overrides,
      }).adapter.listGlobalConfigurationAudit(),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("checks template scope while retaining binding and bootstrap rows with other entity IDs", async () => {
    const items = [
      { ...summary(templateEvent), id: "audit:three" },
      { ...summary({ ...boundEvent, repositoryId: null }), id: "audit:two" },
      { ...summary(bootstrapEvent), id: "audit:one" },
    ].sort(compareConfigurationAuditSummaries);
    const filtered = globalPage(items, { templateId });
    await expect(
      adapterWith(filtered).adapter.listGlobalConfigurationAudit({ templateId }),
    ).resolves.toEqual(filtered);
    await expect(
      adapterWith(globalPage([summary(templateEvent)])).adapter.listGlobalConfigurationAudit({
        templateId,
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(
        globalPage([{ ...summary(templateEvent), entityId: "other" }], { templateId }),
      ).adapter.listGlobalConfigurationAudit({ templateId }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});

describe("configuration audit detail validation", () => {
  it("accepts recorded repository snapshots when the clock moved backwards after creation", async () => {
    const event = {
      ...repositoryEvent,
      snapshot: { ...repository, createdAt: "2026-09-08T08:00:00.000Z" },
    };
    await expect(read(adapterWith(event).adapter, event)).resolves.toEqual(event);
  });

  it.each(events)("accepts immutable $source / $action event snapshots", async (event) => {
    await expect(read(adapterWith(event).adapter, event)).resolves.toEqual(event);
    expect(configurationAuditEventMatches(event, summary(event))).toBe(true);
  });

  it.each([
    { id: "other" },
    { entityId: "other" },
    { repositoryId: "other" },
    { version: 3 },
    { action: "created" },
    { createdAt: "2026-09-07T09:00:00.000Z" },
    { actor: { ...actor, subject: "operator-a" } },
    { actor: { ...actor, issuer: actor.issuer.toLowerCase() } },
    { extra: true },
    { snapshot: { ...repository, id: "other" } },
    { snapshot: { ...repository, version: 3 } },
    { snapshot: { ...repository, updatedAt: "2026-09-07T09:00:00.000Z" } },
    { snapshot: { ...repository, reviewerGithubLogin: "reviewer" } },
    { snapshot: { ...repository, reviewerGithubUserId: 123, reviewerGithubLogin: "bad login" } },
    { snapshot: { ...repository, extra: true } },
    { snapshot: { ...repository, schedulingLimits: { maxActiveLeases: 0, maxQueuedJobs: null } } },
    { snapshot: { ...repository, schedulingLimits: { maxActiveLeases: null } } },
    { snapshot: { ...repository, schedulingLimits: null } },
    { snapshot: null },
  ])("rejects repository detail identity and snapshot drift %j", async (overrides) => {
    await expect(
      read(adapterWith({ ...repositoryEvent, ...overrides }).adapter, repositoryEvent),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { createdAt: "2026-02-30T08:00:00.000Z" },
    { createdAt: "2026-09-07T24:00:00.000Z" },
    { createdAt: `${createdAt}\n` },
    { id: "audit\n" },
    { actor: { ...actor, subject: " operator" } },
    { actor: { ...actor, issuer: "issuer\n" } },
    { actor: { ...actor, subject: "\ud800" } },
    { actor: { ...actor, displayName: "Administrator" } },
    { version: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed wire values %j", async (overrides) => {
    await expect(
      adapterWith({ ...templateEvent, ...overrides }).adapter.getGlobalConfigurationAudit(base.id),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { ...draftEvent, snapshot: { version: 3, draftRevision: 1 } },
    { ...draftEvent, snapshot: { version: 3, draftRevision: 4 } },
    { ...draftEvent, snapshot: { version: 2, draftRevision: 2 } },
    { ...publishedEvent, snapshot: { ...publishedEvent.snapshot, publishedVersion: 4 } },
    {
      ...boundEvent,
      snapshot: { ...boundEvent.snapshot, previousVersionId: "prompt-version:old" },
    },
    { ...profileBoundEvent, snapshot: { ...profileBoundEvent.snapshot, previousVersionId: null } },
    { ...profileEvent, snapshot: { ...profileEvent.snapshot, version: 2 } },
    { ...templateEvent, snapshot: { ...templateEvent.snapshot, draftContent: "Mutable content" } },
    { ...bootstrapEvent, version: 1 },
  ])("rejects contradictory or fabricated $action snapshots", async (value) => {
    const event = events.find((candidate) => candidate.action === value.action);
    if (event === undefined) throw new Error("The fixture must have a matching event.");
    await expect(read(adapterWith(value).adapter, event)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("permits binding rollback and repeated binding targets", async () => {
    const repeated = {
      ...boundEvent,
      version: 2,
      snapshot: {
        ...boundEvent.snapshot,
        version: 2,
        previousVersionId: boundEvent.snapshot.promptVersionId,
      },
    };
    await expect(read(adapterWith(repeated).adapter, repeated)).resolves.toEqual(repeated);
    await expect(read(adapterWith(profileBoundEvent).adapter, profileBoundEvent)).resolves.toEqual(
      profileBoundEvent,
    );
  });

  it("does not accept a global event as repository detail or a repository event as global detail", async () => {
    await expect(
      adapterWith(templateEvent).adapter.getRepositoryConfigurationAudit(
        repositoryId,
        "prompt",
        base.id,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(boundEvent).adapter.getGlobalConfigurationAudit(base.id),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(null).adapter.getGlobalConfigurationAudit(base.id),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("freezes the expected summary identity before transport awaits", async () => {
    let finish: ((value: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const adapter = new HttpConfigurationAuditAdapter({ fetch });
    const expected = structuredClone(summary(templateEvent));
    const pending = adapter.getGlobalConfigurationAudit(base.id, expected);
    expected.actor.subject = "Changed after request";
    finish?.(response(templateEvent));
    await expect(pending).resolves.toEqual(templateEvent);
  });

  it("does not replace a not-found detail with current configuration", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({}, 404));
    await expect(
      new HttpConfigurationAuditAdapter({ fetch }).getGlobalConfigurationAudit(base.id),
    ).rejects.toBeInstanceOf(ReviewControlHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
