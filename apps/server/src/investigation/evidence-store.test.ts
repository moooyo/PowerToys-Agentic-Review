import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvestigationPreview,
  type InvestigationArtifactV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvestigationApp } from "../../dist/investigation/app.js";
import {
  type InvestigationEvidencePolicy,
  InvestigationEvidenceStore,
} from "../../dist/investigation/evidence-store.js";
import { InvestigationStore } from "../../dist/investigation/store.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];
const startedAt = Date.parse("2026-09-16T00:00:00.000Z");

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function open(path?: string): InvestigationStore {
  const store = new InvestigationStore(path);
  stores.push(store);
  return store;
}

function harness(policy: Partial<InvestigationEvidencePolicy> = {}, path?: string) {
  const store = open(path);
  let time = startedAt;
  const evidence = new InvestigationEvidenceStore(
    store,
    { retentionSeconds: 1, ...policy },
    () => new Date(time),
  );
  const task: InvestigationTaskV1 = {
    ...createInvestigationPreview("pr", { findingCount: 0 }).task,
    state: "completed",
    updatedAt: new Date(time).toISOString(),
  };
  store.insert("tasks", task.id, task);
  return {
    store,
    evidence,
    task,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

function artifact(
  task: InvestigationTaskV1,
  id: string,
  bytes = Buffer.from(id),
): InvestigationArtifactV1 {
  return {
    id,
    taskId: task.id,
    attemptId: "synthetic-attempt",
    subjectRef: task.subjectRef,
    kind: "log",
    name: `${id}.txt`,
    mediaType: "text/plain",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    availability: "available",
  };
}

function upload(
  evidence: InvestigationEvidenceStore,
  task: InvestigationTaskV1,
  id: string,
  bytes = Buffer.from(id),
) {
  const entry = artifact(task, id, bytes);
  evidence.upload(entry, bytes.toString("base64"), () => undefined);
  return entry;
}

describe("investigation evidence quotas and retention", () => {
  it("charges exact retries once, bounds empty artifacts, and rolls back failed lease checks", () => {
    const { evidence, store, task } = harness({ maximumBytes: 3, maximumCount: 2 });
    const first = upload(evidence, task, "a", Buffer.from("abc"));
    evidence.upload(first, Buffer.from("abc").toString("base64"), () => undefined);
    upload(evidence, task, "empty", Buffer.alloc(0));
    expect(() => upload(evidence, task, "over-count", Buffer.alloc(0))).toThrow(
      expect.objectContaining({ code: "evidence_quota_exceeded" }),
    );
    expect(() => upload(evidence, task, "over-bytes", Buffer.from("d"))).toThrow(
      expect.objectContaining({ code: "evidence_quota_exceeded" }),
    );
    expect(() =>
      evidence.upload({ ...first, id: "stale" }, "YWJj", () => {
        throw new Error("Stale lease");
      }),
    ).toThrow("Stale lease");
    expect(store.get("evidenceUsage", "global")).toMatchObject({ count: 2, bytes: 3 });
    expect(store.has("evidenceMetadata", "stale")).toBe(false);
    expect(() =>
      evidence.upload({ ...first, name: "changed.txt" }, "YWJj", () => undefined),
    ).toThrow(expect.objectContaining({ code: "artifact_identity_conflict" }));
  });

  it("rolls back content, metadata, and quota when persistence fails", () => {
    const { evidence, store, task } = harness();
    const insert = store.insert.bind(store);
    vi.spyOn(store, "insert").mockImplementation((collection, id, value) => {
      if (collection === "evidenceMetadata") throw new Error("Synthetic disk failure");
      return insert(collection, id, value);
    });
    expect(() => upload(evidence, task, "a")).toThrow("Synthetic disk failure");
    expect(store.has("evidenceAssets", "a")).toBe(false);
    expect(store.has("evidenceMetadata", "a")).toBe(false);
    expect(store.has("evidenceUsage", "global")).toBe(false);
  });

  it("shares quota and retry identity across database connections and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "investigation-retention-"));
    directories.push(directory);
    const path = join(directory, "investigation.sqlite");
    const { store, evidence, task } = harness({ maximumCount: 1 }, path);
    const secondStore = open(path);
    const second = new InvestigationEvidenceStore(secondStore, { maximumCount: 1 });
    const first = upload(evidence, task, "a");
    second.upload(first, Buffer.from("a").toString("base64"), () => undefined);
    expect(() => upload(second, task, "b")).toThrow(
      expect.objectContaining({ code: "evidence_quota_exceeded" }),
    );
    store.close();
    secondStore.close();
    const reopenedStore = open(path);
    const reopened = new InvestigationEvidenceStore(
      reopenedStore,
      { maximumCount: 1, retentionSeconds: 1 },
      () => new Date(startedAt + 2_000),
    );
    expect(reopened.cleanup()).toMatchObject({ expired: 1, releasedBytes: 1 });
    upload(reopened, task, "b");
    expect(reopenedStore.get("evidenceUsage", "global")).toMatchObject({ count: 1, bytes: 1 });
    expect(reopened.current("a").artifact.availability).toBe("expired");
    expect(() => reopened.content("a")).toThrow(
      expect.objectContaining({ statusCode: 410, code: "artifact_expired" }),
    );
  });

  it("expires content after terminal retention and preserves sealed report and artifact identities", () => {
    const { evidence, store, task, advance } = harness();
    const entry = upload(evidence, task, "a");
    const report = { ...createInvestigationPreview("pr").result, artifacts: [entry] };
    store.insert("reports", report.report.id, report);
    store.put("tasks", task.id, { ...task, state: "running" });
    advance(10_000);
    expect(evidence.cleanup().expired).toBe(0);
    store.put("tasks", task.id, { ...task, updatedAt: new Date(startedAt + 10_000).toISOString() });
    expect(evidence.cleanup().expired).toBe(0);
    advance(1_000);
    expect(evidence.cleanup()).toMatchObject({ expired: 1, releasedBytes: 1 });
    expect(store.has("evidenceAssets", entry.id)).toBe(false);
    expect(evidence.artifact(entry.id)).toEqual(entry);
    expect(evidence.current(entry.id)).toMatchObject({
      artifact: { ...entry, availability: "expired" },
      retentionProtected: false,
    });
    expect(store.get("reports", report.report.id)).toEqual(report);
    expect(() => evidence.requireAvailable(entry)).toThrow(
      expect.objectContaining({ code: "artifact_not_registered" }),
    );
    expect(() => evidence.upload(entry, "YQ==", () => undefined)).toThrow();
    expect(store.get("evidenceUsage", "global")).toMatchObject({ count: 0, bytes: 0 });
  });

  it("protects active work and complete checkpoints that still need resumed delivery", () => {
    const { evidence, store, task, advance } = harness();
    const entry = upload(evidence, task, "retained");
    const orphan = upload(evidence, task, "orphan");
    store.put("tasks", task.id, { ...task, state: "queued" });
    advance(2_000);
    expect(evidence.cleanup().expired).toBe(0);
    store.put("tasks", task.id, { ...task, state: "interrupted" });
    store.transaction(() => {
      store.insert("checkpoints", task.id, {
        stopReason: "complete",
        runtime: { artifacts: [entry] },
      });
      evidence.retainCheckpoint([entry]);
    });
    expect(evidence.cleanup()).toMatchObject({ expired: 1, releasedBytes: orphan.byteLength });
    expect(evidence.current(entry.id).retentionProtected).toBe(true);
    expect(evidence.content(entry.id).artifact).toEqual(entry);
  });

  it("pins parent content until its exact child completes without prefix collisions", () => {
    const { evidence, store, task, advance } = harness();
    const entry = upload(evidence, task, "patch");
    const child = { ...task, id: "child:one", parentTaskId: task.id, state: "queued" as const };
    store.transaction(() => {
      store.insert("tasks", child.id, child);
      evidence.pinParent(child);
    });
    advance(2_000);
    expect(evidence.cleanup().expired).toBe(0);
    store.put("tasks", child.id, { ...child, state: "cancelled" });
    expect(evidence.cleanup().expired).toBe(0);
    store.transaction(() => {
      store.put("tasks", child.id, { ...child, state: "completed" });
      evidence.releaseParent(child);
    });
    evidence.pinParent({ ...child, id: "foreign-child", parentTaskId: `${task.id}:suffix` });
    expect(evidence.cleanup().expired).toBe(1);
    expect(evidence.current(entry.id).artifact.availability).toBe("expired");
  });

  it("requires only relevant patches and preserves the exact parent read boundary", () => {
    const { evidence, task, advance } = harness();
    const bytes = Buffer.from("Synthetic patch");
    const patch = {
      ...artifact(task, "patch", bytes),
      kind: "patch" as const,
      subjectRef: "patched-subject",
    };
    evidence.upload(patch, bytes.toString("base64"), () => undefined);
    const subject = {
      id: patch.subjectRef,
      kind: "local_patch" as const,
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      revisionKey: "e".repeat(64),
      baseSubjectRef: task.subjectRef,
      baseSha: "a".repeat(40),
      patchDigest: patch.digest,
      artifactRef: patch.id,
    };
    const child = {
      ...task,
      id: "child",
      parentTaskId: task.id,
      subjectRef: subject.id,
      subjects: [...task.subjects, subject],
      executionPolicy: { ...task.executionPolicy, allowedSubjectRefs: [subject.id] },
    };
    const parent = { ...createInvestigationPreview("pr").result, artifacts: [patch] };
    expect(() => evidence.requireTaskSources(child, parent)).not.toThrow();
    expect(() =>
      evidence.requireTaskSources(child, {
        ...parent,
        artifacts: [],
        context: { ...parent.context, sourceArtifacts: [patch] },
      }),
    ).not.toThrow();
    expect(() => evidence.requireTaskSources(child, { ...parent, artifacts: [] })).toThrow(
      expect.objectContaining({ code: "plan_patch_unavailable" }),
    );
    advance(2_000);
    expect(evidence.cleanup().expired).toBe(1);
    expect(() => evidence.requireTaskSources(child, parent)).toThrow(
      expect.objectContaining({ code: "artifact_not_registered" }),
    );
    expect(() =>
      evidence.requireTaskSources(
        {
          ...child,
          subjectRef: task.subjectRef,
          executionPolicy: task.executionPolicy,
        },
        parent,
      ),
    ).not.toThrow();
  });

  it("retains required ancestor patches across completed intermediate tasks", () => {
    const { evidence, store, task, advance } = harness();
    const bytes = Buffer.from("Synthetic ancestor patch");
    const patch = {
      ...artifact(task, "ancestor-patch", bytes),
      kind: "patch" as const,
      subjectRef: "patched-subject",
    };
    evidence.upload(patch, bytes.toString("base64"), () => undefined);
    const subject = {
      id: patch.subjectRef,
      kind: "local_patch" as const,
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      revisionKey: "e".repeat(64),
      baseSubjectRef: task.subjectRef,
      baseSha: "a".repeat(40),
      patchDigest: patch.digest,
      artifactRef: patch.id,
    };
    const child = {
      ...task,
      id: "grandchild",
      parentTaskId: "completed-intermediate",
      subjectRef: subject.id,
      subjects: [...task.subjects, subject],
      sourceArtifacts: [patch],
      executionPolicy: { ...task.executionPolicy, allowedSubjectRefs: [subject.id] },
    };
    store.transaction(() => evidence.pinParent(child));
    advance(2_000);
    expect(evidence.cleanup().expired).toBe(0);
    store.transaction(() => evidence.releaseParent(child));
    expect(evidence.cleanup().expired).toBe(1);
  });

  it("rolls back evidence protection when checkpoint acceptance fails", () => {
    const { evidence, store, task, advance } = harness();
    const entry = upload(evidence, task, "a");
    store.put("tasks", task.id, { ...task, state: "interrupted" });
    expect(() =>
      store.transaction(() => {
        evidence.retainCheckpoint([entry]);
        throw new Error("Synthetic checkpoint rejection");
      }),
    ).toThrow("Synthetic checkpoint rejection");
    advance(2_000);
    expect(evidence.cleanup().expired).toBe(1);
  });

  it("bounds scans, persists continuation, and never loads base64 during retention or metadata reads", () => {
    const { evidence, store, task, advance } = harness({ cleanupBatchSize: 1 });
    for (const id of ["a", "b", "c"]) upload(evidence, task, id);
    advance(2_000);
    const getter = vi.spyOn(store, "get");
    const list = vi.spyOn(store, "list");
    expect(evidence.cleanup()).toMatchObject({ scanned: 1, expired: 1 });
    expect(store.get("evidenceUsage", "global")).toMatchObject({ cleanupCursor: "a" });
    const restarted = new InvestigationEvidenceStore(
      store,
      { cleanupBatchSize: 1, retentionSeconds: 1 },
      () => new Date(startedAt + 2_000),
    );
    expect(restarted.cleanup()).toMatchObject({ scanned: 1, expired: 1 });
    expect(restarted.current("c").artifact.availability).toBe("available");
    expect(restarted.cleanup()).toMatchObject({ scanned: 1, expired: 1 });
    expect(restarted.cleanup()).toMatchObject({ scanned: 0, expired: 0 });
    expect(getter.mock.calls.some(([collection]) => collection === "evidenceAssets")).toBe(false);
    expect(getter.mock.calls.some(([collection]) => collection === "checkpoints")).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed on missing content or inconsistent accounting", () => {
    const { evidence, store, task, advance } = harness();
    const entry = upload(evidence, task, "a");
    store.delete("evidenceAssets", entry.id);
    expect(evidence.current(entry.id).artifact.availability).toBe("missing");
    expect(() => evidence.content(entry.id)).toThrow(
      expect.objectContaining({ code: "artifact_missing" }),
    );
    store.put("evidenceUsage", "global", { count: 0, bytes: 0, cleanupCursor: "" });
    advance(2_000);
    expect(() => evidence.cleanup()).toThrow(
      expect.objectContaining({ code: "evidence_usage_mismatch" }),
    );
    expect(store.get("evidenceMetadata", entry.id)).toMatchObject({ expiredAt: null });
  });

  it("starts bounded cleanup with the app and clears its timer before closing storage", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cleanup = vi.spyOn(InvestigationEvidenceStore.prototype, "cleanup");
    const store = open();
    const app = buildInvestigationApp({ store, evidencePolicy: { cleanupIntervalSeconds: 1 } });
    try {
      await app.ready();
      expect(cleanup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(cleanup).toHaveBeenCalledTimes(3);
      await app.close();
      store.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(cleanup).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});
