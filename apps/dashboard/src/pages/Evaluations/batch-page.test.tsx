import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationAdapter } from "@/services/configuration";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  batchDetailFixture,
  batchMatrixFixture,
  batchWaitingMatrixFixture,
} from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import {
  evaluationTestActor,
  suiteCaseDetailFixture,
  suiteVersionFixture,
} from "@/services/evaluations/fixtures.testing";
import { BatchCreate } from "./BatchCreate";
import {
  BatchConfigurationPanel,
  BatchDetails,
  BatchMatrix,
  BatchWorkspace,
} from "./BatchWorkspace";
import { EvaluationContext, MutationNotice, useEvaluationQuery } from "./context";

const state = vi.hoisted(() => ({
  queries: [] as {
    enabled: boolean;
    refetchInterval: number | false | ((query: { state: { status: string } }) => number | false);
    refetchIntervalInBackground: boolean;
    queryKey: readonly unknown[];
  }[],
}));
vi.mock("./AssessmentReports", () => ({
  AssessmentReports: () => <section>Assessment reports</section>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    cancelQueries: vi.fn(),
    removeQueries: vi.fn(),
  }),
  useQuery: (options: {
    enabled: boolean;
    refetchInterval: number | false | ((query: { state: { status: string } }) => number | false);
    refetchIntervalInBackground: boolean;
    queryKey: readonly unknown[];
  }) => {
    state.queries.push(options);
    return {
      data: options.queryKey.includes("batch-expectations")
        ? [suiteCaseDetailFixture()]
        : options.queryKey.includes("batch-detail-matrix")
          ? { detail: batchDetailFixture(), matrix: batchMatrixFixture() }
          : options.queryKey.includes("batch-profile")
            ? undefined
            : [],
      error: null,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch: vi.fn(),
    };
  },
}));
const provider = (children: ReactNode, readable = true) => (
  <EvaluationContext.Provider
    value={{
      api: {} as EvaluationAdapter,
      session: "same-session",
      repositoryId: "repository-a",
      principal: evaluationTestActor,
      readable,
      canConfigure: readable,
      allowsConfigure: true,
      invalidateAccess: vi.fn(),
    }}
  >
    {children}
  </EvaluationContext.Provider>
);
beforeEach(() => {
  state.queries = [];
});

