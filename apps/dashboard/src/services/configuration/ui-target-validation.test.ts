import {
  UiDriverCapabilities,
  type ValidationProfileConfig,
  type ValidationProfileCreateRequest,
  type ValidationProfileVersion,
  type WebUiConfiguration,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildProfilePublish,
  parseProfileConfig,
  profileFormValues,
  updateProfileProbeFields,
  updateProfileWebTrace,
} from "../../pages/ValidationProfiles/forms";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import { HttpConfigurationAdapter } from "./http-adapter";

const repositoryId = "repository-ui";
const profileId = "profile-ui";
const profileVersionId = "profile-ui-version-1";
const createdAt = "2026-09-07T02:00:00.000Z";

const webUi: WebUiConfiguration = {
  schemaVersion: "UiScenariosV1",
  target: "web",
  service: {
    origin: "managed_loopback",
    portEnvironmentVariable: "UI_TEST_PORT",
    navigation: "same_origin",
  },
  browser: { engine: "chromium", headless: true, viewport: { width: 1_280, height: 720 } },
  launch: {
    stepId: "launch-app",
    mode: "persistent",
    readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 30_000 },
  },
  reset: { strategy: "restart_process" },
  scenarios: [
    {
      id: "show-title",
      name: "Show the saved title",
      required: true,
      timeoutMs: 60_000,
      path: "/editor",
      steps: [
        {
          id: "assert-title",
          name: "The saved title is visible",
          action: "assertText",
          locator: { by: "testId", testId: "saved-title" },
          expected: "Example title",
          match: "exact",
          timeoutMs: 5_000,
        },
      ],
    },
  ],
  evidence: {
    screenshots: "every_assertion",
    screenshotScope: "viewport",
    trace: "on_failure",
    required: true,
  },
};

const config: ValidationProfileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [],
  test: [],
  launch: [
    {
      id: "launch-app",
      name: "Launch the fixture",
      command: { executable: "node", args: ["app.mjs"], workingDirectory: ".", environment: [] },
      timeoutMs: 120_000,
      required: true,
    },
  ],
  cleanup: [],
  requiredCapabilities: [UiDriverCapabilities.web],
  hardTimeoutMs: 600_000,
  noProgressTimeoutMs: 120_000,
  ui: webUi,
};

const publishRequest: ValidationProfileCreateRequest = {
  name: "Web UI checks",
  workflowKind: "pr_ui",
  target: "web",
  required: true,
  config,
  outputSchemaVersion: "ValidationReportV1",
  expectedVersion: 0,
};

const profileVersion: ValidationProfileVersion = {
  id: profileVersionId,
  profileId,
  repositoryId,
  name: publishRequest.name,
  workflowKind: "pr_ui",
  target: "web",
  required: true,
  config,
  outputSchemaVersion: "ValidationReportV1",
  version: 1,
  configSha256: "a".repeat(64),
  createdAt,
  publishedAt: createdAt,
  createdBy: "operator:ui-target-tests",
};

function adapterWith(response: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      }),
  );
  return { fetch, adapter: new HttpConfigurationAdapter({ fetch }) };
}

