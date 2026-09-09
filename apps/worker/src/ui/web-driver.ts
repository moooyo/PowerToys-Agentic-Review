import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  EntityIdSchema,
  isSafeUiObservationText,
  isUiAssertionAction,
  matchesUiScenarioObservations,
  resolveManagedWebUiUrl,
  type UiAssertionCaptureUnavailableReason,
  type UiScenarioExecutionEvidenceV1,
  UiScenarioExecutionEvidenceV1Schema,
  type UiStepExecutionEvidence,
  WebUiConfigurationSchema,
  WebUiEvidencePolicySchema,
  type WebUiLocator,
  WebUiScenarioSchema,
  type WebUiScenarioStep,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BrowserContext, Frame, Locator, Page, Route, WebSocketRoute } from "playwright-core";

export const webDriverMaximumInputBytes = 512 * 1_024;
export const webDriverMaximumOutputBytes = 512 * 1_024;
export const webDriverMaximumEvidenceBytes = 128 * 1_024 * 1_024;
const maximumScreenshotBytes = 16 * 1_024 * 1_024;
const maximumTraceBytes = 64 * 1_024 * 1_024;
const finalizationTimeoutMs = 10_000;

const AbsolutePathSchema = Type.String({
  minLength: 1,
  maxLength: 32_767,
  pattern: "^[^\\u0000]*$",
});
export const WebDriverRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WebDriverRequestV1"),
    servicePort: Type.Integer({ minimum: 1, maximum: 65_535 }),
    scenario: WebUiScenarioSchema,
    browser: WebUiConfigurationSchema.properties.browser,
    evidence: WebUiEvidencePolicySchema,
    // Both paths are supplied by Worker configuration, never by the profile or model.
    browserExecutablePath: AbsolutePathSchema,
    evidenceDirectory: AbsolutePathSchema,
    observationProtocol: Type.Optional(Type.Literal("UiAssertionCaptureV1")),
  },
  { additionalProperties: false },
);
export type WebDriverRequest = Static<typeof WebDriverRequestSchema>;

export const WebUiObservationProbeRequestSchema = Type.Object(
  { schemaVersion: Type.Literal("WebUiObservationProbeRequestV1") },
  { additionalProperties: false },
);
export const WebUiObservationProbeResult = {
  schemaVersion: "WebUiObservationProbeResultV1",
  features: ["uiAssertionObservation1"],
} as const;
const WebUiObservationProbeResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WebUiObservationProbeResultV1"),
    features: Type.Tuple([Type.Literal("uiAssertionObservation1")]),
  },
  { additionalProperties: false },
);

export function parseWebUiObservationProbeResult(
  output: string,
): Static<typeof WebUiObservationProbeResultSchema> {
  if (!output.isWellFormed() || Buffer.byteLength(output, "utf8") > 1_024)
    throw new TypeError("Invalid Web observation capability probe result.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new TypeError("Invalid Web observation capability probe result.");
  }
  if (!Value.Check(WebUiObservationProbeResultSchema, parsed))
    throw new TypeError("Invalid Web observation capability probe result.");
  return parsed;
}

const ReasonCodeSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("assertion_failed"),
  Type.Literal("action_failed"),
  Type.Literal("navigation_failed"),
  Type.Literal("origin_violation"),
  Type.Literal("unsupported_redirect"),
  Type.Literal("unsupported_popup"),
  Type.Literal("unsupported_websocket"),
  Type.Literal("scenario_timeout"),
  Type.Literal("aborted"),
  Type.Literal("browser_unavailable"),
  Type.Literal("evidence_failed"),
  Type.Literal("cleanup_failed"),
  Type.Literal("progress_failed"),
  Type.Literal("observation_unavailable"),
]);
type ReasonCode = Static<typeof ReasonCodeSchema>;
const OutcomeSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("inconclusive"),
]);
type Outcome = Static<typeof OutcomeSchema>;

export const WebDriverResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("WebDriverResultV1"),
    scenarioId: EntityIdSchema,
    outcome: OutcomeSchema,
    reasonCode: ReasonCodeSchema,
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
    browserVersion: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    evidenceComplete: Type.Boolean(),
    execution: UiScenarioExecutionEvidenceV1Schema,
    evidenceFiles: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          relativePath: Type.String({
            pattern: "^web-[a-f0-9-]+/[a-f0-9-]+\\.(png|zip|json)$",
            maxLength: 128,
          }),
          kind: Type.Union([
            Type.Literal("screenshot"),
            Type.Literal("trace"),
            Type.Literal("ui_steps"),
          ]),
          mediaType: Type.Union([
            Type.Literal("image/png"),
            Type.Literal("application/zip"),
            Type.Literal("application/json"),
          ]),
          sizeBytes: Type.Integer({ minimum: 1, maximum: maximumTraceBytes }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 35 },
    ),
  },
  { additionalProperties: false },
);
export type WebDriverResult = Static<typeof WebDriverResultSchema>;
type EvidenceFile = WebDriverResult["evidenceFiles"][number];

