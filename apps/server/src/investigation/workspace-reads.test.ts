import {
  createInvestigationPreview,
  type InvestigationCommentPublicationSummary,
  type InvestigationInputSnapshotV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationEvidenceStore } from "./evidence-store.js";
import { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkItemRecord } from "./types.js";
import { InvestigationWorkspaceReads } from "./workspace-reads.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function harness() {
  const store = new InvestigationStore();
  stores.push(store);
  const fixture = createInvestigationPreview("pr", { findingCount: 0 });
  const actor: InvestigationOperatorPrincipal = {
    id: "operator",
    displayName: "Synthetic operator",
    repositoryIds: [fixture.task.repository.id],
    permissions: [],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  const item: InvestigationWorkItemRecord = {
    ...fixture.task.workItem,
    repositoryId: fixture.task.repository.id,
    body: "Frozen opening post.",
    state: "open",
    subject: fixture.task.subjects[0]!,
    updatedAt: fixture.task.updatedAt,
  };
  store.insert("repositories", fixture.task.repository.id, fixture.task.repository);
  store.insert("workItems", item.id, item);
  store.insert("tasks", fixture.task.id, fixture.task);
  const evidence = new InvestigationEvidenceStore(store);
  const reads = new InvestigationWorkspaceReads(store, evidence);
  return { store, fixture, actor, item, evidence, reads };
}

