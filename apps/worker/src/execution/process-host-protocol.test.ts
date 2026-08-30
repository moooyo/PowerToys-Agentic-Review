import { describe, expect, it } from "vitest";
import {
  encodeProcessHostRequest,
  ProcessHostProtocolError,
  type ProcessHostRequest,
  type ProcessLaunchSpec,
  parseProcessHostEventFrame,
  processHostMaximumFrameBytes,
  processHostMaximumStandardInputBytes,
  processHostProtocolVersion,
  processHostResourceBounds,
} from "./process-host-protocol.js";

const launchSpec = (): ProcessLaunchSpec => ({
  executable: "C:\\Program Files\\Codex\\codex.exe",
  arguments: ["exec", "-"],
  workingDirectory: "C:\\AgenticReview\\jobs\\one",
  environmentMode: "replace",
  environment: { SystemRoot: "C:\\Windows" },
  standardInput: "Review this revision.",
  limits: {
    hardTimeoutMs: 60_000,
    maximumProcessCount: 16,
    maximumMemoryBytes: 1_073_741_824,
    maximumOutputBytes: 1_048_576,
  },
});

const startRequest = (spec: ProcessLaunchSpec = launchSpec()): ProcessHostRequest => ({
  protocolVersion: processHostProtocolVersion,
  type: "start",
  requestId: "process:one",
  spec,
});

