import type { InvestigationCommentPublicationSummary } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import type { ReviewRecord } from "./model";
import { hasReviewSelection, selectReviewRecord } from "./navigation";

function record(id: string, status: ReviewRecord["status"]): ReviewRecord {
  return {
    id,
    taskId: id,
    workItemId: `source-${id}`,
    repositoryId: "repository",
    repositoryFullName: "microsoft/PowerToys",
    kind: "pr",
    number: 1,
    title: id,
    area: "",
    updatedAt: "2026-10-01T00:00:00Z",
    status,
    ...(status === "attention"
      ? { problem: { type: "review", code: "failed", message: "Failed", hint: "Retry" } as const }
      : {}),
  };
}

function publication(work: ReviewRecord, id: string): InvestigationCommentPublicationSummary {
  return {
    id,
    version: "v1",
    mode: "result",
    repositoryId: work.repositoryId,
    repositoryFullName: work.repositoryFullName,
    workItemId: work.workItemId,
    workItemKind: work.kind === "pr" ? "pull_request" : "issue",
    workItemNumber: work.number,
    taskId: work.taskId ?? null,
    reportId: work.header?.report.id ?? null,
    state: "synced",
    reasonCode: null,
    reason: null,
    requiresAttention: false,
    nextAttemptAt: null,
    lastAttemptAt: work.updatedAt,
    lastConfirmedAt: work.updatedAt,
    externalId: "1",
    commentUrl: "https://github.com/microsoft/PowerToys/pull/1#issuecomment-1",
    availableActions: [],
    createdAt: work.updatedAt,
    updatedAt: work.updatedAt,
  };
}

async function relatedFixture() {
  const api = createSampleInvestigationApi();
  const detail = await api.task("sample-pr-p1-task");
  const header = detail.latestReport;
  if (!header) throw new Error("The fixture requires a saved report.");
  const root = record("root", "posted");
  const historical = { ...record("historical-root", "posted"), workItemId: root.workItemId };
  const child = { ...record("child", "running"), workItemId: root.workItemId };
  for (const work of [root, historical, child]) {
    work.header = {
      ...header,
      id: `report-${work.taskId}`,
      report: { ...header.report, id: `report-${work.taskId}` },
    };
    work.publication = publication(work, `comment-${work.taskId}`);
  }
  const container: ReviewRecord = {
    ...child,
    id: root.id,
    relatedWork: [root, historical, child],
    currentWorkId: child.taskId,
  };
  return { root, historical, child, container };
}

