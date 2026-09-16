import {
  type ActionContextV1,
  createInvestigationPreview,
  type InvestigationActionGuard,
  type InvestigationActionIntentV1,
  type InvestigationActionKind,
  type InvestigationArtifactMetadataV1,
  type InvestigationFindingsPageV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationReportHeaderV1,
  type InvestigationReportRef,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import type {
  CreateTaskInput,
  InvestigationApi,
  PrepareActionInput,
  TaskDetail,
  WorkItem,
} from "./api";
import { InvestigationHttpError } from "./transport";

const repository = {
  id: "repo-powertoys-fork",
  fullName: "moooyo/PowerToys",
  githubRepositoryId: 900_001,
};
const sampleTime = "2026-09-15T03:00:00.000Z";
const noDispatchMessage = "Sample mode: no GitHub action was dispatched.";
type Fixture = ReturnType<typeof createInvestigationPreview>;

function renameFixture(value: unknown, sourcePrefix: string, targetPrefix: string): unknown {
  if (typeof value === "string") {
    return value === "synthetic-powertoys-repository"
      ? repository.id
      : value.startsWith(sourcePrefix)
        ? targetPrefix + value.slice(sourcePrefix.length)
        : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renameFixture(item, sourcePrefix, targetPrefix));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renameFixture(item, sourcePrefix, targetPrefix),
      ]),
    );
  }
  return value;
}

function sampleFixtures(): Fixture[] {
  const cases = [
    {
      name: "pr-p1",
      kind: "pr",
      number: 2101,
      title: "[Sample] Cancellation persists stale Settings values",
      findingCount: 2,
      priority: "P1",
      outcome: "completed",
    },
    {
      name: "pr-p0",
      kind: "pr",
      number: 2102,
      title: "[Sample] Review with a P0 finding on page two",
      findingCount: 26,
      priority: "P2",
      outcome: "completed",
    },
    {
      name: "pr-partial",
      kind: "pr",
      number: 2103,
      title: "[Sample] Interrupted Settings migration review",
      findingCount: 1,
      priority: "P2",
      outcome: "interrupted",
    },
    {
      name: "bug",
      kind: "bug",
      number: 3101,
      title: "[Sample] Settings does not open after an update",
      findingCount: 1,
      priority: "P2",
      outcome: "completed",
    },
    {
      name: "feature",
      kind: "feature",
      number: 3102,
      title: "[Sample] Export a selected subset of Settings",
      findingCount: 0,
      priority: "P2",
      outcome: "completed",
    },
  ] as const;

  return cases.map((scenario) => {
    const fixture = renameFixture(
      createInvestigationPreview(scenario.kind, scenario),
      `synthetic-${scenario.kind}`,
      `sample-${scenario.name}`,
    ) as Fixture;
    fixture.task.workItem.number = scenario.number;
    fixture.task.workItem.title = scenario.title;
    fixture.task.repository.githubRepositoryId = repository.githubRepositoryId;
    fixture.result.context.workItem.number = scenario.number;
    fixture.result.context.workItem.title = scenario.title;
    fixture.result.context.repository.githubRepositoryId = repository.githubRepositoryId;
    if (scenario.name === "pr-p1") {
      const plainFinding = fixture.result.findings[1];
      if (plainFinding) {
        plainFinding.priority = "P2";
        plainFinding.feedbackDraft.suggestion = null;
      }
    }
    if (scenario.name === "pr-p0") {
      const blocker = fixture.result.findings[25];
      if (blocker) {
        blocker.priority = "P0";
        blocker.title = "A cancelled migration can overwrite the only recoverable Settings copy";
      }
      if (fixture.result.assessment.kind === "pr") {
        fixture.result.assessment.reviewConclusion = {
          status: "changes-requested",
          rationale:
            "The complete synthetic report contains an original-PR P0 finding on page two.",
        };
      }
      fixture.result.nextActions = fixture.result.nextActions.map((action) => ({
        ...action,
        action: action.draftRef ? "request-changes" : action.action,
        recommended: action.draftRef !== null,
      }));
    }
    return fixture;
  });
}

function reportRef(report: InvestigationResultV1): InvestigationReportRef {
  return { id: report.id, version: report.version, digest: report.report.logicalContentDigest };
}

