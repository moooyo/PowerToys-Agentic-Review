import { createInvestigationPreview, type InvestigationTaskV1 } from "@agentic-review/contracts";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "../investigation/api";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import { mapReviewTask, type ReviewRecord } from "./model";
import {
  orderRelatedActivities,
  projectRelatedActivities,
  RelatedActivities,
  RelatedActivitiesView,
  relatedActivityMetadata,
  relatedActivityStatus,
  relatedActivityTime,
  selectRelatedActivity,
} from "./related-activities";

const english = (_zh: string, en: string) => en;

function activity(
  id: string,
  taskOverrides: Partial<InvestigationTaskV1> = {},
  recordOverrides: Partial<ReviewRecord> = {},
): ReviewRecord {
  const task: InvestigationTaskV1 = {
    ...createInvestigationPreview("pr").task,
    id,
    latestReportRef: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
    ...taskOverrides,
  };
  return { ...mapReviewTask(task), title: id, ...recordOverrides };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}

function detailFor(task: InvestigationTaskV1, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task,
    attempts: [],
    checkpoint: null,
    latestReport: null,
    children: [],
    ...overrides,
  };
}

function content(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      return isValidElement<{ children?: ReactNode }>(child) ? content(child.props.children) : "";
    })
    .join("");
}

function rows(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return elements(node).filter(
    (element) => element.type === "button" && element.props.className === "rc-activity-row",
  );
}

describe("related activity projection", () => {
  it("keeps distinct tasks of the same kind and deduplicates their stable identities", () => {
    const root = activity("root");
    const first = activity("verification-one", { kind: "pr-verify" }, { id: root.id });
    const duplicate = { ...root, id: "container-alias", title: "Duplicate snapshot" };
    const second = activity("verification-two", { kind: "pr-verify" }, { id: root.id });
    const records = Object.freeze([root, first, duplicate, second]);
    const snapshot = structuredClone(records);

    expect(projectRelatedActivities(records)).toEqual([root, first, second]);
    expect(records).toEqual(snapshot);
  });

  it("retains matching task identifiers from different repositories and work items", () => {
    const root = activity("shared-task");
    const otherRepository = activity("shared-task", {
      repository: { ...root.task!.repository, id: "other-repository" },
    });
    const otherItem = activity("shared-task", {
      workItem: { ...root.task!.workItem, id: "other-item" },
    });

    expect(projectRelatedActivities([root, otherRepository, otherItem])).toEqual([
      root,
      otherRepository,
      otherItem,
    ]);
  });

  it("keeps taskless activities distinct by their recorded identity", () => {
    const first = { ...activity("root"), id: "intake-one", taskId: undefined, task: undefined };
    const duplicate = { ...first, title: "Duplicate intake snapshot" };
    const second = { ...first, id: "intake-two" };

    expect(projectRelatedActivities([first, duplicate, second])).toEqual([first, second]);
  });

  it("overlays the selected live detail without moving it or mutating snapshots", () => {
    const root = activity("root");
    const queued = activity("selected", { state: "queued" });
    const later = activity("later", { kind: "pr-e2e" });
    const live = activity(
      "selected",
      { state: "running", updatedAt: "2026-10-01T00:05:00.000Z" },
      { stage: "model", lastOutput: "Fresh model output" },
    );
    const records = Object.freeze([root, queued, later]);
    const originalRecords = structuredClone(records);
    const originalLive = structuredClone(live);

    const projected = projectRelatedActivities(records, live);

    expect(projected.map((record) => record.taskId)).toEqual(["root", "selected", "later"]);
    expect(projected[1]).toMatchObject({
      status: "running",
      stage: "model",
      lastOutput: "Fresh model output",
      task: { state: "running" },
    });
    expect(records).toEqual(originalRecords);
    expect(live).toEqual(originalLive);
  });

  it("retains a newer parent task when the selected query still has an older terminal snapshot", () => {
    const parent = activity("selected", {
      state: "running",
      updatedAt: "2026-10-01T00:02:00.000Z",
    });
    const cached = activity("selected", {
      state: "cancelled",
      updatedAt: "2026-10-01T00:01:00.000Z",
    });
    const records = Object.freeze([parent]);
    const snapshot = structuredClone(records);

    expect(projectRelatedActivities(records, cached)).toEqual([parent]);
    expect(records).toEqual(snapshot);
  });

  it("accepts a newer bound query detail even when its task snapshot is older", () => {
    const parent = activity("selected", {
      state: "queued",
      updatedAt: "2026-10-01T00:02:00.000Z",
    });
    const oldTask = { ...parent.task!, updatedAt: "2026-10-01T00:01:00.000Z" };
    const freshTask = {
      ...parent.task!,
      state: "running" as const,
      updatedAt: "2026-10-01T00:03:00.000Z",
    };
    const live = { ...parent, task: oldTask, detail: detailFor(freshTask) };

    expect(projectRelatedActivities([parent], live)).toEqual([live]);
    expect(relatedActivityStatus(live, english).label).toBe("Running");
  });

  it.each(["taskId", "repositoryId", "workItemId"] as const)(
    "rejects live overlays with mismatched %s",
    (field) => {
      const record = activity("selected", { state: "queued" });
      const live = { ...record, [field]: "another-source", status: "running" as const };

      expect(projectRelatedActivities([record], live)).toEqual([record]);
    },
  );

  it.each(["task", "repository", "workItem"] as const)(
    "does not replace a bound parent with a selected record whose nested %s binding is wrong",
    (field) => {
      const record = activity("selected", { state: "queued" });
      const task = { ...record.task!, state: "running" as const };
      const mismatched: InvestigationTaskV1 =
        field === "task"
          ? { ...task, id: "another-task" }
          : field === "repository"
            ? { ...task, repository: { ...task.repository, id: "another-repository" } }
            : { ...task, workItem: { ...task.workItem, id: "another-item" } };
      const live = { ...record, task: mismatched, status: "running" as const };

      expect(projectRelatedActivities([record], live)).toEqual([record]);
    },
  );
});

