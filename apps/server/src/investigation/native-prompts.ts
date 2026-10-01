import { createHash, randomUUID } from "node:crypto";
import {
  type InvestigationNativePromptBinding,
  InvestigationNativePromptBindingSchema,
  type InvestigationNativePromptBindRequest,
  InvestigationNativePromptBindRequestSchema,
  type InvestigationNativePromptCatalog,
  type InvestigationNativePromptKind,
  InvestigationNativePromptKindSchema,
  type InvestigationNativePromptPublishRequest,
  InvestigationNativePromptPublishRequestSchema,
  type InvestigationNativePromptSnapshot,
  type InvestigationNativePromptVersion,
  InvestigationNativePromptVersionSchema,
  maximumNativePromptContentBytes,
  nativePromptBuiltInContent,
  nativePromptRuntimeConstraints,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationRepositoryRecord } from "./types.js";

const kinds = ["pr-review", "issue-investigate"] as const;
const prefix = "native-prompt:";
const versionPrefix = (repositoryId: string, kind: InvestigationNativePromptKind) =>
  `${prefix}version:${repositoryId}:${kind}:`;
const bindingKey = (repositoryId: string, kind: InvestigationNativePromptKind) =>
  `${prefix}binding:${repositoryId}:${kind}`;
const ref = ({ id, version, digest }: InvestigationNativePromptVersion) => ({
  id,
  version,
  digest,
});

