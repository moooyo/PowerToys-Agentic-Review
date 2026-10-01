import { createHash } from "node:crypto";
import {
  createInvestigationPreview,
  type InvestigationCommentDelivery,
  type InvestigationCommentPublicationSummary,
  type InvestigationResultV1,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InvestigationNativeEvidenceReads,
  type InvestigationNativeEvidenceReadsOptions,
} from "./native-evidence-read.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

const confirmedAt = "2026-10-01T00:00:00.000Z";
const checkedAt = "2026-10-01T01:00:00.000Z";
const actor: InvestigationOperatorPrincipal = {
  id: "operator",
  displayName: "Synthetic operator",
  repositoryIds: ["repository"],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
const publication: InvestigationCommentPublicationSummary = {
  id: "progress-reply:task:one",
  version: "version-one",
  mode: "progress",
  repositoryId: "repository",
  repositoryFullName: "fixture/repository",
  workItemId: "item",
  workItemKind: "pull_request",
  workItemNumber: 7,
  taskId: "task",
  reportId: "report",
  state: "synced",
  reasonCode: null,
  reason: null,
  requiresAttention: false,
  nextAttemptAt: null,
  lastAttemptAt: confirmedAt,
  lastConfirmedAt: confirmedAt,
  externalId: "700",
  commentUrl: "https://github.com/fixture/repository/pull/7#issuecomment-700",
  availableActions: [],
  createdAt: confirmedAt,
  updatedAt: confirmedAt,
};

function reportFixture(): InvestigationResultV1 {
  const report = createInvestigationPreview("pr").result;
  report.context.repository = {
    id: "repository",
    fullName: "fixture/repository",
    githubRepositoryId: 99,
  };
  report.context.workItem.id = "item";
  report.context.subjects[0]!.repositoryId = "repository";
  report.context.subjects[0]!.workItemId = "item";
  report.findings[0]!.locations = [
    {
      kind: "source",
      subjectRef: report.context.subjects[0]!.id,
      path: "src/a.cpp",
      startLine: 2,
      endLine: 3,
    },
  ];
  report.findings[0]!.feedbackDraft.suggestion = {
    subjectRef: report.findings[0]!.subjectRef,
    path: "src/a.cpp",
    startLine: 2,
    endLine: 3,
    headSha: "f".repeat(40),
    originalContentDigest: "0".repeat(64),
    replacement: "Unapplied replacement",
  };
  return report;
}

function harness(
  fetcher: typeof globalThis.fetch,
  options: {
    summary?: InvestigationCommentPublicationSummary;
    report?: InvestigationResultV1;
    saved?: unknown;
    attempts?: InvestigationCommentDelivery[];
    configured?: boolean;
    repositoryId?: number;
  } = {},
) {
  const report = options.report ?? reportFixture();
  const summary = options.summary ?? publication;
  const saved = {
    schemaVersion: 2,
    id: summary.id,
    repository: {
      id: summary.repositoryId,
      fullName: summary.repositoryFullName,
      githubRepositoryId: 99,
    },
    target: { number: summary.workItemNumber },
    workItemId: summary.workItemId,
    confirmed: null,
    ...(options.saved === undefined
      ? {
          confirmed: {
            externalId: summary.externalId,
            confirmedAt: summary.lastConfirmedAt,
            body: "Last confirmed body",
          },
        }
      : (options.saved as object)),
  };
  const store = {
    get: vi.fn(() => saved),
    pageCommentDeliveries: vi.fn(() => options.attempts ?? []),
  } as unknown as InvestigationNativeEvidenceReadsOptions["store"];
  const githubRead = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.method).toBe("GET");
    if (String(input) === "https://api.github.com/repos/fixture/repository")
      return Response.json({ id: options.repositoryId ?? 99, full_name: "fixture/repository" });
    return fetcher(input, init);
  });
  const readComment = vi.fn(() => summary);
  const reads = new InvestigationNativeEvidenceReads({
    store,
    readComment,
    readReport: () => report,
    ...(options.configured === false ? {} : { github: { token: "synthetic-token" } }),
    fetch: githubRead,
    now: () => new Date(checkedAt),
  });
  return { reads, store, summary, report, githubRead, readComment };
}

