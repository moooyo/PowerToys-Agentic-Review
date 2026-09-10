import type * as C from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { CliExecutionDetails } from "@/components/CliExecutionDetails";
import { DetailsGrid } from "@/components/ui";
import {
  createHttpEvaluationAdjudicationAdapter,
  type EvaluationAdjudicationAdapter,
} from "@/services/evaluation-adjudication";
import type { EvaluationBatchAdapter } from "@/services/evaluation-batches";
import {
  createHttpEvaluationEvidenceAdapter,
  type EvaluationEvidenceAdapter,
} from "@/services/evaluation-evidence";
import { Adjudication } from "./Adjudication";
import { armLabels } from "./batch-state";
import {
  assertCellResultBinding,
  type CellResultBinding,
  cellResultBindingKey,
  currentEvidenceLabel,
} from "./cell-result-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CopyValue, EvaluationTable } from "./Display";
import { EvaluationEvidence } from "./EvaluationEvidence";
import { errorMessage } from "./state";
export function CellResultContent({
  result,
  evidenceAdapter,
  active = true,
}: {
  result: C.EvaluationCellResultV1;
  evidenceAdapter?: EvaluationEvidenceAdapter;
  active?: boolean;
}) {
  const model = result.modelReview;
  const evidenceIds = [...new Set(result.report.checks.flatMap((check) => check.evidenceIds))];
  return (
    <div className="evaluation-cell-result">
      <Alert severity={"info"}>
        <AlertTitle>{"Recorded execution and model advice"}</AlertTitle>
        {
          "Check outcomes and model recommendations do not approve a pull request. Expected check values are execution assertions, not the sample set's assessment labels."
        }
      </Alert>
      <DetailsGrid
        items={[
          {
            key: "result",
            label: "Result",
            value: <CopyValue value={result.resultId} />,
          },
          {
            key: "arm",
            label: "Arm",
            value: `${armLabels[result.arm]} · trial ${result.trial}`,
          },
          {
            key: "source",
            label: "Source state",
            value: <Chip label={result.report.sourceState} />,
          },
          {
            key: "evidence",
            label: "Evidence",
            value: <Chip label={currentEvidenceLabel(result)} />,
          },
          {
            key: "revision",
            label: "Frozen revision",
            value: <span className="evaluation-meta">{result.revisionKey}</span>,
          },
          {
            key: "attempt",
            label: "Job attempt",
            value: (
              <span className="evaluation-meta">
                {result.jobId} · {result.runAttemptId}
              </span>
            ),
          },
          {
            key: "profile",
            label: "Profile version",
            value: <span className="evaluation-meta">{result.profileVersionId}</span>,
          },
          {
            key: "prompt",
            label: "Prompt version",
            value: <span className="evaluation-meta">{result.promptVersionId}</span>,
          },
          {
            key: "cleanup",
            label: "Cleanup",
            value: result.execution.cleanupState,
          },
          {
            key: "created",
            label: "Recorded",
            value: result.createdAt,
          },
        ]}
        columns={2}
      />
      <Typography component="p" variant="body2">
        {result.report.summary}
      </Typography>
      {result.report.workItemKind === "issue" ? (
        <p>Runner reproduction conclusion: {result.report.reproductionConclusion}</p>
      ) : null}
      <Typography component="h5" variant="subtitle1">
        Checks
      </Typography>
      <EvaluationTable<C.ValidationCheckResult>
        rows={result.report.checks}
        getRowId={(row) => row.id}
        columns={[
          {
            id: "check",
            label: "Check",
            render: (check) => {
              return (
                <div>
                  <strong>{check.name}</strong>
                  <span className="evaluation-meta">
                    {check.id} · {check.kind} · {check.source} ·{" "}
                    {check.required ? "Required" : "Optional"}
                  </span>
                  <p>{check.summary}</p>
                </div>
              );
            },
          },
          {
            id: "outcome",
            label: "Outcome",
            width: 105,
            render: (row) => row.outcome,
          },
          {
            id: "expected",
            label: "Expected",
            render: (check) => {
              return (
                <span className="evaluation-result-text">{check.expected ?? "Not recorded"}</span>
              );
            },
          },
          {
            id: "actual",
            label: "Actual",
            render: (check) => {
              return (
                <span className="evaluation-result-text">{check.actual ?? "Not recorded"}</span>
              );
            },
          },
          {
            id: "evidence",
            label: "Evidence IDs",
            render: (check) => {
              return check.evidenceIds.map((id) => (
                <span key={id} className="evaluation-meta">
                  {id}
                </span>
              ));
            },
          },
        ]}
        ariaLabel="Evaluation records"
        pageSize={10}
      />
      <Typography component="h5" variant="subtitle1">
        Execution diagnostics
      </Typography>
      {result.execution.blockers.length ? (
        <EvaluationTable<
          C.ValidationLifecycleBlocker & {
            ordinal: number;
          }
        >
          rows={result.execution.blockers.map((blocker, ordinal) => ({
            ...blocker,
            ordinal,
          }))}
          getRowId={(row) => row.ordinal}
          columns={[
            {
              id: "phase",
              label: "Phase",
              render: (row) => row.phase,
            },
            {
              id: "code",
              label: "Code",
              render: (row) => row.code,
            },
            {
              id: "message",
              label: "Blocker",
              render: (row) => row.message,
            },
          ]}
          ariaLabel="Evaluation records"
          pageSize={10}
        />
      ) : (
        <Typography component="span" variant="body2" color={"text.secondary"}>
          No execution blockers were recorded.
        </Typography>
      )}
      <EvaluationTable<
        C.ValidationStepDiagnostic & {
          ordinal: number;
        }
      >
        rows={result.execution.diagnostics.map((diagnostic, ordinal) => ({
          ...diagnostic,
          ordinal,
        }))}
        getRowId={(row) => row.ordinal}
        columns={[
          {
            id: "step",
            label: "Step",
            render: (diagnostic) => {
              return (
                <span className="evaluation-meta">
                  {diagnostic.phase} · {diagnostic.stepId}
                </span>
              );
            },
          },
          {
            id: "outcome",
            label: "Outcome",
            render: (diagnostic) => {
              return `${diagnostic.outcome} · exit ${diagnostic.exitCode ?? "not recorded"}`;
            },
          },
          {
            id: "diagnostic",
            label: "Diagnostic",
            render: (diagnostic) => {
              return (
                <div>
                  <p>{diagnostic.summary}</p>
                  {diagnostic.stdout !== undefined ? (
                    <pre className="evaluation-source-body">{diagnostic.stdout}</pre>
                  ) : null}
                  {diagnostic.stderr !== undefined ? (
                    <pre className="evaluation-source-body">{diagnostic.stderr}</pre>
                  ) : null}
                </div>
              );
            },
          },
        ]}
        ariaLabel="Evaluation records"
        pageSize={10}
      />
      <Card variant="outlined">
        <CardHeader
          title={"Model advice"}
          action={<Chip label={result.modelRequirements.required ? model.state : "Not required"} />}
          slotProps={{
            title: {
              variant: "subtitle1",
              component: "h3",
            },
          }}
        />
        <CardContent>
          {!result.modelRequirements.required ? (
            <Typography component="p" variant="body2">
              Model execution was not required for this cell. This is not a model failure.
            </Typography>
          ) : null}
          {result.modelRequirements.required && model.error ? (
            <Alert severity={"warning"}>
              <AlertTitle>{model.error.code}</AlertTitle>
              {model.error.message}
            </Alert>
          ) : null}
          <CliExecutionDetails execution={model.execution} />
          {model.summary ? (
            <Typography component="p" variant="body2">
              {model.summary}
            </Typography>
          ) : null}
          {model.recommendation ? <p>Model recommendation: {model.recommendation}</p> : null}
          {model.reproductionConclusion ? (
            <p>Model reproduction advice: {model.reproductionConclusion}</p>
          ) : null}
          {model.issueTriage ? (
            <DetailsGrid
              items={[
                {
                  key: "triage",
                  label: "Triage",
                  value: `${model.issueTriage.category} · priority ${model.issueTriage.priority} · confidence ${model.issueTriage.confidence}`,
                },
                {
                  key: "labels",
                  label: "Suggested labels",
                  value: model.issueTriage.suggestedLabels.join(", ") || "None",
                },
                {
                  key: "missing",
                  label: "Missing information",
                  value: model.issueTriage.missingInformation.join("; ") || "None",
                },
                {
                  key: "duplicates",
                  label: "Duplicate candidates",
                  value:
                    model.issueTriage.duplicateCandidates
                      .map((entry) => JSON.stringify(entry))
                      .join("; ") || "None",
                },
              ]}
              columns={1}
            />
          ) : null}
          <Typography component="h5" variant="subtitle1">
            Findings
          </Typography>
          <EvaluationTable
            rows={model.findings}
            getRowId={(row) => row.ordinal}
            columns={[
              {
                id: "priority",
                label: "Priority",
                width: 80,
                render: (row) => row.priority,
              },
              {
                id: "finding",
                label: "Finding",
                render: (finding) => {
                  return (
                    <div>
                      <strong>{finding.title}</strong>
                      <p className="evaluation-result-text">{finding.body}</p>
                      <span className="evaluation-meta">
                        {finding.findingId} · occurrence {finding.ordinal} ·{" "}
                        {finding.path ?? "No file"}
                        {finding.line ? `:${finding.line}` : ""}
                      </span>
                    </div>
                  );
                },
              },
            ]}
            ariaLabel="Evaluation records"
            pageSize={10}
          />
          <Typography component="h5" variant="subtitle1">
            Observations
          </Typography>
          <EvaluationTable<
            C.ValidationObservation & {
              ordinal: number;
            }
          >
            rows={model.observations.map((observation, ordinal) => ({
              ...observation,
              ordinal,
            }))}
            getRowId={(row) => row.ordinal}
            columns={[
              {
                id: "priority",
                label: "Priority",
                width: 80,
                render: (row) => row.priority,
              },
              {
                id: "observation",
                label: "Observation",
                render: (observation) => {
                  return (
                    <div>
                      <strong>{observation.title}</strong>
                      <p className="evaluation-result-text">{observation.body}</p>
                      <span className="evaluation-meta">
                        {observation.id} · {observation.path ?? "No file"}
                        {observation.line ? `:${observation.line}` : ""}
                      </span>
                    </div>
                  );
                },
              },
            ]}
            ariaLabel="Evaluation records"
            pageSize={10}
          />
        </CardContent>
      </Card>
      {evidenceAdapter ? (
        <EvaluationEvidence result={result} adapter={evidenceAdapter} active={active} />
      ) : (
        <>
          <Typography component="h5" variant="subtitle1">
            Evidence references
          </Typography>
          <p className="evaluation-meta">
            These are the result's recorded evidence IDs. Evaluation evidence download is not
            available in this view; no file availability is inferred from an ID.
          </p>
          {evidenceIds.length ? (
            <Stack
              direction="column"
              spacing={1.5}
              sx={{
                minWidth: 0,
              }}
            >
              {evidenceIds.map((id) => (
                <CopyValue key={id} value={id} />
              ))}
            </Stack>
          ) : (
            <Typography component="span" variant="body2" color={"text.secondary"}>
              No evidence IDs were recorded.
            </Typography>
          )}
        </>
      )}
    </div>
  );
}
export interface RetainedAdjudicationResult {
  identity: string;
  result: C.EvaluationCellResultV1;
}
export function retainAdjudicationResult(
  previous: RetainedAdjudicationResult | null,
  identity: string | null,
  verified: C.EvaluationCellResultV1 | undefined,
): RetainedAdjudicationResult | null {
  if (identity === null) return previous;
  if (verified)
    return {
      identity,
      result: verified,
    };
  return previous?.identity === identity ? previous : null;
}
export function CellResultDrawer({
  api,
  binding,
  active,
  onClose,
  evidenceAdapter,
  adjudicationAdapter,
}: {
  api: EvaluationBatchAdapter;
  binding: CellResultBinding | null;
  active: boolean;
  onClose: () => void;
  evidenceAdapter?: EvaluationEvidenceAdapter;
  adjudicationAdapter?: EvaluationAdjudicationAdapter;
}) {
  const page = useEvaluationPage();
  const evidence = useMemo(
    () => evidenceAdapter ?? createHttpEvaluationEvidenceAdapter(),
    [evidenceAdapter],
  );
  const adjudication = useMemo(
    () => adjudicationAdapter ?? createHttpEvaluationAdjudicationAdapter(),
    [adjudicationAdapter],
  );
  const [adjudicationResult, setAdjudicationResult] = useState<RetainedAdjudicationResult | null>(
    null,
  );
  const identity = binding ? cellResultBindingKey(binding) : null;
  const query = useEvaluationQuery(
    ["cell-result", binding ? cellResultBindingKey(binding) : null],
    async (signal) => {
      if (!binding) throw new Error("Select a current result before reading it.");
      const result = await api.getCellResult(binding.scope, signal);
      assertCellResultBinding(result, binding);
      return result;
    },
    active && binding !== null,
  );
  useEffect(() => {
    setAdjudicationResult((previous) =>
      retainAdjudicationResult(
        previous,
        identity,
        !query.isFetching && !query.error ? query.data : undefined,
      ),
    );
  }, [identity, query.data, query.isFetching, query.error]);
  const adjudicationActive =
    active &&
    page.readable &&
    identity !== null &&
    identity === adjudicationResult?.identity &&
    !query.isFetching &&
    !query.error &&
    query.data !== undefined;
  const close = () => {
    setAdjudicationResult(null);
    onClose();
  };
  return (
    <Drawer
      open={active && page.readable && binding !== null}
      onClose={close}
      anchor="right"
      sx={{ visibility: active && page.readable ? "visible" : "hidden" }}
      slotProps={{
        paper: {
          sx: {
            width: 1100,
            maxWidth: "100vw",
            p: { xs: 2, sm: 3 },
          },
          role: "dialog",
          "aria-label": "Evaluation result",
        },
      }}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 2,
          mb: 3,
        }}
      >
        <Typography variant="h5" component="h2" sx={{ flex: 1, minWidth: 200 }}>
          {binding
            ? `${armLabels[binding.expected.arm]} result · ${binding.caseTitle}`
            : "Evaluation result"}
        </Typography>
        {
          <Button
            disabled={!active || !page.readable || !binding}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            variant="outlined"
          >
            Refresh evidence
          </Button>
        }
        <IconButton aria-label="Close evaluation result" onClick={close}>
          <CloseIcon />
        </IconButton>
      </Stack>
      {query.isFetching || query.isPending ? (
        <Skeleton variant="rounded" height={168} aria-label="Loading evaluation content" />
      ) : query.error ? (
        <Alert severity={"error"}>
          <AlertTitle>{"Result unavailable"}</AlertTitle>
          {errorMessage(query.error)}
        </Alert>
      ) : active && binding && query.data ? (
        <CellResultContent
          result={query.data}
          evidenceAdapter={evidence}
          active={active && page.readable}
        />
      ) : null}
      {adjudicationResult && (identity === null || identity === adjudicationResult.identity) ? (
        <div
          hidden={!adjudicationActive}
          inert={!adjudicationActive}
          aria-hidden={!adjudicationActive}
        >
          <Adjudication
            key={JSON.stringify([page.session, adjudicationResult.identity])}
            result={adjudicationResult.result}
            adapter={adjudication}
            active={adjudicationActive}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
