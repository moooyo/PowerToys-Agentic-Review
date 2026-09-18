import {
  AccountTreeRounded,
  CloseRounded,
  CommentOutlined,
  DarkModeOutlined,
  FactCheckOutlined,
  FolderOutlined,
  GitHub,
  LightModeOutlined,
  LogoutRounded,
  ManageAccountsOutlined,
  MenuRounded,
  PersonOutlineRounded,
  PlayCircleOutlineRounded,
} from "@mui/icons-material";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentType, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import routeDefinitions from "../config/routes";
import AccountsPage from "./investigation/accounts-page";
import CommentsPage from "./investigation/comments-page";
import MyAccountPage from "./investigation/my-account";
import ReportPage from "./investigation/report-workspace";
import RepositoriesPage from "./investigation/repositories-page";
import {
  InvestigationRepositorySelector,
  useInvestigationRepositoryScope,
} from "./investigation/repository-scope";
import { InvestigationSessionProvider, useInvestigationSession } from "./investigation/session";
import TasksPage from "./investigation/task-workspace";
import IssuesPage from "./pages/Issues";
import PullRequestsPage from "./pages/PullRequests";
import { MaterialTheme, useColorMode } from "./theme";
import "./global.css";

const pages: Record<string, ComponentType> = {
  "./PullRequests": PullRequestsPage,
  "./Issues": IssuesPage,
  "./InvestigationTasks": TasksPage,
  "./InvestigationComments": CommentsPage,
  "./InvestigationReport": ReportPage,
  "./InvestigationRepositories": RepositoriesPage,
  "./MyAccount": MyAccountPage,
  "./Accounts": AccountsPage,
};
const icons: Record<string, ComponentType> = {
  "/pull-requests": AccountTreeRounded,
  "/issues": FactCheckOutlined,
  "/tasks": PlayCircleOutlineRounded,
  "/comments": CommentOutlined,
  "/repositories": FolderOutlined,
  "/account": PersonOutlineRounded,
  "/accounts": ManageAccountsOutlined,
};

