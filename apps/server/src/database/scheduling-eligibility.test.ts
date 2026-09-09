import {
  type JobExecutionTemplate,
  maximumClaimLeaseResponseUtf8Bytes,
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  capabilityAtPath,
  evaluateJobWorkerCapabilities,
  parseExecutionTemplate,
  prepareClaimExecutionEnvelope,
  type SchedulingClaimAssignment,
  type SchedulingClaimCandidate,
  satisfiesRequirement,
} from "./scheduling-eligibility.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const template: JobExecutionTemplate = {
  repository: { githubRepositoryId: 42, fullName: "example/review-fixture" },
  resource: {
    kind: "pull_request",
    githubNodeId: "PR_scheduling_fixture",
    number: 7,
    title: "A deterministic scheduling fixture",
    author: { githubUserId: 9, login: "fixture-author" },
    canonicalSnapshot: {},
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    isDraft: false,
  },
  prompt: {
    name: "review",
    version: "fixture",
    renderedPrompt: "Review the selected source.",
    promptSha256: "a".repeat(64),
    outputSchema: {},
    outputSchemaSha256: "b".repeat(64),
  },
  executionPolicy: {
    hardTimeoutMs: 600_000,
    noProgressTimeoutMs: 120_000,
    allowedRecipeIds: [],
    requiredCapabilityLabels: {},
  },
};

const candidate: SchedulingClaimCandidate = {
  id: "job-scheduling-fixture",
  job_kind: "pull_request_review",
  generation: 1,
  intent_version: 1,
  semantic_key: "scheduling-fixture",
  priority: 50,
  attempt_count: 0,
  max_attempts: 3,
};
const assignment: SchedulingClaimAssignment = {
  protocolVersion: "1.0",
  assignedAt: "2026-09-07T00:00:00.000Z",
  leaseExpiresAt: "2026-09-07T00:02:00.000Z",
  executionDeadlineAt: "2026-09-07T00:10:00.000Z",
  workerNodeId: "00000000-0000-4000-8000-000000000001",
  workerInstanceId: "00000000-0000-4000-8000-000000000002",
  runAttemptId: "00000000-0000-4000-8000-000000000003",
  leaseToken: "x".repeat(43),
  leaseGeneration: 1,
};

describe("shared scheduling eligibility", () => {
  it("rejects Legacy model work for a Worker that explicitly disables model execution", () => {
    const capabilities = Object.freeze({
      labels: Object.freeze({
        [workerModelExecutionDisabledLabel]: workerModelExecutionDisabledValue,
      }),
    });
    const before = JSON.stringify(template);
    expect(evaluateJobWorkerCapabilities(template, [], capabilities)).toBe(false);
    expect(evaluateJobWorkerCapabilities(template, [], { labels: {} })).toBe(true);
    expect(JSON.stringify(template)).toBe(before);
    expect(capabilities.labels[workerModelExecutionDisabledLabel]).toBe(
      workerModelExecutionDisabledValue,
    );
  });

  it("parses an ordinary Legacy template without requiring prepared V2 runtime labels", () => {
    const result = parseExecutionTemplate(JSON.stringify(template));
    expect(result).toEqual({ ok: true, template });
    expect(evaluateJobWorkerCapabilities(template, [], { labels: {} })).toBe(true);
  });

  it("distinguishes malformed stored JSON from a well-formed invalid template", () => {
    expect(parseExecutionTemplate("{")).toEqual({
      ok: false,
      message: "Stored execution_json is not valid JSON.",
    });
    expect(parseExecutionTemplate("{}")).toEqual({
      ok: false,
      message: "Stored execution_json does not match JobExecutionTemplateSchema.",
    });
  });

  it.each([
    [{ runtime: { available: true } }, ["runtime.available"], true],
    [{ runtime: { available: false } }, ["runtime.available"], false],
    [{ labels: { compiler: "1" } }, ["compiler"], true],
    [{ labels: { compiler: "2" } }, ["compiler"], false],
    [{ recipeIds: ["compile"] }, ["compile"], true],
    [{ recipeIds: ["compile"] }, ["compile", "test"], false],
    [{ labels: { compiler: "1" }, recipeIds: ["test"] }, ["compiler", "test"], true],
    [{ runtime: { versions: ["8", "9"] } }, { runtime: { versions: "9" } }, true],
    [{ runtime: { versions: ["8", "9"] } }, { runtime: { versions: "10" } }, false],
    [null, { runtime: true }, false],
    [{ labels: { compiler: "1" } }, ["compiler", 1], false],
  ])("retains the existing requirement match for %j and %j", (actual, required, expected) => {
    expect(satisfiesRequirement(actual, required)).toBe(expected);
    expect(evaluateJobWorkerCapabilities(template, required, actual)).toBe(expected);
  });

  it("does not traverse arrays as named capability paths", () => {
    expect(capabilityAtPath({ labels: ["compiler"] }, "labels.0")).toBeUndefined();
    expect(capabilityAtPath({ labels: { compiler: "1" } }, "labels.compiler")).toBe("1");
  });

  it("never mutates a template or worker capability snapshot while checking compatibility", () => {
    const storedTemplate = JSON.stringify(template);
    const capabilities = Object.freeze({ labels: Object.freeze({ compiler: "1" }) });
    expect(evaluateJobWorkerCapabilities(template, ["compiler"], capabilities)).toBe(true);
    expect(JSON.stringify(template)).toBe(storedTemplate);
    expect(capabilities).toEqual({ labels: { compiler: "1" } });
  });

  it("projects the exact supplied claim identity and next attempt without allocating a lease", () => {
    const result = prepareClaimExecutionEnvelope(template, candidate, assignment);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.envelope.lease).toEqual({
      jobId: candidate.id,
      runAttemptId: assignment.runAttemptId,
      workerNodeId: assignment.workerNodeId,
      workerInstanceId: assignment.workerInstanceId,
      leaseToken: assignment.leaseToken,
      leaseGeneration: 1,
    });
    expect(result.envelope.job).toMatchObject({ jobId: candidate.id, attempt: 1, maxAttempts: 3 });
    expect(candidate.attempt_count).toBe(0);
  });

  it("rejects invalid stored Job metadata at the same final envelope gate", () => {
    expect(
      prepareClaimExecutionEnvelope(template, { ...candidate, priority: 0.5 }, assignment),
    ).toMatchObject({
      ok: false,
      code: "invalid_execution_envelope",
    });
  });

  it("measures the actual response instead of treating raw JSON whitespace as an oversized claim", () => {
    const parsed = parseExecutionTemplate(
      " ".repeat(maximumClaimLeaseResponseUtf8Bytes) + JSON.stringify(template),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(prepareClaimExecutionEnvelope(parsed.template, candidate, assignment).ok).toBe(true);
  });

  it("rejects an actual oversized response after envelope schema validation", () => {
    const large = {
      ...template,
      prompt: {
        ...template.prompt,
        outputSchema: { description: "x".repeat(maximumClaimLeaseResponseUtf8Bytes) },
      },
    };
    const result = prepareClaimExecutionEnvelope(large, candidate, assignment);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("An oversized response was accepted.");
    expect(result.code).toBe("claim_response_too_large");
  });
});
