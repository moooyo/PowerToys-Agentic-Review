import type { SQLInputValue } from "node:sqlite";
import type * as C from "@agentic-review/contracts";
import { getModelInvocationSubmissionIssues } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { evaluationAdministrator } from "./evaluation-management.testing.js";
import {
  handleModelInvocationRequest,
  type ModelInvocationOperation,
  type ModelInvocationOperationMap,
  type ModelInvocationRequest,
  readModelInvocationHistoryInTransaction,
} from "./model-invocations.js";
import {
  createModelInvocationFixture,
  type ModelInvocationFixture,
  modelInvocationBeginRequest,
  modelInvocationReceiptSet,
  modelInvocationSealRequest,
  modelInvocationFixtureTime as time,
} from "./model-invocations.testing.js";
import { handleModelRuntimeRegistryRequest } from "./model-runtime-registry.js";

const fixtures: ModelInvocationFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(options: Parameters<typeof createModelInvocationFixture>[0] = {}) {
  const f = createModelInvocationFixture(options);
  fixtures.push(f);
  return f;
}
function execute<K extends ModelInvocationOperation>(
  f: ModelInvocationFixture,
  operation: K,
  request: ModelInvocationOperationMap[K]["input"]["request"],
  now = time.opened as string,
  options: { readOnly?: boolean; tokenSha256?: string } = {},
): ModelInvocationOperationMap[K]["output"] {
  return handleModelInvocationRequest(
    f.database,
    {
      operation,
      input: { workerTokenSha256: options.tokenSha256 ?? f.workerTokenSha256, request },
    } as ModelInvocationRequest,
    now,
    { readOnly: options.readOnly === true },
  ) as ModelInvocationOperationMap[K]["output"];
}
function opened(f: ModelInvocationFixture, arm: "baseline" | "candidate" = "baseline") {
  return execute(f, "beginModelInvocation", modelInvocationBeginRequest(f, arm));
}
function sealAndSubmit(
  f: ModelInvocationFixture,
  opening: C.ModelInvocationOpening,
  set = modelInvocationReceiptSet(opening),
  changes: Partial<C.ModelInvocationSealRequest> = {},
) {
  const lease = f.lease(
    opening.scope.invocationId.endsWith("candidate") ? "candidate" : "baseline",
  );
  const sealing = { ...modelInvocationSealRequest(lease, set), ...changes };
  const seal = execute(f, "sealModelInvocation", sealing, time.sealed);
  const request = { lease, invocationId: opening.scope.invocationId, receiptSet: set };
  const submission = execute(f, "submitModelInvocationReceipts", request, time.submitted);
  return { seal, submission, request, sealing };
}
function records(f: ModelInvocationFixture): string {
  return canonicalJson(
    Object.fromEntries(
      ["openings", "seals", "submissions"].map((suffix) => [
        suffix,
        f.database
          .prepare(`SELECT * FROM model_invocation_${suffix} ORDER BY invocation_id`)
          .all()
          .map((row) => ({ ...row })),
      ]),
    ),
  );
}
function expire(f: ModelInvocationFixture): void {
  f.database
    .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
    .run(time.opened, f.lease().runAttemptId);
}
function rotate(f: ModelInvocationFixture): string {
  const digest = sha256(`arw1_${Buffer.alloc(32, 21).toString("base64url")}`);
  f.database
    .prepare(
      "UPDATE worker_node_credentials SET token_sha256 = ?, updated_at = ?, rotated_at = ? WHERE worker_node_id = ?",
    )
    .run(digest, time.submitted, time.submitted, f.lease().workerNodeId);
  return digest;
}

