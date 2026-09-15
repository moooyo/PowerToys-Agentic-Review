import type {
  InvestigationAssessment,
  InvestigationAttemptV1,
  InvestigationCandidate,
  InvestigationCoverage,
  InvestigationEvidenceV1,
  InvestigationFeedbackDraft,
  InvestigationFindingV1,
  InvestigationNextActionV1,
  InvestigationOutcome,
  InvestigationPlanV1,
  InvestigationRecheck,
  InvestigationResultV1,
  InvestigationSubjectV1,
  InvestigationTaskV1,
} from "./investigation.js";

export interface InvestigationPreviewOptions {
  priority?: "P0" | "P1" | "P2" | "P3";
  outcome?: InvestigationOutcome;
  findingCount?: number;
}

/** Creates explicit preview data without accessing a repository, invoking a model, or running an investigation. */
export function createInvestigationPreview(
  kind: "pr" | "bug" | "feature",
  options: InvestigationPreviewOptions = {},
): { task: InvestigationTaskV1; attempt: InvestigationAttemptV1; result: InvestigationResultV1 } {
  const findingCount = options.findingCount ?? (kind === "feature" ? 0 : 1);
  if (!Number.isSafeInteger(findingCount) || findingCount < 0) {
    throw new RangeError("findingCount must be a non-negative safe integer.");
  }

  const outcome = options.outcome ?? "completed";
  const complete = outcome === "completed";
  const priority = options.priority ?? "P1";
  const prefix = `synthetic-${kind}`;
  const taskId = `${prefix}-task`;
  const attemptId = `${prefix}-attempt-1`;
  const reportId = `${prefix}-report`;
  const subjectId = `${prefix}-subject`;
  const snapshotEvidenceId = `${prefix}-snapshot-evidence`;
  const sourceArtifactId = `${prefix}-source-artifact`;
  const analysisUnitId = `${prefix}-analysis-unit`;
  const startedAt = "2026-09-15T02:00:00.000Z";
  const finishedAt = "2026-09-15T02:00:03.000Z";
  const revisionKey = "a".repeat(64);
  const headSha = "b".repeat(40);
  const reportDigest = "c".repeat(64);
  const repository = {
    id: "synthetic-powertoys-repository",
    fullName: "moooyo/PowerToys",
    githubRepositoryId: 9_000_001,
  };
  const workItem = {
    id: `${prefix}-work-item`,
    kind: kind === "pr" ? ("pull_request" as const) : ("issue" as const),
    number: kind === "pr" ? 101 : kind === "bug" ? 102 : 103,
    title:
      kind === "pr"
        ? "[Synthetic] Settings cancellation review"
        : kind === "bug"
          ? "[Synthetic] Settings does not open"
          : "[Synthetic] Export selected settings",
  };
  const subject: InvestigationSubjectV1 =
    kind === "pr"
      ? {
          id: subjectId,
          kind: "original_pr",
          repositoryId: repository.id,
          workItemId: workItem.id,
          revisionKey,
          baseSha: "d".repeat(40),
          headSha,
        }
      : {
          id: subjectId,
          kind: "issue_snapshot",
          repositoryId: repository.id,
          workItemId: workItem.id,
          revisionKey,
          snapshotDigest: "e".repeat(64),
        };
  const reportRef = { id: reportId, version: 1, digest: reportDigest };
  const sourceReportRef = { id: reportId, version: 1 };
  const profileRef = { id: `${prefix}-profile`, version: 1, digest: "f".repeat(64) };
  const promptRef = { id: `${prefix}-prompt`, version: 1, digest: "1".repeat(64) };
  const budget = {
    maxRounds: 8,
    maxDurationMs: 300_000,
    maxTokens: Math.max(64_000, findingCount * 2_000),
    maxReportBytes: Math.max(8 * 1024 * 1024, findingCount * 32_768),
  };
  const prerequisiteId = `${prefix}-environment`;
  const scenarioId = `${prefix}-scenario`;
  const checkId = `${prefix}-check`;
  const plan: InvestigationPlanV1 = {
    id: `${prefix}-plan`,
    version: 1,
    digest: "2".repeat(64),
    state: "saved",
    sourceReportRef,
    kind: kind === "pr" ? "verification" : kind === "bug" ? "reproduction" : "implementation",
    subjectRef: subjectId,
    title:
      kind === "pr"
        ? "Verify Settings cancellation behavior"
        : kind === "bug"
          ? "Reproduce the reported Settings launch failure"
          : "Implement export for selected settings",
    rationale:
      kind === "pr"
        ? "Runtime behavior requires evidence tied to the original PR SHA."
        : kind === "bug"
          ? "The report supports a hypothesis, but does not establish a reproduced defect."
          : "The requested export can reuse the existing settings serialization boundary.",
    prerequisites:
      kind === "feature"
        ? []
        : [
            {
              id: prerequisiteId,
              kind: "environment",
              description:
                "Provide an authorized, restorable Windows test environment with an interactive desktop.",
            },
          ],
    steps: [
      {
        id: `${prefix}-plan-step`,
        description:
          kind === "pr"
            ? "Open Settings, cancel an in-progress operation, and record the resulting state."
            : kind === "bug"
              ? "Capture the installed version and logs, then attempt the reported launch sequence."
              : "Add a selection-aware export command using the existing settings serializer.",
        expectedObservation:
          kind === "pr"
            ? "Cancelled work does not commit state or report success."
            : kind === "bug"
              ? "Record whether Settings opens, and preserve the exact failure evidence if it does not."
              : "The export contains only the selected settings and preserves their values.",
        checkIds: kind === "feature" ? [] : [checkId],
      },
    ],
    acceptanceCriteria:
      kind === "pr"
        ? [
            "Cancellation leaves persisted settings unchanged.",
            "Evidence identifies the tested head SHA.",
          ]
        : kind === "bug"
          ? [
              "The exact version and launch sequence are recorded.",
              "The experiment reports observed behavior without inferring success from missing logs.",
            ]
          : [
              "Only selected settings are exported.",
              "Exported values preserve the existing serialization format.",
            ],
  };
  const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  const evidence: InvestigationEvidenceV1[] = [
    {
      id: snapshotEvidenceId,
      subjectRef: subjectId,
      source: "source_snapshot",
      authority: "worker",
      summary:
        "Synthetic frozen input snapshot; this fixture has not contacted GitHub or executed repository code.",
      artifactRefs: [sourceArtifactId],
      evidenceRefs: [],
      provenance: { taskId, attemptId, producer: "synthetic-fixture", recordedAt: startedAt },
    },
  ];
  const findings: InvestigationFindingV1[] = [];
  const rechecks: InvestigationRecheck[] = [];
  const candidates: InvestigationCandidate[] = [];

  // There is deliberately no top-k cap: callers can exercise full reports with more than 100 findings.
  for (let index = 0; index < findingCount; index += 1) {
    const ordinal = index + 1;
    const findingId = `${prefix}-finding-${ordinal}`;
    const evidenceId = `${prefix}-finding-evidence-${ordinal}`;
    const recheckId = `${prefix}-recheck-${ordinal}`;
    const path = `src/settings-ui/Settings.UI/Services/SyntheticScenario${ordinal}.cs`;
    const isHypothesis = kind === "bug";
    evidence.push({
      id: evidenceId,
      subjectRef: subjectId,
      source: isHypothesis ? "reporter_statement" : "static_analysis",
      authority: "model",
      summary: isHypothesis
        ? `Synthetic reporter statement ${ordinal} describes a Settings launch failure without an execution trace.`
        : `Synthetic static analysis ${ordinal} identifies a missing cancellation guard in the frozen source snapshot.`,
      artifactRefs: [],
      evidenceRefs: [snapshotEvidenceId],
      provenance: { taskId, attemptId, producer: "synthetic-fixture", recordedAt: finishedAt },
    });
    const feedbackDraft: InvestigationFeedbackDraft = {
      id: `${prefix}-finding-draft-${ordinal}`,
      body: isHypothesis
        ? `Please capture the Settings version, launch steps, and logs for scenario ${ordinal}; the current report does not establish the root cause.`
        : `Scenario ${ordinal} can commit settings after cancellation. Check cancellation before persisting state and verify that cancellation leaves the previous values intact.`,
      suggestion:
        kind === "pr"
          ? {
              subjectRef: subjectId,
              path,
              startLine: 42,
              endLine: 42,
              headSha,
              originalContentDigest: "3".repeat(64),
              replacement:
                "cancellationToken.ThrowIfCancellationRequested();\nawait SaveSettingsAsync(settings, cancellationToken);",
            }
          : null,
    };
    findings.push({
      id: findingId,
      version: 1,
      ordinal: index,
      priority,
      title: isHypothesis
        ? `Settings launch failure requires verification in scenario ${ordinal}`
        : `Cancellation can persist stale settings in scenario ${ordinal}`,
      trigger: {
        conditions: isHypothesis
          ? ["The reporter attempts to open Settings."]
          : ["A settings operation is cancelled before persistence."],
        inputs: [`Synthetic scenario ${ordinal}`],
        steps: isHypothesis
          ? [
              "Launch Settings using the reported sequence.",
              "Record the observed process and window state.",
            ]
          : ["Start a settings update.", "Cancel before persistence completes."],
      },
      impact: {
        description: isHypothesis
          ? "The reported failure may prevent access to settings; its scope remains unverified."
          : "Cancelled work can overwrite persisted settings and mislead the caller about the saved state.",
        affectedParties: ["Users updating PowerToys settings"],
      },
      rootCause: {
        status: isHypothesis ? "hypothesis" : "established",
        explanation: isHypothesis
          ? "Startup initialization may fail before the window is created; the reporter evidence does not identify the failing component."
          : "The persistence boundary does not inspect the cancellation token before committing state.",
        evidenceRefs: [evidenceId],
      },
      subjectRef: subjectId,
      locations:
        kind === "pr"
          ? [{ kind: "source", subjectRef: subjectId, path, startLine: 42, endLine: 42 }]
          : [
              {
                kind: "issue",
                subjectRef: subjectId,
                description: `Synthetic issue scenario ${ordinal}`,
              },
            ],
      evidenceRefs: [evidenceId],
      confirmation: {
        status: isHypothesis ? "hypothesis" : "confirmed",
        rationale: isHypothesis
          ? "The report was rechecked; confirmation requires the saved reproduction experiment."
          : "The final finding version was rechecked against the frozen source snapshot.",
        evidenceRefs: [evidenceId],
        recheckRef: recheckId,
      },
      fixRecommendation: {
        summary: isHypothesis
          ? "Run the saved reproduction experiment before selecting a fix."
          : "Check cancellation immediately before persistence and preserve the existing settings on cancellation.",
        constraints: ["Do not claim runtime verification from static or reporter evidence."],
        planRef,
      },
      feedbackDraft,
    });
    rechecks.push({
      id: recheckId,
      findingId,
      findingVersion: 1,
      subjectRef: subjectId,
      round: 3,
      evidenceRefs: [evidenceId],
      conclusion: isHypothesis
        ? "Retain the explicit hypothesis and saved reproduction plan; a reproduced defect has not been established."
        : "The final finding remains supported by the frozen snapshot and is distinct from the other findings.",
      unresolvedQuestions: isHypothesis
        ? ["Does the captured launch sequence reproduce on the identified version?"]
        : [],
    });
    candidates.push({
      id: `${prefix}-candidate-${ordinal}`,
      subjectRef: subjectId,
      title: findings[index]!.title,
      discoveredRound: 1,
      status: isHypothesis ? "unresolved" : "confirmed",
      findingId,
      findingVersion: 1,
      mergedIntoCandidateId: null,
      rationale: isHypothesis
        ? "Retained as a rechecked hypothesis with a saved experiment and an explicit evidence limitation."
        : "Confirmed and individually rechecked before final delivery.",
      evidenceRefs: [evidenceId],
    });
  }

  const coverage: InvestigationCoverage = {
    scopeManifest: { id: `${prefix}-scope`, version: 1, digest: "4".repeat(64) },
    includedUnits: [
      {
        id: `${prefix}-snapshot-unit`,
        subjectRef: subjectId,
        kind: "input_snapshot",
        paths: [],
        requiredWork: "Freeze the supplied work item and source identity before analysis.",
        status: "completed",
        evidenceRefs: [snapshotEvidenceId],
      },
      {
        id: analysisUnitId,
        subjectRef: subjectId,
        kind: "investigation",
        paths: [],
        requiredWork: "Investigate every frozen scope unit and recheck every retained finding.",
        status: complete ? "completed" : outcome === "blocked" ? "blocked" : "pending",
        evidenceRefs: complete ? evidence.map((item) => item.id) : [],
      },
    ],
    exclusions: [],
    completedUnitRefs: complete
      ? [`${prefix}-snapshot-unit`, analysisUnitId]
      : [`${prefix}-snapshot-unit`],
    unresolvedUnitRefs: complete ? [] : [analysisUnitId],
  };
  const assessment: InvestigationAssessment =
    kind === "pr"
      ? {
          kind: "pr",
          subjectRef: subjectId,
          summary: complete
            ? "Synthetic source review is complete; required runtime validation remains outstanding."
            : "Synthetic source review is incomplete; retained findings do not represent full coverage.",
          evidenceRefs: evidence.map((item) => item.id),
          reviewConclusion: {
            status: !complete
              ? "inconclusive"
              : findingCount > 0 && (priority === "P0" || priority === "P1")
                ? "changes-requested"
                : "no-blocking-findings",
            rationale: !complete
              ? "The investigation still has an unfinished scope unit."
              : findingCount > 0 && (priority === "P0" || priority === "P1")
                ? "The original PR contains confirmed high-priority findings."
                : "The completed source review contains no confirmed P0 or P1 findings.",
          },
          e2eAssessment: {
            level: "required",
            rationale:
              "Cancellation correctness requires a runtime observation of persistence behavior.",
            planRef,
            scenarioIds: [scenarioId],
            prerequisiteRefs: [prerequisiteId],
            linkedValidationReportRefs: [],
          },
        }
      : kind === "bug"
        ? {
            kind: "bug",
            subjectRef: subjectId,
            summary: "The launch failure remains a hypothesis with a saved reproduction plan.",
            evidenceRefs: evidence.map((item) => item.id),
            bugAssessment: {
              status: "needs_verification",
              rationale: "Reporter statements do not establish a reproduced failure or root cause.",
              missingInformation: [],
              hypotheses: ["Settings initialization may fail before the window is created."],
              upstreamFix: null,
              duplicateOf: null,
              expectedBehavior: "Settings opens successfully after the reported launch sequence.",
            },
            reproduction: {
              status: "not_run",
              summary: "No runtime reproduction has been executed by this synthetic fixture.",
              evidenceRefs: [],
              planRef,
            },
          }
        : {
            kind: "feature",
            subjectRef: subjectId,
            summary:
              "The export request has an implementable plan; maintainer acceptance is a separate decision.",
            evidenceRefs: [snapshotEvidenceId],
            featureAssessment: {
              status: "ready",
              requirements: ["Allow users to export a selected subset of settings."],
              feasibility:
                "The existing settings serializer can accept an explicit selection before producing the export.",
              missingInformation: [],
              decisions: [],
              alternatives: ["Continue exporting all settings and filter the result manually."],
              usage: null,
              duplicateOf: null,
              implementationPlanRef: planRef,
              acceptanceCriteria: [...plan.acceptanceCriteria],
              prerequisiteRefs: [],
            },
          };
  const summaryDraft: InvestigationFeedbackDraft = {
    id: `${prefix}-summary-draft`,
    suggestion: null,
    body:
      kind === "pr"
        ? "Please review the confirmed findings and the saved cancellation verification plan."
        : kind === "bug"
          ? "The current evidence does not establish the root cause. The saved reproduction plan captures the next experiment and its prerequisites."
          : "The requested export has a feasible implementation plan and explicit acceptance criteria; maintainer acceptance is still required.",
  };
  const followUp: InvestigationNextActionV1 = {
    id: `${prefix}-follow-up`,
    action: kind === "pr" ? "reviews.verify" : "start-task",
    taskKind:
      kind === "pr" ? "pr-verify" : kind === "bug" ? "reproduction-setup" : "feature-implement",
    label:
      kind === "pr"
        ? "Verify the original PR"
        : kind === "bug"
          ? "Prepare reproduction"
          : "Start implementation",
    reason: plan.rationale,
    recommended:
      complete && !(kind === "pr" && findingCount > 0 && (priority === "P0" || priority === "P1")),
    subjectRef: subjectId,
    planRef,
    draftRef: null,
    validationReportRef: null,
    prerequisiteRefs: plan.prerequisites.map((item) => item.id),
    state: "saved",
    sourceReportRef,
  };
  const nextActions: InvestigationNextActionV1[] = [
    followUp,
    {
      id: `${prefix}-feedback`,
      action:
        kind === "pr" && findingCount > 0 && (priority === "P0" || priority === "P1")
          ? "request-changes"
          : "comment",
      taskKind: null,
      label: "Prepare feedback",
      reason: "Review the draft before submitting any external feedback.",
      recommended:
        complete && kind === "pr" && findingCount > 0 && (priority === "P0" || priority === "P1"),
      subjectRef: subjectId,
      planRef: null,
      draftRef: summaryDraft.id,
      validationReportRef: null,
      prerequisiteRefs: [],
      state: "saved",
      sourceReportRef,
    },
  ];
  const result: InvestigationResultV1 = {
    schemaVersion: "InvestigationResultV1",
    id: reportId,
    version: 1,
    context: {
      repository,
      workItem,
      task: {
        id: taskId,
        kind: kind === "pr" ? "pr-review" : "issue-investigate",
        parentTaskId: null,
        subjectRef: subjectId,
      },
      attempt: { id: attemptId, number: 1 },
      adoptedAttemptIds: [attemptId],
      subjects: [subject],
      profileRef,
      promptRef,
      parentReportRef: null,
    },
    outcome,
    report: {
      id: reportId,
      version: 1,
      delivery: complete ? "final" : "checkpoint",
      completeness: complete ? "complete" : "partial",
      summary: complete
        ? `Synthetic investigation delivered all ${findingCount} retained findings after individual rechecks.`
        : "Synthetic investigation stopped before full scope coverage; retained findings and remaining work are preserved.",
      logicalContentDigest: reportDigest,
      coverage,
      recheck: {
        finalFindingCount: findingCount,
        validFinalVersionRecheckCount: rechecks.length,
        pendingFindingIds: [],
        records: rechecks,
      },
      loop: {
        checkpointId: `${prefix}-checkpoint`,
        checkpointVersion: 3,
        completedRounds: 3,
        candidates,
        stopReason: complete ? "complete" : outcome === "failed" ? "error" : outcome,
        budget,
        consumed: {
          rounds: 3,
          durationMs: 3_000,
          tokens: 2_000 + findingCount * 400,
          reportBytes: 4_096 + findingCount * 4_096,
        },
      },
      limitations: [
        {
          id: `${prefix}-synthetic-limitation`,
          description:
            "This is isolated synthetic fixture data, not evidence of a live investigation.",
          impact: "No runtime behavior or upstream repository state has been verified.",
          evidenceRefs: [snapshotEvidenceId],
        },
        ...(kind === "bug"
          ? [
              {
                id: `${prefix}-reproduction-limitation`,
                description: "The launch-failure hypothesis has not been reproduced.",
                impact:
                  "Run the saved reproduction experiment before treating the hypothesis as a confirmed defect.",
                evidenceRefs: evidence.map((item) => item.id),
              },
            ]
          : []),
      ],
      collections: {
        findings: findings.length,
        verificationEvidence: evidence.length,
        artifacts: 1,
        plans: 1,
        nextActions: nextActions.length,
        candidates: candidates.length,
        rechecks: rechecks.length,
      },
    },
    findings,
    assessment,
    validation: {
      checks:
        kind === "feature"
          ? []
          : [
              {
                id: checkId,
                scenarioId,
                subjectRef: subjectId,
                planRef,
                required: true,
                description: plan.steps[0]!.description,
                status: "not_run",
                executor: null,
                evidenceRefs: [],
                authoritativeAttemptId: null,
              },
            ],
      summary: "This synthetic fixture includes no executed runtime checks.",
    },
    verificationEvidence: evidence,
    diagnostics: complete
      ? []
      : [
          {
            id: `${prefix}-termination`,
            code: `SYNTHETIC_${outcome.toUpperCase()}`,
            category:
              outcome === "blocked" ? "blocker" : outcome === "failed" ? "error" : "limitation",
            message: "The synthetic attempt ended with an unfinished investigation scope unit.",
            retryable: true,
            evidenceRefs: [snapshotEvidenceId],
            prerequisiteRefs: outcome === "blocked" && kind !== "feature" ? [prerequisiteId] : [],
          },
        ],
    artifacts: [
      {
        id: sourceArtifactId,
        taskId,
        attemptId,
        subjectRef: subjectId,
        kind: "source",
        name: "synthetic-input.json",
        mediaType: "application/json",
        digest: "5".repeat(64),
        byteLength: 0,
        availability: "available",
      },
    ],
    plans: [plan],
    nextActions,
    feedbackDrafts: [summaryDraft],
  };
  const task: InvestigationTaskV1 = {
    schemaVersion: "InvestigationTaskV1",
    id: taskId,
    kind: result.context.task.kind,
    repository,
    workItem,
    parentTaskId: null,
    parentReportRef: null,
    planRef: null,
    subjectRef: subjectId,
    subjects: [subject],
    scope: coverage,
    executionPolicy: {
      mode: kind === "pr" ? "source_read" : "snapshot_only",
      allowedSubjectRefs: [subjectId],
      allowRepositoryExecution: false,
      authorizationRef: null,
    },
    budget,
    profileRef,
    promptRef,
    state: outcome,
    latestReportRef: reportRef,
    createdAt: startedAt,
    updatedAt: finishedAt,
  };
  const attempt: InvestigationAttemptV1 = {
    schemaVersion: "InvestigationAttemptV1",
    id: attemptId,
    taskId,
    number: 1,
    workerId: "synthetic-worker",
    leaseVersion: 1,
    state: outcome,
    startedAt,
    finishedAt,
    terminationReason: complete ? null : `Synthetic ${outcome} outcome.`,
  };
  // Keep the frozen task independent so mutating a result cannot silently rewrite its input scope.
  return { task: structuredClone(task), attempt, result };
}
