import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
} from "../../services/review-control/errors";
import { PublicationReadGuard } from "./read-guard";

const deniedError = (status: number) =>
  new ReviewControlHttpError("Unavailable", {
    status,
    operation: "publication read",
    retryable: false,
  });
const clientForTest = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const session = ["publications", "operator-repository-session"];

describe("publication terminal read guard with live QueryObservers", () => {
  it.each([401, 403, 404])(
    "retains an observed HTTP %i error and forbids poll, refetch or render storms",
    async (status) => {
      const client = clientForTest(),
        key = [...session, "outbox", "detail", "missing-publication"];
      const guard = new PublicationReadGuard(client, [key]);
      const error = deniedError(status),
        fetch = vi.fn(async () => {
          throw error;
        });
      const options = () => ({
        queryKey: key,
        queryFn: () => guard.read(fetch),
        enabled: !guard.snapshot(),
        retry: false as const,
        refetchInterval: guard.snapshot() ? (false as const) : 5_000,
      });
      const observer = new QueryObserver(client, options());
      const record = client.getQueryCache().find({ queryKey: key });
      const stopGuard = guard.subscribe(() => observer.setOptions(options()));
      const stopObserver = observer.subscribe(() => {});
      await vi.waitFor(() => expect(guard.snapshot()).toBe(true));
      expect(client.getQueryCache().find({ queryKey: key })).toBe(record);
      expect(record?.getObserversCount()).toBe(1);
      expect(record?.state.data).toBeUndefined();
      expect(record?.state.error).toBe(error);
      for (let index = 0; index < 20; index += 1) {
        observer.setOptions(options());
        await observer.refetch();
        await client.invalidateQueries({ queryKey: session });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(guard.snapshot()).toBe(true);
      expect(observer.getCurrentResult().data).toBeUndefined();
      stopGuard();
      stopObserver();
      guard.dispose();
      client.clear();
    },
  );

  it.each([401, 403, 404])(
    "latches denied preview HTTP %i independently of another decision in the same run",
    async (status) => {
      const client = clientForTest();
      const firstKey = [...session, "preview", "repo-a", "run-a", "decision-a"],
        secondKey = [...session, "preview", "repo-a", "run-a", "decision-b"];
      const first = new PublicationReadGuard(client, [firstKey]),
        second = new PublicationReadGuard(client, [secondKey]);
      const firstFetch = vi.fn(async () => {
          throw deniedError(status);
        }),
        secondFetch = vi.fn(async () => ({ body: "second decision" }));
      await expect(first.read(firstFetch)).rejects.toMatchObject({ status });
      await expect(first.read(firstFetch)).rejects.toMatchObject({ status });
      await expect(second.read(secondFetch)).resolves.toEqual({ body: "second decision" });
      expect(firstFetch).toHaveBeenCalledTimes(1);
      expect(first.snapshot()).toBe(true);
      expect(second.snapshot()).toBe(false);
      first.dispose();
      second.dispose();
      client.clear();
    },
  );

  it("cancels sibling attempts and clears their payload without evicting the parent list or another publication", async () => {
    const client = clientForTest();
    const detail = [...session, "outbox", "detail", "missing"],
      attempts = [...session, "outbox", "attempts", "missing"];
    const list = [...session, "outbox", "list", "repo-a"],
      other = [...session, "outbox", "detail", "existing"];
    client.setQueryData(list, { authorizedList: true });
    client.setQueryData(other, { body: "other publication" });
    const guard = new PublicationReadGuard(client, [detail, attempts]);
    let complete: (value: unknown) => void = () => {
      throw new Error("The request did not start.");
    };
    let signal: AbortSignal | undefined;
    const promise = client
      .fetchQuery({
        queryKey: [...attempts, 1],
        queryFn: (context) => {
          signal = context.signal;
          return guard.read(
            () =>
              new Promise((resolve) => {
                complete = resolve;
              }),
          );
        },
      })
      .catch((error: unknown) => error);
    guard.deny(deniedError(404));
    expect(signal?.aborted).toBe(true);
    complete({ body: "late denied attempt body" });
    await promise;
    expect(client.getQueryData([...attempts, 1])).toBeUndefined();
    expect(client.getQueryData(list)).toEqual({ authorizedList: true });
    expect(client.getQueryData(other)).toEqual({ body: "other publication" });
    guard.dispose();
    client.clear();
  });

  it("does not evict a disabled but still observed sibling on cleanup", () => {
    const client = clientForTest(),
      key = [...session, "outbox", "detail", "existing"];
    client.setQueryData(key, { body: "current operator content" });
    const observer = new QueryObserver(client, { queryKey: key, enabled: false });
    const stop = observer.subscribe(() => {}),
      record = client.getQueryCache().find({ queryKey: key });
    const guard = new PublicationReadGuard(client, [key]);
    guard.dispose();
    expect(client.getQueryCache().find({ queryKey: key })).toBe(record);
    expect(observer.getCurrentResult().data).toEqual({ body: "current operator content" });
    stop();
    guard.dispose();
    expect(client.getQueryData(key)).toBeUndefined();
    client.clear();
  });

  it("supports setup-cleanup-setup without clearing a real denial or accepting an old generation", async () => {
    const client = clientForTest(),
      key = [...session, "preview", "decision-a"];
    const guard = new PublicationReadGuard(client, [key]);
    let complete: (value: string) => void = () => {
      throw new Error("The request did not start.");
    };
    const pending = guard.read(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    guard.dispose();
    guard.activate();
    complete("obsolete setup result");
    await expect(pending).rejects.toThrow("no longer active");
    await expect(guard.read(async () => "new setup result")).resolves.toBe("new setup result");
    guard.deny(deniedError(403));
    guard.dispose();
    guard.activate();
    const fetch = vi.fn(async () => "must not refetch");
    await expect(guard.read(fetch)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    guard.dispose();
    client.clear();
  });

  it("does not turn a late denial from a disposed identity into a denial of the new generation", async () => {
    const client = clientForTest(),
      guard = new PublicationReadGuard(client, [[...session, "preview", "a"]]);
    let reject: (error: unknown) => void = () => {
      throw new Error("The request did not start.");
    };
    const pending = guard.read(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    guard.dispose();
    guard.activate();
    reject(deniedError(404));
    await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(guard.snapshot()).toBe(false);
    guard.dispose();
    client.clear();
  });

  it("keeps uncertain control failures recoverable and requires a new guard to recover access denial", async () => {
    const client = clientForTest(),
      key = [...session, "outbox", "detail", "a"];
    const guard = new PublicationReadGuard(client, [key]);
    guard.deny(new ReviewControlNetworkError("publication control"));
    guard.deny(deniedError(409));
    guard.deny(deniedError(503));
    expect(guard.snapshot()).toBe(false);
    await expect(guard.read(async () => "current delivery")).resolves.toBe("current delivery");
    guard.deny(deniedError(404));
    await expect(guard.read(async () => "old scope")).rejects.toMatchObject({ status: 404 });
    const verifiedScope = new PublicationReadGuard(client, [
      [...session, "verified-epoch", "outbox", "detail", "a"],
    ]);
    await expect(verifiedScope.read(async () => "fresh authorized response")).resolves.toBe(
      "fresh authorized response",
    );
    guard.dispose();
    verifiedScope.dispose();
    client.clear();
  });
});
