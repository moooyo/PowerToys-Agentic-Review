import { createHash } from "node:crypto";

import {
  type IssueReproductionRequestV1,
  type ReviewRunPlanInput,
  type ReviewRunRequest,
  type ValidationProfileConfig,
  type ValidationProfileVersion,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import { evaluateReviewRunStructuralReadiness as exportedStructuralReadiness } from "./index.js";
import {
  createReviewRunPlan,
  evaluateReviewRunPlanReadiness,
  evaluateReviewRunStructuralReadiness,
  getRequiredReviewRunRequestBlockers,
  getReviewRunExecutorCapabilityLabels,
} from "./review-run-plan.js";
import { evaluateValidationApproval } from "./validation-policy.js";

const now = "2026-09-07T00:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const actor = { githubUserId: 10, login: "reviewer" };

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("The fixture collection is empty.");
  return value;
}

function profileOf(selected: ReviewRunRequest): ValidationProfileVersion {
  if (selected.profileVersion === null) throw new Error("The fixture profile is missing.");
  return selected.profileVersion;
}

function promptOf(selected: ReviewRunRequest): NonNullable<ReviewRunRequest["prompt"]> {
  if (selected.prompt === null) throw new Error("The fixture prompt is missing.");
  return selected.prompt;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function step(id: string, required = true) {
  return {
    id,
    name: id,
    command: { executable: "tool.exe", args: [id], workingDirectory: ".", environment: [] },
    required,
    timeoutMs: 30_000,
  };
}

function request(
  workflowKind: WorkflowKind = "pr_static_build",
  target: ReviewRunRequest["target"] = "headless",
): ReviewRunRequest {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: workflowKind === "issue_triage" ? [] : [step("build")],
    test: workflowKind === "issue_triage" ? [] : [step("assert")],
    launch: target === "headless" ? [] : [step("launch")],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 120_000,
    noProgressTimeoutMs: 30_000,
  };
  const id = `${workflowKind}-${target}`;
  const profileVersion = {
    id: `version-${id}`,
    profileId: `profile-${id}`,
    repositoryId: "repo-1",
    version: 1,
    name: id,
    workflowKind,
    target,
    config,
    configSha256: hash(canonical(config)),
    required: true,
    outputSchemaVersion:
      workflowKind === "pr_ui" || workflowKind === "issue_validation"
        ? "ValidationReportV1"
        : WorkflowOutputSchemaVersions[workflowKind],
    createdAt: now,
    publishedAt: now,
    createdBy: "operator",
  } as ValidationProfileVersion;
  return {
    requestId: id,
    workflowKind,
    target,
    required: true,
    profileVersion,
    prompt: {
      workflowKind,
      version: {
        id: `prompt-${workflowKind}`,
        templateId: `template-${workflowKind}`,
        version: 1,
        content: `Review ${workflowKind}.`,
        contentSha256: hash(`Review ${workflowKind}.`),
        outputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
        createdAt: now,
        publishedAt: now,
        createdBy: "operator",
      },
    },
  };
}

