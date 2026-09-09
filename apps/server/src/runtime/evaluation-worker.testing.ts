import { createHash } from "node:crypto";
import type * as C from "@agentic-review/contracts";
import { evaluationModelExecutionCapabilityLabels } from "@agentic-review/contracts";
import Fastify from "fastify";
import { expect } from "vitest";
import type { WorkerConfig } from "../../../worker/src/config.js";
import type { Logger } from "../../../worker/src/logging/logger.js";
import type { ServerConfig } from "../../dist/config.js";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import { registerWorkerRoutes } from "../../dist/routes/workers.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
} from "../database/evidence-control-plane.testing.js";

export const evaluationWorkerActor = {
  issuer: "https://identity.example.test",
  subject: "evaluation-worker-integration",
};
export const syntheticCliConfiguration: C.CliModelConfiguration = {
  kind: "codex",
  version: "synthetic-direct-runner",
  requestedModel: null,
};
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export async function createEvaluationWorkerDatabase(): Promise<EvidenceControlPlaneFixture> {
  const fixture = await createEvidenceControlPlaneFixture(1, [evaluationWorkerActor]);
  // Reuse the existing source/configuration fixture, completing its ordinary validation before
  // creating Evaluation cells. Evaluation leases and results below are never seeded with SQL.
  try {
    for (const envelope of await fixture.claimAll())
      await fixture.client.request("completeLease", completion(envelope, []));
    return fixture;
  } catch (error) {
    try {
      await fixture.closeOwner();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic database initialization cleanup failed.",
      );
    }
    // Keep the failed synthetic database for inspection after its owner has stopped.
    throw error;
  }
}

