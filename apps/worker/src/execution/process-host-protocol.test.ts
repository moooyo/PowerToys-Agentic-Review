import { describe, expect, it } from "vitest";
import {
  assertValidProcessLaunchSpec,
  assertValidProcessStdinResult,
  encodeProcessHostRequest,
  ProcessHostProtocolError,
  type ProcessHostRequest,
  type ProcessHostStdinCloseRequest,
  type ProcessHostStdinWriteRequest,
  type ProcessLaunchSpec,
  type ProcessStdinResultEvent,
  parseProcessHostEventFrame,
  processHostInteractiveStdinCapability,
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

const stdinStreamId = "a".repeat(64);
const stdinWrite = (dataBase64 = Buffer.from("{}\n").toString("base64")) =>
  ({
    protocolVersion: processHostProtocolVersion,
    type: "stdin_write",
    requestId: "process:interactive",
    stdinStreamId,
    sequence: 1,
    dataBase64,
  }) satisfies ProcessHostStdinWriteRequest;
const stdinClose = () =>
  ({
    protocolVersion: processHostProtocolVersion,
    type: "stdin_close",
    requestId: "process:interactive",
    stdinStreamId,
    sequence: 2,
  }) satisfies ProcessHostStdinCloseRequest;
const stdinResult = (
  overrides: Partial<ProcessStdinResultEvent> = {},
): ProcessStdinResultEvent => ({
  protocolVersion: processHostProtocolVersion,
  type: "stdin_result",
  requestId: "process:interactive",
  stdinStreamId,
  sequence: 1,
  operation: "write",
  status: "succeeded",
  bytesWritten: 3,
  code: null,
  ...overrides,
});
const frame = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

describe("opt-in ProcessHost interactive stdin protocol", () => {
  it("advertises only the frozen extension values without changing the protocol version", () => {
    expect(processHostProtocolVersion).toBe("1.0");
    expect(processHostInteractiveStdinCapability).toEqual({
      version: 1,
      maximumChunkBytes: 65536,
      maximumTotalBytes: 8388608,
      maximumOperations: 1024,
      maximumPendingOperations: 1,
      writeTimeoutMs: 10000,
    });
    expect(Object.isFrozen(processHostInteractiveStdinCapability)).toBe(true);
    const ready = {
      protocolVersion: processHostProtocolVersion,
      type: "ready",
      processHostPid: 4242,
      capabilities: {
        concurrentRequests: true,
        maximumConcurrentRequests: 4,
        maximumFrameBytes: processHostMaximumFrameBytes,
        interactiveStdin: processHostInteractiveStdinCapability,
      },
    };
    expect(parseProcessHostEventFrame(frame(ready))).toEqual(ready);
    for (const [key, value] of Object.entries(processHostInteractiveStdinCapability)) {
      for (const replacement of [value + 1, undefined, String(value), null]) {
        expect(() =>
          parseProcessHostEventFrame(
            frame({
              ...ready,
              capabilities: {
                ...ready.capabilities,
                interactiveStdin: { ...processHostInteractiveStdinCapability, [key]: replacement },
              },
            }),
          ),
        ).toThrow(ProcessHostProtocolError);
      }
    }
    for (const interactiveStdin of [true, false, null, {}, []]) {
      expect(() =>
        parseProcessHostEventFrame(
          frame({ ...ready, capabilities: { ...ready.capabilities, interactiveStdin } }),
        ),
      ).toThrow(ProcessHostProtocolError);
    }
    expect(() =>
      parseProcessHostEventFrame(
        frame({
          ...ready,
          capabilities: {
            ...ready.capabilities,
            interactiveStdin: { ...processHostInteractiveStdinCapability, extra: true },
          },
        }),
      ),
    ).toThrow(ProcessHostProtocolError);
  });

  it("opts into an open input pipe without changing any other launch field", () => {
    const { standardInput: _standardInput, ...base } = launchSpec();
    const spec = { ...base, interactiveStdin: true as const };
    expect(() => assertValidProcessLaunchSpec(spec)).not.toThrow();
    const encoded = JSON.parse(encodeProcessHostRequest(startRequest(spec)).toString("utf8"));
    expect(encoded.spec).toEqual(spec);
    expect(encoded.spec).not.toHaveProperty("standardInput");
    expect(
      JSON.parse(encodeProcessHostRequest(startRequest()).toString("utf8")).spec,
    ).not.toHaveProperty("interactiveStdin");
  });

  it.each(["", "payload", undefined])(
    "rejects interactive input with standardInput %j",
    (value) => {
      expect(() =>
        encodeProcessHostRequest(
          startRequest({
            ...launchSpec(),
            interactiveStdin: true,
            standardInput: value,
          } as unknown as ProcessLaunchSpec),
        ),
      ).toThrow(ProcessHostProtocolError);
    },
  );

  it.each([false, null, 1, "true", {}])(
    "rejects a non-opt-in interactive input flag %j",
    (flag) => {
      const { standardInput: _standardInput, ...base } = launchSpec();
      expect(() =>
        encodeProcessHostRequest(
          startRequest({ ...base, interactiveStdin: flag } as unknown as ProcessLaunchSpec),
        ),
      ).toThrow(ProcessHostProtocolError);
    },
  );

  it("preserves a started stream identity alongside optional exact process identity", () => {
    const started = {
      protocolVersion: processHostProtocolVersion,
      type: "started",
      requestId: "process:interactive",
      processId: 5001,
      processCreationTimeFileTime: "18446744073709551615",
      stdinStreamId,
    };
    expect(parseProcessHostEventFrame(frame(started))).toEqual(started);
    for (const invalid of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      `${stdinStreamId}\n`,
      null,
    ]) {
      expect(() =>
        parseProcessHostEventFrame(frame({ ...started, stdinStreamId: invalid })),
      ).toThrow(ProcessHostProtocolError);
    }
  });

  it.each([1, 2, 3, 65_535, 65_536])(
    "encodes a canonical %s-byte chunk without changing its bytes",
    (size) => {
      const bytes = Buffer.alloc(size, 0xff);
      const request = stdinWrite(bytes.toString("base64"));
      const decoded = JSON.parse(encodeProcessHostRequest(request).toString("utf8"));
      expect(decoded).toEqual(request);
      expect(Buffer.from(decoded.dataBase64, "base64")).toEqual(bytes);
    },
  );

  it.each(["", "Zg", "Zg=", "Zh==", "Zm9=", " Zg==", "Zg==\n", "____", "Zg===", "Zg==Zg=="])(
    "rejects noncanonical or empty base64 %j",
    (dataBase64) => {
      expect(() => encodeProcessHostRequest(stdinWrite(dataBase64))).toThrow(
        ProcessHostProtocolError,
      );
    },
  );

  it("enforces the decoded chunk limit even when encoded length has not increased", () => {
    const valid = Buffer.alloc(65_536).toString("base64");
    const invalid = Buffer.alloc(65_537).toString("base64");
    expect(invalid.length).toBe(valid.length);
    expect(() => encodeProcessHostRequest(stdinWrite(invalid))).toThrow(ProcessHostProtocolError);
  });

  it.each([
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: "process:interactive\n" },
    { stdinStreamId: "a".repeat(63) },
    { stdinStreamId: "A".repeat(64) },
    { extra: true },
    { protocolVersion: "2.0" },
  ])("rejects malformed operation identity or shape %#", (overrides) => {
    expect(() =>
      encodeProcessHostRequest({ ...stdinWrite(), ...overrides } as ProcessHostRequest),
    ).toThrow(ProcessHostProtocolError);
  });

  it("encodes close with no payload and leaves lifetime budgets to the owner", () => {
    expect(JSON.parse(encodeProcessHostRequest(stdinClose()).toString("utf8"))).toEqual(
      stdinClose(),
    );
    expect(() => encodeProcessHostRequest({ ...stdinClose(), sequence: 1025 })).not.toThrow();
    expect(() =>
      encodeProcessHostRequest({ ...stdinClose(), dataBase64: "" } as ProcessHostRequest),
    ).toThrow(ProcessHostProtocolError);
  });

  it("accepts successful write and EOF only when they match the exact submitted operation", () => {
    const write = stdinResult();
    expect(parseProcessHostEventFrame(frame(write))).toEqual(write);
    expect(() => assertValidProcessStdinResult(write, stdinWrite())).not.toThrow();
    const close = stdinResult({ operation: "close", sequence: 2, bytesWritten: 0 });
    expect(parseProcessHostEventFrame(frame(close))).toEqual(close);
    expect(() => assertValidProcessStdinResult(close, stdinClose())).not.toThrow();
  });

  it.each([
    "STDIN_NOT_ENABLED",
    "STDIN_PROCESS_NOT_FOUND",
    "STDIN_PROCESS_NOT_RUNNING",
    "STDIN_STREAM_MISMATCH",
    "STDIN_SEQUENCE_MISMATCH",
    "STDIN_BUSY",
    "STDIN_CLOSED",
    "STDIN_LIMIT_EXCEEDED",
  ] as const)("requires zero observed bytes for admission rejection %s", (code) => {
    const event = stdinResult({ status: "failed", bytesWritten: 0, code });
    expect(parseProcessHostEventFrame(frame(event))).toEqual(event);
    expect(() => assertValidProcessStdinResult(event, stdinWrite())).not.toThrow();
    expect(() => parseProcessHostEventFrame(frame({ ...event, bytesWritten: 1 }))).toThrow(
      ProcessHostProtocolError,
    );
  });

  it.each([
    "STDIN_PROCESS_EXITED",
    "STDIN_WRITE_FAILED",
    "STDIN_WRITE_TIMEOUT",
    "STDIN_CANCELLED",
  ] as const)("retains exact observed partial bytes for %s", (code) => {
    for (const bytesWritten of [0, 1, 2, 3]) {
      const event = stdinResult({ status: "failed", bytesWritten, code });
      expect(parseProcessHostEventFrame(frame(event))).toEqual(event);
      expect(() => assertValidProcessStdinResult(event, stdinWrite())).not.toThrow();
    }
    expect(() =>
      assertValidProcessStdinResult(
        stdinResult({ status: "failed", bytesWritten: 4, code }),
        stdinWrite(),
      ),
    ).toThrow(ProcessHostProtocolError);
  });

  it("retains a close failure with zero written bytes", () => {
    const event = stdinResult({
      operation: "close",
      sequence: 2,
      status: "failed",
      bytesWritten: 0,
      code: "STDIN_CLOSE_FAILED",
    });
    expect(parseProcessHostEventFrame(frame(event))).toEqual(event);
    expect(() => assertValidProcessStdinResult(event, stdinClose())).not.toThrow();
  });

  it.each([
    { bytesWritten: 0 },
    { bytesWritten: 65_537 },
    { bytesWritten: -1 },
    { bytesWritten: 0.5 },
    { code: "STDIN_BUSY" },
    { status: "failed" },
    { status: "failed", code: "UNKNOWN" },
    { status: "failed", code: "STDIN_CLOSE_FAILED" },
    { operation: "close" },
    { operation: "close", bytesWritten: 0, status: "failed", code: "STDIN_WRITE_FAILED" },
    { operation: "close", bytesWritten: 0, status: "failed", code: "STDIN_WRITE_TIMEOUT" },
    { sequence: 0 },
    { stdinStreamId: "a".repeat(63) },
    { requestId: "process:interactive\n" },
    { extra: true },
  ])("rejects an impossible stdin result %#", (overrides) => {
    expect(() => parseProcessHostEventFrame(frame({ ...stdinResult(), ...overrides }))).toThrow(
      ProcessHostProtocolError,
    );
  });

  it.each([
    { requestId: "process:other" },
    { stdinStreamId: "b".repeat(64) },
    { sequence: 2 },
    { bytesWritten: 2 },
    { operation: "close", bytesWritten: 0 },
  ] satisfies Partial<ProcessStdinResultEvent>[])(
    "rejects a valid result for a different request %#",
    (overrides) => {
      const value = stdinResult(overrides);
      expect(() => assertValidProcessStdinResult(value)).not.toThrow();
      expect(() => assertValidProcessStdinResult(value, stdinWrite())).toThrow(
        ProcessHostProtocolError,
      );
    },
  );

  it.each([
    '{"type":"ready","type":"stdin_result"}',
    '{"type":"ready","t\\u0079pe":"stdin_result"}',
    '{"capabilities":{"interactiveStdin":{"version":1,"version":1}}}',
    '{"nested":[{"same":1,"s\\u0061me":2}]}',
  ])("rejects ambiguous JSON before interpreting an extension frame %#", (value) => {
    expect(() => parseProcessHostEventFrame(Buffer.from(value))).toThrow(ProcessHostProtocolError);
  });

  it("rejects duplicate identities in an otherwise valid event, including hidden extension fields", () => {
    const valid = JSON.stringify(stdinResult());
    for (const duplicate of [
      valid.replace('"sequence":1', '"sequence":9,"sequence":1'),
      valid.replace('"stdinStreamId":', '"stdinStreamId":"foreign","stdinStreamId":'),
      valid.replace('"type":', '"type":"started","type":'),
      valid.replace('"requestId":', '"requestId":"foreign","requestId":'),
    ])
      expect(() => parseProcessHostEventFrame(Buffer.from(duplicate))).toThrow(
        ProcessHostProtocolError,
      );
  });
});

