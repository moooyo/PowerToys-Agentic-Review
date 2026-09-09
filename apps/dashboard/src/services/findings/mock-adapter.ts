import type {
  FindingDispositionChangeRequest,
  FindingOccurrenceRef,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import { ReviewControlError } from "../review-control/errors";
import type { FindingPageQuery, FindingScope, FindingsAdapter } from "./adapter";

function unavailable(operation: string): never {
  throw new ReviewControlError(
    "unsupported_operation",
    "Finding disposition and comparison are unavailable in explicit sample mode. Connect to the control plane to manage immutable finding results and their audit history.",
    { operation, retryable: false },
  );
}

// Existing sample result previews do not contain full immutable occurrence arrays or authority.
// Keep that limitation explicit instead of fabricating completed evidence or writable receipts.
export class MockFindingsAdapter implements FindingsAdapter {
  readonly mode = "sample" as const;

  async list(_scope: FindingScope, _query?: FindingPageQuery): Promise<never> {
    return unavailable("list finding occurrences");
  }

  async compare(
    _scope: FindingScope,
    _beforeScope: FindingScope,
    _query?: FindingPageQuery,
  ): Promise<never> {
    return unavailable("compare finding results");
  }

  async change(
    _scope: FindingScope,
    _occurrenceKey: string,
    _input: FindingDispositionChangeRequest,
    _actor: OperatorPrincipal,
  ): Promise<never> {
    return unavailable("change finding disposition");
  }

  async history(
    _scope: FindingScope,
    _occurrence: FindingOccurrenceRef,
    _query?: FindingPageQuery,
  ): Promise<never> {
    return unavailable("list finding disposition history");
  }
}