function reportHeader(result: InvestigationResultV1): InvestigationReportHeaderV1 {
  const { candidates: _candidates, ...loop } = result.report.loop;
  const coverage = result.report.coverage;
  return {
    schemaVersion: "InvestigationReportHeaderV1",
    id: result.id,
    version: result.version,
    context: result.context,
    outcome: result.outcome,
    assessment: result.assessment,
    validation: { summary: result.validation.summary },
    report: {
      id: result.id,
      version: result.version,
      delivery: result.report.delivery,
      completeness: result.report.completeness,
      summary: result.report.summary,
      logicalContentDigest: result.report.logicalContentDigest,
      coverage: {
        scopeManifest: coverage.scopeManifest,
        includedUnitCount: coverage.includedUnits.length,
        completedUnitCount: coverage.completedUnitRefs.length,
        unresolvedUnitCount: coverage.unresolvedUnitRefs.length,
        exclusionCount: coverage.exclusions.length,
      },
      recheck: {
        finalFindingCount: result.report.recheck.finalFindingCount,
        validFinalVersionRecheckCount: result.report.recheck.validFinalVersionRecheckCount,
        pendingFindingCount: result.report.recheck.pendingFindingIds.length,
      },
      loop,
      collections: result.report.collections,
    },
  };
}

function reportCheckpoint(fixture: Fixture): InvestigationLoopCheckpointV1 | null {
  if (fixture.result.outcome === "completed") return null;
  const { task, attempt, result } = fixture;
  return {
    schemaVersion: "InvestigationLoopCheckpointV1",
    id: result.report.loop.checkpointId,
    version: result.report.loop.checkpointVersion,
    digest: "6".repeat(64),
    taskId: task.id,
    attemptId: attempt.id,
    leaseVersion: attempt.leaseVersion,
    subjectRevisionKey: task.subjects[0]!.revisionKey,
    profileRef: task.profileRef,
    promptRef: task.promptRef,
    previousCheckpointRef: null,
    round: result.report.loop.completedRounds,
    analysis: {
      schemaVersion: "InvestigationAnalysisV1",
      summary: result.report.summary,
      coverage: result.report.coverage,
      findings: result.findings,
      assessment: result.assessment,
      candidates: result.report.loop.candidates,
      rechecks: result.report.recheck.records,
      evidence: result.verificationEvidence.flatMap((evidence) =>
        evidence.source === "static_analysis" || evidence.source === "reporter_statement"
          ? [
              {
                id: evidence.id,
                subjectRef: evidence.subjectRef,
                source: evidence.source,
                summary: evidence.summary,
                evidenceRefs: evidence.evidenceRefs,
              },
            ]
          : [],
      ),
      plans: result.plans.map(
        ({ digest: _digest, sourceReportRef: _source, state: _state, ...plan }) => plan,
      ),
      nextActions: result.nextActions.map(
        ({ sourceReportRef: _source, state: _state, ...action }) => action,
      ),
      feedbackDrafts: result.feedbackDrafts,
      diagnostics: result.diagnostics,
      limitations: result.report.limitations,
    },
    adoptedAttemptIds: result.context.adoptedAttemptIds,
    recordedAt: sampleTime,
    budget: task.budget,
    consumed: result.report.loop.consumed,
    stopReason: result.report.loop.stopReason,
    taskBindingDigest: "7".repeat(64),
    lastPhase: "recheck",
    runtime: {
      completedStepIds: [],
      checks: result.validation.checks,
      evidence: result.verificationEvidence,
      artifacts: result.artifacts,
      subjects: result.context.subjects,
      startedSteps: [],
      completedSteps: [],
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function payloadDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function required<T>(map: ReadonlyMap<string, T>, id: string, kind: string): T {
  const value = map.get(id);
  if (!value) throw new InvestigationHttpError(404, `The sample ${kind} was not found.`);
  return value;
}

function guard(code: string, satisfied: boolean, message: string): InvestigationActionGuard {
  return { code, satisfied, message };
}

/** Each adapter owns isolated synthetic state and never dispatches network requests. */
export function createSampleInvestigationApi(): InvestigationApi {
  const workItems = new Map<string, WorkItem>();
  const tasks = new Map<string, TaskDetail>();
  const reports = new Map<string, InvestigationResultV1>();
  const artifacts = new Map<string, InvestigationArtifactMetadataV1>();
  const intents = new Map<string, InvestigationActionIntentV1>();
  const taskRequests = new Map<string, { input: string; taskId: string }>();
  const actionRequests = new Map<string, { input: string; intentId: string }>();
  const resumeRequests = new Map<string, string>();
  const confirmedVersions = new Map<string, number>();
  let sequence = 0;

  for (const fixture of sampleFixtures()) {
    const subject = fixture.task.subjects.find((item) => item.id === fixture.task.subjectRef)!;
    workItems.set(fixture.task.workItem.id, {
      ...fixture.task.workItem,
      repositoryId: repository.id,
      body: "This work item is an isolated development sample. No live repository was accessed.",
      state: "open",
      subject,
      updatedAt: sampleTime,
    });
    reports.set(fixture.result.id, fixture.result);
    for (const artifact of fixture.result.artifacts) {
      const expired = fixture.task.id === "sample-pr-partial-task";
      artifacts.set(artifact.id, {
        artifact: { ...artifact, availability: expired ? "expired" : "missing" },
        storedAt: sampleTime,
        expiredAt: expired ? "2026-09-16T03:00:00.000Z" : null,
        retentionProtected: false,
      });
    }
    tasks.set(fixture.task.id, {
      task: fixture.task,
      attempts: [fixture.attempt],
      checkpoint: reportCheckpoint(fixture),
      latestReport: reportHeader(fixture.result),
      children: [],
    });
  }

  function itemReport(workItemId: string, id?: string): InvestigationResultV1 | undefined {
    const report = id
      ? required(reports, id, "report")
      : [...reports.values()].find((item) => item.context.workItem.id === workItemId);
    if (report && report.context.workItem.id !== workItemId) {
      throw new InvestigationHttpError(409, "The sample report belongs to another work item.");
    }
    return report;
  }

  function actionContext(workItemId: string, id?: string): ActionContextV1 {
    const item = required(workItems, workItemId, "work item");
    const report = itemReport(workItemId, id);
    const reference = report ? reportRef(report) : null;
    const isPr = item.subject.kind === "original_pr";
    const blockers =
      report && reference
        ? report.findings
            .filter(
              (finding) =>
                isPr &&
                finding.subjectRef === item.subject.id &&
                finding.priority === "P0" &&
                finding.confirmation.status === "confirmed",
            )
            .map((finding) => ({
              findingId: finding.id,
              reportRef: reference,
              checkpointRef: null,
              reason:
                "A confirmed original-PR P0 finding blocks approval independently of feedback selection.",
            }))
        : [];
    const suggestionSelectionDefaults = (report?.findings ?? []).flatMap((finding) => {
      const suggestion = finding.feedbackDraft.suggestion;
      if (!suggestion) return [];
      const valid =
        isPr &&
        item.subject.kind === "original_pr" &&
        suggestion.subjectRef === item.subject.id &&
        suggestion.headSha === item.subject.headSha &&
        suggestion.startLine > 0 &&
        suggestion.endLine >= suggestion.startLine;
      return [
        {
          findingId: finding.id,
          draftId: finding.feedbackDraft.id,
          valid,
          selectedByDefault: valid,
          reason: valid
            ? "The synthetic suggestion matches this fixture's frozen source binding. No live source was queried."
            : "The synthetic suggestion does not match this fixture's source binding.",
        },
      ];
    });
    const approvalGuards = [
      guard("original_pr", isPr, "Approval requires an original pull request subject."),
      guard(
        "no_original_pr_p0",
        blockers.length === 0,
        "The investigation must contain no confirmed original-PR P0 findings.",
      ),
    ];
    const availability = (action: InvestigationActionKind, guards: InvestigationActionGuard[]) => ({
      action,
      allowed: guards.every((item) => item.satisfied),
      reason:
        guards.find((item) => !item.satisfied)?.message ??
        "Available for a sample preview; external confirmation will not dispatch to GitHub.",
      guards,
    });
    const savedActions = report?.nextActions ?? [];
    const nextActions = savedActions.map((action) => {
      const requiresSource =
        item.kind === "issue" &&
        (action.action === "start-task" || action.action === "reviews.verify");
      return {
        ...action,
        allowed: !requiresSource,
        canPrepare: true,
        readyToExecute: !requiresSource,
        guards: [
          guard(
            "sample_saved_action",
            true,
            "This saved action is bound to an isolated sample report.",
          ),
          ...(requiresSource
            ? [
                guard(
                  "sample_source_commit",
                  false,
                  "Choose an explicit source commit before starting this linked Issue task.",
                ),
              ]
            : []),
        ],
      };
    });
    const recommended = savedActions.find((action) => action.recommended);
    const recommendation: ActionContextV1["recommendation"] =
      report?.outcome === "interrupted"
        ? { action: "resume", reason: "Resume the synthetic task from its preserved checkpoint." }
        : {
            action: recommended?.action ?? "comment",
            reason: recommended?.reason ?? "Review the sample feedback before preparing an action.",
          };
    return {
      schemaVersion: "ActionContextV1",
      workItemId,
      repositoryId: repository.id,
      actor: { id: "sample-operator", displayName: "Development Operator" },
      target: {
        kind: item.kind,
        state: item.state,
        headSha: item.subject.kind === "original_pr" ? item.subject.headSha : null,
        revisionKey: item.subject.revisionKey,
      },
      reportRef: reference,
      recommendedActionId: recommendation.action === "resume" ? null : (recommended?.id ?? null),
      recommendation,
      hardContentBlockers: blockers,
      fixedActions: isPr
        ? [
            availability("comment", []),
            availability("approve", approvalGuards),
            availability("suggestion-comment", [
              guard(
                "valid_suggestion",
                suggestionSelectionDefaults.some((option) => option.valid),
                "A valid source-bound suggestion is required.",
              ),
            ]),
            availability("request-changes", [
              guard("pull_request", isPr, "Request changes is available for pull requests."),
            ]),
            availability("close", []),
            availability("merge", [
              guard("pull_request", isPr, "Merging requires a pull request."),
              guard(
                "target_state",
                item.state === "open",
                "The pull request must be open before merging.",
              ),
            ]),
            availability("trigger-ci", [
              guard("pull_request", isPr, "CI triggering is available for pull requests."),
            ]),
          ]
        : [availability("comment", []), availability("close", [])],
      suggestionSelectionDefaults,
      nextActions,
      pendingSubmission: null,
      generatedAt: sampleTime,
    };
  }

  function createTask(input: CreateTaskInput): InvestigationTaskV1 {
    if (input.sourceCommit !== undefined && !/^[a-f0-9]{40,64}$/u.test(input.sourceCommit)) {
      throw new InvestigationHttpError(
        400,
        "The sample source commit must be a full hexadecimal SHA.",
      );
    }
    const serialized = canonicalJson(input);
    const requestKey = `${input.workItemId}:${input.idempotencyKey}`;
    const previous = taskRequests.get(requestKey);
    if (previous) {
      if (previous.input !== serialized)
        throw new InvestigationHttpError(
          409,
          "The sample task idempotency key was reused with different content.",
        );
      return required(tasks, previous.taskId, "task").task;
    }
    required(workItems, input.workItemId, "work item");
    const template = [...tasks.values()].find(
      (item) => item.task.workItem.id === input.workItemId,
    )!.task;
    const parent = input.parentReportRef
      ? itemReport(input.workItemId, input.parentReportRef.id)
      : undefined;
    if (
      input.parentReportRef &&
      (!parent || canonicalJson(reportRef(parent)) !== canonicalJson(input.parentReportRef))
    ) {
      throw new InvestigationHttpError(409, "The sample parent report binding changed.");
    }
    const selectedPlan = input.planRef;
    if (
      selectedPlan &&
      !parent?.plans.some(
        (plan) =>
          plan.id === selectedPlan.id &&
          plan.version === selectedPlan.version &&
          plan.digest === selectedPlan.digest,
      )
    ) {
      throw new InvestigationHttpError(
        409,
        "The sample task requires its exact saved parent plan.",
      );
    }
    const scope = structuredClone(input.scope ?? template.scope);
    scope.includedUnits = scope.includedUnits.map((unit) => ({
      ...unit,
      status: "pending",
      evidenceRefs: [],
    }));
    scope.completedUnitRefs = [];
    scope.unresolvedUnitRefs = scope.includedUnits.map((unit) => unit.id);
    const taskId = `sample-created-task-${++sequence}`;
    const chosenSource =
      input.sourceCommit === undefined
        ? undefined
        : {
            id: `${taskId}-source`,
            kind: "source_commit" as const,
            repositoryId: repository.id,
            workItemId: input.workItemId,
            revisionKey: input.sourceCommit.padEnd(64, "0"),
            commitSha: input.sourceCommit,
          };
    if (chosenSource) {
      scope.includedUnits = scope.includedUnits.map((unit) => ({
        ...unit,
        subjectRef: chosenSource.id,
      }));
    }
    const task: InvestigationTaskV1 = {
      ...structuredClone(template),
      id: taskId,
      kind: input.kind,
      parentTaskId: parent?.context.task.id ?? null,
      parentReportRef: input.parentReportRef ?? null,
      planRef: input.planRef ?? null,
      scope,
      subjectRef: chosenSource?.id ?? template.subjectRef,
      subjects: chosenSource ? [...template.subjects, chosenSource] : template.subjects,
      executionPolicy: {
        ...template.executionPolicy,
        mode:
          input.executionMode ??
          (template.workItem.kind === "issue" ? "snapshot_only" : "source_read"),
        allowedSubjectRefs: chosenSource
          ? [chosenSource.id]
          : template.executionPolicy.allowedSubjectRefs,
        allowRepositoryExecution: false,
        authorizationRef: null,
      },
      budget: input.budget ?? template.budget,
      profileRef: input.profileRef ?? template.profileRef,
      promptRef: input.promptRef ?? template.promptRef,
      state: "queued",
      latestReportRef: null,
      createdAt: sampleTime,
      updatedAt: sampleTime,
    };
    const stored = structuredClone(task);
    tasks.set(task.id, {
      task: stored,
      attempts: [],
      checkpoint: null,
      latestReport: null,
      children: [],
    });
    taskRequests.set(requestKey, { input: serialized, taskId: task.id });
    return stored;
  }

  const api: InvestigationApi = {
    repositories: async () => ({ items: [structuredClone(repository)] }),
    workItems: async (repositoryId, kind) => ({
      items: structuredClone(
        [...workItems.values()].filter(
          (item) =>
            (!repositoryId || item.repositoryId === repositoryId) && (!kind || item.kind === kind),
        ),
      ),
    }),
    workItem: async (id) => structuredClone(required(workItems, id, "work item")),
    importWorkItem: async () => {
      throw new InvestigationHttpError(
        403,
        "Sample mode uses the fixed synthetic directory. Connect the production service to import a real work item.",
      );
    },
    tasks: async (workItemId) => ({
      items: structuredClone(
        [...tasks.values()]
          .map((item) => item.task)
          .filter((task) => !workItemId || task.workItem.id === workItemId),
      ),
    }),
    task: async (id) => {
      const detail = required(tasks, id, "task");
      return structuredClone({
        ...detail,
        children: [...tasks.values()]
          .map((item) => item.task)
          .filter((task) => task.parentTaskId === id),
      });
    },
    createTask: async (input) => structuredClone(createTask(structuredClone(input))),
    resumeTask: async (id, idempotencyKey, budget) => {
      const detail = required(tasks, id, "task");
      const key = `${id}:${idempotencyKey}`;
      const signature = canonicalJson(budget ?? null);
      if (resumeRequests.has(key)) {
        if (resumeRequests.get(key) !== signature)
          throw new InvestigationHttpError(
            409,
            "The sample resume key was reused with a different budget.",
          );
        return structuredClone(detail.task);
      }
      if (!["interrupted", "blocked", "failed", "cancelled"].includes(detail.task.state)) {
        throw new InvestigationHttpError(409, "Only a stopped sample task can be resumed.");
      }
      if (
        budget &&
        Object.entries(budget).some(
          ([name, value]) =>
            !Number.isSafeInteger(value) ||
            value < detail.task.budget[name as keyof InvestigationTaskV1["budget"]],
        )
      )
        throw new InvestigationHttpError(
          400,
          "Sample resume limits cannot decrease the saved budget.",
        );
      const nextBudget = budget ?? detail.task.budget;
      const consumed = detail.checkpoint?.consumed;
      if (
        consumed &&
        (consumed.rounds >= nextBudget.maxRounds ||
          consumed.durationMs >= nextBudget.maxDurationMs ||
          consumed.tokens >= nextBudget.maxTokens ||
          consumed.reportBytes >= nextBudget.maxReportBytes)
      )
        throw new InvestigationHttpError(
          409,
          "Increase the exhausted sample budget before resuming.",
        );
      detail.task = {
        ...detail.task,
        budget: structuredClone(nextBudget),
        state: "queued",
        updatedAt: sampleTime,
      };
      resumeRequests.set(key, signature);
      return structuredClone(detail.task);
    },
    cancelTask: async (id) => {
      const detail = required(tasks, id, "task");
      if (!["queued", "running"].includes(detail.task.state)) {
        return structuredClone(detail.task);
      }
      detail.task = { ...detail.task, state: "cancelled", updatedAt: sampleTime };
      detail.attempts = detail.attempts.map((attempt) =>
        ["queued", "leased", "running"].includes(attempt.state)
          ? {
              ...attempt,
              state: "cancelled",
              finishedAt: sampleTime,
              terminationReason: "Cancelled in sample mode; no worker execution occurred.",
            }
          : attempt,
      );
      return structuredClone(detail.task);
    },
    report: async (id) => structuredClone(reportHeader(required(reports, id, "report"))),
    findings: async (id, cursor, limit = 25) => {
      const report = required(reports, id, "report");
      const prefix = `${id}:${report.version}:`;
      if (
        cursor !== undefined &&
        (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length)))
      ) {
        throw new InvestigationHttpError(
          400,
          "The sample findings cursor does not belong to this report.",
        );
      }
      const offset = cursor ? Number(cursor.slice(prefix.length)) : 0;
      if (
        !Number.isSafeInteger(offset) ||
        offset > report.findings.length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        throw new InvestigationHttpError(
          400,
          "Use a valid sample cursor and a page size between 1 and 100.",
        );
      }
      const end = Math.min(offset + limit, report.findings.length);
      const page: InvestigationFindingsPageV1 = {
        schemaVersion: "InvestigationFindingsPageV1",
        reportRef: reportRef(report),
        total: report.findings.length,
        offset,
        nextCursor: end < report.findings.length ? `${prefix}${end}` : null,
        items: report.findings.slice(offset, end),
      };
      return structuredClone(page);
    },
    exportReport: async (id) => structuredClone(required(reports, id, "report")),
    artifact: async (id, signal) => {
      signal?.throwIfAborted();
      return structuredClone(required(artifacts, id, "artifact"));
    },
    actionContext: async (workItemId, reportId) =>
      structuredClone(actionContext(workItemId, reportId)),
    prepareAction: async (input: PrepareActionInput) => {
      const snapshot = structuredClone(input);
      const serialized = canonicalJson(snapshot);
      const digest = await payloadDigest(snapshot.payload);
      const requestKey = `${snapshot.workItemId}:${snapshot.idempotencyKey}`;
      const previous = actionRequests.get(requestKey);
      if (previous) {
        if (previous.input !== serialized)
          throw new InvestigationHttpError(
            409,
            "The sample action idempotency key was reused with different content.",
          );
        return structuredClone(required(intents, previous.intentId, "intent"));
      }
      const context = actionContext(snapshot.workItemId, snapshot.reportRef?.id);
      const item = required(workItems, snapshot.workItemId, "work item");
      if (
        snapshot.subjectRef !== item.subject.id ||
        snapshot.expectedRevisionKey !== context.target.revisionKey ||
        snapshot.expectedHeadSha !== context.target.headSha ||
        canonicalJson(snapshot.reportRef) !== canonicalJson(context.reportRef)
      ) {
        throw new InvestigationHttpError(409, "The sample source or report binding changed.");
      }
      const selectedNextAction = snapshot.nextActionId
        ? context.nextActions.find(
            (action) => action.id === snapshot.nextActionId && action.action === snapshot.action,
          )
        : undefined;
      const availability = snapshot.nextActionId
        ? selectedNextAction
        : context.fixedActions.find((action) => action.action === snapshot.action);
      if (
        !availability ||
        !("canPrepare" in availability ? availability.canPrepare : availability.allowed)
      )
        throw new InvestigationHttpError(
          409,
          "The sample action is blocked by the current action context.",
        );
      const resolvedGuards = availability.guards.map((entry) =>
        entry.code === "sample_source_commit"
          ? {
              ...entry,
              satisfied:
                snapshot.payload.kind === "task" &&
                snapshot.payload.sourceCommit !== undefined &&
                /^[a-f0-9]{40,64}$/u.test(snapshot.payload.sourceCommit),
            }
          : entry,
      );
      if (
        (snapshot.action === "start-task" || snapshot.action === "reviews.verify") &&
        (snapshot.payload.kind !== "task" ||
          !selectedNextAction ||
          snapshot.payload.taskKind !== selectedNextAction.taskKind ||
          canonicalJson(snapshot.payload.planRef) !== canonicalJson(selectedNextAction.planRef))
      ) {
        throw new InvestigationHttpError(
          409,
          "The sample action requires the task kind and plan from its saved next action.",
        );
      }
      const report = snapshot.reportRef
        ? required(reports, snapshot.reportRef.id, "report")
        : undefined;
      if (snapshot.payload.kind === "feedback") {
        const selectedIds = snapshot.payload.findingIds;
        if (selectedIds.some((id) => !report?.findings.some((finding) => finding.id === id))) {
          throw new InvestigationHttpError(
            409,
            "A selected finding does not belong to the sample report.",
          );
        }
        const allowedDraftIds = new Set([
          ...(report?.feedbackDrafts.map((draft) => draft.id) ?? []),
          ...(report?.findings
            .filter((finding) => selectedIds.includes(finding.id))
            .map((finding) => finding.feedbackDraft.id) ?? []),
        ]);
        if (snapshot.payload.drafts.some((draft) => !allowedDraftIds.has(draft.id))) {
          throw new InvestigationHttpError(
            409,
            "A selected draft does not belong to the selected sample feedback.",
          );
        }
      }
      const intent: InvestigationActionIntentV1 = {
        schemaVersion: "InvestigationActionIntentV1",
        id: `sample-intent-${++sequence}`,
        version: 1,
        idempotencyKey: snapshot.idempotencyKey,
        action: snapshot.action,
        repositoryId: repository.id,
        workItemId: snapshot.workItemId,
        actorId: "sample-operator",
        subjectRef: snapshot.subjectRef,
        expectedRevisionKey: snapshot.expectedRevisionKey,
        expectedHeadSha: snapshot.expectedHeadSha,
        reportRef: snapshot.reportRef,
        payload: snapshot.payload,
        payloadDigest: digest,
        state: "prepared",
        guards: resolvedGuards,
        createdAt: sampleTime,
        confirmedAt: null,
        result: null,
      };
      intents.set(intent.id, intent);
      actionRequests.set(requestKey, { input: serialized, intentId: intent.id });
      return structuredClone(intent);
    },
    actionIntent: async (id) => structuredClone(required(intents, id, "intent")),
    confirmAction: async (id, version, digest) => {
      const intent = required(intents, id, "intent");
      if (
        digest !== intent.payloadDigest ||
        version !== (confirmedVersions.get(id) ?? intent.version)
      ) {
        throw new InvestigationHttpError(
          409,
          "The sample confirmation does not match the prepared intent.",
        );
      }
      if (intent.state !== "prepared") return structuredClone(intent);
      if (intent.guards.some((entry) => !entry.satisfied))
        throw new InvestigationHttpError(
          409,
          "The sample action still has unmet execution prerequisites.",
        );
      confirmedVersions.set(id, version);
      let result: NonNullable<InvestigationActionIntentV1["result"]>;
      let state: InvestigationActionIntentV1["state"] = "failed";
      if (
        (intent.action === "start-task" || intent.action === "reviews.verify") &&
        intent.payload.kind === "task" &&
        intent.reportRef
      ) {
        const task = createTask({
          idempotencyKey: `sample-intent:${id}`,
          workItemId: intent.workItemId,
          kind: intent.payload.taskKind,
          parentReportRef: intent.reportRef,
          planRef: intent.payload.planRef,
          executionMode: "source_read",
          ...(intent.payload.sourceCommit ? { sourceCommit: intent.payload.sourceCommit } : {}),
        });
        state = "succeeded";
        result = {
          message:
            "Sample mode: a synthetic child task was queued. No worker or GitHub action was dispatched.",
          externalId: null,
          taskId: task.id,
        };
      } else {
        result = { message: noDispatchMessage, externalId: null, taskId: null };
      }
      const confirmed = {
        ...intent,
        version: intent.version + 1,
        state,
        confirmedAt: sampleTime,
        result,
      };
      intents.set(id, confirmed);
      return structuredClone(confirmed);
    },
    reconcileAction: async (id) => structuredClone(required(intents, id, "intent")),
  };
  return api;
}
