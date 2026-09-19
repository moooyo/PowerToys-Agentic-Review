import {
  emptyInvestigationTaskProgress,
  type InvestigationProgressRequest,
  type InvestigationTaskProgress,
} from "@agentic-review/contracts";
import type { InvestigationStore } from "./store.js";

interface ProgressRecord {
  readonly attemptId: string;
  readonly sequence: number;
  readonly progress: InvestigationTaskProgress;
  readonly closedAt?: string;
}
const key = (taskId: string) => `task-progress:${taskId}`;

export function investigationTaskProgress(
  store: InvestigationStore,
  taskId: string,
): InvestigationTaskProgress {
  return (
    store.get<ProgressRecord>("idempotency", key(taskId))?.progress ??
    emptyInvestigationTaskProgress()
  );
}

export function beginInvestigationProgress(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
): void {
  const previous = store.get<ProgressRecord>("idempotency", key(taskId));
  if (previous?.attemptId === attemptId) return;
  store.put<ProgressRecord>("idempotency", key(taskId), {
    attemptId,
    sequence: 0,
    progress: {
      ...emptyInvestigationTaskProgress(),
      lastMeaningfulProgressAt: previous?.progress.lastMeaningfulProgressAt ?? null,
      ...(previous?.progress.stageDurationsMs === undefined
        ? {}
        : {
            stageDurationsMs: previous.progress.stageDurationsMs,
          }),
    },
  });
}

export function recordInvestigationActivity(
  store: InvestigationStore,
  taskId: string,
  request: InvestigationProgressRequest,
  now: string,
): InvestigationTaskProgress {
  const previous = store.get<ProgressRecord>("idempotency", key(taskId));
  const progress = previous?.progress ?? emptyInvestigationTaskProgress();
  if (previous?.attemptId === request.lease.attemptId && previous.sequence >= request.sequence)
    return progress;
  if (previous?.attemptId === request.lease.attemptId && previous.closedAt !== undefined)
    return progress;
  const closed =
    previous?.attemptId === request.lease.attemptId && progress.stage !== request.stage
      ? closeRecordedStage(progress, now)
      : progress;
  const next: InvestigationTaskProgress = {
    ...closed,
    stage: request.stage,
    stageStartedAt:
      previous?.attemptId !== request.lease.attemptId || progress.stage !== request.stage
        ? now
        : (progress.stageStartedAt ?? now),
    lastActivityAt: now,
  };
  store.put<ProgressRecord>("idempotency", key(taskId), {
    attemptId: request.lease.attemptId,
    sequence: request.sequence,
    progress: next,
  });
  return next;
}

export function recordInvestigationHeartbeat(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
  now: string,
): void {
  updateServerProgress(store, taskId, attemptId, { lastHeartbeatAt: now });
}

export function recordMeaningfulInvestigationProgress(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
  now: string,
): void {
  updateServerProgress(store, taskId, attemptId, { lastMeaningfulProgressAt: now });
}

export function recordInvestigationCleanup(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
  now: string,
): void {
  const previous = store.get<ProgressRecord>("idempotency", key(taskId));
  // An old attempt's delayed cleanup cannot overwrite a resumed task's activity.
  if (previous?.attemptId !== attemptId) return;
  if (previous.closedAt !== undefined) return;
  store.put<ProgressRecord>("idempotency", key(taskId), {
    ...previous,
    closedAt: now,
    progress: { ...closeRecordedStage(previous.progress, now), lastActivityAt: now },
  });
}

function closeRecordedStage(
  progress: InvestigationTaskProgress,
  now: string,
): InvestigationTaskProgress {
  if (progress.stage === null || progress.stageStartedAt === null) return progress;
  const elapsed = Date.parse(now) - Date.parse(progress.stageStartedAt);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) return progress;
  const total = (progress.stageDurationsMs?.[progress.stage] ?? 0) + elapsed;
  if (!Number.isSafeInteger(total)) return progress;
  return {
    ...progress,
    stageDurationsMs: { ...progress.stageDurationsMs, [progress.stage]: total },
  };
}

function updateServerProgress(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
  changes: Partial<InvestigationTaskProgress>,
): void {
  const previous = store.get<ProgressRecord>("idempotency", key(taskId));
  store.put<ProgressRecord>("idempotency", key(taskId), {
    ...(previous?.attemptId === attemptId && previous.closedAt !== undefined
      ? { closedAt: previous.closedAt }
      : {}),
    attemptId,
    sequence: previous?.attemptId === attemptId ? previous.sequence : 0,
    progress: { ...(previous?.progress ?? emptyInvestigationTaskProgress()), ...changes },
  });
}
