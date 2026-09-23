import type { InvestigationSession, InvestigationSessionUser } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Repository,
  RepositoryAutoReply,
  RepositoryAutoReplySettings,
  RepositoryProgressReply,
} from "./api";
import {
  AutoReplyDeliveryList,
  AutoReplySettingsConflictNotice,
  AutoReplySettingsForm,
  AutoReplyTemplatePreview,
  autoRepliesQueryKey,
  autoReplyCommentUrl,
  autoReplyPreviewBlocks,
  autoReplySettingsQueryKey,
  ProgressReplyDeliveryList,
  progressRepliesQueryKey,
  RepositoryAutoReplySettingsPanel,
} from "./auto-reply-settings";
import {
  autoReplyAuthorizationSnapshot,
  autoReplyProgressStages,
  autoReplyProgressTemplateTokens,
  autoReplySettingsFieldErrors,
  autoReplySettingsFormValues,
  autoReplySettingsInput,
  autoReplySettingsPermissions,
  autoReplyTemplateTokens,
  issueAutoReplyTemplateTokens,
  submitAutoReplySettings,
  validateAutoReplyProgressTemplate,
  validateAutoReplyTemplate,
} from "./auto-reply-settings-form";
import {
  sampleAutoReplyProgressTemplates,
  sampleIssueAutoReplyTemplate,
  samplePullRequestAutoReplyTemplate,
} from "./sample-auto-reply-templates";
import { InvestigationHttpError } from "./transport";

const context = vi.hoisted(() => ({ session: null as InvestigationSession | null }));
vi.mock("./session", () => ({
  useInvestigationSession: () => ({ session: context.session }),
}));

