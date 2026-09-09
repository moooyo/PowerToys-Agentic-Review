import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import {
  createEvaluationReproductionCellRecord,
  createEvaluationReproductionSourceDefinition,
  evaluationReproductionCellRecordDigest,
  evaluationReproductionManifestDigest,
  evaluationReproductionSourceDefinitionDigest,
} from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import { assertEvaluationSourceSnapshotIntegrity } from "./evaluation-source.js";
import { assertRepositoryPermission } from "./operator-access.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";

const documentMaximum = 2 * 1024 * 1024 + 32 * 1024;
const manifestMaximum = 256 * 1024;
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The frozen evaluation reproduction records are inconsistent.",
  );
}
function missing(): never {
  throw new EvaluationManagementError(
    "PLATFORM_NOT_FOUND",
    "The evaluation reproduction scope was not found.",
  );
}
function invalid(): never {
  throw new EvaluationManagementError(
    "PLATFORM_INVALID",
    "The evaluation reproduction request is invalid.",
  );
}
function parse(serialized: string | null, maximum: number, digest?: string): unknown {
  if (serialized === null || Buffer.byteLength(serialized, "utf8") > maximum) corrupt();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    corrupt();
  }
  if (
    canonicalJson(value) !== serialized ||
    (digest !== undefined && sha256(serialized) !== digest)
  )
    corrupt();
  return value;
}

function readSource(
  database: DatabaseSync,
  repositoryId: string,
  sourceId: string,
): C.EvaluationSourceSnapshotV1 {
  if (!database.isTransaction) corrupt();
  const row = database
    .prepare(`SELECT source_digest AS digest,
    CASE WHEN length(CAST(source_json AS BLOB)) <= ${C.maximumEvaluationSourceSnapshotUtf8Bytes} THEN source_json END AS json
    FROM evaluation_sources WHERE repository_id = ? AND id = ?`)
    .get(repositoryId, sourceId) as { digest: string; json: string | null } | undefined;
  if (!row) missing();
  const source = parse(row.json, C.maximumEvaluationSourceSnapshotUtf8Bytes);
  assertEvaluationSourceSnapshotIntegrity(source);
  if (source.repository.id !== repositoryId || source.sourceDigest !== row.digest) corrupt();
  return source;
}

/** The caller holds current repository authority or an exact internal execution binding. */
export function readEvaluationSourceReproductionInTransaction(
  database: DatabaseSync,
  input: {
    readonly repositoryId: string;
    readonly sourceId: string;
    readonly source?: C.EvaluationSourceSnapshotV1;
  },
): C.EvaluationReproductionSourceDefinitionV1 | null {
  const source = readSource(database, input.repositoryId, input.sourceId);
  if (input.source !== undefined && !same(input.source, source)) corrupt();
  if (source.provenance.kind !== "review_run") return null;
  const row = database
    .prepare(`SELECT plan_digest AS digest, work_item_id AS workItemId, revision_id AS revisionId,
    revision_key AS revisionKey, activation_id AS activationId, request_epoch_id AS requestEpochId,
    CASE WHEN length(CAST(plan_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN plan_json END AS json
    FROM review_runs WHERE repository_id = ? AND id = ?`)
    .get(input.repositoryId, source.provenance.reviewRunId) as
    | {
        digest: string;
        workItemId: string;
        revisionId: string;
        revisionKey: string;
        activationId: string;
        requestEpochId: string | null;
        json: string | null;
      }
    | undefined;
  if (
    !row ||
    row.digest !== source.provenance.planDigest ||
    row.workItemId !== source.workItemId ||
    row.revisionId !== source.revisionId ||
    row.revisionKey !== source.revision.revisionKey ||
    row.requestEpochId !== source.provenance.requestEpochId
  )
    corrupt();
  const parsed = parse(row.json, C.maximumReviewRunPlanUtf8Bytes, row.digest);
  let plan: C.ReviewRunExecutionPlanV1 | C.ReviewRunExecutionPlanV2;
  try {
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "schemaVersion" in parsed &&
      parsed.schemaVersion === "ReviewRunExecutionPlanV2"
    ) {
      C.assertEvaluationReviewRunPlan(parsed);
      plan = parsed;
    } else {
      C.assertReviewRunExecutionPlan(parsed);
      plan = parsed;
    }
    if (plan.activationId !== row.activationId) corrupt();
    return createEvaluationReproductionSourceDefinition({
      repositoryId: input.repositoryId,
      sourceId: input.sourceId,
      source,
      plan,
      expectedPlanDigest: row.digest,
    });
  } catch {
    corrupt();
  }
}

