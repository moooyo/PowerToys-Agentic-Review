import {
  maximumPromptContentUtf8Bytes,
  type PromptBinding,
  type PromptPreviewResponse,
  type PromptTemplate,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import {
  assertPromptPreviewScope,
  bindingExpectedVersion,
  buildPromptCreate,
  buildPromptDraftSave,
  buildPromptPreview,
  buildPromptPublish,
  type CreatePromptValues,
  configurationErrorMessage,
  isPromptConflict,
  validatePromptContent,
} from "./forms";

const workflowCases = [
  { workflowKind: "pr_static_build", outputSchemaVersion: "PrReviewPlanV2" },
  { workflowKind: "pr_ui", outputSchemaVersion: "ValidationSummaryV1" },
  { workflowKind: "issue_triage", outputSchemaVersion: "IssueTriageV2" },
  { workflowKind: "issue_validation", outputSchemaVersion: "ValidationSummaryV1" },
] as const;

const originalContent = " \r\nReview {{work_item.title}}.\t\u00e9 e\u0301 \u{1F680}\r\n ";

const createValues = (overrides: Partial<CreatePromptValues> = {}): CreatePromptValues => ({
  name: "Review prompt",
  description: "Prompt instructions",
  workflowKind: "pr_static_build",
  content: originalContent,
  ...overrides,
});

const promptTemplate = (overrides: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: "template-1",
  name: "Review prompt",
  description: "Prompt instructions",
  workflowKind: "pr_static_build",
  version: 37,
  draftRevision: 4,
  draftContent: originalContent,
  draftOutputSchemaVersion: "PrReviewPlanV2",
  latestPublishedVersionId: "published-1",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T01:00:00.000Z",
  ...overrides,
});

const previewResponse = (
  overrides: Partial<PromptPreviewResponse> = {},
): PromptPreviewResponse => ({
  renderedContent: "Review the selected work item.",
  contentSha256: "a".repeat(64),
  workItemId: null,
  repositoryId: null,
  ...overrides,
});

const promptBinding = (overrides: Partial<PromptBinding> = {}): PromptBinding => ({
  repositoryId: "repository-1",
  workflowKind: "pr_static_build",
  promptVersionId: "published-1",
  version: 19,
  ...overrides,
});

describe("prompt creation", () => {
  it.each(workflowCases)(
    "derives $outputSchemaVersion from $workflowKind and preserves the original content",
    ({ workflowKind, outputSchemaVersion }) => {
      expect(
        buildPromptCreate(
          createValues({
            name: " \tReview prompt\r\n ",
            description: " \r\nPrompt instructions\t ",
            workflowKind,
          }),
        ),
      ).toEqual({
        name: "Review prompt",
        description: " \r\nPrompt instructions\t ",
        workflowKind,
        content: originalContent,
        outputSchemaVersion,
      });
    },
  );

  it.each(["a", "a".repeat(128)])("accepts a trimmed name at the valid boundaries", (name) => {
    expect(buildPromptCreate(createValues({ name: ` \t${name}\r\n ` })).name).toBe(name);
  });

  it.each([
    "",
    " \r\n\t ",
    "a".repeat(129),
    "prompt\u0000name",
    "prompt\u0001name",
    "prompt\tname",
    "prompt\nname",
    "prompt\u001Fname",
    "prompt\u007Fname",
  ])("rejects empty, overlong, or control-character names: %j", (name) => {
    expect(() => buildPromptCreate(createValues({ name }))).toThrow("Template name");
  });

  it.each(["", " \r\n\t ", "a".repeat(2_048)])(
    "preserves descriptions through the 2,048-character limit",
    (description) => {
      expect(buildPromptCreate(createValues({ description })).description).toBe(description);
    },
  );

  it.each(["a".repeat(2_049), "description\u0000text"])(
    "rejects descriptions exceeding the limit or containing null characters",
    (description) => {
      expect(() => buildPromptCreate(createValues({ description }))).toThrow("Description");
    },
  );
});

