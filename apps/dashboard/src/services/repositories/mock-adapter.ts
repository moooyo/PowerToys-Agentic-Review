import {
  type GitHubRepository,
  type ManagedRepository,
  ManagedRepositoryNameSchema,
  ManagedRepositorySchema,
  type RepositoryCreateRequest,
  RepositoryCreateRequestSchema,
  type RepositoryUpdateRequest,
  RepositoryUpdateRequestSchema,
} from "@agentic-review/contracts";
import { ReviewControlHttpError, ReviewControlRequestError } from "../review-control/errors";
import type { RepositoryAdapter, RepositoryListQuery, RepositoryListResult } from "./adapter";
import {
  normalizeListQuery,
  repositorySettingsAreConsistent,
  validateRepositoryId,
  validateRequest,
} from "./validation";

const sampleTimestamp = "2026-09-06T08:00:00.000Z";
const sampleConnectionMessage = "Sample repository metadata. No GitHub connection was checked.";

export const sampleRepositories: readonly ManagedRepository[] = [
  {
    id: "repo-powertoys",
    githubRepositoryId: 184456251,
    fullName: "microsoft/PowerToys",
    enabled: true,
    version: 1,
    reviewerGithubUserId: null,
    reviewerGithubLogin: null,
    authorizationPolicy: null,
    schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
    connectionStatus: "ready",
    connectionMessage: sampleConnectionMessage,
    createdAt: sampleTimestamp,
    updatedAt: sampleTimestamp,
  },
  {
    id: "repo-terminal",
    githubRepositoryId: 100060912,
    fullName: "microsoft/terminal",
    enabled: false,
    version: 1,
    reviewerGithubUserId: null,
    reviewerGithubLogin: null,
    authorizationPolicy: null,
    schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
    connectionStatus: "unknown",
    connectionMessage: null,
    createdAt: sampleTimestamp,
    updatedAt: sampleTimestamp,
  },
  {
    id: "repo-powertoys-fork",
    githubRepositoryId: 1299518756,
    fullName: "moooyo/PowerToys",
    enabled: true,
    version: 1,
    reviewerGithubUserId: null,
    reviewerGithubLogin: null,
    authorizationPolicy: null,
    schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
    connectionStatus: "ready",
    connectionMessage: sampleConnectionMessage,
    createdAt: sampleTimestamp,
    updatedAt: sampleTimestamp,
  },
];

export interface MockRepositoryAdapterOptions {
  readonly initialRepositories?: readonly ManagedRepository[];
  readonly now?: () => Date;
}

const httpError = (operation: string, status: number, message: string): ReviewControlHttpError =>
  new ReviewControlHttpError(message, {
    operation,
    status,
    retryable: false,
    serverCode: status === 409 ? "PLATFORM_CONFLICT" : "PLATFORM_NOT_FOUND",
  });

const sampleMetadata = (sample: ManagedRepository): GitHubRepository => {
  const [ownerLogin = "", name = ""] = sample.fullName.split("/");
  return {
    githubRepositoryId: sample.githubRepositoryId,
    githubNodeId: `sample-repository-${sample.githubRepositoryId}`,
    ownerLogin,
    name,
    fullName: sample.fullName,
    htmlUrl: `https://github.com/${sample.fullName}`,
    defaultBranch: "main",
    isPrivate: false,
  };
};

export class MockRepositoryAdapter implements RepositoryAdapter {
  private readonly records = new Map<string, ManagedRepository>();
  private readonly now: () => Date;

  constructor(options: MockRepositoryAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    for (const item of options.initialRepositories ?? sampleRepositories) {
      validateRequest(ManagedRepositorySchema, item, "initialize sample repositories");
      if (
        !sampleRepositories.some(
          (sample) =>
            sample.id === item.id &&
            sample.githubRepositoryId === item.githubRepositoryId &&
            sample.fullName === item.fullName,
        ) ||
        !repositorySettingsAreConsistent(item) ||
        this.records.has(item.id)
      ) {
        throw new ReviewControlRequestError(
          "initialize sample repositories",
          "initialRepositories",
          "Only the fixed sample repositories are supported.",
        );
      }
      this.records.set(item.id, structuredClone(item));
    }
  }

