import type {
  RepositoryValidationProfileBinding,
  TestProbeOutputDeclarationV1,
  ValidationCommandStep,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildProfileBinding,
  buildProfilePublish,
  collectProfileBindings,
  configurationErrorMessage,
  defaultProfileConfig,
  isProfileConflict,
  type ProfileFormValues,
  parseProfileConfig,
  profileFormValues,
  profileOutputSchemas,
  profileTargets,
  updateProfileProbeFields,
} from "./forms";

type StaticBuildProfile = ValidationProfileVersion & {
  workflowKind: "pr_static_build";
  target: "headless";
  outputSchemaVersion: "PrReviewPlanV2";
};

const step = (overrides: Partial<ValidationCommandStep> = {}): ValidationCommandStep => ({
  id: "step-1",
  name: "Run checks",
  command: {
    executable: "node",
    args: ["scripts/check.mjs"],
    workingDirectory: ".",
    environment: [],
  },
  timeoutMs: 60_000,
  required: true,
  ...overrides,
});

const profile = (overrides: Partial<StaticBuildProfile> = {}): StaticBuildProfile => ({
  id: "profile-version-7",
  profileId: "profile-1",
  repositoryId: "repository-1",
  name: "Build checks",
  workflowKind: "pr_static_build",
  target: "headless",
  required: true,
  config: { ...defaultProfileConfig(), build: [step()] },
  outputSchemaVersion: "PrReviewPlanV2",
  version: 7,
  configSha256: "a".repeat(64),
  createdAt: "2026-09-07T00:00:00.000Z",
  publishedAt: "2026-09-07T00:00:00.000Z",
  createdBy: "operator-1",
  ...overrides,
});

const values = (overrides: Partial<ProfileFormValues> = {}): ProfileFormValues => ({
  ...profileFormValues(),
  name: "Build checks",
  ...overrides,
});

const binding = (
  overrides: Partial<RepositoryValidationProfileBinding> = {},
): RepositoryValidationProfileBinding => ({
  repositoryId: "repository-1",
  profileId: "profile-1",
  profileVersionId: "profile-version-7",
  enabled: true,
  version: 11,
  ...overrides,
});

const bindings = (count: number, start = 0): RepositoryValidationProfileBinding[] =>
  Array.from({ length: count }, (_, index) =>
    binding({ profileId: `profile-${start + index}`, enabled: index % 2 === 0 }),
  );

const bindingPage = (
  items: RepositoryValidationProfileBinding[],
  total: number,
  page = 1,
  pageSize = 50,
) => ({ items, total, page, pageSize });

