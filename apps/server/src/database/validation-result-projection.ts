import type { DatabaseSync } from "node:sqlite";
import {
  getValidationModelSummary,
  getValidationReviewModel,
  type ValidationJobResult,
} from "@agentic-review/codex";
import {
  type DashboardValidationModelReview,
  EntityIdSchema,
  type ReproductionObservationFact,
  UiScenarioExecutionEvidenceV1Schema,
  type UiScenarioStep,
  type UiStepExecutionEvidence,
  type ValidationCheckResult,
  type ValidationReportV1,
  WebUiScenarioSchema,
  WindowsUiScenarioSchema,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type EvidenceStorageOptions,
  finalizedEvidenceReferences,
  handleEvidenceAssetRequest,
} from "./evidence-assets.js";
import type { PreparedRunEvidence } from "./evidence-verification.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

export interface ValidationEvidenceRunScope {
  readonly id: string;
  readonly repositoryId: string;
  readonly revisionKey: string;
  readonly planDigest: string;
}
export interface ValidationEvidenceJobScope {
  readonly jobId: string;
}
export interface ValidationEvidenceResultScope {
  readonly runAttemptId: string;
  readonly profileVersionId: string;
  readonly evidenceComplete: number;
}

/** Internal callbacks must be bound to the same coordinator-issued prepared evidence token. */
export interface VerifiedValidationEvidenceFacts {
  readonly profiles: readonly PreparedRunEvidence["profiles"][number][];
  readonly assertCurrent: () => void;
  readonly admittedEvidenceReferences: (scope: ValidationEvidenceReferenceScope) => boolean;
  readonly admittedScenarioEvidence: (scope: ValidationEvidenceReferenceScope) => boolean;
  readonly admittedScenarioObservations?: (
    scope: ValidationEvidenceReferenceScope,
  ) => readonly ReproductionObservationFact[] | null;
}

type VerificationStatus = "verified" | "pending" | "unavailable";
export type ValidationEvidenceProjectionContext =
  // Direct storage is retained only for compatibility tests. Production reads use prepared facts.
  | { readonly kind: "direct"; readonly storage?: EvidenceStorageOptions }
  | {
      readonly kind: "prepared";
      readonly facts?: VerifiedValidationEvidenceFacts;
      readonly statuses: ReadonlyMap<string, VerificationStatus>;
    };

export const verificationKey = (requestId: string, jobId: string): string =>
  `${requestId}\0${jobId}`;
