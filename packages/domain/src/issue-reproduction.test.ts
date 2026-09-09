import { createHash } from "node:crypto";

import type {
  FrozenIssueReproductionBinding,
  IssueReproductionCaseRequest,
  IssueReproductionRequestV1,
  ObservationValue,
  ReproductionObservationFact,
  ReviewRunPlanInput,
  ReviewRunRequest,
  ValidationCommandStep,
  ValidationProfileConfig,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import {
  aggregateIssueReproduction,
  aggregateIssueReproductionRequest,
  canonicalizeIssueReproductionRequest,
  type DeriveIssueReproductionCaseExecutionsInput,
  deriveIssueReproductionCaseExecutions,
  evaluateIssueReproductionCases,
  freezeIssueReproductionBinding,
  type ReproductionCaseExecution,
  validateFrozenIssueReproductionBinding,
} from "./issue-reproduction.js";

const now = "2026-09-07T00:00:00.000Z";
const commit = "a".repeat(40);
const planDigest = "b".repeat(64);
const actor = { githubUserId: 10, login: "operator" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: string): ObservationValue => ({ type: "string", value });

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
function first<T>(values: readonly T[]): T {
  const result = values[0];
  if (result === undefined) throw new Error("The fixture collection is empty.");
  return result;
}
function command(id: string, required = true): ValidationCommandStep {
  return {
    id,
    name: id,
    required,
    timeoutMs: 30_000,
    command: { executable: "tool.exe", args: [id], workingDirectory: ".", environment: [] },
  };
}
function request(target: ReviewRunRequest["target"]): ReviewRunRequest {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [command("setup")],
    build: [command("build")],
    test: [
      {
        ...command("probe"),
        probeOutput: {
          schemaVersion: "TestProbeOutputDeclarationV1",
          fields: [
            { id: "status", description: "The observed status.", type: "string" },
            { id: "count", description: "The observed count.", type: "number" },
          ],
        },
      },
      command("unrelated"),
    ],
    launch: target === "headless" ? [] : [command("launch")],
    cleanup: [command("cleanup", false)],
    requiredCapabilities: [],
    hardTimeoutMs: 120_000,
    noProgressTimeoutMs: 30_000,
  };
  const scenario = { id: "scenario", name: "Inspect status", required: true, timeoutMs: 30_000 };
  if (target === "web")
    config.ui = {
      schemaVersion: "UiScenariosV1",
      target,
      service: {
        origin: "managed_loopback",
        portEnvironmentVariable: "UI_PORT",
        navigation: "same_origin",
      },
      browser: { engine: "chromium", headless: true, viewport: { width: 1280, height: 720 } },
      launch: {
        stepId: "launch",
        mode: "persistent",
        readiness: { kind: "http", path: "/health", expectedStatus: 200, timeoutMs: 30_000 },
      },
      reset: { strategy: "restart_process" },
      scenarios: [
        {
          ...scenario,
          path: "/",
          steps: [
            {
              id: "status",
              name: "Read status",
              action: "assertText",
              locator: { by: "testId", testId: "status" },
              expected: "Ready",
              match: "exact",
              timeoutMs: 1000,
            },
            {
              id: "click",
              name: "Click",
              action: "click",
              locator: { by: "testId", testId: "button" },
              timeoutMs: 1000,
            },
          ],
        },
      ],
      evidence: {
        screenshots: "every_assertion",
        screenshotScope: "viewport",
        trace: "off",
        required: true,
      },
    };
  if (target === "windows_desktop")
    config.ui = {
      schemaVersion: "UiScenariosV1",
      target,
      desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
      launch: {
        stepId: "launch",
        mode: "persistent",
        readiness: { kind: "window", window: { title: "Fixture" }, timeoutMs: 30_000 },
      },
      reset: { strategy: "restart_process" },
      scenarios: [
        {
          ...scenario,
          steps: [
            {
              id: "status",
              name: "Read status",
              action: "assertText",
              locator: { by: "automationId", automationId: "status" },
              expected: "Ready",
              match: "exact",
              timeoutMs: 1000,
            },
          ],
        },
      ],
      evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
    };
  const profile: ValidationProfileVersion = {
    id: `version-${target}`,
    profileId: `profile-${target}`,
    repositoryId: "repo",
    version: 1,
    name: target,
    workflowKind: "issue_validation",
    target,
    config,
    configSha256: hash(canonical(config)),
    required: true,
    outputSchemaVersion: "ValidationReportV1",
    createdAt: now,
    publishedAt: now,
    createdBy: "operator",
  };
  return {
    requestId: `request-${target}`,
    workflowKind: "issue_validation",
    target,
    required: true,
    profileVersion: profile,
    prompt: null,
  };
}
function caseRequest(target: ReviewRunRequest["target"]): IssueReproductionCaseRequest {
  const observation =
    target === "headless"
      ? { kind: "probe_value" as const, testStepId: "probe", observationId: "status" }
      : { kind: "ui_assertion" as const, scenarioId: "scenario", stepId: "status" };
  return {
    id: `case-${target}`,
    profileId: `profile-${target}`,
    expectedProfileVersionId: `version-${target}`,
    context: " Exact context. ",
    preconditions: [],
    presentWhen: { allOf: [{ observation, equals: text("Duplicate") }] },
    absentWhen: { allOf: [{ observation, equals: text("Ready") }] },
  };
}
function input(targets: ReviewRunRequest["target"][] = ["headless"]): ReviewRunPlanInput {
  const workItem: ReviewRunPlanInput["workItem"] = {
    kind: "issue",
    githubRepositoryId: 100,
    githubWorkItemId: 200,
    githubNodeId: "ISSUE_200",
    number: 1,
    title: "Duplicated status",
    body: "Status appears twice.",
    state: "open",
    author: actor,
    htmlUrl: "https://github.com/org/repo/issues/1",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  const digest = hash(
    JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
  );
  const revision: ReviewRunPlanInput["revision"] = {
    kind: "issue",
    githubRepositoryId: 100,
    githubWorkItemId: 200,
    revisionKey: digest,
    contentDigest: digest,
    observedAt: now,
    sourceUpdatedAt: now,
  };
  return {
    activationId: "activation",
    repository: {
      id: "repo",
      githubRepositoryId: 100,
      fullName: "org/repo",
      configurationVersion: 1,
    },
    workItemId: "work-item",
    workItem,
    revision,
    testedSourceRevision: { kind: "commit", headSha: commit },
    testedSourceAuthorization: {
      kind: "operator",
      activationId: "activation",
      issuer: "https://identity.example.com",
      subject: "operator",
      authorizedAt: now,
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      issueRevisionKey: digest,
      headSha: commit,
    },
    authorization: {
      requestEpochId: "epoch",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      requestKind: "assignment",
      sequence: 1,
      target: actor,
      openedByActor: actor,
      authorizationBasis: "self",
      authorizationPolicyVersion: 1,
      openedByEventId: "event",
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
    requests: targets.map(request),
    runnerSupport: [],
    reproduction: {
      schemaVersion: "IssueReproductionRequestV1",
      claim: " The status duplicates. ",
      cases: targets.map(caseRequest),
    },
  };
}
function frozen(value = input()): FrozenIssueReproductionBinding {
  const result = freezeIssueReproductionBinding(value);
  if (result === undefined) throw new Error("The fixture has no reproduction binding.");
  return result;
}
function intent(value = input()): IssueReproductionRequestV1 {
  if (value.reproduction === undefined) throw new Error("The fixture has no reproduction intent.");
  return value.reproduction;
}
function profile(value: ReviewRunPlanInput): ValidationProfileVersion {
  const result = first(value.requests).profileVersion;
  if (result === null) throw new Error("The fixture has no profile.");
  return result;
}
function rehash(value: ReviewRunPlanInput): void {
  profile(value).configSha256 = hash(canonical(profile(value).config));
}
function execution(
  binding: FrozenIssueReproductionBinding,
  caseId = first(binding.binding.cases).id,
  value: ObservationValue = text("Duplicate"),
): ReproductionCaseExecution {
  const entry = binding.binding.cases.find((item) => item.id === caseId);
  if (entry === undefined) throw new Error("The fixture case is missing.");
  const observation = first(entry.presentWhen.allOf).observation;
  const checkId = `${entry.profileVersionId}:${observation.kind === "ui_assertion" ? observation.scenarioId : observation.testStepId}`;
  return {
    caseId,
    bindingDigest: binding.bindingDigest,
    planDigest,
    requestId: entry.requestId,
    profileVersionId: entry.profileVersionId,
    profileConfigSha256: entry.profileConfigSha256,
    target: entry.target,
    issueRevisionKey: binding.binding.issueRevisionKey,
    testedSourceCommit: commit,
    state: "verified",
    passedPreconditionCheckIds: [],
    failedPreconditionCheckIds: [],
    reasons: [],
    observations: [{ observation, checkId, state: "observed", value, evidenceIds: ["evidence"] }],
  };
}
function deriveInput(
  target: ReviewRunRequest["target"] = "headless",
  source = input([target]),
): DeriveIssueReproductionCaseExecutionsInput {
  const bound = frozen(source);
  const selected = first(source.requests);
  const version = profile(source);
  const steps = [
    ...(["setup", "build", "test", "cleanup"] as const).flatMap((phase) =>
      version.config[phase].map((step) => ({
        id: `${version.id}:${step.id}`,
        phase,
        required: step.required,
      })),
    ),
    ...(version.config.ui?.scenarios ?? []).map((scenario) => ({
      id: `${version.id}:${scenario.id}`,
      phase: "ui" as const,
      required: scenario.required,
    })),
  ];
  return {
    frozen: bound,
    planDigest,
    request: selected,
    issueRevisionKey: bound.binding.issueRevisionKey,
    testedSourceCommit: commit,
    evidenceComplete: true,
    observations: execution(bound).observations,
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      sourceState: "original",
      summary: "Runner facts.",
      reproductionConclusion: "inconclusive",
      checks: steps.map((step) => ({
        id: step.id,
        name: step.id,
        kind: step.phase === "setup" || step.phase === "cleanup" ? "static" : step.phase,
        required: step.required,
        source: "runner",
        outcome: step.phase === "ui" ? "failed" : "passed",
        summary: "Observed result.",
        expected: null,
        actual: null,
        evidenceIds: [],
      })),
    },
    execution: {
      cleanupState: "completed",
      blockers: [],
      diagnostics: [
        ...steps.map((step) => ({
          stepId: step.id,
          phase: step.phase,
          outcome: step.phase === "ui" ? ("failed" as const) : ("passed" as const),
          exitCode: 0,
          summary: "Complete execution.",
        })),
        ...version.config.launch.map((step) => ({
          stepId: `${version.id}:${step.id}`,
          phase: "launch" as const,
          outcome: "passed" as const,
          exitCode: 137,
          summary: "Owned process stopped and drained.",
        })),
      ],
    },
  };
}
function derivedState(value: DeriveIssueReproductionCaseExecutionsInput): string {
  return first(
    evaluateIssueReproductionCases(
      value.frozen.binding,
      deriveIssueReproductionCaseExecutions(value),
    ),
  ).state;
}

describe("reproduction intent and frozen scope", () => {
  it("keeps legacy omission and preserves exact text while canonicalizing case sets", () => {
    const source = input(["windows_desktop", "headless", "web"]);
    const value = frozen(source);
    expect(value.binding.cases.map((entry) => entry.id)).toEqual([
      "case-headless",
      "case-web",
      "case-windows_desktop",
    ]);
    expect(value.binding.claim).toBe(" The status duplicates. ");
    expect(first(value.binding.cases).context).toBe(" Exact context. ");
    const originalConfig = canonical(profile(source).config);
    const reversed = { ...intent(source), cases: [...intent(source).cases].reverse() };
    expect(canonicalizeIssueReproductionRequest(reversed)).toEqual(
      canonicalizeIssueReproductionRequest(intent(source)),
    );
    expect(canonical(profile(source).config)).toBe(originalConfig);
    expect(Object.isFrozen(value.binding.cases)).toBe(true);
    delete source.reproduction;
    expect(freezeIssueReproductionBinding(source)).toBeUndefined();
  });

  it.each(["headless", "web", "windows_desktop"] as const)(
    "freezes the exact %s profile identity and source",
    (target) => {
      const source = input([target]);
      const value = frozen(source);
      expect(first(value.binding.cases)).toMatchObject({
        requestId: `request-${target}`,
        profileVersionId: `version-${target}`,
        target,
      });
      expect(value.binding.authorizedBy.subject).toBe("operator");
      expect(value.binding.testedSourceCommit).toBe(commit);
      validateFrozenIssueReproductionBinding(value, source.requests);
      expect(value.bindingDigest).toBe(hash(canonical(value.binding)));
    },
  );

  it.each([
    (source: ReviewRunPlanInput) => {
      first(intent(source).cases).expectedProfileVersionId = "other-version";
    },
    (source: ReviewRunPlanInput) => {
      first(intent(source).cases).profileId = "other-profile";
    },
    (source: ReviewRunPlanInput) => {
      profile(source).configSha256 = "c".repeat(64);
    },
    (source: ReviewRunPlanInput) => {
      profile(source).repositoryId = "other-repo";
    },
    (source: ReviewRunPlanInput) => {
      source.testedSourceRevision = null;
    },
    (source: ReviewRunPlanInput) => {
      source.testedSourceAuthorization = null;
    },
    (source: ReviewRunPlanInput) => {
      source.workItem.title = "Edited Issue";
    },
    (source: ReviewRunPlanInput) => {
      source.activationId = "other-activation";
    },
    (source: ReviewRunPlanInput) => {
      source.workItemId = "other-item";
      source.testedSourceAuthorization = null;
    },
    (source: ReviewRunPlanInput) => {
      first(source.requests).workflowKind = "issue_triage";
    },
  ])("rejects stale or mismatched authoritative input %#", (change) => {
    const source = input();
    change(source);
    expect(() => frozen(source)).toThrow();
  });

  it("validates every case by default and allows explicit own-profile reference verification", () => {
    const source = input(["headless", "web"]);
    const value = frozen(source);
    expect(() => validateFrozenIssueReproductionBinding(value, [first(source.requests)])).toThrow();
    expect(() =>
      validateFrozenIssueReproductionBinding(
        value,
        [first(source.requests)],
        undefined,
        "request-headless",
      ),
    ).not.toThrow();
    expect(() =>
      validateFrozenIssueReproductionBinding(value, source.requests, undefined, "unknown"),
    ).toThrow();
    expect(() =>
      validateFrozenIssueReproductionBinding(
        { ...value, bindingDigest: "f".repeat(64) },
        source.requests,
      ),
    ).toThrow();
  });

  it("rejects unknown intent fields, duplicate cases, duplicate references, and type conflicts", () => {
    const value = intent();
    expect(() =>
      canonicalizeIssueReproductionRequest({
        ...value,
        observed: true,
      } as IssueReproductionRequestV1),
    ).toThrow();
    expect(() =>
      canonicalizeIssueReproductionRequest({
        ...value,
        cases: [first(value.cases), first(value.cases)],
      }),
    ).toThrow();
    const entry = first(value.cases);
    const predicate = first(entry.presentWhen.allOf);
    entry.presentWhen.allOf.push({ ...predicate, equals: text("another") });
    expect(() => canonicalizeIssueReproductionRequest(value)).toThrow();
    entry.presentWhen.allOf.pop();
    first(entry.absentWhen?.allOf ?? []).equals = { type: "number", value: 1 };
    expect(() => canonicalizeIssueReproductionRequest(value)).toThrow();
  });

  it("rejects signatures that cannot prove disjointness and contradictory controls", () => {
    const value = intent();
    const entry = first(value.cases);
    entry.absentWhen = structuredClone(entry.presentWhen);
    expect(() => canonicalizeIssueReproductionRequest(value)).toThrow(/disjoint/u);
    entry.absentWhen = {
      allOf: [
        {
          observation: { kind: "probe_value", testStepId: "probe", observationId: "count" },
          equals: { type: "number", value: 0 },
        },
      ],
    };
    expect(() => canonicalizeIssueReproductionRequest(value)).toThrow(/disjoint/u);
    entry.absentWhen = null;
    entry.preconditions = [
      {
        kind: "observation_equals",
        predicate: { ...first(entry.presentWhen.allOf), equals: text("Ready") },
      },
    ];
    expect(() => canonicalizeIssueReproductionRequest(value)).toThrow(/satisfiable/u);
  });

  it("uses structured reference keys when IDs contain colons", () => {
    const value = intent();
    const entry = first(value.cases);
    entry.absentWhen = null;
    entry.presentWhen.allOf = [
      {
        observation: { kind: "probe_value", testStepId: "a:b", observationId: "c" },
        equals: text("one"),
      },
      {
        observation: { kind: "probe_value", testStepId: "a", observationId: "b:c" },
        equals: text("two"),
      },
    ];
    expect(canonicalizeIssueReproductionRequest(value).cases[0]?.presentWhen.allOf).toHaveLength(2);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite observation values %s", (value) => {
    const request = intent();
    const entry = first(request.cases);
    entry.absentWhen = null;
    first(entry.presentWhen.allOf).equals = { type: "number", value };
    expect(() => canonicalizeIssueReproductionRequest(request)).toThrow();
  });
  it("normalizes negative zero without changing string equality", () => {
    const value = intent();
    const entry = first(value.cases);
    entry.absentWhen = null;
    first(entry.presentWhen.allOf).equals = { type: "number", value: -0 };
    expect(
      Object.is(
        first(first(canonicalizeIssueReproductionRequest(value).cases).presentWhen.allOf).equals
          .value,
        -0,
      ),
    ).toBe(false);
    first(entry.presentWhen.allOf).equals = text(" Ready ");
    expect(
      first(first(canonicalizeIssueReproductionRequest(value).cases).presentWhen.allOf).equals
        .value,
    ).toBe(" Ready ");
  });

  it("only admits declared test fields and assertion steps, never launch checks or click values", () => {
    const source = input(["web"]);
    const entry = first(intent(source).cases);
    entry.preconditions = [{ kind: "check_passed", checkId: "version-web:launch" }];
    expect(() => frozen(source)).toThrow(/qualified check/u);
    entry.preconditions = [];
    entry.absentWhen = null;
    first(entry.presentWhen.allOf).observation = {
      kind: "ui_assertion",
      scenarioId: "scenario",
      stepId: "click",
    };
    expect(() => frozen(source)).toThrow(/unsupported/u);
    first(entry.presentWhen.allOf).observation = {
      kind: "probe_value",
      testStepId: "unrelated",
      observationId: "status",
    };
    expect(() => frozen(source)).toThrow(/unsupported/u);
  });

  it.each(["web", "windows_desktop"] as const)(
    "rejects a passed %s scenario incompatible with its expected assertion",
    (target) => {
      const source = input([target]);
      const entry = first(intent(source).cases);
      entry.preconditions = [{ kind: "check_passed", checkId: `version-${target}:scenario` }];
      expect(() => frozen(source)).toThrow(/contradicts/u);
      entry.absentWhen = null;
      first(entry.presentWhen.allOf).equals = text("Ready");
      expect(() => frozen(source)).not.toThrow();
      const step = profile(source).config.ui?.scenarios[0]?.steps[0];
      if (step?.action !== "assertText") throw new Error("Expected a text assertion.");
      step.match = "contains";
      rehash(source);
      first(entry.presentWhen.allOf).equals = text("Not Ready Yet");
      expect(() => frozen(source)).not.toThrow();
      first(entry.presentWhen.allOf).equals = text("Duplicate");
      expect(() => frozen(source)).toThrow(/contradicts/u);
    },
  );
});

describe("three-valued deterministic reproduction", () => {
  it("rejects a forged double-truth binding before evaluating observations", () => {
    const value = structuredClone(frozen());
    first(value.binding.cases).absentWhen = structuredClone(first(value.binding.cases).presentWhen);
    value.bindingDigest = hash(canonical(value.binding));
    expect(() => evaluateIssueReproductionCases(value.binding, [execution(value)])).toThrow(
      /disjoint/u,
    );
  });
  it.each(["headless", "web", "windows_desktop"] as const)(
    "evaluates positive, negative, and neither on %s",
    (target) => {
      const value = frozen(input([target]));
      expect(first(evaluateIssueReproductionCases(value.binding, [execution(value)])).state).toBe(
        "present",
      );
      expect(
        first(
          evaluateIssueReproductionCases(value.binding, [
            execution(value, undefined, text("Ready")),
          ]),
        ).state,
      ).toBe("absent");
      for (const unmatched of ["Starting", "ready", " Ready "])
        expect(
          first(
            evaluateIssueReproductionCases(value.binding, [
              execution(value, undefined, text(unmatched)),
            ]),
          ).state,
        ).toBe("inconclusive");
    },
  );
  it("does not turn missing, pending, or explicit unavailable values into absence", () => {
    const value = frozen();
    const ready = execution(value);
    const fact = first(ready.observations);
    for (const executions of [
      [],
      [{ ...ready, state: "pending" as const }],
      [{ ...ready, observations: [] }],
      [
        {
          ...ready,
          observations: [
            {
              observation: fact.observation,
              checkId: fact.checkId,
              evidenceIds: [],
              state: "unavailable" as const,
              reason: "not_run",
            },
          ],
        },
      ],
    ]) {
      const cases = evaluateIssueReproductionCases(value.binding, executions);
      expect(first(cases).state).toBe("inconclusive");
      expect(aggregateIssueReproduction(value, planDigest, cases).conclusion).toBe("inconclusive");
    }
    expect(
      first(
        evaluateIssueReproductionCases(value.binding, [
          {
            ...ready,
            observations: [
              {
                observation: fact.observation,
                checkId: fact.checkId,
                evidenceIds: [],
                state: "unavailable",
                reason: "unsafe_value",
              },
            ],
          },
        ]),
      ).state,
    ).toBe("blocked");
  });
  it("keeps positive-only experiments inconclusive when their signature is false", () => {
    const source = input();
    first(intent(source).cases).absentWhen = null;
    const value = frozen(source);
    const cases = evaluateIssueReproductionCases(value.binding, [
      execution(value, undefined, text("Ready")),
    ]);
    expect(first(cases)).toMatchObject({ state: "inconclusive", reasons: ["positive_only"] });
    expect(aggregateIssueReproduction(value, planDigest, cases).conclusion).toBe("inconclusive");
  });
  it("requires explicit controls and rejects duplicate or scope-substituted facts", () => {
    const source = input();
    first(intent(source).cases).preconditions = [
      { kind: "check_passed", checkId: "version-headless:setup" },
    ];
    const value = frozen(source);
    const ready = execution(value);
    expect(first(evaluateIssueReproductionCases(value.binding, [ready])).reasons).toEqual([
      "precondition_unavailable",
    ]);
    expect(
      first(
        evaluateIssueReproductionCases(value.binding, [
          { ...ready, failedPreconditionCheckIds: ["version-headless:setup"] },
        ]),
      ).reasons,
    ).toEqual(["precondition_failed"]);
    expect(
      first(
        evaluateIssueReproductionCases(value.binding, [
          { ...ready, passedPreconditionCheckIds: ["version-headless:setup"] },
        ]),
      ).state,
    ).toBe("present");
    for (const substitute of [
      { requestId: "other" },
      { issueRevisionKey: "c".repeat(64) },
      { testedSourceCommit: "d".repeat(40) },
      { profileVersionId: "other" },
      { observations: [first(ready.observations), first(ready.observations)] },
    ]) {
      expect(
        first(evaluateIssueReproductionCases(value.binding, [{ ...ready, ...substitute }])).state,
      ).toBe("blocked");
    }
    expect(() => evaluateIssueReproductionCases(value.binding, [ready, ready])).toThrow();
  });
  it("confirms partial positive coverage but requires all explicit negatives for not_reproduced", () => {
    const value = frozen(input(["headless", "web", "windows_desktop"]));
    const positive = execution(value, "case-web");
    const negative = execution(value, "case-headless", text("Ready"));
    const blocked = {
      ...execution(value, "case-windows_desktop"),
      state: "blocked" as const,
      reasons: ["lifecycle_blocked" as const],
    };
    const mixed = evaluateIssueReproductionCases(value.binding, [positive, negative, blocked]);
    expect(aggregateIssueReproduction(value, planDigest, mixed)).toMatchObject({
      conclusion: "confirmed",
      coverage: "partial",
    });
    expect(
      aggregateIssueReproduction(
        value,
        planDigest,
        evaluateIssueReproductionCases(value.binding, [negative, blocked]),
      ).conclusion,
    ).toBe("blocked");
    const allNegative = value.binding.cases.map((entry) =>
      execution(value, entry.id, text("Ready")),
    );
    expect(
      aggregateIssueReproduction(
        value,
        planDigest,
        evaluateIssueReproductionCases(value.binding, allNegative),
      ),
    ).toMatchObject({ conclusion: "not_reproduced", coverage: "complete" });
    expect(
      aggregateIssueReproductionRequest(
        value,
        planDigest,
        "request-web",
        mixed.filter((entry) => entry.requestId === "request-web"),
      ),
    ).toMatchObject({
      schemaVersion: "IssueReproductionRequestAssessmentV1",
      requestId: "request-web",
      conclusion: "confirmed",
    });
    expect(() =>
      aggregateIssueReproductionRequest(value, planDigest, "request-web", mixed),
    ).toThrow();
    expect(() => aggregateIssueReproduction(value, planDigest, mixed.slice(1))).toThrow();
    expect(() => aggregateIssueReproduction(value, "invalid", mixed)).toThrow();
    expect(canonical(mixed)).not.toContain("Duplicate");
  });
});

describe("verified runner derivation", () => {
  it.each(["web", "windows_desktop"] as const)(
    "rejects %s mapped secret commands without changing legacy configuration",
    (target) => {
      const source = input([target]);
      first(profile(source).config.setup).command.environment = [
        { name: "TOKEN", secretRef: "fixture-secret" },
      ];
      rehash(source);
      expect(() => frozen(source)).toThrow(/public fixture/u);
      delete source.reproduction;
      expect(freezeIssueReproductionBinding(source)).toBeUndefined();
    },
  );
  it("requires explicit trace-off and a reachable UI assertion sequence", () => {
    const source = input(["web"]);
    const ui = profile(source).config.ui;
    if (ui?.target !== "web") throw new Error("The Web fixture is missing.");
    ui.evidence.trace = "always";
    rehash(source);
    expect(() => frozen(source)).toThrow(/disable traces/u);
    ui.evidence.trace = "off";
    const scenario = first(ui.scenarios);
    scenario.steps.push({ ...first(scenario.steps), id: "later-status" });
    first(intent(source).cases).presentWhen.allOf.push({
      observation: { kind: "ui_assertion", scenarioId: scenario.id, stepId: "later-status" },
      equals: text("Ready"),
    });
    rehash(source);
    expect(() => frozen(source)).toThrow(/cannot reach/u);
  });
  it("preserves boolean false as a complete observation and checks passed visibility controls", () => {
    const source = input(["web"]);
    const ui = profile(source).config.ui;
    if (ui?.target !== "web") throw new Error("The Web fixture is missing.");
    const scenario = first(ui.scenarios);
    scenario.steps = [
      {
        id: "status",
        name: "Observe visibility",
        action: "assertVisible",
        expected: true,
        locator: { by: "testId", testId: "status" },
        timeoutMs: 1000,
      },
    ];
    const entry = first(intent(source).cases);
    first(entry.presentWhen.allOf).equals = { type: "boolean", value: false };
    first(entry.absentWhen?.allOf ?? []).equals = { type: "boolean", value: true };
    rehash(source);
    const value = frozen(source);
    expect(
      first(
        evaluateIssueReproductionCases(value.binding, [
          execution(value, undefined, { type: "boolean", value: false }),
        ]),
      ).state,
    ).toBe("present");
    entry.preconditions.push({ kind: "check_passed", checkId: "version-web:scenario" });
    expect(() => frozen(source)).toThrow(/contradicts/u);
  });
  it.each(["web", "windows_desktop"] as const)(
    "accepts %s without cleanup commands only with confirmed process exit",
    (target) => {
      const source = input([target]);
      profile(source).config.cleanup = [];
      rehash(source);
      const value = deriveInput(target, source);
      if (value.execution === null) throw new Error("The fixture details are missing.");
      value.execution.cleanupState = "not_needed";
      expect(derivedState(value)).toBe("present");
      const launch = value.execution.diagnostics.find((entry) => entry.phase === "launch");
      if (launch === undefined) throw new Error("The launch diagnostic is missing.");
      launch.exitCode = null;
      expect(derivedState(value)).toBe("blocked");
    },
  );
  it("requires declared optional reset commands and every started command to settle", () => {
    const source = input(["web"]);
    const config = profile(source).config;
    first(config.setup).required = false;
    if (config.ui === undefined) throw new Error("The UI fixture is missing.");
    config.ui.reset = { strategy: "commands", stepIds: ["setup"] };
    rehash(source);
    const value = deriveInput("web", source);
    const check = value.report?.checks.find((entry) => entry.id.endsWith(":setup"));
    const diagnostic = value.execution?.diagnostics.find((entry) =>
      entry.stepId.endsWith(":setup"),
    );
    if (check === undefined || diagnostic === undefined)
      throw new Error("The reset records are missing.");
    check.outcome = "not_run";
    diagnostic.outcome = "not_run";
    diagnostic.exitCode = null;
    expect(derivedState(value)).toBe("blocked");
    const headless = deriveInput();
    if (headless.execution === null) throw new Error("The fixture details are missing.");
    headless.execution.diagnostics = headless.execution.diagnostics.filter(
      (entry) => !entry.stepId.endsWith(":unrelated"),
    );
    expect(derivedState(headless)).toBe("blocked");
  });
  it("retains positive same-request coverage when another case loses evidence", () => {
    const source = input();
    const config = profile(source).config;
    config.test.push({
      ...command("secondary"),
      probeOutput: {
        schemaVersion: "TestProbeOutputDeclarationV1",
        fields: [{ id: "status", description: "A separate status.", type: "string" }],
      },
    });
    const second = structuredClone(first(intent(source).cases));
    second.id = "case-second";
    for (const predicate of [...second.presentWhen.allOf, ...(second.absentWhen?.allOf ?? [])])
      predicate.observation = {
        kind: "probe_value",
        testStepId: "secondary",
        observationId: "status",
      };
    intent(source).cases.push(second);
    rehash(source);
    const value = deriveInput("headless", source);
    const both = {
      ...value,
      observations: [
        ...execution(value.frozen, "case-headless").observations,
        ...execution(value.frozen, "case-second").observations,
      ],
      evidenceUnavailableCheckIds: ["version-headless:secondary"],
    };
    const cases = evaluateIssueReproductionCases(
      value.frozen.binding,
      deriveIssueReproductionCaseExecutions(both),
    );
    expect(cases.map((entry) => entry.state)).toEqual(["present", "blocked"]);
    expect(aggregateIssueReproduction(value.frozen, planDigest, cases)).toMatchObject({
      conclusion: "confirmed",
      coverage: "partial",
    });
    first(intent(source).cases).preconditions.push({
      kind: "check_passed",
      checkId: "version-headless:secondary",
    });
    const withControl = deriveInput("headless", source);
    expect(
      first(
        evaluateIssueReproductionCases(
          withControl.frozen.binding,
          deriveIssueReproductionCaseExecutions({
            ...withControl,
            evidenceUnavailableCheckIds: ["version-headless:secondary"],
          }),
        ),
      ).state,
    ).toBe("blocked");
  });
  it.each(["headless", "web", "windows_desktop"] as const)(
    "accepts a valid %s measurement even when unrelated correctness fails",
    (target) => {
      const value = deriveInput(target);
      const check = value.report?.checks.find((entry) => entry.id.endsWith(":unrelated"));
      const diagnostic = value.execution?.diagnostics.find((entry) =>
        entry.stepId.endsWith(":unrelated"),
      );
      if (check === undefined || diagnostic === undefined)
        throw new Error("The fixture check is missing.");
      check.outcome = "failed";
      diagnostic.outcome = "failed";
      diagnostic.exitCode = 1;
      expect(derivedState(value)).toBe("present");
    },
  );
  it.each(["web", "windows_desktop"] as const)(
    "requires %s readiness, complete exit, cleanup, and original source",
    (target) => {
      const ready = deriveInput(target);
      expect(derivedState(ready)).toBe("present");
      const changes: ((
        value: DeriveIssueReproductionCaseExecutionsInput,
      ) => DeriveIssueReproductionCaseExecutionsInput)[] = [
        (value) => ({ ...value, evidenceComplete: false }),
        (value) => ({
          ...value,
          report: value.report === null ? null : { ...value.report, sourceState: "modified" },
        }),
        (value) => ({
          ...value,
          execution:
            value.execution === null ? null : { ...value.execution, cleanupState: "failed" },
        }),
        (value) => ({
          ...value,
          execution:
            value.execution === null
              ? null
              : {
                  ...value.execution,
                  diagnostics: value.execution.diagnostics.filter(
                    (entry) => entry.phase !== "launch",
                  ),
                },
        }),
        (value) => ({
          ...value,
          execution:
            value.execution === null
              ? null
              : {
                  ...value.execution,
                  diagnostics: value.execution.diagnostics.map((entry) =>
                    entry.phase === "launch" ? { ...entry, exitCode: null } : entry,
                  ),
                },
        }),
        (value) => ({
          ...value,
          execution:
            value.execution === null
              ? null
              : {
                  ...value.execution,
                  blockers: [
                    {
                      phase: "cleanup",
                      stepId: null,
                      code: "UI_PROCESS_TEARDOWN_FAILED",
                      message: "No teardown confirmation.",
                    },
                  ],
                },
        }),
        (value) => ({
          ...value,
          execution:
            value.execution === null
              ? null
              : {
                  ...value.execution,
                  blockers: [
                    {
                      phase: "model_review",
                      stepId: null,
                      code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
                      message: "No teardown confirmation.",
                    },
                  ],
                },
        }),
      ];
      for (const change of changes) expect(derivedState(change(ready))).toBe("blocked");
    },
  );
  it.each(["setup", "build", "cleanup"] as const)(
    "requires successful matching %s commands even when the cleanup is optional",
    (phase) => {
      const value = deriveInput();
      const id = `version-headless:${phase}`;
      const check = value.report?.checks.find((entry) => entry.id === id);
      const diagnostic = value.execution?.diagnostics.find((entry) => entry.stepId === id);
      if (check === undefined || diagnostic === undefined)
        throw new Error("The fixture check is missing.");
      check.outcome = "failed";
      diagnostic.outcome = "failed";
      diagnostic.exitCode = 1;
      expect(derivedState(value)).toBe("blocked");
    },
  );
  it("rejects forged probe facts from failed commands without parsing diagnostics", () => {
    const value = deriveInput();
    const check = value.report?.checks.find((entry) => entry.id.endsWith(":probe"));
    const diagnostic = value.execution?.diagnostics.find((entry) =>
      entry.stepId.endsWith(":probe"),
    );
    if (check === undefined || diagnostic === undefined)
      throw new Error("The probe check is missing.");
    check.outcome = "failed";
    diagnostic.outcome = "failed";
    diagnostic.exitCode = 1;
    diagnostic.stdout = "Duplicate";
    expect(derivedState(value)).toBe("blocked");
    expect(derivedState({ ...value, observations: [] })).toBe("blocked");
  });
  it("rejects wrong check/phase/type scope and unknown process obstructions", () => {
    const value = deriveInput();
    const fact = first(value.observations);
    expect(derivedState({ ...value, observations: [{ ...fact, checkId: "another:probe" }] })).toBe(
      "blocked",
    );
    const wrongType: ReproductionObservationFact = {
      observation: fact.observation,
      checkId: fact.checkId,
      evidenceIds: [],
      state: "observed",
      value: { type: "number", value: 1 },
    };
    expect(derivedState({ ...value, observations: [wrongType] })).toBe("blocked");
    expect(derivedState({ ...value, observations: [fact, fact] })).toBe("blocked");
    if (value.execution === null) throw new Error("The fixture details are missing.");
    expect(
      derivedState({
        ...value,
        execution: {
          ...value.execution,
          blockers: [
            {
              phase: "test",
              stepId: "version-headless:unrelated",
              code: "OUTPUT_READ_FAILED",
              message: "Streams were not drained.",
            },
          ],
        },
      }),
    ).toBe("blocked");
    expect(() =>
      deriveIssueReproductionCaseExecutions({ ...value, planDigest: "invalid" }),
    ).toThrow();
  });
});
