import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type GitHubRepository,
  type ManagedRepository,
  type NormalizedSchedulingEvent,
  type PromptTemplateCreateRequest,
  type PromptVersion,
  type RepositoryUpdateRequest,
  type SchedulingRequestOpenedEvent,
  type SelfOrAllowlistPolicy,
  type ValidationProfileCreateRequest,
  type ValidationProfileVersion,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createValidationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { createOperatorReviewRun } from "./operator-review-runs.js";
import {
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "./prompt-configuration.js";
import {
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  type ReviewRunDetail,
} from "./review-runs.js";

const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T01:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
type OperatorInput = Parameters<typeof createOperatorReviewRun>[1];
type OperatorRequest = OperatorInput["request"];
const databases: DatabaseSync[] = [];

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function configure<K extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: PromptConfigurationOperationMap[K]["input"],
): PromptConfigurationOperationMap[K]["output"] {
  return handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    now,
  ) as PromptConfigurationOperationMap[K]["output"];
}

function repository(githubRepositoryId: number): GitHubRepository {
  return {
    githubRepositoryId,
    githubNodeId: `repository-${githubRepositoryId}`,
    ownerLogin: "example",
    name: `project-${githubRepositoryId}`,
    fullName: `example/project-${githubRepositoryId}`,
    htmlUrl: `https://github.com/example/project-${githubRepositoryId}`,
    defaultBranch: "main",
    isPrivate: false,
  };
}

