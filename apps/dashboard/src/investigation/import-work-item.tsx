import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { investigationApi, type Repository } from "./api";
import { useInvestigationSession } from "./session";

export function ImportWorkItemButton({
  repository,
  initialKind = "pull_request",
}: {
  repository: Repository;
  initialKind?: "pull_request" | "issue";
}) {
  const { session } = useInvestigationSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(initialKind);
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sample = process.env.NODE_ENV === "development";
  const importItem = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const parsed = Number(number);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error("Enter a valid pull request or issue number.");
      const result = await investigationApi.importWorkItem(repository.id, { kind, number: parsed });
      await queryClient.invalidateQueries({ queryKey: ["investigation-work-items"] });
      await queryClient.invalidateQueries({
        queryKey: ["investigation-work-item", result.workItem.id],
      });
      setOpen(false);
      navigate(
        `${result.workItem.kind === "pull_request" ? "/pull-requests" : "/issues"}?repositoryId=${encodeURIComponent(repository.id)}&workItemId=${encodeURIComponent(result.workItem.id)}`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The source snapshot could not be imported.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outlined"
        disabled={sample || !session.user?.permissions.includes("repository:manage")}
        onClick={() => {
          setOpen(true);
          setError(undefined);
        }}
      >
        Import from GitHub
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Import a source snapshot</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography>{repository.fullName}</Typography>
            <Typography variant="body2" color="text.secondary">
              Read the current item and its complete comment history into this workspace. This does
              not post or change anything on GitHub.
            </Typography>
            <TextField
              select
              label="Work item"
              value={kind}
              onChange={(event) => setKind(event.target.value as "pull_request" | "issue")}
            >
              <MenuItem value="pull_request">Pull request</MenuItem>
              <MenuItem value="issue">Issue</MenuItem>
            </TextField>
            <TextField
              label="Number"
              type="number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" disabled={busy || !number} onClick={() => void importItem()}>
            {busy ? "Importing…" : "Import snapshot"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
