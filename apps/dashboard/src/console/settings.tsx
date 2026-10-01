import {
  type InvestigationTaskV1,
  type InvestigationWorkerControl,
  isInvestigationStaticTaskKind,
} from "@agentic-review/contracts";
import { Dialog, DialogActions, DialogContent, DialogTitle, Snackbar } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  investigationApi,
  type Repository,
  type RepositoryAutoReplySettings,
  type RepositoryWebhookSettings,
} from "../investigation/api";
import { autoReplySettingsQueryKey } from "../investigation/auto-reply-settings";
import {
  type AutoReplySettingsFormValues,
  type AutoReplyTemplateKey,
  autoReplyProgressStages,
  autoReplyProgressTemplateTokens,
  autoReplySettingsFieldErrors,
  autoReplySettingsFormValues,
  autoReplySettingsPermissions,
  autoReplyTemplateTokens,
  autoReplyTemplateValue,
  issueAutoReplyTemplateTokens,
  submitAutoReplySettings,
} from "../investigation/auto-reply-settings-form";
import { useGuardedAction, useUnsavedChanges } from "../investigation/navigation-guard";
import { schedulerQueryKey, submitStaticConcurrency } from "../investigation/scheduler-panel";
import { useInvestigationSession } from "../investigation/session";
import { InvestigationHttpError } from "../investigation/transport";
import { webhookSettingsQueryKey } from "../investigation/webhook-settings";
import {
  parseGitHubUserIds,
  submitWebhookSettings,
  webhookSettingsFieldErrors,
  webhookSettingsFormIsDirty,
  webhookSettingsFormValues,
} from "../investigation/webhook-settings-form";
import { workerAdmissionInput, workersQueryKey } from "../investigation/workers-page";
import { formatDuration, stageLabel } from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import { AccountsSettings, ProfileSettings } from "./settings-accounts";
import PromptSettings from "./settings-prompts";
import { defaultReplyTemplates } from "./settings-template-defaults";
import "./settings.css";

type SettingsSection =
  | "intake"
  | "replies"
  | "prompts"
  | "execution"
  | "workers"
  | "accounts"
  | "profile";
