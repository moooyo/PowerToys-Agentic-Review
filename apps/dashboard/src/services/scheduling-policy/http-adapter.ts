import {
  maximumSchedulingConfigurationAuditResponseUtf8Bytes,
  maximumSchedulingStatusResponseUtf8Bytes,
  type SchedulingConfigurationAuditListQuery,
  type SchedulingConfigurationUpdateRequest,
} from "@agentic-review/contracts";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type { SchedulingPolicyAdapter } from "./adapter";
import {
  normalizeSchedulingActivityQuery,
  readPlatformSchedulingStatus,
  readRepositorySchedulingStatus,
  readSchedulingActivity,
  readSchedulingConfiguration,
  readSchedulingEvent,
  schedulingPolicyEventPath,
  schedulingPolicyRepositoryPath,
  validateSchedulingUpdate,
} from "./validation";

const platformPath = "/api/v1/operator/scheduling";

export class HttpSchedulingPolicyAdapter implements SchedulingPolicyAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async repository(repositoryId: string, signal?: AbortSignal) {
    const path = schedulingPolicyRepositoryPath(repositoryId);
    return readRepositorySchedulingStatus(
      await this.client.get(path, "read repository scheduling", {
        signal,
        maxResponseBytes: maximumSchedulingStatusResponseUtf8Bytes,
      }),
      repositoryId,
    );
  }
  async platform(signal?: AbortSignal) {
    return readPlatformSchedulingStatus(
      await this.client.get(platformPath, "read platform scheduling", {
        signal,
        maxResponseBytes: maximumSchedulingStatusResponseUtf8Bytes,
      }),
    );
  }
  async update(input: SchedulingConfigurationUpdateRequest) {
    const request = validateSchedulingUpdate(input);
    return readSchedulingConfiguration(
      await this.client.patch(platformPath, "update scheduling configuration", request),
      request.expectedVersion,
      request.limits,
    );
  }
  async activity(query?: SchedulingConfigurationAuditListQuery, signal?: AbortSignal) {
    const normalized = normalizeSchedulingActivityQuery(query);
    const parameters = new URLSearchParams({
      page: String(normalized.page),
      pageSize: String(normalized.pageSize),
    });
    return readSchedulingActivity(
      await this.client.get(`${platformPath}/activity?${parameters}`, "read scheduling activity", {
        signal,
        maxResponseBytes: maximumSchedulingConfigurationAuditResponseUtf8Bytes,
      }),
      normalized,
    );
  }
  async event(eventId: string, signal?: AbortSignal) {
    return readSchedulingEvent(
      await this.client.get(schedulingPolicyEventPath(eventId), "read scheduling event", {
        signal,
        maxResponseBytes: maximumSchedulingConfigurationAuditResponseUtf8Bytes,
      }),
      eventId,
    );
  }
}
