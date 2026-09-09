import type {
  DashboardJobListItem,
  DashboardReviewRunJob,
  DashboardReviewRunSummary,
  DashboardSystemRead,
  DashboardWorkItemListItem,
  JobAdmission,
  SchedulingDiagnosticJob,
  SchedulingDiagnosticReason,
  SchedulingDiagnostics,
  SchedulingDiagnosticsV1,
} from "../dist/index.js";

// Compile against emitted declarations so strict runtime schemas also retain useful consumer types.
export function admissionFields(value: JobAdmission): [number, string, string | null] {
  if (value.state === "pending") {
    const admittedAt: null = value.admittedAt;
    return [value.attemptBase, value.requestedAt, admittedAt];
  }
  const admittedAt: string = value.admittedAt;
  // @ts-expect-error Internal global ordering is not a public admission capability.
  void value.episodeSequence;
  return [value.attemptBase, value.timestampBasis, admittedAt];
}

export function currentProjections(
  job: DashboardJobListItem,
  runJob: DashboardReviewRunJob,
  item: DashboardWorkItemListItem,
  summary: DashboardReviewRunSummary,
  system: DashboardSystemRead,
  diagnosticJob: SchedulingDiagnosticJob,
): [JobAdmission | null, JobAdmission | null, JobAdmission | null, JobAdmission | null, number[]] {
  return [
    job.admission,
    runJob.admission,
    item.latestJobAdmission,
    diagnosticJob.admission,
    [
      item.latestJobAttemptCount ?? 0,
      summary.execution.awaitingAdmission,
      summary.execution.queued,
      system.queuedJobs,
      system.awaitingAdmissionJobs,
      system.pendingValidationRequests,
    ],
  ];
}

export function versionedDiagnostics(
  current: SchedulingDiagnostics,
  historical: SchedulingDiagnosticsV1,
  reason: SchedulingDiagnosticReason,
): string | null {
  const version: "SchedulingDiagnosticsV2" = current.schemaVersion;
  if (historical.job !== null) {
    // @ts-expect-error V1 never recorded admission state.
    void historical.job.admission;
  }
  if (reason.code === "awaiting_admission") {
    const effect: "claim_gate" = reason.effect;
    return `${version}:${effect}`;
  }
  return current.job?.admission?.admittedAt ?? null;
}
