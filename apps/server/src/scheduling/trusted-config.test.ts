import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maximumPromptContentUtf8Bytes, type PromptVersion } from "@agentic-review/contracts";
import { CloneType, Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  IssueTriageV1ModelOutputSchema,
  IssueTriageV2ModelOutputSchema,
  IssueTriageV2Schema,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "../../../../packages/codex/src/review-results.js";
import { defaultTrustedSchedulingPolicy } from "../../dist/scheduling/default-policy.js";
import {
  isLoadedTrustedSchedulingConfig,
  loadTrustedSchedulingConfig,
  type TrustedSchedulingPolicy,
  withPublishedWorkflowPrompt,
} from "../../dist/scheduling/trusted-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) {
      continue;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Unable to clean scheduling test directories.");
  }
});

describe("loadTrustedSchedulingConfig", () => {
  it("loads the production default policy without shared-object validation failures", async () => {
    const fixture = await createPromptFixture();
    const config = await loadTrustedSchedulingConfig({
      promptDirectory: fixture.promptDirectory,
      policy: defaultTrustedSchedulingPolicy,
      outputSchemas: schemas,
    });

    expect(config.issueTriage.policy).toEqual(defaultTrustedSchedulingPolicy.issueTriage);
    expect(config.pullRequestReview.policy).toEqual(
      defaultTrustedSchedulingPolicy.pullRequestReview,
    );
    expect(config.issueTriage.policy.intentVersion).toBe(2);
    expect(config.pullRequestReview.policy.intentVersion).toBe(2);
  });

  it("loads only the fixed versioned prompts from an absolute trusted directory", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);

    expect(config.issueTriage).toMatchObject({
      name: "issue-triage",
      version: "2",
      text: fixture.issuePrompt,
      outputSchema: { type: "object" },
      policy: createPolicy().issueTriage,
    });
    expect(config.pullRequestReview).toMatchObject({
      name: "pull-request-review",
      version: "2",
      text: fixture.pullRequestPrompt,
      outputSchema: { type: "object" },
      policy: createPolicy().pullRequestReview,
    });
    expect(config.issueTriage.outputSchema).toEqual(
      JSON.parse(JSON.stringify(IssueTriageV2ModelOutputSchema)),
    );
    expect(config.pullRequestReview.outputSchema).toEqual(
      JSON.parse(JSON.stringify(PrReviewPlanV2ModelOutputSchema)),
    );
    expect(config.issueTriage.outputSchema).not.toHaveProperty("$id");
    expect(config.pullRequestReview.outputSchema).not.toHaveProperty("$id");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.issueTriage.policy.executionPolicy)).toBe(true);
    expect(JSON.stringify(config)).not.toContain(fixture.promptDirectory);
  });

  it("rejects a relative prompt directory without resolving it against the process cwd", async () => {
    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: "config/prompts",
        policy: createPolicy(),
        outputSchemas: schemas,
      }),
    ).rejects.toThrow(/absolute path/u);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a prompt file that is a symbolic link",
    async () => {
      const fixture = await createPromptFixture();
      const issuePromptPath = join(fixture.promptDirectory, "issue-triage-v2.md");
      const outsidePromptPath = join(fixture.root, "outside-issue-prompt.md");
      await rm(issuePromptPath);
      await writeFile(outsidePromptPath, "Outside prompt", "utf8");
      await symlink(outsidePromptPath, issuePromptPath, "file");

      await expect(loadFixture(fixture.promptDirectory)).rejects.toThrow(
        /symbolic link|reparse-point/u,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a trusted directory reached through a linked ancestor",
    async () => {
      const fixture = await createPromptFixture();
      const linkedRoot = join(fixture.root, "linked-root");
      await symlink(fixture.root, linkedRoot, "dir");
      const linkedPromptDirectory = join(linkedRoot, "prompts");

      await expect(loadFixture(linkedPromptDirectory)).rejects.toThrow(
        /ancestor|symbolic link|reparse point/u,
      );
    },
  );

  it("rejects missing and empty fixed prompt files", async () => {
    const missingFixture = await createPromptFixture();
    await rm(join(missingFixture.promptDirectory, "issue-triage-v2.md"));
    await expect(loadFixture(missingFixture.promptDirectory)).rejects.toThrow(/inspect/u);

    const emptyFixture = await createPromptFixture();
    await writeFile(join(emptyFixture.promptDirectory, "issue-triage-v2.md"), "", "utf8");
    await expect(loadFixture(emptyFixture.promptDirectory)).rejects.toThrow(/between 1/u);
  });

  it("rejects non-authoritative or crossed output schemas", async () => {
    const fixture = await createPromptFixture();
    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: PrReviewPlanV2ModelOutputSchema,
          pullRequestReview: IssueTriageV2ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV2/u);

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: CloneType(IssueTriageV2Schema),
          pullRequestReview: PrReviewPlanV2ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV2/u);

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: Type.Unknown({ $id: "IssueTriageV2" }),
          pullRequestReview: PrReviewPlanV2ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV2/u);
  });

  it("rejects previous and modified output schemas for the V2 prompt defaults", async () => {
    const fixture = await createPromptFixture();
    const changedIssueSchema = Type.Object(
      {
        ...IssueTriageV2ModelOutputSchema.properties,
        summary: Type.Number(),
      },
      { additionalProperties: false },
    );

    for (const issueTriage of [IssueTriageV1ModelOutputSchema, changedIssueSchema]) {
      await expect(
        loadTrustedSchedulingConfig({
          promptDirectory: fixture.promptDirectory,
          policy: createPolicy(),
          outputSchemas: { issueTriage, pullRequestReview: PrReviewPlanV2ModelOutputSchema },
        }),
      ).rejects.toThrow(/authoritative IssueTriageV2/u);
    }
    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: IssueTriageV2ModelOutputSchema,
          pullRequestReview: PrReviewPlanV1ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative PrReviewPlanV2/u);
  });

  it("requires worker selection capabilities to cover execution policy labels", async () => {
    const fixture = await createPromptFixture();
    const policy = createPolicy();
    policy.issueTriage.requiredCapabilities = {
      labels: { execution: "enabled" },
    };

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy,
        outputSchemas: schemas,
      }),
    ).rejects.toThrow(/processHost.*requiredCapabilityLabels/u);
  });

  it("rejects secret-bearing capability policy fields", async () => {
    const fixture = await createPromptFixture();
    const policy = createPolicy();
    const labels = policy.issueTriage.executionPolicy.requiredCapabilityLabels as Record<
      string,
      string
    >;
    labels.accessToken = "must-not-enter-an-envelope";

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy,
        outputSchemas: schemas,
      }),
    ).rejects.toThrow(/accessToken.*not permitted/u);
  });

  it("validates numeric and execution policy fields with TypeBox", async () => {
    const fixture = await createPromptFixture();
    const invalidPolicy = {
      ...createPolicy(),
      issueTriage: {
        ...createPolicy().issueTriage,
        maxAttempts: 0,
      },
    } as TrustedSchedulingPolicy;

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: invalidPolicy,
        outputSchemas: schemas,
      }),
    ).rejects.toThrow(/policy is invalid/u);
  });

  it("rejects policies outside the Worker execution contract", async () => {
    const fixture = await createPromptFixture();
    const mutations: Array<(policy: TrustedSchedulingPolicy) => void> = [
      (policy) => {
        policy.issueTriage.priority = 1_000_001;
      },
      (policy) => {
        policy.issueTriage.executionPolicy.hardTimeoutMs = 999;
      },
      (policy) => {
        policy.issueTriage.executionPolicy.hardTimeoutMs = 86_400_001;
      },
      (policy) => {
        policy.issueTriage.executionPolicy.noProgressTimeoutMs = 300_001;
      },
      (policy) => {
        policy.pullRequestReview.executionPolicy.allowedRecipeIds = ["invalid recipe id"];
      },
      (policy) => {
        policy.issueTriage.executionPolicy.requiredCapabilityLabels = {
          "invalid label": "value",
        };
      },
    ];

    for (const mutate of mutations) {
      const policy = createPolicy();
      mutate(policy);
      await expect(
        loadTrustedSchedulingConfig({
          promptDirectory: fixture.promptDirectory,
          policy,
          outputSchemas: schemas,
        }),
      ).rejects.toThrow(/policy is invalid|must not exceed/u);
    }
  });
});

