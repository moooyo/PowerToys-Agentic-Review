import type * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  adjudicationActorFixture,
  adjudicationChangeFixture,
  adjudicationContextFixture,
  adjudicationHistoryFixture,
  adjudicationRequestFixture,
  adjudicationScopeFixture,
} from "./fixtures.testing";
import { createHttpEvaluationAdjudicationAdapter } from "./index";

const scope = adjudicationContextFixture().scope,
  occurrenceScope = adjudicationScopeFixture();
const path = `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/results/${scope.resultId}/adjudications`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const setup = (...values: unknown[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of values) fetch.mockResolvedValueOnce(json(value));
  return { fetch, adapter: createHttpEvaluationAdjudicationAdapter({ fetch }) };
};
describe("evaluation adjudication adapter", () => {
  it("uses exact authenticated context, judgment and history paths without sending actor metadata", async () => {
    const { fetch, adapter } = setup(
      adjudicationContextFixture(),
      adjudicationChangeFixture(),
      adjudicationHistoryFixture(),
    );
    expect(await adapter.getContext(scope)).toEqual(adjudicationContextFixture());
    expect(
      await adapter.change(occurrenceScope, adjudicationRequestFixture(), adjudicationActorFixture),
    ).toEqual(adjudicationChangeFixture());
    expect(await adapter.history(occurrenceScope)).toEqual(adjudicationHistoryFixture());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      path,
      `${path}/${occurrenceScope.occurrenceKey}`,
      `${path}/${occurrenceScope.occurrenceKey}/history?page=1&pageSize=20`,
    ]);
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "PUT", "GET"]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(adjudicationRequestFixture()));
    expect(fetch.mock.calls[1]?.[1]?.body).not.toContain("actor");
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      });
  });
  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects a mismatched context %s",
    async (field) => {
      const value = adjudicationContextFixture();
      value.scope[field] = "another-identity";
      await expect(setup(value).adapter.getContext(scope)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );
  it.each([
    "kind",
    "reason",
    "expectedFindingId",
    "actor",
    "version",
    "occurrenceKey",
    "resultDigest",
  ])("rejects a changed %s in the mutation receipt", async (field) => {
    const value = adjudicationChangeFixture();
    if (field === "actor") value.adjudication.actor.subject = "someone-else";
    else if (field === "version") {
      value.previousVersion = 1;
      value.version = 2;
    } else if (field === "occurrenceKey") {
      value.scope.occurrenceKey = "f".repeat(64);
      value.adjudication.occurrenceKey = value.scope.occurrenceKey;
    } else if (field === "resultDigest") value.adjudication.resultDigest = "f".repeat(64);
    else if (field === "reason") value.adjudication.reason = "Changed reason";
    else if (field === "kind")
      value.adjudication = {
        adjudicationId: value.adjudication.adjudicationId,
        caseId: value.adjudication.caseId,
        arm: value.adjudication.arm,
        resultId: value.adjudication.resultId,
        resultDigest: value.adjudication.resultDigest,
        occurrenceKey: value.adjudication.occurrenceKey,
        actor: value.adjudication.actor,
        createdAt: value.adjudication.createdAt,
        reason: value.adjudication.reason,
        kind: "false_positive",
      };
    else if (value.adjudication.kind === "match")
      value.adjudication.expectedFindingId = "expected-two";
    await expect(
      setup(value).adapter.change(
        occurrenceScope,
        adjudicationRequestFixture(),
        adjudicationActorFixture,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("preserves duplicate, false-positive and unjudged branches exactly", async () => {
    for (const judgment of [
      {
        kind: "duplicate" as const,
        primaryOccurrenceKey: "2".repeat(64),
        reason: "Same primary defect.",
      },
      { kind: "false_positive" as const, reason: "The observed behavior is valid." },
      { kind: "unjudged" as const, reason: "More investigation is needed." },
    ]) {
      const request = { ...adjudicationRequestFixture(), judgment },
        receipt = adjudicationChangeFixture(request);
      expect(
        await setup(receipt).adapter.change(occurrenceScope, request, adjudicationActorFixture),
      ).toEqual(receipt);
    }
  });
  it("rejects unknown fields, unsafe paths and missing reviewer identity before fetching", async () => {
    const { fetch, adapter } = setup();
    await expect(adapter.getContext({ ...scope, cellId: "../cell" })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.history({ ...occurrenceScope, occurrenceKey: "not-a-digest" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.history(occurrenceScope, { page: 1, pageSize: 51 }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.change(
        occurrenceScope,
        {
          ...adjudicationRequestFixture(),
          actor: "injected",
        } as unknown as C.EvaluationAdjudicationChangeRequest,
        adjudicationActorFixture,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.change(
        occurrenceScope,
        adjudicationRequestFixture(),
        undefined as unknown as C.OperatorPrincipal,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not silently accept another history window or occurrence", async () => {
    await expect(
      setup(adjudicationHistoryFixture()).adapter.history(occurrenceScope, { page: 2 }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      setup(adjudicationHistoryFixture()).adapter.history({
        ...occurrenceScope,
        occurrenceKey: "2".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("snapshots the original request and actor before transport", async () => {
    const request = adjudicationRequestFixture(),
      original = structuredClone(request),
      actor = { ...adjudicationActorFixture };
    const { fetch, adapter } = setup(adjudicationChangeFixture());
    const pending = adapter.change(occurrenceScope, request, actor);
    request.changeId = "changed";
    request.judgment.reason = "Edited after submit";
    actor.subject = "changed";
    await expect(pending).resolves.toEqual(adjudicationChangeFixture());
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(original));
  });
  it("applies the response byte budget and carries read abort signals", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        }),
    );
    await expect(
      createHttpEvaluationAdjudicationAdapter({ fetch }).getContext(scope),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    const controller = new AbortController();
    controller.abort();
    const idle = setup();
    await expect(idle.adapter.getContext(scope, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(idle.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 503])(
    "preserves HTTP %s without automatic retries or invented CAS",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json({ message: "Rejected" }, status),
      );
      await expect(
        createHttpEvaluationAdjudicationAdapter({ fetch }).change(
          occurrenceScope,
          adjudicationRequestFixture(),
          adjudicationActorFixture,
        ),
      ).rejects.toBeInstanceOf(ReviewControlHttpError);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(adjudicationRequestFixture()));
    },
  );
});
