import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  titleId?: string;
  description: string;
  actions?: ReactNode;
}
export function PageHeader({ eyebrow, title, titleId, description, actions }: PageHeaderProps) {
  return (
    <Box component="header" className="page-header" sx={{ mb: 3, pt: 1 }}>
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}
      >
        <Typography variant="h1" component="h1" id={titleId}>
          {title}
        </Typography>
        {actions && (
          <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
            {actions}
          </Stack>
        )}
      </Stack>
      <Stack
        direction={{ xs: "column", md: "row" }}
        sx={{
          alignItems: { xs: "flex-start", md: "baseline" },
          columnGap: 1.5,
          rowGap: 0.5,
          mt: 1.5,
        }}
      >
        <Typography variant="body2" sx={{ color: "primary.main", fontWeight: 500 }}>
          {eyebrow}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {description}
        </Typography>
      </Stack>
    </Box>
  );
}
