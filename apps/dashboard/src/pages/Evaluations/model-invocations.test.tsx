import type * as C from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchDetailFixture,
  batchMatrixFixture,
} from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationModelInvocationAdapter } from "@/services/evaluation-model-invocations";
import { evaluationCellInvocationListFixture } from "@/services/evaluation-model-invocations/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import { evaluationTestActor } from "@/services/evaluations/fixtures.testing";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { BatchMatrix } from "./BatchWorkspace";
import { EvaluationContext } from "./context";
import { ModelInvocationDrawer, ModelInvocationHistory } from "./ModelInvocations";
import {
  assertCellInvocationBinding,
  type CellInvocationBinding,
  cellInvocationBindingKey,
  selectedCellInvocationBinding,
} from "./model-invocation-state";

const observed = vi.hoisted(() => ({
  data: undefined as unknown,
  error: null as unknown,
  fetching: false,
  options: null as null | {
    enabled: boolean;
    queryKey: readonly unknown[];
    refetchInterval: unknown;
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  },
}));
vi.mock("antd", async (original) => ({
  ...(await original<typeof import("antd")>()),
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <section aria-label="Invocation drawer" hidden={!open}>
      {children}
    </section>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof observed.options>) => {
    observed.options = options;
    return {
      data: observed.data,
      error: observed.error,
      isError: observed.error !== null,
      isPending: false,
      isFetching: observed.fetching,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The synthetic invocation fixture is incomplete.");
  return value;
}
function binding(): CellInvocationBinding {
  const value = evaluationCellInvocationListFixture();
  return {
    scope: {
      repositoryId: value.repositoryId,
      evaluationId: value.evaluationId,
      cellId: value.cellId,
    },
    caseTitle: "Synthetic compile case",
    arm: "baseline",
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    modelRequired: true,
    expectedRuntimeRegistration: value.expectedRuntimeRegistration,
  };
}
const invalidateAccess = vi.fn();
function provider(
  children: ReactNode,
  options: {
    readable?: boolean;
    session?: string;
    repositoryId?: string;
    connected?: boolean;
  } = {},
) {
  return (
    <EvaluationContext.Provider
      value={{
        api: { mode: options.connected === false ? "sample" : "connected" } as EvaluationAdapter,
        session: options.session ?? "session-a",
        repositoryId: options.repositoryId ?? "repository-a",
        principal: evaluationTestActor,
        readable: options.readable ?? true,
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
  observed.data = evaluationCellInvocationListFixture();
  observed.error = null;
  observed.fetching = false;
  observed.options = null;
  vi.clearAllMocks();
});

describe("Model invocation cell binding", () => {
  it("binds cells that have no completed result or Job yet", () => {
    const detail = batchDetailFixture(),
      matrix = batchMatrixFixture();
    const cell = required(matrix.cases[0]).baseline;
    cell.result = null;
    cell.job = null;
    expect(selectedCellInvocationBinding(detail, matrix, cell.cellId)).toMatchObject({
      runId: cell.runId,
      requestId: cell.requestId,
      jobId: null,
    });
  });
  it("clears a selection if its batch, repository or suite changes", () => {
    const matrix = batchMatrixFixture(),
      cell = required(matrix.cases[0]).baseline;
    expect(selectedCellInvocationBinding(undefined, matrix, cell.cellId)).toBeNull();
    expect(selectedCellInvocationBinding(batchDetailFixture(), matrix, "missing")).toBeNull();
    for (const key of ["id", "repositoryId", "suiteVersionId"] as const) {
      const detail = batchDetailFixture();
      detail.summary[key] = "another";
      expect(selectedCellInvocationBinding(detail, matrix, cell.cellId)).toBeNull();
    }
  });
  it.each(["repositoryId", "evaluationId", "cellId"] as const)(
    "rejects another %s response",
    (key) => {
      const value = evaluationCellInvocationListFixture();
      value[key] = "another";
      expect(() => assertCellInvocationBinding(value, binding())).toThrow(/selected cell/u);
    },
  );
  it.each(["runId", "requestId", "jobId"] as const)(
    "rejects a foreign %s within the selected cell",
    (key) => {
      const value = evaluationCellInvocationListFixture();
      required(value.items[0]).opening.scope[key] = "another";
      expect(() => assertCellInvocationBinding(value, binding())).toThrow(/selected cell/u);
    },
  );
  it("compares the complete frozen registration, independently of object key order", () => {
    const value = evaluationCellInvocationListFixture();
    value.expectedRuntimeRegistration = Object.fromEntries(
      Object.entries(required(value.expectedRuntimeRegistration)).reverse(),
    ) as C.ModelRuntimeRegistrationV1;
    expect(() => assertCellInvocationBinding(value, binding())).not.toThrow();
    value.expectedRuntimeRegistration.name = "Changed expectation";
    expect(() => assertCellInvocationBinding(value, binding())).toThrow(/frozen configuration/u);
  });
  it("permits a newly observed Job while rejecting model records for a profile-only cell", () => {
    const value = evaluationCellInvocationListFixture();
    expect(() => assertCellInvocationBinding(value, { ...binding(), jobId: null })).not.toThrow();
    expect(() =>
      assertCellInvocationBinding(value, { ...binding(), modelRequired: false }),
    ).toThrow();
  });
});

describe("Invocation diagnostics presentation", () => {
  it("offers model history independently of final result availability", () => {
    const html = renderToStaticMarkup(
      <BatchMatrix matrix={batchMatrixFixture()} onViewInvocations={vi.fn()} />,
    );
    expect(html).toContain('aria-label="View Baseline model calls for case case-1"');
    expect(html).not.toContain("View result");
  });
  it("shows expected and actual model names while retaining unaccepted execution", () => {
    const history = evaluationCellInvocationListFixture();
    const html = renderToStaticMarkup(<ModelInvocationHistory history={history} />);
    expect(html).toContain(required(history.expectedRuntimeRegistration).identity.modelId);
    expect(html).toContain("Recorded provider model");
    expect(html).toContain("Collection matches");
    expect(html).toContain("Not accepted");
    expect(html).toContain("they do not approve a pull request");
    expect(html).not.toContain("Execution succeeded");
  });
  it.each(["open", "sealed"] as const)(
    "does not infer running or passed from a %s collection",
    (state) => {
      const html = renderToStaticMarkup(
        <ModelInvocationHistory history={evaluationCellInvocationListFixture(state)} />,
      );
      expect(html).toContain(state === "open" ? "Closure not received" : "Ledger not received");
      expect(html).not.toContain("Collection matches");
      expect(html).not.toContain("Completed:");
    },
  );
  it("shows failed calls and incomplete collection without hiding their reason", () => {
    const history = evaluationCellInvocationListFixture(),
      item = required(history.items[0]);
    required(item.submission).consistency = {
      state: "unavailable",
      reasons: ["CALL_CHAIN_INCOMPLETE", "OUTPUT_UNBOUND"],
      observedIdentitySha256: null,
    };
    item.callOutcomes = {
      completed: 0,
      provider_failed: 1,
      provider_incomplete: 0,
      transport_failed: 0,
      cancelled: 0,
      protocol_invalid: 0,
      budget_exceeded: 0,
    };
    item.observedIdentity = null;
    const html = renderToStaticMarkup(<ModelInvocationHistory history={history} />);
    expect(html).toContain("Provider failed: 1");
    expect(html).toContain("Collection incomplete");
    expect(html).toContain("One or more calls failed");
    expect(html).toContain("not bound to a validated model output");
  });
  it("retains explicit empty history rather than fabricating successful observations", () => {
    const history = evaluationCellInvocationListFixture();
    history.items = [];
    history.total = 0;
    const html = renderToStaticMarkup(<ModelInvocationHistory history={history} />);
    expect(html).toContain("No model invocation has been recorded");
    expect(html).not.toContain("Collection matches");
  });
});

describe("Invocation drawer scope and access", () => {
  const render = (options: Parameters<typeof provider>[1] = {}, active = true) =>
    renderToStaticMarkup(
      provider(
        <ModelInvocationDrawer binding={binding()} active={active} onClose={vi.fn()} />,
        options,
      ),
    );
  it("allows readers and does not poll expensive history reads", () => {
    expect(render()).toContain("Recorded provider model");
    expect(required(observed.options).enabled).toBe(true);
    expect(required(observed.options).refetchInterval).toBe(false);
    expect(required(observed.options).queryKey).toContain(cellInvocationBindingKey(binding()));
  });
  it.each([{ readable: false }, { repositoryId: "another-repository" }])(
    "removes previous content on access/scope loss %s",
    (options) => {
      expect(render(options)).not.toContain("Recorded provider model");
      expect(observed.options).toBeNull();
    },
  );
  it("unmounts data when inactive", () => {
    expect(render({}, false)).not.toContain("Recording opened");
    expect(observed.options).toBeNull();
  });
  it("keeps sample mode disconnected", () => {
    expect(render({ connected: false })).toContain("Server connection required");
    expect(required(observed.options).enabled).toBe(false);
  });
  it("keys the cached read by session and hides stale data during refresh/errors", () => {
    render({ session: "session-new" });
    expect(required(observed.options).queryKey).toContain("session-new");
    observed.fetching = true;
    expect(render()).not.toContain("Recorded provider model");
    observed.fetching = false;
    observed.error = new Error("Unavailable");
    expect(render()).toContain("Invocation history unavailable");
    expect(render()).not.toContain("Recorded provider model");
  });
  it("binds fresh responses and propagates current access loss", async () => {
    const list = vi.fn(async () => evaluationCellInvocationListFixture());
    const adapter: EvaluationModelInvocationAdapter = { mode: "connected", list };
    renderToStaticMarkup(
      provider(
        <ModelInvocationDrawer binding={binding()} active onClose={vi.fn()} adapter={adapter} />,
      ),
    );
    const signal = new AbortController().signal;
    await required(observed.options).queryFn({ signal });
    expect(list).toHaveBeenCalledWith(binding().scope, { page: 1, pageSize: 10 }, signal);
    list.mockRejectedValueOnce(
      new ReviewControlHttpError("Denied", {
        operation: "read invocation history",
        status: 403,
        serverCode: "forbidden",
        retryable: false,
      }),
    );
    await expect(required(observed.options).queryFn({ signal })).rejects.toBeInstanceOf(
      ReviewControlHttpError,
    );
    expect(invalidateAccess).toHaveBeenCalledOnce();
  });
});
