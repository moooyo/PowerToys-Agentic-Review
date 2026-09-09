import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertEvaluationExecutionAuthorization,
  assertEvaluationReviewRunPlan,
  assertEvaluationSourceSnapshot,
  assertEvaluationValidationJobContext,
  EvaluationExecutionAuthorizationV1Schema,
  EvaluationExecutionPurposeV1Schema,
  type EvaluationExecutionTemplate,
  type EvaluationExecutionTemplateBinding,
  EvaluationModelRequirementsV1Schema,
  type EvaluationSourceSnapshotV1,
  EvaluationSourceSnapshotV1Schema,
  evaluationExecutionRequiredCapabilityLabels,
  evaluationModelExecutionCapabilityLabels,
  getEvaluationExecutionAuthorizationIssues,
  getEvaluationExecutionTemplateIssues,
  getEvaluationModelRequiredCapabilityLabels,
  getEvaluationReviewRunPlanIssues,
  getEvaluationSourceSnapshotIssues,
  getEvaluationValidationJobContextIssues,
  maximumEvaluationSourceSnapshotUtf8Bytes,
  type ReviewRunExecutionPlanV2,
  ReviewRunExecutionPlanV2Schema,
  type ValidationJobContextV2,
  ValidationJobContextV2Schema,
} from "./evaluation-execution.js";
import { JobExecutionTemplateV1Schema } from "./job-envelope.js";
import type {
  ValidationProfileVersion,
  ValidationTarget,
  WorkflowKind,
} from "./platform-configuration.js";
import { WorkflowOutputSchemaVersions } from "./platform-configuration.js";
import { ReviewRunExecutionPlanV1Schema } from "./review-run.js";
import { ValidationJobContextSchema } from "./validation-job.js";

const now = "2026-09-08T01:00:00.000Z";
const capturedAt = "2026-09-08T00:00:00.000Z";
const digest = (character: string) => character.repeat(64);
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Fixture is missing ${label}.`);
  return value;
}

function onlyJob(value: ReviewRunExecutionPlanV2) {
  if (value.jobs.length !== 1) throw new Error("Fixture must contain exactly one request.");
  return requireValue(value.jobs[0], "the frozen request");
}

function reproductionBinding(value: ReviewRunExecutionPlanV2) {
  return requireValue(value.reproduction, "the reproduction binding").binding;
}

function onlyReproductionCase(value: ReviewRunExecutionPlanV2) {
  const binding = reproductionBinding(value);
  if (binding.cases.length !== 1)
    throw new Error("Fixture must contain exactly one reproduction case.");
  return requireValue(binding.cases[0], "the reproduction case");
}

function source(workflow: WorkflowKind = "pr_static_build"): EvaluationSourceSnapshotV1 {
  const pr = workflow === "pr_static_build" || workflow === "pr_ui";
  const item = {
    githubWorkItemId: 200,
    githubNodeId: "NODE_200",
    githubRepositoryId: 100,
    number: 7,
    title: "Preserve the frozen sample",
    body: "The exact original report body.",
    state: "open" as const,
    author: { githubUserId: 300, login: "contributor" },
    htmlUrl: `https://github.com/example/repository/${pr ? "pull" : "issues"}/7`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    closedAt: null,
  };
  const revision = { githubRepositoryId: 100, githubWorkItemId: 200, revisionKey: digest("a") };
  return {
    schemaVersion: "EvaluationSourceSnapshotV1",
    repository: {
      id: "repository-1",
      githubRepositoryId: 100,
      fullName: "example/repository",
      configurationVersion: 1,
    },
    workItemId: "work-item-1",
    workItem: pr ? { ...item, kind: "pull_request", isDraft: false } : { ...item, kind: "issue" },
    revision: pr
      ? { ...revision, kind: "pull_request", baseSha: "1".repeat(40), headSha: "2".repeat(40) }
      : { ...revision, kind: "issue", contentDigest: digest("b") },
    revisionId: "revision-1",
    testedSourceRevision: pr
      ? { kind: "pull_request", baseSha: "1".repeat(40), headSha: "2".repeat(40) }
      : workflow === "issue_validation"
        ? { kind: "commit", headSha: "3".repeat(40) }
        : null,
    freshness: "frozen",
    sourceDigest: digest("c"),
    provenance: {
      kind: "current_work_item",
      capturedAt,
      expectedRevisionKey: revision.revisionKey,
    },
  };
}

