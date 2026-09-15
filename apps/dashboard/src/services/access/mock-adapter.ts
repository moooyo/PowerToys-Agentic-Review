import {
  type OperatorAccessContext,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type RepositoryAccessAudit,
  type RepositoryAccessChangeRequest,
  type RepositoryAccessChangeResponse,
  type RepositoryAccessGrant,
  RepositoryAccessGrantSchema,
} from "@agentic-review/contracts";
import { sampleRepositories } from "../repositories/mock-adapter";
import { ReviewControlHttpError, ReviewControlRequestError } from "../review-control/errors";
import type { AccessAdapter, AccessPageQuery } from "./adapter";
import {
  grantIsConsistent,
  normalizeAccessPage,
  principalKey,
  rolePermissions,
  validateAccessChange,
  validateAccessId,
  validateAccessRequest,
} from "./validation";

export const sampleOperatorPrincipal: Readonly<OperatorPrincipal> = {
  issuer: "urn:agentic-review:sample",
  subject: "development-operator",
};

export interface MockAccessAdapterOptions {
  readonly principal?: OperatorPrincipal;
  readonly platformAdministrator?: boolean;
  readonly grants?: readonly RepositoryAccessGrant[];
  readonly repositoryIds?: readonly string[];
  readonly repositoryExists?: (repositoryId: string) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

function failure(operation: string, status: 403 | 404 | 409, message: string): never {
  throw new ReviewControlHttpError(message, {
    operation,
    status,
    retryable: false,
    serverCode:
      status === 403
        ? "PLATFORM_FORBIDDEN"
        : status === 404
          ? "PLATFORM_NOT_FOUND"
          : "PLATFORM_CONFLICT",
  });
}

function grantKey(repositoryId: string, principal: OperatorPrincipal): string {
  return JSON.stringify([repositoryId, principalKey(principal)]);
}

function compareIdentityPart(left: string, right: string): number {
  // Unicode scalar order matches SQLite BINARY ordering for valid UTF-8 identities.
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export class MockAccessAdapter implements AccessAdapter {
  readonly mode = "sample" as const;
  private readonly principal: OperatorPrincipal;
  private readonly platformAdministrator: boolean;
  private readonly repositories: Set<string>;
  private readonly repositoryExists: (repositoryId: string) => boolean | Promise<boolean>;
  private readonly grants = new Map<string, RepositoryAccessGrant>();
  private readonly changes = new Map<
    string,
    { input: RepositoryAccessChangeRequest; change: RepositoryAccessAudit }
  >();
  private readonly now: () => Date;

  constructor(options: MockAccessAdapterOptions = {}) {
    const operation = "initialize sample access";
    this.principal = structuredClone(
      validateAccessRequest(
        OperatorPrincipalSchema,
        options.principal ?? sampleOperatorPrincipal,
        operation,
      ),
    );
    if (
      options.platformAdministrator !== undefined &&
      typeof options.platformAdministrator !== "boolean"
    )
      throw new ReviewControlRequestError(
        operation,
        "platformAdministrator",
        "The platform administrator option must be a boolean.",
      );
    this.platformAdministrator = options.platformAdministrator ?? true;
    if (options.repositoryExists !== undefined && options.repositoryIds !== undefined)
      throw new ReviewControlRequestError(
        operation,
        "repositoryIds",
        "Use either fixed repository IDs or a repository existence callback.",
      );
    this.repositories = new Set(
      options.repositoryIds ?? sampleRepositories.map((repository) => repository.id),
    );
    for (const repositoryId of this.repositories) validateAccessId(repositoryId, operation);
    this.repositoryExists =
      options.repositoryExists ?? ((repositoryId) => this.repositories.has(repositoryId));
    this.now = options.now ?? (() => new Date());
    for (const grant of options.grants ?? []) {
      validateAccessRequest(RepositoryAccessGrantSchema, grant, operation);
      const key = grantKey(grant.repositoryId, grant.principal);
      if (
        (options.repositoryExists === undefined && !this.repositories.has(grant.repositoryId)) ||
        this.grants.has(key) ||
        !grantIsConsistent(grant)
      )
        throw new ReviewControlRequestError(
          operation,
          "grants",
          "The sample access grants are inconsistent.",
        );
      this.grants.set(key, structuredClone(grant));
    }
  }

  async context(repositoryId?: string): Promise<OperatorAccessContext> {
    if (repositoryId !== undefined)
      await this.ensureRepositoryExists(repositoryId, "get operator access");
    return {
      principal: structuredClone(this.principal),
      platformAdministrator: this.platformAdministrator,
      repository:
        repositoryId === undefined
          ? null
          : this.requireCurrentPermission(repositoryId, "get operator access", false),
    };
  }

  async list(repositoryId: string, query?: AccessPageQuery) {
    const operation = "list repository access";
    const page = normalizeAccessPage(query, operation);
    await this.ensureRepositoryExists(repositoryId, operation);
    this.requireCurrentPermission(repositoryId, operation);
    const matches = [...this.grants.values()]
      .filter((grant) => grant.repositoryId === repositoryId)
      .sort((left, right) => {
        return (
          compareIdentityPart(left.principal.issuer, right.principal.issuer) ||
          compareIdentityPart(left.principal.subject, right.principal.subject)
        );
      });
    return {
      repositoryId,
      ...page,
      total: matches.length,
      items: structuredClone(
        matches.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
      ),
    };
  }

  async history(repositoryId: string, query?: AccessPageQuery) {
    const operation = "list repository access history";
    const page = normalizeAccessPage(query, operation);
    await this.ensureRepositoryExists(repositoryId, operation);
    this.requireCurrentPermission(repositoryId, operation);
    const matches = [...this.changes.values()]
      .map((record) => record.change)
      .filter((change) => change.repositoryId === repositoryId)
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
        return left.id > right.id ? -1 : left.id < right.id ? 1 : 0;
      });
    return {
      repositoryId,
      ...page,
      total: matches.length,
      items: structuredClone(
        matches.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
      ),
    };
  }

