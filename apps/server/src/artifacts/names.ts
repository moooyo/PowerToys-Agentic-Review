import { join, relative, resolve, sep } from "node:path";
import { maximumResultArtifactBytes } from "@agentic-review/contracts";

const lowerUuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lowerSha256Pattern = /^[0-9a-f]{64}$/u;

export const requireArtifactUploadId = (value: string): string => {
  if (!lowerUuidV4Pattern.test(value)) {
    throw new TypeError("Artifact upload IDs must be lowercase UUIDv4 values.");
  }
  return value;
};

export const requireArtifactOperationId = (value: string, name: string): string => {
  if (!lowerUuidV4Pattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase UUIDv4 value.`);
  }
  return value;
};

export const requireArtifactSha256 = (value: string): string => {
  if (!lowerSha256Pattern.test(value)) {
    throw new TypeError(
      "Artifact SHA-256 values must contain 64 lowercase hexadecimal characters.",
    );
  }
  return value;
};

export const requireArtifactByteCount = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumResultArtifactBytes) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximumResultArtifactBytes}.`);
  }
  return value;
};

export const artifactStagingFilename = (uploadId: string): string =>
  `${requireArtifactUploadId(uploadId)}.upload`;

export const artifactObjectKey = (sha256: string): string => {
  const digest = requireArtifactSha256(sha256);
  return `sha256/${digest.slice(0, 2)}/${digest}`;
};

export const artifactPublicationTemporaryFilename = (
  uploadId: string,
  finalizationId: string,
): string =>
  `.publish-${requireArtifactUploadId(uploadId)}-${requireArtifactOperationId(
    finalizationId,
    "Artifact finalization ID",
  )}.tmp`;

export const joinContainedArtifactPath = (
  rootPath: string,
  parentPath: string,
  serverGeneratedName: string,
): string => {
  if (
    serverGeneratedName.length === 0 ||
    serverGeneratedName === "." ||
    serverGeneratedName === ".." ||
    serverGeneratedName.includes("/") ||
    serverGeneratedName.includes("\\")
  ) {
    throw new TypeError("Artifact storage names must be single Server-generated path segments.");
  }

  const resolvedRoot = resolve(rootPath);
  const resolvedParent = resolve(parentPath);
  const path = resolve(join(resolvedParent, serverGeneratedName));
  const rootRelative = relative(resolvedRoot, path);
  const parentRelative = relative(resolvedParent, path);
  if (
    rootRelative === "" ||
    rootRelative === ".." ||
    rootRelative.startsWith(`..${sep}`) ||
    parentRelative === "" ||
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    rootRelative.includes(":")
  ) {
    throw new TypeError("Artifact storage path escaped its bound root.");
  }
  return path;
};
