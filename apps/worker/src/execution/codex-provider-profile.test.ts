import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import { parse, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCodexProviderProfile,
  loadCodexRelayProviderProfile,
} from "./codex-provider-profile.js";

const temporaryDirectoryPrefix = "agentic-review-codex-provider-profile-";
const temporaryRoot = resolve(tmpdir());
const temporaryDirectories = new Set<string>();
const maximumConfigBytes = 64 * 1024;
const secretCanary = "SYNTHETIC_PROVIDER_SECRET_DO_NOT_EXPORT_7f62";

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    const absoluteDirectory = resolve(directory);
    if (
      dirname(absoluteDirectory) !== temporaryRoot ||
      !basename(absoluteDirectory).startsWith(temporaryDirectoryPrefix)
    ) {
      throw new Error("Refusing to remove a directory outside the test temporary root.");
    }
    await rm(absoluteDirectory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

async function createProfile(source?: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, temporaryDirectoryPrefix));
  temporaryDirectories.add(directory);
  if (source !== undefined) await writeFile(join(directory, "config.toml"), source);
  return directory;
}

describe("loadCodexRelayProviderProfile parent-only static authorization", () => {
  it("retains declared public provider/model settings while keeping all headers behind authorize", async () => {
    const directory = await createProfile(`
model = "declared-model"
model_provider = "review-provider"
model_reasoning_effort = "high"
model_context_window = 200000
model_auto_compact_token_limit = 150000
[model_providers.review-provider]
name = "Review provider"
base_url = "https://inference.example.invalid/prefix/v1/"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 2
stream_idle_timeout_ms = 120000
http_headers = { Authorization = "Bearer ${secretCanary}", "X-Private-Header" = "private-header-value" }
[model_providers.unselected]
experimental_bearer_token = "unselected-secret"
`);
    // This directory would fail any attempt to read auth.json as a file.
    await mkdir(join(directory, "auth.json"));
    const result = await loadCodexRelayProviderProfile(directory);
    expect(result.state).toBe("supported");
    if (result.state !== "supported") throw new Error("Expected a static provider profile.");
    expect(result.effectivePolicy).toBe("unverified");
    expect(result.declared).toEqual({
      providerId: "review-provider",
      baseUrl: "https://inference.example.invalid/prefix/v1/",
      endpoint: "https://inference.example.invalid/prefix/v1/responses",
      model: "declared-model",
      modelReasoningEffort: "high",
      modelContextWindow: 200000,
      modelAutoCompactTokenLimit: 150000,
      provider: {
        name: "Review provider",
        wireApi: "responses",
        supportsWebsockets: true,
        requiresOpenaiAuth: false,
        requestMaxRetries: 0,
        streamMaxRetries: 2,
        streamIdleTimeoutMs: 120000,
      },
    });
    expect(Object.keys(result).sort()).toEqual([
      "authorize",
      "declared",
      "effectivePolicy",
      "getProtectedValues",
      "state",
    ]);
    const publicView = inspect(result, { depth: null, showHidden: true });
    for (const text of [
      secretCanary,
      "private-header-value",
      "X-Private-Header",
      "unselected-secret",
      "providerEnvironment",
      "configurationOverrides",
      "launchPolicySha256",
    ])
      expect(publicView).not.toContain(text);
    const protectedValues = result.getProtectedValues();
    expect(result.getProtectedValues()).toBe(protectedValues);
    expect(Object.isFrozen(protectedValues)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secretCanary);
    expect(JSON.stringify(result)).not.toContain("private-header-value");
    expect(JSON.stringify(result)).not.toContain("protectedValues");
    const authorization = await result.authorize(new AbortController().signal);
    expect(authorization.protectedValues).toBe(protectedValues);
    expect(authorization.headers).toEqual({
      Authorization: `Bearer ${secretCanary}`,
      "X-Private-Header": "private-header-value",
    });
    expect(authorization.protectedValues).toContain(secretCanary);
    expect(authorization.protectedValues).toContain(`Bearer ${secretCanary}`);
    expect(authorization.protectedValues).toContain("private-header-value");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.declared)).toBe(true);
    expect(Object.isFrozen(result.declared.provider)).toBe(true);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.headers)).toBe(true);
    expect(Object.isFrozen(authorization.protectedValues)).toBe(true);
  });

  it("keeps missing declarations explicit and never infers a model or effective launch policy", async () => {
    const result = await loadCodexRelayProviderProfile(
      await createProfile(selectedProviderConfig([])),
    );
    expect(result.state).toBe("supported");
    if (result.state !== "supported") throw new Error("Expected a static provider profile.");
    expect(result.declared).toMatchObject({
      model: null,
      modelReasoningEffort: null,
      modelContextWindow: null,
      modelAutoCompactTokenLimit: null,
      provider: {
        wireApi: null,
        supportsWebsockets: null,
        requiresOpenaiAuth: null,
        requestMaxRetries: null,
        streamMaxRetries: null,
        streamIdleTimeoutMs: null,
      },
    });
    expect(await result.authorize(new AbortController().signal)).toEqual({
      headers: {},
      protectedValues: [],
    });
  });

  it.each([
    { source: undefined, reason: "PROFILE_MISSING" },
    { source: 'model="declared-model"', reason: "PROVIDER_NOT_SELECTED" },
    { source: 'model_provider="unconfigured"', reason: "PROVIDER_NOT_CONFIGURED" },
    {
      source: 'model_provider="unconfigured"\n[model_providers.other]\nname="Other"',
      reason: "PROVIDER_NOT_CONFIGURED",
    },
    {
      source: selectedProviderConfig(["requires_openai_auth=true"]),
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: `forced_login_method="chatgpt"\n${selectedProviderConfig([])}`,
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: `forced_chatgpt_workspace_id="synthetic-workspace"\n${selectedProviderConfig([])}`,
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: selectedProviderConfig([
        `auth={command="synthetic-helper",args=["${secretCanary}"]}`,
      ]),
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: selectedProviderConfig([`env_key="${secretCanary}"`]),
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: selectedProviderConfig([`experimental_bearer_token="${secretCanary}"`]),
      reason: "AUTHENTICATION_UNSUPPORTED",
    },
    {
      source: selectedProviderConfig([`env_http_headers={Authorization="${secretCanary}"}`]),
      reason: "DYNAMIC_HEADERS_UNSUPPORTED",
    },
    { source: selectedProviderConfig(['wire_api="chat"']), reason: "PROTOCOL_UNSUPPORTED" },
    {
      source: selectedProviderConfig(['query_params={version="synthetic"}']),
      reason: "PROVIDER_OPTION_UNSUPPORTED",
    },
  ])(
    "returns typed unsupported $reason without exporting configuration or credentials",
    async ({ source, reason }) => {
      const result = await loadCodexRelayProviderProfile(await createProfile(source));
      expect(result).toEqual({ state: "unsupported", reason, effectivePolicy: "unverified" });
      expect(inspect(result, { depth: null, showHidden: true })).not.toContain(secretCanary);
      expect(result).not.toHaveProperty("authorize");
    },
  );

  it.each([
    "http://inference.example.invalid/v1",
    "https://inference.example.invalid/v1?api-version=synthetic",
    "https://inference.example.invalid/v1#fragment",
    `https://user:${secretCanary}@inference.example.invalid/v1`,
    "https://INFERENCE.example.invalid/v1",
    "not-a-url",
  ])("refuses a noncanonical or non-HTTPS Responses base: %s", async (baseUrl) => {
    const source = `model_provider="review-provider"\n[model_providers.review-provider]\nbase_url=${JSON.stringify(baseUrl)}`;
    const result = await loadCodexRelayProviderProfile(await createProfile(source));
    expect(result).toEqual({
      state: "unsupported",
      reason: "ENDPOINT_UNSUPPORTED",
      effectivePolicy: "unverified",
    });
  });

  it("requires a provider endpoint rather than guessing a default API", async () => {
    const result = await loadCodexRelayProviderProfile(
      await createProfile(
        'model_provider="review-provider"\n[model_providers.review-provider]\nname="Provider"',
      ),
    );
    expect(result).toMatchObject({ state: "unsupported", reason: "ENDPOINT_UNSUPPORTED" });
  });

  it("retains one credential snapshot after the synthetic profile changes and isolates callback results", async () => {
    const directory = await createProfile(
      selectedProviderConfig([`http_headers={Authorization="${secretCanary}"}`]),
    );
    const result = await loadCodexRelayProviderProfile(directory);
    if (result.state !== "supported") throw new Error("Expected a static provider profile.");
    const protectedValues = result.getProtectedValues();
    const first = await result.authorize(new AbortController().signal);
    await writeFile(
      join(directory, "config.toml"),
      selectedProviderConfig(['http_headers={Authorization="changed-credential"}']),
    );
    expect(Reflect.set(first.headers, "Authorization", "changed-through-result")).toBe(false);
    expect(Reflect.set(protectedValues, "0", "changed-through-result")).toBe(false);
    expect(result.getProtectedValues()).toBe(protectedValues);
    const second = await result.authorize(new AbortController().signal);
    expect(first.headers).not.toBe(second.headers);
    expect(second.headers.Authorization).toBe(secretCanary);
    expect(second.protectedValues).toContain(secretCanary);
    expect(second.protectedValues).toBe(protectedValues);
    const signal = AbortSignal.abort(secretCanary);
    await expect(result.authorize(signal)).rejects.toThrow(
      "Codex relay provider authorization was cancelled.",
    );
  });

  it("reuses exact public metadata classification and preserves same-value secret priority", async () => {
    const directory = await createProfile(
      `model="worker-model"\n${selectedProviderConfig(['http_headers={"X-Source"="worker"}'])}`,
    );
    await writeFile(
      join(directory, "provider-metadata-policy.json"),
      JSON.stringify({
        schemaVersion: "CodexProviderMetadataPolicyV1",
        publicHeaders: [
          {
            providerId: "review-provider",
            endpoint: "https://inference.example.invalid/v1",
            header: "X-Source",
            value: "worker",
          },
        ],
      }),
    );
    const result = await loadCodexRelayProviderProfile(directory);
    if (result.state !== "supported")
      throw new Error("Expected the exact public metadata rule to apply.");
    expect(result.getProtectedValues()).toEqual([]);
    expect((await result.authorize(new AbortController().signal)).protectedValues).toEqual([]);
    await writeFile(
      join(directory, "config.toml"),
      `model="worker-model"\n${selectedProviderConfig(['http_headers={"X-Source"="worker",Authorization="worker"}'])}`,
    );
    expect(await loadCodexRelayProviderProfile(directory)).toEqual({
      state: "unsupported",
      reason: "PROTECTED_DECLARATION",
      effectivePolicy: "unverified",
    });
  });

  it("keeps the parent protection accessor usable without a file read or authorization call", async () => {
    const directory = await createProfile(
      selectedProviderConfig([`http_headers={Authorization="Bearer ${secretCanary}"}`]),
    );
    const result = await loadCodexRelayProviderProfile(directory);
    if (result.state !== "supported") throw new Error("Expected a static provider profile.");
    await rm(join(directory, "config.toml"));
    const protectedValues = result.getProtectedValues();
    expect(protectedValues).toContain(secretCanary);
    expect(protectedValues).toContain(`Bearer ${secretCanary}`);
    expect(Object.isFrozen(protectedValues)).toBe(true);
    expect(result.getProtectedValues()).toBe(protectedValues);
    expect(JSON.stringify(result)).not.toContain(secretCanary);
  });

  it("keeps a public header exception separate from the same literal used by an authentication header", async () => {
    const directory = await createProfile(
      selectedProviderConfig(['http_headers={"X-Source"="worker",Authorization="worker"}']),
    );
    await writeFile(
      join(directory, "provider-metadata-policy.json"),
      JSON.stringify({
        schemaVersion: "CodexProviderMetadataPolicyV1",
        publicHeaders: [
          {
            providerId: "review-provider",
            endpoint: "https://inference.example.invalid/v1",
            header: "X-Source",
            value: "worker",
          },
        ],
      }),
    );
    const result = await loadCodexRelayProviderProfile(directory);
    if (result.state !== "supported")
      throw new Error("Expected public declaration fields without secrets.");
    expect(result.getProtectedValues()).toEqual(["worker"]);
    expect((await result.authorize(new AbortController().signal)).protectedValues).toBe(
      result.getProtectedValues(),
    );
    expect(JSON.stringify(result)).not.toContain('"worker"');
    expect(JSON.stringify(result)).not.toContain("getProtectedValues");
  });

  it("rejects protected values echoed in public declared fields", async () => {
    const source = `model="${secretCanary}"\n${selectedProviderConfig([`http_headers={Authorization="Bearer ${secretCanary}"}`])}`;
    expect(await loadCodexRelayProviderProfile(await createProfile(source))).toEqual({
      state: "unsupported",
      reason: "PROTECTED_DECLARATION",
      effectivePolicy: "unverified",
    });
  });

  it.each([
    selectedProviderConfig([
      `http_headers={Authorization="${secretCanary}",authorization="duplicate"}`,
    ]),
    selectedProviderConfig(['requires_openai_auth="false"']),
    selectedProviderConfig(["request_max_retries=-1"]),
    selectedProviderConfig([`http_headers={"bad header"="${secretCanary}"}`]),
    `model="""${secretCanary}`,
  ])("keeps malformed static configuration failures value-free", async (source) => {
    let failure: unknown;
    try {
      await loadCodexRelayProviderProfile(await createProfile(source));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: null, showHidden: true })).not.toContain(secretCanary);
  });

  it("retains the shared bounded regular-file and UTF-8 checks", async () => {
    const oversized = await createProfile(`#${"x".repeat(maximumConfigBytes)}`);
    await expect(loadCodexRelayProviderProfile(oversized)).rejects.toThrow("regular file");
    const invalid = await createProfile(Buffer.from([0xff]));
    await expect(loadCodexRelayProviderProfile(invalid)).rejects.toThrow(
      "could not be read safely",
    );
  });

  it("protects authentication values after HTTP whitespace normalization", async () => {
    const directory = await createProfile(
      `model="plain-fixture-value"\n${selectedProviderConfig(['http_headers={"X-API-Key"=" plain-fixture-value "}'])}`,
    );
    expect(await loadCodexRelayProviderProfile(directory)).toEqual({
      state: "unsupported",
      reason: "PROTECTED_DECLARATION",
      effectivePolicy: "unverified",
    });
    await writeFile(
      join(directory, "config.toml"),
      selectedProviderConfig(['http_headers={"X-API-Key"=" plain-fixture-value "}']),
    );
    const supported = await loadCodexRelayProviderProfile(directory);
    if (supported.state !== "supported")
      throw new Error("Expected safe public declaration fields.");
    const authorization = await supported.authorize(new AbortController().signal);
    expect(authorization.protectedValues).toEqual([" plain-fixture-value ", "plain-fixture-value"]);
  });

  it.each(["X-Authentication", "X-Credential"])(
    "keeps relay authentication header %s protected despite a legacy public declaration",
    async (header) => {
      const directory = await createProfile(
        `model="plain-fixture-value"\n${selectedProviderConfig([`http_headers={"${header}"="plain-fixture-value"}`])}`,
      );
      await writeFile(
        join(directory, "provider-metadata-policy.json"),
        JSON.stringify({
          schemaVersion: "CodexProviderMetadataPolicyV1",
          publicHeaders: [
            {
              providerId: "review-provider",
              endpoint: "https://inference.example.invalid/v1",
              header,
              value: "plain-fixture-value",
            },
          ],
        }),
      );
      expect(await loadCodexRelayProviderProfile(directory)).toEqual({
        state: "unsupported",
        reason: "PROTECTED_DECLARATION",
        effectivePolicy: "unverified",
      });
      // Existing direct-provider classifications retain their original behavior.
      expect((await loadCodexProviderProfile(directory)).protectedValues).toEqual([]);
    },
  );
});

