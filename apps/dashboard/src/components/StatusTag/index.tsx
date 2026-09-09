import { Tag } from "antd";
import "./index.css";

const statusPresentation: Record<string, { color: string; label: string }> = {
  healthy: { color: "success", label: "Healthy" },
  active: { color: "success", label: "Active" },
  online: { color: "success", label: "Online" },
  disabled: { color: "default", label: "Disabled" },
  busy: { color: "processing", label: "Busy" },
  draining: { color: "warning", label: "Draining" },
  offline: { color: "default", label: "Offline" },
  queued: { color: "default", label: "Queued" },
  awaiting_admission: { color: "processing", label: "Awaiting admission" },
  not_scheduled: { color: "default", label: "Not scheduled" },
  leased: { color: "processing", label: "Leased" },
  running: { color: "processing", label: "Running" },
  cancel_requested: {
    color: "warning",
    label: "Cancel requested",
  },
  preparing: { color: "processing", label: "Preparing" },
  reviewing: { color: "processing", label: "Reviewing" },
  codex_review: { color: "processing", label: "Codex review" },
  validating: { color: "processing", label: "Validating" },
  validation: { color: "processing", label: "Validation" },
  codex_revision: {
    color: "processing",
    label: "Codex revision",
  },
  uploading: { color: "processing", label: "Uploading" },
  completing: { color: "processing", label: "Completing" },
  cancelling: { color: "warning", label: "Cancelling" },
  revising: { color: "processing", label: "Revising" },
  waiting_approval: {
    color: "warning",
    label: "Waiting approval",
  },
  publishing: { color: "processing", label: "Publishing" },
  retry_waiting: { color: "warning", label: "Retry waiting" },
  done: { color: "default", label: "Finished" },
  succeeded: { color: "success", label: "Succeeded" },
  pending: { color: "processing", label: "Pending" },
  ready: { color: "processing", label: "Ready" },
  published: { color: "success", label: "Published" },
  approved: { color: "success", label: "Approved" },
  rejected: { color: "error", label: "Rejected" },
  revoked: { color: "error", label: "Revoked" },
  failed: { color: "error", label: "Failed" },
  unavailable: { color: "error", label: "Unavailable" },
  degraded: { color: "warning", label: "Degraded" },
  cancelled: { color: "default", label: "Cancelled" },
  stale: { color: "warning", label: "Superseded" },
  dead_letter: { color: "error", label: "Retry limit reached" },
  unknown: { color: "default", label: "Unknown" },
  not_connected: { color: "default", label: "Not connected" },
  expired: { color: "default", label: "Expired" },
};

export interface StatusTagProps {
  status: string;
}

export function StatusTag({ status }: StatusTagProps) {
  const presentation = statusPresentation[status] ?? {
    color: "default",
    label: status.replaceAll("_", " "),
  };

  return (
    <Tag className="status-tag" color={presentation.color}>
      {presentation.label}
    </Tag>
  );
}
