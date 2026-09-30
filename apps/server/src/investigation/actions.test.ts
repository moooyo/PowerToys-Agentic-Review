import {
  type ActionContextV1,
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationActionIntentV1,
  InvestigationActionIntentV1Schema,
  type InvestigationActionKind,
  type InvestigationCreateActionIntentRequest,
  type InvestigationCreateTaskRequestV1,
  type InvestigationTaskV1,
  investigationPlanDigestPayload,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationActions, type InvestigationActionsDependencies } from "./actions.js";
import { buildInvestigationApp } from "./app.js";
import { InvestigationRequestError } from "./errors.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationPrerequisiteResolver,
  InvestigationWorkItemRecord,
} from "./types.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness(
  options: {
    kind?: "pr" | "bug" | "feature";
    externalWrites?: boolean;
    findingCount?: number;
    priority?: "P0" | "P1" | "P2";
    validateTaskAction?: InvestigationActionsDependencies["validateTaskAction"];
    resolvePlanPrerequisites?: InvestigationPrerequisiteResolver;
  } = {},
) {
  const fixture = createInvestigationFixture(options.kind ?? "pr", {
    findingCount: options.findingCount ?? 0,
    priority: options.priority ?? "P2",
  });
  const store = new InvestigationStore();
  stores.push(store);
  const { task, result } = fixture;
  const subject = task.subjects[0]!;
  const workItem: InvestigationWorkItemRecord = {
    ...task.workItem,
    repositoryId: task.repository.id,
    body: "Synthetic work item",
    state: "open",
    subject,
    updatedAt: task.updatedAt,
  };
  store.insert("repositories", task.repository.id, task.repository);
  store.insert("workItems", workItem.id, workItem);
  store.insert("tasks", task.id, task);
  store.insert("reports", result.report.id, result);
  for (const plan of result.plans) store.insert("plans", `${result.report.id}:${plan.id}`, plan);
  const capabilities: InvestigationActionKind[] = [
    "comment",
    "approve",
    "suggestion-comment",
    "request-changes",
    "close",
    "merge",
    "trigger-ci",
    "close-as-duplicate",
    "start-task",
    "reviews.verify",
    "view-evidence",
    "view-validation",
    "view-changes",
    "create-pr",
  ];
  const actor: InvestigationOperatorPrincipal = {
    id: "synthetic-operator",
    displayName: "Synthetic operator",
    repositoryIds: [task.repository.id],
    permissions: ["action:prepare", "action:execute", "task:create"],
    actionCapabilities: capabilities,
    allowRepositoryExecution: true,
  };
  const target: ActionContextV1["target"] = {
    kind: workItem.kind,
    state: workItem.state,
    headSha: subject.kind === "original_pr" ? subject.headSha : null,
    revisionKey: subject.revisionKey,
  };
  const execute = vi.fn<InvestigationActionTransport["execute"]>(async () => ({
    state: "succeeded",
    message: "Synthetic receipt",
    externalId: "synthetic-receipt",
  }));
  const reconcile = vi.fn<InvestigationActionTransport["reconcile"]>(async () => ({
    state: "unknown",
    message: "Synthetic receipt unavailable",
    externalId: null,
  }));
  const validateSuggestions = vi.fn<
    NonNullable<InvestigationActionTransport["validateSuggestions"]>
  >(async () => {});
  const transport: InvestigationActionTransport = {
    supportedActions: capabilities,
    readTarget: async () => structuredClone(target),
    readCapabilities: async () => capabilities,
    validateSuggestions,
    execute,
    reconcile,
  };
  const createTask = vi.fn(
    async (
      principal: InvestigationOperatorPrincipal,
      request: InvestigationCreateTaskRequestV1,
    ): Promise<InvestigationTaskV1> => {
      const parentReport = request.parentReportRef
        ? store.get<typeof result>("reports", request.parentReportRef.id)
        : undefined;
      const selectedPlan = parentReport?.plans.find(
        (plan) =>
          request.planRef !== undefined &&
          plan.id === request.planRef.id &&
          plan.version === request.planRef.version &&
          plan.digest === request.planRef.digest,
      );
      const created: InvestigationTaskV1 = {
        ...task,
        id: "synthetic-follow-up",
        kind: request.kind,
        state: "queued",
        parentTaskId: task.id,
        parentReportRef: request.parentReportRef ?? null,
        planRef: request.planRef ?? null,
        subjectRef: selectedPlan?.subjectRef ?? task.subjectRef,
        subjects: parentReport?.context.subjects ?? task.subjects,
      };
      store.insert("tasks", created.id, created);
      store.insert("idempotency", `task:${principal.id}:${request.idempotencyKey}`, {
        digest: investigationContentDigest(request),
        entityId: created.id,
      });
      return created;
    },
  );
  let nextId = 0;
  const actions = new InvestigationActions({
    store,
    now: () => new Date("2026-09-15T04:00:00.000Z"),
    idFactory: () => `synthetic-intent-${++nextId}`,
    transport,
    enableExternalWrites: options.externalWrites ?? true,
    createTask,
    ...(options.validateTaskAction === undefined
      ? {}
      : { validateTaskAction: options.validateTaskAction }),
    ...(options.resolvePlanPrerequisites === undefined
      ? {}
      : { resolvePlanPrerequisites: options.resolvePlanPrerequisites }),
  });
  function request(
    action: InvestigationActionKind = "comment",
  ): InvestigationCreateActionIntentRequest {
    return {
      idempotencyKey: "synthetic-action-key",
      workItemId: workItem.id,
      action,
      subjectRef: subject.id,
      expectedRevisionKey: target.revisionKey,
      expectedHeadSha: target.headSha,
      reportRef: {
        id: result.report.id,
        version: result.report.version,
        digest: result.report.logicalContentDigest,
      },
      payload: {
        kind: "feedback",
        body: "Synthetic explicit feedback",
        findingIds: [],
        drafts: [],
      },
    };
  }
  return {
    actions,
    store,
    actor,
    target,
    result,
    task,
    workItem,
    request,
    execute,
    reconcile,
    validateSuggestions,
    createTask,
    transport,
  };
}

function planPrerequisites(
  h: ReturnType<typeof harness>,
  kinds: Array<
    "source" | "environment" | "authorization" | "information" | "decision" | "capability"
  >,
) {
  const plan = h.result.plans[0]!;
  plan.prerequisites = kinds.map((kind) => ({
    id: `synthetic-${kind}-prerequisite`,
    kind,
    description: `Synthetic ${kind} prerequisite`,
  }));
  const action = h.result.nextActions.find(
    (entry) => entry.action === "start-task" || entry.action === "reviews.verify",
  )!;
  action.prerequisiteRefs = plan.prerequisites.map((entry) => entry.id);
  h.store.put("plans", `${h.result.report.id}:${plan.id}`, plan);
  h.store.put("reports", h.result.report.id, h.result);
  return action;
}

