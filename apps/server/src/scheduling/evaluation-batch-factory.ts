import { randomUUID } from "node:crypto";
import * as C from "@agentic-review/contracts";
import {
  createEvaluationReproductionCellRecord,
  createEvaluationReproductionManifest,
  evaluateEvaluationRunReadiness,
  evaluationReproductionCellRecordDigest,
  evaluationReproductionManifestDigest,
  freezeEvaluationScoringPlan,
  validateEvaluationIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import type { PublishedEvaluationSuite } from "../database/evaluation-management.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { createEvaluationPromptEnvelope } from "./validation-job-factory.js";

export interface EvaluationBatchPlannedCell {
  readonly manifest: C.EvaluationCellManifestEntryV1 | C.EvaluationCellManifestEntryV2;
  readonly applicable: boolean;
  readonly source: C.EvaluationSourceSnapshotV1;
  readonly plan: C.ReviewRunExecutionPlanV2;
  readonly planDigest: string;
  readonly prompt: C.PromptEnvelope;
  readonly readiness: C.ReviewRunReadiness[];
  readonly reproductionRecord: C.EvaluationReproductionCellRecordV1;
}
export interface EvaluationBatchPlan {
  readonly summary: C.EvaluationBatchSummaryV1;
  readonly configuration: C.EvaluationConfigurationManifestV1;
  readonly configurationDigest: string;
  readonly cellManifest: C.EvaluationCellManifestV1 | C.EvaluationCellManifestV2;
  readonly cellManifestDigest: string;
  readonly executionManifest: C.EvaluationExecutionManifestV1;
  readonly executionManifestDigest: string;
  readonly authorization: C.EvaluationExecutionAuthorizationV1;
  readonly authorizationDigest: string;
  readonly scoringPlan: C.EvaluationScoringPlanV1;
  readonly scoringPlanDigest: string;
  readonly reproductionSources: readonly C.EvaluationReproductionSourceDefinitionV1[];
  readonly reproductionManifest: C.EvaluationReproductionManifestV1 | null;
  readonly cells: EvaluationBatchPlannedCell[];
}

function bounded(value: unknown, maximum: number, label: string): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > maximum) {
    throw new RangeError(`${label} exceeds its aggregate UTF-8 byte limit.`);
  }
  return json;
}

