import type { ManagedRepository, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import {
  buildRepositoryUpdate,
  isConfigurationConflict,
  parseAllowlistedActors,
  parsePositiveSafeInteger,
  type RepositorySettingsValues,
  repositorySettingsValues,
} from "./form";

const repository = (overrides: Partial<ManagedRepository> = {}): ManagedRepository => ({
  id: "repository-1",
  githubRepositoryId: 165_898_499,
  fullName: "microsoft/PowerToys",
  enabled: true,
  version: 37,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
  connectionStatus: "ready",
  connectionMessage: null,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T01:00:00.000Z",
  ...overrides,
});

const customValues = (
  overrides: Partial<RepositorySettingsValues> = {},
): RepositorySettingsValues => ({
  enabled: true,
  reviewerMode: "custom",
  reviewerGithubUserId: "202",
  reviewerGithubLogin: "reviewer",
  policyMode: "custom",
  policyVersion: "9",
  schedulingTargetGithubUserId: "202",
  allowlistedActorGithubUserIds: "303\n404",
  newRevisionPolicy: "default",
  activeUnlimited: true,
  activeLimit: "1",
  queueUnlimited: true,
  queueLimit: "1",
  ...overrides,
});

describe("repository settings updates", () => {
  it.each([undefined, "require_new_authorization", "inherit_authorized_epoch"] as const)(
    "round-trips the complete authorization policy with newRevisionPolicy %s",
    (newRevisionPolicy) => {
      const policy: SelfOrAllowlistPolicy = {
        kind: "self_or_allowlist",
        policyVersion: 9,
        schedulingTargetGithubUserId: 202,
        allowlistedActorGithubUserIds: [303, 404],
        unknownActorPolicy: "deny",
        ...(newRevisionPolicy === undefined ? {} : { newRevisionPolicy }),
      };
      const current = repository({
        enabled: false,
        reviewerGithubUserId: 202,
        reviewerGithubLogin: "reviewer",
        authorizationPolicy: policy,
        schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      });
      const values = repositorySettingsValues(current);

      expect(values).toEqual(
        customValues({ enabled: false, newRevisionPolicy: newRevisionPolicy ?? "default" }),
      );
      const update = buildRepositoryUpdate(values, current.version);
      expect(update).toEqual({
        expectedVersion: 37,
        enabled: false,
        reviewerGithubUserId: 202,
        reviewerGithubLogin: "reviewer",
        authorizationPolicy: policy,
        schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      });
      if (newRevisionPolicy === undefined) {
        expect(update.authorizationPolicy).not.toHaveProperty("newRevisionPolicy");
      }
    },
  );

  it("round-trips null overrides as inheritance", () => {
    const current = repository();
    const values = repositorySettingsValues(current);

    expect(values).toEqual({
      enabled: true,
      reviewerMode: "inherit",
      reviewerGithubUserId: "",
      reviewerGithubLogin: "",
      policyMode: "inherit",
      policyVersion: "1",
      schedulingTargetGithubUserId: "",
      allowlistedActorGithubUserIds: "",
      newRevisionPolicy: "default",
      activeUnlimited: true,
      activeLimit: "1",
      queueUnlimited: true,
      queueLimit: "1",
    });
    expect(buildRepositoryUpdate(values, current.version)).toEqual({
      expectedVersion: 37,
      enabled: true,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
      schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
    });
  });

  it("clears overrides when inheritance is selected despite stale invalid inputs", () => {
    expect(
      buildRepositoryUpdate(
        customValues({
          reviewerMode: "inherit",
          reviewerGithubUserId: "invalid",
          reviewerGithubLogin: "invalid\u0000login",
          policyMode: "inherit",
          policyVersion: "invalid",
          schedulingTargetGithubUserId: "invalid",
          allowlistedActorGithubUserIds: "1,1",
          newRevisionPolicy: "inherit_authorized_epoch",
        }),
        38,
      ),
    ).toEqual({
      expectedVersion: 38,
      enabled: true,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
      schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
    });
  });

  it("preserves a configured reviewer with an inherited policy and seeds its target ID", () => {
    const current = repository({
      reviewerGithubUserId: 202,
      reviewerGithubLogin: "reviewer",
    });
    const values = repositorySettingsValues(current);

    expect(values.reviewerMode).toBe("custom");
    expect(values.policyMode).toBe("inherit");
    expect(values.schedulingTargetGithubUserId).toBe("202");
    expect(buildRepositoryUpdate(values, current.version)).toMatchObject({
      reviewerGithubUserId: 202,
      reviewerGithubLogin: "reviewer",
      authorizationPolicy: null,
    });
  });

  it("trims complete custom reviewer input", () => {
    expect(
      buildRepositoryUpdate(
        customValues({ reviewerGithubUserId: " 202 ", reviewerGithubLogin: " reviewer " }),
        37,
      ),
    ).toMatchObject({ reviewerGithubUserId: 202, reviewerGithubLogin: "reviewer" });
  });

  it.each([
    { reviewerGithubUserId: " ", reviewerGithubLogin: "reviewer" },
    { reviewerGithubUserId: "202", reviewerGithubLogin: "\t " },
    { reviewerGithubUserId: " ", reviewerGithubLogin: "\t " },
  ])("requires complete custom reviewer input or explicit inheritance: %j", (reviewer) => {
    expect(() =>
      buildRepositoryUpdate(customValues({ ...reviewer, policyMode: "inherit" }), 37),
    ).toThrow(/reviewer/iu);
  });

  it("rejects a custom authorization policy when the reviewer is inherited", () => {
    expect(() => buildRepositoryUpdate(customValues({ reviewerMode: "inherit" }), 37)).toThrow(
      /reviewer/iu,
    );
  });

  it("rejects a policy targeting a different reviewer ID", () => {
    expect(() =>
      buildRepositoryUpdate(customValues({ schedulingTargetGithubUserId: "101" }), 37),
    ).toThrow(/target/iu);
  });

  it("accepts the maximum safe integer in every editable numeric field", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const update = buildRepositoryUpdate(
      customValues({
        reviewerGithubUserId: maximum.toString(),
        policyVersion: maximum.toString(),
        schedulingTargetGithubUserId: maximum.toString(),
        allowlistedActorGithubUserIds: `1,${maximum}`,
      }),
      37,
    );

    expect(update.reviewerGithubUserId).toBe(maximum);
    expect(update.authorizationPolicy).toMatchObject({
      policyVersion: maximum,
      schedulingTargetGithubUserId: maximum,
      allowlistedActorGithubUserIds: [1, maximum],
    });
  });

  it.each([
    ["reviewerGithubUserId", "Reviewer ID"],
    ["policyVersion", "Policy version"],
    ["schedulingTargetGithubUserId", "Scheduling target ID"],
    ["allowlistedActorGithubUserIds", "Actor ID"],
  ] as const)("rejects unsafe integers in %s before submitting", (field, label) => {
    expect(() => buildRepositoryUpdate(customValues({ [field]: "9007199254740993" }), 37)).toThrow(
      label,
    );
  });

  it.each([
    "a".repeat(40),
    "-reviewer",
    "reviewer_name",
    "reviewer.name",
    "reviewer name",
    "reviewer\u0000name",
    "reviewer\nname",
    "reviewer\u007Fname",
  ])(
    "rejects reviewer logins outside the server configuration rules: %j",
    (reviewerGithubLogin) => {
      expect(() => buildRepositoryUpdate(customValues({ reviewerGithubLogin }), 37)).toThrow(
        "Reviewer login",
      );
    },
  );

  it.each(["a", "A0b-reviewer", "a".repeat(39)])(
    "accepts valid reviewer logins through the 39-character limit: %j",
    (reviewerGithubLogin) => {
      expect(buildRepositoryUpdate(customValues({ reviewerGithubLogin }), 37)).toMatchObject({
        reviewerGithubLogin,
      });
    },
  );
});

