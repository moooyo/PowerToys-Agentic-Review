import { EntityIdSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  automaticReplyTemplateVersion,
  defaultAutomaticReplyTemplates,
  validateAutomaticReplyTemplate,
} from "./auto-reply-template.js";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import {
  defaultProgressReplyTemplates,
  type ProgressReplyTemplates,
  validateProgressReplyTemplate,
} from "./progress-reply-template.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationRepositoryRecord } from "./types.js";

export interface AutomaticReplySettingsUpdate {
  readonly version: number;
  readonly enabled: boolean;
  readonly pullRequestTemplate: string;
  readonly issueTemplate: string;
  readonly progressEnabled?: boolean;
  readonly progressTemplates?: ProgressReplyTemplates;
  readonly reauthorize?: boolean;
}

interface NormalizedAutomaticReplySettingsUpdate
  extends Omit<AutomaticReplySettingsUpdate, "reauthorize"> {
  readonly progressEnabled: boolean;
  readonly progressTemplates: ProgressReplyTemplates;
}

export interface AutomaticReplySettingsView extends NormalizedAutomaticReplySettingsUpdate {
  readonly repositoryId: string;
  readonly publisherConfigured: boolean;
  readonly authorizedById: string | null;
  readonly authorizationEpoch: number;
  readonly updatedById: string | null;
  readonly updatedAt: string | null;
  readonly templateVersion: number;
}

export interface AutomaticReplyPolicy extends NormalizedAutomaticReplySettingsUpdate {
  readonly repository: InvestigationRepositoryRecord;
  readonly authorizedById: string;
  readonly authorizationEpoch: number;
  readonly updatedById: string | null;
  readonly updatedAt: string;
  readonly templateVersion: number;
}

interface StoredAutomaticReplySettings extends NormalizedAutomaticReplySettingsUpdate {
  readonly repository: InvestigationRepositoryRecord;
  readonly authorizedById: string | null;
  readonly authorizationEpoch: number;
  readonly updatedById: string | null;
  readonly updatedAt: string;
  readonly templateVersion: number;
}

const requestKeys = new Set(["version", "enabled", "pullRequestTemplate", "issueTemplate"]);
const optionalProgressKeys = new Set(["progressEnabled", "progressTemplates"]);
const optionalRequestKeys = new Set([...optionalProgressKeys, "reauthorize"]);
const optionalStoredKeys = new Set([...optionalProgressKeys, "authorizationEpoch", "updatedById"]);
const progressTemplateKeys = new Set(["received", "started", "failed", "completed"]);
const storedKeys = new Set([
  ...requestKeys,
  "repository",
  "authorizedById",
  "updatedAt",
  "templateVersion",
]);
const repositoryKeys = new Set(["id", "fullName", "githubRepositoryId"]);

function exactObject(
  input: unknown,
  keys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string> = new Set(),
): input is Record<string, unknown> {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    [...keys].every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => keys.has(key) || optionalKeys.has(key))
  );
}

