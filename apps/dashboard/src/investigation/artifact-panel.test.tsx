import type { InvestigationArtifactMetadataV1 } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactDetails, ArtifactPanel, assertArtifactBinding } from "./artifact-panel";
import { createSampleInvestigationApi } from "./sample-adapter";

async function fixture() {
  const api = createSampleInvestigationApi();
  const report = await api.exportReport("sample-pr-partial-report");
  const artifact = report.artifacts[0];
  if (!artifact) throw new Error("The partial report omitted its artifact.");
  return { artifact, metadata: await api.artifact(artifact.id) };
}

describe("current artifact availability", () => {
  it("preserves an inherited patch's producer identity and rejects reassignment to the child task", async () => {
    const { artifact, metadata } = await fixture();
    const inherited = {
      ...artifact,
      kind: "patch" as const,
      taskId: "ancestor-task",
      attemptId: "ancestor-attempt",
    };
    const current = { ...metadata, artifact: { ...inherited, availability: "expired" as const } };
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={inherited}
        metadata={current}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("Producer task: ancestor-task");
    expect(html).toContain("Attempt: ancestor-attempt");
    expect(html).toContain("Current availability: expired");
    expect(html).not.toContain("Download artifact");
    expect(() => assertArtifactBinding(inherited, current)).not.toThrow();
    expect(() =>
      assertArtifactBinding(inherited, {
        ...current,
        artifact: { ...current.artifact, taskId: "child-task", attemptId: "child-attempt" },
      }),
    ).toThrow("does not match");
  });

  it("labels inherited patch inputs separately from this task's produced artifacts and validation", () => {
    const inherited = renderToStaticMarkup(<ArtifactPanel artifacts={[]} origin="inherited" />);
    const produced = renderToStaticMarkup(<ArtifactPanel artifacts={[]} />);
    expect(inherited).toContain("Inherited patch sources");
    expect(inherited).toContain("Patch inputs produced by ancestor tasks");
    expect(inherited).toContain("separate from this task&#x27;s validation evidence");
    expect(inherited).not.toContain("Artifacts produced by this task");
    expect(produced).toContain("Artifacts produced by this task");
    expect(produced).not.toContain("Inherited patch sources");
  });

  it("preserves the report snapshot while making expired content unavailable for download", async () => {
    const { artifact, metadata } = await fixture();
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={artifact}
        metadata={metadata}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("Availability recorded in report: available");
    expect(html).toContain("Current availability: expired");
    expect(html).toContain("Artifact content expired");
    expect(html).toContain("historical report is unchanged");
    expect(html).not.toContain("Download artifact");
    expect(html).not.toContain("/content");
  });

  it("does not offer a download while availability is unverified or refreshing has failed", async () => {
    const { artifact, metadata } = await fixture();
    const available: InvestigationArtifactMetadataV1 = {
      ...metadata,
      artifact: { ...artifact, availability: "available" },
      expiredAt: null,
    };
    for (const state of [
      { metadata: undefined, error: undefined },
      { metadata: available, error: "Current availability could not be verified." },
    ]) {
      const html = renderToStaticMarkup(
        <ArtifactDetails
          artifact={artifact}
          {...state}
          busy={false}
          onDownload={() => {}}
          onRefresh={() => {}}
        />,
      );
      expect(html).not.toContain("Download artifact");
    }
  });

  it("accepts availability changes but rejects bytes or lineage from another artifact", async () => {
    const { artifact, metadata } = await fixture();
    expect(() => assertArtifactBinding(artifact, metadata)).not.toThrow();
    for (const changed of [
      { taskId: "another-task" },
      { subjectRef: "another-subject" },
      { digest: "f".repeat(64) },
      { byteLength: artifact.byteLength + 1 },
    ]) {
      expect(() =>
        assertArtifactBinding(artifact, {
          ...metadata,
          artifact: { ...metadata.artifact, ...changed },
        }),
      ).toThrow("does not match");
    }
  });
});
