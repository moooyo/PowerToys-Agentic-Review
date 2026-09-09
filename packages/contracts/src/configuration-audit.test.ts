import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type ConfigurationAuditEvent,
  ConfigurationAuditEventSchema,
  ConfigurationAuditSummarySchema,
  GlobalConfigurationAuditListQuerySchema,
  GlobalConfigurationAuditListResponseSchema,
  GlobalConfigurationAuditReadQuerySchema,
  maximumConfigurationAuditPageSize,
  PromptConfigurationAuditSnapshots,
  RepositoryConfigurationAuditListQuerySchema,
  RepositoryConfigurationAuditListResponseSchema,
  RepositoryConfigurationAuditReadQuerySchema,
  RepositoryConfigurationSnapshotSchema,
  RepositoryConfigurationSnapshotV1Schema,
  RepositoryConfigurationSnapshotV2Schema,
} from "./configuration-audit.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const common = {
  id: "audit-1",
  entityId: "entity-1",
  actor: { issuer: "local", subject: "operator-1" },
  createdAt: "2026-09-07T00:00:00.000Z",
};
const repositorySnapshot = {
  id: "repository-1",
  githubRepositoryId: 165_898_499,
  fullName: "microsoft/PowerToys",
  enabled: true,
  version: 1,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  connectionStatus: "unknown" as const,
  connectionMessage: null,
  createdAt: common.createdAt,
  updatedAt: common.createdAt,
};
const promptCases = [
  {
    action: "template_created",
    repositoryId: null,
    version: 1,
    snapshot: { workflowKind: "pr_static_build", version: 1 },
  },
  {
    action: "draft_saved",
    repositoryId: null,
    version: 4,
    snapshot: { version: 4, draftRevision: 3 },
  },
  {
    action: "prompt_published",
    repositoryId: null,
    version: 5,
    snapshot: { promptVersionId: "prompt-version-1", publishedVersion: 2, version: 5 },
  },
  {
    action: "prompt_bound",
    repositoryId: null,
    version: 2,
    snapshot: {
      workflowKind: "pr_static_build",
      promptVersionId: "prompt-version-2",
      previousVersionId: "prompt-version-1",
      version: 2,
    },
  },
  {
    action: "profile_published",
    repositoryId: "repository-1",
    version: 2,
    snapshot: { profileVersionId: "profile-version-2", version: 2 },
  },
  {
    action: "profile_bound",
    repositoryId: "repository-1",
    version: 2,
    snapshot: {
      profileId: "profile-1",
      profileVersionId: "profile-version-2",
      previousVersionId: "profile-version-1",
      enabled: false,
      version: 2,
    },
  },
  {
    action: "bootstrap_registered",
    entityId: "pr_static_build",
    repositoryId: null,
    version: null,
    snapshot: { promptVersionId: "bootstrap-prompt-version-1" },
  },
] as const;
const repositoryEvents = (["created", "updated", "bootstrapped"] as const).map((action) => ({
  ...common,
  entityId: "repository-1",
  source: "repository" as const,
  action,
  repositoryId: "repository-1",
  version: 1,
  snapshot: repositorySnapshot,
}));
const promptEvents = promptCases.map((event) => ({
  ...common,
  source: "prompt" as const,
  ...event,
}));
const events: ConfigurationAuditEvent[] = [
  ...repositoryEvents,
  ...promptEvents,
  { ...common, source: "prompt", ...promptCases[3], repositoryId: "repository-1" },
];

