import type { SchedulingDiagnostics } from "@agentic-review/contracts";
import type { SchedulingReadScope } from "./adapter";

export const repositoryScope = {
  kind: "repository_job",
  repositoryId: "repository:one",
  workItemId: "item:one",
  jobId: "job:one",
} satisfies SchedulingReadScope;
export const requestScope = {
  kind: "validation_request",
  repositoryId: "repository:one",
  workItemId: "item:one",
  reviewRunId: "run:one",
  requestId: "request:one",
} satisfies SchedulingReadScope;
export const platformScope = {
  kind: "platform_job",
  jobId: "job:one",
} satisfies SchedulingReadScope;
export const observation: SchedulingDiagnostics = {
  schemaVersion: "SchedulingDiagnosticsV3",
  observedAt: "2026-09-07T08:00:00.000Z",
  subject: repositoryScope,
  policy: {
    repository: {
      repositoryId: repositoryScope.repositoryId,
      version: 1,
      enabled: true,
      limits: { maxActiveLeases: null, maxQueuedJobs: null },
      usage: {
        activeLeases: 0,
        admittedQueuedJobs: 1,
        awaitingAdmissionJobs: 0,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 0, admittedQueuedJobs: 0 },
    },
    platform: {
      visibility: "restricted",
      version: 1,
      activeCapacity: "available",
      queueCapacity: "available",
    },
  },
  stage: "waiting",
  job: {
    jobId: "job:one",
    status: "queued",
    attemptCount: 0,
    admission: {
      state: "admitted",
      attemptBase: 0,
      requestedAt: "2026-09-07T07:00:00.000Z",
      timestampBasis: "recorded",
      admittedAt: "2026-09-07T07:00:00.000Z",
    },
    createdAt: "2026-09-07T07:00:00.000Z",
    nextAttemptAt: null,
  },
  workerInspection: { state: "complete", latestContactAt: "2026-09-07T07:59:00.000Z" },
  requirements: { names: ["ui:web"], truncated: false },
  reasons: [{ code: "worker_slots_occupied", effect: "claim_gate" }],
  reasonsTruncated: false,
};

export const platformObservation: SchedulingDiagnostics = {
  ...observation,
  subject: { ...platformScope, association: "unassociated_legacy" },
  policy: {
    repository: null,
    platform: {
      visibility: "full",
      configuration: {
        version: 1,
        limits: { maxActiveLeases: null, maxQueuedJobs: null },
        policyId: "repository-service-v1",
        updatedAt: "2026-09-07T07:00:00.000Z",
      },
      usage: {
        activeLeases: 0,
        admittedQueuedJobs: 1,
        awaitingAdmissionJobs: 0,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 0, admittedQueuedJobs: 0 },
    },
  },
};
