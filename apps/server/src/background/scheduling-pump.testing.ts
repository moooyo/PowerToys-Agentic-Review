import type { DatabaseClient } from "../database/database-client.js";

/** Route fixtures own no scheduling data; background behavior has dedicated transport tests. */
export const createSchedulingTestDatabase = (
  request: (operation: string, input: unknown) => Promise<unknown>,
): DatabaseClient =>
  ({
    request(operation: string, input: unknown): Promise<unknown> {
      if (operation === "dispatchPendingReviewRuns") {
        return Promise.resolve({
          examinedRequestCount: 0,
          createdJobs: [],
          blockedRequestCount: 0,
        });
      }
      if (operation === "admitPendingJobs") {
        return Promise.resolve({ examinedJobCount: 0, admittedJobCount: 0 });
      }
      return request(operation, input);
    },
    subscribeSchedulingChanges: () => () => {},
  }) as unknown as DatabaseClient;
