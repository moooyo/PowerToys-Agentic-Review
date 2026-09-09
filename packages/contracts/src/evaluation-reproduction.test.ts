import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  EvaluationCellManifestSchema,
  EvaluationCellManifestV1Schema,
  EvaluationCellManifestV2Schema,
  getEvaluationBatchCreateRequestIssues,
  getEvaluationCellManifestIssues,
} from "./evaluation-batches.js";
import {
  type EvaluationReproductionCellRecordV1,
  EvaluationReproductionCellRecordV1Schema,
  type EvaluationReproductionMappingSelectionV1,
  type EvaluationReproductionSourceDefinitionV1,
  getEvaluationReproductionArmMappingsIssues,
  getEvaluationReproductionCellDetailIssues,
  getEvaluationReproductionCellRecordIssues,
  getEvaluationReproductionManifestIssues,
  getEvaluationReproductionMappingSelectionIssues,
  getEvaluationReproductionPlanIssues,
  getEvaluationReproductionPreviewIssues,
  getEvaluationReproductionPreviewRequestIssues,
  getEvaluationReproductionSourceDefinitionIssues,
  getEvaluationReproductionSourceDefinitionReadIssues,
  maximumEvaluationReproductionDocumentUtf8Bytes,
} from "./evaluation-reproduction.js";

const sha = "a".repeat(64);
const from = { kind: "probe_value" as const, testStepId: "old-probe", observationId: "observed" };
const to = { kind: "probe_value" as const, testStepId: "new-probe", observationId: "observed" };
function definition(): EvaluationReproductionSourceDefinitionV1 {
  return {
    schemaVersion: "EvaluationReproductionSourceDefinitionV1",
    repositoryId: "repo",
    sourceId: "source",
    sourceDigest: sha,
    reviewRunId: "run",
    planDigest: sha,
    bindingDigest: sha,
    binding: {
      schemaVersion: "IssueReproductionBindingV1",
      activationId: "activation",
      repositoryId: "repo",
      githubRepositoryId: 1,
      workItemId: "item",
      githubWorkItemId: 2,
      issueRevisionKey: sha,
      testedSourceCommit: "b".repeat(40),
      authorizedBy: {
        issuer: "fixture",
        subject: "operator",
        authorizedAt: "2026-09-09T00:00:00.000Z",
      },
      claim: "Synthetic claim.",
      cases: [
        {
          id: "repro",
          context: "Synthetic context.",
          preconditions: [],
          presentWhen: { allOf: [{ observation: from, equals: { type: "boolean", value: true } }] },
          absentWhen: null,
          requestId: "request",
          profileVersionId: "profile",
          profileConfigSha256: sha,
          target: "headless",
        },
      ],
    },
  };
}
function selection(): EvaluationReproductionMappingSelectionV1 {
  return {
    caseId: "case",
    selectedCaseIds: ["repro"],
    expectedSource: { reviewRunId: "run", planDigest: sha, bindingDigest: sha },
    baseline: { observationMappings: [{ from, to }], checkMappings: [] },
    candidate: { observationMappings: [{ from, to: null }], checkMappings: [] },
  };
}
function record(): EvaluationReproductionCellRecordV1 {
  return {
    schemaVersion: "EvaluationReproductionCellRecordV1",
    evaluationId: "evaluation",
    repositoryId: "repo",
    caseId: "case",
    cellId: "baseline",
    arm: "baseline",
    sourceId: "source",
    sourceDefinitionSha256: sha,
    selectedCaseIds: ["repro"],
    mappings: selection().baseline,
    state: "ready",
    blockers: [],
    reproduction: { binding: definition().binding, bindingDigest: sha },
  };
}
const entry = {
  cellId: "baseline",
  caseId: "case",
  arm: "baseline" as const,
  trial: 1 as const,
  sourceId: "source",
  sourceDigest: sha,
  runId: "run",
  requestId: "request",
  activationId: "activation",
  profileVersionId: "profile",
  promptVersionId: "prompt",
  renderedPromptDigest: sha,
  outputSchemaDigest: sha,
  modelRequirements: { required: false, expectedModelIdentityDigest: null },
};
function manifest() {
  return {
    schemaVersion: "EvaluationReproductionManifestV1" as const,
    evaluationId: "evaluation",
    repositoryId: "repo",
    sources: [{ caseId: "case", sourceId: "source", sourceDefinitionSha256: sha }],
    cells: [
      { cellId: "baseline", caseId: "case", arm: "baseline" as const, cellRecordSha256: sha },
      { cellId: "candidate", caseId: "case", arm: "candidate" as const, cellRecordSha256: sha },
    ],
  };
}

