import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createCanonicalResult,
  type IssueTriageV1,
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
  type PrReviewPlanV1,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
} from "@agentic-review/codex";
import {
  type JobExecutionTemplate,
  JobExecutionTemplateSchema,
  maximumRunCompletionResultUtf8Bytes,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  ResultDigestMismatchError,
  ReviewResultInvalidError,
  StoredExecutionTemplateInvalidError,
} from "./errors.js";

export interface ReviewCompletionJobContext {
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly jobKind: "issue_triage" | "pull_request_review";
  readonly workItemId: string | null;
  readonly workItemResourceKind: "issue" | "pull_request" | null;
  readonly resourceRevision: string;
  readonly revisionId: string | null;
  readonly revisionResourceKind: "issue" | "pull_request" | null;
  readonly revisionBaseSha: string | null;
  readonly revisionHeadSha: string | null;
  readonly executionJson: string;
  readonly executionDigest: string | null;
}

interface ValidatedReviewResultCommon {
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
  readonly schemaId: "IssueTriageV1" | "PrReviewPlanV1";
  readonly outputSchemaSha256: string;
  readonly promptSha256: string;
  readonly requestedRecipeIdsJson: string;
  readonly allowedRecipeIdsJson: string;
  readonly executionTemplateSha256: string;
}

export type ValidatedReviewResult =
  | (ValidatedReviewResultCommon & {
      readonly jobKind: "pull_request_review";
      readonly result: PrReviewPlanV1;
    })
  | (ValidatedReviewResultCommon & {
      readonly jobKind: "issue_triage";
      readonly result: IssueTriageV1;
    });

export interface CanonicalReviewResultSubmission {
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
}

interface AuthoritativeSchema {
  readonly id: "IssueTriageV1" | "PrReviewPlanV1";
  readonly json: string;
  readonly sha256: string;
}

const authoritativeSchemas = {
  issue_triage: createAuthoritativeSchema("IssueTriageV1", IssueTriageV1ModelOutputSchema),
  pull_request_review: createAuthoritativeSchema("PrReviewPlanV1", PrReviewPlanV1ModelOutputSchema),
} as const;

export function validateReviewCompletion(
  context: ReviewCompletionJobContext,
  submittedDigest: string,
  result: unknown,
  canonicalResult = canonicalizeReviewResultSubmission(result),
): ValidatedReviewResult {
  const template = parseAndValidateExecutionTemplate(context);
  const authority = authoritativeSchemas[context.jobKind];
  validateTemplateDigests(context, template, authority);
  if (!securelyMatchesSha256(submittedDigest, canonicalResult.resultDigest)) {
    throw new ResultDigestMismatchError();
  }

  if (context.jobKind === "pull_request_review") {
    if (!Value.Check(PrReviewPlanV1Schema, result)) {
      throw new ReviewResultInvalidError("The review result does not match PrReviewPlanV1Schema.");
    }
    validateRequestedRecipes(result.requestedRecipeIds, template.executionPolicy.allowedRecipeIds);
    validatePrReviewBusinessRules(result);
    return {
      jobKind: context.jobKind,
      result,
      canonicalResultJson: canonicalResult.canonicalResultJson,
      resultDigest: canonicalResult.resultDigest,
      schemaId: authority.id,
      outputSchemaSha256: authority.sha256,
      promptSha256: template.prompt.promptSha256,
      requestedRecipeIdsJson: createCanonicalResult(result.requestedRecipeIds).json,
      allowedRecipeIdsJson: createCanonicalResult(template.executionPolicy.allowedRecipeIds).json,
      executionTemplateSha256: context.executionDigest as string,
    };
  }

  if (!Value.Check(IssueTriageV1Schema, result)) {
    throw new ReviewResultInvalidError("The review result does not match IssueTriageV1Schema.");
  }
  validateRequestedRecipes(result.requestedRecipeIds, template.executionPolicy.allowedRecipeIds);
  return {
    jobKind: context.jobKind,
    result,
    canonicalResultJson: canonicalResult.canonicalResultJson,
    resultDigest: canonicalResult.resultDigest,
    schemaId: authority.id,
    outputSchemaSha256: authority.sha256,
    promptSha256: template.prompt.promptSha256,
    requestedRecipeIdsJson: createCanonicalResult(result.requestedRecipeIds).json,
    allowedRecipeIdsJson: createCanonicalResult(template.executionPolicy.allowedRecipeIds).json,
    executionTemplateSha256: context.executionDigest as string,
  };
}

