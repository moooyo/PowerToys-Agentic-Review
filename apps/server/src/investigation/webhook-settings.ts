import { EntityIdSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationRepositoryRecord } from "./types.js";
import type { InvestigationWebhookBinding } from "./webhook-config.js";

export interface InvestigationWebhookSettingsUpdate {
  readonly version: number;
  readonly enabled: boolean;
  readonly reviewerUserId: number | null;
  readonly allowedActorUserIds: readonly number[];
  readonly e2eEnabled?: boolean;
}

export interface InvestigationWebhookSettingsView extends InvestigationWebhookSettingsUpdate {
  readonly repositoryId: string;
  readonly receiverConfigured: boolean;
}

interface StoredWebhookSettings extends InvestigationWebhookSettingsUpdate {
  readonly repositoryId: string;
}

const requestKeys = new Set([
  "version",
  "enabled",
  "reviewerUserId",
  "allowedActorUserIds",
  "e2eEnabled",
]);

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateRequest(input: unknown, statusCode = 400): InvestigationWebhookSettingsUpdate {
  const code = statusCode === 400 ? "invalid_webhook_settings" : "invalid_saved_webhook_settings";
  const message =
    statusCode === 400
      ? "Webhook settings require an exact version, enabled flag, optional numeric reviewer ID, and unique numeric trusted user IDs."
      : "The saved webhook settings are invalid.";
  requireCondition(
    input !== null &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (Object.keys(input).length === 4 || Object.keys(input).length === 5) &&
      Object.keys(input).every((key) => requestKeys.has(key)),
    statusCode,
    code,
    message,
  );
  const request = input as Record<string, unknown>;
  requireCondition(
    typeof request.version === "number" &&
      Number.isSafeInteger(request.version) &&
      request.version >= 0 &&
      typeof request.enabled === "boolean" &&
      (request.e2eEnabled === undefined || typeof request.e2eEnabled === "boolean") &&
      (request.reviewerUserId === null || isPositiveId(request.reviewerUserId)) &&
      Array.isArray(request.allowedActorUserIds) &&
      request.allowedActorUserIds.length <= 1_024,
    statusCode,
    code,
    message,
  );
  const actors: number[] = [];
  for (const id of request.allowedActorUserIds as unknown[]) {
    requireCondition(isPositiveId(id), statusCode, code, message);
    actors.push(id);
  }
  requireCondition(
    new Set(actors).size === actors.length &&
      (!(request.enabled || request.e2eEnabled === true) ||
        (request.reviewerUserId !== null && actors.length > 0)),
    statusCode,
    code,
    message,
  );
  return {
    version: request.version,
    enabled: request.enabled,
    reviewerUserId: request.reviewerUserId,
    allowedActorUserIds: actors,
    ...(request.e2eEnabled === undefined ? {} : { e2eEnabled: request.e2eEnabled }),
  };
}

/** Repository settings override deployment defaults without storing the receiver secret. */
export class InvestigationWebhookSettings {
  readonly #store: InvestigationStore;
  readonly #defaults: ReadonlyMap<string, InvestigationWebhookSettingsUpdate>;
  readonly #receiverConfigured: boolean;

  constructor(
    store: InvestigationStore,
    defaultBindings: readonly InvestigationWebhookBinding[] = [],
    receiverConfigured = false,
  ) {
    this.#store = store;
    this.#receiverConfigured = receiverConfigured;
    requireCondition(
      Array.isArray(defaultBindings) && defaultBindings.length <= 1_024,
      500,
      "invalid_webhook_defaults",
      "Webhook defaults must contain at most 1024 repository bindings.",
    );
    const defaults = new Map<string, InvestigationWebhookSettingsUpdate>();
    for (const binding of defaultBindings) {
      requireCondition(
        binding !== null &&
          typeof binding === "object" &&
          Value.Check(EntityIdSchema, binding.repositoryId) &&
          !defaults.has(binding.repositoryId),
        500,
        "invalid_webhook_defaults",
        "Webhook defaults require unique exact repository IDs.",
      );
      defaults.set(
        binding.repositoryId,
        validateRequest(
          {
            version: 0,
            enabled: true,
            reviewerUserId: binding.reviewerUserId,
            allowedActorUserIds: binding.allowedActorUserIds,
            ...(binding.e2eEnabled === undefined ? {} : { e2eEnabled: binding.e2eEnabled }),
          },
          500,
        ),
      );
    }
    this.#defaults = defaults;
  }

