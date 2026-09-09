import { inspect } from "node:util";
import { buildCodexExecLaunchSpec } from "@agentic-review/codex";
import type {
  ModelInvocationOpeningV1,
  ModelInvocationScopeV1,
  ModelInvocationScopeV2,
} from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import {
  createModelRelayLaunchProfile,
  ModelRelayLaunchError,
  type ModelRelayLaunchProfileInput,
} from "./model-relay-launch.js";

const hash = (character: string) => character.repeat(64);
const token = Buffer.alloc(32, 1).toString("base64url");
const secondToken = Buffer.alloc(32, 2).toString("base64url");

function fixture(): ModelRelayLaunchProfileInput {
  const scope: ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: "repository-a",
    evaluationId: "evaluation-a",
    cellId: "cell-a",
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    attemptId: "attempt-a",
    invocationId: "invocation-a",
    authorizationId: "authorization-a",
    executionManifestSha256: hash("1"),
    promptSha256: hash("2"),
    outputSchemaSha256: hash("3"),
    expectedModelIdentitySha256: hash("4"),
    requestedModel: "requested-model-alias",
    workerNodeId: "worker-node-a",
    workerInstanceId: "worker-instance-a",
    leaseGeneration: 1,
  };
  const opening: ModelInvocationOpeningV1 = {
    schemaVersion: "ModelInvocationOpeningV1",
    scope,
    scopeSha256: modelInvocationScopeDigest(scope),
    runtime: {
      providerId: "actual-upstream-provider",
      endpointSha256: hash("a"),
      client: {
        kind: "codex_cli",
        version: "synthetic-client",
        executableSha256: hash("b"),
        launchPolicySha256: hash("c"),
      },
      relay: { implementationSha256: hash("d"), policySha256: hash("e") },
    },
    openedAt: "2026-09-08T00:00:00.000Z",
  };
  return {
    session: { opening, relay: { url: "http://127.0.0.1:49152/v1", bearerToken: token } },
    expectedScope: structuredClone(scope),
    promptSha256: scope.promptSha256,
    outputSchemaSha256: scope.outputSchemaSha256,
  };
}

function config(input = fixture()) {
  const profile = createModelRelayLaunchProfile(input);
  return {
    profile,
    parsed: parse(profile.configurationOverrides.join("\n")) as Record<string, unknown>,
  };
}

function summaryFixture(): ModelRelayLaunchProfileInput {
  const input = fixture();
  const scope: ModelInvocationScopeV2 = {
    ...input.expectedScope,
    schemaVersion: "ModelInvocationScopeV2",
    purpose: "validation_summary",
    inputRef: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: hash("5"),
      sourcePromptSha256: input.expectedScope.promptSha256,
      outputSchemaSha256: input.expectedScope.outputSchemaSha256,
      contextSha256: hash("6"),
      actualPromptSha256: hash("7"),
    },
  };
  return {
    ...input,
    expectedScope: scope,
    promptSha256: scope.inputRef.actualPromptSha256,
    session: {
      ...input.session,
      opening: {
        ...input.session.opening,
        schemaVersion: "ModelInvocationOpeningV2",
        scope: structuredClone(scope),
        scopeSha256: modelInvocationScopeDigest(scope),
      },
    },
  };
}

