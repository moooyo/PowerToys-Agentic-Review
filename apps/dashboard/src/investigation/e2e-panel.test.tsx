import type { InvestigationE2eResult } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { E2eCoveragePanel, e2eOutcomeSummary } from "./e2e-panel";

const e2e: InvestigationE2eResult = {
  headSha: "a".repeat(40),
  buildIdentity: "PowerToys task-owned Debug build",
  cleanup: {
    confirmed: true,
    recordedAt: "2026-09-19T01:00:00Z",
    summary: "Owned application processes stopped.",
  },
  features: [
    {
      id: "feature-preview",
      title: "Preview file replacement",
      paths: ["src/Previewer.cs"],
      scenario: "Open a file, replace the selected item, then close the preview.",
      userVisible: true,
      outcome: "passed",
      assertions: [
        {
          id: "assert-release",
          expected: "The old preview releases its file handle.",
          observed: "The old file was renamed while the next preview stayed visible.",
          outcome: "passed",
          evidenceRefs: ["evidence-handle"],
        },
      ],
      artifactRefs: ["preview-video"],
      limitations: [],
    },
    {
      id: "feature-fallback",
      title: "Error fallback",
      paths: ["src/Previewer.cs"],
      scenario: "Open an invalid input.",
      userVisible: true,
      outcome: "not_run",
      assertions: [
        {
          id: "assert-fallback",
          expected: "Fallback appears.",
          observed: "Prerequisite missing.",
          outcome: "not_run",
          evidenceRefs: [],
        },
      ],
      artifactRefs: [],
      limitations: ["The required invalid-file fixture was unavailable."],
    },
  ],
};

describe("E2E feature evidence presentation", () => {
  it("maps each feature to actual assertions, evidence, and missing coverage", () => {
    const html = renderToStaticMarkup(<E2eCoveragePanel result={e2e} />);
    expect(html).toContain(e2e.headSha);
    expect(html).toContain("Preview file replacement");
    expect(html).toContain("Expected:");
    expect(html).toContain("old file was renamed");
    expect(html).toContain("evidence-handle");
    expect(html).toContain("Loading screenshots and videos for this feature");
    expect(html).toContain("Not run");
    expect(html).toContain("No screenshot or video evidence was recorded");
    expect(html).toContain("Desktop cleanup confirmed");
  });

  it("does not infer E2E success when feature results are absent", () => {
    expect(renderToStaticMarkup(<E2eCoveragePanel />)).toContain(
      "does not establish runtime verification",
    );
  });

  it("keeps task results separate from artifact loading and counts outcomes explicitly", () => {
    expect(e2eOutcomeSummary(e2e)).toBe("1 passed · 1 not run");
    const html = renderToStaticMarkup(<E2eCoveragePanel result={e2e} showArtifacts={false} />);
    expect(html).toContain("Registered artifact references");
    expect(html).toContain("preview-video");
    expect(html).toContain("uploaded media alone does not establish a pass");
    expect(html).not.toContain("Loading screenshots and videos");
  });

  it("identifies absent artifact records without changing the recorded assertions", () => {
    const html = renderToStaticMarkup(<E2eCoveragePanel result={e2e} artifacts={[]} />);
    expect(html).toContain("Some referenced artifact records are unavailable");
    expect(html).toContain("The old file was renamed");
    expect(html).toContain("1 passed · 1 not run");
  });
});