// This small structural interface permits deterministic unit tests while the entry injects the
// installed Playwright Chromium implementation. Production calls this only inside ProcessHost.
export interface WebDriverBrowser {
  version(): string;
  newContext(
    options: Parameters<import("playwright-core").Browser["newContext"]>[0],
  ): Promise<WebDriverContext>;
  close(): Promise<void>;
}
export interface WebDriverContext {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
  routeWebSocket(url: string, handler: (route: WebSocketRoute) => void): Promise<unknown>;
  on(event: "page", listener: (page: Page) => void): unknown;
  newPage(): Promise<WebDriverPage>;
  tracing: Pick<BrowserContext["tracing"], "start" | "stop">;
  close(): Promise<void>;
}
export interface WebDriverPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  url(): string;
  mainFrame(): Frame;
  on(event: "framenavigated", listener: (frame: Frame) => void): unknown;
  getByRole(
    role: Parameters<Page["getByRole"]>[0],
    options: { name: string; exact: true; includeHidden: true },
  ): WebDriverLocator;
  getByTestId(testId: string): WebDriverLocator;
  screenshot(options: {
    path?: string;
    type: "png";
    fullPage: false;
    timeout: number;
  }): Promise<Buffer>;
}
export type WebDriverLocator = Pick<
  Locator,
  "count" | "click" | "fill" | "isVisible" | "innerText" | "inputValue"
>;
export interface WebDriverLauncher {
  launch(options: {
    executablePath: string;
    headless: true;
    timeout: number;
    handleSIGINT: false;
    handleSIGTERM: false;
    handleSIGHUP: false;
    downloadsPath: string;
    tracesDir: string;
  }): Promise<WebDriverBrowser>;
}
export interface WebDriverDependencies {
  readonly chromium: WebDriverLauncher;
  readonly signal: AbortSignal;
  readonly onStepCompleted?: (event: WebDriverStepCompleted) => void | Promise<void>;
}

export const WebDriverStepCompletedEventSchema = Type.Object(
  {
    type: Type.Literal("ui_step_completed"),
    scenarioId: EntityIdSchema,
    stepId: EntityIdSchema,
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  },
  { additionalProperties: false },
);
export type WebDriverStepCompletedEvent = Static<typeof WebDriverStepCompletedEventSchema>;
export type WebDriverStepCompleted = Omit<WebDriverStepCompletedEvent, "type">;

export function serializeWebDriverStepCompleted(event: WebDriverStepCompleted): string {
  const value: WebDriverStepCompletedEvent = {
    type: "ui_step_completed",
    scenarioId: event.scenarioId,
    stepId: event.stepId,
    outcome: event.outcome,
  };
  if (!Value.Check(WebDriverStepCompletedEventSchema, value))
    throw new TypeError("Invalid completed UI step event.");
  return JSON.stringify(value);
}

class DriverFailure extends Error {
  public constructor(
    public readonly code: ReasonCode,
    public readonly outcome: Exclude<Outcome, "passed">,
    message: string,
    public readonly captureReason?: UiAssertionCaptureUnavailableReason,
  ) {
    super(message);
  }
}

export function parseWebDriverRequest(value: unknown): WebDriverRequest {
  if (
    !Value.Check(WebDriverRequestSchema, value) ||
    !hasWellFormedStrings(value) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > webDriverMaximumInputBytes
  ) {
    throw new TypeError("Invalid Web driver request.");
  }
  if (!isAbsolute(value.evidenceDirectory) || !isAbsolute(value.browserExecutablePath)) {
    throw new TypeError("Web driver paths must be absolute Worker-owned paths.");
  }
  if (value.observationProtocol === "UiAssertionCaptureV1" && value.evidence.trace !== "off")
    throw new TypeError("Mapped Web observations require the frozen trace policy to be off.");
  resolveManagedWebUiUrl(value.servicePort, value.scenario.path);
  const ids = new Set([value.scenario.id]);
  let assertions = 0;
  for (const step of value.scenario.steps) {
    if (ids.has(step.id) || step.timeoutMs > value.scenario.timeoutMs) {
      throw new TypeError("Web scenario step identifiers and budgets are invalid.");
    }
    ids.add(step.id);
    if (
      value.observationProtocol === "UiAssertionCaptureV1" &&
      ((step.action === "fill" && !isSafeUiObservationText(step.value)) ||
        ((step.action === "assertText" || step.action === "assertValue") &&
          !isSafeUiObservationText(step.expected)))
    )
      throw new TypeError("The mapped Web scenario contains unsafe configured text.");
    if (isUiAssertionAction(step.action)) assertions += 1;
    if (step.action === "assertText" && step.match === "contains" && step.expected.length === 0) {
      throw new TypeError("A text assertion cannot search for an empty value.");
    }
  }
  if (assertions === 0) throw new TypeError("A Web scenario requires a deterministic assertion.");
  return value;
}

export function serializeWebDriverResult(result: WebDriverResult): string {
  if (!Value.Check(WebDriverResultSchema, result))
    throw new TypeError("Invalid Web driver result.");
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > webDriverMaximumOutputBytes) {
    throw new RangeError("Web driver result exceeded the output limit.");
  }
  return serialized;
}

