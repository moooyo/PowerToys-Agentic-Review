import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsolePreferencesProvider } from "../console/preferences";
import { MaterialTheme } from "../theme";
import { PasswordSignInForm } from "./sign-in-form";

afterEach(() => vi.unstubAllEnvs());

describe("sign-in presentation", () => {
  it("renders outside a router with a main landmark, named password control, and no production fixtures", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <PasswordSignInForm busy={false} onLogin={async () => {}} onRetry={async () => {}} />,
    );
    expect(html).toContain("<main");
    expect(html).toMatch(/<h1[^>]*>Sign in<\/h1>/u);
    expect(html).toContain('aria-label="Sign in"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain("Use the account your administrator created");
    expect(html).toContain("microsoft/PowerToys");
    expect(html).not.toContain("Demo-password-2026!");
    expect(html).not.toContain("Design preview");
    expect(html).not.toContain("Fill sample credentials");
  });

  it("retains the provider's session consequence and retry path", () => {
    const html = renderToStaticMarkup(
      <PasswordSignInForm
        busy={false}
        message="Your password was reset. Sign in again."
        severity="success"
        onLogin={async () => {}}
        onRetry={async () => {}}
      />,
    );
    expect(html).toContain("Your password was reset. Sign in again.");
    expect(html).toContain("Retry connection");
    expect(html).toMatch(/autocomplete="current-password"/i);
  });

  it("renders the default Chinese console with language and theme controls", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <MaterialTheme>
        <ConsolePreferencesProvider>
          <PasswordSignInForm busy={false} onLogin={async () => {}} onRetry={async () => {}} />
        </ConsolePreferencesProvider>
      </MaterialTheme>,
    );
    expect(html).toMatch(/<h1[^>]*>登录<\/h1>/u);
    expect(html).toContain("使用管理员分配的账号");
    expect(html).toContain('aria-label="显示密码"');
    expect(html).toContain('aria-label="语言"');
    expect(html).toContain('aria-label="深色模式"');
    expect(html).toContain("Roboto Flex");
    expect(html).toContain("Noto Sans SC");
    expect(html).not.toContain("Demo-password-2026!");
  });

  it("shows sign-out and changed-password consequences as notices without a connection retry", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [message, expected] of [
      ["You have signed out.", "已退出登录"],
      ["Your password was changed. Sign in again with the new password.", "密码已修改，请重新登录"],
    ]) {
      const html = renderToStaticMarkup(
        <ConsolePreferencesProvider>
          <PasswordSignInForm
            busy={false}
            message={message}
            severity="success"
            onLogin={async () => {}}
            onRetry={async () => {}}
          />
        </ConsolePreferencesProvider>,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(expected);
      expect(html).not.toContain("重试连接");
    }
  });

  it("renders authentication failures by the password control while preserving server authority", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <ConsolePreferencesProvider>
        <PasswordSignInForm
          busy={false}
          message="The username or password is incorrect."
          severity="error"
          onLogin={async () => {}}
          onRetry={async () => {}}
        />
      </ConsolePreferencesProvider>,
    );
    expect(html).toContain("用户名或密码不正确");
    expect(html).toMatch(/type="password"[^>]*aria-invalid="true"[^>]*aria-describedby=/u);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("重试连接");
  });

  it("keeps the sign-in action named and marks the pending state", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <PasswordSignInForm busy onLogin={async () => {}} onRetry={async () => {}} />,
    );
    expect(html).toMatch(/class="console-login-submit"[^>]*disabled=""/u);
    expect(html).toContain('class="console-login-spinner" aria-hidden="true"');
    expect(html).toContain("Sign in");
    expect(html).toMatch(/type="password"[^>]*disabled=""/u);
  });
});
