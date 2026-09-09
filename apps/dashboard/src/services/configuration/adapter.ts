import type {
  PromptBinding,
  PromptBindingSaveRequest,
  PromptDraftPublishRequest,
  PromptDraftSaveRequest,
  PromptPreviewRequest,
  PromptPreviewResponse,
  PromptTemplate,
  PromptTemplateCreateRequest,
  PromptTemplateSummary,
  PromptVersion,
  PromptVersionSummary,
  RepositoryValidationProfileBinding,
  RepositoryValidationProfileBindingSaveRequest,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
  WorkflowKind,
} from "@agentic-review/contracts";

export interface ConfigurationPageQuery {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PromptListQuery extends ConfigurationPageQuery {
  readonly workflowKind?: WorkflowKind;
}

export interface ConfigurationPage<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface PromptBindingList {
  readonly items: PromptBinding[];
}

export interface PromptBindingHistory extends PromptBinding {
  readonly id: string;
  readonly previousVersionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ValidationProfileBindingHistory extends RepositoryValidationProfileBinding {
  readonly id: string;
  readonly previousVersionId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ConfigurationAdapter {
  listPrompts(query?: PromptListQuery): Promise<ConfigurationPage<PromptTemplateSummary>>;
  createPrompt(input: PromptTemplateCreateRequest): Promise<PromptTemplate>;
  getPrompt(templateId: string): Promise<PromptTemplate>;
  savePromptDraft(templateId: string, input: PromptDraftSaveRequest): Promise<PromptTemplate>;
  publishPrompt(templateId: string, input: PromptDraftPublishRequest): Promise<PromptVersion>;
  listPromptVersions(
    templateId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<PromptVersionSummary>>;
  getPromptVersion(templateId: string, versionId: string): Promise<PromptVersion>;
  previewPrompt(input: PromptPreviewRequest): Promise<PromptPreviewResponse>;
  listPromptBindings(repositoryId: string | null): Promise<PromptBindingList>;
  savePromptBinding(
    repositoryId: string | null,
    workflowKind: WorkflowKind,
    input: PromptBindingSaveRequest,
  ): Promise<PromptBinding>;
  listPromptBindingHistory(
    repositoryId: string | null,
    workflowKind: WorkflowKind,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<PromptBindingHistory>>;
  listProfiles(
    repositoryId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileVersionSummary>>;
  publishProfile(
    repositoryId: string,
    input: ValidationProfileCreateRequest,
  ): Promise<ValidationProfileVersion>;
  listProfileVersions(
    repositoryId: string,
    profileId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileVersionSummary>>;
  getProfileVersion(
    repositoryId: string,
    profileId: string,
    versionId: string,
  ): Promise<ValidationProfileVersion>;
  listProfileBindings(
    repositoryId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<RepositoryValidationProfileBinding>>;
  saveProfileBinding(
    repositoryId: string,
    profileId: string,
    input: RepositoryValidationProfileBindingSaveRequest,
  ): Promise<RepositoryValidationProfileBinding>;
  listProfileBindingHistory(
    repositoryId: string,
    profileId: string,
    query?: ConfigurationPageQuery,
  ): Promise<ConfigurationPage<ValidationProfileBindingHistory>>;
}
