import type {
  DashboardReviewRunDetail,
  IssueReproductionRequestV1,
} from "@agentic-review/contracts";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { OperatorAccessGate, useOperatorAccess } from "@/components/OperatorAccess";
import { reviewPermissionUnavailableReason } from "@/components/ReviewRuns/actions";
import { DataTable, EmptyState } from "@/components/ui";
import { targetLabels, workflowLabels } from "@/pages/ValidationProfiles/forms";
import { configuration } from "@/services/configuration";
import type { WorkItem } from "@/services/review-control";
import { runs } from "@/services/runs";
import {
  createRunIntentRegistry,
  exactCommitPattern,
  initialRunProfileSelection,
  loadRunProfiles,
  maximumRunProfileCount,
  needsTestedSourceCommit,
  type RunCreationNotice,
  type RunProfileOption,
  runCreationError,
  runCreationPrerequisite,
  selectRunProfiles,
} from "./helpers";
import { ReproductionEditor } from "./ReproductionEditor";

export interface CreateReviewRunModalProps {
  readonly workItem: WorkItem | null;
  readonly onClose: () => void;
  readonly onCreated: (run: DashboardReviewRunDetail) => void;
}

function RunCreationSession({
  workItem,
  onClose,
  onCreated,
}: Omit<CreateReviewRunModalProps, "workItem"> & { readonly workItem: WorkItem }) {
  const access = useOperatorAccess(workItem.repositoryId);
  const permissionReason = reviewPermissionUnavailableReason(access);
  const [selection, setSelection] = useState<string[]>([]);
  const [testedSourceCommit, setTestedSourceCommit] = useState("");
  const [sourceExecutionAuthorized, setSourceExecutionAuthorized] = useState(false);
  const [reproduction, setReproduction] = useState<IssueReproductionRequestV1 | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RunCreationNotice | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionInitialized = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const intents = useRef(createRunIntentRegistry());
  const prerequisite = runCreationPrerequisite(workItem);
  const profilesQuery = useQuery({
    queryKey: ["review-run-create-profiles", workItem.repositoryId, workItem.kind],
    queryFn: () => loadRunProfiles(configuration, workItem.repositoryId, workItem.kind),
    enabled: prerequisite === null,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const profiles = profilesQuery.data ?? [];
  const needsSource = needsTestedSourceCommit(workItem.kind, profiles, selection);
  const sourceIsValid = exactCommitPattern.test(testedSourceCommit);
  const profilesReady =
    profilesQuery.isSuccess && !profilesQuery.isFetching && selectionInitialized.current;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const currentProfiles = profilesQuery.data;
    if (!currentProfiles || profilesQuery.isFetching || profilesQuery.isError) return;
    try {
      if (!selectionInitialized.current) {
        setSelection(initialRunProfileSelection(currentProfiles));
        selectionInitialized.current = true;
      } else {
        setSelection((previous) => {
          try {
            return selectRunProfiles(currentProfiles, previous);
          } catch {
            return initialRunProfileSelection(currentProfiles);
          }
        });
      }
      setSelectionError(null);
    } catch (failure) {
      setSelectionError(runCreationError(failure).description);
    }
  }, [profilesQuery.data, profilesQuery.isError, profilesQuery.isFetching]);

  useEffect(() => {
    if (!needsSource) setSourceExecutionAuthorized(false);
  }, [needsSource]);

  const create = async () => {
    if (!access.can("review")) {
      setError({
        title: "Review access required",
        description: permissionReason ?? "Review access is required to create a run.",
      });
      return;
    }
    if (pending.current || prerequisite || !profilesReady || selectionError) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const input = intents.current.prepare({
        workItem,
        profiles,
        selectedProfileIds: selection,
        testedSourceCommit,
        sourceExecutionAuthorized,
        ...(reproduction === undefined ? {} : { reproduction }),
      });
      const created = await runs.create(workItem.repositoryId, workItem.id, input);
      if (mounted.current) onCreated(created);
    } catch (failure) {
      if (mounted.current) setError(runCreationError(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const changeSelection = (profileId: string, checked: boolean) => {
    try {
      setSelection(
        selectRunProfiles(
          profiles,
          checked ? [...selection, profileId] : selection.filter((id) => id !== profileId),
        ),
      );
      setSelectionError(null);
      setError(null);
      setSourceExecutionAuthorized(false);
    } catch (failure) {
      setSelectionError(runCreationError(failure).description);
    }
  };
  const close = () => {
    if (!saving && !pending.current) onClose();
  };

  return (
    <Dialog
      open
      fullWidth
      maxWidth={reproduction === undefined ? "md" : "lg"}
      aria-labelledby="create-review-run-title"
      onClose={close}
      slotProps={{ paper: { sx: { maxWidth: reproduction === undefined ? 760 : 960 } } }}
    >
      <DialogTitle id="create-review-run-title" sx={{ p: 3, pr: 8 }}>
        {workItem.kind === "pull_request" ? "Create review run" : "Create issue review run"}
        <IconButton
          aria-label="Close create review run"
          disabled={saving}
          onClick={close}
          sx={{ position: "absolute", right: 20, top: 20, width: 40, height: 40 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        <Stack spacing={3}>
          {permissionReason && (
            <Alert severity="info">
              <AlertTitle>Review actions unavailable</AlertTitle>
              {permissionReason}
            </Alert>
          )}
          <div>
            <Typography variant="body2" color="text.secondary">
              {workItem.repository} #{workItem.number}
            </Typography>
            <Typography variant="body1" sx={{ mt: 1, fontWeight: 500 }}>
              {workItem.title}
            </Typography>
          </div>
          {runs.mode === "sample" && reproduction === undefined && (
            <Alert severity="info">
              <AlertTitle>Sample data</AlertTitle>
              This preview creates a sample review run only. It does not send a production request
              or execute code.
            </Alert>
          )}
          {prerequisite ? (
            <Alert severity="warning">
              <AlertTitle>{prerequisite.title}</AlertTitle>
              {prerequisite.description}
            </Alert>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary">
                Choose the checks to include in this review run. Creating a run saves a plan; its
                details will show whether each check is ready or blocked. Creation does not mean
                that checks ran or passed.
              </Typography>
              {workItem.kind === "pull_request" && (
                <Stack spacing={1}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                    Pull request head commit
                  </Typography>
                  <Typography
                    component="code"
                    variant="body2"
                    sx={{ fontFamily: '"Roboto Mono", monospace', overflowWrap: "anywhere" }}
                  >
                    {workItem.headSha}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    The run targets this head commit. Refresh the pull request if it has changed.
                  </Typography>
                </Stack>
              )}
              <Divider />
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
              >
                <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
                  Validation profiles
                </Typography>
                <Button
                  size="medium"
                  startIcon={<RefreshIcon />}
                  loading={profilesQuery.isFetching}
                  disabled={saving}
                  onClick={() => void profilesQuery.refetch()}
                >
                  Reload profiles
                </Button>
              </Stack>
              {profilesQuery.isError ? (
                <Alert severity="error">
                  <AlertTitle>The active profile configuration could not be loaded</AlertTitle>
                  {`${runCreationError(profilesQuery.error).description} All active bindings and their published versions must be available before creating a run.`}
                </Alert>
              ) : profilesQuery.isPending ? (
                <Skeleton variant="rounded" height={180} />
              ) : profiles.length === 0 ? (
                <EmptyState
                  title="No matching validation profiles"
                  description={`No enabled profiles apply to this ${workItem.kind === "pull_request" ? "pull request" : "issue"}. Publish and enable a matching validation profile for this repository.`}
                />
              ) : (
                <>
                  <Box sx={{ maxHeight: 360, overflow: "auto" }}>
                    <DataTable<RunProfileOption>
                      getRowId={(option) => option.version.profileId}
                      rows={profiles}
                      loading={profilesQuery.isFetching}
                      ariaLabel="Validation profiles"
                      columns={[
                        {
                          label: "Include",
                          id: "include",
                          width: 76,
                          render: (option) => (
                            <Checkbox
                              slotProps={{
                                input: {
                                  "aria-label": `Include ${option.version.name}${option.version.required ? " (required)" : ""}`,
                                },
                              }}
                              checked={
                                option.version.required ||
                                selection.includes(option.version.profileId)
                              }
                              disabled={
                                saving ||
                                profilesQuery.isFetching ||
                                option.version.required ||
                                (selection.length >= maximumRunProfileCount &&
                                  !selection.includes(option.version.profileId))
                              }
                              onChange={(event) =>
                                changeSelection(option.version.profileId, event.target.checked)
                              }
                            />
                          ),
                        },
                        {
                          label: "Profile",
                          id: "profile",
                          minWidth: 260,
                          render: (option) => (
                            <Stack spacing={0.5}>
                              <Typography variant="body1" sx={{ fontWeight: 500 }}>
                                {option.version.name}
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                {workflowLabels[option.version.workflowKind]} ·{" "}
                                {targetLabels[option.version.target]}
                              </Typography>
                            </Stack>
                          ),
                        },
                        {
                          label: "Bound version",
                          id: "version",
                          width: 140,
                          render: (option) => (
                            <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
                              <Typography variant="body2">
                                Version {option.version.version}
                              </Typography>
                              <Chip
                                size="medium"
                                color={option.version.required ? "primary" : "default"}
                                label={option.version.required ? "Required" : "Optional"}
                              />
                            </Stack>
                          ),
                        },
                      ]}
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {selection.length} of {maximumRunProfileCount} profiles selected. Required
                    profiles cannot be excluded. Versions shown are the current bindings; the
                    created run records the versions selected by the server.
                  </Typography>
                </>
              )}
              {selectionError && (
                <Alert severity="error">
                  <AlertTitle>Check the profile selection</AlertTitle>
                  {selectionError}
                </Alert>
              )}
              {workItem.kind === "issue" && profilesReady && (
                <>
                  <Divider />
                  <ReproductionEditor
                    profiles={profiles}
                    selectedProfileIds={selection}
                    value={reproduction}
                    defaultClaim={workItem.title}
                    disabled={saving || profilesQuery.isFetching}
                    sample={runs.mode === "sample"}
                    onChange={(next) => {
                      setReproduction(next);
                      setError(null);
                    }}
                  />
                </>
              )}
              {needsSource && (
                <Stack component="section" aria-label="Source authorization" spacing={2}>
                  <Divider />
                  <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
                    Source authorization
                  </Typography>
                  <TextField
                    size="medium"
                    label="Commit to validate"
                    required
                    fullWidth
                    disabled={saving}
                    error={Boolean(testedSourceCommit && !sourceIsValid)}
                    helperText="Enter the exact 40- or 64-character lowercase commit SHA. A branch name or abbreviated SHA is not accepted."
                    value={testedSourceCommit}
                    slotProps={{
                      htmlInput: { "aria-label": "Commit to validate", spellCheck: false },
                    }}
                    placeholder="Full commit SHA"
                    autoComplete="off"
                    onChange={(event) => {
                      setTestedSourceCommit(event.target.value);
                      setSourceExecutionAuthorized(false);
                      setError(null);
                    }}
                  />
                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={sourceExecutionAuthorized}
                          disabled={saving}
                          onChange={(event) => setSourceExecutionAuthorized(event.target.checked)}
                        />
                      }
                      label="I authorize this operation to execute code at the specified commit."
                    />
                    <Typography variant="body2" color="text.secondary">
                      Issue validation can run repository setup, build, test, and application
                      commands on a Worker. This is execution authorization for this commit.
                    </Typography>
                  </Box>
                </Stack>
              )}
              {workItem.kind === "issue" &&
                !needsSource &&
                profilesReady &&
                selection.length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    Issue triage reads the report without authorizing repository code execution.
                    Select an issue validation profile to validate a specific commit.
                  </Typography>
                )}
            </>
          )}
          {error && (
            <Alert severity="error">
              <AlertTitle>{error.title}</AlertTitle>
              {error.description}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3, pt: 1, gap: 1 }}>
        <Button disabled={saving} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void create()}
          loading={saving}
          disabled={
            !access.can("review") ||
            Boolean(prerequisite) ||
            !profilesReady ||
            Boolean(selectionError) ||
            selection.length === 0 ||
            (reproduction !== undefined && runs.mode === "sample") ||
            (needsSource && (!sourceIsValid || !sourceExecutionAuthorized))
          }
        >
          Create review run
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function CreateReviewRunModal(props: CreateReviewRunModalProps) {
  if (!props.workItem) return null;
  return (
    <OperatorAccessGate repositoryId={props.workItem.repositoryId} permission="review">
      <RunCreationSession
        key={JSON.stringify([props.workItem.repositoryId, props.workItem.id])}
        workItem={props.workItem}
        onClose={props.onClose}
        onCreated={props.onCreated}
      />
    </OperatorAccessGate>
  );
}
