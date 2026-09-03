import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import {
  marshalServerBindingActiveStatusStatementV1,
  marshalServerBindingReceiptStatementV1,
  serverBindingActiveStatusSigningPreimageV1,
  serverBindingReceiptSigningPreimageV1,
} from "@agentic-review/contracts/server-binding-authority-v1";

const protocolVersion = "1.0";
const protocolArgument = "--server-binding-signer-host-v1";
const maximumFrameBytes = 8192;
const scenarios = new Set([
  "normal",
  "responsive_cancel",
  "hang_sign",
  "hang_shutdown",
  "exit_before_ready",
  "protocol_corruption",
  "stdout_overflow",
  "stderr_overflow",
]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggZDZZcSzKuD4h3Iu
rGCGLBlKcNoYbAjlNgwsgHcJ/iGhRANCAAT6/SVhOAT0FIVQ9/JY4HhWm2IM5fxA
F0qkH3Q//jWyVZNp7k5o+oDKezoZWbxoB46t9HT3+DoCEUaaBPUsIz+c
-----END PRIVATE KEY-----`;
const privateKey = createPrivateKey(privateKeyPem);
const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const issuerPublicKeySpki = publicKeySpki.toString("base64url");
const issuerKeyId = createHash("sha256").update(publicKeySpki).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });
const inputChunks = [];
let inputBytes = 0;
let instanceId = null;
let activeRequest = null;
let state = "awaiting_hello";

const scenarioArgument = process.argv.find((value) => value.startsWith("--fixture-scenario="));
const scenario = scenarioArgument?.slice("--fixture-scenario=".length) ?? "normal";
if (!process.argv.includes(protocolArgument) || !scenarios.has(scenario)) process.exit(64);

process.stdin.on("data", (chunk) => {
  inputChunks.push(Buffer.from(chunk));
  inputBytes += chunk.byteLength;
  drainInput();
});
process.stdin.on("end", () => {
  if (inputBytes !== 0) process.exitCode = 65;
});
process.stdin.on("error", () => process.exit(66));

function drainInput() {
  let bytes = Buffer.concat(inputChunks, inputBytes);
  let offset = 0;
  while (bytes.byteLength - offset >= 4) {
    const length = bytes.readUInt32BE(offset);
    if (length < 1 || length > maximumFrameBytes) return fail("REQUEST_INVALID", null);
    if (bytes.byteLength - offset < 4 + length) break;
    const payload = bytes.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    handlePayload(payload);
    if (state === "exiting" || state === "blocked") return;
  }
  bytes = Buffer.from(bytes.subarray(offset));
  inputChunks.length = 0;
  if (bytes.byteLength !== 0) inputChunks.push(bytes);
  inputBytes = bytes.byteLength;
}

function handlePayload(payload) {
  let text;
  let message;
  try {
    text = decoder.decode(payload);
    if ([...text].some((character) => character.codePointAt(0) > 0x7f)) throw new Error();
    message = JSON.parse(text);
  } catch {
    return fail("REQUEST_INVALID", null);
  }
  const normalized = normalizeParentMessage(message);
  if (normalized === null || serializeParentMessage(normalized) !== text) {
    return fail("REQUEST_INVALID", normalized?.requestId ?? null);
  }

  switch (state) {
    case "awaiting_hello":
      if (normalized.type !== "hello") return fail("HANDSHAKE_REJECTED", null);
      instanceId = normalized.instanceId;
      if (scenario === "exit_before_ready") return exit(17);
      if (scenario === "protocol_corruption") {
        process.stdout.write(Buffer.from([0, 0, 0, 0]), () => exit(18));
        return;
      }
      if (scenario === "stdout_overflow") {
        process.stdout.write(Buffer.alloc(16_385, 0x41), () => blockForever());
        return;
      }
      if (scenario === "stderr_overflow") {
        process.stderr.write(Buffer.alloc(16_385, "fixture-secret-marker"), () => blockForever());
        return;
      }
      state = "ready_idle";
      return send({
        capabilities: {
          maximumConcurrentRequests: 1,
          operations: ["active_status_statement_v1", "receipt_statement_v1"],
        },
        hostPid: process.pid,
        instanceId,
        issuerKeyId,
        issuerPublicKeySpki,
        protocolVersion,
        type: "ready",
      });
    case "ready_idle":
      if (
        normalized.type === "sign_receipt_statement_v1" ||
        normalized.type === "sign_active_status_statement_v1"
      ) {
        activeRequest = normalized;
        state = "signing";
        if (scenario === "hang_sign") return blockForever();
        if (scenario === "responsive_cancel") return;
        return signAndRespond(normalized);
      }
      if (normalized.type === "shutdown") {
        state = "shutting_down";
        if (scenario === "hang_shutdown") return blockForever();
        return send(
          { protocolVersion, requestId: normalized.requestId, type: "shutdown_ack" },
          () => exit(0),
        );
      }
      return fail("REQUEST_INVALID", normalized.requestId ?? null);
    case "signing":
      if (
        normalized.type === "cancel" &&
        activeRequest !== null &&
        normalized.requestId === activeRequest.requestId
      ) {
        state = "cancelling";
        return send({ protocolVersion, requestId: normalized.requestId, type: "cancelled" }, () =>
          exit(0),
        );
      }
      return fail("REQUEST_BUSY", normalized.requestId ?? null);
    default:
      return fail("INTERNAL_FAILURE", null);
  }
}

function signAndRespond(request) {
  try {
    const statementBytes = Buffer.from(request.statementJson, "base64url");
    const statement = JSON.parse(decoder.decode(statementBytes));
    const receipt = request.type === "sign_receipt_statement_v1";
    const canonical = Buffer.from(
      receipt
        ? marshalServerBindingReceiptStatementV1(statement)
        : marshalServerBindingActiveStatusStatementV1(statement),
    );
    if (!canonical.equals(statementBytes)) return fail("REQUEST_INVALID", request.requestId);
    const preimage = receipt
      ? serverBindingReceiptSigningPreimageV1(statement)
      : serverBindingActiveStatusSigningPreimageV1(statement);
    const signature = normalizeLowS(
      nodeSign("sha256", preimage, { dsaEncoding: "ieee-p1363", key: privateKey }),
    );
    state = "ready_idle";
    activeRequest = null;
    return send({
      operation: receipt ? "receipt_statement_v1" : "active_status_statement_v1",
      protocolVersion,
      requestId: request.requestId,
      signature: signature.toString("base64url"),
      type: "signature",
    });
  } catch {
    return fail("SIGNING_FAILED", request.requestId);
  }
}

function normalizeParentMessage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  switch (value.type) {
    case "hello":
      if (!exactKeys(value, ["instanceId", "protocolVersion", "type"])) return null;
      if (!uuidV4.test(value.instanceId) || value.protocolVersion !== protocolVersion) return null;
      return { instanceId: value.instanceId, protocolVersion, type: "hello" };
    case "sign_receipt_statement_v1":
    case "sign_active_status_statement_v1":
      if (!exactKeys(value, ["protocolVersion", "requestId", "statementJson", "type"])) {
        return null;
      }
      if (
        value.protocolVersion !== protocolVersion ||
        !uuidV4.test(value.requestId) ||
        typeof value.statementJson !== "string" ||
        !/^[A-Za-z0-9_-]+(?![\s\S])/u.test(value.statementJson)
      ) {
        return null;
      }
      return {
        protocolVersion,
        requestId: value.requestId,
        statementJson: value.statementJson,
        type: value.type,
      };
    case "cancel":
      if (!exactKeys(value, ["protocolVersion", "reason", "requestId", "type"])) return null;
      if (
        value.protocolVersion !== protocolVersion ||
        !uuidV4.test(value.requestId) ||
        !["caller_abort", "deadline", "shutdown"].includes(value.reason)
      ) {
        return null;
      }
      return { protocolVersion, reason: value.reason, requestId: value.requestId, type: "cancel" };
    case "shutdown":
      if (!exactKeys(value, ["protocolVersion", "requestId", "type"])) return null;
      if (value.protocolVersion !== protocolVersion || !uuidV4.test(value.requestId)) return null;
      return { protocolVersion, requestId: value.requestId, type: "shutdown" };
    default:
      return null;
  }
}

function serializeParentMessage(value) {
  switch (value.type) {
    case "hello":
      return `{"instanceId":${JSON.stringify(value.instanceId)},"protocolVersion":"1.0","type":"hello"}`;
    case "sign_receipt_statement_v1":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"statementJson":${JSON.stringify(value.statementJson)},"type":"sign_receipt_statement_v1"}`;
    case "sign_active_status_statement_v1":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"statementJson":${JSON.stringify(value.statementJson)},"type":"sign_active_status_statement_v1"}`;
    case "cancel":
      return `{"protocolVersion":"1.0","reason":${JSON.stringify(value.reason)},"requestId":${JSON.stringify(value.requestId)},"type":"cancel"}`;
    case "shutdown":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"type":"shutdown"}`;
    default:
      throw new Error("Unknown fixture message.");
  }
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function send(message, callback) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]), callback);
}

function fail(code, requestId) {
  if (state === "exiting") return;
  state = "exiting";
  send({ code, protocolVersion, requestId, type: "error" }, () => exit(70));
}

function exit(code) {
  state = "exiting";
  process.exit(code);
}

function blockForever() {
  state = "blocked";
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function normalizeLowS(signature) {
  const result = Buffer.from(signature);
  const s = readUnsignedBigEndian(result.subarray(32));
  if (s > p256HalfOrder) writeUnsignedBigEndian(p256Order - s, result, 32, 32);
  return result;
}

function readUnsignedBigEndian(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsignedBigEndian(value, target, offset, length) {
  let remaining = value;
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("Fixture scalar does not fit.");
}
