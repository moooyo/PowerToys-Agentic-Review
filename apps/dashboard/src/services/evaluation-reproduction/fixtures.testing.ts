import { createHash } from "node:crypto";
import type * as C from "@agentic-review/contracts";
import { batchDetailFixture } from "../evaluation-batches/fixtures.testing";
import { suiteCaseDetailFixture } from "../evaluations/fixtures.testing";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Fixture values must be JSON.");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
export const reproductionFixtureDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const reproductionFixtureScope = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
  cellId: "cell-baseline",
};
export function reproductionProfileFixture(
  arm: "baseline" | "candidate" = "baseline",
): C.ValidationProfileVersion {
  const step = (id: string): C.ValidationCommandStep => ({
    id,
    name: id,
    command: { executable: "fixture", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 1000,
    required: true,
  });
  return {
    ...batchDetailFixture().configurations[arm].profile,
    workflowKind: "issue_validation",
    target: "headless",
    outputSchemaVersion: "ValidationReportV1",
    config: {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      build: [step("build")],
      test: [
        {
          ...step("measure"),
          probeOutput: {
            schemaVersion: "TestProbeOutputDeclarationV1",
            fields: [
              { id: "count", description: "Number of saved records", type: "number" },
              { id: "visible", description: "Visibility", type: "boolean" },
            ],
          },
        },
      ],
      launch: [],
      cleanup: [],
      requiredCapabilities: [],
      hardTimeoutMs: 5000,
      noProgressTimeoutMs: 1000,
    },
  };
}
export function reproductionCaseFixture(): C.EvaluationSuiteCaseDetailV1 {
  const entry = suiteCaseDetailFixture();
  entry.source.workItemKind = "issue";
  return entry;
}
export function reproductionSourceFixture(): C.EvaluationReproductionSourceDefinitionReadV1 {
  const entry = reproductionCaseFixture();
  const binding: C.IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "original-activation",
    repositoryId: entry.repositoryId,
    githubRepositoryId: 100,
    workItemId: entry.source.workItemId,
    githubWorkItemId: 200,
    issueRevisionKey: entry.source.revisionKey,
    testedSourceCommit: "b".repeat(40),
    authorizedBy: {
      issuer: "https://fixture.example.test",
      subject: "maintainer",
      authorizedAt: "2026-09-09T00:00:00.000Z",
    },
    claim: "Saving once leaves zero records.",
    cases: [
      {
        id: "original-case",
        context: "Observe the saved record count after one save.",
        requestId: "original-request",
        profileVersionId: "original-profile",
        profileConfigSha256: "c".repeat(64),
        target: "headless",
        preconditions: [{ kind: "check_passed", checkId: "original-profile:build" }],
        presentWhen: {
          allOf: [
            {
              observation: {
                kind: "probe_value",
                testStepId: "original-probe",
                observationId: "records",
              },
              equals: { type: "number", value: 0 },
            },
          ],
        },
        absentWhen: {
          allOf: [
            {
              observation: {
                kind: "probe_value",
                testStepId: "original-probe",
                observationId: "records",
              },
              equals: { type: "number", value: 1 },
            },
          ],
        },
      },
    ],
  };
  const sourceDefinition: C.EvaluationReproductionSourceDefinitionV1 = {
    schemaVersion: "EvaluationReproductionSourceDefinitionV1",
    repositoryId: entry.repositoryId,
    sourceId: entry.source.id,
    sourceDigest: entry.source.sourceDigest,
    reviewRunId: "original-run",
    planDigest: "a".repeat(64),
    bindingDigest: reproductionFixtureDigest(binding),
    binding,
  };
  return {
    schemaVersion: "EvaluationReproductionSourceDefinitionReadV1",
    repositoryId: entry.repositoryId,
    sourceId: entry.source.id,
    sourceDefinition,
    sourceDefinitionSha256: reproductionFixtureDigest(sourceDefinition),
  };
}
export function reproductionSelectionFixture(): C.EvaluationReproductionMappingSelectionV1 {
  const definition = reproductionSourceFixture().sourceDefinition;
  if (!definition) throw new Error("Source definition required.");
  return {
    caseId: "case-1",
    selectedCaseIds: ["original-case"],
    expectedSource: {
      reviewRunId: definition.reviewRunId,
      planDigest: definition.planDigest,
      bindingDigest: definition.bindingDigest,
    },
    baseline: {
      observationMappings: [
        {
          from: { kind: "probe_value", testStepId: "original-probe", observationId: "records" },
          to: { kind: "probe_value", testStepId: "measure", observationId: "count" },
        },
      ],
      checkMappings: [
        { fromCheckId: "original-profile:build", toCheckId: "profile-baseline:build" },
      ],
    },
    candidate: {
      observationMappings: [
        {
          from: { kind: "probe_value", testStepId: "original-probe", observationId: "records" },
          to: null,
        },
      ],
      checkMappings: [{ fromCheckId: "original-profile:build", toCheckId: null }],
    },
  };
}
export function reproductionPreviewRequestFixture(): C.EvaluationReproductionPreviewRequest {
  return {
    sourceId: "source-a",
    selection: reproductionSelectionFixture(),
    baselineProfileVersionId: "profile-baseline",
    candidateProfileVersionId: "profile-candidate",
  };
}
export function reproductionPreviewFixture(): C.EvaluationReproductionPreviewV1 {
  const source = reproductionSourceFixture();
  if (!source.sourceDefinitionSha256) throw new Error("Source digest required.");
  return {
    schemaVersion: "EvaluationReproductionPreviewV1",
    repositoryId: "repository-a",
    sourceId: source.sourceId,
    sourceDefinitionSha256: source.sourceDefinitionSha256,
    baseline: {
      profileVersionId: "profile-baseline",
      profileConfigSha256: reproductionProfileFixture().configSha256,
      state: "ready",
      blockers: [],
    },
    candidate: {
      profileVersionId: "profile-candidate",
      profileConfigSha256: reproductionProfileFixture("candidate").configSha256,
      state: "blocked",
      blockers: [
        {
          code: "mapping_unmapped",
          message: "The selected original observation is explicitly unmapped.",
        },
      ],
    },
  };
}
export function reproductionCellFixture(): C.EvaluationReproductionCellDetailV1 {
  const source = reproductionSourceFixture(),
    selection = reproductionSelectionFixture();
  const record: C.EvaluationReproductionCellRecordV1 = {
    schemaVersion: "EvaluationReproductionCellRecordV1",
    ...reproductionFixtureScope,
    caseId: "case-1",
    arm: "baseline",
    sourceId: source.sourceId,
    sourceDefinitionSha256: source.sourceDefinitionSha256,
    selectedCaseIds: selection.selectedCaseIds,
    mappings: selection.candidate,
    state: "blocked",
    blockers: [
      { code: "mapping_unmapped", message: "The original observation is explicitly unmapped." },
    ],
    reproduction: null,
  };
  return {
    schemaVersion: "EvaluationReproductionCellDetailV1",
    ...reproductionFixtureScope,
    record,
    cellRecordSha256: reproductionFixtureDigest(record),
  };
}
export function reproductionPlanFixture(): C.EvaluationReproductionPlanV1 {
  const source = reproductionSourceFixture(),
    cell = reproductionCellFixture();
  if (!source.sourceDefinitionSha256) throw new Error("Source digest required.");
  return {
    schemaVersion: "EvaluationReproductionPlanV1",
    repositoryId: "repository-a",
    evaluationId: "evaluation-a",
    manifest: {
      schemaVersion: "EvaluationReproductionManifestV1",
      repositoryId: "repository-a",
      evaluationId: "evaluation-a",
      sources: [
        {
          caseId: "case-1",
          sourceId: source.sourceId,
          sourceDefinitionSha256: source.sourceDefinitionSha256,
        },
      ],
      cells: [
        {
          cellId: "cell-baseline",
          caseId: "case-1",
          arm: "baseline",
          cellRecordSha256: cell.cellRecordSha256,
        },
        {
          cellId: "cell-candidate",
          caseId: "case-1",
          arm: "candidate",
          cellRecordSha256: "e".repeat(64),
        },
      ],
    },
  };
}