describe("withPublishedWorkflowPrompt", () => {
  it.each([
    {
      workflowKind: "issue_triage",
      selectedKey: "issueTriage",
      unchangedKey: "pullRequestReview",
      outputSchemaVersion: "IssueTriageV2",
    },
    {
      workflowKind: "pr_static_build",
      selectedKey: "pullRequestReview",
      unchangedKey: "issueTriage",
      outputSchemaVersion: "PrReviewPlanV2",
    },
  ] as const)(
    "applies the published $workflowKind prompt while preserving trusted policy and schema",
    async ({ workflowKind, selectedKey, unchangedKey, outputSchemaVersion }) => {
      const fixture = await createPromptFixture();
      const config = await loadFixture(fixture.promptDirectory);
      const originalConfig = JSON.stringify(config);
      const version = createPublishedPromptVersion({ outputSchemaVersion });
      const templateName = "Published workflow prompt";

      const updated = withPublishedWorkflowPrompt(config, {
        workflowKind,
        templateName,
        version,
      });

      expect(updated).not.toBe(config);
      expect(updated[selectedKey]).not.toBe(config[selectedKey]);
      expect(updated[selectedKey]).toEqual({
        ...config[selectedKey],
        name: templateName,
        version: version.id,
        text: version.content,
      });
      expect(updated[selectedKey].policy).toBe(config[selectedKey].policy);
      expect(updated[selectedKey].outputSchema).toBe(config[selectedKey].outputSchema);
      expect(updated[unchangedKey]).toBe(config[unchangedKey]);
      expect(JSON.stringify(config)).toBe(originalConfig);
      expectDeeplyFrozen(updated);
      expect(isLoadedTrustedSchedulingConfig(updated)).toBe(true);
    },
  );

  it("allows both published prompts to be applied without losing the first override", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);
    const issueVersion = createPublishedPromptVersion();
    const pullRequestVersion = createPublishedPromptVersion({
      id: "prompt-version-pr-29",
      templateId: "prompt-template-pr",
      version: 29,
      content: "Published pull request prompt.\n",
      outputSchemaVersion: "PrReviewPlanV2",
    });
    const issueConfig = withPublishedWorkflowPrompt(config, {
      workflowKind: "issue_triage",
      templateName: "Published issue triage",
      version: issueVersion,
    });

    const updated = withPublishedWorkflowPrompt(issueConfig, {
      workflowKind: "pr_static_build",
      templateName: "Published pull request review",
      version: pullRequestVersion,
    });

    expect(updated.issueTriage).toBe(issueConfig.issueTriage);
    expect(updated.issueTriage.version).toBe(issueVersion.id);
    expect(updated.pullRequestReview).toEqual({
      ...config.pullRequestReview,
      name: "Published pull request review",
      version: pullRequestVersion.id,
      text: pullRequestVersion.content,
    });
    expect(issueConfig.pullRequestReview).toBe(config.pullRequestReview);
    expect(config.issueTriage.text).toBe(fixture.issuePrompt);
    expect(config.pullRequestReview.text).toBe(fixture.pullRequestPrompt);
    expectDeeplyFrozen(updated);
    expect(isLoadedTrustedSchedulingConfig(updated)).toBe(true);
  });

  it("rejects a frozen copy that was not loaded as trusted configuration", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);
    const untrustedConfig = Object.freeze({ ...config });

    expect(isLoadedTrustedSchedulingConfig(untrustedConfig)).toBe(false);
    expect(() =>
      withPublishedWorkflowPrompt(untrustedConfig, {
        workflowKind: "issue_triage",
        templateName: "Published issue triage",
        version: createPublishedPromptVersion(),
      }),
    ).toThrow(/loaded trusted defaults/u);
  });

  it("rejects the UI workflow even when its prompt matches the pull request schema", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);
    const input = {
      workflowKind: "pr_ui",
      templateName: "Published UI review",
      version: createPublishedPromptVersion({ outputSchemaVersion: "PrReviewPlanV2" }),
    } as unknown as Parameters<typeof withPublishedWorkflowPrompt>[1];

    expect(() => withPublishedWorkflowPrompt(config, input)).toThrow(/invalid or incompatible/u);
  });

  it.each([
    { workflowKind: "issue_triage", outputSchemaVersion: "PrReviewPlanV2" },
    { workflowKind: "pr_static_build", outputSchemaVersion: "IssueTriageV2" },
  ] as const)(
    "rejects $outputSchemaVersion for the $workflowKind workflow",
    async ({ workflowKind, outputSchemaVersion }) => {
      const fixture = await createPromptFixture();
      const config = await loadFixture(fixture.promptDirectory);

      expect(() =>
        withPublishedWorkflowPrompt(config, {
          workflowKind,
          templateName: "Published workflow prompt",
          version: createPublishedPromptVersion({ outputSchemaVersion }),
        }),
      ).toThrow(/invalid or incompatible/u);
    },
  );

  it("rejects content that no longer matches the published digest", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);
    const version = createPublishedPromptVersion();
    version.content = "Changed after publication.\n";

    expect(() =>
      withPublishedWorkflowPrompt(config, {
        workflowKind: "issue_triage",
        templateName: "Published issue triage",
        version,
      }),
    ).toThrow(/invalid or incompatible/u);
  });

  it.each([
    { name: "empty", content: "" },
    { name: "whitespace-only", content: " \r\n\t " },
    { name: "NUL-containing", content: "Published\0prompt" },
  ])("rejects $name content even with a matching digest", async ({ content }) => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);

    expect(() =>
      withPublishedWorkflowPrompt(config, {
        workflowKind: "issue_triage",
        templateName: "Published issue triage",
        version: createPublishedPromptVersion({ content }),
      }),
    ).toThrow(/invalid or incompatible/u);
  });

  it("enforces the inclusive UTF-8 byte limit independently of the character count", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);
    const content = "\u00e9".repeat(maximumPromptContentUtf8Bytes / 2);
    const overLimitContent = `${content}x`;
    const input = {
      workflowKind: "issue_triage",
      templateName: "Published issue triage",
      version: createPublishedPromptVersion({ content }),
    } as const;

    expect(withPublishedWorkflowPrompt(config, input).issueTriage.text).toBe(content);
    expect(overLimitContent.length).toBeLessThan(maximumPromptContentUtf8Bytes);
    expect(() =>
      withPublishedWorkflowPrompt(config, {
        ...input,
        version: createPublishedPromptVersion({ content: overLimitContent }),
      }),
    ).toThrow(/invalid or incompatible/u);
  });
});

