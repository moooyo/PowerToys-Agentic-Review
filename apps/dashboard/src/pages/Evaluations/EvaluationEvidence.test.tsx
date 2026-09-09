import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cellResultFixture } from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationEvidenceAdapter } from "@/services/evaluation-evidence";
import {
  evidenceListFixture,
  evidenceManifestFixture,
} from "@/services/evaluation-evidence/fixtures.testing";
import type { EvaluationAdapter } from "@/services/evaluations";
import { evaluationTestActor } from "@/services/evaluations/fixtures.testing";
import { EvaluationContext } from "./context";
import { EvaluationEvidence, EvidencePreviewContent } from "./EvaluationEvidence";

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  options: null as {
    enabled: boolean;
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  } | null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: NonNullable<typeof state.options>) => {
    state.options = options;
    return {
      data: state.items,
      error: null,
      isError: false,
      isFetching: false,
      isPending: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
function provider(children: ReactNode, readable = true) {
  return (
    <EvaluationContext.Provider
      value={{
        api: {} as EvaluationAdapter,
        session: "same-session",
        repositoryId: "repository-a",
        principal: evaluationTestActor,
        readable,
        canConfigure: false,
        allowsConfigure: false,
        invalidateAccess: vi.fn(),
      }}
    >
      {children}
    </EvaluationContext.Provider>
  );
}
beforeEach(() => {
  state.items = evidenceListFixture().items;
  state.options = null;
});
describe("evaluation evidence interface", () => {
  it("shows recorded file actions without an unverified image URL or assertion claim", () => {
    const html = renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{} as EvaluationEvidenceAdapter}
        />,
      ),
    );
    expect(html).toContain("Recorded; verify on open");
    expect(html).toContain('aria-label="Preview evidence evidence-build"');
    expect(html).toContain('aria-label="Download evidence evidence-build"');
    expect(html).not.toContain("blob:");
    expect(html).toContain("does not verify a UI assertion");
  });
  it("shows a missing reference without enabling a download", () => {
    state.items = evidenceListFixture(null).items;
    const html = renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{} as EvaluationEvidenceAdapter}
        />,
      ),
    );
    expect(html).toContain("Missing");
    const download = html.match(
      /<button[^>]*aria-label="Download evidence evidence-build"[^>]*>/u,
    )?.[0];
    expect(download).toContain("disabled");
    expect(html).not.toContain("Preview evidence");
  });
  it("keeps retired references visible and traces download-only", () => {
    state.items = evidenceListFixture({
      ...evidenceManifestFixture(),
      state: "retired",
      retiredAt: "2026-09-08T01:00:00.000Z",
    }).items;
    const retired = renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{} as EvaluationEvidenceAdapter}
        />,
      ),
    );
    expect(retired).toContain("Retired");
    expect(
      retired.match(/<button[^>]*aria-label="Download evidence evidence-build"[^>]*>/u)?.[0],
    ).toContain("disabled");
    state.items = evidenceListFixture(evidenceManifestFixture(undefined, "trace")).items;
    const trace = renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{} as EvaluationEvidenceAdapter}
        />,
      ),
    );
    expect(trace).toContain("Download evidence");
    expect(trace).not.toContain("Preview evidence");
  });
  it("stops reads and hides files while the result scope is inactive", () => {
    const html = renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{} as EvaluationEvidenceAdapter}
          active={false}
        />,
      ),
    );
    expect(state.options?.enabled).toBe(false);
    expect(html).not.toContain("evidence-build");
  });
  it("verifies complete report membership before accepting a list", async () => {
    const list = vi.fn<EvaluationEvidenceAdapter["list"]>(async () => ({
      ...evidenceListFixture(),
      items: [],
    }));
    renderToStaticMarkup(
      provider(
        <EvaluationEvidence
          result={cellResultFixture()}
          adapter={{ list } as unknown as EvaluationEvidenceAdapter}
        />,
      ),
    );
    const options = state.options;
    if (!options) throw new Error("Query required.");
    const signal = new AbortController().signal;
    await expect(options.queryFn({ signal })).rejects.toThrow(/exactly/u);
    expect(list.mock.calls[0]?.[1]).toBe(signal);
  });
  it("renders text as escaped content and makes truncation explicit", () => {
    const html = renderToStaticMarkup(
      <EvidencePreviewContent
        preview={{
          kind: "text",
          assetId: "asset",
          text: "<script>alert('x')</script>",
          truncated: true,
        }}
      />,
    );
    expect(html).toContain("Truncated preview");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