describe("independent model invocation owner records", () => {
  it.each(["unknown_ref_field", "wrong_ref_digest", "missing_ref", "wrong_container"] as const)(
    "SQL rejects V2 %s while allowing the unchanged owner-generated row",
    (change) => {
      const f = fixture(),
        request = modelInvocationBeginRequest(f);
      f.database.exec("BEGIN IMMEDIATE");
      const opening = execute(f, "beginModelInvocation", request);
      const row = {
        ...f.database
          .prepare("SELECT * FROM model_invocation_openings WHERE invocation_id=?")
          .get(request.invocationId)!,
      };
      f.database.exec("ROLLBACK");
      const changed = JSON.parse(String(row.opening_json)) as Record<string, unknown>;
      const scoped = changed.scope as Record<string, unknown>,
        ref = scoped.inputRef as Record<string, unknown>;
      if (change === "unknown_ref_field") ref.extra = true;
      if (change === "wrong_ref_digest") ref.actualPromptSha256 = "0".repeat(64);
      if (change === "missing_ref") delete scoped.inputRef;
      if (change === "wrong_container") changed.schemaVersion = "ModelInvocationOpeningV1";
      const bad: Record<string, SQLInputValue> = {
        ...row,
        opening_json: canonicalJson(changed),
        opening_sha256: sha256(canonicalJson(changed)),
        scope_sha256: sha256(canonicalJson(scoped)),
      };
      changed.scopeSha256 = bad.scope_sha256;
      bad.opening_json = canonicalJson(changed);
      bad.opening_sha256 = sha256(bad.opening_json);
      const columns = Object.keys(row),
        insert = f.database.prepare(
          `INSERT INTO model_invocation_openings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        );
      expect(() => insert.run(...Object.values(bad))).toThrow();
      insert.run(...Object.values(row));
      expect(execute(f, "beginModelInvocation", request)).toEqual(opening);
    },
  );
  it("revalidates stored V2 input bytes during history reads after lease expiry", () => {
    const f = fixture(),
      request = modelInvocationBeginRequest(f),
      opening = execute(f, "beginModelInvocation", request);
    const cell = f.cells.find((item) => item.arm === "baseline")!;
    expire(f);
    const query = {
      repositoryId: f.repositoryId,
      evaluationId: f.batch.id,
      cellId: cell.id,
      invocationId: request.invocationId,
    };
    f.database.exec("BEGIN");
    try {
      expect(
        readModelInvocationHistoryInTransaction(f.database, query, time.submitted).opening,
      ).toEqual(opening);
    } finally {
      f.database.exec("ROLLBACK");
    }
    // Deliberate corruption injection verifies that read validation is independent of write triggers.
    f.database.exec("DROP TRIGGER tr_model_summary_input_no_update");
    const row = f.database
      .prepare("SELECT input_json FROM model_summary_inputs WHERE input_id=?")
      .get(request.summaryInput!.inputId) as { input_json: string };
    const value = JSON.parse(row.input_json) as C.FrozenValidationSummaryInputV1;
    value.context.report.summary = "Changed stored runner content.";
    value.contextSha256 = sha256(canonicalJson(value.context));
    const json = canonicalJson(value);
    f.database
      .prepare("UPDATE model_summary_inputs SET input_json=?,input_sha256=? WHERE input_id=?")
      .run(json, sha256(json), value.inputId);
    f.database.exec("BEGIN");
    try {
      expect(() =>
        readModelInvocationHistoryInTransaction(f.database, query, time.submitted),
      ).toThrow();
    } finally {
      f.database.exec("ROLLBACK");
    }
  });
  it("keeps non-summary reviews on V1 and refuses an unrelated summary reference", () => {
    const f = fixture({ kind: "pull_request" }),
      request = modelInvocationBeginRequest(f);
    expect(request.summaryInput).toBeUndefined();
    const summaryFixture = fixture(),
      ref = modelInvocationBeginRequest(summaryFixture).summaryInput!;
    expect(() => execute(f, "beginModelInvocation", { ...request, summaryInput: ref })).toThrow(
      expect.objectContaining({ code: "MODEL_INVOCATION_INVALID" }),
    );
    expect(execute(f, "beginModelInvocation", request)).toMatchObject({
      schemaVersion: "ModelInvocationOpeningV1",
      scope: { schemaVersion: "ModelInvocationScopeV1" },
    });
  });
  it("requires the exact immutable summary input and generates explicit ScopeV2", () => {
    const f = fixture(),
      request = modelInvocationBeginRequest(f);
    expect(request.summaryInput).toBeDefined();
    const without = { ...request };
    delete without.summaryInput;
    expect(() => execute(f, "beginModelInvocation", without)).toThrow(
      expect.objectContaining({ code: "MODEL_INVOCATION_INVALID" }),
    );
    const foreign = modelInvocationBeginRequest(f, "candidate").summaryInput!;
    expect(() =>
      execute(f, "beginModelInvocation", { ...request, summaryInput: foreign }),
    ).toThrow();
    const opened = execute(f, "beginModelInvocation", request);
    expect(opened).toMatchObject({
      schemaVersion: "ModelInvocationOpeningV2",
      scope: {
        schemaVersion: "ModelInvocationScopeV2",
        purpose: "validation_summary",
        inputRef: request.summaryInput,
        promptSha256: request.summaryInput?.sourcePromptSha256,
      },
    });
    expect(execute(f, "beginModelInvocation", request, time.submitted, { readOnly: true })).toEqual(
      opened,
    );
  });
  it.each([
    "inputId",
    "inputSha256",
    "sourcePromptSha256",
    "outputSchemaSha256",
    "contextSha256",
    "actualPromptSha256",
  ] as const)("rejects changed frozen input %s without reserving an invocation", (field) => {
    const f = fixture(),
      request = modelInvocationBeginRequest(f);
    request.summaryInput = {
      ...request.summaryInput!,
      [field]: field === "inputId" ? "foreign-input" : "0".repeat(64),
    };
    expect(() => execute(f, "beginModelInvocation", request)).toThrow();
    expect(records(f)).toBe('{"openings":[],"seals":[],"submissions":[]}');
  });
  it("does not accept a V1 container for a V2 opening even with recomputed outer bytes", () => {
    const f = fixture(),
      opening = opened(f),
      ledger = modelInvocationReceiptSet(opening);
    const changed = { ...ledger, schemaVersion: "ModelInvocationReceiptSetV1" };
    const sealing = {
      ...modelInvocationSealRequest(f.lease(), ledger),
      receiptSetSha256: sha256(canonicalJson(changed)),
    };
    execute(f, "sealModelInvocation", sealing, time.sealed);
    expect(() =>
      execute(
        f,
        "submitModelInvocationReceipts",
        {
          lease: f.lease(),
          invocationId: opening.scope.invocationId,
          receiptSet: changed as C.ModelInvocationReceiptSet,
        },
        time.submitted,
      ),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_INVALID" }));
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM model_invocation_submissions").get(),
    ).toMatchObject({ count: 0 });
  });
  it("derives the exact sealed scope, records a separate seal and accepts consistency without accepting execution", () => {
    const f = fixture();
    const opening = opened(f);
    const cell = f.cells.find((entry) => entry.arm === "baseline");
    expect(opening.scope).toMatchObject({
      repositoryId: f.repositoryId,
      evaluationId: f.batch.id,
      cellId: cell?.id,
      runId: cell?.run_id,
      requestId: cell?.request_id,
      jobId: f.lease().jobId,
      attemptId: f.lease().runAttemptId,
      invocationId: "invocation-baseline",
      workerNodeId: f.lease().workerNodeId,
      workerInstanceId: f.lease().workerInstanceId,
      leaseGeneration: 1,
      requestedModel: f.registration.requestedModel,
      expectedModelIdentitySha256: f.registration.identitySha256,
      promptSha256: cell?.prompt.promptSha256,
      outputSchemaSha256: cell?.prompt.outputSchemaSha256,
    });
    expect(opening.scopeSha256).toBe(sha256(canonicalJson(opening.scope)));
    const { submission } = sealAndSubmit(f, opening);
    expect(getModelInvocationSubmissionIssues(submission)).toEqual([]);
    expect(submission).toMatchObject({
      executionAccepted: false,
      consistency: {
        state: "matched",
        reasons: [],
        observedIdentitySha256: f.registration.identitySha256,
      },
    });
    const persisted = records(f);
    expect(persisted).not.toContain(f.workerToken);
    expect(persisted).not.toContain(f.workerTokenSha256);
    expect(persisted).not.toContain(f.lease().leaseToken);
    expect(persisted).not.toContain('"leaseToken"');
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it("does not combine baseline and candidate invocation identities", () => {
    const f = fixture(),
      baseline = opened(f),
      candidate = opened(f, "candidate");
    expect(baseline.scope.cellId).not.toBe(candidate.scope.cellId);
    expect(baseline.scope.attemptId).not.toBe(candidate.scope.attemptId);
    expect(baseline.scopeSha256).not.toBe(candidate.scopeSha256);
    const bad = modelInvocationSealRequest(
      f.lease("candidate"),
      modelInvocationReceiptSet(baseline),
    );
    expect(() => execute(f, "sealModelInvocation", bad, time.sealed)).toThrow(
      expect.objectContaining({ code: "MODEL_INVOCATION_LEASE_REJECTED" }),
    );
    expect(sealAndSubmit(f, candidate).submission.consistency.state).toBe("matched");
  });

  it("reserves exactly one invocation per attempt and refuses a new ID or changed measurement", () => {
    const f = fixture(),
      request = modelInvocationBeginRequest(f),
      first = execute(f, "beginModelInvocation", request);
    const before = records(f);
    expect(execute(f, "beginModelInvocation", request, time.sealed)).toEqual(first);
    expect(() =>
      execute(f, "beginModelInvocation", { ...request, invocationId: "another-invocation" }),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_CONFLICT" }));
    expect(() =>
      execute(f, "beginModelInvocation", {
        ...request,
        runtime: { ...request.runtime, endpointSha256: sha256("changed-endpoint") },
      }),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_CONFLICT" }));
    expect(records(f)).toBe(before);
  });

  it("requires an independently persisted seal before accepting any ledger", () => {
    const f = fixture(),
      opening = opened(f),
      set = modelInvocationReceiptSet(opening);
    const before = records(f);
    expect(() =>
      execute(
        f,
        "submitModelInvocationReceipts",
        { lease: f.lease(), invocationId: opening.scope.invocationId, receiptSet: set },
        time.submitted,
      ),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_CONFLICT" }));
    expect(records(f)).toBe(before);
    expect(sealAndSubmit(f, opening, set).submission.consistency.state).toBe("matched");
  });

  it("rejects a changed independent seal without replacing the original", () => {
    const f = fixture(),
      opening = opened(f),
      set = modelInvocationReceiptSet(opening),
      request = modelInvocationSealRequest(f.lease(), set);
    const first = execute(f, "sealModelInvocation", request, time.sealed),
      before = records(f);
    expect(execute(f, "sealModelInvocation", request, time.submitted)).toEqual(first);
    expect(() =>
      execute(
        f,
        "sealModelInvocation",
        { ...request, receiptSetSha256: sha256("different-set") },
        time.submitted,
      ),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_CONFLICT" }));
    expect(records(f)).toBe(before);
  });

  it.each(["set_digest", "scope", "runtime", "closure"] as const)(
    "rejects outer %s mismatches without consuming the unique submission slot",
    (kind) => {
      const f = fixture(),
        opening = opened(f),
        original = modelInvocationReceiptSet(opening),
        changed = structuredClone(original);
      if (kind === "set_digest")
        changed.calls[0]!.receipt.requestSha256 = sha256("changed-request");
      if (kind === "scope") {
        changed.scope.repositoryId = f.secondRepositoryId;
        changed.scopeSha256 = sha256(canonicalJson(changed.scope));
        changed.calls[0]!.receipt.scopeSha256 = changed.scopeSha256;
      }
      if (kind === "runtime") {
        changed.runtime.endpointSha256 = sha256("changed-runtime");
        changed.observedIdentity = {
          ...changed.observedIdentity!,
          endpointSha256: changed.runtime.endpointSha256,
        };
      }
      if (kind === "closure") changed.closedAt = "2020-01-01T00:00:03.000Z";
      const sealing = modelInvocationSealRequest(f.lease(), original);
      if (kind !== "set_digest") sealing.receiptSetSha256 = sha256(canonicalJson(changed));
      execute(f, "sealModelInvocation", sealing, time.sealed);
      const before = records(f);
      expect(() =>
        execute(
          f,
          "submitModelInvocationReceipts",
          { lease: f.lease(), invocationId: opening.scope.invocationId, receiptSet: changed },
          time.submitted,
        ),
      ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_CONFLICT" }));
      expect(records(f)).toBe(before);
      if (kind === "set_digest")
        expect(
          execute(
            f,
            "submitModelInvocationReceipts",
            { lease: f.lease(), invocationId: opening.scope.invocationId, receiptSet: original },
            time.submitted,
          ).consistency.state,
        ).toBe("matched");
    },
  );

  it("records a sealed internally incorrect call hash as invalid consistency", () => {
    const f = fixture(),
      opening = opened(f),
      set = modelInvocationReceiptSet(opening);
    set.calls[0]!.sha256 = sha256("incorrect-call-commitment");
    const { submission } = sealAndSubmit(f, opening, set);
    expect(submission).toMatchObject({
      executionAccepted: false,
      consistency: { state: "invalid", observedIdentitySha256: null },
    });
    expect(submission.consistency.reasons).toContain("RECEIPT_DIGEST_MISMATCH");
  });

  it("records a sealed actual model identity mismatch without replacing the expected identity", () => {
    const f = fixture(),
      opening = opened(f),
      set = modelInvocationReceiptSet(opening, "different-synthetic-model");
    const { submission } = sealAndSubmit(f, opening, set);
    expect(submission.consistency.state).toBe("mismatched");
    expect(submission.consistency.reasons).toContain("RUNTIME_IDENTITY_MISMATCH");
    expect(opening.scope.expectedModelIdentitySha256).toBe(f.registration.identitySha256);
    expect(submission.executionAccepted).toBe(false);
  });

  it.each(["cancelled", "failed", "incomplete", "cleanup", "empty"] as const)(
    "retains %s observations as unavailable rather than successful execution",
    (kind) => {
      const f = fixture(),
        opening = opened(f),
        set = modelInvocationReceiptSet(opening);
      set.modelOutputSha256 = null;
      if (kind === "cancelled") set.state = "cancelled";
      if (kind === "empty") {
        set.calls = [];
        set.observedIdentity = null;
        set.observedIdentitySha256 = null;
      }
      if (kind === "failed" || kind === "incomplete") {
        const call = set.calls[0]!;
        call.receipt.outcome = kind === "failed" ? "provider_failed" : "provider_incomplete";
        call.receipt.response = {
          ...call.receipt.response!,
          outcome: kind,
          outputJsonSha256: null,
          reasonCode: kind === "failed" ? "RESPONSE_FAILED" : "RESPONSE_INCOMPLETE",
        };
        call.sha256 = sha256(canonicalJson(call.receipt));
      }
      const { submission } = sealAndSubmit(
        f,
        opening,
        set,
        kind === "cleanup" ? { processClosed: false } : {},
      );
      expect(submission.consistency.state).toBe("unavailable");
      expect(submission.executionAccepted).toBe(false);
      if (kind === "cleanup")
        expect(submission.consistency.reasons).toContain("CLEANUP_UNCONFIRMED");
    },
  );

  it("allows exact opening, seal and ledger replay after expiry and same-node credential rotation", () => {
    const f = fixture(),
      begin = modelInvocationBeginRequest(f),
      opening = execute(f, "beginModelInvocation", begin);
    const complete = sealAndSubmit(f, opening);
    expire(f);
    const rotated = rotate(f),
      options = { tokenSha256: rotated, readOnly: true },
      before = records(f);
    expect(() => execute(f, "beginModelInvocation", begin, time.submitted)).toThrow(
      expect.objectContaining({ code: "WORKER_TOKEN_REJECTED" }),
    );
    expect(execute(f, "beginModelInvocation", begin, time.submitted, options)).toEqual(opening);
    expect(execute(f, "sealModelInvocation", complete.sealing, time.submitted, options)).toEqual(
      complete.seal,
    );
    expect(
      execute(f, "submitModelInvocationReceipts", complete.request, time.submitted, options),
    ).toEqual(complete.submission);
    expect(records(f)).toBe(before);
  });

  it("checks current credential and historical lease token even before exact replay", () => {
    const f = fixture(),
      request = modelInvocationBeginRequest(f);
    opened(f);
    expect(() =>
      execute(f, "beginModelInvocation", {
        ...request,
        lease: { ...request.lease, leaseToken: "different-synthetic-lease-token-only" },
      }),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_LEASE_REJECTED" }));
    f.database
      .prepare(
        "UPDATE worker_node_credentials SET auth_state = 'revoked', revoked_at = ?, updated_at = ? WHERE worker_node_id = ?",
      )
      .run(time.submitted, time.submitted, request.lease.workerNodeId);
    expect(() => execute(f, "beginModelInvocation", request, time.submitted)).toThrow(
      expect.objectContaining({ code: "WORKER_TOKEN_REJECTED" }),
    );
  });

  it.each(["expiry", "cancel", "superseded", "generation", "not_current"] as const)(
    "rejects new records after %s invalidates the active fence",
    (kind) => {
      const f = fixture(),
        opening = opened(f),
        request = modelInvocationSealRequest(f.lease(), modelInvocationReceiptSet(opening));
      if (kind === "expiry") expire(f);
      if (kind === "cancel")
        f.database
          .prepare("UPDATE jobs SET cancellation_requested_at = ? WHERE id = ?")
          .run(time.sealed, f.lease().jobId);
      if (kind === "superseded")
        f.database
          .prepare("UPDATE workers SET superseded_at = ? WHERE id = 'invocation-worker'")
          .run(time.sealed);
      if (kind === "generation")
        f.database
          .prepare("UPDATE jobs SET lease_generation = 2 WHERE id = ?")
          .run(f.lease().jobId);
      if (kind === "not_current")
        f.database
          .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
          .run(f.lease().jobId);
      const before = records(f);
      expect(() => execute(f, "sealModelInvocation", request, time.sealed)).toThrow(
        expect.objectContaining({ code: "MODEL_INVOCATION_LEASE_REJECTED" }),
      );
      expect(records(f)).toBe(before);
      expect(
        execute(f, "beginModelInvocation", modelInvocationBeginRequest(f), time.sealed),
      ).toEqual(opening);
    },
  );

  it("rejects a new ledger after expiry while retaining its independently accepted seal", () => {
    const f = fixture(),
      opening = opened(f),
      set = modelInvocationReceiptSet(opening),
      sealing = modelInvocationSealRequest(f.lease(), set);
    const original = execute(f, "sealModelInvocation", sealing, time.sealed);
    expire(f);
    expect(() =>
      execute(
        f,
        "submitModelInvocationReceipts",
        { lease: f.lease(), invocationId: opening.scope.invocationId, receiptSet: set },
        time.submitted,
      ),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_LEASE_REJECTED" }));
    expect(execute(f, "sealModelInvocation", sealing, time.submitted)).toEqual(original);
  });

  it("permits only existing exact records in recovery mode", () => {
    const f = fixture(),
      begin = modelInvocationBeginRequest(f);
    expect(() =>
      execute(f, "beginModelInvocation", begin, time.opened, { readOnly: true }),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    const opening = opened(f),
      set = modelInvocationReceiptSet(opening),
      sealing = modelInvocationSealRequest(f.lease(), set);
    expect(execute(f, "beginModelInvocation", begin, time.sealed, { readOnly: true })).toEqual(
      opening,
    );
    expect(() =>
      execute(f, "sealModelInvocation", sealing, time.sealed, { readOnly: true }),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    execute(f, "sealModelInvocation", sealing, time.sealed);
    expect(() =>
      execute(
        f,
        "submitModelInvocationReceipts",
        { lease: f.lease(), invocationId: opening.scope.invocationId, receiptSet: set },
        time.submitted,
        { readOnly: true },
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
  });

  it("does not reinterpret registration disablement as mutation of a previously frozen model selection", () => {
    const f = fixture();
    handleModelRuntimeRegistryRequest(
      f.database,
      {
        operation: "changeModelRuntimeControl",
        input: {
          actor: evaluationAdministrator,
          registrationId: f.registration.id,
          request: {
            changeId: "disable-after-freeze",
            expectedVersion: 1,
            enabled: false,
            reason: "Stop future selections only.",
          },
        },
      },
      time.leased,
      [evaluationAdministrator],
    );
    expect(sealAndSubmit(f, opened(f)).submission.consistency.state).toBe("matched");
  });

  it("rejects profile-only attempts without treating them as model invocations", () => {
    const f = fixture({ modelRequired: false });
    expect(() => opened(f)).toThrow(
      expect.objectContaining({ code: "MODEL_INVOCATION_LEASE_REJECTED" }),
    );
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM model_invocation_openings").get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back an injected opening failure inside an outer transaction", () => {
    const f = fixture();
    f.database.exec(
      "CREATE TEMP TRIGGER fail_synthetic_opening AFTER INSERT ON model_invocation_openings BEGIN SELECT RAISE(ABORT, 'synthetic opening failure'); END;",
    );
    f.database.exec("BEGIN IMMEDIATE");
    const before = records(f);
    expect(() => opened(f)).toThrow("synthetic opening failure");
    expect(f.database.isTransaction).toBe(true);
    expect(records(f)).toBe(before);
    f.database.exec("COMMIT");
  });

  it.each(["openings", "seals", "submissions"] as const)(
    "enforces immutable update/delete/replace for %s",
    (suffix) => {
      const f = fixture();
      sealAndSubmit(f, opened(f));
      const before = records(f),
        table = `model_invocation_${suffix}`;
      expect(() =>
        f.database.exec(`UPDATE ${table} SET scope_sha256 = '${"0".repeat(64)}'`),
      ).toThrow();
      expect(() => f.database.exec(`DELETE FROM ${table}`)).toThrow();
      expect(() =>
        f.database.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
      ).toThrow();
      expect(records(f)).toBe(before);
    },
  );

  it("rejects lease-bearing or extra fields in the independent seal schema", () => {
    const f = fixture(),
      opening = opened(f),
      request = modelInvocationSealRequest(f.lease(), modelInvocationReceiptSet(opening));
    expect(() =>
      execute(
        f,
        "sealModelInvocation",
        {
          ...request,
          receiptSet: modelInvocationReceiptSet(opening),
        } as C.ModelInvocationSealRequest,
        time.sealed,
      ),
    ).toThrow(expect.objectContaining({ code: "MODEL_INVOCATION_INVALID" }));
  });
});
