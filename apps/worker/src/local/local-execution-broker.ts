import type { PreparedLocalExecutionStart } from "./executor-envelope.js";
import type { LocalExecutionRun } from "./local-execution-run.js";

/** Runtime cancellation facade that never exposes the source signal, Event, or abort reason. */
export interface LocalExecutionCancellation {
  readonly aborted: boolean;
  subscribe(listener: () => void): () => void;
}

export function createLocalExecutionCancellation(signal: AbortSignal): LocalExecutionCancellation {
  return Object.freeze({
    get aborted(): boolean {
      return signal.aborted;
    },
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("Cancellation listener must be a function.");
      }
      let subscribed = true;
      const unsubscribe = (): void => {
        if (!subscribed) return;
        subscribed = false;
        signal.removeEventListener("abort", notify);
      };
      const notify = (): void => {
        if (!subscribed) return;
        unsubscribe();
        listener();
      };
      if (signal.aborted) {
        notify();
      } else {
        signal.addEventListener("abort", notify, { once: true });
      }
      return unsubscribe;
    },
  });
}

/**
 * Control-facing local execution boundary.
 *
 * The opaque prepared start is created only by prepareLocalExecutionStart, so broker wrappers and
 * transports never receive a Server envelope or lease token. This contract deliberately does not
 * prescribe a Named Pipe or any other transport.
 */
export interface LocalExecutionBroker {
  /**
   * Starts one prepared attempt. Aborting before this resolves must cancel any transmitted start,
   * wait for zero active processes, and reject without affecting another slot. The runtime facade
   * exposes neither the caller-controlled reason nor its source Event.
   */
  start(
    prepared: PreparedLocalExecutionStart,
    cancellation: LocalExecutionCancellation,
  ): Promise<LocalExecutionRun>;

  /** Stops accepting starts, closes active runs, and releases broker-wide resources. */
  close(): Promise<void>;
}
