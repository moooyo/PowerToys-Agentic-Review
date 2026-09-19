import type {
  InvestigationArtifactMetadataV1,
  InvestigationArtifactV1,
} from "@agentic-review/contracts";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { investigationApi } from "./api";
import { Section } from "./report-sections";
import { sessionIdentity, useInvestigationSession } from "./session";
import { fetchInvestigationArtifactContent } from "./transport";

export function assertArtifactBinding(
  snapshot: InvestigationArtifactV1,
  metadata: InvestigationArtifactMetadataV1,
): void {
  for (const field of [
    "id",
    "taskId",
    "attemptId",
    "subjectRef",
    "kind",
    "name",
    "mediaType",
    "digest",
    "byteLength",
  ] as const) {
    if (snapshot[field] !== metadata.artifact[field]) {
      throw new Error("The current artifact does not match the evidence recorded in this report.");
    }
  }
}

export function artifactPreviewKind(mediaType: string): "image" | "video" | undefined {
  switch (mediaType) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
    case "image/gif":
      return "image";
    case "video/mp4":
    case "video/webm":
    case "video/quicktime":
      return "video";
    default:
      return undefined;
  }
}

export async function readVerifiedArtifactContent(
  artifact: InvestigationArtifactV1,
  metadata: InvestigationArtifactMetadataV1,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  assertArtifactBinding(artifact, metadata);
  if (metadata.artifact.availability !== "available") {
    throw new Error("The artifact content is no longer available.");
  }
  const content = await fetchInvestigationArtifactContent(artifact.id, signal);
  signal.throwIfAborted();
  const mediaType = (value: string) => value.split(";")[0]?.trim().toLowerCase();
  if (
    content.size !== artifact.byteLength ||
    mediaType(content.type) !== mediaType(artifact.mediaType)
  ) {
    throw new Error("The artifact content does not match its recorded size or media type.");
  }
  const bytes = await content.arrayBuffer();
  signal.throwIfAborted();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  signal.throwIfAborted();
  const digest = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== artifact.digest) {
    throw new Error("The artifact content failed its integrity check.");
  }
  return content.slice(0, content.size, artifact.mediaType);
}

interface ArtifactPreview {
  kind: "image" | "video";
  url: string;
  release: () => void;
}

export async function createArtifactPreview(
  artifact: InvestigationArtifactV1,
  metadata: InvestigationArtifactMetadataV1,
  signal: AbortSignal,
): Promise<ArtifactPreview> {
  const kind = artifactPreviewKind(artifact.mediaType);
  if (!kind) throw new Error("This artifact is available as a download only.");
  const content = await readVerifiedArtifactContent(artifact, metadata, signal);
  signal.throwIfAborted();
  const url = URL.createObjectURL(content);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", release);
    URL.revokeObjectURL(url);
  };
  signal.addEventListener("abort", release, { once: true });
  return {
    kind,
    url,
    release,
  };
}

