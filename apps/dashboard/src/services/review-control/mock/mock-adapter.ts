import type { ReviewControlAdapter } from "../adapter";
import type {
  Approval,
  ApprovalDecision,
  Job,
  ListQuery,
  PageResult,
  Publication,
  SystemSnapshot,
  WorkerCredential,
  WorkerCredentialRevocation,
  WorkerCredentialSecret,
  WorkerNode,
  WorkItem,
} from "../types";
import {
  approvals as approvalFixtures,
  jobs as jobFixtures,
  publications as publicationFixtures,
  systemSnapshot,
  workers as workerFixtures,
  workItems as workItemFixtures,
} from "./fixtures";

const latencyMs = 90;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;

const wait = async (): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, latencyMs);
  });

const clone = <T>(value: T): T => structuredClone(value);

const createMockToken = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const encoded = globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `arw1_${encoded}`;
};

const selected = (actual: string, expected: string | string[] | undefined): boolean => {
  if (expected === undefined) {
    return true;
  }

  return Array.isArray(expected)
    ? expected.length === 0 || expected.includes(actual)
    : expected === actual;
};

const contains = (values: Array<string | number | undefined>, term?: string) => {
  if (!term) {
    return true;
  }

  const normalized = term.trim().toLocaleLowerCase();
  return values.some((value) =>
    String(value ?? "")
      .toLocaleLowerCase()
      .includes(normalized),
  );
};

const page = <T>(items: T[], query: ListQuery = {}): PageResult<T> => {
  const current = Math.max(query.page ?? 1, 1);
  const size = Math.max(query.pageSize ?? 20, 1);
  const start = (current - 1) * size;

  return {
    items: clone(items.slice(start, start + size)),
    total: items.length,
  };
};

export class MockReviewControlAdapter implements ReviewControlAdapter {
  private readonly workItems = clone(workItemFixtures);
  private readonly jobs = clone(jobFixtures);
  private readonly workers = clone(workerFixtures);
  private readonly workerCredentials: WorkerCredential[] = this.workers.map((worker) => ({
    workerNodeId: worker.id,
    displayName: worker.displayName,
    authState: "active",
    createdAt: worker.lastHeartbeatAt,
    activatedAt: worker.lastHeartbeatAt,
    rotatedAt: null,
    revokedAt: null,
    updatedAt: worker.lastHeartbeatAt,
  }));
  private readonly approvals = clone(approvalFixtures);
  private readonly publications = clone(publicationFixtures);

  async listWorkItems(query: ListQuery = {}): Promise<PageResult<WorkItem>> {
    await wait();
    const filtered = this.workItems.filter(
      (item) =>
        contains(
          [item.repository, item.number, item.title, item.author, item.scheduledBy],
          query.search,
        ) &&
        selected(item.kind, query.filters?.kind) &&
        selected(item.stage, query.filters?.stage) &&
        selected(item.authorization, query.filters?.authorization),
    );
    return page(filtered, query);
  }

  async requeueWorkItem(workItemId: string): Promise<void> {
    await wait();
    const item = this.workItems.find((candidate) => candidate.id === workItemId);
    if (item) {
      item.stage = "queued";
      item.freshness = "current";
      item.attentionReason = undefined;
      item.updatedAt = new Date().toISOString();
      const repositoryName = item.repository.split("/").at(-1) ?? item.repository;
      this.jobs.unshift({
        id: `job-demo-${Date.now()}`,
        workItemId: item.id,
        workItemRef: `${repositoryName}#${item.number}`,
        title: item.kind === "pull_request" ? "PR review" : "Issue triage",
        generation: 1,
        status: "queued",
        stage: "queued",
        attempt: 0,
        maxAttempts: 3,
        elapsedSeconds: 0,
        ...(item.headSha === undefined ? {} : { targetSha: item.headSha }),
        createdAt: item.updatedAt,
      });
    }
  }

  async listJobs(query: ListQuery = {}): Promise<PageResult<Job>> {
    await wait();
    const filtered = this.jobs.filter(
      (job) =>
        contains([job.id, job.workItemRef, job.title, job.workerNodeId], query.search) &&
        selected(job.status, query.filters?.status) &&
        selected(job.stage, query.filters?.stage),
    );
    return page(filtered, query);
  }

  async cancelJob(jobId: string): Promise<void> {
    await wait();
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (job && !["succeeded", "failed", "cancelled", "stale", "dead_letter"].includes(job.status)) {
      job.status = "cancelled";
      job.stage = "done";
      job.outcome = "cancelled";
      if (job.workerNodeId !== undefined) {
        const worker = this.workers.find((candidate) => candidate.id === job.workerNodeId);
        if (worker !== undefined) {
          worker.currentJobs = worker.currentJobs.filter((id) => id !== job.id);
          worker.activeSlots = Math.max(0, worker.activeSlots - 1);
        }
      }
    }
  }

