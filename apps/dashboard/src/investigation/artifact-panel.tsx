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

export function ArtifactDetails({
  artifact,
  metadata,
  error,
  busy,
  onDownload,
  onRefresh,
}: {
  artifact: InvestigationArtifactV1;
  metadata?: InvestigationArtifactMetadataV1;
  error?: string;
  busy: boolean;
  onDownload: () => void;
  onRefresh: () => void;
}) {
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
        {metadata?.artifact.availability === "available" && !error && (
          <Button disabled={busy} onClick={onDownload}>
            Download artifact
          </Button>
        )}
        <Button disabled={busy} onClick={onRefresh}>
          {busy ? "Checking artifact…" : "Refresh availability"}
        </Button>
      </Stack>
    </Box>
  );
}

function ArtifactCard({ artifact }: { artifact: InvestigationArtifactV1 }) {
  const { session } = useInvestigationSession();
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const downloadRequest = useRef<AbortController | null>(null);
  const current = useQuery({
    queryKey: ["investigation-artifact", sessionIdentity(session), artifact.id, artifact.digest],
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
  useEffect(() => () => downloadRequest.current?.abort(), []);
  const refresh = () => {
    setDownloadError(undefined);
    void current.refetch();
  };
  const download = async () => {
    if (downloadRequest.current) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const latest = await current.refetch({ throwOnError: true });
      request.signal.throwIfAborted();
      if (latest.data?.artifact.availability !== "available") return;
      const content = await fetchInvestigationArtifactContent(artifact.id, request.signal);
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
      busy={current.isFetching || downloading}
      onDownload={() => void download()}
      onRefresh={refresh}
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
          <ArtifactCard key={artifact.id} artifact={artifact} />
        ))}
        {artifacts.length === 0 && (
          <Typography color="text.secondary">No artifacts registered.</Typography>
        )}
      </Stack>
    </Section>
  );
}
