import {
  createInvestigationPreview,
  type InvestigationDiagnostic,
  type InvestigationNextActionDraft,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  projectInvestigationNextActions,
  validateInvestigationNextActions,
} from "./investigation-policy.js";

function fixture() {
  const { result } = createInvestigationPreview("bug");
  const proposals = result.nextActions.map(
    ({ state: _state, sourceReportRef: _source, ...draft }) => structuredClone(draft),
  );
  return { result, proposals };
}

describe("deterministic investigation next-action projection", () => {
  it("preserves valid proposals in order even when their execution prerequisites are not satisfied", () => {
    const { result, proposals } = fixture();
    const projected = projectInvestigationNextActions(
      result,
      proposals,
      result.plans,
      result.diagnostics,
    );
    expect(projected.nextActions).toEqual(result.nextActions);
    expect(projected.diagnostics).toEqual(result.diagnostics);
    expect(projected.nextActions[0]?.prerequisiteRefs.length).toBeGreaterThan(0);
    expect(
      validateInvestigationNextActions(
        { ...result, nextActions: projected.nextActions },
        result.plans,
      ).every((action) => action.valid),
    ).toBe(true);
  });

  it("retains a reproduction-plan mismatch as complete non-executable diagnostic data", () => {
    const { result, proposals } = fixture();
    const invalid = proposals[0]!;
    invalid.taskKind = "issue-verify";
    invalid.reason =
      'Keep every field, including a quoted "proposal",\na newline and Unicode: \u00e9.';
    const original = structuredClone(proposals);
    const projected = projectInvestigationNextActions(result, proposals, result.plans, []);
    expect(projected.nextActions).toEqual([result.nextActions[1]]);
    expect(projected.diagnostics).toHaveLength(1);
    const diagnostic = projected.diagnostics[0]!;
    expect(diagnostic).toMatchObject({
      code: "INVALID_NEXT_ACTION_PROPOSAL",
      category: "limitation",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    });
    expect(JSON.parse(diagnostic.message)).toEqual({
      projectionVersion: "InvestigationNextActionProjectionV1",
      sourceReportRef: { id: result.report.id, version: result.report.version },
      proposalIndex: 0,
      proposal: invalid,
      reasonCodes: ["plan_task_kind_mismatch"],
    });
    expect(proposals).toEqual(original);
    expect(invalid.taskKind).toBe("issue-verify");
    expect(result.plans[0]?.kind).toBe("reproduction");
    const onlyRejected = projectInvestigationNextActions(result, [invalid], result.plans, []);
    expect(onlyRejected.nextActions).toEqual([]);
    const complete = {
      ...result,
      nextActions: onlyRejected.nextActions,
      diagnostics: onlyRejected.diagnostics,
      report: { ...result.report, collections: { ...result.report.collections, nextActions: 0 } },
    };
    expect(complete.report.loop.candidates[0]?.status).toBe("unresolved");
    expect(validateInvestigationResult(complete)).toEqual({ valid: true, errors: [] });
  });

  it.each(["embedded", "standalone"] as const)(
    "rejects suggestion actions whose %s saved draft has no replacement suggestion",
    (origin) => {
      const { result, proposals } = fixture();
      const draft =
        origin === "embedded" ? result.findings[0]!.feedbackDraft : result.feedbackDrafts[0]!;
      draft.suggestion = null;
      const invalid: InvestigationNextActionDraft = {
        ...proposals[1]!,
        action: "suggestion-comment",
        taskKind: null,
        planRef: null,
        draftRef: draft.id,
        prerequisiteRefs: [],
      };
      const projected = projectInvestigationNextActions(result, [invalid], result.plans, []);
      expect(projected.nextActions).toEqual([]);
      expect(JSON.parse(projected.diagnostics[0]!.message)).toMatchObject({
        proposal: invalid,
        reasonCodes: ["missing_saved_suggestion"],
      });
      const complete = {
        ...result,
        nextActions: projected.nextActions,
        diagnostics: projected.diagnostics,
        report: { ...result.report, collections: { ...result.report.collections, nextActions: 0 } },
      };
      expect(validateInvestigationResult(complete)).toEqual({ valid: true, errors: [] });
    },
  );

  it("rejects linked PR verification on a source commit even when saved plan references agree", () => {
    const { result } = createInvestigationPreview("pr");
    const original = result.context.subjects.find(
      (subject) => subject.id === result.nextActions[0]!.subjectRef,
    );
    if (original?.kind !== "original_pr") throw new Error("The original PR subject is missing.");
    result.context.subjects = [
      {
        id: original.id,
        kind: "source_commit",
        repositoryId: original.repositoryId,
        workItemId: original.workItemId,
        revisionKey: original.revisionKey,
        commitSha: original.headSha,
      },
    ];
    const { state: _state, sourceReportRef: _source, ...proposal } = result.nextActions[0]!;
    const projected = projectInvestigationNextActions(result, [proposal], result.plans, []);
    expect(projected.nextActions).toEqual([]);
    expect(JSON.parse(projected.diagnostics[0]!.message)).toMatchObject({
      proposal,
      reasonCodes: ["invalid_pr_verification_binding"],
    });
  });

  it("preserves a suggestion action backed by a saved replacement", () => {
    const { result } = createInvestigationPreview("pr");
    const draft = result.findings[0]!.feedbackDraft;
    expect(draft.suggestion).not.toBeNull();
    const { state: _state, sourceReportRef: _source, ...base } = result.nextActions[1]!;
    const proposal: InvestigationNextActionDraft = {
      ...base,
      action: "suggestion-comment",
      taskKind: null,
      planRef: null,
      draftRef: draft.id,
      prerequisiteRefs: [],
    };
    const projected = projectInvestigationNextActions(result, [proposal], result.plans, []);
    expect(projected.nextActions).toEqual([
      {
        ...proposal,
        state: "saved",
        sourceReportRef: { id: result.report.id, version: result.report.version },
      },
    ]);
    expect(projected.diagnostics).toEqual([]);
  });

  it("preserves every rejection reason and keeps invalid references out of diagnostic reference fields", () => {
    const { result, proposals } = fixture();
    const invalid = {
      ...proposals[0]!,
      planRef: null,
      taskKind: null,
      draftRef: "missing-draft",
      prerequisiteRefs: ["missing-prerequisite"],
    };
    const projected = projectInvestigationNextActions(result, [invalid], [], []);
    expect(projected.nextActions).toEqual([]);
    expect(JSON.parse(projected.diagnostics[0]!.message)).toMatchObject({
      proposal: invalid,
      reasonCodes: [
        "invalid_saved_draft",
        "missing_saved_plan",
        "missing_task_kind",
        "unknown_prerequisite",
      ],
    });
    expect(projected.diagnostics[0]?.prerequisiteRefs).toEqual([]);
  });

  it("preserves colliding checkpoint diagnostics and produces stable identities after JSON key reordering", () => {
    const { result, proposals } = fixture();
    proposals[0]!.taskKind = "issue-verify";
    const first = projectInvestigationNextActions(result, proposals, result.plans, []);
    const saved: InvestigationDiagnostic = {
      ...first.diagnostics[0]!,
      message: "An independently accepted checkpoint limitation with the same ID.",
    };
    const projected = projectInvestigationNextActions(result, proposals, result.plans, [saved]);
    expect(projected.diagnostics[0]).toEqual(saved);
    expect(projected.diagnostics[1]?.id).toBe(`${saved.id}:1`);
    const reordered = proposals.map(
      (proposal) =>
        Object.fromEntries(Object.entries(proposal).reverse()) as InvestigationNextActionDraft,
    );
    expect(projectInvestigationNextActions(result, reordered, result.plans, [saved])).toEqual(
      projected,
    );
    projected.diagnostics[0]!.message = "Changed returned data";
    projected.nextActions[0]!.label = "Changed returned action";
    expect(saved.message).toBe("An independently accepted checkpoint limitation with the same ID.");
    expect(proposals[1]!.label).not.toBe("Changed returned action");
  });
});
