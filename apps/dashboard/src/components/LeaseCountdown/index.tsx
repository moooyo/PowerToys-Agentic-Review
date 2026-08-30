import { ClockCircleOutlined } from "@ant-design/icons";
import { Space, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";

export interface LeaseCountdownProps {
  expiresAt?: string;
}

export function LeaseCountdown({ expiresAt }: LeaseCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) {
      return undefined;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const remaining = useMemo(
    () =>
      expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000)) : undefined,
    [expiresAt, now],
  );

  if (remaining === undefined || expiresAt === undefined) {
    return <Typography.Text type="secondary">Unleased</Typography.Text>;
  }

  return (
    <Tooltip title={new Date(expiresAt).toLocaleString()}>
      <Space size={5}>
        <ClockCircleOutlined />
        <Typography.Text type={remaining < 30 ? "danger" : undefined}>{remaining}s</Typography.Text>
      </Space>
    </Tooltip>
  );
}
