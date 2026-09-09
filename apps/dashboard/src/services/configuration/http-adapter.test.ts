import type {
  PromptBinding,
  PromptBindingSaveRequest,
  PromptDraftPublishRequest,
  PromptDraftSaveRequest,
  PromptPreviewRequest,
  PromptTemplate,
  PromptTemplateCreateRequest,
  PromptVersion,
  RepositoryValidationProfileBinding,
  RepositoryValidationProfileBindingSaveRequest,
  ValidationCommandStep,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
  WorkflowKind,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "../review-control/errors";
import {
  DashboardHttpClient,
  MAX_DASHBOARD_REQUEST_BYTES,
  MAX_DASHBOARD_RESPONSE_BYTES,
} from "../review-control/http-client";
import type {
  ConfigurationAdapter,
  ConfigurationPageQuery,
  PromptBindingHistory,
  PromptListQuery,
  ValidationProfileBindingHistory,
} from "./adapter";
import { HttpConfigurationAdapter } from "./http-adapter";

const repositoryId = "repo-powertoys";
const templateId = "prompt-review";
const versionId = "prompt-version-1";
const profileId = "profile-build";
const profileVersionId = "profile-version-1";
const workflowKind = "pr_static_build";
const createdAt = "2026-09-07T02:00:00.000Z";
const digest = "a".repeat(64);
const promptsPath = "/api/v1/operator/prompts";
const promptPath = `${promptsPath}/${templateId}`;
const globalBindingsPath = "/api/v1/operator/prompt-bindings";
const repositoryPath = `/api/v1/operator/repositories/${repositoryId}`;
const repositoryBindingsPath = `${repositoryPath}/prompt-bindings`;
const profilesPath = `${repositoryPath}/validation-profiles`;
const profilePath = `${profilesPath}/${profileId}`;
const profileBindingsPath = `${repositoryPath}/validation-profile-bindings`;
const pagination = "?page=1&pageSize=20";

const template: PromptTemplate = {
  id: templateId,
  name: "Static review",
  description: "Review the requested revision.",
  workflowKind,
  version: 1,
  draftRevision: 1,
  draftContent: "Review {{workItem.title}}.",
  draftOutputSchemaVersion: "PrReviewPlanV2",
  latestPublishedVersionId: versionId,
  createdAt,
  updatedAt: createdAt,
};
const { draftContent: _draftContent, ...templateSummary } = template;
const promptVersion: PromptVersion = {
  id: versionId,
  templateId,
  version: 1,
  content: template.draftContent,
  contentSha256: digest,
  outputSchemaVersion: "PrReviewPlanV2",
  createdAt,
  publishedAt: createdAt,
  createdBy: "operator:configuration-tests",
};
const { content: _content, ...promptVersionSummary } = promptVersion;
const config: ValidationProfileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [],
  test: [],
  launch: [],
  cleanup: [],
  requiredCapabilities: ["git"],
  hardTimeoutMs: 60_000,
  noProgressTimeoutMs: 30_000,
};
const commandStep: ValidationCommandStep = {
  id: "step-build",
  name: "Build",
  command: {
    executable: "dotnet",
    args: ["build"],
    workingDirectory: ".",
    environment: [],
  },
  timeoutMs: 30_000,
  required: true,
};
const profileVersion: ValidationProfileVersion = {
  id: profileVersionId,
  profileId,
  repositoryId,
  name: "Static build",
  version: 1,
  config,
  required: true,
  workflowKind,
  target: "headless",
  outputSchemaVersion: "PrReviewPlanV2",
  configSha256: digest,
  createdAt,
  publishedAt: createdAt,
  createdBy: "operator:configuration-tests",
};
const { config: _config, ...profileSummary } = profileVersion;
const promptBinding: PromptBinding = {
  repositoryId,
  workflowKind,
  promptVersionId: versionId,
  version: 1,
};
const globalBinding: PromptBinding = { ...promptBinding, repositoryId: null };
const promptHistory: PromptBindingHistory = {
  ...promptBinding,
  id: "prompt-binding-history-1",
  previousVersionId: null,
  createdAt,
  createdBy: "operator:configuration-tests",
};
const globalHistory: PromptBindingHistory = { ...promptHistory, repositoryId: null };
const profileBinding: RepositoryValidationProfileBinding = {
  repositoryId,
  profileId,
  profileVersionId,
  enabled: true,
  version: 1,
};
const profileHistory: ValidationProfileBindingHistory = {
  ...profileBinding,
  id: "profile-binding-history-1",
  previousVersionId: null,
  createdAt,
  createdBy: "operator:configuration-tests",
};
const createPromptRequest: PromptTemplateCreateRequest = {
  name: template.name,
  workflowKind,
  description: template.description,
  content: template.draftContent,
  outputSchemaVersion: "PrReviewPlanV2",
};
const draftRequest: PromptDraftSaveRequest = {
  expectedVersion: 1,
  content: template.draftContent,
  outputSchemaVersion: "PrReviewPlanV2",
};
const publishRequest: PromptDraftPublishRequest = { expectedVersion: 1 };
const previewRequest: PromptPreviewRequest = {
  content: template.draftContent,
  workItemId: "work-item-41982",
};
const preview = {
  renderedContent: "Review the accessibility changes.",
  contentSha256: digest,
  workItemId: previewRequest.workItemId,
  repositoryId,
};
const savePromptBindingRequest: PromptBindingSaveRequest = {
  expectedVersion: 0,
  promptVersionId: versionId,
};
const createProfileRequest: ValidationProfileCreateRequest = {
  name: profileVersion.name,
  config,
  required: true,
  workflowKind,
  target: "headless",
  outputSchemaVersion: "PrReviewPlanV2",
  expectedVersion: 0,
};
const saveProfileBindingRequest: RepositoryValidationProfileBindingSaveRequest = {
  expectedVersion: 0,
  profileVersionId,
  enabled: true,
};

const pageOf = <T>(item: T, page = 1, pageSize = 20, total = 1) => ({
  items: [item],
  total,
  page,
  pageSize,
});
const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
const adapterWith = (value: unknown) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => jsonResponse(value));
  return { fetch, adapter: new HttpConfigurationAdapter({ fetch }) };
};

interface OperationCase {
  readonly name: string;
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly path: string;
  readonly response: unknown;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly invoke: (adapter: ConfigurationAdapter) => Promise<unknown>;
}