function openedEvent(
  metadata: GitHubRepository,
  kind: "pull_request" | "issue" = "pull_request",
  number = 1,
): SchedulingRequestOpenedEvent {
  const githubWorkItemId = metadata.githubRepositoryId * 1000 + number;
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const common = {
    githubWorkItemId,
    githubNodeId: `${kind}-${githubWorkItemId}`,
    githubRepositoryId: metadata.githubRepositoryId,
    number,
    title: "Validate the settings panel",
    body: "Update settings.",
    state: "open" as const,
    author: reviewer,
    htmlUrl: `${metadata.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/${number}`,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  const revision = {
    githubRepositoryId: metadata.githubRepositoryId,
    githubWorkItemId,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  const contentDigest = sha256(
    JSON.stringify([common.title, common.body, common.state, common.updatedAt]),
  );
  return {
    contractVersion: 1,
    eventId: `event-${githubWorkItemId}`,
    source: "webhook",
    sourceEventId: `delivery-${githubWorkItemId}`,
    occurredAt: now,
    observedAt: now,
    repository: metadata,
    author: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    actor: reviewer,
    target: reviewer,
    workItem: kind === "pull_request" ? { ...common, kind, isDraft: false } : { ...common, kind },
    revision:
      kind === "pull_request"
        ? { ...revision, kind, revisionKey: sha256(`${baseSha}\0${headSha}`), baseSha, headSha }
        : { ...revision, kind, revisionKey: contentDigest, contentDigest },
  };
}

function ingest(
  database: DatabaseSync,
  observed: NormalizedSchedulingEvent,
  currentPolicy = policy,
  allowScheduling = true,
) {
  const renderedPrompt = "Review the exact source revision.";
  const shouldSchedule =
    allowScheduling &&
    (observed.action === "request_opened" || observed.action === "revision_observed");
  return ingestSchedulingEvent(database, {
    allowScheduling,
    event: observed,
    policy: currentPolicy,
    schedule: shouldSchedule
      ? {
          jobKind:
            observed.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
          priority: 1,
          intentVersion: 1,
          maxAttempts: 1,
          requiredCapabilities: [],
          executionTemplate: {
            repository: {
              githubRepositoryId: observed.repository.githubRepositoryId,
              fullName: observed.repository.fullName,
            },
            resource: {
              githubNodeId: observed.workItem.githubNodeId,
              number: observed.workItem.number,
              title: observed.workItem.title,
              author: reviewer,
              canonicalSnapshot: observed.workItem,
              ...(observed.revision.kind === "pull_request"
                ? {
                    kind: "pull_request",
                    baseSha: observed.revision.baseSha,
                    headSha: observed.revision.headSha,
                    isDraft: false,
                  }
                : { kind: "issue", revisionDigest: observed.revision.revisionKey }),
            },
            prompt: {
              name: "review",
              version: "fixture",
              renderedPrompt,
              promptSha256: sha256(renderedPrompt),
              outputSchema: {},
              outputSchemaSha256: sha256("{}"),
            },
            executionPolicy: {
              hardTimeoutMs: 120_000,
              noProgressTimeoutMs: 30_000,
              allowedRecipeIds: [],
              requiredCapabilityLabels: {},
            },
          },
        }
      : null,
    delivery: {
      deliveryId: observed.sourceEventId,
      eventName: observed.workItem.kind === "pull_request" ? "pull_request" : "issues",
      payloadSha256: sha256(canonicalJson(observed)),
      receivedAt: observed.observedAt,
    },
  });
}

function publishPrompt(
  database: DatabaseSync,
  workflowKind: WorkflowKind,
  content = "Review the exact source revision.",
): PromptVersion {
  const template = configure(database, "createPromptTemplate", {
    actor,
    request: {
      name: `${workflowKind} prompt`,
      workflowKind,
      content,
      outputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
    } as PromptTemplateCreateRequest,
  });
  return configure(database, "publishPromptDraft", {
    templateId: template.id,
    actor,
    request: { expectedVersion: template.version },
  });
}

function bindPrompt(
  database: DatabaseSync,
  workflowKind: WorkflowKind,
  promptVersionId: string,
  repositoryId: string | null = null,
  expectedVersion = 0,
) {
  return configure(database, "savePromptBinding", {
    repositoryId,
    workflowKind,
    actor,
    request: { expectedVersion, promptVersionId },
  });
}

function publishProfile(
  database: DatabaseSync,
  repositoryId: string,
  options: {
    workflowKind?: WorkflowKind;
    required?: boolean;
    enabled?: boolean;
    previous?: ValidationProfileVersion;
    bind?: boolean;
    probe?: boolean;
  } = {},
): ValidationProfileVersion {
  const workflowKind = options.workflowKind ?? options.previous?.workflowKind ?? "pr_static_build";
  const request: ValidationProfileCreateRequest = {
    name: `${workflowKind} checks`,
    workflowKind,
    target: workflowKind === "pr_ui" ? "web" : "headless",
    required: options.required ?? true,
    outputSchemaVersion:
      workflowKind === "pr_static_build"
        ? "PrReviewPlanV2"
        : workflowKind === "issue_triage"
          ? "IssueTriageV2"
          : "ValidationReportV1",
    ...(options.previous
      ? { profileId: options.previous.profileId, expectedVersion: options.previous.version }
      : {}),
    config: {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      build:
        workflowKind === "issue_triage"
          ? []
          : [
              {
                id: "compile",
                name: "Compile",
                command: {
                  executable: "dotnet",
                  args: ["build"],
                  workingDirectory: ".",
                  environment: [],
                },
                timeoutMs: 30_000,
                required: true,
              },
            ],
      test: options.probe
        ? [
            {
              id: "observe-settings",
              name: "Observe settings",
              command: {
                executable: "node",
                args: ["observe.mjs"],
                workingDirectory: ".",
                environment: [],
              },
              timeoutMs: 30_000,
              required: true,
              probeOutput: {
                schemaVersion: "TestProbeOutputDeclarationV1",
                fields: [
                  { id: "visible", description: "Whether settings is visible.", type: "boolean" },
                  { id: "count", description: "The count of settings controls.", type: "number" },
                ],
              },
            },
          ]
        : [],
      launch: [],
      cleanup: [],
      requiredCapabilities: [],
      hardTimeoutMs: 120_000,
      noProgressTimeoutMs: 30_000,
    },
  } as ValidationProfileCreateRequest;
  const profile = configure(database, "publishValidationProfile", { repositoryId, request, actor });
  if (options.bind !== false) {
    configure(database, "saveValidationProfileBinding", {
      repositoryId,
      profileId: profile.profileId,
      actor,
      request: {
        expectedVersion: options.previous ? 1 : 0,
        profileVersionId: profile.id,
        enabled: options.enabled ?? true,
      },
    });
  }
  return profile;
}

function fixture(
  options: {
    kind?: "pull_request" | "issue";
    configured?: boolean;
    prompt?: boolean;
    authorized?: boolean;
    probe?: boolean;
  } = {},
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [repository(1), repository(2)].map(({ githubRepositoryId, fullName }) => ({
          githubRepositoryId,
          fullName,
        })),
        reviewer,
        authorizationPolicy: policy,
      },
    },
    now,
  );
  const observed = openedEvent(repository(1), options.kind);
  const ingested = ingest(database, observed, policy, options.authorized !== false);
  const workflowKind =
    observed.workItem.kind === "pull_request" ? "pr_static_build" : "issue_validation";
  const profile =
    options.configured === false
      ? null
      : publishProfile(database, ingested.repositoryId, {
          workflowKind,
          ...(options.probe ? { probe: true } : {}),
        });
  const prompt = options.prompt === false ? null : publishPrompt(database, workflowKind);
  if (prompt) bindPrompt(database, workflowKind, prompt.id);
  const request: OperatorRequest = {
    activationId: "activation-1",
    expectedRevisionKey: observed.revision.revisionKey,
  };
  const input: OperatorInput = {
    repositoryId: ingested.repositoryId,
    workItemId: ingested.workItemId,
    request,
    actor,
  };
  return {
    database,
    observed,
    ingested,
    input,
    profile,
    prompt,
    create: (overrides: Partial<OperatorRequest> = {}, at = now) =>
      createOperatorReviewRun(database, { ...input, request: { ...request, ...overrides } }, at),
  };
}

function updateRepository(
  database: DatabaseSync,
  repositoryId: string,
  changes: Omit<RepositoryUpdateRequest, "expectedVersion">,
) {
  const current = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId } },
    now,
  ) as ManagedRepository;
  return handleRepositoryConfigurationRequest(
    database,
    {
      operation: "updateManagedRepository",
      input: { repositoryId, actor, request: { expectedVersion: current.version, ...changes } },
    },
    later,
  ) as ManagedRepository;
}

