import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ClaimLeaseGrantedSchema,
  ClaimLeaseResponseSchema,
  type JobExecutionEnvelope,
  JobExecutionEnvelopeSchema,
} from "./job-envelope.js";
import { type JobExecutionEnvelopeV2, JobExecutionEnvelopeV2Schema } from "./job-envelope-v2.js";

FormatRegistry.Set("date-time", (value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});

describe("dormant JobExecutionEnvelopeV2", () => {
  it("requires the exact result-artifact completion mode", () => {
    const envelope = envelopeV2();
    expect(Value.Check(JobExecutionEnvelopeV2Schema, envelope)).toBe(true);
    expectTypeOf(envelope).toEqualTypeOf<JobExecutionEnvelopeV2>();
    expectTypeOf(envelope.envelopeVersion).toEqualTypeOf<2>();
    expectTypeOf(envelope.completionMode).toEqualTypeOf<"result_artifact_v1">();

    const { completionMode: _removed, ...missingMode } = envelope;
    for (const candidate of [
      missingMode,
      { ...envelope, completionMode: "inline_result_v1" },
      { ...envelope, completionMode: "RESULT_ARTIFACT_V1" },
      { ...envelope, completionMode: null },
      { ...envelope, completionMode: "result_artifact_v2" },
    ]) {
      expect(Value.Check(JobExecutionEnvelopeV2Schema, candidate)).toBe(false);
    }
  });

  it("clones inherited schema nodes instead of sharing mutable v1 definitions", () => {
    const versionOneProperties = (
      JobExecutionEnvelopeSchema as unknown as {
        readonly properties: Readonly<Record<string, unknown>>;
      }
    ).properties;
    const versionTwoProperties = (
      JobExecutionEnvelopeV2Schema as unknown as {
        readonly properties: Readonly<Record<string, unknown>>;
      }
    ).properties;
    for (const [name, versionOneProperty] of Object.entries(versionOneProperties)) {
      if (name === "envelopeVersion") continue;
      expectRecursivelyDetached(versionTwoProperties[name], versionOneProperty);
    }
  });

  it("freezes v2 deeply and remains isolated from reversible v1 mutation", () => {
    const versionOneSemanticKey = nestedSemanticKey(JobExecutionEnvelopeSchema);
    const versionTwoSemanticKey = nestedSemanticKey(JobExecutionEnvelopeV2Schema);
    const originalMaximum = versionOneSemanticKey.maxLength;
    try {
      expect(Reflect.set(versionOneSemanticKey, "maxLength", 999)).toBe(true);
      expect(versionTwoSemanticKey.maxLength).toBe(originalMaximum);
    } finally {
      Reflect.set(versionOneSemanticKey, "maxLength", originalMaximum);
    }
    expect(Object.isFrozen(versionTwoSemanticKey)).toBe(true);
    expect(Reflect.set(versionTwoSemanticKey, "maxLength", 1)).toBe(false);
    expect(versionOneSemanticKey.maxLength).toBe(originalMaximum);
  });

  it("rejects version drift, widening, and invalid inherited fields", () => {
    const envelope = envelopeV2();
    for (const candidate of [
      { ...envelope, envelopeVersion: 1 },
      { ...envelope, envelopeVersion: 3 },
      { ...envelope, envelopeVersion: "2" },
      { ...envelope, protocolVersion: "2.0" },
      { ...envelope, unexpected: true },
      { ...envelope, lease: { ...envelope.lease, leaseToken: "short" } },
      { ...envelope, job: { ...envelope.job, attempt: 0 } },
      {
        ...envelope,
        prompt: { ...envelope.prompt, promptSha256: envelope.prompt.promptSha256.toUpperCase() },
      },
      { ...envelope, prompt: { ...envelope.prompt, promptSha256: null } },
    ]) {
      expect(Value.Check(JobExecutionEnvelopeV2Schema, candidate)).toBe(false);
    }
  });

  it("keeps version-one envelopes and Claim responses mutually exclusive", () => {
    const versionOne = envelopeV1();
    const versionTwo = envelopeV2();

    expect(Value.Check(JobExecutionEnvelopeSchema, versionOne)).toBe(true);
    expect(Value.Check(JobExecutionEnvelopeSchema, versionTwo)).toBe(false);
    expect(Value.Check(JobExecutionEnvelopeV2Schema, versionOne)).toBe(false);

    const validClaim = {
      outcome: "granted",
      serverTime: "2026-09-03T00:00:00.000Z",
      envelope: versionOne,
    };
    expect(Value.Check(ClaimLeaseGrantedSchema, validClaim)).toBe(true);
    expect(Value.Check(ClaimLeaseResponseSchema, validClaim)).toBe(true);
    expect(validClaim.envelope).not.toHaveProperty("completionMode");

    const dormantClaim = { ...validClaim, envelope: versionTwo };
    expect(Value.Check(ClaimLeaseGrantedSchema, dormantClaim)).toBe(false);
    expect(Value.Check(ClaimLeaseResponseSchema, dormantClaim)).toBe(false);
  });
});

function envelopeV1(): JobExecutionEnvelope {
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-09-03T00:00:00.000Z",
    leaseExpiresAt: "2026-09-03T00:01:00.000Z",
    executionDeadlineAt: "2026-09-03T00:30:00.000Z",
    lease: {
      jobId: "job:1",
      runAttemptId: "run:1",
      workerNodeId: "worker:node",
      workerInstanceId: "worker:instance",
      leaseToken: "l".repeat(32),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job:1",
      kind: "pull_request_review",
      priority: 10,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "repo/pr/1/head",
    },
    repository: {
      githubRepositoryId: 184_456_251,
      fullName: "microsoft/PowerToys",
    },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_node_1",
      number: 1,
      title: "Review change",
      author: {
        githubUserId: 42,
        login: "contributor",
        accountType: "user",
        githubNodeId: "USER_node_42",
      },
      canonicalSnapshot: { body: "review me" },
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "pull-request-review",
      version: "1",
      renderedPrompt: "Review this change.",
      promptSha256: "c".repeat(64),
      outputSchema: { type: "object" },
      outputSchemaSha256: "d".repeat(64),
    },
    executionPolicy: {
      hardTimeoutMs: 1_800_000,
      noProgressTimeoutMs: 300_000,
      maxCodexTurns: 8,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function envelopeV2(): JobExecutionEnvelopeV2 {
  return {
    ...envelopeV1(),
    envelopeVersion: 2,
    completionMode: "result_artifact_v1",
  };
}

function nestedSemanticKey(schema: unknown): Record<string, unknown> {
  const root = schema as {
    readonly properties: {
      readonly job: {
        readonly properties: { readonly semanticKey: Record<string, unknown> };
      };
    };
  };
  return root.properties.job.properties.semanticKey;
}

function expectRecursivelyDetached(left: unknown, right: unknown): void {
  expect(left).toEqual(right);
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return;
  }
  expect(left).not.toBe(right);
  for (const key of Reflect.ownKeys(right)) {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    if (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      Object.hasOwn(leftDescriptor, "value") &&
      Object.hasOwn(rightDescriptor, "value")
    ) {
      expectRecursivelyDetached(leftDescriptor.value, rightDescriptor.value);
    }
  }
}
