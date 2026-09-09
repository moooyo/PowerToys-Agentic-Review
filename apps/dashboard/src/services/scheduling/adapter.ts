import type { SchedulingDiagnosticSubject, SchedulingDiagnostics } from "@agentic-review/contracts";

export type SchedulingReadScope =
  | Exclude<SchedulingDiagnosticSubject, { kind: "platform_job" }>
  | { readonly kind: "platform_job"; readonly jobId: string };

export interface SchedulingAdapter {
  readonly mode: "connected" | "sample";
  get(scope: SchedulingReadScope, signal?: AbortSignal): Promise<SchedulingDiagnostics>;
}
