import { DatabaseSync } from "node:sqlite";
import {
  getValidationJobResultV2Issues,
  type ValidationJobResultV1,
  type ValidationJobResultV2,
} from "@agentic-review/codex";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  beginAttempt,
  createEvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
} from "./evaluation-completion.testing.js";
import { modelInvocationFixtureTime as time } from "./model-invocations.testing.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import {
  readValidationModelResultBindingInTransaction,
  validateStoredValidationModelResultBindingInTransaction,
} from "./validation-model-result-binding.js";
import {
  createValidationModelResultBindingFixture,
  insertSyntheticStoredValidationModelResult,
  type ValidationModelResultBindingFixture,
  validationModelCompletionContext,
} from "./validation-model-result-binding.testing.js";
import {
  collectValidationCompletionEvidence,
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const fixtures: { close(): void }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(options: Parameters<typeof createValidationModelResultBindingFixture>[0] = {}) {
  const f = createValidationModelResultBindingFixture(options);
  fixtures.push(f);
  return f;
}
function readInTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN");
  try {
    return action();
  } finally {
    database.exec("ROLLBACK");
  }
}
function read(
  f: ValidationModelResultBindingFixture,
  result = f.result,
  scope = f.scope,
  now?: string,
) {
  return readInTransaction(f.database, () =>
    readValidationModelResultBindingInTransaction(f.database, scope, result, now),
  );
}
describe("V2 validation model content binding", () => {
  it.each([
    "report_summary",
    "source",
    "check",
    "cleanup",
    "diagnostic",
    "evidence",
    "observations",
  ] as const)("rejects changed frozen runner %s despite a recomputed outer digest", (field) => {
    const f = fixture(),
      result = structuredClone(f.result);
    if (field === "report_summary") result.report.summary = "A different runner snapshot.";
    if (field === "source") result.report.sourceState = "modified";
    if (field === "check") result.report.checks[0]!.summary = "Different runner check.";
    if (field === "cleanup") result.execution.cleanupState = "failed";
    if (field === "diagnostic")
      result.execution.diagnostics[0]!.summary = "Different compiler output.";
    if (field === "evidence")
      result.report.checks[0]!.evidenceIds = ["00000000-0000-0000-0000-000000000001"];
    if (field === "observations") result.probeReceipts = [];
    expect(() =>
      read(f, result, { ...f.scope, resultDigest: sha256(canonicalJson(result)) }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
  it("allows only added model-stage lifecycle observations without changing the frozen runner sequence", () => {
    const f = fixture(),
      result = structuredClone(f.result);
    result.execution.diagnostics.push({
      stepId: "model:summary",
      phase: "model_review",
      outcome: "passed",
      exitCode: null,
      summary: "The synthetic summary stage completed.",
    });
    expect(
      read(f, result, { ...f.scope, resultDigest: sha256(canonicalJson(result)) })
        ?.executionAccepted,
    ).toBe(false);
  });
  it("binds the actual raw object to independent owner records without granting execution acceptance", () => {
    const f = fixture(),
      original = canonicalJson(f.result);
    expect(getValidationJobResultV2Issues(f.result)).toEqual([]);
    const result = read(f, f.result, f.scope, time.submitted);
    expect(result).toMatchObject({
      invocationId: f.opening.scope.invocationId,
      modelOutputSha256: f.ledger.modelOutputSha256,
      collectionConsistency: { state: "matched" },
      executionAccepted: false,
    });
    expect(canonicalJson(f.result)).toBe(original);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
  it("rejects a changed raw result even if its own reference and outer digest are recomputed", () => {
    const f = fixture(),
      result = structuredClone(f.result);
    if (result.modelReview.state !== "completed") throw new Error("A model is required.");
    result.modelReview.result.summary = "Different raw content";
    result.modelReview.invocation.modelOutputSha256 = sha256(
      canonicalJson(result.modelReview.result),
    );
    expect(getValidationJobResultV2Issues(result)).toEqual([]);
    expect(() =>
      read(f, result, { ...f.scope, resultDigest: sha256(canonicalJson(result)) }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
  it.each([
    "repositoryId",
    "runId",
    "requestId",
    "jobId",
    "runAttemptId",
    "resultDigest",
    "executionDigest",
  ] as const)("rejects wrong actual %s", (field) => {
    const f = fixture();
    expect(() =>
      read(f, f.result, {
        ...f.scope,
        [field]: field.endsWith("Digest") ? "0".repeat(64) : "other",
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
  it.each(["scopeSha256", "receiptSetSha256", "invocationId"] as const)(
    "rejects a mismatched invocation %s",
    (field) => {
      const f = fixture(),
        value = structuredClone(f.result);
      if (value.modelReview.state !== "completed") throw new Error("A model is required.");
      value.modelReview.invocation[field] = field === "invocationId" ? "other" : "0".repeat(64);
      expect(() =>
        read(f, value, { ...f.scope, resultDigest: sha256(canonicalJson(value)) }),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
    },
  );
  it.each([
    { openingOnly: true },
    { sealOnly: true },
    {
      alterLedger: (set: ValidationModelResultBindingFixture["ledger"]) => {
        const call = set.calls[0];
        if (!call) throw new Error("A call is required.");
        call.sha256 = "0".repeat(64);
      },
    },
  ])("requires a complete matched stored collection", (options) => {
    const f = fixture(options);
    expect(() => read(f)).toThrow(
      expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }),
    );
  });
  it("keeps explicit Server upper bounds while allowing historical validation without an implicit clock", () => {
    const f = fixture();
    expect(read(f)?.executionAccepted).toBe(false);
    expect(() => read(f, f.result, f.scope, time.leased)).toThrow(
      expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }),
    );
  });
  it("does not admit a completed V2 model merely because the collection matches", () => {
    const f = fixture(),
      context = validationModelCompletionContext(f);
    expect(read(f)?.collectionConsistency.state).toBe("matched");
    expect(() =>
      validateValidationCompletion(f.database, context, f.scope.resultDigest, f.result),
    ).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
    expect(() =>
      collectValidationCompletionEvidence(f.database, context, f.scope.resultDigest, f.result),
    ).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
  it("validates a deliberately synthetic archived result through the actual stored row", () => {
    const f = fixture(),
      stored = insertSyntheticStoredValidationModelResult(f);
    f.database.exec("PRAGMA query_only = ON");
    expect(
      readInTransaction(f.database, () =>
        validateStoredValidationModelResultBindingInTransaction(f.database, stored),
      ),
    ).toMatchObject({ executionAccepted: false, modelOutputSha256: f.ledger.modelOutputSha256 });
    expect(() =>
      readInTransaction(f.database, () =>
        validateStoredValidationModelResultBindingInTransaction(f.database, {
          ...stored,
          resultId: "absent",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
  it("does not impose invocation-table or new transactional requirements on V1 history", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const result: ValidationJobResultV1 = {
        schemaVersion: "ValidationJobResultV1",
        report: {
          schemaVersion: "ValidationReportV1",
          source: "worker",
          workItemKind: "issue",
          summary: "Legacy",
          sourceState: "unknown",
          reproductionConclusion: "inconclusive",
          checks: [],
        },
        execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
        modelReview: { state: "not_requested" },
      };
      const scope = {
        repositoryId: "repo",
        runId: "run",
        requestId: "request",
        jobId: "job",
        runAttemptId: "attempt",
        resultDigest: sha256(canonicalJson(result)),
        executionDigest: "0".repeat(64),
      };
      expect(readValidationModelResultBindingInTransaction(database, scope, result)).toBeNull();
      expect(
        validateStoredValidationModelResultBindingInTransaction(database, {
          ...scope,
          schemaId: "ValidationJobResultV1",
          resultId: "legacy",
        }),
      ).toBeNull();
    } finally {
      database.close();
    }
  });
  it.each(["not_requested", "failed"] as const)(
    "preserves profile runner completion for V2 %s without a model binding",
    (state) => {
      const f = createEvaluationCompletionFixture();
      fixtures.push(f);
      const cell = selected(f),
        context = beginAttempt(f, cell);
      const result: ValidationJobResultV2 = {
        ...resultFor(cell),
        schemaVersion: "ValidationJobResultV2",
        modelReview:
          state === "not_requested"
            ? { state }
            : { state, code: "MODEL_UNAVAILABLE", message: "No model result was produced." },
      };
      const digest = sha256(canonicalJson(result));
      const validated = validateValidationCompletion(f.database, context, digest, result);
      expect(validated.schemaId).toBe("ValidationJobResultV2");
      transaction(f.database, () => {
        settle(f.database, context, validated);
        persistValidatedValidationResult(
          f.database,
          context,
          validated,
          "2026-09-08T04:02:00.000Z",
        );
      });
      const stored = f.database
        .prepare(
          "SELECT schema_id, result_json, result_digest FROM validation_job_results WHERE job_id = ?",
        )
        .get(cell.jobId) as { schema_id: string; result_json: string; result_digest: string };
      expect(
        decodeStoredValidationResult(stored.schema_id, stored.result_json, stored.result_digest),
      ).toEqual(result);
    },
  );
});
