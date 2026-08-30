import type {
  Approval,
  ApprovalDecision,
  Job,
  ListQuery,
  PageResult,
  Publication,
  SystemSnapshot,
  WorkerNode,
  WorkItem,
} from "./types";

export interface ReviewControlAdapter {
  listWorkItems(query?: ListQuery): Promise<PageResult<WorkItem>>;
  requeueWorkItem(workItemId: string): Promise<void>;
  listJobs(query?: ListQuery): Promise<PageResult<Job>>;
  cancelJob(jobId: string): Promise<void>;
  listWorkers(query?: ListQuery): Promise<PageResult<WorkerNode>>;
  setWorkerDrain(workerId: string, drain: boolean): Promise<void>;
  listApprovals(query?: ListQuery): Promise<PageResult<Approval>>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  listPublications(query?: ListQuery): Promise<PageResult<Publication>>;
  retryPublication(publicationId: string): Promise<void>;
  getSystemSnapshot(): Promise<SystemSnapshot>;
}