describe("authorized workspace read projections", () => {
  it("lists every immutable report with bounded cursors without exporting whole reports per request", () => {
    const h = harness();
    for (const id of ["report-a", "report-b", "report-c"]) {
      const result = structuredClone(h.fixture.result);
      result.id = id;
      result.report.id = id;
      h.store.insert("reports", id, result);
    }
    const foreign = structuredClone(h.fixture.result);
    foreign.id = "report-foreign";
    foreign.report.id = foreign.id;
    foreign.context.repository.id = "foreign";
    h.store.insert("reports", foreign.id, foreign);
    h.reads.initializeReports();
    const getter = vi.spyOn(h.store, "get");
    const first = h.reads.reports(h.actor, { limit: 2 });
    expect(first.items.map((report) => report.id)).toEqual(["report-a", "report-b"]);
    expect(
      h.reads
        .reports(h.actor, { limit: 2, cursor: first.nextCursor! })
        .items.map((report) => report.id),
    ).toEqual(["report-c"]);
    expect(getter.mock.calls.some(([collection]) => collection === "reports")).toBe(false);
    expect(() =>
      h.reads.reports(
        { ...h.actor, isAdmin: true, repositoryIds: [] },
        { repositoryId: h.item.repositoryId },
      ),
    ).toThrow(expect.objectContaining({ code: "repository_forbidden" }));
    expect(() =>
      h.reads.reports(h.actor, { cursor: first.nextCursor!, search: "changed filter" }),
    ).toThrow(expect.objectContaining({ code: "directory_cursor_invalid" }));
  });

  it("returns an exact retained discussion or honest absence and rejects cross-item snapshots", () => {
    const h = harness();
    expect(h.reads.discussion(h.item, {})).toMatchObject({
      availability: "unavailable",
      inputSnapshot: null,
      snapshotRef: null,
    });
    const snapshot: InvestigationInputSnapshotV1 = {
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: h.item.repositoryId,
      workItemId: h.item.id,
      subjectRef: h.item.subject.id,
      subjectRevisionKey: h.item.subject.revisionKey,
      title: h.item.title,
      body: h.item.body,
      comments: [{ id: "comment-one", body: "Original discussion text." }],
      source: null,
    };
    const digest = investigationContentDigest(snapshot);
    const snapshotId = `snapshot:${digest}`;
    const pointer = `current:${investigationContentDigest({ repositoryId: h.item.repositoryId, workItemId: h.item.id, revisionKey: h.item.subject.revisionKey })}`;
    h.store.insert("sourceSnapshots", snapshotId, {
      id: snapshotId,
      digest,
      inputSnapshot: snapshot,
    });
    h.store.insert("sourceSnapshots", pointer, { snapshotId });
    expect(h.reads.discussion(h.item, {}).inputSnapshot).toEqual(snapshot);
    const changedLive = { ...h.item, title: "Current source title", body: "Current source body" };
    expect(h.reads.discussion(changedLive, {}).inputSnapshot?.body).toBe("Frozen opening post.");
    const wrong = { ...snapshot, workItemId: "another-item" };
    h.store.put("sourceSnapshots", snapshotId, {
      id: snapshotId,
      digest: investigationContentDigest(wrong),
      inputSnapshot: wrong,
    });
    expect(() => h.reads.discussion(h.item, {})).toThrow(
      expect.objectContaining({ code: "source_snapshot_binding_invalid" }),
    );
  });

  it("discovers uploaded artifact metadata before any checkpoint references it without reading bytes", () => {
    const h = harness();
    const artifact = {
      id: "artifact-one",
      taskId: h.fixture.task.id,
      attemptId: h.fixture.attempt.id,
      subjectRef: h.fixture.task.subjectRef,
      kind: "log" as const,
      name: "Observed output.txt",
      mediaType: "text/plain",
      digest: "a".repeat(64),
      byteLength: 1,
      availability: "available" as const,
    };
    h.evidence.upload(artifact, "eA==", () => {});
    const get = vi.spyOn(h.store, "get");
    expect(h.reads.artifacts(h.actor, h.fixture.task, {}).items[0]?.artifact).toEqual(artifact);
    expect(get.mock.calls.some(([collection]) => collection === "evidenceAssets")).toBe(false);
    expect(
      h.reads.artifacts(h.actor, h.fixture.task, { attemptId: "another-attempt" }).items,
    ).toEqual([]);
    h.store.delete("evidenceAssets", artifact.id);
    expect(h.reads.artifacts(h.actor, h.fixture.task, {}).items[0]?.artifact.availability).toBe(
      "missing",
    );
  });

  it("keeps progress, result, and E2E publications distinct in stable scoped pages", () => {
    const h = harness();
    const summaries = new Map<string, InvestigationCommentPublicationSummary>();
    for (const [id, mode, kind] of [
      ["auto-reply:report:one", "result", "pr-review"],
      ["progress-reply:task:one", "progress", "pr-review"],
      ["progress-reply:task:two", "progress", "pr-e2e"],
    ] as const) {
      const entry: InvestigationCommentPublicationSummary = {
        id,
        version: "version-one",
        mode,
        repositoryId: h.item.repositoryId,
        repositoryFullName: h.fixture.task.repository.fullName,
        workItemId: h.item.id,
        workItemKind: h.item.kind,
        workItemNumber: h.item.number,
        workItemTitle: h.item.title,
        taskId: h.fixture.task.id,
        producerTaskKind: kind,
        reportId: null,
        state: "pending",
        reasonCode: null,
        reason: null,
        requiresAttention: false,
        nextAttemptAt: null,
        lastAttemptAt: null,
        lastConfirmedAt: null,
        externalId: null,
        commentUrl: null,
        availableActions: [],
        createdAt: h.item.updatedAt,
        updatedAt: h.item.updatedAt,
      };
      summaries.set(id, entry);
      h.store.insert("idempotency", id, {
        id,
        repository: h.fixture.task.repository,
        taskId: h.fixture.task.id,
        workItemId: h.item.id,
      });
    }
    const summary = vi.fn((id: string) => summaries.get(id)!);
    const first = h.reads.publications(h.actor, { limit: 1 }, summary);
    const second = h.reads.publications(h.actor, { limit: 1, cursor: first.nextCursor! }, summary);
    expect(first.items[0]?.mode).toBe("result");
    expect(second.items[0]?.mode).toBe("progress");
    expect(
      h.reads.publications(h.actor, { taskKind: "pr-e2e" }, summary).items.map((entry) => entry.id),
    ).toEqual(["progress-reply:task:two"]);
    expect(h.reads.publications(h.actor, { state: "synced" }, summary).items).toEqual([]);
  });

  it("searches real granted entities with exact destination kinds and a bounded result count", () => {
    const h = harness();
    h.store.insert("workItems", "foreign", { ...h.item, id: "foreign", repositoryId: "foreign" });
    const result = h.reads.search(h.actor, { query: "Settings", limit: 1 });
    expect(result).toMatchObject({
      truncated: true,
      items: [
        { kind: "work_item", workItemKind: "pull_request", repositoryId: h.item.repositoryId },
      ],
    });
    expect(h.reads.search({ ...h.actor, repositoryIds: [] }, { query: "Settings" }).items).toEqual(
      [],
    );
  });
});