function closeRequest(database: DatabaseSync, observed: SchedulingRequestOpenedEvent) {
  return ingest(database, {
    ...observed,
    eventId: `${observed.eventId}-closed`,
    sourceEventId: `${observed.sourceEventId}-closed`,
    occurredAt: later,
    observedAt: later,
    action: "request_closed",
    closeReason:
      observed.requestKind === "review_request" ? "review_request_removed" : "assignment_removed",
  });
}

function storedCount(
  database: DatabaseSync,
  table: "jobs" | "review_runs" | "review_run_requests" | "review_run_audit",
) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function profileIds(run: ReviewRunDetail) {
  return run.plan.jobs.map((job) => present(job.profileVersion).profileId).sort();
}

function rejects(action: () => unknown, code = "PLATFORM_CONFLICT") {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture value is missing.");
  return value;
}

function reproduction(
  profile: ValidationProfileVersion,
): NonNullable<OperatorRequest["reproduction"]> {
  return {
    schemaVersion: "IssueReproductionRequestV1",
    claim: "Settings creates duplicate hidden controls.",
    cases: [
      {
        id: "settings-hidden",
        profileId: profile.profileId,
        expectedProfileVersionId: profile.id,
        context: "Launch the published settings fixture.",
        preconditions: [{ kind: "check_passed", checkId: `${profile.id}:compile` }],
        presentWhen: {
          allOf: [
            {
              observation: {
                kind: "probe_value",
                testStepId: "observe-settings",
                observationId: "visible",
              },
              equals: { type: "boolean", value: false },
            },
            {
              observation: {
                kind: "probe_value",
                testStepId: "observe-settings",
                observationId: "count",
              },
              equals: { type: "number", value: 2 },
            },
          ],
        },
        absentWhen: null,
      },
    ],
  };
}

