import { randomUUID } from "node:crypto";
import type { InvestigationWorkerLease } from "@agentic-review/contracts";
import type { InvestigationOutputJournal } from "./output-journal.js";

/** Optional output admission must never hold execution or cancellation indefinitely. */
export async function openInvestigationOutputAttempt(options: {
  readonly journal: InvestigationOutputJournal;
  readonly taskId: string;
  readonly lease: InvestigationWorkerLease;
  readonly signal: AbortSignal;
  readonly initializationTimeoutMs?: number;
}): Promise<boolean> {
  options.signal.throwIfAborted();
  const timeoutMs = options.initializationTimeoutMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new RangeError("initializationTimeoutMs must be from 1 through 30000.");
  const initialization = new AbortController();
  const signal = AbortSignal.any([options.signal, initialization.signal]);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let opened = false;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(options.signal.reason);
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    const opening = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return options.journal.openAttempt(options.taskId, options.lease, signal);
      })
      .then(
        () => true,
        () => false,
      );
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        initialization.abort(new Error("Visible output initialization exceeded its time limit."));
        resolve(false);
      }, timeoutMs);
    });
    opened = await Promise.race([opening, timedOut, aborted]);
    // Cancellation wins even if an opening promise resolved in the same microtask turn.
    options.signal.throwIfAborted();
    return opened;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort);
    if (!opened || options.signal.aborted)
      initialization.abort(new Error("Visible output initialization is no longer active."));
    // The journal owns late-created entries. Closing here would close other invocation producers.
  }
}

/** Lifecycle observations describe completed Worker transitions, independently of model text. */
export function createInvestigationOutputReporter(options: {
  readonly journal: InvestigationOutputJournal;
  readonly taskId: string;
  readonly lease: InvestigationWorkerLease;
  readonly initializationTimeoutMs?: number;
  readonly onFailure?: () => void;
}) {
  const initializationLifetime = new AbortController();
  let active = false;
  let closed = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const failed = () => {
    try {
      void Promise.resolve(options.onFailure?.()).catch(() => undefined);
    } catch {
      /* Output cannot change execution. */
    }
  };
  const system = (text: string): void => {
    if (!active || closed) return;
    try {
      options.journal.append(options.taskId, options.lease.attemptId, null, {
        itemId: `lifecycle-${randomUUID()}`,
        kind: "system",
        operation: "append",
        text,
        status: "info",
      });
    } catch {
      failed();
    }
  };
  return {
    start(signal: AbortSignal = new AbortController().signal): Promise<void> {
      if (closed) return Promise.resolve();
      startPromise ??= (async () => {
        try {
          const opened = await openInvestigationOutputAttempt({
            journal: options.journal,
            taskId: options.taskId,
            lease: options.lease,
            signal: AbortSignal.any([signal, initializationLifetime.signal]),
            ...(options.initializationTimeoutMs === undefined
              ? {}
              : { initializationTimeoutMs: options.initializationTimeoutMs }),
          });
          signal.throwIfAborted();
          if (closed) return;
          if (!opened) {
            failed();
            return;
          }
          active = true;
          system("The Worker started this claimed attempt.");
        } catch {
          if (signal.aborted) throw signal.reason;
          if (!closed) failed();
        }
      })();
      return startPromise;
    },
    system,
    close(): Promise<void> {
      closePromise ??= (async () => {
        system(
          "The Worker attempt executor ended. Task cancellation and resource cleanup are recorded separately.",
        );
        const flush = active;
        active = false;
        closed = true;
        initializationLifetime.abort(new Error("The visible output reporter has closed."));
        try {
          // This reporter owns the task lifetime, including an attempt opened by a model runner.
          options.journal.closeAttempt(options.taskId, options.lease.attemptId);
          if (flush) await options.journal.flush(1_000);
        } catch {
          failed();
        }
      })();
      return closePromise;
    },
  };
}
