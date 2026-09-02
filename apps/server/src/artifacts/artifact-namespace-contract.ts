import { createHash, timingSafeEqual } from "node:crypto";
import { maximumResultArtifactBytes } from "@agentic-review/contracts";

export const maximumArtifactNamespacePageSize = 256;
export const maximumArtifactNamespaceManifestEntries = 65_536;

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const canonicalUnsignedDecimalPattern = /^(?:0|[1-9][0-9]{0,39})$/u;
const stagingKeyPattern = new RegExp(
  `^staging/(${uuidV4Pattern.source.slice(1, -1)})\\.upload$`,
  "u",
);
const temporaryKeyPattern = new RegExp(
  `^objects/sha256/([0-9a-f]{2})/\\.publish-(${uuidV4Pattern.source.slice(1, -1)})-(${uuidV4Pattern.source.slice(1, -1)})\\.tmp$`,
  "u",
);

export type ArtifactNamespaceObservationKind = "staging" | "publication-temporary";

export interface ParsedArtifactNamespaceEntryKey {
  readonly entryKey: string;
  readonly kind: ArtifactNamespaceObservationKind;
  readonly uploadId: string;
  readonly finalizationId: string | null;
  readonly shard: string | null;
}

export interface ArtifactNamespaceObservationIdentity {
  readonly entryKey: string;
  readonly kind: ArtifactNamespaceObservationKind;
  readonly uploadId: string;
  readonly finalizationId: string | null;
  readonly linkedObjectSha256: string | null;
  readonly observedBytes: number;
  readonly expectedLinkCount: 1 | 2;
  readonly fileDevice: string;
  readonly fileInode: string;
  readonly fileCtimeNs: string;
  readonly fileMode: string;
  readonly fileUid: string;
  readonly parentDevice: string;
  readonly parentInode: string;
  readonly parentMode: string;
  readonly parentUid: string;
  readonly linkedObjectDevice: string | null;
  readonly linkedObjectInode: string | null;
  readonly linkedObjectCtimeNs: string | null;
}

export interface ArtifactNamespaceObservation extends ArtifactNamespaceObservationIdentity {
  readonly observationSha256: string;
}

export interface ArtifactNamespaceScanPageInput {
  readonly scanSessionId: string;
  readonly sweepGeneration: number;
  readonly expectedAfterKey: string | null;
  readonly maximumEntries: number;
}

export interface ArtifactNamespaceScanPageResult {
  readonly scanSessionId: string;
  readonly sweepGeneration: number;
  readonly expectedAfterKey: string | null;
  readonly observations: readonly ArtifactNamespaceObservation[];
  readonly completedSweep: boolean;
  readonly nextAfterKey: string | null;
}

export interface CloseArtifactNamespaceScanInput {
  readonly scanSessionId: string;
  readonly sweepGeneration: number;
  readonly expectedAfterKey: string | null;
}

export interface CloseArtifactNamespaceScanResult extends CloseArtifactNamespaceScanInput {
  readonly closed: true;
}

export interface ArtifactNamespaceCleanupResult {
  readonly entryKey: string;
  readonly observationSha256: string;
  readonly outcome: "removed" | "already_absent" | "identity_changed";
}

const exactDataObject = (
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Artifact namespace data must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Artifact namespace data must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError("Artifact namespace data contains unsupported or missing fields.");
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Artifact namespace data must contain data properties only.");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

const identityKeys = [
  "entryKey",
  "kind",
  "uploadId",
  "finalizationId",
  "linkedObjectSha256",
  "observedBytes",
  "expectedLinkCount",
  "fileDevice",
  "fileInode",
  "fileCtimeNs",
  "fileMode",
  "fileUid",
  "parentDevice",
  "parentInode",
  "parentMode",
  "parentUid",
  "linkedObjectDevice",
  "linkedObjectInode",
  "linkedObjectCtimeNs",
] as const;

export const parseArtifactNamespaceEntryKey = (
  value: unknown,
  expectedKind?: ArtifactNamespaceObservationKind,
): ParsedArtifactNamespaceEntryKey => {
  if (typeof value !== "string") {
    throw new TypeError("Artifact namespace entry keys must be text.");
  }
  const staging = stagingKeyPattern.exec(value);
  if (staging !== null) {
    const uploadId = staging[1];
    if (uploadId === undefined || (expectedKind !== undefined && expectedKind !== "staging")) {
      throw new TypeError("Artifact namespace entry key kind does not match.");
    }
    return Object.freeze({
      entryKey: value,
      kind: "staging" as const,
      uploadId,
      finalizationId: null,
      shard: null,
    });
  }
  const temporary = temporaryKeyPattern.exec(value);
  if (temporary !== null) {
    const shard = temporary[1];
    const uploadId = temporary[2];
    const finalizationId = temporary[3];
    if (
      shard === undefined ||
      uploadId === undefined ||
      finalizationId === undefined ||
      (expectedKind !== undefined && expectedKind !== "publication-temporary")
    ) {
      throw new TypeError("Artifact namespace entry key kind does not match.");
    }
    return Object.freeze({
      entryKey: value,
      kind: "publication-temporary" as const,
      uploadId,
      finalizationId,
      shard,
    });
  }
  throw new TypeError("Artifact namespace entry key is not managed.");
};

export const requireArtifactNamespaceScanSessionId = (value: unknown): string => {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new TypeError("Artifact namespace scan session IDs must be lowercase UUIDv4 values.");
  }
  return value;
};

