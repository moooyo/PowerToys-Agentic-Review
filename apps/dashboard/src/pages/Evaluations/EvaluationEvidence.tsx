import type * as C from "@agentic-review/contracts";
import { Alert, Button, Image, Modal, Space, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EvaluationEvidenceAdapter } from "@/services/evaluation-evidence";
import { useEvaluationPage, useEvaluationQuery } from "./context";
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
    <Image
      preview={false}
      src={preview.url}
      alt={`Evidence ${preview.assetId}`}
      style={{ maxWidth: "100%" }}
    />
  ) : preview?.kind === "text" ? (
    <>
      <Typography.Paragraph type="secondary">
        {preview.truncated
          ? `Truncated preview: the first ${maximumEvidenceTextPreviewBytes / 1024} KiB. Download the verified file for all content.`
          : "Complete verified text file."}
      </Typography.Paragraph>
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
        <Typography.Title level={5} style={{ margin: 0 }}>
          Evidence files
        </Typography.Title>
        <Button
          disabled={!enabled || session.busy !== null}
          loading={files.isFetching}
          onClick={() => {
            owner.reset();
            void files.refetch();
          }}
        >
          Refresh files
        </Button>
      </div>
      <Typography.Paragraph type="secondary">
        Preview and download verify the complete file bytes against the refreshed manifest.
        Verifying a file does not verify a UI assertion or change the result's evidence assessment.
      </Typography.Paragraph>
      {files.error ? (
        <Alert
          type="error"
          title="Evidence list unavailable"
          description={errorMessage(files.error)}
        />
      ) : null}
      {session.error && enabled ? (
        <Alert
          type={session.error.status === 404 || session.error.status === 410 ? "info" : "error"}
          title={errorLabel}
          description={`${session.error.assetId}: ${session.error.message}`}
        />
      ) : null}
      {session.downloaded && enabled ? (
        <Alert type="success" title="Verified download started" description={session.downloaded} />
      ) : null}
      <Table<EvidenceRow>
        rowKey="assetId"
        size="small"
        dataSource={enabled && !files.error && !loading ? (files.data ?? []) : []}
        loading={enabled && loading}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          {
            title: "File",
            key: "file",
            render: (_, row) => (
              <div>
                <Typography.Text copyable>{row.assetId}</Typography.Text>
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
            ),
          },
          {
            title: "Status",
            key: "status",
            width: 170,
            render: (_, row) => (
              <Tag>
                {row.manifest === null
                  ? "Missing"
                  : row.manifest.state === "retired"
                    ? "Retired"
                    : session.error?.assetId === row.assetId
                      ? "Unavailable"
                      : "Recorded; verify on open"}
              </Tag>
            ),
          },
          {
            title: "Actions",
            key: "actions",
            width: 175,
            render: (_, row) => {
              const manifest = row.manifest,
                disabled =
                  !enabled || loading || session.busy !== null || manifest?.state !== "finalized";
              return (
                <Space wrap>
                  {manifest && manifest.metadata.kind !== "trace" ? (
                    <Button
                      size="small"
                      disabled={disabled}
                      aria-label={`Preview evidence ${row.assetId}`}
                      loading={session.busy === row.assetId}
                      onClick={() => {
                        if (!disabled) void owner.run("preview", manifest);
                      }}
                    >
                      Preview
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    disabled={disabled}
                    aria-label={`Download evidence ${row.assetId}`}
                    onClick={() => {
                      if (!disabled && manifest) void owner.run("download", manifest);
                    }}
                  >
                    Download
                  </Button>
                </Space>
              );
            },
          },
        ]}
      />
      <Modal
        open={preview !== null}
        title={preview ? `Verified file preview · ${preview.assetId}` : "Evidence preview"}
        onCancel={() => owner.closePreview()}
        getContainer={false}
        footer={<Button onClick={() => owner.closePreview()}>Close preview</Button>}
        width={980}
        styles={{ container: { maxWidth: "94vw" } }}
        destroyOnHidden
      >
        <EvidencePreviewContent preview={preview} />
      </Modal>
    </div>
  );
}
