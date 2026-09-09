import type { DatabaseSync } from "node:sqlite";
import {
  assertEvaluationReviewRunPlan,
  assertReviewRunExecutionPlan,
  EntityIdSchema,
  type EvaluationSourceReferenceV1,
  EvaluationSourceReferenceV1Schema,
  type EvaluationSourceSnapshotV1,
  GitHubRepositorySchema,
  GitHubWorkItemRevisionSchema,
  GitHubWorkItemSchema,
  getEvaluationSourceSnapshotIssues,
  maximumEvaluationSourceSnapshotUtf8Bytes,
  maximumReviewRunPlanUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type ReviewRunExecutionPlanV1,
  type ReviewRunExecutionPlanV2,
} from "@agentic-review/contracts";
import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { assertRepositoryPermission } from "./operator-access.js";

export interface CaptureEvaluationSourceInput {
  readonly repositoryId: string;
  readonly actor: OperatorPrincipal;
  readonly source: EvaluationSourceReferenceV1;
}

const inputSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    actor: OperatorPrincipalSchema,
    source: EvaluationSourceReferenceV1Schema,
  },
  { additionalProperties: false },
);

export class EvaluationSourceError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "EvaluationSourceError";
  }
}

function invalid(message: string): never {
  throw new EvaluationSourceError("PLATFORM_INVALID", message);
}
function corrupt(message: string): never {
  throw new EvaluationSourceError("PLATFORM_CORRUPT", message);
}
function conflict(message: string): never {
  throw new EvaluationSourceError("PLATFORM_CONFLICT", message);
}
function notFound(): never {
  throw new EvaluationSourceError("PLATFORM_NOT_FOUND", "The evaluation source was not found.");
}
function limit(): never {
  invalid("The evaluation source exceeds the aggregate UTF-8 byte limit of 2 MiB.");
}

type SourceContent = Pick<
  EvaluationSourceSnapshotV1,
  "repository" | "workItemId" | "workItem" | "revision" | "testedSourceRevision" | "revisionId"
>;

/** Provenance, capture time, freshness, and the claimed digest do not define source identity. */
export function recomputeEvaluationSourceDigest(source: SourceContent): string {
  return sha256(
    canonicalJson({
      repository: source.repository,
      workItemId: source.workItemId,
      workItem: source.workItem,
      revision: source.revision,
      testedSourceRevision: source.testedSourceRevision,
      revisionId: source.revisionId,
    }),
  );
}

function assertRevisionContent(source: SourceContent): void {
  const { revision, workItem } = source;
  const digest =
    revision.kind === "pull_request"
      ? sha256(`${revision.baseSha}\0${revision.headSha}`)
      : sha256(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  if (
    revision.revisionKey !== digest ||
    (revision.kind === "issue" && revision.contentDigest !== digest)
  )
    corrupt("The stored source revision does not match its exact commits or Issue content.");
}

/** Checks frozen content on persistence/readback; this does not grant permission to execute it. */
export function assertEvaluationSourceSnapshotIntegrity(
  value: unknown,
): asserts value is EvaluationSourceSnapshotV1 {
  const issues = getEvaluationSourceSnapshotIssues(value);
  if (issues.length > 0) corrupt(issues[0] ?? "The stored evaluation source is invalid.");
  const source = value as EvaluationSourceSnapshotV1;
  assertRevisionContent(source);
  if (recomputeEvaluationSourceDigest(source) !== source.sourceDigest)
    corrupt("The stored evaluation source digest does not match its frozen content.");
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    corrupt("The persisted evaluation source contains invalid JSON.");
  }
}

function freeze(
  content: SourceContent,
  provenance: EvaluationSourceSnapshotV1["provenance"],
): EvaluationSourceSnapshotV1 {
  const source: EvaluationSourceSnapshotV1 = {
    schemaVersion: "EvaluationSourceSnapshotV1",
    ...content,
    freshness: "frozen",
    sourceDigest: recomputeEvaluationSourceDigest(content),
    provenance,
  };
  if (Buffer.byteLength(canonicalJson(source), "utf8") > maximumEvaluationSourceSnapshotUtf8Bytes)
    limit();
  assertEvaluationSourceSnapshotIntegrity(source);
  return source;
}

