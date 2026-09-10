import type {
  OperatorPrincipal,
  OperatorRepositoryRole,
  RepositoryAccessAudit,
  RepositoryAccessChangeResponse,
  RepositoryAccessGrant,
} from "@agentic-review/contracts";
import { Add, Close, ContentCopy, ExpandLess, ExpandMore, Refresh } from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Pagination,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DetailsGrid, EmptyState, notify } from "@/components/ui";
import { access } from "@/services/access";
import {
  type AccessChangeDraft,
  type AccessNotice,
  accessChangeNotice,
  accessReceiptSummary,
  canManageRepositoryAccess,
  createAccessChangeRegistry,
  expectedAccessVersion,
  isAccessDenied,
  principalKey,
  repositoryAccessQueryKey,
  repositoryRoleDescriptions,
  repositoryRoleLabels,
  samePrincipal,
} from "./helpers";

export interface RepositoryAccessDrawerProps {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly canManage: boolean;
  readonly platformAdministrator: boolean;
  readonly currentPrincipal: OperatorPrincipal;
  readonly onChanged?: () => void;
}

interface AccessEditor {
  readonly grant: RepositoryAccessGrant | null;
  readonly action: "grant" | "edit" | "revoke";
}

interface AccessEditorValues {
  issuer: string;
  subject: string;
  role: OperatorRepositoryRole;
  reason: string;
}

const pageSize = 20;
const runtimeAccessExplanation =
  "Platform administrator access is configured by the server runtime and is not listed as a repository grant. Changing or revoking a repository role does not remove platform administrator access.";

function Identity({ principal }: { readonly principal: OperatorPrincipal }) {
  return (
    <Stack
      spacing={0.5}
      sx={{ minWidth: 0, overflowWrap: "anywhere", "& code": { whiteSpace: "pre-wrap" } }}
    >
      <Typography variant="body2">
        <Box component="span" sx={{ color: "text.secondary" }}>
          Subject:{" "}
        </Box>
        <code>{principal.subject}</code>
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Issuer: <code>{principal.issuer}</code>
      </Typography>
    </Stack>
  );
}

function Role({ role }: { readonly role: OperatorRepositoryRole | null }) {
  return (
    <Chip
      size="medium"
      variant="outlined"
      color={role === "admin" ? "primary" : "default"}
      label={role === null ? "Revoked" : repositoryRoleLabels[role]}
    />
  );
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
}

