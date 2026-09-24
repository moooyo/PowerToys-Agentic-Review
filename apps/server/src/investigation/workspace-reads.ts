import {
  type InvestigationArtifactV1,
  type InvestigationCommentPublicationSummary,
  type InvestigationInputSnapshotV1,
  InvestigationInputSnapshotV1Schema,
  type InvestigationPublicationDirectoryPage,
  type InvestigationPublicationDirectoryQuery,
  type InvestigationReportDirectoryPage,
  type InvestigationReportDirectoryQuery,
  type InvestigationReportHeaderV1,
  type InvestigationResultV1,
  type InvestigationTaskArtifactsPage,
  type InvestigationTaskArtifactsQuery,
  type InvestigationTaskV1,
  type InvestigationWorkItemDiscussion,
  type InvestigationWorkItemDiscussionQuery,
  type InvestigationWorkspaceSearchQuery,
  type InvestigationWorkspaceSearchResult,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationEvidenceStore } from "./evidence-store.js";
import { reportHeader } from "./report.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

function pageLimit(value: number | undefined): number {
  const limit = value ?? 25;
  requireCondition(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 50,
    400,
    "directory_limit_invalid",
    "Directory pages contain at most 50 records.",
  );
  return limit;
}
function pageIdentity(kind: string, actor: InvestigationOperatorPrincipal, query: object): string {
  const {
    cursor: _cursor,
    limit: _limit,
    ...filters
  } = query as { cursor?: string; limit?: number };
  return investigationContentDigest({
    kind,
    repositoryIds: [...actor.repositoryIds].sort(),
    filters,
  });
}
function readCursor(value: string | undefined, identity: string): string | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    /* Binding validation below handles malformed input. */
  }
  requireCondition(
    Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === identity &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0 &&
      writeCursor(identity, parsed[1]) === value,
    400,
    "directory_cursor_invalid",
    "The directory cursor does not match these filters and repository grants.",
  );
  return parsed[1] as string;
}
function writeCursor(identity: string, id: string): string {
  return Buffer.from(JSON.stringify([identity, id]), "utf8").toString("base64url");
}
function repositories(
  actor: InvestigationOperatorPrincipal,
  repositoryId?: string,
): readonly string[] {
  requireCondition(
    repositoryId === undefined || actor.repositoryIds.includes(repositoryId),
    403,
    "repository_forbidden",
    "This identity has no access to the repository.",
  );
  return repositoryId === undefined ? actor.repositoryIds : [repositoryId];
}

/** Read projections never fetch mutable upstream data or dispatch a publication. */
export class InvestigationWorkspaceReads {
  constructor(
    private readonly store: InvestigationStore,
    private readonly evidence: InvestigationEvidenceStore,
  ) {}

  /** Backfill immutable lightweight headers once; request pages never deserialize full exports. */
  initializeReports(): void {
    if (this.store.has("idempotency", "workspace:report-directory:v1")) return;
    this.store.transaction(() => {
      let afterId = "";
      for (;;) {
        const page = this.store.page<InvestigationResultV1>("reports", afterId, 25);
        for (const result of page)
          this.store.put("reportDirectory", result.report.id, reportHeader(result));
        if (page.length < 25) break;
        afterId = page.at(-1)!.report.id;
      }
      this.store.put("idempotency", "workspace:report-directory:v1", { complete: true });
    });
  }

  reports(
    actor: InvestigationOperatorPrincipal,
    query: InvestigationReportDirectoryQuery,
  ): InvestigationReportDirectoryPage {
    const repositoryIds = repositories(actor, query.repositoryId);
    this.assertEntityFilters(actor, query);
    const limit = pageLimit(query.limit);
    const identity = pageIdentity("reports", actor, query);
    const afterId = readCursor(query.cursor, identity);
    const items = this.store.pageWorkspace<InvestigationReportHeaderV1>("reportDirectory", {
      ...query,
      repositoryIds,
      ...(afterId === undefined ? {} : { afterId }),
      limit: limit + 1,
    });
    const more = items.length > limit;
    if (more) items.pop();
    return { items, nextCursor: more ? writeCursor(identity, items.at(-1)!.report.id) : null };
  }

