import {
  InvestigationActionKindSchema,
  InvestigationChangePasswordRequestSchema,
  InvestigationCreateAccountRequestSchema,
  InvestigationLoginRequestSchema,
  InvestigationResetAccountPasswordRequestSchema,
  InvestigationUpdateAccountRequestSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  Account,
  AuthApi,
  CreateAccountInput,
  InvestigationSession,
  PasswordChangeInput,
  PasswordLoginInput,
  ResetPasswordInput,
  UpdateAccountInput,
} from "./auth-api";
import { InvestigationHttpError } from "./transport";

interface PasswordHash {
  salt: Uint8Array<ArrayBuffer>;
  digest: Uint8Array<ArrayBuffer>;
}

interface StoredAccount {
  account: Account;
  password: PasswordHash;
}

interface SampleStore {
  accounts: Map<string, StoredAccount>;
  dummyPassword: PasswordHash;
  session: { accountId: string; expiresAt: string } | null;
}

function validateInput(schema: TSchema, input: unknown): void {
  if (!Value.Check(schema, input)) {
    throw new InvestigationHttpError(400, "The account request contains invalid values.");
  }
}

async function derivePassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = new TextEncoder().encode(password);
  try {
    const key = await crypto.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
        key,
        256,
      ),
    );
  } finally {
    encoded.fill(0);
  }
}

async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt, digest: await derivePassword(password, salt) };
}

async function passwordMatches(password: string, expected: PasswordHash): Promise<boolean> {
  const actual = await derivePassword(password, expected.salt);
  try {
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
      difference |= actual[index]! ^ expected.digest[index]!;
    }
    return difference === 0;
  } finally {
    actual.fill(0);
  }
}

async function initializeStore(): Promise<SampleStore> {
  const timestamp = new Date().toISOString();
  const password = await hashPassword("Demo-password-2026!");
  const account: Account = {
    id: "sample-operator",
    username: "demo",
    displayName: "Development Operator",
    isAdmin: true,
    enabled: true,
    repositoryIds: ["repo-powertoys-fork"],
    permissions: [
      "repository:manage",
      "task:create",
      "task:cancel",
      "action:prepare",
      "action:execute",
    ],
    actionCapabilities: InvestigationActionKindSchema.anyOf.map((entry) => entry.const),
    allowRepositoryExecution: false,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    accounts: new Map([[account.id, { account, password }]]),
    dummyPassword: structuredClone(password),
    session: null,
  };
}

function currentAccount(store: SampleStore): StoredAccount | null {
  if (store.session === null) return null;
  const stored = store.accounts.get(store.session.accountId);
  if (!stored?.account.enabled || Date.parse(store.session.expiresAt) <= Date.now()) {
    store.session = null;
    return null;
  }
  return stored;
}

function requireAccount(store: SampleStore): StoredAccount {
  const current = currentAccount(store);
  if (current === null) {
    throw new InvestigationHttpError(401, "Sign in to continue.");
  }
  return current;
}

function requireAdmin(store: SampleStore): void {
  if (!requireAccount(store).account.isAdmin) {
    throw new InvestigationHttpError(403, "Account administration requires an administrator.");
  }
}

function findAccount(store: SampleStore, id: string, version: number): StoredAccount {
  const stored = store.accounts.get(id);
  if (stored === undefined) {
    throw new InvestigationHttpError(404, "The account was not found.");
  }
  if (stored.account.version !== version) {
    throw new InvestigationHttpError(409, "The account changed. Refresh before trying again.");
  }
  return stored;
}

function readSession(store: SampleStore): InvestigationSession {
  const stored = currentAccount(store);
  if (stored === null || store.session === null) {
    return {
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    };
  }
  const { account } = stored;
  const session: InvestigationSession = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: store.session.expiresAt,
    user: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      email: null,
      isAdmin: account.isAdmin,
      repositoryIds: account.repositoryIds,
      permissions: account.permissions,
      actionCapabilities: account.actionCapabilities,
      allowRepositoryExecution: account.allowRepositoryExecution,
    },
  };
  return structuredClone(session);
}

function accessFields(input: CreateAccountInput | UpdateAccountInput) {
  return {
    displayName: input.displayName.trim(),
    isAdmin: input.isAdmin,
    repositoryIds: [...input.repositoryIds],
    permissions: [...input.permissions],
    actionCapabilities: [...input.actionCapabilities],
    allowRepositoryExecution: input.allowRepositoryExecution,
  };
}