  read(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
  ): InvestigationWebhookSettingsView {
    this.#scope(actor, repositoryId);
    this.#registered(repositoryId);
    return this.#view(repositoryId, this.#effective(repositoryId));
  }

  update(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    request: InvestigationWebhookSettingsUpdate,
  ): InvestigationWebhookSettingsView {
    this.#scope(actor, repositoryId);
    requireCondition(
      actor.permissions.includes("repository:manage"),
      403,
      "permission_denied",
      "Updating webhook settings requires repository:manage.",
    );
    this.#registered(repositoryId);
    const parsed = validateRequest(request);
    return this.#store.transaction(() => {
      this.#registered(repositoryId);
      const previous = this.#effective(repositoryId);
      requireCondition(
        previous.version === parsed.version,
        409,
        "webhook_settings_conflict",
        "Webhook settings changed. Reload the current settings before saving.",
      );
      requireCondition(
        previous.version < Number.MAX_SAFE_INTEGER,
        409,
        "webhook_settings_version_exhausted",
        "Webhook settings cannot advance beyond the maximum safe version.",
      );
      const next: StoredWebhookSettings = {
        repositoryId,
        version: previous.version + 1,
        enabled: parsed.enabled,
        reviewerUserId: parsed.reviewerUserId,
        allowedActorUserIds: [...parsed.allowedActorUserIds],
        ...(parsed.e2eEnabled === undefined ? {} : { e2eEnabled: parsed.e2eEnabled }),
      };
      this.#store.put("idempotency", `webhook:settings:${repositoryId}`, next);
      return this.#view(repositoryId, next);
    });
  }

  bindings(): readonly InvestigationWebhookBinding[] {
    const bindings: InvestigationWebhookBinding[] = [];
    for (const repository of this.#store.list<InvestigationRepositoryRecord>("repositories")) {
      const settings = this.#effective(repository.id);
      if ((settings.enabled || settings.e2eEnabled === true) && settings.reviewerUserId !== null) {
        bindings.push({
          repositoryId: repository.id,
          reviewerUserId: settings.reviewerUserId,
          allowedActorUserIds: [...settings.allowedActorUserIds],
          ...(settings.e2eEnabled === undefined ? {} : { e2eEnabled: settings.e2eEnabled }),
          ...(!settings.enabled ? { assignmentsEnabled: false } : {}),
        });
      }
    }
    return bindings;
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

  #registered(repositoryId: string): void {
    requireCondition(
      this.#store.has("repositories", repositoryId),
      404,
      "not_found",
      "The requested repository does not exist.",
    );
  }

  #effective(repositoryId: string): InvestigationWebhookSettingsUpdate {
    const saved = this.#store.get<StoredWebhookSettings>(
      "idempotency",
      `webhook:settings:${repositoryId}`,
    );
    if (saved !== undefined) {
      requireCondition(
        saved !== null &&
          typeof saved === "object" &&
          !Array.isArray(saved) &&
          (Object.keys(saved).length === 5 || Object.keys(saved).length === 6) &&
          Object.keys(saved).every((key) => key === "repositoryId" || requestKeys.has(key)) &&
          saved.repositoryId === repositoryId &&
          saved.version > 0,
        500,
        "invalid_saved_webhook_settings",
        "The saved webhook settings are invalid.",
      );
      return validateRequest(
        {
          version: saved.version,
          enabled: saved.enabled,
          reviewerUserId: saved.reviewerUserId,
          allowedActorUserIds: saved.allowedActorUserIds,
          ...(saved.e2eEnabled === undefined ? {} : { e2eEnabled: saved.e2eEnabled }),
        },
        500,
      );
    }
    return (
      this.#defaults.get(repositoryId) ?? {
        version: 0,
        enabled: false,
        reviewerUserId: null,
        allowedActorUserIds: [],
      }
    );
  }

  #view(
    repositoryId: string,
    settings: InvestigationWebhookSettingsUpdate,
  ): InvestigationWebhookSettingsView {
    return {
      repositoryId,
      enabled: settings.enabled,
      reviewerUserId: settings.reviewerUserId,
      allowedActorUserIds: [...settings.allowedActorUserIds],
      version: settings.version,
      receiverConfigured: this.#receiverConfigured,
      ...(settings.e2eEnabled === undefined ? {} : { e2eEnabled: settings.e2eEnabled }),
    };
  }
}
