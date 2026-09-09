import type { ConfigurationAuditEvent, ConfigurationAuditSummary } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  configurationAuditDetailKey,
  configurationAuditListKey,
  configurationAuditMatchesSummary,
  configurationAuditRevisionLabel,
  configurationAuditRowKey,
} from "./state";

const principal = { issuer: "https://issuer.example", subject: "operator-one" };
const summary = {
  id: "event-one",
  source: "prompt",
  action: "draft_saved",
  entityId: "template-one",
  repositoryId: null,
  actor: principal,
  createdAt: "2026-09-07T02:00:00.000Z",
  version: 3,
} satisfies ConfigurationAuditSummary;
const event: ConfigurationAuditEvent = { ...summary, snapshot: { version: 3, draftRevision: 2 } };

describe("configuration audit presentation identity", () => {
  it("keeps both source and event ID in row identity", () => {
    expect(configurationAuditRowKey(summary)).not.toEqual(
      configurationAuditRowKey({
        ...summary,
        source: "repository",
        action: "updated",
        repositoryId: "repo-one",
      }),
    );
  });

  it("isolates pagination, repository, template, principal, transport, and session", () => {
    const key = configurationAuditListKey(
      "connected",
      { kind: "global" },
      principal,
      "epoch:1",
      1,
      20,
    );
    const alternatives = [
      configurationAuditListKey("sample", { kind: "global" }, principal, "epoch:1", 1, 20),
      configurationAuditListKey(
        "connected",
        { kind: "repository", repositoryId: "repo-one" },
        principal,
        "epoch:1",
        1,
        20,
      ),
      configurationAuditListKey(
        "connected",
        { kind: "global", templateId: "template-one" },
        principal,
        "epoch:1",
        1,
        20,
      ),
      configurationAuditListKey(
        "connected",
        { kind: "global" },
        { ...principal, issuer: "other-issuer" },
        "epoch:1",
        1,
        20,
      ),
      configurationAuditListKey(
        "connected",
        { kind: "global" },
        { ...principal, subject: "other-operator" },
        "epoch:1",
        1,
        20,
      ),
      configurationAuditListKey("connected", { kind: "global" }, principal, "epoch:2", 1, 20),
      configurationAuditListKey("connected", { kind: "global" }, principal, "epoch:1", 2, 20),
      configurationAuditListKey("connected", { kind: "global" }, principal, "epoch:1", 1, 10),
    ];
    for (const other of alternatives) expect(key).not.toEqual(other);
  });

  it.each([
    { id: "event-two" },
    { source: "repository" },
    { action: "prompt_published" },
    { entityId: "template-two" },
    { repositoryId: "repo-two" },
    { actor: { ...principal, issuer: "other-issuer" } },
    { actor: { ...principal, subject: "other-operator" } },
    { createdAt: "2026-09-07T02:00:01.000Z" },
    { version: 4 },
  ])("rejects a changed immutable summary field: %j", (change) => {
    const changed = { ...event, ...change } as ConfigurationAuditEvent;
    expect(configurationAuditMatchesSummary(changed, summary)).toBe(false);
    expect(
      configurationAuditDetailKey("connected", { kind: "global" }, principal, "one", changed),
    ).not.toEqual(
      configurationAuditDetailKey("connected", { kind: "global" }, principal, "one", summary),
    );
  });

  it("distinguishes template revisions from published versions", () => {
    expect(configurationAuditMatchesSummary(event, summary)).toBe(true);
    expect(configurationAuditRevisionLabel(summary)).toBe("Template revision 3");
    expect(configurationAuditRevisionLabel({ ...summary, action: "prompt_published" })).toBe(
      "Template revision 3",
    );
    expect(configurationAuditRevisionLabel({ ...summary, action: "prompt_bound" })).toBe(
      "Binding revision 3",
    );
    expect(
      configurationAuditRevisionLabel({
        ...summary,
        action: "profile_published",
        repositoryId: "repo-one",
      }),
    ).toBe("Profile version 3");
    expect(
      configurationAuditRevisionLabel({
        ...summary,
        action: "bootstrap_registered",
        version: null,
      }),
    ).toBe("No revision recorded");
  });
});
