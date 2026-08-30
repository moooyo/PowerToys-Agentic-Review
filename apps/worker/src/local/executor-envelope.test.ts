import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import {
  createCanonicalJsonDocument,
  digestExecutorJobEnvelope,
  LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES,
  LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES,
  LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
  LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES,
  serializeCanonicalJson,
  sha256Hex,
} from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { LocalExecutionBoundaryError, prepareLocalExecutionStart } from "./executor-envelope.js";

const attemptCorrelationId = "1000000a-0000-4000-8000-000000000001";
const otherAttemptCorrelationId = "2000000b-0000-4000-8000-000000000002";

describe("prepareLocalExecutionStart", () => {
  it("projects an issue envelope and makes optional actor fields explicit", () => {
    const serverEnvelope = createEnvelope("issue_triage");
    const executorEnvelope = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);

    expect(executorEnvelope).toMatchObject({
      envelopeVersion: 1,
      jobId: "job-1",
      runAttemptId: "server-run-attempt-7",
      jobKind: "issue_triage",
      repository: { githubRepositoryId: 184_456_251, fullName: "microsoft/PowerToys" },
      resource: {
        kind: "issue",
        revisionDigest: "c".repeat(64),
        author: {
          githubUserId: 42,
          login: "contributor",
          accountType: null,
          githubNodeId: null,
        },
      },
    });
    const projection = parseProjection(executorEnvelope.resource.canonicalSnapshotJson);
    expect(projection).toMatchObject({
      projectionVersion: 1,
      repository: { githubRepositoryId: 184_456_251, fullName: "microsoft/PowerToys" },
      resource: {
        kind: "issue",
        revision: { kind: "issue", revisionDigest: "c".repeat(64) },
      },
      body: { state: "complete", text: "Issue body" },
    });
    expect(executorEnvelope.resource.canonicalSnapshotSha256).toBe(
      createCanonicalJsonDocument(projection).sha256,
    );
    expect(executorEnvelope.prompt.outputSchemaSha256).toBe(
      createCanonicalJsonDocument(serverEnvelope.prompt.outputSchema).sha256,
    );
    expect(() => digestExecutorJobEnvelope(executorEnvelope)).not.toThrow();
    expect(Object.isFrozen(executorEnvelope)).toBe(true);
    expect(Object.isFrozen(executorEnvelope.resource.author)).toBe(true);
  });

  it.each([40, 64])("preserves pull request Git object IDs with %i hex characters", (length) => {
    const serverEnvelope = createEnvelope("pull_request_review", length);
    const executorEnvelope = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);

    expect(executorEnvelope.jobKind).toBe("pull_request_review");
    expect(executorEnvelope.resource).toMatchObject({
      kind: "pull_request",
      baseSha: "a".repeat(length),
      headSha: "b".repeat(length),
      isDraft: false,
    });
    const projection = parseProjection(executorEnvelope.resource.canonicalSnapshotJson);
    expect(projection.resource.revision).toEqual({
      kind: "pull_request",
      baseSha: "a".repeat(length),
      headSha: "b".repeat(length),
    });
  });

  it("deterministically bounds a large snapshot with an explicit body marker", () => {
    const original = createEnvelope("issue_triage");
    const body = "PowerToys 🙂 ".repeat(75_000);
    const serverEnvelope = withSnapshot(original, {
      ...(original.resource.canonicalSnapshot as Record<string, unknown>),
      body,
      largeUntrustedField: "z".repeat(200_000),
    });

    const executorEnvelope = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);
    const projection = parseProjection(executorEnvelope.resource.canonicalSnapshotJson);
    const bodyProjection = projection.body as Record<string, unknown>;

    expect(bodyProjection.state).toBe("truncated");
    expect(bodyProjection.text).toMatch(/\n\[UNTRUSTED_BODY_TRUNCATED\]$/u);
    expect(bodyProjection).not.toHaveProperty("sha256");
    expect(bodyProjection).not.toHaveProperty("originalUtf8Bytes");
    expect(projection).not.toHaveProperty("source");
    const projectedText = bodyProjection.text;
    expect(typeof projectedText).toBe("string");
    const marker = "\n[UNTRUSTED_BODY_TRUNCATED]";
    const retainedPrefix = String(projectedText).slice(0, -marker.length);
    expect(body.startsWith(retainedPrefix)).toBe(true);
    const repeated = createExecutorJobEnvelopeV1(serverEnvelope, otherAttemptCorrelationId);
    expect(repeated.resource.canonicalSnapshotJson).toBe(
      executorEnvelope.resource.canonicalSnapshotJson,
    );
    expect(
      Buffer.byteLength(executorEnvelope.resource.canonicalSnapshotJson, "utf8"),
    ).toBeLessThanOrEqual(LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES);
    expect(Buffer.byteLength(serializeCanonicalJson(executorEnvelope), "utf8")).toBeLessThanOrEqual(
      LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES,
    );
  });

  it("fails closed when the output schema exceeds its UTF-8 byte limit", () => {
    const original = createEnvelope("issue_triage");
    const outputSchema = {
      type: "string",
      marker: "x".repeat(LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES),
    };
    const serverEnvelope: JobExecutionEnvelope = {
      ...original,
      prompt: {
        ...original.prompt,
        outputSchema,
        outputSchemaSha256: createCanonicalJsonDocument(outputSchema).sha256,
      },
    };

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId),
      "OUTPUT_SCHEMA_LIMIT_EXCEEDED",
    );
  });

  it("fails closed when a multibyte prompt exceeds its UTF-8 byte limit", () => {
    const original = createEnvelope("issue_triage");
    const renderedPrompt = "🙂".repeat(Math.floor(LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES / 4) + 1);
    const serverEnvelope: JobExecutionEnvelope = {
      ...original,
      prompt: {
        ...original.prompt,
        renderedPrompt,
        promptSha256: sha256Hex(renderedPrompt),
      },
    };

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId),
      "PROMPT_LIMIT_EXCEEDED",
    );
  });

  it("fails closed when prompt, schema, and the minimum projection exceed the aggregate limit", () => {
    const original = createEnvelope("issue_triage");
    const renderedPrompt = "\\".repeat(350 * 1_024);
    const outputSchema = { marker: "\\".repeat(120 * 1_024), type: "string" };
    const serverEnvelope: JobExecutionEnvelope = {
      ...withSnapshot(original, {
        kind: "issue",
        githubRepositoryId: original.repository.githubRepositoryId,
        githubNodeId: original.resource.githubNodeId,
        number: original.resource.number,
        title: original.resource.title,
        author: original.resource.author,
      }),
      prompt: {
        ...original.prompt,
        renderedPrompt,
        promptSha256: sha256Hex(renderedPrompt),
        outputSchema,
        outputSchemaSha256: createCanonicalJsonDocument(outputSchema).sha256,
      },
    };

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId),
      "ENVELOPE_LIMIT_EXCEEDED",
    );
  });

  it.each([
    ["prompt", "PROMPT_DIGEST_MISMATCH"],
    ["schema", "OUTPUT_SCHEMA_DIGEST_MISMATCH"],
  ] as const)("rejects a tampered %s digest", (target, code) => {
    const original = createEnvelope("issue_triage");
    const serverEnvelope: JobExecutionEnvelope = {
      ...original,
      prompt: {
        ...original.prompt,
        ...(target === "prompt"
          ? { promptSha256: "f".repeat(64) }
          : { outputSchemaSha256: "f".repeat(64) }),
      },
    };

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId),
      code,
    );
  });

  it("does not copy lease, Server-time, URL, Authorization, or credential fields", () => {
    const original = createEnvelope("issue_triage");
    const serverEnvelope = withSnapshot(original, {
      ...(original.resource.canonicalSnapshot as Record<string, unknown>),
      htmlUrl: "https://github.com/microsoft/PowerToys/issues/123",
      Authorization: "Bearer snapshot-secret",
      credential: "snapshot-credential",
      nested: { url: "https://control.invalid", leaseToken: "snapshot-token" },
    });
    const executorEnvelope = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);
    const valuesToScan = [
      executorEnvelope,
      parseProjection(executorEnvelope.resource.canonicalSnapshotJson),
    ];
    const forbidden = new Set([
      "lease",
      "leasetoken",
      "assignedat",
      "leaseexpiresat",
      "executiondeadlineat",
      "workernodeid",
      "workerinstanceid",
      "leasegeneration",
      "avatarurl",
      "htmlurl",
      "authorization",
      "url",
      "credential",
      "credentials",
    ]);

    for (const value of valuesToScan) {
      expect(findForbiddenKeys(value, forbidden)).toEqual([]);
    }
    expect(serializeCanonicalJson(executorEnvelope)).not.toContain("server-lease-secret");
    expect(serializeCanonicalJson(executorEnvelope)).not.toContain("snapshot-secret");
  });

  it("is deterministic and never incorporates attempt correlation into the Executor envelope", () => {
    const serverEnvelope = createEnvelope("pull_request_review", 64);
    const first = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);
    const second = createExecutorJobEnvelopeV1(serverEnvelope, otherAttemptCorrelationId);

    expect(serializeCanonicalJson(second)).toBe(serializeCanonicalJson(first));
    expect(digestExecutorJobEnvelope(second)).toBe(digestExecutorJobEnvelope(first));
    expect(serializeCanonicalJson(first)).not.toContain(attemptCorrelationId);
    expect(first.runAttemptId).toBe(serverEnvelope.lease.runAttemptId);
  });

  it.each([
    [
      "LEASE_GENERATION_INVALID",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        lease: { ...value.lease, leaseGeneration: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
    [
      "LOCAL_PRIORITY_OUT_OF_RANGE",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        job: { ...value.job, priority: 1_000_001 },
      }),
    ],
    [
      "LOCAL_HARD_TIMEOUT_OUT_OF_RANGE",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        executionPolicy: { ...value.executionPolicy, hardTimeoutMs: 86_400_001 },
      }),
    ],
    [
      "LOCAL_NO_PROGRESS_TIMEOUT_OUT_OF_RANGE",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        executionPolicy: { ...value.executionPolicy, noProgressTimeoutMs: 999 },
      }),
    ],
    [
      "LOCAL_MAX_CODEX_TURNS_OUT_OF_RANGE",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        executionPolicy: { ...value.executionPolicy, maxCodexTurns: 129 },
      }),
    ],
    [
      "LOCAL_REPOSITORY_INVALID",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        repository: { ...value.repository, fullName: "owner/repo@invalid" },
      }),
    ],
    [
      "LOCAL_RECIPE_ID_INVALID",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        executionPolicy: { ...value.executionPolicy, allowedRecipeIds: ["recipe id"] },
      }),
    ],
    [
      "LOCAL_CAPABILITY_LABEL_INVALID",
      (value: JobExecutionEnvelope): JobExecutionEnvelope => ({
        ...value,
        executionPolicy: {
          ...value.executionPolicy,
          requiredCapabilityLabels: { "os version": "1" },
        },
      }),
    ],
  ] as const)("reports stable local narrowing error %s", (code, mutate) => {
    expectBoundaryCode(
      () =>
        createExecutorJobEnvelopeV1(mutate(createEnvelope("issue_triage")), attemptCorrelationId),
      code,
    );
  });

  it("validates job, lease, resource, repository, revision, and policy consistency", () => {
    const issue = createEnvelope("issue_triage");
    const cases: ReadonlyArray<readonly [JobExecutionEnvelope, string]> = [
      [{ ...issue, lease: { ...issue.lease, jobId: "other-job" } }, "JOB_ID_MISMATCH"],
      [
        { ...issue, job: { ...issue.job, kind: "pull_request_review" } },
        "JOB_RESOURCE_KIND_MISMATCH",
      ],
      [
        withSnapshot(issue, {
          ...(issue.resource.canonicalSnapshot as Record<string, unknown>),
          githubRepositoryId: 1,
        }),
        "SNAPSHOT_IDENTITY_MISMATCH",
      ],
      [
        withSnapshot(issue, {
          ...(issue.resource.canonicalSnapshot as Record<string, unknown>),
          revisionDigest: "d".repeat(64),
        }),
        "SNAPSHOT_IDENTITY_MISMATCH",
      ],
      [withSnapshot(issue, []), "SNAPSHOT_IDENTITY_MISMATCH"],
      [
        withSnapshot(issue, {
          ...(issue.resource.canonicalSnapshot as Record<string, unknown>),
          repository: "microsoft/PowerToys",
        }),
        "SNAPSHOT_IDENTITY_MISMATCH",
      ],
      [
        {
          ...issue,
          job: { ...issue.job, attempt: issue.job.maxAttempts + 1 },
        },
        "ATTEMPT_COUNT_INVALID",
      ],
      [
        {
          ...issue,
          executionPolicy: {
            ...issue.executionPolicy,
            hardTimeoutMs: 2_000,
            noProgressTimeoutMs: 2_001,
          },
        },
        "POLICY_TIMEOUT_INCONSISTENT",
      ],
    ];

    for (const [serverEnvelope, code] of cases) {
      expectBoundaryCode(
        () => createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId),
        code,
      );
    }
  });

  it("rejects incomplete Server envelopes before preparing local data", () => {
    const invalid = {
      ...createEnvelope("issue_triage"),
      Authorization: "Bearer must-not-cross",
    } as JobExecutionEnvelope;

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(invalid, attemptCorrelationId),
      "SERVER_ENVELOPE_INVALID",
    );
  });

  it("rejects canonical snapshot cycles", () => {
    const original = createEnvelope("issue_triage");
    const cyclicSnapshot: Record<string, unknown> = {
      ...(original.resource.canonicalSnapshot as Record<string, unknown>),
    };
    cyclicSnapshot.self = cyclicSnapshot;

    expectBoundaryCode(
      () =>
        createExecutorJobEnvelopeV1(withSnapshot(original, cyclicSnapshot), attemptCorrelationId),
      "CANONICAL_VALUE_INVALID",
    );
  });

  it("rejects unsafe Server integers before local canonicalization", () => {
    const original = createEnvelope("issue_triage");
    const unsafeEnvelope: JobExecutionEnvelope = {
      ...original,
      job: { ...original.job, generation: Number.MAX_SAFE_INTEGER + 1 },
    };

    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(unsafeEnvelope, attemptCorrelationId),
      "SERVER_ENVELOPE_INVALID",
    );
  });

  it("requires a separate canonical UUID v4 correlation ID", () => {
    for (const correlationId of [
      "server-run-attempt-7",
      "10000000-0000-1000-8000-000000000001",
      attemptCorrelationId.toUpperCase(),
    ]) {
      expectBoundaryCode(
        () => createExecutorJobEnvelopeV1(createEnvelope("issue_triage"), correlationId),
        "ATTEMPT_CORRELATION_ID_INVALID",
      );
    }

    const reusedCorrelationEnvelope: JobExecutionEnvelope = {
      ...createEnvelope("issue_triage"),
      lease: {
        ...createEnvelope("issue_triage").lease,
        runAttemptId: attemptCorrelationId,
      },
    };
    expectBoundaryCode(
      () => createExecutorJobEnvelopeV1(reusedCorrelationEnvelope, attemptCorrelationId),
      "ATTEMPT_CORRELATION_ID_INVALID",
    );

    const reusedLeaseTokenEnvelope = createEnvelope("issue_triage");
    expectBoundaryCode(
      () =>
        createExecutorJobEnvelopeV1(
          {
            ...reusedLeaseTokenEnvelope,
            lease: { ...reusedLeaseTokenEnvelope.lease, leaseToken: attemptCorrelationId },
          },
          attemptCorrelationId,
        ),
      "ATTEMPT_CORRELATION_ID_INVALID",
    );
  });

  it("prepares an opaque start containing only correlation and sanitized execution data", () => {
    const prepared = prepareLocalExecutionStart(
      createEnvelope("issue_triage"),
      attemptCorrelationId,
    );

    expect(Object.keys(prepared).sort()).toEqual([
      "attemptCorrelationId",
      "authorityBasis",
      "executorEnvelope",
    ]);
    expect(prepared.attemptCorrelationId).toBe(attemptCorrelationId);
    expect(prepared.authorityBasis).toEqual({
      workerNodeId: "worker-node-1",
      workerInstanceId: "worker-instance-1",
      leaseGeneration: 7,
      serverLeaseExpiresAtUnixMs: Date.parse("2026-08-31T00:05:00.000Z"),
      hardDeadlineUnixMs: Date.parse("2026-08-31T00:20:00.000Z"),
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.authorityBasis)).toBe(true);
    expect(findForbiddenKeys(prepared, new Set(["lease", "leasetoken"]))).toEqual([]);
    expect(serializeCanonicalJson(prepared)).not.toContain("server-lease-secret");
  });

  it("rejects inconsistent lease and hard-deadline timestamps", () => {
    const original = createEnvelope("issue_triage");
    for (const mutation of [
      { leaseExpiresAt: original.assignedAt },
      { executionDeadlineAt: original.assignedAt },
      {
        leaseExpiresAt: "2026-08-31T00:21:00.000Z",
        executionDeadlineAt: "2026-08-31T00:20:00.000Z",
      },
    ]) {
      expectBoundaryCode(
        () => prepareLocalExecutionStart({ ...original, ...mutation }, attemptCorrelationId),
        "LEASE_TIME_INVALID",
      );
    }
  });
});

