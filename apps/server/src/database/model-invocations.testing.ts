import type * as C from "@agentic-review/contracts";
import { evaluateEvaluationRunReadiness } from "@agentic-review/domain";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { evaluationAdministrator } from "./evaluation-management.testing.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handleModelRuntimeRegistryRequest } from "./model-runtime-registry.js";
import { handleValidationDispatchRequest } from "./validation-dispatch.js";
import { freezeValidationSummaryInput } from "./validation-summary-inputs.js";
import { validationSummaryInputRequest } from "./validation-summary-inputs.testing.js";

export const modelInvocationFixtureTime = {
  registered: "2026-09-08T02:59:00.000Z",
  queued: "2026-09-08T03:30:00.000Z",
  leased: "2026-09-08T04:00:00.000Z",
  opened: "2026-09-08T04:00:01.000Z",
  sealed: "2026-09-08T04:00:02.000Z",
  submitted: "2026-09-08T04:00:03.000Z",
  deadline: "2026-09-08T05:00:00.000Z",
} as const;
export const modelInvocationFixtureWorkerToken = `arw1_${Buffer.alloc(32, 9).toString("base64url")}`;
export const modelInvocationFixtureWorkerTokenSha256 = sha256(modelInvocationFixtureWorkerToken);
export function modelInvocationFixtureIdentity(): C.ModelRuntimeIdentityV1 {
  return {
    schemaVersion: "ModelRuntimeIdentityV1",
    providerId: "synthetic-provider",
    endpointSha256: sha256("synthetic-endpoint"),
    modelId: "synthetic-observed-model",
    client: {
      kind: "codex_cli",
      version: "synthetic-cli",
      executableSha256: sha256("synthetic-cli-bytes"),
      launchPolicySha256: sha256("synthetic-launch"),
    },
    relay: {
      implementationSha256: sha256("synthetic-relay-bytes"),
      policySha256: sha256("synthetic-relay-policy"),
    },
  };
}

