import type {
  OperatorAccessContext,
  OperatorPrincipal,
  RepositoryAccessAudit,
  RepositoryAccessChangeRequest,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import { DashboardHttpClient } from "../review-control/http-client";
import type { AccessPageQuery } from "./adapter";
import { HttpAccessAdapter } from "./http-adapter";

const repositoryId = "repo-one";
const principal: OperatorPrincipal = {
  issuer: "https://Identity.example/Issuer",
  subject: "Operator-A",
};
const actor: OperatorPrincipal = {
  issuer: "https://identity.example/Issuer",
  subject: "Administrator-A",
};
const timestamp = "2026-09-07T08:00:00.000Z";
const grant: RepositoryAccessGrant = {
  repositoryId,
  principal,
  role: "reviewer",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  updatedBy: actor,
};
const request: RepositoryAccessChangeRequest = {
  changeId: "change-one",
  principal,
  role: "reviewer",
  expectedVersion: 0,
  reason: "Allow review triage",
};
const audit: RepositoryAccessAudit = {
  id: "audit-one",
  repositoryId,
  changeId: request.changeId,
  principal,
  actor,
  previousRole: null,
  role: "reviewer",
  previousVersion: 0,
  version: 1,
  reason: request.reason,
  createdAt: timestamp,
};
const context: OperatorAccessContext = {
  principal: actor,
  platformAdministrator: true,
  repository: {
    repositoryId,
    role: "admin",
    source: "platform",
    permissions: ["read", "review", "configure", "manage_access"],
  },
};
const page = <T>(items: T[], total = items.length) => ({
  repositoryId,
  page: 1,
  pageSize: 20,
  total,
  items,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const adapterWith = (value: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
  return { adapter: new HttpAccessAdapter({ fetch }), fetch };
};

describe("access HTTP path allowlist", () => {
  const accessPath = `/api/v1/operator/repositories/${repositoryId}/access`;

  it.each([
    "/api/v1/operator/access?",
    "/api/v1/operator/access?repositoryId=",
    "/api/v1/operator/access?repositoryId=repo-one&repositoryId=repo-two",
    "/api/v1/operator/access?repositoryId=repo-one&actor=admin",
    "/api/v1/operator/access?repositoryId=repo-one%0A",
    "/api/v1/operator/access?repositoryId=repo-one%00",
    "/api/v1/operator/access?repositoryId=repo%2Fother",
    "/api/v1/operator/access?repositoryId=repo%252Fother",
    "/api/v1/operator/access?repositoryId=%72epo-one",
    "/api/v1/operator/access?repositoryId=repo-one#fragment",
    "/api/v1/operator/access?principal=admin",
    "/api/v1/operator/access/",
    "/api/v1/operator/access\n",
    "https://outside.example/api/v1/operator/access",
    "//outside.example/api/v1/operator/access",
    accessPath,
    `${accessPath}/history`,
    `${accessPath}?page=1`,
    `${accessPath}?pageSize=20&page=1`,
    `${accessPath}?page=01&pageSize=20`,
    `${accessPath}?page=0&pageSize=20`,
    `${accessPath}?page=1.0&pageSize=20`,
    `${accessPath}?page=1&pageSize=51`,
    `${accessPath}?page=1&pageSize=0`,
    `${accessPath}?page=1&pageSize=20&page=2`,
    `${accessPath}?page=1&pageSize=20&sort=subject`,
    `${accessPath}?page=9007199254740991&pageSize=50`,
    `${accessPath}?page=1&pageSize=20\n`,
    `${accessPath}/history?page=1&pageSize=20&principal=admin`,
    "/api/v1/operator/repositories/repo%2Fother/access?page=1&pageSize=20",
    "/api/v1/operator/repositories/../access?page=1&pageSize=20",
    "/api/v1/operator/repositories/repo\\other/access?page=1&pageSize=20",
  ])("rejects noncanonical access reads before fetch: %s", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(path, "read access")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/operator/access",
    "/api/v1/operator/access?repositoryId=repo-one",
    `${accessPath}?page=1&pageSize=20`,
    `${accessPath}/history`,
    `${accessPath}/revoke`,
    `${accessPath}/`,
    `${accessPath}\n`,
    `${accessPath}#fragment`,
  ])("rejects noncanonical access mutations before fetch: %s", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.post(path, "change access", request)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported mutation methods on the access endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.patch(accessPath, "change access", request)).rejects.toThrow();
    await expect(client.put(accessPath, "change access", request)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("access HTTP transport and requests", () => {
  it("uses the authenticated same-origin client for every operation and never sends an actor", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ ...context, repository: null }))
      .mockResolvedValueOnce(response(context))
      .mockResolvedValueOnce(response(page([grant])))
      .mockResolvedValueOnce(response(page([audit])))
      .mockResolvedValueOnce(response({ change: audit, replayed: false }));
    const adapter = new HttpAccessAdapter({ fetch });
    expect(adapter.mode).toBe("connected");
    await expect(adapter.context()).resolves.toEqual({ ...context, repository: null });
    await expect(adapter.context(repositoryId)).resolves.toEqual(context);
    await expect(adapter.list(repositoryId)).resolves.toEqual(page([grant]));
    await expect(adapter.history(repositoryId)).resolves.toEqual(page([audit]));
    await expect(adapter.change(repositoryId, request)).resolves.toEqual({
      change: audit,
      replayed: false,
    });
    expect(fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body])).toEqual(
      [
        ["/api/v1/operator/access", "GET", undefined],
        [`/api/v1/operator/access?repositoryId=${repositoryId}`, "GET", undefined],
        [
          `/api/v1/operator/repositories/${repositoryId}/access?page=1&pageSize=20`,
          "GET",
          undefined,
        ],
        [
          `/api/v1/operator/repositories/${repositoryId}/access/history?page=1&pageSize=20`,
          "GET",
          undefined,
        ],
        [`/api/v1/operator/repositories/${repositoryId}/access`, "POST", JSON.stringify(request)],
      ],
    );
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        cache: "no-store",
        credentials: "include",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("encodes a colon-bearing repository ID only as the context query value", async () => {
    const id = "repository:one";
    const { adapter, fetch } = adapterWith({
      ...context,
      repository: { ...context.repository, repositoryId: id },
    });
    await adapter.context(id);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/operator/access?repositoryId=repository%3Aone");
  });

  it.each([
    "",
    " repo",
    "repo ",
    "../other",
    "repo/other",
    "repo%2Fother",
    "repo?x=1",
    "repo#x",
    "repo\n",
    "a".repeat(129),
    "repo\0",
    "\ud800",
  ])("rejects unsafe repository scope %j before transport", async (id) => {
    const { adapter, fetch } = adapterWith({});
    await expect(adapter.context(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.list(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.history(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.change(id, request)).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: NaN },
    { page: Infinity },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { pageSize: "20" },
    { page: undefined },
    { pageSize: undefined },
    { sort: "subject" },
    { actor },
    null,
  ])("rejects malformed access pagination %j", async (query) => {
    const { adapter, fetch } = adapterWith({});
    await expect(adapter.list(repositoryId, query as AccessPageQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.history(repositoryId, query as AccessPageQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " leading",
    "trailing ",
    "\tname",
    "name\n",
    "name\0",
    "name\u001f",
    "name\u007f",
    "\ud800",
    "\udfff",
  ])("rejects noncanonical principal components %j without normalization", async (part) => {
    const { adapter, fetch } = adapterWith({});
    for (const field of ["issuer", "subject"] as const)
      await expect(
        adapter.change(repositoryId, { ...request, principal: { ...principal, [field]: part } }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, actor },
    { ...request, platformAdministrator: true },
    { ...request, repositoryId },
    { ...request, principal: { ...principal, email: "operator@example.test" } },
    { ...request, changeId: "change\n" },
    { ...request, changeId: "" },
    { ...request, role: "owner" },
    { ...request, role: undefined },
    { ...request, expectedVersion: -1 },
    { ...request, expectedVersion: 0.5 },
    { ...request, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, reason: " " },
    { ...request, reason: "\0" },
    { ...request, reason: "\ud800" },
    { ...request, reason: "a".repeat(2049) },
    { ...request, principal: { ...principal, issuer: "a".repeat(2049) } },
    { ...request, principal: { ...principal, subject: "a".repeat(513) } },
  ])("rejects invalid changes and server-owned fields %j", async (input) => {
    const { adapter, fetch } = adapterWith({});
    await expect(
      adapter.change(repositoryId, input as RepositoryAccessChangeRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves case, Unicode, whitespace inside identities, and reason text exactly", async () => {
    const exact = { issuer: "https://IDENTITY.example/Issuer", subject: "User 東京 A" };
    const input = { ...request, principal: exact, reason: "  Investigation\nrequires review  " };
    const receipt = { ...audit, principal: exact, reason: input.reason };
    const { adapter, fetch } = adapterWith({ change: receipt, replayed: false });
    await expect(adapter.change(repositoryId, input)).resolves.toEqual({
      change: receipt,
      replayed: false,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });

  it.each([401, 403, 404, 409, 500])(
    "preserves server failures (%i) without a sample fallback",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          response(
            { code: "PLATFORM_FORBIDDEN", message: "The request was rejected.", retryable: false },
            status,
          ),
        );
      const adapter = new HttpAccessAdapter({ fetch });
      for (const action of [
        () => adapter.context(repositoryId),
        () => adapter.list(repositoryId),
        () => adapter.history(repositoryId),
        () => adapter.change(repositoryId, request),
      ]) {
        await expect(action()).rejects.toBeInstanceOf(ReviewControlHttpError);
        await expect(action()).rejects.toMatchObject({ status });
      }
      expect(adapter.mode).toBe("connected");
    },
  );

  it("propagates a network failure instead of synthesizing access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(new HttpAccessAdapter({ fetch }).context()).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
  });

  it("rejects invalid UTF-8 response bytes through the shared transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(new HttpAccessAdapter({ fetch }).context()).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
});

describe("access context response invariants", () => {
  it.each([
    { ...context, principal: undefined },
    { ...context, principal: { ...actor, subject: " actor" } },
    { ...context, principal: { ...actor, issuer: "\ud800" } },
    { ...context, actor },
    { ...context, platformAdministrator: "true" },
    { ...context, repository: null },
    { ...context, repository: { ...context.repository, repositoryId: "repo-other" } },
    { ...context, repository: { ...context.repository, role: "maintainer" } },
    { ...context, repository: { ...context.repository, source: "repository" } },
    { ...context, platformAdministrator: false },
    { ...context, repository: { ...context.repository, permissions: ["read"] } },
    {
      ...context,
      repository: {
        ...context.repository,
        permissions: ["read", "review", "configure", "configure"],
      },
    },
    {
      ...context,
      repository: { ...context.repository, permissions: ["read", "review", "configure", "delete"] },
    },
    { ...context, repository: { ...context.repository, token: "unexpected" } },
  ])("rejects an inconsistent scoped context %j", async (value) => {
    await expect(adapterWith(value).adapter.context(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("requires an unscoped context to omit repository access", async () => {
    await expect(adapterWith(context).adapter.context()).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(
      adapterWith({ ...context, platformAdministrator: false, repository: null }).adapter.context(),
    ).resolves.toMatchObject({ platformAdministrator: false, repository: null });
  });

  it.each([
    ["viewer", ["read"]],
    ["reviewer", ["review", "read"]],
    ["maintainer", ["configure", "read", "review"]],
    ["admin", ["manage_access", "configure", "review", "read"]],
  ])("accepts the exact permission set for repository role %s", async (role, permissions) => {
    const value = {
      ...context,
      platformAdministrator: false,
      repository: { repositoryId, role, source: "repository", permissions },
    };
    await expect(adapterWith(value).adapter.context(repositoryId)).resolves.toEqual(value);
  });

  it.each(["viewer", "reviewer", "maintainer"])(
    "rejects an elevated permission set for %s",
    async (role) => {
      const value = {
        ...context,
        platformAdministrator: false,
        repository: { ...context.repository, role, source: "repository" },
      };
      await expect(adapterWith(value).adapter.context(repositoryId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );
});

describe("access page response invariants", () => {
  it.each(["repositoryId", "principal", "role", "version", "createdAt", "updatedAt", "updatedBy"])(
    "requires the complete grant field %s",
    async (field) => {
      const value: Record<string, unknown> = { ...grant };
      delete value[field];
      await expect(adapterWith(page([value])).adapter.list(repositoryId)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it.each([
    { ...grant, repositoryId: "other" },
    { ...grant, role: "owner" },
    { ...grant, version: 0 },
    { ...grant, version: 1.5 },
    { ...grant, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...grant, createdAt: "yesterday" },
    { ...grant, createdAt: "2026-02-30T08:00:00.000Z" },
    { ...grant, createdAt: "2026-09-06T24:00:00.000Z" },
    { ...grant, updatedAt: "2026-09-06T08:00:00.000Z" },
    { ...grant, updatedBy: { ...actor, issuer: "issuer\0" } },
    { ...grant, principal: { ...principal, subject: "\ud800" } },
    { ...grant, permissions: ["read"] },
  ])("rejects malformed or inconsistent grants %j", async (value) => {
    await expect(adapterWith(page([value])).adapter.list(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { repositoryId: "other" },
    { page: 2 },
    { pageSize: 50 },
    { total: 0 },
    { total: 2 },
    { total: -1 },
    { total: 1.5 },
    { extra: true },
    { page: undefined },
    { items: [] },
    { items: [grant, grant], total: 2 },
  ])("rejects inconsistent pagination or duplicate grants %j", async (patch) => {
    await expect(
      adapterWith({ ...page([grant]), ...patch }).adapter.list(repositoryId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("keeps case-distinct identity pairs and tombstones, and returns empty pages past the end", async () => {
    const values = [
      grant,
      {
        ...grant,
        principal: { ...principal, subject: principal.subject.toLowerCase() },
        role: null,
      },
      { ...grant, principal: { ...principal, issuer: principal.issuer.toLowerCase() } },
    ];
    await expect(adapterWith(page(values)).adapter.list(repositoryId)).resolves.toEqual(
      page(values),
    );
    const { adapter } = adapterWith({ ...page([], 3), page: 2, pageSize: 50 });
    await expect(adapter.list(repositoryId, { page: 2, pageSize: 50 })).resolves.toMatchObject({
      total: 3,
      items: [],
    });
  });

  it.each([
    "id",
    "repositoryId",
    "changeId",
    "principal",
    "actor",
    "previousRole",
    "role",
    "previousVersion",
    "version",
    "reason",
    "createdAt",
  ])("requires the complete audit field %s", async (field) => {
    const value: Record<string, unknown> = { ...audit };
    delete value[field];
    await expect(adapterWith(page([value])).adapter.history(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { ...audit, repositoryId: "other" },
    { ...audit, id: "audit\n" },
    { ...audit, changeId: "bad/id" },
    { ...audit, actor: { ...actor, subject: " actor" } },
    { ...audit, previousRole: "reviewer" },
    { ...audit, previousVersion: 1 },
    { ...audit, version: 2 },
    { ...audit, version: 0 },
    { ...audit, previousVersion: Number.MAX_SAFE_INTEGER, version: Number.MAX_SAFE_INTEGER },
    { ...audit, reason: "\0" },
    { ...audit, createdAt: "not a timestamp" },
    { ...audit, role: "owner" },
    { ...audit, liveGrant: grant },
  ])("rejects malformed or inconsistent audit entries %j", async (value) => {
    await expect(adapterWith(page([value])).adapter.history(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    [{ ...audit, id: "audit-two", changeId: "change-two" }, audit],
    [{ ...audit, id: "audit-two", principal: actor }, audit],
    [{ ...audit, changeId: "change-two", principal: actor }, audit],
    [
      {
        ...audit,
        id: "audit-two",
        changeId: "change-two",
        previousRole: "viewer",
        previousVersion: 1,
        version: 2,
      },
      audit,
    ],
    [
      {
        ...audit,
        id: "audit-two",
        changeId: "change-two",
        previousRole: "reviewer",
        previousVersion: 1,
        version: 2,
        createdAt: "2026-09-06T08:00:00.000Z",
      },
      audit,
    ],
  ])("rejects duplicate receipts and impossible per-principal history %j", async (...items) => {
    await expect(adapterWith(page(items)).adapter.history(repositoryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("accepts tied timestamps, interleaved principals, and nonconsecutive versions on a partial page", async () => {
    const second = {
      ...audit,
      id: "audit-two",
      changeId: "change-two",
      previousRole: "reviewer",
      role: null,
      previousVersion: 1,
      version: 2,
    };
    const fourth = {
      ...audit,
      id: "audit-four",
      changeId: "change-four",
      previousRole: null,
      previousVersion: 3,
      version: 4,
    };
    const other = { ...audit, id: "audit-other", changeId: "change-other", principal: actor };
    const items = [audit, fourth, other, second];
    await expect(
      adapterWith({ ...page(items, 6), pageSize: 4 }).adapter.history(repositoryId, {
        pageSize: 4,
      }),
    ).resolves.toMatchObject({ items });
  });
});

describe("access mutation receipts", () => {
  it.each([
    { repositoryId: "other" },
    { changeId: "other" },
    { principal: { ...principal, issuer: principal.issuer.toLowerCase() } },
    { principal: { ...principal, subject: principal.subject.toLowerCase() } },
    { role: "admin" },
    { previousVersion: 1, version: 2, previousRole: "reviewer" },
    { version: 2 },
    { reason: `${request.reason} ` },
    { actor: { ...actor, subject: "\ud800" } },
  ])("rejects a receipt that does not match the accepted change %j", async (patch) => {
    await expect(
      adapterWith({ change: { ...audit, ...patch }, replayed: false }).adapter.change(
        repositoryId,
        request,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { change: audit },
    { change: audit, replayed: "true" },
    { change: audit, replayed: false, grant },
    { grant, replayed: false },
  ])("requires a strict immutable receipt response %j", async (value) => {
    await expect(adapterWith(value).adapter.change(repositoryId, request)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("returns the original replay receipt after a later revocation without treating it as current access", async () => {
    const tombstone = { ...grant, role: null, version: 2 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ change: audit, replayed: false }))
      .mockResolvedValueOnce(response(page([tombstone])))
      .mockResolvedValueOnce(response({ change: audit, replayed: true }));
    const adapter = new HttpAccessAdapter({ fetch });
    await adapter.change(repositoryId, request);
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({ items: [tombstone] });
    await expect(adapter.change(repositoryId, request)).resolves.toEqual({
      change: audit,
      replayed: true,
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toEqual(fetch.mock.calls[2]?.[1]?.body);
  });

  it("matches an in-flight response against the submitted snapshot even if the caller edits its draft", async () => {
    const input = structuredClone(request);
    let complete: ((value: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const adapter = new HttpAccessAdapter({ fetch });
    const pending = adapter.change(repositoryId, input);
    input.reason = "Edited while waiting";
    input.principal.subject = "Another principal";
    if (!complete) throw new Error("The HTTP request did not start.");
    complete(response({ change: audit, replayed: false }));
    await expect(pending).resolves.toEqual({ change: audit, replayed: false });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(request);
  });

  it("accepts a first-write tombstone and a later regrant from a tombstone", async () => {
    for (const expectedVersion of [0, 4]) {
      const input = {
        ...request,
        role: expectedVersion === 0 ? null : "admin",
        expectedVersion,
      } as RepositoryAccessChangeRequest;
      const value = {
        change: {
          ...audit,
          previousVersion: expectedVersion,
          version: expectedVersion + 1,
          previousRole: null,
          role: input.role,
        },
        replayed: false,
      };
      await expect(adapterWith(value).adapter.change(repositoryId, input)).resolves.toEqual(value);
    }
  });
});
