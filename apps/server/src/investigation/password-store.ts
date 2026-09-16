import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  EntityIdSchema,
  type InvestigationAccount,
  type InvestigationAccountPermission,
  InvestigationAccountPermissionSchema,
  type InvestigationActionKind,
  InvestigationActionKindSchema,
  InvestigationUsernameInputSchema,
  normalizeInvestigationUsername as normalizeUsername,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { InvestigationPasswordKdf, InvestigationPasswordKdfError } from "./password-crypto.js";

export const investigationPasswordSchemaVersion = "investigation-password-auth-v1";

export type InvestigationPasswordPermission = InvestigationAccountPermission;
export type InvestigationPasswordAccount = InvestigationAccount;

export interface InvestigationPasswordActor {
  id: string;
  version: number;
}

export interface InvestigationPasswordAccountInput {
  username: string;
  password: string;
  displayName?: string;
  isAdmin?: boolean;
  enabled?: boolean;
  repositoryIds?: readonly string[];
  permissions?: readonly InvestigationPasswordPermission[];
  actionCapabilities?: readonly InvestigationActionKind[];
  allowRepositoryExecution?: boolean;
}

export type InvestigationPasswordAccountUpdates = Partial<
  Omit<InvestigationPasswordAccountInput, "password" | "username">
>;

export interface InvestigationPasswordSession {
  account: InvestigationPasswordAccount;
  expiresAt: string;
}

export interface InvestigationPasswordStoreOptions {
  sessionTtlMs?: number;
  maxKdfConcurrency?: number;
  maxKdfQueue?: number;
  now?: () => number;
}

export type InvestigationPasswordStoreErrorCode =
  | "invalid_account"
  | "invalid_password"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "last_admin"
  | "bootstrap_required"
  | "incompatible_schema"
  | "kdf_busy";

const errorStatus = {
  invalid_account: 400,
  invalid_password: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  bootstrap_required: 409,
  incompatible_schema: 409,
  kdf_busy: 429,
} as const;

export class InvestigationPasswordStoreError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: InvestigationPasswordStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationPasswordStoreError";
    this.statusCode = errorStatus[code];
  }
}

const definitions = new Map([
  [
    "investigation_password_metadata",
    `CREATE TABLE investigation_password_metadata (
      version TEXT PRIMARY KEY NOT NULL
    ) STRICT`,
  ],
  [
    "investigation_password_clock",
    `CREATE TABLE investigation_password_clock (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      last_observed_at INTEGER NOT NULL CHECK (last_observed_at BETWEEN 0 AND 9007199254740991)
    ) STRICT`,
  ],
  [
    "investigation_password_accounts",
    `CREATE TABLE investigation_password_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL CHECK (is_admin IN (0, 1)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      repository_ids TEXT NOT NULL CHECK (json_valid(repository_ids)),
      permissions TEXT NOT NULL CHECK (json_valid(permissions)),
      action_capabilities TEXT NOT NULL CHECK (json_valid(action_capabilities)),
      allow_repository_execution INTEGER NOT NULL CHECK (allow_repository_execution IN (0, 1))
    ) STRICT`,
  ],
  [
    "investigation_password_sessions",
    `CREATE TABLE investigation_password_sessions (
      token_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(token_sha256) = 64),
      account_id TEXT NOT NULL REFERENCES investigation_password_accounts(id) ON DELETE CASCADE,
      account_version INTEGER NOT NULL CHECK (account_version BETWEEN 1 AND 9007199254740991),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT`,
  ],
  [
    "investigation_password_session_expiry",
    "CREATE INDEX investigation_password_session_expiry ON investigation_password_sessions(expires_at)",
  ],
  [
    "investigation_password_session_account",
    "CREATE INDEX investigation_password_session_account ON investigation_password_sessions(account_id)",
  ],
]);

const mutableFields = new Set([
  "displayName",
  "isAdmin",
  "enabled",
  "repositoryIds",
  "permissions",
  "actionCapabilities",
  "allowRepositoryExecution",
]);
type AccountRow = Record<string, SQLOutputValue>;

