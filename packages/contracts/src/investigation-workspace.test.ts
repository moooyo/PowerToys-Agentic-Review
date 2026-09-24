import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type InvestigationMediaPublication,
  InvestigationMediaPublicationSchema,
  type InvestigationPublicationDirectoryPage,
  InvestigationPublicationDirectoryPageSchema,
  type InvestigationPublicationDirectoryQuery,
  InvestigationPublicationDirectoryQuerySchema,
  type InvestigationReportDirectoryPage,
  InvestigationReportDirectoryPageSchema,
  type InvestigationReportDirectoryQuery,
  InvestigationReportDirectoryQuerySchema,
  type InvestigationTaskArtifactsPage,
  InvestigationTaskArtifactsPageSchema,
  type InvestigationTaskArtifactsQuery,
  InvestigationTaskArtifactsQuerySchema,
  type InvestigationWorkItemDiscussion,
  InvestigationWorkItemDiscussionQuerySchema,
  InvestigationWorkItemDiscussionSchema,
  type InvestigationWorkspaceSearchQuery,
  InvestigationWorkspaceSearchQuerySchema,
  type InvestigationWorkspaceSearchResult,
  InvestigationWorkspaceSearchResultSchema,
} from "./investigation-workspace.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const timestamp = "2026-09-20T00:00:00Z";
const digest = "a".repeat(64);
const versionRef = { id: "version-fixture", version: 1, digest };

const artifact = {
  artifact: {
    id: "artifact-fixture",
    taskId: "task-fixture",
    attemptId: "attempt-fixture",
    subjectRef: "subject-fixture",
    kind: "image",
    name: "Synthetic screenshot",
    mediaType: "image/png",
    digest,
    byteLength: 128,
    availability: "available",
  },
  storedAt: timestamp,
  expiredAt: null,
  retentionProtected: true,
} satisfies InvestigationTaskArtifactsPage["items"][number];

const report = {
  schemaVersion: "InvestigationReportHeaderV1",
  id: "report-fixture",
  version: 1,
  context: {
    repository: { id: "repo-fixture", githubRepositoryId: 1, fullName: "fixture/repository" },
    workItem: { id: "work-item-fixture", kind: "issue", number: 1, title: "Synthetic issue" },
    task: {
      id: "task-fixture",
      kind: "issue-investigate",
      parentTaskId: null,
      subjectRef: "subject-fixture",
    },
    attempt: { id: "attempt-fixture", number: 1 },
    adoptedAttemptIds: [],
    subjects: [
      {
        id: "subject-fixture",
        repositoryId: "repo-fixture",
        workItemId: "work-item-fixture",
        revisionKey: digest,
        kind: "issue_snapshot",
        snapshotDigest: digest,
      },
    ],
    profileRef: versionRef,
    promptRef: versionRef,
    parentReportRef: null,
  },
  outcome: "completed",
  assessment: {
    subjectRef: "subject-fixture",
    summary: "Synthetic assessment",
    evidenceRefs: [],
    kind: "other_issue",
    classification: "question",
    explanation: "The fixture requires no repository execution.",
  },
  validation: { summary: "No execution requested." },
  report: {
    id: "report-fixture",
    version: 1,
    delivery: "final",
    completeness: "complete",
    summary: "Synthetic report",
    logicalContentDigest: digest,
    coverage: {
      scopeManifest: versionRef,
      includedUnitCount: 0,
      completedUnitCount: 0,
      unresolvedUnitCount: 0,
      exclusionCount: 0,
    },
    recheck: {
      finalFindingCount: 0,
      validFinalVersionRecheckCount: 0,
      pendingFindingCount: 0,
    },
    loop: {
      checkpointId: "checkpoint-fixture",
      checkpointVersion: 1,
      completedRounds: 0,
      stopReason: "complete",
      budget: { maxRounds: 1, maxDurationMs: 1_000, maxTokens: 1_000, maxReportBytes: 10_000 },
      consumed: { rounds: 0, durationMs: 0, tokens: 0, reportBytes: 0 },
    },
    collections: {
      findings: 0,
      verificationEvidence: 0,
      artifacts: 0,
      plans: 0,
      nextActions: 0,
      candidates: 0,
      rechecks: 0,
    },
  },
} satisfies InvestigationReportDirectoryPage["items"][number];