export function parseWebDriverResult(stdout: string, input: WebDriverRequest): WebDriverResult {
  const request = parseWebDriverRequest(input);
  if (
    typeof stdout !== "string" ||
    !stdout.isWellFormed() ||
    Buffer.byteLength(stdout, "utf8") > webDriverMaximumOutputBytes
  )
    invalidDriverResult();
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    invalidDriverResult();
  }
  if (!Value.Check(WebDriverResultSchema, value)) invalidDriverResult();
  const result = value;
  if (
    result.scenarioId !== request.scenario.id ||
    result.execution.scenarioId !== request.scenario.id ||
    result.execution.target !== "web" ||
    result.execution.steps.length !== request.scenario.steps.length ||
    !matchesUiScenarioObservations(request.scenario.steps, result.execution.steps, {
      requireCapture: request.observationProtocol === "UiAssertionCaptureV1",
      checkOutcome: result.outcome,
    })
  )
    invalidDriverResult();
  const files = new Map<string, EvidenceFile>();
  const paths = new Set<string>();
  let directory: string | null = null;
  let totalBytes = 0;
  for (const asset of result.evidenceFiles) {
    const extension = asset.kind === "screenshot" ? "png" : asset.kind === "trace" ? "zip" : "json";
    const mediaType =
      asset.kind === "screenshot"
        ? "image/png"
        : asset.kind === "trace"
          ? "application/zip"
          : "application/json";
    const maximumBytes =
      asset.kind === "screenshot"
        ? maximumScreenshotBytes
        : asset.kind === "trace"
          ? maximumTraceBytes
          : webDriverMaximumOutputBytes;
    const folder = asset.relativePath.split("/")[0];
    if (
      folder === undefined ||
      asset.relativePath !== `${folder}/${asset.id}.${extension}` ||
      asset.mediaType !== mediaType ||
      asset.sizeBytes > maximumBytes ||
      asset.sha256.length !== 64 ||
      files.has(asset.id) ||
      paths.has(asset.relativePath.toLowerCase()) ||
      (directory !== null && directory !== folder)
    )
      invalidDriverResult();
    directory = folder;
    totalBytes += asset.sizeBytes;
    if (totalBytes > webDriverMaximumEvidenceBytes) invalidDriverResult();
    files.set(asset.id, asset);
    paths.add(asset.relativePath.toLowerCase());
  }
  const screenshots = new Set<string>();
  let halted = false;
  let firstFailure: UiStepExecutionEvidence | null = null;
  for (const [index, expected] of request.scenario.steps.entries()) {
    const actual = result.execution.steps[index];
    if (
      actual === undefined ||
      actual.stepId !== expected.id ||
      actual.name !== expected.name ||
      actual.action !== expected.action
    )
      invalidDriverResult();
    const expectedValue =
      expected.action === "click" || expected.action === "fill" ? null : expected.expected;
    if (actual.expected !== expectedValue || (halted && actual.outcome !== "not_run"))
      invalidDriverResult();
    if (actual.outcome !== "passed") {
      halted = true;
      firstFailure ??= actual;
    }
    if (expected.action !== "click" && expected.action !== "fill") {
      const matches =
        expected.action === "assertText" && expected.match === "contains"
          ? typeof actual.actual === "string" && actual.actual.includes(expected.expected)
          : actual.actual === expected.expected;
      if (
        (actual.outcome === "passed" && !matches) ||
        (actual.outcome === "failed" && actual.actual !== null && matches)
      )
        invalidDriverResult();
    }
    for (const id of actual.evidenceIds) {
      if (files.get(id)?.kind !== "screenshot" || screenshots.has(id)) invalidDriverResult();
      screenshots.add(id);
    }
    const requiredScreenshot =
      actual.outcome === "failed" ||
      (actual.outcome === "passed" &&
        isUiAssertionAction(expected.action) &&
        request.evidence.screenshots === "every_assertion");
    if (
      actual.evidenceIds.length > 1 ||
      (result.evidenceComplete && requiredScreenshot && actual.evidenceIds.length !== 1) ||
      (actual.outcome === "not_run" && actual.evidenceIds.length !== 0)
    )
      invalidDriverResult();
  }
  const traces = result.evidenceFiles.filter((asset) => asset.kind === "trace");
  const steps = result.evidenceFiles.filter((asset) => asset.kind === "ui_steps");
  const unassignedScreenshots = result.evidenceFiles.filter(
    (asset) => asset.kind === "screenshot" && !screenshots.has(asset.id),
  );
  if (
    traces.length > (request.evidence.trace === "off" ? 0 : 1) ||
    steps.length > 1 ||
    unassignedScreenshots.length > (result.outcome === "passed" ? 0 : 1)
  )
    invalidDriverResult();
  const stepAsset = steps[0];
  if (stepAsset !== undefined) {
    const execution = Buffer.from(JSON.stringify(result.execution), "utf8");
    if (
      stepAsset.sizeBytes !== execution.byteLength ||
      stepAsset.sha256 !== createHash("sha256").update(execution).digest("hex")
    )
      invalidDriverResult();
  }
  const requiresTrace =
    request.evidence.trace !== "off" &&
    (request.evidence.trace === "always" || result.outcome !== "passed");
  if (
    result.evidenceComplete &&
    (result.browserVersion === null || steps.length !== 1 || (requiresTrace && traces.length !== 1))
  )
    invalidDriverResult();
  if (
    result.outcome === "passed" &&
    (halted || !result.evidenceComplete || result.reasonCode !== "completed")
  )
    invalidDriverResult();
  if (result.reasonCode === "completed" && result.outcome !== "passed") invalidDriverResult();
  if (result.outcome === "failed" && (firstFailure === null || firstFailure.outcome !== "failed"))
    invalidDriverResult();
  if (
    result.reasonCode === "assertion_failed" &&
    (result.outcome !== "failed" ||
      firstFailure === null ||
      firstFailure.outcome !== "failed" ||
      firstFailure.actual === null ||
      !isUiAssertionAction(firstFailure.action))
  )
    invalidDriverResult();
  if (
    result.reasonCode === "action_failed" &&
    (result.outcome !== "failed" ||
      firstFailure === null ||
      isUiAssertionAction(firstFailure.action))
  )
    invalidDriverResult();
  if (
    result.outcome === "failed" &&
    result.reasonCode !== "assertion_failed" &&
    result.reasonCode !== "action_failed"
  )
    invalidDriverResult();
  if (
    result.reasonCode === "observation_unavailable" &&
    (firstFailure === null ||
      !isUiAssertionAction(firstFailure.action) ||
      firstFailure.actual !== null ||
      (firstFailure.outcome !== "blocked" && firstFailure.outcome !== "inconclusive") ||
      firstFailure.outcome !== result.outcome ||
      (request.observationProtocol === "UiAssertionCaptureV1" &&
        (!("capture" in firstFailure) || firstFailure.capture?.state !== "unavailable")))
  )
    invalidDriverResult();
  if (
    request.observationProtocol === "UiAssertionCaptureV1" &&
    result.execution.steps.some(
      (step) =>
        "capture" in step &&
        step.capture?.state === "unavailable" &&
        (step.capture.reason === "unsafe_value" || step.capture.reason === "oversized_value"),
    ) &&
    (result.evidenceComplete || result.evidenceFiles.some((asset) => asset.kind !== "ui_steps"))
  )
    invalidDriverResult();
  return result;
}

