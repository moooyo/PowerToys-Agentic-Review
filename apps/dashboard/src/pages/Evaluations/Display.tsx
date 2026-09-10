import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { useState } from "react";
import { type DataColumn, DataTable, notify } from "@/components/ui";

export function CopyValue({ value, className }: { value: string; className?: string }) {
  return (
    <Box
      component="span"
      className={className}
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, minWidth: 0 }}
    >
      <Typography
        component="code"
        variant="body2"
        sx={{ fontFamily: '"Roboto Mono", monospace', overflowWrap: "anywhere" }}
      >
        {value}
      </Typography>
      <Tooltip title="Copy value">
        <IconButton
          aria-label={`Copy ${value}`}
          onClick={() => {
            if (!navigator.clipboard) {
              notify("Clipboard access is unavailable in this browser", "error");
              return;
            }
            void navigator.clipboard.writeText(value).then(
              () => notify("Copied to clipboard"),
              () => notify("The value could not be copied", "error"),
            );
          }}
        >
          <ContentCopyIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/** Local result arrays are sliced before reaching the shared Material table. */
export function EvaluationTable<T>({
  rows,
  columns,
  getRowId,
  loading,
  pageSize: initialPageSize = 10,
  emptyTitle,
  emptyDescription,
  ariaLabel,
}: {
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string | number;
  loading?: boolean;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  ariaLabel?: string;
}) {
  const [position, setPosition] = useState({ page: 1, pageSize: initialPageSize });
  const page = Math.min(position.page, Math.max(1, Math.ceil(rows.length / position.pageSize)));
  return (
    <DataTable
      rows={rows.slice((page - 1) * position.pageSize, page * position.pageSize)}
      columns={columns}
      getRowId={getRowId}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      ariaLabel={ariaLabel}
      pagination={{
        page,
        pageSize: position.pageSize,
        total: rows.length,
        onChange: (nextPage, pageSize) =>
          setPosition({ page: pageSize === position.pageSize ? nextPage : 1, pageSize }),
      }}
    />
  );
}