function invalidAccount(message: string): never {
  throw new InvestigationPasswordStoreError("invalid_account", message);
}

export function normalizeInvestigationUsername(username: string): string {
  if (typeof username !== "string") invalidAccount("Username must be a string.");
  if (!Value.Check(InvestigationUsernameInputSchema, username)) {
    invalidAccount(
      "Username must contain 3 to 64 ASCII letters, digits, periods, underscores, or hyphens.",
    );
  }
  return normalizeUsername(username);
}

function listOfStrings(value: unknown, field: string, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256) ||
    new Set(value).size !== value.length
  ) {
    invalidAccount(`${field} must be an array of unique, nonempty strings.`);
  }
  return [...value] as string[];
}

function validateFields(
  input: Partial<Omit<InvestigationPasswordAccountInput, "password">>,
  allowUsername = false,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalidAccount("Account updates must be an object.");
  }
  if (
    Object.keys(input).some(
      (key) => !mutableFields.has(key) && !(allowUsername && key === "username"),
    )
  ) {
    invalidAccount("Account updates contain an unsupported field.");
  }
  if (input.username !== undefined) normalizeInvestigationUsername(input.username);
  if (
    input.displayName !== undefined &&
    (typeof input.displayName !== "string" ||
      !input.displayName.trim() ||
      Array.from(input.displayName).length > 120)
  ) {
    invalidAccount("Display name must contain 1 to 120 characters.");
  }
  for (const field of ["isAdmin", "enabled", "allowRepositoryExecution"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      invalidAccount(`${field} must be a boolean.`);
    }
  }
  if (input.repositoryIds !== undefined) {
    const repositoryIds = listOfStrings(input.repositoryIds, "repositoryIds", 1_024);
    if (repositoryIds.some((id) => !Value.Check(EntityIdSchema, id))) {
      invalidAccount("Repository access contains an invalid repository ID.");
    }
  }
  if (input.permissions !== undefined) {
    const permissions = listOfStrings(input.permissions, "permissions", 5);
    if (
      permissions.some(
        (permission) => !Value.Check(InvestigationAccountPermissionSchema, permission),
      )
    ) {
      invalidAccount("Account permissions contain an unsupported permission.");
    }
  }
  if (input.actionCapabilities !== undefined) {
    const actions = listOfStrings(input.actionCapabilities, "actionCapabilities", 32);
    if (actions.some((action) => !Value.Check(InvestigationActionKindSchema, action))) {
      invalidAccount("Account action capabilities contain an unsupported action.");
    }
  }
}

function accountFromRow(row: AccountRow): InvestigationPasswordAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    isAdmin: row.is_admin === 1,
    enabled: row.enabled === 1,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    repositoryIds: JSON.parse(String(row.repository_ids)) as string[],
    permissions: JSON.parse(String(row.permissions)) as InvestigationPasswordPermission[],
    actionCapabilities: JSON.parse(String(row.action_capabilities)) as InvestigationActionKind[],
    allowRepositoryExecution: row.allow_repository_execution === 1,
  };
}

function digestToken(token: string): string | null {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/u.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : null;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    (error.errcode === 1555 || error.errcode === 2067)
  );
}

/** Owns account credentials and revocable sessions in an independent SQLite database. */
export class InvestigationPasswordStore {
  readonly #database: DatabaseSync;
  readonly #kdf: InvestigationPasswordKdf;
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  #closed = false;

