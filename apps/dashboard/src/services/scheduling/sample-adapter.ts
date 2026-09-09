import type { SchedulingDiagnostics } from "@agentic-review/contracts";
import { ReviewControlUnsupportedOperationError } from "../review-control/errors";
import type { SchedulingAdapter, SchedulingReadScope } from "./adapter";

export class SampleSchedulingAdapter implements SchedulingAdapter {
  readonly mode = "sample" as const;
  async get(_scope: SchedulingReadScope, signal?: AbortSignal): Promise<SchedulingDiagnostics> {
    signal?.throwIfAborted();
    throw new ReviewControlUnsupportedOperationError(
      "read live scheduling diagnostics in Sample mode",
    );
  }
}
