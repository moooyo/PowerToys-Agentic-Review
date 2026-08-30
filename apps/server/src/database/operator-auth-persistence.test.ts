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
  it("atomically consumes a live login transaction only once and rejects an expired one", async () => {
    const { client } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const liveHash = sha256("live-login-transaction-token");
    await persistence.createLoginTransaction({
      tokenSha256: liveHash,
      createdAt: "2026-08-30T10:00:00.000Z",
      expiresAt: "2026-08-30T10:05:00.000Z",
    });

    const outcomes = await Promise.all([
      persistence.consumeLoginTransaction({
        tokenSha256: liveHash,
        consumedAt: "2026-08-30T10:01:00.000Z",
      }),
      persistence.consumeLoginTransaction({
        tokenSha256: liveHash,
        consumedAt: "2026-08-30T10:01:00.000Z",
      }),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);

    const expiredHash = sha256("expired-login-transaction-token");
    await persistence.createLoginTransaction({
      tokenSha256: expiredHash,
      createdAt: "2026-08-30T11:00:00.000Z",
      expiresAt: "2026-08-30T11:01:00.000Z",
    });
    await expect(
      persistence.consumeLoginTransaction({
        tokenSha256: expiredHash,
        consumedAt: "2026-08-30T11:01:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("creates, finds, expires, and deletes an operator session", async () => {
    const { client } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const sessionHash = sha256("operator-session-token");
    const session = {
      issuer: "https://identity.example.test",
      subject: "operator-123",
      displayName: "Review Operator",
      email: "operator@example.test",
      createdAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
    } as const;

    await persistence.createSession({ tokenSha256: sessionHash, ...session });
    await expect(
      persistence.findSession({
        tokenSha256: sessionHash,
        accessedAt: "2026-08-30T12:30:00.000Z",
      }),
    ).resolves.toEqual(session);
    await expect(
      persistence.findSession({
        tokenSha256: sessionHash,
        accessedAt: session.expiresAt,
      }),
    ).resolves.toBeNull();

    await persistence.deleteSession({ tokenSha256: sessionHash });
    await persistence.deleteSession({ tokenSha256: sessionHash });
    await expect(
      persistence.findSession({
        tokenSha256: sessionHash,
        accessedAt: "2026-08-30T12:30:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("persists token hashes without persisting opaque authentication tokens", async () => {
    const { client, databasePath } = await createFixture();
    const persistence = new DatabaseOperatorAuthPersistence(client);
    const loginToken = "opaque-login-token-that-must-not-enter-sqlite";
    const sessionToken = "opaque-session-token-that-must-not-enter-sqlite";
    const loginHash = sha256(loginToken);
    const sessionHash = sha256(sessionToken);

    await persistence.createLoginTransaction({
      tokenSha256: loginHash,
      createdAt: "2026-08-30T14:00:00.000Z",
      expiresAt: "2026-08-30T14:05:00.000Z",
    });
    await persistence.createSession({
      tokenSha256: sessionHash,
      issuer: "https://identity.example.test",
      subject: "operator-456",
      displayName: null,
      email: null,
      createdAt: "2026-08-30T14:00:00.000Z",
      expiresAt: "2026-08-30T15:00:00.000Z",
    });

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const loginRows = reader
        .prepare("SELECT * FROM operator_login_transactions")
        .all() as unknown[];
      const sessionRows = reader.prepare("SELECT * FROM operator_sessions").all() as unknown[];
      const persisted = JSON.stringify({ loginRows, sessionRows });

      expect(persisted).toContain(loginHash);
      expect(persisted).toContain(sessionHash);
      expect(persisted).not.toContain(loginToken);
      expect(persisted).not.toContain(sessionToken);
    } finally {
      reader.close();
    }
  });
});
