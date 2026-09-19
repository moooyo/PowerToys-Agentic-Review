import { win32 } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";

export const e2eDesktopMaximumRequestBytes = 128 * 1_024;
export const e2eDesktopMaximumResultBytes = 4 * 1_024 * 1_024;

const pidSchema = Type.Integer({ minimum: 1, maximum: 4_294_967_295 });
const boundedText = (maximum: number, minimum = 0) =>
  Type.String({ minLength: minimum, maxLength: maximum, pattern: "^[^\\u0000]*$" });
const identitySchema = Type.Object(
  {
    pid: pidSchema,
    creationTimeFileTime: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }),
  },
  { additionalProperties: false },
);
const actionSchema = Type.Union(
  (
    [
      "enumerate",
      "inspect",
      "click",
      "type",
      "keys",
      "assert",
      "screenshot",
      "desktop-status",
    ] as const
  ).map((action) => Type.Literal(action)),
);
const selectorSchema = Type.Object(
  {
    automationId: Type.Optional(boundedText(512, 1)),
    name: Type.Optional(boundedText(1_024, 1)),
    controlType: Type.Optional(boundedText(128, 1)),
    className: Type.Optional(boundedText(512, 1)),
    index: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  },
  { additionalProperties: false },
);

/** The tool server supplies ownership identities; model arguments must not supply this envelope. */
export const E2eDesktopRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("E2eDesktopRequestV1"),
    requestId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
    action: actionSchema,
    ownedProcesses: Type.Array(identitySchema, { maxItems: 128 }),
    target: Type.Optional(
      Type.Object(
        {
          pid: pidSchema,
          windowHandle: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,19}$" })),
          selector: Type.Optional(selectorSchema),
        },
        { additionalProperties: false },
      ),
    ),
    maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 12 })),
    maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    coordinates: Type.Optional(
      Type.Object(
        {
          x: Type.Integer({ minimum: -65_536, maximum: 65_536 }),
          y: Type.Integer({ minimum: -65_536, maximum: 65_536 }),
        },
        { additionalProperties: false },
      ),
    ),
    text: Type.Optional(boundedText(8_192)),
    // Each entry is a chord such as CTRL+A or a key such as ENTER. WIN is unsupported.
    keys: Type.Optional(Type.Array(boundedText(64, 1), { minItems: 1, maxItems: 128 })),
    assertion: Type.Optional(
      Type.Object(
        {
          property: Type.Union(
            (
              ["exists", "text", "value", "enabled", "offscreen", "focused", "toggleState"] as const
            ).map((property) => Type.Literal(property)),
          ),
          expected: Type.Union([boundedText(8_192), Type.Boolean()]),
          match: Type.Optional(Type.Union([Type.Literal("equals"), Type.Literal("contains")])),
        },
        { additionalProperties: false },
      ),
    ),
    artifactPath: Type.Optional(boundedText(32_000, 3)),
  },
  { additionalProperties: false },
);
export type E2eDesktopRequest = Static<typeof E2eDesktopRequestSchema>;
export type E2eOwnedProcess = Static<typeof identitySchema>;
const descendantSchema = Type.Object(
  { ...identitySchema.properties, parentPid: pidSchema, imagePath: boundedText(32_767, 3) },
  { additionalProperties: false },
);
export type E2eOwnedDescendant = Static<typeof descendantSchema>;
export const E2eTargetWindowSchema = Type.Object(
  {
    ...identitySchema.properties,
    windowHandle: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }),
    sessionId: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
    imagePath: boundedText(32_767, 3),
    title: boundedText(1_024),
    className: boundedText(512),
    visible: Type.Boolean(),
    minimized: Type.Boolean(),
    owned: Type.Literal(true),
    bounds: Type.Object(
      {
        x: Type.Integer({ minimum: -2_147_483_648, maximum: 2_147_483_647 }),
        y: Type.Integer({ minimum: -2_147_483_648, maximum: 2_147_483_647 }),
        width: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
        height: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type E2eTargetWindow = Static<typeof E2eTargetWindowSchema>;

export const E2eDesktopResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("E2eDesktopResultV1"),
    requestId: boundedText(128, 1),
    action: actionSchema,
    success: Type.Boolean(),
    code: Type.Union(
      (
        [
          "completed",
          "invalid_request",
          "interactive_session_unavailable",
          "ownership_lost",
          "window_unavailable",
          "ambiguous_window",
          "element_unavailable",
          "ambiguous_element",
          "foreground_unavailable",
          "input_failed",
          "unsupported_control",
          "assertion_failed",
          "artifact_failed",
          "driver_failed",
        ] as const
      ).map((code) => Type.Literal(code)),
    ),
    message: boundedText(2_048, 1),
    observedAt: boundedText(64, 1),
    interactive: Type.Boolean(),
    sessionId: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
    desktopName: Type.Union([boundedText(256), Type.Null()]),
    foreground: Type.Union([
      Type.Object(
        {
          pid: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
          windowHandle: boundedText(20, 1),
          title: boundedText(1_024),
          owned: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    ownedProcessesAlive: Type.Array(identitySchema, { maxItems: 128 }),
    ownedPidsPresent: Type.Array(pidSchema, { maxItems: 128 }),
    ownedProcessStates: Type.Array(
      Type.Object(
        {
          ...identitySchema.properties,
          state: Type.Union(
            (["alive", "exited", "identity_mismatch", "unavailable"] as const).map((state) =>
              Type.Literal(state),
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type E2eDesktopResult = Static<typeof E2eDesktopResultSchema>;

export function parseE2eDesktopRequest(value: unknown): E2eDesktopRequest {
  if (
    !Value.Check(E2eDesktopRequestSchema, value) ||
    !hasWellFormedStrings(value) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > e2eDesktopMaximumRequestBytes
  )
    throw new TypeError("Invalid E2E desktop request.");
  const owners = new Set<number>();
  for (const owner of value.ownedProcesses) {
    if (owners.has(owner.pid) || BigInt(owner.creationTimeFileTime) > 18_446_744_073_709_551_615n)
      throw new TypeError("Invalid E2E desktop process identity.");
    owners.add(owner.pid);
  }
  if (
    value.target !== undefined &&
    (!owners.has(value.target.pid) ||
      (value.target.windowHandle !== undefined &&
        BigInt(value.target.windowHandle) > 9_223_372_036_854_775_807n) ||
      (value.target.selector !== undefined &&
        Object.keys(value.target.selector).every((key) => key === "index")))
  )
    throw new TypeError("The E2E desktop target must identify an owned process and a selector.");
  if (!["enumerate", "desktop-status"].includes(value.action) && value.target === undefined)
    throw new TypeError("This E2E desktop action requires an owned target.");
  const actionFields = {
    coordinates: "click",
    text: "type",
    keys: "keys",
    assertion: "assert",
    artifactPath: "screenshot",
  } as const;
  for (const [field, action] of Object.entries(actionFields)) {
    if (field in value && value.action !== action)
      throw new TypeError(`The ${field} field is not supported by this E2E desktop action.`);
    if (field !== "coordinates" && value.action === action && !(field in value))
      throw new TypeError(`The ${field} field is required by this E2E desktop action.`);
  }
  if (value.coordinates !== undefined && value.target?.selector !== undefined)
    throw new TypeError("An E2E click must choose coordinates or an element selector.");
  if (value.artifactPath !== undefined) {
    assertWindowsLocalAbsolutePath(value.artifactPath, "E2E screenshot artifact", false);
    if (win32.extname(value.artifactPath).toLowerCase() !== ".png")
      throw new TypeError("An E2E screenshot must use a PNG artifact path.");
  }
  if (value.assertion !== undefined) {
    const assertion = value.assertion;
    const booleanProperty = ["exists", "enabled", "offscreen", "focused"].includes(
      assertion.property,
    );
    if (
      (typeof assertion.expected === "boolean") !== booleanProperty ||
      (assertion.match === "contains" &&
        (booleanProperty || assertion.expected === "" || assertion.property === "toggleState")) ||
      (assertion.property === "toggleState" &&
        !["on", "off", "indeterminate"].includes(String(assertion.expected)))
    )
      throw new TypeError("The E2E assertion expectation does not match its property.");
  }
  for (const chord of value.keys ?? []) parseE2eKeyChord(chord);
  return structuredClone(value);
}

export function parseE2eDesktopResult(
  input: string,
  request?: E2eDesktopRequest,
): E2eDesktopResult {
  if (!input.isWellFormed() || Buffer.byteLength(input, "utf8") > e2eDesktopMaximumResultBytes)
    throw new TypeError("E2E desktop output exceeded its bounds.");
  const value: unknown = JSON.parse(input);
  if (
    !Value.Check(E2eDesktopResultSchema, value) ||
    !hasWellFormedStrings(value) ||
    value.success !== (value.code === "completed") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    (request !== undefined &&
      (value.requestId !== request.requestId || value.action !== request.action))
  )
    throw new TypeError("Invalid E2E desktop result.");
  const states = new Map(value.ownedProcessStates.map((owner) => [owner.pid, owner]));
  const present = new Set(value.ownedPidsPresent);
  const alive = new Map(value.ownedProcessesAlive.map((owner) => [owner.pid, owner]));
  const descendants = getE2eOwnedDescendants(value, request);
  const targetWindow = getE2eTargetWindow(value, request);
  if (
    states.size !== value.ownedProcessStates.length ||
    present.size !== value.ownedPidsPresent.length ||
    alive.size !== value.ownedProcessesAlive.length ||
    value.ownedProcessStates.some(
      (owner) =>
        (owner.state === "alive") !== alive.has(owner.pid) ||
        (owner.state === "exited" && present.has(owner.pid)) ||
        ((owner.state === "alive" || owner.state === "identity_mismatch") &&
          !present.has(owner.pid)),
    ) ||
    value.ownedProcessesAlive.some(
      (owner) => states.get(owner.pid)?.creationTimeFileTime !== owner.creationTimeFileTime,
    ) ||
    value.ownedPidsPresent.some((pid) => !states.has(pid)) ||
    (value.foreground?.owned === true &&
      !alive.has(value.foreground.pid) &&
      !descendants.some((owner) => owner.pid === value.foreground?.pid)) ||
    (request !== undefined &&
      (states.size !== request.ownedProcesses.length ||
        request.ownedProcesses.some(
          (owner) => states.get(owner.pid)?.creationTimeFileTime !== owner.creationTimeFileTime,
        )))
  )
    throw new TypeError("The E2E desktop ownership observations are inconsistent.");
  if (
    value.action === "desktop-status" &&
    value.success &&
    value.data.cleanupConfirmed !==
      (present.size === 0 && value.ownedProcessStates.every((owner) => owner.state === "exited"))
  )
    throw new TypeError("The E2E cleanup observation does not match the process identities.");
  if (
    value.action === "screenshot" &&
    value.success &&
    (value.data.mediaType !== "image/png" ||
      !Number.isSafeInteger(value.data.sizeBytes) ||
      (value.data.sizeBytes as number) <= 0 ||
      value.data.pid !== targetWindow?.pid ||
      value.data.windowHandle !== targetWindow?.windowHandle ||
      (request !== undefined &&
        (value.data.artifactPath !== request.artifactPath ||
          value.data.pid !== request.target?.pid)))
  )
    throw new TypeError("The E2E screenshot observation does not match the requested artifact.");
  return value;
}

/** This identity belongs to the actual window resolved before the action, including failed assertions. */
export function getE2eTargetWindow(
  result: E2eDesktopResult,
  request?: E2eDesktopRequest,
): E2eTargetWindow | null {
  const targeted = !["enumerate", "desktop-status"].includes(result.action);
  const raw = result.data.targetWindow;
  if (raw === undefined || raw === null) {
    if (targeted && (result.success || result.code === "assertion_failed"))
      throw new TypeError("The E2E action is missing its actual target window identity.");
    return null;
  }
  if (!targeted || !Value.Check(E2eTargetWindowSchema, raw) || !hasWellFormedStrings(raw))
    throw new TypeError("Invalid E2E target window observation.");
  assertWindowsLocalAbsolutePath(raw.imagePath, "E2E target executable image", true);
  const identity = result.ownedProcessStates.find((owner) => owner.pid === raw.pid);
  if (
    identity?.creationTimeFileTime !== raw.creationTimeFileTime ||
    raw.sessionId !== result.sessionId ||
    BigInt(raw.windowHandle) > 9_223_372_036_854_775_807n ||
    BigInt(raw.creationTimeFileTime) > 18_446_744_073_709_551_615n ||
    (request !== undefined &&
      (request.target === undefined ||
        request.target.pid !== raw.pid ||
        (request.target.windowHandle !== undefined &&
          request.target.windowHandle !== raw.windowHandle)))
  )
    throw new TypeError("The E2E target window identity does not match its request and session.");
  return structuredClone(raw);
}

/** Register these pinned descendants for later requests and include them in final cleanup checks. */
export function getE2eOwnedDescendants(
  result: E2eDesktopResult,
  request?: E2eDesktopRequest,
): E2eOwnedDescendant[] {
  const raw = result.data.ownedDescendants;
  if (raw === undefined) return [];
  if (
    !["enumerate", "inspect"].includes(result.action) ||
    !Value.Check(Type.Array(descendantSchema, { maxItems: 128 }), raw)
  )
    throw new TypeError("Invalid E2E owned descendant observations.");
  const roots = request?.ownedProcesses ?? result.ownedProcessStates;
  const known = new Map(roots.map((owner) => [owner.pid, owner.creationTimeFileTime]));
  for (const descendant of raw) {
    assertWindowsLocalAbsolutePath(descendant.imagePath, "E2E descendant executable image", true);
    const parentCreation = known.get(descendant.parentPid);
    if (
      known.has(descendant.pid) ||
      parentCreation === undefined ||
      BigInt(descendant.creationTimeFileTime) < BigInt(parentCreation) ||
      BigInt(descendant.creationTimeFileTime) > 18_446_744_073_709_551_615n
    )
      throw new TypeError("The E2E descendant parent chain is inconsistent.");
    known.set(descendant.pid, descendant.creationTimeFileTime);
  }
  if (known.size > 128)
    throw new TypeError("The E2E owned process tree exceeded its identity bound.");
  return structuredClone(raw);
}

export interface E2eDesktopLaunchOptions {
  readonly powershellExecutablePath: string;
  readonly driverPath: string;
  readonly requestPath: string;
  readonly resultPath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly processLimits: ProcessResourceLimits;
}

/** The caller must hold the desktop lease and launch ProcessHost in the interactive session. */
export function buildE2eDesktopLaunch(options: E2eDesktopLaunchOptions): ProcessLaunchSpec {
  for (const [name, path] of [
    ["driver", options.driverPath],
    ["request", options.requestPath],
    ["result", options.resultPath],
  ] as const)
    assertWindowsLocalAbsolutePath(path, `E2E desktop ${name} path`, false);
  if (win32.extname(options.driverPath).toLowerCase() !== ".ps1")
    throw new TypeError("The E2E desktop driver must be a PowerShell script.");
  if (
    win32.resolve(options.requestPath).toLowerCase() ===
    win32.resolve(options.resultPath).toLowerCase()
  )
    throw new TypeError("E2E desktop request and result paths must be distinct.");
  const spec: ProcessLaunchSpec = {
    executable: options.powershellExecutablePath,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      options.driverPath,
      "-RequestPath",
      options.requestPath,
      "-ResultPath",
      options.resultPath,
    ],
    workingDirectory: options.workingDirectory,
    environmentMode: "replace",
    environment: { ...options.environment },
    captureProcessIdentity: true,
    limits: { ...options.processLimits },
  };
  assertValidProcessLaunchSpec(spec);
  return spec;
}

export interface E2eVideoLaunchOptions {
  readonly ffmpegExecutablePath: string;
  readonly artifactPath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly processLimits: ProcessResourceLimits;
  /** Physical screen bounds observed for the owned foreground application window. */
  readonly windowBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly durationSeconds: number;
  readonly frameRate?: number;
}

/** Capture observed application bounds; stop through managed stdin with q and a newline. */
export function buildE2eVideoLaunch(options: E2eVideoLaunchOptions): ProcessLaunchSpec {
  assertWindowsLocalAbsolutePath(options.artifactPath, "E2E video artifact", false);
  const frameRate = options.frameRate ?? 12;
  const bounds = options.windowBounds;
  if (
    bounds === undefined ||
    bounds === null ||
    typeof bounds !== "object" ||
    !Number.isInteger(bounds.x) ||
    !Number.isInteger(bounds.y) ||
    Math.abs(bounds.x) > 65_536 ||
    Math.abs(bounds.y) > 65_536 ||
    !Number.isInteger(bounds.width) ||
    !Number.isInteger(bounds.height) ||
    bounds.width < 1 ||
    bounds.height < 1 ||
    bounds.width > 32_768 ||
    bounds.height > 32_768 ||
    bounds.width * bounds.height > 33_554_432
  )
    throw new TypeError("E2E video requires valid observed application window bounds.");
  if (
    win32.extname(options.artifactPath).toLowerCase() !== ".mp4" ||
    !Number.isInteger(options.durationSeconds) ||
    options.durationSeconds < 1 ||
    options.durationSeconds > 120 ||
    !Number.isInteger(frameRate) ||
    frameRate < 1 ||
    frameRate > 30 ||
    options.processLimits.hardTimeoutMs < (options.durationSeconds + 5) * 1_000
  )
    throw new TypeError("E2E video bounds or the managed shutdown allowance are invalid.");
  const bitRate = Math.min(
    1_000_000,
    Math.floor((8 * 8 * 1_024 * 1_024) / options.durationSeconds),
  );
  const spec: ProcessLaunchSpec = {
    executable: options.ffmpegExecutablePath,
    arguments: [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-progress",
      "pipe:1",
      "-stats_period",
      "0.25",
      "-n",
      "-f",
      "gdigrab",
      "-framerate",
      String(frameRate),
      "-draw_mouse",
      "1",
      "-offset_x",
      String(bounds.x),
      "-offset_y",
      String(bounds.y),
      "-video_size",
      `${bounds.width}x${bounds.height}`,
      "-i",
      "desktop",
      "-t",
      String(options.durationSeconds),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      String(bitRate),
      "-maxrate",
      String(bitRate),
      "-bufsize",
      String(bitRate * 2),
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-fs",
      String(9 * 1_024 * 1_024),
      "-f",
      "mp4",
      options.artifactPath,
    ],
    workingDirectory: options.workingDirectory,
    environmentMode: "replace",
    environment: { ...options.environment },
    interactiveStdin: true,
    captureProcessIdentity: true,
    limits: { ...options.processLimits },
  };
  assertValidProcessLaunchSpec(spec);
  return spec;
}

function parseE2eKeyChord(chord: string): void {
  const parts = chord.toUpperCase().split("+");
  const key = parts.pop();
  if (
    key === undefined ||
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|ENTER|TAB|ESC|ESCAPE|BACKSPACE|DELETE|INSERT|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|SPACE)$/.test(
      key,
    ) ||
    parts.some((part) => !["CTRL", "SHIFT", "ALT"].includes(part)) ||
    new Set(parts).size !== parts.length ||
    (parts.includes("ALT") && ["TAB", "ESC", "ESCAPE"].includes(key)) ||
    (parts.includes("CTRL") && ["ESC", "ESCAPE"].includes(key)) ||
    (parts.includes("CTRL") && parts.includes("ALT") && key === "DELETE")
  )
    throw new TypeError("The E2E key chord is unsupported or changes the active desktop.");
}

function hasWellFormedStrings(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(hasWellFormedStrings);
}
