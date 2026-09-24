import { renderToStaticMarkup } from "react-dom/server";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueBar, type ReviewRecord, useReviewListNavigation } from "./review-navigation";

vi.mock("./session", () => ({
  sessionIdentity: () => "not-needed-without-provider",
  useInvestigationSession: () => {
    throw new Error("Standalone views must not require a session provider for fallback links");
  },
}));

const task: ReviewRecord = {
  kind: "task",
  id: "task-one",
  workItemId: "source-one",
  repositoryId: "repo-a",
  href: "/tasks?taskId=task-one&repositoryId=repo-a",
};

function ListWithoutProvider() {
  const { getLinkProps } = useReviewListNavigation({ label: "Tasks", records: [task] });
  return <Link {...getLinkProps(task)}>Open task</Link>;
}

function RelatedListWithoutProvider() {
  const source: ReviewRecord = {
    ...task,
    kind: "work-item",
    id: "source-one",
    href: "/pull-requests?workItemId=source-one&repositoryId=repo-a",
  };
  const { getLinkProps, getRelatedLinkProps } = useReviewListNavigation({
    label: "Pull requests",
    records: [source],
  });
  return (
    <>
      <Link {...getLinkProps(source)}>Open source</Link>
      <Link {...getRelatedLinkProps(source, task)}>View progress</Link>
    </>
  );
}

describe("standalone review navigation", () => {
  it("keeps related shortcut hrefs and separate opener IDs without a provider", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/pull-requests"]}>
        <RelatedListWithoutProvider />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/tasks?taskId=task-one&amp;repositoryId=repo-a"');
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/gu), (match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}-next`);
  });

  it("preserves an ordinary source link when no review provider is mounted", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/tasks"]}>
        <ListWithoutProvider />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/tasks?taskId=task-one&amp;repositoryId=repo-a"');
    expect(html).toContain("Open task");
    expect(html).toContain("review-result-");
  });

  it("offers only the supplied fallback for directly opened details", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[task.href]}>
        <ReviewQueueBar
          record={task}
          fallbackTo="/tasks?repositoryId=repo-a"
          fallbackLabel="All tasks"
        />
      </MemoryRouter>,
    );
    expect(html).toContain('href="/tasks?repositoryId=repo-a"');
    expect(html).toContain("All tasks");
    expect(html).not.toContain("Review result queue");
    expect(html).not.toContain("Next result");
  });
});
