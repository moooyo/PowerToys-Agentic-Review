import type { ManagedRepositorySummary } from "@agentic-review/contracts";
import { DatabaseOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@umijs/max";
import { Alert, Button, Select, Skeleton, Space, Tooltip } from "antd";
import type { MouseEventHandler, ReactNode } from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { repositories } from "@/services/repositories";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { parseRepositoryScope, pathWithRepositoryScope, searchWithRepositoryScope } from "./scope";
import "./index.css";

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

export function RepositoryScopedLink({
  to,
  children,
  ...props
}: {
  to: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const location = useLocation();
  return (
    <Link {...props} to={pathWithRepositoryScope(to, location.search)}>
      {children}
    </Link>
  );
}

export function RepositorySelector({ collapsed = false }: { collapsed?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const scope = useRepositoryScope();
  const selection = parseRepositoryScope(location.search);
  const { query } = useAuthorizedRepositories();
  const options = [
    { label: "All repositories", value: "__all__" },
    ...(query.data ?? []).map((item) => ({
      label: `${item.fullName}${item.enabled ? "" : " (disabled)"}`,
      value: item.id,
    })),
  ];
  if (scope.repositoryId && !options.some((item) => item.value === scope.repositoryId)) {
    options.push({ label: scope.label, value: scope.repositoryId });
  }
  if (selection.kind === "invalid") {
    options.push({ label: "Invalid repository scope", value: "__invalid__" });
  }
  return (
    <div className={`repository-selector${collapsed ? " repository-selector--collapsed" : ""}`}>
      {!collapsed ? <label htmlFor="repository-scope">Repository</label> : null}
      <Tooltip title={collapsed ? scope.label : undefined} placement="right">
        <Select
          id="repository-scope"
          aria-label="Repository scope"
          className="repository-selector__input"
          showSearch
          optionFilterProp="label"
          loading={query.isPending}
          status={scope.error || query.isError ? "error" : undefined}
          prefix={collapsed ? <DatabaseOutlined /> : undefined}
          value={
            selection.kind === "all"
              ? "__all__"
              : selection.kind === "invalid"
                ? "__invalid__"
                : selection.repositoryId
          }
          options={options}
          popupMatchSelectWidth={collapsed ? 290 : false}
          onChange={(value: string) => {
            if (value === "__invalid__") return;
            navigate({
              pathname: location.pathname,
              search: searchWithRepositoryScope(
                location.search,
                value === "__all__" ? undefined : value,
              ),
              hash: location.hash,
            });
          }}
        />
      </Tooltip>
      {query.isError && !collapsed ? (
        <div className="repository-selector__error">
          <span>Repository list unavailable</span>
          <Button
            type="link"
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {scope.noAccess && !collapsed ? (
        <div className="repository-selector__error">No repository access</div>
      ) : null}
    </div>
  );
}

export function RepositoryScopeUnavailable() {
  const scope = useRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div className="repository-scope-unavailable">
      {scope.error ? (
        <Alert
          title={scope.noAccess ? "No repository access" : "Repository unavailable"}
          description={scope.error}
          type={scope.noAccess ? "info" : "error"}
          showIcon
          action={
            <Space wrap>
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
            </Space>
          }
        />
      ) : (
        <Skeleton active title={{ width: 240 }} paragraph={{ rows: 3 }} />
      )}
    </div>
  );
}
