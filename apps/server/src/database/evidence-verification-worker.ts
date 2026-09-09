import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  isUiAssertionAction,
  matchesUiScenarioObservations,
  matchesUiStepObservation,
  type ReproductionObservationFact,
  UiScenarioExecutionEvidenceV1Schema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { probeEvidenceIdentities, verifyEvidenceAsset } from "./evidence-files.js";
import {
  checkAssetSnapshot,
  checkScenarioObservationAttestation,
  checkScenarioObservationSelection,
  checkSnapshotRoot,
  checkVerificationSchema,
  type EvidenceAttestation,
  EvidenceVerificationError,
  type EvidenceVerificationRequest,
  EvidenceVerificationRequestSchema,
  type EvidenceVerificationResponse,
  type EvidenceVerificationRoot,
  EvidenceVerificationRootSchema,
  evidenceCanonicalJson,
  evidenceSnapshotDigest,
  maximumVerificationStepsBytes,
  reusableEvidenceVerification,
  type ScenarioAttestation,
  type ScenarioVerificationSnapshot,
  ScenarioVerificationSnapshotSchema,
  verificationFailure,
} from "./evidence-verification-protocol.js";

/** Proves step semantics and dependency identity, not screenshot/trace content by itself. */
export async function verifyEvidenceScenario(
  root: EvidenceVerificationRoot,
  snapshot: ScenarioVerificationSnapshot,
  signal: AbortSignal,
): Promise<ScenarioAttestation> {
  checkVerificationSchema(ScenarioVerificationSnapshotSchema, snapshot);
  checkSnapshotRoot(root, snapshot.storage);
  checkAssetSnapshot(snapshot.steps);
  checkScenarioObservationSelection(snapshot);
  if (
    snapshot.steps.asset.state !== "finalized" ||
    snapshot.steps.asset.metadata.kind !== "steps" ||
    snapshot.steps.asset.scope.checkId !==
      `${snapshot.steps.asset.scope.profileVersionId}:${snapshot.scenario.id}` ||
    new Set(snapshot.scenario.steps.map((step) => step.id)).size !==
      snapshot.scenario.steps.length ||
    !snapshot.scenario.steps.some((step) => isUiAssertionAction(step.action))
  )
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  const dependencies = new Map(snapshot.dependencies.map((item) => [item.asset.id, item]));
  if (
    dependencies.size !== snapshot.dependencies.length ||
    dependencies.has(snapshot.steps.asset.id)
  )
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  for (const item of snapshot.dependencies) {
    if (
      item.asset.state !== "finalized" ||
      item.asset.metadata.kind === "steps" ||
      evidenceCanonicalJson(item.asset.scope) !==
        evidenceCanonicalJson(snapshot.steps.asset.scope) ||
      evidenceSnapshotDigest(item.asset) !== item.manifestDigest ||
      item.expectedFile.sizeBytes !== item.asset.metadata.sizeBytes ||
      (item.asset.metadata.checkId ?? null) !== item.asset.scope.checkId
    )
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  }
  const captured = await verifyEvidenceAsset(root, snapshot.steps, signal, true);
  if (
    captured.bytes === undefined ||
    captured.bytes.length !== snapshot.steps.asset.metadata.sizeBytes ||
    captured.bytes.length > maximumVerificationStepsBytes
  )
    verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes));
  } catch {
    return verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  }
  let execution: ReturnType<
    typeof checkVerificationSchema<typeof UiScenarioExecutionEvidenceV1Schema>
  >;
  try {
    execution = checkVerificationSchema(UiScenarioExecutionEvidenceV1Schema, parsed);
  } catch {
    return verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  }
  if (
    execution.target !== snapshot.target ||
    execution.scenarioId !== snapshot.scenario.id ||
    !matchesUiScenarioObservations(snapshot.scenario.steps, execution.steps, {
      checkOutcome: snapshot.checkOutcome,
    })
  )
    verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  const assigned = new Set<string>();
  for (const [index, planned] of snapshot.scenario.steps.entries()) {
    const actual = execution.steps[index];
    if (actual === undefined) verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
    for (const id of actual.evidenceIds) {
      if (dependencies.get(id)?.asset.metadata.kind !== "screenshot" || assigned.has(id))
        verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
      assigned.add(id);
    }
    if (
      snapshot.policy.screenshots === "every_assertion" &&
      isUiAssertionAction(planned.action) &&
      actual.outcome === "passed" &&
      actual.evidenceIds.length === 0
    )
      verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  }
  if (
    snapshot.checkOutcome === "failed" &&
    !snapshot.dependencies.some((item) => item.asset.metadata.kind === "screenshot")
  )
    verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  if (
    snapshot.target === "web" &&
    (snapshot.policy.trace === "always" ||
      (snapshot.policy.trace === "on_failure" && snapshot.checkOutcome === "failed")) &&
    !snapshot.dependencies.some((item) => item.asset.metadata.kind === "trace")
  )
    verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
  let observations: ReproductionObservationFact[] | undefined;
  const selected = snapshot.observationSelection;
  // A historical capture remains generic evidence even when a newer caller requests facts.
  // Grant the requested set atomically so missing capture cannot yield a partial signature.
  if (
    selected?.stepIds.every((stepId) => {
      const step = execution.steps.find((candidate) => candidate.stepId === stepId);
      return step !== undefined && "capture" in step && step.capture !== undefined;
    })
  ) {
    observations = selected.stepIds.map((stepId): ReproductionObservationFact => {
      const planned = snapshot.scenario.steps.find((step) => step.id === stepId);
      const actual = execution.steps.find((step) => step.stepId === stepId);
      if (
        planned === undefined ||
        actual === undefined ||
        !matchesUiStepObservation(planned, actual, { requireCapture: true }) ||
        !("capture" in actual) ||
        actual.capture === undefined ||
        (actual.capture.state === "complete" &&
          actual.outcome === "failed" &&
          actual.evidenceIds.length === 0)
      )
        return verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
      const common = {
        observation: { kind: "ui_assertion" as const, scenarioId: snapshot.scenario.id, stepId },
        checkId: snapshot.steps.asset.scope.checkId as string,
        evidenceIds: [snapshot.steps.asset.id, ...actual.evidenceIds],
      };
      if (actual.capture.state === "unavailable")
        return { ...common, state: "unavailable", reason: actual.capture.reason };
      if (typeof actual.actual === "boolean")
        return { ...common, state: "observed", value: { type: "boolean", value: actual.actual } };
      if (typeof actual.actual === "string")
        return { ...common, state: "observed", value: { type: "string", value: actual.actual } };
      return verificationFailure("EVIDENCE_SCENARIO_MISMATCH");
    });
  }
  const probe = await probeEvidenceIdentities(
    root,
    {
      storage: snapshot.storage,
      assets: [
        {
          assetId: snapshot.steps.asset.id,
          state: snapshot.steps.asset.state,
          expectedFile: snapshot.steps.expectedFile,
        },
        ...snapshot.dependencies.map((item) => ({
          assetId: item.asset.id,
          state: item.asset.state,
          expectedFile: item.expectedFile,
        })),
      ],
    },
    signal,
  );
  if (!probe.matches) verificationFailure("EVIDENCE_FILE_CHANGED");
  const attestation: ScenarioAttestation = {
    kind: "scenario_verified",
    verification: {
      ...captured.attestation.verification,
      reusable: reusableEvidenceVerification(
        captured.attestation.verification,
        probe.assets.map((item) => item.after),
      ),
    },
    snapshotDigest: evidenceSnapshotDigest(snapshot),
    storage: snapshot.storage,
    resultDigest: snapshot.resultDigest,
    scope: snapshot.steps.asset.scope,
    scenarioId: snapshot.scenario.id,
    stepsManifestDigest: snapshot.steps.manifestDigest,
    dependencyManifestDigests: snapshot.dependencies.map((item) => item.manifestDigest),
    observed: probe.assets,
    ...(observations === undefined ? {} : { observations }),
  };
  checkScenarioObservationAttestation(snapshot, attestation);
  return attestation;
}

