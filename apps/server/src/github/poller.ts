import { createHash } from "node:crypto";

import type {
  GitHubActor,
  GitHubIssue,
  GitHubIssueRevision,
  GitHubPullRequest,
  GitHubPullRequestRevision,
  GitHubRepository,
  GitHubWorkItem,
  GitHubWorkItemRevision,
  NormalizedSchedulingEvent,
  SchedulingRequestKind,
} from "@agentic-review/contracts";
import { createPullRequestRevisionKey } from "./revision-key.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_SEARCH_PAGES = 10;
const DEFAULT_MAX_TIMELINE_PAGES = 20;
const MAX_PAGE_SIZE = 100;
const githubNamePattern = /^[A-Za-z0-9_.-]+$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const gitObjectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface GitHubPollingRepositoryTarget {
  readonly githubRepositoryId: number;
  readonly fullName: string;
}

export interface GitHubPollingReviewerTarget {
  readonly githubUserId: number;
  readonly login: string;
}

export interface GitHubIdentitySnapshot {
  readonly githubUserId: number;
  readonly login: string;
  readonly accountType?: "user" | "bot" | "app";
  readonly githubNodeId?: string;
  readonly avatarUrl?: string;
}

export interface GitHubRepositorySnapshot {
  readonly githubRepositoryId: number;
  readonly githubNodeId: string;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
}

export interface GitHubSearchItem {
  readonly kind: "issue" | "pull_request";
  readonly githubWorkItemId: number;
  readonly number: number;
}

interface GitHubWorkItemSnapshotBase {
  readonly githubWorkItemId: number;
  readonly githubNodeId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly author: GitHubIdentitySnapshot;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface GitHubIssueSnapshot extends GitHubWorkItemSnapshotBase {
  readonly kind: "issue";
}

export interface GitHubPullRequestSnapshot extends GitHubWorkItemSnapshotBase {
  readonly kind: "pull_request";
  readonly isDraft: boolean;
  readonly baseSha: string;
  readonly headSha: string;
}

export type GitHubTimelineAction =
  | "assigned"
  | "unassigned"
  | "review_requested"
  | "review_request_removed";

export interface GitHubTimelineEvent {
  /** The REST event ID or GraphQL node ID. It may be null for incomplete API projections. */
  readonly githubEventId: string | number | null;
  readonly action: GitHubTimelineAction;
  readonly actor: GitHubIdentitySnapshot | null;
  readonly target: GitHubIdentitySnapshot | null;
  readonly occurredAt: string;
}

export interface GitHubRateLimitState {
  readonly resource: string;
  readonly remaining: number;
  readonly resetAt: string;
  readonly retryAfterMs?: number;
}

export interface GitHubPage<T> {
  readonly items: readonly T[];
  /** The client resolves GitHub's Link header and returns the next page number. */
  readonly nextPage: number | null;
  /** True when GitHub reports incomplete or capped search results. */
  readonly incomplete?: boolean;
  readonly rateLimit?: GitHubRateLimitState;
}

export interface GitHubReadRequestBase {
  readonly repositoryFullName: string;
  readonly signal?: AbortSignal;
}

export interface GitHubSearchRequest extends GitHubReadRequestBase {
  readonly query: string;
  readonly page: number;
  readonly perPage: number;
}

export interface GitHubWorkItemReadRequest extends GitHubReadRequestBase {
  readonly number: number;
}

export interface GitHubTimelineReadRequest extends GitHubWorkItemReadRequest {
  readonly page: number;
  readonly perPage: number;
}

/**
 * A token-free boundary that an Octokit adapter can implement. Authentication and retries stay
 * outside the polling domain logic.
 */
export interface GitHubReadClient {
  getRepository(request: GitHubReadRequestBase): Promise<GitHubRepositorySnapshot>;
  searchIssuesAndPullRequests(request: GitHubSearchRequest): Promise<GitHubPage<GitHubSearchItem>>;
  getIssue(request: GitHubWorkItemReadRequest): Promise<GitHubIssueSnapshot>;
  getPullRequest(request: GitHubWorkItemReadRequest): Promise<GitHubPullRequestSnapshot>;
  listIssueTimelineEvents(
    request: GitHubTimelineReadRequest,
  ): Promise<GitHubPage<GitHubTimelineEvent>>;
}

export interface GitHubPollingPageContext {
  readonly operation: "assigned_search" | "review_requested_search" | "timeline";
  readonly page: number;
  readonly workItemNumber: number | null;
}

export type ObserveGitHubRateLimit = (
  state: GitHubRateLimitState,
  context: GitHubPollingPageContext,
  signal: AbortSignal | undefined,
) => void | Promise<void>;

export type IngestPolledGitHubEvent = (event: NormalizedSchedulingEvent) => void | Promise<void>;

export interface GitHubPollingActiveRequestProjection {
  readonly requestKind: SchedulingRequestKind;
  /** The normalized source event that opened the currently observed request epoch. */
  readonly openedSourceEventId: string;
}

export interface GitHubPollingWorkItemProjection {
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly activeRequests: readonly GitHubPollingActiveRequestProjection[];
}

/**
 * Durable reconciliation state. Implementations should replace the complete projection atomically
 * after all emitted events have been accepted by the ingestion callback.
 */
export interface GitHubPollingActiveProjection {
  readonly version: 1;
  readonly githubRepositoryId: number;
  readonly repositoryFullName: string;
  readonly reviewerGithubUserId: number;
  readonly reviewerLogin: string;
  readonly workItems: readonly GitHubPollingWorkItemProjection[];
}

export interface GitHubPollingProjectionKey {
  readonly githubRepositoryId: number;
  readonly repositoryFullName: string;
  readonly reviewerGithubUserId: number;
}

export interface GitHubPollingStateSource {
  readActiveProjection(
    key: GitHubPollingProjectionKey,
    signal: AbortSignal | undefined,
  ): Promise<GitHubPollingActiveProjection | null>;
}

export interface GitHubPollingStateSink {
  writeActiveProjection(
    key: GitHubPollingProjectionKey,
    projection: GitHubPollingActiveProjection,
    signal: AbortSignal | undefined,
  ): Promise<void>;
}

export interface ReconcileGitHubPollingInput {
  readonly client: GitHubReadClient;
  readonly repository: GitHubPollingRepositoryTarget;
  readonly reviewer: GitHubPollingReviewerTarget;
  readonly ingest: IngestPolledGitHubEvent;
  readonly signal?: AbortSignal;
  readonly pageSize?: number;
  readonly maxSearchPages?: number;
  readonly maxTimelinePages?: number;
  readonly now?: () => Date;
  readonly observeRateLimit?: ObserveGitHubRateLimit;
  readonly isPermanentlyUnavailableWorkItem?: (error: unknown) => boolean;
  readonly previousActiveProjection?: GitHubPollingActiveProjection | null;
}

export interface GitHubPollingReconciliationResult {
  readonly observedAt: string;
  readonly uniqueWorkItemCount: number;
  readonly emittedEventCount: number;
  readonly searchPageCount: number;
  readonly timelinePageCount: number;
  readonly searchTruncated: boolean;
  readonly timelineTruncatedWorkItemNumbers: readonly number[];
  readonly unavailableWorkItemNumbers: readonly number[];
  readonly nextActiveProjection: GitHubPollingActiveProjection;
}

export class GitHubPollingInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubPollingInvariantError";
  }
}