export function canonicalizeReviewResultSubmission(
  result: unknown,
): CanonicalReviewResultSubmission {
  let canonicalResult: ReturnType<typeof createCanonicalResult>;
  try {
    canonicalResult = createCanonicalResult(result);
  } catch (error) {
    throw new ReviewResultInvalidError(
      error instanceof RangeError
        ? "The review result exceeds the supported canonical nesting depth."
        : "The review result is not valid canonical JSON.",
    );
  }
  if (Buffer.byteLength(canonicalResult.json, "utf8") > maximumRunCompletionResultUtf8Bytes) {
    throw new ReviewResultInvalidError("The review result exceeds the permitted UTF-8 byte size.");
  }
  return {
    canonicalResultJson: canonicalResult.json,
    resultDigest: canonicalResult.sha256,
  };
}

export function canonicalizeLegacyReviewResultSubmission(
  result: unknown,
): CanonicalReviewResultSubmission {
  type Frame =
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "exit"; readonly value: object };

  const frames: Frame[] = [{ kind: "value", value: result }];
  const ancestors = new WeakSet<object>();
  const parts: string[] = [];
  let totalBytes = 0;
  const append = (text: string): void => {
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > maximumRunCompletionResultUtf8Bytes) {
      throw new ReviewResultInvalidError(
        "The legacy review result exceeds the permitted UTF-8 byte size.",
      );
    }
    parts.push(text);
  };

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) {
      continue;
    }
    if (frame.kind === "text") {
      append(frame.text);
      continue;
    }
    if (frame.kind === "exit") {
      ancestors.delete(frame.value);
      continue;
    }

    const value = frame.value;
    if (value === null || typeof value !== "object") {
      let serialized: string;
      try {
        serialized = JSON.stringify(value ?? null) ?? "null";
      } catch {
        throw new ReviewResultInvalidError("The legacy review result is not valid JSON.");
      }
      append(serialized);
      continue;
    }
    if (ancestors.has(value)) {
      throw new ReviewResultInvalidError("The legacy review result contains a cycle.");
    }
    ancestors.add(value);
    frames.push({ kind: "exit", value });

    if (Array.isArray(value)) {
      append("[");
      frames.push({ kind: "text", text: "]" });
      for (let index = value.length - 1; index >= 0; index -= 1) {
        frames.push({ kind: "value", value: value[index] ?? null });
        if (index > 0) {
          frames.push({ kind: "text", text: "," });
        }
      }
      continue;
    }

    append("{");
    frames.push({ kind: "text", text: "}" });
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) {
        continue;
      }
      frames.push({ kind: "value", value: record[key] ?? null });
      frames.push({ kind: "text", text: ":" });
      frames.push({ kind: "text", text: JSON.stringify(key) });
      if (index > 0) {
        frames.push({ kind: "text", text: "," });
      }
    }
  }

  const canonicalResultJson = parts.join("");
  return {
    canonicalResultJson,
    resultDigest: sha256(canonicalResultJson),
  };
}