describe("historical repository configuration snapshots", () => {
  it("preserves the exact V1 fields and serialized historical snapshot", () => {
    const before = JSON.stringify(repositorySnapshot);
    expect(Value.Check(RepositoryConfigurationSnapshotV1Schema, repositorySnapshot)).toBe(true);
    expect(Value.Check(RepositoryConfigurationSnapshotSchema, repositorySnapshot)).toBe(true);
    expect(JSON.stringify(repositorySnapshot)).toBe(before);
    expect(Object.keys(RepositoryConfigurationSnapshotV1Schema.properties)).toEqual([
      "id",
      "githubRepositoryId",
      "fullName",
      "enabled",
      "version",
      "reviewerGithubUserId",
      "reviewerGithubLogin",
      "authorizationPolicy",
      "connectionStatus",
      "connectionMessage",
      "createdAt",
      "updatedAt",
    ]);
    for (const field of Object.keys(repositorySnapshot)) {
      const incomplete: Record<string, unknown> = { ...repositorySnapshot };
      delete incomplete[field];
      expect(Value.Check(RepositoryConfigurationSnapshotV1Schema, incomplete), field).toBe(false);
    }
  });

  it.each(repositoryEvents)(
    "reads both recorded shapes for $action without defaulting limits",
    (event) => {
      const snapshot = {
        ...repositorySnapshot,
        schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: null },
      };
      expect(Value.Check(RepositoryConfigurationSnapshotV1Schema, snapshot)).toBe(false);
      expect(Value.Check(RepositoryConfigurationSnapshotV2Schema, snapshot)).toBe(true);
      expect(Value.Check(RepositoryConfigurationSnapshotV2Schema, repositorySnapshot)).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, event)).toBe(true);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot })).toBe(true);
      expect("schedulingLimits" in event.snapshot).toBe(false);
    },
  );

  it("prevents malformed new snapshots from falling through to the old strict shape", () => {
    for (const schedulingLimits of [
      null,
      {},
      { maxActiveLeases: 1 },
      { maxActiveLeases: 0, maxQueuedJobs: null },
      { maxActiveLeases: null, maxQueuedJobs: 1_000_001 },
      { maxActiveLeases: null, maxQueuedJobs: null, secret: "hidden" },
    ]) {
      const snapshot = { ...repositorySnapshot, schedulingLimits };
      expect(Value.Check(RepositoryConfigurationSnapshotV1Schema, snapshot)).toBe(false);
      expect(Value.Check(RepositoryConfigurationSnapshotV2Schema, snapshot)).toBe(false);
      expect(Value.Check(RepositoryConfigurationSnapshotSchema, snapshot)).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...repositoryEvents[0], snapshot })).toBe(
        false,
      );
    }
    for (const schema of [
      RepositoryConfigurationSnapshotV1Schema,
      RepositoryConfigurationSnapshotSchema,
    ]) {
      expect(Value.Check(schema, { ...repositorySnapshot, schemaVersion: "V1" })).toBe(false);
    }
  });
});

