export class DatabaseRequestError extends Error {
  public readonly code: string | undefined;

  public constructor(message: string, code?: string) {
    super(message);
    this.name = "DatabaseRequestError";
    this.code = code;
  }
}

export class LeaseLostError extends Error {
  public readonly code = "LEASE_LOST";

  public constructor() {
    super("The lease is expired, superseded, or owned by another worker.");
    this.name = "LeaseLostError";
  }
}

export class ResultDigestMismatchError extends Error {
  public readonly code = "RESULT_DIGEST_MISMATCH";

  public constructor() {
    super("The submitted result digest does not match the canonical result payload.");
    this.name = "ResultDigestMismatchError";
  }
}

export class ReviewResultInvalidError extends Error {
  public readonly code = "REVIEW_RESULT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "ReviewResultInvalidError";
  }
}

export class StoredExecutionTemplateInvalidError extends Error {
  public readonly code = "STORED_EXECUTION_TEMPLATE_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "StoredExecutionTemplateInvalidError";
  }
}

export class TerminalSubmissionConflictError extends Error {
  public readonly code = "TERMINAL_SUBMISSION_CONFLICT";

  public constructor() {
    super("The run attempt already has a different terminal submission.");
    this.name = "TerminalSubmissionConflictError";
  }
}

export class ArtifactUploadConflictError extends Error {
  public readonly code = "ARTIFACT_UPLOAD_CONFLICT";

  public constructor(message = "The artifact upload already has different immutable state.") {
    super(message);
    this.name = "ArtifactUploadConflictError";
  }
}

export class ArtifactUploadQuotaExceededError extends Error {
  public readonly code = "ARTIFACT_UPLOAD_QUOTA_EXCEEDED";

  public constructor(message: string) {
    super(message);
    this.name = "ArtifactUploadQuotaExceededError";
  }
}

export class ArtifactCompletionModeMismatchError extends Error {
  public readonly code = "ARTIFACT_COMPLETION_MODE_MISMATCH";

  public constructor() {
    super("The run attempt does not permit result artifact operations.");
    this.name = "ArtifactCompletionModeMismatchError";
  }
}

export class ArtifactReconciliationInvalidRequestError extends Error {
  public readonly code = "ARTIFACT_RECONCILIATION_INVALID_REQUEST";

  public constructor() {
    super("The artifact reconciliation request is invalid.");
    this.name = "ArtifactReconciliationInvalidRequestError";
  }
}

export class ArtifactReconciliationConflictError extends Error {
  public readonly code = "ARTIFACT_RECONCILIATION_CONFLICT";

  public constructor() {
    super("The artifact reconciliation state changed before the operation could commit.");
    this.name = "ArtifactReconciliationConflictError";
  }
}

export class ArtifactReconciliationStateError extends Error {
  public readonly code = "ARTIFACT_RECONCILIATION_STATE_INVALID";

  public constructor() {
    super("The durable artifact reconciliation state is invalid.");
    this.name = "ArtifactReconciliationStateError";
  }
}

export class WorkerUnavailableError extends Error {
  public readonly code = "WORKER_UNAVAILABLE";

  public constructor() {
    super("The worker instance is not registered or is no longer active.");
    this.name = "WorkerUnavailableError";
  }
}

export class WorkerInstanceSupersededError extends Error {
  public readonly code = "WORKER_INSTANCE_SUPERSEDED";

  public constructor() {
    super("The worker process instance was superseded by a newer registration.");
    this.name = "WorkerInstanceSupersededError";
  }
}

export class WebhookDeliveryConflictError extends Error {
  public readonly code = "WEBHOOK_DELIVERY_CONFLICT";

  public constructor() {
    super("The GitHub delivery identifier was already recorded with a different payload digest.");
    this.name = "WebhookDeliveryConflictError";
  }
}

export class NormalizedEventConflictError extends Error {
  public readonly code = "NORMALIZED_EVENT_CONFLICT";

  public constructor() {
    super("The normalized GitHub event key was already recorded with different event data.");
    this.name = "NormalizedEventConflictError";
  }
}

export class GitHubIngestionInvariantError extends Error {
  public readonly code = "GITHUB_INGESTION_INVARIANT_VIOLATION";

  public constructor(message: string) {
    super(message);
    this.name = "GitHubIngestionInvariantError";
  }
}
