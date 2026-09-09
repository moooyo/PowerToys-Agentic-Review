import type { OperatorAccessContext, OperatorPrincipal } from "@agentic-review/contracts";
import {
  BranchesOutlined,
  GithubOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import type { RunTimeLayoutConfig } from "@umijs/max";
import { Avatar, Badge, Button, Tooltip } from "antd";
import type { ReactNode } from "react";
import { NotificationBell } from "@/components/NotificationBell";
import { NotificationSession } from "@/components/NotificationBell/access";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { samePrincipal } from "@/components/OperatorAccess/state";
import { OperatorSessionBoundary } from "@/components/OperatorSession";
import {
  RepositoryScopedLink,
  RepositorySelector,
  useRepositoryScope,
} from "@/components/RepositoryScope";
import { access } from "@/services/access";
import defaultSettings from "../config/defaultSettings";
import "./global.css";

export interface InitialState {
  apiConnected: boolean;
  sessionEpoch: number;
  authenticationEpoch: number;
  authenticated: boolean;
  operatorAccess: OperatorAccessContext | null;
  accessResolvedAt: number;
  currentUser: {
    displayName: string;
    principal: OperatorPrincipal | null;
  };
  settings: Partial<LayoutSettings>;
}

let sessionEpoch = 0;
let authenticationEpoch = 0;
let resolvedSessionIdentity: string | undefined;

function resolveSessionEpoch(principal: OperatorPrincipal | null): number {
  const identity = JSON.stringify(
    principal === null ? null : [principal.issuer, principal.subject],
  );
  if (identity !== resolvedSessionIdentity) {
    resolvedSessionIdentity = identity;
    sessionEpoch += 1;
  }
  return sessionEpoch;
}

export async function getInitialState(): Promise<InitialState> {
  const currentAuthenticationEpoch = ++authenticationEpoch;
  const developmentMode = process.env.NODE_ENV === "development";
  if (developmentMode) {
    const context = await access.context();
    return {
      apiConnected: true,
      sessionEpoch: resolveSessionEpoch(context.principal),
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: true,
      operatorAccess: context,
      accessResolvedAt: Date.now(),
      currentUser: {
        displayName: "Development Operator",
        principal: context.principal,
      },
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  }

  try {
    const response = await fetch("/api/v1/auth/session", {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Operator session endpoint returned ${response.status}.`);
    }
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Operator session endpoint returned an invalid payload.");
    }
    const session = value as Record<string, unknown>;
    if (session.authenticated !== true) {
      if (globalThis.location?.pathname !== "/signed-out") {
        globalThis.location?.assign("/signed-out");
      }
      return {
        apiConnected: true,
        sessionEpoch: resolveSessionEpoch(null),
        authenticationEpoch: currentAuthenticationEpoch,
        authenticated: false,
        operatorAccess: null,
        accessResolvedAt: 0,
        currentUser: { displayName: "Signing in", principal: null },
        settings: defaultSettings as Partial<LayoutSettings>,
      };
    }
    const operator = session.operator;
    if (typeof operator !== "object" || operator === null || Array.isArray(operator)) {
      throw new Error("Operator session endpoint omitted the operator identity.");
    }
    const identity = operator as Record<string, unknown>;
    const displayName =
      (typeof identity.displayName === "string" && identity.displayName) ||
      (typeof identity.email === "string" && identity.email) ||
      (typeof identity.subject === "string" && identity.subject);
    if (
      !displayName ||
      typeof identity.issuer !== "string" ||
      !identity.issuer ||
      typeof identity.subject !== "string" ||
      !identity.subject
    ) {
      throw new Error("Operator session endpoint returned an invalid identity.");
    }
    const principal = { issuer: identity.issuer, subject: identity.subject };
    let context: OperatorAccessContext | null = null;
    try {
      const response = await access.context();
      if (!samePrincipal(response.principal, principal))
        throw new Error("The access identity does not match the session.");
      context = response;
    } catch {
      // A permissions failure must not sign out an otherwise authenticated operator.
    }
    return {
      apiConnected: true,
      sessionEpoch: resolveSessionEpoch(principal),
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: true,
      operatorAccess: context,
      accessResolvedAt: context ? Date.now() : 0,
      currentUser: { displayName, principal },
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  } catch {
    return {
      apiConnected: false,
      sessionEpoch,
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: false,
      operatorAccess: null,
      accessResolvedAt: 0,
      currentUser: { displayName: "Unavailable", principal: null },
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  }
}

function AppBrand({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const scope = useRepositoryScope();
  return (
    <RepositoryScopedLink
      aria-label="Agentic Review home"
      className={`app-brand${collapsed ? " app-brand--collapsed" : ""}`}
      onClick={onNavigate}
      title={`Agentic Review · ${scope.label}`}
      to="/pull-requests"
    >
      <span aria-hidden="true" className="app-brand__mark">
        <BranchesOutlined />
      </span>
      {!collapsed && (
        <span className="app-brand__copy">
          <span className="app-brand__name">Agentic Review</span>
          <span className="app-brand__context">{scope.label}</span>
        </span>
      )}
    </RepositoryScopedLink>
  );
}

function SidebarFooter({
  initialState,
  collapsed,
  onToggle,
}: {
  initialState: InitialState | undefined;
  collapsed: boolean;
  onToggle?: () => void;
}) {
  const scope = useRepositoryScope();
  const operatorAccess = useOperatorAccess(scope.repositoryId);
  const preview = process.env.NODE_ENV === "development";
  const connected = initialState?.apiConnected === true;
  const displayName = initialState?.currentUser.displayName ?? "Operator";
  const status = preview ? "warning" : connected ? "success" : "error";
  const statusLabel = preview ? "Local preview" : connected ? "Connected" : "API unavailable";
  const statusDescription = preview
    ? "This preview uses sample data."
    : connected
      ? "The authenticated Review Control API is available."
      : "The Review Control API is unavailable.";

  return (
    <div className={`app-sidebar-footer${collapsed ? " app-sidebar-footer--collapsed" : ""}`}>
      <div className="app-sidebar-footer__status-row">
        <Tooltip placement="right" title={statusDescription}>
          <span role="status" aria-label={statusLabel} className="app-connection">
            <Badge status={status} text={collapsed ? undefined : statusLabel} />
          </span>
        </Tooltip>
        <div className="app-sidebar-footer__tools">
          <NotificationBell />
          {scope.repository ? (
            <Tooltip placement="top" title={`Open ${scope.repository.fullName} on GitHub`}>
              <Button
                aria-label={`Open ${scope.repository.fullName} on GitHub`}
                href={`https://github.com/${scope.repository.fullName}`}
                icon={<GithubOutlined />}
                target="_blank"
                rel="noreferrer"
                size="small"
                type="text"
              />
            </Tooltip>
          ) : null}
          {onToggle && (
            <Tooltip
              placement="top"
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
            >
              <Button
                aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={onToggle}
                size="small"
                type="text"
              />
            </Tooltip>
          )}
        </div>
      </div>
      <div className="app-sidebar-footer__profile">
        <Avatar className="app-user-avatar" size={32} icon={<UserOutlined />} aria-hidden="true" />
        {!collapsed && (
          <div className="app-user-copy">
            <span className="app-user-copy__name" title={displayName}>
              {displayName}
            </span>
            <span className="app-user-copy__role">
              {preview
                ? "Sample data"
                : operatorAccess.platformAdministrator
                  ? "Platform administrator"
                  : (operatorAccess.context?.repository?.role ??
                    (connected ? "Authenticated operator" : "Session unavailable"))}
            </span>
          </div>
        )}
        {!preview && (
          <Tooltip placement="right" title="Sign out">
            <Button
              aria-label="Sign out"
              className="app-sign-out"
              icon={<LogoutOutlined />}
              onClick={() => {
                void fetch("/api/v1/auth/logout", {
                  credentials: "include",
                  method: "POST",
                  redirect: "error",
                })
                  .catch(() => undefined)
                  .finally(() => globalThis.location?.assign("/signed-out"));
              }}
              size="small"
              type="text"
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export const layout: RunTimeLayoutConfig = ({ initialState }) => ({
  ...defaultSettings,
  ...initialState?.settings,
  className: "app-shell",
  avatarProps: false,
  actionsRender: false,
  collapsedButtonRender: false,
  menu: { type: "group", locale: false },
  menuDataRender: (items) => {
    const reviewPaths = new Set(["/pull-requests", "/issues"]);
    const configurationPaths = new Set([
      "/repositories",
      "/prompts",
      "/validation-profiles",
      "/evaluations",
    ]);
    return [
      {
        key: "review-workspace",
        name: "Workspace",
        children: items.filter((item) => reviewPaths.has(item.path ?? "")),
      },
      {
        key: "review-operations",
        name: "Operations",
        children: items.filter(
          (item) => !reviewPaths.has(item.path ?? "") && !configurationPaths.has(item.path ?? ""),
        ),
      },
      {
        key: "review-configuration",
        name: "Configuration",
        children: items.filter((item) => configurationPaths.has(item.path ?? "")),
      },
    ].filter((group) => group.children.length > 0);
  },
  menuItemRender: (item, dom) =>
    item.path ? (
      <RepositoryScopedLink onClick={item.isMobile ? item.onClick : undefined} to={item.path}>
        {dom}
      </RepositoryScopedLink>
    ) : (
      dom
    ),
  menuHeaderRender: (_logo, _title, props) => (
    <AppBrand
      collapsed={props?.collapsed === true}
      {...(props?.isMobile ? { onNavigate: () => props.onCollapse?.(true) } : {})}
    />
  ),
  menuExtraRender: (props) => <RepositorySelector collapsed={props?.collapsed === true} />,
  menuFooterRender: (props) => (
    <SidebarFooter
      initialState={initialState}
      collapsed={props?.collapsed === true}
      {...(props?.onCollapse && !props.isMobile
        ? { onToggle: () => props?.onCollapse?.(!props?.collapsed) }
        : {})}
    />
  ),
  headerRender: (props) => (
    <div className="app-mobile-header">
      <Button
        aria-expanded={!props.collapsed}
        aria-label={props.collapsed ? "Open navigation" : "Close navigation"}
        icon={<MenuOutlined />}
        onClick={() => props.onCollapse?.(!props.collapsed)}
        type="text"
      />
      <AppBrand />
    </div>
  ),
  footerRender: false,
});

export function innerProvider(container: ReactNode) {
  return (
    <OperatorSessionBoundary>
      <NotificationSession>{container}</NotificationSession>
    </OperatorSessionBoundary>
  );
}
