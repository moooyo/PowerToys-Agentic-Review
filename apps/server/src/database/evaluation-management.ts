import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  assertEvaluationSourceSnapshotIntegrity,
  captureEvaluationSourceInTransaction,
} from "./evaluation-source.js";
import { assertRepositoryPermission } from "./operator-access.js";

interface Scope {
  readonly repositoryId: string;
  readonly actor: C.OperatorPrincipal;
}
interface SuiteScope extends Scope {
  readonly suiteId: string;
}
interface MutationRestriction {
  /** Internal transport restriction. Public request bodies cannot supply this field. */
  readonly replayOnly?: true;
}
interface VersionScope extends SuiteScope {
  readonly versionId: string;
}
export interface EvaluationManagementOperationMap {
  captureEvaluationSource: {
    input: Scope & MutationRestriction & { readonly request: C.EvaluationSourceCaptureRequest };
    output: C.EvaluationSourceSummaryV1;
  };
  getEvaluationSource: {
    input: Scope & { readonly sourceId: string };
    output: C.EvaluationSourceDetailV1;
  };
  listEvaluationSources: {
    input: Scope & { readonly query: C.EvaluationSourceListQuery };
    output: C.EvaluationSourceListResponse;
  };
  createEvaluationSuite: {
    input: Scope & MutationRestriction & { readonly request: C.EvaluationSuiteCreateRequest };
    output: C.EvaluationSuiteSummaryV1;
  };
  getEvaluationSuite: { input: SuiteScope; output: C.EvaluationSuiteDetailV1 };
  listEvaluationSuites: {
    input: Scope & { readonly query: C.EvaluationSuiteListQuery };
    output: C.EvaluationSuiteListResponse;
  };
  saveEvaluationSuiteDraft: {
    input: SuiteScope & MutationRestriction & { readonly request: C.EvaluationSuiteSaveRequest };
    output: C.EvaluationSuiteSummaryV1;
  };
  publishEvaluationSuite: {
    input: SuiteScope & MutationRestriction & { readonly request: C.EvaluationSuitePublishRequest };
    output: C.EvaluationSuiteVersionV1;
  };
  listEvaluationSuiteVersions: {
    input: SuiteScope & { readonly query: C.EvaluationSuiteListQuery };
    output: C.EvaluationSuiteVersionListResponse;
  };
  getEvaluationSuiteVersion: { input: VersionScope; output: C.EvaluationSuiteVersionV1 };
  listEvaluationSuiteCases: { input: VersionScope; output: C.EvaluationSuiteCaseListV1 };
  getEvaluationSuiteCase: {
    input: VersionScope & { readonly caseId: string };
    output: C.EvaluationSuiteCaseDetailV1;
  };
}
export type EvaluationManagementOperation = keyof EvaluationManagementOperationMap;
export type EvaluationManagementRequest = {
  [K in EvaluationManagementOperation]: {
    readonly operation: K;
    readonly input: EvaluationManagementOperationMap[K]["input"];
  };
}[EvaluationManagementOperation];

const scope = { repositoryId: C.EntityIdSchema, actor: C.OperatorPrincipalSchema };
const suiteScope = { ...scope, suiteId: C.EntityIdSchema };
const mutationScope = { ...scope, replayOnly: Type.Optional(Type.Literal(true)) };
const mutationSuiteScope = { ...mutationScope, suiteId: C.EntityIdSchema };
const strict = { additionalProperties: false } as const;
const schemas = {
  captureEvaluationSource: Type.Object(
    { ...mutationScope, request: C.EvaluationSourceCaptureRequestSchema },
    strict,
  ),
  getEvaluationSource: Type.Object({ ...scope, sourceId: C.EntityIdSchema }, strict),
  listEvaluationSources: Type.Object(
    { ...scope, query: C.EvaluationSourceListQuerySchema },
    strict,
  ),
  createEvaluationSuite: Type.Object(
    { ...mutationScope, request: C.EvaluationSuiteCreateRequestSchema },
    strict,
  ),
  getEvaluationSuite: Type.Object(suiteScope, strict),
  listEvaluationSuites: Type.Object({ ...scope, query: C.EvaluationSuiteListQuerySchema }, strict),
  saveEvaluationSuiteDraft: Type.Object(
    { ...mutationSuiteScope, request: C.EvaluationSuiteSaveRequestSchema },
    strict,
  ),
  publishEvaluationSuite: Type.Object(
    { ...mutationSuiteScope, request: C.EvaluationSuitePublishRequestSchema },
    strict,
  ),
  listEvaluationSuiteVersions: Type.Object(
    { ...suiteScope, query: C.EvaluationSuiteListQuerySchema },
    strict,
  ),
  getEvaluationSuiteVersion: Type.Object({ ...suiteScope, versionId: C.EntityIdSchema }, strict),
  listEvaluationSuiteCases: Type.Object({ ...suiteScope, versionId: C.EntityIdSchema }, strict),
  getEvaluationSuiteCase: Type.Object(
    { ...suiteScope, versionId: C.EntityIdSchema, caseId: C.EntityIdSchema },
    strict,
  ),
};
const mutations = new Set<EvaluationManagementOperation>([
  "captureEvaluationSource",
  "createEvaluationSuite",
  "saveEvaluationSuiteDraft",
  "publishEvaluationSuite",
]);
const receiptOperations = {
  captureEvaluationSource: "source_captured",
  createEvaluationSuite: "suite_created",
  saveEvaluationSuiteDraft: "draft_saved",
  publishEvaluationSuite: "suite_published",
} as const;
type Mutation = keyof typeof receiptOperations;
type MutationRequest = Extract<EvaluationManagementRequest, { operation: Mutation }>;
type MutationOutput =
  | C.EvaluationSourceSummaryV1
  | C.EvaluationSuiteSummaryV1
  | C.EvaluationSuiteVersionV1;

