import type {
  DashboardReviewRunDetail,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  IssueReproductionAssessmentV1,
  IssueReproductionCaseAssessment,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Button,
  Divider,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { runs } from "@/services/runs";
import { useOperatorSession } from "@/state/session";
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
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}
      >
        <Typography variant="h6" component="h3">
          Case detail · {reproductionTargetLabel[selection.target]}
        </Typography>
        <Button
          variant="outlined"
          disabled={!mayRead}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh case
        </Button>
      </Stack>
      {!mayRead ? (
        <Alert severity="info">Repository read access is required</Alert>
      ) : query.isError ? (
        <ErrorNotice
          title="Could not load reproduction case"
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : !loaded ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <>
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 500 }}>
            Frozen reproduction claim
          </Typography>
          <Prose>{loaded.detail.binding.claim}</Prose>
          <ReproductionCaseFacts detail={loaded.detail} result={loaded.savedResult} />
          <Stack>
            <Accordion
              expanded={openPanels.includes("identity")}
              onChange={(_, expanded) =>
                setOpenPanels((panels) =>
                  expanded
                    ? [...panels, "identity"]
                    : panels.filter((panel) => panel !== "identity"),
                )
              }
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                Frozen case and saved result identity
              </AccordionSummary>
              <AccordionDetails>
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
              </AccordionDetails>
            </Accordion>
            <Accordion
              expanded={openPanels.includes("evidence")}
              onChange={(_, expanded) =>
                setOpenPanels((panels) =>
                  expanded
                    ? [...panels, "evidence"]
                    : panels.filter((panel) => panel !== "evidence"),
                )
              }
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                Inspect case evidence ({evidenceReferences(loaded.detail).length} references)
              </AccordionSummary>
              <AccordionDetails>
                {openPanels.includes("evidence") ? (
                  evidenceScope ? (
                    <EvidenceView
                      key={JSON.stringify([session, evidenceScope])}
                      scope={evidenceScope}
                      references={evidenceReferences(loaded.detail)}
                    />
                  ) : (
                    <Alert severity="info">
                      <AlertTitle>No saved execution evidence</AlertTitle>
                      Evidence files become available only for the exact saved job attempt. Missing
                      evidence does not establish absence.
                    </Alert>
                  )
                ) : null}
              </AccordionDetails>
            </Accordion>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Case details and settled summaries refresh every 30 seconds while visible. If evidence
            verification is still pending, use Refresh run or Refresh result to retry it.
          </Typography>
        </>
      )}
    </Stack>
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
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Typography variant="h6" component="h3">
        Issue reproduction
      </Typography>
      {view.claim && <Prose>{view.claim}</Prose>}
      <AssessmentSummary assessment={view.assessment} recorded={view.recorded} />
      <Accordion>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          Frozen reproduction identity
        </AccordionSummary>
        <AccordionDetails>
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
        </AccordionDetails>
      </Accordion>
      <TableContainer>
        <Table
          size="medium"
          aria-label="Issue reproduction cases"
          sx={{ minWidth: view.recorded ? 900 : 760 }}
        >
          <TableHead>
            <TableRow>
              <TableCell>Case context</TableCell>
              <TableCell>Target / frozen profile</TableCell>
              <TableCell>Current case state</TableCell>
              {view.recorded && <TableCell>Recorded case state</TableCell>}
              <TableCell>Details</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {view.cases.slice((page - 1) * 10, page * 10).map((entry) => (
              <TableRow
                key={JSON.stringify([entry.requestId, entry.caseId])}
                selected={selected === entry}
              >
                <TableCell>
                  <Stack spacing={0.5}>
                    <Typography
                      variant="body1"
                      sx={{
                        fontWeight: 500,
                        maxWidth: 360,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {entry.context ??
                        `${reproductionTargetLabel[entry.target]} reproduction case`}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ overflowWrap: "anywhere", fontFamily: '"Roboto Mono", monospace' }}
                    >
                      {entry.caseId}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack spacing={0.5}>
                    <Typography variant="body2">{reproductionTargetLabel[entry.target]}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {entry.profileLabel ?? entry.profileVersionId}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
                    <CaseState assessment={entry.current} />
                    {entry.current?.reasons.map((reason) => (
                      <Typography key={reason} variant="body2" color="text.secondary">
                        {reproductionReasonLabel[reason]}
                      </Typography>
                    ))}
                  </Stack>
                </TableCell>
                {view.recorded && (
                  <TableCell>
                    <CaseState assessment={entry.recorded} current={false} />
                  </TableCell>
                )}
                <TableCell>
                  <Button
                    variant={selected === entry ? "contained" : "outlined"}
                    disabled={!mayRead}
                    onClick={() => setSelectedKey(JSON.stringify([entry.requestId, entry.caseId]))}
                  >
                    Inspect case
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {view.cases.length === 0 && (
              <TableRow>
                <TableCell colSpan={view.recorded ? 5 : 4}>
                  <Typography variant="body2" color="text.secondary">
                    No configured reproduction cases.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {view.cases.length > 10 && (
          <TablePagination
            component="div"
            count={view.cases.length}
            page={page - 1}
            rowsPerPage={10}
            rowsPerPageOptions={[10]}
            onPageChange={(_, nextPage) => setPage(nextPage + 1)}
          />
        )}
      </TableContainer>
      {selection ? (
        <>
          <Divider />
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
        <Typography variant="body2" color="text.secondary">
          Inspect a case to compare its frozen preconditions and signatures with selected
          observations and exact execution evidence.
        </Typography>
      )}
    </Stack>
  );
}

function ReproductionAccess({ view }: { view: ReproductionViewProps }) {
  const access = useOperatorAccess(view.repositoryId);
  const { initialState } = useOperatorSession();
  const session = JSON.stringify([
    initialState?.authenticationEpoch ?? 0,
    access.identityKey,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  if (access.pending) return <Skeleton variant="rounded" height={80} />;
  if (!access.principal || !access.allows("read"))
    return (
      <Alert
        severity="info"
        action={
          <Button loading={access.checking} onClick={() => void access.refresh()}>
            Refresh access
          </Button>
        }
      >
        <AlertTitle>Repository read access is required</AlertTitle>
        Refresh access to load reproduction assessments and evidence.
      </Alert>
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
      <Alert severity="info">
        <AlertTitle>No frozen reproduction claim</AlertTitle>
        This run has no configured reproduction cases. Triage conclusions and passed checks alone do
        not establish whether the issue reproduces.
      </Alert>
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
      <Alert severity="info">
        <AlertTitle>No frozen reproduction assessment</AlertTitle>
        This saved result has no assessment bound to configured reproduction cases. Any legacy
        worker or model conclusion remains separate from a verified reproduction assessment.
      </Alert>
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
