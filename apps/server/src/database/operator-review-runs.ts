import type { DatabaseSync } from "node:sqlite";
import {
  type ActiveAuthorizedRequestEpoch,
  ActiveAuthorizedRequestEpochSchema,
  EntityIdSchema,
  type ManagedRepository,
  ManagedRepositorySchema,
  maximumReviewRunRequestCount,
  type OperatorReviewRunCreateRequest,
  OperatorReviewRunCreateRequestSchema,
  type ReviewRunPlanInput,
  type SelfOrAllowlistPolicy,
  SelfOrAllowlistPolicySchema,
  type ValidationProfileVersion,
  ValidationProfileVersionSchema,
  type ValidationTarget,
  ValidationTargetSchema,
  type WorkflowKind,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
import { canonicalizeIssueReproductionRequest } from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  handleRepositoryConfigurationRequest,
  type RepositoryOperationMap,
} from "./managed-repositories.js";
import {
  type ConfigurationActor,
  handlePromptConfigurationRequest,
  type ResolvedWorkflowPrompt,
} from "./prompt-configuration.js";
import {
  createReviewRunInTransaction,
  getReviewRunByActivation,
  type ReviewRunDetail,
} from "./review-runs.js";
import { dispatchReviewRunInTransaction } from "./validation-dispatch.js";

export type { OperatorReviewRunCreateRequest };
export { OperatorReviewRunCreateRequestSchema };

export interface CreateOperatorReviewRunInput {
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly request: OperatorReviewRunCreateRequest;
  readonly actor: ConfigurationActor;
}

export interface OperatorReviewRunOperationMap {
  readonly createOperatorReviewRun: {
    readonly input: CreateOperatorReviewRunInput;
    readonly output: ReviewRunDetail;
  };
}

const inputSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    workItemId: EntityIdSchema,
    request: OperatorReviewRunCreateRequestSchema,
    actor: Type.Object(
      {
        issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
        subject: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export class OperatorReviewRunError extends Error {
  public constructor(
    public readonly code: "PLATFORM_INVALID" | "PLATFORM_NOT_FOUND" | "PLATFORM_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "OperatorReviewRunError";
  }
}

function invalid(message: string): never {
  throw new OperatorReviewRunError("PLATFORM_INVALID", message);
}
function conflict(message: string): never {
  throw new OperatorReviewRunError("PLATFORM_CONFLICT", message);
}
function notFound(): never {
  throw new OperatorReviewRunError("PLATFORM_NOT_FOUND", "The repository work item was not found.");
}

type WorkItemContext = NonNullable<RepositoryOperationMap["getPromptWorkItemContext"]["output"]>;

interface EpochRow {
  readonly id: string;
  readonly ordinal: number;
  readonly request_kind: string;
  readonly epoch_json: string;
  readonly basis: string;
  readonly actor_github_user_id: number;
  readonly decision_target: number;
  readonly policy_json: string;
  readonly policy_sha256: string;
}

const requireAuthorization = (
  database: DatabaseSync,
  input: CreateOperatorReviewRunInput,
  context: WorkItemContext,
  policy: SelfOrAllowlistPolicy,
): ActiveAuthorizedRequestEpoch => {
  const rows = database
    .prepare(`
    SELECT epoch.id, epoch.ordinal, epoch.request_kind, epoch.epoch_json,
      decision.basis, decision.actor_github_user_id,
      decision.target_github_user_id AS decision_target,
      decision.policy_json, decision.policy_sha256
    FROM request_epochs AS epoch
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
      AND revision.work_item_id = epoch.work_item_id
    JOIN authorization_decisions AS decision ON decision.id = epoch.authorization_decision_id
      AND decision.work_item_id = epoch.work_item_id
      AND decision.github_event_id = epoch.opening_event_id
    WHERE epoch.work_item_id = ? AND epoch.status = 'active'
      AND epoch.target_github_user_id = ? AND revision.revision_key = ?
      AND decision.outcome = 'authorized' AND decision.policy_version = ?
      AND (? = 'pull_request' OR epoch.request_kind = 'assignment')
    ORDER BY epoch.ordinal DESC, epoch.id DESC LIMIT 3
  `)
    .all(
      input.workItemId,
      policy.schedulingTargetGithubUserId,
      context.revision.revisionKey,
      policy.policyVersion,
      context.workItem.kind,
    ) as unknown as EpochRow[];
  // An active assignment and an active review request are the only two kinds for one reviewer.
  if (rows.length > 2) conflict("The stored authorization epochs are inconsistent.");
  const currentPolicy = canonicalJson(policy);
  for (const row of rows) {
    let authorization: unknown;
    let decisionPolicy: unknown;
    try {
      authorization = JSON.parse(row.epoch_json);
      decisionPolicy = JSON.parse(row.policy_json);
    } catch {
      conflict("The stored authorization epoch is invalid.");
    }
    if (
      !Value.Check(ActiveAuthorizedRequestEpochSchema, authorization) ||
      !Value.Check(SelfOrAllowlistPolicySchema, decisionPolicy) ||
      sha256(canonicalJson(decisionPolicy)) !== row.policy_sha256
    ) {
      conflict("The stored authorization epoch is invalid.");
    }
    if (canonicalJson(decisionPolicy) !== currentPolicy) continue;
    if (
      authorization.requestEpochId !== row.id ||
      authorization.sequence !== row.ordinal ||
      authorization.requestKind !== row.request_kind ||
      authorization.authorizationBasis !== row.basis ||
      authorization.openedByActor.githubUserId !== row.actor_github_user_id ||
      authorization.target.githubUserId !== row.decision_target ||
      authorization.target.githubUserId !== policy.schedulingTargetGithubUserId ||
      authorization.authorizationPolicyVersion !== policy.policyVersion ||
      authorization.githubRepositoryId !== context.repository.githubRepositoryId ||
      authorization.githubWorkItemId !== context.workItem.githubWorkItemId ||
      authorization.currentRevision.kind !== context.revision.kind ||
      authorization.currentRevision.revisionKey !== context.revision.revisionKey
    ) {
      conflict("The stored authorization epoch has inconsistent identities.");
    }
    const authorizedActor =
      authorization.authorizationBasis === "self"
        ? authorization.openedByActor.githubUserId === authorization.target.githubUserId
        : policy.allowlistedActorGithubUserIds.includes(authorization.openedByActor.githubUserId);
    if (authorizedActor) return authorization;
  }
  conflict(
    context.workItem.kind === "pull_request"
      ? "This exact revision requires a new authorized GitHub review request or assignment."
      : "This issue revision requires a new authorized GitHub assignment.",
  );
};

interface ProfileBindingRow {
  readonly profile_id: string;
  readonly profile_version_id: string;
  readonly profile_repository_id: string | null;
  readonly workflow_kind: WorkflowKind | null;
  readonly target: ValidationTarget | null;
  readonly published_profile_id: string | null;
  readonly required: number | null;
}

type ApplicableProfileBinding = ProfileBindingRow & {
  readonly workflow_kind: WorkflowKind;
  readonly target: ValidationTarget;
  readonly required: number;
};

const selectedBindings = (
  database: DatabaseSync,
  input: CreateOperatorReviewRunInput,
  kind: WorkItemContext["workItem"]["kind"],
): ApplicableProfileBinding[] => {
  const workflows: readonly [WorkflowKind, WorkflowKind] =
    kind === "pull_request" ? ["pr_static_build", "pr_ui"] : ["issue_triage", "issue_validation"];
  const rows = database
    .prepare(`
    SELECT binding.profile_id, binding.profile_version_id,
      profile.repository_id AS profile_repository_id, profile.workflow_kind, profile.target,
      version.profile_id AS published_profile_id, version.required
    FROM validation_profile_bindings AS binding
    LEFT JOIN validation_profiles AS profile ON profile.id = binding.profile_id
    LEFT JOIN validation_profile_versions AS version ON version.id = binding.profile_version_id
    WHERE binding.repository_id = ? AND binding.enabled = 1
      AND (profile.id IS NULL OR profile.repository_id <> ? OR profile.workflow_kind IN (?, ?))
    ORDER BY binding.profile_id LIMIT 1025
  `)
    .all(
      input.repositoryId,
      input.repositoryId,
      workflows[0],
      workflows[1],
    ) as unknown as ProfileBindingRow[];
  if (rows.length > 1_024) conflict("The repository has too many enabled validation profiles.");
  const applicable: ApplicableProfileBinding[] = [];
  for (const row of rows) {
    if (
      row.profile_repository_id !== input.repositoryId ||
      !Value.Check(WorkflowKindSchema, row.workflow_kind) ||
      !Value.Check(ValidationTargetSchema, row.target)
    ) {
      conflict("An enabled validation profile binding has an invalid repository or workflow.");
    }
    if (!workflows.includes(row.workflow_kind)) continue;
    if (
      row.published_profile_id !== row.profile_id ||
      !Value.Check(EntityIdSchema, row.profile_id) ||
      !Value.Check(EntityIdSchema, row.profile_version_id) ||
      (row.required !== 0 && row.required !== 1)
    ) {
      conflict("An enabled validation profile binding has no valid published version.");
    }
    applicable.push({
      ...row,
      workflow_kind: row.workflow_kind,
      target: row.target,
      required: row.required,
    });
  }
  if (applicable.length === 0) {
    conflict(
      "Configure at least one enabled validation profile for this work item before creating a review run.",
    );
  }
  const selection =
    input.request.profileIds === undefined ? undefined : new Set(input.request.profileIds);
  if (
    selection !== undefined &&
    [...selection].some((id) => !applicable.some((row) => row.profile_id === id))
  ) {
    invalid("Selected profiles must be enabled bindings for this repository and work item.");
  }
  const selected = applicable.filter(
    (row) => row.required === 1 || selection === undefined || selection.has(row.profile_id),
  );
  if (selected.length === 0)
    invalid("Select at least one optional profile or configure a required profile.");
  if (selected.length > maximumReviewRunRequestCount) {
    conflict(
      `A review run can include at most ${maximumReviewRunRequestCount} selected and required profiles.`,
    );
  }
  return selected;
};

/** Builds a blocked plan from database authority; it does not enqueue jobs or grant GitHub authority. */
export function createOperatorReviewRun(
  database: DatabaseSync,
  input: CreateOperatorReviewRunInput,
  now: string,
): ReviewRunDetail {
  if (!Value.Check(inputSchema, input)) invalid("The operator review run request is invalid.");
  for (const value of [input.actor.issuer, input.actor.subject]) {
    if (!value.isWellFormed() || value.trim() !== value || value.includes("\0")) {
      invalid("An authenticated review run operator is required.");
    }
  }
  if (
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    invalid("A canonical review run timestamp is required.");
  }
  if (database.isTransaction)
    invalid("Operator review run creation must own its database transaction.");

  database.exec("BEGIN IMMEDIATE");
  try {
    let reproduction: OperatorReviewRunCreateRequest["reproduction"];
    try {
      reproduction =
        input.request.reproduction === undefined
          ? undefined
          : canonicalizeIssueReproductionRequest(input.request.reproduction);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) invalid(error.message);
      throw error;
    }
    const intentDigest = sha256(
      canonicalJson({
        schemaVersion: "OperatorReviewRunIntentV1",
        repositoryId: input.repositoryId,
        workItemId: input.workItemId,
        actor: { issuer: input.actor.issuer, subject: input.actor.subject },
        request: {
          activationId: input.request.activationId,
          expectedRevisionKey: input.request.expectedRevisionKey,
          profileIds:
            input.request.profileIds === undefined ? null : [...input.request.profileIds].sort(),
          testedSourceCommit: input.request.testedSourceCommit ?? null,
          ...(reproduction === undefined ? {} : { reproduction }),
        },
      }),
    );
    const previous = getReviewRunByActivation(database, {
      repositoryId: input.repositoryId,
      workItemId: input.workItemId,
      activationId: input.request.activationId,
    });
    if (previous !== null) {
      if (
        previous.intentDigest !== intentDigest ||
        previous.createdBy.issuer !== input.actor.issuer ||
        previous.createdBy.subject !== input.actor.subject
      ) {
        conflict("This activation belongs to a different creation request or operator.");
      }
      database.exec("COMMIT");
      return previous;
    }

    const repository = handleRepositoryConfigurationRequest(
      database,
      {
        operation: "getManagedRepository",
        input: { repositoryId: input.repositoryId },
      },
      now,
    ) as ManagedRepository | null;
    if (repository === null) notFound();
    if (!Value.Check(ManagedRepositorySchema, repository)) {
      conflict("The managed repository configuration is invalid.");
    }
    const context = handleRepositoryConfigurationRequest(
      database,
      {
        operation: "getPromptWorkItemContext",
        input: { workItemId: input.workItemId },
      },
      now,
    ) as WorkItemContext | null;
    if (
      context === null ||
      context.repositoryId !== input.repositoryId ||
      context.repository.githubRepositoryId !== repository.githubRepositoryId
    )
      notFound();
    if (!repository.enabled) conflict("Enable repository scheduling before creating a review run.");
    const policy = repository.authorizationPolicy;
    if (
      repository.reviewerGithubUserId === null ||
      repository.reviewerGithubLogin === null ||
      policy === null ||
      !Value.Check(SelfOrAllowlistPolicySchema, policy) ||
      policy.schedulingTargetGithubUserId !== repository.reviewerGithubUserId
    ) {
      conflict(
        "Configure the repository reviewer and authorization policy before creating a review run.",
      );
    }
    if (
      context.workItem.state !== "open" ||
      context.revision.revisionKey !== input.request.expectedRevisionKey
    ) {
      conflict(
        "The work item is closed or its revision changed. Refresh it before creating a review run.",
      );
    }
    const authorization = requireAuthorization(database, input, context, policy);
    const bindings = selectedBindings(database, input, context.workItem.kind);
    const includesIssueValidation = bindings.some(
      (binding) => binding.workflow_kind === "issue_validation",
    );
    const commit = input.request.testedSourceCommit;
    if (commit !== undefined && (context.workItem.kind !== "issue" || !includesIssueValidation)) {
      invalid("A tested source commit is accepted only for an issue validation review run.");
    }
    if (reproduction !== undefined) {
      if (context.workItem.kind !== "issue" || !includesIssueValidation || commit === undefined) {
        invalid(
          "Issue reproduction requires an issue validation run and an exact tested source commit.",
        );
      }
      for (const entry of reproduction.cases) {
        const selected = bindings.find((binding) => binding.profile_id === entry.profileId);
        if (selected === undefined || selected.workflow_kind !== "issue_validation") {
          invalid("Each reproduction case must refer to a selected issue validation profile.");
        }
        if (selected.profile_version_id !== entry.expectedProfileVersionId) {
          conflict(
            "A reproduction profile version changed. Refresh it before creating a review run.",
          );
        }
      }
    }

    const promptCache = new Map<WorkflowKind, ResolvedWorkflowPrompt | null>();
    const requests: ReviewRunPlanInput["requests"] = bindings.map((binding) => {
      const profile = handlePromptConfigurationRequest(
        database,
        {
          operation: "getValidationProfileVersion",
          input: {
            repositoryId: input.repositoryId,
            profileId: binding.profile_id,
            versionId: binding.profile_version_id,
          },
        },
        now,
      ) as ValidationProfileVersion;
      if (
        !Value.Check(ValidationProfileVersionSchema, profile) ||
        profile.repositoryId !== repository.id ||
        profile.profileId !== binding.profile_id ||
        profile.id !== binding.profile_version_id ||
        profile.workflowKind !== binding.workflow_kind ||
        profile.target !== binding.target ||
        profile.required !== (binding.required === 1)
      ) {
        conflict("The enabled validation profile does not match its published binding.");
      }
      if (!promptCache.has(binding.workflow_kind)) {
        promptCache.set(
          binding.workflow_kind,
          handlePromptConfigurationRequest(
            database,
            {
              operation: "resolveWorkflowPrompt",
              input: { repositoryId: repository.id, workflowKind: binding.workflow_kind },
            },
            now,
          ) as ResolvedWorkflowPrompt | null,
        );
      }
      const prompt = promptCache.get(binding.workflow_kind) ?? null;
      return {
        requestId: binding.profile_id,
        workflowKind: binding.workflow_kind,
        target: binding.target,
        required: profile.required,
        profileVersion: profile,
        prompt:
          prompt === null ? null : { workflowKind: binding.workflow_kind, version: prompt.version },
      };
    });
    const planInput: ReviewRunPlanInput = {
      activationId: input.request.activationId,
      ...(reproduction === undefined ? {} : { reproduction }),
      repository: {
        id: repository.id,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        configurationVersion: repository.version,
      },
      workItemId: input.workItemId,
      workItem: context.workItem,
      revision: context.revision,
      authorization,
      authorizationPolicy: policy,
      requests,
      runnerSupport: [],
      testedSourceRevision:
        context.revision.kind === "pull_request"
          ? {
              kind: "pull_request",
              baseSha: context.revision.baseSha,
              headSha: context.revision.headSha,
            }
          : commit === undefined
            ? null
            : { kind: "commit", headSha: commit },
      testedSourceAuthorization:
        context.revision.kind === "issue" && commit !== undefined
          ? {
              kind: "operator",
              activationId: input.request.activationId,
              issuer: input.actor.issuer,
              subject: input.actor.subject,
              authorizedAt: now,
              githubRepositoryId: repository.githubRepositoryId,
              githubWorkItemId: context.workItem.githubWorkItemId,
              issueRevisionKey: context.revision.revisionKey,
              headSha: commit,
            }
          : null,
    };
    const created = createReviewRunInTransaction(
      database,
      { planInput, actor: input.actor, intentDigest },
      now,
    );
    dispatchReviewRunInTransaction(
      database,
      { repositoryId: created.repositoryId, reviewRunId: created.id, actor: input.actor },
      now,
    );
    const current = getReviewRunByActivation(database, {
      repositoryId: created.repositoryId,
      workItemId: created.workItemId,
      activationId: created.activationId,
    });
    if (current === null) conflict("The newly dispatched review run could not be read.");
    database.exec("COMMIT");
    return current;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