function invalidDriverResult(): never {
  throw new TypeError("The Web driver result did not match its owned scenario and evidence.");
}

export async function runWebUiScenario(
  input: WebDriverRequest,
  dependencies: WebDriverDependencies,
): Promise<WebDriverResult> {
  const request = parseWebDriverRequest(input);
  const captureObservations = request.observationProtocol === "UiAssertionCaptureV1";
  const execution: UiScenarioExecutionEvidenceV1 = {
    schemaVersion: "UiScenarioExecutionEvidenceV1",
    source: "ui_driver",
    target: "web",
    scenarioId: request.scenario.id,
    steps: request.scenario.steps.map((step) => pendingStep(step, captureObservations)),
  };
  const evidenceFiles: EvidenceFile[] = [];
  const result: WebDriverResult = {
    schemaVersion: "WebDriverResultV1",
    scenarioId: request.scenario.id,
    outcome: "passed",
    reasonCode: "completed",
    summary: "Every configured UI operation and assertion passed.",
    browserVersion: null,
    evidenceComplete: false,
    execution,
    evidenceFiles,
  };
  const deadline = performance.now() + request.scenario.timeoutMs;
  const stopping = new AbortController();
  let failure: DriverFailure | null = null;
  let browser: WebDriverBrowser | null = null;
  let context: WebDriverContext | null = null;
  let page: WebDriverPage | null = null;
  let traceStarted = false;
  let directory: { absolute: string; relative: string } | null = null;
  let finalized = true;
  let totalEvidenceBytes = 0;
  let activeStep: UiStepExecutionEvidence | null = null;
  let mediaAllowed = true;
  const pendingScreenshots: { id: string; bytes: Buffer }[] = [];
  let pendingScreenshotBytes = 0;
  let evidenceScan: Promise<void> | null = null;
  const stop = (error: DriverFailure): void => {
    if (failure === null || error.outcome === "inconclusive") failure = error;
    finalized = false;
    stopping.abort(error);
  };
  const abort = (): void =>
    stop(new DriverFailure("aborted", "inconclusive", "The owned scenario was cancelled."));
  dependencies.signal.addEventListener("abort", abort, { once: true });
  if (dependencies.signal.aborted) abort();
  const timer = setTimeout(
    () =>
      stop(
        new DriverFailure(
          "scenario_timeout",
          "inconclusive",
          "The scenario exceeded its total time budget.",
        ),
      ),
    request.scenario.timeoutMs,
  );
  const evidenceTimer = setInterval(() => {
    if (directory === null || evidenceScan !== null) return;
    evidenceScan = checkEvidenceDirectoryBudget(directory.absolute)
      .catch(() => {
        finalized = false;
        stop(
          new DriverFailure(
            "evidence_failed",
            "blocked",
            "Browser evidence exceeded the controlled storage budget.",
          ),
        );
      })
      .finally(() => {
        evidenceScan = null;
      });
  }, 250);
  const bounded = <T>(operation: Promise<T>): Promise<T> =>
    waitForOperation(operation, stopping.signal, deadline);
  const assertOrigin = (): void => {
    if (page === null || !isManagedUrl(page.url(), request.servicePort)) {
      stop(
        new DriverFailure(
          "origin_violation",
          "blocked",
          "The browser left the managed service origin.",
        ),
      );
    }
    stopping.signal.throwIfAborted();
  };
  const addEvidence = async (
    id: string,
    extension: "png" | "zip" | "json",
    kind: EvidenceFile["kind"],
    maximumBytes: number,
  ): Promise<void> => {
    if (directory === null) throw new Error("Evidence directory is unavailable.");
    const relativePath = `${directory.relative}/${id}.${extension}`;
    const path = join(directory.absolute, `${id}.${extension}`);
    if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Evidence files must not be links.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > maximumBytes ||
        totalEvidenceBytes + stat.size > webDriverMaximumEvidenceBytes
      ) {
        throw new Error("Evidence file exceeded its trusted bounds.");
      }
      const bytes = await file.readFile();
      const after = await file.stat();
      if (
        bytes.byteLength !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      ) {
        throw new Error("Evidence file changed during finalization.");
      }
      totalEvidenceBytes += stat.size;
      evidenceFiles.push({
        id,
        relativePath,
        kind,
        mediaType:
          extension === "png"
            ? "image/png"
            : extension === "zip"
              ? "application/zip"
              : "application/json",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await file.close();
    }
  };
  const screenshot = async (step: UiStepExecutionEvidence | null): Promise<void> => {
    if (page === null || directory === null || stopping.signal.aborted || !mediaAllowed)
      throw new Error("Screenshot context is unavailable.");
    assertOrigin();
    const id = randomUUID();
    const bytes = await bounded(
      page.screenshot({
        ...(captureObservations ? {} : { path: join(directory.absolute, `${id}.png`) }),
        type: "png",
        fullPage: false,
        timeout: remaining(deadline),
      }),
    );
    assertOrigin();
    if (captureObservations) {
      // No screenshot is durable until every sampled value passes the sensitive-value guard.
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > maximumScreenshotBytes ||
        pendingScreenshotBytes + bytes.byteLength > webDriverMaximumEvidenceBytes
      )
        throw new Error("Buffered screenshots exceeded the controlled evidence budget.");
      pendingScreenshotBytes += bytes.byteLength;
      pendingScreenshots.push({ id, bytes });
    } else await addEvidence(id, "png", "screenshot", maximumScreenshotBytes);
    step?.evidenceIds.push(id);
  };
  try {
    stopping.signal.throwIfAborted();
    try {
      directory = await createEvidenceDirectory(request.evidenceDirectory);
    } catch {
      throw new DriverFailure(
        "evidence_failed",
        "blocked",
        "The controlled evidence directory is unavailable.",
      );
    }
    stopping.signal.throwIfAborted();
    const launching = dependencies.chromium.launch({
      executablePath: request.browserExecutablePath,
      headless: true,
      timeout: remaining(deadline),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      downloadsPath: directory.absolute,
      tracesDir: directory.absolute,
    });
    // If cancellation wins startup, a late browser is still closed before the ProcessHost tree ends.
    launching.then(
      (launched) => {
        if (stopping.signal.aborted) void launched.close().catch(() => undefined);
      },
      () => undefined,
    );
    browser = await bounded(launching);
    const version = browser.version();
    if (version.length === 0 || version.length > 128) throw new Error("Invalid browser version.");
    result.browserVersion = version;
    const creatingContext = browser.newContext({
      viewport: request.browser.viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      javaScriptEnabled: true,
    });
    creatingContext.then(
      (created) => {
        if (stopping.signal.aborted) void created.close().catch(() => undefined);
      },
      () => undefined,
    );
    context = await bounded(creatingContext);
    await bounded(
      context.route("**/*", async (route) => {
        try {
          if (
            stopping.signal.aborted ||
            !isManagedUrl(route.request().url(), request.servicePort)
          ) {
            stop(
              new DriverFailure(
                "origin_violation",
                "blocked",
                "A request outside the managed service was blocked.",
              ),
            );
            await route.abort("blockedbyclient");
            return;
          }
          // Playwright does not route every redirect hop. Never continue a redirect chain that can
          // escape the allowlist; replacing its final body would also change browser URL semantics.
          const response = await route.fetch({ maxRedirects: 0, timeout: remaining(deadline) });
          try {
            const location = response.headers().location;
            if (response.status() >= 300 && response.status() <= 399 && location !== undefined) {
              const redirected = new URL(location, route.request().url());
              const code = isManagedUrl(redirected.href, request.servicePort)
                ? "unsupported_redirect"
                : "origin_violation";
              stop(
                new DriverFailure(
                  code,
                  "blocked",
                  "HTTP redirects are outside the managed navigation protocol.",
                ),
              );
              await route.abort("blockedbyclient");
              return;
            }
            await route.fulfill({ response });
          } finally {
            await response.dispose();
          }
        } catch {
          if (!stopping.signal.aborted)
            stop(
              new DriverFailure(
                "navigation_failed",
                "blocked",
                "A managed browser request could not complete.",
              ),
            );
          await route.abort("failed").catch(() => undefined);
        }
      }),
    );
    await bounded(
      context.routeWebSocket("**/*", (socket) => {
        stop(
          new DriverFailure(
            "unsupported_websocket",
            "blocked",
            "WebSocket traffic requires a separately managed transport.",
          ),
        );
        void socket
          .close({ code: 1008, reason: "Managed UI protocol does not permit WebSockets." })
          .catch(() => undefined);
      }),
    );
    let pageCount = 0;
    context.on("page", (created) => {
      pageCount += 1;
      if (pageCount > 1) {
        stop(
          new DriverFailure(
            "unsupported_popup",
            "blocked",
            "An unplanned browser page was opened.",
          ),
        );
        void created.close().catch(() => undefined);
      }
    });
    if (request.evidence.trace !== "off") {
      await bounded(
        context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
          name: "scenario",
        }),
      );
      traceStarted = true;
    }
    page = await bounded(context.newPage());
    page.on("framenavigated", (frame) => {
      const url = frame.url();
      if (url !== "about:blank" && !isManagedUrl(url, request.servicePort)) {
        stop(
          new DriverFailure(
            "origin_violation",
            "blocked",
            "A frame navigated outside the managed service.",
          ),
        );
        void context?.close().catch(() => undefined);
      }
    });
    await bounded(
      page.goto(resolveManagedWebUiUrl(request.servicePort, request.scenario.path), {
        waitUntil: "domcontentloaded",
        timeout: remaining(deadline),
      }),
    );
    assertOrigin();
    for (const [index, step] of request.scenario.steps.entries()) {
      assertOrigin();
      const evidence = execution.steps[index];
      if (evidence === undefined) throw new Error("The configured step is missing.");
      activeStep = evidence;
      await runStep(
        step,
        evidence,
        locatorFor(page, step.locator),
        bounded,
        deadline,
        stopping.signal,
        assertOrigin,
        captureObservations,
      );
      assertOrigin();
      if (evidence.outcome !== "passed" && evidence.outcome !== "failed")
        throw new Error("A completed UI step has no terminal operation outcome.");
      // Progress and evidence failures belong to the scenario after this observation completes.
      activeStep = null;
      if (dependencies.onStepCompleted !== undefined) {
        const event: WebDriverStepCompleted = {
          scenarioId: request.scenario.id,
          stepId: step.id,
          outcome: evidence.outcome,
        };
        try {
          await bounded(Promise.resolve().then(() => dependencies.onStepCompleted?.(event)));
        } catch (error) {
          if (stopping.signal.aborted || error instanceof DriverFailure) throw error;
          throw new DriverFailure(
            "progress_failed",
            "inconclusive",
            "The completed UI step could not report progress.",
          );
        }
      }
      if (evidence.outcome !== "passed") {
        failure = new DriverFailure(
          isUiAssertionAction(step.action) ? "assertion_failed" : "action_failed",
          "failed",
          evidence.summary,
        );
      }
      if (
        evidence.outcome !== "passed" ||
        (isUiAssertionAction(step.action) && request.evidence.screenshots === "every_assertion")
      ) {
        try {
          await screenshot(evidence);
        } catch {
          finalized = false;
        }
      }
      if (failure !== null) break;
    }
  } catch (error) {
    if (failure === null) {
      failure =
        error instanceof DriverFailure
          ? error
          : new DriverFailure(
              browser === null ? "browser_unavailable" : "navigation_failed",
              "blocked",
              browser === null
                ? "The configured browser could not start."
                : "The browser scenario could not execute.",
            );
    }
    if (activeStep !== null) {
      invalidateObservation(activeStep, captureReasonForFailure(failure), captureObservations);
      activeStep.outcome = failure.outcome;
      activeStep.summary = failure.message;
    }
    if (
      failure.captureReason === "unsafe_value" ||
      (captureObservations && failure.captureReason === "oversized_value")
    ) {
      mediaAllowed = false;
      finalized = false;
      pendingScreenshots.length = 0;
      for (const step of execution.steps) step.evidenceIds.length = 0;
    }
    if (!stopping.signal.aborted && page !== null) {
      try {
        await screenshot(null);
      } catch {
        finalized = false;
      }
    } else finalized = false;
  } finally {
    if (context !== null && traceStarted) {
      try {
        const id = randomUUID();
        const retain = mediaAllowed && (request.evidence.trace === "always" || failure !== null);
        await withTimeout(
          context.tracing.stop(
            retain && directory !== null ? { path: join(directory.absolute, `${id}.zip`) } : {},
          ),
          finalizationTimeoutMs,
        );
        if (retain) await addEvidence(id, "zip", "trace", maximumTraceBytes);
      } catch {
        finalized = false;
      }
    } else if (request.evidence.trace !== "off") finalized = false;
    for (const resource of [context, browser]) {
      if (resource === null) continue;
      try {
        await withTimeout(resource.close(), finalizationTimeoutMs);
      } catch {
        finalized = false;
        failure = new DriverFailure(
          "cleanup_failed",
          "inconclusive",
          "The owned browser could not be confirmed stopped.",
        );
      }
    }
    if (captureObservations && directory !== null) {
      const finalizedScreenshotIds = new Set<string>();
      if (mediaAllowed && !stopping.signal.aborted) {
        for (const capture of pendingScreenshots) {
          try {
            const file = await open(join(directory.absolute, `${capture.id}.png`), "wx", 0o600);
            try {
              await file.writeFile(capture.bytes);
            } finally {
              await file.close();
            }
            await addEvidence(capture.id, "png", "screenshot", maximumScreenshotBytes);
            finalizedScreenshotIds.add(capture.id);
          } catch {
            finalized = false;
          }
        }
      }
      for (const step of execution.steps)
        step.evidenceIds = step.evidenceIds.filter((id) => finalizedScreenshotIds.has(id));
      pendingScreenshots.length = 0;
    }
    clearTimeout(timer);
    clearInterval(evidenceTimer);
    dependencies.signal.removeEventListener("abort", abort);
    if (evidenceScan !== null) await evidenceScan;
    if (directory !== null) {
      try {
        await checkEvidenceDirectoryBudget(directory.absolute);
      } catch {
        finalized = false;
      }
    }
  }
  if (!finalized && failure === null)
    failure = new DriverFailure(
      "evidence_failed",
      "blocked",
      "Required browser evidence could not be finalized.",
    );
  if (failure !== null) {
    result.outcome = failure.outcome;
    result.reasonCode = failure.code;
    result.summary = failure.message;
  }
  try {
    if (directory === null) throw new Error("Evidence directory is unavailable.");
    const id = randomUUID();
    const file = await open(join(directory.absolute, `${id}.json`), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(execution), "utf8");
    } finally {
      await file.close();
    }
    await addEvidence(id, "json", "ui_steps", webDriverMaximumOutputBytes);
  } catch {
    finalized = false;
    if (result.outcome === "passed") {
      result.outcome = "blocked";
      result.reasonCode = "evidence_failed";
      result.summary = "Required structured assertion evidence could not be finalized.";
    }
  }
  result.evidenceComplete = finalized;
  serializeWebDriverResult(result);
  return result;
}