const publication = {
  id: "publication-fixture",
  version: "version-1",
  mode: "result",
  repositoryId: "repo-fixture",
  repositoryFullName: "fixture/repository",
  workItemId: "work-item-fixture",
  workItemKind: "issue",
  workItemNumber: 1,
  taskId: "task-fixture",
  reportId: "report-fixture",
  state: "pending",
  reasonCode: null,
  reason: null,
  requiresAttention: false,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastConfirmedAt: null,
  externalId: null,
  commentUrl: null,
  availableActions: ["sync"],
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies InvestigationPublicationDirectoryPage["items"][number];

const discussion = {
  workItemId: "work-item-fixture",
  repositoryId: "repo-fixture",
  revisionKey: digest,
  availability: "available",
  snapshotRef: { id: "snapshot-fixture", digest },
  inputSnapshot: {
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: "repo-fixture",
    workItemId: "work-item-fixture",
    subjectRef: "subject-fixture",
    subjectRevisionKey: digest,
    title: "Synthetic issue",
    body: "The original issue body.\nThe second paragraph is retained.",
    comments: [{ id: "comment-fixture", body: "The original comment." }],
    source: null,
  },
} satisfies InvestigationWorkItemDiscussion;

const searchItem = {
  id: "repo-fixture",
  kind: "repository",
  repositoryId: "repo-fixture",
  title: "Synthetic repository",
  description: "",
  workItemId: null,
  workItemKind: null,
  taskId: null,
  updatedAt: null,
} satisfies InvestigationWorkspaceSearchResult["items"][number];

const media = {
  reportId: "report-fixture",
  state: "pending",
  retryable: true,
  uploadedCount: 0,
  totalCount: 1,
  blockers: [],
  uploads: [
    {
      artifactId: artifact.artifact.id,
      name: artifact.artifact.name,
      mediaType: artifact.artifact.mediaType,
      digest,
      state: "prepared",
      url: null,
      reason: null,
      featureIds: ["feature-fixture"],
    },
  ],
} satisfies InvestigationMediaPublication;

describe("investigation workspace directory queries", () => {
  const schemas = [
    ["artifacts", InvestigationTaskArtifactsQuerySchema],
    ["reports", InvestigationReportDirectoryQuerySchema],
    ["publications", InvestigationPublicationDirectoryQuerySchema],
  ] as const;

  it.each(schemas)("accepts default and bounded %s pagination", (_name, schema) => {
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { cursor: "x".repeat(2_048), limit: 50 })).toBe(true);
    expect(Value.Check(schema, { cursor: "opaque-cursor", limit: 1 })).toBe(true);
  });

  it.each(schemas)("rejects invalid %s pagination and unknown fields", (_name, schema) => {
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: "10" },
      { limit: null },
      { cursor: "" },
      { cursor: "x".repeat(2_049) },
      { cursor: null },
      { offset: 1 },
    ]) {
      expect(Value.Check(schema, query)).toBe(false);
    }
  });

  it("accepts typed artifact, report, and publication filters", () => {
    const artifacts: InvestigationTaskArtifactsQuery = { attemptId: "attempt-fixture", limit: 10 };
    const reports: InvestigationReportDirectoryQuery = {
      repositoryId: "repo-fixture",
      workItemId: "work-item-fixture",
      taskId: "task-fixture",
      kind: "issue-investigate",
      search: "Synthetic report",
      delivery: "final",
      completeness: "complete",
    };
    const publications: InvestigationPublicationDirectoryQuery = {
      repositoryId: "repo-fixture",
      workItemId: "work-item-fixture",
      workItemKind: "pull_request",
      taskId: "task-fixture",
      mode: "result",
      state: "needs_attention",
      taskKind: "pr-e2e",
    };
    expect(Value.Check(InvestigationTaskArtifactsQuerySchema, artifacts)).toBe(true);
    expect(Value.Check(InvestigationReportDirectoryQuerySchema, reports)).toBe(true);
    expect(Value.Check(InvestigationPublicationDirectoryQuerySchema, publications)).toBe(true);
  });

  it("rejects malformed scopes and filters belonging to another directory", () => {
    for (const attemptId of ["", "attempt/unsafe", null]) {
      expect(Value.Check(InvestigationTaskArtifactsQuerySchema, { attemptId })).toBe(false);
    }
    for (const schema of [
      InvestigationReportDirectoryQuerySchema,
      InvestigationPublicationDirectoryQuerySchema,
    ]) {
      for (const field of ["repositoryId", "workItemId", "taskId"]) {
        for (const value of ["", "../identity", null]) {
          expect(Value.Check(schema, { [field]: value })).toBe(false);
        }
      }
    }
    expect(Value.Check(InvestigationTaskArtifactsQuerySchema, { taskId: "task-fixture" })).toBe(
      false,
    );
    expect(Value.Check(InvestigationReportDirectoryQuerySchema, { mode: "result" })).toBe(false);
    expect(Value.Check(InvestigationPublicationDirectoryQuerySchema, { kind: "pr-review" })).toBe(
      false,
    );
  });

  it("bounds report search and restricts report delivery filters", () => {
    expect(Value.Check(InvestigationReportDirectoryQuerySchema, { search: "x".repeat(200) })).toBe(
      true,
    );
    expect(
      Value.Check(InvestigationReportDirectoryQuerySchema, {
        delivery: "checkpoint",
        completeness: "partial",
      }),
    ).toBe(true);
    for (const query of [
      { search: "" },
      { search: "x".repeat(201) },
      { search: null },
      { kind: "review" },
      { delivery: "pending" },
      { completeness: "unknown" },
    ]) {
      expect(Value.Check(InvestigationReportDirectoryQuerySchema, query)).toBe(false);
    }
  });

  it("restricts publication mode, state, task kind, and work item kind filters", () => {
    expect(
      Value.Check(InvestigationPublicationDirectoryQuerySchema, {
        mode: "progress",
        state: "synced",
        workItemKind: "issue",
      }),
    ).toBe(true);
    for (const query of [
      { mode: "draft" },
      { state: "succeeded" },
      { taskKind: "review" },
      { workItemKind: "pr" },
      { workItemKind: "" },
      { workItemKind: null },
      { workItemKind: ["issue", "pull_request"] },
    ]) {
      expect(Value.Check(InvestigationPublicationDirectoryQuerySchema, query)).toBe(false);
    }
  });
});

