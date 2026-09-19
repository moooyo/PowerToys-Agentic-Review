import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkItem } from "./api";
import { InvestigationAccessOptions } from "./start-investigation";

const pullRequest: WorkItem = {
  id: "access-pr",
  repositoryId: "access-repository",
  kind: "pull_request",
  number: 17,
  title: "Review the registered source",
  body: "Synthetic source for access controls.",
  state: "open",
  updatedAt: "2026-09-20T00:00:00Z",
  subject: {
    id: "access-subject",
    repositoryId: "access-repository",
    workItemId: "access-pr",
    revisionKey: "a".repeat(64),
    kind: "original_pr",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
};
const issue: WorkItem = {
  ...pullRequest,
  id: "access-issue",
  kind: "issue",
  subject: {
    id: "issue-subject",
    repositoryId: pullRequest.repositoryId,
    workItemId: "access-issue",
    revisionKey: "d".repeat(64),
    kind: "issue_snapshot",
    snapshotDigest: "e".repeat(64),
  },
};

describe("static investigation access controls", () => {
  it("presents exact-source PR access without any mode radio or snapshot-only choice", () => {
    const html = renderToStaticMarkup(
      <InvestigationAccessOptions
        workItem={pullRequest}
        mode="source_read"
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("Read exact source");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Snapshot only");
    expect(html).not.toContain('value="snapshot_only"');
  });

  it.each(["snapshot_only", "source_read"] as const)(
    "retains both legal Issue modes when %s is selected",
    (mode) => {
      const html = renderToStaticMarkup(
        <InvestigationAccessOptions
          workItem={issue}
          mode={mode}
          disabled={false}
          onChange={vi.fn()}
        />,
      );
      expect(html.match(/type="radio"/gu)).toHaveLength(2);
      expect(html).toContain('value="source_read"');
      expect(html).toContain('value="snapshot_only"');
      expect(html).toContain("Read exact source");
      expect(html).toContain("Snapshot only");
    },
  );
});
