import AccessTimeOutlined from "@mui/icons-material/AccessTimeOutlined";
import { Stack, Tooltip, Typography } from "@mui/material";
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
    return (
      <Typography component="span" variant="body2" color="text.secondary">
        Unleased
      </Typography>
    );
  }

  return (
    <Tooltip title={new Date(expiresAt).toLocaleString()}>
      <Stack
        component="span"
        direction="row"
        sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}
      >
        <AccessTimeOutlined sx={{ fontSize: 20 }} />
        <Typography
          component="span"
          variant="body2"
          color={remaining < 30 ? "error.main" : "text.primary"}
        >
          {remaining}s
        </Typography>
      </Stack>
    </Tooltip>
  );
}
