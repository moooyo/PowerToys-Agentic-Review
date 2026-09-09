import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  EntityIdSchema,
  getValidationProfileConfigIssues,
  maximumConfigurationActorLength,
  maximumPromptContentUtf8Bytes,
  type PromptBinding,
  type PromptBindingSaveRequest,
  PromptBindingSaveRequestSchema,
  type PromptDraftPublishRequest,
  PromptDraftPublishRequestSchema,
  type PromptDraftSaveRequest,
  PromptDraftSaveRequestSchema,
  type PromptTemplate,
  type PromptTemplateCreateRequest,
  PromptTemplateCreateRequestSchema,
  type PromptTemplateSummary,
  type PromptVersion,
  type PromptVersionSummary,
  type RepositoryValidationProfileBinding,
  type RepositoryValidationProfileBindingSaveRequest,
  RepositoryValidationProfileBindingSaveRequestSchema,
  type ValidationProfileCreateRequest,
  ValidationProfileCreateRequestSchema,
  type ValidationProfileVersion,
  type ValidationProfileVersionSummary,
  type WorkflowKind,
  WorkflowKindSchema,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "../scheduling/canonical-json.js";

export interface ConfigurationActor {
  readonly issuer: string;
  readonly subject: string;
}

export interface ConfigurationPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ConfigurationPage<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

interface MutationInput<T> {
  readonly request: T;
  readonly actor: ConfigurationActor;
}

interface PromptScope {
  readonly repositoryId: string | null;
}

interface PromptBindingScope extends PromptScope {
  readonly workflowKind: WorkflowKind;
}

interface ProfileScope {
  readonly repositoryId: string;
  readonly profileId: string;
}

