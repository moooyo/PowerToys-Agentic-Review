import type { InvestigationTaskV1 } from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { investigationApi, type Repository } from "@/investigation/api";
import { useInvestigationSession } from "@/investigation/session";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./settings-prompts.css";

type ReviewType = "pull_request" | "issue";
type PromptRecord = {
  key: string;
  task: InvestigationTaskV1;
};

function promptRecords(tasks: InvestigationTaskV1[], kind: ReviewType): PromptRecord[] {
  const seen = new Set<string>();
  return tasks
    .filter(
      (task) =>
        task.workItem.kind === kind &&
        task.kind === (kind === "pull_request" ? "pr-review" : "issue-investigate"),
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .flatMap((task) => {
      const { id, version, digest } = task.promptRef;
      const key = `${id}:${version}:${digest}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, task }];
    });
}

export default function SettingsPrompts({ repository }: { repository?: Repository }) {
  const { language, text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const [selectedType, setSelectedType] = useState<ReviewType>("pull_request");
  const [selectedRefs, setSelectedRefs] = useState<Partial<Record<ReviewType, string>>>({});
  const viewerId = useId();
  const tasks = useQuery({
    queryKey: ["console", "tasks"],
    queryFn: ({ signal }) => investigationApi.tasks(undefined, signal),
    enabled: !!repository && session.authenticated,
    retry: false,
  });
  const repositoryTasks =
    tasks.data?.items.filter((task) => task.repository.id === repository?.id) ?? [];
  const recordsByType = {
    pull_request: promptRecords(repositoryTasks, "pull_request"),
    issue: promptRecords(repositoryTasks, "issue"),
  };
  const records = recordsByType[selectedType];
  const selected =
    records.find((record) => record.key === selectedRefs[selectedType]) ?? records[0];
  const prompt = selected?.task.promptRef;
  const title = (kind: ReviewType) =>
    kind === "pull_request" ? text("PR Review", "PR review") : text("Issue 分诊", "Issue triage");
  const loading = !!repository && tasks.isPending;
  const noReference = text("尚无可用引用", "No recorded reference");
  const unavailable = text("未提供", "Unavailable");

  return (
    <div className="console-prompts">
      <fieldset className="console-prompts-types" aria-label={text("Review 类型", "Review type")}>
        {(["pull_request", "issue"] as const).map((kind) => {
          const recent = recordsByType[kind][0]?.task.promptRef;
          const active = selectedType === kind;
          return (
            <button
              type="button"
              key={kind}
              className={`console-prompts-type${active ? " is-selected" : ""}`}
              aria-pressed={active}
              aria-controls={viewerId}
              onClick={() => setSelectedType(kind)}
            >
              <span className={`console-prompts-type-icon is-${kind}`}>
                <ConsoleIcon name={kind === "pull_request" ? "merge" : "adjust"} size={22} />
              </span>
              <span className="console-prompts-type-copy">
                <span className="console-prompts-type-title">{title(kind)}</span>
                <span
                  className="console-prompts-type-ref"
                  title={recent ? `${recent.id} · v${recent.version}` : undefined}
                >
                  {recent
                    ? `${recent.id} · v${recent.version}`
                    : loading
                      ? text("读取中…", "Loading…")
                      : noReference}
                </span>
              </span>
              <span className={`console-prompts-type-badge${recent ? " has-reference" : ""}`}>
                {recent
                  ? text(`最近记录 v${recent.version}`, `Last recorded v${recent.version}`)
                  : loading
                    ? text("读取中", "Loading")
                    : unavailable}
              </span>
            </button>
          );
        })}
      </fieldset>

      <section
        className="console-prompts-viewer"
        id={viewerId}
        aria-label={text("Prompt 查看器", "Prompt viewer")}
      >
        <div className="console-prompts-viewer-header">
          <ConsoleIcon name="description" size={18} />
          <span className="console-prompts-path" title={prompt?.id}>
            {prompt?.id ?? text("Prompt 引用", "Prompt reference")}
          </span>
          {records.length > 0 && (
            <fieldset
              className="console-prompts-versions"
              aria-label={text("已记录的 Prompt 引用", "Recorded prompt references")}
            >
              {records.map((record, index) => (
                <button
                  type="button"
                  key={record.key}
                  className={selected?.key === record.key ? "is-selected" : undefined}
                  aria-pressed={selected?.key === record.key}
                  title={`${record.task.promptRef.id} · v${record.task.promptRef.version} · ${record.task.promptRef.digest}`}
                  onClick={() =>
                    setSelectedRefs((current) => ({ ...current, [selectedType]: record.key }))
                  }
                >
                  {records.some((other) => other.task.promptRef.id !== record.task.promptRef.id)
                    ? `${record.task.promptRef.id} · v${record.task.promptRef.version}`
                    : `v${record.task.promptRef.version}`}
                  {records.some(
                    (other) =>
                      other.key !== record.key &&
                      other.task.promptRef.id === record.task.promptRef.id &&
                      other.task.promptRef.version === record.task.promptRef.version,
                  ) && ` · ${record.task.promptRef.digest.slice(0, 7)}`}
                  {index === 0 && ` · ${text("最近记录", "last recorded")}`}
                </button>
              ))}
            </fieldset>
          )}
          <span className="console-prompts-readonly">{text("只读", "Read only")}</span>
        </div>

        <div className="console-prompts-body" aria-busy={loading}>
          <h2>{title(selectedType)}</h2>
          {loading && (
            <p className="console-prompts-state" role="status">
              <span className="console-prompts-spinner" aria-hidden="true" />
              {text(
                "正在读取 Review 记录的 Prompt 引用…",
                "Loading prompt references recorded by reviews…",
              )}
            </p>
          )}
          {tasks.isError && repository && (
            <div className="console-prompts-error" role="alert">
              <ConsoleIcon name="error" size={20} />
              <span>
                {text(
                  "无法读取最近 Review 的 Prompt 引用。",
                  "Could not load prompt references from recent reviews.",
                )}
              </span>
              <button
                type="button"
                onClick={() => void tasks.refetch()}
                disabled={tasks.isFetching}
              >
                {tasks.isFetching ? text("读取中…", "Loading…") : text("重试", "Retry")}
              </button>
            </div>
          )}
          {!repository && (
            <p>
              {text(
                "选择仓库后查看 Review 记录的 Prompt 引用。",
                "Select a repository to view prompt references recorded by reviews.",
              )}
            </p>
          )}

          {selected && (
            <>
              <p>
                {text(
                  "以下引用来自此仓库的历史 Review，不代表当前默认配置。",
                  "This reference was recorded by a review in this repository. It does not establish the current default.",
                )}
              </p>
              <dl className="console-prompts-reference">
                <div>
                  <dt>{text("引用", "Reference")}</dt>
                  <dd>
                    <code>{prompt?.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>{text("版本", "Version")}</dt>
                  <dd>
                    <code>v{prompt?.version}</code>
                  </dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{prompt?.digest}</code>
                  </dd>
                </div>
                <div>
                  <dt>{text("最近记录", "Latest record")}</dt>
                  <dd>
                    {`${selectedType === "pull_request" ? "PR" : "Issue"} #${selected.task.workItem.number}`}
                    <span className="console-prompts-record-time">
                      {new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(selected.task.createdAt))}
                    </span>
                  </dd>
                </div>
              </dl>
            </>
          )}

          <div className="console-prompts-unavailable">
            <ConsoleIcon name="info" size={20} />
            <div>
              <h3>
                {text(
                  "暂不支持内容预览和版本切换",
                  "Content preview and version switching are unavailable",
                )}
              </h3>
              <p>
                {text(
                  "当前服务未提供默认 Prompt 引用、版本列表或 Markdown 内容，控制台暂时无法切换当前版本。",
                  "The service does not expose default prompt references, a version list, or Markdown content. The console cannot change the active version.",
                )}
              </p>
              {!selected && !loading && !tasks.isError && repository && (
                <p>
                  {text(
                    "此类型尚无已记录的 Prompt 引用。",
                    "No prompt reference has been recorded for this review type.",
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <p className="console-prompts-note">
        <ConsoleIcon name="info" size={18} />
        <span>
          {text(
            "每条 Review 保留创建时记录的 Prompt 引用。",
            "Each review retains the prompt reference recorded when it was created.",
          )}
        </span>
      </p>
    </div>
  );
}
