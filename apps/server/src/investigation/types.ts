import type {
  ActionContextV1,
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationPlanV1,
  InvestigationResultV1,
  InvestigationSubjectV1,
} from "@agentic-review/contracts";
import type { FastifyRequest } from "fastify";

export interface InvestigationGitHubIdentity {
  readonly githubUserId: number;
  readonly githubLogin: string;
}

export interface InvestigationOperatorPrincipal {
  readonly id: string;
  readonly username?: string;
  readonly isAdmin?: boolean;
  readonly displayName: string;
  readonly repositoryIds: readonly string[];
  readonly permissions: readonly (
    | "repository:manage"
    | "task:create"
    | "task:cancel"
    | "action:prepare"
    | "action:execute"
  )[];
  readonly actionCapabilities: readonly InvestigationActionKind[];
  readonly allowRepositoryExecution: boolean;
  /** The verified publisher identity frozen into an automatically generated comment. */
  readonly githubIdentity?: InvestigationGitHubIdentity;
}

export interface InvestigationWorkerPrincipal {
  readonly id: string;
  readonly repositoryIds: readonly string[];
}

/** Reads acknowledgements from trusted configuration for one exact saved plan and profile. */
export type InvestigationPrerequisiteResolver = (
  repository: InvestigationRepositoryRecord,
  workItem: InvestigationWorkItemRecord,
  report: InvestigationResultV1,
  plan: InvestigationPlanV1,
  actor: InvestigationOperatorPrincipal,
) => readonly string[] | Promise<readonly string[]>;

export interface InvestigationRepositoryRecord {
  readonly id: string;
  readonly fullName: string;
  readonly githubRepositoryId: number;
}

export interface InvestigationCommentTarget {
  readonly id: string;
  readonly repositoryId: string;
  readonly kind: "pull_request" | "issue";
  readonly number: number;
  readonly githubWorkItemId?: number;
}

export interface InvestigationWorkItemRecord extends InvestigationCommentTarget {
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged";
  readonly subject: InvestigationSubjectV1;
  readonly updatedAt: string;
}

export interface InvestigationProgressCommentRequest {
  readonly marker: string;
  readonly body: string;
  readonly externalId: string | null;
  readonly previousBody: string | null;
  /** Revalidate this assignment only when publishing the first conversation comment. */
  readonly expectedAssigneeUserId?: number;
  /** Revalidate this PR review request only when publishing the first conversation comment. */
  readonly expectedReviewerUserId?: number;
}

export interface InvestigationProgressCommentDelivery {
  readonly state: "succeeded" | "failed" | "unknown";
  readonly message: string;
  readonly externalId: string | null;
  /** Optional only for compatibility with existing custom transports. */
  readonly effect?: "not_sent" | "rejected" | "applied" | "unknown";
  /** Retry the same operation only: an unknown effect never permits resending a mutation. */
  readonly retryable?: boolean;
  readonly reasonCode?: string;
  readonly retryAfterMs?: number;
}

export interface InvestigationProgressCommentTransport {
  publishProgressComment(
    request: InvestigationProgressCommentRequest,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
    /** Must run synchronously after the final awaited preflight and before any mutation. */
    beforeDispatch?: () => void,
  ): Promise<InvestigationProgressCommentDelivery>;
  reconcileProgressComment(
    request: InvestigationProgressCommentRequest,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationCommentTarget,
    actor: InvestigationOperatorPrincipal,
  ): Promise<InvestigationProgressCommentDelivery>;
}

export interface InvestigationActionTransport {
  readonly supportedActions: readonly InvestigationActionKind[];
  readPublisherIdentity?(): Promise<InvestigationGitHubIdentity>;
  publishProgressComment?: InvestigationProgressCommentTransport["publishProgressComment"];
  reconcileProgressComment?: InvestigationProgressCommentTransport["reconcileProgressComment"];
  readTarget(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<ActionContextV1["target"]>;
  readCapabilities?(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<readonly InvestigationActionKind[]>;
  validateRemoteBranch?(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    subject: InvestigationSubjectV1,
    actor: InvestigationOperatorPrincipal,
    baseBranch?: string,
  ): Promise<void>;
  validateSuggestions?(
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    intent: InvestigationActionIntentV1,
  ): Promise<void>;
  execute(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
    /** Must run synchronously after the final awaited preflight and before any mutation. */
    beforeDispatch?: () => void,
  ): Promise<{
    state: "succeeded" | "failed" | "unknown";
    message: string;
    externalId: string | null;
  }>;
  reconcile(
    intent: InvestigationActionIntentV1,
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    actor: InvestigationOperatorPrincipal,
  ): Promise<{
    state: "succeeded" | "failed" | "unknown";
    message: string;
    externalId: string | null;
  }>;
}

export type InvestigationOperatorAuthenticator = (
  request: FastifyRequest,
) => InvestigationOperatorPrincipal | null | Promise<InvestigationOperatorPrincipal | null>;
export type InvestigationWorkerAuthenticator = (
  request: FastifyRequest,
) => InvestigationWorkerPrincipal | null | Promise<InvestigationWorkerPrincipal | null>;