function createEnvelope(
  kind: "issue_triage" | "pull_request_review",
  gitObjectIdLength = 40,
): JobExecutionEnvelope {
  const isPullRequest = kind === "pull_request_review";
  const outputSchema = {
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
    type: "object",
  };
  const renderedPrompt = isPullRequest ? "Review this pull request." : "Triage this issue.";
  const githubNodeId = isPullRequest ? "PR_kwDOAv9ZBc5-test" : "I_kwDOAv9ZBc5-test";
  const number = isPullRequest ? 456 : 123;
  const title = isPullRequest ? "Improve PowerToys Run" : "PowerToys Run issue";
  const author = {
    githubUserId: 42,
    login: "contributor",
    avatarUrl: "https://avatars.githubusercontent.com/u/42",
  };
  const canonicalSnapshot = {
    kind: isPullRequest ? ("pull_request" as const) : ("issue" as const),
    githubRepositoryId: 184_456_251,
    githubNodeId,
    number,
    title,
    body: isPullRequest ? "Pull request body" : "Issue body",
    state: "open",
    author,
    htmlUrl: `https://github.com/microsoft/PowerToys/${isPullRequest ? "pull" : "issues"}/${number}`,
  };

  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-08-31T00:00:00.000Z",
    leaseExpiresAt: "2026-08-31T00:05:00.000Z",
    executionDeadlineAt: "2026-08-31T00:20:00.000Z",
    lease: {
      jobId: "job-1",
      runAttemptId: "server-run-attempt-7",
      workerNodeId: "worker-node-1",
      workerInstanceId: "worker-instance-1",
      leaseToken: "server-lease-secret".padEnd(32, "x"),
      leaseGeneration: 7,
    },
    job: {
      jobId: "job-1",
      kind,
      priority: 100,
      attempt: 2,
      maxAttempts: 3,
      generation: 5,
      intentVersion: 2,
      semanticKey: `github:184456251:${number}:${kind}`,
    },
    repository: { githubRepositoryId: 184_456_251, fullName: "microsoft/PowerToys" },
    resource: isPullRequest
      ? {
          kind: "pull_request",
          githubNodeId,
          number,
          title,
          author,
          canonicalSnapshot,
          baseSha: "a".repeat(gitObjectIdLength),
          headSha: "b".repeat(gitObjectIdLength),
          isDraft: false,
        }
      : {
          kind: "issue",
          githubNodeId,
          number,
          title,
          author,
          canonicalSnapshot,
          revisionDigest: "c".repeat(64),
        },
    prompt: {
      name: isPullRequest ? "pull-request-review" : "issue-triage",
      version: "1",
      renderedPrompt,
      promptSha256: sha256Hex(renderedPrompt),
      outputSchema,
      outputSchemaSha256: createCanonicalJsonDocument(outputSchema).sha256,
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      maxCodexTurns: 8,
      allowedRecipeIds: ["powertoys.static-check"],
      requiredCapabilityLabels: { architecture: "x64", toolchain: "vs-2026" },
    },
  };
}

function withSnapshot(
  envelope: JobExecutionEnvelope,
  canonicalSnapshot: unknown,
): JobExecutionEnvelope {
  return {
    ...envelope,
    resource: { ...envelope.resource, canonicalSnapshot },
  } as JobExecutionEnvelope;
}

interface SnapshotProjectionView extends Record<string, unknown> {
  readonly resource: { readonly revision: unknown };
  readonly body: unknown;
}

function parseProjection(json: string): SnapshotProjectionView {
  return JSON.parse(json) as SnapshotProjectionView;
}

function createExecutorJobEnvelopeV1(serverEnvelope: JobExecutionEnvelope, correlationId: string) {
  return prepareLocalExecutionStart(serverEnvelope, correlationId).executorEnvelope;
}

function expectBoundaryCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(
    expect.objectContaining({ name: LocalExecutionBoundaryError.name, code }),
  );
}

function findForbiddenKeys(value: unknown, forbidden: ReadonlySet<string>): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => findForbiddenKeys(item, forbidden));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) {
      found.push(key);
    }
    found.push(...findForbiddenKeys(child, forbidden));
  }
  return found;
}
