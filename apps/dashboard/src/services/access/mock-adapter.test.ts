import type {
  OperatorPrincipal,
  RepositoryAccessChangeRequest,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ReviewControlRequestError } from "../review-control/errors";
import { MockAccessAdapter, sampleOperatorPrincipal } from "./mock-adapter";

const repositoryId = "repo-powertoys";
const principal: OperatorPrincipal = { issuer: "https://Identity.example", subject: "Reviewer-A" };
const timestamp = "2026-09-07T08:00:00.000Z";
const request: RepositoryAccessChangeRequest = {
  changeId: "change-one",
  principal,
  role: "reviewer",
  expectedVersion: 0,
  reason: "Investigate validation results",
};
const grant = (
  identity: OperatorPrincipal = principal,
  role: RepositoryAccessGrant["role"] = "admin",
  version = 1,
): RepositoryAccessGrant => ({
  repositoryId,
  principal: identity,
  role,
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  updatedBy: sampleOperatorPrincipal,
});
const now = () => new Date(timestamp);

describe("explicit sample access", () => {
  it("defaults to a platform administrator and fixed sample repository scopes", async () => {
    const adapter = new MockAccessAdapter({ now });
    expect(adapter.mode).toBe("sample");
    await expect(adapter.context()).resolves.toEqual({
      principal: sampleOperatorPrincipal,
      platformAdministrator: true,
      repository: null,
    });
    await expect(adapter.context(repositoryId)).resolves.toMatchObject({
      repository: {
        repositoryId,
        role: "admin",
        source: "platform",
        permissions: ["read", "review", "configure", "manage_access"],
      },
    });
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({
      page: 1,
      pageSize: 20,
      total: 0,
      items: [],
    });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({ total: 0, items: [] });
    await expect(adapter.context("repo-unknown")).rejects.toMatchObject({ status: 404 });
  });

  it("preserves an explicitly configured fixed repository scope", async () => {
    const adapter = new MockAccessAdapter({ repositoryIds: ["repo-custom"], now });
    await expect(adapter.context("repo-custom")).resolves.toMatchObject({
      repository: { repositoryId: "repo-custom" },
    });
    await expect(adapter.context(repositoryId)).rejects.toMatchObject({ status: 404 });
    expect(
      () => new MockAccessAdapter({ repositoryIds: [], repositoryExists: async () => true }),
    ).toThrow(ReviewControlRequestError);
  });

  it("snapshots mutations before an asynchronous scope lookup and preserves concurrent CAS", async () => {
    let finishLookup: (() => void) | undefined;
    const lookup = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const adapter = new MockAccessAdapter({
      repositoryExists: async (id) => {
        await lookup;
        return id === "repo-created";
      },
      now,
    });
    const input = structuredClone(request);
    const first = adapter.change("repo-created", input);
    const second = adapter.change("repo-created", {
      ...request,
      changeId: "competing-change",
      role: "admin",
    });
    input.principal.subject = "Edited while waiting";
    input.reason = "Changed draft";
    if (!finishLookup) throw new Error("The lookup gate did not initialize.");
    finishLookup();
    await expect(first).resolves.toMatchObject({
      change: { principal, reason: request.reason, version: 1 },
    });
    await expect(second).rejects.toMatchObject({ status: 409 });
    await expect(adapter.list("repo-created")).resolves.toMatchObject({
      total: 1,
      items: [{ principal, role: "reviewer", version: 1 }],
    });
    await expect(adapter.history("repo-created")).resolves.toMatchObject({ total: 1 });
    await expect(adapter.context(repositoryId)).rejects.toMatchObject({ status: 404 });
  });

  it("creates, revokes, and regrants through the tombstone version", async () => {
    const adapter = new MockAccessAdapter({ now });
    const first = await adapter.change(repositoryId, request);
    expect(first.replayed).toBe(false);
    expect(first.change).toMatchObject({
      principal,
      actor: sampleOperatorPrincipal,
      previousRole: null,
      role: "reviewer",
      previousVersion: 0,
      version: 1,
    });
    const revoke = { ...request, changeId: "change-two", role: null, expectedVersion: 1 };
    await expect(adapter.change(repositoryId, revoke)).resolves.toMatchObject({
      change: { previousRole: "reviewer", role: null, previousVersion: 1, version: 2 },
    });
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({
      total: 1,
      items: [{ role: null, version: 2 }],
    });
    await expect(
      adapter.change(repositoryId, { ...request, changeId: "stale", expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adapter.change(repositoryId, {
        ...request,
        changeId: "change-three",
        expectedVersion: 2,
        role: "maintainer",
      }),
    ).resolves.toMatchObject({
      change: { previousRole: null, role: "maintainer", previousVersion: 2, version: 3 },
    });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({ total: 3 });
  });

  it("keeps the original receipt after later changes and detects an idempotency-key collision", async () => {
    const adapter = new MockAccessAdapter({ now });
    const first = await adapter.change(repositoryId, request);
    await adapter.change(repositoryId, {
      ...request,
      changeId: "revoke",
      role: null,
      expectedVersion: 1,
    });
    await expect(adapter.change(repositoryId, structuredClone(request))).resolves.toEqual({
      ...first,
      replayed: true,
    });
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({
      items: [{ role: null, version: 2 }],
    });
    for (const patch of [
      { principal: { ...principal, subject: "reviewer-a" } },
      { role: "admin" },
      { expectedVersion: 1 },
      { reason: `${request.reason} ` },
    ])
      await expect(
        adapter.change(repositoryId, { ...request, ...patch } as RepositoryAccessChangeRequest),
      ).rejects.toMatchObject({ status: 409 });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({ total: 2 });
  });

  it("retains immutable request, grant, context, and audit snapshots", async () => {
    const input = structuredClone(request);
    const identity: OperatorPrincipal = structuredClone(sampleOperatorPrincipal);
    const seed = grant();
    const adapter = new MockAccessAdapter({ principal: identity, grants: [seed], now });
    identity.subject = "changed";
    seed.role = null;
    const accepted = await adapter.change(repositoryId, { ...input, expectedVersion: 1 });
    input.reason = "mutated";
    accepted.change.actor.subject = "changed";
    accepted.change.principal.subject = "changed";
    const listed = await adapter.list(repositoryId);
    if (listed.items[0]) listed.items[0].role = null;
    const history = await adapter.history(repositoryId);
    if (history.items[0]) history.items[0].reason = "changed";
    const context = await adapter.context();
    context.principal.subject = "changed";
    await expect(adapter.context()).resolves.toMatchObject({ principal: sampleOperatorPrincipal });
    await expect(adapter.list(repositoryId)).resolves.toMatchObject({
      items: [{ principal, role: "reviewer", version: 2 }],
    });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({
      items: [{ principal, actor: sampleOperatorPrincipal, reason: request.reason }],
    });
  });

  it("scopes principals by exact issuer and subject without case folding or key collisions", async () => {
    const identities = [
      principal,
      { ...principal, subject: "reviewer-a" },
      { ...principal, issuer: "https://identity.example" },
      { issuer: "a:b", subject: "c" },
      { issuer: "a", subject: "b:c" },
    ];
    const adapter = new MockAccessAdapter({ now });
    for (const [index, identity] of identities.entries())
      await adapter.change(repositoryId, {
        ...request,
        changeId: `change-${index}`,
        principal: identity,
      });
    expect((await adapter.list(repositoryId)).items.map((item) => item.principal)).toEqual([
      { issuer: "a", subject: "b:c" },
      { issuer: "a:b", subject: "c" },
      principal,
      { ...principal, subject: "reviewer-a" },
      { ...principal, issuer: "https://identity.example" },
    ]);
    const noMatch = new MockAccessAdapter({
      principal: { ...principal, subject: "reviewer-a" },
      platformAdministrator: false,
      grants: [grant()],
      now,
    });
    await expect(noMatch.context(repositoryId)).rejects.toMatchObject({ status: 404 });
  });

  it.each(["viewer", "reviewer", "maintainer"] as const)(
    "returns readable %s context while rejecting access administration",
    async (role) => {
      const adapter = new MockAccessAdapter({
        principal,
        platformAdministrator: false,
        grants: [grant(principal, role)],
        now,
      });
      await expect(adapter.context(repositoryId)).resolves.toMatchObject({
        platformAdministrator: false,
        repository: { role, source: "repository" },
      });
      await expect(adapter.list(repositoryId)).rejects.toMatchObject({ status: 403 });
      await expect(adapter.history(repositoryId)).rejects.toMatchObject({ status: 403 });
      await expect(adapter.change(repositoryId, request)).rejects.toMatchObject({ status: 403 });
    },
  );

  it("uses Unicode scalar order for binary identity pagination", async () => {
    const subjects = ["\u{1f600}", "\ue000", "Z", "a"];
    const adapter = new MockAccessAdapter({
      grants: subjects.map((subject) => grant({ ...principal, subject })),
      now,
    });
    expect((await adapter.list(repositoryId)).items.map((item) => item.principal.subject)).toEqual([
      "Z",
      "a",
      "\ue000",
      "\u{1f600}",
    ]);
  });

  it("keeps missing membership, revoked membership, and unknown repositories opaque", async () => {
    for (const grants of [[], [grant(principal, null)]]) {
      const adapter = new MockAccessAdapter({
        principal,
        platformAdministrator: false,
        grants,
        now,
      });
      await expect(adapter.context()).resolves.toMatchObject({
        platformAdministrator: false,
        repository: null,
      });
      await expect(adapter.context(repositoryId)).rejects.toMatchObject({ status: 404 });
      await expect(adapter.list(repositoryId)).rejects.toMatchObject({ status: 404 });
      await expect(adapter.history(repositoryId)).rejects.toMatchObject({ status: 404 });
      await expect(adapter.change(repositoryId, request)).rejects.toMatchObject({ status: 404 });
    }
  });

  it("prevents a repository administrator from removing the last administrator", async () => {
    const adapter = new MockAccessAdapter({
      principal,
      platformAdministrator: false,
      grants: [grant()],
      now,
    });
    for (const role of [null, "maintainer"] as const)
      await expect(
        adapter.change(repositoryId, { ...request, role, expectedVersion: 1 }),
      ).rejects.toMatchObject({ status: 409 });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({ total: 0 });
    const platform = new MockAccessAdapter({ grants: [grant()], now });
    await expect(
      platform.change(repositoryId, { ...request, role: null, expectedVersion: 1 }),
    ).resolves.toMatchObject({ change: { role: null, version: 2 } });
  });

  it("checks current authority before replaying a receipt after self-demotion", async () => {
    const adapter = new MockAccessAdapter({
      principal,
      platformAdministrator: false,
      grants: [grant(), grant({ ...principal, subject: "Other admin" })],
      now,
    });
    const input = { ...request, expectedVersion: 1 };
    await adapter.change(repositoryId, input);
    await expect(adapter.change(repositoryId, input)).rejects.toMatchObject({ status: 403 });
    await expect(adapter.context(repositoryId)).resolves.toMatchObject({
      repository: { role: "reviewer" },
    });
  });

  it("rechecks current authority after the final asynchronous lookup before a concurrent mutation", async () => {
    const adapter = new MockAccessAdapter({
      principal,
      platformAdministrator: false,
      grants: [grant(), grant({ ...principal, subject: "Other administrator" })],
      repositoryExists: async (id) => id === repositoryId,
      now,
    });
    const [demotion, restoration] = await Promise.allSettled([
      adapter.change(repositoryId, {
        ...request,
        changeId: "self-demotion",
        role: "viewer",
        expectedVersion: 1,
      }),
      adapter.change(repositoryId, {
        ...request,
        changeId: "self-restoration",
        role: "admin",
        expectedVersion: 2,
      }),
    ]);
    expect(demotion).toMatchObject({
      status: "fulfilled",
      value: { change: { role: "viewer", version: 2 } },
    });
    expect(restoration).toMatchObject({ status: "rejected", reason: { status: 403 } });
    await expect(adapter.context(repositoryId)).resolves.toMatchObject({
      repository: { role: "viewer" },
    });
  });

  it("permits first-write revocation, same-role changes, and repository-scoped change IDs", async () => {
    const adapter = new MockAccessAdapter({ now });
    await expect(adapter.change(repositoryId, { ...request, role: null })).resolves.toMatchObject({
      change: { previousRole: null, role: null, version: 1 },
    });
    await expect(
      adapter.change(repositoryId, {
        ...request,
        changeId: "same-role",
        role: null,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ change: { previousRole: null, role: null, version: 2 } });
    await expect(adapter.change("repo-terminal", request)).resolves.toMatchObject({
      change: { repositoryId: "repo-terminal", version: 1 },
    });
    await expect(adapter.history(repositoryId)).resolves.toMatchObject({ total: 2 });
    await expect(adapter.history("repo-terminal")).resolves.toMatchObject({ total: 1 });
  });

  it("paginates grants and audit history with tombstones and a stable total", async () => {
    const adapter = new MockAccessAdapter({ now });
    for (let index = 0; index < 23; index += 1)
      await adapter.change(repositoryId, {
        ...request,
        changeId: `change-${index}`,
        principal: { ...principal, subject: `user-${String(index).padStart(2, "0")}` },
        role: index === 0 ? null : "viewer",
      });
    const first = await adapter.list(repositoryId);
    const second = await adapter.list(repositoryId, { page: 2 });
    expect(first).toMatchObject({ total: 23, page: 1, pageSize: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.role).toBeNull();
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.principal.subject)).size,
    ).toBe(23);
    const historyFirst = await adapter.history(repositoryId);
    const historySecond = await adapter.history(repositoryId, { page: 2 });
    expect(
      new Set([...historyFirst.items, ...historySecond.items].map((item) => item.id)).size,
    ).toBe(23);
    expect(historyFirst.items.map((item) => item.id)).toEqual(
      historyFirst.items
        .map((item) => item.id)
        .sort()
        .reverse(),
    );
    await expect(adapter.list(repositoryId, { page: 3 })).resolves.toMatchObject({
      total: 23,
      items: [],
    });
    await expect(adapter.history(repositoryId, { page: 3 })).resolves.toMatchObject({
      total: 23,
      items: [],
    });
  });

  it("prevents version exhaustion and timestamps that move backwards", async () => {
    const exhausted = new MockAccessAdapter({
      grants: [grant(principal, "reviewer", Number.MAX_SAFE_INTEGER)],
      now,
    });
    await expect(
      exhausted.change(repositoryId, { ...request, expectedVersion: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ status: 409 });
    const backwards = new MockAccessAdapter({
      grants: [grant()],
      now: () => new Date("2026-09-06T08:00:00.000Z"),
    });
    await expect(
      backwards.change(repositoryId, { ...request, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(backwards.list(repositoryId)).resolves.toMatchObject({ items: [{ version: 1 }] });
  });

  it.each(["", " leading", "trailing ", "a\0", "\ud800"])(
    "rejects invalid sample principals and mutation principals %j",
    async (part) => {
      expect(() => new MockAccessAdapter({ principal: { ...principal, subject: part } })).toThrow(
        ReviewControlRequestError,
      );
      await expect(
        new MockAccessAdapter().change(repositoryId, {
          ...request,
          principal: { ...principal, issuer: part },
        }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    },
  );

  it("rejects duplicate or unknown seed scopes, malformed seed metadata, and server-owned request fields", async () => {
    for (const grants of [
      [grant(), grant()],
      [{ ...grant(), repositoryId: "unknown" }],
      [{ ...grant(), updatedAt: "2026-09-06T00:00:00.000Z" }],
      [{ ...grant(), updatedBy: { ...principal, subject: "bad\0" } }],
    ])
      expect(() => new MockAccessAdapter({ grants })).toThrow(ReviewControlRequestError);
    const adapter = new MockAccessAdapter();
    await expect(
      adapter.change(repositoryId, {
        ...request,
        actor: principal,
      } as RepositoryAccessChangeRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.list(repositoryId, { pageSize: 51 })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.history(repositoryId, { page: Number.MAX_SAFE_INTEGER, pageSize: 50 }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
  });
});
