import type {
  InvestigationCommentPublicationSummary,
  InvestigationSessionUser,
} from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { investigationApi } from "./api";
import { InvestigationHttpError } from "./transport";

export type CommentAction = "sync" | "reconcile";
export interface RetainedCommentCommand {
  action: CommentAction;
  version: string;
  idempotencyKey: string;
  requestedAt: string;
  state: "submitting" | "unknown" | "conflict" | "refreshed" | "completed" | "rejected";
  message: string;
}

export const commentCommandQueryKey = (id: string) => ["investigation-comment-command", id];

export function hasCommentActionGrant(
  comment: InvestigationCommentPublicationSummary,
  user: InvestigationSessionUser | null | undefined,
  action: CommentAction,
): boolean {
  return Boolean(
    user?.repositoryIds?.includes(comment.repositoryId) &&
      user.permissions.includes("action:prepare") &&
      user.actionCapabilities?.includes("comment") &&
      (action === "reconcile" || user.permissions.includes("action:execute")),
  );
}

export function canScheduleCommentAction(
  comment: InvestigationCommentPublicationSummary,
  user: InvestigationSessionUser | null | undefined,
  action: CommentAction,
  request?: RetainedCommentCommand | null,
): boolean {
  return (
    hasCommentActionGrant(comment, user, action) &&
    comment.availableActions.includes(action) &&
    !["submitting", "unknown", "conflict", "rejected"].includes(request?.state ?? "") &&
    !(
      request?.state === "completed" &&
      request.version === comment.version &&
      request.action === action
    )
  );
}

/** SessionProvider clears this cache on account or grant changes. No request is persisted to disk. */
export async function scheduleCommentCommand(
  client: QueryClient,
  comment: InvestigationCommentPublicationSummary,
  action: CommentAction,
  replay?: RetainedCommentCommand,
): Promise<void> {
  const key = commentCommandQueryKey(comment.id);
  const current = client.getQueryData<RetainedCommentCommand | null>(key);
  if (current?.state === "submitting") return;
  if (replay) {
    if (
      current?.state !== "unknown" ||
      current.idempotencyKey !== replay.idempotencyKey ||
      replay.action !== action
    )
      return;
  } else if (
    !comment.availableActions.includes(action) ||
    (current && ["unknown", "conflict", "rejected"].includes(current.state)) ||
    (current?.state === "completed" &&
      current.version === comment.version &&
      current.action === action)
  )
    return;
  const pending: RetainedCommentCommand = {
    action,
    version: replay?.version ?? comment.version,
    idempotencyKey: replay?.idempotencyKey ?? crypto.randomUUID(),
    requestedAt: replay?.requestedAt ?? new Date().toISOString(),
    state: "submitting",
    message: "Waiting for the service to acknowledge this saved request.",
  };
  client.setQueryDefaults(key, { gcTime: Infinity });
  client.setQueryData(key, pending);
  const stillCurrent = () => {
    const retained = client.getQueryData<RetainedCommentCommand>(key);
    return retained?.idempotencyKey === pending.idempotencyKey && retained.state === "submitting";
  };
  try {
    await client.cancelQueries({ queryKey: ["investigation-comment", comment.id] });
    if (!stillCurrent()) return;
    const updated = await (action === "sync"
      ? investigationApi.syncComment
      : investigationApi.reconcileComment)(comment.id, {
      version: pending.version,
      idempotencyKey: pending.idempotencyKey,
    });
    if (!stillCurrent()) return;
    if (
      updated.id !== comment.id ||
      updated.repositoryId !== comment.repositoryId ||
      updated.workItemKind !== comment.workItemKind ||
      updated.workItemNumber !== comment.workItemNumber
    )
      throw new Error(
        "The service returned a different publication. Check the saved request before continuing.",
      );
    await client.cancelQueries({ queryKey: ["investigation-comment", comment.id] });
    if (!stillCurrent()) return;
    client.setQueryData(["investigation-comment", comment.id], updated);
    client.setQueryData(key, {
      ...pending,
      state: "completed",
      message:
        action === "sync"
          ? "Publication request accepted. Delivery has its own status below."
          : "Delivery check accepted. This check does not write to GitHub.",
    } satisfies RetainedCommentCommand);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["investigation-comments"] }),
      client.invalidateQueries({ queryKey: ["investigation-publications"] }),
      client.invalidateQueries({ queryKey: ["investigation-comment-deliveries"] }),
    ]);
  } catch (cause) {
    if (!stillCurrent()) return;
    const conflict = cause instanceof InvestigationHttpError && cause.status === 409;
    const rejected =
      cause instanceof InvestigationHttpError &&
      cause.status >= 400 &&
      cause.status < 500 &&
      cause.status !== 408 &&
      cause.status !== 429;
    client.setQueryData(key, {
      ...pending,
      state: conflict ? "conflict" : rejected ? "rejected" : "unknown",
      message: conflict
        ? "This comment changed. Refresh its status and review the latest state before a new request."
        : rejected
          ? cause.message
          : "The response was not confirmed. Check status or retry this same saved request; do not schedule another publication.",
    } satisfies RetainedCommentCommand);
  }
}
