import { createHash } from "node:crypto";
import {
  EntityIdSchema,
  EvidenceAssetMetadataSchema,
  isSafeUiObservationText,
  isUiAssertionAction,
  maximumEvidenceAssetBytes,
  maximumEvidenceChunkBytes,
  maximumUiScenarioStepCount,
  maximumValidationCheckEvidenceReferences,
  QualifiedValidationCheckIdSchema,
  ReproductionObservationFactSchema,
  Sha256Schema,
  UiAssertionCaptureUnavailableReasonSchema,
  ValidationOutcomeSchema,
  WebUiEvidencePolicySchema,
  WebUiScenarioSchema,
  WindowsUiEvidencePolicySchema,
  WindowsUiScenarioSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const maximumVerificationMessageBytes = 1024 * 1024;
export const maximumIdentityProbeAssets = 64;
export const maximumVerificationStepsBytes = 512 * 1024;
export const minimumEvidenceReuseAgeMs = 2000;
const maximumEvidenceClockDeviationMs = 250;
const reusableLocalFilesystemTypes = new Set([0x01021994, 0xef53, 0x58465342, 0x9123683e]);
export const EvidenceVerificationTimingSchema = Type.Object(
  {
    filesystemType: Type.Integer({ minimum: 0, maximum: 4294967295 }),
    startedAtUnixMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    finishedAtUnixMs: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    elapsedMonotonicMs: Type.Number({ minimum: 0, maximum: 86400000 }),
    clockStable: Type.Boolean(),
    reusable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type EvidenceVerificationTiming = Static<typeof EvidenceVerificationTimingSchema>;
export interface EvidenceClockSample {
  wallMs: number;
  monotonicMs: number;
  stable: boolean;
}
export function createEvidenceClockMonitor(): () => EvidenceClockSample {
  const wall = Date.now();
  const monotonic = performance.now();
  let stable = true;
  return () => {
    const wallMs = Date.now();
    const monotonicMs = performance.now();
    if (
      !Number.isFinite(wallMs) ||
      !Number.isFinite(monotonicMs) ||
      Math.abs(wallMs - wall - (monotonicMs - monotonic)) > maximumEvidenceClockDeviationMs
    )
      stable = false;
    return { wallMs, monotonicMs, stable };
  };
}
export function reusableEvidenceVerification(
  timing: Omit<EvidenceVerificationTiming, "reusable">,
  identities: readonly EvidenceFileIdentity[],
): boolean {
  if (
    identities.length === 0 ||
    !timing.clockStable ||
    !reusableLocalFilesystemTypes.has(timing.filesystemType) ||
    Math.abs(timing.finishedAtUnixMs - timing.startedAtUnixMs - timing.elapsedMonotonicMs) >
      maximumEvidenceClockDeviationMs
  )
    return false;
  const olderThan =
    BigInt(Math.floor(timing.startedAtUnixMs - minimumEvidenceReuseAgeMs)) * 1000000n;
  return identities.every(
    (identity) => BigInt(identity.ctimeNs) <= olderThan && BigInt(identity.mtimeNs) <= olderThan,
  );
}
const DecimalSchema = Type.String({ pattern: "^[0-9]{1,30}$" });
const NanosecondsSchema = Type.String({ pattern: "^-?[0-9]{1,30}$" });
const AssetIdSchema = Type.String({ pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$" });
export const EvidenceRootIdentitySchema = Type.Object(
  {
    storageKey: Type.String({ pattern: "^[a-f0-9]{32}$" }),
    device: DecimalSchema,
    inode: DecimalSchema,
  },
  { additionalProperties: false },
);
export type EvidenceRootIdentity = Static<typeof EvidenceRootIdentitySchema>;
export const EvidenceVerificationRootSchema = Type.Composite(
  [
    EvidenceRootIdentitySchema,
    Type.Object({
      directory: Type.String({ minLength: 2, maxLength: 4096, pattern: "^/[^\\u0000]+$" }),
    }),
  ],
  { additionalProperties: false },
);
export type EvidenceVerificationRoot = Static<typeof EvidenceVerificationRootSchema>;
export const EvidenceFileIdentitySchema = Type.Object(
  {
    device: DecimalSchema,
    inode: DecimalSchema,
    sizeBytes: Type.Integer({ minimum: 0, maximum: maximumEvidenceAssetBytes }),
    ctimeNs: NanosecondsSchema,
    mtimeNs: NanosecondsSchema,
    mode: Type.Literal(0o600),
    uid: Type.Integer({ minimum: 0, maximum: 4294967295 }),
    nlink: Type.Literal(1),
  },
  { additionalProperties: false },
);
export type EvidenceFileIdentity = Static<typeof EvidenceFileIdentitySchema>;
export const EvidenceVerificationScopeSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    checkId: Type.Union([QualifiedValidationCheckIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type EvidenceVerificationScope = Static<typeof EvidenceVerificationScopeSchema>;
export const EvidenceVerificationAssetSchema = Type.Object(
  {
    id: AssetIdSchema,
    state: Type.Union([Type.Literal("uploading"), Type.Literal("finalized")]),
    scope: EvidenceVerificationScopeSchema,
    metadata: EvidenceAssetMetadataSchema,
  },
  { additionalProperties: false },
);
export type EvidenceVerificationAsset = Static<typeof EvidenceVerificationAssetSchema>;
export const EvidenceVerificationChunkSchema = Type.Object(
  {
    offset: Type.Integer({ minimum: 0, maximum: maximumEvidenceAssetBytes - 1 }),
    sizeBytes: Type.Integer({ minimum: 1, maximum: maximumEvidenceChunkBytes }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type EvidenceVerificationChunk = Static<typeof EvidenceVerificationChunkSchema>;
export const AssetVerificationSnapshotSchema = Type.Object(
  {
    storage: EvidenceRootIdentitySchema,
    asset: EvidenceVerificationAssetSchema,
    manifestDigest: Sha256Schema,
    expectedFile: EvidenceFileIdentitySchema,
    chunks: Type.Array(EvidenceVerificationChunkSchema, { minItems: 1, maxItems: 4096 }),
    /** Optional interim-summary binding to the actual decoded steps document. */
    expectedJsonSha256: Type.Optional(Sha256Schema),
  },
  { additionalProperties: false },
);
export type AssetVerificationSnapshot = Static<typeof AssetVerificationSnapshotSchema>;
export const EvidenceIdentityProbeItemSchema = Type.Object(
  {
    assetId: AssetIdSchema,
    state: Type.Union([Type.Literal("uploading"), Type.Literal("finalized")]),
    expectedFile: EvidenceFileIdentitySchema,
  },
  { additionalProperties: false },
);
export type EvidenceIdentityProbeItem = Static<typeof EvidenceIdentityProbeItemSchema>;
export const IdentityProbeSnapshotSchema = Type.Object(
  {
    storage: EvidenceRootIdentitySchema,
    assets: Type.Array(EvidenceIdentityProbeItemSchema, {
      minItems: 1,
      maxItems: maximumIdentityProbeAssets,
    }),
  },
  { additionalProperties: false },
);
export type IdentityProbeSnapshot = Static<typeof IdentityProbeSnapshotSchema>;
const DependencySchema = Type.Object(
  {
    asset: EvidenceVerificationAssetSchema,
    manifestDigest: Sha256Schema,
    expectedFile: EvidenceFileIdentitySchema,
  },
  { additionalProperties: false },
);
export const UiObservationSelectionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("UiObservationSelectionV1"),
    stepIds: Type.Array(EntityIdSchema, {
      minItems: 1,
      maxItems: maximumUiScenarioStepCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type UiObservationSelectionV1 = Static<typeof UiObservationSelectionV1Schema>;
const ScenarioBase = {
  storage: EvidenceRootIdentitySchema,
  resultDigest: Sha256Schema,
  steps: AssetVerificationSnapshotSchema,
  checkOutcome: ValidationOutcomeSchema,
  observationSelection: Type.Optional(UiObservationSelectionV1Schema),
  dependencies: Type.Array(DependencySchema, {
    maxItems: maximumValidationCheckEvidenceReferences - 1,
  }),
};
export const ScenarioVerificationSnapshotSchema = Type.Union([
  Type.Object(
    {
      ...ScenarioBase,
      target: Type.Literal("web"),
      scenario: WebUiScenarioSchema,
      policy: WebUiEvidencePolicySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ScenarioBase,
      target: Type.Literal("windows_desktop"),
      scenario: WindowsUiScenarioSchema,
      policy: WindowsUiEvidencePolicySchema,
    },
    { additionalProperties: false },
  ),
]);
export type ScenarioVerificationSnapshot = Static<typeof ScenarioVerificationSnapshotSchema>;
export const AssetAttestationSchema = Type.Object(
  {
    kind: Type.Literal("asset_verified"),
    verification: EvidenceVerificationTimingSchema,
    snapshotDigest: Sha256Schema,
    manifestDigest: Sha256Schema,
    assetId: AssetIdSchema,
    storage: EvidenceRootIdentitySchema,
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: maximumEvidenceAssetBytes }),
    before: EvidenceFileIdentitySchema,
    after: EvidenceFileIdentitySchema,
  },
  { additionalProperties: false },
);
export type AssetAttestation = Static<typeof AssetAttestationSchema>;
const ObservedIdentitySchema = Type.Object(
  {
    assetId: AssetIdSchema,
    state: Type.Union([Type.Literal("uploading"), Type.Literal("finalized")]),
    before: EvidenceFileIdentitySchema,
    after: EvidenceFileIdentitySchema,
  },
  { additionalProperties: false },
);
export const IdentityAttestationSchema = Type.Object(
  {
    kind: Type.Literal("identities_probed"),
    snapshotDigest: Sha256Schema,
    storage: EvidenceRootIdentitySchema,
    matches: Type.Boolean(),
    assets: Type.Array(ObservedIdentitySchema, {
      minItems: 1,
      maxItems: maximumIdentityProbeAssets,
    }),
  },
  { additionalProperties: false },
);
export type IdentityAttestation = Static<typeof IdentityAttestationSchema>;
export const ScenarioAttestationSchema = Type.Object(
  {
    kind: Type.Literal("scenario_verified"),
    verification: EvidenceVerificationTimingSchema,
    snapshotDigest: Sha256Schema,
    storage: EvidenceRootIdentitySchema,
    resultDigest: Sha256Schema,
    scope: EvidenceVerificationScopeSchema,
    scenarioId: EntityIdSchema,
    stepsManifestDigest: Sha256Schema,
    dependencyManifestDigests: Type.Array(Sha256Schema, {
      maxItems: maximumValidationCheckEvidenceReferences - 1,
    }),
    observed: Type.Array(ObservedIdentitySchema, {
      minItems: 1,
      maxItems: maximumValidationCheckEvidenceReferences,
    }),
    observations: Type.Optional(
      Type.Array(ReproductionObservationFactSchema, {
        minItems: 1,
        maxItems: maximumUiScenarioStepCount,
      }),
    ),
  },
  { additionalProperties: false },
);
export type ScenarioAttestation = Static<typeof ScenarioAttestationSchema>;
export const VerificationFailureCodeSchema = Type.Union([
  Type.Literal("EVIDENCE_INVALID_SNAPSHOT"),
  Type.Literal("EVIDENCE_FILE_UNAVAILABLE"),
  Type.Literal("EVIDENCE_FILE_CHANGED"),
  Type.Literal("EVIDENCE_INTEGRITY_FAILED"),
  Type.Literal("EVIDENCE_SCENARIO_MISMATCH"),
  Type.Literal("EVIDENCE_VERIFIER_BUSY"),
  Type.Literal("EVIDENCE_VERIFIER_TIMEOUT"),
  Type.Literal("EVIDENCE_VERIFIER_CANCELLED"),
  Type.Literal("EVIDENCE_VERIFIER_PROTOCOL"),
  Type.Literal("EVIDENCE_VERIFIER_UNAVAILABLE"),
  Type.Literal("EVIDENCE_VERIFIER_SHUTDOWN"),
]);
export type EvidenceVerificationFailureCode = Static<typeof VerificationFailureCodeSchema>;
export class EvidenceVerificationError extends Error {
  constructor(readonly code: EvidenceVerificationFailureCode) {
    super(`Evidence verification failed: ${code}.`);
    this.name = "EvidenceVerificationError";
  }
  get retryable(): boolean {
    return [
      "EVIDENCE_FILE_UNAVAILABLE",
      "EVIDENCE_VERIFIER_BUSY",
      "EVIDENCE_VERIFIER_TIMEOUT",
      "EVIDENCE_VERIFIER_CANCELLED",
      "EVIDENCE_VERIFIER_UNAVAILABLE",
      "EVIDENCE_VERIFIER_SHUTDOWN",
    ].includes(this.code);
  }
}
export function verificationFailure(code: EvidenceVerificationFailureCode): never {
  throw new EvidenceVerificationError(code);
}
const WireBase = { nonce: AssetIdSchema, snapshotDigest: Sha256Schema };
export const EvidenceVerificationRequestSchema = Type.Union([
  Type.Object(
    { ...WireBase, type: Type.Literal("verify_asset"), snapshot: AssetVerificationSnapshotSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WireBase,
      type: Type.Literal("verify_scenario"),
      snapshot: ScenarioVerificationSnapshotSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...WireBase, type: Type.Literal("probe_identities"), snapshot: IdentityProbeSnapshotSchema },
    { additionalProperties: false },
  ),
]);
export type EvidenceVerificationRequest = Static<typeof EvidenceVerificationRequestSchema>;
export const EvidenceVerificationResponseSchema = Type.Union([
  Type.Object(
    {
      ...WireBase,
      type: Type.Literal("verified"),
      attestation: Type.Union([
        AssetAttestationSchema,
        IdentityAttestationSchema,
        ScenarioAttestationSchema,
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...WireBase, type: Type.Literal("failure"), code: VerificationFailureCodeSchema },
    { additionalProperties: false },
  ),
]);
export type EvidenceVerificationResponse = Static<typeof EvidenceVerificationResponseSchema>;
export type EvidenceAttestation = AssetAttestation | IdentityAttestation | ScenarioAttestation;
export type EvidenceSnapshot =
  | AssetVerificationSnapshot
  | IdentityProbeSnapshot
  | ScenarioVerificationSnapshot;
export type EvidenceVerifierInput =
  | EvidenceVerificationRequest
  | { type: "cancel"; nonce: string }
  | { type: "shutdown" };

export function evidenceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(evidenceCanonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${evidenceCanonicalJson(record[key])}`)
    .join(",")}}`;
}
export function evidenceSnapshotDigest(value: unknown): string {
  return createHash("sha256").update(evidenceCanonicalJson(value)).digest("hex");
}
export function sameEvidenceIdentity(
  first: EvidenceFileIdentity,
  second: EvidenceFileIdentity,
): boolean {
  return evidenceCanonicalJson(first) === evidenceCanonicalJson(second);
}
export function checkVerificationSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (text) => Number.isFinite(Date.parse(text)));
  if (!Value.Check(schema, value)) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumVerificationMessageBytes)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  return value;
}
export function checkAssetSnapshot(snapshot: AssetVerificationSnapshot): void {
  checkVerificationSchema(AssetVerificationSnapshotSchema, snapshot);
  if (
    evidenceSnapshotDigest(snapshot.asset) !== snapshot.manifestDigest ||
    snapshot.expectedFile.sizeBytes !== snapshot.asset.metadata.sizeBytes ||
    (snapshot.asset.metadata.checkId ?? null) !== snapshot.asset.scope.checkId
  )
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  let offset = 0;
  for (const chunk of snapshot.chunks) {
    if (chunk.offset !== offset) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    offset += chunk.sizeBytes;
  }
  if (offset !== snapshot.asset.metadata.sizeBytes)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
}
export function checkSnapshotRoot(
  root: EvidenceVerificationRoot,
  storage: EvidenceRootIdentity,
): void {
  if (
    root.storageKey !== storage.storageKey ||
    root.device !== storage.device ||
    root.inode !== storage.inode
  )
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
}

/** The caller selects only frozen assertion IDs; no asset text chooses its own authority. */
export function checkScenarioObservationSelection(snapshot: ScenarioVerificationSnapshot): void {
  const selected = snapshot.observationSelection;
  if (selected === undefined) return;
  checkVerificationSchema(UiObservationSelectionV1Schema, selected);
  for (const stepId of selected.stepIds) {
    const step = snapshot.scenario.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined || !isUiAssertionAction(step.action))
      verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  }
}

/** Limits attested facts to the exact requested selection and already verified evidence scope. */
export function checkScenarioObservationAttestation(
  snapshot: ScenarioVerificationSnapshot,
  attestation: ScenarioAttestation,
): void {
  checkScenarioObservationSelection(snapshot);
  const facts = attestation.observations;
  // Legacy step evidence can prove a generic check, but never supplies observation facts.
  if (facts === undefined) return;
  const selected = snapshot.observationSelection;
  if (selected === undefined || facts.length !== selected.stepIds.length)
    verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
  const screenshotIds = new Set(
    snapshot.dependencies
      .filter((dependency) => dependency.asset.metadata.kind === "screenshot")
      .map((dependency) => dependency.asset.id),
  );
  const assignedScreenshots = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    const stepId = selected.stepIds[index];
    const step = snapshot.scenario.steps.find((candidate) => candidate.id === stepId);
    if (
      step === undefined ||
      fact.observation.kind !== "ui_assertion" ||
      fact.observation.scenarioId !== snapshot.scenario.id ||
      fact.observation.stepId !== stepId ||
      fact.checkId !== snapshot.steps.asset.scope.checkId ||
      fact.evidenceIds[0] !== snapshot.steps.asset.id ||
      fact.evidenceIds.length > 5 ||
      fact.evidenceIds
        .slice(1)
        .some((id) => !screenshotIds.has(id) || assignedScreenshots.has(id)) ||
      (fact.state === "unavailable" &&
        !Value.Check(UiAssertionCaptureUnavailableReasonSchema, fact.reason)) ||
      (fact.state === "observed" &&
        (step.action === "assertVisible"
          ? fact.value.type !== "boolean"
          : fact.value.type !== "string" || !isSafeUiObservationText(fact.value.value)))
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    for (const id of fact.evidenceIds.slice(1)) assignedScreenshots.add(id);
  }
}
