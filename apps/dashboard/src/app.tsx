import { Alert, Button, CircularProgress, Menu, MenuItem } from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import {
  loadReviewRecords,
  type ReviewRecord,
  readIgnoredRecordIds,
  recordStatusLabel,
  relativeTime,
} from "./console/model";
import { hasReviewSelection, selectReviewRecord } from "./console/navigation";
import {
  ConsoleIcon,
  ConsolePreferencesProvider,
  LanguageToggle,
  ThemeToggle,
  useConsolePreferences,
} from "./console/preferences";
import RecordDetail from "./console/record-detail";
import Settings from "./console/settings";
import { investigationApi } from "./investigation/api";
import { NavigationGuardProvider, useGuardedAction } from "./investigation/navigation-guard";
import {
  InvestigationSessionProvider,
  sessionIdentity,
  useInvestigationSession,
} from "./investigation/session";
import { MaterialTheme } from "./theme";
import "./global.css";
import "./console/console.css";

const settingsAliases: Record<string, string> = {
  "/webhooks": "intake",
  "/repositories": "intake",
  "/workers": "workers",
  "/accounts": "accounts",
  "/account": "profile",
};
const activeOrder: Record<string, number> = { running: 0, publishing: 1, queued: 2 };

function RecordRow({
  record,
  selected,
  choose,
  now,
}: {
  record: ReviewRecord;
  selected: boolean;
  choose: () => void;
  now: number;
}) {
  const { text } = useConsolePreferences();
  const active = ["running", "publishing", "queued"].includes(record.status);
  const problemIcons = {
    upload: "cloud_off",
    review: "error",
    worker: "link_off",
    intake: "move_to_inbox",
    stopped: "pause_circle",
  };
  const icon =
    record.status === "ignored"
      ? "notifications_off"
      : record.status === "attention"
        ? record.problem
          ? problemIcons[record.problem.type]
          : "info"
        : record.status === "queued"
          ? "hourglass_empty"
          : record.status === "publishing"
            ? "cloud_upload"
            : record.kind === "issue"
              ? "bug_report"
              : "check_circle";
  return (
    <button
      type="button"
      className={`console-record ${selected ? "selected" : ""}`}
      data-status={record.completedWithoutPublication ? "completed" : record.status}
      data-problem={record.problem?.type}
      aria-pressed={selected}
      onClick={choose}
    >
      <span
        className={`console-record-icon ${record.kind === "issue" ? "issue" : ""}`}
        data-warning={record.problem?.type === "stopped" || undefined}
      >
        {record.status === "running" ? (
          <CircularProgress size={20} />
        ) : (
          <ConsoleIcon name={icon} size={20} filled={record.status === "posted"} />
        )}
      </span>
      <span className="console-record-copy">
        <span className="console-record-overline">
          <span>
            {record.kind === "pr" ? "PR" : "Issue"} #{record.number}
            {record.area ? ` · ${record.area}` : ""}
          </span>
          {!active && (
            <time dateTime={record.updatedAt}>{relativeTime(record.updatedAt, text, now)}</time>
          )}
        </span>
        <span className="console-record-title">{record.title}</span>
        <span className="console-record-status">{recordStatusLabel(record, text, now)}</span>
        {record.status === "running" && record.lastOutput && (
          <span className="console-record-output">
            <ConsoleIcon
              name={
                record.lastOutputKind === "tool"
                  ? "terminal"
                  : record.lastOutputKind === "assistant"
                    ? "smart_toy"
                    : "info"
              }
              size={14}
            />
            <span className={record.lastOutputKind === "tool" ? "mono" : undefined}>
              {record.lastOutput}
            </span>
          </span>
        )}
      </span>
    </button>
  );
}

