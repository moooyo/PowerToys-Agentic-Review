import { createHash } from "node:crypto";
import type {
  GitHubActor,
  GitHubIssue,
  GitHubIssueRevision,
  GitHubPullRequest,
  GitHubPullRequestRevision,
  GitHubRepository,
  NormalizedSchedulingEvent,
} from "@agentic-review/contracts";
import { createPullRequestRevisionKey } from "./revision-key.js";
import type {
  GitHubIssueWebhookAction,
  GitHubPullRequestWebhookAction,
  GitHubWebhookEventName,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const issueActions = new Set<GitHubIssueWebhookAction>([
  "assigned",
  "unassigned",
  "edited",
  "closed",
  "reopened",
]);
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const pullRequestActions = new Set<GitHubPullRequestWebhookAction>([
  "assigned",
  "unassigned",
  "review_requested",
  "review_request_removed",
  "synchronize",
  "closed",
  "reopened",
]);

export class InvalidGitHubWebhookPayloadError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidGitHubWebhookPayloadError";
  }
}

export class UnsupportedGitHubWebhookActionError extends Error {
  public constructor(
    public readonly eventName: GitHubWebhookEventName,
    public readonly action: string,
  ) {
    super(`GitHub webhook action ${eventName}.${action} is not supported.`);
    this.name = "UnsupportedGitHubWebhookActionError";
  }
}

export class UnsupportedGitHubWebhookTargetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedGitHubWebhookTargetError";
  }
}

const invalid = (path: string, expectation: string): never => {
  throw new InvalidGitHubWebhookPayloadError(`${path} ${expectation}.`);
};

const readRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "must be an object");
  }
  return value as JsonRecord;
};

const readString = (
  record: JsonRecord,
  key: string,
  path: string,
  maximumLength: number,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    return invalid(
      `${path}.${key}`,
      `must be a non-empty string of at most ${maximumLength} characters`,
    );
  }
  return value;
};

const readNullableString = (
  record: JsonRecord,
  key: string,
  path: string,
  maximumLength: number,
): string | null => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    return invalid(
      `${path}.${key}`,
      `must be null or a string of at most ${maximumLength} characters`,
    );
  }
  return value;
};

const readPositiveInteger = (record: JsonRecord, key: string, path: string): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalid(`${path}.${key}`, "must be a positive safe integer");
  }
  return value as number;
};

const readBoolean = (record: JsonRecord, key: string, path: string): boolean => {
  const value = record[key];
  if (typeof value !== "boolean") {
    return invalid(`${path}.${key}`, "must be a boolean");
  }
  return value;
};

const readState = (record: JsonRecord, path: string): "open" | "closed" => {
  const state = readString(record, "state", path, 16);
  if (state !== "open" && state !== "closed") {
    return invalid(`${path}.state`, 'must be either "open" or "closed"');
  }
  return state;
};

const readUrl = (record: JsonRecord, key: string, path: string): string => {
  const value = readString(record, key, path, 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`${path}.${key}`, "must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    return invalid(`${path}.${key}`, "must use HTTPS");
  }
  return value;
};

const normalizeTimestamp = (value: string, path: string): string => {
  const timestamp = Date.parse(value);
  if (!dateTimePattern.test(value) || !Number.isFinite(timestamp)) {
    return invalid(path, "must be an ISO-8601 timestamp");
  }
  return value;
};

const readTimestamp = (record: JsonRecord, key: string, path: string): string =>
  normalizeTimestamp(readString(record, key, path, 64), `${path}.${key}`);

const readNullableTimestamp = (record: JsonRecord, key: string, path: string): string | null => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return invalid(`${path}.${key}`, "must be null or an ISO-8601 timestamp");
  }
  return normalizeTimestamp(value, `${path}.${key}`);
};

const readAccountType = (record: JsonRecord, path: string): "user" | "bot" | "app" => {
  const value = readString(record, "type", path, 64).toLowerCase();
  if (value !== "user" && value !== "bot" && value !== "app") {
    return invalid(`${path}.type`, 'must be "User", "Bot", or "App"');
  }
  return value;
};

const readIdentity = (value: unknown, path: string): GitHubActor => {
  const record = readRecord(value, path);
  return {
    githubUserId: readPositiveInteger(record, "id", path),
    githubNodeId: readString(record, "node_id", path, 256),
    login: readString(record, "login", path, 128),
    accountType: readAccountType(record, path),
  };
};