  artifacts(
    actor: InvestigationOperatorPrincipal,
    task: InvestigationTaskV1,
    query: InvestigationTaskArtifactsQuery,
  ): InvestigationTaskArtifactsPage {
    repositories(actor, task.repository.id);
    const limit = pageLimit(query.limit);
    const identity = pageIdentity(`artifacts:${task.id}`, actor, query);
    const afterId = readCursor(query.cursor, identity);
    const records = this.store.pageWorkspace<{ artifact: InvestigationArtifactV1 }>(
      "evidenceMetadata",
      {
        taskId: task.id,
        repositoryIds: [task.repository.id],
        ...(query.attemptId === undefined ? {} : { attemptId: query.attemptId }),
        ...(afterId === undefined ? {} : { afterId }),
        limit: limit + 1,
      },
    );
    const more = records.length > limit;
    if (more) records.pop();
    return {
      taskId: task.id,
      items: records.map((record) => this.evidence.current(record.artifact.id)),
      nextCursor: more ? writeCursor(identity, records.at(-1)!.artifact.id) : null,
    };
  }

  discussion(
    item: InvestigationWorkItemRecord,
    query: InvestigationWorkItemDiscussionQuery,
  ): InvestigationWorkItemDiscussion {
    const revisionKey = query.revisionKey ?? item.subject.revisionKey;
    const pointer = this.store.get<{ snapshotId: string }>(
      "sourceSnapshots",
      `current:${investigationContentDigest({ repositoryId: item.repositoryId, workItemId: item.id, revisionKey })}`,
    );
    const record =
      pointer === undefined
        ? undefined
        : this.store.get<{
            id: string;
            digest: string;
            inputSnapshot: InvestigationInputSnapshotV1;
          }>("sourceSnapshots", pointer.snapshotId);
    if (record === undefined)
      return {
        workItemId: item.id,
        repositoryId: item.repositoryId,
        revisionKey,
        availability: "unavailable",
        snapshotRef: null,
        inputSnapshot: null,
      };
    requireCondition(
      record.id === pointer?.snapshotId &&
        record.id === `snapshot:${record.digest}` &&
        Value.Check(InvestigationInputSnapshotV1Schema, record.inputSnapshot) &&
        record.digest === investigationContentDigest(record.inputSnapshot) &&
        record.inputSnapshot.repositoryId === item.repositoryId &&
        record.inputSnapshot.workItemId === item.id &&
        record.inputSnapshot.subjectRevisionKey === revisionKey &&
        (revisionKey !== item.subject.revisionKey ||
          record.inputSnapshot.subjectRef === item.subject.id),
      409,
      "source_snapshot_binding_invalid",
      "The stored source snapshot does not match this exact work item revision.",
    );
    return {
      workItemId: item.id,
      repositoryId: item.repositoryId,
      revisionKey,
      availability: "available",
      snapshotRef: { id: record.id, digest: record.digest },
      inputSnapshot: record.inputSnapshot,
    };
  }

  publications(
    actor: InvestigationOperatorPrincipal,
    query: InvestigationPublicationDirectoryQuery,
    summary: (id: string) => InvestigationCommentPublicationSummary,
  ): InvestigationPublicationDirectoryPage {
    const repositoryIds = repositories(actor, query.repositoryId);
    this.assertEntityFilters(actor, query);
    const limit = pageLimit(query.limit);
    const identity = pageIdentity("publications", actor, query);
    let afterId = readCursor(query.cursor, identity);
    const items: InvestigationCommentPublicationSummary[] = [];
    const task =
      query.taskId === undefined
        ? undefined
        : this.store.get<InvestigationTaskV1>("tasks", query.taskId);
    const indexedId =
      task === undefined
        ? undefined
        : this.store.get<{ recordId: string }>(
            "idempotency",
            `progress-reply:task-index:${task.id}`,
          )?.recordId;
    const associatedId =
      indexedId === undefined
        ? undefined
        : (this.store.get<{ retiredTo?: string }>("idempotency", indexedId)?.retiredTo ??
          indexedId);
    // Dynamic publication states and grants are projected by the authoritative existing readers.
    // The scan cap makes selective queries bounded; an empty page may carry a continuation.
    for (let scanned = 0; scanned < 500; scanned += 1) {
      const record = this.store.pageWorkspace<{ id: string }>("idempotency", {
        repositoryIds,
        ...(query.workItemKind === undefined ? {} : { workItemKind: query.workItemKind }),
        ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
        ...(query.workItemId === undefined ? {} : { workItemId: query.workItemId }),
        ...(afterId === undefined ? {} : { afterId }),
        limit: 1,
      })[0];
      // Merge the task's shared publication into the same keyset order as its historical records.
      const id =
        associatedId !== undefined &&
        (afterId === undefined || associatedId > afterId) &&
        (record === undefined || associatedId < record.id)
          ? associatedId
          : record?.id;
      if (id === undefined) return { items, nextCursor: null };
      const entry = summary(id);
      if (id === associatedId && task !== undefined)
        requireCondition(
          entry.repositoryId === task.repository.id &&
            (entry.workItemId === null || entry.workItemId === task.workItem.id) &&
            entry.workItemKind === task.workItem.kind &&
            entry.workItemNumber === task.workItem.number,
          409,
          "comment_task_binding_invalid",
          "The shared comment does not match the task's source.",
        );
      const matches =
        (query.workItemKind === undefined || entry.workItemKind === query.workItemKind) &&
        (query.mode === undefined || entry.mode === query.mode) &&
        (query.state === undefined || entry.state === query.state) &&
        (query.taskKind === undefined || entry.producerTaskKind === query.taskKind) &&
        (query.workItemNumber === undefined || entry.workItemNumber === query.workItemNumber) &&
        (query.search === undefined ||
          `${entry.workItemTitle ?? ""} ${entry.workItemNumber} ${entry.repositoryFullName}`
            .toLowerCase()
            .includes(query.search.toLowerCase()));
      if (matches && items.length === limit)
        return { items, nextCursor: writeCursor(identity, afterId!) };
      afterId = id;
      if (matches)
        items.push(task === undefined ? entry : { ...entry, associatedTaskIds: [task.id] });
    }
    return { items, nextCursor: afterId === undefined ? null : writeCursor(identity, afterId) };
  }

