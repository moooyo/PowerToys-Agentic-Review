import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { InvestigationInputSnapshotV1Schema } from "./investigation-execution.js";

const snapshot = {
  schemaVersion: "InvestigationInputSnapshotV1",
  repositoryId: "repo-fixture",
  workItemId: "item-fixture",
  subjectRef: "subject-fixture",
  subjectRevisionKey: "a".repeat(64),
  title: "Synthetic source discussion",
  body: "The complete original issue text.",
  comments: [{ id: "comment-1", body: "The complete original comment.\nNo text was removed." }],
  source: null,
};

describe("investigation input comment provenance", () => {
  it("accepts existing snapshots without provenance", () => {
    expect(Value.Check(InvestigationInputSnapshotV1Schema, snapshot)).toBe(true);
  });

  it("retains exact comment content alongside the narrow optional annotation", () => {
    const annotated = {
      ...snapshot,
      comments: snapshot.comments.map((comment) => ({
        ...comment,
        provenance: { kind: "agentic_review_progress", publicationId: "publication-fixture" },
      })),
    };
    expect(Value.Check(InvestigationInputSnapshotV1Schema, annotated)).toBe(true);
    expect(annotated.comments[0]?.body).toBe(snapshot.comments[0]?.body);
  });

  it.each([
    { kind: "trusted_instruction", publicationId: "publication-fixture" },
    { kind: "agentic_review_progress" },
    { kind: "agentic_review_progress", publicationId: "publication-fixture", execute: true },
  ])("rejects unsupported provenance fields: %j", (provenance) => {
    expect(
      Value.Check(InvestigationInputSnapshotV1Schema, {
        ...snapshot,
        comments: [{ ...snapshot.comments[0], provenance }],
      }),
    ).toBe(false);
  });
});
