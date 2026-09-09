import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PrReviewPlanV2ModelOutputSchema, type ValidationJobResultV1 } from "@agentic-review/codex";
import type {
  JobExecutionEnvelopeV2,
  OperatorPrincipal,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationProfileConfig,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import { handleRepositoryConfigurationRequest } from "../../dist/database/managed-repositories.js";
import { runMigrations } from "../../dist/database/migrations.js";
import type { DatabaseWorkerOptions } from "../../dist/database/protocol.js";
import type { ReviewRunDetail } from "../../dist/database/review-runs.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const actor = { issuer: "https://identity.example.test", subject: "evidence-control-plane" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const workerNodeId = "evidence-integration-node";
const workerInstanceId = "evidence-integration-instance";
const workerTokenSha256 = sha256("evidence-integration-token");
const capabilities: WorkerCapabilities = {
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  cliEngine: "codex",
  cliVersion: "test",
  recipeIds: [],
  labels: { executionEnvelope: "2", validationHeadless: "1", evidenceDelivery: "1" },
};
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The dispatch fixture is incomplete.");
  return value;
}

function openedEvent(repositoryNumber: number, at: string): SchedulingRequestOpenedEvent {
  const repository = {
    githubRepositoryId: repositoryNumber,
    githubNodeId: `repository-${repositoryNumber}`,
    ownerLogin: "example",
    name: `project-${repositoryNumber}`,
    fullName: `example/project-${repositoryNumber}`,
    htmlUrl: `https://github.com/example/project-${repositoryNumber}`,
    defaultBranch: "main",
    isPrivate: false,
  };
  const githubWorkItemId = repositoryNumber * 1000 + 1;
  return {
    contractVersion: 1,
    eventId: `dispatch-open-${repositoryNumber}`,
    source: "webhook",
    sourceEventId: `dispatch-delivery-${repositoryNumber}`,
    occurredAt: at,
    observedAt: at,
    repository,
    author: reviewer,
    actor: reviewer,
    target: reviewer,
    action: "request_opened",
    requestKind: "review_request",
    workItem: {
      kind: "pull_request",
      githubRepositoryId: repositoryNumber,
      githubWorkItemId,
      githubNodeId: `PR_${githubWorkItemId}`,
      number: 1,
      title: "Validate the settings change",
      body: "Operator dispatch integration fixture.",
      state: "open",
      author: reviewer,
      htmlUrl: `${repository.htmlUrl}/pull/1`,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      isDraft: false,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: repositoryNumber,
      githubWorkItemId,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revisionKey: sha256(`${"a".repeat(40)}\0${"b".repeat(40)}`),
      observedAt: at,
      sourceUpdatedAt: at,
    },
  };
}

interface Source {
  repositoryId: string;
  workItemId: string;
  revisionKey: string;
}

