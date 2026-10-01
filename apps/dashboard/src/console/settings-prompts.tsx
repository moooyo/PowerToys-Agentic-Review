import type {
  InvestigationNativePromptContent,
  InvestigationNativePromptKind,
  InvestigationNativePromptVersion,
} from "@agentic-review/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { investigationApi, type Repository } from "@/investigation/api";
import { useGuardedAction, useUnsavedChanges } from "@/investigation/navigation-guard";
import { useInvestigationSession } from "@/investigation/session";
import { InvestigationHttpError } from "@/investigation/transport";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./settings-prompts.css";

type Mode = keyof InvestigationNativePromptContent;
type Draft = { name: string; content: InvestigationNativePromptContent };
const kinds = ["pr-review", "issue-investigate"] as const;

export default function SettingsPrompts({ repository }: { repository?: Repository }) {
  return <PromptWorkspace key={repository?.id ?? "none"} repository={repository} />;
}

function PromptWorkspace({ repository }: { repository?: Repository }) {
  const { language, text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const queryClient = useQueryClient();
  const [selectedType, setSelectedType] = useState<InvestigationNativePromptKind>("pr-review");
  const [selectedIds, setSelectedIds] = useState<
    Partial<Record<InvestigationNativePromptKind, string>>
  >({});
  const [mode, setMode] = useState<Mode>("localCheckout");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"publish" | "bind" | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const viewerId = useId();
  const mounted = useRef(true);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice?.error) noticeRef.current?.focus();
  }, [notice]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = `native-prompts:${repository?.id ?? "none"}`;
  const guarded = useGuardedAction(scope);
  useUnsavedChanges(draft !== null, {
    scope,
    busy: busy !== null,
    description: text(
      "Review Prompt 版本草稿尚未发布。",
      "The review prompt version draft has not been published.",
    ),
    onDiscard: () => setDraft(null),
  });
  const queryKey = ["console", "native-prompts", repository?.id, session.user?.id];
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => investigationApi.nativePrompts(repository!.id, signal),
    enabled: !!repository && session.authenticated,
    retry: false,
  });
  const record = catalog.data?.items.find((item) => item.kind === selectedType);
  const selected =
    record?.versions.find((version) => version.id === selectedIds[selectedType]) ??
    record?.versions.find((version) => version.id === record.binding.promptRef.id);
  const canManage =
    !!repository &&
    !!session.user?.repositoryIds.includes(repository.id) &&
    !!session.user.permissions.includes("repository:manage");
  const canWrite = canManage && !catalog.isError && !catalog.isFetching;
  const active = selected?.id === record?.binding.promptRef.id;
  const loading = !!repository && catalog.isPending;
  const title = (kind: InvestigationNativePromptKind) =>
    kind === "pr-review" ? text("PR Review", "PR review") : text("Issue 分诊", "Issue triage");
  const modeTitle = (value: Mode) =>
    value === "localCheckout"
      ? text("源代码 Review", "Source review")
      : text("快照分析", "Snapshot analysis");
  const versionName = (version: InvestigationNativePromptVersion) =>
    version.createdBy === null
      ? text("内置 Review Prompt", "Built-in review prompt")
      : version.name;
  const errorMessage = (error: unknown) =>
    error instanceof InvestigationHttpError && error.status === 409
      ? text(
          "版本或绑定已被更新，请刷新目录后重试。",
          "The catalog or binding changed. Refresh the catalog and try again.",
        )
      : error instanceof InvestigationHttpError && error.status === 403
        ? text(
            "当前账户没有此仓库的 Prompt 管理权限。",
            "Your account cannot manage prompts for this repository.",
          )
        : text(
            "操作失败，未记录成功。请重试。",
            "The operation failed. No success was recorded. Try again.",
          );
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    const refreshed = await catalog.refetch();
    return !refreshed.isError;
  };
  const switchVersion = async () => {
    if (!repository || !record || !selected || !canWrite || busy) return;
    setBusy("bind");
    setNotice(null);
    try {
      const { id, version, digest } = selected;
      await investigationApi.bindNativePrompt(repository.id, selectedType, {
        expectedVersion: record.binding.version,
        promptRef: { id, version, digest },
      });
      const refreshed = await refresh();
      if (mounted.current)
        setNotice({
          error: !refreshed,
          message: refreshed
            ? text(
                `已切换到 v${version}，后续新建 Review 将使用此版本。`,
                `Switched to v${version}. Future reviews will use this version.`,
              )
            : text(
                `切换到 v${version} 的请求已接受，但目录刷新失败。请刷新目录确认当前绑定。`,
                `The switch to v${version} was accepted, but the catalog refresh failed. Refresh the catalog to confirm the current binding.`,
              ),
        });
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: errorMessage(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const publish = async () => {
    if (!repository || !record || !draft || !canWrite || busy) return;
    setBusy("publish");
    setNotice(null);
    try {
      const version = await investigationApi.publishNativePrompt(repository.id, selectedType, {
        expectedVersion: record.versions[0]!.version,
        name: draft.name,
        content: draft.content,
      });
      const refreshed = await refresh();
      if (mounted.current) {
        setSelectedIds((current) => ({ ...current, [selectedType]: version.id }));
        setDraft(null);
        setNotice({
          error: !refreshed,
          message: refreshed
            ? text(
                `v${version.version} 已发布。选择“设为当前版本”后用于新 Review。`,
                `Published v${version.version}. Select “Set as current version” to use it for new reviews.`,
              )
            : text(
                `v${version.version} 的发布请求已接受，但目录刷新失败。请刷新目录确认新版本。`,
                `Publishing v${version.version} was accepted, but the catalog refresh failed. Refresh the catalog to confirm the new version.`,
              ),
        });
      }
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: errorMessage(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const validDraft =
    draft !== null &&
    draft.name.trim().length > 0 &&
    Object.values(draft.content).every((content) => content.trim().length > 0) &&
    new TextEncoder().encode(JSON.stringify(draft.content)).length <= 64 * 1024;
  const selectVersion = (version: InvestigationNativePromptVersion) =>
    guarded(() => {
      setSelectedIds((current) => ({ ...current, [selectedType]: version.id }));
      setNotice(null);
    });

  return (
    <div className="console-prompts">
      <fieldset className="console-prompts-types" aria-label={text("Review 类型", "Review type")}>
        {kinds.map((kind) => {
          const binding = catalog.data?.items.find((item) => item.kind === kind)?.binding;
          return (
            <button
              type="button"
              key={kind}
              className={`console-prompts-type${selectedType === kind ? " is-selected" : ""}`}
              aria-pressed={selectedType === kind}
              aria-controls={viewerId}
              disabled={busy !== null}
              onClick={() =>
                guarded(() => {
                  setSelectedType(kind);
                  setNotice(null);
                })
              }
            >
              <span
                className={`console-prompts-type-icon is-${kind === "pr-review" ? "pull_request" : "issue"}`}
              >
                <ConsoleIcon name={kind === "pr-review" ? "merge" : "adjust"} size={22} />
              </span>
              <span className="console-prompts-type-copy">
                <span className="console-prompts-type-title">{title(kind)}</span>
                <span className="console-prompts-type-ref" title={binding?.promptRef.id}>
                  {binding?.promptRef.id ??
                    (loading ? text("读取中…", "Loading…") : text("尚无配置", "No configuration"))}
                </span>
              </span>
              {binding && (
                <span className="console-prompts-type-badge has-reference">
                  {text(
                    `当前 v${binding.promptRef.version}`,
                    `Current v${binding.promptRef.version}`,
                  )}
                </span>
              )}
            </button>
          );
        })}
      </fieldset>
      <section
        className="console-prompts-viewer"
        id={viewerId}
        aria-label={text("Review Prompt 模板", "Review prompt template")}
      >
        <div className="console-prompts-viewer-header">
          <ConsoleIcon name="description" size={18} />
          <span className="console-prompts-path" title={selected?.id}>
            {selected
              ? `${versionName(selected)} · v${selected.version}`
              : text("Review Prompt 模板", "Review prompt template")}
          </span>
          {selected && (
            <span className="console-prompts-readonly">
              {text("已发布版本只读", "Published versions are read only")}
            </span>
          )}
        </div>
        <div className="console-prompts-body" aria-busy={loading || busy !== null}>
          <h2>{title(selectedType)}</h2>
          {loading && (
            <p className="console-prompts-state" role="status">
              <span className="console-prompts-spinner" aria-hidden="true" />
              {text("正在读取原生 Prompt 目录…", "Loading the native prompt catalog…")}
            </p>
          )}
          {catalog.isError && repository && (
            <div className="console-prompts-error" role="alert">
              <ConsoleIcon name="error" size={20} />
              <span>
                {text("无法读取原生 Prompt 目录。", "Could not load the native prompt catalog.")}
              </span>
              <button
                type="button"
                onClick={() => void catalog.refetch()}
                disabled={catalog.isFetching}
              >
                {text("重试", "Retry")}
              </button>
            </div>
          )}
          {!repository && (
            <p>
              {text(
                "选择仓库后管理 PR 和 Issue 的 Review Prompt。",
                "Select a repository to manage PR and Issue review prompts.",
              )}
            </p>
          )}
          {notice && (
            <div
              ref={noticeRef}
              tabIndex={-1}
              className={notice.error ? "console-prompts-error" : "console-prompts-success"}
              role={notice.error ? "alert" : "status"}
            >
              <ConsoleIcon name={notice.error ? "error" : "check"} size={18} />
              <span>{notice.message}</span>
              {notice.error && (
                <button
                  type="button"
                  disabled={catalog.isFetching || busy !== null}
                  onClick={() => void catalog.refetch()}
                >
                  {text("刷新目录", "Refresh catalog")}
                </button>
              )}
            </div>
          )}
          {record && selected && (
            <>
              <p>
                {text(
                  "切换当前版本会影响此仓库后续新建的 Review。已有 Review 保留创建时冻结的版本和内容。",
                  "The current version applies to future reviews in this repository. Existing reviews retain their frozen version and content.",
                )}
              </p>
              <label className="console-prompts-directory" htmlFor={`${viewerId}-version`}>
                <span>{text("版本目录", "Version catalog")}</span>
                <select
                  id={`${viewerId}-version`}
                  value={selected.id}
                  disabled={busy !== null || draft !== null}
                  onChange={(event) => {
                    const version = record.versions.find(
                      (entry) => entry.id === event.target.value,
                    );
                    if (version) selectVersion(version);
                  }}
                >
                  {record.versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {`v${version.version} · ${versionName(version)}${version.id === record.binding.promptRef.id ? ` · ${text("当前版本", "current")}` : ""}`}
                    </option>
                  ))}
                </select>
              </label>
              <dl className="console-prompts-reference">
                <div>
                  <dt>{text("版本引用", "Version reference")}</dt>
                  <dd>
                    <code>{selected.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{selected.digest}</code>
                  </dd>
                </div>
                <div>
                  <dt>
                    {selected.createdBy === null
                      ? text("内置登记", "Registered")
                      : text("发布时间", "Published")}
                  </dt>
                  <dd>
                    {new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(selected.createdAt))}
                  </dd>
                </div>
              </dl>
              <div className="console-prompts-actions">
                <span className="console-prompts-binding">
                  {text(
                    `当前绑定 v${record.binding.promptRef.version}`,
                    `Current binding v${record.binding.promptRef.version}`,
                  )}
                </span>
                <button
                  type="button"
                  className="console-prompts-secondary"
                  disabled={!canManage || !!busy || !!draft}
                  onClick={() => {
                    setDraft({ name: "", content: structuredClone(selected.content) });
                    setNotice(null);
                  }}
                >
                  {text("创建新版本", "Create new version")}
                </button>
                <button
                  type="button"
                  className="console-prompts-primary"
                  disabled={!canWrite || active || !!busy || !!draft}
                  onClick={() => void switchVersion()}
                >
                  {busy === "bind"
                    ? text("切换中…", "Switching…")
                    : active
                      ? text("当前版本", "Current version")
                      : text("设为当前版本", "Set as current version")}
                </button>
              </div>
              {!canManage && (
                <p>
                  {text(
                    "此账户可查看内容；管理版本需要仓库管理权限。",
                    "This account can view content. Managing versions requires repository management permission.",
                  )}
                </p>
              )}
              <fieldset
                className="console-prompts-versions console-prompts-modes"
                aria-label={text("Prompt 模板模式", "Prompt template mode")}
              >
                {(["localCheckout", "snapshot"] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={mode === value ? "is-selected" : undefined}
                    aria-pressed={mode === value}
                    disabled={busy !== null}
                    onClick={() => setMode(value)}
                  >
                    {modeTitle(value)}
                  </button>
                ))}
              </fieldset>
              {draft ? (
                <div className="console-prompts-draft">
                  <label htmlFor={`${viewerId}-name`}>
                    {text("新版本名称", "New version name")}
                  </label>
                  <input
                    id={`${viewerId}-name`}
                    value={draft.name}
                    maxLength={128}
                    required
                    disabled={busy !== null}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  <label htmlFor={`${viewerId}-content`}>
                    {text(`${modeTitle(mode)}模板全文`, `${modeTitle(mode)} template content`)}
                  </label>
                  <textarea
                    id={`${viewerId}-content`}
                    value={draft.content[mode]}
                    required
                    disabled={busy !== null}
                    spellCheck={false}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        content: { ...draft.content, [mode]: event.target.value },
                      })
                    }
                  />
                  <p>
                    {text(
                      "两个模式一同发布，内容合计最多 64 KiB。发布后不可修改，可另建版本。",
                      "Both modes are published together, up to 64 KiB in total. Published versions are immutable; create another version to make changes.",
                    )}
                  </p>
                  <div className="console-prompts-actions">
                    <button
                      type="button"
                      className="console-prompts-secondary"
                      disabled={busy !== null}
                      onClick={() => setDraft(null)}
                    >
                      {text("放弃草稿", "Discard draft")}
                    </button>
                    <button
                      type="button"
                      className="console-prompts-primary"
                      disabled={!canWrite || !validDraft || busy !== null}
                      onClick={() => void publish()}
                    >
                      {busy === "publish"
                        ? text("发布中…", "Publishing…")
                        : text("发布新版本", "Publish new version")}
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="console-prompts-content">{selected.content[mode]}</pre>
              )}
              <details className="console-prompts-constraints">
                <summary>
                  {text("查看 Worker 固定运行约束", "View fixed Worker runtime constraints")}
                </summary>
                <p>
                  {text(
                    "这些协议、权限和结果规则由 Worker 附加，版本编辑不会移除。任务上下文和此前 Review 基线在运行时填充。",
                    "The Worker appends these protocol, permission, and result rules. Editing a version cannot remove them. Task context and the prior-review baseline are filled at runtime.",
                  )}
                </p>
                <pre className="console-prompts-content">{record.runtimeConstraints[mode]}</pre>
              </details>
            </>
          )}
        </div>
      </section>
      <p className="console-prompts-note">
        <ConsoleIcon name="info" size={18} />
        <span>
          {text(
            "Review Prompt 模板不包含每次运行的源代码和任务数据。",
            "Review prompt templates exclude per-run source code and task data.",
          )}
        </span>
      </p>
    </div>
  );
}