describe("configuration audit event discrimination", () => {
  it.each(events)("accepts $source / $action in scope $repositoryId", (event) => {
    const { snapshot, ...summary } = event;
    expect(Value.Check(ConfigurationAuditEventSchema, event)).toBe(true);
    expect(Value.Check(ConfigurationAuditSummarySchema, summary)).toBe(true);
    expect(Value.Check(ConfigurationAuditSummarySchema, { ...summary, snapshot })).toBe(false);
    expect(Value.Check(ConfigurationAuditEventSchema, summary)).toBe(false);

    const wrongSource = event.source === "repository" ? "prompt" : "repository";
    expect(Value.Check(ConfigurationAuditSummarySchema, { ...summary, source: wrongSource })).toBe(
      false,
    );
    expect(Value.Check(ConfigurationAuditEventSchema, { ...event, source: wrongSource })).toBe(
      false,
    );
    for (const source of ["profile", "unknown", null]) {
      expect(Value.Check(ConfigurationAuditSummarySchema, { ...summary, source })).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...event, source })).toBe(false);
    }

    for (const action of ["deleted", "published", null]) {
      expect(Value.Check(ConfigurationAuditSummarySchema, { ...summary, action })).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...event, action })).toBe(false);
    }
    if (event.action !== "prompt_bound") {
      const wrongScope = event.repositoryId === null ? "repository-1" : null;
      expect(
        Value.Check(ConfigurationAuditSummarySchema, { ...summary, repositoryId: wrongScope }),
      ).toBe(false);
      expect(
        Value.Check(ConfigurationAuditEventSchema, { ...event, repositoryId: wrongScope }),
      ).toBe(false);
    }
  });

  it.each(events)("requires the recorded revision for $action", (event) => {
    const { snapshot: _snapshot, ...summary } = event;
    const invalidVersions =
      event.action === "bootstrap_registered" ? [0, 1, "1"] : [null, 0, -1, 1.5, "1"];
    for (const version of invalidVersions) {
      expect(Value.Check(ConfigurationAuditSummarySchema, { ...summary, version })).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...event, version })).toBe(false);
    }
  });

  it.each(events)("rejects extra fields and malformed attribution for $action", (event) => {
    const { snapshot: _snapshot, ...summary } = event;
    for (const schema of [ConfigurationAuditSummarySchema, ConfigurationAuditEventSchema]) {
      const record = schema === ConfigurationAuditSummarySchema ? summary : event;
      expect(Value.Check(schema, { ...record, unexpected: true })).toBe(false);
      expect(Value.Check(schema, { ...record, actor: "local/operator-1" })).toBe(false);
      expect(Value.Check(schema, { ...record, actor: { issuer: "local" } })).toBe(false);
      expect(Value.Check(schema, { ...record, actor: { ...common.actor, role: "admin" } })).toBe(
        false,
      );
      expect(Value.Check(schema, { ...record, createdAt: "not-a-date" })).toBe(false);
      expect(Value.Check(schema, { ...record, id: "../audit-1" })).toBe(false);
    }
  });

  it("requires the recorded repository snapshot rather than a repository list summary", () => {
    const event = repositoryEvents[0];
    const { authorizationPolicy: _authorizationPolicy, ...summary } = repositorySnapshot;
    expect(Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot: summary })).toBe(false);
    expect(
      Value.Check(ConfigurationAuditEventSchema, {
        ...event,
        snapshot: { ...repositorySnapshot, unexpected: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot: promptCases[0].snapshot }),
    ).toBe(false);
  });
});

describe("historical prompt audit snapshots", () => {
  it.each(promptCases)("requires exactly the retained fields for $action", (entry) => {
    const schema = PromptConfigurationAuditSnapshots[entry.action];
    const event = { ...common, source: "prompt", ...entry };
    expect(Value.Check(schema, entry.snapshot)).toBe(true);
    for (const field of Object.keys(entry.snapshot)) {
      const incomplete: Record<string, unknown> = { ...entry.snapshot };
      delete incomplete[field];
      expect(Value.Check(schema, incomplete), `Missing ${field}`).toBe(false);
      expect(
        Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot: incomplete }),
        `Missing ${field} in event snapshot`,
      ).toBe(false);
    }
    for (const field of ["unexpected", "content", "draftContent", "config", "actor"]) {
      const snapshot = { ...entry.snapshot, [field]: "Present-day data is not historical data." };
      expect(Value.Check(schema, snapshot), `Unexpected ${field}`).toBe(false);
      expect(Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot })).toBe(false);
    }
    for (const other of promptCases.filter((candidate) => candidate.action !== entry.action)) {
      expect(
        Value.Check(ConfigurationAuditEventSchema, { ...event, snapshot: other.snapshot }),
        `Snapshot from ${other.action}`,
      ).toBe(false);
    }
  });

  it("keeps template creation at revision one and draft revisions positive", () => {
    expect(
      Value.Check(PromptConfigurationAuditSnapshots.template_created, {
        workflowKind: "pr_static_build",
        version: 2,
      }),
    ).toBe(false);
    for (const field of ["version", "draftRevision"]) {
      for (const value of [0, -1, 1.5, "1", null]) {
        expect(
          Value.Check(PromptConfigurationAuditSnapshots.draft_saved, {
            version: 4,
            draftRevision: 3,
            [field]: value,
          }),
        ).toBe(false);
      }
    }
  });

  it.each([promptCases[3], promptCases[5]])(
    "represents a first $action binding with a null previous version",
    (entry) => {
      expect(
        Value.Check(ConfigurationAuditEventSchema, {
          ...common,
          source: "prompt",
          ...entry,
          version: 1,
          snapshot: { ...entry.snapshot, previousVersionId: null, version: 1 },
        }),
      ).toBe(true);
      expect(
        Value.Check(PromptConfigurationAuditSnapshots[entry.action], {
          ...entry.snapshot,
          previousVersionId: "",
        }),
      ).toBe(false);
    },
  );

  it("does not coerce binding enablement or accept unrecognized workflows", () => {
    expect(
      Value.Check(PromptConfigurationAuditSnapshots.profile_bound, {
        ...promptCases[5].snapshot,
        enabled: "false",
      }),
    ).toBe(false);
    for (const entry of [promptCases[0], promptCases[3]]) {
      expect(
        Value.Check(PromptConfigurationAuditSnapshots[entry.action], {
          ...entry.snapshot,
          workflowKind: "unknown",
        }),
      ).toBe(false);
    }
  });
});

