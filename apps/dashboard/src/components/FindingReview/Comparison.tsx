import type { DashboardReviewRunResult, OperatorPrincipal } from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Button,
  MenuItem,
  Pagination,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type FindingScope, findings } from "@/services/findings";
import { runs } from "@/services/runs";
import { ErrorNotice, readable, timestamp } from "../ReviewRuns/common";
import { FindingComparisonView } from "./presentation";
import { findingAccessDenied, findingContextMatchesResult, findingQueryKey } from "./state";
export function FindingComparison({
  result,
  principal,
  onDenied,
}: {
  result: DashboardReviewRunResult;
  principal: OperatorPrincipal;
  onDenied: () => void;
}) {
  const key = [...findingQueryKey(findings.mode, result, principal), "comparison"];
  const [runPage, setRunPage] = useState(1);
  const [jobPage, setJobPage] = useState(1);
  const [page, setPage] = useState(1);
  const [runId, setRunId] = useState<string>();
  const [requestId, setRequestId] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const [baseline, setBaseline] = useState<{
    scope: FindingScope;
    resultId: string;
    resultDigest: string;
  }>();
  const runList = useQuery({
    queryKey: [...key, "runs", runPage],
    retry: false,
    refetchOnMount: "always",
    queryFn: async () => {
      const response = await runs.list(result.repositoryId, {
        workItemId: result.workItemId,
        page: runPage,
        pageSize: 20,
      });
      if (
        response.items.some(
          (item) =>
            item.repositoryId !== result.repositoryId ||
            item.workItemId !== result.workItemId ||
            item.workItemKind !== result.report.workItemKind,
        )
      )
        throw new Error("The baseline run list does not match this work item.");
      return response;
    },
  });
  const runQuery = useQuery({
    queryKey: [...key, "run", runId],
    retry: false,
    enabled: Boolean(runId),
    refetchOnMount: "always",
    queryFn: async () => {
      if (!runId) throw new Error("Select a baseline run.");
      const response = await runs.get(result.repositoryId, runId);
      if (
        response.id !== runId ||
        response.repositoryId !== result.repositoryId ||
        response.workItemId !== result.workItemId ||
        response.workItemKind !== result.report.workItemKind
      )
        throw new Error("The baseline run does not match this work item.");
      return response;
    },
  });
  const jobs = useQuery({
    queryKey: [...key, "jobs", runId, requestId, jobPage],
    retry: false,
    enabled: Boolean(
      runId &&
        requestId &&
        !runQuery.isError &&
        runQuery.data?.requests.some((request) => request.requestId === requestId),
    ),
    refetchOnMount: "always",
    queryFn: () => {
      if (!runId || !requestId) throw new Error("Select a baseline request.");
      return runs.listJobs(result.repositoryId, runId, requestId, {
        page: jobPage,
        pageSize: 20,
      });
    },
  });
  const comparison = useQuery({
    queryKey: [...key, "rows", baseline, page],
    retry: false,
    enabled: Boolean(baseline),
    refetchOnMount: "always",
    queryFn: async () => {
      if (!baseline) throw new Error("Choose a baseline before comparing findings.");
      const response = await findings.compare(
        {
          repositoryId: result.repositoryId,
          reviewRunId: result.reviewRunId,
          requestId: result.requestId,
          jobId: result.jobId,
        },
        baseline.scope,
        {
          page,
          pageSize: 20,
        },
      );
      if (
        !findingContextMatchesResult(response.after, result) ||
        response.before.resultId !== baseline.resultId ||
        response.before.resultDigest !== baseline.resultDigest ||
        response.before.workItemId !== result.workItemId
      )
        throw new Error("The comparison does not match the selected immutable results.");
      return response;
    },
  });
  const denied = [runList.error, runQuery.error, jobs.error, comparison.error].some(
    findingAccessDenied,
  );
  useEffect(() => {
    if (denied) onDenied();
  }, [denied, onDenied]);
  if (denied)
    return (
      <Alert severity="info">
        <AlertTitle>{"Finding comparison unavailable"}</AlertTitle>
        {"Refresh repository access before viewing this comparison."}
      </Alert>
    );
  const selectedJob = !jobs.isError
    ? jobs.data?.items.find((job) => job.jobId === jobId)
    : undefined;
  return (
    <Stack spacing={3} sx={{ width: "100%", minWidth: 0 }}>
      <Typography variant="body1" component="p" color="text.secondary">
        Choose an earlier saved job for the same PR or Issue. Comparison is explicit; no result is
        selected automatically. The server checks workflow, target, profile and prompt versions, and
        complete model outputs.
      </Typography>
      {runList.isError ? (
        <ErrorNotice
          title="Could not load baseline runs"
          error={runList.error}
          retry={() => void runList.refetch()}
        />
      ) : (
        <>
          <TextField
            style={{
              width: "100%",
            }}
            value={runId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setRunId(value);
              setRequestId(undefined);
              setJobId(undefined);
              setBaseline(undefined);
              setJobPage(1);
              setPage(1);
            }}
            select
            fullWidth
            size="medium"
            label="Baseline run"
            helperText={runList.isFetching ? "Loading options…" : undefined}
          >
            <MenuItem value="" disabled>
              {"Select baseline run"}
            </MenuItem>
            {runList.data?.items.map((run) => (
              <MenuItem key={run.id} value={run.id}>
                {`${timestamp(run.createdAt)} · ${run.id}`}
              </MenuItem>
            ))}
          </TextField>
          {Math.ceil((runList.data?.total ?? 0) / 20) > 1 && (
            <Pagination
              size="medium"
              onChange={(_event, next) => setRunPage(next)}
              page={runPage}
              count={Math.ceil((runList.data?.total ?? 0) / 20)}
              color="primary"
            />
          )}
        </>
      )}
      {runQuery.isError ? (
        <ErrorNotice
          title="Could not load baseline requests"
          error={runQuery.error}
          retry={() => void runQuery.refetch()}
        />
      ) : (
        runId && (
          <TextField
            style={{
              width: "100%",
            }}
            value={requestId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setRequestId(value);
              setJobId(undefined);
              setBaseline(undefined);
              setJobPage(1);
              setPage(1);
            }}
            select
            fullWidth
            size="medium"
            label="Baseline request"
            helperText={runQuery.isFetching ? "Loading options…" : undefined}
          >
            <MenuItem value="" disabled>
              {"Select baseline request"}
            </MenuItem>
            {runQuery.data?.requests.map((request) => (
              <MenuItem key={request.requestId} value={request.requestId}>
                {`${readable(request.workflowKind)} · ${readable(request.target)} · ${request.profile?.name ?? request.requestId}`}
              </MenuItem>
            ))}
          </TextField>
        )
      )}
      {jobs.isError ? (
        <ErrorNotice
          title="Could not load baseline jobs"
          error={jobs.error}
          retry={() => void jobs.refetch()}
        />
      ) : (
        requestId && (
          <>
            <TextField
              style={{
                width: "100%",
              }}
              value={jobId ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setJobId(value);
                setBaseline(undefined);
                setPage(1);
              }}
              select
              fullWidth
              size="medium"
              label="Baseline saved job"
              helperText={jobs.isFetching ? "Loading options…" : undefined}
            >
              <MenuItem value="" disabled>
                {"Select baseline saved job"}
              </MenuItem>
              {jobs.data?.items.map((job) => (
                <MenuItem
                  key={job.jobId}
                  value={job.jobId}
                  disabled={
                    job.resultId === null || job.resultDigest === null || job.jobId === result.jobId
                  }
                >
                  {`Activation ${job.activationNumber} · ${timestamp(job.createdAt)} · ${job.jobId}${job.resultId ? "" : " · No saved result"}`}
                </MenuItem>
              ))}
            </TextField>
            {Math.ceil((jobs.data?.total ?? 0) / 20) > 1 && (
              <Pagination
                size="medium"
                onChange={(_event, next) => setJobPage(next)}
                page={jobPage}
                count={Math.ceil((jobs.data?.total ?? 0) / 20)}
                color="primary"
              />
            )}
          </>
        )
      )}
      <Button
        disabled={
          !runId ||
          !requestId ||
          !selectedJob?.resultId ||
          !selectedJob.resultDigest ||
          runQuery.isError ||
          runList.isError ||
          jobs.isFetching
        }
        onClick={() => {
          if (runId && requestId && selectedJob?.resultId && selectedJob.resultDigest) {
            setBaseline({
              scope: {
                repositoryId: result.repositoryId,
                reviewRunId: runId,
                requestId,
                jobId: selectedJob.jobId,
              },
              resultId: selectedJob.resultId,
              resultDigest: selectedJob.resultDigest,
            });
            setPage(1);
          }
        }}
        variant="contained"
      >
        Compare selected results
      </Button>
      {baseline &&
        (comparison.isError ? (
          <ErrorNotice
            title="Could not compare findings"
            error={comparison.error}
            retry={() => void comparison.refetch()}
          />
        ) : !comparison.data ? (
          <Skeleton variant="rounded" height={72} />
        ) : (
          <>
            <FindingComparisonView comparison={comparison.data} />
            {Math.ceil(comparison.data.total / 20) > 1 && (
              <Pagination
                disabled={comparison.isFetching}
                onChange={(_event, next) => setPage(next)}
                page={page}
                count={Math.ceil(comparison.data.total / 20)}
                color="primary"
                size="medium"
              />
            )}
          </>
        ))}
    </Stack>
  );
}
