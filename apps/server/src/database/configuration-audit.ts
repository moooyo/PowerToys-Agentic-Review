import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type ConfigurationAuditEvent,
  ConfigurationAuditEventSchema,
  type ConfigurationAuditSummary,
  ConfigurationAuditSummarySchema,
  EntityIdSchema,
  type GlobalConfigurationAuditListQuery,
  GlobalConfigurationAuditListQuerySchema,
  type GlobalConfigurationAuditListResponse,
  GlobalConfigurationAuditListResponseSchema,
  type GlobalConfigurationAuditReadQuery,
  GlobalConfigurationAuditReadQuerySchema,
  maximumConfigurationAuditPageSize,
  maximumConfigurationAuditResponseUtf8Bytes,
  maximumConfigurationAuditSnapshotUtf8Bytes,
  maximumPromptConfigurationAuditSnapshotUtf8Bytes,
  PositiveIntegerSchema,
  PromptConfigurationAuditSnapshots,
  type RepositoryConfigurationAuditListQuery,
  RepositoryConfigurationAuditListQuerySchema,
  type RepositoryConfigurationAuditListResponse,
  RepositoryConfigurationAuditListResponseSchema,
  type RepositoryConfigurationAuditReadQuery,
  RepositoryConfigurationAuditReadQuerySchema,
  type RepositoryConfigurationSnapshot,
  RepositoryConfigurationSnapshotSchema,
  type WorkflowKind,
  WorkflowKindSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  assertPlatformAdministrator,
  assertRepositoryPermission,
  type OperatorReadContext,
} from "./operator-access.js";

type AuditSource = "repository" | "prompt";
type PromptAction = keyof typeof PromptConfigurationAuditSnapshots;
interface PageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}
interface AuditPage {
  readonly items: ConfigurationAuditSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
export interface ConfigurationAuditOperationMap {
  listRepositoryConfigurationAudit: {
    input: RepositoryConfigurationAuditListQuery;
    output: RepositoryConfigurationAuditListResponse;
  };
  listGlobalConfigurationAudit: {
    input: GlobalConfigurationAuditListQuery;
    output: GlobalConfigurationAuditListResponse;
  };
  getRepositoryConfigurationAudit: {
    input: RepositoryConfigurationAuditReadQuery;
    output: ConfigurationAuditEvent | null;
  };
  getGlobalConfigurationAudit: {
    input: GlobalConfigurationAuditReadQuery;
    output: ConfigurationAuditEvent | null;
  };
}
export type ConfigurationAuditOperation = keyof ConfigurationAuditOperationMap;
export type ConfigurationAuditRequest = {
  [K in ConfigurationAuditOperation]: {
    readonly operation: K;
    readonly input: ConfigurationAuditOperationMap[K]["input"];
  };
}[ConfigurationAuditOperation];

const inputSchemas = {
  listRepositoryConfigurationAudit: RepositoryConfigurationAuditListQuerySchema,
  listGlobalConfigurationAudit: GlobalConfigurationAuditListQuerySchema,
  getRepositoryConfigurationAudit: RepositoryConfigurationAuditReadQuerySchema,
  getGlobalConfigurationAudit: GlobalConfigurationAuditReadQuerySchema,
};
export function isConfigurationAuditOperation(value: string): value is ConfigurationAuditOperation {
  return Object.hasOwn(inputSchemas, value);
}

export class ConfigurationAuditError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_NOT_FOUND" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "ConfigurationAuditError";
  }
}
function invalid(): never {
  throw new ConfigurationAuditError(
    "PLATFORM_INVALID",
    "The configuration audit query is invalid.",
  );
}
function notFound(): never {
  throw new ConfigurationAuditError("PLATFORM_NOT_FOUND", "The requested resource was not found.");
}
function corrupt(): never {
  throw new ConfigurationAuditError(
    "PLATFORM_CORRUPT",
    "The stored configuration audit is invalid.",
  );
}
function check(schema: TSchema, value: unknown): void {
  if (!Value.Check(schema, value)) corrupt();
}
function canonicalInstant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    corrupt();
}
function actorPart(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !value.isWellFormed() ||
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    corrupt();
}
function recordedAuthor(value: unknown): void {
  if (typeof value !== "string" || value.length > 16_384) corrupt();
  let actor: unknown;
  try {
    actor = JSON.parse(value);
  } catch {
    corrupt();
  }
  if (!Array.isArray(actor) || actor.length !== 2) corrupt();
  actorPart(actor[0], 2048);
  actorPart(actor[1], 512);
  if (JSON.stringify(actor) !== value) corrupt();
}
function safeStrings(value: unknown): void {
  if (typeof value === "string") {
    if (!value.isWellFormed() || value.includes("\0")) corrupt();
  } else if (Array.isArray(value)) {
    for (const entry of value) safeStrings(entry);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) safeStrings(entry);
  }
}
function readTransaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec("BEGIN");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function bounded<T>(schema: TSchema, response: T): T {
  check(schema, response);
  if (
    Buffer.byteLength(JSON.stringify(response), "utf8") > maximumConfigurationAuditResponseUtf8Bytes
  )
    corrupt();
  return response;
}

