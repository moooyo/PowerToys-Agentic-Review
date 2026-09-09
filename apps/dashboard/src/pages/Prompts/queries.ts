import type { WorkflowKind } from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";

export const promptQueryKeys = {
  templates: ["prompt-templates"] as const,
  templateList: (page: number, pageSize: number, workflowKind: WorkflowKind | undefined) =>
    ["prompt-templates", "list", page, pageSize, workflowKind ?? "all"] as const,
  templatePicker: (workflowKind: WorkflowKind, page: number, pageSize: number) =>
    ["prompt-templates", "binding-picker", workflowKind, page, pageSize] as const,
  template: (templateId: string) => ["prompt-template", templateId] as const,
  versions: (templateId: string) => ["prompt-versions", templateId] as const,
  versionList: (templateId: string | null, page: number, pageSize: number) =>
    ["prompt-versions", templateId, "list", page, pageSize] as const,
  version: (templateId: string, versionId: string) =>
    ["prompt-version", templateId, versionId] as const,
  bindings: ["prompt-bindings"] as const,
  bindingScope: (repositoryId: string | null) => ["prompt-bindings", repositoryId] as const,
  bindingHistories: ["prompt-binding-history"] as const,
  bindingHistory: (
    repositoryId: string | null,
    workflowKind: WorkflowKind,
    page: number,
    pageSize: number,
  ) => ["prompt-binding-history", repositoryId, workflowKind, page, pageSize] as const,
};

export async function invalidatePromptPublication(
  queryClient: QueryClient,
  templateId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: promptQueryKeys.templates }),
    queryClient.invalidateQueries({ queryKey: promptQueryKeys.versions(templateId) }),
  ]);
}
