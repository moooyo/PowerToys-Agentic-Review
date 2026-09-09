import { createCanonicalResult } from "@agentic-review/codex";
import {
  getEvaluationValidationJobContextIssues,
  JobExecutionEnvelopeV2Schema,
  type ReviewExecutionEvidence,
} from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { ModelInvocationSessionResult } from "./model-invocation-coordinator.js";
import {
  assertModelOutputArtifact,
  captureModelInvocationScope,
  createModelOutputArtifact,
  createSummaryModelInvocationScope,
  ModelOutputArtifactError,
  modelOutputReview,
} from "./model-output-artifact.js";
import {
  modelArtifactEvaluationFixture,
  refreshModelArtifactSourceDigest,
} from "./model-output-artifact.testing.js";

function fixture() {
  const result = {
    schemaVersion: "PrReviewPlanV2" as const,
    summary: "Original model output.",
    assessment: "comment" as const,
    findings: [],
    requestedRecipeIds: [],
    verification: {
      status: "not_run" as const,
      summary: "The example token=placeholder is model text.",
      commands: [],
    },
  };
  const canonical = createCanonicalResult(result);
  const { envelope, scope } = modelArtifactEvaluationFixture();
  const recording: ModelInvocationSessionResult = {
    executionAccepted: false,
    modelOutputBound: true,
    submission: {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: scope.invocationId,
      scopeSha256: modelInvocationScopeDigest(scope),
      receiptSetSha256: "e".repeat(64),
      receivedAt: "2026-09-08T00:00:00.000Z",
      consistency: {
        state: "matched",
        reasons: [],
        observedIdentitySha256: scope.expectedModelIdentitySha256,
      },
      executionAccepted: false,
    },
  };
  const executionEvidence: ReviewExecutionEvidence = {
    schemaVersion: "ReviewExecutionEvidenceV1",
    source: "worker",
    commandCapture: "complete",
    commands: [{ itemId: "command-1", command: "git status", status: "completed", exitCode: 0 }],
    worktree: { status: "modified", source: "git_status" },
  };
  const output = {
    outcome: "succeeded" as const,
    result,
    canonicalResultJson: canonical.json,
    resultDigest: canonical.sha256,
    modelInvocation: recording,
  };
  const input = { output, executionEvidence, expectedScope: scope };
  return { input, output, recording, result, scope, executionEvidence, canonical, envelope };
}

