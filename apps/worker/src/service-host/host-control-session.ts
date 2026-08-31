import type { ServiceHostPayloadRole } from "./launch-contract.js";

/** The role-bound lifecycle surface shared by both HostControl pipe endpoints. */
export interface HostControlSession<TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole> {
  readonly role: TRole;
  drain(): Promise<void>;
  close(): Promise<void>;
}
