export class WorkerApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerApiError";
  }

  public get isLeaseLost(): boolean {
    return this.statusCode === 409 && this.errorCode === "lease_lost";
  }

  public get isWorkerRegistrationLost(): boolean {
    return (
      this.statusCode === 409 &&
      (this.errorCode === "worker_unavailable" ||
        this.errorCode === "not_registered" ||
        this.errorCode === "not_online")
    );
  }

  public get isWorkerInstanceSuperseded(): boolean {
    return this.statusCode === 409 && this.errorCode === "worker_instance_superseded";
  }

  public get isRetryable(): boolean {
    return (
      this.statusCode === undefined ||
      this.statusCode === 408 ||
      this.statusCode === 429 ||
      this.statusCode >= 500
    );
  }
}

export class ProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}
