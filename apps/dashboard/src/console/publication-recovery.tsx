import type {
  InvestigationPublicationRecoveryBlocker,
  InvestigationPublicationRecoveryRequest,
} from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { investigationApi } from "../investigation/api";
import {
  canScheduleCommentAction,
  commentCommandQueryKey,
  type RetainedCommentCommand,
  scheduleCommentCommand,
} from "../investigation/comment-publication-state";
import { useInvestigationSession } from "../investigation/session";
import { InvestigationHttpError } from "../investigation/transport";
import { type ConsoleText, invalidateReviewRecordCache, type ReviewRecord } from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";

export function recoveryReason(
  blocker: InvestigationPublicationRecoveryBlocker | null,
  text: ConsoleText,
): string {
  switch (blocker) {
    case "automatic_replies_disabled":
      return text(
        "自动发布已关闭。开启并授权自动回复后，可重新投递此报告。",
        "Automatic publication is disabled. Enable and authorize automatic replies before delivering this report.",
      );
    case "external_writes_disabled":
      return text(
        "服务端尚未允许 GitHub 评论写入。",
        "The server has not enabled GitHub comment writes.",
      );
    case "publisher_unavailable":
      return text("发布器尚未配置或不可用。", "The publisher is not configured or is unavailable.");
    case "permission_denied":
      return text(
        "当前账号没有发布评论权限。",
        "This account does not have comment publication permission.",
      );
    case "authorization_unavailable":
      return text(
        "发布授权已失效，请在自动回复设置中重新授权。",
        "Publication authorization is no longer valid. Reauthorize automatic replies.",
      );
    case "newer_task":
    case "newer_publication":
      return text(
        "此记录之后已有更新的 Review，重新投递不能覆盖更新的评论。",
        "A newer review already owns the comment. This report cannot replace its result.",
      );
    case "reconcile_required":
      return text(
        "上次投递的结果尚不明确，需要先核对已有评论。",
        "The previous delivery outcome is uncertain. Check the existing comment first.",
      );
    case "publication_busy":
      return text(
        "投递正在进行，请刷新查看结果。",
        "Delivery is in progress. Refresh to check its result.",
      );
    case "legacy_publication":
      return text(
        "此记录使用旧版发布流程，当前不提供投递恢复。",
        "This record uses the legacy publication workflow, which does not offer this recovery action.",
      );
    case "report_unavailable":
      return text(
        "完整的已保存报告不可用，无法重新投递。",
        "The complete saved report is unavailable for delivery.",
      );
    case "unsupported_task":
      return text(
        "此活动不单独发布 GitHub 评论。",
        "This activity does not publish a separate GitHub comment.",
      );
    case "repository_identity_changed":
    case "work_item_identity_changed":
      return text(
        "评论目标的身份已变化，请先检查仓库和来源记录。",
        "The publication target changed. Check its repository and source record first.",
      );
    case "publication_conflict":
      return text(
        "评论发布存在冲突，请检查当前评论状态。",
        "Publication is in conflict. Check the current comment state.",
      );
    default:
      return text("复用已保存的报告进行投递。", "Deliver the saved report.");
  }
}

