import { createHash } from "node:crypto";
import type {
  EvaluationReproductionMappingSelectionV1,
  EvaluationSourceSnapshotV1,
  IssueReproductionBindingV1,
  ReviewRunExecutionPlanV1,
  ReviewRunExecutionPlanV2,
  ValidationCommandStep,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import {
  type CreateEvaluationReproductionCellRecordInput,
  createEvaluationReproductionSourceDefinition,
} from "./evaluation-reproduction.js";

export function fixtureCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fixtureCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${fixtureCanonical(record[key])}`)
    .join(",")}}`;
}
export const fixtureDigest = (value: unknown): string =>
  createHash("sha256").update(fixtureCanonical(value)).digest("hex");
const hashText = (value: string): string => createHash("sha256").update(value).digest("hex");
const capturedAt = "2026-09-01T00:00:00.000Z";
const authorizedAt = "2026-09-09T00:00:00.000Z";
const actor = { issuer: "https://fixture.invalid", subject: "new-operator" };
function command(id: string): ValidationCommandStep {
  return {
    id,
    name: id,
    command: { executable: "fixture.exe", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 1000,
    required: true,
  };
}
export function reproductionProfile(
  id = "target-profile",
  probeId = "target-probe",
): ValidationProfileVersion {
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [command("setup")],
    build: [],
    test: [
      {
        ...command(probeId),
        probeOutput: {
          schemaVersion: "TestProbeOutputDeclarationV1" as const,
          fields: [
            { id: "observed", description: "Synthetic observation", type: "boolean" as const },
          ],
        },
      },
    ],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 60000,
    noProgressTimeoutMs: 30000,
  };
  return {
    id,
    profileId: id,
    repositoryId: "repo",
    version: 1,
    name: "Synthetic profile",
    required: true,
    workflowKind: "issue_validation",
    target: "headless",
    outputSchemaVersion: "ValidationReportV1",
    config,
    configSha256: fixtureDigest(config),
    createdAt: capturedAt,
    publishedAt: capturedAt,
    createdBy: "operator",
  };
}
export function reproductionFixture() {
  const repository = {
    id: "repo",
    githubRepositoryId: 1,
    fullName: "example/repository",
    configurationVersion: 1,
  };
  const workItem = {
    kind: "issue" as const,
    githubWorkItemId: 2,
    githubNodeId: "node-2",
    githubRepositoryId: 1,
    number: 2,
    title: "Synthetic Issue",
    body: "Keep the original claim.",
    state: "open" as const,
    author: { githubUserId: 3, login: "author" },
    htmlUrl: "https://github.com/example/repository/issues/2",
    createdAt: capturedAt,
    updatedAt: capturedAt,
    closedAt: null,
  };
  const revisionKey = hashText(
    JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
  );
  const revision = {
    kind: "issue" as const,
    githubRepositoryId: 1,
    githubWorkItemId: 2,
    revisionKey,
    contentDigest: revisionKey,
  };
  const testedSourceRevision = { kind: "commit" as const, headSha: "a".repeat(40) };
  const profile = reproductionProfile("source-profile", "source-probe");
  const binding: IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "source-activation",
    repositoryId: "repo",
    githubRepositoryId: 1,
    workItemId: "item",
    githubWorkItemId: 2,
    issueRevisionKey: revisionKey,
    testedSourceCommit: testedSourceRevision.headSha,
    authorizedBy: {
      issuer: "https://fixture.invalid",
      subject: "old-operator",
      authorizedAt: capturedAt,
    },
    claim: "Observe the reported behavior without changing it.",
    cases: [
      {
        id: "repro-case",
        context: "Retain this exact context.",
        preconditions: [{ kind: "check_passed", checkId: "source-profile:setup" }],
        presentWhen: {
          allOf: [
            {
              observation: {
                kind: "probe_value",
                testStepId: "source-probe",
                observationId: "observed",
              },
              equals: { type: "boolean", value: true },
            },
          ],
        },
        absentWhen: {
          allOf: [
            {
              observation: {
                kind: "probe_value",
                testStepId: "source-probe",
                observationId: "observed",
              },
              equals: { type: "boolean", value: false },
            },
          ],
        },
        requestId: "source-request",
        profileVersionId: profile.id,
        profileConfigSha256: profile.configSha256,
        target: "headless",
      },
    ],
  };
  const plan: ReviewRunExecutionPlanV1 = {
    schemaVersion: "ReviewRunExecutionPlanV1",
    activationId: binding.activationId,
    repository,
    workItemId: "item",
    workItem,
    revision,
    testedSourceRevision,
    testedSourceAuthorization: {
      kind: "operator",
      activationId: binding.activationId,
      ...binding.authorizedBy,
      githubRepositoryId: 1,
      githubWorkItemId: 2,
      issueRevisionKey: revisionKey,
      headSha: testedSourceRevision.headSha,
    },
    authorization: {
      requestEpochId: "old-epoch",
      sequence: 1,
      basis: "self",
      actorGithubUserId: 3,
      targetGithubUserId: 3,
      policy: {
        kind: "self_or_allowlist",
        policyVersion: 1,
        schedulingTargetGithubUserId: 3,
        allowlistedActorGithubUserIds: [],
        unknownActorPolicy: "deny",
      },
    },
    reproduction: { binding, bindingDigest: fixtureDigest(binding) },
    jobs: [
      {
        requestId: "source-request",
        workflowKind: "issue_validation",
        target: "headless",
        required: true,
        profileVersion: profile,
        prompt: {
          workflowKind: "issue_validation",
          version: {
            id: "prompt-version",
            templateId: "prompt",
            version: 1,
            content: "Summarize observed facts.",
            contentSha256: hashText("Summarize observed facts."),
            outputSchemaVersion: "ValidationSummaryV1",
            createdAt: capturedAt,
            publishedAt: capturedAt,
            createdBy: "operator",
          },
        },
        requiredCheckIds: ["source-profile:source-probe"],
      },
    ],
    requiredCheckIds: ["source-profile:source-probe"],
  };
  const source: EvaluationSourceSnapshotV1 = {
    schemaVersion: "EvaluationSourceSnapshotV1",
    repository,
    workItemId: "item",
    workItem,
    revision,
    revisionId: "revision",
    testedSourceRevision,
    freshness: "frozen",
    sourceDigest: fixtureDigest({
      repository,
      workItemId: "item",
      workItem,
      revision,
      revisionId: "revision",
      testedSourceRevision,
    }),
    provenance: {
      kind: "review_run",
      capturedAt: "2026-09-08T00:00:00.000Z",
      reviewRunId: "source-run",
      planDigest: fixtureDigest(plan),
      requestEpochId: "old-epoch",
    },
  };
  const sourceInput = {
    repositoryId: "repo",
    sourceId: "source",
    source,
    plan,
    expectedPlanDigest: fixtureDigest(plan),
  };
  const definition = createEvaluationReproductionSourceDefinition(sourceInput);
  if (definition === null) throw new Error("Synthetic reproduction definition is missing.");
  const mappings = {
    observationMappings: [
      {
        from: {
          kind: "probe_value" as const,
          testStepId: "source-probe",
          observationId: "observed",
        },
        to: { kind: "probe_value" as const, testStepId: "target-probe", observationId: "observed" },
      },
    ],
    checkMappings: [{ fromCheckId: "source-profile:setup", toCheckId: "target-profile:setup" }],
  };
  const selection: EvaluationReproductionMappingSelectionV1 = {
    caseId: "case",
    selectedCaseIds: ["repro-case"],
    expectedSource: {
      reviewRunId: definition.reviewRunId,
      planDigest: definition.planDigest,
      bindingDigest: definition.bindingDigest,
    },
    baseline: mappings,
    candidate: structuredClone(mappings),
  };
  const input: CreateEvaluationReproductionCellRecordInput = {
    evaluationId: "evaluation",
    repositoryId: "repo",
    caseId: "case",
    cellId: "baseline-cell",
    arm: "baseline",
    sourceId: "source",
    applicable: true,
    sourceDefinition: definition,
    selection,
    bindingContext: {
      activationId: "new-activation",
      requestId: "new-request",
      source,
      profileVersion: reproductionProfile(),
      actor,
      authorizedAt,
    },
  };
  return { sourceInput, definition, selection, input };
}
export function evaluationPlanFixture(
  reproduction: NonNullable<ReviewRunExecutionPlanV2["reproduction"]>,
): ReviewRunExecutionPlanV2 {
  const f = reproductionFixture();
  const profile = f.input.bindingContext.profileVersion;
  const { authorization: _old, ...old } = f.sourceInput.plan;
  const request = old.jobs[0];
  if (request === undefined || request.prompt === null)
    throw new Error("Synthetic evaluation request is missing.");
  return {
    ...old,
    schemaVersion: "ReviewRunExecutionPlanV2",
    activationId: "new-activation",
    requestEpochId: null,
    testedSourceAuthorization: null,
    source: f.sourceInput.source,
    reproduction,
    purpose: {
      schemaVersion: "EvaluationExecutionPurposeV1",
      kind: "evaluation",
      evaluationId: "evaluation",
      cellId: "baseline-cell",
      caseId: "case",
      arm: "baseline",
      sampleSetVersionId: "suite",
      authorizationId: "authority",
      executionManifestSha256: "e".repeat(64),
      trial: 1,
      upstreamMutationPolicy: "forbidden",
    },
    authorization: {
      schemaVersion: "EvaluationExecutionAuthorizationV1",
      kind: "operator_evaluation",
      id: "authority",
      actor,
      authorizedAt,
      evaluationId: "evaluation",
      repositoryId: "repo",
      githubRepositoryId: 1,
      sampleSetVersionId: "suite",
      sourceManifestSha256: "b".repeat(64),
      configurationManifestSha256: "c".repeat(64),
      cellManifestSha256: "d".repeat(64),
      executionManifestSha256: "e".repeat(64),
    },
    modelRequirements: { required: false, expectedModelIdentityDigest: null },
    jobs: [
      {
        ...request,
        requestId: "new-request",
        profileVersion: profile,
        workflowKind: "issue_validation",
        target: "headless",
        requiredCheckIds: ["target-profile:target-probe"],
        prompt: request.prompt,
      },
    ],
    requiredCheckIds: ["target-profile:target-probe"],
  };
}
