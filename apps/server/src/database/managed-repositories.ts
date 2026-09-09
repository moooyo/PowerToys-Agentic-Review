import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  EntityIdSchema,
  type GitHubRepository,
  GitHubRepositorySchema,
  type GitHubWorkItem,
  type GitHubWorkItemRevision,
  GitHubWorkItemRevisionSchema,
  GitHubWorkItemSchema,
  type ManagedRepository,
  ManagedRepositoryNameSchema,
  type ManagedRepositorySummary,
  type RepositoryCreateRequest,
  RepositoryCreateRequestSchema,
  type RepositoryUpdateRequest,
  RepositoryUpdateRequestSchema,
  type SelfOrAllowlistPolicy,
  SelfOrAllowlistPolicySchema,
} from "@agentic-review/contracts";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type OperatorReadContext, repositoryReadSql } from "./operator-access.js";

export interface RepositoryConfigurationActor {
  readonly issuer: string;
  readonly subject: string;
}

export interface RepositoryOperationMap {
  listManagedRepositories: {
    input: { page?: number; pageSize?: number; search?: string; enabled?: boolean };
    output: { items: ManagedRepositorySummary[]; total: number };
  };
  getManagedRepository: { input: { repositoryId: string }; output: ManagedRepository | null };
  getManagedRepositoryByGitHubId: {
    input: { githubRepositoryId: number };
    output: ManagedRepository | null;
  };
  getPromptWorkItemContext: {
    input: { workItemId: string };
    output: {
      repositoryId: string;
      repository: GitHubRepository;
      workItem: GitHubWorkItem;
      revision: GitHubWorkItemRevision;
    } | null;
  };
  listManagedRepositoryPollingReviewers: {
    input: { repositoryId: string };
    output: { githubUserId: number; login: string }[];
  };
  createManagedRepository: {
    input: {
      request: RepositoryCreateRequest;
      actor: RepositoryConfigurationActor;
      metadata?: GitHubRepository;
    };
    output: ManagedRepository;
  };
  updateManagedRepository: {
    input: {
      repositoryId: string;
      request: RepositoryUpdateRequest;
      actor: RepositoryConfigurationActor;
    };
    output: ManagedRepository;
  };
  updateRepositoryConnection: {
    input: {
      repositoryId: string;
      status: "unknown" | "ready" | "error";
      message: string | null;
      metadata?: GitHubRepository;
    };
    output: ManagedRepository;
  };
  bootstrapManagedRepositories: {
    input: {
      repositories: readonly { githubRepositoryId: number; fullName: string }[];
      reviewer: { githubUserId: number; login: string };
      authorizationPolicy: SelfOrAllowlistPolicy;
    };
    output: { imported: number };
  };
}

export type RepositoryOperation = keyof RepositoryOperationMap;
export type RepositoryConfigurationRequest = {
  [K in RepositoryOperation]: { operation: K; input: RepositoryOperationMap[K]["input"] };
}[RepositoryOperation];

const operations = new Set<string>([
  "listManagedRepositories",
  "getManagedRepository",
  "getManagedRepositoryByGitHubId",
  "createManagedRepository",
  "updateManagedRepository",
  "updateRepositoryConnection",
  "bootstrapManagedRepositories",
  "listManagedRepositoryPollingReviewers",
  "getPromptWorkItemContext",
]);

export function isRepositoryConfigurationOperation(
  operation: string,
): operation is RepositoryOperation {
  return operations.has(operation);
}

class RepositoryConfigurationError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_NOT_FOUND" | "PLATFORM_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryConfigurationError";
  }
}

const invalid = (message: string): never => {
  throw new RepositoryConfigurationError("PLATFORM_INVALID", message);
};
const conflict = (message: string): never => {
  throw new RepositoryConfigurationError("PLATFORM_CONFLICT", message);
};
const validate = (schema: TSchema, value: unknown): void => {
  if (!Value.Check(schema, value)) invalid("Repository configuration does not match its contract.");
};

interface RepositoryRow {
  id: string;
  github_repository_id: number;
  full_name: string;
  enabled: number;
  version: number;
  reviewer_github_user_id: number | null;
  reviewer_github_login: string | null;
  authorization_policy_json: string | null;
  max_active_leases: number | null;
  max_queued_jobs: number | null;
  connection_status: ManagedRepository["connectionStatus"];
  connection_message: string | null;
  configuration_source: "discovered" | "bootstrap" | "operator";
  created_at: string;
  updated_at: string;
}

