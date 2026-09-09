import type * as C from "@agentic-review/contracts";
import {
  getObservationOptions,
  getPreconditionChecks,
  observationRefKey,
  reproductionProfileUnavailableReason,
} from "@/components/CreateReviewRun/reproduction";
import type { EvaluationReproductionAdapter } from "@/services/evaluation-reproduction";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";
import { type Arm, arms } from "./batch-state";

export type ReproductionSources = Record<string, C.EvaluationReproductionSourceDefinitionReadV1>;
export interface ReproductionDraft {
  readonly sourceDefinitionSha256: string;
  readonly selectedCaseIds: string[];
  readonly baseline: {
    observations: Record<string, string | null>;
    checks: Record<string, string | null>;
  };
  readonly candidate: {
    observations: Record<string, string | null>;
    checks: Record<string, string | null>;
  };
  readonly preview?: { readonly key: string; readonly value: C.EvaluationReproductionPreviewV1 };
}
export type ReproductionDrafts = Record<string, ReproductionDraft>;
export const unmappedObservation = "__explicit_unmapped__";
export const emptyReproductionArm = () => ({ observations: {}, checks: {} });

export function reproductionDraft(
  value: ReproductionDraft | undefined,
  sourceDefinitionSha256: string,
): ReproductionDraft {
  return value?.sourceDefinitionSha256 === sourceDefinitionSha256
    ? value
    : {
        sourceDefinitionSha256,
        selectedCaseIds: [],
        baseline: emptyReproductionArm(),
        candidate: emptyReproductionArm(),
      };
}

export function clearReproductionArm(drafts: ReproductionDrafts, arm: Arm): ReproductionDrafts {
  return Object.fromEntries(
    Object.entries(drafts).map(([key, draft]) => [
      key,
      { ...withoutReproductionPreview(draft), [arm]: emptyReproductionArm() },
    ]),
  );
}

export function withoutReproductionPreview(draft: ReproductionDraft): ReproductionDraft {
  const { preview: _preview, ...value } = draft;
  return value;
}

export function reproductionPreviewRequest(
  sourceId: string,
  selection: C.EvaluationReproductionMappingSelectionV1,
  profiles: Record<Arm, C.ValidationProfileVersion>,
): C.EvaluationReproductionPreviewRequest {
  return {
    sourceId,
    selection,
    baselineProfileVersionId: profiles.baseline.id,
    candidateProfileVersionId: profiles.candidate.id,
  };
}

export function reproductionPreviewKey(
  request: C.EvaluationReproductionPreviewRequest,
  sourceDefinitionSha256: string,
  profiles: Record<Arm, C.ValidationProfileVersion>,
): string {
  return JSON.stringify([
    request,
    sourceDefinitionSha256,
    profiles.baseline.configSha256,
    profiles.candidate.configSha256,
  ]);
}

export function assertReproductionPreview(
  value: C.EvaluationReproductionPreviewV1,
  request: C.EvaluationReproductionPreviewRequest,
  sourceDefinitionSha256: string,
  profiles: Record<Arm, C.ValidationProfileVersion>,
) {
  if (
    value.repositoryId !== profiles.baseline.repositoryId ||
    value.sourceId !== request.sourceId ||
    value.sourceDefinitionSha256 !== sourceDefinitionSha256 ||
    arms.some(
      (arm) =>
        value[arm].profileVersionId !== profiles[arm].id ||
        value[arm].profileConfigSha256 !== profiles[arm].configSha256,
    )
  )
    throw new ReviewControlProtocolError(
      "preview evaluation reproduction",
      "The preview does not match the exact source and published profile configuration.",
    );
}

export function requireReproductionPreviews(
  selections: readonly C.EvaluationReproductionMappingSelectionV1[],
  cases: readonly C.EvaluationSuiteCaseDetailV1[],
  sources: ReproductionSources,
  drafts: ReproductionDrafts,
  profiles: Record<Arm, C.ValidationProfileVersion>,
) {
  for (const selection of selections) {
    const entry = cases.find((value) => value.caseId === selection.caseId);
    const source = entry ? sources[entry.source.id] : undefined;
    const preview = drafts[selection.caseId]?.preview;
    if (!entry || !source?.sourceDefinitionSha256 || !preview)
      throw new ReviewControlRequestError(
        "create evaluation reproduction",
        "preview",
        "Preview every selected reproduction mapping before creating the batch.",
      );
    const request = reproductionPreviewRequest(entry.source.id, selection, profiles);
    if (preview.key !== reproductionPreviewKey(request, source.sourceDefinitionSha256, profiles))
      throw new ReviewControlRequestError(
        "create evaluation reproduction",
        "preview",
        "The reproduction mapping changed. Preview the current source and profile selections again.",
      );
    assertReproductionPreview(preview.value, request, source.sourceDefinitionSha256, profiles);
  }
}