interface RootRow {
  json: string | null;
  digest: string | null;
  cellCount: number;
  cellJson: string | null;
  cellDigest: string;
}
/** Reads a small complete reference manifest, never all source or cell document bodies. */
export function readEvaluationReproductionManifestInTransaction(
  database: DatabaseSync,
  repositoryId: string,
  evaluationId: string,
): C.EvaluationReproductionManifestV1 | null {
  if (!database.isTransaction) corrupt();
  const row = database
    .prepare(`SELECT manifest.manifest_sha256 AS digest,
    CASE WHEN length(CAST(manifest.manifest_json AS BLOB)) <= ${manifestMaximum} THEN manifest.manifest_json END AS json,
    evaluation.cell_count AS cellCount, evaluation.cell_manifest_sha256 AS cellDigest,
    CASE WHEN length(CAST(evaluation.cell_manifest_json AS BLOB)) <= ${manifestMaximum} THEN evaluation.cell_manifest_json END AS cellJson
    FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    LEFT JOIN evaluation_reproduction_manifests AS manifest ON manifest.evaluation_id = evaluation.id AND manifest.repository_id = evaluation.repository_id
    WHERE evaluation.repository_id = ? AND evaluation.id = ?`)
    .get(repositoryId, evaluationId) as RootRow | undefined;
  if (!row) missing();
  const cells = parse(row.cellJson, manifestMaximum, row.cellDigest);
  if (Value.Check(C.EvaluationCellManifestV1Schema, cells)) {
    if (
      row.json !== null ||
      row.digest !== null ||
      database
        .prepare(`SELECT 1 FROM evaluation_reproduction_cells
      WHERE evaluation_id = ? LIMIT 1`)
        .get(evaluationId)
    )
      corrupt();
    return null;
  }
  if (!Value.Check(C.EvaluationCellManifestV2Schema, cells)) corrupt();
  if (row.digest === null) corrupt();
  const manifest = parse(row.json, manifestMaximum, row.digest);
  if (C.getEvaluationReproductionManifestIssues(manifest).length) corrupt();
  const checked = manifest as C.EvaluationReproductionManifestV1;
  if (
    checked.repositoryId !== repositoryId ||
    checked.evaluationId !== evaluationId ||
    cells.repositoryId !== repositoryId ||
    cells.evaluationId !== evaluationId ||
    evaluationReproductionManifestDigest(checked) !== row.digest ||
    cells.reproductionManifestSha256 !== row.digest ||
    checked.cells.length !== row.cellCount ||
    cells.cells.length !== row.cellCount
  )
    corrupt();
  const records = database
    .prepare(`SELECT cell.id AS cellId, cell.case_id AS caseId, cell.arm, cell.source_id AS sourceId,
    record.record_sha256 AS cellRecordSha256, record.source_definition_sha256 AS sourceDefinitionSha256
    FROM evaluation_cells AS cell LEFT JOIN evaluation_reproduction_cells AS record ON record.cell_id = cell.id
      AND record.evaluation_id = cell.evaluation_id AND record.repository_id = cell.repository_id AND record.source_id = cell.source_id
    WHERE cell.repository_id = ? AND cell.evaluation_id = ? ORDER BY cell.id LIMIT 65`)
    .all(repositoryId, evaluationId) as unknown as {
    cellId: string;
    caseId: string;
    arm: C.EvaluationArm;
    sourceId: string;
    cellRecordSha256: string | null;
    sourceDefinitionSha256: string | null;
  }[];
  if (records.length !== row.cellCount) corrupt();
  const expectedSources = new Map<
    string,
    { caseId: string; sourceId: string; sourceDefinitionSha256: string }
  >();
  for (const record of records) {
    const entry = checked.cells.find((item) => item.cellId === record.cellId);
    const cell = cells.cells.find((item) => item.cellId === record.cellId);
    if (
      !entry ||
      !cell ||
      record.cellRecordSha256 === null ||
      !same(entry, {
        cellId: record.cellId,
        caseId: record.caseId,
        arm: record.arm,
        cellRecordSha256: record.cellRecordSha256,
      }) ||
      cell.caseId !== record.caseId ||
      cell.arm !== record.arm ||
      cell.sourceId !== record.sourceId ||
      cell.reproduction.cellRecordSha256 !== record.cellRecordSha256
    )
      corrupt();
    if (record.sourceDefinitionSha256 !== null) {
      const expected = {
        caseId: record.caseId,
        sourceId: record.sourceId,
        sourceDefinitionSha256: record.sourceDefinitionSha256,
      };
      const previous = expectedSources.get(record.caseId);
      if (previous && !same(previous, expected)) corrupt();
      expectedSources.set(record.caseId, expected);
    }
  }
  if (
    checked.sources.length !== expectedSources.size ||
    checked.sources.some((source) => !same(source, expectedSources.get(source.caseId)))
  )
    corrupt();
  return checked;
}