describe("batch comparison interface", () => {
  it("shows two configuration arms and exact frozen criteria without a global Prompt request", () => {
    const html = renderToStaticMarkup(
      provider(
        <BatchCreate
          version={suiteVersionFixture()}
          api={{} as EvaluationBatchAdapter}
          configuration={{} as ConfigurationAdapter}
          active
          onCreated={vi.fn()}
          onPendingChange={vi.fn()}
        />,
      ),
    );
    expect(html).toContain("Create batch from version 1");
    expect(html).toContain("Baseline profile");
    expect(html).toContain("Candidate profile");
    expect(html).toContain("repository-visible Prompt");
    expect(html).toContain("No check is a missing mapping, never a passed outcome");
    expect(html).toContain("Expected failed");
    expect(html).toContain("Create evaluation batch");
    for (const label of [
      "Batch execution mode",
      "Baseline profile",
      "Candidate profile",
      "Baseline profile version",
      "Candidate profile version",
      "Baseline Prompt version",
      "Candidate Prompt version",
      "Baseline check for case case-1, criterion criterion-1",
      "Candidate check for case case-1, criterion criterion-1",
    ])
      expect(html).toContain(`aria-label="${label}"`);
    expect(
      state.queries.find((query) => query.queryKey.includes("batch-prompts"))?.queryKey,
    ).toContain("pr_static_build");
    expect(html).toContain("The Worker runs its configured model CLI");
  });
  it("gives the published version and cancellation reason explicit accessible names", () => {
    const workspace = renderToStaticMarkup(
      provider(
        <BatchWorkspace
          suiteId="suite-a"
          workflowKind="pr_static_build"
          target="headless"
          active
          onPendingChange={vi.fn()}
        />,
      ),
    );
    expect(workspace).toContain('aria-label="Published suite version to evaluate"');
    const detail = renderToStaticMarkup(
      provider(
        <BatchDetails
          api={{} as EvaluationBatchAdapter}
          evaluationId="evaluation-a"
          scope={{ suiteId: "suite-a", workflowKind: "pr_static_build", target: "headless" }}
          active
          onPendingChange={vi.fn()}
        />,
      ),
    );
    expect(detail).toContain('aria-label="Cancellation reason for batch evaluation-a"');
  });
  it("keeps previous configuration mounted after success and provides an explicit expand action", () => {
    const onOpenChange = vi.fn();
    const html = renderToStaticMarkup(
      <BatchConfigurationPanel
        open={false}
        pending={false}
        createdBatchId="confirmed-batch"
        onOpenChange={onOpenChange}
      >
        <input aria-label="Preserved selection" value="exact-profile-version" readOnly />
      </BatchConfigurationPanel>,
    );
    expect(html).toContain("Create another batch");
    expect(html).toContain("Your previous configuration is preserved");
    expect(html).toContain('hidden=""');
    expect(html).toContain('value="exact-profile-version"');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  it("forces an uncertain request to remain visible and disables configuration hiding", () => {
    const html = renderToStaticMarkup(
      provider(
        <BatchConfigurationPanel
          open={false}
          pending
          createdBatchId="earlier-batch"
          onOpenChange={vi.fn()}
        >
          <MutationNotice
            mutation={{
              request: { changeId: "original-change" },
              busy: false,
              error: "Response lost",
              conflict: false,
              retry: vi.fn(),
            }}
          />
        </BatchConfigurationPanel>,
      ),
    );
    expect(html).toContain("Retry original request");
    expect(html).not.toContain('hidden=""');
    expect(html).not.toContain("Create another batch");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Hide configuration/u);
  });
  it("distinguishes awaiting admission from the Worker queue", () => {
    const waiting = renderToStaticMarkup(<BatchMatrix matrix={batchWaitingMatrixFixture()} />);
    expect(waiting).toContain("Awaiting admission");
    expect(waiting).toContain("it is not queued for a Worker");
    const queued = renderToStaticMarkup(
      <BatchMatrix matrix={batchWaitingMatrixFixture("admitted")} />,
    );
    expect(queued).toContain("Queued");
    expect(queued).not.toContain("it is not queued for a Worker");
  });
  it("shows cancellation in progress, bounded blockers and result identity without claiming a report", () => {
    const matrix = batchMatrixFixture(),
      entry = matrix.cases[0];
    if (!entry) throw new Error("Case fixture required.");
    matrix.status = "cancelling";
    entry.baseline.blockerCount = 20;
    entry.baseline.blockers = Array.from({ length: 16 }, (_, index) => ({
      code: "missing_capability" as const,
      capability: `fixture-${index}`,
    }));
    entry.candidate.result = {
      resultId: "actual-result",
      runAttemptId: "actual-attempt",
      resultDigest: "a".repeat(64),
      createdAt: "2026-09-08T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(<BatchMatrix matrix={matrix} />);
    expect(html).toContain("Cancelling — active work remains");
    expect(html).toContain("16 of 20 blockers");
    expect(html).toContain("Only the first 16 blockers");
    expect(html).toContain("actual-result");
    expect(html).toContain("do not represent a scored report or verified evidence");
  });
  it("uses cancellation-specific conflict text", () => {
    const html = renderToStaticMarkup(
      provider(
        <MutationNotice
          mutation={{
            request: null,
            busy: false,
            error: "Control changed",
            conflict: true,
            retry: vi.fn(),
          }}
          conflictTitle="Cancellation control changed"
          conflictDescription="Refresh the control before another cancellation request."
        />,
      ),
    );
    expect(html).toContain("Cancellation control changed");
    expect(html).not.toContain("saved draft");
  });
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("stops polling when active=%s and readable=%s", (active, readable) => {
    function Probe() {
      useEvaluationQuery(["poll-fixture"], async () => "result", active, 10000);
      return null;
    }
    renderToStaticMarkup(provider(<Probe />, readable));
    expect(state.queries[0]).toMatchObject({
      enabled: false,
      refetchInterval: false,
      refetchIntervalInBackground: false,
    });
  });
  it("polls the visible active scope and disables background polling", () => {
    function Probe() {
      useEvaluationQuery(["poll-fixture"], async () => "result", true, 10000);
      return null;
    }
    renderToStaticMarkup(provider(<Probe />));
    expect(state.queries[0]).toMatchObject({
      enabled: true,
      refetchIntervalInBackground: false,
    });
    const interval = state.queries[0]?.refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function")
      throw new Error("The polling policy must inspect query state.");
    expect(interval({ state: { status: "success" } })).toBe(10000);
    expect(interval({ state: { status: "error" } })).toBe(false);
  });
});
