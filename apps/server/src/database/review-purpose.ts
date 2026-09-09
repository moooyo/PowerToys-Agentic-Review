// Shared ingestion helpers also operate while tests seed schemas that predate ReviewRuns.
// Keep their Job predicate independent of the later Run/link tables. Strict V2 execution
// contexts are evaluation-only; historical Jobs without a validation context remain reviews.
export const ordinaryReviewJobSql = (job: "job" | "candidate" | "jobs"): string => `CASE
  WHEN json_valid(${job}.execution_json) THEN
    json_extract(${job}.execution_json, '$.validation.schemaVersion') IS NOT 'ValidationJobContextV2'
    AND json_extract(${job}.execution_json, '$.validation.purpose.kind') IS NOT 'evaluation'
  ELSE 1
END`;

// V1 is the immutable ordinary-review branch, including on pre-M28 migration fixtures.
// M28's table CHECK binds that discriminator to purpose='review' without rewriting old JSON.
export const ordinaryReviewPlanSql = (plan: "plan_json" | "run.plan_json"): string =>
  `json_extract(${plan}, '$.schemaVersion') IS 'ReviewRunExecutionPlanV1'`;
