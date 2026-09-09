import { createHash } from "node:crypto";
import type { ReproductionObservationFact } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  type AssetVerificationSnapshot,
  AssetVerificationSnapshotSchema,
  checkAssetSnapshot,
  checkScenarioObservationAttestation,
  checkScenarioObservationSelection,
  checkVerificationSchema,
  evidenceSnapshotDigest,
  reusableEvidenceVerification,
  type ScenarioAttestation,
  ScenarioAttestationSchema,
  type ScenarioVerificationSnapshot,
  ScenarioVerificationSnapshotSchema,
  UiObservationSelectionV1Schema,
} from "./evidence-verification-protocol.js";

function snapshot(): AssetVerificationSnapshot {
  const sha256 = createHash("sha256").update("evidence").digest("hex");
  const asset: AssetVerificationSnapshot["asset"] = {
    id: "11111111-1111-1111-1111-111111111111",
    state: "finalized",
    scope: {
      repositoryId: "repo",
      runId: "run",
      requestId: "request",
      jobId: "job",
      runAttemptId: "attempt",
      profileVersionId: "profile",
      revisionKey: "a".repeat(64),
      planDigest: "b".repeat(64),
      checkId: "profile:check",
    },
    metadata: {
      kind: "log",
      mediaType: "text/plain",
      capturedAt: "2026-09-07T00:00:00.000Z",
      sizeBytes: 8,
      sha256,
      checkId: "profile:check",
    },
  };
  return {
    storage: { storageKey: "c".repeat(32), device: "1", inode: "2" },
    asset,
    manifestDigest: evidenceSnapshotDigest(asset),
    expectedFile: {
      device: "1",
      inode: "3",
      sizeBytes: 8,
      ctimeNs: "123",
      mtimeNs: "123",
      mode: 0o600,
      uid: 0,
      nlink: 1,
    },
    chunks: [{ offset: 0, sizeBytes: 8, sha256 }],
  };
}
describe("evidence verification snapshots", () => {
  it.each([0x01021994, 0xef53, 0x58465342, 0x9123683e])(
    "permits aged stable metadata only on known local filesystem %i",
    (filesystemType) => {
      const timing = {
        filesystemType,
        startedAtUnixMs: 100000,
        finishedAtUnixMs: 100010,
        elapsedMonotonicMs: 10,
        clockStable: true,
      };
      const identity = {
        ...snapshot().expectedFile,
        ctimeNs: "97000000000",
        mtimeNs: "97000000000",
      };
      expect(reusableEvidenceVerification(timing, [identity])).toBe(true);
      expect(reusableEvidenceVerification({ ...timing, filesystemType: 0x6969 }, [identity])).toBe(
        false,
      );
      expect(reusableEvidenceVerification({ ...timing, clockStable: false }, [identity])).toBe(
        false,
      );
      expect(
        reusableEvidenceVerification({ ...timing, finishedAtUnixMs: 102000 }, [identity]),
      ).toBe(false);
      expect(reusableEvidenceVerification(timing, [{ ...identity, ctimeNs: "100000000000" }])).toBe(
        false,
      );
      expect(reusableEvidenceVerification(timing, [{ ...identity, mtimeNs: "101000000000" }])).toBe(
        false,
      );
    },
  );
  it("accepts exact bounded snapshots and canonicalizes object key order", () => {
    expect(() => checkAssetSnapshot(snapshot())).not.toThrow();
    expect(evidenceSnapshotDigest({ a: 1, b: 2 })).toBe(evidenceSnapshotDigest({ b: 2, a: 1 }));
  });
  it.each(["directory", "leaseToken", "workerToken", "path"])(
    "rejects extra authority field %s",
    (field) => {
      expect(() =>
        checkVerificationSchema(AssetVerificationSnapshotSchema, {
          ...snapshot(),
          [field]: "private",
        }),
      ).toThrow(/INVALID_SNAPSHOT/u);
    },
  );
  it.each([
    (value: AssetVerificationSnapshot) => {
      required(value.chunks[0]).offset = 1;
    },
    (value: AssetVerificationSnapshot) => {
      required(value.chunks[0]).sizeBytes = 524289;
    },
    (value: AssetVerificationSnapshot) => {
      value.chunks = Array.from({ length: 4097 }, () => required(value.chunks[0]));
    },
    (value: AssetVerificationSnapshot) => {
      value.asset.scope.repositoryId = "different-repo";
    },
    (value: AssetVerificationSnapshot) => {
      value.asset.metadata.checkId = "another:check";
      value.manifestDigest = evidenceSnapshotDigest(value.asset);
    },
    (value: AssetVerificationSnapshot) => {
      value.expectedFile.sizeBytes = 9;
    },
    (value: AssetVerificationSnapshot) => {
      value.asset.id = "../outside";
    },
  ])("rejects contradictory or unbounded snapshot data", (change) => {
    const value = snapshot();
    change(value);
    expect(() => checkAssetSnapshot(value)).toThrow(/INVALID_SNAPSHOT/u);
  });
});

