import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordSignInForm } from "./sign-in-form";

afterEach(() => vi.unstubAllEnvs());

describe("sign-in presentation", () => {
  it("renders outside a router with a main landmark, named password control, and no production fixtures", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      <PasswordSignInForm busy={false} onLogin={async () => {}} onRetry={async () => {}} />,
    );
    expect(html).toContain("<main");
    expect(html).toContain("Welcome back");
    expect(html).toContain('aria-label="Sign in"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain("Contact your workspace administrator");
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
    expect(html).toContain("The password field is cleared after each sign-in attempt.");
  });
});
