import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type * as C from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { runMigrations } from "./migrations.js";
import {
  handleModelInvocationRequest,
  readModelInvocationHistoryInTransaction,
} from "./model-invocations.js";
import {
  createModelInvocationFixture,
  modelInvocationReceiptSet,
  modelInvocationSealRequest,
  modelInvocationFixtureTime as time,
} from "./model-invocations.testing.js";
import { freezeValidationSummaryInput } from "./validation-summary-inputs.js";
import { validationSummaryInputRequest } from "./validation-summary-inputs.testing.js";

const migrations = fileURLToPath(new URL("../../../../migrations", import.meta.url));
describe("validation summary input migration", () => {
  it("retains a real schema-31 V1 archive byte-for-byte and replays it without fabricating a summary input", () => {
    const directory = mkdtempSync(join(tmpdir(), "summary-legacy31-"));
    for (const file of readdirSync(migrations))
      if (/^00(?:0[1-9]|[12][0-9]|3[01])_/u.test(file))
        copyFileSync(join(migrations, file), join(directory, file));
    const f = createModelInvocationFixture({ migrationsDirectory: directory });
    try {
      const cell = f.cells.find((item) => item.arm === "baseline")!;
      const lease = f.lease(),
        request: C.ModelInvocationBeginRequest = {
          lease,
          invocationId: "legacy-summary-invocation",
          runtime: f.runtime,
        };
      const scope: C.ModelInvocationScopeV1 = {
        schemaVersion: "ModelInvocationScopeV1",
        repositoryId: f.repositoryId,
        evaluationId: f.batch.id,
        cellId: cell.id,
        runId: cell.run_id,
        requestId: cell.request_id,
        jobId: cell.jobId,
        attemptId: lease.runAttemptId,
        invocationId: request.invocationId,
        authorizationId: cell.plan.authorization.id,
        executionManifestSha256: cell.plan.purpose.executionManifestSha256,
        promptSha256: cell.prompt.promptSha256,
        outputSchemaSha256: cell.prompt.outputSchemaSha256,
        expectedModelIdentitySha256: f.registration.identitySha256,
        requestedModel: f.registration.requestedModel,
        workerNodeId: lease.workerNodeId,
        workerInstanceId: lease.workerInstanceId,
        leaseGeneration: lease.leaseGeneration,
      };
      const opening: C.ModelInvocationOpeningV1 = {
        schemaVersion: "ModelInvocationOpeningV1",
        scope,
        scopeSha256: sha256(canonicalJson(scope)),
        runtime: f.runtime,
        openedAt: time.opened,
      };
      const { leaseToken, ...leaseFields } = lease;
      const intent = sha256(
        canonicalJson({
          operation: "beginModelInvocation",
          request: { ...request, lease: { ...leaseFields, leaseTokenSha256: sha256(leaseToken) } },
        }),
      );
      // An explicitly synthetic historical record is inserted under the actual schema-31 guard.
      // The current owner must not create this legacy summary opening after migration 32.
      f.database
        .prepare(
          `INSERT INTO model_invocation_openings (invocation_id,run_attempt_id,job_id,worker_node_id,worker_instance_id,lease_generation,scope_sha256,opening_json,opening_sha256,begin_intent_sha256,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          request.invocationId,
          lease.runAttemptId,
          lease.jobId,
          lease.workerNodeId,
          lease.workerInstanceId,
          lease.leaseGeneration,
          opening.scopeSha256,
          canonicalJson(opening),
          sha256(canonicalJson(opening)),
          intent,
          time.opened,
        );
      const ledger = modelInvocationReceiptSet(opening, f.identity.modelId);
      handleModelInvocationRequest(
        f.database,
        {
          operation: "sealModelInvocation",
          input: {
            workerTokenSha256: f.workerTokenSha256,
            request: modelInvocationSealRequest(lease, ledger),
          },
        },
        time.sealed,
      );
      handleModelInvocationRequest(
        f.database,
        {
          operation: "submitModelInvocationReceipts",
          input: {
            workerTokenSha256: f.workerTokenSha256,
            request: { lease, invocationId: request.invocationId, receiptSet: ledger },
          },
        },
        time.submitted,
      );
      const rows = () =>
        canonicalJson(
          ["openings", "seals", "submissions"].map((suffix) =>
            f.database
              .prepare(`SELECT * FROM model_invocation_${suffix}`)
              .all()
              .map((row) => ({ ...row })),
          ),
        );
      const before = rows();
      expect(runMigrations(f.database, migrations)).toBe(33);
      expect(rows()).toBe(before);
      expect(
        handleModelInvocationRequest(
          f.database,
          {
            operation: "beginModelInvocation",
            input: { workerTokenSha256: f.workerTokenSha256, request },
          },
          time.submitted,
          { readOnly: true },
        ),
      ).toEqual(opening);
      expect(() =>
        freezeValidationSummaryInput(
          f.database,
          { workerTokenSha256: f.workerTokenSha256, request: validationSummaryInputRequest(f) },
          time.submitted,
        ),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_SUMMARY_INPUT_CONFLICT" }));
      f.database
        .prepare("UPDATE run_attempts SET lease_expires_at=? WHERE id=?")
        .run(time.opened, lease.runAttemptId);
      f.database.exec("BEGIN");
      try {
        expect(
          readModelInvocationHistoryInTransaction(
            f.database,
            {
              repositoryId: f.repositoryId,
              evaluationId: f.batch.id,
              cellId: cell.id,
              invocationId: request.invocationId,
            },
            time.submitted,
          ).opening,
        ).toEqual(opening);
      } finally {
        f.database.exec("ROLLBACK");
      }
      expect(rows()).toBe(before);
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM model_summary_inputs").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      f.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("adds immutable inputs after schema 31 while preserving prior schemas except the two version-sensitive guards", () => {
    const directory = mkdtempSync(join(tmpdir(), "summary-schema31-"));
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(migrations))
        if (/^00(?:0[1-9]|[12][0-9]|3[01])_/u.test(file))
          copyFileSync(join(migrations, file), join(directory, file));
      expect(runMigrations(database, directory)).toBe(31);
      const previous = database
        .prepare("SELECT version,filename,checksum FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => ({ ...row }));
      const schemas = () =>
        canonicalJson(
          database
            .prepare(
              "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE '%summary_input%' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('tr_model_invocation_opening_consistency','tr_model_invocation_submission_consistency') ORDER BY type,name",
            )
            .all()
            .map((row) => ({ ...row })),
        );
      const before = schemas();
      // This case verifies only the schema-31 to schema-32 transition and its exact guards.
      copyFileSync(
        join(migrations, "0032_validation_summary_inputs.sql"),
        join(directory, "0032_validation_summary_inputs.sql"),
      );
      expect(runMigrations(database, directory)).toBe(32);
      expect(
        database
          .prepare(
            "SELECT version,filename,checksum FROM schema_migrations WHERE version<=31 ORDER BY version",
          )
          .all()
          .map((row) => ({ ...row })),
      ).toEqual(previous);
      expect(schemas()).toBe(before);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM model_summary_inputs").get(),
      ).toMatchObject({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(runMigrations(database, directory)).toBe(32);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
