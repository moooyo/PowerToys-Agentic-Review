import InboxOutlined from "@mui/icons-material/InboxOutlined";
import { Box, type BoxProps, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function PageHeading({
  title,
  subtitle,
  eyebrow,
  action,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box component="header" className="workspace-page-heading">
      {eyebrow && (
        <Typography variant="body2" color="primary" sx={{ mb: 1 }}>
          {eyebrow}
        </Typography>
      )}
      <Box className="workspace-page-title-row">
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography component="h1" variant="h1" sx={{ overflowWrap: "anywhere" }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography
              component="div"
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1, maxWidth: "72ch", overflowWrap: "anywhere" }}
            >
              {subtitle}
            </Typography>
          )}
        </Box>
        {action && <Box className="workspace-page-action">{action}</Box>}
      </Box>
      {children && <Box sx={{ mt: 2 }}>{children}</Box>}
    </Box>
  );
}

export function Surface({ sx, children, ...props }: BoxProps) {
  return (
    <Box
      {...props}
      sx={[
        { minWidth: 0, bgcolor: "background.paper", borderRadius: "16px" },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Stack
      role="status"
      className="workspace-empty-state"
      spacing={1.5}
      sx={{
        py: { xs: 5, sm: 7 },
        px: { xs: 2, sm: 3 },
        textAlign: "center",
        alignItems: "center",
        minWidth: 0,
      }}
    >
      <Box aria-hidden="true" sx={{ color: "text.secondary", display: "flex", mb: 0.5 }}>
        {icon ?? <InboxOutlined sx={{ fontSize: 32 }} />}
      </Box>
      <Typography component="h2" variant="h6" sx={{ overflowWrap: "anywhere" }}>
        {title}
      </Typography>
      {description && (
        <Typography color="text.secondary" sx={{ maxWidth: "58ch", overflowWrap: "anywhere" }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ pt: 1 }}>{action}</Box>}
    </Stack>
  );
}
