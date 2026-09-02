import type { ArmArwxShutdownResultV1 } from "./arwx-shutdown.js";
import type { ArwxFinalFrameReceipt } from "./arwx-stdio-channel.js";
import type { ParsedHostControlShutdownRequested } from "./host-control-protocol.js";
import type { ServiceHostPayloadRole } from "./launch-contract.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";

export type HostControlShutdownRequest<
  TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole,
> = Omit<ParsedHostControlShutdownRequested, "role"> &
  Readonly<{ role: TRole; absoluteDeadline: number }>;

/** The role-bound lifecycle surface shared by both HostControl pipe endpoints. */
export interface HostControlSession<TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly done: Promise<void>;
  readonly shutdownRequested: Promise<Readonly<HostControlShutdownRequest<TRole>>>;
  armArwxShutdown(receipt: ArwxFinalFrameReceipt): Promise<Readonly<ArmArwxShutdownResultV1>>;
  drain(absoluteDeadline?: number): Promise<void>;
  close(absoluteDeadline?: number): Promise<void>;
}
