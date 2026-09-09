import * as C from "@agentic-review/contracts";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Select,
  Table,
  Tag,
  Typography,
} from "antd";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { BatchReproductionPlan } from "./ReproductionPlan";
import { FrozenSourceLabel } from "./Sources";
import { collectCatalog, errorMessage, newIdentity } from "./state";

type SuiteScope = { suiteId: string; workflowKind: C.WorkflowKind; target: C.ValidationTarget };

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
          type="success"
          title="Batch created"
          description={`Batch ${createdBatchId} is selected below. Your previous configuration is preserved.`}
          action={
            <Button onClick={() => onOpenChange(true)} aria-expanded={false}>
              Create another batch
            </Button>
          }
        />
      ) : null}
      {visible && createdBatchId ? (
        <div>
          <Button disabled={pending} onClick={() => onOpenChange(false)} aria-expanded>
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
      <Tag
        color={
          cell.state === "running"
            ? "processing"
            : cell.state === "blocked" || cell.state === "failed" || cell.state === "invalid"
              ? "warning"
              : undefined
        }
      >
        {executionLabels[cell.state]}
      </Tag>
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
          <Typography.Text strong>
            {cell.blockers.length} of {cell.blockerCount} blockers
          </Typography.Text>
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
          <Typography.Text copyable>{cell.result.resultId}</Typography.Text>
          {onViewResult ? (
            <Button
              size="small"
              aria-label={`View ${armLabels[cell.arm]} result for case ${cell.caseId}`}
              onClick={() => onViewResult(cell)}
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
        <Typography.Text strong>Case execution matrix</Typography.Text>
        <Tag>{executionLabels[matrix.status]}</Tag>
      </div>
      <Table<C.EvaluationBatchMatrixV1["cases"][number]>
        rowKey="caseId"
        size="small"
        pagination={false}
        scroll={{ x: 850 }}
        dataSource={matrix.cases}
        columns={[
          {
            title: "Frozen case",
            key: "case",
            width: "34%",
            render: (_, entry) => (
              <div>
                <strong>{entry.title}</strong>
                <FrozenSourceLabel source={entry.source} />
                {entry.applicability.state === "not_applicable" ? (
                  <p>Not applicable: {entry.applicability.reason}</p>
                ) : null}
                <span className="evaluation-meta">{entry.caseId}</span>
              </div>
            ),
          },
          ...arms.map((arm) => ({
            title: armLabels[arm],
            key: arm,
            width: "33%",
            render: (_: unknown, entry: C.EvaluationBatchMatrixV1["cases"][number]) => (
              <ExecutionCell cell={entry[arm]} onViewResult={onViewResult} />
            ),
          })),
        ]}
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
  const batchScope = { repositoryId: page.repositoryId, evaluationId };
  const query = useEvaluationQuery(
    ["batch-detail-matrix", scope.suiteId, evaluationId],
    async (signal) => {
      const [detail, matrix] = await Promise.all([
        api.getBatch(batchScope, signal),
        api.getBatchMatrix(batchScope, signal),
      ]);
      assertBatchReadScope(detail, matrix, scope);
      return { detail, matrix };
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
    <Card
      title="Batch detail"
      extra={
        <Button
          disabled={!active || !page.readable}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh batch
        </Button>
      }
    >
      {query.error ? (
        <Alert type="error" title="Batch unavailable" description={errorMessage(query.error)} />
      ) : null}
      {detail ? (
        <>
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: "id",
                label: "Batch",
                children: <Typography.Text copyable>{detail.summary.id}</Typography.Text>,
              },
              { key: "state", label: "Status", children: executionLabels[detail.status] },
              {
                key: "version",
                label: "Published suite",
                children: `Version ${detail.suiteVersion.version} · ${detail.suiteVersion.id}`,
              },
              {
                key: "mode",
                label: "Mode",
                children:
                  detail.summary.mode === "profile_only" ? "Profile only" : "Prompt and profile",
              },
              {
                key: "control",
                label: "Cancellation control",
                children: `${detail.control.status} · version ${detail.control.version}`,
              },
              {
                key: "progress",
                label: "Progress",
                children: `${detail.progress.completed} completed · ${detail.progress.failed} failed · ${detail.progress.blocked} blocked · ${detail.progress.running} running · ${detail.progress.notApplicableCells} not applicable`,
              },
            ]}
          />
          {detail.status === "cancelling" ? (
            <Alert
              type="info"
              title="Cancellation is still in progress"
              description="One or more Jobs remain active. Cancellation has not yet stopped all work."
            />
          ) : null}
          {detail.status === "awaiting_admission" ? (
            <Alert
              type="info"
              title="Awaiting admission"
              description="Jobs exist but are not yet in the Worker queue. Admission and dispatch blockers appear in the matrix."
            />
          ) : null}
          <div className="evaluation-arm-grid">
            {arms.map((arm) => (
              <Card size="small" key={arm} title={armLabels[arm]}>
                <Typography.Text strong>
                  {detail.configurations[arm].profile.name} · version{" "}
                  {detail.configurations[arm].profile.version}
                </Typography.Text>
                <span className="evaluation-meta">{detail.configurations[arm].profile.id}</span>
                <p>
                  Prompt version {detail.configurations[arm].prompt.version}
                  <span className="evaluation-meta">{detail.configurations[arm].prompt.id}</span>
                </p>
                <Tag>
                  {detail.configurations[arm].modelRequirements.required
                    ? "Model required"
                    : "Profile execution only"}
                </Tag>
              </Card>
            ))}
          </div>
          {detail.control.reason ? (
            <Alert type="info" title="Cancellation reason" description={detail.control.reason} />
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
                    setResultSelection({ cellId: cell.cellId, resultId: cell.result.resultId });
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
            setResultSelection({ cellId: cell.cellId, resultId: cell.result.resultId });
        }}
      />
      {notice ? <Alert type="success" title="Cancellation accepted" description={notice} /> : null}
      {page.allowsConfigure ? (
        <Form layout="vertical">
          <Form.Item label="Cancellation reason" required>
            <Input.TextArea
              aria-label={`Cancellation reason for batch ${evaluationId}`}
              value={reason}
              maxLength={2048}
              disabled={locked}
              onChange={(event) => setReason(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          {error ? (
            <Alert type="error" title="Enter a cancellation reason" description={error} />
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
            >
              Reload cancellation control
            </Button>
          ) : null}
          <Button danger disabled={locked} loading={cancellation.busy} onClick={cancel}>
            Cancel evaluation batch
          </Button>
        </Form>
      ) : null}
    </Card>
  );
}

export function BatchWorkspace({
  suiteId,
  workflowKind,
  target,
  active,
  onPendingChange,
}: SuiteScope & { active: boolean; onPendingChange: (pending: boolean) => void }) {
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
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start", behavior: "auto" });
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
          { repositoryId: page.repositoryId, suiteId },
          { page: number, pageSize: 50 },
          signal,
        ),
      ),
    active,
  );
  const version = useEvaluationQuery(
    ["version", suiteId, versionId],
    async (signal) => {
      const result = await page.api.getSuiteVersion(
        { repositoryId: page.repositoryId, suiteId, versionId: versionId ?? "" },
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
        { suiteId, workflowKind, page: listPage, pageSize: 20 },
        signal,
      ),
    active,
    10_000,
  );
  const error = versions.error ?? version.error ?? list.error;
  return (
    <div className="evaluation-batch-workspace">
      <div className="evaluation-subheading">
        <Typography.Text strong>Evaluation batches</Typography.Text>
        <Button disabled={!active || !page.readable} loading={list.isFetching} onClick={refresh}>
          Refresh batches
        </Button>
      </div>
      {error ? (
        <Alert type="error" title="Batch data unavailable" description={errorMessage(error)} />
      ) : null}
      {page.allowsConfigure ? (
        <BatchConfigurationPanel
          open={configurationOpen}
          pending={createPending}
          createdBatchId={createdBatchId}
          onOpenChange={setConfigurationOpen}
        >
          <Form layout="vertical">
            <Form.Item label="Published version to evaluate">
              <Select
                aria-label="Published suite version to evaluate"
                disabled={!active || !page.canConfigure || pending}
                value={versionId}
                placeholder="Choose the exact immutable suite version"
                loading={versions.isFetching}
                options={(versions.data ?? []).map((entry) => ({
                  value: entry.id,
                  label: `Version ${entry.version} · ${entry.caseCount} cases · ${entry.id}`,
                }))}
                onChange={(id) => {
                  if (!pending) {
                    setVersionId(id);
                    setFrozenVersion(null);
                  }
                }}
              />
            </Form.Item>
          </Form>
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
      <Table<C.EvaluationBatchListItemV1>
        rowKey={(entry) => entry.summary.id}
        size="small"
        loading={active && list.isPending}
        dataSource={list.data?.items ?? []}
        scroll={{ x: 760 }}
        pagination={{
          current: listPage,
          pageSize: 20,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: setListPage,
        }}
        columns={[
          {
            title: "Batch",
            key: "batch",
            render: (_, entry) => (
              <Button
                type="link"
                className="evaluation-name"
                disabled={pending && selected !== entry.summary.id}
                onClick={() => {
                  if (!pending) setSelected(entry.summary.id);
                }}
              >
                {entry.summary.id}
              </Button>
            ),
          },
          {
            title: "Published version",
            key: "version",
            render: (_, entry) => (
              <span className="evaluation-meta">{entry.summary.suiteVersionId}</span>
            ),
          },
          {
            title: "Status",
            key: "status",
            render: (_, entry) => <Tag>{executionLabels[entry.status]}</Tag>,
          },
          {
            title: "Cells",
            key: "cells",
            render: (_, entry) =>
              `${entry.progress.completed}/${entry.progress.applicableCells} completed · ${entry.progress.failed} failed · ${entry.progress.blocked} blocked`,
          },
          {
            title: "Created",
            key: "created",
            render: (_, entry) => (
              <span className="evaluation-meta">{entry.summary.createdAt}</span>
            ),
          },
        ]}
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
            scope={{ suiteId, workflowKind, target }}
            active={active && !createPending}
            onPendingChange={setCancelPending}
          />
        </section>
      ) : null}
    </div>
  );
}
