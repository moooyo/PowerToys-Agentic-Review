import { createCanonicalResult } from "@agentic-review/codex";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerSessionConfiguration,
  type CodexAppServerSessionConfigurationInput,
  CodexAppServerSessionPolicyError,
  openCodexAppServerSession,
} from "./codex-app-server-session-policy.js";
import type { CodexAppServerTransport } from "./codex-app-server-transport.js";

type Configuration = ReturnType<typeof buildCodexAppServerSessionConfiguration>;
// biome-ignore lint/suspicious/noExplicitAny: Negative fixtures intentionally contain invalid mutable RPC fields.
type FixtureValue = any;
type PolicyMethod =
  | "initialize"
  | "config/read"
  | "configRequirements/read"
  | "permissionProfile/list"
  | "windowsSandbox/readiness"
  | "thread/start"
  | "experimentalFeature/list";
type Responses = Record<PolicyMethod, Record<string, FixtureValue>>;
function responseFor(responses: Responses, method: string): Record<string, FixtureValue> {
  if (!Object.hasOwn(responses, method)) throw new Error("Unexpected synthetic policy request.");
  return responses[method as PolicyMethod];
}
function input(
  changes: Partial<CodexAppServerSessionConfigurationInput> = {},
): CodexAppServerSessionConfigurationInput {
  return {
    purpose: "review",
    requestedModel: "synthetic-policy-model",
    relayUrl: "http://127.0.0.1:18080/v1",
    codexHomeDirectory: "C:\\SyntheticSession\\home\\.codex",
    checkoutDirectory: "C:\\SyntheticSession\\checkout",
    controlDirectory: "C:\\SyntheticSession\\control",
    tempDirectory: "C:\\SyntheticSession\\temp",
    userProfileDirectory: "C:\\SyntheticSession\\home",
    shellEnvironment: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\SyntheticSession\\temp",
      TMP: "C:\\SyntheticSession\\temp",
      USERPROFILE: "C:\\SyntheticSession\\home",
    },
    ...changes,
  };
}

/** Synthetic RPC data using the observed 0.145 response shape; ready is not a real OS observation. */
function fixtureResponses(configuration: Configuration, status = "ready"): Responses {
  const e = configuration.expected;
  const config: Record<string, FixtureValue> = parse(configuration.overrides.join("\n"));
  for (const key of [
    "sandbox_mode",
    "sandbox_workspace_write",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "instructions",
    "developer_instructions",
    "model_instructions_file",
    "experimental_compact_prompt_file",
    "profile",
    "projects",
    "skills",
    "hooks",
    "agents",
  ])
    config[key] = null;
  config.tools = null;
  config.permissions[e.permissionProfile].filesystem.glob_scan_max_depth = null;
  config.permissions[e.permissionProfile].network.socks_url = null;
  const provider = config.model_providers.agentic_review_parent_relay;
  for (const key of [
    "env_key",
    "env_key_instructions",
    "experimental_bearer_token",
    "auth",
    "aws",
    "query_params",
    "http_headers",
    "websocket_connect_timeout_ms",
  ])
    provider[key] = null;
  const roots = e.purpose === "review" ? [e.tempDirectory] : undefined;
  return {
    initialize: {
      userAgent: "agentic_review_worker/0.145.0 (Windows synthetic fixture)",
      codexHome: e.codexHomeDirectory,
      platformFamily: "windows",
      platformOs: "windows",
    },
    "config/read": {
      config,
      origins: { model: { version: "synthetic-source-version-one" } },
      layers: [
        {
          name: { type: "user", file: `${e.codexHomeDirectory}\\config.toml` },
          version: "synthetic-layer-version-one",
          config: {},
        },
      ],
    },
    "configRequirements/read": { requirements: null },
    "permissionProfile/list": {
      data: [
        { id: ":read-only", description: null, allowed: true },
        { id: e.permissionProfile, description: null, allowed: true },
      ],
      nextCursor: null,
    },
    "windowsSandbox/readiness": { status },
    "thread/start": {
      thread: {
        id: "synthetic-policy-thread",
        sessionId: "synthetic-policy-thread",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        preview: "",
        status: { type: "idle" },
        turns: [],
        ephemeral: true,
        cwd: e.checkoutDirectory,
        cliVersion: "0.145.0",
        modelProvider: e.providerId,
      },
      model: e.requestedModel,
      modelProvider: e.providerId,
      cwd: e.checkoutDirectory,
      runtimeWorkspaceRoots: [e.checkoutDirectory],
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: e.permissionProfile, extends: null },
      sandbox: {
        type: e.purpose === "review" ? "workspaceWrite" : "readOnly",
        networkAccess: true,
        ...(roots === undefined
          ? {}
          : { writableRoots: roots, excludeTmpdirEnvVar: true, excludeSlashTmp: true }),
      },
      reasoningEffort: e.modelReasoningEffort,
      multiAgentMode: "explicitRequestOnly",
    },
    "experimentalFeature/list": {
      data: Object.entries(config.features).map(([name, enabled]) => ({
        name,
        enabled,
        defaultEnabled: false,
        stage: "stable",
        displayName: null,
        description: null,
        announcement: null,
      })),
      nextCursor: null,
    },
  };
}

