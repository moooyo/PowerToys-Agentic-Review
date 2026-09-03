import {
  marshalServerBindingActiveStatusStatementV1,
  marshalServerBindingReceiptStatementV1,
  type ServerBindingActiveStatusStatementV1,
  type ServerBindingReceiptStatementV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import { describe, expect, it } from "vitest";

import {
  frameServerBindingSignerHostPayloadV1,
  marshalServerBindingSignerHostChildMessageV1,
  marshalServerBindingSignerHostParentMessageV1,
  parseServerBindingSignerHostChildMessageV1,
  parseServerBindingSignerHostParentMessageV1,
  SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDOUT_BYTES,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_CONCURRENT_REQUESTS,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES,
  SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
  SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS,
  type ServerBindingSignerHostChildMessageV1,
  ServerBindingSignerHostFrameDecoderV1,
  type ServerBindingSignerHostParentMessageV1,
} from "./server-binding-signer-host-protocol-v1.js";

const instanceId = "a0000000-0000-4000-8000-000000000001";
const requestId = "b0000000-0000-4000-8000-000000000002";
const shutdownRequestId = "c0000000-0000-4000-8000-000000000003";
const issuerPublicKeySpki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-v0lYTgE9BSFUPfyWOB4VptiDOX8QBdKpB90P_41slWTae5OaPqAyns6GVm8aAeOrfR09_g6AhFGmgT1LCM_nA";
const issuerKeyId = "e28eb43c3d5c64b80fe4f26d45e801d1cf45601cbc095fdab74689e760129930";
const validSignature =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ";

const receiptStatement: ServerBindingReceiptStatementV1 = Object.freeze({
  bindingId: "0f7d78fa-f002-4ede-9cd6-06951ee9b745",
  bindingRevision: 1,
  boundAt: "2026-09-03T01:02:03.004Z",
  certificateDerSha256: "11".repeat(32),
  enrollmentGeneration: 1,
  installationId: "worker.installation-1",
  statementType: "durable-binding-created",
  workerNodeId: "worker:node-1",
});

const activeStatusStatement: ServerBindingActiveStatusStatementV1 = Object.freeze({
  bindingId: receiptStatement.bindingId,
  bindingRevision: 1,
  certificateDerSha256: receiptStatement.certificateDerSha256,
  challengeNonceBase64Url: "A".repeat(43),
  enrollmentGeneration: 1,
  expiresAt: "2026-09-03T01:02:33.004Z",
  installationId: receiptStatement.installationId,
  issuedAt: "2026-09-03T01:02:03.004Z",
  receiptSha256: "22".repeat(32),
  recordDocumentSha256: "33".repeat(32),
  statementType: "active-binding-current",
  workerNodeId: receiptStatement.workerNodeId,
});

const receiptStatementJson = Buffer.from(
  marshalServerBindingReceiptStatementV1(receiptStatement),
).toString("base64url");
const activeStatusStatementJson = Buffer.from(
  marshalServerBindingActiveStatusStatementV1(activeStatusStatement),
).toString("base64url");

const readyMessage = Object.freeze({
  capabilities: Object.freeze({
    maximumConcurrentRequests: 1 as const,
    operations: Object.freeze(["active_status_statement_v1", "receipt_statement_v1"] as const),
  }),
  hostPid: 1234,
  instanceId,
  issuerKeyId,
  issuerPublicKeySpki,
  protocolVersion: "1.0" as const,
  type: "ready" as const,
});

const text = (value: Uint8Array): string => Buffer.from(value).toString("utf8");
const bytes = (value: string): Buffer => Buffer.from(value, "utf8");

describe("server binding signer-host wire protocol v1", () => {
  it("freezes the exact protocol constants", () => {
    expect({
      forcedExit: SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
      gracefulShutdown: SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
      handshake: SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS,
      maximumBufferedStderr: SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES,
      maximumBufferedStdout: SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDOUT_BYTES,
      maximumConcurrentRequests: SERVER_BINDING_SIGNER_HOST_MAXIMUM_CONCURRENT_REQUESTS,
      maximumFrame: SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES,
      maximumStatement: SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES,
      protocolVersion: SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION,
      signing: SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS,
    }).toEqual({
      forcedExit: 10000,
      gracefulShutdown: 5000,
      handshake: 10000,
      maximumBufferedStderr: 16384,
      maximumBufferedStdout: 16384,
      maximumConcurrentRequests: 1,
      maximumFrame: 8192,
      maximumStatement: 4096,
      protocolVersion: "1.0",
      signing: 15000,
    });
  });

  it("matches every parent-message golden vector", () => {
    const vectors: ReadonlyArray<
      readonly [Readonly<ServerBindingSignerHostParentMessageV1>, string]
    > = [
      [
        { instanceId, protocolVersion: "1.0", type: "hello" },
        `{"instanceId":"${instanceId}","protocolVersion":"1.0","type":"hello"}`,
      ],
      [
        {
          protocolVersion: "1.0",
          requestId,
          statementJson: receiptStatementJson,
          type: "sign_receipt_statement_v1",
        },
        `{"protocolVersion":"1.0","requestId":"${requestId}","statementJson":"${receiptStatementJson}","type":"sign_receipt_statement_v1"}`,
      ],
      [
        {
          protocolVersion: "1.0",
          requestId,
          statementJson: activeStatusStatementJson,
          type: "sign_active_status_statement_v1",
        },
        `{"protocolVersion":"1.0","requestId":"${requestId}","statementJson":"${activeStatusStatementJson}","type":"sign_active_status_statement_v1"}`,
      ],
      [
        { protocolVersion: "1.0", reason: "caller_abort", requestId, type: "cancel" },
        `{"protocolVersion":"1.0","reason":"caller_abort","requestId":"${requestId}","type":"cancel"}`,
      ],
      [
        { protocolVersion: "1.0", requestId: shutdownRequestId, type: "shutdown" },
        `{"protocolVersion":"1.0","requestId":"${shutdownRequestId}","type":"shutdown"}`,
      ],
    ];

    for (const [message, golden] of vectors) {
      expect(text(marshalServerBindingSignerHostParentMessageV1(message))).toBe(golden);
      const parsed = parseServerBindingSignerHostParentMessageV1(bytes(golden));
      expect(parsed).toEqual(message);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("matches every child-message golden vector", () => {
    const vectors: ReadonlyArray<
      readonly [Readonly<ServerBindingSignerHostChildMessageV1>, string]
    > = [
      [
        readyMessage,
        `{"capabilities":{"maximumConcurrentRequests":1,"operations":["active_status_statement_v1","receipt_statement_v1"]},"hostPid":1234,"instanceId":"${instanceId}","issuerKeyId":"${issuerKeyId}","issuerPublicKeySpki":"${issuerPublicKeySpki}","protocolVersion":"1.0","type":"ready"}`,
      ],
      [
        {
          operation: "receipt_statement_v1",
          protocolVersion: "1.0",
          requestId,
          signature: validSignature,
          type: "signature",
        },
        `{"operation":"receipt_statement_v1","protocolVersion":"1.0","requestId":"${requestId}","signature":"${validSignature}","type":"signature"}`,
      ],
      [
        {
          operation: "active_status_statement_v1",
          protocolVersion: "1.0",
          requestId,
          signature: validSignature,
          type: "signature",
        },
        `{"operation":"active_status_statement_v1","protocolVersion":"1.0","requestId":"${requestId}","signature":"${validSignature}","type":"signature"}`,
      ],
      [
        { protocolVersion: "1.0", requestId, type: "cancelled" },
        `{"protocolVersion":"1.0","requestId":"${requestId}","type":"cancelled"}`,
      ],
      [
        { protocolVersion: "1.0", requestId: shutdownRequestId, type: "shutdown_ack" },
        `{"protocolVersion":"1.0","requestId":"${shutdownRequestId}","type":"shutdown_ack"}`,
      ],
      [
        { code: "INTERNAL_FAILURE", protocolVersion: "1.0", requestId: null, type: "error" },
        '{"code":"INTERNAL_FAILURE","protocolVersion":"1.0","requestId":null,"type":"error"}',
      ],
    ];

    for (const [message, golden] of vectors) {
      expect(text(marshalServerBindingSignerHostChildMessageV1(message))).toBe(golden);
      const parsed = parseServerBindingSignerHostChildMessageV1(bytes(golden));
      expect(parsed).toEqual(message);
      expect(Object.isFrozen(parsed)).toBe(true);
      if (parsed.type === "ready") {
        expect(Object.isFrozen(parsed.capabilities)).toBe(true);
        expect(Object.isFrozen(parsed.capabilities.operations)).toBe(true);
      }
    }
  });

  it("accepts the exact cancellation reasons and child error codes", () => {
    for (const reason of ["caller_abort", "deadline", "shutdown"] as const) {
      expect(() =>
        marshalServerBindingSignerHostParentMessageV1({
          protocolVersion: "1.0",
          reason,
          requestId,
          type: "cancel",
        }),
      ).not.toThrow();
    }
    for (const code of [
      "HANDSHAKE_REJECTED",
      "REQUEST_INVALID",
      "REQUEST_BUSY",
      "SIGNING_FAILED",
      "CANCEL_FAILED",
      "SHUTDOWN_REJECTED",
      "INTERNAL_FAILURE",
    ] as const) {
      expect(() =>
        marshalServerBindingSignerHostChildMessageV1({
          code,
          protocolVersion: "1.0",
          requestId,
          type: "error",
        }),
      ).not.toThrow();
    }
    for (const reason of [
      "Caller_Abort",
      "caller-abort",
      "caller_abort_shutdown",
      "caller_abort\n",
    ]) {
      expect(() =>
        marshalServerBindingSignerHostParentMessageV1({
          protocolVersion: "1.0",
          reason,
          requestId,
          type: "cancel",
        } as never),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    }
    expect(() =>
      marshalServerBindingSignerHostChildMessageV1({
        code: "INTERNAL_ERROR",
        protocolVersion: "1.0",
        requestId,
        type: "error",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });

  it("rejects noncanonical JSON, duplicate members, extra members, and invalid roots", () => {
    const canonical = `{"instanceId":"${instanceId}","protocolVersion":"1.0","type":"hello"}`;
    for (const candidate of [
      ` {"instanceId":"${instanceId}","protocolVersion":"1.0","type":"hello"}`,
      `{"protocolVersion":"1.0","instanceId":"${instanceId}","type":"hello"}`,
      `${canonical}\n`,
      `{"instanceId":"${instanceId}","protocolVersion":"1.0","type":"hello","type":"hello"}`,
      `{"extra":false,"instanceId":"${instanceId}","protocolVersion":"1.0","type":"hello"}`,
      "[]",
      "null",
      `{"instanceId":"${instanceId}","protocolVersion":"1.0","type":"sign_bytes"}`,
    ]) {
      expect(() => parseServerBindingSignerHostParentMessageV1(bytes(candidate))).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^MESSAGE_/u) }),
      );
    }
    expect(() => parseServerBindingSignerHostParentMessageV1(Buffer.from([0xff]))).toThrowError(
      expect.objectContaining({ code: "MESSAGE_INVALID" }),
    );
    expect(() =>
      parseServerBindingSignerHostParentMessageV1(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(canonical)]),
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });

  it("requires lowercase UUID v4, the exact version, and exact plain input data", () => {
    for (const invalidInstanceId of [
      instanceId.toUpperCase(),
      `${instanceId}\n`,
      "10000000-0000-5000-8000-000000000001",
      "not-a-uuid",
    ]) {
      expect(() =>
        marshalServerBindingSignerHostParentMessageV1({
          instanceId: invalidInstanceId,
          protocolVersion: "1.0",
          type: "hello",
        }),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    }
    expect(() =>
      marshalServerBindingSignerHostParentMessageV1({
        instanceId,
        protocolVersion: "2.0",
        type: "hello",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    expect(() =>
      marshalServerBindingSignerHostParentMessageV1({
        extra: true,
        instanceId,
        protocolVersion: "1.0",
        type: "hello",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      instanceId: { enumerable: true, value: instanceId },
      protocolVersion: { enumerable: true, value: "1.0" },
      type: { enumerable: true, get: () => "hello" },
    });
    expect(() => marshalServerBindingSignerHostParentMessageV1(accessor as never)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_INVALID" }),
    );
    expect(() =>
      marshalServerBindingSignerHostParentMessageV1({
        instanceId,
        protocolVersion: "1.0",
        type: "hello",
        [Symbol("hidden")]: true,
      } as never),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });

  it("validates statement profile, canonical bytes, encoding, and size", () => {
    expect(() =>
      marshalServerBindingSignerHostParentMessageV1({
        protocolVersion: "1.0",
        requestId,
        statementJson: activeStatusStatementJson,
        type: "sign_receipt_statement_v1",
      }),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));

    const noncanonical = Buffer.from(
      `${text(marshalServerBindingReceiptStatementV1(receiptStatement))}\n`,
      "utf8",
    ).toString("base64url");
    const invalidUtf8 = Buffer.from([0xff]).toString("base64url");
    const oversized = Buffer.alloc(SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES + 1).toString(
      "base64url",
    );
    for (const statementJson of [noncanonical, invalidUtf8, oversized, "AA="]) {
      expect(() =>
        marshalServerBindingSignerHostParentMessageV1({
          protocolVersion: "1.0",
          requestId,
          statementJson,
          type: "sign_receipt_statement_v1",
        }),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    }
  });

  it("validates ready capabilities, PID, canonical SPKI, and derived key ID", () => {
    for (const candidate of [
      { ...readyMessage, hostPid: 0 },
      { ...readyMessage, hostPid: Number.MAX_SAFE_INTEGER + 1 },
      { ...readyMessage, issuerKeyId: "00".repeat(32) },
      { ...readyMessage, issuerKeyId: issuerKeyId.toUpperCase() },
      { ...readyMessage, issuerKeyId: `${issuerKeyId}\n` },
      { ...readyMessage, issuerPublicKeySpki: Buffer.alloc(91).toString("base64url") },
      {
        ...readyMessage,
        capabilities: { ...readyMessage.capabilities, maximumConcurrentRequests: 2 },
      },
      {
        ...readyMessage,
        capabilities: {
          maximumConcurrentRequests: 1,
          operations: ["receipt_statement_v1", "active_status_statement_v1"],
        },
      },
    ]) {
      expect(() => marshalServerBindingSignerHostChildMessageV1(candidate as never)).toThrowError(
        expect.objectContaining({ code: "MESSAGE_INVALID" }),
      );
    }
  });

  it("accepts only canonical P1363 low-S signature scalars", () => {
    const highS = Buffer.alloc(64);
    highS[31] = 1;
    writeUnsignedBigEndian(
      BigInt("0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a9"),
      highS,
      32,
      32,
    );
    for (const signature of [
      Buffer.alloc(64).toString("base64url"),
      Buffer.alloc(63).toString("base64url"),
      highS.toString("base64url"),
      `${validSignature}\n`,
    ]) {
      expect(() =>
        marshalServerBindingSignerHostChildMessageV1({
          operation: "receipt_statement_v1",
          protocolVersion: "1.0",
          requestId,
          signature,
          type: "signature",
        }),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
    }
    expect(() =>
      marshalServerBindingSignerHostChildMessageV1({
        operation: "generic_bytes_v1",
        protocolVersion: "1.0",
        requestId,
        signature: validSignature,
        type: "signature",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });

  it("frames payloads with a four-byte big-endian length", () => {
    const payload = marshalServerBindingSignerHostParentMessageV1({
      instanceId,
      protocolVersion: "1.0",
      type: "hello",
    });
    const frame = Buffer.from(frameServerBindingSignerHostPayloadV1(payload));
    expect(frame.readUInt32BE(0)).toBe(payload.byteLength);
    expect(frame.subarray(4)).toEqual(Buffer.from(payload));
    expect(() => frameServerBindingSignerHostPayloadV1(Buffer.alloc(0))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
    expect(() =>
      frameServerBindingSignerHostPayloadV1(
        Buffer.alloc(SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES + 1),
      ),
    ).toThrowError(expect.objectContaining({ code: "FRAME_LIMIT_EXCEEDED" }));
  });

  it("decodes fragmented and coalesced frames without aliasing input", () => {
    const firstPayload = marshalServerBindingSignerHostParentMessageV1({
      instanceId,
      protocolVersion: "1.0",
      type: "hello",
    });
    const secondPayload = marshalServerBindingSignerHostParentMessageV1({
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown",
    });
    const combined = Buffer.concat([
      frameServerBindingSignerHostPayloadV1(firstPayload),
      frameServerBindingSignerHostPayloadV1(secondPayload),
    ]);
    const decoder = new ServerBindingSignerHostFrameDecoderV1();
    const decoded: Uint8Array[] = [];
    for (const byte of combined) decoded.push(...decoder.push(Buffer.from([byte])));
    decoder.finish();
    expect(decoded.map(text)).toEqual([text(firstPayload), text(secondPayload)]);
    combined.fill(0);
    expect(decoded.map(text)).toEqual([text(firstPayload), text(secondPayload)]);

    const coalesced = new ServerBindingSignerHostFrameDecoderV1();
    expect(
      coalesced
        .push(
          Buffer.concat([
            frameServerBindingSignerHostPayloadV1(firstPayload),
            frameServerBindingSignerHostPayloadV1(secondPayload),
          ]),
        )
        .map(text),
    ).toEqual([text(firstPayload), text(secondPayload)]);
    coalesced.finish();
  });

  it("terminalizes zero, oversized, truncated, and post-finish framing", () => {
    const zero = new ServerBindingSignerHostFrameDecoderV1();
    expect(() => zero.push(Buffer.alloc(4))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
    expect(() => zero.push(Buffer.from([1]))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );

    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES + 1, 0);
    const oversized = new ServerBindingSignerHostFrameDecoderV1();
    expect(() => oversized.push(oversizedHeader)).toThrowError(
      expect.objectContaining({ code: "FRAME_LIMIT_EXCEEDED" }),
    );

    const truncated = new ServerBindingSignerHostFrameDecoderV1();
    const frame = Buffer.from(frameServerBindingSignerHostPayloadV1(bytes("{}")));
    truncated.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining({ code: "FRAME_TRUNCATED" }),
    );
    expect(() => truncated.push(Buffer.from([0]))).toThrowError(
      expect.objectContaining({ code: "FRAME_TRUNCATED" }),
    );

    const finished = new ServerBindingSignerHostFrameDecoderV1();
    finished.finish();
    expect(() => finished.push(Buffer.from([0]))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
  });

  it("rejects non-intrinsic byte views", () => {
    const proxied = new Proxy(new Uint8Array([1]), {});
    expect(() => frameServerBindingSignerHostPayloadV1(proxied)).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
    expect(() => frameServerBindingSignerHostPayloadV1({ byteLength: 1 } as never)).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
    const decoder = new ServerBindingSignerHostFrameDecoderV1();
    expect(() => decoder.push(proxied)).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
    expect(() => decoder.push(Buffer.from([0]))).toThrowError(
      expect.objectContaining({ code: "FRAME_INVALID" }),
    );
  });
});

function writeUnsignedBigEndian(
  value: bigint,
  target: Uint8Array,
  offset: number,
  length: number,
): void {
  let remaining = value;
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("Test scalar does not fit.");
}
