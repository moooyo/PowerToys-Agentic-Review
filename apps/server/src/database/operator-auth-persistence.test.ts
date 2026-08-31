import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseOperatorAuthPersistence } from "../../dist/database/operator-auth-persistence.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));

interface Fixture {
  readonly client: DatabaseClient;
  readonly databasePath: string;
  readonly directory: string;
}

const fixtures: Fixture[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const createFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-operator-auth-"));
  const databasePath = join(directory, "server.sqlite");
  try {
    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    const fixture = { client, databasePath, directory };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.client.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

describe("DatabaseOperatorAuthPersistence", () => {
  it("claims a transaction once and fences an older generation before finalization", async () => {
    const { client } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const browserSha256 = sha256("browser-binding");
    const firstTransaction = sha256("first-transaction");
    const secondTransaction = sha256("second-transaction");
    const transactionExpiresAt = "2099-08-30T10:05:00.000Z";
    const browserExpiresAt = "2099-08-30T11:00:00.000Z";

    await expect(
      persistence.beginLogin({
        transactionTokenSha256: firstTransaction,
        browserSha256,
        transactionExpiresAt,
        browserExpiresAt,
      }),
    ).resolves.toMatchObject({ browserGeneration: 1 });
    await expect(
      persistence.finalizeLogin({
        transactionTokenSha256: firstTransaction,
        sessionTokenSha256: sha256("unclaimed-session"),
        browserSha256,
        browserGeneration: 1,
        issuer: "https://identity.example.test",
        subject: "operator-123",
        displayName: null,
        email: null,
        createdAt: "2099-08-30T10:01:00.000Z",
        expiresAt: "2099-08-30T11:01:00.000Z",
      }),
    ).resolves.toBe(false);
    const claimResults = await Promise.all([
      persistence.claimLoginTransaction({
        transactionTokenSha256: firstTransaction,
        browserSha256,
      }),
      persistence.claimLoginTransaction({
        transactionTokenSha256: firstTransaction,
        browserSha256,
      }),
    ]);
    expect(claimResults.filter((result) => result === 1)).toHaveLength(1);
    expect(claimResults.filter((result) => result === null)).toHaveLength(1);

    await expect(
      persistence.beginLogin({
        transactionTokenSha256: secondTransaction,
        browserSha256,
        transactionExpiresAt: "2099-08-30T10:07:00.000Z",
        browserExpiresAt: "2099-08-30T11:02:00.000Z",
      }),
    ).resolves.toMatchObject({ browserGeneration: 2 });
    await expect(
      persistence.finalizeLogin({
        transactionTokenSha256: firstTransaction,
        sessionTokenSha256: sha256("stale-session"),
        browserSha256,
        browserGeneration: 1,
        issuer: "https://identity.example.test",
        subject: "operator-123",
        displayName: null,
        email: null,
        createdAt: "2099-08-30T10:03:00.000Z",
        expiresAt: "2099-08-30T11:03:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("rolls back a consumed login transaction when session insertion fails", async () => {
    const { client, databasePath } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const browserSha256 = sha256("rollback-browser-binding");
    const transactionTokenSha256 = sha256("rollback-transaction");
    const conflictingSessionSha256 = sha256("rollback-session");

    await persistence.beginLogin({
      transactionTokenSha256,
      browserSha256,
      transactionExpiresAt: "2099-08-30T10:05:00.000Z",
      browserExpiresAt: "2099-08-30T11:00:00.000Z",
    });
    await expect(
      persistence.claimLoginTransaction({ transactionTokenSha256, browserSha256 }),
    ).resolves.toBe(1);
    await persistence.createSession({
      tokenSha256: conflictingSessionSha256,
      browserSha256: null,
      browserGeneration: null,
      issuer: "urn:agentic-review:test",
      subject: "conflicting-session",
      displayName: null,
      email: null,
      createdAt: "2099-08-30T10:01:00.000Z",
      expiresAt: "2099-08-30T11:01:00.000Z",
    });

    await expect(
      persistence.finalizeLogin({
        transactionTokenSha256,
        sessionTokenSha256: conflictingSessionSha256,
        browserSha256,
        browserGeneration: 1,
        issuer: "https://identity.example.test",
        subject: "operator-123",
        displayName: null,
        email: null,
        createdAt: "2099-08-30T10:02:00.000Z",
        expiresAt: "2099-08-30T11:02:00.000Z",
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: operator_sessions\.token_sha256/u);

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        reader
          .prepare(`
            SELECT
              browser_generation AS browserGeneration,
              claimed_at AS claimedAt
            FROM operator_login_transactions
            WHERE token_sha256 = ?
          `)
          .get(transactionTokenSha256),
      ).toMatchObject({ browserGeneration: 1, claimedAt: expect.any(String) });
      expect(
        reader
          .prepare("SELECT subject FROM operator_sessions WHERE token_sha256 = ?")
          .get(conflictingSessionSha256),
      ).toEqual({ subject: "conflicting-session" });
    } finally {
      reader.close();
    }
    await expect(
      persistence.claimLoginTransaction({ transactionTokenSha256, browserSha256 }),
    ).resolves.toBeNull();
  });

  it("invalidates an older browser-bound session when a new login begins", async () => {
    const { client } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const browserSha256 = sha256("browser-binding");
    const firstTransaction = sha256("first-transaction");
    const firstSession = sha256("first-session");
    const secondTransaction = sha256("second-transaction");
    const browserExpiresAt = "2099-08-30T13:00:00.000Z";

    await persistence.beginLogin({
      transactionTokenSha256: firstTransaction,
      browserSha256,
      transactionExpiresAt: "2099-08-30T12:05:00.000Z",
      browserExpiresAt,
    });
    await expect(
      persistence.claimLoginTransaction({
        transactionTokenSha256: firstTransaction,
        browserSha256,
      }),
    ).resolves.toBe(1);
    await expect(
      persistence.finalizeLogin({
        transactionTokenSha256: firstTransaction,
        sessionTokenSha256: firstSession,
        browserSha256,
        browserGeneration: 1,
        issuer: "https://identity.example.test",
        subject: "operator-123",
        displayName: "Review Operator",
        email: "operator@example.test",
        createdAt: "2099-08-30T12:01:00.000Z",
        expiresAt: browserExpiresAt,
      }),
    ).resolves.toBe(true);
    await expect(
      persistence.findSession({
        tokenSha256: firstSession,
        browserSha256,
      }),
    ).resolves.toMatchObject({ subject: "operator-123" });

    await persistence.beginLogin({
      transactionTokenSha256: secondTransaction,
      browserSha256,
      transactionExpiresAt: "2099-08-30T12:08:00.000Z",
      browserExpiresAt: "2099-08-30T13:03:00.000Z",
    });
    await expect(
      persistence.findSession({
        tokenSha256: firstSession,
        browserSha256,
      }),
    ).resolves.toBeNull();

    await persistence.deleteBrowserFlow({ browserSha256 });
    await expect(
      persistence.claimLoginTransaction({
        transactionTokenSha256: secondTransaction,
        browserSha256,
      }),
    ).resolves.toBeNull();
  });

  it("rejects an expired transaction claim without marking it claimed", async () => {
    const { client, databasePath } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const browserSha256 = sha256("expired-browser-binding");
    const transactionTokenSha256 = sha256("expired-transaction");
    await persistence.beginLogin({
      transactionTokenSha256,
      browserSha256,
      transactionExpiresAt: "2099-08-30T12:05:00.000Z",
      browserExpiresAt: "2099-08-30T13:00:00.000Z",
    });

    const writer = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      writer
        .prepare("UPDATE operator_auth_clock SET last_observed_at = ? WHERE singleton = 1")
        .run("2099-08-30T12:05:00.000Z");
    } finally {
      writer.close();
    }

    await expect(
      persistence.claimLoginTransaction({ transactionTokenSha256, browserSha256 }),
    ).resolves.toBeNull();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        reader
          .prepare(
            "SELECT claimed_at AS claimedAt FROM operator_login_transactions WHERE token_sha256 = ?",
          )
          .get(transactionTokenSha256),
      ).toEqual({ claimedAt: null });
    } finally {
      reader.close();
    }
  });

  it("keeps development sessions unbound and stores only authentication hashes", async () => {
    const { client, databasePath } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const sessionToken = "opaque-session-token-that-must-not-enter-sqlite";
    const sessionHash = sha256(sessionToken);
    await persistence.createSession({
      tokenSha256: sessionHash,
      browserSha256: null,
      browserGeneration: null,
      issuer: "urn:agentic-review:development",
      subject: "operator-456",
      displayName: null,
      email: null,
      createdAt: "2099-08-30T14:00:00.000Z",
      expiresAt: "2099-08-30T15:00:00.000Z",
    });

    await expect(
      persistence.findSession({
        tokenSha256: sessionHash,
        browserSha256: null,
      }),
    ).resolves.toMatchObject({ subject: "operator-456" });

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const persisted = JSON.stringify(reader.prepare("SELECT * FROM operator_sessions").all());
      expect(persisted).toContain(sessionHash);
      expect(persisted).not.toContain(sessionToken);
    } finally {
      reader.close();
    }
  });

  it("uses the persisted database clock high-water mark for expiry decisions", async () => {
    const { client, databasePath } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const browserSha256 = sha256("clock-browser");
    const sessionSha256 = sha256("clock-session");
    const writer = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      writer.exec("PRAGMA foreign_keys = ON");
      writer
        .prepare("UPDATE operator_auth_clock SET last_observed_at = ? WHERE singleton = 1")
        .run("2099-01-01T00:00:00.000Z");
      writer
        .prepare(`
          INSERT INTO operator_browser_flows (
            browser_sha256, generation, created_at, updated_at, expires_at
          ) VALUES (?, 1, ?, ?, ?)
        `)
        .run(
          browserSha256,
          "2049-01-01T00:00:00.000Z",
          "2049-01-01T00:00:00.000Z",
          "2050-01-01T00:00:00.000Z",
        );
      writer
        .prepare(`
          INSERT INTO operator_sessions (
            token_sha256, issuer, subject, display_name, email, created_at, expires_at,
            browser_sha256, browser_generation
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 1)
        `)
        .run(
          sessionSha256,
          "https://identity.example.test",
          "operator-123",
          "2049-01-01T00:00:00.000Z",
          "2050-01-01T00:00:00.000Z",
          browserSha256,
        );
    } finally {
      writer.close();
    }

    await expect(
      persistence.findSession({
        tokenSha256: sessionSha256,
        browserSha256,
      }),
    ).resolves.toBeNull();
    await expect(
      persistence.beginLogin({
        transactionTokenSha256: sha256("clock-transaction"),
        browserSha256,
        transactionExpiresAt: "2050-01-01T00:00:00.000Z",
        browserExpiresAt: "2050-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/authoritative database time/u);
  });
});
