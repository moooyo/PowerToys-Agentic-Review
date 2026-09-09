import { createHash, randomUUID } from "node:crypto";
import type { UiScenarioExecutionEvidenceV1 } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as files from "./evidence-files.js";
import {
  type AssetVerificationSnapshot,
  type EvidenceVerificationRoot,
  evidenceSnapshotDigest,
  maximumVerificationStepsBytes,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";
import { verifyEvidenceScenario } from "./evidence-verification-worker.js";

afterEach(() => vi.restoreAllMocks());

function dependency({ asset, manifestDigest, expectedFile }: AssetVerificationSnapshot) {
  return { asset, manifestDigest, expectedFile };
}

function fixture(target: "web" | "windows_desktop" = "web") {
  const root: EvidenceVerificationRoot = {
    directory: "/private/evidence",
    storageKey: "c".repeat(32),
    device: "1",
    inode: "2",
  };
  const storage = { storageKey: root.storageKey, device: root.device, inode: root.inode };
  const scope = {
    repositoryId: "repo",
    runId: "run",
    requestId: "request",
    jobId: "job",
    runAttemptId: "attempt",
    profileVersionId: "profile",
    revisionKey: "a".repeat(64),
    planDigest: "b".repeat(64),
    checkId: "profile:settings",
  };
  const asset = (
    bytes: Buffer,
    kind: "steps" | "screenshot" | "trace",
  ): AssetVerificationSnapshot => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest: AssetVerificationSnapshot["asset"] = {
      id: randomUUID(),
      state: "finalized",
      scope,
      metadata: {
        ...(kind === "steps"
          ? { kind, mediaType: "application/json" as const }
          : kind === "screenshot"
            ? { kind, mediaType: "image/png" as const }
            : { kind, mediaType: "application/zip" as const }),
        capturedAt: "2026-09-07T00:00:00.000Z",
        sizeBytes: bytes.length,
        sha256,
        checkId: scope.checkId,
      },
    };
    return {
      storage,
      asset: manifest,
      manifestDigest: evidenceSnapshotDigest(manifest),
      expectedFile: {
        device: "1",
        inode: "3",
        sizeBytes: bytes.length,
        ctimeNs: "123",
        mtimeNs: "123",
        mode: 0o600,
        uid: 0,
        nlink: 1,
      },
      chunks: Array.from({ length: Math.ceil(bytes.length / 524288) }, (_, index) => {
        const offset = index * 524288;
        const chunk = bytes.subarray(offset, offset + 524288);
        return {
          offset,
          sizeBytes: chunk.length,
          sha256: createHash("sha256").update(chunk).digest("hex"),
        };
      }),
    };
  };
  const image = asset(Buffer.from("screenshot"), "screenshot");
  const execution: UiScenarioExecutionEvidenceV1 = {
    schemaVersion: "UiScenarioExecutionEvidenceV1",
    source: "ui_driver",
    scenarioId: "settings",
    target,
    steps: [
      {
        stepId: "visible",
        name: "Visible",
        action: "assertVisible",
        expected: true,
        actual: true,
        outcome: "passed",
        summary: "Private diagnostic canary.",
        evidenceIds: [image.asset.id],
        capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
      },
    ],
  };
  const planned = {
    id: "visible",
    name: "Visible",
    action: "assertVisible" as const,
    expected: true,
    timeoutMs: 100,
  };
  const common = {
    storage,
    resultDigest: "d".repeat(64),
    steps: asset(Buffer.from("placeholder"), "steps"),
    checkOutcome: "passed" as const,
    dependencies: [dependency(image)],
    observationSelection: {
      schemaVersion: "UiObservationSelectionV1" as const,
      stepIds: ["visible"],
    },
  };
  const scenario = { id: "settings", name: "Settings", required: true, timeoutMs: 1000 };
  const snapshot: ScenarioVerificationSnapshot =
    target === "web"
      ? {
          ...common,
          target,
          scenario: {
            ...scenario,
            path: "/",
            steps: [{ ...planned, locator: { by: "testId", testId: "settings" } }],
          },
          policy: {
            screenshots: "every_assertion",
            screenshotScope: "viewport",
            trace: "off",
            required: true,
          },
        }
      : {
          ...common,
          target,
          scenario: {
            ...scenario,
            steps: [{ ...planned, locator: { by: "automationId", automationId: "settings" } }],
          },
          policy: {
            screenshots: "every_assertion",
            screenshotScope: "owned_window",
            required: true,
          },
        };
  const timing = {
    filesystemType: 0,
    startedAtUnixMs: 100000,
    finishedAtUnixMs: 100001,
    elapsedMonotonicMs: 1,
    clockStable: true,
    reusable: false,
  };
  const run = async (bytes = Buffer.from(JSON.stringify(execution))) => {
    snapshot.steps = asset(bytes, "steps");
    vi.spyOn(files, "verifyEvidenceAsset").mockResolvedValue({
      bytes,
      attestation: {
        kind: "asset_verified",
        verification: timing,
        snapshotDigest: evidenceSnapshotDigest(snapshot.steps),
        manifestDigest: snapshot.steps.manifestDigest,
        assetId: snapshot.steps.asset.id,
        storage,
        sha256: snapshot.steps.asset.metadata.sha256,
        sizeBytes: bytes.length,
        before: snapshot.steps.expectedFile,
        after: snapshot.steps.expectedFile,
      },
    });
    vi.spyOn(files, "probeEvidenceIdentities").mockImplementation(async (_root, probe) => ({
      kind: "identities_probed",
      snapshotDigest: evidenceSnapshotDigest(probe),
      storage,
      matches: true,
      assets: probe.assets.map((item) => ({
        assetId: item.assetId,
        state: item.state,
        before: item.expectedFile,
        after: item.expectedFile,
      })),
    }));
    return verifyEvidenceScenario(root, snapshot, new AbortController().signal);
  };
  return { snapshot, execution, image, asset, run };
}