/** A pure test-side projection for independently declaring a synthetic fixture's registration digest. */
function fixturePolicyDigest(configuration: Configuration, responses: Responses): string {
  const e = configuration.expected;
  const clone = structuredClone(responses);
  delete clone.initialize.userAgent;
  delete clone["config/read"].origins;
  delete clone["config/read"].layers;
  const inner = clone["thread/start"].thread;
  for (const key of [
    "id",
    "sessionId",
    "createdAt",
    "updatedAt",
    "recencyAt",
    "preview",
    "status",
    "turns",
  ])
    delete inner[key];
  clone["permissionProfile/list"].data.sort((a: FixtureValue, b: FixtureValue) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  clone["experimentalFeature/list"].data.sort((a: FixtureValue, b: FixtureValue) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const projection = {
    schemaVersion: "CodexAppServerConfigurationProjectionV1",
    initialization: clone.initialize,
    configRead: clone["config/read"],
    requirements: clone["configRequirements/read"],
    permissionProfiles: clone["permissionProfile/list"],
    readiness: clone["windowsSandbox/readiness"],
    thread: clone["thread/start"],
    features: clone["experimentalFeature/list"],
  };
  const replacements = new Map([
    [e.relayUrl, "$PARENT_RELAY_URL"],
    [e.codexHomeDirectory, "$CODEX_HOME"],
    [e.checkoutDirectory, "$CHECKOUT"],
    [e.controlDirectory, "$CONTROL"],
    [e.tempDirectory, "$TEMP"],
    [e.userProfileDirectory, "$USERPROFILE"],
  ]);
  const replace = (value: FixtureValue): FixtureValue =>
    typeof value === "string"
      ? (replacements.get(value) ?? value)
      : Array.isArray(value)
        ? value.map(replace)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, child]) => [
                replacements.get(key) ?? key,
                replace(child),
              ]),
            )
          : value;
  const normalized = replace(projection);
  for (const [original, retained, key] of [
    [projection.configRead.config, normalized.configRead.config, "model_reasoning_effort"],
    [projection.thread, normalized.thread, "reasoningEffort"],
  ] as const) {
    if (typeof original[key] === "string") retained[key] = original[key];
  }
  return createCanonicalResult(normalized).sha256;
}

