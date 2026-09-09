import type { EvidenceAssetManifest } from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Image, Modal, Space, Table, Tag, Typography } from "antd";
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
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Evidence files
        </Typography.Title>
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
      </Space>
      {evidence.mode === "sample" ? (
        <Alert
          showIcon
          type="info"
          title="Sample references only"
          description="These sample IDs do not contain uploaded files. Preview and download are available when connected to a server with recorded evidence."
        />
      ) : (
        <Typography.Text type="secondary">
          Files belong to this exact job attempt. PNG screenshots can be previewed; other formats
          are downloaded. Content is checked against its saved digest before it is opened.
        </Typography.Text>
      )}
      {files.isError ? (
        <ErrorNotice
          title="Could not load evidence files"
          error={files.error}
          retry={() => void files.refetch()}
        />
      ) : (
        <Table<EvidenceRow>
          size="small"
          rowKey="id"
          dataSource={rows}
          loading={evidence.mode === "connected" && files.isPending}
          scroll={{ x: 700 }}
          pagination={{ defaultPageSize: 10, pageSizeOptions: [10, 20, 50], showSizeChanger: true }}
          locale={{
            emptyText:
              evidence.mode === "sample"
                ? "No evidence references in this sample report."
                : "No evidence files or references were recorded for this attempt.",
          }}
          columns={[
            {
              title: "File",
              render: (_, row) => (
                <Space orientation="vertical" size={0}>
                  <CopyValue value={row.id} />
                  <Typography.Text type="secondary">
                    {row.manifest?.metadata.kind ?? "Reference"}
                    {row.manifest ? ` · ${sizeLabel(row.manifest.metadata.sizeBytes)}` : ""}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "Status",
              width: 125,
              render: (_, row) => (
                <Tag
                  color={
                    evidence.mode === "sample"
                      ? "default"
                      : row.manifest?.state === "retired" || !row.manifest || failureFor(row.id)
                        ? "warning"
                        : "success"
                  }
                >
                  {evidence.mode === "sample"
                    ? "Sample"
                    : files.isPending
                      ? "Loading"
                      : row.manifest?.state === "retired"
                        ? "Retired"
                        : !row.manifest
                          ? "Missing"
                          : failureFor(row.id)
                            ? "Unavailable"
                            : "Available"}
                </Tag>
              ),
            },
            {
              title: "Captured",
              width: 185,
              render: (_, row) =>
                row.manifest ? timestamp(row.manifest.metadata.capturedAt) : "Not recorded",
            },
            {
              title: "Actions",
              width: 190,
              render: (_, row) =>
                row.manifest?.state === "finalized" && evidence.mode === "connected" ? (
                  <Space>
                    {row.manifest.metadata.mediaType === "image/png" && (
                      <Button
                        size="small"
                        disabled={busy !== null}
                        onClick={() => void load(row.manifest as EvidenceAssetManifest, "preview")}
                      >
                        Preview PNG
                      </Button>
                    )}
                    <Button
                      size="small"
                      loading={busy === row.id}
                      disabled={busy !== null && busy !== row.id}
                      onClick={() => void load(row.manifest as EvidenceAssetManifest, "download")}
                    >
                      Download
                    </Button>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {evidence.mode === "sample"
                      ? "Sample only"
                      : row.manifest
                        ? "Content retired"
                        : "No file available"}
                  </Typography.Text>
                ),
            },
          ]}
          expandable={{
            expandedRowRender: (row) => (
              <Space orientation="vertical" style={{ width: "100%" }}>
                {failureFor(row.id) && (
                  <Alert
                    showIcon
                    type="warning"
                    title="Evidence content unavailable"
                    description={failureFor(row.id)}
                  />
                )}
                <Facts
                  items={[
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
              </Space>
            ),
          }}
        />
      )}
      {Object.keys(failures).length > 0 && (
        <Alert
          showIcon
          type="warning"
          title="Some evidence content could not be loaded"
          description={Object.values(failures).join(" ")}
        />
      )}
      <Modal
        open={preview !== null}
        onCancel={closePreview}
        title={preview ? fileName(preview.manifest) : "Screenshot"}
        width={960}
        footer={<Button onClick={closePreview}>Close</Button>}
        destroyOnHidden
      >
        {preview && (
          <Image
            width="100%"
            preview={false}
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
      </Modal>
    </Space>
  );
}
