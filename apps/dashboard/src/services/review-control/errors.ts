export type ReviewControlErrorCode =
  | "http_error"
  | "invalid_request"
  | "network_error"
  | "protocol_error"
  | "response_too_large"
  | "timeout"
  | "unsupported_operation";

interface ReviewControlErrorOptions {
  readonly cause?: unknown;
  readonly operation: string;
  readonly retryable: boolean;
}

export class ReviewControlError extends Error {
  readonly code: ReviewControlErrorCode;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(code: ReviewControlErrorCode, message: string, options: ReviewControlErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReviewControlError";
    this.code = code;
    this.operation = options.operation;
    this.retryable = options.retryable;
  }
}

export class ReviewControlHttpError extends ReviewControlError {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly serverCode: string | undefined;

  constructor(
    message: string,
    options: ReviewControlErrorOptions & {
      readonly requestId?: string;
      readonly serverCode?: string;
      readonly status: number;
    },
  ) {
    super("http_error", message, options);
    this.name = "ReviewControlHttpError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.serverCode = options.serverCode;
  }
}

export class ReviewControlNetworkError extends ReviewControlError {
  constructor(operation: string, cause: unknown) {
    super("network_error", `The ${operation} request could not reach the control plane.`, {
      cause,
      operation,
      retryable: true,
    });
    this.name = "ReviewControlNetworkError";
  }
}

export class ReviewControlProtocolError extends ReviewControlError {
  readonly path: string | undefined;

  constructor(operation: string, message: string, path?: string, cause?: unknown) {
    super("protocol_error", message, {
      cause,
      operation,
      retryable: false,
    });
    this.name = "ReviewControlProtocolError";
    this.path = path;
  }
}

export class ReviewControlRequestError extends ReviewControlError {
  readonly path: string;

  constructor(operation: string, path: string, message: string) {
    super("invalid_request", message, {
      operation,
      retryable: false,
    });
    this.name = "ReviewControlRequestError";
    this.path = path;
  }
}

export class ReviewControlResponseTooLargeError extends ReviewControlError {
  readonly maximumBytes: number;

  constructor(operation: string, maximumBytes: number) {
    super(
      "response_too_large",
      `The ${operation} response exceeded the ${maximumBytes}-byte safety limit.`,
      { operation, retryable: false },
    );
    this.name = "ReviewControlResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

export class ReviewControlTimeoutError extends ReviewControlError {
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super("timeout", `The ${operation} request exceeded its ${timeoutMs} ms deadline.`, {
      operation,
      retryable: true,
    });
    this.name = "ReviewControlTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ReviewControlUnsupportedOperationError extends ReviewControlError {
  constructor(operation: string) {
    super(
      "unsupported_operation",
      `The production control plane does not expose the ${operation} operation yet.`,
      { operation, retryable: false },
    );
    this.name = "ReviewControlUnsupportedOperationError";
  }
}