const schemas = {
  issueTriage: IssueTriageV2ModelOutputSchema,
  pullRequestReview: PrReviewPlanV2ModelOutputSchema,
};

function createPublishedPromptVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  const content = overrides.content ?? "Published workflow prompt.\r\nPreserve these bytes.\r\n";
  return {
    id: "prompt-version-17",
    templateId: "prompt-template-issue",
    version: 17,
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    outputSchemaVersion: "IssueTriageV2",
    createdAt: "2026-09-07T00:00:00.000Z",
    publishedAt: "2026-09-07T00:00:00.000Z",
    createdBy: "https://identity.example.test/operator-1",
    ...overrides,
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}

function createPolicy(): TrustedSchedulingPolicy {
  return {
    issueTriage: {
      priority: 75,
      intentVersion: 3,
      maxAttempts: 2,
      requiredCapabilities: {
        operatingSystem: "windows",
        headless: true,
        labels: { execution: "enabled", processHost: "available" },
      },
      executionPolicy: {
        hardTimeoutMs: 300_000,
        noProgressTimeoutMs: 60_000,
        allowedRecipeIds: [],
        requiredCapabilityLabels: {
          execution: "enabled",
          processHost: "available",
        },
      },
    },
    pullRequestReview: {
      priority: 100,
      intentVersion: 7,
      maxAttempts: 3,
      requiredCapabilities: {
        recipeIds: "static-pull-request-review",
        labels: { execution: "enabled", pool: "review" },
      },
      executionPolicy: {
        hardTimeoutMs: 600_000,
        noProgressTimeoutMs: 90_000,
        allowedRecipeIds: ["static-pull-request-review"],
        requiredCapabilityLabels: {
          execution: "enabled",
          pool: "review",
        },
      },
    },
  };
}

async function createPromptFixture(): Promise<{
  readonly root: string;
  readonly promptDirectory: string;
  readonly issuePrompt: string;
  readonly pullRequestPrompt: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentic-review-scheduling-"));
  temporaryDirectories.push(root);
  const promptDirectory = join(root, "prompts");
  await mkdir(promptDirectory);
  const issuePrompt = "Trusted issue prompt.\r\nPreserve these bytes.\r\n";
  const pullRequestPrompt = "Trusted pull request prompt.\n";
  await Promise.all([
    writeFile(join(promptDirectory, "issue-triage-v2.md"), issuePrompt, "utf8"),
    writeFile(join(promptDirectory, "pull-request-review-v2.md"), pullRequestPrompt, "utf8"),
  ]);
  return { root, promptDirectory, issuePrompt, pullRequestPrompt };
}

async function loadFixture(promptDirectory: string) {
  return loadTrustedSchedulingConfig({
    promptDirectory,
    policy: createPolicy(),
    outputSchemas: schemas,
  });
}
