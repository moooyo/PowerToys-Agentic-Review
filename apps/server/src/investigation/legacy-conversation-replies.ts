import type {
  InvestigationActionIntentV1,
  InvestigationCreateActionIntentRequest,
  InvestigationReportRef,
  InvestigationResultV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { AutomaticReplyReceipt } from "./auto-reply.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationCommentTarget,
  InvestigationGitHubIdentity,
  InvestigationRepositoryRecord,
} from "./types.js";

interface RetainedAutomaticReply extends AutomaticReplyReceipt {
  readonly repository: InvestigationRepositoryRecord;
  readonly reportRef: InvestigationReportRef;
  readonly request: InvestigationCreateActionIntentRequest | null;
  readonly githubIdentity?: InvestigationGitHubIdentity;
}

export interface LegacyConversationConfirmation {
  readonly recordId: string;
  readonly taskId: string;
  readonly reportId: string;
  readonly marker: string;
  readonly body: string;
  readonly externalId: string;
  readonly githubIdentity: InvestigationGitHubIdentity;
  readonly confirmedAt: string;
  readonly settingsVersion: number;
  readonly templateVersion: number;
}

const equal = (left: unknown, right: unknown) =>
  investigationContentDigest(left) === investigationContentDigest(right);

/** Reads retained native receipts without granting authority or mutating their history. */
export function inspectLegacyConversationReplies(input: {
  readonly store: InvestigationStore;
  readonly repository: InvestigationRepositoryRecord;
  readonly target: Pick<InvestigationCommentTarget, "kind" | "number">;
  readonly channel: "static" | "e2e";
}): { readonly confirmed: LegacyConversationConfirmation | null; readonly blocked: boolean } {
  const candidates: LegacyConversationConfirmation[] = [];
  let blocked = false;
  const records = input.store.list<RetainedAutomaticReply>(
    "idempotency",
    (value) =>
      value !== null &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      value.id.startsWith("auto-reply:report:") &&
      value.repository?.id === input.repository.id &&
      value.workItemKind === input.target.kind &&
      value.workItemNumber === input.target.number,
  );
  for (const record of records) {
    const task = input.store.get<InvestigationTaskV1>("tasks", record.taskId);
    const report = input.store.get<InvestigationResultV1>("reports", record.reportId);
    const kind = task?.kind ?? report?.context.task.kind;
    if (kind !== undefined && (kind === "pr-e2e" ? "e2e" : "static") !== input.channel) continue;
    const actorId = `automatic-reply:${investigationContentDigest(record.repository.id).slice(0, 32)}`;
    const intents = input.store.list<InvestigationActionIntentV1>(
      "actionIntents",
      (intent) =>
        intent.actorId === actorId && intent.idempotencyKey === `auto-reply:${record.reportId}`,
    );
    const intent = intents.length === 1 ? intents[0] : undefined;
    const mayHaveWritten =
      ["sent", "sending", "unknown"].includes(record.state) ||
      record.externalId !== null ||
      intents.some((entry) => ["executing", "unknown", "succeeded"].includes(entry.state));
    if (!mayHaveWritten) continue;
    const request = record.request;
    const identity = record.githubIdentity;
    if (
      !equal(record.repository, input.repository) ||
      kind === undefined ||
      intent === undefined ||
      intent.state !== "succeeded" ||
      intent.action !== "comment" ||
      intent.repositoryId !== input.repository.id ||
      intent.workItemId !== record.workItemId ||
      (record.intentId !== null && record.intentId !== intent.id) ||
      request === null ||
      intent.subjectRef !== request.subjectRef ||
      intent.expectedRevisionKey !== request.expectedRevisionKey ||
      intent.expectedHeadSha !== request.expectedHeadSha ||
      !equal(intent.reportRef, record.reportRef) ||
      !equal(intent.payload, request.payload) ||
      intent.payloadDigest !== investigationContentDigest(request.payload) ||
      intent.payload.kind !== "feedback" ||
      identity === undefined ||
      !Number.isSafeInteger(identity.githubUserId) ||
      identity.githubUserId < 1 ||
      typeof identity.githubLogin !== "string" ||
      identity.githubLogin.length === 0 ||
      typeof intent.result?.externalId !== "string" ||
      !/^[1-9][0-9]*$/u.test(intent.result.externalId) ||
      (record.externalId !== null && record.externalId !== intent.result.externalId)
    ) {
      blocked = true;
      continue;
    }
    const marker = `<!-- agentic-review-action:${intent.id}:${intent.payloadDigest} -->`;
    const body = [
      intent.payload.body,
      ...intent.payload.drafts
        .filter((draft) => draft.suggestion === null)
        .map((draft) => draft.body),
      marker,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (
      !/^<!-- agentic-review-action:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}:[a-f0-9]{64} -->$/u.test(
        marker,
      ) ||
      Buffer.byteLength(body, "utf8") > 60_000 ||
      body.split("<!-- agentic-review-action:").length !== 2 ||
      body.includes("<!-- agentic-review-progress:")
    ) {
      blocked = true;
      continue;
    }
    candidates.push({
      recordId: record.id,
      taskId: record.taskId,
      reportId: record.reportId,
      marker,
      body,
      externalId: intent.result.externalId,
      githubIdentity: structuredClone(identity),
      confirmedAt: record.updatedAt,
      settingsVersion: record.settingsVersion,
      templateVersion: record.templateVersion,
    });
  }
  candidates.sort(
    (left, right) =>
      right.confirmedAt.localeCompare(left.confirmedAt) ||
      left.recordId.localeCompare(right.recordId),
  );
  return { confirmed: candidates[0] ?? null, blocked };
}
