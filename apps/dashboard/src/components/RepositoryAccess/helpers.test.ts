import type {
  OperatorAccessContext,
  OperatorPrincipal,
  RepositoryAccessChangeResponse,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
} from "../../services/review-control/errors";
import {
  type AccessChangeDraft,
  accessChangeNotice,
  accessReceiptSummary,
  canManageRepositoryAccess,
  createAccessChangeRegistry,
  expectedAccessVersion,
  isAccessDenied,
  principalKey,
  repositoryAccessQueryKey,
  samePrincipal,
} from "./helpers";

const repositoryId = "repo-1";
const principal = { issuer: "https://identity.example/tenant", subject: "operator-1" };
const target = { issuer: "https://identity.example/tenant", subject: "operator-2" };
const recordedAt = "2026-09-07T00:00:00.000Z";
const draft: AccessChangeDraft = {
  repositoryId,
  principal: target,
  role: "reviewer",
  expectedVersion: 3,
  reason: "Review queue rotation",
};

function context(overrides: Partial<OperatorAccessContext> = {}): OperatorAccessContext {
  return {
    principal,
    platformAdministrator: false,
    repository: {
      repositoryId,
      role: "admin",
      source: "repository",
      permissions: ["read", "review", "configure", "manage_access"],
    },
    ...overrides,
  };
}

function grant(role: RepositoryAccessGrant["role"] = "reviewer"): RepositoryAccessGrant {
  return {
    repositoryId,
    principal: target,
    role,
    version: 4,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    updatedBy: principal,
  };
}

function receipt(replayed = false): RepositoryAccessChangeResponse {
  return {
    replayed,
    change: {
      id: "audit-1",
      repositoryId,
      changeId: "change-1",
      principal: target,
      actor: principal,
      previousRole: "viewer",
      role: "reviewer",
      previousVersion: 3,
      version: 4,
      reason: draft.reason,
      createdAt: recordedAt,
    },
  };
}

function httpError(status: number) {
  return new ReviewControlHttpError("Server error", {
    operation: "change repository access",
    status,
    retryable: false,
  });
}

describe("exact operator identity", () => {
  it("matches only the exact issuer and subject pair", () => {
    expect(samePrincipal(principal, { ...principal })).toBe(true);
  });

  it.each<OperatorPrincipal>([
    { ...principal, issuer: principal.issuer.toUpperCase() },
    { ...principal, issuer: `${principal.issuer}/` },
    { ...principal, subject: principal.subject.toUpperCase() },
    { ...principal, subject: `${principal.subject} ` },
    { ...principal, issuer: "https://different.example/tenant" },
  ])("does not normalize or conflate %j", (other) => {
    expect(samePrincipal(principal, other)).toBe(false);
    expect(principalKey(principal)).not.toBe(principalKey(other));
  });

  it("keeps separators inside issuer and subject unambiguous", () => {
    expect(principalKey({ issuer: "a:b", subject: "c" })).not.toBe(
      principalKey({ issuer: "a", subject: "b:c" }),
    );
  });

  it("isolates data caches by repository, complete identity, and adapter mode", () => {
    const key = repositoryAccessQueryKey("connected", repositoryId, principal);
    expect(key).not.toEqual(repositoryAccessQueryKey("sample", repositoryId, principal));
    expect(key).not.toEqual(repositoryAccessQueryKey("connected", "repo-2", principal));
    expect(key).not.toEqual(
      repositoryAccessQueryKey("connected", repositoryId, { ...principal, issuer: "another" }),
    );
    expect(key).not.toEqual(
      repositoryAccessQueryKey("connected", repositoryId, { ...principal, subject: "another" }),
    );
  });
});

