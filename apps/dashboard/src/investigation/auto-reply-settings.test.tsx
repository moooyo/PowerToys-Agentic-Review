import type { InvestigationSession, InvestigationSessionUser } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository, RepositoryAutoReply, RepositoryAutoReplySettings } from "./api";
import {
  AutoReplyDeliveryList,
  AutoReplySettingsConflictNotice,
  AutoReplySettingsForm,
  autoRepliesQueryKey,
  autoReplyCommentUrl,
  autoReplySettingsQueryKey,
  RepositoryAutoReplySettingsPanel,
} from "./auto-reply-settings";
import {
  autoReplySettingsFormValues,
  autoReplySettingsInput,
  autoReplySettingsPermissions,
  autoReplyTemplateTokens,
  issueAutoReplyTemplateTokens,
  submitAutoReplySettings,
  validateAutoReplyTemplate,
} from "./auto-reply-settings-form";
import {
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
  version: 3,
  publisherConfigured: false,
  authorizedById: null,
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

  it("shows English templates, future automatic comment authorization, and publisher status", () => {
    const queryClient = client();
    queryClient.setQueryData(autoReplySettingsQueryKey(repository.id), settings);
    queryClient.setQueryData(autoRepliesQueryKey(repository.id), { items: [] });
    const html = renderPanel(queryClient);
    expect(html).toContain(repository.fullName);
    expect(html).toContain("No per-report");
    expect(html).toContain("confirmation");
    expect(html).toContain("future completed PR and Issue investigations");
    expect(html).toContain("English reply templates");
    expect(html).toContain("AI identity");
    expect(html).toContain("verified GitHub publishing user");
    expect(html).toContain("AI-generated content may contain errors");
    expect(html).toContain("collapsed by default");
    expect(html).toContain("PR reply template");
    expect(html).toContain("Issue reply template");
    expect(html).toContain("Issue placeholders");
    expect(html).toContain("summary is included in Triage result");
    expect(html).toContain("without a separate Summary section");
    expect(html).toContain("Bug triage shows Runtime reproduction separately");
    expect(html).toContain("Next steps appear before collapsed Investigation details");
    expect(html).toContain("{{next_steps}}");
    expect(html).toContain("publisher is not configured yet");
    expect(html).toContain("Save automatic reply settings");
    expect(html).toContain("Refresh deliveries");
    expect(html).toContain("No automatic reply deliveries recorded");
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
    expect(renderForm(true, true)).toContain("Save and authorize automatic comments");
    expect(renderForm(true, true)).not.toContain("publisher is not configured yet");
    const reader = renderForm(false, false);
    expect(reader).toContain("Repository management permission is required");
    expect(reader).not.toContain("Save and authorize automatic comments");
    expect(reader).not.toContain("Save automatic reply settings");
    const manager = renderForm(true, false);
    expect(manager).toContain("turn off existing automatic replies");
    expect(manager).toContain("action preparation, action execution, and comment");
  });

  it("shows independent loading and failed reads with a refresh operation", async () => {
    expect(renderPanel(client())).toContain("Loading automatic reply settings");
    const failed = client();
    await failed.prefetchQuery({
      queryKey: autoReplySettingsQueryKey(repository.id),
      queryFn: () => Promise.reject(new Error("Settings unavailable.")),
    });
    failed.setQueryData(autoRepliesQueryKey(repository.id), { items: [] });
    const html = renderPanel(failed);
    expect(html).toContain("Settings unavailable.");
    expect(html).toContain("Retry automatic reply settings");
    expect(html).toContain("No automatic reply deliveries recorded");
  });
});

describe("automatic reply input and authorization", () => {
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
      enabled: true,
      pullRequestTemplate: template.replace(
        "{{conclusion}}",
        "## Edited PR template\n{{conclusion}}",
      ),
      issueTemplate: issueTemplate.replace(
        "{{conclusion}}",
        "## Edited Issue template\n{{conclusion}}",
      ),
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
    expect(html).toContain("View frozen comment");
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