describe("explicit reproduction contracts", () => {
  it("retains explicit null destinations without silently omitting requirements", () => {
    expect(getEvaluationReproductionMappingSelectionIssues(selection())).toEqual([]);
    expect(selection().candidate.observationMappings[0]?.to).toBeNull();
  });
  it("rejects duplicate sources even when destinations differ", () => {
    const mappings = selection().baseline;
    mappings.observationMappings.push({
      from: { observationId: "observed", testStepId: "old-probe", kind: "probe_value" },
      to: null,
    });
    expect(getEvaluationReproductionArmMappingsIssues(mappings)).not.toEqual([]);
  });
  it.each(["expectedOutcome", "findings", "authorization", "executionAccepted"])(
    "rejects injected %s fields",
    (field) => {
      expect(
        getEvaluationReproductionMappingSelectionIssues({ ...selection(), [field]: true }),
      ).not.toEqual([]);
    },
  );
  it("rejects getter-bearing input without reading its value", () => {
    const input = selection();
    const getter = vi.fn(() => ({ observationMappings: [], checkMappings: [] }));
    Object.defineProperty(input, "baseline", { enumerable: true, get: getter });
    expect(getEvaluationReproductionMappingSelectionIssues(input)).not.toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });
  it("preserves valid source definitions and rejects outer repository swaps", () => {
    expect(getEvaluationReproductionSourceDefinitionIssues(definition())).toEqual([]);
    expect(
      getEvaluationReproductionSourceDefinitionIssues({ ...definition(), repositoryId: "other" }),
    ).not.toEqual([]);
  });
  it.each(["ready", "blocked", "not_applicable"] as const)(
    "validates %s state and binding semantics",
    (state) => {
      const value = record();
      value.state = state;
      if (state !== "ready") value.reproduction = null;
      if (state === "blocked")
        value.blockers = [{ code: "mapping_missing", message: "Missing mapping." }];
      expect(getEvaluationReproductionCellRecordIssues(value)).toEqual([]);
      if (state === "ready") value.reproduction = null;
      else value.reproduction = record().reproduction;
      expect(getEvaluationReproductionCellRecordIssues(value)).not.toEqual([]);
    },
  );
  it("does not permit a missing source to impersonate a blocked or ready mapped definition", () => {
    const value = record();
    value.sourceDefinitionSha256 = null;
    expect(getEvaluationReproductionCellRecordIssues(value)).not.toEqual([]);
    value.state = "not_applicable";
    value.selectedCaseIds = [];
    value.mappings = null;
    value.reproduction = null;
    expect(getEvaluationReproductionCellRecordIssues(value)).toEqual([]);
  });
  it("requires both arms and rejects duplicate or orphan manifest entries", () => {
    const value = manifest();
    expect(getEvaluationReproductionManifestIssues(value)).toEqual([]);
    expect(
      getEvaluationReproductionManifestIssues({ ...value, cells: value.cells.slice(0, 1) }),
    ).not.toEqual([]);
    expect(
      getEvaluationReproductionManifestIssues({
        ...value,
        sources: [...value.sources, ...value.sources],
      }),
    ).not.toEqual([]);
    expect(
      getEvaluationReproductionManifestIssues({
        ...value,
        sources: [{ ...value.sources[0], caseId: "orphan" }],
      }),
    ).not.toEqual([]);
  });
  it("keeps source read nullability and detail scope exact", () => {
    const read = {
      schemaVersion: "EvaluationReproductionSourceDefinitionReadV1",
      repositoryId: "repo",
      sourceId: "source",
      sourceDefinition: definition(),
      sourceDefinitionSha256: sha,
    };
    expect(getEvaluationReproductionSourceDefinitionReadIssues(read)).toEqual([]);
    expect(
      getEvaluationReproductionSourceDefinitionReadIssues({ ...read, sourceDefinition: null }),
    ).not.toEqual([]);
    const detail = {
      schemaVersion: "EvaluationReproductionCellDetailV1",
      evaluationId: "evaluation",
      repositoryId: "repo",
      cellId: "baseline",
      record: record(),
      cellRecordSha256: sha,
    };
    expect(getEvaluationReproductionCellDetailIssues(detail)).toEqual([]);
    expect(
      getEvaluationReproductionCellDetailIssues({ ...detail, cellId: "candidate" }),
    ).not.toEqual([]);
    expect(
      getEvaluationReproductionPlanIssues({
        schemaVersion: "EvaluationReproductionPlanV1",
        evaluationId: "evaluation",
        repositoryId: "repo",
        manifest: manifest(),
      }),
    ).toEqual([]);
  });
  it("does not expose a frozen binding or pretend authorization through preview", () => {
    const request = {
      sourceId: "source",
      selection: selection(),
      baselineProfileVersionId: "baseline-profile",
      candidateProfileVersionId: "candidate-profile",
    };
    expect(getEvaluationReproductionPreviewRequestIssues(request)).toEqual([]);
    const arm = {
      profileVersionId: "profile",
      profileConfigSha256: sha,
      state: "ready",
      blockers: [],
    };
    const preview = {
      schemaVersion: "EvaluationReproductionPreviewV1",
      repositoryId: "repo",
      sourceId: "source",
      sourceDefinitionSha256: sha,
      baseline: arm,
      candidate: arm,
    };
    expect(getEvaluationReproductionPreviewIssues(preview)).toEqual([]);
    expect(
      getEvaluationReproductionPreviewIssues({ ...preview, reproduction: record().reproduction }),
    ).not.toEqual([]);
    expect(
      getEvaluationReproductionPreviewIssues({
        ...preview,
        candidate: { ...arm, state: "blocked" },
      }),
    ).not.toEqual([]);
  });
  it("rejects aggregate oversized records rather than truncating interpretation", () => {
    const value = record();
    if (value.reproduction === null) throw new Error("Fixture binding missing.");
    const original = value.reproduction.binding.cases[0];
    if (original === undefined) throw new Error("Fixture case missing.");
    const predicates = Array.from({ length: 16 }, (_, index) => ({
      observation: {
        kind: "probe_value" as const,
        testStepId: "probe",
        observationId: `field-${index}`,
      },
      equals: { type: "string" as const, value: "x".repeat(2048) },
    }));
    value.reproduction.binding.cases = Array.from({ length: 32 }, (_, index) => ({
      ...original,
      id: `case-${index}`,
      presentWhen: { allOf: predicates },
      absentWhen: { allOf: predicates },
      preconditions: predicates.map((predicate) => ({
        kind: "observation_equals" as const,
        predicate,
      })),
    }));
    value.selectedCaseIds = value.reproduction.binding.cases.map((entry) => entry.id);
    expect(Value.Check(EvaluationReproductionCellRecordV1Schema, value)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(
      maximumEvaluationReproductionDocumentUtf8Bytes,
    );
    expect(getEvaluationReproductionCellRecordIssues(value)).toContain(
      "Evaluation reproduction exceeds its aggregate UTF-8 byte limit.",
    );
  });
});

describe("versioned evaluation cell manifests", () => {
  it("preserves V1 bytes and uses a separate V2 container for reproduction references", () => {
    const legacy = {
      schemaVersion: "EvaluationCellManifestV1",
      evaluationId: "evaluation",
      repositoryId: "repo",
      cells: [entry, { ...entry, cellId: "candidate", arm: "candidate" }],
    };
    const original = JSON.stringify(legacy);
    expect(Value.Check(EvaluationCellManifestV1Schema, legacy)).toBe(true);
    expect(Value.Check(EvaluationCellManifestSchema, legacy)).toBe(true);
    expect(getEvaluationCellManifestIssues(legacy)).toEqual([]);
    expect(JSON.stringify(legacy)).toBe(original);
    const current = {
      ...legacy,
      schemaVersion: "EvaluationCellManifestV2",
      reproductionManifestSha256: sha,
      cells: legacy.cells.map((cell) => ({
        ...cell,
        reproduction: { state: "not_applicable", bindingDigest: null, cellRecordSha256: sha },
      })),
    };
    expect(Value.Check(EvaluationCellManifestV2Schema, current)).toBe(true);
    expect(getEvaluationCellManifestIssues(current)).toEqual([]);
    expect(Value.Check(EvaluationCellManifestV1Schema, current)).toBe(false);
    expect(Value.Check(EvaluationCellManifestV2Schema, legacy)).toBe(false);
  });
  it("adds optional mapping selections without changing an ordinary batch request", () => {
    const request = {
      changeId: "change",
      suiteId: "suite",
      suiteVersionId: "version",
      baseline: { profileVersionId: "profile", promptVersionId: "prompt" },
      candidate: { profileVersionId: "profile", promptVersionId: "prompt" },
      mode: "profile_only",
      checkMappings: [],
    };
    expect(getEvaluationBatchCreateRequestIssues(request)).toEqual([]);
    expect(
      getEvaluationBatchCreateRequestIssues({ ...request, reproductionMappings: [selection()] }),
    ).toEqual([]);
    expect(
      getEvaluationBatchCreateRequestIssues({
        ...request,
        reproductionMappings: [selection(), selection()],
      }),
    ).not.toEqual([]);
  });
});
