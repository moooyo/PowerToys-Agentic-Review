import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvestigationAccountSchema,
  InvestigationCreateAccountRequestSchema,
  InvestigationLoginRequestSchema,
  InvestigationNewPasswordSchema,
  InvestigationSessionSchema,
  InvestigationUpdateAccountRequestSchema,
  normalizeInvestigationUsername,
} from "./investigation-auth.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const account = {
  id: "account-example",
  username: "example.admin",
  displayName: "Example Administrator",
  isAdmin: true,
  enabled: true,
  version: 1,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  repositoryIds: ["repo-example"],
  permissions: ["task:create"],
  actionCapabilities: ["start-task"],
  allowRepositoryExecution: false,
};

describe("built-in investigation account contracts", () => {
  it("accepts a public account without exposing credential fields", () => {
    expect(Value.Check(InvestigationAccountSchema, account)).toBe(true);
    for (const key of ["password", "passwordHash", "salt", "sessionToken"])
      expect(Value.Check(InvestigationAccountSchema, { ...account, [key]: "secret" })).toBe(false);
  });

  it("normalizes username input but requires a canonical public identity", () => {
    expect(normalizeInvestigationUsername(" Example.Admin ")).toBe("example.admin");
    expect(
      Value.Check(InvestigationLoginRequestSchema, {
        username: " Example.Admin ",
        password: "Incorrect passwords still reach credential verification",
      }),
    ).toBe(true);
    expect(Value.Check(InvestigationAccountSchema, { ...account, username: "Example.Admin" })).toBe(
      false,
    );
    expect(Value.Check(InvestigationAccountSchema, { ...account, username: "../admin" })).toBe(
      false,
    );
  });

  it("rejects implicit broad access, unknown permissions, and repeated grants", () => {
    expect(Value.Check(InvestigationAccountSchema, { ...account, repositoryIds: ["*"] })).toBe(
      false,
    );
    expect(
      Value.Check(InvestigationAccountSchema, { ...account, permissions: ["superuser"] }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationAccountSchema, {
        ...account,
        permissions: ["task:create", "task:create"],
      }),
    ).toBe(false);
  });

  it("requires an identity and expiration for authenticated sessions", () => {
    const {
      enabled: _enabled,
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...user
    } = account;
    const session = {
      authenticated: true,
      authMode: "password",
      loginPath: "/api/auth/login",
      user: { ...user, email: null },
      expiresAt: "2026-09-15T08:00:00Z",
    };
    expect(Value.Check(InvestigationSessionSchema, session)).toBe(true);
    expect(Value.Check(InvestigationSessionSchema, { ...session, user: null })).toBe(false);
    expect(Value.Check(InvestigationSessionSchema, { ...session, expiresAt: undefined })).toBe(
      false,
    );
    expect(Value.Check(InvestigationSessionSchema, { ...session, authMode: "loopback" })).toBe(
      false,
    );
    expect(Value.Check(InvestigationSessionSchema, { ...session, authMode: "oidc" })).toBe(false);
    expect(
      Value.Check(InvestigationSessionSchema, {
        authenticated: false,
        authMode: "password",
        loginPath: "/api/auth/login",
        user: null,
      }),
    ).toBe(true);
  });

  it("validates new passwords without silently changing their contents", () => {
    expect(Value.Check(InvestigationNewPasswordSchema, "A sufficiently long password")).toBe(true);
    expect(Value.Check(InvestigationNewPasswordSchema, "x".repeat(14))).toBe(false);
    expect(Value.Check(InvestigationNewPasswordSchema, "x".repeat(129))).toBe(false);
    expect(Value.Check(InvestigationNewPasswordSchema, " ".repeat(20))).toBe(false);
    expect(Value.Check(InvestigationNewPasswordSchema, "🔐".repeat(128))).toBe(true);
    expect(Value.Check(InvestigationNewPasswordSchema, "🔐".repeat(14))).toBe(false);
    expect(Value.Check(InvestigationNewPasswordSchema, "x".repeat(128) + "\n")).toBe(false);
    expect(Value.Check(InvestigationNewPasswordSchema, "\uD800".repeat(15))).toBe(false);
  });

  it("requires explicit grants at creation and a version for changes", () => {
    expect(
      Value.Check(InvestigationCreateAccountRequestSchema, {
        username: "example",
        password: "A sufficiently long password",
        displayName: "Example",
        isAdmin: false,
      }),
    ).toBe(false);
    const update = {
      version: 1,
      displayName: "Example",
      enabled: true,
      isAdmin: false,
      repositoryIds: [],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    };
    expect(Value.Check(InvestigationUpdateAccountRequestSchema, update)).toBe(true);
    expect(Value.Check(InvestigationUpdateAccountRequestSchema, { ...update, version: 0 })).toBe(
      false,
    );
    expect(
      Value.Check(InvestigationUpdateAccountRequestSchema, { ...update, username: "renamed" }),
    ).toBe(false);
  });
});