interface Candidate {
  readonly kind: GitHubSearchItem["kind"];
  readonly githubWorkItemId: number;
  readonly number: number;
  readonly activeRequestKinds: Set<SchedulingRequestKind>;
}

interface CollectedPageSet<T> {
  readonly items: readonly T[];
  readonly pageCount: number;
  readonly truncated: boolean;
}

interface ActiveTimelineRequest {
  readonly event: GitHubTimelineEvent;
}

interface PreviousWorkItemProjection {
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly activeRequests: ReadonlyMap<SchedulingRequestKind, GitHubPollingActiveRequestProjection>;
}

interface ReconciliationTarget {
  readonly kind: GitHubSearchItem["kind"];
  readonly githubWorkItemId: number;
  readonly number: number;
}

export async function reconcileGitHubPolling(
  input: ReconcileGitHubPollingInput,
): Promise<GitHubPollingReconciliationResult> {
  validateInput(input);
  throwIfAborted(input.signal);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxSearchPages = input.maxSearchPages ?? DEFAULT_MAX_SEARCH_PAGES;
  const maxTimelinePages = input.maxTimelinePages ?? DEFAULT_MAX_TIMELINE_PAGES;
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const requestSignal = signalProperty(input.signal);

  const repositorySnapshot = await input.client.getRepository({
    repositoryFullName: input.repository.fullName,
    ...requestSignal,
  });
  throwIfAborted(input.signal);
  const repository = normalizeRepository(repositorySnapshot, input.repository);
  const assignedQuery = `repo:${input.repository.fullName} is:open assignee:${input.reviewer.login}`;
  const reviewRequestedQuery = `repo:${input.repository.fullName} is:open is:pr review-requested:${input.reviewer.login}`;

  const assigned = await collectPages({
    maxPages: maxSearchPages,
    signal: input.signal,
    context: (page) => ({ operation: "assigned_search", page, workItemNumber: null }),
    observeRateLimit: input.observeRateLimit,
    load: (page) =>
      input.client.searchIssuesAndPullRequests({
        repositoryFullName: input.repository.fullName,
        query: assignedQuery,
        page,
        perPage: pageSize,
        ...requestSignal,
      }),
  });
  const reviewRequested = await collectPages({
    maxPages: maxSearchPages,
    signal: input.signal,
    context: (page) => ({ operation: "review_requested_search", page, workItemNumber: null }),
    observeRateLimit: input.observeRateLimit,
    load: (page) =>
      input.client.searchIssuesAndPullRequests({
        repositoryFullName: input.repository.fullName,
        query: reviewRequestedQuery,
        page,
        perPage: pageSize,
        ...requestSignal,
      }),
  });

  const candidates = mergeCandidates(assigned.items, reviewRequested.items);
  const currentById = new Map(
    candidates.map((candidate) => [candidate.githubWorkItemId, candidate]),
  );
  const previousById = readPreviousProjection(input);
  const reconciliationTargets = mergeReconciliationTargets(currentById, previousById);
  const reviewer = normalizeIdentity({
    githubUserId: input.reviewer.githubUserId,
    login: input.reviewer.login,
    accountType: "user",
  });
  let emittedEventCount = 0;
  let timelinePageCount = 0;
  const timelineTruncatedWorkItemNumbers: number[] = [];
  const unavailableWorkItemNumbers: number[] = [];
  const nextWorkItems: GitHubPollingWorkItemProjection[] = [];

  for (const target of reconciliationTargets) {
    throwIfAborted(input.signal);
    const current = currentById.get(target.githubWorkItemId);
    const previous = previousById.get(target.githubWorkItemId);
    let snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot;
    try {
      snapshot =
        target.kind === "issue"
          ? await input.client.getIssue({
              repositoryFullName: input.repository.fullName,
              number: target.number,
              ...requestSignal,
            })
          : await input.client.getPullRequest({
              repositoryFullName: input.repository.fullName,
              number: target.number,
              ...requestSignal,
            });
    } catch (error) {
      if (
        current === undefined &&
        previous !== undefined &&
        input.isPermanentlyUnavailableWorkItem?.(error) === true
      ) {
        unavailableWorkItemNumbers.push(target.number);
        nextWorkItems.push(previousProjectionValue(previous));
        continue;
      }
      throw error;
    }
    throwIfAborted(input.signal);
    assertSnapshotMatchesTarget(snapshot, target);

    const workItem = normalizeWorkItem(snapshot, input.repository.githubRepositoryId);
    const revision = normalizeRevision(snapshot, input.repository.githubRepositoryId, observedAt);
    if (snapshot.state === "closed") {
      await ingest(
        input,
        createWorkItemClosedEvent({ repository, workItem, revision, observedAt }),
      );
      emittedEventCount += 1;
      continue;
    }

    const timeline =
      current === undefined
        ? { items: [], pageCount: 0, truncated: false }
        : await collectPages({
            maxPages: maxTimelinePages,
            signal: input.signal,
            context: (page) => ({ operation: "timeline", page, workItemNumber: target.number }),
            observeRateLimit: input.observeRateLimit,
            load: (page) =>
              input.client.listIssueTimelineEvents({
                repositoryFullName: input.repository.fullName,
                number: target.number,
                page,
                perPage: pageSize,
                ...requestSignal,
              }),
          });
    timelinePageCount += timeline.pageCount;
    if (timeline.truncated) {
      timelineTruncatedWorkItemNumbers.push(target.number);
    }

    const orderedTimeline = orderTimeline(timeline.items);
    const activeRequests = new Map<SchedulingRequestKind, GitHubPollingActiveRequestProjection>();
    const requestKinds = new Set<SchedulingRequestKind>([
      ...(current?.activeRequestKinds ?? []),
      ...(previous?.activeRequests.keys() ?? []),
    ]);

    for (const requestKind of orderedRequestKinds(requestKinds)) {
      const priorRequest = previous?.activeRequests.get(requestKind);
      const observedActive = current?.activeRequestKinds.has(requestKind) ?? false;
      if (!observedActive) {
        if (priorRequest === undefined) {
          continue;
        }
        if (
          !searchCompletedForRequestKind(requestKind, assigned.truncated, reviewRequested.truncated)
        ) {
          activeRequests.set(requestKind, priorRequest);
          continue;
        }
        await ingest(
          input,
          createRequestClosedEvent({
            repository,
            workItem,
            revision,
            requestKind,
            reviewer,
            openedSourceEventId: priorRequest.openedSourceEventId,
            occurredAt: workItem.updatedAt,
            observedAt,
          }),
        );
        emittedEventCount += 1;
        continue;
      }

      const recovered = timeline.truncated
        ? null
        : recoverActiveTimelineRequest(orderedTimeline, requestKind, input.reviewer.githubUserId);
      if (priorRequest !== undefined && recovered === null) {
        activeRequests.set(requestKind, priorRequest);
        continue;
      }

      const openedEvent = createRequestOpenedEvent({
        repository,
        workItem,
        revision,
        requestKind,
        recovered,
        reviewer,
        observedAt,
      });
      if (
        priorRequest !== undefined &&
        priorRequest.openedSourceEventId !== openedEvent.sourceEventId
      ) {
        await ingest(
          input,
          createRequestClosedEvent({
            repository,
            workItem,
            revision,
            requestKind,
            reviewer,
            openedSourceEventId: priorRequest.openedSourceEventId,
            occurredAt: openedEvent.occurredAt,
            observedAt,
          }),
        );
        emittedEventCount += 1;
      }
      if (
        priorRequest === undefined ||
        priorRequest.openedSourceEventId !== openedEvent.sourceEventId
      ) {
        await ingest(input, openedEvent);
        emittedEventCount += 1;
      }
      activeRequests.set(requestKind, {
        requestKind,
        openedSourceEventId: openedEvent.sourceEventId,
      });
    }

    const revisionChanged =
      previous !== undefined && previous.revision.revisionKey !== revision.revisionKey;
    if (
      activeRequests.size > 0 &&
      (revisionChanged || (snapshot.kind === "pull_request" && previous === undefined))
    ) {
      await ingest(
        input,
        createRevisionObservedEvent({
          repository,
          workItem,
          revision,
          observedAt,
        }),
      );
      emittedEventCount += 1;
    }

    if (activeRequests.size > 0) {
      nextWorkItems.push({
        workItem,
        revision,
        activeRequests: orderedRequestKinds(new Set(activeRequests.keys())).map((requestKind) => {
          const request = activeRequests.get(requestKind);
          if (request === undefined) {
            throw new GitHubPollingInvariantError(
              "Active request projection changed unexpectedly.",
            );
          }
          return request;
        }),
      });
    }
  }

  const nextActiveProjection: GitHubPollingActiveProjection = {
    version: 1,
    githubRepositoryId: input.repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    reviewerGithubUserId: input.reviewer.githubUserId,
    reviewerLogin: input.reviewer.login,
    workItems: nextWorkItems,
  };

  return {
    observedAt,
    uniqueWorkItemCount: reconciliationTargets.length,
    emittedEventCount,
    searchPageCount: assigned.pageCount + reviewRequested.pageCount,
    timelinePageCount,
    searchTruncated: assigned.truncated || reviewRequested.truncated,
    timelineTruncatedWorkItemNumbers,
    unavailableWorkItemNumbers,
    nextActiveProjection,
  };
}