describe("configuration audit queries", () => {
  const listQueries = [
    {
      name: "repository",
      schema: RepositoryConfigurationAuditListQuerySchema,
      query: { repositoryId: "repository-1" },
    },
    { name: "global", schema: GlobalConfigurationAuditListQuerySchema, query: {} },
  ];

  it.each(listQueries)("bounds optional pagination for $name lists", ({ schema, query }) => {
    expect(Value.Check(schema, query)).toBe(true);
    expect(Value.Check(schema, { ...query, page: 1, pageSize: 1 })).toBe(true);
    expect(Value.Check(schema, { ...query, page: 10_000_000, pageSize: 20 })).toBe(true);
    for (const page of [0, -1, 1.5, 10_000_001, "1", null]) {
      expect(Value.Check(schema, { ...query, page })).toBe(false);
    }
    for (const pageSize of [0, -1, 1.5, 21, "20", null]) {
      expect(Value.Check(schema, { ...query, pageSize })).toBe(false);
    }
    expect(Value.Check(schema, { ...query, unexpected: true })).toBe(false);
  });

  it("separates repository scope from the optional global template filter", () => {
    expect(Value.Check(RepositoryConfigurationAuditListQuerySchema, {})).toBe(false);
    expect(
      Value.Check(RepositoryConfigurationAuditListQuerySchema, {
        repositoryId: "repository-1",
        templateId: "template-1",
      }),
    ).toBe(false);
    expect(Value.Check(GlobalConfigurationAuditListQuerySchema, { templateId: "template-1" })).toBe(
      true,
    );
    expect(
      Value.Check(GlobalConfigurationAuditListQuerySchema, { repositoryId: "repository-1" }),
    ).toBe(false);
    for (const id of [null, "", "../other", "a".repeat(129)]) {
      expect(Value.Check(RepositoryConfigurationAuditListQuerySchema, { repositoryId: id })).toBe(
        false,
      );
      expect(Value.Check(GlobalConfigurationAuditListQuerySchema, { templateId: id })).toBe(false);
    }
  });

  it("requires repository and source for scoped reads while global reads take only an event ID", () => {
    const query = { repositoryId: "repository-1", source: "repository", eventId: "audit-1" };
    for (const source of ["repository", "prompt"]) {
      expect(Value.Check(RepositoryConfigurationAuditReadQuerySchema, { ...query, source })).toBe(
        true,
      );
    }
    for (const field of Object.keys(query)) {
      const incomplete: Record<string, unknown> = { ...query };
      delete incomplete[field];
      expect(Value.Check(RepositoryConfigurationAuditReadQuerySchema, incomplete)).toBe(false);
    }
    for (const source of ["unknown", null]) {
      expect(Value.Check(RepositoryConfigurationAuditReadQuerySchema, { ...query, source })).toBe(
        false,
      );
    }
    expect(
      Value.Check(RepositoryConfigurationAuditReadQuerySchema, { ...query, unexpected: true }),
    ).toBe(false);
    expect(Value.Check(GlobalConfigurationAuditReadQuerySchema, { eventId: "audit-1" })).toBe(true);
    expect(Value.Check(GlobalConfigurationAuditReadQuerySchema, {})).toBe(false);
    for (const extra of [
      { source: "prompt" },
      { repositoryId: "repository-1" },
      { unexpected: true },
    ]) {
      expect(
        Value.Check(GlobalConfigurationAuditReadQuerySchema, { eventId: "audit-1", ...extra }),
      ).toBe(false);
    }
    for (const eventId of [null, "", "../audit-1", "a".repeat(129)]) {
      expect(Value.Check(RepositoryConfigurationAuditReadQuerySchema, { ...query, eventId })).toBe(
        false,
      );
      expect(Value.Check(GlobalConfigurationAuditReadQuerySchema, { eventId })).toBe(false);
    }
  });
});

