import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  getValidationProfileConfigIssues,
  ManagedRepositorySchema,
  ManagedRepositorySummarySchema,
  maximumConfigurationActorLength,
  maximumPromptContentUtf8Bytes,
  PromptBindingSchema,
  PromptDraftPublishRequestSchema,
  PromptDraftSaveRequestSchema,
  PromptPreviewRequestSchema,
  PromptTemplateCreateRequestSchema,
  PromptTemplateSchema,
  PromptTemplateSummarySchema,
  PromptVersionSchema,
  PromptVersionSummarySchema,
  RepositoryCreateRequestSchema,
  RepositoryPromptBindingSaveRequestSchema,
  RepositoryPromptBindingSchema,
  RepositoryUpdateRequestSchema,
  SchedulingLimitsSchema,
  TrustedValidationCommandSchema,
  type ValidationProfileConfig,
  ValidationProfileConfigSchema,
  ValidationProfileCreateRequestSchema,
  ValidationProfileVersionSchema,
  ValidationProfileVersionSummarySchema,
  WorkflowKindValues,
  WorkflowOutputSchemaVersions,
} from "./platform-configuration.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const timestamp = "2026-09-07T00:00:00.000Z";
const repository = {
  id: "repository-1",
  githubRepositoryId: 165_898_499,
  fullName: "microsoft/PowerToys",
  enabled: true,
  version: 1,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
  connectionStatus: "unknown",
  connectionMessage: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const command = {
  executable: "dotnet",
  args: ["test", "--no-build"],
  workingDirectory: "src",
  environment: [{ name: "CI", value: "true" }],
};
const step = {
  id: "unit-tests",
  name: "Unit tests",
  command,
  timeoutMs: 60_000,
  required: true,
};
const config: ValidationProfileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [],
  test: [step],
  launch: [],
  cleanup: [],
  requiredCapabilities: ["os.windows", "tool.dotnet"],
  hardTimeoutMs: 600_000,
  noProgressTimeoutMs: 120_000,
};

describe("managed repository configuration", () => {
  it("requires current limits on detail and summary DTOs", () => {
    const { schedulingLimits: _schedulingLimits, ...withoutLimits } = repository;
    const { authorizationPolicy: _authorizationPolicy, ...summary } = withoutLimits;
    expect(Value.Check(ManagedRepositorySchema, withoutLimits)).toBe(false);
    expect(Value.Check(ManagedRepositorySummarySchema, summary)).toBe(false);
  });

  it("accepts complete scheduling replacements while preserving create and PATCH omission", () => {
    const identity = {
      githubRepositoryId: repository.githubRepositoryId,
      fullName: repository.fullName,
    };
    expect(Value.Check(RepositoryCreateRequestSchema, identity)).toBe(true);
    for (const schedulingLimits of [
      { maxActiveLeases: null, maxQueuedJobs: null },
      { maxActiveLeases: 2, maxQueuedJobs: 10 },
    ]) {
      expect(Value.Check(RepositoryCreateRequestSchema, { ...identity, schedulingLimits })).toBe(
        true,
      );
      expect(
        Value.Check(RepositoryUpdateRequestSchema, { expectedVersion: 1, schedulingLimits }),
      ).toBe(true);
    }
    for (const schedulingLimits of [null, {}, { maxActiveLeases: 1 }, { maxQueuedJobs: null }]) {
      expect(Value.Check(RepositoryCreateRequestSchema, { ...identity, schedulingLimits })).toBe(
        false,
      );
      expect(
        Value.Check(RepositoryUpdateRequestSchema, { expectedVersion: 1, schedulingLimits }),
      ).toBe(false);
    }
  });

  it("omits authorization policy from list summaries and rejects it as an extra field", () => {
    const { authorizationPolicy, ...summary } = repository;
    expect(Value.Check(ManagedRepositorySummarySchema, summary)).toBe(true);
    expect(Value.Check(ManagedRepositorySummarySchema, { ...summary, authorizationPolicy })).toBe(
      false,
    );
    expect(Value.Check(ManagedRepositorySummarySchema, { ...summary, unexpected: true })).toBe(
      false,
    );
    expect(Value.Check(ManagedRepositorySchema, summary)).toBe(false);
  });

  it("keeps stable repository identity separate from display and readiness metadata", () => {
    expect(Value.Check(ManagedRepositorySchema, repository)).toBe(true);
    expect(
      Value.Check(ManagedRepositorySchema, {
        ...repository,
        fullName: "another-owner/Renamed.Repository",
        version: 2,
        connectionStatus: "ready",
      }),
    ).toBe(true);
    expect(
      Value.Check(RepositoryCreateRequestSchema, {
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
      }),
    ).toBe(true);
  });

  it.each([
    "../repo",
    "owner/..",
    "owner/repo?token=x",
    "owner\\repo",
    "owner/repo/extra",
    "owner/repo\n",
  ])("rejects unsafe repository names: %s", (fullName) => {
    expect(Value.Check(RepositoryCreateRequestSchema, { githubRepositoryId: 1, fullName })).toBe(
      false,
    );
  });

  it("requires a changed configuration field and a positive CAS version", () => {
    expect(Value.Check(RepositoryUpdateRequestSchema, { expectedVersion: 1, enabled: false })).toBe(
      true,
    );
    expect(Value.Check(RepositoryUpdateRequestSchema, { enabled: false })).toBe(false);
    expect(Value.Check(RepositoryUpdateRequestSchema, { expectedVersion: 0, enabled: false })).toBe(
      false,
    );
    expect(Value.Check(RepositoryUpdateRequestSchema, { expectedVersion: 1 })).toBe(false);
  });

  it.each(["id", "githubRepositoryId", "fullName", "connectionStatus", "createdBy"])(
    "does not let an update overwrite server-owned %s",
    (field) => {
      expect(
        Value.Check(RepositoryUpdateRequestSchema, {
          expectedVersion: 1,
          enabled: false,
          [field]: "replacement",
        }),
      ).toBe(false);
    },
  );

  it("rejects malformed repository authorization policies", () => {
    const authorizationPolicy = {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: 123,
      allowlistedActorGithubUserIds: [456],
      unknownActorPolicy: "deny",
    };
    expect(Value.Check(ManagedRepositorySchema, { ...repository, authorizationPolicy })).toBe(true);
    expect(
      Value.Check(ManagedRepositorySchema, {
        ...repository,
        authorizationPolicy: { ...authorizationPolicy, unknownActorPolicy: "allow" },
      }),
    ).toBe(false);
  });
});

