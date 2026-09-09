import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "../../dist/routes/auth.js";
import { registerEvaluationAssessmentRoutes } from "../../dist/routes/evaluation-assessments.js";
import {
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
} from "./evidence-control-plane.testing.js";

const administrator: C.OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "assessment-runtime-administrator",
};
const member: C.OperatorPrincipal = {
  issuer: administrator.issuer,
  subject: "assessment-runtime-reviewer",
};
const origin = "https://assessment-runtime.example.test";
const token = "S".repeat(43);
const fixtures: EvidenceControlPlaneFixture[] = [];
const apps: FastifyInstance[] = [];

async function closeHttpApps(): Promise<void> {
  const results = await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Assessment HTTP cleanup failed.",
    );
}
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    await closeHttpApps();
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.dispose()));
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "Assessment runtime cleanup failed.");
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The assessment runtime fixture is incomplete.");
  return value;
}

async function httpApp(
  fixture: EvidenceControlPlaneFixture,
  readOnly: boolean,
): Promise<FastifyInstance> {
  const createdAt = new Date().toISOString();
  const session = {
    ...member,
    displayName: "Assessment runtime reviewer",
    email: null,
    createdAt,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  // Authentication is a local fixture. Every permission, preview, publication, and replay below
  // still crosses the real actor-bound DatabaseClient and persistence owner.
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: () => undefined,
    startLogin: async () => ({ kind: "session" as const, sessionToken: token, session }),
    completeLogin: async () => {
      throw new Error("No external login in assessment runtime tests.");
    },
    getSession: async (value) => (value === token ? session : null),
    logout: async () => undefined,
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerEvaluationAssessmentRoutes(app, {
    database: fixture.client,
    operatorAuth: auth,
    readOnly,
  });
  await app.ready();
  return app;
}
const httpHeaders = () => ({
  host: "assessment-runtime.example.test",
  origin,
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
});

function expectIncompletePreview(value: C.EvaluationScorePreviewV1, version: number): void {
  expect(C.getEvaluationScorePreviewIssues(value)).toEqual([]);
  expect(value.assessmentVersion).toBe(version);
  for (const arm of ["baseline", "candidate"] as const) {
    expect(value.summary[arm].coverage).toMatchObject({
      applicableCases: 1,
      completedCases: 0,
      blockedCases: 0,
      notRunCases: 1,
      availableModels: 0,
    });
    expect(value.summary[arm].quality.truePositives).toBe(0);
    expect(value.summary[arm].quality.precision.value).toBeNull();
    expect(value.summary[arm].quality.recall.value).toBeNull();
  }
}

describe.skipIf(process.platform !== "linux")(
  "evaluation assessment publication through the real owner",
  () => {
    it("publishes pending CLI execution coverage and preserves permissions and original receipts through recovery", async () => {
      let recovery = false;
      const fixture = await createEvidenceControlPlaneFixture(1, [administrator], {
        createClient: (options) =>
          DatabaseClient.create({ ...options, recoveryMaintenance: recovery }),
      });
      fixtures.push(fixture);
      const repositoryId = fixture.run.repositoryId;
      const operator = () => bindOperatorDatabase(fixture.client, member);
      const admin = () => bindOperatorDatabase(fixture.client, administrator);
      let grantVersion = 0;
      const grant = async (role: C.OperatorRepositoryRole | null) => {
        const expectedVersion = grantVersion;
        await admin().request("changeRepositoryAccess", {
          repositoryId,
          actor: administrator,
          request: {
            changeId: `assessment-runtime-grant-${expectedVersion + 1}`,
            expectedVersion,
            principal: member,
            role,
            reason: "Exercise actual report publication permissions and receipt replay.",
          },
        });
        grantVersion += 1;
      };
      await grant("maintainer");
      expect(
        await operator().request("operatorCheckPermission", {
          repositoryId,
          permission: "configure",
        }),
      ).toEqual({ authorized: true });

      const planned = required(fixture.run.plan.jobs[0]);
      const profile = required(planned.profileVersion);
      const prompt = required(planned.prompt);
      const compile = required(profile.config.build[0]);
      expect(fixture.run.plan.workItem.kind).toBe("pull_request");
      expect(profile.workflowKind).toBe("pr_static_build");
      const captured = await operator().request("captureEvaluationSource", {
        repositoryId,
        actor: member,
        request: {
          changeId: "assessment-runtime-capture",
          source: {
            kind: "current_work_item",
            workItemId: fixture.run.workItemId,
            expectedRevisionKey: fixture.run.revisionKey,
            testedIssueCommit: null,
          },
        },
      });
      const suite = await operator().request("createEvaluationSuite", {
        repositoryId,
        actor: member,
        request: {
          changeId: "assessment-runtime-suite",
          name: "Required model coverage gaps",
          description: "A real frozen source whose required CLI review has not executed.",
          workflowKind: "pr_static_build",
          target: "headless",
        },
      });
      const caseTitle = "The required model has not executed";
      const draft: C.EvaluationSuiteDraft = {
        name: suite.name,
        description: suite.description,
        cases: [
          {
            caseId: "case-required-model",
            title: caseTitle,
            sourceId: captured.id,
            applicability: { state: "applicable" },
            criteria: [
              {
                criterionId: "criterion-build",
                description: "The frozen source should compile.",
                applicability: { state: "applicable" },
                expectedOutcome: "passed",
              },
            ],
            findings: {
              annotation: "complete",
              expected: [
                {
                  expectedFindingId: "expected-regression",
                  description:
                    "The expected regression requires an actual model finding and human adjudication.",
                },
              ],
            },
          },
        ],
      };
      const saved = await operator().request("saveEvaluationSuiteDraft", {
        repositoryId,
        actor: member,
        suiteId: suite.id,
        request: {
          changeId: "assessment-runtime-draft",
          expectedRevision: suite.draftRevision,
          draft,
        },
      });
      const published = await operator().request("publishEvaluationSuite", {
        repositoryId,
        actor: member,
        suiteId: suite.id,
        request: {
          changeId: "assessment-runtime-suite-publish",
          expectedRevision: saved.draftRevision,
        },
      });
      const configuration = { profileVersionId: profile.id, promptVersionId: prompt.version.id };
      const batch = await operator().request("createEvaluationBatch", {
        repositoryId,
        actor: member,
        request: {
          changeId: "assessment-runtime-batch",
          suiteId: suite.id,
          suiteVersionId: published.id,
          mode: "prompt_and_profile",
          baseline: configuration,
          candidate: { ...configuration },
          checkMappings: [
            {
              caseId: "case-required-model",
              criterionId: "criterion-build",
              baselineCheckId: `${profile.id}:${compile.id}`,
              candidateCheckId: `${profile.id}:${compile.id}`,
            },
          ],
        },
      });
      const scope = { repositoryId, evaluationId: batch.id, actor: member };
      const detail = await operator().request("getEvaluationBatch", scope);
      for (const arm of ["baseline", "candidate"] as const)
        expect(detail.configurations[arm].modelRequirements).toEqual({
          required: true,
        });
      const matrix = await operator().request("getEvaluationBatchMatrix", scope);
      expect(C.getEvaluationBatchMatrixIssues(matrix)).toEqual([]);
      expect(matrix.status).toBe("pending");
      expect(matrix.progress).toMatchObject({
        totalCells: 2,
        applicableCells: 2,
        blocked: 0,
        not_run: 2,
        completed: 0,
        running: 0,
        queued: 0,
      });
      for (const entry of matrix.cases)
        for (const arm of ["baseline", "candidate"] as const)
          expect(entry[arm]).toMatchObject({ state: "not_run", job: null, result: null });

      // No claim, CLI execution, completion, or upstream action is performed. These reports
      // intentionally preserve the real pending model and execution coverage gaps above.
      const firstPreview = await operator().request("getEvaluationScorePreview", scope);
      expectIncompletePreview(firstPreview, 0);
      const firstRequest: C.EvaluationAssessmentPublishRequest = {
        changeId: "assessment-runtime-report-1",
        expectedVersion: 0,
        expectedInputDigest: firstPreview.inputDigest,
      };
      const first = await operator().request("publishEvaluationAssessment", {
        ...scope,
        request: firstRequest,
      });
      expect(C.getEvaluationAssessmentPublishResponseIssues(first)).toEqual([]);
      expect(first).toMatchObject({
        repositoryId,
        evaluationId: batch.id,
        version: 1,
        scorerVersion: "explicit-matching-v2",
        createdBy: member,
      });

      await grant("reviewer");
      await expect(
        operator().request("operatorCheckPermission", { repositoryId, permission: "configure" }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      expect(
        await operator().request("operatorCheckPermission", { repositoryId, permission: "review" }),
      ).toEqual({ authorized: true });
      const secondPreview = await operator().request("getEvaluationScorePreview", scope);
      expectIncompletePreview(secondPreview, 1);
      const secondRequest: C.EvaluationAssessmentPublishRequest = {
        changeId: "assessment-runtime-report-2",
        expectedVersion: 1,
        expectedInputDigest: secondPreview.inputDigest,
      };
      const second = await operator().request("publishEvaluationAssessment", {
        ...scope,
        request: secondRequest,
      });
      expect(second.version).toBe(2);
      expect(second.assessmentId).not.toBe(first.assessmentId);
      expect(second.scoringPlanDigest).toBe(first.scoringPlanDigest);
      expect(second.createdBy).toEqual(member);
      expect(
        await operator().request("publishEvaluationAssessment", {
          ...scope,
          request: firstRequest,
        }),
      ).toEqual(first);

      const readFirst = { ...scope, assessmentId: first.assessmentId };
      expect(await operator().request("getEvaluationAssessment", readFirst)).toEqual(first);
      const selectedCase = await operator().request("getEvaluationAssessmentCase", {
        ...readFirst,
        caseId: "case-required-model",
      });
      expect(C.getEvaluationAssessmentCaseIssues(selectedCase)).toEqual([]);
      expect(selectedCase.caseTitle).toBe(caseTitle);
      expect(selectedCase.reportDigest).toBe(first.reportDigest);
      expect(selectedCase.expectation).toMatchObject({
        caseId: "case-required-model",
        sourceDigest: captured.sourceDigest,
        findings: draft.cases[0]?.findings,
      });
      for (const arm of ["baseline", "candidate"] as const) {
        expect(selectedCase.case[arm].executionState).toBe("not_run");
        expect(selectedCase.case[arm].result).toBeNull();
        expect(selectedCase.case[arm].findings.modelAvailable).toBe(false);
      }
      const history = await operator().request("listEvaluationAssessments", {
        ...scope,
        query: { page: 1, pageSize: 20 },
      });
      expect(C.getEvaluationAssessmentListIssues(history)).toEqual([]);
      expect(history.total).toBe(2);
      expect(history.items).toEqual([second, first]);
      expect(
        (
          await operator().request("listEvaluationAssessments", {
            ...scope,
            query: { page: 2, pageSize: 1 },
          })
        ).items,
      ).toEqual([first]);

      const capturedRows = fixture.read(
        (database) =>
          database
            .prepare(
              "SELECT observation_json AS observations, adjudication_json AS adjudications FROM evaluation_assessments WHERE evaluation_id = ? ORDER BY version",
            )
            .all(batch.id) as unknown as { observations: string; adjudications: string }[],
      );
      expect(capturedRows).toHaveLength(2);
      for (const row of capturedRows) {
        const observations = JSON.parse(row.observations) as C.EvaluationOwnerObservation[];
        expect(observations).toHaveLength(2);
        for (const observation of observations)
          expect(observation).toMatchObject({
            executionState: "not_run",
            result: null,
            model: { state: "not_run" },
          });
        expect(JSON.parse(row.adjudications)).toEqual([]);
      }

      await grant("viewer");
      expect(await operator().request("getEvaluationAssessment", readFirst)).toEqual(first);
      expect(
        (
          await operator().request("getEvaluationAssessmentCase", {
            ...readFirst,
            caseId: "case-required-model",
          })
        ).caseTitle,
      ).toBe(caseTitle);
      const viewerPreview = await operator().request("getEvaluationScorePreview", scope);
      expectIncompletePreview(viewerPreview, 2);
      const nextRequest: C.EvaluationAssessmentPublishRequest = {
        changeId: "assessment-runtime-report-new",
        expectedVersion: 2,
        expectedInputDigest: viewerPreview.inputDigest,
      };
      await expect(
        operator().request("publishEvaluationAssessment", { ...scope, request: nextRequest }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await expect(
        operator().request("publishEvaluationAssessment", {
          ...scope,
          request: firstRequest,
          replayOnly: true,
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await grant("reviewer");

      const reportPath = `/api/v1/operator/repositories/${repositoryId}/evaluations/${batch.id}/assessments`;
      const restrictedHttp = await httpApp(fixture, true);
      const replayedHttp = await restrictedHttp.inject({
        method: "POST",
        url: reportPath,
        headers: httpHeaders(),
        payload: firstRequest,
      });
      expect(replayedHttp.statusCode, replayedHttp.body).toBe(200);
      expect(replayedHttp.json()).toEqual(first);
      const restrictedNew = await restrictedHttp.inject({
        method: "POST",
        url: reportPath,
        headers: httpHeaders(),
        payload: nextRequest,
      });
      expect(restrictedNew.statusCode).toBe(503);
      expect(restrictedNew.json().code).toBe("configuration_read_only");
      expect(
        (
          await restrictedHttp.inject({
            method: "POST",
            url: reportPath,
            headers: httpHeaders(),
            payload: { ...nextRequest, replayOnly: false },
          })
        ).statusCode,
      ).toBe(400);
      await closeHttpApps();

      recovery = true;
      await fixture.restart();
      expect(await operator().request("getEvaluationAssessment", readFirst)).toEqual(first);
      expect(
        (await operator().request("listEvaluationAssessments", { ...scope, query: {} })).items,
      ).toEqual([second, first]);
      expect(
        await operator().request("publishEvaluationAssessment", {
          ...scope,
          request: firstRequest,
        }),
      ).toEqual(first);
      await expect(
        operator().request("publishEvaluationAssessment", { ...scope, request: nextRequest }),
      ).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });
      const normalHttp = await httpApp(fixture, false);
      const recoveryReplay = await normalHttp.inject({
        method: "POST",
        url: reportPath,
        headers: httpHeaders(),
        payload: firstRequest,
      });
      expect(recoveryReplay.statusCode, recoveryReplay.body).toBe(200);
      expect(recoveryReplay.json()).toEqual(first);
      const recoveryNew = await normalHttp.inject({
        method: "POST",
        url: reportPath,
        headers: httpHeaders(),
        payload: nextRequest,
      });
      expect(recoveryNew.statusCode).toBe(503);
      expect(recoveryNew.json().code).toBe("configuration_read_only");
      expect(recoveryNew.headers["cache-control"]).toBe("private, no-store");
      await closeHttpApps();

      recovery = false;
      await fixture.restart();
      await grant(null);
      await expect(
        operator().request("publishEvaluationAssessment", {
          ...scope,
          request: firstRequest,
          replayOnly: true,
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(operator().request("getEvaluationAssessment", readFirst)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      await expect(operator().request("getEvaluationScorePreview", scope)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      expect(
        (
          await admin().request("listEvaluationAssessments", {
            repositoryId,
            evaluationId: batch.id,
            actor: administrator,
            query: {},
          })
        ).items,
      ).toEqual([second, first]);
      const finalCounts = fixture.read((database) =>
        database
          .prepare(`SELECT
      (SELECT COUNT(*) FROM evaluation_assessments WHERE evaluation_id = ?) AS assessments,
      (SELECT COUNT(*) FROM evaluation_mutation_receipts AS receipt JOIN evaluation_assessments AS assessment
        ON assessment.id = receipt.entity_id WHERE assessment.evaluation_id = ? AND receipt.operation = 'assessment_published') AS receipts,
      (SELECT COUNT(*) FROM review_run_job_links AS link JOIN evaluation_cells AS cell ON cell.run_id = link.review_run_id
        AND cell.request_id = link.request_id WHERE cell.evaluation_id = ?) AS evaluationJobs`)
          .get(batch.id, batch.id, batch.id),
      );
      expect(finalCounts).toEqual({ assessments: 2, receipts: 2, evaluationJobs: 0 });
    }, 60_000);
  },
);
