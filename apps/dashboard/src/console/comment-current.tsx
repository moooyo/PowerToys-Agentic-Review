import type {
  InvestigationCommentPublicationSummary,
  InvestigationCurrentComment,
} from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { investigationApi } from "../investigation/api";
import { outputAccessDenied } from "../investigation/task-output";
import { type ConsoleText, relativeTime } from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./native-evidence.css";

export function currentCommentQueryKey(
  identity: string,
  publication: InvestigationCommentPublicationSummary,
) {
  return ["console-current-comment", identity, publication.id, publication.version];
}

export function assertCurrentCommentBinding(
  value: InvestigationCurrentComment,
  publication: InvestigationCommentPublicationSummary,
): void {
  if (
    value.commentId !== publication.id ||
    value.repositoryId !== publication.repositoryId ||
    value.repositoryFullName !== publication.repositoryFullName ||
    value.workItemId !== publication.workItemId ||
    value.workItemNumber !== publication.workItemNumber ||
    value.externalId !== publication.externalId
  )
    throw new Error("The current comment belongs to another publication.");
}

function currentState(value: InvestigationCurrentComment, text: ConsoleText): string {
  switch (value.state) {
    case "edited":
      return text("GitHub 评论已被编辑", "GitHub comment was edited");
    case "deleted":
      return text("GitHub 评论已被删除", "GitHub comment was deleted");
    case "not_published":
      return text("尚无已保存的 GitHub 评论", "No saved GitHub comment yet");
    case "unavailable":
      return text("无法确认 GitHub 当前评论", "Current GitHub comment is unavailable");
    default:
      return value.comparison === "unknown"
        ? text(
            "GitHub 评论存在 · 历史内容无法比较",
            "GitHub comment exists · Historical content cannot be compared",
          )
        : text("GitHub 评论与上次确认一致", "GitHub comment matches the last confirmation");
  }
}

function currentReason(code: string | null, text: ConsoleText): string {
  switch (code) {
    case "github_not_configured":
      return text("GitHub 连接尚未配置。", "The GitHub connection is not configured.");
    case "github_authentication_failed":
      return text(
        "GitHub 身份验证失败，无法读取当前评论。",
        "GitHub authentication failed. The current comment cannot be read.",
      );
    case "github_access_denied":
      return text(
        "GitHub 拒绝访问，请检查读取权限或请求限制。",
        "GitHub denied access. Check read permissions or request limits.",
      );
    case "github_not_found_or_inaccessible":
      return text(
        "目标不存在或当前身份无权读取，无法确定评论是否被删除。",
        "The target is missing or inaccessible. Comment deletion cannot be confirmed.",
      );
    case "confirmed_content_unavailable":
      return text(
        "上次确认时间仍保留，但历史正文不可用，无法判断编辑状态。",
        "The last confirmation time is retained, but its body is unavailable, so edits cannot be determined.",
      );
    case "comment_identity_mismatch":
      return text(
        "回读结果与已保存的评论来源不符。",
        "The readback does not match the saved comment source.",
      );
    case "repository_identity_changed":
      return text(
        "仓库名称对应的 GitHub 仓库身份已变化，无法确认原评论状态。",
        "The repository name now resolves to a different GitHub repository. The original comment state cannot be confirmed.",
      );
    case "saved_repository_identity_unavailable":
      return text(
        "未保存可核对的 GitHub 仓库身份，无法确认原评论状态。",
        "No verifiable GitHub repository identity was saved. The original comment state cannot be confirmed.",
      );
    case "target_identity_mismatch":
      return text(
        "当前 PR 或 Issue 身份与保存的目标不符。",
        "The current PR or Issue identity does not match the saved target.",
      );
    case "legacy_comment_readback_unavailable":
      return text(
        "此历史评论使用旧记录格式，当前回读不可用。已保留的正文仍可查看。",
        "This historical comment uses an older record format. Current readback is unavailable, and its retained body remains visible.",
      );
    case "github_rate_limited":
      return text(
        "GitHub 请求受限，请稍后刷新。",
        "GitHub rate-limited the request. Refresh later.",
      );
    default:
      return text(
        "当前状态未能确认，请重新读取。",
        "The current state could not be confirmed. Read it again.",
      );
  }
}

