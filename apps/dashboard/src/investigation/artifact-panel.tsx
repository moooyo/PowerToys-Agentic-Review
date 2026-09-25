import type {
  InvestigationArtifactMetadataV1,
  InvestigationArtifactV1,
} from "@agentic-review/contracts";
import DescriptionRounded from "@mui/icons-material/DescriptionRounded";
import DownloadRounded from "@mui/icons-material/DownloadRounded";
import ImageRounded from "@mui/icons-material/ImageRounded";
import MoreHorizRounded from "@mui/icons-material/MoreHorizRounded";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { investigationApi } from "./api";
import { Section } from "./report-sections";
import { sessionIdentity, useInvestigationSession } from "./session";
import { fetchInvestigationArtifactContent, InvestigationHttpError } from "./transport";
import "./task-evidence.css";

export function evidenceAccessDenied(error: unknown): boolean {
  return error instanceof InvestigationHttpError && (error.status === 401 || error.status === 403);
}

export function evidenceAccessQueryKey(
  identity: string,
  kind: "artifact" | "task",
  id: string,
  attemptId?: string,
) {
  return ["investigation-evidence-access-denied", identity, kind, id, attemptId ?? null] as const;
}

export function useEvidenceAccessGate(
  identity: string,
  kind: "artifact" | "task",
  id: string,
  attemptId?: string,
) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () => evidenceAccessQueryKey(identity, kind, id, attemptId),
    [identity, kind, id, attemptId],
  );
  // Preserve only the denial latch across remounts, never the inaccessible file metadata.
  const state = useQuery<boolean>({
    queryKey,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const deny = useCallback(() => client.setQueryData<boolean>(queryKey, true), [client, queryKey]);
  const retry = useCallback(
    () => client.setQueryData<boolean>(queryKey, false),
    [client, queryKey],
  );
  const assertAllowed = useCallback(() => {
    if (client.getQueryData(queryKey) === true) {
      throw new InvestigationHttpError(403, "Evidence access requires an explicit retry.");
    }
  }, [client, queryKey]);
  return { denied: state.data, deny, retry, assertAllowed };
}

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
      throw new Error("The current artifact does not match its recorded evidence metadata.");
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

export const maximumAutomaticImagePreviews = 4;
export const maximumAutomaticImageBytes = 8 * 1024 * 1024;

export interface AutomaticImagePreviewBudget {
  claim: (artifact: InvestigationArtifactV1) => boolean;
  suppress: (artifactId: string) => void;
}

/** One panel may automatically try four registered images once each, including failed attempts. */
export function createAutomaticImagePreviewBudget(): AutomaticImagePreviewBudget {
  const claimed = new Set<string>();
  const suppressed = new Set<string>();
  return {
    suppress: (artifactId) => {
      suppressed.add(artifactId);
    },
    claim(artifact) {
      if (
        artifact.availability !== "available" ||
        artifactPreviewKind(artifact.mediaType) !== "image" ||
        artifact.byteLength > maximumAutomaticImageBytes ||
        artifact.byteLength <= 0 ||
        claimed.has(artifact.id) ||
        suppressed.has(artifact.id) ||
        claimed.size >= maximumAutomaticImagePreviews
      )
        return false;
      claimed.add(artifact.id);
      return true;
    },
  };
}

export function observeAutomaticImagePreview(
  element: Element,
  artifact: InvestigationArtifactV1,
  metadata: InvestigationArtifactMetadataV1,
  budget: AutomaticImagePreviewBudget,
  onPreview: () => void,
): () => void {
  assertArtifactBinding(artifact, metadata);
  if (
    metadata.artifact.availability !== "available" ||
    artifactPreviewKind(artifact.mediaType) !== "image" ||
    artifact.byteLength > maximumAutomaticImageBytes ||
    typeof IntersectionObserver === "undefined"
  )
    return () => {};
  let stopped = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (stopped || !entries.some((entry) => entry.target === element && entry.isIntersecting))
        return;
      stopped = true;
      observer.disconnect();
      if (budget.claim(metadata.artifact)) onPreview();
    },
    { threshold: 0.01 },
  );
  observer.observe(element);
  return () => {
    stopped = true;
    observer.disconnect();
  };
}

