import type { Readable } from "node:stream";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const processHostProtocolVersion = "1.0" as const;
export const processHostMaximumFrameBytes = 1_048_576;
export const processHostMaximumStandardInputBytes = 512 * 1_024;
export const processHostInteractiveStdinCapability = Object.freeze({
  version: 1,
  maximumChunkBytes: 65_536,
  maximumTotalBytes: 8_388_608,
  maximumOperations: 1_024,
  maximumPendingOperations: 1,
  writeTimeoutMs: 10_000,
} as const);

export const ProcessHostInteractiveStdinCapabilitySchema = Type.Object(
  {
    version: Type.Literal(processHostInteractiveStdinCapability.version),
    maximumChunkBytes: Type.Literal(processHostInteractiveStdinCapability.maximumChunkBytes),
    maximumTotalBytes: Type.Literal(processHostInteractiveStdinCapability.maximumTotalBytes),
    maximumOperations: Type.Literal(processHostInteractiveStdinCapability.maximumOperations),
    maximumPendingOperations: Type.Literal(
      processHostInteractiveStdinCapability.maximumPendingOperations,
    ),
    writeTimeoutMs: Type.Literal(processHostInteractiveStdinCapability.writeTimeoutMs),
  },
  { additionalProperties: false },
);
export type ProcessHostInteractiveStdinCapability = Static<
  typeof ProcessHostInteractiveStdinCapabilitySchema
>;

export const processHostResourceBounds = Object.freeze({
  hardTimeoutMs: Object.freeze({ minimum: 10_000, maximum: 2 * 60 * 60 * 1_000 }),
  maximumProcessCount: Object.freeze({ minimum: 1, maximum: 256 }),
  maximumMemoryBytes: Object.freeze({
    minimum: 128 * 1_024 * 1_024,
    maximum: 64 * 1_024 * 1_024 * 1_024,
  }),
  maximumOutputBytes: Object.freeze({
    minimum: 4 * 1_024,
    maximum: 128 * 1_024 * 1_024,
  }),
});

const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const requestIdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const textWithoutNulPattern = "^[^\\u0000]*$";
const environmentNamePattern = "^[^=\\u0000-\\u001f\\u007f-\\u009f]{1,128}(?![\\s\\S])";
const base64Pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const maximumUnsignedFileTime = 18_446_744_073_709_551_615n;

const RequestIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: requestIdPattern });
const BoundedTextSchema = Type.String({
  minLength: 1,
  maxLength: 32_767,
  pattern: textWithoutNulPattern,
});
const NonNegativeSafeIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: maximumSafeInteger,
});
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: maximumSafeInteger });
const StdinRequestIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])",
});
const StdinStreamIdSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}(?![\\s\\S])",
});

export const ProcessResourceLimitsSchema = Type.Object(
  {
    hardTimeoutMs: Type.Integer(processHostResourceBounds.hardTimeoutMs),
    maximumProcessCount: Type.Integer(processHostResourceBounds.maximumProcessCount),
    maximumMemoryBytes: Type.Integer(processHostResourceBounds.maximumMemoryBytes),
    maximumOutputBytes: Type.Integer(processHostResourceBounds.maximumOutputBytes),
  },
  { additionalProperties: false },
);
export type ProcessResourceLimits = Static<typeof ProcessResourceLimitsSchema>;

export const ProcessLaunchSpecSchema = Type.Object(
  {
    executable: BoundedTextSchema,
    arguments: Type.Array(Type.String({ maxLength: 32_767, pattern: textWithoutNulPattern }), {
      maxItems: 1_024,
    }),
    workingDirectory: BoundedTextSchema,
    environmentMode: Type.Literal("replace"),
    environment: Type.Record(
      Type.String({ minLength: 1, maxLength: 128, pattern: environmentNamePattern }),
      Type.String({ maxLength: 32_767, pattern: textWithoutNulPattern }),
      { maxProperties: 512, additionalProperties: false },
    ),
    standardInput: Type.Optional(
      Type.String({
        maxLength: processHostMaximumStandardInputBytes,
        pattern: textWithoutNulPattern,
      }),
    ),
    interactiveStdin: Type.Optional(Type.Literal(true)),
    captureProcessIdentity: Type.Optional(Type.Literal(true)),
    limits: ProcessResourceLimitsSchema,
  },
  { additionalProperties: false },
);
type RuntimeProcessLaunchSpec = Static<typeof ProcessLaunchSpecSchema>;
export type ProcessLaunchSpec = Readonly<Omit<RuntimeProcessLaunchSpec, "arguments">> & {
  readonly arguments: readonly string[];
};