interface AuditRow {
  readonly id: string;
  readonly source: AuditSource;
  readonly action: string;
  readonly entity_id: string;
  readonly repository_id: string | null;
  readonly actor_issuer: string;
  readonly actor_subject: string;
  readonly version: number | null;
  readonly created_at: string;
  readonly payload_json: string | null;
}
function repositorySelection(includeSnapshot: boolean): string {
  return `SELECT id, 'repository' AS source, action, repository_id AS entity_id,
    repository_id, actor_issuer, actor_subject,
    CASE WHEN version BETWEEN 1 AND 9007199254740991 THEN version ELSE NULL END AS version, created_at,
    ${
      includeSnapshot
        ? `CASE WHEN length(CAST(configuration_json AS BLOB)) <= ${maximumConfigurationAuditSnapshotUtf8Bytes}
      THEN configuration_json ELSE NULL END`
        : "NULL"
    } AS payload_json
    FROM repository_configuration_audit`;
}
const promptSelection = `SELECT id, 'prompt' AS source, action, entity_id, repository_id,
  actor_issuer, actor_subject, NULL AS version, created_at,
  CASE WHEN length(CAST(detail_json AS BLOB)) <= ${maximumPromptConfigurationAuditSnapshotUtf8Bytes}
    THEN detail_json ELSE NULL END AS payload_json
  FROM prompt_configuration_audit`;
const nullableEntityId = Type.Union([EntityIdSchema, Type.Null()]);
const payloadSchemas = PromptConfigurationAuditSnapshots;

