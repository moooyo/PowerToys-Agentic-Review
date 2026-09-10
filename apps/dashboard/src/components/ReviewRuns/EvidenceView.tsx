import type { EvidenceAssetManifest } from "@agentic-review/contracts";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type EvidenceScope, evidence } from "@/services/evidence";
import { ReviewControlError, ReviewControlHttpError } from "@/services/review-control/errors";
import { CopyValue, ErrorNotice, Facts, timestamp } from "./common";

export interface EvidenceReference {
  readonly id: string;
  readonly checkIds: readonly string[];
}

interface EvidenceRow {
  readonly id: string;
  readonly manifest?: EvidenceAssetManifest;
  readonly checkIds: readonly string[];
}

export function evidenceRows(
  manifests: readonly EvidenceAssetManifest[],
  references: readonly EvidenceReference[],
): EvidenceRow[] {
  const rows = new Map<string, EvidenceRow>();
  for (const reference of references) rows.set(reference.id, { ...reference });
  for (const manifest of manifests)
    rows.set(manifest.id, {
      id: manifest.id,
      manifest,
      checkIds: rows.get(manifest.id)?.checkIds ?? [],
    });
  return [...rows.values()];
}

function sizeLabel(bytes: number): string {
  return bytes < 1_024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${(bytes / 1_024).toFixed(1)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function fileName(manifest: EvidenceAssetManifest): string {
  const extension = {
    "image/png": "png",
    "application/json": "json",
    "application/zip": "zip",
    "text/plain": "txt",
  }[manifest.metadata.mediaType];
  return `${manifest.id.replace(/[^A-Za-z0-9._-]/gu, "_")}.${extension}`;
}

export function EvidenceView({
  scope,
  references = [],
}: {
  scope: EvidenceScope;
  references?: readonly EvidenceReference[];
}) {
  const scopeKey = JSON.stringify(scope);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const previewUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; manifest: EvidenceAssetManifest } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const failureFor = (id: string) => (Object.hasOwn(failures, id) ? failures[id] : undefined);
  const files = useQuery({
    queryKey: [
      "evidence",
      scope.repositoryId,
      scope.runId,
      scope.jobId,
      scope.runAttemptId,
      scope.requestId,
      scope.profileVersionId,
      scope.revisionKey,
      scope.planDigest,
    ],
    queryFn: () => evidence.list(scope),
    enabled: evidence.mode === "connected",
    retry: false,
    refetchOnMount: "always",
  });
  const closePreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPreview(null);
  };
  useEffect(() => {
    currentScope.current = scopeKey;
    setFailures({});
    setBusy(null);
    setPreview(null);
    setPage(0);
    return () => {
      currentScope.current = "";
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    };
  }, [scopeKey]);
  const load = async (manifest: EvidenceAssetManifest, action: "preview" | "download") => {
    setBusy(manifest.id);
    setFailures((previous) => {
      const next = { ...previous };
      delete next[manifest.id];
      return next;
    });
    try {
      const blob = await evidence.content(scope, manifest);
      if (currentScope.current !== scopeKey) return;
      const url = URL.createObjectURL(blob);
      if (action === "preview") {
        closePreview();
        previewUrl.current = url;
        setPreview({ url, manifest });
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName(manifest);
        link.rel = "noopener";
        document.body.append(link);
        link.click();
        link.remove();
        // Keep the object alive until the browser has accepted the download navigation.
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    } catch (error) {
      if (currentScope.current !== scopeKey) return;
      const message =
        error instanceof ReviewControlHttpError && error.status === 410
          ? "Retired — content is no longer retained."
          : error instanceof ReviewControlHttpError && error.status === 404
            ? "Missing — this file is no longer available in the attempt."
            : error instanceof ReviewControlError
              ? error.message
              : "The evidence file could not be loaded.";
      setFailures((previous) => ({ ...previous, [manifest.id]: message }));
      void files.refetch();
    } finally {
      if (currentScope.current === scopeKey) setBusy(null);
    }
  };
  const rows = evidenceRows(files.data ?? [], references);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return (
    <Stack spacing={3} sx={{ width: "100%" }}>
      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography variant="h6">Evidence files</Typography>
        <Button
          disabled={evidence.mode === "sample"}
          loading={files.isFetching}
          onClick={() => {
            setFailures({});
            void files.refetch();
          }}
        >
          Refresh files
        </Button>
      </Stack>
      {evidence.mode === "sample" ? (
        <Alert severity="info">
          <AlertTitle>Sample references only</AlertTitle>
          These sample IDs do not contain uploaded files. Preview and download are available when
          connected to a server with recorded evidence.
        </Alert>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Files belong to this exact job attempt. PNG screenshots can be previewed; other formats
          are downloaded. Content is checked against its saved digest before it is opened.
        </Typography>
      )}
      {files.isError ? (
        <ErrorNotice
          title="Could not load evidence files"
          error={files.error}
          retry={() => void files.refetch()}
        />
      ) : (
        <Box sx={{ minWidth: 0 }}>
          <TableContainer>
            <Table size="medium" aria-label="Evidence files" sx={{ minWidth: 700 }}>
              <TableHead>
                <TableRow>
                  <TableCell>File and metadata</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Captured</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {evidence.mode === "connected" && files.isPending ? (
                  <TableRow>
                    <TableCell colSpan={4}>Loading evidence files…</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ py: 4, color: "text.secondary" }}>
                      {evidence.mode === "sample"
                        ? "No evidence references in this sample report."
                        : "No evidence files or references were recorded for this attempt."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row) => (
                    <TableRow key={row.id} sx={{ "& > td": { verticalAlign: "top" } }}>
                      <TableCell sx={{ minWidth: 260 }}>
                        <Accordion
                          disableGutters
                          elevation={0}
                          sx={{
                            bgcolor: "transparent",
                            border: 0,
                            "&::before": { display: "none" },
                          }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
                            <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                              <Typography
                                variant="body2"
                                component="code"
                                sx={{
                                  fontFamily: "var(--app-code-font)",
                                  fontSize: 14,
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {row.id}
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                {row.manifest?.metadata.kind ?? "Reference"}
                                {row.manifest
                                  ? ` · ${sizeLabel(row.manifest.metadata.sizeBytes)}`
                                  : ""}
                              </Typography>
                            </Stack>
                          </AccordionSummary>
                          <AccordionDetails sx={{ px: 0 }}>
                            <Stack spacing={2}>
                              {failureFor(row.id) && (
                                <Alert severity="warning">
                                  <AlertTitle>Evidence content unavailable</AlertTitle>
                                  {failureFor(row.id)}
                                </Alert>
                              )}
                              <Facts
                                columns={1}
                                items={[
                                  { label: "Evidence ID", value: <CopyValue value={row.id} /> },
                                  {
                                    label: "Checks referencing this file",
                                    value: row.checkIds.length
                                      ? row.checkIds.join(", ")
                                      : "No checks reference this file",
                                  },
                                  {
                                    label: "Media type",
                                    value: row.manifest?.metadata.mediaType ?? "Not recorded",
                                  },
                                  {
                                    label: "Content SHA-256",
                                    value: <CopyValue value={row.manifest?.metadata.sha256} />,
                                  },
                                  {
                                    label: "Retired",
                                    value: row.manifest?.retiredAt
                                      ? timestamp(row.manifest.retiredAt)
                                      : row.manifest
                                        ? "Not retired"
                                        : "Not recorded",
                                  },
                                ]}
                              />
                            </Stack>
                          </AccordionDetails>
                        </Accordion>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="medium"
                          color={
                            evidence.mode === "sample"
                              ? "default"
                              : row.manifest?.state === "retired" ||
                                  !row.manifest ||
                                  failureFor(row.id)
                                ? "warning"
                                : "success"
                          }
                          label={
                            evidence.mode === "sample"
                              ? "Sample"
                              : files.isPending
                                ? "Loading"
                                : row.manifest?.state === "retired"
                                  ? "Retired"
                                  : !row.manifest
                                    ? "Missing"
                                    : failureFor(row.id)
                                      ? "Unavailable"
                                      : "Available"
                          }
                        />
                      </TableCell>
                      <TableCell sx={{ minWidth: 165 }}>
                        {row.manifest
                          ? timestamp(row.manifest.metadata.capturedAt)
                          : "Not recorded"}
                      </TableCell>
                      <TableCell>
                        {row.manifest?.state === "finalized" && evidence.mode === "connected" ? (
                          <Stack direction="row" spacing={1}>
                            {row.manifest.metadata.mediaType === "image/png" && (
                              <Button
                                size="medium"
                                disabled={busy !== null}
                                onClick={() =>
                                  void load(row.manifest as EvidenceAssetManifest, "preview")
                                }
                              >
                                Preview PNG
                              </Button>
                            )}
                            <Button
                              size="medium"
                              loading={busy === row.id}
                              disabled={busy !== null && busy !== row.id}
                              onClick={() =>
                                void load(row.manifest as EvidenceAssetManifest, "download")
                              }
                            >
                              Download
                            </Button>
                          </Stack>
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            {evidence.mode === "sample"
                              ? "Sample only"
                              : row.manifest
                                ? "Content retired"
                                : "No file available"}
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={rows.length}
            page={currentPage}
            rowsPerPage={pageSize}
            rowsPerPageOptions={[10, 20, 50]}
            onPageChange={(_, nextPage) => setPage(nextPage)}
            onRowsPerPageChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
          />
        </Box>
      )}
      {Object.keys(failures).length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Some evidence content could not be loaded</AlertTitle>
          {Object.values(failures).join(" ")}
        </Alert>
      )}
      <Dialog open={preview !== null} onClose={closePreview} fullWidth maxWidth="lg">
        <DialogTitle>{preview ? fileName(preview.manifest) : "Screenshot"}</DialogTitle>
        <DialogContent>
          {preview && (
            <Box
              component="img"
              sx={{ width: "100%", height: "auto" }}
              src={preview.url}
              alt={`Evidence screenshot ${preview.manifest.id}`}
              onError={() =>
                setFailures((previous) => ({
                  ...previous,
                  [preview.manifest.id]: "The PNG content could not be displayed.",
                }))
              }
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closePreview}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