describe("validation profile configuration", () => {
  it("provides independent defaults and round-trips published configuration", () => {
    const first = defaultProfileConfig();
    first.build.push(step());
    expect(defaultProfileConfig().build).toEqual([]);

    const published = profile({ required: false });
    const form = profileFormValues(published);
    expect(form).toMatchObject({
      name: published.name,
      workflowKind: "pr_static_build",
      target: "headless",
      required: false,
    });
    expect(parseProfileConfig(form.configJson, form.workflowKind)).toEqual(published.config);
    expect(profileFormValues()).toMatchObject({
      name: "",
      workflowKind: "pr_static_build",
      target: "headless",
      required: true,
    });
  });

  it.each(["", "{", '{"schemaVersion":"ValidationProfileV1",}'])(
    "rejects malformed JSON %j",
    (text) => {
      expect(() => parseProfileConfig(text, "pr_static_build")).toThrow("Enter valid JSON");
    },
  );

  it.each([
    ["null", null],
    ["an array", []],
    ["an unknown root field", { ...defaultProfileConfig(), unexpected: true }],
    [
      "a different schema version",
      { ...defaultProfileConfig(), schemaVersion: "ValidationProfileV2" },
    ],
    ["an incomplete step", { ...defaultProfileConfig(), build: [{ id: "step-1" }] }],
    [
      "an unknown step field",
      { ...defaultProfileConfig(), build: [{ ...step(), unexpected: true }] },
    ],
    [
      "an unknown command field",
      {
        ...defaultProfileConfig(),
        build: [{ ...step(), command: { ...step().command, shell: true } }],
      },
    ],
    [
      "an empty executable",
      {
        ...defaultProfileConfig(),
        build: [{ ...step(), command: { ...step().command, executable: "" } }],
      },
    ],
    [
      "an escaping working directory",
      {
        ...defaultProfileConfig(),
        build: [{ ...step(), command: { ...step().command, workingDirectory: "../outside" } }],
      },
    ],
    [
      "a string step timeout",
      { ...defaultProfileConfig(), build: [{ ...step(), timeoutMs: "60000" }] },
    ],
    [
      "duplicate capabilities",
      { ...defaultProfileConfig(), requiredCapabilities: ["node", "node"] },
    ],
  ])("rejects %s through the configuration schema", (_label, config) => {
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
      "Configuration does not match ValidationProfileV1",
    );
  });

  it.each(["hardTimeoutMs", "noProgressTimeoutMs"] as const)(
    "enforces the integer and range constraints for %s",
    (field) => {
      for (const timeout of [0, 999, 1_000.5, 86_400_001]) {
        expect(() =>
          parseProfileConfig(
            JSON.stringify({ ...defaultProfileConfig(), [field]: timeout }),
            "pr_static_build",
          ),
        ).toThrow("Configuration does not match ValidationProfileV1");
      }
    },
  );

  it("rejects a no-progress timeout above the hard timeout", () => {
    const config = {
      ...defaultProfileConfig(),
      hardTimeoutMs: 60_000,
      noProgressTimeoutMs: 60_001,
    };
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
      "The no-progress timeout must not exceed the hard timeout.",
    );
  });

  it("rejects a step timeout above the profile hard timeout", () => {
    const config = { ...defaultProfileConfig(), build: [step({ timeoutMs: 1_800_001 })] };
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
      "Step step-1 timeout exceeds the profile hard timeout.",
    );
  });

  it.each([{ setup: [step(), step()] }, { setup: [step()], cleanup: [step()] }])(
    "rejects duplicate step IDs within and across stages: %j",
    (stages) => {
      expect(() =>
        parseProfileConfig(
          JSON.stringify({ ...defaultProfileConfig(), ...stages }),
          "pr_static_build",
        ),
      ).toThrow("Step ID step-1 is duplicated.");
    },
  );

  it("accepts secret references and ordinary environment values without rewriting them", () => {
    const command = {
      ...step().command,
      environment: [
        { name: "GITHUB_TOKEN", secretRef: "secret:github-token" },
        { name: "NODE_ENV", value: "test" },
      ],
    };
    const config = { ...defaultProfileConfig(), test: [step({ command })] };
    expect(parseProfileConfig(JSON.stringify(config), "pr_static_build")).toEqual(config);
  });

  it.each(["GITHUB_TOKEN", "api_key", "PASSWORD", "BUILD_SECRET", "AUTHORIZATION"])(
    "requires a secret reference for %s",
    (name) => {
      const command = { ...step().command, environment: [{ name, value: "sensitive-value" }] };
      const config = { ...defaultProfileConfig(), test: [step({ command })] };
      expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
        `environment variable ${name} must use a secret reference.`,
      );
    },
  );

  it.each([
    { name: "TOKEN", secretRef: "" },
    { name: "TOKEN", secretRef: "secret with spaces" },
    { name: "TOKEN", secretRef: "secret-1", value: "literal" },
    { name: "INVALID-NAME", secretRef: "secret-1" },
    { name: "NODE_ENV", value: "test", unexpected: true },
  ])("rejects invalid environment entries: %j", (variable) => {
    const config = {
      ...defaultProfileConfig(),
      test: [{ ...step(), command: { ...step().command, environment: [variable] } }],
    };
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
      "Configuration does not match ValidationProfileV1",
    );
  });

  it("rejects environment names repeated with different casing", () => {
    const command = {
      ...step().command,
      environment: [
        { name: "Path", value: "tools" },
        { name: "PATH", value: "bin" },
      ],
    };
    const config = { ...defaultProfileConfig(), test: [step({ command })] };
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_static_build")).toThrow(
      "Step step-1 repeats environment variable PATH.",
    );
  });

  it("accepts issue triage only when every execution stage is empty", () => {
    const config = defaultProfileConfig();
    expect(parseProfileConfig(JSON.stringify(config), "issue_triage")).toEqual(config);
  });

  it.each(["setup", "build", "test", "launch", "cleanup"] as const)(
    "rejects issue triage with a %s step",
    (stage) => {
      const config = { ...defaultProfileConfig(), [stage]: [step()] };
      expect(() => parseProfileConfig(JSON.stringify(config), "issue_triage")).toThrow(
        `Issue triage must not execute ${stage} steps.`,
      );
    },
  );
});

