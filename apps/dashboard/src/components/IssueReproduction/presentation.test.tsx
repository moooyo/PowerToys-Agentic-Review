import type {
  DashboardReviewRunReproductionCaseResponse,
  IssueReproductionCaseAssessment,
  ObservationValue,
} from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { assessment, check, detail, predicates, recorded, result } from "./fixtures.testing";
import { AssessmentSummary, CaseAssessmentComparison, ReproductionCaseFacts } from "./presentation";

vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
      <aside>
        <strong>{title}</strong>
        {description}
      </aside>
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
    Table: <Row,>({
      dataSource,
      columns,
      rowKey,
    }: {
      dataSource: Row[];
      columns: { title: string; render: (value: unknown, row: Row) => ReactNode }[];
      rowKey: keyof Row | ((row: Row, index: number) => string);
    }) => (
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.title}>{column.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataSource.map((row, index) => {
            const key = typeof rowKey === "function" ? rowKey(row, index) : String(row[rowKey]);
            return (
              <tr key={key}>
                {columns.map((column) => (
                  <td key={column.title}>{column.render(null, row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    ),
    Space: Content,
    Tag: ({ children, color }: { children?: ReactNode; color?: string }) => (
      <span data-tone={color}>{children}</span>
    ),
    Typography: {
      Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
      Paragraph: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
      Title: ({ children }: { children?: ReactNode }) => <h5>{children}</h5>,
    },
    theme: {
      useToken: () => ({
        token: {
          margin: 16,
          marginXS: 8,
          paddingSM: 12,
          colorPrimaryBorder: "#91caff",
          colorBorderSecondary: "#f0f0f0",
        },
      }),
    },
  };
});

const renderedText = (html: string): string =>
  html
    .replace(/<[^>]*>/gu, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

type TableRow = [string, string, string];

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Expected a rendered value at index ${index}.`);
  return value;
}

function tableRows(html: string): TableRow[][] {
  return [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/gu)].map((table) =>
    [...at(table, 1).matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map((row) => {
      const cells = [...at(row, 1).matchAll(/<td>([\s\S]*?)<\/td>/gu)].map((cell) =>
        renderedText(at(cell, 1)),
      );
      if (cells.length !== 3) throw new Error("Expected three case fact columns.");
      return [at(cells, 0), at(cells, 1), at(cells, 2)];
    }),
  );
}

function factValue(html: string, label: string): string | undefined {
  const match = [...html.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/gu)].find(
    (entry) => renderedText(at(entry, 1)) === label,
  );
  return match ? renderedText(at(match, 2)) : undefined;
}

function assessmentSection(html: string, title: string): string | undefined {
  const match = [
    ...html.matchAll(/<section[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gu),
  ].find((entry) => entry[1] === title);
  return match ? renderedText(at(match, 2)) : undefined;
}

describe("reproduction assessment summary presentation", () => {
  it("shows current and recorded conclusions in separately identified sections", () => {
    const html = renderToStaticMarkup(
      <AssessmentSummary
        assessment={{ ...assessment, conclusion: "blocked", coverage: "partial" }}
        recorded={assessment}
      />,
    );
    expect(assessmentSection(html, "Current assessment")).toContain("BlockedPartial coverage");
    expect(assessmentSection(html, "Current assessment")).not.toContain("Confirmed");
    expect(assessmentSection(html, "Recorded assessment")).toContain("ConfirmedComplete coverage");
    expect(renderedText(html)).toContain("1 configured case(s) · rules version 1");
    expect(renderedText(html)).toContain("recorded assessment is preserved from this saved result");
  });

  it("limits partial coverage to frozen configured contexts and requires explicit absence evidence", () => {
    const html = renderToStaticMarkup(
      <AssessmentSummary assessment={{ ...assessment, coverage: "partial" }} />,
    );
    const text = renderedText(html);
    expect(text).toContain("Partial coverage");
    expect(text).toContain("claim only in its frozen context");
    expect(text).toContain("explicit absent signature for every configured case");
    expect(text).toContain("Missing observations never establish absence");
    expect(text).toContain("configured cases, not all environments");
    expect(assessmentSection(html, "Recorded assessment")).toBeUndefined();
  });

  it.each([
    ["invalid_scope", "Historical · not current"],
    ["execution_pending", "Pending"],
  ] as const)("keeps a %s current view separate from recorded confirmation", (reason, label) => {
    const html = renderToStaticMarkup(
      <AssessmentSummary
        assessment={{ ...assessment, cases: [{ ...recorded, reasons: [reason] }] }}
        recorded={assessment}
      />,
    );
    expect(assessmentSection(html, "Current assessment")).toContain(label);
    expect(assessmentSection(html, "Current assessment")).not.toContain("Confirmed");
    expect(assessmentSection(html, "Recorded assessment")).toContain("Confirmed");
  });
});

describe("reproduction case fact presentation", () => {
  it("renders each false-like typed observation in the observed column of both allOf signatures", () => {
    const html = renderToStaticMarkup(<ReproductionCaseFacts detail={detail} result={result} />);
    const rows = tableRows(html);
    expect(renderedText(html)).toContain("Present signature · all conditions must hold");
    expect(renderedText(html)).toContain("Absent signature · all conditions must hold");
    expect(rows).toHaveLength(3);
    expect(at(rows, 1).map((row) => row[0])).toEqual([
      "UI assertion · save / focused",
      "Probe value · measure / count",
      "Probe value · measure / message",
    ]);
    expect(at(rows, 1).map((row) => row[1])).toEqual([
      "boolean · false",
      "number · 0",
      'string · ""',
    ]);
    expect(at(rows, 1).map((row) => row[2])).toEqual([
      "boolean · falseevidence-1",
      "number · 0evidence-2",
      'string · ""evidence-3',
    ]);
    expect(at(rows, 2).map((row) => row[1])).toEqual([
      "boolean · true",
      "number · 1",
      'string · "Saved"',
    ]);
    expect(at(rows, 2).map((row) => row[2])).toEqual(at(rows, 1).map((row) => row[2]));
  });

  it("keeps required precondition expectations separate from recorded check and observation outcomes", () => {
    const html = renderToStaticMarkup(<ReproductionCaseFacts detail={detail} result={result} />);
    const rows = at(tableRows(html), 0);
    expect(renderedText(html)).toContain("Preconditions · all required");
    expect(at(rows, 0)[0]).toBe(`Worker check · ${check.id}`);
    expect(at(rows, 0)[1]).toBe("Passed");
    expect(at(rows, 0)[2]).toContain(`Recorded check · ${check.outcome}`);
    for (const evidenceId of check.evidenceIds) expect(at(rows, 0)[2]).toContain(evidenceId);
    expect(rows[1]).toEqual([
      "UI assertion · save / focused",
      "boolean · false",
      "boolean · false",
    ]);
  });

  it("does not invent a passed precondition when its saved check is missing", () => {
    const missingCheck: DashboardReviewRunReproductionCaseResponse = {
      ...detail,
      case: {
        ...detail.case,
        preconditions: [{ kind: "check_passed", checkId: "missing:check" }],
      },
    };
    for (const savedResult of [null, result]) {
      const html = renderToStaticMarkup(
        <ReproductionCaseFacts detail={missingCheck} result={savedResult} />,
      );
      expect(at(tableRows(html), 0)[0]).toEqual([
        "Worker check · missing:check",
        "Passed",
        "Check outcome not recorded",
      ]);
    }
  });

  it.each([
    ["windows_desktop", "Windows UI"],
    ["web", "Web UI"],
    ["headless", "Headless"],
  ] as const)("displays the frozen %s target and immutable case identity", (target, label) => {
    const html = renderToStaticMarkup(
      <ReproductionCaseFacts
        detail={{ ...detail, case: { ...detail.case, target } }}
        result={result}
      />,
    );
    expect(factValue(html, "Execution target")).toBe(label);
    expect(factValue(html, "Case ID")).toBe(detail.case.id);
    expect(factValue(html, "Tested source commit")).toBe(detail.binding.testedSourceCommit);
    expect(factValue(html, "Profile version ID")).toBe(detail.case.profileVersionId);
    expect(factValue(html, "Profile configuration digest")).toBe(detail.case.profileConfigSha256);
    expect(renderedText(html)).toContain(detail.case.context);
  });

  it("describes the limit of a positive-only case without manufacturing an absent signature", () => {
    const html = renderToStaticMarkup(
      <ReproductionCaseFacts
        detail={{ ...detail, case: { ...detail.case, preconditions: [], absentWhen: null } }}
        result={result}
      />,
    );
    expect(renderedText(html)).toContain("No additional preconditions were configured");
    expect(renderedText(html)).toContain("No absent signature configured");
    expect(renderedText(html)).toContain(
      "Failure to match the present signature cannot establish absence",
    );
    expect(renderedText(html)).not.toContain("Absent signature · all conditions must hold");
    expect(tableRows(html)).toHaveLength(1);
  });

  it.each(["missing_element", "capture_failed", "evidence_unavailable"])(
    "displays %s as unavailable even when the signature expects false",
    (reason) => {
      const unavailable: DashboardReviewRunReproductionCaseResponse = {
        ...detail,
        observations: [
          {
            observation: predicates[0].observation,
            state: "unavailable",
            reason,
            checkId: "save:focused",
            evidenceIds: [],
          },
        ],
      };
      const html = renderToStaticMarkup(
        <ReproductionCaseFacts detail={unavailable} result={result} />,
      );
      const rows = tableRows(html);
      const precondition = at(at(rows, 0), 1);
      const signature = at(rows, 1);
      expect(precondition[1]).toBe("boolean · false");
      expect(precondition[2]).toBe(`Unavailable · ${reason.replaceAll("_", " ")}`);
      expect(at(signature, 0)[1]).toBe("boolean · false");
      expect(at(signature, 0)[2]).toContain(`Unavailable · ${reason.replaceAll("_", " ")}`);
      expect(at(signature, 0)[2]).not.toContain("boolean · false");
      expect(at(signature, 1)[2]).toBe("Not observed");
      expect(at(signature, 2)[2]).toBe("Not observed");
      expect(renderedText(html)).toContain(
        "missing evidence do not become an observed false value",
      );
    },
  );

  it("does not use a neighboring observation with the same final step identifier", () => {
    const other = {
      ...detail,
      observations: [
        {
          observation: { kind: "ui_assertion" as const, scenarioId: "another", stepId: "focused" },
          state: "observed" as const,
          value: { type: "boolean", value: true } satisfies ObservationValue,
          checkId: "save:focused",
          evidenceIds: ["other-evidence"],
        },
      ],
    };
    const html = renderToStaticMarkup(<ReproductionCaseFacts detail={other} result={result} />);
    expect(at(at(tableRows(html), 1), 0)[2]).toBe("Not observed");
    expect(renderedText(html)).not.toContain("other-evidence");
  });
});

describe("recorded and current case presentation", () => {
  it.each([
    [
      "inconclusive",
      "invalid_scope",
      "Historical · not current",
      "historical or its run is no longer current",
    ],
    [
      "inconclusive",
      "execution_pending",
      "Pending",
      "Execution or evidence verification is pending",
    ],
    ["blocked", "evidence_unavailable", "Blocked", "Required evidence is unavailable"],
  ] as const)(
    "retains recorded presence when current state is %s because of %s",
    (state, reason, label, explanation) => {
      const current: IssueReproductionCaseAssessment = { ...recorded, state, reasons: [reason] };
      const html = renderToStaticMarkup(
        <ReproductionCaseFacts detail={{ ...detail, current }} result={result} />,
      );
      expect(factValue(html, "Current case state")).toBe(label);
      expect(factValue(html, "Recorded case state")).toBe("Present");
      expect(renderedText(html)).toContain("Current assessment reasons");
      expect(renderedText(html)).toContain(explanation);
      expect(at(at(tableRows(html), 1), 0)[2]).toContain("boolean · false");
    },
  );

  it("labels an unrecorded case without turning it into an absent result", () => {
    const html = renderToStaticMarkup(
      <CaseAssessmentComparison
        detail={{
          ...detail,
          current: { ...recorded, state: "inconclusive", reasons: ["execution_pending"] },
          recorded: null,
        }}
      />,
    );
    expect(factValue(html, "Current case state")).toBe("Pending");
    expect(factValue(html, "Recorded case state")).toBe("Not recorded");
    expect(renderedText(html)).not.toContain("Absent");
  });

  it("keeps recorded reasons distinct from current availability reasons", () => {
    const html = renderToStaticMarkup(
      <CaseAssessmentComparison
        detail={{
          ...detail,
          current: { ...recorded, state: "blocked", reasons: ["capture_unavailable"] },
          recorded: { ...recorded, state: "inconclusive", reasons: ["positive_only"] },
        }}
      />,
    );
    expect(factValue(html, "Current case state")).toBe("Blocked");
    expect(factValue(html, "Recorded case state")).toBe("Inconclusive");
    expect(renderedText(html)).toContain(
      "Current assessment reasonsThe required capture is unavailable",
    );
    expect(renderedText(html)).toContain("Recorded reasons: No absent signature was configured");
  });
});
