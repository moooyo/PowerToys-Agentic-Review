import type {
  InvestigationReportDirectoryQuery,
  InvestigationReportHeaderV1,
  InvestigationTaskKind,
} from "@agentic-review/contracts";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import DescriptionRounded from "@mui/icons-material/DescriptionRounded";
import FilterListRounded from "@mui/icons-material/FilterListRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { investigationApi, type Repository } from "./api";
import { sessionIdentity, useInvestigationSession } from "./session";
import { EmptyState, PageHeading, Surface } from "./workspace-ui";

const taskKinds: { value: InvestigationTaskKind; label: string }[] = [
  { value: "pr-review", label: "PR review" },
  { value: "issue-investigate", label: "Issue investigation" },
  { value: "pr-e2e", label: "E2E verification" },
  { value: "pr-verify", label: "PR verification" },
  { value: "issue-verify", label: "Issue verification" },
  { value: "reproduction-setup", label: "Reproduction setup" },
  { value: "issue-fix", label: "Issue fix" },
  { value: "feature-implement", label: "Feature implementation" },
];

export function reportKindLabel(kind: InvestigationTaskKind): string {
  return taskKinds.find((item) => item.value === kind)?.label ?? kind;
}

interface ReportFilterValues {
  repositoryId: string;
  kind: string;
  completeness: string;
  delivery: string;
}

