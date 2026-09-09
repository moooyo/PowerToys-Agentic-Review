import { createHash } from "node:crypto";
import {
  maximumPromptContentUtf8Bytes,
  maximumRenderedPromptUtf8Bytes,
  type PromptPreviewRequest,
  type PromptPreviewResponse,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { RepositoryOperationMap } from "../database/managed-repositories.js";
import type { OperatorRequestInput } from "../database/operator-request.js";
import { createPullRequestRevisionKey } from "../github/revision-key.js";
import { ConfigurationHttpError } from "../routes/configuration-support.js";
import { createOperatorRouteTestDatabase } from "../routes/operator-database.testing.js";
import { createPromptPreview } from "./prompt-preview.js";

type WorkItemContext = NonNullable<RepositoryOperationMap["getPromptWorkItemContext"]["output"]>;

const timestamp = "2026-09-07T00:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "preview-operator" };
const workItemId = "work-item-1";
const content = "Review the available evidence and explain reproducible findings.";
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const issueContext: WorkItemContext = {
  repositoryId: "repository-1",
  repository: {
    githubRepositoryId: 1,
    githubNodeId: "R_1",
    ownerLogin: "example",
    name: "project",
    fullName: "example/project",
    htmlUrl: "https://github.com/example/project",
    defaultBranch: "main",
    isPrivate: false,
  },
  workItem: {
    kind: "issue",
    githubWorkItemId: 101,
    githubNodeId: "I_101",
    githubRepositoryId: 1,
    number: 42,
    title: "Verify the preview execution context",
    body: "The report contains a reproducible sequence of steps.",
    state: "open",
    author: { githubUserId: 200, login: "contributor", accountType: "user" },
    htmlUrl: "https://github.com/example/project/issues/42",
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
  },
  revision: {
    kind: "issue",
    githubRepositoryId: 1,
    githubWorkItemId: 101,
    revisionKey: "c".repeat(64),
    contentDigest: "c".repeat(64),
    observedAt: timestamp,
    sourceUpdatedAt: timestamp,
  },
};
const pullRequestContext: WorkItemContext = {
  ...issueContext,
  workItem: {
    ...issueContext.workItem,
    kind: "pull_request",
    isDraft: false,
    htmlUrl: "https://github.com/example/project/pull/42",
  },
  revision: {
    kind: "pull_request",
    githubRepositoryId: 1,
    githubWorkItemId: 101,
    revisionKey: createPullRequestRevisionKey(baseSha, headSha),
    baseSha,
    headSha,
    observedAt: timestamp,
    sourceUpdatedAt: timestamp,
  },
};

const createDatabase = (context: unknown = issueContext) => {
  return createOperatorRouteTestDatabase(actor, async (operation: string, input: unknown) => {
    if (operation !== "getPromptWorkItemContext") {
      throw new Error(`Unexpected preview database operation: ${operation}`);
    }
    expect(input).toEqual({ workItemId });
    return context;
  });
};

function previewFor(database: Pick<DatabaseClient, "request">) {
  return (input: PromptPreviewRequest) => createPromptPreview(database)(input, actor);
}

const readRenderedContext = (response: PromptPreviewResponse): Record<string, unknown> => {
  const prefix = "UNTRUSTED_GITHUB_EXECUTION_CONTEXT_JSON=";
  const line = response.renderedContent.split("\n").find((entry) => entry.startsWith(prefix));
  expect(line).toBeDefined();
  if (line === undefined) throw new Error("The rendered prompt has no execution context.");
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
};

describe("createPromptPreview", () => {
  it("binds both work-item lookup and the final permission check to this invocation's actor", async () => {
    const request = vi.fn(async (operation: string, input: unknown) => {
      expect(operation).toBe("operatorRequest");
      const frame = input as OperatorRequestInput;
      return frame.operation === "operatorCheckPermission" ? { authorized: true } : issueContext;
    });
    const preview = createPromptPreview({ request } as unknown as Pick<DatabaseClient, "request">);
    const secondActor = { ...actor, subject: "another-preview-operator" };
    await preview({ content, workItemId }, actor);
    await preview({ content, workItemId }, secondActor);
    expect(request.mock.calls.map(([, input]) => (input as OperatorRequestInput).context)).toEqual([
      { kind: "operator", actor },
      { kind: "operator", actor },
      { kind: "operator", actor: secondActor },
      { kind: "operator", actor: secondActor },
    ]);
    expect(
      request.mock.calls.map(([, input]) => (input as OperatorRequestInput).operation),
    ).toEqual([
      "getPromptWorkItemContext",
      "operatorCheckPermission",
      "getPromptWorkItemContext",
      "operatorCheckPermission",
    ]);
  });

  it("does not return private preview context when repository access is revoked after its lookup", async () => {
    const { database, permissions, transport } = createDatabase();
    permissions.mockRejectedValue(
      new DatabaseRequestError("The repository was not found.", "PLATFORM_NOT_FOUND"),
    );
    const failure = await previewFor(database)({ content, workItemId }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    expect(String(failure)).not.toContain(issueContext.workItem.body);
    expect(transport).toHaveBeenLastCalledWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "operatorCheckPermission",
      input: { repositoryId: issueContext.repositoryId, permission: "read" },
    });
  });

  it("returns a raw preview with null context and no database lookup when no work item is selected", async () => {
    const { database, request } = createDatabase();
    const rawContent = "Review evidence.\nPreserve Unicode: \u4e2d\u6587 \ud83d\ude00\n";

    const result = await previewFor(database)({
      content: rawContent,
      workflowKind: "pr_static_build",
    });

    expect(result).toEqual({
      renderedContent: rawContent,
      contentSha256: hash(rawContent),
      workItemId: null,
      repositoryId: null,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("hashes the actual rendered issue prompt rather than the unrendered template", async () => {
    const { database, request } = createDatabase();

    const result = await previewFor(database)({ content, workItemId });

    expect(request).toHaveBeenCalledExactlyOnceWith("getPromptWorkItemContext", { workItemId });
    expect(result).toMatchObject({ workItemId, repositoryId: issueContext.repositoryId });
    expect(result.renderedContent).toContain(`${content}\n\n## Trusted Execution Context\n`);
    expect(result.renderedContent).toContain("JOB_KIND=issue_triage\n");
    expect(result.contentSha256).toBe(hash(result.renderedContent));
    expect(result.contentSha256).not.toBe(hash(content));
    expect(readRenderedContext(result)).toMatchObject({
      repository: { githubRepositoryId: 1, fullName: "example/project" },
      workItem: {
        kind: "issue",
        githubWorkItemId: 101,
        number: 42,
        title: issueContext.workItem.title,
        body: issueContext.workItem.body,
      },
      revision: { kind: "issue", revisionKey: "c".repeat(64), contentDigest: "c".repeat(64) },
    });
  });

  it.each([
    {
      context: pullRequestContext,
      workflowKind: "pr_static_build",
      jobKind: "pull_request_review",
    },
    { context: pullRequestContext, workflowKind: "pr_ui", jobKind: "pr_ui" },
    { context: issueContext, workflowKind: "issue_triage", jobKind: "issue_triage" },
    { context: issueContext, workflowKind: "issue_validation", jobKind: "issue_validation" },
  ] as const)("renders the $workflowKind workflow for its work item kind", async (scenario) => {
    const { database } = createDatabase(scenario.context);

    const result = await previewFor(database)({
      content,
      workItemId,
      workflowKind: scenario.workflowKind,
    });

    expect(result.renderedContent).toContain(`JOB_KIND=${scenario.jobKind}\n`);
    expect(result.contentSha256).toBe(hash(result.renderedContent));
    expect(result.repositoryId).toBe(scenario.context.repositoryId);
    if (scenario.context.workItem.kind === "pull_request") {
      expect(readRenderedContext(result)).toMatchObject({
        revision: { kind: "pull_request", baseSha, headSha },
      });
    }
  });

  it("changes the rendered digest when the selected work item's current revision changes", async () => {
    const { database, request } = createDatabase(pullRequestContext);
    const preview = previewFor(database);
    const first = await preview({ content, workItemId });
    const newHead = "d".repeat(40);
    request.mockResolvedValueOnce({
      ...pullRequestContext,
      revision: {
        ...pullRequestContext.revision,
        headSha: newHead,
        revisionKey: createPullRequestRevisionKey(baseSha, newHead),
      },
    });

    const second = await preview({ content, workItemId });

    expect(second.contentSha256).not.toBe(first.contentSha256);
    expect(second.contentSha256).toBe(hash(second.renderedContent));
    expect(readRenderedContext(second)).toMatchObject({ revision: { baseSha, headSha: newHead } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns a scoped 404 when the selected work item has no available current revision", async () => {
    const { database, request } = createDatabase(null);

    await expect(previewFor(database)({ content, workItemId })).rejects.toMatchObject({
      name: "ConfigurationHttpError",
      statusCode: 404,
      code: "prompt_work_item_not_found",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("getPromptWorkItemContext", { workItemId });
  });

  it.each([
    { context: issueContext, workflowKind: "pr_static_build" },
    { context: issueContext, workflowKind: "pr_ui" },
    { context: pullRequestContext, workflowKind: "issue_triage" },
    { context: pullRequestContext, workflowKind: "issue_validation" },
  ] as const)(
    "rejects $workflowKind when the selected work item kind is incompatible",
    async (scenario) => {
      const { database } = createDatabase(scenario.context);

      await expect(
        previewFor(database)({
          content,
          workItemId,
          workflowKind: scenario.workflowKind,
        }),
      ).rejects.toMatchObject({ statusCode: 422, code: "prompt_context_invalid" });
    },
  );

  it.each([
    {
      name: "work item repository",
      context: {
        ...issueContext,
        workItem: { ...issueContext.workItem, githubRepositoryId: 2 },
      },
    },
    {
      name: "revision repository",
      context: {
        ...issueContext,
        revision: { ...issueContext.revision, githubRepositoryId: 2 },
      },
    },
    {
      name: "revision work item",
      context: {
        ...issueContext,
        revision: { ...issueContext.revision, githubWorkItemId: 102 },
      },
    },
    { name: "revision kind", context: { ...issueContext, revision: pullRequestContext.revision } },
    { name: "invalid snapshot shape", context: { ...issueContext, workItem: {} } },
  ])("rejects inconsistent $name without exposing the stored context", async ({ context }) => {
    const { database } = createDatabase(context);
    const error = await previewFor(database)({ content, workItemId }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ConfigurationHttpError);
    expect(error).toMatchObject({ statusCode: 422, code: "prompt_context_invalid" });
    expect(String(error)).not.toContain(issueContext.workItem.body);
  });

  it("enforces the template budget in UTF-8 bytes before reading a selected work item", async () => {
    const { database, request } = createDatabase();
    const oversized = "\ud83d\ude00".repeat(maximumPromptContentUtf8Bytes / 4 + 1);
    expect(oversized.length).toBeLessThan(maximumPromptContentUtf8Bytes);

    await expect(previewFor(database)({ content: oversized, workItemId })).rejects.toMatchObject({
      statusCode: 400,
      code: "prompt_content_too_large",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts a template at the exact UTF-8 budget without a work item", async () => {
    const { database, request } = createDatabase();
    const exactBudget = "\ud83d\ude00".repeat(maximumPromptContentUtf8Bytes / 4);

    const result = await previewFor(database)({ content: exactBudget });

    expect(result.renderedContent).toBe(exactBudget);
    expect(result.contentSha256).toBe(hash(exactBudget));
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds the rendered UTF-8 payload and hashes the final body truncation evidence", async () => {
    const originalBody = "\ud83d\ude00".repeat(200_000);
    const { database } = createDatabase({
      ...issueContext,
      workItem: { ...issueContext.workItem, body: originalBody },
    });
    const result = await previewFor(database)({
      content: "p".repeat(maximumPromptContentUtf8Bytes),
      workItemId,
    });

    expect(Buffer.byteLength(result.renderedContent, "utf8")).toBeLessThanOrEqual(
      maximumRenderedPromptUtf8Bytes,
    );
    expect(result.renderedContent.isWellFormed()).toBe(true);
    expect(result.contentSha256).toBe(hash(result.renderedContent));
    expect(result.renderedContent).toContain("UNTRUSTED_BODY_TRUNCATED");
    expect(result.renderedContent).toContain(
      `originalUtf8Bytes=${Buffer.byteLength(originalBody, "utf8")}`,
    );
    expect(result.renderedContent).toContain(`sha256=${hash(originalBody)}`);
    const parsed = readRenderedContext(result) as { workItem: { body: string } };
    expect(parsed.workItem.body.isWellFormed()).toBe(true);
    expect(parsed.workItem.body.length).toBeLessThan(originalBody.length);
  });

  it("preserves database failures instead of misreporting them as a missing work item", async () => {
    const { database, request } = createDatabase();
    const unavailable = new Error("Database transport unavailable.");
    request.mockRejectedValueOnce(unavailable);

    await expect(previewFor(database)({ content, workItemId })).rejects.toBe(unavailable);
  });
});