async function loadConfiguration(source: string): Promise<TomlTable> {
  const directory = await createProfile(source);
  const profile = await loadCodexProviderProfile(directory);
  return parse(profile.configurationOverrides.join("\n"));
}

async function expectRedactedFailure(directory: string): Promise<Error> {
  let failure: unknown;
  try {
    await loadCodexProviderProfile(directory);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected profile loading to fail.");
  expect(failure.message.length).toBeGreaterThan(0);
  expect(failure.cause).toBeUndefined();
  expect(inspect(failure, { depth: null, showHidden: true })).not.toContain(secretCanary);
  expect(JSON.stringify(failure)).not.toContain(secretCanary);
  return failure;
}

function selectedProviderConfig(providerLines: readonly string[]): string {
  return [
    'model_provider = "review-provider"',
    '[model_providers."review-provider"]',
    'name = "Review provider"',
    'base_url = "https://inference.example.invalid/v1"',
    ...providerLines,
  ].join("\n");
}

describe("loadCodexProviderProfile file handling", () => {
  it("uses defaults when config.toml is missing", async () => {
    const directory = await createProfile();

    await expect(loadCodexProviderProfile(directory)).resolves.toEqual({
      configurationOverrides: [],
      providerEnvironment: {},
      protectedValues: [],
    });
  });

  it.each(["", "# An intentionally empty provider profile.\n"])(
    "uses defaults for an empty TOML document",
    async (source) => {
      const directory = await createProfile(source);

      await expect(loadCodexProviderProfile(directory)).resolves.toEqual({
        configurationOverrides: [],
        providerEnvironment: {},
        protectedValues: [],
      });
    },
  );

  it("accepts a regular file at the 64 KiB limit", async () => {
    const prefix = 'model = "boundary-model"\n#';
    const source = prefix + "a".repeat(maximumConfigBytes - Buffer.byteLength(prefix));

    expect(Buffer.byteLength(source)).toBe(maximumConfigBytes);
    await expect(loadConfiguration(source)).resolves.toEqual({ model: "boundary-model" });
  });

  it("rejects a file larger than 64 KiB by UTF-8 byte count", async () => {
    const source = `#${secretCanary}\n#${"é".repeat(maximumConfigBytes / 2)}`;
    const directory = await createProfile(source);

    expect(source.length).toBeLessThan(maximumConfigBytes);
    expect(Buffer.byteLength(source)).toBeGreaterThan(maximumConfigBytes);
    await expectRedactedFailure(directory);
  });

  it("rejects a directory named config.toml", async () => {
    const directory = await createProfile();
    await mkdir(join(directory, "config.toml"));

    await expectRedactedFailure(directory);
  });

  it("rejects a symlink to an otherwise valid regular config file", async () => {
    const directory = await createProfile();
    const target = join(directory, "actual-config.toml");
    await writeFile(target, 'model = "symlink-model"\n');
    await symlink(target, join(directory, "config.toml"), "file");

    await expectRedactedFailure(directory);
  });

  it("rejects invalid UTF-8 without exposing file bytes", async () => {
    const directory = await createProfile(
      Buffer.concat([Buffer.from(`#${secretCanary}\n`), Buffer.from([0xff, 0xfe])]),
    );

    await expectRedactedFailure(directory);
  });

  it("redacts malformed TOML and discards the original parser error", async () => {
    const first = await createProfile(`model = """${secretCanary}`);
    const second = await createProfile(`model = "initial"\nmodel = "${secretCanary}"\n`);

    const firstFailure = await expectRedactedFailure(first);
    const secondFailure = await expectRedactedFailure(second);
    expect(firstFailure.message).toBe(secondFailure.message);
  });
});

describe("loadCodexProviderProfile allowed configuration", () => {
  it("exports every allowed root field and only the selected provider", async () => {
    const directory = await createProfile(`
model = "review-model"
model_provider = "review-provider"
model_reasoning_effort = "high"
model_context_window = 200000
model_auto_compact_token_limit = 150000
cli_auth_credentials_store = "auto"
forced_login_method = "chatgpt"
forced_chatgpt_workspace_id = "11111111-2222-4333-8444-555555555555"

[model_providers.review-provider]
name = "Review provider"
base_url = "https://inference.example.invalid/v1"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true
request_max_retries = 3
stream_max_retries = 4
stream_idle_timeout_ms = 120000
auth = { command = "synthetic-auth-helper", args = ["--account", "review"] }
http_headers = { "X-Request-Source" = "worker", "OpenAI-Beta" = "responses=v1" }

[model_providers.unselected]
name = "Unused provider"
experimental_bearer_token = "${secretCanary}"
env_key = "SYNTHETIC_UNUSED_API_KEY"
`);
    const profile = await loadCodexProviderProfile(directory);
    const configuration = parse(profile.configurationOverrides.join("\n"));

    expect(configuration).toEqual({
      model: "review-model",
      model_provider: "review-provider",
      model_reasoning_effort: "high",
      model_context_window: 200000,
      model_auto_compact_token_limit: 150000,
      cli_auth_credentials_store: "auto",
      forced_login_method: "chatgpt",
      forced_chatgpt_workspace_id: "11111111-2222-4333-8444-555555555555",
      model_providers: {
        "review-provider": {
          name: "Review provider",
          base_url: "https://inference.example.invalid/v1",
          wire_api: "responses",
          supports_websockets: true,
          requires_openai_auth: true,
          request_max_retries: 3,
          stream_max_retries: 4,
          stream_idle_timeout_ms: 120000,
          auth: { command: "synthetic-auth-helper", args: ["--account", "review"] },
          env_http_headers: {
            "X-Request-Source": "CODEX_PROVIDER_HEADER_0",
            "OpenAI-Beta": "CODEX_PROVIDER_HEADER_1",
          },
        },
      },
    });
    expect(profile.providerEnvironment).toEqual({
      CODEX_PROVIDER_HEADER_0: "worker",
      CODEX_PROVIDER_HEADER_1: "responses=v1",
    });
    expect(profile.protectedValues).toEqual(["worker", "responses=v1"]);
    expect(JSON.stringify(configuration)).not.toContain(secretCanary);
  });

  it("keeps model settings without selecting any provider table", async () => {
    const configuration = await loadConfiguration(`
model = "review-model"
model_reasoning_effort = "medium"

[model_providers.unselected]
experimental_bearer_token = "${secretCanary}"
`);

    expect(configuration).toEqual({ model: "review-model", model_reasoning_effort: "medium" });
  });

  it("preserves a built-in provider selection without a custom provider table", async () => {
    await expect(loadConfiguration('model_provider = "openai"\n')).resolves.toEqual({
      model_provider: "openai",
    });
  });

  it("serializes dotted and quoted provider names through a single top-level table override", async () => {
    const name = 'review."provider';
    const directory = await createProfile(`
model_provider = ${JSON.stringify(name)}
[model_providers.${JSON.stringify(name)}]
name = "Quoted provider"
base_url = "https://inference.example.invalid/v1"
`);
    const profile = await loadCodexProviderProfile(directory);
    const providerOverrides = profile.configurationOverrides.filter((override) =>
      override.startsWith("model_providers"),
    );

    expect(providerOverrides).toHaveLength(1);
    expect(providerOverrides[0]?.startsWith("model_providers=")).toBe(true);
    expect(parse(profile.configurationOverrides.join("\n"))).toEqual({
      model_provider: name,
      model_providers: {
        [name]: { name: "Quoted provider", base_url: "https://inference.example.invalid/v1" },
      },
    });
  });

  it.each(["__proto__", "constructor", "toString"])(
    "does not select inherited object property %s as a provider",
    async (name) => {
      const configuration = await loadConfiguration(`
model_provider = "${name}"
[model_providers.unselected]
name = "Unused provider"
`);

      expect(configuration).toEqual({ model_provider: name });
    },
  );

  it("parses literal strings, dotted keys, comments, and inline tables as TOML", async () => {
    const configuration = await loadConfiguration(`
# Dotted keys must retain their actual TOML structure.
model = 'review-"quoted"-model'
model_provider = 'review-provider'
model_providers.review-provider.name = 'Literal provider'
model_providers.review-provider.base_url = 'https://inference.example.invalid/v1'
model_providers.review-provider.auth = { command = 'C:\\Tools\\auth-helper.exe', args = ['--scope', 'review'] }
`);

    expect(configuration).toEqual({
      model: 'review-"quoted"-model',
      model_provider: "review-provider",
      model_providers: {
        "review-provider": {
          name: "Literal provider",
          base_url: "https://inference.example.invalid/v1",
          auth: { command: "C:\\Tools\\auth-helper.exe", args: ["--scope", "review"] },
        },
      },
    });
  });

  it("preserves quoted provider names, false flags, and zero retry limits", async () => {
    const configuration = await loadConfiguration(`
model_provider = "review.provider"
[model_providers."review.provider"]
name = "Quoted provider"
base_url = "https://inference.example.invalid/v1"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`);

    expect(configuration).toEqual({
      model_provider: "review.provider",
      model_providers: {
        "review.provider": {
          name: "Quoted provider",
          base_url: "https://inference.example.invalid/v1",
          supports_websockets: false,
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
    });
  });

  it("does not export execution, instruction, MCP, or plugin configuration", async () => {
    const configuration = await loadConfiguration(`
model = "review-model"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
developer_instructions = "${secretCanary}"
notify = ["synthetic-notifier", "${secretCanary}"]
api_key = "${secretCanary}"

[shell_environment_policy]
inherit = "all"
set = { PRIVATE_TOKEN = "${secretCanary}" }

[sandbox_workspace_write]
writable_roots = ["C:\\\\Outside"]
network_access = true

[mcp_servers.unwanted]
command = "synthetic-mcp-server"
args = ["${secretCanary}"]

[features]
hooks = true
apps = true

[plugins.unwanted]
enabled = true

[projects.'C:\\Unrelated']
trust_level = "trusted"

[[skills.config]]
path = "unrelated-skill"
enabled = true

[[hooks.SessionStart]]
hooks = [{ type = "command", command = "${secretCanary}" }]
`);

    expect(configuration).toEqual({ model: "review-model" });
    expect(JSON.stringify(configuration)).not.toContain(secretCanary);
  });

  it("returns no overrides for a config containing only unrelated settings", async () => {
    const directory = await createProfile(`
approval_policy = "on-request"
notify = ["${secretCanary}"]
[model_providers.unselected]
experimental_bearer_token = "${secretCanary}"
`);

    await expect(loadCodexProviderProfile(directory)).resolves.toEqual({
      configurationOverrides: [],
      providerEnvironment: {},
      protectedValues: [],
    });
  });
});

describe("loadCodexProviderProfile secret rejection", () => {
  it.each([
    "experimental_bearer_token",
    "env_key",
    "api_key",
    "API_KEY",
    "apiKey",
    "openai_api_key",
    "token",
    "access_token",
    "refreshToken",
  ])("rejects selected provider field %s without disclosing its value", async (name) => {
    const directory = await createProfile(selectedProviderConfig([`${name} = "${secretCanary}"`]));

    await expectRedactedFailure(directory);
  });

  it("rejects preconfigured environment header references", async () => {
    const directory = await createProfile(
      selectedProviderConfig([`env_http_headers = { Authorization = "${secretCanary}" }`]),
    );

    await expectRedactedFailure(directory);
  });

  it.each([
    "Authorization",
    "authorization",
    "PROXY-AUTHORIZATION",
    "Cookie",
    "cookie",
    "Set-Cookie",
    "X-API-Key",
    "x-api-key",
    "X-Auth-Token",
    "__proto__",
  ])("moves header %s into a generated provider environment reference", async (name) => {
    const directory = await createProfile(
      selectedProviderConfig([`http_headers = { "${name}" = "${secretCanary}" }`]),
    );

    const profile = await loadCodexProviderProfile(directory);
    expect(profile.configurationOverrides.join("\n")).not.toContain(secretCanary);
    expect(parse(profile.configurationOverrides.join("\n"))).toEqual({
      model_provider: "review-provider",
      model_providers: {
        "review-provider": {
          name: "Review provider",
          base_url: "https://inference.example.invalid/v1",
          env_http_headers: { [name]: "CODEX_PROVIDER_HEADER_0" },
        },
      },
    });
    expect(profile.providerEnvironment).toEqual({ CODEX_PROVIDER_HEADER_0: secretCanary });
    expect(profile.protectedValues).toEqual([secretCanary]);
  });

  it("rejects duplicate header names regardless of case", async () => {
    const directory = await createProfile(
      selectedProviderConfig([
        `http_headers = { Authorization = "first", authorization = "${secretCanary}" }`,
      ]),
    );

    await expectRedactedFailure(directory);
  });

  it("omits dynamic provider names from diagnostics", async () => {
    const directory = await createProfile(`
model_provider = "${secretCanary}"
[model_providers."${secretCanary}"]
supports_websockets = "invalid"
`);

    await expectRedactedFailure(directory);
  });

  it("omits invalid dynamic header names from diagnostics", async () => {
    const directory = await createProfile(
      selectedProviderConfig([`http_headers = { "${secretCanary} invalid" = "value" }`]),
    );

    await expectRedactedFailure(directory);
  });

  it("rejects more than 64 selected provider headers", async () => {
    const headers = Array.from(
      { length: 65 },
      (_, index) => `"X-Header-${index}" = "${secretCanary}"`,
    );
    const directory = await createProfile(
      selectedProviderConfig([`http_headers = { ${headers.join(", ")} }`]),
    );

    await expectRedactedFailure(directory);
  });

  it("accepts 64 headers and gives each value a distinct environment reference", async () => {
    const headers = Array.from(
      { length: 64 },
      (_, index) => `"X-Header-${index}" = "${secretCanary}-${index}"`,
    );
    const directory = await createProfile(
      selectedProviderConfig([`http_headers = { ${headers.join(", ")} }`]),
    );

    const profile = await loadCodexProviderProfile(directory);
    expect(profile.configurationOverrides.join("\n")).not.toContain(secretCanary);
    expect(profile.providerEnvironment).toEqual(
      Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `CODEX_PROVIDER_HEADER_${index}`,
          `${secretCanary}-${index}`,
        ]),
      ),
    );
    expect(parse(profile.configurationOverrides.join("\n"))).toMatchObject({
      model_providers: {
        "review-provider": {
          env_http_headers: Object.fromEntries(
            Array.from({ length: 64 }, (_, index) => [
              `X-Header-${index}`,
              `CODEX_PROVIDER_HEADER_${index}`,
            ]),
          ),
        },
      },
    });
  });

  it.each(["\n", "\r", "\0"])(
    "rejects control characters in header values without disclosing them",
    async (character) => {
      const directory = await createProfile(
        selectedProviderConfig([
          `http_headers = { Authorization = ${JSON.stringify(`${secretCanary}${character}`)} }`,
        ]),
      );

      await expectRedactedFailure(directory);
    },
  );

  it.each(["\n", "\r", "\0"])(
    "rejects control characters in header names without disclosing their values",
    async (character) => {
      const directory = await createProfile(
        selectedProviderConfig([
          `http_headers = { ${JSON.stringify(`X-Header${character}`)} = "${secretCanary}" }`,
        ]),
      );

      await expectRedactedFailure(directory);
    },
  );

  it.each([
    `["--api-key", "${secretCanary}"]`,
    `["--token=${secretCanary}"]`,
    `["token=${secretCanary}"]`,
  ])("rejects authentication helper arguments that embed a secret", async (argumentsToml) => {
    const directory = await createProfile(
      selectedProviderConfig([
        `auth = { command = "synthetic-auth-helper", args = ${argumentsToml} }`,
      ]),
    );

    await expectRedactedFailure(directory);
  });

  it("allows a helper script path that reads an external token file", async () => {
    const configuration = await loadConfiguration(
      selectedProviderConfig([
        "auth = { command = 'C:\\Tools\\read-token.ps1', args = ['--file', 'C:\\Profile\\provider-token.json'] }",
      ]),
    );

    expect(configuration).toMatchObject({
      model_providers: {
        "review-provider": {
          auth: {
            command: "C:\\Tools\\read-token.ps1",
            args: ["--file", "C:\\Profile\\provider-token.json"],
          },
        },
      },
    });
  });

  it("rejects nested credential fields in the selected provider", async () => {
    const directory = await createProfile(
      selectedProviderConfig([`credentials = { api_key = "${secretCanary}" }`]),
    );

    await expectRedactedFailure(directory);
  });

  it("rejects secret fields added to an otherwise allowed auth helper", async () => {
    const directory = await createProfile(
      selectedProviderConfig([
        `auth = { command = "synthetic-auth-helper", args = [], token = "${secretCanary}" }`,
      ]),
    );

    await expectRedactedFailure(directory);
  });

  it.each([
    `model = ["${secretCanary}"]`,
    `model_provider = { value = "${secretCanary}" }`,
    `model_context_window = "${secretCanary}"`,
    `model_auto_compact_token_limit = "${secretCanary}"`,
  ])("rejects invalid root value types without printing configuration values", async (source) => {
    const directory = await createProfile(source);

    await expectRedactedFailure(directory);
  });
});