const VerificationProfilesSchema = Type.Array(
  Type.Object(
    {
      requestId: EntityIdSchema,
      jobId: EntityIdSchema,
      status: Type.Union([
        Type.Literal("verified"),
        Type.Literal("pending"),
        Type.Literal("unavailable"),
      ]),
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  { maxItems: 32 },
);

export function verificationStatuses(
  facts: VerifiedValidationEvidenceFacts | undefined,
): ReadonlyMap<string, VerificationStatus> {
  const statuses = new Map<string, VerificationStatus>();
  if (facts === undefined || !Value.Check(VerificationProfilesSchema, facts.profiles))
    return statuses;
  for (const profile of facts.profiles) {
    const key = verificationKey(profile.requestId, profile.jobId);
    statuses.set(key, statuses.has(key) ? "unavailable" : profile.status);
  }
  return statuses;
}

function preparedAdmission(
  callback: ((scope: ValidationEvidenceReferenceScope) => boolean) | undefined,
  scope: ValidationEvidenceReferenceScope,
): boolean {
  try {
    return callback?.(scope) === true;
  } catch {
    return false;
  }
}

// Retain the existing read-projection diagnostics when a persisted UI evidence policy is corrupt.
class ReviewRunQueryError extends Error {
  readonly code = "PLATFORM_CORRUPT";
  constructor() {
    super("The stored review run projection is invalid.");
    this.name = "ReviewRunQueryError";
  }
}
function parsed<T extends TSchema>(schema: T, value: string | null): Static<T> {
  if (value !== null) {
    try {
      const result: unknown = JSON.parse(value);
      if (Value.Check(schema, result)) return result;
    } catch {}
  }
  throw new ReviewRunQueryError();
}

export function normalizedValidationModel(
  result: ValidationJobResult,
  workflowKind: WorkflowKind,
): DashboardValidationModelReview {
  const summary = getValidationModelSummary(result);
  const review = result.modelReview;
  const model = getValidationReviewModel(result);
  const base: DashboardValidationModelReview = {
    state: review.state,
    summary: null,
    recommendation: null,
    findings: [],
    observations: summary?.observations ?? [],
    issueTriage: null,
    reproductionConclusion: null,
    error: review.state === "failed" ? { code: review.code, message: review.message } : null,
    execution:
      result.schemaVersion === "ValidationJobResultV2" && result.modelReview.state === "completed"
        ? result.modelReview.execution
        : null,
  };
  if (model !== null) {
    if (model.schemaVersion === "PrReviewPlanV2")
      return {
        ...base,
        summary: model.summary,
        recommendation: model.assessment,
        findings: model.findings.map((finding, ordinal) => ({ ...finding, ordinal })),
      };
    const triage = model;
    return {
      ...base,
      summary: triage.summary,
      issueTriage: {
        category: triage.category,
        priority: triage.priority,
        confidence: triage.confidence,
        suggestedLabels: triage.suggestedLabels,
        missingInformation: triage.missingInformation,
        duplicateCandidates: triage.duplicateCandidates,
      },
    };
  }
  if (
    summary !== null &&
    review.state !== "failed" &&
    ["pr_ui", "issue_validation"].includes(workflowKind)
  )
    return {
      ...base,
      state: "completed",
      summary: summary.summary,
      recommendation: summary.workItemKind === "pull_request" ? summary.recommendation : null,
      reproductionConclusion:
        summary.workItemKind === "issue" ? summary.reproductionConclusion : null,
    };
  return base;
}

/** The display report excludes model prose without rewriting the immutable Worker envelope. */
export function normalizedValidationReport(result: ValidationJobResult): ValidationReportV1 {
  if (result.schemaVersion !== "ValidationJobResultV1") return result.report;
  const { modelSummary: _modelSummary, ...report } = result.report;
  return report;
}

interface EvidenceRow {
  id: string;
  kind: string;
  checkId: string | null;
  sizeBytes: number;
}

const maximumUiStepEvidenceBytes = 512 * 1024;

function matchesFrozenObservation(
  planned: UiScenarioStep,
  actual: UiStepExecutionEvidence,
): boolean {
  if (
    actual.stepId !== planned.id ||
    actual.name !== planned.name ||
    actual.action !== planned.action
  )
    return false;
  switch (planned.action) {
    case "click":
    case "fill":
      return actual.expected === null && actual.actual === null;
    case "assertVisible":
      return (
        actual.action === "assertVisible" &&
        actual.expected === planned.expected &&
        (actual.outcome !== "passed" || actual.actual === planned.expected)
      );
    case "assertValue":
      return (
        actual.action === "assertValue" &&
        actual.expected === planned.expected &&
        (actual.outcome !== "passed" || actual.actual === planned.expected)
      );
    case "assertText":
      return (
        actual.action === "assertText" &&
        actual.expected === planned.expected &&
        (actual.outcome !== "passed" ||
          (typeof actual.actual === "string" &&
            (planned.match === "contains"
              ? actual.actual.includes(planned.expected)
              : actual.actual === planned.expected)))
      );
  }
}

function validUiStepEvidence(
  database: DatabaseSync,
  run: ValidationEvidenceRunScope,
  requestId: string,
  job: ValidationEvidenceJobScope,
  row: ValidationEvidenceResultScope,
  check: ValidationCheckResult,
  scenarioJson: string,
  target: string,
  everyAssertionScreenshot: boolean,
  byId: ReadonlyMap<string, EvidenceRow>,
  options: EvidenceStorageOptions,
): boolean {
  try {
    if (target !== "web" && target !== "windows_desktop") return false;
    const scenario: unknown = JSON.parse(scenarioJson);
    const schema = target === "web" ? WebUiScenarioSchema : WindowsUiScenarioSchema;
    if (!Value.Check(schema, scenario)) return false;
    if (new Set(scenario.steps.map((step) => step.id)).size !== scenario.steps.length) return false;
    const stepAssets = check.evidenceIds
      .map((id) => byId.get(id))
      .filter((asset) => asset?.kind === "steps");
    if (stepAssets.length === 0) return false;
    for (const asset of stepAssets) {
      if (
        asset === undefined ||
        asset.sizeBytes < 1 ||
        asset.sizeBytes > maximumUiStepEvidenceBytes
      )
        return false;
      const response = handleEvidenceAssetRequest(
        database,
        {
          operation: "readEvidenceAssetChunk",
          input: {
            repositoryId: run.repositoryId,
            runId: run.id,
            jobId: job.jobId,
            runAttemptId: row.runAttemptId,
            assetId: asset.id,
            offset: 0,
            maximumBytes: maximumUiStepEvidenceBytes,
          },
        },
        new Date().toISOString(),
        options,
      );
      if (
        response === null ||
        !("base64" in response) ||
        !response.eof ||
        response.offset !== 0 ||
        response.manifest.metadata.kind !== "steps" ||
        response.manifest.metadata.mediaType !== "application/json" ||
        response.manifest.requestId !== requestId ||
        response.manifest.profileVersionId !== row.profileVersionId ||
        response.manifest.metadata.checkId !== check.id
      )
        return false;
      const bytes = Buffer.from(response.base64, "base64");
      if (bytes.length !== asset.sizeBytes || bytes.length > maximumUiStepEvidenceBytes)
        return false;
      const evidence: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        !Value.Check(UiScenarioExecutionEvidenceV1Schema, evidence) ||
        evidence.target !== target ||
        evidence.scenarioId !== scenario.id ||
        evidence.steps.length !== scenario.steps.length
      )
        return false;
      const assignedScreenshots = new Set<string>();
      for (let index = 0; index < scenario.steps.length; index++) {
        const planned = scenario.steps[index];
        const actual = evidence.steps[index];
        if (
          planned === undefined ||
          actual === undefined ||
          !matchesFrozenObservation(planned, actual) ||
          (check.outcome === "passed" && actual.outcome !== "passed")
        )
          return false;
        for (const id of actual.evidenceIds) {
          const screenshot = byId.get(id);
          if (
            screenshot?.kind !== "screenshot" ||
            screenshot.checkId !== check.id ||
            !check.evidenceIds.includes(id) ||
            assignedScreenshots.has(id)
          )
            return false;
          assignedScreenshots.add(id);
        }
        if (
          everyAssertionScreenshot &&
          planned.action.startsWith("assert") &&
          actual.outcome === "passed" &&
          actual.evidenceIds.length === 0
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Checks current evidence for an already selected result. The caller owns result admission and
 * consumes facts.assertCurrent() inside its transaction before using this projection. */
export function currentValidationEvidence(
  database: DatabaseSync,
  run: ValidationEvidenceRunScope,
  requestId: string,
  job: ValidationEvidenceJobScope,
  row: ValidationEvidenceResultScope,
  result: ValidationJobResult,
  evidenceContext: ValidationEvidenceProjectionContext,
): boolean {
  if (
    evidenceContext.kind === "prepared" &&
    evidenceContext.statuses.get(verificationKey(requestId, job.jobId)) !== "verified"
  )
    return false;
  if (row.evidenceComplete !== 1) return false;
  const assets = database
    .prepare(`SELECT id, kind, check_id AS checkId, size_bytes AS sizeBytes FROM evidence_assets
    WHERE repository_id = ? AND review_run_id = ? AND request_id = ? AND job_id = ? AND run_attempt_id = ?
      AND profile_version_id = ? AND revision_key = ? AND plan_digest = ?
      AND state = 'finalized' AND committed_bytes = size_bytes LIMIT 257`)
    .all(
      run.repositoryId,
      run.id,
      requestId,
      job.jobId,
      row.runAttemptId,
      row.profileVersionId,
      run.revisionKey,
      run.planDigest,
    ) as unknown as EvidenceRow[];
  if (assets.length > 256) return false;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const check of result.report.checks) {
    if (check.evidenceIds.some((id) => byId.get(id)?.checkId !== check.id)) return false;
    if (
      check.evidenceIds.some((id) => {
        const asset = byId.get(id);
        return (
          asset?.kind === "steps" &&
          (asset.sizeBytes < 1 || asset.sizeBytes > maximumUiStepEvidenceBytes)
        );
      })
    )
      return false;
    if (
      evidenceContext.kind === "prepared" &&
      check.evidenceIds.length > 0 &&
      !preparedAdmission(evidenceContext.facts?.admittedEvidenceReferences, {
        repositoryId: run.repositoryId,
        runId: run.id,
        requestId,
        jobId: job.jobId,
        runAttemptId: row.runAttemptId,
        profileVersionId: row.profileVersionId,
        checkId: check.id,
        evidenceIds: check.evidenceIds,
      })
    )
      return false;
    if (
      evidenceContext.kind === "direct" &&
      evidenceContext.storage !== undefined &&
      check.evidenceIds.length > 0 &&
      !finalizedEvidenceReferences(
        database,
        {
          repositoryId: run.repositoryId,
          runId: run.id,
          requestId,
          jobId: job.jobId,
          runAttemptId: row.runAttemptId,
          profileVersionId: row.profileVersionId,
          checkId: check.id,
          evidenceIds: check.evidenceIds,
        },
        evidenceContext.storage,
      )
    )
      return false;
    // A scenario needs its structured step evidence; a screenshot alone cannot prove assertions.
    if (check.kind === "ui" && !check.evidenceIds.some((id) => byId.get(id)?.kind === "steps"))
      return false;
  }
  const request = database
    .prepare(`SELECT target, json_extract(request_json, '$.profileVersion.config.ui.target') AS uiTarget,
    json_extract(request_json, '$.profileVersion.config.ui.evidence') AS policyJson
    FROM review_run_requests WHERE review_run_id = ? AND request_id = ?`)
    .get(run.id, requestId) as {
    target: string;
    uiTarget: string | null;
    policyJson: string | null;
  };
  if (request.target !== "headless") {
    const scenarios = database
      .prepare(`SELECT json_extract(scenario.value, '$.id') AS id, scenario.value AS scenarioJson,
      (SELECT COUNT(*) FROM json_each(scenario.value, '$.steps') AS step
        WHERE json_extract(step.value, '$.action') IN ('assertVisible', 'assertText', 'assertValue')) AS assertionCount
      FROM review_run_requests AS request, json_each(request.request_json, '$.profileVersion.config.ui.scenarios') AS scenario
      WHERE request.review_run_id = ? AND request.request_id = ? LIMIT 33`)
      .all(run.id, requestId) as unknown as {
      id: string;
      assertionCount: number;
      scenarioJson: string;
    }[];
    if (scenarios.length === 0 || scenarios.length > 32 || request.policyJson === null)
      return false;
    const policy = parsed(
      Type.Object(
        {
          screenshots: Type.Union([Type.Literal("on_failure"), Type.Literal("every_assertion")]),
          screenshotScope: Type.Union([Type.Literal("viewport"), Type.Literal("owned_window")]),
          trace: Type.Optional(
            Type.Union([Type.Literal("on_failure"), Type.Literal("always"), Type.Literal("off")]),
          ),
          required: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
      request.policyJson,
    );
    for (const scenario of scenarios) {
      const check = result.report.checks.find(
        (candidate) =>
          candidate.id === `${row.profileVersionId}:${scenario.id}` && candidate.kind === "ui",
      );
      if (check === undefined || scenario.assertionCount < 1) return false;
      if (evidenceContext.kind === "prepared") {
        if (request.uiTarget !== request.target) return false;
        try {
          const frozen: unknown = JSON.parse(scenario.scenarioJson);
          const schema = request.target === "web" ? WebUiScenarioSchema : WindowsUiScenarioSchema;
          if (
            !Value.Check(schema, frozen) ||
            new Set(frozen.steps.map((step) => step.id)).size !== frozen.steps.length
          )
            return false;
        } catch {
          return false;
        }
        if (
          !preparedAdmission(evidenceContext.facts?.admittedScenarioEvidence, {
            repositoryId: run.repositoryId,
            runId: run.id,
            requestId,
            jobId: job.jobId,
            runAttemptId: row.runAttemptId,
            profileVersionId: row.profileVersionId,
            checkId: check.id,
            evidenceIds: check.evidenceIds,
          })
        )
          return false;
      }
      if (
        evidenceContext.kind === "direct" &&
        evidenceContext.storage !== undefined &&
        (request.uiTarget !== request.target ||
          !validUiStepEvidence(
            database,
            run,
            requestId,
            job,
            row,
            check,
            scenario.scenarioJson,
            request.target,
            policy.screenshots === "every_assertion",
            byId,
            evidenceContext.storage,
          ))
      )
        return false;
      const evidence = check.evidenceIds.map((id) => byId.get(id));
      if (!evidence.some((asset) => asset?.kind === "steps")) return false;
      const screenshots = evidence.filter((asset) => asset?.kind === "screenshot").length;
      if (
        policy.screenshots === "every_assertion" &&
        check.outcome === "passed" &&
        screenshots < scenario.assertionCount
      )
        return false;
      if (check.outcome === "failed" && screenshots < 1) return false;
      if (
        request.target === "web" &&
        (policy.trace === "always" ||
          (policy.trace === "on_failure" && check.outcome === "failed")) &&
        !evidence.some((asset) => asset?.kind === "trace")
      )
        return false;
    }
  }
  return true;
}