function commentResponse(body: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: 700,
    issue_url: "https://api.github.com/repos/fixture/repository/issues/7",
    body,
    updated_at: checkedAt,
    ...overrides,
  });
}

function sourceFetcher(
  report: InvestigationResultV1,
  bytes = Buffer.from("First line\nOriginal second line\nOriginal third line\nFourth line\n"),
  overrides: {
    mode?: string;
    blob?: Record<string, unknown>;
    tree?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    revision?: string;
  } = {},
) {
  const subject = report.context.subjects[0]!;
  const commitSha =
    overrides.revision ??
    ("headSha" in subject
      ? subject.headSha
      : "commitSha" in subject
        ? subject.commitSha
        : "b".repeat(40));
  const treeSha = "1".repeat(40);
  const directorySha = "2".repeat(40);
  const blobSha = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  const fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.method).toBe("GET");
    const url = String(input);
    if (url.endsWith(`/git/commits/${commitSha}`))
      return Response.json({ sha: commitSha, tree: { sha: treeSha }, ...overrides.commit });
    if (url.endsWith(`/git/trees/${treeSha}`))
      return Response.json({
        sha: treeSha,
        tree: [{ path: "src", type: "tree", mode: "040000", sha: directorySha }],
        truncated: false,
        ...overrides.tree,
      });
    if (url.endsWith(`/git/trees/${directorySha}`))
      return Response.json({
        sha: directorySha,
        tree: [{ path: "a.cpp", type: "blob", mode: overrides.mode ?? "100644", sha: blobSha }],
        truncated: false,
      });
    if (url.endsWith(`/git/blobs/${blobSha}`))
      return Response.json({
        sha: blobSha,
        encoding: "base64",
        content: bytes.toString("base64"),
        size: bytes.byteLength,
        ...overrides.blob,
      });
    throw new Error(`Unexpected synthetic GET: ${url}`);
  });
  return { fetcher, commitSha, blobSha, bytes };
}