  constructor(path = ":memory:", options: InvestigationPasswordStoreOptions = {}) {
    this.#sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.#sessionTtlMs) ||
      this.#sessionTtlMs < 1 ||
      this.#sessionTtlMs > 30 * 24 * 60 * 60 * 1_000
    ) {
      invalidAccount("Session lifetime must be a positive integer of at most 30 days.");
    }
    this.#now = options.now ?? Date.now;
    this.#kdf = new InvestigationPasswordKdf({
      ...(options.maxKdfConcurrency === undefined
        ? {}
        : { maxConcurrency: options.maxKdfConcurrency }),
      ...(options.maxKdfQueue === undefined ? {} : { maxQueue: options.maxKdfQueue }),
    });
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
    try {
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.transaction(() => this.initializeSchema());
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA synchronous = FULL");
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async initializeBootstrap(
    input?: InvestigationPasswordAccountInput,
  ): Promise<InvestigationPasswordAccount | null> {
    if (this.accountCount() !== 0) return null;
    if (input === undefined) {
      throw new InvestigationPasswordStoreError(
        "bootstrap_required",
        "An empty authentication database requires bootstrap administrator credentials.",
      );
    }
    const candidate = this.newAccount({ ...input, isAdmin: true, enabled: true });
    const passwordHash = await this.hashPassword(input.password);
    return this.transaction(() => {
      if (this.accountCount() !== 0) return null;
      this.insertAccount(candidate, passwordHash);
      return candidate;
    });
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<(InvestigationPasswordSession & { token: string }) | null> {
    let normalized: string | null = null;
    try {
      normalized = normalizeInvestigationUsername(username);
    } catch (error) {
      if (!(error instanceof InvestigationPasswordStoreError)) throw error;
    }
    const before =
      normalized === null
        ? undefined
        : this.#database
            .prepare("SELECT * FROM investigation_password_accounts WHERE username = ?")
            .get(normalized);
    const passwordHash = before?.enabled === 1 ? String(before.password_hash) : null;
    if (!(await this.verifyPassword(password, passwordHash)) || before === undefined) return null;
    return this.transaction(() => {
      const current = this.accountRow(String(before.id));
      if (
        current === undefined ||
        current.enabled !== 1 ||
        current.version !== before.version ||
        current.password_hash !== before.password_hash
      ) {
        return null;
      }
      const now = this.now();
      const expiresAt = new Date(now + this.#sessionTtlMs).toISOString();
      const token = randomBytes(32).toString("base64url");
      this.#database
        .prepare(`INSERT INTO investigation_password_sessions
        (token_sha256, account_id, account_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(
          digestToken(token),
          current.id ?? null,
          current.version ?? null,
          new Date(now).toISOString(),
          expiresAt,
        );
      return { account: accountFromRow(current), token, expiresAt };
    });
  }

  getSession(token: string): InvestigationPasswordSession | null {
    const digest = digestToken(token);
    if (digest === null) return null;
    const now = new Date(this.now()).toISOString();
    const row = this.#database
      .prepare(`SELECT accounts.*, sessions.expires_at AS session_expires_at
      FROM investigation_password_sessions AS sessions
      JOIN investigation_password_accounts AS accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_sha256 = ? AND sessions.account_version = accounts.version
        AND accounts.enabled = 1 AND sessions.created_at <= ? AND sessions.expires_at > ?`)
      .get(digest, now, now);
    return row === undefined
      ? null
      : {
          account: accountFromRow(row),
          expiresAt: String(row.session_expires_at),
        };
  }

  getAccount(id: string): InvestigationPasswordAccount | null {
    const row = this.accountRow(id);
    return row === undefined ? null : accountFromRow(row);
  }

  listAccounts(): InvestigationPasswordAccount[] {
    return this.#database
      .prepare("SELECT * FROM investigation_password_accounts ORDER BY username")
      .all()
      .map(accountFromRow);
  }

  listAccountsForAdmin(actor: InvestigationPasswordActor): InvestigationPasswordAccount[] {
    return this.transaction(() => {
      this.assertActor(actor, true);
      return this.listAccounts();
    });
  }

  async createAccount(
    actor: InvestigationPasswordActor,
    input: InvestigationPasswordAccountInput,
  ): Promise<InvestigationPasswordAccount> {
    this.assertActor(actor, true);
    const account = this.newAccount(input);
    const passwordHash = await this.hashPassword(input.password);
    return this.transaction(() => {
      this.assertActor(actor, true);
      this.insertAccount(account, passwordHash);
      return account;
    });
  }

  updateAccount(
    actor: InvestigationPasswordActor,
    id: string,
    expectedVersion: number,
    updates: InvestigationPasswordAccountUpdates,
  ): InvestigationPasswordAccount {
    validateFields(updates);
    if (Object.keys(updates).length === 0) invalidAccount("Account updates must not be empty.");
    return this.transaction(() => {
      this.assertActor(actor, true);
      const current = this.requireAccount(id, expectedVersion);
      const next = {
        ...current,
        ...updates,
        displayName: updates.displayName?.trim() ?? current.displayName,
        repositoryIds: [...(updates.repositoryIds ?? current.repositoryIds)],
        permissions: [...(updates.permissions ?? current.permissions)],
        actionCapabilities: [...(updates.actionCapabilities ?? current.actionCapabilities)],
        version: this.nextVersion(current.version),
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.protectLastAdministrator(current, next);
      this.writeAccount(next, expectedVersion);
      this.revokeAccountSessions(id);
      return next;
    });
  }

  async adminResetPassword(
    actor: InvestigationPasswordActor,
    id: string,
    expectedVersion: number,
    newPassword: string,
  ): Promise<InvestigationPasswordAccount> {
    this.assertActor(actor, true);
    this.requireAccount(id, expectedVersion);
    const passwordHash = await this.hashPassword(newPassword);
    return this.transaction(() => {
      this.assertActor(actor, true);
      const current = this.requireAccount(id, expectedVersion);
      return this.replacePassword(current, passwordHash);
    });
  }

  async changeOwnPassword(
    actor: InvestigationPasswordActor,
    currentPassword: string,
    newPassword: string,
  ): Promise<InvestigationPasswordAccount> {
    this.assertActor(actor, false);
    const before = this.accountRow(actor.id);
    if (before === undefined)
      throw new InvestigationPasswordStoreError("unauthorized", "Authentication is required.");
    if (!(await this.verifyPassword(currentPassword, String(before.password_hash)))) {
      throw new InvestigationPasswordStoreError("unauthorized", "Current password is incorrect.");
    }
    const passwordHash = await this.hashPassword(newPassword);
    return this.transaction(() => {
      this.assertActor(actor, false);
      const current = this.requireAccount(actor.id, actor.version);
      return this.replacePassword(current, passwordHash);
    });
  }

  /** Offline recovery for an existing administrator; no HTTP route may expose this operation. */
  async resetAdministratorOffline(
    username: string,
    newPassword: string,
  ): Promise<InvestigationPasswordAccount> {
    const normalized = normalizeInvestigationUsername(username);
    const before = this.#database
      .prepare("SELECT * FROM investigation_password_accounts WHERE username = ?")
      .get(normalized);
    if (before === undefined || before.enabled !== 1 || before.is_admin !== 1) {
      throw new InvestigationPasswordStoreError(
        "forbidden",
        "Offline recovery requires an existing enabled administrator account.",
      );
    }
    const passwordHash = await this.hashPassword(newPassword);
    return this.transaction(() => {
      const current = this.requireAccount(String(before.id), Number(before.version));
      if (!current.enabled || !current.isAdmin) {
        throw new InvestigationPasswordStoreError(
          "forbidden",
          "Offline recovery requires an existing enabled administrator account.",
        );
      }
      return this.replacePassword(current, passwordHash);
    });
  }

  logout(token: string): void {
    const digest = digestToken(token);
    if (digest !== null)
      this.#database
        .prepare("DELETE FROM investigation_password_sessions WHERE token_sha256 = ?")
        .run(digest);
  }

  reapExpired(): void {
    this.#database
      .prepare("DELETE FROM investigation_password_sessions WHERE expires_at <= ?")
      .run(new Date(this.now()).toISOString());
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  private now(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - this.#sessionTtlMs) {
      throw new Error("The authentication clock returned an invalid time.");
    }
    // Persist observed time atomically so a restart or a second connection cannot revive expiry.
    const row = this.#database
      .prepare(`UPDATE investigation_password_clock
      SET last_observed_at = max(last_observed_at, ?) WHERE singleton = 1
      RETURNING last_observed_at`)
      .get(now);
    if (row === undefined) {
      throw new InvestigationPasswordStoreError(
        "incompatible_schema",
        "The authentication clock is missing.",
      );
    }
    return Number(row.last_observed_at);
  }

  private accountCount(): number {
    return Number(
      this.#database.prepare("SELECT count(*) AS count FROM investigation_password_accounts").get()
        ?.count,
    );
  }

  private accountRow(id: string): AccountRow | undefined {
    return this.#database
      .prepare("SELECT * FROM investigation_password_accounts WHERE id = ?")
      .get(id);
  }

  private assertActor(actor: InvestigationPasswordActor, administrator: boolean): void {
    const current = this.accountRow(actor.id);
    if (current === undefined || current.enabled !== 1 || current.version !== actor.version) {
      throw new InvestigationPasswordStoreError(
        "unauthorized",
        "The account session is no longer current.",
      );
    }
    if (administrator && current.is_admin !== 1) {
      throw new InvestigationPasswordStoreError("forbidden", "Administrator access is required.");
    }
  }

  private requireAccount(id: string, version: number): InvestigationPasswordAccount {
    const row = this.accountRow(id);
    if (row === undefined)
      throw new InvestigationPasswordStoreError("not_found", "Account was not found.");
    if (!Number.isSafeInteger(version) || version < 1)
      invalidAccount("Expected version must be a positive integer.");
    if (row.version !== version)
      throw new InvestigationPasswordStoreError("conflict", "Account version has changed.");
    return accountFromRow(row);
  }

  private newAccount(input: InvestigationPasswordAccountInput): InvestigationPasswordAccount {
    const { password: _password, ...fields } = input;
    validateFields(fields, true);
    const username = normalizeInvestigationUsername(input.username);
    const now = new Date(this.now()).toISOString();
    return {
      id: randomUUID(),
      username,
      displayName: input.displayName?.trim() ?? username,
      isAdmin: input.isAdmin ?? false,
      enabled: input.enabled ?? true,
      version: 1,
      createdAt: now,
      updatedAt: now,
      repositoryIds: [...(input.repositoryIds ?? [])],
      permissions: [...(input.permissions ?? [])],
      actionCapabilities: [...(input.actionCapabilities ?? [])],
      allowRepositoryExecution: input.allowRepositoryExecution ?? false,
    };
  }

  private insertAccount(account: InvestigationPasswordAccount, passwordHash: string): void {
    try {
      this.#database
        .prepare(`INSERT INTO investigation_password_accounts
        (id, username, display_name, password_hash, is_admin, enabled, version, created_at,
         updated_at, repository_ids, permissions, action_capabilities, allow_repository_execution)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          account.id,
          account.username,
          account.displayName,
          passwordHash,
          Number(account.isAdmin),
          Number(account.enabled),
          account.version,
          account.createdAt,
          account.updatedAt,
          JSON.stringify(account.repositoryIds),
          JSON.stringify(account.permissions),
          JSON.stringify(account.actionCapabilities),
          Number(account.allowRepositoryExecution),
        );
    } catch (error) {
      if (isUniqueConflict(error))
        throw new InvestigationPasswordStoreError("conflict", "Username is already in use.");
      throw error;
    }
  }

  private writeAccount(account: InvestigationPasswordAccount, expectedVersion: number): void {
    try {
      const result = this.#database
        .prepare(`UPDATE investigation_password_accounts SET
        username = ?, display_name = ?, is_admin = ?, enabled = ?, version = ?, updated_at = ?,
        repository_ids = ?, permissions = ?, action_capabilities = ?, allow_repository_execution = ?
        WHERE id = ? AND version = ?`)
        .run(
          account.username,
          account.displayName,
          Number(account.isAdmin),
          Number(account.enabled),
          account.version,
          account.updatedAt,
          JSON.stringify(account.repositoryIds),
          JSON.stringify(account.permissions),
          JSON.stringify(account.actionCapabilities),
          Number(account.allowRepositoryExecution),
          account.id,
          expectedVersion,
        );
      if (result.changes !== 1)
        throw new InvestigationPasswordStoreError("conflict", "Account version has changed.");
    } catch (error) {
      if (isUniqueConflict(error))
        throw new InvestigationPasswordStoreError("conflict", "Username is already in use.");
      throw error;
    }
  }

  private nextVersion(version: number): number {
    if (version === Number.MAX_SAFE_INTEGER)
      throw new InvestigationPasswordStoreError("conflict", "Account version limit was reached.");
    return version + 1;
  }

  private protectLastAdministrator(
    current: InvestigationPasswordAccount,
    next: InvestigationPasswordAccount,
  ): void {
    if (!current.enabled || !current.isAdmin || (next.enabled && next.isAdmin)) return;
    const count = Number(
      this.#database
        .prepare(`SELECT count(*) AS count
      FROM investigation_password_accounts WHERE enabled = 1 AND is_admin = 1`)
        .get()?.count,
    );
    if (count <= 1)
      throw new InvestigationPasswordStoreError(
        "last_admin",
        "The last enabled administrator cannot be disabled or demoted.",
      );
  }

  private replacePassword(
    current: InvestigationPasswordAccount,
    passwordHash: string,
  ): InvestigationPasswordAccount {
    const next = {
      ...current,
      version: this.nextVersion(current.version),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const result = this.#database
      .prepare(`UPDATE investigation_password_accounts
      SET password_hash = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .run(passwordHash, next.version, next.updatedAt, current.id, current.version);
    if (result.changes !== 1)
      throw new InvestigationPasswordStoreError("conflict", "Account version has changed.");
    this.revokeAccountSessions(current.id);
    return next;
  }

  private revokeAccountSessions(id: string): void {
    this.#database
      .prepare("DELETE FROM investigation_password_sessions WHERE account_id = ?")
      .run(id);
  }

  private async hashPassword(password: string): Promise<string> {
    try {
      return await this.#kdf.hash(password);
    } catch (error) {
      if (error instanceof InvestigationPasswordKdfError)
        throw new InvestigationPasswordStoreError(error.code, error.message);
      throw error;
    }
  }

  private async verifyPassword(password: string, encoded: string | null): Promise<boolean> {
    try {
      return await this.#kdf.verify(password, encoded);
    } catch (error) {
      if (error instanceof InvestigationPasswordKdfError)
        throw new InvestigationPasswordStoreError(error.code, error.message);
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private initializeSchema(): void {
    const objects = this.#database
      .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
      .all();
    if (objects.length === 0) {
      for (const definition of definitions.values()) this.#database.exec(definition);
      this.#database
        .prepare("INSERT INTO investigation_password_metadata VALUES (?)")
        .run(investigationPasswordSchemaVersion);
      this.#database.exec("INSERT INTO investigation_password_clock VALUES (1, 0)");
      return;
    }
    const normalize = (definition: string) => definition.replace(/\s+/gu, " ").trim().toLowerCase();
    if (
      objects.length !== definitions.size ||
      objects.some((object) => {
        const expected = definitions.get(String(object.name));
        return (
          expected === undefined ||
          typeof object.sql !== "string" ||
          normalize(object.sql) !== normalize(expected)
        );
      })
    ) {
      throw new InvestigationPasswordStoreError(
        "incompatible_schema",
        "The authentication database has an incompatible schema. Configure a new empty password authentication database; existing databases are not migrated.",
      );
    }
    const markers = this.#database
      .prepare("SELECT version FROM investigation_password_metadata")
      .all();
    if (markers.length !== 1 || markers[0]?.version !== investigationPasswordSchemaVersion) {
      throw new InvestigationPasswordStoreError(
        "incompatible_schema",
        "The password authentication schema identity is incompatible.",
      );
    }
  }
}
