import type * as C from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationAdjudicationAdapter } from "@/services/evaluation-adjudication";
import {
  adjudicationActorFixture,
  adjudicationChangeFixture,
  adjudicationContextFixture,
  adjudicationRequestFixture,
  adjudicationResultFixture,
  adjudicationScopeFixture,
} from "@/services/evaluation-adjudication/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
} from "@/services/review-control/errors";
import {
  Adjudication,
  adjudicationEditingAllowed,
  adjudicationEditorForItem,
  applyReviewedAdjudicationVersion,
  assertAdjudicationContext,
  changeJudgmentKind,
  judgmentFromCurrent,
  judgmentLabel,
  validateJudgmentIntent,
} from "./Adjudication";
import { EvaluationContext } from "./context";
import { OriginalMutation } from "./state";

const state = vi.hoisted(() => ({
  context: null as C.EvaluationAdjudicationContextV1 | null,
  reviewer: true,
  checking: false,
  queries: [] as { enabled: boolean; queryKey: readonly unknown[] }[],
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    principal: adjudicationActorFixture,
    ready: true,
    checking: state.checking,
    pending: false,
    error: null,
    can: (permission: string) => permission === "review" && state.reviewer && !state.checking,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean; queryKey: readonly unknown[] }) => {
    state.queries.push(options);
    return {
      data: options.queryKey.includes("adjudications") ? state.context : undefined,
      error: null,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
const provider = (children: ReactNode, readable = true) => (
  <EvaluationContext.Provider
    value={{
      api: {} as EvaluationAdapter,
      session: "same-session",
      repositoryId: "repository-a",
      principal: adjudicationActorFixture,
      readable,
      canConfigure: false,
      allowsConfigure: false,
      invalidateAccess: vi.fn(),
    }}
  >
    {children}
  </EvaluationContext.Provider>
);
beforeEach(() => {
  state.context = adjudicationContextFixture();
  state.reviewer = true;
  state.checking = false;
  state.queries = [];
});

describe("adjudication context and intent", () => {
  it("matches the complete occurrence set independently of display IDs", () => {
    const result = adjudicationResultFixture(),
      context = adjudicationContextFixture();
    expect(() => assertAdjudicationContext(result, context)).not.toThrow();
    expect(result.modelReview.findings[0]?.findingId).toBe(
      result.modelReview.findings[1]?.findingId,
    );
    expect(context.items[0]?.occurrence.key).not.toBe(context.items[1]?.occurrence.key);
    const missing = { ...context, items: context.items.slice(1) };
    expect(() => assertAdjudicationContext(result, missing)).toThrow(/complete occurrence set/u);
    const first = context.items[0];
    if (!first) throw new Error("Occurrence required.");
    expect(() =>
      assertAdjudicationContext(result, { ...context, items: [first, first, first] }),
    ).toThrow(/complete occurrence set/u);
  });
  it.each(["resultDigest", "caseId", "arm", "modelState", "modelRequired"])(
    "rejects a context with changed %s",
    (field) => {
      const context = {
        ...adjudicationContextFixture(),
        [field]: field === "modelRequired" ? false : "different",
      } as C.EvaluationAdjudicationContextV1;
      expect(() => assertAdjudicationContext(adjudicationResultFixture(), context)).toThrow(
        /exact result/u,
      );
    },
  );
  it("permits reviewer editing despite unavailable evidence but not configure-only, non-required or incomplete model states", () => {
    const context = adjudicationContextFixture(),
      access = { active: true, readable: true, reviewer: true, fetching: false, error: null };
    expect(adjudicationResultFixture().evidenceComplete).toBe(false);
    expect(adjudicationEditingAllowed(context, access)).toBe(true);
    expect(adjudicationEditingAllowed(context, { ...access, reviewer: false })).toBe(false);
    expect(adjudicationEditingAllowed({ ...context, modelRequired: false }, access)).toBe(false);
    expect(adjudicationEditingAllowed({ ...context, modelState: "failed" }, access)).toBe(false);
    for (const changed of [
      { active: false },
      { readable: false },
      { fetching: true },
      { error: new Error("Unknown") },
    ])
      expect(adjudicationEditingAllowed(context, { ...access, ...changed })).toBe(false);
  });
  it("requires frozen expectations and direct primary matches, preserving one match per expected finding", () => {
    const context = adjudicationContextFixture(),
      key = "2".repeat(64),
      first = context.items[0];
    if (!first) throw new Error("Occurrence required.");
    expect(() =>
      validateJudgmentIntent(context, key, {
        kind: "match",
        expectedFindingId: "missing",
        reason: "reason",
      }),
    ).toThrow(/frozen/u);
    expect(() =>
      validateJudgmentIntent(context, key, {
        kind: "duplicate",
        primaryOccurrenceKey: first.occurrence.key,
        reason: "reason",
      }),
    ).toThrow(/primary/u);
    first.adjudication = adjudicationChangeFixture().adjudication;
    first.version = 1;
    expect(() =>
      validateJudgmentIntent(context, key, {
        kind: "match",
        expectedFindingId: "expected-one",
        reason: "reason",
      }),
    ).toThrow(/already uses/u);
    expect(() =>
      validateJudgmentIntent(context, key, {
        kind: "duplicate",
        primaryOccurrenceKey: first.occurrence.key,
        reason: "reason",
      }),
    ).not.toThrow();
    expect(() =>
      validateJudgmentIntent(context, key, {
        kind: "duplicate",
        primaryOccurrenceKey: key,
        reason: "reason",
      }),
    ).toThrow(/another current primary/u);
    const second = context.items[1];
    if (!second) throw new Error("Second occurrence required.");
    second.adjudication = adjudicationChangeFixture(
      {
        ...adjudicationRequestFixture(),
        judgment: {
          kind: "duplicate",
          primaryOccurrenceKey: first.occurrence.key,
          reason: "Duplicate",
        },
      },
      { ...adjudicationScopeFixture(), occurrenceKey: key },
    ).adjudication;
    expect(() =>
      validateJudgmentIntent(context, first.occurrence.key, {
        kind: "false_positive",
        reason: "reason",
      }),
    ).toThrow(/Resolve the existing duplicate/u);
  });
  it("keeps no prior judgment distinct from explicit unjudged and preserves reason when changing kind", () => {
    expect(judgmentLabel(null)).toBe("Not yet judged");
    const value = adjudicationChangeFixture({
      ...adjudicationRequestFixture(),
      judgment: { kind: "unjudged", reason: "Need investigation" },
    }).adjudication;
    expect(judgmentLabel(value)).toBe("Unjudged");
    expect(judgmentFromCurrent(value)).toEqual({ kind: "unjudged", reason: "Need investigation" });
    expect(changeJudgmentKind(judgmentFromCurrent(value), "duplicate")).toEqual({
      kind: "duplicate",
      primaryOccurrenceKey: "",
      reason: "Need investigation",
    });
  });
  it("does not change CAS when current data refreshes and reapplies a reviewed version only explicitly", () => {
    const item = adjudicationContextFixture().items[0];
    if (!item) throw new Error("Occurrence required.");
    const editor = adjudicationEditorForItem(item);
    editor.judgment = {
      kind: "match",
      expectedFindingId: "expected-one",
      reason: "Keep this intended judgment",
    };
    const refreshed = { occurrenceKey: item.occurrence.key, version: 2 };
    expect(editor.expectedVersion).toBe(0);
    const reapplied = applyReviewedAdjudicationVersion(editor, refreshed);
    expect(reapplied.expectedVersion).toBe(2);
    expect(reapplied.judgment).toBe(editor.judgment);
    expect(editor.expectedVersion).toBe(0);
    expect(() =>
      applyReviewedAdjudicationVersion(editor, { ...refreshed, occurrenceKey: "2".repeat(64) }),
    ).toThrow(/another occurrence/u);
  });
  it("retains the exact occurrence scope and change body after a lost response, without inventing a new version", async () => {
    const frame = { scope: adjudicationScopeFixture(), request: adjudicationRequestFixture() },
      original = structuredClone(frame),
      owner = new OriginalMutation<typeof frame>();
    await owner.run(
      frame,
      async () => {
        throw new ReviewControlNetworkError("judgment");
      },
      vi.fn(),
      vi.fn(),
    );
    frame.request.expectedVersion = 9;
    frame.scope.occurrenceKey = "2".repeat(64);
    frame.request.judgment.reason = "Changed later";
    const retry = vi.fn(async () => adjudicationChangeFixture());
    await owner.run(frame, retry, vi.fn(), vi.fn());
    expect(retry).toHaveBeenCalledExactlyOnceWith(original);
    const conflicted = new OriginalMutation<typeof frame>();
    await conflicted.run(
      original,
      async () => {
        throw new ReviewControlHttpError("Conflict", {
          operation: "judgment",
          status: 409,
          retryable: false,
        });
      },
      vi.fn(),
      vi.fn(),
    );
    expect(conflicted.snapshot()).toMatchObject({ conflict: true, request: null });
    expect(original.request.expectedVersion).toBe(0);
  });
});
describe("adjudication interface", () => {
  it("shows frozen labels and separate occurrences to a reviewer without configure permission", () => {
    const html = renderToStaticMarkup(
      provider(
        <Adjudication
          result={adjudicationResultFixture()}
          adapter={{} as EvaluationAdjudicationAdapter}
          active
        />,
      ),
    );
    expect(html).toContain("Human adjudication");
    expect(html).toContain("The known defect");
    expect(html).toContain("Model finding body 1");
    expect(html).toContain("Model finding body 2");
    expect(html).toContain("Not yet judged");
    expect(html).toContain("never approves a pull request");
    expect(html).not.toContain("Reviewer permission is required");
  });
  it.each(["viewer", "profile_only", "failed_model"])("explains why %s is read-only", (mode) => {
    const result = adjudicationResultFixture(),
      context = adjudicationContextFixture();
    if (mode === "viewer") state.reviewer = false;
    if (mode === "profile_only") {
      result.modelRequirements.required = false;
      context.modelRequired = false;
    }
    if (mode === "failed_model") {
      result.modelReview.state = "failed";
      context.modelState = "failed";
    }
    state.context = context;
    const html = renderToStaticMarkup(
      provider(
        <Adjudication result={result} adapter={{} as EvaluationAdjudicationAdapter} active />,
      ),
    );
    expect(html).toContain("Read-only adjudication");
    expect(html).toContain(
      mode === "viewer"
        ? "Reviewer permission"
        : mode === "profile_only"
          ? "does not participate in model adjudication"
          : "not completed",
    );
  });
  it("does not fetch a context while its retained result is hidden", () => {
    renderToStaticMarkup(
      provider(
        <Adjudication
          result={adjudicationResultFixture()}
          adapter={{} as EvaluationAdjudicationAdapter}
          active={false}
        />,
      ),
    );
    expect(state.queries.every((query) => !query.enabled)).toBe(true);
  });
});