export const requireArtifactNamespaceObservationSha256 = (value: unknown): string => {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError("Artifact namespace observation digests must be lowercase SHA-256 values.");
  }
  return value;
};

export const snapshotArtifactNamespaceSweepGeneration = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Artifact namespace sweep generation must be non-negative.");
  }
  return value as number;
};

const identityNumber = (value: unknown): string => {
  if (typeof value !== "string" || !canonicalUnsignedDecimalPattern.test(value)) {
    throw new TypeError("Artifact namespace identities must use canonical unsigned decimals.");
  }
  return value;
};

const optionalIdentityNumber = (value: unknown): string | null =>
  value === null ? null : identityNumber(value);

export const snapshotArtifactNamespaceObservationIdentity = (
  value: unknown,
): ArtifactNamespaceObservationIdentity => {
  const snapshot = exactDataObject(value, identityKeys);
  if (snapshot.kind !== "staging" && snapshot.kind !== "publication-temporary") {
    throw new TypeError("Artifact namespace observation kind is unsupported.");
  }
  const kind = snapshot.kind;
  const parsed = parseArtifactNamespaceEntryKey(snapshot.entryKey, kind);
  if (snapshot.uploadId !== parsed.uploadId || snapshot.finalizationId !== parsed.finalizationId) {
    throw new TypeError("Artifact namespace observation identifiers do not match its key.");
  }
  const linkedObjectSha256 =
    snapshot.linkedObjectSha256 === null
      ? null
      : typeof snapshot.linkedObjectSha256 === "string" &&
          sha256Pattern.test(snapshot.linkedObjectSha256)
        ? snapshot.linkedObjectSha256
        : (() => {
            throw new TypeError("Artifact namespace linked object digest is invalid.");
          })();
  const fileDevice = identityNumber(snapshot.fileDevice);
  const fileInode = identityNumber(snapshot.fileInode);
  const fileCtimeNs = identityNumber(snapshot.fileCtimeNs);
  const fileMode = identityNumber(snapshot.fileMode);
  const fileUid = identityNumber(snapshot.fileUid);
  const parentDevice = identityNumber(snapshot.parentDevice);
  const parentInode = identityNumber(snapshot.parentInode);
  const parentMode = identityNumber(snapshot.parentMode);
  const parentUid = identityNumber(snapshot.parentUid);
  const linkedObjectDevice = optionalIdentityNumber(snapshot.linkedObjectDevice);
  const linkedObjectInode = optionalIdentityNumber(snapshot.linkedObjectInode);
  const linkedObjectCtimeNs = optionalIdentityNumber(snapshot.linkedObjectCtimeNs);
  const linkedIdentityCount =
    (linkedObjectDevice === null ? 0 : 1) +
    (linkedObjectInode === null ? 0 : 1) +
    (linkedObjectCtimeNs === null ? 0 : 1);
  const hasLinkedIdentity = linkedIdentityCount === 3;
  if (
    !Number.isSafeInteger(snapshot.observedBytes) ||
    (snapshot.observedBytes as number) < 0 ||
    (snapshot.observedBytes as number) > maximumResultArtifactBytes ||
    fileDevice !== parentDevice ||
    (snapshot.expectedLinkCount !== 1 && snapshot.expectedLinkCount !== 2) ||
    (kind === "staging" &&
      (linkedObjectSha256 !== null ||
        linkedIdentityCount !== 0 ||
        snapshot.expectedLinkCount !== 1)) ||
    (kind === "publication-temporary" &&
      (linkedIdentityCount === 1 ||
        linkedIdentityCount === 2 ||
        (snapshot.expectedLinkCount === 1 && (linkedObjectSha256 !== null || hasLinkedIdentity)) ||
        (snapshot.expectedLinkCount === 2 &&
          (linkedObjectSha256 === null ||
            !hasLinkedIdentity ||
            linkedObjectDevice !== fileDevice ||
            linkedObjectInode !== fileInode ||
            linkedObjectCtimeNs !== fileCtimeNs ||
            linkedObjectSha256.slice(0, 2) !== parsed.shard))))
  ) {
    throw new TypeError("Artifact namespace observation identity is inconsistent.");
  }
  return Object.freeze({
    entryKey: parsed.entryKey,
    kind,
    uploadId: parsed.uploadId,
    finalizationId: parsed.finalizationId,
    linkedObjectSha256,
    observedBytes: snapshot.observedBytes as number,
    expectedLinkCount: snapshot.expectedLinkCount as 1 | 2,
    fileDevice,
    fileInode,
    fileCtimeNs,
    fileMode,
    fileUid,
    parentDevice,
    parentInode,
    parentMode,
    parentUid,
    linkedObjectDevice,
    linkedObjectInode,
    linkedObjectCtimeNs,
  });
};

