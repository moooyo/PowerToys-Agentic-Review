import {
  INVESTIGATION_PASSWORD_MAX_LENGTH,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  ConsoleIcon,
  LanguageToggle,
  ThemeToggle,
  useConsolePreferences,
} from "../console/preferences";
import type { PasswordLoginInput } from "./auth-api";
import { focusInvalidAccountField } from "./password-field";

function noticeTranslation(message: string, text: (zh: string, en: string) => string) {
  const notices: Record<string, string> = {
    "You have signed out.": text("已退出登录", "You signed out"),
    "Your password was changed. Sign in again with the new password.": text(
      "密码已修改，请重新登录",
      "Password changed. Sign in again",
    ),
    "Your session expired. Sign in again.": text(
      "会话已过期，请重新登录",
      "Your session expired. Sign in again.",
    ),
    "The username or password is incorrect.": text(
      "用户名或密码不正确",
      "Incorrect username or password",
    ),
    "Sign in failed.": text("用户名或密码不正确", "Incorrect username or password"),
    "The current session could not be verified. Retry the connection or sign in again.": text(
      "无法确认当前会话，请重试连接或重新登录",
      "The current session could not be verified. Retry the connection or sign in again.",
    ),
    "The session could not be loaded.": text(
      "无法加载会话，请重试连接",
      "The session could not be loaded.",
    ),
    "The service did not establish a signed-in session.": text(
      "服务未建立登录会话，请重试",
      "The service did not establish a signed-in session.",
    ),
    "The service returned an expired session. Try signing in again.": text(
      "服务返回的会话已过期，请重新登录",
      "The service returned an expired session. Try signing in again.",
    ),
  };
  return notices[message] ?? message;
}

