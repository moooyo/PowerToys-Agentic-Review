import type * as C from "@agentic-review/contracts";
import {
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
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EvaluationEvidenceAdapter } from "@/services/evaluation-evidence";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import { CopyValue, EvaluationTable } from "./Display";
import {
  assertResultEvidenceReferences,
  browserEvidenceResources,
  EvaluationEvidenceSession,
  type EvidenceBrowserResources,
  type EvidencePreview,
  maximumEvidenceTextPreviewBytes,
  resultEvidenceBinding,
  resultEvidenceReferences,
} from "./evidence-state";
import { errorMessage } from "./state";

type EvidenceRow = C.EvaluationResultEvidenceListV1["items"][number];
export function EvidencePreviewContent({ preview }: { preview: EvidencePreview | null }) {
  return preview?.kind === "image" ? (
    <Box
      src={preview.url}
      alt={`Evidence ${preview.assetId}`}
      style={{
        maxWidth: "100%",
      }}
      component="img"
    />
  ) : preview?.kind === "text" ? (
    <>
      <Typography component="p" variant="body2" color={"text.secondary"}>
        {preview.truncated
          ? `Truncated preview: the first ${maximumEvidenceTextPreviewBytes / 1024} KiB. Download the verified file for all content.`
          : "Complete verified text file."}
      </Typography>
      <pre className="evaluation-source-body">{preview.text}</pre>
    </>
  ) : null;
}
export function EvaluationEvidence({
  result,
  adapter,
  active = true,
  resources = browserEvidenceResources,
}: {
  result: C.EvaluationCellResultV1;
  adapter: EvaluationEvidenceAdapter;
  active?: boolean;
  resources?: EvidenceBrowserResources;
}) {
  const page = useEvaluationPage();
  const binding = useMemo(() => resultEvidenceBinding(result), [result]);
  const references = useMemo(() => resultEvidenceReferences(result), [result]);
  const identity = JSON.stringify([page.session, binding, references]);
  const owner = useMemo(
    () => new EvaluationEvidenceSession(adapter, binding, resources, page.invalidateAccess),
    [adapter, binding, resources, page.invalidateAccess],
  );
  const session = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const enabled = active && page.readable;
  useEffect(() => {
    owner.activate();
    return () => owner.dispose();
  }, [owner]);
  const files = useEvaluationQuery(
    ["result-evidence", identity],
    async (signal) => {
      const list = await adapter.list(binding, signal);
      assertResultEvidenceReferences(list, binding, references);
      return list.items;
    },
    active,
  );
  const loading = files.isFetching || files.isPending;
  useEffect(() => {
    if (!enabled || loading || files.error) owner.reset();
  }, [owner, enabled, loading, files.error]);
  const errorLabel =
    session.error?.status === 404
      ? "Missing — this file is unavailable"
      : session.error?.status === 410
        ? "Retired — this file is no longer retained"
        : session.error?.status === 401 || session.error?.status === 403
          ? "Evidence access changed"
          : "Evidence could not be verified";
  const preview = enabled && !loading && !files.error ? session.preview : null;
  return (
    <div className="evaluation-cell-result">
      <div className="evaluation-subheading">
        <Typography
          style={{
            margin: 0,
          }}
          component="h5"
          variant="subtitle1"
        >
          Evidence files
        </Typography>
        <Button
          disabled={!enabled || session.busy !== null}
          loading={files.isFetching}
          onClick={() => {
            owner.reset();
            void files.refetch();
          }}
          variant="outlined"
        >
          Refresh files
        </Button>
      </div>
      <Typography component="p" variant="body2" color={"text.secondary"}>
        Preview and download verify the complete file bytes against the refreshed manifest.
        Verifying a file does not verify a UI assertion or change the result's evidence assessment.
      </Typography>
      {files.error ? (
        <Alert severity={"error"}>
          <AlertTitle>{"Evidence list unavailable"}</AlertTitle>
          {errorMessage(files.error)}
        </Alert>
      ) : null}
      {session.error && enabled ? (
        <Alert
          severity={session.error.status === 404 || session.error.status === 410 ? "info" : "error"}
        >
          <AlertTitle>{errorLabel}</AlertTitle>
          {`${session.error.assetId}: ${session.error.message}`}
        </Alert>
      ) : null}
      {session.downloaded && enabled ? (
        <Alert severity={"success"}>
          <AlertTitle>{"Verified download started"}</AlertTitle>
          {session.downloaded}
        </Alert>
      ) : null}
      <EvaluationTable<EvidenceRow>
        loading={enabled && loading}
        rows={enabled && !files.error && !loading ? (files.data ?? []) : []}
        getRowId={(row) => row.assetId}
        columns={[
          {
            id: "file",
            label: "File",
            render: (row) => {
              return (
                <div>
                  <CopyValue value={row.assetId} />
                  <span className="evaluation-meta">
                    {row.manifest
                      ? `${row.manifest.metadata.kind} · ${row.manifest.metadata.mediaType} · ${row.manifest.metadata.sizeBytes.toLocaleString()} bytes`
                      : "Recorded reference"}
                  </span>
                  {row.checkIds.map((id) => (
                    <span key={id} className="evaluation-meta">
                      {id}
                    </span>
                  ))}
                </div>
              );
            },
          },
          {
            id: "status",
            label: "Status",
            width: 170,
            render: (row) => {
              return (
                <Chip
                  label={
                    row.manifest === null
                      ? "Missing"
                      : row.manifest.state === "retired"
                        ? "Retired"
                        : session.error?.assetId === row.assetId
                          ? "Unavailable"
                          : "Recorded; verify on open"
                  }
                />
              );
            },
          },
          {
            id: "actions",
            label: "Actions",
            width: 175,
            render: (row) => {
              const manifest = row.manifest,
                disabled =
                  !enabled || loading || session.busy !== null || manifest?.state !== "finalized";
              return (
                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 1,
                  }}
                >
                  {manifest && manifest.metadata.kind !== "trace" ? (
                    <Button
                      disabled={disabled}
                      aria-label={`Preview evidence ${row.assetId}`}
                      loading={session.busy === row.assetId}
                      onClick={() => {
                        if (!disabled) void owner.run("preview", manifest);
                      }}
                      variant="outlined"
                    >
                      Preview
                    </Button>
                  ) : null}
                  <Button
                    disabled={disabled}
                    aria-label={`Download evidence ${row.assetId}`}
                    onClick={() => {
                      if (!disabled && manifest) void owner.run("download", manifest);
                    }}
                    variant="outlined"
                  >
                    Download
                  </Button>
                </Stack>
              );
            },
          },
        ]}
        ariaLabel="Evaluation records"
        pageSize={10}
      />
      <Dialog open={preview !== null} onClose={() => owner.closePreview()} fullWidth maxWidth="lg">
        <DialogTitle>
          {preview ? `Verified file preview · ${preview.assetId}` : "Evidence preview"}
        </DialogTitle>
        <DialogContent>
          <EvidencePreviewContent preview={preview} />
        </DialogContent>
        <DialogActions>
          {
            <Button onClick={() => owner.closePreview()} variant="outlined">
              Close preview
            </Button>
          }
        </DialogActions>
      </Dialog>
    </div>
  );
}
