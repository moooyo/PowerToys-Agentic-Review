import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../dist/database/migrations.js";
import { findOperatorSession } from "../../dist/database/operator-auth.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator session lookup", () => {
  it("keeps valid-format token and browser misses completely read-only", async () => {
    const { database } = await createDatabase();
    try {
      const liveBrowser = sha256("live-browser");
      const liveSession = sha256("live-session");
      database
        .prepare(`
          INSERT INTO operator_browser_flows (
            browser_sha256, generation, created_at, updated_at, expires_at
          ) VALUES (?, 1, ?, ?, ?)
        `)
        .run(
          liveBrowser,
          "2098-01-01T00:00:00.000Z",
          "2098-01-01T00:00:00.000Z",
          "2099-01-01T00:00:00.000Z",
        );
      database
        .prepare(`
          INSERT INTO operator_sessions (
            token_sha256, issuer, subject, display_name, email, created_at, expires_at,
            browser_sha256, browser_generation
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 1)
        `)
        .run(
          liveSession,
          "https://identity.example.test",
          "operator-123",
          "2098-01-01T00:00:00.000Z",
          "2099-01-01T00:00:00.000Z",
          liveBrowser,
        );
      const clockBefore = readClock(database);
      const changesBefore = readTotalChanges(database);

      for (let index = 0; index < 256; index += 1) {
        expect(
          findOperatorSession(database, {
            tokenSha256: sha256(`missing-session-${index}`),
            browserSha256: index % 2 === 0 ? null : sha256(`missing-browser-${index}`),
          }),
        ).toEqual({ session: null });
      }
      expect(
        findOperatorSession(database, {
          tokenSha256: liveSession,
          browserSha256: sha256("wrong-browser"),
        }),
      ).toEqual({ session: null });

      expect(readClock(database)).toBe(clockBefore);
      expect(readTotalChanges(database)).toBe(changesBefore);
      expect(
        database
          .prepare(
            "SELECT token_sha256 AS tokenSha256 FROM operator_sessions WHERE token_sha256 = ?",
          )
          .get(liveSession),
      ).toEqual({ tokenSha256: liveSession });
    } finally {
      database.close();
    }
  });

  it("uses the persisted clock high-water mark and deletes an expired candidate atomically", async () => {
    const { database } = await createDatabase();
    try {
      const browserSha256 = sha256("clock-browser");
      const sessionSha256 = sha256("clock-session");
      database
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
      database
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
      database
        .prepare("UPDATE operator_auth_clock SET last_observed_at = ? WHERE singleton = 1")
        .run("2099-01-01T00:00:00.000Z");

      expect(findOperatorSession(database, { tokenSha256: sessionSha256, browserSha256 })).toEqual({
        session: null,
      });
      expect(readClock(database)).toBe("2099-01-01T00:00:00.000Z");
      expect(
        database
          .prepare("SELECT 1 AS present FROM operator_sessions WHERE token_sha256 = ?")
          .get(sessionSha256),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back the clock advance when invalid candidate cleanup fails", async () => {
    const { database } = await createDatabase();
    try {
      const sessionSha256 = sha256("rollback-session");
      database
        .prepare(`
          INSERT INTO operator_sessions (
            token_sha256, issuer, subject, display_name, email, created_at, expires_at,
            browser_sha256, browser_generation
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
        `)
        .run(
          sessionSha256,
          "urn:agentic-review:development",
          "operator-rollback",
          "2000-01-01T00:00:00.000Z",
          "2001-01-01T00:00:00.000Z",
        );
      database
        .prepare("UPDATE operator_auth_clock SET last_observed_at = ? WHERE singleton = 1")
        .run("2000-01-01T00:00:00.000Z");
      database.exec(`
        CREATE TRIGGER reject_operator_session_delete
        BEFORE DELETE ON operator_sessions
        WHEN OLD.token_sha256 = '${sessionSha256}'
        BEGIN
          SELECT RAISE(ABORT, 'injected session delete failure');
        END;
      `);

      expect(() =>
        findOperatorSession(database, { tokenSha256: sessionSha256, browserSha256: null }),
      ).toThrow(/injected session delete failure/u);
      expect(readClock(database)).toBe("2000-01-01T00:00:00.000Z");
      expect(
        database
          .prepare("SELECT 1 AS present FROM operator_sessions WHERE token_sha256 = ?")
          .get(sessionSha256),
      ).toEqual({ present: 1 });
    } finally {
      database.close();
    }
  });
});

const createDatabase = async (): Promise<{ readonly database: DatabaseSync }> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-auth-session-"));
  temporaryDirectories.push(directory);
  const database = new DatabaseSync(join(directory, "state.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationsDirectory);
  return { database };
};

const readClock = (database: DatabaseSync): string => {
  const row = database
    .prepare(
      "SELECT last_observed_at AS lastObservedAt FROM operator_auth_clock WHERE singleton = 1",
    )
    .get() as { readonly lastObservedAt: string };
  return row.lastObservedAt;
};

const readTotalChanges = (database: DatabaseSync): number => {
  const row = database.prepare("SELECT total_changes() AS totalChanges").get() as {
    readonly totalChanges: number;
  };
  return row.totalChanges;
};
