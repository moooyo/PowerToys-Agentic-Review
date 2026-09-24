import {
  type InvestigationArtifactMetadataV1,
  type InvestigationCommentPublicationSummary,
  type InvestigationOutputEvent,
  InvestigationOutputQuerySchema,
  type InvestigationPublicationDirectoryQuery,
  InvestigationPublicationDirectoryQuerySchema,
  InvestigationReportDirectoryQuerySchema,
  type InvestigationReportHeaderV1,
  InvestigationTaskArtifactsQuerySchema,
  type InvestigationWorkItemDiscussion,
  InvestigationWorkItemDiscussionQuerySchema,
  InvestigationWorkspaceSearchQuerySchema,
  type InvestigationWorkspaceSearchResult,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Repository, TaskDetail, WorkItem } from "./api";
import type { InvestigationReadApi } from "./read-api";
import { InvestigationHttpError } from "./transport";

interface SampleReadState {
  repositories(): Repository[];
  workItems(): WorkItem[];
  tasks(): TaskDetail[];
  reports(): InvestigationReportHeaderV1[];
  artifacts(): InvestigationArtifactMetadataV1[];
  publications(): InvestigationCommentPublicationSummary[];
}

function queryInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new InvestigationHttpError(400, "The development sample query is invalid.");
  }
  return structuredClone(value) as Static<T>;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new InvestigationHttpError(404, `The development sample ${label} was not found.`);
  }
  return value;
}

function retainedPage<T>(
  values: T[],
  name: string,
  query: { cursor?: string; limit?: number },
  filters: unknown,
) {
  const prefix = `sample-${name}:${encodeURIComponent(JSON.stringify(filters))}:`;
  if (
    query.cursor !== undefined &&
    (!query.cursor.startsWith(prefix) || !/^\d+$/u.test(query.cursor.slice(prefix.length)))
  ) {
    throw new InvestigationHttpError(400, "The sample cursor does not belong to this query.");
  }
  const offset = query.cursor === undefined ? 0 : Number(query.cursor.slice(prefix.length));
  if (!Number.isSafeInteger(offset) || offset > values.length) {
    throw new InvestigationHttpError(400, "The sample cursor is outside the retained result.");
  }
  const end = Math.min(offset + (query.limit ?? 25), values.length);
  return {
    items: values.slice(offset, end),
    nextCursor: end < values.length ? `${prefix}${end}` : null,
  };
}

function outputEvents(detail: TaskDetail, attemptId: string): InvestigationOutputEvent[] {
  const attempt = required(
    detail.attempts.find((entry) => entry.id === attemptId),
    "attempt",
  );
  const observedAt = attempt.finishedAt ?? attempt.startedAt ?? detail.task.createdAt;
  const invocationId =
    detail.invocations?.find((entry) => entry.attemptId === attemptId)?.invocationId ?? null;
  const base = {
    schemaVersion: "InvestigationOutputEventV1" as const,
    taskId: detail.task.id,
    attemptId,
    invocationId,
    operation: "replace" as const,
    observedAt,
    receivedAt: observedAt,
    status: "info" as const,
  };
  return [
    {
      ...base,
      invocationId: null,
      producerSequence: 1,
      itemId: `${attemptId}-sample-boundary`,
      cursor: `sample-output:${encodeURIComponent(detail.task.id)}:${encodeURIComponent(attemptId)}:1`,
      kind: "system",
      text: "Development sample: this retained output is synthetic. No Worker or model process was started.",
    },
    {
      ...base,
      producerSequence: 2,
      itemId: `${attemptId}-sample-message`,
      cursor: `sample-output:${encodeURIComponent(detail.task.id)}:${encodeURIComponent(attemptId)}:2`,
      kind: "assistant",
      text: `Synthetic assistant message for ${detail.task.workItem.title}. Open the saved sample report to inspect its findings and evidence. This text does not establish execution or token usage.`,
    },
  ];
}

