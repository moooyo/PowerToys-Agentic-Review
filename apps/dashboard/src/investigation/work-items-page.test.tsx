import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSampleInvestigationApi } from "./sample-adapter";
import { sourceReportKey } from "./source-result";
import { WorkItemsPage } from "./work-items-page";

vi.mock("./session", () => ({
  sessionIdentity: () => "source-list-test",
  useInvestigationSession: () => ({
    session: {
      authenticated: true,
      user: { id: "reader", permissions: [], repositoryIds: ["repo-powertoys-fork"] },
    },
  }),
}));

async function fixture() {
  const api = createSampleInvestigationApi();
  const { task } = await api.task("sample-pr-p1-task");
  const source = await api.workItem(task.workItem.id);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(["investigation-repositories", "source-list-test"], {
    items: [task.repository],
  });
  queryClient.setQueryData(["investigation-work-items", undefined, "pull_request"], {
    items: [source],
  });
  return { queryClient, source, task };
}

function render(queryClient: QueryClient, entry = "/pull-requests") {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <WorkItemsPage kind="pull_request" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("source list presentation", () => {
  it("presents the saved conclusion and validation independently of completed execution", async () => {
    const { queryClient, source, task } = await fixture();
    const header = await createSampleInvestigationApi().report("sample-pr-p1-report");
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [task] });
    queryClient.setQueryData(sourceReportKey("source-list-test", source.id, task), header);
    const html = render(queryClient);
    expect(html).toContain("Changes needed");
    expect(html).toContain("E2E required");
    expect(html).toContain("Completed");
    expect(html).toContain(task.repository.fullName);
    expect(html).not.toContain("Loading conclusion");
  });

  it("shows a compact source with a distinct investigation state and no single-page controls", async () => {
    const { queryClient, source, task } = await fixture();
    queryClient.setQueryData(["investigation-tasks", "source-list"], {
      items: [{ ...task, state: "running", latestReportRef: null }],
    });
    const html = render(queryClient);
    expect(html).toContain(source.title);
    expect(html).toContain("Running");
    expect(html).toContain("open");
    expect(html).toContain("1 pull request shown");
    expect(html).not.toContain('aria-label="Previous page"');
    expect(html).not.toContain("Review pull request</button>");
    expect(html).toContain("workItemId=");
  });

  it("keeps sources visible while investigation status required by a filter is loading", async () => {
    const { queryClient, source } = await fixture();
    const html = render(queryClient, "/pull-requests?investigation=running");
    expect(html).toContain(source.title);
    expect(html).toContain("Loading status");
    expect(html).not.toContain("No matching sources");
  });

  it("renders a clear-filter action for a URL search with no matches", async () => {
    const { queryClient } = await fixture();
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [] });
    const html = render(queryClient, "/pull-requests?q=unmatched-source");
    expect(html).toContain("No matching sources");
    expect(html).toContain("Clear filters");
    expect(html).toContain("unmatched-source");
  });
});