describe("read-only current GitHub comments", () => {
  it("does not migrate or read upstream for a retained older progress record", async () => {
    const fetcher = vi.fn(async () => commentResponse("Current body"));
    const h = harness(fetcher, {
      saved: {
        schemaVersion: 1,
        workItem: { id: "item", repositoryId: "repository", number: 7 },
        published: { externalId: "700", body: "Retained legacy body" },
      },
    });
    const value = await h.reads.currentComment(actor, publication.id);
    expect(value).toMatchObject({
      state: "unavailable",
      reasonCode: "legacy_comment_readback_unavailable",
      lastConfirmedAt: null,
      lastConfirmedBody: "Retained legacy body",
      externalId: "700",
    });
    expect(h.readComment).not.toHaveBeenCalled();
    expect(h.githubRead).not.toHaveBeenCalled();
    expect(h.store.pageCommentDeliveries).not.toHaveBeenCalled();
  });

  it("checks an older progress record's repository scope before exposing its retained body", async () => {
    const h = harness(
      vi.fn(async () => commentResponse("Current body")),
      {
        saved: {
          schemaVersion: 1,
          workItem: { id: "item", repositoryId: "repository", number: 7 },
          published: { externalId: "700", body: "Retained legacy body" },
        },
      },
    );
    await expect(
      h.reads.currentComment({ ...actor, repositoryIds: [] }, publication.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.readComment).not.toHaveBeenCalled();
    expect(h.githubRead).not.toHaveBeenCalled();
  });

  it.each([
    ["Last confirmed body", "present", "matches_confirmation"],
    ["Edited on GitHub", "edited", "differs_from_confirmation"],
  ] as const)(
    "classifies %s without changing the saved confirmation",
    async (body, state, comparison) => {
      const fetcher = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        expect(init?.method).toBe("GET");
        return commentResponse(body);
      });
      const h = harness(fetcher);
      const before = structuredClone(h.summary);
      const value = await h.reads.currentComment(actor, publication.id);
      expect(value).toMatchObject({
        state,
        comparison,
        body,
        lastConfirmedAt: confirmedAt,
        lastConfirmedBody: "Last confirmed body",
        checkedAt,
      });
      expect(h.summary).toEqual(before);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/fixture/repository/issues/comments/700",
      );
    },
  );

  it("only declares deletion after the exact target is still accessible", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      return String(input).endsWith("/comments/700")
        ? new Response(null, { status: 404 })
        : Response.json({
            number: 7,
            url: "https://api.github.com/repos/fixture/repository/issues/7",
          });
    });
    const value = await harness(fetcher).reads.currentComment(actor, publication.id);
    expect(value).toMatchObject({
      state: "deleted",
      body: null,
      lastConfirmedAt: confirmedAt,
      lastConfirmedBody: "Last confirmed body",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 429, 500])(
    "retains historical content when the target read returns HTTP %s",
    async (status) => {
      const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
      const value = await harness(fetcher).reads.currentComment(actor, publication.id);
      expect(value).toMatchObject({
        state: "unavailable",
        body: null,
        lastConfirmedAt: confirmedAt,
        lastConfirmedBody: "Last confirmed body",
      });
      expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    },
  );

  it("does not claim an edit when the confirmed body is unavailable", async () => {
    const value = await harness(
      vi.fn(async () => commentResponse("Current body")),
      { saved: {} },
    ).reads.currentComment(actor, publication.id);
    expect(value).toMatchObject({
      state: "present",
      comparison: "unknown",
      lastConfirmedAt: confirmedAt,
      lastConfirmedBody: null,
      reasonCode: "confirmed_content_unavailable",
    });
  });

  it("retains confirmed historical content even when its confirmation time is unknown", async () => {
    const summary = { ...publication, lastConfirmedAt: null };
    const value = await harness(
      vi.fn(async () => commentResponse("Last confirmed body")),
      { summary },
    ).reads.currentComment(actor, publication.id);
    expect(value).toMatchObject({
      state: "present",
      comparison: "matches_confirmation",
      lastConfirmedAt: null,
      lastConfirmedBody: "Last confirmed body",
    });
  });

  it("does not call a comment deleted when the repository name now belongs to a different repository", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    const value = await harness(fetcher, { repositoryId: 123456 }).reads.currentComment(
      actor,
      publication.id,
    );
    expect(value).toMatchObject({
      state: "unavailable",
      reasonCode: "repository_identity_changed",
      lastConfirmedAt: confirmedAt,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the progress publication's saved body even when ledger timestamps differ", async () => {
    const value = await harness(
      vi.fn(async () => commentResponse("Last confirmed body")),
      { attempts: [{ finishedAt: "2026-10-01T00:00:00.001Z" } as InvestigationCommentDelivery] },
    ).reads.currentComment(actor, publication.id);
    expect(value.comparison).toBe("matches_confirmation");
  });

  it("retains a result publication's exact successful historical body", async () => {
    const summary = { ...publication, mode: "result" as const, id: "auto-reply:report:one" };
    const attempt = {
      repositoryFullName: summary.repositoryFullName,
      workItemNumber: 7,
      externalId: "700",
      body: "Confirmed result",
      state: "succeeded",
      finishedAt: confirmedAt,
      observations: [],
    } as unknown as InvestigationCommentDelivery;
    const value = await harness(
      vi.fn(async () => commentResponse("Changed result")),
      { summary, attempts: [attempt] },
    ).reads.currentComment(actor, summary.id);
    expect(value).toMatchObject({ state: "edited", lastConfirmedBody: "Confirmed result" });
  });

  it("retains a successful result body whose historical receipt has no timestamp", async () => {
    const summary = {
      ...publication,
      mode: "result" as const,
      id: "auto-reply:report:one",
      lastConfirmedAt: null,
    };
    const attempt = {
      repositoryFullName: summary.repositoryFullName,
      workItemNumber: 7,
      externalId: "700",
      body: "Confirmed legacy result",
      state: "succeeded",
      finishedAt: null,
      observations: [],
    } as unknown as InvestigationCommentDelivery;
    const value = await harness(
      vi.fn(async () => commentResponse("Changed result")),
      { summary, attempts: [attempt] },
    ).reads.currentComment(actor, summary.id);
    expect(value).toMatchObject({
      state: "edited",
      lastConfirmedAt: null,
      lastConfirmedBody: "Confirmed legacy result",
    });
  });

  it.each([
    { id: 701 },
    { issue_url: "https://api.github.com/repos/foreign/repository/issues/7" },
    { updated_at: null },
  ])("rejects a mismatched or incomplete upstream comment", async (overrides) => {
    const value = await harness(
      vi.fn(async () => commentResponse("Body", overrides)),
    ).reads.currentComment(actor, publication.id);
    expect(value).toMatchObject({
      state: "unavailable",
      body: null,
      reasonCode: "comment_identity_mismatch",
    });
  });

  it("does not contact GitHub before native repository authorization", async () => {
    const fetcher = vi.fn(async () => commentResponse("Body"));
    await expect(
      harness(fetcher).reads.currentComment({ ...actor, repositoryIds: [] }, publication.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not look up an unsaved or malformed external identity", async () => {
    const fetcher = vi.fn(async () => commentResponse("Body"));
    expect(
      (
        await harness(fetcher, {
          summary: { ...publication, externalId: null },
        }).reads.currentComment(actor, publication.id)
      ).state,
    ).toBe("not_published");
    expect(
      (
        await harness(fetcher, {
          summary: { ...publication, externalId: "700/path" },
        }).reads.currentComment(actor, publication.id)
      ).state,
    ).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not require publication capabilities or enable outbound writes to read", async () => {
    const value = await harness(vi.fn(async () => commentResponse("Body"))).reads.currentComment(
      actor,
      publication.id,
    );
    expect(value.state).toBe("edited");
  });

  it("reports missing credentials without contacting GitHub", async () => {
    const fetcher = vi.fn(async () => commentResponse("Body"));
    expect(
      (await harness(fetcher, { configured: false }).reads.currentComment(actor, publication.id))
        .reasonCode,
    ).toBe("github_not_configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("finding source context from immutable Git objects", () => {
  it("reads only the saved commit and exact regular blob, preserving source line numbers", async () => {
    const report = reportFixture();
    const source = sourceFetcher(report);
    const h = harness(source.fetcher, { report });
    const value = await h.reads.findingSource(actor, report.report.id, report.findings[0]!.id);
    expect(value).toMatchObject({
      availability: "available",
      commitSha: source.commitSha,
      blobSha: source.blobSha,
      contentDigest: createHash("sha256").update(source.bytes).digest("hex"),
      path: "src/a.cpp",
      startLine: 2,
      endLine: 3,
      contextStartLine: 1,
      contextEndLine: 4,
    });
    expect(value.lines).toEqual([
      { number: 1, text: "First line", inFinding: false },
      { number: 2, text: "Original second line", inFinding: true },
      { number: 3, text: "Original third line", inFinding: true },
      { number: 4, text: "Fourth line", inFinding: false },
    ]);
    expect(value.lines.some((line) => line.text.includes("Unapplied replacement"))).toBe(false);
    expect(source.fetcher).toHaveBeenCalledTimes(4);
    expect(
      source.fetcher.mock.calls
        .map(([input]) => String(input))
        .some((url) => /latest|\/pulls\/|ref=main/u.test(url)),
    ).toBe(false);
  });

  it.each(["120000", "160000"])("does not follow non-regular Git entry mode %s", async (mode) => {
    const report = reportFixture();
    const source = sourceFetcher(report, undefined, { mode });
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value).toMatchObject({
      availability: "unavailable",
      reasonCode: "source_path_type_unsupported",
      lines: [],
    });
    expect(source.fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses a saved source-commit subject for Issue findings", async () => {
    const report = reportFixture();
    const subject = report.context.subjects[0]!;
    report.context.subjects[0] = {
      id: subject.id,
      repositoryId: subject.repositoryId,
      workItemId: subject.workItemId,
      revisionKey: subject.revisionKey,
      kind: "source_commit",
      commitSha: "c".repeat(40),
    };
    report.context.workItem.kind = "issue";
    const source = sourceFetcher(report);
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value).toMatchObject({ availability: "available", commitSha: "c".repeat(40) });
    expect(source.fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/fixture/repository/git/commits/${"c".repeat(40)}`,
    );
  });

  it("reads an exact submodule commit only when the sealed provenance binds its source path", async () => {
    const report = reportFixture();
    const subject = report.context.subjects[0]!;
    if (subject.kind !== "original_pr") throw new Error("Expected original PR fixture.");
    const location = report.findings[0]!.locations[0]!;
    if (location.kind !== "source") throw new Error("Expected source fixture.");
    location.path = "externals/dependency/src/a.cpp";
    report.context.sourceProvenance = {
      subjectRef: subject.id,
      sourceSha: subject.headSha,
      submodules: [
        {
          path: "externals/dependency",
          repository: "fixture/dependency",
          commitSha: "c".repeat(40),
          parentPath: null,
          parentCommitSha: subject.headSha,
        },
      ],
    };
    const source = sourceFetcher(report, undefined, { revision: "c".repeat(40) });
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value).toMatchObject({
      availability: "available",
      commitSha: "c".repeat(40),
      sourceRepositoryFullName: "fixture/dependency",
      sourcePath: "src/a.cpp",
      path: "externals/dependency/src/a.cpp",
    });
    expect(
      source.fetcher.mock.calls.every(([input]) =>
        String(input).startsWith("https://api.github.com/repos/fixture/dependency/"),
      ),
    ).toBe(true);
  });

  it("limits long ranges without changing the saved finding coordinates", async () => {
    const report = reportFixture();
    const location = report.findings[0]!.locations[0]!;
    if (location.kind !== "source") throw new Error("Expected source fixture.");
    location.endLine = 250;
    const bytes = Buffer.from(
      `${Array.from({ length: 300 }, (_, index) => `Line ${index + 1}`).join("\n")}\n`,
    );
    const source = sourceFetcher(report, bytes);
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value).toMatchObject({
      availability: "available",
      startLine: 2,
      endLine: 250,
      contextStartLine: 1,
      contextEndLine: 200,
      truncated: true,
    });
    expect(value.lines).toHaveLength(200);
  });

  it.each([
    [{ sha: "9".repeat(40) }, "source_content_identity_invalid"],
    [
      { content: Buffer.from("Other bytes").toString("base64"), size: 11 },
      "source_content_digest_mismatch",
    ],
    [{ size: 1 }, "source_content_size_mismatch"],
    [{ content: "not!base64" }, "source_content_invalid"],
  ] as const)(
    "rejects a blob whose identity, bytes, size, or encoding changed",
    async (blob, reasonCode) => {
      const report = reportFixture();
      const source = sourceFetcher(report, undefined, { blob: { ...blob } });
      expect(
        await harness(source.fetcher, { report }).reads.findingSource(
          actor,
          report.report.id,
          report.findings[0]!.id,
        ),
      ).toMatchObject({ availability: "unavailable", reasonCode, lines: [] });
    },
  );

  it("rejects a truncated tree instead of guessing which entry was omitted", async () => {
    const report = reportFixture();
    const source = sourceFetcher(report, undefined, { tree: { truncated: true } });
    expect(
      (
        await harness(source.fetcher, { report }).reads.findingSource(
          actor,
          report.report.id,
          report.findings[0]!.id,
        )
      ).reasonCode,
    ).toBe("source_tree_unavailable");
  });

  it("rejects unsupported UTF-8 and binary content", async () => {
    const report = reportFixture();
    for (const bytes of [Buffer.from([0xff]), Buffer.from("Binary\0content")]) {
      const source = sourceFetcher(report, bytes);
      expect(
        (
          await harness(source.fetcher, { report }).reads.findingSource(
            actor,
            report.report.id,
            report.findings[0]!.id,
          )
        ).reasonCode,
      ).toBe("source_encoding_unsupported");
    }
  });

  it("does not substitute base or current head when the saved range is missing", async () => {
    const report = reportFixture();
    const source = sourceFetcher(report, Buffer.from("One line\n"));
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value).toMatchObject({
      availability: "unavailable",
      reasonCode: "saved_source_range_unavailable",
      commitSha: source.commitSha,
      lines: [],
    });
  });

  it("keeps a standalone carriage return within its original Git line", async () => {
    const report = reportFixture();
    const source = sourceFetcher(report, Buffer.from("First\rstill first\nSecond\nThird\n"));
    const value = await harness(source.fetcher, { report }).reads.findingSource(
      actor,
      report.report.id,
      report.findings[0]!.id,
    );
    expect(value.lines).toEqual([
      { number: 1, text: "First\rstill first", inFinding: false },
      { number: 2, text: "Second", inFinding: true },
      { number: 3, text: "Third", inFinding: true },
    ]);
  });

  it("does not read source from a repository that reused the saved repository name", async () => {
    const report = reportFixture();
    const source = sourceFetcher(report);
    const value = await harness(source.fetcher, {
      report,
      repositoryId: 123456,
    }).reads.findingSource(actor, report.report.id, report.findings[0]!.id);
    expect(value).toMatchObject({
      availability: "unavailable",
      reasonCode: "repository_identity_changed",
      lines: [],
    });
    expect(source.fetcher).not.toHaveBeenCalled();
  });

  it("rejects traversal and an unrelated saved subject before reading any Git object", async () => {
    for (const change of ["traversal", "subject"]) {
      const report = reportFixture();
      const location = report.findings[0]!.locations[0]!;
      if (location.kind !== "source") throw new Error("Expected source fixture.");
      if (change === "traversal") location.path = "../a.cpp";
      else report.findings[0]!.subjectRef = "unrelated-subject";
      const fetcher = vi.fn(async () => Response.json({}));
      const value = await harness(fetcher, { report }).reads.findingSource(
        actor,
        report.report.id,
        report.findings[0]!.id,
      );
      expect(value.availability).toBe("unavailable");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("reports a local patch as unavailable instead of reading its unmodified base", async () => {
    const report = reportFixture();
    const subject = report.context.subjects[0]!;
    report.context.subjects[0] = {
      id: subject.id,
      repositoryId: subject.repositoryId,
      workItemId: subject.workItemId,
      revisionKey: subject.revisionKey,
      kind: "local_patch",
      baseSha: "b".repeat(40),
      baseSubjectRef: "base",
      patchDigest: "3".repeat(64),
      artifactRef: "patch",
    };
    const fetcher = vi.fn(async () => Response.json({}));
    expect(
      (
        await harness(fetcher, { report }).reads.findingSource(
          actor,
          report.report.id,
          report.findings[0]!.id,
        )
      ).reasonCode,
    ).toBe("immutable_source_revision_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("selects only the exact saved location index", async () => {
    const report = reportFixture();
    report.findings[0]!.locations.unshift({
      kind: "behavior",
      subjectRef: report.findings[0]!.subjectRef,
      description: "Observed behavior",
    });
    const source = sourceFetcher(report);
    const h = harness(source.fetcher, { report });
    expect(
      (await h.reads.findingSource(actor, report.report.id, report.findings[0]!.id, 0)).reasonCode,
    ).toBe("finding_has_no_source_location");
    expect(source.fetcher).not.toHaveBeenCalled();
    expect(
      (await h.reads.findingSource(actor, report.report.id, report.findings[0]!.id, 1))
        .availability,
    ).toBe("available");
    await expect(
      h.reads.findingSource(actor, report.report.id, report.findings[0]!.id, 2),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("requires the report's repository grant before upstream reads", async () => {
    const report = reportFixture();
    const fetcher = vi.fn(async () => Response.json({}));
    await expect(
      harness(fetcher, { report }).reads.findingSource(
        { ...actor, repositoryIds: [] },
        report.report.id,
        report.findings[0]!.id,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