function previousProjectionValue(
  previous: PreviousWorkItemProjection,
): GitHubPollingWorkItemProjection {
  return {
    workItem: previous.workItem,
    revision: previous.revision,
    activeRequests: orderedRequestKinds(new Set(previous.activeRequests.keys())).map(
      (requestKind) => {
        const request = previous.activeRequests.get(requestKind);
        if (request === undefined) {
          throw new GitHubPollingInvariantError(
            "Previous active request projection changed unexpectedly.",
          );
        }
        return request;
      },
    ),
  };
}

async function ingest(
  input: ReconcileGitHubPollingInput,
  event: NormalizedSchedulingEvent,
): Promise<void> {
  throwIfAborted(input.signal);
  await input.ingest(event);
  throwIfAborted(input.signal);
}

function readPreviousProjection(
  input: ReconcileGitHubPollingInput,
): ReadonlyMap<number, PreviousWorkItemProjection> {
  const projection = input.previousActiveProjection;
  if (projection === undefined || projection === null) {
    return new Map();
  }
  const workItems = new Map<number, PreviousWorkItemProjection>();
  for (const item of projection.workItems) {
    const activeRequests = new Map<SchedulingRequestKind, GitHubPollingActiveRequestProjection>();
    for (const request of item.activeRequests) {
      if (activeRequests.has(request.requestKind)) {
        throw new GitHubPollingInvariantError(
          `Previous projection repeats ${request.requestKind} for work item ${item.workItem.githubWorkItemId}.`,
        );
      }
      activeRequests.set(request.requestKind, request);
    }
    if (workItems.has(item.workItem.githubWorkItemId)) {
      throw new GitHubPollingInvariantError(
        `Previous projection repeats work item ${item.workItem.githubWorkItemId}.`,
      );
    }
    workItems.set(item.workItem.githubWorkItemId, {
      workItem: item.workItem,
      revision: item.revision,
      activeRequests,
    });
  }
  return workItems;
}

