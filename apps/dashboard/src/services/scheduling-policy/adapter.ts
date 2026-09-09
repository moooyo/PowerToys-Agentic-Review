import type {
  PlatformSchedulingStatus,
  RepositorySchedulingStatus,
  SchedulingConfiguration,
  SchedulingConfigurationAuditEvent,
  SchedulingConfigurationAuditListQuery,
  SchedulingConfigurationAuditListResponse,
  SchedulingConfigurationUpdateRequest,
} from "@agentic-review/contracts";

export interface SchedulingPolicyAdapter {
  readonly mode: "connected" | "sample";
  repository(repositoryId: string, signal?: AbortSignal): Promise<RepositorySchedulingStatus>;
  platform(signal?: AbortSignal): Promise<PlatformSchedulingStatus>;
  update(input: SchedulingConfigurationUpdateRequest): Promise<SchedulingConfiguration>;
  activity(
    query?: SchedulingConfigurationAuditListQuery,
    signal?: AbortSignal,
  ): Promise<SchedulingConfigurationAuditListResponse>;
  event(eventId: string, signal?: AbortSignal): Promise<SchedulingConfigurationAuditEvent>;
}