function ApplicationShell() {
  const { text } = useConsolePreferences();
  const { session, logout } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const location = useLocation();
  const navigate = useNavigate();
  const guard = useGuardedAction();
  const queryClient = useQueryClient();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const settingsSection = params.get("section") || settingsAliases[location.pathname] || "intake";
  const settings = location.pathname === "/settings" || Boolean(settingsAliases[location.pathname]);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [repositoryMenu, setRepositoryMenu] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [ignoredRecords, setIgnoredRecords] = useState(() => readIgnoredRecordIds(identity));
  const repositories = useQuery({
    queryKey: ["console-repositories", identity],
    queryFn: () => investigationApi.repositories(),
  });
  const permitted =
    repositories.data?.items.filter((item) => session.user?.repositoryIds.includes(item.id)) || [];
  const repository =
    permitted.find((item) => item.id === params.get("repositoryId")) ||
    permitted.find((item) => item.fullName === "microsoft/PowerToys") ||
    permitted[0];
  const recordsQuery = useQuery({
    queryKey: ["console-records", identity, repository?.id],
    queryFn: ({ signal }) => loadReviewRecords(repository?.id, signal, identity),
    enabled: Boolean(repository),
    refetchInterval: 2500,
  });
  const records = useMemo(() => {
    return (recordsQuery.data || []).map((record) =>
      ignoredRecords.has(record.id) &&
      record.status === "attention" &&
      !record.completedWithoutPublication
        ? { ...record, status: "ignored" as const }
        : record,
    );
  }, [recordsQuery.data, ignoredRecords]);
  const attention = records.filter(
    (record) => record.status === "attention" && !record.completedWithoutPublication,
  );
  const completed = records.filter((record) => record.completedWithoutPublication);
  const active = records
    .filter((record) => ["running", "queued", "publishing"].includes(record.status))
    .sort((a, b) => (activeOrder[a.status] ?? 3) - (activeOrder[b.status] ?? 3));
  const posted = records.filter((record) => record.status === "posted");
  const ignored = records.filter((record) => record.status === "ignored");
  const searchValue = search.trim().toLocaleLowerCase();
  const matches = records
    .filter((record) =>
      `${record.number} #${record.number} ${record.title} ${record.area || ""}`
        .toLocaleLowerCase()
        .includes(searchValue),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const selected = selectReviewRecord(records, params);
  const requestedSelection = hasReviewSelection(params);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    document.title = `${settings ? text("设置", "Settings") : text("收件箱", "Inbox")} · Agentic Review`;
    setMenu(null);
  }, [settings, text]);
  const destination = (path: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      ...(repository ? { repositoryId: repository.id } : {}),
      ...extra,
    });
    guard(() => navigate(`${path}${query.size ? `?${query}` : ""}`));
  };
  const openSettings = (section: string) => {
    if (location.pathname === "/settings") {
      const query = new URLSearchParams({
        ...(repository ? { repositoryId: repository.id } : {}),
        section,
      });
      navigate(`/settings?${query}`);
    } else destination("/settings", { section });
  };
  const refresh = () => {
    setIgnoredRecords(readIgnoredRecordIds(identity));
    void queryClient.invalidateQueries({ queryKey: ["console-records", identity] });
  };
  const initials = (session.user?.displayName || session.user?.username || "AR")
    .trim()
    .split(/\s+/u)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const showRows = (items: ReviewRecord[]) =>
    items.map((record) => (
      <RecordRow
        key={record.id}
        record={record}
        selected={selected?.id === record.id}
        now={now}
        choose={() => destination("/inbox", { recordId: record.id })}
      />
    ));
  return (
    <div className="console-shell">
      <nav className="console-rail" aria-label={text("导航", "Navigation")}>
        <div className="console-logo">
          <ConsoleIcon name="rate_review" filled />
        </div>
        {[
          {
            name: text("收件箱", "Inbox"),
            icon: "inbox",
            active: !settings,
            go: () => destination("/inbox"),
          },
          {
            name: text("设置", "Settings"),
            icon: "settings",
            active: settings,
            go: () => openSettings("intake"),
          },
        ].map((item) => (
          <button
            key={item.icon}
            type="button"
            className={`console-nav ${item.active ? "selected" : ""}`}
            aria-current={item.active ? "page" : undefined}
            onClick={item.go}
          >
            <span className="console-nav-indicator">
              <ConsoleIcon name={item.icon} filled={item.active} />
              {item.icon === "inbox" && attention.length > 0 && (
                <span className="console-nav-badge">{attention.length}</span>
              )}
            </span>
            <span>{item.name}</span>
          </button>
        ))}
      </nav>
      <div className="console-main-column">
        <header className="console-header">
          <span className="console-brand">Agentic Review</span>
          <button
            type="button"
            className="console-repository"
            disabled={permitted.length < 2}
            aria-label={text("选择仓库", "Select repository")}
            onClick={(event) => setRepositoryMenu(event.currentTarget)}
          >
            <ConsoleIcon name="book_2" size={18} />
            {repository?.fullName || "microsoft/PowerToys"}
          </button>
          <span className="console-header-spacer" />
          <label className="console-search">
            <ConsoleIcon name="search" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                if (settings) destination("/inbox");
              }}
              placeholder={text("搜索编号、标题或模块", "Search number, title, or module")}
              aria-label={text("搜索编号、标题或模块", "Search number, title, or module")}
            />
            {search && (
              <button
                type="button"
                className="console-clear"
                aria-label={text("清空搜索", "Clear search")}
                onClick={() => setSearch("")}
              >
                <ConsoleIcon name="close" size={20} />
              </button>
            )}
          </label>
          <LanguageToggle />
          <ThemeToggle />
          <button
            type="button"
            className={`console-avatar-button ${menu ? "open" : ""}`}
            aria-label={text("账号菜单", "Account menu")}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={(event) => setMenu(event.currentTarget)}
          >
            <span className="console-avatar">{initials}</span>
          </button>
        </header>
        <main className={`console-content ${settings ? "settings" : ""}`}>
          {(error || repositories.isError) && (
            <Alert
              severity="error"
              className="console-shell-error"
              onClose={() => setError(undefined)}
            >
              {error || repositories.error?.message}
            </Alert>
          )}
          {settings ? (
            <Settings repository={repository} section={settingsSection} onSection={openSettings} />
          ) : (
            <>
              <section className="console-inbox" aria-label={text("Review 记录", "Review records")}>
                <div className="console-inbox-heading">
                  <h1>
                    {searchValue ? text("搜索结果", "Search results") : text("收件箱", "Inbox")}
                  </h1>
                  {searchValue && (
                    <span>{text(`${matches.length} 条`, `${matches.length} records`)}</span>
                  )}
                </div>
                <div className="console-inbox-scroll">
                  {recordsQuery.isError && (
                    <Alert
                      severity="error"
                      action={
                        <Button onClick={() => void recordsQuery.refetch()}>
                          {text("重试", "Retry")}
                        </Button>
                      }
                    >
                      {recordsQuery.error.message}
                    </Alert>
                  )}
                  {recordsQuery.isPending && repository && (
                    <div className="console-list-empty" role="status">
                      <CircularProgress size={24} />
                      {text("正在加载记录…", "Loading records…")}
                    </div>
                  )}
                  {recordsQuery.data !== undefined &&
                    (searchValue ? (
                      <div className="console-search-results">
                        {showRows(matches)}
                        {!matches.length && (
                          <div className="console-list-empty">
                            {text("没有匹配的记录", "No matching records")}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div
                          className={`console-group-heading ${attention.length ? "attention" : ""}`}
                        >
                          <span>{text("需要处理", "Needs attention")}</span>
                          <small>
                            {text(`${attention.length} 条`, `${attention.length} records`)}
                          </small>
                        </div>
                        {showRows(attention)}
                        {!attention.length && (
                          <div className="console-group-empty success">
                            <ConsoleIcon name="check_circle" filled />
                            <div>
                              <strong>
                                {text("没有需要处理的记录", "Nothing needs attention")}
                              </strong>
                              <span>
                                {text(
                                  "Review 结果会自动发布到 GitHub",
                                  "Review results are published to GitHub automatically",
                                )}
                              </span>
                            </div>
                          </div>
                        )}
                        <div className="console-group-heading">
                          <span>{text("进行中", "In progress")}</span>
                          <small>{text(`${active.length} 条`, `${active.length} records`)}</small>
                        </div>
                        {showRows(active)}
                        {!active.length && (
                          <div className="console-group-empty">
                            <ConsoleIcon name="pause_circle" />
                            <strong>{text("没有进行中的 Review", "No reviews in progress")}</strong>
                          </div>
                        )}
                        <div className="console-group-heading">
                          <span>{text("已发布", "Published")}</span>
                          <small>{text(`${posted.length} 条`, `${posted.length} records`)}</small>
                        </div>
                        {showRows(posted)}
                        {completed.length > 0 && (
                          <>
                            <div className="console-group-heading">
                              <span>
                                {text("已完成 · 发布未确认", "Completed · Publication unconfirmed")}
                              </span>
                              <small>
                                {text(`${completed.length} 条`, `${completed.length} records`)}
                              </small>
                            </div>
                            {showRows(completed)}
                          </>
                        )}
                        {ignored.length > 0 && (
                          <>
                            <div className="console-group-heading">
                              <span>{text("已忽略", "Dismissed")}</span>
                              <small>
                                {text(`${ignored.length} 条`, `${ignored.length} records`)}
                              </small>
                            </div>
                            {showRows(ignored)}
                          </>
                        )}
                      </>
                    ))}
                  {!repository && !repositories.isPending && (
                    <div className="console-list-empty">
                      {text(
                        "没有可访问的仓库，请联系管理员。",
                        "No accessible repositories. Contact your administrator.",
                      )}
                    </div>
                  )}
                </div>
              </section>
              <section
                className="console-detail-panel"
                aria-label={text("Review 详情", "Review details")}
              >
                {selected ? (
                  <RecordDetail
                    key={`${selected.id}:${params.get("recordId") || params.get("taskId") || params.get("reportId") || params.get("commentId") || ""}`}
                    record={selected}
                    onRefresh={refresh}
                    onSettings={openSettings}
                  />
                ) : (
                  <div className="console-detail-empty">
                    <ConsoleIcon name="rate_review" size={48} />
                    <h2>
                      {requestedSelection
                        ? text("指定记录暂不可用", "The requested record is unavailable")
                        : text("选择一条 Review 记录", "Select a review record")}
                    </h2>
                    <p>
                      {requestedSelection
                        ? text(
                            "记录未找到或当前账号无法访问。请选择列表中的记录。",
                            "The record was not found or is not accessible to this account. Select a record from the list.",
                          )
                        : text(
                            "在这里查看报告、会话和评论",
                            "View its report, session, and comments here",
                          )}
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
      <Menu
        anchorEl={menu}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        slotProps={{ paper: { className: "console-account-menu", sx: { width: 288, mt: 1 } } }}
      >
        <div className="console-menu-identity">
          <span className="console-avatar">{initials}</span>
          <div>
            <strong>{session.user?.displayName || session.user?.username}</strong>
            <span>
              @{session.user?.username} ·{" "}
              {session.user?.isAdmin ? text("管理员", "Administrator") : text("成员", "Member")}
            </span>
          </div>
        </div>
        <MenuItem
          onClick={() => {
            setMenu(null);
            openSettings("profile");
          }}
        >
          <ConsoleIcon name="manage_accounts" size={22} />
          {text("我的账号", "My account")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            guard(
              () =>
                void logout().catch((cause: unknown) =>
                  setError(
                    cause instanceof Error ? cause.message : text("退出失败", "Sign out failed"),
                  ),
                ),
            );
          }}
        >
          <ConsoleIcon name="logout" size={22} />
          {text("退出登录", "Sign out")}
        </MenuItem>
      </Menu>
      <Menu
        anchorEl={repositoryMenu}
        open={Boolean(repositoryMenu)}
        onClose={() => setRepositoryMenu(null)}
      >
        {permitted.map((item) => (
          <MenuItem
            key={item.id}
            selected={repository?.id === item.id}
            onClick={() => {
              setRepositoryMenu(null);
              guard(() => navigate(`/inbox?repositoryId=${encodeURIComponent(item.id)}`));
            }}
          >
            {item.fullName}
          </MenuItem>
        ))}
      </Menu>
    </div>
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
      <ConsolePreferencesProvider>
        <QueryClientProvider client={queryClient}>
          <InvestigationSessionProvider>
            <RouterProvider router={router} />
          </InvestigationSessionProvider>
        </QueryClientProvider>
      </ConsolePreferencesProvider>
    </MaterialTheme>
  );
}
