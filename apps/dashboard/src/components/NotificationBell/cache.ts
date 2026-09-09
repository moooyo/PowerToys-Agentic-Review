import type { QueryClient } from "@tanstack/react-query";
import { notificationQueryRoot } from "@/services/notifications";

export function discardNotificationQueries(client: QueryClient): void {
  void client.cancelQueries({ queryKey: notificationQueryRoot });
  client.removeQueries({ queryKey: notificationQueryRoot });
}
