import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../dist/database/migrations.js";
import { cleanupExpiredOperatorAuth } from "../../dist/database/operator-auth.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator authentication cleanup", () => {
  it("deletes expired records in bounded batches and preserves active records", async () => {
    const directory = await createTemporaryDirectory();
    const database = new DatabaseSync(join(directory, "state.sqlite"));
    try {
      database.exec("PRAGMA foreign_keys = ON");
      runMigrations(database, migrationsDirectory);
      const expiredAt = "2000-01-02T00:00:00.000Z";
      const insertLogin = database.prepare(`
        INSERT INTO operator_login_transactions (
          token_sha256, created_at, expires_at, browser_sha256, browser_generation, claimed_at
        ) VALUES (?, ?, ?, ?, 1, ?)
      `);
      const insertSession = database.prepare(`
        INSERT INTO operator_sessions (
          token_sha256, issuer, subject, display_name, email, created_at, expires_at,
          browser_sha256, browser_generation
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 1)
      `);
      const insertBrowser = database.prepare(`
        INSERT INTO operator_browser_flows (
          browser_sha256, generation, created_at, updated_at, expires_at
        ) VALUES (?, 1, ?, ?, ?)
      `);
      for (let index = 0; index < 3; index += 1) {
        const token = index.toString(16).padStart(64, "0");
        const browser = (index + 10).toString(16).padStart(64, "0");
        insertBrowser.run(
          browser,
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
          expiredAt,
        );
        insertLogin.run(
          token,
          "2000-01-01T00:00:00.000Z",
          expiredAt,
          browser,
          "2000-01-01T12:00:00.000Z",
        );
        insertSession.run(
          token,
          "https://issuer.example",
          `subject-${index}`,
          "2000-01-01T00:00:00.000Z",
          expiredAt,
          browser,
        );
      }
      const activeToken = "f".repeat(64);
      const activeBrowser = "e".repeat(64);
      insertBrowser.run(
        activeBrowser,
        "2000-01-01T00:00:00.000Z",
        expiredAt,
        "2099-01-01T00:00:00.000Z",
      );
      insertSession.run(
        activeToken,
        "https://issuer.example",
        "active-subject",
        expiredAt,
        "2099-01-01T00:00:00.000Z",
        activeBrowser,
      );

      expect(cleanupExpiredOperatorAuth(database, { batchSize: 2 })).toEqual({
        deletedBrowserFlows: 2,
        deletedLoginTransactions: 2,
        deletedSessions: 2,
        hasMore: true,
      });
      expect(cleanupExpiredOperatorAuth(database, { batchSize: 2 })).toEqual({
        deletedBrowserFlows: 1,
        deletedLoginTransactions: 1,
        deletedSessions: 1,
        hasMore: false,
      });
      expect(
        database
          .prepare("SELECT subject FROM operator_sessions WHERE token_sha256 = ?")
          .get(activeToken),
      ).toEqual({ subject: "active-subject" });
      expect(
        database
          .prepare("SELECT generation FROM operator_browser_flows WHERE browser_sha256 = ?")
          .get(activeBrowser),
      ).toEqual({ generation: 1 });
    } finally {
      database.close();
    }
  });
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-auth-cleanup-"));
  temporaryDirectories.push(directory);
  return directory;
};