const startRequest = (spec: ProcessLaunchSpec = launchSpec()): ProcessHostRequest => ({
  protocolVersion: processHostProtocolVersion,
  type: "start",
  requestId: "process:one",
  spec,
});

describe("ProcessHost NDJSON contract", () => {
  it("accepts optional resource observations without changing legacy exit events", () => {
    const exited = {
      protocolVersion: processHostProtocolVersion,
      type: "exited",
      requestId: "process:usage",
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    };
    expect(parseProcessHostEventFrame(frame(exited))).toEqual(exited);
    for (const resourceUsage of [
      { peakJobMemoryBytes: 0 },
      { peakProcessMemoryBytes: Number.MAX_SAFE_INTEGER },
      {
        peakJobMemoryBytes: 500,
        peakProcessMemoryBytes: 300,
        activeProcesses: { sampledPeak: 2, sampleCount: 10, sampleIntervalMs: 250 },
      },
    ])
      expect(parseProcessHostEventFrame(frame({ ...exited, resourceUsage }))).toEqual({
        ...exited,
        resourceUsage,
      });
    for (const resourceUsage of [
      {},
      null,
      { peakJobMemoryBytes: -1 },
      { peakProcessMemoryBytes: Number.MAX_SAFE_INTEGER + 1 },
      { peakJobMemoryBytes: "100" },
      { activeProcesses: { sampledPeak: 1, sampleCount: 0, sampleIntervalMs: 250 } },
      { activeProcesses: { sampledPeak: -1, sampleCount: 1, sampleIntervalMs: 250 } },
      { activeProcesses: { sampledPeak: 1, sampleCount: 1, sampleIntervalMs: 100 } },
      { activeProcesses: { sampledPeak: 1, sampleCount: 1 } },
      { peakJobMemoryBytes: 10, limitTriggered: true },
    ])
      expect(() => parseProcessHostEventFrame(frame({ ...exited, resourceUsage }))).toThrow(
        ProcessHostProtocolError,
      );
  });

  it("encodes resource capture only as an explicit opt-in", () => {
    expect(
      JSON.parse(encodeProcessHostRequest(startRequest()).toString("utf8")).spec,
    ).not.toHaveProperty("captureResourceUsage");
    expect(
      JSON.parse(
        encodeProcessHostRequest(
          startRequest({ ...launchSpec(), captureResourceUsage: true }),
        ).toString("utf8"),
      ).spec.captureResourceUsage,
    ).toBe(true);
    for (const captureResourceUsage of [false, null, 0, "true", {}])
      expect(() =>
        encodeProcessHostRequest(
          startRequest({ ...launchSpec(), captureResourceUsage } as unknown as ProcessLaunchSpec),
        ),
      ).toThrow(ProcessHostProtocolError);
  });

  it("encodes one strict newline-delimited request", () => {
    const request = startRequest();

    const encoded = encodeProcessHostRequest(request);

    expect(encoded.at(-1)).toBe(0x0a);
    expect(JSON.parse(encoded.subarray(0, -1).toString("utf8"))).toEqual(request);
  });

  it("keeps process identity absent on legacy launches and encodes only an explicit opt-in", () => {
    const ordinary = JSON.parse(encodeProcessHostRequest(startRequest()).toString("utf8"));
    expect(ordinary.spec).not.toHaveProperty("captureProcessIdentity");
    const optedIn = JSON.parse(
      encodeProcessHostRequest(
        startRequest({
          ...launchSpec(),
          captureProcessIdentity: true,
        }),
      ).toString("utf8"),
    );
    expect(optedIn.spec.captureProcessIdentity).toBe(true);
    expect(optedIn.spec.arguments).toEqual(ordinary.spec.arguments);
    expect(optedIn.spec.environment).toEqual(ordinary.spec.environment);
  });

  it.each([false, null, 0, 1, "true", {}])(
    "rejects a non-opt-in identity control value %j",
    (captureProcessIdentity) => {
      expect(() =>
        encodeProcessHostRequest(
          startRequest({
            ...launchSpec(),
            captureProcessIdentity,
          } as unknown as ProcessLaunchSpec),
        ),
      ).toThrow(ProcessHostProtocolError);
    },
  );

  it.each(["1", "133801632001234567", "18446744073709551615"])(
    "preserves exact positive uint64 process creation FILETIME %s",
    (processCreationTimeFileTime) => {
      const event = {
        protocolVersion: processHostProtocolVersion,
        type: "started",
        requestId: "process:identity",
        processId: 5001,
        processCreationTimeFileTime,
      };
      expect(parseProcessHostEventFrame(Buffer.from(JSON.stringify(event)))).toEqual(event);
    },
  );

  it.each([
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "1\n",
    "1\r\n",
    "1\0",
    "18446744073709551616",
    "99999999999999999999",
    "100000000000000000000",
    "\u0661",
    1,
    null,
  ])(
    "rejects a malformed or overflowing process creation FILETIME %j",
    (processCreationTimeFileTime) => {
      expect(() =>
        parseProcessHostEventFrame(
          Buffer.from(
            JSON.stringify({
              protocolVersion: processHostProtocolVersion,
              type: "started",
              requestId: "process:identity",
              processId: 5001,
              processCreationTimeFileTime,
            }),
          ),
        ),
      ).toThrow(ProcessHostProtocolError);
    },
  );

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

  it("preserves Windows host environment names and configured CLI tokens", () => {
    const environment = {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
      "env-with-dash": "value",
      "env.with.dot": "value",
      "\u914d\u7f6e": "value",
      CLI_TOKEN: "synthetic-cli-token",
      EMPTY: "",
    };
    const frame = encodeProcessHostRequest(startRequest({ ...launchSpec(), environment }));
    expect(JSON.parse(frame.toString("utf8")).spec.environment).toEqual(environment);
  });

  it.each(["X".repeat(128), "\u{1f680}".repeat(64)])(
    "accepts an environment name at the 128 UTF-16 unit boundary",
    (name) => {
      expect(() =>
        encodeProcessHostRequest(
          startRequest({ ...launchSpec(), environment: { [name]: "value" } }),
        ),
      ).not.toThrow();
    },
  );

  it.each([
    "",
    "BAD=NAME",
    "BAD\0NAME",
    "BAD\nNAME",
    "BAD\u007fNAME",
    "BAD\u0085NAME",
    "BAD\uD800NAME",
    "x".repeat(129),
    "\u{1f680}".repeat(65),
  ])("rejects invalid Windows environment name %j", (name) => {
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), environment: { [name]: "value" } })),
    ).toThrow(ProcessHostProtocolError);
  });

  it("accepts 512 host environment entries and rejects an additional entry", () => {
    const environment = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [`ENV_${index}`, "value"]),
    );
    expect(() =>
      encodeProcessHostRequest(startRequest({ ...launchSpec(), environment })),
    ).not.toThrow();
    expect(() =>
      encodeProcessHostRequest(
        startRequest({ ...launchSpec(), environment: { ...environment, EXTRA_ENV: "value" } }),
      ),
    ).toThrow(ProcessHostProtocolError);
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
