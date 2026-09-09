import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertEvaluationBatchCreateRequest,
  type EvaluationBatchCreateRequest,
  EvaluationBatchCreateRequestSchema,
  EvaluationBatchModeSchema,
  type EvaluationCellManifestEntryV1,
  EvaluationCellManifestEntryV1Schema,
  type EvaluationCellManifestV1,
  EvaluationCellManifestV1Schema,
  type EvaluationConfigurationManifestV1,
  EvaluationConfigurationManifestV1Schema,
  EvaluationConfigurationSelectionSchema,
  EvaluationCriterionMappingSchema,
  type EvaluationExecutionManifestV1,
  EvaluationExecutionManifestV1Schema,
  type EvaluationFrozenConfiguration,
  EvaluationFrozenConfigurationSchema,
  getEvaluationBatchCreateRequestIssues,
  getEvaluationFrozenConfigurationIssues,
  maximumEvaluationBatchPlanUtf8Bytes,
  maximumEvaluationBatchRequestUtf8Bytes,
} from "./evaluation-batches.js";
import {
  maximumEvaluationCaseCount,
  maximumEvaluationCriterionCount,
} from "./evaluation-scoring.js";

const now = "2026-09-08T01:00:00.000Z";
const digest = "a".repeat(64);
const originalDateTime = FormatRegistry.Get("date-time");
beforeAll(() => FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value))));
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function request(): EvaluationBatchCreateRequest {
  return {
    changeId: "create-evaluation-1",
    suiteId: "suite-1",
    suiteVersionId: "suite-version-1",
    baseline: { profileVersionId: "profile:baseline:v1", promptVersionId: "prompt:baseline:v1" },
    candidate: { profileVersionId: "profile:candidate:v2", promptVersionId: "prompt:candidate:v2" },
    mode: "prompt_and_profile",
    checkMappings: [
      {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: "profile:baseline:v1:build:compile",
        candidateCheckId: "profile:candidate:v2:test:compile",
      },
    ],
  };
}

function configuration(arm: "baseline" | "candidate"): EvaluationFrozenConfiguration {
  return {
    profileVersion: {
      id: `profile:${arm}:v1`,
      profileId: `profile:${arm}`,
      repositoryId: "repository-1",
      version: 1,
      name: "Frozen profile",
      required: true,
      workflowKind: "pr_static_build",
      target: "headless",
      outputSchemaVersion: "PrReviewPlanV2",
      config: {
        schemaVersion: "ValidationProfileV1",
        setup: [],
        build: [],
        test: [],
        launch: [],
        cleanup: [],
        requiredCapabilities: [],
        hardTimeoutMs: 120_000,
        noProgressTimeoutMs: 60_000,
      },
      configSha256: digest,
      createdAt: now,
      publishedAt: now,
      createdBy: "operator-1",
    },
    prompt: {
      workflowKind: "pr_static_build",
      version: {
        id: `prompt:${arm}:v1`,
        templateId: `template:${arm}`,
        version: 1,
        content: "Review the exact frozen source.",
        contentSha256: digest,
        outputSchemaVersion: "PrReviewPlanV2",
        createdAt: now,
        publishedAt: now,
        createdBy: "operator-1",
      },
    },
    modelRequirements: { required: true, expectedModelIdentityDigest: null },
  };
}

function configurationManifest(): EvaluationConfigurationManifestV1 {
  return {
    schemaVersion: "EvaluationConfigurationManifestV1",
    repositoryId: "repository-1",
    mode: "prompt_and_profile",
    baseline: configuration("baseline"),
    candidate: configuration("candidate"),
  };
}

function cell(caseIndex: number, arm: "baseline" | "candidate"): EvaluationCellManifestEntryV1 {
  return {
    cellId: `cell-${caseIndex}-${arm}`,
    caseId: `case-${caseIndex}`,
    arm,
    trial: 1,
    sourceId: `source-${caseIndex}`,
    sourceDigest: digest,
    runId: `run-${caseIndex}-${arm}`,
    requestId: `request-${caseIndex}-${arm}`,
    activationId: `activation-${caseIndex}-${arm}`,
    profileVersionId: `profile:${arm}:v1`,
    promptVersionId: `prompt:${arm}:v1`,
    renderedPromptDigest: digest,
    outputSchemaDigest: "b".repeat(64),
    modelRequirements: { required: true, expectedModelIdentityDigest: null },
  };
}