function input(): ReviewRunPlanInput {
  const revision = {
    kind: "pull_request" as const,
    githubRepositoryId: 100,
    githubWorkItemId: 200,
    revisionKey: hash(`${baseSha}\0${headSha}`),
    baseSha,
    headSha,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  return {
    activationId: "activation-1",
    repository: {
      id: "repo-1",
      githubRepositoryId: 100,
      fullName: "org/repository",
      configurationVersion: 1,
    },
    workItemId: "work-item-1",
    workItem: {
      kind: "pull_request",
      githubWorkItemId: 200,
      githubNodeId: "PR_200",
      githubRepositoryId: 100,
      number: 1,
      title: "Validate the settings",
      body: "Update the settings panel.",
      state: "open",
      author: actor,
      htmlUrl: "https://github.com/org/repository/pull/1",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      isDraft: false,
    },
    revision,
    testedSourceRevision: { kind: "pull_request", baseSha, headSha },
    testedSourceAuthorization: null,
    authorization: {
      requestEpochId: "epoch-1",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      requestKind: "review_request",
      sequence: 1,
      target: actor,
      openedByActor: actor,
      authorizationBasis: "self",
      authorizationPolicyVersion: 1,
      openedByEventId: "event-1",
      openedAt: now,
      currentRevision: revision,
      status: "active",
      closedByEventId: null,
      closedAt: null,
      closeReason: null,
    },
    authorizationPolicy: {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: 10,
      allowlistedActorGithubUserIds: [],
      unknownActorPolicy: "deny",
    },
    requests: [request()],
    runnerSupport: [
      {
        workflowKind: "pr_static_build",
        target: "headless",
        capabilities: [],
        evidenceDelivery: false,
      },
    ],
  };
}

function issueInput(): ReviewRunPlanInput {
  const baseline = input();
  const { isDraft: _isDraft, ...item } = baseline.workItem as Extract<
    ReviewRunPlanInput["workItem"],
    { kind: "pull_request" }
  >;
  const workItem = { ...item, kind: "issue" as const };
  const contentDigest = hash(
    JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
  );
  const revision = {
    kind: "issue" as const,
    githubRepositoryId: 100,
    githubWorkItemId: 200,
    revisionKey: contentDigest,
    contentDigest,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  return {
    ...baseline,
    workItem,
    revision,
    authorization: {
      ...baseline.authorization,
      requestKind: "assignment",
      currentRevision: revision,
    },
    testedSourceRevision: { kind: "commit", headSha },
    testedSourceAuthorization: {
      kind: "operator",
      activationId: baseline.activationId,
      issuer: "https://identity.example.com",
      subject: "operator-1",
      authorizedAt: now,
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      issueRevisionKey: contentDigest,
      headSha,
    },
    requests: [request("issue_validation")],
    runnerSupport: [
      {
        workflowKind: "issue_validation",
        target: "headless",
        capabilities: [],
        evidenceDelivery: true,
      },
    ],
  };
}

function updateConfig(
  selected: ReviewRunRequest,
  change: (config: ValidationProfileConfig) => void,
): void {
  if (selected.profileVersion === null) throw new Error("The fixture profile is missing.");
  change(selected.profileVersion.config);
  selected.profileVersion.configSha256 = hash(canonical(selected.profileVersion.config));
}

function withUiScenarios(selected: ReviewRunRequest): ReviewRunRequest {
  updateConfig(selected, (config) => {
    const scenario = {
      id: "settings-scenario",
      name: "Settings",
      required: true,
      timeoutMs: 30_000,
    };
    const assertion = {
      id: "settings-visible",
      name: "Settings is visible",
      action: "assertVisible" as const,
      expected: true,
      timeoutMs: 5_000,
    };
    if (selected.target === "web") {
      config.ui = {
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
          readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 10_000 },
        },
        reset: { strategy: "restart_process" },
        scenarios: [
          {
            ...scenario,
            path: "/settings",
            steps: [{ ...assertion, locator: { by: "testId", testId: "settings" } }],
          },
        ],
        evidence: {
          screenshots: "every_assertion",
          screenshotScope: "viewport",
          trace: "always",
          required: true,
        },
      };
    } else if (selected.target === "windows_desktop") {
      config.ui = {
        schemaVersion: "UiScenariosV1",
        target: "windows_desktop",
        desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
        launch: {
          stepId: "launch",
          mode: "persistent",
          readiness: { kind: "window", window: { title: "Settings" }, timeoutMs: 10_000 },
        },
        reset: { strategy: "restart_process" },
        scenarios: [
          {
            ...scenario,
            steps: [{ ...assertion, locator: { by: "automationId", automationId: "settings" } }],
          },
        ],
        evidence: {
          screenshots: "every_assertion",
          screenshotScope: "owned_window",
          required: true,
        },
      };
    } else throw new Error("A UI fixture needs an explicit UI target.");
  });
  return selected;
}

function reproductionFor(selected: ReviewRunRequest): IssueReproductionRequestV1 {
  return {
    schemaVersion: "IssueReproductionRequestV1",
    claim: "The settings control remains hidden.",
    cases: [
      {
        id: "settings-hidden",
        profileId: profileOf(selected).profileId,
        expectedProfileVersionId: profileOf(selected).id,
        context: "Open the published settings scenario.",
        preconditions: [],
        presentWhen: {
          allOf: [
            {
              observation:
                selected.target === "headless"
                  ? { kind: "probe_value", testStepId: "assert", observationId: "visible" }
                  : {
                      kind: "ui_assertion",
                      scenarioId: "settings-scenario",
                      stepId: "settings-visible",
                    },
              equals: { type: "boolean", value: false },
            },
          ],
        },
        absentWhen: null,
      },
    ],
  };
}

function withProbe(selected: ReviewRunRequest): ReviewRunRequest {
  updateConfig(selected, (config) => {
    first(config.test).probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: [{ id: "visible", description: "Whether settings is visible.", type: "boolean" }],
    };
  });
  return selected;
}