/** Immutable native review templates and repository bindings never update legacy prompt settings. */
export class InvestigationNativePrompts {
  constructor(
    private readonly store: InvestigationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {
    if (!FormatRegistry.Has("date-time")) {
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
    }
  }

  catalog(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
  ): InvestigationNativePromptCatalog {
    this.authorize(actor, repositoryId, false);
    return this.atomic(() => ({
      repositoryId,
      items: kinds.map((kind) => {
        const versions = this.versions(repositoryId, kind);
        return {
          kind,
          versions,
          binding: this.binding(repositoryId, kind, versions),
          runtimeConstraints: nativePromptRuntimeConstraints({
            kind,
            analysisTask: true,
            snapshotOnly: true,
            autonomousSnapshot: kind === "issue-investigate",
            recipeGuidance: ["{{task_recipe_guidance}}"],
            baselineGuidance: ["{{frozen_prior_review_baseline_guidance}}"],
          }),
        };
      }),
    }));
  }

  publish(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    kind: InvestigationNativePromptKind,
    request: InvestigationNativePromptPublishRequest,
  ): InvestigationNativePromptVersion {
    this.authorize(actor, repositoryId, true);
    this.requireKind(kind);
    requireCondition(
      Value.Check(InvestigationNativePromptPublishRequestSchema, request) &&
        request.name.trim().length > 0 &&
        Object.values(request.content).every((content) => content.trim().length > 0) &&
        Buffer.byteLength(JSON.stringify(request.content), "utf8") <=
          maximumNativePromptContentBytes,
      400,
      "native_prompt_invalid",
      "Native prompt versions require a name and non-empty templates within the content limit.",
    );
    return this.atomic(() => {
      const versions = this.versions(repositoryId, kind);
      requireCondition(
        versions[0]!.version === request.expectedVersion,
        409,
        "native_prompt_version_conflict",
        "The native prompt catalog changed; refresh before publishing.",
      );
      requireCondition(
        versions.length < 250,
        409,
        "native_prompt_catalog_full",
        "This native prompt catalog reached its version limit.",
      );
      const content = structuredClone(request.content);
      const version: InvestigationNativePromptVersion = {
        repositoryId,
        kind,
        id: this.idFactory(),
        version: request.expectedVersion + 1,
        digest: investigationContentDigest(content),
        name: request.name.trim(),
        content,
        createdAt: this.now().toISOString(),
        createdBy: actor.id,
      };
      this.validateVersion(version, repositoryId, kind);
      this.store.insert(
        "idempotency",
        `${versionPrefix(repositoryId, kind)}${version.id}`,
        version,
      );
      return structuredClone(version);
    });
  }

  bind(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    kind: InvestigationNativePromptKind,
    request: InvestigationNativePromptBindRequest,
  ): InvestigationNativePromptBinding {
    this.authorize(actor, repositoryId, true);
    this.requireKind(kind);
    requireCondition(
      Value.Check(InvestigationNativePromptBindRequestSchema, request),
      400,
      "native_prompt_binding_invalid",
      "Native prompt bindings require an exact catalog reference and binding version.",
    );
    return this.atomic(() => {
      const versions = this.versions(repositoryId, kind);
      const previous = this.binding(repositoryId, kind, versions);
      requireCondition(
        previous.version === request.expectedVersion,
        409,
        "native_prompt_binding_conflict",
        "The native prompt binding changed; refresh before switching versions.",
      );
      this.resolve(versions, request.promptRef);
      const next: InvestigationNativePromptBinding = {
        version: previous.version + 1,
        promptRef: structuredClone(request.promptRef),
        updatedAt: this.now().toISOString(),
        updatedBy: actor.id,
      };
      this.store.put("idempotency", bindingKey(repositoryId, kind), next);
      this.store.insert("idempotency", `${prefix}audit:${repositoryId}:${kind}:${next.version}`, {
        repositoryId,
        kind,
        previousPromptRef: previous.promptRef,
        ...next,
      });
      return structuredClone(next);
    });
  }

  /** Task creation freezes content once; later binding changes cannot alter existing tasks. */
  freeze(
    repositoryId: string,
    kind: InvestigationNativePromptKind,
    requestedRef?: InvestigationNativePromptSnapshot["ref"],
  ): InvestigationNativePromptSnapshot {
    this.requireRepository(repositoryId);
    this.requireKind(kind);
    return this.atomic(() => {
      const versions = this.versions(repositoryId, kind);
      const selected = this.resolve(
        versions,
        requestedRef ?? this.binding(repositoryId, kind, versions).promptRef,
      );
      return { kind, ref: ref(selected), content: structuredClone(selected.content) };
    });
  }

  private versions(
    repositoryId: string,
    kind: InvestigationNativePromptKind,
  ): InvestigationNativePromptVersion[] {
    const key = versionPrefix(repositoryId, kind);
    const stored = this.store.pagePrefix<InvestigationNativePromptVersion>("idempotency", key, 251);
    requireCondition(
      stored.length <= 250,
      500,
      "native_prompt_catalog_corrupt",
      "The stored native prompt catalog exceeds its version limit.",
    );
    for (const version of stored) this.validateVersion(version, repositoryId, kind);
    if (stored.length === 0) {
      const content = nativePromptBuiltInContent(kind);
      const initial: InvestigationNativePromptVersion = {
        repositoryId,
        kind,
        id: `native-${kind}-${createHash("sha256").update(repositoryId).digest("hex").slice(0, 16)}-v1`,
        version: 1,
        digest: investigationContentDigest(content),
        name: "Built-in review prompt",
        content,
        createdAt: this.now().toISOString(),
        createdBy: null,
      };
      this.store.insert("idempotency", `${key}${initial.id}`, initial);
      stored.push(initial);
    }
    return stored.sort((left, right) => right.version - left.version);
  }

  private binding(
    repositoryId: string,
    kind: InvestigationNativePromptKind,
    versions: readonly InvestigationNativePromptVersion[],
  ): InvestigationNativePromptBinding {
    const stored = this.store.get<InvestigationNativePromptBinding>(
      "idempotency",
      bindingKey(repositoryId, kind),
    );
    if (stored !== undefined) {
      requireCondition(
        Value.Check(InvestigationNativePromptBindingSchema, stored),
        500,
        "native_prompt_binding_corrupt",
        "The stored native prompt binding is invalid.",
      );
      this.resolve(versions, stored.promptRef);
      return structuredClone(stored);
    }
    return {
      version: 0,
      promptRef: ref(versions.find((version) => version.version === 1)!),
      updatedAt: null,
      updatedBy: null,
    };
  }

  private resolve(
    versions: readonly InvestigationNativePromptVersion[],
    requestedRef: InvestigationNativePromptSnapshot["ref"],
  ): InvestigationNativePromptVersion {
    const selected = versions.find(
      (version) =>
        version.id === requestedRef.id &&
        version.version === requestedRef.version &&
        version.digest === requestedRef.digest,
    );
    requireCondition(
      selected !== undefined,
      409,
      "native_prompt_reference_unavailable",
      "The exact native prompt version is unavailable for this repository and review type.",
    );
    return selected;
  }

  private validateVersion(
    version: InvestigationNativePromptVersion,
    repositoryId: string,
    kind: InvestigationNativePromptKind,
  ): void {
    requireCondition(
      Value.Check(InvestigationNativePromptVersionSchema, version) &&
        version.repositoryId === repositoryId &&
        version.kind === kind &&
        version.digest === investigationContentDigest(version.content),
      500,
      "native_prompt_version_corrupt",
      "The stored native prompt version is invalid.",
    );
  }

  private requireKind(kind: InvestigationNativePromptKind): void {
    requireCondition(
      Value.Check(InvestigationNativePromptKindSchema, kind),
      400,
      "native_prompt_kind_invalid",
      "Native prompt management supports only PR review and Issue investigation.",
    );
  }

  private requireRepository(repositoryId: string): void {
    requireCondition(
      this.store.get<InvestigationRepositoryRecord>("repositories", repositoryId) !== undefined,
      404,
      "repository_not_found",
      "The repository is not registered.",
    );
  }

  private authorize(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    write: boolean,
  ): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId) &&
        (!write || actor.permissions.includes("repository:manage")),
      403,
      "native_prompt_access_denied",
      "Native prompt access requires repository membership; changes require repository management permission.",
    );
    this.requireRepository(repositoryId);
  }

  private atomic<T>(operation: () => T): T {
    return this.store.inTransaction ? operation() : this.store.transaction(operation);
  }
}
