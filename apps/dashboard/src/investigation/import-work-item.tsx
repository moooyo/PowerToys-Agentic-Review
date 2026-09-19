import type { InvestigationSession } from "@agentic-review/contracts";
import AddRounded from "@mui/icons-material/AddRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import HistoryRounded from "@mui/icons-material/HistoryRounded";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import { investigationApi, type Repository, type WorkItem } from "./api";
import { useGuardedAction, useUnsavedChanges } from "./navigation-guard";
import { sessionIdentity, useInvestigationSession } from "./session";
import { InvestigationHttpError } from "./transport";

type SourceKind = "pull_request" | "issue";
type ImportFailure = { field: "repository" | "number" | "form"; message: string };
type ImportRequest = { repositoryId: string; input: { kind: SourceKind; number: number } };

export class ImportWorkItemValidationError extends Error {
  constructor(
    readonly field: "repository" | "number",
    message: string,
  ) {
    super(message);
    this.name = "ImportWorkItemValidationError";
  }
}

export function importableRepositories(
  repositories: Repository[],
  session: InvestigationSession,
): Repository[] {
  if (!session.authenticated) return [];
  const user = session.user;
  if (!user.permissions.includes("repository:manage")) return [];
  return repositories.filter((repository) => user.repositoryIds.includes(repository.id));
}

export function importWorkItemRequest(
  repositoryId: string,
  kind: SourceKind,
  number: string,
  repositories: Repository[],
  session: InvestigationSession,
): ImportRequest {
  if (!importableRepositories(repositories, session).some((entry) => entry.id === repositoryId))
    throw new ImportWorkItemValidationError(
      "repository",
      "Choose a repository you can manage before importing a source snapshot.",
    );
  const trimmed = number.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new ImportWorkItemValidationError(
      "number",
      `Enter a positive whole ${kind === "pull_request" ? "pull request" : "issue"} number.`,
    );
  return { repositoryId, input: { kind, number: parsed } };
}

export function currentImportSnapshot(
  request: ImportRequest,
  items: WorkItem[],
): WorkItem | undefined {
  if (
    items.some(
      (item) => item.repositoryId !== request.repositoryId || item.kind !== request.input.kind,
    )
  )
    throw new Error("The source list did not match the selected repository and source type.");
  const snapshot = items.find((item) => item.number === request.input.number);
  if (
    snapshot &&
    (snapshot.subject.repositoryId !== snapshot.repositoryId ||
      snapshot.subject.workItemId !== snapshot.id)
  )
    throw new Error("The saved source revision did not match the selected work item.");
  return snapshot;
}