type DraftBar = {
  dirty: boolean;
  busy: boolean;
  valid: boolean;
  save: () => void;
  discard: () => void;
};
type Text = (zh: string, en: string) => string;

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function relativeTime(value: string | null, text: Text): string {
  if (!value || !Number.isFinite(Date.parse(value))) return text("尚未联系", "Never contacted");
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (!minutes) return text("刚刚", "Just now");
  if (minutes < 60) return text(`${minutes} 分钟前`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text(`${hours} 小时前`, `${hours} hr ago`);
  return text(`${Math.floor(hours / 24)} 天前`, `${Math.floor(hours / 24)} days ago`);
}

function Notice({
  children,
  error = false,
  action,
}: {
  children: ReactNode;
  error?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      className={`console-settings-notice${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <ConsoleIcon name={error ? "error" : "info"} size={18} />
      <span>{children}</span>
      {action}
    </div>
  );
}

function QueryState({
  pending,
  error,
  retry,
}: {
  pending: boolean;
  error: Error | null;
  retry: () => void;
}) {
  const { text } = useConsolePreferences();
  if (pending)
    return (
      <div className="console-settings-loading" role="status">
        <span className="console-settings-spinner" />
        {text("正在加载设置…", "Loading settings…")}
      </div>
    );
  if (error)
    return (
      <Notice
        error
        action={
          <button type="button" className="console-settings-button" onClick={retry}>
            {text("重试", "Retry")}
          </button>
        }
      >
        {error.message}
      </Notice>
    );
  return null;
}

export function SettingsSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`console-settings-switch${checked ? " on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span>{checked && <ConsoleIcon name="check" size={16} />}</span>
    </button>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  mono,
  error,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  mono?: boolean;
  error?: boolean;
}) {
  return (
    <div className="console-settings-toggle-row">
      <div>
        <div className="console-settings-row-title">{title}</div>
        <div
          className={`console-settings-row-description${mono ? " mono" : ""}${error ? " error" : ""}`}
        >
          {description}
        </div>
      </div>
      <SettingsSwitch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </div>
  );
}

function IntakeSettings({
  repository,
  onDraft,
  onToast,
}: {
  repository: Repository;
  onDraft: (bar: DraftBar | null) => void;
  onToast: (message: string) => void;
}) {
  const { session } = useInvestigationSession();
  const query = useQuery({
    queryKey: webhookSettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryWebhookSettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const deliveries = useQuery({
    queryKey: ["console", "recent-intake", repository.id],
    queryFn: () => investigationApi.webhookDeliveries({ repositoryId: repository.id, limit: 8 }),
    refetchInterval: 10_000,
  });
  return (
    <>
      <QueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      />
      {query.data && (
        <IntakeForm
          repository={repository}
          settings={query.data}
          canManage={!!session.user?.permissions.includes("repository:manage")}
          onDraft={onDraft}
          onToast={onToast}
        />
      )}
      <RecentIntake repository={repository} query={deliveries} />
    </>
  );
}

function IntakeForm({
  repository,
  settings,
  canManage,
  onDraft,
  onToast,
}: {
  repository: Repository;
  settings: RepositoryWebhookSettings;
  canManage: boolean;
  onDraft: (bar: DraftBar | null) => void;
  onToast: (message: string) => void;
}) {
  const { text } = useConsolePreferences();
  const client = useQueryClient();
  const mounted = useMounted();
  const lock = useRef(false);
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => webhookSettingsFormValues(settings));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [newId, setNewId] = useState("");
  const [newIdError, setNewIdError] = useState<string>();
  const dirty = webhookSettingsFormIsDirty(form, saved);
  const fieldErrors = webhookSettingsFieldErrors(form);
  const valid = !Object.keys(fieldErrors).length;
  const discard = useCallback(() => {
    setForm(webhookSettingsFormValues(saved));
    setNewId("");
    setNewIdError(undefined);
    setError(undefined);
  }, [saved]);
  useUnsavedChanges(dirty, {
    busy,
    description: text("事件接收有未保存的更改。", "Event intake has unsaved changes."),
    onDiscard: discard,
    allowPresentationNavigation: true,
    presentationParameters: ["section"],
  });
  useEffect(() => {
    if (settings.version <= saved.version || busy) return;
    if (dirty) setConflict(true);
    else {
      setSaved(settings);
      setForm(webhookSettingsFormValues(settings));
      setConflict(false);
    }
  }, [settings, saved.version, busy, dirty]);
  const accept = useCallback(
    (updated: RepositoryWebhookSettings) => {
      setSaved(updated);
      setForm(webhookSettingsFormValues(updated));
      setConflict(false);
      client.setQueryData(webhookSettingsQueryKey(repository.id), updated);
    },
    [client, repository.id],
  );
  const save = useCallback(async () => {
    if (lock.current || !canManage || conflict || !valid || !dirty) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await client.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!mounted.current) return;
      const updated = await submitWebhookSettings(
        repository.id,
        form,
        saved,
        conflict,
        investigationApi.updateRepositoryWebhookSettings,
      );
      await client.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      if (!mounted.current) return;
      accept(updated);
      onToast(text("已保存事件接收", "Event intake saved"));
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
      setError(
        cause instanceof Error
          ? cause.message
          : text("事件接收保存失败。", "Event intake could not be saved."),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [
    canManage,
    conflict,
    valid,
    dirty,
    client,
    repository.id,
    form,
    saved,
    mounted,
    onToast,
    text,
    accept,
  ]);
  useEffect(() => {
    onDraft({
      dirty,
      busy,
      valid: valid && canManage && !conflict,
      save: () => void save(),
      discard,
    });
  }, [dirty, busy, valid, canManage, conflict, save, discard, onDraft]);
  useEffect(() => () => onDraft(null), [onDraft]);
  const reload = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await client.cancelQueries({ queryKey: webhookSettingsQueryKey(repository.id) });
      const updated = await investigationApi.repositoryWebhookSettings(repository.id);
      if (updated.version < saved.version)
        throw new Error(
          text(
            "服务端返回了旧设置，请稍后重试。",
            "The service returned older settings. Try again.",
          ),
        );
      if (mounted.current) {
        accept(updated);
        onToast(text("已重新加载设置", "Settings reloaded"));
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : text("重新加载失败。", "Reload failed."));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = !canManage || busy || conflict;
  const actorIds = form.allowedActorUserIdsText.split(/\s+/u).filter(Boolean);
  const addActor = () => {
    try {
      const values = parseGitHubUserIds(newId.trim());
      if (values.length !== 1) throw new Error("single");
      if (actorIds.includes(String(values[0]))) {
        setNewIdError(text("已在列表中", "Already in the list"));
        return;
      }
      if (actorIds.length >= 1024) {
        setNewIdError(text("最多添加 1,024 个用户 ID", "Add up to 1,024 user IDs"));
        return;
      }
      setForm((current) => ({
        ...current,
        allowedActorUserIdsText: [...actorIds, String(values[0])].join("\n"),
      }));
      setNewId("");
      setNewIdError(undefined);
    } catch {
      setNewIdError(text("请输入数字 ID，不是用户名", "Enter a numeric ID, not a username"));
    }
  };
  const webhookUrl =
    typeof window === "undefined"
      ? "/api/github/webhook"
      : new URL("/api/github/webhook", window.location.origin).href;
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      onToast(text("已复制 Webhook 地址", "Webhook URL copied"));
    } catch {
      setError(
        text("无法复制地址，请手动复制。", "The URL could not be copied. Copy it manually."),
      );
    }
  };
  return (
    <>
      <div className="console-settings-webhook console-settings-muted-card">
        <span className="console-settings-leading-icon">
          <ConsoleIcon name="webhook" size={22} />
        </span>
        <div className="console-settings-grow">
          <div className="console-settings-mono console-settings-ellipsis">{webhookUrl}</div>
          <div className={`console-settings-status${saved.receiverConfigured ? " success" : ""}`}>
            <span className="console-settings-dot" />
            {saved.receiverConfigured
              ? text("接收器已配置", "Receiver configured")
              : text("接收器尚未配置", "Receiver not configured")}
          </div>
        </div>
        <button
          type="button"
          className="console-settings-icon-button"
          onClick={() => void copyUrl()}
          aria-label={text("复制 Webhook 地址", "Copy webhook URL")}
        >
          <ConsoleIcon name="content_copy" size={20} />
        </button>
      </div>
      <div className="console-settings-toggle-list">
        <ToggleRow
          title={text("请求 Review 或分配时自动 Review", "Review when requested or assigned")}
          description="pull_request.review_requested · issues.assigned · pull_request.assigned"
          mono
          checked={form.enabled}
          disabled={disabled}
          onChange={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
        />
        <ToggleRow
          title={text("PR 评论触发 E2E", "Trigger E2E from PR comments")}
          description={text(
            "可信用户在 PR 中提及接收账号并评论 e2e",
            "Trusted users mention the reviewer account with e2e in a PR comment",
          )}
          checked={form.e2eEnabled === true}
          disabled={disabled}
          onChange={() => setForm((current) => ({ ...current, e2eEnabled: !current.e2eEnabled }))}
        />
      </div>
      <div className="console-settings-field">
        <label htmlFor="console-reviewer-id">
          {text("接收账号（GitHub 用户 ID）", "Reviewer account (GitHub user ID)")}
        </label>
        <input
          id="console-reviewer-id"
          className="console-settings-numeric"
          value={form.reviewerUserIdText}
          inputMode="numeric"
          disabled={disabled}
          aria-invalid={!!fieldErrors.reviewerUserIdText}
          onChange={(event) =>
            setForm((current) => ({ ...current, reviewerUserIdText: event.target.value }))
          }
        />
        <span className={fieldErrors.reviewerUserIdText ? "error" : ""}>
          {fieldErrors.reviewerUserIdText
            ? text("请输入有效的数字 ID，不是用户名", "Enter a valid numeric ID, not a username")
            : text(
                "保存后按这个 ID 接收 Review 请求和分配",
                "Review requests and assignments use this ID after saving",
              )}
        </span>
      </div>
      <div className="console-settings-trusted">
        <div className="console-settings-label-row">
          <strong>{text("可信请求人和分配人", "Trusted requesters and assigners")}</strong>
          <span>
            {text("只有这些用户的请求会触发 Review", "Only these users can trigger Review")}
          </span>
        </div>
        <div className="console-settings-chip-row">
          {actorIds.map((id) => (
            <span key={id} className="console-settings-trusted-chip">
              <span className="console-settings-avatar small">#</span>
              <span className="console-settings-mono">{id}</span>
              <button
                type="button"
                className="console-settings-icon-button small"
                disabled={disabled}
                aria-label={text(`移除用户 ${id}`, `Remove user ${id}`)}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    allowedActorUserIdsText: actorIds.filter((value) => value !== id).join("\n"),
                  }))
                }
              >
                <ConsoleIcon name="close" size={16} />
              </button>
            </span>
          ))}
        </div>
        <div className="console-settings-add-user">
          <div>
            <input
              aria-label={text("添加 GitHub 用户 ID", "Add GitHub user ID")}
              placeholder={text("添加 GitHub 用户 ID", "Add GitHub user ID")}
              value={newId}
              inputMode="numeric"
              disabled={disabled}
              aria-invalid={!!newIdError}
              onChange={(event) => {
                setNewId(event.target.value);
                setNewIdError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addActor();
                }
              }}
            />
            {newIdError && <span className="error">{newIdError}</span>}
          </div>
          <button
            type="button"
            className="console-settings-button tonal"
            disabled={disabled}
            onClick={addActor}
          >
            <ConsoleIcon name="add" size={18} />
            {text("添加", "Add")}
          </button>
        </div>
      </div>
      {!valid && (
        <div className="console-settings-validation error">
          <ConsoleIcon name="error" size={18} />
          {text(
            "开启前需要接收账号和至少一个可信请求人",
            "A reviewer ID and at least one trusted user are required before enabling intake",
          )}
        </div>
      )}
      {!canManage && (
        <Notice>
          {text(
            "需要管理仓库设置权限才能修改。",
            "Repository management permission is required to make changes.",
          )}
        </Notice>
      )}
      {conflict && (
        <Notice
          action={
            <button
              type="button"
              className="console-settings-button"
              disabled={busy}
              onClick={() => void reload()}
            >
              {text("加载最新设置", "Reload settings")}
            </button>
          }
        >
          {text(
            "设置已被其他人修改。草稿已保留，重新加载后再编辑。",
            "Settings changed elsewhere. Your draft is kept; reload before editing again.",
          )}
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
    </>
  );
}

function RecentIntake({
  repository,
  query,
}: {
  repository: Repository;
  query: ReturnType<
    typeof useQuery<Awaited<ReturnType<typeof investigationApi.webhookDeliveries>>>
  >;
}) {
  const { text } = useConsolePreferences();
  const navigate = useNavigate();
  const guarded = useGuardedAction();
  return (
    <div className="console-settings-recent">
      <h3>{text("最近接收", "Recently received")}</h3>
      <QueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      />
      {query.data && (
        <div className="console-settings-event-list">
          {query.data.items.length === 0 ? (
            <div className="console-settings-empty">
              {text("尚未收到事件", "No events received yet")}
            </div>
          ) : (
            query.data.items.map((delivery) => {
              const failed = delivery.state === "failed";
              const ignored = delivery.state === "ignored";
              const completed = delivery.state === "completed";
              const recordId =
                delivery.taskId ?? (failed ? `intake:${delivery.canonicalDeliveryId}` : null);
              const clickable = !ignored && recordId !== null;
              const state = completed
                ? text("已创建 Review", "Review created")
                : ignored
                  ? text("已忽略", "Ignored")
                  : failed
                    ? text("接收失败", "Intake failed")
                    : text("正在接收", "Receiving");
              return (
                <button
                  type="button"
                  key={delivery.deliveryId}
                  disabled={!clickable}
                  className="console-settings-event"
                  onClick={() =>
                    recordId &&
                    guarded(() =>
                      navigate(
                        `/inbox?repositoryId=${encodeURIComponent(repository.id)}&recordId=${encodeURIComponent(recordId)}`,
                      ),
                    )
                  }
                >
                  <span
                    className={`console-settings-event-icon ${failed ? "error" : ignored ? "neutral" : "success"}`}
                  >
                    <ConsoleIcon
                      name={
                        failed
                          ? "error"
                          : ignored
                            ? "block"
                            : completed
                              ? "check"
                              : "hourglass_empty"
                      }
                      size={16}
                    />
                  </span>
                  <span className="console-settings-grow">
                    <span className="console-settings-event-title">
                      <code>{delivery.eventName}</code>
                      <strong>#{delivery.number}</strong>
                    </span>
                    <span
                      className={`console-settings-event-status ${failed ? "error" : ignored ? "" : "success"}`}
                    >
                      {delivery.totalAttempts > 1 ? text("已重试 · ", "Retried · ") : ""}
                      {state}
                      {delivery.reason ? ` · ${delivery.reason}` : ""}
                    </span>
                  </span>
                  <span className="console-settings-event-time">
                    {relativeTime(delivery.receivedAt, text)}
                  </span>
                  <ConsoleIcon
                    className={clickable ? "" : "console-settings-invisible"}
                    name="chevron_right"
                    size={18}
                  />
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const templateKeys: AutoReplyTemplateKey[] = ["pullRequest", "issue", ...autoReplyProgressStages];
function replyDirty(form: AutoReplySettingsFormValues, saved: RepositoryAutoReplySettings) {
  return JSON.stringify(form) !== JSON.stringify(autoReplySettingsFormValues(saved));
}

function ReplySettings({
  repository,
  onDraft,
  onToast,
}: {
  repository: Repository;
  onDraft: (bar: DraftBar | null) => void;
  onToast: (message: string) => void;
}) {
  const query = useQuery({
    queryKey: autoReplySettingsQueryKey(repository.id),
    queryFn: () => investigationApi.repositoryAutoReplySettings(repository.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <>
      <QueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      />
      {query.data && (
        <ReplyForm
          repository={repository}
          settings={query.data}
          onDraft={onDraft}
          onToast={onToast}
        />
      )}
    </>
  );
}

function ReplyForm({
  repository,
  settings,
  onDraft,
  onToast,
}: {
  repository: Repository;
  settings: RepositoryAutoReplySettings;
  onDraft: (bar: DraftBar | null) => void;
  onToast: (message: string) => void;
}) {
  const { text, language } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const permissions = autoReplySettingsPermissions(repository.id, session.user);
  const mounted = useMounted();
  const lock = useRef(false);
  const client = useQueryClient();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState(() => autoReplySettingsFormValues(settings));
  const [template, setTemplate] = useState<AutoReplyTemplateKey>("pullRequest");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [authorization, setAuthorization] = useState<{
    form: AutoReplySettingsFormValues;
    saved: RepositoryAutoReplySettings;
    renew: boolean;
  }>();
  const replies = useQuery({
    queryKey: ["investigation-auto-replies", repository.id],
    queryFn: () => investigationApi.repositoryAutoReplies(repository.id),
  });
  const dirty = replyDirty(form, saved);
  const errors = autoReplySettingsFieldErrors(form);
  const valid = !Object.keys(errors).length;
  const discard = useCallback(() => {
    setForm(autoReplySettingsFormValues(saved));
    setError(undefined);
    setAuthorization(undefined);
  }, [saved]);
  useUnsavedChanges(dirty, {
    busy,
    onDiscard: discard,
    description: text("自动回复有未保存的更改。", "Automatic replies have unsaved changes."),
    allowPresentationNavigation: true,
    presentationParameters: ["section"],
  });
  useEffect(() => {
    if (settings.version <= saved.version || busy) return;
    setAuthorization(undefined);
    if (dirty) setConflict(true);
    else {
      setSaved(settings);
      setForm(autoReplySettingsFormValues(settings));
      setConflict(false);
    }
  }, [settings, saved.version, busy, dirty]);
  const save = useCallback(
    async (submittedForm = form, submittedSaved = saved, renew = false) => {
      if (
        lock.current ||
        conflict ||
        !permissions.canManage ||
        !valid ||
        ((submittedForm.enabled || renew) && !permissions.canAuthorize)
      )
        return;
      lock.current = true;
      setBusy(true);
      setError(undefined);
      setAuthorization(undefined);
      try {
        await client.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
        if (!mounted.current) return;
        const updated = await submitAutoReplySettings(
          repository.id,
          submittedForm,
          submittedSaved,
          conflict,
          { canManage: permissions.canManage, canAuthorize: permissions.canAuthorize },
          investigationApi.updateRepositoryAutoReplySettings,
          renew,
        );
        await client.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
        if (!mounted.current) return;
        setSaved(updated);
        setForm(autoReplySettingsFormValues(updated));
        setConflict(false);
        client.setQueryData(autoReplySettingsQueryKey(repository.id), updated);
        void client.invalidateQueries({ queryKey: ["investigation-comments"] });
        void client.invalidateQueries({ queryKey: ["investigation-comment"] });
        onToast(
          renew
            ? text("已重新授权自动回复", "Automatic replies reauthorized")
            : text("已保存自动回复", "Automatic replies saved"),
        );
      } catch (cause) {
        if (!mounted.current) return;
        if (cause instanceof InvestigationHttpError && cause.status === 409) setConflict(true);
        setError(
          cause instanceof Error
            ? cause.message
            : text("自动回复保存失败。", "Automatic replies could not be saved."),
        );
      } finally {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [
      conflict,
      permissions.canManage,
      permissions.canAuthorize,
      valid,
      client,
      repository.id,
      form,
      saved,
      mounted,
      text,
      onToast,
    ],
  );
  const requestSave = useCallback(
    (renew = false) => {
      if (
        !valid ||
        conflict ||
        busy ||
        !permissions.canManage ||
        ((form.enabled || renew) && !permissions.canAuthorize)
      )
        return;
      if (
        form.enabled &&
        (renew || !saved.enabled || form.progressEnabled !== saved.progressEnabled)
      ) {
        setAuthorization({
          form: { ...form, progressTemplates: { ...form.progressTemplates } },
          saved: { ...saved, progressTemplates: { ...saved.progressTemplates } },
          renew,
        });
      } else void save(form, saved, renew);
    },
    [valid, conflict, busy, permissions.canManage, permissions.canAuthorize, form, saved, save],
  );
  useEffect(() => {
    onDraft({
      dirty,
      busy,
      valid:
        valid && permissions.canManage && !conflict && (!form.enabled || permissions.canAuthorize),
      save: () => requestSave(),
      discard,
    });
  }, [
    dirty,
    busy,
    valid,
    permissions.canManage,
    permissions.canAuthorize,
    conflict,
    form.enabled,
    requestSave,
    discard,
    onDraft,
  ]);
  useEffect(() => () => onDraft(null), [onDraft]);
  const reload = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await client.cancelQueries({ queryKey: autoReplySettingsQueryKey(repository.id) });
      const updated = await investigationApi.repositoryAutoReplySettings(repository.id);
      if (updated.version < saved.version)
        throw new Error(
          text(
            "服务端返回了旧设置，请稍后重试。",
            "The service returned older settings. Try again.",
          ),
        );
      if (!mounted.current) return;
      setSaved(updated);
      setForm(autoReplySettingsFormValues(updated));
      setConflict(false);
      setAuthorization(undefined);
      client.setQueryData(autoReplySettingsQueryKey(repository.id), updated);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : text("重新加载失败。", "Reload failed."));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const labels: Record<AutoReplyTemplateKey, string> = {
    pullRequest: text("PR 结论", "PR conclusion"),
    issue: text("Issue 结论", "Issue conclusion"),
    received: text("已接收", "Received"),
    started: text("已开始", "Started"),
    failed: text("已停止", "Stopped"),
    completed: text("已完成", "Completed"),
  };
  const value = autoReplyTemplateValue(form, template);
  const tokens: readonly string[] =
    template === "pullRequest"
      ? autoReplyTemplateTokens
      : template === "issue"
        ? issueAutoReplyTemplateTokens
        : autoReplyProgressTemplateTokens[template];
  const setTemplateValue = (newValue: string) =>
    setForm((current) =>
      template === "pullRequest"
        ? { ...current, pullRequestTemplate: newValue }
        : template === "issue"
          ? { ...current, issueTemplate: newValue }
          : {
              ...current,
              progressTemplates: { ...current.progressTemplates, [template]: newValue },
            },
    );
  const latestReply = [...(replies.data?.items ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  const blocked = latestReply && ["blocked", "failed"].includes(latestReply.state);
  const disabled = busy || conflict || !permissions.canManage;
  const authorizationDate = saved.updatedAt
    ? new Date(saved.updatedAt).toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", {
        month: "short",
        day: "numeric",
      })
    : "";
  return (
    <>
      <div className="console-settings-publisher console-settings-muted-card">
        <div className="console-settings-publisher-header">
          <span className="console-settings-bot-avatar">
            <ConsoleIcon name="smart_toy" size={20} />
          </span>
          <div className="console-settings-grow">
            <strong>{text("GitHub 发布账号", "GitHub publishing account")}</strong>
            <div
              className={`console-settings-status${saved.publisherConfigured ? " success" : ""}`}
            >
              <ConsoleIcon
                name={saved.publisherConfigured ? "verified" : "info"}
                size={16}
                filled
              />
              {saved.publisherConfigured
                ? text("发布器已配置", "Publisher configured")
                : text("发布器尚未配置", "Publisher not configured")}{" "}
              ·{" "}
              {saved.enabled && saved.authorizedById
                ? text("自动写入已授权", "Automatic writes authorized")
                : text("自动写入未开启", "Automatic writes disabled")}
            </div>
          </div>
        </div>
        <div className="console-settings-authorization">
          <span>
            {saved.authorizedById
              ? text(
                  `由账号 ${saved.authorizedById} 授权`,
                  `Authorized by account ${saved.authorizedById}`,
                )
              : text("尚未记录发布授权", "No publishing authorization recorded")}
            {authorizationDate && ` · ${text("更新于", "Updated")} ${authorizationDate}`}
          </span>
          <button
            type="button"
            className="console-settings-button"
            disabled={disabled || !permissions.canAuthorize || !form.enabled}
            onClick={() => requestSave(true)}
          >
            {text("重新授权", "Reauthorize")}
          </button>
        </div>
        {blocked && (
          <Notice error>
            {text("最近一次发布未成功", "The latest publication did not succeed")}
            {latestReply.reason ? `：${latestReply.reason}` : ""}
          </Notice>
        )}
      </div>
      <div className="console-settings-toggle-list">
        <ToggleRow
          title={text("自动发布结论", "Automatically publish conclusions")}
          description={text(
            "仅完整的 PR Review 和 Issue 分诊",
            "Completed PR Reviews and Issue triage only",
          )}
          checked={form.enabled}
          disabled={disabled || (!permissions.canAuthorize && !form.enabled)}
          onChange={() =>
            setForm((current) => ({
              ...current,
              enabled: !current.enabled,
              progressEnabled: !current.enabled && current.progressEnabled,
            }))
          }
        />
        <ToggleRow
          title={text("在同一条评论中更新进度", "Update progress in the same comment")}
          description={
            errors.progressEnabled
              ? text("需要先开启自动发布结论", "Enable automatic conclusions first")
              : text("已接收 → 已开始 → 结论", "Received → Started → Conclusion")
          }
          error={!!errors.progressEnabled}
          checked={form.progressEnabled}
          disabled={disabled || !permissions.canAuthorize}
          onChange={() =>
            setForm((current) => ({ ...current, progressEnabled: !current.progressEnabled }))
          }
        />
      </div>
      <div className="console-settings-template-card">
        <div className="console-settings-template-header">
          <h3>{text("评论模板", "Comment templates")}</h3>
          <button
            type="button"
            className="console-settings-button"
            disabled={disabled}
            onClick={() => setTemplateValue(defaultReplyTemplates[template])}
          >
            <ConsoleIcon name="restart_alt" size={18} />
            {text("恢复默认", "Restore default")}
          </button>
        </div>
        <fieldset
          className="console-settings-chip-row"
          aria-label={text("评论模板", "Comment templates")}
        >
          {templateKeys.map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={key === template}
              aria-controls="console-template-editor"
              className={`console-settings-template-chip${key === template ? " selected" : ""}`}
              onClick={() => setTemplate(key)}
            >
              {errors[key] && key !== template && <span className="console-settings-dot error" />}
              {labels[key]}
            </button>
          ))}
        </fieldset>
        <div className="console-settings-chip-row">
          {tokens.map((token) => {
            const matches = [...value.matchAll(/\{\{([^{}]*)\}\}/gu)];
            const index = matches.findIndex((match) => match[1] === token);
            const required = matches.filter((match) => match[1] !== "status");
            const ok =
              matches.filter((match) => match[1] === token).length === 1 &&
              index >= 0 &&
              required[tokens.indexOf(token)]?.[1] === token;
            return (
              <span key={token} className={`console-settings-token${ok ? " valid" : " invalid"}`}>
                <ConsoleIcon name={ok ? "check" : "close"} size={14} />
                {token}
              </span>
            );
          })}
        </div>
        <textarea
          id="console-template-editor"
          aria-label={labels[template]}
          rows={11}
          spellCheck={false}
          disabled={disabled}
          aria-invalid={!!errors[template]}
          value={value}
          onChange={(event) => setTemplateValue(event.target.value)}
        />
        <div className={`console-settings-validation${errors[template] ? " error" : " success"}`}>
          <ConsoleIcon name={errors[template] ? "error" : "check_circle"} size={18} />
          {errors[template]
            ? localizedTemplateError(errors[template], text)
            : text(
                "格式正确 · 每个占位符出现一次并按顺序排列",
                "Valid format · Each placeholder appears once, in order",
              )}
        </div>
      </div>
      {!permissions.canManage && (
        <Notice>
          {text(
            "需要管理仓库设置权限才能修改。",
            "Repository management permission is required to make changes.",
          )}
        </Notice>
      )}
      {permissions.canManage && !permissions.canAuthorize && (
        <Notice>
          {text(
            "开启或重新授权自动回复需要准备操作、执行操作和发布评论权限。",
            "Enabling or renewing automatic replies requires action preparation, execution, and comment permissions.",
          )}
        </Notice>
      )}
      {conflict && (
        <Notice
          action={
            <button
              type="button"
              className="console-settings-button"
              disabled={busy}
              onClick={() => void reload()}
            >
              {text("加载最新设置", "Reload settings")}
            </button>
          }
        >
          {text(
            "设置已被其他人修改。草稿已保留，重新加载后再编辑。",
            "Settings changed elsewhere. Your draft is kept; reload before editing again.",
          )}
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <Dialog
        open={!!authorization}
        onClose={() => !busy && setAuthorization(undefined)}
        className="console-settings-dialog"
        maxWidth="sm"
        fullWidth
        aria-labelledby="console-reply-authorization-title"
      >
        <DialogTitle id="console-reply-authorization-title">
          {authorization?.renew
            ? text("重新授权自动回复？", "Reauthorize automatic replies?")
            : text("授权自动回复？", "Authorize automatic replies?")}
        </DialogTitle>
        <DialogContent>
          <p>
            {text(
              `保存模板并授权之后在 ${repository.fullName} 发布结论${authorization?.form.progressEnabled ? "和进度更新" : ""}。这些发布不会逐条请求确认。已发布的评论不会因保存设置而重新写入。`,
              `Save these templates and authorize future conclusion comments${authorization?.form.progressEnabled ? " and progress updates" : ""} in ${repository.fullName}. Publications do not request confirmation per report. Saving settings does not rewrite existing comments.`,
            )}
          </p>
        </DialogContent>
        <DialogActions>
          <button
            type="button"
            className="console-settings-button"
            onClick={() => setAuthorization(undefined)}
          >
            {text("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="console-settings-button filled"
            disabled={busy || conflict}
            onClick={() =>
              authorization &&
              void save(authorization.form, authorization.saved, authorization.renew)
            }
          >
            {text("保存并授权", "Save and authorize")}
          </button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function localizedTemplateError(value: string | undefined, text: Text): string {
  if (!value) return "";
  if (value.includes("12,000")) return text("模板不能超过 12,000 UTF-8 字节", value);
  if (value.includes("unknown placeholder"))
    return text("含有未知占位符，请只使用列出的占位符", value);
  const token = value.match(/\{\{[^}]+\}\}/u)?.[0];
  if (value.includes("exactly once"))
    return text(`${token ?? "必需占位符"} 必须恰好出现一次`, value);
  if (value.includes("must order")) return text("必需占位符必须按列出的顺序排列", value);
  if (value.includes("must begin")) return text("模板必须以 {{identity}} 开头", value);
  if (value.includes("must end")) return text("模板必须以 {{details}} 结尾", value);
  if (value.includes("optional {{status}} before"))
    return text("可选的 {{status}} 必须在 {{trigger}} 之前", value);
  if (value.includes("optional {{status}}")) return text("可选的 {{status}} 最多出现一次", value);
  return text("占位符格式不完整，请使用精确的 {{token}} 语法", value);
}

function ExecutionSettings({ onToast }: { onToast: (message: string) => void }) {
  const { text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const mounted = useMounted();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const query = useQuery({
    queryKey: schedulerQueryKey,
    queryFn: investigationApi.scheduler,
    refetchInterval: busy ? false : 5_000,
  });
  const tasks = useQuery({
    queryKey: ["console", "tasks"],
    queryFn: ({ signal }) => investigationApi.tasks(undefined, signal),
    refetchInterval: 5_000,
  });
  useUnsavedChanges(false, { busy });
  const update = async (value: number) => {
    if (lock.current || !session.user?.isAdmin || value < 1 || value > 16) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await client.cancelQueries({ queryKey: schedulerQueryKey });
      const updated = await submitStaticConcurrency(
        String(value),
        investigationApi.updateScheduler,
      );
      await client.cancelQueries({ queryKey: schedulerQueryKey });
      if (!mounted.current) return;
      client.setQueryData(schedulerQueryKey, updated);
      void client.invalidateQueries({ queryKey: ["console", "tasks"] });
      onToast(
        text(
          `静态并发已设为 ${updated.staticConcurrency}`,
          `Static concurrency set to ${updated.staticConcurrency}`,
        ),
      );
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : text("并发更新失败。", "Concurrency could not be updated."),
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const queued = tasks.data?.items.filter(
    (task) =>
      task.state === "queued" &&
      ["pr-review", "issue-investigate"].includes(task.kind) &&
      task.executionPolicy.mode !== "execute",
  ).length;
  return (
    <>
      <QueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      />
      {query.data && (
        <>
          <div className="console-settings-execution">
            <div>
              <h3>{text("静态 Review 并发", "Static Review concurrency")}</h3>
              <p>
                {text(
                  `当前占用 ${query.data.occupiedStatic} / ${query.data.staticConcurrency}`,
                  `${query.data.occupiedStatic} / ${query.data.staticConcurrency} occupied`,
                )}
                {queued === undefined ? "" : text(` · ${queued} 条排队`, ` · ${queued} queued`)}
              </p>
            </div>
            <div className="console-settings-stepper">
              <button
                type="button"
                className="console-settings-icon-button outlined"
                disabled={busy || !session.user?.isAdmin || query.data.staticConcurrency <= 1}
                onClick={() => {
                  if (query.data) void update(query.data.staticConcurrency - 1);
                }}
                aria-label={text("降低静态并发", "Decrease static concurrency")}
              >
                <ConsoleIcon name="remove" size={20} />
              </button>
              <span aria-live="polite">{query.data.staticConcurrency}</span>
              <button
                type="button"
                className="console-settings-icon-button outlined"
                disabled={busy || !session.user?.isAdmin || query.data.staticConcurrency >= 16}
                onClick={() => {
                  if (query.data) void update(query.data.staticConcurrency + 1);
                }}
                aria-label={text("增加静态并发", "Increase static concurrency")}
              >
                <ConsoleIcon name="add" size={20} />
              </button>
            </div>
          </div>
          <p className="console-settings-help">
            {text(
              "立即生效，不会打断进行中的 Review",
              "Takes effect immediately without interrupting running Reviews",
            )}
          </p>
          <div className="console-settings-e2e-capacity">
            <div>
              <h3>{text("E2E 执行", "E2E execution")}</h3>
              <p>{text("1 个独占桌面 · 固定", "1 exclusive desktop · Fixed")}</p>
            </div>
            <ConsoleIcon name="lock" size={20} />
          </div>
        </>
      )}
      {!session.user?.isAdmin && (
        <Notice>
          {text(
            "仅管理员可以调整所有仓库共享的并发。",
            "Only administrators can change the shared concurrency limit.",
          )}
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
    </>
  );
}

function WorkerTaskSummary({
  taskId,
  task,
  cleanup,
}: {
  taskId: string;
  task?: InvestigationTaskV1;
  cleanup: boolean;
}) {
  const { text } = useConsolePreferences();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const detail = useQuery({
    queryKey: ["console", "worker-task", taskId],
    queryFn: ({ signal }) => investigationApi.task(taskId, signal),
    enabled: !!task,
    refetchInterval: 5_000,
  });
  const attempt = detail.data?.attempts
    .filter((entry) => entry.taskId === taskId)
    .sort((left, right) => right.number - left.number)[0];
  const observedUntil = task?.state === "running" ? now : task ? Date.parse(task.updatedAt) : now;
  return (
    <div className="console-settings-worker-task">
      <ConsoleIcon name={cleanup ? "hourglass_empty" : "autorenew"} size={18} />
      <span>{task ? `#${task.workItem.number} ${task.workItem.title}` : taskId}</span>
      <span>
        {cleanup
          ? text("等待清理确认", "Awaiting cleanup")
          : detail.isError
            ? text("阶段信息读取失败", "Stage unavailable")
            : `${stageLabel(detail.data?.progress?.stage ?? undefined, text)}${attempt?.startedAt ? ` · ${formatDuration(observedUntil - Date.parse(attempt.startedAt))}` : ""}`}
      </span>
    </div>
  );
}

function WorkerSettings({ onToast }: { onToast: (message: string) => void }) {
  const { text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const mounted = useMounted();
  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string>();
  const [disableWorker, setDisableWorker] = useState<InvestigationWorkerControl>();
  const [error, setError] = useState<string>();
  const query = useQuery({
    queryKey: workersQueryKey,
    queryFn: investigationApi.workers,
    enabled: session.user?.isAdmin === true,
    refetchInterval: busyId ? false : 10_000,
  });
  const scheduler = useQuery({
    queryKey: schedulerQueryKey,
    queryFn: investigationApi.scheduler,
    enabled: session.user?.isAdmin === true,
    refetchInterval: busyId ? false : 5_000,
  });
  const tasks = useQuery({
    queryKey: ["console", "tasks"],
    queryFn: ({ signal }) => investigationApi.tasks(undefined, signal),
    enabled: session.user?.isAdmin === true,
    refetchInterval: 5_000,
  });
  useUnsavedChanges(false, { busy: !!busyId });
  const update = async (
    worker: InvestigationWorkerControl,
    enabled: boolean,
    confirmed = false,
  ) => {
    if (lock.current || !session.user?.isAdmin) return;
    lock.current = true;
    setBusyId(worker.id);
    setError(undefined);
    setDisableWorker(undefined);
    try {
      const input = workerAdmissionInput(worker, enabled, worker.version, confirmed);
      await client.cancelQueries({ queryKey: workersQueryKey });
      const updated = await investigationApi.updateWorkerE2e(worker.id, input);
      await client.cancelQueries({ queryKey: workersQueryKey });
      if (!mounted.current) return;
      client.setQueryData<Awaited<ReturnType<typeof investigationApi.workers>>>(
        workersQueryKey,
        (current) => ({
          items: (current?.items ?? []).map((item) => (item.id === updated.id ? updated : item)),
        }),
      );
      void client.invalidateQueries({ queryKey: workersQueryKey });
      void client.invalidateQueries({ queryKey: schedulerQueryKey });
      onToast(
        updated.status === "awaiting_confirmation" || updated.status === "disabling"
          ? text(
              `已保存 ${worker.id} 的准入设置，等待 Worker 确认`,
              `${worker.id} admission settings saved; awaiting worker confirmation`,
            )
          : enabled
            ? text(`已允许 ${worker.id} 接收 E2E`, `${worker.id} may admit E2E work`)
            : text(`${worker.id} 已关闭 E2E 准入`, `${worker.id} E2E admission disabled`),
      );
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409) void query.refetch();
      setError(
        cause instanceof Error
          ? cause.message
          : text("Worker 设置更新失败。", "Worker settings could not be updated."),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusyId(undefined);
    }
  };
  if (!session.user?.isAdmin)
    return (
      <Notice>
        {text(
          "需要管理员权限才能查看和管理 Workers。",
          "Administrator access is required to view and manage Workers.",
        )}
      </Notice>
    );
  return (
    <>
      <QueryState
        pending={query.isPending}
        error={query.error}
        retry={() => void query.refetch()}
      />
      {query.data?.items.length === 0 && (
        <div className="console-settings-empty">
          {text("尚未注册 Worker", "No workers registered")}
        </div>
      )}
      {query.data?.items.map((worker) => {
        const recent = !!worker.lastSeenAt && Date.now() - Date.parse(worker.lastSeenAt) < 120_000;
        const owners =
          scheduler.data?.leases.filter(
            (lease) => lease.workerId === worker.id && lease.state !== "released",
          ) ?? [];
        const active = owners.length > 0 || worker.activeE2eTaskIds.length > 0;
        const scopeComplete = worker.repositoryIds.every((id) =>
          session.user?.repositoryIds.includes(id),
        );
        const status = !recent
          ? "offline"
          : active
            ? "working"
            : scopeComplete && scheduler.data && !scheduler.isError
              ? "idle"
              : "unconfirmed";
        const taskId = owners[0]?.taskId ?? worker.activeE2eTaskIds[0];
        const task = tasks.data?.items.find((item) => item.id === taskId);
        const cleanup =
          worker.cleanupPendingAttemptIds.length > 0 ||
          owners.some((lease) => lease.state === "needs_cleanup");
        const awaiting = worker.status === "awaiting_confirmation" || worker.status === "disabling";
        const hasStatic = worker.effectiveKinds.some(isInvestigationStaticTaskKind);
        const hasExecution = worker.effectiveKinds.some(
          (kind) => !isInvestigationStaticTaskKind(kind),
        );
        return (
          <article className="console-settings-worker" key={worker.id}>
            <div className="console-settings-worker-top">
              <span className="console-settings-leading-icon">
                <ConsoleIcon name="computer" size={24} />
              </span>
              <div className="console-settings-grow">
                <div className="console-settings-worker-name">
                  <strong>{worker.id}</strong>
                  <span className={`console-settings-worker-state ${status}`}>
                    <span className="console-settings-dot" />
                    {status === "offline"
                      ? text("无最近联系", "No recent contact")
                      : status === "working"
                        ? text("工作中", "Working")
                        : status === "idle"
                          ? text("空闲", "Idle")
                          : text("状态待确认", "Status unconfirmed")}
                  </span>
                </div>
                <div className="console-settings-row-description">
                  {relativeTime(worker.lastSeenAt, text)} ·{" "}
                  {hasStatic && hasExecution
                    ? text("静态 Review + E2E", "Static Review + E2E")
                    : hasExecution
                      ? "E2E"
                      : hasStatic
                        ? text("静态 Review", "Static Review")
                        : text("执行能力未确认", "Capabilities unconfirmed")}
                </div>
              </div>
              <div className="console-settings-worker-switch">
                <span>{text("允许 E2E", "Allow E2E")}</span>
                <SettingsSwitch
                  label={text(`允许 ${worker.id} 运行 E2E`, `Allow ${worker.id} to run E2E`)}
                  checked={worker.e2eEnabled}
                  disabled={!!busyId || (!worker.e2eEnabled && (cleanup || awaiting))}
                  onChange={() =>
                    worker.e2eEnabled ? setDisableWorker(worker) : void update(worker, true)
                  }
                />
              </div>
            </div>
            {taskId && <WorkerTaskSummary taskId={taskId} task={task} cleanup={cleanup} />}
            {!recent && (
              <div className="console-settings-worker-offline">
                {worker.lastSeenAt
                  ? text(
                      `${relativeTime(worker.lastSeenAt, text)}联系，当前联系状态需确认。`,
                      `Last contact ${relativeTime(worker.lastSeenAt, text)}; current availability is unconfirmed.`,
                    )
                  : text(
                      "尚未收到 Worker 联系，当前可用状态未确认。",
                      "The worker has never contacted the service; availability is unconfirmed.",
                    )}
              </div>
            )}
            {awaiting && (
              <div className="console-settings-worker-pending">
                {text(
                  "已保存准入设置，等待 Worker 确认；执行和清理所有权仍保留。",
                  "Admission policy is saved and awaiting worker confirmation. Execution and cleanup ownership remain held.",
                )}
              </div>
            )}
          </article>
        );
      })}
      {error && <Notice error>{error}</Notice>}
      <Dialog
        open={!!disableWorker}
        onClose={() => setDisableWorker(undefined)}
        className="console-settings-dialog"
        maxWidth="xs"
        fullWidth
        aria-labelledby="console-worker-disable-title"
      >
        <DialogTitle id="console-worker-disable-title">
          {text("关闭 E2E 并请求停止当前执行？", "Disable E2E and request execution to stop?")}
        </DialogTitle>
        <DialogContent>
          <p>
            {text(
              `${disableWorker?.id ?? ""} 的 E2E 准入将关闭；服务会请求停止尚在执行的 E2E 任务。已结束执行的结果仍需发布，桌面和进程的清理所有权会保留至确认。`,
              `E2E admission for ${disableWorker?.id ?? ""} will be disabled, and the service requests active E2E execution to stop. Completed execution results still require delivery. Desktop and process cleanup ownership remains held until confirmed.`,
            )}
          </p>
        </DialogContent>
        <DialogActions>
          <button
            type="button"
            className="console-settings-button"
            onClick={() => setDisableWorker(undefined)}
          >
            {text("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="console-settings-button filled"
            onClick={() => disableWorker && void update(disableWorker, false, true)}
          >
            {text("关闭准入", "Disable admission")}
          </button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default function Settings({
  repository,
  section,
  onSection,
}: {
  repository?: Repository;
  section: string;
  onSection: (section: string) => void;
}) {
  const { text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const [toast, setToast] = useState<string>();
  const [intakeDraft, setIntakeDraft] = useState<DraftBar | null>(null);
  const [replyDraft, setReplyDraft] = useState<DraftBar | null>(null);
  const onToast = useCallback((message: string) => setToast(message), []);
  const workers = useQuery({
    queryKey: workersQueryKey,
    queryFn: investigationApi.workers,
    enabled: session.user?.isAdmin === true,
    refetchInterval: 10_000,
  });
  const labels: Record<SettingsSection, string> = {
    intake: text("事件接收", "Event intake"),
    replies: text("自动回复", "Automatic replies"),
    prompts: "Prompt",
    execution: text("执行", "Execution"),
    workers: "Workers",
    accounts: text("账号", "Accounts"),
    profile: text("我的账号", "My account"),
  };
  const descriptions: Record<SettingsSection, string> = {
    intake: text(
      "PR 或 Issue 收到可信 Review 请求或分配时自动开始 Review",
      "Start Review when a PR or Issue receives a trusted review request or assignment",
    ),
    replies: text(
      "Review 完成后自动把结论发布为 GitHub 评论",
      "Automatically publish conclusions as GitHub comments when Review completes",
    ),
    prompts: text("每类 Review 使用的预定义 Prompt", "Predefined prompts for each type of Review"),
    execution: text("所有仓库共享", "Shared across all repositories"),
    workers: workers.data
      ? text(
          `${workers.data.items.filter((worker) => !!worker.lastSeenAt && Date.now() - Date.parse(worker.lastSeenAt) < 120_000).length} / ${workers.data.items.length} 最近联系`,
          `${workers.data.items.filter((worker) => !!worker.lastSeenAt && Date.now() - Date.parse(worker.lastSeenAt) < 120_000).length} / ${workers.data.items.length} contacted recently`,
        )
      : text("Worker 联系状态和执行准入", "Worker contact status and execution admission"),
    accounts: text("控制台账号和权限", "Console accounts and permissions"),
    profile: "",
  };
  const selected = Object.hasOwn(labels, section) ? (section as SettingsSection) : "intake";
  const groups: { title: string; items: [SettingsSection, string][] }[] = [
    {
      title: text(
        `仓库 · ${repository?.fullName ?? ""}`,
        `Repository · ${repository?.fullName ?? ""}`,
      ),
      items: [
        ["intake", "webhook"],
        ["replies", "forum"],
        ["prompts", "description"],
      ],
    },
    {
      title: text("系统", "System"),
      items: [
        ["execution", "tune"],
        ["workers", "dns"],
        ["accounts", "group"],
      ],
    },
    { title: text("个人", "Personal"), items: [["profile", "person"]] },
  ];
  const online = workers.data?.items.filter(
    (worker) => !!worker.lastSeenAt && Date.now() - Date.parse(worker.lastSeenAt) < 120_000,
  ).length;
  const bar = selected === "intake" ? intakeDraft : selected === "replies" ? replyDraft : null;
  const pages: SettingsSection[] = [
    "intake",
    "replies",
    "prompts",
    "execution",
    "workers",
    "accounts",
    "profile",
  ];
  return (
    <div className="console-settings-layout">
      <nav className="console-settings-navigation" aria-label={text("设置", "Settings")}>
        {groups.map((group) => (
          <div key={group.title}>
            <div className="console-settings-nav-group">{group.title}</div>
            {group.items.map(([key, icon]) => (
              <button
                type="button"
                key={key}
                className={`console-settings-nav-item${selected === key ? " selected" : ""}`}
                onClick={() => onSection(key)}
                aria-current={selected === key ? "page" : undefined}
              >
                <ConsoleIcon name={icon} size={22} filled={selected === key} />
                <span>{labels[key]}</span>
                {((key === "intake" && intakeDraft?.dirty) ||
                  (key === "replies" && replyDraft?.dirty)) && (
                  <span className="console-settings-dot dirty" />
                )}
                {key === "workers" && online !== undefined && (
                  <small>
                    {online}/{workers.data?.items.length}
                  </small>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="console-settings-panel" aria-label={labels[selected]}>
        <div className="console-settings-scroll">
          {pages
            .filter((key) => key === selected || key === "intake" || key === "replies")
            .map((key) => (
              <div className="console-settings-content" hidden={key !== selected} key={key}>
                <header className="console-settings-heading">
                  <h1>{labels[key]}</h1>
                  {descriptions[key] && <p>{descriptions[key]}</p>}
                </header>
                {(key === "intake" || key === "replies") &&
                (!repository || !session.user?.repositoryIds.includes(repository.id)) ? (
                  <Notice>
                    {text("请选择有权限访问的仓库。", "Select a repository you can access.")}
                  </Notice>
                ) : key === "intake" && repository ? (
                  <IntakeSettings
                    key={repository.id}
                    repository={repository}
                    onDraft={setIntakeDraft}
                    onToast={onToast}
                  />
                ) : key === "replies" && repository ? (
                  <ReplySettings
                    key={repository.id}
                    repository={repository}
                    onDraft={setReplyDraft}
                    onToast={onToast}
                  />
                ) : key === "prompts" ? (
                  <PromptSettings repository={repository} />
                ) : key === "execution" ? (
                  <ExecutionSettings onToast={onToast} />
                ) : key === "workers" ? (
                  <WorkerSettings onToast={onToast} />
                ) : key === "accounts" ? (
                  <AccountsSettings repository={repository} onToast={onToast} />
                ) : (
                  <ProfileSettings onToast={onToast} />
                )}
              </div>
            ))}
        </div>
        {bar?.dirty && (
          <div className="console-settings-save-bar">
            <span className="console-settings-dot dirty" />
            <span className="console-settings-grow">
              {text("有未保存的更改", "Unsaved changes")}
            </span>
            <button
              type="button"
              className="console-settings-button"
              disabled={bar.busy}
              onClick={bar.discard}
            >
              {text("放弃", "Discard")}
            </button>
            <button
              type="button"
              className="console-settings-button filled"
              disabled={!bar.valid || bar.busy}
              onClick={bar.save}
            >
              {bar.busy && <span className="console-settings-spinner" />}
              {text("保存", "Save")}
            </button>
          </div>
        )}
      </section>
      <Snackbar
        open={!!toast}
        message={toast}
        autoHideDuration={4000}
        onClose={() => setToast(undefined)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </div>
  );
}