describe("test observable declarations", () => {
  const booleanField: TestProbeOutputDeclarationV1["fields"][number] = {
    id: "saved",
    description: "The document was saved.",
    type: "boolean",
  };
  const fields: TestProbeOutputDeclarationV1["fields"] = [
    booleanField,
    {
      id: "title",
      description: "The title read after reopening.\nPreserve whitespace.",
      type: "string",
    },
    { id: "count", description: "The number of saved records.", type: "number" },
  ];
  const declaration: TestProbeOutputDeclarationV1 = {
    schemaVersion: "TestProbeOutputDeclarationV1",
    fields,
  };

  it("round-trips all declared value types through a published profile and its next version", () => {
    const published = profile({
      config: { ...defaultProfileConfig(), test: [step({ probeOutput: declaration })] },
    });
    const form = profileFormValues(published);
    expect(parseProfileConfig(form.configJson, form.workflowKind, form.target)).toEqual(
      published.config,
    );
    expect(buildProfilePublish(form, published.repositoryId, published).config).toEqual(
      published.config,
    );
    expect(JSON.parse(form.configJson).test[0].probeOutput.fields).toEqual(fields);
  });

  it("edits only the selected declaration and preserves every other command and setting", () => {
    const original = {
      ...defaultProfileConfig(),
      setup: [step({ id: "setup", required: false })],
      build: [step({ id: "build" })],
      test: [
        step({ id: "first-test", probeOutput: declaration }),
        step({
          id: "second-test",
          name: "A second test",
          command: {
            executable: "dotnet",
            args: ["test", "--filter", "Name=An exact match"],
            workingDirectory: "src/tests",
            environment: [
              { name: "API_TOKEN", secretRef: "secret:tests" },
              { name: "TEST_MODE", value: "reproduction" },
            ],
          },
          required: false,
          timeoutMs: 80_000,
        }),
      ],
      launch: [step({ id: "launch" })],
      cleanup: [step({ id: "cleanup" })],
      requiredCapabilities: ["node", "dotnet"],
      hardTimeoutMs: 900_000,
      noProgressTimeoutMs: 120_000,
    };
    const originalSnapshot = structuredClone(original);
    const text = JSON.stringify(original, null, 2);
    const updated = updateProfileProbeFields(
      text,
      "issue_validation",
      "headless",
      "second-test",
      fields,
    );
    const expected = structuredClone(original);
    expected.test = expected.test.map((testStep) =>
      testStep.id === "second-test" ? { ...testStep, probeOutput: declaration } : testStep,
    );
    expect(JSON.parse(updated)).toEqual(expected);
    expect(original).toEqual(originalSnapshot);
    expect(JSON.stringify(original, null, 2)).toBe(text);
    expect(fields).toEqual(declaration.fields);
  });

  it("removes an empty declaration without inserting null or undefined fields", () => {
    const config = {
      ...defaultProfileConfig(),
      test: [
        step({ probeOutput: declaration }),
        step({ id: "other-test", probeOutput: declaration }),
      ],
    };
    const updated = JSON.parse(
      updateProfileProbeFields(
        JSON.stringify(config),
        "issue_validation",
        "headless",
        "step-1",
        [],
      ),
    );
    expect(updated.test[0]).toEqual(step());
    expect(Object.hasOwn(updated.test[0], "probeOutput")).toBe(false);
    expect(Object.hasOwn(updated, "ui")).toBe(false);
    expect(updated.test[1]).toEqual(config.test[1]);
  });

  it("keeps legacy configurations free of newly defaulted optional declarations", () => {
    const published = profile();
    const form = profileFormValues(published);
    const request = buildProfilePublish(form, published.repositoryId, published);
    expect(JSON.stringify(request.config)).toBe(JSON.stringify(published.config));
    expect(request.config.build[0]).not.toHaveProperty("probeOutput");
    expect(Object.hasOwn(request.config, "ui")).toBe(false);
  });

  it.each(["setup", "build", "launch", "cleanup"] as const)(
    "rejects declarations in the %s phase",
    (stage) => {
      const config = { ...defaultProfileConfig(), [stage]: [step({ probeOutput: declaration })] };
      expect(() =>
        parseProfileConfig(JSON.stringify(config), "issue_validation", "headless"),
      ).toThrow("may declare probe output only in the test phase");
    },
  );

  it("rejects repeated IDs even when their descriptions and types differ", () => {
    const config = { ...defaultProfileConfig(), test: [step()] };
    expect(() =>
      updateProfileProbeFields(JSON.stringify(config), "issue_validation", "headless", "step-1", [
        booleanField,
        { id: "saved", description: "A different meaning.", type: "string" },
      ]),
    ).toThrow("repeats probe field ID saved");
  });

  it("accepts 32 unique fields and rejects a 33rd", () => {
    const config = { ...defaultProfileConfig(), test: [step()] };
    const maximumFields = Array.from({ length: 32 }, (_, index) => ({
      ...booleanField,
      id: `field-${index}`,
    }));
    expect(
      JSON.parse(
        updateProfileProbeFields(
          JSON.stringify(config),
          "issue_validation",
          "headless",
          "step-1",
          maximumFields,
        ),
      ).test[0].probeOutput.fields,
    ).toHaveLength(32);
    expect(() =>
      updateProfileProbeFields(JSON.stringify(config), "issue_validation", "headless", "step-1", [
        ...maximumFields,
        { ...booleanField, id: "field-32" },
      ]),
    ).toThrow("Configuration does not match");
  });

  it.each([
    { id: "invalid id", description: "A field.", type: "boolean" },
    { id: "value", description: " ", type: "boolean" },
    { id: "value", description: "A field.", type: "object" },
    { id: "value", description: "A field.", type: null },
    { id: "value", description: "A field." },
  ])("rejects an invalid observable field: %j", (field) => {
    const config = {
      ...defaultProfileConfig(),
      test: [
        step({ probeOutput: { ...declaration, fields: [field] } as TestProbeOutputDeclarationV1 }),
      ],
    };
    expect(() =>
      parseProfileConfig(JSON.stringify(config), "issue_validation", "headless"),
    ).toThrow("Configuration does not match");
  });

  it("does not apply a declaration to a removed command or another phase", () => {
    const text = JSON.stringify({ ...defaultProfileConfig(), build: [step()] });
    expect(() =>
      updateProfileProbeFields(text, "issue_validation", "headless", "step-1", fields),
    ).toThrow("Select a test command from this configuration");
  });

  it("leaves an invalid JSON draft untouched instead of replacing it with defaults", () => {
    const text = '{ "test": [';
    expect(() =>
      updateProfileProbeFields(text, "issue_validation", "headless", "step-1", fields),
    ).toThrow("Enter valid JSON");
    expect(text).toBe('{ "test": [');
  });
});

