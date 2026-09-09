import { createHash } from "node:crypto";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import {
  type IssueReproductionBindingV1,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  PullRequestValidationSummaryV1Schema,
  type UiScenarioConfiguration,
  type ValidationCommandStep,
  type ValidationProfileConfig,
  type ValidationProfileVersion,
  type ValidationTarget,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { getReviewRunExecutorCapabilityLabels } from "@agentic-review/domain";
import {
  type ModelArtifactEvaluationEnvelope,
  modelArtifactEvaluationFixture,
  refreshModelArtifactSourceDigest,
} from "./model-output-artifact.testing.js";

const outputSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: PullRequestValidationSummaryV1Schema,
  issue_validation: IssueValidationSummaryV1Schema,
};

function command(id: string): ValidationCommandStep {
  return {
    id,
    name: `Synthetic ${id}`,
    command: { executable: "fixture.exe", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 1_000,
    required: true,
  };
}

function uiConfiguration(target: "web" | "windows_desktop"): UiScenarioConfiguration {
  const scenario = { id: "scenario", name: "Synthetic scenario", required: true, timeoutMs: 1_000 };
  const assertion = {
    id: "assertion",
    name: "Synthetic assertion",
    action: "assertText" as const,
    expected: "Ready",
    match: "exact" as const,
    timeoutMs: 100,
  };
  if (target === "web")
    return {
      schemaVersion: "UiScenariosV1",
      target,
      service: {
        origin: "managed_loopback",
        portEnvironmentVariable: "PORT",
        navigation: "same_origin",
      },
      browser: { engine: "chromium", headless: true, viewport: { width: 800, height: 600 } },
      launch: {
        stepId: "launch",
        mode: "persistent",
        readiness: { kind: "http", path: "/", expectedStatus: 200, timeoutMs: 1_000 },
      },
      reset: { strategy: "restart_process" },
      evidence: {
        screenshots: "every_assertion",
        screenshotScope: "viewport",
        trace: "off",
        required: true,
      },
      scenarios: [
        {
          ...scenario,
          path: "/",
          steps: [{ ...assertion, locator: { by: "testId", testId: "status" } }],
        },
      ],
    };
  return {
    schemaVersion: "UiScenariosV1",
    target,
    desktop: { session: "exclusive_interactive", scope: "launched_process_tree" },
    launch: {
      stepId: "launch",
      mode: "persistent",
      readiness: { kind: "window", window: { title: "Synthetic window" }, timeoutMs: 1_000 },
    },
    reset: { strategy: "restart_process" },
    evidence: { screenshots: "every_assertion", screenshotScope: "owned_window", required: true },
    scenarios: [
      {
        ...scenario,
        steps: [{ ...assertion, locator: { by: "automationId", automationId: "status" } }],
      },
    ],
  };
}

/** Builds data only; no fixture executable or external repository is accessed. */
export function evaluationProfileEnvelopeFixture(
  workflowKind: WorkflowKind = "pr_static_build",
  target: ValidationTarget = workflowKind === "pr_ui" ? "web" : "headless",
  modelRequired = true,
): ModelArtifactEvaluationEnvelope {
  const kind =
    workflowKind === "pr_static_build" || workflowKind === "pr_ui" ? "pull_request" : "issue";
  const { envelope } = modelArtifactEvaluationFixture(kind);
  const context = envelope.validation;
  const config: ValidationProfileConfig = {
    ...context.profileVersion.config,
    test: target === "headless" && workflowKind !== "issue_triage" ? [command("test")] : [],
    launch: target === "headless" ? [] : [command("launch")],
    ...(target === "headless" ? {} : { ui: uiConfiguration(target) }),
  };
  context.workflowKind = workflowKind;
  context.target = target;
  context.profileVersion = {
    ...context.profileVersion,
    workflowKind,
    target,
    config,
    configSha256: createCanonicalResult(config).sha256,
    outputSchemaVersion:
      workflowKind === "pr_static_build"
        ? "PrReviewPlanV2"
        : workflowKind === "issue_triage"
          ? "IssueTriageV2"
          : "ValidationReportV1",
  } as ValidationProfileVersion;
  context.requiredCheckIds = [
    ...config.test.map((step) => `${context.profileVersion.id}:${step.id}`),
    ...(config.ui?.scenarios.map((scenario) => `${context.profileVersion.id}:${scenario.id}`) ??
      []),
  ];
  if (workflowKind === "issue_triage") {
    context.testedSourceRevision = null;
    context.source.testedSourceRevision = null;
  }
  if (!modelRequired) {
    context.modelRequirements = { required: false };
  }
  envelope.prompt.outputSchema = JSON.parse(JSON.stringify(outputSchemas[workflowKind]));
  envelope.prompt.outputSchemaSha256 = createCanonicalResult(envelope.prompt.outputSchema).sha256;
  refreshEvaluationProfileFixture(envelope);
  return envelope;
}

export function refreshEvaluationProfileFixture(envelope: ModelArtifactEvaluationEnvelope): void {
  const context = envelope.validation;
  context.profileVersion.configSha256 = createCanonicalResult(context.profileVersion.config).sha256;
  envelope.executionPolicy.requiredCapabilityLabels = getReviewRunExecutorCapabilityLabels(
    context,
    context,
  );
  refreshModelArtifactSourceDigest(envelope);
}

export function ordinaryProfileEnvelopeFixture(
  workflowKind: WorkflowKind = "issue_validation",
): JobExecutionEnvelopeV2 {
  const envelope = evaluationProfileEnvelopeFixture(workflowKind);
  const {
    source,
    purpose: _purpose,
    authorization,
    modelRequirements: _requirements,
    ...context
  } = envelope.validation;
  const tested = context.testedSourceRevision;
  return {
    ...envelope,
    executionPolicy: {
      ...envelope.executionPolicy,
      requiredCapabilityLabels: { executionEnvelope: "2", validationHeadless: "1" },
    },
    validation: {
      ...context,
      schemaVersion: "ValidationJobContextV1",
      requestEpochId: "ordinary-epoch",
      testedSourceAuthorization:
        workflowKind === "issue_validation" && tested?.kind === "commit"
          ? {
              kind: "operator",
              activationId: context.activationId,
              issuer: authorization.actor.issuer,
              subject: authorization.actor.subject,
              authorizedAt: authorization.authorizedAt,
              githubRepositoryId: source.repository.githubRepositoryId,
              githubWorkItemId: source.workItem.githubWorkItemId,
              issueRevisionKey: context.revisionKey,
              headSha: tested.headSha,
            }
          : null,
    },
  };
}

export function mappedEvaluationProfileFixture(): ModelArtifactEvaluationEnvelope {
  const envelope = evaluationProfileEnvelopeFixture("issue_validation");
  const context = envelope.validation;
  const tested = context.testedSourceRevision;
  if (tested?.kind !== "commit") throw new Error("Synthetic commit is missing.");
  const step = context.profileVersion.config.test[0];
  if (step === undefined) throw new Error("Synthetic probe is missing.");
  step.probeOutput = {
    schemaVersion: "TestProbeOutputDeclarationV1",
    fields: [{ id: "observed", description: "Synthetic observation", type: "boolean" }],
  };
  refreshEvaluationProfileFixture(envelope);
  const binding: IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: context.activationId,
    repositoryId: context.repositoryId,
    githubRepositoryId: context.source.repository.githubRepositoryId,
    workItemId: context.workItemId,
    githubWorkItemId: context.source.workItem.githubWorkItemId,
    issueRevisionKey: context.revisionKey,
    testedSourceCommit: tested.headSha,
    authorizedBy: {
      ...context.authorization.actor,
      authorizedAt: context.authorization.authorizedAt,
    },
    claim: "Synthetic observation reproduces the issue.",
    cases: [
      {
        id: "case-a",
        context: "Synthetic reproduction context.",
        preconditions: [],
        presentWhen: {
          allOf: [
            {
              observation: { kind: "probe_value", testStepId: "test", observationId: "observed" },
              equals: { type: "boolean", value: true },
            },
          ],
        },
        absentWhen: null,
        requestId: context.requestId,
        profileVersionId: context.profileVersion.id,
        profileConfigSha256: context.profileVersion.configSha256,
        target: context.target,
      },
    ],
  };
  context.reproduction = { binding, bindingDigest: createCanonicalResult(binding).sha256 };
  refreshEvaluationProfileFixture(envelope);
  return envelope;
}

export function refreshEvaluationIssueRevision(envelope: ModelArtifactEvaluationEnvelope): void {
  const source = envelope.validation.source;
  const item = source.workItem;
  if (source.revision.kind !== "issue" || envelope.resource.kind !== "issue")
    throw new Error("Expected a synthetic Issue.");
  const digest = createHash("sha256")
    .update(JSON.stringify([item.title, item.body, item.state, item.updatedAt]))
    .digest("hex");
  source.revision.revisionKey = digest;
  source.revision.contentDigest = digest;
  envelope.validation.revisionKey = digest;
  envelope.resource.revisionDigest = digest;
  if (source.provenance.kind === "current_work_item")
    source.provenance.expectedRevisionKey = digest;
  refreshModelArtifactSourceDigest(envelope);
}
