import type { DashboardReviewRunResult, OperatorPrincipal } from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Pagination, Select, Skeleton, Space, Typography } from "antd";
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
      return runs.listJobs(result.repositoryId, runId, requestId, { page: jobPage, pageSize: 20 });
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
        { page, pageSize: 20 },
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
      <Alert
        type="info"
        title="Finding comparison unavailable"
        description="Refresh repository access before viewing this comparison."
      />
    );
  const selectedJob = !jobs.isError
    ? jobs.data?.items.find((job) => job.jobId === jobId)
    : undefined;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary">
        Choose an earlier saved job for the same PR or Issue. Comparison is explicit; no result is
        selected automatically. The server checks workflow, target, profile and prompt versions, and
        complete model outputs.
      </Typography.Paragraph>
      {runList.isError ? (
        <ErrorNotice
          title="Could not load baseline runs"
          error={runList.error}
          retry={() => void runList.refetch()}
        />
      ) : (
        <>
          <Select
            aria-label="Baseline run"
            style={{ width: "100%" }}
            loading={runList.isFetching}
            placeholder="Select baseline run"
            value={runId}
            options={runList.data?.items.map((run) => ({
              value: run.id,
              label: `${timestamp(run.createdAt)} · ${run.id}`,
            }))}
            onChange={(value: string) => {
              setRunId(value);
              setRequestId(undefined);
              setJobId(undefined);
              setBaseline(undefined);
              setJobPage(1);
              setPage(1);
            }}
          />
          <Pagination
            size="small"
            current={runPage}
            pageSize={20}
            total={runList.data?.total ?? 0}
            hideOnSinglePage
            showSizeChanger={false}
            onChange={setRunPage}
          />
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
          <Select
            aria-label="Baseline request"
            style={{ width: "100%" }}
            loading={runQuery.isFetching}
            placeholder="Select baseline request"
            value={requestId}
            options={runQuery.data?.requests.map((request) => ({
              value: request.requestId,
              label: `${readable(request.workflowKind)} · ${readable(request.target)} · ${request.profile?.name ?? request.requestId}`,
            }))}
            onChange={(value: string) => {
              setRequestId(value);
              setJobId(undefined);
              setBaseline(undefined);
              setJobPage(1);
              setPage(1);
            }}
          />
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
            <Select
              aria-label="Baseline saved job"
              style={{ width: "100%" }}
              loading={jobs.isFetching}
              placeholder="Select baseline saved job"
              value={jobId}
              options={jobs.data?.items.map((job) => ({
                value: job.jobId,
                label: `Activation ${job.activationNumber} · ${timestamp(job.createdAt)} · ${job.jobId}${job.resultId ? "" : " · No saved result"}`,
                disabled:
                  job.resultId === null || job.resultDigest === null || job.jobId === result.jobId,
              }))}
              onChange={(value: string) => {
                setJobId(value);
                setBaseline(undefined);
                setPage(1);
              }}
            />
            <Pagination
              size="small"
              current={jobPage}
              pageSize={20}
              total={jobs.data?.total ?? 0}
              hideOnSinglePage
              showSizeChanger={false}
              onChange={setJobPage}
            />
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
          <Skeleton active />
        ) : (
          <>
            <FindingComparisonView comparison={comparison.data} />
            <Pagination
              current={page}
              pageSize={20}
              total={comparison.data.total}
              hideOnSinglePage
              showSizeChanger={false}
              disabled={comparison.isFetching}
              onChange={setPage}
            />
          </>
        ))}
    </Space>
  );
}