export async function createWorkerEvaluation(fixture: EvidenceControlPlaneFixture) {
  const actor = evaluationWorkerActor;
  const operator = bindOperatorDatabase(fixture.client, actor);
  const repositoryId = fixture.run.repositoryId;
  const scope = { repositoryId, actor };
  const captured = await operator.request("captureEvaluationSource", {
    ...scope,
    request: {
      changeId: "worker-e2e-source",
      source: {
        kind: "current_work_item",
        workItemId: fixture.run.workItemId,
        expectedRevisionKey: fixture.run.revisionKey,
        testedIssueCommit: null,
      },
    },
  });
  const suite = await operator.request("createEvaluationSuite", {
    ...scope,
    request: {
      changeId: "worker-e2e-suite",
      name: "Consecutive Worker Evaluation tasks",
      description: "Synthetic direct CLI; actual Worker HTTP, database owner and scoring.",
      workflowKind: "pr_static_build",
      target: "headless",
    },
  });
  const saved = await operator.request("saveEvaluationSuiteDraft", {
    ...scope,
    suiteId: suite.id,
    request: {
      changeId: "worker-e2e-draft",
      expectedRevision: suite.draftRevision,
      draft: {
        name: suite.name,
        description: suite.description,
        cases: [
          {
            caseId: "case-build",
            title: "The same frozen source compiles under both configurations",
            sourceId: captured.id,
            applicability: { state: "applicable" },
            criteria: [
              {
                criterionId: "criterion-build",
                description: "The synthetic frozen build check passes.",
                applicability: { state: "applicable" },
                expectedOutcome: "passed",
              },
            ],
            findings: { annotation: "complete", expected: [] },
          },
        ],
      },
    },
  });
  const published = await operator.request("publishEvaluationSuite", {
    ...scope,
    suiteId: suite.id,
    request: { changeId: "worker-e2e-publish", expectedRevision: saved.draftRevision },
  });

  async function arm(name: C.EvaluationArm) {
    const config: C.ValidationProfileConfig = {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      build: [
        {
          id: `compile-${name}`,
          name: `Compile ${name}`,
          command: {
            executable: "synthetic-build.exe",
            args: [name],
            workingDirectory: ".",
            environment: [],
          },
          timeoutMs: 10_000,
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
    const profile = await operator.request("publishValidationProfile", {
      ...scope,
      request: {
        name: `Worker ${name}`,
        workflowKind: "pr_static_build",
        target: "headless",
        required: true,
        config,
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const template = await operator.request("createPromptTemplate", {
      actor,
      request: {
        name: `Worker ${name}`,
        workflowKind: "pr_static_build",
        content: `Review the frozen source with the ${name} configuration.`,
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const prompt = await operator.request("publishPromptDraft", {
      actor,
      templateId: template.id,
      request: { expectedVersion: template.version },
    });
    return {
      profile,
      prompt,
      selection: {
        profileVersionId: profile.id,
        promptVersionId: prompt.id,
      },
    };
  }
  const baseline = await arm("baseline");
  const candidate = await arm("candidate");
  const batch = await operator.request("createEvaluationBatch", {
    ...scope,
    request: {
      changeId: "worker-e2e-batch",
      suiteId: suite.id,
      suiteVersionId: published.id,
      mode: "prompt_and_profile",
      baseline: baseline.selection,
      candidate: candidate.selection,
      checkMappings: [
        {
          caseId: "case-build",
          criterionId: "criterion-build",
          baselineCheckId: `${baseline.profile.id}:compile-baseline`,
          candidateCheckId: `${candidate.profile.id}:compile-candidate`,
        },
      ],
    },
  });
  await fixture.client.request("dispatchPendingReviewRuns", { limit: 20 });
  const query = { ...scope, evaluationId: batch.id };
  const matrix = await operator.request("getEvaluationBatchMatrix", query);
  expect(matrix.progress.totalCells).toBe(2);
  const first = present(matrix.cases[0]);
  const cells = { baseline: first.baseline, candidate: first.candidate };
  return { operator, query, batch, baseline, candidate, cells };
}

export async function createWorkerHttpRuntime(
  fixture: EvidenceControlPlaneFixture,
  cli: C.CliModelConfiguration = syntheticCliConfiguration,
) {
  const workerNodeId = "evaluation-worker-http-node";
  const workerToken = `arw1_${Buffer.alloc(32, 27).toString("base64url")}`;
  await fixture.client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: "Synthetic consecutive Worker",
    workerTokenSha256: hash(workerToken),
    createdByIssuer: evaluationWorkerActor.issuer,
    createdBySubject: evaluationWorkerActor.subject,
  });
  const shutdown = new AbortController();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    recoveryMaintenance: false,
    databasePath: "unused.sqlite",
    migrationsDirectory: "unused",
    protocolVersion: "1.0",
    heartbeatIntervalSeconds: 1,
    leaseTtlSeconds: 120,
    leaseReaperIntervalSeconds: 15,
    operatorAuthCleanupIntervalSeconds: 300,
    operatorAuthCleanupBatchSize: 100,
    retryDelaySeconds: 1,
    workerOfflineAfterSeconds: 90,
    maxLongPollSeconds: 1,
    allowInsecureHttp: true,
    tls: undefined,
    github: undefined,
    operatorAuth: undefined,
    dashboardDirectory: undefined,
  };
  const app = Fastify({ logger: false });
  const requests: { method: string; path: string; status: number }[] = [];
  app.addHook("onResponse", async (request, reply) => {
    requests.push({ method: request.method, path: request.url, status: reply.statusCode });
  });
  registerWorkerRoutes(app, { database: fixture.client, config, shutdownSignal: shutdown.signal });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const workerConfig: WorkerConfig = {
    serverUrl: new URL(address),
    protocolVersion: "1.0",
    workerNodeId,
    workerToken,
    displayName: "Synthetic consecutive Worker",
    workerVersion: "synthetic-integration",
    maxSlots: 1,
    dataDirectory: ".",
    executionEnabled: true,
    claimWaitSeconds: 0,
    registrationRetrySeconds: 1,
    idleDelayMilliseconds: 10,
    heartbeatIntervalSeconds: 1,
    heartbeatSafetyMarginSeconds: 0,
    shutdownGraceSeconds: 2,
    requestTimeoutSeconds: 5,
    logLevel: "error",
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      cliEngine: cli.kind,
      cliVersion: cli.version,
      recipeIds: [],
      labels: {
        executionEnvelope: "2",
        validationHeadless: "1",
        validationEvaluation: "1",
        [evaluationModelExecutionCapabilityLabels.review]: "1",
      },
    },
    allowInsecureHttp: true,
  };
  return { app, shutdown, workerConfig, requests };
}
