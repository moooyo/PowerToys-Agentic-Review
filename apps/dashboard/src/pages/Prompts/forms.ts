import {
  maximumPromptContentUtf8Bytes,
  type PromptBinding,
  type PromptDraftPublishRequest,
  type PromptDraftSaveRequest,
  type PromptPreviewRequest,
  type PromptPreviewResponse,
  type PromptTemplate,
  type PromptTemplateCreateRequest,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";

export const workflowLabels: Record<WorkflowKind, string> = {
  pr_static_build: "Pull request review",
  pr_ui: "Pull request UI validation",
  issue_triage: "Issue triage",
  issue_validation: "Issue validation",
};

export const workflowOptions = Object.entries(workflowLabels).map(([value, label]) => ({
  value,
  label,
}));

export function configurationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

export function isPromptConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}

export function validatePromptContent(content: string): void {
  if (!content.trim()) throw new Error("Enter prompt content before continuing.");
  if (content.includes("\u0000")) throw new Error("Prompt content cannot contain null characters.");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > maximumPromptContentUtf8Bytes) {
    throw new Error(
      `Prompt content must be no larger than ${maximumPromptContentUtf8Bytes.toLocaleString("en-US")} UTF-8 bytes.`,
    );
  }
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== content) {
    throw new Error("Prompt content must contain valid Unicode.");
  }
}

export interface CreatePromptValues {
  name: string;
  description: string;
  workflowKind: WorkflowKind;
  content: string;
}

export function validatePromptName(value: string): void {
  const name = value.trim();
  const hasControlCharacters = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!name || name.length > 128 || hasControlCharacters) {
    throw new Error("Template name must contain 1–128 characters without control characters.");
  }
}

export function buildPromptCreate(values: CreatePromptValues): PromptTemplateCreateRequest {
  const name = values.name.trim();
  validatePromptName(values.name);
  if (values.description.length > 2_048 || values.description.includes("\u0000")) {
    throw new Error("Description must contain at most 2,048 characters without null characters.");
  }
  validatePromptContent(values.content);
  const common = { name, description: values.description, content: values.content };
  switch (values.workflowKind) {
    case "pr_static_build":
      return {
        ...common,
        workflowKind: values.workflowKind,
        outputSchemaVersion: "PrReviewPlanV2",
      };
    case "issue_triage":
      return { ...common, workflowKind: values.workflowKind, outputSchemaVersion: "IssueTriageV2" };
    case "pr_ui":
    case "issue_validation":
      return {
        ...common,
        workflowKind: values.workflowKind,
        outputSchemaVersion: "ValidationSummaryV1",
      };
  }
}

export function buildPromptDraftSave(
  template: PromptTemplate,
  content: string,
): PromptDraftSaveRequest {
  validatePromptContent(content);
  return {
    expectedVersion: template.version,
    content,
    outputSchemaVersion: WorkflowOutputSchemaVersions[template.workflowKind],
  };
}

export function buildPromptPublish(
  template: PromptTemplate,
  content: string,
): PromptDraftPublishRequest {
  validatePromptContent(content);
  if (content !== template.draftContent)
    throw new Error("Save the current draft before publishing.");
  return { expectedVersion: template.version };
}

export function buildPromptPreview(
  content: string,
  workItemId: string,
  workflowKind: WorkflowKind,
): PromptPreviewRequest {
  validatePromptContent(content);
  const id = workItemId.trim();
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(id)) {
    throw new Error(
      "Enter an exact work item ID containing only letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return { content, workflowKind, ...(id ? { workItemId: id } : {}) };
}

export function assertPromptPreviewScope(
  response: PromptPreviewResponse,
  request: PromptPreviewRequest,
  repositoryId: string | null,
): void {
  if (response.workItemId !== (request.workItemId ?? null)) {
    throw new Error("The preview returned a different work item. No preview has been shown.");
  }
  if (request.workItemId && repositoryId !== null && response.repositoryId !== repositoryId) {
    throw new Error(
      "This work item does not belong to the selected repository. Use an ID from the current repository.",
    );
  }
  if (!request.workItemId && response.repositoryId !== null) {
    throw new Error(
      "The preview returned unexpected repository context. No preview has been shown.",
    );
  }
}

export function bindingExpectedVersion(
  binding: PromptBinding | undefined,
  repositoryId: string | null,
  workflowKind: WorkflowKind,
): number {
  if (!binding) return 0;
  if (binding.repositoryId !== repositoryId || binding.workflowKind !== workflowKind) {
    throw new Error("The binding does not match the current scope. Refresh before changing it.");
  }
  return binding.version;
}