describe("related activity time and ordering", () => {
  it("keeps list order while placing timeline activities in creation order", () => {
    const newest = activity("newest", { createdAt: "2026-10-01T00:03:00.000Z" });
    const oldest = activity("oldest", { createdAt: "2026-10-01T00:01:00.000Z" });
    const middle = activity("middle", { createdAt: "2026-10-01T00:02:00.000Z" });
    const records = Object.freeze([newest, oldest, middle]);
    const snapshot = structuredClone(records);

    expect(orderRelatedActivities(records, "list")).toEqual([newest, oldest, middle]);
    expect(orderRelatedActivities(records, "timeline")).toEqual([oldest, middle, newest]);
    expect(records).toEqual(snapshot);
  });

  it("uses creation time even when a publication update is newer", () => {
    const record = activity(
      "created",
      { createdAt: "2026-10-01T00:01:00.000Z" },
      { updatedAt: "2026-10-03T00:00:00.000Z" },
    );

    expect(relatedActivityTime(record)).toEqual({
      kind: "created",
      value: record.task!.createdAt,
      milliseconds: Date.parse(record.task!.createdAt),
    });
  });

  it("labels an update-time fallback instead of inventing a creation time", () => {
    const record = activity(
      "fallback",
      { createdAt: "not-a-date" },
      { updatedAt: "2026-10-01T00:02:00.000Z" },
    );

    expect(relatedActivityTime(record)).toEqual({
      kind: "updated",
      value: record.updatedAt,
      milliseconds: Date.parse(record.updatedAt),
    });
    expect(relatedActivityTime({ ...record, task: undefined })).toEqual(
      relatedActivityTime(record),
    );
  });

  it.each(["2026-10-01", "October 1, 2026"])(
    "does not accept a non-ISO creation timestamp %s",
    (createdAt) => {
      const record = activity("fallback", { createdAt });

      expect(relatedActivityTime(record)).toMatchObject({
        kind: "updated",
        value: record.updatedAt,
      });
    },
  );

  it("places unknown timestamps last and preserves input order for equal times", () => {
    const unknownFirst = activity("unknown-first", { createdAt: "invalid" }, { updatedAt: "" });
    const equalFirst = activity("equal-first", { createdAt: "2026-10-01T00:01:00.000Z" });
    const fallback = activity(
      "fallback",
      { createdAt: "invalid" },
      { updatedAt: "2026-10-01T00:00:00.000Z" },
    );
    const unknownSecond = activity("unknown-second", { createdAt: "" }, { updatedAt: "invalid" });
    const equalSecond = activity("equal-second", { createdAt: equalFirst.task!.createdAt });

    expect(relatedActivityTime(unknownFirst)).toEqual({ kind: "unknown" });
    expect(
      orderRelatedActivities(
        [unknownFirst, equalFirst, fallback, unknownSecond, equalSecond],
        "timeline",
      ),
    ).toEqual([fallback, equalFirst, equalSecond, unknownFirst, unknownSecond]);
  });

  it("sorts ISO offsets by their actual instants and keeps equal instants stable", () => {
    const later = activity("later", { createdAt: "2026-10-01T07:30:00.000Z" });
    const offset = activity("offset", { createdAt: "2026-10-01T08:00:00.000+08:00" });
    const equivalent = activity("equivalent", { createdAt: "2026-10-01T00:00:00.000Z" });

    expect(orderRelatedActivities([later, offset, equivalent], "timeline")).toEqual([
      offset,
      equivalent,
      later,
    ]);
  });
});