const operations: OperationCase[] = [
  {
    name: "list prompts",
    method: "GET",
    path: `${promptsPath}${pagination}`,
    response: pageOf(templateSummary),
    invoke: (adapter) => adapter.listPrompts(),
  },
  {
    name: "create prompt",
    method: "POST",
    path: promptsPath,
    body: createPromptRequest,
    response: template,
    invoke: (adapter) => adapter.createPrompt(createPromptRequest),
  },
  {
    name: "get prompt",
    method: "GET",
    path: promptPath,
    response: template,
    invoke: (adapter) => adapter.getPrompt(templateId),
  },
  {
    name: "save draft",
    method: "PATCH",
    path: `${promptPath}/draft`,
    body: draftRequest,
    response: template,
    invoke: (adapter) => adapter.savePromptDraft(templateId, draftRequest),
  },
  {
    name: "publish prompt",
    method: "POST",
    path: `${promptPath}/publish`,
    body: publishRequest,
    response: promptVersion,
    invoke: (adapter) => adapter.publishPrompt(templateId, publishRequest),
  },
  {
    name: "list prompt versions",
    method: "GET",
    path: `${promptPath}/versions${pagination}`,
    response: pageOf(promptVersionSummary),
    invoke: (adapter) => adapter.listPromptVersions(templateId),
  },
  {
    name: "get prompt version",
    method: "GET",
    path: `${promptPath}/versions/${versionId}`,
    response: promptVersion,
    invoke: (adapter) => adapter.getPromptVersion(templateId, versionId),
  },
  {
    name: "preview prompt",
    method: "POST",
    path: `${promptsPath}/preview`,
    body: previewRequest,
    response: preview,
    invoke: (adapter) => adapter.previewPrompt(previewRequest),
  },
  {
    name: "list global prompt bindings",
    method: "GET",
    path: globalBindingsPath,
    response: { items: [globalBinding] },
    invoke: (adapter) => adapter.listPromptBindings(null),
  },
  {
    name: "save global prompt binding",
    method: "PUT",
    path: `${globalBindingsPath}/${workflowKind}`,
    body: savePromptBindingRequest,
    response: globalBinding,
    invoke: (adapter) => adapter.savePromptBinding(null, workflowKind, savePromptBindingRequest),
  },
  {
    name: "list global prompt binding history",
    method: "GET",
    path: `${globalBindingsPath}/${workflowKind}/history${pagination}`,
    response: pageOf(globalHistory),
    invoke: (adapter) => adapter.listPromptBindingHistory(null, workflowKind),
  },
  {
    name: "list repository prompt bindings",
    method: "GET",
    path: repositoryBindingsPath,
    response: { items: [promptBinding] },
    invoke: (adapter) => adapter.listPromptBindings(repositoryId),
  },
  {
    name: "save repository prompt binding",
    method: "PUT",
    path: `${repositoryBindingsPath}/${workflowKind}`,
    body: savePromptBindingRequest,
    response: promptBinding,
    invoke: (adapter) =>
      adapter.savePromptBinding(repositoryId, workflowKind, savePromptBindingRequest),
  },
  {
    name: "list repository prompt binding history",
    method: "GET",
    path: `${repositoryBindingsPath}/${workflowKind}/history${pagination}`,
    response: pageOf(promptHistory),
    invoke: (adapter) => adapter.listPromptBindingHistory(repositoryId, workflowKind),
  },
  {
    name: "list profiles",
    method: "GET",
    path: `${profilesPath}${pagination}`,
    response: pageOf(profileSummary),
    invoke: (adapter) => adapter.listProfiles(repositoryId),
  },
  {
    name: "publish profile",
    method: "POST",
    path: profilesPath,
    body: createProfileRequest,
    response: profileVersion,
    invoke: (adapter) => adapter.publishProfile(repositoryId, createProfileRequest),
  },
  {
    name: "list profile versions",
    method: "GET",
    path: `${profilePath}/versions${pagination}`,
    response: pageOf(profileSummary),
    invoke: (adapter) => adapter.listProfileVersions(repositoryId, profileId),
  },
  {
    name: "get profile version",
    method: "GET",
    path: `${profilePath}/versions/${profileVersionId}`,
    response: profileVersion,
    invoke: (adapter) => adapter.getProfileVersion(repositoryId, profileId, profileVersionId),
  },
  {
    name: "list profile bindings",
    method: "GET",
    path: `${profileBindingsPath}${pagination}`,
    response: pageOf(profileBinding),
    invoke: (adapter) => adapter.listProfileBindings(repositoryId),
  },
  {
    name: "save profile binding",
    method: "PUT",
    path: `${profileBindingsPath}/${profileId}`,
    body: saveProfileBindingRequest,
    response: profileBinding,
    invoke: (adapter) =>
      adapter.saveProfileBinding(repositoryId, profileId, saveProfileBindingRequest),
  },
  {
    name: "list profile binding history",
    method: "GET",
    path: `${profileBindingsPath}/${profileId}/history${pagination}`,
    response: pageOf(profileHistory),
    invoke: (adapter) => adapter.listProfileBindingHistory(repositoryId, profileId),
  },
];