describe("repository numeric input", () => {
  it.each([
    ["1", 1],
    [" 00042 ", 42],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("parses %j without losing precision", (value, expected) => {
    expect(parsePositiveSafeInteger(String(value), "ID")).toBe(expected);
  });

  it.each([
    "",
    " ",
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "0x10",
    "NaN",
    "Infinity",
    "9007199254740992",
    "9007199254740993",
    "999999999999999999999999999999999999",
  ])("rejects invalid or unsafe integer text %j", (value) => {
    expect(() => parsePositiveSafeInteger(value, "ID")).toThrow("ID");
  });
});

describe("repository actor allowlist", () => {
  it("parses comma and whitespace separators while preserving actor order", () => {
    expect(parseAllowlistedActors(" 303, 101\n202\t404\r\n505 ")).toEqual([
      303, 101, 202, 404, 505,
    ]);
    expect(parseAllowlistedActors(" \t\r\n ")).toEqual([]);
  });

  it.each(["1,1", "7 007", "303\n101,303"])("rejects duplicate actor IDs in %j", (value) => {
    expect(() => parseAllowlistedActors(value)).toThrow("Each actor ID must appear only once.");
  });

  it("accepts 1,024 distinct actors and rejects an additional actor", () => {
    const ids = Array.from({ length: 1_024 }, (_, index) => index + 1);

    expect(parseAllowlistedActors(ids.join("\n"))).toEqual(ids);
    expect(() => parseAllowlistedActors([...ids, 1_025].join(","))).toThrow(
      "The allowlist can contain at most 1,024 actors.",
    );
  });
});

describe("repository configuration conflicts", () => {
  it("recognizes a compare-and-swap conflict returned by the control plane", () => {
    const error = new ReviewControlHttpError("Repository configuration changed.", {
      operation: "updateRepository",
      retryable: false,
      status: 409,
    });

    expect(isConfigurationConflict(error)).toBe(true);
    expect(isConfigurationConflict({ status: 409 })).toBe(true);
  });

  it.each([null, undefined, 409, "409", {}, { status: "409" }, { status: 400 }, { status: 500 }])(
    "does not classify unrelated failures as conflicts: %j",
    (error) => {
      expect(isConfigurationConflict(error)).toBe(false);
    },
  );
});
