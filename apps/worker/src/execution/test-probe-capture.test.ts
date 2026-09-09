import { createCanonicalResult } from "@agentic-review/codex";
import {
  maximumTestProbeOutputUtf8Bytes,
  type ObservationValue,
  type ProbeObservationsV1,
  type TestProbeOutputDeclarationV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  captureTestProbeOutput,
  containsUnsafeObservationValue,
  sanitizeTestProbeCapture,
  TestProbeCaptureError,
} from "./test-probe-capture.js";

const declaration: TestProbeOutputDeclarationV1 = {
  schemaVersion: "TestProbeOutputDeclarationV1",
  fields: [
    { id: "status", description: "Observed status.", type: "string" },
    { id: "count", description: "Observed count.", type: "number" },
    { id: "visible", description: "Observed visibility.", type: "boolean" },
  ],
};
function output(value = "Ready"): ProbeObservationsV1 {
  return {
    schemaVersion: "ProbeObservationsV1",
    observations: [
      { id: "status", state: "observed", value: { type: "string", value } },
      { id: "count", state: "observed", value: { type: "number", value: -0 } },
      { id: "visible", state: "unavailable" },
    ],
  };
}
const capture = (stdout: string, secrets: readonly string[] = []) =>
  captureTestProbeOutput("profile-version:measure", stdout, declaration, secrets);

