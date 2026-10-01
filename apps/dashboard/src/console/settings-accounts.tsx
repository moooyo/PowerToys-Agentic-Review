import { Dialog } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  AccountFormError,
  type AccountFormValues,
  accountFormValues,
  accountPasswordResetProblems,
  accountWriteVersion,
  submitAccountForm,
  submitAccountPassword,
  updateAccountInput,
} from "../investigation/account-form";
import { investigationApi, type Repository } from "../investigation/api";
import { type Account, authApi } from "../investigation/auth-api";
import { passwordChangeValidation } from "../investigation/my-account";
import { useGuardedAction, useUnsavedChanges } from "../investigation/navigation-guard";
import { focusInvalidAccountField } from "../investigation/password-field";
import { useInvestigationSession } from "../investigation/session";
import { InvestigationHttpError } from "../investigation/transport";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./settings-accounts.css";

const accountsQueryKey = ["investigation-accounts"];
type Translate = (zh: string, en: string) => string;
type AccessChoice = "repository" | "review" | "stop" | "publish" | "e2e";
const accessChoices: AccessChoice[] = ["repository", "review", "stop", "publish", "e2e"];

function choiceLabel(choice: AccessChoice, text: Translate) {
  switch (choice) {
    case "repository":
      return text("管理仓库设置", "Manage repository settings");
    case "review":
      return text("创建和重试 Review", "Create and retry reviews");
    case "stop":
      return text("停止 Review", "Stop reviews");
    case "publish":
      return text("发布到 GitHub", "Publish to GitHub");
    case "e2e":
      return text("允许运行 E2E", "Allow E2E execution");
  }
}

function accessGrants(choices: AccessChoice[]) {
  const permissions = new Set<Account["permissions"][number]>();
  const actions = new Set<Account["actionCapabilities"][number]>();
  if (choices.includes("repository")) permissions.add("repository:manage");
  if (choices.includes("review")) {
    permissions.add("task:create");
    permissions.add("action:prepare");
    permissions.add("action:execute");
    actions.add("start-task");
    actions.add("resume");
  }
  if (choices.includes("stop")) permissions.add("task:cancel");
  if (choices.includes("publish")) {
    permissions.add("action:prepare");
    permissions.add("action:execute");
    actions.add("comment");
  }
  return {
    permissions: [...permissions],
    actionCapabilities: [...actions],
    allowRepositoryExecution: choices.includes("e2e"),
  };
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
}

function avatarTone(username: string) {
  let hash = 0;
  for (const character of username) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 5;
}

function accessSummary(account: Account, text: Translate) {
  if (!account.repositoryIds.length)
    return text("只读 · 无仓库授权", "Read only · No repository access");
  const items: string[] = [];
  const canExecuteActions =
    account.permissions.includes("action:prepare") &&
    account.permissions.includes("action:execute");
  const canCreate = account.permissions.includes("task:create");
  const canRetry = canCreate;
  const canPublish = canExecuteActions && account.actionCapabilities.includes("comment");
  if (account.permissions.includes("repository:manage"))
    items.push(choiceLabel("repository", text));
  if (canRetry) items.push(choiceLabel("review", text));
  else if (canCreate)
    items.push(text("创建 Review · 重试受限", "Create reviews · Retry restricted"));
  else if (
    account.actionCapabilities.some((action) => action === "resume" || action === "start-task")
  )
    items.push(text("受限 Review 权限", "Restricted Review permissions"));
  if (account.permissions.includes("task:cancel")) items.push(choiceLabel("stop", text));
  if (canPublish) items.push(choiceLabel("publish", text));
  else if (account.actionCapabilities.includes("comment"))
    items.push(text("发布权限未完整授予", "Publishing permissions incomplete"));
  if (account.allowRepositoryExecution) items.push(choiceLabel("e2e", text));
  if (!items.length && (account.permissions.length || account.actionCapabilities.length))
    items.push(text("受限 Review 权限", "Restricted Review permissions"));
  return items.length ? items.join(" · ") : text("只读", "Read only");
}

function useMountedForm() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function requestProblem(cause: unknown, text: Translate, fallback: string) {
  if (cause instanceof InvestigationHttpError) {
    if (cause.status === 401)
      return text("登录已过期，请重新登录。", "Your session expired. Sign in again.");
    if (cause.status === 403)
      return text(
        "账号没有执行此操作的权限。",
        "Your account does not have permission for this operation.",
      );
  }
  if (cause instanceof Error) {
    const knownMessages: [string, string, string][] = [
      ["Username is already in use.", "用户名已存在", "Username already exists"],
      ["Account version has changed.", "账号版本已变更。", "The account version changed."],
      [
        "The last enabled administrator cannot be disabled or demoted.",
        "不能停用或降级最后一个已启用的管理员。",
        "The last enabled administrator cannot be disabled or demoted.",
      ],
      [
        "The current password could not be verified. Try again.",
        "当前密码不正确，请重试。",
        "The current password is incorrect. Try again.",
      ],
    ];
    const match = knownMessages.find(([message]) => cause.message.startsWith(message));
    if (match) return `${text(match[1], match[2])}${cause.message.slice(match[0].length)}`;
  }
  return cause instanceof Error ? cause.message : fallback;
}

