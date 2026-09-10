import type {
  PublicationConfirmRequest,
  PublicationConfirmResponse,
  PublicationPreviewQuery,
} from "@agentic-review/contracts";
import {
  Alert,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { Value } from "@sinclair/typebox/value";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  const closePreview = () => {
    if (inFlight.current || saving || access.checking) return;
    onClose();
  };
  return (
    <Dialog
      open
      fullWidth
      maxWidth="lg"
      aria-labelledby="publication-preview-title"
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown" || reason === "backdropClick") closePreview();
      }}
    >
      <DialogTitle id="publication-preview-title">
        <Stack
          direction="row"
          sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2 }}
        >
          <span>Publication preview</span>
          <Button disabled={saving || access.checking} onClick={() => void access.refresh()}>
            Refresh access
          </Button>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: "grid", gap: 3 }}>
        {access.checking ? (
          <Skeleton variant="rounded" height={240} />
        ) : denied ? (
          <Alert severity="info">
            <AlertTitle>Publication access is unavailable</AlertTitle>
            The previous preview has been cleared. Refresh access before requesting a new preview.
          </Alert>
        ) : query.isError ? (
          <Alert severity="error">
            <AlertTitle>Could not load publication preview</AlertTitle>
            {publicationError(query.error)}
          </Alert>
        ) : !value ? (
          <Skeleton variant="rounded" height={240} />
        ) : (
          <>
            <Typography>
              Recording a decision in this platform does not send to GitHub. Confirming this
              complete preview creates a durable delivery intent.
            </Typography>
            {receipt && (
              <Alert severity="success">
                <AlertTitle>
                  {receipt.replayed
                    ? "Original publication confirmation recovered"
                    : "Publication confirmed"}
                </AlertTitle>
                <a href={publicationOutboxPath(scope.repositoryId, receipt.intent.publicationId)}>
                  Inspect delivery in the repository outbox
                </a>
              </Alert>
            )}
            {!!failure && (
              <Alert severity="error">
                <AlertTitle>
                  {conflict
                    ? "This preview is no longer current"
                    : "Publication confirmation failed"}
                </AlertTitle>
                {conflict
                  ? "Refresh the preview and review its complete target and body again. Your previous confirmation is not reused for new content."
                  : `${publicationError(failure)} The original request identity is retained for an explicit retry.`}
              </Alert>
            )}
            {value.blockers.length > 0 && (
              <Alert severity="warning">
                <AlertTitle>Publication cannot be confirmed</AlertTitle>
                <ul>
                  {value.blockers.map((code) => (
                    <li key={code}>{publicationBlockerLabels[code]}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {value.existingIntent && (
              <Typography>
                <a
                  href={publicationOutboxPath(
                    scope.repositoryId,
                    value.existingIntent.publicationId,
                  )}
                >
                  Open existing publication ({value.existingIntent.status})
                </a>
              </Typography>
            )}
            <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Observed {value.observedAt}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Publication policy version {value.policyVersion}
              </Typography>
            </Stack>
            <PublicationDocument
              target={value.target}
              payload={value.payload}
              publisherGitHubUserId={value.publisherGitHubUserId}
              binding={value.binding}
              payloadSha256={value.payloadSha256}
            />
            <Alert severity="info">
              <AlertTitle>Delivery and recovery</AlertTitle>
              {publicationDeliveryLimitations}
            </Alert>
            {!access.allows("configure") && (
              <Typography color="text.secondary">
                Maintainer access or higher is required to confirm publication.
              </Typography>
            )}
            <FormControlLabel
              control={
                <Checkbox
                  checked={consent}
                  disabled={saving || !value.canConfirm || !access.can("configure") || !!receipt}
                  onChange={(event) => setConsent(event.target.checked)}
                />
              }
              label="I have reviewed the complete body, exact GitHub target, commit and event, and authorize this publication."
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <div
          className="publication-actions"
          hidden={access.checking}
          inert={access.checking}
          aria-hidden={access.checking}
        >
          <Button disabled={saving || access.checking} onClick={closePreview}>
            Close
          </Button>
          <Button disabled={saving || denied || access.checking} onClick={() => void refresh()}>
            Refresh preview
          </Button>
          <Button
            variant="contained"
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
      </DialogActions>
    </Dialog>
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