function ApplicationShell() {
  const location = useLocation();
  const desktop = useMediaQuery(useTheme().breakpoints.up("lg"));
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [error, setError] = useState<string>();
  const { mode, toggle } = useColorMode();
  const { session, logout } = useInvestigationSession();
  const scope = useInvestigationRepositoryScope();
  const sample = process.env.NODE_ENV === "development";
  const active = routeDefinitions.find((route) => route.path === location.pathname);
  const scopeQuery = scope.repositoryId
    ? `?repositoryId=${encodeURIComponent(scope.repositoryId)}`
    : "";
  useEffect(() => {
    document.title = `${active?.name ?? "Workspace"} · Agentic Review`;
    setMobileOpen(false);
  }, [active?.name]);
  const navigation = (
    <Box
      component="nav"
      aria-label="Main navigation"
      sx={{ height: "100%", display: "flex", flexDirection: "column", p: 1.5 }}
    >
      {!desktop && (
        <Stack direction="row" sx={{ minHeight: 56, px: 1, alignItems: "center" }}>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Agentic Review
          </Typography>
          <IconButton aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
            <CloseRounded />
          </IconButton>
        </Stack>
      )}
      <Typography variant="subtitle2" color="text.secondary" sx={{ px: 2, py: 1 }}>
        Workspace
      </Typography>
      <List disablePadding sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {routeDefinitions
          .filter(
            (route) =>
              !route.hideInMenu && route.name && (!route.adminOnly || session.user?.isAdmin),
          )
          .map((route) => {
            const Icon = icons[route.path] ?? FolderOutlined;
            return (
              <ListItemButton
                key={route.path}
                component={Link}
                to={route.path + scopeQuery}
                selected={location.pathname === route.path}
                aria-current={location.pathname === route.path ? "page" : undefined}
                sx={{
                  borderRadius: 100,
                  px: 2,
                  minHeight: 48,
                  color: "text.secondary",
                  "&.Mui-selected": {
                    bgcolor: "var(--app-secondary-container)",
                    color: "var(--app-on-secondary-container)",
                    "&:hover": { bgcolor: "var(--app-secondary-container)" },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 40, color: "inherit" }}>
                  <Icon />
                </ListItemIcon>
                <ListItemText
                  primary={route.name}
                  slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 500 } } }}
                />
              </ListItemButton>
            );
          })}
      </List>
      <Divider sx={{ mb: 1 }} />
      <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>
        {sample ? `${session.user?.username} · Sample workspace` : session.user?.displayName}
      </Typography>
    </Box>
  );
  return (
    <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 1, px: { xs: 1, md: 2 } }}>
          <IconButton
            aria-label={navigationOpen && desktop ? "Close navigation" : "Open navigation"}
            onClick={() => (desktop ? setNavigationOpen((value) => !value) : setMobileOpen(true))}
          >
            <MenuRounded />
          </IconButton>
          <Box
            component={Link}
            to={`/pull-requests${scopeQuery}`}
            className="material-brand"
            sx={{ minWidth: 0, flexShrink: 1 }}
          >
            <AccountTreeRounded
              sx={{ color: "primary.main", display: { xs: "none", sm: "block" } }}
            />
            <Typography component="span" variant="h6" noWrap sx={{ fontSize: { xs: 18, sm: 20 } }}>
              Agentic Review
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {desktop && <InvestigationRepositorySelector />}
          {desktop && scope.repository && (
            <Tooltip title={`Open ${scope.repository.fullName} on GitHub`}>
              <IconButton
                component="a"
                href={`https://github.com/${scope.repository.fullName}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open repository on GitHub"
              >
                <GitHub />
              </IconButton>
            </Tooltip>
          )}
          <Chip
            label={sample ? "Sample data" : "Connected"}
            variant="outlined"
            size="small"
            sx={{ display: { xs: "none", sm: "flex" }, flexShrink: 0 }}
          />
          <IconButton
            aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={toggle}
          >
            {mode === "light" ? <DarkModeOutlined /> : <LightModeOutlined />}
          </IconButton>
          {
            <Tooltip title={`Sign out ${session.user?.displayName}`}>
              <IconButton
                aria-label="Sign out"
                onClick={() => {
                  void logout().catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : "Sign out failed."),
                  );
                }}
              >
                <LogoutRounded />
              </IconButton>
            </Tooltip>
          }
        </Toolbar>
      </AppBar>
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Drawer
          variant={desktop ? "persistent" : "temporary"}
          open={desktop ? navigationOpen : mobileOpen}
          onClose={() => setMobileOpen(false)}
          sx={{ width: desktop && navigationOpen ? 260 : 0, flexShrink: 0 }}
          slotProps={{
            paper: {
              sx: {
                width: 260,
                position: desktop ? "relative" : "fixed",
                height: "100%",
                border: 0,
                bgcolor: "background.default",
              },
            },
          }}
        >
          {navigation}
        </Drawer>
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            pr: { lg: 2 },
            pb: { lg: 2 },
          }}
        >
          {!desktop && (
            <Stack direction="row" spacing={1} sx={{ px: 2, pb: 2, alignItems: "center" }}>
              <InvestigationRepositorySelector fullWidth />
              {scope.repository && (
                <IconButton
                  component="a"
                  href={`https://github.com/${scope.repository.fullName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open repository on GitHub"
                >
                  <GitHub />
                </IconButton>
              )}
            </Stack>
          )}
          <Box
            component="main"
            className="material-main material-scroll-region"
            aria-label="Workspace"
            sx={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              bgcolor: "background.paper",
              borderRadius: { xs: 0, lg: "24px" },
              p: { xs: 2, md: 3 },
              pb: 5,
            }}
          >
            {error && (
              <Alert severity="error" onClose={() => setError(undefined)} sx={{ mb: 2 }}>
                {error}
              </Alert>
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
                          <Navigate to={`/pull-requests${scopeQuery}`} replace />
                        ) : route.adminOnly && !session.user?.isAdmin ? (
                          <Alert severity="info">
                            Account administration requires an administrator account.
                          </Alert>
                        ) : Page ? (
                          <Page />
                        ) : (
                          <Stack spacing={2}>
                            <Typography variant="h4">Page unavailable</Typography>
                            <Typography>
                              This page is not part of the current investigation workspace.
                            </Typography>
                            <Button component={Link} to={`/pull-requests${scopeQuery}`}>
                              Open pull requests
                            </Button>
                          </Stack>
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
  return (
    <MaterialTheme>
      <QueryClientProvider client={queryClient}>
        <InvestigationSessionProvider>
          <BrowserRouter>
            <ApplicationShell />
          </BrowserRouter>
        </InvestigationSessionProvider>
      </QueryClientProvider>
    </MaterialTheme>
  );
}
