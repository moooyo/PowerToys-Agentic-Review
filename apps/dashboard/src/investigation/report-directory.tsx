import type {
  InvestigationReportDirectoryQuery,
  InvestigationReportHeaderV1,
  InvestigationTaskKind,
} from "@agentic-review/contracts";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
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
import { useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { investigationApi } from "./api";
import { reportOutcome } from "./outcome-summary";
import { type ReviewRecord, useReviewListNavigation } from "./review-navigation";
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

function directoryRecord(
  header: InvestigationReportHeaderV1,
  params: URLSearchParams,
): ReviewRecord {
  const target = new URLSearchParams(params);
  target.set("reportId", header.report.id);
  return {
    kind: "report",
    id: header.report.id,
    workItemId: header.context.workItem.id,
    repositoryId: header.context.repository.id,
    href: `/reports?${target}`,
    label: header.context.workItem.title,
  };
}

interface ReportFilterValues {
  kind: string;
  completeness: string;
  delivery: string;
}

/** Report-local filters never replace the workspace repository scope. */
export function applyReportDirectoryFilters(params: URLSearchParams, values: ReportFilterValues) {
  const next = new URLSearchParams(params);
  for (const key of ["kind", "completeness", "delivery"] as const) {
    if (values[key]) next.set(key, values[key]);
    else next.delete(key);
  }
  next.delete("cursor");
  return next;
}

export function clearReportDirectoryFilters(params: URLSearchParams) {
  const next = applyReportDirectoryFilters(params, { kind: "", completeness: "", delivery: "" });
  next.delete("search");
  return next;
}

function ReportFilterFields({
  values,
  onChange,
  compact = false,
}: {
  values: ReportFilterValues;
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
        label="Type"
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
        label="Status"
        value={values.completeness}
        onChange={(event) => onChange("completeness", event.target.value)}
      >
        <MenuItem value="" sx={menuItemSx}>
          All reports
        </MenuItem>
        <MenuItem value="complete" sx={menuItemSx}>
          Complete
        </MenuItem>
        <MenuItem value="partial" sx={menuItemSx}>
          Partial
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
          Final
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
  linkProps,
}: {
  header: InvestigationReportHeaderV1;
  to: string;
  linkProps?: ReturnType<ReturnType<typeof useReviewListNavigation>["getLinkProps"]>;
}) {
  const { report, context } = header;
  const outcome = reportOutcome(header);
  return (
    <ButtonBase
      component={Link}
      to={to}
      {...linkProps}
      className="report-directory-row"
      sx={{
        width: "100%",
        textAlign: "left",
        p: 2,
        borderBottom: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          component="h2"
          variant="subtitle1"
          sx={{ fontWeight: 600, overflowWrap: "anywhere" }}
        >
          {context.workItem.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          {context.repository.fullName} ·{" "}
          {context.workItem.kind === "pull_request" ? "PR" : "Issue"} #{context.workItem.number} ·{" "}
          {reportKindLabel(context.task.kind)}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center", mt: 0.75 }}
        >
          <Chip
            size="small"
            label={report.completeness === "partial" ? "Partial" : "Complete"}
            color={report.completeness === "partial" ? "warning" : "default"}
          />
          {report.delivery === "checkpoint" && (
            <Chip size="small" label="Checkpoint" variant="outlined" />
          )}
          <Typography variant="body2">
            {outcome.label} · {report.collections.findings} finding
            {report.collections.findings === 1 ? "" : "s"}
          </Typography>
          {outcome.validation.label !== "Validation" && (
            <Typography variant="caption" color="text.secondary">
              {outcome.validation.label}
            </Typography>
          )}
        </Stack>
      </Box>
      <Box
        component="span"
        className="report-directory-action"
        sx={{ color: "primary.main", borderColor: "divider" }}
      >
        {report.collections.findings
          ? "Review findings"
          : report.delivery === "checkpoint"
            ? "Review checkpoint"
            : "Read report"}
        <ArrowForwardRounded fontSize="small" />
      </Box>
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
  const records = useMemo<ReviewRecord[]>(
    () => (reports.data?.items ?? []).map((header) => directoryRecord(header, params)),
    [reports.data, params],
  );
  const { getLinkProps } = useReviewListNavigation({ label: "Reports", records, complete: false });
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
    setPrevious([]);
    setParams(applyReportDirectoryFilters(params, values), { replace: true });
    setCompactFilters(undefined);
  };
  const clearLocalFilters = () => {
    setPrevious([]);
    setCompactFilters(undefined);
    setParams(clearReportDirectoryFilters(params), { replace: true });
  };
  return (
    <Stack spacing={2} className="report-workspace report-directory">
      <PageHeading
        title="Reports"
        action={
          <Button
            startIcon={<RefreshRounded />}
            disabled={reports.isFetching}
            onClick={() => void reports.refetch()}
          >
            Refresh
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
          placeholder="Title or number"
          type="search"
          value={search}
          onChange={(event) => filter("search", event.target.value)}
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <ReportFilterFields values={appliedFilters} onChange={filter} />
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
        {(activeFilterCount > 0 || Boolean(search)) && (
          <Button className="report-directory-clear-filters" onClick={clearLocalFilters}>
            Clear filters
          </Button>
        )}
      </Box>
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
            <Box
              className="report-directory-list-heading"
              sx={{ bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}
            >
              <Typography variant="caption">
                {reports.data.items.length} report{reports.data.items.length === 1 ? "" : "s"}
                {reports.data.nextCursor || cursor ? " on this page" : ""}
              </Typography>
              <Typography variant="caption">Next action</Typography>
            </Box>
            {reports.data.items.map((header) => {
              const record = directoryRecord(header, params);
              return (
                <ReportDirectoryRow
                  key={`${header.report.id}:${header.report.version}`}
                  header={header}
                  to={record.href}
                  linkProps={getLinkProps(record)}
                />
              );
            })}
          </Surface>
        ) : (
          <EmptyState
            title="No matching reports"
            action={
              search || kind || delivery || completeness ? (
                <Button onClick={clearLocalFilters}>Clear filters</Button>
              ) : undefined
            }
          />
        ))}
      {reports.data && (cursor || reports.data.nextCursor) && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {reports.data.items.length} report{reports.data.items.length === 1 ? "" : "s"} on this
            page
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
              navigatePage(reports.data?.nextCursor ?? undefined);
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
              <ReportFilterFields
                compact
                values={compactValues}
                onChange={(name, value) =>
                  setCompactFilters((current) => ({
                    ...appliedFilters,
                    ...current,
                    [name]: value,
                  }))
                }
              />
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
            Apply filters
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
