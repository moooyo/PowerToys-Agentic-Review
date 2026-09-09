import {
  type SchedulingConfiguration,
  type SchedulingConfigurationAuditEvent,
  type SchedulingConfigurationAuditListQuery,
  type SchedulingConfigurationUpdateRequest,
  type SchedulingLimits,
  type SchedulingUsage,
  schedulingPolicyId,
} from "@agentic-review/contracts";
import { sampleOperatorPrincipal } from "../access/mock-adapter";
import { repositories } from "../repositories";
import type { RepositoryAdapter } from "../repositories/adapter";
import { ReviewControlHttpError } from "../review-control/errors";
import type { SchedulingPolicyAdapter } from "./adapter";
import {
  normalizeSchedulingActivityQuery,
  readPlatformSchedulingStatus,
  readRepositorySchedulingStatus,
  readSchedulingActivity,
  readSchedulingConfiguration,
  readSchedulingEvent,
  schedulingPolicyEventPath,
  validateSchedulingUpdate,
} from "./validation";

const initialConfiguration: SchedulingConfiguration = {
  version: 2,
  limits: { maxActiveLeases: 6, maxQueuedJobs: 8 },
  policyId: schedulingPolicyId,
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const platformUsage: SchedulingUsage = {
  activeLeases: 4,
  admittedQueuedJobs: 6,
  awaitingAdmissionJobs: 5,
  awaitingConfigurationRequests: 2,
};
const overage = (limits: SchedulingLimits, usage: SchedulingUsage) => ({
  activeLeases:
    limits.maxActiveLeases === null ? 0 : Math.max(0, usage.activeLeases - limits.maxActiveLeases),
  admittedQueuedJobs:
    limits.maxQueuedJobs === null
      ? 0
      : Math.max(0, usage.admittedQueuedJobs - limits.maxQueuedJobs),
});

export class SampleSchedulingPolicyAdapter implements SchedulingPolicyAdapter {
  readonly mode = "sample" as const;
  private configuration = structuredClone(initialConfiguration);
  private readonly events: SchedulingConfigurationAuditEvent[] = [
    {
      id: "sample-scheduling-2",
      actor: { ...sampleOperatorPrincipal },
      previousVersion: 1,
      version: 2,
      createdAt: initialConfiguration.updatedAt,
      previousSnapshot: {
        version: 1,
        limits: { maxActiveLeases: null, maxQueuedJobs: null },
        policyId: schedulingPolicyId,
        updatedAt: "2026-09-06T08:00:00.000Z",
      },
      snapshot: structuredClone(initialConfiguration),
    },
  ];
  constructor(
    private readonly repositoryAdapter: RepositoryAdapter = repositories,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async repository(repositoryId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const repository = await this.repositoryAdapter.get(repositoryId, signal);
    const usage: SchedulingUsage =
      repositoryId === "repo-powertoys"
        ? {
            activeLeases: 2,
            admittedQueuedJobs: 3,
            awaitingAdmissionJobs: 4,
            awaitingConfigurationRequests: 1,
          }
        : {
            activeLeases: 1,
            admittedQueuedJobs: 2,
            awaitingAdmissionJobs: 1,
            awaitingConfigurationRequests: 1,
          };
    signal?.throwIfAborted();
    return readRepositorySchedulingStatus(
      {
        repositoryId,
        observedAt: this.now().toISOString(),
        repositoryVersion: repository.version,
        enabled: repository.enabled,
        limits: repository.schedulingLimits,
        usage,
        overage: overage(repository.schedulingLimits, usage),
        platform: {
          visibility: "restricted",
          version: this.configuration.version,
          activeCapacity:
            this.configuration.limits.maxActiveLeases !== null &&
            platformUsage.activeLeases >= this.configuration.limits.maxActiveLeases
              ? "limited"
              : "available",
          queueCapacity:
            this.configuration.limits.maxQueuedJobs !== null &&
            platformUsage.admittedQueuedJobs >= this.configuration.limits.maxQueuedJobs
              ? "limited"
              : "available",
        },
      },
      repositoryId,
    );
  }
  async platform(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return readPlatformSchedulingStatus(
      structuredClone({
        observedAt: this.now().toISOString(),
        configuration: this.configuration,
        usage: platformUsage,
        unscopedUsage: {
          activeLeases: 1,
          admittedQueuedJobs: 1,
          awaitingAdmissionJobs: 0,
          awaitingConfigurationRequests: 0,
        },
        overage: overage(this.configuration.limits, platformUsage),
      }),
    );
  }
  async update(input: SchedulingConfigurationUpdateRequest) {
    validateSchedulingUpdate(input);
    if (input.expectedVersion !== this.configuration.version)
      throw new ReviewControlHttpError("Scheduling configuration changed. Reload before saving.", {
        operation: "update scheduling configuration",
        status: 409,
        retryable: false,
      });
    const previousSnapshot = structuredClone(this.configuration);
    const createdAt = this.now().toISOString();
    this.configuration = {
      version: previousSnapshot.version + 1,
      limits: structuredClone(input.limits),
      policyId: schedulingPolicyId,
      updatedAt: createdAt,
    };
    this.events.unshift({
      id: `sample-scheduling-${this.configuration.version}`,
      actor: { ...sampleOperatorPrincipal },
      previousVersion: previousSnapshot.version,
      version: this.configuration.version,
      createdAt,
      previousSnapshot,
      snapshot: structuredClone(this.configuration),
    });
    return readSchedulingConfiguration(structuredClone(this.configuration), input.expectedVersion);
  }
  async activity(query?: SchedulingConfigurationAuditListQuery, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const normalized = normalizeSchedulingActivityQuery(query);
    const offset = (normalized.page - 1) * normalized.pageSize;
    const items = [...this.events]
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id > right.id
            ? -1
            : left.id < right.id
              ? 1
              : 0
          : left.createdAt > right.createdAt
            ? -1
            : 1,
      )
      .slice(offset, offset + normalized.pageSize)
      .map(({ previousSnapshot: _previous, snapshot: _snapshot, ...summary }) =>
        structuredClone(summary),
      );
    return readSchedulingActivity({ ...normalized, total: this.events.length, items }, normalized);
  }
  async event(eventId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    schedulingPolicyEventPath(eventId);
    const event = this.events.find((item) => item.id === eventId);
    if (!event)
      throw new ReviewControlHttpError("The scheduling event does not exist.", {
        operation: "read scheduling event",
        status: 404,
        retryable: false,
      });
    return readSchedulingEvent(structuredClone(event), eventId);
  }
}