describe("validation profile publication", () => {
  it("exposes the allowed targets and profile output schemas for each workflow", () => {
    expect(profileTargets("pr_static_build")).toEqual(["headless"]);
    expect(profileTargets("issue_triage")).toEqual(["headless"]);
    expect(profileTargets("pr_ui")).toEqual(["windows_desktop", "web"]);
    expect(profileTargets("issue_validation")).toEqual(["headless", "windows_desktop", "web"]);
    expect(profileOutputSchemas).toEqual({
      pr_static_build: "PrReviewPlanV2",
      issue_triage: "IssueTriageV2",
      pr_ui: "ValidationReportV1",
      issue_validation: "ValidationReportV1",
    });
  });

  it.each([
    ["pr_static_build", "headless", "PrReviewPlanV2"],
    ["issue_triage", "headless", "IssueTriageV2"],
    ["pr_ui", "windows_desktop", "ValidationReportV1"],
    ["pr_ui", "web", "ValidationReportV1"],
    ["issue_validation", "headless", "ValidationReportV1"],
    ["issue_validation", "windows_desktop", "ValidationReportV1"],
    ["issue_validation", "web", "ValidationReportV1"],
  ] as const)(
    "creates %s on %s with %s and an initial CAS version of zero",
    (workflowKind, target, outputSchemaVersion) => {
      const request = buildProfilePublish(values({ workflowKind, target }), "repository-1");
      expect(request).toEqual({
        name: "Build checks",
        workflowKind,
        target,
        required: true,
        config: defaultProfileConfig(),
        outputSchemaVersion,
        expectedVersion: 0,
      });
    },
  );

  it.each([
    ["pr_static_build", "windows_desktop"],
    ["pr_static_build", "web"],
    ["issue_triage", "windows_desktop"],
    ["issue_triage", "web"],
    ["pr_ui", "headless"],
  ] as const)("rejects the unsupported %s target %s", (workflowKind, target) => {
    expect(() => buildProfilePublish(values({ workflowKind, target }), "repository-1")).toThrow(
      "supported workflow target",
    );
  });

  it("publishes a copy using the latest version without copying published metadata or modifying its source", () => {
    const source = profile({ id: "profile-version-2", version: 2 });
    const latest = profile();
    const originalSource = structuredClone(source);
    const originalLatest = structuredClone(latest);
    const form = { ...profileFormValues(source), name: "  Revised checks  ", required: false };
    const originalForm = structuredClone(form);

    const request = buildProfilePublish(form, "repository-1", latest);
    expect(request).toEqual({
      name: "Revised checks",
      workflowKind: "pr_static_build",
      target: "headless",
      required: false,
      config: source.config,
      outputSchemaVersion: "PrReviewPlanV2",
      profileId: "profile-1",
      expectedVersion: 7,
    });
    expect(request.config).not.toBe(source.config);
    request.config.build[0]!.name = "Changed after publication";
    expect(source).toEqual(originalSource);
    expect(latest).toEqual(originalLatest);
    expect(form).toEqual(originalForm);
  });

  it("rejects publishing an existing profile under another repository", () => {
    expect(() => buildProfilePublish(values(), "repository-2", profile())).toThrow(
      "This profile belongs to another repository.",
    );
  });

  it.each([
    { workflowKind: "issue_validation", target: "headless" },
    { workflowKind: "pr_static_build", target: "web" },
  ] as const)("rejects changing the workflow or target of an existing profile: %j", (changes) => {
    expect(() => buildProfilePublish(values(changes), "repository-1", profile())).toThrow(
      "A new version cannot change the profile workflow or execution target.",
    );
  });

  it.each(["", " \t ", "x".repeat(129), "Name\nwith control", "Name\u0000with control"])(
    "rejects invalid profile names %j",
    (name) => {
      expect(() => buildProfilePublish(values({ name }), "repository-1")).toThrow(
        "Enter a name of 1–128 characters",
      );
    },
  );
});

