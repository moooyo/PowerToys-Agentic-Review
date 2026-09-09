import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  getEvaluationValidationJobContextIssues,
  JobExecutionEnvelopeV2Schema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  assertModelOutputArtifact,
  createModelOutputArtifact,
  ModelOutputArtifactError,
  modelOutputReview,
} from "./model-output-artifact.js";
import {
  modelArtifactEvaluationFixture,
  refreshModelArtifactSourceDigest,
} from "./model-output-artifact.testing.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function fixture(kind: "pull_request" | "issue" = "pull_request") {
  const data = modelArtifactEvaluationFixture(kind);
  const input = {
    output: data.preparedOutput,
    executionEvidence: data.executionEvidence,
    envelope: data.envelope,
    ...(data.summaryInputRef === undefined ? {} : { summaryInputRef: data.summaryInputRef }),
  };
  return { ...data, input };
}

function refreshResult(f: ReturnType<typeof fixture>): void {
  const canonical = createCanonicalResult(f.rawResult);
  f.preparedOutput.canonicalResultJson = canonical.json;
  f.preparedOutput.resultDigest = canonical.sha256;
  Object.assign(f.cliExecution, { modelOutputSha256: canonical.sha256 });
}

describe("CLI model output artifacts", () => {
  it.each(["pull_request", "issue"] as const)(
    "retains a complete frozen %s evaluation fixture",
    (kind) => {
      const f = fixture(kind);
      expect(Value.Check(JobExecutionEnvelopeV2Schema, f.envelope)).toBe(true);
      expect(getEvaluationValidationJobContextIssues(f.envelope.validation)).toEqual([]);
      const original = createCanonicalResult(f.envelope).json;
      const artifact = assertModelOutputArtifact(
        f.artifact,
        f.envelope,
        f.summaryInputRef?.actualPromptSha256,
        f.summaryInputRef?.contextSha256,
      );
      expect(artifact).toEqual(f.artifact);
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(createCanonicalResult(f.envelope).json).toBe(original);
    },
  );

  it("preserves canonical model output and attaches separate Worker observations", () => {
    const f = fixture();
    const artifact = createModelOutputArtifact(f.input);
    expect(artifact.result).toEqual(f.rawResult);
    expect(artifact.canonicalResultJson).toBe(f.resultJson);
    expect(artifact.modelOutputSha256).toBe(f.canonical.sha256);
    expect(artifact.executionEvidence).toEqual(f.executionEvidence);
    expect(artifact.result).not.toHaveProperty("executionEvidence");
    const review = modelOutputReview(artifact);
    expect(Object.keys(review).sort()).toEqual([
      "execution",
      "executionEvidence",
      "result",
      "state",
    ]);
    expect(review.execution).toEqual({
      schemaVersion: "CliModelExecutionV1",
      jobId: f.envelope.job.jobId,
      runAttemptId: f.envelope.lease.runAttemptId,
      cli: { kind: "codex", version: "fixture-version", requestedModel: null },
      promptSha256: f.envelope.prompt.promptSha256,
      outputSchemaSha256: f.envelope.prompt.outputSchemaSha256,
      outputSha256: f.canonical.sha256,
      exitCode: 0,
    });
    f.rawResult.summary = "Changed caller data.";
    const command = f.executionEvidence.commands[0];
    if (command === undefined) throw new Error("Expected the command fixture.");
    command.command = "Changed evidence.";
    Object.assign(f.cliExecution, { requestedModel: "Changed model." });
    expect(artifact.result.summary).toBe("Original model output.");
    expect(artifact.executionEvidence.commands[0]?.command).toBe("git status");
    expect(artifact.execution.cli.requestedModel).toBeNull();
    expect(Object.isFrozen(artifact.result)).toBe(true);
    expect(Object.isFrozen(artifact.execution.cli)).toBe(true);
    expect(Object.isFrozen(artifact.executionEvidence.commands)).toBe(true);
  });

  it("retains the configured Copilot version and requested model with incomplete command capture", () => {
    const f = fixture();
    Object.assign(f.cliExecution, {
      engine: "copilot",
      cliVersion: "copilot-fixture-version",
      requestedModel: "configured-model",
    });
    f.executionEvidence.commandCapture = "incomplete";
    f.executionEvidence.commands = [];
    f.executionEvidence.worktree = { status: "unknown", source: "not_observed" };
    const artifact = createModelOutputArtifact(f.input);
    expect(artifact.execution.cli).toEqual({
      kind: "copilot",
      version: "copilot-fixture-version",
      requestedModel: "configured-model",
    });
    expect(artifact.executionEvidence.commandCapture).toBe("incomplete");
  });

  it.each([
    "result",
    "canonical JSON",
    "result digest",
    "observed output digest",
    "prompt digest",
    "schema digest",
    "engine",
    "CLI version",
    "missing execution",
    "model evidence",
    "worker evidence",
  ])("rejects inconsistent %s without replacing the model output", (part) => {
    const f = fixture();
    if (part === "result") f.rawResult.summary = "Changed.";
    if (part === "canonical JSON") f.preparedOutput.canonicalResultJson = ` ${f.resultJson}`;
    if (part === "result digest") f.preparedOutput.resultDigest = "f".repeat(64);
    if (part === "observed output digest")
      Object.assign(f.cliExecution, { modelOutputSha256: "f".repeat(64) });
    if (part === "prompt digest") Object.assign(f.cliExecution, { promptSha256: "f".repeat(64) });
    if (part === "schema digest")
      Object.assign(f.cliExecution, { outputSchemaSha256: "f".repeat(64) });
    if (part === "engine") Object.assign(f.cliExecution, { engine: "unsupported" });
    if (part === "CLI version") Object.assign(f.cliExecution, { cliVersion: "" });
    if (part === "missing execution") Reflect.deleteProperty(f.preparedOutput, "cliExecution");
    if (part === "model evidence")
      Object.assign(f.rawResult, { executionEvidence: f.executionEvidence });
    if (part === "worker evidence") f.executionEvidence.worktree.source = "not_observed";
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });

  it.each(["jobId", "runAttemptId"] as const)("rejects another task's %s", (field) => {
    const f = fixture();
    const nextEnvelope = structuredClone(f.envelope);
    nextEnvelope.lease[field] = "next-task";
    if (field === "jobId") nextEnvelope.job.jobId = "next-task";
    expect(() => assertModelOutputArtifact(f.artifact, nextEnvelope)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it("keeps identical model text isolated between consecutive jobs", () => {
    const first = fixture();
    const second = fixture();
    second.envelope.job.jobId = "next-job";
    second.envelope.lease.jobId = "next-job";
    second.envelope.lease.runAttemptId = "next-attempt";
    const nextArtifact = createModelOutputArtifact(second.input);
    expect(first.artifact.modelOutputSha256).toBe(nextArtifact.modelOutputSha256);
    expect(() => assertModelOutputArtifact(first.artifact, second.envelope)).toThrow(
      ModelOutputArtifactError,
    );
    expect(() => assertModelOutputArtifact(nextArtifact, first.envelope)).toThrow(
      ModelOutputArtifactError,
    );
    expect(assertModelOutputArtifact(nextArtifact, second.envelope)).toEqual(nextArtifact);
  });

  it.each(["artifact field", "artifact result", "execution digest", "nonzero exit"])(
    "rejects changed persisted %s",
    (part) => {
      const f = fixture();
      const artifact = structuredClone(f.artifact);
      if (part === "artifact field") Object.assign(artifact, { unexpected: true });
      if (part === "artifact result") artifact.result.summary = "Changed.";
      if (part === "execution digest") artifact.execution.outputSha256 = "f".repeat(64);
      if (part === "nonzero exit") Object.assign(artifact.execution, { exitCode: 1 });
      expect(() => assertModelOutputArtifact(artifact, f.envelope)).toThrow(
        ModelOutputArtifactError,
      );
    },
  );

  it("rejects output from a different prompt even when the replacement envelope is internally valid", () => {
    const f = fixture();
    f.envelope.prompt.renderedPrompt = "A different frozen task prompt.";
    f.envelope.prompt.promptSha256 = hash(f.envelope.prompt.renderedPrompt);
    expect(() => assertModelOutputArtifact(f.artifact, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it.each([
    "source digest",
    "source revision",
    "resource",
    "profile config",
    "policy",
    "capability",
    "authorization",
  ])("rejects an inconsistent frozen envelope %s", (part) => {
    const f = fixture();
    const context = f.envelope.validation;
    if (part === "source digest") context.source.workItem.body = "Changed source.";
    if (part === "source revision") {
      context.source.revision.revisionKey = "f".repeat(64);
      context.revisionKey = context.source.revision.revisionKey;
      if (context.source.provenance.kind === "current_work_item")
        context.source.provenance.expectedRevisionKey = context.revisionKey;
      refreshModelArtifactSourceDigest(f.envelope);
    }
    if (part === "resource") f.envelope.resource.title = "Another work item.";
    if (part === "profile config") context.profileVersion.config.hardTimeoutMs += 1;
    if (part === "policy") f.envelope.executionPolicy.allowedRecipeIds = ["unplanned"];
    if (part === "capability")
      Reflect.deleteProperty(
        f.envelope.executionPolicy.requiredCapabilityLabels,
        "validationEvaluation",
      );
    if (part === "authorization") context.authorization.evaluationId = "other-evaluation";
    expect(() => assertModelOutputArtifact(f.artifact, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
  });

  it("requires both the summary's actual prompt and its frozen context", () => {
    const f = fixture("issue");
    const reference = f.summaryInputRef;
    if (reference === undefined) throw new Error("Expected a summary reference.");
    expect(f.artifact.execution.summaryInputRef).toEqual(reference);
    expect(
      assertModelOutputArtifact(
        f.artifact,
        f.envelope,
        reference.actualPromptSha256,
        reference.contextSha256,
      ),
    ).toEqual(f.artifact);
    expect(() => assertModelOutputArtifact(f.artifact, f.envelope)).toThrow(
      ModelOutputArtifactError,
    );
    expect(() =>
      assertModelOutputArtifact(f.artifact, f.envelope, reference.actualPromptSha256),
    ).toThrow(ModelOutputArtifactError);
    expect(() =>
      assertModelOutputArtifact(f.artifact, f.envelope, "f".repeat(64), reference.contextSha256),
    ).toThrow(ModelOutputArtifactError);
    expect(() =>
      assertModelOutputArtifact(
        f.artifact,
        f.envelope,
        reference.actualPromptSha256,
        "f".repeat(64),
      ),
    ).toThrow(ModelOutputArtifactError);
    expect(Object.isFrozen(f.artifact.execution.summaryInputRef)).toBe(true);
  });

  it.each([
    "sourcePromptSha256",
    "outputSchemaSha256",
    "actualPromptSha256",
    "contextSha256",
  ] as const)("rejects a changed summary input %s", (field) => {
    const f = fixture("issue");
    const artifact = structuredClone(f.artifact);
    const reference = artifact.execution.summaryInputRef;
    if (reference === undefined || f.summaryInputRef === undefined)
      throw new Error("Expected a summary reference.");
    reference[field] = "f".repeat(64);
    expect(() =>
      assertModelOutputArtifact(
        artifact,
        f.envelope,
        f.summaryInputRef?.actualPromptSha256,
        f.summaryInputRef?.contextSha256,
      ),
    ).toThrow(ModelOutputArtifactError);
  });

  it("rejects a summary result without its input reference", () => {
    const f = fixture("issue");
    expect(() =>
      createModelOutputArtifact({
        output: f.preparedOutput,
        executionEvidence: f.executionEvidence,
        envelope: f.envelope,
      }),
    ).toThrow(ModelOutputArtifactError);
  });

  it("does not attach summary context to a static review", () => {
    const f = fixture();
    const reference = fixture("issue").summaryInputRef;
    if (reference === undefined) throw new Error("Expected a summary reference.");
    expect(() => createModelOutputArtifact({ ...f.input, summaryInputRef: reference })).toThrow(
      ModelOutputArtifactError,
    );
    expect(() =>
      assertModelOutputArtifact(f.artifact, f.envelope, f.envelope.prompt.promptSha256),
    ).toThrow(ModelOutputArtifactError);
  });

  it("rejects a valid model payload for the wrong workflow", () => {
    const f = fixture();
    const summary = fixture("issue");
    f.preparedOutput.result = summary.rawResult;
    f.preparedOutput.canonicalResultJson = summary.canonical.json;
    f.preparedOutput.resultDigest = summary.canonical.sha256;
    Object.assign(f.cliExecution, { modelOutputSha256: summary.canonical.sha256 });
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });

  it("rejects supplied sensitive model text without retaining a redacted replacement", () => {
    const f = fixture();
    expect(() =>
      createModelOutputArtifact({ ...f.input, sensitiveValues: ["placeholder"] }),
    ).toThrow(ModelOutputArtifactError);
    expect(f.preparedOutput.canonicalResultJson).toBe(f.resultJson);
  });

  it.each(["model result", "Worker evidence"])("rejects the current lease token in %s", (part) => {
    const f = fixture();
    if (part === "model result") {
      f.rawResult.summary = f.envelope.lease.leaseToken;
      refreshResult(f);
    } else {
      const command = f.executionEvidence.commands[0];
      if (command === undefined) throw new Error("Expected a command fixture.");
      command.command = f.envelope.lease.leaseToken;
    }
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });

  it("rejects an oversized model result instead of truncating findings", () => {
    const f = fixture();
    Object.assign(f.rawResult, {
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
    refreshResult(f);
    expect(Buffer.byteLength(f.preparedOutput.canonicalResultJson, "utf8")).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    expect(() => createModelOutputArtifact(f.input)).toThrow(ModelOutputArtifactError);
  });
});