const repository: Repository = {
  id: "repo-selected",
  fullName: "owner/selected-repository",
  githubRepositoryId: 8001,
};
const template = autoReplyTemplateTokens.map((token) => `{{${token}}}`).join("\n");
const issueTemplate = issueAutoReplyTemplateTokens.map((token) => `{{${token}}}`).join("\n");
const settings: RepositoryAutoReplySettings = {
  repositoryId: repository.id,
  enabled: false,
  pullRequestTemplate: template,
  issueTemplate,
  progressEnabled: false,
  progressTemplates: { ...sampleAutoReplyProgressTemplates },
  version: 3,
  publisherConfigured: false,
  authorizedById: null,
  authorizationEpoch: 0,
  updatedById: null,
  updatedAt: null,
  templateVersion: 4,
};
const user: InvestigationSessionUser = {
  id: "operator",
  username: "operator",
  displayName: "Operator",
  email: null,
  isAdmin: false,
  repositoryIds: [repository.id],
  permissions: ["repository:manage", "action:prepare", "action:execute"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: false,
};

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

function renderPanel(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <RepositoryAutoReplySettingsPanel repository={repository} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function delivery(overrides: Partial<RepositoryAutoReply> = {}): RepositoryAutoReply {
  return {
    id: "delivery-1",
    reportId: "report:1",
    taskId: "task-1",
    workItemId: "work-item-1",
    workItemKind: "pull_request",
    workItemNumber: 12,
    state: "pending",
    body: null,
    intentId: null,
    externalId: null,
    reason: null,
    settingsVersion: 3,
    templateVersion: 4,
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

function progressDelivery(
  overrides: Partial<RepositoryProgressReply> = {},
): RepositoryProgressReply {
  return {
    id: "progress-1",
    reportId: null,
    taskId: "task-1",
    workItemId: "work-item-1",
    workItemKind: "pull_request",
    workItemNumber: 12,
    stage: "received",
    state: "pending",
    body: null,
    externalId: null,
    reason: null,
    settingsVersion: 3,
    templateVersion: 4,
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: structuredClone(user),
  };
});

describe("repository automatic reply configuration", () => {
  it("does not create queries outside repository grants, including for administrators", () => {
    if (!context.session?.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = true;
    context.session.user.repositoryIds = [];
    const queryClient = client();
    expect(renderPanel(queryClient)).toBe("");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("shows English templates, update policy, and a separate comment history entry", () => {
    const queryClient = client();
    queryClient.setQueryData(autoReplySettingsQueryKey(repository.id), settings);
    queryClient.setQueryData(autoRepliesQueryKey(repository.id), { items: [] });
    queryClient.setQueryData(progressRepliesQueryKey(repository.id), { items: [] });
    const html = renderPanel(queryClient);
    expect(html).toContain(repository.fullName);
    expect(html).toContain("No per-report");
    expect(html).toContain("confirmation");
    expect(html).toContain("completed PR and Issue investigations");
    expect(html).toContain(
      "Template changes apply to the next update, including active investigations",
    );
    expect(html).toContain("does not rewrite existing comments");
    expect(html).toContain("English reply templates");
    expect(html).toContain("Conclusion templates");
    expect(html).toContain("Progress templates");
    expect(html).toContain("Edit templates");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Publish assignment task progress");
    expect(html).toContain("updates that same comment when work starts, stops, or completes");
    expect(html).toContain("also authorizes these comment updates");
    expect(html).not.toContain("Received progress template</textarea>");
    expect(html).toContain("publisher is not configured yet");
    expect(html).toContain("Save automatic reply settings");
    expect(html).toContain("View comment deliveries");
    expect(html).toContain("/comments?repositoryId=repo-selected");
    expect(html).not.toContain("Recent automatic replies");
    expect(html).not.toContain("Recent assignment progress");
    expect(html).not.toContain("Confirm publication");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Merge");
  });

  it("shows enabled-save authorization explicitly and hides saving for a scoped reader", () => {
    const renderForm = (canManage: boolean, canAuthorize: boolean) =>
      renderToStaticMarkup(
        <QueryClientProvider client={client()}>
          <AutoReplySettingsForm
            repository={repository}
            settings={{
              ...settings,
              enabled: true,
              publisherConfigured: true,
              authorizedById: user.id,
            }}
            canManage={canManage}
            canAuthorize={canAuthorize}
          />
        </QueryClientProvider>,
      );
    expect(renderForm(true, true)).toContain("Save automatic reply settings");
    expect(renderForm(true, true)).toMatch(
      /<button\b[^>]*disabled=""[^>]*>Save automatic reply settings<\/button>/u,
    );
    const renewal = renderForm(true, true).match(
      /<button\b[^>]*>Save and renew publishing authorization<\/button>/u,
    )?.[0];
    expect(renewal).toBeDefined();
    expect(renewal).not.toContain('disabled=""');
    expect(renderForm(true, true)).toContain("Save and renew publishing authorization");
    expect(renderForm(true, true)).not.toContain("publisher is not configured yet");
    const reader = renderForm(false, false);
    expect(reader).toContain("Repository management permission is required");
    expect(reader).not.toContain("Save and authorize automatic comments");
    expect(reader).not.toContain("Save automatic reply settings");
    const manager = renderForm(true, false);
    expect(manager).toContain("turn off existing automatic replies");
    expect(manager).toContain("action preparation, action execution, and comment");
  });

  it("opens the requested template view without introducing a configuration change", () => {
    const queryClient = client();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AutoReplySettingsForm
          repository={repository}
          settings={settings}
          canManage
          canAuthorize
          selectedTemplate="issue"
          onTemplateChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Issue reply template");
    expect(html).toContain("<textarea");
    expect(html).toContain("{{next_steps}}");
    expect(html).not.toContain("Unsaved changes");
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>Save automatic reply settings<\/button>/u);
    queryClient.clear();
  });

  it("shows loading and failed settings reads without loading historical snapshot lists", async () => {
    expect(renderPanel(client())).toContain("Loading automatic reply settings");
    const failed = client();
    await failed.prefetchQuery({
      queryKey: autoReplySettingsQueryKey(repository.id),
      queryFn: () => Promise.reject(new Error("Settings unavailable.")),
    });
    failed.setQueryData(autoRepliesQueryKey(repository.id), { items: [] });
    await failed.prefetchQuery({
      queryKey: progressRepliesQueryKey(repository.id),
      queryFn: () => Promise.reject(new Error("Progress deliveries unavailable.")),
    });
    const html = renderPanel(failed);
    expect(html).toContain("Settings unavailable.");
    expect(html).toContain("Retry automatic reply settings");
    expect(html).not.toContain("Progress deliveries unavailable.");
    expect(html).toContain("View comment deliveries");
  });

  it("requires enabled automatic replies and current authorization to toggle assignment progress", () => {
    for (const [enabled, canManage, canAuthorize, expectedDisabled] of [
      [false, true, true, true],
      [true, false, true, true],
      [true, true, false, true],
      [true, true, true, false],
    ] as const) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client()}>
          <AutoReplySettingsForm
            repository={repository}
            settings={{ ...settings, enabled, progressEnabled: enabled }}
            canManage={canManage}
            canAuthorize={canAuthorize}
          />
        </QueryClientProvider>,
      );
      const switches = [...html.matchAll(/<input\b[^>]*>/gu)]
        .map((match) => match[0])
        .filter((input) => input.includes('type="checkbox"'));
      expect(switches).toHaveLength(2);
      expect(switches[1]?.includes('disabled=""')).toBe(expectedDisabled);
      if (enabled && canManage && canAuthorize) {
        expect(html).toContain("Save automatic reply settings");
      }
    }
  });
});

describe("automatic reply input and authorization", () => {
  it("binds an authorization confirmation to the reviewed draft and numeric settings version", async () => {
    const saved = structuredClone({ ...settings, enabled: true });
    const draft = autoReplySettingsFormValues(saved);
    const confirmation = autoReplyAuthorizationSnapshot(draft, saved, true);
    saved.version = 4;
    draft.pullRequestTemplate = draft.pullRequestTemplate.replace(
      "{{summary}}",
      "Unreviewed wording\n{{summary}}",
    );
    draft.progressTemplates.received += "\nUnreviewed progress wording";
    const update = vi
      .fn()
      .mockRejectedValue(new InvestigationHttpError(409, "The saved settings changed."));
    await expect(
      submitAutoReplySettings(
        repository.id,
        confirmation.form,
        confirmation.saved,
        false,
        { canManage: true, canAuthorize: true },
        update,
        confirmation.renew,
      ),
    ).rejects.toThrow("The saved settings changed.");
    expect(update).toHaveBeenCalledExactlyOnceWith(repository.id, {
      ...autoReplySettingsInput(autoReplySettingsFormValues({ ...settings, enabled: true }), 3),
      reauthorize: true,
    });
    expect(draft.pullRequestTemplate).toContain("Unreviewed wording");
    expect(confirmation.form.progressTemplates.received).not.toContain(
      "Unreviewed progress wording",
    );
  });
  it("reports invalid hidden templates by their exact selector key without altering a draft", () => {
    const draft = autoReplySettingsFormValues(settings);
    draft.issueTemplate = draft.issueTemplate.replace("{{next_steps}}", "");
    draft.progressTemplates.failed = draft.progressTemplates.failed.replace("{{failure}}", "");
    const errors = autoReplySettingsFieldErrors(draft);
    expect(Object.keys(errors)).toEqual(["issue", "failed"]);
    expect(errors.issue).toContain("{{next_steps}}");
    expect(errors.failed).toContain("{{failure}}");
    expect(draft.issueTemplate).not.toContain("{{next_steps}}");
    expect(autoReplySettingsFieldErrors(autoReplySettingsFormValues(settings))).toEqual({});
  });

  it("retains distinct source locations for repeated paragraphs, details tokens, and CRLF headings", () => {
    const value = "Repeat\r\n\r\nRepeat\r\n\r\n{{details}}\r\n\r\n## Summary\r\n{{summary}}";
    const blocks = autoReplyPreviewBlocks(value);
    expect(blocks.map((block) => block.kind)).toEqual(["text", "text", "details", "text"]);
    expect(blocks.map((block) => block.sourceOffset)).toEqual([
      0,
      value.indexOf("Repeat", 1),
      value.indexOf("{{details}}"),
      value.indexOf("## Summary"),
    ]);
    expect(new Set(blocks.map((block) => block.sourceOffset)).size).toBe(blocks.length);
    for (const block of blocks) {
      expect(value.slice(block.sourceOffset, block.sourceOffset + block.value.length)).toBe(
        block.value,
      );
    }
    const html = renderToStaticMarkup(
      <AutoReplyTemplatePreview template="pullRequest" value={value} />,
    );
    expect(html).toContain("[Investigation summary]");
    expect(html).toContain("Summary</h3>");
  });

  it("previews escaped placeholders and collapsed details without inventing real investigation data", () => {
    const html = renderToStaticMarkup(
      <AutoReplyTemplatePreview
        template="issue"
        value={"{{identity}}\n<script>alert(1)</script>\n{{next_steps}}\n{{details}}"}
      />,
    );
    expect(html).toContain("Illustrative placeholders only");
    expect(html).toContain("[Recommended next steps]");
    expect(html).toContain("Investigation details");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("task-1041");
  });
  it("renews publication authorization only through an explicit request", async () => {
    const update = vi.fn().mockResolvedValue(settings);
    await submitAutoReplySettings(
      repository.id,
      autoReplySettingsFormValues(settings),
      settings,
      false,
      { canManage: true, canAuthorize: true },
      update,
      true,
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(repository.id, {
      ...autoReplySettingsInput(autoReplySettingsFormValues(settings), settings.version),
      reauthorize: true,
    });
  });
  it("requires the exact ordered progress placeholders without weakening the full-result template", () => {
    for (const stage of autoReplyProgressStages) {
      const progressTemplate = sampleAutoReplyProgressTemplates[stage];
      const tokens = autoReplyProgressTemplateTokens[stage];
      expect(() => validateAutoReplyProgressTemplate(progressTemplate, stage)).not.toThrow();
      for (const token of tokens) {
        expect(() =>
          validateAutoReplyProgressTemplate(progressTemplate.replace(`{{${token}}}`, ""), stage),
        ).toThrow("exactly once");
        expect(() =>
          validateAutoReplyProgressTemplate(`${progressTemplate}\n{{${token}}}`, stage),
        ).toThrow("exactly once");
      }
      for (const invalid of ["{{other}}", "{{ trigger }}", "{{TRIGGER}}", "{{}}"])
        expect(() =>
          validateAutoReplyProgressTemplate(`${progressTemplate}\n${invalid}`, stage),
        ).toThrow("unknown placeholder");
      for (const invalid of ["{{broken", "broken}}"])
        expect(() =>
          validateAutoReplyProgressTemplate(`${progressTemplate}\n${invalid}`, stage),
        ).toThrow("incomplete placeholder");
      expect(() =>
        validateAutoReplyProgressTemplate(
          progressTemplate.replace("{{trigger}}", "{{{trigger}}}"),
          stage,
        ),
      ).toThrow("exact {{token}}");
      expect(() =>
        validateAutoReplyProgressTemplate(
          [...tokens]
            .reverse()
            .map((token) => `{{${token}}}`)
            .join("\n"),
          stage,
        ),
      ).toThrow("must order placeholders");
      expect(() =>
        validateAutoReplyProgressTemplate(progressTemplate.padEnd(12_000, " "), stage),
      ).not.toThrow();
      expect(() =>
        validateAutoReplyProgressTemplate(progressTemplate.padEnd(12_001, " "), stage),
      ).toThrow("12,000 UTF-8 bytes");
      expect(() =>
        validateAutoReplyProgressTemplate(`${progressTemplate}${"é".repeat(6_000)}`, stage),
      ).toThrow("12,000 UTF-8 bytes");
    }
    expect(sampleAutoReplyProgressTemplates.completed).toContain("{{result}}");
  });

  it("accepts one leading status token only in progress templates", () => {
    for (const stage of autoReplyProgressStages) {
      const value = sampleAutoReplyProgressTemplates[stage];
      expect(() =>
        validateAutoReplyProgressTemplate(value.replace("{{status}}", "Current status"), stage),
      ).not.toThrow();
      expect(() => validateAutoReplyProgressTemplate(`${value}\n{{status}}`, stage)).toThrow(
        "only once",
      );
      expect(() =>
        validateAutoReplyProgressTemplate(
          value.replace("{{status}}", "Status").replace("{{trigger}}", "{{trigger}}\n{{status}}"),
          stage,
        ),
      ).toThrow("before {{trigger}}");
    }
    expect(() => validateAutoReplyTemplate(`${template}\n{{status}}`)).toThrow(
      "unknown placeholder",
    );
  });

  it("validates disabled progress settings and keeps nested form and submission snapshots isolated", () => {
    const form = autoReplySettingsFormValues(settings);
    expect(form.progressTemplates).not.toBe(settings.progressTemplates);
    form.progressTemplates.received = form.progressTemplates.received.replace(
      "## {{status}}",
      "## Assignment acknowledged: {{status}}",
    );
    const input = autoReplySettingsInput(form, settings.version);
    expect(input.progressTemplates).toEqual(form.progressTemplates);
    expect(input.progressTemplates).not.toBe(form.progressTemplates);
    expect(settings.progressTemplates.received).toContain("## {{status}}");
    form.progressTemplates.received = "Changed after submission";
    expect(input.progressTemplates?.received).toContain("## Assignment acknowledged");
    expect(() => autoReplySettingsInput(form, settings.version)).toThrow(
      "Received progress template",
    );
    expect(() =>
      autoReplySettingsInput(
        { ...autoReplySettingsFormValues(settings), progressEnabled: true },
        3,
      ),
    ).toThrow("require automatic replies to be enabled");
  });

  it("validates each placeholder exactly once, including the sample defaults", () => {
    expect(() => validateAutoReplyTemplate(template)).not.toThrow();
    expect(() => validateAutoReplyTemplate(samplePullRequestAutoReplyTemplate)).not.toThrow();
    expect(() =>
      validateAutoReplyTemplate(sampleIssueAutoReplyTemplate, "Issue template", "issue"),
    ).not.toThrow();
    for (const token of autoReplyTemplateTokens) {
      expect(() => validateAutoReplyTemplate(template.replace(`{{${token}}}`, ""))).toThrow(
        "exactly once",
      );
      expect(() => validateAutoReplyTemplate(`${template}\n{{${token}}}`)).toThrow("exactly once");
    }
    for (const invalid of ["{{other}}", "{{ summary }}", "{{SUMMARY}}", "{{}}"])
      expect(() => validateAutoReplyTemplate(`${template}\n${invalid}`)).toThrow(
        "unknown placeholder",
      );
    for (const invalid of ["{{broken", "broken}}"])
      expect(() => validateAutoReplyTemplate(`${template}\n${invalid}`)).toThrow(
        "incomplete placeholder",
      );
    expect(() =>
      validateAutoReplyTemplate(template.replace("{{summary}}", "{{{summary}}}")),
    ).toThrow("exact {{token}}");
  });

  it("uses distinct PR findings and Issue next-step placeholders", () => {
    expect(() => validateAutoReplyTemplate(issueTemplate, "Issue template", "issue")).not.toThrow();
    for (const token of issueAutoReplyTemplateTokens) {
      expect(() =>
        validateAutoReplyTemplate(
          issueTemplate.replace(`{{${token}}}`, ""),
          "Issue template",
          "issue",
        ),
      ).toThrow("exactly once");
      expect(() =>
        validateAutoReplyTemplate(`${issueTemplate}\n{{${token}}}`, "Issue template", "issue"),
      ).toThrow("exactly once");
    }
    expect(() => validateAutoReplyTemplate(issueTemplate)).toThrow("unknown placeholder");
    expect(() => validateAutoReplyTemplate(template, "Issue template", "issue")).toThrow(
      "unknown placeholder",
    );
    const previousIssueTemplate = issueTemplate.replace(
      "{{conclusion}}",
      "{{conclusion}}\n{{summary}}",
    );
    expect(() =>
      validateAutoReplyTemplate(previousIssueTemplate, "Issue template", "issue"),
    ).toThrow("unknown placeholder");
    expect(() =>
      autoReplySettingsInput(
        { ...autoReplySettingsFormValues(settings), issueTemplate: template },
        3,
      ),
    ).toThrow("Issue reply template contains an unknown placeholder");
    expect(() =>
      autoReplySettingsInput(
        { ...autoReplySettingsFormValues(settings), pullRequestTemplate: issueTemplate },
        3,
      ),
    ).toThrow("PR reply template contains an unknown placeholder");
  });

  it("limits UTF-8 bytes and validates both templates even for disabled settings", () => {
    expect(() => validateAutoReplyTemplate(template.padEnd(12_000, " "))).not.toThrow();
    expect(() => validateAutoReplyTemplate(template.padEnd(12_001, " "))).toThrow(
      "12,000 UTF-8 bytes",
    );
    expect(() => validateAutoReplyTemplate(`${template}${"é".repeat(6_000)}`)).toThrow(
      "12,000 UTF-8 bytes",
    );
    expect(() =>
      autoReplySettingsInput({ ...autoReplySettingsFormValues(settings), issueTemplate: "" }, 3),
    ).toThrow("Issue reply template");
  });

  it("keeps the identity first, conclusions before findings or next steps, and collapsed details last", () => {
    for (const [kind, value] of [
      ["pullRequest", template],
      ["issue", issueTemplate],
    ] as const) {
      expect(() => validateAutoReplyTemplate(`\n  ${value}\n  `, "Template", kind)).not.toThrow();
      expect(() => validateAutoReplyTemplate(`# Review\n${value}`, "Template", kind)).toThrow(
        "first nonempty content",
      );
      expect(() =>
        validateAutoReplyTemplate(`${value}\nAdditional footer.`, "Template", kind),
      ).toThrow("last nonempty content");
      const followingToken = kind === "issue" ? "next_steps" : "summary";
      const reordered = value.replace(
        `{{conclusion}}\n{{${followingToken}}}`,
        `{{${followingToken}}}\n{{conclusion}}`,
      );
      expect(() => validateAutoReplyTemplate(reordered, "Template", kind)).toThrow(
        "must order placeholders",
      );
    }
    for (const sample of [samplePullRequestAutoReplyTemplate, sampleIssueAutoReplyTemplate]) {
      expect(sample.trimStart()).toMatch(/^\{\{identity\}\}/u);
      expect(sample.trimEnd()).toMatch(/\{\{details\}\}$/u);
      expect(sample).not.toContain("<details");
    }
    expect(samplePullRequestAutoReplyTemplate).toContain("## Conclusion\n\n{{conclusion}}");
    expect(samplePullRequestAutoReplyTemplate).toContain("## Summary\n\n{{summary}}");
    expect(samplePullRequestAutoReplyTemplate).toContain("## Findings\n\n{{findings}}");
    expect(sampleIssueAutoReplyTemplate).toContain("## Triage result\n\n{{conclusion}}");
    expect(sampleIssueAutoReplyTemplate).toContain("## Next steps\n\n{{next_steps}}");
    expect(sampleIssueAutoReplyTemplate).not.toContain("{{summary}}");
    expect(sampleIssueAutoReplyTemplate).not.toContain("## Summary");
    expect(sampleIssueAutoReplyTemplate).not.toContain("{{findings}}");
  });

  it("requires all comment authorization grants while allowing managers to save disabled settings", async () => {
    expect(autoReplySettingsPermissions(repository.id, null)).toEqual({
      canRead: false,
      canManage: false,
      canAuthorize: false,
    });
    expect(autoReplySettingsPermissions(repository.id, user)).toEqual({
      canRead: true,
      canManage: true,
      canAuthorize: true,
    });
    for (const permission of user.permissions) {
      expect(
        autoReplySettingsPermissions(repository.id, {
          ...user,
          isAdmin: true,
          permissions: user.permissions.filter((value) => value !== permission),
        }).canAuthorize,
      ).toBe(false);
    }
    expect(
      autoReplySettingsPermissions(repository.id, { ...user, actionCapabilities: ["close"] })
        .canAuthorize,
    ).toBe(false);
    const update = vi.fn().mockResolvedValue({ ...settings, version: 4 });
    const form = { ...autoReplySettingsFormValues(settings), enabled: true };
    for (const permissions of [
      { canManage: false, canAuthorize: false },
      { canManage: true, canAuthorize: false },
    ]) {
      await expect(
        submitAutoReplySettings(repository.id, form, settings, false, permissions, update),
      ).rejects.toThrow("permission");
    }
    expect(update).not.toHaveBeenCalled();
    await submitAutoReplySettings(
      repository.id,
      { ...form, enabled: false },
      settings,
      false,
      { canManage: true, canAuthorize: false },
      update,
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(repository.id, {
      ...form,
      enabled: false,
      version: 3,
    });
  });

  it("saves both edited templates and preserves a conflict draft until explicit reload", async () => {
    const form = {
      ...autoReplySettingsFormValues(settings),
      enabled: true,
      progressEnabled: true,
      pullRequestTemplate: template.replace(
        "{{conclusion}}",
        "## Edited PR template\n{{conclusion}}",
      ),
      issueTemplate: issueTemplate.replace(
        "{{conclusion}}",
        "## Edited Issue template\n{{conclusion}}",
      ),
      progressTemplates: {
        ...sampleAutoReplyProgressTemplates,
        started: sampleAutoReplyProgressTemplates.started.replace(
          "## {{status}}",
          "## Work in progress: {{status}}",
        ),
      },
    };
    const permissions = { canManage: true, canAuthorize: true };
    const conflict = new InvestigationHttpError(409, "Settings changed.");
    const update = vi.fn().mockRejectedValue(conflict);
    await expect(
      submitAutoReplySettings(repository.id, form, settings, false, permissions, update),
    ).rejects.toBe(conflict);
    expect(update).toHaveBeenCalledExactlyOnceWith(repository.id, { ...form, version: 3 });
    await expect(
      submitAutoReplySettings(repository.id, form, settings, true, permissions, update),
    ).rejects.toThrow("Reload the latest saved settings");
    await expect(
      submitAutoReplySettings("another-repository", form, settings, false, permissions, update),
    ).rejects.toThrow("selected repository");
    expect(update).toHaveBeenCalledOnce();
    expect(form.pullRequestTemplate).toContain("Edited PR template");
    expect(form.issueTemplate).toContain("Edited Issue template");
    expect(form.progressTemplates.started).toContain("## Work in progress");
    expect(settings.pullRequestTemplate).toBe(template);
    const latest = {
      ...settings,
      version: 4,
      issueTemplate: issueTemplate.replace("{{conclusion}}", "## Latest\n{{conclusion}}"),
    };
    update.mockResolvedValue({ ...latest, version: 5 });
    await submitAutoReplySettings(
      repository.id,
      autoReplySettingsFormValues(latest),
      latest,
      false,
      permissions,
      update,
    );
    expect(update).toHaveBeenLastCalledWith(repository.id, {
      ...autoReplySettingsFormValues(latest),
      version: 4,
    });
    const notice = renderToStaticMarkup(<AutoReplySettingsConflictNotice />);
    expect(notice).toContain("Your draft is still in this form");
    expect(notice).toContain("replace the draft with the latest version");
  });
});

describe("automatic reply delivery visibility", () => {
  it("shows progress failures and uncertain edits before a report exists", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProgressReplyDeliveryList
          repository={repository}
          items={[
            progressDelivery({
              id: "progress-failed",
              stage: "failed",
              state: "failed",
              reason: "The worker stopped before a conclusion was available.",
            }),
            progressDelivery({
              stage: "started",
              state: "unknown",
              body: "## Saved progress\n<script>alert(1)</script>",
              reason: "Update response lost.",
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("failed");
    expect(html).toContain("started");
    expect(html).toContain("The worker stopped before a conclusion was available.");
    expect(html).toContain("Update response lost.");
    expect(html).toContain("does not automatically resend an uncertain comment update");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("Open report");
    expect(html).not.toContain("View GitHub comment");
    expect(html).not.toContain("Retry delivery");
  });

  it("keeps the existing comment reachable when a progress update fails or becomes uncertain", () => {
    for (const state of ["failed", "unknown"] as const) {
      const reply = progressDelivery({ stage: "started", state, externalId: "987654321" });
      expect(autoReplyCommentUrl(repository, reply)).toBe(
        "https://github.com/owner/selected-repository/pull/12#issuecomment-987654321",
      );
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <ProgressReplyDeliveryList repository={repository} items={[reply]} />
        </MemoryRouter>,
      );
      expect(html).toContain("View GitHub comment");
      expect(html).toContain("pull/12#issuecomment-987654321");
      expect(html).not.toContain("Open report");
    }
  });

  it("links completed progress reports and comments and orders progress by the latest update", () => {
    const items = Array.from({ length: 21 }, (_, index) =>
      progressDelivery({
        id: `progress-${index}`,
        body: `Unique progress body ${index}`,
        updatedAt: `2026-09-16T09:${String(20 - index).padStart(2, "0")}:00.000Z`,
      }),
    );
    items[0] = progressDelivery({
      ...items[0],
      stage: "completed",
      state: "sent",
      reportId: "report:progress",
      externalId: "99999999999999999999",
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProgressReplyDeliveryList repository={repository} items={items} />
      </MemoryRouter>,
    );
    expect(html).toContain("Showing the 20 most recent deliveries");
    expect(html).toContain("Unique progress body 0");
    expect(html).not.toContain("Unique progress body 20");
    expect(html).toContain("completed");
    expect(html).toContain("/reports?reportId=report%3Aprogress&amp;repositoryId=repo-selected");
    expect(html).toContain("pull/12#issuecomment-99999999999999999999");
  });

  it("shows frozen content and uncertain delivery without a resend or confirmation control", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AutoReplyDeliveryList
          repository={repository}
          items={[
            delivery({
              state: "unknown",
              body: "## Frozen reply\n<script>alert(1)</script>",
              reason: "Response lost.",
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("unknown");
    expect(html).toContain("Response lost.");
    expect(html).toContain("needs reconciliation");
    expect(html).toContain("send the comment again");
    expect(html).toContain("View saved comment");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("/reports?reportId=report%3A1&amp;repositoryId=repo-selected");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("View GitHub comment");
    expect(html).not.toContain("Retry delivery");
    expect(html).not.toContain("Confirm publication");
  });

  it("links only confirmed sent comments with numeric IDs without losing integer precision", () => {
    const sent = delivery({ state: "sent", externalId: "99999999999999999999" });
    expect(autoReplyCommentUrl(repository, sent)).toBe(
      "https://github.com/owner/selected-repository/pull/12#issuecomment-99999999999999999999",
    );
    expect(autoReplyCommentUrl(repository, { ...sent, workItemKind: "issue" })).toContain(
      "/issues/12#issuecomment-",
    );
    for (const externalId of [null, "", "0", "1.2", "javascript:alert(1)", "synthetic-comment"])
      expect(autoReplyCommentUrl(repository, { ...sent, externalId })).toBeNull();
    for (const state of ["pending", "prepared", "sending", "blocked", "failed", "unknown"] as const)
      expect(autoReplyCommentUrl(repository, { ...sent, state })).toBeNull();
    for (const fullName of [
      "owner/repo?query",
      "owner/repo#anchor",
      "owner/..",
      "owner/repo/other",
    ])
      expect(autoReplyCommentUrl({ ...repository, fullName }, sent)).toBeNull();
  });

  it("shows all states and limits the visible list to the most recent 20 records", () => {
    const items = Array.from({ length: 21 }, (_, index) =>
      delivery({
        id: `delivery-${index}`,
        workItemNumber: index + 1,
        body: `Unique frozen body ${index}`,
        createdAt: `2026-09-16T09:${String(index).padStart(2, "0")}:00.000Z`,
        state: (
          ["pending", "prepared", "sending", "sent", "blocked", "failed", "unknown"] as const
        )[index % 7]!,
      }),
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AutoReplyDeliveryList repository={repository} items={items} />
      </MemoryRouter>,
    );
    expect(html).toContain("Showing the 20 most recent deliveries");
    expect(html).not.toContain("Unique frozen body 0");
    expect(html).toContain("Unique frozen body 20");
    for (const state of ["pending", "prepared", "sending", "sent", "blocked", "failed", "unknown"])
      expect(html).toContain(state);
  });
});
