import { maximumSchedulingDiagnosticsResponseUtf8Bytes } from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { SchedulingAdapter, SchedulingReadScope } from "./adapter";
import { readSchedulingDiagnostics, schedulingPath } from "./validation";

export class HttpSchedulingAdapter implements SchedulingAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }
  async get(scope: SchedulingReadScope, signal?: AbortSignal) {
    const frozen = structuredClone(scope);
    const path = schedulingPath(frozen);
    signal?.throwIfAborted();
    const response = await this.client.get(path, "read current scheduling diagnostics", {
      ...(signal === undefined ? {} : { signal }),
      maxResponseBytes: maximumSchedulingDiagnosticsResponseUtf8Bytes,
    });
    signal?.throwIfAborted();
    return readSchedulingDiagnostics(response, frozen);
  }
}
