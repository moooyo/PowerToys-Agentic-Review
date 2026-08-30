export const processHostProtocolVersion = "1.0" as const;

export interface ProcessResourceLimits {
  readonly hardTimeoutMs: number;
  readonly maximumProcessCount?: number;
  readonly maximumMemoryBytes?: number;
  readonly maximumOutputBytes?: number;
}

export interface ProcessLaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly standardInput?: string;
  readonly limits: ProcessResourceLimits;
}

export type ProcessHostRequest =
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly requestId: string;
      readonly type: "start";
      readonly spec: ProcessLaunchSpec;
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly requestId: string;
      readonly type: "terminate";
      readonly reason: "cancelled" | "lease_lost" | "stale" | "timeout" | "worker_shutdown";
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly requestId: string;
      readonly type: "shutdown";
    };

export type ProcessHostEvent =
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly type: "ready";
      readonly processHostPid: number;
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly type: "started";
      readonly requestId: string;
      readonly processId: number;
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly type: "stdout" | "stderr";
      readonly requestId: string;
      readonly sequence: number;
      readonly dataBase64: string;
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly type: "exited";
      readonly requestId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly outputTruncated: boolean;
    }
  | {
      readonly protocolVersion: typeof processHostProtocolVersion;
      readonly type: "error";
      readonly requestId: string | null;
      readonly code: string;
      readonly message: string;
    };

export interface ManagedProcess {
  readonly requestId: string;
  readonly processId: number;
  readonly completed: Promise<Extract<ProcessHostEvent, { readonly type: "exited" }>>;
  terminate(
    reason: Extract<ProcessHostRequest, { readonly type: "terminate" }>["reason"],
  ): Promise<void>;
}

export interface ProcessHostClient {
  start(spec: ProcessLaunchSpec, signal: AbortSignal): Promise<ManagedProcess>;
  terminateAll(
    reason: Extract<ProcessHostRequest, { readonly type: "terminate" }>["reason"],
  ): Promise<void>;
  close(): Promise<void>;
}

export class UnavailableProcessHostClient implements ProcessHostClient {
  public async start(_spec: ProcessLaunchSpec, _signal: AbortSignal): Promise<ManagedProcess> {
    throw new Error("ProcessHost integration is not available in this worker build.");
  }

  public async terminateAll(
    _reason: Extract<ProcessHostRequest, { readonly type: "terminate" }>["reason"],
  ): Promise<void> {
    await Promise.resolve();
  }

  public async close(): Promise<void> {
    await Promise.resolve();
  }
}
