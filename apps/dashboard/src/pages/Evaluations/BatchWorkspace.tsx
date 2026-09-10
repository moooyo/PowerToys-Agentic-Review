import * as C from "@agentic-review/contracts";
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DataTable, DetailsGrid } from "@/components/ui";
import { HttpConfigurationAdapter } from "@/services/configuration";
import {
  createHttpEvaluationBatchAdapter,
  type EvaluationBatchAdapter,
} from "@/services/evaluation-batches";
import { ReviewControlProtocolError } from "@/services/review-control/errors";
import { AssessmentReports } from "./AssessmentReports";
import { BatchCreate } from "./BatchCreate";
import { armLabels, arms, assertBatchReadScope, executionLabels } from "./batch-state";
import { CellResultDrawer } from "./CellResult";
import { type CellResultSelection, selectedCellResultBinding } from "./cell-result-state";
import {
  MutationNotice,
  useEvaluationPage,
  useEvaluationQuery,
  useOriginalMutation,
  useRefreshEvaluations,
} from "./context";
import { CopyValue } from "./Display";
import { BatchReproductionPlan } from "./ReproductionPlan";
import { FrozenSourceLabel } from "./Sources";
import { collectCatalog, errorMessage, newIdentity } from "./state";

type SuiteScope = {
  suiteId: string;
  workflowKind: C.WorkflowKind;
  target: C.ValidationTarget;
};
export function BatchConfigurationPanel({
  open,
  pending,
  createdBatchId,
  onOpenChange,
  children,
}: {
  open: boolean;
  pending: boolean;
  createdBatchId: string | null;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const visible = open || pending;
  return (
    <>
      {!visible && createdBatchId ? (
        <Alert
          action={
            <Button onClick={() => onOpenChange(true)} aria-expanded={false} variant="outlined">
              Create another batch
            </Button>
          }
          severity={"success"}
        >
          <AlertTitle>{"Batch created"}</AlertTitle>
          {`Batch ${createdBatchId} is selected below. Your previous configuration is preserved.`}
        </Alert>
      ) : null}
      {visible && createdBatchId ? (
        <div>
          <Button
            disabled={pending}
            onClick={() => onOpenChange(false)}
            aria-expanded
            variant="outlined"
          >
            Hide configuration
          </Button>
        </div>
      ) : null}
      <div hidden={!visible}>{children}</div>
    </>
  );
}
export function ExecutionCell({
  cell,
  onViewResult,
}: {
  cell: C.EvaluationCellSummaryV1;
  onViewResult?: (cell: C.EvaluationCellSummaryV1) => void;
}) {
  return (
    <div className="evaluation-cell">
      <Chip
        label={executionLabels[cell.state]}
        color={
          cell.state === "running"
            ? "info"
            : cell.state === "blocked" || cell.state === "failed" || cell.state === "invalid"
              ? "warning"
              : "default"
        }
      />
      {cell.state === "awaiting_admission" ? (
        <span className="evaluation-meta">
          The Job is waiting for admission; it is not queued for a Worker.
        </span>
      ) : null}
      <span className="evaluation-meta">Run {cell.runId}</span>
      {cell.job ? (
        <span className="evaluation-meta">
          Job {cell.job.jobId} · {cell.job.status} · {cell.job.attemptCount} attempts
          {cell.job.failureCode ? ` · ${cell.job.failureCode}` : ""}
          {cell.job.admission ? ` · admission ${cell.job.admission.state}` : ""}
        </span>
      ) : null}
      {cell.blockerCount > 0 ? (
        <div>
          <Typography
            component="span"
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {cell.blockers.length} of {cell.blockerCount} blockers
          </Typography>
          <ul className="evaluation-blockers">
            {cell.blockers.map((blocker) => (
              <li key={JSON.stringify(blocker)}>
                <span>{blocker.code.replaceAll("_", " ")}</span>
                {Object.entries(blocker)
                  .filter(([key]) => key !== "code")
                  .map(([key, value]) => (
                    <span className="evaluation-meta" key={key}>
                      {key}: {typeof value === "string" ? value : JSON.stringify(value)}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
          {cell.blockerCount > cell.blockers.length ? (
            <span className="evaluation-meta">
              Only the first 16 blockers are included in this matrix.
            </span>
          ) : null}
        </div>
      ) : null}
      {cell.result ? (
        <div>
          <span className="evaluation-meta">Result identity</span>
          <CopyValue value={cell.result.resultId} />
          {onViewResult ? (
            <Button
              aria-label={`View ${armLabels[cell.arm]} result for case ${cell.caseId}`}
              onClick={() => onViewResult(cell)}
              variant="outlined"
            >
              View result
            </Button>
          ) : null}
          <span className="evaluation-meta">Attempt {cell.result.runAttemptId}</span>
        </div>
      ) : null}
    </div>
  );
}
export function BatchMatrix({
  matrix,
  onViewResult,
}: {
  matrix: C.EvaluationBatchMatrixV1;
  onViewResult?: (cell: C.EvaluationCellSummaryV1) => void;
}) {
  return (
    <div>
      <div className="evaluation-subheading">
        <Typography
          component="span"
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          Case execution matrix
        </Typography>
        <Chip label={executionLabels[matrix.status]} />
      </div>
      <DataTable<C.EvaluationBatchMatrixV1["cases"][number]>
        rows={matrix.cases}
        getRowId={(row) => row.caseId}
        columns={[
          {
            id: "case",
            label: "Frozen case",
            width: "34%",
            render: (entry) => {
              return (
                <div>
                  <strong>{entry.title}</strong>
                  <FrozenSourceLabel source={entry.source} />
                  {entry.applicability.state === "not_applicable" ? (
                    <p>Not applicable: {entry.applicability.reason}</p>
                  ) : null}
                  <span className="evaluation-meta">{entry.caseId}</span>
                </div>
              );
            },
          },
          ...arms.map((arm) => ({
            id: arm,
            label: armLabels[arm],
            width: "33%",
            render: (entry: C.EvaluationBatchMatrixV1["cases"][number]) => {
              return <ExecutionCell cell={entry[arm]} onViewResult={onViewResult} />;
            },
          })),
        ]}
        ariaLabel="Evaluation records"
      />
      <p className="evaluation-meta">
        Execution state and result IDs do not represent a scored report or verified evidence.
        Finding completeness and expected outcomes remain the labels frozen in the suite version.
      </p>
    </div>
  );
}
export function BatchDetails({
  api,
  evaluationId,
  scope,
  active,
  onPendingChange,
}: {
  api: EvaluationBatchAdapter;
  evaluationId: string;
  scope: SuiteScope;
  active: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const batchScope = {
    repositoryId: page.repositoryId,
    evaluationId,
  };
  const query = useEvaluationQuery(
    ["batch-detail-matrix", scope.suiteId, evaluationId],
    async (signal) => {
      const [detail, matrix] = await Promise.all([
        api.getBatch(batchScope, signal),
        api.getBatchMatrix(batchScope, signal),
      ]);
      assertBatchReadScope(detail, matrix, scope);
      return {
        detail,
        matrix,
      };
    },
    active,
    10_000,
  );
  const [reason, setReason] = useState("");
  const [resultSelection, setResultSelection] = useState<CellResultSelection | null>(null);
  const [assessmentPending, setAssessmentPending] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const cancellation = useOriginalMutation<
    C.EvaluationBatchCancelRequest,
    C.EvaluationBatchCancellationV1
  >(
    (request) => api.cancelBatch(batchScope, request, page.principal),
    (result) => {
      setNotice(
        `Cancellation recorded. ${result.cancelledJobCount} Jobs cancelled; ${result.cancellationRequestedJobCount} active Jobs received a cancellation request. Active work may still be stopping.`,
      );
      refresh();
    },
  );
  useEffect(() => {
    onPendingChange(cancellation.busy || cancellation.request !== null || assessmentPending);
  }, [onPendingChange, cancellation.busy, cancellation.request, assessmentPending]);
  const detail = query.data?.detail;
  const resultBinding = selectedCellResultBinding(detail, query.data?.matrix, resultSelection);
  const locked =
    !active ||
    !page.canConfigure ||
    cancellation.busy ||
    cancellation.request !== null ||
    cancellation.conflict ||
    assessmentPending ||
    !detail ||
    detail.control.version !== 1;
  const cancel = () => {
    if (locked) return;
    const request: C.EvaluationBatchCancelRequest = {
      changeId: newIdentity(),
      expectedVersion: 1,
      reason,
    };
    const issues = C.getEvaluationBatchCancelRequestIssues(request);
    setError(issues[0] ?? null);
    if (!issues.length) cancellation.submit(request);
  };
  return (
    <Card variant="outlined">
      <CardHeader
        title={"Batch detail"}
        action={
          <Button
            disabled={!active || !page.readable}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            variant="outlined"
          >
            Refresh batch
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
        {query.error ? (
          <Alert severity={"error"}>
            <AlertTitle>{"Batch unavailable"}</AlertTitle>
            {errorMessage(query.error)}
          </Alert>
        ) : null}
        {detail ? (
          <>
            <DetailsGrid
              items={[
                {
                  key: "id",
                  label: "Batch",
                  value: <CopyValue value={detail.summary.id} />,
                },
                {
                  key: "state",
                  label: "Status",
                  value: executionLabels[detail.status],
                },
                {
                  key: "version",
                  label: "Published suite",
                  value: `Version ${detail.suiteVersion.version} · ${detail.suiteVersion.id}`,
                },
                {
                  key: "mode",
                  label: "Mode",
                  value:
                    detail.summary.mode === "profile_only" ? "Profile only" : "Prompt and profile",
                },
                {
                  key: "control",
                  label: "Cancellation control",
                  value: `${detail.control.status} · version ${detail.control.version}`,
                },
                {
                  key: "progress",
                  label: "Progress",
                  value: `${detail.progress.completed} completed · ${detail.progress.failed} failed · ${detail.progress.blocked} blocked · ${detail.progress.running} running · ${detail.progress.notApplicableCells} not applicable`,
                },
              ]}
              columns={2}
            />
            {detail.status === "cancelling" ? (
              <Alert severity={"info"}>
                <AlertTitle>{"Cancellation is still in progress"}</AlertTitle>
                {"One or more Jobs remain active. Cancellation has not yet stopped all work."}
              </Alert>
            ) : null}
            {detail.status === "awaiting_admission" ? (
              <Alert severity={"info"}>
                <AlertTitle>{"Awaiting admission"}</AlertTitle>
                {
                  "Jobs exist but are not yet in the Worker queue. Admission and dispatch blockers appear in the matrix."
                }
              </Alert>
            ) : null}
            <div className="evaluation-arm-grid">
              {arms.map((arm) => (
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
                    <Typography
                      component="span"
                      variant="body2"
                      sx={{
                        fontWeight: 500,
                      }}
                    >
                      {detail.configurations[arm].profile.name} · version{" "}
                      {detail.configurations[arm].profile.version}
                    </Typography>
                    <span className="evaluation-meta">{detail.configurations[arm].profile.id}</span>
                    <p>
                      Prompt version {detail.configurations[arm].prompt.version}
                      <span className="evaluation-meta">
                        {detail.configurations[arm].prompt.id}
                      </span>
                    </p>
                    <Chip
                      label={
                        detail.configurations[arm].modelRequirements.required
                          ? "Model required"
                          : "Profile execution only"
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
            {detail.control.reason ? (
              <Alert severity={"info"}>
                <AlertTitle>{"Cancellation reason"}</AlertTitle>
                {detail.control.reason}
              </Alert>
            ) : null}
          </>
        ) : null}
        {query.data ? (
          <BatchMatrix
            matrix={query.data.matrix}
            onViewResult={
              active && page.readable
                ? (cell) => {
                    if (cell.result && cell.job)
                      setResultSelection({
                        cellId: cell.cellId,
                        resultId: cell.result.resultId,
                      });
                  }
                : undefined
            }
          />
        ) : null}
        <CellResultDrawer
          api={api}
          binding={resultBinding}
          active={active}
          onClose={() => setResultSelection(null)}
        />
        {detail?.summary.workflowKind === "issue_validation" && query.data ? (
          <BatchReproductionPlan
            key={`reproduction-plan:${evaluationId}`}
            detail={detail}
            matrix={query.data.matrix}
            active={active && page.readable}
          />
        ) : null}
        <AssessmentReports
          key={`assessment-reports:${evaluationId}`}
          evaluationId={evaluationId}
          matrix={query.data?.matrix}
          active={active && !cancellation.busy && cancellation.request === null}
          onPendingChange={setAssessmentPending}
          onViewResult={(cell) => {
            if (active && page.readable && cell.result && cell.job)
              setResultSelection({
                cellId: cell.cellId,
                resultId: cell.result.resultId,
              });
          }}
        />
        {notice ? (
          <Alert severity={"success"}>
            <AlertTitle>{"Cancellation accepted"}</AlertTitle>
            {notice}
          </Alert>
        ) : null}
        {page.allowsConfigure ? (
          <Stack
            component="fieldset"
            spacing={2}
            sx={{
              border: 0,
              p: 0,
              m: 0,
              minWidth: 0,
            }}
          >
            <TextField
              value={reason}
              disabled={locked}
              onChange={(event) => setReason(event.target.value)}
              fullWidth
              label={"Cancellation reason"}
              required={true}
              slotProps={{
                htmlInput: {
                  maxLength: 2048,
                  "aria-label": `Cancellation reason for batch ${evaluationId}`,
                },
              }}
              multiline
              minRows={2}
              maxRows={4}
            />
            {error ? (
              <Alert severity={"error"}>
                <AlertTitle>{"Enter a cancellation reason"}</AlertTitle>
                {error}
              </Alert>
            ) : null}
            <MutationNotice
              mutation={cancellation}
              conflictTitle="Cancellation control changed"
              conflictDescription="Your reason is preserved. Refresh the control before deciding whether a new cancellation request is still needed."
            />
            {cancellation.conflict ? (
              <Button
                disabled={!active || !page.readable}
                onClick={async () => {
                  const result = await query.refetch();
                  if (!result.isError) cancellation.reset();
                }}
                variant="outlined"
              >
                Reload cancellation control
              </Button>
            ) : null}
            <Button
              disabled={locked}
              loading={cancellation.busy}
              onClick={cancel}
              variant="outlined"
              color="error"
            >
              Cancel evaluation batch
            </Button>
          </Stack>
        ) : null}
      </CardContent>
    </Card>
  );
}
export function BatchWorkspace({
  suiteId,
  workflowKind,
  target,
  active,
  onPendingChange,
}: SuiteScope & {
  active: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const api = useMemo(() => createHttpEvaluationBatchAdapter(), []),
    configuration = useMemo(() => new HttpConfigurationAdapter(), []);
  const [listPage, setListPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null),
    [versionId, setVersionId] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false),
    [cancelPending, setCancelPending] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(true);
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null);
  const [focusBatchId, setFocusBatchId] = useState<string | null>(null);
  const detailElement = useRef<HTMLElement>(null);
  const configurationVisible = configurationOpen || createPending;
  useEffect(() => {
    if (
      !active ||
      !page.readable ||
      configurationVisible ||
      !focusBatchId ||
      selected !== focusBatchId
    )
      return;
    const element = detailElement.current;
    if (!element) return;
    element.focus({
      preventScroll: true,
    });
    element.scrollIntoView({
      block: "start",
      behavior: "auto",
    });
    setFocusBatchId(null);
  }, [active, page.readable, configurationVisible, focusBatchId, selected]);
  const pending = createPending || cancelPending;
  useEffect(() => {
    onPendingChange(pending);
  }, [onPendingChange, pending]);
  const versions = useEvaluationQuery(
    ["versions", suiteId],
    (signal) =>
      collectCatalog((number) =>
        page.api.listSuiteVersions(
          {
            repositoryId: page.repositoryId,
            suiteId,
          },
          {
            page: number,
            pageSize: 50,
          },
          signal,
        ),
      ),
    active,
  );
  const version = useEvaluationQuery(
    ["version", suiteId, versionId],
    async (signal) => {
      const result = await page.api.getSuiteVersion(
        {
          repositoryId: page.repositoryId,
          suiteId,
          versionId: versionId ?? "",
        },
        signal,
      );
      if (result.workflowKind !== workflowKind || result.target !== target)
        throw new ReviewControlProtocolError(
          "read batch suite version",
          "The published version does not match this suite's workflow and target.",
        );
      return result;
    },
    active && versionId !== null,
  );
  const [frozenVersion, setFrozenVersion] = useState<C.EvaluationSuiteVersionV1 | null>(null);
  useEffect(() => {
    if (version.data && version.data.id === versionId) setFrozenVersion(version.data);
  }, [version.data, versionId]);
  const list = useEvaluationQuery(
    ["batches", suiteId, listPage, workflowKind],
    (signal) =>
      api.listBatches(
        page.repositoryId,
        {
          suiteId,
          workflowKind,
          page: listPage,
          pageSize: 20,
        },
        signal,
      ),
    active,
    10_000,
  );
  const error = versions.error ?? version.error ?? list.error;
  return (
    <div className="evaluation-batch-workspace">
      <div className="evaluation-subheading">
        <Typography
          component="span"
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          Evaluation batches
        </Typography>
        <Button
          disabled={!active || !page.readable}
          loading={list.isFetching}
          onClick={refresh}
          variant="outlined"
        >
          Refresh batches
        </Button>
      </div>
      {error ? (
        <Alert severity={"error"}>
          <AlertTitle>{"Batch data unavailable"}</AlertTitle>
          {errorMessage(error)}
        </Alert>
      ) : null}
      {page.allowsConfigure ? (
        <BatchConfigurationPanel
          open={configurationOpen}
          pending={createPending}
          createdBatchId={createdBatchId}
          onOpenChange={setConfigurationOpen}
        >
          <Stack
            component="fieldset"
            spacing={2}
            sx={{
              border: 0,
              p: 0,
              m: 0,
              minWidth: 0,
            }}
          >
            <Autocomplete
              disabled={!active || !page.canConfigure || pending}
              loading={versions.isFetching}
              options={(versions.data ?? []).map((entry) => ({
                value: entry.id,
                label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.id}`,
              }))}
              disablePortal
              fullWidth
              value={
                (versions.data ?? [])
                  .map((entry) => ({
                    value: entry.id,
                    label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.id}`,
                  }))
                  .find((option) => option.value === versionId) ??
                (versionId == null || String(versionId) === ""
                  ? null
                  : {
                      value: versionId as NonNullable<typeof versionId>,
                      label: String(versionId),
                    })
              }
              onChange={(_event, option) => {
                if (option !== null)
                  ((id) => {
                    if (!pending) {
                      setVersionId(id);
                      setFrozenVersion(null);
                    }
                  })(option.value as NonNullable<typeof versionId>);
              }}
              getOptionLabel={(option) => option.label}
              isOptionEqualToValue={(option, selected) => option.value === selected.value}
              getOptionDisabled={(option) => "disabled" in option && option.disabled === true}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={"Published version to evaluate"}
                  placeholder={"Choose the exact immutable suite version"}
                  slotProps={{
                    ...params.slotProps,
                    htmlInput: {
                      ...params.slotProps.htmlInput,
                      "aria-label": "Published suite version to evaluate",
                    },
                  }}
                />
              )}
              disableClearable={Boolean(versionId)}
              getOptionKey={(option) => option.value}
            />
          </Stack>
          {frozenVersion && frozenVersion.id === versionId ? (
            <BatchCreate
              key={frozenVersion.id}
              version={frozenVersion}
              api={api}
              configuration={configuration}
              active={active && configurationVisible && !cancelPending}
              onPendingChange={setCreatePending}
              onCreated={(batch) => {
                setSelected(batch.id);
                setCreatedBatchId(batch.id);
                setConfigurationOpen(false);
                setFocusBatchId(batch.id);
                refresh();
              }}
            />
          ) : null}
        </BatchConfigurationPanel>
      ) : null}
      <DataTable<C.EvaluationBatchListItemV1>
        loading={active && list.isPending}
        rows={list.data?.items ?? []}
        getRowId={(entry) => entry.summary.id}
        columns={[
          {
            id: "batch",
            label: "Batch",
            render: (entry) => {
              return (
                <Button
                  className="evaluation-name"
                  disabled={pending && selected !== entry.summary.id}
                  onClick={() => {
                    if (!pending) setSelected(entry.summary.id);
                  }}
                  variant="text"
                >
                  {entry.summary.id}
                </Button>
              );
            },
          },
          {
            id: "version",
            label: "Published version",
            render: (entry) => {
              return <span className="evaluation-meta">{entry.summary.suiteVersionId}</span>;
            },
          },
          {
            id: "status",
            label: "Status",
            render: (entry) => {
              return <Chip label={executionLabels[entry.status]} />;
            },
          },
          {
            id: "cells",
            label: "Cells",
            render: (entry) => {
              return `${entry.progress.completed}/${entry.progress.applicableCells} completed · ${entry.progress.failed} failed · ${entry.progress.blocked} blocked`;
            },
          },
          {
            id: "created",
            label: "Created",
            render: (entry) => {
              return <span className="evaluation-meta">{entry.summary.createdAt}</span>;
            },
          },
        ]}
        ariaLabel="Evaluation records"
        pagination={{
          page: listPage,
          pageSize: 20,
          total: list.data?.total ?? 0,
          onChange: setListPage,
        }}
      />
      {selected ? (
        <section
          ref={detailElement}
          tabIndex={-1}
          aria-label={`Selected evaluation batch ${selected}`}
          className="evaluation-selected-batch"
        >
          <BatchDetails
            key={selected}
            api={api}
            evaluationId={selected}
            scope={{
              suiteId,
              workflowKind,
              target,
            }}
            active={active && !createPending}
            onPendingChange={setCancelPending}
          />
        </section>
      ) : null}
    </div>
  );
}
