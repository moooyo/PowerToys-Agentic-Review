import { Value } from "@sinclair/typebox/value";
import { ProcessHostRecoverySnapshotSchema } from "../execution/process-host-protocol.js";

/**
 * Both snapshots must originate from validated native handshakes and the previous
 * snapshot must have been journaled before any attempt-owned process was started.
 * A different generation for the same named Job proves that the previous Host and
 * its nested process trees drained before the current Host joined that Job.
 * PID absence, singleton-mutex acquisition, and legacy snapshots are not evidence.
 * This proves no desktop restoration and does not authorize replaying any work.
 */
export function hasRecoveredProcessHostOwnership(previous: unknown, current: unknown): boolean {
  if (
    !Value.Check(ProcessHostRecoverySnapshotSchema, previous) ||
    !Value.Check(ProcessHostRecoverySnapshotSchema, current)
  ) {
    return false;
  }
  return previous.instanceKey === current.instanceKey && previous.generation !== current.generation;
}
