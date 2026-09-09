import { describe, expect, it } from "vitest";
import {
  createEvaluationReproductionCellRecord,
  createEvaluationReproductionManifest,
  createEvaluationReproductionSourceDefinition,
  evaluationReproductionCellRecordDigest,
  evaluationReproductionManifestDigest,
  evaluationReproductionSourceDefinitionDigest,
  validateEvaluationIssueReproductionBinding,
} from "./evaluation-reproduction.js";
import {
  evaluationPlanFixture,
  fixtureCanonical,
  fixtureDigest,
  reproductionFixture,
} from "./evaluation-reproduction.testing.js";

describe("historical reproduction definitions", () => {
  it("retains the exact original binding independently of fresh evaluation authorization", () => {
    const f = reproductionFixture();
    expect(f.definition.binding).toEqual(f.sourceInput.plan.reproduction?.binding);
    expect(f.definition.bindingDigest).toBe(f.sourceInput.plan.reproduction?.bindingDigest);
    expect(f.definition.binding.authorizedBy.subject).toBe("old-operator");
    expect(evaluationReproductionSourceDefinitionDigest(f.definition)).toBe(
      fixtureDigest(f.definition),
    );
    expect(Object.isFrozen(f.definition.binding.cases)).toBe(true);
  });
  it("returns null only for a verified source plan without reproduction", () => {
    const f = reproductionFixture();
    delete f.sourceInput.plan.reproduction;
    f.sourceInput.expectedPlanDigest = fixtureDigest(f.sourceInput.plan);
    if (f.sourceInput.source.provenance.kind !== "review_run")
      throw new Error("Missing provenance.");
    f.sourceInput.source.provenance.planDigest = f.sourceInput.expectedPlanDigest;
    expect(createEvaluationReproductionSourceDefinition(f.sourceInput)).toBeNull();
  });
  it.each(["plan", "provenance", "source", "binding", "ordinary authorization"])(
    "rejects changed %s",
    (part) => {
      const f = reproductionFixture();
      if (part === "plan") f.sourceInput.expectedPlanDigest = "f".repeat(64);
      if (part === "provenance" && f.sourceInput.source.provenance.kind === "review_run")
        f.sourceInput.source.provenance.planDigest = "f".repeat(64);
      if (part === "source") f.sourceInput.source.sourceDigest = "f".repeat(64);
      if (part === "binding" && f.sourceInput.plan.reproduction)
        f.sourceInput.plan.reproduction.binding.claim = "Changed claim.";
      if (part === "ordinary authorization") f.sourceInput.plan.testedSourceAuthorization = null;
      if (part === "ordinary authorization" || part === "binding") {
        f.sourceInput.expectedPlanDigest = fixtureDigest(f.sourceInput.plan);
        if (f.sourceInput.source.provenance.kind === "review_run")
          f.sourceInput.source.provenance.planDigest = f.sourceInput.expectedPlanDigest;
      }
      expect(() => createEvaluationReproductionSourceDefinition(f.sourceInput)).toThrow();
    },
  );
  it("rejects a different historical plan with identical checkout facts", () => {
    const f = reproductionFixture();
    f.sourceInput.plan.activationId = "different-activation";
    expect(() => createEvaluationReproductionSourceDefinition(f.sourceInput)).toThrow();
  });
});