export class EvaluationManagementError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT"
      | "DATABASE_READ_ONLY",
    message: string,
  ) {
    super(message);
    this.name = "EvaluationManagementError";
  }
}
function invalid(message = "The evaluation management request is invalid."): never {
  throw new EvaluationManagementError("PLATFORM_INVALID", message);
}
function corrupt(message = "The stored evaluation management record is invalid."): never {
  throw new EvaluationManagementError("PLATFORM_CORRUPT", message);
}
function missing(): never {
  throw new EvaluationManagementError(
    "PLATFORM_NOT_FOUND",
    "The evaluation resource was not found.",
  );
}
function conflict(
  message = "The evaluation resource changed. Refresh before trying again.",
): never {
  throw new EvaluationManagementError("PLATFORM_CONFLICT", message);
}
function assertInputIssues(issues: readonly string[]): void {
  if (issues.length) invalid(issues[0]);
}
function stored<T>(value: T, issues: (value: unknown) => readonly string[]): T {
  if (issues(value).length) corrupt();
  return value;
}
function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    corrupt();
  }
}
function assertTimestamp(now: string): void {
  if (
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid("A canonical evaluation management timestamp is required.");
}
function transaction<T>(database: DatabaseSync, write: boolean, action: () => T): T {
  const nested = database.isTransaction;
  const name = `evaluation_${randomUUID().replaceAll("-", "")}`;
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
      throw new AggregateError([error, rollbackError], "Evaluation management rollback failed.", {
        cause: error,
      });
    }
    throw error;
  }
}

export function isEvaluationManagementOperation(
  operation: string,
): operation is EvaluationManagementOperation {
  return Object.hasOwn(schemas, operation);
}
function validateRequest(request: EvaluationManagementRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !isEvaluationManagementOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input)
  )
    invalid();
  if (
    Buffer.byteLength(JSON.stringify(request.input), "utf8") >
    C.maximumEvaluationSuiteUtf8Bytes + 65_536
  )
    invalid("The evaluation request exceeds its aggregate byte limit.");
  switch (request.operation) {
    case "captureEvaluationSource":
      assertInputIssues(C.getEvaluationSourceCaptureRequestIssues(request.input.request));
      break;
    case "listEvaluationSources":
      assertInputIssues(C.getEvaluationSourceListQueryIssues(request.input.query));
      break;
    case "createEvaluationSuite":
      assertInputIssues(C.getEvaluationSuiteCreateRequestIssues(request.input.request));
      break;
    case "saveEvaluationSuiteDraft":
      assertInputIssues(C.getEvaluationSuiteSaveRequestIssues(request.input.request));
      break;
    case "publishEvaluationSuite":
      assertInputIssues(C.getEvaluationSuitePublishRequestIssues(request.input.request));
      break;
    case "listEvaluationSuites":
    case "listEvaluationSuiteVersions":
      assertInputIssues(C.getEvaluationSuiteListQueryIssues(request.input.query));
      break;
  }
}

interface SourceRow {
  id: string;
  repository_id: string;
  work_item_id: string;
  revision_id: string;
  revision_key: string;
  source_digest: string;
  kind: "pull_request" | "issue";
  number: number;
  title: string;
  actor_issuer: string;
  actor_subject: string;
  created_at: string;
}
const sourceColumns = `id, repository_id, work_item_id, revision_id, revision_key, source_digest,
  json_extract(source_json, '$.workItem.kind') AS kind,
  json_extract(source_json, '$.workItem.number') AS number,
  json_extract(source_json, '$.workItem.title') AS title, actor_issuer, actor_subject, created_at`;
