import { createHash } from "node:crypto";
import {
  maximumPromptContentUtf8Bytes,
  type OperatorPrincipal,
  type PromptPreviewRequest,
  type PromptPreviewResponse,
} from "@agentic-review/contracts";
import type { DatabaseClient } from "../database/database-client.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { ConfigurationHttpError } from "../routes/configuration-support.js";
import { renderConfiguredPrompt } from "../scheduling/job-factory.js";

export function createPromptPreview(
  database: Pick<DatabaseClient, "request">,
): (input: PromptPreviewRequest, actor: OperatorPrincipal) => Promise<PromptPreviewResponse> {
  return async (input, actor) => {
    const operatorDatabase = bindOperatorDatabase(database, actor);
    if (Buffer.byteLength(input.content, "utf8") > maximumPromptContentUtf8Bytes) {
      throw new ConfigurationHttpError(
        400,
        "prompt_content_too_large",
        "The prompt exceeds the supported UTF-8 size.",
      );
    }
    let renderedContent = input.content;
    let repositoryId: string | null = null;
    if (input.workItemId !== undefined) {
      const context = await operatorDatabase.request("getPromptWorkItemContext", {
        workItemId: input.workItemId,
      });
      if (context === null)
        throw new ConfigurationHttpError(
          404,
          "prompt_work_item_not_found",
          "The work item has no available revision snapshot.",
        );
      try {
        renderedContent = renderConfiguredPrompt(input.content, context, input.workflowKind);
      } catch (error) {
        if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
        throw new ConfigurationHttpError(
          422,
          "prompt_context_invalid",
          "The prompt cannot be rendered for this work item and workflow. Check its size and workflow type.",
        );
      }
      repositoryId = context.repositoryId;
      await operatorDatabase.request("operatorCheckPermission", {
        repositoryId,
        permission: "read",
      });
    }
    return {
      renderedContent,
      contentSha256: createHash("sha256").update(renderedContent, "utf8").digest("hex"),
      workItemId: input.workItemId ?? null,
      repositoryId,
    };
  };
}
