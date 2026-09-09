import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ReviewRunBlockedReasonSchema,
  ReviewRunPlannedJobSchema,
  ReviewRunReadinessSchema,
  ReviewRunRequestSchema,
  ReviewRunRunnerSupportSchema,
  ReviewRunTestedSourceAuthorizationSchema,
  ReviewRunTestedSourceRevisionSchema,
} from "./review-run.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

const request = {
  requestId: "desktop",
  workflowKind: "pr_ui",
  target: "windows_desktop",
  required: true,
  profileVersion: null,
  prompt: null,
};

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
}

describe("review run planning contracts", () => {
  it("represents an unconfigured workflow without inventing an executable profile", () => {
    expect(Value.Check(ReviewRunRequestSchema, request)).toBe(true);
    expect(Value.Check(ReviewRunPlannedJobSchema, { ...request, requiredCheckIds: [] })).toBe(true);
  });

  it.each(["windows_desktop", "web"])("preserves the explicit UI target %s", (target) => {
    expect(Value.Check(ReviewRunRequestSchema, { ...request, target })).toBe(true);
  });

  it("does not accept publication or dispatch controls as part of a requested job", () => {
    expect(Value.Check(ReviewRunRequestSchema, { ...request, leaseToken: "fake" })).toBe(false);
    expect(Value.Check(ReviewRunRequestSchema, { ...request, publish: true })).toBe(false);
    expect(Value.Check(ReviewRunRequestSchema, { ...request, artifactReuse: true })).toBe(false);
  });

  it("keeps a PR base/head pair separate from an explicitly selected issue source commit", () => {
    expect(
      Value.Check(ReviewRunTestedSourceRevisionSchema, {
        kind: "pull_request",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunTestedSourceRevisionSchema, { kind: "commit", headSha: "c".repeat(64) }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunTestedSourceRevisionSchema, { kind: "commit", branch: "main" }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceRevisionSchema, { kind: "commit", headSha: "a".repeat(41) }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceRevisionSchema, {
        kind: "pull_request",
        headSha: "a".repeat(40),
      }),
    ).toBe(false);
  });

  it("requires bounded, exact scope for an operator source authorization", () => {
    const authorization = {
      kind: "operator",
      activationId: "activation-1",
      issuer: "https://identity.example.com",
      subject: "operator-1",
      authorizedAt: "2026-09-07T00:00:00.000Z",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      issueRevisionKey: "a".repeat(64),
      headSha: "b".repeat(40),
    };
    expect(Value.Check(ReviewRunTestedSourceAuthorizationSchema, authorization)).toBe(true);
    expect(
      Value.Check(ReviewRunTestedSourceAuthorizationSchema, {
        ...authorization,
        issuer: "x".repeat(2_049),
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceAuthorizationSchema, {
        ...authorization,
        subject: "x".repeat(513),
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceAuthorizationSchema, { ...authorization, headSha: "main" }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceAuthorizationSchema, {
        ...authorization,
        executionApproved: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunTestedSourceAuthorizationSchema, {
        ...authorization,
        authorizedAt: "not-a-date",
      }),
    ).toBe(false);
  });

  it("bounds qualified check IDs while supporting maximum-length profile and step IDs", () => {
    const id = `${"p".repeat(128)}:${"s".repeat(128)}`;
    expect(Value.Check(QualifiedValidationCheckIdSchema, id)).toBe(true);
    expect(Value.Check(QualifiedValidationCheckIdSchema, `${id}x`)).toBe(false);
    expect(Value.Check(QualifiedValidationCheckIdSchema, "unqualified")).toBe(false);
    expect(Value.Check(ReviewRunPlannedJobSchema, { ...request, requiredCheckIds: [id] })).toBe(
      true,
    );
    expect(
      Value.Check(ReviewRunPlannedJobSchema, {
        ...request,
        requiredCheckIds: ["profile:step", "profile:step"],
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunPlannedJobSchema, {
        ...request,
        requiredCheckIds: Array.from({ length: 97 }, (_, index) => `profile:step-${index}`),
      }),
    ).toBe(false);
  });

  it("describes existing executor support without fabricated UI assertions or artifact availability", () => {
    const support = {
      workflowKind: "pr_ui",
      target: "web",
      capabilities: ["browser:chromium"],
      evidenceDelivery: true,
    };
    expect(Value.Check(ReviewRunRunnerSupportSchema, support)).toBe(true);
    expect(Value.Check(ReviewRunRunnerSupportSchema, { ...support, uiAssertions: true })).toBe(
      false,
    );
    expect(Value.Check(ReviewRunRunnerSupportSchema, { ...support, artifactInputs: true })).toBe(
      false,
    );
    expect(
      Value.Check(ReviewRunRunnerSupportSchema, {
        ...support,
        capabilities: ["browser:chromium", "browser:chromium"],
      }),
    ).toBe(false);
  });

  it.each([
    "missing_profile",
    "missing_prompt",
    "unsupported_target",
    "missing_scenarios",
    "missing_tested_source_revision",
  ])("preserves a typed planning blocker: %s", (code) =>
    expect(Value.Check(ReviewRunBlockedReasonSchema, { code })).toBe(true),
  );

  it("bounds readiness explanations and rejects nonplanning states", () => {
    const readiness = {
      requestId: "desktop",
      required: true,
      state: "blocked",
      reasons: [{ code: "missing_capability", capability: "desktop:interactive" }],
    };
    expect(Value.Check(ReviewRunReadinessSchema, readiness)).toBe(true);
    expect(Value.Check(ReviewRunReadinessSchema, { ...readiness, state: "running" })).toBe(false);
    expect(
      Value.Check(ReviewRunBlockedReasonSchema, { code: "missing_scenarios", passed: true }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunBlockedReasonSchema, {
        code: "missing_capability",
        capability: "x".repeat(129),
      }),
    ).toBe(false);
  });
});
