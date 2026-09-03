import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  IssueTriageV1ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
} from "@agentic-review/codex";
import {
  type JobExecutionTemplate,
  maximumClaimLeaseResponseUtf8Bytes,
  type NormalizedSchedulingEvent,
  type SelfOrAllowlistPolicy,
  type WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../dist/app.js";
import {
  ArtifactTransactionCoordinator,
  type ArtifactTransactionDatabaseHandle,
  type ArtifactTransactionDatabaseOperation,
  registerArtifactTransactionOwnerLockHandle,
  registerArtifactTransactionStorageHandle,
} from "../../dist/artifacts/artifact-transaction-coordinator.js";
import { ArtifactStorageClientError } from "../../dist/artifacts/errors.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityLimits,
  ArtifactUploadCleanupRequest,
  PreparedArtifactChunk,
  PreparedArtifactFinalization,
} from "../../dist/artifacts/types.js";
import type { ServerConfig } from "../../dist/config.js";
import { maximumResultArtifactUploadIdentitiesPerAttempt } from "../../dist/database/artifacts.js";
import {
  attachDatabaseClientForTest,
  DatabaseClient,
  type DatabaseWorkerTransport,
} from "../../dist/database/database-client.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import { runMigrations } from "../../dist/database/migrations.js";
import type { IngestSchedulingEventInput } from "../../dist/database/protocol.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { ServerBindingCoordinatorV1 } from "../../dist/enrollment/server-binding-coordinator-v1.js";

type FakeArtifactTransactionStorageOwner = Parameters<
  typeof registerArtifactTransactionStorageHandle
>[1];
type FakeArtifactTransactionOwnerLock = Parameters<
  typeof registerArtifactTransactionOwnerLockHandle
>[1];

const attachArtifactTransactionStorageForTest = (owner: FakeArtifactTransactionStorageOwner) =>
  registerArtifactTransactionStorageHandle(owner, owner);

const attachArtifactTransactionOwnerLockForTest = (owner: FakeArtifactTransactionOwnerLock) =>
  registerArtifactTransactionOwnerLockHandle(owner, owner);

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const protocolVersion = "1.0";
const leaseTtlSeconds = 300;
const artifactLeaseToken = "database-client-artifact-lease-token";

const workerCapabilities = {
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  codexVersion: "test",
  recipeIds: ["pull-request-review"],
  labels: { pool: "test" },
} satisfies WorkerCapabilities;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const workerTokenForNode = (workerNodeId: string): string =>
  `arw1_${createHash("sha256").update(`worker-token:${workerNodeId}`).digest("base64url")}`;
const workerTokenSha256ForNode = (workerNodeId: string): string =>
  sha256(workerTokenForNode(workerNodeId));
