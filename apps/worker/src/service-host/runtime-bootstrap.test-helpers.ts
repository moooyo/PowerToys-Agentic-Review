import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Duplex, PassThrough } from "node:stream";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { ArwxStdioChannel } from "./arwx-stdio-channel.js";
import type { ServiceHostPayloadRole } from "./launch-contract.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import {
  createRuntimeBootstrapReadyBoundary,
  type RuntimeBootstrapPreparation,
} from "./runtime-bootstrap-handshake.js";

interface BootstrapHostState {
  readonly role: ServiceHostPayloadRole;
  readonly bootstrap: Buffer;
  readonly commit: Buffer | undefined;
  readonly commitFragments: number;
  ack: Buffer | undefined;
}

const bootstrapHosts = new WeakMap<object, BootstrapHostState>();

export function installBootstrapTestHost(
  stream: Duplex,
  role: ServiceHostPayloadRole,
  options:
    | number
    | {
        readonly bootstrap?: Buffer;
        readonly commit?: Buffer | null;
        readonly fragments?: number;
      } = 1,
): void {
  const fragments = typeof options === "number" ? options : (options.fragments ?? 1);
  const bootstrap =
    typeof options === "number" || options.bootstrap === undefined
      ? bootstrapDocument(role)
      : options.bootstrap;
  const commit =
    typeof options === "number" || options.commit === undefined
      ? commitDocument(role, bootstrap)
      : (options.commit ?? undefined);
  bootstrapHosts.set(stream, {
    role,
    bootstrap,
    commit,
    commitFragments: fragments,
    ack: undefined,
  });
  pushFragments(stream, encodeFrame(bootstrap), fragments);
}

export function handleBootstrapTestWrite(
  stream: Duplex,
  chunk: Buffer | string,
  callback: (error?: Error | null) => void,
): boolean {
  const state = bootstrapHosts.get(stream);
  if (state === undefined || state.ack !== undefined) return false;
  const frame = Buffer.from(chunk);
  const document = decodeSingleFrame(frame);
  const value = JSON.parse(document.toString("utf8")) as Record<string, unknown>;
  if (value.type !== "runtimeBootstrapAck") {
    callback(new Error("Expected RuntimeBootstrapAckV1 as the first Node write."));
    return true;
  }
  state.ack = document;
  callback();
  const commit = state.commit;
  if (commit !== undefined) {
    queueMicrotask(() => pushFragments(stream, encodeFrame(commit), state.commitFragments));
  }
  return true;
}

export function bootstrapTestAck(stream: Duplex): Buffer | undefined {
  const ack = bootstrapHosts.get(stream)?.ack;
  return ack === undefined ? undefined : Buffer.from(ack);
}

export function createTestBootstrapPreparation<TRole extends ServiceHostPayloadRole>(
  role: TRole,
): RuntimeBootstrapPreparation<TRole> {
  return (parsed) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const arwx = new ArwxStdioChannel({
      localRole: role,
      input,
      output,
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        parsed.bootstrap.shutdown.gracefulTimeoutMs -
        parsed.bootstrap.shutdown.forceTerminationReserveMs,
    });
    const receiveLoop = arwx.startRuntimeBootstrapReceiveLoop(() => {
      throw new Error("Test bootstrap guard rejects business messages.");
    });
    try {
      return createRuntimeBootstrapReadyBoundary(role, parsed, arwx, receiveLoop.token);
    } catch (error) {
      arwx.abort();
      throw error;
    }
  };
}

export function bootstrapDocument(role: ServiceHostPayloadRole): Buffer {
  const golden = readSharedGolden();
  const value = JSON.parse(golden.toString("utf8")) as Record<string, unknown>;
  value.role = role;
  value.roleConfig = encodeHostControlOpaqueJson(
    { executionEnabled: false, foundationVersion: 1, role },
    47 * 1_024,
  );
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

export function commitDocument(role: ServiceHostPayloadRole, bootstrap: Uint8Array): Buffer {
  const value = JSON.parse(Buffer.from(bootstrap).toString("utf8")) as Record<string, unknown>;
  return Buffer.from(
    serializeCanonicalJson({
      bootstrapId: value.bootstrapId,
      bootstrapSha256: createHash("sha256").update(bootstrap).digest("hex"),
      bootstrapVersion: 1,
      committed: true,
      protocolVersion: "1.0",
      role,
      type: "runtimeBootstrapCommit",
    }),
    "utf8",
  );
}

export function encodeFrame(document: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(4 + document.byteLength);
  frame.writeUInt32LE(document.byteLength, 0);
  frame.set(document, 4);
  return frame;
}

export function decodeSingleFrame(frame: Uint8Array): Buffer {
  const bytes = Buffer.from(frame);
  if (bytes.byteLength < 5) throw new Error("Test HostControl frame is incomplete.");
  const length = bytes.readUInt32LE(0);
  if (length !== bytes.byteLength - 4) throw new Error("Test HostControl frame length is invalid.");
  return Buffer.from(bytes.subarray(4));
}

function pushFragments(stream: Duplex, frame: Buffer, fragments: number): void {
  const size = Math.max(1, Math.ceil(frame.byteLength / fragments));
  for (let offset = 0; offset < frame.byteLength; offset += size) {
    stream.push(frame.subarray(offset, Math.min(frame.byteLength, offset + size)));
  }
}

function readSharedGolden(): Buffer {
  const path = new URL(
    "../../../../native/service-host/internal/localrpc/testdata/runtime_bootstrap_v1.json",
    import.meta.url,
  );
  const document = readFileSync(path);
  return Buffer.from(document.subarray(0, document.byteLength - 1));
}