describe("verified management permission", () => {
  it("allows verified repository administrators", () => {
    expect(canManageRepositoryAccess(context(), repositoryId, principal)).toBe(true);
  });

  it("allows runtime administrators without an explicit grant", () => {
    const value = context({ platformAdministrator: true });
    if (value.repository) value.repository.source = "platform";
    expect(canManageRepositoryAccess(value, repositoryId, principal)).toBe(true);
  });

  it.each([undefined, context({ repository: null })])(
    "denies unknown repository permissions",
    (value) => {
      expect(canManageRepositoryAccess(value, repositoryId, principal)).toBe(false);
    },
  );

  it.each(["viewer", "reviewer", "maintainer"] as const)(
    "does not infer management from %s",
    (role) => {
      const value = context();
      if (value.repository) {
        value.repository.role = role;
        value.repository.permissions = ["read"];
      }
      expect(canManageRepositoryAccess(value, repositoryId, principal)).toBe(false);
    },
  );

  it("does not trust the repository role label without its permission", () => {
    const value = context();
    if (value.repository) value.repository.permissions = ["read", "review", "configure"];
    expect(canManageRepositoryAccess(value, repositoryId, principal)).toBe(false);
  });

  it("does not infer runtime authority from a source label", () => {
    const value = context();
    if (value.repository) value.repository.source = "platform";
    expect(canManageRepositoryAccess(value, repositoryId, principal)).toBe(false);
  });

  it("rejects another repository's permissions", () => {
    expect(canManageRepositoryAccess(context(), "repo-2", principal)).toBe(false);
  });

  it("rejects another authenticated identity", () => {
    expect(canManageRepositoryAccess(context(), repositoryId, target)).toBe(false);
  });
});

describe("versioned access changes", () => {
  it("uses version zero only for new identities", () => {
    expect(expectedAccessVersion(null)).toBe(0);
    expect(expectedAccessVersion(grant())).toBe(4);
  });

  it("preserves the tombstone version when restoring revoked access", () => {
    const input = createAccessChangeRegistry(() => "change-1").prepare({
      ...draft,
      expectedVersion: expectedAccessVersion(grant(null)),
    });
    expect(input.expectedVersion).toBe(4);
    expect(input.role).toBe("reviewer");
  });

  it("sends only the change contract and preserves exact values", () => {
    const input = createAccessChangeRegistry(() => "change-1").prepare({
      ...draft,
      principal: { issuer: "Issuer/", subject: " Subject " },
      reason: "  Approved rotation\n",
    });
    expect(input).toEqual({
      changeId: "change-1",
      principal: { issuer: "Issuer/", subject: " Subject " },
      role: "reviewer",
      expectedVersion: 3,
      reason: "  Approved rotation\n",
    });
    expect(input).not.toHaveProperty("actor");
    expect(input).not.toHaveProperty("repositoryId");
  });

  it("uses one immutable intent for retries after an uncertain response", () => {
    const createId = vi.fn(() => "change-1");
    const registry = createAccessChangeRegistry(createId);
    const first = registry.prepare(draft);
    const retry = registry.prepare({ ...draft, principal: { ...target } });
    expect(retry).toEqual(first);
    expect(createId).toHaveBeenCalledTimes(1);
    expect(retry).not.toBe(first);
    expect(retry.principal).not.toBe(first.principal);
  });

  it.each<Partial<AccessChangeDraft>>([
    { repositoryId: "repo-2" },
    { principal: { ...target, issuer: target.issuer.toUpperCase() } },
    { principal: { ...target, subject: target.subject.toUpperCase() } },
    { role: "admin" },
    { role: null },
    { expectedVersion: 4 },
    { reason: `${draft.reason} ` },
  ])("creates a distinct intent when a request field changes: %j", (change) => {
    let id = 0;
    const registry = createAccessChangeRegistry(() => `change-${++id}`);
    const first = registry.prepare(draft);
    expect(registry.prepare({ ...draft, ...change }).changeId).not.toBe(first.changeId);
    expect(registry.prepare(draft).changeId).toBe(first.changeId);
  });

  it("does not let caller mutation alter a retained intent", () => {
    const registry = createAccessChangeRegistry(() => "change-1");
    const first = registry.prepare(draft);
    first.principal.subject = "changed";
    first.reason = "changed";
    expect(registry.prepare(draft)).toMatchObject({ principal: target, reason: draft.reason });
  });

  it("retires accepted intents without converting a receipt into current membership", () => {
    let id = 0;
    const registry = createAccessChangeRegistry(() => `change-${++id}`);
    const first = registry.prepare(draft);
    registry.accepted(repositoryId, first);
    expect(registry.prepare(draft).changeId).not.toBe(first.changeId);
  });

  it("does not retire an intent for another repository or change identifier", () => {
    const registry = createAccessChangeRegistry(() => "change-1");
    const first = registry.prepare(draft);
    registry.accepted("repo-2", first);
    registry.accepted(repositoryId, { ...first, changeId: "change-other" });
    expect(registry.prepare(draft)).toEqual(first);
  });

  it.each<Partial<AccessChangeDraft>>([
    { reason: "" },
    { reason: " \n\t " },
    { reason: "x".repeat(2_049) },
    { principal: { issuer: "", subject: "subject" } },
    { principal: { issuer: "x".repeat(2_049), subject: "subject" } },
    { principal: { issuer: "issuer", subject: "" } },
    { principal: { issuer: "issuer", subject: "x".repeat(513) } },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { repositoryId: "repo-1\n" },
    { repositoryId: "../other" },
  ])("rejects invalid input before allocating an intent: %j", (change) => {
    const createId = vi.fn(() => "change-1");
    const registry = createAccessChangeRegistry(createId);
    expect(() => registry.prepare({ ...draft, ...change })).toThrow();
    expect(createId).not.toHaveBeenCalled();
  });

  it("accepts the contract's maximum valid lengths", () => {
    const input = createAccessChangeRegistry(() => "change-1").prepare({
      ...draft,
      principal: { issuer: "x".repeat(2_048), subject: "x".repeat(512) },
      reason: "x".repeat(2_048),
    });
    expect(input.reason).toHaveLength(2_048);
  });
});