describe("Review run structural readiness", () => {
  it("allows complete static and UI plans to wait for executors without claiming runtime support", () => {
    const baseline = input();
    baseline.requests = [
      withProbe(request()),
      withUiScenarios(request("pr_ui", "web")),
      withUiScenarios(request("pr_ui", "windows_desktop")),
    ];
    baseline.runnerSupport = [];
    const result = createReviewRunPlan(baseline);

    expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
      { requestId: "pr_static_build-headless", required: true, state: "ready", reasons: [] },
      { requestId: "pr_ui-web", required: true, state: "ready", reasons: [] },
      { requestId: "pr_ui-windows_desktop", required: true, state: "ready", reasons: [] },
    ]);
    expect(result.readiness).toEqual([
      {
        requestId: "pr_static_build-headless",
        required: true,
        state: "blocked",
        reasons: [{ code: "unsupported_target" }],
      },
      {
        requestId: "pr_ui-web",
        required: true,
        state: "blocked",
        reasons: [{ code: "unsupported_target" }],
      },
      {
        requestId: "pr_ui-windows_desktop",
        required: true,
        state: "blocked",
        reasons: [{ code: "unsupported_target" }],
      },
    ]);
    expect(evaluateReviewRunPlanReadiness(result.plan, [])).toEqual(result.readiness);
  });

  it("retains source-authorized reproduction and triage intent while runtime support is absent", () => {
    const baseline = issueInput();
    const selected = withProbe(first(baseline.requests));
    baseline.reproduction = reproductionFor(selected);
    baseline.requests.push(request("issue_triage"));
    baseline.runnerSupport = [];
    const result = createReviewRunPlan(baseline);

    expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
      { requestId: "issue_triage-headless", required: true, state: "ready", reasons: [] },
      { requestId: "issue_validation-headless", required: true, state: "ready", reasons: [] },
    ]);
    expect(result.plan.reproduction?.binding.cases).toHaveLength(1);
    expect(getRequiredReviewRunRequestBlockers(result.readiness)).toEqual([
      { requestId: "issue_triage-headless", reason: "unsupported_target" },
      { requestId: "issue_validation-headless", reason: "unsupported_target" },
    ]);
  });

  it("retains profile and prompt gaps and each request's required status", () => {
    const baseline = input();
    first(baseline.requests).prompt = null;
    baseline.requests.push({
      requestId: "optional-ui",
      workflowKind: "pr_ui",
      target: "web",
      required: false,
      profileVersion: null,
      prompt: null,
    });
    const result = createReviewRunPlan(baseline);
    const readiness = evaluateReviewRunStructuralReadiness(result.plan);

    expect(readiness).toEqual([
      {
        requestId: "optional-ui",
        required: false,
        state: "blocked",
        reasons: [
          { code: "missing_profile" },
          { code: "missing_prompt" },
          { code: "missing_scenarios" },
        ],
      },
      {
        requestId: "pr_static_build-headless",
        required: true,
        state: "blocked",
        reasons: [{ code: "missing_prompt" }],
      },
    ]);
    expect(getRequiredReviewRunRequestBlockers(readiness)).toEqual([
      { requestId: "pr_static_build-headless", reason: "missing_prompt" },
    ]);
  });

  it.each([false, true])(
    "retains Issue source prerequisites when a commit is selected: %s",
    (selectedCommit) => {
      const baseline = issueInput();
      if (!selectedCommit) baseline.testedSourceRevision = null;
      baseline.testedSourceAuthorization = null;
      const result = createReviewRunPlan(baseline);

      expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
        {
          requestId: "issue_validation-headless",
          required: true,
          state: "blocked",
          reasons: selectedCommit
            ? [{ code: "missing_source_authorization" }]
            : [
                { code: "missing_tested_source_revision" },
                { code: "missing_source_authorization" },
              ],
        },
      ]);
    },
  );

  it.each(["web", "windows_desktop"] as const)(
    "retains missing scenarios, build, and launch blockers for %s",
    (target) => {
      const baseline = input();
      const selected = request("pr_ui", target);
      updateConfig(selected, (config) => {
        config.build = [];
        config.launch = [];
      });
      baseline.requests = [selected];
      const result = createReviewRunPlan(baseline);

      expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
        {
          requestId: selected.requestId,
          required: true,
          state: "blocked",
          reasons: [
            { code: "missing_scenarios" },
            { code: "missing_build" },
            { code: "missing_launch" },
          ],
        },
      ]);
    },
  );

  it.each(["web", "windows_desktop"] as const)(
    "does not let optional scenarios satisfy required UI coverage for %s",
    (target) => {
      const baseline = input();
      const selected = withUiScenarios(request("pr_ui", target));
      updateConfig(selected, (config) => {
        if (config.ui === undefined) throw new Error("The fixture UI profile is missing.");
        first(config.ui.scenarios).required = false;
      });
      baseline.requests = [selected];
      const result = createReviewRunPlan(baseline);

      expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
        {
          requestId: selected.requestId,
          required: true,
          state: "blocked",
          reasons: [{ code: "missing_required_scenarios" }],
        },
      ]);
    },
  );

  it("retains missing validation checks even when setup and cleanup commands exist", () => {
    const baseline = input();
    updateConfig(first(baseline.requests), (config) => {
      config.build = [];
      config.test = [];
      config.setup = [step("prepare")];
      config.cleanup = [step("clean")];
    });
    const result = createReviewRunPlan(baseline);

    expect(evaluateReviewRunStructuralReadiness(result.plan)).toEqual([
      {
        requestId: "pr_static_build-headless",
        required: true,
        state: "blocked",
        reasons: [{ code: "missing_validation_checks" }],
      },
    ]);
  });

  it("exports the evaluator without changing caller input or frozen plan history", () => {
    expect(exportedStructuralReadiness).toBe(evaluateReviewRunStructuralReadiness);
    const baseline = input();
    baseline.runnerSupport = [];
    const beforeInput = canonical(baseline);
    const result = createReviewRunPlan(baseline);
    const beforeResult = canonical(result);
    const readiness = exportedStructuralReadiness(result.plan);
    first(readiness).state = "blocked";
    first(readiness).reasons.push({ code: "missing_prompt" });

    expect(canonical(baseline)).toBe(beforeInput);
    expect(canonical(result)).toBe(beforeResult);
    expect(result.planDigest).toBe(hash(canonical(result.plan)));
    expect(createReviewRunPlan(baseline)).toEqual(result);
    expect(exportedStructuralReadiness(result.plan)).toEqual([
      { requestId: "pr_static_build-headless", required: true, state: "ready", reasons: [] },
    ]);
  });
});