function sourceSummary(row: SourceRow): C.EvaluationSourceSummaryV1 {
  return stored(
    {
      schemaVersion: "EvaluationSourceSummaryV1" as const,
      id: row.id,
      repositoryId: row.repository_id,
      workItemId: row.work_item_id,
      revisionId: row.revision_id,
      revisionKey: row.revision_key,
      sourceDigest: row.source_digest,
      workItemKind: row.kind,
      number: row.number,
      title: row.title,
      createdAt: row.created_at,
      createdBy: { issuer: row.actor_issuer, subject: row.actor_subject },
    },
    C.getEvaluationSourceSummaryIssues,
  );
}
function readSource(
  database: DatabaseSync,
  repositoryId: string,
  sourceId: string,
): C.EvaluationSourceDetailV1 {
  const length = database
    .prepare(
      "SELECT length(CAST(source_json AS BLOB)) AS bytes FROM evaluation_sources WHERE repository_id = ? AND id = ?",
    )
    .get(repositoryId, sourceId) as { bytes: number } | undefined;
  if (!length) missing();
  if (
    !Number.isSafeInteger(length.bytes) ||
    length.bytes < 1 ||
    length.bytes > C.maximumEvaluationSourceSnapshotUtf8Bytes
  )
    corrupt();
  const row = database
    .prepare(
      `SELECT ${sourceColumns}, source_json FROM evaluation_sources WHERE repository_id = ? AND id = ?`,
    )
    .get(repositoryId, sourceId) as (SourceRow & { source_json: string }) | undefined;
  if (!row) missing();
  const snapshot = parse(row.source_json);
  assertEvaluationSourceSnapshotIntegrity(snapshot);
  return stored({ ...sourceSummary(row), snapshot }, C.getEvaluationSourceDetailIssues);
}

interface SuiteRow {
  id: string;
  repository_id: string;
  workflow_kind: C.WorkflowKind;
  target: C.ValidationTarget;
  name: string;
  description: string;
  draft_revision: number;
  case_count: number;
  latest_version_id: string | null;
  created_by_issuer: string;
  created_by_subject: string;
  updated_by_issuer: string;
  updated_by_subject: string;
  created_at: string;
  updated_at: string;
}
const suiteColumns = `id, repository_id, workflow_kind, target, name, description, draft_revision,
  json_array_length(draft_json, '$.cases') AS case_count, latest_version_id, created_by_issuer,
  created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at`;
function suiteSummary(row: SuiteRow): C.EvaluationSuiteSummaryV1 {
  return stored(
    {
      schemaVersion: "EvaluationSuiteSummaryV1" as const,
      id: row.id,
      repositoryId: row.repository_id,
      workflowKind: row.workflow_kind,
      target: row.target,
      name: row.name,
      description: row.description,
      draftRevision: row.draft_revision,
      caseCount: row.case_count,
      latestVersionId: row.latest_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: { issuer: row.created_by_issuer, subject: row.created_by_subject },
      updatedBy: { issuer: row.updated_by_issuer, subject: row.updated_by_subject },
    },
    C.getEvaluationSuiteSummaryIssues,
  );
}
function readSuite(
  database: DatabaseSync,
  input: Pick<SuiteScope, "repositoryId" | "suiteId">,
): C.EvaluationSuiteDetailV1 {
  const length = database
    .prepare(
      "SELECT length(CAST(draft_json AS BLOB)) AS bytes FROM evaluation_suites WHERE repository_id = ? AND id = ?",
    )
    .get(input.repositoryId, input.suiteId) as { bytes: number } | undefined;
  if (!length) missing();
  if (
    !Number.isSafeInteger(length.bytes) ||
    length.bytes < 1 ||
    length.bytes > C.maximumEvaluationSuiteUtf8Bytes
  )
    corrupt();
  const row = database
    .prepare(
      `SELECT ${suiteColumns}, draft_json FROM evaluation_suites WHERE repository_id = ? AND id = ?`,
    )
    .get(input.repositoryId, input.suiteId) as (SuiteRow & { draft_json: string }) | undefined;
  if (!row) missing();
  const draft = parse(row.draft_json);
  if (C.getEvaluationSuiteDraftIssues(draft).length) corrupt();
  return stored(
    { ...suiteSummary(row), draft: draft as C.EvaluationSuiteDraft },
    C.getEvaluationSuiteDetailIssues,
  );
}
function summaryFromDetail(detail: C.EvaluationSuiteDetailV1): C.EvaluationSuiteSummaryV1 {
  const { draft: _draft, ...summary } = detail;
  return summary;
}

interface VersionRow {
  id: string;
  suite_id: string;
  repository_id: string;
  version: number;
  source_draft_revision: number;
  name: string;
  description: string;
  workflow_kind: C.WorkflowKind;
  target: C.ValidationTarget;
  source_version_id: string;
  expectation_version_id: string;
  source_manifest_sha256: string;
  expectation_manifest_sha256: string;
  case_count: number;
  actor_issuer: string;
  actor_subject: string;
  created_at: string;
}
const versionColumns = `id, suite_id, repository_id, version, source_draft_revision, name, description,
  workflow_kind, target, source_version_id, expectation_version_id, source_manifest_sha256,
  expectation_manifest_sha256, case_count, actor_issuer, actor_subject, created_at`;
