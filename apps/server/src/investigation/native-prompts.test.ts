import { createHash } from "node:crypto";
import {
  createInvestigationPreview,
  type InvestigationInputSnapshotV1,
  type InvestigationNativePromptContent,
  type InvestigationNativePromptKind,
  type InvestigationNativePromptSnapshot,
  type InvestigationNativePromptVersion,
  type InvestigationTaskV1,
  nativePromptBuiltInContent,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { InvestigationService } from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const stores: InvestigationStore[] = [];
const timestamp = "2026-10-01T02:00:00.000Z";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Every repository, task, snapshot, and account is an isolated synthetic fixture. */
function fixture(kind: InvestigationNativePromptKind = "pr-review") {
  const store = new InvestigationStore();
  stores.push(store);
  const original = createInvestigationPreview(kind === "pr-review" ? "pr" : "bug", {
    findingCount: 0,
  }).task;
  const item: InvestigationWorkItemRecord = {
    ...original.workItem,
    repositoryId: original.repository.id,
    body: "Synthetic native prompt fixture without upstream activity.",
    state: "open",
    subject: original.subjects.find((entry) => entry.id === original.subjectRef)!,
    updatedAt: timestamp,
  };
  store.insert("repositories", original.repository.id, original.repository);
  store.insert("workItems", item.id, item);
  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-prompt-manager",
    displayName: "Synthetic prompt manager",
    repositoryIds: [original.repository.id],
    permissions: ["repository:manage", "task:create", "task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  let sequence = 0;
  const service = new InvestigationService({
    store,
    now: () => new Date(timestamp),
    idFactory: () => `synthetic-native-prompt-${++sequence}`,
  });
  return {
    store,
    service,
    prompts: service.prompts,
    actor,
    item,
    repository: original.repository,
    worker: { id: "synthetic-prompt-worker", repositoryIds: [original.repository.id] },
  };
}

function contentFor(label: string): InvestigationNativePromptContent {
  return {
    localCheckout: `Review the pinned source using synthetic native guidance ${label}.`,
    snapshot: `Assess the frozen snapshot using synthetic native guidance ${label}.`,
  };
}

function versionRef(
  version: InvestigationNativePromptVersion,
): InvestigationNativePromptSnapshot["ref"] {
  return { id: version.id, version: version.version, digest: version.digest };
}

function catalogItem(h: ReturnType<typeof fixture>, kind: InvestigationNativePromptKind) {
  const item = h.prompts
    .catalog(h.actor, h.repository.id)
    .items.find((entry) => entry.kind === kind);
  if (item === undefined) throw new Error("Expected a synthetic native prompt catalog item.");
  return item;
}

function publishAndBind(
  h: ReturnType<typeof fixture>,
  kind: InvestigationNativePromptKind,
  label: string,
) {
  const current = catalogItem(h, kind);
  const version = h.prompts.publish(h.actor, h.repository.id, kind, {
    expectedVersion: current.versions[0]!.version,
    name: `Synthetic guidance ${label}`,
    content: contentFor(label),
  });
  h.prompts.bind(h.actor, h.repository.id, kind, {
    expectedVersion: current.binding.version,
    promptRef: versionRef(version),
  });
  return version;
}

function saveImportedSource(h: ReturnType<typeof fixture>) {
  const item = structuredClone(h.item);
  const comments: InvestigationInputSnapshotV1["comments"] = [];
  if (item.subject.kind === "original_pr") {
    item.subject.revisionKey = createHash("sha256")
      .update(`${item.subject.baseSha}\0${item.subject.headSha}`)
      .digest("hex");
  } else if (item.subject.kind === "issue_snapshot") {
    item.subject.snapshotDigest = investigationContentDigest({
      title: item.title,
      body: item.body,
      comments,
    });
  } else {
    throw new Error("Expected an original synthetic PR or Issue subject.");
  }
  h.store.put("workItems", item.id, item);
  const inputSnapshot: InvestigationInputSnapshotV1 = {
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: item.repositoryId,
    workItemId: item.id,
    subjectRef: item.subject.id,
    subjectRevisionKey: item.subject.revisionKey,
    title: item.title,
    body: item.body,
    comments,
    source: null,
  };
  const digest = investigationContentDigest(inputSnapshot);
  const snapshotRef = { id: `snapshot:${digest}`, digest };
  h.store.insert("sourceSnapshots", snapshotRef.id, { ...snapshotRef, inputSnapshot });
  return { workItem: item, snapshotRef };
}

describe("native prompt catalogs and task bindings", () => {
  it("provides separate built-in PR and Issue versions with an unmodified initial binding", () => {
    const h = fixture();
    const catalog = h.prompts.catalog(h.actor, h.repository.id);
    expect(catalog.repositoryId).toBe(h.repository.id);
    expect(catalog.items.map((item) => item.kind)).toEqual(["pr-review", "issue-investigate"]);
    for (const item of catalog.items) {
      const builtIn = item.versions[0]!;
      expect(item.versions).toHaveLength(1);
      expect(builtIn).toMatchObject({
        repositoryId: h.repository.id,
        kind: item.kind,
        version: 1,
        content: nativePromptBuiltInContent(item.kind),
        digest: investigationContentDigest(nativePromptBuiltInContent(item.kind)),
        createdBy: null,
      });
      expect(item.binding).toEqual({
        version: 0,
        promptRef: versionRef(builtIn),
        updatedAt: null,
        updatedBy: null,
      });
      expect(item.runtimeConstraints.localCheckout).toContain("InvestigationModelTurnDeltaV1");
      expect(item.runtimeConstraints.snapshot).toContain("Do not invoke tools.");
      expect(h.prompts.freeze(h.repository.id, item.kind)).toEqual({
        kind: item.kind,
        ref: versionRef(builtIn),
        content: builtIn.content,
      });
    }
  });

  it("permits repository managers without requiring administrator access and checks repository scope", () => {
    const h = fixture();
    const current = catalogItem(h, "pr-review");
    const manager: InvestigationOperatorPrincipal = {
      ...h.actor,
      permissions: ["repository:manage"],
    };
    const version = h.prompts.publish(manager, h.repository.id, "pr-review", {
      expectedVersion: 1,
      name: "Repository-managed guidance",
      content: contentFor("manager"),
    });
    expect(version.createdBy).toBe(manager.id);
    const reader: InvestigationOperatorPrincipal = { ...h.actor, permissions: [], isAdmin: true };
    expect(h.prompts.catalog(reader, h.repository.id).items).toHaveLength(2);
    for (const principal of [
      reader,
      { ...manager, repositoryIds: ["synthetic-other-repository"], isAdmin: true },
    ]) {
      const before = h.store.list("idempotency");
      expect(() =>
        h.prompts.publish(principal, h.repository.id, "pr-review", {
          expectedVersion: version.version,
          name: "Forbidden guidance",
          content: contentFor("forbidden"),
        }),
      ).toThrow(expect.objectContaining({ statusCode: 403, code: "native_prompt_access_denied" }));
      expect(() =>
        h.prompts.bind(principal, h.repository.id, "pr-review", {
          expectedVersion: current.binding.version,
          promptRef: versionRef(version),
        }),
      ).toThrow(expect.objectContaining({ statusCode: 403, code: "native_prompt_access_denied" }));
      expect(h.store.list("idempotency")).toEqual(before);
    }
    expect(() => h.prompts.catalog({ ...manager, repositoryIds: [] }, h.repository.id)).toThrow(
      expect.objectContaining({ statusCode: 403, code: "native_prompt_access_denied" }),
    );
  });

  it("preserves immutable versions and leaves the binding unchanged until explicitly switched", () => {
    const h = fixture();
    const current = catalogItem(h, "pr-review");
    const content = contentFor("A");
    const version = h.prompts.publish(h.actor, h.repository.id, "pr-review", {
      expectedVersion: 1,
      name: "Synthetic guidance A",
      content,
    });
    const ref = versionRef(version);
    content.snapshot = "Mutated request content.";
    version.content.localCheckout = "Mutated returned content.";
    expect(catalogItem(h, "pr-review").binding).toEqual(current.binding);
    const frozen = h.prompts.freeze(h.repository.id, "pr-review", ref);
    expect(frozen.content).toEqual(contentFor("A"));
    frozen.content.snapshot = "Mutated returned frozen content.";
    expect(h.prompts.freeze(h.repository.id, "pr-review", ref).content).toEqual(contentFor("A"));
    expect(catalogItem(h, "pr-review").versions.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("rejects stale catalog and binding versions without changing published state or audit records", () => {
    const h = fixture();
    const first = publishAndBind(h, "pr-review", "A");
    const second = h.prompts.publish(h.actor, h.repository.id, "pr-review", {
      expectedVersion: first.version,
      name: "Synthetic guidance B",
      content: contentFor("B"),
    });
    const before = h.store.list("idempotency");
    expect(() =>
      h.prompts.publish(h.actor, h.repository.id, "pr-review", {
        expectedVersion: first.version,
        name: "Stale guidance",
        content: contentFor("stale"),
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: "native_prompt_version_conflict" }));
    expect(() =>
      h.prompts.bind(h.actor, h.repository.id, "pr-review", {
        expectedVersion: 0,
        promptRef: versionRef(second),
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409, code: "native_prompt_binding_conflict" }));
    expect(h.store.list("idempotency")).toEqual(before);
    expect(catalogItem(h, "pr-review").binding.promptRef).toEqual(versionRef(first));
    const bound = h.prompts.bind(h.actor, h.repository.id, "pr-review", {
      expectedVersion: 1,
      promptRef: versionRef(second),
    });
    expect(bound).toMatchObject({
      version: 2,
      promptRef: versionRef(second),
      updatedBy: h.actor.id,
    });
  });

  it("rejects references from another review type or with a changed content digest", () => {
    const h = fixture();
    const pr = publishAndBind(h, "pr-review", "PR");
    const before = h.store.list("idempotency");
    for (const [kind, promptRef] of [
      ["issue-investigate", versionRef(pr)],
      ["pr-review", { ...versionRef(pr), digest: "0".repeat(64) }],
    ] as const) {
      expect(() =>
        h.prompts.bind(h.actor, h.repository.id, kind, {
          expectedVersion: kind === "pr-review" ? 1 : 0,
          promptRef,
        }),
      ).toThrow(
        expect.objectContaining({
          statusCode: 409,
          code: "native_prompt_reference_unavailable",
        }),
      );
    }
    expect(h.store.list("idempotency")).toEqual(before);
  });

  it.each(["pr-review", "issue-investigate"] as const)(
    "freezes the selected %s content and applies binding changes only to subsequent roots",
    async (kind) => {
      const h = fixture(kind);
      const firstVersion = publishAndBind(h, kind, "A");
      const request = { kind, workItemId: h.item.id, idempotencyKey: "before-binding-change" };
      const first = await h.service.createTask(h.actor, request);
      const expectedSnapshot = { kind, ref: versionRef(firstVersion), content: contentFor("A") };
      expect(first.promptRef).toEqual(versionRef(firstVersion));
      expect(first.promptSnapshot).toEqual(expectedSnapshot);
      const secondVersion = publishAndBind(h, kind, "B");
      const replayed = await h.service.createTask(h.actor, request);
      expect(replayed.id).toBe(first.id);
      expect(replayed.promptSnapshot).toEqual(expectedSnapshot);
      expect(h.store.get<InvestigationTaskV1>("tasks", first.id)?.promptSnapshot).toEqual(
        expectedSnapshot,
      );
      const claim = h.service.workerClaim(h.worker, { supportedKinds: [kind] }).claim;
      expect(claim?.task.id).toBe(first.id);
      expect(claim?.task.promptSnapshot).toEqual(expectedSnapshot);
      const fresh = await h.service.createTask(h.actor, {
        ...request,
        idempotencyKey: "after-binding-change",
      });
      expect(fresh.promptRef).toEqual(versionRef(secondVersion));
      expect(fresh.promptSnapshot).toEqual({
        kind,
        ref: versionRef(secondVersion),
        content: contentFor("B"),
      });
      const explicit = await h.service.createTask(h.actor, {
        ...request,
        idempotencyKey: "explicit-prior-prompt",
        promptRef: versionRef(firstVersion),
      });
      expect(explicit.promptSnapshot).toEqual(expectedSnapshot);
    },
  );

  it.each(["pr-review", "issue-investigate"] as const)(
    "freezes the selected %s content for imported roots without requiring a prepared-input hook",
    async (kind) => {
      const h = fixture(kind);
      const version = publishAndBind(h, kind, "imported");
      const task = await h.service.createImportedTask(
        h.actor,
        {
          kind,
          workItemId: h.item.id,
          idempotencyKey: "synthetic-imported-prompt",
        },
        saveImportedSource(h),
      );
      expect(task.promptSnapshot).toEqual({
        kind,
        ref: versionRef(version),
        content: contentFor("imported"),
      });
      expect(task.parentTaskId).toBeNull();
    },
  );
});