function artifactTypeLabel(artifact: InvestigationArtifactV1): string {
  if (artifactPreviewKind(artifact.mediaType) === "image") return "Workspace screenshot";
  if (artifactPreviewKind(artifact.mediaType) === "video") {
    return artifact.mediaType === "video/webm"
      ? "Workspace WebM recording"
      : artifact.mediaType === "video/mp4"
        ? "Workspace MP4 recording"
        : "Workspace recording";
  }
  return artifact.mediaType === "application/json"
    ? "Workspace JSON"
    : artifact.kind === "log"
      ? "Workspace log"
      : `${artifact.kind === "patch" ? "Patch" : "Workspace"} file`;
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
  recordSource = "report",
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
  recordSource?: "report" | "workspace";
}) {
  const [zoomed, setZoomed] = useState(false);
  const [playRequested, setPlayRequested] = useState(false);
  const videoElement = useRef<HTMLVideoElement>(null);
  const previewTitleId = useId();
  const previewKind = artifactPreviewKind(artifact.mediaType);
  const available = metadata?.artifact.availability === "available" && !error;
  const imagePreview = available && preview?.kind === "image" && previewKind === "image";
  const videoPreview = available && preview?.kind === "video" && previewKind === "video";
  const status = metadata?.artifact.availability;
  useEffect(() => {
    if (!imagePreview && !previewBusy) setZoomed(false);
  }, [imagePreview, previewBusy]);
  useEffect(() => {
    if (!playRequested || !videoPreview || !videoElement.current) return;
    setPlayRequested(false);
    // A browser may still require the native play control after the user-requested download.
    void videoElement.current.play().catch(() => {});
  }, [playRequested, videoPreview]);
  const openImage = () => {
    setZoomed(true);
    if (!imagePreview) onPreview?.();
  };
  const playRecording = () => {
    setPlayRequested(true);
    onPreview?.();
  };
  return (
    <Box
      component="article"
      aria-busy={previewBusy}
      className={`task-artifact-card ${previewKind ? "task-artifact-media-card" : "task-artifact-file-row"}`}
    >
      {previewKind && (
        <Box className={`task-artifact-visual task-artifact-visual-${previewKind}`}>
          {available && preview?.kind === "video" && previewKind === "video" ? (
            <Box
              component="video"
              ref={videoElement}
              src={preview.url}
              aria-label={artifact.name}
              controls
              playsInline
              preload="metadata"
              onError={onPreviewError}
              className="task-artifact-preview"
            >
              Your browser does not support video playback. Download the artifact to view it.
            </Box>
          ) : (
            <button
              type="button"
              className="task-artifact-open"
              onClick={previewKind === "image" ? openImage : playRecording}
              disabled={!available || (busy && !imagePreview)}
              aria-label={
                available
                  ? `${previewKind === "image" ? "Open screenshot" : "Play recording"}: ${artifact.name}`
                  : `${status === "expired" ? "Expired" : status === "missing" ? "Missing" : "Unverified"} file: ${artifact.name}`
              }
              aria-haspopup={previewKind === "image" && available ? "dialog" : undefined}
            >
              {imagePreview && preview ? (
                <img
                  src={preview.url}
                  alt={artifact.name}
                  onError={onPreviewError}
                  className="task-artifact-preview"
                />
              ) : (
                <span className="task-artifact-visual-icon" aria-hidden="true">
                  {previewBusy ? (
                    <CircularProgress size={28} />
                  ) : previewKind === "video" ? (
                    <PlayArrowRounded sx={{ fontSize: 36 }} />
                  ) : (
                    <ImageRounded sx={{ fontSize: 32 }} />
                  )}
                </span>
              )}
              <span className="task-artifact-open-label">
                {previewBusy
                  ? "Loading preview…"
                  : !available
                    ? status === "expired"
                      ? "Content expired"
                      : status === "missing"
                        ? "Content missing"
                        : error
                          ? "Preview unavailable"
                          : "Checking file…"
                    : previewKind === "image"
                      ? "Open screenshot"
                      : "Play recording"}
              </span>
            </button>
          )}
        </Box>
      )}
      <Box className="task-artifact-caption">
        {!previewKind && (
          <Box className="task-artifact-file-icon" aria-hidden="true">
            <DescriptionRounded />
          </Box>
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography component="h3" variant="subtitle2" sx={{ overflowWrap: "anywhere" }}>
            {artifact.name}
          </Typography>
          <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
            {artifactTypeLabel(artifact)}
            {metadata
              ? ` · ${new Date(metadata.storedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
              : ""}
          </Typography>
        </Box>
        {available && (
          <Tooltip title="Download artifact">
            <Box component="span" sx={{ display: "inline-flex", flexShrink: 0 }}>
              <IconButton
                aria-label={`Download artifact: ${artifact.name}`}
                disabled={busy}
                onClick={onDownload}
              >
                <DownloadRounded fontSize="small" />
              </IconButton>
            </Box>
          </Tooltip>
        )}
      </Box>
      {metadata?.artifact.availability === "expired" && (
        <Alert severity="info" className="task-artifact-message">
          Artifact content expired{metadata.expiredAt ? ` at ${metadata.expiredAt}` : ""}. The{" "}
          {recordSource === "report"
            ? "historical report is unchanged."
            : "workspace record is preserved."}
        </Alert>
      )}
      {metadata?.artifact.availability === "missing" && (
        <Alert severity="warning" className="task-artifact-message">
          Artifact content is missing. The {recordSource} retains its original evidence metadata.
        </Alert>
      )}
      {error && (
        <Alert severity="error" className="task-artifact-message">
          {error}
        </Alert>
      )}
      {previewError && (
        <Alert severity="warning" className="task-artifact-message">
          {previewError}
        </Alert>
      )}
      {available && preview?.kind === "video" && previewKind === "video" && (
        <Typography variant="caption" color="text.secondary" className="task-artifact-message">
          If this video does not play in your browser, download the artifact to view it.
        </Typography>
      )}
      <Box component="details" className="task-artifact-provenance">
        <summary aria-label={`File details: ${artifact.name}`} title="File details">
          <MoreHorizRounded />
          <span className="task-artifact-sr-only">Evidence source and digest</span>
        </summary>
        <Box className="task-artifact-details-body">
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            File details
          </Typography>
          <Typography variant="caption" component="div">
            Current availability: {status ?? "unverified"}
          </Typography>
          <Typography variant="caption" component="div">
            {artifact.mediaType} · {artifact.byteLength.toLocaleString()} bytes
          </Typography>
          <Typography variant="caption" component="div">
            Artifact ID: {artifact.id}
          </Typography>
          <Typography variant="caption" component="div">
            Producer task: {artifact.taskId} · Attempt: {artifact.attemptId}
          </Typography>
          <Typography variant="caption" component="div">
            Subject: {artifact.subjectRef}
          </Typography>
          <Typography variant="caption" component="div">
            Availability recorded in {recordSource}: {artifact.availability}
          </Typography>
          {metadata && (
            <Typography variant="caption" component="div">
              Stored at: {metadata.storedAt}
            </Typography>
          )}
          <Typography variant="caption" component="div">
            Digest: {artifact.digest}
          </Typography>
          {metadata?.retentionProtected && (
            <Typography variant="caption" component="div">
              Retained for an active or resumable investigation.
            </Typography>
          )}
          <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 1 }}>
            SHA-256, size, media type, and producer identity are checked before each preview or
            download. File availability does not establish a passing test or GitHub publication.
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
            {(preview || previewBusy) && onClosePreview && (
              <Button onClick={onClosePreview}>Close preview</Button>
            )}
            <Button disabled={busy} onClick={onRefresh}>
              {busy ? "Checking artifact…" : "Refresh availability"}
            </Button>
          </Stack>
        </Box>
      </Box>
      {imagePreview && preview && (
        <Dialog
          open={zoomed}
          onClose={() => setZoomed(false)}
          aria-labelledby={previewTitleId}
          fullWidth
          maxWidth="lg"
        >
          <DialogTitle id={previewTitleId} sx={{ overflowWrap: "anywhere" }}>
            {artifact.name}
          </DialogTitle>
          <DialogContent dividers>
            <Box
              component="img"
              src={preview.url}
              alt={artifact.name}
              onError={onPreviewError}
              sx={{ display: "block", width: "100%", maxHeight: "75dvh", objectFit: "contain" }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setZoomed(false)} autoFocus>
              Close image
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
export function ArtifactCard({
  artifact,
  recordSource = "report",
  automaticPreviewBudget,
}: {
  artifact: InvestigationArtifactV1;
  recordSource?: "report" | "workspace";
  automaticPreviewBudget?: AutomaticImagePreviewBudget;
}) {
  const { session } = useInvestigationSession();
  if (!session.authenticated) return null;
  return (
    <ScopedArtifactCard
      key={JSON.stringify([sessionIdentity(session), artifact])}
      artifact={artifact}
      identity={sessionIdentity(session)}
      recordSource={recordSource}
      automaticPreviewBudget={automaticPreviewBudget}
    />
  );
}

function ScopedArtifactCard({
  artifact,
  identity,
  recordSource,
  automaticPreviewBudget,
}: {
  artifact: InvestigationArtifactV1;
  identity: string;
  recordSource: "report" | "workspace";
  automaticPreviewBudget?: AutomaticImagePreviewBudget;
}) {
  const queryClient = useQueryClient();
  const access = useEvidenceAccessGate(identity, "artifact", artifact.id);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const downloadRequest = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);
  const previewResource = useRef<ArtifactPreview | null>(null);
  const cardElement = useRef<HTMLDivElement>(null);
  const automaticSuppressed = useRef(false);
  const queryKey = useMemo(
    () => ["investigation-artifact", identity, artifact] as const,
    [identity, artifact],
  );
  const current = useQuery<
    InvestigationArtifactMetadataV1,
    Error,
    InvestigationArtifactMetadataV1,
    typeof queryKey
  >({
    queryKey,
    enabled: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    queryFn: async ({ signal }) => {
      access.assertAllowed();
      const metadata = await investigationApi.artifact(artifact.id, signal);
      signal.throwIfAborted();
      access.assertAllowed();
      assertArtifactBinding(artifact, metadata);
      return metadata;
    },
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) =>
      access.denied || evidenceAccessDenied(query.state.error) ? false : 30_000,
    refetchOnMount: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    refetchOnWindowFocus: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
    refetchOnReconnect: (query) => !access.denied && !evidenceAccessDenied(query.state.error),
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
    if (access.denied || current.isError || current.data?.artifact.availability !== "available") {
      downloadRequest.current?.abort();
      downloadRequest.current = null;
      setDownloading(false);
      previewRequest.current?.abort();
      previewRequest.current = null;
      previewResource.current?.release();
      previewResource.current = null;
      setPreview(undefined);
      setPreviewBusy(false);
    }
  }, [access.denied, current.isError, current.data?.artifact.availability]);
  useEffect(() => {
    if (!access.denied && !evidenceAccessDenied(current.error)) return;
    if (!access.denied) access.deny();
    queryClient.removeQueries({ queryKey, exact: true });
  }, [access.denied, access.deny, current.error, queryClient, queryKey]);
  const releasePreview = useCallback(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    previewResource.current?.release();
    previewResource.current = null;
    setPreview(undefined);
    setPreviewBusy(false);
    setPreviewError(undefined);
  }, []);
  const closePreview = useCallback(() => {
    automaticSuppressed.current = true;
    automaticPreviewBudget?.suppress(artifact.id);
    releasePreview();
  }, [automaticPreviewBudget, artifact.id, releasePreview]);
  const refresh = () => {
    setDownloadError(undefined);
    setPreviewError(undefined);
    void current.refetch();
  };
  const denyAccess = useCallback(() => {
    access.deny();
    downloadRequest.current?.abort();
    downloadRequest.current = null;
    setDownloading(false);
    closePreview();
    setDownloadError(undefined);
    queryClient.removeQueries({ queryKey, exact: true });
  }, [access.deny, closePreview, queryClient, queryKey]);
  const checkAccess = () => {
    access.retry();
    refresh();
  };
  const showPreview = useCallback(
    async (source: "automatic" | "manual" = "manual") => {
      if (previewRequest.current || downloadRequest.current) return;
      if (source === "manual") {
        automaticSuppressed.current = true;
        automaticPreviewBudget?.suppress(artifact.id);
      }
      releasePreview();
      const request = new AbortController();
      previewRequest.current = request;
      setPreviewBusy(true);
      let resource: ArtifactPreview | undefined;
      try {
        const latest = await current.refetch({ throwOnError: true });
        request.signal.throwIfAborted();
        access.assertAllowed();
        if (latest.data?.artifact.availability !== "available") return;
        resource = await createArtifactPreview(artifact, latest.data, request.signal);
        request.signal.throwIfAborted();
        access.assertAllowed();
        previewResource.current = resource;
        setPreview(resource);
        resource = undefined;
      } catch (cause) {
        if (!request.signal.aborted) {
          if (evidenceAccessDenied(cause)) {
            denyAccess();
            return;
          }
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
    },
    [
      artifact,
      automaticPreviewBudget,
      access.assertAllowed,
      current.refetch,
      denyAccess,
      releasePreview,
    ],
  );
  useEffect(() => {
    const element = cardElement.current;
    if (
      !element ||
      !automaticPreviewBudget ||
      automaticSuppressed.current ||
      access.denied ||
      current.isError ||
      !current.data ||
      preview ||
      previewBusy
    )
      return;
    return observeAutomaticImagePreview(
      element,
      artifact,
      current.data,
      automaticPreviewBudget,
      () => {
        if (!automaticSuppressed.current) void showPreview("automatic");
      },
    );
  }, [
    automaticPreviewBudget,
    artifact,
    access.denied,
    current.isError,
    current.data,
    preview,
    previewBusy,
    showPreview,
  ]);
  const download = async () => {
    if (downloadRequest.current || previewRequest.current) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const latest = await current.refetch({ throwOnError: true });
      request.signal.throwIfAborted();
      access.assertAllowed();
      if (latest.data?.artifact.availability !== "available") return;
      const content = await readVerifiedArtifactContent(artifact, latest.data, request.signal);
      request.signal.throwIfAborted();
      access.assertAllowed();
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
        if (evidenceAccessDenied(cause)) {
          denyAccess();
          return;
        }
        setDownloadError(
          cause instanceof Error ? cause.message : "The artifact could not be downloaded.",
        );
        void current.refetch();
      }
    } finally {
      if (downloadRequest.current === request) downloadRequest.current = null;
      if (!request.signal.aborted) setDownloading(false);
    }
  };
  if (access.denied || evidenceAccessDenied(current.error)) {
    return (
      <Alert
        severity="warning"
        action={
          <Button disabled={current.isFetching} onClick={checkAccess}>
            Check access
          </Button>
        }
      >
        This artifact is unavailable for the current account.
      </Alert>
    );
  }
  return (
    <Box ref={cardElement} className="task-artifact-item">
      <ArtifactDetails
        artifact={artifact}
        recordSource={recordSource}
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
    </Box>
  );
}

export function ArtifactPanel({
  artifacts,
  origin = "produced",
}: {
  artifacts: InvestigationArtifactV1[];
  origin?: "produced" | "inherited";
}) {
  const [automaticPreviewBudget] = useState(createAutomaticImagePreviewBudget);
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
          <ArtifactCard
            key={JSON.stringify(artifact)}
            artifact={artifact}
            automaticPreviewBudget={automaticPreviewBudget}
          />
        ))}
        {artifacts.length === 0 && (
          <Typography color="text.secondary">No artifacts registered.</Typography>
        )}
      </Stack>
    </Section>
  );
}
