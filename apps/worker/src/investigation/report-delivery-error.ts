import type { InvestigationReportDeliveryFailure } from "@agentic-review/contracts";
import { InvestigationWorkerClientError } from "./http-client.js";
import { InvestigationReportBuildError } from "./report-builder.js";

export type { InvestigationReportDeliveryFailure } from "@agentic-review/contracts";

const genericFailure: InvestigationReportDeliveryFailure = {
  code: "REPORT_DELIVERY_FAILED",
  retryable: false,
};

function boundedFailure(
  failure: InvestigationReportDeliveryFailure,
): InvestigationReportDeliveryFailure {
  return failure.code.length > 0 &&
    failure.code.length <= 128 &&
    !/[^A-Za-z0-9_.:-]/u.test(failure.code)
    ? { code: failure.code, retryable: failure.retryable }
    : { ...genericFailure };
}

/** Report diagnostics never include response bodies, model output, or arbitrary exception text. */
export function getInvestigationReportDeliveryFailure(
  error: unknown,
): InvestigationReportDeliveryFailure {
  if (error instanceof InvestigationWorkerClientError)
    return boundedFailure({ code: error.code, retryable: error.retryable });
  if (error instanceof InvestigationReportBuildError)
    return boundedFailure({ code: error.code, retryable: false });
  return { ...genericFailure };
}

/** Only the coordinator may isolate delivery after local cleanup and the Server acknowledgement. */
export class IsolatedInvestigationReportDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  public constructor(failure: InvestigationReportDeliveryFailure) {
    super("Investigation report delivery failed after confirmed cleanup.");
    this.name = "IsolatedInvestigationReportDeliveryError";
    const bounded = boundedFailure(failure);
    this.code = bounded.code;
    this.retryable = bounded.retryable;
  }
}
