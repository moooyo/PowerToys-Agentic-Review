import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type InvestigationAnalysisV1,
  InvestigationAnalysisV1Schema,
  InvestigationCheckpointRequestSchema,
  InvestigationReportHeaderV1Schema,
  InvestigationResultV1Schema,
  InvestigationRuntimeStateSchema,
  type InvestigationSourceProvenance,
  InvestigationSourceProvenanceSchema,
  type InvestigationSubjectV1,
  validateInvestigationResult,
  validateInvestigationSourceProvenance,
} from "./investigation.js";
import { createInvestigationFixture } from "./investigation.testing.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const rootSha = "a".repeat(40);
const childSha = "b".repeat(40);
const nestedSha = "c".repeat(40);
const subject: InvestigationSubjectV1 = {
  id: "source-subject",
  repositoryId: "repository",
  workItemId: "work-item",
  revisionKey: "d".repeat(64),
  kind: "source_commit",
  commitSha: rootSha,
};
const binding = { subjectRef: subject.id, subjects: [subject] };

function provenance(): InvestigationSourceProvenance {
  return {
    subjectRef: subject.id,
    sourceSha: rootSha,
    // Declaration order is not an authority for the dependency parent relationship.
    submodules: [
      {
        path: "vendor/library/deps/nested",
        repository: "Example/Nested",
        commitSha: nestedSha,
        parentPath: "vendor/library",
        parentCommitSha: childSha,
      },
      {
        path: "vendor/library",
        repository: "Example/Library",
        commitSha: childSha,
        parentPath: null,
        parentCommitSha: rootSha,
      },
    ],
  };
}

function rootModule(path: string): InvestigationSourceProvenance["submodules"][number] {
  return { ...provenance().submodules[1]!, path };
}