describe("related activity source status", () => {
  it.each([
    ["completed", "Completed", "success"],
    ["failed", "Failed", "danger"],
    ["running", "Running", "active"],
    ["queued", "Queued", "neutral"],
    ["blocked", "Blocked", "warning"],
    ["cancelled", "Cancelled", "neutral"],
    ["interrupted", "Interrupted", "warning"],
  ] as const)(
    "shows actual %s state instead of a conflicting aggregate status",
    (state, label, tone) => {
      const record = activity(
        state,
        { state },
        { status: "posted", completedWithoutPublication: true },
      );

      expect(relatedActivityStatus(record, english)).toMatchObject({ label, tone });
    },
  );

  it("uses the bound live task state before an older task snapshot", () => {
    const record = activity("selected", { state: "queued" });
    const liveTask = {
      ...record.task!,
      state: "running" as const,
      updatedAt: "2026-10-01T00:02:00.000Z",
    };

    expect(relatedActivityStatus({ ...record, detail: detailFor(liveTask) }, english).label).toBe(
      "Running",
    );
  });

  it.each([
    ["running", "cancelled", "Running"],
    ["completed", "running", "Completed"],
  ] as const)(
    "keeps a fresh %s source ahead of an older %s detail without reusing its stage",
    (state, cachedState, label) => {
      const record = activity(
        "selected",
        { state, updatedAt: "2026-10-01T00:02:00.000Z" },
        { stage: "model" },
      );
      const cachedTask = {
        ...record.task!,
        state: cachedState,
        updatedAt: "2026-10-01T00:01:00.000Z",
      };
      const detail = detailFor(cachedTask, {
        progress: {
          stage: "model",
          stageStartedAt: "2026-10-01T00:00:00.000Z",
          lastActivityAt: null,
          lastMeaningfulProgressAt: null,
          lastHeartbeatAt: null,
        },
      });
      const source = { ...record, detail };

      expect(relatedActivityStatus(source, english).label).toBe(label);
      expect(relatedActivityMetadata(source, english)).toEqual([]);
    },
  );

  it.each(["task", "repository", "workItem"] as const)(
    "ignores detail state from a mismatched %s binding",
    (field) => {
      const record = activity("selected", { state: "queued" });
      const liveTask = { ...record.task!, state: "running" as const };
      const mismatched: InvestigationTaskV1 =
        field === "task"
          ? { ...liveTask, id: "another-task" }
          : field === "repository"
            ? { ...liveTask, repository: { ...liveTask.repository, id: "another-source" } }
            : { ...liveTask, workItem: { ...liveTask.workItem, id: "another-source" } };

      expect(
        relatedActivityStatus({ ...record, detail: detailFor(mismatched) }, english).label,
      ).toBe("Queued");
    },
  );

  it("keeps completed execution separate from a publication warning", () => {
    const record = activity(
      "completed",
      { state: "completed", kind: "pr-verify", parentTaskId: "parent-review" },
      {
        completedWithoutPublication: false,
        problem: { type: "upload", code: "HTTP 403", message: "Delivery failed", hint: "Retry" },
      },
    );
    const status = relatedActivityStatus(record, english);
    const html = renderToStaticMarkup(
      <RelatedActivitiesView
        records={[record]}
        selectedTaskId={record.taskId}
        view="list"
        busy={false}
        onSelect={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(status).toMatchObject({ label: "Completed", tone: "success" });
    expect(html).toContain("Completed");
    expect(html).toContain("Publication needs attention");
    expect(html).not.toContain(">Failed<");
  });

  it.each(["pr-review", "pr-e2e", "issue-investigate"] as const)(
    "retains missing-publication uncertainty for a completed %s root",
    (kind) => {
      const preview = createInvestigationPreview(kind === "issue-investigate" ? "bug" : "pr");
      const record = activity("completed", {
        ...preview.task,
        id: "completed",
        state: "completed",
        kind,
      });
      const html = renderToStaticMarkup(
        <RelatedActivitiesView
          records={[record]}
          selectedTaskId={record.taskId}
          view="timeline"
          busy={false}
          onSelect={vi.fn()}
          onViewChange={vi.fn()}
        />,
      );

      expect(relatedActivityStatus(record, english).label).toBe("Completed");
      expect(html).toContain("Publication unconfirmed");
    },
  );

  it.each(["reproduction-setup", "issue-fix", "pr-verify"] as const)(
    "shows completed %s follow-up without inferring missing publication",
    (kind) => {
      const preview = createInvestigationPreview(kind === "pr-verify" ? "pr" : "bug");
      const record = activity(kind, {
        ...preview.task,
        id: kind,
        kind,
        state: "completed",
        parentTaskId: "parent-review",
        parentReportRef: { id: "parent-report", version: 1, digest: "a".repeat(64) },
        planRef: { id: "follow-up-plan", version: 1, digest: "b".repeat(64) },
      });
      const original = structuredClone(record);
      const html = renderToStaticMarkup(
        <RelatedActivitiesView
          records={[record]}
          view="list"
          busy={false}
          onSelect={vi.fn()}
          onViewChange={vi.fn()}
        />,
      );

      expect(record.completedWithoutPublication).toBe(true);
      expect(relatedActivityStatus(record, english).label).toBe("Completed");
      expect(html).toContain("Completed");
      expect(html).not.toContain("Publication unconfirmed");
      expect(html).not.toContain("Publication needs attention");
      expect(record).toEqual(original);
    },
  );

  it.each([
    ["unconfirmed", false, "Publication unconfirmed"],
    ["needs_attention", true, "Publication needs attention"],
  ] as const)(
    "retains an actual %s publication warning for a completed follow-up",
    async (state, requiresAttention, warning) => {
      const record = activity("child", {
        state: "completed",
        kind: "pr-verify",
        parentTaskId: "parent-review",
      });
      const publication = (await createSampleInvestigationApi().publicationDirectory({ limit: 50 }))
        .items[0];
      if (!publication) throw new Error("A publication fixture is required.");
      record.publication = {
        ...publication,
        repositoryId: record.repositoryId,
        workItemId: record.workItemId,
        taskId: record.taskId!,
        state,
        requiresAttention,
      };
      const html = renderToStaticMarkup(
        <RelatedActivitiesView
          records={[record]}
          view="list"
          busy={false}
          onSelect={vi.fn()}
          onViewChange={vi.fn()}
        />,
      );

      expect(html).toContain("Completed");
      expect(html).toContain(warning);
    },
  );
});

describe("related activity observed metadata", () => {
  it.each([0, 65_000])("shows measured execution duration of %s ms", async (durationMs) => {
    const original = await createSampleInvestigationApi().task("sample-pr-partial-task");
    if (!original.checkpoint) throw new Error("The fixture requires a saved checkpoint.");
    const task = { ...original.task, state: "running" as const };
    const detail = detailFor(task, {
      checkpoint: {
        ...original.checkpoint,
        consumed: { ...original.checkpoint.consumed, durationMs },
      },
      progress: {
        stage: "model",
        stageStartedAt: "2000-01-01T00:00:00.000Z",
        lastActivityAt: null,
        lastMeaningfulProgressAt: null,
        lastHeartbeatAt: null,
      },
    });
    const record = { ...mapReviewTask(task, detail), startedAt: "2000-01-01T00:00:00.000Z" };

    expect(relatedActivityMetadata(record, english)).toEqual([
      "Stage: Model analysis",
      `Recorded execution: ${durationMs === 0 ? "0:00" : "1:05"}`,
    ]);
  });

  it("omits unknown stages and does not infer elapsed execution from timestamps", () => {
    const record = activity(
      "unmeasured",
      { state: "running" },
      { stage: "future-stage", startedAt: "2000-01-01T00:00:00.000Z" },
    );

    expect(relatedActivityMetadata(record, english)).toEqual([]);
    expect(relatedActivityMetadata({ ...record, stage: undefined }, english)).toEqual([]);
  });

  it("does not present a retained stage as active after execution stops", () => {
    const record = activity("stopped", { state: "cancelled" }, { stage: "model" });

    expect(relatedActivityMetadata(record, english)).toEqual([]);
  });

  it("ignores a measured duration from another task's checkpoint", async () => {
    const original = await createSampleInvestigationApi().task("sample-pr-partial-task");
    const record = activity("selected", { state: "running" }, { detail: original });

    expect(relatedActivityMetadata(record, english)).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not display invalid measured duration %s",
    async (durationMs) => {
      const original = await createSampleInvestigationApi().task("sample-pr-partial-task");
      if (!original.checkpoint) throw new Error("The fixture requires a saved checkpoint.");
      const detail = detailFor(original.task, {
        checkpoint: {
          ...original.checkpoint,
          consumed: { ...original.checkpoint.consumed, durationMs },
        },
      });

      expect(relatedActivityMetadata(mapReviewTask(original.task, detail), english)).toEqual([]);
    },
  );

  it("uses consumed duration from the bound current saved report when no checkpoint is available", async () => {
    const original = await createSampleInvestigationApi().task("sample-pr-p1-task");
    if (!original.latestReport) throw new Error("The fixture requires a saved report.");
    const header = {
      ...original.latestReport,
      report: {
        ...original.latestReport.report,
        loop: {
          ...original.latestReport.report.loop,
          consumed: { ...original.latestReport.report.loop.consumed, durationMs: 65_000 },
        },
      },
    };
    const record = mapReviewTask(original.task, {
      ...original,
      checkpoint: null,
      latestReport: header,
    });

    expect(relatedActivityMetadata(record, english)).toEqual(["Recorded execution: 1:05"]);
    expect(
      relatedActivityMetadata(
        {
          ...record,
          detail: undefined,
          header: { ...header, id: "superseded-report" },
        },
        english,
      ),
    ).toEqual([]);
  });
});

describe("related activity selection", () => {
  it("selects the exact activity record rather than its shared container identifier", () => {
    const record = activity("child", { kind: "pr-verify" }, { id: "root-container" });
    const onSelect = vi.fn();

    selectRelatedActivity(record, false, onSelect);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(record);
  });

  it("guards selection while busy and for an activity without a task identity", () => {
    const record = activity("selected");
    const onSelect = vi.fn();

    selectRelatedActivity(record, true, onSelect);
    selectRelatedActivity({ ...record, taskId: undefined, task: undefined }, false, onSelect);
    selectRelatedActivity({ ...record, taskId: "", task: undefined }, false, onSelect);

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("related activities view", () => {
  it("shows all seven actual task states together in the default list", () => {
    const states = [
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["running", "Running"],
      ["queued", "Queued"],
      ["blocked", "Blocked"],
      ["cancelled", "Cancelled"],
      ["interrupted", "Interrupted"],
    ] as const;
    const records = states.map(([state]) => activity(`mixed-${state}`, { state }));
    const html = renderToStaticMarkup(
      <RelatedActivities
        records={records}
        selectedTaskId="mixed-running"
        busy={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("rc-activities-list");
    expect(html.match(/class="rc-activity-row"/gu)).toHaveLength(states.length);
    for (const [state, label] of states) {
      expect(html).toContain(`data-task-id="mixed-${state}"`);
      expect(html).toContain(`data-task-state="${state}"`);
      expect(html).toContain(label);
    }
    expect(html.match(/aria-current="true"/gu)).toHaveLength(1);
  });

  it("defaults to a list and renders every activity with an exact selectable identity", () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      activity(`verification-${index}`, { kind: "pr-verify" }),
    );
    const snapshot = structuredClone(records);
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      <RelatedActivities
        records={records}
        selectedTaskId="verification-7"
        busy={false}
        onSelect={onSelect}
      />,
    );

    expect(html).toContain("rc-activities-list");
    expect(html.match(/class="rc-activity-row"/gu)).toHaveLength(12);
    for (const record of records) {
      expect(html).toContain(`data-task-id="${record.taskId}"`);
      expect(html).toContain(`<code>${record.taskId}</code>`);
    }
    expect(html.match(/aria-current="true"/gu)).toHaveLength(1);
    const selectedRow = html.match(/<button\b[^>]*data-task-id="verification-7"[^>]*>/u)?.[0];
    expect(selectedRow).toContain('aria-pressed="true"');
    expect(selectedRow).toContain('aria-current="true"');
    expect(records).toEqual(snapshot);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders the selected live record while retaining the original list snapshots", () => {
    const queued = activity("selected", { state: "queued" });
    const live = activity("selected", { state: "running" }, { stage: "model" });
    const records = Object.freeze([queued]);
    const snapshot = structuredClone(records);
    const html = renderToStaticMarkup(
      <RelatedActivities
        records={records}
        selectedTaskId={queued.taskId}
        selectedRecord={live}
        busy={false}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('data-task-state="running"');
    expect(html).toContain("Stage: Model analysis");
    expect(html).not.toContain(">Queued<");
    expect(records).toEqual(snapshot);
  });

  it("changes only the controlled layout callback and keeps the selected activity", () => {
    const later = activity("later", { createdAt: "2026-10-01T00:02:00.000Z" });
    const selected = activity("selected", { createdAt: "2026-10-01T00:01:00.000Z" });
    const records = Object.freeze([later, selected]);
    const onSelect = vi.fn();
    const onViewChange = vi.fn();
    const props = {
      records,
      selectedTaskId: selected.taskId,
      view: "list" as const,
      busy: false,
      onSelect,
      onViewChange,
    };
    const view = RelatedActivitiesView(props);
    const timelineButton = elements(view).find(
      (element) =>
        element.type === "button" && content(element.props.children as ReactNode) === "Timeline",
    );

    expect(timelineButton).toBeDefined();
    expect(timelineButton!.props["aria-pressed"]).toBe(false);
    (timelineButton!.props.onClick as () => void)();

    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("timeline");
    expect(onSelect).not.toHaveBeenCalled();
    expect(props.selectedTaskId).toBe("selected");
    expect(props.view).toBe("list");
    expect(rows(view).map((row) => row.props["data-task-id"])).toEqual(["later", "selected"]);

    const timeline = RelatedActivitiesView({ ...props, view: "timeline" });
    const timelineRows = rows(timeline);
    expect(timelineRows.map((row) => row.props["data-task-id"])).toEqual(["selected", "later"]);
    expect(timelineRows.filter((row) => row.props["aria-pressed"])).toHaveLength(1);
    expect(timelineRows.find((row) => row.props["aria-pressed"])?.props["data-task-id"]).toBe(
      "selected",
    );
    expect(records).toEqual([later, selected]);
  });

  it.each(["list", "timeline"] as const)(
    "keeps exact row selection and disabled guards in the %s view",
    (view) => {
      const record = activity("child", { kind: "pr-verify" }, { id: "root-container" });
      const taskless = { ...activity("intake"), taskId: undefined, task: undefined };
      const onSelect = vi.fn();
      const props = {
        records: [record, taskless],
        selectedTaskId: record.taskId,
        view,
        busy: false,
        onSelect,
        onViewChange: vi.fn(),
      };
      const activityRows = rows(RelatedActivitiesView(props));
      const taskRow = activityRows.find((row) => row.props["data-task-id"] === "child")!;
      const tasklessRow = activityRows.find((row) => !row.props["data-task-id"])!;

      expect(taskRow.props["aria-pressed"]).toBe(true);
      expect(tasklessRow.props.disabled).toBe(true);
      (tasklessRow.props.onClick as () => void)();
      expect(onSelect).not.toHaveBeenCalled();
      (taskRow.props.onClick as () => void)();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(record);
      onSelect.mockClear();

      const busyRows = rows(RelatedActivitiesView({ ...props, busy: true }));
      expect(busyRows.every((row) => row.props.disabled)).toBe(true);
      for (const row of busyRows) (row.props.onClick as () => void)();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("labels fallback and unknown times in the rendered activity rows", () => {
    const fallback = activity(
      "fallback",
      { createdAt: "invalid" },
      { updatedAt: "2026-10-01T00:01:00.000Z" },
    );
    const unknown = activity("unknown", { createdAt: "invalid" }, { updatedAt: "invalid" });
    const html = renderToStaticMarkup(
      <RelatedActivitiesView
        records={[fallback, unknown]}
        view="timeline"
        busy={false}
        onSelect={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(html).toMatch(/Updated <time datetime="2026-10-01T00:01:00\.000Z"/iu);
    expect(html).toContain("Time unknown");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
  });
});
