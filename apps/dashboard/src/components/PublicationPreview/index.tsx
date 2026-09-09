import type {
  PublicationConfirmRequest,
  PublicationConfirmResponse,
  PublicationPreviewQuery,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Drawer, Skeleton, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { useOperatorAccess } from "@/components/OperatorAccess";
import { publicationQueryRoot, publications } from "@/services/publications";
import {
  PublicationAccess,
  publicationAccessDenied,
  publicationError,
  usePublicationReadGuard,
} from "./access";
import { PublicationDocument } from "./Document";
import {
  confirmationFromPreview,
  publicationBlockerLabels,
  publicationDeliveryLimitations,
  publicationFingerprint,
  publicationOutboxPath,
} from "./state";
import "./index.css";

function PreviewSession({
  scope,
  session,
  access,
  onClose,
}: {
  scope: PublicationPreviewQuery;
  session: string;
  access: ReturnType<typeof useOperatorAccess>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState<PublicationConfirmRequest | null>(null);
  const [receipt, setReceipt] = useState<PublicationConfirmResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const inFlight = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previewKey = [
    ...publicationQueryRoot,
    session,
    "preview",
    scope.repositoryId,
    scope.reviewRunId,
    scope.decisionId,
  ];
  const read = usePublicationReadGuard([previewKey]);
  const query = useQuery({
    queryKey: previewKey,
    queryFn: ({ signal }) => read.guard.read(() => publications.preview(scope, signal)),
    enabled: !read.denied && !access.checking,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  const denied =
    read.denied || publicationAccessDenied(query.error) || publicationAccessDenied(failure);
  const verifiedValue = !query.isError && !denied ? query.data : undefined;
  const value = !access.checking ? verifiedValue : undefined;
  const fingerprint = verifiedValue ? publicationFingerprint(verifiedValue) : null;
  const observedFingerprint = useRef<string | null>(null);
  useEffect(() => {
    if (fingerprint === null || observedFingerprint.current === fingerprint) return;
    observedFingerprint.current = fingerprint;
    setConsent(false);
    setSubmitted(null);
    setFailure(null);
    setReceipt(null);
  }, [fingerprint]);
  const refresh = async () => {
    if (inFlight.current || denied || access.checking) return;
    setConsent(false);
    setSubmitted(null);
    setFailure(null);
    setReceipt(null);
    await query.refetch();
  };
  const conflict =
    typeof failure === "object" &&
    failure !== null &&
    "status" in failure &&
    failure.status === 409;
  const confirm = async () => {
    if (
      !value ||
      read.guard.snapshot() ||
      !consent ||
      !access.can("configure") ||
      !value.canConfirm ||
      query.isFetching ||
      conflict ||
      inFlight.current ||
      receipt
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const request = submitted ?? confirmationFromPreview(value, crypto.randomUUID());
      setSubmitted(request);
      const result = await publications.confirm(scope, request);
      if (!mounted.current || read.guard.snapshot()) return;
      if (
        result.intent.actor.issuer !== access.principal?.issuer ||
        result.intent.actor.subject !== access.principal?.subject ||
        !Value.Equal(result.intent.payload, value.payload) ||
        !Value.Equal(result.intent.target, value.target)
      )
        throw new Error("The confirmation receipt does not match this operator and reviewed body.");
      setReceipt(result);
      setConsent(false);
      await client.invalidateQueries({ queryKey: [...publicationQueryRoot, session, "outbox"] });
    } catch (error) {
      if (mounted.current) {
        read.guard.deny(error);
        setFailure(error);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <Drawer
      open
      title="Publication preview"
      size={900}
      onClose={onClose}
      closable={!saving && !access.checking}
      keyboard={!saving && !access.checking}
      mask={{ closable: !saving && !access.checking }}
      extra={
        <Button disabled={saving || access.checking} onClick={() => void access.refresh()}>
          Refresh access
        </Button>
      }
      footer={
        <div
          className="publication-actions"
          hidden={access.checking}
          inert={access.checking}
          aria-hidden={access.checking}
        >
          <Button disabled={saving || access.checking} onClick={onClose}>
            Close
          </Button>
          <Button disabled={saving || denied || access.checking} onClick={() => void refresh()}>
            Refresh preview
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={
              !value?.canConfirm ||
              !consent ||
              !access.can("configure") ||
              query.isFetching ||
              conflict ||
              !!receipt ||
              denied
            }
            onClick={() => void confirm()}
          >
            {submitted && failure && !conflict
              ? "Retry original confirmation"
              : "Confirm publication"}
          </Button>
        </div>
      }
    >
      {access.checking ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : denied ? (
        <Alert
          showIcon
          type="info"
          title="Publication access is unavailable"
          description="The previous preview has been cleared. Refresh access before requesting a new preview."
        />
      ) : query.isError ? (
        <Alert
          showIcon
          type="error"
          title="Could not load publication preview"
          description={publicationError(query.error)}
        />
      ) : !value ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Typography.Paragraph>
            Recording a decision in this platform does not send to GitHub. Confirming this complete
            preview creates a durable delivery intent.
          </Typography.Paragraph>
          {receipt ? (
            <Alert
              className="publication-notice"
              showIcon
              type="success"
              title={
                receipt.replayed
                  ? "Original publication confirmation recovered"
                  : "Publication confirmed"
              }
              description={
                <a href={publicationOutboxPath(scope.repositoryId, receipt.intent.publicationId)}>
                  Inspect delivery in the repository outbox
                </a>
              }
            />
          ) : null}
          {failure ? (
            <Alert
              className="publication-notice"
              showIcon
              type="error"
              title={
                conflict ? "This preview is no longer current" : "Publication confirmation failed"
              }
              description={
                conflict
                  ? "Refresh the preview and review its complete target and body again. Your previous confirmation is not reused for new content."
                  : `${publicationError(failure)} The original request identity is retained for an explicit retry.`
              }
            />
          ) : null}
          {value.blockers.length > 0 && (
            <Alert
              className="publication-notice"
              showIcon
              type="warning"
              title="Publication cannot be confirmed"
              description={
                <ul>
                  {value.blockers.map((code) => (
                    <li key={code}>{publicationBlockerLabels[code]}</li>
                  ))}
                </ul>
              }
            />
          )}
          {value.existingIntent && (
            <Typography.Paragraph>
              <a
                href={publicationOutboxPath(scope.repositoryId, value.existingIntent.publicationId)}
              >
                Open existing publication ({value.existingIntent.status})
              </a>
            </Typography.Paragraph>
          )}
          <Space wrap>
            <Typography.Text type="secondary">Observed {value.observedAt}</Typography.Text>
            <Typography.Text type="secondary">
              Publication policy version {value.policyVersion}
            </Typography.Text>
          </Space>
          <PublicationDocument
            target={value.target}
            payload={value.payload}
            publisherGitHubUserId={value.publisherGitHubUserId}
            binding={value.binding}
            payloadSha256={value.payloadSha256}
          />
          <Alert
            className="publication-notice"
            showIcon
            type="info"
            title="Delivery and recovery"
            description={publicationDeliveryLimitations}
          />
          {!access.allows("configure") && (
            <Typography.Paragraph type="secondary">
              Maintainer access or higher is required to confirm publication.
            </Typography.Paragraph>
          )}
          <Checkbox
            checked={consent}
            disabled={saving || !value.canConfirm || !access.can("configure") || !!receipt}
            onChange={(event) => setConsent(event.target.checked)}
          >
            I have reviewed the complete body, exact GitHub target, commit and event, and authorize
            this publication.
          </Checkbox>
        </>
      )}
    </Drawer>
  );
}
export function PublicationPreview({
  repositoryId,
  reviewRunId,
  decisionId,
  onClose,
}: PublicationPreviewQuery & { onClose: () => void }) {
  const scope = { repositoryId, reviewRunId, decisionId };
  return (
    <PublicationAccess repositoryId={repositoryId}>
      {(session, access) => (
        <PreviewSession
          key={JSON.stringify([session, reviewRunId, decisionId])}
          scope={scope}
          session={session}
          access={access}
          onClose={onClose}
        />
      )}
    </PublicationAccess>
  );
}