describe("ProcessHost NDJSON contract", () => {
  it("encodes one strict newline-delimited request", () => {
    const request = startRequest();

    const encoded = encodeProcessHostRequest(request);

    expect(encoded.at(-1)).toBe(0x0a);
    expect(JSON.parse(encoded.subarray(0, -1).toString("utf8"))).toEqual(request);
  });

  it("parses the exact ready handshake and rejects unknown fields", () => {
    const ready = {
      protocolVersion: processHostProtocolVersion,
      type: "ready",
      processHostPid: 4242,
      capabilities: {
        concurrentRequests: true,
        maximumConcurrentRequests: 4,
        maximumFrameBytes: processHostMaximumFrameBytes,
      },
    } as const;

    expect(parseProcessHostEventFrame(Buffer.from(JSON.stringify(ready)))).toEqual(ready);
    expect(() =>
      parseProcessHostEventFrame(Buffer.from(JSON.stringify({ ...ready, extra: true }))),
    ).toThrow(ProcessHostProtocolError);
    for (const maximumConcurrentRequests of [0, 65]) {
      expect(() =>
        parseProcessHostEventFrame(
          Buffer.from(
            JSON.stringify({
              ...ready,
              capabilities: { ...ready.capabilities, maximumConcurrentRequests },
            }),
          ),
        ),
      ).toThrow(ProcessHostProtocolError);
    }
  });

  it("rejects unknown event types, malformed JSON, invalid UTF-8, and oversized frames", () => {
    expect(() =>
      parseProcessHostEventFrame(
        Buffer.from(
          JSON.stringify({ protocolVersion: processHostProtocolVersion, type: "future_event" }),
        ),
      ),
    ).toThrow(ProcessHostProtocolError);
    expect(() => parseProcessHostEventFrame(Buffer.from("{", "utf8"))).toThrow(
      ProcessHostProtocolError,
    );
    expect(() => parseProcessHostEventFrame(Uint8Array.from([0xc3, 0x28]))).toThrow(
      ProcessHostProtocolError,
    );
    expect(() =>
      parseProcessHostEventFrame(Buffer.alloc(processHostMaximumFrameBytes + 1, 0x20)),
    ).toThrow(ProcessHostProtocolError);
  });

  it("requires replacement environments and every resource limit", () => {
    const invalid = {
      protocolVersion: processHostProtocolVersion,
      type: "start",
      requestId: "process:one",
      spec: {
        ...launchSpec(),
        environmentMode: "inherit",
        limits: { hardTimeoutMs: 60_000 },
      },
    } as unknown as ProcessHostRequest;

    expect(() => encodeProcessHostRequest(invalid)).toThrow(ProcessHostProtocolError);
  });

  it("accepts readonly launch arguments and rejects case-insensitive environment duplicates", () => {
    const readonlySpec = {
      ...launchSpec(),
      arguments: Object.freeze(["exec", "-"] as const),
    } satisfies ProcessLaunchSpec;
    const readonlyRequest = {
      protocolVersion: processHostProtocolVersion,
      type: "start",
      requestId: "process:readonly",
      spec: readonlySpec,
    } satisfies ProcessHostRequest;
    expect(() => encodeProcessHostRequest(readonlyRequest)).not.toThrow();

    expect(() =>
      encodeProcessHostRequest(
        startRequest({
          ...launchSpec(),
          environment: { Path: "C:\\Tools", PATH: "C:\\Windows" },
        }),
      ),
    ).toThrow(/collide case-insensitively/u);
  });

  it("accepts the exact resource boundaries", () => {
    const minimums = Object.fromEntries(
      Object.entries(processHostResourceBounds).map(([name, bounds]) => [name, bounds.minimum]),
    ) as unknown as ProcessLaunchSpec["limits"];
    const maximums = Object.fromEntries(
      Object.entries(processHostResourceBounds).map(([name, bounds]) => [name, bounds.maximum]),
    ) as unknown as ProcessLaunchSpec["limits"];

    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), limits: minimums })),
    ).not.toThrow();
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), limits: maximums })),
    ).not.toThrow();
  });

  it.each([
    ["hardTimeoutMs", 9_999],
    ["hardTimeoutMs", 7_200_001],
    ["maximumProcessCount", 0],
    ["maximumProcessCount", 257],
    ["maximumMemoryBytes", 134_217_727],
    ["maximumMemoryBytes", 68_719_476_737],
    ["maximumOutputBytes", 4_095],
    ["maximumOutputBytes", 134_217_729],
  ] as const)("rejects out-of-range %s=%s", (name, value) => {
    const spec = launchSpec();
    const limits = { ...spec.limits, [name]: value };
    expect(() => encodeProcessHostRequest(startRequest({ ...spec, limits }))).toThrow(
      ProcessHostProtocolError,
    );
  });

  it("enforces the standard input limit in UTF-8 bytes", () => {
    const exact = `${"\u754c".repeat(Math.floor(processHostMaximumStandardInputBytes / 3))}${"a".repeat(
      processHostMaximumStandardInputBytes % 3,
    )}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(processHostMaximumStandardInputBytes);
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), standardInput: exact })),
    ).not.toThrow();
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), standardInput: `${exact}\u754c` })),
    ).toThrow(/UTF-8 bytes/u);
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), standardInput: "review\uD800" })),
    ).toThrow(/well-formed Unicode/u);
  });

  it("rejects malformed Unicode in arguments and environment values", () => {
    expect(() =>
      encodeProcessHostRequest(
        startRequest({ ...launchSpec(), arguments: ["exec", "review\uD800"] }),
      ),
    ).toThrow(/well-formed Unicode/u);
    expect(() =>
      encodeProcessHostRequest(
        startRequest({ ...launchSpec(), environment: { PATH: "C:\\Tools\uDFFF" } }),
      ),
    ).toThrow(/well-formed Unicode/u);
  });

  it.each([
    "codex.exe",
    "\\\\server\\share\\codex.exe",
    "\\\\?\\C:\\Tools\\codex.exe",
    "C:\\Tools\\codex.com",
    "C:\\Tools\\.\\codex.exe",
    "C:\\Tools\\..\\codex.exe",
    "C:\\Tools\\codex.exe:payload",
    "C:\\Tools.\\codex.exe",
    "C:\\Tools\\co?dex.exe",
    "C:\\Tools\\CON.exe",
    "C:\\NUL\\codex.exe",
  ])("rejects unsafe executable path %s", (executable) => {
    expect(() => encodeProcessHostRequest(startRequest({ ...launchSpec(), executable }))).toThrow(
      ProcessHostProtocolError,
    );
  });

  it.each([
    "jobs\\one",
    "C:\\Jobs\\..\\Secrets",
    "C:\\Jobs\\report:stream",
    "C:\\Jobs \\one",
    "C:\\Jobs\\LPT1",
  ])("rejects unsafe working directory %s", (workingDirectory) => {
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), workingDirectory })),
    ).toThrow(ProcessHostProtocolError);
  });
});