function versionSummary(row: VersionRow): C.EvaluationSuiteVersionV1 {
  return stored(
    {
      schemaVersion: "EvaluationSuiteVersionV1" as const,
      id: row.id,
      suiteId: row.suite_id,
      repositoryId: row.repository_id,
      version: row.version,
      sourceDraftRevision: row.source_draft_revision,
      name: row.name,
      description: row.description,
      workflowKind: row.workflow_kind,
      target: row.target,
      sourceVersionId: row.source_version_id,
      expectationVersionId: row.expectation_version_id,
      sourceManifestSha256: row.source_manifest_sha256,
      expectationManifestSha256: row.expectation_manifest_sha256,
      caseCount: row.case_count,
      createdAt: row.created_at,
      createdBy: { issuer: row.actor_issuer, subject: row.actor_subject },
    },
    C.getEvaluationSuiteVersionIssues,
  );
}
function readVersion(
  database: DatabaseSync,
  input: Pick<VersionScope, "repositoryId" | "suiteId" | "versionId">,
): C.EvaluationSuiteVersionV1 {
  const row = database
    .prepare(
      `SELECT ${versionColumns} FROM evaluation_suite_versions WHERE repository_id = ? AND suite_id = ? AND id = ?`,
    )
    .get(input.repositoryId, input.suiteId, input.versionId) as VersionRow | undefined;
  if (!row) missing();
  return versionSummary(row);
}

function validateSources(
  database: DatabaseSync,
  suite: Pick<C.EvaluationSuiteSummaryV1, "repositoryId" | "workflowKind">,
  cases: C.EvaluationSuiteDraft["cases"],
): Map<string, C.EvaluationSourceDetailV1> {
  let totalBytes = 0;
  for (const entry of cases) {
    const row = database
      .prepare(
        "SELECT length(CAST(source_json AS BLOB)) AS bytes FROM evaluation_sources WHERE repository_id = ? AND id = ?",
      )
      .get(suite.repositoryId, entry.sourceId) as { bytes: number } | undefined;
    if (!row) missing();
    if (
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > C.maximumEvaluationSourceSnapshotUtf8Bytes
    )
      corrupt();
    totalBytes += row.bytes;
    if (totalBytes > 16 * 1024 * 1024)
      invalid("The suite exceeds its aggregate source byte limit of 16 MiB.");
  }
  const sources = new Map<string, C.EvaluationSourceDetailV1>();
  for (const entry of cases) {
    let source = sources.get(entry.sourceId);
    if (!source) {
      source = readSource(database, suite.repositoryId, entry.sourceId);
      sources.set(entry.sourceId, source);
    }
    const snapshot = source.snapshot;
    const compatible = suite.workflowKind.startsWith("pr_")
      ? snapshot.workItem.kind === "pull_request" &&
        snapshot.testedSourceRevision?.kind === "pull_request"
      : snapshot.workItem.kind === "issue" &&
        (suite.workflowKind === "issue_triage"
          ? snapshot.testedSourceRevision === null
          : snapshot.testedSourceRevision?.kind === "commit");
    if (!compatible)
      invalid(
        "The captured source does not match the suite workflow and tested commit requirements.",
      );
  }
  return sources;
}

export interface PublishedEvaluationSuite {
  readonly version: C.EvaluationSuiteVersionV1;
  readonly sourceManifest: C.EvaluationSourceManifestV1;
  readonly expectationManifest: C.EvaluationExpectationManifestV1;
}
/** Internal batch planning also rechecks permission; manifests never come from an HTTP body. */
export function readPublishedEvaluationSuiteInTransaction(
  database: DatabaseSync,
  input: VersionScope,
  administrators: readonly C.OperatorPrincipal[],
): PublishedEvaluationSuite {
  if (!database.isTransaction)
    invalid("Reading a frozen evaluation suite requires an existing transaction.");
  if (!Value.Check(schemas.getEvaluationSuiteVersion, input)) invalid();
  assertRepositoryPermission(database, input.actor, input.repositoryId, "read", administrators);
  const version = readVersion(database, input);
  const sourceRow = database
    .prepare(`SELECT manifest_sha256, CASE WHEN length(CAST(manifest_json AS BLOB)) <= ? THEN manifest_json ELSE NULL END AS manifest_json
    FROM evaluation_source_versions WHERE id = ? AND suite_id = ? AND repository_id = ?`)
    .get(
      C.maximumEvaluationSourceManifestUtf8Bytes,
      version.sourceVersionId,
      input.suiteId,
      input.repositoryId,
    ) as { manifest_sha256: string; manifest_json: string | null } | undefined;
  const expectationRow = database
    .prepare(`SELECT manifest_sha256, CASE WHEN length(CAST(manifest_json AS BLOB)) <= ? THEN manifest_json ELSE NULL END AS manifest_json
    FROM evaluation_expectation_versions WHERE id = ? AND suite_id = ? AND repository_id = ?`)
    .get(
      C.maximumEvaluationSuiteUtf8Bytes,
      version.expectationVersionId,
      input.suiteId,
      input.repositoryId,
    ) as { manifest_sha256: string; manifest_json: string | null } | undefined;
  if (!sourceRow?.manifest_json || !expectationRow?.manifest_json) corrupt();
  const source = parse(sourceRow.manifest_json),
    expected = parse(expectationRow.manifest_json);
  if (
    C.getEvaluationSourceManifestIssues(source).length ||
    C.getEvaluationExpectationManifestIssues(expected).length
  )
    corrupt();
  const sourceManifest = source as C.EvaluationSourceManifestV1,
    expectationManifest = expected as C.EvaluationExpectationManifestV1;
  if (
    sha256(canonicalJson(sourceManifest)) !== version.sourceManifestSha256 ||
    sourceRow.manifest_sha256 !== version.sourceManifestSha256 ||
    sha256(canonicalJson(expectationManifest)) !== version.expectationManifestSha256 ||
    expectationRow.manifest_sha256 !== version.expectationManifestSha256 ||
    [sourceManifest, expectationManifest].some(
      (manifest) =>
        manifest.repositoryId !== input.repositoryId ||
        manifest.workflowKind !== version.workflowKind ||
        manifest.target !== version.target ||
        manifest.cases.length !== version.caseCount,
    ) ||
    sourceManifest.cases.some(
      (entry, index) => expectationManifest.cases[index]?.caseId !== entry.caseId,
    )
  )
    corrupt();
  const cases = expectationManifest.cases.map((entry, index) => {
    const sourceCase = sourceManifest.cases[index];
    if (!sourceCase) corrupt();
    return { ...entry, sourceId: sourceCase.sourceId };
  });
  const sources = validateSources(database, version, cases);
  if (
    sourceManifest.cases.some(
      (entry) => sources.get(entry.sourceId)?.sourceDigest !== entry.sourceDigest,
    )
  )
    corrupt();
  return { version, sourceManifest, expectationManifest };
}

