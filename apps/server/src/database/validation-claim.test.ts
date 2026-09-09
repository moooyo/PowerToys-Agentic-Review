import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ActiveAuthorizedRequestEpoch,
  AuthorizationDecision,
  GitHubPullRequest,
  GitHubPullRequestRevision,
  GitHubRepository,
  JobExecutionTemplate,
  JobExecutionTemplateV2,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
  ValidationJobContext,
  ValidationProfileVersion,
  ValidationTarget,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { createJobAdmissionInTransaction } from "../../dist/database/job-admission.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const profileTimestamp = "2026-09-07T00:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const revisionKey = sha256(`${baseSha}\0${headSha}`);

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

const legacyTemplate = {
  repository: { githubRepositoryId: 1, fullName: "microsoft/PowerToys" },
  resource: {
    kind: "pull_request",
    githubNodeId: "PR_validation_claim",
    number: 1,
    title: "Validate the selected profile",
    author: { githubUserId: 7, login: "contributor" },
    canonicalSnapshot: {},
    baseSha,
    headSha,
    isDraft: false,
  },
  prompt: {
    name: "validation-claim",
    version: "fixture",
    renderedPrompt: "Review the exact pull request revision.",
    promptSha256: sha256("Review the exact pull request revision."),
    outputSchema: {},
    outputSchemaSha256: sha256("{}"),
  },
  executionPolicy: {
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
    allowedRecipeIds: [],
    requiredCapabilityLabels: {},
  },
} satisfies JobExecutionTemplate;

const targetCases = [
  { target: "headless", capabilityLabel: "validationHeadless" },
  { target: "windows_desktop", capabilityLabel: "validationWindowsDesktop" },
  { target: "web", capabilityLabel: "validationWeb" },
] as const satisfies readonly { target: ValidationTarget; capabilityLabel: string }[];

const legacyWorkers: { name: string; labels: WorkerCapabilities["labels"] }[] = [
  { name: "a legacy Worker", labels: {} },
  { name: "a Worker with envelope support alone", labels: { executionEnvelope: "2" } },
];

const profileVersion = (target: ValidationTarget, profileId: string): ValidationProfileVersion => {
  const config: ValidationProfileVersion["config"] = {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [],
    test: [
      {
        id: "check",
        name: "Run the selected profile check",
        command: {
          executable: "dotnet",
          args: ["test", "--no-restore"],
          workingDirectory: ".",
          environment: [],
        },
        timeoutMs: 60_000,
        required: true,
      },
    ],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
  };
  const common = {
    id: `${profileId}-version-1`,
    profileId,
    repositoryId: "repository-1",
    version: 1,
    name: `Validation profile ${profileId}`,
    config,
    configSha256: sha256(canonicalJson(config)),
    required: true,
    createdAt: profileTimestamp,
    publishedAt: profileTimestamp,
    createdBy: "validation-claim-test",
  };
  return target === "headless"
    ? { ...common, workflowKind: "pr_static_build", target, outputSchemaVersion: "PrReviewPlanV2" }
    : { ...common, workflowKind: "pr_ui", target, outputSchemaVersion: "ValidationReportV1" };
};

const validationTemplate = (
  target: ValidationTarget,
  profileId = "profile-selected",
): JobExecutionTemplateV2 => {
  const selectedProfile = profileVersion(target, profileId);
  const validation: ValidationJobContext = {
    schemaVersion: "ValidationJobContextV1",
    runId: "review-run-1",
    planDigest: sha256("frozen-plan-with-selected-and-sibling-profiles"),
    activationId: "activation-1",
    requestId: `request-${profileId}`,
    jobActivation: 1,
    repositoryId: "repository-1",
    workItemId: "work-item-1",
    revisionKey,
    requestEpochId: "request-epoch-1",
    workflowKind: selectedProfile.workflowKind,
    target,
    required: true,
    profileVersion: selectedProfile,
    promptVersion: {
      id: `prompt-${profileId}-version-1`,
      templateId: `prompt-${profileId}`,
      version: 1,
      contentSha256: legacyTemplate.prompt.promptSha256,
    },
    requiredCheckIds: [`${selectedProfile.id}:check`],
    testedSourceRevision: { kind: "pull_request", baseSha, headSha },
    testedSourceAuthorization: null,
  };
  return { ...legacyTemplate, validation };
};

