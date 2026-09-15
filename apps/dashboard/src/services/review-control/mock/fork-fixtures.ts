import type { Job, JobReviewResult, WorkerNode, WorkItem } from "../types";

const repositoryId = "repo-powertoys-fork";
const repository = "moooyo/PowerToys";
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

interface ForkScenario {
  kind: WorkItem["kind"];
  number: number;
  title: string;
  stage: WorkItem["stage"];
  priority: WorkItem["priority"];
  status: Job["status"] | null;
  attempt: number;
  elapsedSeconds: number;
  minutesAgo: number;
  workerNodeId?: string;
  attentionReason?: string;
}

const scenarios: ForkScenario[] = [
  {
    kind: "pull_request",
    number: 1001,
    title: "Restore Command Palette keyboard navigation after closing settings",
    stage: "reviewing",
    priority: "high",
    status: "running",
    attempt: 1,
    elapsedSeconds: 246,
    minutesAgo: 1,
    workerNodeId: "powertoys-worker-fork-review",
  },
  {
    kind: "pull_request",
    number: 1002,
    title: "Keep PowerToys Run plugin results stable while refreshing the index",
    stage: "awaiting_admission",
    priority: "normal",
    status: "queued",
    attempt: 0,
    elapsedSeconds: 0,
    minutesAgo: 6,
  },
  {
    kind: "pull_request",
    number: 1003,
    title: "Preserve FancyZones layouts after monitor reconnect",
    stage: "done",
    priority: "high",
    status: "succeeded",
    attempt: 1,
    elapsedSeconds: 318,
    minutesAgo: 12,
  },
  {
    kind: "pull_request",
    number: 1004,
    title: "Refresh File Locksmith results after a process exits",
    stage: "done",
    priority: "normal",
    status: "dead_letter",
    attempt: 3,
    elapsedSeconds: 1800,
    minutesAgo: 28,
    attentionReason: "Sample review exceeded its timeout after three attempts.",
  },
  {
    kind: "issue",
    number: 1005,
    title: "Crop and Lock preview is offset on mixed-DPI monitors",
    stage: "validating",
    priority: "high",
    status: "running",
    attempt: 1,
    elapsedSeconds: 423,
    minutesAgo: 2,
    workerNodeId: "powertoys-worker-fork-ui",
  },
  {
    kind: "issue",
    number: 1006,
    title: "Keyboard Manager editor loses focus after target selection",
    stage: "done",
    priority: "normal",
    status: "succeeded",
    attempt: 1,
    elapsedSeconds: 156,
    minutesAgo: 18,
  },
  {
    kind: "issue",
    number: 1007,
    title: "Advanced Paste formatting differs between plain text and Markdown",
    stage: "queued",
    priority: "normal",
    status: "queued",
    attempt: 0,
    elapsedSeconds: 0,
    minutesAgo: 4,
  },
  {
    kind: "issue",
    number: 1008,
    title: "Keep Color Picker history across Windows sessions",
    stage: "not_scheduled",
    priority: "low",
    status: null,
    attempt: 0,
    elapsedSeconds: 0,
    minutesAgo: 35,
  },
];

export const forkWorkItems: WorkItem[] = scenarios.map((scenario) => {
  const suffix = `${scenario.kind === "pull_request" ? "pr" : "issue"}-${scenario.number}`;
  const updatedAt = ago(scenario.minutesAgo);
  const requestedAt = ago(scenario.minutesAgo + Math.ceil(scenario.elapsedSeconds / 60));
  const trigger =
    scenario.status === null
      ? "not_requested"
      : scenario.kind === "pull_request"
        ? "review_requested"
        : "assigned";
  const headSha =
    scenario.kind === "pull_request" ? String(scenario.number - 1000).repeat(40) : undefined;
  return {
    id: `wi-fork-${suffix}`,
    repositoryId,
    repository,
    revisionKey: scenario.number.toString(16).padStart(64, "0"),
    kind: scenario.kind,
    number: scenario.number,
    title: `[Sample] ${scenario.title}`,
    author: "moooyo",
    // Synthetic records link to the fork, not to nonexistent GitHub PRs or issues.
    githubUrl: `https://github.com/${repository}`,
    trigger,
    scheduledBy: trigger === "not_requested" ? "No scheduling actor" : "moooyo",
    authorization: trigger === "not_requested" ? "pending" : "self",
    priority: scenario.priority,
    state:
      scenario.status === "running" ? "active" : scenario.status === "queued" ? "assigned" : "open",
    stage: scenario.stage,
    freshness: "current",
    latestJobId: scenario.status === null ? undefined : `job-fork-${suffix}`,
    latestJobStatus: scenario.status ?? undefined,
    latestJobAttemptCount: scenario.status === null ? null : scenario.attempt,
    latestJobAdmission:
      scenario.status !== "queued"
        ? null
        : scenario.stage === "awaiting_admission"
          ? {
              state: "pending",
              attemptBase: 0,
              requestedAt,
              admittedAt: null,
              timestampBasis: "recorded",
            }
          : {
              state: "admitted",
              attemptBase: 0,
              requestedAt,
              admittedAt: requestedAt,
              timestampBasis: "recorded",
            },
    headSha,
    reviewedSha: scenario.status === "succeeded" ? headSha : undefined,
    workerNodeId: scenario.workerNodeId,
    attentionReason: scenario.attentionReason,
    updatedAt,
    activeRequestEpoch:
      trigger === "not_requested"
        ? null
        : {
            requestEpochId: `epoch-fork-${suffix}`,
            requestKind: trigger === "assigned" ? "assignment" : "review_request",
            sequence: 1,
            status: "active",
            authorization: "self",
            openedAt: requestedAt,
            closedAt: null,
          },
  };
});

