import { createInvestigationPreview, validateInvestigationResult } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { projectInvestigationNextActions } from "./investigation-policy.js";
import { projectInvestigationReportFindings } from "./investigation-report-projection.js";

describe("investigation report finding position projection", () => {
  it.each([
    [1, 2, 3],
    [0, 0, 0],
    [17, 5, 100],
  ])(
    "derives zero-based display positions without sorting or editing reviewed content: %j",
    (...ordinals) => {
      const { result } = createInvestigationPreview("pr", { findingCount: 3 });
      result.findings.forEach((finding, index) => {
        finding.ordinal = ordinals[index]!;
      });
      const original = structuredClone(result.findings);
      const projected = projectInvestigationReportFindings(
        result.findings,
        result.report,
        result.diagnostics,
      );
      expect(projected.findings).toEqual(
        original.map((finding, ordinal) => ({ ...finding, ordinal })),
      );
      expect(projected.findings.map((finding) => finding.id)).toEqual(
        original.map((finding) => finding.id),
      );
      expect(projected.diagnostics).toHaveLength(
        ordinals.filter((ordinal, index) => ordinal !== index).length,
      );
      for (const diagnostic of projected.diagnostics) {
        const envelope = JSON.parse(diagnostic.message);
        const source = original[envelope.reportOrdinal]!;
        expect(envelope).toEqual({
          projectionVersion: "InvestigationFindingOrdinalProjectionV1",
          sourceReportRef: { id: result.report.id, version: result.report.version },
          findingId: source.id,
          findingVersion: source.version,
          originalOrdinal: source.ordinal,
          reportOrdinal: envelope.reportOrdinal,
        });
      }
      expect(result.findings).toEqual(original);
    },
  );

  it("delivers an unresolved hypothesis with one-based ordinal and only a rejected action proposal", () => {
    const { result } = createInvestigationPreview("bug");
    result.findings[0]!.ordinal = 1;
    const { state: _state, sourceReportRef: _source, ...proposal } = result.nextActions[0]!;
    proposal.taskKind = "issue-verify";
    const findings = projectInvestigationReportFindings(
      result.findings,
      { id: result.report.id, version: result.report.version },
      [],
    );
    const actions = projectInvestigationNextActions(
      { ...result, findings: findings.findings },
      [proposal],
      result.plans,
      findings.diagnostics,
    );
    const projected = {
      ...result,
      findings: findings.findings,
      nextActions: actions.nextActions,
      diagnostics: actions.diagnostics,
      report: { ...result.report, collections: { ...result.report.collections, nextActions: 0 } },
    };
    expect(projected.nextActions).toEqual([]);
    expect(projected.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "FINDING_ORDINAL_NORMALIZED",
      "INVALID_NEXT_ACTION_PROPOSAL",
    ]);
    expect(new Set(projected.diagnostics.map((diagnostic) => diagnostic.id)).size).toBe(2);
    expect(validateInvestigationResult(projected)).toEqual({ valid: true, errors: [] });
    expect(result.findings[0]!.ordinal).toBe(1);
  });

  it("preserves checkpoint diagnostics that collide with an ordinal projection identity", () => {
    const { result } = createInvestigationPreview("pr");
    result.findings[0]!.ordinal = 9;
    const reference = { id: result.report.id, version: result.report.version };
    const first = projectInvestigationReportFindings(result.findings, reference, []);
    const checkpointDiagnostic = {
      ...first.diagnostics[0]!,
      message: "Original checkpoint record",
    };
    const projected = projectInvestigationReportFindings(result.findings, reference, [
      checkpointDiagnostic,
    ]);
    expect(projected.diagnostics[0]).toEqual(checkpointDiagnostic);
    expect(projected.diagnostics[1]?.id).toBe(`${checkpointDiagnostic.id}:1`);
  });
});