function scenarioSnapshot(stepIds = ["status"]): ScenarioVerificationSnapshot {
  const steps = snapshot();
  steps.asset.metadata = {
    ...steps.asset.metadata,
    kind: "steps",
    mediaType: "application/json",
  };
  steps.manifestDigest = evidenceSnapshotDigest(steps.asset);
  const dependencies = stepIds.map((_, index) => {
    const screenshot = snapshot();
    screenshot.asset.id = `22222222-2222-2222-2222-${(index + 2).toString(16).padStart(12, "0")}`;
    screenshot.asset.metadata = {
      ...screenshot.asset.metadata,
      kind: "screenshot",
      mediaType: "image/png",
    };
    screenshot.manifestDigest = evidenceSnapshotDigest(screenshot.asset);
    screenshot.expectedFile.inode = String(index + 4);
    return {
      asset: screenshot.asset,
      manifestDigest: screenshot.manifestDigest,
      expectedFile: screenshot.expectedFile,
    };
  });
  const common = { name: "Fixture operation", timeoutMs: 1000 };
  return {
    storage: steps.storage,
    resultDigest: "d".repeat(64),
    steps,
    checkOutcome: "passed",
    observationSelection: { schemaVersion: "UiObservationSelectionV1", stepIds },
    dependencies,
    target: "web",
    scenario: {
      id: "check",
      name: "Fixture scenario",
      required: true,
      timeoutMs: 10000,
      path: "/",
      steps: [
        { ...common, id: "open", action: "click", locator: { by: "testId", testId: "open" } },
        {
          ...common,
          id: "input",
          action: "fill",
          locator: { by: "testId", testId: "input" },
          value: "fixture",
        },
        {
          ...common,
          id: "visible",
          action: "assertVisible",
          locator: { by: "testId", testId: "visible" },
          expected: true,
        },
        {
          ...common,
          id: "status",
          action: "assertText",
          locator: { by: "testId", testId: "status" },
          expected: "Ready",
          match: "exact",
        },
        {
          ...common,
          id: "value",
          action: "assertValue",
          locator: { by: "testId", testId: "value" },
          expected: "ready",
        },
      ],
    },
    policy: {
      screenshots: "on_failure",
      screenshotScope: "viewport",
      trace: "off",
      required: true,
    },
  };
}

type ObservedFact = Extract<ReproductionObservationFact, { state: "observed" }>;

function scenarioAttestation(value: ScenarioVerificationSnapshot): ScenarioAttestation {
  return {
    kind: "scenario_verified",
    verification: {
      filesystemType: 0xef53,
      startedAtUnixMs: 100000,
      finishedAtUnixMs: 100010,
      elapsedMonotonicMs: 10,
      clockStable: true,
      reusable: true,
    },
    snapshotDigest: evidenceSnapshotDigest(value),
    storage: value.storage,
    resultDigest: value.resultDigest,
    scope: { ...value.steps.asset.scope },
    scenarioId: value.scenario.id,
    stepsManifestDigest: value.steps.manifestDigest,
    dependencyManifestDigests: value.dependencies.map((dependency) => dependency.manifestDigest),
    observed: [value.steps, ...value.dependencies].map((entry) => ({
      assetId: entry.asset.id,
      state: entry.asset.state,
      before: entry.expectedFile,
      after: entry.expectedFile,
    })),
    observations: required(value.observationSelection).stepIds.map(
      (stepId, index): ObservedFact => ({
        observation: { kind: "ui_assertion", scenarioId: value.scenario.id, stepId },
        checkId: "profile:check",
        state: "observed",
        value:
          stepId === "visible"
            ? { type: "boolean", value: true }
            : { type: "string", value: stepId === "status" ? "Ready" : "ready" },
        evidenceIds: [value.steps.asset.id, required(value.dependencies[index]).asset.id],
      }),
    ),
  };
}

