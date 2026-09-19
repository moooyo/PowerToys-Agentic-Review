import type { InvestigationSession } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import type { Repository, WorkItem } from "./api";
import {
  currentImportSnapshot,
  ImportWorkItemValidationError,
  importableRepositories,
  importWorkItemRequest,
} from "./import-work-item";

const repository: Repository = {
  id: "repo-selected",
  fullName: "owner/selected-repository",
  githubRepositoryId: 8001,
};
const otherRepository: Repository = {
  id: "repo-other",
  fullName: "owner/other-repository",
  githubRepositoryId: 8002,
};
const snapshot: WorkItem = {
  id: "issue-12",
  repositoryId: repository.id,
  kind: "issue",
  number: 12,
  title: "An imported issue",
  body: "The saved source description.",
  state: "open",
  updatedAt: "2026-09-20T00:00:00Z",
  subject: {
    id: "issue-12-subject",
    repositoryId: repository.id,
    workItemId: "issue-12",
    kind: "issue_snapshot",
    revisionKey: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
  },
};

function session(): InvestigationSession {
  return {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: {
      id: "operator",
      username: "operator",
      displayName: "Operator",
      email: null,
      isAdmin: false,
      repositoryIds: [repository.id],
      permissions: ["repository:manage"],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
}

describe("source import access", () => {
  it("offers only registered repositories granted to the current account", () => {
    expect(importableRepositories([otherRepository, repository], session())).toEqual([repository]);
    expect(importableRepositories([otherRepository], session())).toEqual([]);
  });

  it.each(["repository grant", "management permission"])(
    "does not let administrators bypass a missing %s",
    (missing) => {
      const current = session();
      if (!current.authenticated) throw new Error("An authenticated fixture is required.");
      current.user.isAdmin = true;
      if (missing === "repository grant") current.user.repositoryIds = [];
      else current.user.permissions = [];
      expect(importableRepositories([repository], current)).toEqual([]);
      expect(() =>
        importWorkItemRequest(repository.id, "pull_request", "12", [repository], current),
      ).toThrow(ImportWorkItemValidationError);
    },
  );

  it("does not import a repository absent from the loaded permitted list", () => {
    expect(() =>
      importWorkItemRequest(repository.id, "issue", "12", [otherRepository], session()),
    ).toThrow("Choose a repository you can manage");
  });

  it("does not import after the account signs out", () => {
    const signedOut: InvestigationSession = {
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    };
    expect(importableRepositories([repository], signedOut)).toEqual([]);
    expect(() =>
      importWorkItemRequest(repository.id, "issue", "12", [repository], signedOut),
    ).toThrow(ImportWorkItemValidationError);
  });
});

describe("source import input", () => {
  it.each(["pull_request", "issue"] as const)("keeps the requested %s source kind", (kind) => {
    expect(importWorkItemRequest(repository.id, kind, " 0012 ", [repository], session())).toEqual({
      repositoryId: repository.id,
      input: { kind, number: 12 },
    });
  });

  it.each(["", " ", "0", "-1", "1.5", "1e3", "0x10", "+12", "#12", "12abc", "9007199254740992"])(
    "rejects a non-positive, non-decimal, or unsafe source number: %j",
    (number) => {
      try {
        importWorkItemRequest(repository.id, "issue", number, [repository], session());
        throw new Error("The source number should have been rejected.");
      } catch (cause) {
        expect(cause).toBeInstanceOf(ImportWorkItemValidationError);
        expect(cause).toMatchObject({
          field: "number",
          message: "Enter a positive whole issue number.",
        });
      }
    },
  );

  it("accepts the largest safely represented positive source number", () => {
    expect(
      importWorkItemRequest(
        repository.id,
        "pull_request",
        "9007199254740991",
        [repository],
        session(),
      ).input.number,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("source import conflict recovery", () => {
  const request = { repositoryId: repository.id, input: { kind: "issue" as const, number: 12 } };

  it("returns the existing snapshot for the exact requested source number", () => {
    expect(currentImportSnapshot(request, [{ ...snapshot, number: 13 }, snapshot])).toBe(snapshot);
  });

  it("distinguishes no saved snapshot from a failed read", () => {
    expect(currentImportSnapshot(request, [])).toBeUndefined();
    expect(currentImportSnapshot(request, [{ ...snapshot, number: 13 }])).toBeUndefined();
  });

  it.each([
    { ...snapshot, repositoryId: otherRepository.id },
    { ...snapshot, kind: "pull_request" as const },
  ])("rejects a response from another repository or source type", (foreign) => {
    expect(() => currentImportSnapshot(request, [foreign])).toThrow(
      "The source list did not match the selected repository and source type.",
    );
  });

  it("rejects a snapshot whose revision belongs to another work item", () => {
    expect(() =>
      currentImportSnapshot(request, [
        { ...snapshot, subject: { ...snapshot.subject, workItemId: "another-work-item" } },
      ]),
    ).toThrow("The saved source revision did not match the selected work item.");
  });
});
