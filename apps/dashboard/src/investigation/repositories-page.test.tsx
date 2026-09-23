import type { InvestigationSession } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository, RepositoryWebhookSettings } from "./api";
import RepositoriesPage, {
  repositoryReplyTemplate,
  repositorySettingsTab,
} from "./repositories-page";
import { webhookSettingsQueryKey } from "./webhook-settings";

const context = vi.hoisted(() => ({ session: null as InvestigationSession | null }));
vi.mock("./session", () => ({ useInvestigationSession: () => ({ session: context.session }) }));
vi.mock("./scheduler-panel", () => ({ SchedulerPanel: () => <div>Global scheduler fixture</div> }));
vi.mock("./import-work-item", () => ({
  ImportWorkItemButton: () => <button type="button">Import snapshot</button>,
}));

const repository: Repository = {
  id: "repo-allowed",
  fullName: "owner/allowed",
  githubRepositoryId: 8001,
};
const hidden: Repository = {
  id: "repo-hidden",
  fullName: "owner/hidden",
  githubRepositoryId: 8002,
};
const settings: RepositoryWebhookSettings = {
  repositoryId: repository.id,
  enabled: false,
  e2eEnabled: false,
  reviewerUserId: null,
  allowedActorUserIds: [],
  version: 4,
  receiverConfigured: true,
};
function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(["investigation-repositories"], { items: [repository, hidden] });
  return queryClient;
}
function render(queryClient: QueryClient, url = "/repositories") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={queryClient}>
        <RepositoriesPage />
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

describe("repository directory and detail navigation", () => {
  it("restores directory search and only accepts known reply-template view keys", () => {
    const queryClient = client();
    const html = render(queryClient, "/repositories?q=missing");
    expect(html).toContain('value="missing"');
    expect(html).toContain("No matching repositories");
    expect(html).not.toContain(hidden.fullName);
    expect(repositoryReplyTemplate("issue")).toBe("issue");
    expect(repositoryReplyTemplate("completed")).toBe("completed");
    expect(repositoryReplyTemplate("{{conclusion}}")).toBeUndefined();
    expect(repositoryReplyTemplate(null)).toBeUndefined();
    queryClient.clear();
  });
  it("lists only exact repository grants and leaves settings editors out of the directory", () => {
    const queryClient = client();
    const html = render(queryClient);
    expect(html).toContain(repository.fullName);
    expect(html).not.toContain(hidden.fullName);
    expect(html).toContain("Find a repository");
    expect(html).not.toContain("Assignment recipient GitHub user ID");
    expect(html).not.toContain("Global scheduler fixture");
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes(hidden.id)),
    ).toBe(false);
  });

  it("does not convert a failed saved-settings read into disabled intake", async () => {
    const queryClient = client();
    await queryClient.prefetchQuery({
      queryKey: webhookSettingsQueryKey(repository.id),
      queryFn: () => Promise.reject(new Error("Read failed")),
    });
    const html = render(queryClient);
    expect(html).toContain("Intake unavailable");
    expect(html).not.toContain("Intake off");
  });

  it("opens the selected production deep link with one focused editor and retained event history", () => {
    const queryClient = client();
    queryClient.setQueryData(webhookSettingsQueryKey(repository.id), settings);
    const html = render(queryClient, "/repositories?repositoryId=repo-allowed&tab=intake");
    expect(html).toContain("Back to repositories");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="repository-tab-intake"');
    expect(html).toContain("Assignment recipient GitHub user ID");
    expect(html).toContain("/webhooks?repositoryId=repo-allowed");
    expect(html).not.toContain("PR reply template");
    expect(html).not.toContain("Global scheduler fixture");
  });

  it("keeps global scheduling in its explicit tab and rejects an out-of-scope deep link", () => {
    expect(render(client(), "/repositories?repositoryId=repo-allowed&tab=scheduling")).toContain(
      "Global scheduler fixture",
    );
    const queryClient = client();
    const html = render(queryClient, "/repositories?repositoryId=repo-hidden&tab=intake");
    expect(html).toContain("Repository not available");
    expect(html).not.toContain(hidden.fullName);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes(hidden.id)),
    ).toBe(false);
  });

  it("does not give repository grants to an administrator and normalizes unknown tabs", () => {
    if (!context.session?.authenticated) throw new Error("Expected an authenticated fixture.");
    context.session.user.isAdmin = true;
    context.session.user.repositoryIds = [];
    const queryClient = client();
    const html = render(queryClient);
    expect(html).toContain("No repositories in your scope");
    expect(html).not.toContain(repository.fullName);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
    expect(repositorySettingsTab("unexpected")).toBe("overview");
    expect(repositorySettingsTab("replies")).toBe("replies");
  });
});