function profile(workflow: WorkflowKind, target: ValidationTarget): ValidationProfileVersion {
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [],
    build:
      workflow === "issue_triage"
        ? []
        : [
            {
              id: "build",
              name: "Compile the frozen source",
              command: {
                executable: "build.exe",
                args: [],
                workingDirectory: ".",
                environment: [],
              },
              timeoutMs: 30_000,
              required: true,
            },
          ],
    test: [],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 120_000,
    noProgressTimeoutMs: 60_000,
  };
  return {
    id: "profile-version-1",
    profileId: "profile-1",
    repositoryId: "repository-1",
    version: 1,
    name: "Evaluation profile",
    required: true,
    config,
    configSha256: digest("d"),
    createdAt: capturedAt,
    publishedAt: capturedAt,
    createdBy: "operator",
    workflowKind: workflow,
    target,
    outputSchemaVersion:
      workflow === "pr_static_build"
        ? "PrReviewPlanV2"
        : workflow === "issue_triage"
          ? "IssueTriageV2"
          : "ValidationReportV1",
  } as ValidationProfileVersion;
}

function plan(
  workflow: WorkflowKind = "pr_static_build",
  target: ValidationTarget = "headless",
): ReviewRunExecutionPlanV2 {
  const frozen = source(workflow);
  const version = profile(workflow, target);
  const requiredCheckIds = version.config.build.map((step) => `${version.id}:${step.id}`);
  return {
    schemaVersion: "ReviewRunExecutionPlanV2",
    activationId: "activation-1",
    requestEpochId: null,
    repository: structuredClone(frozen.repository),
    workItemId: frozen.workItemId,
    workItem: structuredClone(frozen.workItem),
    revision: structuredClone(frozen.revision),
    testedSourceRevision: structuredClone(frozen.testedSourceRevision),
    testedSourceAuthorization: null,
    source: frozen,
    purpose: {
      schemaVersion: "EvaluationExecutionPurposeV1",
      kind: "evaluation",
      evaluationId: "evaluation-1",
      cellId: "cell-1",
      caseId: "case-1",
      arm: "candidate",
      sampleSetVersionId: "sample-set-version-1",
      authorizationId: "authorization-1",
      executionManifestSha256: digest("e"),
      trial: 1,
      upstreamMutationPolicy: "forbidden",
    },
    authorization: {
      schemaVersion: "EvaluationExecutionAuthorizationV1",
      kind: "operator_evaluation",
      id: "authorization-1",
      actor: { issuer: "https://identity.example.com", subject: "operator-1" },
      authorizedAt: now,
      evaluationId: "evaluation-1",
      repositoryId: frozen.repository.id,
      githubRepositoryId: 100,
      sampleSetVersionId: "sample-set-version-1",
      sourceManifestSha256: digest("1"),
      configurationManifestSha256: digest("2"),
      cellManifestSha256: digest("3"),
      executionManifestSha256: digest("e"),
    },
    modelRequirements: { required: true },
    jobs: [
      {
        requestId: "request-1",
        workflowKind: workflow,
        target,
        required: true,
        profileVersion: version,
        prompt: {
          workflowKind: workflow,
          version: {
            id: "prompt-version-1",
            templateId: "prompt-1",
            version: 1,
            content: "Review the frozen input.",
            contentSha256: digest("5"),
            outputSchemaVersion: WorkflowOutputSchemaVersions[workflow],
            createdAt: capturedAt,
            publishedAt: capturedAt,
            createdBy: "operator",
          },
        },
        requiredCheckIds,
      },
    ],
    requiredCheckIds: [...requiredCheckIds],
  };
}