const readRepository = (value: unknown): GitHubRepository => {
  const path = "payload.repository";
  const record = readRecord(value, path);
  const owner = readRecord(record.owner, `${path}.owner`);
  const fullName = readString(record, "full_name", path, 201);
  const name = readString(record, "name", path, 100);
  if (!fullName.endsWith(`/${name}`)) {
    return invalid(`${path}.full_name`, "must end with the repository name");
  }

  return {
    githubRepositoryId: readPositiveInteger(record, "id", path),
    githubNodeId: readString(record, "node_id", path, 256),
    ownerLogin: readString(owner, "login", `${path}.owner`, 128),
    name,
    fullName,
    htmlUrl: readUrl(record, "html_url", path),
    defaultBranch: readString(record, "default_branch", path, 255),
    isPrivate: readBoolean(record, "private", path),
  };
};

const readCommonWorkItem = (value: unknown, path: string, githubRepositoryId: number) => {
  const record = readRecord(value, path);
  const author = readIdentity(record.user, `${path}.user`);
  return {
    record,
    common: {
      githubWorkItemId: readPositiveInteger(record, "id", path),
      githubNodeId: readString(record, "node_id", path, 256),
      githubRepositoryId,
      number: readPositiveInteger(record, "number", path),
      title: readString(record, "title", path, 1_024),
      body: readNullableString(record, "body", path, 1_048_576),
      state: readState(record, path),
      author,
      htmlUrl: readUrl(record, "html_url", path),
      createdAt: readTimestamp(record, "created_at", path),
      updatedAt: readTimestamp(record, "updated_at", path),
      closedAt: readNullableTimestamp(record, "closed_at", path),
    },
  };
};

const readIssue = (value: unknown, githubRepositoryId: number): GitHubIssue => {
  const { common } = readCommonWorkItem(value, "payload.issue", githubRepositoryId);
  return { kind: "issue", ...common };
};

const readGitSha = (record: JsonRecord, path: string): string => {
  const sha = readString(record, "sha", path, 64);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) {
    return invalid(`${path}.sha`, "must be a 40- or 64-character hexadecimal object ID");
  }
  return sha.toLowerCase();
};

const readPullRequest = (value: unknown, githubRepositoryId: number): GitHubPullRequest => {
  const path = "payload.pull_request";
  const { common, record } = readCommonWorkItem(value, path, githubRepositoryId);

  return {
    kind: "pull_request",
    ...common,
    isDraft: readBoolean(record, "draft", path),
  };
};

const readPullRequestRevision = (
  value: unknown,
  workItem: GitHubPullRequest,
  observedAt: string,
): GitHubPullRequestRevision => {
  const path = "payload.pull_request";
  const record = readRecord(value, path);
  const headSha = readGitSha(readRecord(record.head, `${path}.head`), `${path}.head`);
  const baseSha = readGitSha(readRecord(record.base, `${path}.base`), `${path}.base`);
  return {
    kind: "pull_request",
    githubRepositoryId: workItem.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    revisionKey: createPullRequestRevisionKey(baseSha, headSha),
    baseSha,
    headSha,
    observedAt,
    sourceUpdatedAt: workItem.updatedAt,
  };
};

const readIssueRevision = (workItem: GitHubIssue, observedAt: string): GitHubIssueRevision => {
  const contentDigest = createHash("sha256")
    .update(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]))
    .digest("hex");
  return {
    kind: "issue",
    githubRepositoryId: workItem.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    revisionKey: contentDigest,
    contentDigest,
    observedAt,
    sourceUpdatedAt: workItem.updatedAt,
  };
};

const readAction = (payload: JsonRecord): string => readString(payload, "action", "payload", 64);

const assertIssueAction = (action: string): GitHubIssueWebhookAction => {
  if (!issueActions.has(action as GitHubIssueWebhookAction)) {
    throw new UnsupportedGitHubWebhookActionError("issues", action);
  }
  return action as GitHubIssueWebhookAction;
};

const assertPullRequestAction = (action: string): GitHubPullRequestWebhookAction => {
  if (!pullRequestActions.has(action as GitHubPullRequestWebhookAction)) {
    throw new UnsupportedGitHubWebhookActionError("pull_request", action);
  }
  return action as GitHubPullRequestWebhookAction;
};

const assertDeliveryId = (deliveryId: string): void => {
  if (deliveryId.length === 0 || deliveryId.length > 512) {
    invalid("deliveryId", "must be a non-empty string of at most 512 characters");
  }
};

