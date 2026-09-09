import type * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { evaluationTestActor } from "../evaluations/fixtures.testing";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  assessmentCaseFixture,
  assessmentListFixture,
  assessmentPreviewFixture,
  assessmentRequestFixture,
  assessmentSummaryFixture,
  assessmentTestScope,
} from "./fixtures.testing";
import { createHttpEvaluationAssessmentAdapter } from "./index";

const root = "/api/v1/operator/repositories/repository-a/evaluations/evaluation-a";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const setup = (...values: unknown[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of values) fetch.mockResolvedValueOnce(json(value));
  return { fetch, adapter: createHttpEvaluationAssessmentAdapter({ fetch }) };
};
describe("evaluation assessment adapter", () => {
  it("preserves page-budget rejection until the caller explicitly chooses a smaller page", async () => {
    const smaller = { ...assessmentListFixture(), pageSize: 1 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            code: "evaluation_report_page_too_large",
            message: "The report snapshot page exceeds its read budget.",
          },
          400,
        ),
      )
      .mockResolvedValueOnce(json(smaller));
    const adapter = createHttpEvaluationAssessmentAdapter({ fetch });
    await expect(
      adapter.list(assessmentTestScope, { page: 2, pageSize: 20 }),
    ).rejects.toMatchObject({ status: 400, serverCode: "evaluation_report_page_too_large" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${root}/assessments?page=2&pageSize=20`);
    await expect(adapter.list(assessmentTestScope, { page: 1, pageSize: 1 })).resolves.toEqual(
      smaller,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(`${root}/assessments?page=1&pageSize=1`);
  });
  it("uses five bounded endpoints and saves only the original report request", async () => {
    const { fetch, adapter } = setup(
      assessmentPreviewFixture(),
      assessmentSummaryFixture(),
      assessmentListFixture(),
      assessmentSummaryFixture(),
      assessmentCaseFixture(),
    );
    expect(await adapter.preview(assessmentTestScope)).toEqual(assessmentPreviewFixture());
    expect(
      await adapter.save(assessmentTestScope, assessmentRequestFixture(), evaluationTestActor),
    ).toEqual(assessmentSummaryFixture());
    expect(await adapter.list(assessmentTestScope)).toEqual(assessmentListFixture());
    expect(await adapter.get({ ...assessmentTestScope, assessmentId: "assessment-a" })).toEqual(
      assessmentSummaryFixture(),
    );
    expect(
      await adapter.getCase({
        ...assessmentTestScope,
        assessmentId: "assessment-a",
        caseId: "case-1",
      }),
    ).toEqual(assessmentCaseFixture());
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      `${root}/score-preview`,
      `${root}/assessments`,
      `${root}/assessments?page=1&pageSize=20`,
      `${root}/assessments/assessment-a`,
      `${root}/assessments/assessment-a/cases/case-1`,
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(assessmentRequestFixture()));
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      });
  });
  it.each(["repositoryId", "evaluationId"] as const)(
    "rejects a preview from another %s",
    async (field) => {
      await expect(
        setup({ ...assessmentPreviewFixture(), [field]: "other" }).adapter.preview(
          assessmentTestScope,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it("rejects different saved report identities, versions, authors and history windows", async () => {
    await expect(
      setup({ ...assessmentSummaryFixture(), assessmentId: "other" }).adapter.get({
        ...assessmentTestScope,
        assessmentId: "assessment-a",
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      setup({ ...assessmentSummaryFixture(), version: 2 }).adapter.save(
        assessmentTestScope,
        assessmentRequestFixture(),
        evaluationTestActor,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      setup({
        ...assessmentSummaryFixture(),
        createdBy: { ...evaluationTestActor, subject: "other" },
      }).adapter.save(assessmentTestScope, assessmentRequestFixture(), evaluationTestActor),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      setup(assessmentListFixture()).adapter.list(assessmentTestScope, { page: 2 }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("rejects another report case and incomplete frozen expectation mappings", async () => {
    const other = assessmentCaseFixture();
    other.scope.assessmentId = "other";
    await expect(
      setup(other).adapter.getCase(assessmentCaseFixture().scope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const missing = assessmentCaseFixture();
    missing.expectation.criteria = [];
    await expect(
      setup(missing).adapter.getCase(assessmentCaseFixture().scope),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
  it("does not accept actor, raw snapshots, unsafe identities or unsupported pagination in requests", async () => {
    const { fetch, adapter } = setup();
    await expect(
      adapter.preview({ ...assessmentTestScope, evaluationId: "../other" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.list(assessmentTestScope, { pageSize: 51 })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.save(
        assessmentTestScope,
        {
          ...assessmentRequestFixture(),
          snapshot: {},
        } as unknown as C.EvaluationAssessmentPublishRequest,
        evaluationTestActor,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.save(
        assessmentTestScope,
        assessmentRequestFixture(),
        undefined as unknown as C.OperatorPrincipal,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the save input and actor while transport is pending", async () => {
    const request = assessmentRequestFixture(),
      original = structuredClone(request),
      actor = { ...evaluationTestActor };
    const { fetch, adapter } = setup(assessmentSummaryFixture()),
      pending = adapter.save(assessmentTestScope, request, actor);
    request.expectedInputDigest = "0".repeat(64);
    request.expectedVersion = 10;
    actor.subject = "other";
    await expect(pending).resolves.toEqual(assessmentSummaryFixture());
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(original));
  });
  it("applies two MiB read limits and caller cancellation without widening to raw scoring snapshots", async () => {
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
      createHttpEvaluationAssessmentAdapter({ fetch }).preview(assessmentTestScope),
    ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    const controller = new AbortController();
    controller.abort();
    const idle = setup();
    await expect(
      idle.adapter.getCase(assessmentCaseFixture().scope, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(idle.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 503])(
    "preserves HTTP %s and does not automatically retry saving",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json({ message: "Unavailable" }, status),
      );
      await expect(
        createHttpEvaluationAssessmentAdapter({ fetch }).save(
          assessmentTestScope,
          assessmentRequestFixture(),
          evaluationTestActor,
        ),
      ).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
