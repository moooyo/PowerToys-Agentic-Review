import {
  Add,
  Key,
  Refresh,
  Search,
  StopCircleOutlined,
  ViewColumnOutlined,
} from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  LinearProgress,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OperatorAccessGate } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { StatusTag } from "@/components/StatusTag";
import { EmptyState, notify } from "@/components/ui";
import { reviewControl, type WorkerCredentialSecret } from "@/services/review-control";
import { useOperatorSession } from "@/state/session";
import { asSearchValue } from "@/utils/table";
import { CredentialRevealModal } from "./CredentialRevealModal";
import {
  isSafeWorkerDisplayName,
  runSingleFlight,
  type SynchronousGate,
  tryAcquireGate,
  workerMutationErrorText,
} from "./credential-mutation";
import {
  createWorkerInventorySnapshotCache,
  DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
  filterWorkerInventory,
  isCanonicalWorkerNodeId,
  MAX_WORKER_INVENTORY_PAGE_SIZE,
  mergeWorkerInventory,
  paginateWorkerInventory,
  type WorkerInventoryAuthState,
  type WorkerInventoryRow,
  type WorkerInventoryRuntimeState,
  type WorkerInventorySnapshotCache,
} from "./worker-inventory";
import "./index.css";

type MutationKey = "create" | `rotate:${string}` | `revoke:${string}`;
interface RevealedCredential {
  operation: "created" | "rotated";
  secret: WorkerCredentialSecret;
}
interface WorkerColumn {
  id: string;
  label: string;
  minWidth: number;
  render: (row: WorkerInventoryRow) => ReactNode;
}
interface CredentialConfirmation {
  operation: "rotate" | "revoke";
  row: WorkerInventoryRow;
  release: () => void;
}
const columnPreferenceKey = "agentic-review:workers:columns:v1";
const defaultHiddenColumns = [
  "capabilities",
  "credentialUpdatedAt",
  "diskFreeGb",
  "lastHeartbeatAt",
  "version",
];
const configurableColumns = [
  "authState",
  "runtimeState",
  "location",
  "slots",
  "capabilities",
  "currentJobs",
  "diskFreeGb",
  "lastHeartbeatAt",
  "credentialUpdatedAt",
  "version",
];

function readHiddenColumns(): string[] {
  try {
    const saved: unknown = JSON.parse(
      globalThis.localStorage.getItem(columnPreferenceKey) ?? "null",
    );
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      return configurableColumns.filter((id) => {
        const column = (saved as Record<string, unknown>)[id];
        return column && typeof column === "object"
          ? (column as { show?: unknown }).show === false
          : defaultHiddenColumns.includes(id);
      });
    }
  } catch {
    // Column preferences are optional when browser storage is unavailable.
  }
  return [...defaultHiddenColumns];
}

export default function WorkersPage() {
  const { initialState } = useOperatorSession();
  const identity = JSON.stringify([
    initialState?.sessionEpoch,
    initialState?.authenticationEpoch,
    initialState?.currentUser?.principal,
  ]);
  return (
    <OperatorAccessGate platformOnly>
      <WorkersContent key={identity} />
    </OperatorAccessGate>
  );
}