describe("prompt content validation", () => {
  it("preserves a valid leading Unicode byte order mark", () => {
    const content = "\uFEFFReview the current revision.\n";
    expect(() => validatePromptContent(content)).not.toThrow();
    expect(buildPromptPreview(content, "", "pr_static_build").content).toBe(content);
  });

  it.each(["", " \r\n\t ", "\u00a0\u2003"])("rejects blank content %j", (content) => {
    expect(() => validatePromptContent(content)).toThrow("Enter prompt content");
  });

  it("rejects null characters in otherwise valid content", () => {
    expect(() => validatePromptContent("Review\u0000instructions")).toThrow("null characters");
  });

  it.each(["\uD800", "\uDC00", "Review \uD800 content", "\uDC00\uD800"])(
    "rejects unpaired Unicode surrogates %j",
    (content) => {
      expect(() => validatePromptContent(content)).toThrow("valid Unicode");
    },
  );

  it("accepts valid Unicode without changing normalization or whitespace", () => {
    expect(() => validatePromptContent(originalContent)).not.toThrow();
    expect(buildPromptCreate(createValues()).content).toBe(originalContent);
    expect(buildPromptDraftSave(promptTemplate(), originalContent).content).toBe(originalContent);
    expect(buildPromptPreview(originalContent, "", "pr_static_build").content).toBe(
      originalContent,
    );
  });

  it.each([
    { label: "ASCII", content: "a".repeat(maximumPromptContentUtf8Bytes) },
    { label: "two-byte Unicode", content: "\u00e9".repeat(maximumPromptContentUtf8Bytes / 2) },
    {
      label: "four-byte Unicode",
      content: "\u{1F680}".repeat(maximumPromptContentUtf8Bytes / 4),
    },
  ])("uses the UTF-8 byte limit for $label content", ({ content }) => {
    expect(() => validatePromptContent(content)).not.toThrow();
    expect(() => validatePromptContent(`${content}a`)).toThrow("UTF-8 bytes");
  });

  it.each([
    { label: "create", build: (content: string) => buildPromptCreate(createValues({ content })) },
    {
      label: "draft save",
      build: (content: string) => buildPromptDraftSave(promptTemplate(), content),
    },
    {
      label: "publish",
      build: (content: string) =>
        buildPromptPublish(promptTemplate({ draftContent: content }), content),
    },
    {
      label: "preview",
      build: (content: string) => buildPromptPreview(content, "work-item-1", "pr_static_build"),
    },
  ])("validates content before building a $label request", ({ build }) => {
    for (const content of [
      " \n ",
      "text\u0000text",
      "\uD800",
      "a".repeat(maximumPromptContentUtf8Bytes + 1),
    ]) {
      expect(() => build(content)).toThrow();
    }
  });
});

describe("prompt draft mutations", () => {
  it.each(workflowCases)(
    "saves $workflowKind with the template CAS version and derived schema",
    ({ workflowKind, outputSchemaVersion }) => {
      const template = promptTemplate({
        workflowKind,
        draftOutputSchemaVersion: outputSchemaVersion,
      });

      expect(buildPromptDraftSave(template, originalContent)).toEqual({
        expectedVersion: 37,
        content: originalContent,
        outputSchemaVersion,
      });
    },
  );

  it("publishes an unchanged saved draft using the template version instead of the draft revision", () => {
    expect(buildPromptPublish(promptTemplate(), originalContent)).toEqual({ expectedVersion: 37 });
  });

  it.each([
    `${originalContent}New instruction`,
    originalContent.trim(),
    originalContent.replaceAll("\r\n", "\n"),
    originalContent.normalize("NFC"),
  ])("requires a save before publishing any change to the draft", (content) => {
    expect(() => buildPromptPublish(promptTemplate(), content)).toThrow(
      "Save the current draft before publishing.",
    );
  });
});

describe("prompt preview requests", () => {
  it.each(workflowCases)(
    "includes the selected $workflowKind workflow in preview requests",
    ({ workflowKind }) => {
      expect(buildPromptPreview(originalContent, "work-item-1", workflowKind)).toEqual({
        content: originalContent,
        workItemId: "work-item-1",
        workflowKind,
      });
    },
  );

  it.each(["", " \r\n\t "])(
    "omits the optional work item ID entirely when no ID is entered",
    (workItemId) => {
      const request = buildPromptPreview(originalContent, workItemId, "pr_static_build");

      expect(request).toEqual({ content: originalContent, workflowKind: "pr_static_build" });
      expect(request).not.toHaveProperty("workItemId");
    },
  );

  it.each(["A", "9", "WorkItem:42._-review", "a".repeat(128)])(
    "accepts an exact work item ID and trims only its surrounding whitespace: %j",
    (workItemId) => {
      expect(
        buildPromptPreview(originalContent, ` \t${workItemId}\r\n `, "pr_static_build"),
      ).toEqual({
        content: originalContent,
        workItemId,
        workflowKind: "pr_static_build",
      });
    },
  );

  it.each([
    "a".repeat(129),
    "-work-item",
    ".work-item",
    "_work-item",
    ":work-item",
    "owner/repository#42",
    "https://github.com/owner/repository/issues/42",
    "work item",
    "work\nitem",
    "work\titem",
    "work\u0000item",
    "work\u007Fitem",
    "work-\u00e9",
    "work-item?state=open",
  ])("rejects input that is not a complete exact work item ID: %j", (workItemId) => {
    expect(() => buildPromptPreview(originalContent, workItemId, "pr_static_build")).toThrow(
      "exact work item ID",
    );
  });
});

