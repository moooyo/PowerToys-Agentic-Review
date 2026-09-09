import { createHash } from "node:crypto";
import {
  getValidationProfileConfigIssues,
  type PromptDraftSaveRequest,
  PromptPreviewResponseSchema,
  type PromptTemplateCreateRequest,
  PromptTemplateSchema,
  PromptTemplateSummarySchema,
  PromptVersionSchema,
  PromptVersionSummarySchema,
  type ValidationProfileConfig,
  type ValidationProfileCreateRequest,
  ValidationProfileVersionSchema,
  ValidationProfileVersionSummarySchema,
  type WorkflowKind,
  WorkflowKindValues,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ReviewControlHttpError, ReviewControlRequestError } from "../review-control/errors";
import type { ConfigurationPageQuery, PromptListQuery } from "./adapter";
import { MockConfigurationAdapter } from "./mock-adapter";

const timestamp = "2026-09-07T08:00:00.000Z";
const repositoryId = "repo-powertoys";
const otherRepositoryId = "repo-terminal";
const makeAdapter = () =>
  new MockConfigurationAdapter({ empty: true, now: () => new Date(timestamp) });
const promptRequest: PromptTemplateCreateRequest = {
  name: "Sample review",
  workflowKind: "pr_static_build",
  content: "Sample initial instructions.",
  outputSchemaVersion: "PrReviewPlanV2",
};
const makeConfig = (): ValidationProfileConfig => ({
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [
    {
      id: "build",
      name: "Sample build",
      command: {
        executable: "dotnet",
        args: ["build"],
        workingDirectory: ".",
        environment: [],
      },
      timeoutMs: 30_000,
      required: true,
    },
  ],
  test: [],
  launch: [],
  cleanup: [],
  requiredCapabilities: ["windows", "dotnet"],
  hardTimeoutMs: 60_000,
  noProgressTimeoutMs: 30_000,
});
const profileRequest = (): ValidationProfileCreateRequest => ({
  name: "Sample build profile",
  workflowKind: "pr_static_build",
  target: "headless",
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
  config: makeConfig(),
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function expectHttp(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ReviewControlHttpError);
  await expect(promise).rejects.toMatchObject({ status, retryable: false });
}

async function publishedPrompt(adapter: MockConfigurationAdapter) {
  const template = await adapter.createPrompt(promptRequest);
  const published = await adapter.publishPrompt(template.id, { expectedVersion: template.version });
  return { template, published };
}

describe("configuration sample data", () => {
  it("initializes four published workflow defaults and three explicit sample profiles", async () => {
    const adapter = new MockConfigurationAdapter({ now: () => new Date(timestamp) });
    const prompts = await adapter.listPrompts();
    expect(prompts).toMatchObject({ total: 4, page: 1, pageSize: 20 });
    expect(prompts.items.map((item) => item.workflowKind).sort()).toEqual(
      [...WorkflowKindValues].sort(),
    );
    for (const summary of prompts.items) {
      expect(Value.Check(PromptTemplateSummarySchema, summary)).toBe(true);
      expect(summary).not.toHaveProperty("draftContent");
      const template = await adapter.getPrompt(summary.id);
      expect(template).toMatchObject({ version: 2, draftRevision: 1 });
      expect(template.name).toContain("Sample");
      expect(template.draftContent).toContain("Sample");
      expect(Value.Check(PromptTemplateSchema, template)).toBe(true);
      const published = await adapter.getPromptVersion(
        template.id,
        template.latestPublishedVersionId ?? "missing",
      );
      expect(published.createdBy).toContain("Sample");
      expect(published.contentSha256).toBe(digest(published.content));
    }
    const defaults = await adapter.listPromptBindings(null);
    expect(Object.keys(defaults)).toEqual(["items"]);
    expect(defaults.items).toHaveLength(4);
    expect(defaults.items.every((item) => item.repositoryId === null && item.version === 1)).toBe(
      true,
    );
    expect(await adapter.listPromptBindings(repositoryId)).toEqual({ items: [] });
    expect(await adapter.listPromptBindings(otherRepositoryId)).toEqual({ items: [] });
    const profiles = await adapter.listProfiles(repositoryId);
    expect(profiles.total).toBe(3);
    expect(profiles.items.map((item) => item.target).sort()).toEqual([
      "headless",
      "web",
      "windows_desktop",
    ]);
    for (const summary of profiles.items) {
      expect(Value.Check(ValidationProfileVersionSummarySchema, summary)).toBe(true);
      expect(summary).not.toHaveProperty("config");
      const profile = await adapter.getProfileVersion(repositoryId, summary.profileId, summary.id);
      expect(Value.Check(ValidationProfileVersionSchema, profile)).toBe(true);
      expect(getValidationProfileConfigIssues(profile.config, profile.workflowKind)).toEqual([]);
      expect(profile.name).toContain("Sample");
      expect(profile.createdBy).toContain("Sample");
      expect(profile.configSha256).toBe(digest(canonicalJson(profile.config)));
    }
    expect((await adapter.listProfileBindings(repositoryId)).total).toBe(3);
    expect((await adapter.listProfiles(otherRepositoryId)).total).toBe(0);
  });

  it("keeps initialization and later state private to each adapter", async () => {
    const empty = makeAdapter();
    expect(await empty.listPrompts()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(await empty.listPromptBindings(null)).toEqual({ items: [] });
    expect((await empty.listProfiles(repositoryId)).items).toEqual([]);
    await empty.createPrompt(promptRequest);
    expect((await makeAdapter().listPrompts()).total).toBe(0);
    expect((await new MockConfigurationAdapter().listPrompts()).total).toBe(4);
  });
});

describe("sample prompt lifecycle", () => {
  it("preserves leading BOM bytes through creation, draft saves, publication and preview", async () => {
    const adapter = makeAdapter();
    const initialContent = "\uFEFFSample initial instructions.\r\nPreserve this line ending.";
    const savedContent = "\uFEFFSample revised instructions.\r\nKeep the leading BOM.";
    const created = await adapter.createPrompt({ ...promptRequest, content: initialContent });
    expect(created.draftContent).toBe(initialContent);
    expect((await adapter.getPrompt(created.id)).draftContent).toBe(initialContent);
    const initialVersion = await adapter.publishPrompt(created.id, { expectedVersion: 1 });
    expect(Buffer.from(initialVersion.content, "utf8")).toEqual(
      Buffer.from(initialContent, "utf8"),
    );
    expect(initialVersion.contentSha256).toBe(digest(initialContent));
    expect(initialVersion.contentSha256).not.toBe(digest(initialContent.slice(1)));

    const saved = await adapter.savePromptDraft(created.id, {
      expectedVersion: 2,
      content: savedContent,
      outputSchemaVersion: "PrReviewPlanV2",
    });
    expect(saved.draftContent).toBe(savedContent);
    const savedVersion = await adapter.publishPrompt(created.id, { expectedVersion: 3 });
    expect(Buffer.from(savedVersion.content, "utf8")).toEqual(Buffer.from(savedContent, "utf8"));
    expect(savedVersion.contentSha256).toBe(digest(savedContent));
    expect(savedVersion.contentSha256).not.toBe(digest(savedContent.slice(1)));
    expect(await adapter.getPromptVersion(created.id, initialVersion.id)).toEqual(initialVersion);
    expect(await adapter.getPromptVersion(created.id, savedVersion.id)).toEqual(savedVersion);

    const preview = await adapter.previewPrompt({ content: savedContent });
    expect(preview.renderedContent).toBe(
      `Sample prompt preview. No model, validation command, or GitHub request was executed.\n\n${savedContent}`,
    );
    expect(preview.contentSha256).toBe(digest(preview.renderedContent));
    expect(preview.contentSha256).not.toBe(digest(preview.renderedContent.replace("\uFEFF", "")));
  });

  it("keeps drafts separate from immutable publications and advances the correct revisions", async () => {
    const adapter = makeAdapter();
    const created = await adapter.createPrompt(promptRequest);
    expect(created).toMatchObject({
      version: 1,
      draftRevision: 1,
      latestPublishedVersionId: null,
      description: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(await adapter.listPromptVersions(created.id)).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    const draft = await adapter.savePromptDraft(created.id, {
      expectedVersion: 1,
      content: "hello",
      outputSchemaVersion: "PrReviewPlanV2",
    });
    expect(draft).toMatchObject({ version: 2, draftRevision: 2, draftContent: "hello" });
    const published = await adapter.publishPrompt(created.id, { expectedVersion: 2 });
    expect(Value.Check(PromptVersionSchema, published)).toBe(true);
    expect(published).toMatchObject({
      version: 1,
      content: "hello",
      createdAt: timestamp,
      publishedAt: timestamp,
    });
    expect(published.contentSha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(await adapter.getPrompt(created.id)).toMatchObject({
      version: 3,
      draftRevision: 2,
      latestPublishedVersionId: published.id,
    });
    await adapter.savePromptDraft(created.id, {
      expectedVersion: 3,
      content: "Sample changed instructions.",
      outputSchemaVersion: "PrReviewPlanV2",
    });
    const second = await adapter.publishPrompt(created.id, { expectedVersion: 4 });
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(published.id);
    expect(await adapter.getPromptVersion(created.id, published.id)).toEqual(published);
    const versions = await adapter.listPromptVersions(created.id, { pageSize: 1 });
    expect(versions).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(versions.items[0]).toMatchObject({ id: second.id, version: 2 });
    expect(versions.items[0]).not.toHaveProperty("content");
    expect(Value.Check(PromptVersionSummarySchema, versions.items[0])).toBe(true);
    expect(
      (await adapter.listPromptVersions(created.id, { page: 2, pageSize: 1 })).items[0]?.id,
    ).toBe(published.id);
  });

  it("records a scoped binding, upgrade, rollback, and same-version save as separate history entries", async () => {
    const adapter = makeAdapter();
    const { template, published } = await publishedPrompt(adapter);
    const second = await adapter.publishPrompt(template.id, { expectedVersion: 2 });
    await adapter.savePromptBinding(null, "pr_static_build", {
      expectedVersion: 0,
      promptVersionId: published.id,
    });
    const firstBinding = await adapter.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 0,
      promptVersionId: published.id,
    });
    expect(firstBinding.version).toBe(1);
    await adapter.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 1,
      promptVersionId: second.id,
    });
    const rollback = await adapter.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 2,
      promptVersionId: published.id,
    });
    expect(rollback.version).toBe(3);
    await adapter.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 3,
      promptVersionId: published.id,
    });
    const history = await adapter.listPromptBindingHistory(repositoryId, "pr_static_build");
    expect(
      history.items.map((entry) => [entry.version, entry.promptVersionId, entry.previousVersionId]),
    ).toEqual([
      [4, published.id, published.id],
      [3, published.id, second.id],
      [2, second.id, published.id],
      [1, published.id, null],
    ]);
    expect(new Set(history.items.map((entry) => entry.id)).size).toBe(4);
    expect(
      history.items.every(
        (entry) => entry.createdBy.includes("Sample") && entry.createdAt === timestamp,
      ),
    ).toBe(true);
    expect((await adapter.listPromptBindingHistory(null, "pr_static_build")).total).toBe(1);
    expect(
      (await adapter.listPromptBindingHistory(otherRepositoryId, "pr_static_build")).total,
    ).toBe(0);
    expect((await adapter.listPromptBindingHistory(repositoryId, "issue_triage")).total).toBe(0);
    expect((await adapter.listPromptBindings(null)).items[0]?.version).toBe(1);
    expect((await adapter.listPromptBindings(repositoryId)).items[0]?.version).toBe(4);
  });

  it("rejects stale writes and mismatched workflows without changing drafts, bindings, or history", async () => {
    const adapter = makeAdapter();
    const { template, published } = await publishedPrompt(adapter);
    const before = await adapter.getPrompt(template.id);
    await expectHttp(adapter.publishPrompt(template.id, { expectedVersion: 1 }), 409);
    await expectHttp(
      adapter.savePromptDraft(template.id, {
        expectedVersion: 1,
        content: "Stale draft",
        outputSchemaVersion: "PrReviewPlanV2",
      }),
      409,
    );
    await expectHttp(
      adapter.savePromptDraft(template.id, {
        expectedVersion: 2,
        content: "Wrong workflow",
        outputSchemaVersion: "IssueTriageV2",
      }),
      400,
    );
    await expectHttp(
      adapter.savePromptBinding(repositoryId, "issue_triage", {
        expectedVersion: 0,
        promptVersionId: published.id,
      }),
      400,
    );
    await expectHttp(
      adapter.savePromptBinding(repositoryId, "pr_static_build", {
        expectedVersion: 1,
        promptVersionId: published.id,
      }),
      409,
    );
    await expectHttp(
      adapter.savePromptBinding(null, "pr_static_build", {
        expectedVersion: 0,
        promptVersionId: "unknown-version",
      }),
      404,
    );
    expect(await adapter.getPrompt(template.id)).toEqual(before);
    expect((await adapter.listPromptVersions(template.id)).total).toBe(1);
    expect(await adapter.listPromptBindings(repositoryId)).toEqual({ items: [] });
    expect((await adapter.listPromptBindingHistory(repositoryId, "pr_static_build")).total).toBe(0);
    const valid = await adapter.savePromptBinding(repositoryId, "pr_static_build", {
      expectedVersion: 0,
      promptVersionId: published.id,
    });
    await expectHttp(
      adapter.savePromptBinding(repositoryId, "pr_static_build", {
        expectedVersion: 0,
        promptVersionId: published.id,
      }),
      409,
    );
    expect((await adapter.listPromptBindings(repositoryId)).items).toEqual([valid]);
    expect((await adapter.listPromptBindingHistory(repositoryId, "pr_static_build")).total).toBe(1);
  });

  it("serializes asynchronous publications against concurrent publication and draft updates", async () => {
    const adapter = makeAdapter();
    const created = await adapter.createPrompt(promptRequest);
    const results = await Promise.allSettled([
      adapter.publishPrompt(created.id, { expectedVersion: 1 }),
      adapter.publishPrompt(created.id, { expectedVersion: 1 }),
      adapter.savePromptDraft(created.id, {
        expectedVersion: 1,
        content: "Concurrent update",
        outputSchemaVersion: "PrReviewPlanV2",
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    for (const result of results.slice(1)) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    }
    expect((await adapter.listPromptVersions(created.id)).total).toBe(1);
    expect(await adapter.getPrompt(created.id)).toMatchObject({
      version: 2,
      draftRevision: 1,
      draftContent: promptRequest.content,
    });
    await expect(
      adapter.savePromptDraft(created.id, {
        expectedVersion: 2,
        content: "Recovered update",
        outputSchemaVersion: "PrReviewPlanV2",
      }),
    ).resolves.toMatchObject({ version: 3 });
  });
});

describe("sample validation profile lifecycle", () => {
  it("publishes immutable versions with canonical hashes and lists only the latest version per profile", async () => {
    const adapter = makeAdapter();
    const request = profileRequest();
    const first = await adapter.publishProfile(repositoryId, request);
    expect(first).toMatchObject({ version: 1, createdAt: timestamp, publishedAt: timestamp });
    expect(first.configSha256).toBe(digest(canonicalJson(request.config)));
    const sameContent = await adapter.publishProfile(repositoryId, {
      ...request,
      profileId: first.profileId,
      expectedVersion: 1,
      name: "Sample renamed profile",
      required: false,
      config: Object.fromEntries(
        Object.entries(request.config).reverse(),
      ) as ValidationProfileConfig,
    });
    expect(sameContent.configSha256).toBe(first.configSha256);
    expect(sameContent).toMatchObject({ version: 2, profileId: first.profileId, required: false });
    const list = await adapter.listProfiles(repositoryId);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: sameContent.id, version: 2 });
    expect(list.items[0]).not.toHaveProperty("config");
    expect(
      (await adapter.listProfileVersions(repositoryId, first.profileId)).items.map(
        (version) => version.version,
      ),
    ).toEqual([2, 1]);
    expect(await adapter.getProfileVersion(repositoryId, first.profileId, first.id)).toEqual(first);
    expect(
      (await adapter.listProfileVersions(repositoryId, first.profileId, { page: 2, pageSize: 1 }))
        .items[0]?.id,
    ).toBe(first.id);
    expect((await adapter.listProfiles(otherRepositoryId)).total).toBe(0);
  });

  it("supports profile binding, disabled rollback and immutable history", async () => {
    const adapter = makeAdapter();
    const first = await adapter.publishProfile(repositoryId, profileRequest());
    const second = await adapter.publishProfile(repositoryId, {
      ...profileRequest(),
      profileId: first.profileId,
      expectedVersion: 1,
    });
    await adapter.saveProfileBinding(repositoryId, first.profileId, {
      expectedVersion: 0,
      profileVersionId: first.id,
      enabled: true,
    });
    await adapter.saveProfileBinding(repositoryId, first.profileId, {
      expectedVersion: 1,
      profileVersionId: second.id,
      enabled: true,
    });
    const rollback = await adapter.saveProfileBinding(repositoryId, first.profileId, {
      expectedVersion: 2,
      profileVersionId: first.id,
      enabled: false,
    });
    expect(rollback).toMatchObject({ version: 3, enabled: false });
    await adapter.saveProfileBinding(repositoryId, first.profileId, {
      expectedVersion: 3,
      profileVersionId: first.id,
      enabled: true,
    });
    expect(
      (await adapter.listProfileBindingHistory(repositoryId, first.profileId)).items.map(
        (entry) => [entry.version, entry.profileVersionId, entry.previousVersionId, entry.enabled],
      ),
    ).toEqual([
      [4, first.id, first.id, true],
      [3, first.id, second.id, false],
      [2, second.id, first.id, true],
      [1, first.id, null, true],
    ]);
    expect((await adapter.listProfileBindings(repositoryId)).items[0]).toMatchObject({
      version: 4,
      profileVersionId: first.id,
      enabled: true,
    });
    expect((await adapter.listProfileBindings(otherRepositoryId)).items).toEqual([]);
    const page = await adapter.listProfileBindingHistory(repositoryId, first.profileId, {
      page: 2,
      pageSize: 2,
    });
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.items.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("rejects repository, workflow, target, and bound-version mismatches without side effects", async () => {
    const adapter = makeAdapter();
    const first = await adapter.publishProfile(repositoryId, profileRequest());
    const other = await adapter.publishProfile(repositoryId, profileRequest());
    await expectHttp(
      adapter.publishProfile(otherRepositoryId, {
        ...profileRequest(),
        profileId: first.profileId,
        expectedVersion: 1,
      }),
      400,
    );
    await expectHttp(
      adapter.publishProfile(repositoryId, {
        name: "Sample different workflow",
        workflowKind: "pr_ui",
        target: "web",
        outputSchemaVersion: "ValidationReportV1",
        required: false,
        config: makeConfig(),
        profileId: first.profileId,
        expectedVersion: 1,
      }),
      400,
    );
    const web = await adapter.publishProfile(repositoryId, {
      name: "Sample UI profile",
      workflowKind: "pr_ui",
      target: "web",
      outputSchemaVersion: "ValidationReportV1",
      required: false,
      config: makeConfig(),
    });
    await expectHttp(
      adapter.publishProfile(repositoryId, {
        name: "Sample target change",
        workflowKind: "pr_ui",
        target: "windows_desktop",
        outputSchemaVersion: "ValidationReportV1",
        required: false,
        config: makeConfig(),
        profileId: web.profileId,
        expectedVersion: 1,
      }),
      400,
    );
    await expectHttp(
      adapter.saveProfileBinding(repositoryId, first.profileId, {
        expectedVersion: 0,
        profileVersionId: other.id,
        enabled: true,
      }),
      400,
    );
    await expectHttp(
      adapter.saveProfileBinding(otherRepositoryId, first.profileId, {
        expectedVersion: 0,
        profileVersionId: first.id,
        enabled: true,
      }),
      400,
    );
    await expectHttp(
      adapter.saveProfileBinding(repositoryId, first.profileId, {
        expectedVersion: 1,
        profileVersionId: first.id,
        enabled: true,
      }),
      409,
    );
    await expectHttp(
      adapter.saveProfileBinding(repositoryId, first.profileId, {
        expectedVersion: 0,
        profileVersionId: "unknown-version",
        enabled: true,
      }),
      404,
    );
    expect((await adapter.listProfileVersions(repositoryId, first.profileId)).total).toBe(1);
    expect((await adapter.listProfileBindings(repositoryId)).total).toBe(0);
    expect((await adapter.listProfileBindingHistory(repositoryId, first.profileId)).total).toBe(0);
  });

  it("permits only one concurrent publication and binding update for an expected version", async () => {
    const adapter = makeAdapter();
    const first = await adapter.publishProfile(repositoryId, profileRequest());
    const next = { ...profileRequest(), profileId: first.profileId, expectedVersion: 1 };
    const published = await Promise.allSettled([
      adapter.publishProfile(repositoryId, next),
      adapter.publishProfile(repositoryId, next),
    ]);
    expect(published.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    if (published[1]?.status === "rejected")
      expect(published[1].reason).toMatchObject({ status: 409 });
    expect((await adapter.listProfileVersions(repositoryId, first.profileId)).total).toBe(2);
    const binding = { expectedVersion: 0, profileVersionId: first.id, enabled: true };
    const bound = await Promise.allSettled([
      adapter.saveProfileBinding(repositoryId, first.profileId, binding),
      adapter.saveProfileBinding(repositoryId, first.profileId, binding),
    ]);
    expect(bound.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await adapter.listProfileBindingHistory(repositoryId, first.profileId)).total).toBe(1);
  });
});

describe("sample configuration boundaries", () => {
  it("returns 404 for missing entities and 400 for an existing profile in another scope", async () => {
    const adapter = makeAdapter();
    const { template, published } = await publishedPrompt(adapter);
    const other = await adapter.createPrompt(promptRequest);
    const profile = await adapter.publishProfile(repositoryId, profileRequest());
    const secondProfile = await adapter.publishProfile(repositoryId, profileRequest());
    const missing = [
      adapter.getPrompt("missing"),
      adapter.listPromptVersions("missing"),
      adapter.getPromptVersion(template.id, "missing"),
      adapter.getPromptVersion(other.id, published.id),
      adapter.publishPrompt("missing", { expectedVersion: 1 }),
      adapter.savePromptDraft("missing", {
        expectedVersion: 1,
        content: "Sample",
        outputSchemaVersion: "PrReviewPlanV2",
      }),
      adapter.listPromptBindings("repo-missing"),
      adapter.listPromptBindingHistory("repo-missing", "pr_ui"),
      adapter.listProfiles("repo-missing"),
      adapter.publishProfile("repo-missing", profileRequest()),
      adapter.listProfileVersions(repositoryId, "missing"),
      adapter.listProfileBindings("repo-missing"),
      adapter.getProfileVersion(repositoryId, profile.profileId, "missing"),
      adapter.getProfileVersion(repositoryId, secondProfile.profileId, profile.id),
      adapter.listProfileBindingHistory(repositoryId, "missing"),
      adapter.saveProfileBinding(repositoryId, "missing", {
        expectedVersion: 0,
        profileVersionId: profile.id,
        enabled: true,
      }),
    ];
    await Promise.all(missing.map((promise) => expectHttp(promise, 404)));
    await expectHttp(adapter.listProfileVersions(otherRepositoryId, profile.profileId), 400);
    await expectHttp(
      adapter.getProfileVersion(otherRepositoryId, profile.profileId, profile.id),
      400,
    );
    await expectHttp(adapter.listProfileBindingHistory(otherRepositoryId, profile.profileId), 400);
  });

  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { pageSize: Number.NaN },
    { page: undefined },
    { pageSize: "20" },
    { unknown: true },
  ])("rejects invalid pagination %j", async (query) => {
    await expect(makeAdapter().listPrompts(query as ConfigurationPageQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
  });

  it("filters before pagination and keeps ordering stable when timestamps tie", async () => {
    const adapter = makeAdapter();
    await Promise.all(
      Array.from({ length: 23 }, (_, index) =>
        adapter.createPrompt({ ...promptRequest, name: `Sample ${index}` }),
      ),
    );
    await adapter.createPrompt({
      name: "Sample triage",
      workflowKind: "issue_triage",
      content: "Sample triage instructions",
      outputSchemaVersion: "IssueTriageV2",
    });
    const first = await adapter.listPrompts({ workflowKind: "pr_static_build" });
    const second = await adapter.listPrompts({ workflowKind: "pr_static_build", page: 2 });
    expect(first).toMatchObject({ total: 23, page: 1, pageSize: 20 });
    expect(second.items).toHaveLength(3);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
    expect(new Set(ids).size).toBe(23);
    expect((await adapter.listPrompts({ page: 3, pageSize: 20 })).items).toEqual([]);
    expect((await adapter.listPrompts({ pageSize: 50 })).items).toHaveLength(24);
    expect((await adapter.listPrompts({ workflowKind: "issue_triage" })).total).toBe(1);
    await expect(
      adapter.listPrompts({ workflowKind: "pr_review" } as unknown as PromptListQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const item = first.items[0];
    expect(item).toBeDefined();
    await expect(
      adapter.listPromptVersions(item?.id ?? "missing", {
        workflowKind: "pr_ui",
      } as ConfigurationPageQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
  });

  it.each(["", " ", "a\0b", "\uD800", "x".repeat(262_145), "\u754c".repeat(90_000)])(
    "rejects invalid prompt content at all input boundaries",
    async (content) => {
      const adapter = makeAdapter();
      const template = await adapter.createPrompt(promptRequest);
      await expect(adapter.createPrompt({ ...promptRequest, content })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(
        adapter.savePromptDraft(template.id, {
          expectedVersion: 1,
          content,
          outputSchemaVersion: "PrReviewPlanV2",
        }),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      await expect(adapter.previewPrompt({ content })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect((await adapter.listPrompts()).total).toBe(1);
      expect((await adapter.getPrompt(template.id)).version).toBe(1);
    },
  );

  it("rejects forged fields, malformed IDs and invalid profile configuration", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.createPrompt({
        ...promptRequest,
        createdBy: "forged",
      } as PromptTemplateCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.createPrompt({ ...promptRequest, name: "bad\uD800" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.getPrompt("id\n")).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.listPromptBindings(undefined as unknown as string)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.listProfiles(null as unknown as string)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(
      adapter.listPromptBindingHistory(null, "pr_review" as WorkflowKind),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.publishProfile(repositoryId, {
        ...profileRequest(),
        expectedVersion: 1,
      } as ValidationProfileCreateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const config = makeConfig();
    config.noProgressTimeoutMs = config.hardTimeoutMs + 1;
    await expect(
      adapter.publishProfile(repositoryId, { ...profileRequest(), config }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const duplicate = makeConfig();
    duplicate.test = structuredClone(duplicate.build);
    await expect(
      adapter.publishProfile(repositoryId, { ...profileRequest(), config: duplicate }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const secret = makeConfig();
    const step = secret.build[0];
    if (!step) throw new Error("The test requires a build step.");
    step.command.environment = [{ name: "API_TOKEN", value: "sample" }];
    await expect(
      adapter.publishProfile(repositoryId, { ...profileRequest(), config: secret }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      adapter.publishProfile(repositoryId, {
        name: "Sample triage",
        workflowKind: "issue_triage",
        target: "headless",
        outputSchemaVersion: "IssueTriageV2",
        required: false,
        config: makeConfig(),
      }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect((await adapter.listProfiles(repositoryId)).total).toBe(0);
  });

  it("isolates in-flight inputs, returned records, nested configurations and histories", async () => {
    const adapter = makeAdapter();
    const request = structuredClone(promptRequest);
    const creating = adapter.createPrompt(request);
    request.content = "Mutated input";
    const template = await creating;
    expect(template.draftContent).toBe(promptRequest.content);
    template.draftContent = "Mutated output";
    expect((await adapter.getPrompt(template.id)).draftContent).toBe(promptRequest.content);
    const save: PromptDraftSaveRequest = {
      expectedVersion: 1,
      content: "Saved snapshot",
      outputSchemaVersion: "PrReviewPlanV2",
    };
    const saving = adapter.savePromptDraft(template.id, save);
    save.content = "Changed after call";
    await saving;
    const publication = await adapter.publishPrompt(template.id, { expectedVersion: 2 });
    publication.content = "Mutated publication";
    expect((await adapter.getPromptVersion(template.id, publication.id)).content).toBe(
      "Saved snapshot",
    );
    const binding = await adapter.savePromptBinding(null, "pr_static_build", {
      expectedVersion: 0,
      promptVersionId: publication.id,
    });
    binding.promptVersionId = "forged";
    const history = await adapter.listPromptBindingHistory(null, "pr_static_build");
    const entry = history.items[0];
    if (!entry) throw new Error("The test requires binding history.");
    entry.promptVersionId = "forged";
    expect((await adapter.listPromptBindings(null)).items[0]?.promptVersionId).toBe(publication.id);
    expect(
      (await adapter.listPromptBindingHistory(null, "pr_static_build")).items[0]?.promptVersionId,
    ).toBe(publication.id);
    const profileInput = profileRequest();
    const publishing = adapter.publishProfile(repositoryId, profileInput);
    profileInput.config.requiredCapabilities.push("forged");
    const profile = await publishing;
    expect(profile.config.requiredCapabilities).toEqual(["windows", "dotnet"]);
    profile.config.requiredCapabilities.push("mutated");
    expect(
      (await adapter.getProfileVersion(repositoryId, profile.profileId, profile.id)).config
        .requiredCapabilities,
    ).toEqual(["windows", "dotnet"]);
    const summaries = await adapter.listProfiles(repositoryId);
    const summary = summaries.items[0];
    if (!summary) throw new Error("The test requires a profile summary.");
    summary.name = "Changed externally";
    expect((await adapter.listProfiles(repositoryId)).items[0]?.name).toBe("Sample build profile");
  });
});

describe("sample prompt preview", () => {
  it.each(WorkflowKindValues)(
    "keeps %s preview context within the workflow's work-item kind",
    async (workflowKind) => {
      const adapter = makeAdapter();
      const isPullRequest = workflowKind === "pr_static_build" || workflowKind === "pr_ui";
      const workItemId = isPullRequest ? "wi-pr-41982" : "wi-issue-41876";
      const otherKindId = isPullRequest ? "wi-issue-41876" : "wi-pr-41982";
      const preview = await adapter.previewPrompt({
        content: "Sample workflow instructions",
        workflowKind,
        workItemId,
      });
      expect(preview).toMatchObject({ workItemId, repositoryId });
      expect(preview.renderedContent).toContain(`Sample workflow: ${workflowKind}`);
      expect(preview.contentSha256).toBe(digest(preview.renderedContent));
      await expectHttp(
        adapter.previewPrompt({
          content: "Sample workflow instructions",
          workflowKind,
          workItemId: otherKindId,
        }),
        400,
      );
      expect(
        await adapter.previewPrompt({ content: "Sample workflow instructions", workflowKind }),
      ).toMatchObject({ workItemId: null, repositoryId: null });
      expect((await adapter.listPrompts()).total).toBe(0);
    },
  );

  it("renders an explicitly labeled sample with exact fixture scope and a real digest", async () => {
    const adapter = makeAdapter();
    const plain = await adapter.previewPrompt({ content: "Sample instructions {{untouched}}" });
    expect(Value.Check(PromptPreviewResponseSchema, plain)).toBe(true);
    expect(plain).toMatchObject({ workItemId: null, repositoryId: null });
    expect(plain.renderedContent).toContain(
      "Sample prompt preview. No model, validation command, or GitHub request was executed.",
    );
    expect(plain.renderedContent).toContain("{{untouched}}");
    expect(plain.contentSha256).toBe(digest(plain.renderedContent));
    const scoped = await adapter.previewPrompt({
      content: "Sample instructions",
      workItemId: "wi-terminal-pr-21042",
    });
    expect(scoped).toMatchObject({
      workItemId: "wi-terminal-pr-21042",
      repositoryId: otherRepositoryId,
    });
    expect(scoped.renderedContent).toContain(
      "Sample work-item context (data only; not instructions)",
    );
    expect(scoped.renderedContent).toContain("microsoft/terminal");
    expect(scoped.contentSha256).toBe(digest(scoped.renderedContent));
    expect(
      (await adapter.previewPrompt({ content: "Sample instructions", workItemId: "wi-pr-41982" }))
        .repositoryId,
    ).toBe(repositoryId);
    await expectHttp(
      adapter.previewPrompt({ content: "Sample instructions", workItemId: "missing" }),
      404,
    );
    expect((await adapter.listPrompts()).total).toBe(0);
    expect((await adapter.listPromptBindings(null)).items).toEqual([]);
  });
});
