import type * as C from "@agentic-review/contracts";
import { canonicalJson } from "../scheduling/canonical-json.js";
import type { CreateEvaluationBatchInput } from "./evaluation-batches.js";
import { createEvaluationBatchFixture, evaluationBatchNow } from "./evaluation-batches.testing.js";
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import { evaluationActor, evaluationAdministrator } from "./evaluation-management.testing.js";
import { handleEvaluationReproductionRequest } from "./evaluation-reproduction.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";
import { handleReviewRunRequest, type ReviewRunDetail } from "./review-runs.js";

/** Only synthetic immutable records are created. No command, model, or upstream write occurs. */
export function createEvaluationReproductionFixture(
  options: { notApplicableCase?: boolean; requiredModel?: boolean } = {},
) {
  const base = createEvaluationBatchFixture("issue", { notApplicableCase: false });
  const database = base.database;
  try {
    const publish = (name: string, stepId: string, fieldId: string) => {
      const profile = handlePromptConfigurationRequest(
        database,
        {
          operation: "publishValidationProfile",
          input: {
            repositoryId: base.repositoryId,
            actor: evaluationAdministrator,
            request: {
              name,
              required: true,
              workflowKind: "issue_validation",
              target: "headless",
              outputSchemaVersion: "ValidationReportV1",
              config: {
                ...base.baseline.profile.config,
                test: [
                  {
                    id: stepId,
                    name: "Read a synthetic boolean observation",
                    required: true,
                    command: {
                      executable: "node",
                      args: ["synthetic-probe.mjs"],
                      workingDirectory: ".",
                      environment: [],
                    },
                    timeoutMs: 30_000,
                    probeOutput: {
                      schemaVersion: "TestProbeOutputDeclarationV1",
                      fields: [
                        {
                          id: fieldId,
                          type: "boolean",
                          description: "Synthetic observed condition.",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
        evaluationBatchNow,
      ) as C.ValidationProfileVersion;
      return {
        profile,
        prompt: base.baseline.prompt,
        selection: { profileVersionId: profile.id, promptVersionId: base.baseline.prompt.id },
      };
    };
    const original = publish("Historical mapped profile", "old-probe", "old-state");
    handlePromptConfigurationRequest(
      database,
      {
        operation: "saveValidationProfileBinding",
        input: {
          repositoryId: base.repositoryId,
          profileId: original.profile.profileId,
          actor: evaluationAdministrator,
          request: { expectedVersion: 0, profileVersionId: original.profile.id, enabled: true },
        },
      },
      evaluationBatchNow,
    );
    const baseline = publish("Mapped baseline", "baseline-probe", "baseline-state");
    const candidate = publish("Mapped candidate", "candidate-probe", "candidate-state");
    const originalObservation: C.ReproductionObservationRef = {
      kind: "probe_value",
      testStepId: "old-probe",
      observationId: "old-state",
    };
    const reproduction: C.IssueReproductionRequestV1 = {
      schemaVersion: "IssueReproductionRequestV1",
      claim: "Synthetic condition is present.",
      cases: [
        {
          id: "condition",
          context: "Read the declared synthetic observation.",
          profileId: original.profile.profileId,
          expectedProfileVersionId: original.profile.id,
          preconditions: [{ kind: "check_passed", checkId: `${original.profile.id}:compile` }],
          presentWhen: {
            allOf: [{ observation: originalObservation, equals: { type: "boolean", value: true } }],
          },
          absentWhen: {
            allOf: [
              { observation: originalObservation, equals: { type: "boolean", value: false } },
            ],
          },
        },
      ],
    };
    const run = handleReviewRunRequest(
      database,
      {
        operation: "createReviewRun",
        input: {
          actor: evaluationActor,
          planInput: {
            ...base.planInput,
            requests: [
              {
                requestId: "original-reproduction-request",
                workflowKind: "issue_validation",
                target: "headless",
                required: true,
                profileVersion: original.profile,
                prompt: { workflowKind: "issue_validation", version: original.prompt },
              },
            ],
            reproduction,
          },
        },
      },
      evaluationBatchNow,
    ) as ReviewRunDetail;
    const scope = { repositoryId: base.repositoryId, actor: evaluationActor };
    const source = handleEvaluationManagementRequest(
      database,
      {
        operation: "captureEvaluationSource",
        input: {
          ...scope,
          request: {
            changeId: "capture-mapped-source",
            source: { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: run.planDigest },
          },
        },
      },
      evaluationBatchNow,
      [evaluationAdministrator],
    ) as C.EvaluationSourceSummaryV1;
    const definitionRead = handleEvaluationReproductionRequest(
      database,
      { operation: "getEvaluationSourceReproduction", input: { ...scope, sourceId: source.id } },
      evaluationBatchNow,
      [evaluationAdministrator],
    ) as C.EvaluationReproductionSourceDefinitionReadV1;
    const definition = definitionRead.sourceDefinition;
    if (definition === null || !run.plan.reproduction)
      throw new Error("The synthetic historical reproduction definition is missing.");
    const suite = handleEvaluationManagementRequest(
      database,
      {
        operation: "createEvaluationSuite",
        input: {
          ...scope,
          request: {
            changeId: "mapped-suite",
            name: "Synthetic mapped observations",
            description: "Frozen explicit arm remapping.",
            workflowKind: "issue_validation",
            target: "headless",
          },
        },
      },
      evaluationBatchNow,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteSummaryV1;
    const cases: C.EvaluationSuiteDraftCase[] = [
      {
        caseId: "mapped-case",
        title: "Synthetic mapped condition",
        sourceId: source.id,
        applicability: { state: "applicable" },
        criteria: [],
        findings: { annotation: "unlabeled", expected: [] },
      },
    ];
    if (options.notApplicableCase)
      cases.push({
        ...cases[0]!,
        caseId: "excluded-case",
        applicability: { state: "not_applicable", reason: "Excluded synthetic case." },
      });
    const saved = handleEvaluationManagementRequest(
      database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          ...scope,
          suiteId: suite.id,
          request: {
            changeId: "mapped-suite-draft",
            expectedRevision: suite.draftRevision,
            draft: { name: suite.name, description: suite.description, cases },
          },
        },
      },
      evaluationBatchNow,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteSummaryV1;
    const version = handleEvaluationManagementRequest(
      database,
      {
        operation: "publishEvaluationSuite",
        input: {
          ...scope,
          suiteId: suite.id,
          request: {
            changeId: "mapped-suite-publish",
            expectedRevision: saved.draftRevision,
          },
        },
      },
      evaluationBatchNow,
      [evaluationAdministrator],
    ) as C.EvaluationSuiteVersionV1;
    const selection: C.EvaluationReproductionMappingSelectionV1 = {
      caseId: "mapped-case",
      selectedCaseIds: ["condition"],
      expectedSource: {
        reviewRunId: run.id,
        planDigest: run.planDigest,
        bindingDigest: run.plan.reproduction.bindingDigest,
      },
      baseline: {
        observationMappings: [
          {
            from: originalObservation,
            to: {
              kind: "probe_value",
              testStepId: "baseline-probe",
              observationId: "baseline-state",
            },
          },
        ],
        checkMappings: [
          {
            fromCheckId: `${original.profile.id}:compile`,
            toCheckId: `${baseline.profile.id}:compile`,
          },
        ],
      },
      candidate: {
        observationMappings: [
          {
            from: originalObservation,
            to: {
              kind: "probe_value",
              testStepId: "candidate-probe",
              observationId: "candidate-state",
            },
          },
        ],
        checkMappings: [
          {
            fromCheckId: `${original.profile.id}:compile`,
            toCheckId: `${candidate.profile.id}:compile`,
          },
        ],
      },
    };
    const input: CreateEvaluationBatchInput = {
      ...base.input,
      request: {
        changeId: "create-mapped-evaluation",
        suiteId: suite.id,
        suiteVersionId: version.id,
        baseline: baseline.selection,
        candidate: candidate.selection,
        mode: options.requiredModel ? "prompt_and_profile" : "profile_only",
        checkMappings: [],
        reproductionMappings: [selection],
      },
    };
    return {
      ...base,
      original,
      baseline,
      candidate,
      run,
      source,
      definition,
      suite,
      version,
      selection,
      input,
      create: (request = input, restriction?: { readOnly?: boolean }) =>
        base.create(request, restriction),
      originalPlanJson: canonicalJson(run.plan),
    };
  } catch (error) {
    base.close();
    throw error;
  }
}