function assertion(f: ReturnType<typeof fixture>) {
  const step = f.execution.steps[0];
  if (step === undefined || step.action !== "assertVisible")
    throw new Error("Missing assertion fixture.");
  return step;
}

describe("bounded selected UI observation facts", () => {
  it.each(["web", "windows_desktop"] as const)(
    "returns only selected safe %s facts",
    async (target) => {
      const f = fixture(target);
      const proof = await f.run();
      expect(proof.observations).toEqual([
        {
          observation: { kind: "ui_assertion", scenarioId: "settings", stepId: "visible" },
          checkId: "profile:settings",
          evidenceIds: [f.snapshot.steps.asset.id, f.image.asset.id],
          state: "observed",
          value: { type: "boolean", value: true },
        },
      ]);
      expect(JSON.stringify(proof)).not.toContain("Private diagnostic canary");
      expect(proof.observed.map((item) => item.assetId)).toContain(f.image.asset.id);
    },
  );

  it("keeps a legacy capture generic even when a caller requests its observation", async () => {
    const f = fixture();
    delete assertion(f).capture;
    expect((await f.run()).observations).toBeUndefined();
  });

  it("never returns facts without a versioned selection", async () => {
    const f = fixture();
    delete f.snapshot.observationSelection;
    expect((await f.run()).observations).toBeUndefined();
  });

  it("admits a complete failed assertion only with its own screenshot", async () => {
    const f = fixture();
    f.snapshot.checkOutcome = "failed";
    Object.assign(assertion(f), { outcome: "failed", actual: false });
    expect((await f.run()).observations?.[0]).toMatchObject({
      state: "observed",
      value: { type: "boolean", value: false },
      evidenceIds: [f.snapshot.steps.asset.id, f.image.asset.id],
    });
  });

  it.each(["matching_actual", "global_screenshot"])(
    "rejects invalid failed assertion proof: %s",
    async (kind) => {
      const f = fixture();
      f.snapshot.checkOutcome = "failed";
      Object.assign(assertion(f), { outcome: "failed", actual: kind === "matching_actual" });
      if (kind === "global_screenshot") assertion(f).evidenceIds = [];
      await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
    },
  );

  it("does not mistake a successful contains assertion for a complete mismatch", async () => {
    const f = fixture();
    const step = f.snapshot.scenario.steps[0];
    if (step === undefined) throw new Error("Missing planned step.");
    f.snapshot.scenario.steps[0] = {
      ...step,
      action: "assertText",
      expected: "Ready",
      match: "contains",
    };
    f.execution.steps[0] = {
      ...assertion(f),
      action: "assertText",
      expected: "Ready",
      actual: "Ready now",
      outcome: "failed",
    };
    f.snapshot.checkOutcome = "failed";
    await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
  });

  it("preserves typed unavailable state without turning null into false", async () => {
    const f = fixture();
    f.snapshot.checkOutcome = "blocked";
    Object.assign(assertion(f), {
      outcome: "blocked",
      actual: null,
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "timeout" },
    });
    const fact = (await f.run()).observations?.[0];
    expect(fact).toMatchObject({ state: "unavailable", reason: "timeout" });
    expect(fact).not.toHaveProperty("value");
  });

  it("rejects a measured value attached to an unavailable capture", async () => {
    const f = fixture();
    f.snapshot.checkOutcome = "blocked";
    Object.assign(assertion(f), {
      outcome: "blocked",
      actual: false,
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "timeout" },
    });
    await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
  });

  it.each(["passed", "failed", "not_run_with_screenshot"])(
    "rejects continuation after first failure: %s",
    async (kind) => {
      const f = fixture();
      if (f.snapshot.target !== "web") throw new Error("Missing Web fixture.");
      const planned = f.snapshot.scenario.steps[0];
      if (planned === undefined) throw new Error("Missing planned step.");
      f.snapshot.scenario.steps.push({ ...planned, id: "later", name: "Later" });
      f.snapshot.checkOutcome = "failed";
      Object.assign(assertion(f), { outcome: "failed", actual: false });
      const image = f.asset(Buffer.from("later screenshot"), "screenshot");
      f.snapshot.dependencies.push(dependency(image));
      f.execution.steps.push({
        ...assertion(f),
        stepId: "later",
        name: "Later",
        outcome: kind === "not_run_with_screenshot" ? "not_run" : (kind as "passed" | "failed"),
        actual: kind === "not_run_with_screenshot" ? null : kind === "passed",
        evidenceIds: [image.asset.id],
        capture:
          kind === "not_run_with_screenshot"
            ? { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "not_run" }
            : { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
      });
      await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
    },
  );

  it("returns not_run only after the failed step and never reuses its screenshot", async () => {
    const f = fixture();
    if (f.snapshot.target !== "web") throw new Error("Missing Web fixture.");
    const planned = f.snapshot.scenario.steps[0];
    if (planned === undefined) throw new Error("Missing planned step.");
    f.snapshot.scenario.steps.push({ ...planned, id: "later", name: "Later" });
    f.snapshot.observationSelection?.stepIds.push("later");
    f.snapshot.checkOutcome = "failed";
    Object.assign(assertion(f), { outcome: "failed", actual: false });
    f.execution.steps.push({
      ...assertion(f),
      stepId: "later",
      name: "Later",
      outcome: "not_run",
      actual: null,
      evidenceIds: [],
      capture: { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason: "not_run" },
    });
    const facts = (await f.run()).observations;
    expect(facts).toHaveLength(2);
    expect(facts?.[1]).toMatchObject({
      observation: { stepId: "later" },
      state: "unavailable",
      reason: "not_run",
      evidenceIds: [f.snapshot.steps.asset.id],
    });
  });

  it.each(["unsafe", "oversized"])("rejects incomplete selected text: %s", async (kind) => {
    const f = fixture();
    const planned = f.snapshot.scenario.steps[0];
    if (planned === undefined) throw new Error("Missing planned step.");
    f.snapshot.scenario.steps[0] = { ...planned, action: "assertValue", expected: "Ready" };
    f.execution.steps[0] = {
      ...assertion(f),
      action: "assertValue",
      expected: "Ready",
      outcome: "failed",
      actual: kind === "unsafe" ? "token=private-value" : "x".repeat(2049),
    };
    f.snapshot.checkOutcome = "failed";
    await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
  });

  it("does not transport an unselected assertion value or its summary", async () => {
    const f = fixture();
    if (f.snapshot.target !== "web") throw new Error("Missing Web fixture.");
    const planned = f.snapshot.scenario.steps[0];
    if (planned === undefined) throw new Error("Missing planned step.");
    f.snapshot.scenario.steps.push({
      ...planned,
      id: "private",
      name: "Private",
      action: "assertValue",
      expected: "Unselected value canary",
    });
    const image = f.asset(Buffer.from("other screenshot"), "screenshot");
    f.snapshot.dependencies.push(dependency(image));
    f.execution.steps.push({
      ...assertion(f),
      stepId: "private",
      name: "Private",
      action: "assertValue",
      expected: "Unselected value canary",
      actual: "Unselected value canary",
      summary: "Unselected summary canary",
      evidenceIds: [image.asset.id],
    });
    const proof = await f.run();
    expect(proof.observations).toHaveLength(1);
    expect(JSON.stringify(proof)).not.toContain("canary");
  });

  it.each(["always", "on_failure"] as const)("requires a real trace under %s", async (trace) => {
    const f = fixture();
    if (f.snapshot.target !== "web") throw new Error("Missing Web fixture.");
    f.snapshot.policy.trace = trace;
    f.snapshot.checkOutcome = "failed";
    Object.assign(assertion(f), { outcome: "failed", actual: false });
    await expect(f.run()).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
  });

  it.each(["invalid_utf8", "oversized_bytes"])(
    "rejects bounded document violations: %s",
    async (kind) => {
      const f = fixture();
      await expect(
        f.run(
          kind === "invalid_utf8"
            ? Buffer.from([0xff])
            : Buffer.alloc(maximumVerificationStepsBytes + 1, 32),
        ),
      ).rejects.toMatchObject({ code: "EVIDENCE_SCENARIO_MISMATCH" });
    },
  );
});
