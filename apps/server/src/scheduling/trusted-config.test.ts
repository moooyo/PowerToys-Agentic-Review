import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
  PrReviewPlanV1ModelOutputSchema,
} from "../../../../packages/codex/src/review-results.js";
import { defaultTrustedSchedulingPolicy } from "../../dist/scheduling/default-policy.js";
import {
  loadTrustedSchedulingConfig,
  type TrustedSchedulingPolicy,
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
  });

  it("loads only the fixed versioned prompts from an absolute trusted directory", async () => {
    const fixture = await createPromptFixture();
    const config = await loadFixture(fixture.promptDirectory);

    expect(config.issueTriage).toMatchObject({
      name: "issue-triage",
      version: "1",
      text: fixture.issuePrompt,
      outputSchema: { type: "object" },
      policy: createPolicy().issueTriage,
    });
    expect(config.pullRequestReview).toMatchObject({
      name: "pull-request-review",
      version: "1",
      text: fixture.pullRequestPrompt,
      outputSchema: { type: "object" },
      policy: createPolicy().pullRequestReview,
    });
    expect(config.issueTriage.outputSchema).toEqual(
      JSON.parse(JSON.stringify(IssueTriageV1ModelOutputSchema)),
    );
    expect(config.pullRequestReview.outputSchema).toEqual(
      JSON.parse(JSON.stringify(PrReviewPlanV1ModelOutputSchema)),
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
      const issuePromptPath = join(fixture.promptDirectory, "issue-triage-v1.md");
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
    await rm(join(missingFixture.promptDirectory, "issue-triage-v1.md"));
    await expect(loadFixture(missingFixture.promptDirectory)).rejects.toThrow(/inspect/u);

    const emptyFixture = await createPromptFixture();
    await writeFile(join(emptyFixture.promptDirectory, "issue-triage-v1.md"), "", "utf8");
    await expect(loadFixture(emptyFixture.promptDirectory)).rejects.toThrow(/between 1/u);
  });

  it("rejects non-authoritative or crossed output schemas", async () => {
    const fixture = await createPromptFixture();
    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: PrReviewPlanV1ModelOutputSchema,
          pullRequestReview: IssueTriageV1ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV1/u);

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: IssueTriageV1Schema,
          pullRequestReview: PrReviewPlanV1ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV1/u);

    await expect(
      loadTrustedSchedulingConfig({
        promptDirectory: fixture.promptDirectory,
        policy: createPolicy(),
        outputSchemas: {
          issueTriage: Type.Unknown({ $id: "IssueTriageV1" }),
          pullRequestReview: PrReviewPlanV1ModelOutputSchema,
        },
      }),
    ).rejects.toThrow(/authoritative IssueTriageV1/u);
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

const schemas = {
  issueTriage: IssueTriageV1ModelOutputSchema,
  pullRequestReview: PrReviewPlanV1ModelOutputSchema,
};

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
    writeFile(join(promptDirectory, "issue-triage-v1.md"), issuePrompt, "utf8"),
    writeFile(join(promptDirectory, "pull-request-review-v1.md"), pullRequestPrompt, "utf8"),
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
