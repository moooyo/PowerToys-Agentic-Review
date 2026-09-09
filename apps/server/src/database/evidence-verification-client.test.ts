import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachEvidenceVerifierForTest,
  type EvidenceVerificationClient,
  type EvidenceVerifierTransport,
} from "./evidence-verification-client.js";
import {
  type AssetVerificationSnapshot,
  type EvidenceAttestation,
  type EvidenceVerificationRequest,
  evidenceSnapshotDigest,
  reusableEvidenceVerification,
  type ScenarioAttestation,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";

const root = {
  directory: "/private/evidence",
  storageKey: "c".repeat(32),
  device: "1",
  inode: "2",
};
const storage = { storageKey: root.storageKey, device: root.device, inode: root.inode };
function snapshot(number = 1): AssetVerificationSnapshot {
  const sha256 = createHash("sha256").update("evidence").digest("hex");
  const asset: AssetVerificationSnapshot["asset"] = {
    id: `11111111-1111-1111-1111-${String(number).padStart(12, "0")}`,
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
    storage,
    asset,
    manifestDigest: evidenceSnapshotDigest(asset),
    expectedFile: {
      device: "1",
      inode: String(number + 2),
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

function scenarioSnapshot(stepIds = ["status"]): ScenarioVerificationSnapshot {
  const steps = snapshot();
  steps.asset.metadata.kind = "steps";
  steps.asset.metadata.mediaType = "application/json";
  steps.manifestDigest = evidenceSnapshotDigest(steps.asset);
  const screenshots = [snapshot(2), snapshot(3)];
  for (const screenshot of screenshots) {
    screenshot.asset.metadata.kind = "screenshot";
    screenshot.asset.metadata.mediaType = "image/png";
    screenshot.manifestDigest = evidenceSnapshotDigest(screenshot.asset);
  }
  return {
    storage,
    resultDigest: "d".repeat(64),
    steps,
    checkOutcome: "passed",
    observationSelection: { schemaVersion: "UiObservationSelectionV1", stepIds },
    dependencies: screenshots.map(({ asset, manifestDigest, expectedFile }) => ({
      asset,
      manifestDigest,
      expectedFile,
    })),
    target: "web",
    scenario: {
      id: "check",
      name: "Status scenario",
      required: true,
      timeoutMs: 1000,
      path: "/",
      steps: [
        {
          id: "open",
          name: "Open status",
          action: "click",
          locator: { by: "testId", testId: "open" },
          timeoutMs: 1000,
        },
        {
          id: "status",
          name: "Read status",
          action: "assertText",
          locator: { by: "testId", testId: "status" },
          timeoutMs: 1000,
          expected: "Ready",
          match: "exact",
        },
        {
          id: "visible",
          name: "Read visibility",
          action: "assertVisible",
          locator: { by: "testId", testId: "status" },
          timeoutMs: 1000,
          expected: true,
        },
      ],
    },
    policy: {
      screenshots: "every_assertion",
      screenshotScope: "viewport",
      trace: "off",
      required: true,
    },
  };
}

type ObservedScenarioFact = Extract<
  NonNullable<ScenarioAttestation["observations"]>[number],
  { state: "observed" }
>;

function scenarioFact(
  value: ScenarioVerificationSnapshot,
  stepId = "status",
): ObservedScenarioFact {
  const screenshot = required(value.dependencies[stepId === "visible" ? 1 : 0]);
  return {
    observation: { kind: "ui_assertion", scenarioId: value.scenario.id, stepId },
    checkId: required(value.steps.asset.scope.checkId ?? undefined),
    evidenceIds: [value.steps.asset.id, screenshot.asset.id],
    state: "observed",
    value:
      stepId === "visible" ? { type: "boolean", value: true } : { type: "string", value: "Ready" },
  };
}

class Transport extends EventEmitter implements EvidenceVerifierTransport {
  filesystemType = 0x01021994;
  requests: EvidenceVerificationRequest[] = [];
  controls: unknown[] = [];
  exitsOnShutdown = true;
  terminated = 0;
  transformAttestation: ((attestation: EvidenceAttestation) => unknown) | undefined;
  postMessage(value: unknown): void {
    const request = value as EvidenceVerificationRequest;
    if (["verify_asset", "verify_scenario", "probe_identities"].includes(request.type))
      this.requests.push(structuredClone(request));
    else {
      this.controls.push(value);
      if (request.type === ("shutdown" as string) && this.exitsOnShutdown)
        queueMicrotask(() => this.emit("exit", 0));
    }
  }
  async terminate(): Promise<number> {
    this.terminated++;
    this.emit("exit", 0);
    return 0;
  }
  ready(): void {
    this.emit("message", { type: "ready" });
  }
  answer(request = required(this.requests.at(-1))): void {
    let attestation: EvidenceAttestation;
    const timing = {
      filesystemType: this.filesystemType,
      startedAtUnixMs: Date.now(),
      finishedAtUnixMs: Date.now(),
      elapsedMonotonicMs: 0,
      clockStable: true,
    };
    if (request.type === "verify_asset")
      attestation = {
        kind: "asset_verified",
        verification: {
          ...timing,
          reusable: reusableEvidenceVerification(timing, [request.snapshot.expectedFile]),
        },
        snapshotDigest: request.snapshotDigest,
        manifestDigest: request.snapshot.manifestDigest,
        assetId: request.snapshot.asset.id,
        storage: request.snapshot.storage,
        sha256: request.snapshot.asset.metadata.sha256,
        sizeBytes: request.snapshot.asset.metadata.sizeBytes,
        before: request.snapshot.expectedFile,
        after: request.snapshot.expectedFile,
      };
    else if (request.type === "probe_identities")
      attestation = {
        kind: "identities_probed",
        snapshotDigest: request.snapshotDigest,
        storage: request.snapshot.storage,
        matches: true,
        assets: request.snapshot.assets.map((item) => ({
          assetId: item.assetId,
          state: item.state,
          before: item.expectedFile,
          after: item.expectedFile,
        })),
      };
    else {
      const dependencies = [request.snapshot.steps, ...request.snapshot.dependencies];
      const selected = request.snapshot.observationSelection;
      attestation = {
        kind: "scenario_verified",
        verification: {
          ...timing,
          reusable: reusableEvidenceVerification(
            timing,
            dependencies.map((item) => item.expectedFile),
          ),
        },
        snapshotDigest: request.snapshotDigest,
        storage: request.snapshot.storage,
        resultDigest: request.snapshot.resultDigest,
        scope: request.snapshot.steps.asset.scope,
        scenarioId: request.snapshot.scenario.id,
        stepsManifestDigest: request.snapshot.steps.manifestDigest,
        dependencyManifestDigests: request.snapshot.dependencies.map((item) => item.manifestDigest),
        observed: dependencies.map((item) => ({
          assetId: item.asset.id,
          state: item.asset.state,
          before: item.expectedFile,
          after: item.expectedFile,
        })),
        ...(selected === undefined
          ? {}
          : {
              observations: selected.stepIds.map((stepId) =>
                scenarioFact(request.snapshot, stepId),
              ),
            }),
      };
    }
    this.emit("message", {
      type: "verified",
      nonce: request.nonce,
      snapshotDigest: request.snapshotDigest,
      attestation: this.transformAttestation?.(attestation) ?? attestation,
    });
  }
}
const clients: EvidenceVerificationClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
function fixture(
  options: {
    maximumQueuedTasks?: number;
    maximumWaiters?: number;
    maximumCacheBytes?: number;
    maximumCacheEntries?: number;
    operationTimeoutMs?: number;
    closeTimeoutMs?: number;
  } = {},
) {
  const transport = new Transport();
  const client = attachEvidenceVerifierForTest(transport, {
    storageRoot: root,
    operationTimeoutMs: 1000,
    closeTimeoutMs: 50,
    ...options,
  });
  clients.push(client);
  return { transport, client, signal: new AbortController().signal };
}
describe("bounded evidence verifier client", () => {
  it("never reuses a young proof when changed bytes retain the same timestamp bucket", async () => {
    const f = fixture();
    f.transport.ready();
    const value = snapshot();
    value.expectedFile.ctimeNs = String(BigInt(Date.now()) * 1000000n);
    value.expectedFile.mtimeNs = value.expectedFile.ctimeNs;
    const first = f.client.verifyAsset(value, f.signal);
    f.transport.answer();
    expect((await first).verification.reusable).toBe(false);
    expect(f.client.peekAssetAttestation(value)).toBeNull();
    // The simulated mutation preserves every metadata field; only a fresh byte check can detect it.
    const changed = f.client.verifyAsset(value, f.signal);
    const request = required(f.transport.requests.at(-1));
    expect(request.type).toBe("verify_asset");
    f.transport.emit("message", {
      type: "failure",
      nonce: request.nonce,
      snapshotDigest: request.snapshotDigest,
      code: "EVIDENCE_INTEGRITY_FAILED",
    });
    await expect(changed).rejects.toMatchObject({ code: "EVIDENCE_INTEGRITY_FAILED" });
  });
  it("disables positive reuse for unknown filesystems and future timestamps", async () => {
    const f = fixture();
    f.transport.filesystemType = 0x6969;
    f.transport.ready();
    const value = snapshot();
    const first = f.client.verifyAsset(value, f.signal);
    f.transport.answer();
    expect((await first).verification.reusable).toBe(false);
    expect(f.client.peekAssetAttestation(value)).toBeNull();
    const next = f.client.verifyAsset(value, f.signal);
    expect(f.transport.requests.at(-1)?.type).toBe("verify_asset");
    f.transport.answer();
    await next;
    f.transport.filesystemType = 0x01021994;
    const future = snapshot(2);
    future.expectedFile.ctimeNs = String(BigInt(Date.now() + 60000) * 1000000n);
    const pending = f.client.verifyAsset(future, f.signal);
    f.transport.answer();
    expect((await pending).verification.reusable).toBe(false);
    expect(f.client.peekAssetAttestation(future)).toBeNull();
  });
  it("clears and disables reuse after wall-clock discontinuity", async () => {
    const f = fixture();
    f.transport.ready();
    const value = snapshot();
    const first = f.client.verifyAsset(value, f.signal);
    f.transport.answer();
    await first;
    expect(f.client.peekAssetAttestation(value)).not.toBeNull();
    const current = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(current + 2000);
    expect(f.client.peekAssetAttestation(value)).toBeNull();
    const fresh = f.client.verifyAsset(value, f.signal);
    expect(f.transport.requests.at(-1)?.type).toBe("verify_asset");
    f.transport.answer();
    await fresh;
    expect(f.client.peekAssetAttestation(value)).toBeNull();
  });
  it("deduplicates cold verification and freshly probes every warm hit", async () => {
    const f = fixture();
    const first = f.client.verifyAsset(snapshot(), f.signal);
    const duplicate = f.client.verifyAsset(snapshot(), f.signal);
    expect(f.transport.requests).toHaveLength(0);
    f.transport.ready();
    expect(f.transport.requests).toHaveLength(1);
    f.transport.answer();
    expect(await duplicate).toEqual(await first);
    const warm = f.client.verifyAsset(snapshot(), f.signal);
    expect(f.transport.requests.at(-1)?.type).toBe("probe_identities");
    f.transport.answer();
    expect((await warm).kind).toBe("asset_verified");
  });
  it("keeps UI observation selection in both cache and shared-task identity", async () => {
    const f = fixture();
    const status = scenarioSnapshot();
    const visible = scenarioSnapshot(["visible"]);
    const legacy = structuredClone(status);
    delete legacy.observationSelection;
    expect({ ...status, observationSelection: undefined }).toEqual({
      ...visible,
      observationSelection: undefined,
    });
    const first = f.client.verifyScenario(status, f.signal);
    const duplicate = f.client.verifyScenario(structuredClone(status), f.signal);
    const changed = f.client.verifyScenario(visible, f.signal);
    const unselected = f.client.verifyScenario(legacy, f.signal);
    f.transport.ready();
    expect(f.transport.requests).toHaveLength(1);
    f.transport.answer();
    const statusProof = await first;
    expect(await duplicate).toEqual(statusProof);
    expect(f.client.peekScenarioAttestation(visible)).toBeNull();
    expect(f.client.peekScenarioAttestation(legacy)).toBeNull();
    expect(f.transport.requests).toHaveLength(2);
    expect(f.transport.requests[1]).toMatchObject({
      type: "verify_scenario",
      snapshot: { observationSelection: { stepIds: ["visible"] } },
    });
    f.transport.answer();
    const visibleProof = await changed;
    expect(visibleProof.observations).toEqual([scenarioFact(visible, "visible")]);
    expect(f.transport.requests).toHaveLength(3);
    f.transport.answer();
    expect((await unselected).observations).toBeUndefined();
    expect(new Set(f.transport.requests.map((request) => request.snapshotDigest)).size).toBe(3);
    expect(statusProof.observations).toEqual([scenarioFact(status)]);
    required(statusProof.observations).splice(0);
    expect(f.client.peekScenarioAttestation(status)?.observations).toEqual([scenarioFact(status)]);
    for (const value of [status, visible, legacy]) {
      const warm = f.client.verifyScenario(value, f.signal);
      expect(f.transport.requests.at(-1)?.type).toBe("probe_identities");
      f.transport.answer();
      expect((await warm).observations).toEqual(
        value.observationSelection?.stepIds.map((stepId) => scenarioFact(value, stepId)),
      );
    }
    expect(
      f.transport.requests.filter((request) => request.type === "verify_scenario"),
    ).toHaveLength(3);
  });
  it.each(["open", "unknown"])(
    "rejects selected non-assertion %s before transport",
    async (stepId) => {
      const f = fixture();
      f.transport.ready();
      await expect(
        f.client.verifyScenario(scenarioSnapshot([stepId]), f.signal),
      ).rejects.toMatchObject({
        code: "EVIDENCE_INVALID_SNAPSHOT",
      });
      expect(f.transport.requests).toHaveLength(0);
    },
  );
  it("accepts unavailable capture reasons without importing an actual value", async () => {
    const f = fixture();
    f.transport.ready();
    const value = scenarioSnapshot();
    const fact = scenarioFact(value);
    const unavailable = {
      observation: fact.observation,
      checkId: fact.checkId,
      evidenceIds: [value.steps.asset.id],
      state: "unavailable",
      reason: "not_run",
    };
    f.transport.transformAttestation = (proof) => ({ ...proof, observations: [unavailable] });
    const pending = f.client.verifyScenario(value, f.signal);
    f.transport.answer();
    expect((await pending).observations).toEqual([unavailable]);
  });
  it("keeps selected legacy scenario evidence readable without observation facts", async () => {
    const f = fixture();
    f.transport.ready();
    f.transport.transformAttestation = (proof) => {
      if (proof.kind !== "scenario_verified") throw new Error("Expected scenario proof.");
      const { observations: _observations, ...legacy } = proof;
      return legacy;
    };
    const pending = f.client.verifyScenario(scenarioSnapshot(), f.signal);
    f.transport.answer();
    expect((await pending).observations).toBeUndefined();
  });
  it.each<{
    name: string;
    forge: (fact: ObservedScenarioFact) => unknown;
  }>([
    { name: "foreign check", forge: (fact) => ({ ...fact, checkId: "profile:other" }) },
    {
      name: "foreign scenario",
      forge: (fact) => ({ ...fact, observation: { ...fact.observation, scenarioId: "other" } }),
    },
    {
      name: "unselected assertion",
      forge: (fact) => ({ ...fact, observation: { ...fact.observation, stepId: "visible" } }),
    },
    {
      name: "probe observation",
      forge: (fact) => ({
        ...fact,
        observation: { kind: "probe_value", testStepId: "measure", observationId: "count" },
      }),
    },
    {
      name: "numeric UI value",
      forge: (fact) => ({ ...fact, value: { type: "number", value: 1 } }),
    },
    {
      name: "boolean text value",
      forge: (fact) => ({ ...fact, value: { type: "boolean", value: true } }),
    },
    {
      name: "unsafe actual text",
      forge: (fact) => ({ ...fact, value: { type: "string", value: "Bearer fake-token" } }),
    },
    {
      name: "transformed actual text",
      forge: (fact) => ({ ...fact, value: { type: "string", value: "[REDACTED]" } }),
    },
    {
      name: "oversized actual text",
      forge: (fact) => ({ ...fact, value: { type: "string", value: "x".repeat(2049) } }),
    },
    {
      name: "unknown capture reason",
      forge: (fact) => ({
        observation: fact.observation,
        checkId: fact.checkId,
        evidenceIds: fact.evidenceIds,
        state: "unavailable",
        reason: "invented_reason",
      }),
    },
    {
      name: "actual value on unavailable capture",
      forge: (fact) => ({ ...fact, state: "unavailable", reason: "timeout" }),
    },
    {
      name: "missing steps evidence",
      forge: (fact) => ({ ...fact, evidenceIds: fact.evidenceIds.slice(1) }),
    },
    {
      name: "steps evidence out of order",
      forge: (fact) => ({ ...fact, evidenceIds: [...fact.evidenceIds].reverse() }),
    },
    {
      name: "foreign screenshot",
      forge: (fact) => ({
        ...fact,
        evidenceIds: [required(fact.evidenceIds[0]), snapshot(4).asset.id],
      }),
    },
    {
      name: "repeated screenshot",
      forge: (fact) => ({
        ...fact,
        evidenceIds: [...fact.evidenceIds, required(fact.evidenceIds[1])],
      }),
    },
  ])("rejects forged $name facts even with the requested snapshot digest", async ({ forge }) => {
    const f = fixture();
    f.transport.ready();
    const value = scenarioSnapshot();
    f.transport.transformAttestation = (proof) => ({
      ...proof,
      observations: [forge(scenarioFact(value))],
    });
    const pending = f.client.verifyScenario(value, f.signal);
    f.transport.answer();
    await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
    expect(f.transport.terminated).toBe(1);
    expect(f.client.peekScenarioAttestation(value)).toBeNull();
  });
  it.each(["extra", "duplicate", "reordered", "shared_screenshot"] as const)(
    "rejects %s observation facts on the private transport",
    async (mode) => {
      const f = fixture();
      f.transport.ready();
      const value = scenarioSnapshot(mode === "extra" ? ["status"] : ["status", "visible"]);
      const first = scenarioFact(value);
      const second = scenarioFact(value, "visible");
      const facts =
        mode === "duplicate"
          ? [first, structuredClone(first)]
          : mode === "reordered"
            ? [second, first]
            : mode === "shared_screenshot"
              ? [first, { ...second, evidenceIds: first.evidenceIds }]
              : [first, second];
      f.transport.transformAttestation = (proof) => ({ ...proof, observations: facts });
      const pending = f.client.verifyScenario(value, f.signal);
      f.transport.answer();
      await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
      expect(f.transport.terminated).toBe(1);
    },
  );
  it.each(["empty", "observed"] as const)(
    "rejects %s observations when the request has no observation selection",
    async (mode) => {
      const f = fixture();
      f.transport.ready();
      const value = scenarioSnapshot();
      delete value.observationSelection;
      f.transport.transformAttestation = (proof) => ({
        ...proof,
        observations: mode === "empty" ? [] : [scenarioFact(value)],
      });
      const pending = f.client.verifyScenario(value, f.signal);
      f.transport.answer();
      await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
      expect(f.transport.terminated).toBe(1);
    },
  );
  it("does not hash on a cold cache hit or claim success before the verifier replies", async () => {
    const f = fixture();
    f.transport.ready();
    let completed = false;
    const pending = f.client.verifyAsset(snapshot(), f.signal).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    f.transport.answer();
    await pending;
  });
  it("rejects a changed identity instead of reusing cached proof", async () => {
    const f = fixture();
    f.transport.ready();
    const cold = f.client.verifyAsset(snapshot(), f.signal);
    f.transport.answer();
    await cold;
    const warm = f.client.verifyAsset(snapshot(), f.signal);
    const request = required(f.transport.requests.at(-1));
    if (request.type !== "probe_identities") throw new Error("Expected fresh probe.");
    f.transport.emit("message", {
      type: "verified",
      nonce: request.nonce,
      snapshotDigest: request.snapshotDigest,
      attestation: {
        kind: "identities_probed",
        snapshotDigest: request.snapshotDigest,
        storage,
        matches: false,
        assets: request.snapshot.assets.map((item) => ({
          assetId: item.assetId,
          state: item.state,
          before: { ...item.expectedFile, ctimeNs: "999" },
          after: { ...item.expectedFile, ctimeNs: "999" },
        })),
      },
    });
    await expect(warm).rejects.toMatchObject({ code: "EVIDENCE_FILE_CHANGED" });
    const retry = f.client.verifyAsset(snapshot(), f.signal);
    expect(f.transport.requests.at(-1)?.type).toBe("verify_asset");
    f.transport.answer();
    await retry;
  });
  it("bounds queued work and shared waiters", async () => {
    const f = fixture({ maximumQueuedTasks: 1, maximumWaiters: 2 });
    const first = f.client.verifyAsset(snapshot(), f.signal);
    const duplicate = f.client.verifyAsset(snapshot(), f.signal);
    await expect(f.client.verifyAsset(snapshot(2), f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_BUSY",
    });
    f.transport.ready();
    f.transport.answer();
    await Promise.all([first, duplicate]);
  });
  it("does not cancel a shared task when only one waiter aborts", async () => {
    const f = fixture();
    f.transport.ready();
    const cancellation = new AbortController();
    const first = f.client.verifyAsset(snapshot(), cancellation.signal);
    const second = f.client.verifyAsset(snapshot(), f.signal);
    cancellation.abort();
    await expect(first).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_CANCELLED" });
    expect(f.transport.controls).toHaveLength(0);
    f.transport.answer();
    await second;
  });
  it("cancels active work after its final waiter aborts", async () => {
    const f = fixture();
    f.transport.ready();
    const cancellation = new AbortController();
    const pending = f.client.verifyAsset(snapshot(), cancellation.signal);
    cancellation.abort();
    await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_CANCELLED" });
    expect(f.transport.controls).toContainEqual({
      type: "cancel",
      nonce: required(f.transport.requests[0]).nonce,
    });
    f.transport.answer();
  });
  it("serves background hashes after at most four foreground starts", async () => {
    const f = fixture();
    f.transport.ready();
    const promises = [
      f.client.verifyAsset(snapshot(1), f.signal),
      f.client.verifyAsset(snapshot(2), f.signal, { priority: "background" }),
    ];
    for (let index = 3; index <= 7; index++)
      promises.push(f.client.verifyAsset(snapshot(index), f.signal));
    for (let index = 0; index < 7; index++)
      f.transport.answer(required(f.transport.requests[index]));
    await Promise.all(promises);
    expect(required(f.transport.requests[4]).snapshot).toMatchObject({
      asset: { id: snapshot(2).asset.id },
    });
  });
  it("dispatches an identity probe while a hash is pending", async () => {
    const f = fixture();
    f.transport.ready();
    const value = snapshot();
    const hash = f.client.verifyAsset(value, f.signal);
    const probe = f.client.probeIdentities(
      {
        storage,
        assets: [
          { assetId: value.asset.id, state: value.asset.state, expectedFile: value.expectedFile },
        ],
      },
      f.signal,
    );
    expect(f.transport.requests.map((request) => request.type)).toEqual([
      "verify_asset",
      "probe_identities",
    ]);
    f.transport.answer(f.transport.requests[1]);
    await probe;
    f.transport.answer(f.transport.requests[0]);
    await hash;
  });
  it.each(["nonce", "snapshotDigest"])("rejects mismatched %s on the private port", async (key) => {
    const f = fixture();
    f.transport.ready();
    const pending = f.client.verifyAsset(snapshot(), f.signal);
    const request = required(f.transport.requests[0]);
    f.transport.emit("message", {
      type: "failure",
      nonce: request.nonce,
      snapshotDigest: request.snapshotDigest,
      code: "EVIDENCE_FILE_UNAVAILABLE",
      [key]: key === "nonce" ? "22222222-2222-2222-2222-222222222222" : "f".repeat(64),
    });
    await expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_PROTOCOL" });
    expect(f.transport.terminated).toBe(1);
  });
  it("evicts bounded cache entries and never caches oversized proofs", async () => {
    const f = fixture({ maximumCacheEntries: 1 });
    f.transport.ready();
    for (const value of [snapshot(1), snapshot(2), snapshot(1)]) {
      const pending = f.client.verifyAsset(value, f.signal);
      expect(f.transport.requests.at(-1)?.type).toBe("verify_asset");
      f.transport.answer();
      await pending;
    }
    const tiny = fixture({ maximumCacheBytes: 1 });
    tiny.transport.ready();
    for (let index = 0; index < 2; index++) {
      const pending = tiny.client.verifyAsset(snapshot(), tiny.signal);
      expect(tiny.transport.requests.at(-1)?.type).toBe("verify_asset");
      tiny.transport.answer();
      await pending;
    }
  });
  it("times out without turning a cold valid reference into unknown evidence", async () => {
    const f = fixture({ operationTimeoutMs: 20 });
    f.transport.ready();
    await expect(f.client.verifyAsset(snapshot(), f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_TIMEOUT",
      retryable: true,
    });
    f.transport.answer();
  });
  it("drains waiters and forces verifier exit on bounded shutdown", async () => {
    const f = fixture({ closeTimeoutMs: 10 });
    f.transport.exitsOnShutdown = false;
    f.transport.ready();
    const pending = f.client.verifyAsset(snapshot(), f.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_VERIFIER_SHUTDOWN" });
    await f.client.close();
    await rejected;
    expect(f.transport.terminated).toBe(1);
    await expect(f.client.verifyAsset(snapshot(), f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_SHUTDOWN",
    });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture.");
  return value;
}
