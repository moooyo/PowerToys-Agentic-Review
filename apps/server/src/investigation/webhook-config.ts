import { EntityIdSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";

export interface InvestigationWebhookBinding {
  readonly repositoryId: string;
  readonly reviewerUserId: number;
  readonly allowedActorUserIds: readonly number[];
  readonly e2eEnabled?: boolean;
  /** Internal effective setting for static review requests and assignment fallback. */
  readonly assignmentsEnabled?: boolean;
}

export interface InvestigationWebhookConfig {
  readonly secret: string;
  readonly maximumPayloadBytes: number;
  readonly bindings: readonly InvestigationWebhookBinding[];
}

const maximumBindings = 1_024;
const maximumAllowedActors = 1_024;
const maximumBodyBytes = 32 * 1_024 * 1_024;
const bindingKeys = new Set([
  "repositoryId",
  "reviewerUserId",
  "allowedActorUserIds",
  "e2eEnabled",
]);

function isPositiveGitHubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseInvestigationWebhookConfig(
  secret: string | undefined,
  value: unknown,
  maximumPayloadBytes: number,
): InvestigationWebhookConfig | undefined {
  if (secret === undefined && value === undefined) return undefined;
  if (secret === undefined) {
    throw new Error("GitHub webhook repository bindings require a configured secret.");
  }
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    Buffer.byteLength(secret, "utf8") > 4_096 ||
    secret.trim() !== secret
  ) {
    throw new Error(
      "GitHub webhook secret must contain 32 to 4096 UTF-8 bytes without surrounding whitespace.",
    );
  }
  if (
    !Number.isSafeInteger(maximumPayloadBytes) ||
    maximumPayloadBytes < 1 ||
    maximumPayloadBytes > maximumBodyBytes
  ) {
    throw new Error("GitHub webhook payload limit must be an integer from 1 to 33554432 bytes.");
  }
  const entries = value === undefined ? [] : value;
  if (!Array.isArray(entries) || entries.length > maximumBindings) {
    throw new Error("GitHub webhook bindings must contain at most 1024 repository objects.");
  }

  const repositoryIds = new Set<string>();
  const bindings: InvestigationWebhookBinding[] = [];
  for (const entry of entries as unknown[]) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      (Object.keys(entry).length !== 3 && Object.keys(entry).length !== 4) ||
      Object.keys(entry).some((key) => !bindingKeys.has(key))
    ) {
      throw new Error(
        "Each GitHub webhook binding must contain exactly repositoryId, reviewerUserId, and allowedActorUserIds.",
      );
    }
    const binding = entry as Record<string, unknown>;
    if (binding.e2eEnabled !== undefined && typeof binding.e2eEnabled !== "boolean")
      throw new Error("GitHub webhook e2eEnabled must be a boolean when configured.");
    const repositoryId = binding.repositoryId;
    if (typeof repositoryId !== "string" || !Value.Check(EntityIdSchema, repositoryId)) {
      throw new Error("GitHub webhook repositoryId must be a valid exact entity ID.");
    }
    if (repositoryIds.has(repositoryId)) {
      throw new Error("GitHub webhook repository bindings must have unique repository IDs.");
    }
    repositoryIds.add(repositoryId);
    if (!isPositiveGitHubId(binding.reviewerUserId)) {
      throw new Error("GitHub webhook reviewerUserId must be a positive safe numeric GitHub ID.");
    }
    if (
      !Array.isArray(binding.allowedActorUserIds) ||
      binding.allowedActorUserIds.length < 1 ||
      binding.allowedActorUserIds.length > maximumAllowedActors
    ) {
      throw new Error("GitHub webhook allowedActorUserIds must contain 1 to 1024 GitHub IDs.");
    }
    const actors: number[] = [];
    for (const actor of binding.allowedActorUserIds as unknown[]) {
      if (!isPositiveGitHubId(actor)) {
        throw new Error(
          "GitHub webhook allowedActorUserIds must contain positive safe numeric GitHub IDs.",
        );
      }
      actors.push(actor);
    }
    if (new Set(actors).size !== actors.length) {
      throw new Error("GitHub webhook allowedActorUserIds must contain unique GitHub IDs.");
    }
    bindings.push(
      Object.freeze({
        repositoryId,
        reviewerUserId: binding.reviewerUserId,
        allowedActorUserIds: Object.freeze(actors),
        ...(binding.e2eEnabled === undefined ? {} : { e2eEnabled: binding.e2eEnabled }),
      }),
    );
  }
  return Object.freeze({ secret, maximumPayloadBytes, bindings: Object.freeze(bindings) });
}
