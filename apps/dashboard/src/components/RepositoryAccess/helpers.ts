import type {
  OperatorAccessContext,
  OperatorPrincipal,
  OperatorRepositoryRole,
  RepositoryAccessChangeRequest,
  RepositoryAccessChangeResponse,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { ReviewControlHttpError } from "../../services/review-control/errors";

export const repositoryRoleLabels: Record<OperatorRepositoryRole, string> = {
  viewer: "Viewer",
  reviewer: "Reviewer",
  maintainer: "Maintainer",
  admin: "Admin",
};

export const repositoryRoleDescriptions: Record<OperatorRepositoryRole, string> = {
  viewer: "Read repository data",
  reviewer: "Read and review",
  maintainer: "Read, review, and configure",
  admin: "Read, review, configure, and manage access",
};

export interface AccessChangeDraft {
  readonly repositoryId: string;
  readonly principal: OperatorPrincipal;
  readonly role: OperatorRepositoryRole | null;
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface AccessNotice {
  readonly title: string;
  readonly description: string;
  readonly kind: "denied" | "conflict" | "error";
}

export function principalKey(principal: OperatorPrincipal): string {
  return JSON.stringify([principal.issuer, principal.subject]);
}

export function samePrincipal(left: OperatorPrincipal, right: OperatorPrincipal): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}

export function repositoryAccessQueryKey(
  mode: "sample" | "connected",
  repositoryId: string,
  principal: OperatorPrincipal,
) {
  return ["repository-access", mode, repositoryId, principal.issuer, principal.subject] as const;
}

export function canManageRepositoryAccess(
  context: OperatorAccessContext | undefined,
  repositoryId: string,
  principal: OperatorPrincipal,
): boolean {
  return Boolean(
    context &&
      samePrincipal(context.principal, principal) &&
      context.repository?.repositoryId === repositoryId &&
      context.repository.permissions.includes("manage_access") &&
      (context.repository.source !== "platform" || context.platformAdministrator),
  );
}

export function expectedAccessVersion(grant: RepositoryAccessGrant | null): number {
  return grant === null ? 0 : grant.version;
}

function validateDraft(draft: AccessChangeDraft): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(draft.repositoryId)) {
    throw new Error("A valid repository identifier is required.");
  }
  if (draft.principal.issuer.length === 0 || draft.principal.issuer.length > 2_048) {
    throw new Error("Issuer must contain between 1 and 2,048 characters.");
  }
  if (draft.principal.subject.length === 0 || draft.principal.subject.length > 512) {
    throw new Error("Subject must contain between 1 and 512 characters.");
  }
  if (draft.role !== null && !Object.hasOwn(repositoryRoleLabels, draft.role)) {
    throw new Error("Select a repository role.");
  }
  if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 0) {
    throw new Error("The membership version is unavailable. Reload members before editing.");
  }
  if (draft.reason.trim().length === 0 || draft.reason.length > 2_048) {
    throw new Error("Enter a reason containing no more than 2,048 characters.");
  }
}

function intentKey(draft: AccessChangeDraft): string {
  return JSON.stringify([
    draft.repositoryId,
    draft.principal.issuer,
    draft.principal.subject,
    draft.role,
    draft.expectedVersion,
    draft.reason,
  ]);
}

export function createAccessChangeRegistry(createId: () => string = () => crypto.randomUUID()) {
  const intents = new Map<string, string>();
  return {
    prepare(draft: AccessChangeDraft): RepositoryAccessChangeRequest {
      validateDraft(draft);
      const key = intentKey(draft);
      let changeId = intents.get(key);
      if (!changeId) {
        changeId = createId();
        intents.set(key, changeId);
      }
      return {
        changeId,
        principal: { issuer: draft.principal.issuer, subject: draft.principal.subject },
        role: draft.role,
        expectedVersion: draft.expectedVersion,
        reason: draft.reason,
      };
    },
    accepted(repositoryId: string, request: RepositoryAccessChangeRequest): void {
      const key = intentKey({ repositoryId, ...request });
      if (intents.get(key) === request.changeId) intents.delete(key);
    },
  };
}

export function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof ReviewControlHttpError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function accessChangeNotice(error: unknown): AccessNotice {
  if (isAccessDenied(error)) {
    return {
      kind: "denied",
      title: "Access management is unavailable",
      description:
        "This repository is unavailable to your current session, or your session cannot manage its access. Refresh access to check your permissions.",
    };
  }
  if (error instanceof ReviewControlHttpError && error.status === 409) {
    return {
      kind: "conflict",
      title: "Access change rejected",
      description: `${error.message} Review this rejection before continuing. If the record changed, close this editor and reload members, then review the latest record. An existing or revoked identity must be edited with its current version.`,
    };
  }
  return {
    kind: "error",
    title: "The access request could not be completed",
    description:
      error instanceof Error
        ? error.message
        : "Try again with the same values to reuse this change request.",
  };
}

export function accessReceiptSummary(receipt: RepositoryAccessChangeResponse): string {
  const change = receipt.change;
  const previous =
    change.previousRole === null ? "No repository role" : repositoryRoleLabels[change.previousRole];
  const next = change.role === null ? "Revoked" : repositoryRoleLabels[change.role];
  return `${receipt.replayed ? "Existing receipt" : "Change recorded"}: ${previous} → ${next}, version ${change.version}. This receipt records the accepted change. Use the refreshed members list to check current access.`;
}
