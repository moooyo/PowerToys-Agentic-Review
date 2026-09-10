import assert from "node:assert/strict";

export interface WorkerCleanupObservations {
  readonly workspaceEntries: readonly string[];
  readonly activeReservations: number;
  readonly activeMonitors: number;
  readonly abandonedReservations: number;
  readonly admittedReservations: number;
  readonly releasedReservations: number;
  readonly preparedWorkspaces: readonly unknown[];
  readonly cleanups: readonly { readonly attemptId: string; readonly completedAt: string }[];
  readonly activeProcessRequests: number;
  readonly completedProcessTrees: number;
  readonly processes: readonly {
    readonly cli: boolean;
    readonly failure?: unknown;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
  }[];
  readonly sourceObservations: readonly { readonly state: string }[];
  readonly hostClosed: unknown;
  readonly terminalAcknowledgements: readonly {
    readonly attemptId: string;
    readonly operation: string;
    readonly at: string;
  }[];
}

/** Checks recorded cleanup facts without starting a process or changing a receipt. */
export function assertWorkerCleanup(
  observations: WorkerCleanupObservations,
  expectedTaskCount: number,
): void {
  assert.ok(Number.isSafeInteger(expectedTaskCount) && expectedTaskCount > 0);
  const expectedWorkspaceCount = expectedTaskCount * 2;
  assert.equal(observations.workspaceEntries.length, 0);
  assert.equal(observations.activeReservations, 0);
  assert.equal(observations.activeMonitors, 0);
  assert.equal(observations.abandonedReservations, 0);
  assert.equal(observations.admittedReservations, expectedWorkspaceCount);
  assert.equal(observations.releasedReservations, expectedWorkspaceCount);
  assert.equal(observations.preparedWorkspaces.length, expectedWorkspaceCount);
  assert.equal(observations.cleanups.length, expectedWorkspaceCount);
  assert.equal(observations.activeProcessRequests, 0);
  assert.equal(observations.completedProcessTrees, observations.processes.length);
  assert.equal(observations.processes.filter((entry) => entry.cli).length, expectedTaskCount);
  assert.ok(
    observations.processes.every(
      (entry) => entry.failure === undefined && entry.exitCode === 0 && entry.signal === null,
    ),
  );
  assert.ok(observations.sourceObservations.every((entry) => entry.state === "clean"));
  const hostClosed = observations.hostClosed;
  assert.ok(
    hostClosed !== null &&
      typeof hostClosed === "object" &&
      "code" in hostClosed &&
      hostClosed.code === 0,
  );
  for (const cleanup of observations.cleanups) {
    const terminal = observations.terminalAcknowledgements.find(
      (entry) => entry.attemptId === cleanup.attemptId && entry.operation === "complete",
    );
    assert.ok(terminal && Date.parse(terminal.at) <= Date.parse(cleanup.completedAt));
  }
}
