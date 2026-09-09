import type {
  Approval,
  ApprovalDecision,
  Job,
  JobDetails,
  ListQuery,
  PageResult,
  Publication,
  SystemSnapshot,
  WorkerCredential,
  WorkerCredentialRevocation,
  WorkerCredentialSecret,
  WorkerNode,
  WorkItem,
} from "./types";

export interface ReviewControlAdapter {
  listWorkItems(query?: ListQuery): Promise<PageResult<WorkItem>>;
  requeueWorkItem(workItemId: string): Promise<void>;
  listJobs(query?: ListQuery): Promise<PageResult<Job>>;
  getJob(jobId: string, signal?: AbortSignal): Promise<JobDetails | null>;
  cancelJob(jobId: string): Promise<void>;
  listWorkers(query?: ListQuery): Promise<PageResult<WorkerNode>>;
  listAllWorkers(): Promise<PageResult<WorkerNode>>;
  listWorkerCredentials(): Promise<PageResult<WorkerCredential>>;
  createWorkerCredential(displayName: string): Promise<WorkerCredentialSecret>;
  rotateWorkerToken(
    workerNodeId: string,
    expectedUpdatedAt: string,
  ): Promise<WorkerCredentialSecret>;
  revokeWorkerToken(workerNodeId: string): Promise<WorkerCredentialRevocation>;
  setWorkerDrain(workerId: string, drain: boolean): Promise<void>;
  listApprovals(query?: ListQuery): Promise<PageResult<Approval>>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  listPublications(query?: ListQuery): Promise<PageResult<Publication>>;
  retryPublication(publicationId: string): Promise<void>;
  getSystemSnapshot(): Promise<SystemSnapshot>;
}
