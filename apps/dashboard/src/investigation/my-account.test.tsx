import type { InvestigationSession } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionLabels } from "./action-panel";
import MyAccountPage, { passwordChangeValidation } from "./my-account";

const context = vi.hoisted(() => ({ session: null as InvestigationSession | null }));
vi.mock("./session", () => ({
  useInvestigationSession: () => ({ session: context.session, changePassword: vi.fn() }),
}));

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00.000Z",
    user: {
      id: "own-account",
      username: "workspace.admin",
      displayName: "Workspace Administrator",
      isAdmin: true,
      email: null,
      repositoryIds: [],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
});

describe("personal account access", () => {
  it("shows only session grants for an administrator with no repository access", () => {
    const html = renderToStaticMarkup(<MyAccountPage />);
    expect(html).toContain("My account");
    expect(html).toContain("own-account");
    expect(html).toContain("No repositories");
    expect(html).toContain("Read-only");
    expect(html).toContain("No actions are granted to this account.");
    expect(html).toContain("Not allowed");
    expect(html).not.toContain("Create investigations");
    expect(html).toContain('aria-label="Show current password"');
    expect(html).toContain('aria-label="Show confirm new password"');
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain("signs you out on all devices");
  });

  it("keeps exact repository IDs and action grants separate from administration", () => {
    if (!context.session?.authenticated) throw new Error("An authenticated fixture is required.");
    Object.assign(context.session.user, {
      isAdmin: false,
      repositoryIds: ["repo:outside-directory"],
      permissions: ["task:create"],
      actionCapabilities: ["comment"],
      allowRepositoryExecution: true,
    });
    const html = renderToStaticMarkup(<MyAccountPage />);
    expect(html).toContain("repo:outside-directory");
    expect(html).toContain("Create investigations");
    expect(html).toContain(`>${actionLabels.comment}<`);
    expect(html).toContain(">Allowed<");
    expect(html).toContain("Your access");
    expect(html).not.toContain(">Administrator<");
    expect(html).not.toContain(">Approve<");
  });

  it("does not synthesize a profile for a signed-out session", () => {
    context.session = {
      authenticated: false,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: null,
    };
    const html = renderToStaticMarkup(<MyAccountPage />);
    expect(html).toContain("Sign in to view your account.");
    expect(html).not.toContain("workspace.admin");
    expect(html).not.toContain('aria-label="Change password"');
  });
});

describe("password change field feedback", () => {
  it("associates requirements with the fields the user can correct", () => {
    expect(passwordChangeValidation("", "short", "different")).toEqual({
      currentPassword: "Enter your current password.",
      newPassword: "Use 15–128 characters and include a non-space character.",
      confirmation: "The new passwords do not match.",
    });
    expect(
      passwordChangeValidation("current", "  Correct password  ", "  Correct password  "),
    ).toEqual({});
    expect(passwordChangeValidation("current", "  Correct password  ", "Correct password")).toEqual(
      { confirmation: "The new passwords do not match." },
    );
  });
});
