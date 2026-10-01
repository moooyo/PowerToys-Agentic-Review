import { createHash } from "node:crypto";
import type {
  ActionContextV1,
  InvestigationCreateTaskRequestV1,
  InvestigationInputSnapshotV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InvestigationImportedTaskSource,
  type InvestigationPreparedTaskInput,
  InvestigationService,
} from "../../dist/investigation/service.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "../../dist/investigation/types.js";

const stores: InvestigationStore[] = [];
const timestamp = "2026-09-16T08:00:00.000Z";
const repository: InvestigationRepositoryRecord = {
  id: "synthetic-repository",
  fullName: "synthetic/imported-task-fixture",
  githubRepositoryId: 123,
};
const actor: InvestigationOperatorPrincipal = {
  id: "synthetic-operator",
  displayName: "Synthetic Operator",
  repositoryIds: [repository.id],
  permissions: ["task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function gate() {
  let release: () => void = () => {
    throw new Error("The synthetic gate has not been initialized.");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function saveSnapshot(store: InvestigationStore, inputSnapshot: InvestigationInputSnapshotV1) {
  const digest = investigationContentDigest(inputSnapshot);
  const snapshot = { id: `snapshot:${digest}`, digest, inputSnapshot };
  store.put("sourceSnapshots", snapshot.id, snapshot);
  return { id: snapshot.id, digest };
}

function pointerId(item: InvestigationWorkItemRecord) {
  return `current:${investigationContentDigest({
    repositoryId: item.repositoryId,
    workItemId: item.id,
    revisionKey: item.subject.revisionKey,
  })}`;
}

/** The source, persisted records, and transport are isolated synthetic fixtures. */
function harness(kind: InvestigationWorkItemRecord["kind"] = "pull_request") {
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", repository.id, repository);
  const id = "synthetic-work-item";
  const title = "Original imported title";
  const body = "Complete original imported body.";
  const comments = [
    { id: "issue-comment:1", body: "Complete conversation context." },
    { id: "review-comment:2", body: "Complete inline review context." },
  ];
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const identity = {
    id: "synthetic-original-subject",
    repositoryId: repository.id,
    workItemId: id,
  };
  const workItem: InvestigationWorkItemRecord = {
    id,
    repositoryId: repository.id,
    kind,
    number: 7,
    title,
    body,
    state: "open",
    updatedAt: timestamp,
    subject:
      kind === "pull_request"
        ? {
            ...identity,
            kind: "original_pr",
            baseSha,
            headSha,
            revisionKey: createHash("sha256").update(`${baseSha}\0${headSha}`).digest("hex"),
          }
        : {
            ...identity,
            kind: "issue_snapshot",
            snapshotDigest: investigationContentDigest({ title, body, comments }),
            revisionKey: createHash("sha256")
              .update(JSON.stringify([title, body, "open", timestamp]))
              .digest("hex"),
          },
  };
  const inputSnapshot: InvestigationInputSnapshotV1 = {
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: repository.id,
    workItemId: workItem.id,
    subjectRef: workItem.subject.id,
    subjectRevisionKey: workItem.subject.revisionKey,
    title,
    body,
    comments,
    source: null,
  };
  const source = { workItem, snapshotRef: saveSnapshot(store, inputSnapshot) };
  store.insert("workItems", workItem.id, workItem);
  store.put("sourceSnapshots", pointerId(workItem), { snapshotId: source.snapshotRef.id });
  const target: ActionContextV1["target"] = {
    kind,
    state: "open",
    revisionKey: workItem.subject.revisionKey,
    headSha: kind === "pull_request" ? headSha : null,
  };
  const readTarget = vi.fn<InvestigationActionTransport["readTarget"]>(async () =>
    structuredClone(target),
  );
  const execute = vi.fn<InvestigationActionTransport["execute"]>(async () => {
    throw new Error("Imported task creation must not write upstream.");
  });
  const reconcile = vi.fn<InvestigationActionTransport["reconcile"]>(async () => {
    throw new Error("Imported task creation must not reconcile upstream writes.");
  });
  const prepareTaskInput = vi.fn(async (): Promise<InvestigationPreparedTaskInput> => {
    throw new Error("Imported task creation must use its exact snapshot reference.");
  });
  let sequence = 0;
  const service = new InvestigationService({
    store,
    now: () => new Date(timestamp),
    idFactory: () => `synthetic-task-${++sequence}`,
    actionTransport: { supportedActions: [], readTarget, execute, reconcile },
    prepareTaskInput,
  });
  service.prompts.catalog(actor, repository.id);
  const initialIdempotencyRecords = store.list("idempotency");
  const initialReportDirectoryMarker = store.get("idempotency", "workspace:report-directory:v1");
  const request: InvestigationCreateTaskRequestV1 = {
    workItemId: workItem.id,
    kind: kind === "pull_request" ? "pr-review" : "issue-investigate",
    idempotencyKey: "synthetic-webhook-delivery",
  };
  return {
    store,
    service,
    initialIdempotencyRecords,
    initialReportDirectoryMarker,
    request,
    source,
    inputSnapshot,
    target,
    readTarget,
    execute,
    reconcile,
    prepareTaskInput,
  };
}

type Harness = ReturnType<typeof harness>;

function expectNoTaskWrites(fixture: Harness) {
  expect(fixture.store.list("tasks")).toEqual([]);
  expectIdempotencyRecords(fixture);
  expect(fixture.execute).not.toHaveBeenCalled();
  expect(fixture.reconcile).not.toHaveBeenCalled();
}

function expectIdempotencyRecords(fixture: Harness, taskRecords: unknown[] = []) {
  const sorted = (records: unknown[]) =>
    records.toSorted((left, right) =>
      investigationContentDigest(left).localeCompare(investigationContentDigest(right)),
    );
  expect(sorted(fixture.store.list("idempotency"))).toEqual(
    sorted([...fixture.initialIdempotencyRecords, ...taskRecords]),
  );
  expect(fixture.store.get("idempotency", "workspace:report-directory:v1")).toEqual(
    fixture.initialReportDirectoryMarker,
  );
}

function expectCreatedTaskWrites(fixture: Harness, task: InvestigationTaskV1) {
  expect(fixture.store.list("tasks")).toEqual([task]);
  const input = { inputSnapshot: fixture.inputSnapshot, plan: null, execution: null };
  const receipt = { digest: investigationContentDigest(fixture.request), entityId: task.id };
  expect(fixture.store.get("idempotency", `input:${task.id}`)).toEqual(input);
  expect(
    fixture.store.get("idempotency", `task:${actor.id}:${fixture.request.idempotencyKey}`),
  ).toEqual(receipt);
  expectIdempotencyRecords(fixture, [input, receipt]);
}

function replaceSnapshot(fixture: Harness, inputSnapshot: InvestigationInputSnapshotV1) {
  fixture.source.snapshotRef = saveSnapshot(fixture.store, inputSnapshot);
}

function deferTarget(fixture: Harness) {
  const entered = gate();
  const resumed = gate();
  fixture.readTarget.mockImplementationOnce(async () => {
    entered.release();
    await resumed.promise;
    return structuredClone(fixture.target);
  });
  return { entered, resumed };
}

describe("frozen imported task creation", () => {
  it("preserves initialized metadata when an imported task transaction makes no writes", () => {
    const fixture = harness();
    expect(fixture.store.get("idempotency", "workspace:report-directory:v1")).toEqual({
      complete: true,
    });
    fixture.store.transaction(() => undefined);
    expectNoTaskWrites(fixture);
  });

  it.each([
    [
      "an unexpected task",
      (fixture: Harness) => {
        fixture.store.insert("tasks", "synthetic-unexpected-task", {
          id: "synthetic-unexpected-task",
        });
      },
    ],
    [
      "an extra metadata record with the same value",
      (fixture: Harness) => {
        fixture.store.insert("idempotency", "synthetic-unexpected-metadata", { complete: true });
      },
    ],
    [
      "a changed initialization record",
      (fixture: Harness) => {
        fixture.store.put("idempotency", "workspace:report-directory:v1", { complete: false });
      },
    ],
    [
      "a removed initialization record",
      (fixture: Harness) => {
        fixture.store.delete("idempotency", "workspace:report-directory:v1");
      },
    ],
    [
      "an initialization record moved to another key with the same value",
      (fixture: Harness) => {
        fixture.store.delete("idempotency", "workspace:report-directory:v1");
        fixture.store.insert("idempotency", "synthetic-replaced-metadata", { complete: true });
      },
    ],
  ] as const)("detects %s when checking that no task writes occurred", (_description, mutate) => {
    const fixture = harness();
    mutate(fixture);
    expect(() => expectNoTaskWrites(fixture)).toThrow();
  });

  it("commits its creation callback with the task and does not replay it for an existing task", async () => {
    const fixture = harness();
    const onPersisted = vi.fn((task: InvestigationTaskV1) => {
      expect(fixture.store.get("tasks", task.id)).toEqual(task);
      expect(fixture.store.has("idempotency", `input:${task.id}`)).toBe(true);
      fixture.store.insert("idempotency", "synthetic-progress-created", { taskId: task.id });
    });
    const task = await fixture.service.createImportedTask(
      actor,
      fixture.request,
      fixture.source,
      undefined,
      onPersisted,
    );
    expect(fixture.store.get("idempotency", "synthetic-progress-created")).toEqual({
      taskId: task.id,
    });
    expect(
      await fixture.service.createImportedTask(
        actor,
        fixture.request,
        fixture.source,
        undefined,
        onPersisted,
      ),
    ).toEqual(task);
    expect(onPersisted).toHaveBeenCalledExactlyOnceWith(task);
  });

  it("rolls back the imported task and all callback writes when creation notification fails", async () => {
    const fixture = harness();
    await expect(
      fixture.service.createImportedTask(
        actor,
        fixture.request,
        fixture.source,
        undefined,
        (task) => {
          fixture.store.insert("idempotency", "synthetic-progress-created", { taskId: task.id });
          throw new Error("Synthetic acknowledgement persistence failed.");
        },
      ),
    ).rejects.toThrow("Synthetic acknowledgement persistence failed.");
    expectNoTaskWrites(fixture);
  });

  it.each(["pull_request", "issue"] as const)(
    "persists the complete imported %s input without consulting the moving source pointer",
    async (kind) => {
      const fixture = harness(kind);
      fixture.store.delete("sourceSnapshots", pointerId(fixture.source.workItem));
      const task = await fixture.service.createImportedTask(actor, fixture.request, fixture.source);
      expect(task.kind).toBe(fixture.request.kind);
      expect(task.state).toBe("queued");
      expect(task.subjects).toEqual([fixture.source.workItem.subject]);
      expect(task.executionPolicy).toMatchObject({
        mode: kind === "pull_request" ? "source_read" : "snapshot_only",
        allowRepositoryExecution: false,
        authorizationRef: null,
      });
      expect(fixture.store.get("idempotency", `input:${task.id}`)).toEqual({
        inputSnapshot: fixture.inputSnapshot,
        plan: null,
        execution: null,
      });
      expect(fixture.prepareTaskInput).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.reconcile).not.toHaveBeenCalled();
    },
  );

  it("retains the original PR title and comments when the same-SHA snapshot pointer advances during a read", async () => {
    const fixture = harness();
    const originalSource = structuredClone(fixture.source);
    const originalRequest = structuredClone(fixture.request);
    const { entered, resumed } = deferTarget(fixture);
    const pending = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    await entered.promise;
    const latestInput = {
      ...fixture.inputSnapshot,
      title: "Later upstream title",
      body: "Later upstream body",
      comments: [{ id: "issue-comment:3", body: "New discussion after the imported event." }],
    };
    const latestRef = saveSnapshot(fixture.store, latestInput);
    fixture.store.put("sourceSnapshots", pointerId(originalSource.workItem), {
      snapshotId: latestRef.id,
    });
    fixture.store.put("workItems", originalSource.workItem.id, {
      ...originalSource.workItem,
      title: latestInput.title,
      body: latestInput.body,
      updatedAt: "2026-09-16T08:01:00.000Z",
    });
    (fixture.source.workItem as { title: string }).title = "Caller-mutated title";
    fixture.source.workItem.subject.revisionKey = "f".repeat(64);
    fixture.source.snapshotRef.id = latestRef.id;
    fixture.source.snapshotRef.digest = latestRef.digest;
    fixture.request.idempotencyKey = "caller-mutated-key";
    fixture.request.kind = "issue-fix";
    resumed.release();
    const task = await pending;
    expect(task.workItem.title).toBe(originalSource.workItem.title);
    expect(task.subjects).toEqual([originalSource.workItem.subject]);
    expect(fixture.store.get("idempotency", `input:${task.id}`)).toEqual({
      inputSnapshot: fixture.inputSnapshot,
      plan: null,
      execution: null,
    });
    expect(
      fixture.store.get("idempotency", `task:${actor.id}:${originalRequest.idempotencyKey}`),
    ).toMatchObject({ entityId: task.id });
    expect(fixture.store.get("idempotency", `task:${actor.id}:caller-mutated-key`)).toBeUndefined();
    expect(fixture.prepareTaskInput).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing record",
      (fixture: Harness) => {
        fixture.store.delete("sourceSnapshots", fixture.source.snapshotRef.id);
      },
    ],
    [
      "tampered content",
      (fixture: Harness) => {
        fixture.store.put("sourceSnapshots", fixture.source.snapshotRef.id, {
          ...fixture.source.snapshotRef,
          inputSnapshot: { ...fixture.inputSnapshot, comments: [] },
        });
      },
    ],
    [
      "wrong reference digest",
      (fixture: Harness) => {
        fixture.source.snapshotRef.digest = "e".repeat(64);
      },
    ],
    [
      "noncanonical record ID",
      (fixture: Harness) => {
        fixture.source.snapshotRef.id = "synthetic-snapshot-alias";
        fixture.store.put("sourceSnapshots", fixture.source.snapshotRef.id, {
          ...fixture.source.snapshotRef,
          inputSnapshot: fixture.inputSnapshot,
        });
      },
    ],
    [
      "foreign repository",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, repositoryId: "foreign-repository" });
      },
    ],
    [
      "foreign work item",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, workItemId: "foreign-work-item" });
      },
    ],
    [
      "foreign subject",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, subjectRef: "foreign-subject" });
      },
    ],
    [
      "changed revision",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, subjectRevisionKey: "e".repeat(64) });
      },
    ],
    [
      "changed title",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, title: "Other snapshot title" });
      },
    ],
    [
      "changed body",
      (fixture: Harness) => {
        replaceSnapshot(fixture, { ...fixture.inputSnapshot, body: "Other snapshot body" });
      },
    ],
    [
      "unexpected source artifact",
      (fixture: Harness) => {
        replaceSnapshot(fixture, {
          ...fixture.inputSnapshot,
          source: {
            artifactRef: "unexpected-source",
            artifactDigest: "e".repeat(64),
            sourceSha: "a".repeat(40),
            files: [],
          },
        });
      },
    ],
    [
      "invalid snapshot schema",
      (fixture: Harness) => {
        const invalid = { ...fixture.inputSnapshot, comments: [{ id: "invalid-comment" }] };
        const digest = investigationContentDigest(invalid);
        fixture.source.snapshotRef = { id: `snapshot:${digest}`, digest };
        fixture.store.put("sourceSnapshots", fixture.source.snapshotRef.id, {
          ...fixture.source.snapshotRef,
          inputSnapshot: invalid,
        });
      },
    ],
  ] as const)("rejects a snapshot with %s before persisting anything", async (_name, mutate) => {
    const fixture = harness();
    mutate(fixture);
    await expect(
      fixture.service.createImportedTask(actor, fixture.request, fixture.source),
    ).rejects.toMatchObject({ statusCode: 409, code: "source_snapshot_missing" });
    expectNoTaskWrites(fixture);
    expect(fixture.readTarget).not.toHaveBeenCalled();
  });

  it.each(["pull_request", "issue"] as const)(
    "rejects a %s subject whose revision does not match the imported content",
    async (kind) => {
      const fixture = harness(kind);
      const subject = fixture.source.workItem.subject;
      fixture.source.workItem = {
        ...fixture.source.workItem,
        subject:
          subject.kind === "original_pr"
            ? { ...subject, revisionKey: "e".repeat(64) }
            : { ...subject, snapshotDigest: "e".repeat(64) },
      };
      fixture.store.put("workItems", fixture.source.workItem.id, fixture.source.workItem);
      replaceSnapshot(fixture, {
        ...fixture.inputSnapshot,
        subjectRevisionKey: fixture.source.workItem.subject.revisionKey,
      });
      await expect(
        fixture.service.createImportedTask(actor, fixture.request, fixture.source),
      ).rejects.toMatchObject({ statusCode: 409, code: "imported_subject_mismatch" });
      expectNoTaskWrites(fixture);
    },
  );

  it.each([
    [
      "revision",
      (item: InvestigationWorkItemRecord) => ({
        ...item,
        subject: { ...item.subject, revisionKey: "e".repeat(64) },
      }),
    ],
    [
      "base SHA",
      (item: InvestigationWorkItemRecord) => ({
        ...item,
        subject: { ...item.subject, baseSha: "c".repeat(40) },
      }),
    ],
    [
      "head SHA",
      (item: InvestigationWorkItemRecord) => ({
        ...item,
        subject: { ...item.subject, headSha: "c".repeat(40) },
      }),
    ],
    [
      "subject identity",
      (item: InvestigationWorkItemRecord) => ({
        ...item,
        subject: { ...item.subject, id: "other-subject" },
      }),
    ],
    ["number", (item: InvestigationWorkItemRecord) => ({ ...item, number: 8 })],
    [
      "repository",
      (item: InvestigationWorkItemRecord) => ({
        ...item,
        repositoryId: "foreign-repository",
      }),
    ],
    ["kind", (item: InvestigationWorkItemRecord) => ({ ...item, kind: "issue" })],
    ["state", (item: InvestigationWorkItemRecord) => ({ ...item, state: "closed" })],
  ] as const)(
    "rejects a work-item %s change during upstream verification",
    async (_name, mutate) => {
      const fixture = harness();
      const { entered, resumed } = deferTarget(fixture);
      const pending = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
      await entered.promise;
      fixture.store.put("workItems", fixture.source.workItem.id, mutate(fixture.source.workItem));
      resumed.release();
      await expect(pending).rejects.toMatchObject({ statusCode: 409, code: "stale_subject" });
      expectNoTaskWrites(fixture);
    },
  );

  it("rejects an upstream work-item alias inserted while its task is being prepared", async () => {
    const fixture = harness();
    const { entered, resumed } = deferTarget(fixture);
    const pending = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    await entered.promise;
    fixture.store.insert("workItems", "synthetic-alias", {
      ...fixture.source.workItem,
      id: "synthetic-alias",
      subject: { ...fixture.source.workItem.subject, workItemId: "synthetic-alias" },
    });
    resumed.release();
    await expect(pending).rejects.toMatchObject({
      statusCode: 409,
      code: "work_item_identity_conflict",
    });
    expectNoTaskWrites(fixture);
  });

  it.each([{ fullName: "synthetic/renamed-repository" }, { githubRepositoryId: 456 }])(
    "rejects a repository binding change during upstream verification: %j",
    async (change) => {
      const fixture = harness();
      const { entered, resumed } = deferTarget(fixture);
      const pending = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
      await entered.promise;
      fixture.store.put("repositories", repository.id, { ...repository, ...change });
      resumed.release();
      await expect(pending).rejects.toMatchObject({ statusCode: 409, code: "repository_changed" });
      expectNoTaskWrites(fixture);
    },
  );

  it.each([{ state: "closed" }, { revisionKey: "e".repeat(64) }] as const)(
    "rejects a stale upstream target: %j",
    async (change) => {
      const fixture = harness();
      fixture.readTarget.mockResolvedValueOnce({ ...fixture.target, ...change });
      await expect(
        fixture.service.createImportedTask(actor, fixture.request, fixture.source),
      ).rejects.toMatchObject({ statusCode: 409, code: "stale_subject" });
      expectNoTaskWrites(fixture);
    },
  );

  it("replays the original committed task after its source record disappears and the latest source changes", async () => {
    const fixture = harness();
    const task = await fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    const frozen = fixture.store.get("idempotency", `input:${task.id}`);
    fixture.store.delete("sourceSnapshots", fixture.source.snapshotRef.id);
    const latestItem = {
      ...fixture.source.workItem,
      title: "A later source revision",
      subject: { ...fixture.source.workItem.subject, revisionKey: "e".repeat(64) },
    };
    fixture.store.put("workItems", latestItem.id, latestItem);
    const replayed = await fixture.service.createImportedTask(
      actor,
      fixture.request,
      fixture.source,
    );
    expect(replayed).toEqual(task);
    expect(fixture.store.get("idempotency", `input:${task.id}`)).toEqual(frozen);
    expectCreatedTaskWrites(fixture, task);
    expect(fixture.readTarget).toHaveBeenCalledTimes(1);
  });

  it("commits one task and one frozen input for concurrent duplicate deliveries", async () => {
    const fixture = harness();
    const entered = gate();
    const resumed = gate();
    let readers = 0;
    fixture.readTarget.mockImplementation(async () => {
      if (++readers === 2) entered.release();
      await resumed.promise;
      return structuredClone(fixture.target);
    });
    const first = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    const second = fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    await entered.promise;
    resumed.release();
    const [firstTask, secondTask] = await Promise.all([first, second]);
    expect(secondTask).toEqual(firstTask);
    expectCreatedTaskWrites(fixture, firstTask);
    expect(fixture.store.get("idempotency", `input:${firstTask.id}`)).toEqual({
      inputSnapshot: fixture.inputSnapshot,
      plan: null,
      execution: null,
    });
  });

  it("rejects reuse of a committed idempotency key with a changed request", async () => {
    const fixture = harness();
    const task = await fixture.service.createImportedTask(actor, fixture.request, fixture.source);
    await expect(
      fixture.service.createImportedTask(
        actor,
        { ...fixture.request, executionMode: "source_read" },
        fixture.source,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    expectCreatedTaskWrites(fixture, task);
  });

  it.each([
    { executionMode: "execute" },
    { kind: "pr-verify" },
    { kind: "issue-fix" },
    { parentReportRef: { id: "parent", version: 1, digest: "e".repeat(64) } },
    { planRef: { id: "plan", version: 1, digest: "e".repeat(64) } },
    { idempotencyKey: "" },
    { unexpectedField: true },
  ])("rejects an invalid imported root request: %j", async (change) => {
    const fixture = harness();
    await expect(
      fixture.service.createImportedTask(
        actor,
        { ...fixture.request, ...change } as InvestigationCreateTaskRequestV1,
        fixture.source,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_imported_task_request" });
    expectNoTaskWrites(fixture);
    expect(fixture.readTarget).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}])(
    "rejects an absent or malformed imported source: %j",
    async (source) => {
      const fixture = harness();
      await expect(
        fixture.service.createImportedTask(
          actor,
          fixture.request,
          source as unknown as InvestigationImportedTaskSource,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: "imported_source_mismatch" });
      expectNoTaskWrites(fixture);
      expect(fixture.prepareTaskInput).not.toHaveBeenCalled();
    },
  );

  it("rejects an imported source from another repository", async () => {
    const fixture = harness();
    fixture.source.workItem = { ...fixture.source.workItem, repositoryId: "foreign-repository" };
    await expect(
      fixture.service.createImportedTask(actor, fixture.request, fixture.source),
    ).rejects.toMatchObject({ statusCode: 409, code: "imported_source_mismatch" });
    expectNoTaskWrites(fixture);
  });

  it.each([{ repositoryIds: [] }, { permissions: [] }])(
    "enforces operator authorization before creating an imported task: %j",
    async (change) => {
      const fixture = harness();
      await expect(
        fixture.service.createImportedTask(
          { ...actor, ...change },
          fixture.request,
          fixture.source,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expectNoTaskWrites(fixture);
      expect(fixture.readTarget).not.toHaveBeenCalled();
    },
  );
});