export function persistValidatedReviewResult(
  database: DatabaseSync,
  context: ReviewCompletionJobContext,
  validated: ValidatedReviewResult,
  createdAt: string,
): string {
  if (context.workItemId === null || context.revisionId === null) {
    throw new StoredExecutionTemplateInvalidError(
      "The completed review job is not linked to an immutable work-item revision.",
    );
  }

  const reviewResultId = randomUUID();
  database
    .prepare(`
      INSERT INTO review_results (
        id,
        run_attempt_id,
        job_id,
        work_item_id,
        revision_id,
        job_kind,
        resource_revision,
        schema_id,
        result_digest,
        result_json,
        summary,
        requested_recipe_ids_json,
        output_schema_sha256,
        prompt_sha256,
        allowed_recipe_ids_json,
        execution_template_sha256,
        execution_template_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      reviewResultId,
      context.runAttemptId,
      context.jobId,
      context.workItemId,
      context.revisionId,
      validated.jobKind,
      context.resourceRevision,
      validated.schemaId,
      validated.resultDigest,
      validated.canonicalResultJson,
      validated.result.summary,
      validated.requestedRecipeIdsJson,
      validated.outputSchemaSha256,
      validated.promptSha256,
      validated.allowedRecipeIdsJson,
      validated.executionTemplateSha256,
      context.executionJson,
      createdAt,
    );

  if (validated.jobKind === "pull_request_review") {
    persistPrReview(database, reviewResultId, validated.result);
  } else {
    persistIssueTriage(database, reviewResultId, validated.result);
  }
  return reviewResultId;
}

function createAuthoritativeSchema(
  id: AuthoritativeSchema["id"],
  schema: typeof IssueTriageV1ModelOutputSchema | typeof PrReviewPlanV1ModelOutputSchema,
): AuthoritativeSchema {
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) {
    throw new Error(`The authoritative ${id} schema could not be serialized.`);
  }
  const canonical = createCanonicalResult(JSON.parse(serialized) as unknown);
  return Object.freeze({ id, json: canonical.json, sha256: canonical.sha256 });
}

function parseAndValidateExecutionTemplate(
  context: ReviewCompletionJobContext,
): JobExecutionTemplate {
  if (
    context.workItemId === null ||
    context.revisionId === null ||
    context.workItemResourceKind === null ||
    context.revisionResourceKind === null ||
    context.executionDigest === null
  ) {
    throw new StoredExecutionTemplateInvalidError(
      "The review job is missing its immutable execution or revision identity.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(context.executionJson) as unknown;
  } catch {
    throw new StoredExecutionTemplateInvalidError("The stored execution template is not JSON.");
  }
  if (!Value.Check(JobExecutionTemplateSchema, value)) {
    throw new StoredExecutionTemplateInvalidError(
      "The stored execution template does not match JobExecutionTemplateSchema.",
    );
  }

  let canonicalTemplate: ReturnType<typeof createCanonicalResult>;
  try {
    canonicalTemplate = createCanonicalResult(value);
  } catch {
    throw new StoredExecutionTemplateInvalidError(
      "The stored execution template is not valid canonical JSON.",
    );
  }
  if (
    context.executionJson !== canonicalTemplate.json ||
    !securelyMatchesSha256(context.executionDigest, canonicalTemplate.sha256)
  ) {
    throw new StoredExecutionTemplateInvalidError(
      "The stored execution template digest or canonical encoding is inconsistent.",
    );
  }
  return value;
}

function validateTemplateDigests(
  context: ReviewCompletionJobContext,
  template: JobExecutionTemplate,
  authority: AuthoritativeSchema,
): void {
  const expectedResourceKind = context.jobKind === "pull_request_review" ? "pull_request" : "issue";
  if (
    context.workItemResourceKind !== expectedResourceKind ||
    context.revisionResourceKind !== expectedResourceKind ||
    template.resource.kind !== expectedResourceKind
  ) {
    throw new StoredExecutionTemplateInvalidError(
      "The job kind, work item, revision, and execution target are inconsistent.",
    );
  }
  if (template.prompt.promptSha256 !== sha256(template.prompt.renderedPrompt)) {
    throw new StoredExecutionTemplateInvalidError(
      "The stored rendered prompt digest is inconsistent.",
    );
  }

  let suppliedSchema: ReturnType<typeof createCanonicalResult>;
  try {
    suppliedSchema = createCanonicalResult(template.prompt.outputSchema);
  } catch {
    throw new StoredExecutionTemplateInvalidError(
      "The stored output schema is not valid canonical JSON.",
    );
  }
  if (
    suppliedSchema.json !== authority.json ||
    !securelyMatchesSha256(suppliedSchema.sha256, authority.sha256) ||
    !securelyMatchesSha256(template.prompt.outputSchemaSha256, authority.sha256)
  ) {
    throw new StoredExecutionTemplateInvalidError(
      "The stored output schema is not authoritative for the job kind.",
    );
  }

  if (context.jobKind === "pull_request_review") {
    if (
      template.resource.kind !== "pull_request" ||
      template.resource.baseSha !== context.revisionBaseSha ||
      template.resource.headSha !== context.revisionHeadSha
    ) {
      throw new StoredExecutionTemplateInvalidError(
        "The stored pull-request target does not match the immutable revision.",
      );
    }
  } else if (
    template.resource.kind !== "issue" ||
    template.resource.revisionDigest !== context.resourceRevision
  ) {
    throw new StoredExecutionTemplateInvalidError(
      "The stored issue target does not match the immutable revision.",
    );
  }
}

function validateRequestedRecipes(
  requestedRecipeIds: readonly string[],
  allowedRecipeIds: readonly string[],
): void {
  const allowed = new Set(allowedRecipeIds);
  if (requestedRecipeIds.some((recipeId) => !allowed.has(recipeId))) {
    throw new ReviewResultInvalidError(
      "The review result requested a validation recipe outside the job allowlist.",
    );
  }
}

function validatePrReviewBusinessRules(result: PrReviewPlanV1): void {
  const findingIds = new Set<string>();
  for (const finding of result.findings) {
    if (findingIds.has(finding.findingId)) {
      throw new ReviewResultInvalidError(
        "The pull-request review contains duplicate finding identifiers.",
      );
    }
    findingIds.add(finding.findingId);
    if (finding.endLine !== null && finding.endLine < finding.line) {
      throw new ReviewResultInvalidError(
        "The pull-request review contains an invalid finding line range.",
      );
    }
    if (!isNormalizedRepositoryRelativePath(finding.path)) {
      throw new ReviewResultInvalidError(
        "The pull-request review contains a non-normalized repository-relative path.",
      );
    }
  }
}

function isNormalizedRepositoryRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || path.includes(":")) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function persistPrReview(
  database: DatabaseSync,
  reviewResultId: string,
  result: PrReviewPlanV1,
): void {
  database
    .prepare(`
      INSERT INTO pr_review_results (review_result_id, assessment)
      VALUES (?, ?)
    `)
    .run(reviewResultId, result.assessment);

  const insertFinding = database.prepare(`
    INSERT INTO pr_review_findings (
      review_result_id,
      ordinal,
      finding_id,
      priority,
      title,
      body,
      path,
      line,
      end_line,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [ordinal, finding] of result.findings.entries()) {
    insertFinding.run(
      reviewResultId,
      ordinal,
      finding.findingId,
      finding.priority,
      finding.title,
      finding.body,
      finding.path,
      finding.line,
      finding.endLine,
      finding.confidence,
    );
  }
}

function persistIssueTriage(
  database: DatabaseSync,
  reviewResultId: string,
  result: IssueTriageV1,
): void {
  database
    .prepare(`
      INSERT INTO issue_triage_results (
        review_result_id,
        category,
        priority,
        confidence,
        suggested_labels_json,
        missing_information_json,
        duplicate_candidates_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      reviewResultId,
      result.category,
      result.priority,
      result.confidence,
      createCanonicalResult(result.suggestedLabels).json,
      createCanonicalResult(result.missingInformation).json,
      createCanonicalResult(result.duplicateCandidates).json,
    );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function securelyMatchesSha256(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
