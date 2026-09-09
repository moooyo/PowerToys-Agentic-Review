import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  EntityIdSchema,
  isSafeUiObservationText,
  isUiAssertionAction,
  matchesUiScenarioObservations,
  UiScenarioExecutionEvidenceV1Schema,
  WindowsUiEvidencePolicySchema,
  WindowsUiLaunchSchema,
  WindowsUiScenarioSchema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const windowsDriverMaximumInputBytes = 512 * 1_024;
export const windowsDriverMaximumOutputBytes = 512 * 1_024;
export const windowsDriverMaximumEvidenceBytes = 128 * 1_024 * 1_024;
export const windowsDriverMaximumScreenshotBytes = 16 * 1_024 * 1_024;

// ProcessHost supplies the exact creation FILETIME. JavaScript numbers and ISO millisecond
// timestamps cannot preserve its 100-nanosecond precision and must never identify an owner.
export const WindowsDriverRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WindowsDriverRequestV1"),
    rootProcess: Type.Object(
      {
        pid: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
        creationTimeFileTime: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }),
      },
      { additionalProperties: false },
    ),
    scenario: WindowsUiScenarioSchema,
    readiness: WindowsUiLaunchSchema.properties.readiness,
    evidence: WindowsUiEvidencePolicySchema,
    observationProtocol: Type.Optional(Type.Literal("UiAssertionCaptureV1")),
    // A private Worker evidence directory outside the launched application's worktree.
    evidenceDirectory: Type.String({ minLength: 3, maxLength: 32_000, pattern: "^[^\u0000]*$" }),
  },
  { additionalProperties: false },
);
export type WindowsDriverRequest = Static<typeof WindowsDriverRequestSchema>;

export const WindowsUiObservationProbeResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WindowsUiObservationProbeResultV1"),
    features: Type.Tuple([Type.Literal("uiAssertionObservation1")]),
  },
  { additionalProperties: false },
);
export type WindowsUiObservationProbeResult = Static<typeof WindowsUiObservationProbeResultSchema>;

export function parseWindowsUiObservationProbeResult(
  input: string,
): WindowsUiObservationProbeResult {
  if (!input.isWellFormed() || Buffer.byteLength(input, "utf8") > 4_096)
    throw new TypeError("Windows observation probe output exceeded its bounds.");
  const value: unknown = JSON.parse(input);
  if (!Value.Check(WindowsUiObservationProbeResultSchema, value))
    throw new TypeError("Invalid Windows observation probe result.");
  return value;
}

export const WindowsSessionProbeResultSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal("WindowsSessionProbeResultV1"),
      available: Type.Literal(true),
      sessionId: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
      reasonCode: Type.Literal("ready"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal("WindowsSessionProbeResultV1"),
      available: Type.Literal(false),
      sessionId: Type.Null(),
      reasonCode: Type.Literal("interactive_session_unavailable"),
    },
    { additionalProperties: false },
  ),
]);
export type WindowsSessionProbeResult = Static<typeof WindowsSessionProbeResultSchema>;
export const WindowsTcpOwnerProbeResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WindowsTcpOwnerProbeResultV1"),
    rootProcess: WindowsDriverRequestSchema.properties.rootProcess,
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    owned: Type.Boolean(),
    reasonCode: Type.Union(
      [
        "owned",
        "not_listening",
        "ownership_lost",
        "ambiguous_listener",
        "unowned_listener",
        "probe_unavailable",
      ].map((code) => Type.Literal(code)),
    ),
  },
  { additionalProperties: false },
);
export type WindowsTcpOwnerProbeResult = Static<typeof WindowsTcpOwnerProbeResultSchema>;

export function parseWindowsSessionProbeResult(input: string): WindowsSessionProbeResult {
  if (Buffer.byteLength(input, "utf8") > 4_096)
    throw new TypeError("Session probe output exceeded its bounds.");
  const value: unknown = JSON.parse(input);
  if (!Value.Check(WindowsSessionProbeResultSchema, value))
    throw new TypeError("Invalid session probe result.");
  return value;
}

export function parseWindowsTcpOwnerProbeResult(
  input: string,
  rootProcess: WindowsDriverRequest["rootProcess"],
  port: number,
): WindowsTcpOwnerProbeResult {
  if (Buffer.byteLength(input, "utf8") > 4_096)
    throw new TypeError("TCP probe output exceeded its bounds.");
  const value: unknown = JSON.parse(input);
  if (
    !Value.Check(WindowsTcpOwnerProbeResultSchema, value) ||
    value.port !== port ||
    value.rootProcess.pid !== rootProcess.pid ||
    value.rootProcess.creationTimeFileTime !== rootProcess.creationTimeFileTime ||
    value.owned !== (value.reasonCode === "owned")
  )
    throw new TypeError("Invalid owned TCP probe result.");
  return value;
}

const ReasonCodeSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("assertion_failed"),
  Type.Literal("action_failed"),
  Type.Literal("interactive_session_unavailable"),
  Type.Literal("ownership_lost"),
  Type.Literal("window_unavailable"),
  Type.Literal("ambiguous_window"),
  Type.Literal("ambiguous_locator"),
  Type.Literal("unsupported_control"),
  Type.Literal("provider_unavailable"),
  Type.Literal("scenario_timeout"),
  Type.Literal("evidence_failed"),
]);

export const WindowsDriverResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WindowsDriverResultV1"),
    scenarioId: EntityIdSchema,
    outcome: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("blocked"),
      Type.Literal("inconclusive"),
    ]),
    reasonCode: ReasonCodeSchema,
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    evidenceComplete: Type.Boolean(),
    execution: UiScenarioExecutionEvidenceV1Schema,
    evidenceFiles: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          relativePath: Type.String({
            pattern: "^windows-[a-f0-9-]+/[a-f0-9-]+\\.(png|json)$",
            maxLength: 128,
          }),
          kind: Type.Union([Type.Literal("screenshot"), Type.Literal("ui_steps")]),
          mediaType: Type.Union([Type.Literal("image/png"), Type.Literal("application/json")]),
          sizeBytes: Type.Integer({ minimum: 1, maximum: windowsDriverMaximumScreenshotBytes }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 34 },
    ),
  },
  { additionalProperties: false },
);
export type WindowsDriverResult = Static<typeof WindowsDriverResultSchema>;

export function parseWindowsDriverRequest(value: unknown): WindowsDriverRequest {
  if (!Value.Check(WindowsDriverRequestSchema, value)) {
    throw new TypeError("Invalid Windows driver request.");
  }
  const serialized = JSON.stringify(value);
  if (
    !hasWellFormedStrings(value) ||
    Buffer.byteLength(serialized, "utf8") > windowsDriverMaximumInputBytes ||
    BigInt(value.rootProcess.creationTimeFileTime) > 18_446_744_073_709_551_615n ||
    !win32.isAbsolute(value.evidenceDirectory) ||
    !/^[A-Za-z]:[\\/]/u.test(value.evidenceDirectory) ||
    [...value.evidenceDirectory].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError("Windows driver identity, paths, or input bounds are invalid.");
  }
  const identifiers = new Set([value.scenario.id]);
  let assertions = 0;
  for (const step of value.scenario.steps) {
    if (
      value.observationProtocol !== undefined &&
      ((step.action === "fill" && !isSafeUiObservationText(step.value)) ||
        ("expected" in step &&
          typeof step.expected === "string" &&
          !isSafeUiObservationText(step.expected)))
    )
      throw new TypeError("Mapped Windows UI inputs cannot contain protected values.");
    if (identifiers.has(step.id) || step.timeoutMs > value.scenario.timeoutMs) {
      throw new TypeError("Windows scenario step identifiers and budgets are invalid.");
    }
    identifiers.add(step.id);
    if (isUiAssertionAction(step.action)) assertions += 1;
    if (step.action === "assertText" && step.match === "contains" && step.expected.length === 0) {
      throw new TypeError("A text assertion cannot search for an empty value.");
    }
  }
  if (assertions === 0) throw new TypeError("A Windows scenario requires an assertion.");
  return value;
}

function hasWellFormedStrings(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(hasWellFormedStrings);
}