interface SeedJob {
  readonly id: string;
  readonly priority: number;
  readonly template: JobExecutionTemplate;
  readonly status?: "queued" | "retry_waiting";
  readonly concurrencyKey?: string;
}

interface SeedRepository {
  readonly id: string;
  readonly githubRepositoryId: number;
  readonly fullName: string;
  readonly enabled?: boolean;
  readonly configurationSource?: "operator" | "discovered";
}

interface DatabaseFixture {
  readonly client: DatabaseClient;
  readonly directory: string;
  readonly databasePath: string;
}

const fixtures: DatabaseFixture[] = [];

const insertRow = (database: DatabaseSync, table: string, row: Record<string, SQLInputValue>) => {
  const fields = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
};

// These are pre-admitted claim-fence fixtures, not dispatch or admission-selector fixtures.
// V2 still needs the exact repository, work item and epoch identity required by ownership guards.
const seedValidationSource = (
  database: DatabaseSync,
  template: JobExecutionTemplateV2,
  now: string,
): void => {
  const { validation, resource } = template;
  if (resource.kind !== "pull_request") throw new Error("Expected a pull request claim fixture.");
  expect(validation.profileVersion.repositoryId).toBe(validation.repositoryId);
  expect(validation.revisionKey).toBe(revisionKey);
  const existing = database
    .prepare(`SELECT item.repository_id, item.github_node_id, item.github_number, item.current_revision_key,
      repository.github_repository_id, epoch.id AS request_epoch_id
      FROM work_items AS item JOIN repositories AS repository ON repository.id = item.repository_id
      JOIN request_epochs AS epoch ON epoch.work_item_id = item.id
      WHERE item.id = ? AND epoch.id = ?`)
    .get(validation.workItemId, validation.requestEpochId);
  if (existing !== undefined) {
    expect(existing).toMatchObject({
      repository_id: validation.repositoryId,
      github_repository_id: template.repository.githubRepositoryId,
      github_node_id: resource.githubNodeId,
      github_number: resource.number,
      current_revision_key: validation.revisionKey,
      request_epoch_id: validation.requestEpochId,
    });
    return;
  }
  const [ownerLogin, name] = template.repository.fullName.split("/");
  if (!ownerLogin || !name) throw new Error("Expected an exact fixture repository name.");
  const repository: GitHubRepository = {
    ...template.repository,
    githubNodeId: `repository-node-${template.repository.githubRepositoryId}`,
    ownerLogin,
    name,
    htmlUrl: `https://github.com/${template.repository.fullName}`,
    defaultBranch: "main",
    isPrivate: false,
  };
  const workItem: GitHubPullRequest = {
    kind: "pull_request",
    githubWorkItemId: template.repository.githubRepositoryId * 1_000_000 + resource.number,
    githubNodeId: resource.githubNodeId,
    githubRepositoryId: repository.githubRepositoryId,
    number: resource.number,
    title: resource.title,
    body: "Synthetic claim-fence source.",
    state: "open",
    author: resource.author,
    htmlUrl: `${repository.htmlUrl}/pull/${resource.number}`,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isDraft: resource.isDraft,
  };
  const revision: GitHubPullRequestRevision = {
    kind: "pull_request",
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    revisionKey: validation.revisionKey,
    baseSha: resource.baseSha,
    headSha: resource.headSha,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  const eventId = `event-${validation.requestEpochId}`;
  const revisionId = `revision-${validation.workItemId}`;
  const decisionId = `decision-${validation.requestEpochId}`;
  const event: SchedulingRequestOpenedEvent = {
    contractVersion: 1,
    eventId,
    source: "reconciliation",
    sourceEventId: eventId,
    occurredAt: now,
    observedAt: now,
    repository,
    workItem,
    revision,
    author: resource.author,
    action: "request_opened",
    requestKind: "review_request",
    actor: resource.author,
    target: resource.author,
  };
  const policy: SelfOrAllowlistPolicy = {
    kind: "self_or_allowlist",
    policyVersion: 1,
    schedulingTargetGithubUserId: resource.author.githubUserId,
    allowlistedActorGithubUserIds: [],
    unknownActorPolicy: "deny",
    newRevisionPolicy: "require_new_authorization",
  };
  const decision: AuthorizationDecision = {
    eventId,
    outcome: "authorized",
    basis: "self",
    reason: "authorized_self",
    policyKind: policy.kind,
    policyVersion: policy.policyVersion,
    actorGithubUserId: resource.author.githubUserId,
    targetGithubUserId: resource.author.githubUserId,
    inheritedFromEpochId: null,
    evaluatedAt: now,
  };
  const epoch: ActiveAuthorizedRequestEpoch = {
    requestEpochId: validation.requestEpochId,
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    requestKind: "review_request",
    sequence: 1,
    target: resource.author,
    openedByActor: resource.author,
    authorizationBasis: "self",
    authorizationPolicyVersion: 1,
    openedByEventId: eventId,
    openedAt: now,
    currentRevision: revision,
    status: "active",
    closedByEventId: null,
    closedAt: null,
    closeReason: null,
  };
  insertRow(database, "repositories", {
    id: validation.repositoryId,
    github_repository_id: repository.githubRepositoryId,
    github_node_id: repository.githubNodeId,
    owner_login: repository.ownerLogin,
    name: repository.name,
    full_name: repository.fullName,
    html_url: repository.htmlUrl,
    default_branch: repository.defaultBranch,
    is_private: 0,
    snapshot_json: canonicalJson(repository),
    observed_at: now,
    created_at: now,
    updated_at: now,
  });
  insertRow(database, "work_items", {
    id: validation.workItemId,
    repository_id: validation.repositoryId,
    resource_kind: workItem.kind,
    github_work_item_id: workItem.githubWorkItemId,
    github_node_id: workItem.githubNodeId,
    github_number: workItem.number,
    state: workItem.state,
    title: workItem.title,
    body: workItem.body,
    html_url: workItem.htmlUrl,
    author_github_user_id: resource.author.githubUserId,
    author_login: resource.author.login,
    author_account_type: resource.author.accountType ?? "user",
    current_revision_key: revision.revisionKey,
    is_draft: Number(workItem.isDraft),
    source_created_at: now,
    source_updated_at: now,
    snapshot_json: canonicalJson(workItem),
    projection_source: "reconciliation",
    observed_at: now,
    created_at: now,
    updated_at: now,
  });
  insertRow(database, "work_item_revisions", {
    id: revisionId,
    work_item_id: validation.workItemId,
    revision_key: revision.revisionKey,
    resource_kind: revision.kind,
    base_sha: revision.baseSha,
    head_sha: revision.headSha,
    source_updated_at: now,
    observed_at: now,
    revision_json: canonicalJson(revision),
    created_at: now,
  });
  insertRow(database, "github_events", {
    id: eventId,
    event_key: eventId,
    source: event.source,
    source_event_id: eventId,
    repository_id: validation.repositoryId,
    work_item_id: validation.workItemId,
    revision_id: revisionId,
    action: event.action,
    request_kind: event.requestKind,
    actor_github_user_id: resource.author.githubUserId,
    actor_login: resource.author.login,
    target_github_user_id: resource.author.githubUserId,
    target_login: resource.author.login,
    occurred_at: now,
    observed_at: now,
    normalized_sha256: sha256(canonicalJson(event)),
    normalized_json: canonicalJson(event),
    created_at: now,
  });
  insertRow(database, "authorization_decisions", {
    id: decisionId,
    decision_key: decisionId,
    github_event_id: eventId,
    work_item_id: validation.workItemId,
    outcome: decision.outcome,
    basis: decision.basis,
    reason: decision.reason,
    policy_kind: policy.kind,
    policy_version: policy.policyVersion,
    actor_github_user_id: resource.author.githubUserId,
    target_github_user_id: resource.author.githubUserId,
    evaluated_at: now,
    policy_json: canonicalJson(policy),
    policy_sha256: sha256(canonicalJson(policy)),
    decision_json: canonicalJson(decision),
    created_at: now,
  });
  insertRow(database, "request_epochs", {
    id: validation.requestEpochId,
    work_item_id: validation.workItemId,
    ordinal: 1,
    request_kind: epoch.requestKind,
    target_github_user_id: resource.author.githubUserId,
    opening_event_id: eventId,
    authorization_decision_id: decisionId,
    current_revision_id: revisionId,
    status: epoch.status,
    opened_at: now,
    epoch_json: canonicalJson(epoch),
    created_at: now,
    updated_at: now,
  });
};

const createFixture = async (
  jobs: readonly SeedJob[],
  repositories: readonly SeedRepository[] = [],
): Promise<DatabaseFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-validation-claim-"));
  const databasePath = join(directory, "server.sqlite");
  try {
    const seedDatabase = new DatabaseSync(databasePath);
    try {
      runMigrations(seedDatabase, migrationsDirectory);
      const now = new Date(Date.now() - 60_000).toISOString();
      seedDatabase.exec("BEGIN IMMEDIATE");
      const configuredRepositories = new Map(
        repositories.map((repository) => [repository.id, repository]),
      );
      for (const { template } of jobs) {
        if (!("validation" in template)) continue;
        const repository = configuredRepositories.get(template.validation.repositoryId);
        if (repository !== undefined) {
          expect(repository.githubRepositoryId).toBe(template.repository.githubRepositoryId);
          expect(repository.fullName).toBe(template.repository.fullName);
        } else {
          configuredRepositories.set(template.validation.repositoryId, {
            id: template.validation.repositoryId,
            ...template.repository,
          });
        }
      }
      const insertRepository = seedDatabase.prepare(`
        INSERT INTO managed_repositories (
          id, github_repository_id, full_name, enabled, version, connection_status,
          configuration_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'unknown', ?, ?, ?)
      `);
      for (const repository of configuredRepositories.values()) {
        insertRepository.run(
          repository.id,
          repository.githubRepositoryId,
          repository.fullName,
          Number(repository.enabled ?? true),
          repository.configurationSource ?? "operator",
          now,
          now,
        );
      }
      const insert = seedDatabase.prepare(`
        INSERT INTO jobs (
          id, work_item_id, request_epoch_id, job_kind, semantic_key, concurrency_key, status, priority,
          execution_json, execution_digest, required_capabilities_json,
          resource_revision, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pull_request_review', ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
      `);
      for (const job of jobs) {
        if ("validation" in job.template) seedValidationSource(seedDatabase, job.template, now);
        const executionJson = canonicalJson(job.template);
        // Empty stored capability requirements isolate the mandatory claim-time executor fence.
        insert.run(
          job.id,
          "validation" in job.template ? job.template.validation.workItemId : null,
          "validation" in job.template ? job.template.validation.requestEpochId : null,
          `validation-claim:${job.id}`,
          job.concurrencyKey ?? "microsoft/PowerToys#1",
          job.status ?? "queued",
          job.priority,
          executionJson,
          sha256(executionJson),
          revisionKey,
          now,
          now,
          now,
        );
        const admission = createJobAdmissionInTransaction(seedDatabase, job.id, now);
        expect(admission).toMatchObject({
          state: "pending",
          attemptBase: 0,
          ownershipState: "resolved",
        });
        expect(
          seedDatabase
            .prepare(
              "UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ? AND state = 'pending' AND attempt_base = 0",
            )
            .run(now, job.id).changes,
        ).toBe(1);
        if ("validation" in job.template) {
          insertRow(seedDatabase, "job_request_epochs", {
            job_id: job.id,
            request_epoch_id: job.template.validation.requestEpochId,
            linked_at: now,
          });
        }
      }
      seedDatabase.exec("COMMIT");
    } finally {
      seedDatabase.close();
    }
    if (process.platform !== "win32") {
      await chmod(databasePath, 0o600);
    }
    await writeFile(
      databaseInitializationMarkerPath(databasePath),
      databaseInitializationMarkerContent,
      { mode: 0o600 },
    );
    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    const fixture = { client, directory, databasePath };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

const readJobState = (fixture: DatabaseFixture, jobId: string) => {
  const database = new DatabaseSync(fixture.databasePath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return database
      .prepare(`
        SELECT status, failure_code, current_run_attempt_id, attempt_count, lease_generation,
          (SELECT COUNT(*) FROM run_attempts WHERE job_id = jobs.id) AS run_attempt_count
        FROM jobs WHERE id = ?
      `)
      .get(jobId);
  } finally {
    database.close();
  }
};

const expectUnclaimed = (
  fixture: DatabaseFixture,
  jobId: string,
  status: "queued" | "retry_waiting" = "queued",
): void => {
  expect(readJobState(fixture, jobId)).toEqual({
    status,
    failure_code: null,
    current_run_attempt_id: null,
    attempt_count: 0,
    lease_generation: 0,
    run_attempt_count: 0,
  });
};

const registerAndClaim = async (
  fixture: DatabaseFixture,
  labels: WorkerCapabilities["labels"],
  workerSuffix = "validation-claim",
) => {
  const workerNodeId = `worker-${workerSuffix}`;
  const workerInstanceId = `instance-${workerSuffix}`;
  const workerTokenSha256 = sha256(`${workerSuffix}-worker-token`);
  await fixture.client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: "https://issuer.example.test",
    createdBySubject: "validation-claim-test",
  });
  const capabilities: WorkerCapabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: true,
    codexVersion: "test",
    recipeIds: [],
    labels,
  };
  const worker = await fixture.client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerTokenSha256,
    workerInstanceId,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 1,
    capabilities,
  });
  return fixture.client.request("claimLease", {
    workerNodeId,
    workerInstanceId,
    availableSlots: 1,
    capabilitiesDigest: worker.capabilitiesDigest,
    protocolVersion: "1.0",
    leaseTtlSeconds: 300,
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
    throw new AggregateError(cleanupErrors, "Validation claim fixture cleanup failed.");
  }
});