function validateRequest(
  input: unknown,
  statusCode = 400,
  validateCurrentTemplate = true,
): NormalizedAutomaticReplySettingsUpdate {
  const code =
    statusCode === 400 ? "invalid_auto_reply_settings" : "invalid_saved_auto_reply_settings";
  const message =
    statusCode === 400
      ? "Automatic reply settings require an exact version, enabled flag, and valid PR and issue templates."
      : "The saved automatic reply settings are invalid.";
  requireCondition(exactObject(input, requestKeys, optionalRequestKeys), statusCode, code, message);
  requireCondition(
    typeof input.version === "number" &&
      Number.isSafeInteger(input.version) &&
      input.version >= 0 &&
      typeof input.enabled === "boolean" &&
      typeof input.pullRequestTemplate === "string" &&
      typeof input.issueTemplate === "string" &&
      (!Object.hasOwn(input, "reauthorize") || typeof input.reauthorize === "boolean") &&
      (!Object.hasOwn(input, "progressEnabled") || typeof input.progressEnabled === "boolean") &&
      (!Object.hasOwn(input, "progressTemplates") ||
        exactObject(input.progressTemplates, progressTemplateKeys)),
    statusCode,
    code,
    message,
  );
  requireCondition(
    input.reauthorize !== true || input.enabled,
    statusCode,
    code,
    "Renewing automatic reply authorization requires automatic replies to be enabled.",
  );
  const progressEnabled = input.progressEnabled === true;
  requireCondition(
    !progressEnabled || input.enabled,
    statusCode,
    code,
    "Assignment progress comments require automatic replies to be enabled.",
  );
  const progressTemplates = input.progressTemplates ?? defaultProgressReplyTemplates;
  let parsedProgressTemplates: ProgressReplyTemplates;
  try {
    const values = progressTemplates as Record<string, unknown>;
    parsedProgressTemplates = {
      received: validateProgressReplyTemplate(values.received, "received"),
      started: validateProgressReplyTemplate(values.started, "started"),
      failed: validateProgressReplyTemplate(values.failed, "failed"),
      completed: validateProgressReplyTemplate(values.completed, "completed"),
    };
  } catch (error) {
    if (statusCode !== 400 && error instanceof InvestigationRequestError)
      throw new InvestigationRequestError(statusCode, code, message);
    throw error;
  }
  if (!validateCurrentTemplate) {
    requireCondition(
      input.pullRequestTemplate.trim().length > 0 &&
        input.issueTemplate.trim().length > 0 &&
        Buffer.byteLength(input.pullRequestTemplate, "utf8") <= 12_000 &&
        Buffer.byteLength(input.issueTemplate, "utf8") <= 12_000,
      statusCode,
      code,
      message,
    );
    return {
      version: input.version,
      enabled: input.enabled,
      pullRequestTemplate: input.pullRequestTemplate,
      issueTemplate: input.issueTemplate,
      progressEnabled,
      progressTemplates: parsedProgressTemplates,
    };
  }
  try {
    return {
      version: input.version,
      enabled: input.enabled,
      pullRequestTemplate: validateAutomaticReplyTemplate(input.pullRequestTemplate),
      issueTemplate: validateAutomaticReplyTemplate(input.issueTemplate, "issue"),
      progressEnabled,
      progressTemplates: parsedProgressTemplates,
    };
  } catch (error) {
    if (statusCode !== 400 && error instanceof InvestigationRequestError)
      throw new InvestigationRequestError(statusCode, code, message);
    throw error;
  }
}

function validRepository(
  input: unknown,
  repositoryId: string,
): input is InvestigationRepositoryRecord {
  return (
    exactObject(input, repositoryKeys) &&
    input.id === repositoryId &&
    Value.Check(EntityIdSchema, input.id) &&
    typeof input.fullName === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.fullName) &&
    typeof input.githubRepositoryId === "number" &&
    Number.isSafeInteger(input.githubRepositoryId) &&
    input.githubRepositoryId > 0
  );
}

function matchesRepository(
  saved: InvestigationRepositoryRecord,
  current: InvestigationRepositoryRecord,
): boolean {
  return (
    saved.id === current.id &&
    saved.fullName === current.fullName &&
    saved.githubRepositoryId === current.githubRepositoryId
  );
}

function nextAuthorizationEpoch(previous: number): number {
  requireCondition(
    previous < Number.MAX_SAFE_INTEGER,
    409,
    "auto_reply_authorization_epoch_exhausted",
    "Automatic reply authorization cannot advance beyond the maximum safe epoch.",
  );
  return previous + 1;
}

/** Stores repository-scoped authorization without credentials or retroactive publication. */
export class InvestigationAutomaticReplySettings {
  readonly #store: InvestigationStore;
  readonly #publisherConfigured: boolean;
  readonly #now: () => Date;

  constructor(store: InvestigationStore, publisherConfigured = false, now?: () => Date) {
    this.#store = store;
    this.#publisherConfigured = publisherConfigured;
    this.#now = now ?? (() => new Date());
  }

  read(actor: InvestigationOperatorPrincipal, repositoryId: string): AutomaticReplySettingsView {
    this.#scope(actor, repositoryId);
    const repository = this.#registered(repositoryId);
    return this.#view(repository, this.#saved(repositoryId));
  }

