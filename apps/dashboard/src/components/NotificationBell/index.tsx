import NotificationsOutlinedIcon from "@mui/icons-material/NotificationsOutlined";
import { Badge, IconButton, Tooltip } from "@mui/material";
import { Link, useLocation } from "react-router-dom";
import { useRepositoryScope } from "@/components/RepositoryScope";
import { useNotificationAccess, useNotificationSummary } from "./access";

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
      <IconButton aria-label={label} component={Link} to={to} color="inherit">
        <Badge
          badgeContent={summary?.capped ? "99+" : summary?.unreadCount}
          showZero={!!summary}
          color="primary"
        >
          <NotificationsOutlinedIcon aria-hidden="true" />
        </Badge>
      </IconButton>
    </Tooltip>
  );
}
