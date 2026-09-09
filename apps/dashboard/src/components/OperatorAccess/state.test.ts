import type {
  OperatorAccessContext,
  OperatorRepositoryPermission,
  OperatorRepositoryRole,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { accessContextMatches, contextAllows, samePrincipal } from "./state";

const principal = { issuer: "https://issuer.example", subject: "ExactSubject" };
const permissions: Record<OperatorRepositoryRole, OperatorRepositoryPermission[]> = {
  viewer: ["read"],
  reviewer: ["read", "review"],
  maintainer: ["read", "review", "configure"],
  admin: ["read", "review", "configure", "manage_access"],
};

describe("operator access state", () => {
  for (const [role, grants] of Object.entries(permissions)) {
    const context = {
      principal,
      platformAdministrator: false,
      repository: { repositoryId: "repo-1", role, source: "repository", permissions: grants },
    } as OperatorAccessContext;
    it(`${role} grants only its server-provided repository permissions`, () => {
      for (const permission of permissions.admin) {
        expect(contextAllows(context, permission, "repo-1")).toBe(grants.includes(permission));
        expect(contextAllows(context, permission, "repo-2")).toBe(false);
      }
    });
  }

  it("keeps an authenticated operator without grants able to read the repository directory", () => {
    const context: OperatorAccessContext = {
      principal,
      platformAdministrator: false,
      repository: null,
    };
    expect(contextAllows(context, "read")).toBe(true);
    for (const permission of permissions.admin)
      expect(contextAllows(context, permission, "repo-1")).toBe(false);
    for (const permission of ["review", "configure", "manage_access"] as const)
      expect(contextAllows(context, permission)).toBe(false);
  });

  it("recognizes a platform administrator only from the runtime context flag", () => {
    const context: OperatorAccessContext = {
      principal,
      platformAdministrator: true,
      repository: null,
    };
    for (const permission of permissions.admin)
      expect(contextAllows(context, permission)).toBe(true);
  });

  it("requires exact issuer and subject without normalization", () => {
    expect(samePrincipal(principal, { ...principal })).toBe(true);
    expect(samePrincipal(principal, { ...principal, issuer: "https://ISSUER.example" })).toBe(
      false,
    );
    expect(samePrincipal(principal, { ...principal, subject: "exactsubject" })).toBe(false);
    expect(samePrincipal(principal, { ...principal, subject: "ExactSubject " })).toBe(false);
    expect(samePrincipal(principal, null)).toBe(false);
  });

  it("rejects a cached context from another session or scope", () => {
    const context: OperatorAccessContext = {
      principal,
      platformAdministrator: false,
      repository: null,
    };
    expect(accessContextMatches(context, principal)).toBe(true);
    expect(accessContextMatches(context, principal, "repo-1")).toBe(false);
    expect(accessContextMatches(context, { ...principal, subject: "other" })).toBe(false);
    expect(accessContextMatches(undefined, principal)).toBe(false);
    expect(contextAllows(undefined, "read")).toBe(false);
  });
});
