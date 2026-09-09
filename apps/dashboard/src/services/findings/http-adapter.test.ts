import {
  type FindingDispositionChangeRequest,
  maximumFindingDispositionResponseUtf8Bytes,
  type OperatorPrincipal,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import { DashboardHttpClient } from "../review-control/http-client";
import type { FindingPageQuery, FindingScope } from "./adapter";
import {
  actor,
  beforeScope,
  comparison,
  event,
  history,
  input,
  jsonResponse,
  list,
  ref,
  scope,
} from "./fixtures.testing";
import { HttpFindingsAdapter } from "./http-adapter";
import { MockFindingsAdapter } from "./mock-adapter";

const path = `/api/v1/operator/repositories/${scope.repositoryId}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}/jobs/${scope.jobId}/findings`;
function adapterWith(value: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value, status));
  return { adapter: new HttpFindingsAdapter({ fetch }), fetch };
}

describe("finding transport and canonical paths", () => {
  it("bounds oversized responses at the transport before rendering or parsing finding data", async () => {
    const { adapter } = adapterWith({
      ...list,
      oversized: "x".repeat(maximumFindingDispositionResponseUtf8Bytes),
    });
    await expect(adapter.list(scope)).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
  });
  it("uses only the four exact same-origin operator endpoints and never sends a caller-supplied actor", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(list))
      .mockResolvedValueOnce(jsonResponse(comparison))
      .mockResolvedValueOnce(jsonResponse({ change: event, replayed: false }, 201))
      .mockResolvedValueOnce(jsonResponse(history));
    const adapter = new HttpFindingsAdapter({ fetch });
    expect(adapter.mode).toBe("connected");
    await expect(adapter.list(scope)).resolves.toEqual(list);
    await expect(adapter.compare(scope, beforeScope)).resolves.toEqual(comparison);
    await expect(adapter.change(scope, ref.key, input, actor)).resolves.toEqual({
      change: event,
      replayed: false,
    });
    await expect(adapter.history(scope, ref)).resolves.toEqual(history);
    expect(fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body])).toEqual(
      [
        [`${path}?page=1&pageSize=20`, "GET", undefined],
        [
          `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&beforeJobId=job-one&page=1&pageSize=20`,
          "GET",
          undefined,
        ],
        [`${path}/${ref.key}/disposition`, "POST", JSON.stringify(input)],
        [`${path}/${ref.key}/history?page=1&pageSize=20`, "GET", undefined],
      ],
    );
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
  });

  it.each([
    path,
    `${path}?`,
    `${path}/`,
    `${path}?page=1`,
    `${path}?pageSize=20&page=1`,
    `${path}?page=01&pageSize=20`,
    `${path}?page=1&pageSize=21`,
    `${path}?page=1&pageSize=20&extra=1`,
    `${path}?page=1&pageSize=20&page=2`,
    `${path}\n?page=1&pageSize=20`,
    `${path}?page=1&pageSize=20#section`,
    `${path}/${ref.key}/history`,
    `${path}/${ref.key}/history?page=1&pageSize=21`,
    `${path}/comparison?page=1&pageSize=20`,
    `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&page=1&pageSize=20`,
    `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&beforeJobId=job-one&page=1&pageSize=21`,
    `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&beforeJobId=job-one&pageSize=20&page=1`,
    `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&beforeJobId=..&page=1&pageSize=20`,
    `${path}/comparison?beforeReviewRunId=run-one&beforeRequestId=request-one&beforeJobId=%2Fsecret&page=1&pageSize=20`,
    `https://github.com${path}?page=1&pageSize=20`,
  ])("rejects a noncanonical read path before fetch: %s", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new DashboardHttpClient({ fetch }).get(value, "read findings")).rejects.toThrow(
      "allowlisted",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    path,
    `${path}/${ref.key}/history`,
    `${path}/${ref.key}/disposition?`,
    `${path}/${ref.key}/disposition/`,
    `${path}/${ref.key.toUpperCase()}/disposition`,
    `${path}/${ref.key.slice(1)}/disposition`,
    `${path}/${ref.key}/disposition\n`,
  ])("rejects a noncanonical mutation path before fetch: %s", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      new DashboardHttpClient({ fetch }).post(value, "change finding", input),
    ).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 429, 500, 503])(
    "propagates HTTP %i without replacing it with sample data",
    async (status) => {
      const { adapter, fetch } = adapterWith(
        { code: "PLATFORM_CONFLICT", message: "Reload before saving.", retryable: false },
        status,
      );
      const operation = adapter.change(scope, ref.key, input, actor);
      await expect(operation).rejects.toBeInstanceOf(ReviewControlHttpError);
      await expect(operation).rejects.toMatchObject({
        status,
        serverCode: "PLATFORM_CONFLICT",
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not invent empty findings or successful audit events after network and protocol failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
    await expect(new HttpFindingsAdapter({ fetch }).list(scope)).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
    for (const value of [null, [], {}, { ...list, invented: true }])
      await expect(adapterWith(value).adapter.list(scope)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    await expect(
      adapterWith({ change: event }).adapter.change(scope, ref.key, input, actor),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("snapshots the selected scope, retry intent, and principal before awaiting transport", async () => {
    const selected = { ...scope };
    const request = { ...input, reason: `  ${input.reason}\n ` };
    const principal = { ...actor };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      selected.jobId = "another-job";
      request.changeId = "another-intent";
      request.reason = "Another reason";
      principal.subject = "Another-Operator";
      return jsonResponse({ change: event, replayed: true });
    });
    await expect(
      new HttpFindingsAdapter({ fetch }).change(selected, ref.key, request, principal),
    ).resolves.toEqual({ change: event, replayed: true });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(input));
  });

  it("does not refetch current state while accepting an immutable retry receipt", async () => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: true });
    await expect(adapter.change(scope, ref.key, input, actor)).resolves.toMatchObject({
      replayed: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("finding request validation before transport", () => {
  it.each(["", "../secret", "/absolute", "bad value", "bad\n", "bad\ud800", "x".repeat(129)])(
    "rejects invalid scope identifier %j",
    async (id) => {
      for (const field of ["repositoryId", "reviewRunId", "requestId", "jobId"] as const) {
        const { adapter, fetch } = adapterWith(list);
        await expect(adapter.list({ ...scope, [field]: id })).rejects.toBeInstanceOf(
          ReviewControlRequestError,
        );
        expect(fetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 20 },
    { pageSize: 0 },
    { pageSize: 21 },
    { pageSize: 1.5 },
    { page: Number.NaN },
    { page: "1" },
    { other: true },
    { page: undefined },
  ])("rejects invalid or overflowing paging %j", async (query) => {
    const { adapter, fetch } = adapterWith(list);
    await expect(adapter.list(scope, query as FindingPageQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects comparison across repositories and untrusted extra scope fields", async () => {
    const { adapter, fetch } = adapterWith(comparison);
    await expect(
      adapter.compare(scope, { ...beforeScope, repositoryId: "other" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.list({ ...scope, actor } as FindingScope)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { changeId: "bad\n" },
    { expectedVersion: -1 },
    { expectedVersion: Number.MAX_SAFE_INTEGER },
    { expectedResultDigest: "x".repeat(64) },
    { expectedContextDigest: "d".repeat(63) },
    { ordinal: 100 },
    { ordinal: -1 },
    { ordinal: 0.5 },
    { action: "approve" },
    { reason: "   " },
    { reason: "bad\u000btext" },
    { reason: "bad\u0085text" },
    { reason: "bad\ud800text" },
    { reason: "x".repeat(2049) },
    { actor },
  ])("rejects invalid finding intent %j", async (mutation) => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: false });
    await expect(
      adapter.change(
        scope,
        ref.key,
        { ...input, ...mutation } as FindingDispositionChangeRequest,
        actor,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "F".repeat(64), "f".repeat(63), `${ref.key}\n`, `${ref.key}/disposition`])(
    "rejects an invalid occurrence key %j",
    async (key) => {
      const { adapter, fetch } = adapterWith({ change: event, replayed: false });
      await expect(adapter.change(scope, key, input, actor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { issuer: "", subject: "operator" },
    { ...actor, subject: "other\n" },
    { ...actor, issuer: " https://issuer" },
    { ...actor, subject: "\ud800" },
    { ...actor, displayName: "Other" },
  ])("rejects malformed principals %j", async (principal) => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: false });
    await expect(
      adapter.change(scope, ref.key, input, principal as OperatorPrincipal),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects extra history identity fields instead of silently dropping them", async () => {
    const { adapter, fetch } = adapterWith(history);
    await expect(adapter.history(scope, { ...ref, actor } as typeof ref)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("explicit findings sample mode", () => {
  it("does not fabricate immutable arrays, writable audit state, or contact a repository", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    try {
      const adapter = new MockFindingsAdapter();
      expect(adapter.mode).toBe("sample");
      for (const operation of [
        adapter.list(scope),
        adapter.compare(scope, beforeScope),
        adapter.change(scope, ref.key, input, actor),
        adapter.history(scope, ref),
      ])
        await expect(operation).rejects.toMatchObject({
          code: "unsupported_operation",
          retryable: false,
          message: expect.stringContaining("explicit sample mode"),
        });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