function pendingStep(
  step: WebUiScenarioStep,
  captureObservations: boolean,
): UiStepExecutionEvidence {
  const common = {
    stepId: step.id,
    name: step.name,
    outcome: "not_run" as const,
    summary: "A preceding operation prevented this step from running.",
    evidenceIds: [],
  };
  if (step.action === "click" || step.action === "fill")
    return { ...common, action: step.action, expected: null, actual: null };
  const capture = captureObservations
    ? {
        capture: {
          schemaVersion: "UiAssertionCaptureV1" as const,
          state: "unavailable" as const,
          reason: "not_run" as const,
        },
      }
    : {};
  if (step.action === "assertVisible")
    return { ...common, ...capture, action: step.action, expected: step.expected, actual: null };
  return { ...common, ...capture, action: step.action, expected: step.expected, actual: null };
}

function locatorFor(page: WebDriverPage, locator: WebUiLocator): WebDriverLocator {
  return locator.by === "role"
    ? page.getByRole(locator.role, { name: locator.name, exact: true, includeHidden: true })
    : page.getByTestId(locator.testId);
}

async function runStep(
  step: WebUiScenarioStep,
  evidence: UiStepExecutionEvidence,
  locator: WebDriverLocator,
  bounded: <T>(promise: Promise<T>) => Promise<T>,
  scenarioDeadline: number,
  signal: AbortSignal,
  assertOrigin: () => void,
  captureObservations: boolean,
): Promise<void> {
  const deadline = Math.min(performance.now() + step.timeoutMs, scenarioDeadline);
  const assertion = isUiAssertionAction(step.action);
  const stepBounded = <T>(operation: Promise<T>): Promise<T> =>
    bounded(
      waitForOperation(
        operation,
        signal,
        deadline,
        assertion
          ? new DriverFailure(
              "observation_unavailable",
              "inconclusive",
              "The assertion read exceeded its step budget.",
              "timeout",
            )
          : new Error("UI step deadline exceeded."),
      ),
    );
  evidence.summary = "The configured operation did not complete within its step budget.";
  evidence.outcome = "failed";
  let unavailableReason: UiAssertionCaptureUnavailableReason = "timeout";
  while (performance.now() < deadline) {
    // Each poll is independent. A later failed read must never expose an earlier mismatch.
    invalidateObservation(evidence, "timeout", captureObservations);
    try {
      signal.throwIfAborted();
      assertOrigin();
      const count = await stepBounded(locator.count());
      assertOrigin();
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid locator count.");
      if (count > 1) {
        if (!assertion) {
          evidence.summary = "The locator matched multiple elements.";
          return;
        }
        throw observationFailure("ambiguous_element", "The locator matched multiple elements.");
      }
      if (count === 1 || step.action === "assertVisible") {
        const timeout = remaining(deadline);
        if (step.action === "click") {
          await stepBounded(locator.click({ timeout }));
        } else if (step.action === "fill") {
          await stepBounded(locator.fill(step.value, { timeout }));
        } else if (step.action === "assertVisible" && evidence.action === "assertVisible") {
          const actual = count === 0 ? false : await stepBounded(locator.isVisible());
          if (count === 1) {
            const afterCount = await stepBounded(locator.count());
            if (afterCount !== 1)
              throw observationFailure(
                afterCount === 0 ? "missing_element" : "ambiguous_element",
                "The locator ceased to identify one element during the assertion.",
              );
          }
          assertOrigin();
          evidence.actual = actual;
          completeObservation(evidence, captureObservations);
          if (actual !== step.expected) {
            await pause(deadline, signal);
            continue;
          }
        } else if (
          (step.action === "assertText" || step.action === "assertValue") &&
          (evidence.action === "assertText" || evidence.action === "assertValue")
        ) {
          const actual = await stepBounded(
            step.action === "assertText"
              ? locator.innerText({ timeout })
              : locator.inputValue({ timeout }),
          );
          assertOrigin();
          if (actual.length > 2_048)
            throw observationFailure(
              "oversized_value",
              "The observed value exceeded the supported evidence bound.",
            );
          if (
            !actual.isWellFormed() ||
            actual.includes("\0") ||
            (captureObservations && !isSafeUiObservationText(actual))
          )
            throw observationFailure("unsafe_value", "The observed value is unsafe to capture.");
          const afterCount = await stepBounded(locator.count());
          if (afterCount !== 1)
            throw observationFailure(
              afterCount === 0 ? "missing_element" : "ambiguous_element",
              "The locator ceased to identify one element during the assertion.",
            );
          assertOrigin();
          evidence.actual = actual;
          completeObservation(evidence, captureObservations);
          const matches =
            step.action === "assertText" && step.match === "contains"
              ? actual.includes(step.expected)
              : actual === step.expected;
          if (!matches) {
            await pause(deadline, signal);
            continue;
          }
        } else throw new Error("Assertion evidence did not match its configured operation.");
        assertOrigin();
        evidence.outcome = "passed";
        evidence.summary = isUiAssertionAction(step.action)
          ? "The deterministic assertion passed."
          : "The configured UI operation completed.";
        return;
      }
      unavailableReason = "missing_element";
      invalidateObservation(evidence, unavailableReason, captureObservations);
      await pause(deadline, signal);
    } catch (error) {
      if (assertion) {
        const failure =
          error instanceof DriverFailure
            ? error
            : observationFailure(
                "provider_error",
                "The assertion provider could not read the value.",
              );
        invalidateObservation(
          evidence,
          signal.aborted
            ? captureReasonForFailure(signal.reason)
            : captureReasonForFailure(failure),
          captureObservations,
        );
        if (signal.aborted) signal.throwIfAborted();
        throw failure;
      }
      if (signal.aborted || error instanceof DriverFailure) throw error;
      evidence.summary = "The configured UI operation failed or exceeded its step budget.";
      return;
    }
  }
  if (assertion && evidence.actual === null)
    throw observationFailure(unavailableReason, "The assertion could not obtain a complete value.");
  evidence.summary = isUiAssertionAction(step.action)
    ? "The deterministic assertion did not match before its deadline."
    : "The locator did not resolve to one actionable element before its deadline.";
}