  async list(query?: RepositoryListQuery): Promise<RepositoryListResult> {
    const { page, pageSize, search } = normalizeListQuery(query);
    const matches = [...this.records.values()]
      .filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()))
      .sort((left, right) =>
        left.fullName.toLowerCase().localeCompare(right.fullName.toLowerCase()),
      );
    const items = matches.slice((page - 1) * pageSize, page * pageSize).map((repository) => {
      const { authorizationPolicy: _authorizationPolicy, ...summary } = repository;
      return structuredClone(summary);
    });
    return { items, total: matches.length };
  }

  async get(id: string, signal?: AbortSignal): Promise<ManagedRepository> {
    signal?.throwIfAborted();
    return structuredClone(this.requireRepository(id, "get repository"));
  }

  async resolve(fullName: string): Promise<GitHubRepository> {
    const operation = "resolve repository";
    validateRequest(ManagedRepositoryNameSchema, fullName, operation, "fullName");
    const sample = sampleRepositories.find(
      (repository) => repository.fullName.toLowerCase() === fullName.toLowerCase(),
    );
    if (!sample)
      throw httpError(
        operation,
        404,
        "Sample mode supports only microsoft/PowerToys, microsoft/terminal, and moooyo/PowerToys. Connect the control plane to resolve other repositories.",
      );
    return sampleMetadata(sample);
  }

  async create(input: RepositoryCreateRequest): Promise<ManagedRepository> {
    const operation = "create repository";
    validateRequest(RepositoryCreateRequestSchema, input, operation);
    const metadata = await this.resolve(input.fullName);
    if (metadata.githubRepositoryId !== input.githubRepositoryId) {
      throw new ReviewControlRequestError(
        operation,
        "githubRepositoryId",
        "The repository name and GitHub ID do not match.",
      );
    }
    const sample = sampleRepositories.find(
      (repository) => repository.githubRepositoryId === metadata.githubRepositoryId,
    );
    if (!sample) throw httpError(operation, 404, "The sample repository does not exist.");
    if (this.records.has(sample.id))
      throw httpError(operation, 409, "The repository is already managed.");
    const timestamp = this.now().toISOString();
    const repository: ManagedRepository = {
      ...structuredClone(sample),
      enabled: input.enabled ?? false,
      schedulingLimits: structuredClone(
        input.schedulingLimits ?? { maxActiveLeases: null, maxQueuedJobs: null },
      ),
      version: 1,
      connectionStatus: "ready",
      connectionMessage: sampleConnectionMessage,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(repository.id, repository);
    return structuredClone(repository);
  }

  async update(id: string, input: RepositoryUpdateRequest): Promise<ManagedRepository> {
    const operation = "update repository";
    validateRequest(RepositoryUpdateRequestSchema, input, operation);
    const current = this.requireRepository(id, operation);
    if (current.version !== input.expectedVersion)
      throw httpError(operation, 409, "Repository settings changed. Reload before saving.");
    const { expectedVersion: _expectedVersion, ...changes } = input;
    const next: ManagedRepository = {
      ...current,
      ...structuredClone(changes),
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!repositorySettingsAreConsistent(next)) {
      throw new ReviewControlRequestError(
        operation,
        "request",
        "Configure the reviewer ID and login together and target the same reviewer in the authorization policy.",
      );
    }
    this.records.set(id, next);
    return structuredClone(next);
  }

  async checkConnection(id: string): Promise<ManagedRepository> {
    const current = this.requireRepository(id, "check repository connection");
    const next: ManagedRepository = {
      ...current,
      connectionStatus: "ready",
      connectionMessage: sampleConnectionMessage,
      updatedAt: this.now().toISOString(),
    };
    this.records.set(id, next);
    return structuredClone(next);
  }

  private requireRepository(id: string, operation: string): ManagedRepository {
    validateRepositoryId(id, operation);
    const repository = this.records.get(id);
    if (!repository) throw httpError(operation, 404, "The repository does not exist.");
    return repository;
  }
}