export const ProcessTerminationReasonSchema = Type.Union([
  Type.Literal("cancelled"),
  Type.Literal("lease_lost"),
  Type.Literal("stale"),
  Type.Literal("timeout"),
  Type.Literal("worker_shutdown"),
]);
export type ProcessTerminationReason = Static<typeof ProcessTerminationReasonSchema>;

export const ProcessHostStartRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("start"),
    requestId: RequestIdSchema,
    spec: ProcessLaunchSpecSchema,
  },
  { additionalProperties: false },
);

export const ProcessHostTerminateRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("terminate"),
    requestId: RequestIdSchema,
    reason: ProcessTerminationReasonSchema,
  },
  { additionalProperties: false },
);

export const ProcessHostShutdownRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("shutdown"),
    requestId: RequestIdSchema,
  },
  { additionalProperties: false },
);

const processStdinOperationProperties = {
  protocolVersion: Type.Literal(processHostProtocolVersion),
  requestId: StdinRequestIdSchema,
  stdinStreamId: StdinStreamIdSchema,
  sequence: PositiveSafeIntegerSchema,
} as const;

export const ProcessHostStdinWriteRequestSchema = Type.Object(
  {
    ...processStdinOperationProperties,
    type: Type.Literal("stdin_write"),
    dataBase64: Type.String({
      minLength: 4,
      maxLength: Math.ceil(processHostInteractiveStdinCapability.maximumChunkBytes / 3) * 4,
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\\s\\S])",
    }),
  },
  { additionalProperties: false },
);
export type ProcessHostStdinWriteRequest = Readonly<
  Static<typeof ProcessHostStdinWriteRequestSchema>
>;

export const ProcessHostStdinCloseRequestSchema = Type.Object(
  { ...processStdinOperationProperties, type: Type.Literal("stdin_close") },
  { additionalProperties: false },
);
export type ProcessHostStdinCloseRequest = Readonly<
  Static<typeof ProcessHostStdinCloseRequestSchema>
>;
export type ProcessHostStdinRequest = ProcessHostStdinWriteRequest | ProcessHostStdinCloseRequest;

export const ProcessStdinFailureCodeSchema = Type.Union([
  Type.Literal("STDIN_NOT_ENABLED"),
  Type.Literal("STDIN_PROCESS_NOT_FOUND"),
  Type.Literal("STDIN_PROCESS_NOT_RUNNING"),
  Type.Literal("STDIN_STREAM_MISMATCH"),
  Type.Literal("STDIN_SEQUENCE_MISMATCH"),
  Type.Literal("STDIN_BUSY"),
  Type.Literal("STDIN_CLOSED"),
  Type.Literal("STDIN_LIMIT_EXCEEDED"),
  Type.Literal("STDIN_PROCESS_EXITED"),
  Type.Literal("STDIN_WRITE_FAILED"),
  Type.Literal("STDIN_WRITE_TIMEOUT"),
  Type.Literal("STDIN_CLOSE_FAILED"),
  Type.Literal("STDIN_CANCELLED"),
]);
export type ProcessStdinFailureCode = Static<typeof ProcessStdinFailureCodeSchema>;

export const ProcessStdinResultEventSchema = Type.Object(
  {
    ...processStdinOperationProperties,
    type: Type.Literal("stdin_result"),
    operation: Type.Union([Type.Literal("write"), Type.Literal("close")]),
    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
    bytesWritten: Type.Integer({
      minimum: 0,
      maximum: processHostInteractiveStdinCapability.maximumChunkBytes,
    }),
    code: Type.Union([Type.Null(), ProcessStdinFailureCodeSchema]),
  },
  { additionalProperties: false },
);
export type ProcessStdinResultEvent = Static<typeof ProcessStdinResultEventSchema>;

