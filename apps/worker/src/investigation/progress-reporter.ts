import type {
  InvestigationProgressStage,
  InvestigationWorkerLease,
} from "@agentic-review/contracts";
import type { InvestigationWorkerClient } from "./http-client.js";
import type { ModelActivityObservation } from "./model-progress.js";

/** Progress delivery is bounded, ordered, and independent of task correctness or lease renewal. */
export function createInvestigationProgressReporter(options: {
  readonly client: Pick<InvestigationWorkerClient, "progress">;
  readonly taskId: string;
  readonly lease: InvestigationWorkerLease;
  readonly now?: () => number;
  readonly onFailure?: () => void;
}) {
  let sequence = 0;
  let currentStage: InvestigationProgressStage = "prepare_source";
  let pending = Promise.resolve();
  let activityPending = false;
  let lastActivity = Number.NEGATIVE_INFINITY;
  const now = options.now ?? Date.now;
  const send = (
    stage: InvestigationProgressStage,
    kind: "stage" | "activity",
    signal?: AbortSignal,
  ) => {
    const request = { lease: options.lease, sequence: ++sequence, kind, stage };
    pending = pending.then(async () => {
      try {
        await options.client.progress?.(options.taskId, request, signal);
      } catch {
        try {
          options.onFailure?.();
        } catch {
          /* Telemetry cannot change task execution. */
        }
      }
    });
    return pending;
  };
  return {
    reportProgress(stage: InvestigationProgressStage, signal?: AbortSignal): Promise<void> {
      currentStage = stage;
      return send(stage, "stage", signal);
    },
    onActivity(_observation: ModelActivityObservation): void {
      const observedAt = now();
      if (activityPending || observedAt - lastActivity < 1_000) return;
      lastActivity = observedAt;
      activityPending = true;
      void send(currentStage, "activity").finally(() => {
        activityPending = false;
      });
    },
    flush(): Promise<void> {
      return pending;
    },
  };
}
