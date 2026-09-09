import { createHash } from "node:crypto";
import {
  assertReviewRunExecutionPlan,
  type EvaluationArm,
  type EvaluationReproductionBlockerV1,
  type EvaluationReproductionCellRecordV1,
  type EvaluationReproductionManifestV1,
  type EvaluationReproductionMappingSelectionV1,
  type EvaluationReproductionSourceDefinitionV1,
  type EvaluationSourceSnapshotV1,
  type FrozenIssueReproductionBinding,
  type FrozenIssueReproductionCase,
  getEvaluationReproductionBindingContextIssues,
  getEvaluationReproductionCellRecordIssues,
  getEvaluationReproductionManifestIssues,
  getEvaluationReproductionMappingSelectionIssues,
  getEvaluationReproductionSourceDefinitionIssues,
  getEvaluationReviewRunPlanIssues,
  getEvaluationSourceSnapshotIssues,
  getEvaluationValidationJobContextIssues,
  getValidationProfileConfigIssues,
  maximumEvaluationReproductionDocumentUtf8Bytes,
  type OperatorPrincipal,
  type ReproductionObservationRef,
  type ReviewRunExecutionPlanV1,
  type ReviewRunExecutionPlanV2,
  type ValidationJobContextV2,
  type ValidationProfileVersion,
} from "@agentic-review/contracts";
import {
  canonicalizeIssueReproductionRequest,
  validateFrozenIssueReproductionBinding,
} from "./issue-reproduction.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError("Reproduction data must be JSON.");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
const hashText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const digest = (value: unknown): string => hashText(canonical(value));
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
function assertNoIssues(issues: readonly string[]): void {
  if (issues.length) throw new TypeError(issues[0]);
}
function frozenCopy<T>(value: T): T {
  const copy = JSON.parse(canonical(value)) as T;
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === "object") {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
  };
  freeze(copy);
  return copy;
}
function assertSource(source: EvaluationSourceSnapshotV1): void {
  assertNoIssues(getEvaluationSourceSnapshotIssues(source));
  const { repository, workItemId, workItem, revision, testedSourceRevision, revisionId } = source;
  const revisionKey = hashText(
    revision.kind === "pull_request"
      ? `${revision.baseSha}\0${revision.headSha}`
      : JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
  );
  const commits =
    testedSourceRevision === null
      ? []
      : testedSourceRevision.kind === "pull_request"
        ? [testedSourceRevision.baseSha, testedSourceRevision.headSha]
        : [testedSourceRevision.headSha];
  if (
    digest({ repository, workItemId, workItem, revision, testedSourceRevision, revisionId }) !==
      source.sourceDigest ||
    revisionKey !== revision.revisionKey ||
    (revision.kind === "issue" && revision.contentDigest !== revisionKey) ||
    commits.some((entry) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(entry))
  )
    throw new TypeError("The evaluation reproduction source content is inconsistent.");
}

/** Reuses canonical case/profile checks, then verifies evaluation authority without a V1 surrogate. */
export function validateEvaluationIssueReproductionBinding(
  value: ValidationJobContextV2 | ReviewRunExecutionPlanV2,
): void {
  assertNoIssues(
    value.schemaVersion === "ReviewRunExecutionPlanV2"
      ? getEvaluationReviewRunPlanIssues(value)
      : getEvaluationValidationJobContextIssues(value),
  );
  assertSource(value.source);
  if (value.reproduction === undefined) return;
  const requests = "jobs" in value ? value.jobs : [value];
  validateFrozenIssueReproductionBinding(value.reproduction, requests);
  const binding = value.reproduction.binding;
  if (
    value.source.workItem.kind !== "issue" ||
    value.source.testedSourceRevision?.kind !== "commit" ||
    binding.activationId !== value.activationId ||
    binding.repositoryId !== value.source.repository.id ||
    binding.githubRepositoryId !== value.source.repository.githubRepositoryId ||
    binding.workItemId !== value.source.workItemId ||
    binding.githubWorkItemId !== value.source.workItem.githubWorkItemId ||
    binding.issueRevisionKey !== value.source.revision.revisionKey ||
    binding.testedSourceCommit !== value.source.testedSourceRevision.headSha ||
    !same(binding.authorizedBy, {
      ...value.authorization.actor,
      authorizedAt: value.authorization.authorizedAt,
    })
  )
    throw new TypeError(
      "The reproduction binding differs from its evaluation source and authorization.",
    );
}

