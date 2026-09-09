import type * as C from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  batchDetailFixture,
  batchMatrixFixture,
  cellResultFixture,
  completedCellMatrixFixture,
} from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import { evaluationTestActor } from "@/services/evaluations/fixtures.testing";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { BatchMatrix } from "./BatchWorkspace";
import { CellResultContent, CellResultDrawer, retainAdjudicationResult } from "./CellResult";
import {
  assertCellResultBinding,
  cellResultBindingKey,
  currentEvidenceLabel,
  selectedCellResultBinding,
} from "./cell-result-state";
import { EvaluationContext } from "./context";

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: null as unknown,
  fetching: false,
  pending: false,
  options: null as null | {
    enabled: boolean;
    refetchInterval: unknown;
    queryKey: readonly unknown[];
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  },
}));
vi.mock("./EvaluationEvidence", () => ({
  EvaluationEvidence: () => <div>Evidence file panel</div>,
}));
vi.mock("antd", async (original) => ({
  ...(await original<typeof import("antd")>()),
  Drawer: ({ children, open }: { children: ReactNode; open: boolean }) => (
    <section aria-label="Result drawer" hidden={!open}>
      {children}
    </section>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof state.options>) => {
    state.options = options;
    return {
      data: state.data,
      error: state.error,
      isError: state.error !== null,
      isFetching: state.fetching,
      isPending: state.pending,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const selection = { cellId: "cell-baseline", resultId: "result-baseline" };
vi.mock("./Adjudication", () => ({ Adjudication: () => <div>Adjudication panel</div> }));
function binding() {
  const value = selectedCellResultBinding(
    batchDetailFixture(),
    completedCellMatrixFixture(),
    selection,
  );
  if (!value) throw new Error("A completed cell binding is required.");
  return value;
}
const invalidateAccess = vi.fn();
function provider(children: ReactNode, readable = true) {
  return (
    <EvaluationContext.Provider
      value={{
        api: {} as EvaluationAdapter,
        session: "session-a",
        repositoryId: "repository-a",
        principal: evaluationTestActor,
        readable,
        canConfigure: false,
        allowsConfigure: false,
        invalidateAccess,
      }}
    >
      {children}
    </EvaluationContext.Provider>
  );
}
beforeEach(() => {
  state.data = cellResultFixture();
  state.error = null;
  state.fetching = false;
  state.pending = false;
  state.options = null;
  vi.clearAllMocks();
});

describe("matrix result identity", () => {
  it("retains the verified adjudication result through temporary empty bindings and clears a different selection", () => {
    const previous = { identity: "selected-result", result: cellResultFixture() };
    expect(retainAdjudicationResult(previous, null, undefined)).toBe(previous);
    expect(retainAdjudicationResult(previous, "selected-result", undefined)).toBe(previous);
    expect(retainAdjudicationResult(previous, "another-result", undefined)).toBeNull();
    expect(retainAdjudicationResult(null, null, undefined)).toBeNull();
  });
  it("matches every immutable identity before displaying a result", () => {
    const expected = binding(),
      result = cellResultFixture();
    expect(() => assertCellResultBinding(result, expected)).not.toThrow();
    for (const field of [
      ...Object.keys(expected.scope),
      ...Object.keys(expected.expected),
    ] as (keyof C.EvaluationCellResultV1)[]) {
      expect(() =>
        assertCellResultBinding(
          { ...result, [field]: "different-identity" } as C.EvaluationCellResultV1,
          expected,
        ),
      ).toThrow(/no longer matches/u);
    }
    expect(() =>
      assertCellResultBinding(
        { ...result, modelRequirements: { required: false, expectedModelIdentityDigest: null } },
        expected,
      ),
    ).toThrow(/no longer matches/u);
  });
  it("clears a selected result when the matrix, batch or Job no longer supplies its exact identity", () => {
    expect(
      selectedCellResultBinding(batchDetailFixture(), batchMatrixFixture(), selection),
    ).toBeNull();
    const matrix = completedCellMatrixFixture(),
      detail = batchDetailFixture();
    detail.summary.id = "another-batch";
    expect(selectedCellResultBinding(detail, matrix, selection)).toBeNull();
    const entry = matrix.cases[0];
    if (!entry) throw new Error("Case required.");
    entry.baseline.job = null;
    expect(selectedCellResultBinding(batchDetailFixture(), matrix, selection)).toBeNull();
  });
  it("does not reset result identity when only matrix progress or blockers refresh", () => {
    const detail = batchDetailFixture(),
      matrix = completedCellMatrixFixture(),
      first = binding();
    matrix.progress.blocked = 1;
    const second = selectedCellResultBinding(detail, matrix, selection);
    expect(second && cellResultBindingKey(second)).toBe(cellResultBindingKey(first));
  });
});

describe("evaluation result presentation", () => {
  it("offers result reading only for real matrix result identities", () => {
    expect(
      renderToStaticMarkup(<BatchMatrix matrix={batchMatrixFixture()} onViewResult={vi.fn()} />),
    ).not.toContain("View result");
    const html = renderToStaticMarkup(
      <BatchMatrix matrix={completedCellMatrixFixture()} onViewResult={vi.fn()} />,
    );
    expect(html).toContain('aria-label="View Baseline result for case case-1"');
  });
  it("shows checks, diagnostics and advice without approving or inventing evidence links", () => {
    const html = renderToStaticMarkup(<CellResultContent result={cellResultFixture()} />);
    expect(html).toContain("Expected");
    expect(html).toContain("Actual");
    expect(html).toContain("Exit code 0");
    expect(html).toContain("Fixture output");
    expect(html).toContain("Currently verified");
    expect(html).toContain("Model recommendation: approve");
    expect(html).toContain("do not approve a pull request");
    expect(html).toContain("evidence-build");
    expect(html).not.toContain("/review-runs/");
    expect(html).not.toContain("Download");
  });
  it("keeps profile-only model execution distinct from failure", () => {
    const result = cellResultFixture();
    result.modelRequirements = { required: false, expectedModelIdentityDigest: null };
    result.modelReview = {
      state: "not_requested",
      summary: null,
      recommendation: null,
      findings: [],
      observations: [],
      issueTriage: null,
      reproductionConclusion: null,
      error: null,
    };
    const html = renderToStaticMarkup(<CellResultContent result={result} />);
    expect(html).toContain("Not required");
    expect(html).toContain("This is not a model failure");
    expect(html).not.toContain("MODEL_FAILED");
  });
  it("preserves repeated observation IDs and ordered diagnostics as separate recorded entries", () => {
    const result = cellResultFixture();
    result.modelReview.observations = [
      {
        id: "same-id",
        title: "First observation",
        body: "First recorded detail",
        priority: 1,
        path: null,
        line: null,
      },
      {
        id: "same-id",
        title: "Second observation",
        body: "Second recorded detail",
        priority: 2,
        path: null,
        line: null,
      },
    ];
    const diagnostic = result.execution.diagnostics[0];
    if (!diagnostic) throw new Error("Diagnostic required.");
    result.execution.diagnostics.push({
      ...diagnostic,
      summary: "Later diagnostic for the same step",
    });
    const before = structuredClone(result);
    const html = renderToStaticMarkup(<CellResultContent result={result} />);
    expect(html).toContain("First recorded detail");
    expect(html).toContain("Second recorded detail");
    expect(html).toContain("Later diagnostic for the same step");
    expect(result).toEqual(before);
  });
  it("distinguishes current verification from pending and unavailable evidence", () => {
    const result = cellResultFixture();
    expect(currentEvidenceLabel(result)).toBe("Currently verified");
    expect(
      currentEvidenceLabel({
        ...result,
        evidenceComplete: false,
        evidenceVerificationPending: true,
      }),
    ).toBe("Pending verification");
    expect(currentEvidenceLabel({ ...result, evidenceComplete: false })).toBe(
      "Unavailable or incomplete",
    );
  });
  it.each(["fetching", "error", "permission", "selection"])(
    "does not expose a previous result during %s uncertainty",
    (condition) => {
      state.fetching = condition === "fetching";
      state.error = condition === "error" ? new Error("Read unavailable") : null;
      const html = renderToStaticMarkup(
        provider(
          <CellResultDrawer
            api={{} as EvaluationBatchAdapter}
            binding={condition === "selection" ? null : binding()}
            active
            onClose={vi.fn()}
          />,
          condition !== "permission",
        ),
      );
      expect(html).not.toContain("The original source was checked");
      expect(html).not.toContain("evidence-build");
    },
  );
  it("reads with an abort signal, rechecks the result binding, and does not poll", async () => {
    const getCellResult = vi.fn(async () => cellResultFixture());
    renderToStaticMarkup(
      provider(
        <CellResultDrawer
          api={{ getCellResult } as unknown as EvaluationBatchAdapter}
          binding={binding()}
          active
          onClose={vi.fn()}
        />,
      ),
    );
    const options = state.options;
    if (!options) throw new Error("A query is required.");
    expect(options.refetchInterval).toBe(false);
    const controller = new AbortController();
    await options.queryFn({ signal: controller.signal });
    expect(getCellResult).toHaveBeenCalledWith(binding().scope, controller.signal);
    getCellResult.mockResolvedValueOnce({
      ...cellResultFixture(),
      profileVersionId: "another-profile",
    });
    await expect(options.queryFn({ signal: controller.signal })).rejects.toThrow(
      /no longer matches/u,
    );
  });
  it("invalidates access on a forbidden result read", async () => {
    const api = {
      getCellResult: vi.fn(async () => {
        throw new ReviewControlHttpError("Forbidden", {
          status: 403,
          retryable: false,
          operation: "read cell result",
        });
      }),
    } as unknown as EvaluationBatchAdapter;
    renderToStaticMarkup(
      provider(<CellResultDrawer api={api} binding={binding()} active onClose={vi.fn()} />),
    );
    const options = state.options;
    if (!options) throw new Error("A query is required.");
    await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({
      status: 403,
    });
    expect(invalidateAccess).toHaveBeenCalledOnce();
  });
});
