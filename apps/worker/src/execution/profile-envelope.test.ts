import { createHash } from "node:crypto";
import { createCanonicalResult, IssueTriageV2ModelOutputSchema } from "@agentic-review/codex";
import {
  getEvaluationValidationJobContextIssues,
  JobExecutionEnvelopeV2Schema,
  type ValidationTarget,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import type { ModelArtifactEvaluationEnvelope } from "./model-output-artifact.testing.js";
import { validateProfileEnvelope } from "./profile-envelope.js";
import {
  evaluationProfileEnvelopeFixture,
  mappedEvaluationProfileFixture,
  ordinaryProfileEnvelopeFixture,
  refreshEvaluationIssueRevision,
  refreshEvaluationProfileFixture,
} from "./profile-envelope.testing.js";

registerWorkerContractFormats();

type Evaluation = ModelArtifactEvaluationEnvelope;
type Mutation = (envelope: Evaluation) => void;
const mutations: readonly [string, Mutation][] = [
  [
    "outer repository name",
    (e) => {
      e.repository.fullName = "another/repository";
    },
  ],
  [
    "outer repository id",
    (e) => {
      e.repository.githubRepositoryId += 1;
    },
  ],
  [
    "outer work item title",
    (e) => {
      e.resource.title = "Another title";
    },
  ],
  [
    "outer work item author",
    (e) => {
      e.resource.author = { ...e.resource.author, login: "another" };
    },
  ],
  [
    "outer canonical snapshot",
    (e) => {
      e.resource.canonicalSnapshot = { ...e.validation.source.workItem, body: "Another body" };
    },
  ],
  [
    "lease job id",
    (e) => {
      e.lease.jobId = "another-job";
    },
  ],
  [
    "job kind",
    (e) => {
      e.job.kind = "issue_triage";
    },
  ],
  [
    "context repository id",
    (e) => {
      e.validation.repositoryId = "another-repository";
    },
  ],
  [
    "context work item id",
    (e) => {
      e.validation.workItemId = "another-item";
    },
  ],
  [
    "authorization id",
    (e) => {
      e.validation.authorization.id = "another-authorization";
    },
  ],
  [
    "authorization repository",
    (e) => {
      e.validation.authorization.repositoryId = "another-repository";
    },
  ],
  [
    "authorization evaluation",
    (e) => {
      e.validation.authorization.evaluationId = "another-evaluation";
    },
  ],
  [
    "authorization source time",
    (e) => {
      e.validation.authorization.authorizedAt = "2026-09-07T00:00:00.000Z";
    },
  ],
  [
    "execution manifest",
    (e) => {
      e.validation.purpose.executionManifestSha256 = "f".repeat(64);
    },
  ],
  [
    "source digest",
    (e) => {
      e.validation.source.sourceDigest = "f".repeat(64);
    },
  ],
  [
    "source item content",
    (e) => {
      e.validation.source.workItem.body = "Changed frozen content";
    },
  ],
  [
    "source revision id",
    (e) => {
      e.validation.source.revisionId = "another-revision";
    },
  ],
  [
    "source revision key",
    (e) => {
      e.validation.source.revision.revisionKey = "f".repeat(64);
      refreshEvaluationProfileFixture(e);
    },
  ],
  [
    "profile repository",
    (e) => {
      e.validation.profileVersion.repositoryId = "another-repository";
    },
  ],
  [
    "profile digest",
    (e) => {
      e.validation.profileVersion.configSha256 = "f".repeat(64);
    },
  ],
  [
    "profile output schema version",
    (e) => {
      e.validation.profileVersion.outputSchemaVersion = "IssueTriageV2";
    },
  ],
  [
    "profile timeout",
    (e) => {
      e.validation.profileVersion.config.hardTimeoutMs += 1_000;
      refreshEvaluationProfileFixture(e);
    },
  ],
  [
    "required check omission",
    (e) => {
      e.validation.requiredCheckIds = [];
    },
  ],
  [
    "required check addition",
    (e) => {
      e.validation.requiredCheckIds.push("profile-version-a:extra");
    },
  ],
  [
    "prompt template",
    (e) => {
      e.prompt.name = "another-template";
    },
  ],
  [
    "prompt version",
    (e) => {
      e.prompt.version = "2";
    },
  ],
  [
    "prompt bytes",
    (e) => {
      e.prompt.renderedPrompt += " changed";
    },
  ],
  [
    "prompt digest",
    (e) => {
      e.prompt.promptSha256 = "f".repeat(64);
    },
  ],
  [
    "workflow output schema",
    (e) => {
      e.prompt.outputSchema = JSON.parse(JSON.stringify(IssueTriageV2ModelOutputSchema));
      e.prompt.outputSchemaSha256 = createCanonicalResult(e.prompt.outputSchema).sha256;
    },
  ],
  [
    "recipe permission",
    (e) => {
      e.executionPolicy.allowedRecipeIds.push("unexpected-recipe");
    },
  ],
  [
    "evaluation protocol",
    (e) => {
      delete e.executionPolicy.requiredCapabilityLabels.validationEvaluation;
    },
  ],
  [
    "evaluation protocol version",
    (e) => {
      e.executionPolicy.requiredCapabilityLabels.validationEvaluation = "2";
    },
  ],
  [
    "envelope protocol",
    (e) => {
      delete e.executionPolicy.requiredCapabilityLabels.executionEnvelope;
    },
  ],
  [
    "headless protocol",
    (e) => {
      delete e.executionPolicy.requiredCapabilityLabels.validationHeadless;
    },
  ],
  [
    "static review without model",
    (e) => {
      e.validation.modelRequirements.required = false;
    },
  ],
  [
    "registration omission",
    (e) => {
      delete e.validation.modelRuntimeRegistration;
    },
  ],
  [
    "registration identity",
    (e) => {
      const registration = e.validation.modelRuntimeRegistration;
      if (!registration) throw new Error("Synthetic registration missing.");
      registration.identity.modelId = "another-model";
    },
  ],
  [
    "registration digest",
    (e) => {
      const reference = e.validation.modelRequirements.runtimeRegistration;
      if (!reference) throw new Error("Synthetic reference missing.");
      reference.registrationSha256 = "f".repeat(64);
    },
  ],
  [
    "expected model identity",
    (e) => {
      e.validation.modelRequirements.expectedModelIdentityDigest = "f".repeat(64);
    },
  ],
];

describe("frozen evaluation profile envelopes", () => {
  it.each([
    ["pr_static_build", "headless"],
    ["issue_triage", "headless"],
    ["issue_validation", "headless"],
    ["pr_ui", "web"],
    ["pr_ui", "windows_desktop"],
    ["issue_validation", "web"],
    ["issue_validation", "windows_desktop"],
  ] satisfies [WorkflowKind, ValidationTarget][])(
    "accepts frozen %s data for %s without granting execution",
    (workflow, target) => {
      const envelope = evaluationProfileEnvelopeFixture(workflow, target);
      expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(true);
      expect(getEvaluationValidationJobContextIssues(envelope.validation)).toEqual([]);
      expect(envelope.validation.testedSourceAuthorization).toBeNull();
      const before = createCanonicalResult(envelope);
      expect(() => validateProfileEnvelope(envelope)).not.toThrow();
      expect(createCanonicalResult(envelope)).toEqual(before);
    },
  );

  it.each(["pr_ui", "issue_validation"] as const)(
    "accepts a profile-only %s without inventing a model registration",
    (workflow) => {
      const envelope = evaluationProfileEnvelopeFixture(
        workflow,
        workflow === "pr_ui" ? "web" : "headless",
        false,
      );
      expect(envelope.validation.modelRuntimeRegistration).toBeUndefined();
      expect(() => validateProfileEnvelope(envelope)).not.toThrow();
    },
  );

  it("keeps unresolved model identity as structurally valid data for the separate readiness gate", () => {
    const envelope = evaluationProfileEnvelopeFixture();
    envelope.validation.modelRequirements = { required: true, expectedModelIdentityDigest: null };
    delete envelope.validation.modelRuntimeRegistration;
    expect(() => validateProfileEnvelope(envelope)).not.toThrow();
    expect(envelope.validation.modelRequirements.expectedModelIdentityDigest).toBeNull();
  });

  it.each(mutations)("rejects changed %s", (_name, mutate) => {
    const envelope = evaluationProfileEnvelopeFixture();
    mutate(envelope);
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it.each(["source", "authorization", "purpose", "modelRequirements"])(
    "rejects incomplete evaluation context missing %s",
    (field) => {
      const envelope = evaluationProfileEnvelopeFixture();
      Reflect.deleteProperty(envelope.validation, field);
      expect(() => validateProfileEnvelope(envelope)).toThrow();
    },
  );

  it("rejects a recomputed Issue source digest that hides a stale content digest", () => {
    const envelope = evaluationProfileEnvelopeFixture("issue_validation");
    envelope.validation.source.workItem.body = "Changed Issue content";
    refreshEvaluationProfileFixture(envelope);
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("rejects an Issue commit outside the exact frozen Git object identity", () => {
    const envelope = evaluationProfileEnvelopeFixture("issue_validation");
    const source = { kind: "commit" as const, headSha: "b".repeat(40) + "\n" };
    envelope.validation.testedSourceRevision = source;
    envelope.validation.source.testedSourceRevision = source;
    refreshEvaluationProfileFixture(envelope);
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("rejects a changed selected Issue commit in the outer context", () => {
    const envelope = evaluationProfileEnvelopeFixture("issue_validation");
    envelope.validation.testedSourceRevision = { kind: "commit", headSha: "c".repeat(40) };
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("accepts complete Unicode Issue content without normalizing its bytes", () => {
    const envelope = evaluationProfileEnvelopeFixture("issue_validation");
    envelope.validation.source.workItem.body = "Unicode fixture: \u754c\ud83d\ude80e\u0301\r\n";
    refreshEvaluationIssueRevision(envelope);
    const before = createCanonicalResult(envelope);
    expect(() => validateProfileEnvelope(envelope)).not.toThrow();
    expect(createCanonicalResult(envelope)).toEqual(before);
  });

  it("rejects malformed Unicode even when its Prompt digest was recomputed", () => {
    const envelope = evaluationProfileEnvelopeFixture();
    envelope.prompt.renderedPrompt = "Malformed \ud800";
    envelope.prompt.promptSha256 = createHash("sha256")
      .update(envelope.prompt.renderedPrompt)
      .digest("hex");
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("requires structured-probe capability for a declared probe", () => {
    const envelope = evaluationProfileEnvelopeFixture("issue_validation");
    const step = envelope.validation.profileVersion.config.test[0];
    if (!step) throw new Error("Synthetic step missing.");
    step.probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: [{ id: "observed", description: "Synthetic observation", type: "boolean" }],
    };
    refreshEvaluationProfileFixture(envelope);
    expect(() => validateProfileEnvelope(envelope)).not.toThrow();
    delete envelope.executionPolicy.requiredCapabilityLabels.structuredProbeOutput;
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it.each(["validationWeb", "uiAssertionObservation"])(
    "requires the applicable Web protocol %s",
    (label) => {
      const envelope = evaluationProfileEnvelopeFixture("pr_ui");
      delete envelope.executionPolicy.requiredCapabilityLabels[label];
      expect(() => validateProfileEnvelope(envelope)).toThrow();
    },
  );

  it("requires the Windows target protocol without substituting another UI target", () => {
    const envelope = evaluationProfileEnvelopeFixture("pr_ui", "windows_desktop");
    delete envelope.executionPolicy.requiredCapabilityLabels.validationWindowsDesktop;
    envelope.executionPolicy.requiredCapabilityLabels.validationWeb = "1";
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("preserves additional deployment labels without treating them as protocol support", () => {
    const envelope = evaluationProfileEnvelopeFixture();
    envelope.executionPolicy.requiredCapabilityLabels.site = "synthetic-site";
    expect(() => validateProfileEnvelope(envelope)).not.toThrow();
    delete envelope.executionPolicy.requiredCapabilityLabels.validationEvaluation;
    envelope.executionPolicy.requiredCapabilityLabels.VALIDATIONEVALUATION = "1";
    expect(() => validateProfileEnvelope(envelope)).toThrow();
  });

  it("validates mapped evaluation reproduction using its independent source authorization", () => {
    const envelope = mappedEvaluationProfileFixture();
    expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(true);
    expect(getEvaluationValidationJobContextIssues(envelope.validation)).toEqual([]);
    expect(envelope.validation.testedSourceAuthorization).toBeNull();
    expect(() => validateProfileEnvelope(envelope)).not.toThrow();
  });
  it.each(["actor", "request", "commit"] as const)(
    "rejects rehashed evaluation reproduction with a changed %s",
    (field) => {
      const envelope = mappedEvaluationProfileFixture();
      const frozen = envelope.validation.reproduction;
      if (frozen === undefined) throw new Error("Synthetic binding missing.");
      if (field === "actor") frozen.binding.authorizedBy.subject = "another-operator";
      else if (field === "request") frozen.binding.cases[0]!.requestId = "another-request";
      else frozen.binding.testedSourceCommit = "c".repeat(40);
      frozen.bindingDigest = createCanonicalResult(frozen.binding).sha256;
      expect(() => validateProfileEnvelope(envelope)).toThrow();
    },
  );
});

describe("ordinary profile authorization compatibility", () => {
  it.each(["pr_static_build", "issue_triage", "issue_validation"] as const)(
    "retains ordinary %s validation",
    (workflow) => {
      expect(() => validateProfileEnvelope(ordinaryProfileEnvelopeFixture(workflow))).not.toThrow();
    },
  );

  it("still requires the ordinary Issue source authorization", () => {
    const envelope = ordinaryProfileEnvelopeFixture();
    envelope.validation.testedSourceAuthorization = null;
    expect(() => validateProfileEnvelope(envelope)).toThrow("Issue source authorization mismatch");
  });

  it.each(["headSha", "activationId", "issueRevisionKey"] as const)(
    "rejects ordinary Issue authorization with changed %s",
    (field) => {
      const envelope = ordinaryProfileEnvelopeFixture();
      const authorization = envelope.validation.testedSourceAuthorization;
      if (!authorization) throw new Error("Synthetic source authorization missing.");
      authorization[field] = field === "activationId" ? "another-activation" : "d".repeat(64);
      expect(() => validateProfileEnvelope(envelope)).toThrow(
        "Issue source authorization mismatch",
      );
    },
  );
});
