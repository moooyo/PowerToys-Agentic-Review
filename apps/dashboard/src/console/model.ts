import type {
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
  InvestigationGitHubUser,
  InvestigationReportHeaderV1,
  InvestigationSchedulerStatus,
  InvestigationTaskV1,
  InvestigationWebhookDelivery,
} from "@agentic-review/contracts";
import { investigationApi, type TaskDetail, type WorkItem } from "../investigation/api";
import {
  emptyTaskOutput,
  mergeTaskOutput,
  selectedTaskAttempt,
  type TaskOutputState,
} from "../investigation/task-output-state";

export type ConsoleText = (zh: string, en: string) => string;
export type ReviewStatus = "attention" | "running" | "queued" | "publishing" | "posted";
export type ReviewProblemType = "upload" | "review" | "worker" | "intake" | "stopped";

export interface ReviewRecord {
  id: string;
  workItemId: string;
  repositoryId: string;
  repositoryFullName: string;
  taskId?: string;
  kind: "pr" | "issue";
  number: number;
  title: string;
  author?: InvestigationGitHubUser;
  area: string;
  updatedAt: string;
  status: ReviewStatus;
  problem?: { type: ReviewProblemType; code: string; message: string; hint: string };
  stage?: string;
  startedAt?: string;
  summary?: string;
  lastOutput?: string;
  lastOutputKind?: "assistant" | "tool" | "system" | "gap";
  lastOutputAt?: string;
  task?: InvestigationTaskV1;
  detail?: TaskDetail;
  header?: InvestigationReportHeaderV1;
  publication?: InvestigationCommentPublicationSummary;
  progressPublication?: InvestigationCommentPublicationSummary;
  currentPublication?: InvestigationCommentPublicationSummary;
  webhook?: InvestigationWebhookDelivery;
  queueReason?: "capacity" | "worker" | "unknown";
  occupied?: number;
  concurrency?: number;
  readWarning?: string;
  relatedWork?: ReviewRecord[];
  currentWorkId?: string;
  completedWithoutPublication?: boolean;
  historicalPublication?: InvestigationCommentDelivery;
}

const stages: Record<string, [string, string]> = {
  prepare_source: ["准备源码", "Preparing source"],
  model: ["模型分析", "Model analysis"],
  validate_result: ["校验结果", "Validating result"],
  save_checkpoint: ["保存进度", "Saving progress"],
  build_report: ["生成报告", "Building report"],
  upload_evidence: ["上传证据", "Uploading evidence"],
  cleanup: ["清理", "Cleaning up"],
};

