import type * as C from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { handleValidationDispatchRequest } from "./validation-dispatch.js";

export const modelCliFixtureTime = {
  queued: "2026-09-08T03:30:00.000Z",
  leased: "2026-09-08T04:00:00.000Z",
  opened: "2026-09-08T04:00:01.000Z",
  submitted: "2026-09-08T04:00:03.000Z",
  deadline: "2026-09-08T05:00:00.000Z",
} as const;
export const modelCliFixtureWorkerToken = `arw1_${Buffer.alloc(32, 9).toString("base64url")}`;
export const modelCliFixtureWorkerTokenSha256 = sha256(modelCliFixtureWorkerToken);
export function modelCliFixtureConfiguration(): C.CliModelConfiguration {
  return {
    kind: "codex",
    version: "synthetic-cli",
    requestedModel: null,
  };
}

/** Seeds protocol observations only. No executor/model runs and no successful production claim is asserted. */
export function createModelCliFixture(
  options: {
    readonly modelRequired?: boolean;
    readonly now?: string;
    readonly migrationsDirectory?: string;
    readonly kind?: "issue" | "pull_request";
  } = {},
) {
  const f = createEvaluationBatchFixture(options.kind ?? "issue", {
    notApplicableCase: false,
    ...(options.migrationsDirectory === undefined
      ? {}
      : { migrationsDirectory: options.migrationsDirectory }),
  });
  try {
    const leasedAt = options.now ?? modelCliFixtureTime.leased;
    const deadline =
      options.now === undefined
        ? modelCliFixtureTime.deadline
        : new Date(Date.parse(options.now) + 10 * 60 * 1000).toISOString();
    const cli = modelCliFixtureConfiguration();
    const request = structuredClone(f.input);
    if (options.modelRequired === false) request.request.mode = "profile_only";
    const batch = f.create(request);
    handleValidationDispatchRequest(
      f.database,
      { operation: "dispatchPendingReviewRuns", input: { limit: 128 } },
      modelCliFixtureTime.queued,
    );
    const cells = readEvaluationBatchCells(f.database, batch.id).map((cell) => {
      const row = f.database
        .prepare(
          "SELECT job_id FROM review_run_job_links WHERE review_run_id = ? AND request_id = ?",
        )
        .get(cell.run_id, cell.request_id) as { job_id: string } | undefined;
      if (!row) throw new Error("The frozen CLI evaluation cell was not dispatched.");
      return { ...cell, jobId: row.job_id };
    });
    const capabilities: C.WorkerCapabilities = {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      cliEngine: "codex",
      cliVersion: "synthetic-cli",
      recipeIds: [],
      labels: {},
    };
    const capabilitiesJson = canonicalJson(capabilities);
    f.database.exec("BEGIN IMMEDIATE");
    try {
      f.database
        .prepare(`INSERT INTO worker_node_credentials
        (worker_node_id, display_name, token_sha256, auth_state, created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at)
        VALUES ('cli-node', 'Synthetic CLI observer', ?, 'active', 'fixture', 'fixture', 'fixture', 'fixture', ?, ?, ?)`)
        .run(modelCliFixtureWorkerTokenSha256, leasedAt, leasedAt, leasedAt);
      f.database
        .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version, protocol_version,
        max_slots, available_slots, capabilities_json, capabilities_digest, status, registered_at, last_seen_at, updated_at)
        VALUES ('cli-worker', 'cli-node', 'cli-instance', 'Synthetic CLI observer', 'fixture', '1.0', 4, 4, ?, ?, 'online', ?, ?, ?)`)
        .run(capabilitiesJson, sha256(capabilitiesJson), leasedAt, leasedAt, leasedAt);
      // This deliberate SQL protocol seed preserves every constraint. It is not production admission/claim acceptance.
      for (const cell of cells) {
        f.database
          .prepare(
            "UPDATE job_admission SET state = 'admitted', admitted_at = ?, blockers_json = '[]' WHERE job_id = ? AND ownership_state = 'resolved'",
          )
          .run(leasedAt, cell.jobId);
        const attemptId = `cli-attempt-${cell.arm}`;
        f.database
          .prepare(
            "UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1, lease_generation = 1 WHERE id = ? AND status = 'queued'",
          )
          .run(attemptId, cell.jobId);
        f.database
          .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id,
          status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at, no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at)
          VALUES (?, ?, 1, 'cli-worker', 'cli-node', 'cli-instance', 'running', ?, 1, ?, ?, 60000, ?, ?, 'model_observation_fixture', ?)`)
          .run(
            attemptId,
            cell.jobId,
            sha256(`synthetic-model-lease-token-${cell.arm}-only`),
            deadline,
            deadline,
            deadline,
            leasedAt,
            leasedAt,
          );
        f.database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(cell.jobId);
      }
      f.database.exec("COMMIT");
    } catch (error) {
      if (f.database.isTransaction) f.database.exec("ROLLBACK");
      throw error;
    }
    const lease = (arm: "baseline" | "candidate" = "baseline"): C.LeaseIdentity => {
      const cell = cells.find((entry) => entry.arm === arm);
      if (!cell) throw new Error("The requested synthetic cell is missing.");
      return {
        jobId: cell.jobId,
        runAttemptId: `cli-attempt-${arm}`,
        workerNodeId: "cli-node",
        workerInstanceId: "cli-instance",
        leaseGeneration: 1,
        leaseToken: `synthetic-model-lease-token-${arm}-only`,
      };
    };
    return {
      ...f,
      batch,
      cells,
      cli,
      lease,
      workerToken: modelCliFixtureWorkerToken,
      workerTokenSha256: modelCliFixtureWorkerTokenSha256,
    };
  } catch (error) {
    f.close();
    throw error;
  }
}
export type ModelCliFixture = ReturnType<typeof createModelCliFixture>;
/** The caller owns the destination path and supplies its storage marker/permissions before reopening an owner. */
export function exportModelCliFixture(fixture: ModelCliFixture, databasePath: string): void {
  if (fixture.database.isTransaction)
    throw new Error("The fixture must finish its seed transaction before export.");
  fixture.database.prepare("VACUUM INTO ?").run(databasePath);
  fixture.close();
}
