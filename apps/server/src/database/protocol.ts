import type {
  DashboardHealthComponent,
  DashboardJobDetailRead,
  DashboardJobListQuery,
  DashboardJobListResponse,
  DashboardJobReadQuery,
  DashboardSystemRead,
  DashboardWorkerListQuery,
  DashboardWorkerListResponse,
  DashboardWorkItemListQuery,
  DashboardWorkItemListResponse,
  JobExecutionEnvelope,
  JobExecutionTemplate,
  NormalizedSchedulingEvent,
  OperatorPrincipal,
  OperatorRepositoryPermission,
  RunFailureDiagnostics,
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
import type { ConfigurationAuditOperationMap } from "./configuration-audit.js";
import type { EvaluationAdjudicationOperationMap } from "./evaluation-adjudication.js";
import type { EvaluationAssessmentOperationMap } from "./evaluation-assessments.js";
import type { EvaluationEvidenceOperationMap } from "./evaluation-evidence.js";
import type { EvaluationManagementOperationMap } from "./evaluation-management.js";
import type { EvaluationModelInvocationOperationMap } from "./evaluation-model-invocations.js";
import type { EvaluationBatchOperationMap } from "./evaluation-queries.js";
import type { EvaluationReproductionOperationMap } from "./evaluation-reproduction.js";
import type { EvaluationResultOperationMap } from "./evaluation-results.js";
import type { EvidenceAssetOperationMap, EvidenceStorageOptions } from "./evidence-assets.js";
import type { FindingDispositionOperationMap } from "./finding-dispositions.js";
import type {
  CommitGitHubPollingReconciliationInput,
  CommitGitHubPollingReconciliationResult,
  WriteGitHubPollingProjectionInput,
} from "./github-polling-state.js";
import type { RepositoryOperationMap } from "./managed-repositories.js";
import type { ModelInvocationOperationMap } from "./model-invocations.js";
import type { ModelRuntimeRegistryOperationMap } from "./model-runtime-registry.js";
import type { NotificationOperationMap } from "./notifications.js";
import type { OperatorAccessOperationMap } from "./operator-access.js";
import type {
  CleanupExpiredOperatorAuthInput,
  CleanupExpiredOperatorAuthResult,
  PurgeOperatorAuthForRecoveryResult,
} from "./operator-auth.js";
import type { OperatorRequestInput } from "./operator-request.js";
import type { OperatorReviewRunOperationMap } from "./operator-review-runs.js";
import type { PromptConfigurationOperationMap } from "./prompt-configuration.js";
import type { PublicationOperationMap } from "./publications.js";
import type { ReviewRunDecisionOperationMap } from "./review-run-decisions.js";
import type { ReviewRunQueryOperationMap } from "./review-run-queries.js";
import type { ReviewRunOperationMap } from "./review-runs.js";
import type { SchedulingConfigurationOperationMap } from "./scheduling-configuration.js";
import type { SchedulingDiagnosticsOperationMap } from "./scheduling-diagnostics.js";
import type { ValidationDispatchOperationMap } from "./validation-dispatch.js";
import type { ValidationSummaryInputOperationMap } from "./validation-summary-inputs.js";
export interface DatabaseWorkerOptions {
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly startupTimeoutMilliseconds?: number;
  readonly evidenceStorage?: EvidenceStorageOptions;
  // The owner enforces recovery restrictions after checking exact evaluation mutation replays.
  readonly recoveryMaintenance?: boolean;
  // Trusted server configuration; never supplied by an Operator HTTP body or session claims.
  readonly operatorAccess?: { readonly administrators: readonly OperatorPrincipal[] };
  // Publisher identity is public configuration. Its delivery credential never enters the owner.
  readonly publicationPublisher?: { readonly githubUserId: number };
}

export interface RegisterWorkerInput {
  readonly protocolVersion: string;
  readonly workerNodeId: string;
  readonly workerTokenSha256: string;
  readonly workerInstanceId: string;
  readonly displayName: string;
  readonly workerVersion: string;
  readonly maxSlots: number;
  readonly capabilities: unknown;
}

export type WorkerNodeAuthState = "pending" | "active" | "revoked";

export interface CreateWorkerNodeCredentialInput {
  readonly workerNodeId: string;
  readonly displayName: string;
  readonly workerTokenSha256: string;
  readonly createdByIssuer: string;
  readonly createdBySubject: string;
}

export interface AuthenticateWorkerTokenInput {
  readonly workerTokenSha256: string;
}

export interface ListWorkerNodeCredentialsInput {
  readonly offset: number;
  readonly limit: number;
  readonly sort?: "identity";
}

export type AuthenticateWorkerTokenResult =
  | {
      readonly outcome: "authenticated";
      readonly workerNodeId: string;
      readonly authState: Exclude<WorkerNodeAuthState, "revoked">;
    }
  | { readonly outcome: "invalid" };

export interface RotateWorkerTokenInput {
  readonly workerNodeId: string;
  readonly workerTokenSha256: string;
  readonly expectedUpdatedAt: string;
  readonly rotatedByIssuer: string;
  readonly rotatedBySubject: string;
}

export interface RevokeWorkerTokenInput {
  readonly workerNodeId: string;
  readonly revokedByIssuer: string;
  readonly revokedBySubject: string;
}

export interface WorkerNodeCredentialMutationResult {
  readonly workerNodeId: string;
  readonly authState: WorkerNodeAuthState;
}

export interface WorkerNodeCredentialListItem {
  readonly workerNodeId: string;
  readonly displayName: string;
  readonly authState: WorkerNodeAuthState;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string;
}

export interface WorkerNodeCredentialListResult {
  readonly items: readonly WorkerNodeCredentialListItem[];
  readonly total: number;
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
  readonly diagnostics?: RunFailureDiagnostics;
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
  readonly allowScheduling?: boolean;
  readonly event: NormalizedSchedulingEvent;
  readonly policy: SelfOrAllowlistPolicy;
  readonly delivery: WebhookDeliveryInput | null;
  readonly schedule: ScheduleJobInput | null;
}

export interface IngestSchedulingEventResult {
  readonly schedulingSuppressed?: boolean;
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

export interface DatabaseOperationMap
  extends RepositoryOperationMap,
    PromptConfigurationOperationMap,
    ReviewRunOperationMap,
    OperatorReviewRunOperationMap,
    ReviewRunQueryOperationMap,
    ConfigurationAuditOperationMap,
    ValidationDispatchOperationMap,
    EvidenceAssetOperationMap,
    OperatorAccessOperationMap,
    ReviewRunDecisionOperationMap,
    FindingDispositionOperationMap,
    SchedulingDiagnosticsOperationMap,
    SchedulingConfigurationOperationMap,
    PublicationOperationMap,
    NotificationOperationMap,
    EvaluationManagementOperationMap,
    EvaluationBatchOperationMap,
    EvaluationReproductionOperationMap,
    EvaluationResultOperationMap,
    EvaluationEvidenceOperationMap,
    EvaluationAdjudicationOperationMap,
    EvaluationAssessmentOperationMap,
    ModelRuntimeRegistryOperationMap,
    EvaluationModelInvocationOperationMap,
    ModelInvocationOperationMap,
    ValidationSummaryInputOperationMap {
  readonly admitPendingJobs: {
    readonly input: { readonly limit?: number };
    readonly output: { readonly examinedJobCount: number; readonly admittedJobCount: number };
  };
  readonly operatorRequest: {
    readonly input: OperatorRequestInput;
    readonly output: unknown;
  };
  readonly operatorCheckPermission: {
    readonly input: {
      readonly repositoryId?: string;
      readonly permission?: OperatorRepositoryPermission;
    };
    readonly output: { readonly authorized: true };
  };
  readonly ping: {
    readonly input: Record<string, never>;
    readonly output: DatabaseHealth;
  };
  readonly registerWorker: {
    readonly input: RegisterWorkerInput;
    readonly output: RegisteredWorker;
  };
  readonly createWorkerNodeCredential: {
    readonly input: CreateWorkerNodeCredentialInput;
    readonly output: WorkerNodeCredentialMutationResult & { readonly authState: "pending" };
  };
  readonly authenticateWorkerToken: {
    readonly input: AuthenticateWorkerTokenInput;
    readonly output: AuthenticateWorkerTokenResult;
  };
  readonly listWorkerNodeCredentials: {
    readonly input: ListWorkerNodeCredentialsInput;
    readonly output: WorkerNodeCredentialListResult;
  };
  readonly rotateWorkerToken: {
    readonly input: RotateWorkerTokenInput;
    readonly output: WorkerNodeCredentialMutationResult & {
      readonly authState: Exclude<WorkerNodeAuthState, "revoked">;
    };
  };
  readonly revokeWorkerToken: {
    readonly input: RevokeWorkerTokenInput;
    readonly output: WorkerNodeCredentialMutationResult & { readonly authState: "revoked" };
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
  readonly getJob: {
    readonly input: DashboardJobReadQuery;
    readonly output: DashboardJobDetailRead | null;
  };
  readonly listWorkers: {
    readonly input: DashboardWorkerListQuery;
    readonly output: DashboardWorkerListResponse;
  };
  readonly getSystemSnapshot: {
    readonly input: { readonly githubHealth?: DashboardHealthComponent };
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
  readonly purgeOperatorAuthForRecovery: {
    readonly input: Record<string, never>;
    readonly output: PurgeOperatorAuthForRecoveryResult;
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
      readonly error: { readonly name: string; readonly message: string; readonly code?: string };
    };