/** Explicit development fixtures only. This module never calls HTTP or advances a fake process. */
export function createSampleReadApi(state: SampleReadState): InvestigationReadApi {
  const snapshots = new Map<string, InvestigationWorkItemDiscussion>(
    state.workItems().map((item) => [
      item.id,
      {
        workItemId: item.id,
        repositoryId: item.repositoryId,
        revisionKey: item.subject.revisionKey,
        availability: "available",
        snapshotRef: { id: `${item.id}-sample-snapshot`, digest: "a".repeat(64) },
        inputSnapshot: {
          schemaVersion: "InvestigationInputSnapshotV1",
          repositoryId: item.repositoryId,
          workItemId: item.id,
          subjectRef: item.subject.id,
          subjectRevisionKey: item.subject.revisionKey,
          title: item.title,
          body: item.body,
          comments: [
            {
              id: `${item.id}-sample-source-comment`,
              body: "This is a frozen synthetic discussion comment. No upstream discussion was imported.",
            },
          ],
          source: null,
        },
      },
    ]),
  );
  const publications = async (
    input: InvestigationPublicationDirectoryQuery = {},
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const query = queryInput(InvestigationPublicationDirectoryQuerySchema, input);
    const { cursor: _cursor, limit: _limit, ...filters } = query;
    const search = query.search?.toLocaleLowerCase();
    const tasks = state.tasks();
    const workItems = state.workItems();
    const items = state
      .publications()
      .map((item) => ({
        ...item,
        producerTaskKind: tasks.find((detail) => detail.task.id === item.taskId)?.task.kind ?? null,
        workItemTitle: workItems.find((entry) => entry.id === item.workItemId)?.title ?? null,
      }))
      .filter(
        (item) =>
          (query.repositoryId === undefined || item.repositoryId === query.repositoryId) &&
          (query.workItemId === undefined || item.workItemId === query.workItemId) &&
          (query.workItemKind === undefined || item.workItemKind === query.workItemKind) &&
          (query.workItemNumber === undefined || item.workItemNumber === query.workItemNumber) &&
          (query.taskId === undefined || item.taskId === query.taskId) &&
          (query.mode === undefined || item.mode === query.mode) &&
          (query.state === undefined || item.state === query.state) &&
          (query.taskKind === undefined || item.producerTaskKind === query.taskKind) &&
          (search === undefined ||
            `${item.id} ${item.workItemTitle ?? ""} ${item.workItemNumber} ${item.repositoryFullName}`
              .toLocaleLowerCase()
              .includes(search)),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
    return structuredClone(retainedPage(items, "publications", query, filters));
  };
  const workItemSnapshot: InvestigationReadApi["workItemSnapshot"] = async (
    id,
    input = {},
    signal,
  ) => {
    signal?.throwIfAborted();
    const query = queryInput(InvestigationWorkItemDiscussionQuerySchema, input);
    const item = required(
      state.workItems().find((entry) => entry.id === id),
      "work item",
    );
    const revisionKey = query.revisionKey ?? item.subject.revisionKey;
    const snapshot = snapshots.get(id);
    return structuredClone(
      snapshot?.revisionKey === revisionKey
        ? snapshot
        : {
            workItemId: id,
            repositoryId: item.repositoryId,
            revisionKey,
            availability: "unavailable" as const,
            snapshotRef: null,
            inputSnapshot: null,
          },
    );
  };

  return {
    async taskDefaults(signal) {
      signal?.throwIfAborted();
      return { budget: structuredClone(required(state.tasks()[0], "task defaults").task.budget) };
    },
    async taskOutput(id, input, signal) {
      signal?.throwIfAborted();
      const query = queryInput(InvestigationOutputQuerySchema, input);
      const detail = required(
        state.tasks().find((entry) => entry.task.id === id),
        "task",
      );
      const events = outputEvents(detail, query.attemptId);
      const prefix = `sample-output:${encodeURIComponent(id)}:${encodeURIComponent(query.attemptId)}:`;
      if (
        query.after !== undefined &&
        (!query.after.startsWith(prefix) || !/^\d+$/u.test(query.after.slice(prefix.length)))
      ) {
        throw new InvestigationHttpError(
          400,
          "The sample output cursor belongs to another attempt.",
        );
      }
      const after = query.after === undefined ? 0 : Number(query.after.slice(prefix.length));
      if (!Number.isSafeInteger(after) || after > events.length) {
        throw new InvestigationHttpError(
          400,
          "The sample output cursor is outside the retained result.",
        );
      }
      const items = events.slice(after, after + (query.limit ?? 100));
      return structuredClone({
        taskId: id,
        attemptId: query.attemptId,
        items,
        nextCursor: after + items.length < events.length ? (items.at(-1)?.cursor ?? null) : null,
        highWaterCursor: events.at(-1)?.cursor ?? null,
        earliestAvailableCursor: events[0]?.cursor ?? null,
        lastAcceptedProducerSequence: events.length,
        retainedEventCount: events.length,
        truncated: false,
        cursorExpired: false,
      });
    },
    async taskArtifacts(id, input = {}, signal) {
      signal?.throwIfAborted();
      const query = queryInput(InvestigationTaskArtifactsQuerySchema, input);
      const detail = required(
        state.tasks().find((entry) => entry.task.id === id),
        "task",
      );
      if (query.attemptId !== undefined) {
        required(
          detail.attempts.find((entry) => entry.id === query.attemptId),
          "attempt",
        );
      }
      const items = state
        .artifacts()
        .filter(
          (item) =>
            item.artifact.taskId === id &&
            (query.attemptId === undefined || item.artifact.attemptId === query.attemptId),
        )
        .sort(
          (left, right) =>
            right.storedAt.localeCompare(left.storedAt) ||
            right.artifact.id.localeCompare(left.artifact.id),
        );
      return structuredClone({
        taskId: id,
        ...retainedPage(items, "artifacts", query, [id, query.attemptId]),
      });
    },
    async reports(input = {}, signal) {
      signal?.throwIfAborted();
      const query = queryInput(InvestigationReportDirectoryQuerySchema, input);
      const { cursor: _cursor, limit: _limit, ...filters } = query;
      const search = query.search?.toLocaleLowerCase();
      const items = state
        .reports()
        .filter(
          (item) =>
            (query.repositoryId === undefined ||
              item.context.repository.id === query.repositoryId) &&
            (query.workItemId === undefined || item.context.workItem.id === query.workItemId) &&
            (query.taskId === undefined || item.context.task.id === query.taskId) &&
            (query.kind === undefined || item.context.task.kind === query.kind) &&
            (query.delivery === undefined || item.report.delivery === query.delivery) &&
            (query.completeness === undefined || item.report.completeness === query.completeness) &&
            (search === undefined ||
              `${item.id} ${item.context.workItem.title} ${item.context.workItem.number} ${item.report.summary}`
                .toLocaleLowerCase()
                .includes(search)),
        )
        .sort((left, right) => right.id.localeCompare(left.id));
      return structuredClone(retainedPage(items, "reports", query, filters));
    },
    publications,
    publicationDirectory: publications,
    workItemSnapshot,
    workItemDiscussion: workItemSnapshot,
    async workspaceSearch(input, signal) {
      signal?.throwIfAborted();
      const query = queryInput(InvestigationWorkspaceSearchQuerySchema, input);
      const candidates: InvestigationWorkspaceSearchResult["items"] = [
        ...state.repositories().map((item) => ({
          id: item.id,
          kind: "repository" as const,
          repositoryId: item.id,
          title: item.fullName,
          description: "Development sample repository",
          workItemId: null,
          workItemKind: null,
          taskId: null,
          updatedAt: null,
        })),
        ...state.workItems().map((item) => ({
          id: item.id,
          kind: "work_item" as const,
          repositoryId: item.repositoryId,
          title: item.title,
          description: `${item.kind} #${item.number}`,
          workItemId: item.id,
          workItemKind: item.kind,
          taskId: null,
          updatedAt: item.updatedAt,
        })),
        ...state.tasks().map(({ task }) => ({
          id: task.id,
          kind: "task" as const,
          repositoryId: task.repository.id,
          title: task.workItem.title,
          description: `${task.kind}: ${task.state}`,
          workItemId: task.workItem.id,
          workItemKind: task.workItem.kind,
          taskId: task.id,
          updatedAt: task.updatedAt,
        })),
        ...state.reports().map((item) => ({
          id: item.id,
          kind: "report" as const,
          repositoryId: item.context.repository.id,
          title: item.context.workItem.title,
          description: item.report.summary.slice(0, 300),
          workItemId: item.context.workItem.id,
          workItemKind: item.context.workItem.kind,
          taskId: item.context.task.id,
          updatedAt: null,
        })),
      ];
      const search = query.query.trim().toLocaleLowerCase();
      if (search.length === 0) {
        throw new InvestigationHttpError(400, "Workspace search requires non-empty text.");
      }
      const items = candidates.filter(
        (item) =>
          (query.repositoryId === undefined || item.repositoryId === query.repositoryId) &&
          `${item.id} ${item.title} ${item.description}`.toLocaleLowerCase().includes(search),
      );
      const limit = query.limit ?? 20;
      return structuredClone({ items: items.slice(0, limit), truncated: items.length > limit });
    },
    async reportMediaPublication(id, signal) {
      signal?.throwIfAborted();
      const report = required(
        state.reports().find((entry) => entry.id === id),
        "report",
      );
      if (report.context.task.kind !== "pr-e2e") {
        throw new InvestigationHttpError(400, "Media publication status belongs to an E2E report.");
      }
      return {
        reportId: id,
        state: "blocked",
        retryable: false,
        uploadedCount: 0,
        totalCount: 0,
        blockers: ["Development sample: no media publisher or external upload was started."],
        uploads: [],
      };
    },
  };
}
