import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createReportDraft } from "./report-draft-store";
import { ReportFindingsReader } from "./report-findings-reader";
import { selectionContext } from "./report-state";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("complete report reader", () => {
  it("opens the off-page P0 from a public finding link and keeps report feedback private", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p0-report");
    const result = await api.exportReport(header.report.id);
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    const p0 = result.findings.find((finding) => finding.priority === "P0");
    if (!p0) throw new Error("The sample must contain its off-page P0.");
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          `/reports?reportId=${header.report.id}&findingId=${p0.id}&findingPriority=P0`,
        ]}
      >
        <ReportFindingsReader
          header={header}
          result={result}
          context={context}
          loading={false}
          draft={createReportDraft(selectionContext(context))}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit
          canPublish
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(p0.title);
    expect(html).toContain(`aria-label="Finding ${p0.ordinal + 1}:`);
    expect(html).toContain("Search all findings");
    expect(html).toContain("Review selected");
    expect(html).toContain("Private feedback saved for this session");
  });

  it("does not silently replace an unavailable deep-linked finding", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const result = await api.exportReport(header.report.id);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/reports?reportId=${header.report.id}&findingId=missing`]}>
        <ReportFindingsReader
          header={header}
          result={result}
          loading={false}
          draft={createReportDraft({
            reportId: header.report.id,
            reportVersion: header.report.version,
            recommendedAction: null,
            suggestionOptions: [],
          })}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit={false}
          canPublish={false}
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Finding unavailable");
    expect(html).toContain("This link does not identify a finding in the complete saved report");
    expect(html).not.toContain("Save draft &amp; next");
  });

  it("waits for the complete collection instead of claiming an empty report", async () => {
    const header = await createSampleInvestigationApi().report("sample-pr-p0-report");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReportFindingsReader
          header={header}
          loading
          draft={createReportDraft({
            reportId: header.report.id,
            reportVersion: header.report.version,
            recommendedAction: null,
            suggestionOptions: [],
          })}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit={false}
          canPublish={false}
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading the complete saved collection");
    expect(html).not.toContain("No review findings");
  });
});