/** Reconstructs this cell from its explicit mapping and frozen source, profile, and evaluation authority. */
export function readEvaluationReproductionCellInTransaction(
  database: DatabaseSync,
  input: {
    readonly repositoryId: string;
    readonly evaluationId: string;
    readonly cellId: string;
    readonly sourceId: string;
    readonly applicable: boolean;
    readonly plan: C.ReviewRunExecutionPlanV2;
    readonly manifest: C.EvaluationCellManifestV1 | C.EvaluationCellManifestV2;
  },
): C.EvaluationReproductionCellRecordV1 | null {
  if (input.manifest.schemaVersion === "EvaluationCellManifestV1") {
    if (
      input.plan.reproduction !== undefined ||
      readEvaluationSourceReproductionInTransaction(database, {
        repositoryId: input.repositoryId,
        sourceId: input.sourceId,
        source: input.plan.source,
      }) !== null
    )
      corrupt();
    return null;
  }
  const root = readEvaluationReproductionManifestInTransaction(
    database,
    input.repositoryId,
    input.evaluationId,
  );
  if (root === null) corrupt();
  const row = database
    .prepare(`SELECT record_sha256 AS digest,
    CASE WHEN length(CAST(record_json AS BLOB)) <= ${documentMaximum} THEN record_json END AS json
    FROM evaluation_reproduction_cells WHERE repository_id = ? AND evaluation_id = ? AND cell_id = ? AND source_id = ?`)
    .get(input.repositoryId, input.evaluationId, input.cellId, input.sourceId) as
    | { digest: string; json: string | null }
    | undefined;
  if (!row) corrupt();
  const parsed = parse(row.json, documentMaximum, row.digest);
  if (C.getEvaluationReproductionCellRecordIssues(parsed).length) corrupt();
  const record = parsed as C.EvaluationReproductionCellRecordV1;
  const entry = input.manifest.cells.find((cell) => cell.cellId === input.cellId);
  if (
    !entry ||
    record.repositoryId !== input.repositoryId ||
    record.evaluationId !== input.evaluationId ||
    record.cellId !== input.cellId ||
    record.caseId !== input.plan.purpose.caseId ||
    record.arm !== input.plan.purpose.arm ||
    record.sourceId !== input.sourceId ||
    row.digest !== entry.reproduction.cellRecordSha256 ||
    row.digest !== evaluationReproductionCellRecordDigest(record) ||
    !same(entry.reproduction, {
      state: record.state,
      bindingDigest: record.reproduction?.bindingDigest ?? null,
      cellRecordSha256: row.digest,
    }) ||
    !same(record.reproduction, input.plan.reproduction ?? null)
  )
    corrupt();
  const definition = readEvaluationSourceReproductionInTransaction(database, {
    repositoryId: input.repositoryId,
    sourceId: input.sourceId,
    source: input.plan.source,
  });
  if (definition !== null) {
    const stored = database
      .prepare(`SELECT definition_sha256 AS digest,
      CASE WHEN length(CAST(definition_json AS BLOB)) <= ${documentMaximum} THEN definition_json END AS json
      FROM evaluation_reproduction_sources WHERE repository_id = ? AND source_id = ?`)
      .get(input.repositoryId, input.sourceId) as
      | { digest: string; json: string | null }
      | undefined;
    if (
      !stored ||
      stored.digest !== evaluationReproductionSourceDefinitionDigest(definition) ||
      !same(parse(stored.json, documentMaximum, stored.digest), definition) ||
      record.sourceDefinitionSha256 !== stored.digest
    )
      corrupt();
  } else if (record.sourceDefinitionSha256 !== null) corrupt();
  const request = input.plan.jobs[0];
  if (!request) corrupt();
  try {
    const rebuilt = createEvaluationReproductionCellRecord({
      evaluationId: input.evaluationId,
      repositoryId: input.repositoryId,
      caseId: record.caseId,
      cellId: record.cellId,
      arm: record.arm,
      sourceId: record.sourceId,
      applicable: input.applicable,
      sourceDefinition: definition,
      ...(record.mappings === null || definition === null
        ? {}
        : {
            selection: {
              caseId: record.caseId,
              selectedCaseIds: record.selectedCaseIds,
              expectedSource: {
                reviewRunId: definition.reviewRunId,
                planDigest: definition.planDigest,
                bindingDigest: definition.bindingDigest,
              },
              baseline: record.mappings,
              candidate: record.mappings,
            },
          }),
      bindingContext: {
        activationId: input.plan.activationId,
        requestId: request.requestId,
        source: input.plan.source,
        profileVersion: request.profileVersion,
        actor: input.plan.authorization.actor,
        authorizedAt: input.plan.authorization.authorizedAt,
      },
    });
    if (!same(rebuilt, record)) corrupt();
  } catch {
    corrupt();
  }
  return record;
}

