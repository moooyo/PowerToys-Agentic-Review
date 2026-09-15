export class InvestigationRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationRequestError";
  }
}

export function requireCondition(
  condition: unknown,
  statusCode: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new InvestigationRequestError(statusCode, code, message);
}
