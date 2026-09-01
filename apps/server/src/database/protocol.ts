import type {
  DashboardJobListQuery,
  DashboardJobListResponse,
  DashboardSystemRead,
  DashboardWorkerListQuery,
  DashboardWorkerListResponse,
  DashboardWorkItemListQuery,
  DashboardWorkItemListResponse,
  JobExecutionEnvelope,
  JobExecutionTemplate,
  NormalizedSchedulingEvent,
  RunTerminalResponse,
  SelfOrAllowlistPolicy,
  WorkerState,
} from "@agentic-review/contracts";
import type {
  GitHubPollingActiveProjection,
  GitHubPollingProjectionKey,
} from "../github/poller.js";
import type {
  BeginOperatorLoginInput,
  BeginOperatorLoginResult,
  ClaimOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorBrowserFlowInput,
  DeleteOperatorSessionInput,
  FinalizeOperatorLoginInput,
  FindOperatorSessionInput,
  OperatorSession,
} from "../security/operator-auth.js";
import type {
  CommitGitHubPollingReconciliationInput,
  CommitGitHubPollingReconciliationResult,
  WriteGitHubPollingProjectionInput,
} from "./github-polling-state.js";
import type {
  CleanupExpiredOperatorAuthInput,
  CleanupExpiredOperatorAuthResult,
} from "./operator-auth.js";
import type {
  CommitArtifactChunkInput,
  CommitArtifactChunkResult,
  CommitArtifactFinalizeInput,
  CommitArtifactFinalizeResult,
  CreateArtifactUploadInput,
  CreateArtifactUploadResult,
  PrepareArtifactChunkInput,
  PrepareArtifactChunkResult,
  PrepareArtifactFinalizeInput,
  PrepareArtifactFinalizeResult,
  ProbeArtifactUploadCreateResult,
  TerminateArtifactUploadInput,
  TerminateArtifactUploadResult,
} from "./artifacts.js";

export interface DatabaseWorkerOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
}

export interface RegisterWorkerInput {
  readonly protocolVersion: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly displayName: string;
  readonly workerVersion: string;
  readonly maxSlots: number;
  readonly capabilities: unknown;
}

export interface RegisteredWorker {
  readonly workerId: string;
  readonly status: WorkerState;
  readonly capabilitiesDigest: string;
}

export interface HeartbeatWorkerInput {
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly heartbeatSequence: number;
  readonly availableSlots: number;
  readonly health: unknown;
}

export interface ClaimLeaseInput {
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly availableSlots: number;
  readonly capabilitiesDigest: string;
  readonly protocolVersion: string;
  readonly leaseTtlSeconds: number;
}

export type ClaimLeaseResult =
  | { readonly outcome: "granted"; readonly envelope: JobExecutionEnvelope }
  | { readonly outcome: "no_work"; readonly retryAfterMs: number }
  | {
      readonly outcome: "worker_unavailable";
      readonly reason:
        | "not_registered"
        | "not_online"
        | "draining"
        | "disabled"
        | "upgrade_required"
        | "capabilities_changed"
        | "no_available_slots";
      readonly retryAfterMs?: number;
    };

export interface HeartbeatLeaseInput {
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly phase: string;
  readonly progressSequence: number;
  readonly progress: unknown;
  readonly leaseTtlSeconds: number;
}

export interface HeartbeatLeaseResult {
  readonly leaseExpiresAt: string;
  readonly command: "continue" | "cancel" | "stale" | "drain";
}

export interface LeaseCompletionInput {
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly resultDigest: string;
  readonly result: unknown;
}

export interface LeaseFailureInput {
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly failureCode: string;
  readonly failureMessage: string;
  readonly retryable: boolean;
  readonly retryDelaySeconds: number;
}

export type LeaseTerminalResult = RunTerminalResponse;

export interface ReapExpiredLeasesInput {
  readonly retryDelaySeconds: number;
  readonly workerOfflineAfterSeconds: number;
}

export interface DatabaseHealth {
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
}

export interface ScheduleJobInput {
  readonly jobKind: "issue_triage" | "pull_request_review";
  readonly priority: number;
  readonly intentVersion: number;
  readonly maxAttempts: number;
  readonly executionTemplate: JobExecutionTemplate;
  readonly requiredCapabilities: unknown;
}

export interface WebhookDeliveryInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadSha256: string;
  readonly receivedAt: string;
}

export interface IngestSchedulingEventInput {
  readonly event: NormalizedSchedulingEvent;
  readonly policy: SelfOrAllowlistPolicy;
  readonly delivery: WebhookDeliveryInput | null;
  readonly schedule: ScheduleJobInput | null;
}

export interface IngestSchedulingEventResult {
  readonly outcome: "processed" | "duplicate";
  readonly eventId: string;
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly workItemProjected: boolean;
  readonly authorizationDecisionIds: readonly string[];
  readonly authorized: boolean;
  readonly activeRequestEpochIds: readonly string[];
  readonly openedRequestEpochId: string | null;
  readonly closedRequestEpochIds: readonly string[];
  readonly jobId: string | null;
  readonly jobCreated: boolean;
  readonly staleJobCount: number;
  readonly cancelRequestedJobCount: number;
}