export function CommentCurrentView({
  value,
  text,
  refreshing = false,
  onRefresh,
}: {
  value: InvestigationCurrentComment;
  text: ConsoleText;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const changed = value.state === "edited" || value.state === "deleted";
  return (
    <section
      className="rc-current-comment"
      aria-label={text("GitHub 当前评论", "Current GitHub comment")}
    >
      <div
        className={`rc-native-state${changed || value.state === "unavailable" ? " rc-native-state-warning" : ""}`}
        role="status"
      >
        <ConsoleIcon
          name={
            value.state === "deleted"
              ? "delete_outline"
              : value.state === "edited"
                ? "edit_note"
                : value.state === "unavailable"
                  ? "cloud_off"
                  : "comment"
          }
          size={18}
        />
        <strong>{currentState(value, text)}</strong>
        {onRefresh && (
          <button
            type="button"
            className="rc-native-refresh"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? text("读取中…", "Reading…") : text("重新读取", "Read again")}
          </button>
        )}
      </div>
      <div className="rc-native-meta">
        {text("回读时间", "Checked")} · {relativeTime(value.checkedAt, text)}
        {value.upstreamUpdatedAt && (
          <>
            {" "}
            · {text("GitHub 更新", "GitHub updated")} {relativeTime(value.upstreamUpdatedAt, text)}
          </>
        )}
      </div>
      {value.state === "unavailable" && (
        <p className="rc-native-message">{currentReason(value.reasonCode, text)}</p>
      )}
      {value.comparison === "unknown" && value.state === "present" && (
        <p className="rc-native-message">{currentReason(value.reasonCode, text)}</p>
      )}
      {value.body !== null && (
        <div className="rc-current-body">
          <span className="rc-native-label">{text("GitHub 当前正文", "Current GitHub body")}</span>
          <pre>{value.body}</pre>
        </div>
      )}
      {(value.lastConfirmedAt !== null || value.lastConfirmedBody !== null) && (
        <details className="rc-confirmed-history">
          <summary>
            {text("上次确认的历史内容", "Last confirmed historical content")} ·{" "}
            {value.lastConfirmedAt === null
              ? text("确认时间未知", "Confirmation time unknown")
              : relativeTime(value.lastConfirmedAt, text)}
          </summary>
          {value.lastConfirmedBody === null ? (
            <p>{text("历史正文未保留。", "The historical body was not retained.")}</p>
          ) : (
            <pre>{value.lastConfirmedBody}</pre>
          )}
        </details>
      )}
    </section>
  );
}

export function CommentCurrent({
  publication,
  identity,
}: {
  publication: InvestigationCommentPublicationSummary;
  identity: string;
}) {
  const { text } = useConsolePreferences();
  const query = useQuery({
    queryKey: currentCommentQueryKey(identity, publication),
    queryFn: async ({ signal }) => {
      const value = await investigationApi.currentComment(publication.id, signal);
      assertCurrentCommentBinding(value, publication);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const value = outputAccessDenied(query.error) ? undefined : query.data;
  if (query.isError)
    return (
      <div className="rc-native-read-error" role="alert">
        {text("无法读取 GitHub 当前评论", "Could not read the current GitHub comment")}
        <button
          type="button"
          className="rc-native-refresh"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {text("重试", "Retry")}
        </button>
        {publication.lastConfirmedAt && (
          <p>
            {text("上次确认", "Last confirmed")} · {relativeTime(publication.lastConfirmedAt, text)}
          </p>
        )}
      </div>
    );
  if (!value)
    return (
      <div className="rc-native-loading" role="status">
        {text("正在读取 GitHub 当前评论…", "Reading the current GitHub comment…")}
      </div>
    );
  return (
    <CommentCurrentView
      value={value}
      text={text}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
    />
  );
}