function ImportWorkItemDialog({
  repository,
  initialKind,
  onClose,
}: {
  repository?: Repository;
  initialKind: SourceKind;
  onClose: () => void;
}) {
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const guardedAction = useGuardedAction();
  const id = useId();
  const [repositoryId, setRepositoryId] = useState<string>();
  const [initialRepositoryId, setInitialRepositoryId] = useState<string>();
  const [kind, setKind] = useState(initialKind);
  const [number, setNumber] = useState("");
  const [failure, setFailure] = useState<ImportFailure>();
  const [busy, setBusy] = useState(false);
  const [checkingSource, setCheckingSource] = useState(false);
  const [conflict, setConflict] = useState<ImportRequest>();
  const [sourceReview, setSourceReview] = useState<{ snapshot?: WorkItem }>();
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const repositoryInput = useRef<HTMLSelectElement>(null);
  const numberInput = useRef<HTMLInputElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const canManage = session.authenticated && session.user.permissions.includes("repository:manage");
  const repositoriesQuery = useQuery({
    queryKey: ["investigation-repositories", identity],
    queryFn: () => investigationApi.repositories(),
    enabled: canManage,
    retry: false,
  });
  const repositories = repositoriesQuery.data?.items ?? [];
  const permittedRepositories = importableRepositories(repositories, session);
  const defaultRepositoryId =
    permittedRepositories.find((entry) => entry.id === repository?.id)?.id ??
    permittedRepositories[0]?.id ??
    "";
  const selectedRepositoryId = repositoryId ?? defaultRepositoryId;
  const selectedRepository = permittedRepositories.find(
    (entry) => entry.id === selectedRepositoryId,
  );
  const dirty =
    number !== "" ||
    kind !== initialKind ||
    selectedRepositoryId !== (initialRepositoryId ?? defaultRepositoryId);
  useUnsavedChanges(dirty, {
    busy,
    description: "Your source import details have not been saved.",
    onDiscard: onClose,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    if (initialRepositoryId === undefined && repositoriesQuery.isSuccess) {
      setInitialRepositoryId(defaultRepositoryId);
      setRepositoryId((current) => current ?? defaultRepositoryId);
    }
  }, [defaultRepositoryId, initialRepositoryId, repositoriesQuery.isSuccess]);
  useEffect(() => {
    if (failure?.field === "repository") repositoryInput.current?.focus();
    else if (failure?.field === "number") numberInput.current?.focus();
    else if (failure?.field === "form") errorSummary.current?.focus();
  }, [failure]);

  const close = () => {
    if (!pending.current) guardedAction(onClose);
  };
  const reloadSource = async () => {
    if (pending.current || !conflict) return;
    pending.current = true;
    const requestGeneration = ++generation.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === requestGeneration &&
      currentIdentity.current === identity;
    setBusy(true);
    setCheckingSource(true);
    try {
      const page = await investigationApi.workItems(conflict.repositoryId, conflict.input.kind);
      if (!isCurrent()) return;
      const snapshot = currentImportSnapshot(conflict, page.items);
      queryClient.setQueryData(
        ["investigation-work-items", conflict.repositoryId, conflict.input.kind],
        page,
      );
      if (snapshot) queryClient.setQueryData(["investigation-work-item", snapshot.id], snapshot);
      setSourceReview({ snapshot });
      setConflict(undefined);
      setFailure(undefined);
    } catch (cause) {
      if (!isCurrent()) return;
      setFailure({
        field: "form",
        message:
          cause instanceof Error ? cause.message : "The current snapshot could not be loaded.",
      });
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
        setCheckingSource(false);
      }
    }
  };
  const importItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || conflict) return;
    pending.current = true;
    const requestGeneration = ++generation.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === requestGeneration &&
      currentIdentity.current === identity;
    setFailure(undefined);
    setSourceReview(undefined);
    let request: ImportRequest | undefined;
    try {
      if (repositoriesQuery.isPending || repositoriesQuery.isError)
        throw new ImportWorkItemValidationError(
          "repository",
          "Load the available repositories before importing a source snapshot.",
        );
      request = importWorkItemRequest(selectedRepositoryId, kind, number, repositories, session);
      setBusy(true);
      const result = await investigationApi.importWorkItem(request.repositoryId, request.input);
      if (!isCurrent()) return;
      if (
        result.workItem.repositoryId !== request.repositoryId ||
        result.workItem.kind !== request.input.kind ||
        result.workItem.number !== request.input.number
      )
        throw new Error(
          "The imported snapshot did not match the selected source. Reload the source list before trying again.",
        );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["investigation-work-items"] }),
        queryClient.invalidateQueries({
          queryKey: ["investigation-work-item", result.workItem.id],
        }),
      ]);
      if (!isCurrent()) return;
      flushSync(onClose);
      navigate(
        `${result.workItem.kind === "pull_request" ? "/pull-requests" : "/issues"}?repositoryId=${encodeURIComponent(request.repositoryId)}&workItemId=${encodeURIComponent(result.workItem.id)}`,
      );
    } catch (cause) {
      if (!isCurrent()) return;
      if (request && cause instanceof InvestigationHttpError && cause.status === 409)
        setConflict(request);
      setFailure({
        field: cause instanceof ImportWorkItemValidationError ? cause.field : "form",
        message:
          cause instanceof Error ? cause.message : "The source snapshot could not be imported.",
      });
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Dialog
      open
      onClose={(_event, reason) => {
        if ((reason === "escapeKeyDown" || reason === "backdropClick") && (busy || pending.current))
          return;
        close();
      }}
      fullWidth
      maxWidth="xs"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      slotProps={{ paper: { sx: { m: 2, width: "calc(100% - 32px)" } } }}
    >
      <DialogTitle id={`${id}-title`} sx={{ pr: 8 }}>
        Import a source snapshot
      </DialogTitle>
      <IconButton
        aria-label="Close source import"
        disabled={busy}
        onClick={close}
        sx={{ position: "absolute", right: 16, top: 16 }}
      >
        <CloseRounded />
      </IconButton>
      <DialogContent>
        <Typography id={`${id}-description`} variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Choose the source to bring into this workspace.
        </Typography>
        <Stack
          component="form"
          id={`${id}-form`}
          onSubmit={(event: FormEvent<HTMLFormElement>) => void importItem(event)}
          spacing={3}
          noValidate
          aria-busy={busy}
        >
          {failure?.field === "form" && (
            <Alert severity="error" ref={errorSummary} tabIndex={-1}>
              {failure.message}
            </Alert>
          )}
          {conflict && (
            <Alert severity="warning">
              <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
                <Typography variant="body2">
                  The source could not be imported with its previous context. Your import details
                  are kept. Load the current snapshot, review it, and submit again.
                </Typography>
                <Button disabled={busy} onClick={() => void reloadSource()} sx={{ ml: -2 }}>
                  {checkingSource ? "Loading…" : "Load current snapshot"}
                </Button>
              </Stack>
            </Alert>
          )}
          {sourceReview && (
            <Alert severity="info">
              {sourceReview.snapshot ? (
                <Stack spacing={1}>
                  <Typography variant="subtitle2">Current snapshot loaded</Typography>
                  <Typography variant="body2">
                    #{sourceReview.snapshot.number} · {sourceReview.snapshot.title}
                  </Typography>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    Saved revision: <code>{sourceReview.snapshot.subject.revisionKey}</code>
                  </Typography>
                  <Typography variant="body2">
                    Review this source before importing its latest snapshot again.
                  </Typography>
                </Stack>
              ) : (
                "No saved snapshot was found for this source. Review the repository, source type, and number before importing again."
              )}
            </Alert>
          )}
          <Stack spacing={1}>
            <Typography
              component="label"
              htmlFor={`${id}-repository`}
              variant="body2"
              color="text.secondary"
            >
              Repository
            </Typography>
            <TextField
              id={`${id}-repository`}
              select
              value={selectedRepository ? selectedRepositoryId : ""}
              onChange={(event) => {
                setRepositoryId(event.target.value);
                setSourceReview(undefined);
              }}
              inputRef={repositoryInput}
              disabled={busy || !!conflict || repositoriesQuery.isPending || !canManage}
              error={failure?.field === "repository"}
              helperText={failure?.field === "repository" ? failure.message : undefined}
              slotProps={{ select: { native: true } }}
              fullWidth
            >
              {!selectedRepository && <option value="">Choose a repository</option>}
              {permittedRepositories.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.fullName}
                </option>
              ))}
            </TextField>
            {repositoriesQuery.isPending && canManage && (
              <Stack direction="row" spacing={1} role="status" sx={{ alignItems: "center" }}>
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">
                  Loading repositories…
                </Typography>
              </Stack>
            )}
            {repositoriesQuery.isError && (
              <Alert
                severity="error"
                action={
                  <Button
                    disabled={repositoriesQuery.isFetching}
                    onClick={() => void repositoriesQuery.refetch()}
                  >
                    Retry
                  </Button>
                }
              >
                {repositoriesQuery.error instanceof Error
                  ? repositoriesQuery.error.message
                  : "Repositories could not be loaded."}
              </Alert>
            )}
            {!canManage || (repositoriesQuery.isSuccess && !permittedRepositories.length) ? (
              <Alert severity="info">
                Importing requires Manage repositories permission and access to a repository.
              </Alert>
            ) : null}
          </Stack>
          <Stack spacing={1}>
            <Typography
              component="label"
              htmlFor={`${id}-kind`}
              variant="body2"
              color="text.secondary"
            >
              Source type
            </Typography>
            <TextField
              id={`${id}-kind`}
              select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as SourceKind);
                setSourceReview(undefined);
              }}
              disabled={busy || !!conflict}
              slotProps={{ select: { native: true } }}
              fullWidth
            >
              <option value="pull_request">Pull request</option>
              <option value="issue">Issue</option>
            </TextField>
          </Stack>
          <Stack spacing={1}>
            <Typography
              component="label"
              htmlFor={`${id}-number`}
              variant="body2"
              color="text.secondary"
            >
              {kind === "pull_request" ? "Pull request" : "Issue"} number
            </Typography>
            <TextField
              id={`${id}-number`}
              value={number}
              onChange={(event) => {
                setNumber(event.target.value);
                setSourceReview(undefined);
              }}
              placeholder={kind === "pull_request" ? "For example, 2105" : "For example, 3103"}
              inputRef={numberInput}
              disabled={busy || !!conflict}
              error={failure?.field === "number"}
              helperText={
                failure?.field === "number"
                  ? failure.message
                  : "Use the number shown beside the source title."
              }
              slotProps={{ htmlInput: { inputMode: "numeric", pattern: "[0-9]*", maxLength: 32 } }}
              autoFocus
              fullWidth
            />
          </Stack>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{
              p: 2,
              borderRadius: 2,
              bgcolor: "var(--app-surface-container)",
              color: "text.secondary",
            }}
          >
            <HistoryRounded sx={{ fontSize: 22, flexShrink: 0 }} />
            <Typography variant="body2" sx={{ lineHeight: "22px" }}>
              A snapshot includes the description, discussion, and source revision. Importing reads
              the source without changing anything on GitHub.
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ borderTop: 1, borderColor: "divider", pt: 2 }}>
        <Button disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={`${id}-form`}
          variant="contained"
          disabled={
            busy ||
            !!conflict ||
            !selectedRepository ||
            repositoriesQuery.isPending ||
            repositoriesQuery.isError
          }
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {checkingSource ? "Checking source…" : busy ? "Importing…" : "Import snapshot"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ImportWorkItemButton({
  repository,
  initialKind = "pull_request",
}: {
  repository?: Repository;
  initialKind?: SourceKind;
}) {
  const { session } = useInvestigationSession();
  const [open, setOpen] = useState(false);
  const sample = process.env.NODE_ENV === "development";
  const canImport =
    session.authenticated &&
    session.user.permissions.includes("repository:manage") &&
    session.user.repositoryIds.length > 0;
  return (
    <>
      <Tooltip
        title={
          sample
            ? "Source import is unavailable in the sample workspace."
            : !canImport
              ? "Manage repositories permission and repository access are required."
              : ""
        }
      >
        <span style={{ display: "inline-flex" }}>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            disabled={sample || !canImport}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            Import from GitHub
          </Button>
        </span>
      </Tooltip>
      {open && (
        <ImportWorkItemDialog
          key={sessionIdentity(session)}
          repository={repository}
          initialKind={initialKind}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