describe.skipIf(process.platform !== "linux").each(targetCases)(
  "validation lease claims for $target",
  ({ target, capabilityLabel }) => {
    const incompatibleWorkers: {
      name: string;
      labels: WorkerCapabilities["labels"];
    }[] = [
      { name: "a legacy Worker", labels: {} },
      { name: "envelope support alone", labels: { executionEnvelope: "2" } },
      { name: "target support alone", labels: { [capabilityLabel]: "1" } },
      {
        name: "an older envelope version",
        labels: { executionEnvelope: "1", [capabilityLabel]: "1" },
      },
      {
        name: "an unsupported target capability version",
        labels: { executionEnvelope: "2", [capabilityLabel]: "2" },
      },
      {
        name: "the other targets' capabilities",
        labels: {
          executionEnvelope: "2",
          ...Object.fromEntries(
            targetCases
              .filter((candidate) => candidate.target !== target)
              .map((candidate) => [candidate.capabilityLabel, "1"]),
          ),
        },
      },
      {
        name: "unrecognized target capability labels",
        labels: {
          executionEnvelope: "2",
          validationTarget: target,
          [`${capabilityLabel}V2`]: "1",
        },
      },
    ];

    it.each(incompatibleWorkers)("does not allocate an attempt for $name", async ({ labels }) => {
      const fixture = await createFixture([
        { id: "validation-selected", priority: 100, template: validationTemplate(target) },
      ]);

      expect(await registerAndClaim(fixture, labels)).toMatchObject({ outcome: "no_work" });
      expectUnclaimed(fixture, "validation-selected");
    });

    it("grants v2 with only the selected profile context to a compatible Worker", async () => {
      const selected = validationTemplate(target);
      const sibling = validationTemplate(target, "profile-sibling");
      const fixture = await createFixture([
        { id: "validation-selected", priority: 100, template: selected },
        { id: "validation-sibling", priority: 50, template: sibling },
      ]);

      const claim = await registerAndClaim(fixture, {
        executionEnvelope: "2",
        [capabilityLabel]: "1",
      });
      expect(claim.outcome).toBe("granted");
      if (claim.outcome !== "granted" || claim.envelope.envelopeVersion !== 2) {
        throw new Error("Expected a validation envelope v2 lease.");
      }
      expect(claim.envelope.job).toMatchObject({
        jobId: "validation-selected",
        kind: "pull_request_review",
        attempt: 1,
      });
      expect(claim.envelope.validation).toEqual(selected.validation);
      expect(claim.envelope).not.toHaveProperty("plan");
      expect(claim.envelope).not.toHaveProperty("requests");
      expect(JSON.stringify(claim.envelope)).not.toContain(sibling.validation.profileVersion.id);
      expect(readJobState(fixture, "validation-selected")).toEqual({
        status: "leased",
        failure_code: null,
        current_run_attempt_id: claim.envelope.lease.runAttemptId,
        attempt_count: 1,
        lease_generation: 1,
        run_attempt_count: 1,
      });
      expectUnclaimed(fixture, "validation-sibling");
    });

    it.each(legacyWorkers)(
      "lets $name claim v1 after skipping a higher-priority v2 job",
      async ({ labels }) => {
        const fixture = await createFixture([
          { id: "validation-selected", priority: 100, template: validationTemplate(target) },
          { id: "legacy-review", priority: 10, template: legacyTemplate },
        ]);

        const claim = await registerAndClaim(fixture, labels);
        expect(claim.outcome).toBe("granted");
        if (claim.outcome !== "granted") {
          throw new Error("Expected the compatible legacy review job to remain claimable.");
        }
        expect(claim.envelope.envelopeVersion).toBe(1);
        expect(claim.envelope.job.jobId).toBe("legacy-review");
        expect(claim.envelope).not.toHaveProperty("validation");
        expectUnclaimed(fixture, "validation-selected");
        expect(readJobState(fixture, "legacy-review")).toEqual({
          status: "leased",
          failure_code: null,
          current_run_attempt_id: claim.envelope.lease.runAttemptId,
          attempt_count: 1,
          lease_generation: 1,
          run_attempt_count: 1,
        });
      },
    );
  },
);

