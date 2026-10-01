import type {
  InvestigationCommentPublicationSummary,
  InvestigationCurrentComment,
  InvestigationFindingSource,
  InvestigationFindingV1,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import { assertCurrentCommentBinding, CommentCurrentView } from "./comment-current";
import {
  assertFindingSourceBinding,
  FindingSource,
  FindingSourceView,
  findingSourceQueryKey,
} from "./finding-source";

const english = (_zh: string, en: string) => en;
const chinese = (zh: string, _en: string) => zh;

function currentFixture(
  overrides: Partial<InvestigationCurrentComment> = {},
): InvestigationCurrentComment {
  return {
    commentId: "comment",
    repositoryId: "repository",
    repositoryFullName: "fixture/repository",
    workItemId: "item",
    workItemNumber: 7,
    externalId: "700",
    checkedAt: "2026-10-01T01:00:00.000Z",
    state: "edited",
    comparison: "differs_from_confirmation",
    reasonCode: null,
    body: "Edited current body",
    commentUrl: "https://github.com/fixture/repository/pull/7#issuecomment-700",
    upstreamUpdatedAt: "2026-10-01T00:30:00.000Z",
    lastConfirmedAt: "2026-10-01T00:00:00.000Z",
    lastConfirmedBody: "Historical confirmed body",
    ...overrides,
  };
}

async function sourceFixture(): Promise<{
  header: InvestigationReportHeaderV1;
  finding: InvestigationFindingV1;
  value: InvestigationFindingSource;
}> {
  const api = createSampleInvestigationApi();
  const header = await api.report("sample-pr-p1-report");
  const finding = (await api.findings(header.id)).items[0]!;
  const location = finding.locations[0]!;
  if (location.kind !== "source") throw new Error("The fixture requires a source location.");
  const subject = header.context.subjects.find((entry) => entry.id === location.subjectRef)!;
  if (subject.kind !== "original_pr") throw new Error("The fixture requires a frozen PR subject.");
  const first = Math.max(1, location.startLine - 1);
  const last = location.endLine + 1;
  const value: InvestigationFindingSource = {
    reportRef: {
      id: header.id,
      version: header.version,
      digest: header.report.logicalContentDigest,
    },
    findingId: finding.id,
    findingVersion: finding.version,
    locationIndex: 0,
    repositoryId: header.context.repository.id,
    repositoryFullName: header.context.repository.fullName,
    workItemId: header.context.workItem.id,
    subjectRef: location.subjectRef,
    revisionKey: subject.revisionKey,
    commitSha: subject.headSha,
    blobSha: "9".repeat(40),
    contentDigest: "8".repeat(64),
    path: location.path,
    startLine: location.startLine,
    endLine: location.endLine,
    sourceRepositoryFullName: header.context.repository.fullName,
    sourcePath: location.path,
    availability: "available",
    reasonCode: null,
    sourceUrl: `https://github.com/${header.context.repository.fullName}/blob/${subject.headSha}/${location.path.split("/").map(encodeURIComponent).join("/")}#L${location.startLine}-L${location.endLine}`,
    checkedAt: "2026-10-01T01:00:00.000Z",
    contextStartLine: first,
    contextEndLine: last,
    truncated: false,
    lines: Array.from({ length: last - first + 1 }, (_, index) => ({
      number: first + index,
      text: `original source line ${first + index}`,
      inFinding: first + index >= location.startLine && first + index <= location.endLine,
    })),
  };
  return { header, finding, value };
}

describe("current GitHub comment display", () => {
  it("shows edited upstream content and retained historical content separately", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView value={currentFixture()} text={english} />,
    );
    expect(html).toContain("GitHub comment was edited");
    expect(html).toContain("Current GitHub body");
    expect(html).toContain("Edited current body");
    expect(html).toContain("Last confirmed historical content");
    expect(html).toContain("Historical confirmed body");
    expect(html).not.toContain("matches the last confirmation");
  });

  it("retains confirmation history when the comment is deleted", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView
        value={currentFixture({
          state: "deleted",
          comparison: "unknown",
          body: null,
          reasonCode: "comment_deleted",
        })}
        text={chinese}
      />,
    );
    expect(html).toContain("GitHub 评论已被删除");
    expect(html).toContain("上次确认的历史内容");
    expect(html).toContain("Historical confirmed body");
    expect(html).not.toContain("Edited current body");
  });

  it("shows an inaccessible target as unknown instead of deleted", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView
        value={currentFixture({
          state: "unavailable",
          body: null,
          comparison: "unknown",
          reasonCode: "github_not_found_or_inaccessible",
        })}
        text={english}
      />,
    );
    expect(html).toContain("Current GitHub comment is unavailable");
    expect(html).toContain("Comment deletion cannot be confirmed");
    expect(html).not.toContain("GitHub comment was deleted");
  });

  it("does not infer an edit without a retained confirmed body", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView
        value={currentFixture({
          state: "present",
          comparison: "unknown",
          lastConfirmedBody: null,
          reasonCode: "confirmed_content_unavailable",
        })}
        text={english}
      />,
    );
    expect(html).toContain("Historical content cannot be compared");
    expect(html).toContain("edits cannot be determined");
    expect(html).not.toContain("GitHub comment was edited");
  });

  it("displays retained confirmation content when its original timestamp is unknown", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView value={currentFixture({ lastConfirmedAt: null })} text={english} />,
    );
    expect(html).toContain("Last confirmed historical content");
    expect(html).toContain("Confirmation time unknown");
    expect(html).toContain("Historical confirmed body");
  });

  it.each(["commentId", "repositoryId", "workItemId", "externalId"] as const)(
    "rejects response binding changes to %s",
    (field) => {
      const value = currentFixture();
      const publication = {
        id: value.commentId,
        repositoryId: value.repositoryId,
        repositoryFullName: value.repositoryFullName,
        workItemId: value.workItemId,
        workItemNumber: value.workItemNumber,
        externalId: value.externalId,
      } as InvestigationCommentPublicationSummary;
      expect(() =>
        assertCurrentCommentBinding({ ...value, [field]: "other" }, publication),
      ).toThrow("another publication");
    },
  );

  it("renders upstream bodies as text without executing embedded markup", () => {
    const html = renderToStaticMarkup(
      <CommentCurrentView
        value={currentFixture({ body: '<img src="x" onerror="alert(1)">' })}
        text={english}
      />,
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src="x"');
  });
});

