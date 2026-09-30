import { afterEach, describe, expect, it, vi } from "vitest";
import type { E2eFeaturePlan } from "./e2e-feature-plan.js";
import { listE2eRecipes, prepareE2eRecipe, runE2eRecipe } from "./e2e-recipes.js";
import type { E2eToolReceipt } from "./e2e-tool-server.js";

const startupFiles = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
}));

vi.mock("node:fs/promises", () => startupFiles);

const calculatorPath =
  "src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.Calculator/CalculateEngine.cs";
const calculatorTestPath =
  "src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.Calculator.UnitTest/QueryTests.cs";
const converterPath =
  "src/modules/launcher/Plugins/Community.PowerToys.Run.Plugin.UnitConverter/Main.cs";
const repository = "fixture-owner/PowerToys";

function feature(id = "conversion", paths = [converterPath]): E2eFeaturePlan {
  return {
    id,
    title: "Unit conversion result",
    paths,
    scenario: "Enter a conversion query and inspect the result.",
    userVisible: true,
    assertions: [
      {
        id: "result",
        kind: "ui",
        description: "The converted value is displayed.",
        selector: { automationId: "Result" },
        assertion: { property: "text", expected: "1.609344", match: "contains" },
      },
    ],
  };
}

function queryAssertion(
  query: string,
): Extract<E2eFeaturePlan["assertions"][number], { kind: "ui" }> {
  return {
    id: "query",
    kind: "ui",
    description: "The query control contains the exact requested query.",
    selector: { automationId: "QueryTextBox" },
    assertion: { property: "value", expected: query, match: "equals" },
  };
}

function absenceFeature(query = "invalid query", id = "absent"): E2eFeaturePlan {
  return {
    ...feature(id),
    assertions: [
      queryAssertion(query),
      {
        id: "no-error",
        kind: "ui",
        description: "No error is displayed.",
        selector: { name: "Invalid expression" },
        assertion: { property: "exists", expected: false },
      },
    ],
  };
}

function calculatorPlan() {
  return prepareE2eRecipe(
    { operation: "run-recipe", recipeId: "powertoys-calculator" },
    repository,
    [calculatorPath, calculatorTestPath],
  );
}

function queryInput(scenarios: unknown = [{ query: "1 mile to km", feature: feature() }]) {
  return {
    operation: "run-recipe",
    recipeId: "powertoys-run-query",
    plugin: "UnitConverter",
    scenarios,
  };
}

type ReceiptOverride = (
  input: Record<string, unknown>,
  receipt: E2eToolReceipt,
) => E2eToolReceipt | Promise<E2eToolReceipt>;