export const forkJobs: Job[] = forkWorkItems.flatMap<Job>((item, index) => {
  const scenario = scenarios[index];
  if (!scenario || !item.latestJobId || !item.latestJobStatus) return [];
  return [
    {
      id: item.latestJobId,
      repositoryId,
      workItemId: item.id,
      workItemRef: `${repository}#${item.number}`,
      title:
        item.kind === "pull_request"
          ? "Sample PR review"
          : item.stage === "validating"
            ? "Sample issue validation"
            : "Sample issue triage",
      generation: 1,
      status: item.latestJobStatus,
      admission: item.latestJobAdmission,
      stage:
        item.stage === "reviewing"
          ? "cli_review"
          : item.stage === "validating"
            ? "validation"
            : item.stage === "awaiting_admission"
              ? "awaiting_admission"
              : item.stage === "queued"
                ? "queued"
                : "done",
      attempt: scenario.attempt,
      maxAttempts: 3,
      elapsedSeconds: scenario.elapsedSeconds,
      targetSha: item.headSha,
      workerNodeId: item.workerNodeId,
      ...(item.workerNodeId
        ? {
            leaseGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
            progressUpdatedAt: item.updatedAt,
          }
        : {}),
      outcome:
        scenario.status === "succeeded"
          ? "success"
          : scenario.status === "dead_letter"
            ? "timed_out"
            : undefined,
      createdAt: ago(scenario.minutesAgo + Math.ceil(scenario.elapsedSeconds / 60)),
    },
  ];
});

export const forkWorkers: WorkerNode[] = [
  {
    id: "powertoys-worker-fork-review",
    serverId: "worker-sample-fork-review",
    displayName: "Sample fork review worker",
    instanceId: "sample-fork-review-01",
    status: "online",
    version: "0.1.0",
    location: "Fork preview",
    activeSlots: 1,
    maxSlots: 2,
    capabilities: ["static-review", "build-powertoys", "unit-tests"],
    currentJobs: ["job-fork-pr-1001"],
    lastHeartbeatAt: ago(0),
    diskFreeGb: 142,
  },
  {
    id: "powertoys-worker-fork-ui",
    serverId: "worker-sample-fork-ui",
    displayName: "Sample fork Windows UI worker",
    instanceId: "sample-fork-ui-01",
    status: "online",
    version: "0.1.0",
    location: "Fork preview",
    activeSlots: 1,
    maxSlots: 1,
    capabilities: ["windows", "interactive-desktop", "build-powertoys"],
    currentJobs: ["job-fork-issue-1005"],
    lastHeartbeatAt: ago(0),
    diskFreeGb: 108,
  },
];

export const forkReviewResults: Record<string, JobReviewResult> = {
  "job-fork-pr-1003": {
    reviewResultId: "result-fork-pr-1003",
    schemaId: "PrReviewPlanV2",
    resultDigest: "3".repeat(64),
    summary:
      "Sample review: FancyZones restores the saved layout, but a monitor disconnected during restore can leave an invalid handle. Add a guard before applying the layout.",
    requestedRecipeIds: [],
    createdAt: ago(12),
    verification: {
      status: "not_run",
      summary:
        "Synthetic static review for the fork preview. No verification commands were executed.",
      commands: [],
    },
    prReview: {
      assessment: "request_changes",
      findings: [
        {
          findingId: "sample-fork-monitor-handle",
          ordinal: 0,
          priority: 1,
          title: "Guard the monitor handle before restoring a layout",
          body: "Sample finding: a display can disconnect between monitor enumeration and layout restoration. Check that the monitor handle is still valid before applying the saved zone set.",
          path: "src/modules/fancyzones/FancyZonesLib/FancyZones.cpp",
          line: 142,
          endLine: null,
          confidence: 0.94,
        },
      ],
    },
    issueTriage: null,
  },
  "job-fork-issue-1006": {
    reviewResultId: "result-fork-issue-1006",
    schemaId: "IssueTriageV2",
    resultDigest: "6".repeat(64),
    summary:
      "Sample triage: the Keyboard Manager editor loses keyboard focus after selecting a remap target. Request the PowerToys version, display scaling, and a short recording before reproducing the issue.",
    requestedRecipeIds: [],
    createdAt: ago(18),
    verification: {
      status: "not_run",
      summary: "Synthetic issue triage for the fork preview. No reproduction was executed.",
      commands: [],
    },
    prReview: null,
    issueTriage: {
      category: "bug",
      priority: 2,
      confidence: 0.9,
      suggestedLabels: ["Product-Keyboard Manager", "Needs-Triage"],
      missingInformation: [
        "PowerToys version and display scaling settings.",
        "A short recording of target selection and the loss of keyboard focus.",
      ],
      duplicateCandidates: [],
    },
  },
};