function mergeReconciliationTargets(
  currentById: ReadonlyMap<number, Candidate>,
  previousById: ReadonlyMap<number, PreviousWorkItemProjection>,
): readonly ReconciliationTarget[] {
  const targets = new Map<number, ReconciliationTarget>();
  for (const candidate of currentById.values()) {
    targets.set(candidate.githubWorkItemId, candidate);
  }
  for (const previous of previousById.values()) {
    const target = {
      kind: previous.workItem.kind,
      githubWorkItemId: previous.workItem.githubWorkItemId,
      number: previous.workItem.number,
    } satisfies ReconciliationTarget;
    const current = targets.get(target.githubWorkItemId);
    if (
      current !== undefined &&
      (current.kind !== target.kind || current.number !== target.number)
    ) {
      throw new GitHubPollingInvariantError(
        `Work item ${target.githubWorkItemId} differs between current and previous projections.`,
      );
    }
    targets.set(target.githubWorkItemId, target);
  }
  return [...targets.values()].sort(
    (left, right) =>
      left.number - right.number ||
      left.kind.localeCompare(right.kind) ||
      left.githubWorkItemId - right.githubWorkItemId,
  );
}

function searchCompletedForRequestKind(
  requestKind: SchedulingRequestKind,
  assignedSearchTruncated: boolean,
  reviewRequestedSearchTruncated: boolean,
): boolean {
  return requestKind === "assignment" ? !assignedSearchTruncated : !reviewRequestedSearchTruncated;
}