function cellManifest(count = 1): EvaluationCellManifestV1 {
  return {
    schemaVersion: "EvaluationCellManifestV1",
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    cells: Array.from({ length: count }, (_, index) => [
      cell(index, "baseline"),
      cell(index, "candidate"),
    ]).flat(),
  };
}

function executionManifest(): EvaluationExecutionManifestV1 {
  return {
    schemaVersion: "EvaluationExecutionManifestV1",
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    sampleSetVersionId: "suite-version-1",
    workflowKind: "pr_static_build",
    target: "headless",
    sourceManifestSha256: digest,
    configurationManifestSha256: "b".repeat(64),
    cellManifestSha256: "c".repeat(64),
    trial: 1,
    upstreamMutationPolicy: "forbidden",
  };
}

function requestAtByteLimit(): EvaluationBatchCreateRequest {
  const value = request();
  value.baseline.profileVersionId = "a".repeat(128);
  value.candidate.profileVersionId = "b".repeat(128);
  value.checkMappings = Array.from({ length: maximumEvaluationCaseCount }, (_, caseIndex) =>
    Array.from({ length: maximumEvaluationCriterionCount }, (_, criterionIndex) => ({
      caseId: `case-${caseIndex}`,
      criterionId: `criterion-${criterionIndex}`,
      baselineCheckId: `${value.baseline.profileVersionId}:${"x".repeat(128)}`,
      candidateCheckId: `${value.candidate.profileVersionId}:${"y".repeat(128)}`,
    })),
  ).flat();
  let remaining = maximumEvaluationBatchRequestUtf8Bytes - bytes(value);
  if (remaining < 0) throw new Error("The minimum fixture exceeds the request budget.");
  for (const mapping of value.checkMappings) {
    const added = Math.min(128 - mapping.criterionId.length, remaining);
    mapping.criterionId += "z".repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error("The fixture could not fill the request byte budget.");
  return value;
}

describe("evaluation batch creation contracts", () => {
  it("selects only an exact model registration ID while preserving legacy request bytes", () => {
    const legacy = request();
    const before = JSON.stringify(legacy);
    expect(getEvaluationBatchCreateRequestIssues(legacy)).toEqual([]);
    expect(JSON.stringify(legacy)).toBe(before);
    const value = request();
    value.baseline.modelRuntimeRegistrationId = "registration-baseline";
    value.candidate.modelRuntimeRegistrationId = "registration-candidate";
    expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
    for (const invalid of ["", "registration\n", " registration", null, "x".repeat(129)])
      expect(
        getEvaluationBatchCreateRequestIssues({
          ...value,
          baseline: { ...value.baseline, modelRuntimeRegistrationId: invalid },
        }).length,
      ).toBeGreaterThan(0);
    for (const extra of [
      { modelRuntimeRegistration: {} },
      { identitySha256: digest },
      { registrationSha256: digest },
      { modelRequirements: {} },
    ])
      expect(
        getEvaluationBatchCreateRequestIssues({
          ...value,
          baseline: { ...value.baseline, ...extra },
        }).length,
      ).toBeGreaterThan(0);
  });
  it("preserves explicit identities and mappings for both supported modes", () => {
    for (const mode of ["prompt_and_profile", "profile_only"] as const) {
      const value = { ...request(), mode };
      const original = structuredClone(value);
      expect(Value.Check(EvaluationBatchModeSchema, mode)).toBe(true);
      expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(true);
      expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
      assertEvaluationBatchCreateRequest(value);
      expect(value).toEqual(original);
    }
    expect(Value.Check(EvaluationBatchModeSchema, "recorded_results")).toBe(false);
    expect(Value.Check(EvaluationBatchModeSchema, "prompt_only")).toBe(false);
  });

  it("retains empty and null mappings as coverage omissions", () => {
    expect(getEvaluationBatchCreateRequestIssues({ ...request(), checkMappings: [] })).toEqual([]);
    for (const fields of [
      { baselineCheckId: null },
      { candidateCheckId: null },
      { baselineCheckId: null, candidateCheckId: null },
    ]) {
      const value = request();
      value.checkMappings = [
        {
          ...value.checkMappings[0],
          caseId: "case-1",
          criterionId: "criterion-1",
          baselineCheckId: "profile:baseline:v1:build",
          candidateCheckId: "profile:candidate:v2:test",
          ...fields,
        },
      ];
      const original = structuredClone(value);
      expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
      expect(value).toEqual(original);
    }
  });

  it("allows the same published configuration in both arms without substituting old results", () => {
    const value = request();
    value.candidate = { ...value.baseline };
    value.checkMappings = [
      {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: "profile:baseline:v1:build",
        candidateCheckId: "profile:baseline:v1:build",
      },
    ];
    expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
  });

  it("rejects repeated case/criterion tuples even when their mapped check differs", () => {
    const value = request();
    const mapping = value.checkMappings[0];
    if (!mapping) throw new Error("The request fixture is missing its mapping.");
    value.checkMappings.push({ ...mapping, candidateCheckId: null });
    expect(getEvaluationBatchCreateRequestIssues(value).join(" ")).toMatch(
      /exactly one explicit mapping/u,
    );
    expect(() => assertEvaluationBatchCreateRequest(value)).toThrow(TypeError);
  });

  it("keeps colon-bearing case and criterion identities distinct without tuple collisions", () => {
    const value = request();
    value.checkMappings = [
      {
        caseId: "case:part",
        criterionId: "criterion",
        baselineCheckId: null,
        candidateCheckId: null,
      },
      {
        caseId: "case",
        criterionId: "part:criterion",
        baselineCheckId: null,
        candidateCheckId: null,
      },
    ];
    expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
  });

  it("qualifies mapped checks against each complete selected profile identity", () => {
    expect(getEvaluationBatchCreateRequestIssues(request())).toEqual([]);
    for (const patch of [
      { baselineCheckId: "other-profile:build" },
      { candidateCheckId: "profile:baseline:v1:test" },
      { baselineCheckId: "profile:baseline:v10:build" },
      { baselineCheckId: "PROFILE:baseline:v1:build" },
      { baselineCheckId: "profile:baseline:v1:" },
      { candidateCheckId: "profile:candidate:v2::test" },
      { baselineCheckId: `profile:baseline:v1:${"x".repeat(129)}` },
    ]) {
      const value = request();
      value.checkMappings = [
        {
          caseId: "case-1",
          criterionId: "criterion-1",
          baselineCheckId: "profile:baseline:v1:build",
          candidateCheckId: "profile:candidate:v2:test",
          ...patch,
        },
      ];
      expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(true);
      expect(getEvaluationBatchCreateRequestIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("bounds mapped case scope and per-case criterion scope independently of the total", () => {
    const value = request();
    value.checkMappings = Array.from({ length: maximumEvaluationCaseCount + 1 }, (_, index) => ({
      caseId: `case-${index}`,
      criterionId: "criterion-1",
      baselineCheckId: null,
      candidateCheckId: null,
    }));
    expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(true);
    expect(getEvaluationBatchCreateRequestIssues(value).length).toBeGreaterThan(0);
    value.checkMappings = Array.from(
      { length: maximumEvaluationCriterionCount + 1 },
      (_, index) => ({
        caseId: "case-1",
        criterionId: `criterion-${index}`,
        baselineCheckId: null,
        candidateCheckId: null,
      }),
    );
    expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(true);
    expect(getEvaluationBatchCreateRequestIssues(value).length).toBeGreaterThan(0);
  });

  it("admits every mapping in a 32-case, 96-criterion scope and rejects excess entries", () => {
    const value = request();
    value.checkMappings = Array.from({ length: maximumEvaluationCaseCount }, (_, caseIndex) =>
      Array.from({ length: maximumEvaluationCriterionCount }, (_, criterionIndex) => ({
        caseId: `case-${caseIndex}`,
        criterionId: `criterion-${criterionIndex}`,
        baselineCheckId: null,
        candidateCheckId: null,
      })),
    ).flat();
    expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
    value.checkMappings.push({
      caseId: "overflow",
      criterionId: "overflow",
      baselineCheckId: null,
      candidateCheckId: null,
    });
    expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(false);
    expect(getEvaluationBatchCreateRequestIssues(value).length).toBeGreaterThan(0);
  });

  it("enforces the complete serialized request budget at the exact byte boundary", () => {
    const value = requestAtByteLimit();
    expect(bytes(value)).toBe(maximumEvaluationBatchRequestUtf8Bytes);
    expect(getEvaluationBatchCreateRequestIssues(value)).toEqual([]);
    value.changeId += "x";
    expect(Value.Check(EvaluationBatchCreateRequestSchema, value)).toBe(true);
    expect(bytes(value)).toBe(maximumEvaluationBatchRequestUtf8Bytes + 1);
    expect(getEvaluationBatchCreateRequestIssues(value).join(" ")).toMatch(
      /aggregate UTF-8 byte limit/u,
    );
    expect(() => assertEvaluationBatchCreateRequest(value)).toThrow(TypeError);
  });

  it.each([
    { actor: { issuer: "issuer", subject: "operator" } },
    { replayOnly: true },
    { repositoryId: "other" },
    { source: { body: "claimed source" } },
    { authorization: {} },
    { cellId: "client-cell" },
    { resultId: "old-success" },
    { modelRequirements: { required: true, expectedModelIdentityDigest: digest } },
    { executionManifestSha256: digest },
    { requestEpochId: "invented-epoch" },
  ])("rejects client-owned execution facts in the request: %j", (extra) => {
    expect(
      getEvaluationBatchCreateRequestIssues({ ...request(), ...extra }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects malformed nested configuration selections and mapping labels", () => {
    expect(Value.Check(EvaluationConfigurationSelectionSchema, request().baseline)).toBe(true);
    expect(
      Value.Check(EvaluationConfigurationSelectionSchema, {
        ...request().baseline,
        content: "fake published content",
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationConfigurationSelectionSchema, { profileVersionId: "profile-1" }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationCriterionMappingSchema, {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: "unqualified",
        candidateCheckId: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationCriterionMappingSchema, {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: null,
        candidateCheckId: null,
        expectedOutcome: "passed",
      }),
    ).toBe(false);
  });

  it("rejects malformed, circular and non-JSON values without throwing during validation", () => {
    const circular: Record<string, unknown> = request();
    circular.self = circular;
    const withSymbol = { ...request(), [Symbol("hidden")]: "not JSON" };
    for (const value of [
      null,
      undefined,
      [],
      { ...request(), changeId: "bad\ud800" },
      { ...request(), extra: 1n },
      { ...request(), extra: new Date(now) },
      { ...request(), extra: Number.NaN },
      { ...request(), checkMappings: [undefined] },
      circular,
      withSymbol,
    ]) {
      expect(() => getEvaluationBatchCreateRequestIssues(value)).not.toThrow();
      expect(getEvaluationBatchCreateRequestIssues(value).length).toBeGreaterThan(0);
      expect(() => assertEvaluationBatchCreateRequest(value)).toThrow(TypeError);
    }
  });
});

describe("frozen evaluation manifest shapes and digest dependencies", () => {
  it("pairs the complete frozen registration with a thin cell reference and preserves unknown history", () => {
    const value = configuration("baseline");
    const before = JSON.stringify(value);
    expect(getEvaluationFrozenConfigurationIssues(value)).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
    value.modelRequirements.expectedModelIdentityDigest = digest;
    value.modelRequirements.runtimeRegistration = {
      registrationId: "registration-1",
      registrationSha256: "b".repeat(64),
    };
    expect(getEvaluationFrozenConfigurationIssues(value).length).toBeGreaterThan(0);
    value.modelRuntimeRegistration = {
      schemaVersion: "ModelRuntimeRegistrationV1",
      id: "registration-1",
      name: "Expected runtime",
      requestedModel: "requested",
      identitySha256: digest,
      createdAt: now,
      createdBy: { issuer: "fixture", subject: "operator" },
      identity: {
        schemaVersion: "ModelRuntimeIdentityV1",
        providerId: "provider",
        modelId: "observed",
        endpointSha256: digest,
        client: {
          kind: "codex_cli",
          version: "fixture",
          executableSha256: digest,
          launchPolicySha256: digest,
        },
        relay: { implementationSha256: digest, policySha256: digest },
      },
    };
    expect(getEvaluationFrozenConfigurationIssues(value)).toEqual([]);
    const entry = cell(0, "baseline");
    entry.modelRequirements = structuredClone(value.modelRequirements);
    expect(Value.Check(EvaluationCellManifestEntryV1Schema, entry)).toBe(true);
    expect(
      Value.Check(EvaluationCellManifestEntryV1Schema, {
        ...entry,
        modelRuntimeRegistration: value.modelRuntimeRegistration,
      }),
    ).toBe(false);
    expect(Object.keys(entry.modelRequirements.runtimeRegistration ?? {}).sort()).toEqual([
      "registrationId",
      "registrationSha256",
    ]);
    value.modelRuntimeRegistration.id = "another-registration";
    expect(getEvaluationFrozenConfigurationIssues(value).length).toBeGreaterThan(0);
    delete value.modelRequirements.runtimeRegistration;
    expect(getEvaluationFrozenConfigurationIssues(value).length).toBeGreaterThan(0);
  });
  it("retains complete published configuration content and explicit model requirements", () => {
    expect(Value.Check(EvaluationFrozenConfigurationSchema, configuration("baseline"))).toBe(true);
    expect(Value.Check(EvaluationConfigurationManifestV1Schema, configurationManifest())).toBe(
      true,
    );
    const value = configuration("baseline");
    value.modelRequirements = { required: false, expectedModelIdentityDigest: null };
    expect(Value.Check(EvaluationFrozenConfigurationSchema, value)).toBe(true);
    expect(
      Value.Check(EvaluationFrozenConfigurationSchema, {
        ...value,
        modelRequirements: { required: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationFrozenConfigurationSchema, {
        ...value,
        profileVersion: { id: "claimed-version" },
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationFrozenConfigurationSchema, {
        ...value,
        prompt: {
          ...value.prompt,
          version: { ...value.prompt.version, contentSha256: "not-a-digest" },
        },
      }),
    ).toBe(false);
  });

  it("bounds the complete two-arm matrix to 64 cells with one declared trial", () => {
    expect(Value.Check(EvaluationCellManifestEntryV1Schema, cell(0, "baseline"))).toBe(true);
    expect(Value.Check(EvaluationCellManifestV1Schema, cellManifest(1))).toBe(true);
    expect(
      Value.Check(EvaluationCellManifestV1Schema, cellManifest(maximumEvaluationCaseCount)),
    ).toBe(true);
    expect(Value.Check(EvaluationCellManifestV1Schema, cellManifest(0))).toBe(false);
    expect(
      Value.Check(EvaluationCellManifestV1Schema, {
        ...cellManifest(),
        cells: [cell(0, "baseline")],
      }),
    ).toBe(false);
    expect(
      Value.Check(EvaluationCellManifestV1Schema, cellManifest(maximumEvaluationCaseCount + 1)),
    ).toBe(false);
    for (const extra of [
      { trial: 2 },
      { arm: "best_attempt" },
      { renderedPromptDigest: null },
      { runId: null },
    ]) {
      expect(
        Value.Check(EvaluationCellManifestEntryV1Schema, { ...cell(0, "baseline"), ...extra }),
      ).toBe(false);
    }
  });

  it.each([
    "planDigest",
    "executionDigest",
    "executionManifestSha256",
    "authorization",
    "result",
    "expectedOutcome",
    "expectedFindings",
  ])(
    "excludes %s from cell manifests to preserve withheld labels and an acyclic digest graph",
    (field) => {
      expect(
        Value.Check(EvaluationCellManifestEntryV1Schema, {
          ...cell(0, "baseline"),
          [field]: digest,
        }),
      ).toBe(false);
      expect(
        Value.Check(EvaluationCellManifestV1Schema, { ...cellManifest(), [field]: digest }),
      ).toBe(false);
    },
  );

  it("binds execution to source, configuration and cell digests with forbidden upstream writes", () => {
    expect(Value.Check(EvaluationExecutionManifestV1Schema, executionManifest())).toBe(true);
    for (const target of ["windows_desktop", "web"] as const) {
      expect(
        Value.Check(EvaluationExecutionManifestV1Schema, {
          ...executionManifest(),
          workflowKind: "pr_ui",
          target,
        }),
      ).toBe(true);
    }
    for (const patch of [
      { trial: 2 },
      { upstreamMutationPolicy: "allowed" },
      { requestEpochId: "invented-epoch" },
      { authorization: {} },
      { expectationManifestSha256: digest },
      { planDigest: digest },
      { sourceManifestSha256: "A".repeat(64) },
      { configurationManifestSha256: null },
      { cellManifestSha256: "short" },
      { schemaVersion: "EvaluationExecutionManifestV2" },
    ])
      expect(
        Value.Check(EvaluationExecutionManifestV1Schema, { ...executionManifest(), ...patch }),
      ).toBe(false);
    expect(maximumEvaluationBatchRequestUtf8Bytes).toBe(2 * 1024 * 1024);
    expect(maximumEvaluationBatchPlanUtf8Bytes).toBe(64 * 1024 * 1024);
  });

  it("rejects unknown manifest fields without embedding scoring or execution authority", () => {
    for (const extra of [
      { expectation: {} },
      { checkMappings: [] },
      { authorization: {} },
      { bindings: {} },
    ]) {
      expect(
        Value.Check(EvaluationConfigurationManifestV1Schema, {
          ...configurationManifest(),
          ...extra,
        }),
      ).toBe(false);
      expect(
        Value.Check(EvaluationFrozenConfigurationSchema, {
          ...configuration("baseline"),
          ...extra,
        }),
      ).toBe(false);
    }
  });
});
