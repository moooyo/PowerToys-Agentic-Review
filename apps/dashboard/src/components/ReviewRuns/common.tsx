import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Alert, AlertTitle, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { DetailsGrid, notify } from "@/components/ui";

export function readable(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString("en-US");
}

export function withOccurrenceKeys<T>(
  items: readonly T[],
  identity: (item: T) => string,
): Array<{ key: string; item: T }> {
  // Preserve duplicate recorded entries while keeping identities independent of pagination.
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const value = identity(item);
    const occurrence = (occurrences.get(value) ?? 0) + 1;
    occurrences.set(value, occurrence);
    return { key: `${value}:${occurrence}`, item };
  });
}

export function CopyValue({ value }: { value: string | null | undefined }) {
  return value ? (
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, alignItems: "center" }}>
      <Typography
        component="code"
        variant="body2"
        sx={{ overflowWrap: "anywhere", fontFamily: "var(--app-code-font)", fontSize: 14 }}
      >
        {value}
      </Typography>
      <Tooltip title="Copy value">
        <IconButton
          aria-label={`Copy ${value}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              notify("Copied to clipboard.");
            } catch {
              notify("Could not copy this value.", "error");
            }
          }}
        >
          <ContentCopyIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  ) : (
    <Typography component="span" variant="body2" color="text.secondary">
      Not recorded
    </Typography>
  );
}

export function Facts({
  items,
  columns = 2,
}: {
  items: Array<{ label: string; value: ReactNode }>;
  columns?: 1 | 2 | 3;
}) {
  return <DetailsGrid columns={columns} items={items} />;
}

export function Prose({ children }: { children: ReactNode }) {
  return (
    <Typography
      component="div"
      variant="body1"
      sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {children}
    </Typography>
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
    <Alert severity="error" action={<Button onClick={retry}>Retry</Button>}>
      <AlertTitle>{title}</AlertTitle>
      {error instanceof Error ? error.message : "The request could not be completed."}
    </Alert>
  );
}

export function EvidenceIds({ ids }: { ids: string[] }) {
  return ids.length ? (
    <Stack spacing={0.5} sx={{ maxWidth: "100%" }}>
      {ids.map((id) => (
        <CopyValue key={id} value={id} />
      ))}
    </Stack>
  ) : (
    <Typography component="span" variant="body2" color="text.secondary">
      No evidence IDs recorded
    </Typography>
  );
}
