import { createHash } from "node:crypto";
import { FormatRegistry, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ClaimLeaseResponseSchema,
  JobExecutionEnvelopeSchema,
  JobExecutionEnvelopeV1Schema,
  JobExecutionEnvelopeV2Schema,
  JobExecutionTemplateSchema,
  JobExecutionTemplateV1Schema,
  JobExecutionTemplateV2Schema,
} from "./job-envelope.js";
import { type ValidationJobContext, ValidationJobContextSchema } from "./validation-job.js";

const now = "2026-09-07T00:00:00.000Z";
const existingDateTimeFormat = FormatRegistry.Get("date-time");

beforeAll(() => {
  if (existingDateTimeFormat === undefined) {
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  }
});

afterAll(() => {
  if (existingDateTimeFormat === undefined) FormatRegistry.Delete("date-time");
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function validationContext(): ValidationJobContext {
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [],
    build: [
      {
        id: "build",
        name: "Compile the submitted revision",
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
    schemaVersion: "ValidationJobContextV1",
    runId: "review-run-1",
    planDigest: "a".repeat(64),
    activationId: "run-activation-1",
    requestId: "static-build",
    jobActivation: 1,
    repositoryId: "repository-1",
    workItemId: "work-item-1",
    revisionKey: hash(`${"1".repeat(40)}\0${"2".repeat(40)}`),
    requestEpochId: "epoch-1",
    workflowKind: "pr_static_build",
    target: "headless",
    required: true,
    profileVersion: {
      id: "profile-version-1",
      profileId: "profile-1",
      repositoryId: "repository-1",
      version: 1,
      name: "Static build",
      workflowKind: "pr_static_build",
      target: "headless",
      config,
      configSha256: hash(canonicalJson(config)),
      required: true,
      outputSchemaVersion: "PrReviewPlanV2",
      createdAt: now,
      publishedAt: now,
      createdBy: "operator",
    },
    promptVersion: {
      id: "prompt-version-1",
      templateId: "prompt-template-1",
      version: 1,
      contentSha256: hash("Review this pull request."),
    },
    requiredCheckIds: ["profile-version-1:build"],
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    testedSourceAuthorization: null,
  };
}

function legacyTemplate(): Static<typeof JobExecutionTemplateV1Schema> {
  return {
    repository: { githubRepositoryId: 1, fullName: "org/repository" },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_1",
      number: 1,
      title: "Validate the submitted code",
      author: { githubUserId: 10, login: "contributor" },
      canonicalSnapshot: {},
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "pull-request-review",
      version: "1",
      renderedPrompt: "Review this pull request.",
      promptSha256: hash("Review this pull request."),
      outputSchema: {},
      outputSchemaSha256: hash("{}"),
    },
    executionPolicy: {
      hardTimeoutMs: 120_000,
      noProgressTimeoutMs: 60_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function legacyEnvelope(): Static<typeof JobExecutionEnvelopeV1Schema> {
  return {
    ...legacyTemplate(),
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: now,
    leaseExpiresAt: "2026-09-07T00:01:00.000Z",
    executionDeadlineAt: "2026-09-07T00:02:00.000Z",
    lease: {
      jobId: "job-1",
      runAttemptId: "attempt-1",
      workerNodeId: "worker-1",
      workerInstanceId: "worker-instance-1",
      leaseToken: "t".repeat(64),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job-1",
      kind: "pull_request_review",
      priority: 100,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "run:review-run-1:static-build:activation:1",
    },
  };
}

describe("versioned validation execution contracts", () => {
  it("preserves a strict legacy template and envelope without validation context", () => {
    expect(Value.Check(JobExecutionTemplateV1Schema, legacyTemplate())).toBe(true);
    expect(Value.Check(JobExecutionTemplateSchema, legacyTemplate())).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeV1Schema, legacyEnvelope())).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeSchema, legacyEnvelope())).toBe(true);
    expect(
      Value.Check(JobExecutionTemplateV1Schema, {
        ...legacyTemplate(),
        validation: validationContext(),
      }),
    ).toBe(false);
    expect(
      Value.Check(JobExecutionEnvelopeSchema, {
        ...legacyEnvelope(),
        validation: validationContext(),
      }),
    ).toBe(false);
  });

  it("accepts a v2 envelope with one frozen profile and its exact execution identity", () => {
    const validation = validationContext();
    const template = { ...legacyTemplate(), validation };
    const envelope = { ...legacyEnvelope(), envelopeVersion: 2, validation };

    expect(Value.Check(ValidationJobContextSchema, validation)).toBe(true);
    expect(Value.Check(JobExecutionTemplateV2Schema, template)).toBe(true);
    expect(Value.Check(JobExecutionTemplateSchema, template)).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeV1Schema, envelope)).toBe(false);
    expect(
      Value.Check(ClaimLeaseResponseSchema, { outcome: "granted", serverTime: now, envelope }),
    ).toBe(true);
  });

  it.each([undefined, null, {}, []])("rejects absent or malformed v2 context: %s", (validation) => {
    const template = { ...legacyTemplate(), validation };
    const envelope = { ...legacyEnvelope(), envelopeVersion: 2, validation };
    if (validation === undefined) {
      Reflect.deleteProperty(template, "validation");
      Reflect.deleteProperty(envelope, "validation");
    }
    expect(Value.Check(JobExecutionTemplateV2Schema, template)).toBe(false);
    expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(false);
    expect(Value.Check(JobExecutionEnvelopeSchema, envelope)).toBe(false);
  });

  it.each(Object.keys(validationContext()))("requires context field %s", (field) => {
    const validation = { ...validationContext() };
    Reflect.deleteProperty(validation, field);
    expect(Value.Check(ValidationJobContextSchema, validation)).toBe(false);
    expect(
      Value.Check(JobExecutionEnvelopeSchema, {
        ...legacyEnvelope(),
        envelopeVersion: 2,
        validation,
      }),
    ).toBe(false);
  });

  it.each([0, 3, "2"])("rejects unsupported envelope version %s", (envelopeVersion) => {
    expect(
      Value.Check(JobExecutionEnvelopeSchema, {
        ...legacyEnvelope(),
        envelopeVersion,
        validation: validationContext(),
      }),
    ).toBe(false);
  });

  it("rejects a whole plan or multiple profiles in the per-job context", () => {
    const validation = validationContext();
    for (const candidate of [
      { ...validation, plan: { jobs: [] } },
      { ...validation, profiles: [validation.profileVersion] },
      { ...validation, profileVersion: [validation.profileVersion] },
      { ...validation, additionalWriteRoots: ["C:/shared"] },
    ]) {
      expect(Value.Check(ValidationJobContextSchema, candidate)).toBe(false);
    }
  });

  it.each([
    { planDigest: "a".repeat(63) },
    { jobActivation: 0 },
    { revisionKey: "latest" },
    { requiredCheckIds: ["build"] },
    { requiredCheckIds: ["profile-version-1:build", "profile-version-1:build"] },
    { testedSourceRevision: { kind: "commit", headSha: "main" } },
    { profileVersion: null },
  ])("rejects incomplete execution identity %#", (override) => {
    expect(Value.Check(ValidationJobContextSchema, { ...validationContext(), ...override })).toBe(
      false,
    );
  });
});