function mergeCandidates(
  assignedItems: readonly GitHubSearchItem[],
  reviewRequestedItems: readonly GitHubSearchItem[],
): readonly Candidate[] {
  const candidates = new Map<number, Candidate>();
  const merge = (item: GitHubSearchItem, requestKind: SchedulingRequestKind): void => {
    assertPositiveInteger(item.githubWorkItemId, "search item githubWorkItemId");
    assertPositiveInteger(item.number, "search item number");
    if (requestKind === "review_request" && item.kind !== "pull_request") {
      throw new GitHubPollingInvariantError(
        `Review-request search returned non-pull-request item #${item.number}.`,
      );
    }
    const existing = candidates.get(item.githubWorkItemId);
    if (existing !== undefined) {
      if (existing.kind !== item.kind || existing.number !== item.number) {
        throw new GitHubPollingInvariantError(
          `GitHub work item ${item.githubWorkItemId} has inconsistent search projections.`,
        );
      }
      existing.activeRequestKinds.add(requestKind);
      return;
    }
    candidates.set(item.githubWorkItemId, {
      kind: item.kind,
      githubWorkItemId: item.githubWorkItemId,
      number: item.number,
      activeRequestKinds: new Set([requestKind]),
    });
  };

  for (const item of assignedItems) {
    merge(item, "assignment");
  }
  for (const item of reviewRequestedItems) {
    merge(item, "review_request");
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.number - right.number ||
      left.kind.localeCompare(right.kind) ||
      left.githubWorkItemId - right.githubWorkItemId,
  );
}

function orderedRequestKinds(
  requestKinds: ReadonlySet<SchedulingRequestKind>,
): readonly SchedulingRequestKind[] {
  return (["assignment", "review_request"] as const).filter((kind) => requestKinds.has(kind));
}

function orderTimeline(events: readonly GitHubTimelineEvent[]): readonly GitHubTimelineEvent[] {
  for (const event of events) {
    assertDateTime(event.occurredAt, "timeline event occurredAt");
  }
  return [...events].sort((left, right) => {
    const timestampOrder = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    if (timestampOrder !== 0) {
      return timestampOrder;
    }
    return timelineIdentity(left).localeCompare(timelineIdentity(right));
  });
}

function recoverActiveTimelineRequest(
  events: readonly GitHubTimelineEvent[],
  requestKind: SchedulingRequestKind,
  reviewerId: number,
): ActiveTimelineRequest | null {
  let active: ActiveTimelineRequest | null = null;
  const openAction = requestKind === "assignment" ? "assigned" : "review_requested";
  const closeAction = requestKind === "assignment" ? "unassigned" : "review_request_removed";

  for (const event of events) {
    if (event.action !== openAction && event.action !== closeAction) {
      continue;
    }
    if (event.target?.githubUserId !== reviewerId) {
      continue;
    }
    active = event.action === openAction ? { event } : null;
  }
  return active;
}

function createRequestOpenedEvent(input: {
  readonly repository: GitHubRepository;
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly requestKind: SchedulingRequestKind;
  readonly recovered: ActiveTimelineRequest | null;
  readonly reviewer: GitHubActor;
  readonly observedAt: string;
}): NormalizedSchedulingEvent {
  const evidence = input.recovered?.event;
  const sourceMaterial =
    evidence === undefined
      ? [
          "active-state",
          input.repository.githubRepositoryId,
          input.workItem.githubWorkItemId,
          input.requestKind,
          input.reviewer.githubUserId,
          input.workItem.updatedAt,
        ]
      : [
          "timeline",
          input.repository.githubRepositoryId,
          input.workItem.githubWorkItemId,
          input.requestKind,
          timelineIdentity(evidence),
        ];
  const sourceDigest = stableDigest(sourceMaterial);
  return {
    contractVersion: 1,
    eventId: `github-poll-event:v1:request-opened:${sourceDigest}`,
    source: "poll",
    sourceEventId: `github-poll-source:v1:${sourceDigest}`,
    occurredAt: evidence?.occurredAt ?? input.workItem.updatedAt,
    observedAt: input.observedAt,
    repository: input.repository,
    workItem: input.workItem,
    revision: input.revision,
    author: input.workItem.author,
    action: "request_opened",
    requestKind: input.requestKind,
    actor:
      evidence === undefined || evidence.actor === null ? null : normalizeIdentity(evidence.actor),
    target:
      evidence === undefined || evidence.target === null
        ? input.reviewer
        : normalizeIdentity(evidence.target),
  };
}