export function ArtifactDetails({
  artifact,
  metadata,
  error,
  busy,
  onDownload,
  onRefresh,
  preview,
  previewBusy = false,
  previewError,
  onPreview,
  onClosePreview,
  onPreviewError,
}: {
  artifact: InvestigationArtifactV1;
  metadata?: InvestigationArtifactMetadataV1;
  error?: string;
  busy: boolean;
  onDownload: () => void;
  onRefresh: () => void;
  preview?: Pick<ArtifactPreview, "kind" | "url">;
  previewBusy?: boolean;
  previewError?: string;
  onPreview?: () => void;
  onClosePreview?: () => void;
  onPreviewError?: () => void;
}) {
  const previewKind = artifactPreviewKind(artifact.mediaType);
  const available = metadata?.artifact.availability === "available" && !error;
  return (
    <Box>
      <Typography variant="subtitle2">
        {artifact.name} · {artifact.kind}
      </Typography>
      <Typography variant="caption" component="div">
        {artifact.mediaType} · {artifact.byteLength} bytes
      </Typography>
      <Typography variant="caption" component="div" sx={{ overflowWrap: "anywhere" }}>
        Digest: {artifact.digest}
      </Typography>
      <Typography variant="caption" component="div">
        Producer task: {artifact.taskId} · Attempt: {artifact.attemptId}
      </Typography>
      <Typography variant="caption" component="div">
        Subject: {artifact.subjectRef}
      </Typography>
      <Typography variant="caption" component="div">
        Availability recorded in report: {artifact.availability}
      </Typography>
      <Typography variant="body2" sx={{ mt: 1 }}>
        Current availability: {metadata?.artifact.availability ?? "unverified"}
      </Typography>
      {metadata?.artifact.availability === "expired" && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Artifact content expired{metadata.expiredAt ? ` at ${metadata.expiredAt}` : ""}. The
          historical report is unchanged.
        </Alert>
      )}
      {metadata?.artifact.availability === "missing" && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Artifact content is missing. The report retains its original evidence metadata.
        </Alert>
      )}
      {metadata?.retentionProtected && (
        <Typography variant="caption" component="div">
          Retained for an active or resumable investigation.
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        {available && (
          <Button disabled={busy} onClick={onDownload}>
            Download artifact
          </Button>
        )}
        {available && previewKind && onPreview && !preview && (
          <Button disabled={busy} onClick={onPreview}>
            Preview {previewKind}
          </Button>
        )}
        {(preview || previewBusy) && onClosePreview && (
          <Button onClick={onClosePreview}>Close preview</Button>
        )}
        <Button disabled={busy} onClick={onRefresh}>
          {busy ? "Checking artifact…" : "Refresh availability"}
        </Button>
      </Stack>
      {previewBusy && (
        <Typography role="status" variant="body2" sx={{ mt: 1 }}>
          Loading preview…
        </Typography>
      )}
      {previewError && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {previewError}
        </Alert>
      )}
      {available && preview && preview.kind === previewKind && (
        <Box sx={{ mt: 2 }}>
          {preview.kind === "image" ? (
            <Box
              component="img"
              src={preview.url}
              alt={artifact.name}
              onError={onPreviewError}
              sx={{ display: "block", maxWidth: "100%", maxHeight: 560, objectFit: "contain" }}
            />
          ) : (
            <>
              <Box
                component="video"
                src={preview.url}
                aria-label={artifact.name}
                controls
                playsInline
                preload="metadata"
                onError={onPreviewError}
                sx={{ display: "block", width: "100%", maxHeight: 560 }}
              >
                Your browser does not support video playback. Download the artifact to view it.
              </Box>
              <Typography variant="caption" component="div" sx={{ mt: 1 }}>
                If this video does not play in your browser, download the artifact to view it.
              </Typography>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

function ArtifactCard({ artifact }: { artifact: InvestigationArtifactV1 }) {
  const { session } = useInvestigationSession();
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const downloadRequest = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);
  const previewResource = useRef<ArtifactPreview | null>(null);
  const current = useQuery({
    queryKey: ["investigation-artifact", sessionIdentity(session), artifact],
    queryFn: async ({ signal }) => {
      const metadata = await investigationApi.artifact(artifact.id, signal);
      assertArtifactBinding(artifact, metadata);
      return metadata;
    },
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
  });
  useEffect(
    () => () => {
      downloadRequest.current?.abort();
      previewRequest.current?.abort();
      previewResource.current?.release();
    },
    [],
  );
  useEffect(() => {
    if (current.isError || current.data?.artifact.availability !== "available") {
      previewRequest.current?.abort();
      previewRequest.current = null;
      previewResource.current?.release();
      previewResource.current = null;
      setPreview(undefined);
      setPreviewBusy(false);
    }
  }, [current.isError, current.data?.artifact.availability]);
  const closePreview = () => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    previewResource.current?.release();
    previewResource.current = null;
    setPreview(undefined);
    setPreviewBusy(false);
    setPreviewError(undefined);
  };
  const refresh = () => {
    setDownloadError(undefined);
    setPreviewError(undefined);
    void current.refetch();
  };
  const showPreview = async () => {
    if (previewRequest.current || downloadRequest.current) return;
    closePreview();
    const request = new AbortController();
    previewRequest.current = request;
    setPreviewBusy(true);
    let resource: ArtifactPreview | undefined;
    try {
      const latest = await current.refetch({ throwOnError: true });
      request.signal.throwIfAborted();
      if (latest.data?.artifact.availability !== "available") return;
      resource = await createArtifactPreview(artifact, latest.data, request.signal);
      request.signal.throwIfAborted();
      previewResource.current = resource;
      setPreview(resource);
      resource = undefined;
    } catch (cause) {
      if (!request.signal.aborted) {
        setPreviewError(
          cause instanceof Error ? cause.message : "The preview could not be loaded.",
        );
        void current.refetch();
      }
    } finally {
      resource?.release();
      if (previewRequest.current === request) previewRequest.current = null;
      if (!request.signal.aborted) setPreviewBusy(false);
    }
  };
  const download = async () => {
    if (downloadRequest.current || previewRequest.current) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const latest = await current.refetch({ throwOnError: true });
      request.signal.throwIfAborted();
      if (latest.data?.artifact.availability !== "available") return;
      const content = await readVerifiedArtifactContent(artifact, latest.data, request.signal);
      request.signal.throwIfAborted();
      const url = URL.createObjectURL(content);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = artifact.name;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (cause) {
      if (!request.signal.aborted) {
        setDownloadError(
          cause instanceof Error ? cause.message : "The artifact could not be downloaded.",
        );
        void current.refetch();
      }
    } finally {
      downloadRequest.current = null;
      if (!request.signal.aborted) setDownloading(false);
    }
  };
  return (
    <ArtifactDetails
      artifact={artifact}
      metadata={current.isSuccess ? current.data : undefined}
      error={current.isError ? current.error.message : downloadError}
      busy={current.isFetching || downloading || previewBusy}
      onDownload={() => void download()}
      onRefresh={refresh}
      preview={preview}
      previewBusy={previewBusy}
      previewError={previewError}
      onPreview={() => void showPreview()}
      onClosePreview={closePreview}
      onPreviewError={() => {
        closePreview();
        setPreviewError(
          "This browser could not display the preview. Download the artifact to view it.",
        );
      }}
    />
  );
}

export function ArtifactPanel({
  artifacts,
  origin = "produced",
}: {
  artifacts: InvestigationArtifactV1[];
  origin?: "produced" | "inherited";
}) {
  return (
    <Section
      title={origin === "inherited" ? "Inherited patch sources" : "Artifacts produced by this task"}
    >
      <Stack spacing={2}>
        {origin === "inherited" && (
          <Typography variant="body2" color="text.secondary">
            Patch inputs produced by ancestor tasks. The original producer task and attempt are
            retained; these inputs are separate from this task's validation evidence.
          </Typography>
        )}
        {artifacts.map((artifact) => (
          <ArtifactCard key={JSON.stringify(artifact)} artifact={artifact} />
        ))}
        {artifacts.length === 0 && (
          <Typography color="text.secondary">No artifacts registered.</Typography>
        )}
      </Stack>
    </Section>
  );
}
