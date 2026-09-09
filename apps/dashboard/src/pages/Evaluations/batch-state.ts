import * as C from "@agentic-review/contracts";
import type { EvaluationAdapter } from "@/services/evaluations";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";

export type Arm = "baseline" | "candidate";
export const arms = ["baseline", "candidate"] as const;
export const armLabels = { baseline: "Baseline", candidate: "Candidate" } as const;
export const nullCheckOption = "__explicit_null__";
export type CheckChoices = Record<string, Partial<Record<Arm, string | null>>>;
export const criterionKey = (caseId: string, criterionId: string) =>
  JSON.stringify([caseId, criterionId]);
export const permitsProfileOnly = (workflow: C.WorkflowKind) =>
  workflow === "pr_ui" || workflow === "issue_validation";

export function profileChecks(profile: C.ValidationProfileVersion) {
  return [
    ...profile.config.build.map((check) => ({ ...check, phase: "Build" })),
    ...profile.config.test.map((check) => ({ ...check, phase: "Test" })),
    ...(profile.config.ui?.scenarios ?? []).map((check) => ({ ...check, phase: "UI scenario" })),
  ].map((check) => ({
    value: `${profile.id}:${check.id}`,
    label: `${check.phase}: ${check.name} · ${check.id}`,
  }));
}

export function clearArmChoices(choices: CheckChoices, arm: Arm): CheckChoices {
  return Object.fromEntries(
    Object.entries(choices).map(([key, choice]) => {
      const updated = { ...choice };
      delete updated[arm];
      return [key, updated];
    }),
  );
}

export function assertProfileScope(
  profile: C.ValidationProfileVersion,
  version: C.EvaluationSuiteVersionV1,
) {
  if (
    profile.repositoryId !== version.repositoryId ||
    profile.workflowKind !== version.workflowKind ||
    profile.target !== version.target ||
    C.getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target).length
  )
    throw new ReviewControlProtocolError(
      "read evaluation profile",
      "The published profile does not match this suite's repository, workflow and target.",
    );
}

