import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ArmArwxShutdownV1, validateArmArwxShutdownResult } from "./arwx-shutdown.js";
import { encodeHostControlCall } from "./host-control-protocol.js";

describe("ArmArwxShutdownV1 wire contract", () => {
  it.each([
    ["control", 0, 1],
    ["executor", 2, 3],
  ] as const)(
    "matches the shared %s canonical call and result golden",
    (_role, callLine, resultLine) => {
      const callDocument = goldenLine(callLine);
      const call = JSON.parse(callDocument) as {
        readonly requestId: string;
        readonly payload: ArmArwxShutdownV1;
      };
      const encoded = encodeHostControlCall("ArmArwxShutdown", call.requestId, call.payload);
      expect(encoded.readUInt32LE(0)).toBe(Buffer.byteLength(callDocument, "utf8"));
      expect(encoded.subarray(4).toString("utf8")).toBe(callDocument);

      const response = JSON.parse(goldenLine(resultLine)) as {
        readonly body: Record<string, unknown>;
      };
      expect(validateArmArwxShutdownResult(response.body, call.payload)).toEqual(response.body);
    },
  );

  it.each([
    [
      "extra field",
      (value: Record<string, unknown>): void => {
        value.extra = true;
      },
    ],
    [
      "armed false",
      (value: Record<string, unknown>): void => {
        value.armed = false;
      },
    ],
    [
      "sequence number",
      (value: Record<string, unknown>): void => {
        value.finalSequence = 1;
      },
    ],
    [
      "sequence drift",
      (value: Record<string, unknown>): void => {
        value.finalSequence = "2";
      },
    ],
    [
      "digest drift",
      (value: Record<string, unknown>): void => {
        value.finalFrameSha256 = "0".repeat(64);
      },
    ],
    [
      "remaining drift",
      (value: Record<string, unknown>): void => {
        value.remainingShutdownMs = 1;
      },
    ],
  ] as const)("rejects result mutation: %s", (_name, mutate) => {
    const call = JSON.parse(goldenLine(0)) as { readonly payload: ArmArwxShutdownV1 };
    const response = JSON.parse(goldenLine(1)) as { readonly body: Record<string, unknown> };
    mutate(response.body);
    expect(() => validateArmArwxShutdownResult(response.body, call.payload)).toThrowError(
      expect.objectContaining({ code: "ARM_RESULT_INVALID" }),
    );
  });

  it.each([
    ["zero sequence", { finalSequence: "0" }],
    ["leading-zero sequence", { finalSequence: "01" }],
    ["overflow sequence", { finalSequence: "18446744073709551616" }],
    ["short frame", { finalFrameBytes: 47 }],
    ["non-nil correlation", { finalCorrelationId: "00112233-4455-4677-8899-aabbccddeeff" }],
  ] as const)("rejects request mutation: %s", (_name, mutation) => {
    const call = JSON.parse(goldenLine(0)) as {
      readonly requestId: string;
      readonly payload: ArmArwxShutdownV1;
    };
    expect(() =>
      encodeHostControlCall("ArmArwxShutdown", call.requestId, {
        ...call.payload,
        ...mutation,
      }),
    ).toThrow();
  });

  it("rejects request IDs with trailing line terminators", () => {
    const call = JSON.parse(goldenLine(0)) as {
      readonly requestId: string;
      readonly payload: ArmArwxShutdownV1;
    };
    expect(() =>
      encodeHostControlCall("ArmArwxShutdown", `${call.requestId}\n`, call.payload),
    ).toThrow();
    expect(() =>
      encodeHostControlCall("ArmArwxShutdown", `${call.requestId}\u2028`, call.payload),
    ).toThrow();
  });
});

function goldenLines(): readonly string[] {
  return readFileSync(
    new URL(
      "../../../../native/service-host/internal/localrpc/testdata/arm_arwx_shutdown_v1.jsonl",
      import.meta.url,
    ),
    "utf8",
  )
    .trim()
    .split("\n");
}

function goldenLine(index: number): string {
  const line = goldenLines()[index];
  if (line === undefined) throw new Error(`Missing ArmArwxShutdownV1 golden line ${index}.`);
  return line;
}
