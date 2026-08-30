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

export class TerminalSubmissionConflictError extends Error {
  public readonly code = "TERMINAL_SUBMISSION_CONFLICT";

  public constructor() {
    super("The run attempt already has a different terminal submission.");
    this.name = "TerminalSubmissionConflictError";
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