describe("typed UI profile target validation", () => {
  it("parses a valid Web UI profile without rewriting its configuration", () => {
    expect(parseProfileConfig(JSON.stringify(config), "pr_ui", "web")).toEqual(config);
  });

  it.each(["on_failure", "always", "off"] as const)(
    "preserves the explicitly published trace policy %s through editing and publication",
    (trace) => {
      const published: ValidationProfileVersion = {
        ...profileVersion,
        config: { ...config, ui: { ...webUi, evidence: { ...webUi.evidence, trace } } },
      };
      const form = profileFormValues(published);
      const request = buildProfilePublish(form, repositoryId, published);
      expect(request.config).toEqual(published.config);
      expect(request.config.ui).toMatchObject({ evidence: { trace } });
    },
  );

  it("changes trace capture to Off without changing screenshots, scenarios, or command configuration", () => {
    const original = structuredClone(config);
    const updated = updateProfileWebTrace(JSON.stringify(config), "pr_ui", "web", "off");
    expect(JSON.parse(updated)).toEqual({
      ...config,
      ui: { ...webUi, evidence: { ...webUi.evidence, trace: "off" } },
    });
    expect(config).toEqual(original);
  });

  it("keeps the current Web configuration when applying test observables to the draft", () => {
    const testStep = {
      id: "read-saved-title",
      name: "Read the saved title",
      command: {
        executable: "node",
        args: ["read-title.mjs"],
        workingDirectory: ".",
        environment: [],
      },
      timeoutMs: 30_000,
      required: true,
    };
    const draft = {
      ...config,
      test: [testStep],
      ui: { ...webUi, evidence: { ...webUi.evidence, trace: "off" as const } },
    };
    const fields = [{ id: "title", description: "The saved title.", type: "string" as const }];
    const updated = updateProfileProbeFields(
      JSON.stringify(draft),
      "issue_validation",
      "web",
      testStep.id,
      fields,
    );
    expect(JSON.parse(updated)).toEqual({
      ...draft,
      test: [
        { ...testStep, probeOutput: { schemaVersion: "TestProbeOutputDeclarationV1", fields } },
      ],
    });
  });

  it("does not default trace capture or UI configuration into a legacy profile", () => {
    const legacyConfig = structuredClone(config);
    delete legacyConfig.ui;
    const published = { ...profileVersion, config: legacyConfig };
    expect(
      buildProfilePublish(profileFormValues(published), repositoryId, published).config,
    ).toEqual(legacyConfig);
    expect(() =>
      updateProfileWebTrace(JSON.stringify(legacyConfig), "pr_ui", "web", "off"),
    ).toThrow("Add Web UI scenarios");
    expect(Object.hasOwn(legacyConfig, "ui")).toBe(false);
  });

  it("publishes explicit trace Off without rewriting its evidence settings", async () => {
    const offConfig = {
      ...config,
      ui: { ...webUi, evidence: { ...webUi.evidence, trace: "off" as const } },
    };
    const request = { ...publishRequest, config: offConfig };
    const response = { ...profileVersion, config: offConfig };
    const { adapter, fetch } = adapterWith(response);
    await expect(adapter.publishProfile(repositoryId, request)).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/operator/repositories/${repositoryId}/validation-profiles`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );
  });

  it("publishes a valid Web UI profile and preserves its typed configuration", async () => {
    const { adapter, fetch } = adapterWith(profileVersion);

    await expect(adapter.publishProfile(repositoryId, publishRequest)).resolves.toEqual(
      profileVersion,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/operator/repositories/${repositoryId}/validation-profiles`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(publishRequest) }),
    );
  });

  it("rejects a Web UI configuration for a Windows profile before fetching", async () => {
    const { adapter, fetch } = adapterWith(profileVersion);
    const request: ValidationProfileCreateRequest = {
      ...publishRequest,
      target: "windows_desktop",
    };

    const result = adapter.publishProfile(repositoryId, request);

    await expect(result).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(result).rejects.toMatchObject({
      operation: "publish validation profile",
      path: "config",
      message: "UI configuration target must match the validation profile target.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed typed UI configuration in a publication response", async () => {
    const { adapter } = adapterWith({
      ...profileVersion,
      config: {
        ...config,
        ui: { ...webUi, browser: { ...webUi.browser, engine: "unsupported" } },
      },
    });

    await expect(adapter.publishProfile(repositoryId, publishRequest)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects a publication response whose UI target differs from its profile target", async () => {
    const legacyConfig = structuredClone(config);
    delete legacyConfig.ui;
    const request: ValidationProfileCreateRequest = {
      ...publishRequest,
      target: "windows_desktop",
      config: legacyConfig,
    };
    const { adapter, fetch } = adapterWith({ ...profileVersion, target: "windows_desktop" });

    await expect(adapter.publishProfile(repositoryId, request)).rejects.toMatchObject({
      name: "ReviewControlProtocolError",
      message: "The publish validation profile response contains an invalid validation profile.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a fetched version whose UI target differs from its profile target", async () => {
    const { adapter } = adapterWith({ ...profileVersion, target: "windows_desktop" });

    await expect(
      adapter.getProfileVersion(repositoryId, profileId, profileVersionId),
    ).rejects.toMatchObject({
      name: "ReviewControlProtocolError",
      message:
        "The get validation profile version response contains an invalid validation profile.",
    });
  });

  it("rejects Web UI configuration when the form selects a Windows target", () => {
    expect(() => parseProfileConfig(JSON.stringify(config), "pr_ui", "windows_desktop")).toThrow(
      "UI configuration target must match the validation profile target.",
    );
  });
});