function Spinner() {
  return <span className="console-account-spinner" aria-hidden="true" />;
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={`console-account-notice${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <ConsoleIcon name={error ? "error" : "info"} size={18} /> <span>{children}</span>
    </div>
  );
}

function AccountField({
  label,
  name,
  value,
  onChange,
  error,
  help,
  password = false,
  count = false,
  autoFocus = false,
  disabled = false,
  autoComplete = "off",
  maxLength,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  help?: string;
  password?: boolean;
  count?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  maxLength?: number;
}) {
  const { text } = useConsolePreferences();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  return (
    <div className={`console-account-field${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <div className="console-account-input-wrap">
        <input
          ref={input}
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={password && !visible ? "password" : "text"}
          disabled={disabled}
          autoComplete={autoComplete}
          spellCheck={false}
          maxLength={maxLength ?? (password ? 256 : undefined)}
          aria-invalid={Boolean(error)}
          aria-describedby={error || help || count ? `${id}-help` : undefined}
        />
        {password && (
          <button
            type="button"
            className="console-account-reveal"
            disabled={disabled}
            aria-label={`${visible ? text("隐藏", "Hide") : text("显示", "Show")} ${label}`}
            aria-pressed={visible}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setVisible((current) => !current)}
          >
            <ConsoleIcon name={visible ? "visibility_off" : "visibility"} size={20} />
          </button>
        )}
      </div>
      {(error || help || count) && (
        <div className="console-account-field-help" id={`${id}-help`}>
          <span role={error ? "alert" : undefined}>{error ?? help}</span>
          {count && <span>{Array.from(value).length} / 128</span>}
        </div>
      )}
    </div>
  );
}