export function reproductionRequirements(cases: readonly C.FrozenIssueReproductionCase[]) {
  const observations = new Map<
    string,
    { ref: C.ReproductionObservationRef; type: C.ObservationValue["type"] }
  >();
  const checks = new Set<string>();
  for (const entry of cases) {
    const predicates = [
      ...entry.presentWhen.allOf,
      ...(entry.absentWhen?.allOf ?? []),
      ...entry.preconditions.flatMap((control) =>
        control.kind === "observation_equals" ? [control.predicate] : [],
      ),
    ];
    for (const predicate of predicates) {
      const key = observationRefKey(predicate.observation),
        previous = observations.get(key);
      if (previous && previous.type !== predicate.equals.type)
        throw new ReviewControlProtocolError(
          "read source reproduction",
          "The source uses conflicting types for the same observation.",
        );
      observations.set(key, { ref: predicate.observation, type: predicate.equals.type });
    }
    for (const control of entry.preconditions)
      if (control.kind === "check_passed") checks.add(control.checkId);
  }
  return {
    observations: [...observations].map(([key, value]) => ({ key, ...value })),
    checks: [...checks],
  };
}

export async function loadReproductionSources(
  api: EvaluationReproductionAdapter,
  cases: readonly C.EvaluationSuiteCaseDetailV1[],
  signal?: AbortSignal,
): Promise<ReproductionSources> {
  const result: ReproductionSources = {};
  for (const entry of cases) {
    if (entry.source.workItemKind !== "issue") continue;
    signal?.throwIfAborted();
    const read =
      result[entry.source.id] ??
      (await api.getSource(
        { repositoryId: entry.repositoryId, sourceId: entry.source.id },
        signal,
      ));
    const definition = read.sourceDefinition;
    if (
      read.repositoryId !== entry.repositoryId ||
      read.sourceId !== entry.source.id ||
      (definition &&
        (definition.sourceDigest !== entry.source.sourceDigest ||
          definition.binding.workItemId !== entry.source.workItemId ||
          definition.binding.issueRevisionKey !== entry.source.revisionKey))
    )
      throw new ReviewControlProtocolError(
        "read source reproduction",
        "The reproduction definition does not match the frozen evaluation source.",
      );
    if (definition) reproductionRequirements(definition.binding.cases);
    result[entry.source.id] = read;
  }
  signal?.throwIfAborted();
  return result;
}

/** Build execution mappings solely from the historical reproduction and explicit operator choices. */
export function buildReproductionSelections(input: {
  cases: readonly C.EvaluationSuiteCaseDetailV1[];
  sources: ReproductionSources;
  drafts: ReproductionDrafts;
  profiles: Record<Arm, C.ValidationProfileVersion>;
}): C.EvaluationReproductionMappingSelectionV1[] {
  const reject = (message: string): never => {
    throw new ReviewControlRequestError(
      "create evaluation reproduction",
      "reproductionMappings",
      message,
    );
  };
  return input.cases.flatMap((entry) => {
    if (entry.source.workItemKind !== "issue") return [];
    const read = input.sources[entry.source.id];
    if (!read) return reject("Load the original reproduction for every frozen Issue source.");
    if (!read.sourceDefinition) return [];
    const source = read.sourceDefinition,
      draft = input.drafts[entry.caseId];
    if (!draft || draft.sourceDefinitionSha256 !== read.sourceDefinitionSha256)
      return reject(
        "Select reproduction cases from the current frozen source before creating a batch.",
      );
    if (
      !draft.selectedCaseIds.length ||
      new Set(draft.selectedCaseIds).size !== draft.selectedCaseIds.length
    )
      return reject(
        "Explicitly select at least one original reproduction case for each mapped source.",
      );
    const selected = source.binding.cases.filter((value) =>
      draft.selectedCaseIds.includes(value.id),
    );
    if (selected.length !== draft.selectedCaseIds.length)
      return reject("A selected reproduction case no longer belongs to its original source.");
    const required = reproductionRequirements(selected);
    const armMappings = Object.fromEntries(
      arms.map((arm) => {
        const profile = input.profiles[arm];
        const unavailable = reproductionProfileUnavailableReason(profile);
        const observations = unavailable ? [] : getObservationOptions(profile);
        const checks = unavailable ? [] : getPreconditionChecks(profile);
        const observationMappings = required.observations.map((original) => {
          const choice = draft[arm].observations[original.key];
          if (choice === undefined)
            return reject(
              "Choose an observation or explicit Unmapped for each original reference in both arms.",
            );
          if (choice === null) return { from: original.ref, to: null };
          const option = observations.find(
            (value) => value.key === choice && value.type === original.type,
          );
          if (!option)
            return reject(
              "A selected observation is unavailable or has a different type in its exact published profile.",
            );
          return { from: original.ref, to: option.ref };
        });
        const checkMappings = required.checks.map((fromCheckId) => {
          const toCheckId = draft[arm].checks[fromCheckId];
          if (toCheckId === undefined)
            return reject(
              "Choose a check or explicit Unmapped for each original check precondition in both arms.",
            );
          if (toCheckId !== null && !checks.some((value) => value.id === toCheckId))
            return reject(
              "A selected precondition check is unavailable in its exact published profile.",
            );
          return { fromCheckId, toCheckId };
        });
        return [arm, { observationMappings, checkMappings }];
      }),
    ) as Record<Arm, C.EvaluationReproductionArmMappingsV1>;
    return [
      {
        caseId: entry.caseId,
        selectedCaseIds: [...draft.selectedCaseIds],
        expectedSource: {
          reviewRunId: source.reviewRunId,
          planDigest: source.planDigest,
          bindingDigest: source.bindingDigest,
        },
        baseline: armMappings.baseline,
        candidate: armMappings.candidate,
      },
    ];
  });
}