function WorkersContent() {
  const activeRef = useRef(true);
  const inventoryRequestGeneration = useRef(0);
  const confirmationGateRef = useRef<SynchronousGate>({ active: false });
  const credentialMutationGateRef = useRef<SynchronousGate>({ active: false });
  const inventoryCacheRef = useRef<WorkerInventorySnapshotCache | null>(null);
  if (inventoryCacheRef.current === null) {
    inventoryCacheRef.current = createWorkerInventorySnapshotCache(async () => {
      const [credentials, workers] = await Promise.all([
        reviewControl.listWorkerCredentials(),
        reviewControl.listAllWorkers(),
      ]);
      return mergeWorkerInventory(credentials.items, workers.items);
    });
  }
  const inventoryCache = inventoryCacheRef.current;
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState<WorkerInventoryAuthState | "all">("all");
  const [runtimeFilter, setRuntimeFilter] = useState<WorkerInventoryRuntimeState | "all">("all");
  const [inventory, setInventory] = useState<WorkerInventoryRow[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_WORKER_INVENTORY_PAGE_SIZE);
  const [mutationKey, setMutationKey] = useState<MutationKey | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<RevealedCredential | null>(null);
  const [confirmation, setConfirmation] = useState<CredentialConfirmation | null>(null);
  const [columnAnchor, setColumnAnchor] = useState<HTMLElement | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(readHiddenColumns);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebouncedSearch(search), 180);
    return () => globalThis.clearTimeout(timer);
  }, [search]);
  const loadInventory = useCallback(() => {
    const generation = ++inventoryRequestGeneration.current;
    setInventoryLoading(true);
    setInventoryError(null);
    void inventoryCache
      .load()
      .then((rows) => {
        if (generation === inventoryRequestGeneration.current) setInventory(rows);
      })
      .catch((error: unknown) => {
        if (generation !== inventoryRequestGeneration.current) return;
        setInventory([]);
        setInventoryError(workerMutationErrorText(error, "Refresh the worker list to try again."));
      })
      .finally(() => {
        if (generation === inventoryRequestGeneration.current) setInventoryLoading(false);
      });
  }, [inventoryCache]);
  useEffect(() => {
    loadInventory();
    return () => {
      inventoryRequestGeneration.current += 1;
    };
  }, [loadInventory]);
  useEffect(() => {
    try {
      // Persist only column visibility. Credential material stays in component memory.
      globalThis.localStorage.setItem(
        columnPreferenceKey,
        JSON.stringify(
          Object.fromEntries(
            configurableColumns.map((id) => [id, { show: !hiddenColumns.includes(id) }]),
          ),
        ),
      );
    } catch {
      // The inventory remains usable without browser storage.
    }
  }, [hiddenColumns]);

  const filteredRows = useMemo(
    () =>
      filterWorkerInventory(inventory, {
        search: asSearchValue(debouncedSearch),
        authState: accessFilter === "all" ? undefined : accessFilter,
        runtimeState: runtimeFilter === "all" ? undefined : runtimeFilter,
      }),
    [inventory, debouncedSearch, accessFilter, runtimeFilter],
  );
  const inventoryPage = paginateWorkerInventory(filteredRows, page, pageSize);
  const hasFilters = search.length > 0 || accessFilter !== "all" || runtimeFilter !== "all";
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [filteredRows.length, page, pageSize]);

  const reloadInventory = () => {
    inventoryCache.invalidate();
    loadInventory();
  };
  const closeCreate = () => {
    if (credentialMutationGateRef.current.active) return;
    setCreateOpen(false);
    setDisplayName("");
    setNameError(null);
  };
  const createWorker = async () => {
    if (displayName.length > 128) {
      setNameError("Use 128 characters or fewer.");
      return;
    }
    if (displayName.trim().length === 0) {
      setNameError("Enter a display name.");
      return;
    }
    if (!isSafeWorkerDisplayName(displayName)) {
      setNameError("Display names cannot contain worker credential material.");
      return;
    }
    await runSingleFlight(credentialMutationGateRef.current, async () => {
      setMutationKey("create");
      try {
        const secret = await reviewControl.createWorkerCredential(displayName.trim());
        if (!activeRef.current) return;
        setCreateOpen(false);
        setDisplayName("");
        setNameError(null);
        setRevealedCredential({ operation: "created", secret });
        reloadInventory();
      } catch (error) {
        if (activeRef.current)
          notify(
            workerMutationErrorText(error, "The worker credential could not be created."),
            "error",
          );
      } finally {
        if (activeRef.current) setMutationKey(null);
      }
    });
  };
  const openConfirmation = (operation: "rotate" | "revoke", row: WorkerInventoryRow) => {
    if (
      row.credential === undefined ||
      row.authState === "revoked" ||
      !isCanonicalWorkerNodeId(row.workerNodeId)
    )
      return;
    const release = tryAcquireGate(confirmationGateRef.current);
    if (release) setConfirmation({ operation, row, release });
  };
  const closeConfirmation = () => {
    if (credentialMutationGateRef.current.active) return;
    confirmation?.release();
    setConfirmation(null);
  };
  const confirmCredentialMutation = async () => {
    if (!confirmation) return;
    const { operation, row, release } = confirmation;
    await runSingleFlight(credentialMutationGateRef.current, async () => {
      setMutationKey(`${operation}:${row.workerNodeId}` as MutationKey);
      try {
        if (operation === "rotate") {
          if (!row.credential) return;
          const secret = await reviewControl.rotateWorkerToken(
            row.workerNodeId,
            row.credential.updatedAt,
          );
          if (!activeRef.current) return;
          setRevealedCredential({ operation: "rotated", secret });
        } else {
          await reviewControl.revokeWorkerToken(row.workerNodeId);
          if (!activeRef.current) return;
          notify("Worker access revoked.");
        }
        reloadInventory();
      } catch (error) {
        if (activeRef.current)
          notify(
            workerMutationErrorText(
              error,
              operation === "rotate"
                ? "The worker token could not be rotated."
                : "Worker access could not be revoked.",
            ),
            "error",
          );
      } finally {
        release();
        if (activeRef.current) {
          setMutationKey(null);
          setConfirmation(null);
        }
      }
    });
  };

  const columns: WorkerColumn[] = [
    {
      id: "workerNodeId",
      label: "Worker",
      minWidth: 250,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            {row.displayName}
          </Typography>
          <Tooltip title={row.workerNodeId}>
            <Typography component="span" className="worker-inventory__node-id mono">
              {row.workerNodeId}
            </Typography>
          </Tooltip>
          {row.runtime && (
            <Typography component="span" className="worker-inventory__instance-id mono">
              {row.runtime.instanceId}
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: "authState",
      label: "Access",
      minWidth: 108,
      render: (row) => <StatusTag status={row.authState} />,
    },
    {
      id: "runtimeState",
      label: "Runtime",
      minWidth: 126,
      render: (row) => <StatusTag status={row.runtimeState} />,
    },
    {
      id: "location",
      label: "Location",
      minWidth: 120,
      render: (row) => row.runtime?.location ?? "—",
    },
    {
      id: "slots",
      label: "Slots",
      minWidth: 132,
      render: (row) =>
        row.runtime ? (
          <Stack spacing={0.5}>
            <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {row.runtime.activeSlots}/{row.runtime.maxSlots}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={
                row.runtime.maxSlots > 0
                  ? Math.min(
                      100,
                      Math.round((row.runtime.activeSlots / row.runtime.maxSlots) * 100),
                    )
                  : 0
              }
              aria-label={`Used slots for ${row.displayName}`}
              aria-valuetext={`${row.runtime.activeSlots} of ${row.runtime.maxSlots}`}
              sx={{ borderRadius: 1 }}
            />
          </Stack>
        ) : (
          "—"
        ),
    },
    {
      id: "capabilities",
      label: "Capabilities",
      minWidth: 220,
      render: (row) =>
        row.runtime ? (
          <Stack direction="row" useFlexGap sx={{ flexWrap: "wrap", gap: 0.5 }}>
            {row.runtime.capabilities.map((capability) => (
              <Chip key={capability} variant="outlined" label={capability} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Awaiting registration
          </Typography>
        ),
    },
    {
      id: "currentJobs",
      label: "Current jobs",
      minWidth: 180,
      render: (row) =>
        !row.runtime || row.runtime.currentJobs.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {row.runtime ? "Idle" : "—"}
          </Typography>
        ) : (
          <Stack>
            {row.runtime.currentJobs.map((job) => (
              <Typography variant="body2" className="mono" key={job}>
                {job}
              </Typography>
            ))}
          </Stack>
        ),
    },
    {
      id: "diskFreeGb",
      label: "Disk free",
      minWidth: 104,
      render: (row) =>
        row.runtime?.diskFreeGb === undefined ? "—" : `${row.runtime.diskFreeGb} GB`,
    },
    {
      id: "lastHeartbeatAt",
      label: "Heartbeat",
      minWidth: 168,
      render: (row) =>
        row.runtime?.lastHeartbeatAt ? (
          <time dateTime={row.runtime.lastHeartbeatAt}>
            {new Date(row.runtime.lastHeartbeatAt).toLocaleString()}
          </time>
        ) : (
          "—"
        ),
    },
    {
      id: "credentialUpdatedAt",
      label: "Credential updated",
      minWidth: 168,
      render: (row) =>
        row.credential?.updatedAt ? (
          <time dateTime={row.credential.updatedAt}>
            {new Date(row.credential.updatedAt).toLocaleString()}
          </time>
        ) : (
          "—"
        ),
    },
    { id: "version", label: "Version", minWidth: 92, render: (row) => row.runtime?.version ?? "—" },
    {
      id: "actions",
      label: "Actions",
      minWidth: 104,
      render: (row) => {
        const legacyNodeId = !isCanonicalWorkerNodeId(row.workerNodeId);
        const unavailable =
          row.credential === undefined || row.authState === "revoked" || legacyNodeId;
        const unavailableReason = legacyNodeId
          ? "Legacy worker node IDs cannot use credential mutations"
          : "No rotatable credential is available";
        return (
          <Stack direction="row" spacing={0.25}>
            <Tooltip title={unavailable ? unavailableReason : "Rotate token"}>
              <span>
                <IconButton
                  aria-label={`Rotate token for ${row.workerNodeId}`}
                  disabled={mutationKey !== null || unavailable}
                  loading={mutationKey === `rotate:${row.workerNodeId}`}
                  onClick={() => openConfirmation("rotate", row)}
                >
                  <Key />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip
              title={
                unavailable
                  ? legacyNodeId
                    ? unavailableReason
                    : "Worker access is already unavailable"
                  : "Revoke access"
              }
            >
              <span>
                <IconButton
                  color="error"
                  aria-label={`Revoke access for ${row.workerNodeId}`}
                  disabled={mutationKey !== null || unavailable}
                  loading={mutationKey === `revoke:${row.workerNodeId}`}
                  onClick={() => openConfirmation("revoke", row)}
                >
                  <StopCircleOutlined />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        );
      },
    },
  ];
  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(column.id));

  return (
    <section aria-labelledby="workers-page-title" className="workers-page">
      <PageHeader
        eyebrow="Operations"
        title="Workers"
        titleId="workers-page-title"
        description="Manage workers, capacity, and access."
        actions={
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button
              variant="outlined"
              startIcon={<Refresh />}
              loading={inventoryLoading}
              onClick={reloadInventory}
            >
              Refresh
            </Button>
            <Button
              variant="contained"
              disabled={mutationKey !== null}
              startIcon={<Add />}
              onClick={() => setCreateOpen(true)}
            >
              Register worker
            </Button>
          </Stack>
        }
      />
      <Box component="section" className="workers-panel" aria-label="Worker inventory">
        <Box className="workers-filters" sx={{ mb: 3 }}>
          <TextField
            className="workers-search"
            label="Search workers"
            placeholder="Name, node, instance, or location"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            slotProps={{
              htmlInput: { "aria-label": "Search workers" },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search />
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            select
            label="Access"
            value={accessFilter}
            sx={{ minWidth: 136 }}
            onChange={(event) => {
              setAccessFilter(event.target.value as WorkerInventoryAuthState | "all");
              setPage(1);
            }}
          >
            {[
              ["all", "All access"],
              ["pending", "Pending"],
              ["active", "Active"],
              ["revoked", "Revoked"],
              ["unknown", "Unknown"],
            ].map(([value, label]) => (
              <MenuItem value={value} key={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Runtime"
            value={runtimeFilter}
            sx={{ minWidth: 156 }}
            onChange={(event) => {
              setRuntimeFilter(event.target.value as WorkerInventoryRuntimeState | "all");
              setPage(1);
            }}
          >
            {[
              ["all", "All runtime"],
              ["online", "Online"],
              ["draining", "Draining"],
              ["offline", "Offline"],
              ["disabled", "Disabled"],
              ["not_connected", "Not connected"],
            ].map(([value, label]) => (
              <MenuItem value={value} key={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          {hasFilters && (
            <Button
              onClick={() => {
                setSearch("");
                setDebouncedSearch("");
                setAccessFilter("all");
                setRuntimeFilter("all");
                setPage(1);
              }}
            >
              Reset
            </Button>
          )}
          <Button
            variant="outlined"
            sx={{ ml: "auto" }}
            startIcon={<ViewColumnOutlined />}
            onClick={(event) => setColumnAnchor(event.currentTarget)}
            aria-expanded={columnAnchor !== null}
          >
            Columns
          </Button>
        </Box>
        <Menu
          anchorEl={columnAnchor}
          open={columnAnchor !== null}
          onClose={() => setColumnAnchor(null)}
        >
          {columns
            .filter((column) => configurableColumns.includes(column.id))
            .map((column) => (
              <MenuItem
                key={column.id}
                role="menuitemcheckbox"
                aria-checked={!hiddenColumns.includes(column.id)}
                onClick={() =>
                  setHiddenColumns((hidden) =>
                    hidden.includes(column.id)
                      ? hidden.filter((id) => id !== column.id)
                      : [...hidden, column.id],
                  )
                }
              >
                <Checkbox
                  checked={!hiddenColumns.includes(column.id)}
                  tabIndex={-1}
                  disableRipple
                  slotProps={{ input: { "aria-hidden": true } }}
                />
                {column.label}
              </MenuItem>
            ))}
        </Menu>
        {inventoryError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>Worker inventory could not be refreshed</AlertTitle>
            {inventoryError}
          </Alert>
        )}
        {inventoryLoading && <LinearProgress aria-label="Loading worker inventory" />}
        <TableContainer sx={{ bgcolor: "background.paper", borderRadius: "12px" }}>
          <Table aria-label="Worker inventory" aria-busy={inventoryLoading}>
            <TableHead>
              <TableRow>
                {visibleColumns.map((column) => (
                  <TableCell
                    key={column.id}
                    sx={{
                      minWidth: column.minWidth,
                      ...(column.id === "actions"
                        ? { position: "sticky", right: 0, bgcolor: "background.paper" }
                        : {}),
                    }}
                  >
                    {column.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {inventoryPage.items.map((row) => (
                <TableRow key={row.workerNodeId} hover>
                  {visibleColumns.map((column) => (
                    <TableCell
                      key={column.id}
                      sx={{
                        py: 2,
                        ...(column.id === "actions"
                          ? { position: "sticky", right: 0, bgcolor: "background.paper" }
                          : {}),
                      }}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {inventoryPage.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length}>
                    {inventoryLoading ? (
                      <Stack spacing={2} sx={{ alignItems: "center", py: 6 }}>
                        <CircularProgress size={32} />
                        <Typography variant="body2" color="text.secondary">
                          Loading worker inventory…
                        </Typography>
                      </Stack>
                    ) : (
                      <EmptyState
                        title={
                          inventoryError
                            ? "Worker inventory is unavailable"
                            : hasFilters
                              ? "No workers match these filters"
                              : "No workers registered"
                        }
                        description={
                          inventoryError
                            ? "Refresh to retrieve the current inventory."
                            : hasFilters
                              ? "Adjust the search, access, or runtime filters."
                              : "Register a worker to create its one-time access credential."
                        }
                      />
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={inventoryPage.total}
          page={page - 1}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[
            DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
            100,
            MAX_WORKER_INVENTORY_PAGE_SIZE,
          ]}
          labelRowsPerPage="Workers per page"
          onPageChange={(_, nextPage) => setPage(nextPage + 1)}
          onRowsPerPageChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        />
      </Box>
      <Dialog
        open={createOpen}
        maxWidth="xs"
        fullWidth
        onClose={(_, reason) => {
          if (reason !== "backdropClick") closeCreate();
        }}
      >
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void createWorker();
          }}
        >
          <DialogTitle>Register a Windows worker</DialogTitle>
          <DialogContent>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              The worker starts in pending state. Its one-time token is shown after the credential
              is created.
            </Typography>
            <TextField
              autoFocus
              fullWidth
              label="Display name"
              placeholder="Example: Seattle review worker"
              value={displayName}
              disabled={mutationKey === "create"}
              error={nameError !== null}
              helperText={nameError ?? `${displayName.length}/128`}
              slotProps={{ htmlInput: { maxLength: 128 } }}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setNameError(null);
              }}
            />
          </DialogContent>
          <DialogActions>
            <Button disabled={mutationKey === "create"} onClick={closeCreate}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" loading={mutationKey === "create"}>
              Create credential
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
      <Dialog open={confirmation !== null} maxWidth="xs" fullWidth onClose={closeConfirmation}>
        <DialogTitle>
          {confirmation?.operation === "rotate"
            ? "Rotate this worker token?"
            : "Revoke this worker?"}
        </DialogTitle>
        <DialogContent>
          <Typography>{confirmation?.row.displayName}</Typography>
          <Typography
            variant="body2"
            className="mono"
            color="text.secondary"
            sx={{ overflowWrap: "anywhere", mb: 2 }}
          >
            {confirmation?.row.workerNodeId}
          </Typography>
          <Alert severity={confirmation?.operation === "rotate" ? "warning" : "error"}>
            {confirmation?.operation === "rotate"
              ? "The current token stops working as soon as rotation succeeds."
              : "The worker will be denied on its next authenticated request. Revocation cannot be reversed."}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button autoFocus disabled={mutationKey !== null} onClick={closeConfirmation}>
            Cancel
          </Button>
          <Button
            color={confirmation?.operation === "revoke" ? "error" : "primary"}
            variant="contained"
            loading={mutationKey !== null}
            onClick={() => void confirmCredentialMutation()}
          >
            {confirmation?.operation === "rotate" ? "Rotate token" : "Revoke access"}
          </Button>
        </DialogActions>
      </Dialog>
      <CredentialRevealModal
        credential={revealedCredential?.secret ?? null}
        onClose={() => setRevealedCredential(null)}
        onCopyError={() =>
          notify("Clipboard access failed. Select the token and copy it manually.", "error")
        }
        onCopySuccess={() => notify("Token copied to the clipboard.")}
        operation={revealedCredential?.operation ?? "created"}
      />
    </section>
  );
}