function mapRepository(row: RepositoryRow): ManagedRepository {
  return {
    id: row.id,
    githubRepositoryId: row.github_repository_id,
    fullName: row.full_name,
    enabled: row.enabled === 1,
    version: row.version,
    reviewerGithubUserId: row.reviewer_github_user_id,
    reviewerGithubLogin: row.reviewer_github_login,
    authorizationPolicy:
      row.authorization_policy_json === null ? null : JSON.parse(row.authorization_policy_json),
    schedulingLimits: {
      maxActiveLeases: row.max_active_leases,
      maxQueuedJobs: row.max_queued_jobs,
    },
    connectionStatus: row.connection_status,
    connectionMessage: row.connection_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepositorySummary(row: RepositoryRow): ManagedRepositorySummary {
  return {
    id: row.id,
    githubRepositoryId: row.github_repository_id,
    fullName: row.full_name,
    enabled: row.enabled === 1,
    version: row.version,
    reviewerGithubUserId: row.reviewer_github_user_id,
    reviewerGithubLogin: row.reviewer_github_login,
    schedulingLimits: {
      maxActiveLeases: row.max_active_leases,
      maxQueuedJobs: row.max_queued_jobs,
    },
    connectionStatus: row.connection_status,
    connectionMessage: row.connection_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRepository(
  db: DatabaseSync,
  repositoryId: string,
  context?: OperatorReadContext,
): ManagedRepository | null {
  validate(EntityIdSchema, repositoryId);
  const visibility =
    context === undefined
      ? { sql: "1 = 1", parameters: [] }
      : repositoryReadSql("managed_repositories.id", context.actor, context.administrators);
  const row = db
    .prepare(`SELECT * FROM managed_repositories WHERE id = ? AND (${visibility.sql})`)
    .get(repositoryId, ...visibility.parameters) as RepositoryRow | undefined;
  return row ? mapRepository(row) : null;
}

function requireRepository(db: DatabaseSync, repositoryId: string): ManagedRepository {
  const repository = getRepository(db, repositoryId);
  if (!repository)
    throw new RepositoryConfigurationError("PLATFORM_NOT_FOUND", "The repository does not exist.");
  return repository;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function audit(
  db: DatabaseSync,
  repository: ManagedRepository,
  action: string,
  actor: RepositoryConfigurationActor,
  now: string,
): void {
  if (
    !actor ||
    typeof actor.issuer !== "string" ||
    !actor.issuer ||
    actor.issuer.length > 2_048 ||
    typeof actor.subject !== "string" ||
    !actor.subject ||
    actor.subject.length > 512
  )
    invalid("An authenticated configuration actor is required.");
  db.prepare(`INSERT INTO repository_configuration_audit
    (id, repository_id, action, actor_issuer, actor_subject, version, configuration_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    repository.id,
    action,
    actor.issuer,
    actor.subject,
    repository.version,
    JSON.stringify(repository),
    now,
  );
}

function assertReviewer(
  repository: Pick<
    ManagedRepository,
    "reviewerGithubUserId" | "reviewerGithubLogin" | "authorizationPolicy"
  >,
): void {
  if ((repository.reviewerGithubUserId === null) !== (repository.reviewerGithubLogin === null)) {
    invalid("The reviewer ID and login must be configured or cleared together.");
  }
  if (
    repository.reviewerGithubLogin !== null &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(repository.reviewerGithubLogin)
  ) {
    invalid("The reviewer login is invalid.");
  }
  if (
    repository.authorizationPolicy !== null &&
    repository.authorizationPolicy.schedulingTargetGithubUserId !== repository.reviewerGithubUserId
  ) {
    invalid("The authorization policy must target the configured reviewer.");
  }
}

function validateMetadata(
  metadata: GitHubRepository | undefined,
  repository: { githubRepositoryId: number; fullName: string },
): void {
  if (!metadata) return;
  validate(GitHubRepositorySchema, metadata);
  if (
    metadata.githubRepositoryId !== repository.githubRepositoryId ||
    metadata.fullName.toLowerCase() !== repository.fullName.toLowerCase()
  ) {
    invalid("GitHub repository identity does not match the requested repository.");
  }
}

export function handleRepositoryConfigurationRequest(
  db: DatabaseSync,
  request: RepositoryConfigurationRequest,
  now: string,
  context?: OperatorReadContext,
): unknown {
  switch (request.operation) {
    case "listManagedRepositories": {
      const { page = 1, pageSize = 50, search, enabled } = request.input;
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 50 ||
        !Number.isSafeInteger((page - 1) * pageSize) ||
        (search !== undefined && (typeof search !== "string" || search.length > 512)) ||
        (enabled !== undefined && typeof enabled !== "boolean")
      )
        invalid("Repository list query is invalid.");
      const where: string[] = [];
      const parameters: SQLInputValue[] = [];
      if (context !== undefined) {
        const visibility = repositoryReadSql(
          "managed_repositories.id",
          context.actor,
          context.administrators,
        );
        where.push(`(${visibility.sql})`);
        parameters.push(...visibility.parameters);
      }
      if (search) {
        where.push("instr(lower(full_name), lower(?)) > 0");
        parameters.push(search);
      }
      if (enabled !== undefined) {
        where.push("enabled = ?");
        parameters.push(Number(enabled));
      }
      const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM managed_repositories${clause}`)
        .get(...parameters) as { total: number };
      const rows = db
        .prepare(`SELECT id, github_repository_id, full_name, enabled, version,
        reviewer_github_user_id, reviewer_github_login, max_active_leases, max_queued_jobs,
        connection_status, connection_message, created_at, updated_at
        FROM managed_repositories${clause} ORDER BY full_name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
        .all(...parameters, pageSize, (page - 1) * pageSize) as unknown as RepositoryRow[];
      return { items: rows.map(mapRepositorySummary), total: total.total };
    }
    case "getManagedRepository":
      return getRepository(db, request.input.repositoryId, context);
    case "getManagedRepositoryByGitHubId": {
      const id = request.input.githubRepositoryId;
      if (!Number.isSafeInteger(id) || id < 1) invalid("The GitHub repository ID is invalid.");
      const visibility =
        context === undefined
          ? { sql: "1 = 1", parameters: [] }
          : repositoryReadSql("managed_repositories.id", context.actor, context.administrators);
      const row = db
        .prepare(
          `SELECT * FROM managed_repositories WHERE github_repository_id = ? AND (${visibility.sql})`,
        )
        .get(id, ...visibility.parameters) as RepositoryRow | undefined;
      return row ? mapRepository(row) : null;
    }
    case "getPromptWorkItemContext": {
      validate(EntityIdSchema, request.input.workItemId);
      const visibility =
        context === undefined
          ? { sql: "1 = 1", parameters: [] }
          : repositoryReadSql("w.repository_id", context.actor, context.administrators);
      const row = db
        .prepare(`SELECT r.id AS repository_id, r.github_repository_id,
        r.snapshot_json AS repository_json, w.github_work_item_id, w.github_number,
        w.resource_kind AS work_item_kind, w.current_revision_key,
        w.snapshot_json AS work_item_json, revision.resource_kind AS revision_kind,
        revision.revision_key, revision.base_sha, revision.head_sha, revision.content_digest,
        revision.revision_json
        FROM work_items w JOIN repositories r ON r.id = w.repository_id
        JOIN work_item_revisions revision ON revision.work_item_id = w.id AND revision.revision_key = w.current_revision_key
        WHERE w.id = ? AND (${visibility.sql})`)
        .get(request.input.workItemId, ...visibility.parameters) as
        | {
            repository_id: string;
            github_repository_id: number;
            github_work_item_id: number;
            github_number: number;
            work_item_kind: string;
            current_revision_key: string;
            revision_kind: string;
            revision_key: string;
            base_sha: string | null;
            head_sha: string | null;
            content_digest: string | null;
            repository_json: string;
            work_item_json: string;
            revision_json: string;
          }
        | undefined;
      if (!row) return null;
      const repository = JSON.parse(row.repository_json) as GitHubRepository;
      const workItem = JSON.parse(row.work_item_json) as GitHubWorkItem;
      const revision = JSON.parse(row.revision_json) as GitHubWorkItemRevision;
      validate(GitHubRepositorySchema, repository);
      validate(GitHubWorkItemSchema, workItem);
      validate(GitHubWorkItemRevisionSchema, revision);
      if (
        repository.githubRepositoryId !== row.github_repository_id ||
        workItem.githubWorkItemId !== row.github_work_item_id ||
        workItem.number !== row.github_number ||
        workItem.kind !== row.work_item_kind ||
        revision.kind !== row.revision_kind ||
        revision.revisionKey !== row.revision_key ||
        revision.revisionKey !== row.current_revision_key ||
        (revision.kind === "issue"
          ? revision.contentDigest !== row.content_digest
          : revision.baseSha !== row.base_sha || revision.headSha !== row.head_sha) ||
        repository.githubRepositoryId !== workItem.githubRepositoryId ||
        repository.githubRepositoryId !== revision.githubRepositoryId ||
        workItem.githubWorkItemId !== revision.githubWorkItemId ||
        workItem.kind !== revision.kind
      )
        invalid("Stored prompt preview context has inconsistent identities.");
      return { repositoryId: row.repository_id, repository, workItem, revision };
    }
    case "listManagedRepositoryPollingReviewers": {
      const { repositoryId } = request.input;
      requireRepository(db, repositoryId);
      const rows = db
        .prepare(`SELECT e.target_github_user_id AS githubUserId,
        (SELECT json_extract(latest.epoch_json, '$.target.login') FROM request_epochs latest
          JOIN work_items latest_item ON latest_item.id = latest.work_item_id
          WHERE latest_item.repository_id = ? AND latest.status = 'active'
            AND latest.target_github_user_id = e.target_github_user_id
          ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1) AS login
        FROM request_epochs e JOIN work_items item ON item.id = e.work_item_id
        WHERE item.repository_id = ? AND e.status = 'active'
        GROUP BY e.target_github_user_id ORDER BY e.target_github_user_id LIMIT 1025`)
        .all(repositoryId, repositoryId) as { githubUserId: number; login: string }[];
      if (
        rows.length > 1_024 ||
        rows.some(
          (row) =>
            typeof row.login !== "string" ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(row.login),
        )
      ) {
        invalid("Stored repository polling reviewers are invalid or exceed the supported bound.");
      }
      return rows;
    }
    case "createManagedRepository":
      return transaction(db, () => {
        const { request: input, actor, metadata } = request.input;
        validate(RepositoryCreateRequestSchema, input);
        validateMetadata(metadata, input);
        if (
          db
            .prepare(
              "SELECT id FROM managed_repositories WHERE github_repository_id = ? OR full_name = ? COLLATE NOCASE",
            )
            .get(input.githubRepositoryId, input.fullName)
        )
          conflict("The repository is already managed.");
        const projection = db
          .prepare("SELECT id FROM repositories WHERE github_repository_id = ?")
          .get(input.githubRepositoryId) as { id: string } | undefined;
        const id = projection?.id ?? randomUUID();
        db.prepare(`INSERT INTO managed_repositories
        (id, github_repository_id, full_name, enabled, version, max_active_leases, max_queued_jobs,
        connection_status, metadata_json, configuration_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'operator', ?, ?)`).run(
          id,
          input.githubRepositoryId,
          metadata?.fullName ?? input.fullName,
          Number(input.enabled ?? false),
          input.schedulingLimits?.maxActiveLeases ?? null,
          input.schedulingLimits?.maxQueuedJobs ?? null,
          metadata ? "ready" : "unknown",
          metadata ? JSON.stringify(metadata) : null,
          now,
          now,
        );
        const result = requireRepository(db, id);
        audit(db, result, "created", actor, now);
        return result;
      });
    case "updateManagedRepository":
      return transaction(db, () => {
        const { repositoryId, request: input, actor } = request.input;
        validate(RepositoryUpdateRequestSchema, input);
        const current = requireRepository(db, repositoryId);
        if (current.version !== input.expectedVersion)
          conflict("Repository settings changed. Reload before saving.");
        if (current.version === Number.MAX_SAFE_INTEGER)
          invalid("The repository configuration version is exhausted.");
        const next = {
          ...current,
          enabled: input.enabled ?? current.enabled,
          reviewerGithubUserId:
            input.reviewerGithubUserId === undefined
              ? current.reviewerGithubUserId
              : input.reviewerGithubUserId,
          reviewerGithubLogin:
            input.reviewerGithubLogin === undefined
              ? current.reviewerGithubLogin
              : input.reviewerGithubLogin,
          authorizationPolicy:
            input.authorizationPolicy === undefined
              ? current.authorizationPolicy
              : input.authorizationPolicy,
          schedulingLimits: input.schedulingLimits ?? current.schedulingLimits,
        };
        assertReviewer(next);
        db.prepare(`UPDATE managed_repositories SET enabled = ?, version = version + 1,
        reviewer_github_user_id = ?, reviewer_github_login = ?, authorization_policy_json = ?,
        max_active_leases = ?, max_queued_jobs = ?, configuration_source = 'operator', updated_at = ?
        WHERE id = ? AND version = ?`).run(
          Number(next.enabled),
          next.reviewerGithubUserId,
          next.reviewerGithubLogin,
          next.authorizationPolicy === null ? null : JSON.stringify(next.authorizationPolicy),
          next.schedulingLimits.maxActiveLeases,
          next.schedulingLimits.maxQueuedJobs,
          now,
          repositoryId,
          input.expectedVersion,
        );
        const result = requireRepository(db, repositoryId);
        audit(db, result, "updated", actor, now);
        return result;
      });
    case "updateRepositoryConnection":
      return transaction(db, () => {
        const { repositoryId, status, message, metadata } = request.input;
        const current = requireRepository(db, repositoryId);
        if (
          !["unknown", "ready", "error"].includes(status) ||
          (message !== null &&
            (typeof message !== "string" ||
              !message ||
              message.length > 2_048 ||
              message.includes("\0")))
        )
          invalid("Connection status is invalid.");
        if (metadata) {
          validate(GitHubRepositorySchema, metadata);
          validate(ManagedRepositoryNameSchema, metadata.fullName);
          if (metadata.githubRepositoryId !== current.githubRepositoryId)
            invalid("Connection check returned a different repository.");
          const duplicate = db
            .prepare(
              "SELECT id FROM managed_repositories WHERE full_name = ? COLLATE NOCASE AND id <> ?",
            )
            .get(metadata.fullName, repositoryId);
          if (duplicate) conflict("The repository name belongs to another managed repository.");
        }
        db.prepare(`UPDATE managed_repositories SET connection_status = ?, connection_message = ?,
        full_name = ?, metadata_json = COALESCE(?, metadata_json), updated_at = ? WHERE id = ?`).run(
          status,
          message,
          metadata?.fullName ?? current.fullName,
          metadata ? JSON.stringify(metadata) : null,
          now,
          repositoryId,
        );
        return requireRepository(db, repositoryId);
      });
    case "bootstrapManagedRepositories":
      return transaction(db, () => {
        const input = request.input;
        validate(SelfOrAllowlistPolicySchema, input.authorizationPolicy);
        if (
          !Array.isArray(input.repositories) ||
          input.repositories.length > 100 ||
          input.repositories.length < 1 ||
          input.reviewer.githubUserId !== input.authorizationPolicy.schedulingTargetGithubUserId
        )
          invalid("Repository bootstrap configuration is invalid.");
        assertReviewer({
          reviewerGithubUserId: input.reviewer.githubUserId,
          reviewerGithubLogin: input.reviewer.login,
          authorizationPolicy: input.authorizationPolicy,
        });
        if (
          db
            .prepare(
              "SELECT bootstrap_key FROM repository_configuration_bootstrap WHERE bootstrap_key = 'github-environment-v1'",
            )
            .get()
        )
          return { imported: 0 };
        let imported = 0;
        for (const repository of input.repositories) {
          validate(RepositoryCreateRequestSchema, repository);
          const existing = db
            .prepare("SELECT * FROM managed_repositories WHERE github_repository_id = ?")
            .get(repository.githubRepositoryId) as RepositoryRow | undefined;
          if (existing?.configuration_source === "operator") continue;
          if (
            db
              .prepare(
                "SELECT id FROM managed_repositories WHERE full_name = ? COLLATE NOCASE AND github_repository_id <> ?",
              )
              .get(repository.fullName, repository.githubRepositoryId)
          )
            conflict("Repository bootstrap name conflicts with another identity.");
          const id = existing?.id ?? randomUUID();
          db.prepare(`INSERT INTO managed_repositories
          (id, github_repository_id, full_name, enabled, version, reviewer_github_user_id, reviewer_github_login,
          authorization_policy_json, connection_status, configuration_source, created_at, updated_at)
          VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'unknown', 'bootstrap', ?, ?)
          ON CONFLICT(github_repository_id) DO UPDATE SET full_name = excluded.full_name, enabled = 1,
            reviewer_github_user_id = excluded.reviewer_github_user_id, reviewer_github_login = excluded.reviewer_github_login,
            authorization_policy_json = excluded.authorization_policy_json, configuration_source = 'bootstrap',
            version = managed_repositories.version + 1, updated_at = excluded.updated_at`).run(
            id,
            repository.githubRepositoryId,
            repository.fullName,
            input.reviewer.githubUserId,
            input.reviewer.login,
            JSON.stringify(input.authorizationPolicy),
            now,
            now,
          );
          audit(
            db,
            requireRepository(db, id),
            "bootstrapped",
            { issuer: "system", subject: "github-environment-bootstrap" },
            now,
          );
          imported += 1;
        }
        db.prepare(
          "INSERT INTO repository_configuration_bootstrap (bootstrap_key, completed_at) VALUES ('github-environment-v1', ?)",
        ).run(now);
        return { imported };
      });
  }
}
