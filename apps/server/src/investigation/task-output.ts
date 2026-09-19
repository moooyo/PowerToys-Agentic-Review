import {
  type InvestigationOutputBatchRequest,
  InvestigationOutputBatchRequestSchema,
  type InvestigationOutputBatchResponse,
  type InvestigationOutputEvent,
  type InvestigationOutputPage,
  type InvestigationOutputQuery,
  maximumInvestigationOutputBatchBytes,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";

interface OutputStream {
  taskId: string;
  attemptId: string;
  lastSequence: number;
  earliestSequence: number;
  retainedCount: number;
  retainedBytes: number;
}
interface OutputBatch {
  digest: string;
  response: InvestigationOutputBatchResponse;
}
interface OutputCapacity {
  bytes: number;
  events: number;
  batches: number;
}
export interface InvestigationOutputPolicy {
  maximumAttemptEvents: number;
  maximumAttemptBytes: number;
  maximumBytes: number;
  maximumBatches: number;
}
const defaultPolicy: InvestigationOutputPolicy = {
  maximumAttemptEvents: 10_000,
  maximumAttemptBytes: 8 * 1_024 * 1_024,
  maximumBytes: 128 * 1_024 * 1_024,
  maximumBatches: 100_000,
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: This security filter must match explicit control bytes.
const forbiddenOutputControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const eventKey = (attemptId: string, sequence: number) =>
  `${encodeURIComponent(attemptId)}:${String(sequence).padStart(16, "0")}`;
const batchKey = (attemptId: string, batchId: string) =>
  `${encodeURIComponent(attemptId)}:${encodeURIComponent(batchId)}`;
const streamKey = (attemptId: string) => `attempt:${attemptId}`;
function cursor(taskId: string, attemptId: string, sequence: number): string {
  return Buffer.from(JSON.stringify([taskId, attemptId, sequence]), "utf8").toString("base64url");
}
function parseCursor(value: string | undefined, taskId: string, attemptId: string): number {
  if (value === undefined) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    /* The common binding check rejects malformed input. */
  }
  requireCondition(
    Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === taskId &&
      parsed[1] === attemptId &&
      Number.isSafeInteger(parsed[2]) &&
      parsed[2] >= 0 &&
      cursor(taskId, attemptId, parsed[2]) === value,
    400,
    "output_cursor_invalid",
    "The output cursor must belong to the exact task and attempt.",
  );
  return parsed[2] as number;
}

/** Durable output is observational. It cannot change task, accounting, or cleanup state. */
export class InvestigationTaskOutput {
  readonly policy: InvestigationOutputPolicy;
  constructor(
    private readonly store: InvestigationStore,
    private readonly now: () => Date,
    policy: Partial<InvestigationOutputPolicy> = {},
  ) {
    this.policy = { ...defaultPolicy, ...policy };
    for (const value of Object.values(this.policy))
      requireCondition(
        Number.isSafeInteger(value) && value > 0,
        500,
        "output_policy_invalid",
        "Output limits must be positive safe integers.",
      );
  }

  established(attemptId: string): boolean {
    return this.store.has("outputStreams", streamKey(attemptId));
  }
  duplicate(
    taskId: string,
    request: InvestigationOutputBatchRequest,
  ): InvestigationOutputBatchResponse | undefined {
    const existing = this.store.get<OutputBatch>(
      "outputBatches",
      batchKey(request.lease.attemptId, request.batchId),
    );
    if (existing === undefined) return undefined;
    requireCondition(
      existing.digest ===
        investigationContentDigest({ taskId, batchId: request.batchId, events: request.events }),
      409,
      "output_batch_conflict",
      "An output batch identity cannot be reused with different content.",
    );
    return { ...existing.response, duplicate: true };
  }

  /** The caller checks the original lease and every invocation inside this same transaction. */
  append(
    taskId: string,
    request: InvestigationOutputBatchRequest,
  ): InvestigationOutputBatchResponse {
    requireCondition(
      this.store.inTransaction,
      500,
      "output_transaction_required",
      "Output admission must share the lease-check transaction.",
    );
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
    requireCondition(
      Value.Check(InvestigationOutputBatchRequestSchema, request) &&
        Buffer.byteLength(JSON.stringify(request), "utf8") <= maximumInvestigationOutputBatchBytes,
      400,
      "output_batch_invalid",
      "The normalized output batch exceeds its contract or byte limit.",
    );
    const duplicate = this.duplicate(taskId, request);
    if (duplicate !== undefined) return duplicate;
    const attemptId = request.lease.attemptId;
    const stream = this.store.get<OutputStream>("outputStreams", streamKey(attemptId)) ?? {
      taskId,
      attemptId,
      lastSequence: 0,
      earliestSequence: 1,
      retainedCount: 0,
      retainedBytes: 0,
    };
    requireCondition(
      stream.taskId === taskId,
      409,
      "output_attempt_mismatch",
      "The output stream belongs to another task.",
    );
    const capacity = this.store.get<OutputCapacity>("outputStreams", "capacity") ?? {
      bytes: 0,
      events: 0,
      batches: 0,
    };
    requireCondition(
      capacity.batches < this.policy.maximumBatches,
      409,
      "output_quota_exceeded",
      "The durable output receipt quota is exhausted.",
    );
    let expected = stream.lastSequence + 1;
    for (const event of request.events) {
      requireCondition(
        event.attemptId === attemptId && event.producerSequence === expected++,
        409,
        "output_sequence_conflict",
        "Output events must continue the exact attempt's contiguous producer sequence.",
      );
      requireCondition(
        (event.kind !== "assistant" && event.kind !== "tool") || event.invocationId !== null,
        400,
        "output_invocation_required",
        "Model-visible events require their registered invocation identity.",
      );
      requireCondition(
        [event.text, event.command ?? "", event.result ?? ""].every(
          (text) => !forbiddenOutputControlCharacters.test(text),
        ),
        400,
        "output_control_characters",
        "Visible output must omit terminal control sequences.",
      );
      const saved: InvestigationOutputEvent = {
        ...event,
        taskId,
        receivedAt: this.now().toISOString(),
        cursor: cursor(taskId, attemptId, event.producerSequence),
      };
      const bytes = Buffer.byteLength(JSON.stringify(saved), "utf8");
      requireCondition(
        bytes <= this.policy.maximumBytes,
        409,
        "output_quota_exceeded",
        "One output event exceeds the aggregate retained output capacity.",
      );
      this.store.insert("outputEvents", eventKey(attemptId, event.producerSequence), saved);
      stream.lastSequence = event.producerSequence;
      stream.retainedCount += 1;
      stream.retainedBytes += bytes;
      capacity.bytes += bytes;
      capacity.events += 1;
    }
    while (
      stream.retainedCount > this.policy.maximumAttemptEvents ||
      stream.retainedBytes > this.policy.maximumAttemptBytes
    ) {
      const oldest = this.store.pageOutput<InvestigationOutputEvent>(
        attemptId,
        stream.earliestSequence - 1,
        1,
      )[0];
      requireCondition(
        oldest !== undefined,
        500,
        "output_retention_invalid",
        "The retained output range is inconsistent.",
      );
      const bytes = Buffer.byteLength(JSON.stringify(oldest), "utf8");
      this.store.delete("outputEvents", eventKey(attemptId, oldest.producerSequence));
      stream.earliestSequence = oldest.producerSequence + 1;
      stream.retainedCount -= 1;
      stream.retainedBytes -= bytes;
      capacity.bytes -= bytes;
      capacity.events -= 1;
    }
    this.store.put("outputStreams", streamKey(attemptId), stream);
    while (capacity.bytes > this.policy.maximumBytes) {
      const oldest = this.store.oldestOutput<InvestigationOutputEvent>();
      requireCondition(
        oldest !== undefined,
        500,
        "output_retention_invalid",
        "The aggregate retained output range is inconsistent.",
      );
      const retained =
        oldest.attemptId === attemptId
          ? stream
          : this.store.get<OutputStream>("outputStreams", streamKey(oldest.attemptId));
      requireCondition(
        retained !== undefined,
        500,
        "output_retention_invalid",
        "The retained output stream is unavailable.",
      );
      const bytes = Buffer.byteLength(JSON.stringify(oldest), "utf8");
      this.store.delete("outputEvents", eventKey(oldest.attemptId, oldest.producerSequence));
      retained.earliestSequence = oldest.producerSequence + 1;
      retained.retainedCount -= 1;
      retained.retainedBytes -= bytes;
      capacity.bytes -= bytes;
      capacity.events -= 1;
      this.store.put("outputStreams", streamKey(oldest.attemptId), retained);
    }
    const response: InvestigationOutputBatchResponse = {
      taskId,
      attemptId,
      batchId: request.batchId,
      lastAcceptedProducerSequence: stream.lastSequence,
      cursor: cursor(taskId, attemptId, stream.lastSequence),
      duplicate: false,
    };
    capacity.batches += 1;
    this.store.put("outputStreams", streamKey(attemptId), stream);
    this.store.put("outputStreams", "capacity", capacity);
    this.store.insert("outputBatches", batchKey(attemptId, request.batchId), {
      digest: investigationContentDigest({
        taskId,
        batchId: request.batchId,
        events: request.events,
      }),
      response,
    } satisfies OutputBatch);
    return response;
  }

  read(taskId: string, query: InvestigationOutputQuery): InvestigationOutputPage {
    const limit = query.limit ?? 100;
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 200,
      400,
      "output_page_invalid",
      "Output pages contain at most 200 events.",
    );
    const after = parseCursor(query.after, taskId, query.attemptId);
    const stream = this.store.get<OutputStream>("outputStreams", streamKey(query.attemptId));
    requireCondition(
      after <= (stream?.lastSequence ?? 0),
      400,
      "output_cursor_future",
      "The output cursor is beyond the accepted stream.",
    );
    const expired =
      stream !== undefined && query.after !== undefined && after < stream.earliestSequence - 1;
    const items = this.store.pageOutput<InvestigationOutputEvent>(
      query.attemptId,
      expired ? stream.earliestSequence - 1 : after,
      limit + 1,
    );
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    return {
      taskId,
      attemptId: query.attemptId,
      items,
      nextCursor: hasMore ? items.at(-1)!.cursor : null,
      highWaterCursor:
        stream === undefined ? null : cursor(taskId, query.attemptId, stream.lastSequence),
      earliestAvailableCursor:
        stream === undefined || stream.retainedCount === 0
          ? null
          : cursor(taskId, query.attemptId, stream.earliestSequence),
      lastAcceptedProducerSequence: stream?.lastSequence ?? 0,
      retainedEventCount: stream?.retainedCount ?? 0,
      truncated: (stream?.earliestSequence ?? 1) > 1,
      cursorExpired: expired,
    };
  }
}