describe("parent-owned relay launch profile", () => {
  it("uses the bound actual summary prompt while retaining source Prompt identity", () => {
    const input = summaryFixture();
    const { profile, parsed } = config(input);
    expect(input.promptSha256).not.toBe(input.expectedScope.promptSha256);
    expect(parsed.model).toBe(input.expectedScope.requestedModel);
    expect(profile.providerEnvironment).toEqual({ CODEX_PROVIDER_HEADER_0: `Bearer ${token}` });
    expect(profile.protectedValues).toEqual([token, `Bearer ${token}`]);
  });

  it.each(["template", "source", "schema", "opening_version", "reference"])(
    "refuses a mismatched V2 launch binding: %s",
    (field) => {
      const input = summaryFixture();
      if (
        input.expectedScope.schemaVersion !== "ModelInvocationScopeV2" ||
        input.session.opening.scope.schemaVersion !== "ModelInvocationScopeV2"
      )
        throw new Error("Expected summary scope.");
      if (field === "template")
        Reflect.set(input, "promptSha256", input.expectedScope.promptSha256);
      if (field === "source") input.expectedScope.inputRef.sourcePromptSha256 = hash("8");
      if (field === "schema") input.expectedScope.inputRef.outputSchemaSha256 = hash("8");
      if (field === "opening_version")
        Reflect.set(input.session.opening, "schemaVersion", "ModelInvocationOpeningV1");
      if (field === "reference") {
        input.session.opening.scope.inputRef.inputId = "different-summary-input";
        input.session.opening.scopeSha256 = modelInvocationScopeDigest(input.session.opening.scope);
      }
      expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
    },
  );

  it("builds only the requested alias and one fixed Responses relay provider", () => {
    const { profile, parsed } = config();
    expect(parsed).toEqual({
      model: "requested-model-alias",
      model_provider: "agentic_review_parent_relay",
      model_providers: {
        agentic_review_parent_relay: {
          name: "Agentic Review parent relay",
          base_url: "http://127.0.0.1:49152/v1",
          wire_api: "responses",
          supports_websockets: false,
          requires_openai_auth: false,
          env_http_headers: { Authorization: "CODEX_PROVIDER_HEADER_0" },
        },
      },
    });
    expect(profile.providerEnvironment).toEqual({ CODEX_PROVIDER_HEADER_0: `Bearer ${token}` });
    expect(profile.protectedValues).toEqual([token, `Bearer ${token}`]);
    expect(JSON.stringify(profile.configurationOverrides)).not.toContain(token);
    expect(JSON.stringify(parsed)).not.toContain("actual-upstream-provider");
    expect(profile).not.toHaveProperty("effectivePolicy");
    expect(profile).not.toHaveProperty("executionAccepted");
  });

  it("produces immutable, independent profiles for successive invocations", () => {
    const input = fixture();
    const first = createModelRelayLaunchProfile(input);
    Object.assign(input.session.relay, {
      url: "http://127.0.0.1:49153/v1",
      bearerToken: secondToken,
    });
    input.session.opening.scope.invocationId = "invocation-b";
    input.session.opening.scope.attemptId = "attempt-b";
    input.session.opening.scope.requestedModel = "second-requested-alias";
    input.session.opening.scopeSha256 = modelInvocationScopeDigest(input.session.opening.scope);
    Object.assign(input.expectedScope, input.session.opening.scope);
    const second = createModelRelayLaunchProfile(input);
    expect(first.providerEnvironment).toEqual({ CODEX_PROVIDER_HEADER_0: `Bearer ${token}` });
    expect(second.providerEnvironment).toEqual({
      CODEX_PROVIDER_HEADER_0: `Bearer ${secondToken}`,
    });
    expect(first.configurationOverrides.join("\n")).toContain("49152");
    expect(second.configurationOverrides.join("\n")).toContain("49153");
    expect(second.configurationOverrides).toContain('model="second-requested-alias"');
    expect(second.configurationOverrides).not.toContain('model="requested-model-alias"');
    for (const value of [
      first,
      first.configurationOverrides,
      first.providerEnvironment,
      first.protectedValues,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(second.protectedValues).not.toContain(token);
  });

  it("captures only launch metadata without reading unrelated session methods or legacy settings", () => {
    const input = fixture();
    const getter = vi.fn(() => {
      throw new Error("private legacy settings");
    });
    Object.defineProperty(input.session, "close", { get: getter });
    Object.defineProperty(input.session, "attachProcess", { get: getter });
    Object.defineProperty(input, "codexProviderEnvironment", { get: getter });
    Object.defineProperty(input, "codexConfigurationOverrides", { get: getter });
    expect(createModelRelayLaunchProfile(input).providerEnvironment).toEqual({
      CODEX_PROVIDER_HEADER_0: `Bearer ${token}`,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("quotes the requested model as a single TOML string without creating assignments", () => {
    const input = fixture();
    const alias = 'alias "quoted" \\ model_provider="other"';
    input.expectedScope.requestedModel = alias;
    input.session.opening.scope.requestedModel = alias;
    input.session.opening.scopeSha256 = modelInvocationScopeDigest(input.session.opening.scope);
    const { parsed } = config(input);
    expect(parsed.model).toBe(alias);
    expect(parsed.model_provider).toBe("agentic_review_parent_relay");
    expect(Object.keys(parsed)).toEqual(["model", "model_provider", "model_providers"]);
  });

  it("fits the existing replacement-environment launch builder without additional provider variables", () => {
    const input = fixture();
    const profile = createModelRelayLaunchProfile(input);
    const spec = buildCodexExecLaunchSpec({
      executable: "C:\\Service\\Tools\\codex.exe",
      workingDirectory: "C:\\Service\\Runs\\attempt-a\\checkout",
      processWorkingDirectory: "C:\\Service\\Runs\\attempt-a\\control",
      controlRootDirectory: "C:\\Service\\Runs\\attempt-a\\control",
      prompt: "Synthetic prompt.",
      outputSchemaPath: "C:\\Service\\Runs\\attempt-a\\control\\schema.json",
      outputLastMessagePath: "C:\\Service\\Runs\\attempt-a\\control\\result.json",
      configurationOverrides: profile.configurationOverrides,
      providerEnvironment: profile.providerEnvironment,
      sandboxMode: "read-only",
      environment: {
        CODEX_HOME: "C:\\Service\\Codex",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
        SYSTEMROOT: "C:\\Windows",
        TEMP: "C:\\Service\\Runs\\attempt-a\\temp",
        USERPROFILE: "C:\\Service\\Runs\\attempt-a\\profile",
      },
      limits: {
        hardTimeoutMs: 10_000,
        maximumProcessCount: 2,
        maximumMemoryBytes: 128 * 1024 * 1024,
        maximumOutputBytes: 4096,
      },
    });
    expect(spec.environmentMode).toBe("replace");
    expect(
      Object.keys(spec.environment).filter((key) => key.startsWith("CODEX_PROVIDER_")),
    ).toEqual(["CODEX_PROVIDER_HEADER_0"]);
    expect(spec.environment.CODEX_PROVIDER_HEADER_0).toBe(`Bearer ${token}`);
    expect(spec.arguments.join(" ")).not.toContain(token);
    expect(spec.standardInput).not.toContain(token);
    expect(spec.arguments).toContain("--ignore-user-config");
    expect(spec.arguments).toContain("--ignore-rules");
  });

  const scopeFields = [
    "repositoryId",
    "evaluationId",
    "cellId",
    "runId",
    "requestId",
    "jobId",
    "attemptId",
    "invocationId",
    "authorizationId",
    "executionManifestSha256",
    "promptSha256",
    "outputSchemaSha256",
    "expectedModelIdentitySha256",
    "requestedModel",
    "workerNodeId",
    "workerInstanceId",
    "leaseGeneration",
  ] as const;
  it.each(scopeFields)("rejects a correctly hashed opening for another %s", (field) => {
    const input = fixture();
    if (field === "leaseGeneration") input.session.opening.scope[field] = 2;
    else
      input.session.opening.scope[field] = field.endsWith("Sha256")
        ? hash("9")
        : "foreign-identity";
    input.session.opening.scopeSha256 = modelInvocationScopeDigest(input.session.opening.scope);
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
  });

  it.each(["promptSha256", "outputSchemaSha256"] as const)(
    "requires the actual input %s to match the independent scope",
    (field) => {
      const input = fixture();
      Object.assign(input, { [field]: hash("9") });
      expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
    },
  );

  it("rejects a scope digest copied from another opening", () => {
    const input = fixture();
    input.session.opening.scopeSha256 = hash("9");
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
  });

  it.each([
    "http://localhost:49152/v1",
    "http://[::1]:49152/v1",
    "https://127.0.0.1:49152/v1",
    "http://127.0.0.2:49152/v1",
    "http://127.0.0.1/v1",
    "http://127.0.0.1:80/v1",
    "http://127.0.0.1:0/v1",
    "http://127.0.0.1:65536/v1",
    "http://127.0.0.1:049152/v1",
    "http://127.0.0.1:49152/v1/",
    "http://127.0.0.1:49152/v1/responses",
    "http://127.0.0.1:49152/v2",
    "http://127.0.0.1:49152/%76%31",
    "http://127.0.0.1:49152/a/../v1",
    "http://127.0.0.1:49152/v1?x=1",
    "http://127.0.0.1:49152/v1#fragment",
    "http://user:private@127.0.0.1:49152/v1",
    "http://127.000.000.001:49152/v1",
    " http://127.0.0.1:49152/v1",
    "http://127.0.0.1:49152/v1\n",
  ])("rejects a noncanonical or foreign relay URL %j", (url) => {
    const input = fixture();
    Object.assign(input.session.relay, { url });
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
  });

  it.each([
    "",
    " ",
    "x".repeat(42),
    "x".repeat(44),
    "x".repeat(43),
    `${token}=`,
    `${token}\n`,
    `Bearer ${token}`,
    "/".repeat(43),
  ])("rejects an invalid ephemeral bearer %j", (bearerToken) => {
    const input = fixture();
    Object.assign(input.session.relay, { bearerToken });
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
  });

  it("never places the ephemeral bearer inside a model alias argument", () => {
    const input = fixture();
    input.expectedScope.requestedModel = token;
    input.session.opening.scope.requestedModel = token;
    input.session.opening.scopeSha256 = modelInvocationScopeDigest(input.session.opening.scope);
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
  });

  it.each([
    "session",
    "expectedScope",
    "promptSha256",
    "outputSchemaSha256",
    "opening",
    "relay",
    "url",
    "bearerToken",
    "requestedModel",
    "runtime",
  ])("rejects a %s getter without executing it", (key) => {
    const input = fixture();
    const getter = vi.fn(() => {
      throw new Error(`private ${token}`);
    });
    const target = ["session", "expectedScope", "promptSha256", "outputSchemaSha256"].includes(key)
      ? input
      : ["opening", "relay"].includes(key)
        ? input.session
        : ["url", "bearerToken"].includes(key)
          ? input.session.relay
          : key === "runtime"
            ? input.session.opening
            : input.expectedScope;
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    expect(() => createModelRelayLaunchProfile(input)).toThrow(ModelRelayLaunchError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects Proxy metadata without executing its traps", () => {
    const input = fixture();
    const trap = vi.fn(() => {
      throw new Error("private proxy detail");
    });
    const malicious = new Proxy(input, {
      get: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    expect(() => createModelRelayLaunchProfile(malicious)).toThrow(ModelRelayLaunchError);
    expect(trap).not.toHaveBeenCalled();
  });

  it("keeps rejected metadata and ephemeral credentials out of errors", () => {
    const input = fixture();
    Object.assign(input.session.relay, {
      url: `https://private.example/${token}`,
      bearerToken: `${token}\n`,
    });
    let caught: unknown;
    try {
      createModelRelayLaunchProfile(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelRelayLaunchError);
    expect(inspect(caught, { depth: 8, showHidden: true })).not.toContain(token);
    expect(inspect(caught, { depth: 8, showHidden: true })).not.toContain("private.example");
  });
});