function observationFailure(
  reason: UiAssertionCaptureUnavailableReason,
  message: string,
): DriverFailure {
  return new DriverFailure("observation_unavailable", "blocked", message, reason);
}

function captureReasonForFailure(error: unknown): UiAssertionCaptureUnavailableReason {
  if (!(error instanceof DriverFailure)) return "provider_error";
  if (error.captureReason !== undefined) return error.captureReason;
  if (error.code === "aborted") return "cancelled";
  if (error.code === "scenario_timeout") return "timeout";
  return "capture_failed";
}

function invalidateObservation(
  evidence: UiStepExecutionEvidence,
  reason: UiAssertionCaptureUnavailableReason,
  captureObservations: boolean,
): void {
  if (
    evidence.action === "assertVisible" ||
    evidence.action === "assertText" ||
    evidence.action === "assertValue"
  ) {
    evidence.actual = null;
    if (captureObservations)
      evidence.capture = { schemaVersion: "UiAssertionCaptureV1", state: "unavailable", reason };
  }
}

function completeObservation(
  evidence: UiStepExecutionEvidence,
  captureObservations: boolean,
): void {
  if (
    captureObservations &&
    (evidence.action === "assertVisible" ||
      evidence.action === "assertText" ||
      evidence.action === "assertValue")
  )
    evidence.capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
}