const managedRepository = { id: "repository-1", ...legacyTemplate.repository };
const repositoryActor = { issuer: "https://identity.example.test", subject: "claim-operator" };
const setRepositoryEnabled = (fixture: DatabaseFixture, enabled: boolean, expectedVersion = 1) =>
  fixture.client.request("updateManagedRepository", {
    repositoryId: managedRepository.id,
    request: { enabled, expectedVersion },
    actor: repositoryActor,
  });

const repositoryClaimCases: {
  readonly name: string;
  readonly template: JobExecutionTemplate;
  readonly envelopeVersion: 1 | 2;
  readonly labels: WorkerCapabilities["labels"];
}[] = [
  { name: "legacy v1", template: legacyTemplate, envelopeVersion: 1, labels: {} },
  {
    name: "validation v2",
    template: validationTemplate("headless"),
    envelopeVersion: 2,
    labels: { executionEnvelope: "2", validationHeadless: "1" },
  },
];

describe.skipIf(process.platform !== "linux").each(repositoryClaimCases)(
  "repository pause for $name claims",
  ({ template, envelopeVersion, labels }) => {
    it.each(["queued", "retry_waiting"] as const)(
      "preserves a %s job while paused and resumes it after enabling the repository",
      async (status) => {
        const fixture = await createFixture(
          [{ id: "paused-review", priority: 100, template, status }],
          [managedRepository],
        );
        await setRepositoryEnabled(fixture, false);

        expect(await registerAndClaim(fixture, labels)).toMatchObject({ outcome: "no_work" });
        expectUnclaimed(fixture, "paused-review", status);

        await setRepositoryEnabled(fixture, true, 2);
        const resumed = await registerAndClaim(fixture, labels, "resumed");
        expect(resumed.outcome).toBe("granted");
        if (resumed.outcome !== "granted") {
          throw new Error(
            "Expected the paused job to resume after repository scheduling is enabled.",
          );
        }
        expect(resumed.envelope).toMatchObject(template);
        expect(resumed.envelope.envelopeVersion).toBe(envelopeVersion);
        expect(resumed.envelope.job).toMatchObject({ jobId: "paused-review", attempt: 1 });
        expect(readJobState(fixture, "paused-review")).toMatchObject({
          status: "leased",
          attempt_count: 1,
          lease_generation: 1,
          run_attempt_count: 1,
        });
      },
    );

    it("claims another enabled repository after a full page of higher-priority paused jobs", async () => {
      const otherRepository = {
        id: "repository-2",
        githubRepositoryId: 2,
        fullName: "example/another-repository",
      };
      const pausedJobs = Array.from({ length: 101 }, (_, index) => ({
        id: `paused-${index}`,
        priority: 100,
        template,
      }));
      const otherTemplate: JobExecutionTemplate = {
        ...template,
        repository: {
          githubRepositoryId: otherRepository.githubRepositoryId,
          fullName: otherRepository.fullName,
        },
        resource: { ...template.resource, githubNodeId: "PR_validation_claim_other" },
        ...("validation" in template
          ? {
              validation: {
                ...template.validation,
                runId: "review-run-2",
                planDigest: sha256("other-repository-frozen-plan"),
                activationId: "activation-2",
                repositoryId: otherRepository.id,
                workItemId: "work-item-2",
                requestEpochId: "request-epoch-2",
                profileVersion: {
                  ...template.validation.profileVersion,
                  repositoryId: otherRepository.id,
                },
              },
            }
          : {}),
      };
      const fixture = await createFixture(
        [
          ...pausedJobs,
          {
            id: "other-review",
            priority: 10,
            template: otherTemplate,
            concurrencyKey: "example/another-repository#1",
          },
        ],
        [managedRepository, otherRepository],
      );
      await setRepositoryEnabled(fixture, false);

      const claim = await registerAndClaim(fixture, labels);
      expect(claim.outcome).toBe("granted");
      if (claim.outcome !== "granted") {
        throw new Error("Expected a different enabled repository to remain claimable.");
      }
      expect(claim.envelope.job.jobId).toBe("other-review");
      expect(claim.envelope.envelopeVersion).toBe(envelopeVersion);
      expect(claim.envelope).toMatchObject(otherTemplate);
      for (const job of pausedJobs) {
        expectUnclaimed(fixture, job.id);
      }
    });

    it("keeps an active lease valid while holding subsequent jobs for the paused repository", async () => {
      const fixture = await createFixture(
        [
          { id: "active-review", priority: 100, template },
          {
            id: "waiting-review",
            priority: 50,
            template,
            concurrencyKey: "microsoft/PowerToys#2",
          },
        ],
        [managedRepository],
      );
      const active = await registerAndClaim(fixture, labels);
      if (active.outcome !== "granted") {
        throw new Error("Expected the enabled repository to grant the first lease.");
      }
      await setRepositoryEnabled(fixture, false);

      expect(readJobState(fixture, "active-review")).toMatchObject({
        status: "leased",
        current_run_attempt_id: active.envelope.lease.runAttemptId,
        attempt_count: 1,
        run_attempt_count: 1,
      });
      expect(await registerAndClaim(fixture, labels, "waiting")).toMatchObject({
        outcome: "no_work",
      });
      expectUnclaimed(fixture, "waiting-review");
      expect(
        await fixture.client.request("heartbeatLease", {
          ...active.envelope.lease,
          phase: "validation_check",
          progressSequence: 1,
          progress: { completedChecks: 1 },
          leaseTtlSeconds: 300,
        }),
      ).toMatchObject({ command: "continue" });
      expect(readJobState(fixture, "active-review")).toMatchObject({
        status: "running",
        current_run_attempt_id: active.envelope.lease.runAttemptId,
        attempt_count: 1,
        run_attempt_count: 1,
      });
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "legacy repository configuration compatibility",
  () => {
    it("continues claiming a directly seeded legacy job with no managed repository", async () => {
      const fixture = await createFixture([
        { id: "unmanaged-legacy", priority: 100, template: legacyTemplate },
      ]);

      const claim = await registerAndClaim(fixture, {});
      expect(claim.outcome).toBe("granted");
      if (claim.outcome !== "granted") {
        throw new Error("Expected the unconfigured legacy queue to remain compatible.");
      }
      expect(claim.envelope.envelopeVersion).toBe(1);
      expect(claim.envelope.job.jobId).toBe("unmanaged-legacy");
    });

    it("holds legacy jobs for discovered repositories until scheduling is explicitly enabled", async () => {
      const fixture = await createFixture(
        [{ id: "discovered-legacy", priority: 100, template: legacyTemplate }],
        [{ ...managedRepository, enabled: false, configurationSource: "discovered" }],
      );

      expect(await registerAndClaim(fixture, {})).toMatchObject({ outcome: "no_work" });
      expectUnclaimed(fixture, "discovered-legacy");
    });
  },
);
