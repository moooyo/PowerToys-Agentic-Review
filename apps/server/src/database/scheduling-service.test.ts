import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";
import {
  ensureRepositorySchedulingStateInTransaction,
  readRepositorySchedulingService,
  recordSuccessfulSchedulingServiceInTransaction,
} from "./scheduling-service.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  return database;
}
function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("successful repository service tickets", () => {
  it("keeps admission and claim history independent and preserves saturated Issue debt", () => {
    const database = open();
    transaction(database, () => {
      for (let index = 0; index < 4; index++)
        recordSuccessfulSchedulingServiceInTransaction(
          database,
          "github:1",
          "claim",
          "pull_request",
        );
      recordSuccessfulSchedulingServiceInTransaction(database, "github:1", "admission", "issue");
    });
    expect(readRepositorySchedulingService(database, "github:1")).toEqual({
      lastAdmissionTicket: 1,
      lastClaimTicket: 4,
      admissionPrStreak: 0,
      claimPrStreak: 2,
    });
    transaction(database, () =>
      recordSuccessfulSchedulingServiceInTransaction(database, "github:1", "claim", "issue"),
    );
    expect(readRepositorySchedulingService(database, "github:1")).toEqual({
      lastAdmissionTicket: 1,
      lastClaimTicket: 5,
      admissionPrStreak: 0,
      claimPrStreak: 0,
    });
  });

  it("initializes new buckets at current independent sequences without resetting idle history", () => {
    const database = open();
    transaction(database, () => {
      ensureRepositorySchedulingStateInTransaction(database, "github:1");
      recordSuccessfulSchedulingServiceInTransaction(
        database,
        "github:1",
        "admission",
        "pull_request",
      );
      for (let index = 0; index < 3; index++)
        recordSuccessfulSchedulingServiceInTransaction(
          database,
          "github:1",
          "claim",
          "pull_request",
        );
      ensureRepositorySchedulingStateInTransaction(database, "github:2");
      ensureRepositorySchedulingStateInTransaction(database, "github:1");
    });
    expect(readRepositorySchedulingService(database, "github:2")).toEqual({
      lastAdmissionTicket: 1,
      lastClaimTicket: 3,
      admissionPrStreak: 0,
      claimPrStreak: 0,
    });
    expect(readRepositorySchedulingService(database, "github:1").claimPrStreak).toBe(2);
  });

  it("rolls back the service allocation and debt update with the surrounding grant", () => {
    const database = open();
    transaction(database, () => ensureRepositorySchedulingStateInTransaction(database, "github:1"));
    const before = database.prepare("SELECT * FROM scheduling_state").get();
    expect(() =>
      transaction(database, () => {
        recordSuccessfulSchedulingServiceInTransaction(
          database,
          "github:1",
          "claim",
          "pull_request",
        );
        throw new Error("Synthetic lease insertion failure");
      }),
    ).toThrow("Synthetic lease insertion failure");
    expect(database.prepare("SELECT * FROM scheduling_state").get()).toEqual(before);
    expect(readRepositorySchedulingService(database, "github:1")).toEqual({
      lastAdmissionTicket: 0,
      lastClaimTicket: 0,
      admissionPrStreak: 0,
      claimPrStreak: 0,
    });
  });

  it("fails sequence exhaustion without consuming class service or creating a lease", () => {
    const database = open();
    transaction(database, () => ensureRepositorySchedulingStateInTransaction(database, "github:1"));
    database
      .prepare("UPDATE scheduling_state SET successful_claim_sequence = ?")
      .run(Number.MAX_SAFE_INTEGER);
    const before = readRepositorySchedulingService(database, "github:1");
    expect(() =>
      transaction(database, () =>
        recordSuccessfulSchedulingServiceInTransaction(
          database,
          "github:1",
          "claim",
          "pull_request",
        ),
      ),
    ).toThrow(/sequence is exhausted/u);
    expect(readRepositorySchedulingService(database, "github:1")).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
  });
});
