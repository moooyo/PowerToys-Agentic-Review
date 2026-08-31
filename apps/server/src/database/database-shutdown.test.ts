import { describe, expect, it } from "vitest";
import {
  closeDatabaseStorage,
  completeDatabaseShutdown,
} from "../../dist/database/database-shutdown.js";

describe("completeDatabaseShutdown", () => {
  it("reports success only after the database closes", () => {
    const events: string[] = [];
    completeDatabaseShutdown(
      { close: () => events.push("close") },
      () => events.push("success"),
      () => events.push("error"),
    );
    expect(events).toEqual(["close", "success"]);
  });

  it("reports a close failure without reporting success", () => {
    const closeError = new Error("close failed");
    const events: string[] = [];
    let reportedError: unknown;
    completeDatabaseShutdown(
      {
        close: () => {
          events.push("close");
          throw closeError;
        },
      },
      () => events.push("success"),
      (error) => {
        events.push("error");
        reportedError = error;
      },
    );
    expect(events).toEqual(["close", "error"]);
    expect(reportedError).toBe(closeError);
  });

  it("waits for database shutdown before releasing the owner lock and aggregates failures", async () => {
    const events: string[] = [];
    const databaseClose = Promise.withResolvers<void>();
    const close = closeDatabaseStorage(
      {
        close: async () => {
          events.push("database-start");
          await databaseClose.promise;
          events.push("database-end");
        },
      },
      {
        close: async () => {
          events.push("owner-lock");
        },
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["database-start"]);
    databaseClose.resolve();
    await close;
    expect(events).toEqual(["database-start", "database-end", "owner-lock"]);

    const databaseError = new Error("database close failed");
    const ownerLockError = new Error("owner lock close failed");
    let thrown: unknown;
    try {
      await closeDatabaseStorage(
        { close: async () => Promise.reject(databaseError) },
        { close: async () => Promise.reject(ownerLockError) },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([databaseError, ownerLockError]);
  });
});
