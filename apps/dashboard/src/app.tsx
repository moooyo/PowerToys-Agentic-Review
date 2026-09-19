import {
  ArrowForwardRounded,
  BugReportOutlined,
  CloseRounded,
  DarkModeOutlined,
  DescriptionOutlined,
  FolderOutlined,
  ForumRounded,
  GridViewRounded,
  LightModeOutlined,
  LogoutRounded,
  MenuRounded,
  PersonOutlineRounded,
  PlayCircleRounded,
  RateReviewRounded,
  SearchRounded,
  TuneRounded,
} from "@mui/icons-material";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  type ComponentType,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createBrowserRouter,
  Link,
  Navigate,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import routeDefinitions from "../config/routes";
import AccountsPage from "./investigation/accounts-page";
import { type InvestigationWorkspaceSearchResult, investigationApi } from "./investigation/api";
import CommentsPage from "./investigation/comments-page";
import MyAccountPage from "./investigation/my-account";
import { NavigationGuardProvider, useGuardedAction } from "./investigation/navigation-guard";
import ReportPage from "./investigation/report-workspace";
import RepositoriesPage from "./investigation/repositories-page";
import { useInvestigationRepositoryScope } from "./investigation/repository-scope";
import {
  InvestigationSessionProvider,
  sessionIdentity,
  useInvestigationSession,
} from "./investigation/session";
import TasksPage from "./investigation/task-workspace";
import WebhookDeliveriesPage from "./investigation/webhook-deliveries-page";
import WorkersPage from "./investigation/workers-page";
import {
  hasAppliedRepositoryFilter,
  isWorkspaceDetail,
  withoutRepositoryFilter,
  workspaceRecordKey,
} from "./investigation/workspace-navigation";
import { EmptyState } from "./investigation/workspace-ui";
import IssuesPage from "./pages/Issues";
import PullRequestsPage from "./pages/PullRequests";
import { MaterialTheme, useColorMode } from "./theme";
import "./global.css";
import "./workspace-shell.css";

const pages: Record<string, ComponentType> = {
  "./PullRequests": PullRequestsPage,
  "./Issues": IssuesPage,
  "./InvestigationTasks": TasksPage,
  "./InvestigationComments": CommentsPage,
  "./InvestigationWebhooks": WebhookDeliveriesPage,
  "./InvestigationWorkers": WorkersPage,
  "./InvestigationReport": ReportPage,
  "./InvestigationRepositories": RepositoriesPage,
  "./MyAccount": MyAccountPage,
  "./Accounts": AccountsPage,
};
const groups = [
  {
    id: "review",
    label: "Review",
    icon: RateReviewRounded,
    paths: ["/pull-requests", "/issues", "/reports"],
  },
  { id: "tasks", label: "Tasks", icon: PlayCircleRounded, paths: ["/tasks"] },
  { id: "activity", label: "Activity", icon: ForumRounded, paths: ["/comments", "/webhooks"] },
  {
    id: "workspace",
    label: "Workspace",
    icon: TuneRounded,
    paths: ["/repositories", "/workers", "/accounts"],
  },
];
const labels: Record<string, string> = {
  "/pull-requests": "Pull requests",
  "/issues": "Issues",
  "/reports": "Reports",
  "/tasks": "Tasks",
  "/comments": "Comments",
  "/webhooks": "Webhook events",
  "/repositories": "Repositories",
  "/workers": "Workers",
  "/accounts": "Accounts",
  "/account": "My account",
};