describe("validation profile bindings", () => {
  it.each([true, false])(
    "uses the current binding CAS version when rolling back with enabled=%s",
    (enabled) => {
      const selected = profile({ id: "profile-version-2", version: 2 });
      const current = binding();
      const originals = structuredClone({ selected, current });
      expect(buildProfileBinding("repository-1", "profile-1", selected, enabled, current)).toEqual({
        expectedVersion: 11,
        profileVersionId: "profile-version-2",
        enabled,
      });
      expect({ selected, current }).toEqual(originals);
    },
  );

  it("uses CAS version zero for a new binding", () => {
    expect(buildProfileBinding("repository-1", "profile-1", profile(), true)).toEqual({
      expectedVersion: 0,
      profileVersionId: "profile-version-7",
      enabled: true,
    });
  });

  it.each([{ repositoryId: "repository-2" }, { profileId: "profile-2" }])(
    "rejects a selected version from the wrong scope: %j",
    (scope) => {
      expect(() => buildProfileBinding("repository-1", "profile-1", profile(scope), true)).toThrow(
        "Select a published version from this repository and profile.",
      );
    },
  );

  it.each([{ repositoryId: "repository-2" }, { profileId: "profile-2" }])(
    "rejects a current binding from the wrong scope: %j",
    (scope) => {
      expect(() =>
        buildProfileBinding("repository-1", "profile-1", profile(), true, binding(scope)),
      ).toThrow("The binding does not match this repository and profile.");
    },
  );
});

