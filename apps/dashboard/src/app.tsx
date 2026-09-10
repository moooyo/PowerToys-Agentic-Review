import {
  AccountTreeRounded,
  ArrowOutwardRounded,
  AssignmentTurnedInOutlined,
  CloseRounded,
  DarkModeOutlined,
  DashboardCustomizeOutlined,
  FactCheckOutlined,
  FolderOutlined,
  GitHub,
  LightModeOutlined,
  LogoutRounded,
  MenuRounded,
  NotificationsOutlined,
  PlayCircleOutlineRounded,
  SettingsOutlined,
  SourceOutlined,
  TerminalRounded,
  TuneRounded,
  WidgetsOutlined,
} from "@mui/icons-material";
import {
  Alert,
  AppBar,
  Avatar,
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
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { type ComponentType, lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import routeDefinitions from "../config/routes";
import accessForSession from "./access";
import { NotificationBell } from "./components/NotificationBell";
import { NotificationSession } from "./components/NotificationBell/access";
import { OperatorSessionBoundary } from "./components/OperatorSession";
import {
  RepositoryScopedLink,
  RepositorySelector,
  useRepositoryScope,
} from "./components/RepositoryScope";
import { NotificationsHost } from "./components/ui";
import { SessionProvider, useOperatorSession } from "./state/session";
import { MaterialTheme, useColorMode } from "./theme";
import "./global.css";

export type { InitialState } from "./state/session";
export { getInitialState } from "./state/session";

const pages: Record<string, ComponentType> = {
  "./WorkspaceRedirect": lazy(() => import("./pages/WorkspaceRedirect")),
  "./PullRequests": lazy(() => import("./pages/PullRequests")),
  "./Issues": lazy(() => import("./pages/Issues")),
  "./Jobs": lazy(() => import("./pages/Jobs")),
  "./Repositories": lazy(() => import("./pages/Repositories")),
  "./Prompts": lazy(() => import("./pages/Prompts")),
  "./ValidationProfiles": lazy(() => import("./pages/ValidationProfiles")),
  "./Workers": lazy(() => import("./pages/Workers")),
  "./Evaluations": lazy(() => import("./pages/Evaluations")),
  "./Approvals": lazy(() => import("./pages/Approvals")),
  "./Publications": lazy(() => import("./pages/Publications")),
  "./Notifications": lazy(() => import("./pages/Notifications")),
  "./System": lazy(() => import("./pages/System")),
  "./SignedOut": lazy(() => import("./pages/SignedOut")),
  "./NotFound": lazy(() => import("./pages/NotFound")),
};
const navIcons: Record<string, ComponentType<{ fontSize?: "small" }>> = {
  "/pull-requests": AccountTreeRounded,
  "/issues": FactCheckOutlined,
  "/jobs": PlayCircleOutlineRounded,
  "/workers": TerminalRounded,
  "/publications": ArrowOutwardRounded,
  "/notifications": NotificationsOutlined,
  "/system": SettingsOutlined,
  "/repositories": FolderOutlined,
  "/prompts": SourceOutlined,
  "/validation-profiles": TuneRounded,
  "/evaluations": DashboardCustomizeOutlined,
  "/approvals": AssignmentTurnedInOutlined,
};
const sections = [
  { label: "Review", paths: ["/pull-requests", "/issues"] },
  {
    label: "Operations",
    paths: ["/jobs", "/workers", "/publications", "/notifications", "/system"],
  },
  {
    label: "Configuration",
    paths: ["/repositories", "/prompts", "/validation-profiles", "/evaluations"],
  },
];
const sidebarWidth = 280;

function PageLoading() {
  return (
    <Box role="status" aria-label="Loading page" sx={{ p: 4 }}>
      <Typography color="text.secondary">Loading workspace…</Typography>
    </Box>
  );
}

function RouteContent({ component, permission }: { component: string; permission?: string }) {
  const { initialState } = useOperatorSession();
  const allowed = accessForSession(initialState);
  const Page = pages[component];
  if (!Page) return null;
  if (permission && allowed[permission as keyof typeof allowed] !== true)
    return (
      <Alert severity="info">
        This page requires additional access. Contact your platform administrator.
      </Alert>
    );
  return <Page />;
}

function ApplicationShell() {
  const { initialState, refresh } = useOperatorSession();
  const repositoryScope = useRepositoryScope();
  const location = useLocation();
  const desktop = useMediaQuery(useTheme().breakpoints.up("lg"));
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const { mode, toggle } = useColorMode();
  const allowed = accessForSession(initialState);
  const preview = process.env.NODE_ENV === "development";
  const active = routeDefinitions.find((route) => route.path === location.pathname);
  const barePage = active?.layout === false || !active;
  useEffect(() => {
    document.title = (active?.name ?? "Workspace") + " · Agentic Review";
    setMobileOpen(false);
    setAccountAnchor(null);
  }, [active?.name]);

  const routeTree = (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        {routeDefinitions.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<RouteContent component={route.component} permission={route.access} />}
          />
        ))}
      </Routes>
    </Suspense>
  );
  if (barePage) return routeTree;
  if (!initialState?.authenticated)
    return (
      <Box sx={{ maxWidth: 620, mx: "auto", pt: 12, px: 3 }}>
        <Alert severity={initialState?.apiConnected ? "info" : "error"} sx={{ mb: 3 }}>
          {initialState?.apiConnected
            ? "Sign in to open your review workspace."
            : "The review service is unavailable. Check the connection and try again."}
        </Alert>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={() => void refresh()}>
            Try again
          </Button>
          <Button component={Link} to="/signed-out">
            Sign in
          </Button>
        </Stack>
      </Box>
    );

  const displayName = initialState.currentUser.displayName;
  const initials = displayName
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  const status = (
    <Chip
      label={preview ? "Sample data" : initialState.apiConnected ? "Connected" : "Disconnected"}
      variant="outlined"
      sx={{ color: "text.secondary", borderColor: "divider", flexShrink: 0 }}
    />
  );
  const githubShortcut = repositoryScope.repository ? (
    <Tooltip title={"Open " + repositoryScope.repository.fullName + " on GitHub"}>
      <IconButton
        component="a"
        href={"https://github.com/" + repositoryScope.repository.fullName}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={"Open " + repositoryScope.repository.fullName + " on GitHub"}
      >
        <GitHub />
      </IconButton>
    </Tooltip>
  ) : null;
  const navigation = (
    <Box
      component="nav"
      aria-label="Main navigation"
      sx={{ height: "100%", display: "flex", flexDirection: "column", px: 1.5, pb: 2 }}
    >
      {!desktop && (
        <Stack direction="row" sx={{ alignItems: "center", minHeight: 72, px: 1, gap: 2 }}>
          <AccountTreeRounded color="primary" />
          <Typography variant="h6" sx={{ flex: 1 }}>
            Agentic Review
          </Typography>
          <IconButton aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
            <CloseRounded />
          </IconButton>
        </Stack>
      )}
      <Box sx={{ flex: 1, overflowY: "auto", pt: desktop ? 1 : 0 }}>
        {sections.map((section) => {
          const routes = routeDefinitions.filter(
            (route) =>
              section.paths.includes(route.path) &&
              !route.hideInMenu &&
              (!route.access || allowed[route.access as keyof typeof allowed]),
          );
          return routes.length ? (
            <Box key={section.label} sx={{ mb: 1.5 }}>
              <Typography variant="subtitle2" sx={{ color: "text.secondary", px: 2, py: 1.5 }}>
                {section.label}
              </Typography>
              <List disablePadding>
                {routes.map((route) => {
                  const Icon = navIcons[route.path] ?? WidgetsOutlined;
                  const selected = location.pathname === route.path;
                  return (
                    <ListItemButton
                      key={route.path}
                      component={RepositoryScopedLink}
                      to={route.path}
                      selected={selected}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => setMobileOpen(false)}
                      sx={{
                        minHeight: 52,
                        borderRadius: 100,
                        px: 2,
                        mb: 0.5,
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
                        slotProps={{
                          primary: { sx: { fontSize: 14, lineHeight: "20px", fontWeight: 500 } },
                        }}
                      />
                    </ListItemButton>
                  );
                })}
              </List>
            </Box>
          ) : null;
        })}
      </Box>
      <Divider sx={{ mx: 2, mb: 2 }} />
      <Typography variant="body2" sx={{ px: 2, color: "text.secondary" }}>
        {preview ? "Local preview" : "Review workspace"}
      </Typography>
    </Box>
  );

  return (
    <Box sx={{ minHeight: "100vh" }}>
      <AppBar position="sticky">
        <Toolbar sx={{ minHeight: 64, px: { xs: 1.5, md: 2 }, gap: { xs: 0.5, sm: 1 } }}>
          <Tooltip title={desktop && desktopOpen ? "Close navigation" : "Open navigation"}>
            <IconButton
              aria-label={desktop && desktopOpen ? "Close navigation" : "Open navigation"}
              onClick={() => (desktop ? setDesktopOpen((value) => !value) : setMobileOpen(true))}
            >
              <MenuRounded />
            </IconButton>
          </Tooltip>
          <RepositoryScopedLink
            className="material-brand"
            to="/pull-requests"
            aria-label="Agentic Review home"
          >
            <AccountTreeRounded
              sx={{ color: "primary.main", display: { xs: "none", sm: "block" } }}
            />
            <Typography component="span" variant="h6" sx={{ fontSize: { xs: 20, sm: 22 } }}>
              Agentic Review
            </Typography>
          </RepositoryScopedLink>
          <Box sx={{ flex: 1 }} />
          {desktop && (
            <>
              <RepositorySelector />
              {githubShortcut}
              <Box sx={{ mx: 1 }}>{status}</Box>
            </>
          )}
          <Tooltip title={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}>
            <IconButton
              aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
              onClick={toggle}
            >
              {mode === "light" ? <DarkModeOutlined /> : <LightModeOutlined />}
            </IconButton>
          </Tooltip>
          <NotificationBell />
          <Tooltip title={displayName}>
            <IconButton
              aria-label="Open account menu"
              aria-controls={accountAnchor ? "account-menu" : undefined}
              aria-haspopup="true"
              aria-expanded={Boolean(accountAnchor)}
              onClick={(event) => setAccountAnchor(event.currentTarget)}
            >
              <Avatar sx={{ width: 32, height: 32, fontSize: 14 }}>{initials}</Avatar>
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Menu
        id="account-menu"
        anchorEl={accountAnchor}
        open={Boolean(accountAnchor)}
        onClose={() => setAccountAnchor(null)}
      >
        <Box sx={{ px: 2, py: 1.5, minWidth: 220 }}>
          <Typography variant="subtitle1">{displayName}</Typography>
          <Typography variant="body2" color="text.secondary">
            {preview ? "Sample workspace" : "Signed in"}
          </Typography>
        </Box>
        {!preview && <Divider />}
        {!preview && (
          <MenuItem
            onClick={() => {
              void fetch("/api/v1/auth/logout", {
                credentials: "include",
                method: "POST",
                redirect: "error",
              })
                .catch(() => undefined)
                .finally(() => globalThis.location?.assign("/signed-out"));
            }}
          >
            <ListItemIcon>
              <LogoutRounded />
            </ListItemIcon>
            Sign out
          </MenuItem>
        )}
      </Menu>
      <Box sx={{ display: "flex" }}>
        <Drawer
          variant={desktop ? "persistent" : "temporary"}
          open={desktop ? desktopOpen : mobileOpen}
          onClose={() => setMobileOpen(false)}
          sx={{ width: desktop && desktopOpen ? sidebarWidth : 0, flexShrink: 0 }}
          slotProps={{
            paper: {
              sx: {
                width: sidebarWidth,
                border: 0,
                bgcolor: "background.default",
                top: desktop ? 64 : 0,
                height: desktop ? "calc(100dvh - 64px)" : "100%",
                borderRadius: desktop ? 0 : "0 16px 16px 0",
              },
            },
          }}
        >
          {navigation}
        </Drawer>
        <Box sx={{ flex: 1, minWidth: 0, pr: { xs: 0, lg: 2 }, pb: { xs: 0, lg: 2 } }}>
          {!desktop && (
            <Stack direction="row" sx={{ alignItems: "center", px: 2, pt: 1, pb: 2, gap: 1 }}>
              <RepositorySelector fullWidth />
              {githubShortcut}
              {status}
            </Stack>
          )}
          <Box
            component="main"
            className="material-main"
            sx={{
              maxWidth: 1600,
              mx: "auto",
              minHeight: "calc(100dvh - 80px)",
              bgcolor: "background.paper",
              borderRadius: { xs: 0, lg: "24px" },
              p: { xs: 2, md: 3 },
              pb: 5,
            }}
          >
            {routeTree}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export default function App() {
  return (
    <MaterialTheme>
      <SessionProvider>
        <BrowserRouter>
          <OperatorSessionBoundary>
            <NotificationSession>
              <ApplicationShell />
              <NotificationsHost />
            </NotificationSession>
          </OperatorSessionBoundary>
        </BrowserRouter>
      </SessionProvider>
    </MaterialTheme>
  );
}
