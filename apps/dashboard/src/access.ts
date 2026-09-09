import type { InitialState } from "./app";

export default function access(initialState: InitialState | undefined) {
  const authenticated = initialState?.authenticated === true;
  const platformAdministrator =
    authenticated && initialState?.operatorAccess?.platformAdministrator === true;

  return {
    canRead: authenticated,
    canApprove: process.env.NODE_ENV === "development" && platformAdministrator,
    canManageWorkers: platformAdministrator,
    canManageSystem: platformAdministrator,
    canPublish: process.env.NODE_ENV === "development" && platformAdministrator,
  };
}
