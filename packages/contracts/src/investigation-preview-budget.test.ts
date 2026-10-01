import { describe, expect, it } from "vitest";
import { createInvestigationPreview } from "./investigation-preview.js";

describe("investigation preview execution policy", () => {
  it.each(["pr", "bug", "feature"] as const)(
    "uses only the fixed duration and report capacity for %s previews",
    (kind) => {
      const preview = createInvestigationPreview(kind, { findingCount: 20 });
      expect(preview.task.budget).toEqual({
        maxDurationMs: 7_200_000,
        maxReportBytes: 8 * 1024 * 1024,
      });
      expect(preview.result.report.loop?.budget).toEqual(preview.task.budget);
    },
  );
});
