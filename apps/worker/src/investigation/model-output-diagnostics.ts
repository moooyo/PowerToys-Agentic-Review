import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const ruleDescriptions = {
  invalid_json: "The final response is not valid JSON.",
  invalid_encoding: "The model transport contains invalid UTF-8.",
  invalid_cli_event: "The CLI emitted an invalid structured event.",
  invalid_cli_response: "The CLI did not provide a valid final text response.",
  invalid_usage_json: "The CLI usage record is not valid JSON.",
  delta_schema: "The model response does not match the bounded delta schema.",
  round_schema: "The merged analysis does not match the investigation round schema.",
  response_schema: "The final response does not match its required schema.",
  delta_binding:
    "The model delta does not match its projected task, attempt, checkpoint, round, and phase.",
  task_scope_violation:
    "The analysis violates the frozen task scope or trusted runtime boundaries.",
  trusted_evidence_collision: "Model evidence cannot replace a Worker observation identity.",
  coverage_definition_changed:
    "A coverage update cannot change frozen required work or its subject.",
  immutable_record_changed: "Accepted evidence and recheck records are immutable.",
  candidate_identity_changed: "A candidate update must preserve its subject and discovery round.",
  record_version_invalid: "Changing an existing record requires a newer content version.",
  finding_removal_outside_batch: "A delta cannot remove a finding outside its supplied batch.",
  finding_update_removed: "A delta cannot both update and remove the same finding.",
  finding_owner_required:
    "Removing a finding requires retained withdrawal or merge records for every owning candidate.",
  duplicate_record_id: "The model delta contains duplicate record IDs.",
  record_outside_batch: "The model delta modifies a record outside its supplied batch.",
  embedded_draft_update:
    "An embedded finding draft can only change through its supplied owning finding.",
  draft_identity_collision: "A finding cannot take over another finding's draft identity.",
  reference_outside_batch:
    "The model delta references a record outside its supplied batch or new records.",
} as const;

export type ModelOutputValidationRule = keyof typeof ruleDescriptions;
export type ModelOutputValidationPath = string | readonly (string | number)[];

// Unknown property names can contain model-controlled text, including credentials.
const safePathFields = new Set([
  "schemaVersion",
  "taskId",
  "attemptId",
  "inputCheckpointRef",
  "id",
  "version",
  "digest",
  "round",
  "phase",
  "analysis",
  "runtime",
  "reviewMode",
  "sourceCoverage",
  "subjects",
  "exclusions",
  "summary",
  "assessment",
  "coverage",
  "coverageUnits",
  "includedUnits",
  "completedUnitRefs",
  "unresolvedUnitRefs",
  "findings",
  "candidates",
  "rechecks",
  "evidence",
  "plans",
  "nextActions",
  "feedbackDrafts",
  "diagnostics",
  "limitations",
  "removedFindingIds",
  "continue",
  "continuationReason",
  "kind",
  "subjectRef",
  "paths",
  "requiredWork",
  "status",
  "evidenceRefs",
  "findingId",
  "findingVersion",
  "mergedIntoCandidateId",
  "discoveredRound",
  "confirmation",
  "recheckRef",
  "feedbackDraft",
  "planRef",
  "draftRef",
  "source",
  "severity",
  "category",
  "title",
  "body",
  "description",
  "location",
  "path",
  "startLine",
  "endLine",
  "line",
  "side",
  "code",
  "message",
  "retryable",
  "prerequisiteRefs",
  "reason",
  "rationale",
  "conclusion",
  "scope",
  "steps",
  "expectedResult",
  "actualResult",
  "acceptanceCriteria",
  "assumptions",
  "risks",
  "facts",
  "data",
  "type",
  "content",
  "text",
  "toolRequests",
  "modelMetrics",
  "reproduction",
  "impact",
  "confidence",
  "fixRecommendation",
  "rootCause",
  "locations",
  "suggestion",
  "bugAssessment",
  "upstreamFix",
  "duplicateOf",
  "e2eAssessment",
  "featureAssessment",
  "implementationPlanRef",
  "linkedValidationReportRefs",
  "prerequisites",
]);
const maximumPaths = 8;
const maximumPathSegments = 16;
const safeMessages = new WeakMap<object, string>();
const safeIssues = new WeakMap<
  object,
  { readonly rule: ModelOutputValidationRule; readonly paths: readonly string[] }
