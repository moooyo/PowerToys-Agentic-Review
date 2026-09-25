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
    expect(html).toContain("Search findings");
    expect(html).toContain("Include in feedback");
    expect(html).not.toContain("Private feedback saved for this session");
  });

  it.each([true, false])(
    "keeps the sixth finding in its directory window with a selected checkbox when canEdit is %s",
    async (canEdit) => {
      const api = createSampleInvestigationApi();
      const header = await api.report("sample-pr-p0-report");
      const result = await api.exportReport(header.report.id);
      const finding = result.findings[5];
      if (!finding) throw new Error("The sample must contain a sixth finding.");
      const draft = createReportDraft({
        reportId: header.report.id,
        reportVersion: header.report.version,
        recommendedAction: null,
        suggestionOptions: [],
      });
      draft.current = {
        ...draft.current,
        selection: {
          ...draft.current.selection,
          selectedFindings: [
            { findingId: finding.id, draftId: finding.feedbackDraft.id, suggestionId: null },
          ],
        },
      };
      const html = renderToStaticMarkup(
        <MemoryRouter
          initialEntries={[`/reports?reportId=${header.report.id}&findingId=${finding.id}`]}
        >
          <ReportFindingsReader
            header={header}
            result={result}
            loading={false}
            draft={draft}
            onDraft={() => {}}
            dispatch={() => {}}
            canEdit={canEdit}
            canPublish={canEdit}
            onPublish={() => {}}
          />
        </MemoryRouter>,
      );
      const directoryEntries = [...html.matchAll(/data-finding-id="([^"]+)"/gu)];
      expect(directoryEntries.map((entry) => entry[1])).toEqual(
        result.findings.slice(5, 10).map((entry) => entry.id),
      );
      const currentEntry = html
        .match(/<button\b[^>]*>/gu)
        ?.find((entry) => entry.includes(`data-finding-id="${finding.id}"`));
      expect(currentEntry).toContain('aria-current="true"');
      expect(html).toContain(`aria-label="Finding 6: ${finding.title}"`);
      expect(html).toContain("6–10 of 26");
      expect(html).toContain("Show all 25 on this page");
      const choice = html
        .match(/<label\b[^>]*>[\s\S]*?<\/label>/gu)
        ?.find((label) => label.includes(`aria-label="Include ${finding.title} in feedback"`));
      const checkbox = choice?.match(/<input\b[^>]*>/u)?.[0];
      expect(choice).toContain("Include in feedback");
      expect(checkbox).toContain('type="checkbox"');
      expect(checkbox).toContain('checked=""');
      expect(checkbox?.includes('disabled=""')).toBe(!canEdit);
    },
  );

  it("keeps a selected edited finding readable when the retained filters exclude it", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p0-report");
    const result = await api.exportReport(header.report.id);
    const finding = result.findings[5];
    if (!finding) throw new Error("The sample must contain a sixth finding.");
    const draft = createReportDraft({
      reportId: header.report.id,
      reportVersion: header.report.version,
      recommendedAction: null,
      suggestionOptions: [],
    });
    draft.current = {
      ...draft.current,
      editedBodies: { [finding.feedbackDraft.id]: "Retained feedback outside the P0 filter" },
      selection: {
        ...draft.current.selection,
        selectedFindings: [
          { findingId: finding.id, draftId: finding.feedbackDraft.id, suggestionId: null },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          `/reports?reportId=${header.report.id}&findingId=${finding.id}&findingPriority=P0`,
        ]}
      >
        <ReportFindingsReader
          header={header}
          result={result}
          loading={false}
          draft={draft}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit
          canPublish
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(`aria-label="Finding 6: ${finding.title}"`);
    expect(html).toContain("This finding is hidden by the current filters.");
    expect(html).toContain("Clear filters");
    expect(html).toContain("1 selected");
    expect(html).toContain("Retained feedback outside the P0 filter");
    expect(html).toContain("Publish selected");
    expect(html).not.toContain("Finding unavailable");
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
    expect(html).toContain("This link does not identify a finding in this report");
    expect(html).toContain("Open first finding");
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
    expect(html).toContain("Loading findings");
    expect(html).not.toContain("No review findings");
  });

  it("shows a single finding without redundant navigation and ignores obsolete filters", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-bug-report");
    const result = await api.exportReport(header.report.id);
    const finding = result.findings[0];
    if (!finding) throw new Error("The fixture requires a finding.");
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          `/reports?reportId=${header.report.id}&findingSearch=unmatched&findingPriority=P0`,
        ]}
      >
        <ReportFindingsReader
          header={header}
          result={{ ...result, findings: [finding] }}
          loading={false}
          draft={createReportDraft({
            reportId: header.report.id,
            reportVersion: header.report.version,
            recommendedAction: null,
            suggestionOptions: [],
          })}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit
          canPublish
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(finding.title);
    expect(html).toContain("report-findings-single");
    expect(html).not.toContain('id="report-finding-directory"');
    expect(html).not.toContain('id="report-findings-tools"');
    expect(html).not.toContain("Previous page");
    expect(html).not.toContain("No matching findings");
  });

  it("keeps save and publish available outside filters for a selected edited single finding", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-bug-report");
    const result = await api.exportReport(header.report.id);
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    const finding = result.findings[0];
    if (!finding) throw new Error("The fixture requires a finding.");
    const draft = createReportDraft(selectionContext(context));
    draft.current = {
      ...draft.current,
      editedBodies: { [finding.feedbackDraft.id]: "Updated feedback" },
      selection: {
        ...draft.current.selection,
        selectedFindings: [
          { findingId: finding.id, draftId: finding.feedbackDraft.id, suggestionId: null },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReportFindingsReader
          header={header}
          result={{ ...result, findings: [finding] }}
          context={context}
          loading={false}
          draft={draft}
          onDraft={() => {}}
          dispatch={() => {}}
          canEdit
          canPublish
          onPublish={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Unsaved feedback");
    expect(html).toContain("Save draft");
    expect(html).toContain("Publish selected");
    expect(html).toContain("Updated feedback");
    expect(html).not.toContain('id="report-findings-tools"');
  });
});
