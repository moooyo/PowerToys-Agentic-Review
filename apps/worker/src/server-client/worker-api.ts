import type {
  ClaimLeaseRequest,
  ClaimLeaseResponse,
  RunCompletionSubmission,
  RunFailureSubmission,
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
} from "@agentic-review/contracts";

export type { RunCompletionSubmission, RunFailureSubmission };

export interface WorkerApi {
  register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse>;
  claimLease(request: ClaimLeaseRequest, signal?: AbortSignal): Promise<ClaimLeaseResponse>;
  heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse>;
  completeRun(
    runAttemptId: string,
    submission: RunCompletionSubmission,
    signal?: AbortSignal,
  ): Promise<void>;
  failRun(
    runAttemptId: string,
    submission: RunFailureSubmission,
    signal?: AbortSignal,
  ): Promise<void>;
}