  async listWorkers(query: ListQuery = {}): Promise<PageResult<WorkerNode>> {
    await wait();
    const filtered = this.workers.filter(
      (worker) =>
        contains([worker.id, worker.instanceId, worker.location], query.search) &&
        selected(worker.status, query.filters?.status),
    );
    return page(filtered, query);
  }

  async listAllWorkers(): Promise<PageResult<WorkerNode>> {
    await wait();
    return { items: clone(this.workers), total: this.workers.length };
  }

  async listWorkerCredentials(): Promise<PageResult<WorkerCredential>> {
    await wait();
    return page(this.workerCredentials, { page: 1, pageSize: 200 });
  }

  async createWorkerCredential(displayName: string): Promise<WorkerCredentialSecret> {
    await wait();
    if (workerTokenExposurePattern.test(displayName)) {
      throw new Error("The worker display name contains credential material.");
    }
    const workerNodeId = `worker:${globalThis.crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.workerCredentials.unshift({
      workerNodeId,
      displayName,
      authState: "pending",
      createdAt: now,
      activatedAt: null,
      rotatedAt: null,
      revokedAt: null,
      updatedAt: now,
    });
    return { workerNodeId, authState: "pending", token: createMockToken() };
  }

  async rotateWorkerToken(
    workerNodeId: string,
    expectedUpdatedAt: string,
  ): Promise<WorkerCredentialSecret> {
    await wait();
    const credential = this.workerCredentials.find((item) => item.workerNodeId === workerNodeId);
    if (
      credential === undefined ||
      credential.authState === "revoked" ||
      credential.updatedAt !== expectedUpdatedAt
    ) {
      throw new Error("The worker credential cannot be rotated in its current state.");
    }
    const now = new Date().toISOString();
    credential.rotatedAt = now;
    credential.updatedAt = now;
    return { workerNodeId, authState: credential.authState, token: createMockToken() };
  }

  async revokeWorkerToken(workerNodeId: string): Promise<WorkerCredentialRevocation> {
    await wait();
    const credential = this.workerCredentials.find((item) => item.workerNodeId === workerNodeId);
    if (credential === undefined) {
      throw new Error("The worker credential does not exist.");
    }
    const now = new Date().toISOString();
    credential.authState = "revoked";
    credential.revokedAt ??= now;
    credential.updatedAt = now;
    const worker = this.workers.find((item) => item.id === workerNodeId);
    if (worker !== undefined) {
      worker.status = "disabled";
    }
    return { workerNodeId, authState: "revoked" };
  }

  async setWorkerDrain(workerId: string, drain: boolean): Promise<void> {
    await wait();
    const worker = this.workers.find((candidate) => candidate.id === workerId);
    if (worker && worker.status !== "offline") {
      worker.status = drain ? "draining" : "online";
    }
  }

  async listApprovals(query: ListQuery = {}): Promise<PageResult<Approval>> {
    await wait();
    const filtered = this.approvals.filter(
      (approval) =>
        contains([approval.workItemRef, approval.summary], query.search) &&
        selected(approval.kind, query.filters?.kind) &&
        selected(approval.status, query.filters?.status) &&
        selected(approval.risk, query.filters?.risk),
    );
    return page(filtered, query);
  }

  async decideApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    await wait();
    const approval = this.approvals.find((candidate) => candidate.id === approvalId);
    if (approval && approval.status === "pending") {
      approval.status = decision.decision === "approve" ? "approved" : "rejected";
      approval.decidedAt = new Date().toISOString();
      approval.decidedBy = "Review Operator";
    }
  }

  async listPublications(query: ListQuery = {}): Promise<PageResult<Publication>> {
    await wait();
    const filtered = this.publications.filter(
      (publication) =>
        contains([publication.id, publication.workItemRef, publication.lastError], query.search) &&
        selected(publication.kind, query.filters?.kind) &&
        selected(publication.status, query.filters?.status),
    );
    return page(filtered, query);
  }

  async retryPublication(publicationId: string): Promise<void> {
    await wait();
    const publication = this.publications.find((candidate) => candidate.id === publicationId);
    if (publication && ["failed", "unknown"].includes(publication.status)) {
      publication.status = "pending";
      publication.attempts += 1;
      publication.lastError = undefined;
      publication.updatedAt = new Date().toISOString();
    }
  }

  async getSystemSnapshot(): Promise<SystemSnapshot> {
    await wait();
    return clone(systemSnapshot);
  }
}
