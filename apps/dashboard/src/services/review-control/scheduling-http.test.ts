import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "./errors";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const path = "/api/v1/operator/repositories/repo/jobs/job/scheduling";
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
describe("bounded cancellable dashboard GETs", () => {
  it.each([
    `${path}?x=1`,
    `${path}/`,
    "/api/v1/operator/scheduling/unexpected",
    "/api/v1/operator/scheduling/jobs/job?repositoryId=repo",
    "/api/v1/operator/repositories/repo/scheduling/unexpected",
    "/api/v1/operator/repositories/repo/jobs/job%2Fother/scheduling",
  ])("refuses paths outside the explicit scheduling read routes", async (candidate) => {
    const fetch = vi.fn();
    await expect(
      new DashboardHttpClient({ fetch }).get(candidate, "read scheduling"),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["/api/v1/operator/scheduling", "/api/v1/operator/repositories/repo/scheduling"])(
    "reads current policy through the same bounded uncached client: %s",
    async (candidate) => {
      const fetch = vi.fn(async () => response({ ok: true }));
      await expect(
        new DashboardHttpClient({ fetch }).get(candidate, "read scheduling policy"),
      ).resolves.toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledWith(
        candidate,
        expect.objectContaining({
          method: "GET",
          cache: "no-store",
          credentials: "include",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );
  it("never enables mutation through a scheduling read path", async () => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({ fetch });
    for (const method of ["post", "put", "patch"] as const)
      await expect(client[method](path, "change scheduling", {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([path, "/api/v1/operator/scheduling", "/api/v1/operator/repositories/repo/scheduling"])(
    "rejects an already aborted request without calling fetch: %s",
    async (candidate) => {
      const controller = new AbortController();
      controller.abort();
      const fetch = vi.fn();
      await expect(
        new DashboardHttpClient({ fetch }).get(candidate, "read scheduling", {
          signal: controller.signal,
        }),
      ).rejects.toBe(controller.signal.reason);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not reuse late response data after caller cancellation", async () => {
    let complete!: (value: Response) => void;
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    });
    const controller = new AbortController();
    const pending = new DashboardHttpClient({ fetch }).get(path, "read scheduling", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(signal?.aborted).toBe(true);
    complete(response({ previousScope: true }));
    await Promise.resolve();
  });
  it("retains the original caller signal when its options object is reused", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const options = { signal: first.signal };
    const pending = new DashboardHttpClient({
      fetch: () => new Promise<Response>(() => undefined),
    }).get(path, "read scheduling", options);
    options.signal = second.signal;
    first.abort();
    await expect(pending).rejects.toBe(first.signal.reason);
    expect(second.signal.aborted).toBe(false);
  });
  it("does not dispatch a stale authorization failure after cancellation", async () => {
    const controller = new AbortController();
    let complete!: (value: Response) => void;
    const dispatch = vi.fn();
    vi.stubGlobal("dispatchEvent", dispatch);
    try {
      const pending = new DashboardHttpClient({
        fetch: () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      }).get(path, "read scheduling", { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBe(controller.signal.reason);
      complete(
        new Response('{"message":"Access denied"}', {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("cancels a partially read stream instead of parsing stale bytes", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel: cancelled,
    });
    const controller = new AbortController();
    const pending = new DashboardHttpClient({
      fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    }).get(path, "read scheduling", { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("removes the external abort listener once a response completes", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const client = new DashboardHttpClient({
      fetch: async (_path, init) => {
        signal = init?.signal;
        return response({ ok: true });
      },
    });
    await expect(
      client.get(path, "read scheduling", { signal: controller.signal }),
    ).resolves.toEqual({ ok: true });
    controller.abort();
    expect(signal?.aborted).toBe(false);
  });
  it.each([0, -1, 1.5, Number.NaN, MAX_DASHBOARD_RESPONSE_BYTES + 1])(
    "validates response limits before transport",
    async (maxResponseBytes) => {
      const fetch = vi.fn();
      await expect(
        new DashboardHttpClient({ fetch }).get(path, "read scheduling", { maxResponseBytes }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects a declared oversized response before consuming it", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "65537" },
        }),
    );
    await expect(
      new DashboardHttpClient({ fetch }).get(path, "read scheduling", { maxResponseBytes: 65536 }),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
  });
  it("retains the original byte limit for existing two-argument callers", async () => {
    const value = "x".repeat(70000);
    const client = new DashboardHttpClient({ fetch: async () => response(value) });
    await expect(client.get("/api/v1/dashboard/system", "read system")).resolves.toBe(value);
  });
  it("retains timeout errors when no caller cancellation occurred", async () => {
    const client = new DashboardHttpClient({
      timeoutMs: 5,
      fetch: () => new Promise<Response>(() => undefined),
    });
    await expect(client.get(path, "read scheduling")).rejects.toBeInstanceOf(
      ReviewControlTimeoutError,
    );
  });
});