interface PromptVersionIdentity {
  readonly id: string;
  readonly template_id: string;
  readonly version: number;
  readonly source_draft_revision: number;
  readonly workflow_kind: WorkflowKind;
  readonly created_at: string;
  readonly published_at: string;
  readonly created_by: string;
}
function promptVersion(database: DatabaseSync, id: unknown): PromptVersionIdentity {
  check(EntityIdSchema, id);
  const row = database
    .prepare(`SELECT version.id, version.template_id,
      CASE WHEN version.version BETWEEN 1 AND 9007199254740991 THEN version.version ELSE NULL END AS version,
      CASE WHEN version.source_draft_revision BETWEEN 1 AND 9007199254740991
        THEN version.source_draft_revision ELSE NULL END AS source_draft_revision,
      template.workflow_kind, version.created_at,
      version.published_at, version.created_by
    FROM prompt_versions AS version JOIN prompt_templates AS template ON template.id = version.template_id
    WHERE version.id = ?`)
    .get(id as string) as unknown as PromptVersionIdentity | undefined;
  if (!row) corrupt();
  check(EntityIdSchema, row.id);
  check(EntityIdSchema, row.template_id);
  check(PositiveIntegerSchema, row.version);
  check(PositiveIntegerSchema, row.source_draft_revision);
  check(WorkflowKindSchema, row.workflow_kind);
  canonicalInstant(row.created_at);
  canonicalInstant(row.published_at);
  recordedAuthor(row.created_by);
  if (row.created_at !== row.published_at) corrupt();
  return row;
}
function templateWorkflow(database: DatabaseSync, id: string): WorkflowKind {
  const row = database.prepare("SELECT workflow_kind FROM prompt_templates WHERE id = ?").get(id) as
    | { workflow_kind: WorkflowKind }
    | undefined;
  if (!row) corrupt();
  check(WorkflowKindSchema, row.workflow_kind);
  return row.workflow_kind;
}
function exactAuthor(row: AuditRow, createdAt: unknown, createdBy: unknown): void {
  if (
    createdAt !== row.created_at ||
    createdBy !== JSON.stringify([row.actor_issuer, row.actor_subject])
  )
    corrupt();
}
interface ProfileVersionIdentity {
  readonly id: string;
  readonly profile_id: string;
  readonly repository_id: string;
  readonly version: number;
  readonly workflow_kind: WorkflowKind;
  readonly created_at: string;
  readonly published_at: string;
  readonly created_by: string;
}
function profileVersion(
  database: DatabaseSync,
  id: unknown,
  repositoryId: string,
  profileId: string,
): ProfileVersionIdentity {
  check(EntityIdSchema, id);
  const row = database
    .prepare(`SELECT version.id, version.profile_id, profile.repository_id,
      CASE WHEN version.version BETWEEN 1 AND 9007199254740991 THEN version.version ELSE NULL END AS version,
      profile.workflow_kind, version.created_at, version.published_at, version.created_by
    FROM validation_profile_versions AS version JOIN validation_profiles AS profile ON profile.id = version.profile_id
    WHERE version.id = ? AND version.profile_id = ? AND profile.repository_id = ?`)
    .get(id as string, profileId, repositoryId) as unknown as ProfileVersionIdentity | undefined;
  if (!row) corrupt();
  check(EntityIdSchema, row.id);
  check(EntityIdSchema, row.profile_id);
  check(EntityIdSchema, row.repository_id);
  check(PositiveIntegerSchema, row.version);
  check(WorkflowKindSchema, row.workflow_kind);
  canonicalInstant(row.created_at);
  canonicalInstant(row.published_at);
  recordedAuthor(row.created_by);
  if (row.created_at !== row.published_at) corrupt();
  return row;
}
function validatePromptReferences(
  database: DatabaseSync,
  row: AuditRow,
  action: PromptAction,
  payload: Record<string, unknown>,
): void {
  switch (action) {
    case "template_created":
      if (
        row.repository_id !== null ||
        templateWorkflow(database, row.entity_id) !== payload.workflowKind
      )
        corrupt();
      return;
    case "draft_saved":
      if (
        row.repository_id !== null ||
        Number(payload.version) < 2 ||
        Number(payload.draftRevision) < 2 ||
        Number(payload.draftRevision) > Number(payload.version)
      )
        corrupt();
      templateWorkflow(database, row.entity_id);
      return;
    case "prompt_published": {
      if (row.repository_id !== null) corrupt();
      const version = promptVersion(database, payload.promptVersionId);
      if (
        version.template_id !== row.entity_id ||
        version.version !== payload.publishedVersion ||
        Number(payload.version) <= version.version ||
        version.published_at !== row.created_at
      )
        corrupt();
      exactAuthor(row, version.created_at, version.created_by);
      return;
    }
    case "prompt_bound": {
      const history = database
        .prepare(`SELECT scope_key, repository_id, workflow_kind, prompt_version_id,
          previous_version_id,
          CASE WHEN version BETWEEN 1 AND 9007199254740991 THEN version ELSE NULL END AS version,
          created_at, created_by FROM prompt_binding_history
        WHERE id = ? AND repository_id IS ?`)
        .get(row.entity_id, row.repository_id) as
        | {
            scope_key: string;
            repository_id: string | null;
            workflow_kind: string;
            prompt_version_id: string;
            previous_version_id: string | null;
            version: number;
            created_at: string;
            created_by: string;
          }
        | undefined;
      if (
        !history ||
        history.scope_key !==
          (row.repository_id === null ? "global" : `repository:${row.repository_id}`) ||
        history.workflow_kind !== payload.workflowKind ||
        history.prompt_version_id !== payload.promptVersionId ||
        history.previous_version_id !== payload.previousVersionId ||
        history.version !== payload.version ||
        (history.version === 1) !== (history.previous_version_id === null)
      )
        corrupt();
      exactAuthor(row, history.created_at, history.created_by);
      if (promptVersion(database, payload.promptVersionId).workflow_kind !== payload.workflowKind)
        corrupt();
      if (
        payload.previousVersionId !== null &&
        promptVersion(database, payload.previousVersionId).workflow_kind !== payload.workflowKind
      )
        corrupt();
      return;
    }
    case "profile_published": {
      if (row.repository_id === null) corrupt();
      const version = profileVersion(
        database,
        payload.profileVersionId,
        row.repository_id,
        row.entity_id,
      );
      if (version.version !== payload.version || version.published_at !== row.created_at) corrupt();
      exactAuthor(row, version.created_at, version.created_by);
      return;
    }
    case "profile_bound": {
      if (row.repository_id === null) corrupt();
      const history = database
        .prepare(`SELECT profile_id, profile_version_id, previous_version_id,
          CASE WHEN enabled IN (0, 1) THEN enabled ELSE NULL END AS enabled,
          CASE WHEN version BETWEEN 1 AND 9007199254740991 THEN version ELSE NULL END AS version,
          created_at, created_by FROM validation_profile_binding_history
        WHERE id = ? AND repository_id = ?`)
        .get(row.entity_id, row.repository_id) as
        | {
            profile_id: string;
            profile_version_id: string;
            previous_version_id: string | null;
            enabled: number;
            version: number;
            created_at: string;
            created_by: string;
          }
        | undefined;
      if (
        !history ||
        history.profile_id !== payload.profileId ||
        history.profile_version_id !== payload.profileVersionId ||
        history.previous_version_id !== payload.previousVersionId ||
        history.enabled !== (payload.enabled ? 1 : 0) ||
        history.version !== payload.version ||
        (history.version === 1) !== (history.previous_version_id === null)
      )
        corrupt();
      exactAuthor(row, history.created_at, history.created_by);
      profileVersion(database, payload.profileVersionId, row.repository_id, history.profile_id);
      if (payload.previousVersionId !== null)
        profileVersion(database, payload.previousVersionId, row.repository_id, history.profile_id);
      return;
    }
    case "bootstrap_registered": {
      if (row.repository_id !== null) corrupt();
      check(WorkflowKindSchema, row.entity_id);
      const version = promptVersion(database, payload.promptVersionId);
      const marker = database
        .prepare(
          "SELECT prompt_version_id, created_at FROM prompt_configuration_bootstrap WHERE workflow_kind = ?",
        )
        .get(row.entity_id) as { prompt_version_id: string; created_at: string } | undefined;
      if (
        !marker ||
        version.workflow_kind !== row.entity_id ||
        marker.prompt_version_id !== payload.promptVersionId ||
        marker.created_at !== row.created_at
      )
        corrupt();
      return;
    }
  }
}
function metadata(row: AuditRow, version: number | null): ConfigurationAuditSummary {
  check(EntityIdSchema, row.id);
  check(EntityIdSchema, row.entity_id);
  check(nullableEntityId, row.repository_id);
  actorPart(row.actor_issuer, 2048);
  actorPart(row.actor_subject, 512);
  canonicalInstant(row.created_at);
  const summary = {
    id: row.id,
    source: row.source,
    action: row.action,
    entityId: row.entity_id,
    repositoryId: row.repository_id,
    actor: { issuer: row.actor_issuer, subject: row.actor_subject },
    createdAt: row.created_at,
    version,
  };
  check(ConfigurationAuditSummarySchema, summary);
  if (row.source === "repository" && row.entity_id !== row.repository_id) corrupt();
  return summary as ConfigurationAuditSummary;
}
function project(database: DatabaseSync, row: AuditRow): ConfigurationAuditEvent {
  // Validate attribution before using it to compare immutable authors.
  actorPart(row.actor_issuer, 2048);
  actorPart(row.actor_subject, 512);
  canonicalInstant(row.created_at);
  check(EntityIdSchema, row.entity_id);
  check(nullableEntityId, row.repository_id);
  if (typeof row.payload_json !== "string") corrupt();
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    corrupt();
  }
  let version: number | null;
  if (row.source === "repository") {
    if (
      !["created", "updated", "bootstrapped"].includes(row.action) ||
      row.repository_id === null ||
      row.entity_id !== row.repository_id
    )
      corrupt();
    check(PositiveIntegerSchema, row.version);
    check(RepositoryConfigurationSnapshotSchema, payload);
    const snapshot = payload as RepositoryConfigurationSnapshot;
    if (
      snapshot.id !== row.repository_id ||
      snapshot.version !== row.version ||
      (snapshot.reviewerGithubUserId === null) !== (snapshot.reviewerGithubLogin === null)
    )
      corrupt();
    canonicalInstant(snapshot.createdAt);
    canonicalInstant(snapshot.updatedAt);
    if (snapshot.updatedAt !== row.created_at) corrupt();
    version = row.version;
  } else {
    if (row.source !== "prompt" || !Object.hasOwn(payloadSchemas, row.action)) corrupt();
    const action = row.action as PromptAction;
    check(payloadSchemas[action], payload);
    validatePromptReferences(database, row, action, payload as Record<string, unknown>);
    const recorded = payload as Record<string, unknown>;
    version = typeof recorded.version === "number" ? recorded.version : null;
  }
  safeStrings(payload);
  const event = { ...metadata(row, version), snapshot: payload };
  check(ConfigurationAuditEventSchema, event);
  return event as ConfigurationAuditEvent;
}
function authorize(
  database: DatabaseSync,
  repositoryId: string | null,
  context?: OperatorReadContext,
): void {
  if (repositoryId === null) {
    if (context !== undefined) assertPlatformAdministrator(context.actor, context.administrators);
  } else if (context !== undefined) {
    assertRepositoryPermission(
      database,
      context.actor,
      repositoryId,
      "read",
      context.administrators,
    );
  } else if (
    !database.prepare("SELECT 1 FROM managed_repositories WHERE id = ?").get(repositoryId)
  ) {
    notFound();
  }
}
function list(
  database: DatabaseSync,
  query: PageQuery,
  selectSql: string,
  countSql: string,
  parameters: SQLInputValue[],
): AuditPage {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? maximumConfigurationAuditPageSize;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) invalid();
  const count = database.prepare(countSql).get(...parameters) as { total: number };
  if (!Number.isSafeInteger(count.total) || count.total < 0) corrupt();
  const rows = database
    .prepare(`${selectSql} ORDER BY created_at DESC, source ASC, id DESC LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, offset) as unknown as AuditRow[];
  const items = rows.map((row) => {
    if (row.source === "repository") return metadata(row, row.version);
    const { snapshot: _snapshot, ...summary } = project(database, row);
    return summary;
  });
  return { items, total: count.total, page, pageSize };
}

/** Authorization, count, page selection and immutable-reference validation share one read snapshot. */
export function handleConfigurationAuditRequest(
  database: DatabaseSync,
  request: ConfigurationAuditRequest,
  context?: OperatorReadContext,
): unknown {
  if (
    !isConfigurationAuditOperation(request.operation) ||
    !Value.Check(inputSchemas[request.operation], request.input)
  )
    invalid();
  return readTransaction(database, () => {
    const repositoryId = "repositoryId" in request.input ? request.input.repositoryId : null;
    authorize(database, repositoryId, context);
    switch (request.operation) {
      case "listRepositoryConfigurationAudit":
        return bounded(RepositoryConfigurationAuditListResponseSchema, {
          repositoryId: request.input.repositoryId,
          ...list(
            database,
            request.input,
            `${repositorySelection(false)} WHERE repository_id = ? UNION ALL ${promptSelection} WHERE repository_id = ?`,
            `SELECT (SELECT COUNT(*) FROM repository_configuration_audit WHERE repository_id = ?) +
            (SELECT COUNT(*) FROM prompt_configuration_audit WHERE repository_id = ?) AS total`,
            [request.input.repositoryId, request.input.repositoryId],
          ),
        });
      case "listGlobalConfigurationAudit": {
        const { templateId } = request.input;
        if (
          templateId !== undefined &&
          !database.prepare("SELECT 1 FROM prompt_templates WHERE id = ?").get(templateId)
        )
          notFound();
        const filter =
          templateId === undefined
            ? "repository_id IS NULL"
            : `repository_id IS NULL AND
          ((action IN ('template_created', 'draft_saved', 'prompt_published') AND entity_id = ?) OR
          (action IN ('prompt_bound', 'bootstrap_registered') AND EXISTS (
            SELECT 1 FROM prompt_versions WHERE template_id = ? AND id = CASE
              WHEN json_valid(prompt_configuration_audit.detail_json)
                THEN json_extract(prompt_configuration_audit.detail_json, '$.promptVersionId') ELSE NULL END
          )))`;
        return bounded(GlobalConfigurationAuditListResponseSchema, {
          ...(templateId === undefined ? {} : { templateId }),
          ...list(
            database,
            request.input,
            `${promptSelection} WHERE ${filter}`,
            `SELECT COUNT(*) AS total FROM prompt_configuration_audit WHERE ${filter}`,
            templateId === undefined ? [] : [templateId, templateId],
          ),
        });
      }
      case "getRepositoryConfigurationAudit": {
        const row = database
          .prepare(`${request.input.source === "repository" ? repositorySelection(true) : promptSelection}
          WHERE repository_id = ? AND id = ?`)
          .get(request.input.repositoryId, request.input.eventId) as AuditRow | undefined;
        return row === undefined
          ? null
          : bounded(ConfigurationAuditEventSchema, project(database, row));
      }
      case "getGlobalConfigurationAudit": {
        const row = database
          .prepare(`${promptSelection} WHERE repository_id IS NULL AND id = ?`)
          .get(request.input.eventId) as AuditRow | undefined;
        return row === undefined
          ? null
          : bounded(ConfigurationAuditEventSchema, project(database, row));
      }
    }
  });
}
