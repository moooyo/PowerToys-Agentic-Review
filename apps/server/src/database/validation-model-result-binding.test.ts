import { DatabaseSync } from "node:sqlite";
import {
  getValidationJobResultIssues,
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
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { evaluationAdministrator } from "./evaluation-management.testing.js";
import { modelCliFixtureTime as time } from "./model-cli.testing.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import {
  readValidationModelResultBindingInTransaction,
  validateStoredValidationModelResultBindingInTransaction,
} from "./validation-model-result-binding.js";
import {
  completeValidationModelResultFixture,
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
  it.each(["codex", "copilot"] as const)(
    "binds direct %s CLI review without a summary record",
    (kind) => {
      const f = fixture({ kind: "pull_request" });
      if (f.result.modelReview.state !== "completed") throw new Error("A CLI review is required.");
      f.result.modelReview.execution.cli = { kind, version: "fixture-cli", requestedModel: null };
      expect(
        read(f, f.result, { ...f.scope, resultDigest: sha256(canonicalJson(f.result)) }),
      ).toEqual({ execution: f.result.modelReview.execution });
      expect(f.result.modelReview.execution).not.toHaveProperty("summaryInputRef");
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM model_summary_inputs").get(),
      ).toEqual({ count: 0 });
    },
  );
  it("rejects an unrelated summary reference on direct CLI review", () => {
    const f = fixture({ kind: "pull_request" });
    const summary = fixture();
    if (f.result.modelReview.state !== "completed" || summary.summaryInput === null)
      throw new Error("Both synthetic result contexts are required.");
    f.result.modelReview.execution.summaryInputRef = {
      ...summary.summaryInput,
      sourcePromptSha256: f.cell.prompt.promptSha256,
      actualPromptSha256: f.cell.prompt.promptSha256,
      outputSchemaSha256: f.cell.prompt.outputSchemaSha256,
    };
    expect(() =>
      read(f, f.result, { ...f.scope, resultDigest: sha256(canonicalJson(f.result)) }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
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
      read(f, result, { ...f.scope, resultDigest: sha256(canonicalJson(result)) })?.execution,
    ).toEqual(result.modelReview.state === "completed" ? result.modelReview.execution : null);
  });
  it("binds the raw CLI output to the actual task and frozen input", () => {
    const f = fixture(),
      original = canonicalJson(f.result);
    expect(getValidationJobResultV2Issues(f.result)).toEqual([]);
    const result = read(f, f.result, f.scope, time.submitted);
    expect(result).toEqual({
      execution: f.result.modelReview.state === "completed" ? f.result.modelReview.execution : null,
    });
    expect(canonicalJson(f.result)).toBe(original);
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
  it("accepts current Worker output when its raw content and hashes are consistent", () => {
    const f = fixture(),
      result = structuredClone(f.result);
    if (result.modelReview.state !== "completed") throw new Error("A model is required.");
    result.modelReview.result.summary = "Different raw content";
    result.modelReview.execution.outputSha256 = sha256(canonicalJson(result.modelReview.result));
    expect(getValidationJobResultV2Issues(result)).toEqual([]);
    expect(read(f, result, { ...f.scope, resultDigest: sha256(canonicalJson(result)) })).toEqual({
      execution: result.modelReview.execution,
    });
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
  it.each(["jobId", "runAttemptId", "promptSha256", "outputSchemaSha256", "outputSha256"] as const)(
    "rejects mismatched CLI execution %s",
    (field) => {
      const f = fixture(),
        value = structuredClone(f.result);
      if (value.modelReview.state !== "completed") throw new Error("A model is required.");
      value.modelReview.execution[field] = field.endsWith("Sha256") ? "0".repeat(64) : "other";
      expect(() =>
        read(f, value, { ...f.scope, resultDigest: sha256(canonicalJson(value)) }),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
    },
  );
  it.each(["missing", "inputId", "inputSha256", "contextSha256"] as const)(
    "rejects a %s frozen summary input reference",
    (field) => {
      const f = fixture(),
        value = structuredClone(f.result);
      if (value.modelReview.state !== "completed") throw new Error("A model is required.");
      const execution = value.modelReview.execution;
      if (field === "missing") delete execution.summaryInputRef;
      else {
        if (!execution.summaryInputRef) throw new Error("A summary input is required.");
        execution.summaryInputRef[field] = field === "inputId" ? "other" : "0".repeat(64);
      }
      expect(() =>
        read(f, value, { ...f.scope, resultDigest: sha256(canonicalJson(value)) }),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
    },
  );
  it("keeps explicit Server upper bounds while allowing historical validation without an implicit clock", () => {
    const f = fixture();
    expect(read(f)?.execution.summaryInputRef).toEqual(f.summaryInput);
    expect(() => read(f, f.result, f.scope, time.leased)).toThrow(
      expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }),
    );
  });
  it("persists a completed V2 model with its frozen runner input and CLI metadata", () => {
    const f = fixture(),
      context = validationModelCompletionContext(f);
    expect(read(f)?.execution.summaryInputRef).toEqual(f.summaryInput);
    expect(
      collectValidationCompletionEvidence(f.database, context, f.scope.resultDigest, f.result)
        .result,
    ).toEqual(f.result);
    const stored = completeValidationModelResultFixture(f);
    expect(
      readInTransaction(f.database, () =>
        validateStoredValidationModelResultBindingInTransaction(f.database, stored),
      ),
    ).toEqual({
      execution: f.result.modelReview.state === "completed" ? f.result.modelReview.execution : null,
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 1 });
  });
  it.each(["summary", "legacy_review"] as const)(
    "rejects a V1 %s without CLI task metadata on a model-backed evaluation",
    (kind) => {
      const f = fixture(),
        context = validationModelCompletionContext(f);
      if (f.result.report.workItemKind !== "issue") throw new Error("An Issue is required.");
      const result: ValidationJobResultV1 = {
        schemaVersion: "ValidationJobResultV1",
        report: { ...f.result.report },
        execution: f.result.execution,
        modelReview: { state: "not_requested" },
      };
      if (kind === "summary") {
        result.report.modelSummary = {
          schemaVersion: "ValidationSummaryV1",
          workItemKind: "issue",
          summary: "Synthetic unbound advice.",
          observations: [],
          reproductionConclusion: "inconclusive",
        };
      } else {
        result.modelReview = {
          state: "completed",
          result: {
            schemaVersion: "IssueTriageV2",
            summary: "Synthetic unbound triage.",
            category: "bug",
            priority: 1,
            confidence: 0.9,
            suggestedLabels: [],
            missingInformation: [],
            duplicateCandidates: [],
            requestedRecipeIds: [],
            verification: { status: "not_run", summary: "No commands ran.", commands: [] },
            executionEvidence: {
              schemaVersion: "ReviewExecutionEvidenceV1",
              source: "worker",
              commandCapture: "complete",
              commands: [],
              worktree: { status: "unknown", source: "not_observed" },
            },
          },
        };
      }
      expect(getValidationJobResultIssues(result)).toEqual([]);
      const digest = sha256(canonicalJson(result));
      const rejected = expect.objectContaining({
        code: "REVIEW_RESULT_INVALID",
        message: "Model-backed evaluations require a V2 result bound to its CLI execution.",
      });
      expect(() => validateValidationCompletion(f.database, context, digest, result)).toThrow(
        rejected,
      );
      expect(() =>
        collectValidationCompletionEvidence(f.database, context, digest, result),
      ).toThrow(rejected);
      expect(
        f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
      ).toEqual({ count: 0 });
    },
  );
  it.each(["cancel", "worker_superseded", "attempt_changed"] as const)(
    "rechecks %s before persisting a bound model result",
    (change) => {
      const f = fixture(),
        context = validationModelCompletionContext(f),
        validated = validateValidationCompletion(
          f.database,
          context,
          f.scope.resultDigest,
          f.result,
        );
      f.database.exec("BEGIN IMMEDIATE");
      try {
        if (change === "cancel") {
          cancelEvaluationBatchInTransaction(
            f.database,
            {
              repositoryId: f.repositoryId,
              evaluationId: f.batch.id,
              actor: evaluationAdministrator,
              request: {
                changeId: "cancel-bound-model-result",
                expectedVersion: 1,
                reason: "Cancel the synthetic evaluation.",
              },
            },
            "2026-09-08T04:02:00.000Z",
            [evaluationAdministrator],
          );
        } else {
          settle(f.database, context, validated);
          if (change === "worker_superseded")
            f.database
              .prepare("UPDATE workers SET superseded_at = ? WHERE id = 'cli-worker'")
              .run("2026-09-08T04:02:00.000Z");
          else
            f.database
              .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
              .run(context.jobId);
        }
        expect(() =>
          persistValidatedValidationResult(
            f.database,
            context,
            validated,
            "2026-09-08T04:02:00.000Z",
          ),
        ).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
        expect(
          f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
        ).toEqual({ count: 0 });
      } finally {
        f.database.exec("ROLLBACK");
      }
    },
  );
  it("validates a deliberately synthetic archived result through the actual stored row", () => {
    const f = fixture(),
      stored = insertSyntheticStoredValidationModelResult(f);
    f.database.exec("PRAGMA query_only = ON");
    expect(
      readInTransaction(f.database, () =>
        validateStoredValidationModelResultBindingInTransaction(f.database, stored),
      ),
    ).toMatchObject({
      execution: {
        outputSha256:
          f.result.modelReview.state === "completed"
            ? f.result.modelReview.execution.outputSha256
            : null,
      },
    });
    expect(() =>
      readInTransaction(f.database, () =>
        validateStoredValidationModelResultBindingInTransaction(f.database, {
          ...stored,
          resultId: "absent",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_MODEL_RESULT_BINDING_INVALID" }));
  });
  it("does not impose CLI metadata or new transactional requirements on V1 history", () => {
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
    "preserves required-model V2 %s diagnostics without claiming a completed model",
    (state) => {
      const f = fixture();
      const result: ValidationJobResultV2 = {
        ...f.result,
        modelReview:
          state === "not_requested"
            ? { state }
            : { state, code: "MODEL_UNAVAILABLE", message: "No model result was produced." },
      };
      const scope = { ...f.scope, resultDigest: sha256(canonicalJson(result)) };
      const stored = completeValidationModelResultFixture({ ...f, result, scope });
      expect(
        readInTransaction(f.database, () =>
          validateStoredValidationModelResultBindingInTransaction(f.database, stored),
        ),
      ).toBeNull();
      expect(
        f.database
          .prepare("SELECT result_json FROM validation_job_results WHERE id = ?")
          .get(stored.resultId),
      ).toEqual({ result_json: canonicalJson(result) });
    },
  );
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