  async change(
    repositoryId: string,
    request: RepositoryAccessChangeRequest,
  ): Promise<RepositoryAccessChangeResponse> {
    const operation = "change repository access";
    validateAccessId(repositoryId, operation);
    const input = structuredClone(validateAccessChange(request, operation));
    await this.ensureRepositoryExists(repositoryId, operation);
    // Keep authorization and the write in one synchronous continuation after the lookup.
    this.requireCurrentPermission(repositoryId, operation);
    const key = JSON.stringify([repositoryId, input.changeId]);
    const existing = this.changes.get(key);
    if (existing) {
      const prior = existing.input;
      if (
        principalKey(prior.principal) !== principalKey(input.principal) ||
        prior.role !== input.role ||
        prior.expectedVersion !== input.expectedVersion ||
        prior.reason !== input.reason
      )
        failure(operation, 409, "This access change identifier belongs to another request.");
      return { change: structuredClone(existing.change), replayed: true };
    }
    const membershipKey = grantKey(repositoryId, input.principal);
    const current = this.grants.get(membershipKey);
    if ((current?.version ?? 0) !== input.expectedVersion)
      failure(operation, 409, "Repository access changed. Reload before saving.");
    if (input.expectedVersion === Number.MAX_SAFE_INTEGER)
      failure(operation, 409, "The repository access version is exhausted.");
    const timestamp = this.now().toISOString();
    if (current && Date.parse(current.updatedAt) > Date.parse(timestamp))
      failure(operation, 409, "The access change timestamp precedes the current grant.");
    if (
      current?.role === "admin" &&
      input.role !== "admin" &&
      !this.platformAdministrator &&
      ![...this.grants.entries()].some(
        ([grantId, grant]) =>
          grantId !== membershipKey &&
          grant.repositoryId === repositoryId &&
          grant.role === "admin",
      )
    )
      failure(
        operation,
        409,
        "A repository administrator cannot remove the last repository administrator.",
      );
    const change: RepositoryAccessAudit = {
      id: globalThis.crypto.randomUUID(),
      repositoryId,
      changeId: input.changeId,
      principal: structuredClone(input.principal),
      actor: structuredClone(this.principal),
      previousRole: current?.role ?? null,
      role: input.role,
      previousVersion: input.expectedVersion,
      version: input.expectedVersion + 1,
      reason: input.reason,
      createdAt: timestamp,
    };
    const grant: RepositoryAccessGrant = {
      repositoryId,
      principal: structuredClone(input.principal),
      role: input.role,
      version: change.version,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      updatedBy: structuredClone(this.principal),
    };
    this.grants.set(membershipKey, grant);
    this.changes.set(key, { input: structuredClone(input), change });
    return { change: structuredClone(change), replayed: false };
  }

  private async ensureRepositoryExists(repositoryId: string, operation: string): Promise<void> {
    validateAccessId(repositoryId, operation);
    if ((await this.repositoryExists(repositoryId)) !== true)
      failure(operation, 404, "The repository was not found.");
  }

  private requireCurrentPermission(
    repositoryId: string,
    operation: string,
    manage = true,
  ): NonNullable<OperatorAccessContext["repository"]> {
    if (this.platformAdministrator)
      return {
        repositoryId,
        role: "admin",
        source: "platform",
        permissions: [...rolePermissions.admin],
      };
    const grant = this.grants.get(grantKey(repositoryId, this.principal));
    if (!grant || grant.role === null) failure(operation, 404, "The repository was not found.");
    if (manage && !rolePermissions[grant.role].includes("manage_access"))
      failure(operation, 403, "The operator does not have permission for this action.");
    return {
      repositoryId,
      role: grant.role,
      source: "repository",
      permissions: [...rolePermissions[grant.role]],
    };
  }
}