export const ProcessHostRequestSchema = Type.Union([
  ProcessHostStartRequestSchema,
  ProcessHostTerminateRequestSchema,
  ProcessHostShutdownRequestSchema,
  ProcessHostStdinWriteRequestSchema,
  ProcessHostStdinCloseRequestSchema,
]);
export type ProcessHostStartRequest = Readonly<
  Omit<Static<typeof ProcessHostStartRequestSchema>, "spec">
> & {
  readonly spec: ProcessLaunchSpec;
};
export type ProcessHostRequest =
  | ProcessHostStartRequest
  | ProcessHostStdinRequest
  | Readonly<Static<typeof ProcessHostTerminateRequestSchema>>
  | Readonly<Static<typeof ProcessHostShutdownRequestSchema>>;

export const ProcessHostReadyEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("ready"),
    processHostPid: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
    capabilities: Type.Object(
      {
        concurrentRequests: Type.Literal(true),
        maximumConcurrentRequests: Type.Integer({ minimum: 1, maximum: 64 }),
        maximumFrameBytes: Type.Literal(processHostMaximumFrameBytes),
        interactiveStdin: Type.Optional(ProcessHostInteractiveStdinCapabilitySchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProcessStartedEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("started"),
    requestId: RequestIdSchema,
    processId: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
    stdinStreamId: Type.Optional(StdinStreamIdSchema),
    processCreationTimeFileTime: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: "^[1-9][0-9]{0,19}(?![\\s\\S])",
      }),
    ),
  },
  { additionalProperties: false },
);

const processOutputProperties = {
  protocolVersion: Type.Literal(processHostProtocolVersion),
  requestId: RequestIdSchema,
  sequence: NonNegativeSafeIntegerSchema,
  dataBase64: Type.String({
    minLength: 4,
    maxLength: processHostMaximumFrameBytes,
    pattern: base64Pattern,
  }),
} as const;

export const ProcessStdoutEventSchema = Type.Object(
  { ...processOutputProperties, type: Type.Literal("stdout") },
  { additionalProperties: false },
);

export const ProcessStderrEventSchema = Type.Object(
  { ...processOutputProperties, type: Type.Literal("stderr") },
  { additionalProperties: false },
);

export const ProcessOutputTruncatedEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("output_truncated"),
    requestId: RequestIdSchema,
    sequence: NonNegativeSafeIntegerSchema,
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("combined")]),
    discardedBytes: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const ProcessTerminatedEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("terminated"),
    requestId: RequestIdSchema,
    reason: ProcessTerminationReasonSchema,
  },
  { additionalProperties: false },
);

export const ProcessExitedEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("exited"),
    requestId: RequestIdSchema,
    exitCode: Type.Union([
      Type.Integer({ minimum: -2_147_483_648, maximum: 4_294_967_295 }),
      Type.Null(),
    ]),
    signal: Type.Union([
      Type.String({ minLength: 1, maxLength: 128, pattern: textWithoutNulPattern }),
      Type.Null(),
    ]),
    outputTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ProcessHostErrorEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("error"),
    requestId: Type.Union([RequestIdSchema, Type.Null()]),
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Z][A-Z0-9_]*$" }),
    message: Type.String({ minLength: 1, maxLength: 2_048, pattern: textWithoutNulPattern }),
  },
  { additionalProperties: false },
);

export const ProcessHostShutdownCompleteEventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(processHostProtocolVersion),
    type: Type.Literal("shutdown_complete"),
    requestId: RequestIdSchema,
  },
  { additionalProperties: false },
);

export const ProcessHostEventSchema = Type.Union([
  ProcessHostReadyEventSchema,
  ProcessStartedEventSchema,
  ProcessStdoutEventSchema,
  ProcessStderrEventSchema,
  ProcessOutputTruncatedEventSchema,
  ProcessTerminatedEventSchema,
  ProcessExitedEventSchema,
  ProcessHostErrorEventSchema,
  ProcessHostShutdownCompleteEventSchema,
  ProcessStdinResultEventSchema,
]);
export type ProcessHostEvent = Static<typeof ProcessHostEventSchema>;
export type ProcessHostReadyEvent = Static<typeof ProcessHostReadyEventSchema>;
export type ProcessOutputEvent =
  | Static<typeof ProcessStdoutEventSchema>
  | Static<typeof ProcessStderrEventSchema>;