export function PasswordSignInForm({
  onLogin,
  onRetry,
  busy,
  message,
  severity = "info",
}: {
  onLogin: (input: PasswordLoginInput) => Promise<void>;
  onRetry: () => Promise<void>;
  busy: boolean;
  message?: string;
  severity?: "info" | "error" | "success";
}) {
  const { text } = useConsolePreferences();
  const formId = useId();
  const titleId = useId();
  const usernameId = useId();
  const usernameErrorId = useId();
  const passwordId = useId();
  const passwordErrorId = useId();
  const pending = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<{
    username?: "required" | "invalid";
    password?: "required";
  }>({});
  const [error, setError] = useState<string>();
  const [dismissedMessage, setDismissedMessage] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting;
  const serverError =
    error ?? (severity === "error" && message !== dismissedMessage ? message : undefined);
  const notice = message && severity !== "error" ? noticeTranslation(message, text) : undefined;
  const usernameError =
    errors.username === "required"
      ? text("请输入用户名", "Enter your username")
      : errors.username === "invalid"
        ? text(
            "用户名需要 3–64 个字母、数字、句点、下划线或连字符",
            "Use 3–64 letters, numbers, periods, underscores, or hyphens",
          )
        : undefined;
  const passwordError = errors.password
    ? text("请输入密码", "Enter your password")
    : serverError
      ? noticeTranslation(serverError, text)
      : undefined;
  const passwordLabel = visible
    ? text("隐藏密码", "Hide password")
    : text("显示密码", "Show password");

  useEffect(() => {
    if (!password) setVisible(false);
  }, [password]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || pending.current) return;
    const input = { username: normalizeInvestigationUsername(username), password };
    const nextErrors: typeof errors = {
      username: !input.username
        ? "required"
        : /^[a-z0-9][a-z0-9._-]{2,63}$/u.test(input.username)
          ? undefined
          : "invalid",
      password: input.password ? undefined : "required",
    };
    setErrors(nextErrors);
    setError(undefined);
    setDismissedMessage(undefined);
    if (nextErrors.username || nextErrors.password) {
      focusInvalidAccountField(formId);
      return;
    }
    pending.current = true;
    setSubmitting(true);
    setPassword("");
    try {
      await onLogin(input);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : text("登录失败，请重试", "Sign-in failed. Try again."),
      );
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };

  return (
    <main className="console-login">
      <div className="console-login-layout">
        <section className="console-login-card" aria-labelledby={titleId}>
          <div className="console-login-brand">
            <div className="console-login-logo">
              <ConsoleIcon name="rate_review" filled />
            </div>
            <div className="console-login-brand-copy">
              <span className="console-login-brand-name">Agentic Review</span>
              <span className="console-login-repository">microsoft/PowerToys</span>
            </div>
          </div>
          <div className="console-login-heading">
            <h1 id={titleId}>{text("登录", "Sign in")}</h1>
            <p>{text("使用管理员分配的账号", "Use the account your administrator created")}</p>
          </div>
          {notice && (
            <div className="console-login-notice" role="status">
              <ConsoleIcon name="info" size={18} />
              {notice}
            </div>
          )}
          <form
            className="console-login-form"
            id={formId}
            onSubmit={(event) => void submit(event)}
            aria-label={text("登录", "Sign in")}
            noValidate
          >
            <div className="console-login-fields">
              <div className="console-login-field">
                <label className="console-login-label" htmlFor={usernameId}>
                  {text("用户名", "Username")}
                </label>
                <input
                  className="console-login-input"
                  id={usernameId}
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={64}
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setErrors((current) => ({ ...current, username: undefined }));
                    setError(undefined);
                    setDismissedMessage(message);
                  }}
                  aria-invalid={!!usernameError}
                  aria-describedby={usernameError ? usernameErrorId : undefined}
                  disabled={disabled}
                  required
                />
                {usernameError && (
                  <span className="console-login-error" id={usernameErrorId} role="alert">
                    <ConsoleIcon name="error" size={16} />
                    {usernameError}
                  </span>
                )}
              </div>
              <div className="console-login-field">
                <label className="console-login-label" htmlFor={passwordId}>
                  {text("密码", "Password")}
                </label>
                <span className="console-login-password">
                  <input
                    className="console-login-input"
                    id={passwordId}
                    type={visible ? "text" : "password"}
                    name="password"
                    autoComplete="current-password"
                    maxLength={INVESTIGATION_PASSWORD_MAX_LENGTH * 2}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setErrors((current) => ({ ...current, password: undefined }));
                      setError(undefined);
                      setDismissedMessage(message);
                    }}
                    aria-invalid={!!passwordError}
                    aria-describedby={passwordError ? passwordErrorId : undefined}
                    disabled={disabled}
                    required
                  />
                  <button
                    className="console-login-password-toggle"
                    type="button"
                    aria-label={passwordLabel}
                    aria-pressed={visible}
                    title={passwordLabel}
                    disabled={disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setVisible((current) => !current)}
                  >
                    <ConsoleIcon name={visible ? "visibility_off" : "visibility"} size={22} />
                  </button>
                </span>
                {passwordError && (
                  <span className="console-login-error" id={passwordErrorId} role="alert">
                    <ConsoleIcon name="error" size={16} />
                    {passwordError}
                  </span>
                )}
              </div>
            </div>
            <button className="console-login-submit" type="submit" disabled={disabled}>
              {disabled && <span className="console-login-spinner" aria-hidden="true" />}
              {text("登录", "Sign in")}
            </button>
            {message &&
              ![
                "The username or password is incorrect.",
                "Sign in failed.",
                "You have signed out.",
                "Your password was changed. Sign in again with the new password.",
              ].includes(message) && (
                <button
                  className="console-login-retry"
                  type="button"
                  disabled={disabled}
                  onClick={() => void onRetry()}
                >
                  {text("重试连接", "Retry connection")}
                </button>
              )}
          </form>
        </section>
        <div className="console-login-preferences">
          <ThemeToggle />
          <LanguageToggle />
        </div>
        {process.env.NODE_ENV === "development" && (
          <details className="console-login-demo">
            <summary>{text("开发演示账号", "Development sample only")}</summary>
            <p>
              {text("演示账号", "Public demo account")}: <strong>demo</strong>
              <br />
              {text("演示密码", "Demo password")}: <code>Demo-password-2026!</code>
            </p>
            <p>
              {text(
                "演示数据保存在内存中，不会连接 GitHub 或启动 Worker。",
                "Accounts and PowerToys reports are held in memory. This preview does not access GitHub or start a Worker.",
              )}
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setUsername("demo");
                setPassword("Demo-password-2026!");
                setErrors({});
                setError(undefined);
                setDismissedMessage(message);
              }}
            >
              {text("填入演示账号", "Fill demo credentials")}
            </button>
          </details>
        )}
      </div>
    </main>
  );
}