  search(
    actor: InvestigationOperatorPrincipal,
    query: InvestigationWorkspaceSearchQuery,
  ): InvestigationWorkspaceSearchResult {
    const repositoryIds = repositories(actor, query.repositoryId);
    const limit = query.limit ?? 20;
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 30 && query.query.trim().length > 0,
      400,
      "search_query_invalid",
      "Workspace search requires text and at most 30 results.",
    );
    const options = { repositoryIds, search: query.query.trim(), limit: limit + 1 };
    const items: InvestigationWorkspaceSearchResult["items"] = [];
    for (const item of this.store.pageWorkspace<InvestigationWorkItemRecord>("workItems", options))
      items.push({
        id: item.id,
        kind: "work_item",
        repositoryId: item.repositoryId,
        title: item.title,
        description: `#${item.number} · ${item.state}`,
        workItemId: item.id,
        workItemKind: item.kind,
        taskId: null,
        updatedAt: item.updatedAt,
      });
    for (const task of this.store.pageWorkspace<InvestigationTaskV1>("tasks", options))
      items.push({
        id: task.id,
        kind: "task",
        repositoryId: task.repository.id,
        title: task.workItem.title,
        description: `${task.kind} · ${task.state}`,
        workItemId: task.workItem.id,
        workItemKind: task.workItem.kind,
        taskId: task.id,
        updatedAt: task.updatedAt,
      });
    for (const header of this.store.pageWorkspace<InvestigationReportHeaderV1>(
      "reportDirectory",
      options,
    ))
      items.push({
        id: header.report.id,
        kind: "report",
        repositoryId: header.context.repository.id,
        title: header.context.workItem.title,
        description: `${header.report.delivery} · ${header.report.completeness}`,
        workItemId: header.context.workItem.id,
        workItemKind: header.context.workItem.kind,
        taskId: header.context.task.id,
        updatedAt: null,
      });
    for (const repository of this.store.pageWorkspace<InvestigationRepositoryRecord>(
      "repositories",
      options,
    ))
      items.push({
        id: repository.id,
        kind: "repository",
        repositoryId: repository.id,
        title: repository.fullName,
        description: "Repository",
        workItemId: null,
        workItemKind: null,
        taskId: null,
        updatedAt: null,
      });
    return { items: items.slice(0, limit), truncated: items.length > limit };
  }

  private assertEntityFilters(
    actor: InvestigationOperatorPrincipal,
    query: { taskId?: string; workItemId?: string; repositoryId?: string },
  ): void {
    if (query.taskId !== undefined) {
      const task = this.store.get<InvestigationTaskV1>("tasks", query.taskId);
      requireCondition(task !== undefined, 404, "task_not_found", "The task does not exist.");
      repositories(actor, task.repository.id);
      requireCondition(
        (query.repositoryId === undefined || task.repository.id === query.repositoryId) &&
          (query.workItemId === undefined || task.workItem.id === query.workItemId),
        400,
        "directory_scope_mismatch",
        "The task filter does not match the selected source.",
      );
    }
    if (query.workItemId !== undefined) {
      const item = this.store.get<InvestigationWorkItemRecord>("workItems", query.workItemId);
      requireCondition(
        item !== undefined,
        404,
        "work_item_not_found",
        "The work item does not exist.",
      );
      repositories(actor, item.repositoryId);
      requireCondition(
        query.repositoryId === undefined || item.repositoryId === query.repositoryId,
        400,
        "directory_scope_mismatch",
        "The work item does not belong to the selected repository.",
      );
    }
  }
}