export type ProcessOutputTruncatedEvent = Static<typeof ProcessOutputTruncatedEventSchema>;
export type ProcessTerminatedEvent = Static<typeof ProcessTerminatedEventSchema>;
export type ProcessExitedEvent = Static<typeof ProcessExitedEventSchema>;
export type ProcessHostErrorEvent = Static<typeof ProcessHostErrorEventSchema>;
export type ProcessHostShutdownCompleteEvent = Static<
  typeof ProcessHostShutdownCompleteEventSchema
>;

export class ProcessHostProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessHostProtocolError";
  }
}

export function assertValidProcessLaunchSpec(spec: unknown): asserts spec is ProcessLaunchSpec {
  assertSchema(ProcessLaunchSpecSchema, spec, "ProcessHost launch spec");
  if (spec.interactiveStdin === true && Object.hasOwn(spec, "standardInput")) {
    throw new ProcessHostProtocolError(
      "Interactive ProcessHost input must not include spec.standardInput.",
    );
  }
  assertWindowsLocalAbsolutePath(spec.executable, "spec.executable", true);
  assertWindowsLocalAbsolutePath(spec.workingDirectory, "spec.workingDirectory", false);
  for (const [index, argument] of spec.arguments.entries()) {
    assertWellFormedUnicode(argument, `spec.arguments[${index}]`);
  }
  const environmentNames = new Map<string, string>();
  for (const [name, value] of Object.entries(spec.environment)) {
    assertWellFormedUnicode(name, "spec.environment variable name");
    const folded = name.toUpperCase();
    const previous = environmentNames.get(folded);
    if (previous !== undefined) {
      throw new ProcessHostProtocolError(
        `spec.environment names ${JSON.stringify(previous)} and ${JSON.stringify(name)} collide case-insensitively.`,
      );
    }
    environmentNames.set(folded, name);
    assertWellFormedUnicode(value, `spec.environment.${name}`);
  }
  if (spec.standardInput !== undefined) {
    assertWellFormedUnicode(spec.standardInput, "spec.standardInput");
    const byteLength = Buffer.byteLength(spec.standardInput, "utf8");
    if (byteLength > processHostMaximumStandardInputBytes) {
      throw new ProcessHostProtocolError(
        `spec.standardInput must not exceed ${processHostMaximumStandardInputBytes} UTF-8 bytes.`,
      );
    }
  }
}

export function encodeProcessHostRequest(request: ProcessHostRequest): Buffer {
  assertSchema(ProcessHostRequestSchema, request, "ProcessHost request");
  if (request.type === "start") {
    assertValidProcessLaunchSpec(request.spec);
  } else if (request.type === "stdin_write") {
    stdinWriteByteCount(request);
  }
  const serialized = Buffer.from(JSON.stringify(request), "utf8");
  if (serialized.byteLength > processHostMaximumFrameBytes) {
    throw new ProcessHostProtocolError(
      `ProcessHost request exceeds the ${processHostMaximumFrameBytes}-byte frame limit.`,
    );
  }
  return Buffer.concat([serialized, Buffer.from("\n", "ascii")]);
}