describe("explicit evaluation reproduction arm mappings", () => {
  it("maps identities and references while preserving original interpretation and values", () => {
    const f = reproductionFixture();
    const before = fixtureCanonical(f);
    const record = createEvaluationReproductionCellRecord(f.input);
    expect(record.state).toBe("ready");
    expect(record.blockers).toEqual([]);
    const binding = record.reproduction?.binding;
    expect(binding?.claim).toBe(f.definition.binding.claim);
    expect(binding?.authorizedBy).toEqual({
      ...f.input.bindingContext.actor,
      authorizedAt: f.input.bindingContext.authorizedAt,
    });
    expect(binding?.activationId).toBe("new-activation");
    expect(binding?.cases[0]).toMatchObject({
      id: "repro-case",
      context: "Retain this exact context.",
      requestId: "new-request",
      profileVersionId: "target-profile",
      preconditions: [{ kind: "check_passed", checkId: "target-profile:setup" }],
      presentWhen: {
        allOf: [
          {
            observation: {
              kind: "probe_value",
              testStepId: "target-probe",
              observationId: "observed",
            },
            equals: { type: "boolean", value: true },
          },
        ],
      },
      absentWhen: { allOf: [{ equals: { type: "boolean", value: false } }] },
    });
    expect(record.reproduction?.bindingDigest).toBe(fixtureDigest(binding));
    expect(fixtureCanonical(f)).toBe(before);
    expect(fixtureCanonical(record)).not.toContain("expectedOutcome");
    expect(fixtureCanonical(record)).not.toContain("testedSourceAuthorization");
    expect(evaluationReproductionCellRecordDigest(record)).toBe(fixtureDigest(record));
  });
  it("never borrows a baseline mapping for the candidate arm", () => {
    const f = reproductionFixture();
    f.selection.candidate.observationMappings = [];
    expect(createEvaluationReproductionCellRecord(f.input).state).toBe("ready");
    const candidate = createEvaluationReproductionCellRecord({
      ...f.input,
      arm: "candidate",
      cellId: "candidate-cell",
    });
    expect(candidate).toMatchObject({
      state: "blocked",
      reproduction: null,
      blockers: [{ code: "mapping_missing" }],
    });
  });
  it("retains a missing selection as blocked rather than discarding the source requirement", () => {
    const f = reproductionFixture();
    const { selection: _selection, ...input } = f.input;
    expect(createEvaluationReproductionCellRecord(input)).toMatchObject({
      state: "blocked",
      selectedCaseIds: [],
      mappings: null,
      reproduction: null,
      sourceDefinitionSha256: evaluationReproductionSourceDefinitionDigest(f.definition),
      blockers: [{ code: "mapping_missing" }],
    });
  });
  it.each(["observation", "check"])("retains an explicitly unmapped %s as blocked", (part) => {
    const f = reproductionFixture();
    if (part === "observation") {
      const entry = f.selection.baseline.observationMappings[0];
      if (!entry) throw new Error();
      entry.to = null;
    } else {
      const entry = f.selection.baseline.checkMappings[0];
      if (!entry) throw new Error();
      entry.toCheckId = null;
    }
    const record = createEvaluationReproductionCellRecord(f.input);
    expect(record).toMatchObject({
      state: "blocked",
      reproduction: null,
      blockers: [{ code: "mapping_unmapped" }],
    });
    expect(record.selectedCaseIds).toEqual(["repro-case"]);
    expect(record.mappings).toEqual(f.selection.baseline);
  });
  it.each([
    "source identity",
    "source plan",
    "source binding",
    "case scope",
    "repository",
    "actor time",
  ])("rejects changed %s instead of constructing authority", (part) => {
    const f = reproductionFixture();
    if (part === "source identity") f.input = { ...f.input, sourceId: "different-source" };
    if (part === "source plan") f.selection.expectedSource.planDigest = "f".repeat(64);
    if (part === "source binding") f.selection.expectedSource.bindingDigest = "f".repeat(64);
    if (part === "case scope") f.selection.caseId = "different-case";
    if (part === "repository") f.input = { ...f.input, repositoryId: "different-repo" };
    if (part === "actor time")
      f.input = {
        ...f.input,
        bindingContext: { ...f.input.bindingContext, authorizedAt: "2020-01-01T00:00:00.000Z" },
      };
    expect(() => createEvaluationReproductionCellRecord(f.input)).toThrow();
  });
  it.each(["unknown source", "unknown target", "wrong target type", "wrong check"])(
    "blocks %s references",
    (part) => {
      const f = reproductionFixture();
      const observation = f.selection.baseline.observationMappings[0];
      if (!observation) throw new Error();
      if (part === "unknown source")
        observation.from = { kind: "probe_value", testStepId: "other", observationId: "unknown" };
      if (part === "unknown target")
        observation.to = { kind: "probe_value", testStepId: "missing", observationId: "unknown" };
      if (part === "wrong check") {
        const check = f.selection.baseline.checkMappings[0];
        if (!check) throw new Error();
        check.toCheckId = "another-profile:setup";
      }
      if (part === "wrong target type") {
        const profile = f.input.bindingContext.profileVersion;
        const field = profile.config.test[0]?.probeOutput?.fields[0];
        if (!field) throw new Error();
        field.type = "string";
        profile.configSha256 = fixtureDigest(profile.config);
      }
      expect(createEvaluationReproductionCellRecord(f.input)).toMatchObject({
        state: "blocked",
        reproduction: null,
      });
    },
  );
  it("rejects duplicate source references rather than choosing the last mapping", () => {
    const f = reproductionFixture();
    const entry = f.selection.baseline.observationMappings[0];
    if (!entry) throw new Error();
    f.selection.baseline.observationMappings.push(structuredClone(entry));
    expect(() => createEvaluationReproductionCellRecord(f.input)).toThrow();
  });
  it("records an inapplicable case with its source definition but without an execution binding", () => {
    const f = reproductionFixture();
    const { selection: _selection, ...input } = f.input;
    expect(createEvaluationReproductionCellRecord({ ...input, applicable: false })).toMatchObject({
      state: "not_applicable",
      sourceDefinitionSha256: evaluationReproductionSourceDefinitionDigest(f.definition),
      reproduction: null,
      blockers: [],
    });
  });
  it("records a verified source without reproduction as not applicable", () => {
    const f = reproductionFixture();
    const { selection: _selection, ...input } = f.input;
    expect(
      createEvaluationReproductionCellRecord({ ...input, sourceDefinition: null }),
    ).toMatchObject({
      state: "not_applicable",
      sourceDefinitionSha256: null,
      selectedCaseIds: [],
      mappings: null,
      reproduction: null,
      blockers: [],
    });
  });
});

