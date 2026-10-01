import type {
  InvestigationCommentDelivery,
  InvestigationFindingV1,
} from "@agentic-review/contracts";
import { Dialog, Snackbar } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { investigationApi } from "../investigation/api";
import {
  canScheduleCommentAction,
  commentCommandQueryKey,
  type RetainedCommentCommand,
  scheduleCommentCommand,
} from "../investigation/comment-publication-state";
import { sessionIdentity, useInvestigationSession } from "../investigation/session";
import { outputAccessDenied } from "../investigation/task-output";
import {
  emptyTaskOutput,
  latestAttemptInvocation,
  mergeTaskOutput,
  type OutputItem,
  selectedTaskAttempt,
  type TaskOutputState,
} from "../investigation/task-output-state";
import {
  applyHistoricalPublication,
  assertReviewDetailBinding,
  type ConsoleText,
  formatDuration,
  invalidateReviewRecordCache,
  mapReviewTask,
  problemHint,
  problemLabel,
  problemMessage,
  type ReviewRecord,
  recordStatusLabel,
  relatedWorkLabel,
  relativeTime,
  reportConclusion,
  setReviewRecordIgnored,
  stageLabel,
  triggerLabel,
} from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./record-detail.css";

interface Props {
  record: ReviewRecord;
  onRefresh: () => void;
  onSettings: (section: string) => void;
}

function Spinner({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`rc-detail-spinner${small ? " rc-detail-spinner-small" : ""}`}
      aria-hidden="true"
    />
  );
}

function DetailButton({
  icon,
  children,
  filled = false,
  outlined = false,
  ...props
}: {
  icon?: string;
  children: ReactNode;
  filled?: boolean;
  outlined?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`rc-detail-button${filled ? " rc-detail-button-filled" : ""}${outlined ? " rc-detail-button-outlined" : ""}`}
      {...props}
    >
      {icon && <ConsoleIcon name={icon} size={18} />}
      {children}
    </button>
  );
}

function EmptyPanel({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="rc-detail-empty">
      <ConsoleIcon name={icon} size={32} />
      <p>{children}</p>
    </div>
  );
}