export function parseProcessHostEventFrame(frame: Uint8Array): ProcessHostEvent {
  if (frame.byteLength === 0) {
    throw new ProcessHostProtocolError("ProcessHost emitted an empty NDJSON frame.");
  }
  if (frame.byteLength > processHostMaximumFrameBytes) {
    throw new ProcessHostProtocolError(
      `ProcessHost frame exceeds the ${processHostMaximumFrameBytes}-byte limit.`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch (error) {
    throw new ProcessHostProtocolError("ProcessHost emitted invalid UTF-8.", { cause: error });
  }
  if (text.endsWith("\r")) {
    text = text.slice(0, -1);
  }
  if (text.length === 0) {
    throw new ProcessHostProtocolError("ProcessHost emitted an empty NDJSON frame.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
    assertUnambiguousJson(text);
  } catch (error) {
    throw new ProcessHostProtocolError("ProcessHost emitted malformed JSON.", { cause: error });
  }
  assertSchema(ProcessHostEventSchema, value, "ProcessHost event");
  if (
    value.type === "started" &&
    value.processCreationTimeFileTime !== undefined &&
    BigInt(value.processCreationTimeFileTime) > maximumUnsignedFileTime
  ) {
    throw new ProcessHostProtocolError("ProcessHost process creation FILETIME exceeds uint64.");
  }
  if (value.type === "stdin_result") assertValidProcessStdinResult(value);
  return value;
}

function stdinWriteByteCount(request: ProcessHostStdinWriteRequest): number {
  const bytes = Buffer.from(request.dataBase64, "base64");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > processHostInteractiveStdinCapability.maximumChunkBytes ||
    bytes.toString("base64") !== request.dataBase64
  ) {
    throw new ProcessHostProtocolError(
      "ProcessHost stdin data must be canonical padded base64 within the chunk byte limit.",
    );
  }
  return bytes.byteLength;
}

const stdinAdmissionFailureCodes = new Set<ProcessStdinFailureCode>([
  "STDIN_NOT_ENABLED",
  "STDIN_PROCESS_NOT_FOUND",
  "STDIN_PROCESS_NOT_RUNNING",
  "STDIN_STREAM_MISMATCH",
  "STDIN_SEQUENCE_MISMATCH",
  "STDIN_BUSY",
  "STDIN_CLOSED",
  "STDIN_LIMIT_EXCEEDED",
]);

/** Pipe completion is not application acceptance or permission to replay an operation. */
export function assertValidProcessStdinResult(
  value: unknown,
  request?: ProcessHostStdinRequest,
): asserts value is ProcessStdinResultEvent {
  assertSchema(ProcessStdinResultEventSchema, value, "ProcessHost stdin result");
  if (
    (value.operation === "close" && value.bytesWritten !== 0) ||
    (value.status === "succeeded" &&
      (value.code !== null || (value.operation === "write" && value.bytesWritten === 0))) ||
    (value.status === "failed" &&
      (value.code === null ||
        (stdinAdmissionFailureCodes.has(value.code) && value.bytesWritten !== 0) ||
        (value.operation === "close" &&
          (value.code === "STDIN_WRITE_FAILED" || value.code === "STDIN_WRITE_TIMEOUT")) ||
        (value.operation === "write" && value.code === "STDIN_CLOSE_FAILED")))
  ) {
    throw new ProcessHostProtocolError(
      "ProcessHost stdin result has inconsistent operation facts.",
    );
  }
  if (request === undefined) return;
  assertSchema(
    Type.Union([ProcessHostStdinWriteRequestSchema, ProcessHostStdinCloseRequestSchema]),
    request,
    "ProcessHost stdin request",
  );
  const operation = request.type === "stdin_write" ? "write" : "close";
  const requestedBytes = request.type === "stdin_write" ? stdinWriteByteCount(request) : 0;
  if (
    value.requestId !== request.requestId ||
    value.stdinStreamId !== request.stdinStreamId ||
    value.sequence !== request.sequence ||
    value.operation !== operation ||
    value.bytesWritten > requestedBytes ||
    (value.status === "succeeded" && value.bytesWritten !== requestedBytes)
  ) {
    throw new ProcessHostProtocolError(
      "ProcessHost stdin result does not match its exact request.",
    );
  }
}

/** JSON.parse alone loses duplicate identities, including keys written with Unicode escapes. */
function assertUnambiguousJson(text: string): void {
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && /[\t\r\n ]/u.test(text[offset] ?? "")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === "\\") offset += 2;
      else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error("Unterminated JSON string.");
  };
  const visit = (depth: number): void => {
    if (depth > 64) throw new Error("JSON nesting exceeds the ProcessHost protocol limit.");
    whitespace();
    const opening = text[offset];
    if (opening === '"') {
      string();
    } else if (opening === "{" || opening === "[") {
      offset++;
      whitespace();
      const closing = opening === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (text[offset] !== closing) {
        for (;;) {
          if (opening === "{") {
            const key = string();
            if (keys.has(key)) throw new Error("Duplicate JSON property.");
            keys.add(key);
            whitespace();
            offset++;
          }
          visit(depth + 1);
          whitespace();
          if (text[offset] !== ",") break;
          offset++;
          whitespace();
        }
      }
      offset++;
    } else {
      while (offset < text.length && !/[,\]}\t\r\n ]/u.test(text[offset] ?? "")) offset++;
    }
  };
  visit(0);
}

