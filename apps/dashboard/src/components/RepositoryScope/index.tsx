import type { ManagedRepositorySummary } from "@agentic-review/contracts";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Skeleton,
  Stack,
  TextField,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { forwardRef, type MouseEventHandler, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { repositories } from "@/services/repositories";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { parseRepositoryScope, pathWithRepositoryScope, searchWithRepositoryScope } from "./scope";

async function listScopeRepositories(): Promise<ManagedRepositorySummary[]> {
  const result: ManagedRepositorySummary[] = [];
  const identifiers = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page += 1) {
    const current = await repositories.list({ page, pageSize: 50 });
    if (total === undefined) total = current.total;
    if (current.total !== total || total > 10_000) {
      throw new Error(
        "The repository list changed while loading. Refresh the repository selector.",
      );
    }
    if (current.items.length > 50) {
      throw new Error("The repository list exceeded its requested page size.");
    }
    for (const item of current.items) {
      if (identifiers.has(item.id)) {
        throw new Error("The repository list contains repeated entries. Refresh and try again.");
      }
      identifiers.add(item.id);
      result.push(item);
    }
    if (result.length > total)
      throw new Error("The repository list returned an inconsistent total.");
    if (result.length === total) return result;
    if (current.items.length < 50) {
      throw new Error("The repository list ended before all repositories were loaded.");
    }
  }
}

export function useAuthorizedRepositories() {
  const operatorAccess = useOperatorAccess();
  const query = useQuery({
    queryKey: ["managed-repositories", "scope-options", ...operatorAccess.identityKey],
    queryFn: listScopeRepositories,
    enabled: operatorAccess.allows("read"),
    retry: false,
    refetchOnWindowFocus: true,
  });
  return { query, operatorAccess };
}

export function useRepositoryScope() {
  const location = useLocation();
  const selection = parseRepositoryScope(location.search);
  const repositoryId = selection.kind === "repository" ? selection.repositoryId : undefined;
  const operatorAccess = useOperatorAccess(repositoryId);
  const directory = useAuthorizedRepositories();
  const query = useQuery({
    queryKey: ["managed-repositories", "detail", repositoryId, ...operatorAccess.identityKey],
    queryFn: () => {
      if (repositoryId === undefined) throw new Error("A repository identifier is required.");
      return repositories.get(repositoryId);
    },
    enabled: repositoryId !== undefined && operatorAccess.allows("read"),
    retry: false,
  });
  const accessDenied =
    operatorAccess.error instanceof ReviewControlHttpError &&
    [403, 404].includes(operatorAccess.error.status);
  const noAccess =
    selection.kind === "all" &&
    directory.query.isSuccess &&
    directory.query.data.length === 0 &&
    !operatorAccess.platformAdministrator;
  const error =
    selection.kind === "invalid"
      ? selection.message
      : operatorAccess.error
        ? accessDenied
          ? "The repository is unavailable or you do not have access."
          : "Repository access could not be verified. Refresh to try again."
        : noAccess
          ? "You are signed in, but no repositories have been shared with you. Ask a repository or platform administrator for access."
          : selection.kind === "all" && directory.query.isError
            ? "The list of accessible repositories could not be loaded."
            : repositoryId !== undefined && query.isError
              ? query.error.message
              : null;
  const ready =
    operatorAccess.allows("read") &&
    !error &&
    (selection.kind === "all"
      ? directory.query.isSuccess
      : repositoryId !== undefined && query.isSuccess);
  return {
    key: selection.key,
    repositoryId,
    repository: repositoryId === undefined || !ready ? undefined : query.data,
    label:
      selection.kind === "all"
        ? "All repositories"
        : (query.data?.fullName ?? (error ? "Repository unavailable" : "Loading repository…")),
    ready,
    error,
    noAccess: noAccess || accessDenied,
    refresh: async () => {
      await operatorAccess.refresh();
      await directory.query.refetch();
      if (repositoryId !== undefined) await query.refetch();
    },
  };
}

export const RepositoryScopedLink = forwardRef<
  HTMLAnchorElement,
  {
    to: string;
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    className?: string;
    title?: string;
    "aria-label"?: string;
  }
>(function RepositoryScopedLink({ to, children, ...props }, ref) {
  const location = useLocation();
  return (
    <Link ref={ref} {...props} to={pathWithRepositoryScope(to, location.search)}>
      {children}
    </Link>
  );
});

export function RepositorySelector({
  collapsed = false,
  fullWidth = false,
}: {
  collapsed?: boolean;
  fullWidth?: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const scope = useRepositoryScope();
  const selection = parseRepositoryScope(location.search);
  const { query } = useAuthorizedRepositories();
  const all = { label: "All repositories", value: "__all__" };
  const options = [
    all,
    ...(query.data ?? []).map((item) => ({
      label: `${item.fullName}${item.enabled ? "" : " (disabled)"}`,
      value: item.id,
    })),
  ];
  if (scope.repositoryId && !options.some((item) => item.value === scope.repositoryId))
    options.push({ label: scope.label, value: scope.repositoryId });
  if (selection.kind === "invalid")
    options.push({ label: "Invalid repository scope", value: "__invalid__" });
  const value =
    selection.kind === "all"
      ? "__all__"
      : selection.kind === "invalid"
        ? "__invalid__"
        : selection.repositoryId;
  return (
    <Box
      sx={{
        width: fullWidth ? "100%" : { xs: 176, sm: collapsed ? 220 : 284 },
        flex: fullWidth ? 1 : undefined,
        minWidth: 0,
      }}
    >
      <Autocomplete
        id="repository-scope"
        disableClearable
        size="small"
        options={options}
        loading={query.isPending}
        value={options.find((option) => option.value === value) ?? all}
        isOptionEqualToValue={(option, selected) => option.value === selected.value}
        onChange={(_event, next) => {
          if (next.value === "__invalid__") return;
          navigate({
            pathname: location.pathname,
            search: searchWithRepositoryScope(
              location.search,
              next.value === "__all__" ? undefined : next.value,
            ),
            hash: location.hash,
          });
        }}
        renderInput={(params) => (
          <TextField {...params} label="Repository" error={Boolean(scope.error || query.isError)} />
        )}
      />
      {query.isError && !collapsed && (
        <Button size="small" startIcon={<RefreshRounded />} onClick={() => void query.refetch()}>
          Retry repository list
        </Button>
      )}
    </Box>
  );
}

export function RepositoryScopeUnavailable() {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Box className="repository-scope-unavailable" sx={{ py: 2 }}>
      {scope.error ? (
        <Alert severity={scope.noAccess ? "info" : "error"}>
          <AlertTitle>
            {scope.noAccess ? "No repository access" : "Repository unavailable"}
          </AlertTitle>
          {scope.error}
          <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1, mt: 2 }}>
            <Button onClick={() => void scope.refresh()}>Refresh</Button>
            <Button
              onClick={() =>
                navigate({
                  pathname: location.pathname,
                  search: searchWithRepositoryScope(location.search),
                  hash: location.hash,
                })
              }
            >
              Show all repositories
            </Button>
          </Stack>
        </Alert>
      ) : (
        <Stack spacing={1}>
          <Skeleton width={240} height={36} />
          <Skeleton height={56} />
          <Skeleton height={120} />
        </Stack>
      )}
    </Box>
  );
}
