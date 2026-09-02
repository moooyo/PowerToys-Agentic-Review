import { ServerLifecycleCore, type ServerLifecycleCoreEffects } from "./server-lifecycle-core.js";

interface TestingDeadline {
  readonly callback: () => void;
  cancelled: boolean;
}

export interface ServerLifecycleTestingHarness {
  readonly lifecycle: ServerLifecycleCore;
  readonly hardExitCodes: readonly number[];
  readonly queuedTeardownCount: number;
  readonly armedDeadlineCount: number;
  runQueuedTeardown(): void;
  fireHardDeadline(): void;
}

/** Test-only deterministic effects. This file is excluded from the production TypeScript build. */
export const createServerLifecycleTestingHarness = (
  shutdownTimeoutMilliseconds = 5_000,
): ServerLifecycleTestingHarness => {
  const teardownQueue: Array<() => void> = [];
  const deadlines: TestingDeadline[] = [];
  const hardExitCodes: number[] = [];
  const effects: ServerLifecycleCoreEffects = {
    armHardDeadline: (_delayMilliseconds, callback) => {
      const deadline = { callback, cancelled: false };
      deadlines.push(deadline);
      return () => {
        deadline.cancelled = true;
      };
    },
    queueTeardown: (callback) => {
      teardownQueue.push(callback);
    },
    hardExit: ((exitCode: number) => {
      hardExitCodes.push(exitCode);
      return undefined as never;
    }) as (exitCode: number) => never,
  };
  const lifecycle = new ServerLifecycleCore({
    shutdownTimeoutMilliseconds,
    hardExitCode: 1,
    effects,
  });
  return {
    lifecycle,
    hardExitCodes,
    get queuedTeardownCount() {
      return teardownQueue.length;
    },
    get armedDeadlineCount() {
      return deadlines.length;
    },
    runQueuedTeardown: () => {
      const callback = teardownQueue.shift();
      if (callback === undefined) throw new Error("No lifecycle teardown is queued.");
      callback();
    },
    fireHardDeadline: () => {
      const deadline = deadlines.find((candidate) => !candidate.cancelled);
      if (deadline === undefined) throw new Error("No lifecycle hard deadline is armed.");
      deadline.callback();
    },
  };
};
