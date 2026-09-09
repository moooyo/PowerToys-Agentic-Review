import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import {
  assertEvaluationModelRuntimeRegistrationIntegrity,
  validateEvaluationIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import { readEvaluationReproductionCellInTransaction } from "./evaluation-reproduction.js";
import { assertEvaluationSourceSnapshotIntegrity } from "./evaluation-source.js";
import { readModelRuntimeRegistrationInTransaction } from "./model-runtime-registry.js";

export interface EvaluationExecutionCell {
  readonly runId: string;
  readonly repositoryId: string;
  readonly evaluationId: string;
  readonly cellId: string;
  readonly requestId: string;
  readonly applicable: boolean;
  readonly repositoryEnabled: boolean;
  readonly controlStatus: "active" | "cancelled";
  readonly controlVersion: number;
  readonly plan: C.ReviewRunExecutionPlanV2;
  readonly planDigest: string;
  readonly prompt: C.PromptEnvelope;
  readonly request: C.EvaluationReviewRunPlannedJob;
  readonly jobs: readonly { jobId: string; activationNumber: 1 }[];
  readonly reproductionRecord: C.EvaluationReproductionCellRecordV1 | null;
  readonly reproductionReadiness: {
    readonly state: "ready" | "blocked" | "not_applicable";
    readonly blockers: C.EvaluationReproductionCellRecordV1["blockers"];
  };
}

function corrupt(): never {
  throw Object.assign(new Error("The sealed evaluation execution binding is inconsistent."), {
    code: "PLATFORM_CORRUPT",
  });
}
function json(serialized: string | null): unknown {
  if (serialized === null) corrupt();
  try {
    return JSON.parse(serialized);
  } catch {
    corrupt();
  }
}
function canonical(serialized: string | null, digest?: string): unknown {
  const value = json(serialized);
  if (
    canonicalJson(value) !== serialized ||
    (digest !== undefined && sha256(serialized) !== digest)
  )
    corrupt();
  return value;
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

interface CellRow {
  run_id: string;
  repository_id: string;
  work_item_id: string;
  revision_id: string;
  revision_key: string;
  request_epoch_id: null;
  evaluation_id: string;
  cell_id: string;
  case_id: string;
  arm: C.EvaluationArm;
  request_id: string;
  activation_id: string;
  applicable: number;
  profile_version_id: string;
  prompt_version_id: string;
  plan_json: string | null;
  plan_digest: string;
  request_json: string | null;
  prompt_envelope_json: string | null;
  source_id: string;
  source_json: string | null;
  source_digest: string;
  authorization_id: string;
  authorization_json: string | null;
  authorization_digest: string;
  configuration_json: string | null;
  configuration_digest: string;
  cell_manifest_json: string | null;
  cell_manifest_digest: string;
  execution_manifest_json: string | null;
  execution_manifest_digest: string;
  source_manifest_digest: string;
  suite_version_id: string;
  workflow_kind: C.WorkflowKind;
  target: C.ValidationTarget;
  repository_enabled: number;
  github_repository_id: number;
  control_status: "active" | "cancelled";
  control_version: number;
  created_at: string;
  sealed_at: string;
}

/** Internal owner read: callers establish operator access or hold the dispatch/lease authority. */
export function readEvaluationExecutionCellInTransaction(
  database: DatabaseSync,
  input: { readonly repositoryId: string; readonly runId: string },
  now?: string,
): EvaluationExecutionCell | null {
  if (
    !database.isTransaction ||
    !Value.Check(C.EntityIdSchema, input.repositoryId) ||
    !Value.Check(C.EntityIdSchema, input.runId) ||
    (now !== undefined &&
      (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now))
  )
    corrupt();
  const row = database
    .prepare(`SELECT run.id AS run_id, run.repository_id, run.work_item_id, run.revision_id, run.revision_key,
    run.request_epoch_id, cell.evaluation_id, cell.id AS cell_id, cell.case_id, cell.arm, cell.request_id,
    cell.activation_id, cell.applicable, cell.profile_version_id, cell.prompt_version_id,
    CASE WHEN length(CAST(run.plan_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN run.plan_json END AS plan_json,
    run.plan_digest, CASE WHEN length(CAST(request.request_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN request.request_json END AS request_json,
    CASE WHEN length(CAST(request.prompt_envelope_json AS BLOB)) <= 8388608 THEN request.prompt_envelope_json END AS prompt_envelope_json,
    cell.source_id, CASE WHEN length(CAST(source.source_json AS BLOB)) <= ${C.maximumEvaluationSourceSnapshotUtf8Bytes} THEN source.source_json END AS source_json,
    cell.source_digest, cell.authorization_id,
    CASE WHEN length(CAST(authorization.authorization_json AS BLOB)) <= 16384 THEN authorization.authorization_json END AS authorization_json,
    authorization.authorization_digest,
    CASE WHEN length(CAST(evaluation.configuration_manifest_json AS BLOB)) <= 2097152 THEN evaluation.configuration_manifest_json END AS configuration_json,
    evaluation.configuration_manifest_sha256 AS configuration_digest,
    CASE WHEN length(CAST(evaluation.cell_manifest_json AS BLOB)) <= 262144 THEN evaluation.cell_manifest_json END AS cell_manifest_json,
    evaluation.cell_manifest_sha256 AS cell_manifest_digest,
    CASE WHEN length(CAST(evaluation.execution_manifest_json AS BLOB)) <= 16384 THEN evaluation.execution_manifest_json END AS execution_manifest_json,
    evaluation.execution_manifest_sha256 AS execution_manifest_digest,
    evaluation.source_manifest_sha256 AS source_manifest_digest, evaluation.suite_version_id, evaluation.workflow_kind, evaluation.target,
    repository.enabled AS repository_enabled, repository.github_repository_id,
    control.status AS control_status, control.version AS control_version, evaluation.created_at, seal.sealed_at
    FROM review_runs AS run JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id
    JOIN evaluation_authorizations AS authorization ON authorization.id = cell.authorization_id
      AND authorization.evaluation_id = evaluation.id AND authorization.repository_id = evaluation.repository_id
    JOIN evaluation_sources AS source ON source.id = cell.source_id AND source.repository_id = cell.repository_id
      AND source.source_digest = cell.source_digest
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = cell.request_id
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    WHERE run.id = ? AND run.repository_id = ? AND run.purpose = 'evaluation'`)
    .get(input.runId, input.repositoryId) as CellRow | undefined;
  if (!row) return null;
  const plan = canonical(row.plan_json, row.plan_digest);
  const prompt = canonical(row.prompt_envelope_json);
  const source = canonical(row.source_json);
  const authorization = canonical(row.authorization_json, row.authorization_digest);
  const configuration = canonical(row.configuration_json, row.configuration_digest);
  const cells = canonical(row.cell_manifest_json, row.cell_manifest_digest);
  const execution = canonical(row.execution_manifest_json, row.execution_manifest_digest);
  try {
    C.assertEvaluationReviewRunPlan(plan);
    validateEvaluationIssueReproductionBinding(plan);
    assertEvaluationModelRuntimeRegistrationIntegrity(
      plan.modelRequirements,
      plan.modelRuntimeRegistration,
    );
    assertEvaluationSourceSnapshotIntegrity(source);
    C.assertEvaluationExecutionAuthorization(authorization);
  } catch {
    corrupt();
  }
  if (
    !Value.Check(C.PromptEnvelopeSchema, prompt) ||
    !Value.Check(C.EvaluationConfigurationManifestV1Schema, configuration) ||
    !Value.Check(C.EvaluationCellManifestSchema, cells) ||
    !Value.Check(C.EvaluationExecutionManifestV1Schema, execution)
  )
    corrupt();
  if (plan.modelRuntimeRegistration !== undefined) {
    const registered = readModelRuntimeRegistrationInTransaction(
      database,
      plan.modelRuntimeRegistration.id,
      now === undefined ? {} : { now },
    );
    if (
      registered === null ||
      !same(registered.registration, plan.modelRuntimeRegistration) ||
      registered.registrationSha256 !==
        plan.modelRequirements.runtimeRegistration?.registrationSha256
    )
      corrupt();
  }
  const request = plan.jobs[0];
  const manifestEntries = cells.cells.filter((entry) => entry.cellId === row.cell_id);
  const entry = manifestEntries[0];
  if (
    !request ||
    !entry ||
    manifestEntries.length !== 1 ||
    row.request_epoch_id !== null ||
    row.repository_id !== input.repositoryId ||
    row.run_id !== input.runId ||
    row.github_repository_id !== plan.repository.githubRepositoryId ||
    row.source_digest !== source.sourceDigest ||
    !same(plan.source, source) ||
    !same(plan.authorization, authorization) ||
    plan.workItemId !== row.work_item_id ||
    plan.source.revisionId !== row.revision_id ||
    plan.revision.revisionKey !== row.revision_key ||
    plan.activationId !== row.activation_id ||
    request.requestId !== row.request_id ||
    request.profileVersion.id !== row.profile_version_id ||
    request.prompt.version.id !== row.prompt_version_id ||
    !same(request, canonical(row.request_json)) ||
    plan.purpose.cellId !== row.cell_id ||
    plan.purpose.caseId !== row.case_id ||
    plan.purpose.arm !== row.arm ||
    plan.purpose.evaluationId !== row.evaluation_id ||
    plan.purpose.sampleSetVersionId !== row.suite_version_id ||
    plan.purpose.authorizationId !== row.authorization_id ||
    plan.purpose.executionManifestSha256 !== row.execution_manifest_digest ||
    authorization.id !== row.authorization_id ||
    authorization.evaluationId !== row.evaluation_id ||
    authorization.repositoryId !== row.repository_id ||
    authorization.sampleSetVersionId !== row.suite_version_id ||
    authorization.sourceManifestSha256 !== row.source_manifest_digest ||
    authorization.configurationManifestSha256 !== row.configuration_digest ||
    authorization.cellManifestSha256 !== row.cell_manifest_digest ||
    authorization.executionManifestSha256 !== row.execution_manifest_digest ||
    configuration.repositoryId !== row.repository_id ||
    !same(configuration[row.arm], {
      profileVersion: request.profileVersion,
      prompt: request.prompt,
      modelRequirements: plan.modelRequirements,
      ...(plan.modelRuntimeRegistration === undefined
        ? {}
        : { modelRuntimeRegistration: plan.modelRuntimeRegistration }),
    }) ||
    cells.evaluationId !== row.evaluation_id ||
    cells.repositoryId !== row.repository_id ||
    !same(entry, {
      cellId: row.cell_id,
      caseId: row.case_id,
      arm: row.arm,
      trial: 1,
      sourceId: row.source_id,
      sourceDigest: row.source_digest,
      runId: row.run_id,
      requestId: row.request_id,
      activationId: row.activation_id,
      profileVersionId: row.profile_version_id,
      promptVersionId: row.prompt_version_id,
      renderedPromptDigest: prompt.promptSha256,
      outputSchemaDigest: prompt.outputSchemaSha256,
      modelRequirements: plan.modelRequirements,
      ...(cells.schemaVersion === "EvaluationCellManifestV2" && "reproduction" in entry
        ? { reproduction: entry.reproduction }
        : {}),
    }) ||
    !same(execution, {
      schemaVersion: "EvaluationExecutionManifestV1",
      evaluationId: row.evaluation_id,
      repositoryId: row.repository_id,
      sampleSetVersionId: row.suite_version_id,
      workflowKind: row.workflow_kind,
      target: row.target,
      sourceManifestSha256: row.source_manifest_digest,
      configurationManifestSha256: row.configuration_digest,
      cellManifestSha256: row.cell_manifest_digest,
      trial: 1,
      upstreamMutationPolicy: "forbidden",
    }) ||
    request.workflowKind !== row.workflow_kind ||
    request.target !== row.target ||
    prompt.promptSha256 !== sha256(prompt.renderedPrompt) ||
    prompt.outputSchemaSha256 !== sha256(canonicalJson(prompt.outputSchema)) ||
    prompt.name !== request.prompt.version.templateId ||
    prompt.version !== String(request.prompt.version.version) ||
    ![0, 1].includes(row.repository_enabled) ||
    ![0, 1].includes(row.applicable) ||
    (row.control_status === "active"
      ? row.control_version !== 1
      : row.control_status !== "cancelled" || row.control_version !== 2) ||
    (now !== undefined &&
      (Date.parse(row.created_at) > Date.parse(now) || Date.parse(row.sealed_at) > Date.parse(now)))
  )
    corrupt();
  const reproductionRecord = readEvaluationReproductionCellInTransaction(database, {
    repositoryId: row.repository_id,
    evaluationId: row.evaluation_id,
    cellId: row.cell_id,
    sourceId: row.source_id,
    applicable: row.applicable === 1,
    plan,
    manifest: cells,
  });
  const links = database
    .prepare(`SELECT job_id AS jobId, activation_number AS activationNumber
    FROM review_run_job_links WHERE review_run_id = ? AND request_id = ?`)
    .all(row.run_id, row.request_id) as { jobId: string; activationNumber: number }[];
  if (
    links.length > 1 ||
    links.some((link) => link.activationNumber !== 1 || !Value.Check(C.EntityIdSchema, link.jobId))
  )
    corrupt();
  return {
    runId: row.run_id,
    repositoryId: row.repository_id,
    evaluationId: row.evaluation_id,
    cellId: row.cell_id,
    requestId: row.request_id,
    applicable: row.applicable === 1,
    repositoryEnabled: row.repository_enabled === 1,
    controlStatus: row.control_status,
    controlVersion: row.control_version,
    plan,
    planDigest: row.plan_digest,
    prompt,
    request,
    jobs: links as { jobId: string; activationNumber: 1 }[],
    reproductionRecord,
    reproductionReadiness: {
      state: reproductionRecord?.state ?? "not_applicable",
      blockers: reproductionRecord?.blockers ?? [],
    },
  };
}

/** Verifies the exact immutable Job link and complete execution slice before admission or claim. */
export function readEvaluationJobBindingInTransaction(
  database: DatabaseSync,
  jobId: string,
  template: C.JobExecutionTemplateV2,
  now?: string,
): EvaluationExecutionCell {
  if (template.validation.schemaVersion !== "ValidationJobContextV2") corrupt();
  const cell = readEvaluationExecutionCellInTransaction(
    database,
    {
      repositoryId: template.validation.repositoryId,
      runId: template.validation.runId,
    },
    now,
  );
  if (
    !cell?.jobs.some((link) => link.jobId === jobId && link.activationNumber === 1) ||
    !same(
      template,
      createEvaluationExecutionTemplate({
        runId: cell.runId,
        plan: cell.plan,
        planDigest: cell.planDigest,
        frozenPrompt: cell.prompt,
      }),
    )
  )
    corrupt();
  return cell;
}