  update(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    request: AutomaticReplySettingsUpdate,
  ): AutomaticReplySettingsView {
    this.#scope(actor, repositoryId);
    requireCondition(
      actor.permissions.includes("repository:manage"),
      403,
      "permission_denied",
      "Updating automatic reply settings requires repository:manage.",
    );
    this.#registered(repositoryId);
    const parsed = validateRequest(request);
    const reauthorize = request.reauthorize === true;
    if (parsed.enabled) {
      requireCondition(
        actor.permissions.includes("action:prepare") &&
          actor.permissions.includes("action:execute") &&
          actor.actionCapabilities.includes("comment"),
        403,
        "permission_denied",
        "Enabling automatic replies requires action:prepare, action:execute, and comment capability.",
      );
    }
    requireCondition(
      Value.Check(EntityIdSchema, actor.id),
      403,
      "permission_denied",
      "Automatic reply settings require an exact authorizing account identity.",
    );
    return this.#store.transaction(() => {
      const repository = this.#registered(repositoryId);
      const previous = this.#saved(repositoryId);
      const version = previous?.version ?? 0;
      requireCondition(
        version === parsed.version,
        409,
        "auto_reply_settings_conflict",
        "Automatic reply settings changed. Reload the current settings before saving.",
      );
      requireCondition(
        !parsed.enabled || previous === null || matchesRepository(previous.repository, repository),
        409,
        "auto_reply_repository_changed",
        "The repository identity changed. Save disabled settings before authorizing automatic replies again.",
      );
      requireCondition(
        version < Number.MAX_SAFE_INTEGER,
        409,
        "auto_reply_settings_version_exhausted",
        "Automatic reply settings cannot advance beyond the maximum safe version.",
      );
      const authorizationChanged =
        previous === null ||
        previous.enabled !== parsed.enabled ||
        previous.progressEnabled !== parsed.progressEnabled ||
        !matchesRepository(previous.repository, repository) ||
        (parsed.enabled && previous.templateVersion !== automaticReplyTemplateVersion) ||
        reauthorize;
      const authorizationEpoch = authorizationChanged
        ? nextAuthorizationEpoch(previous?.authorizationEpoch ?? 0)
        : previous.authorizationEpoch;
      const saved: StoredAutomaticReplySettings = {
        ...parsed,
        version: version + 1,
        repository: { ...repository },
        authorizedById: parsed.enabled
          ? authorizationChanged
            ? actor.id
            : previous.authorizedById
          : null,
        authorizationEpoch,
        updatedById: actor.id,
        updatedAt: this.#now().toISOString(),
        templateVersion: automaticReplyTemplateVersion,
      };
      this.#store.put("idempotency", `auto-reply:settings:${repositoryId}`, saved);
      return this.#view(repository, saved);
    });
  }

  /** The caller must include registration and this invalidation in one store transaction. */
  invalidateRepository(
    previous: InvestigationRepositoryRecord,
    next: InvestigationRepositoryRecord,
  ): void {
    if (matchesRepository(previous, next)) return;
    requireCondition(
      previous.id === next.id &&
        validRepository(previous, previous.id) &&
        validRepository(next, previous.id),
      500,
      "invalid_repository_invalidation",
      "Automatic reply invalidation requires exact repository identities with the same internal ID.",
    );
    const saved = this.#saved(previous.id);
    const version = saved?.version ?? 0;
    requireCondition(
      version < Number.MAX_SAFE_INTEGER,
      409,
      "auto_reply_settings_version_exhausted",
      "Automatic reply settings cannot advance beyond the maximum safe version.",
    );
    const invalidated: StoredAutomaticReplySettings = {
      version: version + 1,
      enabled: false,
      progressEnabled: false,
      progressTemplates: { ...(saved?.progressTemplates ?? defaultProgressReplyTemplates) },
      repository: { ...next },
      pullRequestTemplate:
        saved?.templateVersion === automaticReplyTemplateVersion
          ? saved.pullRequestTemplate
          : defaultAutomaticReplyTemplates.pullRequest,
      issueTemplate:
        saved?.templateVersion === automaticReplyTemplateVersion
          ? saved.issueTemplate
          : defaultAutomaticReplyTemplates.issue,
      authorizedById: null,
      authorizationEpoch: nextAuthorizationEpoch(saved?.authorizationEpoch ?? 0),
      updatedById: saved?.updatedById ?? null,
      updatedAt: this.#now().toISOString(),
      templateVersion: automaticReplyTemplateVersion,
    };
    this.#store.put("idempotency", `auto-reply:settings:${previous.id}`, invalidated);
  }

  policy(repositoryId: string): AutomaticReplyPolicy | null {
    const repository = this.#store.get<InvestigationRepositoryRecord>("repositories", repositoryId);
    if (repository === undefined) return null;
    requireCondition(
      validRepository(repository, repositoryId),
      500,
      "invalid_repository_record",
      "The registered repository identity is invalid.",
    );
    const saved = this.#saved(repositoryId);
    if (
      saved === null ||
      !saved.enabled ||
      saved.authorizedById === null ||
      !matchesRepository(saved.repository, repository) ||
      saved.templateVersion !== automaticReplyTemplateVersion
    )
      return null;
    return { ...saved, repository: { ...saved.repository }, authorizedById: saved.authorizedById };
  }

  #scope(actor: InvestigationOperatorPrincipal, repositoryId: string): void {
    requireCondition(
      typeof repositoryId === "string" && Value.Check(EntityIdSchema, repositoryId),
      400,
      "invalid_repository_id",
      "The repository ID must be a valid exact entity ID.",
    );
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
  }

  #registered(repositoryId: string): InvestigationRepositoryRecord {
    const repository = this.#store.get<InvestigationRepositoryRecord>("repositories", repositoryId);
    requireCondition(
      repository !== undefined,
      404,
      "not_found",
      "The requested repository does not exist.",
    );
    requireCondition(
      validRepository(repository, repositoryId),
      500,
      "invalid_repository_record",
      "The registered repository identity is invalid.",
    );
    return repository;
  }

  #saved(repositoryId: string): StoredAutomaticReplySettings | null {
    const saved = this.#store.get<unknown>("idempotency", `auto-reply:settings:${repositoryId}`);
    if (saved === undefined) return null;
    requireCondition(
      exactObject(saved, storedKeys, optionalStoredKeys) &&
        validRepository(saved.repository, repositoryId) &&
        (saved.enabled === true
          ? Value.Check(EntityIdSchema, saved.authorizedById)
          : saved.authorizedById === null) &&
        typeof saved.updatedAt === "string" &&
        Number.isFinite(Date.parse(saved.updatedAt)) &&
        typeof saved.templateVersion === "number" &&
        Number.isSafeInteger(saved.templateVersion) &&
        saved.templateVersion > 0 &&
        typeof saved.version === "number" &&
        saved.version > 0 &&
        (!Object.hasOwn(saved, "authorizationEpoch") ||
          (typeof saved.authorizationEpoch === "number" &&
            Number.isSafeInteger(saved.authorizationEpoch) &&
            saved.authorizationEpoch > 0)) &&
        (!Object.hasOwn(saved, "updatedById") ||
          saved.updatedById === null ||
          Value.Check(EntityIdSchema, saved.updatedById)),
      500,
      "invalid_saved_auto_reply_settings",
      "The saved automatic reply settings are invalid.",
    );
    const parsed = validateRequest(
      {
        version: saved.version,
        enabled: saved.enabled,
        pullRequestTemplate: saved.pullRequestTemplate,
        issueTemplate: saved.issueTemplate,
        ...(Object.hasOwn(saved, "progressEnabled")
          ? { progressEnabled: saved.progressEnabled }
          : {}),
        ...(Object.hasOwn(saved, "progressTemplates")
          ? { progressTemplates: saved.progressTemplates }
          : {}),
      },
      500,
      saved.templateVersion === automaticReplyTemplateVersion,
    );
    return {
      ...parsed,
      repository: { ...saved.repository },
      authorizedById: saved.authorizedById as string | null,
      // Preserve the historical grant binding without migrating records during reads.
      authorizationEpoch: (saved.authorizationEpoch ?? saved.version) as number,
      updatedById: (saved.updatedById ?? null) as string | null,
      updatedAt: saved.updatedAt,
      templateVersion: saved.templateVersion,
    };
  }

  #view(
    repository: InvestigationRepositoryRecord,
    saved: StoredAutomaticReplySettings | null,
  ): AutomaticReplySettingsView {
    const enabled =
      saved !== null &&
      saved.enabled &&
      matchesRepository(saved.repository, repository) &&
      saved.templateVersion === automaticReplyTemplateVersion;
    return {
      repositoryId: repository.id,
      publisherConfigured: this.#publisherConfigured,
      version: saved?.version ?? 0,
      enabled,
      progressEnabled: enabled && saved?.progressEnabled === true,
      progressTemplates: { ...(saved?.progressTemplates ?? defaultProgressReplyTemplates) },
      pullRequestTemplate:
        saved?.templateVersion === automaticReplyTemplateVersion
          ? saved.pullRequestTemplate
          : defaultAutomaticReplyTemplates.pullRequest,
      issueTemplate:
        saved?.templateVersion === automaticReplyTemplateVersion
          ? saved.issueTemplate
          : defaultAutomaticReplyTemplates.issue,
      authorizedById: enabled ? (saved?.authorizedById ?? null) : null,
      authorizationEpoch: saved?.authorizationEpoch ?? 0,
      updatedById: saved?.updatedById ?? null,
      updatedAt: saved?.updatedAt ?? null,
      templateVersion: automaticReplyTemplateVersion,
    };
  }
}
