import type { InvestigationArtifactV1, InvestigationResultV1 } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReportEvidence } from "./report-detail-panels";
import { createSampleInvestigationApi } from "./sample-adapter";

// Keep the real feature/assertion composition while isolating authenticated file loading.
vi.mock("./artifact-panel", () => ({
  ArtifactPanel: ({ artifacts }: { artifacts: InvestigationArtifactV1[] }) => (
    <section aria-label="Test artifact gallery">
      {artifacts.map((artifact) => (
        <article key={artifact.id} data-file-id={artifact.id}>
          {artifact.name}
        </article>
      ))}
    </section>
  ),
}));

function render(result: InvestigationResultV1): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReportEvidence result={result} identity="evidence-composition-viewer" />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

describe("report evidence composition", () => {
  it("renders shared E2E files once while preserving each feature's assertions and references", async () => {
    const result = await createSampleInvestigationApi().exportReport("sample-pr-partial-report");
    const artifact = result.artifacts[0];
    if (!artifact) throw new Error("The fixture must include an artifact.");
    const html = render({
      ...result,
      context: {
        ...result.context,
        sourceArtifacts: [],
        task: { ...result.context.task, kind: "pr-e2e" },
        e2e: {
          headSha: "a".repeat(40),
          buildIdentity: "Synthetic composition fixture",
          cleanup: {
            confirmed: true,
            summary: "Synthetic cleanup receipt",
            recordedAt: "2026-09-20T00:00:00Z",
          },
          features: ["reload", "recovery"].map((id) => ({
            id,
            title: `Recorded ${id}`,
            paths: [],
            scenario: `Observe ${id}`,
            userVisible: true,
            outcome: "passed" as const,
            assertions: [
              {
                id: `${id}-assertion`,
                expected: `${id} state is restored`,
                observed: `${id} state was restored`,
                outcome: "passed" as const,
                evidenceRefs: [],
              },
            ],
            artifactRefs: [artifact.id],
            limitations: [],
          })),
        },
      },
    });
    expect(html.match(/aria-label="Test artifact gallery"/gu)).toHaveLength(1);
    expect(html.match(/data-file-id=/gu)).toHaveLength(result.artifacts.length);
    expect(html).toContain("reload state was restored");
    expect(html).toContain("recovery state was restored");
    expect(html.match(/Registered artifact references:/gu)).toHaveLength(2);
    expect(html).toContain("2 passed");
  });

  it.each(["pr-verify", "issue-verify", "issue-fix"] as const)(
    "does not mislabel %s report files as static captures",
    async (kind) => {
      const result = await createSampleInvestigationApi().exportReport("sample-pr-partial-report");
      const html = render({
        ...result,
        context: { ...result.context, task: { ...result.context.task, kind } },
      });
      expect(html).toContain("Checks");
      expect(html).not.toContain("Files registered by this static investigation");
      expect(html).not.toContain("E2E feature coverage");
      expect(html).not.toContain("GitHub media publication");
      expect(html.match(/data-file-id=/gu)).toHaveLength(result.artifacts.length);
    },
  );
});
