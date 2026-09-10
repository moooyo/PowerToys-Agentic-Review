import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkerCleanup, type WorkerCleanupObservations } from "./cleanup-verification.js";

function completed(taskCount: number) {
  const workspaces = Array.from({ length: taskCount * 2 }, (_, index) => ({
    attemptId: `attempt-${Math.floor(index / 2)}`,
    completedAt: "2026-09-10T00:02:00.000Z",
  }));
  const processes = Array.from({ length: taskCount + 2 }, (_, index) => ({
    cli: index < taskCount,
    exitCode: 0,
    signal: null,
  }));
  return {
    workspaceEntries: [] as string[],
    activeReservations: 0,
    activeMonitors: 0,
    abandonedReservations: 0,
    admittedReservations: taskCount * 2,
    releasedReservations: taskCount * 2,
    preparedWorkspaces: [...workspaces],
    cleanups: [...workspaces],
    activeProcessRequests: 0,
    completedProcessTrees: processes.length,
    processes,
    sourceObservations: [{ state: "clean" }],
    hostClosed: { code: 0 },
    terminalAcknowledgements: Array.from({ length: taskCount }, (_, index) => ({
      attemptId: `attempt-${index}`,
      operation: "complete",
      at: "2026-09-10T00:01:00.000Z",
    })),
  } satisfies WorkerCleanupObservations;
}

test("default three-task and quality nine-task cleanups derive their own expected counts", () => {
  assert.doesNotThrow(() => assertWorkerCleanup(completed(3), 3));
  assert.doesNotThrow(() => assertWorkerCleanup(completed(9), 9));
  assert.throws(() => assertWorkerCleanup(completed(9), 3));
  assert.throws(() => assertWorkerCleanup(completed(3), 9));
});

for (const field of ["admittedReservations", "releasedReservations"] as const) {
  test(`rejects an incorrect ${field} count`, () => {
    const observations = completed(9);
    observations[field] -= 1;
    assert.throws(() => assertWorkerCleanup(observations, 9));
  });
}
for (const field of ["preparedWorkspaces", "cleanups"] as const) {
  test(`rejects an incomplete ${field} collection`, () => {
    const observations = completed(9);
    observations[field].pop();
    assert.throws(() => assertWorkerCleanup(observations, 9));
  });
}
test("rejects incorrect CLI accounting even when all recorded processes exited successfully", () => {
  const observations = completed(9);
  const process = observations.processes[0];
  assert.ok(process);
  process.cli = false;
  assert.throws(() => assertWorkerCleanup(observations, 9));
});
test("retains the active-resource and failed-process postconditions", () => {
  for (const field of [
    "activeReservations",
    "activeMonitors",
    "abandonedReservations",
    "activeProcessRequests",
  ] as const) {
    const observations = completed(9);
    observations[field] = 1;
    assert.throws(() => assertWorkerCleanup(observations, 9));
  }
  assert.throws(() =>
    assertWorkerCleanup({ ...completed(9), workspaceEntries: ["retained-checkout"] }, 9),
  );
  assert.throws(() => assertWorkerCleanup({ ...completed(9), completedProcessTrees: 0 }, 9));
  assert.throws(() => assertWorkerCleanup({ ...completed(9), hostClosed: { code: 1 } }, 9));
  assert.throws(() =>
    assertWorkerCleanup({ ...completed(9), sourceObservations: [{ state: "modified" }] }, 9),
  );
  const observations = completed(9);
  const process = observations.processes[0];
  assert.ok(process);
  process.exitCode = 1;
  assert.throws(() => assertWorkerCleanup(observations, 9));
});
test("requires every cleanup to follow its real terminal acknowledgement", () => {
  const observations = completed(9);
  const acknowledgement = observations.terminalAcknowledgements[0];
  assert.ok(acknowledgement);
  acknowledgement.at = "2026-09-10T00:03:00.000Z";
  assert.throws(() => assertWorkerCleanup(observations, 9));
});
