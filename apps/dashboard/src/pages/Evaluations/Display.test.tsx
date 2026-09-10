import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyValue, EvaluationTable } from "./Display";

describe("Material evaluation displays", () => {
  it("passes a complete local page to the shared table while retaining the full row count", () => {
    const rows = Array.from({ length: 13 }, (_, index) => ({
      id: index + 1,
      label: `visible-record-${index + 1}`,
    }));
    const html = renderToStaticMarkup(
      <EvaluationTable
        rows={rows}
        getRowId={(row) => row.id}
        pageSize={12}
        columns={[{ id: "label", label: "Result", render: (row) => row.label }]}
        ariaLabel="Frozen results"
      />,
    );
    expect(html).toContain('aria-label="Frozen results"');
    expect(html).toContain("visible-record-1");
    expect(html).toContain("visible-record-12");
    expect(html).not.toContain("visible-record-13");
    expect(html).toContain("of 13");
  });

  it("keeps an immutable identifier readable and gives its copy action an accessible name", () => {
    const html = renderToStaticMarkup(<CopyValue value="frozen-result-identity" />);
    expect(html).toContain("frozen-result-identity");
    expect(html).toContain('aria-label="Copy frozen-result-identity"');
    expect(html).toContain("<code");
  });
});