describe("investigation workspace directory pages", () => {
  const pages = [
    {
      name: "artifacts",
      schema: InvestigationTaskArtifactsPageSchema,
      page: { taskId: "task-fixture", items: [artifact], nextCursor: null },
      item: artifact,
    },
    {
      name: "reports",
      schema: InvestigationReportDirectoryPageSchema,
      page: { items: [report], nextCursor: null },
      item: report,
    },
    {
      name: "publications",
      schema: InvestigationPublicationDirectoryPageSchema,
      page: { items: [publication], nextCursor: null },
      item: publication,
    },
  ];

  it.each(pages)(
    "accepts typed $name items, empty pages, and full pages",
    ({ schema, page, item }) => {
      expect(Value.Check(schema, page)).toBe(true);
      expect(Value.Check(schema, { ...page, items: [] })).toBe(true);
      expect(
        Value.Check(schema, {
          ...page,
          items: Array.from({ length: 50 }, () => item),
          nextCursor: "x".repeat(2_048),
        }),
      ).toBe(true);
      expect(Value.Check(schema, { ...page, items: Array.from({ length: 51 }, () => item) })).toBe(
        false,
      );
    },
  );

  it.each(pages)("requires explicit bounded $name cursors", ({ schema, page }) => {
    for (const nextCursor of [undefined, "", "x".repeat(2_049), 1]) {
      expect(Value.Check(schema, { ...page, nextCursor })).toBe(false);
    }
  });

  it.each(pages)("rejects malformed and extra $name page fields", ({ schema, page, item }) => {
    for (const items of [null, [{}], [{ ...item, rawPayload: {} }]]) {
      expect(Value.Check(schema, { ...page, items })).toBe(false);
    }
    expect(Value.Check(schema, { ...page, total: 1 })).toBe(false);
  });

  it("keeps artifact storage metadata typed and separate from artifact identity", () => {
    const page: InvestigationTaskArtifactsPage = {
      taskId: "task-fixture",
      items: [{ ...artifact, expiredAt: timestamp, retentionProtected: false }],
      nextCursor: null,
    };
    expect(Value.Check(InvestigationTaskArtifactsPageSchema, page)).toBe(true);
    for (const item of [
      artifact.artifact,
      { ...artifact, expiredAt: "invalid" },
      { ...artifact, retentionProtected: "true" },
      { ...artifact, artifact: { ...artifact.artifact, digest: "not-a-digest" } },
      { ...artifact, artifact: { ...artifact.artifact, contentBase64: "payload" } },
    ]) {
      expect(Value.Check(InvestigationTaskArtifactsPageSchema, { ...page, items: [item] })).toBe(
        false,
      );
    }
    expect(Value.Check(InvestigationTaskArtifactsPageSchema, { ...page, taskId: undefined })).toBe(
      false,
    );
  });

  it("requires report headers and publication summaries with their nested contracts", () => {
    for (const item of [
      { ...report, schemaVersion: "InvestigationResultV1" },
      { ...report, report: { ...report.report, delivery: "pending" } },
      { ...report, report: { ...report.report, findings: [] } },
    ]) {
      expect(
        Value.Check(InvestigationReportDirectoryPageSchema, { items: [item], nextCursor: null }),
      ).toBe(false);
    }
    for (const item of [
      { ...publication, state: "succeeded" },
      { ...publication, availableActions: ["sync", "sync"] },
      { ...publication, nextAttemptAt: "invalid" },
    ]) {
      expect(
        Value.Check(InvestigationPublicationDirectoryPageSchema, {
          items: [item],
          nextCursor: null,
        }),
      ).toBe(false);
    }
  });

  it("bounds shared publication task associations independently from the current producer", () => {
    const associatedTaskIds = Array.from({ length: 100 }, (_, index) => `task-${index}`);
    expect(
      Value.Check(InvestigationPublicationDirectoryPageSchema, {
        items: [{ ...publication, associatedTaskIds }],
        nextCursor: null,
      }),
    ).toBe(true);
    for (const invalid of [
      [...associatedTaskIds, "task-overflow"],
      ["task-duplicate", "task-duplicate"],
      ["../invalid-task"],
      null,
    ])
      expect(
        Value.Check(InvestigationPublicationDirectoryPageSchema, {
          items: [{ ...publication, associatedTaskIds: invalid }],
          nextCursor: null,
        }),
      ).toBe(false);
  });
});

