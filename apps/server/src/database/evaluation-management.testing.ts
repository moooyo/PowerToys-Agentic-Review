import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ActiveAuthorizedRequestEpoch,
  EvaluationSourceReferenceV1,
  GitHubRepository,
  ManagedRepository,
  NormalizedSchedulingEvent,
  OperatorPrincipal,
  OperatorRepositoryRole,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest } from "./operator-access.js";
import { handleReviewRunRequest, type ReviewRunDetail } from "./review-runs.js";

export const evaluationNow = "2026-09-08T01:00:00.000Z";
export const evaluationLater = "2026-09-08T02:00:00.000Z";
export const evaluationActor = {
  issuer: "https://identity.example.test",
  subject: "maintainer",
} satisfies OperatorPrincipal;
export const evaluationAdministrator = {
  ...evaluationActor,
  subject: "administrator",
} satisfies OperatorPrincipal;

const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const migrationDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));

type CurrentEvaluationSourceReference = Extract<
  EvaluationSourceReferenceV1,
  { kind: "current_work_item" }
>;

export interface EvaluationManagementFixtureOptions {
  readonly migrationsDirectory?: string;
  readonly githubRepositoryId?: number;
  readonly secondGithubRepositoryId?: number;
}

export interface EvaluationManagementFixture {
  readonly database: DatabaseSync;
  readonly repositoryId: string;
  readonly secondRepositoryId: string;
  readonly event: SchedulingRequestOpenedEvent;
  readonly secondEvent: SchedulingRequestOpenedEvent;
  readonly reference: CurrentEvaluationSourceReference;
  readonly secondReference: CurrentEvaluationSourceReference;
  readonly planInput: ReviewRunPlanInput;
  readonly createRun: () => ReviewRunDetail;
  readonly close: () => void;
}

function metadata(githubRepositoryId: number): GitHubRepository {
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

function observed(
  kind: "pull_request" | "issue",
  repository: GitHubRepository,
): SchedulingRequestOpenedEvent {
  const githubWorkItemId = repository.githubRepositoryId * 1_000 + 1;
  const common = {
    githubWorkItemId,
    githubNodeId: `item-${githubWorkItemId}`,
    githubRepositoryId: repository.githubRepositoryId,
    number: 1,
    title: "Capture the original settings regression",
    body: "The original full report body.",
    state: "open" as const,
    author: reviewer,
    htmlUrl: `${repository.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/1`,
    createdAt: evaluationNow,
    updatedAt: evaluationNow,
    closedAt: null,
  };
  const workItem =
    kind === "pull_request" ? { ...common, kind, isDraft: false } : { ...common, kind };
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const revisionKey =
    kind === "pull_request"
      ? sha256(`${baseSha}\0${headSha}`)
      : sha256(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  return {
    contractVersion: 1,
    eventId: `event-${githubWorkItemId}`,
    source: "webhook",
    sourceEventId: `delivery-${githubWorkItemId}`,
    occurredAt: evaluationNow,
    observedAt: evaluationNow,
    repository,
    author: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    actor: reviewer,
    target: reviewer,
    workItem,
    revision: {
      githubRepositoryId: repository.githubRepositoryId,
      githubWorkItemId,
      revisionKey,
      observedAt: evaluationNow,
      sourceUpdatedAt: evaluationNow,
      ...(kind === "pull_request"
        ? { kind, baseSha, headSha }
        : { kind, contentDigest: revisionKey }),
    },
  };
}

function ingest(database: DatabaseSync, event: NormalizedSchedulingEvent) {
  const renderedPrompt = "Review the stored source.";
  return ingestSchedulingEvent(database, {
    allowScheduling: true,
    event,
    policy,
    schedule: {
      jobKind: event.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 1,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: event.repository.githubRepositoryId,
          fullName: event.repository.fullName,
        },
        resource: {
          githubNodeId: event.workItem.githubNodeId,
          number: event.workItem.number,
          title: event.workItem.title,
          author: reviewer,
          canonicalSnapshot: event.workItem,
          ...(event.revision.kind === "pull_request"
            ? {
                kind: "pull_request",
                baseSha: event.revision.baseSha,
                headSha: event.revision.headSha,
                isDraft: false,
              }
            : { kind: "issue", revisionDigest: event.revision.revisionKey }),
        },
        prompt: {
          name: "evaluation-management-fixture",
          version: "1",
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
    },
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: event.workItem.kind,
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: event.observedAt,
    },
  });
}

export function setEvaluationManagementRole(
  database: DatabaseSync,
  repositoryId: string,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
  principal: OperatorPrincipal = evaluationActor,
): void {
  handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        actor: evaluationAdministrator,
        repositoryId,
        request: {
          principal,
          role,
          expectedVersion,
          changeId: `access-${sha256(canonicalJson({ repositoryId, principal, expectedVersion }))}`,
          reason: "Authorize the isolated evaluation management fixture.",
        },
      },
    },
    evaluationLater,
    [evaluationAdministrator],
  );
}

