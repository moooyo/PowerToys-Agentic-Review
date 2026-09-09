import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type * as C from "@agentic-review/contracts";
import {
  evaluationModelExecutionCapabilityLabels,
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { evaluationAdministrator } from "./evaluation-management.testing.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "./storage-security.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const genericEvaluationLabels: C.WorkerCapabilities["labels"] = {
  executionEnvelope: "2",
  validationHeadless: "1",
  validationEvaluation: "1",
};
const labels: C.WorkerCapabilities["labels"] = {
  ...genericEvaluationLabels,
  [evaluationModelExecutionCapabilityLabels.review]: "1",
};
const incompatibleWorkers: {
  readonly name: string;
  readonly labels: C.WorkerCapabilities["labels"];
}[] = [
  {
    name: "envelope support",
    labels: {
      validationHeadless: "1",
      validationEvaluation: "1",
      [evaluationModelExecutionCapabilityLabels.review]: "1",
    },
  },
  {
    name: "headless execution",
    labels: {
      executionEnvelope: "2",
      validationEvaluation: "1",
      [evaluationModelExecutionCapabilityLabels.review]: "1",
    },
  },
  {
    name: "evaluation execution",
    labels: {
      executionEnvelope: "2",
      validationHeadless: "1",
      [evaluationModelExecutionCapabilityLabels.review]: "1",
    },
  },
  { name: "review CLI support", labels: genericEvaluationLabels },
  {
    name: "review CLI support despite summary support",
    labels: {
      ...genericEvaluationLabels,
      [evaluationModelExecutionCapabilityLabels.summary]: "1",
    },
  },
  {
    name: "enabled model execution",
    labels: {
      ...labels,
      [workerModelExecutionDisabledLabel]: workerModelExecutionDisabledValue,
    },
  },
];

interface OwnedDatabase {
  readonly directory: string;
  client?: DatabaseClient;
}

const ownedDatabases: OwnedDatabase[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const owned of ownedDatabases.splice(0)) {
    try {
      await owned.client?.close();
    } catch (error) {
      // Retain files if the database owner did not confirm closure.
      failures.push(error);
      continue;
    }
    try {
      await rm(owned.directory, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Evaluation model claim fixture cleanup failed.");
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-model-claim-"));
  const owned: OwnedDatabase = { directory };
  ownedDatabases.push(owned);
  await chmod(directory, 0o700);
  const databasePath = join(directory, "claims.sqlite");
  const seeded = createEvaluationBatchFixture("pull_request", { notApplicableCase: false });
  try {
    // Source ingestion creates unrelated historical review jobs. Keep their records while
    // removing them from this synthetic fixture's claim queue before creating the evaluation.
    seeded.database.prepare("UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'").run();
    const input = structuredClone(seeded.input);
    const batch = seeded.create(input);
    const cells = readEvaluationBatchCells(seeded.database, batch.id);
    seeded.database.prepare("VACUUM INTO ?").run(databasePath);
    seeded.close();
    await chmod(databasePath, 0o600);
    await writeFile(
      databaseInitializationMarkerPath(databasePath),
      databaseInitializationMarkerContent,
      { mode: 0o600, flag: "wx" },
    );
    const client = await DatabaseClient.create({ databasePath, migrationsDirectory });
    owned.client = client;
    return { client, databasePath, batch, cells };
  } finally {
    seeded.close();
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function registerWorker(
  value: Fixture,
  selectedLabels = labels,
  cliEngine: C.CliEngine = "codex",
) {
  const workerNodeId = "evaluation-claim-node";
  const workerInstanceId = "evaluation-claim-instance";
  const workerTokenSha256 = sha256("synthetic-evaluation-claim-token");
  await value.client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: "Synthetic evaluation VM",
    workerTokenSha256,
    createdByIssuer: evaluationAdministrator.issuer,
    createdBySubject: evaluationAdministrator.subject,
  });
  const capabilities: C.WorkerCapabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    cliEngine,
    cliVersion: "synthetic-cli",
    recipeIds: [],
    labels: selectedLabels,
  };
  const worker = await value.client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerTokenSha256,
    workerInstanceId,
    displayName: "Synthetic evaluation Worker",
    workerVersion: "fixture",
    maxSlots: 1,
    capabilities,
  });
  return () =>
    value.client.request("claimLease", {
      workerNodeId,
      workerInstanceId,
      availableSlots: 1,
      capabilitiesDigest: worker.capabilitiesDigest,
      protocolVersion: "1.0",
      leaseTtlSeconds: 300,
    });
}