describe("access failure and receipt presentation", () => {
  it.each([401, 403, 404])(
    "treats HTTP %s as a permission failure without falling back",
    (status) => {
      expect(isAccessDenied(httpError(status))).toBe(true);
      expect(accessChangeNotice(httpError(status)).kind).toBe("denied");
    },
  );

  it("requires review of a fresh membership after a conflict", () => {
    const notice = accessChangeNotice(httpError(409));
    expect(notice.kind).toBe("conflict");
    expect(notice.description).toContain("review the latest record");
  });

  it("preserves policy rejection details instead of claiming every conflict is a stale version", () => {
    const rejection = new ReviewControlHttpError(
      "A repository administrator cannot remove the last repository administrator.",
      { operation: "change repository access", status: 409, retryable: false },
    );
    const notice = accessChangeNotice(rejection);
    expect(notice.title).toBe("Access change rejected");
    expect(notice.description).toContain(rejection.message);
    expect(notice.description).not.toContain("The membership changed");
  });

  it.each([
    new ReviewControlNetworkError("change repository access"),
    new ReviewControlProtocolError("change repository access", "Invalid receipt"),
    httpError(500),
  ])("preserves other failures as errors", (failure) => {
    expect(isAccessDenied(failure)).toBe(false);
    expect(accessChangeNotice(failure).kind).toBe("error");
    expect(accessChangeNotice(failure).description).toBe(failure.message);
  });

  it("presents an immutable receipt as history, including replays", () => {
    const message = accessReceiptSummary(receipt(true));
    expect(message).toContain("Existing receipt: Viewer → Reviewer, version 4");
    expect(message).toContain("refreshed members list to check current access");
  });

  it("preserves the distinction between no prior role and a revoked role", () => {
    const value = receipt();
    value.change.previousRole = null;
    value.change.role = null;
    expect(accessReceiptSummary(value)).toContain("No repository role → Revoked");
  });
});