export function stageLabel(stage: string | undefined, text: ConsoleText): string {
  const value = stage ? stages[stage] : undefined;
  return value ? text(value[0], value[1]) : text("等待阶段信息", "Waiting for stage information");
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function relativeTime(timestamp: string, text: ConsoleText, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return text(`${seconds} 秒前`, `${seconds}s ago`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return text(`${minutes} 分钟前`, `${minutes}m ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text(`${hours} 小时前`, `${hours}h ago`);
  return text(`${Math.floor(hours / 24)} 天前`, `${Math.floor(hours / 24)}d ago`);
}

export function problemLabel(type: ReviewProblemType | undefined, text: ConsoleText): string {
  switch (type) {
    case "upload":
      return text("发布失败", "Publication failed");
    case "review":
      return text("Review 失败", "Review failed");
    case "worker":
      return text("Worker 失联", "Worker disconnected");
    case "intake":
      return text("接收失败", "Intake failed");
    case "stopped":
      return text("已停止", "Stopped");
    default:
      return text("需要处理", "Needs attention");
  }
}

export function triggerLabel(
  delivery: InvestigationWebhookDelivery | undefined,
  text: ConsoleText,
): string {
  if (!delivery) return text("触发方式未记录", "Trigger not recorded");
  const labels = {
    assignment: text("分配触发", "Assignment"),
    review_request: text("Review 请求", "Review request"),
    review_rerequest: text("重新请求 Review", "Review re-request"),
    e2e_command: text("E2E 命令", "E2E command"),
    e2e_revision: text("E2E 提交更新", "E2E revision update"),
  };
  return `${delivery.triggerKind ? labels[delivery.triggerKind] : delivery.mode === "e2e" ? text("E2E 命令", "E2E command") : text("Review 请求或分配", "Review request or assignment")} · ${delivery.actorLogin ? `@${delivery.actorLogin}` : `ID ${delivery.actorUserId}`}`;
}

export function problemMessage(record: ReviewRecord, text: ConsoleText): string {
  if (record.problem?.type === "stopped")
    return record.detail?.checkpoint
      ? text(
          "Review 已停止，已保存的进度仍可使用。",
          "Review was stopped. Saved progress remains available.",
        )
      : text("Review 已停止，尚未保存进度。", "Review was stopped before progress was saved.");
  return record.problem?.message ?? "";
}

export function problemHint(record: ReviewRecord, text: ConsoleText): string {
  if (record.problem?.type === "stopped")
    return record.detail?.checkpoint
      ? text("可以从已保存的进度继续。", "Continue from the saved progress.")
      : text(
          "重新开始会使用这次 Review 的原始来源。",
          "Restart using this Review's original source.",
        );
  if (record.problem?.type === "upload")
    return text(
      "检查自动回复设置和当前评论状态。",
      "Check automatic reply settings and the current comment state.",
    );
  if (record.problem?.type === "intake")
    return text(
      "解决接收问题后重新接收原始事件。",
      "Resolve the intake failure before receiving the original event again.",
    );
  return text("解决所记录的问题后重试。", "Resolve the recorded failure before retrying.");
}

export function assertReviewDetailBinding(task: InvestigationTaskV1, detail: TaskDetail): void {
  if (
    detail.task.id !== task.id ||
    detail.task.repository.id !== task.repository.id ||
    detail.task.workItem.id !== task.workItem.id ||
    detail.task.workItem.kind !== task.workItem.kind ||
    detail.task.workItem.number !== task.workItem.number
  )
    throw new Error("Task detail belongs to another review record.");
}

export function relatedWorkLabel(record: ReviewRecord, text: ConsoleText): string {
  switch (record.task?.kind) {
    case "pr-review":
    case "issue-investigate":
      return "Review";
    case "pr-e2e":
      return "E2E";
    case "reproduction-setup":
      return text("复现", "Reproduction");
    case "issue-verify":
      return text("复现验证", "Reproduction verification");
    case "pr-verify":
      return text("补丁验证", "Patch verification");
    case "issue-fix":
      return text("修复", "Fix");
    case "feature-implement":
      return text("功能实现", "Implementation");
    default:
      return "Review";
  }
}

export function reportConclusion(
  header: InvestigationReportHeaderV1 | undefined,
  text: ConsoleText,
): string {
  const assessment = header?.assessment;
  if (!assessment) return text("报告尚未生成", "No report yet");
  if (assessment.kind === "pr") {
    switch (assessment.reviewConclusion.status) {
      case "changes-requested":
        return text("需要修改", "Changes requested");
      case "no-blocking-findings":
        return text("没有阻塞问题", "No blocking findings");
      case "inconclusive":
        return text("结论不确定", "Inconclusive");
    }
  }
  if (assessment.kind === "bug") {
    const labels: Record<typeof assessment.bugAssessment.status, [string, string]> = {
      confirmed: ["Bug · 已确认", "Bug · Confirmed"],
      needs_information: ["Bug · 需要信息", "Bug · Needs information"],
      needs_verification: ["Bug · 待验证", "Bug · Needs verification"],
      already_fixed: ["Bug · 已修复", "Bug · Already fixed"],
      duplicate: ["Bug · 重复", "Bug · Duplicate"],
      not_a_bug: ["非 Bug", "Not a bug"],
    };
    return text(...labels[assessment.bugAssessment.status]);
  }
  if (assessment.kind === "feature") {
    const labels: Record<typeof assessment.featureAssessment.status, [string, string]> = {
      ready: ["功能建议 · 可实施", "Feature · Ready"],
      needs_information: ["功能建议 · 需要信息", "Feature · Needs information"],
      needs_decision: ["功能建议 · 待决定", "Feature · Needs decision"],
      already_supported: ["功能建议 · 已支持", "Feature · Already supported"],
      duplicate: ["功能建议 · 重复", "Feature · Duplicate"],
      not_feasible: ["功能建议 · 不可行", "Feature · Not feasible"],
    };
    return text(...labels[assessment.featureAssessment.status]);
  }
  return assessment.classification;
}

export function recordStatusLabel(
  record: ReviewRecord,
  text: ConsoleText,
  now = Date.now(),
): string {
  if (record.status === "attention")
    if (record.completedWithoutPublication)
      return text("Review 已完成 · 发布状态未确认", "Review completed · Publication unconfirmed");
  if (record.status === "attention")
    return `${problemLabel(record.problem?.type, text)} · ${problemMessage(record, text)}`;
  if (record.status === "running")
    return `${stageLabel(record.stage, text)}${record.startedAt ? ` · ${formatDuration(now - Date.parse(record.startedAt))}` : ""}`;
  if (record.status === "publishing") return text("正在发布", "Publishing");
  if (record.status === "queued") {
    if (record.queueReason === "capacity")
      return text(
        `等待并发位 · ${record.occupied} / ${record.concurrency} 已占用`,
        `Waiting for capacity · ${record.occupied} / ${record.concurrency} occupied`,
      );
    if (record.queueReason === "worker")
      return text("等待空闲 Worker", "Waiting for a free Worker");
    return text("等待调度", "Waiting for scheduling");
  }
  const conclusion = reportConclusion(record.header, text);
  return record.kind === "pr" && record.header
    ? `${conclusion} · ${text(`${record.header.report.collections.findings} 个问题`, `${record.header.report.collections.findings} findings`)}`
    : conclusion;
}

function publicationMatches(
  task: InvestigationTaskV1,
  publication: InvestigationCommentPublicationSummary,
): boolean {
  return (
    publication.repositoryId === task.repository.id &&
    publication.workItemId === task.workItem.id &&
    publication.workItemKind === task.workItem.kind &&
    publication.workItemNumber === task.workItem.number &&
    (publication.taskId === task.id || publication.associatedTaskIds?.includes(task.id) === true)
  );
}

export function mapReviewTask(
  task: InvestigationTaskV1,
  detail?: TaskDetail,
  publications: readonly InvestigationCommentPublicationSummary[] = [],
  scheduler?: InvestigationSchedulerStatus,
  webhook?: InvestigationWebhookDelivery,
): ReviewRecord {
  if (detail) assertReviewDetailBinding(task, detail);
  const header = detail?.latestReport ?? undefined;
  if (
    header &&
    (header.context.task.id !== task.id ||
      header.context.repository.id !== task.repository.id ||
      header.context.workItem.id !== task.workItem.id)
  ) {
    throw new Error("Report belongs to another review record.");
  }
  if (
    header &&
    (!task.latestReportRef ||
      header.id !== task.latestReportRef.id ||
      header.version !== task.latestReportRef.version ||
      header.report.logicalContentDigest !== task.latestReportRef.digest)
  ) {
    throw new Error("Report does not match the review record's current saved report.");
  }
  const comments = publications
    .filter((entry) => publicationMatches(task, entry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const publication = comments.find(
    (entry) => !!task.latestReportRef && entry.reportId === task.latestReportRef.id,
  );
  const progressPublication = comments.find((entry) => entry.mode === "progress");
  const currentPublication = publications
    .filter(
      (entry) =>
        entry.mode === "progress" &&
        entry.repositoryId === task.repository.id &&
        entry.workItemId === task.workItem.id &&
        entry.workItemKind === task.workItem.kind &&
        entry.workItemNumber === task.workItem.number &&
        (entry.producerTaskKind === undefined
          ? publicationMatches(task, entry)
          : (entry.producerTaskKind === "pr-e2e") === (task.kind === "pr-e2e")),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const attempt = detail?.attempts
    .filter((entry) => entry.taskId === task.id)
    .sort((left, right) => right.number - left.number)[0];
  const record: ReviewRecord = {
    id: task.id,
    taskId: task.id,
    workItemId: task.workItem.id,
    repositoryId: task.repository.id,
    repositoryFullName: task.repository.fullName,
    kind: task.workItem.kind === "pull_request" ? "pr" : "issue",
    number: task.workItem.number,
    title: task.workItem.title,
    area: "",
    updatedAt:
      publication && publication.updatedAt > task.updatedAt
        ? publication.updatedAt
        : task.updatedAt,
    status: task.state === "running" ? "running" : task.state === "queued" ? "queued" : "attention",
    ...(detail?.progress?.stage ? { stage: detail.progress.stage } : {}),
    ...(attempt?.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(header ? { header, summary: header.report.summary } : {}),
    task,
    detail,
    publication,
    progressPublication,
    currentPublication,
    webhook,
  };
  if (task.state === "queued") {
    const e2e = task.kind === "pr-e2e";
    record.occupied = e2e ? scheduler?.occupiedE2e : scheduler?.occupiedStatic;
    record.concurrency = e2e ? scheduler?.e2eConcurrency : scheduler?.staticConcurrency;
    record.queueReason =
      record.occupied !== undefined &&
      record.concurrency !== undefined &&
      record.occupied >= record.concurrency
        ? "capacity"
        : "unknown";
  } else if (task.state === "completed") {
    if (publication?.state === "synced" && publication.externalId && publication.lastConfirmedAt)
      record.status = "posted";
    else if (publication && ["pending", "sending", "retrying"].includes(publication.state))
      record.status = "publishing";
    else if (!publication) {
      record.completedWithoutPublication = true;
      record.readWarning =
        "The saved report is complete, but its publication state has not been confirmed.";
    } else
      record.problem = {
        type: "upload",
        code: publication?.reasonCode ?? "report_not_published",
        message:
          publication?.reason ?? "The saved report has not been confirmed as published on GitHub.",
        hint: "Check automatic reply settings and the current comment state.",
      };
  } else if (task.state !== "running") {
    const reason = attempt?.terminationReason ?? task.state;
    const stopped = task.state === "cancelled";
    const worker =
      !stopped &&
      /heartbeat|worker.*(?:offline|disconnect|lost)|lease.*(?:expire|lost)/i.test(reason);
    record.problem = {
      type: stopped ? "stopped" : worker ? "worker" : "review",
      code: stopped ? "cancelled" : reason,
      message: stopped
        ? detail?.checkpoint
          ? "Review was stopped. Saved progress remains available."
          : "Review was stopped before progress was saved."
        : reason,
      hint: stopped
        ? detail?.checkpoint
          ? "Continue from the saved progress."
          : "Restart using this Review's original source."
        : "Resolve the recorded failure before retrying.",
    };
  }
  return record;
}

export function mapIntakeFailure(
  delivery: InvestigationWebhookDelivery,
  item?: WorkItem,
): ReviewRecord {
  return {
    id: `intake:${delivery.deliveryId}`,
    workItemId: item?.id ?? "",
    repositoryId: delivery.repositoryId,
    repositoryFullName: delivery.repositoryFullName,
    kind: delivery.kind === "pull_request" ? "pr" : "issue",
    number: delivery.number,
    title:
      item?.title ?? `${delivery.kind === "pull_request" ? "PR" : "Issue"} #${delivery.number}`,
    ...(item?.author ? { author: item.author } : {}),
    area: "",
    updatedAt: delivery.attemptHistory.at(-1)?.finishedAt ?? delivery.receivedAt,
    status: "attention",
    problem: {
      type: "intake",
      code: delivery.reason ?? "intake_failed",
      message: delivery.reason ?? "The assignment event could not be received.",
      hint: "Retry receiving the original event after resolving the failure.",
    },
    webhook: delivery,
  };
}

let detailCacheIdentity: string | undefined;
const stableTaskDetails = new Map<string, { updatedAt: string; detail: TaskDetail }>();
const runningOutput = new Map<string, TaskOutputState>();
const historicalDeliveries = new Map<
  string,
  { checkedAt: number; receipt?: InvestigationCommentDelivery }
>();

async function readPublications(repositoryId?: string, signal?: AbortSignal) {
  const items: InvestigationCommentPublicationSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await investigationApi.publicationDirectory(
      { repositoryId, cursor, limit: 50 },
      signal,
    );
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("The publication cursor did not advance.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items };
}

const deliverySnapshots = new Map<
  string,
  { checkedAt: number; items: InvestigationWebhookDelivery[] }
>();

async function readIntakeFailures(repositoryId?: string, signal?: AbortSignal, identity?: string) {
  const cacheKey = `${identity ?? ""}:${repositoryId ?? ""}`;
  const snapshot = identity ? deliverySnapshots.get(cacheKey) : undefined;
  if (snapshot && Date.now() - snapshot.checkedAt < 15_000) return { items: snapshot.items };
  const items: InvestigationWebhookDelivery[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await investigationApi.webhookDeliveries({
      repositoryId,
      cursor,
      limit: 50,
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("The webhook cursor did not advance.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (identity && detailCacheIdentity === identity)
    deliverySnapshots.set(cacheKey, { checkedAt: Date.now(), items });
  return { items };
}

async function readTaskDetails(
  tasks: InvestigationTaskV1[],
  signal?: AbortSignal,
  identity?: string,
): Promise<PromiseSettledResult<TaskDetail>[]> {
  if (identity !== detailCacheIdentity) {
    stableTaskDetails.clear();
    runningOutput.clear();
    deliverySnapshots.clear();
    historicalDeliveries.clear();
    detailCacheIdentity = identity;
  }
  const results: PromiseSettledResult<TaskDetail>[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(6, tasks.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      const task = tasks[index];
      if (!task) return;
      try {
        signal?.throwIfAborted();
        const cached = identity ? stableTaskDetails.get(task.id) : undefined;
        const detail =
          cached?.updatedAt === task.updatedAt
            ? cached.detail
            : await investigationApi.task(task.id, signal);
        assertReviewDetailBinding(task, detail);
        if (detailCacheIdentity === identity) {
          if (
            identity &&
            !["running", "queued"].includes(detail.task.state) &&
            !detail.resourceLeases?.some((lease) => lease.state !== "released")
          )
            stableTaskDetails.set(task.id, { updatedAt: detail.task.updatedAt, detail });
          else stableTaskDetails.delete(task.id);
        }
        results[index] = { status: "fulfilled", value: detail };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  const currentIds = new Set(tasks.map((task) => task.id));
  for (const id of stableTaskDetails.keys()) if (!currentIds.has(id)) stableTaskDetails.delete(id);
  return results;
}

export function applyHistoricalPublication(
  record: ReviewRecord,
  deliveries: InvestigationCommentDelivery[],
): ReviewRecord {
  const reportId = record.task?.latestReportRef?.id;
  if (record.task?.state !== "completed" || !reportId || record.publication) return record;
  const receipt = deliveries
    .filter(
      (entry) =>
        entry.taskId === record.taskId &&
        entry.reportId === reportId &&
        entry.repositoryId === record.repositoryId &&
        entry.workItemId === record.workItemId &&
        entry.workItemKind === (record.kind === "pr" ? "pull_request" : "issue") &&
        entry.workItemNumber === record.number &&
        entry.state === "succeeded" &&
        entry.effect === "applied" &&
        !!entry.externalId,
    )
    .sort((left, right) =>
      (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt),
    )[0];
  return receipt
    ? {
        ...record,
        status: "posted",
        problem: undefined,
        completedWithoutPublication: false,
        readWarning: undefined,
        historicalPublication: receipt,
        updatedAt: receipt.finishedAt ?? receipt.startedAt,
      }
    : record;
}

async function readHistoricalPublications(
  records: ReviewRecord[],
  signal?: AbortSignal,
  identity?: string,
) {
  const completed = records.filter(
    (record) =>
      record.task?.state === "completed" && !record.publication && record.task.latestReportRef,
  );
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, completed.length) }, async () => {
      for (;;) {
        const record = completed[nextIndex++];
        if (!record?.taskId) return;
        const key = `${record.taskId}:${record.task?.latestReportRef?.id}`;
        const saved = identity ? historicalDeliveries.get(key) : undefined;
        if (saved && (saved.receipt || Date.now() - saved.checkedAt < 15_000)) {
          if (saved.receipt)
            Object.assign(record, applyHistoricalPublication(record, [saved.receipt]));
          continue;
        }
        try {
          const deliveries: InvestigationCommentDelivery[] = [];
          const seen = new Set<string>();
          let cursor: string | undefined;
          do {
            signal?.throwIfAborted();
            const page = await investigationApi.commentDeliveries({
              taskId: record.taskId,
              repositoryId: record.repositoryId,
              cursor,
              limit: 50,
            });
            deliveries.push(...page.items);
            cursor = page.nextCursor ?? undefined;
            if (cursor && seen.has(cursor))
              throw new Error("The historical comment cursor did not advance.");
            if (cursor) seen.add(cursor);
          } while (cursor);
          signal?.throwIfAborted();
          Object.assign(record, applyHistoricalPublication(record, deliveries));
          if (identity && detailCacheIdentity === identity)
            historicalDeliveries.set(key, {
              checkedAt: Date.now(),
              receipt: record.historicalPublication,
            });
        } catch {
          record.readWarning = "Historical publication receipts could not be read.";
        }
      }
    }),
  );
}

export function invalidateReviewRecordCache(): void {
  deliverySnapshots.clear();
  historicalDeliveries.clear();
}

async function readRunningOutput(
  records: ReviewRecord[],
  signal?: AbortSignal,
  identity?: string,
): Promise<void> {
  const live = records.filter(
    (record) => record.status === "running" && record.taskId && record.detail,
  );
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, live.length) }, async () => {
      for (;;) {
        const record = live[nextIndex++];
        if (!record?.taskId || !record.detail) return;
        const attempt = selectedTaskAttempt(record.taskId, record.detail.attempts);
        if (!attempt) continue;
        const key = `${record.taskId}:${attempt.id}`;
        try {
          const previous = identity ? runningOutput.get(key) : undefined;
          const state = previous ?? emptyTaskOutput(record.taskId, attempt.id);
          const page = await investigationApi.taskOutput(
            record.taskId,
            { attemptId: attempt.id, after: state.cursor, limit: 200 },
            signal,
          );
          signal?.throwIfAborted();
          const output = mergeTaskOutput(state, page);
          if (identity && detailCacheIdentity === identity) runningOutput.set(key, output);
          if (output.hasMore) continue;
          const latest = [...output.items].sort(
            (left, right) => right.producerSequence - left.producerSequence,
          )[0];
          if (latest) {
            record.lastOutput =
              latest.kind === "tool" ? (latest.command ?? latest.text) : latest.text;
            record.lastOutputKind = latest.kind;
            record.lastOutputAt = latest.observedAt;
          }
        } catch {
          runningOutput.delete(key);
        }
      }
    }),
  );
  const liveIds = new Set(live.map((record) => record.taskId));
  for (const [key, value] of runningOutput)
    if (!liveIds.has(value.taskId)) runningOutput.delete(key);
}

export function aggregateRelatedWork(
  root: ReviewRecord,
  descendants: ReviewRecord[],
): ReviewRecord {
  if (!descendants.length) return root;
  const related = [root, ...descendants].map((record) => {
    if (record.id === root.id || record.task?.state !== "completed" || record.publication)
      return record;
    return { ...record, problem: undefined, completedWithoutPublication: true };
  });
  const latestKinds = new Map<string, ReviewRecord>();
  for (const record of [...related].sort((left, right) =>
    (left.task?.createdAt ?? left.updatedAt).localeCompare(
      right.task?.createdAt ?? right.updatedAt,
    ),
  ))
    latestKinds.set(record.task?.kind ?? record.id, record);
  const current = [...latestKinds.values()];
  const selected =
    current.find(
      (record) => record.status === "attention" && !record.completedWithoutPublication,
    ) ??
    current.find((record) => record.status === "running") ??
    current.find((record) => record.status === "publishing") ??
    current.find((record) => record.status === "queued") ??
    root;
  return { ...selected, id: root.id, relatedWork: related, currentWorkId: selected.taskId };
}

export async function loadReviewRecords(
  repositoryId?: string,
  signal?: AbortSignal,
  identity?: string,
): Promise<ReviewRecord[]> {
  if (identity !== detailCacheIdentity) {
    stableTaskDetails.clear();
    runningOutput.clear();
    deliverySnapshots.clear();
    historicalDeliveries.clear();
    detailCacheIdentity = identity;
  }
  const [tasksResponse, itemsResponse, commentsResponse, schedulerResponse, deliveriesResponse] =
    await Promise.allSettled([
      investigationApi.tasks(undefined, signal),
      investigationApi.workItems(repositoryId),
      readPublications(repositoryId, signal),
      investigationApi.scheduler(),
      readIntakeFailures(repositoryId, signal, identity),
    ]);
  signal?.throwIfAborted();
  if (tasksResponse.status === "rejected") throw tasksResponse.reason;
  const tasks = tasksResponse.value.items.filter(
    (task) => !repositoryId || task.repository.id === repositoryId,
  );
  const details = await readTaskDetails(tasks, signal, identity);
  signal?.throwIfAborted();
  const publications = commentsResponse.status === "fulfilled" ? commentsResponse.value.items : [];
  const scheduler = schedulerResponse.status === "fulfilled" ? schedulerResponse.value : undefined;
  const deliveries =
    deliveriesResponse.status === "fulfilled" ? deliveriesResponse.value.items : [];
  const items = itemsResponse.status === "fulfilled" ? itemsResponse.value.items : [];
  const taskRecords = tasks.map((task, index) => {
    const detail = details[index];
    const record = mapReviewTask(
      detail?.status === "fulfilled" ? detail.value.task : task,
      detail?.status === "fulfilled" ? detail.value : undefined,
      publications,
      scheduler,
      deliveries.find(
        (entry) =>
          entry.taskId === task.id &&
          entry.canonicalDeliveryId === entry.deliveryId &&
          entry.repositoryId === task.repository.id &&
          entry.kind === task.workItem.kind &&
          entry.number === task.workItem.number &&
          entry.triggerKind !== "e2e_revision" &&
          !["active_e2e_revision", "revision_observed"].includes(entry.reason ?? ""),
      ),
    );
    const item = items.find(
      (item) => item.id === task.workItem.id && item.repositoryId === task.repository.id,
    );
    if (item?.author) record.author = item.author;
    if (detail?.status === "rejected" || commentsResponse.status === "rejected") {
      record.readWarning =
        "Some review details are unavailable. Refresh to check the current state.";
      if (task.state === "completed" && commentsResponse.status === "rejected")
        record.problem = {
          type: "upload",
          code: "publication_state_unavailable",
          message: "The publication state could not be read.",
          hint: "Refresh before taking a publication action.",
        };
    }
    return record;
  });
  await readRunningOutput(taskRecords, signal, identity);
  await readHistoricalPublications(taskRecords, signal, identity);
  signal?.throwIfAborted();
  const byId = new Map(taskRecords.map((record) => [record.taskId, record]));
  const rootId = (record: ReviewRecord): string | undefined => {
    const seen = new Set<string>();
    let current: ReviewRecord | undefined = record;
    while (current?.task?.parentTaskId) {
      if (seen.has(current.task.id)) return undefined;
      seen.add(current.task.id);
      current = byId.get(current.task.parentTaskId);
    }
    return current?.id;
  };
  const records = taskRecords
    .filter((record) => record.task?.parentTaskId === null)
    .map((root) =>
      aggregateRelatedWork(
        root,
        taskRecords.filter((record) => record.id !== root.id && rootId(record) === root.id),
      ),
    );
  for (const delivery of deliveries) {
    if (
      delivery.state !== "failed" ||
      delivery.taskId ||
      delivery.canonicalDeliveryId !== delivery.deliveryId
    )
      continue;
    records.push(
      mapIntakeFailure(
        delivery,
        items.find(
          (item) =>
            item.repositoryId === delivery.repositoryId &&
            item.kind === delivery.kind &&
            item.number === delivery.number,
        ),
      ),
    );
  }
  return records.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
  );
}
