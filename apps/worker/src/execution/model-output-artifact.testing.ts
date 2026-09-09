import { createHash } from "node:crypto";
import {
  createCanonicalResult,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV2ModelResult,
} from "@agentic-review/codex";
import {
  getEvaluationModelRequiredCapabilityLabels,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  type ReviewExecutionEvidence,
  type ValidationJobContextV2,
  type ValidationSummaryInputReferenceV1,
} from "@agentic-review/contracts";
import { createModelOutputArtifact } from "./model-output-artifact.js";
import type { CliExecutionObservation } from "./prepared-cli-output-runner.js";

export type ModelArtifactEvaluationEnvelope = JobExecutionEnvelopeV2 & {
  validation: ValidationJobContextV2;
};
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function refreshModelArtifactSourceDigest(envelope: ModelArtifactEvaluationEnvelope): void {
  const source = envelope.validation.source;
  source.sourceDigest = createCanonicalResult({
    repository: source.repository,
    workItemId: source.workItemId,
    workItem: source.workItem,
    revision: source.revision,
    testedSourceRevision: source.testedSourceRevision,
    revisionId: source.revisionId,
  }).sha256;
}

/** Complete synthetic data only; no CLI or external repository is accessed. */
export function modelArtifactEvaluationFixture(kind: "pull_request" | "issue" = "pull_request") {
  const createdAt = "2026-09-08T00:00:00.000Z";
  const baseSha = "a".repeat(40),
    headSha = "b".repeat(40);
  const commonItem = {
    githubWorkItemId: 42,
    githubNodeId: "item-node",
    githubRepositoryId: 123,
    number: 42,
    title: "Frozen source",
    body: "Synthetic source text.",
    state: "open" as const,
    author: { githubUserId: 7, login: "fixture", accountType: "user" as const },
    htmlUrl: `https://github.com/example/repository/${kind === "issue" ? "issues" : "pull"}/42`,
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
  };
  const item = kind === "issue" ? { ...commonItem, kind } : { ...commonItem, kind, isDraft: false };
  const revisionKey = hash(
    kind === "pull_request"
      ? `${baseSha}\0${headSha}`
      : JSON.stringify([item.title, item.body, item.state, item.updatedAt]),
  );
  const workflowKind = kind === "issue" ? "issue_validation" : "pr_static_build";
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [],
    build: [],
    test: [],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 30_000,
  };
  const source: ValidationJobContextV2["source"] = {
    schemaVersion: "EvaluationSourceSnapshotV1",
    freshness: "frozen",
    sourceDigest: "0".repeat(64),
    repository: {
      id: "repo-a",
      githubRepositoryId: 123,
      fullName: "example/repository",
      configurationVersion: 1,
    },
    workItemId: "work-item-a",
    workItem: item,
    revisionId: "revision-a",
    revision:
      kind === "pull_request"
        ? { kind, githubRepositoryId: 123, githubWorkItemId: 42, revisionKey, baseSha, headSha }
        : {
            kind,
            githubRepositoryId: 123,
            githubWorkItemId: 42,
            revisionKey,
            contentDigest: revisionKey,
          },
    testedSourceRevision:
      kind === "pull_request" ? { kind, baseSha, headSha } : { kind: "commit", headSha },
    provenance: {
      kind: "current_work_item",
      capturedAt: createdAt,
      expectedRevisionKey: revisionKey,
    },
  };
  const outputSchema = JSON.parse(
    JSON.stringify(
      kind === "issue" ? IssueValidationSummaryV1Schema : PrReviewPlanV2ModelOutputSchema,
    ),
  );
  const renderedPrompt = "Review only this frozen synthetic source.";
  const envelope: ModelArtifactEvaluationEnvelope = {
    protocolVersion: "1.0",
    envelopeVersion: 2,
    assignedAt: createdAt,
    leaseExpiresAt: "2026-09-08T00:02:00.000Z",
    executionDeadlineAt: "2026-09-08T00:20:00.000Z",
    lease: {
      jobId: "job-a",
      runAttemptId: "attempt-a",
      workerNodeId: "worker-a",
      workerInstanceId: "instance-a",
      leaseGeneration: 1,
      leaseToken: "private-lease-token-for-artifact-check",
    },
    job: {
      jobId: "job-a",
      kind: kind === "issue" ? "issue_triage" : "pull_request_review",
      priority: 10,
      attempt: 1,
      maxAttempts: 1,
      generation: 1,
      intentVersion: 1,
      semanticKey: "semantic-a",
    },
    repository: { githubRepositoryId: 123, fullName: "example/repository" },
    resource:
      kind === "pull_request"
        ? {
            kind,
            githubNodeId: item.githubNodeId,
            number: item.number,
            title: item.title,
            author: item.author,
            canonicalSnapshot: item,
            baseSha,
            headSha,
            isDraft: false,
          }
        : {
            kind,
            githubNodeId: item.githubNodeId,
            number: item.number,
            title: item.title,
            author: item.author,
            canonicalSnapshot: item,
            revisionDigest: revisionKey,
          },
    prompt: {
      name: "template-a",
      version: "1",
      renderedPrompt,
      promptSha256: hash(renderedPrompt),
      outputSchema,
      outputSchemaSha256: createCanonicalResult(outputSchema).sha256,
    },
    executionPolicy: {
      hardTimeoutMs: 60_000,
      noProgressTimeoutMs: 30_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {
        executionEnvelope: "2",
        validationEvaluation: "1",
        validationHeadless: "1",
        ...getEvaluationModelRequiredCapabilityLabels(workflowKind, true),
      },
    },
    validation: {
      schemaVersion: "ValidationJobContextV2",
      runId: "run-a",
      requestId: "request-a",
      activationId: "activation-a",
      jobActivation: 1,
      repositoryId: "repo-a",
      workItemId: source.workItemId,
      planDigest: hash("synthetic-plan"),
      revisionKey,
      requestEpochId: null,
      workflowKind,
      target: "headless",
      required: true,
      profileVersion: {
        id: "profile-version-a",
        profileId: "profile-a",
        repositoryId: "repo-a",
        name: "Synthetic profile",
        workflowKind,
        target: "headless",
        version: 1,
        config,
        configSha256: createCanonicalResult(config).sha256,
        required: true,
        outputSchemaVersion: kind === "issue" ? "ValidationReportV1" : "PrReviewPlanV2",
        createdAt,
        publishedAt: createdAt,
        createdBy: "operator",
      },
      promptVersion: {
        id: "prompt-a",
        templateId: "template-a",
        version: 1,
        contentSha256: hash("synthetic-template"),
      },
      requiredCheckIds: [],
      testedSourceRevision: source.testedSourceRevision,
      testedSourceAuthorization: null,
      source,
      purpose: {
        schemaVersion: "EvaluationExecutionPurposeV1",
        kind: "evaluation",
        evaluationId: "evaluation-a",
        cellId: "cell-a",
        caseId: "case-a",
        arm: "baseline",
        sampleSetVersionId: "suite-version-a",
        authorizationId: "authorization-a",
        executionManifestSha256: "a".repeat(64),
        trial: 1,
        upstreamMutationPolicy: "forbidden",
      },
      authorization: {
        schemaVersion: "EvaluationExecutionAuthorizationV1",
        kind: "operator_evaluation",
        id: "authorization-a",
        actor: { issuer: "fixture", subject: "operator" },
        authorizedAt: createdAt,
        evaluationId: "evaluation-a",
        repositoryId: "repo-a",
        githubRepositoryId: 123,
        sampleSetVersionId: "suite-version-a",
        sourceManifestSha256: "b".repeat(64),
        configurationManifestSha256: "c".repeat(64),
        cellManifestSha256: "d".repeat(64),
        executionManifestSha256: "a".repeat(64),
      },
      modelRequirements: { required: true },
    },
  };
  refreshModelArtifactSourceDigest(envelope);
  const rawResult: ValidationJobResultV2ModelResult =
    kind === "issue"
      ? {
          schemaVersion: "ValidationSummaryV1",
          workItemKind: "issue",
          summary: "Original model output.",
          reproductionConclusion: "inconclusive",
          observations: [],
        }
      : {
          schemaVersion: "PrReviewPlanV2",
          summary: "Original model output.",
          assessment: "comment",
          findings: [],
          requestedRecipeIds: [],
          verification: {
            status: "not_run",
            summary: "The example token=placeholder is model text.",
            commands: [],
          },
        };
  const canonical = createCanonicalResult(rawResult);
  const summaryInputRef: ValidationSummaryInputReferenceV1 | undefined =
    kind === "issue"
      ? {
          schemaVersion: "ValidationSummaryInputReferenceV1",
          inputId: "summary-input-a",
          inputSha256: hash("synthetic-summary-input"),
          sourcePromptSha256: envelope.prompt.promptSha256,
          outputSchemaSha256: envelope.prompt.outputSchemaSha256,
          contextSha256: hash("synthetic-summary-context"),
          actualPromptSha256: hash("synthetic-summary-prompt"),
        }
      : undefined;
  const cliExecution: CliExecutionObservation = {
    engine: "codex",
    cliVersion: "fixture-version",
    requestedModel: null,
    processRequestId: "process-request-a",
    startedAt: createdAt,
    completedAt: "2026-09-08T00:00:01.000Z",
    promptSha256: summaryInputRef?.actualPromptSha256 ?? envelope.prompt.promptSha256,
    actualPromptSha256: summaryInputRef?.actualPromptSha256 ?? envelope.prompt.promptSha256,
    outputSchemaSha256: envelope.prompt.outputSchemaSha256,
    modelOutputSha256: canonical.sha256,
  };
  const executionEvidence: ReviewExecutionEvidence = {
    schemaVersion: "ReviewExecutionEvidenceV1",
    source: "worker",
    commandCapture: "complete",
    commands: [{ itemId: "command-1", command: "git status", status: "completed", exitCode: 0 }],
    worktree: { status: "modified", source: "git_status" },
  };
  const preparedOutput = {
    outcome: "succeeded" as const,
    result: rawResult,
    canonicalResultJson: canonical.json,
    resultDigest: canonical.sha256,
    cliExecution,
  };
  const artifact = createModelOutputArtifact({
    output: preparedOutput,
    executionEvidence,
    envelope,
    ...(summaryInputRef === undefined ? {} : { summaryInputRef }),
  });
  return {
    envelope,
    rawResult,
    resultJson: canonical.json,
    canonical,
    cliExecution,
    executionEvidence,
    preparedOutput,
    summaryInputRef,
    artifact,
  };
}