function createRequestClosedEvent(input: {
  readonly repository: GitHubRepository;
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly requestKind: SchedulingRequestKind;
  readonly reviewer: GitHubActor;
  readonly openedSourceEventId: string;
  readonly occurredAt: string;
  readonly observedAt: string;
}): NormalizedSchedulingEvent {
  const sourceDigest = stableDigest([
    "request-closed",
    input.repository.githubRepositoryId,
    input.workItem.githubWorkItemId,
    input.requestKind,
    input.reviewer.githubUserId,
    input.openedSourceEventId,
  ]);
  return {
    contractVersion: 1,
    eventId: `github-reconciliation-event:v1:request-closed:${sourceDigest}`,
    source: "reconciliation",
    sourceEventId: `github-reconciliation-source:v1:${sourceDigest}`,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    repository: input.repository,
    workItem: input.workItem,
    revision: input.revision,
    author: input.workItem.author,
    action: "request_closed",
    requestKind: input.requestKind,
    actor: null,
    target: input.reviewer,
    closeReason:
      input.requestKind === "assignment" ? "assignment_removed" : "review_request_removed",
  };
}

function createWorkItemClosedEvent(input: {
  readonly repository: GitHubRepository;
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly observedAt: string;
}): NormalizedSchedulingEvent {
  const occurredAt = input.workItem.closedAt ?? input.workItem.updatedAt;
  const sourceDigest = stableDigest([
    "work-item-closed",
    input.repository.githubRepositoryId,
    input.workItem.githubWorkItemId,
    input.revision.revisionKey,
    occurredAt,
  ]);
  return {
    contractVersion: 1,
    eventId: `github-reconciliation-event:v1:work-item-closed:${sourceDigest}`,
    source: "reconciliation",
    sourceEventId: `github-reconciliation-source:v1:${sourceDigest}`,
    occurredAt,
    observedAt: input.observedAt,
    repository: input.repository,
    workItem: input.workItem,
    revision: input.revision,
    author: input.workItem.author,
    action: "work_item_closed",
    requestKind: null,
    actor: null,
    target: null,
    closeReason: "work_item_closed",
  };
}

function createRevisionObservedEvent(input: {
  readonly repository: GitHubRepository;
  readonly workItem: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
  readonly observedAt: string;
}): NormalizedSchedulingEvent {
  const sourceMaterial =
    input.revision.kind === "issue"
      ? [
          "issue-revision",
          input.repository.githubRepositoryId,
          input.workItem.githubWorkItemId,
          input.revision.contentDigest,
        ]
      : [
          "pull-request-revision",
          input.repository.githubRepositoryId,
          input.workItem.githubWorkItemId,
          input.revision.baseSha,
          input.revision.headSha,
        ];
  const sourceDigest = stableDigest(sourceMaterial);
  return {
    contractVersion: 1,
    eventId: `github-poll-event:v1:revision-observed:${sourceDigest}`,
    source: "poll",
    sourceEventId: `github-poll-source:v1:${sourceDigest}`,
    occurredAt: input.workItem.updatedAt,
    observedAt: input.observedAt,
    repository: input.repository,
    workItem: input.workItem,
    revision: input.revision,
    author: input.workItem.author,
    action: "revision_observed",
    requestKind: null,
    actor: null,
    target: null,
  };
}

function normalizeRepository(
  snapshot: GitHubRepositorySnapshot,
  expected: GitHubPollingRepositoryTarget,
): GitHubRepository {
  if (
    snapshot.githubRepositoryId !== expected.githubRepositoryId ||
    snapshot.fullName.toLowerCase() !== expected.fullName.toLowerCase()
  ) {
    throw new GitHubPollingInvariantError(
      `Repository lookup returned ${snapshot.fullName} (${snapshot.githubRepositoryId}) instead of ${expected.fullName} (${expected.githubRepositoryId}).`,
    );
  }
  assertNonEmpty(snapshot.githubNodeId, "repository githubNodeId");
  assertNonEmpty(snapshot.defaultBranch, "repository defaultBranch");
  assertHttpsUrl(snapshot.htmlUrl, "repository htmlUrl");
  const [ownerLogin, name] = snapshot.fullName.split("/");
  if (ownerLogin === undefined || name === undefined) {
    throw new GitHubPollingInvariantError("Repository fullName must contain one owner/name pair.");
  }
  return {
    githubRepositoryId: snapshot.githubRepositoryId,
    githubNodeId: snapshot.githubNodeId,
    ownerLogin,
    name,
    fullName: snapshot.fullName,
    htmlUrl: snapshot.htmlUrl,
    defaultBranch: snapshot.defaultBranch,
    isPrivate: snapshot.isPrivate,
  };
}

