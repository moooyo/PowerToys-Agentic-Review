import {
  type InvestigationDiagnostic,
  type InvestigationFindingV1,
  type InvestigationResultV1,
  investigationCanonicalJson,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "./investigation-loop.js";

/** Shared internal construction keeps all checkpoint and generated diagnostic identities distinct. */
export function appendInvestigationProjectionDiagnostic(
  diagnostics: InvestigationDiagnostic[],
  code: "INVALID_NEXT_ACTION_PROPOSAL" | "FINDING_ORDINAL_NORMALIZED",
  envelope: unknown,
  ids: Set<string>,
): void {
  const prefix =
    code === "INVALID_NEXT_ACTION_PROPOSAL" ? "rejected-next-action" : "finding-ordinal";
  const baseId = `${prefix}:${investigationContentDigest(envelope)}`;
  let id = baseId;
  let suffix = 0;
  while (ids.has(id)) id = `${baseId}:${++suffix}`;
  ids.add(id);
  diagnostics.push({
    id,
    code,
    category: code === "INVALID_NEXT_ACTION_PROPOSAL" ? "limitation" : "recovery",
    message: investigationCanonicalJson(envelope),
    retryable: false,
    evidenceRefs: [],
    prerequisiteRefs: [],
  });
}

/** Report ordinals describe array position, never the model ledger or reviewed finding content. */
export function projectInvestigationReportFindings(
  checkpointFindings: readonly InvestigationFindingV1[],
  sourceReportRef: Pick<InvestigationResultV1["report"], "id" | "version">,
  checkpointDiagnostics: readonly InvestigationDiagnostic[],
): { findings: InvestigationFindingV1[]; diagnostics: InvestigationDiagnostic[] } {
  const diagnostics = structuredClone([...checkpointDiagnostics]);
  const ids = new Set(diagnostics.map((diagnostic) => diagnostic.id));
  const reportReference = { id: sourceReportRef.id, version: sourceReportRef.version };
  const findings = checkpointFindings.map((finding, ordinal) => {
    if (finding.ordinal !== ordinal)
      appendInvestigationProjectionDiagnostic(
        diagnostics,
        "FINDING_ORDINAL_NORMALIZED",
        {
          projectionVersion: "InvestigationFindingOrdinalProjectionV1",
          sourceReportRef: reportReference,
          findingId: finding.id,
          findingVersion: finding.version,
          originalOrdinal: finding.ordinal,
          reportOrdinal: ordinal,
        },
        ids,
      );
    return { ...structuredClone(finding), ordinal };
  });
  return { findings, diagnostics };
}
