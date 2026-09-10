import { alpha, Chip, useTheme } from "@mui/material";

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
  cli_review: { color: "processing", label: "CLI review" },
  validating: { color: "processing", label: "Validating" },
  validation: { color: "processing", label: "Validation" },
  cli_revision: {
    color: "processing",
    label: "CLI revision",
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
  const theme = useTheme();
  const presentation = statusPresentation[status] ?? {
    color: "default",
    label: status.replaceAll("_", " "),
  };

  const color = presentation.color === "processing" ? "info" : presentation.color;
  const tone =
    color === "success"
      ? theme.palette.success.main
      : color === "warning"
        ? theme.palette.warning.main
        : color === "error"
          ? theme.palette.error.main
          : color === "info"
            ? theme.palette.primary.main
            : theme.palette.text.secondary;
  return (
    <Chip
      label={presentation.label}
      className="status-tag"
      sx={{
        color: tone,
        bgcolor: alpha(tone, 0.09),
        maxWidth: "100%",
      }}
    />
  );
}
