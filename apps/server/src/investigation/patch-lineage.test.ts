import { createHash } from "node:crypto";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationArtifactV1,
  type InvestigationClaim,
  type InvestigationClaimResponse,
  type InvestigationCreateTaskRequestV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationPlanDraft,
  type InvestigationResultV1,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInvestigationReportSubmission,
  InvestigationReportBuildError,
} from "../../../worker/src/investigation/report-builder.js";
import { buildInvestigationApp } from "./app.js";
import { InvestigationRequestError } from "./errors.js";
import { assembleInvestigationReport } from "./report.js";
import { InvestigationStore } from "./store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "./types.js";
import { InvestigationWorkerControls } from "./worker-controls.js";

const recordedAt = "2026-09-15T02:01:00.000Z";
const resources: Array<{ app: FastifyInstance; store: InvestigationStore }> = [];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("External network access is forbidden in the synthetic lineage fixture.");
    }),
  );
});

afterEach(async () => {
  try {
    for (const { app, store } of resources.splice(0)) {
      await app.close();
      store.close();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function post(app: FastifyInstance, path: string, payload: unknown, token = "operator") {
  return app.inject({
    method: "POST",
    url: path,
    payload: JSON.stringify(payload),
    headers: { authorization: token, "content-type": "application/json" },
  });
}

function reportRef(result: InvestigationResultV1) {
  return {
    id: result.report.id,
    version: result.report.version,
    digest: result.report.logicalContentDigest,
  };
}

function sealCheckpoint(checkpoint: InvestigationLoopCheckpointV1): void {
  const { digest: _digest, ...content } = checkpoint;
  checkpoint.digest = investigationContentDigest(content);
}

/** All identities, artifacts, execution bindings, and reports remain isolated synthetic data. */
async function harness() {
  const { task: fixtureTask } = createInvestigationFixture("pr", { findingCount: 0 });
  const subject = fixtureTask.subjects.find((entry) => entry.id === fixtureTask.subjectRef);
  if (subject?.kind !== "original_pr") throw new Error("The synthetic PR subject is missing.");
  const item: InvestigationWorkItemRecord = {
    ...fixtureTask.workItem,
    repositoryId: fixtureTask.repository.id,
    body: "Synthetic patch lineage without upstream activity.",
    state: "open",
    subject,
    updatedAt: recordedAt,
  };
  const operator: InvestigationOperatorPrincipal = {
    id: "lineage-operator",
    displayName: "Synthetic lineage operator",
    repositoryIds: [fixtureTask.repository.id],
    permissions: ["repository:manage", "task:create"],
    actionCapabilities: [],
    allowRepositoryExecution: true,
  };
  const worker: InvestigationWorkerPrincipal = {
    id: "lineage-worker",
    repositoryIds: [fixtureTask.repository.id],
  };
  let sequence = 0;
  const store = new InvestigationStore();
  const workerControls = new InvestigationWorkerControls(store, () => new Date(recordedAt));
  workerControls.initialize([worker]);
  const app = buildInvestigationApp({
    store,
    workerControls,
    now: () => new Date(recordedAt),
    idFactory: () => `lineage-generated-${++sequence}`,
    enableExternalWrites: false,
    authenticateOperator: (request) =>
      request.headers.authorization === "operator" ? operator : null,
    authenticateWorker: (request) => (request.headers.authorization === "worker" ? worker : null),
    prepareTaskInput: async (task, workItem, plan) => {
      const primary = task.subjects.find((entry) => entry.id === task.subjectRef);
      if (primary === undefined) throw new Error("The frozen task subject is missing.");
      const operation = { kind: "ui" as const, adapterId: "synthetic-ui", scenarioId: "lineage" };
      return {
        inputSnapshot: {
          schemaVersion: "InvestigationInputSnapshotV1" as const,
          repositoryId: task.repository.id,
          workItemId: workItem.id,
          subjectRef: primary.id,
          subjectRevisionKey: primary.revisionKey,
          title: workItem.title,
          body: workItem.body,
          comments: [],
          source: null,
        },
        plan,
        execution:
          plan === null || task.planRef === null
            ? null
            : {
                planRef: task.planRef,
                subjectRef: primary.id,
                subjectRevisionKey: primary.revisionKey,
                executionPolicyDigest: investigationContentDigest(task.executionPolicy),
                authorizationRef: operator.id,
                satisfiedPrerequisiteRefs: [],
                steps: plan.steps.map((step) => ({
                  stepId: step.id,
                  operation,
                  digest: investigationContentDigest({ stepId: step.id, operation }),
                })),
              },
      };
    },
  });
  resources.push({ app, store });
  expect((await post(app, "/api/repositories", fixtureTask.repository)).statusCode).toBe(201);
  expect((await post(app, "/api/work-items", item)).statusCode).toBe(201);

  async function createAndClaim(
    request: Omit<InvestigationCreateTaskRequestV1, "workItemId">,
  ): Promise<InvestigationClaim> {
    const response = await post(app, "/api/tasks", { ...request, workItemId: item.id });
    expect(response.statusCode, response.body).toBe(201);
    const task = response.json<InvestigationTaskV1>();
    const claimed = await post(
      app,
      "/api/worker/claims",
      { supportedKinds: [task.kind] },
      "worker",
    );
    expect(claimed.statusCode, claimed.body).toBe(200);
    const claim = claimed.json<InvestigationClaimResponse>().claim;
    if (claim === null) throw new Error("Expected the isolated queued task to be claimed.");
    expect(claim.task.id).toBe(task.id);
    return claim;
  }

  async function upload(
    claim: InvestigationClaim,
    artifact: InvestigationArtifactV1,
    bytes: Buffer,
  ) {
    const response = await post(
      app,
      `/api/worker/tasks/${claim.task.id}/artifacts`,
      {
        lease: claim.lease,
        artifact,
        contentBase64: bytes.toString("base64"),
      },
      "worker",
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function saveReport(
    claim: InvestigationClaim,
    options: {
      artifacts?: InvestigationArtifactV1[];
      subjects?: InvestigationSubjectV1[];
      plans?: InvestigationPlanDraft[];
    } = {},
  ) {
    if (claim.checkpoint === null) throw new Error("The claimed checkpoint is missing.");
    const checkpoint = structuredClone(claim.checkpoint);
    checkpoint.stopReason = "blocked";
    checkpoint.analysis.summary =
      "Synthetic lineage is preserved while source work remains pending.";
    checkpoint.analysis.plans = options.plans ?? [];
    checkpoint.runtime.artifacts = options.artifacts ?? [];
    checkpoint.runtime.subjects = options.subjects ?? [];
    sealCheckpoint(checkpoint);
    const submission = buildInvestigationReportSubmission({
      task: claim.task,
      attempt: claim.attempt,
      checkpoint,
      reportId: claim.reportId,
      outcome: "blocked",
      parentPlan: claim.plan,
    });
    const input = {
      task: claim.task,
      attempt: claim.attempt,
      checkpoint,
      parentPlan: claim.plan,
      ...submission,
    };
    const result = assembleInvestigationReport(input);
    const validation = validateInvestigationResult(result);
    expect(validation.errors).toEqual([]);
    // Supply the isolated synthetic checkpoint, then follow the production terminal lifecycle.
    // Writing only Task/Report records would leave its Attempt and resource lease running.
    store.put("checkpoints", claim.task.id, checkpoint);
    for (const part of submission.parts) {
      const uploaded = await post(
        app,
        `/api/worker/tasks/${claim.task.id}/report-parts`,
        { lease: claim.lease, part },
        "worker",
      );
      expect(uploaded.statusCode, uploaded.body).toBe(200);
    }
    const finalized = await post(
      app,
      `/api/worker/tasks/${claim.task.id}/finalize`,
      { lease: claim.lease, header: submission.header, manifest: submission.manifest },
      "worker",
    );
    expect(finalized.statusCode, finalized.body).toBe(200);
    expect(finalized.json()).toEqual({ reportRef: reportRef(result) });
    const cleanup = await post(
      app,
      `/api/worker/tasks/${claim.task.id}/cleanup`,
      { lease: claim.lease, ownedProcessesStopped: true, desktopRestored: true },
      "worker",
    );
    expect(cleanup.statusCode, cleanup.body).toBe(200);
    expect(cleanup.json()).toEqual({ released: true, attemptId: claim.attempt.id });
    return { result, input };
  }

  return {
    app,
    store,
    item,
    subject,
    createAndClaim,
    upload,
    saveReport,
    enableE2e: () =>
      workerControls.update(
        { ...operator, id: "lineage-administrator", isAdmin: true },
        worker.id,
        { version: 1, e2eEnabled: true },
        () => {},
      ),
  };
}

async function lineage() {
  const fixture = await harness();
  const review = await fixture.createAndClaim({
    kind: "pr-review",
    idempotencyKey: "root-review",
    executionMode: "source_read",
  });
  expect(review.task.executionPolicy).toMatchObject({
    mode: "source_read",
    allowRepositoryExecution: false,
    authorizationRef: null,
  });
  const originPlan: InvestigationPlanDraft = {
    id: "lineage-origin-verification-plan",
    version: 1,
    kind: "verification",
    subjectRef: fixture.subject.id,
    title: "Prepare synthetic patch variants for verification",
    rationale: "Verify inherited source bindings using isolated patch artifacts.",
    prerequisites: [],
    steps: [
      {
        id: "lineage-origin-verification-step",
        description: "Prepare and inspect two synthetic patch variants of the frozen PR source.",
        expectedObservation: "Each patch retains its exact source and originating attempt.",
        checkIds: [],
      },
    ],
    acceptanceCriteria: ["Patch metadata preserves the frozen base and exact content digest."],
  };
  const reviewReport = await fixture.saveReport(review, { plans: [originPlan] });
  const savedOriginPlan = reviewReport.result.plans[0]!;
  fixture.enableE2e();
  const origin = await fixture.createAndClaim({
    kind: "pr-verify",
    idempotencyKey: "origin",
    executionMode: "execute",
    parentReportRef: reportRef(reviewReport.result),
    planRef: {
      id: savedOriginPlan.id,
      version: savedOriginPlan.version,
      digest: savedOriginPlan.digest,
    },
  });
  expect(origin.task.executionPolicy).toMatchObject({
    mode: "execute",
    allowRepositoryExecution: true,
    authorizationRef: "lineage-operator",
  });
  const patches = ["selected", "unrelated"].map((name) => {
    const bytes = Buffer.from(`Synthetic ${name} patch bytes.\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const subject: InvestigationSubjectV1 = {
      id: `lineage-subject-${name}`,
      kind: "local_patch",
      repositoryId: origin.task.repository.id,
      workItemId: origin.task.workItem.id,
      revisionKey: investigationContentDigest({ base: fixture.subject.headSha, digest }),
      baseSubjectRef: fixture.subject.id,
      baseSha: fixture.subject.headSha,
      patchDigest: digest,
      artifactRef: `lineage-patch-${name}`,
    };
    const artifact: InvestigationArtifactV1 = {
      id: subject.artifactRef,
      taskId: origin.task.id,
      attemptId: origin.attempt.id,
      subjectRef: subject.id,
      kind: "patch",
      name: `${name}.patch`,
      mediaType: "text/x-diff",
      digest,
      byteLength: bytes.byteLength,
      availability: "available",
    };
    return { artifact, subject, bytes };
  });
  const selected = patches[0]!;
  const unrelated = patches[1]!;
  const logBytes = Buffer.from("Synthetic originating task log.\n");
  const log: InvestigationArtifactV1 = {
    id: "lineage-origin-log",
    taskId: origin.task.id,
    attemptId: origin.attempt.id,
    subjectRef: fixture.subject.id,
    kind: "log",
    name: "origin.log",
    mediaType: "text/plain",
    digest: createHash("sha256").update(logBytes).digest("hex"),
    byteLength: logBytes.byteLength,
    availability: "available",
  };
  for (const patch of patches) await fixture.upload(origin, patch.artifact, patch.bytes);
  await fixture.upload(origin, log, logBytes);
  const originReport = await fixture.saveReport(origin, {
    subjects: patches.map((patch) => patch.subject),
    artifacts: [...patches.map((patch) => patch.artifact), log],
  });
  const child = await fixture.createAndClaim({
    kind: "pr-review",
    idempotencyKey: "child",
    parentReportRef: reportRef(originReport.result),
  });
  const directParentRead = await post(
    fixture.app,
    `/api/worker/tasks/${child.task.id}/artifact-content`,
    { lease: child.lease, artifactId: log.id },
    "worker",
  );
  const plan: InvestigationPlanDraft = {
    id: "lineage-selected-patch-plan",
    version: 1,
    kind: "verification",
    subjectRef: selected.subject.id,
    title: "Verify the selected synthetic patch",
    rationale: "Bind the follow-up to one exact inherited patch.",
    prerequisites: [],
    steps: [
      {
        id: "lineage-verification-step",
        description: "Observe the selected synthetic patch.",
        expectedObservation: "The frozen source metadata remains unchanged.",
        checkIds: [],
      },
    ],
    acceptanceCriteria: ["Only the selected patch can be read through the inherited lineage."],
  };
  const childReport = await fixture.saveReport(child, { plans: [plan] });
  const savedPlan = childReport.result.plans[0]!;
  const grandchild = await fixture.createAndClaim({
    kind: "pr-verify",
    idempotencyKey: "grandchild",
    parentReportRef: reportRef(childReport.result),
    planRef: { id: savedPlan.id, version: savedPlan.version, digest: savedPlan.digest },
  });
  const read = (claim: InvestigationClaim, artifactId: string) =>
    post(
      fixture.app,
      `/api/worker/tasks/${claim.task.id}/artifact-content`,
      { lease: claim.lease, artifactId },
      "worker",
    );
  return {
    ...fixture,
    origin,
    child,
    childReport,
    grandchild,
    selected,
    unrelated,
    log,
    logBytes,
    directParentRead,
    read,
  };
}

describe("inherited patch artifact lineage", () => {
  it("builds original-source follow-up reports and reads only the authorized ancestral patch", async () => {
    const fixture = await lineage();
    const { origin, child, childReport, grandchild, selected, unrelated, log, read } = fixture;
    expect(child.task.subjectRef).toBe(fixture.subject.id);
    expect(child.task.sourceArtifacts).toEqual([selected.artifact, unrelated.artifact]);
    expect(childReport.result.context.sourceArtifacts).toEqual(child.task.sourceArtifacts);
    expect(childReport.result.artifacts).toEqual([]);
    expect(childReport.result.report.collections.artifacts).toBe(0);
    expect(grandchild.task.sourceArtifacts).toEqual(child.task.sourceArtifacts);
    expect(grandchild.task.subjectRef).toBe(selected.subject.id);
    expect(grandchild.task.executionPolicy.allowedSubjectRefs).toEqual([selected.subject.id]);

    const inherited = await read(grandchild, selected.artifact.id);
    expect(inherited.statusCode, inherited.body).toBe(200);
    expect(inherited.json()).toEqual({
      artifact: { ...selected.artifact, taskId: origin.task.id, attemptId: origin.attempt.id },
      contentBase64: selected.bytes.toString("base64"),
    });
    for (const artifactId of [unrelated.artifact.id, log.id]) {
      const denied = await read(grandchild, artifactId);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "artifact_scope_mismatch" });
    }

    const directParent = fixture.directParentRead;
    expect(directParent.statusCode, directParent.body).toBe(200);
    expect(directParent.json()).toEqual({
      artifact: log,
      contentBase64: fixture.logBytes.toString("base64"),
    });
    expect(fixture.store.list("evidenceAssets")).toHaveLength(3);
  });

  it("rejects inherited reads after tampering with the exact parent, frozen metadata, or patch binding", async () => {
    const { store, grandchild, childReport, selected, read } = await lineage();
    const originalTask = structuredClone(grandchild.task);
    const originalReport = structuredClone(childReport.result);
    const mutations: Array<(task: InvestigationTaskV1, report: InvestigationResultV1) => void> = [
      (task) => {
        task.parentReportRef!.digest = "0".repeat(64);
      },
      (task) => {
        task.parentReportRef!.version += 1;
      },
      (task) => {
        task.sourceArtifacts = [];
      },
      (task) => {
        task.sourceArtifacts![0]!.name = "changed-frozen-name.patch";
      },
      (_task, report) => {
        report.context.sourceArtifacts![0]!.name = "changed-parent-name.patch";
      },
      (_task, report) => {
        report.context.sourceArtifacts = [];
      },
      (task) => {
        const subject = task.subjects.find((entry) => entry.id === selected.subject.id);
        if (subject?.kind !== "local_patch") throw new Error("The selected patch is missing.");
        subject.patchDigest = "0".repeat(64);
      },
      (task) => {
        const original = task.subjects.find((entry) => entry.kind === "original_pr")!;
        task.subjectRef = original.id;
        task.executionPolicy.allowedSubjectRefs = [original.id];
      },
    ];
    for (const mutate of mutations) {
      const task = structuredClone(originalTask);
      const report = structuredClone(originalReport);
      mutate(task, report);
      store.put("tasks", task.id, task);
      store.put("reports", report.id, report);
      const denied = await read(grandchild, selected.artifact.id);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toMatchObject({ code: "artifact_scope_mismatch" });
    }
    store.put("tasks", originalTask.id, originalTask);
    store.put("reports", originalReport.id, originalReport);
    expect((await read(grandchild, selected.artifact.id)).statusCode).toBe(200);
  });

  it("requires exact frozen report metadata and rejects re-owning an inherited artifact", async () => {
    const { childReport, selected } = await lineage();
    for (const mutation of ["omit", "rename", "reown"] as const) {
      const input = structuredClone(childReport.input);
      if (mutation === "omit") delete input.header.context.sourceArtifacts;
      else if (mutation === "rename")
        input.header.context.sourceArtifacts![0]!.name = "forged.patch";
      else input.header.context.sourceArtifacts![0]!.taskId = input.task.id;
      try {
        assembleInvestigationReport(input);
        throw new Error("Expected frozen report context tampering to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(InvestigationRequestError);
        expect((error as InvestigationRequestError).code).toBe("report_context_mismatch");
      }
    }

    const input = structuredClone(childReport.input);
    input.checkpoint.runtime.artifacts = [
      {
        ...selected.artifact,
        taskId: input.task.id,
        attemptId: input.attempt.id,
      },
    ];
    sealCheckpoint(input.checkpoint);
    try {
      buildInvestigationReportSubmission({
        task: input.task,
        attempt: input.attempt,
        checkpoint: input.checkpoint,
        reportId: "lineage-forged-owner-report",
        outcome: "blocked",
      });
      throw new Error("Expected inherited artifact ownership forgery to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationReportBuildError);
      expect((error as InvestigationReportBuildError).code).toBe("INVALID_RUNTIME_ARTIFACT");
    }
  });
});