async function createEvidenceDirectory(
  parent: string,
): Promise<{ absolute: string; relative: string }> {
  const canonical = await realpath(parent);
  if (canonical !== resolve(parent) || !(await lstat(parent)).isDirectory())
    throw new Error("Evidence directory must be a canonical owned directory.");
  const relative = `web-${randomUUID()}`;
  const absolute = join(canonical, relative);
  await mkdir(absolute, { recursive: false, mode: 0o700 });
  return { absolute, relative };
}

async function checkEvidenceDirectoryBudget(root: string): Promise<void> {
  let bytes = 0;
  let count = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) throw new Error("Evidence directory nesting exceeded its bound.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      count += 1;
      if (count > 2_048 || entry.isSymbolicLink())
        throw new Error("Evidence directory entries exceeded their bounds.");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else {
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Unsupported evidence entry.");
          bytes += stat.size;
          if (bytes > webDriverMaximumEvidenceBytes)
            throw new Error("Evidence storage budget exceeded.");
        } catch (error) {
          // Trace finalization atomically replaces temporary files while the bounded scan runs.
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    }
  };
  await visit(root, 0);
}

function isManagedUrl(value: string, port: number): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      (url.port === "" ? "80" : url.port) === String(port) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
function remaining(deadline: number): number {
  return Math.max(1, Math.ceil(deadline - performance.now()));
}
function pause(deadline: number, signal: AbortSignal): Promise<void> {
  return waitForOperation(
    new Promise<void>((resolvePause) =>
      setTimeout(resolvePause, Math.min(50, remaining(deadline))),
    ),
    signal,
    deadline + 1_000,
  );
}
async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return waitForOperation(
    operation,
    new AbortController().signal,
    performance.now() + milliseconds,
  );
}
async function waitForOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number,
  timeoutFailure: Error = new DriverFailure(
    "scenario_timeout",
    "inconclusive",
    "The scenario exceeded its total time budget.",
  ),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    timer = setTimeout(() => reject(timeoutFailure), remaining(deadline));
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    clearTimeout(timer);
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

function hasWellFormedStrings(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value !== null && typeof value === "object")
    return Object.values(value).every(hasWellFormedStrings);
  return true;
}
