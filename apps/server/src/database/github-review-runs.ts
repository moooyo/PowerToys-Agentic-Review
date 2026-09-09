import type { DatabaseSync } from "node:sqlite";
import {
  type ActiveAuthorizedRequestEpoch,
  ActiveAuthorizedRequestEpochSchema,
  EntityIdSchema,
  type ManagedRepository,
  ManagedRepositorySchema,
  maximumReviewRunRequestCount,
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
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { GitHubIngestionInvariantError } from "./errors.js";
import {
  handleRepositoryConfigurationRequest,
  type RepositoryOperationMap,
} from "./managed-repositories.js";
import {
  type ConfigurationActor,
  handlePromptConfigurationRequest,
  type ResolvedWorkflowPrompt,
} from "./prompt-configuration.js";
import { ordinaryReviewJobSql } from "./review-purpose.js";
import {
  createReviewRunInTransaction,
  getReviewRunByActivation,
  type ReviewRunDetail,
} from "./review-runs.js";
import {
  dispatchReviewRunInTransaction,
  type ValidationDispatchResult,
} from "./validation-dispatch.js";

const automaticActor: ConfigurationActor = {
  issuer: "urn:agentic-review:server",
  subject: "github-ingestion",
};

function invalid(message: string): never {
  throw new GitHubIngestionInvariantError(message);
}

function assertTransaction(database: DatabaseSync, now: string): void {
  if (!database.isTransaction)
    invalid("GitHub review runs require an existing database transaction.");
  if (
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  ) {
    invalid("GitHub review run timestamps must be canonical UTC values.");
  }
}

export function observeGitHubReviewRunSourceInTransaction(
  database: DatabaseSync,
  input: {
    readonly workItemId: string;
    readonly currentRevisionKey: string;
    readonly revisionChanged: boolean;
  },
  now: string,
): number {
  assertTransaction(database, now);
  const source = database
    .prepare(`SELECT current_revision_key, sequence FROM github_review_run_sources
    WHERE work_item_id = ?`)
    .get(input.workItemId) as { current_revision_key: string; sequence: number } | undefined;
  if (!source) {
    database
      .prepare(`INSERT INTO github_review_run_sources (work_item_id, current_revision_key, sequence, activated_at)
      VALUES (?, ?, 1, ?)`)
      .run(input.workItemId, input.currentRevisionKey, now);
    return 1;
  }
  if (source.current_revision_key === input.currentRevisionKey) {
    if (input.revisionChanged)
      invalid("A projected source change did not advance its revision identity.");
    return source.sequence;
  }
  if (!input.revisionChanged)
    invalid("The GitHub source activation does not match its work item projection.");
  if (!Number.isSafeInteger(source.sequence + 1))
    invalid("The GitHub source activation sequence is exhausted.");
  database
    .prepare(`UPDATE github_review_run_sources SET current_revision_key = ?, sequence = sequence + 1,
    activated_at = ? WHERE work_item_id = ?`)
    .run(input.currentRevisionKey, now, input.workItemId);
  return source.sequence + 1;
}

interface BoundProfileRow {
  readonly profile_id: string;
  readonly profile_version_id: string;
  readonly profile_repository_id: string | null;
  readonly workflow_kind: WorkflowKind | null;
  readonly target: ValidationTarget | null;
  readonly published_profile_id: string | null;
  readonly required: number | null;
}

type BoundProfile = BoundProfileRow & {
  readonly workflow_kind: WorkflowKind;
  readonly target: ValidationTarget;
  readonly required: number;
};

function applicableProfiles(
  database: DatabaseSync,
  repositoryId: string,
  kind: "pull_request" | "issue",
): BoundProfile[] {
  const workflows: readonly [WorkflowKind, WorkflowKind] =
    kind === "pull_request" ? ["pr_static_build", "pr_ui"] : ["issue_triage", "issue_validation"];
  const rows = database
    .prepare(`SELECT binding.profile_id, binding.profile_version_id,
    profile.repository_id AS profile_repository_id, profile.workflow_kind, profile.target,
    version.profile_id AS published_profile_id, version.required
    FROM validation_profile_bindings AS binding
    LEFT JOIN validation_profiles AS profile ON profile.id = binding.profile_id
    LEFT JOIN validation_profile_versions AS version ON version.id = binding.profile_version_id
    WHERE binding.repository_id = ? AND binding.enabled = 1
      AND (profile.id IS NULL OR profile.repository_id <> ? OR profile.workflow_kind IN (?, ?))
    ORDER BY binding.profile_id LIMIT 1025`)
    .all(repositoryId, repositoryId, workflows[0], workflows[1]) as unknown as BoundProfileRow[];
  if (rows.length > 1_024) invalid("The repository has too many enabled validation profiles.");
  const selected: BoundProfile[] = [];
  for (const row of rows) {
    if (
      row.profile_repository_id !== repositoryId ||
      !Value.Check(WorkflowKindSchema, row.workflow_kind) ||
      !Value.Check(ValidationTargetSchema, row.target)
    )
      invalid("The enabled validation profile scope is invalid.");
    if (!workflows.includes(row.workflow_kind)) continue;
    if (
      row.published_profile_id !== row.profile_id ||
      !Value.Check(EntityIdSchema, row.profile_id) ||
      !Value.Check(EntityIdSchema, row.profile_version_id) ||
      (row.required !== 0 && row.required !== 1)
    ) {
      invalid("An enabled validation profile binding has no valid published version.");
    }
    selected.push({
      ...row,
      workflow_kind: row.workflow_kind,
      target: row.target,
      required: row.required,
    });
  }
  if (selected.length > maximumReviewRunRequestCount) {
    invalid(
      `Automatic review runs support at most ${maximumReviewRunRequestCount} enabled profiles.`,
    );
  }
  return selected;
}

type WorkItemContext = NonNullable<RepositoryOperationMap["getPromptWorkItemContext"]["output"]>;

interface AutomaticReviewRunScope {
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly requestEpochId: string;
}

export interface AutomaticGitHubReviewRunResult {
  readonly kind: "review_run";
  readonly run: ReviewRunDetail;
  readonly created: boolean;
  readonly dispatch: ValidationDispatchResult | null;
}

export interface PinnedGitHubLegacyJob {
  readonly kind: "legacy";
  readonly jobId: string;
}

/** Preserve legacy routing independently of job state so repeated observations cannot rerun it. */
export function pinGitHubLegacyJobInTransaction(
  database: DatabaseSync,
  input: { readonly workItemId: string; readonly jobId: string },
  now: string,
): void {
  assertTransaction(database, now);
  if (!Value.Check(EntityIdSchema, input.workItemId) || !Value.Check(EntityIdSchema, input.jobId)) {
    invalid("The legacy job activation identity is invalid.");
  }
  assertLegacyReviewJob(database, input.workItemId, input.jobId);
  const source = database
    .prepare(
      "SELECT current_revision_key, sequence FROM github_review_run_sources WHERE work_item_id = ?",
    )
    .get(input.workItemId) as { current_revision_key: string; sequence: number } | undefined;
  if (!source) invalid("The legacy job source activation is missing.");
  const epochs = database
    .prepare(`SELECT epoch.id FROM request_epochs AS epoch
    JOIN job_request_epochs AS link ON link.request_epoch_id = epoch.id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
    WHERE epoch.work_item_id = ? AND epoch.status = 'active' AND link.job_id = ?
      AND revision.revision_key = ? ORDER BY epoch.ordinal LIMIT 1025`)
    .all(input.workItemId, input.jobId, source.current_revision_key) as { id: string }[];
  if (epochs.length > 1_024) invalid("The legacy job has too many active authorization epochs.");
  if (epochs.length === 0) invalid("The legacy job has no current authorized source epoch.");
  for (const epoch of epochs) {
    const existing = database
      .prepare(`SELECT mode FROM github_review_run_activations
      WHERE work_item_id = ? AND request_epoch_id = ? AND source_sequence = ?`)
      .get(input.workItemId, epoch.id, source.sequence);
    if (existing) continue;
    database
      .prepare(`INSERT INTO github_review_run_activations
      (work_item_id, request_epoch_id, source_sequence, revision_key, mode, review_run_id, legacy_job_id, created_at)
      VALUES (?, ?, ?, ?, 'legacy', NULL, ?, ?)`)
      .run(
        input.workItemId,
        epoch.id,
        source.sequence,
        source.current_revision_key,
        input.jobId,
        now,
      );
  }
}

/** Transport execution templates and prompt text are deliberately not accepted by this boundary. */
export function createGitHubReviewRunInTransaction(
  database: DatabaseSync,
  input: AutomaticReviewRunScope,
  now: string,
): AutomaticGitHubReviewRunResult | PinnedGitHubLegacyJob | null {
  assertTransaction(database, now);
  if (
    ![input.repositoryId, input.workItemId, input.requestEpochId].every((id) =>
      Value.Check(EntityIdSchema, id),
    )
  ) {
    invalid("The automatic review run identity is invalid.");
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
    !context ||
    context.repositoryId !== input.repositoryId ||
    context.workItem.state !== "open"
  ) {
    invalid("Automatic review runs require the current open repository work item.");
  }
  const source = database
    .prepare(`SELECT current_revision_key, sequence FROM github_review_run_sources
    WHERE work_item_id = ?`)
    .get(input.workItemId) as { current_revision_key: string; sequence: number } | undefined;
  if (!source || source.current_revision_key !== context.revision.revisionKey) {
    invalid("The automatic review run source activation is missing or stale.");
  }
  const routing = database
    .prepare(`SELECT mode, review_run_id, legacy_job_id FROM github_review_run_activations
    WHERE work_item_id = ? AND request_epoch_id = ? AND source_sequence = ?`)
    .get(input.workItemId, input.requestEpochId, source.sequence) as
    | {
        mode: "legacy" | "review_run";
        review_run_id: string | null;
        legacy_job_id: string | null;
      }
    | undefined;
  if (routing?.mode === "legacy") {
    if (routing.legacy_job_id === null) invalid("The pinned legacy execution is missing.");
    assertLegacyReviewJob(database, input.workItemId, routing.legacy_job_id);
    return { kind: "legacy", jobId: routing.legacy_job_id };
  }
  const activationId = `github-run:${sha256(
    canonicalJson({
      workItemId: input.workItemId,
      requestEpochId: input.requestEpochId,
      revisionKey: source.current_revision_key,
      sourceSequence: source.sequence,
    }),
  )}`;
  const previous = getReviewRunByActivation(database, {
    repositoryId: input.repositoryId,
    workItemId: input.workItemId,
    activationId,
  });
  if (previous) {
    if (
      previous.createdBy.issuer !== automaticActor.issuer ||
      previous.createdBy.subject !== automaticActor.subject
    ) {
      invalid("The automatic review run activation belongs to another actor.");
    }
    if (routing?.mode !== "review_run" || routing.review_run_id !== previous.id) {
      invalid("The automatic review run activation has inconsistent routing.");
    }
    return { kind: "review_run", run: previous, created: false, dispatch: null };
  }
  if (routing) invalid("The pinned automatic review run is missing.");
  const bindings = applicableProfiles(database, input.repositoryId, context.workItem.kind);
  if (bindings.length === 0) return null;
  const repository = handleRepositoryConfigurationRequest(
    database,
    {
      operation: "getManagedRepository",
      input: { repositoryId: input.repositoryId },
    },
    now,
  ) as ManagedRepository | null;
  if (
    !repository ||
    !Value.Check(ManagedRepositorySchema, repository) ||
    !repository.enabled ||
    repository.githubRepositoryId !== context.repository.githubRepositoryId ||
    repository.authorizationPolicy === null ||
    !Value.Check(SelfOrAllowlistPolicySchema, repository.authorizationPolicy)
  ) {
    invalid("The managed repository is not configured for automatic validation.");
  }
  const row = database
    .prepare(`SELECT epoch.epoch_json, decision.policy_json, decision.policy_sha256
    FROM request_epochs AS epoch JOIN authorization_decisions AS decision
      ON decision.id = epoch.authorization_decision_id AND decision.work_item_id = epoch.work_item_id
        AND decision.github_event_id = epoch.opening_event_id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id AND revision.work_item_id = epoch.work_item_id
    WHERE epoch.id = ? AND epoch.work_item_id = ? AND epoch.status = 'active'
      AND decision.outcome = 'authorized' AND revision.revision_key = ?`)
    .get(input.requestEpochId, input.workItemId, context.revision.revisionKey) as
    | {
        epoch_json: string;
        policy_json: string;
        policy_sha256: string;
      }
    | undefined;
  if (!row) invalid("The automatic review run has no exact active authorization epoch.");
  const authorization: unknown = JSON.parse(row.epoch_json);
  const policy: unknown = JSON.parse(row.policy_json);
  if (
    !Value.Check(ActiveAuthorizedRequestEpochSchema, authorization) ||
    !Value.Check(SelfOrAllowlistPolicySchema, policy) ||
    sha256(canonicalJson(policy)) !== row.policy_sha256 ||
    canonicalJson(policy) !== canonicalJson(repository.authorizationPolicy) ||
    (context.workItem.kind === "issue" && authorization.requestKind !== "assignment")
  ) {
    invalid("The automatic review run authorization does not match the current repository policy.");
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
      profile.repositoryId !== input.repositoryId ||
      profile.profileId !== binding.profile_id ||
      profile.id !== binding.profile_version_id ||
      profile.workflowKind !== binding.workflow_kind ||
      profile.target !== binding.target ||
      profile.required !== (binding.required === 1)
    )
      invalid("The automatic validation profile snapshot is inconsistent.");
    if (!promptCache.has(binding.workflow_kind)) {
      promptCache.set(
        binding.workflow_kind,
        handlePromptConfigurationRequest(
          database,
          {
            operation: "resolveWorkflowPrompt",
            input: { repositoryId: input.repositoryId, workflowKind: binding.workflow_kind },
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
    activationId,
    repository: {
      id: repository.id,
      githubRepositoryId: repository.githubRepositoryId,
      fullName: repository.fullName,
      configurationVersion: repository.version,
    },
    workItemId: input.workItemId,
    workItem: context.workItem,
    revision: context.revision,
    testedSourceRevision:
      context.revision.kind === "pull_request"
        ? {
            kind: "pull_request",
            baseSha: context.revision.baseSha,
            headSha: context.revision.headSha,
          }
        : null,
    testedSourceAuthorization: null,
    authorization: authorization as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy as SelfOrAllowlistPolicy,
    requests,
    runnerSupport: [],
  };
  const run = createReviewRunInTransaction(
    database,
    {
      planInput,
      actor: automaticActor,
      intentDigest: sha256(
        canonicalJson({
          schemaVersion: "GitHubReviewRunIntentV1",
          repositoryId: input.repositoryId,
          workItemId: input.workItemId,
          requestEpochId: input.requestEpochId,
          revisionKey: source.current_revision_key,
          sourceSequence: source.sequence,
          actor: automaticActor,
        }),
      ),
    },
    now,
  );
  database
    .prepare(`INSERT INTO github_review_run_activations
    (work_item_id, request_epoch_id, source_sequence, revision_key, mode, review_run_id, legacy_job_id, created_at)
    VALUES (?, ?, ?, ?, 'review_run', ?, NULL, ?)`)
    .run(
      input.workItemId,
      input.requestEpochId,
      source.sequence,
      source.current_revision_key,
      run.id,
      now,
    );
  const dispatch = dispatchReviewRunInTransaction(
    database,
    {
      repositoryId: input.repositoryId,
      reviewRunId: run.id,
      actor: automaticActor,
    },
    now,
  );
  return { kind: "review_run", run, created: true, dispatch };
}

function assertLegacyReviewJob(database: DatabaseSync, workItemId: string, jobId: string): void {
  const job = database
    .prepare(`SELECT 1 FROM jobs AS job WHERE job.id = ? AND job.work_item_id = ?
      AND ${ordinaryReviewJobSql("job")}
      AND CASE WHEN json_valid(job.execution_json)
        THEN json_type(job.execution_json, '$.validation') IS NULL ELSE 0 END`)
    .get(jobId, workItemId);
  if (!job) invalid("GitHub legacy routing requires an ordinary non-validation Job.");
}
