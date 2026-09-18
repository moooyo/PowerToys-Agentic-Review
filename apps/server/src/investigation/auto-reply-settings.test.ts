import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AutomaticReplyPolicy,
  type AutomaticReplySettingsUpdate,
  InvestigationAutomaticReplySettings,
} from "../../dist/investigation/auto-reply-settings.js";
import {
  automaticReplyTemplateVersion,
  defaultAutomaticReplyTemplates,
} from "../../dist/investigation/auto-reply-template.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";

const repository = { id: "repo-1", fullName: "fixture/project", githubRepositoryId: 101 };
const actor: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Fixture operator",
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "action:prepare", "action:execute"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: false,
};
const enabled: AutomaticReplySettingsUpdate = {
  version: 0,
  enabled: true,
  pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
  issueTemplate: defaultAutomaticReplyTemplates.issue,
};
const timestamp = "2026-09-16T10:00:00.000Z";
const now = () => new Date(timestamp);
const settingsKey = `auto-reply:settings:${repository.id}`;
const legacyTemplate = [
  "## Automated investigation",
  "{{assessment}}",
  "{{summary}}",
  "{{findings}}",
  "{{validation}}",
  "{{next_steps}}",
  "{{scope}}",
  "{{limitations}}",
].join("\n\n");
const legacyIdentityTemplate = [
  "{{identity}}",
  "## Conclusion\n\n{{conclusion}}",
  "## Summary\n\n{{summary}}",
  "## Findings\n\n{{findings}}",
  "{{details}}\n",
].join("\n\n");
const legacyTriageTemplate = [
  "{{identity}}",
  "## Triage conclusion\n\n{{conclusion}}",
  "## Summary\n\n{{summary}}",
  "## Next steps\n\n{{next_steps}}",
  "{{details}}\n",
].join("\n\n");
const stores: InvestigationStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function open(path?: string): InvestigationStore {
  const store = new InvestigationStore(path);
  stores.push(store);
  store.put("repositories", repository.id, repository);
  return store;
}

function expectError(operation: () => unknown, statusCode: number, code?: string): void {
  expect(operation).toThrow(
    expect.objectContaining({ statusCode, ...(code === undefined ? {} : { code }) }),
  );
}