describe("complete validation profile binding collection", () => {
  it("loads every page at the reported total and preserves all bindings", async () => {
    const rows = bindings(103);
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(rows.slice(0, 50), 103))
      .mockResolvedValueOnce(bindingPage(rows.slice(50, 100), 103, 2))
      .mockResolvedValueOnce(bindingPage(rows.slice(100), 103, 3));

    await expect(collectProfileBindings("repository-1", list)).resolves.toEqual(rows);
    expect(list.mock.calls).toEqual([
      ["repository-1", { page: 1, pageSize: 50 }],
      ["repository-1", { page: 2, pageSize: 50 }],
      ["repository-1", { page: 3, pageSize: 50 }],
    ]);
  });

  it.each([0, 50])(
    "stops at the exact reported total of %s without requesting another page",
    async (total) => {
      const rows = bindings(total);
      const list = vi
        .fn<Parameters<typeof collectProfileBindings>[1]>()
        .mockResolvedValueOnce(bindingPage(rows, total));
      await expect(collectProfileBindings("repository-1", list)).resolves.toEqual(rows);
      expect(list).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a short page instead of replacing the reported total with the loaded count", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(50), 52))
      .mockResolvedValueOnce(bindingPage(bindings(1, 50), 52, 2));
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
      "The binding list ended before all bindings were loaded.",
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects more bindings than the reported total", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(2), 1));
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
      "The binding list exceeded its reported total.",
    );
  });

  it("rejects a total that changes between pages", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(50), 51))
      .mockResolvedValueOnce(bindingPage(bindings(2, 50), 52, 2));
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
      "inconsistent pagination",
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid reported total of %s",
    async (total) => {
      const list = vi
        .fn<Parameters<typeof collectProfileBindings>[1]>()
        .mockResolvedValueOnce(bindingPage([], total));
      await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
        "inconsistent pagination",
      );
    },
  );

  it.each([
    bindingPage(bindings(1), 1, 2),
    bindingPage(bindings(1), 1, 1, 20),
    bindingPage(bindings(51), 51),
  ])("rejects inconsistent page metadata or page lengths: %j", async (page) => {
    const list = vi.fn<Parameters<typeof collectProfileBindings>[1]>().mockResolvedValueOnce(page);
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
      "inconsistent pagination",
    );
  });

  it("rejects a binding from another repository on a later page", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(50), 51))
      .mockResolvedValueOnce(
        bindingPage([binding({ repositoryId: "repository-2", profileId: "profile-50" })], 51, 2),
      );
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow(
      "The binding list returned a different scope or repeated profile.",
    );
  });

  it("rejects duplicate profiles within a page", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(
        bindingPage([binding(), binding({ profileVersionId: "profile-version-2" })], 2),
      );
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow("repeated profile");
  });

  it("rejects duplicate profiles across pages", async () => {
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(50), 51))
      .mockResolvedValueOnce(bindingPage([binding({ profileId: "profile-0" })], 51, 2));
    await expect(collectProfileBindings("repository-1", list)).rejects.toThrow("repeated profile");
  });

  it("propagates a later page failure without returning a partial collection", async () => {
    const error = new Error("Binding service unavailable.");
    const list = vi
      .fn<Parameters<typeof collectProfileBindings>[1]>()
      .mockResolvedValueOnce(bindingPage(bindings(50), 51))
      .mockRejectedValueOnce(error);
    await expect(collectProfileBindings("repository-1", list)).rejects.toBe(error);
  });
});

describe("validation profile error presentation", () => {
  it("preserves Error messages and provides a fallback for unknown failures", () => {
    expect(configurationErrorMessage(new Error("Version changed."))).toBe("Version changed.");
    expect(configurationErrorMessage(null)).toBe("The request could not be completed. Try again.");
  });

  it("recognizes HTTP 409 as a configuration conflict", () => {
    expect(isProfileConflict({ status: 409 })).toBe(true);
  });

  it.each([null, undefined, 409, "409", {}, { status: "409" }, { status: 400 }, { status: 500 }])(
    "does not mistake unrelated errors for conflicts: %j",
    (error) => {
      expect(isProfileConflict(error)).toBe(false);
    },
  );
});