export interface CreateEvaluationReproductionSourceDefinitionInput {
  readonly repositoryId: string;
  readonly sourceId: string;
  readonly source: EvaluationSourceSnapshotV1;
  readonly plan: ReviewRunExecutionPlanV1 | ReviewRunExecutionPlanV2;
  readonly expectedPlanDigest: string;
}
/** The owner resolves and authorizes the immutable source run before calling this pure builder. */
export function createEvaluationReproductionSourceDefinition(
  input: CreateEvaluationReproductionSourceDefinitionInput,
): EvaluationReproductionSourceDefinitionV1 | null {
  const { source, plan } = input;
  assertSource(source);
  if (plan.schemaVersion === "ReviewRunExecutionPlanV1") assertReviewRunExecutionPlan(plan);
  else validateEvaluationIssueReproductionBinding(plan);
  if (
    source.provenance.kind !== "review_run" ||
    input.repositoryId !== source.repository.id ||
    input.expectedPlanDigest !== source.provenance.planDigest ||
    digest(plan) !== input.expectedPlanDigest ||
    !same(
      {
        repository: source.repository,
        workItemId: source.workItemId,
        workItem: source.workItem,
        revision: source.revision,
        testedSourceRevision: source.testedSourceRevision,
      },
      {
        repository: plan.repository,
        workItemId: plan.workItemId,
        workItem: plan.workItem,
        revision: plan.revision,
        testedSourceRevision: plan.testedSourceRevision,
      },
    )
  )
    throw new TypeError("The reproduction source must match its retained historical plan.");
  if (plan.reproduction === undefined) return null;
  if (plan.schemaVersion === "ReviewRunExecutionPlanV1")
    validateFrozenIssueReproductionBinding(plan.reproduction, plan.jobs, {
      activationId: plan.activationId,
      repositoryId: plan.repository.id,
      githubRepositoryId: plan.repository.githubRepositoryId,
      workItemId: plan.workItemId,
      githubWorkItemId: plan.workItem.githubWorkItemId,
      workItemKind: plan.workItem.kind,
      issueRevisionKey: plan.revision.revisionKey,
      testedSourceRevision: plan.testedSourceRevision,
      testedSourceAuthorization: plan.testedSourceAuthorization,
    });
  const definition: EvaluationReproductionSourceDefinitionV1 = {
    schemaVersion: "EvaluationReproductionSourceDefinitionV1",
    repositoryId: input.repositoryId,
    sourceId: input.sourceId,
    sourceDigest: source.sourceDigest,
    reviewRunId: source.provenance.reviewRunId,
    planDigest: input.expectedPlanDigest,
    bindingDigest: plan.reproduction.bindingDigest,
    binding: plan.reproduction.binding,
  };
  evaluationReproductionSourceDefinitionDigest(definition);
  return frozenCopy(definition);
}
export function evaluationReproductionSourceDefinitionDigest(
  value: EvaluationReproductionSourceDefinitionV1,
): string {
  assertNoIssues(getEvaluationReproductionSourceDefinitionIssues(value));
  if (
    !same(canonicalBinding(value.binding), {
      binding: value.binding,
      bindingDigest: value.bindingDigest,
    })
  )
    throw new TypeError("The source reproduction binding digest is inconsistent.");
  return digest(value);
}
export function evaluationReproductionCellRecordDigest(
  value: EvaluationReproductionCellRecordV1,
): string {
  assertNoIssues(getEvaluationReproductionCellRecordIssues(value));
  if (
    value.reproduction !== null &&
    !same(canonicalBinding(value.reproduction.binding), value.reproduction)
  )
    throw new TypeError("The cell reproduction binding digest is inconsistent.");
  return digest(value);
}
export function evaluationReproductionManifestDigest(
  value: EvaluationReproductionManifestV1,
): string {
  assertNoIssues(getEvaluationReproductionManifestIssues(value));
  return digest(value);
}