/** Seeds protocol observations only. No executor/model runs and no successful production claim is asserted. */
export function createModelInvocationFixture(
  options: {
    readonly modelRequired?: boolean;
    readonly registerRuntime?: boolean;
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
    const leasedAt = options.now ?? modelInvocationFixtureTime.leased;
    const deadline =
      options.now === undefined
        ? modelInvocationFixtureTime.deadline
        : new Date(Date.parse(options.now) + 10 * 60 * 1000).toISOString();
    const identity = modelInvocationFixtureIdentity();
    const status = handleModelRuntimeRegistryRequest(
      f.database,
      {
        operation: "registerModelRuntime",
        input: {
          actor: evaluationAdministrator,
          request: {
            changeId: "register-invocation-fixture",
            name: "Synthetic model observer",
            requestedModel: "synthetic-requested-model",
            identity,
            enabled: true,
          },
        },
      },
      modelInvocationFixtureTime.registered,
      [evaluationAdministrator],
    ) as C.ModelRuntimeStatusV1;
    const request = structuredClone(f.input);
    if (options.modelRequired === false) request.request.mode = "profile_only";
    else if (options.registerRuntime !== false) {
      request.request.baseline.modelRuntimeRegistrationId = status.registration.id;
      request.request.candidate.modelRuntimeRegistrationId = status.registration.id;
    }
    const batch = f.create(request);
    handleValidationDispatchRequest(
      f.database,
      { operation: "dispatchPendingReviewRuns", input: { limit: 128 } },
      modelInvocationFixtureTime.queued,
    );
    const cells = readEvaluationBatchCells(f.database, batch.id).map((cell) => {
      let row = f.database
        .prepare(
          "SELECT job_id FROM review_run_job_links WHERE review_run_id = ? AND request_id = ?",
        )
        .get(cell.run_id, cell.request_id) as { job_id: string } | undefined;
      if (!row) {
        // Required-model dispatch remains blocked. Seed only synthetic protocol rows against the
        // original sealed template, using the same SQL boundaries as completion-owner fixtures.
        const template = createEvaluationExecutionTemplate({
          runId: cell.run_id,
          plan: cell.plan,
          planDigest: cell.plan_digest,
          frozenPrompt: cell.prompt,
        });
        const jobId = `synthetic-invocation-job-${cell.arm}`;
        const serialized = canonicalJson(template);
        f.database.exec("BEGIN IMMEDIATE");
        try {
          f.database
            .prepare(`INSERT INTO jobs
            (id, work_item_id, job_kind, semantic_key, concurrency_key, status, execution_json, execution_digest,
            required_capabilities_json, required_capabilities_digest, resource_revision, request_epoch_id,
            max_attempts, next_attempt_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?, NULL, 1, ?, ?, ?)`)
            .run(
              jobId,
              cell.plan.workItemId,
              cell.plan.workItem.kind === "issue" ? "issue_triage" : "pull_request_review",
              jobId,
              jobId,
              serialized,
              sha256(serialized),
              sha256("[]"),
              cell.plan.revision.revisionKey,
              modelInvocationFixtureTime.queued,
              modelInvocationFixtureTime.queued,
              modelInvocationFixtureTime.queued,
            );
          createJobAdmissionInTransaction(f.database, jobId, modelInvocationFixtureTime.queued);
          f.database
            .prepare(`INSERT INTO review_run_job_links
            (review_run_id, request_id, activation_number, job_id, linked_at) VALUES (?, ?, 1, ?, ?)`)
            .run(cell.run_id, cell.request_id, jobId, modelInvocationFixtureTime.queued);
          f.database.exec("COMMIT");
          row = { job_id: jobId };
        } catch (error) {
          if (f.database.isTransaction) f.database.exec("ROLLBACK");
          throw error;
        }
      }
      return { ...cell, jobId: row.job_id };
    });
    if (
      options.modelRequired !== false &&
      options.registerRuntime !== false &&
      cells.some(
        (cell) =>
          !evaluateEvaluationRunReadiness(cell.plan, [])[0]?.reasons.some(
            (reason) =>
              reason.code === "missing_capability" &&
              reason.capability === "verified_model_execution",
          ),
      )
    )
      throw new Error(
        "The fixture must not remove the production model-execution readiness refusal.",
      );
    const capabilities: C.WorkerCapabilities = {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "synthetic-cli",
      recipeIds: [],
      labels: {},
    };
    const capabilitiesJson = canonicalJson(capabilities);
    f.database.exec("BEGIN IMMEDIATE");
    try {
      f.database
        .prepare(`INSERT INTO worker_node_credentials
        (worker_node_id, display_name, token_sha256, auth_state, created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at)
        VALUES ('invocation-node', 'Synthetic invocation observer', ?, 'active', 'fixture', 'fixture', 'fixture', 'fixture', ?, ?, ?)`)
        .run(modelInvocationFixtureWorkerTokenSha256, leasedAt, leasedAt, leasedAt);
      f.database
        .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version, protocol_version,
        max_slots, available_slots, capabilities_json, capabilities_digest, status, registered_at, last_seen_at, updated_at)
        VALUES ('invocation-worker', 'invocation-node', 'invocation-instance', 'Synthetic invocation observer', 'fixture', '1.0', 4, 4, ?, ?, 'online', ?, ?, ?)`)
        .run(capabilitiesJson, sha256(capabilitiesJson), leasedAt, leasedAt, leasedAt);
      // This deliberate SQL protocol seed preserves every constraint. It is not production admission/claim acceptance.
      for (const cell of cells) {
        f.database
          .prepare(
            "UPDATE job_admission SET state = 'admitted', admitted_at = ?, blockers_json = '[]' WHERE job_id = ? AND ownership_state = 'resolved'",
          )
          .run(leasedAt, cell.jobId);
        const attemptId = `invocation-attempt-${cell.arm}`;
        f.database
          .prepare(
            "UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1, lease_generation = 1 WHERE id = ? AND status = 'queued'",
          )
          .run(attemptId, cell.jobId);
        f.database
          .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id,
          status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at, no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at)
          VALUES (?, ?, 1, 'invocation-worker', 'invocation-node', 'invocation-instance', 'running', ?, 1, ?, ?, 60000, ?, ?, 'model_observation_fixture', ?)`)
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
    const { schemaVersion: _schemaVersion, modelId: _modelId, ...runtime } = identity;
    const lease = (arm: "baseline" | "candidate" = "baseline"): C.LeaseIdentity => {
      const cell = cells.find((entry) => entry.arm === arm);
      if (!cell) throw new Error("The requested synthetic cell is missing.");
      return {
        jobId: cell.jobId,
        runAttemptId: `invocation-attempt-${arm}`,
        workerNodeId: "invocation-node",
        workerInstanceId: "invocation-instance",
        leaseGeneration: 1,
        leaseToken: `synthetic-model-lease-token-${arm}-only`,
      };
    };
    return {
      ...f,
      batch,
      cells,
      registration: status.registration,
      identity,
      runtime,
      lease,
      workerToken: modelInvocationFixtureWorkerToken,
      workerTokenSha256: modelInvocationFixtureWorkerTokenSha256,
    };
  } catch (error) {
    f.close();
    throw error;
  }
}
export type ModelInvocationFixture = ReturnType<typeof createModelInvocationFixture>;
/** The caller owns the destination path and supplies its storage marker/permissions before reopening an owner. */
export function exportModelInvocationFixture(
  fixture: ModelInvocationFixture,
  databasePath: string,
): void {
  if (fixture.database.isTransaction)
    throw new Error("The fixture must finish its seed transaction before export.");
  fixture.database.prepare("VACUUM INTO ?").run(databasePath);
  fixture.close();
}
export function modelInvocationBeginRequest(
  fixture: ModelInvocationFixture,
  arm: "baseline" | "candidate" = "baseline",
  options: { readonly lease?: C.LeaseIdentity; readonly now?: string } = {},
): C.ModelInvocationBeginRequest {
  const lease = options.lease ?? fixture.lease(arm);
  const result: C.ModelInvocationBeginRequest = {
    lease,
    invocationId: `invocation-${arm}`,
    runtime: fixture.runtime,
  };
  const cell = fixture.cells.find((value) => value.arm === arm);
  if (
    cell?.plan.modelRequirements.required &&
    cell.plan.modelRuntimeRegistration &&
    ["pr_ui", "issue_validation"].includes(cell.plan.jobs[0]?.workflowKind ?? "")
  ) {
    // New summary invocations explicitly freeze real owner input before opening. This is still
    // synthetic runner data and never implies that production model claim gates passed.
    const request = validationSummaryInputRequest(fixture, arm);
    request.lease = lease;
    request.context.jobId = lease.jobId;
    request.context.runAttemptId = lease.runAttemptId;
    if (lease.runAttemptId !== fixture.lease(arm).runAttemptId)
      request.inputId = `summary-${lease.runAttemptId}`;
    const row = fixture.database
      .prepare("SELECT started_at FROM run_attempts WHERE id=?")
      .get(lease.runAttemptId) as { started_at: string };
    const old = fixture.database
      .prepare("SELECT frozen_at FROM model_summary_inputs WHERE input_id=?")
      .get(request.inputId) as { frozen_at: string } | undefined;
    result.summaryInput = freezeValidationSummaryInput(
      fixture.database,
      { workerTokenSha256: fixture.workerTokenSha256, request },
      options.now ?? old?.frozen_at ?? row.started_at,
    ).reference;
  }
  return result;
}
/** Pure synthetic response metadata; this does not claim a provider request was made. */
export function modelInvocationReceiptSet(
  opening: C.ModelInvocationOpening,
  modelId = "synthetic-observed-model",
): C.ModelInvocationReceiptSet {
  const outputDigest = sha256(canonicalJson({ synthetic: true }));
  const receipt: C.ModelCallReceiptV1 = {
    schemaVersion: "ModelCallReceiptV1",
    scopeSha256: opening.scopeSha256,
    sequence: 1,
    previousReceiptSha256: null,
    startedAt: "2020-01-01T00:00:00.000Z",
    finishedAt: "2020-01-01T00:00:01.000Z",
    requestSha256: sha256("synthetic-request"),
    requestBytes: 17,
    requestedModel: opening.scope.requestedModel,
    httpStatus: 200,
    outcome: "completed",
    response: {
      schemaVersion: "ModelResponseObservationV1",
      bodySha256: sha256("synthetic-response"),
      bodyBytes: 18,
      eventCount: 1,
      transportComplete: true,
      outcome: "completed",
      responseId: "synthetic-response",
      modelId,
      outputJsonSha256: outputDigest,
      reasonCode: null,
    },
  };
  const observedIdentity: C.ModelRuntimeIdentityV1 = {
    schemaVersion: "ModelRuntimeIdentityV1",
    ...opening.runtime,
    modelId,
  };
  return {
    schemaVersion:
      opening.schemaVersion === "ModelInvocationOpeningV2"
        ? "ModelInvocationReceiptSetV2"
        : "ModelInvocationReceiptSetV1",
    scope: opening.scope,
    scopeSha256: opening.scopeSha256,
    runtime: opening.runtime,
    calls: [{ receipt, sha256: sha256(canonicalJson(receipt)) }],
    closedAt: "2020-01-01T00:00:02.000Z",
    state: "closed",
    modelOutputSha256: outputDigest,
    observedIdentity,
    observedIdentitySha256: sha256(canonicalJson(observedIdentity)),
  } as C.ModelInvocationReceiptSet;
}
export function modelInvocationSealRequest(
  lease: C.LeaseIdentity,
  receiptSet: C.ModelInvocationReceiptSet,
): C.ModelInvocationSealRequest {
  return {
    lease,
    invocationId: receiptSet.scope.invocationId,
    scopeSha256: receiptSet.scopeSha256,
    receiptSetSha256: sha256(canonicalJson(receiptSet)),
    closedAt: receiptSet.closedAt,
    state: receiptSet.state,
    callCount: receiptSet.calls.length,
    lastReceiptSha256: receiptSet.calls.at(-1)?.sha256 ?? null,
    modelOutputSha256: receiptSet.modelOutputSha256,
    observedIdentitySha256: receiptSet.observedIdentitySha256,
    processClosed: true,
    relayClosed: true,
  };
}