interface ReceiptRow {
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
function intentDigest(request: MutationRequest): string {
  const { replayOnly: _replayOnly, ...input } = request.input;
  return sha256(canonicalJson({ operation: request.operation, input }));
}
function replay(
  database: DatabaseSync,
  request: MutationRequest,
  digest: string,
): MutationOutput | null {
  const input = request.input;
  const row = database
    .prepare(`SELECT operation, entity_id, intent_digest, actor_issuer, actor_subject,
    previous_version, version, response_json, created_at FROM evaluation_mutation_receipts
    WHERE repository_id = ? AND change_id = ?`)
    .get(input.repositoryId, input.request.changeId) as ReceiptRow | undefined;
  if (!row) return null;
  if (
    row.operation !== receiptOperations[request.operation] ||
    row.intent_digest !== digest ||
    row.actor_issuer !== input.actor.issuer ||
    row.actor_subject !== input.actor.subject
  )
    conflict("The evaluation change ID was already used for a different request or operator.");
  if (
    Buffer.byteLength(row.response_json, "utf8") > 262_144 ||
    row.version !== row.previous_version + 1
  )
    corrupt();
  const value = parse(row.response_json);
  if (request.operation === "captureEvaluationSource") {
    const result = stored(value as C.EvaluationSourceSummaryV1, C.getEvaluationSourceSummaryIssues);
    if (
      result.id !== row.entity_id ||
      result.repositoryId !== input.repositoryId ||
      result.createdAt !== row.created_at ||
      canonicalJson(result.createdBy) !== canonicalJson(input.actor) ||
      row.previous_version !== 0
    )
      corrupt();
    return result;
  }
  if (request.operation === "publishEvaluationSuite") {
    const result = stored(value as C.EvaluationSuiteVersionV1, C.getEvaluationSuiteVersionIssues);
    if (
      result.suiteId !== row.entity_id ||
      result.suiteId !== request.input.suiteId ||
      result.repositoryId !== input.repositoryId ||
      result.createdAt !== row.created_at ||
      canonicalJson(result.createdBy) !== canonicalJson(input.actor) ||
      result.sourceDraftRevision !== row.previous_version ||
      row.previous_version !== request.input.request.expectedRevision
    )
      corrupt();
    return result;
  }
  const result = stored(value as C.EvaluationSuiteSummaryV1, C.getEvaluationSuiteSummaryIssues);
  if (
    result.id !== row.entity_id ||
    result.repositoryId !== input.repositoryId ||
    result.draftRevision !== row.version ||
    result.updatedAt !== row.created_at ||
    canonicalJson(result.updatedBy) !== canonicalJson(input.actor) ||
    (request.operation === "createEvaluationSuite"
      ? row.previous_version !== 0
      : result.id !== request.input.suiteId ||
        row.previous_version !== request.input.request.expectedRevision)
  )
    corrupt();
  return result;
}
function writeReceipt(
  database: DatabaseSync,
  request: MutationRequest,
  digest: string,
  entityId: string,
  previous: number,
  output: MutationOutput,
  now: string,
): void {
  const response = canonicalJson(output);
  if (Buffer.byteLength(response, "utf8") > 262_144) corrupt();
  database
    .prepare(`INSERT INTO evaluation_mutation_receipts
    (repository_id, change_id, operation, entity_id, intent_digest, actor_issuer, actor_subject, previous_version, version, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      request.input.repositoryId,
      request.input.request.changeId,
      receiptOperations[request.operation],
      entityId,
      digest,
      request.input.actor.issuer,
      request.input.actor.subject,
      previous,
      previous + 1,
      response,
      now,
    );
}
function requireRevision(suite: C.EvaluationSuiteSummaryV1, expected: number): void {
  if (suite.draftRevision !== expected) conflict();
  if (suite.draftRevision >= Number.MAX_SAFE_INTEGER)
    conflict("The suite draft revision limit was reached.");
}
function captureSource(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["captureEvaluationSource"]["input"],
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationSourceSummaryV1 {
  const snapshot = captureEvaluationSourceInTransaction(
    database,
    { repositoryId: input.repositoryId, actor: input.actor, source: input.request.source },
    now,
    administrators,
  );
  const id = randomUUID();
  database
    .prepare(`INSERT INTO evaluation_sources
    (id, repository_id, work_item_id, revision_id, revision_key, source_digest, source_json, actor_issuer, actor_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.repositoryId,
      snapshot.workItemId,
      snapshot.revisionId,
      snapshot.revision.revisionKey,
      snapshot.sourceDigest,
      canonicalJson(snapshot),
      input.actor.issuer,
      input.actor.subject,
      now,
    );
  const detail = readSource(database, input.repositoryId, id);
  const { snapshot: _snapshot, ...summary } = detail;
  return summary;
}
function createSuite(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["createEvaluationSuite"]["input"],
  now: string,
): C.EvaluationSuiteSummaryV1 {
  const id = randomUUID(),
    request = input.request;
  const draft: C.EvaluationSuiteDraft = {
    name: request.name,
    description: request.description,
    cases: [],
  };
  database
    .prepare(`INSERT INTO evaluation_suites
    (id, repository_id, workflow_kind, target, name, description, draft_revision, draft_json, latest_version_id,
      created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.repositoryId,
      request.workflowKind,
      request.target,
      request.name,
      request.description,
      canonicalJson(draft),
      input.actor.issuer,
      input.actor.subject,
      input.actor.issuer,
      input.actor.subject,
      now,
      now,
    );
  return summaryFromDetail(readSuite(database, { repositoryId: input.repositoryId, suiteId: id }));
}
function saveDraft(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["saveEvaluationSuiteDraft"]["input"],
  now: string,
): C.EvaluationSuiteSummaryV1 {
  const suite = readSuite(database, input);
  requireRevision(suite, input.request.expectedRevision);
  const draft = input.request.draft;
  validateSources(database, suite, draft.cases);
  const result = database
    .prepare(`UPDATE evaluation_suites SET name = ?, description = ?, draft_json = ?,
    draft_revision = draft_revision + 1, updated_by_issuer = ?, updated_by_subject = ?, updated_at = ?
    WHERE repository_id = ? AND id = ? AND draft_revision = ?`)
    .run(
      draft.name,
      draft.description,
      canonicalJson(draft),
      input.actor.issuer,
      input.actor.subject,
      now,
      input.repositoryId,
      input.suiteId,
      input.request.expectedRevision,
    );
  if (Number(result.changes) !== 1) conflict();
  return summaryFromDetail(readSuite(database, input));
}
function publishSuite(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["publishEvaluationSuite"]["input"],
  now: string,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationSuiteVersionV1 {
  const suite = readSuite(database, input);
  requireRevision(suite, input.request.expectedRevision);
  assertInputIssues(C.getEvaluationSuitePublicationIssues(suite.draft));
  const sources = validateSources(database, suite, suite.draft.cases);
  const common = {
    repositoryId: input.repositoryId,
    workflowKind: suite.workflowKind,
    target: suite.target,
  };
  const sourceManifest: C.EvaluationSourceManifestV1 = {
    schemaVersion: "EvaluationSourceManifestV1",
    ...common,
    cases: suite.draft.cases.map((entry) => {
      const source = sources.get(entry.sourceId);
      if (!source) corrupt();
      return { caseId: entry.caseId, sourceId: entry.sourceId, sourceDigest: source.sourceDigest };
    }),
  };
  const expectationManifest: C.EvaluationExpectationManifestV1 = {
    schemaVersion: "EvaluationExpectationManifestV1",
    ...common,
    cases: suite.draft.cases.map(({ sourceId: _sourceId, ...entry }) => entry),
  };
  stored(sourceManifest, C.getEvaluationSourceManifestIssues);
  stored(expectationManifest, C.getEvaluationExpectationManifestIssues);
  const sourceJson = canonicalJson(sourceManifest),
    expectationJson = canonicalJson(expectationManifest);
  const sourceId = randomUUID(),
    expectationId = randomUUID(),
    id = randomUUID();
  const sourceDigest = sha256(sourceJson),
    expectationDigest = sha256(expectationJson);
  const current = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM evaluation_suite_versions WHERE repository_id = ? AND suite_id = ?",
    )
    .get(input.repositoryId, input.suiteId) as { version: number };
  if (!Number.isSafeInteger(current.version) || current.version < 0) corrupt();
  if (current.version >= Number.MAX_SAFE_INTEGER)
    conflict("The suite publication version limit was reached.");
  for (const [table, versionId, digest, body] of [
    ["evaluation_source_versions", sourceId, sourceDigest, sourceJson],
    ["evaluation_expectation_versions", expectationId, expectationDigest, expectationJson],
  ] as const)
    database
      .prepare(
        `INSERT INTO ${table} (id, suite_id, repository_id, manifest_sha256, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, input.suiteId, input.repositoryId, digest, body, now);
  database
    .prepare(`INSERT INTO evaluation_suite_versions
    (id, suite_id, repository_id, version, source_draft_revision, name, description, workflow_kind, target,
      source_version_id, expectation_version_id, source_manifest_sha256, expectation_manifest_sha256, case_count, actor_issuer, actor_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.suiteId,
      input.repositoryId,
      current.version + 1,
      suite.draftRevision,
      suite.name,
      suite.description,
      suite.workflowKind,
      suite.target,
      sourceId,
      expectationId,
      sourceDigest,
      expectationDigest,
      suite.caseCount,
      input.actor.issuer,
      input.actor.subject,
      now,
    );
  const update = database
    .prepare(`UPDATE evaluation_suites SET latest_version_id = ?, draft_revision = draft_revision + 1,
    updated_by_issuer = ?, updated_by_subject = ?, updated_at = ? WHERE repository_id = ? AND id = ? AND draft_revision = ?`)
    .run(
      id,
      input.actor.issuer,
      input.actor.subject,
      now,
      input.repositoryId,
      input.suiteId,
      suite.draftRevision,
    );
  if (Number(update.changes) !== 1) conflict();
  return readPublishedEvaluationSuiteInTransaction(
    database,
    { versionId: id, suiteId: input.suiteId, repositoryId: input.repositoryId, actor: input.actor },
    administrators,
  ).version;
}

function mutate(
  database: DatabaseSync,
  request: MutationRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  readOnly: boolean,
): MutationOutput {
  const digest = intentDigest(request),
    previous = replay(database, request, digest);
  if (previous !== null) return previous;
  if (readOnly)
    throw new EvaluationManagementError(
      "DATABASE_READ_ONLY",
      "New evaluation changes are unavailable during recovery maintenance.",
    );
  let result: MutationOutput, entityId: string, version: number;
  switch (request.operation) {
    case "captureEvaluationSource":
      result = captureSource(database, request.input, now, administrators);
      entityId = result.id;
      version = 0;
      break;
    case "createEvaluationSuite":
      result = createSuite(database, request.input, now);
      entityId = result.id;
      version = 0;
      break;
    case "saveEvaluationSuiteDraft":
      result = saveDraft(database, request.input, now);
      entityId = request.input.suiteId;
      version = request.input.request.expectedRevision;
      break;
    case "publishEvaluationSuite":
      result = publishSuite(database, request.input, now, administrators);
      entityId = request.input.suiteId;
      version = request.input.request.expectedRevision;
      break;
  }
  writeReceipt(database, request, digest, entityId, version, result, now);
  return result;
}
function pagination(query: C.EvaluationSuiteListQuery | C.EvaluationSourceListQuery): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = query.page ?? 1,
    pageSize = query.pageSize ?? 20,
    offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) invalid();
  return { page, pageSize, offset };
}
function listSources(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["listEvaluationSources"]["input"],
): C.EvaluationSourceListResponse {
  const { page, pageSize, offset } = pagination(input.query);
  const total = (
    database
      .prepare("SELECT COUNT(*) AS total FROM evaluation_sources WHERE repository_id = ?")
      .get(input.repositoryId) as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT ${sourceColumns} FROM evaluation_sources WHERE repository_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(input.repositoryId, pageSize, offset) as unknown as SourceRow[];
  return stored(
    { repositoryId: input.repositoryId, total, page, pageSize, items: rows.map(sourceSummary) },
    C.getEvaluationSourceListResponseIssues,
  );
}
function listSuites(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["listEvaluationSuites"]["input"],
): C.EvaluationSuiteListResponse {
  const { page, pageSize, offset } = pagination(input.query);
  const total = (
    database
      .prepare("SELECT COUNT(*) AS total FROM evaluation_suites WHERE repository_id = ?")
      .get(input.repositoryId) as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT ${suiteColumns} FROM evaluation_suites WHERE repository_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(input.repositoryId, pageSize, offset) as unknown as SuiteRow[];
  return stored(
    { repositoryId: input.repositoryId, total, page, pageSize, items: rows.map(suiteSummary) },
    C.getEvaluationSuiteListResponseIssues,
  );
}
function listVersions(
  database: DatabaseSync,
  input: EvaluationManagementOperationMap["listEvaluationSuiteVersions"]["input"],
): C.EvaluationSuiteVersionListResponse {
  if (
    !database
      .prepare("SELECT 1 FROM evaluation_suites WHERE repository_id = ? AND id = ?")
      .get(input.repositoryId, input.suiteId)
  )
    missing();
  const { page, pageSize, offset } = pagination(input.query);
  const total = (
    database
      .prepare(
        "SELECT COUNT(*) AS total FROM evaluation_suite_versions WHERE repository_id = ? AND suite_id = ?",
      )
      .get(input.repositoryId, input.suiteId) as { total: number }
  ).total;
  const rows = database
    .prepare(
      `SELECT ${versionColumns} FROM evaluation_suite_versions WHERE repository_id = ? AND suite_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
    )
    .all(input.repositoryId, input.suiteId, pageSize, offset) as unknown as VersionRow[];
  return stored(
    {
      repositoryId: input.repositoryId,
      suiteId: input.suiteId,
      total,
      page,
      pageSize,
      items: rows.map(versionSummary),
    },
    C.getEvaluationSuiteVersionListResponseIssues,
  );
}

function frozenCaseScope(version: C.EvaluationSuiteVersionV1) {
  return {
    repositoryId: version.repositoryId,
    suiteId: version.suiteId,
    versionId: version.id,
    sourceVersionId: version.sourceVersionId,
    expectationVersionId: version.expectationVersionId,
    sourceManifestSha256: version.sourceManifestSha256,
    expectationManifestSha256: version.expectationManifestSha256,
  };
}

function listCases(
  database: DatabaseSync,
  input: VersionScope,
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationSuiteCaseListV1 {
  const published = readPublishedEvaluationSuiteInTransaction(database, input, administrators);
  const { version, sourceManifest, expectationManifest } = published;
  const items = expectationManifest.cases.map((entry, index): C.EvaluationSuiteCaseSummaryV1 => {
    const source = sourceManifest.cases[index];
    if (!source || source.caseId !== entry.caseId) corrupt();
    return stored(
      {
        schemaVersion: "EvaluationSuiteCaseSummaryV1" as const,
        repositoryId: input.repositoryId,
        suiteId: input.suiteId,
        versionId: input.versionId,
        caseId: entry.caseId,
        title: entry.title,
        sourceId: source.sourceId,
        sourceDigest: source.sourceDigest,
        applicability: entry.applicability,
        criterionCount: entry.criteria.length,
        annotation: entry.findings.annotation,
        expectedFindingCount: entry.findings.expected.length,
      },
      C.getEvaluationSuiteCaseSummaryIssues,
    );
  });
  return stored(
    {
      schemaVersion: "EvaluationSuiteCaseListV1" as const,
      ...frozenCaseScope(version),
      total: version.caseCount,
      items,
    },
    C.getEvaluationSuiteCaseListIssues,
  );
}

function readCase(
  database: DatabaseSync,
  input: VersionScope & { readonly caseId: string },
  administrators: readonly C.OperatorPrincipal[],
): C.EvaluationSuiteCaseDetailV1 {
  const { caseId, ...versionScope } = input;
  const published = readPublishedEvaluationSuiteInTransaction(
    database,
    versionScope,
    administrators,
  );
  const expectation = published.expectationManifest.cases.find((entry) => entry.caseId === caseId);
  const reference = published.sourceManifest.cases.find((entry) => entry.caseId === caseId);
  if (!expectation || !reference) missing();
  const { snapshot: _snapshot, ...source } = readSource(
    database,
    input.repositoryId,
    reference.sourceId,
  );
  if (source.sourceDigest !== reference.sourceDigest) corrupt();
  return stored(
    {
      schemaVersion: "EvaluationSuiteCaseDetailV1" as const,
      ...frozenCaseScope(published.version),
      caseId,
      source,
      expectation,
    },
    C.getEvaluationSuiteCaseDetailIssues,
  );
}

/** Permission, replay, CAS, persistence and the receipt share one synchronous transaction. */
export function handleEvaluationManagementRequest(
  database: DatabaseSync,
  request: EvaluationManagementRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): EvaluationManagementOperationMap[EvaluationManagementOperation]["output"] {
  validateRequest(request);
  assertTimestamp(now);
  const mutation = mutations.has(request.operation);
  const readOnly =
    options.readOnly === true ||
    ("replayOnly" in request.input && request.input.replayOnly === true);
  return transaction(database, mutation && !readOnly, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      request.input.repositoryId,
      mutation ? "configure" : "read",
      administrators,
    );
    if (mutation)
      return mutate(database, request as MutationRequest, now, administrators, readOnly);
    switch (request.operation) {
      case "getEvaluationSource":
        return readSource(database, request.input.repositoryId, request.input.sourceId);
      case "listEvaluationSources":
        return listSources(database, request.input);
      case "getEvaluationSuite":
        return readSuite(database, request.input);
      case "listEvaluationSuites":
        return listSuites(database, request.input);
      case "listEvaluationSuiteVersions":
        return listVersions(database, request.input);
      case "getEvaluationSuiteVersion":
        return readPublishedEvaluationSuiteInTransaction(database, request.input, administrators)
          .version;
      case "listEvaluationSuiteCases":
        return listCases(database, request.input, administrators);
      case "getEvaluationSuiteCase":
        return readCase(database, request.input, administrators);
      default:
        invalid();
    }
  });
}
