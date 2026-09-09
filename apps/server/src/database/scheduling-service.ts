import type { DatabaseSync } from "node:sqlite";

export type SchedulingServiceStage = "admission" | "claim";
export type SchedulingWorkClass = "pull_request" | "issue";

export interface RepositorySchedulingService {
  readonly lastAdmissionTicket: number;
  readonly lastClaimTicket: number;
  readonly admissionPrStreak: number;
  readonly claimPrStreak: number;
}

function corrupt(message: string): never {
  throw Object.assign(new Error(message), { code: "PLATFORM_CORRUPT" });
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > maximum)
    corrupt("The repository scheduling service state is invalid.");
  return result;
}

/** Newly discovered repositories start at today's service sequence, without historical credit. */
export function ensureRepositorySchedulingStateInTransaction(
  database: DatabaseSync,
  bucketKey: string,
): void {
  if (!database.isTransaction) corrupt("Repository service requires an immediate transaction.");
  database
    .prepare(`INSERT INTO repository_scheduling_state
      (bucket_key, last_admission_ticket, last_claim_ticket)
      SELECT ?, successful_admission_sequence, successful_claim_sequence
      FROM scheduling_state WHERE singleton = 1
        AND NOT EXISTS (SELECT 1 FROM repository_scheduling_state WHERE bucket_key = ?)`)
    .run(bucketKey, bucketKey);
}

export function readRepositorySchedulingService(
  database: DatabaseSync,
  bucketKey: string,
): RepositorySchedulingService {
  const row = database
    .prepare(`SELECT last_admission_ticket, last_claim_ticket, admission_pr_streak,
      claim_pr_streak FROM repository_scheduling_state WHERE bucket_key = ?`)
    .get(bucketKey);
  if (!row) corrupt("The repository scheduling service state is missing.");
  return {
    lastAdmissionTicket: integer(row.last_admission_ticket),
    lastClaimTicket: integer(row.last_claim_ticket),
    admissionPrStreak: integer(row.admission_pr_streak, 2),
    claimPrStreak: integer(row.claim_pr_streak, 2),
  };
}

/** Only a committed admission or grant consumes a service ticket or changes class debt. */
export function recordSuccessfulSchedulingServiceInTransaction(
  database: DatabaseSync,
  bucketKey: string,
  stage: SchedulingServiceStage,
  workClass: SchedulingWorkClass,
): number {
  if (!database.isTransaction) corrupt("Repository service requires an immediate transaction.");
  if (
    (stage !== "admission" && stage !== "claim") ||
    (workClass !== "pull_request" && workClass !== "issue")
  )
    corrupt("The repository scheduling service request is invalid.");
  ensureRepositorySchedulingStateInTransaction(database, bucketKey);
  const sequenceColumn =
    stage === "admission" ? "successful_admission_sequence" : "successful_claim_sequence";
  const ticketColumn = stage === "admission" ? "last_admission_ticket" : "last_claim_ticket";
  const streakColumn = stage === "admission" ? "admission_pr_streak" : "claim_pr_streak";
  const sequence = database
    .prepare(`UPDATE scheduling_state SET ${sequenceColumn} = ${sequenceColumn} + 1
      WHERE singleton = 1 AND ${sequenceColumn} < 9007199254740991
      RETURNING ${sequenceColumn} AS sequence`)
    .get();
  if (!sequence) corrupt("The scheduling successful-service sequence is exhausted.");
  const ticket = integer(sequence.sequence);
  const changed = database
    .prepare(`UPDATE repository_scheduling_state SET ${ticketColumn} = ?,
      ${streakColumn} = CASE WHEN ? = 'issue' THEN 0 ELSE MIN(2, ${streakColumn} + 1) END
      WHERE bucket_key = ?`)
    .run(ticket, workClass, bucketKey);
  if (Number(changed.changes) !== 1) corrupt("The repository scheduling service state changed.");
  return ticket;
}