export function assertReproductionPlanScope(
  plan: C.EvaluationReproductionPlanV1,
  matrix: C.EvaluationBatchMatrixV1,
) {
  const manifest = plan.manifest;
  const cells = matrix.cases.flatMap((entry) => [entry.baseline, entry.candidate]);
  if (
    plan.repositoryId !== matrix.repositoryId ||
    plan.evaluationId !== matrix.evaluationId ||
    (manifest &&
      (manifest.cells.length !== cells.length ||
        manifest.cells.some(
          (reference) =>
            !cells.some(
              (cell) =>
                cell.cellId === reference.cellId &&
                cell.caseId === reference.caseId &&
                cell.arm === reference.arm,
            ),
        ) ||
        manifest.sources.some(
          (reference) =>
            !matrix.cases.some(
              (entry) =>
                entry.caseId === reference.caseId && entry.source.id === reference.sourceId,
            ),
        )))
  )
    throw new ReviewControlProtocolError(
      "read evaluation reproduction plan",
      "The frozen reproduction manifest does not match this batch matrix.",
    );
}

export function assertFrozenReproductionCell(input: {
  detail: C.EvaluationReproductionCellDetailV1;
  manifest: C.EvaluationReproductionManifestV1;
  cell: C.EvaluationCellSummaryV1;
  profile: C.ValidationProfileVersionSummary;
  source: C.EvaluationReproductionSourceDefinitionReadV1 | null;
}) {
  const { detail, manifest, cell, profile, source } = input;
  const reference = manifest.cells.find((entry) => entry.cellId === cell.cellId);
  const original = manifest.sources.find((entry) => entry.caseId === cell.caseId);
  const record = detail.record;
  if (
    detail.evaluationId !== manifest.evaluationId ||
    detail.repositoryId !== manifest.repositoryId ||
    detail.cellRecordSha256 !== reference?.cellRecordSha256 ||
    record.cellId !== cell.cellId ||
    record.caseId !== cell.caseId ||
    record.arm !== cell.arm ||
    record.sourceId !== cell.sourceId ||
    record.sourceDefinitionSha256 !== (original?.sourceDefinitionSha256 ?? null) ||
    (original &&
      (source === null ||
        source.sourceId !== cell.sourceId ||
        source.sourceDefinitionSha256 !== original.sourceDefinitionSha256 ||
        source.sourceDefinition?.sourceDigest !== cell.sourceDigest)) ||
    (record.reproduction &&
      (record.reproduction.binding.claim !== source?.sourceDefinition?.binding.claim ||
        record.reproduction.binding.testedSourceCommit !==
          source?.sourceDefinition?.binding.testedSourceCommit ||
        record.reproduction.binding.cases.some(
          (entry) =>
            entry.requestId !== cell.requestId ||
            entry.profileVersionId !== profile.id ||
            entry.profileConfigSha256 !== profile.configSha256 ||
            entry.target !== profile.target,
        )))
  )
    throw new ReviewControlProtocolError(
      "read evaluation reproduction cell",
      "The reproduction record does not match its frozen manifest, source, cell and profile.",
    );
}
