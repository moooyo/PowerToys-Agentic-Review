import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  applyReportDirectoryFilters,
  clearReportDirectoryFilters,
  ReportDirectory,
} from "./report-directory";

vi.mock("./session", () => ({
  useInvestigationSession: () => ({ session: { authenticated: true } }),
  sessionIdentity: () => "report-directory-test-session",
}));

describe("report-local filters and workspace repository scope", () => {
  it("applies a retained mobile filter draft within the current global repository", () => {
    const params = new URLSearchParams("repositoryId=current-repo&search=settings&cursor=old-page");
    const retainedDraft = {
      repositoryId: "previous-repo",
      kind: "pr-review",
      completeness: "partial",
      delivery: "checkpoint",
    };
    const next = applyReportDirectoryFilters(params, retainedDraft);
    expect(next.get("repositoryId")).toBe("current-repo");
    expect(next.get("search")).toBe("settings");
    expect(next.get("kind")).toBe("pr-review");
    expect(next.get("completeness")).toBe("partial");
    expect(next.get("delivery")).toBe("checkpoint");
    expect(next.has("cursor")).toBe(false);
    expect(params.get("cursor")).toBe("old-page");
  });

  it("clears local search and filters without clearing or inventing a global repository", () => {
    const scoped = new URLSearchParams(
      "repositoryId=current-repo&search=settings&kind=pr-review&completeness=partial&delivery=checkpoint&cursor=old-page",
    );
    expect(clearReportDirectoryFilters(scoped).toString()).toBe("repositoryId=current-repo");
    expect(
      clearReportDirectoryFilters(new URLSearchParams("search=settings&kind=pr-review")).toString(),
    ).toBe("");
  });

  it("uses the global scope in the query without rendering another Repository selector or counting it as a local filter", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    try {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={["/reports?repositoryId=current-repo"]}>
          <QueryClientProvider client={client}>
            <ReportDirectory />
          </QueryClientProvider>
        </MemoryRouter>,
      );
      expect(html).toContain("Investigation type");
      expect(html).toContain("Completeness");
      expect(html).toContain("Delivery");
      expect(html).not.toContain(">Repository<");
      expect(html).not.toContain("All accessible repositories");
      expect(html).not.toContain("Filters, 1 active");
      const queries = client.getQueryCache().getAll();
      expect(queries.map((query) => query.queryKey[0])).toEqual(["investigation-report-directory"]);
      expect(queries[0]?.queryKey[2]).toMatchObject({ repositoryId: "current-repo" });
    } finally {
      client.clear();
    }
  });
});