describe("Issue reproduction plan admission", () => {
  it("preserves the complete historical plan shape and profile and prompt hashes when absent", () => {
    const baseline = input();
    const result = createReviewRunPlan(baseline);
    expect(Object.hasOwn(result.plan, "reproduction")).toBe(false);
    expect(result.plan.jobs[0]?.profileVersion).toEqual(baseline.requests[0]?.profileVersion);
    expect(result.plan.jobs[0]?.prompt).toEqual(baseline.requests[0]?.prompt);
    expect(getReviewRunExecutorCapabilityLabels(result.plan, first(result.plan.jobs))).toEqual({
      executionEnvelope: "2",
      validationHeadless: "1",
    });
    const {
      observedAt: _observedAt,
      sourceUpdatedAt: _sourceUpdatedAt,
      ...revision
    } = baseline.revision;
    expect(result.planDigest).toBe(
      hash(
        canonical({
          schemaVersion: "ReviewRunExecutionPlanV1",
          activationId: baseline.activationId,
          repository: baseline.repository,
          workItemId: baseline.workItemId,
          workItem: baseline.workItem,
          revision,
          testedSourceRevision: baseline.testedSourceRevision,
          testedSourceAuthorization: baseline.testedSourceAuthorization,
          authorization: {
            requestEpochId: baseline.authorization.requestEpochId,
            sequence: baseline.authorization.sequence,
            basis: baseline.authorization.authorizationBasis,
            actorGithubUserId: baseline.authorization.openedByActor.githubUserId,
            targetGithubUserId: baseline.authorization.target.githubUserId,
            policy: baseline.authorizationPolicy,
          },
          jobs: [
            {
              ...first(baseline.requests),
              requiredCheckIds: [
                "version-pr_static_build-headless:assert",
                "version-pr_static_build-headless:build",
              ],
            },
          ],
          requiredCheckIds: [
            "version-pr_static_build-headless:assert",
            "version-pr_static_build-headless:build",
          ],
        }),
      ),
    );
  });

  it("freezes authoritative mapping scope while retaining every request and required check", () => {
    const baseline = issueInput();
    const selected = withProbe(first(baseline.requests));
    baseline.requests.push(request("issue_triage"));
    baseline.reproduction = reproductionFor(selected);
    const result = createReviewRunPlan(baseline);
    expect(result.plan.reproduction?.binding).toMatchObject({
      activationId: baseline.activationId,
      repositoryId: baseline.repository.id,
      workItemId: baseline.workItemId,
      issueRevisionKey: baseline.revision.revisionKey,
      testedSourceCommit: headSha,
      authorizedBy: {
        issuer: "https://identity.example.com",
        subject: "operator-1",
        authorizedAt: now,
      },
      cases: [{ requestId: selected.requestId, profileVersionId: profileOf(selected).id }],
    });
    expect(result.plan.jobs).toHaveLength(2);
    expect(result.plan.requiredCheckIds).toEqual([
      "version-issue_validation-headless:assert",
      "version-issue_validation-headless:build",
    ]);
    expect(Object.isFrozen(result.plan.reproduction?.binding.cases)).toBe(true);
    expect(
      result.readiness.find((entry) => entry.requestId === selected.requestId)?.reasons,
    ).toEqual([
      { code: "missing_capability", capability: "issueReproduction" },
      { code: "missing_capability", capability: "structuredProbeOutput" },
    ]);
    const ready = evaluateReviewRunPlanReadiness(result.plan, [
      {
        workflowKind: "issue_validation",
        target: "headless",
        evidenceDelivery: true,
        capabilities: ["issueReproduction", "structuredProbeOutput"],
      },
    ]);
    expect(ready.find((entry) => entry.requestId === selected.requestId)?.state).toBe("ready");
    first(baseline.reproduction.cases).context = "Modified after planning.";
    expect(result.plan.reproduction?.binding.cases[0]?.context).toBe(
      "Open the published settings scenario.",
    );
  });

  it("requires the structured output protocol for declared probes without a reproduction binding", () => {
    const baseline = input();
    withProbe(first(baseline.requests));
    const result = createReviewRunPlan(baseline);
    expect(result.readiness[0]?.reasons).toEqual([
      { code: "missing_capability", capability: "structuredProbeOutput" },
    ]);
    expect(Object.hasOwn(result.plan, "reproduction")).toBe(false);
  });

  it.each(["web", "windows_desktop"] as const)(
    "requires the observation protocol for mapped %s requests",
    (target) => {
      const baseline = issueInput();
      const selected = withUiScenarios(request("issue_validation", target));
      if (target === "web")
        updateConfig(selected, (config) => {
          if (config.ui?.target === "web") config.ui.evidence.trace = "off";
        });
      baseline.requests = [selected];
      baseline.reproduction = reproductionFor(selected);
      baseline.runnerSupport = [
        {
          workflowKind: "issue_validation",
          target,
          capabilities: [`ui:${target}`, "issueReproduction"],
          evidenceDelivery: true,
        },
      ];
      const result = createReviewRunPlan(baseline);
      expect(result.readiness[0]?.reasons).toContainEqual({
        code: "missing_capability",
        capability: "uiAssertionObservation",
      });
      expect(
        getReviewRunExecutorCapabilityLabels(result.plan, first(result.plan.jobs)),
      ).toMatchObject({ issueReproduction: "1", uiAssertionObservation: "1" });
    },
  );

  it("requires the observation protocol for generic Web profiles with traces disabled", () => {
    const baseline = input();
    const selected = withUiScenarios(request("pr_ui", "web"));
    updateConfig(selected, (config) => {
      if (config.ui?.target === "web") config.ui.evidence.trace = "off";
    });
    baseline.requests = [selected];
    baseline.runnerSupport = [
      { workflowKind: "pr_ui", target: "web", capabilities: ["ui:web"], evidenceDelivery: true },
    ];
    expect(createReviewRunPlan(baseline).readiness[0]?.reasons).toContainEqual({
      code: "missing_capability",
      capability: "uiAssertionObservation",
    });
  });

  it("rejects mapping a stale profile version before a frozen plan can be produced", () => {
    const baseline = issueInput();
    baseline.reproduction = reproductionFor(withProbe(first(baseline.requests)));
    first(baseline.reproduction.cases).expectedProfileVersionId = "outdated-profile-version";
    expect(() => createReviewRunPlan(baseline)).toThrow(/version/u);
  });
});