const workerAuthorizationHeaders = (workerNodeId: string) => ({
  authorization: `Bearer ${workerTokenForNode(workerNodeId)}`,
});
const artifactClientId = (ordinal: number): string =>
  `10000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;

const artifactTransactionDatabaseOperations = [
  "probeArtifactUploadCreate",
  "createArtifactUpload",
  "prepareArtifactChunk",
  "prepareArtifactCompletion",
  "commitArtifactChunk",
  "commitArtifactCompletion",
  "prepareArtifactFinalize",
  "commitArtifactFinalize",
  "terminateArtifactUpload",
  "terminalizeInactiveArtifactUploads",
  "listDueArtifactCleanups",
  "completeArtifactCleanup",
  "recordArtifactCleanupFailure",
  "classifyArtifactNamespacePageAndAdvanceCursor",
  "listDueArtifactNamespaceCleanups",
  "completeArtifactNamespaceCleanup",
  "recordArtifactNamespaceCleanupFailure",
  "readArtifactHealthAccounting",
  "readArtifactReconciliationCursor",
] as const satisfies readonly ArtifactTransactionDatabaseOperation[];

const exhaustiveArtifactTransactionDatabaseOperations: [
  Exclude<
    ArtifactTransactionDatabaseOperation,
    (typeof artifactTransactionDatabaseOperations)[number]
  >,
] extends [never]
  ? typeof artifactTransactionDatabaseOperations
  : never = artifactTransactionDatabaseOperations;

const artifactStorageCapacity: ArtifactCapacityLimits = {
  hardBytes: 1_000_000_000n,
  hardEntries: 100_000,
  emergencyReserveBytes: 1_000n,
  perUploadMetadataHeadroomBytes: 0n,
  cleanupBacklogHighWaterEntries: 4_096,
};

const capacityAdmission = (input: ArtifactCapacityEvaluationInput): ArtifactCapacityAdmission => {
  const requiredBytes = BigInt(input.request.expectedTotalBytes) * 2n;
  const outstandingReservationBytes = input.accounting.liveUploadExpectedByteSizeBuckets.reduce(
    (total, bucket) => total + BigInt(bucket.expectedTotalBytes) * 2n * BigInt(bucket.uploadCount),
    0n,
  );
  const outstandingReservationEntries = input.accounting.liveUploadCount * 4;
  const filesystemAvailableBytes = 1_000_000_000n;
  return {
    requiredBytes,
    requiredEntries: 4,
    physicalAllocatedBytes: 0n,
    physicalEntries: 0,
    outstandingReservationBytes,
    outstandingReservationEntries,
    filesystemAvailableBytes,
    filesystemAvailableAfterReservationsBytes:
      filesystemAvailableBytes - outstandingReservationBytes,
    filesystemAllocationUnitBytes: 1n,
    projectedChargedBytes: outstandingReservationBytes + requiredBytes,
    projectedChargedEntries: outstandingReservationEntries + 4,
  };
};

class FakeArtifactTransactionStorage implements FakeArtifactTransactionStorageOwner {
  readonly exit = Promise.withResolvers<number>();
  readonly ownerExit = this.exit.promise;
  readonly terminal = Promise.withResolvers<Error>();
  readonly terminalFailure = this.terminal.promise;
  capacityEvaluationCount = 0;
  chunkWriteCount = 0;
  finalizationCount = 0;
  objectReadCount = 0;
  objectBytes: Buffer | undefined;
  objectReadError: Error | undefined;
  objectRead: (() => Promise<Buffer>) | undefined;

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    this.capacityEvaluationCount += 1;
    return Promise.resolve(capacityAdmission(input));
  }

  writePreparedChunk(input: PreparedArtifactChunk) {
    this.chunkWriteCount += 1;
    return Promise.resolve({
      uploadId: input.uploadId,
      prepareId: input.prepareId,
      durableOffsetBytes: input.offsetBytes + input.bytes.byteLength,
      replayed: input.receiptState === "committed",
    });
  }

  finalizeArtifact(input: PreparedArtifactFinalization) {
    this.finalizationCount += 1;
    return Promise.resolve({
      ...input,
      storageObjectKey: `sha256/${input.sha256.slice(0, 2)}/${input.sha256}`,
      reused: false,
    });
  }

  readObject(): Promise<Buffer> {
    this.objectReadCount += 1;
    if (this.objectReadError !== undefined) {
      return Promise.reject(this.objectReadError);
    }
    if (this.objectRead !== undefined) {
      return this.objectRead();
    }
    if (this.objectBytes !== undefined) {
      return Promise.resolve(Buffer.from(this.objectBytes));
    }
    return Promise.reject(new Error("Fake artifact object reads are not configured."));
  }

  cleanupUpload(_input: ArtifactUploadCleanupRequest) {
    return Promise.resolve({ stagingRemoved: false, publicationTemporariesRemoved: 0 });
  }

  scanNamespacePage(
    input: Parameters<FakeArtifactTransactionStorageOwner["scanNamespacePage"]>[0],
  ) {
    return Promise.resolve({
      scanSessionId: input.scanSessionId,
      sweepGeneration: input.sweepGeneration,
      expectedAfterKey: input.expectedAfterKey,
      observations: [],
      completedSweep: true,
      nextAfterKey: null,
    });
  }

  closeNamespaceScan(
    input: Parameters<FakeArtifactTransactionStorageOwner["closeNamespaceScan"]>[0],
  ) {
    return Promise.resolve({ ...input, closed: true as const });
  }

  cleanupNamespaceEntry(
    input: Parameters<FakeArtifactTransactionStorageOwner["cleanupNamespaceEntry"]>[0],
  ) {
    return Promise.resolve({
      entryKey: input.entryKey,
      observationSha256: input.observationSha256,
      outcome: "identity_changed" as const,
    });
  }

  close(): Promise<void> {
    this.exit.resolve(0);
    return Promise.resolve();
  }
}

const createArtifactCoordinator = async (
  client: DatabaseClient,
  database: ArtifactTransactionDatabaseHandle = client.createArtifactTransactionDatabaseHandle(),
  reconciliationIntervalMilliseconds = 60_000,
  storage = new FakeArtifactTransactionStorage(),
  onFailStop: (error: Error) => void = () => undefined,
): Promise<ArtifactTransactionCoordinator> => {
  const coordinator = await ArtifactTransactionCoordinator.create({
    database,
    storage: attachArtifactTransactionStorageForTest(storage),
    storageCapacity: artifactStorageCapacity,
    databaseOwnerLock: attachArtifactTransactionOwnerLockForTest({
      close: () => Promise.resolve(),
    }),
    requestTimeoutMilliseconds: 5_000,
    closeTimeoutMilliseconds: 5_000,
    storageJoinTimeoutMilliseconds: 5_000,
    maximumPendingTransactions: 16,
    reconciliationBatchSize: 8,
    reconciliationMaximumNamespacePagesPerSession: 8,
    reconciliationIntervalMilliseconds,
    reconciliationPassTimeoutMilliseconds: 5_000,
    reconciliationInitialRetryDelaySeconds: 30,
    reconciliationMaximumRetryDelaySeconds: 300,
    onFailStop,
  });
  await coordinator.ready;
  return coordinator;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
};

const executionTemplate = {
  repository: {
    githubRepositoryId: 1,
    fullName: "microsoft/PowerToys",
  },
  resource: {
    kind: "pull_request",
    githubNodeId: "PR_test",
    number: 1,
    title: "Test pull request",
    author: {
      githubUserId: 1,
      login: "test-author",
    },
    canonicalSnapshot: {},
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    isDraft: false,
  },
  prompt: {
    name: "pull-request-review",
    version: "test",
    renderedPrompt: "Review this pull request.",
    promptSha256: sha256("Review this pull request."),
    outputSchema: {},
    outputSchemaSha256: sha256("{}"),
  },
  executionPolicy: {
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 600_000,
    maxCodexTurns: 3,
    allowedRecipeIds: ["pull-request-review"],
    requiredCapabilityLabels: {},
  },
} satisfies JobExecutionTemplate;

const reviewer = {
  githubUserId: 99,
  login: "reviewer",
  accountType: "user",
} as const;

const pullRequestAuthor = {
  githubUserId: 7,
  login: "contributor",
  accountType: "user",
} as const;

const repository = {
  githubRepositoryId: 1,
  githubNodeId: "R_test",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
} as const;

const pullRequestRevisionKey = (headSha: string): string =>
  sha256(`${"a".repeat(40)}\0${headSha.toLowerCase()}`);

const schedulingPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [42],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
} satisfies SelfOrAllowlistPolicy;

const makePullRequest = (
  state: "open" | "closed",
  updatedAt: string,
): Extract<NormalizedSchedulingEvent["workItem"], { kind: "pull_request" }> => ({
  kind: "pull_request",
  githubWorkItemId: 501,
  githubNodeId: "PR_ingestion_test",
  githubRepositoryId: repository.githubRepositoryId,
  number: 501,
  title: "Test normalized ingestion",
  body: "Review body",
  state,
  author: pullRequestAuthor,
  htmlUrl: "https://github.com/microsoft/PowerToys/pull/501",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt,
  closedAt: state === "closed" ? updatedAt : null,
  isDraft: false,
});

const makePullRequestRevision = (
  headSha: string,
  observedAt: string,
): Extract<NormalizedSchedulingEvent["revision"], { kind: "pull_request" }> => ({
  kind: "pull_request",
  githubRepositoryId: repository.githubRepositoryId,
  githubWorkItemId: 501,
  revisionKey: pullRequestRevisionKey(headSha),
  baseSha: "a".repeat(40),
  headSha,
  observedAt,
  sourceUpdatedAt: observedAt,
});

const makeJobSchedule = (
  event: NormalizedSchedulingEvent,
): IngestSchedulingEventInput["schedule"] => {
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request") {
    throw new Error("This test schedule factory only supports pull requests.");
  }
  const renderedPrompt = "Review the normalized pull request.";
  const outputSchema = PrReviewPlanV1ModelOutputSchema;
  return {
    jobKind: "pull_request_review",
    priority: 100,
    intentVersion: 1,
    maxAttempts: 3,
    requiredCapabilities: [],
    executionTemplate: {
      repository: {
        githubRepositoryId: event.repository.githubRepositoryId,
        fullName: event.repository.fullName,
      },
      resource: {
        kind: "pull_request",
        githubNodeId: event.workItem.githubNodeId,
        number: event.workItem.number,
        title: event.workItem.title,
        author: event.workItem.author,
        canonicalSnapshot: event.workItem,
        baseSha: event.revision.baseSha,
        headSha: event.revision.headSha,
        isDraft: event.workItem.isDraft,
      },
      prompt: {
        name: "pull-request-review",
        version: "test",
        renderedPrompt,
        promptSha256: sha256(renderedPrompt),
        outputSchema,
        outputSchemaSha256: sha256(canonicalJson(outputSchema)),
      },
      executionPolicy: {
        hardTimeoutMs: 600_000,
        noProgressTimeoutMs: 600_000,
        maxCodexTurns: 3,
        allowedRecipeIds: ["pull-request-review"],
        requiredCapabilityLabels: {},
      },
    },
  };
};

const makeIssueRequestOpenedInput = (deliveryId: string): IngestSchedulingEventInput => {
  const observedAt = "2026-08-30T00:00:10.000Z";
  const contentDigest = sha256(`issue:${deliveryId}`);
  const workItem = {
    kind: "issue",
    githubWorkItemId: 601,
    githubNodeId: "I_ingestion_test",
    githubRepositoryId: repository.githubRepositoryId,
    number: 601,
    title: "Test issue triage",
    body: "The launcher exits unexpectedly.",
    state: "open",
    author: pullRequestAuthor,
    htmlUrl: "https://github.com/microsoft/PowerToys/issues/601",
    createdAt: observedAt,
    updatedAt: observedAt,
    closedAt: null,
  } as const;
  const revision = {
    kind: "issue",
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    revisionKey: contentDigest,
    contentDigest,
    observedAt,
    sourceUpdatedAt: observedAt,
  } as const;
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem,
    revision,
    author: workItem.author,
    action: "request_opened",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
  } satisfies NormalizedSchedulingEvent;
  const renderedPrompt = "Triage the immutable issue snapshot.";
  return {
    event,
    policy: schedulingPolicy,
    delivery: delivery(deliveryId),
    schedule: {
      jobKind: "issue_triage",
      priority: 50,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: repository.githubRepositoryId,
          fullName: repository.fullName,
        },
        resource: {
          kind: "issue",
          githubNodeId: workItem.githubNodeId,
          number: workItem.number,
          title: workItem.title,
          author: workItem.author,
          canonicalSnapshot: workItem,
          revisionDigest: revision.revisionKey,
        },
        prompt: {
          name: "issue-triage",
          version: "test",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: IssueTriageV1ModelOutputSchema,
          outputSchemaSha256: sha256(canonicalJson(IssueTriageV1ModelOutputSchema)),
        },
        executionPolicy: {
          hardTimeoutMs: 600_000,
          noProgressTimeoutMs: 600_000,
          maxCodexTurns: 1,
          allowedRecipeIds: ["issue-triage"],
          requiredCapabilityLabels: {},
        },
      },
    },
  };
};

const validPrReviewFinding = () => ({
  findingId: "finding-1",
  priority: 1,
  title: "Preserve the lease fence",
  body: "The finding records a concrete review concern for the immutable revision.",
  path: "apps/server/src/database/database-worker.ts",
  line: 100,
  endLine: 102,
  confidence: 0.95,
});

const validPrReviewResult = (summary = "The reviewed revision is ready for operator review.") => ({
  schemaVersion: "PrReviewPlanV1" as const,
  summary,
  assessment: "comment" as const,
  findings: [validPrReviewFinding()],
  requestedRecipeIds: ["pull-request-review"],
});

const validIssueTriageResult = () => ({
  schemaVersion: "IssueTriageV1" as const,
  summary: "The issue describes a reproducible launcher failure.",
  category: "bug" as const,
  priority: 1,
  confidence: 0.9,
  suggestedLabels: ["Issue-Bug", "Product-Launcher"],
  missingInformation: ["Provide the Windows build number."],
  duplicateCandidates: [{ number: 123, reason: "The reported call stack is similar." }],
  requestedRecipeIds: ["issue-triage"],
});

const delivery = (deliveryId: string, payload = `payload:${deliveryId}`) => ({
  deliveryId,
  eventName: "pull_request",
  payloadSha256: sha256(payload),
  receivedAt: "2026-08-30T00:00:10.000Z",
});

const makeRequestOpenedInput = (
  deliveryId: string,
  headSha = "b".repeat(40),
): IngestSchedulingEventInput => {
  const observedAt = "2026-08-30T00:00:10.000Z";
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "request_opened",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: delivery(deliveryId),
    schedule: makeJobSchedule(event),
  };
};

const makeRevisionObservedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
  withSchedule: boolean,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "revision_observed",
    requestKind: null,
    actor: pullRequestAuthor,
    target: null,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: withSchedule ? makeJobSchedule(event) : null,
  };
};

const makeRequestClosedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "request_closed",
    requestKind: "assignment",
    actor: reviewer,
    target: reviewer,
    closeReason: "assignment_removed",
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

const makeWorkItemClosedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("closed", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "work_item_closed",
    requestKind: null,
    actor: reviewer,
    target: null,
    closeReason: "work_item_closed",
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

const makeWorkItemReopenedInput = (
  deliveryId: string,
  headSha: string,
  observedAt: string,
): IngestSchedulingEventInput => {
  const event = {
    contractVersion: 1,
    eventId: `event:${deliveryId}`,
    source: "webhook",
    sourceEventId: deliveryId,
    occurredAt: observedAt,
    observedAt,
    repository,
    workItem: makePullRequest("open", observedAt),
    revision: makePullRequestRevision(headSha, observedAt),
    author: pullRequestAuthor,
    action: "work_item_reopened",
    requestKind: null,
    actor: reviewer,
    target: null,
  } satisfies NormalizedSchedulingEvent;
  return {
    event,
    policy: schedulingPolicy,
    delivery: { ...delivery(deliveryId), receivedAt: observedAt },
    schedule: null,
  };
};

interface DatabaseFixture {
  readonly client: DatabaseClient;
  readonly directory: string;
  readonly databasePath: string;
}

interface WorkerNodeCredentialRow {
  readonly worker_node_id: string;
  readonly display_name: string;
  readonly token_sha256: string;
  readonly auth_state: "pending" | "active" | "revoked";
  readonly created_by_issuer: string;
  readonly created_by_subject: string;
  readonly updated_by_issuer: string;
  readonly updated_by_subject: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly activated_at: string | null;
  readonly rotated_at: string | null;
  readonly revoked_at: string | null;
}

const fixtures: DatabaseFixture[] = [];

const createFixture = async (seedLeaseJob = true): Promise<DatabaseFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-server-"));
  const databasePath = join(directory, "server.sqlite");

  try {
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      runMigrations(seedDatabase, migrationsDirectory);
      if (seedLeaseJob) {
        const now = new Date().toISOString();
        seedDatabase
          .prepare(`
          INSERT INTO jobs (
            id,
            job_kind,
            semantic_key,
            concurrency_key,
            status,
            priority,
            execution_json,
            required_capabilities_json,
            resource_revision,
            next_attempt_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?, ?, ?)
          `)
          .run(
            "job-1",
            "pull_request_review",
            "microsoft/PowerToys#1:review",
            "microsoft/PowerToys#1",
            100,
            JSON.stringify(executionTemplate),
            executionTemplate.resource.headSha,
            now,
            now,
            now,
          );
      }
    } finally {
      seedDatabase.close();
    }
    if (process.platform !== "win32") {
      await chmod(databasePath, 0o600);
    }
    await writeInitializationMarker(databasePath);

    const client = await DatabaseClient.create({
      databasePath,
      migrationsDirectory,
    });
    const fixture = { client, directory, databasePath };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

const writeInitializationMarker = async (databasePath: string): Promise<void> => {
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
};

const withFixtureDatabase = <T>(
  fixture: DatabaseFixture,
  action: (database: DatabaseSync) => T,
): T => {
  const database = new DatabaseSync(fixture.databasePath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return action(database);
  } finally {
    database.close();
  }
};

const readWorkerNodeCredential = (
  fixture: DatabaseFixture,
  workerNodeId: string,
): WorkerNodeCredentialRow =>
  withFixtureDatabase(fixture, (database) => {
    const row = database
      .prepare("SELECT * FROM worker_node_credentials WHERE worker_node_id = ?")
      .get(workerNodeId) as unknown as WorkerNodeCredentialRow | undefined;
    if (row === undefined) {
      throw new Error("Expected a Worker node credential record.");
    }
    return row;
  });

const seedCompletedNamespaceSweepForTest = (fixture: DatabaseFixture): void => {
  withFixtureDatabase(fixture, (database) => {
    const completedAt = new Date().toISOString();
    const update = database
      .prepare(`
        UPDATE artifact_namespace_reconciliation_cursors
        SET sweep_generation = 1,
            after_key = NULL,
            updated_at = ?,
            last_completed_at = ?
        WHERE name = 'managed_namespace_v2'
          AND sweep_generation = 0
          AND after_key IS NULL
          AND last_completed_at IS NULL
      `)
      .run(completedAt, completedAt);
    if (Number(update.changes) !== 1) {
      throw new Error("Expected the namespace sweep test fixture to be incomplete.");
    }
  });
};

const setWorkerState = (
  fixture: DatabaseFixture,
  workerNodeId: string,
  workerInstanceId: string,
  status: "online" | "draining" | "offline" | "disabled",
): void => {
  withFixtureDatabase(fixture, (database) => {
    const update = database
      .prepare(`
        UPDATE workers
        SET status = ?, updated_at = ?
        WHERE node_id = ? AND instance_id = ?
      `)
      .run(status, new Date().toISOString(), workerNodeId, workerInstanceId);
    if (Number(update.changes) !== 1) {
      throw new Error("Expected one Worker record to be updated.");
    }
  });
};

const createWorkerNodeCredential = (
  client: DatabaseClient,
  workerNodeId: string,
  workerTokenSha256: string,
) =>
  client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: "https://issuer.example.test",
    createdBySubject: "database-client-test",
  });

const registerWorkerWithToken = (
  client: DatabaseClient,
  workerNodeId: string,
  workerInstanceId: string,
  workerTokenSha256: string,
  maxSlots = 1,
  registrationProtocolVersion = protocolVersion,
) =>
  client.request("registerWorker", {
    protocolVersion: registrationProtocolVersion,
    workerNodeId,
    workerTokenSha256,
    workerInstanceId,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots,
    capabilities: workerCapabilities,
  });

const registerWorker = async (
  client: DatabaseClient,
  workerNodeId: string,
  workerInstanceId: string,
) => {
  const workerTokenSha256 = workerTokenSha256ForNode(workerNodeId);
  const authentication = await client.request("authenticateWorkerToken", { workerTokenSha256 });
  if (authentication.outcome === "invalid") {
    await createWorkerNodeCredential(client, workerNodeId, workerTokenSha256);
  } else if (authentication.workerNodeId !== workerNodeId) {
    throw new Error("The deterministic test Worker token belongs to another Worker node.");
  }
  return registerWorkerWithToken(client, workerNodeId, workerInstanceId, workerTokenSha256);
};

const claimLease = async (
  client: DatabaseClient,
  workerNodeId: string,
  workerInstanceId: string,
  capabilitiesDigest: string,
) =>
  client.request("claimLease", {
    workerNodeId,
    workerInstanceId,
    availableSlots: 1,
    capabilitiesDigest,
    protocolVersion,
    leaseTtlSeconds,
  });

const addArtifactModeLease = (
  fixture: DatabaseFixture,
  workerId: string,
  workerNodeId: string,
  workerInstanceId: string,
  suffix: string,
) => {
  const now = new Date().toISOString();
  const future = "2099-09-01T00:00:00.000Z";
  const jobId = `job-artifact-${suffix}`;
  const runAttemptId = `run-artifact-${suffix}`;
  withFixtureDatabase(fixture, (database) => {
    database
      .prepare(`
        INSERT INTO jobs (
          id,
          job_kind,
          semantic_key,
          concurrency_key,
          status,
          execution_json,
          required_capabilities_json,
          resource_revision,
          attempt_count,
          max_attempts,
          lease_generation,
          current_run_attempt_id,
          next_attempt_at,
          started_at,
          created_at,
          updated_at
        ) VALUES (
          ?, 'pull_request_review', ?, ?, 'running', '{}', '[]', ?, 1, 3, 1, ?, ?, ?, ?, ?
        )
      `)
      .run(
        jobId,
        `artifact-${suffix}-semantic-key`,
        `artifact-${suffix}-concurrency-key`,
        sha256(`artifact-${suffix}-revision`),
        runAttemptId,
        now,
        now,
        now,
        now,
      );
    database
      .prepare(`
        INSERT INTO run_attempts (
          id,
          job_id,
          attempt_number,
          worker_id,
          worker_node_id,
          worker_instance_id,
          status,
          lease_token_hash,
          lease_generation,
          lease_expires_at,
          execution_deadline_at,
          no_progress_timeout_ms,
          no_progress_deadline_at,
          last_heartbeat_at,
          phase,
          completion_mode,
          started_at
        ) VALUES (
          ?, ?, 1, ?, ?, ?, 'running', ?, 1, ?, ?, 600000, ?, ?,
          'uploading', 'result_artifact_v1', ?
        )
      `)
      .run(
        runAttemptId,
        jobId,
        workerId,
        workerNodeId,
        workerInstanceId,
        sha256(artifactLeaseToken),
        future,
        future,
        future,
        now,
        now,
      );
  });
  return {
    jobId,
    runAttemptId,
    workerNodeId,
    workerInstanceId,
    leaseToken: artifactLeaseToken,
    leaseGeneration: 1,
  } as const;
};

const scheduleAndClaimReview = async (
  fixture: DatabaseFixture,
  input: IngestSchedulingEventInput,
  workerSuffix: string,
) => {
  const ingestion = await fixture.client.request("ingestSchedulingEvent", input);
  if (!ingestion.authorized || ingestion.jobId === null) {
    throw new Error("Expected an authorized GitHub event to schedule a review job.");
  }
  const workerNodeId = `worker-review-${workerSuffix}`;
  const workerInstanceId = `instance-review-${workerSuffix}`;
  const worker = await registerWorker(fixture.client, workerNodeId, workerInstanceId);
  const claim = await claimLease(
    fixture.client,
    workerNodeId,
    workerInstanceId,
    worker.capabilitiesDigest,
  );
  if (claim.outcome !== "granted") {
    throw new Error("Expected the scheduled GitHub review job to be leased.");
  }
  return claim;
};

const enableArtifactCompletionForAttempt = (
  fixture: DatabaseFixture,
  runAttemptId: string,
): void => {
  withFixtureDatabase(fixture, (database) => {
    database.exec("DROP TRIGGER tr_run_attempt_completion_mode_immutable");
    const update = database
      .prepare(`
        UPDATE run_attempts
        SET completion_mode = 'result_artifact_v1'
        WHERE id = ? AND status IN ('leased', 'running')
      `)
      .run(runAttemptId);
    if (Number(update.changes) !== 1) {
      throw new Error("Expected one active run attempt to enter artifact completion mode.");
    }
  });
};

const publishResultArtifact = async (
  coordinator: ArtifactTransactionCoordinator,
  lease: {
    readonly jobId: string;
    readonly runAttemptId: string;
    readonly workerNodeId: string;
    readonly workerInstanceId: string;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
  },
  bytes: Buffer,
) => {
  const rawDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await coordinator.createArtifactUpload({
    ...lease,
    clientArtifactId: artifactClientId(7),
    purpose: "result",
    name: "result.json",
    mediaType: "application/json",
    totalBytes: bytes.byteLength,
    sha256: rawDigest,
  });
  await coordinator.putArtifactChunk(created.uploadId, {
    ...lease,
    chunkIndex: 0,
    offsetBytes: 0,
    chunkBytes: bytes.byteLength,
    chunkSha256: rawDigest,
    data: bytes.toString("base64url"),
  });
  const finalized = await coordinator.finalizeArtifactUpload(created.uploadId, {
    ...lease,
    chunkCount: 1,
    totalBytes: bytes.byteLength,
    sha256: rawDigest,
  });
  return finalized.artifact;
};

const serverConfigFor = (fixture: DatabaseFixture): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: fixture.databasePath,
  migrationsDirectory,
  artifactStorage: {
    rootPath: join(fixture.directory, "unused-artifacts"),
    capacity: artifactStorageCapacity,
  },
  protocolVersion,
  heartbeatIntervalSeconds: 20,
  leaseTtlSeconds,
  leaseReaperIntervalSeconds: 300,
  operatorAuthCleanupIntervalSeconds: 300,
  operatorAuthCleanupBatchSize: 100,
  retryDelaySeconds: 1,
  workerOfflineAfterSeconds: 90,
  maxLongPollSeconds: 30,
  allowInsecureHttp: true,
  tls: undefined,
  github: undefined,
  operatorAuth: undefined,
  dashboardDirectory: undefined,
});

const assertUncommittedReviewCompletion = (
  fixture: DatabaseFixture,
  runAttemptId: string,
): void => {
  withFixtureDatabase(fixture, (database) => {
    const state = database
      .prepare(`
        SELECT
          attempt.status AS attempt_status,
          attempt.result_digest,
          attempt.result_json,
          job.status AS job_status,
          job.current_run_attempt_id
        FROM run_attempts AS attempt
        JOIN jobs AS job ON job.id = attempt.job_id
        WHERE attempt.id = ?
      `)
      .get(runAttemptId);
    expect(state).toEqual({
      attempt_status: "leased",
      result_digest: null,
      result_json: null,
      job_status: "leased",
      current_run_attempt_id: runAttemptId,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_results").get()).toEqual({
      count: 0,
    });
  });
};

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.client.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(fixture.directory, { force: true, recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Database fixture cleanup failed.");
  }
});

describe("DatabaseClient Worker token authentication", () => {
  it("creates a pending credential and authenticates only the stored lowercase token hash", async () => {
    const fixture = await createFixture(false);
    const workerNodeId = "worker-token-pending";
    const rawToken = "worker-token-pending-secret";
    const workerTokenSha256 = sha256(rawToken);

    await expect(
      createWorkerNodeCredential(fixture.client, workerNodeId, workerTokenSha256),
    ).resolves.toEqual({ workerNodeId, authState: "pending" });
    await expect(
      fixture.client.request("authenticateWorkerToken", { workerTokenSha256 }),
    ).resolves.toEqual({ outcome: "authenticated", workerNodeId, authState: "pending" });
    await expect(
      fixture.client.request("authenticateWorkerToken", {
        workerTokenSha256: workerTokenSha256.toUpperCase(),
      }),
    ).resolves.toEqual({ outcome: "invalid" });
    await expect(
      createWorkerNodeCredential(fixture.client, workerNodeId, sha256("replacement-token")),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_CONFLICT" });
    await expect(
      createWorkerNodeCredential(fixture.client, "worker-token-pending-other", workerTokenSha256),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_CONFLICT" });

    withFixtureDatabase(fixture, (database) => {
      const row = database
        .prepare(`
          SELECT worker_node_id, token_sha256, auth_state, created_by_subject
          FROM worker_node_credentials
          WHERE worker_node_id = ?
        `)
        .get(workerNodeId);
      expect(row).toEqual({
        worker_node_id: workerNodeId,
        token_sha256: workerTokenSha256,
        auth_state: "pending",
        created_by_subject: "database-client-test",
      });
      expect(JSON.stringify(row)).not.toContain(rawToken);
    });
  });

  it("activates a pending credential in the registration transaction and permits active replay", async () => {
    const fixture = await createFixture(false);
    const workerNodeId = "worker-token-active";
    const workerInstanceId = "worker-token-active-instance";
    const workerTokenSha256 = sha256("worker-token-active-secret");
    await createWorkerNodeCredential(fixture.client, workerNodeId, workerTokenSha256);

    const first = await registerWorkerWithToken(
      fixture.client,
      workerNodeId,
      workerInstanceId,
      workerTokenSha256,
    );
    const replay = await registerWorkerWithToken(
      fixture.client,
      workerNodeId,
      workerInstanceId,
      workerTokenSha256,
    );

    expect(replay.workerId).toBe(first.workerId);
    await expect(
      fixture.client.request("authenticateWorkerToken", { workerTokenSha256 }),
    ).resolves.toEqual({ outcome: "authenticated", workerNodeId, authState: "active" });
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare(
            "SELECT auth_state, activated_at IS NOT NULL AS activated FROM worker_node_credentials WHERE worker_node_id = ?",
          )
          .get(workerNodeId),
      ).toEqual({ auth_state: "active", activated: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM workers WHERE node_id = ?")
          .get(workerNodeId),
      ).toEqual({ count: 1 });
    });
  });

  it("rejects unknown tokens and rolls pending activation back when registration fails", async () => {
    const fixture = await createFixture(false);
    const workerNodeId = "worker-token-rollback";
    const workerTokenSha256 = sha256("worker-token-rollback-secret");
    await createWorkerNodeCredential(fixture.client, workerNodeId, workerTokenSha256);

    await expect(
      registerWorkerWithToken(
        fixture.client,
        workerNodeId,
        "worker-token-rollback-instance",
        sha256("unknown-token"),
      ),
    ).rejects.toMatchObject({ code: "WORKER_TOKEN_INVALID" });
    await expect(
      registerWorkerWithToken(
        fixture.client,
        "worker-token-other-identity",
        "worker-token-rollback-instance",
        workerTokenSha256,
      ),
    ).rejects.toMatchObject({ code: "WORKER_IDENTITY_MISMATCH" });
    await expect(
      registerWorkerWithToken(
        fixture.client,
        workerNodeId,
        "worker-token-rollback-instance",
        workerTokenSha256,
        1,
        "9.9",
      ),
    ).rejects.toMatchObject({ code: "WORKER_REGISTRATION_INVALID" });
    withFixtureDatabase(fixture, (database) => {
      database.exec(`
        CREATE TRIGGER tr_test_worker_registration_insert_failure
        BEFORE INSERT ON workers
        BEGIN
          SELECT RAISE(ABORT, 'forced Worker instance insert failure');
        END
      `);
    });
    await expect(
      registerWorkerWithToken(
        fixture.client,
        workerNodeId,
        "worker-token-rollback-instance",
        workerTokenSha256,
      ),
    ).rejects.toThrow("forced Worker instance insert failure");

    await expect(
      fixture.client.request("authenticateWorkerToken", { workerTokenSha256 }),
    ).resolves.toEqual({ outcome: "authenticated", workerNodeId, authState: "pending" });
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM workers WHERE node_id = ?")
          .get(workerNodeId),
      ).toEqual({ count: 0 });
    });
  });

  it("rotates pending and active tokens without changing their authentication state", async () => {
    const fixture = await createFixture(false);
    const workerNodeId = "worker-token-rotate";
    const firstTokenSha256 = sha256("worker-token-rotate-first");
    const secondTokenSha256 = sha256("worker-token-rotate-second");
    const thirdTokenSha256 = sha256("worker-token-rotate-third");
    await createWorkerNodeCredential(fixture.client, workerNodeId, firstTokenSha256);
    const pendingBeforeRotation = readWorkerNodeCredential(fixture, workerNodeId);

    await expect(
      fixture.client.request("rotateWorkerToken", {
        workerNodeId,
        workerTokenSha256: firstTokenSha256,
        rotatedByIssuer: "https://issuer.example.test",
        rotatedBySubject: "token-rotator",
      }),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_CONFLICT" });
    expect(readWorkerNodeCredential(fixture, workerNodeId)).toEqual(pendingBeforeRotation);

    await expect(
      fixture.client.request("rotateWorkerToken", {
        workerNodeId,
        workerTokenSha256: secondTokenSha256,
        rotatedByIssuer: "https://issuer.example.test",
        rotatedBySubject: "token-rotator",
      }),
    ).resolves.toEqual({ workerNodeId, authState: "pending" });
    const pendingAfterRotation = readWorkerNodeCredential(fixture, workerNodeId);
    expect(pendingAfterRotation).toEqual({
      ...pendingBeforeRotation,
      token_sha256: secondTokenSha256,
      updated_by_issuer: "https://issuer.example.test",
      updated_by_subject: "token-rotator",
      rotated_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(pendingAfterRotation.updated_at).toBe(pendingAfterRotation.rotated_at);
    await expect(
      fixture.client.request("authenticateWorkerToken", {
        workerTokenSha256: firstTokenSha256,
      }),
    ).resolves.toEqual({ outcome: "invalid" });
    await registerWorkerWithToken(
      fixture.client,
      workerNodeId,
      "worker-token-rotate-instance",
      secondTokenSha256,
    );
    const activeBeforeRotation = readWorkerNodeCredential(fixture, workerNodeId);

    await expect(
      fixture.client.request("rotateWorkerToken", {
        workerNodeId,
        workerTokenSha256: thirdTokenSha256,
        rotatedByIssuer: "https://issuer.example.test",
        rotatedBySubject: "token-rotator",
      }),
    ).resolves.toEqual({ workerNodeId, authState: "active" });
    const activeAfterRotation = readWorkerNodeCredential(fixture, workerNodeId);
    expect(activeAfterRotation).toEqual({
      ...activeBeforeRotation,
      token_sha256: thirdTokenSha256,
      updated_by_issuer: "https://issuer.example.test",
      updated_by_subject: "token-rotator",
      rotated_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(activeAfterRotation.updated_at).toBe(activeAfterRotation.rotated_at);
    await expect(
      fixture.client.request("authenticateWorkerToken", {
        workerTokenSha256: secondTokenSha256,
      }),
    ).resolves.toEqual({ outcome: "invalid" });
    await expect(
      fixture.client.request("authenticateWorkerToken", {
        workerTokenSha256: thirdTokenSha256,
      }),
    ).resolves.toEqual({ outcome: "authenticated", workerNodeId, authState: "active" });

    const otherTokenSha256 = sha256("worker-token-rotate-other-node");
    await createWorkerNodeCredential(fixture.client, "worker-token-rotate-other", otherTokenSha256);
    await expect(
      fixture.client.request("rotateWorkerToken", {
        workerNodeId,
        workerTokenSha256: otherTokenSha256,
        rotatedByIssuer: "https://issuer.example.test",
        rotatedBySubject: "token-rotator",
      }),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_CONFLICT" });
    expect(readWorkerNodeCredential(fixture, workerNodeId)).toEqual(activeAfterRotation);
    await expect(
      fixture.client.request("authenticateWorkerToken", {
        workerTokenSha256: thirdTokenSha256,
      }),
    ).resolves.toEqual({ outcome: "authenticated", workerNodeId, authState: "active" });
  });

  it("revokes credentials idempotently and hides revoked tokens as invalid", async () => {
    const fixture = await createFixture(false);
    const workerNodeId = "worker-token-revoked";
    const workerTokenSha256 = sha256("worker-token-revoked-secret");
    await createWorkerNodeCredential(fixture.client, workerNodeId, workerTokenSha256);
    await registerWorkerWithToken(
      fixture.client,
      workerNodeId,
      "worker-token-revoked-instance",
      workerTokenSha256,
    );
    const revocation = {
      workerNodeId,
      revokedByIssuer: "https://issuer.example.test",
      revokedBySubject: "first-revoker",
    } as const;

    await expect(fixture.client.request("revokeWorkerToken", revocation)).resolves.toEqual({
      workerNodeId,
      authState: "revoked",
    });
    const firstRevocation = withFixtureDatabase(fixture, (database) =>
      database
        .prepare(
          "SELECT auth_state, updated_by_issuer, updated_by_subject, updated_at, revoked_at FROM worker_node_credentials WHERE worker_node_id = ?",
        )
        .get(workerNodeId),
    );
    expect(firstRevocation).toMatchObject({
      auth_state: "revoked",
      updated_by_issuer: revocation.revokedByIssuer,
      updated_by_subject: revocation.revokedBySubject,
    });
    await expect(
      fixture.client.request("revokeWorkerToken", {
        ...revocation,
        revokedBySubject: "second-revoker",
      }),
    ).resolves.toEqual({ workerNodeId, authState: "revoked" });
    await expect(
      fixture.client.request("authenticateWorkerToken", { workerTokenSha256 }),
    ).resolves.toEqual({ outcome: "invalid" });
    await expect(
      registerWorkerWithToken(
        fixture.client,
        workerNodeId,
        "worker-token-revoked-instance",
        workerTokenSha256,
      ),
    ).rejects.toMatchObject({ code: "WORKER_TOKEN_INVALID" });
    await expect(
      fixture.client.request("rotateWorkerToken", {
        workerNodeId,
        workerTokenSha256: sha256("worker-token-revoked-replacement"),
        rotatedByIssuer: "https://issuer.example.test",
        rotatedBySubject: "token-rotator",
      }),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_REVOKED" });

    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare(
            "SELECT auth_state, updated_by_issuer, updated_by_subject, updated_at, revoked_at FROM worker_node_credentials WHERE worker_node_id = ?",
          )
          .get(workerNodeId),
      ).toEqual(firstRevocation);
    });
  });

  it("rechecks active credential state inside the lease claim transaction", async () => {
    const fixture = await createFixture();
    const workerNodeId = "worker-token-claim-revoked";
    const workerInstanceId = "worker-token-claim-revoked-instance";
    const workerTokenSha256 = sha256("worker-token-claim-revoked-secret");
    await createWorkerNodeCredential(fixture.client, workerNodeId, workerTokenSha256);
    const worker = await registerWorkerWithToken(
      fixture.client,
      workerNodeId,
      workerInstanceId,
      workerTokenSha256,
    );
    await fixture.client.request("revokeWorkerToken", {
      workerNodeId,
      revokedByIssuer: "https://issuer.example.test",
      revokedBySubject: "lease-revoker",
    });

    await expect(
      claimLease(fixture.client, workerNodeId, workerInstanceId, worker.capabilitiesDigest),
    ).resolves.toEqual({ outcome: "worker_unavailable", reason: "not_registered" });
  });
});

describe("DatabaseClient lease integration", () => {
  it("grants a queued job to only one of two concurrent claimers", async () => {
    const { client } = await createFixture();
    const firstWorker = await registerWorker(client, "worker-a", "instance-a");
    const secondWorker = await registerWorker(client, "worker-b", "instance-b");

    const results = await Promise.all([
      claimLease(client, "worker-a", "instance-a", firstWorker.capabilitiesDigest),
      claimLease(client, "worker-b", "instance-b", secondWorker.capabilitiesDigest),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["granted", "no_work"]);
    const granted = results.find((result) => result.outcome === "granted");
    expect(granted?.outcome).toBe("granted");
    if (granted?.outcome === "granted") {
      expect(["worker-a", "worker-b"]).toContain(granted.envelope.lease.workerNodeId);
    }
  });

  it("keeps every live artifact route mutation-free for a normal inline claim", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(
      fixture.client,
      "worker-inline-rollout-gate",
      "instance-inline-rollout-gate",
    );
    const claim = await claimLease(
      fixture.client,
      "worker-inline-rollout-gate",
      "instance-inline-rollout-gate",
      worker.capabilitiesDigest,
    );
    if (claim.outcome !== "granted") {
      throw new Error("Expected the inline rollout-gate fixture to receive a lease.");
    }

    expect(claim.envelope).not.toHaveProperty("completionMode");
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare("SELECT completion_mode FROM run_attempts WHERE id = ?")
          .get(claim.envelope.lease.runAttemptId),
      ).toEqual({ completion_mode: "inline_result_v1" });
    });
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const shutdown = new AbortController();
    const config = {
      host: "127.0.0.1",
      port: 0,
      databasePath: fixture.databasePath,
      migrationsDirectory,
      artifactStorage: {
        rootPath: join(fixture.directory, "unused-artifacts"),
        capacity: artifactStorageCapacity,
      },
      protocolVersion,
      heartbeatIntervalSeconds: 20,
      leaseTtlSeconds,
      leaseReaperIntervalSeconds: 300,
      operatorAuthCleanupIntervalSeconds: 300,
      operatorAuthCleanupBatchSize: 100,
      retryDelaySeconds: 1,
      workerOfflineAfterSeconds: 90,
      maxLongPollSeconds: 30,
      allowInsecureHttp: true,
      tls: undefined,
      github: undefined,
      operatorAuth: undefined,
      dashboardDirectory: undefined,
    } satisfies ServerConfig;
    let app: ReturnType<typeof buildApp> | undefined;
    const content = Buffer.from("{}", "utf8");
    const contentSha256 = sha256("{}");
    const uploadId = "20000000-0000-4000-8000-000000000001";
    const lease = claim.envelope.lease;
    const readArtifactCounts = () =>
      withFixtureDatabase(fixture, (database) => {
        const count = (
          table:
            | "artifact_uploads"
            | "artifact_upload_chunks"
            | "run_artifacts"
            | "artifact_completion_bindings",
        ) =>
          (
            database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              readonly count: number;
            }
          ).count;
        return Object.freeze({
          uploads: count("artifact_uploads"),
          chunks: count("artifact_upload_chunks"),
          artifacts: count("run_artifacts"),
          completions: count("artifact_completion_bindings"),
        });
      });
    const readStorageMutationCounts = () =>
      Object.freeze({
        capacityEvaluations: storage.capacityEvaluationCount,
        chunkWrites: storage.chunkWriteCount,
        finalizations: storage.finalizationCount,
        objectReads: storage.objectReadCount,
      });
    const databaseBefore = readArtifactCounts();
    const storageBefore = readStorageMutationCounts();
    const requests = [
      {
        method: "POST",
        url: `/api/v1/worker/runs/${lease.runAttemptId}/artifacts`,
        payload: {
          ...lease,
          clientArtifactId: artifactClientId(0),
          purpose: "result",
          name: "result.json",
          mediaType: "application/json",
          totalBytes: content.byteLength,
          sha256: contentSha256,
        },
      },
      {
        method: "PUT",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/chunks/0`,
        payload: {
          ...lease,
          chunkIndex: 0,
          offsetBytes: 0,
          chunkBytes: content.byteLength,
          chunkSha256: contentSha256,
          data: content.toString("base64url"),
        },
      },
      {
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/complete`,
        payload: {
          ...lease,
          chunkCount: 1,
          totalBytes: content.byteLength,
          sha256: contentSha256,
        },
      },
      {
        method: "POST",
        url: `/api/v1/worker/artifact-uploads/${uploadId}/terminate`,
        payload: {
          ...lease,
          state: "abandoned",
          reason: "client_abandoned",
        },
      },
      {
        method: "POST",
        url: `/api/v1/worker/runs/${lease.runAttemptId}/complete`,
        payload: {
          ...lease,
          artifactId: "artifact-id",
          resultDigest: contentSha256,
        },
      },
    ] as const;

    try {
      app = buildApp({
        config,
        database: fixture.client,
        shutdownSignal: shutdown.signal,
        artifactReadiness: { read: () => ({ ready: true }) },
        artifactTransactions: coordinator,
        artifactCompletion: Object.freeze({
          completeArtifactRun: (input, signal) => coordinator.completeArtifactRun(input, signal),
        }),
        serverAdmission: { read: () => true },
      });
      expect(databaseBefore).toEqual({ uploads: 0, chunks: 0, artifacts: 0, completions: 0 });
      expect(storageBefore).toEqual({
        capacityEvaluations: 0,
        chunkWrites: 0,
        finalizations: 0,
        objectReads: 0,
      });
      for (const request of requests) {
        const response = await app.inject({
          ...request,
          headers: workerAuthorizationHeaders("worker-inline-rollout-gate"),
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          code: "artifact_completion_mode_mismatch",
          message: "The run attempt does not permit result artifact operations.",
          retryable: false,
        });
      }
      expect(readArtifactCounts()).toEqual(databaseBefore);
      expect(readStorageMutationCounts()).toEqual(storageBefore);
    } finally {
      shutdown.abort(new Error("Inline artifact route integration test completed."));
      try {
        await app?.close();
      } finally {
        await coordinator.close();
      }
    }
  });

  it("maps artifact mutations through the single transaction authority", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(
      fixture.client,
      "worker-artifact-probe",
      "instance-artifact-probe",
    );
    const artifactLease = addArtifactModeLease(
      fixture,
      worker.workerId,
      "worker-artifact-probe",
      "instance-artifact-probe",
      "probe",
    );
    const input = {
      ...artifactLease,
      clientArtifactId: artifactClientId(0),
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: 2,
      sha256: sha256("{}"),
    };

    seedCompletedNamespaceSweepForTest(fixture);
    const databaseHandle = fixture.client.createArtifactTransactionDatabaseHandle();
    expect(Reflect.ownKeys(databaseHandle)).toEqual([]);
    expect(() => fixture.client.createArtifactTransactionDatabaseHandle()).toThrow(
      /already issued/u,
    );
    const coordinator = await createArtifactCoordinator(fixture.client, databaseHandle);
    const created = await coordinator.createArtifactUpload(input);
    const chunk = {
      ...artifactLease,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: 2,
      chunkSha256: sha256("{}"),
      data: Buffer.from("{}").toString("base64url"),
    };
    await expect(coordinator.putArtifactChunk(created.uploadId, chunk)).resolves.toMatchObject({
      state: "receiving",
      outcome: "accepted",
      nextChunkIndex: 1,
      nextOffsetBytes: 2,
    });
    await expect(coordinator.putArtifactChunk(created.uploadId, chunk)).resolves.toMatchObject({
      state: "receiving",
      outcome: "replayed",
      nextChunkIndex: 1,
      nextOffsetBytes: 2,
    });
    await expect(coordinator.createArtifactUpload(input)).resolves.toEqual({
      ...created,
      replayed: true,
      nextChunkIndex: 1,
      nextOffsetBytes: 2,
    });
    await coordinator.close();
  });

  it("completes a review from a verified artifact and replays without rereading storage", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-success"),
      "artifact-completion-success",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Artifact-backed review completed.");
    const canonicalResultJson = canonicalJson(result);
    const resultDigest = sha256(canonicalResultJson);
    const artifactBytes = Buffer.from(JSON.stringify(result, null, 2), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectBytes = artifactBytes;
    expect(artifact.sha256).not.toBe(resultDigest);

    const submission = {
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest,
    };
    const shutdown = new AbortController();
    const app = buildApp({
      config: serverConfigFor(fixture),
      database: fixture.client,
      shutdownSignal: shutdown.signal,
      artifactReadiness: { read: () => ({ ready: true }) },
      artifactTransactions: coordinator,
      artifactCompletion: Object.freeze({
        completeArtifactRun: (input, signal) => coordinator.completeArtifactRun(input, signal),
      }),
      serverAdmission: { read: () => true },
    });
    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/v1/worker/runs/${submission.runAttemptId}/complete`,
      headers: workerAuthorizationHeaders(submission.workerNodeId),
      payload: submission,
    });
    expect(firstResponse.statusCode).toBe(200);
    const terminal = firstResponse.json();
    expect(terminal).toEqual({
      jobId: claim.envelope.lease.jobId,
      runAttemptId: claim.envelope.lease.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    });
    expect(storage.objectReadCount).toBe(1);
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", submission.runAttemptId);
    });
    const replayResponse = await app.inject({
      method: "POST",
      url: `/api/v1/worker/runs/${submission.runAttemptId}/complete`,
      headers: workerAuthorizationHeaders(submission.workerNodeId),
      payload: submission,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toEqual(terminal);
    expect(storage.objectReadCount).toBe(1);
    const conflictResponse = await app.inject({
      method: "POST",
      url: `/api/v1/worker/runs/${submission.runAttemptId}/complete`,
      headers: workerAuthorizationHeaders(submission.workerNodeId),
      payload: { ...submission, resultDigest: "0".repeat(64) },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      code: "terminal_submission_conflict",
      retryable: false,
    });
    const tokenConflictResponse = await app.inject({
      method: "POST",
      url: `/api/v1/worker/runs/${submission.runAttemptId}/complete`,
      headers: workerAuthorizationHeaders(submission.workerNodeId),
      payload: { ...submission, leaseToken: "z".repeat(32) },
    });
    expect(tokenConflictResponse.statusCode).toBe(409);
    expect(tokenConflictResponse.json()).toMatchObject({
      code: "terminal_submission_conflict",
      retryable: false,
    });

    withFixtureDatabase(fixture, (database) => {
      const state = database
        .prepare(`
          SELECT
            attempt.status AS attempt_status,
            attempt.result_digest,
            attempt.result_json,
            attempt.ended_at,
            job.status AS job_status,
            job.current_run_attempt_id,
            job.completed_at,
            binding.artifact_id,
            binding.artifact_sha256,
            binding.result_digest AS binding_result_digest,
            binding.canonicalization_version,
            binding.terminal_response_json,
            binding.completed_at AS binding_completed_at
          FROM run_attempts AS attempt
          JOIN jobs AS job ON job.id = attempt.job_id
          JOIN artifact_completion_bindings AS binding
            ON binding.run_attempt_id = attempt.id
          WHERE attempt.id = ?
        `)
        .get(claim.envelope.lease.runAttemptId) as Record<string, unknown>;
      expect(state).toMatchObject({
        attempt_status: "succeeded",
        result_digest: resultDigest,
        result_json: canonicalResultJson,
        job_status: "succeeded",
        current_run_attempt_id: null,
        artifact_id: artifact.artifactId,
        artifact_sha256: artifact.sha256,
        binding_result_digest: resultDigest,
        canonicalization_version: 1,
        terminal_response_json: JSON.stringify(terminal),
      });
      expect(state.ended_at).toBe(state.binding_completed_at);
      expect(state.completed_at).toBe(state.binding_completed_at);
      expect(database.prepare("SELECT COUNT(*) AS count FROM review_results").get()).toEqual({
        count: 1,
      });
    });
    shutdown.abort(new Error("Artifact completion route test completed."));
    await app.close();
    await coordinator.close();
  });

  it.each([
    { kind: "encoding", expectedCode: "ARTIFACT_COMPLETION_RESULT_ENCODING_INVALID" },
    { kind: "json", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "bom", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "trailing", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "unsafe-number", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "unpaired-surrogate", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "duplicate-member", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "depth", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "width", expectedCode: "ARTIFACT_COMPLETION_RESULT_JSON_INVALID" },
    { kind: "schema", expectedCode: "ARTIFACT_COMPLETION_RESULT_INVALID" },
    { kind: "digest", expectedCode: "ARTIFACT_COMPLETION_RESULT_DIGEST_MISMATCH" },
  ] as const)(
    "keeps artifact completion zero-write after $kind validation failure",
    async ({ kind, expectedCode }) => {
      const fixture = await createFixture(false);
      const claim = await scheduleAndClaimReview(
        fixture,
        makeRequestOpenedInput(`delivery-artifact-completion-${kind}`),
        `artifact-completion-${kind}`,
      );
      enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
      seedCompletedNamespaceSweepForTest(fixture);
      const storage = new FakeArtifactTransactionStorage();
      const coordinator = await createArtifactCoordinator(
        fixture.client,
        undefined,
        60_000,
        storage,
      );
      const validResult = validPrReviewResult(`Artifact ${kind} validation.`);
      const value = kind === "schema" ? {} : validResult;
      let artifactBytes: Buffer;
      switch (kind) {
        case "encoding":
          artifactBytes = Buffer.from([0xff]);
          break;
        case "json":
          artifactBytes = Buffer.from("{", "utf8");
          break;
        case "bom":
          artifactBytes = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(JSON.stringify(validResult), "utf8"),
          ]);
          break;
        case "trailing":
          artifactBytes = Buffer.from(`${JSON.stringify(validResult)} {}`, "utf8");
          break;
        case "unsafe-number":
          artifactBytes = Buffer.from("9007199254740993", "utf8");
          break;
        case "unpaired-surrogate":
          artifactBytes = Buffer.from('"\\ud800"', "utf8");
          break;
        case "duplicate-member":
          artifactBytes = Buffer.from(
            '{"schemaVersion":"PrReviewPlanV1","schemaVersion":"PrReviewPlanV1"}',
            "utf8",
          );
          break;
        case "depth":
          artifactBytes = Buffer.from(`${"[".repeat(130)}null${"]".repeat(130)}`, "utf8");
          break;
        case "width":
          artifactBytes = Buffer.from(`[${"0,".repeat(65_536)}0]`, "utf8");
          break;
        default:
          artifactBytes = Buffer.from(JSON.stringify(value), "utf8");
      }
      const artifact = await publishResultArtifact(
        coordinator,
        claim.envelope.lease,
        artifactBytes,
      );
      storage.objectBytes = artifactBytes;
      const claimedDigest = kind === "schema" ? sha256(canonicalJson(value)) : "0".repeat(64);

      await expect(
        coordinator.completeArtifactRun({
          ...claim.envelope.lease,
          artifactId: artifact.artifactId,
          resultDigest: claimedDigest,
        }),
      ).rejects.toMatchObject({ code: expectedCode, requiresFailStop: false });
      assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
      withFixtureDatabase(fixture, (database) => {
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM artifact_completion_bindings").get(),
        ).toEqual({ count: 0 });
      });
      expect(storage.objectReadCount).toBe(1);
      await coordinator.close();
    },
  );

  it("rejects a lost lease before reading artifact storage or writing terminal state", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-lease-lost"),
      "artifact-completion-lease-lost",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Expired artifact completion.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectBytes = artifactBytes;
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.lease.runAttemptId);
    });

    await expect(
      coordinator.completeArtifactRun({
        ...claim.envelope.lease,
        artifactId: artifact.artifactId,
        resultDigest: sha256(canonicalJson(result)),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_LEASE_LOST" });
    expect(storage.objectReadCount).toBe(0);
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
    await coordinator.close();
  });

  it("rechecks a revoked lease after the verified storage read before final commit", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-revoked-during-read"),
      "artifact-completion-revoked-during-read",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Lease revoked during artifact read.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    const read = Promise.withResolvers<Buffer>();
    storage.objectRead = () => read.promise;
    const completion = coordinator.completeArtifactRun({
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest: sha256(canonicalJson(result)),
    });
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(storage.objectReadCount).toBe(1));
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.lease.runAttemptId);
    });
    read.resolve(artifactBytes);

    await expect(completion).rejects.toMatchObject({ code: "ARTIFACT_TRANSACTION_LEASE_LOST" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
    withFixtureDatabase(fixture, (database) => {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM artifact_completion_bindings").get(),
      ).toEqual({ count: 0 });
    });
    await coordinator.close();
  });

  it("lets a competing terminal failure win while artifact completion is reading", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-terminal-race"),
      "artifact-completion-terminal-race",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Terminal failure wins the race.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    const read = Promise.withResolvers<Buffer>();
    storage.objectRead = () => read.promise;
    const completion = coordinator.completeArtifactRun({
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest: sha256(canonicalJson(result)),
    });
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(storage.objectReadCount).toBe(1));
    await fixture.client.request("failLease", {
      ...claim.envelope.lease,
      failureCode: "execution_failed",
      failureMessage: "A terminal failure committed while the object was being read.",
      retryable: false,
      retryDelaySeconds: 1,
    });
    read.resolve(artifactBytes);

    await expect(completion).rejects.toMatchObject({
      code: "ARTIFACT_COMPLETION_TERMINAL_CONFLICT",
    });
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare(`
            SELECT
              attempt.status AS attempt_status,
              job.status AS job_status,
              (SELECT COUNT(*) FROM artifact_completion_bindings) AS binding_count,
              (SELECT COUNT(*) FROM review_results) AS review_result_count
            FROM run_attempts AS attempt
            JOIN jobs AS job ON job.id = attempt.job_id
            WHERE attempt.id = ?
          `)
          .get(claim.envelope.lease.runAttemptId),
      ).toEqual({
        attempt_status: "failed",
        job_status: "failed",
        binding_count: 0,
        review_result_count: 0,
      });
    });
    await coordinator.close();
  });

  it("fails stop on immutable object integrity loss without committing completion", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-integrity"),
      "artifact-completion-integrity",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const failStops: Error[] = [];
    const coordinator = await createArtifactCoordinator(
      fixture.client,
      undefined,
      60_000,
      storage,
      (error) => failStops.push(error),
    );
    const result = validPrReviewResult("Integrity failure remains uncommitted.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectReadError = new ArtifactStorageClientError(
      "ARTIFACT_STORAGE_INTEGRITY",
      "The immutable object failed verification.",
    );

    await expect(
      coordinator.completeArtifactRun({
        ...claim.envelope.lease,
        artifactId: artifact.artifactId,
        resultDigest: sha256(canonicalJson(result)),
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_STORAGE_INTEGRITY",
      requiresFailStop: true,
    });
    expect(failStops).toHaveLength(1);
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
    await coordinator.close().catch(() => undefined);
  });

  it("fails stop instead of replaying noncanonical terminal binding JSON", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-corrupt-replay"),
      "artifact-completion-corrupt-replay",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Replay state must stay canonical.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectBytes = artifactBytes;
    const submission = {
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest: sha256(canonicalJson(result)),
    };
    await coordinator.completeArtifactRun(submission);
    const readsAfterCommit = storage.objectReadCount;
    withFixtureDatabase(fixture, (database) => {
      database.exec("DROP TRIGGER tr_artifact_completion_bindings_immutable_update");
      database
        .prepare(`
          UPDATE artifact_completion_bindings
          SET terminal_response_json = ' ' || terminal_response_json
          WHERE run_attempt_id = ?
        `)
        .run(claim.envelope.lease.runAttemptId);
    });

    await expect(coordinator.completeArtifactRun(submission)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    expect(storage.objectReadCount).toBe(readsAfterCommit);
    await coordinator.close().catch(() => undefined);
  });

  it("fails stop instead of replaying consistently corrupted canonical result JSON", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-corrupt-result-replay"),
      "artifact-completion-corrupt-result-replay",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Canonical replay state must remain digest-bound.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectBytes = artifactBytes;
    const submission = {
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest: sha256(canonicalJson(result)),
    };
    await coordinator.completeArtifactRun(submission);
    const readsAfterCommit = storage.objectReadCount;
    withFixtureDatabase(fixture, (database) => {
      database.exec("DROP TRIGGER tr_run_attempt_artifact_completion_immutable");
      database.exec("DROP TRIGGER tr_run_attempt_completed_review_identity_immutable");
      database.exec("DROP TRIGGER tr_review_results_immutable_update");
      database
        .prepare("UPDATE run_attempts SET result_json = ' ' || result_json WHERE id = ?")
        .run(claim.envelope.lease.runAttemptId);
      database
        .prepare(
          "UPDATE review_results SET result_json = ' ' || result_json WHERE run_attempt_id = ?",
        )
        .run(claim.envelope.lease.runAttemptId);
    });

    await expect(coordinator.completeArtifactRun(submission)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    expect(storage.objectReadCount).toBe(readsAfterCommit);
    await coordinator.close().catch(() => undefined);
  });

  it("fails stop when a terminal binding loses its immutable artifact referent", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-artifact-completion-missing-terminal-artifact"),
      "artifact-completion-missing-terminal-artifact",
    );
    enableArtifactCompletionForAttempt(fixture, claim.envelope.lease.runAttemptId);
    seedCompletedNamespaceSweepForTest(fixture);
    const storage = new FakeArtifactTransactionStorage();
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 60_000, storage);
    const result = validPrReviewResult("Terminal replay requires its immutable artifact.");
    const artifactBytes = Buffer.from(JSON.stringify(result), "utf8");
    const artifact = await publishResultArtifact(coordinator, claim.envelope.lease, artifactBytes);
    storage.objectBytes = artifactBytes;
    const submission = {
      ...claim.envelope.lease,
      artifactId: artifact.artifactId,
      resultDigest: sha256(canonicalJson(result)),
    };
    await coordinator.completeArtifactRun(submission);
    const readsAfterCommit = storage.objectReadCount;
    withFixtureDatabase(fixture, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TRIGGER tr_run_artifacts_immutable_delete");
      database.prepare("DELETE FROM run_artifacts WHERE id = ?").run(artifact.artifactId);
    });

    await expect(coordinator.completeArtifactRun(submission)).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    expect(storage.objectReadCount).toBe(readsAfterCommit);
    await coordinator.close().catch(() => undefined);
  });

  it("rejects every ordinary artifact request and issues one opaque transaction handle", async () => {
    const fixture = await createFixture();
    let getterCalls = 0;
    for (const operation of exhaustiveArtifactTransactionDatabaseOperations) {
      const accessor = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(accessor, "value", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      const bareRequest = Reflect.apply(fixture.client.request, fixture.client, [
        operation,
        accessor,
      ]) as Promise<unknown>;
      await expect(bareRequest).rejects.toMatchObject({
        name: "DatabaseRequestError",
        code: "ARTIFACT_TRANSACTION_AUTHORITY_REQUIRED",
      });
    }
    const shutdownInput = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(shutdownInput, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    await expect(
      Reflect.apply(fixture.client.request, fixture.client, ["shutdown", shutdownInput]),
    ).rejects.toMatchObject({ code: "DATABASE_SHUTDOWN_AUTHORITY_REQUIRED" });
    expect(getterCalls).toBe(0);
    const handle = fixture.client.createArtifactTransactionDatabaseHandle();
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(() => fixture.client.createArtifactTransactionDatabaseHandle()).toThrow(
      /already issued/u,
    );
    seedCompletedNamespaceSweepForTest(fixture);
    const coordinator = await createArtifactCoordinator(fixture.client, handle);
    await expect(fixture.client.close()).rejects.toMatchObject({
      code: "ARTIFACT_TRANSACTION_AUTHORITY_REQUIRED",
    });
    await coordinator.close();
  });

  it("revokes an unconsumed artifact transaction handle when the database owner closes", async () => {
    const fixture = await createFixture();
    const handle = fixture.client.createArtifactTransactionDatabaseHandle();
    expect(Reflect.ownKeys(handle)).toEqual([]);

    await expect(fixture.client.close()).resolves.toBeUndefined();
  });

  it("round-trips Server-authoritative artifact cleanup operations through the database Worker", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(
      fixture.client,
      "worker-artifact-reconcile",
      "instance-artifact-reconcile",
    );
    const artifactLease = addArtifactModeLease(
      fixture,
      worker.workerId,
      "worker-artifact-reconcile",
      "instance-artifact-reconcile",
      "reconcile",
    );
    seedCompletedNamespaceSweepForTest(fixture);
    const coordinator = await createArtifactCoordinator(fixture.client, undefined, 10);
    await coordinator.createArtifactUpload({
      ...artifactLease,
      clientArtifactId: artifactClientId(0),
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: 2,
      sha256: sha256("{}"),
    });
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", artifactLease.runAttemptId);
    });

    await vi.waitFor(() => {
      expect(coordinator.readiness.health).toMatchObject({
        cleanup: { completed: 1, failed: 0 },
        capacity: { liveUploadCount: 0, cleanupBacklogEntries: 0 },
      });
    });
    await coordinator.close();
  });

  it("serializes the stable artifact upload quota error across the database protocol", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(
      fixture.client,
      "worker-artifact-quota",
      "instance-artifact-quota",
    );
    const artifactLease = addArtifactModeLease(
      fixture,
      worker.workerId,
      "worker-artifact-quota",
      "instance-artifact-quota",
      "quota",
    );
    seedCompletedNamespaceSweepForTest(fixture);
    const coordinator = await createArtifactCoordinator(fixture.client);

    for (let ordinal = 0; ordinal < maximumResultArtifactUploadIdentitiesPerAttempt; ordinal += 1) {
      const upload = await coordinator.createArtifactUpload({
        ...artifactLease,
        clientArtifactId: artifactClientId(ordinal),
        purpose: "result",
        name: `result-${ordinal}.json`,
        mediaType: "application/json",
        totalBytes: 1,
        sha256: sha256(`artifact-${ordinal}`),
      });
      await coordinator.terminateArtifactUpload(upload.uploadId, {
        ...artifactLease,
        state: "abandoned",
        reason: "client_abandoned",
      });
    }

    await expect(
      coordinator.createArtifactUpload({
        ...artifactLease,
        clientArtifactId: artifactClientId(maximumResultArtifactUploadIdentitiesPerAttempt),
        purpose: "result",
        name: "result-over-quota.json",
        mediaType: "application/json",
        totalBytes: 1,
        sha256: sha256("artifact-over-quota"),
      }),
    ).rejects.toMatchObject({
      name: "ArtifactTransactionCoordinatorError",
      code: "ARTIFACT_TRANSACTION_QUOTA_EXCEEDED",
    });
    await coordinator.close();
  });

  it("dead-letters an oversized claim response before committing a lease", async () => {
    const fixture = await createFixture();
    const oversizedTemplate: JobExecutionTemplate = {
      ...executionTemplate,
      resource: {
        ...executionTemplate.resource,
        canonicalSnapshot: { body: "x".repeat(maximumClaimLeaseResponseUtf8Bytes) },
      },
    };
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE jobs SET execution_json = ? WHERE id = 'job-1'")
        .run(JSON.stringify(oversizedTemplate));
    });

    const worker = await registerWorker(fixture.client, "worker-large", "instance-large");
    await expect(
      claimLease(fixture.client, "worker-large", "instance-large", worker.capabilitiesDigest),
    ).resolves.toMatchObject({ outcome: "no_work" });

    withFixtureDatabase(fixture, (database) => {
      const state = database
        .prepare(`
          SELECT
            jobs.status,
            jobs.failure_code,
            jobs.current_run_attempt_id,
            jobs.attempt_count,
            COUNT(run_attempts.id) AS run_attempt_count
          FROM jobs
          LEFT JOIN run_attempts ON run_attempts.job_id = jobs.id
          WHERE jobs.id = 'job-1'
          GROUP BY jobs.id
        `)
        .get();
      expect(state).toEqual({
        status: "dead_letter",
        failure_code: "claim_response_too_large",
        current_run_attempt_id: null,
        attempt_count: 0,
        run_attempt_count: 0,
      });
    });
  });

  it("reaches a compatible claim candidate after a full incompatible page", async () => {
    const fixture = await createFixture(false);
    const firstCreatedAt = Date.now() - 120_000;
    const nextAttemptAt = new Date(firstCreatedAt).toISOString();

    withFixtureDatabase(fixture, (database) => {
      const insert = database.prepare(`
        INSERT INTO jobs (
          id,
          job_kind,
          semantic_key,
          concurrency_key,
          status,
          priority,
          execution_json,
          required_capabilities_json,
          resource_revision,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, 'pull_request_review', ?, ?, 'queued', 100, ?, ?, ?, ?, ?, ?)
      `);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index <= 100; index += 1) {
          const jobId = `job-paged-${index.toString().padStart(3, "0")}`;
          const createdAt = new Date(firstCreatedAt + index).toISOString();
          const requiredCapabilities =
            index < 100 ? ["unsupported-recipe"] : ["pull-request-review"];
          insert.run(
            jobId,
            `paged-semantic-${index}`,
            `paged-concurrency-${index}`,
            JSON.stringify(executionTemplate),
            JSON.stringify(requiredCapabilities),
            executionTemplate.resource.headSha,
            nextAttemptAt,
            createdAt,
            createdAt,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });

    const worker = await registerWorker(fixture.client, "worker-paged", "instance-paged");
    const claim = await claimLease(
      fixture.client,
      "worker-paged",
      "instance-paged",
      worker.capabilitiesDigest,
    );

    expect(claim.outcome).toBe("granted");
    if (claim.outcome === "granted") {
      expect(claim.envelope.job.jobId).toBe("job-paged-100");
    }
  });

  it("allows an authoritative offline Worker instance to complete its live lease", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(fixture.client, "worker-offline", "instance-complete");
    const claim = await claimLease(
      fixture.client,
      "worker-offline",
      "instance-complete",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    setWorkerState(fixture, "worker-offline", "instance-complete", "offline");
    const result = { findings: [], summary: "completed after the Worker became offline" };
    const terminal = await fixture.client.request("completeLease", {
      ...claim.envelope.lease,
      resultDigest: sha256(canonicalJson(result)),
      result,
    });

    expect(terminal).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
  });

  it("allows an authoritative offline Worker instance to fail its live lease", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(fixture.client, "worker-offline", "instance-fail");
    const claim = await claimLease(
      fixture.client,
      "worker-offline",
      "instance-fail",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    setWorkerState(fixture, "worker-offline", "instance-fail", "offline");
    const terminal = await fixture.client.request("failLease", {
      ...claim.envelope.lease,
      failureCode: "test_failure",
      failureMessage: "A focused reliability test requested failure.",
      retryable: false,
      retryDelaySeconds: 1,
    });

    expect(terminal).toMatchObject({ jobState: "failed", runState: "failed" });
  });

  it.each(["draining", "disabled"] as const)(
    "renews and completes the current lease while the Worker is %s",
    async (workerState) => {
      const fixture = await createFixture();
      const worker = await registerWorker(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
      );
      const claim = await claimLease(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
        worker.capabilitiesDigest,
      );
      expect(claim.outcome).toBe("granted");
      if (claim.outcome !== "granted") {
        throw new Error("Expected the Worker instance to receive the lease.");
      }

      setWorkerState(fixture, `worker-${workerState}`, `instance-${workerState}`, workerState);
      const additionalClaim = await claimLease(
        fixture.client,
        `worker-${workerState}`,
        `instance-${workerState}`,
        worker.capabilitiesDigest,
      );
      expect(additionalClaim).toMatchObject({
        outcome: "worker_unavailable",
        reason: workerState,
      });

      const heartbeat = await fixture.client.request("heartbeatLease", {
        ...claim.envelope.lease,
        phase: "codex_review",
        progressSequence: 1,
        progress: { completedTurns: 1 },
        leaseTtlSeconds,
      });
      expect(heartbeat.command).toBe("drain");

      const result = { findings: [], summary: `completed while ${workerState}` };
      const terminal = await fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      });
      expect(terminal).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
    },
  );

  it("keeps Server-controlled Worker states and recovers only offline instances", async () => {
    const fixture = await createFixture(false);
    await registerWorker(fixture.client, "worker-state", "instance-state");
    const heartbeat = (heartbeatSequence: number, state: string) =>
      fixture.client.request("heartbeatWorker", {
        workerNodeId: "worker-state",
        workerInstanceId: "instance-state",
        heartbeatSequence,
        availableSlots: 1,
        health: { state },
      });

    await expect(heartbeat(1, "draining")).resolves.toEqual({ state: "online" });

    setWorkerState(fixture, "worker-state", "instance-state", "draining");
    await expect(heartbeat(2, "online")).resolves.toEqual({ state: "draining" });

    setWorkerState(fixture, "worker-state", "instance-state", "disabled");
    await expect(heartbeat(3, "online")).resolves.toEqual({ state: "disabled" });

    setWorkerState(fixture, "worker-state", "instance-state", "offline");
    await expect(heartbeat(4, "draining")).resolves.toEqual({ state: "online" });
  });

  it("rejects terminal completion from an instance superseded by registration", async () => {
    const { client } = await createFixture();
    const oldWorker = await registerWorker(client, "worker-node", "instance-old");
    const claim = await claimLease(
      client,
      "worker-node",
      "instance-old",
      oldWorker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the old Worker instance to receive the lease.");
    }

    await registerWorker(client, "worker-node", "instance-new");
    const result = { summary: "completed by the stale instance" };

    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("rejects a superseded instance registration without fencing the current instance", async () => {
    const { client } = await createFixture(false);
    await registerWorker(client, "worker-node", "instance-old");
    await registerWorker(client, "worker-node", "instance-current");

    await expect(registerWorker(client, "worker-node", "instance-old")).rejects.toMatchObject({
      code: "WORKER_INSTANCE_SUPERSEDED",
    });
    await expect(
      client.request("heartbeatWorker", {
        workerNodeId: "worker-node",
        workerInstanceId: "instance-current",
        heartbeatSequence: 1,
        availableSlots: 1,
        health: { state: "online" },
      }),
    ).resolves.toEqual({ state: "online" });
  });

  it("rejects completion when the result digest does not match", async () => {
    const { client } = await createFixture();
    const worker = await registerWorker(client, "worker-node", "instance-current");
    const claim = await claimLease(
      client,
      "worker-node",
      "instance-current",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    const result = { findings: [], summary: "complete" };
    const validDigest = sha256(canonicalJson(result));
    const invalidDigest = `${validDigest.startsWith("0") ? "1" : "0"}${validDigest.slice(1)}`;

    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: invalidDigest,
        result,
      }),
    ).rejects.toMatchObject({ code: "RESULT_DIGEST_MISMATCH" });
    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: `${validDigest}\u0000ignored-suffix`,
        result,
      }),
    ).rejects.toMatchObject({ code: "RESULT_DIGEST_MISMATCH" });
  });

  it("replays an identical completion and rejects conflicting terminal submissions", async () => {
    const fixture = await createFixture();
    const { client } = fixture;
    const worker = await registerWorker(client, "worker-replay", "instance-complete-replay");
    const claim = await claimLease(
      client,
      "worker-replay",
      "instance-complete-replay",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    const result = { findings: [], summary: "idempotent completion" };
    const submission = {
      ...claim.envelope.lease,
      resultDigest: sha256(canonicalJson(result)),
      result,
    };
    const first = await client.request("completeLease", submission);
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.lease.runAttemptId);
    });
    const replay = await client.request("completeLease", submission);

    expect(replay).toEqual(first);
    await expect(
      client.request("completeLease", {
        ...submission,
        leaseToken: "different-terminal-replay-token".padEnd(32, "x"),
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      client.request("completeLease", {
        ...submission,
        resultDigest: `${submission.resultDigest.startsWith("0") ? "1" : "0"}${submission.resultDigest.slice(1)}`,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });

    const differentResult = { findings: [], summary: "different completion" };
    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(differentResult)),
        result: differentResult,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });
    await expect(
      client.request("failLease", {
        ...claim.envelope.lease,
        failureCode: "late_failure",
        failureMessage: "A failure cannot replace a committed completion.",
        retryable: false,
        retryDelaySeconds: 1,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });
  });

  it("replays an identical failure and rejects a changed payload or outcome", async () => {
    const fixture = await createFixture();
    const { client } = fixture;
    const worker = await registerWorker(client, "worker-replay", "instance-failure-replay");
    const claim = await claimLease(
      client,
      "worker-replay",
      "instance-failure-replay",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    const submission = {
      ...claim.envelope.lease,
      failureCode: "temporary_execution_failure",
      failureMessage: "The execution host ended unexpectedly.",
      retryable: true,
      retryDelaySeconds: 1,
    };
    const first = await client.request("failLease", submission);
    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.lease.runAttemptId);
    });
    const replay = await client.request("failLease", submission);

    expect(first).toMatchObject({ jobState: "retry_waiting", runState: "failed" });
    expect(replay).toEqual(first);

    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE jobs SET next_attempt_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.job.jobId);
    });
    const nextClaim = await claimLease(
      client,
      "worker-replay",
      "instance-failure-replay",
      worker.capabilitiesDigest,
    );
    expect(nextClaim.outcome).toBe("granted");
    if (nextClaim.outcome !== "granted") {
      throw new Error("Expected the retry attempt to receive the lease.");
    }
    expect(nextClaim.envelope.lease.runAttemptId).not.toBe(claim.envelope.lease.runAttemptId);
    await expect(client.request("failLease", submission)).resolves.toEqual(first);
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare("SELECT status, current_run_attempt_id FROM jobs WHERE id = ?")
          .get(claim.envelope.job.jobId),
      ).toEqual({
        status: "leased",
        current_run_attempt_id: nextClaim.envelope.lease.runAttemptId,
      });
    });

    await expect(
      client.request("failLease", { ...submission, retryable: false }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });

    const completion = { summary: "too late" };
    await expect(
      client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(completion)),
        result: completion,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });
  });

  it("rejects terminal submissions for an expired attempt that never committed a terminal state", async () => {
    const fixture = await createFixture();
    const worker = await registerWorker(fixture.client, "worker-expired", "instance-expired");
    const claim = await claimLease(
      fixture.client,
      "worker-expired",
      "instance-expired",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");
    if (claim.outcome !== "granted") {
      throw new Error("Expected the Worker instance to receive the lease.");
    }

    withFixtureDatabase(fixture, (database) => {
      database
        .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", claim.envelope.lease.runAttemptId);
    });
    await expect(
      fixture.client.request("reapExpiredLeases", {
        retryDelaySeconds: 1,
        workerOfflineAfterSeconds: 90,
      }),
    ).resolves.toEqual({ expiredCount: 1 });

    const result = { summary: "expired" };
    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      fixture.client.request("failLease", {
        ...claim.envelope.lease,
        failureCode: "expired",
        failureMessage: "The expired attempt cannot commit a terminal state.",
        retryable: true,
        retryDelaySeconds: 1,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("validates and atomically persists an immutable pull-request review projection", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-pr"),
      "valid-pr",
    );
    const result = validPrReviewResult();

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).resolves.toMatchObject({ jobState: "succeeded", runState: "succeeded" });

    withFixtureDatabase(fixture, (database) => {
      const persisted = database
        .prepare(`
          SELECT
            result.id,
            result.run_attempt_id,
            result.job_id,
            result.work_item_id,
            result.revision_id,
            result.job_kind,
            result.schema_id,
            result.result_digest,
            result.result_json,
            result.summary,
            result.requested_recipe_ids_json,
            result.output_schema_sha256,
            result.prompt_sha256,
            result.allowed_recipe_ids_json,
            result.execution_template_sha256,
            result.execution_template_json,
            projection.assessment
          FROM review_results AS result
          JOIN pr_review_results AS projection ON projection.review_result_id = result.id
          WHERE result.run_attempt_id = ?
        `)
        .get(claim.envelope.lease.runAttemptId) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        run_attempt_id: claim.envelope.lease.runAttemptId,
        job_id: claim.envelope.job.jobId,
        job_kind: "pull_request_review",
        schema_id: "PrReviewPlanV1",
        result_digest: sha256(canonicalJson(result)),
        result_json: canonicalJson(result),
        summary: result.summary,
        requested_recipe_ids_json: canonicalJson(result.requestedRecipeIds),
        output_schema_sha256: sha256(canonicalJson(PrReviewPlanV1ModelOutputSchema)),
        prompt_sha256: claim.envelope.prompt.promptSha256,
        allowed_recipe_ids_json: canonicalJson(claim.envelope.executionPolicy.allowedRecipeIds),
        execution_template_sha256: sha256(
          canonicalJson({
            repository: claim.envelope.repository,
            resource: claim.envelope.resource,
            prompt: claim.envelope.prompt,
            executionPolicy: claim.envelope.executionPolicy,
          }),
        ),
        execution_template_json: canonicalJson({
          repository: claim.envelope.repository,
          resource: claim.envelope.resource,
          prompt: claim.envelope.prompt,
          executionPolicy: claim.envelope.executionPolicy,
        }),
        assessment: result.assessment,
      });
      expect(persisted.work_item_id).toEqual(expect.any(String));
      expect(persisted.revision_id).toEqual(expect.any(String));

      const findings = database
        .prepare(`
          SELECT ordinal, finding_id, priority, title, body, path, line, end_line, confidence
          FROM pr_review_findings
          WHERE review_result_id = ?
          ORDER BY ordinal
        `)
        .all(persisted.id as string);
      expect(findings).toEqual([
        {
          ordinal: 0,
          finding_id: "finding-1",
          priority: 1,
          title: result.findings[0]?.title,
          body: result.findings[0]?.body,
          path: result.findings[0]?.path,
          line: 100,
          end_line: 102,
          confidence: 0.95,
        },
      ]);
      expect(() =>
        database
          .prepare("UPDATE review_results SET summary = ? WHERE id = ?")
          .run("changed", persisted.id as string),
      ).toThrow("review results are immutable");
      expect(() =>
        database
          .prepare("DELETE FROM pr_review_findings WHERE review_result_id = ?")
          .run(persisted.id as string),
      ).toThrow("PR review findings are immutable");
      expect(() =>
        database
          .prepare(`
            INSERT INTO pr_review_findings (
              review_result_id,
              ordinal,
              finding_id,
              priority,
              title,
              body,
              path,
              line,
              end_line,
              confidence
            ) VALUES (?, 1, 'late-finding', 1, 'Late', 'Late insert', 'src/late.ts', 1, NULL, 1.0)
          `)
          .run(persisted.id as string),
      ).toThrow("PR finding/result mismatch");
      expect(() =>
        database
          .prepare(`
            INSERT OR REPLACE INTO pr_review_results (review_result_id, assessment)
            VALUES (?, 'approve')
          `)
          .run(persisted.id as string),
      ).toThrow("PR review projection/result mismatch");
      expect(() =>
        database
          .prepare("UPDATE jobs SET execution_json = ? WHERE id = ?")
          .run("{}", claim.envelope.job.jobId),
      ).toThrow("GitHub review scheduling identity is immutable");
      expect(() =>
        database
          .prepare("UPDATE jobs SET request_epoch_id = NULL WHERE id = ?")
          .run(claim.envelope.job.jobId),
      ).toThrow("GitHub review scheduling identity is immutable");
      expect(() =>
        database
          .prepare("UPDATE run_attempts SET result_json = ? WHERE id = ?")
          .run("{}", claim.envelope.lease.runAttemptId),
      ).toThrow("completed review attempt result is immutable");
      expect(() =>
        database
          .prepare("UPDATE work_item_revisions SET head_sha = ? WHERE id = ?")
          .run("f".repeat(40), persisted.revision_id as string),
      ).toThrow("completed review revision identity is immutable");
      expect(() =>
        database
          .prepare(`
            INSERT INTO legacy_review_result_replays (
              run_attempt_id,
              job_id,
              result_digest,
              result_json,
              recorded_at
            ) VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            claim.envelope.lease.runAttemptId,
            claim.envelope.job.jobId,
            sha256(canonicalJson(result)),
            canonicalJson(result),
            new Date().toISOString(),
          ),
      ).toThrow("legacy review-result replay markers are migration-only");
    });
  });

  it("rejects an omitted PR finding end line and persists an explicit null", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-null-end-line"),
      "null-end-line",
    );
    const findingWithoutEndLine: Record<string, unknown> = { ...validPrReviewFinding() };
    delete findingWithoutEndLine.endLine;
    const omittedResult = {
      ...validPrReviewResult(),
      findings: [findingWithoutEndLine],
    };

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(omittedResult)),
        result: omittedResult,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);

    const nullableResult = {
      ...validPrReviewResult(),
      findings: [{ ...validPrReviewFinding(), endLine: null }],
    };
    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(nullableResult)),
        result: nullableResult,
      }),
    ).resolves.toMatchObject({ jobState: "succeeded", runState: "succeeded" });

    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare(`
            SELECT finding.end_line
            FROM pr_review_findings AS finding
            JOIN review_results AS result ON result.id = finding.review_result_id
            WHERE result.run_attempt_id = ?
          `)
          .get(claim.envelope.lease.runAttemptId),
      ).toEqual({ end_line: null });
    });
  });

  it("validates and atomically persists an immutable issue-triage projection", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeIssueRequestOpenedInput("delivery-review-result-issue"),
      "valid-issue",
    );
    const result = validIssueTriageResult();

    await fixture.client.request("completeLease", {
      ...claim.envelope.lease,
      resultDigest: sha256(canonicalJson(result)),
      result,
    });

    withFixtureDatabase(fixture, (database) => {
      const persisted = database
        .prepare(`
          SELECT
            result.id,
            result.job_kind,
            result.schema_id,
            result.result_json,
            projection.category,
            projection.priority,
            projection.confidence,
            projection.suggested_labels_json,
            projection.missing_information_json,
            projection.duplicate_candidates_json
          FROM review_results AS result
          JOIN issue_triage_results AS projection ON projection.review_result_id = result.id
          WHERE result.run_attempt_id = ?
        `)
        .get(claim.envelope.lease.runAttemptId) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        job_kind: "issue_triage",
        schema_id: "IssueTriageV1",
        result_json: canonicalJson(result),
        category: result.category,
        priority: result.priority,
        confidence: result.confidence,
        suggested_labels_json: canonicalJson(result.suggestedLabels),
        missing_information_json: canonicalJson(result.missingInformation),
        duplicate_candidates_json: canonicalJson(result.duplicateCandidates),
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM pr_review_results").get()).toEqual({
        count: 0,
      });
      expect(() =>
        database
          .prepare("DELETE FROM issue_triage_results WHERE review_result_id = ?")
          .run(persisted.id as string),
      ).toThrow("issue triage projections are immutable");
    });
  });

  it("rejects a result schema that does not match the authoritative job kind", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-wrong-kind"),
      "wrong-kind",
    );
    const result = validIssueTriageResult();

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });

  it("rejects an otherwise schema-valid review result above the canonical byte limit", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-too-large"),
      "too-large",
    );
    const result = {
      ...validPrReviewResult(),
      findings: Array.from({ length: 100 }, (_, index) => ({
        ...validPrReviewFinding(),
        findingId: `finding-${index}`,
        body: "\u754c".repeat(8_192),
        path: `src/${index}-${"\u754c".repeat(1_000)}`,
      })),
    };

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });

  it("rejects a deeply nested result before unbounded canonicalization", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-too-deep"),
      "too-deep",
    );
    let result: unknown = null;
    for (let depth = 0; depth < 256; depth += 1) {
      result = [result];
    }

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: "0".repeat(64),
        result,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });

  it.each(["execution", "prompt", "schema"] as const)(
    "rejects an altered %s digest in the stored execution template",
    async (alteration) => {
      const fixture = await createFixture(false);
      const claim = await scheduleAndClaimReview(
        fixture,
        makeRequestOpenedInput(`delivery-review-result-altered-${alteration}`),
        `altered-${alteration}`,
      );
      withFixtureDatabase(fixture, (database) => {
        // Simulate a pre-migration corrupted record after separately verifying the SQL freeze.
        expect(() =>
          database
            .prepare("UPDATE jobs SET execution_digest = ? WHERE id = ?")
            .run("f".repeat(64), claim.envelope.job.jobId),
        ).toThrow("GitHub review scheduling identity is immutable");
        database.exec("DROP TRIGGER tr_github_review_job_scheduling_identity_immutable");
        if (alteration === "execution") {
          database
            .prepare("UPDATE jobs SET execution_digest = ? WHERE id = ?")
            .run("0".repeat(64), claim.envelope.job.jobId);
          return;
        }
        const row = database
          .prepare("SELECT execution_json FROM jobs WHERE id = ?")
          .get(claim.envelope.job.jobId) as { readonly execution_json: string };
        const template = JSON.parse(row.execution_json) as JobExecutionTemplate;
        const alteredTemplate: JobExecutionTemplate = {
          ...template,
          prompt: {
            ...template.prompt,
            ...(alteration === "prompt"
              ? { promptSha256: "0".repeat(64) }
              : { outputSchemaSha256: "0".repeat(64) }),
          },
        };
        const executionJson = canonicalJson(alteredTemplate);
        database
          .prepare("UPDATE jobs SET execution_json = ?, execution_digest = ? WHERE id = ?")
          .run(executionJson, sha256(executionJson), claim.envelope.job.jobId);
      });

      const result = validPrReviewResult();
      await expect(
        fixture.client.request("completeLease", {
          ...claim.envelope.lease,
          resultDigest: sha256(canonicalJson(result)),
          result,
        }),
      ).rejects.toMatchObject({ code: "STORED_EXECUTION_TEMPLATE_INVALID" });
      assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
    },
  );

  it("rejects direct SQL inserts whose immutable result or execution snapshot does not match", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-sql-mismatch"),
      "sql-mismatch",
    );
    const result = validPrReviewResult();
    const resultJson = canonicalJson(result);
    const resultDigest = sha256(resultJson);

    withFixtureDatabase(fixture, (database) => {
      const context = database
        .prepare(`
          SELECT
            job.work_item_id,
            job.resource_revision,
            job.execution_json,
            job.execution_digest,
            revision.id AS revision_id
          FROM jobs AS job
          JOIN work_item_revisions AS revision
            ON revision.work_item_id = job.work_item_id
            AND revision.revision_key = job.resource_revision
          WHERE job.id = ?
        `)
        .get(claim.envelope.job.jobId) as {
        readonly work_item_id: string;
        readonly resource_revision: string;
        readonly execution_json: string;
        readonly execution_digest: string;
        readonly revision_id: string;
      };
      database
        .prepare(`
          UPDATE run_attempts
          SET status = 'succeeded', result_digest = ?, result_json = ?
          WHERE id = ?
        `)
        .run(resultDigest, resultJson, claim.envelope.lease.runAttemptId);
      const insert = database.prepare(`
        INSERT INTO review_results (
          id,
          run_attempt_id,
          job_id,
          work_item_id,
          revision_id,
          job_kind,
          resource_revision,
          schema_id,
          result_digest,
          result_json,
          summary,
          requested_recipe_ids_json,
          output_schema_sha256,
          prompt_sha256,
          allowed_recipe_ids_json,
          execution_template_sha256,
          execution_template_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 'pull_request_review', ?, 'PrReviewPlanV1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const commonArguments = [
        claim.envelope.lease.runAttemptId,
        claim.envelope.job.jobId,
        context.work_item_id,
        context.revision_id,
        context.resource_revision,
      ] as const;
      const trailingArguments = (
        allowedRecipeIdsJson = canonicalJson(claim.envelope.executionPolicy.allowedRecipeIds),
      ) =>
        [
          resultJson,
          result.summary,
          canonicalJson(result.requestedRecipeIds),
          claim.envelope.prompt.outputSchemaSha256,
          claim.envelope.prompt.promptSha256,
          allowedRecipeIdsJson,
          context.execution_digest,
        ] as const;
      const differentDigest = `${resultDigest.startsWith("0") ? "1" : "0"}${resultDigest.slice(1)}`;
      expect(() =>
        insert.run(
          "review-result-wrong-result",
          ...commonArguments,
          differentDigest,
          ...trailingArguments(),
          context.execution_json,
          new Date().toISOString(),
        ),
      ).toThrow("review result dependency mismatch");
      expect(() =>
        insert.run(
          "review-result-wrong-template",
          ...commonArguments,
          resultDigest,
          ...trailingArguments(),
          "{}",
          new Date().toISOString(),
        ),
      ).toThrow("review result dependency mismatch");
      expect(() =>
        insert.run(
          "review-result-wrong-allowlist",
          ...commonArguments,
          resultDigest,
          ...trailingArguments('["different-recipe"]'),
          context.execution_json,
          new Date().toISOString(),
        ),
      ).toThrow("review result dependency mismatch");
      database
        .prepare(`
          UPDATE run_attempts
          SET status = 'leased', result_digest = NULL, result_json = NULL
          WHERE id = ?
        `)
        .run(claim.envelope.lease.runAttemptId);
    });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });

  it.each([
    {
      name: "disallowed recipe",
      result: () => ({ ...validPrReviewResult(), requestedRecipeIds: ["not-allowed"] }),
    },
    {
      name: "non-normalized path",
      result: () => ({
        ...validPrReviewResult(),
        findings: [{ ...validPrReviewFinding(), path: "apps//server.ts" }],
      }),
    },
    {
      name: "duplicate finding identifier",
      result: () => {
        return {
          ...validPrReviewResult(),
          findings: [
            validPrReviewFinding(),
            { ...validPrReviewFinding(), line: 110, endLine: 111 },
          ],
        };
      },
    },
    {
      name: "reversed line range",
      result: () => ({
        ...validPrReviewResult(),
        findings: [{ ...validPrReviewFinding(), line: 200, endLine: 199 }],
      }),
    },
  ])("rejects the PR review business violation: $name", async ({ name, result: createResult }) => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput(`delivery-review-result-${name.replaceAll(" ", "-")}`),
      name.replaceAll(" ", "-"),
    );
    const result = createResult();

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_RESULT_INVALID" });
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });

  it("replays an identical persisted review without duplicating its immutable projection", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-replay"),
      "persisted-replay",
    );
    const result = validPrReviewResult("Persist this result exactly once.");
    const submission = {
      ...claim.envelope.lease,
      resultDigest: sha256(canonicalJson(result)),
      result,
    };

    const first = await fixture.client.request("completeLease", submission);
    const replay = await fixture.client.request("completeLease", submission);
    expect(replay).toEqual(first);
    withFixtureDatabase(fixture, (database) => {
      expect(database.prepare("SELECT COUNT(*) AS count FROM review_results").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM pr_review_results").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM pr_review_findings").get()).toEqual({
        count: 1,
      });
    });

    await expect(
      fixture.client.request("completeLease", {
        ...submission,
        resultDigest: sha256(canonicalJson(validPrReviewResult("A conflicting result."))),
        result: validPrReviewResult("A conflicting result."),
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_SUBMISSION_CONFLICT" });
  });

  it("preserves idempotent replay for a linked review completed before migration 0006", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentic-review-server-v5-replay-"));
    const databasePath = join(directory, "data", "server.sqlite");
    const versionFiveMigrations = join(directory, "migrations-v5");
    await mkdir(versionFiveMigrations);
    await Promise.all(
      [1, 2, 3, 4, 5].map((version) => {
        const filename = `${version.toString().padStart(4, "0")}_${
          [
            "initial",
            "github_ingestion",
            "operator_auth",
            "github_polling_state",
            "operator_browser_flows",
          ][version - 1]
        }.sql`;
        return copyFile(join(migrationsDirectory, filename), join(versionFiveMigrations, filename));
      }),
    );

    const leaseToken = "legacy-review-result-replay-token".padEnd(32, "x");
    let result: unknown = "Completed under schema version five.";
    for (let depth = 0; depth < 256; depth += 1) {
      result = [result];
    }
    const resultJson = canonicalJson(result);
    const resultDigest = sha256(resultJson);
    const workerNodeId = "worker-legacy-review";
    const workerInstanceId = "instance-legacy-review";
    const workerId = "worker-id-legacy-review";
    const runAttemptId = "attempt-legacy-review";
    await mkdir(join(directory, "data"), { mode: 0o700 });
    let jobId: string;
    const versionFiveDatabase = new DatabaseSync(databasePath);
    try {
      expect(runMigrations(versionFiveDatabase, versionFiveMigrations)).toBe(5);
      FormatRegistry.Set(
        "date-time",
        (value) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
          Number.isFinite(Date.parse(value)),
      );
      FormatRegistry.Set("uri", (value) => URL.canParse(value));
      const ingestion = ingestSchedulingEvent(
        versionFiveDatabase,
        makeRequestOpenedInput("delivery-legacy-review-result"),
      );
      if (ingestion.jobId === null) {
        throw new Error("Expected the version-five fixture to schedule a linked review job.");
      }
      jobId = ingestion.jobId;
    } finally {
      versionFiveDatabase.close();
    }
    if (process.platform !== "win32") {
      await chmod(databasePath, 0o600);
    }
    await writeInitializationMarker(databasePath);
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      const now = new Date().toISOString();
      const capabilitiesJson = canonicalJson(workerCapabilities);
      seedDatabase
        .prepare(`
          INSERT INTO workers (
            id,
            node_id,
            instance_id,
            display_name,
            version,
            protocol_version,
            max_slots,
            capabilities_json,
            capabilities_digest,
            status,
            registered_at,
            last_seen_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'test', ?, 1, ?, ?, 'online', ?, ?, ?)
        `)
        .run(
          workerId,
          workerNodeId,
          workerInstanceId,
          workerInstanceId,
          protocolVersion,
          capabilitiesJson,
          sha256(capabilitiesJson),
          now,
          now,
          now,
        );
      seedDatabase
        .prepare(`
          INSERT INTO run_attempts (
            id,
            job_id,
            attempt_number,
            worker_id,
            worker_node_id,
            worker_instance_id,
            status,
            lease_token_hash,
            lease_generation,
            lease_expires_at,
            execution_deadline_at,
            no_progress_timeout_ms,
            no_progress_deadline_at,
            last_heartbeat_at,
            phase,
            result_digest,
            result_json,
            started_at,
            ended_at
          ) VALUES (?, ?, 1, ?, ?, ?, 'succeeded', ?, 1, ?, ?, 600000, ?, ?, 'completed', ?, ?, ?, ?)
        `)
        .run(
          runAttemptId,
          jobId,
          workerId,
          workerNodeId,
          workerInstanceId,
          sha256(leaseToken),
          now,
          now,
          now,
          now,
          resultDigest,
          resultJson,
          now,
          now,
        );
      seedDatabase
        .prepare(`
          UPDATE jobs
          SET
            status = 'succeeded',
            attempt_count = 1,
            lease_generation = 1,
            current_run_attempt_id = NULL,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .run(now, now, now, jobId);
    } finally {
      seedDatabase.close();
    }

    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    const fixture = { client, directory, databasePath };
    fixtures.push(fixture);
    await expect(
      client.request("completeLease", {
        jobId,
        runAttemptId,
        workerNodeId,
        workerInstanceId,
        leaseToken,
        leaseGeneration: 1,
        resultDigest,
        result,
      }),
    ).resolves.toEqual({
      jobId,
      runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    });
    withFixtureDatabase(fixture, (database) => {
      expect(
        database
          .prepare("SELECT result_digest, result_json FROM legacy_review_result_replays")
          .get(),
      ).toEqual({ result_digest: resultDigest, result_json: resultJson });
      expect(database.prepare("SELECT COUNT(*) AS count FROM review_results").get()).toEqual({
        count: 0,
      });
    });
  });

  it("rolls back the attempt and result when a projection insert fails", async () => {
    const fixture = await createFixture(false);
    const claim = await scheduleAndClaimReview(
      fixture,
      makeRequestOpenedInput("delivery-review-result-rollback"),
      "rollback",
    );
    withFixtureDatabase(fixture, (database) => {
      database.exec(`
        CREATE TRIGGER test_abort_pr_finding_insert
        BEFORE INSERT ON pr_review_findings
        BEGIN
          SELECT RAISE(ABORT, 'injected PR finding failure');
        END;
      `);
    });
    const result = validPrReviewResult();

    await expect(
      fixture.client.request("completeLease", {
        ...claim.envelope.lease,
        resultDigest: sha256(canonicalJson(result)),
        result,
      }),
    ).rejects.toThrow("injected PR finding failure");
    assertUncommittedReviewCompletion(fixture, claim.envelope.lease.runAttemptId);
  });
});

describe("DatabaseClient scheduling ingestion integration", () => {
  it("atomically projects and schedules an authorized delivery exactly once", async () => {
    const { client } = await createFixture(false);
    const input = makeRequestOpenedInput("delivery-authorized");

    const first = await client.request("ingestSchedulingEvent", input);
    const duplicate = await client.request("ingestSchedulingEvent", input);

    expect(first).toMatchObject({
      outcome: "processed",
      authorized: true,
      jobCreated: true,
      staleJobCount: 0,
      cancelRequestedJobCount: 0,
    });
    expect(first.openedRequestEpochId).not.toBeNull();
    expect(first.jobId).not.toBeNull();
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      eventId: first.eventId,
      workItemId: first.workItemId,
      jobId: first.jobId,
      jobCreated: true,
    });

    const workItems = await client.request("listWorkItems", {
      page: 1,
      pageSize: 20,
      search: "normalized ingestion",
      kind: ["pull_request"],
      state: ["assigned"],
      authorization: ["self"],
    });
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: ["queued"],
      phase: [],
    });
    const system = await client.request("getSystemSnapshot", {});

    expect(workItems.total).toBe(1);
    expect(workItems.items[0]).toMatchObject({
      id: first.workItemId,
      state: "assigned",
      trigger: "assignment",
      authorization: "self",
      latestJobId: first.jobId,
    });
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]).toMatchObject({ id: first.jobId, status: "queued" });
    expect(system.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(system.databaseSizeBytes).toBeGreaterThan(0);
    expect(system.oldestQueuedAt).not.toBeNull();
  });

  it("rejects reuse of a webhook delivery identifier with a different payload", async () => {
    const { client } = await createFixture(false);
    const input = makeRequestOpenedInput("delivery-conflict");
    await client.request("ingestSchedulingEvent", input);

    await expect(
      client.request("ingestSchedulingEvent", {
        ...input,
        delivery: delivery("delivery-conflict", "different-payload"),
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_DELIVERY_CONFLICT" });
  });

  it("inherits an active epoch for one job per new pull request revision", async () => {
    const { client } = await createFixture(false);
    const originalHead = "b".repeat(40);
    const newHead = "c".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-open", originalHead),
    );

    const revision = await client.request(
      "ingestSchedulingEvent",
      makeRevisionObservedInput("delivery-revision", newHead, "2026-08-30T00:01:00.000Z", true),
    );
    const unchanged = await client.request(
      "ingestSchedulingEvent",
      makeRevisionObservedInput(
        "delivery-revision-repeat",
        newHead,
        "2026-08-30T00:02:00.000Z",
        false,
      ),
    );
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: [],
      phase: [],
    });

    expect(revision).toMatchObject({ authorized: true, jobCreated: true, staleJobCount: 1 });
    expect(unchanged).toMatchObject({ authorized: false, jobId: null, jobCreated: false });
    expect(jobs.total).toBe(2);
    expect(jobs.items.map((job) => job.status).sort()).toEqual(["queued", "stale"]);
    expect(
      jobs.items.filter((job) => job.targetRevisionKey === pullRequestRevisionKey(newHead)),
    ).toHaveLength(1);
  });

  it("does not let an equal-timestamp webhook overwrite a canonical polling revision", async () => {
    const { client } = await createFixture(false);
    const originalHead = "4".repeat(40);
    const currentHead = "5".repeat(40);
    const sourceUpdatedAt = "2026-08-30T00:00:10.000Z";
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-equal-time-open", originalHead),
    );

    const canonicalCandidate = makeRevisionObservedInput(
      "poll-equal-time-current",
      currentHead,
      "2026-08-30T00:01:00.000Z",
      true,
    );
    const canonicalEvent = {
      ...canonicalCandidate.event,
      eventId: "poll-equal-time-current",
      source: "poll" as const,
      sourceEventId: "poll-equal-time-current",
      workItem: {
        ...canonicalCandidate.event.workItem,
        updatedAt: sourceUpdatedAt,
      },
      revision: {
        ...canonicalCandidate.event.revision,
        sourceUpdatedAt,
      },
    } satisfies NormalizedSchedulingEvent;
    const canonical = await client.request("ingestSchedulingEvent", {
      event: canonicalEvent,
      policy: schedulingPolicy,
      delivery: null,
      schedule: makeJobSchedule(canonicalEvent),
    });

    const delayedCandidate = makeRevisionObservedInput(
      "delivery-equal-time-delayed",
      originalHead,
      "2026-08-30T00:02:00.000Z",
      true,
    );
    const delayedEvent = {
      ...delayedCandidate.event,
      workItem: {
        ...delayedCandidate.event.workItem,
        updatedAt: sourceUpdatedAt,
      },
      revision: {
        ...delayedCandidate.event.revision,
        sourceUpdatedAt,
      },
    } satisfies NormalizedSchedulingEvent;
    const delayed = await client.request("ingestSchedulingEvent", {
      ...delayedCandidate,
      event: delayedEvent,
      schedule: makeJobSchedule(delayedEvent),
    });
    const workItems = await client.request("listWorkItems", { pageSize: 20 });
    const jobs = await client.request("listJobs", { pageSize: 20 });

    expect(canonical).toMatchObject({ authorized: true, jobCreated: true });
    expect(delayed).toMatchObject({ authorized: false, jobCreated: false });
    expect(workItems.items[0]?.currentRevision).toMatchObject({ headSha: currentHead });
    expect(jobs.items.filter((job) => job.status === "queued")).toHaveLength(1);
    expect(jobs.items.find((job) => job.status === "queued")?.targetRevisionKey).toBe(
      pullRequestRevisionKey(currentHead),
    );
  });

  it("reuses only an identical active-epoch job intent and configuration", async () => {
    const { client } = await createFixture(false);
    const headSha = "c".repeat(40);
    const firstInput = makeRequestOpenedInput("delivery-config-first", headSha);
    const first = await client.request("ingestSchedulingEvent", firstInput);

    const secondInput = makeRequestOpenedInput("delivery-config-second", headSha);
    if (secondInput.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const sharedAcrossEpochs = await client.request("ingestSchedulingEvent", {
      ...secondInput,
      event: { ...secondInput.event, requestKind: "review_request" },
    });
    expect(sharedAcrossEpochs).toMatchObject({
      jobId: first.jobId,
      jobCreated: false,
    });

    if (firstInput.schedule === null) {
      throw new Error("Expected a candidate schedule.");
    }
    const changedIntentInput = makeRequestOpenedInput("delivery-config-intent", headSha);
    const changedIntent = await client.request("ingestSchedulingEvent", {
      ...changedIntentInput,
      schedule: { ...firstInput.schedule, intentVersion: 2 },
    });
    expect(changedIntent).toMatchObject({ jobCreated: true });
    expect(changedIntent.jobId).not.toBe(first.jobId);

    const changedCapabilitiesInput = makeRequestOpenedInput(
      "delivery-config-capabilities",
      headSha,
    );
    const changedCapabilities = await client.request("ingestSchedulingEvent", {
      ...changedCapabilitiesInput,
      schedule: {
        ...firstInput.schedule,
        intentVersion: 2,
        requiredCapabilities: ["static-review"],
      },
    });
    expect(changedCapabilities).toMatchObject({ jobCreated: true });
    expect(changedCapabilities.jobId).not.toBe(changedIntent.jobId);

    const changedTemplateInput = makeRequestOpenedInput("delivery-config-template", headSha);
    const changedPrompt = "Review with the updated policy prompt.";
    const changedTemplate = await client.request("ingestSchedulingEvent", {
      ...changedTemplateInput,
      schedule: {
        ...firstInput.schedule,
        intentVersion: 2,
        requiredCapabilities: ["static-review"],
        executionTemplate: {
          ...firstInput.schedule.executionTemplate,
          prompt: {
            ...firstInput.schedule.executionTemplate.prompt,
            version: "test-2",
            renderedPrompt: changedPrompt,
            promptSha256: sha256(changedPrompt),
          },
        },
      },
    });
    expect(changedTemplate).toMatchObject({ jobCreated: true });
    expect(changedTemplate.jobId).not.toBe(changedCapabilities.jobId);

    const jobs = await client.request("listJobs", { page: 1, pageSize: 20 });
    expect(jobs.total).toBe(4);
  });

  it("fences an old revision even when the event actor is not authorized", async () => {
    const { client } = await createFixture(false);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-fence-original", "b".repeat(40)),
    );
    const untrustedRevision = makeRequestOpenedInput("delivery-fence-untrusted", "f".repeat(40));
    if (untrustedRevision.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const result = await client.request("ingestSchedulingEvent", {
      ...untrustedRevision,
      event: {
        ...untrustedRevision.event,
        actor: { githubUserId: 1234, login: "untrusted", accountType: "user" },
      },
    });
    const jobs = await client.request("listJobs", { page: 1, pageSize: 20 });

    expect(result).toMatchObject({ authorized: false, jobId: null, staleJobCount: 1 });
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]?.status).toBe("stale");
  });

  it("uses the epoch opening policy snapshot for inherited revision decisions", async () => {
    const { client, directory } = await createFixture(false);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-policy-open", "b".repeat(40)),
    );
    const revisionInput = makeRevisionObservedInput(
      "delivery-policy-revision",
      "c".repeat(40),
      "2026-08-30T00:06:00.000Z",
      true,
    );
    await client.request("ingestSchedulingEvent", {
      ...revisionInput,
      policy: {
        ...schedulingPolicy,
        policyVersion: 9,
        allowlistedActorGithubUserIds: [777],
      },
    });
    await client.close();

    const auditDatabase = new DatabaseSync(join(directory, "server.sqlite"));
    try {
      const inherited = auditDatabase
        .prepare(`
          SELECT policy_version, policy_json, policy_sha256
          FROM authorization_decisions
          WHERE basis = 'active_epoch'
        `)
        .get() as unknown as {
        readonly policy_version: number;
        readonly policy_json: string;
        readonly policy_sha256: string;
      };
      expect(inherited.policy_version).toBe(schedulingPolicy.policyVersion);
      expect(JSON.parse(inherited.policy_json)).toEqual(schedulingPolicy);
      expect(inherited.policy_sha256).toBe(sha256(canonicalJson(schedulingPolicy)));
    } finally {
      auditDatabase.close();
    }
  });

  it("requests cancellation when the final active request is removed from a leased job", async () => {
    const { client } = await createFixture(false);
    const headSha = "d".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-before-close", headSha),
    );
    const worker = await registerWorker(client, "worker-close", "instance-close");
    const claim = await claimLease(
      client,
      "worker-close",
      "instance-close",
      worker.capabilitiesDigest,
    );
    expect(claim.outcome).toBe("granted");

    const closed = await client.request(
      "ingestSchedulingEvent",
      makeRequestClosedInput("delivery-close", headSha, "2026-08-30T00:03:00.000Z"),
    );
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: ["cancel_requested"],
      phase: [],
    });
    const workers = await client.request("listWorkers", {
      page: 1,
      pageSize: 20,
      search: "worker-close",
      status: ["online"],
    });

    expect(closed.closedRequestEpochIds).toHaveLength(1);
    expect(closed.activeRequestEpochIds).toEqual([]);
    expect(closed.cancelRequestedJobCount).toBe(1);
    expect(jobs.total).toBe(1);
    expect(jobs.items[0]?.status).toBe("cancel_requested");
    expect(workers.total).toBe(1);
    expect(workers.items[0]).toMatchObject({
      workerNodeId: "worker-close",
      instanceId: "instance-close",
      activeSlots: 1,
    });
  });

  it("projects a reopened work item without reactivating its closed epoch", async () => {
    const { client } = await createFixture(false);
    const headSha = "e".repeat(40);
    await client.request(
      "ingestSchedulingEvent",
      makeRequestOpenedInput("delivery-before-resource-close", headSha),
    );
    const closed = await client.request(
      "ingestSchedulingEvent",
      makeWorkItemClosedInput("delivery-resource-close", headSha, "2026-08-30T00:04:00.000Z"),
    );
    const reopened = await client.request(
      "ingestSchedulingEvent",
      makeWorkItemReopenedInput("delivery-resource-reopen", headSha, "2026-08-30T00:05:00.000Z"),
    );
    const workItems = await client.request("listWorkItems", {
      page: 1,
      pageSize: 20,
      state: "open",
    });

    expect(closed.closedRequestEpochIds).toHaveLength(1);
    expect(closed.staleJobCount).toBe(1);
    expect(reopened).toMatchObject({
      authorized: false,
      activeRequestEpochIds: [],
      openedRequestEpochId: null,
      jobId: null,
      jobCreated: false,
    });
    expect(workItems.total).toBe(1);
    expect(workItems.items[0]?.state).toBe("open");
  });

  it("audits but does not schedule an actor outside the allowlist", async () => {
    const { client } = await createFixture(false);
    const authorizedInput = makeRequestOpenedInput("delivery-denied");
    if (authorizedInput.event.action !== "request_opened") {
      throw new Error("Expected a request_opened event.");
    }
    const deniedInput: IngestSchedulingEventInput = {
      ...authorizedInput,
      event: {
        ...authorizedInput.event,
        actor: { githubUserId: 1234, login: "untrusted", accountType: "user" },
      },
    };

    const result = await client.request("ingestSchedulingEvent", deniedInput);
    const jobs = await client.request("listJobs", {
      page: 1,
      pageSize: 20,
      status: [],
      phase: [],
    });

    expect(result).toMatchObject({
      authorized: false,
      activeRequestEpochIds: [],
      openedRequestEpochId: null,
      jobId: null,
    });
    expect(result.authorizationDecisionIds).toHaveLength(1);
    expect(jobs.total).toBe(0);
  });
});

class ServerBindingDatabaseWorkerTestTransport extends EventEmitter {
  readonly posted: unknown[] = [];
  terminateCalls = 0;
  throwOnPost = false;

  postMessage(value: unknown): void {
    if (this.throwOnPost)
      throw new DOMException("The value could not be cloned.", "DataCloneError");
    this.posted.push(value);
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      "operation" in value &&
      value.operation === "shutdown"
    ) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          id: value.id,
          ok: true,
          output: { closed: true },
        });
        this.emit("exit", 0);
      });
    }
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(1);
  }
}

const attachServerBindingDatabaseClientForTest = async (
  worker: ServerBindingDatabaseWorkerTestTransport,
): Promise<DatabaseClient> => {
  const connecting = attachDatabaseClientForTest(worker as unknown as DatabaseWorkerTransport);
  worker.emit("message", { type: "ready" });
  return connecting;
};

describe("DatabaseClient Server binding persistence capability", () => {
  it("rejects a Server binding persistence operation through the generic request path", async () => {
    const worker = new ServerBindingDatabaseWorkerTestTransport();
    const client = await attachServerBindingDatabaseClientForTest(worker);
    let getterCalls = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });

    const request = Reflect.apply(client.request, client, [
      "initializeServerBindingIssuerV1",
      input,
    ]) as Promise<unknown>;

    await expect(request).rejects.toMatchObject({
      name: "DatabaseRequestError",
      code: "SERVER_BINDING_PERSISTENCE_AUTHORITY_REQUIRED",
    });
    expect(getterCalls).toBe(0);
    expect(worker.posted).toEqual([]);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("issues the Server binding persistence handle only once", async () => {
    const worker = new ServerBindingDatabaseWorkerTestTransport();
    const client = await attachServerBindingDatabaseClientForTest(worker);

    const handle = client.createServerBindingPersistenceDatabaseHandle();

    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(() => client.createServerBindingPersistenceDatabaseHandle()).toThrow(/already issued/u);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("revokes an unconsumed Server binding persistence handle without blocking close", async () => {
    const worker = new ServerBindingDatabaseWorkerTestTransport();
    const client = await attachServerBindingDatabaseClientForTest(worker);
    client.createServerBindingPersistenceDatabaseHandle();

    const close = client.close();

    expect(client.close()).toBe(close);
    await expect(close).resolves.toBeUndefined();
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ operation: "shutdown" });
    expect(worker.terminateCalls).toBe(0);
  });

  it("preserves fatal error codes and revokes an unconsumed persistence handle", async () => {
    const worker = new ServerBindingDatabaseWorkerTestTransport();
    const client = await attachServerBindingDatabaseClientForTest(worker);
    const handle = client.createServerBindingPersistenceDatabaseHandle();

    worker.emit("message", {
      type: "fatal",
      error: {
        name: "ServerBindingPersistenceErrorV1",
        message: "The durable Server binding state is invalid.",
        code: "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
      },
    });
    worker.emit("exit", 1);

    await expect(
      client.request("listJobs", { page: 1, pageSize: 1, status: [], phase: [] }),
    ).rejects.toMatchObject({
      name: "DatabaseRequestError",
      code: "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    });
    expect(() => new ServerBindingCoordinatorV1({ database: handle })).toThrow(
      /consumed or forged/u,
    );
    await expect(client.close()).rejects.toMatchObject({
      code: "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    });
  });

  it("removes a request when postMessage fails before sending", async () => {
    const worker = new ServerBindingDatabaseWorkerTestTransport();
    const client = await attachServerBindingDatabaseClientForTest(worker);
    worker.throwOnPost = true;

    await expect(client.request("ping", {})).rejects.toMatchObject({
      name: "DatabaseRequestError",
      code: "DATABASE_REQUEST_NOT_SENT",
    });
    worker.throwOnPost = false;
    await expect(client.close()).resolves.toBeUndefined();
    expect(worker.terminateCalls).toBe(0);
  });
});