/** Inputs are owner-resolved published records. This function never grants access or dispatches. */
export function createEvaluationBatchPlan(input: {
  readonly request: C.EvaluationBatchCreateRequest;
  readonly suite: PublishedEvaluationSuite;
  readonly sources: ReadonlyMap<string, C.EvaluationSourceSnapshotV1>;
  readonly reproductionSources?: ReadonlyMap<string, C.EvaluationReproductionSourceDefinitionV1>;
  readonly baseline: C.EvaluationFrozenConfiguration;
  readonly candidate: C.EvaluationFrozenConfiguration;
  readonly actor: C.OperatorPrincipal;
  readonly now: string;
}): EvaluationBatchPlan {
  C.assertEvaluationBatchCreateRequest(input.request);
  const { suite, request } = input;
  C.assertEvaluationSuiteVersion(suite.version);
  const version = suite.version;
  if (
    request.suiteId !== version.suiteId ||
    request.suiteVersionId !== version.id ||
    !Value.Check(C.OperatorPrincipalSchema, input.actor) ||
    new Date(input.now).toISOString() !== input.now
  )
    throw new TypeError("The evaluation batch scope or creation identity is invalid.");
  if (
    request.mode === "profile_only" &&
    (version.workflowKind === "pr_static_build" || version.workflowKind === "issue_triage")
  ) {
    throw new TypeError("Static review and Issue triage require Prompt and profile evaluation.");
  }
  const configuration: C.EvaluationConfigurationManifestV1 = {
    schemaVersion: "EvaluationConfigurationManifestV1",
    repositoryId: version.repositoryId,
    mode: request.mode,
    baseline: input.baseline,
    candidate: input.candidate,
  };
  if (!Value.Check(C.EvaluationConfigurationManifestV1Schema, configuration)) {
    throw new TypeError("The frozen evaluation configuration is invalid.");
  }
  const checkIds = { baseline: new Set<string>(), candidate: new Set<string>() };
  for (const arm of ["baseline", "candidate"] as const) {
    const selected = configuration[arm],
      profile = selected.profileVersion;
    if (
      C.getEvaluationFrozenConfigurationIssues(selected).length > 0 ||
      profile.id !== request[arm].profileVersionId ||
      selected.prompt.version.id !== request[arm].promptVersionId ||
      profile.repositoryId !== version.repositoryId ||
      profile.workflowKind !== version.workflowKind ||
      profile.target !== version.target ||
      selected.prompt.workflowKind !== version.workflowKind ||
      selected.modelRequirements.required !== (request.mode === "prompt_and_profile") ||
      sha256(canonicalJson(profile.config)) !== profile.configSha256 ||
      C.getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target)
        .length
    ) {
      throw new TypeError("The selected configuration does not match the published suite.");
    }
    for (const check of [
      ...profile.config.build,
      ...profile.config.test,
      ...(profile.config.ui?.scenarios ?? []),
    ]) {
      checkIds[arm].add(`${profile.id}:${check.id}`);
    }
  }
  const mappings = new Map(
    request.checkMappings.map((mapping) => [
      JSON.stringify([mapping.caseId, mapping.criterionId]),
      mapping,
    ]),
  );
  let criterionCount = 0;
  for (const entry of suite.expectationManifest.cases) {
    for (const criterion of entry.criteria) {
      criterionCount += 1;
      const mapping = mappings.get(JSON.stringify([entry.caseId, criterion.criterionId]));
      if (!mapping)
        throw new TypeError(
          "Every frozen criterion requires an explicit mapping for both arms, including null mappings.",
        );
      for (const arm of ["baseline", "candidate"] as const) {
        const id = mapping[`${arm}CheckId`];
        if (id !== null && !checkIds[arm].has(id)) {
          throw new TypeError(
            "A criterion mapping references a check absent from the published profile.",
          );
        }
      }
    }
  }
  if (criterionCount !== mappings.size)
    throw new TypeError(
      "The evaluation mappings contain a case or criterion outside this suite version.",
    );
  const configurationDigest = sha256(
    bounded(configuration, 2 * 1024 * 1024, "Evaluation configuration"),
  );
  const evaluationId = randomUUID();
  const hasReproduction =
    (input.reproductionSources?.size ?? 0) > 0 || (request.reproductionMappings?.length ?? 0) > 0;
  const reproductionSelections = new Map(
    (request.reproductionMappings ?? []).map((selection) => [selection.caseId, selection]),
  );
  if (
    reproductionSelections.size !== (request.reproductionMappings ?? []).length ||
    [...reproductionSelections.keys()].some(
      (caseId) => !suite.sourceManifest.cases.some((entry) => entry.caseId === caseId),
    )
  )
    throw new TypeError("Reproduction mappings must identify distinct cases in the frozen suite.");
  const prepared = suite.sourceManifest.cases.flatMap((entry, index) => {
    const source = input.sources.get(entry.sourceId);
    const expected = suite.expectationManifest.cases[index];
    if (
      !source ||
      expected?.caseId !== entry.caseId ||
      source.repository.id !== version.repositoryId ||
      source.sourceDigest !== entry.sourceDigest
    ) {
      throw new TypeError("The evaluation source and expectation matrix is incomplete.");
    }
    C.assertEvaluationSourceSnapshot(source);
    return (["baseline", "candidate"] as const).map((arm) => {
      const selected = configuration[arm];
      const prompt = createEvaluationPromptEnvelope(source, selected.prompt);
      const identity: C.EvaluationCellManifestEntryV1 = {
        cellId: randomUUID(),
        caseId: entry.caseId,
        arm,
        trial: 1,
        sourceId: entry.sourceId,
        sourceDigest: source.sourceDigest,
        runId: randomUUID(),
        requestId: randomUUID(),
        activationId: randomUUID(),
        profileVersionId: selected.profileVersion.id,
        promptVersionId: selected.prompt.version.id,
        renderedPromptDigest: prompt.promptSha256,
        outputSchemaDigest: prompt.outputSchemaSha256,
        modelRequirements: selected.modelRequirements,
      };
      const selection = reproductionSelections.get(entry.caseId);
      const reproductionRecord = createEvaluationReproductionCellRecord({
        evaluationId,
        repositoryId: version.repositoryId,
        caseId: entry.caseId,
        cellId: identity.cellId,
        arm,
        sourceId: entry.sourceId,
        applicable: expected.applicability.state === "applicable",
        sourceDefinition: input.reproductionSources?.get(entry.sourceId) ?? null,
        ...(selection === undefined ? {} : { selection }),
        bindingContext: {
          activationId: identity.activationId,
          requestId: identity.requestId,
          source,
          profileVersion: selected.profileVersion,
          actor: input.actor,
          authorizedAt: input.now,
        },
      });
      const manifest: C.EvaluationCellManifestEntryV1 | C.EvaluationCellManifestEntryV2 =
        !hasReproduction
          ? identity
          : {
              ...identity,
              reproduction: {
                state: reproductionRecord.state,
                bindingDigest: reproductionRecord.reproduction?.bindingDigest ?? null,
                cellRecordSha256: evaluationReproductionCellRecordDigest(reproductionRecord),
              },
            };
      return {
        manifest,
        reproductionRecord,
        source,
        prompt,
        applicable: expected.applicability.state === "applicable",
      };
    });
  });
  if (prepared.length !== version.caseCount * 2)
    throw new TypeError("The complete evaluation matrix requires exactly two cells per case.");
  const reproductionManifest = !hasReproduction
    ? null
    : createEvaluationReproductionManifest({
        evaluationId,
        repositoryId: version.repositoryId,
        sources: suite.sourceManifest.cases.flatMap((entry) => {
          const definition = input.reproductionSources?.get(entry.sourceId);
          return definition === undefined ? [] : [{ caseId: entry.caseId, definition }];
        }),
        cells: prepared.map((cell) => cell.reproductionRecord),
      });
  const cellManifest: C.EvaluationCellManifestV1 | C.EvaluationCellManifestV2 =
    reproductionManifest === null
      ? {
          schemaVersion: "EvaluationCellManifestV1",
          evaluationId,
          repositoryId: version.repositoryId,
          cells: prepared.map((cell) => cell.manifest),
        }
      : {
          schemaVersion: "EvaluationCellManifestV2",
          evaluationId,
          repositoryId: version.repositoryId,
          reproductionManifestSha256: evaluationReproductionManifestDigest(reproductionManifest),
          cells: prepared.map((cell) => {
            if (!("reproduction" in cell.manifest))
              throw new TypeError("The reproduction cell reference is missing.");
            return cell.manifest;
          }),
        };
  const cellManifestDigest = sha256(bounded(cellManifest, 262_144, "Evaluation cell manifest"));
  const executionManifest: C.EvaluationExecutionManifestV1 = {
    schemaVersion: "EvaluationExecutionManifestV1",
    evaluationId,
    repositoryId: version.repositoryId,
    sampleSetVersionId: version.id,
    workflowKind: version.workflowKind,
    target: version.target,
    sourceManifestSha256: version.sourceManifestSha256,
    configurationManifestSha256: configurationDigest,
    cellManifestSha256: cellManifestDigest,
    trial: 1,
    upstreamMutationPolicy: "forbidden",
  };
  const executionManifestDigest = sha256(
    bounded(executionManifest, 16_384, "Evaluation execution manifest"),
  );
  const first = prepared[0];
  if (!first) throw new TypeError("An evaluation requires at least one frozen case.");
  const authorization: C.EvaluationExecutionAuthorizationV1 = {
    schemaVersion: "EvaluationExecutionAuthorizationV1",
    kind: "operator_evaluation",
    id: randomUUID(),
    actor: input.actor,
    authorizedAt: input.now,
    evaluationId,
    repositoryId: version.repositoryId,
    githubRepositoryId: first.source.repository.githubRepositoryId,
    sampleSetVersionId: version.id,
    sourceManifestSha256: version.sourceManifestSha256,
    configurationManifestSha256: configurationDigest,
    cellManifestSha256: cellManifestDigest,
    executionManifestSha256: executionManifestDigest,
  };
  C.assertEvaluationExecutionAuthorization(authorization);
  const authorizationDigest = sha256(bounded(authorization, 16_384, "Evaluation authorization"));
  const cells = prepared.map((cell) => {
    const selected = configuration[cell.manifest.arm],
      profile = selected.profileVersion;
    const requiredCheckIds = profile.required
      ? [...profile.config.build, ...profile.config.test, ...(profile.config.ui?.scenarios ?? [])]
          .filter((check) => check.required)
          .map((check) => `${profile.id}:${check.id}`)
          .sort()
      : [];
    const source = cell.source;
    const plan: C.ReviewRunExecutionPlanV2 = {
      schemaVersion: "ReviewRunExecutionPlanV2",
      activationId: cell.manifest.activationId,
      requestEpochId: null,
      repository: source.repository,
      workItemId: source.workItemId,
      workItem: source.workItem,
      revision: source.revision,
      testedSourceRevision: source.testedSourceRevision,
      testedSourceAuthorization: null,
      source,
      authorization,
      modelRequirements: selected.modelRequirements,
      ...(cell.reproductionRecord.reproduction === null
        ? {}
        : { reproduction: cell.reproductionRecord.reproduction }),
      purpose: {
        schemaVersion: "EvaluationExecutionPurposeV1",
        kind: "evaluation",
        evaluationId,
        cellId: cell.manifest.cellId,
        caseId: cell.manifest.caseId,
        arm: cell.manifest.arm,
        sampleSetVersionId: version.id,
        authorizationId: authorization.id,
        executionManifestSha256: executionManifestDigest,
        trial: 1,
        upstreamMutationPolicy: "forbidden",
      },
      jobs: [
        {
          requestId: cell.manifest.requestId,
          workflowKind: version.workflowKind,
          target: version.target,
          required: profile.required,
          profileVersion: profile,
          prompt: selected.prompt,
          requiredCheckIds,
        },
      ],
      requiredCheckIds,
    };
    C.assertEvaluationReviewRunPlan(plan);
    validateEvaluationIssueReproductionBinding(plan);
    const readiness = evaluateEvaluationRunReadiness(plan, []);
    if (cell.reproductionRecord.state === "blocked") {
      for (const item of readiness) {
        item.state = "blocked";
        item.reasons.push({ code: "reproduction_mapping_blocked" });
      }
    }
    return {
      ...cell,
      plan,
      planDigest: sha256(bounded(plan, C.maximumReviewRunPlanUtf8Bytes, "Evaluation run plan")),
      readiness,
    };
  });
  const scoringConfiguration = (arm: C.EvaluationArm) => ({
    profileVersionId: configuration[arm].profileVersion.id,
    promptVersionId: configuration[arm].prompt.version.id,
  });
  const scoringPlan: C.EvaluationScoringPlanV1 = {
    schemaVersion: "EvaluationScoringPlanV1",
    evaluationId,
    repositoryId: version.repositoryId,
    sampleSetVersionId: version.id,
    expectationVersionId: version.expectationVersionId,
    baseline: scoringConfiguration("baseline"),
    candidate: scoringConfiguration("candidate"),
    cases: suite.expectationManifest.cases.map((entry) => {
      const baseline = cells.find(
        (cell) => cell.manifest.caseId === entry.caseId && cell.manifest.arm === "baseline",
      );
      const candidate = cells.find(
        (cell) => cell.manifest.caseId === entry.caseId && cell.manifest.arm === "candidate",
      );
      if (!baseline || !candidate)
        throw new TypeError("A scoring case requires both new execution bindings.");
      const binding = (cell: EvaluationBatchPlannedCell) => ({
        cellId: cell.manifest.cellId,
        runId: cell.manifest.runId,
        requestId: cell.manifest.requestId,
      });
      return {
        caseId: entry.caseId,
        sourceDigest: baseline.source.sourceDigest,
        baselineBinding: binding(baseline),
        candidateBinding: binding(candidate),
        applicability: entry.applicability,
        findings: entry.findings,
        criteria: entry.criteria.map((criterion) => {
          const mapping = mappings.get(JSON.stringify([entry.caseId, criterion.criterionId]));
          if (!mapping) throw new TypeError("A frozen criterion mapping disappeared.");
          return {
            ...criterion,
            baselineCheckId: mapping.baselineCheckId,
            candidateCheckId: mapping.candidateCheckId,
          };
        }),
      };
    }),
  };
  const frozenScoringPlan = freezeEvaluationScoringPlan(scoringPlan);
  const summary: C.EvaluationBatchSummaryV1 = {
    schemaVersion: "EvaluationBatchSummaryV1",
    id: evaluationId,
    repositoryId: version.repositoryId,
    suiteId: version.suiteId,
    suiteVersionId: version.id,
    workflowKind: version.workflowKind,
    target: version.target,
    mode: request.mode,
    baseline: request.baseline,
    candidate: request.candidate,
    caseCount: version.caseCount,
    cellCount: cells.length,
    createdAt: input.now,
    createdBy: input.actor,
  };
  const result: EvaluationBatchPlan = {
    summary,
    configuration,
    configurationDigest,
    cellManifest,
    cellManifestDigest,
    executionManifest,
    executionManifestDigest,
    authorization,
    authorizationDigest,
    scoringPlan: frozenScoringPlan.plan,
    scoringPlanDigest: frozenScoringPlan.digest,
    reproductionSources: [...(input.reproductionSources?.values() ?? [])],
    reproductionManifest,
    cells,
  };
  return JSON.parse(
    bounded(result, C.maximumEvaluationBatchPlanUtf8Bytes, "Evaluation batch plan"),
  ) as EvaluationBatchPlan;
}