describe("immutable review run planning", () => {
  it.each(["web", "windows_desktop"] as const)(
    "requires real %s driver support and evidence for typed scenarios",
    (target) => {
      const baseline = input();
      baseline.requests = [withUiScenarios(request("pr_ui", target))];
      baseline.runnerSupport = [
        { workflowKind: "pr_ui", target, capabilities: [`ui:${target}`], evidenceDelivery: true },
      ];
      const result = createReviewRunPlan(baseline);
      expect(result.readiness[0]?.state).toBe("ready");
      expect(result.plan.requiredCheckIds).toContain(`version-pr_ui-${target}:settings-scenario`);
      expect(result.plan.requiredCheckIds).not.toContain(
        `version-pr_ui-${target}:settings-visible`,
      );
      expect(result.plan.requiredCheckIds).not.toContain(`version-pr_ui-${target}:launch`);
      const noDriver = createReviewRunPlan({
        ...baseline,
        runnerSupport: [
          { workflowKind: "pr_ui", target, capabilities: [], evidenceDelivery: true },
        ],
      });
      expect(noDriver.planDigest).toBe(result.planDigest);
      expect(noDriver.readiness[0]?.state).toBe("blocked");
      expect(noDriver.readiness[0]?.reasons).toContainEqual({
        code: "missing_capability",
        capability: `ui:${target}`,
      });
      const noEvidence = createReviewRunPlan({
        ...baseline,
        runnerSupport: [
          {
            workflowKind: "pr_ui",
            target,
            capabilities: [`ui:${target}`],
            evidenceDelivery: false,
          },
        ],
      });
      expect(noEvidence.readiness[0]?.reasons).toContainEqual({
        code: "evidence_delivery_unavailable",
      });
    },
  );

  it("does not combine a driver's capabilities with another executor's evidence support", () => {
    const baseline = input();
    baseline.requests = [withUiScenarios(request("pr_ui", "web"))];
    baseline.runnerSupport = [
      { workflowKind: "pr_ui", target: "web", capabilities: ["ui:web"], evidenceDelivery: false },
      { workflowKind: "pr_ui", target: "web", capabilities: [], evidenceDelivery: true },
    ];
    expect(createReviewRunPlan(baseline).readiness[0]?.reasons).toContainEqual({
      code: "evidence_delivery_unavailable",
    });
  });

  it("requires at least one mandatory UI scenario for a required UI profile", () => {
    const baseline = input();
    const selected = withUiScenarios(request("pr_ui", "web"));
    updateConfig(selected, (config) => {
      if (config.ui?.target === "web") first(config.ui.scenarios).required = false;
    });
    baseline.requests = [selected];
    baseline.runnerSupport = [
      { workflowKind: "pr_ui", target: "web", capabilities: ["ui:web"], evidenceDelivery: true },
    ];
    const result = createReviewRunPlan(baseline);
    expect(result.requiredRequestBlockers).toContainEqual({
      requestId: "pr_ui-web",
      reason: "missing_required_scenarios",
    });
    expect(result.plan.requiredCheckIds).not.toContain("version-pr_ui-web:settings-scenario");
  });

  it("rejects a mismatched UI target and a scenario without assertions as corrupt configuration", () => {
    const mismatched = input();
    const selected = withUiScenarios(request("pr_ui", "web"));
    const profile = profileOf(selected);
    selected.target = "windows_desktop";
    profile.target = "windows_desktop";
    mismatched.requests = [selected];
    expect(() => createReviewRunPlan(mismatched)).toThrow(/target must match/u);
    const noAssertions = input();
    const clickOnly = withUiScenarios(request("pr_ui", "web"));
    updateConfig(clickOnly, (config) => {
      if (config.ui?.target === "web")
        first(config.ui.scenarios).steps = [
          {
            id: "click-settings",
            name: "Click settings",
            action: "click",
            locator: { by: "testId", testId: "settings" },
            timeoutMs: 5_000,
          },
        ];
    });
    noAssertions.requests = [clickOnly];
    expect(() => createReviewRunPlan(noAssertions)).toThrow(
      /at least one deterministic assertion/u,
    );
  });
  it("freezes an exact authorized revision and qualified required checks", () => {
    const result = createReviewRunPlan(input());
    expect(result.readiness).toEqual([
      { requestId: "pr_static_build-headless", required: true, state: "ready", reasons: [] },
    ]);
    expect(result.requiredRequestBlockers).toEqual([]);
    expect(result.plan.requiredCheckIds).toEqual([
      "version-pr_static_build-headless:assert",
      "version-pr_static_build-headless:build",
    ]);
    expect(result.plan.testedSourceRevision).toEqual({ kind: "pull_request", baseSha, headSha });
    expect(result.planDigest).toBe(hash(canonical(result.plan)));
  });

  it("creates separate static, Windows desktop, and Web jobs without pretending UI scenarios exist", () => {
    const baseline = input();
    baseline.requests.push(request("pr_ui", "windows_desktop"), request("pr_ui", "web"));
    baseline.runnerSupport.push(
      {
        workflowKind: "pr_ui",
        target: "windows_desktop",
        capabilities: ["ui:windows_desktop"],
        evidenceDelivery: true,
      },
      { workflowKind: "pr_ui", target: "web", capabilities: ["ui:web"], evidenceDelivery: true },
    );
    const result = createReviewRunPlan(baseline);
    expect(result.plan.jobs).toHaveLength(3);
    for (const target of ["windows_desktop", "web"]) {
      expect(result.readiness).toContainEqual({
        requestId: `pr_ui-${target}`,
        required: true,
        state: "blocked",
        reasons: [{ code: "missing_scenarios" }],
      });
      expect(result.requiredRequestBlockers).toContainEqual({
        requestId: `pr_ui-${target}`,
        reason: "missing_scenarios",
      });
    }
    expect(
      result.plan.jobs
        .find((job) => job.target === "web")
        ?.requiredCheckIds.every((id) => !id.endsWith(":launch")),
    ).toBe(true);
  });

  it("keeps runner availability out of the immutable digest", () => {
    const baseline = input();
    const available = createReviewRunPlan(baseline);
    const unavailable = createReviewRunPlan({ ...baseline, runnerSupport: [] });
    expect(unavailable.planDigest).toBe(available.planDigest);
    expect(unavailable.readiness[0]?.reasons).toEqual([{ code: "unsupported_target" }]);
    expect(evaluateReviewRunPlanReadiness(unavailable.plan, baseline.runnerSupport)).toEqual(
      available.readiness,
    );
    expect(
      getRequiredReviewRunRequestBlockers(
        evaluateReviewRunPlanReadiness(unavailable.plan, baseline.runnerSupport),
      ),
    ).toEqual([]);
    expect(getRequiredReviewRunRequestBlockers(unavailable.readiness)).toEqual(
      unavailable.requiredRequestBlockers,
    );
  });

  it("does not retain caller-owned mutable profile or prompt references", () => {
    const baseline = input();
    const result = createReviewRunPlan(baseline);
    const original = canonical(result.plan);
    first(profileOf(first(baseline.requests)).config.build).name = "Changed after planning";
    promptOf(first(baseline.requests)).version.content = "Changed prompt";
    expect(canonical(result.plan)).toBe(original);
    expect(Object.isFrozen(result.plan.jobs[0]?.profileVersion?.config)).toBe(true);
    expect(() => {
      first(result.plan.jobs).requiredCheckIds.push("injected:check");
    }).toThrow();
  });

  it("keeps request order and transport observation timestamps out of execution identity", () => {
    const baseline = input();
    baseline.requests.push(request("pr_ui", "web"));
    const first = createReviewRunPlan(baseline);
    baseline.requests.reverse();
    baseline.revision = {
      ...baseline.revision,
      observedAt: "2026-09-07T01:00:00.000Z",
      sourceUpdatedAt: "2026-09-07T01:00:00.000Z",
    };
    expect(createReviewRunPlan(baseline).planDigest).toBe(first.planDigest);
  });

  it("gives an intentional new activation a different identity", () => {
    const baseline = input();
    expect(createReviewRunPlan({ ...baseline, activationId: "activation-2" }).planDigest).not.toBe(
      createReviewRunPlan(baseline).planDigest,
    );
  });

  it("separates issue content revision from an explicitly chosen test source commit", () => {
    const baseline = issueInput();
    const result = createReviewRunPlan(baseline);
    expect(result.plan.revision.kind).toBe("issue");
    expect(result.plan.testedSourceRevision).toEqual({ kind: "commit", headSha });
    const other = createReviewRunPlan({
      ...baseline,
      testedSourceRevision: { kind: "commit", headSha: "c".repeat(40) },
      testedSourceAuthorization:
        baseline.testedSourceAuthorization === null
          ? null
          : { ...baseline.testedSourceAuthorization, headSha: "c".repeat(40) },
    });
    expect(other.plan.revision).toEqual(result.plan.revision);
    expect(other.planDigest).not.toBe(result.planDigest);
  });

  it("blocks issue reproduction until a source commit is explicitly selected", () => {
    const result = createReviewRunPlan({
      ...issueInput(),
      testedSourceRevision: null,
      testedSourceAuthorization: null,
    });
    expect(result.requiredRequestBlockers).toContainEqual({
      requestId: "issue_validation-headless",
      reason: "missing_tested_source_revision",
    });
  });

  it("does not upgrade GitHub issue-triage authorization into permission to execute a commit", () => {
    const result = createReviewRunPlan({ ...issueInput(), testedSourceAuthorization: null });
    expect(result.readiness[0]?.state).toBe("blocked");
    expect(result.requiredRequestBlockers).toEqual([
      { requestId: "issue_validation-headless", reason: "missing_source_authorization" },
    ]);
  });

  it.each([
    { activationId: "older-activation" },
    { githubRepositoryId: 999 },
    { githubWorkItemId: 999 },
    { issueRevisionKey: "e".repeat(64) },
    { headSha: "e".repeat(40) },
    { issuer: " https://identity.example.com" },
    { subject: "operator-1 " },
  ])("rejects mismatched operator source authorization: %j", (override) => {
    const baseline = issueInput();
    if (baseline.testedSourceAuthorization === null)
      throw new Error("Fixture authorization is missing.");
    baseline.testedSourceAuthorization = { ...baseline.testedSourceAuthorization, ...override };
    expect(() => createReviewRunPlan(baseline)).toThrow(/operator source authorization/u);
  });

  it("binds explicit operator authorization to a run activation while allowing frozen-plan reuse", () => {
    const baseline = issueInput();
    const firstPlan = createReviewRunPlan(baseline);
    expect(createReviewRunPlan(baseline).planDigest).toBe(firstPlan.planDigest);
    expect(() => createReviewRunPlan({ ...baseline, activationId: "activation-2" })).toThrow(
      /operator source authorization/u,
    );
    if (baseline.testedSourceAuthorization === null)
      throw new Error("Fixture authorization is missing.");
    const rerun = createReviewRunPlan({
      ...baseline,
      activationId: "activation-2",
      testedSourceAuthorization: {
        ...baseline.testedSourceAuthorization,
        activationId: "activation-2",
        authorizedAt: "2026-09-07T01:00:00.000Z",
      },
    });
    expect(rerun.planDigest).not.toBe(firstPlan.planDigest);
    expect(rerun.plan.testedSourceAuthorization?.subject).toBe("operator-1");
    expect(rerun.readiness[0]?.state).toBe("ready");
  });

  it("does not substitute an operator source authorization for the PR GitHub epoch", () => {
    expect(() =>
      createReviewRunPlan({
        ...input(),
        testedSourceAuthorization: issueInput().testedSourceAuthorization,
      }),
    ).toThrow(/PR source authorization/u);
  });

  it("allows static issue triage without inventing a code checkout or check", () => {
    const baseline = issueInput();
    baseline.requests = [request("issue_triage")];
    baseline.testedSourceRevision = null;
    baseline.testedSourceAuthorization = null;
    baseline.runnerSupport = [
      {
        workflowKind: "issue_triage",
        target: "headless",
        capabilities: [],
        evidenceDelivery: false,
      },
    ];
    const result = createReviewRunPlan(baseline);
    expect(result.readiness[0]?.state).toBe("ready");
    expect(result.plan.requiredCheckIds).toEqual([]);
  });

  it("preserves required profile and prompt gaps as aggregate blockers", () => {
    const baseline = input();
    baseline.requests.push({
      requestId: "required-ui",
      workflowKind: "pr_ui",
      target: "web",
      required: true,
      profileVersion: null,
      prompt: null,
    });
    const result = createReviewRunPlan(baseline);
    expect(result.requiredRequestBlockers).toContainEqual({
      requestId: "required-ui",
      reason: "missing_profile",
    });
    expect(result.requiredRequestBlockers).toContainEqual({
      requestId: "required-ui",
      reason: "missing_prompt",
    });
    const decision = evaluateValidationApproval({
      currentRevisionKey: baseline.revision.revisionKey,
      expectedExecutionPlanDigest: result.planDigest,
      requiredCheckIds: result.plan.requiredCheckIds,
      reports: [],
      blockingFindingIds: [],
      requiredRequestBlockers: result.requiredRequestBlockers,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContainEqual({
      code: "required_request_blocked",
      requestId: "required-ui",
      reason: "missing_profile",
    });
  });

  it("does not downgrade a published required profile through an optional request", () => {
    const baseline = input();
    first(baseline.requests).required = false;
    expect(createReviewRunPlan(baseline).plan.jobs[0]?.required).toBe(true);
  });

  it("keeps optional blocked profiles visible without turning them into required blockers", () => {
    const baseline = input();
    baseline.requests.push({
      requestId: "optional-ui",
      workflowKind: "pr_ui",
      target: "web",
      required: false,
      profileVersion: null,
      prompt: null,
    });
    const result = createReviewRunPlan(baseline);
    expect(result.readiness.find((entry) => entry.requestId === "optional-ui")?.state).toBe(
      "blocked",
    );
    expect(result.requiredRequestBlockers).toEqual([]);
  });

  it("does not union capabilities from different executors to manufacture a match", () => {
    const baseline = input();
    updateConfig(first(baseline.requests), (config) => {
      config.requiredCapabilities = ["toolchain", "sdk"];
    });
    baseline.runnerSupport = [
      {
        workflowKind: "pr_static_build",
        target: "headless",
        capabilities: ["toolchain"],
        evidenceDelivery: false,
      },
      {
        workflowKind: "pr_static_build",
        target: "headless",
        capabilities: ["sdk"],
        evidenceDelivery: false,
      },
    ];
    expect(createReviewRunPlan(baseline).readiness[0]?.reasons).toEqual([
      { code: "missing_capability", capability: "sdk" },
    ]);
  });

  it("requires concrete local build and launch steps for UI, without enabling artifact reuse", () => {
    const baseline = input();
    const selected = request("pr_ui", "windows_desktop");
    updateConfig(selected, (config) => {
      config.build = [];
      config.launch = [];
    });
    baseline.requests = [selected];
    baseline.runnerSupport = [
      {
        workflowKind: "pr_ui",
        target: "windows_desktop",
        capabilities: [],
        evidenceDelivery: false,
      },
    ];
    const reasons = createReviewRunPlan(baseline).readiness[0]?.reasons;
    expect(reasons).toContainEqual({ code: "evidence_delivery_unavailable" });
    expect(reasons).toContainEqual({ code: "missing_scenarios" });
    expect(reasons).toContainEqual({ code: "missing_build" });
    expect(reasons).toContainEqual({ code: "missing_launch" });
  });

  it("does not count setup or launch commands as required validation checks", () => {
    const baseline = input();
    updateConfig(first(baseline.requests), (config) => {
      config.build = [];
      config.test = [];
      config.setup = [step("prepare")];
      config.cleanup = [step("clean")];
    });
    const result = createReviewRunPlan(baseline);
    expect(result.plan.requiredCheckIds).toEqual([]);
    expect(result.requiredRequestBlockers).toEqual([
      { requestId: "pr_static_build-headless", reason: "missing_validation_checks" },
    ]);
  });

  it.each([
    [
      "wrong repository",
      (value: ReviewRunPlanInput) => {
        value.repository.githubRepositoryId = 999;
      },
    ],
    [
      "wrong work item",
      (value: ReviewRunPlanInput) => {
        value.authorization.githubWorkItemId = 999;
      },
    ],
    [
      "closed work item",
      (value: ReviewRunPlanInput) => {
        value.workItem.state = "closed";
      },
    ],
    [
      "wrong authorization policy",
      (value: ReviewRunPlanInput) => {
        value.authorizationPolicy.policyVersion = 2;
      },
    ],
    [
      "unauthorized actor",
      (value: ReviewRunPlanInput) => {
        value.authorization.openedByActor = { ...actor, githubUserId: 999 };
      },
    ],
    [
      "old revision",
      (value: ReviewRunPlanInput) => {
        value.authorization.currentRevision = {
          ...value.authorization.currentRevision,
          revisionKey: "f".repeat(64),
        };
      },
    ],
    [
      "different tested head",
      (value: ReviewRunPlanInput) => {
        value.testedSourceRevision = { kind: "pull_request", baseSha, headSha: "f".repeat(40) };
      },
    ],
    [
      "missing PR source",
      (value: ReviewRunPlanInput) => {
        value.testedSourceRevision = null;
      },
    ],
    [
      "wrong PR digest",
      (value: ReviewRunPlanInput) => {
        value.revision.revisionKey = "f".repeat(64);
        value.authorization.currentRevision = value.revision;
      },
    ],
    [
      "cross-repository profile",
      (value: ReviewRunPlanInput) => {
        profileOf(first(value.requests)).repositoryId = "other-repo";
      },
    ],
    [
      "profile digest corruption",
      (value: ReviewRunPlanInput) => {
        profileOf(first(value.requests)).configSha256 = "f".repeat(64);
      },
    ],
    [
      "prompt digest corruption",
      (value: ReviewRunPlanInput) => {
        promptOf(first(value.requests)).version.contentSha256 = "f".repeat(64);
      },
    ],
    [
      "wrong prompt workflow",
      (value: ReviewRunPlanInput) => {
        promptOf(first(value.requests)).workflowKind = "issue_triage";
      },
    ],
    [
      "duplicate requests",
      (value: ReviewRunPlanInput) => {
        value.requests.push(structuredClone(first(value.requests)));
      },
    ],
    [
      "duplicate profile",
      (value: ReviewRunPlanInput) => {
        value.requests.push({ ...structuredClone(first(value.requests)), requestId: "second" });
      },
    ],
    [
      "duplicate steps",
      (value: ReviewRunPlanInput) => {
        updateConfig(first(value.requests), (config) => {
          first(config.test).id = "build";
        });
      },
    ],
  ] as const)("rejects %s rather than reporting it as missing configuration", (_name, corrupt) => {
    const baseline = input();
    corrupt(baseline);
    expect(() => createReviewRunPlan(baseline)).toThrow(TypeError);
  });

  it("rejects issue content tampering and branch-name source references", () => {
    const baseline = issueInput();
    baseline.workItem.body = "Different issue content";
    expect(() => createReviewRunPlan(baseline)).toThrow(/Issue content revision/u);
    const branch = { ...issueInput(), testedSourceRevision: { kind: "commit", headSha: "main" } };
    expect(() => createReviewRunPlan(branch as ReviewRunPlanInput)).toThrow(/input is invalid/u);
  });

  it("changes identity when frozen prompt, configuration, or repository configuration changes", () => {
    const baseline = input();
    const original = createReviewRunPlan(baseline).planDigest;
    const prompt = promptOf(first(baseline.requests)).version;
    prompt.content = "A different review instruction.";
    prompt.contentSha256 = hash(prompt.content);
    expect(createReviewRunPlan(baseline).planDigest).not.toBe(original);
    const other = input();
    updateConfig(first(other.requests), (config) => {
      first(config.build).command.args = ["different"];
    });
    expect(createReviewRunPlan(other).planDigest).not.toBe(original);
    expect(
      createReviewRunPlan({
        ...input(),
        repository: { ...input().repository, configurationVersion: 2 },
      }).planDigest,
    ).not.toBe(original);
  });
});
