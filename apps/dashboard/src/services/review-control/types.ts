import type {
  DashboardRequestEpochSummary,
  ExecutionPhase,
  JobAdmission,
  JobState,
  ReviewExecutionEvidence,
  RunFailureDiagnostics,
  VerificationReport,
  WorkerState,
  WorkItemState,
} from "@agentic-review/contracts";

export type WorkItemKind = "pull_request" | "issue";
export type TriggerKind = "assigned" | "review_requested" | "not_requested";
export type AuthorizationKind = "self" | "allowlisted" | "denied" | "pending";
export type WorkItemStage =
  | "not_scheduled"
  | "awaiting_admission"
  | "queued"
  | "preparing"
  | "reviewing"
  | "validating"
  | "waiting_approval"
  | "publishing"
  | "done";
export type JobStage = "queued" | "awaiting_admission" | ExecutionPhase | "done";
export type JobStatus = JobState;

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  filters?: Record<string, string | string[] | undefined>;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface WorkItem {
  id: string;
  repositoryId: string;
  revisionKey: string;
  activeRequestEpoch: DashboardRequestEpochSummary | null;
  kind: WorkItemKind;
  repository: string;
  number: number;
  title: string;
  author: string;
  githubUrl: string;
  trigger: TriggerKind;
  scheduledBy: string;
  authorization: AuthorizationKind;
  priority: "urgent" | "high" | "normal" | "low";
  state: WorkItemState;
  stage: WorkItemStage;
  freshness: "current" | "superseded";
  latestJobId?: string;
  latestJobStatus?: JobStatus;
  latestJobAttemptCount: number | null;
  latestJobAdmission: JobAdmission | null;
  headSha?: string;
  reviewedSha?: string;
  workerNodeId?: string;
  attentionReason?: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  repositoryId: string;
  workItemId: string;
  workItemRef: string;
  title: string;
  generation: number;
  status: JobStatus;
  admission: JobAdmission | null;
  stage: JobStage;
  attempt: number;
  maxAttempts: number;
  workerNodeId?: string;
  leaseGeneration?: number;
  leaseExpiresAt?: string;
  progressUpdatedAt?: string;
  elapsedSeconds: number;
  targetSha?: string;
  outcome?: "success" | "failed" | "cancelled" | "timed_out";
  createdAt: string;
}

export interface PrReviewFinding {
  findingId: string;
  ordinal: number;
  priority: 0 | 1 | 2 | 3;
  title: string;
  body: string;
  path: string;
  line: number;
  endLine: number | null;
  confidence: number;
}

export interface IssueDuplicateCandidate {
  number: number;
  reason: string;
}

export interface JobReviewResult {
  reviewResultId: string;
  schemaId: "IssueTriageV1" | "PrReviewPlanV1" | "IssueTriageV2" | "PrReviewPlanV2";
  resultDigest: string;
  summary: string;
  requestedRecipeIds: string[];
  createdAt: string;
  verification?: VerificationReport;
  executionEvidence?: ReviewExecutionEvidence;
  prReview: {
    assessment: "approve" | "comment" | "request_changes";
    findings: PrReviewFinding[];
  } | null;
  issueTriage: {
    category: "bug" | "feature_request" | "documentation" | "question" | "support" | "other";
    priority: 0 | 1 | 2 | 3;
    confidence: number;
    suggestedLabels: string[];
    missingInformation: string[];
    duplicateCandidates: IssueDuplicateCandidate[];
  } | null;
}

export interface JobDetails extends Job {
  updatedAt: string;
  failureCode: string | null;
  failureMessage: string | null;
  failureDiagnostics?: RunFailureDiagnostics | null;
  resultDigest: string | null;
  reviewResult: JobReviewResult | null;
}

export interface WorkerNode {
  id: string;
  serverId: string;
  displayName: string;
  instanceId: string;
  status: WorkerState;
  version: string;
  location: string;
  activeSlots: number;
  maxSlots: number;
  capabilities: string[];
  currentJobs: string[];
  lastHeartbeatAt: string;
  diskFreeGb: number;
}

export type WorkerCredentialAuthState = "pending" | "active" | "revoked";

export interface WorkerCredential {
  workerNodeId: string;
  displayName: string;
  authState: WorkerCredentialAuthState;
  createdAt: string;
  activatedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

export interface WorkerCredentialSecret {
  workerNodeId: string;
  authState: Exclude<WorkerCredentialAuthState, "revoked">;
  token: string;
}

export interface WorkerCredentialRevocation {
  workerNodeId: string;
  authState: "revoked";
}

export interface Approval {
  id: string;
  workItemRef: string;
  kind: "validation" | "publication";
  summary: string;
  targetSha: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface Publication {
  id: string;
  workItemRef: string;
  kind: "issue_comment" | "pull_request_review" | "check_run";
  status: "ready" | "pending" | "published" | "failed" | "unknown";
  targetSha?: string;
  attempts: number;
  lastError?: string;
  remoteUrl?: string;
  updatedAt: string;
}

export interface HealthComponent {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "unavailable";
  summary: string;
  checkedAt: string;
}

export interface SystemSnapshot {
  serverVersion: string;
  protocolVersion: string;
  nodeVersion: string;
  sqliteVersion: string;
  databaseSizeMb: number;
  oldestQueuedAt?: string;
  oldestAwaitingAdmissionAt?: string;
  queuedJobs: number;
  awaitingAdmissionJobs: number;
  pendingValidationRequests: number;
  activeWorkers: number;
  activeLeases: number;
  pendingApprovals: number;
  health: HealthComponent[];
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
}
