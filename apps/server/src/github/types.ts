import type { NormalizedSchedulingEvent } from "@agentic-review/contracts";

export type GitHubWebhookEventName = "issues" | "pull_request";

export type GitHubIssueWebhookAction = "assigned" | "unassigned" | "edited" | "closed" | "reopened";

export type GitHubPullRequestWebhookAction =
  | "assigned"
  | "unassigned"
  | "review_requested"
  | "review_request_removed"
  | "synchronize"
  | "closed"
  | "reopened";

export type GitHubWebhookAction = GitHubIssueWebhookAction | GitHubPullRequestWebhookAction;

export interface GitHubWebhookDeliveryMetadata {
  readonly deliveryId: string;
  readonly eventName: GitHubWebhookEventName;
  readonly payloadSha256: string;
  readonly receivedAt: string;
}

export type IngestGitHubWebhookEvent = (
  event: NormalizedSchedulingEvent,
  delivery: GitHubWebhookDeliveryMetadata,
) => Promise<void>;
