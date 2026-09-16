import type { InvestigationSession } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountFormValues,
  accountWriteVersion,
  assertNewPassword,
  createAccountInput,
  parseRepositoryIds,
  submitAccountForm,
  submitAccountPassword,
  updateAccountInput,
} from "./account-form";
import AccountsPage, { AccountAccessSummary, AccountConflictNotice } from "./accounts-page";
import type { Account } from "./auth-api";
import { InvestigationHttpError } from "./transport";

const context = vi.hoisted(() => ({ session: null as InvestigationSession | null }));
vi.mock("./session", () => ({
  useInvestigationSession: () => ({
    session: context.session,
    refresh: vi.fn(),
    requireSignIn: vi.fn(),
  }),
}));

const account: Account = {
  id: "account-1",
  username: "workspace.admin",
  displayName: "Workspace Administrator",
  isAdmin: true,
  enabled: true,
  version: 3,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  repositoryIds: [],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function renderPage(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AccountsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2026-09-16T00:00:00Z",
    user: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      isAdmin: true,
      email: null,
      repositoryIds: [],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
});

describe("account administration access", () => {
  it("does not create protected queries for a non-administrator with business permissions", () => {
    if (!context.session?.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = false;
    context.session.user.permissions = [
      "repository:manage",
      "task:create",
      "task:cancel",
      "action:prepare",
      "action:execute",
    ];
    const queryClient = client();
    expect(renderPage(queryClient)).toContain("Administrator access is required");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("does not create protected queries for a signed-out session", () => {
    context.session = {
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    };
    const queryClient = client();
    expect(renderPage(queryClient)).toContain("Administrator access is required");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("lets an administrator with no repository grants manage accounts", () => {
    const queryClient = client();
    queryClient.setQueryData(["investigation-accounts"], { items: [account] });
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    const html = renderPage(queryClient);
    expect(html).toContain("Create account");
    expect(html).toContain("Workspace Administrator");
    expect(html).toContain("Edit account workspace.admin");
    expect(html).toContain("Reset password for workspace.admin");
    expect(html).toContain("Repositories: None");
    expect(html).toContain("Permissions: None");
  });

  it("shows loading, an actionable error, and an empty directory", async () => {
    expect(renderPage(client())).toContain("Loading accounts");
    const failedClient = client();
    await failedClient.prefetchQuery({
      queryKey: ["investigation-accounts"],
      queryFn: () => Promise.reject(new Error("The account directory is unavailable.")),
    });
    const errorHtml = renderPage(failedClient);
    expect(errorHtml).toContain("The account directory is unavailable.");
    expect(errorHtml).toContain("Refresh accounts");
    expect(errorHtml).not.toContain("Loading accounts");
    await failedClient.fetchQuery({
      queryKey: ["investigation-accounts"],
      queryFn: async () => ({ items: [account] }),
    });
    const recoveredHtml = renderPage(failedClient);
    expect(recoveredHtml).toContain("Workspace Administrator");
    expect(recoveredHtml).not.toContain("The account directory is unavailable.");
    const emptyClient = client();
    emptyClient.setQueryData(["investigation-accounts"], { items: [] });
    expect(renderPage(emptyClient)).toContain("Create an account to grant access.");
  });

  it("shows administrator identity independently from repository and execution access", () => {
    const html = renderToStaticMarkup(<AccountAccessSummary account={account} />);
    expect(html).toContain("Administrator");
    expect(html).toContain("Repositories: None");
    expect(html).toContain("Repository execution: Not allowed");
  });
});

describe("typed account forms", () => {
  it("starts with no access and does not infer business grants from administrator status", () => {
    const form = accountFormValues();
    expect(form.isAdmin).toBe(false);
    expect(form.permissions).toEqual([]);
    expect(form.actionCapabilities).toEqual([]);
    expect(form.allowRepositoryExecution).toBe(false);
    const input = createAccountInput({
      ...form,
      username: "  Admin.User-1  ",
      password: "  Correct password  ",
      displayName: "  Administrator  ",
      isAdmin: true,
    });
    expect(input.username).toBe("admin.user-1");
    expect(input.displayName).toBe("Administrator");
    expect(input.password).toBe("  Correct password  ");
    expect(input.permissions).toEqual([]);
    expect(input.repositoryIds).toEqual([]);
    expect(input.actionCapabilities).toEqual([]);
    expect(input.allowRepositoryExecution).toBe(false);
  });

  it("validates username and password boundaries using the shared contracts", () => {
    const form = {
      ...accountFormValues(),
      username: "abc",
      displayName: "Operator",
      password: "p".repeat(15),
    };
    expect(createAccountInput(form).username).toBe("abc");
    expect(createAccountInput({ ...form, username: "a".repeat(64) }).username).toHaveLength(64);
    for (const username of [
      "ab",
      "a".repeat(65),
      "-operator",
      "user/name",
      "管理员",
      "user name",
    ]) {
      expect(() => createAccountInput({ ...form, username })).toThrow("Use 3–64");
    }
    for (const password of ["p".repeat(14), "p".repeat(129), " ".repeat(15)]) {
      expect(() => assertNewPassword(password)).toThrow("between 15 and 128");
    }
    expect(() => assertNewPassword("p".repeat(128))).not.toThrow();
    expect(() => createAccountInput({ ...form, displayName: " ".repeat(5) })).toThrow(
      "display name",
    );
    expect(() => createAccountInput({ ...form, displayName: "a".repeat(121) })).toThrow(
      "display name",
    );
  });

  it("accepts exact repository IDs outside the directory and rejects wildcards", () => {
    expect(parseRepositoryIds("repo-other, repo-1\nrepo-other\n repo:internal_2 ")).toEqual([
      "repo-other",
      "repo-1",
      "repo:internal_2",
    ]);
    expect(parseRepositoryIds(" \n")).toEqual([]);
    for (const invalid of ["*", "repo-*", "owner/repo", "repo-1\n*", "x".repeat(129)]) {
      expect(() => parseRepositoryIds(invalid)).toThrow("exact repository IDs");
    }
    expect(() =>
      parseRepositoryIds(Array.from({ length: 1025 }, (_, i) => `repo-${i}`).join(",")),
    ).toThrow("up to 1,024");
  });

  it("updates access with the reviewed version without sending username or password", () => {
    const form = {
      ...accountFormValues(account),
      username: "cannot-change-this",
      password: "not-an-update-field",
      enabled: false,
      repositoryIdsText: "repo-external",
      permissions: ["task:create"] as Account["permissions"],
      actionCapabilities: ["start-task"] as Account["actionCapabilities"],
    };
    const input = updateAccountInput(form, 9);
    expect(input).toMatchObject({
      version: 9,
      enabled: false,
      isAdmin: true,
      repositoryIds: ["repo-external"],
      permissions: ["task:create"],
      actionCapabilities: ["start-task"],
    });
    expect(input).not.toHaveProperty("username");
    expect(input).not.toHaveProperty("password");
    input.permissions.push("task:cancel");
    expect(form.permissions).toEqual(["task:create"]);
  });
});

describe("password handling and account conflict recovery", () => {
  it("clears a create password after success, an API failure, and client validation failure", async () => {
    const form = { ...accountFormValues(account), password: "New account password" };
    const clearPassword = vi.fn();
    const api = { createAccount: vi.fn().mockResolvedValue(account), updateAccount: vi.fn() };
    await expect(
      submitAccountForm(form, undefined, undefined, api, clearPassword),
    ).resolves.toEqual(account);
    expect(clearPassword).toHaveBeenCalledTimes(1);
    const conflict = new InvestigationHttpError(409, "The username is already in use.");
    api.createAccount.mockRejectedValue(conflict);
    await expect(submitAccountForm(form, undefined, undefined, api, clearPassword)).rejects.toBe(
      conflict,
    );
    expect(clearPassword).toHaveBeenCalledTimes(2);
    await expect(
      submitAccountForm({ ...form, password: "short" }, undefined, undefined, api, clearPassword),
    ).rejects.toThrow("between 15 and 128");
    expect(clearPassword).toHaveBeenCalledTimes(3);
    expect(api.createAccount).toHaveBeenCalledTimes(2);
    expect(api.updateAccount).not.toHaveBeenCalled();
  });

  it("sends the exact new password with the reviewed version and clears every reset attempt", async () => {
    const clearPassword = vi.fn();
    const reset = vi.fn().mockResolvedValue({ ...account, version: 4 });
    await submitAccountPassword(account, "  New reset password  ", 3, reset, clearPassword);
    expect(reset).toHaveBeenCalledWith(account.id, {
      version: 3,
      newPassword: "  New reset password  ",
    });
    const conflict = new InvestigationHttpError(409, "The account changed.");
    reset.mockRejectedValue(conflict);
    await expect(
      submitAccountPassword(account, "New reset password", 3, reset, clearPassword),
    ).rejects.toBe(conflict);
    await expect(submitAccountPassword(account, "short", 3, reset, clearPassword)).rejects.toThrow(
      "between 15 and 128",
    );
    expect(clearPassword).toHaveBeenCalledTimes(3);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("keeps the draft and blocks a conflict retry until the refreshed account is reviewed", () => {
    const form = {
      ...accountFormValues(account),
      displayName: "Unsaved display name",
      enabled: false,
    };
    const latest = { ...account, version: 4, displayName: "Changed elsewhere" };
    expect(accountWriteVersion(account, false, undefined, false)).toBe(3);
    expect(() => accountWriteVersion(account, true, undefined, false)).toThrow(
      "Refresh this account",
    );
    expect(() => accountWriteVersion(account, true, latest, false)).toThrow(
      "review its current access",
    );
    expect(() =>
      accountWriteVersion(account, true, { ...latest, id: "another-account" }, true),
    ).toThrow();
    expect(
      updateAccountInput(form, accountWriteVersion(account, true, latest, true)),
    ).toMatchObject({
      version: 4,
      displayName: "Unsaved display name",
      enabled: false,
    });
    expect(form.displayName).toBe("Unsaved display name");
    expect(latest.displayName).toBe("Changed elsewhere");
  });

  it("shows latest saved access and explicit review without presenting the draft as saved", () => {
    const html = renderToStaticMarkup(
      <AccountConflictNotice
        disabled={false}
        review={{
          conflict: true,
          latest: { ...account, version: 4, displayName: "Changed elsewhere", enabled: false },
          reviewed: false,
          loading: false,
          error: undefined,
          ready: false,
          version: () => 4,
          setReviewed: vi.fn(),
          markConflict: vi.fn(),
          refresh: vi.fn(),
        }}
      />,
    );
    expect(html).toContain("Your non-password fields are still in");
    expect(html).toContain("Refresh account for review");
    expect(html).toContain("Latest saved account · version 4");
    expect(html).toContain("Changed elsewhere");
    expect(html).toContain("Disabled");
    expect(html).toContain("I reviewed the latest account");
  });
});