/** Persisted only inside the batch transaction, before its complete immutable seal. */
export function persistEvaluationReproductionInTransaction(
  database: DatabaseSync,
  input: {
    readonly sources: readonly C.EvaluationReproductionSourceDefinitionV1[];
    readonly cells: readonly C.EvaluationReproductionCellRecordV1[];
    readonly manifest: C.EvaluationReproductionManifestV1;
    readonly now: string;
  },
): void {
  if (!database.isTransaction) corrupt();
  for (const definition of input.sources) {
    const digest = evaluationReproductionSourceDefinitionDigest(definition),
      serialized = canonicalJson(definition);
    if (Buffer.byteLength(serialized) > documentMaximum) invalid();
    const previous = database
      .prepare(`SELECT definition_json AS json, definition_sha256 AS digest FROM evaluation_reproduction_sources
      WHERE source_id = ? AND repository_id = ?`)
      .get(definition.sourceId, definition.repositoryId) as
      | { json: string; digest: string }
      | undefined;
    if (previous) {
      if (previous.digest !== digest || previous.json !== serialized) corrupt();
      continue;
    }
    database
      .prepare(`INSERT INTO evaluation_reproduction_sources(source_id,repository_id,definition_sha256,definition_json,created_at)
      VALUES (?,?,?,?,?)`)
      .run(definition.sourceId, definition.repositoryId, digest, serialized, input.now);
  }
  for (const record of input.cells) {
    const serialized = canonicalJson(record);
    if (Buffer.byteLength(serialized) > documentMaximum) invalid();
    database
      .prepare(`INSERT INTO evaluation_reproduction_cells(cell_id,evaluation_id,repository_id,source_id,
      source_definition_sha256,record_sha256,record_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        record.cellId,
        record.evaluationId,
        record.repositoryId,
        record.sourceId,
        record.sourceDefinitionSha256,
        evaluationReproductionCellRecordDigest(record),
        serialized,
        input.now,
      );
  }
  const serialized = canonicalJson(input.manifest);
  if (Buffer.byteLength(serialized) > manifestMaximum) invalid();
  database
    .prepare(`INSERT INTO evaluation_reproduction_manifests(evaluation_id,repository_id,manifest_sha256,manifest_json,created_at)
    VALUES (?,?,?,?,?)`)
    .run(
      input.manifest.evaluationId,
      input.manifest.repositoryId,
      evaluationReproductionManifestDigest(input.manifest),
      serialized,
      input.now,
    );
}

interface Scope {
  readonly repositoryId: string;
  readonly actor: C.OperatorPrincipal;
}
export interface EvaluationReproductionOperationMap {
  getEvaluationSourceReproduction: {
    input: Scope & { readonly sourceId: string };
    output: C.EvaluationReproductionSourceDefinitionReadV1;
  };
  getEvaluationReproductionPlan: {
    input: Scope & { readonly evaluationId: string };
    output: C.EvaluationReproductionPlanV1;
  };
  getEvaluationReproductionCell: {
    input: Scope & { readonly evaluationId: string; readonly cellId: string };
    output: C.EvaluationReproductionCellDetailV1;
  };
  previewEvaluationReproduction: {
    input: Scope & { readonly request: C.EvaluationReproductionPreviewRequest };
    output: C.EvaluationReproductionPreviewV1;
  };
}
export type EvaluationReproductionOperation = keyof EvaluationReproductionOperationMap;
export type EvaluationReproductionRequest = {
  [K in EvaluationReproductionOperation]: {
    readonly operation: K;
    readonly input: EvaluationReproductionOperationMap[K]["input"];
  };
}[EvaluationReproductionOperation];
const scopeSchema = { repositoryId: C.EntityIdSchema, actor: C.OperatorPrincipalSchema };
const strict = { additionalProperties: false } as const;
const schemas = {
  getEvaluationSourceReproduction: Type.Object(
    { ...scopeSchema, sourceId: C.EntityIdSchema },
    strict,
  ),
  getEvaluationReproductionPlan: Type.Object(
    { ...scopeSchema, evaluationId: C.EntityIdSchema },
    strict,
  ),
  getEvaluationReproductionCell: Type.Object(
    { ...scopeSchema, evaluationId: C.EntityIdSchema, cellId: C.EntityIdSchema },
    strict,
  ),
  previewEvaluationReproduction: Type.Object(
    { ...scopeSchema, request: C.EvaluationReproductionPreviewRequestSchema },
    strict,
  ),
};
export function isEvaluationReproductionOperation(
  operation: string,
): operation is EvaluationReproductionOperation {
  return Object.hasOwn(schemas, operation);
}
function preview(
  database: DatabaseSync,
  input: EvaluationReproductionOperationMap["previewEvaluationReproduction"]["input"],
  now: string,
): C.EvaluationReproductionPreviewV1 {
  const source = readSource(database, input.repositoryId, input.request.sourceId);
  const definition = readEvaluationSourceReproductionInTransaction(database, {
    repositoryId: input.repositoryId,
    sourceId: input.request.sourceId,
    source,
  });
  if (definition === null) invalid();
  const arm = (name: C.EvaluationArm) => {
    const profileVersionId = input.request[`${name}ProfileVersionId`];
    const identity = database
      .prepare(`SELECT version.profile_id AS id FROM validation_profile_versions AS version
      JOIN validation_profiles AS profile ON profile.id = version.profile_id WHERE version.id = ? AND profile.repository_id = ?`)
      .get(profileVersionId, input.repositoryId) as { id: string } | undefined;
    if (!identity) missing();
    const profile = handlePromptConfigurationRequest(
      database,
      {
        operation: "getValidationProfileVersion",
        input: {
          repositoryId: input.repositoryId,
          profileId: identity.id,
          versionId: profileVersionId,
        },
      },
      now,
    ) as C.ValidationProfileVersion;
    if (Date.parse(profile.publishedAt) > Date.parse(now)) corrupt();
    const record = createEvaluationReproductionCellRecord({
      evaluationId: "preview-evaluation",
      repositoryId: input.repositoryId,
      caseId: input.request.selection.caseId,
      cellId: `preview-${name}`,
      arm: name,
      sourceId: input.request.sourceId,
      applicable: true,
      sourceDefinition: definition,
      selection: input.request.selection,
      bindingContext: {
        activationId: `preview-activation-${name}`,
        requestId: `preview-request-${name}`,
        source,
        profileVersion: profile,
        actor: input.actor,
        authorizedAt: now,
      },
    });
    return {
      profileVersionId: profile.id,
      profileConfigSha256: profile.configSha256,
      state: record.state,
      blockers: record.blockers,
    };
  };
  try {
    return {
      schemaVersion: "EvaluationReproductionPreviewV1",
      repositoryId: input.repositoryId,
      sourceId: input.request.sourceId,
      sourceDefinitionSha256: evaluationReproductionSourceDefinitionDigest(definition),
      baseline: arm("baseline"),
      candidate: arm("candidate"),
    };
  } catch (error) {
    if (error instanceof EvaluationManagementError) throw error;
    invalid();
  }
}
export function handleEvaluationReproductionRequest(
  database: DatabaseSync,
  request: EvaluationReproductionRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): EvaluationReproductionOperationMap[EvaluationReproductionOperation]["output"] {
  if (
    !request ||
    !isEvaluationReproductionOperation(request.operation) ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !Value.Check(schemas[request.operation], request.input) ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid();
  if (
    request.operation === "previewEvaluationReproduction" &&
    C.getEvaluationReproductionPreviewRequestIssues(request.input.request).length
  )
    invalid();
  const nested = database.isTransaction,
    savepoint = `evaluation_reproduction_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
  try {
    const input = request.input;
    assertRepositoryPermission(database, input.actor, input.repositoryId, "read", administrators);
    let result: EvaluationReproductionOperationMap[EvaluationReproductionOperation]["output"];
    switch (request.operation) {
      case "getEvaluationSourceReproduction": {
        const definition = readEvaluationSourceReproductionInTransaction(database, request.input);
        result = {
          schemaVersion: "EvaluationReproductionSourceDefinitionReadV1",
          repositoryId: input.repositoryId,
          sourceId: request.input.sourceId,
          sourceDefinition: definition,
          sourceDefinitionSha256:
            definition === null ? null : evaluationReproductionSourceDefinitionDigest(definition),
        };
        break;
      }
      case "getEvaluationReproductionPlan":
        result = {
          schemaVersion: "EvaluationReproductionPlanV1",
          repositoryId: input.repositoryId,
          evaluationId: request.input.evaluationId,
          manifest: readEvaluationReproductionManifestInTransaction(
            database,
            input.repositoryId,
            request.input.evaluationId,
          ),
        };
        break;
      case "getEvaluationReproductionCell": {
        const row = database
          .prepare(
            `SELECT run_id AS runId FROM evaluation_cells WHERE repository_id = ? AND evaluation_id = ? AND id = ?`,
          )
          .get(input.repositoryId, request.input.evaluationId, request.input.cellId) as
          | { runId: string }
          | undefined;
        if (!row) missing();
        const cell = readEvaluationExecutionCellInTransaction(database, {
          repositoryId: input.repositoryId,
          runId: row.runId,
        });
        if (
          !cell ||
          cell.evaluationId !== request.input.evaluationId ||
          cell.cellId !== request.input.cellId
        )
          corrupt();
        if (cell.reproductionRecord === null) missing();
        result = {
          schemaVersion: "EvaluationReproductionCellDetailV1",
          repositoryId: input.repositoryId,
          evaluationId: cell.evaluationId,
          cellId: cell.cellId,
          record: cell.reproductionRecord,
          cellRecordSha256: evaluationReproductionCellRecordDigest(cell.reproductionRecord),
        };
        break;
      }
      case "previewEvaluationReproduction":
        result = preview(database, request.input, now);
        break;
    }
    const issues =
      result.schemaVersion === "EvaluationReproductionSourceDefinitionReadV1"
        ? C.getEvaluationReproductionSourceDefinitionReadIssues(result)
        : result.schemaVersion === "EvaluationReproductionPlanV1"
          ? C.getEvaluationReproductionPlanIssues(result)
          : result.schemaVersion === "EvaluationReproductionCellDetailV1"
            ? C.getEvaluationReproductionCellDetailIssues(result)
            : C.getEvaluationReproductionPreviewIssues(result);
    if (issues.length || Buffer.byteLength(canonicalJson(result)) > documentMaximum + 8192)
      corrupt();
    database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      if (nested) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else database.exec("ROLLBACK");
    }
    throw error;
  }
}
