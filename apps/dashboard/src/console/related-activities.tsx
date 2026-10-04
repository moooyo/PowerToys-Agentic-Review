import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import { useState } from "react";
import {
  type ConsoleText,
  formatDuration,
  problemLabel,
  type ReviewRecord,
  relatedWorkLabel,
  stageLabel,
} from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./related-activities.css";

export type RelatedActivityView = "list" | "timeline";

interface RelatedActivitiesProps {
  records: readonly ReviewRecord[];
  selectedTaskId?: string;
  selectedRecord?: ReviewRecord;
  busy: boolean;
  onSelect: (record: ReviewRecord) => void;
}

interface RelatedActivitiesViewProps extends Omit<RelatedActivitiesProps, "selectedRecord"> {
  view: RelatedActivityView;
  onViewChange: (view: RelatedActivityView) => void;
  text?: ConsoleText;
  language?: "zh" | "en";
}

function boundTask(record: ReviewRecord): InvestigationTaskV1 | undefined {
  const taskId = record.taskId ?? record.task?.id;
  const candidates = [record.detail?.task, record.task].filter(
    (task) =>
      task !== undefined &&
      task.id === taskId &&
      task.repository.id === record.repositoryId &&
      task.workItem.id === record.workItemId,
  );
  return candidates.reduce<InvestigationTaskV1 | undefined>((latest, task) => {
    if (!task) return latest;
    if (!latest) return task;
    const time = Date.parse(task.updatedAt);
    const latestTime = Date.parse(latest.updatedAt);
    if (Number.isFinite(time) && (!Number.isFinite(latestTime) || time > latestTime)) return task;
    return latest;
  }, undefined);
}

export function relatedActivityKey(record: ReviewRecord): string {
  return JSON.stringify([
    record.repositoryId,
    record.workItemId,
    record.taskId ? "task" : "record",
    record.taskId ?? record.id,
  ]);
}

export function projectRelatedActivities(
  records: readonly ReviewRecord[],
  selectedRecord?: ReviewRecord,
): ReviewRecord[] {
  const unique = new Map<string, ReviewRecord>();
  for (const record of records) {
    const key = relatedActivityKey(record);
    if (!unique.has(key)) unique.set(key, record);
  }
  if (selectedRecord) {
    const key = relatedActivityKey(selectedRecord);
    const retained = unique.get(key);
    if (retained) {
      const retainedTask = boundTask(retained);
      const selectedTask = boundTask(selectedRecord);
      const selectedIsOlder =
        retainedTask &&
        (!selectedTask || Date.parse(retainedTask.updatedAt) > Date.parse(selectedTask.updatedAt));
      if (!selectedIsOlder) unique.set(key, selectedRecord);
    }
  }
  return [...unique.values()];
}

function timestampMilliseconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts) return undefined;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  )
    return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function relatedActivityTime(record: ReviewRecord): {
  kind: "created" | "updated" | "unknown";
  value?: string;
  milliseconds?: number;
} {
  const created = boundTask(record)?.createdAt;
  const createdMilliseconds = timestampMilliseconds(created);
  if (createdMilliseconds !== undefined)
    return { kind: "created", value: created, milliseconds: createdMilliseconds };
  const updatedMilliseconds = timestampMilliseconds(record.updatedAt);
  return updatedMilliseconds === undefined
    ? { kind: "unknown" }
    : { kind: "updated", value: record.updatedAt, milliseconds: updatedMilliseconds };
}

export function orderRelatedActivities(
  records: readonly ReviewRecord[],
  view: RelatedActivityView,
): ReviewRecord[] {
  if (view === "list") return [...records];
  return records
    .map((record, index) => ({ record, index, time: relatedActivityTime(record).milliseconds }))
    .sort((left, right) => {
      if (left.time === undefined && right.time === undefined) return left.index - right.index;
      if (left.time === undefined) return 1;
      if (right.time === undefined) return -1;
      return left.time - right.time || left.index - right.index;
    })
    .map(({ record }) => record);
}

