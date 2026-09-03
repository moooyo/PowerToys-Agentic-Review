import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";
import { purgeOperatorAuthForRecovery } from "../../dist/database/operator-auth.js";
import { DatabaseOperatorAuthPersistence } from "../../dist/database/operator-auth-persistence.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { OperatorAuthService } from "../../dist/security/operator-auth.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const createMigratedDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-operator-recovery-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "server.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationsDirectory);
  return { database, databasePath };
};

const seedOperatorAuthState = (database: DatabaseSync): void => {
  const browserSha256 = sha256("recovery-browser");
  database
    .prepare(`
      INSERT INTO operator_browser_flows (
        browser_sha256, generation, created_at, updated_at, expires_at
      ) VALUES (?, 1, ?, ?, ?)
    `)
    .run(
      browserSha256,
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T02:00:00.000Z",
    );
  database
    .prepare(`
      INSERT INTO operator_login_transactions (
        token_sha256, created_at, expires_at, browser_sha256, browser_generation, claimed_at
      ) VALUES (?, ?, ?, ?, 1, NULL)
    `)
    .run(
      sha256("bound-login"),
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T01:00:00.000Z",
      browserSha256,
    );
  database
    .prepare(`
      INSERT INTO operator_login_transactions (
        token_sha256, created_at, expires_at, browser_sha256, browser_generation, claimed_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL)
    `)
    .run(sha256("unbound-login"), "2099-01-01T00:00:00.000Z", "2099-01-01T01:00:00.000Z");
  const insertSession = database.prepare(`
    INSERT INTO operator_sessions (
      token_sha256,
      issuer,
      subject,
      display_name,
      email,
      created_at,
      expires_at,
      browser_sha256,
      browser_generation
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  insertSession.run(
    sha256("bound-session"),
    "https://issuer.example.test",
    "bound-operator",
    "Bound Operator",
    "2099-01-01T00:00:00.000Z",
    "2099-01-01T02:00:00.000Z",
    browserSha256,
    1,
  );
  insertSession.run(
    sha256("unbound-session"),
    "urn:agentic-review:development",
    "recovery-operator",
    "Recovery Operator",
    "2099-01-01T00:00:00.000Z",
    "2099-01-01T02:00:00.000Z",
    null,
    null,
  );
};

const readOperatorAuthCounts = (database: DatabaseSync) => ({
  browserFlows: (
    database.prepare("SELECT COUNT(*) AS count FROM operator_browser_flows").get() as {
      readonly count: number;
    }
  ).count,
  loginTransactions: (
    database.prepare("SELECT COUNT(*) AS count FROM operator_login_transactions").get() as {
      readonly count: number;
    }
  ).count,
  sessions: (
    database.prepare("SELECT COUNT(*) AS count FROM operator_sessions").get() as {
      readonly count: number;
    }
  ).count,
});

const readOperatorAuthClock = (databasePath: string): string => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT last_observed_at AS value FROM operator_auth_clock WHERE singleton = 1")
      .get() as { readonly value: string } | undefined;
    if (row === undefined) {
      throw new Error("Operator authentication clock is unavailable.");
    }
    return row.value;
  } finally {
    database.close();
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator authentication recovery purge", () => {
  it("atomically purges all login state without changing the clock high-water mark", async () => {
    const { database } = await createMigratedDatabase();
    try {
      seedOperatorAuthState(database);
      const clockBefore = (
        database
          .prepare("SELECT last_observed_at AS value FROM operator_auth_clock WHERE singleton = 1")
          .get() as { readonly value: string }
      ).value;

      expect(purgeOperatorAuthForRecovery(database)).toEqual({
        deletedBrowserFlows: 1,
        deletedLoginTransactions: 2,
        deletedSessions: 2,
      });
      expect(readOperatorAuthCounts(database)).toEqual({
        browserFlows: 0,
        loginTransactions: 0,
        sessions: 0,
      });
      expect(
        database
          .prepare("SELECT last_observed_at AS value FROM operator_auth_clock WHERE singleton = 1")
          .get(),
      ).toEqual({ value: clockBefore });
      expect(purgeOperatorAuthForRecovery(database)).toEqual({
        deletedBrowserFlows: 0,
        deletedLoginTransactions: 0,
        deletedSessions: 0,
      });
    } finally {
      database.close();
    }
  });

  it("rolls back earlier deletes when any purge step fails", async () => {
    const { database } = await createMigratedDatabase();
    try {
      seedOperatorAuthState(database);
      const before = readOperatorAuthCounts(database);
      database.exec(`
        CREATE TRIGGER reject_recovery_session_delete
        BEFORE DELETE ON operator_sessions
        BEGIN
          SELECT RAISE(ABORT, 'injected recovery purge failure');
        END;
      `);

      expect(() => purgeOperatorAuthForRecovery(database)).toThrow(
        /injected recovery purge failure/u,
      );
      expect(readOperatorAuthCounts(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "invalidates an old operator cookie across database Worker restart and permits a fresh login",
    async () => {
      const { database, databasePath } = await createMigratedDatabase();
      database.close();
      if (process.platform !== "win32") {
        await chmod(databasePath, 0o600);
      }
      await writeFile(
        databaseInitializationMarkerPath(databasePath),
        databaseInitializationMarkerContent,
        { mode: 0o600 },
      );

      let client = await DatabaseClient.create({ databasePath, migrationsDirectory });
      const oldToken = Buffer.alloc(32, 1).toString("base64url");
      const newToken = Buffer.alloc(32, 2).toString("base64url");
      const createAuth = (token: string) =>
        new OperatorAuthService({
          config: {
            environment: "development",
            publicOrigin: "http://127.0.0.1:8080",
            loginTransactionTtlSeconds: 600,
            sessionTtlSeconds: 3_600,
            postLoginRedirectPath: "/work-items",
            mode: "loopback-development-bypass",
            developmentIdentity: {
              issuer: "urn:agentic-review:development",
              subject: "recovery-operator",
              displayName: "Recovery Operator",
              email: null,
            },
          },
          persistence: new DatabaseOperatorAuthPersistence(client),
          now: () => new Date("2099-01-01T00:00:00.000Z"),
          generateOpaqueToken: () => token,
        });

      try {
        const initialLogin = await createAuth(oldToken).startLogin();
        expect(initialLogin).toMatchObject({ kind: "session", sessionToken: oldToken });
        await expect(createAuth(newToken).getSession(oldToken)).resolves.toMatchObject({
          subject: "recovery-operator",
        });

        await client.close();
        client = await DatabaseClient.create({ databasePath, migrationsDirectory });
        await expect(createAuth(newToken).getSession(oldToken)).resolves.toMatchObject({
          subject: "recovery-operator",
        });
        const clockBeforePurge = readOperatorAuthClock(databasePath);

        await expect(client.request("purgeOperatorAuthForRecovery", {})).resolves.toEqual({
          deletedBrowserFlows: 0,
          deletedLoginTransactions: 0,
          deletedSessions: 1,
        });
        expect(readOperatorAuthClock(databasePath)).toBe(clockBeforePurge);

        await client.close();
        client = await DatabaseClient.create({ databasePath, migrationsDirectory });
        await expect(createAuth(newToken).getSession(oldToken)).resolves.toBeNull();
        const freshLogin = await createAuth(newToken).startLogin();
        expect(freshLogin).toMatchObject({ kind: "session", sessionToken: newToken });
        await expect(createAuth(oldToken).getSession(newToken)).resolves.toMatchObject({
          subject: "recovery-operator",
        });
      } finally {
        await client.close();
      }
    },
  );
});
