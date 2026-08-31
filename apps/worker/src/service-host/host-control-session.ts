import type { ServiceHostPayloadRole } from "./launch-contract.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";

/** The role-bound lifecycle surface shared by both HostControl pipe endpoints. */
export interface HostControlSession<TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly done: Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
