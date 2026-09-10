import InboxOutlined from "@mui/icons-material/InboxOutlined";
import type { AlertColor } from "@mui/material";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";

export interface DataColumn<T> {
  id: string;
  label: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: "left" | "center" | "right";
  width?: number | string;
  minWidth?: number;
}

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  loading = false,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  onRowClick,
  ariaLabel = "Records",
  pagination,
}: {
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string | number;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  ariaLabel?: string;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    pageSizeOptions?: readonly number[];
    onChange: (page: number, pageSize: number) => void;
  };
}) {
  return (
    <Box sx={{ minWidth: 0, position: "relative" }}>
      {loading && (
        <LinearProgress
          aria-label="Loading records"
          sx={{ position: "absolute", inset: "0 0 auto", zIndex: 1 }}
        />
      )}
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table aria-label={ariaLabel} aria-busy={loading}>
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableCell
                  key={column.id}
                  align={column.align}
                  sx={{ width: column.width, minWidth: column.minWidth }}
                >
                  {column.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow
                key={getRowId(row)}
                hover={Boolean(onRowClick)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={
                  onRowClick
                    ? (event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest("button,a,input,select,textarea,[role=button]")
                        )
                          return;
                        onRowClick(row);
                      }
                    : undefined
                }
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                sx={{
                  cursor: onRowClick ? "pointer" : "default",
                  "&:last-child td": { borderBottom: 0 },
                }}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    align={column.align}
                    sx={{ minWidth: column.minWidth, overflowWrap: "anywhere" }}
                  >
                    {column.render(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={Math.max(columns.length, 1)}>
                  {loading ? (
                    <Stack sx={{ alignItems: "center", p: 5 }}>
                      <CircularProgress size={24} />
                    </Stack>
                  ) : (
                    <EmptyState title={emptyTitle} description={emptyDescription} />
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {pagination && (
        <TablePagination
          component="div"
          count={pagination.total}
          page={Math.max(0, pagination.page - 1)}
          rowsPerPage={pagination.pageSize}
          rowsPerPageOptions={pagination.pageSizeOptions ? [...pagination.pageSizeOptions] : []}
          onPageChange={(_event, page) => pagination.onChange(page + 1, pagination.pageSize)}
          onRowsPerPageChange={(event) => pagination.onChange(1, Number(event.target.value))}
        />
      )}
    </Box>
  );
}

export function DetailsGrid({
  items,
  columns = 2,
}: {
  items: readonly { label: ReactNode; value: ReactNode; key?: string }[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: "grid",
        gridTemplateColumns: { xs: "minmax(0, 1fr)", md: `repeat(${columns}, minmax(0, 1fr))` },
        gap: 2.5,
      }}
    >
      {items.map((item, index) => (
        <Box key={item.key ?? index} sx={{ minWidth: 0 }}>
          <Typography
            component="dt"
            variant="caption"
            sx={{ color: "text.secondary", mb: 0.5, fontWeight: 500 }}
          >
            {item.label}
          </Typography>
          <Box component="dd" sx={{ m: 0, fontSize: "0.875rem", overflowWrap: "anywhere" }}>
            {item.value ?? "—"}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Stack sx={{ alignItems: "center", textAlign: "center", py: 5, px: 2, gap: 1.25 }}>
      <Box sx={{ color: "text.disabled", display: "grid", placeItems: "center", mb: 0.5 }}>
        {icon ?? <InboxOutlined sx={{ fontSize: 36 }} />}
      </Box>
      <Typography variant="subtitle1">{title}</Typography>
      {description && (
        <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 480 }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 1 }}>{action}</Box>}
    </Stack>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  disabled = false,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: () => unknown;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      {children && <DialogContent>{children}</DialogContent>}
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          variant="contained"
          color={destructive ? "error" : "primary"}
          disabled={disabled || loading}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
          onClick={() => {
            void onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type Notice = { id: number; message: string; severity: AlertColor };
const noticeListeners = new Set<(notice: Notice) => void>();
let noticeSequence = 0;
export function notify(message: string, severity: AlertColor = "success") {
  const notice = { id: ++noticeSequence, message, severity };
  for (const listener of noticeListeners) listener(notice);
}

export function NotificationsHost() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    noticeListeners.add(setNotice);
    return () => {
      noticeListeners.delete(setNotice);
    };
  }, []);
  return (
    <Snackbar
      key={notice?.id}
      open={notice !== null}
      autoHideDuration={6000}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") setNotice(null);
      }}
    >
      {notice ? (
        <Alert severity={notice.severity} variant="filled" onClose={() => setNotice(null)}>
          {notice.message}
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}

export function Section({
  title,
  children,
  action,
}: {
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Paper sx={{ p: 3, minWidth: 0, bgcolor: "background.default" }}>
      {(title || action) && (
        <Stack
          direction="row"
          sx={{ alignItems: "center", justifyContent: "space-between", gap: 2, mb: 2 }}
        >
          <Typography variant="h6">{title}</Typography>
          {action}
        </Stack>
      )}
      {children}
    </Paper>
  );
}
