import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationAssessmentAdapter } from "@/services/evaluation-assessments";
import {
  assessmentCaseFixture,
  assessmentListFixture,
  assessmentPreviewFixture,
  assessmentScoringFixture,
  assessmentSummaryFixture,
  assessmentTestScope,
} from "@/services/evaluation-assessments/fixtures.testing";
import {
  batchMatrixFixture,
  completedCellMatrixFixture,
} from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import { evaluationTestActor } from "@/services/evaluations/fixtures.testing";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
} from "@/services/review-control/errors";
import {
  AssessmentCase,
  AssessmentReports,
  AssessmentSummary,
  assertAssessmentCaseReport,
  assertAssessmentPreviewReceipt,
  assessmentMatrixStamp,
  assessmentRatioLabel,
  assessmentReportPageSizes,
  assessmentSaveIntent,
  changeAssessmentReportPageSize,
  currentAssessmentResult,
  isAssessmentReportPageTooLarge,
  ManualAssessmentPreview,
} from "./AssessmentReports";
import { EvaluationContext } from "./context";
import { OriginalMutation } from "./state";

const state = vi.hoisted(() => ({
  reviewer: true,
  listError: null as unknown,
  queries: [] as { queryKey: readonly unknown[]; enabled: boolean }[],
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    ready: true,
    checking: false,
    pending: false,
    error: null,
    principal: evaluationTestActor,
    can: (permission: string) => permission === "review" && state.reviewer,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[]; enabled: boolean }) => {
    state.queries.push(options);
    return {
      data: options.queryKey.includes("assessment-list") ? assessmentListFixture() : undefined,
      error: options.queryKey.includes("assessment-list") ? state.listError : null,
      isError: options.queryKey.includes("assessment-list") && state.listError !== null,
      isPending: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
const provider = (children: ReactNode, readable = true) => (
  <EvaluationContext.Provider
    value={{
      api: {} as EvaluationAdapter,
      session: "session-a",
      repositoryId: "repository-a",
      principal: evaluationTestActor,
      readable,
      canConfigure: false,
      allowsConfigure: false,
      invalidateAccess: vi.fn(),
    }}
  >
    {children}
  </EvaluationContext.Provider>
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
beforeEach(() => {
  state.reviewer = true;
  state.listError = null;
  state.queries = [];
});

describe("manual assessment preview", () => {
  it("calculates only when explicitly invoked, prevents duplicate work, and never restarts after invalidation", async () => {
    const owner = new ManualAssessmentPreview(),
      response = deferred<ReturnType<typeof assessmentPreviewFixture>>(),
      load = vi.fn(() => response.promise);
    expect(owner.snapshot().value).toBeNull();
    expect(load).not.toHaveBeenCalled();
    const pending = owner.calculate(load, vi.fn());
    await owner.calculate(load, vi.fn());
    expect(load).toHaveBeenCalledOnce();
    response.resolve(assessmentPreviewFixture());
    await pending;
    expect(owner.snapshot().value).toEqual(assessmentPreviewFixture());
    owner.invalidate();
    expect(owner.snapshot().value).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });
  it("aborts scope changes and ignores a late preview even if its loader ignores cancellation", async () => {
    const owner = new ManualAssessmentPreview(),
      response = deferred<ReturnType<typeof assessmentPreviewFixture>>();
    const load = vi.fn((_signal: AbortSignal) => response.promise),
      pending = owner.calculate(load, vi.fn());
    owner.dispose();
    expect(load.mock.calls[0]?.[0].aborted).toBe(true);
    response.resolve(assessmentPreviewFixture());
    await pending;
    expect(owner.snapshot().value).toBeNull();
  });
  it("does not automatically repeat a failed or denied expensive preview", async () => {
    const owner = new ManualAssessmentPreview(),
      denied = vi.fn(),
      load = vi.fn(async () => {
        throw new ReviewControlHttpError("Forbidden", {
          status: 403,
          retryable: false,
          operation: "preview",
        });
      });
    await owner.calculate(load, denied);
    expect(denied).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({ value: null, busy: false });
  });
  it("captures and retries the same input digest, expected version and change ID after response loss", async () => {
    const intent = assessmentSaveIntent(
        assessmentTestScope,
        assessmentPreviewFixture(),
        1,
        "original-save",
      ),
      original = structuredClone(intent),
      owner = new OriginalMutation<typeof intent>();
    await owner.run(
      intent,
      async () => {
        throw new ReviewControlNetworkError("save report");
      },
      vi.fn(),
      vi.fn(),
    );
    intent.request.expectedVersion = 9;
    intent.request.expectedInputDigest = "0".repeat(64);
    intent.request.changeId = "replacement";
    const retry = vi.fn(async () => assessmentSummaryFixture());
    await owner.run(intent, retry, vi.fn(), vi.fn());
    expect(retry).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.request).toEqual({
      changeId: "original-save",
      expectedVersion: 0,
      expectedInputDigest: "e".repeat(64),
    });
  });
  it("binds the saved summary to the preview while ignoring only object property order", () => {
    const preview = assessmentPreviewFixture(),
      saved = assessmentSummaryFixture();
    saved.summary = Object.fromEntries(
      Object.entries(saved.summary).reverse(),
    ) as typeof saved.summary;
    expect(() => assertAssessmentPreviewReceipt(saved, preview)).not.toThrow();
    saved.summary.baseline.quality.correctChecks = 7;
    expect(() => assertAssessmentPreviewReceipt(saved, preview)).toThrow(/summary/u);
    expect(() =>
      assessmentSaveIntent(
        { ...assessmentTestScope, evaluationId: "another-batch" },
        preview,
        1,
        "change-one",
      ),
    ).toThrow(/another batch/u);
  });
  it("leaves a conflict unresolved until a new preview has been explicitly reviewed", async () => {
    const owner = new OriginalMutation<ReturnType<typeof assessmentSaveIntent>>(),
      intent = assessmentSaveIntent(assessmentTestScope, assessmentPreviewFixture(), 1, "save-one");
    const execute = vi.fn(async () => {
      throw new ReviewControlHttpError("Inputs changed", {
        status: 409,
        retryable: false,
        operation: "save report",
      });
    });
    await owner.run(intent, execute, vi.fn(), vi.fn());
    const previews = new ManualAssessmentPreview();
    await previews.calculate(
      async () => ({
        ...assessmentPreviewFixture(),
        assessmentVersion: 2,
        inputDigest: "9".repeat(64),
      }),
      vi.fn(),
    );
    expect(owner.snapshot().conflict).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(intent.request.expectedVersion).toBe(0);
    expect(intent.request.expectedInputDigest).toBe("e".repeat(64));
  });
});

describe("assessment report presentation", () => {
  it("keeps the explicit page-size recovery control visible after a budget rejection", () => {
    state.listError = new ReviewControlHttpError("Page too large", {
      operation: "list reports",
      status: 400,
      retryable: false,
      serverCode: "evaluation_report_page_too_large",
    });
    const preview = vi.fn();
    const html = renderToStaticMarkup(
      provider(
        <AssessmentReports
          evaluationId="evaluation-a"
          active
          onPendingChange={vi.fn()}
          adapter={{ preview } as unknown as EvaluationAssessmentAdapter}
        />,
      ),
    );
    expect(html).toContain("Choose a smaller page size to load these reports");
    expect(html).toContain('aria-label="Reports per page"');
    expect(assessmentReportPageSizes).toEqual([1, 5, 10, 20, 50]);
    expect(
      state.queries.find((query) => query.queryKey.includes("assessment-list"))?.queryKey.slice(-2),
    ).toEqual([1, 20]);
    expect(preview).not.toHaveBeenCalled();
    expect(
      isAssessmentReportPageTooLarge(
        new ReviewControlHttpError("Other bad request", {
          operation: "list",
          status: 400,
          retryable: false,
          serverCode: "other",
        }),
      ),
    ).toBe(false);
  });
  it("returns to page one without changing an original pending report save or calculating a preview", async () => {
    const intent = assessmentSaveIntent(
        assessmentTestScope,
        assessmentPreviewFixture(),
        1,
        "same-save",
      ),
      owner = new OriginalMutation<typeof intent>();
    await owner.run(
      intent,
      async () => {
        throw new ReviewControlNetworkError("save report");
      },
      vi.fn(),
      vi.fn(),
    );
    const pending = owner.snapshot().request,
      preview = new ManualAssessmentPreview();
    expect(changeAssessmentReportPageSize(1)).toEqual({ page: 1, pageSize: 1 });
    expect(changeAssessmentReportPageSize(5)).toEqual({ page: 1, pageSize: 5 });
    expect(owner.snapshot().request).toBe(pending);
    expect(owner.snapshot().request?.request).toEqual(intent.request);
    expect(preview.snapshot().calculation).toBe(0);
  });
  it("shows coverage and quality separately and labels zero or unresolved denominators not evaluable", () => {
    expect(assessmentRatioLabel({ numerator: 0, denominator: 0, value: null })).toBe(
      "Not evaluable (0/0)",
    );
    expect(assessmentRatioLabel({ numerator: 1, denominator: 3, value: null })).toBe(
      "Not evaluable (1/3)",
    );
    const html = renderToStaticMarkup(<AssessmentSummary summary={assessmentScoringFixture()} />);
    for (const label of [
      "Execution coverage",
      "Check coverage",
      "Model coverage",
      "Check agreement",
      "false positives",
      "false negatives",
      "unjudged",
      "Paired changes",
      "Not evaluable",
      "provisional",
    ])
      expect(html).toContain(label);
  });
  it("compares frozen descriptions and expected failure against actual outcomes without claiming live evidence", () => {
    const html = renderToStaticMarkup(<AssessmentCase value={assessmentCaseFixture()} />);
    expect(html).toContain("Known failing build");
    expect(html).toContain("The original build defect remains a failed check");
    expect(html).toContain("expected failed");
    expect(html).toContain("Actual: failed");
    expect(html).toContain("Actual: passed");
    expect(html).toContain("The known compiler defect");
    expect(html).toContain("The model output was unavailable");
    expect(html).toContain("does not reverify live evidence");
    expect(html).not.toContain("View current result");
  });
  it("opens only result identities that still match the current matrix", () => {
    const value = assessmentCaseFixture(),
      matrix = completedCellMatrixFixture();
    expect(currentAssessmentResult(matrix, value.case.baseline)?.cellId).toBe("cell-baseline");
    expect(currentAssessmentResult(matrix, value.case.candidate)).toBeNull();
    if (!value.case.baseline.result) throw new Error("Result required.");
    value.case.baseline.result.runAttemptId = "superseded-attempt";
    expect(currentAssessmentResult(matrix, value.case.baseline)).toBeNull();
  });
  it("ties a case to its saved report and frozen scoring plan", () => {
    const value = assessmentCaseFixture(),
      summary = assessmentSummaryFixture();
    expect(() => assertAssessmentCaseReport(value, summary)).not.toThrow();
    value.reportDigest = "0".repeat(64);
    expect(() => assertAssessmentCaseReport(value, summary)).toThrow(/saved report/u);
  });
  it("lists saved reports first without calculating a preview on mount or rendering another batch state", () => {
    const preview = vi.fn(),
      adapter = { preview } as unknown as EvaluationAssessmentAdapter;
    const html = renderToStaticMarkup(
      provider(
        <AssessmentReports
          evaluationId="evaluation-a"
          matrix={batchMatrixFixture()}
          active
          onPendingChange={vi.fn()}
          adapter={adapter}
        />,
      ),
    );
    expect(html).toContain("Version 1");
    expect(html).toContain("Calculate preview");
    expect(preview).not.toHaveBeenCalled();
    expect(state.queries.every((query) => !query.queryKey.includes("score-preview"))).toBe(true);
    const changed = batchMatrixFixture();
    changed.status = "running";
    expect(assessmentMatrixStamp(changed)).not.toBe(assessmentMatrixStamp(batchMatrixFixture()));
    renderToStaticMarkup(
      provider(
        <AssessmentReports
          evaluationId="evaluation-a"
          matrix={changed}
          active
          onPendingChange={vi.fn()}
          adapter={adapter}
        />,
      ),
    );
    expect(preview).not.toHaveBeenCalled();
  });
  it("allows a reviewer without configure permission and explains read-only report saving", () => {
    const html = renderToStaticMarkup(
      provider(
        <AssessmentReports
          evaluationId="evaluation-a"
          active
          onPendingChange={vi.fn()}
          adapter={{} as EvaluationAssessmentAdapter}
        />,
      ),
    );
    expect(html).not.toContain("Reviewer permission is required");
    state.reviewer = false;
    expect(
      renderToStaticMarkup(
        provider(
          <AssessmentReports
            evaluationId="evaluation-a"
            active
            onPendingChange={vi.fn()}
            adapter={{} as EvaluationAssessmentAdapter}
          />,
        ),
      ),
    ).toContain("Reviewer permission is required to save reports");
  });
});