>();

/** Safe metadata only; arbitrary exception text and response values are never retained. */
export class ModelOutputValidationError extends Error {
  public readonly code = "MODEL_OUTPUT_INVALID";
  public readonly rule: ModelOutputValidationRule;
  public readonly paths: readonly string[];

  public constructor(
    rule: ModelOutputValidationRule,
    path: ModelOutputValidationPath = [],
    relatedPaths: readonly ModelOutputValidationPath[] = [],
  ) {
    const safeRule = Object.hasOwn(ruleDescriptions, rule) ? rule : "response_schema";
    const paths = [...new Set([path, ...relatedPaths.slice(0, maximumPaths - 1)].map(safePointer))];
    const message = `Model output validation failed [${safeRule}] at ${paths.join(", ")}: ${ruleDescriptions[safeRule]}`;
    super(message);
    this.name = "ModelOutputValidationError";
    this.rule = safeRule;
    this.paths = Object.freeze(paths);
    safeMessages.set(this, message);
    safeIssues.set(this, { rule: safeRule, paths: this.paths });
  }
}

/** Only branded, immutable diagnostics cross the terminal-report boundary. */
export function safeModelOutputValidationMessage(error: unknown): string | null {
  return typeof error === "object" && error !== null ? (safeMessages.get(error) ?? null) : null;
}

/** Return a detached copy of the branded rule metadata, never mutable Error properties. */
export function safeModelOutputValidationIssue(
  error: unknown,
): { rule: ModelOutputValidationRule; paths: string[] } | null {
  const issue = typeof error === "object" && error !== null ? safeIssues.get(error) : undefined;
  return issue === undefined ? null : { rule: issue.rule, paths: [...issue.paths] };
}

/** TypeBox paths are metadata; its messages and rejected values are deliberately omitted. */
export function modelOutputSchemaError(
  schema: TSchema,
  value: unknown,
  stage: "delta" | "round" | "response",
): ModelOutputValidationError {
  const paths: ModelOutputValidationPath[] = [];
  for (const issue of Value.Errors(schema, value)) {
    paths.push(schemaPathSegments(issue.path, value));
    if (paths.length >= maximumPaths) break;
  }
  return new ModelOutputValidationError(`${stage}_schema`, paths[0] ?? [], paths.slice(1));
}

function safePointer(path: ModelOutputValidationPath): string {
  const segments =
    typeof path === "string" ? path.split("/").slice(path.startsWith("/") ? 1 : 0) : path;
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "")) return "/";
  const safeSegments = segments.slice(0, maximumPathSegments).map((segment) => {
    if (typeof segment === "number")
      return Number.isSafeInteger(segment) && segment >= 0 && segment <= 999_999
        ? String(segment)
        : "*";
    return safePathFields.has(segment) ? segment : "*";
  });
  if (segments.length > maximumPathSegments) safeSegments.push("*");
  return `/${safeSegments.join("/")}`;
}

function schemaPathSegments(path: string, value: unknown): readonly (string | number)[] {
  if (path === "") return [];
  const segments: (string | number)[] = [];
  let parent = value;
  for (const encoded of path.split("/").slice(1, maximumPathSegments + 2)) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    // A numeric object key is still untrusted text; only actual array indexes are retained.
    segments.push(Array.isArray(parent) && /^(0|[1-9][0-9]{0,5})$/.test(key) ? Number(key) : key);
    parent =
      typeof parent === "object" && parent !== null && Object.hasOwn(parent, key)
        ? (parent as Record<string, unknown>)[key]
        : undefined;
  }
  return segments;
}
