import { HttpNotificationAdapter } from "./http-adapter";
export const notifications = new HttpNotificationAdapter();
export const notificationQueryRoot = ["notifications"] as const;
export type { NotificationAdapter } from "./adapter";
export { HttpNotificationAdapter } from "./http-adapter";