describe("configuration audit list responses", () => {
  const event = { ...common, source: "prompt", ...promptCases[0] };
  const { snapshot: _snapshot, ...summary } = event;
  const repositorySummary = {
    ...common,
    entityId: "repository-1",
    source: "repository",
    action: "created",
    repositoryId: "repository-1",
    version: 1,
  };
  const page = { items: [summary], total: 1, page: 1, pageSize: 20 };
  const repositoryPage = { ...page, items: [repositorySummary] };
  const responses = [
    {
      name: "repository",
      schema: RepositoryConfigurationAuditListResponseSchema,
      response: { repositoryId: "repository-1", ...repositoryPage },
      summary: repositorySummary,
      event: { ...repositorySummary, snapshot: repositorySnapshot },
    },
    {
      name: "global",
      schema: GlobalConfigurationAuditListResponseSchema,
      response: page,
      summary,
      event,
    },
  ];

  it.each(responses)(
    "requires bounded metadata and summary-only items for $name",
    ({ schema, response, summary, event }) => {
      expect(Value.Check(schema, response)).toBe(true);
      expect(Value.Check(schema, { ...response, items: [], total: 0 })).toBe(true);
      expect(
        Value.Check(schema, {
          ...response,
          items: Array.from({ length: maximumConfigurationAuditPageSize }, () => summary),
          total: Number.MAX_SAFE_INTEGER,
          page: 10_000_000,
        }),
      ).toBe(true);
      expect(
        Value.Check(schema, {
          ...response,
          items: Array.from({ length: 21 }, () => summary),
        }),
      ).toBe(false);
      expect(Value.Check(schema, { ...response, items: [event] })).toBe(false);
      expect(Value.Check(schema, { ...response, items: [{ ...summary, unexpected: true }] })).toBe(
        false,
      );
      expect(Value.Check(schema, { ...response, unexpected: true })).toBe(false);
      for (const field of Object.keys(page)) {
        const incomplete: Record<string, unknown> = { ...response };
        delete incomplete[field];
        expect(Value.Check(schema, incomplete), `Missing ${field}`).toBe(false);
      }
      for (const total of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        expect(Value.Check(schema, { ...response, total })).toBe(false);
      }
      for (const page of [0, 1.5, 10_000_001, "1", null]) {
        expect(Value.Check(schema, { ...response, page })).toBe(false);
      }
      for (const pageSize of [0, 1.5, 21, "20", null]) {
        expect(Value.Check(schema, { ...response, pageSize })).toBe(false);
      }
    },
  );

  it("preserves the response scope without accepting the other scope's identifier", () => {
    expect(Value.Check(RepositoryConfigurationAuditListResponseSchema, repositoryPage)).toBe(false);
    expect(
      Value.Check(RepositoryConfigurationAuditListResponseSchema, {
        ...repositoryPage,
        repositoryId: "repository-1",
        templateId: "template-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(GlobalConfigurationAuditListResponseSchema, {
        ...page,
        templateId: "template-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(GlobalConfigurationAuditListResponseSchema, {
        ...page,
        repositoryId: "repository-1",
      }),
    ).toBe(false);
    for (const id of [null, "", "../other"]) {
      expect(
        Value.Check(RepositoryConfigurationAuditListResponseSchema, {
          ...repositoryPage,
          repositoryId: id,
        }),
      ).toBe(false);
      expect(
        Value.Check(GlobalConfigurationAuditListResponseSchema, { ...page, templateId: id }),
      ).toBe(false);
    }
  });
});