export async function executeEvidenceVerification(
  root: EvidenceVerificationRoot,
  request: EvidenceVerificationRequest,
  signal: AbortSignal,
): Promise<EvidenceAttestation> {
  checkVerificationSchema(EvidenceVerificationRequestSchema, request);
  if (evidenceSnapshotDigest(request.snapshot) !== request.snapshotDigest)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  checkSnapshotRoot(root, request.snapshot.storage);
  switch (request.type) {
    case "verify_asset":
      return (await verifyEvidenceAsset(root, request.snapshot, signal)).attestation;
    case "verify_scenario":
      return verifyEvidenceScenario(root, request.snapshot, signal);
    case "probe_identities":
      return probeEvidenceIdentities(root, request.snapshot, signal);
  }
}

if (!isMainThread) {
  const port = parentPort;
  if (port === null) throw new Error("The evidence verifier requires its private parent port.");
  try {
    const root = checkVerificationSchema(EvidenceVerificationRootSchema, workerData);
    const active = new Map<
      string,
      { controller: AbortController; task: Promise<void>; probe: boolean }
    >();
    let draining = false;
    const shutdown = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      for (const work of active.values()) work.controller.abort();
      await Promise.allSettled([...active.values()].map((work) => work.task));
      port.close();
    };
    port.on("message", (message: unknown) => {
      if (draining) return;
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "shutdown"
      ) {
        try {
          checkVerificationSchema(
            Type.Object({ type: Type.Literal("shutdown") }, { additionalProperties: false }),
            message,
          );
        } catch {
          void shutdown();
          return;
        }
        void shutdown();
        return;
      }
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "cancel"
      ) {
        try {
          const cancelled = checkVerificationSchema(
            Type.Object(
              { type: Type.Literal("cancel"), nonce: Type.String({ pattern: "^[a-f0-9-]{36}$" }) },
              { additionalProperties: false },
            ),
            message,
          );
          active.get(cancelled.nonce)?.controller.abort();
        } catch {
          void shutdown();
        }
        return;
      }
      let request: EvidenceVerificationRequest;
      try {
        request = checkVerificationSchema(EvidenceVerificationRequestSchema, message);
      } catch {
        port.postMessage({ type: "fatal", code: "EVIDENCE_VERIFIER_PROTOCOL" });
        void shutdown();
        return;
      }
      const probe = request.type === "probe_identities";
      if (active.has(request.nonce) || [...active.values()].some((item) => item.probe === probe)) {
        port.postMessage({
          type: "failure",
          nonce: request.nonce,
          snapshotDigest: request.snapshotDigest,
          code: "EVIDENCE_VERIFIER_BUSY",
        } satisfies EvidenceVerificationResponse);
        return;
      }
      const controller = new AbortController();
      const task = Promise.resolve().then(async () => {
        try {
          const attestation = await executeEvidenceVerification(root, request, controller.signal);
          if (controller.signal.aborted) verificationFailure("EVIDENCE_VERIFIER_CANCELLED");
          port.postMessage({
            type: "verified",
            nonce: request.nonce,
            snapshotDigest: request.snapshotDigest,
            attestation,
          } satisfies EvidenceVerificationResponse);
        } catch (error) {
          port.postMessage({
            type: "failure",
            nonce: request.nonce,
            snapshotDigest: request.snapshotDigest,
            code:
              error instanceof EvidenceVerificationError ? error.code : "EVIDENCE_FILE_UNAVAILABLE",
          } satisfies EvidenceVerificationResponse);
        } finally {
          active.delete(request.nonce);
        }
      });
      active.set(request.nonce, { controller, task, probe });
    });
    port.postMessage({ type: "ready" });
  } catch {
    port.postMessage({ type: "fatal", code: "EVIDENCE_VERIFIER_PROTOCOL" });
    port.close();
  }
}