function normalizeWorkItem(
  snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot,
  githubRepositoryId: number,
): GitHubWorkItem {
  assertPositiveInteger(snapshot.githubWorkItemId, "work item githubWorkItemId");
  assertPositiveInteger(snapshot.number, "work item number");
  assertNonEmpty(snapshot.githubNodeId, "work item githubNodeId");
  assertNonEmpty(snapshot.title, "work item title");
  assertHttpsUrl(snapshot.htmlUrl, "work item htmlUrl");
  assertDateTime(snapshot.createdAt, "work item createdAt");
  assertDateTime(snapshot.updatedAt, "work item updatedAt");
  if (snapshot.closedAt !== null) {
    assertDateTime(snapshot.closedAt, "work item closedAt");
  }
  const common = {
    githubWorkItemId: snapshot.githubWorkItemId,
    githubNodeId: snapshot.githubNodeId,
    githubRepositoryId,
    number: snapshot.number,
    title: snapshot.title,
    body: snapshot.body,
    state: snapshot.state,
    author: normalizeIdentity(snapshot.author),
    htmlUrl: snapshot.htmlUrl,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    closedAt: snapshot.closedAt,
  };
  return snapshot.kind === "issue"
    ? ({ ...common, kind: "issue" } satisfies GitHubIssue)
    : ({ ...common, kind: "pull_request", isDraft: snapshot.isDraft } satisfies GitHubPullRequest);
}

function normalizeRevision(
  snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot,
  githubRepositoryId: number,
  observedAt: string,
): GitHubWorkItemRevision {
  if (snapshot.kind === "issue") {
    const contentDigest = stableDigest([
      snapshot.title,
      snapshot.body,
      snapshot.state,
      snapshot.updatedAt,
    ]);
    return {
      kind: "issue",
      githubRepositoryId,
      githubWorkItemId: snapshot.githubWorkItemId,
      revisionKey: contentDigest,
      contentDigest,
      observedAt,
      sourceUpdatedAt: snapshot.updatedAt,
    } satisfies GitHubIssueRevision;
  }
  if (!gitObjectIdPattern.test(snapshot.baseSha) || !gitObjectIdPattern.test(snapshot.headSha)) {
    throw new GitHubPollingInvariantError(
      `Pull request #${snapshot.number} returned an invalid base or head object ID.`,
    );
  }
  const baseSha = snapshot.baseSha.toLowerCase();
  const headSha = snapshot.headSha.toLowerCase();
  return {
    kind: "pull_request",
    githubRepositoryId,
    githubWorkItemId: snapshot.githubWorkItemId,
    revisionKey: createPullRequestRevisionKey(baseSha, headSha),
    baseSha,
    headSha,
    observedAt,
    sourceUpdatedAt: snapshot.updatedAt,
  } satisfies GitHubPullRequestRevision;
}

function normalizeIdentity(snapshot: GitHubIdentitySnapshot): GitHubActor {
  assertPositiveInteger(snapshot.githubUserId, "identity githubUserId");
  assertNonEmpty(snapshot.login, "identity login");
  return {
    githubUserId: snapshot.githubUserId,
    login: snapshot.login,
    ...(snapshot.accountType === undefined ? {} : { accountType: snapshot.accountType }),
    ...(snapshot.githubNodeId === undefined ? {} : { githubNodeId: snapshot.githubNodeId }),
    ...(snapshot.avatarUrl === undefined ? {} : { avatarUrl: snapshot.avatarUrl }),
  };
}

function assertSnapshotMatchesTarget(
  snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot,
  target: ReconciliationTarget,
): void {
  if (
    snapshot.kind !== target.kind ||
    snapshot.githubWorkItemId !== target.githubWorkItemId ||
    snapshot.number !== target.number
  ) {
    throw new GitHubPollingInvariantError(
      `GitHub detail lookup for #${target.number} did not match its reconciliation target.`,
    );
  }
}

async function collectPages<T>(input: {
  readonly maxPages: number;
  readonly signal: AbortSignal | undefined;
  readonly context: (page: number) => GitHubPollingPageContext;
  readonly observeRateLimit: ObserveGitHubRateLimit | undefined;
  readonly load: (page: number) => Promise<GitHubPage<T>>;
}): Promise<CollectedPageSet<T>> {
  const items: T[] = [];
  const seenPages = new Set<number>();
  let page: number | null = 1;
  let pageCount = 0;
  let incomplete = false;
  while (page !== null && pageCount < input.maxPages) {
    throwIfAborted(input.signal);
    if (!Number.isSafeInteger(page) || page <= 0 || seenPages.has(page)) {
      throw new GitHubPollingInvariantError(
        `GitHub pagination returned invalid next page ${page}.`,
      );
    }
    seenPages.add(page);
    const response = await input.load(page);
    throwIfAborted(input.signal);
    pageCount += 1;
    items.push(...response.items);
    incomplete ||= response.incomplete === true;
    if (response.rateLimit !== undefined && input.observeRateLimit !== undefined) {
      await input.observeRateLimit(response.rateLimit, input.context(page), input.signal);
      throwIfAborted(input.signal);
    }
    if (response.nextPage !== null && response.nextPage <= page) {
      throw new GitHubPollingInvariantError(
        `GitHub pagination did not advance from page ${page} to ${response.nextPage}.`,
      );
    }
    page = response.nextPage;
  }
  return { items, pageCount, truncated: page !== null || incomplete };
}