function context(value = plan()): ValidationJobContextV2 {
  const request = onlyJob(value);
  const prompt = request.prompt.version;
  return {
    schemaVersion: "ValidationJobContextV2",
    runId: "run-1",
    planDigest: digest("6"),
    activationId: value.activationId,
    requestId: request.requestId,
    jobActivation: 1,
    repositoryId: value.repository.id,
    workItemId: value.workItemId,
    revisionKey: value.revision.revisionKey,
    requestEpochId: null,
    workflowKind: request.workflowKind,
    target: request.target,
    required: request.required,
    profileVersion: structuredClone(request.profileVersion),
    promptVersion: {
      id: prompt.id,
      templateId: prompt.templateId,
      version: prompt.version,
      contentSha256: prompt.contentSha256,
    },
    requiredCheckIds: [...request.requiredCheckIds],
    testedSourceRevision: structuredClone(value.testedSourceRevision),
    testedSourceAuthorization: null,
    source: structuredClone(value.source),
    purpose: structuredClone(value.purpose),
    authorization: structuredClone(value.authorization),
    modelRequirements: structuredClone(value.modelRequirements),
    ...(value.reproduction === undefined
      ? {}
      : { reproduction: structuredClone(value.reproduction) }),
  };
}

function execution(value = plan()): {
  template: EvaluationExecutionTemplate;
  binding: EvaluationExecutionTemplateBinding;
} {
  const validation = context(value);
  const request = onlyJob(value);
  const item = value.workItem;
  const common = {
    githubNodeId: item.githubNodeId,
    number: item.number,
    title: item.title,
    author: item.author,
    canonicalSnapshot: item,
  };
  const frozenPrompt = {
    name: "prompt-1",
    version: "1",
    renderedPrompt: "Frozen rendered input.",
    promptSha256: digest("7"),
    outputSchema: {},
    outputSchemaSha256: digest("8"),
  };
  const requiredCapabilityLabels = {
    executionEnvelope: "2",
    [request.target === "headless"
      ? "validationHeadless"
      : request.target === "web"
        ? "validationWeb"
        : "validationWindowsDesktop"]: "1",
    ...evaluationExecutionRequiredCapabilityLabels,
    ...getEvaluationModelRequiredCapabilityLabels(
      request.workflowKind,
      value.modelRequirements.required,
    ),
  };
  return {
    template: {
      repository: {
        githubRepositoryId: value.repository.githubRepositoryId,
        fullName: value.repository.fullName,
      },
      resource:
        item.kind === "pull_request" && value.revision.kind === "pull_request"
          ? {
              ...common,
              kind: "pull_request",
              baseSha: value.revision.baseSha,
              headSha: value.revision.headSha,
              isDraft: item.isDraft,
            }
          : { ...common, kind: "issue", revisionDigest: value.revision.revisionKey },
      prompt: structuredClone(frozenPrompt),
      executionPolicy: {
        hardTimeoutMs: 120_000,
        noProgressTimeoutMs: 60_000,
        allowedRecipeIds: [],
        requiredCapabilityLabels: { ...requiredCapabilityLabels },
      },
      validation,
    },
    binding: {
      plan: value,
      runId: "run-1",
      planDigest: digest("6"),
      frozenPrompt,
      requiredCapabilityLabels,
    },
  };
}

function reproductionPlan(): ReviewRunExecutionPlanV2 {
  const value = plan("issue_validation");
  const request = onlyJob(value);
  request.profileVersion.config.test = [
    {
      ...requireValue(request.profileVersion.config.build[0], "the build step"),
      id: "probe",
      name: "Measure the reported behavior",
      probeOutput: {
        schemaVersion: "TestProbeOutputDeclarationV1",
        fields: [{ id: "observed", description: "The measured behavior", type: "boolean" }],
      },
    },
  ];
  request.requiredCheckIds.push("profile-version-1:probe");
  value.requiredCheckIds = [...request.requiredCheckIds];
  value.reproduction = {
    bindingDigest: digest("9"),
    binding: {
      schemaVersion: "IssueReproductionBindingV1",
      activationId: value.activationId,
      repositoryId: value.repository.id,
      githubRepositoryId: value.repository.githubRepositoryId,
      workItemId: value.workItemId,
      githubWorkItemId: value.workItem.githubWorkItemId,
      issueRevisionKey: value.revision.revisionKey,
      testedSourceCommit: "3".repeat(40),
      authorizedBy: {
        ...value.authorization.actor,
        authorizedAt: value.authorization.authorizedAt,
      },
      claim: "The measured value exposes the reported behavior.",
      cases: [
        {
          id: "reproduction-case-1",
          context: "Evaluate a deterministic probe.",
          preconditions: [],
          presentWhen: {
            allOf: [
              {
                observation: {
                  kind: "probe_value",
                  testStepId: "probe",
                  observationId: "observed",
                },
                equals: { type: "boolean", value: true },
              },
            ],
          },
          absentWhen: null,
          requestId: request.requestId,
          profileVersionId: request.profileVersion.id,
          profileConfigSha256: request.profileVersion.configSha256,
          target: "headless",
        },
      ],
    },
  };
  return value;
}

