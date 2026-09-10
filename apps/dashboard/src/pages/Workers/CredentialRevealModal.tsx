import { Check, ContentCopy, LockOutlined } from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { WorkerCredentialSecret } from "@/services/review-control";

export interface CredentialRevealModalProps {
  credential: WorkerCredentialSecret | null;
  operation: "created" | "rotated";
  onClose: () => void;
  onCopyError: () => void;
  onCopySuccess: () => void;
}

export function CredentialRevealModal({
  credential,
  operation,
  onClose,
  onCopyError,
  onCopySuccess,
}: CredentialRevealModalProps) {
  const activeRef = useRef(true);
  const copyingRef = useRef(false);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const copyToken = async () => {
    if (credential === null || copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      if (globalThis.navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable.");
      }
      await globalThis.navigator.clipboard.writeText(credential.token);
      if (activeRef.current) onCopySuccess();
    } catch {
      if (activeRef.current) onCopyError();
    } finally {
      copyingRef.current = false;
      if (activeRef.current) setCopying(false);
    }
  };
  if (credential === null) return null;
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      aria-labelledby="credential-reveal-title"
      onClose={(_event, reason) => {
        // A one-time credential closes only through the acknowledgement button.
        if (reason === "backdropClick" || reason === "escapeKeyDown") return;
      }}
    >
      <DialogTitle id="credential-reveal-title">
        {operation === "created" ? "Worker credential created" : "Worker token rotated"}
      </DialogTitle>
      <DialogContent>
        <Stack className="credential-reveal" spacing={3}>
          <Alert severity="warning">
            <AlertTitle>Copy this token now</AlertTitle>
            {operation === "created"
              ? "The token cannot be recovered after this window is closed. Store it in the worker authentication file before continuing."
              : "The previous token is already invalid. Replace it in the worker authentication file before closing this window."}
          </Alert>
          <section aria-label="One-time worker credential" className="credential-reveal__seal">
            <div className="credential-reveal__eyebrow">
              <LockOutlined />
              <span>One-time worker access</span>
            </div>
            <Stack className="credential-reveal__identity" spacing={0.5}>
              <Typography variant="body2" color="text.secondary">
                Worker node ID
              </Typography>
              <Typography variant="body2" className="credential-reveal__node mono">
                {credential.workerNodeId}
              </Typography>
            </Stack>
            <Stack spacing={1}>
              <TextField
                fullWidth
                multiline
                minRows={2}
                maxRows={3}
                label="Bearer token"
                className="credential-reveal__token"
                value={credential.token}
                slotProps={{
                  input: { readOnly: true },
                  htmlInput: { "aria-label": "One-time worker token", spellCheck: false },
                }}
              />
              <Button
                className="credential-reveal__copy"
                variant="outlined"
                startIcon={<ContentCopy />}
                loading={copying}
                onClick={() => void copyToken()}
              >
                Copy token
              </Button>
            </Stack>
          </section>
          <Typography
            className="credential-reveal__footnote"
            variant="body2"
            color="text.secondary"
          >
            Closing this window removes the token from the dashboard. The dashboard does not place
            it in the URL or browser storage.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          disabled={copying}
          startIcon={<Check />}
          onClick={() => {
            if (!copyingRef.current) onClose();
          }}
          variant="contained"
        >
          I saved the credential
        </Button>
      </DialogActions>
    </Dialog>
  );
}
