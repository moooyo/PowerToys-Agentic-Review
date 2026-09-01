export class ArtifactStorageIntegrityError extends Error {
  readonly code = "ARTIFACT_STORAGE_INTEGRITY";

  constructor(message = "Artifact storage integrity validation failed.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactStorageIntegrityError";
  }
}

export class ArtifactStorageCapacityError extends Error {
  readonly code = "ARTIFACT_STORAGE_CAPACITY";
  readonly retryable = true;

  constructor(message = "Artifact storage capacity is unavailable.") {
    super(message);
    this.name = "ArtifactStorageCapacityError";
  }
}

export class ArtifactStorageClosedError extends Error {
  readonly code = "ARTIFACT_STORAGE_CLOSED";

  constructor(message = "Artifact storage is not accepting new work.") {
    super(message);
    this.name = "ArtifactStorageClosedError";
  }
}

export class ArtifactStorageCloseTimeoutError extends Error {
  readonly code = "ARTIFACT_STORAGE_CLOSE_TIMEOUT";

  constructor(timeoutMilliseconds: number) {
    super(`Artifact storage did not become idle within ${timeoutMilliseconds} milliseconds.`);
    this.name = "ArtifactStorageCloseTimeoutError";
  }
}