function fixture(changes: Partial<CodexAppServerSessionConfigurationInput> = {}, status = "ready") {
  const configuration = buildCodexAppServerSessionConfiguration(input(changes));
  const responses = fixtureResponses(configuration, status);
  const request = vi.fn(async (method: string) => structuredClone(responseFor(responses, method)));
  const transport = {
    request,
    notifyInitialized: vi.fn(async () => undefined),
    close: vi.fn(),
    abort: vi.fn(),
    completed: new Promise(() => undefined),
  } as unknown as CodexAppServerTransport;
  return {
    configuration,
    responses,
    request,
    transport,
    open: () => openCodexAppServerSession({ transport, expected: configuration.expected }),
  };
}

describe("Codex app-server session policy", () => {
  it("preserves explicitly declared model parameters in requested and observed policy", async () => {
    const parameters = {
      modelReasoningEffort: "xhigh",
      modelContextWindow: 200000,
      modelAutoCompactTokenLimit: 150000,
    };
    const f = fixture(parameters);
    expect(parse(f.configuration.overrides.join("\n"))).toMatchObject({
      model_reasoning_effort: "xhigh",
      model_context_window: 200000,
      model_auto_compact_token_limit: 150000,
    });
    expect(f.configuration.expected).toMatchObject(parameters);
    const opened = await f.open();
    expect(opened.launchPolicySha256).toBe(fixturePolicyDigest(f.configuration, f.responses));
    expect(opened.observation.projection.configRead).toMatchObject({
      config: {
        model_reasoning_effort: "xhigh",
        model_context_window: 200000,
        model_auto_compact_token_limit: 150000,
      },
    });
    const changed = fixture({ ...parameters, modelReasoningEffort: "high" });
    expect((await changed.open()).launchPolicySha256).not.toBe(opened.launchPolicySha256);
  });

  it.each([
    {},
    { modelReasoningEffort: null, modelContextWindow: null, modelAutoCompactTokenLimit: null },
  ])(
    "leaves absent model parameters unspecified without inventing overrides: %j",
    async (parameters) => {
      const f = fixture(parameters);
      const config = parse(f.configuration.overrides.join("\n"));
      for (const key of [
        "model_reasoning_effort",
        "model_context_window",
        "model_auto_compact_token_limit",
      ])
        expect(config).not.toHaveProperty(key);
      expect(f.configuration.expected).toMatchObject({
        modelReasoningEffort: null,
        modelContextWindow: null,
        modelAutoCompactTokenLimit: null,
      });
      expect((await f.open()).observation.executionAccepted).toBe(false);
    },
  );

  it("retains provider-loader reasoning strings and independent positive token limits without normalization", async () => {
    const f = fixture({
      modelReasoningEffort: " custom-effort ",
      modelContextWindow: 200000,
      modelAutoCompactTokenLimit: 250000,
    });
    const config = parse(f.configuration.overrides.join("\n"));
    expect(config).toMatchObject({
      model_reasoning_effort: " custom-effort ",
      model_context_window: 200000,
      model_auto_compact_token_limit: 250000,
    });
    await expect(f.open()).resolves.toMatchObject({ observation: { executionAccepted: false } });
  });

  it.each(["$TEMP", "C:\\SyntheticSession\\temp"])(
    "preserves reasoning parameter data that resembles a path role: %s",
    async (effort) => {
      const f = fixture({ modelReasoningEffort: effort });
      const opened = await f.open();
      expect(opened.observation.projection.configRead).toMatchObject({
        config: { model_reasoning_effort: effort },
      });
      expect(opened.observation.projection.thread).toMatchObject({ reasoningEffort: effort });
      expect(opened.launchPolicySha256).toBe(fixturePolicyDigest(f.configuration, f.responses));
    },
  );

  it.each([
    "model_reasoning_effort",
    "model_context_window",
    "model_auto_compact_token_limit",
    "thread reasoning",
  ])("rejects a changed or missing declared model parameter: %s", async (key) => {
    const f = fixture({
      modelReasoningEffort: "high",
      modelContextWindow: 200000,
      modelAutoCompactTokenLimit: 150000,
    });
    if (key === "thread reasoning") f.responses["thread/start"].reasoningEffort = "low";
    else f.responses["config/read"].config[key] = null;
    await expect(f.open()).rejects.toMatchObject({ code: "POLICY_MISMATCH" });
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it.each([
    ["modelReasoningEffort", ""],
    ["modelReasoningEffort", "high\n"],
    ["modelContextWindow", 0],
    ["modelContextWindow", -1],
    ["modelContextWindow", Number.MAX_SAFE_INTEGER + 1],
    ["modelAutoCompactTokenLimit", 0],
    ["modelAutoCompactTokenLimit", 0.5],
    ["modelAutoCompactTokenLimit", Number.POSITIVE_INFINITY],
  ])("rejects a model declaration outside existing provider-loader bounds: %s=%s", (key, value) => {
    expect(() =>
      buildCodexAppServerSessionConfiguration(input({ [key as string]: value })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("snapshots model declarations without invoking accessors", () => {
    const getter = vi.fn(() => {
      throw new Error("Synthetic private model declaration.");
    });
    const supplied = input();
    Object.defineProperty(supplied, "modelReasoningEffort", { get: getter, enumerable: true });
    expect(() => buildCodexAppServerSessionConfiguration(supplied)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("generates named permissions, a parent-only model endpoint and explicit shell environment", () => {
    const c = buildCodexAppServerSessionConfiguration(
      input({ commandNetworkDomains: ["api.example.com"] }),
    );
    const config: Record<string, FixtureValue> = parse(c.overrides.join("\n"));
    expect(config.permissions[c.permissionProfile].filesystem).toEqual({
      ":minimal": "read",
      ":workspace_roots": { ".": "write" },
      "C:\\SyntheticSession\\temp": "write",
    });
    expect(config.permissions[c.permissionProfile].network.domains).toEqual({
      "api.example.com": "allow",
    });
    expect(config.model_providers.agentic_review_parent_relay.env_http_headers).toEqual({
      Authorization: "CODEX_PROVIDER_HEADER_0",
    });
    expect(config.shell_environment_policy).toMatchObject({
      inherit: "none",
      set: input().shellEnvironment,
    });
    expect(c.overrides.join("\n")).not.toMatch(
      /sandbox_mode|sandbox_workspace_write|tools\.view_image/,
    );
  });

  it("observes one transport, returns the actual version and hashes actual RPC data without accepting execution", async () => {
    const f = fixture();
    const result = await f.open();
    expect(result.launchPolicySha256).toBe(fixturePolicyDigest(f.configuration, f.responses));
    expect(result.observation).toMatchObject({
      cliVersion: "0.145.0",
      readiness: "ready",
      executionAccepted: false,
      measurementKind: "app_server_configuration_projection_v1",
      threadId: "synthetic-policy-thread",
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "config/read",
      "configRequirements/read",
      "permissionProfile/list",
      "windowsSandbox/readiness",
      "thread/start",
      "experimentalFeature/list",
    ]);
    expect(f.transport.notifyInitialized).toHaveBeenCalledOnce();
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.transport.abort).not.toHaveBeenCalled();
  });

  it("keeps summary shell available with read-only checkout/TEMP and no command network domains", async () => {
    const f = fixture({ purpose: "summary_read_only" });
    const fs =
      f.responses["config/read"].config.permissions[f.configuration.permissionProfile].filesystem;
    expect(fs[":workspace_roots"]).toEqual({ ".": "read" });
    expect(fs[f.configuration.expected.tempDirectory]).toBe("read");
    expect(f.responses["config/read"].config.features.shell_tool).toBe(true);
    expect(
      f.responses["config/read"].config.permissions[f.configuration.permissionProfile].network
        .domains,
    ).toEqual({});
    expect((await f.open()).observation.executionAccepted).toBe(false);
    expect(() =>
      buildCodexAppServerSessionConfiguration(
        input({ purpose: "summary_read_only", commandNetworkDomains: ["example.com"] }),
      ),
    ).toThrow(CodexAppServerSessionPolicyError);
  });

  it.each(["updateRequired", "notConfigured"])(
    "retains a complete rejection observation for %s without starting a turn",
    async (status) => {
      const f = fixture({}, status);
      const error = (await f
        .open()
        .catch((value: unknown) => value)) as CodexAppServerSessionPolicyError;
      expect(error).toBeInstanceOf(CodexAppServerSessionPolicyError);
      expect(error.code).toBe("SANDBOX_NOT_READY");
      expect(error.observation).toMatchObject({
        readiness: status,
        executionAccepted: false,
        launchPolicySha256: fixturePolicyDigest(f.configuration, f.responses),
      });
      expect(
        f.request.mock.calls.some(
          ([method]) => method === "turn/start" || method.includes("setup"),
        ),
      ).toBe(false);
    },
  );

  const drifts: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      "wrong initialization version",
      (f) => {
        f.responses.initialize.userAgent = "agentic_review_worker/0.146.0 (synthetic)";
      },
    ],
    [
      "wrong CLI thread version",
      (f) => {
        f.responses["thread/start"].thread.cliVersion = "0.144.0";
      },
    ],
    [
      "wrong home",
      (f) => {
        f.responses.initialize.codexHome = "C:\\ForeignHome";
      },
    ],
    [
      "wrong model",
      (f) => {
        f.responses["thread/start"].model = "foreign-model";
      },
    ],
    [
      "wrong provider",
      (f) => {
        f.responses["thread/start"].thread.modelProvider = "openai";
      },
    ],
    [
      "old sandbox override",
      (f) => {
        f.responses["config/read"].config.sandbox_mode = "danger-full-access";
      },
    ],
    [
      "upstream provider URL",
      (f) => {
        f.responses["config/read"].config.model_providers.agentic_review_parent_relay.base_url =
          "https://provider.invalid/v1";
      },
    ],
    [
      "static provider secret",
      (f) => {
        f.responses["config/read"].config.model_providers.agentic_review_parent_relay.http_headers =
          { Authorization: "synthetic-secret-never-echo" };
      },
    ],
    [
      "provider command auth",
      (f) => {
        f.responses["config/read"].config.model_providers.agentic_review_parent_relay.auth = {
          command: "synthetic-command",
        };
      },
    ],
    [
      "changed header reference",
      (f) => {
        f.responses[
          "config/read"
        ].config.model_providers.agentic_review_parent_relay.env_http_headers.Authorization =
          "FOREIGN_TOKEN";
      },
    ],
    [
      "ChatGPT auth",
      (f) => {
        f.responses[
          "config/read"
        ].config.model_providers.agentic_review_parent_relay.requires_openai_auth = true;
      },
    ],
    [
      "shell inheritance",
      (f) => {
        f.responses["config/read"].config.shell_environment_policy.inherit = "all";
      },
    ],
    [
      "additional shell secret",
      (f) => {
        f.responses["config/read"].config.shell_environment_policy.set.TOKEN =
          "synthetic-secret-never-echo";
      },
    ],
    [
      "extra filesystem grant",
      (f) => {
        f.responses["config/read"].config.permissions[f.configuration.permissionProfile].filesystem[
          "C:\\Foreign"
        ] = "write";
      },
    ],
    [
      "command loopback domain",
      (f) => {
        f.responses["config/read"].config.permissions[
          f.configuration.permissionProfile
        ].network.domains.localhost = "allow";
      },
    ],
    [
      "upstream proxy",
      (f) => {
        f.responses["config/read"].config.permissions[
          f.configuration.permissionProfile
        ].network.allow_upstream_proxy = true;
      },
    ],
    [
      "proxy feature disabled",
      (f) => {
        f.responses["experimentalFeature/list"].data.find(
          (item: FixtureValue) => item.name === "network_proxy",
        ).enabled = false;
      },
    ],
    [
      "tool feature enabled",
      (f) => {
        f.responses["experimentalFeature/list"].data.find(
          (item: FixtureValue) => item.name === "browser_use",
        ).enabled = true;
      },
    ],
    [
      "profile denied",
      (f) => {
        f.responses["permissionProfile/list"].data[1].allowed = false;
      },
    ],
    [
      "wrong selected profile",
      (f) => {
        f.responses["thread/start"].activePermissionProfile.id = ":danger-full-access";
      },
    ],
    [
      "approval drift",
      (f) => {
        f.responses["thread/start"].approvalPolicy = "on-request";
      },
    ],
    [
      "extra runtime root",
      (f) => {
        f.responses["thread/start"].runtimeWorkspaceRoots.push("C:\\Foreign");
      },
    ],
    [
      "foreign legacy writable root",
      (f) => {
        f.responses["thread/start"].sandbox.writableRoots.push("C:\\Foreign");
      },
    ],
    [
      "instruction source",
      (f) => {
        f.responses["thread/start"].instructionSources.push({ path: "C:\\Foreign\\AGENTS.md" });
      },
    ],
  ];
  it.each(drifts)("rejects %s with a fixed error before any turn", async (_name, change) => {
    const f = fixture();
    change(f);
    const error = (await f
      .open()
      .catch((value: unknown) => value)) as CodexAppServerSessionPolicyError;
    expect(error).toBeInstanceOf(CodexAppServerSessionPolicyError);
    expect(error.message).toBe("The Codex app-server session policy could not be verified.");
    expect(error.message).not.toContain("synthetic-secret");
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it.each(["permissionProfile/list", "experimentalFeature/list"] as const)(
    "requires a complete nonduplicated %s",
    async (method) => {
      const paged = fixture();
      paged.responses[method].nextCursor = "next";
      await expect(paged.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
      const duplicated = fixture();
      duplicated.responses[method].data.push(duplicated.responses[method].data[0]);
      await expect(duplicated.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
    },
  );

  it("does not treat missing requirements or a ready boolean as observed status", async () => {
    const missing = fixture();
    delete missing.responses["configRequirements/read"].requirements;
    await expect(missing.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
    const invented = fixture();
    invented.responses["windowsSandbox/readiness"] = { ready: true };
    await expect(invented.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
  });

  it("keeps unknown configuration, requirement, feature and RPC policy fields in the observed hash", async () => {
    const first = fixture();
    const original = await first.open();
    const changed = fixture();
    changed.responses["config/read"].config.futurePolicy = { enforce: "synthetic-only" };
    changed.responses["config/read"].futureRpcPolicy = { version: 2 };
    changed.responses["configRequirements/read"].requirements = { futureRequirement: ["strict"] };
    changed.responses["experimentalFeature/list"].data.push({
      name: "future_feature",
      enabled: false,
      defaultEnabled: false,
      stage: "removed",
      futureFact: 7,
    });
    changed.responses["thread/start"].futureThreadPolicy = "synthetic-only";
    const observed = await changed.open();
    expect(observed.launchPolicySha256).not.toBe(original.launchPolicySha256);
    expect(observed.launchPolicySha256).toBe(
      fixturePolicyDigest(changed.configuration, changed.responses),
    );
    expect(JSON.stringify(observed.observation.projection)).toContain("futureRpcPolicy");
    expect(observed.observation.executionAccepted).toBe(false);
  });

  it("normalizes only exact owned path and relay values, while binding dynamic provenance separately", async () => {
    const first = fixture();
    const original = await first.open();
    const changedInput = JSON.parse(
      JSON.stringify(input()).replaceAll("SyntheticSession", "OtherSession"),
    ) as CodexAppServerSessionConfigurationInput;
    const configuration = buildCodexAppServerSessionConfiguration({
      ...changedInput,
      relayUrl: "http://127.0.0.1:19090/v1",
    });
    const changed = fixture();
    const responses = fixtureResponses(configuration);
    responses["thread/start"].thread.id = "another-synthetic-thread";
    responses["thread/start"].thread.sessionId = "another-synthetic-thread";
    responses["thread/start"].thread.createdAt = 100;
    responses["config/read"].layers[0].version = "different-per-run-version";
    changed.request.mockImplementation(async (method) =>
      structuredClone(responseFor(responses, method)),
    );
    const next = await openCodexAppServerSession({
      transport: changed.transport,
      expected: configuration.expected,
    });
    expect(next.launchPolicySha256).toBe(original.launchPolicySha256);
    expect(next.observation.rawObservationSha256).not.toBe(
      original.observation.rawObservationSha256,
    );
    const embedded = fixture();
    embedded.responses["config/read"].config.futurePath =
      `${embedded.configuration.expected.tempDirectory}\\foreign-child`;
    const withEmbedded = await embedded.open();
    expect(JSON.stringify(withEmbedded.observation.projection)).toContain("foreign-child");
    expect(withEmbedded.launchPolicySha256).not.toBe(original.launchPolicySha256);
  });

  it("does not collapse an untrusted literal placeholder into an owned path", async () => {
    const f = fixture();
    f.responses["config/read"].config.futurePath = "$TEMP";
    await expect(f.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
  });

  it("uses code-unit ordering independent of source ordering or locale collation", async () => {
    const first = fixture();
    for (const name of ["a_future", "Z_future"]) {
      first.responses["experimentalFeature/list"].data.push({
        name,
        enabled: false,
        defaultEnabled: false,
        stage: "removed",
      });
      first.responses["permissionProfile/list"].data.push({
        id: name,
        description: null,
        allowed: false,
      });
    }
    const second = fixture();
    second.responses["experimentalFeature/list"].data = structuredClone(
      first.responses["experimentalFeature/list"].data,
    ).reverse();
    second.responses["permissionProfile/list"].data = structuredClone(
      first.responses["permissionProfile/list"].data,
    ).reverse();
    const observed = await first.open();
    expect((await second.open()).launchPolicySha256).toBe(observed.launchPolicySha256);
    const projection = observed.observation.projection as Record<string, FixtureValue>;
    const featureNames: string[] = projection.features.data.map((item: FixtureValue) => item.name);
    const profileNames: string[] = projection.permissionProfiles.data.map(
      (item: FixtureValue) => item.id,
    );
    expect(featureNames).toEqual([...featureNames].sort());
    expect(profileNames).toEqual([...profileNames].sort());
    expect(featureNames.indexOf("Z_future")).toBeLessThan(featureNames.indexOf("a_future"));
  });

  it.each(["codexHomeDirectory", "controlDirectory", "userProfileDirectory"] as const)(
    "rejects a TEMP write grant enclosing %s before role normalization can hide the layout",
    (key) => {
      const source = input();
      const path = `${source.tempDirectory}\\nested-private`;
      const changed = {
        ...source,
        [key]: path,
        shellEnvironment: {
          ...source.shellEnvironment,
          ...(key === "userProfileDirectory" ? { USERPROFILE: path } : {}),
        },
      };
      expect(() => buildCodexAppServerSessionConfiguration(changed)).toThrow(
        CodexAppServerSessionPolicyError,
      );
    },
  );

  it("rejects TEMP inside control/home but permits a user profile containing separate HOME and TEMP children", () => {
    const source = input();
    for (const parent of [source.controlDirectory, source.codexHomeDirectory]) {
      const temp = `${parent}\\temporary`;
      expect(() =>
        buildCodexAppServerSessionConfiguration({
          ...source,
          tempDirectory: temp,
          shellEnvironment: { ...source.shellEnvironment, TEMP: temp, TMP: temp },
        }),
      ).toThrow(CodexAppServerSessionPolicyError);
    }
    const temp = `${source.userProfileDirectory}\\temporary`;
    expect(
      buildCodexAppServerSessionConfiguration({
        ...source,
        tempDirectory: temp,
        shellEnvironment: { ...source.shellEnvironment, TEMP: temp, TMP: temp },
      }).expected.tempDirectory,
    ).toBe(temp);
  });

  it("snapshots mutable inputs and RPC data and binds transport functions before its first await", async () => {
    const originalInput = input();
    const configuration = buildCodexAppServerSessionConfiguration(originalInput);
    (originalInput.shellEnvironment as Record<string, string>).PATH = "C:\\Foreign";
    expect(configuration.expected.shellEnvironment.PATH).toBe("C:\\Windows\\System32");
    const f = fixture();
    const observedConfig = f.responses["config/read"];
    f.request.mockImplementation(async (method) => {
      if (method === "configRequirements/read")
        observedConfig.config.model = "changed-after-observation";
      return responseFor(f.responses, method);
    });
    const pending = f.open();
    Object.defineProperty(f.transport, "request", {
      value: vi.fn(() => {
        throw new Error("must not run");
      }),
      configurable: true,
    });
    const result = await pending;
    expect(
      (result.observation.projection.configRead as { config: { model: string } }).config.model,
    ).toBe("synthetic-policy-model");
    await expect(f.open()).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it.each([
    { relayUrl: "https://provider.invalid/v1" },
    { relayUrl: "http://127.0.0.1:18080/v1?secret=synthetic" },
    { relayUrl: "http://synthetic:secret@127.0.0.1:18080/v1" },
    { relayUrl: "not a URL" },
    { commandNetworkDomains: ["localhost"] },
    { commandNetworkDomains: ["127.0.0.1"] },
    { commandNetworkDomains: ["*.example.com"] },
    { commandNetworkDomains: ["example.com", "EXAMPLE.COM"] },
    { commandNetworkDomains: ["example.com:443"] },
    { checkoutDirectory: "C:\\SyntheticSession\\control" },
    { shellEnvironment: { ...input().shellEnvironment, TOKEN: "synthetic-secret" } },
  ])("rejects invalid or ambiguous configuration without exposing its values (%j)", (changes) => {
    let error: unknown;
    try {
      buildCodexAppServerSessionConfiguration(input(changes));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CodexAppServerSessionPolicyError);
    expect(error).toMatchObject({
      code: "INVALID_CONFIGURATION",
      message: "The Codex app-server session policy could not be verified.",
    });
  });

  it("rejects accessors, forged expected objects and oversized observations without invoking getters", async () => {
    const getter = vi.fn(() => "synthetic-secret");
    const source = input();
    Object.defineProperty(source, "requestedModel", { get: getter, enumerable: true });
    expect(() => buildCodexAppServerSessionConfiguration(source)).toThrow(
      CodexAppServerSessionPolicyError,
    );
    expect(getter).not.toHaveBeenCalled();
    const f = fixture();
    await expect(
      openCodexAppServerSession({
        transport: f.transport,
        expected: { ...f.configuration.expected },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(f.request).not.toHaveBeenCalled();
    const large = fixture();
    large.responses.initialize.future = "x".repeat(4 * 1024 * 1024 + 1);
    await expect(large.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
    const malicious = fixture();
    malicious.request.mockImplementation(async (method) => {
      const value = structuredClone(responseFor(malicious.responses, method));
      if (method === "initialize")
        Object.defineProperty(value, "hidden", { get: getter, enumerable: true });
      return value;
    });
    await expect(malicious.open()).rejects.toMatchObject({ code: "INVALID_OBSERVATION" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("maps transport failure to a fixed error and never claims a ready observation", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("synthetic-secret-never-echo"));
    await expect(f.open()).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      observation: undefined,
    });
  });
});
