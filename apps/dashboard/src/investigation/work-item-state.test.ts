import type { InvestigationWorkItemDiscussion } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { createSampleInvestigationApi } from "./sample-adapter";
import {
  assertSourceSnapshot,
  currentWorkItemTask,
  filterWorkItems,
  relatedWorkItemTasks,
  taskReportMatches,
  taskUsesCurrentSource,
  workItemUrl,
} from "./work-item-state";

async function fixture() {
  const api = createSampleInvestigationApi();
  const detail = await api.task("sample-pr-p1-task");
  return { ...detail, source: await api.workItem(detail.task.workItem.id), api };
}

describe("source and investigation binding", () => {
  it("keeps an active static investigation visible beside an older completed report", async () => {
    const { task, source } = await fixture();
    const current = {
      ...task,
      id: "current",
      state: "running" as const,
      latestReportRef: null,
      createdAt: "2026-09-20T12:00:00Z",
    };
    const old = {
      ...task,
      id: "old",
      state: "completed" as const,
      createdAt: "2026-09-19T12:00:00Z",
    };
    expect(currentWorkItemTask(source, [old, current])?.id).toBe("current");
  });

  it("does not substitute E2E work or a report from a previous source revision", async () => {
    const { task, source } = await fixture();
    const e2e = { ...task, id: "e2e", kind: "pr-e2e" as const, state: "running" as const };
    const old = {
      ...task,
      subjects: task.subjects.map((subject) => ({ ...subject, revisionKey: "f".repeat(64) })),
    };
    expect(currentWorkItemTask(source, [e2e, old])).toBeUndefined();
    expect(taskUsesCurrentSource(source, old)).toBe(false);
    expect(relatedWorkItemTasks(source, [e2e, old])).toHaveLength(2);
  });

  it("excludes matching numbers from a different repository or work item", async () => {
    const { task, source } = await fixture();
    expect(
      relatedWorkItemTasks(source, [
        { ...task, repository: { ...task.repository, id: "other-repository" } },
        { ...task, workItem: { ...task.workItem, id: "other-item" } },
      ]),
    ).toEqual([]);
  });

  it("checks the saved report reference, producing task, repository, and source subject", async () => {
    const { task, source, latestReport } = await fixture();
    if (!latestReport) throw new Error("A report fixture is required.");
    expect(taskReportMatches(source, task, latestReport)).toBe(true);
    expect(
      taskReportMatches(source, task, {
        ...latestReport,
        report: { ...latestReport.report, logicalContentDigest: "f".repeat(64) },
      }),
    ).toBe(false);
    expect(
      taskReportMatches(source, task, {
        ...latestReport,
        context: {
          ...latestReport.context,
          task: { ...latestReport.context.task, id: "another-task" },
        },
      }),
    ).toBe(false);
    expect(
      taskReportMatches(source, task, {
        ...latestReport,
        context: {
          ...latestReport.context,
          repository: { ...latestReport.context.repository, id: "another-repository" },
        },
      }),
    ).toBe(false);
  });

  it("combines source-state, number search, and investigation filters without changing the input", async () => {
    const { task, source } = await fixture();
    const blocked = { ...task, state: "blocked" as const };
    const inputs = [source];
    expect(
      filterWorkItems(inputs, [blocked], {
        search: `#${source.number}`,
        state: source.state,
        investigation: "blocked",
      }),
    ).toEqual([source]);
    expect(
      filterWorkItems(inputs, [blocked], {
        search: "unmatched title",
        state: "all",
        investigation: "all",
      }),
    ).toEqual([]);
    expect(inputs).toEqual([source]);
  });

  it("preserves legacy workItemId links with shareable detail tabs", async () => {
    const { source } = await fixture();
    const url = new URL(workItemUrl(source, "discussion"), "https://workspace.invalid");
    expect(url.searchParams.get("workItemId")).toBe(source.id);
    expect(url.searchParams.get("repositoryId")).toBe(source.repositoryId);
    expect(url.searchParams.get("tab")).toBe("discussion");
  });

  it("requires frozen discussion to belong to the selected repository, work item, and revision", async () => {
    const { source } = await fixture();
    const snapshot: InvestigationWorkItemDiscussion = {
      workItemId: source.id,
      repositoryId: source.repositoryId,
      revisionKey: source.subject.revisionKey,
      availability: "available",
      snapshotRef: { id: "snapshot", digest: "a".repeat(64) },
      inputSnapshot: {
        schemaVersion: "InvestigationInputSnapshotV1",
        workItemId: source.id,
        repositoryId: source.repositoryId,
        subjectRef: source.subject.id,
        subjectRevisionKey: source.subject.revisionKey,
        title: source.title,
        body: source.body,
        comments: [{ id: "comment", body: "Recorded discussion" }],
        source: null,
      },
    };
    expect(() => assertSourceSnapshot(source, snapshot)).not.toThrow();
    expect(() => assertSourceSnapshot(source, { ...snapshot, repositoryId: "other" })).toThrow(
      "does not match",
    );
    expect(() =>
      assertSourceSnapshot(source, {
        ...snapshot,
        inputSnapshot: { ...snapshot.inputSnapshot!, subjectRevisionKey: "b".repeat(64) },
      }),
    ).toThrow("does not match");
    expect(() =>
      assertSourceSnapshot(source, { ...snapshot, availability: "unavailable" }),
    ).toThrow("does not match");
    expect(() =>
      assertSourceSnapshot(source, {
        ...snapshot,
        availability: "unavailable",
        snapshotRef: null,
        inputSnapshot: null,
      }),
    ).not.toThrow();
  });
});