export interface DatabaseOperationMap {
  readonly ping: {
    readonly input: Record<string, never>;
    readonly output: DatabaseHealth;
  };
  readonly registerWorker: {
    readonly input: RegisterWorkerInput;
    readonly output: RegisteredWorker;
  };
  readonly heartbeatWorker: {
    readonly input: HeartbeatWorkerInput;
    readonly output: { readonly state: WorkerState };
  };
  readonly claimLease: {
    readonly input: ClaimLeaseInput;
    readonly output: ClaimLeaseResult;
  };
  readonly heartbeatLease: {
    readonly input: HeartbeatLeaseInput;
    readonly output: HeartbeatLeaseResult;
  };
  readonly createArtifactUpload: {
    readonly input: CreateArtifactUploadInput;
    readonly output: CreateArtifactUploadResult;
  };
  readonly probeArtifactUploadCreate: {
    readonly input: CreateArtifactUploadInput;
    readonly output: ProbeArtifactUploadCreateResult;
  };
  readonly prepareArtifactChunk: {
    readonly input: PrepareArtifactChunkInput;
    readonly output: PrepareArtifactChunkResult;
  };
  readonly commitArtifactChunk: {
    readonly input: CommitArtifactChunkInput;
    readonly output: CommitArtifactChunkResult;
  };
  readonly prepareArtifactFinalize: {
    readonly input: PrepareArtifactFinalizeInput;
    readonly output: PrepareArtifactFinalizeResult;
  };
  readonly commitArtifactFinalize: {
    readonly input: CommitArtifactFinalizeInput;
    readonly output: CommitArtifactFinalizeResult;
  };
  readonly terminateArtifactUpload: {
    readonly input: TerminateArtifactUploadInput;
    readonly output: TerminateArtifactUploadResult;
  };
  readonly completeLease: {
    readonly input: LeaseCompletionInput;
    readonly output: LeaseTerminalResult;
  };
  readonly failLease: {
    readonly input: LeaseFailureInput;
    readonly output: LeaseTerminalResult;
  };
  readonly reapExpiredLeases: {
    readonly input: ReapExpiredLeasesInput;
    readonly output: { readonly expiredCount: number };
  };
  readonly ingestSchedulingEvent: {
    readonly input: IngestSchedulingEventInput;
    readonly output: IngestSchedulingEventResult;
  };
  readonly listWorkItems: {
    readonly input: DashboardWorkItemListQuery;
    readonly output: DashboardWorkItemListResponse;
  };
  readonly listJobs: {
    readonly input: DashboardJobListQuery;
    readonly output: DashboardJobListResponse;
  };
  readonly listWorkers: {
    readonly input: DashboardWorkerListQuery;
    readonly output: DashboardWorkerListResponse;
  };
  readonly getSystemSnapshot: {
    readonly input: Record<string, never>;
    readonly output: DashboardSystemRead;
  };
  readonly beginOperatorLogin: {
    readonly input: BeginOperatorLoginInput;
    readonly output: BeginOperatorLoginResult;
  };
  readonly claimOperatorLoginTransaction: {
    readonly input: ClaimOperatorLoginTransactionInput;
    readonly output: { readonly browserGeneration: number | null };
  };
  readonly finalizeOperatorLogin: {
    readonly input: FinalizeOperatorLoginInput;
    readonly output: { readonly finalized: boolean };
  };
  readonly createOperatorSession: {
    readonly input: CreateOperatorSessionInput;
    readonly output: { readonly created: true };
  };
  readonly findOperatorSession: {
    readonly input: FindOperatorSessionInput;
    readonly output: { readonly session: OperatorSession | null };
  };
  readonly deleteOperatorSession: {
    readonly input: DeleteOperatorSessionInput;
    readonly output: { readonly deleted: boolean };
  };
  readonly deleteOperatorBrowserFlow: {
    readonly input: DeleteOperatorBrowserFlowInput;
    readonly output: { readonly deleted: boolean };
  };
  readonly cleanupExpiredOperatorAuth: {
    readonly input: CleanupExpiredOperatorAuthInput;
    readonly output: CleanupExpiredOperatorAuthResult;
  };
  readonly readGitHubPollingProjection: {
    readonly input: GitHubPollingProjectionKey;
    readonly output: { readonly projection: GitHubPollingActiveProjection | null };
  };
  readonly writeGitHubPollingProjection: {
    readonly input: WriteGitHubPollingProjectionInput;
    readonly output: { readonly written: true };
  };
  readonly commitGitHubPollingReconciliation: {
    readonly input: CommitGitHubPollingReconciliationInput;
    readonly output: CommitGitHubPollingReconciliationResult;
  };
  readonly shutdown: {
    readonly input: Record<string, never>;
    readonly output: { readonly closed: true };
  };
}

export type DatabaseOperation = keyof DatabaseOperationMap;

export interface DatabaseRequest<TOperation extends DatabaseOperation = DatabaseOperation> {
  readonly type: "request";
  readonly id: number;
  readonly operation: TOperation;
  readonly input: DatabaseOperationMap[TOperation]["input"];
}

export type DatabaseResponse =
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly code?: string;
      };
    };

export type DatabaseWorkerMessage =
  | DatabaseResponse
  | { readonly type: "ready" }
  | {
      readonly type: "fatal";
      readonly error: { readonly name: string; readonly message: string };
    };