describe("trusted investigation source provenance", () => {
  it("keeps historical reports without provenance valid", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 0 });
    expect(result.context.sourceProvenance).toBeUndefined();
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it("preserves dependency pins in full reports and report header contexts", () => {
    const { task, result } = createInvestigationFixture("pr", { findingCount: 0 });
    const primary = task.subjects.find((entry) => entry.id === task.subjectRef);
    if (primary?.kind !== "original_pr") throw new Error("Expected an original PR fixture.");
    const pinned = provenance();
    pinned.subjectRef = primary.id;
    pinned.sourceSha = primary.headSha;
    pinned.submodules[1]!.parentCommitSha = primary.headSha;
    result.context.sourceProvenance = pinned;
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(Value.Check(InvestigationReportHeaderV1Schema.properties.context, result.context)).toBe(
      true,
    );
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    pinned.submodules[0]!.parentCommitSha = "f".repeat(40);
    expect(validateInvestigationResult(result).errors).toContainEqual(
      expect.objectContaining({
        path: "/context/sourceProvenance/submodules/0/parentPath",
        code: "SOURCE_PROVENANCE_PARENT_MISMATCH",
      }),
    );
  });

  it("accepts an unordered nested graph and preserves repository name casing", () => {
    const value = provenance();
    expect(Value.Check(InvestigationSourceProvenanceSchema, value)).toBe(true);
    expect(validateInvestigationSourceProvenance(value, binding)).toEqual({
      valid: true,
      errors: [],
    });
    expect(value.submodules[0]!.repository).toBe("Example/Nested");
  });

  it("accepts the bounded maximum graph and ordinary Windows filename characters", () => {
    const value = provenance();
    value.submodules = Array.from({ length: 128 }, (_, index) =>
      rootModule(`@deps/-lib%,;${index}`),
    );
    expect(Value.Check(InvestigationSourceProvenanceSchema, value)).toBe(true);
    expect(validateInvestigationSourceProvenance(value, binding)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each([0, 129])("rejects a graph containing %i dependencies", (count) => {
    const value = {
      ...provenance(),
      submodules: Array.from({ length: count }, (_, index) => rootModule(`deps/${index}`)),
    };
    expect(Value.Check(InvestigationSourceProvenanceSchema, value)).toBe(false);
    expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
  });

  it.each(["sourceSha", "commitSha", "parentCommitSha"] as const)(
    "requires an exact lowercase SHA-1 for %s",
    (field) => {
      for (const invalidSha of [
        "a".repeat(39),
        "a".repeat(41),
        "a".repeat(64),
        "A".repeat(40),
        "g".repeat(40),
      ]) {
        const value = provenance();
        if (field === "sourceSha") value.sourceSha = invalidSha;
        else value.submodules[0]![field] = invalidSha;
        expect(Value.Check(InvestigationSourceProvenanceSchema, value)).toBe(false);
        expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
      }
    },
  );

  it.each(
    [undefined, null, false, 1, "source", [], {}, { ...provenance(), submodules: null }].map(
      (value) => ({ value }),
    ),
  )("rejects malformed unknown provenance without throwing: %j", ({ value }) => {
    expect(validateInvestigationSourceProvenance(value, binding)).toMatchObject({ valid: false });
  });

  it.each(["root", "dependency"] as const)("rejects extra fields on the %s", (target) => {
    const value = provenance();
    const malformed =
      target === "root"
        ? { ...value, coverage: "reviewed" }
        : { ...value, submodules: [{ ...value.submodules[0], reviewed: true }] };
    expect(Value.Check(InvestigationSourceProvenanceSchema, malformed)).toBe(false);
    expect(validateInvestigationSourceProvenance(malformed, binding).valid).toBe(false);
  });

  it("fails closed when untrusted property access throws", () => {
    const malformed = Object.defineProperty(provenance(), "sourceSha", {
      get() {
        throw new Error("Untrusted getter.");
      },
    });
    expect(validateInvestigationSourceProvenance(malformed, binding)).toEqual({
      valid: false,
      errors: [expect.objectContaining({ code: "INVALID_SOURCE_PROVENANCE" })],
    });
  });

  it.each(["source_commit", "original_pr", "remote_branch", "local_patch"] as const)(
    "binds the exact materialized commit of a %s primary subject",
    (kind) => {
      const common = {
        id: subject.id,
        repositoryId: subject.repositoryId,
        workItemId: subject.workItemId,
        revisionKey: subject.revisionKey,
      };
      const primary: InvestigationSubjectV1 =
        kind === "source_commit"
          ? { ...common, kind, commitSha: rootSha }
          : kind === "original_pr"
            ? { ...common, kind, baseSha: "f".repeat(40), headSha: rootSha }
            : kind === "remote_branch"
              ? {
                  ...common,
                  kind,
                  baseSha: "f".repeat(40),
                  headSha: rootSha,
                  branch: "verification",
                  verifiedEvidenceRef: "branch-evidence",
                }
              : {
                  ...common,
                  kind,
                  baseSubjectRef: "base-subject",
                  baseSha: rootSha,
                  patchDigest: "f".repeat(64),
                  artifactRef: "patch-artifact",
                };
      const base: InvestigationSubjectV1 = {
        ...common,
        id: "base-subject",
        kind: "source_commit",
        commitSha: rootSha,
      };
      expect(
        validateInvestigationSourceProvenance(provenance(), {
          subjectRef: primary.id,
          subjects: kind === "local_patch" ? [primary, base] : [primary],
        }),
      ).toEqual({ valid: true, errors: [] });
    },
  );

  it("rejects issue snapshots without a materialized source commit", () => {
    const primary: InvestigationSubjectV1 = {
      id: subject.id,
      repositoryId: subject.repositoryId,
      workItemId: subject.workItemId,
      revisionKey: subject.revisionKey,
      kind: "issue_snapshot",
      snapshotDigest: "d".repeat(64),
    };
    expect(
      validateInvestigationSourceProvenance(provenance(), {
        subjectRef: primary.id,
        subjects: [primary],
      }).valid,
    ).toBe(false);
  });

  it.each(["source_commit", "original_pr", "remote_branch"] as const)(
    "accepts a local patch based on an exact frozen %s subject",
    (kind) => {
      const patch: InvestigationSubjectV1 = {
        id: subject.id,
        repositoryId: subject.repositoryId,
        workItemId: subject.workItemId,
        revisionKey: subject.revisionKey,
        kind: "local_patch",
        baseSubjectRef: "base-subject",
        baseSha: rootSha,
        patchDigest: "f".repeat(64),
        artifactRef: "patch-artifact",
      };
      const base: InvestigationSubjectV1 =
        kind === "source_commit"
          ? { ...subject, id: patch.baseSubjectRef, kind, commitSha: rootSha }
          : kind === "original_pr"
            ? {
                id: patch.baseSubjectRef,
                repositoryId: patch.repositoryId,
                workItemId: patch.workItemId,
                revisionKey: subject.revisionKey,
                kind,
                baseSha: "f".repeat(40),
                headSha: rootSha,
              }
            : {
                id: patch.baseSubjectRef,
                repositoryId: patch.repositoryId,
                workItemId: patch.workItemId,
                revisionKey: subject.revisionKey,
                kind,
                baseSha: "f".repeat(40),
                headSha: rootSha,
                branch: "verification",
                verifiedEvidenceRef: "branch-evidence",
              };
      expect(
        validateInvestigationSourceProvenance(provenance(), {
          subjectRef: patch.id,
          subjects: [patch, base],
        }),
      ).toEqual({ valid: true, errors: [] });
    },
  );

  it.each([
    "missing",
    "duplicated",
    "malformed",
    "repository mismatch",
    "work item mismatch",
    "revision mismatch",
    "unsupported kind",
    "self reference",
  ] as const)("rejects a local patch whose frozen base is %s", (mutation) => {
    const patch: Extract<InvestigationSubjectV1, { kind: "local_patch" }> = {
      id: subject.id,
      repositoryId: subject.repositoryId,
      workItemId: subject.workItemId,
      revisionKey: subject.revisionKey,
      kind: "local_patch",
      baseSubjectRef: "base-subject",
      baseSha: rootSha,
      patchDigest: "f".repeat(64),
      artifactRef: "patch-artifact",
    };
    const base: Extract<InvestigationSubjectV1, { kind: "source_commit" }> = {
      ...subject,
      id: patch.baseSubjectRef,
    };
    const subjects: InvestigationSubjectV1[] = [patch, base];
    if (mutation === "missing") subjects.pop();
    else if (mutation === "duplicated") subjects.push({ ...base });
    else if (mutation === "malformed") base.revisionKey = "";
    else if (mutation === "repository mismatch") base.repositoryId = "other-repository";
    else if (mutation === "work item mismatch") base.workItemId = "other-work-item";
    else if (mutation === "revision mismatch") base.commitSha = "f".repeat(40);
    else if (mutation === "unsupported kind")
      subjects[1] = {
        id: base.id,
        repositoryId: base.repositoryId,
        workItemId: base.workItemId,
        revisionKey: base.revisionKey,
        kind: "issue_snapshot",
        snapshotDigest: "f".repeat(64),
      };
    else patch.baseSubjectRef = patch.id;
    expect(
      validateInvestigationSourceProvenance(provenance(), { subjectRef: patch.id, subjects })
        .errors,
    ).toContainEqual(
      expect.objectContaining({ code: "SOURCE_PROVENANCE_BASE_MISMATCH", path: "/sourceSha" }),
    );
  });

  it.each([
    "other subject",
    "missing primary",
    "duplicate primary",
    "malformed primary",
    "wrong revision",
  ] as const)("rejects provenance bound to an %s", (mutation) => {
    const value = provenance();
    const other: InvestigationSubjectV1 = { ...subject, id: "other-subject" };
    const subjects = [subject, other];
    if (mutation === "other subject") value.subjectRef = other.id;
    else if (mutation === "missing primary") subjects.shift();
    else if (mutation === "duplicate primary") subjects.push({ ...subject });
    else if (mutation === "malformed primary") subjects[0] = { ...subject, repositoryId: "" };
    else {
      value.sourceSha = "f".repeat(40);
      value.submodules[1]!.parentCommitSha = value.sourceSha;
    }
    expect(
      validateInvestigationSourceProvenance(value, { subjectRef: subject.id, subjects }).valid,
    ).toBe(false);
  });

  it.each([
    "",
    "/deps/lib",
    "C:/deps/lib",
    "C:deps/lib",
    "\\\\server\\share",
    "deps\\lib",
    "../lib",
    "deps/./lib",
    "deps//lib",
    "deps/lib/",
    "deps/.GiT/lib",
    "deps/lib:stream",
    "deps/lib.",
    "deps/lib ",
    "deps/NUL.txt",
    "deps/COM1",
    "deps/LPT9.ext",
    "deps/CONIN$",
    "deps/CONOUT$",
    "deps/CLOCK$",
    "deps/li*b",
    "deps/li?b",
    'deps/li"b',
    "deps/li|b",
    "deps/li<b",
    "deps/li>b",
    "deps/li\u0000b",
    "deps/li\u007fb",
    "deps/\ud800",
    "deps/\udc00",
    "x".repeat(4_097),
  ])("rejects a noncanonical dependency path: %j", (path) => {
    const value = { ...provenance(), submodules: [rootModule(path)] };
    expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
  });

  it.each([
    "https://github.com/owner/repo",
    "owner/repo.git",
    "owner.git/repo",
    "owner/repo.",
    "owner./repo",
    "owner/repo/extra",
    "owner/re po",
    "owner/repo?ref=main",
    "owner/repo\n",
    "owner/repo\r",
    "owner/repo\u2028",
    "owner/repo\u2029",
    "owner/repo.git\n",
  ])("rejects a noncanonical repository: %s", (repository) => {
    const value = provenance();
    value.submodules[0]!.repository = repository;
    expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
  });

  it.each([
    ["deps/library", "deps/library"],
    ["deps/library", "DEPS/LIBRARY"],
    ["Deps/first", "deps/second"],
    ["deps/Shared/first", "deps/shared/second"],
  ])("rejects duplicate or aliased paths: %s and %s", (first, second) => {
    const value = { ...provenance(), submodules: [rootModule(first), rootModule(second)] };
    expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
  });

  it.each([
    "missing parent",
    "wrong parent commit",
    "root commit",
    "parent case",
    "unsafe parent",
    "self parent",
    "skipped parent",
  ] as const)("rejects an incorrect dependency relationship: %s", (mutation) => {
    const value = provenance();
    const child = value.submodules[0]!;
    if (mutation === "missing parent") child.parentPath = null;
    else if (mutation === "wrong parent commit") child.parentCommitSha = rootSha;
    else if (mutation === "root commit") value.submodules[1]!.parentCommitSha = childSha;
    else if (mutation === "parent case") child.parentPath = "Vendor/Library";
    else if (mutation === "unsafe parent") child.parentPath = "vendor/../library";
    else if (mutation === "self parent") child.parentPath = child.path;
    else
      value.submodules.push({
        ...rootModule("vendor/library/deps"),
        parentPath: "vendor/library",
        parentCommitSha: childSha,
      });
    expect(validateInvestigationSourceProvenance(value, binding).valid).toBe(false);
  });

  it("persists trusted runtime provenance while keeping it outside model output", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 0 });
    const analysis: InvestigationAnalysisV1 = {
      schemaVersion: "InvestigationAnalysisV1",
      summary: result.report.summary,
      coverage: result.report.coverage,
      findings: [],
      assessment: result.assessment,
      candidates: [],
      rechecks: [],
      evidence: [],
      plans: [],
      nextActions: [],
      feedbackDrafts: [],
      diagnostics: [],
      limitations: [],
    };
    const runtime = {
      completedStepIds: [],
      checks: [],
      evidence: [],
      artifacts: [],
      subjects: [],
      startedSteps: [],
      completedSteps: [],
    };
    expect(Value.Check(InvestigationAnalysisV1Schema, analysis)).toBe(true);
    expect(Value.Check(InvestigationRuntimeStateSchema, runtime)).toBe(true);
    expect(
      Value.Check(InvestigationAnalysisV1Schema, { ...analysis, sourceProvenance: provenance() }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationAnalysisV1Schema, {
        ...analysis,
        context: { sourceProvenance: provenance() },
      }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationRuntimeStateSchema, { ...runtime, sourceProvenance: provenance() }),
    ).toBe(true);
  });

  it("accepts the dedicated source provenance checkpoint request with its exact envelope", () => {
    const request = {
      kind: "source_provenance",
      lease: { attemptId: "attempt", fence: 1, leaseToken: "synthetic-lease" },
      provenance: provenance(),
    };
    expect(Value.Check(InvestigationCheckpointRequestSchema, request)).toBe(true);
    expect(Value.Check(InvestigationCheckpointRequestSchema, { ...request, reviewed: true })).toBe(
      false,
    );
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, {
        ...request,
        provenance: { ...request.provenance, submodules: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, {
        ...request,
        lease: { ...request.lease, attemptId: "" },
      }),
    ).toBe(false);
  });
});