// The caller still finalizes file hashes, original source state, process shutdown, and reset.
// A valid driver result alone never makes the enclosing ReviewRun eligible for approval.
export function parseWindowsDriverResult(
  input: string,
  request: WindowsDriverRequest,
): WindowsDriverResult {
  parseWindowsDriverRequest(request);
  if (!input.isWellFormed() || Buffer.byteLength(input, "utf8") > windowsDriverMaximumOutputBytes) {
    throw new TypeError("Windows driver output exceeded its protocol bounds.");
  }
  const result: unknown = JSON.parse(input);
  if (!Value.Check(WindowsDriverResultSchema, result) || !hasWellFormedStrings(result)) {
    throw new TypeError("Invalid Windows driver result.");
  }
  if (
    result.scenarioId !== request.scenario.id ||
    result.execution.scenarioId !== request.scenario.id ||
    result.execution.target !== "windows_desktop" ||
    !matchesUiScenarioObservations(request.scenario.steps, result.execution.steps, {
      requireCapture: request.observationProtocol === "UiAssertionCaptureV1",
    })
  ) {
    throw new TypeError("Windows driver result does not match the assigned scenario.");
  }
  const assets = new Map(result.evidenceFiles.map((asset) => [asset.id, asset]));
  const paths = new Set(result.evidenceFiles.map((asset) => asset.relativePath));
  const directories = new Set(
    result.evidenceFiles.map((asset) => asset.relativePath.split("/")[0]),
  );
  if (
    assets.size !== result.evidenceFiles.length ||
    paths.size !== assets.size ||
    directories.size > 1 ||
    result.evidenceFiles.reduce((size, asset) => size + asset.sizeBytes, 0) >
      windowsDriverMaximumEvidenceBytes
  ) {
    throw new TypeError("Windows driver evidence manifest is inconsistent.");
  }
  for (const asset of assets.values()) {
    const suffix = asset.kind === "screenshot" ? ".png" : ".json";
    const mediaType = asset.kind === "screenshot" ? "image/png" : "application/json";
    if (
      !asset.relativePath.endsWith(`/${asset.id}${suffix}`) ||
      asset.mediaType !== mediaType ||
      (asset.kind === "ui_steps" && asset.sizeBytes > windowsDriverMaximumOutputBytes)
    ) {
      throw new TypeError("Windows evidence identifiers, types, and paths must agree.");
    }
  }
  const referencedScreenshots = new Set<string>();
  for (const [index, planned] of request.scenario.steps.entries()) {
    const observed = result.execution.steps[index];
    if (
      observed === undefined ||
      observed.stepId !== planned.id ||
      observed.name !== planned.name ||
      observed.action !== planned.action ||
      observed.expected !== ("expected" in planned ? planned.expected : null) ||
      observed.evidenceIds.some((id) => assets.get(id)?.kind !== "screenshot") ||
      observed.evidenceIds.length > 1 ||
      (observed.outcome === "not_run" && observed.evidenceIds.length !== 0) ||
      (request.observationProtocol === undefined && "capture" in observed)
    ) {
      throw new TypeError("Windows driver step evidence does not match the planned operation.");
    }
    for (const id of observed.evidenceIds) {
      if (referencedScreenshots.has(id)) {
        throw new TypeError(
          "A Windows screenshot cannot be reused as a different step observation.",
        );
      }
      referencedScreenshots.add(id);
    }
    if (
      result.evidenceComplete &&
      observed.outcome !== "not_run" &&
      ((request.evidence.screenshots === "every_assertion" &&
        isUiAssertionAction(planned.action)) ||
        observed.outcome !== "passed") &&
      observed.evidenceIds.length === 0
    ) {
      throw new TypeError("Required Windows screenshot evidence is missing.");
    }
  }
  const stepAssets = result.evidenceFiles.filter((asset) => asset.kind === "ui_steps");
  const stepAsset = stepAssets[0];
  if (stepAssets.length > 1) throw new TypeError("Windows step evidence must be unique.");
  if (stepAsset !== undefined && request.observationProtocol !== undefined) {
    const execution = Buffer.from(JSON.stringify(result.execution), "utf8");
    if (
      stepAsset.sizeBytes !== execution.byteLength ||
      stepAsset.sha256 !== createHash("sha256").update(execution).digest("hex")
    )
      throw new TypeError("Windows step evidence does not bind the complete observation document.");
  }
  const unassignedScreenshots = result.evidenceFiles.filter(
    (asset) => asset.kind === "screenshot" && !referencedScreenshots.has(asset.id),
  );
  const firstFailure = result.execution.steps.find((step) => step.outcome !== "passed");
  if (
    unassignedScreenshots.length > (result.outcome === "passed" ? 0 : 1) ||
    (request.observationProtocol !== undefined &&
      !result.evidenceComplete &&
      referencedScreenshots.size + unassignedScreenshots.length !== 0) ||
    (result.evidenceComplete && stepAssets.length !== 1) ||
    (result.outcome === "passed" &&
      (result.reasonCode !== "completed" ||
        !result.evidenceComplete ||
        result.execution.steps.some((step) => step.outcome !== "passed"))) ||
    (result.outcome !== "passed" && result.reasonCode === "completed") ||
    (result.outcome === "failed" && firstFailure?.outcome !== "failed") ||
    (result.reasonCode === "assertion_failed" &&
      (result.outcome !== "failed" ||
        firstFailure === undefined ||
        !isUiAssertionAction(firstFailure.action) ||
        (request.observationProtocol !== undefined &&
          (!("capture" in firstFailure) || firstFailure.capture?.state !== "complete")))) ||
    (result.reasonCode === "action_failed" &&
      (result.outcome !== "failed" ||
        firstFailure === undefined ||
        isUiAssertionAction(firstFailure.action)))
  ) {
    throw new TypeError("Windows driver completion state is inconsistent.");
  }
  return result;
}