function WorkspaceSearch({ open, close }: { open: boolean; close: () => void }) {
  const { session } = useInvestigationSession();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const guard = useGuardedAction();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setError(undefined);
    }
  }, [open]);
  const results = useQuery({
    queryKey: ["investigation-workspace-search", sessionIdentity(session), debounced],
    queryFn: ({ signal }) =>
      investigationApi.workspaceSearch({ query: debounced, limit: 20 }, signal),
    enabled: open && debounced.length >= 2,
  });
  const choose = (item: InvestigationWorkspaceSearchResult["items"][number]) => {
    let destination: string;
    if (item.kind === "repository")
      destination = `/repositories?repositoryId=${encodeURIComponent(item.id)}`;
    else if (item.kind === "task") destination = `/tasks?taskId=${encodeURIComponent(item.id)}`;
    else if (item.kind === "report")
      destination = `/reports?reportId=${encodeURIComponent(item.id)}`;
    else if (item.workItemKind)
      destination = `${item.workItemKind === "issue" ? "/issues" : "/pull-requests"}?workItemId=${encodeURIComponent(item.id)}`;
    else {
      setError("This source has no recorded type. Refresh the search before opening it.");
      return;
    }
    close();
    guard(() => navigate(destination));
  };
  return (
    <Dialog open={open} onClose={close} maxWidth="sm" aria-labelledby="workspace-search-title">
      <DialogTitle
        id="workspace-search-title"
        sx={{ display: "flex", alignItems: "center", gap: 2 }}
      >
        <Box sx={{ flex: 1 }}>Search workspace</Box>
        <IconButton aria-label="Close search" onClick={close}>
          <CloseRounded />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Search sources, tasks, and reports"
          value={query}
          onChange={(event) => setQuery(event.target.value.slice(0, 200))}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded />
                </InputAdornment>
              ),
            },
          }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        {results.isError && (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={<Button onClick={() => void results.refetch()}>Retry</Button>}
          >
            {results.error.message}
          </Alert>
        )}
        {debounced.length < 2 ? (
          <Typography color="text.secondary" sx={{ py: 3 }}>
            Enter at least two characters. Results include only repositories you can access.
          </Typography>
        ) : results.isFetching ? (
          <Typography role="status" color="text.secondary" sx={{ py: 3 }}>
            Searching…
          </Typography>
        ) : (
          results.data && (
            <>
              <List aria-label="Search results" sx={{ mt: 1 }}>
                {results.data.items.map((item) => (
                  <ListItemButton
                    key={`${item.kind}:${item.id}`}
                    onClick={() => choose(item)}
                    sx={{ borderRadius: 2, alignItems: "flex-start", py: 1.5 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
                      {item.kind === "repository" ? (
                        <FolderOutlined />
                      ) : item.kind === "task" ? (
                        <PlayCircleRounded />
                      ) : item.kind === "report" ? (
                        <DescriptionOutlined />
                      ) : item.workItemKind === "issue" ? (
                        <BugReportOutlined />
                      ) : (
                        <RateReviewRounded />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={item.title}
                      secondary={item.description}
                      slotProps={{
                        primary: { sx: { overflowWrap: "anywhere" } },
                        secondary: { sx: { overflowWrap: "anywhere" } },
                      }}
                    />
                    <ArrowForwardRounded
                      sx={{ ml: 1, mt: 0.5, fontSize: 18, color: "text.secondary" }}
                    />
                  </ListItemButton>
                ))}
              </List>
              {!results.data.items.length && (
                <EmptyState
                  title="No matching results"
                  description="Try a source number, title, or task name."
                />
              )}
              {results.data.truncated && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  More results are available. Refine your search to find the right item.
                </Typography>
              )}
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppliedRepositoryFilter() {
  const scope = useInvestigationRepositoryScope();
  const location = useLocation();
  const navigate = useNavigate();
  const name =
    scope.repository?.fullName ??
    (scope.query.isPending ? "Loading repository…" : "Repository unavailable");
  return (
    <Box sx={{ mb: 2.5, minWidth: 0 }}>
      <Tooltip title="View all accessible repositories">
        <Button
          size="small"
          variant="outlined"
          startIcon={<FolderOutlined />}
          endIcon={<CloseRounded />}
          aria-label={`Clear repository filter: ${name}`}
          onClick={() =>
            navigate({
              pathname: location.pathname,
              search: withoutRepositoryFilter(location.search),
            })
          }
          sx={{ maxWidth: "100%", borderRadius: 2, textAlign: "left" }}
        >
          <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
            Repository: {name}
          </Box>
        </Button>
      </Tooltip>
    </Box>
  );
}

function ApplicationShell() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { session, logout } = useInvestigationSession();
  const { mode, toggle } = useColorMode();
  const guard = useGuardedAction();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string>();
  const main = useRef<HTMLElement | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  // Capture before a shorter destination can clamp scrollTop during the route commit.
  const rememberScroll = useCallback((key: string, top: number) => {
    scrollPositions.current.set(key, top);
    while (scrollPositions.current.size > 100) {
      const first = scrollPositions.current.keys().next().value;
      if (first === undefined) break;
      scrollPositions.current.delete(first);
    }
  }, []);
  const recordKey = workspaceRecordKey(location.pathname, location.search);
  const previousRecord = useRef(recordKey);
  const activeGroup = groups.find((group) => group.paths.includes(location.pathname));
  const allowed = (path: string) =>
    !["/accounts", "/workers"].includes(path) || Boolean(session.user?.isAdmin);
  const isDetail = isWorkspaceDetail(location.pathname, location.search);
  const home = session.user?.repositoryIds.length ? "/pull-requests" : "/account";
  const initials = (session.user?.displayName || session.user?.username || "Account")
    .trim()
    .split(/\s+/u)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  useEffect(() => {
    document.title = `${labels[location.pathname] ?? "Workspace"} · Agentic Review`;
    setMobileOpen(false);
    setAnchor(null);
  }, [location.pathname]);
  useLayoutEffect(() => {
    const target = main.current;
    if (!target) return;
    if (navigationType === "POP" && scrollPositions.current.has(location.key)) {
      target.scrollTop = scrollPositions.current.get(location.key) ?? 0;
    } else if (previousRecord.current !== recordKey) target.scrollTop = 0;
    previousRecord.current = recordKey;
    rememberScroll(location.key, target.scrollTop);
  }, [location.key, navigationType, recordKey, rememberScroll]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const navigation = (compact: boolean) => (
    <nav
      className={compact ? "workspace-bottom-nav" : "workspace-rail-nav"}
      aria-label={compact ? "Main navigation" : "Workspace navigation"}
    >
      {groups.map((group) => {
        const Icon = group.icon;
        const destination = group.paths.find(allowed);
        return destination ? (
          <Link
            key={group.id}
            to={destination}
            className={`workspace-nav-link ${activeGroup?.id === group.id ? "selected" : ""}`}
            aria-current={activeGroup?.id === group.id ? "page" : undefined}
          >
            <span className="workspace-nav-symbol">
              <Icon />
            </span>
            <span>{group.label}</span>
          </Link>
        ) : null;
      })}
    </nav>
  );
  return (
    <Box className="workspace-shell">
      <button
        type="button"
        className="workspace-skip"
        onClick={() => main.current?.focus({ preventScroll: true })}
      >
        Skip to content
      </button>
      <aside className="workspace-rail">
        <Tooltip title="Agentic Review">
          <IconButton
            component={Link}
            to={home}
            aria-label="Workspace home"
            className="workspace-brand-mark"
          >
            <GridViewRounded />
          </IconButton>
        </Tooltip>
        {navigation(false)}
        <Tooltip title={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}>
          <IconButton
            className="workspace-theme-button"
            aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={toggle}
          >
            {mode === "light" ? <DarkModeOutlined /> : <LightModeOutlined />}
          </IconButton>
        </Tooltip>
      </aside>
      <Box className="workspace-content">
        <header className="workspace-app-bar">
          <IconButton
            className="workspace-mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <MenuRounded />
          </IconButton>
          <Link to={home} className="workspace-brand">
            Agentic Review
          </Link>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Search workspace (Ctrl+K)">
            <IconButton aria-label="Search workspace (Ctrl+K)" onClick={() => setSearchOpen(true)}>
              <SearchRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title="My account">
            <IconButton
              aria-label="Open account menu"
              aria-controls={anchor ? "workspace-account-menu" : undefined}
              aria-haspopup="menu"
              aria-expanded={Boolean(anchor)}
              onClick={(event) => setAnchor(event.currentTarget)}
            >
              <Avatar sx={{ width: 36, height: 36, fontSize: 14, fontWeight: 500 }}>
                {initials}
              </Avatar>
            </IconButton>
          </Tooltip>
        </header>
        <Box
          component="main"
          id="workspace-main"
          ref={main}
          tabIndex={-1}
          className="material-main material-scroll-region workspace-main"
          aria-label="Workspace"
          onScroll={(event) => rememberScroll(location.key, event.currentTarget.scrollTop)}
        >
          {error && (
            <Alert severity="error" onClose={() => setError(undefined)} sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}
          {!isDetail && activeGroup && activeGroup.paths.filter(allowed).length > 1 && (
            <nav className="workspace-group-tabs" aria-label={`${activeGroup.label} pages`}>
              {activeGroup.paths.filter(allowed).map((path) => (
                <Button
                  key={path}
                  component={Link}
                  to={path}
                  className={location.pathname === path ? "selected" : ""}
                  aria-current={location.pathname === path ? "page" : undefined}
                >
                  {labels[path]}
                </Button>
              ))}
            </nav>
          )}
          <Box className="workspace-page-content">
            {hasAppliedRepositoryFilter(location.pathname, location.search) && (
              <AppliedRepositoryFilter />
            )}
            <Suspense
              fallback={
                <Typography color="text.secondary" role="status">
                  Loading workspace…
                </Typography>
              }
            >
              <Routes>
                {routeDefinitions.map((route) => {
                  const Page = pages[route.component];
                  return (
                    <Route
                      key={route.path}
                      path={route.path}
                      element={
                        route.component === "./WorkspaceRedirect" ? (
                          <Navigate to={home} replace />
                        ) : route.adminOnly && !session.user?.isAdmin ? (
                          <EmptyState
                            title="Administrator access required"
                            description="Your account does not have access to this management page."
                          />
                        ) : Page ? (
                          <Page />
                        ) : (
                          <EmptyState
                            title="Page unavailable"
                            description="This page is not part of the investigation workspace."
                            action={
                              <Button component={Link} to={home}>
                                Open workspace
                              </Button>
                            }
                          />
                        )
                      }
                    />
                  );
                })}
              </Routes>
            </Suspense>
          </Box>
        </Box>
      </Box>
      {navigation(true)}
      <Drawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        slotProps={{ paper: { sx: { width: "min(320px, 90vw)", p: 2 } } }}
      >
        <Stack
          direction="row"
          sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="h6">Agentic Review</Typography>
          <IconButton aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
            <CloseRounded />
          </IconButton>
        </Stack>
        {groups.map((group) => (
          <Box key={group.id} sx={{ mb: 2 }}>
            <Typography color="text.secondary" variant="body2" sx={{ px: 2, pb: 1 }}>
              {group.label}
            </Typography>
            <List disablePadding>
              {group.paths.filter(allowed).map((path) => (
                <ListItemButton
                  key={path}
                  component={Link}
                  to={path}
                  onClick={() => setMobileOpen(false)}
                  selected={location.pathname === path}
                  sx={{ borderRadius: 2 }}
                >
                  <ListItemText primary={labels[path]} />
                </ListItemButton>
              ))}
            </List>
          </Box>
        ))}
        <Divider />
        <Button
          onClick={toggle}
          startIcon={mode === "light" ? <DarkModeOutlined /> : <LightModeOutlined />}
          sx={{ mt: 2 }}
        >
          {mode === "light" ? "Dark theme" : "Light theme"}
        </Button>
      </Drawer>
      <Menu
        id="workspace-account-menu"
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 240,
              maxWidth: "calc(100vw - 32px)",
              mt: 1,
              bgcolor: "background.paper",
              boxShadow: "0 8px 30px rgb(20 35 60 / 14%)",
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography sx={{ overflowWrap: "anywhere", fontWeight: 500 }}>
            {session.user?.displayName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            @{session.user?.username}
          </Typography>
        </Box>
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            guard(() => navigate("/account"));
          }}
        >
          <ListItemIcon>
            <PersonOutlineRounded />
          </ListItemIcon>
          My account
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            guard(() => {
              void logout().catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Sign out failed."),
              );
            });
          }}
        >
          <ListItemIcon>
            <LogoutRounded />
          </ListItemIcon>
          Sign out
        </MenuItem>
      </Menu>
      <WorkspaceSearch open={searchOpen} close={() => setSearchOpen(false)} />
    </Box>
  );
}

export default function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          path: "*",
          element: (
            <NavigationGuardProvider>
              <ApplicationShell />
            </NavigationGuardProvider>
          ),
        },
      ]),
    [],
  );
  return (
    <MaterialTheme>
      <QueryClientProvider client={queryClient}>
        <InvestigationSessionProvider>
          <RouterProvider router={router} />
        </InvestigationSessionProvider>
      </QueryClientProvider>
    </MaterialTheme>
  );
}