export interface PromptBindingHistory extends PromptBinding {
  readonly id: string;
  readonly previousVersionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ValidationProfileBindingHistory extends RepositoryValidationProfileBinding {
  readonly id: string;
  readonly previousVersionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ResolvedWorkflowPrompt {
  readonly binding: PromptBinding;
  readonly version: PromptVersion;
  readonly templateName: string;
  readonly workflowKind: WorkflowKind;
}

export interface PromptConfigurationOperationMap {
  readonly bootstrapPromptTemplates: {
    readonly input: {
      readonly templates: readonly PromptTemplateCreateRequest[];
      readonly actor: ConfigurationActor;
    };
    readonly output: PromptBinding[];
  };
  readonly listPromptTemplates: {
    readonly input: ConfigurationPageQuery & { readonly workflowKind?: WorkflowKind };
    readonly output: ConfigurationPage<PromptTemplateSummary>;
  };
  readonly getPromptTemplate: {
    readonly input: { readonly templateId: string };
    readonly output: PromptTemplate | null;
  };
  readonly createPromptTemplate: {
    readonly input: MutationInput<PromptTemplateCreateRequest>;
    readonly output: PromptTemplate;
  };
  readonly savePromptDraft: {
    readonly input: MutationInput<PromptDraftSaveRequest> & { readonly templateId: string };
    readonly output: PromptTemplate;
  };
  readonly publishPromptDraft: {
    readonly input: MutationInput<PromptDraftPublishRequest> & { readonly templateId: string };
    readonly output: PromptVersion;
  };
  readonly listPromptVersions: {
    readonly input: ConfigurationPageQuery & { readonly templateId: string };
    readonly output: ConfigurationPage<PromptVersionSummary>;
  };
  readonly getPromptVersion: {
    readonly input: { readonly templateId: string; readonly versionId: string };
    readonly output: PromptVersion;
  };
  readonly listPromptBindings: {
    readonly input: PromptScope;
    readonly output: PromptBinding[];
  };
  readonly resolveWorkflowPrompt: {
    readonly input: { readonly repositoryId: string; readonly workflowKind: WorkflowKind };
    readonly output: ResolvedWorkflowPrompt | null;
  };
  readonly savePromptBinding: {
    readonly input: PromptBindingScope & MutationInput<PromptBindingSaveRequest>;
    readonly output: PromptBinding;
  };
  readonly listPromptBindingHistory: {
    readonly input: PromptBindingScope & ConfigurationPageQuery;
    readonly output: ConfigurationPage<PromptBindingHistory>;
  };
  readonly listValidationProfiles: {
    readonly input: ConfigurationPageQuery & { readonly repositoryId: string };
    readonly output: ConfigurationPage<ValidationProfileVersionSummary>;
  };
  readonly publishValidationProfile: {
    readonly input: {
      readonly repositoryId: string;
    } & MutationInput<ValidationProfileCreateRequest>;
    readonly output: ValidationProfileVersion;
  };
  readonly listValidationProfileVersions: {
    readonly input: ConfigurationPageQuery & ProfileScope;
    readonly output: ConfigurationPage<ValidationProfileVersionSummary>;
  };
  readonly getValidationProfileVersion: {
    readonly input: ProfileScope & { readonly versionId: string };
    readonly output: ValidationProfileVersion;
  };
  readonly listValidationProfileBindings: {
    readonly input: ConfigurationPageQuery & { readonly repositoryId: string };
    readonly output: ConfigurationPage<RepositoryValidationProfileBinding>;
  };
  readonly saveValidationProfileBinding: {
    readonly input: ProfileScope & MutationInput<RepositoryValidationProfileBindingSaveRequest>;
    readonly output: RepositoryValidationProfileBinding;
  };
  readonly listValidationProfileBindingHistory: {
    readonly input: ConfigurationPageQuery & ProfileScope;
    readonly output: ConfigurationPage<ValidationProfileBindingHistory>;
  };
}

export type PromptConfigurationOperation = keyof PromptConfigurationOperationMap;
export type PromptConfigurationRequest = {
  [K in PromptConfigurationOperation]: {
    readonly operation: K;
    readonly input: PromptConfigurationOperationMap[K]["input"];
  };
}[PromptConfigurationOperation];

const operations = {
  bootstrapPromptTemplates: true,
  listPromptTemplates: true,
  getPromptTemplate: true,
  createPromptTemplate: true,
  savePromptDraft: true,
  publishPromptDraft: true,
  listPromptVersions: true,
  getPromptVersion: true,
  listPromptBindings: true,
  resolveWorkflowPrompt: true,
  savePromptBinding: true,
  listPromptBindingHistory: true,
  listValidationProfiles: true,
  publishValidationProfile: true,
  listValidationProfileVersions: true,
  getValidationProfileVersion: true,
  listValidationProfileBindings: true,
  saveValidationProfileBinding: true,
  listValidationProfileBindingHistory: true,
} satisfies Record<PromptConfigurationOperation, true>;

export function isPromptConfigurationOperation(
  value: string,
): value is PromptConfigurationOperation {
  return Object.hasOwn(operations, value);
}

export class PromptConfigurationError extends Error {
  constructor(
    readonly code: "PLATFORM_CONFLICT" | "PLATFORM_NOT_FOUND" | "PLATFORM_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PromptConfigurationError";
  }
}

function invalid(message: string): never {
  throw new PromptConfigurationError("PLATFORM_INVALID", message);
}

function notFound(entity: string): never {
  throw new PromptConfigurationError("PLATFORM_NOT_FOUND", `${entity} was not found.`);
}

function conflict(): never {
  throw new PromptConfigurationError(
    "PLATFORM_CONFLICT",
    "The configuration changed. Reload it before saving.",
  );
}

function validate<T extends TSchema>(schema: T, value: unknown): asserts value is Static<T> {
  if (!Value.Check(schema, value))
    invalid("The configuration request does not match its supported schema.");
}

function entityId(value: string): void {
  validate(EntityIdSchema, value);
}

function author(actor: ConfigurationActor): string {
  for (const [value, maximum] of [
    [actor?.issuer, 2048],
    [actor?.subject, 512],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum ||
      value.trim() !== value ||
      value.includes("\0") ||
      Buffer.from(value, "utf8").toString("utf8") !== value
    ) {
      invalid("The authenticated operator identity is invalid.");
    }
  }
  const result = JSON.stringify([actor.issuer, actor.subject]);
  if (result.length > maximumConfigurationActorLength)
    invalid("The operator attribution is too long.");
  return result;
}

function promptContent(content: string): void {
  if (
    content.includes("\0") ||
    Buffer.byteLength(content, "utf8") > maximumPromptContentUtf8Bytes ||
    Buffer.from(content, "utf8").toString("utf8") !== content
  ) {
    invalid(
      `Prompt content must be valid UTF-8 without NUL characters and at most ${maximumPromptContentUtf8Bytes} bytes.`,
    );
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function nextVersion(current: number): number {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
    invalid("The configuration version is exhausted.");
  return current + 1;
}

function checkVersion(expected: number, actual: number): number {
  if (expected !== actual) conflict();
  return nextVersion(actual);
}

function transaction<T>(database: DatabaseSync, action: () => T, readOnly = false): T {
  // A configuration read can share the caller's atomic planning snapshot without owning its commit.
  if (readOnly && database.isTransaction) return action();
  database.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function requireRepository(database: DatabaseSync, repositoryId: string | null): void {
  if (repositoryId === null) return;
  entityId(repositoryId);
  if (!database.prepare("SELECT id FROM managed_repositories WHERE id = ?").get(repositoryId))
    notFound("Repository");
}

function scopeKey(repositoryId: string | null): string {
  return repositoryId === null ? "global" : `repository:${repositoryId}`;
}

function audit(
  database: DatabaseSync,
  action: string,
  entity: string,
  repositoryId: string | null,
  actor: ConfigurationActor,
  now: string,
  detail: unknown,
): void {
  database
    .prepare(`INSERT INTO prompt_configuration_audit
    (id, action, entity_id, repository_id, actor_issuer, actor_subject, created_at, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      action,
      entity,
      repositoryId,
      actor.issuer,
      actor.subject,
      now,
      canonicalJson(detail),
    );
}

function page<T>(
  database: DatabaseSync,
  query: ConfigurationPageQuery,
  countSql: string,
  selectSql: string,
  parameters: SQLInputValue[],
  map: (row: unknown) => T,
): ConfigurationPage<T> {
  const pageNumber = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  if (
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((pageNumber - 1) * pageSize)
  ) {
    invalid("Pagination requires a positive page and a page size from 1 through 50.");
  }
  return transaction(
    database,
    () => {
      const count = database.prepare(countSql).get(...parameters) as { total: number };
      const rows = database
        .prepare(`${selectSql} LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (pageNumber - 1) * pageSize);
      return { items: rows.map(map), total: count.total, page: pageNumber, pageSize };
    },
    true,
  );
}

const templateSelect = `SELECT id, name, description, workflow_kind AS workflowKind, version,
  draft_revision AS draftRevision, draft_content AS draftContent,
  draft_output_schema_version AS draftOutputSchemaVersion,
  latest_published_version_id AS latestPublishedVersionId, created_at AS createdAt, updated_at AS updatedAt
  FROM prompt_templates`;
const templateSummarySelect = `SELECT id, name, description, workflow_kind AS workflowKind, version,
  draft_revision AS draftRevision, draft_output_schema_version AS draftOutputSchemaVersion,
  latest_published_version_id AS latestPublishedVersionId, created_at AS createdAt, updated_at AS updatedAt
  FROM prompt_templates`;
const promptVersionSelect = `SELECT id, template_id AS templateId, version, content,
  content_sha256 AS contentSha256, output_schema_version AS outputSchemaVersion,
  created_at AS createdAt, published_at AS publishedAt, created_by AS createdBy FROM prompt_versions`;
const promptVersionSummarySelect = `SELECT id, template_id AS templateId, version,
  content_sha256 AS contentSha256, output_schema_version AS outputSchemaVersion,
  created_at AS createdAt, published_at AS publishedAt, created_by AS createdBy FROM prompt_versions`;
const promptBindingSelect = `SELECT repository_id AS repositoryId, workflow_kind AS workflowKind,
  prompt_version_id AS promptVersionId, version FROM prompt_bindings`;
const profileVersionSelect = `SELECT version.id, version.profile_id AS profileId,
  profile.repository_id AS repositoryId, profile.workflow_kind AS workflowKind, profile.target,
  version.version, version.name, version.config_json AS configJson, version.config_sha256 AS configSha256,
  version.required, version.output_schema_version AS outputSchemaVersion,
  version.created_at AS createdAt, version.published_at AS publishedAt, version.created_by AS createdBy
  FROM validation_profile_versions AS version JOIN validation_profiles AS profile ON profile.id = version.profile_id`;
const profileVersionSummarySelect = `SELECT version.id, version.profile_id AS profileId,
  profile.repository_id AS repositoryId, profile.workflow_kind AS workflowKind, profile.target,
  version.version, version.name, version.config_sha256 AS configSha256,
  version.required, version.output_schema_version AS outputSchemaVersion,
  version.created_at AS createdAt, version.published_at AS publishedAt, version.created_by AS createdBy
  FROM validation_profile_versions AS version JOIN validation_profiles AS profile ON profile.id = version.profile_id`;
const profileBindingSelect = `SELECT repository_id AS repositoryId, profile_id AS profileId,
  profile_version_id AS profileVersionId, enabled, version FROM validation_profile_bindings`;

function getTemplate(database: DatabaseSync, templateId: string): PromptTemplate | null {
  entityId(templateId);
  return (
    (database.prepare(`${templateSelect} WHERE id = ?`).get(templateId) as
      | PromptTemplate
      | undefined) ?? null
  );
}

function requireTemplate(database: DatabaseSync, templateId: string): PromptTemplate {
  return getTemplate(database, templateId) ?? notFound("Prompt template");
}

function createTemplate(
  database: DatabaseSync,
  input: MutationInput<PromptTemplateCreateRequest>,
  now: string,
): PromptTemplate {
  validate(PromptTemplateCreateRequestSchema, input.request);
  promptContent(input.request.content);
  const id = randomUUID();
  const request = input.request;
  database
    .prepare(`INSERT INTO prompt_templates
    (id, name, description, workflow_kind, version, draft_revision, draft_content,
      draft_output_schema_version, latest_published_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, NULL, ?, ?)`)
    .run(
      id,
      request.name,
      request.description ?? "",
      request.workflowKind,
      request.content,
      request.outputSchemaVersion,
      now,
      now,
    );
  audit(database, "template_created", id, null, input.actor, now, {
    workflowKind: request.workflowKind,
    version: 1,
  });
  return requireTemplate(database, id);
}

function saveDraft(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["savePromptDraft"]["input"],
  now: string,
): PromptTemplate {
  validate(PromptDraftSaveRequestSchema, input.request);
  promptContent(input.request.content);
  const template = requireTemplate(database, input.templateId);
  if (input.request.outputSchemaVersion !== WorkflowOutputSchemaVersions[template.workflowKind])
    invalid("The output schema does not match the prompt workflow.");
  const version = checkVersion(input.request.expectedVersion, template.version);
  const draftRevision = nextVersion(template.draftRevision);
  database
    .prepare(`UPDATE prompt_templates SET version = ?, draft_revision = ?, draft_content = ?,
    draft_output_schema_version = ?, updated_at = ? WHERE id = ? AND version = ?`)
    .run(
      version,
      draftRevision,
      input.request.content,
      input.request.outputSchemaVersion,
      now,
      template.id,
      template.version,
    );
  audit(database, "draft_saved", template.id, null, input.actor, now, { version, draftRevision });
  return requireTemplate(database, template.id);
}

function publishDraft(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["publishPromptDraft"]["input"],
  now: string,
): PromptVersion {
  validate(PromptDraftPublishRequestSchema, input.request);
  const template = requireTemplate(database, input.templateId);
  promptContent(template.draftContent);
  const templateVersion = checkVersion(input.request.expectedVersion, template.version);
  const previous = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM prompt_versions WHERE template_id = ?",
    )
    .get(template.id) as { version: number };
  const published: PromptVersion = {
    id: randomUUID(),
    templateId: template.id,
    version: nextVersion(previous.version),
    content: template.draftContent,
    contentSha256: sha256(template.draftContent),
    outputSchemaVersion: template.draftOutputSchemaVersion,
    createdAt: now,
    publishedAt: now,
    createdBy: author(input.actor),
  };
  database
    .prepare(`INSERT INTO prompt_versions
    (id, template_id, version, source_draft_revision, content, content_sha256, output_schema_version, created_at, published_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      published.id,
      template.id,
      published.version,
      template.draftRevision,
      published.content,
      published.contentSha256,
      published.outputSchemaVersion,
      now,
      now,
      published.createdBy,
    );
  database
    .prepare(
      "UPDATE prompt_templates SET version = ?, latest_published_version_id = ?, updated_at = ? WHERE id = ? AND version = ?",
    )
    .run(templateVersion, published.id, now, template.id, template.version);
  audit(database, "prompt_published", template.id, null, input.actor, now, {
    promptVersionId: published.id,
    publishedVersion: published.version,
    version: templateVersion,
  });
  return published;
}

function listPromptBindings(database: DatabaseSync, scope: PromptScope): PromptBinding[] {
  requireRepository(database, scope.repositoryId);
  return database
    .prepare(`${promptBindingSelect} WHERE scope_key = ? ORDER BY workflow_kind LIMIT 4`)
    .all(scopeKey(scope.repositoryId)) as unknown as PromptBinding[];
}

function resolveWorkflowPrompt(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["resolveWorkflowPrompt"]["input"],
): ResolvedWorkflowPrompt | null {
  entityId(input.repositoryId);
  validate(WorkflowKindSchema, input.workflowKind);
  return transaction(
    database,
    () => {
      requireRepository(database, input.repositoryId);
      const binding = database
        .prepare(`${promptBindingSelect}
      WHERE workflow_kind = ? AND scope_key IN (?, 'global')
      ORDER BY CASE WHEN scope_key = 'global' THEN 1 ELSE 0 END LIMIT 1`)
        .get(input.workflowKind, scopeKey(input.repositoryId)) as PromptBinding | undefined;
      if (!binding) return null;
      // Resolve the selected binding separately so a damaged repository override cannot fall back.
      const version = database
        .prepare(`${promptVersionSelect} WHERE id = ?`)
        .get(binding.promptVersionId) as PromptVersion | undefined;
      if (!version) invalid("The configured prompt binding has no published version.");
      const template = database
        .prepare("SELECT name, workflow_kind AS workflowKind FROM prompt_templates WHERE id = ?")
        .get(version.templateId) as { name: string; workflowKind: WorkflowKind } | undefined;
      if (
        !template ||
        template.workflowKind !== input.workflowKind ||
        version.outputSchemaVersion !== WorkflowOutputSchemaVersions[input.workflowKind]
      ) {
        invalid("The configured prompt version does not match its workflow output contract.");
      }
      promptContent(version.content);
      if (!version.content.trim() || version.contentSha256 !== sha256(version.content)) {
        invalid("The configured prompt version has an invalid content digest.");
      }
      return { binding, version, templateName: template.name, workflowKind: input.workflowKind };
    },
    true,
  );
}

function savePromptBinding(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["savePromptBinding"]["input"],
  now: string,
): PromptBinding {
  validate(PromptBindingSaveRequestSchema, input.request);
  validate(WorkflowKindSchema, input.workflowKind);
  requireRepository(database, input.repositoryId);
  const referenced = database
    .prepare(`SELECT template.workflow_kind AS workflowKind FROM prompt_versions AS version
    JOIN prompt_templates AS template ON template.id = version.template_id WHERE version.id = ?`)
    .get(input.request.promptVersionId) as { workflowKind: WorkflowKind } | undefined;
  if (!referenced) notFound("Published prompt version");
  if (referenced.workflowKind !== input.workflowKind)
    invalid("The published prompt belongs to another workflow.");
  const key = scopeKey(input.repositoryId);
  const previous = database
    .prepare(`${promptBindingSelect} WHERE scope_key = ? AND workflow_kind = ?`)
    .get(key, input.workflowKind) as PromptBinding | undefined;
  const version = checkVersion(input.request.expectedVersion, previous?.version ?? 0);
  const binding: PromptBinding = {
    repositoryId: input.repositoryId,
    workflowKind: input.workflowKind,
    promptVersionId: input.request.promptVersionId,
    version,
  };
  if (previous) {
    database
      .prepare(
        "UPDATE prompt_bindings SET prompt_version_id = ?, version = ?, updated_at = ? WHERE scope_key = ? AND workflow_kind = ? AND version = ?",
      )
      .run(binding.promptVersionId, version, now, key, binding.workflowKind, previous.version);
  } else {
    database
      .prepare(
        "INSERT INTO prompt_bindings (scope_key, repository_id, workflow_kind, prompt_version_id, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(key, binding.repositoryId, binding.workflowKind, binding.promptVersionId, version, now);
  }
  const historyId = randomUUID();
  database
    .prepare(`INSERT INTO prompt_binding_history
    (id, scope_key, repository_id, workflow_kind, prompt_version_id, previous_version_id, version, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      historyId,
      key,
      binding.repositoryId,
      binding.workflowKind,
      binding.promptVersionId,
      previous?.promptVersionId ?? null,
      version,
      now,
      author(input.actor),
    );
  audit(database, "prompt_bound", historyId, binding.repositoryId, input.actor, now, {
    workflowKind: binding.workflowKind,
    promptVersionId: binding.promptVersionId,
    previousVersionId: previous?.promptVersionId ?? null,
    version,
  });
  return binding;
}

interface StoredProfileIdentity {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowKind: WorkflowKind;
  readonly target: ValidationProfileVersion["target"];
}

function requireProfile(database: DatabaseSync, scope: ProfileScope): StoredProfileIdentity {
  entityId(scope.repositoryId);
  requireRepository(database, scope.repositoryId);
  entityId(scope.profileId);
  const profile = database
    .prepare(
      "SELECT id, repository_id AS repositoryId, workflow_kind AS workflowKind, target FROM validation_profiles WHERE id = ?",
    )
    .get(scope.profileId) as StoredProfileIdentity | undefined;
  if (!profile) notFound("Validation profile");
  if (profile.repositoryId !== scope.repositoryId)
    invalid("The validation profile belongs to another repository.");
  return profile;
}

function mapProfile(row: unknown): ValidationProfileVersion {
  const stored = row as Omit<ValidationProfileVersion, "config" | "required"> & {
    configJson: string;
    required: number;
  };
  const { configJson, required, ...properties } = stored;
  return {
    ...properties,
    config: JSON.parse(configJson),
    required: required === 1,
  } as ValidationProfileVersion;
}

function mapProfileBinding<T extends RepositoryValidationProfileBinding>(row: unknown): T {
  const stored = row as Omit<T, "enabled"> & { enabled: number };
  return { ...stored, enabled: stored.enabled === 1 } as T;
}

function mapProfileSummary(row: unknown): ValidationProfileVersionSummary {
  const stored = row as Omit<ValidationProfileVersionSummary, "required"> & { required: number };
  return { ...stored, required: stored.required === 1 } as ValidationProfileVersionSummary;
}

function publishProfile(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["publishValidationProfile"]["input"],
  now: string,
): ValidationProfileVersion {
  validate(ValidationProfileCreateRequestSchema, input.request);
  const request = input.request;
  const issues = getValidationProfileConfigIssues(request.config, request.workflowKind);
  if (issues.length) invalid(issues.join(" "));
  entityId(input.repositoryId);
  requireRepository(database, input.repositoryId);
  let profileId: string;
  let version: number;
  if ("profileId" in request) {
    const profile = requireProfile(database, {
      repositoryId: input.repositoryId,
      profileId: request.profileId,
    });
    if (profile.workflowKind !== request.workflowKind || profile.target !== request.target)
      invalid("A profile version cannot change its workflow or execution target.");
    const previous = database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM validation_profile_versions WHERE profile_id = ?",
      )
      .get(profile.id) as { version: number };
    version = checkVersion(request.expectedVersion, previous.version);
    profileId = profile.id;
  } else {
    profileId = randomUUID();
    version = 1;
    database
      .prepare(
        "INSERT INTO validation_profiles (id, repository_id, workflow_kind, target, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(profileId, input.repositoryId, request.workflowKind, request.target, now);
  }
  const configJson = canonicalJson(request.config);
  const id = randomUUID();
  database
    .prepare(`INSERT INTO validation_profile_versions
    (id, profile_id, version, name, config_json, config_sha256, output_schema_version, required, created_at, published_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      profileId,
      version,
      request.name,
      configJson,
      sha256(configJson),
      request.outputSchemaVersion,
      request.required ? 1 : 0,
      now,
      now,
      author(input.actor),
    );
  audit(database, "profile_published", profileId, input.repositoryId, input.actor, now, {
    profileVersionId: id,
    version,
  });
  return mapProfile(database.prepare(`${profileVersionSelect} WHERE version.id = ?`).get(id));
}

function saveProfileBinding(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["saveValidationProfileBinding"]["input"],
  now: string,
): RepositoryValidationProfileBinding {
  validate(RepositoryValidationProfileBindingSaveRequestSchema, input.request);
  requireProfile(database, input);
  const referenced = database
    .prepare("SELECT profile_id AS profileId FROM validation_profile_versions WHERE id = ?")
    .get(input.request.profileVersionId) as { profileId: string } | undefined;
  if (!referenced) notFound("Published validation profile version");
  if (referenced.profileId !== input.profileId)
    invalid("The published version belongs to another validation profile.");
  const previous = database
    .prepare(`${profileBindingSelect} WHERE repository_id = ? AND profile_id = ?`)
    .get(input.repositoryId, input.profileId) as
    | { version: number; profileVersionId: string }
    | undefined;
  const version = checkVersion(input.request.expectedVersion, previous?.version ?? 0);
  const binding: RepositoryValidationProfileBinding = {
    repositoryId: input.repositoryId,
    profileId: input.profileId,
    profileVersionId: input.request.profileVersionId,
    enabled: input.request.enabled,
    version,
  };
  if (previous) {
    database
      .prepare(
        "UPDATE validation_profile_bindings SET profile_version_id = ?, enabled = ?, version = ?, updated_at = ? WHERE repository_id = ? AND profile_id = ? AND version = ?",
      )
      .run(
        binding.profileVersionId,
        binding.enabled ? 1 : 0,
        version,
        now,
        binding.repositoryId,
        binding.profileId,
        previous.version,
      );
  } else {
    database
      .prepare(
        "INSERT INTO validation_profile_bindings (repository_id, profile_id, profile_version_id, enabled, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        binding.repositoryId,
        binding.profileId,
        binding.profileVersionId,
        binding.enabled ? 1 : 0,
        version,
        now,
      );
  }
  const historyId = randomUUID();
  database
    .prepare(`INSERT INTO validation_profile_binding_history
    (id, repository_id, profile_id, profile_version_id, previous_version_id, enabled, version, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      historyId,
      binding.repositoryId,
      binding.profileId,
      binding.profileVersionId,
      previous?.profileVersionId ?? null,
      binding.enabled ? 1 : 0,
      version,
      now,
      author(input.actor),
    );
  audit(database, "profile_bound", historyId, binding.repositoryId, input.actor, now, {
    profileId: binding.profileId,
    profileVersionId: binding.profileVersionId,
    previousVersionId: previous?.profileVersionId ?? null,
    enabled: binding.enabled,
    version,
  });
  return binding;
}

function bootstrap(
  database: DatabaseSync,
  input: PromptConfigurationOperationMap["bootstrapPromptTemplates"]["input"],
  now: string,
): PromptBinding[] {
  if (!Array.isArray(input.templates) || input.templates.length > 4)
    invalid("Bootstrap accepts at most one template per workflow.");
  const seen = new Set<WorkflowKind>();
  for (const request of input.templates) {
    validate(PromptTemplateCreateRequestSchema, request);
    promptContent(request.content);
    if (seen.has(request.workflowKind)) invalid("Bootstrap contains a repeated workflow.");
    seen.add(request.workflowKind);
  }
  for (const request of input.templates) {
    if (
      database
        .prepare("SELECT workflow_kind FROM prompt_configuration_bootstrap WHERE workflow_kind = ?")
        .get(request.workflowKind)
    )
      continue;
    let binding = listPromptBindings(database, { repositoryId: null }).find(
      (candidate) => candidate.workflowKind === request.workflowKind,
    );
    if (!binding) {
      const template = createTemplate(database, { request, actor: input.actor }, now);
      const published = publishDraft(
        database,
        {
          templateId: template.id,
          request: { expectedVersion: template.version },
          actor: input.actor,
        },
        now,
      );
      binding = savePromptBinding(
        database,
        {
          repositoryId: null,
          workflowKind: request.workflowKind,
          request: { expectedVersion: 0, promptVersionId: published.id },
          actor: input.actor,
        },
        now,
      );
    }
    database
      .prepare(
        "INSERT INTO prompt_configuration_bootstrap (workflow_kind, prompt_version_id, created_at) VALUES (?, ?, ?)",
      )
      .run(request.workflowKind, binding.promptVersionId, now);
    audit(database, "bootstrap_registered", request.workflowKind, null, input.actor, now, {
      promptVersionId: binding.promptVersionId,
    });
  }
  return listPromptBindings(database, { repositoryId: null });
}

// This entry point receives actor identity from the authenticated server, never from request JSON.
export function handlePromptConfigurationRequest(
  database: DatabaseSync,
  request: PromptConfigurationRequest,
  now: string,
): unknown {
  if (
    typeof now !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(now) ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid("The server timestamp must be a canonical UTC instant.");
  if ("request" in request.input) {
    author(request.input.actor);
  } else if (request.operation === "bootstrapPromptTemplates") {
    author(request.input.actor);
  }
  switch (request.operation) {
    case "bootstrapPromptTemplates":
      return transaction(database, () => bootstrap(database, request.input, now));
    case "createPromptTemplate":
      return transaction(database, () => createTemplate(database, request.input, now));
    case "savePromptDraft":
      return transaction(database, () => saveDraft(database, request.input, now));
    case "publishPromptDraft":
      return transaction(database, () => publishDraft(database, request.input, now));
    case "savePromptBinding":
      return transaction(database, () => savePromptBinding(database, request.input, now));
    case "publishValidationProfile":
      return transaction(database, () => publishProfile(database, request.input, now));
    case "saveValidationProfileBinding":
      return transaction(database, () => saveProfileBinding(database, request.input, now));
    case "getPromptTemplate":
      return getTemplate(database, request.input.templateId);
    case "getPromptVersion": {
      requireTemplate(database, request.input.templateId);
      entityId(request.input.versionId);
      return (
        database
          .prepare(`${promptVersionSelect} WHERE template_id = ? AND id = ?`)
          .get(request.input.templateId, request.input.versionId) ??
        notFound("Published prompt version")
      );
    }
    case "getValidationProfileVersion": {
      requireProfile(database, request.input);
      entityId(request.input.versionId);
      const version = database
        .prepare(`${profileVersionSelect} WHERE profile.id = ? AND version.id = ?`)
        .get(request.input.profileId, request.input.versionId);
      return version ? mapProfile(version) : notFound("Published validation profile version");
    }
    case "listPromptTemplates": {
      const workflow = request.input.workflowKind;
      if (workflow !== undefined) validate(WorkflowKindSchema, workflow);
      const where = workflow === undefined ? "" : " WHERE workflow_kind = ?";
      return page(
        database,
        request.input,
        `SELECT COUNT(*) AS total FROM prompt_templates${where}`,
        `${templateSummarySelect}${where} ORDER BY created_at DESC, id`,
        workflow === undefined ? [] : [workflow],
        (row) => row as PromptTemplateSummary,
      );
    }
    case "listPromptVersions": {
      requireTemplate(database, request.input.templateId);
      return page(
        database,
        request.input,
        "SELECT COUNT(*) AS total FROM prompt_versions WHERE template_id = ?",
        `${promptVersionSummarySelect} WHERE template_id = ? ORDER BY version DESC`,
        [request.input.templateId],
        (row) => row as PromptVersionSummary,
      );
    }
    case "listPromptBindings":
      return listPromptBindings(database, request.input);
    case "resolveWorkflowPrompt":
      return resolveWorkflowPrompt(database, request.input);
    case "listPromptBindingHistory": {
      requireRepository(database, request.input.repositoryId);
      validate(WorkflowKindSchema, request.input.workflowKind);
      const where = " WHERE scope_key = ? AND workflow_kind = ?";
      return page(
        database,
        request.input,
        `SELECT COUNT(*) AS total FROM prompt_binding_history${where}`,
        `SELECT id, repository_id AS repositoryId, workflow_kind AS workflowKind, prompt_version_id AS promptVersionId, previous_version_id AS previousVersionId, version, created_at AS createdAt, created_by AS createdBy FROM prompt_binding_history${where} ORDER BY version DESC`,
        [scopeKey(request.input.repositoryId), request.input.workflowKind],
        (row) => row as PromptBindingHistory,
      );
    }
    case "listValidationProfiles": {
      entityId(request.input.repositoryId);
      requireRepository(database, request.input.repositoryId);
      return page(
        database,
        request.input,
        "SELECT COUNT(*) AS total FROM validation_profiles WHERE repository_id = ?",
        `${profileVersionSummarySelect} WHERE profile.repository_id = ? AND version.version = (SELECT MAX(latest.version) FROM validation_profile_versions AS latest WHERE latest.profile_id = profile.id) ORDER BY profile.created_at DESC, profile.id`,
        [request.input.repositoryId],
        mapProfileSummary,
      );
    }
    case "listValidationProfileVersions": {
      requireProfile(database, request.input);
      return page(
        database,
        request.input,
        "SELECT COUNT(*) AS total FROM validation_profile_versions WHERE profile_id = ?",
        `${profileVersionSummarySelect} WHERE profile.id = ? ORDER BY version.version DESC`,
        [request.input.profileId],
        mapProfileSummary,
      );
    }
    case "listValidationProfileBindings": {
      entityId(request.input.repositoryId);
      requireRepository(database, request.input.repositoryId);
      return page(
        database,
        request.input,
        "SELECT COUNT(*) AS total FROM validation_profile_bindings WHERE repository_id = ?",
        `${profileBindingSelect} WHERE repository_id = ? ORDER BY profile_id`,
        [request.input.repositoryId],
        mapProfileBinding<RepositoryValidationProfileBinding>,
      );
    }
    case "listValidationProfileBindingHistory": {
      requireProfile(database, request.input);
      const where = " WHERE repository_id = ? AND profile_id = ?";
      return page(
        database,
        request.input,
        `SELECT COUNT(*) AS total FROM validation_profile_binding_history${where}`,
        `SELECT id, repository_id AS repositoryId, profile_id AS profileId, profile_version_id AS profileVersionId, previous_version_id AS previousVersionId, enabled, version, created_at AS createdAt, created_by AS createdBy FROM validation_profile_binding_history${where} ORDER BY version DESC`,
        [request.input.repositoryId, request.input.profileId],
        mapProfileBinding<ValidationProfileBindingHistory>,
      );
    }
  }
}
