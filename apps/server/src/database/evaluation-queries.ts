import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createEvaluationBatchInTransaction } from "./evaluation-batches.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { assertRepositoryPermission, isPlatformAdministrator } from "./operator-access.js";
import {
  handlePromptConfigurationRequest,
  type ResolvedWorkflowPrompt,
} from "./prompt-configuration.js";

interface Scope {
  readonly repositoryId: string;
  readonly actor: C.OperatorPrincipal;
}
interface BatchScope extends Scope {
  readonly evaluationId: string;
}
interface MutationRestriction {
  /** Trusted transport restriction, never a public request field. */
  readonly replayOnly?: true;
}
export interface EvaluationBatchOperationMap {
  createEvaluationBatch: {
    input: Scope & MutationRestriction & { readonly request: C.EvaluationBatchCreateRequest };
    output: C.EvaluationBatchSummaryV1;
  };
  cancelEvaluationBatch: {
    input: BatchScope & MutationRestriction & { readonly request: C.EvaluationBatchCancelRequest };
    output: C.EvaluationBatchCancellationV1;
  };
  listEvaluationBatches: {
    input: Scope & { readonly query: C.EvaluationBatchListQuery };
    output: C.EvaluationBatchListV1;
  };
  getEvaluationBatch: { input: BatchScope; output: C.EvaluationBatchDetailV1 };
  getEvaluationBatchMatrix: { input: BatchScope; output: C.EvaluationBatchMatrixV1 };
  listEvaluationPromptOptions: {
    input: Scope & { readonly query: C.EvaluationPromptOptionsQuery };
    output: C.EvaluationPromptOptionsV1;
  };
}
export type EvaluationBatchOperation = keyof EvaluationBatchOperationMap;
export type EvaluationBatchRequest = {
  [K in EvaluationBatchOperation]: {
    readonly operation: K;
    readonly input: EvaluationBatchOperationMap[K]["input"];
  };
}[EvaluationBatchOperation];

