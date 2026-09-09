import { BellOutlined } from "@ant-design/icons";
import { Link, useLocation } from "@umijs/max";
import { Badge, Tooltip } from "antd";
import { useRepositoryScope } from "@/components/RepositoryScope";
import { useNotificationAccess, useNotificationSummary } from "./access";
import "./index.css";

export function NotificationBell() {
  const scope = useRepositoryScope();
  const location = useLocation();
  const access = useNotificationAccess(scope.repositoryId);
  const query = useNotificationSummary(scope.repositoryId, {
    ...access,
    readable: access.readable && scope.ready,
  });
  const summary = query.data;
  const label = access.sample
    ? "Notifications unavailable in sample mode"
    : !scope.ready
      ? "Notification repository scope unavailable"
      : summary
        ? `${summary.unreadCount}${summary.capped ? "+" : ""} unread notifications`
        : "Notification count unavailable";
  const to = !scope.ready
    ? `/notifications${location.search}`
    : scope.repositoryId
      ? `/notifications?${new URLSearchParams({ repositoryId: scope.repositoryId })}`
      : "/notifications";
  return (
    <Tooltip title={label}>
      <Link aria-label={label} to={to} className="notification-bell">
        <Badge
          count={summary?.capped ? "99+" : summary?.unreadCount}
          showZero={!!summary}
          size="small"
        >
          <BellOutlined aria-hidden="true" style={{ fontSize: 18 }} />
        </Badge>
        {!summary && (
          <span className="notification-bell__unavailable" aria-hidden="true">
            —
          </span>
        )}
      </Link>
    </Tooltip>
  );
}