function patchVerificationAction(h: ReturnType<typeof harness>) {
  const source = {
    id: "synthetic-patch-base",
    kind: "source_commit" as const,
    repositoryId: h.task.repository.id,
    workItemId: h.workItem.id,
    revisionKey: "7".repeat(64),
    commitSha: "8".repeat(40),
  };
  const patch = {
    id: "synthetic-verified-patch",
    kind: "local_patch" as const,
    repositoryId: source.repositoryId,
    workItemId: source.workItemId,
    revisionKey: "9".repeat(64),
    baseSubjectRef: source.id,
    baseSha: source.commitSha,
    patchDigest: "a".repeat(64),
    artifactRef: "synthetic-retained-patch",
  };
  h.result.context.subjects.push(source, patch);
  const artifact = {
    id: patch.artifactRef,
    taskId: h.task.id,
    attemptId: h.result.context.attempt.id,
    subjectRef: patch.id,
    kind: "patch" as const,
    name: "fix.patch",
    mediaType: "text/x-diff",
    digest: patch.patchDigest,
    byteLength: 42,
    availability: "available" as const,
  };
  h.result.artifacts.push(artifact);
  h.result.report.collections.artifacts = h.result.artifacts.length;
  const plan = h.result.plans[0]!;
  plan.kind = "verification";
  plan.subjectRef = patch.id;
  plan.prerequisites = [];
  const action = h.result.nextActions.find((entry) => entry.action === "start-task")!;
  action.subjectRef = patch.id;
  action.taskKind = "issue-verify";
  action.prerequisiteRefs = [];
  h.store.put("plans", `${h.result.report.id}:${plan.id}`, plan);
  h.store.put("reports", h.result.report.id, h.result);
  const request: InvestigationCreateActionIntentRequest = {
    ...h.request("start-task"),
    nextActionId: action.id,
    subjectRef: patch.id,
    payload: { kind: "task", taskKind: "issue-verify", planRef: action.planRef! },
  };
  return { action, source, patch, artifact, request };
}

function patchFixReportWithoutActions(h: ReturnType<typeof harness>) {
  const originalSubjectRef = h.result.assessment.subjectRef;
  const fixPlan = structuredClone(h.result.plans[0]!);
  const { source, patch, artifact } = patchVerificationAction(h);
  if (h.result.assessment.kind !== "bug") throw new Error("Expected a bug assessment.");
  h.result.context.task.kind = "issue-fix";
  h.result.context.task.subjectRef = source.id;
  h.result.context.task.parentTaskId = "synthetic-parent-investigation";
  h.result.context.parentReportRef = {
    id: "synthetic-parent-report",
    version: 1,
    digest: "b".repeat(64),
  };
  h.result.assessment.subjectRef = source.id;
  h.result.assessment.bugAssessment.status = "confirmed";
  h.result.assessment.reproduction.planRef = null;
  for (const evidence of h.result.verificationEvidence)
    if (evidence.subjectRef === originalSubjectRef) evidence.subjectRef = source.id;
  for (const entry of h.result.artifacts)
    if (entry.subjectRef === originalSubjectRef) entry.subjectRef = source.id;
  for (const unit of h.result.report.coverage.includedUnits)
    if (unit.subjectRef === originalSubjectRef) unit.subjectRef = source.id;
  for (const candidate of h.result.report.loop.candidates) {
    candidate.subjectRef = source.id;
    candidate.status = "confirmed";
  }
  for (const recheck of h.result.report.recheck.records) recheck.subjectRef = source.id;
  fixPlan.kind = "fix";
  fixPlan.subjectRef = source.id;
  fixPlan.prerequisites = [];
  fixPlan.sourceReportRef = { id: h.result.context.parentReportRef.id, version: 1 };
  fixPlan.digest = investigationContentDigest(investigationPlanDigestPayload(fixPlan));
  const fixPlanRef = { id: fixPlan.id, version: fixPlan.version, digest: fixPlan.digest };
  for (const finding of h.result.findings) {
    finding.subjectRef = source.id;
    finding.confirmation.status = "confirmed";
    finding.fixRecommendation.planRef = fixPlanRef;
    for (const location of finding.locations) location.subjectRef = source.id;
  }
  for (const check of h.result.validation.checks) {
    check.subjectRef = source.id;
    check.planRef = fixPlanRef;
  }
  const patchPlan = h.result.plans[0]!;
  patchPlan.id = "synthetic-generated-patch-verification";
  patchPlan.digest = investigationContentDigest(investigationPlanDigestPayload(patchPlan));
  h.result.plans = [fixPlan, patchPlan];
  h.result.report.collections.plans = h.result.plans.length;
  h.result.nextActions = [];
  h.result.report.collections.nextActions = 0;
  h.store.put("plans", `${h.result.report.id}:${fixPlan.id}`, fixPlan);
  h.store.put("plans", `${h.result.report.id}:${patchPlan.id}`, patchPlan);
  h.store.put("reports", h.result.report.id, h.result);
  return { source, patch, artifact, patchPlan };
}

function storeVerificationChild(
  h: ReturnType<typeof harness>,
  options: {
    id: string;
    createdAt: string;
    status: "passed" | "blocked";
    checkIds?: readonly string[];
  },
) {
  const report = structuredClone(h.result);
  const plan = report.plans[0]!;
  const planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  const parentReportRef = h.request().reportRef!;
  const attemptId = `${options.id}-attempt`;
  report.id = `${options.id}-report`;
  report.report.id = report.id;
  report.report.logicalContentDigest = investigationContentDigest(options);
  report.context.task = {
    id: options.id,
    kind: "pr-verify",
    parentTaskId: h.task.id,
    subjectRef: h.task.subjectRef,
  };
  report.context.attempt = { id: attemptId, number: 1 };
  report.context.adoptedAttemptIds = [attemptId];
  report.context.parentReportRef = parentReportRef;
  const complete =
    options.status === "passed" &&
    (options.checkIds === undefined || options.checkIds.length === report.validation.checks.length);
  report.outcome = complete ? "completed" : "blocked";
  report.report.delivery = complete ? "final" : "checkpoint";
  report.report.completeness = complete ? "complete" : "partial";
  report.nextActions = [];
  report.report.collections.nextActions = 0;
  report.validation.checks = report.validation.checks
    .filter((check) => options.checkIds === undefined || options.checkIds.includes(check.id))
    .map((check) => {
      const evidenceId = `${options.id}-${check.id}-observation`;
      report.verificationEvidence.push({
        id: evidenceId,
        subjectRef: check.subjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: `The synthetic execution check was ${options.status}.`,
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: options.id,
          attemptId,
          producer: "synthetic-verification-executor",
          recordedAt: options.createdAt,
        },
      });
      return {
        ...check,
        status: options.status,
        executor: "synthetic-verification-executor",
        authoritativeAttemptId: attemptId,
        evidenceRefs: [evidenceId],
      };
    });
  report.report.collections.verificationEvidence = report.verificationEvidence.length;
  const task: InvestigationTaskV1 = {
    ...structuredClone(h.task),
    id: options.id,
    kind: "pr-verify",
    parentTaskId: h.task.id,
    parentReportRef,
    planRef,
    state: report.outcome,
    executionPolicy: {
      ...h.task.executionPolicy,
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: h.actor.id,
    },
    latestReportRef: {
      id: report.report.id,
      version: report.report.version,
      digest: report.report.logicalContentDigest,
    },
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  };
  h.store.insert("tasks", task.id, task);
  h.store.insert("reports", report.report.id, report);
}