export function createEvaluationManagementFixture(
  kind: "pull_request" | "issue" = "pull_request",
  options: EvaluationManagementFixtureOptions = {},
): EvaluationManagementFixture {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  const close = () => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };
  try {
    database.exec("PRAGMA foreign_keys = ON");
    runMigrations(database, options.migrationsDirectory ?? migrationDirectory);
    const githubRepositoryId = options.githubRepositoryId ?? 1;
    const secondGithubRepositoryId = options.secondGithubRepositoryId ?? githubRepositoryId + 1;
    if (secondGithubRepositoryId === githubRepositoryId)
      throw new Error("The fixture requires two distinct repository identities.");
    const repositories = [metadata(githubRepositoryId), metadata(secondGithubRepositoryId)];
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "bootstrapManagedRepositories",
        input: {
          repositories: repositories.map(({ githubRepositoryId, fullName }) => ({
            githubRepositoryId,
            fullName,
          })),
          reviewer,
          authorizationPolicy: policy,
        },
      },
      evaluationNow,
    );
    const event = observed(kind, metadata(githubRepositoryId));
    const secondEvent = observed(kind, metadata(secondGithubRepositoryId));
    const result = ingest(database, event);
    const secondResult = ingest(database, secondEvent);
    const repository = handleRepositoryConfigurationRequest(
      database,
      { operation: "getManagedRepository", input: { repositoryId: result.repositoryId } },
      evaluationNow,
    ) as ManagedRepository;
    const epoch = database
      .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
      .get(result.openedRequestEpochId) as { epoch_json: string };
    const activationId = "historical-source-activation";
    const planInput: ReviewRunPlanInput = {
      activationId,
      repository: {
        id: repository.id,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        configurationVersion: repository.version,
      },
      workItemId: result.workItemId,
      workItem: event.workItem,
      revision: event.revision,
      testedSourceRevision:
        event.revision.kind === "pull_request"
          ? {
              kind: "pull_request",
              baseSha: event.revision.baseSha,
              headSha: event.revision.headSha,
            }
          : { kind: "commit", headSha: "c".repeat(40) },
      testedSourceAuthorization:
        kind === "pull_request"
          ? null
          : {
              kind: "operator",
              activationId,
              ...evaluationActor,
              authorizedAt: evaluationNow,
              githubRepositoryId: repository.githubRepositoryId,
              githubWorkItemId: event.workItem.githubWorkItemId,
              issueRevisionKey: event.revision.revisionKey,
              headSha: "c".repeat(40),
            },
      authorization: JSON.parse(epoch.epoch_json) as ActiveAuthorizedRequestEpoch,
      authorizationPolicy: policy,
      requests: [
        {
          requestId: "fixture-request",
          workflowKind: kind === "pull_request" ? "pr_static_build" : "issue_validation",
          target: "headless",
          required: true,
          profileVersion: null,
          prompt: null,
        },
      ],
      runnerSupport: [],
    };
    setEvaluationManagementRole(database, repository.id, "maintainer");
    const reference: CurrentEvaluationSourceReference = {
      kind: "current_work_item",
      workItemId: result.workItemId,
      expectedRevisionKey: event.revision.revisionKey,
      testedIssueCommit: null,
    };
    const secondReference: CurrentEvaluationSourceReference = {
      kind: "current_work_item",
      workItemId: secondResult.workItemId,
      expectedRevisionKey: secondEvent.revision.revisionKey,
      testedIssueCommit: null,
    };
    return {
      database,
      repositoryId: repository.id,
      secondRepositoryId: secondResult.repositoryId,
      event,
      secondEvent,
      reference,
      secondReference,
      planInput,
      createRun: () =>
        handleReviewRunRequest(
          database,
          {
            operation: "createReviewRun",
            input: { planInput, actor: evaluationActor },
          },
          evaluationNow,
        ) as ReviewRunDetail,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export function reviseEvaluationManagementSource(
  fixture: EvaluationManagementFixture,
  body: string,
  headSha = "d".repeat(40),
) {
  const { event } = fixture;
  const workItem = { ...event.workItem, body, updatedAt: evaluationLater };
  const revisionKey =
    event.revision.kind === "pull_request"
      ? sha256(`${event.revision.baseSha}\0${headSha}`)
      : sha256(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  const changeId = sha256(canonicalJson({ body, headSha })).slice(0, 16);
  const changed: NormalizedSchedulingEvent = {
    ...event,
    eventId: `${event.eventId}-changed-${changeId}`,
    sourceEventId: `${event.sourceEventId}-changed-${changeId}`,
    observedAt: evaluationLater,
    occurredAt: evaluationLater,
    action: "revision_observed",
    requestKind: null,
    actor: null,
    target: null,
    workItem,
    revision: {
      ...event.revision,
      observedAt: evaluationLater,
      sourceUpdatedAt: evaluationLater,
      revisionKey,
      ...(event.revision.kind === "pull_request" ? { headSha } : { contentDigest: revisionKey }),
    },
  };
  ingest(fixture.database, changed);
  return { workItem, revisionKey };
}