/** Load only frozen expectations and source summaries, with a complete aggregate budget. */
export async function loadFrozenCases(
  api: EvaluationAdapter,
  version: C.EvaluationSuiteVersionV1,
  signal?: AbortSignal,
): Promise<C.EvaluationSuiteCaseDetailV1[]> {
  const scope = {
    repositoryId: version.repositoryId,
    suiteId: version.suiteId,
    versionId: version.id,
  };
  const list = await api.listSuiteCases(scope, signal);
  const matchesManifest = (value: {
    sourceVersionId: string;
    expectationVersionId: string;
    sourceManifestSha256: string;
    expectationManifestSha256: string;
  }) =>
    value.sourceVersionId === version.sourceVersionId &&
    value.expectationVersionId === version.expectationVersionId &&
    value.sourceManifestSha256 === version.sourceManifestSha256 &&
    value.expectationManifestSha256 === version.expectationManifestSha256;
  if (!matchesManifest(list) || list.items.length !== version.caseCount)
    throw new ReviewControlProtocolError(
      "read evaluation expectations",
      "The case list does not match the selected published version.",
    );
  const result: C.EvaluationSuiteCaseDetailV1[] = [];
  let expectationBytes = 0;
  for (const item of list.items) {
    if (signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const detail = await api.getSuiteCase({ ...scope, caseId: item.caseId }, signal);
    if (
      !matchesManifest(detail) ||
      detail.source.id !== item.sourceId ||
      detail.source.sourceDigest !== item.sourceDigest ||
      detail.expectation.criteria.length !== item.criterionCount
    )
      throw new ReviewControlProtocolError(
        "read evaluation expectations",
        "A frozen case does not match its published manifest.",
      );
    expectationBytes += new TextEncoder().encode(JSON.stringify(detail.expectation)).byteLength;
    if (expectationBytes > C.maximumEvaluationSuiteUtf8Bytes)
      throw new ReviewControlProtocolError(
        "read evaluation expectations",
        "The frozen expectations exceed the aggregate suite byte limit.",
      );
    result.push(detail);
  }
  return result;
}

export function createBatchRequest(input: {
  changeId: string;
  version: C.EvaluationSuiteVersionV1;
  cases: C.EvaluationSuiteCaseDetailV1[];
  profiles: Record<Arm, C.ValidationProfileVersion>;
  prompts: Record<Arm, C.EvaluationPromptOptionV1>;
  mode: C.EvaluationBatchMode;
  choices: CheckChoices;
  reproductionMappings?: C.EvaluationReproductionMappingSelectionV1[];
}): C.EvaluationBatchCreateRequest {
  const reject = (message: string): never => {
    throw new ReviewControlRequestError("create evaluation batch", "configuration", message);
  };
  if (input.mode === "profile_only" && !permitsProfileOnly(input.version.workflowKind))
    reject("Static review and Issue triage require Prompt and profile mode.");
  if (
    input.cases.length !== input.version.caseCount ||
    new Set(input.cases.map((entry) => entry.caseId)).size !== input.cases.length
  )
    reject("Load every frozen case before creating a batch.");
  const checks = { baseline: new Set<string>(), candidate: new Set<string>() };
  for (const arm of arms) {
    assertProfileScope(input.profiles[arm], input.version);
    if (
      input.prompts[arm].outputSchemaVersion !==
      C.WorkflowOutputSchemaVersions[input.version.workflowKind]
    )
      reject("Select a repository-visible Prompt for this workflow.");
    checks[arm] = new Set(profileChecks(input.profiles[arm]).map((check) => check.value));
  }
  const checkMappings = input.cases.flatMap((entry) => {
    if (
      entry.repositoryId !== input.version.repositoryId ||
      entry.suiteId !== input.version.suiteId ||
      entry.versionId !== input.version.id
    )
      reject("The selected cases belong to another published version.");
    return entry.expectation.criteria.map((criterion) => {
      const choice = input.choices[criterionKey(entry.caseId, criterion.criterionId)];
      for (const arm of arms) {
        if (choice?.[arm] === undefined)
          reject(
            "Choose a check or an explicit no-check mapping for every criterion and both arms.",
          );
        const selected = choice?.[arm];
        if (typeof selected === "string" && !checks[arm].has(selected))
          reject("A selected check is absent from its exact published profile version.");
      }
      return {
        caseId: entry.caseId,
        criterionId: criterion.criterionId,
        baselineCheckId: choice?.baseline ?? null,
        candidateCheckId: choice?.candidate ?? null,
      };
    });
  });
  const request: C.EvaluationBatchCreateRequest = {
    changeId: input.changeId,
    suiteId: input.version.suiteId,
    suiteVersionId: input.version.id,
    baseline: {
      profileVersionId: input.profiles.baseline.id,
      promptVersionId: input.prompts.baseline.id,
    },
    candidate: {
      profileVersionId: input.profiles.candidate.id,
      promptVersionId: input.prompts.candidate.id,
    },
    mode: input.mode,
    checkMappings,
    ...(input.reproductionMappings === undefined
      ? {}
      : { reproductionMappings: structuredClone(input.reproductionMappings) }),
  };
  const issues = C.getEvaluationBatchCreateRequestIssues(request);
  if (issues.length) reject(issues[0] ?? "The batch request is invalid.");
  return request;
}

export const executionLabels: Record<
  C.EvaluationCellExecutionState | C.EvaluationBatchStatus,
  string
> = {
  pending: "Pending dispatch",
  not_run: "Not run",
  awaiting_admission: "Awaiting admission",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  cancelling: "Cancelling — active work remains",
  invalid: "Invalid",
};

export function assertBatchReadScope(
  detail: C.EvaluationBatchDetailV1,
  matrix: C.EvaluationBatchMatrixV1,
  scope: { suiteId: string; workflowKind: C.WorkflowKind; target: C.ValidationTarget },
) {
  if (
    detail.summary.suiteId !== scope.suiteId ||
    detail.summary.workflowKind !== scope.workflowKind ||
    detail.summary.target !== scope.target ||
    matrix.evaluationId !== detail.summary.id ||
    matrix.repositoryId !== detail.summary.repositoryId ||
    matrix.suiteVersionId !== detail.summary.suiteVersionId ||
    matrix.cases.length !== detail.summary.caseCount
  )
    throw new ReviewControlProtocolError(
      "read evaluation batch",
      "The batch and matrix do not belong to this exact suite, workflow and version.",
    );
  const kind =
    scope.workflowKind === "pr_static_build" || scope.workflowKind === "pr_ui"
      ? "pull_request"
      : "issue";
  for (const entry of matrix.cases) {
    if (
      entry.source.workItemKind !== kind ||
      arms.some(
        (arm) =>
          entry[arm].profileVersionId !== detail.summary[arm].profileVersionId ||
          entry[arm].promptVersionId !== detail.summary[arm].promptVersionId,
      )
    )
      throw new ReviewControlProtocolError(
        "read evaluation batch",
        "The matrix source or arm configuration differs from the frozen batch.",
      );
  }
}