describe("repository automatic reply settings", () => {
  it("defaults to disabled English templates and allows a scoped viewer without storing anything", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    expect(settings.read({ ...actor, permissions: [] }, repository.id)).toEqual({
      ...enabled,
      enabled: false,
      repositoryId: repository.id,
      publisherConfigured: false,
      authorizedById: null,
      updatedAt: null,
      templateVersion: automaticReplyTemplateVersion,
    });
    expect(settings.policy(repository.id)).toBeNull();
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires exact repository scope for reads and writes including administrators", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    for (const repositoryIds of [[], ["*"], ["repo-"], ["Repo-1"], ["repo-2"]]) {
      const denied = { ...actor, isAdmin: true, repositoryIds };
      expectError(() => settings.read(denied, repository.id), 403, "repository_forbidden");
      expectError(
        () => settings.update(denied, repository.id, enabled),
        403,
        "repository_forbidden",
      );
    }
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires repository management even when all publication permissions are present", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    const denied: InvestigationOperatorPrincipal = {
      ...actor,
      isAdmin: true,
      permissions: ["action:prepare", "action:execute"],
    };
    for (const active of [true, false])
      expectError(
        () => settings.update(denied, repository.id, { ...enabled, enabled: active }),
        403,
        "permission_denied",
      );
    expect(store.list("idempotency")).toEqual([]);
  });

  it("requires prepare, execute, and comment grants every time enabled settings are saved", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    for (const permission of ["action:prepare", "action:execute"] as const) {
      expectError(
        () =>
          settings.update(
            {
              ...actor,
              isAdmin: true,
              permissions: actor.permissions.filter((entry) => entry !== permission),
            },
            repository.id,
            enabled,
          ),
        403,
        "permission_denied",
      );
    }
    expectError(
      () =>
        settings.update(
          { ...actor, isAdmin: true, actionCapabilities: ["approve"] },
          repository.id,
          enabled,
        ),
      403,
      "permission_denied",
    );
    settings.update(actor, repository.id, enabled);
    expectError(
      () =>
        settings.update(
          { ...actor, permissions: ["repository:manage"], actionCapabilities: [] },
          repository.id,
          { ...enabled, version: 1 },
        ),
      403,
      "permission_denied",
    );
    expect(settings.read(actor, repository.id).version).toBe(1);
  });

  it("allows repository managers to edit disabled drafts and revoke an existing authorization", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    const manager: InvestigationOperatorPrincipal = {
      ...actor,
      id: "manager-1",
      permissions: ["repository:manage"],
      actionCapabilities: [],
    };
    const draft = enabled.pullRequestTemplate.replace("## Summary", "## Custom summary");
    expect(
      settings.update(manager, repository.id, {
        ...enabled,
        version: 1,
        enabled: false,
        pullRequestTemplate: draft,
      }),
    ).toMatchObject({
      enabled: false,
      version: 2,
      pullRequestTemplate: draft,
      authorizedById: null,
    });
    expect(settings.policy(repository.id)).toBeNull();
  });

  it("requires a valid registered repository without revealing out-of-scope registration", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    const scoped = { ...actor, repositoryIds: [...actor.repositoryIds, "missing"] };
    expectError(() => settings.read(scoped, "missing"), 404, "not_found");
    expectError(() => settings.update(scoped, "missing", enabled), 404, "not_found");
    expectError(() => settings.read(actor, "missing"), 403, "repository_forbidden");
    expectError(() => settings.update(actor, "missing", enabled), 403, "repository_forbidden");
    expectError(() => settings.read(actor, "repo-1 "), 400, "invalid_repository_id");
    expect(settings.policy("missing")).toBeNull();
  });

  it("saves complete identity and authorization with CAS but keeps the template format version fixed", () => {
    const store = open();
    const first = new InvestigationAutomaticReplySettings(store, true, now);
    const second = new InvestigationAutomaticReplySettings(store, true, now);
    const previous = second.read(actor, repository.id);
    const saved = first.update(actor, repository.id, enabled);
    expect(saved).toEqual({
      ...enabled,
      version: 1,
      repositoryId: repository.id,
      publisherConfigured: true,
      authorizedById: actor.id,
      updatedAt: timestamp,
      templateVersion: automaticReplyTemplateVersion,
    });
    expect(first.policy(repository.id)).toEqual({
      ...enabled,
      version: 1,
      repository,
      authorizedById: actor.id,
      updatedAt: timestamp,
      templateVersion: automaticReplyTemplateVersion,
    });
    expectError(
      () => second.update(actor, repository.id, { ...enabled, version: previous.version }),
      409,
      "auto_reply_settings_conflict",
    );
    expect(second.read(actor, repository.id)).toEqual(saved);
    const next = second.update(actor, repository.id, {
      ...enabled,
      version: 1,
      issueTemplate: enabled.issueTemplate.replace("## Triage result", "## Custom triage result"),
    });
    expect(next.version).toBe(2);
    expect(next.templateVersion).toBe(automaticReplyTemplateVersion);
    expect(store.list("idempotency")).toHaveLength(1);
  });

  it("rolls back failed persistence without leaving a partial authorization", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    const write = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce((collection, id, value) => {
      write(collection, id, value);
      throw new Error("Synthetic transaction failure");
    });
    expect(() => settings.update(actor, repository.id, enabled)).toThrow(
      "Synthetic transaction failure",
    );
    expect(settings.read(actor, repository.id).version).toBe(0);
    expect(settings.policy(repository.id)).toBeNull();
    expect(store.list("idempotency")).toEqual([]);
  });

  it("persists enabled and disabled templates across restarts without requiring deployed credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-reply-settings-"));
    directories.push(directory);
    const path = join(directory, "settings.sqlite");
    const firstStore = open(path);
    const first = new InvestigationAutomaticReplySettings(firstStore, false, now);
    const saved = first.update(actor, repository.id, enabled);
    expect(saved.publisherConfigured).toBe(false);
    firstStore.close();
    const secondStore = open(path);
    const second = new InvestigationAutomaticReplySettings(secondStore, true, now);
    expect(second.read(actor, repository.id)).toEqual({ ...saved, publisherConfigured: true });
    expect(second.policy(repository.id)?.authorizedById).toBe(actor.id);
    const draft = enabled.issueTemplate.replace("## Triage result", "## Draft triage result");
    second.update(actor, repository.id, {
      ...enabled,
      version: 1,
      enabled: false,
      issueTemplate: draft,
    });
    secondStore.close();
    const third = new InvestigationAutomaticReplySettings(open(path), false, now);
    expect(third.policy(repository.id)).toBeNull();
    expect(third.read(actor, repository.id)).toMatchObject({
      version: 2,
      enabled: false,
      issueTemplate: draft,
    });
  });

  it.each([
    { ...repository, fullName: "fixture/renamed" },
    { ...repository, fullName: "Fixture/project" },
    { ...repository, githubRepositoryId: 102 },
  ])("invalidates saved authorization when registered identity changes", (replacement) => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    store.put("repositories", repository.id, replacement);
    expect(settings.policy(repository.id)).toBeNull();
    expect(settings.read(actor, repository.id)).toMatchObject({
      version: 1,
      enabled: false,
      authorizedById: null,
    });
    expectError(
      () => settings.update(actor, repository.id, { ...enabled, version: 1 }),
      409,
      "auto_reply_repository_changed",
    );
    settings.update(actor, repository.id, { ...enabled, enabled: false, version: 1 });
    settings.update(actor, repository.id, { ...enabled, version: 2 });
    expect(settings.policy(repository.id)).toMatchObject({ version: 3, repository: replacement });
  });

  it("invalidates authorization atomically with registration so stale editors and restored names cannot reactivate it", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    const draft = enabled.pullRequestTemplate.replace("## Summary", "## Custom summary");
    const saved = settings.update(actor, repository.id, { ...enabled, pullRequestTemplate: draft });
    const renamed = { ...repository, fullName: "fixture/renamed" };
    store.transaction(() => {
      store.put("repositories", repository.id, renamed);
      settings.invalidateRepository(repository, renamed);
    });
    expect(settings.read(actor, repository.id)).toMatchObject({
      version: 2,
      enabled: false,
      authorizedById: null,
      pullRequestTemplate: draft,
    });
    expectError(
      () => settings.update(actor, repository.id, { ...enabled, version: saved.version }),
      409,
      "auto_reply_settings_conflict",
    );
    store.transaction(() => {
      store.put("repositories", repository.id, repository);
      settings.invalidateRepository(renamed, repository);
    });
    expect(settings.policy(repository.id)).toBeNull();
    expect(settings.read(actor, repository.id)).toMatchObject({
      version: 3,
      enabled: false,
      authorizedById: null,
    });
    settings.update(actor, repository.id, { ...enabled, version: 3 });
    expect(settings.policy(repository.id)).toMatchObject({
      version: 4,
      repository,
      authorizedById: actor.id,
    });
  });

  it("invalidates a version-zero editor after registration changes even before the first settings save", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    const previous = settings.read(actor, repository.id);
    const renamed = { ...repository, fullName: "fixture/renamed" };
    store.transaction(() => {
      store.put("repositories", repository.id, renamed);
      settings.invalidateRepository(repository, renamed);
    });
    expect(settings.read(actor, repository.id)).toMatchObject({
      version: 1,
      enabled: false,
      authorizedById: null,
      pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
      issueTemplate: defaultAutomaticReplyTemplates.issue,
    });
    expectError(
      () => settings.update(actor, repository.id, { ...enabled, version: previous.version }),
      409,
      "auto_reply_settings_conflict",
    );
    expect(settings.policy(repository.id)).toBeNull();
  });

  it("preserves same-identity registrations and rolls back invalidation with registration failures", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    const policy = settings.policy(repository.id);
    store.transaction(() => settings.invalidateRepository(repository, { ...repository }));
    expect(settings.policy(repository.id)).toEqual(policy);
    const renamed = { ...repository, fullName: "fixture/renamed" };
    expect(() =>
      store.transaction(() => {
        store.put("repositories", repository.id, renamed);
        settings.invalidateRepository(repository, renamed);
        throw new Error("Synthetic registration failure");
      }),
    ).toThrow("Synthetic registration failure");
    expect(store.get("repositories", repository.id)).toEqual(repository);
    expect(settings.policy(repository.id)).toEqual(policy);
  });

  it("does not resolve unregistered repositories or reuse settings under a new internal ID", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    store.delete("repositories", repository.id);
    expect(settings.policy(repository.id)).toBeNull();
    store.put("repositories", "repo-2", { ...repository, id: "repo-2" });
    expect(settings.policy("repo-2")).toBeNull();
  });

  it("fails closed for an unsupported template format until a current version is explicitly saved", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    const saved = store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!;
    store.put("idempotency", settingsKey, {
      ...saved,
      templateVersion: automaticReplyTemplateVersion + 1,
    });
    expect(settings.policy(repository.id)).toBeNull();
    expect(settings.read(actor, repository.id)).toMatchObject({
      enabled: false,
      version: 1,
      authorizedById: null,
    });
    settings.update(actor, repository.id, { ...enabled, version: 1 });
    expect(settings.policy(repository.id)?.templateVersion).toBe(automaticReplyTemplateVersion);
  });

  it.each([
    { templateVersion: 1, template: legacyTemplate },
    { templateVersion: 2, template: legacyIdentityTemplate },
    { templateVersion: 3, template: legacyIdentityTemplate, issueTemplate: legacyTriageTemplate },
  ])(
    "requires renewed authorization before replacing version $templateVersion templates with issue triage",
    ({ templateVersion, template, issueTemplate = template }) => {
      const store = open();
      const settings = new InvestigationAutomaticReplySettings(store, true, now);
      settings.update(actor, repository.id, enabled);
      const saved = store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!;
      store.put("idempotency", settingsKey, {
        ...saved,
        templateVersion,
        pullRequestTemplate: template,
        issueTemplate,
      });

      expect(automaticReplyTemplateVersion).toBe(4);
      expect(settings.policy(repository.id)).toBeNull();
      expect(settings.read(actor, repository.id)).toEqual({
        ...enabled,
        version: 1,
        enabled: false,
        repositoryId: repository.id,
        publisherConfigured: true,
        authorizedById: null,
        updatedAt: timestamp,
        templateVersion: 4,
      });
      expect(store.get<AutomaticReplyPolicy>("idempotency", settingsKey)).toMatchObject({
        templateVersion,
        pullRequestTemplate: template,
        issueTemplate,
      });
      expectError(
        () => settings.update(actor, repository.id, enabled),
        409,
        "auto_reply_settings_conflict",
      );
      const renewed = settings.update(actor, repository.id, { ...enabled, version: 1 });
      expect(renewed).toMatchObject({
        version: 2,
        enabled: true,
        templateVersion: 4,
        authorizedById: actor.id,
      });
      expect(settings.policy(repository.id)).toMatchObject({
        ...enabled,
        version: 2,
        templateVersion: 4,
        authorizedById: actor.id,
      });
    },
  );

  it.each([
    { templateVersion: 1, template: legacyTemplate },
    { templateVersion: 2, template: legacyIdentityTemplate },
    { templateVersion: 3, template: legacyIdentityTemplate, issueTemplate: legacyTriageTemplate },
  ])(
    "disables version $templateVersion authorization and replaces old templates atomically when a repository is renamed",
    ({ templateVersion, template, issueTemplate = template }) => {
      const store = open();
      const settings = new InvestigationAutomaticReplySettings(store, true, now);
      settings.update(actor, repository.id, enabled);
      const saved = store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!;
      store.put("idempotency", settingsKey, {
        ...saved,
        templateVersion,
        pullRequestTemplate: template,
        issueTemplate,
      });
      const renamed = { ...repository, fullName: "fixture/renamed" };
      store.transaction(() => {
        store.put("repositories", repository.id, renamed);
        settings.invalidateRepository(repository, renamed);
      });
      expect(settings.read(actor, repository.id)).toMatchObject({
        ...enabled,
        enabled: false,
        version: 2,
        templateVersion: 4,
        authorizedById: null,
      });
      expect(settings.policy(repository.id)).toBeNull();
      expect(store.get<AutomaticReplyPolicy>("idempotency", settingsKey)).toMatchObject({
        enabled: false,
        version: 2,
        templateVersion: 4,
        repository: renamed,
        pullRequestTemplate: defaultAutomaticReplyTemplates.pullRequest,
        issueTemplate: defaultAutomaticReplyTemplates.issue,
      });
    },
  );

  it("does not scan old reports or create publication work when authorization is enabled", () => {
    const store = open();
    const report = { id: "old-report", outcome: "completed" };
    store.put("reports", report.id, report);
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    expect(store.list("reports")).toEqual([report]);
    expect(store.list("tasks")).toEqual([]);
    expect(store.list("actionIntents")).toEqual([]);
    expect(store.list("idempotency")).toHaveLength(1);
    expect(Object.keys(settings.read(actor, repository.id)).sort()).toEqual([
      "authorizedById",
      "enabled",
      "issueTemplate",
      "publisherConfigured",
      "pullRequestTemplate",
      "repositoryId",
      "templateVersion",
      "updatedAt",
      "version",
    ]);
    expect(
      Object.keys(store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!).sort(),
    ).toEqual([
      "authorizedById",
      "enabled",
      "issueTemplate",
      "pullRequestTemplate",
      "repository",
      "templateVersion",
      "updatedAt",
      "version",
    ]);
  });

  it.each([
    null,
    [],
    {},
    { ...enabled, version: -1 },
    { ...enabled, version: 1.5 },
    { ...enabled, version: "0" },
    { ...enabled, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...enabled, enabled: "true" },
    { ...enabled, issueTemplate: 1 },
    { ...enabled, pullRequestTemplate: null },
    { ...enabled, repositoryId: "repo-2" },
    { ...enabled, authorizedById: "other-operator" },
    { ...enabled, publisherConfigured: true },
    { ...enabled, templateVersion: 2 },
    { ...enabled, secret: "untrusted-secret" },
  ])(
    "rejects malformed settings and caller-controlled authorization metadata without mutation",
    (request) => {
      const store = open();
      const settings = new InvestigationAutomaticReplySettings(store);
      expectError(
        () => settings.update(actor, repository.id, request as AutomaticReplySettingsUpdate),
        400,
        "invalid_auto_reply_settings",
      );
      expect(store.list("idempotency")).toEqual([]);
    },
  );

  it.each([
    { ...enabled, issueTemplate: "" },
    { ...enabled, pullRequestTemplate: "{{summary}}" },
    { ...enabled, issueTemplate: `${enabled.issueTemplate}\n{{unknown}}` },
    {
      ...enabled,
      issueTemplate: enabled.issueTemplate.replace(
        "{{next_steps}}",
        "{{summary}}\n\n{{next_steps}}",
      ),
    },
    { ...enabled, pullRequestTemplate: `${enabled.pullRequestTemplate}\n{{findings}}` },
    { ...enabled, pullRequestTemplate: enabled.issueTemplate },
    { ...enabled, issueTemplate: enabled.pullRequestTemplate },
    { ...enabled, enabled: false, issueTemplate: "invalid disabled draft" },
    { ...enabled, issueTemplate: `## Prefix\n\n${enabled.issueTemplate}` },
    { ...enabled, issueTemplate: `${enabled.issueTemplate}\n\nTrailing prose` },
    {
      ...enabled,
      issueTemplate: enabled.issueTemplate
        .replace("{{conclusion}}", "{{temporary}}")
        .replace("{{next_steps}}", "{{conclusion}}")
        .replace("{{temporary}}", "{{next_steps}}"),
    },
  ])("validates both enabled and disabled templates before saving", (request) => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store);
    expectError(
      () => settings.update(actor, repository.id, request),
      400,
      "automatic_reply_template_invalid",
    );
    expect(store.list("idempotency")).toEqual([]);
  });

  it("rejects invalid persisted policy records without falling back to an enabled default", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    const saved = store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!;
    for (const invalid of [
      null,
      { ...saved, version: 0 },
      { ...saved, repository: { ...repository, id: "repo-2" } },
      { ...saved, repository: { ...repository, githubRepositoryId: -1 } },
      { ...saved, authorizedById: null },
      { ...saved, updatedAt: "not-a-date" },
      { ...saved, templateVersion: 0 },
      { ...saved, issueTemplate: "{{summary}}" },
      { ...saved, publisherConfigured: true },
    ]) {
      store.put("idempotency", settingsKey, invalid);
      expectError(
        () => settings.read(actor, repository.id),
        500,
        "invalid_saved_auto_reply_settings",
      );
      expectError(() => settings.policy(repository.id), 500, "invalid_saved_auto_reply_settings");
    }
  });

  it("rejects exhausted versions and detaches returned identities from persisted authorization", () => {
    const store = open();
    const settings = new InvestigationAutomaticReplySettings(store, true, now);
    settings.update(actor, repository.id, enabled);
    const policy = settings.policy(repository.id)!;
    (policy.repository as { fullName: string }).fullName = "fixture/untrusted";
    expect(settings.policy(repository.id)?.repository).toEqual(repository);
    const saved = store.get<AutomaticReplyPolicy>("idempotency", settingsKey)!;
    store.put("idempotency", settingsKey, { ...saved, version: Number.MAX_SAFE_INTEGER });
    expectError(
      () => settings.update(actor, repository.id, { ...enabled, version: Number.MAX_SAFE_INTEGER }),
      409,
      "auto_reply_settings_version_exhausted",
    );
    expect(settings.read(actor, repository.id).version).toBe(Number.MAX_SAFE_INTEGER);
  });
});