export function relatedActivityStatus(
  record: ReviewRecord,
  text: ConsoleText,
): {
  label: string;
  tone: "success" | "active" | "warning" | "danger" | "neutral";
  icon: string;
} {
  const state = boundTask(record)?.state;
  switch (state ?? record.status) {
    case "completed":
      return { label: text("已完成", "Completed"), tone: "success", icon: "check_circle" };
    case "running":
      return { label: text("运行中", "Running"), tone: "active", icon: "play_circle" };
    case "queued":
      return { label: text("排队中", "Queued"), tone: "neutral", icon: "schedule" };
    case "blocked":
      return { label: text("受阻", "Blocked"), tone: "warning", icon: "error_outline" };
    case "failed":
      return { label: text("失败", "Failed"), tone: "danger", icon: "error" };
    case "cancelled":
      return { label: text("已取消", "Cancelled"), tone: "neutral", icon: "stop_circle" };
    case "interrupted":
      return { label: text("已中断", "Interrupted"), tone: "warning", icon: "pause_circle" };
    case "publishing":
      return { label: text("发布中", "Publishing"), tone: "active", icon: "upload" };
    case "posted":
      return { label: text("已发布", "Posted"), tone: "success", icon: "check_circle" };
    default:
      return { label: problemLabel(record.problem?.type, text), tone: "warning", icon: "info" };
  }
}

function relatedActivityPublicationWarning(
  record: ReviewRecord,
  text: ConsoleText,
): string | undefined {
  if (record.problem?.type === "upload" || record.publication?.requiresAttention)
    return text("发布需要处理", "Publication needs attention");
  const task = boundTask(record);
  const missingRootPublication =
    record.completedWithoutPublication &&
    task?.state === "completed" &&
    task.parentTaskId === null &&
    task.parentReportRef === null &&
    task.planRef === null &&
    ["pr-review", "pr-e2e", "issue-investigate"].includes(task.kind);
  if (missingRootPublication || record.publication?.state === "unconfirmed")
    return text("发布尚未确认", "Publication unconfirmed");
  return undefined;
}

export function relatedActivityMetadata(record: ReviewRecord, text: ConsoleText): string[] {
  const task = boundTask(record);
  const detail =
    task &&
    record.detail?.task.id === task.id &&
    record.detail.task.repository.id === record.repositoryId &&
    record.detail.task.workItem.id === record.workItemId
      ? record.detail
      : undefined;
  const metadata: string[] = [];
  const active = ["running", "queued"].includes(task?.state ?? record.status);
  const currentProgress =
    detail?.task.updatedAt === task?.updatedAt && detail?.task.state === task?.state
      ? detail?.progress?.stage
      : undefined;
  const stage = currentProgress ?? (record.detail ? undefined : record.stage);
  if (active && stage && stageLabel(stage, text) !== stageLabel(undefined, text))
    metadata.push(text("阶段：", "Stage: ") + stageLabel(stage, text));
  const checkpoint = detail?.checkpoint?.taskId === task?.id ? detail?.checkpoint : undefined;
  const header = detail?.latestReport ?? record.header;
  const boundHeader =
    task &&
    task.latestReportRef &&
    header?.context.task.id === task.id &&
    header.context.repository.id === record.repositoryId &&
    header.context.workItem.id === record.workItemId &&
    header.id === task.latestReportRef.id &&
    header.version === task.latestReportRef.version &&
    header.report.logicalContentDigest === task.latestReportRef.digest
      ? header
      : undefined;
  const durationMs =
    checkpoint?.consumed.durationMs ?? boundHeader?.report.loop.consumed.durationMs;
  if (durationMs !== undefined && Number.isSafeInteger(durationMs) && durationMs >= 0)
    metadata.push(text("已记录执行：", "Recorded execution: ") + formatDuration(durationMs));
  return metadata;
}

export function selectRelatedActivity(
  record: ReviewRecord,
  busy: boolean,
  onSelect: (record: ReviewRecord) => void,
): void {
  if (!busy && record.taskId) onSelect(record);
}

const english: ConsoleText = (_zh, en) => en;