describe("original model output artifacts", () => {
  it("requires both the actual summary Prompt and complete context for ScopeV2", () => {
    const { envelope } = modelArtifactEvaluationFixture("issue");
    const scope = createSummaryModelInvocationScope(envelope, "summary-invocation", {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: "a".repeat(64),
      sourcePromptSha256: envelope.prompt.promptSha256,
      outputSchemaSha256: envelope.prompt.outputSchemaSha256,
      contextSha256: "b".repeat(64),
      actualPromptSha256: "c".repeat(64),
    });
    expect(captureModelInvocationScope(scope, envelope, "c".repeat(64), "b".repeat(64))).toEqual(
      scope,
    );
    expect(() => captureModelInvocationScope(scope, envelope, "c".repeat(64))).toThrow(
      ModelOutputArtifactError,
    );
    expect(() =>
      captureModelInvocationScope(scope, envelope, "d".repeat(64), "b".repeat(64)),
    ).toThrow(ModelOutputArtifactError);
    expect(() =>
      captureModelInvocationScope(scope, envelope, "c".repeat(64), "d".repeat(64)),
    ).toThrow(ModelOutputArtifactError);
    expect(() =>
      createSummaryModelInvocationScope(
        modelArtifactEvaluationFixture().envelope,
        "summary-invocation",
        scope.inputRef,
      ),
    ).toThrow(ModelOutputArtifactError);
    expect(Object.isFrozen(scope.inputRef)).toBe(true);
  });
  it.each(["pull_request", "issue"] as const)(
    "binds a complete frozen %s evaluation envelope",
    (kind) => {
      const { envelope, scope } = modelArtifactEvaluationFixture(kind);
      expect(getEvaluationValidationJobContextIssues(envelope.validation)).toEqual([]);
      expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(true);
      const original = createCanonicalResult(envelope).json;
      const captured = captureModelInvocationScope(scope, envelope);
      expect(captured).toEqual(scope);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(createCanonicalResult(envelope).json).toBe(original);
    },
  );

  it.each([
    "evaluationId",
    "cellId",
    "authorizationId",
    "executionManifestSha256",
    "expectedModelIdentitySha256",
    "requestedModel",
  ] as const)("rejects a foreign evaluation scope %s", (field) => {
    const f = fixture();
    f.scope[field] = field.endsWith("Sha256") ? "f".repeat(64) : "foreign";
    expect(() => captureModelInvocationScope(f.scope, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it.each([
    "ordinary",
    "profile-only",
    "missing registration",
    "registration digest",
    "identity digest",
    "registration identity",
    "registration reference",
    "expected identity",
    "authorization",
    "source digest",
    "source revision",
    "resource",
    "profile config",
    "prompt",
    "schema",
    "policy",
    "capability",
    "epoch",
  ])("rejects inconsistent frozen %s data before a collector can be opened", (part) => {
    const f = fixture();
    const context = f.envelope.validation;
    const registration = context.modelRuntimeRegistration;
    const reference = context.modelRequirements.runtimeRegistration;
    if (registration === undefined || reference === undefined)
      throw new Error("Registration required.");
    if (part === "ordinary") {
      for (const field of [
        "purpose",
        "source",
        "authorization",
        "modelRequirements",
        "modelRuntimeRegistration",
      ])
        Reflect.deleteProperty(context, field);
      Object.assign(context, {
        schemaVersion: "ValidationJobContextV1",
        requestEpochId: "ordinary-epoch",
      });
      expect(Value.Check(JobExecutionEnvelopeV2Schema, f.envelope)).toBe(true);
    }
    if (part === "profile-only") context.modelRequirements.required = false;
    if (part === "missing registration")
      Reflect.deleteProperty(context, "modelRuntimeRegistration");
    if (part === "registration digest") reference.registrationSha256 = "f".repeat(64);
    if (part === "identity digest") {
      registration.identitySha256 = "f".repeat(64);
      context.modelRequirements.expectedModelIdentityDigest = registration.identitySha256;
      reference.registrationSha256 = createCanonicalResult(registration).sha256;
      f.scope.expectedModelIdentitySha256 = registration.identitySha256;
    }
    if (part === "registration identity") registration.identity.modelId = "different-model";
    if (part === "registration reference") reference.registrationId = "different-registration";
    if (part === "expected identity")
      context.modelRequirements.expectedModelIdentityDigest = "f".repeat(64);
    if (part === "authorization") context.authorization.evaluationId = "other-evaluation";
    if (part === "source digest") context.source.workItem.body = "changed content";
    if (part === "source revision") {
      context.source.revision.revisionKey = "f".repeat(64);
      context.revisionKey = context.source.revision.revisionKey;
      if (context.source.provenance.kind === "current_work_item")
        context.source.provenance.expectedRevisionKey = context.revisionKey;
      refreshModelArtifactSourceDigest(f.envelope);
    }
    if (part === "resource") f.envelope.resource.title = "different source";
    if (part === "profile config") context.profileVersion.config.hardTimeoutMs += 1;
    if (part === "prompt") f.envelope.prompt.renderedPrompt = "different prompt";
    if (part === "schema") {
      f.envelope.prompt.outputSchema = { type: "object" };
      f.envelope.prompt.outputSchemaSha256 = createCanonicalResult(
        f.envelope.prompt.outputSchema,
      ).sha256;
      f.scope.outputSchemaSha256 = f.envelope.prompt.outputSchemaSha256;
    }
    if (part === "policy") f.envelope.executionPolicy.allowedRecipeIds = ["unplanned"];
    if (part === "capability")
      Reflect.deleteProperty(
        f.envelope.executionPolicy.requiredCapabilityLabels,
        "validationEvaluation",
      );
    if (part === "epoch") Object.assign(context, { requestEpochId: "ordinary-epoch" });
    expect(() => captureModelInvocationScope(f.scope, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it("does not reinterpret a V1 scope as a composite prompt binding", () => {
    const f = fixture();
    f.scope.promptSha256 = "f".repeat(64);
    expect(() => captureModelInvocationScope(f.scope, f.envelope, f.scope.promptSha256)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it("rejects envelope getters and proxies without invoking them", () => {
    const f = fixture();
    const getter = vi.fn(() => {
      throw new Error("Sensitive getter");
    });
    Object.defineProperty(f.envelope, "prompt", { enumerable: true, get: getter });
    expect(() => captureModelInvocationScope(f.scope, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy(f.envelope, { get: getter, getPrototypeOf: getter });
    expect(() => captureModelInvocationScope(f.scope, proxy)).toThrow(ModelOutputArtifactError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("preserves raw canonical output and keeps Worker observations outside it", () => {
    const f = fixture();
    const artifact = createModelOutputArtifact(f.input);
    expect(artifact.result).toEqual(f.result);
    expect(artifact.canonicalResultJson).toBe(f.canonical.json);
    expect(artifact.modelOutputSha256).toBe(f.canonical.sha256);
    expect(artifact.result).not.toHaveProperty("executionEvidence");
    expect(artifact.executionEvidence).toEqual(f.executionEvidence);
    if (artifact.result.schemaVersion !== "PrReviewPlanV2")
      throw new Error("Expected the PR fixture.");
    expect(artifact.result.verification.summary).toContain("token=placeholder");
    const review = modelOutputReview(artifact);
    expect(Object.keys(review).sort()).toEqual([
      "executionEvidence",
      "invocation",
      "result",
      "state",
    ]);
    expect(review.invocation.modelOutputSha256).toBe(f.canonical.sha256);
    expect(review).not.toHaveProperty("scope");
    expect(review).not.toHaveProperty("executionAccepted");
    expect(assertModelOutputArtifact(artifact, f.envelope)).toEqual(artifact);
    f.result.summary = "Changed caller data.";
    const command = f.executionEvidence.commands[0];
    if (command === undefined) throw new Error("Expected the command fixture.");
    command.command = "Changed evidence.";
    f.scope.jobId = "changed-job";
    expect(artifact.result.summary).toBe("Original model output.");
    expect(artifact.executionEvidence.commands[0]?.command).toBe("git status");
    expect(Object.isFrozen(artifact.result)).toBe(true);
    expect(Object.isFrozen(artifact.invocation)).toBe(true);
  });

  it.each([
    "result",
    "canonical JSON",
    "result digest",
    "scope digest",
    "invocation",
    "execution accepted",
    "unbound",
    "unmatched",
    "observed identity",
    "missing",
    "model evidence",
    "worker evidence",
  ])("rejects invalid %s without relabeling the raw output", (part) => {
    const f = fixture();
    if (part === "result") f.result.summary = "Changed.";
    if (part === "canonical JSON")
      f.output.canonicalResultJson = ` ${f.output.canonicalResultJson}`;
    if (part === "result digest") f.output.resultDigest = "f".repeat(64);
    if (part === "scope digest") f.recording.submission.scopeSha256 = "f".repeat(64);
    if (part === "invocation") f.recording.submission.invocationId = "foreign-invocation";
    if (part === "execution accepted") Object.assign(f.recording, { executionAccepted: true });
    if (part === "unbound") Object.assign(f.recording, { modelOutputBound: false });
    if (part === "observed identity")
      f.recording.submission.consistency.observedIdentitySha256 = "f".repeat(64);
    if (part === "unmatched")
      f.recording.submission.consistency = {
        state: "unavailable",
        reasons: ["OUTPUT_UNBOUND"],
        observedIdentitySha256: "d".repeat(64),
      };
    if (part === "missing") Reflect.deleteProperty(f.output, "modelInvocation");
    if (part === "model evidence")
      Object.assign(f.result, { executionEvidence: f.executionEvidence });
    if (part === "worker evidence") f.executionEvidence.worktree.source = "not_observed";
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });

  it.each([
    "jobId",
    "runAttemptId",
    "workerNodeId",
    "workerInstanceId",
    "leaseGeneration",
  ] as const)("rejects another envelope lease %s", (key) => {
    const f = fixture();
    const artifact = createModelOutputArtifact(f.input);
    if (key === "leaseGeneration") f.envelope.lease[key]++;
    else f.envelope.lease[key] = "foreign";
    expect(() => assertModelOutputArtifact(artifact, f.envelope)).toThrow(ModelOutputArtifactError);
  });

  it.each(["repositoryId", "runId", "requestId"] as const)("rejects another frozen %s", (key) => {
    const f = fixture();
    const artifact = createModelOutputArtifact(f.input);
    f.envelope.validation[key] = "foreign";
    expect(() => assertModelOutputArtifact(artifact, f.envelope)).toThrow(ModelOutputArtifactError);
  });

  it("rejects altered artifact bytes, unsupported workflow, and mismatched actual prompt", () => {
    const f = fixture();
    const artifact = structuredClone(createModelOutputArtifact(f.input));
    artifact.result.summary = "Changed.";
    expect(() => assertModelOutputArtifact(artifact, f.envelope)).toThrow(ModelOutputArtifactError);
    const valid = createModelOutputArtifact(f.input);
    expect(() => assertModelOutputArtifact(valid, f.envelope, "f".repeat(64))).toThrow(
      ModelOutputArtifactError,
    );
    Object.assign(f.envelope.validation, { workflowKind: "issue_triage" });
    expect(() => assertModelOutputArtifact(valid, f.envelope)).toThrow(ModelOutputArtifactError);
  });

  it("rejects protected output instead of retaining a redacted replacement", () => {
    const f = fixture();
    expect(() =>
      createModelOutputArtifact({ ...f.input, sensitiveValues: ["placeholder"] }),
    ).toThrow(ModelOutputArtifactError);
    expect(() =>
      createModelOutputArtifact({ ...f.input, sensitiveValues: ["git status"] }),
    ).toThrow(ModelOutputArtifactError);
    f.result.summary = f.envelope.lease.leaseToken;
    const canonical = createCanonicalResult(f.result);
    f.output.canonicalResultJson = canonical.json;
    f.output.resultDigest = canonical.sha256;
    const artifact = createModelOutputArtifact(f.input);
    expect(() => assertModelOutputArtifact(artifact, f.envelope)).toThrow(ModelOutputArtifactError);
  });

  it("rejects an oversized canonical raw result instead of truncating findings", () => {
    const f = fixture();
    Object.assign(f.result, {
      findings: Array.from({ length: 100 }, (_, index) => ({
        findingId: `finding-${index}`,
        priority: 1,
        title: "Finding",
        body: "\u754c".repeat(8192),
        path: "src/file.ts",
        line: 1,
        endLine: null,
        confidence: 1,
      })),
    });
    const canonical = createCanonicalResult(f.result);
    f.output.canonicalResultJson = canonical.json;
    f.output.resultDigest = canonical.sha256;
    expect(Buffer.byteLength(canonical.json, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });

  it.each(["result", "modelInvocation"])(
    "rejects source %s getters without invoking them",
    (key) => {
      const f = fixture();
      const getter = vi.fn(() => {
        throw new Error("private metadata");
      });
      Object.defineProperty(f.output, key, { enumerable: true, get: getter });
      expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("rejects Proxy metadata without invoking traps", () => {
    const f = fixture();
    const get = vi.fn(() => {
      throw new Error("private proxy");
    });
    const source = new Proxy(f.input, { get, getPrototypeOf: get });
    expect(() => createModelOutputArtifact(source)).toThrow(ModelOutputArtifactError);
    expect(get).not.toHaveBeenCalled();
  });
});