function readEvaluationJobs(value: Fixture) {
  const database = new DatabaseSync(value.databasePath, { readOnly: true, timeout: 5_000 });
  try {
    return database
      .prepare(`SELECT job.id, job.status, job.attempt_count, job.lease_generation,
        job.current_run_attempt_id,
        (SELECT COUNT(*) FROM run_attempts WHERE job_id = job.id) AS attempt_rows
        FROM evaluation_cells AS cell
        JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id
          AND link.request_id = cell.request_id
        JOIN jobs AS job ON job.id = link.job_id
        WHERE cell.evaluation_id = ? ORDER BY job.id`)
      .all(value.batch.id);
  } finally {
    database.close();
  }
}

describe.skipIf(process.platform !== "linux")("Evaluation model lease claims", () => {
  it.each(["codex", "copilot"] as const)(
    "dispatches and claims a frozen evaluation with the Worker's %s CLI through the real owner",
    async (cliEngine) => {
      const value = await fixture();
      const claim = await registerWorker(value, labels, cliEngine);
      const dispatched = await value.client.request("dispatchPendingReviewRuns", { limit: 128 });
      expect(dispatched.createdJobs).toHaveLength(2);
      expect(dispatched.blockedRequestCount).toBe(0);

      const result = await claim();
      expect(result.outcome).toBe("granted");
      if (
        result.outcome !== "granted" ||
        result.envelope.envelopeVersion !== 2 ||
        result.envelope.validation.schemaVersion !== "ValidationJobContextV2"
      ) {
        throw new Error("Expected the real database owner to grant an evaluation lease.");
      }
      const context = result.envelope.validation;
      const cell = value.cells.find((entry) => entry.run_id === context.runId);
      expect(cell).toBeDefined();
      expect(context.modelRequirements).toEqual(cell?.plan.modelRequirements);
      expect(context.modelRequirements).toEqual({ required: true });
      expect(context.planDigest).toBe(cell?.plan_digest);
      expect(context.requestId).toBe(cell?.request_id);
      expect(result.envelope.lease).toMatchObject({
        jobId: result.envelope.job.jobId,
        workerNodeId: "evaluation-claim-node",
        workerInstanceId: "evaluation-claim-instance",
        leaseGeneration: 1,
      });
      expect(readEvaluationJobs(value)).toContainEqual({
        id: result.envelope.job.jobId,
        status: "leased",
        attempt_count: 1,
        lease_generation: 1,
        current_run_attempt_id: result.envelope.lease.runAttemptId,
        attempt_rows: 1,
      });
      expect(await claim()).toMatchObject({
        outcome: "worker_unavailable",
        reason: "no_available_slots",
      });
      expect(readEvaluationJobs(value).filter((job) => job.status === "queued")).toHaveLength(1);
    },
  );

  it.each(incompatibleWorkers)(
    "does not claim when the Worker lacks $name",
    async ({ labels: selectedLabels }) => {
      const value = await fixture();
      const claim = await registerWorker(value, selectedLabels);
      const dispatched = await value.client.request("dispatchPendingReviewRuns", { limit: 128 });
      expect(dispatched.createdJobs).toHaveLength(2);
      expect(await claim()).toMatchObject({ outcome: "no_work" });
      const jobs = readEvaluationJobs(value);
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job).toMatchObject({
          status: "queued",
          attempt_count: 0,
          lease_generation: 0,
          current_run_attempt_id: null,
          attempt_rows: 0,
        });
      }
    },
  );
});