describe("investigation work item discussion contracts", () => {
  it("accepts current and bounded revision-specific requests", () => {
    expect(Value.Check(InvestigationWorkItemDiscussionQuerySchema, {})).toBe(true);
    expect(
      Value.Check(InvestigationWorkItemDiscussionQuerySchema, { revisionKey: "x".repeat(1_024) }),
    ).toBe(true);
    for (const query of [
      { revisionKey: "" },
      { revisionKey: "x".repeat(1_025) },
      { revisionKey: null },
      { taskId: "task-fixture" },
    ]) {
      expect(Value.Check(InvestigationWorkItemDiscussionQuerySchema, query)).toBe(false);
    }
  });

  it("accepts an available frozen discussion and explicit unavailable nulls", () => {
    expect(Value.Check(InvestigationWorkItemDiscussionSchema, discussion)).toBe(true);
    const unavailable: InvestigationWorkItemDiscussion = {
      ...discussion,
      availability: "unavailable",
      snapshotRef: null,
      inputSnapshot: null,
    };
    expect(Value.Check(InvestigationWorkItemDiscussionSchema, unavailable)).toBe(true);
    for (const field of ["snapshotRef", "inputSnapshot"] as const) {
      expect(
        Value.Check(InvestigationWorkItemDiscussionSchema, { ...unavailable, [field]: undefined }),
      ).toBe(false);
    }
  });

  it("rejects malformed discussion identities, references, and raw provider fields", () => {
    for (const fields of [
      { workItemId: "" },
      { revisionKey: "" },
      { availability: "pending" },
      { snapshotRef: { id: "snapshot-fixture", digest: "invalid" } },
      { snapshotRef: { ...discussion.snapshotRef, path: "private-path" } },
      { inputSnapshot: { ...discussion.inputSnapshot, comments: [{ id: "comment-fixture" }] } },
      { inputSnapshot: { ...discussion.inputSnapshot, rawPayload: {} } },
      { liveDiscussion: {} },
    ]) {
      expect(Value.Check(InvestigationWorkItemDiscussionSchema, { ...discussion, ...fields })).toBe(
        false,
      );
    }
  });
});

