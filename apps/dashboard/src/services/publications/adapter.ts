import type {
  PublicationAttemptListQuery,
  PublicationAttemptListResponse,
  PublicationConfirmRequest,
  PublicationConfirmResponse,
  PublicationControlAction,
  PublicationControlRequest,
  PublicationControlResponse,
  PublicationDetail,
  PublicationListQuery,
  PublicationListResponse,
  PublicationPreview,
  PublicationPreviewQuery,
  PublicationReadQuery,
  RepositoryPublicationPolicy,
  RepositoryPublicationPolicyAuditEvent,
  RepositoryPublicationPolicyAuditListQuery,
  RepositoryPublicationPolicyAuditListResponse,
  RepositoryPublicationPolicyUpdateRequest,
  RepositoryPublicationPolicyUpdateResponse,
} from "@agentic-review/contracts";

export interface PublicationAdapter {
  readonly mode: "connected";
  preview(scope: PublicationPreviewQuery, signal?: AbortSignal): Promise<PublicationPreview>;
  confirm(
    scope: PublicationPreviewQuery,
    request: PublicationConfirmRequest,
  ): Promise<PublicationConfirmResponse>;
  list(query: PublicationListQuery, signal?: AbortSignal): Promise<PublicationListResponse>;
  get(scope: PublicationReadQuery, signal?: AbortSignal): Promise<PublicationDetail>;
  attempts(
    query: PublicationAttemptListQuery,
    signal?: AbortSignal,
  ): Promise<PublicationAttemptListResponse>;
  control(
    scope: PublicationReadQuery,
    action: PublicationControlAction,
    request: PublicationControlRequest,
  ): Promise<PublicationControlResponse>;
  policy(repositoryId: string, signal?: AbortSignal): Promise<RepositoryPublicationPolicy>;
  updatePolicy(
    repositoryId: string,
    request: RepositoryPublicationPolicyUpdateRequest,
  ): Promise<RepositoryPublicationPolicyUpdateResponse>;
  policyActivity(
    query: RepositoryPublicationPolicyAuditListQuery,
    signal?: AbortSignal,
  ): Promise<RepositoryPublicationPolicyAuditListResponse>;
  policyEvent(
    repositoryId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryPublicationPolicyAuditEvent>;
}
