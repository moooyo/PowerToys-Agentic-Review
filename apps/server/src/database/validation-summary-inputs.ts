import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { composeSummaryPrompt } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvidenceVerificationCandidate } from "./evidence-assets.js";
import {
  collectValidationRunnerEvidence,
  type ValidationCompletionOptions,
  type ValidationEvidenceReferenceScope,
  type ValidationRunnerEvidenceInput,
  validateValidationRunnerEvidence,
} from "./validation-results.js";
import {
  assertActiveValidationSummaryInputAttempt,
  readValidationSummaryInputAttemptInTransaction,
} from "./validation-summary-input-lease.js";

export interface ValidationSummaryInputOperationMap {
  freezeValidationSummaryInput: {
    input: {
      readonly workerTokenSha256: string;
      readonly request: C.FreezeValidationSummaryInputRequest;
    };
    output: C.FreezeValidationSummaryInputResponse;
  };
}
export type ValidationSummaryInputOwnerRequest =
  ValidationSummaryInputOperationMap["freezeValidationSummaryInput"]["input"];
export class ValidationSummaryInputError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_SUMMARY_INPUT_INVALID"
      | "VALIDATION_SUMMARY_INPUT_CONFLICT"
      | "VALIDATION_SUMMARY_INPUT_CORRUPT"
      | "DATABASE_READ_ONLY",
  ) {
    super(
      code === "DATABASE_READ_ONLY"
        ? "New summary inputs are unavailable during recovery maintenance."
        : "The validation summary input could not be admitted.",
    );
    this.name = "ValidationSummaryInputError";
  }
}
function fail(
  code: ValidationSummaryInputError["code"] = "VALIDATION_SUMMARY_INPUT_INVALID",
): never {
  throw new ValidationSummaryInputError(code);
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function transaction<T>(database: DatabaseSync, readOnly: boolean, work: () => T): T {
  const outer = database.isTransaction;
  if (outer && readOnly) return work();
  const savepoint = `summary_input_${randomUUID().replaceAll("-", "")}`;
  database.exec(outer ? `SAVEPOINT ${savepoint}` : readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec(outer ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    database.exec(outer ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
    if (outer) database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
interface StoredRow {
  input_id: string;
  run_attempt_id: string;
  job_id: string;
  input_json: string | null;
  input_sha256: string;
  intent_sha256: string;
  frozen_at: string;
}
const storedColumns = `input_id, run_attempt_id, job_id, input_sha256, intent_sha256, frozen_at,
 CASE WHEN length(CAST(input_json AS BLOB)) <= ${C.maximumFrozenValidationSummaryInputUtf8Bytes} THEN input_json END AS input_json`;
type Attempt = ReturnType<typeof readValidationSummaryInputAttemptInTransaction>;
export interface ValidationSummaryInputEvidenceCollection {
  readonly fingerprint: string;
  readonly runner: ValidationRunnerEvidenceInput;
  readonly scopes: readonly ValidationEvidenceReferenceScope[];
  readonly expectedStepsJsonSha256: Readonly<Record<string, string>>;
}
export interface ValidationSummaryInputEvidenceFacts extends ValidationCompletionOptions {
  readonly assertCurrent: (fingerprint: string) => void;
}
export type ValidationSummaryInputPreparation =
  | { readonly kind: "replay"; readonly response: C.FreezeValidationSummaryInputResponse }
  | { readonly kind: "verify"; readonly evidence: ValidationSummaryInputEvidenceCollection };

function intent(input: ValidationSummaryInputOwnerRequest): string {
  const { leaseToken, ...lease } = input.request.lease;
  return sha256(
    canonicalJson({
      operation: "freezeValidationSummaryInput",
      request: {
        ...input.request,
        lease: { ...lease, leaseTokenSha256: sha256(leaseToken) },
      },
    }),
  );
}
function document(
  attempt: Attempt,
  input: Pick<C.FreezeValidationSummaryInputRequest, "inputId" | "context">,
  now: string,
): C.FrozenValidationSummaryInputV1 {
  const { cell } = attempt.frozen;
  const contextJson = canonicalJson(input.context);
  const result: C.FrozenValidationSummaryInputV1 = {
    schemaVersion: "FrozenValidationSummaryInputV1",
    inputId: input.inputId,
    repositoryId: cell.repositoryId,
    evaluationId: cell.evaluationId,
    cellId: cell.cellId,
    authorizationId: cell.plan.authorization.id,
    executionManifestSha256: cell.plan.purpose.executionManifestSha256,
    workerNodeId: attempt.attempt.worker_node_id,
    workerInstanceId: attempt.attempt.worker_instance_id,
    leaseGeneration: attempt.attempt.lease_generation,
    sourcePromptSha256: cell.prompt.promptSha256,
    outputSchemaSha256: cell.prompt.outputSchemaSha256,
    contextSha256: sha256(contextJson),
    actualPromptSha256: sha256(composeSummaryPrompt(cell.prompt.renderedPrompt, contextJson)),
    context: input.context,
    frozenAt: now,
  };
  if (C.getFrozenValidationSummaryInputIssues(result).length) fail();
  return result;
}
function response(value: C.FrozenValidationSummaryInputV1): C.FreezeValidationSummaryInputResponse {
  return {
    schemaVersion: "FreezeValidationSummaryInputResponseV1",
    frozenAt: value.frozenAt,
    reference: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: value.inputId,
      inputSha256: sha256(canonicalJson(value)),
      sourcePromptSha256: value.sourcePromptSha256,
      outputSchemaSha256: value.outputSchemaSha256,
      contextSha256: value.contextSha256,
      actualPromptSha256: value.actualPromptSha256,
    },
  };
}

/** Historical reads retain the original input bytes; they never grant new execution authority. */
export function readFrozenValidationSummaryInputInTransaction(
  database: DatabaseSync,
  inputId: string,
): { document: C.FrozenValidationSummaryInputV1; inputSha256: string } | null {
  if (!database.isTransaction) fail();
  const row = database
    .prepare(`SELECT ${storedColumns} FROM model_summary_inputs WHERE input_id = ?`)
    .get(inputId) as StoredRow | undefined;
  if (!row) return null;
  let value: C.FrozenValidationSummaryInputV1;
  try {
    value = JSON.parse(row.input_json ?? "null") as C.FrozenValidationSummaryInputV1;
  } catch {
    return fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  }
  if (
    C.getFrozenValidationSummaryInputIssues(value).length ||
    canonicalJson(value) !== row.input_json ||
    sha256(row.input_json ?? "") !== row.input_sha256 ||
    value.inputId !== row.input_id ||
    value.context.jobId !== row.job_id ||
    value.context.runAttemptId !== row.run_attempt_id ||
    value.frozenAt !== row.frozen_at ||
    sha256(canonicalJson(value.context)) !== value.contextSha256
  )
    fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  return { document: value, inputSha256: row.input_sha256 };
}

function runnerInput(
  attempt: Attempt,
  context: C.ValidationSummaryContextV1,
): ValidationRunnerEvidenceInput {
  // The shared lease reader has already verified these original bytes and their sealed V2 binding.
  const template = JSON.parse(attempt.attempt.execution_json as string) as C.JobExecutionTemplateV2;
  const validation = template.validation;
  if (
    !["pr_ui", "issue_validation"].includes(validation.workflowKind) ||
    context.runId !== validation.runId ||
    context.requestId !== validation.requestId ||
    context.githubRepositoryId !== template.repository.githubRepositoryId ||
    context.profileVersionId !== validation.profileVersion.id ||
    context.planDigest !== validation.planDigest ||
    context.revisionKey !== validation.revisionKey ||
    !equal(context.testedSourceRevision, validation.testedSourceRevision) ||
    !equal(context.reproduction ?? null, validation.reproduction ?? null) ||
    context.report.workItemKind !== template.resource.kind ||
    context.report.source !== "worker"
  )
    fail();
  return {
    template,
    request: attempt.frozen.cell.request,
    jobId: context.jobId,
    runAttemptId: context.runAttemptId,
    result: { report: context.report, execution: context.execution, ...context.observationResults },
  };
}
function collect(
  database: DatabaseSync,
  runner: ValidationRunnerEvidenceInput,
  context: C.ValidationSummaryContextV1,
  fingerprint: string,
): ValidationSummaryInputEvidenceCollection {
  const scopes = collectValidationRunnerEvidence(runner);
  const expectedStepsJsonSha256: Record<string, string> = {};
  const actualIds = new Set<string>();
  const scenarioChecks = new Set<string>();
  for (const scope of scopes) {
    const steps: string[] = [];
    for (const assetId of scope.evidenceIds) {
      if (actualIds.has(assetId)) fail();
      actualIds.add(assetId);
      const candidate = readEvidenceVerificationCandidate(database, { ...scope, assetId });
      if (candidate === null) fail();
      const { checkId: _checkId, ...assetScope } = candidate.asset.scope;
      const expected = {
        id: assetId,
        ...assetScope,
        metadata: candidate.asset.metadata,
        state: "finalized",
        createdAt: candidate.metadataToken.createdAt,
        finalizedAt: candidate.metadataToken.finalizedAt,
        retiredAt: null,
      };
      const submitted = context.evidence.assets.find((asset) => asset.id === assetId);
      if (candidate.asset.state !== "finalized" || !equal(expected, submitted ?? null)) fail();
      if (candidate.asset.metadata.kind === "steps") steps.push(assetId);
    }
    const scenario = context.evidence.scenarios.find((item) => item.checkId === scope.checkId);
    if (scenario) {
      const check = context.report.checks.find((item) => item.id === scope.checkId);
      if (
        check?.kind !== "ui" ||
        steps.length !== 1 ||
        !runner.request.profileVersion?.config.ui?.scenarios.some(
          (item) => `${context.profileVersionId}:${item.id}` === scope.checkId,
        )
      )
        fail();
      expectedStepsJsonSha256[steps[0] as string] = sha256(canonicalJson(scenario.execution));
      scenarioChecks.add(scope.checkId);
    } else if (steps.length !== 0) fail();
  }
  if (
    actualIds.size !== context.evidence.assets.length ||
    scenarioChecks.size !== context.evidence.scenarios.length
  )
    fail();
  return { fingerprint, runner, scopes, expectedStepsJsonSha256 };
}
function prepare(
  database: DatabaseSync,
  input: ValidationSummaryInputOwnerRequest,
  now: string,
  readOnly: boolean,
): ValidationSummaryInputPreparation & { readonly attempt?: Attempt } {
  if (
    !input ||
    Object.keys(input).length !== 2 ||
    typeof input.workerTokenSha256 !== "string" ||
    !/^[a-f0-9]{64}(?![\s\S])/u.test(input.workerTokenSha256) ||
    C.getFreezeValidationSummaryInputRequestIssues(input.request).length
  )
    fail();
  const attempt = readValidationSummaryInputAttemptInTransaction(
    database,
    { workerTokenSha256: input.workerTokenSha256, lease: input.request.lease },
    now,
  );
  const runner = runnerInput(attempt, input.request.context);
  const old = database
    .prepare(
      `SELECT ${storedColumns} FROM model_summary_inputs WHERE input_id = ? OR run_attempt_id = ?`,
    )
    .all(input.request.inputId, input.request.lease.runAttemptId) as unknown as StoredRow[];
  const fingerprint = intent(input);
  if (old.length) {
    if (
      old.length !== 1 ||
      old[0]?.intent_sha256 !== fingerprint ||
      old[0].input_id !== input.request.inputId ||
      old[0].run_attempt_id !== input.request.lease.runAttemptId
    )
      fail("VALIDATION_SUMMARY_INPUT_CONFLICT");
    const saved = readFrozenValidationSummaryInputInTransaction(database, input.request.inputId);
    if (
      !saved ||
      saved.document.frozenAt > now ||
      !equal(saved.document, document(attempt, input.request, saved.document.frozenAt))
    )
      fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
    return { kind: "replay", response: response(saved.document) };
  }
  if (readOnly) fail("DATABASE_READ_ONLY");
  assertActiveValidationSummaryInputAttempt(attempt, now);
  return {
    kind: "verify",
    evidence: collect(database, runner, input.request.context, fingerprint),
    attempt,
  };
}
export function prepareValidationSummaryInput(
  database: DatabaseSync,
  input: ValidationSummaryInputOwnerRequest,
  now: string,
  options: { readonly readOnly?: boolean } = {},
): ValidationSummaryInputPreparation {
  return transaction(database, options.readOnly === true, () =>
    prepare(database, input, now, options.readOnly === true),
  );
}
export function freezeValidationSummaryInput(
  database: DatabaseSync,
  input: ValidationSummaryInputOwnerRequest,
  now: string,
  options: {
    readonly readOnly?: boolean;
    readonly evidence?: ValidationSummaryInputEvidenceFacts;
  } = {},
): C.FreezeValidationSummaryInputResponse {
  return transaction(database, options.readOnly === true, () => {
    const prepared = prepare(database, input, now, options.readOnly === true);
    if (prepared.kind === "replay") return prepared.response;
    if (!prepared.attempt) fail();
    if (prepared.evidence.scopes.length && !options.evidence) fail();
    options.evidence?.assertCurrent(prepared.evidence.fingerprint);
    validateValidationRunnerEvidence(prepared.evidence.runner, options.evidence ?? {});
    const frozen = document(prepared.attempt, input.request, now),
      serialized = canonicalJson(frozen);
    database
      .prepare(`INSERT INTO model_summary_inputs
      (input_id, run_attempt_id, job_id, repository_id, evaluation_id, cell_id, run_id, request_id, worker_node_id, worker_instance_id,
       lease_generation, input_json, input_sha256, intent_sha256, frozen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        frozen.inputId,
        frozen.context.runAttemptId,
        frozen.context.jobId,
        frozen.repositoryId,
        frozen.evaluationId,
        frozen.cellId,
        frozen.context.runId,
        frozen.context.requestId,
        frozen.workerNodeId,
        frozen.workerInstanceId,
        frozen.leaseGeneration,
        serialized,
        sha256(serialized),
        prepared.evidence.fingerprint,
        now,
      );
    return response(frozen);
  });
}