describe("evaluation execution source and authority", () => {
  it("freezes complete current metadata and accepts historical closed sources without current authority", () => {
    const value = source();
    expect(getEvaluationSourceSnapshotIssues(value)).toEqual([]);
    expect(() => assertEvaluationSourceSnapshot(value)).not.toThrow();
    value.workItem.state = "closed";
    value.workItem.closedAt = capturedAt;
    value.provenance = {
      kind: "review_run",
      capturedAt,
      reviewRunId: "old-run",
      planDigest: digest("9"),
      requestEpochId: "withdrawn-epoch",
    };
    expect(getEvaluationSourceSnapshotIssues(value)).toEqual([]);
    expect(Value.Check(EvaluationSourceSnapshotV1Schema, value)).toBe(true);
    expect(Value.Check(EvaluationSourceSnapshotV1Schema, { ...value, freshness: "current" })).toBe(
      false,
    );
  });

  it.each([
    [
      "repository",
      (value: EvaluationSourceSnapshotV1) => {
        value.repository.githubRepositoryId = 999;
      },
    ],
    [
      "work item",
      (value: EvaluationSourceSnapshotV1) => {
        value.revision.githubWorkItemId = 999;
      },
    ],
    [
      "expected revision",
      (value: EvaluationSourceSnapshotV1) => {
        if (value.provenance.kind === "current_work_item")
          value.provenance.expectedRevisionKey = digest("f");
      },
    ],
    [
      "exact head",
      (value: EvaluationSourceSnapshotV1) => {
        if (value.testedSourceRevision?.kind === "pull_request")
          value.testedSourceRevision.headSha = "f".repeat(40);
      },
    ],
    [
      "noncanonical commit length",
      (value: EvaluationSourceSnapshotV1) => {
        if (value.revision.kind === "pull_request") value.revision.headSha = "f".repeat(41);
      },
    ],
  ])("rejects mismatched source %s", (_name, mutate) => {
    const value = source();
    mutate(value);
    expect(getEvaluationSourceSnapshotIssues(value).length).toBeGreaterThan(0);
    expect(() => assertEvaluationSourceSnapshot(value)).toThrow();
  });

  it("bounds source UTF-8 bytes without truncation and rejects malformed Unicode", () => {
    const value = source();
    value.workItem.body = "\u754c".repeat(Math.ceil(maximumEvaluationSourceSnapshotUtf8Bytes / 3));
    expect(Value.Check(EvaluationSourceSnapshotV1Schema, value)).toBe(true);
    expect(getEvaluationSourceSnapshotIssues(value)).toEqual([
      "Evaluation source snapshot exceeds its aggregate UTF-8 byte limit.",
    ]);
    value.workItem.body = "\ud800";
    expect(getEvaluationSourceSnapshotIssues(value)).toEqual([
      "Evaluation source snapshot must contain well-formed JSON data.",
    ]);
  });

  it.each(["sourceDigest", "revisionId", "provenance", "workItem", "revision"])(
    "requires source field %s",
    (field) => {
      const value = source();
      Reflect.deleteProperty(value, field);
      expect(getEvaluationSourceSnapshotIssues(value).length).toBeGreaterThan(0);
    },
  );

  it("rejects claimed approval, write permission, and GitHub epochs on evaluation authorization", () => {
    const value = plan().authorization;
    expect(() => assertEvaluationExecutionAuthorization(value)).not.toThrow();
    for (const extra of [
      { approved: true },
      { requestEpochId: "fake-epoch" },
      { upstreamMutationPolicy: "allowed" },
    ])
      expect(Value.Check(EvaluationExecutionAuthorizationV1Schema, { ...value, ...extra })).toBe(
        false,
      );
    value.actor.subject = " operator-1 ";
    expect(getEvaluationExecutionAuthorizationIssues(value).length).toBeGreaterThan(0);
  });

  it("does not admit human assessment labels into the execution source", () => {
    expect(
      Value.Check(EvaluationSourceSnapshotV1Schema, {
        ...source(),
        expectedFindings: [],
        expectedOutcome: "passed",
      }),
    ).toBe(false);
  });

  it.each([
    "sourceManifestSha256",
    "configurationManifestSha256",
    "cellManifestSha256",
    "executionManifestSha256",
  ] as const)("requires bounded authorization manifest %s", (field) => {
    const value = plan().authorization;
    expect(
      Value.Check(EvaluationExecutionAuthorizationV1Schema, { ...value, [field]: "claimed" }),
    ).toBe(false);
    Reflect.deleteProperty(value, field);
    expect(Value.Check(EvaluationExecutionAuthorizationV1Schema, value)).toBe(false);
  });
});