describe("complete test probe capture", () => {
  it("keeps complete typed values and explicit unavailable values with a canonical hash", () => {
    const result = capture(` \r\n${JSON.stringify(output())}\t`);
    expect(result.output).toEqual(JSON.parse(JSON.stringify(output())));
    expect(result.outputSha256).toBe(createCanonicalResult(result.output).sha256);
    const number = result.output.observations[1];
    expect(number?.state === "observed" && Object.is(number.value.value, -0)).toBe(false);
    expect(result.checkId).toBe("profile-version:measure");
  });

  it("accepts safe empty and full-length values without diagnostic transformation", () => {
    for (const text of ["", "x".repeat(2_048), "line one\nline two\tend"]) {
      expect(capture(JSON.stringify(output(text))).output.observations[0]).toEqual({
        id: "status",
        state: "observed",
        value: { type: "string", value: text },
      });
    }
  });

  it("enforces the byte limit before discarding surrounding whitespace", () => {
    const text = JSON.stringify(output());
    expect(() => capture(text.padEnd(maximumTestProbeOutputUtf8Bytes, " "))).not.toThrow();
    expect(() => capture(text.padEnd(maximumTestProbeOutputUtf8Bytes + 1, " "))).toThrow(
      TestProbeCaptureError,
    );
    expect(() => capture(`${"é".repeat(maximumTestProbeOutputUtf8Bytes / 2)}${text}`)).toThrow(
      TestProbeCaptureError,
    );
  });

  it.each([
    [
      "repeated root key",
      '{"schemaVersion":"ProbeObservationsV1","schemaVersion":"ProbeObservationsV1","observations":[]}',
    ],
    [
      "escaped duplicate key",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"status","\\u0069d":"status","state":"unavailable"}]}',
    ],
    [
      "nested duplicate key",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"count","state":"observed","value":{"type":"number","value":1,"\\u0076alue":2}}]}',
    ],
    [
      "prototype member",
      '{"schemaVersion":"ProbeObservationsV1","observations":[],"__proto__":{"polluted":true}}',
    ],
    ["additional document", `${JSON.stringify(output())}\n{}`],
    ["leading log", `progress\n${JSON.stringify(output())}`],
    ["trailing comma", '{"schemaVersion":"ProbeObservationsV1","observations":[],}'],
    ["missing comma", '{"schemaVersion":"ProbeObservationsV1" "observations":[]}'],
    ["non-JSON whitespace", `\u00a0${JSON.stringify(output())}`],
    [
      "leading zero",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"count","state":"observed","value":{"type":"number","value":01}}]}',
    ],
    [
      "numeric overflow",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"count","state":"observed","value":{"type":"number","value":1e999}}]}',
    ],
    [
      "incomplete number",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"count","state":"observed","value":{"type":"number","value":1.}}]}',
    ],
    [
      "invalid escape",
      '{"schemaVersion":"ProbeObservationsV1","observations":[{"id":"status","state":"observed","value":{"type":"string","value":"\\x41"}}]}',
    ],
    ["unpaired escaped surrogate", JSON.stringify(output("\ud800"))],
    ["unpaired literal surrogate", JSON.stringify(output()).replace("Ready", "\ud800")],
    ["escaped NUL", JSON.stringify(output("\0"))],
    ["literal control", JSON.stringify(output()).replace("Ready", "invalid\ntext")],
    ["too deep", `${"[".repeat(18)}0${"]".repeat(18)}`],
    ["partial document", JSON.stringify(output()).slice(0, -2)],
    ["unterminated escape", '"unfinished\\'],
    ["empty document", ""],
  ])("rejects %s without retaining source bytes", (_name, text) => {
    expect(() => capture(text)).toThrow(
      "The test probe did not provide a complete valid observation document.",
    );
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("rejects missing, unknown, repeated, mistyped, and oversized observations in full", () => {
    const documents: unknown[] = [];
    const missing = output();
    missing.observations.pop();
    documents.push(missing);
    const extra = output();
    extra.observations.push({ id: "foreign", state: "unavailable" });
    documents.push(extra);
    const duplicate = output();
    duplicate.observations[2] = { id: "status", state: "unavailable" };
    documents.push(duplicate);
    const mistyped = output();
    mistyped.observations[0] = {
      id: "status",
      state: "observed",
      value: { type: "boolean", value: false },
    };
    documents.push(mistyped);
    documents.push(output("x".repeat(2_049)));
    documents.push({ ...output(), verdict: "confirmed" });
    documents.push({
      ...output(),
      observations: [{ id: "visible", state: "unavailable", value: false }],
    });
    for (const document of documents) expect(() => capture(JSON.stringify(document))).toThrow();
  });

  it("rejects repeated declarations independently of their descriptions or types", () => {
    const invalid = structuredClone(declaration);
    invalid.fields.push({ id: "status", type: "boolean", description: "Repeated declaration." });
    expect(() =>
      captureTestProbeOutput("profile:measure", JSON.stringify(output()), invalid),
    ).toThrow();
  });

  it("withholds decoded sensitive values and hashes only unavailable output", () => {
    const original = JSON.stringify(output("resolved-private-value")).replace(
      "private",
      "pr\\u0069vate",
    );
    const result = capture(original, ["resolved-private-value"]);
    expect(result.output.observations[0]).toEqual({ id: "status", state: "unavailable" });
    expect(result.outputSha256).toBe(createCanonicalResult(result.output).sha256);
    expect(JSON.stringify(result)).not.toContain("resolved-private-value");
    expect(result.outputSha256).not.toBe(
      createCanonicalResult(output("resolved-private-value")).sha256,
    );
  });

  it("rechecks earlier safe output when later steps resolve a secret", () => {
    const earlier = capture(JSON.stringify(output("later-resolved-value")));
    const final = sanitizeTestProbeCapture(earlier, ["later-resolved-value"]);
    expect(final.output.observations[0]).toEqual({ id: "status", state: "unavailable" });
    expect(final.outputSha256).not.toBe(earlier.outputSha256);
    expect(earlier.output.observations[0]?.state).toBe("observed");
  });

  it.each([
    "[REDACTED]",
    "Authorization: Bearer private-value",
    "Bearer private-value",
    "ghp_abcdefghijklmnop",
    "https://user:password@example.invalid",
    "api_key=private-value",
    "-----BEGIN PRIVATE KEY-----\nprivate-value",
  ])("withholds unsafe text without substituting a value: %s", (text) => {
    expect(capture(JSON.stringify(output(text))).output.observations[0]).toEqual({
      id: "status",
      state: "unavailable",
    });
  });

  it("checks resolved sensitive values in each typed scalar", () => {
    for (const value of [
      { type: "string", value: "12345" },
      { type: "number", value: 12345 },
      { type: "boolean", value: true },
    ] satisfies ObservationValue[]) {
      expect(containsUnsafeObservationValue(value, [String(value.value)])).toBe(true);
    }
  });
});
