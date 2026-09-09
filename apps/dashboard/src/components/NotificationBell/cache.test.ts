import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { discardNotificationQueries } from "./cache";

describe("notification cache invalidation", () => {
  it("removes repository events and global counters while preventing a late response from restoring them", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const summaryKey = ["notifications", "global-session", "summary", null];
    const listKey = ["notifications", "repository-session", "list", "repository-a"];
    client.setQueryData(summaryKey, { unreadCount: 42 });
    client.setQueryData(listKey, { privateEvent: "previous operator" });
    client.setQueryData(["unrelated"], "preserved");
    let resolve: (value: unknown) => void = () => {
      throw new Error("The request did not start.");
    };
    let signal: AbortSignal | undefined;
    const pending = client
      .fetchQuery({
        queryKey: listKey,
        queryFn: (context) => {
          signal = context.signal;
          return new Promise((done) => {
            resolve = done;
          });
        },
      })
      .catch((error: unknown) => error);
    discardNotificationQueries(client);
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(summaryKey)).toBeUndefined();
    expect(client.getQueryData(listKey)).toBeUndefined();
    resolve({ privateEvent: "late old operator result" });
    await pending;
    expect(client.getQueriesData({ queryKey: ["notifications"] })).toEqual([]);
    expect(client.getQueryData(["unrelated"])).toBe("preserved");
    client.clear();
  });
});
