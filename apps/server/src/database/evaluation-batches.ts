import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationBatchPlan,
  type EvaluationBatchPlan,
} from "../scheduling/evaluation-batch-factory.js";
import {
  EvaluationManagementError,
  handleEvaluationManagementRequest,
  readPublishedEvaluationSuiteInTransaction,
} from "./evaluation-management.js";
import {
  persistEvaluationReproductionInTransaction,
  readEvaluationSourceReproductionInTransaction,
} from "./evaluation-reproduction.js";
import { assertEvaluationSourceSnapshotIntegrity } from "./evaluation-source.js";
import { readModelRuntimeRegistrationInTransaction } from "./model-runtime-registry.js";
import { assertRepositoryPermission, isPlatformAdministrator } from "./operator-access.js";
import {
  handlePromptConfigurationRequest,
  type ResolvedWorkflowPrompt,
} from "./prompt-configuration.js";

export interface CreateEvaluationBatchInput {
  readonly repositoryId: string;
  readonly actor: C.OperatorPrincipal;
  readonly request: C.EvaluationBatchCreateRequest;
  /** Trusted transport restriction, never accepted in public request bodies. */
  readonly replayOnly?: true;
}
const inputSchema = Type.Object(
  {
    repositoryId: C.EntityIdSchema,
    actor: C.OperatorPrincipalSchema,
    request: C.EvaluationBatchCreateRequestSchema,
    replayOnly: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

function fail(
  code: ConstructorParameters<typeof EvaluationManagementError>[0],
  message: string,
): never {
  throw new EvaluationManagementError(code, message);
}
function missing(): never {
  fail(
    "PLATFORM_NOT_FOUND",
    "The selected published evaluation configuration was not found in this scope.",
  );
}

function resolveConfiguration(
  database: DatabaseSync,
  input: CreateEvaluationBatchInput,
  selection: C.EvaluationConfigurationSelection,
  workflowKind: C.WorkflowKind,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationFrozenConfiguration {
  const profileIdentity = database
    .prepare(`SELECT version.profile_id FROM validation_profile_versions AS version
    JOIN validation_profiles AS profile ON profile.id = version.profile_id
    WHERE version.id = ? AND profile.repository_id = ?`)
    .get(selection.profileVersionId, input.repositoryId) as { profile_id: string } | undefined;
  if (!profileIdentity) missing();
  if (!isPlatformAdministrator(input.actor, administrators)) {
    const binding = handlePromptConfigurationRequest(
      database,
      {
        operation: "resolveWorkflowPrompt",
        input: { repositoryId: input.repositoryId, workflowKind },
      },
      now,
    ) as ResolvedWorkflowPrompt | null;
    const known =
      binding?.version.id === selection.promptVersionId ||
      database
        .prepare(`SELECT 1
      FROM review_run_requests AS request JOIN review_runs AS run ON run.id = request.review_run_id
      WHERE run.repository_id = ? AND request.workflow_kind = ? AND request.prompt_version_id = ? LIMIT 1`)
        .get(input.repositoryId, workflowKind, selection.promptVersionId);
    if (!known) missing();
  }
  const promptIdentity = database
    .prepare(`SELECT version.template_id FROM prompt_versions AS version
    JOIN prompt_templates AS template ON template.id = version.template_id
    WHERE version.id = ? AND template.workflow_kind = ?`)
    .get(selection.promptVersionId, workflowKind) as { template_id: string } | undefined;
  if (!promptIdentity) missing();
  const profileVersion = handlePromptConfigurationRequest(
    database,
    {
      operation: "getValidationProfileVersion",
      input: {
        repositoryId: input.repositoryId,
        profileId: profileIdentity.profile_id,
        versionId: selection.profileVersionId,
      },
    },
    now,
  ) as C.ValidationProfileVersion;
  const version = handlePromptConfigurationRequest(
    database,
    {
      operation: "getPromptVersion",
      input: { templateId: promptIdentity.template_id, versionId: selection.promptVersionId },
    },
    now,
  ) as C.PromptVersion;
  if (
    Date.parse(profileVersion.publishedAt) > Date.parse(now) ||
    Date.parse(version.publishedAt) > Date.parse(now)
  ) {
    fail(
      "PLATFORM_CORRUPT",
      "A selected evaluation configuration has a future publication timestamp.",
    );
  }
  const modelRuntime =
    selection.modelRuntimeRegistrationId === undefined
      ? undefined
      : readModelRuntimeRegistrationInTransaction(database, selection.modelRuntimeRegistrationId, {
          requireEnabled: true,
          now,
        });
  if (modelRuntime === null) missing();
  if (modelRuntime !== undefined && input.request.mode !== "prompt_and_profile")
    fail(
      "PLATFORM_INVALID",
      "Profile-only evaluations cannot select a model runtime registration.",
    );
  return {
    profileVersion,
    prompt: { workflowKind, version },
    // Registration freezes an expectation; it does not attest actual execution or isolation.
    modelRequirements: {
      required: input.request.mode === "prompt_and_profile",
      expectedModelIdentityDigest: modelRuntime?.registration.identitySha256 ?? null,
      ...(modelRuntime === undefined
        ? {}
        : {
            runtimeRegistration: {
              registrationId: modelRuntime.registration.id,
              registrationSha256: modelRuntime.registrationSha256,
            },
          }),
    },
    ...(modelRuntime === undefined ? {} : { modelRuntimeRegistration: modelRuntime.registration }),
  };
}

function replay(
  database: DatabaseSync,
  input: CreateEvaluationBatchInput,
  digest: string,
): C.EvaluationBatchSummaryV1 | null {
  const row = database
    .prepare(`SELECT operation, entity_id, intent_digest, actor_issuer, actor_subject,
    previous_version, version, response_json, created_at FROM evaluation_mutation_receipts
    WHERE repository_id = ? AND change_id = ?`)
    .get(input.repositoryId, input.request.changeId) as
    | {
        operation: string;
        entity_id: string;
        intent_digest: string;
        actor_issuer: string;
        actor_subject: string;
        previous_version: number;
        version: number;
        response_json: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  if (
    row.operation !== "evaluation_created" ||
    row.intent_digest !== digest ||
    row.actor_issuer !== input.actor.issuer ||
    row.actor_subject !== input.actor.subject
  ) {
    fail(
      "PLATFORM_CONFLICT",
      "This evaluation change ID belongs to a different operation, intent, or actor.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.response_json);
  } catch {
    fail("PLATFORM_CORRUPT", "The evaluation receipt contains invalid JSON.");
  }
  if (
    !Value.Check(C.EvaluationBatchSummaryV1Schema, value) ||
    value.id !== row.entity_id ||
    value.repositoryId !== input.repositoryId ||
    value.suiteId !== input.request.suiteId ||
    value.suiteVersionId !== input.request.suiteVersionId ||
    value.mode !== input.request.mode ||
    canonicalJson(value.baseline) !== canonicalJson(input.request.baseline) ||
    canonicalJson(value.candidate) !== canonicalJson(input.request.candidate) ||
    canonicalJson(value.createdBy) !== canonicalJson(input.actor) ||
    value.createdAt !== row.created_at ||
    value.cellCount !== value.caseCount * 2 ||
    row.previous_version !== 0 ||
    row.version !== 1 ||
    !database
      .prepare(`SELECT 1 FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
      WHERE evaluation.id = ? AND evaluation.repository_id = ?`)
      .get(row.entity_id, input.repositoryId)
  ) {
    fail("PLATFORM_CORRUPT", "The evaluation receipt does not match its complete persisted batch.");
  }
  return value;
}

function persist(
  database: DatabaseSync,
  plan: EvaluationBatchPlan,
  input: CreateEvaluationBatchInput,
  digest: string,
): void {
  const { summary, authorization, cells } = plan;
  const now = summary.createdAt,
    actor = input.actor;
  const suite = database
    .prepare(`SELECT source_version_id, expectation_version_id FROM evaluation_suite_versions
    WHERE id = ? AND repository_id = ?`)
    .get(summary.suiteVersionId, summary.repositoryId) as
    | { source_version_id: string; expectation_version_id: string }
    | undefined;
  if (!suite) missing();
  database
    .prepare(`INSERT INTO evaluations (id, repository_id, suite_version_id, source_version_id, expectation_version_id,
    workflow_kind, target, source_manifest_sha256, configuration_manifest_sha256, cell_manifest_sha256,
    execution_manifest_sha256, configuration_manifest_json, cell_manifest_json, execution_manifest_json,
    scoring_plan_digest, scoring_plan_json, case_count, cell_count, actor_issuer, actor_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      summary.id,
      summary.repositoryId,
      summary.suiteVersionId,
      suite.source_version_id,
      suite.expectation_version_id,
      summary.workflowKind,
      summary.target,
      authorization.sourceManifestSha256,
      plan.configurationDigest,
      plan.cellManifestDigest,
      plan.executionManifestDigest,
      canonicalJson(plan.configuration),
      canonicalJson(plan.cellManifest),
      canonicalJson(plan.executionManifest),
      plan.scoringPlanDigest,
      canonicalJson(plan.scoringPlan),
      summary.caseCount,
      summary.cellCount,
      actor.issuer,
      actor.subject,
      now,
    );
  database
    .prepare(`INSERT INTO evaluation_authorizations (id, evaluation_id, repository_id, authorization_digest,
    authorization_json, actor_issuer, actor_subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      authorization.id,
      summary.id,
      summary.repositoryId,
      plan.authorizationDigest,
      canonicalJson(authorization),
      actor.issuer,
      actor.subject,
      now,
    );
  const insertCell =
    database.prepare(`INSERT INTO evaluation_cells (id, evaluation_id, repository_id, case_id, arm, trial,
    source_id, source_digest, run_id, request_id, activation_id, profile_version_id, prompt_version_id, authorization_id, applicable)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const cell of cells) {
    const m = cell.manifest;
    insertCell.run(
      m.cellId,
      summary.id,
      summary.repositoryId,
      m.caseId,
      m.arm,
      m.sourceId,
      m.sourceDigest,
      m.runId,
      m.requestId,
      m.activationId,
      m.profileVersionId,
      m.promptVersionId,
      authorization.id,
      Number(cell.applicable),
    );
  }
  const insertRun =
    database.prepare(`INSERT INTO review_runs (id, repository_id, work_item_id, revision_id, revision_key,
    request_epoch_id, activation_id, creation_intent_digest, plan_digest, plan_json, readiness_json,
    required_request_blockers_json, request_count, blocked_request_count, required_blocker_count, actor_issuer, actor_subject,
    created_at, purpose, evaluation_cell_id) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'evaluation', ?)`);
  const insertRequest =
    database.prepare(`INSERT INTO review_run_requests (review_run_id, request_id, workflow_kind, target,
    required, profile_version_id, prompt_version_id, prompt_envelope_json, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const cell of cells) {
    const m = cell.manifest,
      request = cell.plan.jobs[0];
    if (!request) fail("PLATFORM_CORRUPT", "The evaluation cell is missing its request.");
    const blockers = cell.readiness.flatMap((entry) =>
      entry.required
        ? entry.reasons.map((reason) => ({ requestId: entry.requestId, reason: reason.code }))
        : [],
    );
    insertRun.run(
      m.runId,
      summary.repositoryId,
      cell.source.workItemId,
      cell.source.revisionId,
      cell.source.revision.revisionKey,
      m.activationId,
      digest,
      cell.planDigest,
      canonicalJson(cell.plan),
      canonicalJson(cell.readiness),
      canonicalJson(blockers),
      cell.readiness.filter((entry) => entry.state === "blocked").length,
      blockers.length,
      actor.issuer,
      actor.subject,
      now,
      m.cellId,
    );
    insertRequest.run(
      m.runId,
      m.requestId,
      request.workflowKind,
      request.target,
      Number(request.required),
      m.profileVersionId,
      m.promptVersionId,
      canonicalJson(cell.prompt),
      canonicalJson(request),
    );
    database
      .prepare(`INSERT INTO review_run_audit (id, review_run_id, action, actor_issuer, actor_subject, detail_json, created_at)
      VALUES (?, ?, 'planned', ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        m.runId,
        actor.issuer,
        actor.subject,
        canonicalJson({
          evaluationId: summary.id,
          cellId: m.cellId,
          planDigest: cell.planDigest,
          intentDigest: digest,
        }),
        now,
      );
    if (!cell.applicable) {
      database
        .prepare(
          `UPDATE validation_dispatch_checks SET pending = 0 WHERE review_run_id = ? AND request_id = ?`,
        )
        .run(m.runId, m.requestId);
    }
  }
  if (plan.reproductionManifest !== null)
    persistEvaluationReproductionInTransaction(database, {
      sources: plan.reproductionSources,
      cells: plan.cells.map((cell) => cell.reproductionRecord),
      manifest: plan.reproductionManifest,
      now,
    });
  database
    .prepare("INSERT INTO evaluation_seals (evaluation_id, sealed_at) VALUES (?, ?)")
    .run(summary.id, now);
  database
    .prepare(`INSERT INTO evaluation_controls (evaluation_id, status, version, actor_issuer, actor_subject, reason, updated_at)
    VALUES (?, 'active', 1, ?, ?, NULL, ?)`)
    .run(summary.id, actor.issuer, actor.subject, now);
  database
    .prepare(`INSERT INTO evaluation_mutation_receipts (repository_id, change_id, operation, entity_id,
    intent_digest, actor_issuer, actor_subject, previous_version, version, response_json, created_at)
    VALUES (?, ?, 'evaluation_created', ?, ?, ?, ?, 0, 1, ?, ?)`)
    .run(
      summary.repositoryId,
      input.request.changeId,
      summary.id,
      digest,
      actor.issuer,
      actor.subject,
      canonicalJson(summary),
      now,
    );
}

/** The complete immutable matrix is created under the owner's existing write transaction. */
export function createEvaluationBatchInTransaction(
  database: DatabaseSync,
  input: CreateEvaluationBatchInput,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): C.EvaluationBatchSummaryV1 {
  if (!database.isTransaction)
    fail("PLATFORM_INVALID", "Evaluation creation requires an existing owner transaction.");
  // Validate JSON before inspecting or hashing request data.
  try {
    C.assertEvaluationBatchCreateRequest(input?.request);
  } catch (error) {
    fail(
      "PLATFORM_INVALID",
      error instanceof Error ? error.message : "The evaluation request is invalid.",
    );
  }
  if (
    !Value.Check(inputSchema, input) ||
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    fail("PLATFORM_INVALID", "The evaluation batch input or timestamp is invalid.");
  assertRepositoryPermission(
    database,
    input.actor,
    input.repositoryId,
    "configure",
    administrators,
  );
  const digest = sha256(
    canonicalJson({
      operation: "createEvaluationBatch",
      input: {
        repositoryId: input.repositoryId,
        actor: input.actor,
        request: input.request,
      },
    }),
  );
  const previous = replay(database, input, digest);
  if (previous) return previous;
  if (options.readOnly || input.replayOnly)
    fail(
      "DATABASE_READ_ONLY",
      "Recovery maintenance permits existing evaluation receipt replay only.",
    );
  const suite = readPublishedEvaluationSuiteInTransaction(
    database,
    {
      repositoryId: input.repositoryId,
      actor: input.actor,
      suiteId: input.request.suiteId,
      versionId: input.request.suiteVersionId,
    },
    administrators,
  );
  const sources = new Map<string, C.EvaluationSourceSnapshotV1>();
  const reproductionSources = new Map<string, C.EvaluationReproductionSourceDefinitionV1>();
  for (const entry of suite.sourceManifest.cases) {
    if (sources.has(entry.sourceId)) continue;
    const source = (
      handleEvaluationManagementRequest(
        database,
        {
          operation: "getEvaluationSource",
          input: { repositoryId: input.repositoryId, actor: input.actor, sourceId: entry.sourceId },
        },
        now,
        administrators,
      ) as C.EvaluationSourceDetailV1
    ).snapshot;
    assertEvaluationSourceSnapshotIntegrity(source);
    const reproduction = readEvaluationSourceReproductionInTransaction(database, {
      repositoryId: input.repositoryId,
      sourceId: entry.sourceId,
      source,
    });
    if (reproduction !== null) reproductionSources.set(entry.sourceId, reproduction);
    sources.set(entry.sourceId, source);
  }
  let plan: EvaluationBatchPlan;
  try {
    plan = createEvaluationBatchPlan({
      request: input.request,
      suite,
      sources,
      reproductionSources,
      actor: input.actor,
      now,
      baseline: resolveConfiguration(
        database,
        input,
        input.request.baseline,
        suite.version.workflowKind,
        now,
        administrators,
      ),
      candidate: resolveConfiguration(
        database,
        input,
        input.request.candidate,
        suite.version.workflowKind,
        now,
        administrators,
      ),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      fail("PLATFORM_INVALID", error.message);
    throw error;
  }
  const savepoint = `evaluation_batch_${randomUUID().replaceAll("-", "")}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    persist(database, plan, input, digest);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Evaluation batch rollback failed.", {
        cause: error,
      });
    }
    throw error;
  }
  return plan.summary;
}