interface RevisionRow {
  revision_id: string;
  revision_work_item_id: string;
  revision_key: string;
  revision_kind: string;
  base_sha: string | null;
  head_sha: string | null;
  content_digest: string | null;
  revision_json: string;
}

function persistedRevision(row: RevisionRow): EvaluationSourceSnapshotV1["revision"] {
  const revision = parseJson(row.revision_json);
  if (!Value.Check(GitHubWorkItemRevisionSchema, revision))
    corrupt("The persisted source revision is invalid.");
  if (
    !Value.Check(EntityIdSchema, row.revision_id) ||
    revision.kind !== row.revision_kind ||
    revision.revisionKey !== row.revision_key ||
    (revision.kind === "pull_request"
      ? revision.baseSha !== row.base_sha ||
        revision.headSha !== row.head_sha ||
        row.content_digest !== null
      : revision.contentDigest !== row.content_digest ||
        row.base_sha !== null ||
        row.head_sha !== null)
  )
    corrupt("The persisted source revision columns have inconsistent identities.");
  // Observation timestamps can advance while the immutable revision remains the same.
  const { observedAt: _observedAt, sourceUpdatedAt: _sourceUpdatedAt, ...frozen } = revision;
  return frozen;
}

interface CurrentRow extends RevisionRow {
  managed_github_repository_id: number;
  managed_full_name: string;
  configuration_version: number;
  github_repository_id: number;
  repository_node_id: string;
  owner_login: string;
  repository_name: string;
  repository_full_name: string;
  repository_html_url: string;
  default_branch: string;
  is_private: number;
  repository_json: string;
  work_item_id: string;
  item_repository_id: string;
  github_work_item_id: number;
  github_node_id: string;
  github_number: number;
  item_kind: string;
  state: string;
  title: string;
  body: string | null;
  html_url: string;
  author_github_user_id: number;
  author_login: string;
  author_account_type: string;
  is_draft: number | null;
  source_created_at: string;
  source_updated_at: string;
  source_closed_at: string | null;
  current_revision_key: string;
  work_item_json: string;
}

