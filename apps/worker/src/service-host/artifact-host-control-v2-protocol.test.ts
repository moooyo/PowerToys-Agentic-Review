import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES,
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES,
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES,
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_FRAME_BYTES,
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_BODY_BYTES,
  ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_FRAME_BYTES,
  ArtifactHostControlV2ProtocolError,
  encodeArtifactHostControlV2Call,
  parseArtifactHostControlV2Call,
  parseArtifactHostControlV2Response,
} from "./artifact-host-control-v2-protocol.js";
import { encodeHostControlCall, parseHostControlResponse } from "./host-control-protocol.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";

describe("dormant Artifact HostControl v2 protocol", () => {
  it("pins the version and independent body and frame ceilings", () => {
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES).toBe(16_384);
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES).toBe(365_910);
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_BODY_BYTES).toBe(16_384);
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_FRAME_BYTES).toBe(32_768);
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES).toBe(524_288);
    expect(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_FRAME_BYTES).toBe(32_768);
  });

  it("pins the cross-language create-call golden", () => {
    const body = encodeHostControlOpaqueJson({}, 16_384);
    const frame = encodeArtifactHostControlV2Call("CreateArtifactUpload", "request:1", {
      body,
      runAttemptId: "run:1",
    });
    const document = documentFromFrame(frame);

    expect(document.toString("utf8")).toBe(
      '{"operation":"CreateArtifactUpload","payload":{"body":{"base64Url":"e30","byteLength":2,"sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},"runAttemptId":"run:1"},"protocolVersion":"2.0","requestId":"request:1","type":"call"}',
    );
    expect(createHash("sha256").update(document).digest("hex")).toBe(
      "c826868a3fc625e9b98e832d03b5d98bd0bf0e4479bc46609296d30d27ceb20a",
    );
    expect(parseArtifactHostControlV2Call(document)).toMatchObject({
      operation: "CreateArtifactUpload",
      requestId: "request:1",
      payload: { runAttemptId: "run:1", body },
    });
  });

  it("accepts exactly the five fixed route shapes", () => {
    const controlBody = encodeHostControlOpaqueJson({ ok: true }, 16_384);
    const chunkBody = encodeHostControlOpaqueJson({ data: "YQ" }, 365_910);
    const cases = [
      ["CreateArtifactUpload", { body: controlBody, runAttemptId: "run:1" }],
      ["PutArtifactChunk", { body: chunkBody, chunkIndex: 7, uploadId: "upload:1" }],
      ["FinalizeArtifactUpload", { body: controlBody, uploadId: "upload:1" }],
      ["TerminateArtifactUpload", { body: controlBody, uploadId: "upload:1" }],
      ["CompleteArtifactRun", { body: controlBody, runAttemptId: "run:1" }],
    ] as const;

    for (const [operation, payload] of cases) {
      const parsed = parseArtifactHostControlV2Call(
        documentFromFrame(encodeArtifactHostControlV2Call(operation, "request:1", payload)),
      );
      expect(parsed).toMatchObject({ operation, payload, protocolVersion: "2.0" });
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.payload)).toBe(true);
    }
  });

  it.each(["url", "method", "header", "origin", "certificatePath"])(
    "rejects payload widening through %s",
    (name) => {
      const body = encodeHostControlOpaqueJson({}, 16_384);
      expect(() =>
        encodeArtifactHostControlV2Call("CreateArtifactUpload", "request:1", {
          body,
          runAttemptId: "run:1",
          [name]: "attacker-controlled",
        } as never),
      ).toThrow(ArtifactHostControlV2ProtocolError);
    },
  );

  it("rejects accessor payloads without invoking their getters", () => {
    const body = encodeHostControlOpaqueJson({}, 16_384);
    let reads = 0;
    const payload = { body, runAttemptId: "run:1" };
    Object.defineProperty(payload, "runAttemptId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "run:1";
      },
    });
    expect(() =>
      encodeArtifactHostControlV2Call("CreateArtifactUpload", "request:1", payload),
    ).toThrow(ArtifactHostControlV2ProtocolError);
    expect(reads).toBe(0);
  });

  it("rejects unknown operations and invalid route identities before framing", () => {
    const body = encodeHostControlOpaqueJson({}, 16_384);
    expect(() =>
      encodeArtifactHostControlV2Call("Claim" as never, "request:1", {
        body,
        runAttemptId: "run:1",
      }),
    ).toThrow(ArtifactHostControlV2ProtocolError);
    expect(() =>
      encodeArtifactHostControlV2Call("PutArtifactChunk", "request:1", {
        body,
        chunkIndex: 8,
        uploadId: "upload:1",
      }),
    ).toThrow(ArtifactHostControlV2ProtocolError);
    expect(() =>
      encodeArtifactHostControlV2Call("CompleteArtifactRun", "request:1", {
        body,
        runAttemptId: "../escape",
      }),
    ).toThrow(ArtifactHostControlV2ProtocolError);
  });

  it("enforces decoded body limits independently of the physical frame limit", () => {
    const exactControl = encodeHostControlOpaqueJson(
      { value: "x".repeat(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES - 12) },
      ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES,
    );
    const exactChunk = encodeHostControlOpaqueJson(
      { value: "x".repeat(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES - 12) },
      ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES,
    );
    expect(
      encodeArtifactHostControlV2Call("CreateArtifactUpload", "request:1", {
        body: exactControl,
        runAttemptId: "run:1",
      }).byteLength,
    ).toBeLessThanOrEqual(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_FRAME_BYTES + 4);
    expect(
      encodeArtifactHostControlV2Call("PutArtifactChunk", "request:1", {
        body: exactChunk,
        chunkIndex: 0,
        uploadId: "upload:1",
      }).byteLength,
    ).toBeLessThanOrEqual(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES + 4);

    const oversized = encodeHostControlOpaqueJson(
      { value: "x".repeat(ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES - 11) },
      ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES + 1,
    );
    expect(() =>
      encodeArtifactHostControlV2Call("FinalizeArtifactUpload", "request:1", {
        body: oversized,
        uploadId: "upload:1",
      }),
    ).toThrow(ArtifactHostControlV2ProtocolError);
  });

  it("decodes bounded success and preserves sanitized code plus retryable", () => {
    const body = encodeHostControlOpaqueJson({ state: "receiving" }, 16_384);
    expect(
      parseArtifactHostControlV2Response(
        canonicalDocument({
          body,
          outcome: "ok",
          protocolVersion: "2.0",
          requestId: "request:1",
          type: "response",
        }),
      ),
    ).toMatchObject({
      outcome: "ok",
      requestId: "request:1",
      body: { state: "receiving" },
    });

    const error = parseArtifactHostControlV2Response(
      canonicalDocument({
        error: {
          code: "artifact_storage_integrity",
          message: "The artifact operation failed.",
          retryable: false,
        },
        outcome: "error",
        protocolVersion: "2.0",
        requestId: "request:2",
        type: "response",
      }),
    );
    expect(error).toMatchObject({
      outcome: "error",
      error: { code: "artifact_storage_integrity", retryable: false },
    });
    expect(JSON.stringify(error)).not.toContain("The artifact operation failed.");
  });

  it("keeps v1 and v2 mutually unrecognized", () => {
    const body = encodeHostControlOpaqueJson({}, 16_384);
    const v2Call = documentFromFrame(
      encodeArtifactHostControlV2Call("CreateArtifactUpload", "request:1", {
        body,
        runAttemptId: "run:1",
      }),
    );
    expect(() => parseHostControlResponse(v2Call)).toThrow();
    expect(() =>
      encodeHostControlCall("CreateArtifactUpload" as never, "request:1", {
        body,
        runAttemptId: "run:1",
      }),
    ).toThrow();

    const v1Response = canonicalDocument({
      body,
      outcome: "ok",
      protocolVersion: "1.0",
      requestId: "request:1",
      type: "response",
    });
    expect(() => parseArtifactHostControlV2Response(v1Response)).toThrow(
      ArtifactHostControlV2ProtocolError,
    );
  });

  it("rejects noncanonical, widened, oversized, and unsafe error responses", () => {
    const valid = {
      error: { code: "lease_lost", message: "Lease lost.", retryable: false },
      outcome: "error",
      protocolVersion: "2.0",
      requestId: "request:1",
      type: "response",
    };
    for (const value of [
      { ...valid, extra: true },
      { ...valid, protocolVersion: "1.0" },
      { ...valid, error: { ...valid.error, code: "LEASE_LOST" } },
      { ...valid, error: { ...valid.error, message: "secret\nvalue" } },
      { ...valid, error: { ...valid.error, message: "secret\tvalue" } },
      { ...valid, error: { ...valid.error, message: "secret\u007fvalue" } },
      { ...valid, error: { ...valid.error, retryable: "false" } },
    ]) {
      expect(() => parseArtifactHostControlV2Response(canonicalDocument(value))).toThrow(
        ArtifactHostControlV2ProtocolError,
      );
    }
    expect(() =>
      parseArtifactHostControlV2Response(Buffer.from(' {"protocolVersion":"2.0"}', "utf8")),
    ).toThrow(ArtifactHostControlV2ProtocolError);
  });
});

function canonicalDocument(value: Readonly<Record<string, unknown>>): Buffer {
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function documentFromFrame(frame: Buffer): Buffer {
  const length = frame.readUInt32LE(0);
  expect(length).toBe(frame.byteLength - 4);
  return frame.subarray(4);
}
