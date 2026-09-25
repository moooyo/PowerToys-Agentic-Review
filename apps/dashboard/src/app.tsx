import {
  ArrowForwardRounded,
  BugReportRounded,
  CloseRounded,
  DarkModeRounded,
  DescriptionRounded,
  FolderRounded,
  ForumRounded,
  GridViewRounded,
  LightModeRounded,
  LinkRounded,
  LogoutRounded,
  PersonRounded,
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
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
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
import { InvestigationRepositorySelector } from "./investigation/repository-scope";
import { ReviewNavigationProvider } from "./investigation/review-navigation";
import {
  InvestigationSessionProvider,
  sessionIdentity,
  useInvestigationSession,
} from "./investigation/session";
import TasksPage from "./investigation/task-workspace";
import WebhookDeliveriesPage from "./investigation/webhook-deliveries-page";
import WorkersPage from "./investigation/workers-page";
import { isWorkspaceDetail, workspaceRecordKey } from "./investigation/workspace-navigation";
import { EmptyState } from "./investigation/workspace-ui";
import {
  publicWorkspaceHref,
  repositoryScopedPaths,
  scopedWorkspaceHref,
} from "./investigation/workspace-view";
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
    else if (item.kind === "task")
      destination = `/tasks?${new URLSearchParams({ taskId: item.id, repositoryId: item.repositoryId })}`;
    else if (item.kind === "report")
      destination = `/reports?${new URLSearchParams({ reportId: item.id, repositoryId: item.repositoryId })}`;
    else if (item.workItemKind)
      destination = `${item.workItemKind === "issue" ? "/issues" : "/pull-requests"}?${new URLSearchParams({ workItemId: item.id, repositoryId: item.repositoryId })}`;
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
            Enter at least two characters.
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
                        <FolderRounded />
                      ) : item.kind === "task" ? (
                        <PlayCircleRounded />
                      ) : item.kind === "report" ? (
                        <DescriptionRounded />
                      ) : item.workItemKind === "issue" ? (
                        <BugReportRounded />
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

function ApplicationShell() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { session, logout } = useInvestigationSession();
  const { mode, toggle } = useColorMode();
  const guard = useGuardedAction();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string>();
  const [lastRepository, setLastRepository] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string>();
  const routeRepository = new URLSearchParams(location.search).get("repositoryId") || undefined;
  const businessPage = repositoryScopedPaths.has(location.pathname);
  const repository = businessPage ? routeRepository : lastRepository;
  const permittedRepository =
    repository && session.user?.repositoryIds.includes(repository) ? repository : undefined;
  useEffect(() => {
    if (businessPage) setLastRepository(routeRepository);
  }, [businessPage, routeRepository]);
  const destinationFor = (path: string) => scopedWorkspaceHref(path, permittedRepository);
  const copyView = async () => {
    const url = window.location.origin + publicWorkspaceHref(location.pathname, location.search);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopyFallback(url);
    }
  };
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
  const selectedPage =
    Object.hasOwn(labels, location.pathname) && allowed(location.pathname) ? location.pathname : "";
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
  const navigation = () => (
    <nav className="workspace-rail-nav" aria-label="Workspace navigation">
      {groups.map((group) => {
        const Icon = group.icon;
        const destination = group.paths.find(allowed);
        return destination ? (
          <ButtonBase
            component={Link}
            key={group.id}
            to={destinationFor(destination)}
            className={`workspace-nav-link ${activeGroup?.id === group.id ? "selected" : ""}`}
            aria-current={activeGroup?.id === group.id ? "page" : undefined}
          >
            <span className="workspace-nav-symbol">
              <Icon />
            </span>
            <span>{group.label}</span>
          </ButtonBase>
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
            to={destinationFor(home)}
            aria-label="Workspace home"
            className="workspace-brand-mark"
          >
            <GridViewRounded />
          </IconButton>
        </Tooltip>
        {navigation()}
        <Tooltip title={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}>
          <IconButton
            className="workspace-theme-button"
            aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={toggle}
          >
            {mode === "light" ? <DarkModeRounded /> : <LightModeRounded />}
          </IconButton>
        </Tooltip>
      </aside>
      <Box className="workspace-content">
        <header className="workspace-app-bar">
          <Box className="workspace-page-picker">
            <TextField
              select
              fullWidth
              size="small"
              label="Page"
              value={selectedPage}
              onChange={(event) => navigate(destinationFor(event.target.value))}
            >
              {!selectedPage && <MenuItem value="">Choose page</MenuItem>}
              {groups.flatMap((group) => [
                <ListSubheader key={group.id}>{group.label}</ListSubheader>,
                ...group.paths.filter(allowed).map((path) => (
                  <MenuItem key={path} value={path}>
                    {labels[path]}
                  </MenuItem>
                )),
              ])}
              <MenuItem value="/account">My account</MenuItem>
            </TextField>
          </Box>
          <Link to={destinationFor(home)} className="workspace-brand">
            Agentic Review
          </Link>
          {businessPage && (
            <Box className="workspace-repository-picker">
              <InvestigationRepositorySelector fullWidth />
            </Box>
          )}
          <Box className="workspace-header-actions">
            <Tooltip title="Search workspace (Ctrl+K)">
              <Button
                className="workspace-search-button"
                aria-label="Search workspace (Ctrl+K)"
                startIcon={<SearchRounded />}
                onClick={() => setSearchOpen(true)}
              >
                <span>Search</span>
              </Button>
            </Tooltip>
            <Tooltip title="Copy view link">
              <IconButton
                className="workspace-copy-view"
                aria-label="Copy view link"
                onClick={() => void copyView()}
              >
                <LinkRounded />
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
                <Avatar sx={{ width: 40, height: 40, fontSize: 14, fontWeight: 500 }}>
                  {initials}
                </Avatar>
              </IconButton>
            </Tooltip>
          </Box>
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
                  to={destinationFor(path)}
                  className={location.pathname === path ? "selected" : ""}
                  aria-current={location.pathname === path ? "page" : undefined}
                >
                  {labels[path]}
                </Button>
              ))}
            </nav>
          )}
          <Box className="workspace-page-content">
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
                            action={
                              <Button component={Link} to="/account">
                                My account
                              </Button>
                            }
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
            toggle();
            setAnchor(null);
          }}
        >
          <ListItemIcon>
            {mode === "light" ? <DarkModeRounded /> : <LightModeRounded />}
          </ListItemIcon>
          {mode === "light" ? "Dark theme" : "Light theme"}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            guard(() => navigate("/account"));
          }}
        >
          <ListItemIcon>
            <PersonRounded />
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
      <Snackbar
        open={copied}
        autoHideDuration={3500}
        onClose={() => setCopied(false)}
        message="View link copied"
      />
      <Dialog
        open={Boolean(copyFallback)}
        onClose={() => setCopyFallback(undefined)}
        fullWidth
        maxWidth="sm"
        aria-labelledby="copy-view-title"
      >
        <DialogTitle id="copy-view-title">Copy current view</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>Copy this link to share the current view.</Typography>
          <TextField
            autoFocus
            fullWidth
            label="View link"
            value={copyFallback ?? ""}
            slotProps={{ input: { readOnly: true } }}
            onFocus={(event) => event.target.select()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCopyFallback(undefined)}>Done</Button>
        </DialogActions>
      </Dialog>
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
              <ReviewNavigationProvider>
                <ApplicationShell />
              </ReviewNavigationProvider>
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