describe("evaluation-only run plans", () => {
  it.each([
    ["pr_static_build", "headless"],
    ["pr_ui", "web"],
    ["pr_ui", "windows_desktop"],
    ["issue_triage", "headless"],
    ["issue_validation", "headless"],
    ["issue_validation", "web"],
    ["issue_validation", "windows_desktop"],
  ] as const)(
    "retains the frozen %s/%s workflow without claiming runtime readiness",
    (workflow, target) => {
      const value = plan(workflow, target);
      expect(Value.Check(ReviewRunExecutionPlanV2Schema, value)).toBe(true);
      expect(getEvaluationReviewRunPlanIssues(value)).toEqual([]);
      expect(() => assertEvaluationReviewRunPlan(value)).not.toThrow();
      expect(
        getEvaluationValidationJobContextIssues(context(value), {
          plan: value,
          runId: "run-1",
          planDigest: digest("6"),
        }),
      ).toEqual([]);
    },
  );

  it("keeps V1 plan/context schemas unchanged and rejects adding evaluation purpose to old shapes", () => {
    const value = plan();
    const current = context(value);
    const {
      purpose: _purpose,
      source: _source,
      authorization: _authority,
      modelRequirements: _model,
      ...oldFields
    } = current;
    const old = {
      ...oldFields,
      schemaVersion: "ValidationJobContextV1",
      requestEpochId: "existing-epoch",
    };
    expect(Value.Check(ValidationJobContextSchema, old)).toBe(true);
    expect(Value.Check(ValidationJobContextSchema, { ...old, purpose: value.purpose })).toBe(false);
    expect(Value.Check(ValidationJobContextSchema, current)).toBe(false);
    expect(Value.Check(ReviewRunExecutionPlanV1Schema, value)).toBe(false);
    expect(Value.Check(JobExecutionTemplateV1Schema, execution(value).template)).toBe(false);
  });

  it("uses a fresh evaluation stamp for a historical closed work item and withdrawn epoch", () => {
    const value = plan();
    value.source.workItem.state = "closed";
    value.source.workItem.closedAt = capturedAt;
    value.source.provenance = {
      kind: "review_run",
      capturedAt,
      reviewRunId: "old-run",
      planDigest: digest("9"),
      requestEpochId: "withdrawn-epoch",
    };
    value.workItem = structuredClone(value.source.workItem);
    expect(getEvaluationReviewRunPlanIssues(value)).toEqual([]);
    expect(value.requestEpochId).toBeNull();
    expect(value.testedSourceAuthorization).toBeNull();
  });

  it("requires exactly one complete request and never accepts fake legacy source authorization", () => {
    const value = plan();
    for (const jobs of [
      [],
      [value.jobs[0], value.jobs[0]],
      [{ ...value.jobs[0], profileVersion: null }],
      [{ ...value.jobs[0], prompt: null }],
    ])
      expect(Value.Check(ReviewRunExecutionPlanV2Schema, { ...value, jobs })).toBe(false);
    expect(
      Value.Check(ReviewRunExecutionPlanV2Schema, { ...value, requestEpochId: "fake-epoch" }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunExecutionPlanV2Schema, {
        ...value,
        testedSourceAuthorization: { kind: "operator" },
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunExecutionPlanV2Schema, {
        ...value,
        authorization: { requestEpochId: "fake-epoch", basis: "self" },
      }),
    ).toBe(false);
  });

  it.each([
    [
      "source body",
      (value: ReviewRunExecutionPlanV2) => {
        value.workItem.body = "A newer report body.";
      },
    ],
    [
      "source commit",
      (value: ReviewRunExecutionPlanV2) => {
        value.testedSourceRevision = { kind: "commit", headSha: "4".repeat(40) };
      },
    ],
    [
      "repository",
      (value: ReviewRunExecutionPlanV2) => {
        value.authorization.repositoryId = "another-repository";
      },
    ],
    [
      "evaluation",
      (value: ReviewRunExecutionPlanV2) => {
        value.purpose.evaluationId = "another-evaluation";
      },
    ],
    [
      "suite version",
      (value: ReviewRunExecutionPlanV2) => {
        value.purpose.sampleSetVersionId = "another-suite";
      },
    ],
    [
      "authorization ID",
      (value: ReviewRunExecutionPlanV2) => {
        value.purpose.authorizationId = "another-authorization";
      },
    ],
    [
      "execution manifest",
      (value: ReviewRunExecutionPlanV2) => {
        value.purpose.executionManifestSha256 = digest("f");
      },
    ],
    [
      "authorization time",
      (value: ReviewRunExecutionPlanV2) => {
        value.authorization.authorizedAt = "2020-01-01T00:00:00.000Z";
      },
    ],
    [
      "profile scope",
      (value: ReviewRunExecutionPlanV2) => {
        onlyJob(value).profileVersion.repositoryId = "another-repository";
      },
    ],
    [
      "prompt workflow",
      (value: ReviewRunExecutionPlanV2) => {
        onlyJob(value).prompt.workflowKind = "issue_triage";
      },
    ],
    [
      "prompt schema",
      (value: ReviewRunExecutionPlanV2) => {
        onlyJob(value).prompt.version.outputSchemaVersion = "IssueTriageV2";
      },
    ],
    [
      "required coverage",
      (value: ReviewRunExecutionPlanV2) => {
        onlyJob(value).requiredCheckIds = [];
        value.requiredCheckIds = [];
      },
    ],
    [
      "aggregate coverage",
      (value: ReviewRunExecutionPlanV2) => {
        value.requiredCheckIds = [];
      },
    ],
  ])("rejects cross-field %s substitution", (_name, mutate) => {
    const value = plan();
    mutate(value);
    expect(getEvaluationReviewRunPlanIssues(value).length).toBeGreaterThan(0);
  });

  it("enforces snapshot-only triage and explicit Issue validation commits independently of V1 authority", () => {
    const triage = plan("issue_triage");
    expect(triage.source.testedSourceRevision).toBeNull();
    triage.source.testedSourceRevision = triage.testedSourceRevision = {
      kind: "commit",
      headSha: "f".repeat(40),
    };
    expect(getEvaluationReviewRunPlanIssues(triage)).toContain(
      "Issue triage evaluations must remain snapshot-only without a tested commit.",
    );
    const validation = plan("issue_validation");
    validation.source.testedSourceRevision = validation.testedSourceRevision = null;
    expect(getEvaluationReviewRunPlanIssues(validation)).toContain(
      "Issue validation evaluations require an explicitly selected source commit.",
    );
    const pr = plan();
    pr.source.testedSourceRevision = pr.testedSourceRevision = null;
    expect(getEvaluationReviewRunPlanIssues(pr)).toContain(
      "Evaluation PR source must retain its exact base and head commits.",
    );
  });

  it.each([true, false])("accepts a model requirement containing only required: %s", (required) => {
    expect(Value.Check(EvaluationModelRequirementsV1Schema, { required })).toBe(true);
  });

  it("requires model execution for static review and triage while allowing profile-only validation", () => {
    const value = plan();
    expect(getEvaluationReviewRunPlanIssues(value)).toEqual([]);
    value.modelRequirements.required = false;
    expect(getEvaluationReviewRunPlanIssues(value)).toContain(
      "Static review and Issue triage evaluations require model execution.",
    );
    const ui = plan("pr_ui", "web");
    ui.modelRequirements = { required: false };
    expect(getEvaluationReviewRunPlanIssues(ui)).toEqual([]);
    const validation = plan("issue_validation");
    validation.modelRequirements = { required: false };
    expect(getEvaluationReviewRunPlanIssues(validation)).toEqual([]);
    const triage = plan("issue_triage");
    triage.modelRequirements.required = false;
    expect(getEvaluationReviewRunPlanIssues(triage).length).toBeGreaterThan(0);
    expect(
      Value.Check(EvaluationModelRequirementsV1Schema, {
        ...ui.modelRequirements,
        networkBoundaryAccepted: true,
      }),
    ).toBe(false);
  });
});

describe("evaluation context and template binding", () => {
  it("returns issues for an invalid expected plan without dereferencing missing requests", () => {
    const value = plan();
    const job = context(value);
    Reflect.deleteProperty(value, "jobs");
    expect(
      getEvaluationValidationJobContextIssues(job, {
        plan: value,
        runId: "run-1",
        planDigest: digest("6"),
      }).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    [
      "cell",
      (value: ValidationJobContextV2) => {
        value.purpose.cellId = "another-cell";
      },
    ],
    [
      "case",
      (value: ValidationJobContextV2) => {
        value.purpose.caseId = "another-case";
      },
    ],
    [
      "arm",
      (value: ValidationJobContextV2) => {
        value.purpose.arm = "baseline";
      },
    ],
    [
      "source digest",
      (value: ValidationJobContextV2) => {
        value.source.sourceDigest = digest("f");
      },
    ],
    [
      "revision row",
      (value: ValidationJobContextV2) => {
        value.source.revisionId = "another-revision";
      },
    ],
    [
      "configuration manifest",
      (value: ValidationJobContextV2) => {
        value.authorization.configurationManifestSha256 = digest("f");
      },
    ],
    [
      "cell manifest",
      (value: ValidationJobContextV2) => {
        value.authorization.cellManifestSha256 = digest("f");
      },
    ],
    [
      "source manifest",
      (value: ValidationJobContextV2) => {
        value.authorization.sourceManifestSha256 = digest("f");
      },
    ],
    [
      "actor",
      (value: ValidationJobContextV2) => {
        value.authorization.actor.subject = "another-operator";
      },
    ],
    [
      "model requirement",
      (value: ValidationJobContextV2) => {
        value.modelRequirements.required = false;
      },
    ],
    [
      "plan digest",
      (value: ValidationJobContextV2) => {
        value.planDigest = digest("f");
      },
    ],
    [
      "run",
      (value: ValidationJobContextV2) => {
        value.runId = "another-run";
      },
    ],
    [
      "request",
      (value: ValidationJobContextV2) => {
        value.requestId = "another-request";
      },
    ],
    [
      "prompt",
      (value: ValidationJobContextV2) => {
        value.promptVersion.id = "another-prompt";
      },
    ],
    [
      "profile bytes",
      (value: ValidationJobContextV2) => {
        requireValue(value.profileVersion.config.build[0], "the build step").command.args = [
          "changed",
        ];
      },
    ],
  ])("rejects another %s at the exact plan binding", (_name, mutate) => {
    const value = plan();
    const job = context(value);
    mutate(job);
    const expected = { plan: value, runId: "run-1", planDigest: digest("6") };
    expect(getEvaluationValidationJobContextIssues(job, expected).length).toBeGreaterThan(0);
    expect(() => assertEvaluationValidationJobContext(job, expected)).toThrow();
  });

  it("rejects invented epochs, legacy source authority, further trials, and side-effect permission", () => {
    const value = context();
    for (const extra of [
      { requestEpochId: "fake" },
      { jobActivation: 2 },
      { testedSourceAuthorization: { kind: "operator" } },
      { publish: true },
    ])
      expect(Value.Check(ValidationJobContextV2Schema, { ...value, ...extra })).toBe(false);
    expect(Value.Check(EvaluationExecutionPurposeV1Schema, { ...value.purpose, trial: 2 })).toBe(
      false,
    );
    expect(
      Value.Check(EvaluationExecutionPurposeV1Schema, {
        ...value.purpose,
        upstreamMutationPolicy: "allowed",
      }),
    ).toBe(false);
  });

  it("binds the rendered prompt and execution policy without claiming digest attestation", () => {
    const { template, binding } = execution();
    expect(getEvaluationExecutionTemplateIssues(template, binding)).toEqual([]);
    const unchanged = JSON.stringify(template);
    expect(getEvaluationExecutionTemplateIssues(template, binding)).toEqual([]);
    expect(JSON.stringify(template)).toBe(unchanged);
    template.prompt.renderedPrompt = "A replacement prompt with the same claimed digest.";
    expect(getEvaluationExecutionTemplateIssues(template, binding).length).toBeGreaterThan(0);
  });

  it.each([
    [
      "current PR head",
      (value: EvaluationExecutionTemplate) => {
        if (value.resource.kind === "pull_request") value.resource.headSha = "f".repeat(40);
      },
    ],
    [
      "snapshot",
      (value: EvaluationExecutionTemplate) => {
        value.resource.canonicalSnapshot = {};
      },
    ],
    [
      "repository",
      (value: EvaluationExecutionTemplate) => {
        value.repository.githubRepositoryId = 999;
      },
    ],
    [
      "timeout",
      (value: EvaluationExecutionTemplate) => {
        value.executionPolicy.hardTimeoutMs = 180_000;
      },
    ],
    [
      "recipes",
      (value: EvaluationExecutionTemplate) => {
        value.executionPolicy.allowedRecipeIds = ["unapproved"];
      },
    ],
    [
      "evaluation capability",
      (value: EvaluationExecutionTemplate) => {
        delete value.executionPolicy.requiredCapabilityLabels.validationEvaluation;
      },
    ],
  ])("rejects template substitution of %s", (_name, mutate) => {
    const { template, binding } = execution();
    mutate(template);
    expect(getEvaluationExecutionTemplateIssues(template, binding).length).toBeGreaterThan(0);
  });

  it("cannot remove the evaluation protocol gate even from the caller's expected policy", () => {
    const { template, binding } = execution();
    delete template.executionPolicy.requiredCapabilityLabels.validationEvaluation;
    const altered = {
      ...binding,
      requiredCapabilityLabels: { executionEnvelope: "2", validationHeadless: "1" },
    };
    expect(getEvaluationExecutionTemplateIssues(template, altered)).toContain(
      "Evaluation templates require implemented evaluation and target protocol capabilities.",
    );
  });

  it("cannot remove the required model runtime from the caller's expected policy", () => {
    const { template, binding } = execution();
    const label = evaluationModelExecutionCapabilityLabels.review;
    const labels = { ...binding.requiredCapabilityLabels };
    delete labels[label];
    template.executionPolicy.requiredCapabilityLabels = { ...labels };
    expect(
      getEvaluationExecutionTemplateIssues(template, {
        ...binding,
        requiredCapabilityLabels: labels,
      }),
    ).toContain(
      "Evaluation templates require implemented evaluation and target protocol capabilities.",
    );
  });

  it("preserves reproduction with fresh evaluation authority and gates its observation protocols", () => {
    const value = reproductionPlan();
    expect(getEvaluationReviewRunPlanIssues(value)).toEqual([]);
    const { template, binding } = execution(value);
    expect(getEvaluationExecutionTemplateIssues(template, binding)).toContain(
      "Evaluation templates require implemented evaluation and target protocol capabilities.",
    );
    const labels = {
      ...binding.requiredCapabilityLabels,
      issueReproduction: "1",
      structuredProbeOutput: "1",
    };
    template.executionPolicy.requiredCapabilityLabels = { ...labels };
    expect(
      getEvaluationExecutionTemplateIssues(template, {
        ...binding,
        requiredCapabilityLabels: labels,
      }),
    ).toEqual([]);
    expect(template.validation.testedSourceAuthorization).toBeNull();
    expect(template.validation.requestEpochId).toBeNull();
  });

  it.each([
    [
      "historical actor",
      (value: ReviewRunExecutionPlanV2) => {
        reproductionBinding(value).authorizedBy.subject = "old-operator";
      },
    ],
    [
      "historical time",
      (value: ReviewRunExecutionPlanV2) => {
        reproductionBinding(value).authorizedBy.authorizedAt = capturedAt;
      },
    ],
    [
      "another source",
      (value: ReviewRunExecutionPlanV2) => {
        reproductionBinding(value).testedSourceCommit = "f".repeat(40);
      },
    ],
    [
      "another request",
      (value: ReviewRunExecutionPlanV2) => {
        onlyReproductionCase(value).requestId = "another-request";
      },
    ],
    [
      "another profile",
      (value: ReviewRunExecutionPlanV2) => {
        onlyReproductionCase(value).profileConfigSha256 = digest("f");
      },
    ],
  ])("rejects reproduction borrowing %s", (_name, mutate) => {
    const value = reproductionPlan();
    mutate(value);
    expect(getEvaluationReviewRunPlanIssues(value)).toContain(
      "Evaluation reproduction must use its own source, request, profile, and evaluation authorization.",
    );
  });
});