describe("prompt preview scope", () => {
  it.each([null, "repository-1"])(
    "accepts a context-free response when the selected repository is %j",
    (repositoryId) => {
      expect(() =>
        assertPromptPreviewScope(previewResponse(), { content: originalContent }, repositoryId),
      ).not.toThrow();
    },
  );

  it("accepts the exact work item in the selected repository", () => {
    expect(() =>
      assertPromptPreviewScope(
        previewResponse({ workItemId: "work-item-1", repositoryId: "repository-1" }),
        { content: originalContent, workItemId: "work-item-1" },
        "repository-1",
      ),
    ).not.toThrow();
  });

  it("accepts a matching work item from any repository in the global scope", () => {
    expect(() =>
      assertPromptPreviewScope(
        previewResponse({ workItemId: "work-item-1", repositoryId: "repository-2" }),
        { content: originalContent, workItemId: "work-item-1" },
        null,
      ),
    ).not.toThrow();
  });

  it.each([null, "work-item-2", "Work-Item-1"])(
    "rejects a missing, different, or differently cased returned work item: %j",
    (workItemId) => {
      expect(() =>
        assertPromptPreviewScope(
          previewResponse({ workItemId, repositoryId: "repository-1" }),
          { content: originalContent, workItemId: "work-item-1" },
          "repository-1",
        ),
      ).toThrow("different work item");
    },
  );

  it("rejects an unsolicited work item for a context-free request", () => {
    expect(() =>
      assertPromptPreviewScope(
        previewResponse({ workItemId: "work-item-1" }),
        { content: originalContent },
        null,
      ),
    ).toThrow("different work item");
  });

  it.each([null, "repository-2"])(
    "rejects a work item whose returned repository does not match the selected repository: %j",
    (repositoryId) => {
      expect(() =>
        assertPromptPreviewScope(
          previewResponse({ workItemId: "work-item-1", repositoryId }),
          { content: originalContent, workItemId: "work-item-1" },
          "repository-1",
        ),
      ).toThrow("does not belong to the selected repository");
    },
  );

  it.each([null, "repository-1"])(
    "rejects unsolicited repository context when the selected repository is %j",
    (repositoryId) => {
      expect(() =>
        assertPromptPreviewScope(
          previewResponse({ repositoryId: "repository-1" }),
          { content: originalContent },
          repositoryId,
        ),
      ).toThrow("unexpected repository context");
    },
  );
});

describe("prompt binding versions", () => {
  it.each([null, "repository-1"])(
    "uses version zero when no binding exists in repository scope %j",
    (repositoryId) => {
      for (const { workflowKind } of workflowCases) {
        expect(bindingExpectedVersion(undefined, repositoryId, workflowKind)).toBe(0);
      }
    },
  );

  it.each([null, "repository-1"])(
    "uses the current binding version only for its exact repository scope %j and workflow",
    (repositoryId) => {
      for (const { workflowKind } of workflowCases) {
        const binding = promptBinding({ repositoryId, workflowKind });

        expect(bindingExpectedVersion(binding, repositoryId, workflowKind)).toBe(19);
      }
    },
  );

  it.each([
    { bindingRepositoryId: null, selectedRepositoryId: "repository-1" },
    { bindingRepositoryId: "repository-1", selectedRepositoryId: null },
    { bindingRepositoryId: "repository-2", selectedRepositoryId: "repository-1" },
  ])(
    "rejects a binding inherited from a different scope: %j",
    ({ bindingRepositoryId, selectedRepositoryId }) => {
      expect(() =>
        bindingExpectedVersion(
          promptBinding({ repositoryId: bindingRepositoryId }),
          selectedRepositoryId,
          "pr_static_build",
        ),
      ).toThrow("does not match the current scope");
    },
  );

  it.each([null, "repository-1"])(
    "rejects another workflow's binding even when the repository scope %j matches",
    (repositoryId) => {
      expect(() =>
        bindingExpectedVersion(
          promptBinding({ repositoryId, workflowKind: "pr_ui" }),
          repositoryId,
          "issue_validation",
        ),
      ).toThrow("does not match the current scope");
    },
  );
});

describe("prompt configuration errors", () => {
  it("recognizes HTTP 409 conflicts from the control plane", () => {
    const error = new ReviewControlHttpError("The prompt changed.", {
      operation: "savePromptDraft",
      retryable: false,
      status: 409,
    });

    expect(isPromptConflict(error)).toBe(true);
    expect(isPromptConflict({ status: 409 })).toBe(true);
    expect(configurationErrorMessage(error)).toBe("The prompt changed.");
  });

  it.each([
    null,
    undefined,
    409,
    "409",
    {},
    { status: "409" },
    { status: 400 },
    { status: 500 },
    new Error("409"),
  ])("does not classify unrelated failures as prompt conflicts: %j", (error) => {
    expect(isPromptConflict(error)).toBe(false);
  });

  it.each([null, undefined, "Request failed", { message: "Request failed" }])(
    "uses a readable fallback for failures that are not Error instances: %j",
    (error) => {
      expect(configurationErrorMessage(error)).toBe(
        "The request could not be completed. Try again.",
      );
    },
  );
});
