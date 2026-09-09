import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import {
  type CreateEvaluationBatchInput,
  createEvaluationBatchInTransaction,
} from "./evaluation-batches.js";
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import {
  createEvaluationManagementFixture,
  evaluationActor,
  evaluationAdministrator,
  evaluationLater,
} from "./evaluation-management.testing.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";

export const evaluationBatchNow = "2026-09-08T03:00:00.000Z";

export function publishEvaluationConfiguration(
  database: DatabaseSync,
  repositoryId: string,
  workflowKind: "pr_static_build" | "issue_validation",
  name: string,
  required = true,
) {
  const profile = handlePromptConfigurationRequest(
    database,
    {
      operation: "publishValidationProfile",
      input: {
        repositoryId,
        actor: evaluationAdministrator,
        request: {
          name,
          required,
          workflowKind,
          target: "headless",
          outputSchemaVersion:
            workflowKind === "pr_static_build" ? "PrReviewPlanV2" : "ValidationReportV1",
          config: {
            schemaVersion: "ValidationProfileV1",
            setup: [],
            build: [
              {
                id: "compile",
                name: "Compile the frozen source",
                command: {
                  executable: "node",
                  args: ["compile.mjs"],
                  workingDirectory: ".",
                  environment: [],
                },
                timeoutMs: 30_000,
                required: true,
              },
            ],
            test: [],
            launch: [],
            cleanup: [],
            requiredCapabilities: [],
            hardTimeoutMs: 120_000,
            noProgressTimeoutMs: 60_000,
          },
        },
      },
    },
    evaluationLater,
  ) as C.ValidationProfileVersion;
  const template = handlePromptConfigurationRequest(
    database,
    {
      operation: "createPromptTemplate",
      input: {
        actor: evaluationAdministrator,
        request: {
          name,
          workflowKind,
          content: `Review the frozen source with ${name}.`,
          outputSchemaVersion: C.WorkflowOutputSchemaVersions[workflowKind],
        },
      },
    },
    evaluationLater,
  ) as C.PromptTemplate;
  const prompt = handlePromptConfigurationRequest(
    database,
    {
      operation: "publishPromptDraft",
      input: {
        actor: evaluationAdministrator,
        templateId: template.id,
        request: { expectedVersion: template.version },
      },
    },
    evaluationLater,
  ) as C.PromptVersion;
  return {
    profile,
    prompt,
    selection: { profileVersionId: profile.id, promptVersionId: prompt.id },
  };
}

