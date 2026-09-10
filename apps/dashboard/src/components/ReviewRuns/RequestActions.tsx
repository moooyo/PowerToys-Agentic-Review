import type {
  DashboardReviewRunDetail,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { SchedulingDiagnostics } from "@/components/SchedulingDiagnostics";
import { runs } from "@/services/runs";
import { type SchedulingReadScope, schedulingScopeKey } from "@/services/scheduling";
import {
  cancelUnavailableReason,
  rerunUnavailableReason,
  reviewPermissionUnavailableReason,
} from "./actions";
import { CopyValue } from "./common";

type Intent = { kind: "rerun"; activationId: string } | { kind: "cancel"; jobId: string };

export function RequestActions({
  run,
  request,
  visible = true,
}: {
  run: DashboardReviewRunDetail;
  request: DashboardReviewRunRequest;
  visible?: boolean;
}) {
  const client = useQueryClient();
  const access = useOperatorAccess(run.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sample = runs.mode === "sample";
  const schedulingScope: SchedulingReadScope = {
    kind: "validation_request",
    repositoryId: run.repositoryId,
    workItemId: run.workItemId,
    reviewRunId: run.id,
    requestId: request.requestId,
  };
  const rerunReason =
    permissionReason ??
    (sample ? "Sample mode does not execute jobs." : rerunUnavailableReason(run, request));
  const cancelReason =
    permissionReason ??
    (sample ? "Sample mode does not control real jobs." : cancelUnavailableReason(request));
  const intentReason = intent?.kind === "rerun" ? rerunReason : cancelReason;
  const submit = async () => {
    if (!access.can("review")) {
      setError(permissionReason ?? "Review access is required to change a run.");
      return;
    }
    if (!intent || saving) return;
    if (intentReason) {
      setError(intentReason);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (intent.kind === "rerun") {
        const response = await runs.rerun(run.repositoryId, run.id, request.requestId, {
          activationId: intent.activationId,
        });
        setNotice(
          response.replayed
            ? `Activation ${response.jobActivation} was already created for this request.`
            : `Activation ${response.jobActivation} was created for this profile.`,
        );
      } else {
        const response = await runs.cancel(
          run.repositoryId,
          run.id,
          request.requestId,
          intent.jobId,
        );
        setNotice(
          response.jobState === "cancel_requested"
            ? "Cancellation requested. The worker is stopping this execution."
            : response.changed
              ? "The waiting execution was cancelled."
              : "This execution has already finished; no further change was made.",
        );
      }
      setIntent(null);
      await client.invalidateQueries({ queryKey: ["review-runs", run.repositoryId] });
      await client.invalidateQueries({ queryKey: schedulingScopeKey(schedulingScope) });
      if (request.latestJob)
        await client.invalidateQueries({
          queryKey: schedulingScopeKey({
            kind: "repository_job",
            repositoryId: run.repositoryId,
            workItemId: run.workItemId,
            jobId: request.latestJob.jobId,
          }),
        });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The operation could not be completed.",
      );
      // Keep the same activation ID after a lost response so Retry cannot create a second rerun.
    } finally {
      setSaving(false);
    }
  };
  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Tooltip title={rerunReason}>
          <span>
            <Button
              variant="outlined"
              disabled={rerunReason !== null || saving}
              onClick={() => {
                if (!access.can("review") || rerunReason !== null || saving) return;
                setError(null);
                setIntent({ kind: "rerun", activationId: crypto.randomUUID() });
              }}
            >
              Rerun profile
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={cancelReason}>
          <span>
            <Button
              color="error"
              disabled={cancelReason !== null || saving}
              onClick={() => {
                if (!access.can("review") || cancelReason !== null || saving) return;
                if (request.latestJob) {
                  setError(null);
                  setIntent({ kind: "cancel", jobId: request.latestJob.jobId });
                }
              }}
            >
              Cancel execution
            </Button>
          </span>
        </Tooltip>
      </Stack>
      {permissionReason && (
        <Typography variant="body2" color="text.secondary">
          {permissionReason}
        </Typography>
      )}
      {sample && (
        <Typography variant="body2" color="text.secondary">
          Sample mode · execution controls require a connected server.
        </Typography>
      )}
      <SchedulingDiagnostics scope={schedulingScope} visible={visible} />
      {notice && <Alert severity="success">{notice}</Alert>}
      <Dialog
        open={intent !== null}
        fullWidth
        maxWidth="sm"
        onClose={() => {
          if (saving) return;
          setIntent(null);
          setError(null);
        }}
      >
        <DialogTitle>
          {intent?.kind === "rerun" ? "Rerun this validation profile?" : "Cancel this execution?"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {permissionReason && (
              <Alert severity="info">
                <AlertTitle>Review actions unavailable</AlertTitle>
                {permissionReason}
              </Alert>
            )}
            <Typography variant="subtitle1">
              {request.profile?.name ?? "Validation profile"}
            </Typography>
            <Typography variant="body1">
              {intent?.kind === "rerun"
                ? "This creates another execution using this run's frozen revision, profile, and prompt versions. Existing results are preserved. The server checks current authorization and configuration before creating it; queue admission is separate."
                : "Only the selected job is stopped. Its recorded history and other profile executions are preserved."}
            </Typography>
            <CopyValue value={intent?.kind === "cancel" ? intent.jobId : run.revisionKey} />
            {error && (
              <Alert severity="error">
                <AlertTitle>Operation could not be completed</AlertTitle>
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={saving}
            onClick={() => {
              setIntent(null);
              setError(null);
            }}
          >
            Back
          </Button>
          <Button
            variant="contained"
            color={intent?.kind === "cancel" ? "error" : "primary"}
            disabled={intentReason !== null || saving}
            loading={saving}
            onClick={() => void submit()}
          >
            {error ? "Retry" : intent?.kind === "rerun" ? "Create execution" : "Cancel execution"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