describe("operator Issue reproduction admission", () => {
  it("preserves the historical creation intent when reproduction is omitted", () => {
    const f = fixture();
    const run = f.create();
    expect(Object.hasOwn(run.plan, "reproduction")).toBe(false);
    expect(run.intentDigest).toBe(
      sha256(
        canonicalJson({
          schemaVersion: "OperatorReviewRunIntentV1",
          repositoryId: f.input.repositoryId,
          workItemId: f.input.workItemId,
          actor,
          request: {
            activationId: f.input.request.activationId,
            expectedRevisionKey: f.input.request.expectedRevisionKey,
            profileIds: null,
            testedSourceCommit: null,
          },
        }),
      ),
    );
  });

  it("freezes the exact operator scope and retains required profiles outside the mapping", () => {
    const f = fixture({ kind: "issue", probe: true });
    const mapped = present(f.profile);
    const required = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "issue_validation",
    });
    const run = f.create({
      profileIds: [mapped.profileId],
      testedSourceCommit: "c".repeat(40),
      reproduction: reproduction(mapped),
    });
    expect(profileIds(run)).toEqual([mapped.profileId, required.profileId].sort());
    expect(run.plan.requiredCheckIds).toContain(`${required.id}:compile`);
    expect(run.plan.reproduction?.binding).toMatchObject({
      activationId: f.input.request.activationId,
      repositoryId: f.input.repositoryId,
      workItemId: f.input.workItemId,
      issueRevisionKey: f.input.request.expectedRevisionKey,
      testedSourceCommit: "c".repeat(40),
      authorizedBy: { ...actor, authorizedAt: now },
      cases: [
        {
          requestId: mapped.profileId,
          profileVersionId: mapped.id,
          profileConfigSha256: mapped.configSha256,
        },
      ],
    });
    const templateFor = (requestId: string) =>
      createValidationExecutionTemplate({
        runId: run.id,
        plan: run.plan,
        planDigest: run.planDigest,
        requestId,
        jobActivation: 1,
        frozenPrompt: present(
          getReviewRunPromptEnvelope(f.database, {
            repositoryId: run.repositoryId,
            reviewRunId: run.id,
            requestId,
          }),
        ),
      });
    const mappedTemplate = templateFor(mapped.profileId);
    expect(mappedTemplate.validation.reproduction).toEqual(run.plan.reproduction);
    expect(mappedTemplate.executionPolicy.requiredCapabilityLabels).toMatchObject({
      issueReproduction: "1",
      structuredProbeOutput: "1",
    });
    const otherTemplate = templateFor(required.profileId);
    expect(Object.hasOwn(otherTemplate.validation, "reproduction")).toBe(false);
    expect(otherTemplate.executionPolicy.requiredCapabilityLabels).toEqual({
      executionEnvelope: "2",
      validationHeadless: "1",
    });
  });

  it("rejects a persisted binding with mismatched source scope even when the enclosing digest is recomputed", () => {
    const f = fixture({ kind: "issue", probe: true });
    const run = f.create({
      testedSourceCommit: "c".repeat(40),
      reproduction: reproduction(present(f.profile)),
    });
    const plan = structuredClone(run.plan);
    const frozen = present(plan.reproduction);
    frozen.binding.testedSourceCommit = "d".repeat(40);
    frozen.bindingDigest = sha256(canonicalJson(frozen.binding));
    expect(() =>
      f.database
        .prepare("UPDATE review_runs SET plan_json = ?, plan_digest = ? WHERE id = ?")
        .run(canonicalJson(plan), sha256(canonicalJson(plan)), run.id),
    ).toThrow(/immutable/u);
    // Simulate a corrupt persisted record only after proving the production trigger rejects it.
    f.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    f.database
      .prepare("UPDATE review_runs SET plan_json = ?, plan_digest = ? WHERE id = ?")
      .run(canonicalJson(plan), sha256(canonicalJson(plan)), run.id);
    rejects(() =>
      handleReviewRunRequest(
        f.database,
        {
          operation: "getReviewRun",
          input: { repositoryId: run.repositoryId, reviewRunId: run.id },
        },
        later,
      ),
    );
  });

  it("canonicalizes unordered cases and predicates before replaying an existing activation", () => {
    const f = fixture({ kind: "issue", probe: true });
    const profile = present(f.profile);
    const intent = reproduction(profile);
    intent.cases.push({
      ...structuredClone(present(intent.cases[0])),
      id: "settings-hidden-again",
    });
    const request = { testedSourceCommit: "c".repeat(40), reproduction: intent };
    const run = f.create(request);
    publishProfile(f.database, f.input.repositoryId, { previous: profile, probe: true });
    updateRepository(f.database, f.input.repositoryId, { enabled: false });
    closeRequest(f.database, f.observed);
    const reordered = structuredClone(intent);
    reordered.cases.reverse();
    for (const entry of reordered.cases) entry.presentWhen.allOf.reverse();
    expect(f.create({ ...request, reproduction: reordered }, later)).toEqual(run);
  });

  it.each(["claim", "predicate", "profile-version", "commit"])(
    "conflicts when %s changes on the same activation",
    (change) => {
      const f = fixture({ kind: "issue", probe: true });
      const request = {
        testedSourceCommit: "c".repeat(40),
        reproduction: reproduction(present(f.profile)),
      };
      f.create(request);
      const changed = structuredClone(request);
      if (change === "claim") changed.reproduction.claim = "A different Issue claim.";
      if (change === "predicate")
        present(present(changed.reproduction.cases[0]).presentWhen.allOf[0]).equals = {
          type: "boolean",
          value: true,
        };
      if (change === "profile-version")
        present(changed.reproduction.cases[0]).expectedProfileVersionId = "changed-version";
      if (change === "commit") changed.testedSourceCommit = "d".repeat(40);
      rejects(() => f.create(changed));
      expect(storedCount(f.database, "review_runs")).toBe(1);
    },
  );

  it("rejects a stale expected profile version and an unselected optional mapping", () => {
    const f = fixture({ kind: "issue", probe: true });
    const old = present(f.profile);
    publishProfile(f.database, f.input.repositoryId, { previous: old, probe: true });
    rejects(() =>
      f.create({ testedSourceCommit: "c".repeat(40), reproduction: reproduction(old) }),
    );
    const optional = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "issue_validation",
      required: false,
      probe: true,
    });
    rejects(
      () =>
        f.create({
          profileIds: [],
          testedSourceCommit: "c".repeat(40),
          reproduction: reproduction(optional),
        }),
      "PLATFORM_INVALID",
    );
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it("rejects missing tested commits and PR mappings before persisting a plan", () => {
    const issue = fixture({ kind: "issue", probe: true });
    rejects(
      () => issue.create({ reproduction: reproduction(present(issue.profile)) }),
      "PLATFORM_INVALID",
    );
    const pr = fixture({ probe: true });
    rejects(
      () => pr.create({ reproduction: reproduction(present(pr.profile)) }),
      "PLATFORM_INVALID",
    );
    expect(storedCount(issue.database, "review_runs")).toBe(0);
    expect(storedCount(pr.database, "review_runs")).toBe(0);
  });

  it("rejects invalid references and duplicate semantic predicates before recording an activation", () => {
    const f = fixture({ kind: "issue", probe: true });
    const intent = reproduction(present(f.profile));
    present(intent.cases[0]).presentWhen.allOf.push(
      structuredClone(present(present(intent.cases[0]).presentWhen.allOf[0])),
    );
    rejects(
      () => f.create({ testedSourceCommit: "c".repeat(40), reproduction: intent }),
      "PLATFORM_INVALID",
    );
    const invalid = reproduction(present(f.profile));
    present(present(invalid.cases[0]).presentWhen.allOf[0]).observation = {
      kind: "probe_value",
      testStepId: "observe-settings",
      observationId: "undeclared",
    };
    rejects(
      () => f.create({ testedSourceCommit: "c".repeat(40), reproduction: invalid }),
      "PLATFORM_INVALID",
    );
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });
});