export interface NormalizeGitHubWebhookInput {
  readonly deliveryId: string;
  readonly eventName: GitHubWebhookEventName;
  readonly receivedAt: string;
  readonly payload: unknown;
}

export const normalizeGitHubWebhookPayload = (
  input: NormalizeGitHubWebhookInput,
): NormalizedSchedulingEvent => {
  assertDeliveryId(input.deliveryId);
  const observedAt = normalizeTimestamp(input.receivedAt, "receivedAt");
  const payload = readRecord(input.payload, "payload");
  const repository = readRepository(payload.repository);
  const actor = readIdentity(payload.sender, "payload.sender");
  const eventBase = {
    contractVersion: 1 as const,
    eventId: `github:webhook:${input.deliveryId}`,
    source: "webhook" as const,
    sourceEventId: input.deliveryId,
    observedAt,
    repository,
    actor,
  };

  if (input.eventName === "issues") {
    const action = assertIssueAction(readAction(payload));
    const workItem = readIssue(payload.issue, repository.githubRepositoryId);
    const revision = readIssueRevision(workItem, observedAt);
    const issueBase = {
      ...eventBase,
      occurredAt: workItem.updatedAt,
      workItem,
      revision,
      author: workItem.author,
    };

    if (action === "assigned" || action === "unassigned") {
      const common = {
        ...issueBase,
        requestKind: "assignment" as const,
        target: readIdentity(payload.assignee, "payload.assignee"),
      };
      return action === "assigned"
        ? { ...common, action: "request_opened" }
        : { ...common, action: "request_closed", closeReason: "assignment_removed" };
    }

    if (action === "closed") {
      if (workItem.state !== "closed" || workItem.closedAt === null) {
        return invalid(
          "payload.issue",
          "must be closed and include closed_at for the closed action",
        );
      }
      return {
        ...issueBase,
        action: "work_item_closed",
        requestKind: null,
        target: null,
        closeReason: "work_item_closed",
      };
    }

    if (action === "edited") {
      return {
        ...issueBase,
        action: "revision_observed",
        requestKind: null,
        target: null,
      };
    }

    if (workItem.state !== "open" || workItem.closedAt !== null) {
      return invalid(
        "payload.issue",
        "must be open and have a null closed_at for the reopened action",
      );
    }
    return {
      ...issueBase,
      action: "work_item_reopened",
      requestKind: null,
      target: null,
    };
  }

  const action = assertPullRequestAction(readAction(payload));
  const workItem = readPullRequest(payload.pull_request, repository.githubRepositoryId);
  const revision = readPullRequestRevision(payload.pull_request, workItem, observedAt);
  const pullRequestBase = {
    ...eventBase,
    occurredAt: workItem.updatedAt,
    workItem,
    revision,
    author: workItem.author,
  };

  if (action === "assigned" || action === "unassigned") {
    const common = {
      ...pullRequestBase,
      requestKind: "assignment" as const,
      target: readIdentity(payload.assignee, "payload.assignee"),
    };
    return action === "assigned"
      ? { ...common, action: "request_opened" }
      : { ...common, action: "request_closed", closeReason: "assignment_removed" };
  }

  if (action === "review_requested" || action === "review_request_removed") {
    if (payload.requested_reviewer === null || payload.requested_reviewer === undefined) {
      throw new UnsupportedGitHubWebhookTargetError(
        "Only user review targets represented by payload.requested_reviewer are supported.",
      );
    }
    const common = {
      ...pullRequestBase,
      requestKind: "review_request" as const,
      target: readIdentity(payload.requested_reviewer, "payload.requested_reviewer"),
    };
    return action === "review_requested"
      ? { ...common, action: "request_opened" }
      : { ...common, action: "request_closed", closeReason: "review_request_removed" };
  }

  if (action === "closed") {
    if (workItem.state !== "closed" || workItem.closedAt === null) {
      return invalid(
        "payload.pull_request",
        "must be closed and include closed_at for the closed action",
      );
    }
    return {
      ...pullRequestBase,
      action: "work_item_closed",
      requestKind: null,
      target: null,
      closeReason: "work_item_closed",
    };
  }

  if (action === "reopened") {
    if (workItem.state !== "open" || workItem.closedAt !== null) {
      return invalid(
        "payload.pull_request",
        "must be open and have a null closed_at for the reopened action",
      );
    }
    return {
      ...pullRequestBase,
      action: "work_item_reopened",
      requestKind: null,
      target: null,
    };
  }

  return {
    ...pullRequestBase,
    action: "revision_observed",
    requestKind: null,
    target: null,
  };
};
