import type { ExecutionPhase, JobState, WorkerState } from "@agentic-review/contracts";

export type WorkItemKind = "pull_request" | "issue";
export type TriggerKind = "assigned" | "review_requested" | "not_requested";
export type AuthorizationKind = "self" | "allowlisted" | "denied" | "pending";
export type WorkItemStage =
  | "queued"
  | "preparing"
  | "reviewing"
  | "validating"
  | "waiting_approval"
  | "publishing"
  | "done";
export type JobStage = "queued" | ExecutionPhase | "done";
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
  stage: WorkItemStage;
  freshness: "current" | "superseded";
  headSha?: string;
  reviewedSha?: string;
  workerNodeId?: string;
  attentionReason?: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  workItemId: string;
  workItemRef: string;
  title: string;
  generation: number;
  status: JobStatus;
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
  activeWorkers: number;
  activeLeases: number;
  pendingApprovals: number;
  health: HealthComponent[];
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
}