function ReportFilterFields({
  values,
  repositories,
  onChange,
  compact = false,
}: {
  values: ReportFilterValues;
  repositories: Repository[];
  onChange: (name: keyof ReportFilterValues, value: string) => void;
  compact?: boolean;
}) {
  const className = compact ? undefined : "report-directory-desktop-filter";
  const menuItemSx = compact ? { minHeight: 48 } : undefined;
  return (
    <>
      <TextField
        select
        fullWidth
        className={className}
        label="Repository"
        value={values.repositoryId}
        onChange={(event) => onChange("repositoryId", event.target.value)}
      >
        <MenuItem value="" sx={menuItemSx}>
          All accessible repositories
        </MenuItem>
        {repositories.map((item) => (
          <MenuItem key={item.id} value={item.id} sx={menuItemSx}>
            {item.fullName}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        fullWidth
        className={className}
        label="Investigation type"
        value={values.kind}
        onChange={(event) => onChange("kind", event.target.value)}
      >
        <MenuItem value="" sx={menuItemSx}>
          All types
        </MenuItem>
        {taskKinds.map((item) => (
          <MenuItem key={item.value} value={item.value} sx={menuItemSx}>
            {item.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        fullWidth
        className={className}
        label="Completeness"
        value={values.completeness}
        onChange={(event) => onChange("completeness", event.target.value)}
      >
        <MenuItem value="" sx={menuItemSx}>
          Any completeness
        </MenuItem>
        <MenuItem value="complete" sx={menuItemSx}>
          Complete report
        </MenuItem>
        <MenuItem value="partial" sx={menuItemSx}>
          Partial report
        </MenuItem>
      </TextField>
      <TextField
        select
        fullWidth
        className={className}
        label="Delivery"
        value={values.delivery}
        onChange={(event) => onChange("delivery", event.target.value)}
      >
        <MenuItem value="" sx={menuItemSx}>
          All deliveries
        </MenuItem>
        <MenuItem value="final" sx={menuItemSx}>
          Final delivery
        </MenuItem>
        <MenuItem value="checkpoint" sx={menuItemSx}>
          Checkpoint
        </MenuItem>
      </TextField>
    </>
  );
}

export function ReportDirectoryRow({
  header,
  to,
}: {
  header: InvestigationReportHeaderV1;
  to: string;
}) {
  const { report, context } = header;
  return (
    <ButtonBase
      component={Link}
      to={to}
      className="report-directory-row"
      sx={{
        width: "100%",
        textAlign: "left",
        p: { xs: 2, md: 3 },
        borderBottom: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box
        className="report-directory-icon"
        sx={{
          bgcolor: "action.selected",
          color: "primary.main",
          width: 48,
          height: 48,
          display: "grid",
          placeItems: "center",
          borderRadius: 3,
        }}
      >
        <DescriptionRounded />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {context.repository.fullName} ·{" "}
          {context.workItem.kind === "pull_request" ? "Pull request" : "Issue"} #
          {context.workItem.number} · {reportKindLabel(context.task.kind)}
        </Typography>
        <Typography component="h2" variant="h6" sx={{ my: 0.75, overflowWrap: "anywhere" }}>
          {context.workItem.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {report.summary}
        </Typography>
      </Box>
      <Stack className="report-directory-status" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Chip
          size="small"
          label={report.delivery === "checkpoint" ? "Checkpoint" : "Final delivery"}
          color={report.delivery === "checkpoint" ? "warning" : "default"}
        />
        <Typography variant="caption" color="text.secondary">
          {report.completeness} report · {report.collections.findings} findings
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Execution: {header.outcome}
        </Typography>
      </Stack>
      <ArrowForwardRounded className="report-directory-arrow" fontSize="small" />
    </ButtonBase>
  );
}

export function ReportDirectory() {
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const [params, setParams] = useSearchParams();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [compactFilters, setCompactFilters] = useState<ReportFilterValues>();
  const filterFormId = useId();
  const repositoryId = params.get("repositoryId") || undefined;
  const search = params.get("search") ?? "";
  const kind = taskKinds.find((item) => item.value === params.get("kind"))?.value;
  const completeness =
    params.get("completeness") === "complete"
      ? "complete"
      : params.get("completeness") === "partial"
        ? "partial"
        : undefined;
  const delivery =
    params.get("delivery") === "final"
      ? "final"
      : params.get("delivery") === "checkpoint"
        ? "checkpoint"
        : undefined;
  const cursor = params.get("cursor") || undefined;
  const appliedFilters: ReportFilterValues = {
    repositoryId: repositoryId ?? "",
    kind: kind ?? "",
    completeness: completeness ?? "",
    delivery: delivery ?? "",
  };
  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;
  const compactValues = compactFilters ?? appliedFilters;
  const query: InvestigationReportDirectoryQuery = {
    repositoryId,
    search: search.trim() || undefined,
    kind,
    completeness,
    delivery,
    cursor,
    limit: 20,
  };
  const reports = useQuery({
    queryKey: ["investigation-report-directory", identity, query],
    queryFn: ({ signal }) => investigationApi.reports(query, signal),
  });
  const repositories = useQuery({
    queryKey: ["investigation-repositories", identity],
    queryFn: () => investigationApi.repositories(),
  });
  const filter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("cursor");
    setPrevious([]);
    setParams(next, { replace: true });
  };
  const navigatePage = (nextCursor?: string) => {
    const next = new URLSearchParams(params);
    if (nextCursor) next.set("cursor", nextCursor);
    else next.delete("cursor");
    setParams(next);
  };
  const applyCompactFilters = (values: ReportFilterValues) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    next.delete("cursor");
    setPrevious([]);
    setParams(next, { replace: true });
    setCompactFilters(undefined);
  };
  return (
    <Stack spacing={3} className="report-workspace report-directory">
      <PageHeading
        title="Reports"
        subtitle="Conclusions, evidence, and your next decision."
        action={
          <Button
            startIcon={<RefreshRounded />}
            disabled={reports.isFetching}
            onClick={() => void reports.refetch()}
          >
            Refresh reports
          </Button>
        }
      />
      <Box
        role="search"
        aria-label="Report search and filters"
        className="report-directory-filters"
      >
        <TextField
          label="Search reports"
          type="search"
          value={search}
          onChange={(event) => filter("search", event.target.value)}
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <ReportFilterFields
          values={appliedFilters}
          repositories={repositories.data?.items ?? []}
          onChange={filter}
        />
        <Button
          className="report-directory-mobile-filter"
          startIcon={<FilterListRounded />}
          variant={activeFilterCount ? "contained" : "outlined"}
          aria-haspopup="dialog"
          aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : "Filters"}
          onClick={() => {
            setCompactFilters((current) => current ?? appliedFilters);
            setFiltersOpen(true);
          }}
        >
          Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
        </Button>
        {activeFilterCount > 0 && (
          <Button
            className="report-directory-clear-filters"
            onClick={() =>
              applyCompactFilters({ repositoryId: "", kind: "", completeness: "", delivery: "" })
            }
          >
            Clear filters
          </Button>
        )}
      </Box>
      {repositories.isError && (
        <Alert severity="warning">
          Repository filters could not be loaded. {repositories.error.message}
        </Alert>
      )}
      {reports.isPending && (
        <Box role="status">
          <CircularProgress size={24} />
          <Typography>Loading reports…</Typography>
        </Box>
      )}
      {reports.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void reports.refetch()}>Retry</Button>}
        >
          {reports.error.message}
        </Alert>
      )}
      {reports.data &&
        (reports.data.items.length ? (
          <Surface sx={{ overflow: "hidden" }}>
            {reports.data.items.map((header) => {
              const target = new URLSearchParams(params);
              target.set("reportId", header.report.id);
              return (
                <ReportDirectoryRow
                  key={`${header.report.id}:${header.report.version}`}
                  header={header}
                  to={`/reports?${target}`}
                />
              );
            })}
          </Surface>
        ) : (
          <EmptyState
            title="No matching reports"
            description="Saved reports from repositories available to your account appear here."
            action={
              search || kind || delivery || completeness ? (
                <Button
                  onClick={() => {
                    const next = new URLSearchParams();
                    if (repositoryId) next.set("repositoryId", repositoryId);
                    setPrevious([]);
                    setParams(next);
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ))}
      {reports.data && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {reports.data.items.length} reports on this page
          </Typography>
          <Button
            disabled={!cursor || reports.isFetching}
            onClick={() => {
              navigatePage(previous.at(-1));
              setPrevious((value) => value.slice(0, -1));
            }}
          >
            Previous
          </Button>
          <Button
            disabled={!reports.data.nextCursor || reports.isFetching}
            onClick={() => {
              setPrevious((value) => [...value, cursor]);
              navigatePage(reports.data!.nextCursor ?? undefined);
            }}
          >
            Next
          </Button>
        </Stack>
      )}
      <Dialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        fullWidth
        maxWidth="xs"
        aria-labelledby={`${filterFormId}-title`}
      >
        <DialogTitle id={`${filterFormId}-title`}>Filter reports</DialogTitle>
        <DialogContent>
          <Box
            component="form"
            id={filterFormId}
            onSubmit={(event) => {
              event.preventDefault();
              applyCompactFilters(compactValues);
              setFiltersOpen(false);
            }}
          >
            <Stack spacing={2.5} sx={{ pt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                Choose Show reports to apply these filters. Closing this dialog keeps your unapplied
                choices.
              </Typography>
              <ReportFilterFields
                compact
                values={compactValues}
                repositories={repositories.data?.items ?? []}
                onChange={(name, value) =>
                  setCompactFilters((current) => ({
                    ...appliedFilters,
                    ...current,
                    [name]: value,
                  }))
                }
              />
              {repositories.isError && (
                <Alert severity="warning">Repository filters could not be loaded.</Alert>
              )}
              <Stack
                direction="row"
                useFlexGap
                sx={{ flexWrap: "wrap", justifyContent: "space-between", gap: 1 }}
              >
                <Button
                  type="button"
                  sx={{ minHeight: 48 }}
                  onClick={() =>
                    setCompactFilters({
                      repositoryId: "",
                      kind: "",
                      completeness: "",
                      delivery: "",
                    })
                  }
                >
                  Reset filters
                </Button>
                <Button
                  type="button"
                  startIcon={<RefreshRounded />}
                  disabled={reports.isFetching}
                  onClick={() => void reports.refetch()}
                  sx={{ minHeight: 48 }}
                >
                  Refresh reports
                </Button>
              </Stack>
            </Stack>
          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 2, flexWrap: "wrap", gap: 1 }}>
          <Button onClick={() => setFiltersOpen(false)} sx={{ minHeight: 48 }}>
            Cancel
          </Button>
          <Button type="submit" form={filterFormId} variant="contained" sx={{ minHeight: 48 }}>
            Show reports
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
