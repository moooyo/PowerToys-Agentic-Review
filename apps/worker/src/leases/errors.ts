export class LeaseLostError extends Error {
  public constructor(
    message: string,
    public readonly reasonCode?: string,
  ) {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class ExecutionTimeoutError extends Error {
  public constructor(timeoutMilliseconds: number) {
    super(`Job execution exceeded its hard timeout of ${timeoutMilliseconds} ms.`);
    this.name = "ExecutionTimeoutError";
  }
}