export function assertWindowsLocalAbsolutePath(
  value: string,
  name: string,
  requireExecutable: boolean,
): void {
  assertWellFormedUnicode(value, name);
  if (value.length > 32_767) {
    throw new ProcessHostProtocolError(`${name} must not exceed 32767 UTF-16 code units.`);
  }
  if (!/^[A-Za-z]:[\\/]/u.test(value)) {
    throw new ProcessHostProtocolError(`${name} must be an absolute drive-qualified Windows path.`);
  }
  if (value.slice(2).includes(":")) {
    throw new ProcessHostProtocolError(`${name} must not contain an alternate data stream.`);
  }

  const components = value.slice(3).split(/[\\/]/u);
  for (const component of components) {
    if (component.length === 0) continue;
    if (component === "." || component === "..") {
      throw new ProcessHostProtocolError(`${name} must not contain relative path components.`);
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      throw new ProcessHostProtocolError(`${name} path components must not end in a dot or space.`);
    }
    for (const character of component) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 32 || '<>"|?*'.includes(character)) {
        throw new ProcessHostProtocolError(`${name} contains an invalid Windows path character.`);
      }
    }
    if (isReservedWindowsDeviceName(component)) {
      throw new ProcessHostProtocolError(`${name} contains a reserved Windows device name.`);
    }
  }

  if (requireExecutable && !value.toLowerCase().endsWith(".exe")) {
    throw new ProcessHostProtocolError(`${name} must end in .exe.`);
  }
}

function isReservedWindowsDeviceName(component: string): boolean {
  const baseName = component.split(".", 1)[0]?.toUpperCase() ?? "";
  return (
    baseName === "CON" ||
    baseName === "PRN" ||
    baseName === "AUX" ||
    baseName === "NUL" ||
    baseName === "CONIN$" ||
    baseName === "CONOUT$" ||
    baseName === "CLOCK$" ||
    /^COM[1-9]$/u.test(baseName) ||
    /^LPT[1-9]$/u.test(baseName)
  );
}

function assertWellFormedUnicode(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new ProcessHostProtocolError(`${name} must contain well-formed Unicode.`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ProcessHostProtocolError(`${name} must contain well-formed Unicode.`);
    }
  }
}

function assertSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  description: string,
): asserts value is Static<T> {
  if (Value.Check(schema, value)) {
    return;
  }
  const firstError = Value.Errors(schema, value).First();
  const detail = firstError === undefined ? "unknown schema violation" : firstError.message;
  const path = firstError?.path === undefined || firstError.path === "" ? "/" : firstError.path;
  throw new ProcessHostProtocolError(
    `${description} failed schema validation at ${path}: ${detail}`,
  );
}

export interface ManagedProcessStandardInput {
  readonly streamId: string;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface ManagedProcess {
  readonly requestId: string;
  readonly processId: number;
  /** Exact Windows creation FILETIME, supplied only for explicitly requested process identity. */
  readonly processCreationTimeFileTime?: string;
  readonly stdin?: ManagedProcessStandardInput;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completed: Promise<ProcessExitedEvent>;
  terminate(reason: ProcessTerminationReason): Promise<void>;
}

export interface ProcessHostClient {
  start(spec: ProcessLaunchSpec, signal: AbortSignal): Promise<ManagedProcess>;
  terminateAll(reason: ProcessTerminationReason): Promise<void>;
  close(): Promise<void>;
}

export class UnavailableProcessHostClient implements ProcessHostClient {
  public async start(_spec: ProcessLaunchSpec, _signal: AbortSignal): Promise<ManagedProcess> {
    throw new Error("ProcessHost integration is not available in this worker build.");
  }

  public async terminateAll(_reason: ProcessTerminationReason): Promise<void> {
    await Promise.resolve();
  }

  public async close(): Promise<void> {
    await Promise.resolve();
  }
}
