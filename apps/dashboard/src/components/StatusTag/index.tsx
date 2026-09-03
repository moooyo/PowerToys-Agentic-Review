import {
  CheckCircleFilled,
  ClockCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleFilled,
  SyncOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import type { ReactNode } from "react";

const statusPresentation: Record<string, { color: string; icon: ReactNode; label: string }> = {
  healthy: { color: "success", icon: <CheckCircleFilled />, label: "Healthy" },
  active: { color: "success", icon: <CheckCircleFilled />, label: "Active" },
  online: { color: "success", icon: <CheckCircleFilled />, label: "Online" },
  disabled: { color: "default", icon: <MinusCircleFilled />, label: "Disabled" },
  busy: { color: "processing", icon: <SyncOutlined spin />, label: "Busy" },
  draining: { color: "warning", icon: <ClockCircleFilled />, label: "Draining" },
  offline: { color: "default", icon: <MinusCircleFilled />, label: "Offline" },
  queued: { color: "default", icon: <ClockCircleFilled />, label: "Queued" },
  leased: { color: "processing", icon: <SyncOutlined spin />, label: "Leased" },
  running: { color: "processing", icon: <SyncOutlined spin />, label: "Running" },
  cancel_requested: {
    color: "warning",
    icon: <ClockCircleFilled />,
    label: "Cancel requested",
  },
  preparing: { color: "processing", icon: <SyncOutlined spin />, label: "Preparing" },
  reviewing: { color: "processing", icon: <SyncOutlined spin />, label: "Reviewing" },
  codex_review: { color: "processing", icon: <SyncOutlined spin />, label: "Codex review" },
  validating: { color: "processing", icon: <SyncOutlined spin />, label: "Validating" },
  validation: { color: "processing", icon: <SyncOutlined spin />, label: "Validation" },
  codex_revision: {
    color: "processing",
    icon: <SyncOutlined spin />,
    label: "Codex revision",
  },
  uploading: { color: "processing", icon: <SyncOutlined spin />, label: "Uploading" },
  completing: { color: "processing", icon: <SyncOutlined spin />, label: "Completing" },
  cancelling: { color: "warning", icon: <ClockCircleFilled />, label: "Cancelling" },
  revising: { color: "processing", icon: <SyncOutlined spin />, label: "Revising" },
  waiting_approval: {
    color: "warning",
    icon: <ClockCircleFilled />,
    label: "Waiting approval",
  },
  publishing: { color: "processing", icon: <SyncOutlined spin />, label: "Publishing" },
  retry_waiting: { color: "warning", icon: <ClockCircleFilled />, label: "Retry waiting" },
  done: { color: "success", icon: <CheckCircleFilled />, label: "Done" },
  succeeded: { color: "success", icon: <CheckCircleFilled />, label: "Succeeded" },
  pending: { color: "processing", icon: <SyncOutlined spin />, label: "Pending" },
  ready: { color: "cyan", icon: <CheckCircleFilled />, label: "Ready" },
  published: { color: "success", icon: <CheckCircleFilled />, label: "Published" },
  approved: { color: "success", icon: <CheckCircleFilled />, label: "Approved" },
  rejected: { color: "error", icon: <CloseCircleFilled />, label: "Rejected" },
  revoked: { color: "error", icon: <CloseCircleFilled />, label: "Revoked" },
  failed: { color: "error", icon: <CloseCircleFilled />, label: "Failed" },
  unavailable: { color: "error", icon: <CloseCircleFilled />, label: "Unavailable" },
  degraded: { color: "warning", icon: <ExclamationCircleFilled />, label: "Degraded" },
  cancelled: { color: "default", icon: <MinusCircleFilled />, label: "Cancelled" },
  stale: { color: "warning", icon: <ExclamationCircleFilled />, label: "Stale" },
  dead_letter: { color: "error", icon: <CloseCircleFilled />, label: "Dead letter" },
  unknown: { color: "warning", icon: <ExclamationCircleFilled />, label: "Unknown" },
  not_connected: { color: "default", icon: <MinusCircleFilled />, label: "Not connected" },
  expired: { color: "default", icon: <MinusCircleFilled />, label: "Expired" },
};

export interface StatusTagProps {
  status: string;
}

export function StatusTag({ status }: StatusTagProps) {
  const presentation = statusPresentation[status] ?? {
    color: "default",
    icon: <MinusCircleFilled />,
    label: status.replaceAll("_", " "),
  };

  return (
    <Tag color={presentation.color} icon={presentation.icon}>
      {presentation.label}
    </Tag>
  );
}
