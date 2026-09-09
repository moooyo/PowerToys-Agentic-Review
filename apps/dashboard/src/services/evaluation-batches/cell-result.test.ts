import * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import { cellResultFixture } from "./fixtures.testing";
import { createHttpEvaluationBatchAdapter } from "./index";

const value = cellResultFixture();
const scope: C.EvaluationCellResultReadQuery = {
  repositoryId: value.repositoryId,
  evaluationId: value.evaluationId,
  cellId: value.cellId,
  resultId: value.resultId,
};
const path = `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/results/${scope.resultId}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fixture = (body: unknown = cellResultFixture()) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(body));
  return { fetch, adapter: createHttpEvaluationBatchAdapter({ fetch }) };
};

describe("evaluation cell result HTTP reads", () => {
  it("reads the exact authenticated result path and sends no body", async () => {
    const { fetch, adapter } = fixture();
    expect(await adapter.getCellResult(scope)).toEqual(value);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(path);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects a response with a mismatched %s",
    async (field) => {
      await expect(
        fixture({ ...value, [field]: "another-identity" }).adapter.getCellResult(scope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it.each(["../other", "encoded%3Aid", "bad/id", "trailing\n", ""])(
    "rejects invalid result scope %s before fetching",
    async (resultId) => {
      const { fetch, adapter } = fixture();
      await expect(adapter.getCellResult({ ...scope, resultId })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects unknown request and result properties without silently discarding them", async () => {
    const { fetch, adapter } = fixture();
    await expect(
      adapter.getCellResult({
        ...scope,
        actor: "injected",
      } as unknown as C.EvaluationCellResultReadQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      fixture({ ...value, approval: "approved" }).adapter.getCellResult(scope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("rejects structurally inconsistent model result projections", async () => {
    const invalid = cellResultFixture();
    invalid.report = {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      summary: "Wrong work item kind",
      sourceState: "original",
      reproductionConclusion: "inconclusive",
      checks: [],
    };
    await expect(fixture(invalid).adapter.getCellResult(scope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("enforces the two MiB response boundary before accepting content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(C.maximumEvaluationCellResultUtf8Bytes + 1),
          },
        }),
    );
    await expect(
      createHttpEvaluationBatchAdapter({ fetch }).getCellResult(scope),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("propagates cancellation to the request without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = createHttpEvaluationBatchAdapter({ fetch }).getCellResult(
      scope,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([401, 403, 404, 503])(
    "preserves HTTP %s and never substitutes a prior result",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json({ message: "Not available" }, status),
      );
      await expect(
        createHttpEvaluationBatchAdapter({ fetch }).getCellResult(scope),
      ).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledOnce();
      await expect(
        createHttpEvaluationBatchAdapter({ fetch }).getCellResult(scope),
      ).rejects.toBeInstanceOf(ReviewControlHttpError);
    },
  );
});
