import type {
  DashboardReviewRunDetail,
  DashboardReviewRunRequest,
} from "@agentic-review/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Space, Tooltip, Typography } from "antd";
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
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <SchedulingDiagnostics scope={schedulingScope} visible={visible} />
      <Space wrap>
        <Tooltip title={rerunReason}>
          <span>
            <Button
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
              danger
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
      </Space>
      {permissionReason && <Typography.Text type="secondary">{permissionReason}</Typography.Text>}
      {sample && (
        <Typography.Text type="secondary">
          Sample mode · execution controls require a connected server.
        </Typography.Text>
      )}
      {notice && <Alert showIcon type="success" title={notice} />}
      <Modal
        open={intent !== null}
        title={
          intent?.kind === "rerun" ? "Rerun this validation profile?" : "Cancel this execution?"
        }
        okText={
          error ? "Retry" : intent?.kind === "rerun" ? "Create execution" : "Cancel execution"
        }
        okButtonProps={{
          danger: intent?.kind === "cancel",
          disabled: intentReason !== null || saving,
        }}
        confirmLoading={saving}
        cancelButtonProps={{ disabled: saving }}
        mask={{ closable: !saving }}
        keyboard={!saving}
        closable={!saving}
        onOk={() => void submit()}
        onCancel={() => {
          if (!saving) {
            setIntent(null);
            setError(null);
          }
        }}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          {permissionReason && (
            <Alert
              showIcon
              type="info"
              title="Review actions unavailable"
              description={permissionReason}
            />
          )}
          <Typography.Text strong>{request.profile?.name ?? "Validation profile"}</Typography.Text>
          <Typography.Paragraph>
            {intent?.kind === "rerun"
              ? "This creates another execution using this run's frozen revision, profile, and prompt versions. Existing results are preserved. The server checks current authorization and configuration before creating it; queue admission is separate."
              : "Only the selected job is stopped. Its recorded history and other profile executions are preserved."}
          </Typography.Paragraph>
          <CopyValue value={intent?.kind === "cancel" ? intent.jobId : run.revisionKey} />
          {error && (
            <Alert
              showIcon
              type="error"
              title="Operation could not be completed"
              description={error}
            />
          )}
        </Space>
      </Modal>
    </Space>
  );
}