export interface EvaluationReproductionBindingContext {
  readonly activationId: string;
  readonly requestId: string;
  readonly source: EvaluationSourceSnapshotV1;
  readonly profileVersion: ValidationProfileVersion;
  readonly actor: OperatorPrincipal;
  readonly authorizedAt: string;
}
export interface CreateEvaluationReproductionCellRecordInput {
  readonly evaluationId: string;
  readonly repositoryId: string;
  readonly caseId: string;
  readonly cellId: string;
  readonly arm: EvaluationArm;
  readonly sourceId: string;
  readonly applicable: boolean;
  readonly sourceDefinition: EvaluationReproductionSourceDefinitionV1 | null;
  readonly selection?: EvaluationReproductionMappingSelectionV1;
  readonly bindingContext: EvaluationReproductionBindingContext;
}
function observationKey(reference: ReproductionObservationRef): string {
  return reference.kind === "probe_value"
    ? canonical([reference.kind, reference.testStepId, reference.observationId])
    : canonical([reference.kind, reference.scenarioId, reference.stepId]);
}
function predicates(entry: FrozenIssueReproductionCase) {
  return [
    ...entry.presentWhen.allOf,
    ...(entry.absentWhen?.allOf ?? []),
    ...entry.preconditions.flatMap((condition) =>
      condition.kind === "observation_equals" ? [condition.predicate] : [],
    ),
  ];
}
function canonicalBinding(
  binding: FrozenIssueReproductionBinding["binding"],
): FrozenIssueReproductionBinding {
  const interpretation = canonicalizeIssueReproductionRequest({
    schemaVersion: "IssueReproductionRequestV1",
    claim: binding.claim,
    cases: binding.cases.map(
      ({
        requestId: _request,
        profileVersionId,
        profileConfigSha256: _digest,
        target: _target,
        ...entry
      }) => ({ ...entry, profileId: profileVersionId, expectedProfileVersionId: profileVersionId }),
    ),
  });
  const cases = interpretation.cases.map(
    ({ profileId: _profile, expectedProfileVersionId: _version, ...entry }) => {
      const original = binding.cases.find((candidate) => candidate.id === entry.id);
      if (!original)
        throw new TypeError("The reproduction case disappeared during canonicalization.");
      return { ...original, ...entry };
    },
  );
  const result = { ...binding, cases };
  return { binding: result, bindingDigest: digest(result) };
}