function firstObservedFact(attestation: ScenarioAttestation): ObservedFact {
  const fact = required(required(attestation.observations)[0]);
  if (fact.state !== "observed") throw new Error("Missing observed fact fixture.");
  return fact;
}

describe("UI observation selections", () => {
  it("accepts only the selected frozen assertions without changing the snapshot", () => {
    const value = scenarioSnapshot(["visible", "status", "value"]);
    const before = JSON.stringify(value);
    expect(() => checkVerificationSchema(ScenarioVerificationSnapshotSchema, value)).not.toThrow();
    expect(() => checkScenarioObservationSelection(value)).not.toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("bounds the selection independently of the scenario payload", () => {
    const selection = {
      schemaVersion: "UiObservationSelectionV1",
      stepIds: Array.from({ length: 32 }, (_, index) => `assertion-${index}`),
    };
    expect(() => checkVerificationSchema(UiObservationSelectionV1Schema, selection)).not.toThrow();
    expect(() =>
      checkVerificationSchema(UiObservationSelectionV1Schema, {
        ...selection,
        stepIds: [...selection.stepIds, "assertion-32"],
      }),
    ).toThrow(/INVALID_SNAPSHOT/u);
  });

  it.each([
    { schemaVersion: "UiObservationSelectionV2", stepIds: ["status"] },
    { schemaVersion: "UiObservationSelectionV1", stepIds: [] },
    { schemaVersion: "UiObservationSelectionV1", stepIds: ["status", "status"] },
    { schemaVersion: "UiObservationSelectionV1", stepIds: ["../status"] },
    { schemaVersion: "UiObservationSelectionV1", stepIds: "status" },
    { schemaVersion: "UiObservationSelectionV1", stepIds: ["status"], facts: [] },
    { stepIds: ["status"] },
  ])("rejects malformed or self-authorizing selection %j", (selection) => {
    expect(() => checkVerificationSchema(UiObservationSelectionV1Schema, selection)).toThrow(
      /INVALID_SNAPSHOT/u,
    );
    expect(() =>
      checkVerificationSchema(ScenarioVerificationSnapshotSchema, {
        ...scenarioSnapshot(),
        observationSelection: selection,
      }),
    ).toThrow(/INVALID_SNAPSHOT/u);
  });

  it.each([["open"], ["input"], ["unknown"], ["status", "status"]])(
    "rejects non-assertion, missing, or repeated selected IDs %j",
    (...stepIds) => {
      expect(() => checkScenarioObservationSelection(scenarioSnapshot(stepIds))).toThrow(
        /INVALID_SNAPSHOT/u,
      );
    },
  );
});

describe("UI observation attestations", () => {
  it.each(["visible", "status", "value"])(
    "accepts a scoped typed fact for the selected %s assertion",
    (stepId) => {
      const value = scenarioSnapshot([stepId]);
      value.checkOutcome = "failed";
      const attestation = scenarioAttestation(value);
      firstObservedFact(attestation).value =
        stepId === "visible" ? { type: "boolean", value: false } : { type: "string", value: "" };
      const before = JSON.stringify(attestation);
      expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
      expect(() => checkScenarioObservationAttestation(value, attestation)).not.toThrow();
      expect(JSON.stringify(attestation)).toBe(before);
    },
  );

  it("keeps unavailable facts valueless and bound to the verified step document", () => {
    const value = scenarioSnapshot();
    value.checkOutcome = "blocked";
    const attestation = scenarioAttestation(value);
    const fact = firstObservedFact(attestation);
    attestation.observations = [
      {
        observation: fact.observation,
        checkId: fact.checkId,
        state: "unavailable",
        reason: "not_run",
        evidenceIds: [value.steps.asset.id],
      },
    ];
    expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
    expect(() => checkScenarioObservationAttestation(value, attestation)).not.toThrow();
    expect(() =>
      checkVerificationSchema(ScenarioAttestationSchema, {
        ...attestation,
        observations: [{ ...required(attestation.observations?.[0]), value: fact.value }],
      }),
    ).toThrow(/INVALID_SNAPSHOT/u);
  });

  it("leaves legacy attestations readable without supplying facts", () => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    delete attestation.observations;
    expect(() => checkScenarioObservationAttestation(value, attestation)).not.toThrow();
    delete value.observationSelection;
    expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
    expect(() => checkScenarioObservationAttestation(value, attestation)).not.toThrow();
    expect(attestation.observations).toBeUndefined();
  });

  it("rejects facts when no observation selection was requested", () => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    delete value.observationSelection;
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it.each([
    (fact: ObservedFact) => {
      fact.observation = { kind: "ui_assertion", scenarioId: "foreign", stepId: "status" };
    },
    (fact: ObservedFact) => {
      fact.observation = { kind: "ui_assertion", scenarioId: "check", stepId: "visible" };
    },
    (fact: ObservedFact) => {
      fact.observation = { kind: "probe_value", testStepId: "status", observationId: "value" };
    },
    (fact: ObservedFact) => {
      fact.checkId = "foreign:check";
    },
    (fact: ObservedFact) => {
      fact.evidenceIds = fact.evidenceIds.slice(1);
    },
    (fact: ObservedFact) => {
      fact.evidenceIds.reverse();
    },
    (fact: ObservedFact) => {
      fact.evidenceIds.push("33333333-3333-3333-3333-333333333333");
    },
  ])("rejects facts outside the selected assertion or verified evidence scope", (change) => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    change(firstObservedFact(attestation));
    expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it("rejects a non-screenshot dependency as observation evidence", () => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    const dependency = required(value.dependencies[0]);
    dependency.asset.metadata.kind = "log";
    dependency.asset.metadata.mediaType = "text/plain";
    dependency.manifestDigest = evidenceSnapshotDigest(dependency.asset);
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it("does not let a second fact borrow the first assertion's screenshot", () => {
    const value = scenarioSnapshot(["status", "value"]);
    const attestation = scenarioAttestation(value);
    expect(() => checkScenarioObservationAttestation(value, attestation)).not.toThrow();
    const facts = required(attestation.observations);
    required(facts[1]).evidenceIds = [...required(facts[0]).evidenceIds];
    expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it("rejects an unavailable fact with a reason outside the capture protocol", () => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    const fact = firstObservedFact(attestation);
    attestation.observations = [
      {
        observation: fact.observation,
        checkId: fact.checkId,
        state: "unavailable",
        reason: "arbitrary_reason",
        evidenceIds: [value.steps.asset.id],
      },
    ];
    expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it.each(["visible", "status", "value"])(
    "rejects the wrong observation value type for %s",
    (stepId) => {
      const value = scenarioSnapshot([stepId]);
      const attestation = scenarioAttestation(value);
      firstObservedFact(attestation).value =
        stepId === "visible"
          ? { type: "string", value: "false" }
          : { type: "boolean", value: false };
      expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
      expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
        /VERIFIER_PROTOCOL/u,
      );
    },
  );

  it.each([
    "Bearer opaque-session",
    "[REDACTED]",
    "bad\u001btext",
    "bad\ud800text",
    "x".repeat(2049),
  ])("rejects unsafe or incomplete original observation text %j", (text) => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    firstObservedFact(attestation).value = { type: "string", value: text };
    expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
      /VERIFIER_PROTOCOL/u,
    );
  });

  it.each(["missing", "extra", "duplicate", "reordered"])(
    "rejects %s facts instead of expanding or changing the selected observations",
    (change) => {
      const value = scenarioSnapshot(["status", "value"]);
      const attestation = scenarioAttestation(value);
      const facts = required(attestation.observations);
      if (change === "missing") facts.pop();
      if (change === "extra") facts.push({ ...required(facts[0]) });
      if (change === "duplicate") facts[1] = { ...required(facts[0]) };
      if (change === "reordered") facts.reverse();
      expect(() => checkVerificationSchema(ScenarioAttestationSchema, attestation)).not.toThrow();
      expect(() => checkScenarioObservationAttestation(value, attestation)).toThrow(
        /VERIFIER_PROTOCOL/u,
      );
    },
  );

  it("rejects malformed fact arrays and duplicate evidence references at the schema boundary", () => {
    const value = scenarioSnapshot();
    const attestation = scenarioAttestation(value);
    const fact = firstObservedFact(attestation);
    for (const observations of [
      [],
      Array.from({ length: 33 }, () => fact),
      [{ ...fact, evidenceIds: [value.steps.asset.id, value.steps.asset.id] }],
      [{ ...fact, conclusion: "confirmed" }],
    ]) {
      expect(() =>
        checkVerificationSchema(ScenarioAttestationSchema, { ...attestation, observations }),
      ).toThrow(/INVALID_SNAPSHOT/u);
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture.");
  return value;
}
