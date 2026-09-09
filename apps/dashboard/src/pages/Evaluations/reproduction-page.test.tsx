import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observationRefKey } from "@/components/CreateReviewRun/reproduction";
import type { EvaluationReproductionAdapter } from "@/services/evaluation-reproduction";
import {
  reproductionCaseFixture,
  reproductionCellFixture,
  reproductionPreviewFixture,
  reproductionPreviewRequestFixture,
  reproductionProfileFixture,
  reproductionSourceFixture,
} from "@/services/evaluation-reproduction/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import { evaluationTestActor } from "@/services/evaluations/fixtures.testing";
import { EvaluationContext } from "./context";
import { ReproductionMapping } from "./ReproductionMapping";
import { FrozenReproductionRecord } from "./ReproductionPlan";
import { ReproductionPreview, ReproductionPreviewResult } from "./ReproductionPreview";
import { type ReproductionDrafts, reproductionRequirements } from "./reproduction-state";

const state = vi.hoisted(() => ({
  queries: [] as { enabled: boolean; queryKey: readonly unknown[] }[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean; queryKey: readonly unknown[] }) => {
    state.queries.push(options);
    return { data: undefined, error: null, isError: false, isFetching: false, refetch: vi.fn() };
  },
}));
const provider = (children: ReactNode, readable = true, canConfigure = true) => (
  <EvaluationContext.Provider
    value={{
      api: {} as EvaluationAdapter,
      session: "reproduction-session",
      repositoryId: "repository-a",
      principal: evaluationTestActor,
      readable,
      canConfigure,
      allowsConfigure: canConfigure,
      invalidateAccess: vi.fn(),
    }}
  >
    {children}
  </EvaluationContext.Provider>
);
beforeEach(() => {
  state.queries = [];
});
function mappingFixture() {
  const entry = reproductionCaseFixture(),
    source = reproductionSourceFixture();
  const key = reproductionRequirements(source.sourceDefinition!.binding.cases).observations[0]!.key;
  const drafts: ReproductionDrafts = {
    [entry.caseId]: {
      sourceDefinitionSha256: source.sourceDefinitionSha256!,
      selectedCaseIds: ["original-case"],
      baseline: {
        observations: {
          [key]: observationRefKey({
            kind: "probe_value",
            testStepId: "measure",
            observationId: "count",
          }),
        },
        checks: { "original-profile:build": "profile-baseline:build" },
      },
      candidate: { observations: { [key]: null }, checks: { "original-profile:build": null } },
    },
  };
  return {
    cases: [entry],
    sources: { [source.sourceId]: source },
    drafts,
    profiles: {
      baseline: reproductionProfileFixture(),
      candidate: reproductionProfileFixture("candidate"),
    },
    api: {} as EvaluationReproductionAdapter,
    onChange: vi.fn(),
  };
}

describe("Issue evaluation reproduction interface", () => {
  it("shows original claims, signatures, explicit cases and separate arm mappings", () => {
    const html = renderToStaticMarkup(
      provider(<ReproductionMapping {...mappingFixture()} locked={false} />),
    );
    expect(html).toContain("Saving once leaves zero records.");
    expect(html).toContain("Issue present when every observation matches");
    expect(html).toContain("Issue absent when every observation matches");
    expect(html).toContain("number · 0");
    expect(html).toContain("number · 1");
    expect(html).toContain("original-profile:build");
    expect(html).toContain('aria-label="Original reproduction cases for case-1"');
    expect(html).toContain("Baseline reproduction mapping");
    expect(html).toContain("Candidate reproduction mapping");
    expect(html).toContain("This arm will be blocked");
    expect(html).toContain('aria-label="Preview reproduction mapping for case-1"');
    expect(state.queries[0]?.enabled).toBe(false);
    expect(JSON.stringify(state.queries[0]?.queryKey)).toContain("reproduction-session");
    expect(JSON.stringify(state.queries[0]?.queryKey)).toContain("profile-baseline");
    expect(JSON.stringify(state.queries[0]?.queryKey)).toContain("profile-candidate");
  });
  it("keeps source selection explicit and does not preview incomplete mappings", () => {
    const value = mappingFixture();
    const html = renderToStaticMarkup(
      provider(<ReproductionMapping {...value} drafts={{}} locked={false} />),
    );
    expect(html).toContain("Not selected");
    expect(html).toContain("Complete the explicit reproduction mapping choices");
    expect(html).not.toContain('aria-label="Preview reproduction mapping for case-1"');
    expect(state.queries).toEqual([]);
  });
  it("explains missing source definitions without using expectation labels", () => {
    const value = mappingFixture();
    value.sources["source-a"]!.sourceDefinition = null;
    value.sources["source-a"]!.sourceDefinitionSha256 = null;
    const html = renderToStaticMarkup(provider(<ReproductionMapping {...value} locked={false} />));
    expect(html).toContain("This source has no frozen reproduction definition");
    expect(html).not.toContain("Preview reproduction mapping");
    expect(state.queries).toEqual([]);
  });
  it("shows blocked previews as configuration results without implying execution", () => {
    const html = renderToStaticMarkup(
      <ReproductionPreviewResult value={reproductionPreviewFixture()} />,
    );
    expect(html).toContain("Mapping ready");
    expect(html).toContain("Mapping blocked");
    expect(html).toContain("checks your choices without running validation");
    expect(html).toContain("Creating the batch rechecks the original source and selected profiles");
  });
  it("disables preview while access cannot configure the repository", () => {
    const source = reproductionSourceFixture();
    const html = renderToStaticMarkup(
      provider(
        <ReproductionPreview
          api={{} as EvaluationReproductionAdapter}
          request={reproductionPreviewRequestFixture()}
          sourceDefinitionSha256={source.sourceDefinitionSha256!}
          profiles={{
            baseline: reproductionProfileFixture(),
            candidate: reproductionProfileFixture("candidate"),
          }}
          disabled={false}
          onPreview={vi.fn()}
        />,
        false,
        false,
      ),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Preview reproduction mapping/u);
    expect(state.queries.every((query) => !query.enabled)).toBe(true);
  });
  it("retains original requirements and explicit unmapped targets in a frozen blocked cell", () => {
    const html = renderToStaticMarkup(
      <FrozenReproductionRecord
        detail={reproductionCellFixture()}
        original={reproductionSourceFixture().sourceDefinition}
      />,
    );
    expect(html).toContain("Frozen mapping blockers");
    expect(html).toContain("Saving once leaves zero records.");
    expect(html).toContain("Unmapped");
    expect(html).toContain("does not establish execution, reproduction or a passing result");
  });
});