describe("sealed mapped evaluation scope", () => {
  it("validates fresh evaluation authority without a fabricated ordinary source authorization", () => {
    const f = reproductionFixture();
    const reproduction = createEvaluationReproductionCellRecord(f.input).reproduction;
    if (!reproduction) throw new Error();
    const plan = evaluationPlanFixture(reproduction);
    expect(plan.testedSourceAuthorization).toBeNull();
    expect(() => validateEvaluationIssueReproductionBinding(plan)).not.toThrow();
    const changed = structuredClone(plan);
    changed.authorization.actor.subject = "another-operator";
    expect(() => validateEvaluationIssueReproductionBinding(changed)).toThrow();
  });
  it("supports a verified historical evaluation plan as a new source definition", () => {
    const f = reproductionFixture();
    const reproduction = createEvaluationReproductionCellRecord(f.input).reproduction;
    if (!reproduction) throw new Error();
    const plan = evaluationPlanFixture(reproduction);
    const source = structuredClone(plan.source);
    source.provenance = {
      kind: "review_run",
      reviewRunId: "previous-evaluation-run",
      planDigest: fixtureDigest(plan),
      requestEpochId: null,
      capturedAt: "2026-09-10T00:00:00.000Z",
    };
    expect(
      createEvaluationReproductionSourceDefinition({
        ...f.sourceInput,
        source,
        plan,
        expectedPlanDigest: fixtureDigest(plan),
      })?.binding,
    ).toEqual(reproduction.binding);
  });
  it("binds separately retained records in a small paired manifest", () => {
    const f = reproductionFixture();
    const baseline = createEvaluationReproductionCellRecord(f.input);
    const candidate = createEvaluationReproductionCellRecord({
      ...f.input,
      cellId: "candidate-cell",
      arm: "candidate",
    });
    const input = {
      evaluationId: "evaluation",
      repositoryId: "repo",
      sources: [{ caseId: "case", definition: f.definition }],
      cells: [candidate, baseline],
    };
    const manifest = createEvaluationReproductionManifest(input);
    expect(manifest.cells).toHaveLength(2);
    expect(manifest.cells[0]?.cellRecordSha256).toBe(
      evaluationReproductionCellRecordDigest(baseline),
    );
    expect(evaluationReproductionManifestDigest(manifest)).toBe(fixtureDigest(manifest));
    expect(fixtureCanonical(manifest)).not.toContain("claim");
    expect(
      createEvaluationReproductionManifest({ ...input, cells: [baseline, candidate] }),
    ).toEqual(manifest);
    expect(() =>
      createEvaluationReproductionManifest({ ...input, cells: [baseline, baseline] }),
    ).toThrow();
    expect(() => createEvaluationReproductionManifest({ ...input, sources: [] })).toThrow();
  });
});
