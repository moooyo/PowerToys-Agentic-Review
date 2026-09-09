import * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import {
  reproductionCellFixture,
  reproductionFixtureDigest,
  reproductionFixtureScope,
  reproductionPlanFixture,
  reproductionPreviewFixture,
  reproductionPreviewRequestFixture,
  reproductionSourceFixture,
} from "./fixtures.testing";
import { HttpEvaluationReproductionAdapter } from "./index";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function fixture(value: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, api: new HttpEvaluationReproductionAdapter({ fetch }) };
}
const sourceScope = { repositoryId: "repository-a", sourceId: "source-a" };
const batchScope = { repositoryId: "repository-a", evaluationId: "evaluation-a" };

describe("evaluation reproduction transport", () => {
  it("loads a verified original definition through the exact repository source path", async () => {
    const source = reproductionSourceFixture(),
      test = fixture(source);
    expect(await test.api.getSource(sourceScope)).toEqual(source);
    expect(test.fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/operator/repositories/repository-a/evaluation-sources/source-a/reproduction",
    );
    expect(test.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
  });
  it("keeps source absence explicit without inventing a reproduction definition", async () => {
    const source = reproductionSourceFixture();
    source.sourceDefinition = null;
    source.sourceDefinitionSha256 = null;
    expect(await fixture(source).api.getSource(sourceScope)).toEqual(source);
    source.sourceDefinitionSha256 = "a".repeat(64);
    await expect(fixture(source).api.getSource(sourceScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("rejects changed claims and nested binding digests even when the outer digest is replaced", async () => {
    const source = reproductionSourceFixture();
    if (!source.sourceDefinition) throw new Error("Definition required.");
    source.sourceDefinition.binding.claim = "Changed original claim";
    await expect(fixture(source).api.getSource(sourceScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    source.sourceDefinitionSha256 = reproductionFixtureDigest(source.sourceDefinition);
    await expect(fixture(source).api.getSource(sourceScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("reads exact persisted plan and cell records without widening mutation paths", async () => {
    const plan = reproductionPlanFixture(),
      cell = reproductionCellFixture();
    expect(await fixture(plan).api.getPlan(batchScope)).toEqual(plan);
    const test = fixture(cell);
    expect(await test.api.getCell(reproductionFixtureScope)).toEqual(cell);
    expect(test.fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/operator/repositories/repository-a/evaluations/evaluation-a/cells/cell-baseline/reproduction",
    );
    cell.record.selectedCaseIds = ["other-original-case"];
    await expect(fixture(cell).api.getCell(reproductionFixtureScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("preserves an explicitly blocked preview and snapshots the exact mapping request", async () => {
    const request = reproductionPreviewRequestFixture(),
      response = reproductionPreviewFixture(),
      test = fixture(response);
    const pending = test.api.preview("repository-a", request);
    request.selection.candidate.observationMappings = [];
    const result = await pending;
    expect(result.candidate.state).toBe("blocked");
    expect(test.fetch.mock.calls[0]?.[0]).toBe(
      "/api/v1/operator/repositories/repository-a/evaluation-reproduction/preview",
    );
    expect(JSON.parse(String(test.fetch.mock.calls[0]?.[1]?.body))).toEqual(
      reproductionPreviewRequestFixture(),
    );
    expect(JSON.stringify(result)).not.toContain("reproduction.binding");
  });
  it.each(["repositoryId", "sourceId"] as const)("rejects mismatched preview %s", async (field) => {
    const value = reproductionPreviewFixture();
    value[field] = "different-identity";
    await expect(
      fixture(value).api.preview("repository-a", reproductionPreviewRequestFixture()),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it.each(["baseline", "candidate"] as const)(
    "rejects a changed %s profile identity",
    async (arm) => {
      const value = reproductionPreviewFixture();
      value[arm].profileVersionId = "another-profile";
      await expect(
        fixture(value).api.preview("repository-a", reproductionPreviewRequestFixture()),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it("rejects extra response fields and malformed selected IDs before using their values", async () => {
    const source = {
      ...reproductionSourceFixture(),
      runtimeCredentials: { secret: "forbidden-fixture" },
    };
    await expect(fixture(source).api.getSource(sourceScope)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    const request = reproductionPreviewRequestFixture();
    request.selection.selectedCaseIds = ["original-case\n"];
    const test = fixture(reproductionPreviewFixture());
    await expect(test.api.preview("repository-a", request)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(test.fetch).not.toHaveBeenCalled();
  });
  it("cancels preview transport when its scope is invalidated", async () => {
    const controller = new AbortController();
    let release: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const api = new HttpEvaluationReproductionAdapter({ fetch });
    const pending = api.preview(
      "repository-a",
      reproductionPreviewRequestFixture(),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    release?.(json(reproductionPreviewFixture()));
  });
  it("retains the dedicated source read limit without admitting oversized metadata", async () => {
    const source = reproductionSourceFixture();
    if (!source.sourceDefinition) throw new Error("Definition required.");
    source.sourceDefinition.binding.claim = "x".repeat(
      C.maximumEvaluationReproductionReadUtf8Bytes,
    );
    await expect(fixture(source).api.getSource(sourceScope)).rejects.toThrow();
  });
});