function timelineIdentity(event: GitHubTimelineEvent): string {
  if (event.githubEventId !== null) {
    return `github-event:${String(event.githubEventId)}`;
  }
  return `synthetic:${stableDigest([
    event.action,
    event.occurredAt,
    event.actor?.githubUserId ?? null,
    event.target?.githubUserId ?? null,
  ])}`;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
}

function validateInput(input: ReconcileGitHubPollingInput): void {
  assertPositiveInteger(input.repository.githubRepositoryId, "repository githubRepositoryId");
  const repositoryParts = input.repository.fullName.split("/");
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some((part) => !githubNamePattern.test(part))
  ) {
    throw new GitHubPollingInvariantError("repository fullName must be a GitHub owner/name pair.");
  }
  assertPositiveInteger(input.reviewer.githubUserId, "reviewer githubUserId");
  if (!githubLoginPattern.test(input.reviewer.login)) {
    throw new GitHubPollingInvariantError("reviewer login is not a valid GitHub user login.");
  }
  assertBoundedPositiveInteger(input.pageSize ?? DEFAULT_PAGE_SIZE, "pageSize", MAX_PAGE_SIZE);
  assertPositiveInteger(input.maxSearchPages ?? DEFAULT_MAX_SEARCH_PAGES, "maxSearchPages");
  assertPositiveInteger(input.maxTimelinePages ?? DEFAULT_MAX_TIMELINE_PAGES, "maxTimelinePages");
  validatePreviousProjection(input);
}

function validatePreviousProjection(input: ReconcileGitHubPollingInput): void {
  const projection = input.previousActiveProjection;
  if (projection === undefined || projection === null) {
    return;
  }
  if (
    projection.version !== 1 ||
    projection.githubRepositoryId !== input.repository.githubRepositoryId ||
    projection.repositoryFullName.toLowerCase() !== input.repository.fullName.toLowerCase() ||
    projection.reviewerGithubUserId !== input.reviewer.githubUserId
  ) {
    throw new GitHubPollingInvariantError(
      "Previous active projection does not belong to the configured repository and reviewer.",
    );
  }
  if (!githubLoginPattern.test(projection.reviewerLogin)) {
    throw new GitHubPollingInvariantError(
      "Previous active projection has an invalid reviewer login.",
    );
  }

  const workItemIds = new Set<number>();
  for (const item of projection.workItems) {
    if (
      item.workItem.githubRepositoryId !== input.repository.githubRepositoryId ||
      item.revision.githubRepositoryId !== input.repository.githubRepositoryId ||
      item.revision.githubWorkItemId !== item.workItem.githubWorkItemId ||
      item.revision.kind !== item.workItem.kind ||
      item.workItem.state !== "open" ||
      item.activeRequests.length === 0
    ) {
      throw new GitHubPollingInvariantError(
        "Previous active projection contains an inconsistent or inactive work item.",
      );
    }
    assertPositiveInteger(item.workItem.githubWorkItemId, "projected work item githubWorkItemId");
    assertPositiveInteger(item.workItem.number, "projected work item number");
    if (workItemIds.has(item.workItem.githubWorkItemId)) {
      throw new GitHubPollingInvariantError(
        `Previous active projection repeats work item ${item.workItem.githubWorkItemId}.`,
      );
    }
    workItemIds.add(item.workItem.githubWorkItemId);

    const requestKinds = new Set<SchedulingRequestKind>();
    for (const request of item.activeRequests) {
      if (
        (request.requestKind !== "assignment" && request.requestKind !== "review_request") ||
        request.openedSourceEventId.length === 0 ||
        request.openedSourceEventId.length > 512 ||
        (request.requestKind === "review_request" && item.workItem.kind !== "pull_request") ||
        requestKinds.has(request.requestKind)
      ) {
        throw new GitHubPollingInvariantError(
          "Previous active projection contains an invalid active request.",
        );
      }
      requestKinds.add(request.requestKind);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubPollingInvariantError(`${name} must be a positive safe integer.`);
  }
}

function assertBoundedPositiveInteger(value: number, name: string, maximum: number): void {
  assertPositiveInteger(value, name);
  if (value > maximum) {
    throw new GitHubPollingInvariantError(`${name} must not exceed ${maximum}.`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new GitHubPollingInvariantError(`${name} must not be empty.`);
  }
}

function assertHttpsUrl(value: string, name: string): void {
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("not HTTPS");
    }
  } catch {
    throw new GitHubPollingInvariantError(`${name} must be an absolute HTTPS URL.`);
  }
}

function assertDateTime(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new GitHubPollingInvariantError(`${name} must be an ISO-8601 timestamp.`);
  }
}

function signalProperty(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
