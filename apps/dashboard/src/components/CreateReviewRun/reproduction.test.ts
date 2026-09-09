import type {
  IssueReproductionCaseRequest,
  IssueReproductionRequestV1,
  ObservationEquals,
  ObservationValue,
  ReproductionObservationRef,
  ValidationCommandStep,
  WebUiConfiguration,
  WindowsUiConfiguration,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { defaultProfileConfig } from "../../pages/ValidationProfiles/forms";
import type { RunProfileOption } from "./helpers";
import {
  getObservationOptions,
  getPreconditionChecks,
  getReproductionProfileOptions,
  observationRefKey,
  observationValueFromInput,
  reproductionProfileUnavailableReason,
  validateAndCanonicalizeReproduction,
} from "./reproduction";

const timestamp = "2026-09-07T00:00:00.000Z";

function command(id: string): ValidationCommandStep {
  return {
    id,
    name: id,
    command: { executable: "node", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 60_000,
    required: true,
  };
}

function profile(): RunProfileOption {
  return {
    binding: {
      repositoryId: "repository-1",
      profileId: "profile-1",
      profileVersionId: "version-1",
      version: 1,
      enabled: true,
    },
    version: {
      id: "version-1",
      profileId: "profile-1",
      repositoryId: "repository-1",
      name: "Probe profile",
      version: 1,
      required: false,
      configSha256: "a".repeat(64),
      createdAt: timestamp,
      publishedAt: timestamp,
      createdBy: "operator-1",
      workflowKind: "issue_validation",
      target: "headless",
      outputSchemaVersion: "ValidationReportV1",
      config: {
        ...defaultProfileConfig(),
        setup: [command("setup")],
        test: [
          {
            ...command("probe"),
            probeOutput: {
              schemaVersion: "TestProbeOutputDeclarationV1",
              fields: [
                { id: "visible", description: "Visibility", type: "boolean" },
                { id: "text", description: "Text", type: "string" },
                { id: "count", description: "Count", type: "number" },
              ],
            },
          },
        ],
      },
    },
  };
}

function webProfile(): RunProfileOption {
  const option = profile();
  const ui: WebUiConfiguration = {
    schemaVersion: "UiScenariosV1",
    target: "web",
    service: {
      origin: "managed_loopback",
      portEnvironmentVariable: "PORT",
      navigation: "same_origin",
    },
    browser: { engine: "chromium", headless: true, viewport: { width: 1280, height: 720 } },
    launch: {
      stepId: "launch",
      mode: "persistent",
      readiness: { kind: "http", path: "/", expectedStatus: 200, timeoutMs: 10_000 },
    },
    reset: { strategy: "restart_process" },
    evidence: {
      screenshots: "every_assertion",
      screenshotScope: "viewport",
      required: true,
      trace: "off",
    },
    scenarios: [
      {
        id: "scenario",
        name: "Scenario",
        required: true,
        timeoutMs: 60_000,
        path: "/",
        steps: [
          {
            id: "click",
            name: "Click",
            action: "click",
            timeoutMs: 1_000,
            locator: { by: "testId", testId: "button" },
          },
          {
            id: "fill",
            name: "Fill",
            action: "fill",
            value: "fixture",
            timeoutMs: 1_000,
            locator: { by: "testId", testId: "field" },
          },
          {
            id: "visible",
            name: "Visible",
            action: "assertVisible",
            expected: true,
            timeoutMs: 1_000,
            locator: { by: "testId", testId: "status" },
          },
          {
            id: "text",
            name: "Text",
            action: "assertText",
            expected: "Ready",
            match: "contains",
            timeoutMs: 1_000,
            locator: { by: "testId", testId: "status" },
          },
          {
            id: "value",
            name: "Value",
            action: "assertValue",
            expected: "",
            timeoutMs: 1_000,
            locator: { by: "testId", testId: "field" },
          },
        ],
      },
    ],
  };
  return {
    ...option,
    version: {
      ...option.version,
      workflowKind: "issue_validation",
      target: "web",
      outputSchemaVersion: "ValidationReportV1",
      config: { ...option.version.config, launch: [command("launch")], ui },
    },
  };
}

function windowsProfile(): RunProfileOption {
  const option = webProfile();
  const scenario = (option.version.config.ui as WebUiConfiguration).scenarios[0]!;
  const config: WindowsUiConfiguration = {
    schemaVersion: "UiScenariosV1",
    target: "windows_desktop",
    desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
    launch: {
      stepId: "launch",
      mode: "persistent",
      readiness: { kind: "window", window: { title: "Public fixture" }, timeoutMs: 10_000 },
    },
    reset: { strategy: "restart_process" },
    evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
    scenarios: [
      {
        id: scenario.id,
        name: scenario.name,
        required: scenario.required,
        timeoutMs: scenario.timeoutMs,
        steps: scenario.steps.map((step) => ({
          ...step,
          locator: { by: "automationId", automationId: step.id },
        })),
      },
    ],
  };
  return {
    ...option,
    version: {
      ...option.version,
      workflowKind: "issue_validation",
      target: "windows_desktop",
      outputSchemaVersion: "ValidationReportV1",
      config: { ...option.version.config, ui: config },
    },
  };
}

const probe = (observationId: string): ReproductionObservationRef => ({
  kind: "probe_value",
  testStepId: "probe",
  observationId,
});
const ui = (stepId: string): ReproductionObservationRef => ({
  kind: "ui_assertion",
  scenarioId: "scenario",
  stepId,
});
const equality = (
  observation: ReproductionObservationRef,
  equals: ObservationValue,
): ObservationEquals => ({ observation, equals });

function request(changes: Partial<IssueReproductionCaseRequest> = {}): IssueReproductionRequestV1 {
  return {
    schemaVersion: "IssueReproductionRequestV1",
    claim: "  The fixture reproduces the reported behavior.  ",
    cases: [
      {
        id: "case-1",
        context: "  Public fixture state.  ",
        profileId: "profile-1",
        expectedProfileVersionId: "version-1",
        preconditions: [],
        presentWhen: { allOf: [equality(probe("visible"), { type: "boolean", value: true })] },
        absentWhen: { allOf: [equality(probe("visible"), { type: "boolean", value: false })] },
        ...changes,
      },
    ],
  };
}

const validate = (input: IssueReproductionRequestV1, option = profile()) =>
  validateAndCanonicalizeReproduction(input, [option], ["profile-1"]);

describe("reproduction profile and observation authoring", () => {
  it("enumerates declared probes and assertions with exact scalar types and qualified checks", () => {
    const version = webProfile().version;
    const options = getObservationOptions(version);
    expect(options.map((option) => [option.ref.kind, option.type, option.checkId])).toEqual([
      ["probe_value", "boolean", "version-1:probe"],
      ["probe_value", "string", "version-1:probe"],
      ["probe_value", "number", "version-1:probe"],
      ["ui_assertion", "boolean", "version-1:scenario"],
      ["ui_assertion", "string", "version-1:scenario"],
      ["ui_assertion", "string", "version-1:scenario"],
    ]);
    expect(options[0]?.description).toBe("Visibility");
    expect(options.map((option) => option.key)).not.toContain(observationRefKey(ui("click")));
    expect(options.map((option) => option.key)).not.toContain(observationRefKey(ui("fill")));
    expect(getPreconditionChecks(version).map((check) => check.id)).toEqual([
      "version-1:setup",
      "version-1:probe",
      "version-1:scenario",
    ]);
  });

  it("keeps colon-containing observation identifiers unambiguous", () => {
    expect(
      observationRefKey({ kind: "probe_value", testStepId: "a:b", observationId: "c" }),
    ).not.toBe(observationRefKey({ kind: "probe_value", testStepId: "a", observationId: "b:c" }));
  });

  it("reports capability suitability separately from selected and required profile state", () => {
    const option = profile();
    expect(getReproductionProfileOptions([option], [])[0]).toMatchObject({
      selected: false,
      suitable: true,
      reason: null,
    });
    expect(
      getReproductionProfileOptions(
        [{ ...option, version: { ...option.version, required: true } }],
        [],
      )[0],
    ).toMatchObject({ selected: true, suitable: true });
    expect(
      reproductionProfileUnavailableReason({ ...option.version, config: defaultProfileConfig() }),
    ).toContain("no declared test probe fields or UI assertions");
    expect(
      reproductionProfileUnavailableReason({
        ...option.version,
        workflowKind: "issue_triage",
        target: "headless",
        outputSchemaVersion: "IssueTriageV2",
      }),
    ).toContain("Issue validation");
  });

  it.each(["setup", "build", "test", "launch", "cleanup"] as const)(
    "rejects a UI profile with a secret reference in the %s phase",
    (phase) => {
      const option = webProfile();
      const step =
        phase === "launch" ? option.version.config.launch[0]! : command(`secret-${phase}`);
      step.command.environment = [{ name: "FIXTURE_TOKEN", secretRef: "credential-1" }];
      if (phase !== "launch") option.version.config[phase].push(step);
      expect(reproductionProfileUnavailableReason(option.version)).toContain(
        "without secret references",
      );
      expect(() => validate(request(), option)).toThrow("without secret references");
    },
  );

  it.each(["always", "on_failure", undefined] as const)(
    "requires Web traces to be explicitly off, received %s",
    (trace) => {
      const option = webProfile();
      const config = option.version.config.ui as WebUiConfiguration;
      config.evidence.trace = trace as WebUiConfiguration["evidence"]["trace"];
      expect(reproductionProfileUnavailableReason(option.version)).toContain(
        "traces explicitly turned off",
      );
    },
  );

  it("allows headless probe commands with secret references and public UI profiles", () => {
    const option = profile();
    option.version.config.setup[0]!.command.environment = [
      { name: "TOKEN", secretRef: "fixture-token" },
    ];
    expect(reproductionProfileUnavailableReason(option.version)).toBeNull();
    expect(reproductionProfileUnavailableReason(webProfile().version)).toBeNull();
  });

  it("supports Windows observations without a Web trace policy and rejects secret-bearing Windows commands", () => {
    const option = windowsProfile();
    expect(reproductionProfileUnavailableReason(option.version)).toBeNull();
    expect(getObservationOptions(option.version).map((observation) => observation.type)).toEqual([
      "boolean",
      "string",
      "number",
      "boolean",
      "string",
      "string",
    ]);
    expect(
      validate(
        request({
          presentWhen: { allOf: [equality(ui("visible"), { type: "boolean", value: false })] },
          absentWhen: { allOf: [equality(ui("visible"), { type: "boolean", value: true })] },
        }),
        option,
      ).cases,
    ).toHaveLength(1);
    option.version.config.test[0]!.command.environment = [{ name: "TOKEN", secretRef: "token-1" }];
    expect(reproductionProfileUnavailableReason(option.version)).toContain(
      "without secret references",
    );
  });
});

describe("typed reproduction values", () => {
  it.each(["", "  ", "  expected value\n", "\uFEFFfixture"])(
    "preserves the string observation %j byte for byte",
    (input) => {
      expect(observationValueFromInput("string", input)).toEqual({ type: "string", value: input });
    },
  );

  it.each(["", " ", "1e309", "0x10", true, NaN, Infinity, -Infinity])(
    "rejects invalid numeric input %s",
    (input) => {
      expect(() => observationValueFromInput("number", input)).toThrow("finite numeric");
    },
  );

  it("preserves false and canonicalizes numeric negative zero", () => {
    expect(observationValueFromInput("boolean", false)).toEqual({ type: "boolean", value: false });
    expect(observationValueFromInput("boolean", "false")).toEqual({
      type: "boolean",
      value: false,
    });
    expect(observationValueFromInput("number", "-0")).toEqual({ type: "number", value: 0 });
    expect(observationValueFromInput("number", "1.25e2")).toEqual({ type: "number", value: 125 });
    expect(() => observationValueFromInput("boolean", "yes")).toThrow("true or false");
  });

  it.each(["\uD800", "contains\u0000nul", "a".repeat(2049)])(
    "rejects invalid string value %j",
    (input) => {
      expect(() => observationValueFromInput("string", input)).toThrow();
    },
  );
});

describe("reproduction request preflight", () => {
  it("preserves positive-only intent and rejects an unproven absent interpretation", () => {
    expect(validate(request({ absentWhen: null })).cases[0]?.absentWhen).toBeNull();
    expect(() =>
      validate(
        request({
          absentWhen: { allOf: [equality(probe("text"), { type: "string", value: "unrelated" })] },
        }),
      ),
    ).toThrow("provably disjoint");
  });

  it("canonicalizes semantic sets and property insertion order while preserving authored text", () => {
    const input = request({
      preconditions: [
        { kind: "check_passed", checkId: "version-1:setup" },
        {
          kind: "observation_equals",
          predicate: equality(probe("count"), { type: "number", value: -0 }),
        },
      ],
      presentWhen: {
        allOf: [
          equality(probe("visible"), { type: "boolean", value: true }),
          equality(probe("text"), { type: "string", value: "  " }),
        ],
      },
      absentWhen: {
        allOf: [
          equality(probe("visible"), { type: "boolean", value: false }),
          equality(probe("text"), { type: "string", value: "" }),
        ],
      },
    });
    input.cases.push({ ...structuredClone(input.cases[0]!), id: "Case-2" });
    const reordered = JSON.parse(JSON.stringify(input), (_key, value: unknown) => {
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.reverse();
      return Object.fromEntries(Object.entries(value).reverse());
    }) as IssueReproductionRequestV1;
    const canonical = validate(input);
    expect(JSON.stringify(validate(reordered))).toBe(JSON.stringify(canonical));
    expect(validate(canonical)).toEqual(canonical);
    expect(canonical.claim).toBe(input.claim);
    expect(canonical.cases[0]?.context).toBe(input.cases[0]?.context);
    expect(canonical.cases[0]?.preconditions).toContainEqual({
      kind: "observation_equals",
      predicate: equality(probe("count"), { type: "number", value: 0 }),
    });
    expect(
      Object.is(
        input.cases[0]?.preconditions[1]?.kind === "observation_equals"
          ? input.cases[0].preconditions[1].predicate.equals.value
          : 1,
        -0,
      ),
    ).toBe(true);
    expect(canonical.cases[0]?.presentWhen.allOf).toContainEqual(
      equality(probe("text"), { type: "string", value: "  " }),
    );
  });

  it("rejects duplicate case IDs and observation references even when values differ", () => {
    const input = request();
    input.cases.push({ ...structuredClone(input.cases[0]!), context: "Another context" });
    expect(() => validate(input)).toThrow("case IDs must be unique");
    expect(() =>
      validate(
        request({
          presentWhen: {
            allOf: [
              equality(probe("visible"), { type: "boolean", value: true }),
              equality(probe("visible"), { type: "boolean", value: false }),
            ],
          },
        }),
      ),
    ).toThrow("observation references must be unique");
    expect(() =>
      validate(
        request({
          preconditions: [
            {
              kind: "observation_equals",
              predicate: equality(probe("count"), { type: "number", value: 0 }),
            },
            {
              kind: "observation_equals",
              predicate: equality(probe("count"), { type: "number", value: 1 }),
            },
          ],
        }),
      ),
    ).toThrow("preconditions must be unique");
  });

  it.each([NaN, Infinity, -Infinity])("rejects a non-finite authored value %s", (value) => {
    expect(() =>
      validate(
        request({
          presentWhen: { allOf: [equality(probe("count"), { type: "number", value })] },
          absentWhen: null,
        }),
      ),
    ).toThrow("numbers must be finite");
  });

  it("rejects incorrect scalar types, unsupported observations and forged checks", () => {
    expect(() =>
      validate(
        request({
          presentWhen: { allOf: [equality(probe("count"), { type: "string", value: "1" })] },
          absentWhen: null,
        }),
      ),
    ).toThrow("wrong type");
    expect(() =>
      validate(
        request({
          presentWhen: { allOf: [equality(probe("undeclared"), { type: "boolean", value: true })] },
          absentWhen: null,
        }),
      ),
    ).toThrow("unsupported");
    expect(() =>
      validate(
        request({ preconditions: [{ kind: "check_passed", checkId: "version-1:missing" }] }),
      ),
    ).toThrow("existing qualified check");
    expect(() =>
      validate(
        request({ preconditions: [{ kind: "check_passed", checkId: "version-1:launch" }] }),
        webProfile(),
      ),
    ).toThrow("existing qualified check");
  });

  it("requires compatible preconditions and exact types across both signatures", () => {
    expect(() =>
      validate(
        request({
          preconditions: [
            {
              kind: "observation_equals",
              predicate: equality(probe("visible"), { type: "boolean", value: true }),
            },
          ],
        }),
      ),
    ).toThrow("must be satisfiable");
    expect(() =>
      validate(
        request({
          absentWhen: { allOf: [equality(probe("visible"), { type: "string", value: "false" })] },
        }),
      ),
    ).toThrow("one exact type");
  });

  it("preserves frozen profile expectations and rejects deselected cases without changing the draft", () => {
    const input = request();
    const before = structuredClone(input);
    expect(() => validateAndCanonicalizeReproduction(input, [profile()], [])).toThrow(
      "Reselect the profile or remove this case",
    );
    expect(input).toEqual(before);
    expect(() => validate(request({ expectedProfileVersionId: "version-previous" }))).toThrow(
      "Reload the repository bindings, then reselect",
    );
    const required = profile();
    required.version.required = true;
    expect(validateAndCanonicalizeReproduction(input, [required], []).cases).toHaveLength(1);
  });

  it("honors UI stop-on-failure ordering independently of authored predicate ordering", () => {
    const option = webProfile();
    const visible = equality(ui("visible"), { type: "boolean", value: false });
    const text = equality(ui("text"), { type: "string", value: "Ready" });
    expect(() =>
      validate(request({ presentWhen: { allOf: [text, visible] }, absentWhen: null }), option),
    ).toThrow("cannot reach an assertion");
    expect(() =>
      validate(
        request({
          preconditions: [{ kind: "observation_equals", predicate: visible }],
          presentWhen: { allOf: [text] },
          absentWhen: null,
        }),
        option,
      ),
    ).toThrow("cannot reach an assertion");
  });

  it("checks UI assertion reachability in the absent signature too", () => {
    const option = webProfile();
    expect(() =>
      validate(
        request({
          presentWhen: { allOf: [equality(ui("visible"), { type: "boolean", value: true })] },
          absentWhen: {
            allOf: [
              equality(ui("visible"), { type: "boolean", value: false }),
              equality(ui("text"), { type: "string", value: "Ready" }),
            ],
          },
        }),
        option,
      ),
    ).toThrow("cannot reach an assertion");
  });

  it("rejects a passed UI check contradicted by an equality and supports contains assertions", () => {
    const option = webProfile();
    expect(() =>
      validate(
        request({
          preconditions: [{ kind: "check_passed", checkId: "version-1:scenario" }],
          presentWhen: { allOf: [equality(ui("visible"), { type: "boolean", value: false })] },
          absentWhen: null,
        }),
        option,
      ),
    ).toThrow("passed UI check contradicts");
    expect(
      validate(
        request({
          preconditions: [{ kind: "check_passed", checkId: "version-1:scenario" }],
          presentWhen: {
            allOf: [
              equality(ui("text"), { type: "string", value: "Not Ready Yet" }),
              equality(ui("value"), { type: "string", value: "" }),
            ],
          },
          absentWhen: null,
        }),
        option,
      ).cases,
    ).toHaveLength(1);
  });
});
