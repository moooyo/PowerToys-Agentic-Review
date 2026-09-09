import type { JobAdmission as Admission } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { executionLabel } from "../ReviewRuns/presentation";
import { JobAdmission } from "./index";

const at = "2026-09-07T08:00:00.000Z";
const pending: Admission = {
  state: "pending",
  attemptBase: 2,
  requestedAt: at,
  admittedAt: null,
  timestampBasis: "recorded",
};
describe("waiting admission presentation", () => {
  it("keeps a real pending job distinct from no job and an admitted retry", () => {
    expect(executionLabel("queued", pending)).toBe("Awaiting admission");
    expect(executionLabel("retry_waiting", pending)).toBe("Awaiting admission");
    expect(executionLabel(undefined)).toBe("Not scheduled");
    expect(executionLabel("retry_waiting", { ...pending, state: "admitted", admittedAt: at })).toBe(
      "Queued",
    );
    expect(renderToStaticMarkup(<JobAdmission admission={pending} />)).toContain(
      "No new attempt has started",
    );
  });
  it("does not render queue state for active or terminal projections", () => {
    expect(renderToStaticMarkup(<JobAdmission admission={null} />)).toBe("");
  });
  it("does not pass migration timestamps off as original queue entry", () => {
    const html = renderToStaticMarkup(
      <JobAdmission
        admission={{
          ...pending,
          state: "admitted",
          admittedAt: at,
          timestampBasis: "migration_backfill",
        }}
      />,
    );
    expect(html).toContain("Migration record");
    expect(html).toContain("original queue entry time was not retained");
    expect(html).not.toContain("Entered queue");
  });
});