function executorFixture(override?: ReceiptOverride) {
  const calls: Record<string, unknown>[] = [];
  const receipts: E2eToolReceipt[] = [];
  const controller = new AbortController();
  let buildRef: string | undefined;
  let processRef: string | undefined;
  let interactionVersion = 0;
  const execute = vi.fn(async (input: Record<string, unknown>): Promise<E2eToolReceipt> => {
    calls.push(structuredClone(input));
    const operation = String(input.operation);
    const id = `${operation}-${calls.length}`;
    let observed: unknown = {};
    let artifactRefs: readonly string[] = [];
    let relatedAssertionIds: readonly string[] | undefined;
    if (operation === "desktop-status") {
      observed = { interactive: true, data: { cleanupConfirmed: true } };
    } else if (operation === "register-feature") {
      observed = input.feature;
    } else if (operation === "build") {
      buildRef = id;
      observed = { id, artifacts: [] };
    } else if (operation === "launch") {
      processRef = id;
      observed = { processRef, pid: 321 };
    } else if (operation === "enumerate") {
      observed = {
        data: {
          windows: [
            {
              pid: 321,
              title: "PowerToys.PowerLauncher",
              windowHandle: "123",
              owned: true,
              visible: true,
            },
          ],
        },
      };
    } else if (operation === "inspect") {
      observed = { data: { nodes: [{ automationId: "QueryTextBox", controlType: "Edit" }] } };
    } else if (["click", "keys", "type"].includes(operation)) {
      interactionVersion++;
    } else if (operation === "screenshot") {
      artifactRefs = [`${id}.png`];
      relatedAssertionIds = receipts
        .filter(
          (receipt) =>
            receipt.operation === "assert" &&
            receipt.status === "passed" &&
            receipt.featureId === input.featureId &&
            receipt.interactionVersion === interactionVersion,
        )
        .map((receipt) => receipt.id);
    } else if (operation === "stop") {
      observed = { stopped: true };
    } else if (operation === "command") {
      observed = { exitCode: 0, stdout: "", stderr: "" };
    } else if (operation !== "assert") {
      throw new Error(`Unexpected recipe operation: ${operation}`);
    }
    const receipt: E2eToolReceipt = {
      id,
      operation,
      status: "passed",
      assertion: operation === "assert",
      summary: `${operation} completed.`,
      observed,
      artifactRefs,
      ...(typeof input.featureId === "string" ? { featureId: input.featureId } : {}),
      ...(typeof input.assertionId === "string" ? { assertionId: input.assertionId } : {}),
      ...(buildRef === undefined ? {} : { buildRef }),
      ...(processRef === undefined ? {} : { processRef }),
      ...(relatedAssertionIds === undefined ? {} : { relatedAssertionIds }),
      interactionVersion,
      targetPid: 321,
      windowHandle: "123",
    };
    const result = override === undefined ? receipt : await override(input, receipt);
    receipts.push(result);
    return result;
  });
  return { calls, receipts, controller, execute };
}

