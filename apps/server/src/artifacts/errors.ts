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

export type ArtifactStorageClientErrorCode =
  | "ARTIFACT_STORAGE_CAPACITY"
  | "ARTIFACT_STORAGE_CLIENT_BUSY"
  | "ARTIFACT_STORAGE_CLIENT_PROTOCOL"
  | "ARTIFACT_STORAGE_CLIENT_TERMINAL"
  | "ARTIFACT_STORAGE_CLIENT_TIMEOUT"
  | "ARTIFACT_STORAGE_CLOSED"
  | "ARTIFACT_STORAGE_CLOSE_TIMEOUT"
  | "ARTIFACT_STORAGE_INTEGRITY"
  | "ARTIFACT_STORAGE_INTERNAL"
  | "ARTIFACT_STORAGE_INVALID_REQUEST"
  | "ARTIFACT_STORAGE_IO_FAILURE"
  | "ARTIFACT_STORAGE_REQUEST_ID_EXHAUSTED"
  | "ARTIFACT_STORAGE_WORKER_EXIT";

export class ArtifactStorageClientError extends Error {
  readonly code: ArtifactStorageClientErrorCode;
  readonly retryable: boolean;
  readonly ownerExit: Promise<number> | undefined;

  constructor(
    code: ArtifactStorageClientErrorCode,
    message: string,
    retryable = false,
    ownerExit?: Promise<number>,
  ) {
    super(message);
    this.name = "ArtifactStorageClientError";
    this.code = code;
    this.retryable = retryable;
    this.ownerExit = ownerExit;
  }
}
