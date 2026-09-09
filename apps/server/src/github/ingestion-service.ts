import type { NormalizedSchedulingEvent, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import type { DatabaseClient } from "../database/database-client.js";
import type {
  IngestSchedulingEventResult,
  ScheduleJobInput,
  WebhookDeliveryInput,
} from "../database/protocol.js";

export interface ConfiguredGitHubRepository {
  readonly githubRepositoryId: number;
  readonly fullName: string;
}

export type SchedulingCandidateFactory = (
  event: NormalizedSchedulingEvent,
) => ScheduleJobInput | null;

export interface GitHubEventRuntimeConfiguration {
  readonly repository: ConfiguredGitHubRepository;
  readonly policy: SelfOrAllowlistPolicy;
  readonly allowScheduling: boolean;
  readonly schedule: ScheduleJobInput | null;
}

export type ResolveGitHubEventConfiguration = (
  event: NormalizedSchedulingEvent,
) => GitHubEventRuntimeConfiguration | null | Promise<GitHubEventRuntimeConfiguration | null>;

export interface GitHubEventIngestionDependencies {
  readonly database: Pick<DatabaseClient, "request">;
  readonly repositories?: readonly ConfiguredGitHubRepository[];
  readonly policy?: SelfOrAllowlistPolicy;
  readonly createSchedule?: SchedulingCandidateFactory;
  readonly resolveConfiguration?: ResolveGitHubEventConfiguration;
}

export class GitHubRepositoryNotConfiguredError extends Error {
  public readonly code = "GITHUB_REPOSITORY_NOT_CONFIGURED";

  public constructor() {
    super("The GitHub event repository is not configured for agentic review.");
    this.name = "GitHubRepositoryNotConfiguredError";
  }
}

export class GitHubEventIngestionService {
  readonly #database: Pick<DatabaseClient, "request">;
  readonly #repositories: ReadonlyMap<number, string>;
  readonly #policy: SelfOrAllowlistPolicy | undefined;
  readonly #createSchedule: SchedulingCandidateFactory | undefined;
  readonly #resolveConfiguration: ResolveGitHubEventConfiguration | undefined;

  public constructor(dependencies: GitHubEventIngestionDependencies) {
    const anyLegacy =
      dependencies.repositories !== undefined ||
      dependencies.policy !== undefined ||
      dependencies.createSchedule !== undefined;
    const completeLegacy =
      dependencies.repositories !== undefined &&
      dependencies.policy !== undefined &&
      dependencies.createSchedule !== undefined;
    if (
      (anyLegacy && !completeLegacy) ||
      (!completeLegacy && dependencies.resolveConfiguration === undefined)
    ) {
      throw new TypeError(
        "Configure a runtime resolver or a complete legacy repository, policy, and scheduling factory.",
      );
    }
    if (
      dependencies.repositories?.length === 0 &&
      dependencies.resolveConfiguration === undefined
    ) {
      throw new Error("At least one GitHub repository must be configured.");
    }

    const repositories = new Map<number, string>();
    const names = new Set<string>();
    for (const repository of dependencies.repositories ?? []) {
      if (
        !Number.isSafeInteger(repository.githubRepositoryId) ||
        repository.githubRepositoryId <= 0
      ) {
        throw new Error("Configured GitHub repository IDs must be positive safe integers.");
      }
      const normalizedName = repository.fullName.toLowerCase();
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName) ||
        repositories.has(repository.githubRepositoryId) ||
        names.has(normalizedName)
      ) {
        throw new Error(
          "Configured GitHub repositories must have unique IDs and owner/name pairs.",
        );
      }
      repositories.set(repository.githubRepositoryId, normalizedName);
      names.add(normalizedName);
    }

    this.#database = dependencies.database;
    this.#repositories = repositories;
    this.#policy = dependencies.policy;
    this.#createSchedule = dependencies.createSchedule;
    this.#resolveConfiguration = dependencies.resolveConfiguration;
  }

  public async ingest(
    event: NormalizedSchedulingEvent,
    delivery: WebhookDeliveryInput | null = null,
  ): Promise<IngestSchedulingEventResult> {
    if (this.#resolveConfiguration !== undefined) {
      const configuration = await this.#resolveConfiguration(event);
      if (
        configuration === null ||
        configuration.repository.githubRepositoryId !== event.repository.githubRepositoryId ||
        configuration.repository.fullName.toLowerCase() !== event.repository.fullName.toLowerCase()
      ) {
        throw new GitHubRepositoryNotConfiguredError();
      }
      if (!configuration.allowScheduling && configuration.schedule !== null) {
        throw new TypeError("An observation-only repository cannot supply a job schedule.");
      }
      return this.#database.request("ingestSchedulingEvent", {
        event,
        policy: configuration.policy,
        delivery,
        allowScheduling: configuration.allowScheduling,
        schedule: configuration.schedule,
      });
    }
    this.#assertConfiguredRepository(event);
    if (this.#policy === undefined || this.#createSchedule === undefined) {
      throw new TypeError("Legacy GitHub scheduling configuration is incomplete.");
    }
    return this.#database.request("ingestSchedulingEvent", {
      event,
      policy: this.#policy,
      delivery,
      schedule: this.#createSchedule(event),
    });
  }

  #assertConfiguredRepository(event: NormalizedSchedulingEvent): void {
    const configuredName = this.#repositories.get(event.repository.githubRepositoryId);
    if (
      configuredName === undefined ||
      configuredName !== event.repository.fullName.toLowerCase()
    ) {
      throw new GitHubRepositoryNotConfiguredError();
    }
  }
}
