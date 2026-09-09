import {
  type PromptBinding,
  type PromptBindingSaveRequest,
  PromptBindingSaveRequestSchema,
  PromptBindingSchema,
  type PromptDraftPublishRequest,
  PromptDraftPublishRequestSchema,
  type PromptDraftSaveRequest,
  PromptDraftSaveRequestSchema,
  type PromptPreviewRequest,
  PromptPreviewRequestSchema,
  type PromptPreviewResponse,
  PromptPreviewResponseSchema,
  type PromptTemplate,
  type PromptTemplateCreateRequest,
  PromptTemplateCreateRequestSchema,
  PromptTemplateSchema,
  type PromptTemplateSummary,
  PromptTemplateSummarySchema,
  type PromptVersion,
  PromptVersionSchema,
  type PromptVersionSummary,
  PromptVersionSummarySchema,
  type RepositoryValidationProfileBinding,
  type RepositoryValidationProfileBindingSaveRequest,
  RepositoryValidationProfileBindingSaveRequestSchema,
  RepositoryValidationProfileBindingSchema,
  type ValidationProfileCreateRequest,
  ValidationProfileCreateRequestSchema,
  type ValidationProfileVersion,
  ValidationProfileVersionSchema,
  type ValidationProfileVersionSummary,
  ValidationProfileVersionSummarySchema,
  type WorkflowKind,
  WorkflowKindValues,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import type {
  ConfigurationAdapter,
  ConfigurationPage,
  ConfigurationPageQuery,
  PromptBindingHistory,
  PromptBindingList,
  PromptListQuery,
  ValidationProfileBindingHistory,
} from "./adapter";
import {
  normalizePageQuery,
  PromptBindingHistorySchema,
  pageQueryString,
  ValidationProfileBindingHistorySchema,
  validateEntityId,
  validatePage,
  validateProfileConfig,
  validatePromptContent,
  validateRequest,
  validateResponse,
  validateWorkflowKind,
} from "./validation";

const promptPrefix = "/api/v1/operator/prompts";
const promptPath = (templateId: string, operation: string): string => {
  validateEntityId(templateId, operation, "templateId");
  return `${promptPrefix}/${templateId}`;
};
const repositoryPath = (repositoryId: string, operation: string): string => {
  validateEntityId(repositoryId, operation, "repositoryId");
  return `/api/v1/operator/repositories/${repositoryId}`;
};
const promptBindingsPath = (repositoryId: string | null, operation: string): string =>
  `${repositoryId === null ? "/api/v1/operator" : repositoryPath(repositoryId, operation)}/prompt-bindings`;
const profilePath = (repositoryId: string, profileId: string, operation: string): string => {
  validateEntityId(profileId, operation, "profileId");
  return `${repositoryPath(repositoryId, operation)}/validation-profiles/${profileId}`;
};

export class HttpConfigurationAdapter implements ConfigurationAdapter {
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async listPrompts(query?: PromptListQuery): Promise<ConfigurationPage<PromptTemplateSummary>> {
    const operation = "list prompt templates";
    const pagination = normalizePageQuery(query, true);
    return validatePage(
      PromptTemplateSummarySchema,
      await this.client.get(`${promptPrefix}?${pageQueryString(pagination)}`, operation),
      operation,
      pagination,
      pagination.workflowKind === undefined ? {} : { workflowKind: pagination.workflowKind },
    );
  }

  async createPrompt(input: PromptTemplateCreateRequest): Promise<PromptTemplate> {
    const operation = "create prompt template";
    validateRequest(PromptTemplateCreateRequestSchema, input, operation);
    validatePromptContent(input.content, operation);
    return validateResponse(
      PromptTemplateSchema,
      await this.client.post(promptPrefix, operation, input),
      operation,
      { workflowKind: input.workflowKind, draftOutputSchemaVersion: input.outputSchemaVersion },
    );
  }

  async getPrompt(templateId: string): Promise<PromptTemplate> {
    const operation = "get prompt template";
    return validateResponse(
      PromptTemplateSchema,
      await this.client.get(promptPath(templateId, operation), operation),
      operation,
      { id: templateId },
    );
  }

  async savePromptDraft(
    templateId: string,
    input: PromptDraftSaveRequest,
  ): Promise<PromptTemplate> {
    const operation = "save prompt draft";
    const path = `${promptPath(templateId, operation)}/draft`;
    validateRequest(PromptDraftSaveRequestSchema, input, operation);
    validatePromptContent(input.content, operation);
    return validateResponse(
      PromptTemplateSchema,
      await this.client.patch(path, operation, input),
      operation,
      { id: templateId, draftOutputSchemaVersion: input.outputSchemaVersion },
    );
  }

  async publishPrompt(
    templateId: string,
    input: PromptDraftPublishRequest,
  ): Promise<PromptVersion> {
    const operation = "publish prompt version";
    const path = `${promptPath(templateId, operation)}/publish`;
    validateRequest(PromptDraftPublishRequestSchema, input, operation);
    return validateResponse(
      PromptVersionSchema,
      await this.client.post(path, operation, input),
      operation,
      { templateId },
    );
  }

  async listPromptVersions(
    templateId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<PromptVersionSummary>> {
    const operation = "list prompt versions";
    const path = `${promptPath(templateId, operation)}/versions`;
    const pagination = normalizePageQuery(query);
    return validatePage(
      PromptVersionSummarySchema,
      await this.client.get(`${path}?${pageQueryString(pagination)}`, operation),
      operation,
      pagination,
      { templateId },
      ["id", "version"],
    );
  }

  async getPromptVersion(templateId: string, versionId: string): Promise<PromptVersion> {
    const operation = "get prompt version";
    const path = promptPath(templateId, operation);
    validateEntityId(versionId, operation, "versionId");
    return validateResponse(
      PromptVersionSchema,
      await this.client.get(`${path}/versions/${versionId}`, operation),
      operation,
      { templateId, id: versionId },
    );
  }

  async previewPrompt(input: PromptPreviewRequest): Promise<PromptPreviewResponse> {
    const operation = "preview prompt";
    validateRequest(PromptPreviewRequestSchema, input, operation);
    validatePromptContent(input.content, operation);
    return validateResponse(
      PromptPreviewResponseSchema,
      await this.client.post(`${promptPrefix}/preview`, operation, input),
      operation,
      { workItemId: input.workItemId ?? null },
    );
  }

  async listPromptBindings(repositoryId: string | null): Promise<PromptBindingList> {
    const operation = "list prompt bindings";
    const result = validateResponse(
      Type.Object(
        {
          items: Type.Array(PromptBindingSchema, { maxItems: WorkflowKindValues.length }),
        },
        { additionalProperties: false },
      ),
      await this.client.get(promptBindingsPath(repositoryId, operation), operation),
      operation,
    );
    for (const item of result.items)
      validateResponse(PromptBindingSchema, item, operation, { repositoryId });
    if (new Set(result.items.map((item) => item.workflowKind)).size !== result.items.length) {
      throw new ReviewControlProtocolError(
        operation,
        "The prompt bindings contain duplicate workflows.",
      );
    }
    return result;
  }

  async savePromptBinding(
    repositoryId: string | null,
    workflowKind: WorkflowKind,
    input: PromptBindingSaveRequest,
  ): Promise<PromptBinding> {
    const operation = "save prompt binding";
    const path = promptBindingsPath(repositoryId, operation);
    validateWorkflowKind(workflowKind, operation);
    validateRequest(PromptBindingSaveRequestSchema, input, operation);
    return validateResponse(
      PromptBindingSchema,
      await this.client.put(`${path}/${workflowKind}`, operation, input),
      operation,
      { repositoryId, workflowKind, promptVersionId: input.promptVersionId },
    );
  }

  async listPromptBindingHistory(
    repositoryId: string | null,
    workflowKind: WorkflowKind,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<PromptBindingHistory>> {
    const operation = "list prompt binding history";
    const path = promptBindingsPath(repositoryId, operation);
    validateWorkflowKind(workflowKind, operation);
    const pagination = normalizePageQuery(query);
    return validatePage(
      PromptBindingHistorySchema,
      await this.client.get(
        `${path}/${workflowKind}/history?${pageQueryString(pagination)}`,
        operation,
      ),
      operation,
      pagination,
      { repositoryId, workflowKind },
      ["id", "version"],
    );
  }

  async listProfiles(
    repositoryId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileVersionSummary>> {
    const operation = "list validation profiles";
    const path = `${repositoryPath(repositoryId, operation)}/validation-profiles`;
    const pagination = normalizePageQuery(query);
    return validatePage(
      ValidationProfileVersionSummarySchema,
      await this.client.get(`${path}?${pageQueryString(pagination)}`, operation),
      operation,
      pagination,
      { repositoryId },
      ["id", "profileId"],
    );
  }

  async publishProfile(
    repositoryId: string,
    input: ValidationProfileCreateRequest,
  ): Promise<ValidationProfileVersion> {
    const operation = "publish validation profile";
    const path = `${repositoryPath(repositoryId, operation)}/validation-profiles`;
    validateRequest(ValidationProfileCreateRequestSchema, input, operation);
    validateProfileConfig(input.config, input.workflowKind, input.target, operation);
    return validateResponse(
      ValidationProfileVersionSchema,
      await this.client.post(path, operation, input),
      operation,
      {
        repositoryId,
        workflowKind: input.workflowKind,
        target: input.target,
        outputSchemaVersion: input.outputSchemaVersion,
        ...("profileId" in input ? { profileId: input.profileId } : {}),
      },
    );
  }

  async listProfileVersions(
    repositoryId: string,
    profileId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileVersionSummary>> {
    const operation = "list validation profile versions";
    const path = `${profilePath(repositoryId, profileId, operation)}/versions`;
    const pagination = normalizePageQuery(query);
    return validatePage(
      ValidationProfileVersionSummarySchema,
      await this.client.get(`${path}?${pageQueryString(pagination)}`, operation),
      operation,
      pagination,
      { repositoryId, profileId },
      ["id", "version"],
    );
  }

  async getProfileVersion(
    repositoryId: string,
    profileId: string,
    versionId: string,
  ): Promise<ValidationProfileVersion> {
    const operation = "get validation profile version";
    const path = profilePath(repositoryId, profileId, operation);
    validateEntityId(versionId, operation, "versionId");
    return validateResponse(
      ValidationProfileVersionSchema,
      await this.client.get(`${path}/versions/${versionId}`, operation),
      operation,
      { repositoryId, profileId, id: versionId },
    );
  }

  async listProfileBindings(
    repositoryId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<RepositoryValidationProfileBinding>> {
    const operation = "list validation profile bindings";
    const path = `${repositoryPath(repositoryId, operation)}/validation-profile-bindings`;
    const pagination = normalizePageQuery(query);
    return validatePage(
      RepositoryValidationProfileBindingSchema,
      await this.client.get(`${path}?${pageQueryString(pagination)}`, operation),
      operation,
      pagination,
      { repositoryId },
      ["profileId"],
    );
  }

  async saveProfileBinding(
    repositoryId: string,
    profileId: string,
    input: RepositoryValidationProfileBindingSaveRequest,
  ): Promise<RepositoryValidationProfileBinding> {
    const operation = "save validation profile binding";
    const path = `${repositoryPath(repositoryId, operation)}/validation-profile-bindings`;
    validateEntityId(profileId, operation, "profileId");
    validateRequest(RepositoryValidationProfileBindingSaveRequestSchema, input, operation);
    return validateResponse(
      RepositoryValidationProfileBindingSchema,
      await this.client.put(`${path}/${profileId}`, operation, input),
      operation,
      { repositoryId, profileId, profileVersionId: input.profileVersionId, enabled: input.enabled },
    );
  }

  async listProfileBindingHistory(
    repositoryId: string,
    profileId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileBindingHistory>> {
    const operation = "list validation profile binding history";
    const path = `${repositoryPath(repositoryId, operation)}/validation-profile-bindings`;
    validateEntityId(profileId, operation, "profileId");
    const pagination = normalizePageQuery(query);
    return validatePage(
      ValidationProfileBindingHistorySchema,
      await this.client.get(
        `${path}/${profileId}/history?${pageQueryString(pagination)}`,
        operation,
      ),
      operation,
      pagination,
      { repositoryId, profileId },
      ["id", "version"],
    );
  }
}