export function createEvaluationBatchFixture(
  kind: "pull_request" | "issue" = "pull_request",
  options: { required?: boolean; notApplicableCase?: boolean; migrationsDirectory?: string } = {},
) {
  const base = createEvaluationManagementFixture(kind, {
    ...(options.migrationsDirectory === undefined
      ? {}
      : { migrationsDirectory: options.migrationsDirectory }),
  });
  const { database, repositoryId } = base;
  try {
    const workflowKind = kind === "pull_request" ? "pr_static_build" : "issue_validation";
    const scope = { repositoryId, actor: evaluationActor };
    const source = handleEvaluationManagementRequest(
      database,
      {
        operation: "captureEvaluationSource",
        input: {
          ...scope,
          request: {
            changeId: "batch-capture-source",
            source: {
              ...base.reference,
              testedIssueCommit: kind === "issue" ? "c".repeat(40) : null,
            },
          },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSourceSummaryV1;
    const suite = handleEvaluationManagementRequest(
      database,
      {
        operation: "createEvaluationSuite",
        input: {
          ...scope,
          request: {
            changeId: "batch-create-suite",
            name: "Compiler samples",
            description: "Frozen known examples.",
            workflowKind,
            target: "headless",
          },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteSummaryV1;
    const cases: C.EvaluationSuiteDraftCase[] = [
      {
        caseId: "case-compiler",
        title: "Known failing build",
        sourceId: source.id,
        applicability: { state: "applicable" },
        criteria: [
          {
            criterionId: "criterion-compiler",
            description: "The declared build failure is detected.",
            applicability: { state: "applicable" },
            expectedOutcome: "failed",
          },
        ],
        findings: { annotation: "complete", expected: [] },
      },
    ];
    if (options.notApplicableCase !== false)
      cases.push({
        caseId: "case-other-target",
        title: "Excluded from this target",
        sourceId: source.id,
        applicability: {
          state: "not_applicable",
          reason: "This behavior belongs to another target.",
        },
        criteria: [],
        findings: { annotation: "unlabeled", expected: [] },
      });
    const saved = handleEvaluationManagementRequest(
      database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          ...scope,
          suiteId: suite.id,
          request: {
            changeId: "batch-save-suite",
            expectedRevision: suite.draftRevision,
            draft: { name: suite.name, description: suite.description, cases },
          },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteSummaryV1;
    const version = handleEvaluationManagementRequest(
      database,
      {
        operation: "publishEvaluationSuite",
        input: {
          ...scope,
          suiteId: suite.id,
          request: { changeId: "batch-publish-suite", expectedRevision: saved.draftRevision },
        },
      },
      evaluationLater,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteVersionV1;
    const baseline = publishEvaluationConfiguration(
      database,
      repositoryId,
      workflowKind,
      "Baseline",
      options.required,
    );
    const candidate = publishEvaluationConfiguration(
      database,
      repositoryId,
      workflowKind,
      "Candidate",
      options.required,
    );
    handlePromptConfigurationRequest(
      database,
      {
        operation: "savePromptBinding",
        input: {
          repositoryId,
          workflowKind,
          actor: evaluationAdministrator,
          request: { expectedVersion: 0, promptVersionId: baseline.prompt.id },
        },
      },
      evaluationLater,
    );
    const input: CreateEvaluationBatchInput = {
      repositoryId,
      actor: evaluationAdministrator,
      request: {
        changeId: "create-evaluation-batch",
        suiteId: suite.id,
        suiteVersionId: version.id,
        baseline: baseline.selection,
        candidate: candidate.selection,
        mode: "prompt_and_profile",
        checkMappings: [
          {
            caseId: "case-compiler",
            criterionId: "criterion-compiler",
            baselineCheckId: `${baseline.profile.id}:compile`,
            candidateCheckId: `${candidate.profile.id}:compile`,
          },
        ],
      },
    };
    const create = (
      selected: CreateEvaluationBatchInput = input,
      options?: { readOnly?: boolean },
    ) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = createEvaluationBatchInTransaction(
          database,
          selected,
          evaluationBatchNow,
          [evaluationAdministrator],
          options,
        );
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    };
    return { ...base, source, suite, version, baseline, candidate, input: { ...input }, create };
  } catch (error) {
    base.close();
    throw error;
  }
}

export function readEvaluationBatchCells(database: DatabaseSync, evaluationId: string) {
  return (
    database
      .prepare(`SELECT cell.id, cell.arm, cell.case_id, cell.applicable, cell.run_id, cell.request_id,
    run.plan_json, run.plan_digest, request.prompt_envelope_json FROM evaluation_cells AS cell
    JOIN review_runs AS run ON run.id = cell.run_id
    JOIN review_run_requests AS request ON request.review_run_id = cell.run_id AND request.request_id = cell.request_id
    WHERE cell.evaluation_id = ? ORDER BY cell.case_id, cell.arm`)
      .all(evaluationId) as {
      id: string;
      arm: C.EvaluationArm;
      case_id: string;
      applicable: number;
      run_id: string;
      request_id: string;
      plan_json: string;
      plan_digest: string;
      prompt_envelope_json: string;
    }[]
  ).map((row) => ({
    ...row,
    plan: JSON.parse(row.plan_json) as C.ReviewRunExecutionPlanV2,
    prompt: JSON.parse(row.prompt_envelope_json) as C.PromptEnvelope,
  }));
}