function touchAccount(account: Account): void {
  account.version += 1;
  account.updatedAt = new Date().toISOString();
}

// This isolated, in-memory Development preview is not a production authentication service.
// Seed data and password hashing are deferred until an API method is called.
export function createSampleAuthApi(): AuthApi {
  let initialization: Promise<SampleStore> | undefined;
  let previous: Promise<void> | undefined;

  function run<T>(operation: (store: SampleStore) => T | Promise<T>): Promise<T> {
    const result = (previous ?? Promise.resolve()).then(async () => {
      initialization ??= initializeStore();
      return operation(await initialization);
    });
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    session: () => run(readSession),

    login(input: PasswordLoginInput) {
      const snapshot = structuredClone(input);
      return run(async (store) => {
        validateInput(InvestigationLoginRequestSchema, snapshot);
        const username = normalizeInvestigationUsername(snapshot.username);
        const stored = [...store.accounts.values()].find(
          (entry) => entry.account.username === username,
        );
        const matched = await passwordMatches(
          snapshot.password,
          stored?.password ?? store.dummyPassword,
        );
        if (!stored?.account.enabled || !matched) {
          throw new InvestigationHttpError(401, "The username or password is incorrect.");
        }
        store.session = {
          accountId: stored.account.id,
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
        };
        return readSession(store);
      });
    },

    logout: () =>
      run((store) => {
        store.session = null;
      }),

    changePassword(input: PasswordChangeInput) {
      const snapshot = structuredClone(input);
      return run(async (store) => {
        const stored = requireAccount(store);
        validateInput(InvestigationChangePasswordRequestSchema, snapshot);
        if (!(await passwordMatches(snapshot.currentPassword, stored.password))) {
          throw new InvestigationHttpError(401, "The current password is incorrect.");
        }
        stored.password = await hashPassword(snapshot.newPassword);
        touchAccount(stored.account);
        store.session = null;
      });
    },

    listAccounts: () =>
      run((store) => {
        requireAdmin(store);
        return {
          items: [...store.accounts.values()].map((entry) => structuredClone(entry.account)),
        };
      }),

    createAccount(input: CreateAccountInput) {
      const snapshot = structuredClone(input);
      return run(async (store) => {
        requireAdmin(store);
        validateInput(InvestigationCreateAccountRequestSchema, snapshot);
        const username = normalizeInvestigationUsername(snapshot.username);
        if ([...store.accounts.values()].some((entry) => entry.account.username === username)) {
          throw new InvestigationHttpError(409, "An account with this username already exists.");
        }
        const password = await hashPassword(snapshot.password);
        const timestamp = new Date().toISOString();
        const account: Account = {
          id: `sample-account-${crypto.randomUUID()}`,
          username,
          ...accessFields(snapshot),
          enabled: true,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.accounts.set(account.id, { account, password });
        return structuredClone(account);
      });
    },

    updateAccount(id: string, input: UpdateAccountInput) {
      const snapshot = structuredClone(input);
      return run((store) => {
        requireAdmin(store);
        validateInput(InvestigationUpdateAccountRequestSchema, snapshot);
        const stored = findAccount(store, id, snapshot.version);
        if (
          stored.account.enabled &&
          stored.account.isAdmin &&
          (!snapshot.enabled || !snapshot.isAdmin) &&
          [...store.accounts.values()].filter(
            (entry) => entry.account.enabled && entry.account.isAdmin,
          ).length <= 1
        ) {
          throw new InvestigationHttpError(
            409,
            "The last enabled administrator must remain enabled.",
          );
        }
        stored.account = {
          ...stored.account,
          ...accessFields(snapshot),
          enabled: snapshot.enabled,
        };
        touchAccount(stored.account);
        if (!stored.account.enabled && store.session?.accountId === id) store.session = null;
        return structuredClone(stored.account);
      });
    },

    resetAccountPassword(id: string, input: ResetPasswordInput) {
      const snapshot = structuredClone(input);
      return run(async (store) => {
        requireAdmin(store);
        validateInput(InvestigationResetAccountPasswordRequestSchema, snapshot);
        const stored = findAccount(store, id, snapshot.version);
        stored.password = await hashPassword(snapshot.newPassword);
        touchAccount(stored.account);
        if (store.session?.accountId === id) store.session = null;
        return structuredClone(stored.account);
      });
    },
  };
}