export default function PublicationRecovery({
  record,
  identity,
  onRefresh,
  onSettings,
}: {
  record: ReviewRecord;
  identity: string;
  onRefresh: () => void;
  onSettings: (section: string) => void;
}) {
  const { text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const pending = useRef<InvestigationPublicationRecoveryRequest | null>(null);
  const eligible =
    !!record.taskId && record.task?.parentTaskId === null && record.task.state === "completed";
  const query = useQuery({
    queryKey: [
      "console-publication-recovery",
      identity,
      record.taskId,
      record.task?.latestReportRef?.id,
    ],
    enabled: eligible,
    queryFn: async ({ signal }) => {
      if (!record.taskId) throw new Error("The review record has no saved task.");
      const value = await investigationApi.publicationRecovery(record.taskId, signal);
      if (value.taskId !== record.taskId || value.reportId !== record.task?.latestReportRef?.id)
        throw new Error("The publication recovery is not bound to this saved report.");
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const status = query.data;
  const publication = status?.publication;
  const retained = publication
    ? client.getQueryData<RetainedCommentCommand>(commentCommandQueryKey(publication.id))
    : undefined;
  const command =
    publication && (status?.state === "existing" || status?.blocker === "reconcile_required")
      ? publication.availableActions.includes("reconcile")
        ? "reconcile"
        : status?.state === "existing" && publication.availableActions.includes("sync")
          ? "sync"
          : undefined
      : undefined;
  const canEnqueue = status?.state === "missing" && status.availableActions.includes("enqueue");
  const canCommand =
    publication &&
    command &&
    canScheduleCommentAction(publication, session.user, command, retained);
  const act = async () => {
    if (busy || !record.taskId || !status || query.isError) return;
    setBusy(true);
    setMessage(undefined);
    try {
      if (canEnqueue && status.reportId) {
        const request = pending.current ?? {
          version: status.version,
          reportId: status.reportId,
          idempotencyKey: crypto.randomUUID(),
        };
        pending.current = request;
        const value = await investigationApi.recoverPublication(record.taskId, request);
        if (value.taskId !== record.taskId || value.reportId !== request.reportId)
          throw new Error("The delivery acknowledgement belongs to another saved report.");
        pending.current = null;
        setMessage(
          text(
            "投递请求已接受，正在等待发布结果。",
            "The delivery request was accepted. Waiting for publication.",
          ),
        );
      } else if (publication && command && canCommand) {
        await scheduleCommentCommand(client, publication, command);
        const result = client.getQueryData<RetainedCommentCommand>(
          commentCommandQueryKey(publication.id),
        );
        if (result?.state !== "completed")
          throw new Error(result?.message ?? "The comment recovery request was not confirmed.");
        setMessage(
          command === "reconcile"
            ? text("评论核对已完成。", "The comment check completed.")
            : text("重新投递请求已接受。", "The redelivery request was accepted."),
        );
      }
      invalidateReviewRecordCache();
      await query.refetch();
      onRefresh();
    } catch (error) {
      if (error instanceof InvestigationHttpError) pending.current = null;
      setMessage(
        error instanceof Error
          ? error.message
          : text(
              "投递未完成，请刷新检查状态。",
              "Delivery did not complete. Refresh to check its state.",
            ),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!eligible) return null;
  return (
    <section
      className="rc-publication-recovery"
      aria-label={text("报告投递恢复", "Saved report delivery recovery")}
    >
      <p>
        {status
          ? recoveryReason(status.blocker, text)
          : query.isError
            ? text(
                "投递状态读取失败，请重新读取后操作。",
                "Delivery status could not be read. Read it again before acting.",
              )
            : text("正在读取可用的投递操作…", "Loading available delivery actions…")}
      </p>
      <div className="rc-recovery-actions">
        <button
          type="button"
          className="rc-detail-button"
          disabled={busy || query.isFetching}
          onClick={() => {
            void query.refetch();
            onRefresh();
          }}
        >
          {text("刷新投递状态", "Refresh delivery status")}
        </button>
        {(status?.blocker === "automatic_replies_disabled" ||
          status?.blocker === "authorization_unavailable") && (
          <button type="button" className="rc-detail-button" onClick={() => onSettings("replies")}>
            {text("自动回复设置", "Automatic reply settings")}
          </button>
        )}
        {(canEnqueue || canCommand) && (
          <button
            type="button"
            className="rc-detail-button rc-detail-button-filled"
            disabled={busy || query.isFetching || query.isError}
            onClick={() => void act()}
          >
            <ConsoleIcon name={command === "reconcile" ? "fact_check" : "publish"} size={18} />
            {busy
              ? text("处理中…", "Working…")
              : command === "reconcile"
                ? text("核对已有评论", "Check existing comment")
                : text("重新投递", "Redeliver")}
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
