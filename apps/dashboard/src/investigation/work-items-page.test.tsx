import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSampleInvestigationApi } from "./sample-adapter";
import { sourceActionKey, sourceReportKey } from "./source-result";
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
  it("keeps validation separate from completed execution without repeating the conclusion", async () => {
    const { queryClient, source, task } = await fixture();
    const header = await createSampleInvestigationApi().report("sample-pr-p1-report");
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [task] });
    queryClient.setQueryData(sourceReportKey("source-list-test", source.id, task), header);
    const html = render(queryClient);
    expect(html).not.toContain("Changes needed");
    expect(html).toContain("E2E required");
    expect(html).toContain('aria-label="Validation: E2E required"');
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
    expect(html).toContain("1 pull request");
    expect(html).not.toContain('aria-label="Previous page"');
    expect(html).not.toContain("Review pull request</button>");
    expect(html).toContain("workItemId=");
  });

  it("uses a live report-bound next action beside the source link", async () => {
    const { queryClient, source, task } = await fixture();
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(source.id, header.report.id);
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [task] });
    queryClient.setQueryData(sourceReportKey("source-list-test", source.id, task), header);
    queryClient.setQueryData(sourceActionKey("source-list-test", source, header), {
      ...context,
      actor: { ...context.actor, id: "reader" },
    });
    const html = render(queryClient);
    expect(html).toContain("source-queue-row");
    expect(html).toContain("source-queue-title");
    expect(html).toContain("Action · Validation");
    expect(html).toContain("Request changes");
    expect(html).not.toContain("Prepare request changes");
    const actionButton = html.match(
      new RegExp(`<button\\b[^>]*aria-label="Request changes for PR #${source.number}"[^>]*>`, "u"),
    )?.[0];
    expect(actionButton).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Next action");
  });

  it("opens a recommended validation report directly without preparation permission", async () => {
    const { queryClient, source, task } = await fixture();
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(source.id, header.report.id);
    const candidate = context.nextActions[0];
    if (!candidate || !context.reportRef) throw new Error("A report action fixture is required.");
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [task] });
    queryClient.setQueryData(sourceReportKey("source-list-test", source.id, task), header);
    queryClient.setQueryData(sourceActionKey("source-list-test", source, header), {
      ...context,
      actor: { ...context.actor, id: "reader" },
      recommendation: { action: "view-validation", reason: "Read the linked validation report." },
      recommendedActionId: "linked-validation-action",
      nextActions: [
        {
          ...candidate,
          id: "linked-validation-action",
          action: "view-validation",
          allowed: true,
          canPrepare: false,
          state: "saved",
          validationReportRef: { ...context.reportRef, id: "linked-validation-report" },
        },
      ],
    });
    const html = render(queryClient);
    const validationLink = html.match(
      /<a\b[^>]*aria-label="View validation for PR #[^"]+"[^>]*>/u,
    )?.[0];
    expect(validationLink).toContain("reportId=linked-validation-report");
    expect(validationLink).toContain("section=validation");
    expect(validationLink).not.toContain('aria-disabled="true"');
    expect(validationLink).not.toContain('aria-haspopup="dialog"');
  });

  it("shows a local recovery control when action availability cannot load", async () => {
    const { queryClient, source, task } = await fixture();
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [task] });
    queryClient.setQueryData(sourceReportKey("source-list-test", source.id, task), header);
    const key = sourceActionKey("source-list-test", source, header);
    queryClient.setQueryData(key, await api.actionContext(source.id, header.report.id));
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
    if (!query) throw new Error("The action query fixture is required.");
    query.setState({
      data: undefined,
      status: "error",
      error: new Error("Action availability is temporarily unavailable."),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });

    const html = render(queryClient);
    expect(html).toContain("Refresh actions");
    expect(html).toContain("Action availability is temporarily unavailable.");
    expect(html).not.toContain('aria-label="Request changes for PR');
  });

  it("keeps clear filters available while matching sources remain visible", async () => {
    const { queryClient, source } = await fixture();
    queryClient.setQueryData(["investigation-tasks", "source-list"], { items: [] });
    const html = render(queryClient, `/pull-requests?q=${source.number}`);
    expect(html).toContain(source.title);
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("No matching sources");
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