describe("finding source context display", () => {
  it("renders the frozen commit, exact source lines, highlights, and a pinned GitHub link", async () => {
    const { header, finding, value } = await sourceFixture();
    expect(() => assertFindingSourceBinding(value, header, finding, 0)).not.toThrow();
    const html = renderToStaticMarkup(<FindingSourceView value={value} text={english} />);
    expect(html).toContain("Original source context");
    expect(html).toContain(value.commitSha!.slice(0, 12));
    expect(html).toContain(`original source line ${value.startLine}`);
    expect(html).toContain("rc-source-line-selected");
    expect(html).toContain(`/blob/${value.commitSha}/`);
    expect(html).toContain("View this commit on GitHub");
  });

  it.each([
    "commitSha",
    "path",
    "subjectRef",
    "revisionKey",
    "findingId",
    "contentDigest",
  ] as const)("rejects mismatched immutable source metadata %s", async (field) => {
    const { header, finding, value } = await sourceFixture();
    const altered = { ...value, [field]: field === "contentDigest" ? null : "other" };
    expect(() => assertFindingSourceBinding(altered, header, finding, 0)).toThrow();
  });

  it("rejects line-number drift and a URL to a mutable branch", async () => {
    const { header, finding, value } = await sourceFixture();
    expect(() =>
      assertFindingSourceBinding(
        { ...value, lines: value.lines.map((line) => ({ ...line, number: line.number + 1 })) },
        header,
        finding,
        0,
      ),
    ).toThrow();
    expect(() =>
      assertFindingSourceBinding(
        { ...value, sourceUrl: "https://github.com/fixture/repository/blob/main/a.cpp" },
        header,
        finding,
        0,
      ),
    ).toThrow();
  });

  it("shows an unavailable saved revision without inserting suggested replacement content", async () => {
    const { value } = await sourceFixture();
    const html = renderToStaticMarkup(
      <FindingSourceView
        value={{
          ...value,
          availability: "unavailable",
          reasonCode: "immutable_source_revision_unavailable",
          lines: [],
          sourceUrl: null,
        }}
        text={chinese}
      />,
    );
    expect(html).toContain("未保存可读取的不可变源码提交");
    expect(html).not.toContain("original source line");
  });

  it("labels proposed replacements separately from the original source reader", async () => {
    const { header, finding, value } = await sourceFixture();
    const suggestion = finding.feedbackDraft.suggestion;
    if (!suggestion) throw new Error("The fixture requires a code suggestion.");
    suggestion.replacement = "PROPOSED_ONLY_REPLACEMENT";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(findingSourceQueryKey("viewer", header, finding, 0), value);
    try {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <FindingSource header={header} finding={finding} identity="viewer" />
        </QueryClientProvider>,
      );
      expect(html).toContain("Original source context");
      expect(html).toContain("Proposed replacement");
      expect(html).toContain("has not been applied");
      expect(html).toContain("PROPOSED_ONLY_REPLACEMENT");
      expect(html.indexOf("PROPOSED_ONLY_REPLACEMENT")).toBeGreaterThan(
        html.indexOf("rc-source-suggestion"),
      );
    } finally {
      client.clear();
    }
  });
});
