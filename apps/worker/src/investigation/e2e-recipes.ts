import { open, readdir, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { type E2eFeaturePlan, parseE2eFeaturePlan } from "./e2e-feature-plan.js";
import type { E2eToolReceipt } from "./e2e-tool-server.js";

type E2eRecipeId = "powertoys-calculator" | "powertoys-run-query";
type PowerToysRunPlugin = "Calculator" | "UnitConverter";

export interface E2eRecipeDescriptor {
  readonly id: E2eRecipeId;
  readonly title: string;
  readonly description: string;
  readonly plugins: readonly PowerToysRunPlugin[];
}

export interface E2eRecipeScenario {
  readonly query: string;
  readonly feature: E2eFeaturePlan;
  readonly requires?: string;
}

export interface PreparedE2eRecipe {
  readonly id: E2eRecipeId;
  readonly plugin: PowerToysRunPlugin;
  readonly scenarios: readonly E2eRecipeScenario[];
}

export interface E2eRecipeResult {
  readonly recipeId: E2eRecipeId;
  readonly summary: string;
  readonly features: {
    featureId: string;
    outcome: "passed" | "failed" | "blocked";
    reason: string;
    assertionReceiptIds: string[];
    mediaReceiptIds: string[];
    limitations: string[];
  }[];
  readonly cleanupConfirmed: boolean;
}

export interface E2eRecipeExecution {
  readonly execute: (input: Record<string, unknown>) => Promise<E2eToolReceipt>;
  readonly signal: AbortSignal;
  readonly environment: Readonly<Record<string, string>>;
}

const pluginDirectories: Record<PowerToysRunPlugin, string> = {
  Calculator: "Microsoft.PowerToys.Run.Plugin.Calculator",
  UnitConverter: "Community.PowerToys.Run.Plugin.UnitConverter",
};
const pluginRoot = "src/modules/launcher/Plugins/";
const calculatorPaths = [
  `${pluginRoot}Microsoft.PowerToys.Run.Plugin.Calculator.UnitTest/QueryTests.cs`,
  `${pluginRoot}Microsoft.PowerToys.Run.Plugin.Calculator/CalculateEngine.cs`,
  `${pluginRoot}Microsoft.PowerToys.Run.Plugin.Calculator/Properties/Resources.Designer.cs`,
  `${pluginRoot}Microsoft.PowerToys.Run.Plugin.Calculator/Properties/Resources.resx`,
] as const;
const baselineLimitation =
  "These four fixed Calculator baseline scenarios do not establish complete semantic coverage of the PR.";

function pluginPaths(plugin: PowerToysRunPlugin, changedPaths: readonly string[]): string[] {
  const directory = `${pluginRoot}${pluginDirectories[plugin]}`;
  return changedPaths.filter(
    (path) => path.startsWith(`${directory}/`) || path.startsWith(`${directory}.UnitTest/`),
  );
}

/** Discovery is a source-path hint; the agent must still assess the PR's behavior. */
export function listE2eRecipes(
  repositoryFullName: string,
  changedPaths: readonly string[],
): readonly E2eRecipeDescriptor[] {
  if (!/^[A-Za-z0-9_.-]+\/PowerToys$/iu.test(repositoryFullName)) return [];
  const plugins = (Object.keys(pluginDirectories) as PowerToysRunPlugin[]).filter(
    (plugin) => pluginPaths(plugin, changedPaths).length > 0,
  );
  const recipes: E2eRecipeDescriptor[] = [];
  if (calculatorPaths.some((path) => changedPaths.includes(path)))
    recipes.push({
      id: "powertoys-calculator",
      title: "PowerToys Run Calculator baseline",
      description:
        "Four fixed English-UI scenarios cover explicit and global 2+2 and sqrt(-1), with a same-session positive control before absence checks. Applies only to the known Calculator engine, QueryTests and resource paths. This baseline does not establish full PR coverage; inspect the current source and expected behavior before selecting it.",
      plugins: ["Calculator"],
    });
  if (plugins.length > 0)
    recipes.push({
      id: "powertoys-run-query",
      title: "PowerToys Run plugin query scenarios",
      description:
        "Build and launch PowerToys Run once, then execute 1-8 supplied query/feature scenarios for an eligible plugin. Features must contain UI assertions and actual changed paths for that plugin. An absence assertion requires an exact QueryTextBox value assertion and an earlier positive result scenario through requires. Supply PR-specific expectations; a recipe does not infer complete PR coverage.",
      plugins,
    });
  return recipes;
}

export function prepareE2eRecipe(
  input: unknown,
  repositoryFullName: string,
  changedPaths: readonly string[],
): PreparedE2eRecipe {
  const request = object(input);
  const descriptor = listE2eRecipes(repositoryFullName, changedPaths).find(
    (recipe) => recipe.id === request?.recipeId,
  );
  if (request === undefined || descriptor === undefined)
    throw new Error("The requested recipe is not eligible for this repository and changed paths.");
  if (descriptor.id === "powertoys-calculator") {
    if (request.plugin !== undefined || request.scenarios !== undefined)
      throw new Error("The Calculator baseline has fixed scenarios and accepts no overrides.");
    const paths = calculatorPaths.filter((path) => changedPaths.includes(path));
    return {
      id: descriptor.id,
      plugin: "Calculator",
      scenarios: calculatorScenarios(paths).map((scenario) => ({
        ...scenario,
        feature: parseE2eFeaturePlan(scenario.feature, changedPaths),
      })),
    };
  }
  const plugin = request.plugin;
  if (
    (plugin !== "Calculator" && plugin !== "UnitConverter") ||
    !descriptor.plugins.includes(plugin)
  )
    throw new Error("The query recipe requires an eligible Calculator or UnitConverter plugin.");
  if (
    !Array.isArray(request.scenarios) ||
    request.scenarios.length < 1 ||
    request.scenarios.length > 8
  )
    throw new Error("The query recipe requires between one and eight scenarios.");
  const allowedPaths = pluginPaths(plugin, changedPaths);
  const scenarios: E2eRecipeScenario[] = [];
  for (const value of request.scenarios) {
    const scenario = object(value);
    if (
      scenario === undefined ||
      typeof scenario.query !== "string" ||
      scenario.query.trim().length === 0 ||
      scenario.query.length > 8_192 ||
      scenario.query.includes("\0")
    )
      throw new Error("Each recipe scenario requires a bounded, nonempty query.");
    const feature = parseE2eFeaturePlan(scenario.feature, allowedPaths);
    if (!feature.userVisible || feature.assertions.some((assertion) => assertion.kind !== "ui"))
      throw new Error("Query recipe features require user-visible UI assertions.");
    if (scenarios.some((previous) => previous.feature.id === feature.id))
      throw new Error("Recipe feature IDs must be unique.");
    const requires = scenario.requires;
    if (
      requires !== undefined &&
      (typeof requires !== "string" ||
        !scenarios.some((previous) => previous.feature.id === requires))
    )
      throw new Error("A scenario dependency must name an earlier feature in this recipe.");
    const hasAbsenceAssertion = feature.assertions.some(
      (assertion) =>
        assertion.kind === "ui" &&
        assertion.assertion?.property === "exists" &&
        assertion.assertion.expected === false,
    );
    if (hasAbsenceAssertion) {
      if (requires === undefined)
        throw new Error("An absence scenario requires an earlier same-session positive control.");
      if (
        !feature.assertions.some(
          (assertion) =>
            assertion.kind === "ui" &&
            assertion.selector.automationId === "QueryTextBox" &&
            assertion.assertion?.property === "value" &&
            assertion.assertion.expected === scenario.query &&
            assertion.assertion.match === "equals",
        )
      )
        throw new Error(
          "An absence scenario must assert the exact QueryTextBox value for its query.",
        );
      const dependency = scenarios.find((previous) => previous.feature.id === requires)!;
      if (
        !dependency.feature.assertions.some(
          (assertion) =>
            assertion.kind === "ui" &&
            assertion.selector.automationId !== "QueryTextBox" &&
            ((assertion.assertion?.property === "exists" &&
              assertion.assertion.expected === true) ||
              ((assertion.assertion?.property === "text" ||
                assertion.assertion?.property === "value") &&
                typeof assertion.assertion.expected === "string" &&
                assertion.assertion.expected.trim().length > 0)),
        )
      )
        throw new Error("An absence scenario dependency must assert a positive plugin result.");
    }
    scenarios.push({
      query: scenario.query,
      feature,
      ...(typeof requires === "string" ? { requires } : {}),
    });
  }
  return { id: descriptor.id, plugin, scenarios };
}

function calculatorScenarios(paths: readonly string[]): E2eRecipeScenario[] {
  const errorRow = "Failed to calculate the input : Complex numbers are not supported, ";
  const resultRow = "4 : Copy this number to the clipboard, ";
  const queryAssertion = (query: string): E2eFeaturePlan["assertions"][number] => ({
    id: "query",
    kind: "ui",
    description: `The query control contains exactly ${query}.`,
    selector: { automationId: "QueryTextBox" },
    assertion: { property: "value", expected: query, match: "equals" },
  });
  const rowAssertion = (
    id: string,
    name: string,
    description: string,
    expected: boolean,
  ): E2eFeaturePlan["assertions"][number] => ({
    id,
    kind: "ui",
    description,
    selector: { name },
    assertion: { property: "exists", expected },
  });
  const scenario = (
    id: string,
    title: string,
    query: string,
    description: string,
    assertions: E2eFeaturePlan["assertions"],
    requires?: string,
  ): E2eRecipeScenario => ({
    query,
    feature: {
      id,
      title,
      paths: [...paths],
      scenario: description,
      userVisible: true,
      assertions: [queryAssertion(query), ...assertions],
    },
    ...(requires === undefined ? {} : { requires }),
  });
  return [
    scenario(
      "explicit-complex-error",
      "Explicit keyword complex result error",
      "=sqrt(-1)",
      "Enter =sqrt(-1) and verify the Calculator complex-number error title and subtitle.",
      [
        {
          id: "error-title",
          kind: "ui",
          description: "The Calculator result title reports a calculation failure.",
          selector: { name: errorRow },
          assertion: {
            property: "text",
            expected: "Failed to calculate the input",
            match: "contains",
          },
        },
        {
          id: "error-subtitle",
          kind: "ui",
          description:
            "The Calculator result subtitle explains that complex numbers are unsupported.",
          selector: { name: errorRow },
          assertion: {
            property: "text",
            expected: "Complex numbers are not supported",
            match: "contains",
          },
        },
      ],
    ),
    scenario(
      "explicit-basic-calculation",
      "Explicit keyword ordinary calculation",
      "=2+2",
      "Enter =2+2 and verify the exact query and Calculator result titled 4.",
      [
        rowAssertion(
          "result-row",
          resultRow,
          "The Calculator result is 4 with its normal subtitle.",
          true,
        ),
      ],
    ),
    scenario(
      "global-basic-positive-control",
      "Global query Calculator positive control",
      "2+2",
      "Enter global 2+2 and verify that Calculator participates before testing global error absence.",
      [
        rowAssertion(
          "result-row",
          resultRow,
          "Calculator participates in the global query with result 4.",
          true,
        ),
      ],
    ),
    scenario(
      "global-complex-error-absence",
      "Global query suppresses Calculator complex error",
      "sqrt(-1)",
      "After the same-session global positive control passes, enter sqrt(-1) and verify that the Calculator error and stale 4 result are absent. Other plugins may return results.",
      [
        rowAssertion(
          "error-absent",
          errorRow,
          "The Calculator complex error result is absent.",
          false,
        ),
        rowAssertion(
          "stale-result-cleared",
          resultRow,
          "The previous Calculator 4 result has cleared.",
          false,
        ),
      ],
      "global-basic-positive-control",
    ),
  ];
}

/** Every execution capability and every assertion/media receipt belongs to the calling tool session. */
export async function runE2eRecipe(
  prepared: PreparedE2eRecipe,
  context: E2eRecipeExecution,
): Promise<E2eRecipeResult> {
  const plan = structuredClone(prepared);
  const features: E2eRecipeResult["features"] = plan.scenarios.map(({ feature }) => ({
    featureId: feature.id,
    outcome: "blocked",
    reason: "The scenario has not executed.",
    assertionReceiptIds: [],
    mediaReceiptIds: [],
    limitations: plan.id === "powertoys-calculator" ? [baselineLimitation] : [],
  }));
  const execute = async (input: Record<string, unknown>, requirePassed = true) => {
    context.signal.throwIfAborted();
    const receipt = await context.execute(input);
    context.signal.throwIfAborted();
    if (requirePassed && receipt.status !== "passed")
      throw new Error(`The ${String(input.operation)} operation did not pass: ${receipt.summary}`);
    return receipt;
  };
  const wait = (milliseconds: number) => abortableDelay(milliseconds, context.signal);
  let processRef: string | undefined;
  let processId: number | undefined;
  let cleanupConfirmed = false;
  const enumerate = async () => {
    const receipt = await execute({ operation: "enumerate", processRef });
    const data = object(object(receipt.observed)?.data);
    if (data === undefined || data.truncated === true || !Array.isArray(data.windows))
      throw new Error("The owned window list was unavailable or truncated.");
    return data.windows.flatMap((value) => {
      const window = object(value);
      return window !== undefined &&
        window.pid === processId &&
        window.owned === true &&
        window.visible === true &&
        typeof window.title === "string" &&
        typeof window.windowHandle === "string" &&
        /^[1-9][0-9]*$/u.test(window.windowHandle)
        ? [{ title: window.title, windowHandle: window.windowHandle }]
        : [];
    });
  };
  const dismissDialogs = async (windows: Awaited<ReturnType<typeof enumerate>>) => {
    for (const dialog of windows.filter((window) =>
      window.title.endsWith("Plugin Initialization Error"),
    )) {
      const target = { windowHandle: dialog.windowHandle };
      const receipt = await execute({
        operation: "inspect",
        processRef,
        target,
        maxDepth: 5,
        maxNodes: 100,
      });
      const nodes = inspectedNodes(receipt);
      if (
        !nodes
          .map((node) => node.name ?? "")
          .join("\n")
          .includes("Fail to initialize plugins") ||
        nodes.filter(
          (node) => node.name === "OK" && node.automationId === "2" && node.className === "Button",
        ).length !== 1
      )
        throw new Error(
          "The owned initialization dialog did not contain its expected message and unique OK control.",
        );
      await execute({
        operation: "click",
        featureId: plan.scenarios[0]!.feature.id,
        processRef,
        target: { ...target, selector: { name: "OK", automationId: "2" } },
      });
      await wait(300);
      if ((await enumerate()).some((window) => window.windowHandle === dialog.windowHandle))
        throw new Error("The owned initialization dialog remained visible after dismissal.");
    }
  };
  try {
    await execute({ operation: "desktop-status" });
    for (const scenario of plan.scenarios)
      await execute({ operation: "register-feature", feature: scenario.feature });
    const build = await execute({
      operation: "build",
      request: {
        tool: "msbuild",
        projectPath: "PowerToys.slnx",
        configuration: "Debug",
        platform: "x64",
        solutionProject: "src/modules/launcher/PowerLauncher/PowerLauncher.csproj",
        repositoryOutputDirectory: "x64/Debug",
        outputs: [
          "PowerToys.PowerLauncher.exe",
          `RunPlugins/${plan.plugin}/${pluginDirectories[plan.plugin]}.dll`,
        ],
      },
    });
    const buildRef = object(build.observed)?.id;
    if (typeof buildRef !== "string")
      throw new Error("The build did not return a current build reference.");
    const localAppData = Object.entries(context.environment).find(
      ([name]) => name.toUpperCase() === "LOCALAPPDATA",
    )?.[1];
    const logRoot =
      localAppData === undefined
        ? undefined
        : win32.join(localAppData, "Microsoft", "PowerToys", "PowerToys Run", "Logs");
    const logOffsets = await startupLogOffsets(logRoot);
    const launched = await execute({
      operation: "launch",
      buildRef,
      outputPath: "PowerToys.PowerLauncher.exe",
      arguments: [],
    });
    const application = object(launched.observed);
    if (typeof application?.processRef !== "string" || typeof application.pid !== "number")
      throw new Error("The launch did not return an owned application reference.");
    processRef = application.processRef;
    processId = application.pid;
    const deadline = Date.now() + 90_000;
    let windowHandle: string | undefined;
    let activated = false;
    while (Date.now() < deadline) {
      context.signal.throwIfAborted();
      const windows = await enumerate();
      await dismissDialogs(windows);
      const mainWindows = windows.filter((window) => window.title === "PowerToys.PowerLauncher");
      if (mainWindows.length > 1)
        throw new Error("More than one visible owned Launcher main window was found.");
      if (mainWindows.length === 1) {
        const candidate = mainWindows[0]!;
        const inspected = await execute(
          {
            operation: "inspect",
            processRef,
            target: { windowHandle: candidate.windowHandle },
            maxDepth: 6,
            maxNodes: 200,
          },
          false,
        );
        if (
          inspected.status === "passed" &&
          inspectedNodes(inspected).some(
            (node) => node.automationId === "QueryTextBox" && node.controlType === "Edit",
          )
        ) {
          windowHandle = candidate.windowHandle;
          break;
        }
      } else if (!activated && (await hasNewStartupMarker(logRoot, logOffsets))) {
        await execute({
          operation: "command",
          script:
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('% ')",
          timeoutMs: 15_000,
        });
        activated = true;
      }
      await wait(500);
    }
    if (windowHandle === undefined)
      throw new Error(
        "No ready owned Launcher window with QueryTextBox appeared within 90 seconds.",
      );
    const mainTarget = { windowHandle };
    for (const [index, scenario] of plan.scenarios.entries()) {
      context.signal.throwIfAborted();
      const feature = features[index]!;
      if (
        scenario.requires !== undefined &&
        !features.some(
          (previous) => previous.featureId === scenario.requires && previous.outcome === "passed",
        )
      ) {
        feature.reason = "The required same-session positive control and its media did not pass.";
        continue;
      }
      try {
        const queryTarget = {
          windowHandle,
          selector: { automationId: "QueryTextBox", controlType: "Edit" },
        };
        await execute({
          operation: "click",
          featureId: feature.featureId,
          processRef,
          target: queryTarget,
        });
        await execute({
          operation: "keys",
          featureId: feature.featureId,
          processRef,
          target: queryTarget,
          keys: ["CTRL+A"],
        });
        await execute({
          operation: "type",
          featureId: feature.featureId,
          processRef,
          target: queryTarget,
          text: scenario.query,
        });
        await wait(2_000);
        await execute({
          operation: "inspect",
          processRef,
          target: mainTarget,
          maxDepth: 6,
          maxNodes: 200,
        });
        const assertions: E2eToolReceipt[] = [];
        for (const specification of scenario.feature.assertions) {
          const receipt = await execute(
            {
              operation: "assert",
              featureId: feature.featureId,
              assertionId: specification.id,
              processRef,
              target: mainTarget,
            },
            false,
          );
          assertions.push(receipt);
          feature.assertionReceiptIds.push(receipt.id);
          if (receipt.status === "failed") feature.outcome = "failed";
        }
        const passed = assertions.filter((receipt) => receipt.status === "passed");
        let mediaPassed = false;
        if (passed.length > 0) {
          // Keep the screenshot in the exact interaction state used by the assertions.
          const screenshot = await execute(
            {
              operation: "screenshot",
              featureId: feature.featureId,
              processRef,
              target: mainTarget,
            },
            false,
          );
          feature.mediaReceiptIds.push(screenshot.id);
          mediaPassed =
            screenshot.status === "passed" &&
            screenshot.artifactRefs.length > 0 &&
            passed.every((receipt) => screenshot.relatedAssertionIds?.includes(receipt.id));
        }
        feature.outcome = assertions.some((receipt) => receipt.status === "failed")
          ? "failed"
          : assertions.every((receipt) => receipt.status === "passed") && mediaPassed
            ? "passed"
            : "blocked";
        feature.reason =
          feature.outcome === "passed"
            ? "Every registered assertion passed and is linked to this owned window's fresh screenshot."
            : "The assertion or media receipts did not establish every registered expectation.";
      } catch (error) {
        context.signal.throwIfAborted();
        feature.reason = errorMessage(error);
      }
    }
  } catch (error) {
    context.signal.throwIfAborted();
    for (const feature of features)
      if (feature.reason === "The scenario has not executed.") feature.reason = errorMessage(error);
  } finally {
    // On cancellation the tool session's outer lifecycle performs guaranteed process cleanup.
    if (!context.signal.aborted) {
      try {
        const stopped =
          processRef === undefined
            ? undefined
            : await execute({ operation: "stop", processRef }, false);
        const desktop = await execute({ operation: "desktop-status" }, false);
        cleanupConfirmed =
          (stopped === undefined || stopped.status === "passed") &&
          desktop.status === "passed" &&
          object(object(desktop.observed)?.data)?.cleanupConfirmed === true;
      } catch {
        context.signal.throwIfAborted();
      }
    }
  }
  if (!cleanupConfirmed)
    for (const feature of features) {
      if (feature.outcome === "passed") feature.outcome = "blocked";
      feature.limitations.push("Owned-process cleanup was not confirmed by the tool session.");
    }
  const passedCount = features.filter((feature) => feature.outcome === "passed").length;
  return {
    recipeId: plan.id,
    summary: `${plan.plugin} recipe: ${passedCount}/${features.length} scenarios passed; owned-process cleanup ${cleanupConfirmed ? "confirmed" : "unconfirmed"}.`,
    features,
    cleanupConfirmed,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inspectedNodes(receipt: E2eToolReceipt): Record<string, unknown>[] {
  const data = object(object(receipt.observed)?.data);
  if (data === undefined || data.truncated === true || !Array.isArray(data.nodes))
    throw new Error("The inspected UI tree was unavailable or truncated.");
  return data.nodes.flatMap((value) => {
    const node = object(value);
    return node === undefined ? [] : [node];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The recipe operation did not complete.";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function startupLogFiles(root: string | undefined, depth = 0): Promise<string[]> {
  if (root === undefined) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const path = win32.join(root, entry.name);
        if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.txt$/u.test(entry.name)) return [path];
        return entry.isDirectory() && depth < 2 ? startupLogFiles(path, depth + 1) : [];
      }),
    );
    return files.flat();
  } catch {
    return [];
  }
}

async function startupLogOffsets(root: string | undefined): Promise<Map<string, number>> {
  const offsets = new Map<string, number>();
  for (const path of await startupLogFiles(root)) {
    try {
      offsets.set(path, (await stat(path)).size);
    } catch {
      // Optional startup diagnostics.
    }
  }
  return offsets;
}

async function hasNewStartupMarker(
  root: string | undefined,
  offsets: ReadonlyMap<string, number>,
): Promise<boolean> {
  for (const path of await startupLogFiles(root)) {
    try {
      const handle = await open(path, "r");
      try {
        const size = (await handle.stat()).size;
        const previous = offsets.get(path) ?? 0;
        const start = Math.max(previous <= size ? previous : 0, size - 256 * 1_024);
        if (start === size) continue;
        const bytes = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
        if (bytes.subarray(0, bytesRead).toString("utf8").includes("End PowerToys Run startup"))
          return true;
      } finally {
        await handle.close();
      }
    } catch {
      // UI readiness remains available when optional startup logs cannot be read.
    }
  }
  return false;
}