function ChangeEditor({
  editor,
  repositoryId,
  repositoryName,
  currentPrincipal,
  platformAdministrator,
  saving,
  allowed,
  onClose,
  onReload,
  onSubmit,
}: {
  readonly editor: AccessEditor;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly currentPrincipal: OperatorPrincipal;
  readonly platformAdministrator: boolean;
  readonly saving: boolean;
  readonly allowed: boolean;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly onSubmit: (draft: AccessChangeDraft) => Promise<void>;
}) {
  const [values, setValues] = useState<AccessEditorValues>(() => ({
    issuer: editor.grant?.principal.issuer ?? "",
    subject: editor.grant?.principal.subject ?? "",
    role: editor.grant?.role ?? "viewer",
    reason: "",
  }));
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<AccessNotice | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const revoke = editor.action === "revoke";
  const ownGrant = editor.grant && samePrincipal(editor.grant.principal, currentPrincipal);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = <K extends keyof AccessEditorValues>(key: K, value: AccessEditorValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    if (notice?.kind !== "conflict") setNotice(null);
  };
  const submit = async () => {
    if (
      !allowed ||
      saving ||
      pending.current ||
      (revoke && !confirmed) ||
      notice?.kind === "conflict"
    )
      return;
    pending.current = true;
    try {
      if (!values.issuer || values.issuer.length > 2_048)
        throw new Error("Enter the exact issuer using no more than 2,048 characters.");
      if (!values.subject || values.subject.length > 512)
        throw new Error("Enter the exact subject using no more than 512 characters.");
      if (!values.reason.trim() || values.reason.length > 2_048)
        throw new Error("Enter a reason containing no more than 2,048 characters.");
      if (!mounted.current || !allowed) return;
      setNotice(null);
      await onSubmit({
        repositoryId,
        principal: editor.grant?.principal ?? { issuer: values.issuer, subject: values.subject },
        role: revoke ? null : values.role,
        expectedVersion: expectedAccessVersion(editor.grant),
        reason: values.reason,
      });
    } catch (failure) {
      if (mounted.current) setNotice(accessChangeNotice(failure));
    } finally {
      pending.current = false;
    }
  };
  const disabled = saving || !allowed;
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <DialogTitle>
        {revoke
          ? "Revoke repository access"
          : editor.grant
            ? "Change repository role"
            : "Grant repository access"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          <Typography variant="subtitle1">{repositoryName}</Typography>
          <Typography variant="body2" color="text.secondary">
            Use the exact, case-sensitive issuer and subject from the identity provider. Email
            addresses and display names do not identify an operator. Values are sent exactly as
            entered.
          </Typography>
          {editor.grant && (
            <DetailsGrid
              columns={2}
              items={[
                {
                  key: "role",
                  label: "Current repository role",
                  value: <Role role={editor.grant.role} />,
                },
                { key: "version", label: "Record version", value: editor.grant.version },
              ]}
            />
          )}
          <Stack
            component="form"
            id="repository-access-change"
            spacing={3}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Typography variant="subtitle1">Operator identity</Typography>
            <TextField
              label="Issuer"
              required
              value={values.issuer}
              disabled={disabled}
              onChange={(event) => update("issuer", event.target.value)}
              autoComplete="off"
              slotProps={{
                input: { readOnly: Boolean(editor.grant) },
                htmlInput: { maxLength: 2_048, spellCheck: false, "aria-label": "Issuer" },
              }}
            />
            <TextField
              label="Subject"
              required
              value={values.subject}
              disabled={disabled}
              onChange={(event) => update("subject", event.target.value)}
              autoComplete="off"
              slotProps={{
                input: { readOnly: Boolean(editor.grant) },
                htmlInput: { maxLength: 512, spellCheck: false, "aria-label": "Subject" },
              }}
            />
            <Divider />
            <Typography variant="subtitle1">Access change</Typography>
            {!revoke && (
              <TextField
                select
                label="Repository role"
                required
                value={values.role}
                disabled={disabled}
                onChange={(event) => update("role", event.target.value as OperatorRepositoryRole)}
              >
                {(Object.keys(repositoryRoleLabels) as OperatorRepositoryRole[]).map((role) => (
                  <MenuItem key={role} value={role}>
                    {repositoryRoleLabels[role]} — {repositoryRoleDescriptions[role]}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              label="Reason"
              required
              multiline
              minRows={3}
              value={values.reason}
              disabled={disabled}
              onChange={(event) => update("reason", event.target.value)}
              slotProps={{ htmlInput: { maxLength: 2_048, "aria-label": "Reason" } }}
              helperText={`The audit history records this reason with your authenticated issuer and subject. ${values.reason.length.toLocaleString("en-US")}/2,048 characters.`}
            />
          </Stack>
          {!editor.grant && (
            <Typography variant="body2" color="text.secondary">
              New identities use record version 0. If this identity already has a record, including
              revoked access, edit that record from Members instead.
            </Typography>
          )}
          {revoke && (
            <Alert severity="warning">
              <AlertTitle>Confirm the exact identity before revoking</AlertTitle>
              <Stack spacing={1}>
                {editor.grant && <Identity principal={editor.grant.principal} />}
                <span>
                  The explicit repository role in {repositoryName} will be revoked. Its record and
                  version will remain in the audit history.
                </span>
              </Stack>
            </Alert>
          )}
          {ownGrant && !platformAdministrator && (
            <Typography variant="body2" color="text.secondary">
              This is your own repository grant. Removing Admin may prevent you from managing
              repository access.
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {runtimeAccessExplanation}
          </Typography>
          {revoke && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={confirmed}
                  disabled={disabled}
                  onChange={(_, checked) => setConfirmed(checked)}
                />
              }
              label={`I confirm revoking the repository role for the exact identity shown above in ${repositoryName}.`}
            />
          )}
          {notice && (
            <Alert severity="error">
              <AlertTitle>{notice.title}</AlertTitle>
              {notice.description}
            </Alert>
          )}
          {!allowed && (
            <Alert severity="warning">
              Your permission must be refreshed before changing access.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, bgcolor: "background.default" }}>
        <Button disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        {notice?.kind === "conflict" ? (
          <Button variant="contained" onClick={onReload}>
            Close and reload members
          </Button>
        ) : (
          <Button
            variant="contained"
            color={revoke ? "error" : "primary"}
            type="submit"
            form="repository-access-change"
            loading={saving}
            disabled={!allowed || (revoke && !confirmed)}
          >
            {revoke ? "Revoke access" : "Save access"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function MemberRow({
  grant,
  currentPrincipal,
  disabled,
  onEdit,
}: {
  grant: RepositoryAccessGrant;
  currentPrincipal: OperatorPrincipal;
  disabled: boolean;
  onEdit: (editor: AccessEditor) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <TableRow sx={{ "& > td": { verticalAlign: "top" } }}>
        <TableCell padding="checkbox">
          <IconButton
            size="medium"
            aria-label={`${expanded ? "Hide" : "Show"} access details for ${grant.principal.subject}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ minWidth: 250 }}>
          <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
            <Identity principal={grant.principal} />
            {samePrincipal(grant.principal, currentPrincipal) && <Chip size="medium" label="You" />}
          </Stack>
        </TableCell>
        <TableCell sx={{ minWidth: 130 }}>
          <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
            <Role role={grant.role} />
            <Typography variant="body2" color="text.secondary">
              Version {grant.version}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell sx={{ minWidth: 180 }}>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button
              size="medium"
              disabled={disabled}
              onClick={() => onEdit({ grant, action: "edit" })}
            >
              {grant.role === null ? "Restore access" : "Change role"}
            </Button>
            {grant.role !== null && (
              <Button
                size="medium"
                color="error"
                disabled={disabled}
                onClick={() => onEdit({ grant, action: "revoke" })}
              >
                Revoke
              </Button>
            )}
          </Stack>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={4} sx={{ py: 0, borderBottom: expanded ? undefined : 0 }}>
          <Collapse in={expanded} unmountOnExit>
            <Box sx={{ p: 3, bgcolor: "background.default" }}>
              <DetailsGrid
                columns={1}
                items={[
                  { key: "created", label: "Created", value: timestamp(grant.createdAt) },
                  { key: "updated", label: "Last updated", value: timestamp(grant.updatedAt) },
                  {
                    key: "actor",
                    label: "Updated by",
                    value: <Identity principal={grant.updatedBy} />,
                  },
                ]}
              />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function AuditRow({ change }: { change: RepositoryAccessAudit }) {
  const [expanded, setExpanded] = useState(false);
  const copyChangeId = async () => {
    try {
      await navigator.clipboard.writeText(change.changeId);
      notify("Change ID copied.");
    } catch {
      notify("Could not copy the change ID. Select and copy it manually.", "error");
    }
  };
  return (
    <>
      <TableRow sx={{ "& > td": { verticalAlign: "top" } }}>
        <TableCell padding="checkbox">
          <IconButton
            size="medium"
            aria-label={`${expanded ? "Hide" : "Show"} change details for ${change.principal.subject}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ minWidth: 250 }}>
          <Identity principal={change.principal} />
        </TableCell>
        <TableCell sx={{ minWidth: 200 }}>
          <Typography variant="body2">
            {change.previousRole === null
              ? "No repository role"
              : repositoryRoleLabels[change.previousRole]}{" "}
            → {change.role === null ? "Revoked" : repositoryRoleLabels[change.role]}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Version {change.previousVersion} → {change.version}
          </Typography>
        </TableCell>
        <TableCell sx={{ minWidth: 160 }}>{timestamp(change.createdAt)}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={4} sx={{ py: 0, borderBottom: expanded ? undefined : 0 }}>
          <Collapse in={expanded} unmountOnExit>
            <Box sx={{ p: 3, bgcolor: "background.default" }}>
              <DetailsGrid
                columns={1}
                items={[
                  {
                    key: "actor",
                    label: "Changed by",
                    value: <Identity principal={change.actor} />,
                  },
                  {
                    key: "reason",
                    label: "Reason",
                    value: (
                      <Box
                        component="span"
                        sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                      >
                        {change.reason}
                      </Box>
                    ),
                  },
                  {
                    key: "change",
                    label: "Change ID",
                    value: (
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <Box component="code" sx={{ overflowWrap: "anywhere" }}>
                          {change.changeId}
                        </Box>
                        <IconButton
                          size="medium"
                          aria-label="Copy change ID"
                          onClick={() => void copyChangeId()}
                        >
                          <ContentCopy fontSize="small" />
                        </IconButton>
                      </Stack>
                    ),
                  },
                ]}
              />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function AccessSession({
  repositoryId,
  repositoryName,
  currentPrincipal,
  platformAdministrator,
  onChanged,
  onBusyChange,
}: Omit<RepositoryAccessDrawerProps, "open" | "onClose" | "canManage"> & {
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [memberPage, setMemberPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [tab, setTab] = useState("members");
  const [editor, setEditor] = useState<AccessEditor | null>(null);
  const [receipt, setReceipt] = useState<RepositoryAccessChangeResponse | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const permission = useRef(false);
  const permissionLossReported = useRef(false);
  const intents = useRef(createAccessChangeRegistry());
  const baseKey = repositoryAccessQueryKey(access.mode, repositoryId, currentPrincipal);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      permission.current = false;
    };
  }, []);
  const recordFailure = (failure: unknown): never => {
    if (mounted.current && isAccessDenied(failure)) {
      permission.current = false;
      setBlocked(true);
      if (!permissionLossReported.current) {
        permissionLossReported.current = true;
        onChanged?.();
      }
    }
    throw failure;
  };
  const contextQuery = useQuery({
    queryKey: [...baseKey, "context"],
    queryFn: () => access.context(repositoryId).catch(recordFailure),
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const authorityReady =
    contextQuery.isSuccess &&
    !contextQuery.isFetching &&
    canManageRepositoryAccess(contextQuery.data, repositoryId, currentPrincipal);
  const allowed = authorityReady && !blocked && !refreshing;
  permission.current = allowed;
  const membersQuery = useQuery({
    queryKey: [...baseKey, "members", memberPage],
    queryFn: () => access.list(repositoryId, { page: memberPage, pageSize }).catch(recordFailure),
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const auditQuery = useQuery({
    queryKey: [...baseKey, "audit", auditPage],
    queryFn: () => access.history(repositoryId, { page: auditPage, pageSize }).catch(recordFailure),
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const membersReady = allowed && membersQuery.isSuccess && !membersQuery.isFetching;
  const serverPlatformAdministrator =
    contextQuery.data?.platformAdministrator ?? platformAdministrator;
  const refresh = async () => {
    if (!mounted.current || refreshing || pending.current) return;
    setRefreshing(true);
    permission.current = false;
    try {
      await queryClient.invalidateQueries({ queryKey: baseKey, refetchType: "none" });
      const context = await contextQuery.refetch();
      if (!mounted.current) return;
      if (
        !context.isSuccess ||
        !canManageRepositoryAccess(context.data, repositoryId, currentPrincipal)
      ) {
        setBlocked(true);
        return;
      }
      setBlocked(false);
      permissionLossReported.current = false;
      await Promise.allSettled([membersQuery.refetch(), auditQuery.refetch()]);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };
  const submit = async (draft: AccessChangeDraft) => {
    if (pending.current || !permission.current || draft.repositoryId !== repositoryId) {
      throw new Error("Refresh repository access before submitting this change.");
    }
    const request = intents.current.prepare(draft);
    pending.current = true;
    setSaving(true);
    onBusyChange(true);
    try {
      const accepted = await access.change(repositoryId, request).catch(recordFailure);
      intents.current.accepted(repositoryId, request);
      await queryClient.invalidateQueries({ queryKey: baseKey, refetchType: "none" });
      if (!mounted.current) return;
      setReceipt(accepted);
      setEditor(null);
      pending.current = false;
      await refresh();
      if (mounted.current) onChanged?.();
    } finally {
      pending.current = false;
      if (mounted.current) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  };
  return (
    <Stack spacing={3} sx={{ minWidth: 0 }}>
      <Box sx={{ p: 3, borderRadius: 3, bgcolor: "background.default" }}>
        <DetailsGrid
          columns={1}
          items={[
            { key: "repository", label: "Repository", value: repositoryName },
            {
              key: "principal",
              label: "Current operator",
              value: <Identity principal={currentPrincipal} />,
            },
            {
              key: "authority",
              label: "Access source",
              value: contextQuery.isFetching
                ? "Checking access…"
                : contextQuery.isSuccess
                  ? contextQuery.data.repository?.source === "platform"
                    ? "Platform administrator (server runtime)"
                    : contextQuery.data.repository
                      ? "Repository role"
                      : "No repository role"
                  : "Unavailable",
            },
          ]}
        />
      </Box>
      {access.mode === "sample" && (
        <Alert severity="info">
          <AlertTitle>Sample access management</AlertTitle>This preview uses local simulated members
          and audit records. Changes affect sample data only and are not sent to the production
          server.
        </Alert>
      )}
      <Accordion
        disableGutters
        elevation={0}
        sx={{ bgcolor: "transparent", "&:before": { display: "none" } }}
      >
        <AccordionSummary
          expandIcon={<ExpandMore />}
          aria-controls="repository-platform-access-content"
          id="repository-platform-access-heading"
          sx={{ px: 0 }}
        >
          <Typography variant="subtitle1">Platform administrator access</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <Typography variant="body2" color="text.secondary">
            {runtimeAccessExplanation}
          </Typography>
        </AccordionDetails>
      </Accordion>
      {receipt && (
        <Alert severity="success">
          <AlertTitle>
            {receipt.replayed ? "Existing change receipt received" : "Access change recorded"}
          </AlertTitle>
          <Stack spacing={1}>
            <Identity principal={receipt.change.principal} />
            <span>{accessReceiptSummary(receipt)}</span>
          </Stack>
        </Alert>
      )}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
      >
        <Typography variant="subtitle1">Repository access</Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button
            startIcon={<Refresh />}
            loading={refreshing || contextQuery.isFetching}
            disabled={saving}
            onClick={() => void refresh()}
          >
            Refresh access
          </Button>
          {allowed && (
            <Button
              variant="contained"
              startIcon={<Add />}
              disabled={!membersReady || saving}
              onClick={() => setEditor({ grant: null, action: "grant" })}
            >
              Grant access
            </Button>
          )}
        </Stack>
      </Stack>
      {contextQuery.isError ? (
        <Alert severity="error">
          <AlertTitle>Repository permissions could not be verified</AlertTitle>
          {accessChangeNotice(contextQuery.error).description}
        </Alert>
      ) : contextQuery.isFetching || refreshing ? (
        <Skeleton variant="rounded" height={260} />
      ) : !allowed ? (
        <Alert severity="warning">
          <AlertTitle>Repository access management is restricted</AlertTitle>Members and audit
          history are available only to an operator with Manage access permission for this
          repository. Refresh access to check your current permissions.
        </Alert>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(_, value: string) => setTab(value)}
            aria-label="Repository access views"
          >
            <Tab
              value="members"
              label="Members"
              id="repository-access-members-tab"
              aria-controls="repository-access-members-panel"
            />
            <Tab
              value="audit"
              label="Audit history"
              id="repository-access-audit-tab"
              aria-controls="repository-access-audit-panel"
            />
          </Tabs>
          {tab === "members" ? (
            <Stack
              spacing={2}
              role="tabpanel"
              id="repository-access-members-panel"
              aria-labelledby="repository-access-members-tab"
            >
              {membersQuery.isError ? (
                <Alert severity="error">
                  <AlertTitle>Members could not be loaded</AlertTitle>
                  {accessChangeNotice(membersQuery.error).description}
                </Alert>
              ) : membersQuery.isPending ? (
                <Skeleton variant="rounded" height={240} />
              ) : (
                <>
                  <Typography variant="body2" color="text.secondary">
                    Revoked entries remain visible so future changes use the current record version.
                    These are explicit repository grants, not the list of platform administrators.
                  </Typography>
                  {membersQuery.data?.items.length ? (
                    <TableContainer>
                      <Table
                        size="medium"
                        aria-label="Repository members"
                        aria-busy={membersQuery.isFetching}
                      >
                        <TableHead>
                          <TableRow>
                            <TableCell padding="checkbox" />
                            <TableCell>Identity</TableCell>
                            <TableCell>Role</TableCell>
                            <TableCell>Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {membersQuery.data.items.map((grant) => (
                            <MemberRow
                              key={principalKey(grant.principal)}
                              grant={grant}
                              currentPrincipal={currentPrincipal}
                              disabled={!membersReady || saving}
                              onEdit={setEditor}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    <EmptyState title="No explicit repository access records." />
                  )}
                  {(membersQuery.data?.total ?? 0) > pageSize && (
                    <Stack
                      direction="row"
                      spacing={2}
                      sx={{ alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {membersQuery.data?.total} access records
                      </Typography>
                      <Pagination
                        page={memberPage}
                        count={Math.ceil((membersQuery.data?.total ?? 0) / pageSize)}
                        onChange={(_, value) => setMemberPage(value)}
                        disabled={saving || membersQuery.isFetching}
                      />
                    </Stack>
                  )}
                </>
              )}
            </Stack>
          ) : (
            <Stack
              spacing={2}
              role="tabpanel"
              id="repository-access-audit-panel"
              aria-labelledby="repository-access-audit-tab"
            >
              {auditQuery.isError ? (
                <Alert severity="error">
                  <AlertTitle>Audit history could not be loaded</AlertTitle>
                  {accessChangeNotice(auditQuery.error).description}
                </Alert>
              ) : auditQuery.isPending ? (
                <Skeleton variant="rounded" height={240} />
              ) : (
                <>
                  <Typography variant="body2" color="text.secondary">
                    Each entry records the authenticated actor and accepted change at that time.
                    Earlier entries do not describe current access.
                  </Typography>
                  {auditQuery.data?.items.length ? (
                    <TableContainer>
                      <Table
                        size="medium"
                        aria-label="Repository access audit history"
                        aria-busy={auditQuery.isFetching}
                      >
                        <TableHead>
                          <TableRow>
                            <TableCell padding="checkbox" />
                            <TableCell>Identity</TableCell>
                            <TableCell>Recorded change</TableCell>
                            <TableCell>Recorded</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {auditQuery.data.items.map((change) => (
                            <AuditRow key={change.id} change={change} />
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    <EmptyState title="No access changes recorded." />
                  )}
                  {(auditQuery.data?.total ?? 0) > pageSize && (
                    <Stack
                      direction="row"
                      spacing={2}
                      sx={{ alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {auditQuery.data?.total} recorded changes
                      </Typography>
                      <Pagination
                        page={auditPage}
                        count={Math.ceil((auditQuery.data?.total ?? 0) / pageSize)}
                        onChange={(_, value) => setAuditPage(value)}
                        disabled={saving || auditQuery.isFetching}
                      />
                    </Stack>
                  )}
                </>
              )}
            </Stack>
          )}
        </>
      )}
      {editor && (
        <ChangeEditor
          editor={editor}
          repositoryId={repositoryId}
          repositoryName={repositoryName}
          currentPrincipal={currentPrincipal}
          platformAdministrator={serverPlatformAdministrator}
          saving={saving}
          allowed={allowed}
          onClose={() => setEditor(null)}
          onReload={() => {
            setEditor(null);
            void refresh();
          }}
          onSubmit={submit}
        />
      )}
    </Stack>
  );
}

export function RepositoryAccessDrawer(props: RepositoryAccessDrawerProps) {
  const [busy, setBusy] = useState(false);
  const sessionKey = JSON.stringify([
    props.repositoryId,
    props.currentPrincipal.issuer,
    props.currentPrincipal.subject,
  ]);
  const busyScope = useRef(sessionKey);
  useEffect(() => {
    if (!props.open || !props.canManage || busyScope.current !== sessionKey) {
      busyScope.current = sessionKey;
      setBusy(false);
    }
  }, [props.open, props.canManage, sessionKey]);
  return (
    <Drawer
      open={props.open}
      anchor="right"
      onClose={() => {
        if (!busy) props.onClose();
      }}
      slotProps={{ paper: { sx: { width: { xs: "100%", lg: 860 }, maxWidth: "100%" } } }}
    >
      <Stack
        direction="row"
        sx={{
          px: 3,
          py: 2,
          minHeight: 72,
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Typography variant="h6">Repository access</Typography>
        <IconButton aria-label="Close repository access" disabled={busy} onClick={props.onClose}>
          <Close />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: { xs: 2, sm: 3 }, overflowY: "auto" }}>
        {props.open &&
          (props.canManage ? (
            <AccessSession
              key={sessionKey}
              repositoryId={props.repositoryId}
              repositoryName={props.repositoryName}
              currentPrincipal={props.currentPrincipal}
              platformAdministrator={props.platformAdministrator}
              onChanged={props.onChanged}
              onBusyChange={setBusy}
            />
          ) : (
            <Stack spacing={2.5}>
              <Typography variant="subtitle1">{props.repositoryName}</Typography>
              <Alert severity="warning">
                <AlertTitle>Repository access management is restricted</AlertTitle>Your verified
                permissions do not include Manage access for this repository. Members and audit
                history have not been requested. Ask a repository or platform administrator to
                review your access.
              </Alert>
              <Typography variant="body2" color="text.secondary">
                {runtimeAccessExplanation}
              </Typography>
            </Stack>
          ))}
      </Box>
    </Drawer>
  );
}
