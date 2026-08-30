import { CheckCircleFilled, GithubOutlined, LogoutOutlined, UserOutlined } from "@ant-design/icons";
import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunTimeLayoutConfig } from "@umijs/max";
import { Link } from "@umijs/max";
import { Badge, Button, Space, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import defaultSettings from "../config/defaultSettings";
import "./global.css";

export interface InitialState {
  apiConnected: boolean;
  currentUser: {
    displayName: string;
    roles: string[];
  };
  settings: Partial<LayoutSettings>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

export async function getInitialState(): Promise<InitialState> {
  const developmentMode = process.env.NODE_ENV === "development";
  if (developmentMode) {
    return {
      apiConnected: true,
      currentUser: {
        displayName: "Development Operator",
        roles: ["review-operator"],
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
        globalThis.location?.assign("/api/v1/auth/login");
      }
      return {
        apiConnected: true,
        currentUser: { displayName: "Signing in", roles: [] },
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
    if (!displayName) {
      throw new Error("Operator session endpoint returned an invalid identity.");
    }
    return {
      apiConnected: true,
      currentUser: { displayName, roles: ["review-operator"] },
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  } catch {
    return {
      apiConnected: false,
      currentUser: { displayName: "Unavailable", roles: [] },
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  }
}

export const layout: RunTimeLayoutConfig = ({ initialState }) => ({
  ...defaultSettings,
  ...initialState?.settings,
  avatarProps: {
    icon: <UserOutlined />,
    size: "small",
    title: initialState?.currentUser.displayName ?? "Operator",
  },
  actionsRender: () => [
    <Tooltip
      key="connection"
      title={
        process.env.NODE_ENV === "development"
          ? "The dashboard is using deterministic development fixtures"
          : initialState?.apiConnected
            ? "The authenticated Review Control API is available"
            : "The Review Control API is unavailable"
      }
    >
      <Space size={6} className="app-header-status">
        <Badge
          status={
            process.env.NODE_ENV === "development"
              ? "warning"
              : initialState?.apiConnected
                ? "success"
                : "error"
          }
        />
        <Typography.Text>
          {process.env.NODE_ENV === "development"
            ? "Fixture data"
            : initialState?.apiConnected
              ? "Connected"
              : "API unavailable"}
        </Typography.Text>
      </Space>
    </Tooltip>,
    <Tooltip key="github" title="Open the PowerToys repository">
      <Button
        aria-label="Open the PowerToys repository"
        href="https://github.com/microsoft/PowerToys"
        icon={<GithubOutlined />}
        rel="noreferrer"
        target="_blank"
        type="text"
      />
    </Tooltip>,
    ...(process.env.NODE_ENV === "development"
      ? []
      : [
          <Tooltip key="logout" title="Sign out">
            <Button
              aria-label="Sign out"
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
              type="text"
            />
          </Tooltip>,
        ]),
  ],
  menuItemRender: (item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom),
  menuHeaderRender: (_logo, title) => (
    <Space size={10} className="app-menu-brand">
      <CheckCircleFilled className="app-menu-brand__icon" />
      {title}
    </Space>
  ),
  footerRender: false,
});

export function rootContainer(container: ReactNode) {
  return <QueryClientProvider client={queryClient}>{container}</QueryClientProvider>;
}