interface PageOperation {
  readonly name: string;
  readonly path: string;
  readonly item: object;
  readonly invoke: (
    adapter: ConfigurationAdapter,
    query?: ConfigurationPageQuery,
  ) => Promise<unknown>;
}
const pageOperations: PageOperation[] = [
  {
    name: "prompts",
    path: promptsPath,
    item: templateSummary,
    invoke: (adapter, query) => adapter.listPrompts(query),
  },
  {
    name: "prompt versions",
    path: `${promptPath}/versions`,
    item: promptVersionSummary,
    invoke: (adapter, query) => adapter.listPromptVersions(templateId, query),
  },
  {
    name: "global prompt history",
    path: `${globalBindingsPath}/${workflowKind}/history`,
    item: globalHistory,
    invoke: (adapter, query) => adapter.listPromptBindingHistory(null, workflowKind, query),
  },
  {
    name: "repository prompt history",
    path: `${repositoryBindingsPath}/${workflowKind}/history`,
    item: promptHistory,
    invoke: (adapter, query) => adapter.listPromptBindingHistory(repositoryId, workflowKind, query),
  },
  {
    name: "profiles",
    path: profilesPath,
    item: profileSummary,
    invoke: (adapter, query) => adapter.listProfiles(repositoryId, query),
  },
  {
    name: "profile versions",
    path: `${profilePath}/versions`,
    item: profileSummary,
    invoke: (adapter, query) => adapter.listProfileVersions(repositoryId, profileId, query),
  },
  {
    name: "profile bindings",
    path: profileBindingsPath,
    item: profileBinding,
    invoke: (adapter, query) => adapter.listProfileBindings(repositoryId, query),
  },
  {
    name: "profile history",
    path: `${profileBindingsPath}/${profileId}/history`,
    item: profileHistory,
    invoke: (adapter, query) => adapter.listProfileBindingHistory(repositoryId, profileId, query),
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("configuration HTTP routes", () => {
  it.each(operations)(
    "sends $name through its authenticated same-origin route",
    async (operation) => {
      const { adapter, fetch } = adapterWith(operation.response);
      await expect(operation.invoke(adapter)).resolves.toEqual(operation.response);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(operation.path, {
        ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(operation.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method: operation.method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each(["pr_static_build", "pr_ui", "issue_triage", "issue_validation"] as const)(
    "serializes the supported prompt workflow filter %s",
    async (kind) => {
      const { adapter, fetch } = adapterWith({ items: [], total: 0, page: 1, pageSize: 20 });
      await adapter.listPrompts({ workflowKind: kind });
      expect(fetch).toHaveBeenCalledWith(
        `${promptsPath}${pagination}&workflowKind=${kind}`,
        expect.anything(),
      );
    },
  );

  it.each(["pr_static_build", "pr_ui", "issue_triage", "issue_validation"] as const)(
    "serializes the optional preview workflow %s with and without a work item",
    async (kind) => {
      for (const workItemId of [undefined, previewRequest.workItemId]) {
        const input: PromptPreviewRequest = {
          content: previewRequest.content,
          workflowKind: kind,
          ...(workItemId === undefined ? {} : { workItemId }),
        };
        const response = {
          ...preview,
          workItemId: workItemId ?? null,
          repositoryId: workItemId === undefined ? null : repositoryId,
        };
        const { adapter, fetch } = adapterWith(response);
        await expect(adapter.previewPrompt(input)).resolves.toEqual(response);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          `${promptsPath}/preview`,
          expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
        expect(response).not.toHaveProperty("workflowKind");
      }
    },
  );

  it.each(pageOperations)("preserves explicit pagination for $name", async (operation) => {
    const response = { items: [], total: 0, page: 3, pageSize: 50 };
    const { adapter, fetch } = adapterWith(response);
    await expect(operation.invoke(adapter, { page: 3, pageSize: 50 })).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(`${operation.path}?page=3&pageSize=50`, expect.anything());
  });

  it("accepts multiple versions and history rows for the same configuration", async () => {
    const promptVersions = {
      ...pageOf(promptVersionSummary),
      total: 2,
      items: [
        promptVersionSummary,
        { ...promptVersionSummary, id: "prompt-version-2", version: 2 },
      ],
    };
    await expect(
      adapterWith(promptVersions).adapter.listPromptVersions(templateId),
    ).resolves.toEqual(promptVersions);
    const profileVersions = {
      ...pageOf(profileSummary),
      total: 2,
      items: [profileSummary, { ...profileSummary, id: "profile-version-2", version: 2 }],
    };
    await expect(
      adapterWith(profileVersions).adapter.listProfileVersions(repositoryId, profileId),
    ).resolves.toEqual(profileVersions);
    for (const scope of [null, repositoryId]) {
      const first = { ...promptHistory, repositoryId: scope };
      const second = {
        ...first,
        id: "prompt-history-2",
        version: 2,
        previousVersionId: versionId,
        promptVersionId: "prompt-version-2",
      };
      const response = { ...pageOf(first), total: 2, items: [first, second] };
      await expect(
        adapterWith(response).adapter.listPromptBindingHistory(scope, workflowKind),
      ).resolves.toEqual(response);
    }
    const response = {
      ...pageOf(profileHistory),
      total: 2,
      items: [
        profileHistory,
        {
          ...profileHistory,
          id: "profile-history-2",
          version: 2,
          previousVersionId: profileVersionId,
          profileVersionId: "profile-version-2",
        },
      ],
    };
    await expect(
      adapterWith(response).adapter.listProfileBindingHistory(repositoryId, profileId),
    ).resolves.toEqual(response);
  });

  it("accepts all four distinct current prompt bindings in either scope", async () => {
    for (const scope of [null, repositoryId]) {
      const response = {
        items: (["pr_static_build", "pr_ui", "issue_triage", "issue_validation"] as const).map(
          (kind) => ({ ...promptBinding, repositoryId: scope, workflowKind: kind }),
        ),
      };
      await expect(adapterWith(response).adapter.listPromptBindings(scope)).resolves.toEqual(
        response,
      );
    }
  });

  it.each([
    {
      workflowKind: "pr_ui",
      target: "web",
      promptSchema: "ValidationSummaryV1",
      profileSchema: "ValidationReportV1",
    },
    {
      workflowKind: "pr_ui",
      target: "windows_desktop",
      promptSchema: "ValidationSummaryV1",
      profileSchema: "ValidationReportV1",
    },
    {
      workflowKind: "issue_triage",
      target: "headless",
      promptSchema: "IssueTriageV2",
      profileSchema: "IssueTriageV2",
    },
    {
      workflowKind: "issue_validation",
      target: "headless",
      promptSchema: "ValidationSummaryV1",
      profileSchema: "ValidationReportV1",
    },
    {
      workflowKind: "issue_validation",
      target: "web",
      promptSchema: "ValidationSummaryV1",
      profileSchema: "ValidationReportV1",
    },
    {
      workflowKind: "issue_validation",
      target: "windows_desktop",
      promptSchema: "ValidationSummaryV1",
      profileSchema: "ValidationReportV1",
    },
  ] as const)(
    "preserves distinct prompt and profile schemas for $workflowKind / $target",
    async (kind) => {
      const createdTemplate = {
        ...template,
        workflowKind: kind.workflowKind,
        draftOutputSchemaVersion: kind.promptSchema,
      };
      await expect(
        adapterWith(createdTemplate).adapter.createPrompt({
          ...createPromptRequest,
          workflowKind: kind.workflowKind,
          outputSchemaVersion: kind.promptSchema,
        }),
      ).resolves.toEqual(createdTemplate);
      const publishedProfile = {
        ...profileVersion,
        workflowKind: kind.workflowKind,
        target: kind.target,
        outputSchemaVersion: kind.profileSchema,
      };
      await expect(
        adapterWith(publishedProfile).adapter.publishProfile(repositoryId, {
          ...createProfileRequest,
          workflowKind: kind.workflowKind,
          target: kind.target,
          outputSchemaVersion: kind.profileSchema,
        }),
      ).resolves.toEqual(publishedProfile);
    },
  );

  it("supports prompt previews without a work item and explicit first profile publication", async () => {
    const { adapter, fetch } = adapterWith({ ...preview, workItemId: null, repositoryId: null });
    await expect(
      adapter.previewPrompt({ content: "Review this revision." }),
    ).resolves.toMatchObject({ workItemId: null });
    expect(fetch).toHaveBeenCalledWith(
      `${promptsPath}/preview`,
      expect.objectContaining({ body: JSON.stringify({ content: "Review this revision." }) }),
    );
    const { expectedVersion: _version, ...firstPublication } = createProfileRequest;
    await expect(
      adapterWith(profileVersion).adapter.publishProfile(repositoryId, firstPublication),
    ).resolves.toEqual(profileVersion);
    await expect(
      adapterWith(profileVersion).adapter.publishProfile(repositoryId, {
        ...createProfileRequest,
        profileId,
        expectedVersion: 1,
      }),
    ).resolves.toEqual(profileVersion);
  });
});

describe("configuration request validation", () => {
  it.each([
    "",
    "../other",
    "repo/other",
    "repo%2Fother",
    "repo?query",
    "repo#fragment",
    "repo\\other",
    "repo\n",
    "a".repeat(129),
  ])("rejects invalid IDs at every parameter position before fetch: %j", async (id) => {
    const { adapter, fetch } = adapterWith(null);
    const calls = [
      () => adapter.getPrompt(id),
      () => adapter.savePromptDraft(id, draftRequest),
      () => adapter.publishPrompt(id, publishRequest),
      () => adapter.listPromptVersions(id),
      () => adapter.getPromptVersion(id, versionId),
      () => adapter.getPromptVersion(templateId, id),
      () => adapter.previewPrompt({ ...previewRequest, workItemId: id }),
      () => adapter.listPromptBindings(id),
      () => adapter.savePromptBinding(id, workflowKind, savePromptBindingRequest),
      () =>
        adapter.savePromptBinding(null, workflowKind, {
          ...savePromptBindingRequest,
          promptVersionId: id,
        }),
      () => adapter.listPromptBindingHistory(id, workflowKind),
      () => adapter.listProfiles(id),
      () => adapter.publishProfile(id, createProfileRequest),
      () =>
        adapter.publishProfile(repositoryId, {
          ...createProfileRequest,
          profileId: id,
          expectedVersion: 1,
        }),
      () => adapter.listProfileVersions(id, profileId),
      () => adapter.listProfileVersions(repositoryId, id),
      () => adapter.getProfileVersion(id, profileId, profileVersionId),
      () => adapter.getProfileVersion(repositoryId, id, profileVersionId),
      () => adapter.getProfileVersion(repositoryId, profileId, id),
      () => adapter.listProfileBindings(id),
      () => adapter.saveProfileBinding(id, profileId, saveProfileBindingRequest),
      () => adapter.saveProfileBinding(repositoryId, id, saveProfileBindingRequest),
      () =>
        adapter.saveProfileBinding(repositoryId, profileId, {
          ...saveProfileBindingRequest,
          profileVersionId: id,
        }),
      () => adapter.listProfileBindingHistory(id, profileId),
      () => adapter.listProfileBindingHistory(repositoryId, id),
    ];
    for (const call of calls)
      await expect(call()).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "pr_review", "pr_static_build\n", "issue_triage/history", "PR_UI"])(
    "rejects unsupported workflows before fetch: %j",
    async (kind) => {
      const { adapter, fetch } = adapterWith(null);
      await expect(
        adapter.listPrompts({ workflowKind: kind as WorkflowKind }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      for (const scope of [null, repositoryId]) {
        await expect(
          adapter.savePromptBinding(scope, kind as WorkflowKind, savePromptBindingRequest),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
        await expect(
          adapter.listPromptBindingHistory(scope, kind as WorkflowKind),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(pageOperations)(
    "rejects malformed pagination and extra query keys for $name",
    async (operation) => {
      const { adapter, fetch } = adapterWith(null);
      for (const query of [
        { page: 0 },
        { page: -1 },
        { page: 1.5 },
        { page: Number.NaN },
        { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
        { pageSize: 0 },
        { pageSize: 51 },
        { pageSize: 1.5 },
        { page: "1" },
        { page: undefined },
        { search: "review" },
      ]) {
        await expect(
          operation.invoke(adapter, query as ConfigurationPageQuery),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
      }
      if (operation.name !== "prompts") {
        await expect(
          operation.invoke(adapter, { workflowKind } as ConfigurationPageQuery),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    "",
    "pr_review",
    "pr_static_build\n",
    "issue_triage/history",
    "PR_UI",
    1,
  ])("rejects malformed or explicitly undefined preview workflows: %j", async (kind) => {
    const { adapter, fetch } = adapterWith(preview);
    await expect(
      adapter.previewPrompt({ ...previewRequest, workflowKind: kind } as PromptPreviewRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects undefined workflow values instead of silently dropping them", async () => {
    const { adapter, fetch } = adapterWith(null);
    await expect(
      adapter.listPrompts({ workflowKind: undefined } as PromptListQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects server-owned fields and undefined fields in every mutation schema", async () => {
    const { adapter, fetch } = adapterWith(null);
    for (const extra of [{ createdBy: "injected-operator" }, { unexpected: undefined }]) {
      const calls = [
        () =>
          adapter.createPrompt({ ...createPromptRequest, ...extra } as PromptTemplateCreateRequest),
        () =>
          adapter.savePromptDraft(templateId, {
            ...draftRequest,
            ...extra,
          } as PromptDraftSaveRequest),
        () =>
          adapter.publishPrompt(templateId, {
            ...publishRequest,
            ...extra,
          } as PromptDraftPublishRequest),
        () => adapter.previewPrompt({ ...previewRequest, ...extra } as PromptPreviewRequest),
        () =>
          adapter.savePromptBinding(repositoryId, workflowKind, {
            ...savePromptBindingRequest,
            ...extra,
          } as PromptBindingSaveRequest),
        () =>
          adapter.publishProfile(repositoryId, {
            ...createProfileRequest,
            ...extra,
          } as ValidationProfileCreateRequest),
        () =>
          adapter.saveProfileBinding(repositoryId, profileId, {
            ...saveProfileBindingRequest,
            ...extra,
          } as RepositoryValidationProfileBindingSaveRequest),
      ];
      for (const call of calls)
        await expect(call()).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "requires an integer compare-and-swap version: %j",
    async (expectedVersion) => {
      const { adapter, fetch } = adapterWith(null);
      const calls = [
        () =>
          adapter.savePromptDraft(templateId, {
            ...draftRequest,
            expectedVersion,
          } as PromptDraftSaveRequest),
        () => adapter.publishPrompt(templateId, { expectedVersion } as PromptDraftPublishRequest),
        () =>
          adapter.savePromptBinding(null, workflowKind, {
            ...savePromptBindingRequest,
            expectedVersion,
          } as PromptBindingSaveRequest),
        () =>
          adapter.publishProfile(repositoryId, {
            ...createProfileRequest,
            profileId,
            expectedVersion,
          } as ValidationProfileCreateRequest),
        () =>
          adapter.saveProfileBinding(repositoryId, profileId, {
            ...saveProfileBindingRequest,
            expectedVersion,
          } as RepositoryValidationProfileBindingSaveRequest),
      ];
      for (const call of calls)
        await expect(call()).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("allows zero only for new bindings or new profiles", async () => {
    const { adapter, fetch } = adapterWith(null);
    await expect(
      adapter.savePromptDraft(templateId, { ...draftRequest, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.publishPrompt(templateId, { expectedVersion: 0 })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.publishProfile(repositoryId, {
        ...createProfileRequest,
        profileId,
        expectedVersion: 0,
      } as ValidationProfileCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.publishProfile(repositoryId, {
        ...createProfileRequest,
        expectedVersion: 1,
      } as ValidationProfileCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " \n\t",
    "review\u0000",
    "\ud800",
    "text\udfff",
    "a".repeat(262_145),
    "\u754c".repeat(87_382),
  ])(
    "rejects invalid prompt content on creation, draft save, and preview: case %#",
    async (content) => {
      const { adapter, fetch } = adapterWith(null);
      await expect(
        adapter.createPrompt({ ...createPromptRequest, content }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(
        adapter.savePromptDraft(templateId, { ...draftRequest, content }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.previewPrompt({ content })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("accepts valid Unicode at the exact 256 KiB prompt boundary", async () => {
    const content = "\ud83d\ude80".repeat(65_536);
    expect(new TextEncoder().encode(content).byteLength).toBe(262_144);
    await expect(
      adapterWith({ ...template, draftContent: content }).adapter.createPrompt({
        ...createPromptRequest,
        content,
      }),
    ).resolves.toMatchObject({ draftContent: content });
    await expect(
      adapterWith({ ...template, draftContent: content }).adapter.savePromptDraft(templateId, {
        ...draftRequest,
        content,
      }),
    ).resolves.toMatchObject({ draftContent: content });
    await expect(
      adapterWith({ ...preview, workItemId: null }).adapter.previewPrompt({ content }),
    ).resolves.toMatchObject({ workItemId: null });
  });

  it.each(["create", "save", "preview"] as const)(
    "preserves a leading BOM in the %s prompt request and response",
    async (operation) => {
      const content = "\ufeffReview the requested revision.\nPreserve this exact content.";
      const response =
        operation === "preview"
          ? { ...preview, renderedContent: content }
          : { ...template, draftContent: content };
      const { adapter, fetch } = adapterWith(response);
      const body =
        operation === "create"
          ? { ...createPromptRequest, content }
          : operation === "save"
            ? { ...draftRequest, content }
            : { ...previewRequest, content };
      const result =
        operation === "create"
          ? await adapter.createPrompt(body as PromptTemplateCreateRequest)
          : operation === "save"
            ? await adapter.savePromptDraft(templateId, body as PromptDraftSaveRequest)
            : await adapter.previewPrompt(body as PromptPreviewRequest);

      expect(result).toEqual(response);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        operation === "create"
          ? promptsPath
          : operation === "save"
            ? `${promptPath}/draft`
            : `${promptsPath}/preview`,
        expect.objectContaining({
          method: operation === "save" ? "PATCH" : "POST",
          body: JSON.stringify(body),
        }),
      );
      const returnedContent =
        "draftContent" in result ? result.draftContent : result.renderedContent;
      expect(new TextEncoder().encode(returnedContent)).toEqual(new TextEncoder().encode(content));
      expect(returnedContent.codePointAt(0)).toBe(0xfeff);
    },
  );

  it("preserves a leading BOM in published prompt content", async () => {
    const content = "\ufeffReview this published revision.";
    const response = { ...promptVersion, content };
    const { adapter, fetch } = adapterWith(response);
    const result = await adapter.getPromptVersion(templateId, versionId);
    expect(result).toEqual(response);
    expect(new TextEncoder().encode(result.content)).toEqual(new TextEncoder().encode(content));
    expect(result.content.codePointAt(0)).toBe(0xfeff);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${promptPath}/versions/${versionId}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects inconsistent workflow schemas and invalid nested command fields", async () => {
    const { adapter, fetch } = adapterWith(null);
    await expect(
      adapter.createPrompt({
        ...createPromptRequest,
        outputSchemaVersion: "IssueTriageV2",
      } as PromptTemplateCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.publishProfile(repositoryId, {
        ...createProfileRequest,
        target: "web",
      } as ValidationProfileCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    for (const command of [
      { ...commandStep.command, workingDirectory: "../outside" },
      { ...commandStep.command, workingDirectory: "C:\\workspace" },
      { ...commandStep.command, executable: "dotnet\n" },
      { ...commandStep.command, args: [undefined] },
      {
        ...commandStep.command,
        environment: [{ name: "TOKEN", value: "secret", secretRef: "secret-1" }],
      },
      { ...commandStep.command, unknown: true },
    ]) {
      await expect(
        adapter.publishProfile(repositoryId, {
          ...createProfileRequest,
          config: { ...config, build: [{ ...commandStep, command }] },
        } as ValidationProfileCreateRequest),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["setup", "build", "test", "launch", "cleanup"] as const)(
    "forbids issue-triage commands in the %s stage",
    async (stage) => {
      const { adapter, fetch } = adapterWith(null);
      await expect(
        adapter.publishProfile(repositoryId, {
          ...createProfileRequest,
          workflowKind: "issue_triage",
          outputSchemaVersion: "IssueTriageV2",
          config: { ...config, [stage]: [commandStep] },
        }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-field profile errors, duplicate identities, and oversized UTF-8 configuration", async () => {
    const { adapter, fetch } = adapterWith(null);
    const badConfigs: ValidationProfileConfig[] = [
      { ...config, noProgressTimeoutMs: config.hardTimeoutMs + 1 },
      { ...config, build: [{ ...commandStep, timeoutMs: config.hardTimeoutMs + 1 }] },
      { ...config, setup: [commandStep], cleanup: [commandStep] },
      {
        ...config,
        build: [
          {
            ...commandStep,
            command: {
              ...commandStep.command,
              environment: [
                { name: "Path", value: "first" },
                { name: "PATH", value: "second" },
              ],
            },
          },
        ],
      },
      {
        ...config,
        build: [
          {
            ...commandStep,
            command: {
              ...commandStep.command,
              environment: [{ name: "GITHUB_TOKEN", value: "plaintext" }],
            },
          },
        ],
      },
      {
        ...config,
        build: [
          {
            ...commandStep,
            command: {
              ...commandStep.command,
              args: Array.from({ length: 11 }, () => "\u754c".repeat(8_192)),
            },
          },
        ],
      },
    ];
    for (const value of badConfigs) {
      await expect(
        adapter.publishProfile(repositoryId, { ...createProfileRequest, config: value }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects lone surrogates outside prompt bodies before JSON serialization", async () => {
    const { adapter, fetch } = adapterWith(null);
    await expect(
      adapter.createPrompt({ ...createPromptRequest, name: "\ud800" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.createPrompt({ ...createPromptRequest, description: "\udfff" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.publishProfile(repositoryId, {
        ...createProfileRequest,
        config: {
          ...config,
          build: [{ ...commandStep, command: { ...commandStep.command, args: ["\ud800"] } }],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("configuration response validation", () => {
  it.each(operations)("rejects missing or extra response fields for $name", async (operation) => {
    for (const response of [null, {}, { ...(operation.response as object), unexpected: true }]) {
      await expect(operation.invoke(adapterWith(response).adapter)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    }
  });

  it.each(pageOperations)(
    "enforces echoed pagination, counts, and unique identities for $name",
    async (operation) => {
      for (const response of [
        { ...pageOf(operation.item), page: 2 },
        { ...pageOf(operation.item), pageSize: 50 },
        { ...pageOf(operation.item), total: 0 },
        { ...pageOf(operation.item), total: -1 },
        { ...pageOf(operation.item), total: 1.5 },
        { ...pageOf(operation.item), items: [operation.item, operation.item], total: 2 },
        { ...pageOf(operation.item), items: [{ ...operation.item, unexpected: true }] },
        { ...pageOf(operation.item), nextCursor: "next" },
      ]) {
        await expect(operation.invoke(adapterWith(response).adapter)).rejects.toBeInstanceOf(
          ReviewControlProtocolError,
        );
      }
      await expect(
        operation.invoke(
          adapterWith({
            items: [
              operation.item,
              {
                ...operation.item,
                ...("id" in operation.item ? { id: "other" } : {}),
                ...("version" in operation.item ? { version: 2 } : {}),
                ...(["profiles", "profile bindings"].includes(operation.name)
                  ? { profileId: "other-profile" }
                  : {}),
              },
            ],
            total: 2,
            page: 1,
            pageSize: 1,
          }).adapter,
          { pageSize: 1 },
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        operation.invoke(adapterWith(pageOf(operation.item, 2, 20, 20)).adapter, { page: 2 }),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );

  it("rejects full content in summary lists and summaries in full-detail responses", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => adapterWith(pageOf(template)).adapter.listPrompts(),
      () => adapterWith(pageOf(promptVersion)).adapter.listPromptVersions(templateId),
      () => adapterWith(pageOf(profileVersion)).adapter.listProfiles(repositoryId),
      () =>
        adapterWith(pageOf(profileVersion)).adapter.listProfileVersions(repositoryId, profileId),
      () => adapterWith(templateSummary).adapter.getPrompt(templateId),
      () => adapterWith(promptVersionSummary).adapter.getPromptVersion(templateId, versionId),
      () =>
        adapterWith(profileSummary).adapter.getProfileVersion(
          repositoryId,
          profileId,
          profileVersionId,
        ),
    ];
    for (const call of calls)
      await expect(call()).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects templates or prompt versions from another requested identity or workflow", async () => {
    const otherTemplate = { ...template, id: "other-template" };
    await expect(adapterWith(otherTemplate).adapter.getPrompt(templateId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(
      adapterWith(otherTemplate).adapter.savePromptDraft(templateId, draftRequest),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const otherWorkflow = {
      ...template,
      workflowKind: "issue_triage",
      draftOutputSchemaVersion: "IssueTriageV2",
    };
    await expect(
      adapterWith(otherWorkflow).adapter.createPrompt(createPromptRequest),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const { draftContent: _draft, ...otherWorkflowSummary } = otherWorkflow;
    await expect(
      adapterWith(pageOf(otherWorkflowSummary)).adapter.listPrompts({ workflowKind }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith({ ...promptVersion, templateId: "other-template" }).adapter.publishPrompt(
        templateId,
        publishRequest,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(
        pageOf({ ...promptVersionSummary, templateId: "other-template" }),
      ).adapter.listPromptVersions(templateId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    for (const change of [{ templateId: "other-template" }, { id: "other-version" }]) {
      await expect(
        adapterWith({ ...promptVersion, ...change }).adapter.getPromptVersion(
          templateId,
          versionId,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
  });

  it("rejects prompt-binding scope, workflow, and duplicate workflow mismatches", async () => {
    for (const scope of [null, repositoryId]) {
      const binding = { ...promptBinding, repositoryId: scope };
      const history = { ...promptHistory, repositoryId: scope };
      const otherScope = scope === null ? repositoryId : null;
      await expect(
        adapterWith({
          items: [{ ...binding, repositoryId: otherScope }],
        }).adapter.listPromptBindings(scope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        adapterWith({ items: [binding, binding] }).adapter.listPromptBindings(scope),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      for (const change of [
        { repositoryId: otherScope },
        { repositoryId: "other-repo" },
        { workflowKind: "issue_triage" },
      ]) {
        await expect(
          adapterWith({ ...binding, ...change }).adapter.savePromptBinding(
            scope,
            workflowKind,
            savePromptBindingRequest,
          ),
        ).rejects.toBeInstanceOf(ReviewControlProtocolError);
        await expect(
          adapterWith(pageOf({ ...history, ...change })).adapter.listPromptBindingHistory(
            scope,
            workflowKind,
          ),
        ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      }
    }
  });

  it("rejects profile versions and bindings that escape repository or profile scope", async () => {
    await expect(
      adapterWith(pageOf({ ...profileSummary, repositoryId: "other-repo" })).adapter.listProfiles(
        repositoryId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    for (const change of [
      { repositoryId: "other-repo" },
      { workflowKind: "issue_triage", outputSchemaVersion: "IssueTriageV2" },
    ]) {
      await expect(
        adapterWith({ ...profileVersion, ...change }).adapter.publishProfile(
          repositoryId,
          createProfileRequest,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      adapterWith({ ...profileVersion, profileId: "other-profile" }).adapter.publishProfile(
        repositoryId,
        { ...createProfileRequest, profileId, expectedVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    for (const change of [{ repositoryId: "other-repo" }, { profileId: "other-profile" }]) {
      await expect(
        adapterWith(pageOf({ ...profileSummary, ...change })).adapter.listProfileVersions(
          repositoryId,
          profileId,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        adapterWith({ ...profileVersion, ...change }).adapter.getProfileVersion(
          repositoryId,
          profileId,
          profileVersionId,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        adapterWith({ ...profileBinding, ...change }).adapter.saveProfileBinding(
          repositoryId,
          profileId,
          saveProfileBindingRequest,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        adapterWith(pageOf({ ...profileHistory, ...change })).adapter.listProfileBindingHistory(
          repositoryId,
          profileId,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      adapterWith({ ...profileVersion, id: "other-version" }).adapter.getProfileVersion(
        repositoryId,
        profileId,
        profileVersionId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(
        pageOf({ ...profileBinding, repositoryId: "other-repo" }),
      ).adapter.listProfileBindings(repositoryId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { id: "history\n" },
    { previousVersionId: "version\n" },
    { previousVersionId: undefined },
    { createdAt: "yesterday" },
    { createdBy: "" },
    { createdBy: "operator\n" },
    { version: 0 },
    { previousVersionId: 1 },
    { id: undefined },
    { reason: "extra audit field" },
  ])("validates every binding-history field strictly: %j", async (change) => {
    await expect(
      adapterWith(pageOf({ ...globalHistory, ...change })).adapter.listPromptBindingHistory(
        null,
        workflowKind,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(pageOf({ ...promptHistory, ...change })).adapter.listPromptBindingHistory(
        repositoryId,
        workflowKind,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(pageOf({ ...profileHistory, ...change })).adapter.listProfileBindingHistory(
        repositoryId,
        profileId,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects a preview for a different work item", async () => {
    await expect(
      adapterWith({ ...preview, workItemId: "other-work-item" }).adapter.previewPrompt(
        previewRequest,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith(preview).adapter.previewPrompt({ content: "Review." }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("keeps preview response scope and shape unchanged when a workflow is supplied", async () => {
    const input: PromptPreviewRequest = { ...previewRequest, workflowKind };
    await expect(
      adapterWith({ ...preview, workflowKind }).adapter.previewPrompt(input),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith({ ...preview, workItemId: "other-work-item" }).adapter.previewPrompt(input),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("checks Unicode and UTF-8 limits again on full prompt responses", async () => {
    for (const content of ["\ud800", "\u754c".repeat(87_382)]) {
      await expect(
        adapterWith({ ...template, draftContent: content }).adapter.getPrompt(templateId),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
      await expect(
        adapterWith({ ...promptVersion, content }).adapter.getPromptVersion(templateId, versionId),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      adapterWith({ ...preview, renderedContent: "\ud800" }).adapter.previewPrompt(previewRequest),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects semantically invalid full profile responses", async () => {
    for (const badConfig of [
      { ...config, noProgressTimeoutMs: config.hardTimeoutMs + 1 },
      { ...config, setup: [commandStep], cleanup: [commandStep] },
      {
        ...config,
        build: [
          {
            ...commandStep,
            command: {
              ...commandStep.command,
              args: Array.from({ length: 11 }, () => "\u754c".repeat(8_192)),
            },
          },
        ],
      },
    ]) {
      await expect(
        adapterWith({ ...profileVersion, config: badConfig }).adapter.getProfileVersion(
          repositoryId,
          profileId,
          profileVersionId,
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      adapterWith({
        ...profileVersion,
        workflowKind: "issue_triage",
        outputSchemaVersion: "IssueTriageV2",
        config: { ...config, cleanup: [commandStep] },
      }).adapter.getProfileVersion(repositoryId, profileId, profileVersionId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});

describe("configuration HTTP path boundaries", () => {
  it.each([
    `https://elsewhere.example${promptPath}`,
    `//elsewhere.example${promptPath}`,
    `${promptPath}#fragment`,
    `${promptPath}/`,
    `${promptPath}?page=1`,
    `${promptsPath}/../worker-nodes`,
    `${promptsPath}/%2e%2e/worker-nodes`,
    `${promptsPath}\\${templateId}`,
    `${promptsPath}/${templateId}\n`,
    `${promptsPath}?page=01&pageSize=20`,
    `${promptsPath}?page=1&pageSize=51`,
    `${promptsPath}?page=1&pageSize=20&page=2`,
    `${promptsPath}?pageSize=20&page=1`,
    `${promptsPath}?page=1&pageSize=20&unknown=true`,
    `${promptsPath}?page=1&pageSize=20&workflowKind=unknown`,
    `${promptsPath}?page=1&pageSize=20&workflowKind=pr_static_build&workflowKind=pr_ui`,
    `${promptsPath}?page=${Number.MAX_SAFE_INTEGER}&pageSize=50`,
    `${promptPath}/versions${pagination}&workflowKind=pr_static_build`,
    `${profilesPath}${pagination}&workflowKind=pr_static_build`,
    `${profileBindingsPath}${pagination}&workflowKind=pr_static_build`,
    `${globalBindingsPath}${pagination}`,
    `${repositoryBindingsPath}?repositoryId=other`,
    `${globalBindingsPath}/unknown/history${pagination}`,
    `${globalBindingsPath}/${workflowKind}/history${pagination}&workflowKind=pr_static_build`,
    `${globalBindingsPath}/${workflowKind}`,
    `${profilePath}/versions/${profileVersionId}?page=1`,
    `${profileBindingsPath}/${profileId}`,
  ])("rejects noncanonical or unregistered GET routes: %s", async (path) => {
    const fetch = vi.fn();
    await expect(
      new DashboardHttpClient({ fetch }).get(path, "invalid configuration read"),
    ).rejects.toThrow("outside its allowlisted control-plane API");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["post", `${promptPath}/draft`],
    ["post", `${promptPath}/versions`],
    ["post", `${globalBindingsPath}/${workflowKind}`],
    ["post", `${profileBindingsPath}/${profileId}`],
    ["patch", promptsPath],
    ["patch", `${promptPath}/publish`],
    ["patch", `${repositoryBindingsPath}/${workflowKind}`],
    ["patch", profilesPath],
    ["put", promptPath],
    ["put", `${promptPath}/draft`],
    ["put", `${promptsPath}/preview`],
    ["put", globalBindingsPath],
    ["put", `${globalBindingsPath}/unknown`],
    ["put", `${globalBindingsPath}/${workflowKind}/history`],
    ["put", `${repositoryBindingsPath}/${workflowKind}?repositoryId=other`],
    ["put", `${profileBindingsPath}/${profileId}/history`],
    ["put", `/api/v1/operator/repositories/${repositoryId}`],
    ["put", "/api/v1/operator/worker-nodes"],
    [
      "put",
      "/api/v1/operator/worker-nodes/worker:11111111-1111-4111-8111-111111111111/token/rotate",
    ],
    ["put", "/api/v1/dashboard/jobs/job-1"],
  ] as const)("does not expand %s access to %s", async (method, path) => {
    const fetch = vi.fn();
    await expect(
      new DashboardHttpClient({ fetch })[method](path, "invalid configuration mutation", {}),
    ).rejects.toThrow("outside its allowlisted control-plane API");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["post", "patch", "put"] as const)(
    "limits the encoded JSON body to 2 MiB for %s before fetch",
    async (method) => {
      const fetch = vi.fn();
      const client = new DashboardHttpClient({ fetch });
      const path =
        method === "post"
          ? promptsPath
          : method === "patch"
            ? `${promptPath}/draft`
            : `${globalBindingsPath}/${workflowKind}`;
      expect(MAX_DASHBOARD_REQUEST_BYTES).toBe(2 * 1_024 * 1_024);
      for (const body of [
        { content: "a".repeat(MAX_DASHBOARD_REQUEST_BYTES) },
        { content: "\u754c".repeat(Math.ceil(MAX_DASHBOARD_REQUEST_BYTES / 3)) },
        { content: "\u0001".repeat(Math.ceil(MAX_DASHBOARD_REQUEST_BYTES / 6)) },
      ]) {
        await expect(
          client[method](path, "oversized configuration mutation", body),
        ).rejects.toBeInstanceOf(ReviewControlRequestError);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("configuration transport failures", () => {
  it.each([
    {
      status: 409,
      code: "platform_conflict",
      message: "Reload the configuration before saving.",
      retryable: false,
    },
    {
      status: 503,
      code: "prompt_preview_unavailable",
      message: "Preview is unavailable.",
      retryable: true,
    },
  ])(
    "preserves HTTP $status and the server error without substituting data",
    async ({ status, ...body }) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body, status));
      const adapter = new HttpConfigurationAdapter({ fetch });
      const call =
        status === 409
          ? adapter.publishPrompt(templateId, publishRequest)
          : adapter.previewPrompt(previewRequest);
      await expect(call).rejects.toBeInstanceOf(ReviewControlHttpError);
      await expect(call).rejects.toMatchObject({
        status,
        serverCode: body.code,
        retryable: body.retryable,
        message: body.message,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves network failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Offline"));
    await expect(new HttpConfigurationAdapter({ fetch }).listPrompts()).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts timed-out mutations and reports the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const adapter = new HttpConfigurationAdapter({ fetch, timeoutMs: 25 });
    const call = adapter.savePromptBinding(null, workflowKind, savePromptBindingRequest);
    const failure = expect(call).rejects.toBeInstanceOf(ReviewControlTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    await expect(call).rejects.toMatchObject({ timeoutMs: 25 });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["declared", "streamed"] as const)(
    "keeps the shared %s response-size limit",
    async (kind) => {
      const response = new Response(
        kind === "streamed" ? "x".repeat(MAX_DASHBOARD_RESPONSE_BYTES + 1) : "{}",
        {
          headers: {
            "content-type": "application/json",
            ...(kind === "declared"
              ? { "content-length": String(MAX_DASHBOARD_RESPONSE_BYTES + 1) }
              : {}),
          },
        },
      );
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(
        new HttpConfigurationAdapter({ fetch }).getPrompt(templateId),
      ).rejects.toBeInstanceOf(ReviewControlResponseTooLargeError);
    },
  );

  it.each([
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("not JSON", { headers: { "content-type": "application/json" } }),
    () =>
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { "content-type": "application/json" },
      }),
  ])("rejects invalid response encoding or format: case %#", async (makeResponse) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => makeResponse());
    await expect(
      new HttpConfigurationAdapter({ fetch }).getPrompt(templateId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each(["production", "test"])(
    "selects real HTTP in %s without a fixture fallback",
    async (environment) => {
      vi.resetModules();
      vi.stubEnv("NODE_ENV", environment);
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Offline"));
      vi.stubGlobal("fetch", fetch);
      const { configuration } = await import("./index");
      expect(configuration.constructor.name).toBe("HttpConfigurationAdapter");
      await expect(configuration.listPrompts()).rejects.toMatchObject({ code: "network_error" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("selects the fixture adapter only in development", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { configuration } = await import("./index");
    expect(configuration.constructor.name).toBe("MockConfigurationAdapter");
    expect(fetch).not.toHaveBeenCalled();
  });
});