export const calculateArtifactNamespaceObservationSha256 = (
  value: ArtifactNamespaceObservationIdentity,
): string => {
  const observation = snapshotArtifactNamespaceObservationIdentity(value);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "artifact_namespace_observation_v1",
        observation.entryKey,
        observation.kind,
        observation.uploadId,
        observation.finalizationId,
        observation.linkedObjectSha256,
        observation.observedBytes,
        observation.expectedLinkCount,
        observation.fileDevice,
        observation.fileInode,
        observation.fileCtimeNs,
        observation.fileMode,
        observation.fileUid,
        observation.parentDevice,
        observation.parentInode,
        observation.parentMode,
        observation.parentUid,
        observation.linkedObjectDevice,
        observation.linkedObjectInode,
        observation.linkedObjectCtimeNs,
      ]),
      "utf8",
    )
    .digest("hex");
};

export const artifactNamespaceObservationSha256Matches = (
  actual: unknown,
  expected: string,
): actual is string =>
  typeof actual === "string" &&
  sha256Pattern.test(actual) &&
  timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

export const snapshotArtifactNamespaceObservation = (
  value: unknown,
): ArtifactNamespaceObservation => {
  const snapshot = exactDataObject(value, [
    "entryKey",
    "observationSha256",
    ...identityKeys.slice(1),
  ]);
  const identity = snapshotArtifactNamespaceObservationIdentity({
    entryKey: snapshot.entryKey,
    kind: snapshot.kind,
    uploadId: snapshot.uploadId,
    finalizationId: snapshot.finalizationId,
    linkedObjectSha256: snapshot.linkedObjectSha256,
    observedBytes: snapshot.observedBytes,
    expectedLinkCount: snapshot.expectedLinkCount,
    fileDevice: snapshot.fileDevice,
    fileInode: snapshot.fileInode,
    fileCtimeNs: snapshot.fileCtimeNs,
    fileMode: snapshot.fileMode,
    fileUid: snapshot.fileUid,
    parentDevice: snapshot.parentDevice,
    parentInode: snapshot.parentInode,
    parentMode: snapshot.parentMode,
    parentUid: snapshot.parentUid,
    linkedObjectDevice: snapshot.linkedObjectDevice,
    linkedObjectInode: snapshot.linkedObjectInode,
    linkedObjectCtimeNs: snapshot.linkedObjectCtimeNs,
  });
  if (
    !artifactNamespaceObservationSha256Matches(
      snapshot.observationSha256,
      calculateArtifactNamespaceObservationSha256(identity),
    )
  ) {
    throw new TypeError("Artifact namespace observation digest is invalid.");
  }
  return Object.freeze({ ...identity, observationSha256: snapshot.observationSha256 });
};

export const snapshotArtifactNamespaceObservations = (
  value: unknown,
): readonly ArtifactNamespaceObservation[] => {
  if (!Array.isArray(value) || value.length > maximumArtifactNamespacePageSize) {
    throw new TypeError("Artifact namespace observation pages must be bounded arrays.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    throw new TypeError("Artifact namespace observation pages must be dense arrays.");
  }
  const observations: ArtifactNamespaceObservation[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Artifact namespace observation pages must contain data values.");
    }
    observations.push(snapshotArtifactNamespaceObservation(descriptor.value));
  }
  return Object.freeze(observations);
};

const optionalManagedKey = (value: unknown): string | null =>
  value === null ? null : parseArtifactNamespaceEntryKey(value).entryKey;

export const snapshotArtifactNamespaceScanPageInput = (
  value: unknown,
): ArtifactNamespaceScanPageInput => {
  const snapshot = exactDataObject(value, [
    "scanSessionId",
    "sweepGeneration",
    "expectedAfterKey",
    "maximumEntries",
  ]);
  const maximumEntries = snapshot.maximumEntries;
  if (
    !Number.isSafeInteger(maximumEntries) ||
    (maximumEntries as number) < 1 ||
    (maximumEntries as number) > maximumArtifactNamespacePageSize
  ) {
    throw new TypeError("Artifact namespace scan pages exceed their entry limit.");
  }
  return Object.freeze({
    scanSessionId: requireArtifactNamespaceScanSessionId(snapshot.scanSessionId),
    sweepGeneration: snapshotArtifactNamespaceSweepGeneration(snapshot.sweepGeneration),
    expectedAfterKey: optionalManagedKey(snapshot.expectedAfterKey),
    maximumEntries: maximumEntries as number,
  });
};

export const snapshotCloseArtifactNamespaceScanInput = (
  value: unknown,
): CloseArtifactNamespaceScanInput => {
  const snapshot = exactDataObject(value, ["scanSessionId", "sweepGeneration", "expectedAfterKey"]);
  return Object.freeze({
    scanSessionId: requireArtifactNamespaceScanSessionId(snapshot.scanSessionId),
    sweepGeneration: snapshotArtifactNamespaceSweepGeneration(snapshot.sweepGeneration),
    expectedAfterKey: optionalManagedKey(snapshot.expectedAfterKey),
  });
};