const strict = { additionalProperties: false } as const;
const scope = { repositoryId: C.EntityIdSchema, actor: C.OperatorPrincipalSchema };
const batchScope = { ...scope, evaluationId: C.EntityIdSchema };
const schemas = {
  createEvaluationBatch: Type.Object(
    {
      ...scope,
      replayOnly: Type.Optional(Type.Literal(true)),
      request: C.EvaluationBatchCreateRequestSchema,
    },
    strict,
  ),
  cancelEvaluationBatch: Type.Object(
    {
      ...batchScope,
      replayOnly: Type.Optional(Type.Literal(true)),
      request: C.EvaluationBatchCancelRequestSchema,
    },
    strict,
  ),
  listEvaluationBatches: Type.Object({ ...scope, query: C.EvaluationBatchListQuerySchema }, strict),
  getEvaluationBatch: Type.Object(batchScope, strict),
  getEvaluationBatchMatrix: Type.Object(batchScope, strict),
  listEvaluationPromptOptions: Type.Object(
    { ...scope, query: C.EvaluationPromptOptionsQuerySchema },
    strict,
  ),
};
export function isEvaluationBatchOperation(
  operation: string,
): operation is EvaluationBatchOperation {
  return Object.hasOwn(schemas, operation);
}
function invalid(message = "The evaluation batch request is invalid."): never {
  throw new EvaluationManagementError("PLATFORM_INVALID", message);
}
function corrupt(message = "The stored evaluation batch projection is inconsistent."): never {
  throw new EvaluationManagementError("PLATFORM_CORRUPT", message);
}
function missing(): never {
  throw new EvaluationManagementError(
    "PLATFORM_NOT_FOUND",
    "The evaluation batch was not found in this repository.",
  );
}
function stored<T>(value: T, issues: (value: unknown) => readonly string[]): T {
  if (issues(value).length) corrupt();
  return value;
}
function parse(value: string, maximum = C.maximumEvaluationReadUtf8Bytes): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) corrupt();
  try {
    return JSON.parse(value);
  } catch {
    corrupt();
  }
}
function validateRequest(request: EvaluationBatchRequest, now: string): void {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !isEvaluationBatchOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input) ||
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid();
  let issues: string[] = [];
  switch (request.operation) {
    case "createEvaluationBatch":
      issues = C.getEvaluationBatchCreateRequestIssues(request.input.request);
      break;
    case "cancelEvaluationBatch":
      issues = C.getEvaluationBatchCancelRequestIssues(request.input.request);
      break;
    case "listEvaluationBatches":
      issues = C.getEvaluationBatchListQueryIssues(request.input.query);
      break;
    case "listEvaluationPromptOptions":
      issues = C.getEvaluationPromptOptionsQueryIssues(request.input.query);
      break;
  }
  if (issues.length) invalid(issues[0]);
  if (
    Buffer.byteLength(JSON.stringify(request.input), "utf8") >
    C.maximumEvaluationBatchRequestUtf8Bytes + 8192
  )
    invalid();
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction;
  const name = `evaluation_query_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${name}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = action();
    database.exec(nested ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      if (database.isTransaction) {
        if (nested) {
          database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          database.exec(`RELEASE SAVEPOINT ${name}`);
        } else database.exec("ROLLBACK");
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Evaluation batch transaction rollback failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

interface Header {
  summary: C.EvaluationBatchSummaryV1;
  suiteVersion: C.EvaluationSuiteVersionV1;
  control: C.EvaluationBatchDetailV1["control"];
  configurations: C.EvaluationBatchDetailV1["configurations"];
  repositoryEnabled: boolean;
}
const frozenConfigurationSummarySchema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationConfigurationManifestV1"),
    repositoryId: C.EntityIdSchema,
    mode: C.EvaluationBatchModeSchema,
    ...Object.fromEntries(
      ["baseline", "candidate"].map((arm) => [
        arm,
        Type.Object(
          {
            profileVersion: C.ValidationProfileVersionSummarySchema,
            prompt: Type.Object(
              { workflowKind: C.WorkflowKindSchema, version: C.PromptVersionSummarySchema },
              strict,
            ),
            modelRequirements: C.EvaluationModelRequirementsV1Schema,
          },
          strict,
        ),
      ]),
    ),
  },
  strict,
);
type FrozenConfigurationSummary = {
  schemaVersion: "EvaluationConfigurationManifestV1";
  repositoryId: string;
  mode: C.EvaluationBatchMode;
  baseline: {
    profileVersion: C.ValidationProfileVersionSummary;
    prompt: { workflowKind: C.WorkflowKind; version: C.PromptVersionSummary };
    modelRequirements: C.EvaluationModelRequirementsV1;
  };
  candidate: {
    profileVersion: C.ValidationProfileVersionSummary;
    prompt: { workflowKind: C.WorkflowKind; version: C.PromptVersionSummary };
    modelRequirements: C.EvaluationModelRequirementsV1;
  };
};

// These are immutable summary projections, not execution/evidence integrity attestations.
// SQL removes prompt/config bodies before they cross into the synchronous database owner.
function readHeader(database: DatabaseSync, repositoryId: string, evaluationId: string): Header {
  const row = database
    .prepare(`SELECT evaluation.id, evaluation.repository_id AS repositoryId,
    evaluation.suite_version_id AS suiteVersionId, version.suite_id AS suiteId,
    evaluation.workflow_kind AS workflowKind, evaluation.target, evaluation.case_count AS caseCount,
    evaluation.cell_count AS cellCount, evaluation.created_at AS createdAt,
    evaluation.actor_issuer AS issuer, evaluation.actor_subject AS subject,
    repository.enabled AS repositoryEnabled,
    json_remove(evaluation.configuration_manifest_json,
      '$.baseline.profileVersion.config', '$.candidate.profileVersion.config',
      '$.baseline.prompt.version.content', '$.candidate.prompt.version.content') AS configurationJson,
    json_object('schemaVersion', 'EvaluationSuiteVersionV1', 'id', version.id,
      'repositoryId', version.repository_id, 'suiteId', version.suite_id, 'version', version.version,
      'sourceDraftRevision', version.source_draft_revision, 'name', version.name, 'description', version.description,
      'workflowKind', version.workflow_kind, 'target', version.target, 'sourceVersionId', version.source_version_id,
      'expectationVersionId', version.expectation_version_id, 'sourceManifestSha256', version.source_manifest_sha256,
      'expectationManifestSha256', version.expectation_manifest_sha256, 'caseCount', version.case_count,
      'createdAt', version.created_at, 'createdBy', json_object('issuer', version.actor_issuer, 'subject', version.actor_subject)) AS versionJson,
    json_object('status', control.status, 'version', control.version, 'reason', control.reason,
      'updatedAt', control.updated_at, 'updatedBy', json_object('issuer', control.actor_issuer, 'subject', control.actor_subject)) AS controlJson
    FROM evaluations AS evaluation
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id
    JOIN evaluation_suite_versions AS version ON version.id = evaluation.suite_version_id AND version.repository_id = evaluation.repository_id
    JOIN managed_repositories AS repository ON repository.id = evaluation.repository_id
    WHERE evaluation.repository_id = ? AND evaluation.id = ?`)
    .get(repositoryId, evaluationId) as
    | {
        id: string;
        repositoryId: string;
        suiteId: string;
        suiteVersionId: string;
        workflowKind: C.WorkflowKind;
        target: C.ValidationTarget;
        caseCount: number;
        cellCount: number;
        createdAt: string;
        issuer: string;
        subject: string;
        repositoryEnabled: number;
        configurationJson: string;
        versionJson: string;
        controlJson: string;
      }
    | undefined;
  if (!row) missing();
  const rawConfiguration = parse(row.configurationJson, 131_072);
  if (!Value.Check(frozenConfigurationSummarySchema, rawConfiguration)) corrupt();
  const configuration = rawConfiguration as FrozenConfigurationSummary;
  if (
    configuration.repositoryId !== repositoryId ||
    configuration.baseline.prompt.workflowKind !== row.workflowKind ||
    configuration.candidate.prompt.workflowKind !== row.workflowKind ||
    ![0, 1].includes(row.repositoryEnabled)
  )
    corrupt();
  const summary: C.EvaluationBatchSummaryV1 = {
    schemaVersion: "EvaluationBatchSummaryV1",
    id: row.id,
    repositoryId: row.repositoryId,
    suiteId: row.suiteId,
    suiteVersionId: row.suiteVersionId,
    workflowKind: row.workflowKind,
    target: row.target,
    caseCount: row.caseCount,
    cellCount: row.cellCount,
    createdAt: row.createdAt,
    createdBy: { issuer: row.issuer, subject: row.subject },
    mode: configuration.mode,
    baseline: {
      profileVersionId: configuration.baseline.profileVersion.id,
      promptVersionId: configuration.baseline.prompt.version.id,
    },
    candidate: {
      profileVersionId: configuration.candidate.profileVersion.id,
      promptVersionId: configuration.candidate.prompt.version.id,
    },
  };
  stored(summary, C.getEvaluationBatchSummaryIssues);
  const suiteVersion = parse(row.versionJson) as C.EvaluationSuiteVersionV1;
  stored(suiteVersion, C.getEvaluationSuiteVersionIssues);
  const control = parse(row.controlJson) as Header["control"];
  if (!Value.Check(C.EvaluationBatchDetailV1Schema.properties.control, control)) corrupt();
  return {
    summary,
    suiteVersion,
    control,
    repositoryEnabled: row.repositoryEnabled === 1,
    configurations: {
      baseline: {
        profile: configuration.baseline.profileVersion,
        prompt: configuration.baseline.prompt.version,
        modelRequirements: configuration.baseline.modelRequirements,
      },
      candidate: {
        profile: configuration.candidate.profileVersion,
        prompt: configuration.candidate.prompt.version,
        modelRequirements: configuration.candidate.modelRequirements,
      },
    },
  };
}

const cellRowSchema = Type.Object(
  {
    ...Type.Omit(C.EvaluationCellSummaryV1Schema, ["state", "job", "result", "blockers"])
      .properties,
    applicable: Type.Union([Type.Literal(0), Type.Literal(1)]),
    modelRequired: Type.Union([Type.Literal(0), Type.Literal(1)]),
    reproductionState: Type.Union([
      Type.Null(),
      Type.Literal("ready"),
      Type.Literal("blocked"),
      Type.Literal("not_applicable"),
    ]),
    blockersJson: Type.String({ maxLength: 65_536 }),
    jobJson: Type.String({ maxLength: 8192 }),
    resultJson: Type.String({ maxLength: 8192 }),
  },
  strict,
);
type CellRow = Static<typeof cellRowSchema>;
interface CellProjection {
  cell: C.EvaluationCellSummaryV1;
  applicable: boolean;
}

function cellState(
  header: Header,
  row: CellRow,
  job: C.EvaluationCellSummaryV1["job"],
  blockerCount: number,
): C.EvaluationCellSummaryV1["state"] {
  if (!row.applicable) return "not_run";
  if (!job) {
    if (header.control.status === "cancelled") return "cancelled";
    if (!header.repositoryEnabled || blockerCount > 0) return "blocked";
    return "not_run";
  }
  switch (job.status) {
    case "queued":
    case "retry_waiting":
      return job.admission?.state === "admitted" ? "queued" : "awaiting_admission";
    case "leased":
    case "running":
    case "cancel_requested":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
    case "dead_letter":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "invalid";
  }
}

function readCells(database: DatabaseSync, header: Header): CellProjection[] {
  const rows = database
    .prepare(`WITH raw AS (
    SELECT cell.id AS cellId, cell.case_id AS caseId, cell.arm, cell.trial,
      cell.run_id AS runId, cell.request_id AS requestId, cell.source_id AS sourceId,
      cell.source_digest AS sourceDigest, cell.profile_version_id AS profileVersionId,
      cell.prompt_version_id AS promptVersionId, cell.applicable,
      json_extract(manifest.value, '$.modelRequirements.required') AS modelRequired,
      json_extract(manifest.value, '$.reproduction.state') AS reproductionState,
      checked.checked_at AS checkedAt,
      CASE WHEN checked.checked_at IS NULL THEN json_extract(run.readiness_json, '$[0].reasons')
        ELSE checked.blockers_json END AS blockers,
      CASE WHEN job.id IS NULL THEN 'null' ELSE json_object('jobId', job.id, 'status', job.status,
        'attemptCount', job.attempt_count, 'createdAt', job.created_at, 'startedAt', job.started_at,
        'completedAt', job.completed_at, 'failureCode', job.failure_code,
        'admission', CASE WHEN job.status IN ('queued', 'retry_waiting') AND admission.job_id IS NOT NULL
          THEN json_object('state', admission.state, 'attemptBase', admission.attempt_base,
            'requestedAt', admission.requested_at, 'timestampBasis', admission.timestamp_basis,
            'admittedAt', admission.admitted_at) ELSE NULL END) END AS jobJson,
      CASE WHEN result.id IS NULL THEN 'null' ELSE json_object('resultId', result.id,
        'runAttemptId', result.run_attempt_id, 'resultDigest', result.result_digest, 'createdAt', result.created_at) END AS resultJson
    FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id
    JOIN json_each(evaluation.cell_manifest_json, '$.cells') AS manifest ON json_extract(manifest.value, '$.cellId') = cell.id
    JOIN review_runs AS run ON run.id = cell.run_id AND run.repository_id = cell.repository_id
      AND run.purpose = 'evaluation' AND run.evaluation_cell_id = cell.id
    JOIN review_run_requests AS request ON request.review_run_id = cell.run_id AND request.request_id = cell.request_id
    JOIN validation_dispatch_checks AS checked ON checked.review_run_id = cell.run_id AND checked.request_id = cell.request_id
    LEFT JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id AND link.request_id = cell.request_id
    LEFT JOIN jobs AS job ON job.id = link.job_id
    LEFT JOIN job_admission AS admission ON admission.job_id = job.id
    LEFT JOIN validation_job_results AS result ON result.job_id = job.id AND result.repository_id = cell.repository_id
      AND result.review_run_id = cell.run_id AND result.request_id = cell.request_id
    WHERE cell.repository_id = ? AND cell.evaluation_id = ?
  ) SELECT cellId, caseId, arm, trial, runId, requestId, sourceId, sourceDigest,
    profileVersionId, promptVersionId, applicable, modelRequired, reproductionState, jobJson, resultJson,
    (SELECT COUNT(*) FROM json_each(raw.blockers) WHERE raw.checkedAt IS NOT NULL OR json_extract(value, '$.code') <> 'unsupported_target') AS blockerCount,
    (SELECT json_group_array(json(value)) FROM (
      SELECT value FROM json_each(raw.blockers)
      WHERE raw.checkedAt IS NOT NULL OR json_extract(value, '$.code') <> 'unsupported_target'
      ORDER BY key LIMIT 16
    )) AS blockersJson
    FROM raw ORDER BY caseId, arm LIMIT 65`)
    .all(header.summary.repositoryId, header.summary.id) as unknown[];
  if (rows.length !== header.summary.cellCount) corrupt();
  const ids = new Set<string>(),
    runs = new Set<string>(),
    requests = new Set<string>();
  return rows.map((value) => {
    if (!Value.Check(cellRowSchema, value)) corrupt();
    const row = value;
    if (
      ids.has(row.cellId) ||
      runs.has(row.runId) ||
      requests.has(row.requestId) ||
      row.profileVersionId !== header.summary[row.arm].profileVersionId ||
      row.promptVersionId !== header.summary[row.arm].promptVersionId ||
      Boolean(row.modelRequired) !== header.configurations[row.arm].modelRequirements.required
    )
      corrupt();
    ids.add(row.cellId);
    runs.add(row.runId);
    requests.add(row.requestId);
    const job = parse(row.jobJson, 8192) as C.EvaluationCellSummaryV1["job"];
    const result = parse(row.resultJson, 8192) as C.EvaluationCellSummaryV1["result"];
    let blockers = parse(row.blockersJson, 65_536) as C.EvaluationCellSummaryV1["blockers"];
    let blockerCount = row.blockerCount;
    if (row.reproductionState === "blocked") {
      if (job !== null || result !== null) corrupt();
      if (!blockers.some((blocker) => blocker.code === "reproduction_mapping_blocked")) {
        const mappingBlocker: C.EvaluationCellSummaryV1["blockers"][number] = {
          code: "reproduction_mapping_blocked",
        };
        blockers = [mappingBlocker, ...blockers].slice(0, 16);
        blockerCount += 1;
      }
    }
    if (row.applicable && !job && !header.repositoryEnabled && header.control.status === "active") {
      blockers = [{ code: "authorization_changed" }];
      blockerCount = 1;
    }
    const cell: C.EvaluationCellSummaryV1 = {
      cellId: row.cellId,
      caseId: row.caseId,
      arm: row.arm,
      trial: row.trial,
      runId: row.runId,
      requestId: row.requestId,
      sourceId: row.sourceId,
      sourceDigest: row.sourceDigest,
      profileVersionId: row.profileVersionId,
      promptVersionId: row.promptVersionId,
      state: cellState(header, row, job, blockerCount),
      job,
      result,
      blockerCount,
      blockers,
    };
    if (
      !Value.Check(C.EvaluationCellSummaryV1Schema, cell) ||
      (job !== null && C.getJobAdmissionIssues(job).length > 0) ||
      cell.blockers.length !== Math.min(16, cell.blockerCount) ||
      (cell.state === "completed" && (!result || job?.status !== "succeeded")) ||
      (result !== null && cell.state !== "completed") ||
      (!row.applicable && (job !== null || result !== null))
    )
      corrupt();
    return { cell, applicable: row.applicable === 1 };
  });
}
function progress(cells: readonly CellProjection[]): C.EvaluationBatchProgress {
  const result: C.EvaluationBatchProgress = {
    totalCells: cells.length,
    applicableCells: 0,
    notApplicableCells: 0,
    not_run: 0,
    awaiting_admission: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    invalid: 0,
  };
  for (const { cell, applicable } of cells) {
    if (applicable) {
      result.applicableCells += 1;
      result[cell.state] += 1;
    } else result.notApplicableCells += 1;
  }
  return stored(result, C.getEvaluationBatchProgressIssues);
}

/** Internal metadata selection; callers establish authority and retain the surrounding transaction. */
export function readEvaluationBatchScoringProjectionInTransaction(
  database: DatabaseSync,
  scope: { readonly repositoryId: string; readonly evaluationId: string },
): {
  readonly summary: C.EvaluationBatchSummaryV1;
  readonly suiteVersion: C.EvaluationSuiteVersionV1;
  readonly control: C.EvaluationBatchDetailV1["control"];
  readonly configurations: C.EvaluationBatchDetailV1["configurations"];
  readonly repositoryEnabled: boolean;
  readonly cells: readonly C.EvaluationCellSummaryV1[];
} {
  if (!database.isTransaction) corrupt();
  const header = readHeader(database, scope.repositoryId, scope.evaluationId);
  const cells = readCells(database, header);
  // Reuse the public detail's consistency checks without treating its metadata as file evidence.
  detail(header, cells);
  return {
    ...header,
    cells: cells.map((entry) => entry.cell),
  };
}
function listItem(header: Header, cells: readonly CellProjection[]): C.EvaluationBatchListItemV1 {
  const totals = progress(cells);
  return {
    summary: header.summary,
    suiteName: header.suiteVersion.name,
    controlStatus: header.control.status,
    controlVersion: header.control.version,
    status: C.getEvaluationBatchStatus(totals, header.control.status === "cancelled"),
    progress: totals,
  };
}
function detail(header: Header, cells: readonly CellProjection[]): C.EvaluationBatchDetailV1 {
  return stored(
    {
      schemaVersion: "EvaluationBatchDetailV1",
      ...listItem(header, cells),
      suiteVersion: header.suiteVersion,
      control: header.control,
      configurations: header.configurations,
    },
    C.getEvaluationBatchDetailIssues,
  );
}
function matrix(
  database: DatabaseSync,
  header: Header,
  cells: readonly CellProjection[],
): C.EvaluationBatchMatrixV1 {
  const rows = database
    .prepare(`SELECT json_extract(entry.value, '$.caseId') AS caseId,
    json_extract(entry.value, '$.title') AS title, json_extract(entry.value, '$.applicability') AS applicability
    FROM evaluation_expectation_versions AS version, json_each(version.manifest_json, '$.cases') AS entry
    WHERE version.id = ? AND version.repository_id = ? ORDER BY entry.key LIMIT 33`)
    .all(header.suiteVersion.expectationVersionId, header.summary.repositoryId) as {
    caseId: string;
    title: string;
    applicability: string;
  }[];
  if (rows.length !== header.summary.caseCount) corrupt();
  const sourceCache = new Map<string, C.EvaluationSourceSummaryV1>();
  const cases: C.EvaluationBatchMatrixV1["cases"] = rows.map((row) => {
    const baseline = cells.find(
      ({ cell }) => cell.caseId === row.caseId && cell.arm === "baseline",
    );
    const candidate = cells.find(
      ({ cell }) => cell.caseId === row.caseId && cell.arm === "candidate",
    );
    if (!baseline || !candidate || baseline.applicable !== candidate.applicable) corrupt();
    let source = sourceCache.get(baseline.cell.sourceId);
    if (!source) {
      const value = database
        .prepare(`SELECT json_object('schemaVersion', 'EvaluationSourceSummaryV1',
        'id', id, 'repositoryId', repository_id, 'workItemId', work_item_id, 'revisionId', revision_id,
        'revisionKey', revision_key, 'sourceDigest', source_digest,
        'workItemKind', json_extract(source_json, '$.workItem.kind'), 'number', json_extract(source_json, '$.workItem.number'),
        'title', json_extract(source_json, '$.workItem.title'), 'createdAt', created_at,
        'createdBy', json_object('issuer', actor_issuer, 'subject', actor_subject)) AS summary
        FROM evaluation_sources WHERE repository_id = ? AND id = ?`)
        .get(header.summary.repositoryId, baseline.cell.sourceId) as
        | { summary: string }
        | undefined;
      if (!value) corrupt();
      source = stored(
        parse(value.summary) as C.EvaluationSourceSummaryV1,
        C.getEvaluationSourceSummaryIssues,
      );
      sourceCache.set(source.id, source);
    }
    const applicability = parse(
      row.applicability,
      16_384,
    ) as C.EvaluationBatchMatrixV1["cases"][number]["applicability"];
    if ((applicability.state === "applicable") !== baseline.applicable) corrupt();
    return {
      caseId: row.caseId,
      title: row.title,
      applicability,
      source,
      baseline: baseline.cell,
      candidate: candidate.cell,
    };
  });
  const item = listItem(header, cells);
  return stored(
    {
      schemaVersion: "EvaluationBatchMatrixV1",
      repositoryId: header.summary.repositoryId,
      evaluationId: header.summary.id,
      suiteVersionId: header.summary.suiteVersionId,
      status: item.status,
      progress: item.progress,
      cases,
    },
    C.getEvaluationBatchMatrixIssues,
  );
}
function listBatches(
  database: DatabaseSync,
  input: EvaluationBatchOperationMap["listEvaluationBatches"]["input"],
): C.EvaluationBatchListV1 {
  const { query } = input,
    page = query.page ?? 1,
    pageSize = query.pageSize ?? 20;
  const predicates = ["evaluation.repository_id = ?"],
    values: SQLInputValue[] = [input.repositoryId];
  if (query.suiteId !== undefined) {
    predicates.push("version.suite_id = ?");
    values.push(query.suiteId);
  }
  if (query.workflowKind !== undefined) {
    predicates.push("evaluation.workflow_kind = ?");
    values.push(query.workflowKind);
  }
  const from = `FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_suite_versions AS version ON version.id = evaluation.suite_version_id AND version.repository_id = evaluation.repository_id
    WHERE ${predicates.join(" AND ")}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total ${from}`).get(...values) as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT evaluation.id ${from} ORDER BY evaluation.created_at DESC, evaluation.id LIMIT ? OFFSET ?`,
    )
    .all(...values, pageSize, (page - 1) * pageSize) as { id: string }[];
  const items = rows.map(({ id }) => {
    const header = readHeader(database, input.repositoryId, id);
    const value = detail(header, readCells(database, header));
    const {
      schemaVersion: _schema,
      suiteVersion: _suite,
      control: _control,
      configurations: _configurations,
      ...item
    } = value;
    return item;
  });
  return stored(
    {
      schemaVersion: "EvaluationBatchListV1",
      repositoryId: input.repositoryId,
      page,
      pageSize,
      total,
      items,
    },
    C.getEvaluationBatchListIssues,
  );
}
function promptOptions(
  database: DatabaseSync,
  input: EvaluationBatchOperationMap["listEvaluationPromptOptions"]["input"],
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationPromptOptionsV1 {
  const { query } = input,
    page = query.page ?? 1,
    pageSize = query.pageSize ?? 20;
  const admin = isPlatformAdministrator(input.actor, administrators);
  const binding = handlePromptConfigurationRequest(
    database,
    {
      operation: "resolveWorkflowPrompt",
      input: { repositoryId: input.repositoryId, workflowKind: query.workflowKind },
    },
    now,
  ) as ResolvedWorkflowPrompt | null;
  const bindingId = binding?.version.id ?? null;
  const visible = admin
    ? ""
    : `AND (version.id = ? OR EXISTS (
    SELECT 1 FROM review_run_requests AS request JOIN review_runs AS run ON run.id = request.review_run_id
    WHERE run.repository_id = ? AND request.workflow_kind = ? AND request.prompt_version_id = version.id))`;
  const values: SQLInputValue[] = [query.workflowKind];
  if (!admin) values.push(bindingId, input.repositoryId, query.workflowKind);
  const from = `FROM prompt_versions AS version JOIN prompt_templates AS template ON template.id = version.template_id
    WHERE template.workflow_kind = ? ${visible}`;
  const total = (
    database.prepare(`SELECT COUNT(*) AS total ${from}`).get(...values) as { total: number }
  ).total;
  const items = database
    .prepare(`SELECT version.id, version.template_id AS templateId, version.version,
    version.content_sha256 AS contentSha256, version.output_schema_version AS outputSchemaVersion,
    version.created_at AS createdAt, version.published_at AS publishedAt, version.created_by AS createdBy,
    template.name AS templateName ${from} ORDER BY version.published_at DESC, version.id LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize)
    .map((row) => ({
      ...row,
      visibility: admin ? "platform" : row.id === bindingId ? "binding" : "frozen_run",
    })) as C.EvaluationPromptOptionV1[];
  return stored(
    {
      schemaVersion: "EvaluationPromptOptionsV1",
      repositoryId: input.repositoryId,
      workflowKind: query.workflowKind,
      page,
      pageSize,
      total,
      items,
    },
    C.getEvaluationPromptOptionsIssues,
  );
}

/** Reauthorization, exact mutation replay and bounded reads share the owner's transaction. */
export function handleEvaluationBatchRequest(
  database: DatabaseSync,
  request: EvaluationBatchRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): EvaluationBatchOperationMap[EvaluationBatchOperation]["output"] {
  validateRequest(request, now);
  const mutation =
    request.operation === "createEvaluationBatch" || request.operation === "cancelEvaluationBatch";
  const readOnly =
    options.readOnly === true ||
    ("replayOnly" in request.input && request.input.replayOnly === true);
  return transaction(database, mutation && !readOnly, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      mutation || request.operation === "listEvaluationPromptOptions" ? "configure" : "read",
      administrators,
    );
    switch (request.operation) {
      case "createEvaluationBatch":
        return stored(
          createEvaluationBatchInTransaction(database, request.input, now, administrators, {
            readOnly,
          }),
          C.getEvaluationBatchSummaryIssues,
        );
      case "cancelEvaluationBatch":
        return stored(
          cancelEvaluationBatchInTransaction(database, request.input, now, administrators, {
            readOnly,
          }),
          C.getEvaluationBatchCancellationIssues,
        );
      case "listEvaluationBatches":
        return listBatches(database, request.input);
      case "listEvaluationPromptOptions":
        return promptOptions(database, request.input, now, administrators);
      case "getEvaluationBatch": {
        const header = readHeader(database, request.input.repositoryId, request.input.evaluationId);
        return detail(header, readCells(database, header));
      }
      case "getEvaluationBatchMatrix": {
        const header = readHeader(database, request.input.repositoryId, request.input.evaluationId);
        const cells = readCells(database, header);
        detail(header, cells);
        return matrix(database, header, cells);
      }
    }
  });
}
