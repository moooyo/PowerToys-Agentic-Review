import type * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "../review-control/errors";
import { MAX_DASHBOARD_RESPONSE_BYTES } from "../review-control/http-client";
import {
  evaluationCellInvocationItemFixture,
  evaluationCellInvocationListFixture,
  evaluationModelInvocationTestScope,
  invocationFixtureDigest,
} from "./fixtures.testing";
import { createHttpEvaluationModelInvocationAdapter } from "./index";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function fixture(value: unknown = evaluationCellInvocationListFixture()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: createHttpEvaluationModelInvocationAdapter({ fetch }) };
}
function item(value: C.EvaluationCellInvocationListV1) {
  const found = value.items[0];
  if (!found) throw new Error("The fixture must contain an invocation.");
  return found;
}
function seal(value: C.EvaluationCellInvocationListV1) {
  const found = item(value).seal;
  if (!found) throw new Error("The fixture must contain a seal.");
  return found;
}
function submission(value: C.EvaluationCellInvocationListV1) {
  const found = item(value).submission;
  if (!found) throw new Error("The fixture must contain a submission.");
  return found;
}
function registration(value: C.EvaluationCellInvocationListV1) {
  const found = value.expectedRuntimeRegistration;
  if (!found) throw new Error("The fixture must contain a runtime registration.");
  return found;
}
function refreshScope(value: C.EvaluationCellInvocationListV1): void {
  const found = item(value);
  found.opening.scopeSha256 = invocationFixtureDigest(found.opening.scope);
  if (found.seal !== null) found.seal.scopeSha256 = found.opening.scopeSha256;
  if (found.submission !== null) found.submission.scopeSha256 = found.opening.scopeSha256;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("evaluation model invocation diagnostic service", () => {
  it("retains explicit summary input references in V2 history without changing execution acceptance", async () => {
    const response = evaluationCellInvocationListFixture();
    const found = item(response);
    const original = found.opening.scope;
    found.opening = {
      ...found.opening,
      schemaVersion: "ModelInvocationOpeningV2",
      scope: {
        ...original,
        schemaVersion: "ModelInvocationScopeV2",
        purpose: "validation_summary",
        inputRef: {
          schemaVersion: "ValidationSummaryInputReferenceV1",
          inputId: "input-a",
          inputSha256: "a".repeat(64),
          sourcePromptSha256: original.promptSha256,
          outputSchemaSha256: original.outputSchemaSha256,
          contextSha256: "b".repeat(64),
          actualPromptSha256: "c".repeat(64),
        },
      },
    };
    refreshScope(response);
    const read = await fixture(response).adapter.list(evaluationModelInvocationTestScope);
    expect(read).toEqual(response);
    expect(item(read).submission?.executionAccepted).toBe(false);
    if (found.opening.scope.schemaVersion !== "ModelInvocationScopeV2")
      throw new Error("Expected V2.");
    found.opening.scope.inputRef.sourcePromptSha256 = "d".repeat(64);
    refreshScope(response);
    await expect(
      fixture(response).adapter.list(evaluationModelInvocationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it.each(["open", "sealed", "submitted"] as const)(
    "loads a %s snapshot without promoting execution acceptance",
    async (state) => {
      const response = evaluationCellInvocationListFixture(state);
      const test = fixture(response);
      expect(test.adapter.mode).toBe("connected");
      const result = await test.adapter.list(evaluationModelInvocationTestScope);
      expect(result).toEqual(response);
      expect(result).not.toBe(response);
      expect(item(result).submission?.executionAccepted ?? false).toBe(false);
      expect(test.fetch).toHaveBeenCalledOnce();
      expect(test.fetch.mock.calls[0]?.[0]).toBe(
        "/api/v1/operator/repositories/repository-a/evaluations/evaluation-a/cells/cell-a/model-invocations?page=1&pageSize=10",
      );
      expect(test.fetch.mock.calls[0]?.[1]).toMatchObject({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(test.fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
      expect("post" in test.adapter).toBe(false);
    },
  );

  it("keeps frozen runtime expectations on an empty invocation page", async () => {
    const response = evaluationCellInvocationListFixture();
    response.items = [];
    response.total = 0;
    expect(await fixture(response).adapter.list(evaluationModelInvocationTestScope)).toEqual(
      response,
    );
    response.expectedRuntimeRegistration = null;
    expect(await fixture(response).adapter.list(evaluationModelInvocationTestScope)).toEqual(
      response,
    );
  });

  it("uses explicit pagination with a complete final page", async () => {
    const response = evaluationCellInvocationListFixture();
    response.page = 2;
    response.pageSize = 2;
    response.total = 3;
    const test = fixture(response);
    expect(
      await test.adapter.list(evaluationModelInvocationTestScope, { page: 2, pageSize: 2 }),
    ).toEqual(response);
    expect(test.fetch.mock.calls[0]?.[0]).toMatch(/\?page=2&pageSize=2$/u);
  });

  it("accepts an empty page beyond the known total without replacing it with fixtures", async () => {
    const response = evaluationCellInvocationListFixture();
    response.page = Number.MAX_SAFE_INTEGER;
    response.pageSize = 1;
    response.items = [];
    expect(
      await fixture(response).adapter.list(evaluationModelInvocationTestScope, {
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 1,
      }),
    ).toEqual(response);
  });

  it("snapshots the requested scope and pagination before asynchronous fetch", async () => {
    let complete: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const adapter = createHttpEvaluationModelInvocationAdapter({ fetch });
    const scope = { ...evaluationModelInvocationTestScope };
    const query = { page: 1, pageSize: 10 };
    const pending = adapter.list(scope, query);
    scope.repositoryId = "changed-repository";
    scope.evaluationId = "changed-evaluation";
    scope.cellId = "changed-cell";
    query.page = 9;
    query.pageSize = 1;
    complete?.(json(evaluationCellInvocationListFixture()));
    expect(await pending).toEqual(evaluationCellInvocationListFixture());
    expect(fetch.mock.calls[0]?.[0]).toContain(
      "/repository-a/evaluations/evaluation-a/cells/cell-a/",
    );
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\?page=1&pageSize=10$/u);
  });

  it.each(["repositoryId", "evaluationId", "cellId"] as const)(
    "rejects a fully self-consistent response for another %s",
    async (field) => {
      const response = evaluationCellInvocationListFixture();
      response[field] = "foreign-identity";
      item(response).opening.scope[field] = "foreign-identity";
      refreshScope(response);
      await expect(
        fixture(response).adapter.list(evaluationModelInvocationTestScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );

  const inconsistent: ReadonlyArray<
    readonly [string, (value: C.EvaluationCellInvocationListV1) => void]
  > = [
    [
      "opening repository",
      (v) => {
        item(v).opening.scope.repositoryId = "other";
        refreshScope(v);
      },
    ],
    [
      "opening evaluation",
      (v) => {
        item(v).opening.scope.evaluationId = "other";
        refreshScope(v);
      },
    ],
    [
      "opening cell",
      (v) => {
        item(v).opening.scope.cellId = "other";
        refreshScope(v);
      },
    ],
    [
      "unmeasured frozen registration",
      (v) => {
        v.expectedRuntimeRegistration = null;
      },
    ],
    [
      "frozen requested model",
      (v) => {
        registration(v).requestedModel = "another-alias";
      },
    ],
    [
      "frozen expected identity",
      (v) => {
        item(v).opening.scope.expectedModelIdentitySha256 = "9".repeat(64);
        refreshScope(v);
      },
    ],
    [
      "scope digest",
      (v) => {
        item(v).opening.scope.promptSha256 = "9".repeat(64);
      },
    ],
    [
      "registration identity digest",
      (v) => {
        registration(v).identity.client.version = "unverified-version";
      },
    ],
    [
      "observed identity digest",
      (v) => {
        const observed = item(v).observedIdentity;
        if (observed) observed.modelId = "unverified-model";
      },
    ],
    [
      "missing observed identity",
      (v) => {
        item(v).observedIdentity = null;
      },
    ],
    [
      "seal invocation",
      (v) => {
        seal(v).invocationId = "another-invocation";
      },
    ],
    [
      "seal scope digest",
      (v) => {
        seal(v).scopeSha256 = "9".repeat(64);
      },
    ],
    [
      "submission invocation",
      (v) => {
        submission(v).invocationId = "another-invocation";
      },
    ],
    [
      "submission scope digest",
      (v) => {
        submission(v).scopeSha256 = "9".repeat(64);
      },
    ],
    [
      "submission ledger digest",
      (v) => {
        submission(v).receiptSetSha256 = "9".repeat(64);
      },
    ],
    [
      "submission without seal",
      (v) => {
        item(v).seal = null;
      },
    ],
    [
      "missing call outcomes",
      (v) => {
        item(v).callOutcomes = null;
      },
    ],
    [
      "unsubmitted outcomes",
      (v) => {
        item(v).submission = null;
      },
    ],
    [
      "incomplete call total",
      (v) => {
        seal(v).callCount = 2;
      },
    ],
    [
      "foreign observed identity",
      (v) => {
        submission(v).consistency.observedIdentitySha256 = "9".repeat(64);
      },
    ],
    [
      "unsafe execution promotion",
      (v) => {
        Object.assign(submission(v), { executionAccepted: true });
      },
    ],
    [
      "matched without process closure",
      (v) => {
        seal(v).processClosed = false;
        seal(v).modelOutputSha256 = null;
      },
    ],
    [
      "matched without relay closure",
      (v) => {
        seal(v).relayClosed = false;
        seal(v).modelOutputSha256 = null;
      },
    ],
    [
      "matched incomplete outcomes",
      (v) => {
        item(v).callOutcomes = {
          completed: 0,
          provider_failed: 1,
          provider_incomplete: 0,
          transport_failed: 0,
          cancelled: 0,
          protocol_invalid: 0,
          budget_exceeded: 0,
        };
      },
    ],
    [
      "sample before opening",
      (v) => {
        v.sampledAt = "2026-09-08T00:00:01.000Z";
      },
    ],
    [
      "seal before opening",
      (v) => {
        seal(v).recordedAt = "2026-09-08T00:00:01.000Z";
      },
    ],
    [
      "submission before seal",
      (v) => {
        submission(v).receivedAt = "2026-09-08T00:01:02.000Z";
      },
    ],
    [
      "submission after sample",
      (v) => {
        submission(v).receivedAt = "2026-09-08T00:03:00.000Z";
      },
    ],
    [
      "unexpected page",
      (v) => {
        v.page = 2;
        v.total = 11;
      },
    ],
    [
      "unexpected page size",
      (v) => {
        v.pageSize = 1;
      },
    ],
    [
      "incomplete page",
      (v) => {
        v.total = 2;
      },
    ],
    [
      "duplicate invocation",
      (v) => {
        v.items.push(structuredClone(item(v)));
        v.total = 2;
      },
    ],
  ];
  it.each(inconsistent)(
    "rejects %s instead of rendering misleading diagnostics",
    async (_name, mutate) => {
      const response = evaluationCellInvocationListFixture();
      mutate(response);
      await expect(
        fixture(response).adapter.list(evaluationModelInvocationTestScope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );

  it("checks duplicate attempts independently of distinct invocation IDs", async () => {
    const response = evaluationCellInvocationListFixture();
    const second = evaluationCellInvocationItemFixture("submitted", "zero");
    second.opening.scope.attemptId = item(response).opening.scope.attemptId;
    second.opening.scopeSha256 = invocationFixtureDigest(second.opening.scope);
    if (second.seal) second.seal.scopeSha256 = second.opening.scopeSha256;
    if (second.submission) second.submission.scopeSha256 = second.opening.scopeSha256;
    response.items.unshift(second);
    response.total = 2;
    await expect(
      fixture(response).adapter.list(evaluationModelInvocationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("requires descending opening time and ASCII identity ordering", async () => {
    const response = evaluationCellInvocationListFixture();
    const second = evaluationCellInvocationItemFixture("submitted", "zero");
    response.items.unshift(second);
    response.total = 2;
    expect(await fixture(response).adapter.list(evaluationModelInvocationTestScope)).toEqual(
      response,
    );
    response.items.reverse();
    await expect(
      fixture(response).adapter.list(evaluationModelInvocationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    response.items.reverse();
    second.opening.openedAt = "2026-09-08T00:00:59.000Z";
    await expect(
      fixture(response).adapter.list(evaluationModelInvocationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("retains diagnostic mismatches with measured runtime changes without granting acceptance", async () => {
    const response = evaluationCellInvocationListFixture();
    item(response).opening.runtime.client.version = "observed-other-version";
    const observed = item(response).observedIdentity;
    if (observed === null) throw new Error("The fixture requires an observed identity.");
    observed.client.version = "observed-other-version";
    observed.modelId = "observed-other-model";
    const observedDigest = invocationFixtureDigest(observed);
    seal(response).observedIdentitySha256 = observedDigest;
    submission(response).consistency = {
      state: "mismatched",
      reasons: ["RUNTIME_IDENTITY_MISMATCH"],
      observedIdentitySha256: observedDigest,
    };
    expect(await fixture(response).adapter.list(evaluationModelInvocationTestScope)).toEqual(
      response,
    );
  });

  it("retains invalid consistency with no trusted observed identity", async () => {
    const response = evaluationCellInvocationListFixture();
    submission(response).consistency = {
      state: "invalid",
      reasons: ["IDENTITY_DIGEST_MISMATCH"],
      observedIdentitySha256: null,
    };
    item(response).observedIdentity = null;
    expect(await fixture(response).adapter.list(evaluationModelInvocationTestScope)).toEqual(
      response,
    );
  });

  it.each([
    null,
    {},
    { schemaVersion: "unknown" },
    { ...evaluationCellInvocationListFixture(), credentials: "private" },
  ])("rejects malformed or expanded diagnostic records", async (response) => {
    await expect(
      fixture(response).adapter.list(evaluationModelInvocationTestScope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each(["repositoryId", "evaluationId", "cellId"] as const)(
    "rejects invalid %s before fetching",
    async (field) => {
      for (const id of ["", "..", "a/b", "a%2Fb", "a?scope=other", "a\n", "a#fragment"]) {
        const test = fixture();
        await expect(
          test.adapter.list({ ...evaluationModelInvocationTestScope, [field]: id }),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
        expect(test.fetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { page: 0 },
    { page: 1.1 },
    { page: "1" },
    { page: undefined },
    { pageSize: 0 },
    { pageSize: 11 },
    { pageSize: "10" },
    { pageSize: NaN },
    { pageSize: Infinity },
    { actor: "admin" },
    { page: Number.MAX_SAFE_INTEGER },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 2 },
  ])("rejects noncanonical pagination %j before fetching", async (query) => {
    const test = fixture();
    await expect(
      test.adapter.list(
        evaluationModelInvocationTestScope,
        query as C.EvaluationCellInvocationListQuery,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("rejects request getters without evaluating them", async () => {
    const test = fixture();
    const getter = vi.fn(() => 1);
    const query = Object.defineProperty({}, "page", { enumerable: true, get: getter });
    await expect(
      test.adapter.list(evaluationModelInvocationTestScope, query),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const scope = Object.defineProperty({ ...evaluationModelInvocationTestScope }, "cellId", {
      enumerable: true,
      get: getter,
    });
    await expect(test.adapter.list(scope)).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(getter).not.toHaveBeenCalled();
    expect(test.fetch).not.toHaveBeenCalled();
  });
});

describe("evaluation invocation diagnostic transport", () => {
  it.each([401, 403, 404, 409, 503])(
    "preserves HTTP %s without fixture fallback or automatic retry",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json(
          {
            error: {
              code: "not_available",
              message: "Diagnostics unavailable.",
              retryable: status >= 500,
            },
          },
          status,
        ),
      );
      const adapter = createHttpEvaluationModelInvocationAdapter({ fetch });
      const failure = await adapter
        .list(evaluationModelInvocationTestScope)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ReviewControlHttpError);
      expect(failure).toMatchObject({ status });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("preserves a network failure without leaking the rejected fetch detail", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("private connection detail");
    });
    const adapter = createHttpEvaluationModelInvocationAdapter({ fetch });
    const failure = await adapter
      .list(evaluationModelInvocationTestScope)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewControlNetworkError);
    expect(String(failure)).not.toContain("private connection detail");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds the response to 2 MiB before diagnostic parsing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(`"${"x".repeat(MAX_DASHBOARD_RESPONSE_BYTES)}"`, {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      createHttpEvaluationModelInvocationAdapter({ fetch }).list(
        evaluationModelInvocationTestScope,
      ),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects missing cryptographic verification without returning unchecked metadata", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("private digest detail"),
    );
    const test = fixture();
    const failure = await test.adapter
      .list(evaluationModelInvocationTestScope)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewControlProtocolError);
    expect(String(failure)).not.toContain("private digest detail");
  });

  it("cancels before fetch with the caller's AbortSignal", async () => {
    const controller = new AbortController();
    const reason = new Error("The cell selection changed.");
    controller.abort(reason);
    const test = fixture();
    await expect(
      test.adapter.list(evaluationModelInvocationTestScope, {}, controller.signal),
    ).rejects.toBe(reason);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("forwards cancellation to the transport and discards late completion", async () => {
    let complete: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const reason = new Error("The cell selection changed.");
    const pending = createHttpEvaluationModelInvocationAdapter({ fetch }).list(
      evaluationModelInvocationTestScope,
      {},
      controller.signal,
    );
    controller.abort(reason);
    complete?.(json(evaluationCellInvocationListFixture()));
    await expect(pending).rejects.toBe(reason);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("discards a response cancelled during cryptographic verification", async () => {
    let complete: ((digest: ArrayBuffer) => void) | undefined;
    const started = Promise.withResolvers<void>();
    const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(() => {
      started.resolve();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const controller = new AbortController();
    const reason = new Error("The session changed.");
    const pending = fixture().adapter.list(
      evaluationModelInvocationTestScope,
      {},
      controller.signal,
    );
    await started.promise;
    controller.abort(reason);
    complete?.(await original("SHA-256", new Uint8Array()));
    await expect(pending).rejects.toBe(reason);
  });

  it("expires a stalled read without starting a polling loop", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const pending = createHttpEvaluationModelInvocationAdapter({ fetch, timeoutMs: 30 })
      .list(evaluationModelInvocationTestScope)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toBeInstanceOf(ReviewControlTimeoutError);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