function currentSource(
  database: DatabaseSync,
  repositoryId: string,
  reference: Extract<EvaluationSourceReferenceV1, { kind: "current_work_item" }>,
  now: string,
): EvaluationSourceSnapshotV1 {
  // Read only lengths before fetching potentially large JSON or body columns into the owner.
  const lengths = database
    .prepare(`SELECT item.current_revision_key,
      length(CAST(item.snapshot_json AS BLOB)) AS item_bytes,
      length(CAST(item.body AS BLOB)) AS body_bytes,
      length(CAST(repository.snapshot_json AS BLOB)) AS repository_bytes,
      length(CAST(revision.revision_json AS BLOB)) AS revision_bytes
      FROM work_items AS item
      LEFT JOIN repositories AS repository ON repository.id = item.repository_id
      LEFT JOIN work_item_revisions AS revision ON revision.work_item_id = item.id
        AND revision.revision_key = item.current_revision_key
      WHERE item.repository_id = ? AND item.id = ?`)
    .get(repositoryId, reference.workItemId) as
    | {
        current_revision_key: string;
        item_bytes: number;
        body_bytes: number | null;
        repository_bytes: number | null;
        revision_bytes: number | null;
      }
    | undefined;
  if (!lengths) notFound();
  if (lengths.current_revision_key !== reference.expectedRevisionKey)
    conflict("The work item revision changed. Capture its current revision again.");
  if (lengths.repository_bytes === null || lengths.revision_bytes === null)
    corrupt("The persisted work item has no matching repository or current revision.");
  if (
    [
      lengths.item_bytes,
      lengths.body_bytes ?? 0,
      lengths.repository_bytes,
      lengths.revision_bytes,
    ].some((bytes) => bytes > maximumEvaluationSourceSnapshotUtf8Bytes)
  )
    limit();
  const row = database
    .prepare(`SELECT managed.github_repository_id AS managed_github_repository_id,
      managed.full_name AS managed_full_name, managed.version AS configuration_version,
      repository.github_repository_id, repository.github_node_id AS repository_node_id,
      repository.owner_login, repository.name AS repository_name,
      repository.full_name AS repository_full_name, repository.html_url AS repository_html_url,
      repository.default_branch, repository.is_private, repository.snapshot_json AS repository_json,
      item.id AS work_item_id, item.repository_id AS item_repository_id,
      item.github_work_item_id, item.github_node_id, item.github_number,
      item.resource_kind AS item_kind, item.state, item.title, item.body, item.html_url,
      item.author_github_user_id, item.author_login, item.author_account_type, item.is_draft,
      item.source_created_at, item.source_updated_at, item.source_closed_at,
      item.current_revision_key, item.snapshot_json AS work_item_json,
      revision.id AS revision_id, revision.work_item_id AS revision_work_item_id,
      revision.revision_key, revision.resource_kind AS revision_kind,
      revision.base_sha, revision.head_sha, revision.content_digest, revision.revision_json
      FROM work_items AS item
      JOIN repositories AS repository ON repository.id = item.repository_id
      JOIN managed_repositories AS managed ON managed.id = repository.id
      JOIN work_item_revisions AS revision ON revision.work_item_id = item.id
        AND revision.revision_key = item.current_revision_key
      WHERE item.repository_id = ? AND item.id = ?`)
    .get(repositoryId, reference.workItemId) as unknown as CurrentRow | undefined;
  if (!row) corrupt("The persisted evaluation source relations are inconsistent.");
  const repository = parseJson(row.repository_json);
  const workItem = parseJson(row.work_item_json);
  if (
    !Value.Check(GitHubRepositorySchema, repository) ||
    !Value.Check(GitHubWorkItemSchema, workItem)
  )
    corrupt("The persisted repository or work item snapshot is invalid.");
  if (
    repository.githubRepositoryId !== row.github_repository_id ||
    repository.githubRepositoryId !== row.managed_github_repository_id ||
    repository.githubNodeId !== row.repository_node_id ||
    repository.ownerLogin !== row.owner_login ||
    repository.name !== row.repository_name ||
    repository.fullName !== row.repository_full_name ||
    repository.fullName !== row.managed_full_name ||
    repository.fullName !== `${repository.ownerLogin}/${repository.name}` ||
    repository.htmlUrl !== row.repository_html_url ||
    repository.defaultBranch !== row.default_branch ||
    Number(repository.isPrivate) !== row.is_private
  )
    corrupt("The persisted repository metadata columns have inconsistent identities.");
  if (
    row.work_item_id !== reference.workItemId ||
    row.item_repository_id !== repositoryId ||
    row.revision_work_item_id !== reference.workItemId ||
    workItem.githubWorkItemId !== row.github_work_item_id ||
    workItem.githubNodeId !== row.github_node_id ||
    workItem.number !== row.github_number ||
    workItem.kind !== row.item_kind ||
    workItem.state !== row.state ||
    workItem.title !== row.title ||
    workItem.body !== row.body ||
    workItem.htmlUrl !== row.html_url ||
    workItem.author.githubUserId !== row.author_github_user_id ||
    workItem.author.login !== row.author_login ||
    (workItem.author.accountType ?? "user") !== row.author_account_type ||
    (workItem.kind === "pull_request" ? Number(workItem.isDraft) : null) !== row.is_draft ||
    new Date(workItem.createdAt).toISOString() !== row.source_created_at ||
    new Date(workItem.updatedAt).toISOString() !== row.source_updated_at ||
    (workItem.closedAt === null ? null : new Date(workItem.closedAt).toISOString()) !==
      row.source_closed_at
  )
    corrupt("The persisted work item columns do not match its complete snapshot.");
  const revision = persistedRevision(row);
  if (revision.revisionKey !== reference.expectedRevisionKey)
    corrupt("The persisted current revision has an inconsistent revision key.");
  if (workItem.kind === "pull_request" && reference.testedIssueCommit !== null)
    invalid("A PR source uses its stored base and head; testedIssueCommit must be null.");
  return freeze(
    {
      repository: {
        id: repositoryId,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        configurationVersion: row.configuration_version,
      },
      workItemId: reference.workItemId,
      workItem,
      revision,
      revisionId: row.revision_id,
      testedSourceRevision:
        revision.kind === "pull_request"
          ? { kind: "pull_request", baseSha: revision.baseSha, headSha: revision.headSha }
          : reference.testedIssueCommit === null
            ? null
            : { kind: "commit", headSha: reference.testedIssueCommit },
    },
    {
      kind: "current_work_item",
      capturedAt: now,
      expectedRevisionKey: reference.expectedRevisionKey,
    },
  );
}

