import type { InvestigationSession } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository, RepositoryWebhookSettings } from "./api";
import { InvestigationHttpError } from "./transport";
import {
  RepositoryWebhookSettingsPanel,
  WebhookSettingsConflictNotice,
  WebhookSettingsForm,
  webhookSettingsQueryKey,
} from "./webhook-settings";
import {
  parseGitHubUserIds,
  submitWebhookSettings,
  webhookSettingsFieldErrors,
  webhookSettingsFormIsDirty,
  webhookSettingsFormValues,
  webhookSettingsInput,
} from "./webhook-settings-form";

const context = vi.hoisted(() => ({ session: null as InvestigationSession | null }));
vi.mock("./session", () => ({
  useInvestigationSession: () => ({ session: context.session }),
}));

const repository: Repository = {
  id: "repo-selected",
  fullName: "owner/selected-repository",
  githubRepositoryId: 8001,
};
const settings: RepositoryWebhookSettings = {
  repositoryId: repository.id,
  enabled: true,
  reviewerUserId: 1001,
  allowedActorUserIds: [2001, 2002],
  version: 3,
  receiverConfigured: false,
};

function client() {
  // SSR mounts a new observer; retain a settled error instead of retrying that mount.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

function renderPanel(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <RepositoryWebhookSettingsPanel repository={repository} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: {
      id: "operator",
      username: "operator",
      displayName: "Operator",
      email: null,
      isAdmin: false,
      repositoryIds: [repository.id],
      permissions: ["repository:manage"],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
});

describe("repository assignment webhook settings", () => {
  it("does not query settings outside the current repository grants", () => {
    if (!context.session?.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = true;
    context.session.user.repositoryIds = [];
    const queryClient = client();
    expect(renderPanel(queryClient)).toBe("");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("shows the selected repository, assignment rules, and unavailable receiver without blocking configuration", () => {
    const queryClient = client();
    queryClient.setQueryData(webhookSettingsQueryKey(repository.id), settings);
    const html = renderPanel(queryClient);
    expect(html).toContain("Static investigations");
    expect(html).toContain("Listen for assignments");
    expect(html).toContain("Assignment recipient ID");
    expect(html).toContain("Trusted GitHub user IDs");
    expect(html).toContain("/api/github/webhook");
    expect(html).toContain("receiver is not configured");
    expect(html).toContain("Save settings");
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>Save settings<\/button>/u);
    expect(html).not.toContain("review_requested");
  });

  it("allows scoped readers to see settings without presenting a save operation", () => {
    if (!context.session?.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = true;
    context.session.user.permissions = [];
    const queryClient = client();
    queryClient.setQueryData(webhookSettingsQueryKey(repository.id), settings);
    const html = renderPanel(queryClient);
    expect(html).toContain("Assignment recipient ID");
    expect(html).toContain("Repository management permission is required");
    expect(html).not.toContain("Save settings");
  });

  it("shows settings loading and a retryable read failure", async () => {
    expect(renderPanel(client())).toContain("Loading webhook settings");
    const failed = client();
    await failed.prefetchQuery({
      queryKey: webhookSettingsQueryKey(repository.id),
      queryFn: () => Promise.reject(new Error("The settings directory is unavailable.")),
    });
    const html = renderPanel(failed);
    expect(html).toContain("The settings directory is unavailable.");
    expect(html).toContain("Retry webhook settings");
  });

  it("does not show an unavailable-receiver warning when the receiver is configured", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client()}>
          <WebhookSettingsForm
            repository={repository}
            settings={{ ...settings, receiverConfigured: true }}
            canManage
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain("receiver is not configured");
  });
});

describe("webhook settings input and conflict recovery", () => {
  it("identifies the exact field to focus while keeping trusted E2E intake independent", () => {
    const draft = {
      enabled: false,
      e2eEnabled: true,
      reviewerUserIdText: "octocat",
      allowedActorUserIdsText: "",
    };
    expect(webhookSettingsFieldErrors(draft)).toEqual({
      reviewerUserIdText: "Enter positive numeric GitHub user IDs, not usernames.",
      allowedActorUserIdsText: "Add at least one trusted user before enabling intake.",
    });
    expect(
      webhookSettingsFieldErrors({
        ...draft,
        reviewerUserIdText: "1001",
        allowedActorUserIdsText: "2001,2002",
      }),
    ).toEqual({});
    expect(
      webhookSettingsFieldErrors({
        ...draft,
        e2eEnabled: false,
        reviewerUserIdText: "",
        allowedActorUserIdsText: "",
      }),
    ).toEqual({});
  });
  it("preserves independent E2E authorization using the existing trusted identity fields", () => {
    const form = webhookSettingsFormValues({ ...settings, enabled: false, e2eEnabled: true });
    expect(webhookSettingsInput(form, settings.version)).toMatchObject({
      enabled: false,
      e2eEnabled: true,
      reviewerUserId: settings.reviewerUserId,
      allowedActorUserIds: settings.allowedActorUserIds,
    });
    expect(() => webhookSettingsInput({ ...form, allowedActorUserIdsText: "" }, 0)).toThrow(
      "trusted user",
    );
  });
  it("accepts numeric IDs separated by commas or new lines and deduplicates stable identity", () => {
    expect(parseGitHubUserIds("2001, 2002\n2001\n 02003 ")).toEqual([2001, 2002, 2003]);
    expect(parseGitHubUserIds(" \n")).toEqual([]);
    for (const input of ["username", "0", "-1", "1.5", "1e3", "0x42", "9007199254740992"]) {
      expect(() => parseGitHubUserIds(input)).toThrow("positive numeric GitHub user IDs");
    }
    expect(() =>
      parseGitHubUserIds(Array.from({ length: 1025 }, (_, index) => index + 1).join(",")),
    ).toThrow("up to 1,024");
  });

  it("requires complete enabled rules and permits an unconfigured disabled repository", () => {
    const empty = { enabled: false, reviewerUserIdText: "", allowedActorUserIdsText: "" };
    expect(webhookSettingsInput(empty, 0)).toEqual({
      version: 0,
      enabled: false,
      reviewerUserId: null,
      allowedActorUserIds: [],
    });
    for (const form of [
      { ...empty, enabled: true },
      { ...empty, enabled: true, reviewerUserIdText: "1001" },
      { ...empty, enabled: true, allowedActorUserIdsText: "2001" },
    ]) {
      expect(() => webhookSettingsInput(form, 0)).toThrow(
        "recipient and at least one trusted user",
      );
    }
    expect(() => webhookSettingsInput({ ...empty, reviewerUserIdText: "1001,1002" }, 0)).toThrow(
      "positive numeric GitHub user IDs",
    );
  });

  it("sends the saved version and edited values only to the selected repository", async () => {
    const form = {
      ...webhookSettingsFormValues(settings),
      reviewerUserIdText: "1002",
      allowedActorUserIdsText: "2003,2004",
    };
    const updated = {
      ...settings,
      reviewerUserId: 1002,
      allowedActorUserIds: [2003, 2004],
      version: 4,
    };
    const update = vi.fn().mockResolvedValue(updated);
    await expect(
      submitWebhookSettings(repository.id, form, settings, false, update),
    ).resolves.toEqual(updated);
    expect(update).toHaveBeenCalledExactlyOnceWith(repository.id, {
      version: 3,
      enabled: true,
      reviewerUserId: 1002,
      allowedActorUserIds: [2003, 2004],
    });
    await expect(
      submitWebhookSettings("another-repo", form, settings, false, update),
    ).rejects.toThrow("selected repository");
    expect(update).toHaveBeenCalledOnce();
  });

  it("retains a failed draft and prevents a stale retry until saved settings are reloaded", async () => {
    const form = { ...webhookSettingsFormValues(settings), reviewerUserIdText: "1009" };
    const conflict = new InvestigationHttpError(409, "The settings changed.");
    const update = vi.fn().mockRejectedValue(conflict);
    await expect(submitWebhookSettings(repository.id, form, settings, false, update)).rejects.toBe(
      conflict,
    );
    await expect(
      submitWebhookSettings(repository.id, form, settings, true, update),
    ).rejects.toThrow("Reload the latest saved settings");
    expect(update).toHaveBeenCalledOnce();
    expect(form.reviewerUserIdText).toBe("1009");
    expect(settings.reviewerUserId).toBe(1001);
    const latest = { ...settings, version: 4, reviewerUserId: 1005 };
    update.mockResolvedValue({ ...latest, version: 5 });
    await submitWebhookSettings(
      repository.id,
      { ...webhookSettingsFormValues(latest), reviewerUserIdText: "1009" },
      latest,
      false,
      update,
    );
    expect(update).toHaveBeenLastCalledWith(repository.id, {
      version: 4,
      enabled: true,
      reviewerUserId: 1009,
      allowedActorUserIds: [2001, 2002],
    });
    const notice = renderToStaticMarkup(<WebhookSettingsConflictNotice />);
    expect(notice).toContain("Your draft is kept");
    expect(notice).toContain("replace the draft with the latest version");
  });

  it("does not write unchanged intake rules when numeric IDs are reordered or reformatted", async () => {
    const form = {
      ...webhookSettingsFormValues(settings),
      reviewerUserIdText: " 01001 ",
      allowedActorUserIdsText: "2002, 2001\n2002",
    };
    const update = vi.fn();
    expect(webhookSettingsFormIsDirty(form, settings)).toBe(false);
    await expect(submitWebhookSettings(repository.id, form, settings, false, update)).resolves.toBe(
      settings,
    );
    expect(update).not.toHaveBeenCalled();
    expect(webhookSettingsFormIsDirty({ ...form, enabled: false }, settings)).toBe(true);
    expect(
      webhookSettingsFormIsDirty({ ...form, reviewerUserIdText: "not-a-user-id" }, settings),
    ).toBe(true);
    expect(webhookSettingsFormIsDirty({ ...form, allowedActorUserIdsText: "2001" }, settings)).toBe(
      true,
    );
  });
});
