import type * as C from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { DataTable, DetailsGrid } from "@/components/ui";
import {
  createHttpEvaluationAssessmentAdapter,
  type EvaluationAssessmentAdapter,
} from "@/services/evaluation-assessments";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
} from "@/services/review-control/errors";
import { armLabels, arms } from "./batch-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CopyValue, EvaluationTable } from "./Display";
import { accessDenied, errorMessage, newIdentity, OriginalMutation } from "./state";
export function assessmentRatioLabel(ratio: C.EvaluationRatio): string {
  return ratio.value === null || ratio.denominator === 0
    ? `Not evaluable (${ratio.numerator}/${ratio.denominator})`
    : `${(ratio.value * 100).toFixed(1)}% (${ratio.numerator}/${ratio.denominator})`;
}
export const assessmentReportPageSizes = [1, 5, 10, 20, 50] as const;
export function changeAssessmentReportPageSize(pageSize: number): {
  page: number;
  pageSize: number;
} {
  if (!assessmentReportPageSizes.some((value) => value === pageSize))
    throw new RangeError("Choose a supported report page size.");
  return {
    page: 1,
    pageSize,
  };
}
export function isAssessmentReportPageTooLarge(error: unknown): boolean {
  return (
    error instanceof ReviewControlHttpError &&
    error.status === 400 &&
    error.serverCode === "evaluation_report_page_too_large"
  );
}
const readableState = (value: string) => value.replaceAll("_", " ");
export function assessmentMatrixStamp(matrix: C.EvaluationBatchMatrixV1): string {
  return JSON.stringify([
    matrix.evaluationId,
    matrix.status,
    matrix.progress,
    matrix.cases.map((entry) => [
      entry.caseId,
      entry.source.sourceDigest,
      ...arms.map((arm) => {
        const cell = entry[arm];
        return [cell.cellId, cell.state, cell.result, cell.job, cell.blockers];
      }),
    ]),
  ]);
}
interface PreviewState {
  value: C.EvaluationScorePreviewV1 | null;
  busy: boolean;
  error: string | null;
  calculation: number;
}
/** Preview reads are exclusively user-triggered. Query invalidation and polling never call this owner. */
export class ManualAssessmentPreview {
  #state: PreviewState = {
    value: null,
    busy: false,
    error: null,
    calculation: 0,
  };
  #listeners = new Set<() => void>();
  #controller: AbortController | null = null;
  #generation = 0;
  #disposed = false;
  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #set(value: PreviewState) {
    this.#state = value;
    for (const listener of this.#listeners) listener();
  }
  activate() {
    this.#disposed = false;
  }
  pause() {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
    if (this.#state.busy)
      this.#set({
        ...this.#state,
        busy: false,
      });
  }
  invalidate() {
    this.pause();
    this.#set({
      ...this.#state,
      value: null,
      error: null,
    });
  }
  dispose() {
    this.#disposed = true;
    this.invalidate();
    this.#listeners.clear();
  }
  async calculate(
    load: (signal: AbortSignal) => Promise<C.EvaluationScorePreviewV1>,
    denied: () => void,
  ): Promise<void> {
    if (this.#disposed || this.#state.busy) return;
    const generation = ++this.#generation,
      controller = new AbortController();
    this.#controller = controller;
    this.#set({
      ...this.#state,
      value: null,
      busy: true,
      error: null,
    });
    try {
      const value = await load(controller.signal);
      if (this.#disposed || generation !== this.#generation || controller.signal.aborted) return;
      this.#set({
        value,
        busy: false,
        error: null,
        calculation: this.#state.calculation + 1,
      });
    } catch (error) {
      if (this.#disposed || generation !== this.#generation || controller.signal.aborted) return;
      this.#set({
        ...this.#state,
        value: null,
        busy: false,
        error: errorMessage(error),
      });
      if (accessDenied(error)) denied();
    } finally {
      if (generation === this.#generation) this.#controller = null;
    }
  }
}
export function AssessmentSummary({ summary }: { summary: C.EvaluationScoringSummaryV1 }) {
  const rows: {
    name: string;
    baseline: string;
    candidate: string;
  }[] = [];
  const add = (name: string, read: (aggregate: C.EvaluationArmAggregate) => string | number) =>
    rows.push({
      name,
      baseline: String(read(summary.baseline)),
      candidate: String(read(summary.candidate)),
    });
  add("Execution coverage", (arm) => assessmentRatioLabel(arm.coverage.execution));
  add(
    "Applicable / not applicable cases",
    (arm) => `${arm.coverage.applicableCases} / ${arm.coverage.notApplicableCases}`,
  );
  add(
    "Completed / pending / not run",
    (arm) =>
      `${arm.coverage.completedCases} / ${arm.coverage.pendingCases} / ${arm.coverage.notRunCases}`,
  );
  add(
    "Failed / blocked / cancelled / invalid",
    (arm) =>
      `${arm.coverage.failedCases} / ${arm.coverage.blockedCases} / ${arm.coverage.cancelledCases} / ${arm.coverage.invalidCases}`,
  );
  add("Check coverage", (arm) => assessmentRatioLabel(arm.coverage.checks));
  add(
    "Scored / unmapped / unavailable / not run criteria",
    (arm) =>
      `${arm.coverage.scoredCriteria} / ${arm.coverage.unmappedCriteria} / ${arm.coverage.unavailableCriteria} / ${arm.coverage.notRunCriteria}`,
  );
  add("Not applicable criteria", (arm) => arm.coverage.notApplicableCriteria);
  add("Model coverage", (arm) => assessmentRatioLabel(arm.coverage.models));
  add("Available models", (arm) => arm.coverage.availableModels);
  add(
    "Complete / partial / unlabeled cases",
    (arm) =>
      `${arm.coverage.completeAnnotationCases} / ${arm.coverage.partialAnnotationCases} / ${arm.coverage.unlabeledCases}`,
  );
  add("Check agreement", (arm) => assessmentRatioLabel(arm.quality.checkAgreement));
  add(
    "Correct / incorrect checks",
    (arm) => `${arm.quality.correctChecks} / ${arm.quality.incorrectChecks}`,
  );
  add(
    "True positives / false positives / false negatives",
    (arm) =>
      `${arm.quality.truePositives} / ${arm.quality.falsePositives} / ${arm.quality.falseNegatives}`,
  );
  add(
    "Duplicate / unjudged / unresolved expected findings",
    (arm) =>
      `${arm.quality.duplicates} / ${arm.quality.unjudged} / ${arm.quality.unresolvedExpected}`,
  );
  add("Known-positive recall", (arm) => assessmentRatioLabel(arm.quality.knownPositiveRecall));
  add("Finding precision", (arm) => assessmentRatioLabel(arm.quality.precision));
  add("Finding recall", (arm) => assessmentRatioLabel(arm.quality.recall));
  return (
    <div className="evaluation-cell-result">
      <Typography component="p" variant="body2" color={"text.secondary"}>
        Coverage describes what could be assessed. Unknown model output, unavailable evidence and
        unjudged findings do not become correct results. A zero denominator is not evaluable.
      </Typography>
      {summary.baseline.quality.provisional || summary.candidate.quality.provisional ? (
        <Alert severity={"info"}>
          <AlertTitle>{"Finding assessment is provisional"}</AlertTitle>
          {"Review the unjudged and unresolved counts before interpreting quality ratios."}
        </Alert>
      ) : null}
      <DataTable
        rows={rows}
        getRowId={(row) => row.name}
        columns={[
          {
            id: "name",
            label: "Measure",
            render: (row) => row.name,
          },
          {
            id: "baseline",
            label: "Baseline",
            render: (row) => row.baseline,
          },
          {
            id: "candidate",
            label: "Candidate",
            render: (row) => row.candidate,
          },
        ]}
        ariaLabel="Evaluation records"
      />
      <Typography component="h5" variant="subtitle1">
        Paired changes
      </Typography>
      <DataTable
        rows={(["criteria", "findings"] as const).map((name) => ({
          name,
          ...summary.paired[name],
        }))}
        getRowId={(row) => row.name}
        columns={[
          {
            id: "name",
            label: "Comparison",
            render: (row) => row.name,
          },
          {
            id: "coverage",
            label: "Coverage",
            render: (item) => {
              return assessmentRatioLabel(item.coverage);
            },
          },
          {
            id: "quality",
            label: "Improved / regressed / unchanged",
            render: (item) => {
              return `${item.improved} / ${item.regressed} / ${item.unchanged}`;
            },
          },
          {
            id: "coverageChange",
            label: "Coverage improved / regressed",
            render: (item) => {
              return `${item.coverageImproved} / ${item.coverageRegressed}`;
            },
          },
          {
            id: "unavailable",
            label: "Unavailable / not applicable",
            render: (item) => {
              return `${item.unavailable} / ${item.notApplicable}`;
            },
          },
        ]}
        ariaLabel="Evaluation records"
      />
    </div>
  );
}
export function assertAssessmentCaseReport(
  value: C.EvaluationAssessmentCaseV1,
  report: C.EvaluationAssessmentSummaryV1,
): void {
  if (
    value.scope.repositoryId !== report.repositoryId ||
    value.scope.evaluationId !== report.evaluationId ||
    value.scope.assessmentId !== report.assessmentId ||
    !report.caseIds.includes(value.scope.caseId) ||
    value.reportDigest !== report.reportDigest ||
    value.scoringPlanDigest !== report.scoringPlanDigest
  )
    throw new ReviewControlProtocolError(
      "read assessment case",
      "The case does not match this saved report and its frozen scoring plan.",
    );
}
export function currentAssessmentResult(
  matrix: C.EvaluationBatchMatrixV1 | undefined,
  arm: C.EvaluationArmCaseAssessment,
): C.EvaluationCellSummaryV1 | null {
  const result = arm.result;
  if (!matrix || !result) return null;
  for (const entry of matrix.cases)
    for (const side of arms) {
      const cell = entry[side];
      if (
        cell.cellId === arm.cellId &&
        cell.runId === arm.runId &&
        cell.requestId === arm.requestId &&
        cell.result?.resultId === result.resultId &&
        cell.result.resultDigest === result.resultDigest &&
        cell.result.runAttemptId === result.runAttemptId &&
        cell.job?.jobId === result.jobId &&
        cell.sourceDigest === result.sourceDigest &&
        cell.profileVersionId === result.profileVersionId &&
        cell.promptVersionId === result.promptVersionId
      )
        return cell;
    }
  return null;
}
export function AssessmentCase({
  value,
  matrix,
  onViewResult,
}: {
  value: C.EvaluationAssessmentCaseV1;
  matrix?: C.EvaluationBatchMatrixV1;
  onViewResult?: (cell: C.EvaluationCellSummaryV1) => void;
}) {
  const score = value.case,
    expectation = value.expectation;
  return (
    <Card variant="outlined">
      <CardHeader
        title={value.caseTitle}
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1,
          }}
        >
          <Chip label={score.applicable ? "Applicable" : "Not applicable"} />
          <Typography component="span" variant="body2" color={"text.secondary"}>
            {score.caseId}
          </Typography>
        </Stack>
        {expectation.applicability.state === "not_applicable" ? (
          <p>{expectation.applicability.reason}</p>
        ) : null}
        <p className="evaluation-meta">
          Frozen source digest {expectation.sourceDigest}. This saved assessment does not reverify
          live evidence.
        </p>
        <div className="evaluation-arm-grid">
          {arms.map((arm) => {
            const assessment = score[arm],
              current = currentAssessmentResult(matrix, assessment);
            return (
              <Card key={arm} variant="elevation" elevation={0} className="evaluation-tonal-card">
                <CardHeader
                  title={armLabels[arm]}
                  slotProps={{
                    title: {
                      variant: "subtitle1",
                      component: "h3",
                    },
                  }}
                />
                <CardContent>
                  <Chip label={readableState(assessment.executionState)} />
                  {assessment.executionReason ? <p>{assessment.executionReason}</p> : null}
                  <span className="evaluation-meta">Run {assessment.runId}</span>
                  {assessment.result ? (
                    <>
                      <span className="evaluation-meta">
                        Recorded result {assessment.result.resultId} · attempt{" "}
                        {assessment.result.runAttemptId}
                      </span>
                      {current && onViewResult ? (
                        <Button onClick={() => onViewResult(current)} variant="outlined">
                          View current result
                        </Button>
                      ) : (
                        <span className="evaluation-meta">
                          Recorded identity only; no current result link is assumed.
                        </span>
                      )}
                    </>
                  ) : (
                    <p>No result was available for this saved assessment.</p>
                  )}
                  <p>Model findings: {readableState(assessment.findings.state)}</p>
                  {assessment.findings.reason ? <p>{assessment.findings.reason}</p> : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <Typography component="h5" variant="subtitle1">
          Frozen criteria and observed outcomes
        </Typography>
        <DataTable
          rows={expectation.criteria}
          getRowId={(row) => row.criterionId}
          columns={[
            {
              id: "expected",
              label: "Expected criterion",
              render: (criterion) => {
                return (
                  <div>
                    <strong>{criterion.description}</strong>
                    <span className="evaluation-meta">
                      {criterion.criterionId} · expected {criterion.expectedOutcome} ·{" "}
                      {readableState(criterion.applicability.state)}
                    </span>
                    {criterion.applicability.state === "not_applicable" ? (
                      <p>{criterion.applicability.reason}</p>
                    ) : null}
                  </div>
                );
              },
            },
            ...arms.map((arm) => ({
              id: arm,
              label: armLabels[arm],
              render: (criterion: C.EvaluationCaseExpectation["criteria"][number]) => {
                const actual = score[arm].criteria.find(
                  (item) => item.criterionId === criterion.criterionId,
                );
                return (
                  <div>
                    <Chip label={actual ? readableState(actual.state) : "Unavailable"} />
                    <p>Actual: {actual?.actualOutcome ?? "Not available"}</p>
                    <span className="evaluation-meta">{actual?.checkId ?? "Unmapped"}</span>
                    {actual?.reason ? <p>{actual.reason}</p> : null}
                  </div>
                );
              },
            })),
            {
              id: "paired",
              label: "Paired change",
              render: (criterion) => {
                return readableState(
                  score.paired.criteria.find((item) => item.criterionId === criterion.criterionId)
                    ?.change ?? "unavailable",
                );
              },
            },
          ]}
          ariaLabel="Evaluation records"
        />
        <Typography component="h5" variant="subtitle1">
          Frozen finding expectations
        </Typography>
        <Chip label={expectation.findings.annotation} />
        <p>
          {expectation.findings.annotation === "unlabeled"
            ? "Unlabeled findings are not negative examples."
            : expectation.findings.annotation === "partial"
              ? "Only the listed known positives are labeled."
              : expectation.findings.expected.length === 0
                ? "Complete labels declare no expected findings."
                : "These are the complete expected finding labels."}
        </p>
        <DataTable
          rows={expectation.findings.expected}
          getRowId={(row) => row.expectedFindingId}
          columns={[
            {
              id: "expected",
              label: "Expected finding",
              render: (finding) => {
                return (
                  <div>
                    {finding.description}
                    <span className="evaluation-meta">{finding.expectedFindingId}</span>
                  </div>
                );
              },
            },
            ...arms.map((arm) => ({
              id: arm,
              label: armLabels[arm],
              render: (expected: C.EvaluationCaseExpectation["findings"]["expected"][number]) => {
                const finding = score[arm].findings.expected.find(
                  (item) => item.expectedFindingId === expected.expectedFindingId,
                );
                return (
                  <div>
                    {readableState(finding?.state ?? "unresolved")}
                    <span className="evaluation-meta">
                      {finding?.occurrenceKey ?? "No matched occurrence"}
                    </span>
                  </div>
                );
              },
            })),
            {
              id: "paired",
              label: "Paired change",
              render: (expected) => {
                return readableState(
                  score.paired.findings.find(
                    (item) => item.expectedFindingId === expected.expectedFindingId,
                  )?.change ?? "unavailable",
                );
              },
            },
          ]}
          ariaLabel="Evaluation records"
        />
        <div className="evaluation-arm-grid">
          {arms.map((arm) => {
            const findings = score[arm].findings;
            return (
              <Card key={arm} variant="elevation" elevation={0} className="evaluation-tonal-card">
                <CardHeader
                  title={`${armLabels[arm]} finding assessment`}
                  slotProps={{
                    title: {
                      variant: "subtitle1",
                      component: "h3",
                    },
                  }}
                />
                <CardContent>
                  <p>
                    True positives {findings.truePositives} · false positives{" "}
                    {findings.falsePositives} · false negatives {findings.falseNegatives}
                  </p>
                  <p>
                    Duplicates {findings.duplicates} · unjudged {findings.unjudged} · unresolved{" "}
                    {findings.unresolvedExpected}
                  </p>
                  <p>
                    Precision: {assessmentRatioLabel(findings.precision)}
                    <br />
                    Recall: {assessmentRatioLabel(findings.recall)}
                    <br />
                    Known-positive recall: {assessmentRatioLabel(findings.knownPositiveRecall)}
                  </p>
                  <EvaluationTable
                    rows={findings.occurrences}
                    getRowId={(row) => row.occurrenceKey}
                    columns={[
                      {
                        id: "key",
                        label: "Occurrence",
                        render: (row) => {
                          const key: string = row.occurrenceKey;
                          return <span className="evaluation-meta">{key}</span>;
                        },
                      },
                      {
                        id: "kind",
                        label: "Judgment",
                        render: (row) => row.kind,
                      },
                    ]}
                    ariaLabel="Evaluation records"
                    pageSize={10}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p>
          Paired model coverage: {readableState(score.paired.modelCoverage)} · false-positive delta:{" "}
          {score.paired.falsePositiveDelta ?? "Not evaluable"} · duplicate delta:{" "}
          {score.paired.duplicateDelta ?? "Not evaluable"}
        </p>
      </CardContent>
    </Card>
  );
}
interface SaveIntent {
  scope: C.EvaluationAssessmentScope;
  request: C.EvaluationAssessmentPublishRequest;
  preview: C.EvaluationScorePreviewV1;
  calculation: number;
}
export function assessmentSaveIntent(
  scope: C.EvaluationAssessmentScope,
  preview: C.EvaluationScorePreviewV1,
  calculation: number,
  changeId: string,
): SaveIntent {
  if (scope.repositoryId !== preview.repositoryId || scope.evaluationId !== preview.evaluationId)
    throw new ReviewControlProtocolError(
      "save evaluation report",
      "The selected preview belongs to another batch.",
    );
  return {
    scope: structuredClone(scope),
    preview: structuredClone(preview),
    calculation,
    request: {
      changeId,
      expectedVersion: preview.assessmentVersion,
      expectedInputDigest: preview.inputDigest,
    },
  };
}
function canonicalSummary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSummary);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalSummary(entry)]),
    );
  return value;
}
export function assertAssessmentPreviewReceipt(
  value: C.EvaluationAssessmentSummaryV1,
  preview: C.EvaluationScorePreviewV1,
): void {
  if (
    value.repositoryId !== preview.repositoryId ||
    value.evaluationId !== preview.evaluationId ||
    value.scoringPlanDigest !== preview.scoringPlanDigest ||
    value.observationDigest !== preview.observationDigest ||
    value.adjudicationDigest !== preview.adjudicationDigest ||
    value.summary.rulesVersion !== preview.summary.rulesVersion ||
    JSON.stringify([...value.caseIds].sort()) !== JSON.stringify([...preview.caseIds].sort()) ||
    JSON.stringify(canonicalSummary(value.summary)) !==
      JSON.stringify(canonicalSummary(preview.summary))
  )
    throw new ReviewControlProtocolError(
      "save evaluation report",
      "The saved report does not match the confirmed preview inputs and summary.",
    );
}
export function AssessmentReports({
  evaluationId,
  matrix,
  active,
  onPendingChange,
  onViewResult,
  adapter: providedAdapter,
}: {
  evaluationId: string;
  matrix?: C.EvaluationBatchMatrixV1;
  active: boolean;
  onPendingChange: (pending: boolean) => void;
  onViewResult?: (cell: C.EvaluationCellSummaryV1) => void;
  adapter?: EvaluationAssessmentAdapter;
}) {
  const page = useEvaluationPage(),
    access = useOperatorAccess(page.repositoryId);
  const adapter = useMemo(
    () => providedAdapter ?? createHttpEvaluationAssessmentAdapter(),
    [providedAdapter],
  );
  const scope = {
      repositoryId: page.repositoryId,
      evaluationId,
    },
    scopeKey = JSON.stringify(scope);
  const previewOwner = useMemo(() => new ManualAssessmentPreview(), []),
    saveOwner = useMemo(() => new OriginalMutation<SaveIntent>(), []);
  const preview = useSyncExternalStore(
      previewOwner.subscribe,
      previewOwner.snapshot,
      previewOwner.snapshot,
    ),
    mutation = useSyncExternalStore(saveOwner.subscribe, saveOwner.snapshot, saveOwner.snapshot);
  useEffect(() => {
    previewOwner.activate();
    saveOwner.activate();
    return () => {
      previewOwner.dispose();
      saveOwner.dispose();
    };
  }, [previewOwner, saveOwner]);
  useEffect(() => {
    if (!active || !page.readable) previewOwner.pause();
  }, [active, page.readable, previewOwner]);
  const stamp = matrix ? assessmentMatrixStamp(matrix) : undefined,
    previousStamp = useRef(stamp);
  const [stale, setStale] = useState(false),
    [lastAttempt, setLastAttempt] = useState<SaveIntent | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (stamp === undefined) return;
    if (previousStamp.current !== undefined && stamp !== previousStamp.current) {
      previewOwner.invalidate();
      setStale(true);
    }
    previousStamp.current = stamp;
  }, [stamp, previewOwner]);
  const [listPagination, setListPagination] = useState({
      page: 1,
      pageSize: 20,
    }),
    [selected, setSelected] = useState<string | null>(null),
    [caseId, setCaseId] = useState<string | null>(null);
  const pending = mutation.busy || mutation.request !== null;
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  const reviewer =
    access.ready &&
    !access.checking &&
    !access.pending &&
    !access.error &&
    access.principal?.issuer === page.principal.issuer &&
    access.principal?.subject === page.principal.subject &&
    access.can("review");
  const canSave = active && page.readable && reviewer;
  const list = useEvaluationQuery(
    ["assessment-list", scopeKey, listPagination.page, listPagination.pageSize],
    (signal) => adapter.list(scope, listPagination, signal),
    active,
  );
  const report = useEvaluationQuery(
    ["assessment", scopeKey, selected],
    (signal) =>
      adapter.get(
        {
          ...scope,
          assessmentId: selected ?? "",
        },
        signal,
      ),
    active && selected !== null,
  );
  const caseDetail = useEvaluationQuery(
    ["assessment-case", scopeKey, selected, caseId],
    async (signal) => {
      if (!report.data) throw new Error("Load the saved report before selecting a case.");
      const value = await adapter.getCase(
        {
          ...scope,
          assessmentId: selected ?? "",
          caseId: caseId ?? "",
        },
        signal,
      );
      assertAssessmentCaseReport(value, report.data);
      return value;
    },
    active && selected !== null && caseId !== null && report.data !== undefined,
  );
  const calculate = () => {
    if (!active || !page.readable || pending || preview.busy) return;
    setStale(false);
    setNotice(null);
    void previewOwner.calculate(async (signal) => {
      const value = await adapter.preview(scope, signal);
      if (
        matrix &&
        (value.caseIds.length !== matrix.cases.length ||
          value.caseIds.some((id) => !matrix.cases.some((entry) => entry.caseId === id)))
      )
        throw new ReviewControlProtocolError(
          "calculate evaluation preview",
          "The preview does not include this batch's complete frozen case set.",
        );
      return value;
    }, page.invalidateAccess);
  };
  const execute = async (intent: SaveIntent) => {
    const value = await adapter.save(intent.scope, intent.request, page.principal);
    assertAssessmentPreviewReceipt(value, intent.preview);
    return value;
  };
  const success = (value: C.EvaluationAssessmentSummaryV1) => {
    setSelected(value.assessmentId);
    setCaseId(null);
    setLastAttempt(null);
    previewOwner.invalidate();
    setNotice(`Report version ${value.version} saved. This is an internal immutable report.`);
    void list.refetch();
  };
  const save = () => {
    if (
      !canSave ||
      pending ||
      mutation.conflict ||
      !preview.value ||
      preview.busy ||
      preview.value.assessmentVersion >= Number.MAX_SAFE_INTEGER
    )
      return;
    const intent = assessmentSaveIntent(scope, preview.value, preview.calculation, newIdentity());
    setLastAttempt(intent);
    void saveOwner.run(intent, execute, success, page.invalidateAccess);
  };
  const retry = () => {
    if (canSave && mutation.request)
      void saveOwner.run(mutation.request, execute, success, page.invalidateAccess);
  };
  const shownPreview = mutation.request?.preview ?? preview.value;
  return (
    <Card
      hidden={!active || !page.readable}
      inert={!active || !page.readable}
      variant="elevation"
      elevation={0}
      className="evaluation-section-card"
    >
      <CardHeader
        title={"Assessment reports"}
        action={
          <Button
            disabled={!active || !page.readable}
            loading={list.isFetching}
            onClick={() => void list.refetch()}
            variant="outlined"
          >
            Refresh reports
          </Button>
        }
        slotProps={{
          title: {
            variant: "subtitle1",
            component: "h3",
          },
        }}
      />
      <CardContent>
        <Typography component="p" variant="body2" color={"text.secondary"}>
          Saved reports preserve the observations, evidence assessment and human judgments used at
          that time. They do not represent live evidence or an approval decision.
        </Typography>
        {list.error || report.error || caseDetail.error ? (
          <Alert severity={"error"}>
            <AlertTitle>
              {isAssessmentReportPageTooLarge(list.error)
                ? "Report page is too large"
                : "Report data unavailable"}
            </AlertTitle>
            {isAssessmentReportPageTooLarge(list.error)
              ? "Choose a smaller page size to load these reports"
              : errorMessage(list.error ?? report.error ?? caseDetail.error)}
          </Alert>
        ) : null}
        <Stack
          style={{
            marginBlock: 12,
          }}
          direction="row"
          spacing={1.5}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1,
          }}
        >
          <Typography component="span" variant="body2">
            Reports per page
          </Typography>
          <Autocomplete
            style={{
              minWidth: 120,
            }}
            disabled={!active || !page.readable}
            options={assessmentReportPageSizes.map((value) => ({
              value,
              label: String(value),
            }))}
            disablePortal
            fullWidth
            value={
              assessmentReportPageSizes
                .map((value) => ({
                  value,
                  label: String(value),
                }))
                .find((option) => option.value === listPagination.pageSize) ??
              (listPagination.pageSize == null || String(listPagination.pageSize) === ""
                ? null
                : {
                    value: listPagination.pageSize as NonNullable<
                      NonNullable<typeof listPagination>["pageSize"]
                    >,
                    label: String(listPagination.pageSize),
                  })
            }
            onChange={(_event, option) => {
              if (option !== null)
                ((value) => setListPagination(changeAssessmentReportPageSize(value)))(
                  option.value as NonNullable<NonNullable<typeof listPagination>["pageSize"]>,
                );
            }}
            getOptionLabel={(option) => option.label}
            isOptionEqualToValue={(option, selected) => option.value === selected.value}
            getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
            renderInput={(params) => (
              <TextField
                {...params}
                label={"Reports per page"}
                slotProps={{
                  ...params.slotProps,
                  htmlInput: {
                    ...params.slotProps.htmlInput,
                    "aria-label": "Reports per page",
                  },
                }}
              />
            )}
            disableClearable={Boolean(listPagination.pageSize)}
            getOptionKey={(option) => option.value}
          />
        </Stack>
        <DataTable<C.EvaluationAssessmentSummaryV1>
          loading={active && list.isPending}
          rows={list.data?.items ?? []}
          getRowId={(row) => row.assessmentId}
          columns={[
            {
              id: "report",
              label: "Report",
              render: (item) => {
                return (
                  <Button
                    disabled={pending || !active || !page.readable}
                    onClick={() => {
                      setSelected(item.assessmentId);
                      setCaseId(null);
                    }}
                    variant="text"
                  >
                    Version {item.version}
                  </Button>
                );
              },
            },
            {
              id: "created",
              label: "Saved",
              render: (row) => row.createdAt,
            },
            {
              id: "rules",
              label: "Scoring rules",
              render: (row) => row.scorerVersion,
            },
          ]}
          ariaLabel="Evaluation records"
          pagination={{
            page: listPagination.page,
            pageSize: listPagination.pageSize,
            total: list.data?.total ?? 0,
            onChange: (page) =>
              setListPagination((previous) => ({
                ...previous,
                page,
              })),
          }}
        />
        {report.data && !report.isFetching ? (
          <Card variant="elevation" elevation={0} className="evaluation-section-card">
            <CardHeader
              title={`Saved report · version ${report.data.version}`}
              slotProps={{
                title: {
                  variant: "subtitle1",
                  component: "h3",
                },
              }}
            />
            <CardContent>
              <DetailsGrid
                items={[
                  {
                    key: "saved",
                    label: "Saved by",
                    value: `${report.data.createdBy.issuer} · ${report.data.createdBy.subject} · ${report.data.createdAt}`,
                  },
                  {
                    key: "digest",
                    label: "Report digest",
                    value: <CopyValue value={report.data.reportDigest} />,
                  },
                ]}
                columns={1}
              />
              <AssessmentSummary summary={report.data.summary} />
              <Autocomplete
                disabled={!active || !page.readable}
                style={{
                  width: "100%",
                  marginBlock: 16,
                }}
                options={report.data.caseIds.map((id) => ({
                  value: id,
                  label: matrix?.cases.find((entry) => entry.caseId === id)?.title ?? id,
                }))}
                disablePortal
                fullWidth
                value={
                  report.data.caseIds
                    .map((id) => ({
                      value: id,
                      label: matrix?.cases.find((entry) => entry.caseId === id)?.title ?? id,
                    }))
                    .find((option) => option.value === (caseId ?? undefined)) ??
                  ((caseId ?? undefined) == null || String(caseId ?? undefined) === ""
                    ? null
                    : {
                        value: (caseId ?? undefined) as NonNullable<typeof caseId>,
                        label: String(caseId ?? undefined),
                      })
                }
                onChange={(_event, option) => {
                  if (option !== null) setCaseId(option.value as NonNullable<typeof caseId>);
                }}
                getOptionLabel={(option) => option.label}
                isOptionEqualToValue={(option, selected) => option.value === selected.value}
                getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={"Saved report case"}
                    placeholder={"Inspect a frozen case"}
                    slotProps={{
                      ...params.slotProps,
                      htmlInput: {
                        ...params.slotProps.htmlInput,
                        "aria-label": "Saved report case",
                      },
                    }}
                  />
                )}
                disableClearable={Boolean(caseId ?? undefined)}
                getOptionKey={(option) => option.value}
              />
              {caseDetail.data && !caseDetail.isFetching ? (
                <AssessmentCase
                  value={caseDetail.data}
                  matrix={matrix}
                  onViewResult={active && page.readable ? onViewResult : undefined}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        <Card variant="elevation" elevation={0} className="evaluation-section-card">
          <CardHeader
            title={"Current preview"}
            action={
              <Button
                disabled={!active || !page.readable || pending}
                loading={preview.busy}
                onClick={calculate}
                variant="outlined"
              >
                {preview.value || mutation.conflict ? "Refresh preview" : "Calculate preview"}
              </Button>
            }
            slotProps={{
              title: {
                variant: "subtitle1",
                component: "h3",
              },
            }}
          />
          <CardContent>
            <p className="evaluation-meta">
              Preview calculation verifies the current batch inputs only when requested. Batch
              polling does not recalculate it.
            </p>
            {stale ? (
              <Alert severity={"info"}>
                <AlertTitle>{"The batch changed since the previous preview"}</AlertTitle>
                {
                  "Calculate a new preview before saving a new report. Any original request awaiting confirmation is retained."
                }
              </Alert>
            ) : null}
            {preview.error ? (
              <Alert severity={"error"}>
                <AlertTitle>{"Preview unavailable"}</AlertTitle>
                {preview.error}
              </Alert>
            ) : null}
            {shownPreview ? (
              <>
                <p className="evaluation-meta">
                  Calculated {shownPreview.generatedAt} · assessment version{" "}
                  {shownPreview.assessmentVersion} · {shownPreview.summary.rulesVersion}
                </p>
                <AssessmentSummary summary={shownPreview.summary} />
              </>
            ) : (
              <Typography component="p" variant="body2" color={"text.secondary"}>
                Calculate a preview to inspect current coverage and comparison results.
              </Typography>
            )}
            {!reviewer ? (
              <Alert severity={"info"}>
                <AlertTitle>{"Reviewer permission is required to save reports"}</AlertTitle>
              </Alert>
            ) : null}
            {mutation.error ? (
              <Alert
                action={
                  mutation.request ? (
                    <Button
                      disabled={!canSave}
                      loading={mutation.busy}
                      onClick={retry}
                      variant="outlined"
                    >
                      Retry original save
                    </Button>
                  ) : undefined
                }
                severity={mutation.conflict ? "warning" : "error"}
              >
                <AlertTitle>
                  {mutation.conflict
                    ? "The report inputs or version changed"
                    : mutation.request
                      ? "The save result is not confirmed"
                      : "The report was rejected"}
                </AlertTitle>
                {mutation.error}
              </Alert>
            ) : null}
            {mutation.request ? (
              <p className="evaluation-meta">
                The original change ID, input digest and expected version are preserved.
              </p>
            ) : null}
            {mutation.conflict ? (
              <>
                <p>
                  Refresh the preview, review it, and explicitly confirm it before submitting a new
                  report request.
                </p>
                {preview.value && lastAttempt && preview.calculation > lastAttempt.calculation ? (
                  <Button
                    disabled={!canSave || pending}
                    onClick={() => {
                      saveOwner.reset();
                      setLastAttempt(null);
                    }}
                    variant="outlined"
                  >
                    Use this refreshed preview
                  </Button>
                ) : null}
              </>
            ) : null}
            {notice ? (
              <Alert severity={"success"}>
                <AlertTitle>{notice}</AlertTitle>
              </Alert>
            ) : null}
            <Button
              disabled={
                !canSave ||
                pending ||
                mutation.conflict ||
                preview.busy ||
                !preview.value ||
                preview.value.assessmentVersion >= Number.MAX_SAFE_INTEGER
              }
              loading={mutation.busy}
              onClick={save}
              variant="contained"
            >
              Save report
            </Button>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}