interface HistoricalRow extends RevisionRow {
  repository_id: string;
  work_item_id: string;
  run_revision_id: string;
  run_revision_key: string;
  request_epoch_id: string | null;
  activation_id: string;
  plan_digest: string;
  plan_json: string;
  github_repository_id: number;
  managed_github_repository_id: number;
  item_repository_id: string;
  github_work_item_id: number;
  github_node_id: string;
  github_number: number;
  item_kind: string;
}

function historicalSource(
  database: DatabaseSync,
  repositoryId: string,
  reference: Extract<EvaluationSourceReferenceV1, { kind: "review_run" }>,
  now: string,
): EvaluationSourceSnapshotV1 {
  const lengths = database
    .prepare(`SELECT plan_digest, length(CAST(plan_json AS BLOB)) AS plan_bytes,
      CASE WHEN json_valid(plan_json) THEN
        length(CAST(json_extract(plan_json, '$.workItem') AS BLOB)) ELSE 0 END AS item_bytes
      FROM review_runs WHERE repository_id = ? AND id = ?`)
    .get(repositoryId, reference.reviewRunId) as
    | { plan_digest: string; plan_bytes: number; item_bytes: number | null }
    | undefined;
  if (!lengths) notFound();
  if (lengths.plan_digest !== reference.expectedPlanDigest)
    conflict("The historical review run does not match the expected plan digest.");
  if (lengths.plan_bytes > maximumReviewRunPlanUtf8Bytes)
    corrupt("The persisted review run plan exceeds its aggregate UTF-8 byte limit.");
  if ((lengths.item_bytes ?? 0) > maximumEvaluationSourceSnapshotUtf8Bytes) limit();
  // Identity joins deliberately omit today's body, current revision, configuration, and epoch state.
  const row = database
    .prepare(`SELECT run.repository_id, run.work_item_id, run.revision_id AS run_revision_id,
      run.revision_key AS run_revision_key, run.request_epoch_id, run.activation_id,
      run.plan_digest, run.plan_json, repository.github_repository_id,
      managed.github_repository_id AS managed_github_repository_id,
      item.repository_id AS item_repository_id, item.github_work_item_id,
      item.github_node_id, item.github_number, item.resource_kind AS item_kind,
      revision.id AS revision_id, revision.work_item_id AS revision_work_item_id,
      revision.revision_key, revision.resource_kind AS revision_kind,
      revision.base_sha, revision.head_sha, revision.content_digest,
      CASE WHEN length(CAST(revision.revision_json AS BLOB)) <= ?
        THEN revision.revision_json ELSE NULL END AS revision_json
      FROM review_runs AS run
      LEFT JOIN managed_repositories AS managed ON managed.id = run.repository_id
      LEFT JOIN repositories AS repository ON repository.id = run.repository_id
      LEFT JOIN work_items AS item ON item.id = run.work_item_id
      LEFT JOIN work_item_revisions AS revision ON revision.id = run.revision_id
      WHERE run.repository_id = ? AND run.id = ?`)
    .get(
      maximumEvaluationSourceSnapshotUtf8Bytes,
      repositoryId,
      reference.reviewRunId,
    ) as unknown as HistoricalRow | undefined;
  if (!row) notFound();
  const parsed = parseJson(row.plan_json);
  let plan: ReviewRunExecutionPlanV1 | ReviewRunExecutionPlanV2;
  try {
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "schemaVersion" in parsed &&
      parsed.schemaVersion === "ReviewRunExecutionPlanV2"
    ) {
      assertEvaluationReviewRunPlan(parsed);
      plan = parsed;
    } else {
      assertReviewRunExecutionPlan(parsed);
      plan = parsed;
    }
  } catch {
    corrupt("The persisted review run plan does not satisfy its strict versioned contract.");
  }
  if (sha256(canonicalJson(plan)) !== row.plan_digest)
    corrupt("The persisted review run plan digest does not match its frozen content.");
  if (
    plan.repository.id !== repositoryId ||
    row.repository_id !== repositoryId ||
    row.item_repository_id !== repositoryId ||
    plan.repository.githubRepositoryId !== row.github_repository_id ||
    plan.repository.githubRepositoryId !== row.managed_github_repository_id ||
    plan.workItemId !== row.work_item_id ||
    plan.workItem.githubWorkItemId !== row.github_work_item_id ||
    plan.workItem.githubNodeId !== row.github_node_id ||
    plan.workItem.number !== row.github_number ||
    plan.workItem.kind !== row.item_kind ||
    plan.activationId !== row.activation_id ||
    row.run_revision_id !== row.revision_id ||
    row.revision_work_item_id !== row.work_item_id ||
    plan.revision.revisionKey !== row.run_revision_key ||
    row.revision_json === null ||
    canonicalJson(plan.revision) !== canonicalJson(persistedRevision(row)) ||
    (plan.schemaVersion === "ReviewRunExecutionPlanV1"
      ? plan.authorization.requestEpochId !== row.request_epoch_id
      : row.request_epoch_id !== null || plan.source.revisionId !== row.revision_id)
  )
    corrupt(
      "The persisted review run source has inconsistent repository, item, or revision links.",
    );
  if (plan.schemaVersion === "ReviewRunExecutionPlanV2")
    assertEvaluationSourceSnapshotIntegrity(plan.source);
  return freeze(
    {
      repository: plan.repository,
      workItemId: plan.workItemId,
      workItem: plan.workItem,
      revision: plan.revision,
      revisionId: row.revision_id,
      testedSourceRevision: plan.testedSourceRevision,
    },
    {
      kind: "review_run",
      capturedAt: now,
      reviewRunId: reference.reviewRunId,
      planDigest: row.plan_digest,
      requestEpochId: row.request_epoch_id,
    },
  );
}

/** Owner-internal source capture. The caller owns the transaction and any subsequent persistence. */
export function captureEvaluationSourceInTransaction(
  database: DatabaseSync,
  input: CaptureEvaluationSourceInput,
  now: string,
  administrators: readonly OperatorPrincipal[],
): EvaluationSourceSnapshotV1 {
  if (!Value.Check(inputSchema, input)) invalid("The evaluation source reference is invalid.");
  if (
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid("A canonical evaluation source capture timestamp is required.");
  if (!database.isTransaction)
    invalid("Evaluation source capture requires an existing transaction.");
  // Recheck current authority before accessing any requested source or returning a replay receipt.
  assertRepositoryPermission(
    database,
    input.actor,
    input.repositoryId,
    "configure",
    administrators,
  );
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
  return input.source.kind === "current_work_item"
    ? currentSource(database, input.repositoryId, input.source, now)
    : historicalSource(database, input.repositoryId, input.source, now);
}