function clock(timestamp: string, language: "zh" | "en") {
  return new Date(timestamp).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function safeGithubUrl(record: ReviewRecord): string | undefined {
  if (
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(record.repositoryFullName) ||
    !Number.isSafeInteger(record.number) ||
    record.number < 1
  )
    return undefined;
  return `https://github.com/${record.repositoryFullName}/${record.kind === "pr" ? "pull" : "issues"}/${record.number}`;
}

function safeCommentUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function useReviewOutput(record: ReviewRecord, identity: string) {
  const attempt =
    record.taskId && record.detail
      ? selectedTaskAttempt(record.taskId, record.detail.attempts)
      : undefined;
  const taskId = record.taskId ?? "";
  const attemptId = attempt?.id ?? "";
  const [state, setState] = useState<TaskOutputState>(() => emptyTaskOutput(taskId, attemptId));
  const retained = useRef(state);
  const quiet = useRef(0);
  const active = attempt !== undefined && ["queued", "leased", "running"].includes(attempt.state);
  useEffect(() => {
    const empty = emptyTaskOutput(taskId, attemptId);
    retained.current = empty;
    setState(empty);
    quiet.current = 0;
  }, [taskId, attemptId]);
  const query = useQuery<TaskOutputState>({
    queryKey: ["console-review-output", identity, taskId, attemptId],
    enabled: (current) => !!taskId && !!attemptId && !outputAccessDenied(current.state.error),
    queryFn: async ({ signal }) => {
      const previous =
        retained.current.taskId === taskId && retained.current.attemptId === attemptId
          ? retained.current
          : emptyTaskOutput(taskId, attemptId);
      const page = await investigationApi.taskOutput(
        taskId,
        { attemptId, after: previous.cursor, limit: 200 },
        signal,
      );
      signal.throwIfAborted();
      const next = mergeTaskOutput(previous, page);
      retained.current = next;
      quiet.current = page.items.length === 0 && !page.nextCursor ? quiet.current + 1 : 0;
      return next;
    },
    refetchInterval: (current) => {
      if (outputAccessDenied(current.state.error) || current.state.errorUpdateCount >= 3)
        return false;
      if (current.state.error) return 5_000;
      if (current.state.data?.hasMore) return 100;
      return active || quiet.current < 3 ? 1_500 : false;
    },
    retry: false,
    gcTime: 0,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (current) => !outputAccessDenied(current.state.error),
    refetchOnReconnect: (current) => !outputAccessDenied(current.state.error),
  });
  useEffect(() => {
    if (query.data) setState(query.data);
  }, [query.data]);
  useEffect(() => {
    if (!outputAccessDenied(query.error)) return;
    const empty = emptyTaskOutput(taskId, attemptId);
    retained.current = empty;
    setState(empty);
  }, [query.error, taskId, attemptId]);
  return {
    state: outputAccessDenied(query.error) ? emptyTaskOutput(taskId, attemptId) : state,
    query,
    attempt,
  };
}

function Workflow({ record, now, text }: { record: ReviewRecord; now: number; text: ConsoleText }) {
  const intakeFailed = record.problem?.type === "intake";
  const reviewFailed =
    record.problem && ["review", "worker", "stopped"].includes(record.problem.type);
  const reviewComplete = record.task?.state === "completed";
  const trigger = triggerLabel(record.webhook, text);
  const duration = record.startedAt
    ? formatDuration(now - Date.parse(record.startedAt))
    : undefined;
  const steps: {
    label: string;
    description: string;
    state: "done" | "failed" | "paused" | "active" | "pending";
  }[] = [
    {
      label: text("触发", "Trigger"),
      description: intakeFailed
        ? `${text("接收失败", "Intake failed")} · ${record.problem?.code}`
        : trigger,
      state: intakeFailed ? "failed" : "done",
    },
    {
      label: "Review",
      description: reviewComplete
        ? text("Review 已完成", "Review completed")
        : record.status === "running"
          ? `${stageLabel(record.stage, text)}${duration ? ` · ${duration}` : ""}`
          : record.status === "queued"
            ? text("排队中", "Queued")
            : reviewFailed
              ? `${problemLabel(record.problem?.type, text)}${record.header ? ` · ${formatDuration(record.header.report.loop.consumed.durationMs)}` : ""}`
              : "",
      state: intakeFailed
        ? "pending"
        : reviewComplete
          ? "done"
          : record.problem?.type === "stopped"
            ? "paused"
            : reviewFailed
              ? "failed"
              : record.status === "running"
                ? "active"
                : "pending",
    },
    {
      label: text("报告", "Report"),
      description: record.header ? reportConclusion(record.header, text) : "",
      state: record.header ? "done" : record.stage === "build_report" ? "active" : "pending",
    },
    {
      label: text("发布", "Publish"),
      description:
        record.status === "posted"
          ? `${text("已发布", "Posted")} · ${relativeTime(record.publication?.lastConfirmedAt ?? record.updatedAt, text, now)}`
          : record.status === "publishing"
            ? text("正在发布", "Publishing")
            : record.problem?.type === "upload"
              ? `${text("发布失败", "Publication failed")} · ${record.problem.code}`
              : "",
      state:
        record.status === "posted"
          ? "done"
          : record.status === "publishing"
            ? "active"
            : record.problem?.type === "upload"
              ? "failed"
              : "pending",
    },
  ];
  return (
    <ol className="rc-workflow" aria-label={text("Review 流程", "Review workflow")}>
      {steps.map((step) => (
        <li key={step.label} className={`rc-workflow-${step.state}`}>
          <div className="rc-workflow-track">
            <span className="rc-workflow-dot">
              {step.state === "active" ? (
                <Spinner small />
              ) : step.state !== "pending" ? (
                <ConsoleIcon
                  name={
                    step.state === "done"
                      ? "check"
                      : step.state === "paused"
                        ? "pause"
                        : "priority_high"
                  }
                  size={18}
                />
              ) : null}
            </span>
            <span className="rc-workflow-line" />
          </div>
          <span className="rc-workflow-label">{step.label}</span>
          <span className="rc-workflow-description">{step.description}</span>
        </li>
      ))}
    </ol>
  );
}

function Finding({ finding, text }: { finding: InvestigationFindingV1; text: ConsoleText }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const location = finding.locations[0];
  const position =
    location?.kind === "source" ? `${location.path}:${location.startLine}` : location?.description;
  return (
    <article className="rc-finding">
      <button
        type="button"
        className="rc-finding-heading"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <span className={`rc-priority rc-priority-${finding.priority}`}>{finding.priority}</span>
        <span className="rc-finding-title">
          <strong>
            {finding.title}
            {finding.confirmation.status === "hypothesis" && (
              <span className="rc-finding-hypothesis">
                {text("假设 · 尚未确认", "Hypothesis · Unconfirmed")}
              </span>
            )}
          </strong>
          {position && <code>{position}</code>}
        </span>
        <ConsoleIcon name={open ? "expand_less" : "expand_more"} size={20} />
      </button>
      {open && (
        <div id={contentId} className="rc-finding-body">
          <div>
            <span>{text("影响", "Impact")}</span>
            <p>{finding.impact.description}</p>
          </div>
          <div>
            <span>{text("建议", "Suggested fix")}</span>
            <p>{finding.fixRecommendation.summary}</p>
          </div>
        </div>
      )}
    </article>
  );
}

function ReportPanel({ record, identity }: { record: ReviewRecord; identity: string }) {
  const { text } = useConsolePreferences();
  const header = record.header;
  const findings = useQuery({
    queryKey: ["console-review-findings", identity, header?.id, header?.version],
    enabled: !!header && record.kind === "pr",
    queryFn: async () => {
      if (!header) return [];
      const results: InvestigationFindingV1[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await investigationApi.findings(header.id, cursor, 100);
        if (page.reportRef.id !== header.id || page.reportRef.version !== header.version)
          throw new Error("Findings belong to a different report version.");
        results.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("The findings cursor did not advance.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return results;
    },
    retry: false,
  });
  if (!header)
    return (
      <EmptyPanel icon="description">
        {text("报告会在 Review 完成后生成", "The report appears when the review finishes")}
      </EmptyPanel>
    );
  const assessment = header.assessment;
  const conclusionTone =
    assessment.kind === "pr"
      ? assessment.reviewConclusion.status === "changes-requested"
        ? "error"
        : assessment.reviewConclusion.status === "no-blocking-findings"
          ? "success"
          : "neutral"
      : assessment.kind === "bug"
        ? "warning"
        : assessment.kind === "feature"
          ? "primary"
          : "neutral";
  const conclusionIcon =
    assessment.kind === "bug"
      ? "bug_report"
      : assessment.kind === "feature"
        ? "lightbulb"
        : conclusionTone === "error"
          ? "rule"
          : conclusionTone === "success"
            ? "check_circle"
            : "hourglass_empty";
  const priorities = (outputAccessDenied(findings.error) ? [] : (findings.data ?? [])).reduce<
    Partial<Record<InvestigationFindingV1["priority"], number>>
  >((counts, finding) => {
    counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
    return counts;
  }, {});
  const e2e = header.context.e2e;
  const rawSteps =
    assessment.kind === "bug"
      ? [...assessment.bugAssessment.missingInformation, ...assessment.bugAssessment.hypotheses]
      : assessment.kind === "feature"
        ? [
            ...assessment.featureAssessment.requirements,
            ...assessment.featureAssessment.missingInformation,
            ...assessment.featureAssessment.acceptanceCriteria,
          ]
        : [];
  const steps = [...new Set(rawSteps)];
  return (
    <div className="rc-report-panel">
      <div className="rc-report-conclusion">
        <span className={`rc-conclusion rc-conclusion-${conclusionTone}`}>
          <ConsoleIcon name={conclusionIcon} size={18} filled />
          {reportConclusion(header, text)}
        </span>
        {(["P0", "P1", "P2", "P3"] as const)
          .filter((priority) => priorities[priority])
          .map((priority) => (
            <span key={priority} className={`rc-priority rc-priority-${priority}`}>
              {priority} · {priorities[priority]}
            </span>
          ))}
        <span className="rc-report-coverage">
          {text(
            `覆盖 ${header.report.coverage.completedUnitCount} / ${header.report.coverage.includedUnitCount} 个范围单元`,
            `Coverage ${header.report.coverage.completedUnitCount} / ${header.report.coverage.includedUnitCount} scope units`,
          )}
          {e2e
            ? ` · E2E ${e2e.features.filter((feature) => feature.outcome === "passed").length} / ${e2e.features.length}`
            : ""}
        </span>
      </div>
      <p className="rc-report-summary">{header.report.summary}</p>
      {header.report.completeness === "partial" &&
        !outputAccessDenied(findings.error) &&
        findings.data?.some((finding) => finding.confirmation.status === "confirmed") && (
          <div className="rc-report-partial">
            <ConsoleIcon name="info" size={18} />
            {text("已确认的问题 · Review 未完成", "Confirmed so far · Review incomplete")}
          </div>
        )}
      {record.kind === "pr" ? (
        <div className="rc-findings">
          {findings.isPending && (
            <div className="rc-detail-loading">
              <Spinner />
              {text("正在读取问题", "Loading findings")}
            </div>
          )}
          {findings.isError && (
            <div className="rc-detail-read-error" role="alert">
              {findings.error.message}
              <DetailButton onClick={() => void findings.refetch()}>
                {text("重新加载", "Reload")}
              </DetailButton>
            </div>
          )}
          {!outputAccessDenied(findings.error) &&
            findings.data?.map((finding) => (
              <Finding key={`${finding.id}:${finding.version}`} finding={finding} text={text} />
            ))}
        </div>
      ) : (
        <div className="rc-triage">
          {steps.length > 0 && (
            <>
              <h3>{text("下一步", "Next steps")}</h3>
              <ol>
                {steps.map((step, index) => (
                  <li key={step}>
                    <span>{index + 1}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
          {assessment.kind === "bug" && <p>{assessment.bugAssessment.rationale}</p>}
          {assessment.kind === "feature" && <p>{assessment.featureAssessment.feasibility}</p>}
          {assessment.kind === "other_issue" && <p>{assessment.explanation}</p>}
        </div>
      )}
    </div>
  );
}

function OutputRow({
  item,
  text,
  language,
}: {
  item: OutputItem;
  text: ConsoleText;
  language: "zh" | "en";
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const time = (
    <time dateTime={item.observedAt} title={new Date(item.observedAt).toLocaleString()}>
      {clock(item.observedAt, language)}
    </time>
  );
  if (item.kind === "tool") {
    const active = item.status === "started";
    const status = active
      ? text("运行中", "Running")
      : item.status === "cancelled"
        ? text("已取消", "Cancelled")
        : item.status === "failed"
          ? text("失败", "Failed")
          : item.status === "completed"
            ? text("已完成", "Completed")
            : text("工具输出", "Tool output");
    return (
      <div className="rc-session-command">
        <button
          type="button"
          disabled={!item.result}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen(!open)}
        >
          <ConsoleIcon name="terminal" size={16} />
          <code title={item.command ?? item.text}>{item.command ?? item.text}</code>
          <span className={`rc-command-status rc-command-${item.status ?? "info"}`}>
            {active && <Spinner small />}
            {status}
          </span>
          {item.result && <ConsoleIcon name={open ? "expand_less" : "expand_more"} size={18} />}
        </button>
        {open && item.result && <pre id={contentId}>{item.result}</pre>}
      </div>
    );
  }
  if (item.status === "failed")
    return (
      <div className="rc-session-error">
        <ConsoleIcon name="error" size={18} />
        <p>{item.text}</p>
        {time}
      </div>
    );
  if (item.kind === "system" || item.kind === "gap")
    return (
      <div className={`rc-session-system${item.kind === "gap" ? " rc-session-gap" : ""}`}>
        <span />
        <p>
          {item.text} {time}
        </p>
        <span />
      </div>
    );
  return (
    <div className="rc-session-agent">
      <span className="rc-session-avatar">
        <ConsoleIcon name="smart_toy" size={16} />
      </span>
      <div>
        <div className="rc-session-agent-meta">
          <strong>Agent</strong>
          {time}
        </div>
        <p>{item.text}</p>
      </div>
    </div>
  );
}

function SessionPanel({
  record,
  output,
  disconnected,
  denied,
  onRetry,
  onExpand,
  expanded = false,
}: {
  record: ReviewRecord;
  output: TaskOutputState;
  disconnected: boolean;
  denied: boolean;
  onRetry: () => void;
  onExpand?: () => void;
  expanded?: boolean;
}) {
  const { text, language } = useConsolePreferences();
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const active = record.status === "running";
  const call =
    record.detail && latestAttemptInvocation(record.detail.invocations, output.attemptId);
  const runtime = call
    ? `${call.engine === "copilot" ? "Copilot CLI" : "Codex CLI"} · ${call.model ?? text("CLI 默认模型", "CLI default model")}`
    : text("运行信息尚未记录", "Runtime not recorded");
  useEffect(() => {
    if (following.current && viewport.current && output.eventCount > 0)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [output.eventCount]);
  if (denied)
    return (
      <div className="rc-detail-read-error" role="alert">
        {text("当前账号无法读取会话", "This account cannot read the session")}
      </div>
    );
  if (!output.attemptId)
    return (
      <EmptyPanel icon="terminal">
        {record.problem?.type === "intake"
          ? text(
              "记录尚未导入，没有会话",
              "The source has not been imported, so there is no session",
            )
          : text("会话会在 Review 开始后出现", "The session appears once the review starts")}
      </EmptyPanel>
    );
  const runningCommand = output.items.some(
    (item) => item.kind === "tool" && item.status === "started",
  );
  return (
    <div className="rc-session-panel">
      <div className="rc-session-heading">
        <span>
          {active && !disconnected ? (
            <>
              <span className="rc-live-dot" />
              <strong>{text("实时", "Live")}</strong>
            </>
          ) : (
            <span>{disconnected ? text("连接中断", "Disconnected") : text("已结束", "Ended")}</span>
          )}
          <span className="rc-session-count">
            {" "}
            · {text(`${output.items.length} 条输出`, `${output.items.length} events`)}
          </span>
        </span>
        <span className="rc-session-runtime">{runtime}</span>
        {onExpand && (
          <button
            type="button"
            className="rc-detail-icon-button"
            title={text("展开会话", "Expand session")}
            aria-label={text("展开会话", "Expand session")}
            onClick={onExpand}
          >
            <ConsoleIcon name="open_in_full" size={20} />
          </button>
        )}
      </div>
      {disconnected && (
        <div className="rc-detail-read-error" role="alert">
          {text("无法获取新的会话输出", "New session output is unavailable")}
          <DetailButton onClick={onRetry}>{text("重新连接", "Reconnect")}</DetailButton>
        </div>
      )}
      {(output.retentionGap || output.localGap) && (
        <div className="rc-report-partial">
          <ConsoleIcon name="info" size={18} />
          {text(
            "部分历史输出已超出保留或显示范围",
            "Some historical output is outside retention or display limits",
          )}
        </div>
      )}
      <div
        ref={viewport}
        className={`rc-session-log${expanded ? " rc-session-log-expanded" : ""}`}
        role="log"
        aria-label={text("Agent 会话输出", "Agent session output")}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
        }}
      >
        {output.items.map((item) => (
          <OutputRow
            key={`${item.attemptId}:${item.invocationId}:${item.kind}:${item.itemId}`}
            item={item}
            text={text}
            language={language}
          />
        ))}
        {active && !runningCommand && !disconnected && (
          <div className="rc-agent-working">
            <span />
            <span />
            <span />
            {text("Agent 正在处理…", "Agent is working…")}
          </div>
        )}
        {!active && output.items.length === 0 && (
          <EmptyPanel icon="terminal">
            {text("没有保存的会话输出", "No saved session output")}
          </EmptyPanel>
        )}
      </div>
    </div>
  );
}

function RetainedBody({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let lines: string[] = [];
  let code = false;
  const flush = () => {
    if (!lines.length) return;
    blocks.push(
      code ? (
        <pre key={blocks.length}>{lines.join("\n")}</pre>
      ) : (
        <p key={blocks.length}>{lines.join("\n")}</p>
      ),
    );
    lines = [];
  };
  for (const line of body.split(/\r?\n/u)) {
    if (/^```/u.test(line)) {
      flush();
      code = !code;
      continue;
    }
    if (code) {
      lines.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      flush();
      blocks.push(<h3 key={blocks.length}>{heading[1]}</h3>);
    } else if (!line.trim()) flush();
    else lines.push(line);
  }
  flush();
  return <div className="rc-comment-body">{blocks}</div>;
}

function CommentsPanel({ record, identity }: { record: ReviewRecord; identity: string }) {
  const { text, language } = useConsolePreferences();
  const query = useQuery({
    queryKey: ["console-review-comments", identity, record.taskId],
    enabled: !!record.taskId,
    queryFn: async () => {
      const deliveries: InvestigationCommentDelivery[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await investigationApi.commentDeliveries({
          taskId: record.taskId,
          repositoryId: record.repositoryId,
          cursor,
          limit: 50,
        });
        if (
          page.items.some(
            (entry) =>
              entry.repositoryId !== record.repositoryId ||
              entry.workItemId !== record.workItemId ||
              entry.workItemNumber !== record.number,
          )
        )
          throw new Error("Comment history belongs to another review source.");
        deliveries.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new Error("The comment history cursor did not advance.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return deliveries.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
    retry: false,
    refetchInterval: ["running", "queued", "publishing"].includes(record.status) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const deliveries = outputAccessDenied(query.error) ? [] : (query.data ?? []);
  const confirmed = deliveries.find(
    (delivery) =>
      delivery.state === "succeeded" && delivery.effect === "applied" && delivery.body !== null,
  );
  const currentByComment = new Map<string, InvestigationCommentDelivery>();
  for (const delivery of deliveries)
    if (!currentByComment.has(delivery.commentId))
      currentByComment.set(delivery.commentId, delivery);
  const latestFailure = [...currentByComment.values()].find(
    (delivery) => delivery.state === "failed" || delivery.state === "unknown",
  );
  const isConclusion = (delivery: InvestigationCommentDelivery) =>
    delivery.mode === "result" ||
    (delivery.reportId === record.header?.id && record.task?.state === "completed");
  if (!record.taskId || (!query.isPending && !deliveries.length && !query.error))
    return (
      <EmptyPanel icon="forum">
        {text("还没有发布评论", "No comment has been posted yet")}
      </EmptyPanel>
    );
  return (
    <div className="rc-comments-panel">
      {query.isPending && (
        <div className="rc-detail-loading">
          <Spinner />
          {text("正在读取评论", "Loading comments")}
        </div>
      )}
      {query.isError && (
        <div className="rc-detail-read-error" role="alert">
          {query.error.message}
          <DetailButton onClick={() => void query.refetch()}>
            {text("重新加载", "Reload")}
          </DetailButton>
        </div>
      )}
      {latestFailure && (
        <div className="rc-comment-error">
          <ConsoleIcon name="error" size={18} />
          {latestFailure.reason ?? text("评论发布状态未确认", "Comment delivery is unconfirmed")}
        </div>
      )}
      {confirmed && (
        <article className="rc-comment-preview">
          <div className="rc-comment-heading">
            <span className="rc-comment-avatar">
              <ConsoleIcon name="smart_toy" size={16} />
            </span>
            <strong>Agentic Review</strong>
            <span className="rc-bot-chip">bot</span>
            <span className="rc-comment-current">
              {text("最近确认发布", "Last confirmed publication")} ·{" "}
              {clock(confirmed.finishedAt ?? confirmed.startedAt, language)}
            </span>
            <span
              className={`rc-comment-mode rc-comment-mode-${isConclusion(confirmed) ? "result" : "progress"}`}
            >
              {isConclusion(confirmed) ? text("结论", "Result") : text("进度", "Progress")}
            </span>
          </div>
          <RetainedBody body={confirmed.body ?? ""} />
        </article>
      )}
      {!confirmed && deliveries.length > 0 && (
        <EmptyPanel icon="forum">
          {text("没有已确认的评论正文", "No confirmed comment body")}
        </EmptyPanel>
      )}
      {deliveries.length > 0 && (
        <div className="rc-comment-history">
          {[...deliveries].reverse().map((delivery) => (
            <div
              key={delivery.id}
              className={`rc-comment-history-row rc-comment-history-${delivery.state}`}
            >
              <ConsoleIcon
                name={
                  delivery.state === "succeeded"
                    ? "check"
                    : delivery.state === "sending"
                      ? "sync"
                      : "error"
                }
                size={18}
              />
              <div>
                <span>
                  {delivery.operation === "create"
                    ? text("创建", "Create")
                    : text("更新", "Update")}{" "}
                  · {isConclusion(delivery) ? text("结论", "Result") : text("进度", "Progress")}
                </span>
                {delivery.reason && <p>{delivery.reason}</p>}
              </div>
              <span className="rc-comment-history-state">
                {delivery.state === "succeeded"
                  ? text("成功", "Succeeded")
                  : delivery.state === "failed"
                    ? text("失败", "Failed")
                    : delivery.state === "sending"
                      ? text("发送中", "Sending")
                      : delivery.state === "cancelled"
                        ? text("已取消", "Cancelled")
                        : text("未确认", "Unconfirmed")}
              </span>
              <time dateTime={delivery.finishedAt ?? delivery.startedAt}>
                {clock(delivery.finishedAt ?? delivery.startedAt, language)}
              </time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RecordDetail(props: Props) {
  const { session } = useInvestigationSession();
  const { text } = useConsolePreferences();
  if (!session.authenticated || !session.user.repositoryIds.includes(props.record.repositoryId))
    return (
      <div className="rc-detail-empty">
        {text("当前账号无法查看这条记录", "This record is unavailable for the current account")}
      </div>
    );
  return <RecordDetailReader key={`${sessionIdentity(session)}:${props.record.id}`} {...props} />;
}

function RecordDetailReader({ record: initialRecord, onRefresh, onSettings }: Props) {
  const { text, language } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const client = useQueryClient();
  const related = initialRecord.relatedWork ?? [initialRecord];
  const [selectedWorkId, setSelectedWorkId] = useState(
    initialRecord.currentWorkId ?? initialRecord.taskId,
  );
  const selectedSource = related.find((work) => work.taskId === selectedWorkId) ?? initialRecord;
  const [tab, setTab] = useState<"report" | "session" | "comment">(
    ["running", "queued"].includes(initialRecord.status) ? "session" : "report",
  );
  const [now, setNow] = useState(Date.now());
  const [stopOpen, setStopOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; undo?: boolean }>();
  const resumeKey = useRef(crypto.randomUUID());
  const intakeKey = useRef(crypto.randomUUID());
  const tabsId = useId();
  const detailQuery = useQuery({
    queryKey: ["console-review-detail", identity, selectedSource.taskId],
    enabled: !!selectedSource.taskId,
    queryFn: async ({ signal }) => {
      if (!selectedSource.taskId) throw new Error("A review source is required.");
      const value = await investigationApi.task(selectedSource.taskId, signal);
      if (selectedSource.task) assertReviewDetailBinding(selectedSource.task, value);
      return value;
    },
    initialData: selectedSource.detail,
    refetchInterval: (current) =>
      current.state.data && ["running", "queued"].includes(current.state.data.task.state)
        ? 3_000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const detail = !outputAccessDenied(detailQuery.error)
    ? (detailQuery.data ?? selectedSource.detail)
    : undefined;
  const mapped =
    detail && selectedSource.task
      ? mapReviewTask(
          detail.task,
          detail,
          [selectedSource.publication, selectedSource.progressPublication].filter(
            (value): value is NonNullable<typeof value> => !!value,
          ),
          undefined,
          selectedSource.webhook,
        )
      : selectedSource;
  const fresh = selectedSource.historicalPublication
    ? applyHistoricalPublication(mapped, [selectedSource.historicalPublication])
    : mapped;
  const record: ReviewRecord = {
    ...fresh,
    id: initialRecord.id,
    queueReason: selectedSource.queueReason,
    occupied: selectedSource.occupied,
    concurrency: selectedSource.concurrency,
    ...(selectedSource.completedWithoutPublication &&
    detail?.task.state === "completed" &&
    !fresh.publication
      ? { completedWithoutPublication: true, problem: undefined }
      : {}),
    ...(initialRecord.status === "ignored" ? { status: "ignored" as const } : {}),
  };
  const output = useReviewOutput(record, identity);
  const command = useQuery<RetainedCommentCommand | null>({
    queryKey: commentCommandQueryKey(record.publication?.id ?? ""),
    queryFn: () => null,
    enabled: false,
    gcTime: Infinity,
  }).data;
  if (outputAccessDenied(detailQuery.error))
    return (
      <div className="rc-detail-read-error" role="alert">
        {text("当前账号无法读取这条记录的详情", "This account cannot read these review details")}
      </div>
    );
  const attempt = output.attempt;
  const call = detail && latestAttemptInvocation(detail.invocations, attempt?.id);
  const runtime = call
    ? `${call.engine === "copilot" ? "Copilot CLI" : "Codex CLI"} · ${call.model ?? text("CLI 默认模型", "CLI default model")}${attempt?.workerId ? ` · ${attempt.workerId}` : ""}`
    : (attempt?.workerId ?? text("运行信息尚未记录", "Runtime not recorded"));
  const lastOutput = output.state.items.reduce<string | undefined>(
    (latest, item) => (!latest || item.observedAt > latest ? item.observedAt : latest),
    undefined,
  );
  const quiet = lastOutput
    ? now - Date.parse(lastOutput) > 180_000
    : record.startedAt
      ? now - Date.parse(record.startedAt) > 180_000
      : false;
  const quietSince = lastOutput ?? record.startedAt;
  const quietMinutes = quietSince
    ? Math.max(0, Math.floor((now - Date.parse(quietSince)) / 60_000))
    : 0;
  const githubUrl = safeGithubUrl(record);
  const commentUrl = safeCommentUrl(record.publication?.commentUrl);
  const publicationAction = record.publication?.availableActions.includes("sync")
    ? "sync"
    : record.publication?.availableActions.includes("reconcile")
      ? "reconcile"
      : undefined;
  const cleanupPending =
    detail?.resourceLeases?.some(
      (lease) => lease.taskId === record.taskId && lease.state !== "released",
    ) === true;
  const resumeAllowed =
    !!session.user?.permissions.includes("task:create") &&
    (record.task?.executionPolicy.mode !== "execute" || session.user.allowRepositoryExecution) &&
    !cleanupPending &&
    !detailQuery.isError;
  const publicationAllowed =
    !!record.publication &&
    !!publicationAction &&
    canScheduleCommentAction(record.publication, session.user, publicationAction, command);
  const retryAllowed =
    record.problem?.type === "upload"
      ? publicationAllowed
      : record.problem?.type === "intake"
        ? record.webhook?.availableActions.includes("retry") === true &&
          session.user?.permissions.includes("repository:manage") === true &&
          session.user?.permissions.includes("task:create") === true &&
          (record.webhook.mode !== "e2e" || session.user.allowRepositoryExecution)
        : resumeAllowed;
  const primaryLabel =
    record.problem?.type === "upload"
      ? publicationAction === "reconcile"
        ? text("检查发布状态", "Check publication")
        : text("重新发布", "Repost")
      : record.problem?.type === "intake"
        ? text("重新接收", "Receive again")
        : record.problem?.type === "stopped"
          ? record.detail?.checkpoint
            ? text("继续 Review", "Continue Review")
            : text("重新 Review", "Restart Review")
          : text("重试", "Retry");
  const primaryIcon =
    record.problem?.type === "upload"
      ? "publish"
      : record.problem?.type === "intake"
        ? "refresh"
        : record.problem?.type === "stopped"
          ? "play_arrow"
          : "replay";
  const problemIcon =
    record.problem?.type === "upload"
      ? "cloud_off"
      : record.problem?.type === "worker"
        ? "link_off"
        : record.problem?.type === "intake"
          ? "move_to_inbox"
          : record.problem?.type === "stopped"
            ? "pause_circle"
            : "error";
  const ignore = (ignored: boolean) => {
    try {
      setReviewRecordIgnored(identity, record.id, ignored);
      onRefresh();
      setNotice({
        text: text(
          `${ignored ? "已忽略" : "已撤销忽略"} · #${record.number}`,
          `${ignored ? "Ignored" : "Ignore undone"} · #${record.number}`,
        ),
        undo: ignored,
      });
    } catch {
      setError(text("无法保存当前浏览器的忽略状态", "Could not save this browser's ignored state"));
    }
  };
  const primary = async () => {
    if (busy || !retryAllowed) return;
    setBusy(true);
    setError(undefined);
    try {
      if (record.problem?.type === "upload" && record.publication && publicationAction) {
        await scheduleCommentCommand(client, record.publication, publicationAction);
        const saved = client.getQueryData<RetainedCommentCommand>(
          commentCommandQueryKey(record.publication.id),
        );
        if (saved?.state !== "completed")
          throw new Error(
            saved?.message ?? text("发布请求未确认", "The publication request was not confirmed"),
          );
        setNotice({
          text: text(
            `发布请求已接受 · #${record.number}`,
            `Publication request accepted · #${record.number}`,
          ),
        });
      } else if (record.problem?.type === "intake" && record.webhook) {
        await investigationApi.retryWebhookDelivery(record.webhook.deliveryId, {
          version: record.webhook.version,
          idempotencyKey: intakeKey.current,
        });
        intakeKey.current = crypto.randomUUID();
        setNotice({
          text: text(
            `接收请求已接受 · #${record.number}`,
            `Intake request accepted · #${record.number}`,
          ),
        });
      } else if (record.taskId) {
        await investigationApi.resumeTask(record.taskId, resumeKey.current);
        resumeKey.current = crypto.randomUUID();
        setNotice({ text: text(`已重新排队 · #${record.number}`, `Requeued · #${record.number}`) });
      }
      invalidateReviewRecordCache();
      if (initialRecord.status === "ignored") setReviewRecordIgnored(identity, record.id, false);
      if (record.taskId) await detailQuery.refetch();
      onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : text("操作未完成", "The operation did not complete"),
      );
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (
      !record.taskId ||
      busy ||
      !session.user?.permissions.includes("task:cancel") ||
      detailQuery.isError
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await investigationApi.cancelTask(record.taskId);
      await detailQuery.refetch();
      onRefresh();
      setStopOpen(false);
      setNotice({
        text: text(
          `停止请求已接受 · #${record.number}`,
          `Stop request accepted · #${record.number}`,
        ),
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : text("无法停止 Review", "Could not stop Review"),
      );
    } finally {
      setBusy(false);
    }
  };
  const stopped = record.problem?.type === "stopped";
  const shaSubject = record.task?.subjects.find(
    (subject) => subject.id === record.task?.subjectRef,
  );
  const sha =
    shaSubject && "headSha" in shaSubject
      ? shaSubject.headSha
      : shaSubject && "commitSha" in shaSubject
        ? shaSubject.commitSha
        : undefined;
  const unavailableAction = !retryAllowed && record.status === "attention";
  return (
    <div className="rc-record-detail">
      <header className="rc-detail-heading">
        <div>
          <div className="rc-detail-eyebrow">
            <span className="rc-kind-chip">{record.kind === "pr" ? "PR" : "Issue"}</span>
            <span>
              #{record.number}
              {record.area ? ` · ${record.area}` : ""}
            </span>
          </div>
          <h1>{record.title}</h1>
          <div className="rc-detail-meta">
            {record.webhook && (
              <span>
                <ConsoleIcon name="bolt" size={18} />
                {triggerLabel(record.webhook, text)}
              </span>
            )}
            {record.task && (
              <span>
                <ConsoleIcon name="description" size={18} />
                {record.task.promptRef.id} v{record.task.promptRef.version}
              </span>
            )}
            {record.kind === "pr" && sha && (
              <span>
                <ConsoleIcon name="commit" size={18} />
                <code title={sha}>{sha.slice(0, 7)}</code>
              </span>
            )}
          </div>
        </div>
        {githubUrl && (
          <a
            className="rc-detail-button rc-detail-button-outlined rc-github-button"
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ConsoleIcon name="open_in_new" size={18} />
            GitHub
          </a>
        )}
      </header>
      {related.length > 1 && (
        <fieldset
          className="rc-related-work"
          aria-label={text("相关 Review 流程", "Related review work")}
        >
          {related.map((work) => (
            <button
              type="button"
              key={work.taskId}
              aria-pressed={selectedSource.taskId === work.taskId}
              disabled={busy}
              onClick={() => {
                setSelectedWorkId(work.taskId);
                setTab(["running", "queued"].includes(work.status) ? "session" : "report");
                setError(undefined);
              }}
            >
              {relatedWorkLabel(work, text)}
              <span className="rc-related-status">
                {work.completedWithoutPublication || work.task?.state === "completed"
                  ? text("已完成", "Completed")
                  : work.status === "running"
                    ? text("运行中", "Running")
                    : work.status === "queued"
                      ? text("排队中", "Queued")
                      : problemLabel(work.problem?.type, text)}
              </span>
            </button>
          ))}
        </fieldset>
      )}
      <Workflow record={record} now={now} text={text} />
      {(detailQuery.isError || record.readWarning) && (
        <div
          className={
            record.completedWithoutPublication ? "rc-detail-read-warning" : "rc-detail-read-error"
          }
          role="alert"
        >
          {record.completedWithoutPublication
            ? text(
                "报告已完成，发布状态尚未确认。可以刷新检查发布记录。",
                "The report is complete; publication is unconfirmed. Refresh to check its delivery history.",
              )
            : text(
                "部分详情无法读取，请刷新后再操作",
                "Some details are unavailable. Refresh before taking action.",
              )}
          <DetailButton
            onClick={() => {
              void detailQuery.refetch();
              onRefresh();
            }}
          >
            {text("刷新", "Refresh")}
          </DetailButton>
        </div>
      )}
      {error && (
        <div className="rc-detail-read-error" role="alert">
          {error}
          <button
            type="button"
            className="rc-detail-icon-button"
            onClick={() => setError(undefined)}
            aria-label={text("关闭错误提示", "Dismiss error")}
          >
            <ConsoleIcon name="close" size={18} />
          </button>
        </div>
      )}
      {record.completedWithoutPublication && record.status !== "ignored" && (
        <section className="rc-status-card rc-status-completed">
          <ConsoleIcon name="check_circle" size={24} filled />
          <div className="rc-status-copy">
            <h2>{text("Review 已完成", "Review completed")}</h2>
            <small>
              {text(
                "报告已保存，发布状态尚未确认",
                "The report is saved; publication is unconfirmed",
              )}
            </small>
          </div>
        </section>
      )}
      {record.status === "attention" && !record.completedWithoutPublication && (
        <section
          className={`rc-status-card rc-status-attention${stopped ? " rc-status-stopped" : ""}`}
        >
          <span className="rc-status-problem-icon">
            <ConsoleIcon name={problemIcon} size={24} />
          </span>
          <div className="rc-status-copy">
            <h2>
              {problemLabel(record.problem?.type, text)}
              {record.problem?.code ? ` · ${record.problem.code}` : ""}
            </h2>
            <p>{problemMessage(record, text)}</p>
            <small>
              {cleanupPending
                ? text(
                    "Worker 正在清理，清理完成后才能继续",
                    "Worker cleanup must finish before continuing",
                  )
                : problemHint(record, text)}
            </small>
            {unavailableAction && (
              <small>
                {record.problem?.type === "upload" && !record.publication
                  ? text(
                      "服务端尚未提供可重发的评论，请检查自动回复设置",
                      "The service has no comment to repost. Check automatic reply settings.",
                    )
                  : text(
                      "当前状态或账号权限不允许执行该操作",
                      "The current state or account permissions do not allow this action",
                    )}
              </small>
            )}
          </div>
          <div className="rc-status-actions">
            <DetailButton onClick={() => ignore(true)} disabled={busy}>
              {text("忽略", "Ignore")}
            </DetailButton>
            <DetailButton
              filled
              icon={busy ? undefined : primaryIcon}
              disabled={busy || !retryAllowed}
              onClick={() => void primary()}
            >
              {busy && <Spinner small />}
              {primaryLabel}
            </DetailButton>
          </div>
        </section>
      )}
      {record.status === "running" && (
        <section className="rc-status-card rc-status-running">
          <div className="rc-running-heading">
            <Spinner />
            <div className="rc-status-copy">
              <h2>
                {text("Review 中", "Reviewing")} · {stageLabel(record.stage, text)}
              </h2>
              <small>{runtime}</small>
            </div>
            <DetailButton
              outlined
              icon="stop_circle"
              disabled={
                busy || !session.user?.permissions.includes("task:cancel") || detailQuery.isError
              }
              onClick={() => setStopOpen(true)}
            >
              {text("停止", "Stop")}
            </DetailButton>
          </div>
          <div className="rc-running-stats">
            <div>
              <span className="rc-stat-label">{text("运行时间", "Elapsed")}</span>
              <strong className="rc-elapsed">
                {record.startedAt ? formatDuration(now - Date.parse(record.startedAt)) : "—"}
              </strong>
              <small>
                {record.startedAt
                  ? text(
                      `开始于 ${clock(record.startedAt, language)}`,
                      `Started at ${clock(record.startedAt, language)}`,
                    )
                  : text("开始时间未记录", "Start time not recorded")}
              </small>
            </div>
            <div>
              <span className="rc-stat-label">{text("最近输出", "Last output")}</span>
              <strong className={`rc-last-output${quiet ? " rc-last-output-quiet" : ""}`}>
                <span className={quiet || output.query.isError ? "rc-quiet-dot" : "rc-live-dot"} />
                {lastOutput
                  ? relativeTime(lastOutput, text, now)
                  : text("等待输出", "Waiting for output")}
              </strong>
              <small className={quiet ? "rc-quiet-copy" : ""}>
                {output.query.isError
                  ? text("输出连接中断", "Output disconnected")
                  : quiet
                    ? text(
                        `${quietMinutes} 分钟没有新输出`,
                        `No new output for ${quietMinutes} minutes`,
                      )
                    : lastOutput
                      ? text("持续输出中", "Receiving output")
                      : text("尚未收到会话输出", "No session output received")}
              </small>
            </div>
          </div>
        </section>
      )}
      {record.status === "queued" && (
        <section className="rc-status-card rc-status-queued">
          <ConsoleIcon name="hourglass_empty" size={24} />
          <div className="rc-status-copy">
            <h2>{text("排队中", "Queued")}</h2>
            <small>{recordStatusLabel(record, text, now)}</small>
          </div>
          {record.queueReason === "capacity" && (
            <DetailButton onClick={() => onSettings("execution")}>
              {text("调整并发", "Adjust capacity")} <span aria-hidden="true">→</span>
            </DetailButton>
          )}
        </section>
      )}
      {record.status === "publishing" && (
        <section className="rc-status-card rc-status-publishing">
          <div>
            <ConsoleIcon name="cloud_upload" size={24} />
            <h2>{text("正在发布到 GitHub", "Posting to GitHub")}</h2>
          </div>
          <span className="rc-indeterminate" />
        </section>
      )}
      {record.status === "posted" && (
        <section className="rc-status-card rc-status-posted">
          <ConsoleIcon name="check_circle" size={24} filled />
          <strong>
            {record.historicalPublication
              ? text("曾发布 · 评论后续已更新", "Previously posted · Comment has since changed")
              : text("已发布", "Posted")}{" "}
            · {relativeTime(record.publication?.lastConfirmedAt ?? record.updatedAt, text, now)}
          </strong>
          {commentUrl && (
            <a
              className="rc-detail-button"
              href={commentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {text("在 GitHub 查看", "View on GitHub")}
            </a>
          )}
        </section>
      )}
      {record.status === "ignored" && (
        <section className="rc-status-card rc-status-ignored">
          <ConsoleIcon name="notifications_off" size={24} />
          <span>{text("已忽略，不会再提醒", "Ignored; reminders are hidden")}</span>
          <DetailButton onClick={() => ignore(false)}>{text("撤销", "Undo")}</DetailButton>
        </section>
      )}
      <div
        className="rc-detail-tabs"
        role="tablist"
        aria-label={text("记录详情", "Record details")}
      >
        {(["report", "session", "comment"] as const).map((key) => (
          <button
            type="button"
            key={key}
            id={`${tabsId}-${key}-tab`}
            role="tab"
            tabIndex={tab === key ? 0 : -1}
            aria-selected={tab === key}
            aria-controls={`${tabsId}-${key}-panel`}
            className={tab === key ? "rc-tab-selected" : ""}
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const keys = ["report", "session", "comment"] as const;
              const index = keys.indexOf(key);
              const next =
                event.key === "Home"
                  ? keys[0]
                  : event.key === "End"
                    ? keys[2]
                    : (keys[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3] ?? "report");
              setTab(next);
              document.getElementById(`${tabsId}-${next}-tab`)?.focus();
            }}
          >
            {key === "session" && record.status === "running" && <span className="rc-live-dot" />}
            {key === "report"
              ? text("报告", "Report")
              : key === "session"
                ? text("会话", "Session")
                : text("评论", "Comment")}
            {key === "report" &&
              record.kind === "pr" &&
              !!record.header?.report.collections.findings && (
                <span className="rc-tab-count">{record.header.report.collections.findings}</span>
              )}
            {key === "session" && output.state.items.length > 0 && (
              <span className="rc-tab-count">{output.state.items.length}</span>
            )}
          </button>
        ))}
      </div>
      <section
        className="rc-detail-tab-panel"
        role="tabpanel"
        id={`${tabsId}-${tab}-panel`}
        aria-labelledby={`${tabsId}-${tab}-tab`}
      >
        {tab === "report" ? (
          <ReportPanel record={record} identity={identity} />
        ) : tab === "session" ? (
          <SessionPanel
            key={output.state.attemptId}
            record={record}
            output={output.state}
            disconnected={output.query.isError}
            denied={outputAccessDenied(output.query.error)}
            onRetry={() => void output.query.refetch()}
            onExpand={() => setSessionOpen(true)}
          />
        ) : (
          <CommentsPanel record={record} identity={identity} />
        )}
      </section>
      <Dialog
        open={stopOpen}
        onClose={() => {
          if (!busy) setStopOpen(false);
        }}
        className="rc-stop-dialog"
        aria-labelledby={`${tabsId}-stop-title`}
      >
        <div className="rc-stop-dialog-content">
          <ConsoleIcon name="stop_circle" size={24} />
          <h2 id={`${tabsId}-stop-title`}>{text("停止这次 Review？", "Stop this Review?")}</h2>
          <p>
            {text(
              "已保存的进度会保留，之后可以继续。尚未保存的输出可能不会恢复。",
              "Saved progress will be kept so you can continue later. Unsaved output may not be recoverable.",
            )}
          </p>
          {error && (
            <div className="rc-detail-read-error" role="alert">
              {error}
            </div>
          )}
          <div className="rc-stop-dialog-actions">
            <DetailButton disabled={busy} onClick={() => setStopOpen(false)}>
              {text("取消", "Cancel")}
            </DetailButton>
            <DetailButton disabled={busy} onClick={() => void stop()}>
              {busy && <Spinner small />}
              {text("停止", "Stop")}
            </DetailButton>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={sessionOpen}
        onClose={() => setSessionOpen(false)}
        fullWidth
        maxWidth="lg"
        className="rc-session-dialog"
        aria-labelledby={`${tabsId}-session-title`}
      >
        <div className="rc-session-dialog-heading">
          <h2 id={`${tabsId}-session-title`}>
            {text("Agent 会话", "Agent session")} · #{record.number}
          </h2>
          <button
            type="button"
            className="rc-detail-icon-button"
            onClick={() => setSessionOpen(false)}
            aria-label={text("关闭会话", "Close session")}
          >
            <ConsoleIcon name="close" size={24} />
          </button>
        </div>
        <SessionPanel
          key={`expanded:${output.state.attemptId}`}
          record={record}
          output={output.state}
          disconnected={output.query.isError}
          denied={outputAccessDenied(output.query.error)}
          onRetry={() => void output.query.refetch()}
          expanded
        />
      </Dialog>
      <Snackbar
        open={!!notice}
        autoHideDuration={4_500}
        onClose={() => setNotice(undefined)}
        className="rc-detail-snackbar"
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <div role="status" className="rc-snackbar-content">
          <span>{notice?.text}</span>
          {notice?.undo && (
            <button type="button" onClick={() => ignore(false)}>
              {text("撤销", "Undo")}
            </button>
          )}
          <button
            type="button"
            aria-label={text("关闭提示", "Dismiss notification")}
            onClick={() => setNotice(undefined)}
          >
            <ConsoleIcon name="close" size={18} />
          </button>
        </div>
      </Snackbar>
    </div>
  );
}