/** Builds before execution manifests exist; no provisional authorization or manifest hash is used. */
export function createEvaluationReproductionCellRecord(
  input: CreateEvaluationReproductionCellRecordInput,
): EvaluationReproductionCellRecordV1 {
  const { bindingContext: context, sourceDefinition: definition, selection } = input;
  const profile = context.profileVersion;
  assertSource(context.source);
  assertNoIssues(
    getEvaluationReproductionBindingContextIssues({
      activationId: context.activationId,
      requestId: context.requestId,
      profileVersion: profile,
      actor: context.actor,
      authorizedAt: context.authorizedAt,
    }),
  );
  if (
    typeof input.applicable !== "boolean" ||
    context.source.repository.id !== input.repositoryId ||
    profile.repositoryId !== input.repositoryId ||
    digest(profile.config) !== profile.configSha256 ||
    getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target).length ||
    context.actor.issuer.trim() !== context.actor.issuer ||
    context.actor.subject.trim() !== context.actor.subject ||
    context.actor.issuer.includes("\0") ||
    context.actor.subject.includes("\0") ||
    !Number.isFinite(Date.parse(context.authorizedAt)) ||
    Date.parse(context.authorizedAt) < Date.parse(context.source.provenance.capturedAt)
  )
    throw new TypeError(
      "The reproduction cell requires its actual source, published profile, and evaluation actor.",
    );
  const sourceDefinitionSha256 =
    definition === null ? null : evaluationReproductionSourceDefinitionDigest(definition);
  if (
    definition !== null &&
    (definition.repositoryId !== input.repositoryId ||
      definition.sourceId !== input.sourceId ||
      definition.sourceDigest !== context.source.sourceDigest ||
      context.source.provenance.kind !== "review_run" ||
      definition.reviewRunId !== context.source.provenance.reviewRunId ||
      definition.planDigest !== context.source.provenance.planDigest)
  )
    throw new TypeError("The reproduction definition belongs to another frozen source.");
  if (selection !== undefined) {
    assertNoIssues(getEvaluationReproductionMappingSelectionIssues(selection));
    if (
      definition === null ||
      selection.caseId !== input.caseId ||
      !same(selection.expectedSource, {
        reviewRunId: definition.reviewRunId,
        planDigest: definition.planDigest,
        bindingDigest: definition.bindingDigest,
      })
    )
      throw new TypeError(
        "The reproduction selection differs from its expected historical definition.",
      );
  }
  const record: EvaluationReproductionCellRecordV1 = {
    schemaVersion: "EvaluationReproductionCellRecordV1",
    evaluationId: input.evaluationId,
    repositoryId: input.repositoryId,
    caseId: input.caseId,
    cellId: input.cellId,
    arm: input.arm,
    sourceId: input.sourceId,
    sourceDefinitionSha256,
    selectedCaseIds: [...(selection?.selectedCaseIds ?? [])].sort(),
    mappings: selection?.[input.arm] ?? null,
    state: "not_applicable",
    blockers: [],
    reproduction: null,
  };
  const finish = () => {
    evaluationReproductionCellRecordDigest(record);
    return frozenCopy(record);
  };
  const blocked = (code: EvaluationReproductionBlockerV1["code"], message: string) => {
    record.state = "blocked";
    record.blockers = [{ code, message }];
    record.reproduction = null;
    return finish();
  };
  if (!input.applicable || definition === null) return finish();
  if (selection === undefined)
    return blocked(
      "mapping_missing",
      "The applicable source reproduction requires an explicit case selection and both arm mappings.",
    );
  const selected = definition.binding.cases.filter((entry) =>
    record.selectedCaseIds.includes(entry.id),
  );
  if (selected.length !== record.selectedCaseIds.length)
    return blocked("mapping_invalid", "The selection names an unknown source reproduction case.");
  const mappings = selection[input.arm];
  const observed = new Set(
    selected.flatMap(predicates).map((predicate) => observationKey(predicate.observation)),
  );
  const checks = new Set(
    selected.flatMap((entry) =>
      entry.preconditions.flatMap((condition) =>
        condition.kind === "check_passed" ? [condition.checkId] : [],
      ),
    ),
  );
  if (
    mappings.observationMappings.some((entry) => !observed.has(observationKey(entry.from))) ||
    mappings.checkMappings.some((entry) => !checks.has(entry.fromCheckId))
  )
    return blocked(
      "mapping_invalid",
      "The mapping contains references outside the selected reproduction cases.",
    );
  if (
    mappings.observationMappings.length !== observed.size ||
    mappings.checkMappings.length !== checks.size
  )
    return blocked(
      "mapping_missing",
      "Every selected reproduction observation and check precondition requires an explicit mapping.",
    );
  if (
    mappings.observationMappings.some((entry) => entry.to === null) ||
    mappings.checkMappings.some((entry) => entry.toCheckId === null)
  )
    return blocked(
      "mapping_unmapped",
      "A selected reproduction requirement is explicitly unmapped in this arm.",
    );
  const observationTargets = mappings.observationMappings.map((entry) =>
    entry.to === null ? "" : observationKey(entry.to),
  );
  const checkTargets = mappings.checkMappings.map((entry) => entry.toCheckId);
  if (
    new Set(observationTargets).size !== observationTargets.length ||
    new Set(checkTargets).size !== checkTargets.length
  )
    return blocked(
      "mapping_invalid",
      "Distinct source reproduction references cannot collapse into one target reference.",
    );
  const observationMap = new Map(
    mappings.observationMappings.map((entry) => [observationKey(entry.from), entry.to]),
  );
  const checkMap = new Map(
    mappings.checkMappings.map((entry) => [entry.fromCheckId, entry.toCheckId]),
  );
  const mapPredicate = (predicate: ReturnType<typeof predicates>[number]) => {
    const to = observationMap.get(observationKey(predicate.observation));
    if (to === null || to === undefined)
      throw new TypeError("The reproduction observation mapping is incomplete.");
    return { observation: to, equals: predicate.equals };
  };
  const tested = context.source.testedSourceRevision;
  if (
    profile.workflowKind !== "issue_validation" ||
    context.source.workItem.kind !== "issue" ||
    tested?.kind !== "commit"
  )
    return blocked(
      "profile_incompatible",
      "Mapped reproduction requires an Issue validation profile and its exact selected source commit.",
    );
  const cases = selected.map(
    (entry): FrozenIssueReproductionCase => ({
      ...entry,
      requestId: context.requestId,
      profileVersionId: profile.id,
      profileConfigSha256: profile.configSha256,
      target: profile.target,
      preconditions: entry.preconditions.map((condition) => {
        if (condition.kind === "observation_equals")
          return { kind: "observation_equals", predicate: mapPredicate(condition.predicate) };
        const checkId = checkMap.get(condition.checkId);
        if (checkId === null || checkId === undefined)
          throw new TypeError("The reproduction check mapping is incomplete.");
        return { kind: "check_passed", checkId };
      }),
      presentWhen: { allOf: entry.presentWhen.allOf.map(mapPredicate) },
      absentWhen:
        entry.absentWhen === null ? null : { allOf: entry.absentWhen.allOf.map(mapPredicate) },
    }),
  );
  let reproduction: FrozenIssueReproductionBinding;
  try {
    reproduction = canonicalBinding({
      ...definition.binding,
      activationId: context.activationId,
      repositoryId: input.repositoryId,
      githubRepositoryId: context.source.repository.githubRepositoryId,
      workItemId: context.source.workItemId,
      githubWorkItemId: context.source.workItem.githubWorkItemId,
      issueRevisionKey: context.source.revision.revisionKey,
      testedSourceCommit: tested.headSha,
      authorizedBy: { ...context.actor, authorizedAt: context.authorizedAt },
      cases,
    });
    validateFrozenIssueReproductionBinding(reproduction, [
      {
        requestId: context.requestId,
        workflowKind: profile.workflowKind,
        target: profile.target,
        profileVersion: profile,
      },
    ]);
  } catch (error) {
    if (error instanceof RangeError)
      return blocked(
        "result_too_large",
        "The complete mapped interpretation exceeds its retained document budget.",
      );
    return blocked(
      "profile_incompatible",
      "The mapped observations, types, preconditions, or UI evidence policy are incompatible with the published profile.",
    );
  }
  record.reproduction = reproduction;
  record.state = "ready";
  if (Buffer.byteLength(canonical(record), "utf8") > maximumEvaluationReproductionDocumentUtf8Bytes)
    return blocked(
      "result_too_large",
      "The complete mapped binding exceeds its retained document budget.",
    );
  return finish();
}

