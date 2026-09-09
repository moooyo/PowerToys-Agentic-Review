import type {
  DashboardReviewRunDetail,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import { Alert, Button, Collapse, Divider, Skeleton, Space, Table, Typography } from "antd";
import { useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { runs } from "@/services/runs";
import { CopyValue, ErrorNotice, Facts, Prose } from "../ReviewRuns/common";
import { EvidenceView } from "../ReviewRuns/EvidenceView";
import { evidencePollingViewVisible } from "../ReviewRuns/evidence-verification";
import { AssessmentSummary, CaseState, ReproductionCaseFacts } from "./presentation";
import {
  type ReproductionCaseSelection,
  reproductionCaseMatches,
  reproductionEvidenceScope,
  reproductionPollingInterval,
  reproductionQueryKey,
  reproductionReasonLabel,
  reproductionTargetLabel,
} from "./state";

type Assessment = Omit<IssueReproductionAssessmentV1, "schemaVersion">;
interface CaseRow {
  readonly caseId: string;
  readonly requestId: string;
  readonly profileVersionId: string;
  readonly profileLabel?: string;
  readonly target: IssueReproductionCaseAssessment["target"];
  readonly context?: string;
  readonly executionKey?: string;
  readonly current: IssueReproductionCaseAssessment | undefined;
  readonly recorded?: IssueReproductionCaseAssessment;
}
interface ReproductionViewProps {
  readonly repositoryId: string;
  readonly workItemId: string;
  readonly reviewRunId: string;
  readonly claim?: string;
  readonly assessment: Assessment;
  readonly recorded?: Assessment;
  readonly cases: CaseRow[];
  readonly result?: DashboardReviewRunResult;
}

function evidenceReferences(detail: DashboardReviewRunReproductionCaseResponse) {
  const ids = new Set([
    ...detail.current.evidenceIds,
    ...(detail.recorded?.evidenceIds ?? []),
    ...detail.observations.flatMap((fact) => fact.evidenceIds),
  ]);
  return [...ids].map((id) => ({
    id,
    checkIds: [
      ...new Set(
        detail.observations
          .filter((fact) => fact.evidenceIds.includes(id))
          .map((fact) => fact.checkId),
      ),
    ],
  }));
}

function CaseDetails({
  selection,
  principal,
  session,
  mayRead,
  result,
}: {
  selection: ReproductionCaseSelection;
  principal: OperatorPrincipal;
  session: string;
  mayRead: boolean;
  result?: DashboardReviewRunResult;
}) {
  const [openPanels, setOpenPanels] = useState<string[]>([]);
  const query = useQuery<{
    detail: DashboardReviewRunReproductionCaseResponse;
    savedResult: DashboardReviewRunResult | null;
  }>({
    queryKey: reproductionQueryKey(runs.mode, selection, principal, session),
    enabled: mayRead,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (state) =>
      reproductionPollingInterval({
        mode: runs.mode,
        canRead: mayRead,
        visible: evidencePollingViewVisible(),
        hasError: state.state.status === "error",
      }),
    queryFn: async ({ signal }) => {
      const detail = await runs.getReproductionCase({
        repositoryId: selection.repositoryId,
        reviewRunId: selection.reviewRunId,
        requestId: selection.requestId,
        caseId: selection.caseId,
        ...(selection.jobId ? { jobId: selection.jobId } : {}),
      });
      signal.throwIfAborted();
      if (!reproductionCaseMatches(detail, selection))
        throw new Error("The reproduction case does not match the selected frozen run and case.");
      const savedResult =
        detail.jobId && detail.resultId
          ? (result ??
            (await runs.getResult(
              detail.repositoryId,
              detail.reviewRunId,
              detail.requestId,
              detail.jobId,
            )))
          : null;
      signal.throwIfAborted();
      if (detail.resultId && !reproductionEvidenceScope(detail, savedResult))
        throw new Error(
          "The saved result does not match this case's exact execution. Refresh the run and case.",
        );
      return { detail, savedResult };
    },
  });
  const loaded =
    !query.isError && query.data && reproductionCaseMatches(query.data.detail, selection)
      ? query.data
      : null;
  const evidenceScope = loaded
    ? reproductionEvidenceScope(loaded.detail, loaded.savedResult)
    : null;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Case detail · {reproductionTargetLabel[selection.target]}
        </Typography.Title>
        <Button disabled={!mayRead} loading={query.isFetching} onClick={() => void query.refetch()}>
          Refresh case
        </Button>
      </Space>
      {!mayRead ? (
        <Alert showIcon type="info" title="Repository read access is required" />
      ) : query.isError ? (
        <ErrorNotice
          title="Could not load reproduction case"
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : !loaded ? (
        <Skeleton active />
      ) : (
        <>
          <Typography.Text type="secondary">Frozen reproduction claim</Typography.Text>
          <Prose>{loaded.detail.binding.claim}</Prose>
          <ReproductionCaseFacts detail={loaded.detail} result={loaded.savedResult} />
          <Collapse
            activeKey={openPanels}
            onChange={(keys) => setOpenPanels(Array.isArray(keys) ? keys : [keys])}
            items={[
              {
                key: "identity",
                label: "Frozen case and saved result identity",
                children: (
                  <Facts
                    items={[
                      { label: "Case ID", value: <CopyValue value={loaded.detail.caseId} /> },
                      { label: "Request ID", value: <CopyValue value={loaded.detail.requestId} /> },
                      { label: "Job ID", value: <CopyValue value={loaded.detail.jobId} /> },
                      { label: "Result ID", value: <CopyValue value={loaded.detail.resultId} /> },
                      {
                        label: "Run attempt ID",
                        value: <CopyValue value={loaded.savedResult?.runAttemptId} />,
                      },
                      {
                        label: "Issue revision key",
                        value: <CopyValue value={loaded.detail.binding.issueRevisionKey} />,
                      },
                      {
                        label: "Reproduction binding digest",
                        value: <CopyValue value={loaded.detail.bindingDigest} />,
                      },
                      {
                        label: "Plan digest",
                        value: <CopyValue value={loaded.detail.planDigest} />,
                      },
                    ]}
                  />
                ),
              },
              {
                key: "evidence",
                label: `Inspect case evidence (${evidenceReferences(loaded.detail).length} references)`,
                children: openPanels.includes("evidence") ? (
                  evidenceScope ? (
                    <EvidenceView
                      key={JSON.stringify([session, evidenceScope])}
                      scope={evidenceScope}
                      references={evidenceReferences(loaded.detail)}
                    />
                  ) : (
                    <Alert
                      showIcon
                      type="info"
                      title="No saved execution evidence"
                      description="Evidence files become available only for the exact saved job attempt. Missing evidence does not establish absence."
                    />
                  )
                ) : null,
              },
            ]}
          />
          <Typography.Text type="secondary">
            Case details and settled summaries refresh every 30 seconds while visible. If evidence
            verification is still pending, use Refresh run or Refresh result to retry it.
          </Typography.Text>
        </>
      )}
    </Space>
  );
}

function ReproductionSession({
  view,
  principal,
  session,
  mayRead,
}: {
  view: ReproductionViewProps;
  principal: OperatorPrincipal;
  session: string;
  mayRead: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const selected = view.cases.find(
    (entry) => JSON.stringify([entry.requestId, entry.caseId]) === selectedKey,
  );
  const selection: ReproductionCaseSelection | null = selected
    ? {
        repositoryId: view.repositoryId,
        workItemId: view.workItemId,
        reviewRunId: view.reviewRunId,
        requestId: selected.requestId,
        caseId: selected.caseId,
        profileVersionId: selected.profileVersionId,
        target: selected.target,
        bindingDigest: view.assessment.bindingDigest,
        planDigest: view.assessment.planDigest,
        issueRevisionKey: view.assessment.issueRevisionKey,
        testedSourceCommit: view.assessment.testedSourceCommit,
        executionKey: selected.executionKey,
        ...(view.result ? { jobId: view.result.jobId, resultId: view.result.id } : {}),
      }
    : null;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        Issue reproduction
      </Typography.Title>
      {view.claim && <Prose>{view.claim}</Prose>}
      <AssessmentSummary assessment={view.assessment} recorded={view.recorded} />
      <Collapse
        items={[
          {
            key: "reproduction-identity",
            label: "Frozen reproduction identity",
            children: (
              <Facts
                items={[
                  {
                    label: "Tested source commit",
                    value: <CopyValue value={view.assessment.testedSourceCommit} />,
                  },
                  {
                    label: "Reproduction binding digest",
                    value: <CopyValue value={view.assessment.bindingDigest} />,
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Table<CaseRow>
        size="small"
        rowKey={(entry) => JSON.stringify([entry.requestId, entry.caseId])}
        dataSource={view.cases}
        scroll={{ x: view.recorded ? 900 : 760 }}
        pagination={{
          current: page,
          pageSize: 10,
          total: view.cases.length,
          hideOnSinglePage: true,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: "Case context",
            render: (_, entry) => (
              <Space orientation="vertical" size={4}>
                <Typography.Paragraph
                  strong
                  ellipsis={{ rows: 2 }}
                  style={{ margin: 0, maxWidth: 360 }}
                >
                  {entry.context ?? `${reproductionTargetLabel[entry.target]} reproduction case`}
                </Typography.Paragraph>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, overflowWrap: "anywhere" }}
                >
                  {entry.caseId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Target / frozen profile",
            render: (_, entry) => (
              <Space orientation="vertical" size={4}>
                <Typography.Text>{reproductionTargetLabel[entry.target]}</Typography.Text>
                <Typography.Text type="secondary">
                  {entry.profileLabel ?? entry.profileVersionId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Current case state",
            render: (_, entry) => (
              <Space orientation="vertical" size={4}>
                <CaseState assessment={entry.current} />
                {entry.current?.reasons.map((reason) => (
                  <Typography.Text key={reason} type="secondary">
                    {reproductionReasonLabel[reason]}
                  </Typography.Text>
                ))}
              </Space>
            ),
          },
          ...(view.recorded
            ? [
                {
                  title: "Recorded case state",
                  render: (_: unknown, entry: CaseRow) => (
                    <CaseState assessment={entry.recorded} current={false} />
                  ),
                },
              ]
            : []),
          {
            title: "Details",
            render: (_, entry) => (
              <Button
                type={selected === entry ? "primary" : "default"}
                disabled={!mayRead}
                onClick={() => setSelectedKey(JSON.stringify([entry.requestId, entry.caseId]))}
              >
                Inspect case
              </Button>
            ),
          },
        ]}
      />
      {selection ? (
        <>
          <Divider style={{ marginBlock: 0 }} />
          <CaseDetails
            key={JSON.stringify(reproductionQueryKey(runs.mode, selection, principal, session))}
            selection={selection}
            principal={principal}
            session={session}
            mayRead={mayRead}
            result={view.result}
          />
        </>
      ) : (
        <Typography.Text type="secondary">
          Inspect a case to compare its frozen preconditions and signatures with selected
          observations and exact execution evidence.
        </Typography.Text>
      )}
    </Space>
  );
}

function ReproductionAccess({ view }: { view: ReproductionViewProps }) {
  const access = useOperatorAccess(view.repositoryId);
  const { initialState } = useModel("@@initialState");
  const session = JSON.stringify([
    initialState?.authenticationEpoch ?? 0,
    access.identityKey,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  if (access.pending) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (!access.principal || !access.allows("read"))
    return (
      <Alert
        showIcon
        type="info"
        title="Repository read access is required"
        description="Refresh access to load reproduction assessments and evidence."
        action={
          <Button loading={access.checking} onClick={() => void access.refresh()}>
            Refresh access
          </Button>
        }
      />
    );
  return (
    <ReproductionSession
      key={JSON.stringify([
        runs.mode,
        view.repositoryId,
        view.workItemId,
        view.reviewRunId,
        view.assessment.bindingDigest,
        view.assessment.planDigest,
        view.result?.jobId,
        view.result?.id,
        session,
      ])}
      view={view}
      principal={access.principal}
      session={session}
      mayRead={access.can("read")}
    />
  );
}

export function IssueReproductionSummary({ run }: { run: DashboardReviewRunDetail }) {
  if (run.workItemKind !== "issue") return null;
  const reproduction = run.reproduction;
  if (!reproduction)
    return (
      <Alert
        showIcon
        type="info"
        title="No frozen reproduction claim"
        description="This run has no configured reproduction cases. Triage conclusions and passed checks alone do not establish whether the issue reproduces."
      />
    );
  return (
    <ReproductionAccess
      view={{
        repositoryId: run.repositoryId,
        workItemId: run.workItemId,
        reviewRunId: run.id,
        claim: reproduction.claim,
        assessment: reproduction.assessment,
        cases: reproduction.cases.map((entry) => {
          const request = run.requests.find((request) => request.requestId === entry.requestId);
          const profile = request?.profile;
          const current = reproduction.assessment.cases.find(
            (assessment) =>
              assessment.caseId === entry.caseId && assessment.requestId === entry.requestId,
          );
          return {
            ...entry,
            profileLabel: profile ? `${profile.name} · v${profile.version}` : undefined,
            current,
            executionKey: JSON.stringify([
              request?.latestJob,
              request?.latestResult?.id,
              request?.latestResult?.evidenceComplete,
              request?.latestResult?.evidenceVerificationPending,
              current,
            ]),
          };
        }),
      }}
    />
  );
}

export function IssueReproductionResult({ result }: { result: DashboardReviewRunResult }) {
  if (result.report.workItemKind !== "issue") return null;
  const reproduction = result.reproduction;
  if (!reproduction)
    return (
      <Alert
        showIcon
        type="info"
        title="No frozen reproduction assessment"
        description="This saved result has no assessment bound to configured reproduction cases. Any legacy worker or model conclusion remains separate from a verified reproduction assessment."
      />
    );
  return (
    <ReproductionAccess
      view={{
        repositoryId: result.repositoryId,
        workItemId: result.workItemId,
        reviewRunId: result.reviewRunId,
        assessment: reproduction.currentAssessment,
        recorded: reproduction.recordedAssessment,
        result,
        cases: reproduction.currentAssessment.cases.map((entry) => ({
          ...entry,
          current: entry,
          executionKey: JSON.stringify([
            result.authoritative,
            result.evidenceComplete,
            result.evidenceVerificationPending,
            entry,
          ]),
          recorded: reproduction.recordedAssessment.cases.find(
            (recorded) =>
              recorded.caseId === entry.caseId && recorded.requestId === entry.requestId,
          ),
        })),
      }}
    />
  );
}
