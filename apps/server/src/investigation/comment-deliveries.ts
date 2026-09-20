import { randomUUID } from "node:crypto";
import {
  type InvestigationCommentDelivery,
  type InvestigationCommentDeliveryList,
  type InvestigationCommentDeliveryQuery,
  InvestigationCommentDeliveryQuerySchema,
  InvestigationCommentDeliverySchema,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { commentDeliveryState } from "./comment-delivery-state.js";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

type Delivery = InvestigationCommentDelivery;
type TerminalState = Exclude<Delivery["state"], "sending">;
type Effect = Exclude<Delivery["effect"], null>;

export type BeginCommentDeliveryInput = Pick<
  Delivery,
  | "commentId"
  | "mode"
  | "repositoryId"
  | "repositoryFullName"
  | "workItemKind"
  | "workItemNumber"
  | "operation"
  | "body"
  | "settingsVersion"
  | "templateVersion"
> &
  Partial<
    Pick<
      Delivery,
      "id" | "startedAt" | "workItemId" | "taskId" | "reportId" | "externalId" | "attemptNumber"
    >
  > & { readonly sourceReceiptId?: string | null };

export interface CommentDeliveryResult {
  readonly state: TerminalState;
  readonly reason?: string | null;
  readonly effect?: Effect;
  readonly externalId?: string | null;
  readonly at?: string;
}
export type CommentDeliveryObservationInput = Omit<CommentDeliveryResult, "effect" | "state"> & {
  readonly state: Exclude<TerminalState, "cancelled">;
};
export type LegacyCommentDeliveryInput = BeginCommentDeliveryInput & {
  readonly id: string;
  readonly startedAt: string;
  readonly state: Delivery["state"];
  readonly finishedAt?: string | null;
  readonly reason?: string | null;
  readonly effect?: Effect | null;
};

interface OriginalReceipt {
  readonly state: TerminalState;
  readonly reason: string | null;
  readonly effect: Effect;
  readonly externalId: string | null;
  readonly at: string | null;
}
interface StoredDelivery extends Delivery {
  readonly sourceReceiptId?: string | null;
  readonly inputDigest: string;
  readonly initialTaskId: string | null;
  readonly initialWorkItemId: string | null;
  readonly initialExternalId: string | null;
  readonly dispatchedAt: string | null;
  readonly originalReceipt: OriginalReceipt | null;
}
interface Cursor {
  readonly version: 1;
  readonly scope: string;
  readonly startedAt: string;
  readonly id: string;
}

export interface InvestigationCommentDeliveriesOptions {
  readonly store: InvestigationStore;
  readonly now?: () => Date;
}

/** Records actual publishing attempts. It never submits a request or manufactures a Task event. */
export class InvestigationCommentDeliveries {
  readonly #now: () => Date;
  constructor(private readonly options: InvestigationCommentDeliveriesOptions) {
    this.#now = options.now ?? (() => new Date());
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }

  /** Safe to call inside the publication's existing synchronous transaction. */
  begin(input: BeginCommentDeliveryInput): Delivery {
    return this.#atomic(() => this.#begin(input, false));
  }

  markDispatched(id: string): void {
    this.#atomic(() => {
      const record = this.#record(id);
      requireCondition(
        record.originalReceipt === null,
        409,
        "comment_delivery_finished",
        "The delivery attempt is already finished.",
      );
      requireCondition(
        record.dispatchedAt === null,
        409,
        "comment_delivery_dispatched",
        "The delivery attempt was already marked as dispatched.",
      );
      this.options.store.put("commentDeliveries", id, {
        ...record,
        dispatchedAt: this.#now().toISOString(),
      });
    });
  }

  finish(id: string, result: CommentDeliveryResult): Delivery {
    return this.#atomic(() => {
      const record = this.#record(id);
      const receipt: OriginalReceipt = {
        state: result.state,
        reason: result.reason ?? null,
        effect:
          result.effect ??
          (result.state === "succeeded"
            ? "applied"
            : result.state === "unknown"
              ? "unknown"
              : record.dispatchedAt === null
                ? "not_sent"
                : "rejected"),
        externalId:
          result.externalId === undefined
            ? record.originalReceipt === null
              ? record.externalId
              : record.originalReceipt.externalId
            : result.externalId,
        at: this.#timestamp(result.at ?? record.originalReceipt?.at ?? this.#now().toISOString()),
      };
      this.#validateOutcome(receipt.state, receipt.effect, receipt.externalId);
      requireCondition(
        receipt.state !== "cancelled" || record.dispatchedAt === null,
        400,
        "comment_delivery_receipt_invalid",
        "A dispatched delivery attempt cannot be cancelled.",
      );
      if (record.originalReceipt !== null) {
        requireCondition(
          this.#equal(record.originalReceipt, receipt),
          409,
          "comment_delivery_immutable",
          "A finished delivery receipt cannot be replaced.",
        );
        return this.#view(record);
      }
      this.#assertExternalId(record, receipt.externalId);
      const next: StoredDelivery = {
        ...record,
        state: receipt.state,
        reason: receipt.reason,
        effect: receipt.effect,
        externalId: receipt.externalId,
        finishedAt: receipt.at,
        originalReceipt: receipt,
      };
      this.#save(next);
      return this.#view(next);
    });
  }

  /** A readback appends evidence to the original attempt, never a fictitious create/update row. */
  observe(id: string, result: CommentDeliveryObservationInput): Delivery {
    return this.#atomic(() => {
      let record = this.#record(id);
      if (record.originalReceipt === null) {
        requireCondition(
          record.dispatchedAt !== null,
          409,
          "comment_delivery_not_dispatched",
          "An undispatched attempt cannot have an ambiguous-write readback.",
        );
        this.finish(id, {
          state: "unknown",
          effect: "unknown",
          reason: "The dispatched attempt ended without a recorded response.",
          ...(result.at === undefined ? {} : { at: result.at }),
        });
        record = this.#record(id);
      }
      const externalId = result.externalId === undefined ? record.externalId : result.externalId;
      this.#assertExternalId(record, externalId);
      if (result.state === "succeeded")
        requireCondition(
          externalId !== null,
          400,
          "comment_delivery_receipt_invalid",
          "A successful readback requires a comment identity.",
        );
      const observation = {
        at: this.#timestamp(result.at ?? this.#now().toISOString()),
        state: result.state,
        reason: result.reason ?? null,
      };
      if (record.observations.some((value) => this.#equal(value, observation)))
        return this.#view(record);
      // A failed read cannot establish whether an ambiguous write was applied. Readbacks also
      // cannot attribute a later retry's success to an earlier definitively rejected attempt.
      const resolvesUnknown = record.state === "unknown" && observation.state === "succeeded";
      const next: StoredDelivery = {
        ...record,
        state: resolvesUnknown ? "succeeded" : record.state,
        reason: record.state === "unknown" ? observation.reason : record.reason,
        effect: resolvesUnknown ? "applied" : record.effect,
        externalId: record.state === "unknown" ? externalId : record.externalId,
        observations: [...record.observations, observation],
      };
      this.#save(next);
      return this.#view(next);
    });
  }

  attachTask(
    commentId: string,
    taskId: string,
    workItemId: string,
    sourceReceiptId?: string | null,
  ): void {
    this.#atomic(() => {
      let before: { startedAt: string; id: string } | undefined;
      for (;;) {
        const records = this.options.store.pageCommentDeliveries<StoredDelivery>({
          commentId,
          limit: 100,
          ...(before === undefined ? {} : { before }),
        });
        for (const record of records) {
          // A shared comment keeps each attempt attributed to its originating intake cycle.
          if (
            sourceReceiptId !== undefined &&
            (record.taskId !== null || record.sourceReceiptId !== sourceReceiptId)
          )
            continue;
          requireCondition(
            (record.taskId === null || record.taskId === taskId) &&
              (record.workItemId === null || record.workItemId === workItemId),
            409,
            "comment_delivery_task_conflict",
            "This comment history already belongs to another Task or work item.",
          );
          this.#save({ ...record, taskId, workItemId });
        }
        if (records.length < 100) break;
        const last = records.at(-1)!;
        before = { startedAt: last.startedAt, id: last.id };
      }
    });
  }

  /** Imports exactly one retained legacy snapshot. The caller supplies its actual retained timestamp. */
  importLegacy(input: LegacyCommentDeliveryInput): Delivery {
    return this.#atomic(() => {
      const previous = this.options.store.get<StoredDelivery>("commentDeliveries", input.id);
      const begun = this.#begin(input, true);
      if (previous !== undefined) return begun;
      const record = this.#record(begun.id);
      const effect =
        input.effect ??
        (input.state === "succeeded"
          ? "applied"
          : input.state === "failed"
            ? "rejected"
            : input.state === "cancelled"
              ? "not_sent"
              : input.state === "unknown"
                ? "unknown"
                : null);
      if (input.state !== "sending") this.#validateOutcome(input.state, effect!, record.externalId);
      const next: StoredDelivery = {
        ...record,
        state: input.state,
        reason: input.reason ?? null,
        effect,
        finishedAt: input.finishedAt == null ? null : this.#timestamp(input.finishedAt),
        originalReceipt:
          input.state === "sending"
            ? null
            : {
                state: input.state,
                reason: input.reason ?? null,
                effect: effect!,
                externalId: record.externalId,
                at: input.finishedAt == null ? null : this.#timestamp(input.finishedAt),
              },
      };
      this.#save(next);
      return this.#view(next);
    });
  }

  read(actor: InvestigationOperatorPrincipal, id: string): Delivery {
    const record = this.#record(id);
    this.#authorize(actor, record.repositoryId);
    return this.#view(record);
  }

  list(
    actor: InvestigationOperatorPrincipal,
    query: InvestigationCommentDeliveryQuery = {},
  ): InvestigationCommentDeliveryList {
    requireCondition(
      Value.Check(InvestigationCommentDeliveryQuerySchema, query),
      400,
      "comment_delivery_query_invalid",
      "The comment delivery query is invalid.",
    );
    if (query.repositoryId !== undefined) this.#authorize(actor, query.repositoryId);
    const repositoryIds =
      query.repositoryId === undefined
        ? [...new Set(actor.repositoryIds)].sort()
        : [query.repositoryId];
    const { cursor, limit = 25, ...filters } = query;
    const scope = investigationContentDigest({ actorId: actor.id, repositoryIds, filters });
    const before = cursor === undefined ? undefined : this.#cursor(cursor, scope);
    const records = this.options.store.pageCommentDeliveries<StoredDelivery>({
      repositoryIds,
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.commentId === undefined ? {} : { commentId: query.commentId }),
      ...(query.workItemNumber === undefined ? {} : { workItemNumber: query.workItemNumber }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.mode === undefined ? {} : { mode: query.mode }),
      ...(before === undefined ? {} : { before }),
      limit: limit + 1,
    });
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((record) => this.#view(record)),
      nextCursor:
        records.length > limit && last !== undefined
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                scope,
                startedAt: last.startedAt,
                id: last.id,
              } satisfies Cursor),
            ).toString("base64url")
          : null,
    };
  }

  #begin(input: BeginCommentDeliveryInput, legacy: boolean): Delivery {
    const id = input.id ?? `comment-delivery:${randomUUID()}`;
    const existing = this.options.store.get<StoredDelivery>("commentDeliveries", id);
    const latest = this.options.store.pageCommentDeliveries<StoredDelivery>({
      commentId: input.commentId,
      limit: 1,
    })[0];
    const draft: Delivery = {
      id,
      commentId: input.commentId,
      mode: input.mode,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      workItemId:
        input.workItemId === undefined ? (existing?.initialWorkItemId ?? null) : input.workItemId,
      workItemKind: input.workItemKind,
      workItemNumber: input.workItemNumber,
      taskId: input.taskId === undefined ? (existing?.initialTaskId ?? null) : input.taskId,
      reportId: input.reportId ?? null,
      operation: input.operation,
      state: "sending",
      body: input.body,
      externalId:
        input.externalId === undefined ? (existing?.initialExternalId ?? null) : input.externalId,
      startedAt: this.#timestamp(
        input.startedAt ?? existing?.startedAt ?? this.#now().toISOString(),
      ),
      finishedAt: null,
      reason: null,
      effect: null,
      attemptNumber:
        input.attemptNumber ??
        existing?.attemptNumber ??
        (legacy ? 0 : this.options.store.maximumCommentDeliveryAttemptNumber(input.commentId) + 1),
      settingsVersion: input.settingsVersion,
      templateVersion: input.templateVersion,
      legacy,
      observations: [],
    };
    this.#validate(draft);
    requireCondition(
      legacy || draft.attemptNumber > 0,
      400,
      "comment_delivery_attempt_invalid",
      "A new delivery attempt requires a positive attempt number.",
    );
    const inputDigest = investigationContentDigest(draft);
    if (existing !== undefined) {
      requireCondition(
        existing.inputDigest === inputDigest,
        409,
        "comment_delivery_conflict",
        "This delivery identity already refers to different frozen content.",
      );
      return this.#view(existing);
    }
    if (latest !== undefined)
      requireCondition(
        latest.repositoryId === draft.repositoryId &&
          latest.repositoryFullName === draft.repositoryFullName &&
          latest.workItemKind === draft.workItemKind &&
          latest.workItemNumber === draft.workItemNumber &&
          latest.mode === draft.mode &&
          (latest.workItemId === null ||
            draft.workItemId === null ||
            latest.workItemId === draft.workItemId),
        409,
        "comment_delivery_target_conflict",
        "A comment history cannot change its repository or conversation.",
      );
    const record: StoredDelivery = {
      ...draft,
      ...(input.sourceReceiptId === undefined ? {} : { sourceReceiptId: input.sourceReceiptId }),
      inputDigest,
      initialTaskId: draft.taskId,
      initialWorkItemId: draft.workItemId,
      initialExternalId: draft.externalId,
      dispatchedAt: null,
      originalReceipt: null,
    };
    this.options.store.insert("commentDeliveries", id, record);
    return this.#view(record);
  }

  #record(id: string): StoredDelivery {
    const record = this.options.store.get<StoredDelivery>("commentDeliveries", id);
    requireCondition(
      record !== undefined,
      404,
      "comment_delivery_not_found",
      "The comment delivery record does not exist.",
    );
    return record;
  }

  #view(record: StoredDelivery): Delivery {
    const {
      inputDigest: _digest,
      initialTaskId: _task,
      initialWorkItemId: _item,
      initialExternalId: _external,
      dispatchedAt: _dispatched,
      originalReceipt: _receipt,
      sourceReceiptId: _sourceReceipt,
      ...view
    } = record;
    return structuredClone({ ...view, state: commentDeliveryState(view) });
  }

  #save(record: StoredDelivery): void {
    this.#validate(this.#view(record));
    this.options.store.put("commentDeliveries", record.id, record);
  }

  #validate(record: Delivery): void {
    requireCondition(
      Value.Check(InvestigationCommentDeliverySchema, record),
      400,
      "comment_delivery_invalid",
      "The comment delivery record is invalid.",
    );
  }

  #timestamp(value: string): string {
    const timestamp = Date.parse(value);
    requireCondition(
      Number.isFinite(timestamp),
      400,
      "comment_delivery_timestamp_invalid",
      "A delivery timestamp must identify a valid instant.",
    );
    return new Date(timestamp).toISOString();
  }

  #validateOutcome(state: TerminalState, effect: Effect, externalId: string | null): void {
    requireCondition(
      state === "succeeded"
        ? effect === "applied" && externalId !== null
        : state === "unknown"
          ? effect === "unknown"
          : state === "cancelled"
            ? effect === "not_sent"
            : effect === "not_sent" || effect === "rejected",
      400,
      "comment_delivery_receipt_invalid",
      "The delivery outcome and its recorded effect are inconsistent.",
    );
  }

  #assertExternalId(record: StoredDelivery, externalId: string | null): void {
    requireCondition(
      record.externalId === null || record.externalId === externalId,
      409,
      "comment_delivery_external_id_conflict",
      "The delivery receipt belongs to another GitHub comment.",
    );
  }

  #authorize(actor: InvestigationOperatorPrincipal, repositoryId: string): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity cannot read this repository's comment deliveries.",
    );
  }

  #cursor(value: string, scope: string): Cursor {
    try {
      requireCondition(
        /^[A-Za-z0-9_-]+$/u.test(value),
        400,
        "comment_delivery_cursor_invalid",
        "The delivery cursor is invalid.",
      );
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      requireCondition(
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
        400,
        "comment_delivery_cursor_invalid",
        "The delivery cursor is invalid.",
      );
      const cursor = parsed as Record<string, unknown>;
      requireCondition(
        Object.keys(cursor).sort().join(",") === "id,scope,startedAt,version" &&
          cursor.version === 1 &&
          cursor.scope === scope &&
          typeof cursor.id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(cursor.id) &&
          typeof cursor.startedAt === "string" &&
          Number.isFinite(Date.parse(cursor.startedAt)),
        400,
        "comment_delivery_cursor_invalid",
        "The delivery cursor does not match this query or repository scope.",
      );
      return cursor as unknown as Cursor;
    } catch (error) {
      if (error instanceof InvestigationRequestError) throw error;
      throw new InvestigationRequestError(
        400,
        "comment_delivery_cursor_invalid",
        "The delivery cursor is invalid.",
      );
    }
  }

  #equal(left: unknown, right: unknown): boolean {
    return investigationContentDigest(left) === investigationContentDigest(right);
  }

  #atomic<T>(operation: () => T): T {
    return this.options.store.inTransaction
      ? operation()
      : this.options.store.transaction(operation);
  }
}