async function completeRecipe(
  plan: ReturnType<typeof prepareE2eRecipe>,
  fixture: ReturnType<typeof executorFixture>,
  environment: Readonly<Record<string, string>> = {},
) {
  const outcome = runE2eRecipe(plan, {
    execute: fixture.execute,
    signal: fixture.controller.signal,
    environment,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

function freshStartupMarker() {
  const marker = Buffer.from("End PowerToys Run startup", "utf8");
  const close = vi.fn(async () => {});
  startupFiles.readdir.mockResolvedValue([
    {
      name: `${new Date().toISOString().slice(0, 10)}.txt`,
      isFile: () => true,
      isDirectory: () => false,
    },
  ]);
  startupFiles.stat.mockResolvedValue({ size: 0 });
  startupFiles.open.mockResolvedValue({
    stat: async () => ({ size: marker.length }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: marker.copy(buffer, offset, position, position + length),
      buffer,
    }),
    close,
  });
  return { close };
}

function lateDialogFixture(outcome: "reactivate" | "revealed" | "hidden") {
  let activationCount = 0;
  let dismissedCount = 0;
  const events: string[] = [];
  const fixture = executorFixture((input, receipt) => {
    const target = input.target as { windowHandle?: string } | undefined;
    if (input.operation === "command") {
      activationCount++;
      events.push("activate");
    } else if (input.operation === "enumerate") {
      if (activationCount > dismissedCount && (activationCount === 1 || outcome === "hidden")) {
        return {
          ...receipt,
          observed: {
            data: {
              windows: [
                {
                  pid: 321,
                  title: "PowerToys Run Plugin Initialization Error",
                  windowHandle: activationCount === 1 ? "456" : "789",
                  owned: true,
                  visible: true,
                },
              ],
            },
          },
        };
      }
      if (
        (outcome === "revealed" && dismissedCount === 1) ||
        (outcome === "reactivate" && activationCount === 2)
      )
        return receipt;
      return { ...receipt, observed: { data: { windows: [] } } };
    } else if (target?.windowHandle === "456" || target?.windowHandle === "789") {
      if (input.operation === "inspect") {
        return {
          ...receipt,
          observed: {
            data: {
              nodes: [
                { name: "Fail to initialize plugins" },
                { name: "OK", automationId: "2", className: "Button" },
              ],
            },
          },
        };
      }
      if (input.operation === "click") {
        dismissedCount++;
        events.push("dismiss");
      }
    } else if (input.operation === "inspect" && target?.windowHandle === "123") {
      events.push("ready");
    }
    return receipt;
  });
  return { ...fixture, events };
}

afterEach(() => {
  startupFiles.readdir.mockReset();
  startupFiles.stat.mockReset();
  startupFiles.open.mockReset();
  vi.useRealTimers();
});

describe("E2E recipe planning", () => {
  it("discovers recipes only for exact PowerToys repository identities and supported paths", () => {
    expect(
      listE2eRecipes("Fork-Owner/pOwErToYs", [calculatorPath]).map((recipe) => recipe.id),
    ).toEqual(expect.arrayContaining(["powertoys-calculator", "powertoys-run-query"]));
    expect(listE2eRecipes(repository, [converterPath])).toEqual([
      expect.objectContaining({ id: "powertoys-run-query", plugins: ["UnitConverter"] }),
    ]);
    for (const invalidRepository of [
      "PowerToys",
      "owner/PowerToys-Clone",
      "owner/nested/PowerToys",
    ]) {
      expect(listE2eRecipes(invalidRepository, [calculatorPath])).toEqual([]);
    }
    for (const unsupportedPath of [
      "README.md",
      "src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.CalculatorExtra/Main.cs",
      "src/modules/launcher/Plugins/Community.PowerToys.Run.Plugin.UnitConverterExtra/Main.cs",
    ]) {
      expect(listE2eRecipes(repository, [unsupportedPath])).toEqual([]);
    }
  });

  it("limits bundled scenario coverage to supported files that actually changed", () => {
    const unmodeledCalculatorPath =
      "src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.Calculator/NewBehavior.cs";
    const paths = [calculatorTestPath, unmodeledCalculatorPath, converterPath, "README.md"];
    const plan = prepareE2eRecipe(
      { operation: "run-recipe", recipeId: "powertoys-calculator" },
      repository,
      paths,
    );
    expect(plan.scenarios).toHaveLength(4);
    expect(plan.scenarios.flatMap((scenario) => scenario.feature.assertions)).toHaveLength(10);
    expect(new Set(plan.scenarios.flatMap((scenario) => scenario.feature.paths))).toEqual(
      new Set([calculatorTestPath]),
    );
    expect(plan.scenarios[2]!.query).toMatch(/2\s*\+\s*2/u);
    expect(plan.scenarios[3]!.requires).toBe(plan.scenarios[2]!.feature.id);
  });

  it("does not offer the fixed calculator scenarios for newly changed calculator files", () => {
    const path =
      "src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.Calculator/NewBehavior.cs";
    expect(listE2eRecipes(repository, [path]).map((recipe) => recipe.id)).toEqual([
      "powertoys-run-query",
    ]);
    expect(() =>
      prepareE2eRecipe({ operation: "run-recipe", recipeId: "powertoys-calculator" }, repository, [
        path,
      ]),
    ).toThrow();
  });

  it("accepts a custom UnitConverter query with a current feature plan", () => {
    const plan = prepareE2eRecipe(queryInput(), repository, [converterPath, "README.md"]);
    expect(plan).toMatchObject({
      id: "powertoys-run-query",
      plugin: "UnitConverter",
      scenarios: [{ query: "1 mile to km", feature: feature() }],
    });
  });

  it.each([
    ["empty query", queryInput([{ query: " ", feature: feature() }])],
    ["empty scenarios", queryInput([])],
    [
      "duplicate feature IDs",
      queryInput([
        { query: "1 mile to km", feature: feature() },
        { query: "2 mile to km", feature: feature() },
      ]),
    ],
    [
      "unknown dependency",
      queryInput([{ query: "1 mile to km", feature: feature(), requires: "missing" }]),
    ],
    [
      "forward dependency",
      queryInput([
        { query: "1 mile to km", feature: feature("first"), requires: "second" },
        { query: "2 mile to km", feature: feature("second") },
      ]),
    ],
    [
      "self dependency",
      queryInput([{ query: "1 mile to km", feature: feature(), requires: "conversion" }]),
    ],
    ["unsupported plugin", { ...queryInput(), plugin: "OtherPlugin" }],
    ["unknown recipe", { operation: "run-recipe", recipeId: "unknown" }],
  ])("rejects %s before execution", (_name, input) => {
    expect(() => prepareE2eRecipe(input, repository, [converterPath])).toThrow();
  });

  it("rejects paths from another plugin or outside the current changed files", () => {
    expect(() =>
      prepareE2eRecipe({ ...queryInput(), plugin: "Calculator" }, repository, [
        calculatorPath,
        converterPath,
      ]),
    ).toThrow();
    expect(() => prepareE2eRecipe(queryInput(), repository, [calculatorPath])).toThrow();
    expect(() =>
      prepareE2eRecipe(
        queryInput([
          { query: "1 mile to km", feature: feature("conversion", [converterPath, "README.md"]) },
        ]),
        repository,
        [converterPath, "README.md"],
      ),
    ).toThrow();
  });

  it("requires an earlier positive control for an absence assertion", () => {
    const absent = absenceFeature();
    expect(() =>
      prepareE2eRecipe(queryInput([{ query: "invalid query", feature: absent }]), repository, [
        converterPath,
      ]),
    ).toThrow();
    const plan = prepareE2eRecipe(
      queryInput([
        { query: "1 mile to km", feature: feature("control") },
        { query: "invalid query", feature: absent, requires: "control" },
      ]),
      repository,
      [converterPath],
    );
    expect(plan.scenarios[1]!.requires).toBe("control");
  });

  it.each(["missing", "stale value", "substring", "different control", "text property"])(
    "rejects an absence scenario with a %s query assertion",
    (invalidQueryAssertion) => {
      const absent = absenceFeature();
      const observation = queryAssertion("invalid query");
      if (invalidQueryAssertion === "stale value") observation.assertion!.expected = "old query";
      else if (invalidQueryAssertion === "substring") observation.assertion!.match = "contains";
      else if (invalidQueryAssertion === "different control")
        observation.selector.automationId = "AnotherQueryTextBox";
      else if (invalidQueryAssertion === "text property") observation.assertion!.property = "text";
      absent.assertions = [
        ...(invalidQueryAssertion === "missing" ? [] : [observation]),
        absent.assertions[1]!,
      ];
      expect(() =>
        prepareE2eRecipe(
          queryInput([
            { query: "1 mile to km", feature: feature("control") },
            { query: "invalid query", feature: absent, requires: "control" },
          ]),
          repository,
          [converterPath],
        ),
      ).toThrow();
    },
  );

  it("rejects a dependency that proves only the query text", () => {
    const control = feature("control");
    control.assertions = [queryAssertion("1 mile to km")];
    expect(() =>
      prepareE2eRecipe(
        queryInput([
          { query: "1 mile to km", feature: control },
          { query: "invalid query", feature: absenceFeature(), requires: "control" },
        ]),
        repository,
        [converterPath],
      ),
    ).toThrow();
  });

  it("rejects a dependency whose result assertions prove only absence", () => {
    expect(() =>
      prepareE2eRecipe(
        queryInput([
          { query: "1 mile to km", feature: feature("control") },
          {
            query: "first invalid query",
            feature: absenceFeature("first invalid query", "absence-control"),
            requires: "control",
          },
          { query: "invalid query", feature: absenceFeature(), requires: "absence-control" },
        ]),
        repository,
        [converterPath],
      ),
    ).toThrow();
  });

  it.each(["exists", "text", "value"] as const)(
    "accepts a dependency with a positive %s result assertion",
    (property) => {
      const control = feature("control");
      control.assertions = [
        {
          id: "result",
          kind: "ui",
          description: "The result control provides a positive observation.",
          selector: { automationId: "Result" },
          assertion: { property, expected: property === "exists" ? true : "1.609344" },
        },
      ];
      const plan = prepareE2eRecipe(
        queryInput([
          { query: "1 mile to km", feature: control },
          { query: "invalid query", feature: absenceFeature(), requires: "control" },
        ]),
        repository,
        [converterPath],
      );
      expect(plan.scenarios[1]!.requires).toBe("control");
    },
  );

  it("rejects process-only evidence in the interactive query recipe", () => {
    const processFeature: E2eFeaturePlan = {
      ...feature(),
      userVisible: false,
      assertions: [
        {
          id: "process",
          kind: "process",
          description: "The process exits successfully.",
          outputPath: "app.exe",
          arguments: [],
          expectedExitCode: 0,
          expectedOutputContains: "success",
        },
      ],
    };
    expect(() =>
      prepareE2eRecipe(
        queryInput([{ query: "1 mile to km", feature: processFeature }]),
        repository,
        [converterPath],
      ),
    ).toThrow();
  });
});

describe("E2E recipe execution", () => {
  it.each([
    {
      readiness: "a second activation",
      outcome: "reactivate" as const,
      activationCount: 2,
      events: ["activate", "dismiss", "activate", "ready"],
    },
    {
      readiness: "the window revealed by dismissal",
      outcome: "revealed" as const,
      activationCount: 1,
      events: ["activate", "dismiss", "ready"],
    },
  ])(
    "completes the recipe after a late initialization dialog using $readiness",
    async ({ outcome, activationCount, events }) => {
      vi.useFakeTimers();
      const logs = freshStartupMarker();
      const fixture = lateDialogFixture(outcome);
      const result = await completeRecipe(calculatorPlan(), fixture, {
        LOCALAPPDATA: "C:\\Fixture\\Local",
      });
      expect(result.features.map((entry) => entry.outcome)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed",
      ]);
      expect(result.cleanupConfirmed).toBe(true);
      expect(fixture.events.slice(0, events.length)).toEqual(events);
      expect(fixture.calls.filter((input) => input.operation === "build")).toHaveLength(1);
      expect(fixture.calls.filter((input) => input.operation === "command")).toHaveLength(
        activationCount,
      );
      expect(fixture.calls.filter((input) => input.operation === "assert")).toHaveLength(10);
      expect(fixture.calls.filter((input) => input.operation === "screenshot")).toHaveLength(4);
      const firstReadyInspection = fixture.calls.findIndex(
        (input) =>
          input.operation === "inspect" &&
          (input.target as { windowHandle?: string } | undefined)?.windowHandle === "123",
      );
      expect(firstReadyInspection).toBeGreaterThan(-1);
      expect(
        fixture.calls.slice(firstReadyInspection).some((input) => input.operation === "command"),
      ).toBe(false);
      expect(logs.close).toHaveBeenCalledTimes(activationCount);
    },
  );

  it("does not send a third activation after another late initialization dialog is dismissed", async () => {
    vi.useFakeTimers();
    freshStartupMarker();
    const fixture = lateDialogFixture("hidden");
    const result = await completeRecipe(calculatorPlan(), fixture, {
      LOCALAPPDATA: "C:\\Fixture\\Local",
    });
    expect(fixture.events).toEqual(["activate", "dismiss", "activate", "dismiss"]);
    expect(fixture.calls.filter((input) => input.operation === "command")).toHaveLength(2);
    expect(fixture.calls.filter((input) => input.operation === "build")).toHaveLength(1);
    expect(result.features.every((entry) => entry.outcome === "blocked")).toBe(true);
    expect(fixture.calls.some((input) => input.operation === "type")).toBe(false);
    expect(fixture.calls.some((input) => input.operation === "assert")).toBe(false);
    expect(result.cleanupConfirmed).toBe(true);
  });

  it("shares one build while preserving assertion and fresh screenshot receipts for every scenario", async () => {
    vi.useFakeTimers();
    const plan = calculatorPlan();
    const fixture = executorFixture();
    const result = await completeRecipe(plan, fixture);
    expect(result.recipeId).toBe("powertoys-calculator");
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.features.map((entry) => entry.outcome)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    const operations = fixture.calls.map((input) => input.operation);
    expect(operations.filter((operation) => operation === "build")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "register-feature")).toHaveLength(4);
    expect(operations.filter((operation) => operation === "assert")).toHaveLength(10);
    expect(operations.filter((operation) => operation === "screenshot")).toHaveLength(4);
    expect(operations.lastIndexOf("register-feature")).toBeLessThan(operations.indexOf("build"));
    expect(operations.slice(-2)).toEqual(["stop", "desktop-status"]);
    expect(
      fixture.calls.filter((input) => input.operation === "type").map((input) => input.text),
    ).toEqual(plan.scenarios.map((scenario) => scenario.query));
    for (const scenario of plan.scenarios) {
      const entry = result.features.find((item) => item.featureId === scenario.feature.id)!;
      const assertions = fixture.receipts.filter(
        (receipt) => receipt.operation === "assert" && receipt.featureId === entry.featureId,
      );
      const screenshot = fixture.receipts.find(
        (receipt) => receipt.operation === "screenshot" && receipt.featureId === entry.featureId,
      )!;
      expect(entry.assertionReceiptIds).toEqual(assertions.map((receipt) => receipt.id));
      expect(entry.mediaReceiptIds).toEqual([screenshot.id]);
      expect(screenshot.relatedAssertionIds).toEqual(entry.assertionReceiptIds);
      expect(screenshot.artifactRefs).not.toHaveLength(0);
      const firstAssertionIndex = fixture.calls.findIndex(
        (input) => input.operation === "assert" && input.featureId === entry.featureId,
      );
      const screenshotIndex = fixture.calls.findIndex(
        (input) => input.operation === "screenshot" && input.featureId === entry.featureId,
      );
      expect(
        fixture.calls
          .slice(firstAssertionIndex, screenshotIndex)
          .every((input) => input.operation === "assert"),
      ).toBe(true);
    }
  });

  it("blocks a dependent negative scenario when its positive control fails", async () => {
    vi.useFakeTimers();
    const plan = calculatorPlan();
    const control = plan.scenarios[2]!.feature.id;
    const fixture = executorFixture((input, receipt) =>
      input.operation === "assert" && input.featureId === control
        ? {
            ...receipt,
            status: "failed",
            summary: "The positive control did not produce the expected result.",
          }
        : receipt,
    );
    const result = await completeRecipe(plan, fixture);
    expect(result.features.map((entry) => entry.outcome)).toEqual([
      "passed",
      "passed",
      "failed",
      "blocked",
    ]);
    expect(
      fixture.calls.some(
        (input) => input.operation === "type" && input.featureId === plan.scenarios[3]!.feature.id,
      ),
    ).toBe(false);
    expect(result.features[3]!.assertionReceiptIds).toEqual([]);
    expect(result.features[3]!.mediaReceiptIds).toEqual([]);
  });

  it("retains a failed assertion while allowing independent later scenarios to run", async () => {
    vi.useFakeTimers();
    const plan = calculatorPlan();
    const failedFeature = plan.scenarios[0]!.feature.id;
    const fixture = executorFixture((input, receipt) =>
      input.operation === "assert" && input.featureId === failedFeature
        ? { ...receipt, status: "failed", summary: "The expected error text was not shown." }
        : receipt,
    );
    const result = await completeRecipe(plan, fixture);
    expect(result.features.map((entry) => entry.outcome)).toEqual([
      "failed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(result.features[0]!.assertionReceiptIds.length).toBeGreaterThan(0);
    expect(result.features[0]!.mediaReceiptIds).toEqual([]);
  });

  it("blocks all scenarios when the controlled build cannot complete", async () => {
    vi.useFakeTimers();
    const fixture = executorFixture((input, receipt) =>
      input.operation === "build"
        ? { ...receipt, status: "blocked", summary: "The required solution is unavailable." }
        : receipt,
    );
    const result = await completeRecipe(calculatorPlan(), fixture);
    expect(result.features.every((entry) => entry.outcome === "blocked")).toBe(true);
    expect(fixture.calls.some((input) => input.operation === "launch")).toBe(false);
    expect(fixture.calls.some((input) => input.operation === "assert")).toBe(false);
  });

  it("does not build when the interactive desktop is unavailable", async () => {
    vi.useFakeTimers();
    const fixture = executorFixture((input, receipt) =>
      input.operation === "desktop-status"
        ? { ...receipt, status: "blocked", observed: { interactive: false, data: {} } }
        : receipt,
    );
    const result = await completeRecipe(calculatorPlan(), fixture);
    expect(result.features.every((entry) => entry.outcome === "blocked")).toBe(true);
    expect(fixture.calls.some((input) => input.operation === "build")).toBe(false);
  });

  it("does not interact with a visible Launcher window outside the owned application", async () => {
    vi.useFakeTimers();
    const fixture = executorFixture((input, receipt) =>
      input.operation === "enumerate"
        ? {
            ...receipt,
            observed: {
              data: {
                windows: [
                  {
                    pid: 999,
                    title: "PowerToys.PowerLauncher",
                    windowHandle: "456",
                    owned: false,
                    visible: true,
                  },
                ],
              },
            },
          }
        : receipt,
    );
    const result = await completeRecipe(calculatorPlan(), fixture);
    expect(result.features.every((entry) => entry.outcome === "blocked")).toBe(true);
    expect(
      fixture.calls.some((input) =>
        ["click", "keys", "type", "assert"].includes(String(input.operation)),
      ),
    ).toBe(false);
    expect(fixture.calls.some((input) => input.operation === "stop")).toBe(true);
  });

  it.each(["artifact", "assertion link"])(
    "blocks passing assertions without screenshot %s evidence",
    async (missing) => {
      vi.useFakeTimers();
      const fixture = executorFixture((input, receipt) =>
        input.operation === "screenshot"
          ? {
              ...receipt,
              ...(missing === "artifact" ? { artifactRefs: [] } : { relatedAssertionIds: [] }),
            }
          : receipt,
      );
      const plan = prepareE2eRecipe(queryInput(), repository, [converterPath]);
      const result = await completeRecipe(plan, fixture);
      expect(result.features[0]!.outcome).toBe("blocked");
      expect(result.features[0]!.assertionReceiptIds).toHaveLength(1);
      expect(result.features[0]!.mediaReceiptIds).toEqual([
        fixture.receipts.find((receipt) => receipt.operation === "screenshot")!.id,
      ]);
    },
  );

  it("does not report success when final cleanup is unconfirmed", async () => {
    vi.useFakeTimers();
    let desktopChecks = 0;
    const fixture = executorFixture((input, receipt) => {
      if (input.operation !== "desktop-status" || ++desktopChecks === 1) return receipt;
      return { ...receipt, observed: { interactive: true, data: { cleanupConfirmed: false } } };
    });
    const result = await completeRecipe(calculatorPlan(), fixture);
    expect(result.cleanupConfirmed).toBe(false);
    expect(result.features.every((entry) => entry.outcome === "blocked")).toBe(true);
  });

  it.each(["tool response", "query settling"])(
    "propagates cancellation during %s before following scenarios or assertions run",
    async (phase) => {
      vi.useFakeTimers();
      const reason = new Error("The task was cancelled.");
      const fixture = executorFixture((input, receipt) => {
        if (input.operation === "type") {
          if (phase === "tool response") fixture.controller.abort(reason);
          else setTimeout(() => fixture.controller.abort(reason), 100);
        }
        return receipt;
      });
      const pending = completeRecipe(calculatorPlan(), fixture);
      await expect(pending).rejects.toBe(reason);
      expect(fixture.calls.filter((input) => input.operation === "type")).toHaveLength(1);
      expect(fixture.calls.some((input) => input.operation === "assert")).toBe(false);
    },
  );
});