function AccountModal({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const guardedAction = useGuardedAction();
  return (
    <Dialog
      open
      maxWidth={false}
      className="console-account-dialog"
      slotProps={{ paper: { className: "console-account-dialog-paper" } }}
      aria-labelledby={titleId}
      onClose={() => {
        if (!busy) guardedAction(onClose);
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </Dialog>
  );
}

function ModalActions({
  busy,
  disabled = false,
  onClose,
  label,
}: {
  busy: boolean;
  disabled?: boolean;
  onClose: () => void;
  label: string;
}) {
  const { text } = useConsolePreferences();
  const guardedAction = useGuardedAction();
  return (
    <div className="console-account-modal-actions">
      <button
        type="button"
        className="console-account-button"
        disabled={busy}
        onClick={() => guardedAction(onClose)}
      >
        {text("取消", "Cancel")}
      </button>
      <button type="submit" className="console-account-button filled" disabled={busy || disabled}>
        {busy && <Spinner />}
        {label}
      </button>
    </div>
  );
}

function useAccountReview(
  account: Account,
  reload: (id: string) => Promise<Account>,
  initialConflict = false,
) {
  const mounted = useMountedForm();
  const { text } = useConsolePreferences();
  const [conflict, setConflict] = useState(initialConflict);
  const [latest, setLatest] = useState<Account>();
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  return {
    conflict,
    latest,
    reviewed,
    loading,
    error,
    setReviewed,
    ready: !conflict || Boolean(latest && reviewed),
    version: () => accountWriteVersion(account, conflict, latest, reviewed),
    markConflict: () => {
      setConflict(true);
      setLatest(undefined);
      setReviewed(false);
    },
    refresh: async () => {
      if (pending.current) return;
      pending.current = true;
      setLoading(true);
      setError(undefined);
      setReviewed(false);
      try {
        const result = await reload(account.id);
        if (mounted.current) setLatest(result);
      } catch (cause) {
        if (mounted.current) {
          setLatest(undefined);
          setError(
            requestProblem(
              cause,
              text,
              text("无法刷新账号。", "The account could not be refreshed."),
            ),
          );
        }
      } finally {
        pending.current = false;
        if (mounted.current) setLoading(false);
      }
    },
  };
}

function ConflictNotice({
  review,
  busy,
}: {
  review: ReturnType<typeof useAccountReview>;
  busy: boolean;
}) {
  const { text } = useConsolePreferences();
  if (!review.conflict) return null;
  return (
    <div className="console-account-conflict">
      <Notice>
        {text(
          "账号保存被拒绝。刷新并确认最新权限后，才能再次提交。",
          "The account save was rejected. Refresh and review its latest access before submitting again.",
        )}
      </Notice>
      <button
        type="button"
        className="console-account-button outlined"
        disabled={busy || review.loading}
        onClick={() => void review.refresh()}
      >
        {review.loading && <Spinner />}
        {text("查看最新权限", "Review latest access")}
      </button>
      {review.error && <Notice error>{review.error}</Notice>}
      {review.latest && (
        <div className="console-account-latest">
          <strong>
            {review.latest.displayName} · {text("版本", "Version")} {review.latest.version}
          </strong>
          <p>
            {review.latest.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")} ·{" "}
            {review.latest.isAdmin ? text("管理员", "Administrator") : text("成员", "Member")}
          </p>
          <p>{accessSummary(review.latest, text)}</p>
          <p>
            {text("仓库", "Repositories")}:{" "}
            {review.latest.repositoryIds.join(", ") || text("无", "None")}
          </p>
          <p>
            {text("实际权限", "Granted permissions")}:{" "}
            {review.latest.permissions.join(", ") || text("无", "None")}
          </p>
          <p>
            {text("操作能力", "Action capabilities")}:{" "}
            {review.latest.actionCapabilities.join(", ") || text("无", "None")}
          </p>
          <label className="console-account-check">
            <input
              type="checkbox"
              checked={review.reviewed}
              disabled={busy || review.loading}
              onChange={(event) => review.setReviewed(event.target.checked)}
            />
            <span>
              {text(
                "我已确认此版本，继续提交。",
                "I have reviewed this version and want to submit again.",
              )}
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function CreateAccountDialog({
  repository,
  repositories,
  repositoriesUnavailable,
  existing,
  onClose,
  onSaved,
}: {
  repository?: Repository;
  repositories: Repository[];
  repositoriesUnavailable: boolean;
  existing: Account[];
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const { text } = useConsolePreferences();
  const mounted = useMountedForm();
  const formId = useId();
  const [form, setForm] = useState<AccountFormValues>(() => ({
    ...accountFormValues(),
    repositoryIdsText: repository?.id ?? "",
  }));
  const [choices, setChoices] = useState<AccessChoice[]>(["review"]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [errors, setErrors] = useState<
    Partial<Record<"username" | "displayName" | "password" | "repositoryIdsText", string>>
  >({});
  const [error, setError] = useState<string>();
  const dirty = Boolean(
    form.username ||
      form.displayName ||
      form.password ||
      form.isAdmin ||
      form.repositoryIdsText !== (repository?.id ?? "") ||
      choices.join(",") !== "review",
  );
  useUnsavedChanges(dirty, {
    busy,
    description: text(
      "新账号尚未创建，离开会放弃输入。",
      "The account has not been created. Leaving will discard these entries.",
    ),
    onDiscard: () => {
      setForm({ ...accountFormValues(), repositoryIdsText: repository?.id ?? "" });
      setChoices(["review"]);
    },
  });
  const setField = <K extends keyof AccountFormValues>(field: K, value: AccountFormValues[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const selectedIds = form.repositoryIdsText.split(/[\s,]+/u).filter(Boolean);
  const shownRepositories =
    repository && !repositories.some((item) => item.id === repository.id)
      ? [repository, ...repositories]
      : repositories;
  const toggleRepository = (id: string, checked: boolean) =>
    setField(
      "repositoryIdsText",
      (checked
        ? [...new Set([...selectedIds, id])]
        : selectedIds.filter((value) => value !== id)
      ).join("\n"),
    );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const input = {
      ...form,
      displayName: form.displayName.trim() || form.username.trim(),
      ...accessGrants(form.isAdmin ? accessChoices : choices),
    };
    setError(undefined);
    setErrors({});
    if (
      !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(form.username.trim()) ||
      existing.some((account) => account.username === form.username.trim())
    ) {
      setErrors({
        username: existing.some((account) => account.username === form.username.trim())
          ? text("用户名已存在", "Username already exists")
          : text(
              "请输入 3–64 位小写字母、数字、点、下划线或连字符，以字母或数字开头",
              "Use 3–64 lowercase letters, digits, dots, underscores or hyphens; start with a letter or digit",
            ),
      });
      setField("password", "");
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const saved = await submitAccountForm(input, undefined, undefined, authApi, () => {
        if (mounted.current) setForm((current) => ({ ...current, password: "" }));
      });
      if (mounted.current) onSaved(saved);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof AccountFormError) {
        setErrors({
          [cause.field]:
            cause.field === "password"
              ? text(
                  "密码需要 15–128 个字符，并包含非空白字符",
                  "Use 15–128 characters, including a non-whitespace character",
                )
              : cause.field === "displayName"
                ? text("显示名称最多 120 个字符", "Use a display name of up to 120 characters")
                : cause.field === "repositoryIdsText"
                  ? text(
                      "最多输入 1,024 个准确仓库 ID，以逗号或换行分隔",
                      "Enter up to 1,024 exact repository IDs, separated by commas or new lines",
                    )
                  : text("用户名格式不正确", "The username format is invalid"),
        });
        focusInvalidAccountField(formId);
      } else
        setError(
          requestProblem(cause, text, text("账号创建失败。", "The account could not be created.")),
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <AccountModal title={text("新建账号", "New account")} onClose={onClose} busy={busy}>
      <form
        id={formId}
        className="console-account-form console-account-create-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <div className="console-account-modal-body">
          <AccountField
            label={text("用户名", "Username")}
            name="username"
            value={form.username}
            onChange={(value) => setField("username", value)}
            disabled={busy}
            autoFocus
            maxLength={64}
            error={errors.username}
            help={text(
              "3–64 位小写字母、数字、点、下划线或连字符",
              "3–64 lowercase letters, digits, dots, underscores or hyphens",
            )}
          />
          <AccountField
            label={text("显示名称", "Display name")}
            name="displayName"
            value={form.displayName}
            onChange={(value) => setField("displayName", value)}
            disabled={busy}
            maxLength={120}
            error={errors.displayName}
            help={text("可选，留空时使用用户名", "Optional; defaults to the username")}
          />
          <AccountField
            label={text("初始密码", "Initial password")}
            name="password"
            value={form.password}
            onChange={(value) => setField("password", value)}
            password
            count
            autoComplete="new-password"
            disabled={busy}
            error={errors.password}
            help={text("15–128 个字符", "15–128 characters")}
          />
          <div className="console-account-admin">
            <div>
              <span>{text("管理员", "Administrator")}</span>
              <small>{text("可以管理账号和 Workers", "Can manage accounts and Workers")}</small>
            </div>
            <button
              type="button"
              role="switch"
              className="console-account-switch"
              aria-label={text("管理员", "Administrator")}
              aria-checked={form.isAdmin}
              disabled={busy}
              onClick={() => setField("isAdmin", !form.isAdmin)}
            >
              <span>{form.isAdmin && <ConsoleIcon name="check" size={16} />}</span>
            </button>
          </div>
          <fieldset className="console-account-permissions" disabled={busy}>
            <legend>{text("权限", "Permissions")}</legend>
            {accessChoices.map((choice) => (
              <label className="console-account-check" key={choice}>
                <input
                  type="checkbox"
                  checked={form.isAdmin || choices.includes(choice)}
                  disabled={form.isAdmin}
                  onChange={(event) =>
                    setChoices((current) =>
                      event.target.checked
                        ? [...current, choice]
                        : current.filter((item) => item !== choice),
                    )
                  }
                />
                <span>{choiceLabel(choice, text)}</span>
              </label>
            ))}
          </fieldset>
          <details
            className="console-account-scope-options"
            open={Boolean(errors.repositoryIdsText) || repositoriesUnavailable}
          >
            <summary>
              <span>{text("仓库访问范围", "Repository access")}</span>
              <small>
                {selectedIds
                  .map((id) => shownRepositories.find((item) => item.id === id)?.fullName ?? id)
                  .join(", ") || text("无", "None")}
              </small>
              <ConsoleIcon name="expand_more" size={18} />
            </summary>
            <fieldset className="console-account-permissions" disabled={busy}>
              <legend>{text("仓库访问范围", "Repository access")}</legend>
              {shownRepositories.map((item) => (
                <label className="console-account-check" key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.id)}
                    onChange={(event) => toggleRepository(item.id, event.target.checked)}
                  />
                  <span>{item.fullName}</span>
                </label>
              ))}
              {repositoriesUnavailable && (
                <Notice>
                  {text(
                    "仓库目录暂不可用，可以在下方填写准确 ID。",
                    "The repository directory is unavailable. Enter exact IDs below.",
                  )}
                </Notice>
              )}
              <details
                className="console-account-repository-ids"
                open={Boolean(errors.repositoryIdsText) || repositoriesUnavailable}
              >
                <summary>{text("仓库 ID", "Repository IDs")}</summary>
                <AccountField
                  label={text("仓库 ID（空白或逗号分隔）", "Repository IDs (spaces or commas)")}
                  name="repositoryIdsText"
                  value={form.repositoryIdsText}
                  onChange={(value) => setField("repositoryIdsText", value)}
                  disabled={busy}
                  error={errors.repositoryIdsText}
                />
              </details>
              <p className="console-account-helper">
                {text(
                  "权限只对选定仓库生效。管理员也需要明确的仓库访问授权。",
                  "Permissions apply to selected repositories. Administrators also need explicit repository access.",
                )}
              </p>
            </fieldset>
          </details>
          {error && <Notice error>{error}</Notice>}
        </div>
        <ModalActions busy={busy} onClose={onClose} label={text("创建", "Create")} />
      </form>
    </AccountModal>
  );
}

function ResetPasswordDialog({
  account,
  reloadAccount,
  onClose,
  onSaved,
}: {
  account: Account;
  reloadAccount: (id: string) => Promise<Account>;
  onClose: () => void;
  onSaved: (account: Account) => Promise<void>;
}) {
  const { text } = useConsolePreferences();
  const mounted = useMountedForm();
  const formId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<{
    password?: string;
    confirmation?: string;
    acknowledged?: string;
  }>({});
  const review = useAccountReview(account, reloadAccount);
  const clearPasswords = () => {
    setPassword("");
    setConfirmation("");
  };
  useUnsavedChanges(Boolean(password || confirmation || acknowledged), {
    busy: busy || review.loading,
    description: text(
      "新密码尚未保存，离开会放弃密码重置。",
      "The new password has not been saved. Leaving will discard this reset.",
    ),
    onDiscard: () => {
      clearPasswords();
      setAcknowledged(false);
    },
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading) return;
    const input = password;
    const problems = accountPasswordResetProblems(password, confirmation, acknowledged);
    clearPasswords();
    setError(undefined);
    setErrors({
      password: problems.password
        ? text(
            "密码需要 15–128 个字符，并包含非空白字符",
            "Use 15–128 characters, including a non-whitespace character",
          )
        : undefined,
      confirmation: problems.confirmation
        ? text("两次输入的新密码不一致", "The new passwords do not match")
        : undefined,
      acknowledged: problems.acknowledged
        ? text("请确认该账号的所有会话将退出", "Confirm that all sessions of this account will end")
        : undefined,
    });
    if (Object.keys(problems).length) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const saved = await submitAccountPassword(
        account,
        input,
        review.version(),
        authApi.resetAccountPassword,
        () => {
          if (mounted.current) clearPasswords();
        },
      );
      if (mounted.current) await onSaved(saved);
    } catch (cause) {
      if (mounted.current) {
        setError(
          requestProblem(cause, text, text("密码重置失败。", "The password could not be reset.")),
        );
        if (cause instanceof InvestigationHttpError && cause.status === 409) review.markConflict();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <AccountModal
      title={text(`重置 @${account.username} 的密码`, `Reset password for @${account.username}`)}
      onClose={onClose}
      busy={busy || review.loading}
    >
      <form
        id={formId}
        className="console-account-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <div className="console-account-modal-body">
          <p className="console-account-helper">
            {text(
              "该账号所有已登录的会话会退出。",
              "All signed-in sessions of this account will end.",
            )}
          </p>
          <AccountField
            label={text("新密码", "New password")}
            name="password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
            password
            count
            autoFocus
            autoComplete="new-password"
            disabled={busy || review.loading}
            error={errors.password}
            help={text("15–128 个字符", "15–128 characters")}
          />
          <AccountField
            label={text("确认新密码", "Confirm new password")}
            name="confirmation"
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value);
              setErrors((current) => ({ ...current, confirmation: undefined }));
            }}
            password
            autoComplete="new-password"
            disabled={busy || review.loading}
            error={errors.confirmation}
          />
          <label className="console-account-check">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || review.loading}
              aria-invalid={Boolean(errors.acknowledged)}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
                setErrors((current) => ({ ...current, acknowledged: undefined }));
              }}
            />
            <span>
              {text(
                "我理解该账号将在所有设备上退出登录",
                "I understand this account will be signed out everywhere",
              )}
            </span>
          </label>
          {errors.acknowledged && <Notice error>{errors.acknowledged}</Notice>}
          {error && <Notice error>{error}</Notice>}
          <ConflictNotice review={review} busy={busy} />
        </div>
        <ModalActions
          busy={busy || review.loading}
          disabled={!review.ready}
          onClose={onClose}
          label={text("重置", "Reset")}
        />
      </form>
    </AccountModal>
  );
}

function StatusConflictDialog({
  account,
  enabled,
  initialError,
  reloadAccount,
  onClose,
  onSaved,
}: {
  account: Account;
  enabled: boolean;
  initialError: string;
  reloadAccount: (id: string) => Promise<Account>;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const { text } = useConsolePreferences();
  const mounted = useMountedForm();
  const review = useAccountReview(account, reloadAccount, true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState(initialError);
  useUnsavedChanges(false, { busy: busy || review.loading });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !review.ready || review.loading || !review.latest) return;
    pending.current = true;
    setBusy(true);
    try {
      const saved = await authApi.updateAccount(
        account.id,
        updateAccountInput({ ...accountFormValues(review.latest), enabled }, review.version()),
      );
      if (mounted.current) onSaved(saved);
    } catch (cause) {
      if (mounted.current) {
        setError(
          requestProblem(
            cause,
            text,
            text("账号状态更新失败。", "The account status could not be updated."),
          ),
        );
        if (cause instanceof InvestigationHttpError && cause.status === 409) review.markConflict();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <AccountModal
      title={
        enabled
          ? text(`启用 @${account.username}`, `Enable @${account.username}`)
          : text(`停用 @${account.username}`, `Disable @${account.username}`)
      }
      onClose={onClose}
      busy={busy || review.loading}
    >
      <form className="console-account-form" onSubmit={(event) => void submit(event)}>
        <div className="console-account-modal-body">
          <Notice error>{error}</Notice>
          <ConflictNotice review={review} busy={busy} />
        </div>
        <ModalActions
          busy={busy || review.loading}
          disabled={!review.ready}
          onClose={onClose}
          label={text("再次提交", "Submit again")}
        />
      </form>
    </AccountModal>
  );
}

export function AccountsSettings({
  repository,
  onToast,
}: {
  repository?: Repository;
  onToast: (message: string) => void;
}) {
  const { session } = useInvestigationSession();
  const { text } = useConsolePreferences();
  if (!session.authenticated || !session.user?.isAdmin)
    return (
      <Notice>
        {text("只有管理员可以管理控制台账号。", "Only administrators can manage console accounts.")}
      </Notice>
    );
  return <AdminAccountsSettings repository={repository} onToast={onToast} />;
}

function AdminAccountsSettings({
  repository,
  onToast,
}: {
  repository?: Repository;
  onToast: (message: string) => void;
}) {
  const { session, requireSignIn } = useInvestigationSession();
  const { text } = useConsolePreferences();
  const queryClient = useQueryClient();
  const mounted = useMountedForm();
  const guardedAction = useGuardedAction();
  const accounts = useQuery({
    queryKey: accountsQueryKey,
    queryFn: authApi.listAccounts,
    retry: false,
    retryOnMount: false,
  });
  const repositories = useQuery({
    queryKey: ["investigation-repositories"],
    queryFn: investigationApi.repositories,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordAccount, setPasswordAccount] = useState<Account>();
  const [statusConflict, setStatusConflict] = useState<{
    account: Account;
    enabled: boolean;
    error: string;
  }>();
  const [changingId, setChangingId] = useState<string>();
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  useUnsavedChanges(false, { busy: Boolean(changingId) });
  const cacheAccount = (account: Account) => {
    queryClient.setQueryData<{ items: Account[] }>(accountsQueryKey, (current) => ({
      items: current
        ? current.items.some((item) => item.id === account.id)
          ? current.items.map((item) => (item.id === account.id ? account : item))
          : [...current.items, account]
        : [account],
    }));
    void queryClient.invalidateQueries({ queryKey: accountsQueryKey });
  };
  const reloadAccount = async (id: string) => {
    const result = await accounts.refetch();
    if (result.isError) throw result.error;
    const account = result.data?.items.find((item) => item.id === id);
    if (!account)
      throw new Error(
        text(
          "账号已不存在。关闭此窗口并刷新列表。",
          "This account is no longer available. Close this form and refresh the list.",
        ),
      );
    return account;
  };
  const statusSaved = (account: Account) => {
    setStatusConflict(undefined);
    cacheAccount(account);
    onToast(
      account.enabled
        ? text(`已启用 @${account.username}`, `Enabled @${account.username}`)
        : text(`已停用 @${account.username}`, `Disabled @${account.username}`),
    );
  };
  const changeStatus = async (account: Account) => {
    if (pending.current || account.id === session.user?.id) return;
    pending.current = true;
    setChangingId(account.id);
    setError(undefined);
    try {
      const saved = await authApi.updateAccount(
        account.id,
        updateAccountInput(
          { ...accountFormValues(account), enabled: !account.enabled },
          account.version,
        ),
      );
      if (mounted.current) statusSaved(saved);
    } catch (cause) {
      if (mounted.current) {
        const problem = requestProblem(
          cause,
          text,
          text("账号状态更新失败。", "The account status could not be updated."),
        );
        if (cause instanceof InvestigationHttpError && cause.status === 409)
          setStatusConflict({ account, enabled: !account.enabled, error: problem });
        else setError(problem);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setChangingId(undefined);
    }
  };
  return (
    <div className="console-accounts-settings">
      <div className="console-account-toolbar">
        <button
          type="button"
          className="console-account-button filled"
          disabled={Boolean(changingId)}
          onClick={() => guardedAction(() => setCreateOpen(true))}
        >
          <ConsoleIcon name="person_add" size={18} />
          {text("新建账号", "New account")}
        </button>
      </div>
      {accounts.isPending && (
        <Notice>
          <Spinner />
          {text("正在加载账号…", "Loading accounts…")}
        </Notice>
      )}
      {accounts.error && (
        <Notice error>
          {requestProblem(
            accounts.error,
            text,
            text("无法加载账号。", "Accounts could not be loaded."),
          )}
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      {accounts.data && (
        <div className="console-account-list">
          {accounts.data.items.map((account) => {
            const isMe = account.id === session.user?.id;
            const summary = accessSummary(account, text);
            const scope = `${text("仓库", "Repositories")}: ${account.repositoryIds.map((id) => repositories.data?.items.find((item) => item.id === id)?.fullName ?? id).join(", ") || text("无", "None")}`;
            const toggleLabel = isMe
              ? text("不能停用自己", "You cannot disable yourself")
              : account.enabled
                ? text("停用", "Disable")
                : text("启用", "Enable");
            return (
              <article
                key={account.id}
                className={`console-account-row${account.enabled ? "" : " disabled"}`}
                aria-label={`${text("账号", "Account")} @${account.username}`}
              >
                <span
                  className={`console-account-avatar tone-${avatarTone(account.username)}`}
                  aria-hidden="true"
                >
                  {initials(account.displayName)}
                </span>
                <div className="console-account-info">
                  <div className="console-account-identity">
                    <strong>{account.displayName}</strong>
                    <span className="console-account-username">@{account.username}</span>
                    <span
                      className={`console-account-badge ${account.isAdmin ? "admin" : "member"}`}
                    >
                      {account.isAdmin ? text("管理员", "Administrator") : text("成员", "Member")}
                    </span>
                    {isMe && <span className="console-account-badge you">{text("你", "You")}</span>}
                    {!account.enabled && (
                      <span className="console-account-badge off">
                        {text("已停用", "Disabled")}
                      </span>
                    )}
                  </div>
                  <span className="console-account-summary" title={`${summary}\n${scope}`}>
                    {summary}
                  </span>
                  <span className="console-account-scope" title={scope}>
                    {scope}
                  </span>
                </div>
                <button
                  type="button"
                  className="console-account-icon-button"
                  disabled={Boolean(changingId)}
                  title={text("重置密码", "Reset password")}
                  aria-label={text(
                    `重置 @${account.username} 的密码`,
                    `Reset password for @${account.username}`,
                  )}
                  onClick={() => guardedAction(() => setPasswordAccount(account))}
                >
                  <ConsoleIcon name="key" size={20} />
                </button>
                <button
                  type="button"
                  className="console-account-icon-button"
                  disabled={isMe || Boolean(changingId)}
                  title={toggleLabel}
                  aria-label={`${toggleLabel} @${account.username}`}
                  onClick={() =>
                    guardedAction(() => {
                      void changeStatus(account);
                    })
                  }
                >
                  {changingId === account.id ? (
                    <Spinner />
                  ) : (
                    <ConsoleIcon name={account.enabled ? "person_off" : "person_check"} size={20} />
                  )}
                </button>
              </article>
            );
          })}
          {accounts.data.items.length === 0 && (
            <div className="console-account-empty">{text("还没有账号", "No accounts yet")}</div>
          )}
        </div>
      )}
      {createOpen && (
        <CreateAccountDialog
          repository={repository}
          repositories={repositories.data?.items ?? []}
          repositoriesUnavailable={repositories.isError}
          existing={accounts.data?.items ?? []}
          onClose={() => setCreateOpen(false)}
          onSaved={(account) => {
            setCreateOpen(false);
            cacheAccount(account);
            onToast(text(`已创建账号 @${account.username}`, `Created @${account.username}`));
          }}
        />
      )}
      {passwordAccount && (
        <ResetPasswordDialog
          account={passwordAccount}
          reloadAccount={reloadAccount}
          onClose={() => setPasswordAccount(undefined)}
          onSaved={async (account) => {
            setPasswordAccount(undefined);
            if (account.id === session.user?.id) {
              await requireSignIn(
                text("密码已重置，请重新登录。", "Your password was reset. Sign in again."),
              );
              return;
            }
            cacheAccount(account);
            onToast(
              text(
                `已重置 @${account.username} 的密码，所有会话已退出`,
                `Password reset for @${account.username}. All sessions have ended.`,
              ),
            );
          }}
        />
      )}
      {statusConflict && (
        <StatusConflictDialog
          account={statusConflict.account}
          enabled={statusConflict.enabled}
          initialError={statusConflict.error}
          reloadAccount={reloadAccount}
          onClose={() => setStatusConflict(undefined)}
          onSaved={statusSaved}
        />
      )}
    </div>
  );
}

export function ProfileSettings({ onToast }: { onToast: (message: string) => void }) {
  const { session, logout, changePassword } = useInvestigationSession();
  const { text } = useConsolePreferences();
  const mounted = useMountedForm();
  const guardedAction = useGuardedAction();
  const formId = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<ReturnType<typeof passwordChangeValidation>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const clearPasswords = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
  };
  useUnsavedChanges(Boolean(currentPassword || newPassword || confirmation), {
    busy,
    description: text(
      "新密码尚未保存，离开会放弃修改。",
      "The new password has not been saved. Leaving will discard these changes.",
    ),
    onDiscard: clearPasswords,
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const input = { currentPassword, newPassword };
    const problems = passwordChangeValidation(currentPassword, newPassword, confirmation);
    clearPasswords();
    setError(undefined);
    setErrors({
      currentPassword: problems.currentPassword
        ? text("请输入当前密码", "Enter your current password")
        : undefined,
      newPassword: problems.newPassword
        ? text(
            "密码需要 15–128 个字符，并包含非空白字符",
            "Use 15–128 characters, including a non-whitespace character",
          )
        : undefined,
      confirmation: problems.confirmation
        ? text("两次输入的新密码不一致", "The new passwords do not match")
        : undefined,
    });
    if (Object.keys(problems).length) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await changePassword(input);
      onToast(text("密码已修改，请重新登录", "Password changed. Sign in again."));
    } catch (cause) {
      if (mounted.current) {
        setError(
          requestProblem(cause, text, text("密码修改失败。", "The password could not be changed.")),
        );
        setErrors({
          currentPassword: text(
            "请重新输入当前密码后重试",
            "Enter your current password again to retry",
          ),
        });
        focusInvalidAccountField(formId);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const signOut = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await logout();
    } catch (cause) {
      if (mounted.current)
        setError(requestProblem(cause, text, text("退出登录失败。", "Sign out failed.")));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const user = session.user;
  if (!user) return <Notice>{text("请登录查看账号。", "Sign in to view your account.")}</Notice>;
  const minutes = session.authenticated
    ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 60_000))
    : 0;
  const expiry =
    minutes >= 60
      ? text(
          `本次登录 ${Math.ceil(minutes / 60)} 小时后过期`,
          `Session expires in ${Math.ceil(minutes / 60)} h`,
        )
      : minutes > 0
        ? text(`本次登录 ${minutes} 分钟后过期`, `Session expires in ${minutes} min`)
        : text("本次登录即将过期", "Session expires soon");
  return (
    <div className="console-profile-settings">
      <div className="console-profile-header">
        <span className="console-account-avatar" aria-hidden="true">
          {initials(user.displayName)}
        </span>
        <div className="console-profile-identity">
          <span>{user.displayName}</span>
          <small>
            @{user.username} ·{" "}
            {user.isAdmin ? text("管理员", "Administrator") : text("成员", "Member")} · {expiry}
          </small>
        </div>
        <button
          type="button"
          className="console-account-button outlined"
          disabled={busy}
          onClick={() =>
            guardedAction(() => {
              void signOut();
            })
          }
        >
          <ConsoleIcon name="logout" size={18} />
          {text("退出登录", "Sign out")}
        </button>
      </div>
      <form
        id={formId}
        className="console-profile-password console-account-form"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <h3>{text("修改密码", "Change password")}</h3>
        <AccountField
          label={text("当前密码", "Current password")}
          name="currentPassword"
          value={currentPassword}
          onChange={(value) => {
            setCurrentPassword(value);
            setErrors((current) => ({ ...current, currentPassword: undefined }));
          }}
          password
          autoComplete="current-password"
          disabled={busy}
          error={errors.currentPassword}
        />
        <AccountField
          label={text("新密码", "New password")}
          name="newPassword"
          value={newPassword}
          onChange={(value) => {
            setNewPassword(value);
            setErrors((current) => ({ ...current, newPassword: undefined }));
          }}
          password
          autoComplete="new-password"
          disabled={busy}
          error={errors.newPassword}
          help={text("15–128 个字符", "15–128 characters")}
        />
        <AccountField
          label={text("确认新密码", "Confirm new password")}
          name="confirmation"
          value={confirmation}
          onChange={(value) => {
            setConfirmation(value);
            setErrors((current) => ({ ...current, confirmation: undefined }));
          }}
          password
          autoComplete="new-password"
          disabled={busy}
          error={errors.confirmation}
        />
        {error && <Notice error>{error}</Notice>}
        <div className="console-profile-password-actions">
          <button type="submit" className="console-account-button filled" disabled={busy}>
            {busy && <Spinner />}
            {text("修改密码", "Change password")}
          </button>
          <span>{text("修改后需要重新登录", "You will sign in again afterwards")}</span>
        </div>
      </form>
    </div>
  );
}
