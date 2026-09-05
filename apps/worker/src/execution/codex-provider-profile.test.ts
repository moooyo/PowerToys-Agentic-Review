import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import { parse, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { loadCodexProviderProfile } from "./codex-provider-profile.js";

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
    });
  });

  it.each(["", "# An intentionally empty provider profile.\n"])(
    "uses defaults for an empty TOML document",
    async (source) => {
      const directory = await createProfile(source);

      await expect(loadCodexProviderProfile(directory)).resolves.toEqual({
        configurationOverrides: [],
        providerEnvironment: {},
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