describe("investigation action preparation and confirmation", () => {
  it.each([
    { older: "blocked", newer: "passed", recommendation: "approve" },
    { older: "passed", newer: "blocked", recommendation: "reviews.verify" },
  ] as const)(
    "uses the newest verification task when an older $older report precedes a $newer report",
    async ({ older, newer, recommendation }) => {
      const h = harness();
      storeVerificationChild(h, {
        id: "older-verification",
        createdAt: "2026-09-15T02:10:00.000Z",
        status: older,
      });
      const prior = await h.actions.actionContext(h.actor, h.workItem.id, {
        reportId: h.result.report.id,
      });
      expect(prior.recommendation.action).toBe(older === "passed" ? "approve" : "reviews.verify");
      storeVerificationChild(h, {
        id: "newer-verification",
        createdAt: "2026-09-15T02:20:00.000Z",
        status: newer,
      });
      const savedReports = h.store.list("reports");
      const context = await h.actions.actionContext(h.actor, h.workItem.id, {
        reportId: h.result.report.id,
      });
      expect(context.reportRef).toEqual(h.request().reportRef);
      expect(context.recommendation.action).toBe(recommendation);
      expect(h.store.list("reports")).toEqual(savedReports);
      expect(h.store.get("reports", h.result.report.id)).toEqual(h.result);
    },
  );

  it("does not fill missing checks in the latest verification task from an older passing task", async () => {
    const h = harness();
    if (h.result.assessment.kind !== "pr") throw new Error("Expected a PR assessment.");
    const plan = h.result.plans[0]!;
    const firstCheck = h.result.validation.checks[0]!;
    plan.steps[0]!.checkIds.push("second-check");
    h.result.assessment.e2eAssessment.scenarioIds.push("second-scenario");
    h.result.validation.checks.push({
      ...firstCheck,
      id: "second-check",
      scenarioId: "second-scenario",
      description: "The second required scenario is checked.",
    });
    h.store.put("plans", `${h.result.report.id}:${plan.id}`, plan);
    h.store.put("reports", h.result.report.id, h.result);
    storeVerificationChild(h, {
      id: "older-complete-verification",
      createdAt: "2026-09-15T02:10:00.000Z",
      status: "passed",
    });
    expect(
      (await h.actions.actionContext(h.actor, h.workItem.id, { reportId: h.result.report.id }))
        .recommendation.action,
    ).toBe("approve");
    storeVerificationChild(h, {
      id: "newer-partial-verification",
      createdAt: "2026-09-15T02:20:00.000Z",
      status: "passed",
      checkIds: [firstCheck.id],
    });
    const savedReports = h.store.list("reports");
    const context = await h.actions.actionContext(h.actor, h.workItem.id, {
      reportId: h.result.report.id,
    });
    expect(context.recommendation.action).toBe("reviews.verify");
    expect(h.store.list("reports")).toEqual(savedReports);
    expect(h.store.get("reports", h.result.report.id)).toEqual(h.result);
  });

  it("keeps external actions visible but unavailable when writes are disabled", async () => {
    const h = harness({ externalWrites: false });
    const context = await h.actions.actionContext(h.actor, h.workItem.id);
    expect(context.fixedActions.find((action) => action.action === "comment")).toMatchObject({
      allowed: false,
    });
    expect(
      context.fixedActions.find((action) => action.action === "comment")?.guards,
    ).toContainEqual(
      expect.objectContaining({ code: "external_writes_enabled", satisfied: false }),
    );
    await expect(h.actions.createIntent(h.actor, h.request())).rejects.toMatchObject({
      code: "action_guard_failed",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("uses exact repository grants and prevents another actor from reading an intent", async () => {
    const h = harness();
    await expect(
      h.actions.actionContext({ ...h.actor, repositoryIds: ["*"] }, h.workItem.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    const intent = await h.actions.createIntent(h.actor, h.request());
    expect(() => h.actions.getIntent({ ...h.actor, id: "another-operator" }, intent.id)).toThrow();
  });

  it("uses every saved finding for approval even when feedback has no selection or report", async () => {
    const h = harness({ findingCount: 137 });
    h.result.findings[136]!.priority = "P0";
    h.store.put("reports", h.result.report.id, h.result);
    const request = { ...h.request("approve"), reportRef: null };
    const context = await h.actions.actionContext(h.actor, h.workItem.id);
    expect(context.hardContentBlockers.map((entry) => entry.findingId)).toContain(
      h.result.findings[136]!.id,
    );
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "action_guard_failed",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("returns the same intent for identical idempotency content and rejects a changed payload", async () => {
    const h = harness();
    const request = h.request();
    const first = await h.actions.createIntent(h.actor, request);
    expect(await h.actions.createIntent(h.actor, structuredClone(request))).toEqual(first);
    await expect(
      h.actions.createIntent(h.actor, {
        ...request,
        payload: { kind: "feedback", body: "Different text", findingIds: [], drafts: [] },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["prepared", "succeeded", "unknown"] as const)(
    "looks up a saved %s intent without current publication permissions or transport calls",
    async (state) => {
      const h = harness();
      const request = h.request();
      expect(h.actions.findIntentByIdempotencyKey(h.actor, request.idempotencyKey)).toBeNull();
      const prepared = await h.actions.createIntent(h.actor, request);
      let expected = prepared;
      if (state !== "prepared") {
        h.execute.mockResolvedValue({ state, message: "Synthetic receipt", externalId: null });
        expected = await h.actions.confirmIntent(h.actor, prepared.id, {
          version: prepared.version,
          payloadDigest: prepared.payloadDigest,
        });
      }
      const readTarget = vi.fn<InvestigationActionTransport["readTarget"]>();
      h.transport.readTarget = readTarget;
      h.execute.mockClear();
      const previousRecords = h.store.list("idempotency");
      expect(
        h.actions.findIntentByIdempotencyKey(
          { ...h.actor, permissions: [], actionCapabilities: [] },
          request.idempotencyKey,
        ),
      ).toEqual(expected);
      expect(h.actions.findIntentByIdempotencyKey(h.actor, "missing-key")).toBeNull();
      expect(h.store.list("idempotency")).toEqual(previousRecords);
      expect(h.store.list("actionIntents")).toEqual([expected]);
      expect(readTarget).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
    },
  );

  it("keeps idempotency lookup scoped to the owning actor and repository grants", async () => {
    const h = harness();
    const request = h.request();
    const prepared = await h.actions.createIntent(h.actor, request);
    expect(() =>
      h.actions.findIntentByIdempotencyKey(
        { ...h.actor, repositoryIds: [] },
        request.idempotencyKey,
      ),
    ).toThrow(InvestigationRequestError);
    const otherActor = { ...h.actor, id: "other-synthetic-operator" };
    expect(h.actions.findIntentByIdempotencyKey(otherActor, request.idempotencyKey)).toBeNull();
    h.store.insert(
      "idempotency",
      `action-request:${investigationContentDigest([otherActor.id, request.idempotencyKey])}`,
      { intentId: prepared.id, requestDigest: investigationContentDigest(request) },
    );
    expect(() => h.actions.findIntentByIdempotencyKey(otherActor, request.idempotencyKey)).toThrow(
      InvestigationRequestError,
    );
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("dispatches a concurrently confirmed intent at most once", async () => {
    const h = harness();
    const intent = await h.actions.createIntent(h.actor, h.request());
    const confirmation = { version: intent.version, payloadDigest: intent.payloadDigest };
    await Promise.allSettled([
      h.actions.confirmIntent(h.actor, intent.id, confirmation),
      h.actions.confirmIntent(h.actor, intent.id, confirmation),
    ]);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]).toHaveLength(4);
    expect(h.actions.getIntent(h.actor, intent.id).state).toBe("succeeded");
    expect((await h.actions.confirmIntent(h.actor, intent.id, confirmation)).state).toBe(
      "succeeded",
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("rechecks source identity and current authorization before dispatch", async () => {
    const h = harness();
    const intent = await h.actions.createIntent(h.actor, h.request("approve"));
    const confirmation = { version: intent.version, payloadDigest: intent.payloadDigest };
    await expect(
      h.actions.confirmIntent(
        { ...h.actor, permissions: ["action:prepare"] },
        intent.id,
        confirmation,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    h.target.headSha = "9".repeat(40);
    h.target.revisionKey = "8".repeat(64);
    await expect(h.actions.confirmIntent(h.actor, intent.id, confirmation)).rejects.toMatchObject({
      code: "target_revision_changed",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects edits to persisted intent content that were not part of the reviewed preview", async () => {
    const h = harness();
    const intent = await h.actions.createIntent(h.actor, h.request());
    h.store.put("actionIntents", intent.id, {
      ...intent,
      payload: { kind: "feedback", body: "Unreviewed edit", findingIds: [], drafts: [] },
    });
    await expect(
      h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).rejects.toMatchObject({ code: "intent_binding_invalid" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rechecks all persisted P0 findings atomically after asynchronous permission checks", async () => {
    const h = harness();
    const intent = await h.actions.createIntent(h.actor, h.request("approve"));
    h.transport.readTarget = async () => {
      const discovered = createInvestigationFixture("pr", { priority: "P0" });
      h.store.put("reports", discovered.result.report.id, discovered.result);
      return structuredClone(h.target);
    };
    await expect(
      h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).rejects.toMatchObject({ code: "current_p0_prohibits_approval" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["prepare", "confirm"] as const)(
    "rolls back %s when trusted authorization is revoked during asynchronous target checks",
    async (phase) => {
      const h = harness();
      const request = h.request();
      const prepared = phase === "confirm" ? await h.actions.createIntent(h.actor, request) : null;
      let authorized = true;
      h.transport.readTarget = async () => {
        await Promise.resolve();
        authorized = false;
        return structuredClone(h.target);
      };
      const assertAuthorized = vi.fn(() => {
        h.store.insert("idempotency", "synthetic-authorization-transaction", { checked: true });
        if (!authorized)
          throw new InvestigationRequestError(
            403,
            "synthetic_authorization_revoked",
            "The synthetic publication policy was revoked.",
          );
      });
      const pending =
        prepared === null
          ? h.actions.createIntent(h.actor, request, assertAuthorized)
          : h.actions.confirmIntent(
              h.actor,
              prepared.id,
              { version: prepared.version, payloadDigest: prepared.payloadDigest },
              assertAuthorized,
            );
      await expect(pending).rejects.toMatchObject({ code: "synthetic_authorization_revoked" });
      expect(assertAuthorized).toHaveBeenCalledTimes(1);
      expect(h.store.has("idempotency", "synthetic-authorization-transaction")).toBe(false);
      expect(h.store.list("actionIntents")).toEqual(prepared === null ? [] : [prepared]);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it("fails before calling the transport when authorization is revoked after confirmation", async () => {
    const h = harness();
    const prepared = await h.actions.createIntent(h.actor, h.request());
    const assertAuthorized = vi.fn((intent: InvestigationActionIntentV1) => {
      if (intent.state === "executing")
        throw new InvestigationRequestError(
          403,
          "synthetic_authorization_revoked",
          "The synthetic publication policy was revoked.",
        );
    });
    await expect(
      h.actions.confirmIntent(
        h.actor,
        prepared.id,
        { version: prepared.version, payloadDigest: prepared.payloadDigest },
        assertAuthorized,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      result: { message: "The synthetic publication policy was revoked." },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("treats an injected transport's final authorization refusal as an unsent failure", async () => {
    const h = harness();
    const prepared = await h.actions.createIntent(h.actor, h.request());
    let authorized = true;
    const send = vi.fn();
    h.execute.mockImplementation(
      async (_intent, _repository, _workItem, _actor, beforeDispatch) => {
        await Promise.resolve();
        authorized = false;
        beforeDispatch?.();
        send();
        return { state: "succeeded", message: "Synthetic receipt", externalId: "receipt" };
      },
    );
    await expect(
      h.actions.confirmIntent(
        h.actor,
        prepared.id,
        { version: prepared.version, payloadDigest: prepared.payloadDigest },
        () => {
          if (!authorized) throw new Error("Synthetic authorization was revoked.");
        },
      ),
    ).resolves.toMatchObject({
      state: "failed",
      result: { message: "The action is no longer authorized for dispatch." },
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "unknown"] as const)(
    "does not require renewed publication authorization to return or reconcile a %s receipt",
    async (state) => {
      const h = harness();
      let authorized = true;
      const assertAuthorized = vi.fn(() => {
        if (!authorized) throw new Error("Synthetic authorization was revoked.");
      });
      h.execute.mockImplementation(
        async (_intent, _repository, _workItem, _actor, beforeDispatch) => {
          await Promise.resolve();
          beforeDispatch?.();
          return { state, message: "Synthetic receipt", externalId: null };
        },
      );
      const request = h.request();
      const prepared = await h.actions.createIntent(h.actor, request, assertAuthorized);
      const confirmation = { version: prepared.version, payloadDigest: prepared.payloadDigest };
      const finished = await h.actions.confirmIntent(
        h.actor,
        prepared.id,
        confirmation,
        assertAuthorized,
      );
      expect(finished.state).toBe(state);
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.execute.mock.calls[0]).toHaveLength(5);
      expect(assertAuthorized).toHaveBeenCalledTimes(4);
      authorized = false;
      assertAuthorized.mockClear();
      expect(await h.actions.createIntent(h.actor, request, assertAuthorized)).toEqual(finished);
      expect(
        await h.actions.confirmIntent(h.actor, prepared.id, confirmation, assertAuthorized),
      ).toEqual(finished);
      h.reconcile.mockResolvedValue({
        state: "succeeded",
        message: "The synthetic comment receipt was found.",
        externalId: "receipt",
      });
      expect((await h.actions.reconcileIntent(h.actor, prepared.id)).state).toBe("succeeded");
      expect(h.reconcile).toHaveBeenCalledTimes(state === "unknown" ? 1 : 0);
      expect(assertAuthorized).not.toHaveBeenCalled();
      expect(h.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("retains unknown delivery and reconciles without resubmitting any mutation", async () => {
    const h = harness();
    h.execute.mockRejectedValue(new Error("Synthetic connection interruption after dispatch"));
    const intent = await h.actions.createIntent(h.actor, h.request());
    const confirmation = { version: intent.version, payloadDigest: intent.payloadDigest };
    expect((await h.actions.confirmIntent(h.actor, intent.id, confirmation)).state).toBe("unknown");
    expect((await h.actions.confirmIntent(h.actor, intent.id, confirmation)).state).toBe("unknown");
    await expect(
      h.actions.createIntent(h.actor, { ...h.request(), idempotencyKey: "another-write" }),
    ).rejects.toMatchObject({ code: "action_guard_failed" });
    expect((await h.actions.reconcileIntent(h.actor, intent.id)).state).toBe("unknown");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["succeeded", "failed", "unknown"] as const)(
    "returns and persists a strict %s reconciliation receipt through HTTP without redispatch",
    async (state) => {
      const h = harness();
      h.execute.mockResolvedValue({
        state: "unknown",
        message: "The dispatch response was lost.",
        externalId: null,
      });
      h.reconcile.mockResolvedValue({
        state,
        message: "Read-only synthetic receipt observation.",
        externalId: state === "succeeded" ? "receipt-found" : null,
      });
      const intent = await h.actions.createIntent(h.actor, h.request());
      const confirmation = { version: intent.version, payloadDigest: intent.payloadDigest };
      await h.actions.confirmIntent(h.actor, intent.id, confirmation);
      const app = buildInvestigationApp({
        store: h.store,
        actionTransport: h.transport,
        enableExternalWrites: true,
        authenticateOperator: (request) =>
          request.headers.authorization === "synthetic-operator" ? h.actor : null,
      });
      try {
        const reconciled = await app.inject({
          method: "POST",
          url: `/api/action-intents/${intent.id}/reconcile`,
          headers: { authorization: "synthetic-operator" },
          payload: {},
        });
        expect(reconciled.statusCode, reconciled.body).toBe(200);
        const body = reconciled.json<InvestigationActionIntentV1>();
        expect(Value.Check(InvestigationActionIntentV1Schema, body)).toBe(true);
        expect(body.state).toBe(state);
        expect(body.result).toEqual({
          message: "Read-only synthetic receipt observation.",
          externalId: state === "succeeded" ? "receipt-found" : null,
          taskId: null,
        });
        const read = await app.inject({
          method: "GET",
          url: `/api/action-intents/${intent.id}`,
          headers: { authorization: "synthetic-operator" },
        });
        expect(read.statusCode).toBe(200);
        expect(Value.Check(InvestigationActionIntentV1Schema, read.json())).toBe(true);
        expect(read.json()).toEqual(body);
        expect(h.store.get("actionIntents", intent.id)).toEqual(body);
        expect(await h.actions.confirmIntent(h.actor, intent.id, confirmation)).toEqual(body);
        expect(h.execute).toHaveBeenCalledTimes(1);
        expect(h.reconcile).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["succeeded", "failed", "unknown"] as const)(
    "reads only the exact legacy %s reconciliation shape without rewriting history or redispatching",
    async (state) => {
      const h = harness();
      h.execute.mockResolvedValue({
        state,
        message: "Original immutable observation.",
        externalId: state === "succeeded" ? "original-receipt" : null,
      });
      const request = h.request();
      const prepared = await h.actions.createIntent(h.actor, request);
      const confirmation = { version: prepared.version, payloadDigest: prepared.payloadDigest };
      const original = await h.actions.confirmIntent(h.actor, prepared.id, confirmation);
      const legacy = { ...original, result: { ...original.result!, state } };
      h.store.put("actionIntents", original.id, legacy);
      const historicalDigest = investigationContentDigest(legacy);
      const app = buildInvestigationApp({
        store: h.store,
        actionTransport: h.transport,
        enableExternalWrites: true,
        authenticateOperator: () => h.actor,
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/action-intents/${original.id}`,
        });
        expect(response.statusCode).toBe(200);
        expect(Value.Check(InvestigationActionIntentV1Schema, response.json())).toBe(true);
        expect(response.json()).toEqual(original);
        expect(h.actions.findIntentByIdempotencyKey(h.actor, request.idempotencyKey)).toEqual(
          original,
        );
        expect(await h.actions.confirmIntent(h.actor, original.id, confirmation)).toEqual(original);
        if (state !== "unknown")
          expect(await h.actions.reconcileIntent(h.actor, original.id)).toEqual(original);
        expect(investigationContentDigest(h.store.get("actionIntents", original.id))).toBe(
          historicalDigest,
        );
        expect(h.store.get("actionIntents", original.id)).toEqual(legacy);
        expect(h.execute).toHaveBeenCalledTimes(1);
        expect(h.reconcile).not.toHaveBeenCalled();
        expect(() =>
          h.actions.getIntent({ ...h.actor, id: "another-operator" }, original.id),
        ).toThrow(expect.objectContaining({ code: "action_intent_forbidden" }));
        expect(() => h.actions.getIntent({ ...h.actor, repositoryIds: [] }, original.id)).toThrow(
          expect.objectContaining({ code: "action_intent_forbidden" }),
        );
      } finally {
        await app.close();
      }
    },
  );

  it("projects a concurrently retained legacy terminal receipt on the finish compare-and-swap return", async () => {
    const h = harness();
    h.execute.mockResolvedValue({
      state: "unknown",
      message: "The dispatch response was lost.",
      externalId: null,
    });
    const prepared = await h.actions.createIntent(h.actor, h.request());
    const unknown = await h.actions.confirmIntent(h.actor, prepared.id, {
      version: prepared.version,
      payloadDigest: prepared.payloadDigest,
    });
    const terminal = {
      ...unknown,
      version: unknown.version + 1,
      state: "succeeded" as const,
      result: {
        message: "An earlier reconciler found the original receipt.",
        externalId: "original-receipt",
        taskId: null,
      },
    };
    const legacy = { ...terminal, result: { ...terminal.result, state: "succeeded" } };
    h.reconcile.mockImplementation(async () => {
      h.store.put("actionIntents", unknown.id, legacy);
      return { state: "unknown", message: "A later lookup was inconclusive.", externalId: null };
    });
    const reconciled = await h.actions.reconcileIntent(h.actor, unknown.id);
    expect(Value.Check(InvestigationActionIntentV1Schema, reconciled)).toBe(true);
    expect(reconciled).toEqual(terminal);
    expect(h.store.get("actionIntents", unknown.id)).toEqual(legacy);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([
    "additional result key",
    "additional key without legacy state",
    "additional intent key",
    "conflicting result state",
    "executing state",
    "internal task action",
    "external task reference",
    "missing result message",
    "invalid result field type",
  ])(
    "rejects %s instead of treating it as the exact legacy reconciliation bug",
    async (variant) => {
      const h = harness();
      const prepared = await h.actions.createIntent(h.actor, h.request());
      const original = await h.actions.confirmIntent(h.actor, prepared.id, {
        version: prepared.version,
        payloadDigest: prepared.payloadDigest,
      });
      const legacyResult = { ...original.result!, state: original.state };
      let invalid: unknown = { ...original, result: legacyResult };
      if (variant === "additional result key")
        invalid = { ...original, result: { ...legacyResult, unsupported: true } };
      if (variant === "additional key without legacy state")
        invalid = { ...original, result: { ...original.result!, unsupported: true } };
      if (variant === "additional intent key")
        invalid = { ...original, result: legacyResult, unsupported: true };
      if (variant === "conflicting result state")
        invalid = { ...original, result: { ...legacyResult, state: "failed" } };
      if (variant === "executing state")
        invalid = {
          ...original,
          state: "executing",
          result: { ...legacyResult, state: "executing" },
        };
      if (variant === "internal task action")
        invalid = { ...original, action: "start-task", result: legacyResult };
      if (variant === "external task reference")
        invalid = { ...original, result: { ...legacyResult, taskId: "unrelated-task" } };
      if (variant === "missing result message")
        invalid = {
          ...original,
          result: { state: original.state, externalId: null, taskId: null },
        };
      if (variant === "invalid result field type")
        invalid = { ...original, result: { ...legacyResult, externalId: 42 } };
      h.store.put("actionIntents", original.id, invalid);
      expect(() =>
        h.actions.getIntent({ ...h.actor, id: "another-operator" }, original.id),
      ).toThrow(expect.objectContaining({ code: "action_intent_forbidden" }));
      expect(() => h.actions.getIntent(h.actor, original.id)).toThrow(
        expect.objectContaining({ statusCode: 500, code: "invalid_saved_action_intent" }),
      );
      await expect(h.actions.reconcileIntent(h.actor, original.id)).rejects.toMatchObject({
        code: "invalid_saved_action_intent",
      });
      expect(h.store.get("actionIntents", original.id)).toEqual(invalid);
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.reconcile).not.toHaveBeenCalled();
    },
  );

  it("restricts feedback drafts to the exact selected findings", async () => {
    const h = harness({ findingCount: 2 });
    const [selected, unselected] = h.result.findings;
    const request = h.request("suggestion-comment");
    request.payload = {
      kind: "feedback",
      body: "",
      findingIds: [selected!.id],
      drafts: [selected!.feedbackDraft, unselected!.feedbackDraft],
    };
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "selected_feedback_incomplete",
    });
    request.payload.drafts = [
      {
        ...selected!.feedbackDraft,
        body: "Edited feedback",
        suggestion: { ...selected!.feedbackDraft.suggestion!, replacement: "Edited replacement" },
      },
    ];
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.action).toBe("suggestion-comment");
    expect(h.validateSuggestions).toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("combines selected findings with explicitly selected independent report drafts", async () => {
    const h = harness({ findingCount: 1 });
    const finding = h.result.findings[0]!;
    const independent = h.result.feedbackDrafts[0]!;
    h.result.feedbackDrafts.push({
      id: "unselected-independent-draft",
      body: "This draft was not selected.",
      suggestion: null,
    });
    h.store.put("reports", h.result.report.id, h.result);
    const request = h.request("suggestion-comment");
    request.payload = {
      kind: "feedback",
      body: "",
      findingIds: [finding.id],
      drafts: [finding.feedbackDraft, { ...independent, body: "Edited independent feedback" }],
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.payload).toEqual(request.payload);
    expect(
      intent.payload.kind === "feedback" && intent.payload.drafts.map((draft) => draft.id),
    ).toEqual([finding.feedbackDraft.id, independent.id]);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects independent drafts without their exact report binding", async () => {
    const h = harness();
    const request = h.request();
    request.payload = {
      kind: "feedback",
      body: "",
      findingIds: [],
      drafts: [h.result.feedbackDrafts[0]!],
    };
    await expect(
      h.actions.createIntent(h.actor, { ...request, reportRef: null }),
    ).rejects.toMatchObject({ code: "selected_feedback_incomplete" });
    request.payload.drafts = [
      { id: "another-report-draft", body: "Unbound feedback", suggestion: null },
    ];
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "selected_feedback_incomplete",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("verifies independent code suggestions against the same immutable source binding", async () => {
    const h = harness({ findingCount: 1 });
    const independent = {
      ...h.result.findings[0]!.feedbackDraft,
      id: "independent-code-suggestion",
    };
    h.result.feedbackDrafts.push(independent);
    h.store.put("reports", h.result.report.id, h.result);
    h.validateSuggestions.mockImplementation(async (_repository, _workItem, intent) => {
      if (
        intent.payload.kind === "feedback" &&
        intent.payload.drafts.some((draft) => draft.id === independent.id)
      ) {
        throw new Error("Synthetic source mismatch");
      }
    });
    const request = h.request("suggestion-comment");
    request.payload = { kind: "feedback", body: "", findingIds: [], drafts: [independent] };
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "suggestion_validation_failed",
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "prepares a native PR verification from its saved assessment plan and rechecks revision changes=%s",
    async (changeRevision) => {
      const h = harness({
        externalWrites: false,
        resolvePlanPrerequisites: (_repository, _workItem, _report, plan) =>
          plan.prerequisites.map((entry) => entry.id),
        validateTaskAction: async () => [
          { code: "task_execution_binding", satisfied: true, message: "Synthetic binding ready." },
        ],
      });
      h.result.nextActions = [];
      h.result.report.collections.nextActions = 0;
      h.store.put("reports", h.result.report.id, h.result);
      const original = structuredClone(h.result);
      const context = await h.actions.actionContext(h.actor, h.workItem.id);
      const action = context.nextActions.find((entry) => entry.action === "reviews.verify");
      expect(action).toMatchObject({ taskKind: "pr-verify", canPrepare: true });
      const request: InvestigationCreateActionIntentRequest = {
        ...h.request("reviews.verify"),
        nextActionId: action!.id,
        payload: { kind: "task", taskKind: "pr-verify", planRef: action!.planRef! },
      };
      const intent = await h.actions.createIntent(h.actor, request);
      if (changeRevision) {
        h.target.headSha = "9".repeat(40);
        h.target.revisionKey = "8".repeat(64);
        await expect(
          h.actions.confirmIntent(h.actor, intent.id, {
            version: intent.version,
            payloadDigest: intent.payloadDigest,
          }),
        ).rejects.toMatchObject({ code: "target_revision_changed" });
        expect(h.createTask).not.toHaveBeenCalled();
      } else {
        const confirmed = await h.actions.confirmIntent(h.actor, intent.id, {
          version: intent.version,
          payloadDigest: intent.payloadDigest,
        });
        expect(confirmed).toMatchObject({ state: "succeeded" });
        expect(h.createTask).toHaveBeenCalledWith(
          h.actor,
          expect.objectContaining({
            kind: "pr-verify",
            executionMode: "execute",
            parentReportRef: request.reportRef,
            planRef: action!.planRef,
          }),
        );
      }
      expect(h.store.get("reports", h.result.report.id)).toEqual(original);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it("requires a saved next action and exact plan binding for follow-up execution", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const action = h.result.nextActions.find((entry) => entry.action === "start-task")!;
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
    };
    await expect(
      h.actions.createIntent(h.actor, { ...request, nextActionId: "unsaved-action" }),
    ).rejects.toMatchObject({ code: "invalid_saved_action" });
    const intent = await h.actions.createIntent(h.actor, request);
    const result = await h.actions.confirmIntent(h.actor, intent.id, {
      version: intent.version,
      payloadDigest: intent.payloadDigest,
    });
    expect(result).toMatchObject({ state: "succeeded", result: { taskId: "synthetic-follow-up" } });
    expect(h.createTask).toHaveBeenCalledWith(
      h.actor,
      expect.objectContaining({
        executionMode: "execute",
        kind: "feature-implement",
        parentReportRef: request.reportRef,
        planRef: action.planRef,
      }),
    );
    expect(h.createTask.mock.calls[0]![1]).not.toHaveProperty("sourceCommit");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("forwards an explicitly reviewed source commit through the existing task creation path", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const action = h.result.nextActions.find((entry) => entry.action === "start-task")!;
    const sourceCommit = "7".repeat(40);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef!, sourceCommit },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.payloadDigest).toBe(investigationContentDigest(request.payload));
    const result = await h.actions.confirmIntent(h.actor, intent.id, {
      version: intent.version,
      payloadDigest: intent.payloadDigest,
    });
    expect(result.state).toBe("succeeded");
    expect(h.createTask).toHaveBeenCalledWith(h.actor, expect.objectContaining({ sourceCommit }));
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });

  it("allows a source preparation form while retaining unresolved execution guards", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const action = planPrerequisites(h, ["source", "environment"]);
    const context = await h.actions.actionContext(h.actor, h.workItem.id);
    expect(context.nextActions.find((entry) => entry.id === action.id)).toMatchObject({
      canPrepare: true,
      readyToExecute: false,
      allowed: false,
    });
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: {
        kind: "task",
        taskKind: action.taskKind!,
        planRef: action.planRef!,
        sourceCommit: "7".repeat(40),
      },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.state).toBe("prepared");
    expect(intent.guards.some((entry) => !entry.satisfied)).toBe(true);
    await expect(
      h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).rejects.toMatchObject({ code: "action_guard_failed" });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("only resolves preparable prerequisites through the trusted task validator", async () => {
    const sourceCommit = "7".repeat(40);
    const validateTaskAction = vi.fn<
      NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
    >(async (_actor, request) => [
      {
        code: "task_execution_binding",
        satisfied: request.sourceCommit === sourceCommit,
        message: "Synthetic trusted source and execution binding",
      },
    ]);
    const h = harness({ kind: "feature", externalWrites: false, validateTaskAction });
    const action = planPrerequisites(h, ["source", "environment"]);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef!, sourceCommit },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.guards.every((entry) => entry.satisfied)).toBe(true);
    expect(h.createTask).not.toHaveBeenCalled();
    expect(
      (
        await h.actions.confirmIntent(h.actor, intent.id, {
          version: intent.version,
          payloadDigest: intent.payloadDigest,
        })
      ).state,
    ).toBe("succeeded");
    expect(validateTaskAction).toHaveBeenCalledTimes(2);
    expect(validateTaskAction).toHaveBeenLastCalledWith(
      h.actor,
      expect.objectContaining({ sourceCommit, planRef: action.planRef }),
    );
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });

  it("revalidates readiness at confirmation instead of trusting the prepared guards", async () => {
    const validateTaskAction = vi.fn<
      NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
    >(async () => [
      {
        code: "task_execution_binding",
        satisfied: true,
        message: "Synthetic trusted binding is ready",
      },
    ]);
    const h = harness({ kind: "feature", externalWrites: false, validateTaskAction });
    const action = planPrerequisites(h, ["environment"]);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.guards.every((entry) => entry.satisfied)).toBe(true);
    validateTaskAction.mockResolvedValue([
      {
        code: "task_execution_binding",
        satisfied: false,
        message: "Synthetic execution environment is no longer available",
      },
    ]);
    await expect(
      h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).rejects.toMatchObject({ code: "action_guard_failed" });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it.each(["authorization", "information", "decision", "capability"] as const)(
    "does not defer a %s prerequisite to source preparation",
    async (kind) => {
      const validateTaskAction = vi.fn<
        NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
      >(async () => [
        {
          code: "task_execution_binding",
          satisfied: true,
          message: "Synthetic validator must not bypass a substantive prerequisite",
        },
      ]);
      const h = harness({ kind: "feature", externalWrites: false, validateTaskAction });
      const action = planPrerequisites(h, ["source", kind]);
      expect(
        (await h.actions.actionContext(h.actor, h.workItem.id)).nextActions.find(
          (entry) => entry.id === action.id,
        )?.canPrepare,
      ).toBe(false);
      const request: InvestigationCreateActionIntentRequest = {
        ...h.request("start-task"),
        nextActionId: action.id,
        payload: {
          kind: "task",
          taskKind: action.taskKind!,
          planRef: action.planRef!,
          sourceCommit: "7".repeat(40),
        },
      };
      await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
        code: "action_guard_failed",
      });
      expect(validateTaskAction).not.toHaveBeenCalled();
      expect(h.createTask).not.toHaveBeenCalled();
    },
  );

  it("does not treat an empty validator response as proof that execution is ready", async () => {
    const h = harness({
      kind: "feature",
      externalWrites: false,
      validateTaskAction: async () => [],
    });
    const action = planPrerequisites(h, ["source"]);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.guards).toContainEqual(
      expect.objectContaining({ code: "task_execution_binding", satisfied: false }),
    );
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("retains a frozen issue source without allowing a different commit to replace it", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const source = {
      id: "synthetic-frozen-source",
      kind: "source_commit" as const,
      repositoryId: h.task.repository.id,
      workItemId: h.workItem.id,
      revisionKey: "9".repeat(64),
      commitSha: "7".repeat(40),
    };
    h.result.context.subjects.push(source);
    const plan = h.result.plans[0]!;
    plan.subjectRef = source.id;
    const action = h.result.nextActions.find((entry) => entry.action === "start-task")!;
    action.subjectRef = source.id;
    h.store.put("plans", `${h.result.report.id}:${plan.id}`, plan);
    h.store.put("reports", h.result.report.id, h.result);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      subjectRef: source.id,
      payload: {
        kind: "task",
        taskKind: action.taskKind!,
        planRef: action.planRef!,
        sourceCommit: "8".repeat(40),
      },
    };
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "saved_source_commit_changed",
    });
    request.payload = {
      kind: "task",
      taskKind: action.taskKind!,
      planRef: action.planRef!,
      sourceCommit: source.commitSha,
    };
    expect((await h.actions.createIntent(h.actor, request)).state).toBe("prepared");
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("prepares and dispatches the saved patch verification without external writes", async () => {
    const h = harness({ kind: "bug", externalWrites: false });
    const { request } = patchVerificationAction(h);
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.state).toBe("prepared");
    expect(
      await h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).toMatchObject({ state: "succeeded", result: { taskId: "synthetic-follow-up" } });
    expect(h.createTask).toHaveBeenCalledWith(
      h.actor,
      expect.objectContaining({
        kind: "issue-verify",
        parentReportRef: request.reportRef,
        planRef: request.payload.kind === "task" ? request.payload.planRef : null,
        executionMode: "execute",
      }),
    );
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("dispatches native patch verification from a valid Issue fix report that omitted its next action", async () => {
    const h = harness({ kind: "bug", findingCount: 1, externalWrites: false });
    const { source, patch, patchPlan } = patchFixReportWithoutActions(h);
    expect(validateInvestigationResult(h.result)).toEqual({ valid: true, errors: [] });
    const context = await h.actions.actionContext(h.actor, h.workItem.id);
    const action = context.nextActions.find(
      (entry) => entry.taskKind === "issue-verify" && entry.subjectRef === patch.id,
    )!;
    expect(action).toBeDefined();
    expect(action.subjectRef).not.toBe(source.id);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      subjectRef: patch.id,
      payload: { kind: "task", taskKind: "issue-verify", planRef: action.planRef! },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    const completed = await h.actions.confirmIntent(h.actor, intent.id, {
      version: intent.version,
      payloadDigest: intent.payloadDigest,
    });
    expect(completed.state).toBe("succeeded");
    expect(h.store.get<InvestigationTaskV1>("tasks", completed.result!.taskId!)).toMatchObject({
      kind: "issue-verify",
      subjectRef: patch.id,
      planRef: { id: patchPlan.id, version: patchPlan.version, digest: patchPlan.digest },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["base revision", "artifact digest", "artifact availability", "artifact absent"])(
    "refuses patch verification with invalid %s",
    async (change) => {
      const h = harness({ kind: "bug", externalWrites: false });
      const { patch, request } = patchVerificationAction(h);
      if (change === "base revision") patch.baseSha = "b".repeat(40);
      const artifact = h.result.artifacts.find((entry) => entry.id === patch.artifactRef)!;
      if (change === "artifact digest") artifact.digest = "b".repeat(64);
      if (change === "artifact availability") artifact.availability = "missing";
      if (change === "artifact absent") {
        h.result.artifacts = h.result.artifacts.filter((entry) => entry.id !== patch.artifactRef);
        h.result.report.collections.artifacts = h.result.artifacts.length;
      }
      h.store.put("reports", h.result.report.id, h.result);
      await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
        code: "action_subject_stale",
      });
      expect(h.createTask).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it("does not let a source SHA override the patch selected by the saved plan", async () => {
    const h = harness({ kind: "bug", externalWrites: false });
    const { request, source } = patchVerificationAction(h);
    if (request.payload.kind !== "task") throw new Error("Expected a task payload.");
    request.payload.sourceCommit = source.commitSha;
    await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
      code: "saved_source_commit_changed",
    });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("clears preparation availability when the upstream target is unavailable", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const action = planPrerequisites(h, ["source"]);
    h.transport.readTarget = async () => {
      throw new Error("Synthetic upstream outage");
    };
    expect(
      (await h.actions.actionContext(h.actor, h.workItem.id)).nextActions.find(
        (entry) => entry.id === action.id,
      ),
    ).toMatchObject({ canPrepare: false, readyToExecute: false, allowed: false });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it("recovers a task receipt after an uncertain internal dispatch without creating it again", async () => {
    const h = harness({ kind: "feature", externalWrites: false });
    const action = h.result.nextActions.find((entry) => entry.action === "start-task")!;
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
    };
    const create = h.createTask.getMockImplementation()!;
    h.createTask.mockImplementation(async (actor, body) => {
      await create(actor, body);
      throw new Error("Synthetic interruption after task persistence");
    });
    const intent = await h.actions.createIntent(h.actor, request);
    expect(
      (
        await h.actions.confirmIntent(h.actor, intent.id, {
          version: intent.version,
          payloadDigest: intent.payloadDigest,
        })
      ).state,
    ).toBe("unknown");
    expect(await h.actions.reconcileIntent(h.actor, intent.id)).toMatchObject({
      state: "succeeded",
      result: { taskId: "synthetic-follow-up" },
    });
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });

  it.each(["authorization", "information", "decision"] as const)(
    "accepts trusted acknowledgement of a saved plan's %s prerequisite",
    async (kind) => {
      const resolvePlanPrerequisites = vi.fn<InvestigationPrerequisiteResolver>(
        async (_repository, _workItem, _report, plan) =>
          plan.prerequisites.map((entry) => entry.id),
      );
      const validateTaskAction = vi.fn<
        NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
      >(async () => [
        {
          code: "task_execution_binding",
          satisfied: true,
          message: "Synthetic trusted execution configuration is ready",
        },
      ]);
      const h = harness({
        kind: "feature",
        externalWrites: false,
        resolvePlanPrerequisites,
        validateTaskAction,
      });
      const action = planPrerequisites(h, [kind]);
      const context = await h.actions.actionContext(h.actor, h.workItem.id);
      expect(context.nextActions.find((entry) => entry.id === action.id)).toMatchObject({
        canPrepare: true,
      });
      expect(resolvePlanPrerequisites).toHaveBeenCalledWith(
        h.task.repository,
        h.workItem,
        h.result,
        h.result.plans[0],
        h.actor,
      );
      const request: InvestigationCreateActionIntentRequest = {
        ...h.request("start-task"),
        nextActionId: action.id,
        payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
      };
      const intent = await h.actions.createIntent(h.actor, request);
      expect(intent.guards.every((entry) => entry.satisfied)).toBe(true);
      expect(validateTaskAction).toHaveBeenCalledTimes(1);
      expect(h.createTask).not.toHaveBeenCalled();
    },
  );

  it.each(["unacknowledged", "resolver-error"] as const)(
    "keeps a substantive prerequisite unavailable when %s",
    async (mode) => {
      const resolvePlanPrerequisites = vi.fn<InvestigationPrerequisiteResolver>(async () => {
        if (mode === "resolver-error") throw new Error("Synthetic prerequisite lookup failure");
        return [];
      });
      const validateTaskAction = vi.fn<
        NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
      >(async () => [
        {
          code: "task_execution_binding",
          satisfied: true,
          message: "Synthetic task validation must not bypass an unacknowledged prerequisite",
        },
      ]);
      const h = harness({
        kind: "feature",
        externalWrites: false,
        resolvePlanPrerequisites,
        validateTaskAction,
      });
      const action = planPrerequisites(h, ["authorization"]);
      expect(
        (await h.actions.actionContext(h.actor, h.workItem.id)).nextActions.find(
          (entry) => entry.id === action.id,
        ),
      ).toMatchObject({ canPrepare: false, readyToExecute: false, allowed: false });
      const request: InvestigationCreateActionIntentRequest = {
        ...h.request("start-task"),
        nextActionId: action.id,
        payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
      };
      await expect(h.actions.createIntent(h.actor, request)).rejects.toMatchObject({
        code: "action_guard_failed",
      });
      expect(validateTaskAction).not.toHaveBeenCalled();
      expect(h.createTask).not.toHaveBeenCalled();
    },
  );

  it("does not share an acknowledged prerequisite ID across different saved plans", async () => {
    let acknowledgedPlanId = "";
    const resolvePlanPrerequisites = vi.fn<InvestigationPrerequisiteResolver>(
      async (_repository, _workItem, _report, plan) =>
        plan.id === acknowledgedPlanId ? plan.prerequisites.map((entry) => entry.id) : [],
    );
    const h = harness({ kind: "feature", externalWrites: false, resolvePlanPrerequisites });
    const actionA = planPrerequisites(h, ["authorization"]);
    const planA = h.result.plans[0]!;
    acknowledgedPlanId = planA.id;
    const planB = {
      ...structuredClone(planA),
      id: `${planA.id}-independent`,
      kind: "investigation" as const,
      digest: "6".repeat(64),
    };
    const actionB = {
      ...structuredClone(actionA),
      id: `${actionA.id}-independent`,
      taskKind: "issue-investigate" as const,
      planRef: { id: planB.id, version: planB.version, digest: planB.digest },
    };
    h.result.plans.push(planB);
    h.result.nextActions.push(actionB);
    h.result.report.collections.plans = h.result.plans.length;
    h.result.report.collections.nextActions = h.result.nextActions.length;
    h.store.insert("plans", `${h.result.report.id}:${planB.id}`, planB);
    h.store.put("reports", h.result.report.id, h.result);
    const context = await h.actions.actionContext(h.actor, h.workItem.id);
    expect(context.nextActions.find((entry) => entry.id === actionA.id)).toMatchObject({
      canPrepare: true,
      readyToExecute: true,
      allowed: true,
    });
    expect(context.nextActions.find((entry) => entry.id === actionB.id)).toMatchObject({
      canPrepare: false,
      readyToExecute: false,
      allowed: false,
    });
    expect(resolvePlanPrerequisites).toHaveBeenCalledWith(
      h.task.repository,
      h.workItem,
      h.result,
      planB,
      h.actor,
    );
  });

  it("rechecks trusted acknowledgement before confirming a prepared task", async () => {
    let acknowledged = true;
    const resolvePlanPrerequisites = vi.fn<InvestigationPrerequisiteResolver>(
      async (_repository, _workItem, _report, plan) =>
        acknowledged ? plan.prerequisites.map((entry) => entry.id) : [],
    );
    const validateTaskAction = vi.fn<
      NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
    >(async () => [
      {
        code: "task_execution_binding",
        satisfied: true,
        message: "Synthetic trusted execution configuration is ready",
      },
    ]);
    const h = harness({
      kind: "feature",
      externalWrites: false,
      resolvePlanPrerequisites,
      validateTaskAction,
    });
    const action = planPrerequisites(h, ["decision"]);
    const request: InvestigationCreateActionIntentRequest = {
      ...h.request("start-task"),
      nextActionId: action.id,
      payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
    };
    const intent = await h.actions.createIntent(h.actor, request);
    expect(intent.guards.every((entry) => entry.satisfied)).toBe(true);
    acknowledged = false;
    await expect(
      h.actions.confirmIntent(h.actor, intent.id, {
        version: intent.version,
        payloadDigest: intent.payloadDigest,
      }),
    ).rejects.toMatchObject({ code: "action_guard_failed" });
    expect(resolvePlanPrerequisites).toHaveBeenCalledTimes(2);
    expect(validateTaskAction).toHaveBeenCalledTimes(1);
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.actions.getIntent(h.actor, intent.id).state).toBe("prepared");
  });

  it("does not let acknowledged plan facts override the actor's execution permission", async () => {
    const resolvePlanPrerequisites: InvestigationPrerequisiteResolver = (
      _repository,
      _workItem,
      _report,
      plan,
    ) => plan.prerequisites.map((entry) => entry.id);
    const validateTaskAction = vi.fn<
      NonNullable<InvestigationActionsDependencies["validateTaskAction"]>
    >(async () => []);
    const h = harness({
      kind: "feature",
      externalWrites: false,
      resolvePlanPrerequisites,
      validateTaskAction,
    });
    const action = planPrerequisites(h, ["authorization"]);
    const actor = { ...h.actor, allowRepositoryExecution: false };
    expect(
      (await h.actions.actionContext(actor, h.workItem.id)).nextActions.find(
        (entry) => entry.id === action.id,
      ),
    ).toMatchObject({ canPrepare: false, readyToExecute: false, allowed: false });
    await expect(
      h.actions.createIntent(actor, {
        ...h.request("start-task"),
        nextActionId: action.id,
        payload: { kind: "task", taskKind: action.taskKind!, planRef: action.planRef! },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(validateTaskAction).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
  });
});