export function RelatedActivitiesView({
  records,
  selectedTaskId,
  view,
  busy,
  onSelect,
  onViewChange,
  text = english,
  language = "en",
}: RelatedActivitiesViewProps) {
  const activities = orderRelatedActivities(projectRelatedActivities(records), view);
  return (
    <section className="rc-related-activities" aria-label={text("关联活动", "Related activities")}>
      <div className="rc-activities-heading">
        <h2>
          {text("关联活动", "Related activities")}
          <span className="rc-activities-count">{activities.length}</span>
        </h2>
        <fieldset className="rc-activities-views" aria-label={text("活动视图", "Activity view")}>
          {(
            [
              ["list", "view_list", text("列表", "List")],
              ["timeline", "timeline", text("时间线", "Timeline")],
            ] as const
          ).map(([value, icon, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={view === value}
              onClick={() => onViewChange(value)}
            >
              <ConsoleIcon name={icon} size={18} />
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      {view === "timeline" && (
        <p className="rc-activities-note">
          {text("按记录时间查看各项独立活动。", "Browse independent activities by recorded time.")}
        </p>
      )}
      {busy && (
        <p className="rc-activities-note" role="status">
          {text(
            "当前操作完成后可选择其他活动。",
            "Choose another activity after the current operation finishes.",
          )}
        </p>
      )}
      <ol className={`rc-activities-rows rc-activities-${view}`}>
        {activities.map((activity) => {
          const task = boundTask(activity);
          const status = relatedActivityStatus(activity, text);
          const selected = !!activity.taskId && activity.taskId === selectedTaskId;
          const time = relatedActivityTime(activity);
          const metadata = relatedActivityMetadata(activity, text);
          const publicationWarning = relatedActivityPublicationWarning(activity, text);
          return (
            <li key={relatedActivityKey(activity)}>
              <button
                type="button"
                className="rc-activity-row"
                data-task-id={activity.taskId}
                data-task-state={task?.state ?? activity.status}
                aria-pressed={selected}
                aria-current={selected ? "true" : undefined}
                disabled={busy || !activity.taskId}
                onClick={() => selectRelatedActivity(activity, busy, onSelect)}
              >
                <span className="rc-activity-primary">
                  <span className="rc-activity-name">
                    {relatedWorkLabel({ ...activity, task }, text)}
                  </span>
                  {selected && (
                    <span className="rc-activity-selected">
                      <ConsoleIcon name="visibility" size={16} />
                      {text("正在查看", "Viewing")}
                    </span>
                  )}
                  <span className={`rc-activity-state rc-activity-${status.tone}`}>
                    <ConsoleIcon name={status.icon} size={16} />
                    {status.label}
                  </span>
                </span>
                <span className="rc-activity-time">
                  {time.kind === "unknown" ? (
                    text("时间未记录", "Time unknown")
                  ) : (
                    <>
                      {time.kind === "created"
                        ? text("创建于 ", "Created ")
                        : text("更新于 ", "Updated ")}
                      <time dateTime={time.value}>
                        {new Date(time.milliseconds!).toLocaleString(
                          language === "zh" ? "zh-CN" : "en-US",
                          {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          },
                        )}
                      </time>
                    </>
                  )}
                </span>
                <span className="rc-activity-identity">
                  {text("活动 ID：", "Activity ID: ")}
                  <code>{activity.taskId ?? activity.id}</code>
                </span>
                {(metadata.length > 0 || publicationWarning) && (
                  <span className="rc-activity-metadata">
                    {metadata.map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                    {publicationWarning && (
                      <span className="rc-activity-publication-warning">
                        <ConsoleIcon name="cloud_off" size={16} />
                        {publicationWarning}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {activities.length === 0 && (
        <p className="rc-activities-note">{text("暂无关联活动。", "No related activities.")}</p>
      )}
    </section>
  );
}

export function RelatedActivities(props: RelatedActivitiesProps) {
  const [view, setView] = useState<RelatedActivityView>("list");
  const { text, language } = useConsolePreferences();
  return (
    <RelatedActivitiesView
      {...props}
      records={projectRelatedActivities(props.records, props.selectedRecord)}
      view={view}
      onViewChange={setView}
      text={text}
      language={language}
    />
  );
}