describe("review resource navigation", () => {
  it("selects attention before live and published work only for an unqualified inbox", () => {
    const records = [
      record("published", "posted"),
      record("live", "running"),
      record("failed", "attention"),
    ];
    expect(selectReviewRecord(records, new URLSearchParams())?.id).toBe("failed");
    expect(selectReviewRecord(records.slice(0, 2), new URLSearchParams())?.id).toBe("live");
  });
  it.each(["recordId", "taskId", "reportId", "commentId", "workItemId"])(
    "does not substitute an unrelated review for an unknown %s",
    (key) => {
      const parameters = new URLSearchParams({ [key]: "missing-resource" });
      expect(hasReviewSelection(parameters)).toBe(true);
      expect(selectReviewRecord([record("failed", "attention")], parameters)).toBeUndefined();
    },
  );
  it("preserves the automatic current activity for a container or source link", async () => {
    const { root, container } = await relatedFixture();
    const selections: Record<string, string>[] = [
      { recordId: root.id },
      { workItemId: root.workItemId },
      { recordId: root.id, workItemId: root.workItemId },
    ];
    for (const parameters of selections)
      expect(selectReviewRecord([container], new URLSearchParams(parameters))).toBe(container);
  });
  it("opens exact root, historical root, and child tasks inside one source", async () => {
    const { root, historical, child, container } = await relatedFixture();
    for (const work of [root, historical, child]) {
      expect(
        selectReviewRecord([container], new URLSearchParams({ taskId: work.taskId ?? "" })),
      ).toMatchObject({ id: container.id, currentWorkId: work.taskId });
      expect(
        selectReviewRecord(
          [container],
          new URLSearchParams({ recordId: container.id, taskId: work.taskId ?? "" }),
        ),
      ).toMatchObject({ id: container.id, currentWorkId: work.taskId });
    }
  });
  it("retains historical record links while an explicit task selects within their source", async () => {
    const { historical, child, container } = await relatedFixture();
    expect(
      selectReviewRecord([container], new URLSearchParams({ recordId: historical.id })),
    ).toMatchObject({ id: container.id, currentWorkId: historical.taskId });
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({ recordId: historical.id, taskId: child.taskId ?? "" }),
      ),
    ).toMatchObject({ id: container.id, currentWorkId: child.taskId });
    const parameters = {
      recordId: historical.id,
      taskId: child.taskId ?? "",
      reportId: child.header?.report.id ?? "",
      commentId: child.publication?.id ?? "",
      workItemId: child.workItemId,
    };
    expect(selectReviewRecord([container], new URLSearchParams(parameters))).toMatchObject({
      id: container.id,
      currentWorkId: child.taskId,
    });
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({ ...parameters, reportId: historical.header?.report.id ?? "" }),
      ),
    ).toBeUndefined();
  });
  it("rejects unknown or conflicting record and task identifiers", async () => {
    const { historical, child, container } = await relatedFixture();
    const other = record("other", "running");
    for (const parameters of [
      { recordId: "missing-record", taskId: child.taskId ?? "" },
      { recordId: container.id, taskId: "missing-task" },
      { recordId: historical.id, taskId: "missing-task" },
      { recordId: other.id, taskId: child.taskId ?? "" },
      { recordId: container.id, taskId: other.taskId ?? "" },
    ])
      expect(
        selectReviewRecord([container, other], new URLSearchParams(parameters)),
      ).toBeUndefined();
  });
  it("does not treat a container identifier as an available raw task", async () => {
    const { child, container } = await relatedFixture();
    const unavailable = { ...container, relatedWork: [child] };
    expect(selectReviewRecord([unavailable], new URLSearchParams({ recordId: container.id }))).toBe(
      unavailable,
    );
    expect(
      selectReviewRecord([unavailable], new URLSearchParams({ taskId: container.id })),
    ).toBeUndefined();
  });
  it("applies report, comment, and source constraints to the same exact activity", async () => {
    const { root, historical, child, container } = await relatedFixture();
    for (const work of [root, historical, child]) {
      const parameters = {
        recordId: container.id,
        taskId: work.taskId ?? "",
        reportId: work.header?.report.id ?? "",
        commentId: work.publication?.id ?? "",
        workItemId: work.workItemId,
      };
      expect(selectReviewRecord([container], new URLSearchParams(parameters))).toMatchObject({
        id: container.id,
        currentWorkId: work.taskId,
      });
      for (const key of ["reportId", "commentId", "workItemId"] as const)
        expect(
          selectReviewRecord(
            [container],
            new URLSearchParams({ ...parameters, [key]: "missing-resource" }),
          ),
        ).toBeUndefined();
    }
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({
          recordId: container.id,
          taskId: child.taskId ?? "",
          reportId: root.header?.report.id ?? "",
        }),
      ),
    ).toBeUndefined();
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({
          reportId: root.header?.report.id ?? "",
          commentId: child.publication?.id ?? "",
        }),
      ),
    ).toBeUndefined();
  });
  it("selects an exact activity from report or comment links without a task parameter", async () => {
    const { root, historical, child, container } = await relatedFixture();
    for (const work of [root, historical, child]) {
      const selections: Record<string, string>[] = [
        { reportId: work.header?.report.id ?? "" },
        { commentId: work.publication?.id ?? "" },
        { recordId: container.id, reportId: work.header?.report.id ?? "" },
        { recordId: historical.id, reportId: work.header?.report.id ?? "" },
      ];
      for (const parameters of selections) {
        const selected = selectReviewRecord([container], new URLSearchParams(parameters));
        if (
          "recordId" in parameters &&
          parameters.recordId === historical.id &&
          work !== historical
        )
          expect(selected).toBeUndefined();
        else expect(selected).toMatchObject({ id: container.id, currentWorkId: work.taskId });
      }
    }
  });
  it("matches progress comments while retaining the exact task and report constraints", async () => {
    const { root, child, container } = await relatedFixture();
    child.progressPublication = { ...publication(child, "progress-child"), mode: "progress" };
    const parameters = {
      recordId: container.id,
      taskId: child.taskId ?? "",
      reportId: child.header?.report.id ?? "",
      commentId: child.progressPublication.id,
      workItemId: child.workItemId,
    };
    expect(selectReviewRecord([container], new URLSearchParams(parameters))).toMatchObject({
      id: container.id,
      currentWorkId: child.taskId,
    });
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({ ...parameters, taskId: root.taskId ?? "" }),
      ),
    ).toBeUndefined();
  });
  it("keeps an explicit task exact when multiple activities share a comment", async () => {
    const { root, child, container } = await relatedFixture();
    child.publication = publication(child, root.publication?.id ?? "");
    expect(
      selectReviewRecord(
        [container],
        new URLSearchParams({ taskId: child.taskId ?? "", commentId: root.publication?.id ?? "" }),
      ),
    ).toMatchObject({ id: container.id, currentWorkId: child.taskId });
  });
  it.each(["repositoryId", "workItemId", "kind", "number"] as const)(
    "rejects a related activity with a conflicting %s source binding",
    async (field) => {
      const { child, container } = await relatedFixture();
      const foreign: ReviewRecord = {
        ...child,
        id: "foreign",
        taskId: "foreign",
        [field]: field === "kind" ? "issue" : field === "number" ? 2 : "another-source",
      };
      expect(
        selectReviewRecord(
          [{ ...container, relatedWork: [foreign] }],
          new URLSearchParams({ recordId: container.id, taskId: foreign.taskId ?? "" }),
        ),
      ).toBeUndefined();
    },
  );
  it("applies source constraints even when an explicit task belongs to another visible record", async () => {
    const { child, container } = await relatedFixture();
    const other = record("other", "running");
    expect(
      selectReviewRecord(
        [container, other],
        new URLSearchParams({ taskId: other.taskId ?? "", workItemId: child.workItemId }),
      ),
    ).toBeUndefined();
  });
  it("rejects conflicting source and work identifiers", () => {
    const selected = record("known", "running");
    expect(
      selectReviewRecord(
        [selected],
        new URLSearchParams({ taskId: selected.id, workItemId: "another-source" }),
      ),
    ).toBeUndefined();
  });
  it("treats an empty identifier as an unqualified inbox", () => {
    expect(hasReviewSelection(new URLSearchParams("recordId="))).toBe(false);
    expect(
      selectReviewRecord([record("live", "running")], new URLSearchParams("recordId="))?.id,
    ).toBe("live");
  });
});