function seedSource(database: DatabaseSync, number: number, at: string): Source {
  const event = openedEvent(number, at);
  if (event.workItem.kind !== "pull_request" || event.revision.kind !== "pull_request")
    throw new Error("The dispatch fixture requires a pull request.");
  const renderedPrompt = "Review the exact source revision.";
  const opened = ingestSchedulingEvent(database, {
    event,
    policy,
    allowScheduling: true,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "pull_request",
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: at,
    },
    schedule: {
      jobKind: "pull_request_review",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: {
        repository: { githubRepositoryId: number, fullName: event.repository.fullName },
        resource: {
          kind: "pull_request",
          githubNodeId: event.workItem.githubNodeId,
          number: 1,
          title: event.workItem.title,
          author: reviewer,
          canonicalSnapshot: event.workItem,
          baseSha: event.revision.baseSha,
          headSha: event.revision.headSha,
          isDraft: false,
        },
        prompt: {
          name: "review",
          version: "fixture",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: PrReviewPlanV2ModelOutputSchema,
          outputSchemaSha256: sha256(canonicalJson(PrReviewPlanV2ModelOutputSchema)),
        },
        executionPolicy: {
          hardTimeoutMs: 600_000,
          noProgressTimeoutMs: 120_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
  });
  // Only the legacy authorization fixture is seeded. Every validation job is created by RPC.
  database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(present(opened.jobId));
  return {
    repositoryId: opened.repositoryId,
    workItemId: opened.workItemId,
    revisionKey: event.revision.revisionKey,
  };
}

function profileConfig(): ValidationProfileConfig {
  return {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    test: [],
    launch: [],
    cleanup: [],
    build: [
      {
        id: "compile",
        name: "Compile",
        required: true,
        timeoutMs: 10_000,
        command: {
          executable: "node",
          args: ["--version"],
          workingDirectory: ".",
          environment: [],
        },
      },
    ],
    requiredCapabilities: [],
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
  };
}

export interface EvidenceControlPlaneFixture {
  readonly client: DatabaseClient;
  readonly run: ReviewRunDetail;
  readonly evidenceDirectory: string;
  readonly query: { repositoryId: string; reviewRunId: string };
  claimAll(): Promise<JobExecutionEnvelopeV2[]>;
  restart(): Promise<void>;
  closeOwner(): Promise<void>;
  dispose(): Promise<void>;
  heartbeat(
    envelope: JobExecutionEnvelopeV2,
    sequence?: number,
  ): ReturnType<DatabaseClient["request"]>;
  cancel(envelope: JobExecutionEnvelopeV2): Promise<unknown>;
  closeSource(): Promise<unknown>;
  supersedeWorker(): Promise<unknown>;
  read<T>(action: (reader: DatabaseSync) => T): T;
}

export async function createEvidenceControlPlaneFixture(
  profileCount = 2,
  administrators?: readonly OperatorPrincipal[],
  integrationOptions: {
    readonly publicationPublisher?: { readonly githubUserId: number };
    readonly createClient?: (options: DatabaseWorkerOptions) => Promise<DatabaseClient>;
  } = {},
): Promise<EvidenceControlPlaneFixture> {
  const directory = await mkdtemp(join(tmpdir(), "evidence-control-plane-"));
  const databaseDirectory = join(directory, "database");
  const evidenceDirectory = join(directory, "evidence");
  await mkdir(databaseDirectory, { mode: 0o700 });
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "server.sqlite");
  const database = new DatabaseSync(databasePath);
  let source: Source;
  const at = new Date(Date.now() - 60_000).toISOString();
  try {
    database.exec("PRAGMA foreign_keys = ON");
    runMigrations(database, migrationsDirectory);
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "bootstrapManagedRepositories",
        input: {
          repositories: [{ githubRepositoryId: 1, fullName: "example/project-1" }],
          reviewer,
          authorizationPolicy: policy,
        },
      },
      at,
    );
    source = seedSource(database, 1, at);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
  const options = {
    databasePath,
    migrationsDirectory,
    startupTimeoutMilliseconds: 10_000,
    ...(integrationOptions.publicationPublisher === undefined
      ? {}
      : { publicationPublisher: integrationOptions.publicationPublisher }),
    ...(administrators === undefined
      ? {}
      : { operatorAccess: { administrators: structuredClone(administrators) } }),
    evidenceStorage: {
      evidenceDirectory,
      globalQuotaBytes: 512 * 1024 * 1024,
      globalAssetLimit: 1024,
      retentionMs: 60 * 60 * 1000,
      incompleteUploadTtlMs: 60 * 60 * 1000,
    },
  };
  const createClient = integrationOptions.createClient ?? ((input) => DatabaseClient.create(input));
  let client = await createClient(options);
  try {
    await client.request("createWorkerNodeCredential", {
      workerNodeId,
      displayName: workerNodeId,
      workerTokenSha256,
      createdByIssuer: actor.issuer,
      createdBySubject: actor.subject,
    });
    const register = (instance: string) =>
      client.request("registerWorker", {
        protocolVersion: "1.0",
        workerNodeId,
        workerInstanceId: instance,
        workerTokenSha256,
        displayName: instance,
        workerVersion: "test",
        maxSlots: profileCount,
        capabilities,
      });
    const worker = await register(workerInstanceId);
    const template = await client.request("createPromptTemplate", {
      actor,
      request: {
        name: "Evidence integration",
        workflowKind: "pr_static_build",
        content: "Review the exact source revision.",
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const prompt = await client.request("publishPromptDraft", {
      templateId: template.id,
      actor,
      request: { expectedVersion: template.version },
    });
    await client.request("savePromptBinding", {
      repositoryId: source.repositoryId,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 0, promptVersionId: prompt.id },
    });
    const profileIds: string[] = [];
    for (let index = 0; index < profileCount; index += 1) {
      const profile = await client.request("publishValidationProfile", {
        repositoryId: source.repositoryId,
        actor,
        request: {
          name: `Evidence build ${index + 1}`,
          workflowKind: "pr_static_build",
          target: "headless",
          required: true,
          config: profileConfig(),
          outputSchemaVersion: "PrReviewPlanV2",
        },
      });
      await client.request("saveValidationProfileBinding", {
        repositoryId: source.repositoryId,
        profileId: profile.profileId,
        actor,
        request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
      });
      profileIds.push(profile.profileId);
    }
    const run = await client.request("createOperatorReviewRun", {
      repositoryId: source.repositoryId,
      workItemId: source.workItemId,
      actor,
      request: {
        activationId: "evidence-integration-activation",
        expectedRevisionKey: source.revisionKey,
        profileIds,
      },
    });
    const query = { repositoryId: source.repositoryId, reviewRunId: run.id };
    return {
      get client() {
        return client;
      },
      run,
      query,
      evidenceDirectory,
      async claimAll() {
        const envelopes: JobExecutionEnvelopeV2[] = [];
        for (let index = 0; index < profileCount; index += 1) {
          const claim = await client.request("claimLease", {
            workerNodeId,
            workerInstanceId,
            availableSlots: profileCount - index,
            capabilitiesDigest: worker.capabilitiesDigest,
            protocolVersion: "1.0",
            leaseTtlSeconds: 300,
          });
          if (claim.outcome !== "granted" || claim.envelope.envelopeVersion !== 2)
            throw new Error("Expected a validation lease.");
          envelopes.push(claim.envelope);
        }
        return envelopes;
      },
      async restart() {
        await client.close();
        client = await createClient(options);
      },
      closeOwner: () => client.close(),
      async dispose() {
        try {
          await client.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      heartbeat: (envelope, sequence = 1) =>
        client.request("heartbeatLease", {
          ...envelope.lease,
          phase: "validation",
          progressSequence: sequence,
          progress: {},
          leaseTtlSeconds: 300,
        }),
      cancel: (envelope) =>
        client.request("cancelValidationJob", {
          ...query,
          requestId: envelope.validation.requestId,
          jobId: envelope.job.jobId,
          actor,
        }),
      async closeSource() {
        const time = new Date().toISOString();
        const opened = openedEvent(1, at);
        const event = {
          ...opened,
          eventId: "evidence-source-closed",
          sourceEventId: "evidence-source-close-delivery",
          occurredAt: time,
          observedAt: time,
          action: "work_item_closed" as const,
          requestKind: null,
          target: null,
          closeReason: "work_item_closed" as const,
          workItem: {
            ...opened.workItem,
            state: "closed" as const,
            updatedAt: time,
            closedAt: time,
          },
        };
        return client.request("ingestSchedulingEvent", {
          event,
          policy,
          schedule: null,
          delivery: {
            deliveryId: event.sourceEventId,
            eventName: "pull_request",
            receivedAt: time,
            payloadSha256: sha256(canonicalJson(event)),
          },
        });
      },
      supersedeWorker: () => register("superseding-evidence-instance"),
      read<T>(action: (reader: DatabaseSync) => T): T {
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return action(reader);
        } finally {
          reader.close();
        }
      },
    };
  } catch (error) {
    await client.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Upload fixed-size blocks through the real protocol; no manifest or result row is forged. */
export async function uploadEvidence(
  fixture: EvidenceControlPlaneFixture,
  envelope: JobExecutionEnvelopeV2,
  clientAssetId: string,
  sizeBytes = 8 * 1024 * 1024,
  finalize = true,
): Promise<string> {
  const chunk = Buffer.alloc(Math.min(sizeBytes, 512 * 1024), 97 + (clientAssetId.length % 26));
  const whole = createHash("sha256");
  for (let offset = 0; offset < sizeBytes; offset += chunk.length)
    whole.update(chunk.subarray(0, Math.min(chunk.length, sizeBytes - offset)));
  const begun = await fixture.client.request("beginEvidenceUpload", {
    lease: envelope.lease,
    clientAssetId,
    metadata: {
      kind: "log",
      mediaType: "text/plain",
      sizeBytes,
      sha256: whole.digest("hex"),
      capturedAt: new Date().toISOString(),
      checkId: `${envelope.validation.profileVersion.id}:compile`,
    },
  });
  for (let offset = 0; offset < sizeBytes; offset += chunk.length) {
    const bytes = chunk.subarray(0, Math.min(chunk.length, sizeBytes - offset));
    await fixture.client.request("appendEvidenceChunk", {
      lease: envelope.lease,
      assetId: begun.assetId,
      offset,
      base64: bytes.toString("base64"),
      chunkSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (finalize)
    await fixture.client.request("finalizeEvidenceUpload", {
      lease: envelope.lease,
      assetId: begun.assetId,
    });
  return begun.assetId;
}

export function completion(envelope: JobExecutionEnvelopeV2, evidenceIds: string[]) {
  const checkId = `${envelope.validation.profileVersion.id}:compile`;
  const result: ValidationJobResultV1 = {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      sourceState: "original",
      summary: "The real evidence integration completed.",
      checks: [
        {
          id: checkId,
          name: "Compile",
          kind: "build",
          required: true,
          source: "runner",
          outcome: "passed",
          summary: "Compilation passed.",
          expected: "Exit code 0",
          actual: "Exit code 0",
          evidenceIds,
        },
      ],
    },
    execution: {
      blockers: [],
      cleanupState: "not_needed",
      diagnostics: [
        {
          stepId: checkId,
          phase: "build",
          outcome: "passed",
          exitCode: 0,
          summary: "Compilation passed.",
        },
      ],
    },
    modelReview: { state: "not_requested" },
  };
  return { ...envelope.lease, resultDigest: sha256(canonicalJson(result)), result };
}

export const resultQuery = (
  fixture: EvidenceControlPlaneFixture,
  envelope: JobExecutionEnvelopeV2,
) => ({
  ...fixture.query,
  requestId: envelope.validation.requestId,
  jobId: envelope.job.jobId,
});
