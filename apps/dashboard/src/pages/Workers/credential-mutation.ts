import { ReviewControlError } from "../../services/review-control/errors";

const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;

export interface SynchronousGate {
  active: boolean;
}

export const tryAcquireGate = (gate: SynchronousGate): (() => void) | undefined => {
  if (gate.active) {
    return undefined;
  }
  gate.active = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      gate.active = false;
    }
  };
};

export const runSingleFlight = async <T>(
  gate: SynchronousGate,
  task: () => Promise<T>,
): Promise<T | undefined> => {
  const release = tryAcquireGate(gate);
  if (release === undefined) {
    return undefined;
  }
  try {
    return await task();
  } finally {
    release();
  }
};

export const workerMutationErrorText = (error: unknown, fallback: string): string =>
  error instanceof ReviewControlError ? error.message : fallback;

export const isSafeWorkerDisplayName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 128 &&
  !value.includes("\0") &&
  !workerTokenExposurePattern.test(value);
