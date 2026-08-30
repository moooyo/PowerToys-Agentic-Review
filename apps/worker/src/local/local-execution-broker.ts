import type { PreparedLocalExecutionStart } from "./executor-envelope.js";
import type { LocalExecutionRun } from "./local-execution-run.js";

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
   * wait for zero active processes, and reject without affecting another slot.
   */
  start(prepared: PreparedLocalExecutionStart, signal: AbortSignal): Promise<LocalExecutionRun>;

  /** Stops accepting starts, closes active runs, and releases broker-wide resources. */
  close(): Promise<void>;
}