describe("investigation workspace search contracts", () => {
  it("requires bounded search text and accepts optional repository scope", () => {
    const query: InvestigationWorkspaceSearchQuery = {
      query: "x".repeat(200),
      repositoryId: "repo-fixture",
      limit: 30,
    };
    expect(Value.Check(InvestigationWorkspaceSearchQuerySchema, query)).toBe(true);
    expect(Value.Check(InvestigationWorkspaceSearchQuerySchema, { query: "x", limit: 1 })).toBe(
      true,
    );
    for (const fields of [
      { query: undefined },
      { query: "" },
      { query: "x".repeat(201) },
      { query: null },
      { repositoryId: "" },
      { limit: 0 },
      { limit: 31 },
      { limit: 1.5 },
      { limit: "10" },
      { cursor: "unexpected" },
    ]) {
      expect(Value.Check(InvestigationWorkspaceSearchQuerySchema, { ...query, ...fields })).toBe(
        false,
      );
    }
  });

  it("accepts empty results and all typed entity kinds with nullable links", () => {
    const empty: InvestigationWorkspaceSearchResult = { items: [], truncated: false };
    expect(Value.Check(InvestigationWorkspaceSearchResultSchema, empty)).toBe(true);
    for (const kind of ["repository", "work_item", "task", "report"] as const) {
      const result: InvestigationWorkspaceSearchResult = {
        items: [{ ...searchItem, kind }],
        truncated: false,
      };
      expect(Value.Check(InvestigationWorkspaceSearchResultSchema, result)).toBe(true);
    }
    expect(
      Value.Check(InvestigationWorkspaceSearchResultSchema, {
        items: [
          {
            ...searchItem,
            workItemId: "work-item-fixture",
            taskId: "task-fixture",
            updatedAt: timestamp,
          },
        ],
        truncated: true,
      }),
    ).toBe(true);
  });

  it("bounds results and rejects unknown wrapper or item fields", () => {
    const result = { items: Array.from({ length: 30 }, () => searchItem), truncated: true };
    expect(Value.Check(InvestigationWorkspaceSearchResultSchema, result)).toBe(true);
    for (const fields of [
      { items: [...result.items, searchItem] },
      { items: null },
      { truncated: "false" },
      { nextCursor: null },
    ]) {
      expect(Value.Check(InvestigationWorkspaceSearchResultSchema, { ...result, ...fields })).toBe(
        false,
      );
    }
    for (const fields of [
      { kind: "artifact" },
      { workItemId: undefined },
      { taskId: undefined },
      { updatedAt: undefined },
      { updatedAt: "invalid" },
      { title: null },
      { rawPayload: {} },
    ]) {
      expect(
        Value.Check(InvestigationWorkspaceSearchResultSchema, {
          items: [{ ...searchItem, ...fields }],
          truncated: false,
        }),
      ).toBe(false);
    }
  });
});

describe("investigation media publication contracts", () => {
  it("accepts typed media records and an empty publication", () => {
    expect(Value.Check(InvestigationMediaPublicationSchema, media)).toBe(true);
    expect(
      Value.Check(InvestigationMediaPublicationSchema, {
        ...media,
        state: "ready",
        retryable: false,
        totalCount: 0,
        uploads: [],
      }),
    ).toBe(true);
  });

  it.each(["ready", "pending", "blocked", "unknown"])("accepts publication state %s", (state) => {
    expect(Value.Check(InvestigationMediaPublicationSchema, { ...media, state })).toBe(true);
  });

  it.each(["prepared", "uploading", "uploaded", "blocked", "rejected", "unknown"])(
    "accepts upload state %s",
    (state) => {
      expect(
        Value.Check(InvestigationMediaPublicationSchema, {
          ...media,
          uploads: [{ ...media.uploads[0], state }],
        }),
      ).toBe(true);
    },
  );

  it("accepts a published URL or a blocked reason with typed feature links", () => {
    expect(
      Value.Check(InvestigationMediaPublicationSchema, {
        ...media,
        state: "blocked",
        uploadedCount: 1,
        totalCount: 2,
        blockers: ["The upload needs attention."],
        uploads: [
          {
            ...media.uploads[0],
            state: "uploaded",
            url: "https://example.invalid/media/fixture.png",
          },
          { ...media.uploads[0], state: "blocked", reason: "The provider rejected the fixture." },
        ],
      }),
    ).toBe(true);
  });

  it("requires nonnegative integral counts, boolean retryability, and a strict wrapper", () => {
    for (const field of ["uploadedCount", "totalCount"]) {
      for (const value of [-1, 1.5, "1", null]) {
        expect(Value.Check(InvestigationMediaPublicationSchema, { ...media, [field]: value })).toBe(
          false,
        );
      }
    }
    for (const fields of [
      { reportId: "" },
      { state: "uploaded" },
      { retryable: "true" },
      { blockers: [null] },
      { uploads: null },
      { providerEnvelope: {} },
    ]) {
      expect(Value.Check(InvestigationMediaPublicationSchema, { ...media, ...fields })).toBe(false);
    }
  });

  it("requires explicit nullable upload details and rejects malformed nested fields", () => {
    for (const fields of [
      { artifactId: "" },
      { state: "ready" },
      { digest: "invalid" },
      { url: undefined },
      { reason: undefined },
      { url: 1 },
      { reason: {} },
      { featureIds: [""] },
      { featureIds: null },
      { uploadToken: "private-value" },
    ]) {
      expect(
        Value.Check(InvestigationMediaPublicationSchema, {
          ...media,
          uploads: [{ ...media.uploads[0], ...fields }],
        }),
      ).toBe(false);
    }
  });
});
