import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type WorkerCapabilities,
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";
import { sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationBatchFixture } from "./evaluation-batches.testing.js";
import { evaluationActor } from "./evaluation-management.testing.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
const fixtures: { dispose(): Promise<void> }[] = [];

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  const results = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.dispose()));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Model execution admission fixture cleanup failed.",
    );
});
afterAll(() => {
  for (const [name, format] of formats) {
    if (format === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, format);
  }
});

interface JobState {
  readonly id: string;
  readonly jobKind: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly runAttemptId: string | null;
  readonly admissionState: string;
}

/** Only metadata and production-ingested legacy Jobs precede the isolated database owner.
 * Ordinary validation dispatch, every admission decision, and every attempt use real RPCs. */
async function fixture(kind: "pull_request" | "issue") {
  const directory = await mkdtemp(join(tmpdir(), "model-execution-admission-"));
  await chmod(directory, 0o700);
  const databaseDirectory = join(directory, "database");
  await mkdir(databaseDirectory, { mode: 0o700 });
  const databasePath = join(databaseDirectory, "server.sqlite");
  let client: DatabaseClient | undefined;
  try {
    const seeded = createEvaluationBatchFixture(kind, { notApplicableCase: false });
    let saved: {
      readonly repositoryId: string;
      readonly planInput: typeof seeded.planInput;
      readonly baseline: typeof seeded.baseline;
      readonly legacyJobIds: string[];
    };
    try {
      // These two legacy Jobs were created by ingestSchedulingEvent, never by raw INSERTs.
      const legacyJobIds = seeded.database
        .prepare("SELECT id FROM jobs ORDER BY id")
        .all()
        .map((row) => String(row.id));
      expect(legacyJobIds).toHaveLength(2);
      expect(
        seeded.database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()?.count,
      ).toBe(0);
      saved = {
        repositoryId: seeded.repositoryId,
        planInput: structuredClone(seeded.planInput),
        baseline: structuredClone(seeded.baseline),
        legacyJobIds,
      };
      seeded.database.prepare("VACUUM INTO ?").run(databasePath);
    } finally {
      seeded.close();
    }
    await chmod(databasePath, 0o600);
    // This marker accompanies the trusted synthetic export, following the existing owner fixtures.
    await writeFile(
      databaseInitializationMarkerPath(databasePath),
      databaseInitializationMarkerContent,
      { mode: 0o600, flag: "wx" },
    );
    client = await DatabaseClient.create({
      databasePath,
      migrationsDirectory,
      startupTimeoutMilliseconds: 10_000,
    });
    const owner = client;
    const value = {
      ...saved,
      client: owner,
      read<T>(action: (reader: DatabaseSync) => T): T {
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try {
          return action(reader);
        } finally {
          reader.close();
        }
      },
      async dispose() {
        try {
          await owner.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
    fixtures.push(value);
    return value;
  } catch (error) {
    try {
      await client?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function registerWorker(f: Fixture, suffix: string, disabled: boolean) {
  const workerNodeId = "model-routing-" + suffix;
  const workerInstanceId = workerNodeId + "-instance";
  const workerTokenSha256 = sha256("synthetic-model-routing-token-" + suffix);
  await f.client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: evaluationActor.issuer,
    createdBySubject: evaluationActor.subject,
  });
  const capabilities: WorkerCapabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    cliEngine: "codex",
    cliVersion: "synthetic-protocol-only",
    recipeIds: [],
    labels: {
      executionEnvelope: "2",
      validationHeadless: "1",
      ...(disabled
        ? { [workerModelExecutionDisabledLabel]: workerModelExecutionDisabledValue }
        : {}),
    },
  };
  const registered = await f.client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerInstanceId,
    workerTokenSha256,
    displayName: workerInstanceId,
    workerVersion: "test",
    maxSlots: 8,
    capabilities,
  });
  return {
    workerNodeId,
    capabilities,
    claim: () =>
      f.client.request("claimLease", {
        workerNodeId,
        workerInstanceId,
        availableSlots: 8,
        capabilitiesDigest: registered.capabilitiesDigest,
        protocolVersion: "1.0",
        leaseTtlSeconds: 300,
      }),
  };
}

async function dispatchOrdinary(f: Fixture) {
  const profile = f.baseline.profile;
  await f.client.request("saveValidationProfileBinding", {
    repositoryId: f.repositoryId,
    profileId: profile.profileId,
    actor: evaluationActor,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
  });
  const run = await f.client.request("createReviewRun", {
    actor: evaluationActor,
    planInput: {
      ...f.planInput,
      requests: [
        {
          requestId: "ordinary-model-routing-request",
          workflowKind: profile.workflowKind,
          target: profile.target,
          required: profile.required,
          profileVersion: profile,
          prompt: { workflowKind: profile.workflowKind, version: f.baseline.prompt },
        },
      ],
    },
  });
  const dispatched = await f.client.request("dispatchReviewRun", {
    repositoryId: f.repositoryId,
    reviewRunId: run.id,
    actor: evaluationActor,
  });
  expect(dispatched.blockedRequests).toEqual([]);
  const current = await f.client.request("getReviewRun", {
    repositoryId: f.repositoryId,
    reviewRunId: run.id,
  });
  const jobId = current?.requests.find(
    (entry) => entry.requestId === "ordinary-model-routing-request",
  )?.jobs[0]?.jobId;
  if (jobId === undefined)
    throw new Error("The production owner did not dispatch the ordinary validation Job.");
  return { runId: run.id, jobId, workflowKind: profile.workflowKind };
}

function states(f: Fixture): JobState[] {
  return f.read((reader) =>
    reader
      .prepare(
        "SELECT job.id, job.job_kind AS jobKind, job.status, job.attempt_count AS attemptCount, job.current_run_attempt_id AS runAttemptId, admission.state AS admissionState FROM jobs AS job JOIN job_admission AS admission ON admission.job_id = job.id ORDER BY job.id",
      )
      .all()
      .map((row) => ({ ...row })),
  ) as unknown as JobState[];
}
function attemptCount(f: Fixture, workerNodeId?: string): number {
  return f.read((reader) =>
    Number(
      workerNodeId === undefined
        ? reader.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()?.count
        : reader
            .prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE worker_node_id = ?")
            .get(workerNodeId)?.count,
    ),
  );
}

describe.skipIf(process.platform !== "linux")(
  "model execution capability through the real database owner",
  () => {
    it("keeps legacy review and ordinary static-build Jobs pending when only a disabled Worker is online", async () => {
      const f = await fixture("pull_request");
      const disabled = await registerWorker(f, "disabled-only", true);
      const ordinary = await dispatchOrdinary(f);
      await f.client.request("admitPendingJobs", { limit: 128 });
      const rows = states(f);
      expect(rows.map((row) => row.id).sort()).toEqual([...f.legacyJobIds, ordinary.jobId].sort());
      expect(
        rows.every(
          (row) =>
            row.jobKind === "pull_request_review" &&
            row.admissionState === "pending" &&
            row.status === "queued" &&
            row.attemptCount === 0 &&
            row.runAttemptId === null,
        ),
      ).toBe(true);
      expect(await disabled.claim()).toMatchObject({ outcome: "no_work" });
      expect(attemptCount(f)).toBe(0);
    });

    it("rejects disabled claims after an unlabelled Worker genuinely admits model Jobs, then grants that compatible Worker", async () => {
      const f = await fixture("pull_request");
      const disabled = await registerWorker(f, "mixed-disabled", true);
      const ordinary = await dispatchOrdinary(f);
      await f.client.request("admitPendingJobs", { limit: 128 });
      expect(states(f).every((row) => row.admissionState === "pending")).toBe(true);

      const compatible = await registerWorker(f, "mixed-compatible", false);
      expect(compatible.capabilities.labels).not.toHaveProperty(workerModelExecutionDisabledLabel);
      await f.client.request("admitPendingJobs", { limit: 128 });
      const admitted = states(f);
      expect(admitted.map((row) => row.id).sort()).toEqual(
        [...f.legacyJobIds, ordinary.jobId].sort(),
      );
      expect(admitted.every((row) => row.admissionState === "admitted")).toBe(true);
      expect(await disabled.claim()).toMatchObject({ outcome: "no_work" });
      expect(attemptCount(f, disabled.workerNodeId)).toBe(0);

      const granted = await compatible.claim();
      expect(granted.outcome).toBe("granted");
      if (granted.outcome !== "granted")
        throw new Error("The compatible Worker did not receive a model Job.");
      const envelope = granted.envelope;
      expect(envelope.lease.workerNodeId).toBe(compatible.workerNodeId);
      if (envelope.envelopeVersion === 2) {
        expect(envelope.job.jobId).toBe(ordinary.jobId);
        expect(envelope.validation.schemaVersion).toBe("ValidationJobContextV1");
        expect(envelope.validation.workflowKind).toBe("pr_static_build");
      } else {
        expect(f.legacyJobIds).toContain(envelope.job.jobId);
        expect(envelope.job.kind).toBe("pull_request_review");
      }
      expect(attemptCount(f, compatible.workerNodeId)).toBe(1);
      expect(attemptCount(f, disabled.workerNodeId)).toBe(0);
    });

    it("grants ordinary model-free Issue validation to a disabled Worker while legacy Issue triage stays pending", async () => {
      const f = await fixture("issue");
      const disabled = await registerWorker(f, "issue-disabled", true);
      const ordinary = await dispatchOrdinary(f);
      expect(ordinary.workflowKind).toBe("issue_validation");
      await f.client.request("admitPendingJobs", { limit: 128 });
      const rows = states(f);
      expect(rows.find((row) => row.id === ordinary.jobId)).toMatchObject({
        admissionState: "admitted",
        status: "queued",
        attemptCount: 0,
        runAttemptId: null,
      });
      expect(rows.filter((row) => f.legacyJobIds.includes(row.id))).toEqual(
        f.legacyJobIds.map((id) => ({
          id,
          jobKind: "issue_triage",
          admissionState: "pending",
          status: "queued",
          attemptCount: 0,
          runAttemptId: null,
        })),
      );

      const granted = await disabled.claim();
      expect(granted.outcome).toBe("granted");
      if (granted.outcome !== "granted" || granted.envelope.envelopeVersion !== 2)
        throw new Error("The disabled Worker did not receive the ordinary Issue validation lease.");
      expect(granted.envelope.job.jobId).toBe(ordinary.jobId);
      expect(granted.envelope.validation).toMatchObject({
        schemaVersion: "ValidationJobContextV1",
        runId: ordinary.runId,
        workflowKind: "issue_validation",
      });
      expect(granted.envelope.lease.workerNodeId).toBe(disabled.workerNodeId);
      expect(attemptCount(f, disabled.workerNodeId)).toBe(1);
      expect(await disabled.claim()).toMatchObject({ outcome: "no_work" });
      expect(
        states(f)
          .filter((row) => f.legacyJobIds.includes(row.id))
          .every((row) => row.attemptCount === 0),
      ).toBe(true);
    });
  },
);