describe("scheduling limits", () => {
  it.each([
    ["maxActiveLeases", 65_535],
    ["maxQueuedJobs", 1_000_000],
  ] as const)("bounds %s and preserves explicit unlimited values", (field, maximum) => {
    const limits = { maxActiveLeases: null, maxQueuedJobs: null };
    for (const value of [null, 1, maximum]) {
      expect(Value.Check(SchedulingLimitsSchema, { ...limits, [field]: value })).toBe(true);
    }
    for (const value of [0, -1, 1.5, maximum + 1, NaN, Infinity, "1", true, undefined]) {
      expect(Value.Check(SchedulingLimitsSchema, { ...limits, [field]: value })).toBe(false);
    }
    expect(Value.Check(SchedulingLimitsSchema, { ...limits, unexpected: true })).toBe(false);
  });
});

describe("prompt draft and publication contracts", () => {
  it.each(["before\u0000after", "before\n", "before\tafter", "before\u007Fafter", "   "])(
    "rejects embedded control characters and blank configuration names",
    (name) => {
      expect(
        Value.Check(PromptTemplateCreateRequestSchema, {
          name,
          workflowKind: "pr_static_build",
          content: "Review the original revision.",
          outputSchemaVersion: "PrReviewPlanV2",
        }),
      ).toBe(false);
    },
  );

  it.each(WorkflowKindValues)(
    "keeps %s prompt lists free of draft and published content",
    (workflowKind) => {
      const templateSummary = {
        id: "prompt-1",
        name: "Repository review",
        workflowKind,
        description: "Review the selected revision.",
        version: 2,
        draftRevision: 1,
        draftOutputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
        latestPublishedVersionId: "prompt-version-1",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      expect(Value.Check(PromptTemplateSummarySchema, templateSummary)).toBe(true);
      expect(
        Value.Check(PromptTemplateSummarySchema, {
          ...templateSummary,
          draftContent: "Full draft.",
        }),
      ).toBe(false);
      expect(
        Value.Check(PromptTemplateSummarySchema, { ...templateSummary, unexpected: true }),
      ).toBe(false);
      expect(Value.Check(PromptTemplateSchema, templateSummary)).toBe(false);

      const versionSummary = {
        id: "prompt-version-1",
        templateId: "prompt-1",
        version: 1,
        contentSha256: "a".repeat(64),
        outputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
        createdAt: timestamp,
        publishedAt: timestamp,
        createdBy: "local/operator-1",
      };
      expect(Value.Check(PromptVersionSummarySchema, versionSummary)).toBe(true);
      expect(
        Value.Check(PromptVersionSummarySchema, {
          ...versionSummary,
          content: "Full published content.",
        }),
      ).toBe(false);
      expect(Value.Check(PromptVersionSummarySchema, { ...versionSummary, unexpected: true })).toBe(
        false,
      );
      expect(Value.Check(PromptVersionSchema, versionSummary)).toBe(false);
    },
  );

  it.each(WorkflowKindValues)("binds %s to its deployed output schema", (workflowKind) => {
    const request = {
      name: "Repository review",
      workflowKind,
      content: "Review the supplied revision and report concrete findings.",
      outputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
    };
    expect(Value.Check(PromptTemplateCreateRequestSchema, request)).toBe(true);
    expect(
      Value.Check(PromptTemplateCreateRequestSchema, {
        ...request,
        outputSchemaVersion: "CustomV1",
      }),
    ).toBe(false);
    const incompatibleSchema = workflowKind === "issue_triage" ? "PrReviewPlanV2" : "IssueTriageV2";
    expect(
      Value.Check(PromptTemplateCreateRequestSchema, {
        ...request,
        outputSchemaVersion: incompatibleSchema,
      }),
    ).toBe(false);
    expect(
      Value.Check(PromptTemplateCreateRequestSchema, {
        ...request,
        outputSchema: { type: "object" },
      }),
    ).toBe(false);
  });

  it("separates mutable draft revisions from immutable published versions", () => {
    const template = {
      id: "prompt-1",
      name: "PR static review",
      workflowKind: "pr_static_build",
      description: "Static review and build checks.",
      version: 4,
      draftRevision: 3,
      draftContent: "Review the original PR revision.",
      draftOutputSchemaVersion: "PrReviewPlanV2",
      latestPublishedVersionId: "prompt-version-1",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(Value.Check(PromptTemplateSchema, template)).toBe(true);
    const version = {
      id: "prompt-version-1",
      templateId: template.id,
      version: 1,
      content: "Published content remains unchanged when the draft is edited.",
      contentSha256: "a".repeat(64),
      outputSchemaVersion: "PrReviewPlanV2",
      createdAt: timestamp,
      publishedAt: timestamp,
      createdBy: "https://issuer.example/operator-1",
    };
    expect(Value.Check(PromptVersionSchema, version)).toBe(true);
    expect(Value.Check(PromptVersionSchema, { ...version, outputSchema: {} })).toBe(false);
    expect(
      Value.Check(PromptVersionSchema, {
        ...version,
        createdBy: JSON.stringify(["i".repeat(2_048), "s".repeat(512)]),
      }),
    ).toBe(true);
    expect(
      Value.Check(PromptVersionSchema, {
        ...version,
        createdBy: "a".repeat(maximumConfigurationActorLength + 1),
      }),
    ).toBe(false);
    expect(Value.Check(PromptVersionSchema, { ...version, contentSha256: "old-digest" })).toBe(
      false,
    );
  });

  it("publishes only the CAS-selected draft, without caller-supplied content or attribution", () => {
    expect(Value.Check(PromptDraftPublishRequestSchema, { expectedVersion: 4 })).toBe(true);
    expect(Value.Check(PromptDraftPublishRequestSchema, {})).toBe(false);
    expect(
      Value.Check(PromptDraftPublishRequestSchema, {
        expectedVersion: 4,
        content: "Different draft",
      }),
    ).toBe(false);
    expect(
      Value.Check(PromptDraftPublishRequestSchema, {
        expectedVersion: 4,
        createdBy: "another-user",
      }),
    ).toBe(false);
    expect(
      Value.Check(PromptDraftSaveRequestSchema, {
        expectedVersion: 4,
        content: "A new draft.",
        outputSchemaVersion: "PrReviewPlanV2",
      }),
    ).toBe(true);
    expect(
      Value.Check(PromptDraftSaveRequestSchema, {
        expectedVersion: 4,
        content: "A model must not produce runner check results.",
        outputSchemaVersion: "ValidationReportV1",
      }),
    ).toBe(false);
  });

  it.each(["", " \n\t ", "text\u0000text", "x".repeat(maximumPromptContentUtf8Bytes + 1)])(
    "rejects empty, NUL-containing, or oversized prompt content",
    (content) => {
      expect(Value.Check(PromptPreviewRequestSchema, { content })).toBe(false);
    },
  );

  it("limits preview input to a bounded prompt and authorized work-item reference", () => {
    expect(
      Value.Check(PromptPreviewRequestSchema, {
        content: "Review {{workItem}}.",
        workItemId: "item-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(PromptPreviewRequestSchema, {
        content: "Review {{workItem}}.",
        repositoryId: "other-repository",
        workItemSnapshot: {},
      }),
    ).toBe(false);
  });

  it("requires a version for binding changes and supports new bindings at version zero", () => {
    expect(
      Value.Check(RepositoryPromptBindingSaveRequestSchema, {
        expectedVersion: 0,
        promptVersionId: "published-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(RepositoryPromptBindingSaveRequestSchema, { promptVersionId: "published-1" }),
    ).toBe(false);
    expect(
      Value.Check(RepositoryPromptBindingSaveRequestSchema, {
        expectedVersion: 1,
        promptVersionId: "published-1",
        content: "Replace published content",
      }),
    ).toBe(false);
  });

  it("represents an explicit global default separately from a repository binding", () => {
    const binding = {
      repositoryId: null,
      workflowKind: "pr_static_build",
      promptVersionId: "prompt-version-1",
      version: 1,
    };
    expect(Value.Check(PromptBindingSchema, binding)).toBe(true);
    expect(Value.Check(RepositoryPromptBindingSchema, binding)).toBe(false);
    expect(Value.Check(PromptBindingSchema, { ...binding, repositoryId: "repository-1" })).toBe(
      true,
    );
    expect(
      Value.Check(RepositoryPromptBindingSchema, { ...binding, repositoryId: "repository-1" }),
    ).toBe(true);
  });
});

describe("published validation profiles", () => {
  const request = {
    name: "Static checks",
    workflowKind: "pr_static_build",
    target: "headless",
    config,
    required: true,
    outputSchemaVersion: "PrReviewPlanV2",
  };

  it.each([
    { workflowKind: "pr_static_build", target: "headless", outputSchemaVersion: "PrReviewPlanV2" },
    { workflowKind: "pr_ui", target: "windows_desktop", outputSchemaVersion: "ValidationReportV1" },
    { workflowKind: "pr_ui", target: "web", outputSchemaVersion: "ValidationReportV1" },
    { workflowKind: "issue_triage", target: "headless", outputSchemaVersion: "IssueTriageV2" },
    { workflowKind: "issue_validation", target: "web", outputSchemaVersion: "ValidationReportV1" },
  ])(
    "keeps $workflowKind / $target list summaries free of execution configuration",
    (workflowTarget) => {
      const summary = {
        ...workflowTarget,
        id: "profile-version-1",
        profileId: "profile-1",
        repositoryId: "repository-1",
        name: "Validation profile",
        version: 1,
        required: true,
        configSha256: "b".repeat(64),
        createdAt: timestamp,
        publishedAt: timestamp,
        createdBy: "local/operator-1",
      };
      expect(Value.Check(ValidationProfileVersionSummarySchema, summary)).toBe(true);
      expect(Value.Check(ValidationProfileVersionSummarySchema, { ...summary, config })).toBe(
        false,
      );
      expect(
        Value.Check(ValidationProfileVersionSummarySchema, { ...summary, unexpected: true }),
      ).toBe(false);
      expect(Value.Check(ValidationProfileVersionSchema, summary)).toBe(false);
    },
  );

  it("accepts distinct Windows desktop and Web targets with the validation report schema", () => {
    expect(Value.Check(ValidationProfileCreateRequestSchema, request)).toBe(true);
    for (const target of ["windows_desktop", "web"]) {
      expect(
        Value.Check(ValidationProfileCreateRequestSchema, {
          ...request,
          workflowKind: "pr_ui",
          target,
          outputSchemaVersion: "ValidationReportV1",
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, {
        ...request,
        workflowKind: "pr_ui",
        outputSchemaVersion: "ValidationReportV1",
      }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, {
        ...request,
        target: "web",
      }),
    ).toBe(false);
  });

  it("reads immutable configuration metadata without accepting it in publication requests", () => {
    const version = {
      ...request,
      id: "profile-version-1",
      profileId: "profile-1",
      repositoryId: "repository-1",
      version: 1,
      configSha256: "b".repeat(64),
      createdAt: timestamp,
      publishedAt: timestamp,
      createdBy: "local/operator-1",
    };
    expect(Value.Check(ValidationProfileVersionSchema, version)).toBe(true);
    expect(Value.Check(ValidationProfileCreateRequestSchema, version)).toBe(false);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, { ...request, result: "passed" }),
    ).toBe(false);
  });

  it("requires CAS when publishing another version of an existing profile", () => {
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, { ...request, expectedVersion: 0 }),
    ).toBe(true);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, { ...request, expectedVersion: 1 }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, { ...request, profileId: "profile-1" }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, {
        ...request,
        profileId: "profile-1",
        expectedVersion: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileCreateRequestSchema, {
        ...request,
        profileId: "profile-1",
        expectedVersion: 1,
      }),
    ).toBe(true);
  });

  it.each([
    "../outside",
    "src/../../outside",
    "/tmp",
    "C:/temp",
    "\\\\host\\share",
    "src\\..\\outside",
  ])("rejects a working directory outside the normalized workspace: %s", (workingDirectory) => {
    expect(Value.Check(TrustedValidationCommandSchema, { ...command, workingDirectory })).toBe(
      false,
    );
  });

  it("accepts references for credentials and rejects NUL arguments and ambiguous commands", () => {
    expect(
      Value.Check(TrustedValidationCommandSchema, {
        ...command,
        environment: [{ name: "TEST_PASSWORD", secretRef: "test-password" }],
      }),
    ).toBe(true);
    expect(Value.Check(TrustedValidationCommandSchema, { ...command, shell: true })).toBe(false);
    expect(
      Value.Check(TrustedValidationCommandSchema, { ...command, args: ["bad\u0000argument"] }),
    ).toBe(false);
    expect(
      Value.Check(TrustedValidationCommandSchema, {
        ...command,
        environment: [{ name: "TEST_PASSWORD", value: "raw", secretRef: "test-password" }],
      }),
    ).toBe(false);
  });

  it("bounds command counts, capability counts, and execution budgets", () => {
    expect(Value.Check(ValidationProfileConfigSchema, config)).toBe(true);
    expect(
      Value.Check(ValidationProfileConfigSchema, {
        ...config,
        test: Array.from({ length: 33 }, () => step),
      }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileConfigSchema, { ...config, hardTimeoutMs: 86_400_001 }),
    ).toBe(false);
    expect(
      Value.Check(ValidationProfileConfigSchema, {
        ...config,
        requiredCapabilities: ["web", "web"],
      }),
    ).toBe(false);
    expect(Value.Check(ValidationProfileConfigSchema, { ...config, scenario: {} })).toBe(false);
  });

  it("checks cross-stage identity, Windows environment-name collisions, and secret references", () => {
    expect(getValidationProfileConfigIssues(config)).toEqual([]);
    const issues = getValidationProfileConfigIssues({
      ...config,
      setup: [step],
      test: [
        {
          ...step,
          command: {
            ...command,
            environment: [
              { name: "Path", value: "first" },
              { name: "PATH", value: "second" },
              { name: "API_TOKEN", value: "plaintext" },
            ],
          },
        },
      ],
    });
    expect(issues.some((issue) => issue.includes("Step ID unit-tests is duplicated"))).toBe(true);
    expect(issues.some((issue) => issue.includes("repeats environment variable PATH"))).toBe(true);
    expect(issues.some((issue) => issue.includes("API_TOKEN must use a secret reference"))).toBe(
      true,
    );
  });

  it("keeps issue triage static while preserving execution steps for validation workflows", () => {
    expect(getValidationProfileConfigIssues(config, "pr_static_build")).toEqual([]);
    expect(getValidationProfileConfigIssues(config, "issue_triage")).toEqual([
      "Issue triage must not execute test steps.",
    ]);
    expect(getValidationProfileConfigIssues({ ...config, test: [] }, "issue_triage")).toEqual([]);
    for (const stage of ["setup", "build", "test", "launch", "cleanup"] as const) {
      const issues = getValidationProfileConfigIssues(
        { ...config, test: [], [stage]: [step] },
        "issue_triage",
      );
      expect(issues).toEqual([`Issue triage must not execute ${stage} steps.`]);
    }
  });

  it("rejects semantically impossible timeouts and oversized UTF-8 configurations", () => {
    expect(
      getValidationProfileConfigIssues({ ...config, hardTimeoutMs: 30_000 }).some((issue) =>
        issue.includes("no-progress timeout"),
      ),
    ).toBe(true);
    expect(
      getValidationProfileConfigIssues({ ...config, hardTimeoutMs: 30_000 }).some((issue) =>
        issue.includes("Step unit-tests timeout"),
      ),
    ).toBe(true);
    const multibyteConfig = {
      ...config,
      test: [
        {
          ...step,
          command: { ...command, args: Array.from({ length: 20 }, () => "界".repeat(8_192)) },
        },
      ],
    };
    expect(Value.Check(ValidationProfileConfigSchema, multibyteConfig)).toBe(true);
    expect(
      getValidationProfileConfigIssues(multibyteConfig).some((issue) =>
        issue.includes("UTF-8 bytes"),
      ),
    ).toBe(true);
  });
});