describe("operator review run creation", () => {
  it("freezes bound versions and authorization while persisting structurally complete pending Jobs", () => {
    const f = fixture();
    const bound = present(f.profile);
    const unbound = publishProfile(f.database, f.input.repositoryId, {
      previous: bound,
      required: false,
      bind: false,
    });
    const optional = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "pr_ui",
      required: false,
    });
    const uiPrompt = publishPrompt(f.database, "pr_ui");
    bindPrompt(f.database, "pr_ui", uiPrompt.id);
    const before = storedCount(f.database, "jobs");

    const run = f.create();

    expect(run).toMatchObject({
      repositoryId: f.input.repositoryId,
      workItemId: f.input.workItemId,
      activationId: f.input.request.activationId,
      revisionKey: f.observed.revision.revisionKey,
      requestEpochId: f.ingested.openedRequestEpochId,
      createdBy: actor,
      requestCount: 2,
      blockedRequestCount: 2,
    });
    expect(run.intentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(run.planDigest).toBe(sha256(canonicalJson(run.plan)));
    expect(profileIds(run)).toEqual([bound.profileId, optional.profileId].sort());
    expect(
      run.plan.jobs.find((job) => job.profileVersion?.profileId === bound.profileId)
        ?.profileVersion,
    ).toEqual(bound);
    expect(run.plan.jobs.some((job) => job.profileVersion?.id === unbound.id)).toBe(false);
    expect(run.plan.testedSourceRevision).toEqual({
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
    expect(run.plan.testedSourceAuthorization).toBeNull();
    expect(run.plan.authorization).toMatchObject({
      actorGithubUserId: reviewer.githubUserId,
      targetGithubUserId: reviewer.githubUserId,
      policy,
    });
    expect(
      run.readiness.every(
        (entry) =>
          entry.state === "blocked" &&
          entry.reasons.some((reason) => reason.code === "unsupported_target"),
      ),
    ).toBe(true);
    const pending = present(run.requests.find((request) => request.requestId === bound.profileId));
    expect(pending.jobs).toHaveLength(1);
    expect(run.requests.find((request) => request.requestId === optional.profileId)?.jobs).toEqual(
      [],
    );
    expect(
      f.database
        .prepare("SELECT state, attempt_base FROM job_admission WHERE job_id = ?")
        .get(present(pending.jobs[0]).jobId),
    ).toEqual({ state: "pending", attempt_base: 0 });
    expect(storedCount(f.database, "jobs")).toBe(before + 1);
    expect(storedCount(f.database, "run_attempts")).toBe(0);
    expect(storedCount(f.database, "review_run_audit")).toBe(2);
    expect(f.database.isTransaction).toBe(false);
  });

  it("includes every required profile and treats omitted selection as all enabled applicable profiles", () => {
    const f = fixture();
    const required = present(f.profile);
    const optional = publishProfile(f.database, f.input.repositoryId, { required: false });
    const another = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "pr_ui",
      required: false,
    });
    publishProfile(f.database, f.input.repositoryId, { required: true, enabled: false });
    publishProfile(f.database, f.input.repositoryId, { workflowKind: "issue_triage" });

    expect(profileIds(f.create())).toEqual(
      [required.profileId, optional.profileId, another.profileId].sort(),
    );
    expect(
      profileIds(f.create({ activationId: "required-only", profileIds: [required.profileId] })),
    ).toEqual([required.profileId]);
    expect(
      profileIds(f.create({ activationId: "selected", profileIds: [optional.profileId] })),
    ).toEqual([required.profileId, optional.profileId].sort());
  });

  it("accepts exactly 32 selected profiles", () => {
    const f = fixture({ configured: false });
    const selected = Array.from({ length: 32 }, () =>
      publishProfile(f.database, f.input.repositoryId, { required: false }),
    ).map((profile) => profile.profileId);
    const run = f.create({ profileIds: selected });
    expect(profileIds(run)).toEqual([...selected].sort());
    expect(run.requestCount).toBe(32);
  });

  it.each([true, false])(
    "never truncates more than 32 selected or required profiles: required=%s",
    (required) => {
      const f = fixture({ configured: false });
      const profiles = Array.from({ length: 33 }, () =>
        publishProfile(f.database, f.input.repositoryId, { required }),
      );
      rejects(() => f.create(required ? { profileIds: [present(profiles[0]).profileId] } : {}));
      expect(storedCount(f.database, "review_runs")).toBe(0);
    },
  );

  it("normalizes selected profile order for activation replay", () => {
    const f = fixture();
    const required = present(f.profile);
    const optional = publishProfile(f.database, f.input.repositoryId, { required: false });
    const first = f.create({ profileIds: [required.profileId, optional.profileId] });
    const admissions = f.database.prepare("SELECT * FROM job_admission ORDER BY job_id").all();
    const audit = f.database.prepare("SELECT * FROM review_run_audit ORDER BY id").all();
    expect(first.requests.every((request) => request.jobs.length === 1)).toBe(true);
    expect(audit).toHaveLength(3);

    expect(f.create({ profileIds: [optional.profileId, required.profileId] }, later)).toEqual(
      first,
    );
    expect(storedCount(f.database, "review_runs")).toBe(1);
    expect(f.database.prepare("SELECT * FROM review_run_audit ORDER BY id").all()).toEqual(audit);
    expect(f.database.prepare("SELECT * FROM job_admission ORDER BY job_id").all()).toEqual(
      admissions,
    );
  });

  it("distinguishes omitted selection from an explicit selection even when both select the same profiles", () => {
    const f = fixture();
    f.create();
    rejects(() => f.create({ profileIds: [present(f.profile).profileId] }));
    const other = fixture();
    other.create({ profileIds: [present(other.profile).profileId] });
    rejects(() => other.create());
  });

  it("replays the frozen plan after repository, profile, prompt, and authorization changes", () => {
    const f = fixture();
    const first = f.create();
    const audit = f.database.prepare("SELECT * FROM review_run_audit ORDER BY id").all();
    const admissions = f.database.prepare("SELECT * FROM job_admission ORDER BY job_id").all();
    const templates = f.database
      .prepare("SELECT id, execution_json, execution_digest FROM jobs ORDER BY id")
      .all();
    expect(first.requests[0]?.jobs).toHaveLength(1);
    expect(audit).toHaveLength(2);
    publishProfile(f.database, f.input.repositoryId, { previous: present(f.profile) });
    const replacement = publishPrompt(f.database, "pr_static_build", "Use the new prompt.");
    bindPrompt(f.database, "pr_static_build", replacement.id, null, 1);
    closeRequest(f.database, f.observed);
    updateRepository(f.database, f.input.repositoryId, { enabled: false });

    expect(f.create({}, later)).toEqual(first);
    expect(storedCount(f.database, "review_runs")).toBe(1);
    expect(f.database.prepare("SELECT * FROM review_run_audit ORDER BY id").all()).toEqual(audit);
    expect(f.database.prepare("SELECT * FROM job_admission ORDER BY job_id").all()).toEqual(
      admissions,
    );
    expect(
      f.database.prepare("SELECT id, execution_json, execution_digest FROM jobs ORDER BY id").all(),
    ).toEqual(templates);
  });

  it("rejects changed revision intent or selected profiles on the same activation", () => {
    const f = fixture();
    const optional = publishProfile(f.database, f.input.repositoryId, { required: false });
    const selection = [present(f.profile).profileId];
    f.create({ profileIds: selection });
    rejects(() => f.create({ profileIds: selection, expectedRevisionKey: "e".repeat(64) }));
    rejects(() => f.create({ profileIds: [optional.profileId] }));
  });

  it.each([
    { ...actor, issuer: "https://other.example.test" },
    { ...actor, subject: "operator-2" },
  ])("rejects activation replay by a different authenticated actor: %j", (otherActor) => {
    const f = fixture();
    f.create();
    rejects(() => createOperatorReviewRun(f.database, { ...f.input, actor: otherActor }, later));
  });

  it("rejects unknown repositories, unknown work items, and cross-repository work items", () => {
    const f = fixture();
    const other = ingest(f.database, openedEvent(repository(2)));
    for (const changed of [
      { repositoryId: "unknown-repository" },
      { workItemId: "unknown-work-item" },
      { repositoryId: other.repositoryId },
    ]) {
      rejects(
        () => createOperatorReviewRun(f.database, { ...f.input, ...changed }, now),
        "PLATFORM_NOT_FOUND",
      );
    }
    expect(storedCount(f.database, "review_runs")).toBe(0);
    expect(f.database.isTransaction).toBe(false);
  });

  it.each<Omit<RepositoryUpdateRequest, "expectedVersion">>([
    { enabled: false },
    { authorizationPolicy: null },
    { reviewerGithubUserId: null, reviewerGithubLogin: null, authorizationPolicy: null },
  ])("requires enabled repository settings with a reviewer and policy: %j", (changes) => {
    const f = fixture();
    updateRepository(f.database, f.input.repositoryId, changes);
    rejects(() => f.create());
  });

  it("requires the exact current revision and rolls failed creation back", () => {
    const f = fixture();
    rejects(() => f.create({ expectedRevisionKey: "e".repeat(64) }));
    expect(storedCount(f.database, "review_runs")).toBe(0);
    expect(storedCount(f.database, "review_run_audit")).toBe(0);
    expect(f.database.isTransaction).toBe(false);
    expect(f.create().activationId).toBe(f.input.request.activationId);
  });

  it("rolls all plan records back if writing the audit fails", () => {
    const f = fixture();
    f.database.exec(`CREATE TEMP TRIGGER reject_operator_audit
      BEFORE INSERT ON review_run_audit BEGIN
      SELECT RAISE(ABORT, 'audit storage unavailable'); END`);

    expect(() => f.create()).toThrow("audit storage unavailable");
    expect(storedCount(f.database, "review_runs")).toBe(0);
    expect(storedCount(f.database, "review_run_requests")).toBe(0);
    expect(storedCount(f.database, "review_run_audit")).toBe(0);
    expect(f.database.isTransaction).toBe(false);
    f.database.exec("DROP TRIGGER reject_operator_audit");
    expect(f.create().activationId).toBe(f.input.request.activationId);
  });

  it("requires its own transaction and preserves the caller's existing transaction", () => {
    const f = fixture();
    f.database.exec("BEGIN IMMEDIATE");
    try {
      rejects(() => f.create(), "PLATFORM_INVALID");
      expect(f.database.isTransaction).toBe(true);
      expect(storedCount(f.database, "review_runs")).toBe(0);
    } finally {
      f.database.exec("ROLLBACK");
    }
  });

  it("requires a fresh GitHub request when no active authorization exists", () => {
    const f = fixture({ authorized: false });
    rejects(() => f.create());
    expect(() => f.create()).toThrow(/GitHub.*(?:review|assignment)/iu);
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it("rejects a closed authorization epoch", () => {
    const f = fixture();
    closeRequest(f.database, f.observed);
    rejects(() => f.create());
  });

  it("rejects a closed work item even when its expected revision still matches", () => {
    const f = fixture();
    ingest(f.database, {
      ...f.observed,
      eventId: "work-item-closed",
      sourceEventId: "delivery-work-item-closed",
      occurredAt: later,
      observedAt: later,
      action: "work_item_closed",
      requestKind: null,
      target: null,
      closeReason: "work_item_closed",
      workItem: { ...f.observed.workItem, state: "closed", closedAt: later, updatedAt: later },
    });
    rejects(() => f.create());
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it("requires authorization for the current reviewer and exact policy snapshot", () => {
    for (const changed of [
      { ...policy, policyVersion: 2 },
      { ...policy, allowlistedActorGithubUserIds: [999] },
    ]) {
      const changedPolicy = fixture();
      updateRepository(changedPolicy.database, changedPolicy.input.repositoryId, {
        authorizationPolicy: changed,
      });
      rejects(() => changedPolicy.create());
    }

    const changedReviewer = fixture();
    updateRepository(changedReviewer.database, changedReviewer.input.repositoryId, {
      reviewerGithubUserId: 200,
      reviewerGithubLogin: "other-reviewer",
      authorizationPolicy: { ...policy, schedulingTargetGithubUserId: 200 },
    });
    rejects(() => changedReviewer.create());
  });

  it("does not let an old active epoch authorize a newly observed revision", () => {
    const f = fixture();
    const original = f.create();
    if (f.observed.revision.kind !== "pull_request")
      throw new Error("Expected a pull request fixture.");
    const headSha = "d".repeat(40);
    const revisionKey = sha256(`${f.observed.revision.baseSha}\0${headSha}`);
    ingest(f.database, {
      ...f.observed,
      eventId: "revision-2",
      sourceEventId: "delivery-revision-2",
      occurredAt: later,
      observedAt: later,
      action: "revision_observed",
      requestKind: null,
      target: null,
      workItem: { ...f.observed.workItem, updatedAt: later },
      revision: {
        ...f.observed.revision,
        headSha,
        revisionKey,
        observedAt: later,
        sourceUpdatedAt: later,
      },
    });

    rejects(() => f.create({ activationId: "revision-2", expectedRevisionKey: revisionKey }));
    expect(f.create({}, later)).toEqual(original);
    expect(storedCount(f.database, "review_runs")).toBe(1);
  });

  it("rejects absent, disabled, foreign, or inapplicable profile selections", () => {
    const f = fixture();
    const disabled = publishProfile(f.database, f.input.repositoryId, { enabled: false });
    const inapplicable = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "issue_triage",
    });
    const other = ingest(f.database, openedEvent(repository(2)));
    const foreign = publishProfile(f.database, other.repositoryId);

    for (const profileId of [
      "unknown-profile",
      disabled.profileId,
      inapplicable.profileId,
      foreign.profileId,
    ]) {
      rejects(() => f.create({ profileIds: [profileId] }), "PLATFORM_INVALID");
    }
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it.each(["none", "disabled", "inapplicable"] as const)(
    "rejects a repository with no enabled applicable profiles: %s",
    (configuration) => {
      const f = fixture({ configured: false });
      if (configuration === "disabled")
        publishProfile(f.database, f.input.repositoryId, { enabled: false });
      if (configuration === "inapplicable")
        publishProfile(f.database, f.input.repositoryId, { workflowKind: "issue_triage" });
      rejects(() => f.create());
      expect(storedCount(f.database, "review_runs")).toBe(0);
    },
  );

  it("preserves missing prompts as blocked null snapshots", () => {
    const f = fixture({ prompt: false });
    const run = f.create();
    expect(run.plan.jobs[0]?.prompt).toBeNull();
    expect(run.readiness[0]).toMatchObject({
      state: "blocked",
      reasons: expect.arrayContaining([{ code: "missing_prompt" }, { code: "unsupported_target" }]),
    });
  });

  it("prefers repository prompt overrides and falls back to the global binding for other workflows", () => {
    const f = fixture();
    const override = publishPrompt(
      f.database,
      "pr_static_build",
      "Use repository-specific instructions.",
    );
    bindPrompt(f.database, "pr_static_build", override.id, f.input.repositoryId);
    publishProfile(f.database, f.input.repositoryId, { workflowKind: "pr_ui" });
    const globalUi = publishPrompt(f.database, "pr_ui");
    bindPrompt(f.database, "pr_ui", globalUi.id);
    const run = f.create();

    expect(
      run.plan.jobs.find((job) => job.workflowKind === "pr_static_build")?.prompt?.version,
    ).toEqual(override);
    expect(run.plan.jobs.find((job) => job.workflowKind === "pr_ui")?.prompt?.version).toEqual(
      globalUi,
    );
  });

  it("keeps the bound prompt version when a newer version is published without rebinding", () => {
    const f = fixture();
    const bound = present(f.prompt);
    const template = present(
      configure(f.database, "getPromptTemplate", { templateId: bound.templateId }),
    );
    const draft = configure(f.database, "savePromptDraft", {
      templateId: template.id,
      actor,
      request: {
        expectedVersion: template.version,
        content: "New instructions are not yet bound.",
        outputSchemaVersion: bound.outputSchemaVersion,
      },
    });
    const unbound = configure(f.database, "publishPromptDraft", {
      templateId: template.id,
      actor,
      request: { expectedVersion: draft.version },
    });

    expect(unbound.id).not.toBe(bound.id);
    expect(f.create().plan.jobs[0]?.prompt?.version).toEqual(bound);
  });

  it("rejects client-tested commits for pull requests", () => {
    const f = fixture();
    rejects(() => f.create({ testedSourceCommit: "c".repeat(40) }), "PLATFORM_INVALID");
  });

  it.each([40, 64])(
    "creates explicit operator authorization for an Issue validation commit of length %i",
    (length) => {
      const f = fixture({ kind: "issue" });
      const headSha = "c".repeat(length);
      const run = f.create({ testedSourceCommit: headSha });
      expect(run.plan.testedSourceRevision).toEqual({ kind: "commit", headSha });
      expect(run.plan.testedSourceAuthorization).toEqual({
        kind: "operator",
        activationId: f.input.request.activationId,
        issuer: actor.issuer,
        subject: actor.subject,
        authorizedAt: now,
        githubRepositoryId: f.observed.repository.githubRepositoryId,
        githubWorkItemId: f.observed.workItem.githubWorkItemId,
        issueRevisionKey: f.observed.revision.revisionKey,
        headSha,
      });
      expect(run.readiness.every((entry) => entry.state === "blocked")).toBe(true);
      expect(f.create({ testedSourceCommit: headSha }, later)).toEqual(run);
      rejects(() => f.create({ testedSourceCommit: "d".repeat(length) }));
    },
  );

  it("preserves a missing Issue validation source as blocked without inventing authorization", () => {
    const f = fixture({ kind: "issue" });
    const run = f.create();
    expect(run.plan.testedSourceRevision).toBeNull();
    expect(run.plan.testedSourceAuthorization).toBeNull();
    expect(run.readiness[0]).toMatchObject({
      state: "blocked",
      reasons: expect.arrayContaining([
        { code: "missing_tested_source_revision" },
        { code: "missing_source_authorization" },
      ]),
    });
  });

  it("accepts no commit for a triage-only Issue selection", () => {
    const f = fixture({ kind: "issue", configured: false });
    const triage = publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "issue_triage",
    });
    publishProfile(f.database, f.input.repositoryId, {
      workflowKind: "issue_validation",
      required: false,
    });
    const run = f.create({ profileIds: [triage.profileId] });
    expect(profileIds(run)).toEqual([triage.profileId]);
    expect(run.plan.testedSourceRevision).toBeNull();
    expect(run.plan.testedSourceAuthorization).toBeNull();
    rejects(
      () =>
        f.create({
          activationId: "triage-with-source",
          profileIds: [triage.profileId],
          testedSourceCommit: "c".repeat(40),
        }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    "main",
    "abc123",
    "c".repeat(39),
    "c".repeat(41),
    "c".repeat(63),
    "c".repeat(65),
    "C".repeat(40),
    `${"c".repeat(40)}\n`,
  ])("rejects a non-exact lowercase Issue commit: %j", (testedSourceCommit) => {
    const f = fixture({ kind: "issue" });
    rejects(() => f.create({ testedSourceCommit }), "PLATFORM_INVALID");
  });

  it.each([
    { planInput: {} },
    {
      runnerSupport: [
        {
          workflowKind: "pr_static_build",
          target: "headless",
          capabilities: [],
          evidenceDelivery: true,
        },
      ],
    },
    { authorization: { targetGithubUserId: 999 } },
    { authorizationPolicy: policy },
    { testedSourceAuthorization: { ...actor, authorizedAt: now } },
    { testedSourceRevision: { kind: "commit", headSha: "c".repeat(40) } },
    { actor: { ...actor, subject: "forged-operator" } },
    { repository: { id: "forged-repository" } },
    { requests: [] },
  ])("rejects client-supplied server authority fields: %j", (extra) => {
    const f = fixture();
    rejects(
      () =>
        createOperatorReviewRun(
          f.database,
          { ...f.input, request: { ...f.input.request, ...extra } } as OperatorInput,
          now,
        ),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    { activationId: "" },
    { activationId: "invalid activation" },
    { expectedRevisionKey: "not-a-revision" },
    { profileIds: [] },
    { profileIds: ["invalid profile"] },
    { profileIds: ["same-profile", "same-profile"] },
    { profileIds: Array.from({ length: 33 }, (_, index) => `profile-${index}`) },
    { profileIds: null },
    { testedSourceCommit: null },
  ])("rejects malformed operator creation requests: %j", (changed) => {
    const f = fixture();
    rejects(
      () =>
        createOperatorReviewRun(
          f.database,
          { ...f.input, request: { ...f.input.request, ...changed } } as unknown as OperatorInput,
          now,
        ),
      "PLATFORM_INVALID",
    );
    expect(storedCount(f.database, "review_runs")).toBe(0);
  });

  it.each([
    { issuer: "", subject: actor.subject },
    { issuer: actor.issuer, subject: "" },
    { issuer: actor.issuer, subject: " operator-1" },
    { issuer: actor.issuer, subject: "operator\0" },
  ])("requires a valid authenticated operator identity: %j", (invalidActor) => {
    const f = fixture();
    rejects(
      () => createOperatorReviewRun(f.database, { ...f.input, actor: invalidActor }, now),
      "PLATFORM_INVALID",
    );
  });
});
