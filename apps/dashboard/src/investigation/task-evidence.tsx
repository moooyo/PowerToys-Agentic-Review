import type {
  InvestigationArtifactMetadataV1,
  InvestigationE2eResult,
  InvestigationLoopCheckpointV1,
  InvestigationTaskArtifactsPage,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import FolderOpenRounded from "@mui/icons-material/FolderOpenRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { type InfiniteData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { investigationApi } from "./api";
import {
  ArtifactCard,
  artifactPreviewKind,
  assertArtifactBinding,
  createAutomaticImagePreviewBudget,
  evidenceAccessDenied,
  useEvidenceAccessGate,
} from "./artifact-panel";
import { E2eCoveragePanel, e2eOutcomeSummary } from "./e2e-panel";
import { sessionIdentity, useInvestigationSession } from "./session";
import "./task-evidence.css";

export function taskArtifactsQueryKey(identity: string, taskId: string, attemptId?: string) {
  return ["investigation-task-artifacts", identity, taskId, attemptId ?? null] as const;
}

export function assertTaskArtifactPage(
  page: InvestigationTaskArtifactsPage,
  taskId: string,
  attemptId?: string,
): InvestigationTaskArtifactsPage {
  if (
    page.taskId !== taskId ||
    page.items.some(
      ({ artifact }) =>
        artifact.taskId !== taskId || (attemptId !== undefined && artifact.attemptId !== attemptId),
    )
  ) {
    throw new Error("The artifact list does not belong to the selected task and attempt.");
  }
  return page;
}

export function taskArtifactRecords(
  pages: readonly InvestigationTaskArtifactsPage[],
): InvestigationArtifactMetadataV1[] {
  const records = new Map<string, InvestigationArtifactMetadataV1>();
  for (const page of pages) {
    for (const metadata of page.items) {
      const previous = records.get(metadata.artifact.id);
      if (previous) assertArtifactBinding(previous.artifact, metadata);
      records.set(metadata.artifact.id, metadata);
    }
  }
  return [...records.values()];
}

export function taskCheckpointE2e(
  task: Pick<InvestigationTaskV1, "id" | "kind">,
  checkpoint: InvestigationLoopCheckpointV1 | null,
  attemptId?: string,
): InvestigationE2eResult | undefined {
  if (
    task.kind !== "pr-e2e" ||
    checkpoint?.taskId !== task.id ||
    (attemptId !== undefined && checkpoint.attemptId !== attemptId)
  ) {
    return undefined;
  }
  return checkpoint.runtime.e2e;
}

interface TaskEvidenceProps {
  task: InvestigationTaskV1;
  attemptId?: string;
  checkpoint: InvestigationLoopCheckpointV1 | null;
  active: boolean;
}

export function TaskEvidencePanel(props: TaskEvidenceProps) {
  const { session } = useInvestigationSession();
  if (!session.authenticated || !session.user.repositoryIds.includes(props.task.repository.id)) {
    return <Alert severity="warning">Evidence is unavailable for the current account.</Alert>;
  }
  const identity = sessionIdentity(session);
  return (
    <ScopedTaskEvidencePanel
      key={JSON.stringify([identity, props.task.id, props.attemptId ?? null])}
      {...props}
      identity={identity}
    />
  );
}

function ScopedTaskEvidencePanel({
  task,
  attemptId,
  checkpoint,
  active,
  identity,
}: TaskEvidenceProps & { identity: string }) {
  const queryClient = useQueryClient();
  const [automaticPreviewBudget] = useState(createAutomaticImagePreviewBudget);
  const access = useEvidenceAccessGate(identity, "task", task.id, attemptId);
  const queryKey = useMemo(
    () => taskArtifactsQueryKey(identity, task.id, attemptId),
    [identity, task.id, attemptId],
  );
  const files = useInfiniteQuery<
    InvestigationTaskArtifactsPage,
    Error,
    InfiniteData<InvestigationTaskArtifactsPage, string | undefined>,
    typeof queryKey,
    string | undefined
  >({
    queryKey,
    enabled: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    initialPageParam: undefined,
    queryFn: async ({ pageParam, signal }) => {
      access.assertAllowed();
      const page = await investigationApi.taskArtifacts(
        task.id,
        {
          ...(attemptId ? { attemptId } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
          limit: 24,
        },
        signal,
      );
      signal.throwIfAborted();
      access.assertAllowed();
      return assertTaskArtifactPage(page, task.id, attemptId);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      active && !access.denied && !evidenceAccessDenied(query.state.error) ? 5_000 : false,
    refetchOnMount: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    refetchOnWindowFocus: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    refetchOnReconnect: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    retry: false,
  });
  useEffect(() => {
    if (!access.denied && !evidenceAccessDenied(files.error)) return;
    if (!access.denied) access.deny();
    queryClient.removeQueries({ queryKey, exact: true });
  }, [access.denied, access.deny, files.error, queryClient, queryKey]);
  const acceptedCheckpoint = checkpoint?.taskId === task.id ? checkpoint : null;
  const result = taskCheckpointE2e(task, acceptedCheckpoint, attemptId);
  const isE2e = task.kind === "pr-e2e";
  const isStatic = task.kind === "pr-review" || task.kind === "issue-investigate";
  let records: InvestigationArtifactMetadataV1[] = [];
  let bindingError: string | undefined;
  if (!files.isError && files.data) {
    try {
      records = taskArtifactRecords(files.data.pages);
    } catch (error) {
      bindingError =
        error instanceof Error ? error.message : "Artifact records could not be verified.";
    }
  }
  const error = files.isError ? files.error.message : bindingError;
  const checkpointMatchesAttempt =
    acceptedCheckpoint && (!attemptId || acceptedCheckpoint.attemptId === attemptId);
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  const sourceRevision =
    subject?.kind === "original_pr" || subject?.kind === "remote_branch"
      ? subject.headSha
      : subject?.kind === "source_commit"
        ? subject.commitSha
        : subject?.kind === "local_patch"
          ? `Patch ${subject.patchDigest} on ${subject.baseSha}`
          : subject?.kind === "issue_snapshot"
            ? "Snapshot only"
            : "Source revision not recorded";

  if (access.denied || evidenceAccessDenied(files.error)) {
    return (
      <Alert
        severity="warning"
        action={
          <Button
            disabled={files.isFetching}
            onClick={() => {
              access.retry();
              void files.refetch();
            }}
          >
            Check access
          </Button>
        }
      >
        Evidence is unavailable for the current account.
      </Alert>
    );
  }

  return (
    <Box className="task-evidence-panel">
      <Box component="header" className="task-evidence-heading">
        <Box>
          <Typography component="h2" variant="h6">
            Stored in workspace
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Uploaded files registered to {attemptId ? "the selected attempt" : "this task"}. Storage
            and test results are recorded separately.
          </Typography>
        </Box>
        <Button
          startIcon={<RefreshRounded />}
          aria-label="Refresh files"
          aria-busy={files.isFetching}
          disabled={files.isFetching}
          onClick={() => void files.refetch()}
        >
          {files.isFetching && !files.isPending ? "Refreshing…" : "Refresh files"}
        </Button>
      </Box>

      {isE2e && result && (
        <Box component="details" className="task-evidence-results">
          <summary>
            <span>Recorded test results</span>
            <Typography component="span" variant="body2" color="text.secondary">
              {e2eOutcomeSummary(result)}
            </Typography>
          </summary>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            From accepted checkpoint {acceptedCheckpoint?.id}, attempt{" "}
            {acceptedCheckpoint?.attemptId}. These recorded outcomes do not establish a new result
            for another attempt.
          </Typography>
          <E2eCoveragePanel result={result} showArtifacts={false} />
        </Box>
      )}
      {isE2e && !result && (
        <Alert severity="info">
          No E2E feature results are recorded in the accepted checkpoint for this selection.
          Uploaded files and task status do not establish passing tests.
        </Alert>
      )}
      {isStatic && (
        <Alert severity="info">
          These files are internal workspace evidence. Static review captures are not application
          test results and are excluded from GitHub media publication.
        </Alert>
      )}
      {!isE2e && !isStatic && (
        <Alert severity="info">
          These files are retained execution evidence. Uploaded files alone do not establish passing
          verification. GitHub media publication requires eligible evidence from an independent E2E
          task.
        </Alert>
      )}

      {error ? (
        <Alert severity="warning">
          Artifact files could not be verified: {error} Refresh the list to check access and
          availability.
        </Alert>
      ) : files.isPending ? (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", py: 3 }} role="status">
          <CircularProgress size={20} />
          <Typography variant="body2">Loading stored files…</Typography>
        </Stack>
      ) : records.length === 0 ? (
        <Box className="task-evidence-empty">
          <FolderOpenRounded aria-hidden="true" sx={{ fontSize: 36, color: "text.secondary" }} />
          <Box>
            <Typography component="h3" variant="h6">
              No stored files{active ? " yet" : ""}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No artifact record is stored for {attemptId ? "this attempt" : "this task"}. Only
              uploaded and registered files appear here.
            </Typography>
          </Box>
        </Box>
      ) : (
        <>
          <Box className="task-evidence-media">
            {records
              .filter(({ artifact }) => artifactPreviewKind(artifact.mediaType))
              .map(({ artifact }) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  recordSource="workspace"
                  automaticPreviewBudget={automaticPreviewBudget}
                />
              ))}
          </Box>
          <Box className="task-evidence-files">
            {records
              .filter(({ artifact }) => !artifactPreviewKind(artifact.mediaType))
              .map(({ artifact }) => (
                <ArtifactCard key={artifact.id} artifact={artifact} recordSource="workspace" />
              ))}
          </Box>
        </>
      )}

      {!error && files.hasNextPage && (
        <Button
          variant="outlined"
          disabled={files.isFetching}
          onClick={() => void files.fetchNextPage()}
          sx={{ justifySelf: "start" }}
        >
          {files.isFetchingNextPage ? "Loading more files…" : "Load more files"}
        </Button>
      )}

      <Box component="details" className="task-evidence-provenance">
        <summary>Evidence source and artifact records</summary>
        <Typography variant="body2" color="text.secondary">
          {records.length} loaded files. Missing or expired content keeps its original artifact
          record. Automatic previews try at most four visible images per panel, up to 8 MiB each.
          Videos load only when opened.
        </Typography>
        <Box component="dl">
          <dt>Producer task</dt>
          <dd>{task.id}</dd>
          <dt>Attempt filter</dt>
          <dd>{attemptId ?? "All producer attempts"}</dd>
          <dt>Source</dt>
          <dd>
            {task.repository.fullName} · {task.workItem.kind === "pull_request" ? "PR" : "Issue"} #
            {task.workItem.number}
          </dd>
          <dt>Subject</dt>
          <dd>{task.subjectRef}</dd>
          <dt>Source revision</dt>
          <dd>{sourceRevision}</dd>
          {acceptedCheckpoint && (
            <>
              <dt>Accepted checkpoint</dt>
              <dd>{acceptedCheckpoint.id}</dd>
              <dt>Checkpoint attempt</dt>
              <dd>{acceptedCheckpoint.attemptId}</dd>
              <dt>Checkpoint recorded</dt>
              <dd>{acceptedCheckpoint.recordedAt}</dd>
            </>
          )}
        </Box>
        {acceptedCheckpoint && !checkpointMatchesAttempt && (
          <Typography variant="body2" color="text.secondary">
            The saved checkpoint belongs to a different attempt. Its test results are not shown for
            this selection.
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          File cards retain each producer attempt and content digest. Refreshing availability does
          not change a checkpoint or the recorded test outcomes.
        </Typography>
      </Box>
      {isE2e && (
        <Box component="details" className="task-evidence-provenance">
          <summary>GitHub publication</summary>
          <Typography variant="body2" color="text.secondary">
            Workspace storage and GitHub delivery are separate. This view does not establish media
            publication or publication eligibility. Publication comments have their own delivery
            history.
          </Typography>
        </Box>
      )}
    </Box>
  );
}