describe("explicit provider metadata policy", () => {
  const endpoint = "https://inference.example.invalid/v1";
  const rule = {
    providerId: "review-provider",
    endpoint,
    header: "X-Request-Source",
    value: "worker",
  };
  const policy = (publicHeaders: unknown[] = [rule]) => ({
    schemaVersion: "CodexProviderMetadataPolicyV1",
    publicHeaders,
  });
  async function writePolicy(directory: string, value: unknown) {
    const content =
      typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    if (content === undefined) throw new Error("The synthetic policy must have JSON content.");
    await writeFile(join(directory, "provider-metadata-policy.json"), content);
  }
  async function metadataProfile(value: unknown = policy(), source?: string) {
    const directory = await createProfile(
      source ??
        selectedProviderConfig([
          `http_headers = { "X-Request-Source" = "worker", Authorization = "${secretCanary}" }`,
        ]),
    );
    await writePolicy(directory, value);
    return directory;
  }

  it("classifies an exact declared literal without exporting its policy or exposing credentials", async () => {
    const profile = await loadCodexProviderProfile(await metadataProfile());
    expect(profile.protectedValues).toEqual([secretCanary]);
    expect(profile.providerEnvironment).toEqual({
      CODEX_PROVIDER_HEADER_0: "worker",
      CODEX_PROVIDER_HEADER_1: secretCanary,
    });
    expect(Object.isFrozen(profile.protectedValues)).toBe(true);
    expect(Object.isFrozen(profile.providerEnvironment)).toBe(true);
    for (const text of [
      "CodexProviderMetadataPolicyV1",
      "publicHeaders",
      "provider-metadata-policy.json",
      secretCanary,
      '"worker"',
    ])
      expect(profile.configurationOverrides.join("\n")).not.toContain(text);
    expect(Object.keys(profile.providerEnvironment)).toEqual([
      "CODEX_PROVIDER_HEADER_0",
      "CODEX_PROVIDER_HEADER_1",
    ]);
  });

  it.each([
    { providerId: "other-provider" },
    { providerId: "Review-provider" },
    { endpoint: `${endpoint}/` },
    { endpoint: "https://INFERENCE.example.invalid/v1" },
    { endpoint: `${endpoint}?version=1` },
    { header: "X-Other-Source" },
    { value: "Worker" },
    { value: "work" },
  ])("keeps unmatched provider/header/literal scope protected: %j", async (replacement) => {
    const profile = await loadCodexProviderProfile(
      await metadataProfile(policy([{ ...rule, ...replacement }])),
    );
    expect(profile.protectedValues).toEqual(["worker", secretCanary]);
  });

  it("matches HTTP header names without case sensitivity and protects the same text from another secret", async () => {
    const declared = policy([{ ...rule, header: "x-request-source" }]);
    const publicProfile = await loadCodexProviderProfile(await metadataProfile(declared));
    expect(publicProfile.protectedValues).toEqual([secretCanary]);
    const collision = await loadCodexProviderProfile(
      await metadataProfile(
        declared,
        selectedProviderConfig([
          'http_headers = { "X-Request-Source" = "worker", Authorization = "worker" }',
        ]),
      ),
    );
    expect(collision.protectedValues).toEqual(["worker"]);
  });

  it("does not infer a default endpoint or provider for a public exception", async () => {
    const missingEndpoint = selectedProviderConfig([
      'http_headers = { "X-Request-Source" = "worker" }',
    ]).replace(`base_url = "${endpoint}"\n`, "");
    expect(
      (await loadCodexProviderProfile(await metadataProfile(policy(), missingEndpoint)))
        .protectedValues,
    ).toEqual(["worker"]);
    const missingProvider = selectedProviderConfig([
      'http_headers = { "X-Request-Source" = "worker" }',
    ]).replace('model_provider = "review-provider"\n', "");
    const profile = await loadCodexProviderProfile(
      await metadataProfile(policy(), missingProvider),
    );
    expect(profile.providerEnvironment).toEqual({});
    expect(profile.protectedValues).toEqual([]);
  });

  it.each(["7", "worker", "short"])(
    "keeps the unclassified literal %s protected regardless of length",
    async (value) => {
      const directory = await createProfile(
        selectedProviderConfig([`http_headers = { "X-Custom" = ${JSON.stringify(value)} }`]),
      );
      expect((await loadCodexProviderProfile(directory)).protectedValues).toEqual([value]);
    },
  );

  it.each(["Bearer opaque", "token=opaque", "Authorization: Token opaque"])(
    "retains generic credential-pattern protection for an approved literal %s",
    async (value) => {
      const directory = await metadataProfile(
        policy([{ ...rule, value }]),
        selectedProviderConfig([
          `http_headers = { "X-Request-Source" = ${JSON.stringify(value)} }`,
        ]),
      );
      expect((await loadCodexProviderProfile(directory)).protectedValues).toEqual([value]);
    },
  );

  it.each([
    "Authorization",
    "authorization",
    "PROXY-AUTHORIZATION",
    "Cookie",
    "Set-Cookie",
    "Authentication-Info",
    "X-API-Key",
    "X-Auth-Token",
    "X-Custom-Secret",
  ])("rejects public declarations for authentication header %s", async (header) => {
    await expectRedactedFailure(
      await metadataProfile(policy([{ ...rule, header, value: secretCanary }])),
    );
  });

  it.each(["X-Request-Source", "x-request-source"])(
    "rejects a duplicate header rule rather than allowing %s to overwrite it",
    async (header) => {
      await expectRedactedFailure(
        await metadataProfile(policy([rule, { ...rule, header, value: secretCanary }])),
      );
    },
  );

  it.each(
    [
      null,
      [],
      {},
      { schemaVersion: "unsupported", publicHeaders: [] },
      { ...policy(), extra: secretCanary },
      policy([{ ...rule, extra: secretCanary }]),
      policy([{ ...rule, providerId: "x".repeat(129) }]),
      policy([{ ...rule, endpoint: `https://example.invalid/${"x".repeat(2048)}` }]),
      policy([{ ...rule, header: "X".repeat(129) }]),
      policy([{ ...rule, value: "x".repeat(1025) }]),
      policy([{ ...rule, value: `${secretCanary}\n` }]),
      policy([{ ...rule, value: "\ud800" }]),
      policy([{ ...rule, endpoint: "https://user:password@example.invalid/v1" }]),
      policy([{ ...rule, endpoint: "https://example.invalid/v1?api_key=hidden" }]),
      policy(Array.from({ length: 65 }, (_, index) => ({ ...rule, header: `X-Meta-${index}` }))),
    ].map((value) => ({ value })),
  )(
    "rejects invalid or unbounded policy shape %# without reflecting content",
    async ({ value }) => {
      await expectRedactedFailure(await metadataProfile(value));
    },
  );

  it("rejects duplicate JSON properties including escaped aliases", async () => {
    for (const raw of [
      '{"schemaVersion":"CodexProviderMetadataPolicyV1","publicHeaders":[],"publicHeaders":[]}',
      `{"schemaVersion":"CodexProviderMetadataPolicyV1","publicHeaders":[{"providerId":"review-provider","endpoint":"${endpoint}","header":"X-Request-Source","value":"worker","v\\u0061lue":"${secretCanary}"}]}`,
    ])
      await expectRedactedFailure(await metadataProfile(raw));
  });

  it("accepts the exact file byte limit and rejects the next byte and malformed UTF-8", async () => {
    const raw = JSON.stringify(policy());
    const padded = raw + " ".repeat(maximumConfigBytes - Buffer.byteLength(raw));
    const directory = await metadataProfile(padded);
    expect((await loadCodexProviderProfile(directory)).protectedValues).toEqual([secretCanary]);
    await writePolicy(directory, `${padded} `);
    await expectRedactedFailure(directory);
    await writePolicy(directory, Buffer.concat([Buffer.from(raw), Buffer.from([0xff])]));
    await expectRedactedFailure(directory);
  });

  it("rejects non-regular policy files and symlink aliases", async () => {
    const directory = await createProfile(selectedProviderConfig([]));
    await mkdir(join(directory, "provider-metadata-policy.json"));
    await expectRedactedFailure(directory);
    const linked = await createProfile(selectedProviderConfig([]));
    const target = join(linked, "metadata-policy-source.json");
    await writeFile(target, JSON.stringify(policy()));
    await symlink(target, join(linked, "provider-metadata-policy.json"), "file");
    await expectRedactedFailure(linked);
  });
});
