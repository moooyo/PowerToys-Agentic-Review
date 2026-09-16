import {
  type InvestigationAccount,
  InvestigationAccountListSchema,
  InvestigationAccountSchema,
  type InvestigationCreateAccountRequest,
  type InvestigationLoginRequest,
  InvestigationSessionSchema,
  type InvestigationUpdateAccountRequest,
} from "@agentic-review/contracts";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthApi } from "./auth-api";
import { createSampleAuthApi } from "./sample-auth";
import { InvestigationHttpError } from "./transport";

const demoCredentials = { username: "demo", password: "Demo-password-2026!" };
const operatorId = "sample-operator";
const repositoryId = "repo-powertoys-fork";
const fetcher = vi.fn<typeof fetch>();
const storageAccess = vi.fn(() => {
  throw new Error("Sample authentication must never access persistent browser storage.");
});
const forbiddenStorage = new Proxy({} as Storage, {
  get: storageAccess,
  set: storageAccess,
  deleteProperty: storageAccess,
  defineProperty: storageAccess,
  ownKeys: storageAccess,
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("A required account is missing.");
  return value;
}

function expectSchema(schema: TSchema, value: unknown): void {
  expect(Value.Check(schema, value)).toBe(true);
}

function expectHttpError(
  operation: Promise<unknown>,
  status: number,
): Promise<InvestigationHttpError> {
  return operation.then(
    () => {
      throw new Error(`Expected an HTTP ${status} rejection.`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(InvestigationHttpError);
      expect(error).toMatchObject({ status });
      return error as InvestigationHttpError;
    },
  );
}

function createInput(
  overrides: Partial<InvestigationCreateAccountRequest> = {},
): InvestigationCreateAccountRequest {
  return {
    username: "reviewer",
    password: "Reviewer-password-2026!",
    displayName: "Review Operator",
    isAdmin: false,
    repositoryIds: [repositoryId],
    permissions: ["task:create"],
    actionCapabilities: ["comment"],
    allowRepositoryExecution: false,
    ...overrides,
  };
}

function credentials(input: InvestigationLoginRequest): InvestigationLoginRequest {
  return { username: input.username, password: input.password };
}

function updateInput(
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

async function signedInApi(): Promise<AuthApi> {
  const api = createSampleAuthApi();
  await api.login(demoCredentials);
  return api;
}

async function findAccount(api: AuthApi, id = operatorId): Promise<InvestigationAccount> {
  return required((await api.listAccounts()).items.find((account) => account.id === id));
}

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockRejectedValue(
    new Error("Sample authentication must never dispatch network requests."),
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

describe("sample password authentication", () => {
  it("does not initialize account secrets until an API method is called", async () => {
    const randomValues = vi.spyOn(crypto, "getRandomValues");
    const api = createSampleAuthApi();
    expect(randomValues).not.toHaveBeenCalled();
    const session = await api.session();
    expect(randomValues).toHaveBeenCalled();
    expectSchema(InvestigationSessionSchema, session);
    expect(session).toEqual({
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    });
  });

  it("normalizes login names and returns the seeded operator without account secrets", async () => {
    const api = createSampleAuthApi();
    const session = await api.login({ ...demoCredentials, username: "  DeMo  " });
    expectSchema(InvestigationSessionSchema, session);
    expect(session).toMatchObject({
      authenticated: true,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: {
        id: operatorId,
        username: "demo",
        displayName: "Development Operator",
        email: null,
        isAdmin: true,
        repositoryIds: [repositoryId],
        permissions: [
          "repository:manage",
          "task:create",
          "task:cancel",
          "action:prepare",
          "action:execute",
        ],
        allowRepositoryExecution: false,
      },
    });
    expect(new Set(required(session.user).actionCapabilities)).toEqual(
      new Set([
        "comment",
        "approve",
        "suggestion-comment",
        "request-changes",
        "close",
        "merge",
        "trigger-ci",
        "close-as-duplicate",
        "start-task",
        "reviews.verify",
        "view-validation",
        "view-changes",
        "create-pr",
        "view-evidence",
        "resume",
      ]),
    );
    const accounts = await api.listAccounts();
    expectSchema(InvestigationAccountListSchema, accounts);
    expect(accounts.items).toHaveLength(1);
    expect(required(accounts.items[0])).toMatchObject({
      id: operatorId,
      username: "demo",
      enabled: true,
      isAdmin: true,
      version: 1,
    });
    expect(JSON.stringify({ session, accounts })).not.toContain(demoCredentials.password);
  });

  it("uses the same generic error for unknown accounts, wrong passwords, and disabled accounts", async () => {
    const api = createSampleAuthApi();
    const wrongPassword = "Incorrect-password-2026!";
    const unknown = await expectHttpError(
      api.login({ username: "unknown", password: demoCredentials.password }),
      401,
    );
    const wrong = await expectHttpError(
      api.login({ username: "demo", password: wrongPassword }),
      401,
    );
    expect(wrong.message).toBe(unknown.message);
    expect((await api.session()).authenticated).toBe(false);

    await api.login(demoCredentials);
    const input = createInput();
    const account = await api.createAccount(input);
    await api.updateAccount(account.id, updateInput(account, { enabled: false }));
    await api.logout();
    const disabled = await expectHttpError(api.login(credentials(input)), 401);
    expect(disabled.message).toBe(unknown.message);
    for (const error of [unknown, wrong, disabled]) {
      const detail = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
      for (const password of [demoCredentials.password, wrongPassword, input.password]) {
        expect(detail).not.toContain(password);
      }
    }
    expect((await api.session()).authenticated).toBe(false);
    await api.login(demoCredentials);
    expect((await api.session()).authenticated).toBe(true);
  });

  it("serializes login, logout, and session reads in invocation order", async () => {
    const api = createSampleAuthApi();
    const signingIn = api.login(demoCredentials);
    const signingOut = api.logout();
    const afterLogout = api.session();
    const [session, , signedOut] = await Promise.all([signingIn, signingOut, afterLogout]);
    expect(session.authenticated).toBe(true);
    expect(signedOut.authenticated).toBe(false);
    await api.logout();
    await expectHttpError(api.listAccounts(), 401);
  });

  it("expires the session at its advertised deadline and denies protected operations", async () => {
    const timestamp = Date.parse("2026-09-15T08:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    const api = createSampleAuthApi();
    const session = await api.login(demoCredentials);
    if (!session.authenticated) throw new Error("Expected an authenticated session.");
    expect(Date.parse(session.expiresAt)).toBe(timestamp + 8 * 60 * 60 * 1_000);
    now.mockReturnValue(Date.parse(session.expiresAt) - 1);
    expect((await api.session()).authenticated).toBe(true);
    now.mockReturnValue(Date.parse(session.expiresAt));
    expect((await api.session()).authenticated).toBe(false);
    await expectHttpError(api.listAccounts(), 401);
    await api.login(demoCredentials);
    expect((await api.session()).authenticated).toBe(true);
  });

  it("rejects invalid password changes atomically and rotates exact passwords with session revocation", async () => {
    const api = await signedInApi();
    const original = await findAccount(api);
    await expectHttpError(
      api.changePassword({
        currentPassword: "Incorrect-password-2026!",
        newPassword: "Valid-new-password-2026!",
      }),
      401,
    );
    for (const newPassword of ["short", " ".repeat(15), "x".repeat(129)]) {
      await expectHttpError(
        api.changePassword({ currentPassword: demoCredentials.password, newPassword }),
        400,
      );
    }
    expect((await api.session()).authenticated).toBe(true);
    expect(await findAccount(api)).toEqual(original);

    const newPassword = "  Exact-new-password-2026!  ";
    await api.changePassword({ currentPassword: demoCredentials.password, newPassword });
    expect((await api.session()).authenticated).toBe(false);
    await expectHttpError(api.listAccounts(), 401);
    await expectHttpError(api.login(demoCredentials), 401);
    await expectHttpError(api.login({ username: "demo", password: newPassword.trim() }), 401);
    await api.login({ username: "demo", password: newPassword });
    expect((await findAccount(api)).version).toBe(original.version + 1);
  });

  it("requires authentication and restricts account administration to administrators", async () => {
    const api = createSampleAuthApi();
    const input = createInput();
    const update = updateInput({
      ...input,
      id: operatorId,
      enabled: true,
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
    await expectHttpError(api.listAccounts(), 401);
    await expectHttpError(api.createAccount(input), 401);
    await expectHttpError(api.updateAccount(operatorId, update), 401);
    await expectHttpError(
      api.resetAccountPassword(operatorId, { version: 1, newPassword: input.password }),
      401,
    );
    await expectHttpError(
      api.changePassword({ currentPassword: input.password, newPassword: input.password }),
      401,
    );

    await api.login(demoCredentials);
    const account = await api.createAccount(input);
    await api.logout();
    await api.login(credentials(input));
    await expectHttpError(api.listAccounts(), 403);
    await expectHttpError(api.createAccount(createInput({ username: "another" })), 403);
    await expectHttpError(
      api.updateAccount(account.id, updateInput(account, { isAdmin: true })),
      403,
    );
    await expectHttpError(
      api.resetAccountPassword(account.id, {
        version: account.version,
        newPassword: input.password,
      }),
      403,
    );
    await api.changePassword({
      currentPassword: input.password,
      newPassword: "Reviewer-rotated-2026!",
    });
    expect((await api.session()).authenticated).toBe(false);
    expect(
      (await api.login({ username: input.username, password: "Reviewer-rotated-2026!" }))
        .authenticated,
    ).toBe(true);
  });
});

describe("sample account administration", () => {
  it("normalizes created usernames, rejects duplicates, and validates account and password inputs", async () => {
    const api = await signedInApi();
    const input = createInput({ username: "  ReView.User-1  " });
    const account = await api.createAccount(input);
    expectSchema(InvestigationAccountSchema, account);
    expect(account).toMatchObject({ username: "review.user-1", enabled: true, version: 1 });
    await expectHttpError(api.createAccount({ ...input, username: "REVIEW.USER-1" }), 409);
    for (const username of ["ab", "_name", "user name", "équipe", "a".repeat(65)]) {
      await expectHttpError(api.createAccount(createInput({ username })), 400);
    }
    for (const password of ["short", "\t".repeat(15), "x".repeat(129)]) {
      await expectHttpError(api.createAccount(createInput({ password })), 400);
    }
    await expectHttpError(api.createAccount(createInput({ displayName: "   " })), 400);
    await expectHttpError(
      api.createAccount(createInput({ repositoryIds: [repositoryId, repositoryId] })),
      400,
    );
    expect((await api.listAccounts()).items).toHaveLength(2);
    await api.logout();
    expect(
      (await api.login({ username: "review.USER-1", password: input.password })).authenticated,
    ).toBe(true);
  });

  it.each([15, 128])("accepts a new password at the %i-character boundary", async (length) => {
    const api = await signedInApi();
    const input = createInput({ password: "p".repeat(length) });
    await api.createAccount(input);
    await api.logout();
    expect((await api.login(credentials(input))).authenticated).toBe(true);
  });

  it("rejects missing accounts, stale versions, and invalid updates without partial writes", async () => {
    const api = await signedInApi();
    const account = await api.createAccount(createInput());
    const changed = await api.updateAccount(
      account.id,
      updateInput(account, { displayName: "Updated Operator" }),
    );
    expect(changed.version).toBe(account.version + 1);
    await expectHttpError(
      api.updateAccount(account.id, updateInput(account, { enabled: false })),
      409,
    );
    await expectHttpError(
      api.resetAccountPassword(account.id, {
        version: account.version,
        newPassword: "Rejected-reset-password!",
      }),
      409,
    );
    await expectHttpError(api.updateAccount("missing-account", updateInput(changed)), 404);
    await expectHttpError(
      api.resetAccountPassword("missing-account", {
        version: 1,
        newPassword: "Rejected-reset-password!",
      }),
      404,
    );
    await expectHttpError(
      api.updateAccount(account.id, updateInput(changed, { displayName: "   ", enabled: false })),
      400,
    );
    expect(await findAccount(api, account.id)).toEqual(changed);
    await api.logout();
    expect((await api.login(credentials(createInput()))).authenticated).toBe(true);
  });

  it("serializes conflicting writes and recovers the queue after a version conflict", async () => {
    const api = await signedInApi();
    const account = await api.createAccount(createInput());
    const first = api.updateAccount(
      account.id,
      updateInput(account, { displayName: "First update" }),
    );
    const second = expectHttpError(
      api.updateAccount(account.id, updateInput(account, { displayName: "Second update" })),
      409,
    );
    const [updated] = await Promise.all([first, second]);
    expect(updated).toMatchObject({ displayName: "First update", version: account.version + 1 });
    expect(await findAccount(api, account.id)).toEqual(updated);

    const input = createInput({ username: "new-reviewer" });
    const created = api.createAccount(input);
    const duplicate = expectHttpError(
      api.createAccount({ ...input, username: "NEW-REVIEWER" }),
      409,
    );
    await Promise.all([created, duplicate]);
    expect(
      (await api.listAccounts()).items.filter((item) => item.username === input.username),
    ).toHaveLength(1);
  });

  it("protects the last enabled administrator and does not count disabled administrators", async () => {
    const api = await signedInApi();
    const operator = await findAccount(api);
    for (const overrides of [
      { enabled: false },
      { isAdmin: false },
      { enabled: false, isAdmin: false },
    ]) {
      await expectHttpError(api.updateAccount(operator.id, updateInput(operator, overrides)), 409);
    }
    expect(await findAccount(api)).toEqual(operator);
    const backup = await api.createAccount(
      createInput({ username: "backup-admin", isAdmin: true }),
    );
    await api.updateAccount(backup.id, updateInput(backup, { enabled: false }));
    await expectHttpError(
      api.updateAccount(operator.id, updateInput(operator, { isAdmin: false })),
      409,
    );
    expect((await api.session()).user?.isAdmin).toBe(true);
    expect(await findAccount(api)).toEqual(operator);
  });

  it("refreshes session grants and authorizes queued operations after an administrator demotes themself", async () => {
    const api = await signedInApi();
    await api.createAccount(createInput({ username: "backup-admin", isAdmin: true }));
    const operator = await findAccount(api);
    const changed = await api.updateAccount(
      operator.id,
      updateInput(operator, {
        displayName: "Restricted Operator",
        repositoryIds: [],
        permissions: [],
        actionCapabilities: [],
        allowRepositoryExecution: true,
      }),
    );
    expect((await api.session()).user).toMatchObject({
      displayName: "Restricted Operator",
      repositoryIds: [],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: true,
    });
    const demotion = api.updateAccount(
      operator.id,
      updateInput(changed, {
        isAdmin: false,
        allowRepositoryExecution: false,
      }),
    );
    const denied = expectHttpError(api.listAccounts(), 403);
    await Promise.all([demotion, denied]);
    expect((await api.session()).user).toMatchObject({
      isAdmin: false,
      allowRepositoryExecution: false,
    });
  });

  it("revokes a disabled operator immediately and allows an administrator to enable the account again", async () => {
    const api = await signedInApi();
    const backupInput = createInput({ username: "backup-admin", isAdmin: true });
    await api.createAccount(backupInput);
    const operator = await findAccount(api);
    const disabling = api.updateAccount(operator.id, updateInput(operator, { enabled: false }));
    const denied = expectHttpError(api.listAccounts(), 401);
    await Promise.all([disabling, denied]);
    expect((await api.session()).authenticated).toBe(false);
    await expectHttpError(api.login(demoCredentials), 401);
    await api.login(credentials(backupInput));
    const disabled = await findAccount(api);
    await api.updateAccount(disabled.id, updateInput(disabled, { enabled: true }));
    await api.logout();
    expect((await api.login(demoCredentials)).authenticated).toBe(true);
  });

  it("resets another account without signing out the administrator and revokes a self reset", async () => {
    const api = await signedInApi();
    const input = createInput();
    const account = await api.createAccount(input);
    for (const newPassword of ["short", " ".repeat(15), "x".repeat(129)]) {
      await expectHttpError(
        api.resetAccountPassword(account.id, { version: account.version, newPassword }),
        400,
      );
    }
    expect(await findAccount(api, account.id)).toEqual(account);
    const newPassword = "Reset-reviewer-password-2026!";
    const reset = await api.resetAccountPassword(account.id, {
      version: account.version,
      newPassword,
    });
    expectSchema(InvestigationAccountSchema, reset);
    expect(reset.version).toBe(account.version + 1);
    expect((await api.session()).user?.id).toBe(operatorId);
    await api.logout();
    await expectHttpError(api.login(credentials(input)), 401);
    await api.login({ username: input.username, password: newPassword });
    await api.logout();
    await api.login(demoCredentials);
    const operator = await findAccount(api);
    const selfPassword = "Reset-operator-password-2026!";
    const selfReset = api.resetAccountPassword(operator.id, {
      version: operator.version,
      newPassword: selfPassword,
    });
    const denied = expectHttpError(api.listAccounts(), 401);
    const [updated] = await Promise.all([selfReset, denied]);
    expect(updated.version).toBe(operator.version + 1);
    expect((await api.session()).authenticated).toBe(false);
    await expectHttpError(api.login(demoCredentials), 401);
    await api.login({ username: "demo", password: selfPassword });
  });
});

describe("sample authentication isolation", () => {
  it("returns cloned sessions, account lists, and mutation results", async () => {
    const api = await signedInApi();
    const session = await api.session();
    const originalUser = structuredClone(required(session.user));
    required(session.user).repositoryIds.length = 0;
    required(session.user).permissions.length = 0;
    required(session.user).actionCapabilities.length = 0;
    required(session.user).displayName = "Mutated session";
    expect((await api.session()).user).toEqual(originalUser);
    const list = await api.listAccounts();
    const operator = structuredClone(required(list.items[0]));
    required(list.items[0]).enabled = false;
    required(list.items[0]).repositoryIds.length = 0;
    list.items.length = 0;
    expect(await findAccount(api)).toEqual(operator);

    const created = await api.createAccount(createInput());
    expectSchema(InvestigationAccountSchema, created);
    const originalCreated = structuredClone(created);
    created.permissions.length = 0;
    created.actionCapabilities.length = 0;
    created.isAdmin = true;
    expect(await findAccount(api, created.id)).toEqual(originalCreated);
    const updated = await api.updateAccount(
      created.id,
      updateInput(originalCreated, { displayName: "Saved display name" }),
    );
    expectSchema(InvestigationAccountSchema, updated);
    const originalUpdated = structuredClone(updated);
    updated.repositoryIds.length = 0;
    updated.displayName = "Mutated response";
    expect(await findAccount(api, updated.id)).toEqual(originalUpdated);
    const reset = await api.resetAccountPassword(updated.id, {
      version: originalUpdated.version,
      newPassword: "Reset-clone-password-2026!",
    });
    expectSchema(InvestigationAccountSchema, reset);
    const originalReset = structuredClone(reset);
    reset.enabled = false;
    reset.permissions.length = 0;
    expect(await findAccount(api, reset.id)).toEqual(originalReset);
  });

  it("snapshots login, creation, updates, and password requests synchronously before queueing", async () => {
    const api = createSampleAuthApi();
    const loginInput = { ...demoCredentials };
    const signingIn = api.login(loginInput);
    loginInput.username = "different-user";
    loginInput.password = "Different-password-2026!";
    expect((await signingIn).authenticated).toBe(true);

    const input = createInput();
    const savedInput = structuredClone(input);
    const creating = api.createAccount(input);
    input.username = "changed-reviewer";
    input.password = "Changed-input-password-2026!";
    input.repositoryIds.length = 0;
    input.permissions.length = 0;
    input.actionCapabilities.length = 0;
    const account = await creating;
    expect(account).toMatchObject({
      username: savedInput.username,
      repositoryIds: savedInput.repositoryIds,
      permissions: savedInput.permissions,
      actionCapabilities: savedInput.actionCapabilities,
    });
    await api.logout();
    await api.login(credentials(savedInput));
    await api.logout();
    await api.login(demoCredentials);
    const update = updateInput(account, { displayName: "Queued display name" });
    const updating = api.updateAccount(account.id, update);
    update.version = 999;
    update.displayName = "Changed input";
    update.repositoryIds.length = 0;
    update.permissions.length = 0;
    update.actionCapabilities.length = 0;
    const updated = await updating;
    expect(updated).toMatchObject({
      displayName: "Queued display name",
      repositoryIds: savedInput.repositoryIds,
      permissions: savedInput.permissions,
      actionCapabilities: savedInput.actionCapabilities,
    });

    const reset = { version: updated.version, newPassword: "Queued-reset-password-2026!" };
    const resetPassword = reset.newPassword;
    const resetting = api.resetAccountPassword(account.id, reset);
    reset.version = 999;
    reset.newPassword = "Changed-reset-password-2026!";
    await resetting;
    await api.logout();
    await api.login({ username: savedInput.username, password: resetPassword });
    const change = { currentPassword: resetPassword, newPassword: "Queued-change-password-2026!" };
    const changedPassword = change.newPassword;
    const changing = api.changePassword(change);
    change.currentPassword = "Changed-current-password-2026!";
    change.newPassword = "Changed-new-password-2026!";
    await changing;
    expect((await api.session()).authenticated).toBe(false);
    await expectHttpError(
      api.login({ username: savedInput.username, password: resetPassword }),
      401,
    );
    expect(
      (await api.login({ username: savedInput.username, password: changedPassword })).authenticated,
    ).toBe(true);
  });

  it("keeps credentials, accounts, and sessions isolated between factory instances", async () => {
    const first = await signedInApi();
    const second = createSampleAuthApi();
    await first.createAccount(createInput());
    await first.changePassword({
      currentPassword: demoCredentials.password,
      newPassword: "First-instance-password-2026!",
    });
    expect((await second.session()).authenticated).toBe(false);
    await second.login(demoCredentials);
    expect((await second.listAccounts()).items).toHaveLength(1);
    expect((await findAccount(second)).version).toBe(1);
    await expectHttpError(first.login(demoCredentials), 401);
    await first.login({ username: "demo", password: "First-instance-password-2026!" });
    expect((await first.listAccounts()).items).toHaveLength(2);
    await first.logout();
    expect((await second.session()).authenticated).toBe(true);
  });
});
