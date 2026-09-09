import { Alert, Button, Descriptions, Space, Typography } from "antd";
import type { ReactNode } from "react";

export function readable(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString("en-US");
}

export function CopyValue({ value }: { value: string | null | undefined }) {
  return value ? (
    <Typography.Text code copyable={{ text: value }} style={{ overflowWrap: "anywhere" }}>
      {value}
    </Typography.Text>
  ) : (
    <Typography.Text type="secondary">Not recorded</Typography.Text>
  );
}

export function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <Descriptions
      size="small"
      column={1}
      items={items.map(({ label, value }) => ({ key: label, label, children: value }))}
    />
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return (
    <Typography.Paragraph style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {children}
    </Typography.Paragraph>
  );
}

export function ErrorNotice({
  title,
  error,
  retry,
}: {
  title: string;
  error: unknown;
  retry: () => void;
}) {
  return (
    <Alert
      type="error"
      showIcon
      title={title}
      description={error instanceof Error ? error.message : "The request could not be completed."}
      action={
        <Button size="small" onClick={retry}>
          Retry
        </Button>
      }
    />
  );
}

export function EvidenceIds({ ids }: { ids: string[] }) {
  return ids.length ? (
    <Space orientation="vertical" size={4} style={{ maxWidth: "100%" }}>
      {ids.map((id) => (
        <CopyValue key={id} value={id} />
      ))}
    </Space>
  ) : (
    <Typography.Text type="secondary">No evidence IDs recorded</Typography.Text>
  );
}
