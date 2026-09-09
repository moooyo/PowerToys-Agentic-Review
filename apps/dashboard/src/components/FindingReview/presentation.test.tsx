import type { FindingComparisonResponse, FindingComparisonRow } from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { context, event, listResponse, occurrence } from "./fixtures.testing";
import {
  FindingBinding,
  FindingComparisonView,
  FindingEvent,
  FindingSummary,
  OriginalFinding,
} from "./presentation";

vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
      <aside>
        {title}
        {description}
      </aside>
    ),
    Collapse: ({ items }: { items: { key: string; label: ReactNode; children: ReactNode }[] }) => (
      <div>
        {items.map((item) => (
          <details key={item.key}>
            <summary>{item.label}</summary>
            {item.children}
          </details>
        ))}
      </div>
    ),
    Descriptions: ({
      items,
    }: {
      items: { key: string; label: ReactNode; children: ReactNode }[];
    }) => (
      <dl>
        {items.map((item) => (
          <div key={item.key}>
            <dt>{item.label}</dt>
            <dd>{item.children}</dd>
          </div>
        ))}
      </dl>
    ),
    Table: ({
      dataSource,
      columns,
    }: {
      dataSource: FindingComparisonRow[];
      columns: {
        title: string;
        render: (value: unknown, row: FindingComparisonRow) => ReactNode;
      }[];
    }) => (
      <div>
        {dataSource.map((row) => (
          <article key={`${row.before?.key ?? "none"}:${row.after?.key ?? "none"}`}>
            {columns.map((column) => (
              <div key={column.title}>
                {column.title}
                {column.render(null, row)}
              </div>
            ))}
          </article>
        ))}
      </div>
    ),
    Space: Content,
    Tag: Content,
    Typography: { Paragraph: Content, Text: Content },
  };
});
const side = {
  key: occurrence.key,
  resultId: occurrence.resultId,
  resultDigest: occurrence.resultDigest,
  kind: occurrence.kind,
  ordinal: occurrence.ordinal,
  title: occurrence.title,
  priority: occurrence.priority,
  path: occurrence.path,
  line: occurrence.line,
};
const comparison: FindingComparisonResponse = {
  algorithmVersion: "exact-content-v1",
  before: { ...context, resultId: "baseline", contextDigest: "1".repeat(64) },
  after: context,
  compatible: true,
  reasons: [],
  items: [
    {
      status: "persistent",
      before: side,
      after: { ...side, key: "2".repeat(64), line: 98 },
      reason: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

describe("original finding and disposition presentation", () => {
  it("renders original model content and stable identity without modifying the text", () => {
    const html = renderToStaticMarkup(<OriginalFinding finding={occurrence} />);
    for (const text of [
      occurrence.body,
      occurrence.modelId,
      occurrence.key,
      "src/private.ts:42–44",
      "Original array index",
      "Version 0",
      "95%",
    ])
      expect(html).toContain(text);
  });
  it("shows nullable locations and confidence without inventing facts", () => {
    const html = renderToStaticMarkup(
      <OriginalFinding
        finding={{ ...occurrence, path: null, line: null, endLine: null, confidence: null }}
      />,
    );
    expect(html).toContain("Not recorded");
    expect(html).not.toContain("null:null");
    expect(html).not.toContain("0%");
  });
  it("keeps reported counts visible after all blocking findings were dismissed", () => {
    const html = renderToStaticMarkup(
      <FindingSummary
        summary={{ ...listResponse.summary, open: 0, dismissed: 1, unresolvedBlocking: 0 }}
      />,
    );
    expect(html).toContain("Reported P0 / P1 findings");
    expect(html).toContain("Unresolved P0 / P1 findings");
    expect(html).toContain("required checks and evidence must still pass");
    expect(html).toContain("Each rerun starts with its own findings and dispositions");
  });
  it("shows exact actor, immutable reason and both distinct context and result-set digests", () => {
    const html = renderToStaticMarkup(<FindingEvent event={event} />);
    for (const text of [
      event.actor.issuer,
      event.actor.subject,
      event.reason,
      event.contextDigestAtChange,
      event.resultSetDigestAtChange,
      event.changeId,
      event.id,
      "Confirmed · unresolved",
      "0 → 1",
    ])
      expect(html).toContain(text);
  });
  it("describes source freshness and profile/prompt bindings for the selected result", () => {
    const html = renderToStaticMarkup(
      <FindingBinding
        context={{ ...context, historical: true, sourceCurrent: false, latestForRequest: false }}
      />,
    );
    for (const text of [
      context.reviewRunId,
      context.requestId,
      context.jobId,
      context.revisionKey,
      context.planDigest,
      context.profileVersionId,
      context.promptVersionId,
      "Source current",
      "Latest activation for request",
      "No",
    ])
      expect(html).toContain(text);
  });
});

describe("conservative finding comparison", () => {
  it("presents persistent matches with changed line numbers and no inherited disposition", () => {
    const html = renderToStaticMarkup(<FindingComparisonView comparison={comparison} />);
    expect(html).toContain("Still reported");
    expect(html).toContain("src/private.ts:98");
    expect(html).toContain("dispositions never carry over");
    expect(html).toContain("unique, exact normalized content");
  });
  it("does not turn an absent earlier finding into an automatic resolution", () => {
    const html = renderToStaticMarkup(
      <FindingComparisonView
        comparison={{
          ...comparison,
          items: [{ status: "not_observed_again", before: side, after: null, reason: null }],
        }}
      />,
    );
    expect(html).toContain("Not observed again");
    expect(html).toContain("not automatically resolved");
    expect(html).not.toContain("Resolved by reviewer");
  });
  it("labels a new finding without reporting an earlier disposition", () => {
    const html = renderToStaticMarkup(
      <FindingComparisonView
        comparison={{
          ...comparison,
          items: [{ status: "new", before: null, after: side, reason: null }],
        }}
      />,
    );
    expect(html).toContain("Newly reported");
    expect(html).toContain("No paired finding");
    expect(html).not.toContain("Confirmed · unresolved");
  });
  it.each([
    "configuration_changed",
    "model_unavailable",
    "same_result",
    "baseline_not_earlier",
  ] as const)("shows %s as an incompatible comparison", (reason) => {
    const html = renderToStaticMarkup(
      <FindingComparisonView
        comparison={{
          ...comparison,
          compatible: false,
          reasons: [reason],
          items: [
            {
              status: "incomparable",
              before: side,
              after: null,
              reason:
                reason === "configuration_changed" || reason === "model_unavailable"
                  ? reason
                  : null,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Results are not comparable");
    expect(html).toContain("Cannot compare");
    expect(html).not.toContain("Not observed again");
  });
  it("shows ambiguous duplicates as incomparable despite an otherwise compatible configuration", () => {
    const html = renderToStaticMarkup(
      <FindingComparisonView
        comparison={{
          ...comparison,
          items: [{ status: "incomparable", before: side, after: null, reason: "ambiguous_match" }],
        }}
      />,
    );
    expect(html).toContain("multiple possible matches");
    expect(html).toContain("Cannot compare");
    expect(html).not.toContain("Still reported");
  });
});