export function createEvaluationReproductionManifest(input: {
  readonly evaluationId: string;
  readonly repositoryId: string;
  readonly sources: readonly {
    readonly caseId: string;
    readonly definition: EvaluationReproductionSourceDefinitionV1;
  }[];
  readonly cells: readonly EvaluationReproductionCellRecordV1[];
}): EvaluationReproductionManifestV1 {
  const sources = input.sources
    .map(({ caseId, definition }) => {
      if (definition.repositoryId !== input.repositoryId)
        throw new TypeError("The reproduction source belongs to another repository.");
      return {
        caseId,
        sourceId: definition.sourceId,
        sourceDefinitionSha256: evaluationReproductionSourceDefinitionDigest(definition),
      };
    })
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const cells = input.cells
    .map((record) => {
      const source = sources.find((entry) => entry.caseId === record.caseId);
      if (
        record.evaluationId !== input.evaluationId ||
        record.repositoryId !== input.repositoryId ||
        (source === undefined
          ? record.sourceDefinitionSha256 !== null
          : record.sourceDefinitionSha256 !== source.sourceDefinitionSha256 ||
            record.sourceId !== source.sourceId)
      )
        throw new TypeError("The reproduction cell differs from its manifest source or scope.");
      return {
        cellId: record.cellId,
        caseId: record.caseId,
        arm: record.arm,
        cellRecordSha256: evaluationReproductionCellRecordDigest(record),
      };
    })
    .sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0));
  const manifest: EvaluationReproductionManifestV1 = {
    schemaVersion: "EvaluationReproductionManifestV1",
    evaluationId: input.evaluationId,
    repositoryId: input.repositoryId,
    sources,
    cells,
  };
  evaluationReproductionManifestDigest(manifest);
  return frozenCopy(manifest);
}
